// =============================================================================
// batch-reconstruct-orchestrator.js — Auto-escalating reconstruction queue
// =============================================================================
// Wraps three per-method BatchReconstructQueue.Queue instances (greedy, beam,
// dijkstra) and coordinates auto-escalation:
//
//   Greedy fails on game K  -->  beam queue enqueues K
//   Beam fails on game K    -->  dijkstra queue enqueues K
//   Greedy solves K         -->  nothing further runs on K by default
//
// All three per-method queues process sequentially within themselves but in
// parallel across methods — i.e., greedy can be on game 20 while beam is on
// game 3 and dijkstra is on game 1, each from their own SearchManager
// instance. Peak worker count is 3.
//
// Exposes the same callback surface as the underlying Queue so existing
// callers (batch-game-list.js) can swap in without restructuring. The
// onGameComplete callback now fires once per method completion with an
// aggregated payload (results.{greedy,beam,dijkstra}), so the UI can show
// incremental progress as escalation runs.
//
// Dependencies:
//   - BatchReconstructQueue (batch-reconstruct-queue.js)
//   - BatchTriage (batch-triage.js)
// =============================================================================

var BatchReconstructOrchestrator = (function() {
  'use strict';

  var METHOD_ORDER = ['greedy', 'beam', 'dijkstra'];

  function _solved(methodResult) {
    // VALID = worker found the input already valid (0 fixes needed); SOLVED =
    // worker had to apply fixes. Both mean "this method produced a fully
    // validated game" — treat them identically. Without VALID here, a 0-fixes
    // game flips methodStatus to 'failed', the sidebar paints G✗B✗D✗ on a
    // game the panels render as "Solved!", and pickBestResult drops the
    // result so the game stays RECONSTRUCTING.
    return !!(methodResult &&
              (methodResult.status === 'SOLVED' ||
               methodResult.status === 'VALID'));
  }

  /**
   * @param {Object} [options]
   * @param {Object} [options.methodOptions] — per-method search options, same
   *                 shape as Queue's methodOptions. Split across the three
   *                 per-method queues internally.
   * @param {string} [options.lockMode='tier1'] — MergeSheets lock mode (forwarded).
   * @param {boolean} [options.escalate=true] — set false to disable auto-escalation
   *                  (Greedy-only; same as the old single-Queue behavior).
   */
  function Orchestrator(options) {
    options = options || {};
    this.methodOptions = options.methodOptions || {};
    this.lockMode = options.lockMode || 'tier1';
    this.escalate = options.escalate !== false;

    // Original ocrResult per gameId, retained so escalation queues run from
    // the same raw input rather than from Greedy's partially-fixed moves.
    this._ocrByGame = {};
    // Override prepared-input per gameId — set by requeue() when the user
    // edits a fix during review. Escalation after a requeue must use the
    // overridden moves, not the stale raw OCR.
    this._overrideByGame = {};
    // Aggregated per-game results: gameId -> {results: {greedy,beam,dijkstra},
    //                                         triage, picked, methodStatus}
    this.results = {};
    this.cancelled = false;

    // Callbacks (match Queue's shape)
    this.onProgress = null;       // (gameId, phase, message)
    this.onMethodStep = null;     // (gameId, method, step)
    this.onGameComplete = null;   // (gameId, aggregatedPayload) — fires per method
    this.onQueueComplete = null;  // (results) — fires when all three queues idle

    var Q = window.BatchReconstructQueue && window.BatchReconstructQueue.Queue;
    if (typeof Q !== 'function') {
      throw new Error('BatchReconstructQueue.Queue not available — load batch-reconstruct-queue.js first');
    }

    var self = this;
    this._queues = {};
    METHOD_ORDER.forEach(function(method) {
      var mo = {};
      if (self.methodOptions[method]) mo[method] = self.methodOptions[method];

      var q = new Q({
        methods: [method],
        methodOptions: mo,
        lockMode: self.lockMode
      });

      q.onProgress = function(gameId, phase, message) {
        // Surface "this method just started on this game" as methodStatus=running
        // so the status indicator can animate. The Queue fires 'reconstructing'
        // when it picks up a new item from its queue.
        if (phase === 'reconstructing' && self.results[gameId]) {
          self.results[gameId].methodStatus[method] = 'running';
        } else if (phase === 'reconstruct_error' && self.results[gameId]) {
          self.results[gameId].methodStatus[method] = 'error';
        }
        if (self.onProgress) {
          try { self.onProgress(gameId, phase, message, method); } catch (e) {}
        }
      };
      q.onMethodStep = function(gameId, m, step) {
        if (self.onMethodStep) {
          try { self.onMethodStep(gameId, m, step); } catch (e) {}
        }
      };
      q.onGameComplete = function(gameId, payload) {
        self._handleMethodComplete(method, gameId, payload);
      };
      q.onQueueComplete = function() {
        self._maybeFireQueueComplete();
      };

      self._queues[method] = q;
    });
  }

  // =========================================================================
  // Public API — mirrors Queue's shape for drop-in use
  // =========================================================================

  /**
   * Enqueue a game. Always lands in the greedy queue first; escalation to
   * beam/dijkstra happens automatically on failure (if escalate=true).
   */
  Orchestrator.prototype.enqueue = function(gameId, ocrResult) {
    this._ocrByGame[gameId] = ocrResult;
    // A fresh enqueue supersedes any earlier override.
    delete this._overrideByGame[gameId];
    this.results[gameId] = _freshAggregate('queued');
    // Sort the greedy queue so easier games (fewer low-confidence cells) are
    // processed first. The user gets a steady stream of ready games while
    // Greedy chews on the hard ones at the back of the queue. Escalation to
    // beam/dijkstra keeps FIFO-by-failure-order (unpriorityed enqueue).
    var priority = _computeDifficulty(ocrResult);
    this._queues.greedy.enqueue(gameId, ocrResult, priority);
  };

  // Count low-confidence cells as a cheap difficulty proxy. Works uniformly
  // for single- and dual-sheet games. Not a great signal — cells with
  // low-confidence OCR are often salvageable via the candidate list — but
  // it's strictly better than FIFO for batch ordering and available the
  // moment OCR completes (no merge needed).
  var _LOW_CONF_THRESHOLD = 0.8;
  function _computeDifficulty(ocrResult) {
    // Games with trailing noise need user attention before reconstruction
    // can succeed (the garbage cells at the end produce illegal moves that
    // reconstruction can't fix on its own). Boost them to the very front
    // of the queue so the user sees and truncates them first.
    if (_hasTrailingNoise(ocrResult)) return -1000;

    if (!ocrResult) return 0;
    var count = 0;
    function scan(cells) {
      if (!Array.isArray(cells)) return;
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        var conf = (c && typeof c.confidence === 'number') ? c.confidence : 1;
        if (conf < _LOW_CONF_THRESHOLD) count++;
      }
    }
    if (ocrResult.isDualSheet) {
      scan(ocrResult.sheet1);
      scan(ocrResult.sheet2);
    } else {
      scan(ocrResult.ocrCells);
    }
    return count;
  }

  // Extracted from ui.js::detectTrailingNoise so it can run at batch-enqueue
  // time without DOM dependencies. Pure check: do the last 1-2 OCR cells on
  // either sheet look like garbage (low confidence)? Matches the thresholds
  // that already trigger the "Continue" confirmation prompt in the single-
  // sheet flow. For dual-sheet games, noise on either sheet qualifies.
  var _NOISE_THRESHOLD_PAIR = 0.55;
  var _NOISE_THRESHOLD_LAST = 0.50;
  function _hasTrailingNoise(ocrResult) {
    if (!ocrResult) return false;
    function scan(cells) {
      if (!Array.isArray(cells) || cells.length < 4) return false;
      var last = cells[cells.length - 1];
      var sec  = cells[cells.length - 2];
      var lastConf = (last && typeof last.confidence === 'number') ? last.confidence : 1;
      var secConf  = (sec  && typeof sec.confidence  === 'number') ? sec.confidence  : 1;
      if (lastConf < _NOISE_THRESHOLD_PAIR && secConf < _NOISE_THRESHOLD_PAIR) return true;
      if (lastConf < _NOISE_THRESHOLD_LAST) return true;
      return false;
    }
    if (ocrResult.isDualSheet) {
      return scan(ocrResult.sheet1) || scan(ocrResult.sheet2);
    }
    return scan(ocrResult.ocrCells);
  }

  /**
   * Re-enqueue after user override. Goes back through greedy first — the
   * override changes the input, so every method has to re-run if escalation
   * fires again. Clears prior per-game results to avoid stale triage.
   *
   * Also aborts any in-flight Beam/Dijkstra work for this game. Those are
   * running against the pre-override input; if we let them finish, their
   * onGameComplete callback would pour stale results back into the
   * aggregate we just reset. The aborted searches fire with
   * status='CANCELLED', which _handleMethodComplete discards.
   */
  Orchestrator.prototype.requeue = function(gameId, updatedOcrMoves, lockedPlies, fromPly) {
    // Remember the overridden input so that if greedy fails on the override,
    // escalation to beam/dijkstra runs on the SAME overridden moves, not on
    // the stale raw OCR we stored at original-enqueue time.
    this._overrideByGame[gameId] = {
      ocrMoves: updatedOcrMoves,
      lockedPlies: (lockedPlies || []).slice(),
      fromPly: fromPly || 0
    };
    this.results[gameId] = _freshAggregate('queued');

    // Kill every in-flight run for this game across all three queues. Greedy
    // will be restarted right below via requeue; beam/dijkstra just get
    // purged of any pending work so they don't fire stale completions.
    METHOD_ORDER.forEach(function(m) {
      if (m === 'greedy') return;  // greedy.requeue below handles greedy
      try { this._queues[m].abortGame(gameId); } catch (e) {}
    }, this);
    // Greedy is also likely processing this game — abort + requeue covers
    // both the in-flight and the pending case.
    try { this._queues.greedy.abortGame(gameId); } catch (e) {}
    this._queues.greedy.requeue(gameId, updatedOcrMoves, lockedPlies, fromPly);

    // Notify listeners that all prior per-method results for this game are
    // invalidated. The interactive panel bridge needs this: otherwise panels
    // keep showing the stale Beam/Dijkstra partial result the user was
    // reviewing when they triggered the override, even though the aggregate
    // above is already empty. Fires AFTER state is reset so listeners see a
    // clean aggregate.
    if (this.onGameReset) {
      try { this.onGameReset(gameId); } catch (e) {}
    }
  };

  function _freshAggregate(greedyStatus) {
    return {
      results: {},
      triage: null,
      picked: null,
      methodStatus: { greedy: greedyStatus, beam: 'idle', dijkstra: 'idle' }
    };
  }

  Orchestrator.prototype.cancel = function() {
    this.cancelled = true;
    METHOD_ORDER.forEach(function(m) {
      try { this._queues[m].cancel(); } catch (e) {}
    }, this);
  };

  /**
   * Abort all in-flight + queued work for a single game across all three
   * per-method queues, without affecting other games or disabling future
   * enqueues. Used when a game becomes functionally complete (revalidate
   * found no stuck point) or is explicitly verified — the algorithms are
   * no longer needed and their continued step events would overwrite the
   * "✓ Game complete" panel header set by markPanelsGameComplete.
   *
   * Mirrors the per-method abort fan-out that requeue() already does, but
   * does not re-enqueue. The aborted searches return CANCELLED, which
   * _handleMethodComplete discards, so no stale aggregate is written.
   */
  Orchestrator.prototype.abortGame = function(gameId) {
    if (!gameId) return;
    METHOD_ORDER.forEach(function(m) {
      try { this._queues[m].abortGame(gameId); } catch (e) {}
    }, this);
  };

  Orchestrator.prototype.resume = function() {
    this.cancelled = false;
    METHOD_ORDER.forEach(function(m) {
      try { this._queues[m].resume(); } catch (e) {}
    }, this);
  };

  Orchestrator.prototype.getStatus = function() {
    var out = { byMethod: {}, processing: false };
    var total = 0, remaining = 0;
    METHOD_ORDER.forEach(function(m) {
      var s = this._queues[m].getStatus();
      out.byMethod[m] = s;
      total += s.total; remaining += s.remaining;
      if (s.processing) out.processing = true;
    }, this);
    out.total = total;
    out.remaining = remaining;
    return out;
  };

  Orchestrator.prototype.getResult = function(gameId) {
    return this.results[gameId] || null;
  };

  // =========================================================================
  // Internal: aggregation, escalation, triage
  // =========================================================================

  Orchestrator.prototype._handleMethodComplete = function(method, gameId, payload) {
    // payload is {results, triage, picked} from the single-method queue —
    // results[method] is the interesting slot.
    var aggregate = this.results[gameId] || (this.results[gameId] = {
      results: {}, triage: null, picked: null,
      methodStatus: { greedy: 'idle', beam: 'idle', dijkstra: 'idle' }
    });

    var methodResult = (payload && payload.results && payload.results[method]) || null;

    // Cancelled completions come from abortGame (called by requeue to kill
    // stale in-flight work on the pre-override input). Discarding them
    // entirely — don't store results, don't update methodStatus, don't
    // escalate — keeps the aggregate clean while fresh work flows in.
    if (methodResult && methodResult.status === 'CANCELLED') {
      return;
    }

    aggregate.results[method] = methodResult;

    // Per-method status: 'solved' | 'partial' | 'failed' | 'error'.
    // Partial = search-worker returned status=PARTIAL: applied some fixes but
    // could not reach the end of the game. Still useful (the partial fixes
    // are real corrections), and the orchestrator escalates to the next
    // method the same way it does on failure (_solved() is strict about
    // SOLVED so the escalation path below picks this up unchanged).
    if (!payload || !payload.results) {
      aggregate.methodStatus[method] = 'error';
    } else if (_solved(methodResult)) {
      aggregate.methodStatus[method] = 'solved';
    } else if (methodResult && methodResult.status === 'PARTIAL') {
      aggregate.methodStatus[method] = 'partial';
    } else {
      aggregate.methodStatus[method] = 'failed';
    }

    // Re-triage on the current aggregate (only present methods are considered).
    if (window.BatchTriage) {
      try {
        aggregate.triage = window.BatchTriage.classifyTier(aggregate.results);
        aggregate.picked = window.BatchTriage.pickBestResult(aggregate.results);
      } catch (e) {
        aggregate.triage = { tier: 'C', reason: 'triage_error', details: { message: String(e && e.message || e) } };
      }
    }

    // Decide on escalation BEFORE firing onGameComplete so the methodStatus
    // we hand to the UI reflects the next-method queued state (otherwise the
    // panel for the next method keeps showing 'Idle' until its first step
    // event, which can be seconds or minutes away).
    //
    // Always-chain policy: if a later method exists, hand the game off,
    // even on SOLVED. CLAUDE.md says "cross-algorithm agreement is a
    // stronger signal than any single algorithm's output" — idling Beam
    // and Dijkstra after Greedy solves throws away free corroboration
    // AND lets the triage classifier actually distinguish Tier A (all
    // agree) from Tier B (some disagreement). The three queues run in
    // parallel so this doesn't block the next game moving through the
    // greedy queue; it just uses the beam/dijkstra queues that would
    // otherwise sit idle.
    var willEscalate = this.escalate;
    var next = willEscalate ? _nextMethod(method) : null;
    var escalationInput = null;  // 'requeue' | 'enqueue' | null
    if (next) {
      var override = this._overrideByGame[gameId];
      if (override) {
        escalationInput = 'requeue';
        aggregate.methodStatus[next] = 'queued';
      } else if (this._ocrByGame[gameId]) {
        escalationInput = 'enqueue';
        aggregate.methodStatus[next] = 'queued';
      }
      // else: can't escalate (no stored input); leave methodStatus[next] alone.
    }

    // Notify the UI of this method's completion + current aggregate state.
    if (this.onGameComplete) {
      try { this.onGameComplete(gameId, aggregate, method); } catch (e) {}
    }

    if (next && escalationInput) {
      // Escalation uses the SAME input greedy saw, not this method's partial
      // fixes. If there's an override from requeue() we route through the
      // next queue's .requeue() to preserve the override; otherwise start
      // from the raw OCR result.
      if (escalationInput === 'requeue') {
        var ov = this._overrideByGame[gameId];
        this._queues[next].requeue(gameId, ov.ocrMoves, ov.lockedPlies, ov.fromPly);
      } else {
        this._queues[next].enqueue(gameId, this._ocrByGame[gameId]);
      }
      if (this.onProgress) {
        try {
          var _msg = _solved(methodResult)
            ? method + ' solved — chaining to ' + next + ' for corroboration'
            : method + ' did not solve — escalating to ' + next;
          this.onProgress(gameId, 'escalating', _msg, method);
        } catch (e) {}
      }
    }
  };

  function _nextMethod(method) {
    var idx = METHOD_ORDER.indexOf(method);
    if (idx < 0 || idx >= METHOD_ORDER.length - 1) return null;
    return METHOD_ORDER[idx + 1];
  }

  Orchestrator.prototype._maybeFireQueueComplete = function() {
    // Fire only when all three per-method queues are idle with empty queues.
    var allIdle = METHOD_ORDER.every(function(m) {
      var s = this._queues[m].getStatus();
      return !s.processing && s.remaining === 0;
    }, this);
    if (allIdle && this.onQueueComplete) {
      try { this.onQueueComplete(this.results); } catch (e) {}
    }
  };

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    Orchestrator: Orchestrator,
    METHOD_ORDER: METHOD_ORDER,
    // Pure helper — exposed so batch-game-list can mark games in the UI
    // without having to re-implement the detection logic.
    hasTrailingNoise: _hasTrailingNoise
  };
})();

window.BatchReconstructOrchestrator = BatchReconstructOrchestrator;
