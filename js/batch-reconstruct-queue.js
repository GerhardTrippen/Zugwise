// =============================================================================
// batch-reconstruct-queue.js — Sequential reconstruction queue for batch mode
// =============================================================================
// Phase 2 of Batch Mode. Consumes OCR results (from batch-ocr-queue.js), runs
// the three reconstruction algorithms (greedy, beam, dijkstra) per game using
// its own background SearchManager instance, then hands the raw results to
// batch-triage.js for Tier A/B/C classification.
//
// Runs games sequentially — each game launches three parallel workers, but
// we only start a new game after all three finish, so peak worker count is 3.
//
// Dependencies:
//   - SearchManager class (search-manager.js) — instantiated per game
//   - MergeSheets (merge-sheets.js) — for dual-sheet merge before reconstruction
//   - BatchTriage (batch-triage.js) — tier classification
// =============================================================================

var BatchReconstructQueue = (function() {
  'use strict';

  // Per-spec default methods — change only in wiring code, not here.
  // Batch mode runs Greedy only. Beam and Dijkstra can take minutes (Dijkstra
  // unbounded) per game; at 50+ games/round that blocks the user far longer
  // than the progress is worth. If Greedy solves, the game is ready to
  // verify. If Greedy fails, mark the game "stalled" and let the user
  // escalate to Beam/Dijkstra interactively from the Review UI on demand.
  // See "Batch Strategy: Greedy-Only by Default" in BATCH-MODE-SPEC.md for rationale.
  var DEFAULT_METHODS = ['greedy'];

  // =========================================================================
  // Queue constructor
  // =========================================================================

  /**
   * @param {Object} [options]
   * @param {Array<string>} [options.methods=['greedy','beam','dijkstra']]
   * @param {Object}        [options.methodOptions] — per-method search options;
   *                                                  passed through to SearchManager.
   * @param {string}        [options.lockMode='tier1'] — MergeSheets lock mode.
   */
  function Queue(options) {
    options = options || {};
    this.methods = options.methods || DEFAULT_METHODS.slice();
    this.methodOptions = options.methodOptions || {};
    this.lockMode = options.lockMode || 'tier1';

    // Queue of { gameId, ocrResult, lockedPlies, fromPly } items.
    this.queue = [];
    this.results = {};        // gameId -> { results, triage, picked }
    this.processing = false;
    this.cancelled = false;
    this._currentGameId = null;
    this._currentManager = null;  // active SearchManager instance

    // Callbacks (all optional)
    this.onProgress = null;       // (gameId, phase, message) — phase e.g. 'reconstructing'
    this.onMethodStep = null;     // (gameId, method, step) — streaming per-method progress
    this.onGameComplete = null;   // (gameId, {results, triage, picked})
    this.onQueueComplete = null;  // ({gameId: ...})
  }

  // =========================================================================
  // Public queue API
  // =========================================================================

  /**
   * Enqueue a single game for reconstruction.
   * Called by the OCR queue (or app.js) once OCR finishes for a game.
   *
   * @param {string} gameId
   * @param {Object} ocrResult - Result from BatchOcrQueue._processGame:
   *                             either { ocrCells, ... } (single sheet) or
   *                             { isDualSheet: true, sheet1, sheet2, ... }.
   */
  Queue.prototype.enqueue = function(gameId, ocrResult, priority) {
    var item = { gameId: gameId, ocrResult: ocrResult };
    if (typeof priority === 'number') {
      // Ascending priority = easier games first. Insert before the first
      // prioritized item with strictly higher priority. Items without a
      // priority field (requeues — see Queue.prototype.requeue) are
      // skipped during the scan; new prioritized items can be placed
      // either before or after them depending on relative priority of
      // surrounding items, but unprioritized requeues themselves never
      // move once placed at the back.
      item.priority = priority;
      var insertAt = this.queue.length;
      for (var i = 0; i < this.queue.length; i++) {
        var existing = this.queue[i];
        if (typeof existing.priority !== 'number') continue;
        if (existing.priority > priority) { insertAt = i; break; }
      }
      this.queue.splice(insertAt, 0, item);
    } else {
      this.queue.push(item);
    }
    if (!this.processing && !this.cancelled) {
      this._processNext();
    }
  };

  /**
   * Re-enqueue a game after user override during verification.
   * Replaces any pending entry for the same gameId and adds it at the back
   * — fair scheduling. The previous policy was head-of-line, but with
   * Greedy taking tens of seconds per game and multiple games waiting
   * in big sections, that starved the rest of the queue. The user-edited
   * game now waits its turn behind whatever is already pending.
   *
   * @param {string} gameId
   * @param {Array}  updatedOcrMoves - post-override merged OCR moves
   * @param {Array}  lockedPlies     - user-confirmed plies included
   * @param {number} [fromPly]       - optional: skip prefix up to this ply
   */
  Queue.prototype.requeue = function(gameId, updatedOcrMoves, lockedPlies, fromPly) {
    this.queue = this.queue.filter(function(item) {
      return item.gameId !== gameId;
    });
    this.queue.push({
      gameId: gameId,
      // Carry already-merged moves + lockedPlies so we skip the merge step.
      prepared: {
        ocrMoves: updatedOcrMoves,
        lockedPlies: lockedPlies || [],
        fromPly: fromPly || 0
      }
    });
    if (!this.processing && !this.cancelled) {
      this._processNext();
    }
  };

  /**
   * Cancel the queue. In-flight game finishes (can't interrupt a worker in a
   * clean way mid-step without leaving pyodide state dangling), but no further
   * games will start. Per-method cancel is possible via the active manager.
   */
  Queue.prototype.cancel = function() {
    this.cancelled = true;
    if (this._currentManager) {
      try { this._currentManager.cancel(); } catch (e) {}
    }
  };

  /**
   * Cancel only the in-flight processing of a specific game, and remove any
   * pending queue entries for it. The queue itself stays alive — _processNext
   * picks up the next game when the aborted one settles. The aborted search
   * fires onGameComplete with status='CANCELLED'; callers (Orchestrator)
   * discard those.
   */
  Queue.prototype.abortGame = function(gameId) {
    this.queue = this.queue.filter(function(item) {
      return item.gameId !== gameId;
    });
    if (this._currentGameId === gameId && this._currentManager) {
      try { this._currentManager.cancel(); } catch (e) {}
    }
  };

  /**
   * Reset the cancelled flag so enqueue() will start processing again.
   * Does not clear results or queue.
   */
  Queue.prototype.resume = function() {
    this.cancelled = false;
    if (!this.processing && this.queue.length > 0) {
      this._processNext();
    }
  };

  Queue.prototype.getStatus = function() {
    var completed = Object.keys(this.results).length;
    return {
      total: completed + this.queue.length + (this.processing ? 1 : 0),
      completed: completed,
      remaining: this.queue.length,
      currentGameId: this._currentGameId,
      processing: this.processing
    };
  };

  Queue.prototype.getResult = function(gameId) {
    return this.results[gameId] || null;
  };

  // =========================================================================
  // Processing loop
  // =========================================================================

  Queue.prototype._processNext = async function() {
    if (this.cancelled || this.queue.length === 0) {
      this.processing = false;
      this._currentGameId = null;
      this._currentManager = null;
      if (this.onQueueComplete) {
        try { this.onQueueComplete(this.results); } catch (e) {}
      }
      return;
    }

    this.processing = true;
    var item = this.queue.shift();
    this._currentGameId = item.gameId;

    try {
      // Step 1: prepare merged OCR moves + lockedPlies
      var prepared = item.prepared || this._prepareOcrInput(item.gameId, item.ocrResult);
      if (!prepared || !prepared.ocrMoves || prepared.ocrMoves.length === 0) {
        this._emitProgress(item.gameId, 'reconstruct_skipped', 'No OCR cells to reconstruct');
        this.results[item.gameId] = {
          results: null,
          triage: { tier: 'C', reason: 'no_ocr_input', details: {} },
          picked: null
        };
        if (this.onGameComplete) {
          try { this.onGameComplete(item.gameId, this.results[item.gameId]); } catch (e) {}
        }
      } else {
        // Step 2: run reconstruction
        this._emitProgress(item.gameId, 'reconstructing',
          'Running ' + this.methods.join(', ') + ' (' + prepared.ocrMoves.length + ' plies, ' +
          prepared.lockedPlies.length + ' locked)');

        var results = await this._runReconstruction(item.gameId, prepared);

        // Step 3: triage
        var triage = window.BatchTriage
          ? window.BatchTriage.classifyTier(results)
          : { tier: 'C', reason: 'triage_unavailable', details: {} };
        var picked = window.BatchTriage
          ? window.BatchTriage.pickBestResult(results)
          : null;

        this.results[item.gameId] = {
          results: results,
          triage: triage,
          picked: picked
        };

        this._emitProgress(item.gameId, 'reconstruct_complete',
          'Tier ' + triage.tier + ' — ' +
          (triage.details && triage.details.totalFixes != null
            ? triage.details.totalFixes + ' fix(es)'
            : triage.reason));

        if (this.onGameComplete) {
          try { this.onGameComplete(item.gameId, this.results[item.gameId]); } catch (e) {}
        }
      }
    } catch (e) {
      console.error('[BatchReconstruct] Error processing ' + item.gameId + ':', e);
      this.results[item.gameId] = {
        results: null,
        triage: { tier: 'C', reason: 'reconstruct_error', details: { message: String(e && e.message || e) } },
        picked: null
      };
      this._emitProgress(item.gameId, 'reconstruct_error',
        (e && e.message) ? e.message : String(e));
      if (this.onGameComplete) {
        try { this.onGameComplete(item.gameId, this.results[item.gameId]); } catch (_) {}
      }
    }

    this._currentManager = null;

    // Continue — even if cancelled was set mid-game, we honor it here.
    this._processNext();
  };

  // =========================================================================
  // OCR → reconstruction input
  // =========================================================================

  /**
   * Build the reconstruction input (ocrMoves + lockedPlies) from a raw OCR
   * queue result. Handles both the dual-sheet case (runs MergeSheets) and the
   * single-sheet case (passes cells straight through with no locked plies).
   * @private
   */
  Queue.prototype._prepareOcrInput = function(gameId, ocrResult) {
    if (!ocrResult) return null;

    // Dual sheet — optionally auto-apply high-anchor NW alignment edits
    // BEFORE merge, then merge and compute locked plies. The auto-apply
    // step turns games blocked by missing-ply boundaries into "good enough
    // for the algorithms to walk through unattended"; the applied list is
    // stored on ocrResult so the user can review/revert per entry.
    if (ocrResult.isDualSheet && window.MergeSheets &&
        (ocrResult.sheet1 || ocrResult.sheet2)) {
      var s1 = ocrResult.sheet1 || [];
      var s2 = ocrResult.sheet2 || [];

      if (window.BatchNWAutoApply && !ocrResult.nwAutoApplies) {
        var anchorMin = window.BatchNWAutoApply.getAnchorMinSetting();
        if (isFinite(anchorMin)) {
          var autoResult = window.BatchNWAutoApply.autoApplyHighAnchor(s1, s2, anchorMin);
          if (autoResult.applied.length > 0) {
            // Preserve the pristine sheets so a later revert can re-derive
            // the current state from (original) + (subset of applied).
            ocrResult.originalSheet1 = s1;
            ocrResult.originalSheet2 = s2;
            ocrResult.nwAutoApplies = autoResult.applied;
            ocrResult.nwAutoApplyThreshold = anchorMin;
            // Replace the working sheets with the post-apply versions so
            // merge + reconstruction see the corrected input.
            ocrResult.sheet1 = autoResult.sheet1;
            ocrResult.sheet2 = autoResult.sheet2;
            s1 = autoResult.sheet1;
            s2 = autoResult.sheet2;
            if (typeof log === 'function') {
              log('⚙️ Auto-applied ' + autoResult.applied.length +
                  ' NW correction(s) to ' + gameId +
                  ' (anchors ≥ ' + anchorMin.toFixed(2) + '):');
              autoResult.applied.forEach(function(e) {
                log('   • ' + window.BatchNWAutoApply.describeApplied(e));
              });
            }
          }
        }
      }

      var merged = window.MergeSheets.mergeSheets(s1, s2);
      var tierMap = window.MergeSheets.classifyTiers(merged);
      var lockedPlies = window.MergeSheets.computeLockedPlies(tierMap, this.lockMode);
      return {
        ocrMoves: merged,
        lockedPlies: lockedPlies || [],
        fromPly: 0,
        source: 'dual-merge'
      };
    }

    // Single sheet — no lockedPlies derived from cross-sheet agreement.
    var cells = ocrResult.ocrCells || [];
    return {
      ocrMoves: cells,
      lockedPlies: [],
      fromPly: 0,
      source: 'single'
    };
  };

  // =========================================================================
  // Reconstruction (fresh SearchManager per game)
  // =========================================================================

  /**
   * Run the three algorithms on a prepared input. Spawns a fresh SearchManager
   * instance so it does not interfere with the UI singleton.
   * @private
   */
  Queue.prototype._runReconstruction = function(gameId, prepared) {
    if (typeof window.SearchManager !== 'function') {
      throw new Error('SearchManager class not available (search-manager.js must load before batch-reconstruct-queue.js)');
    }

    var self = this;
    var mgr = new window.SearchManager();
    this._currentManager = mgr;

    // If this run is a review-requeue (override at ply N), thread the
    // confirmed_ply frontier into each method's options so greedy skips
    // re-proposing fixes before that ply. Shallow-clone to avoid mutating
    // the shared queue-level defaults.
    var perMethodOptions = this.methodOptions || {};
    if (prepared.fromPly) {
      perMethodOptions = {};
      Object.keys(this.methodOptions || {}).forEach(function(m) {
        perMethodOptions[m] = Object.assign({}, self.methodOptions[m] || {},
          { confirmed_ply: prepared.fromPly | 0 });
      });
      // Cover methods that had no options entry yet.
      this.methods.forEach(function(m) {
        if (!perMethodOptions[m]) {
          perMethodOptions[m] = { confirmed_ply: prepared.fromPly | 0 };
        }
      });
    }

    // Tier 1 auto-relock set: plies with strong dual-sheet backing —
    // cell._sheetCount === 2 AND either raw top-agreement (cell._agree) OR a
    // summed-consensus pick both sheets saw (cell._consensusTop, set by
    // mergePly). Static — independent of legality. Greedy uses this to
    // re-evaluate its locked set after each applied fix, mirroring the frontend's
    // classifyTiers behavior on revalidate (which elevates the same
    // _agree||_consensusTop cells to Tier 1). Without this, an iter-2 Greedy in
    // batch mode happily proposes a fix at a Tier 1 ply (symptom: 4.B e6 — Tier 1
    // agreed — being "fixed" to e5 even though both scoresheets clearly read e6
    // and the bug is upstream; or 6.B Bb7 with summed 1.04). mergeSheets carries
    // _sheetCount/_agree/_consensusTop on every cell, and the requeue splice
    // paths (_buildOcrMovesFromState / _buildOcrMovesWithOverrides) preserve them
    // via Object.assign, so deriving here works for both the initial-merge and
    // post-override requeue cases.
    var tier1AgreedPlies = [];
    (prepared.ocrMoves || []).forEach(function(cell, ply) {
      if (cell && cell._sheetCount === 2 && (cell._agree || cell._consensusTop)) {
        tier1AgreedPlies.push(ply | 0);
      }
    });

    return mgr.launchSearchesPromise(
      prepared.ocrMoves,
      this.methods,
      perMethodOptions,
      {
        onStepUpdate: function(method, step) {
          if (self.onMethodStep) {
            try { self.onMethodStep(gameId, method, step); } catch (e) {}
          }
        },
        onStatusChange: function(method, status) {
          // Surface worker loading/error as progress so the game list can
          // show "running beam…" / "beam error".
          if (status === 'loading' || status === 'error') {
            self._emitProgress(gameId, 'reconstructing',
              method + ': ' + status);
          }
        }
      },
      prepared.lockedPlies || [],
      tier1AgreedPlies
    );
  };

  // =========================================================================
  // Helpers
  // =========================================================================

  Queue.prototype._emitProgress = function(gameId, phase, message) {
    if (this.onProgress) {
      try { this.onProgress(gameId, phase, message); } catch (e) {}
    }
  };

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    Queue: Queue,
    DEFAULT_METHODS: DEFAULT_METHODS
  };
})();

// Expose globally
window.BatchReconstructQueue = BatchReconstructQueue;
