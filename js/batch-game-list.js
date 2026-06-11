// =============================================================================
// batch-game-list.js — Game list sidebar UI + status tracking for batch mode
// =============================================================================
// Phase 1 of Batch Mode. Shows a list of games with status indicators.
// Clicking a game loads its OCR results into the main Zugwise interface.
//
// Dependencies: batch-naming.js, batch-ocr-queue.js, app.js (state, log)
// =============================================================================

var BatchGameList = (function() {
  'use strict';

  // =========================================================================
  // Game status tracking
  // =========================================================================

  var GAME_STATUS = {
    QUEUED:           'queued',
    OCR_RUNNING:      'ocr_running',
    OCR_COMPLETE:     'ocr_complete',
    OCR_ERROR:        'ocr_error',
    GRID_WARNING:     'grid_warning',
    GRID_FAILED:      'grid_failed',
    NEEDS_TRUNCATION: 'needs_truncation',   // Trailing OCR noise — user must act first
    RECONSTRUCTING:   'reconstructing',     // Phase 2: algorithms running in bg
    RECONSTRUCT_ERROR:'reconstruct_error',  // Phase 2
    NEEDS_REVIEW:     'needs_review',
    IN_REVIEW:        'in_review',
    VERIFIED:         'verified',
    EXPORTED:         'exported'
  };

  var STATUS_DISPLAY = {};
  STATUS_DISPLAY[GAME_STATUS.QUEUED]       = { icon: '\u2B1C', label: 'Queued',       cssClass: 'text-gray-400' };
  STATUS_DISPLAY[GAME_STATUS.OCR_RUNNING]  = { icon: '\uD83D\uDD35', label: 'OCR running', cssClass: 'text-blue-400 animate-pulse' };
  STATUS_DISPLAY[GAME_STATUS.OCR_COMPLETE] = { icon: '\u2B1C', label: 'OCR done',     cssClass: 'text-gray-300' };
  STATUS_DISPLAY[GAME_STATUS.OCR_ERROR]    = { icon: '\uD83D\uDD34', label: 'OCR error',   cssClass: 'text-red-400' };
  STATUS_DISPLAY[GAME_STATUS.GRID_WARNING] = { icon: '\u26A0\uFE0F', label: 'Grid warning', cssClass: 'text-yellow-400' };
  STATUS_DISPLAY[GAME_STATUS.GRID_FAILED]  = { icon: '\uD83D\uDD34', label: 'Grid failed',  cssClass: 'text-red-400' };
  STATUS_DISPLAY[GAME_STATUS.NEEDS_TRUNCATION]  = { icon: '\u2702\uFE0F',    label: 'Needs truncation', cssClass: 'text-orange-400 animate-pulse' };
  STATUS_DISPLAY[GAME_STATUS.RECONSTRUCTING]    = { icon: '\u2699\uFE0F',    label: 'Reconstructing', cssClass: 'text-blue-300 animate-pulse' };
  STATUS_DISPLAY[GAME_STATUS.RECONSTRUCT_ERROR] = { icon: '\uD83D\uDD34',    label: 'Reconstruct error', cssClass: 'text-red-400' };
  STATUS_DISPLAY[GAME_STATUS.NEEDS_REVIEW] = { icon: '\uD83D\uDFE1', label: 'Needs review', cssClass: 'text-yellow-400' };
  STATUS_DISPLAY[GAME_STATUS.IN_REVIEW]    = { icon: '\uD83D\uDD0D', label: 'Reviewing',    cssClass: 'text-blue-400' };
  STATUS_DISPLAY[GAME_STATUS.VERIFIED]     = { icon: '\u2705', label: 'Verified',     cssClass: 'text-green-400' };
  STATUS_DISPLAY[GAME_STATUS.EXPORTED]     = { icon: '\u2705', label: 'Exported',     cssClass: 'text-green-400' };

  // =========================================================================
  // Batch state
  // =========================================================================

  var batchState = {
    active: false,
    games: new Map(),          // gameId -> game metadata + status
    ocrResults: {},            // gameId -> {ocrCells, gridSidecar}
    currentGameId: null,
    selectedRound: null,
    selectedSection: null,     // null = "all sections"; only meaningful when >1 section
    allGames: null,            // All games from folder (all rounds, all sections)
    availableRounds: [],
    availableSections: [],
    folderHandle: null,        // File System Access API handle
    ocrQueue: null,            // BatchOcrQueue.Queue instance
    reconstructQueue: null,    // BatchReconstructOrchestrator.Orchestrator instance (Phase 2)
    reconstructResults: {}     // gameId -> {results, triage, picked} from reconstruction
  };

  // =========================================================================
  // Initialization
  // =========================================================================

  /**
   * Initialize batch mode from a folder of scan files.
   * @param {FileSystemDirectoryHandle} dirHandle - Selected folder
   * @returns {Promise<Object>} - {games, rounds, unmatched}
   */
  async function initFromFolder(dirHandle) {
    batchState.folderHandle = dirHandle;

    // Read all files recursively
    if (typeof log === 'function') log('Scanning folder...');
    var files = await window.BatchNaming.readDirectoryRecursive(dirHandle);

    // Group into games. Pass the picked folder's name as a section
    // fallback so picking a section folder directly (e.g. "Premier")
    // populates the section field — paths from the File System Access API
    // don't include the chosen folder's name. When the picked folder is
    // a tournament root containing per-section subfolders, directory
    // inference still wins and the per-section name is kept.
    var result = window.BatchNaming.groupFilesIntoGames(files, {
      defaultSection: dirHandle.name || null
    });
    batchState.allGames = result.games;
    batchState.availableSections = window.BatchNaming.getAvailableSections(result.games);
    batchState.selectedSection = null;
    batchState.availableRounds = window.BatchNaming.getAvailableRounds(result.games);

    if (typeof log === 'function') {
      log('Found ' + result.games.size + ' games across ' +
          batchState.availableRounds.length + ' round(s)' +
          (batchState.availableSections.length > 1
            ? ' in ' + batchState.availableSections.length + ' sections'
            : ''));
      if (result.unmatched.length > 0) {
        log('  ' + result.unmatched.length + ' file(s) could not be matched to a game');
      }
    }

    return {
      games: result.games,
      rounds: batchState.availableRounds,
      sections: batchState.availableSections,
      unmatched: result.unmatched
    };
  }

  /**
   * Initialize batch mode from file input (fallback, no directory handle).
   * @param {FileList|Array<File>} files
   * @returns {Object} - {games, rounds, unmatched}
   */
  function initFromFiles(files) {
    var fileArray = Array.from(files).map(function(f) {
      return {
        name: f.name,
        path: f.webkitRelativePath || f.name,
        handle: null,
        file: f
      };
    });

    // If every file shares the same top-level folder, use it as the
    // section fallback. With <input webkitdirectory> the first segment is
    // already the chosen folder name, so directory inference normally
    // catches it; this only matters if some path entries lack a
    // webkitRelativePath (e.g. drag-drop of loose files).
    var topLevels = {};
    fileArray.forEach(function(f) {
      var parts = (f.path || '').split('/');
      if (parts.length > 1) topLevels[parts[0]] = true;
    });
    var topKeys = Object.keys(topLevels);
    var defaultSection = (topKeys.length === 1) ? topKeys[0] : null;

    var result = window.BatchNaming.groupFilesIntoGames(fileArray, {
      defaultSection: defaultSection
    });
    batchState.allGames = result.games;
    batchState.availableSections = window.BatchNaming.getAvailableSections(result.games);
    batchState.selectedSection = null;
    batchState.availableRounds = window.BatchNaming.getAvailableRounds(result.games);

    return {
      games: result.games,
      rounds: batchState.availableRounds,
      sections: batchState.availableSections,
      unmatched: result.unmatched
    };
  }

  /**
   * Select a section and narrow the available rounds. Multi-section
   * tournaments call this BEFORE selectRound; single-section ones can
   * skip it entirely (selectedSection stays null → all rounds shown).
   * @param {string|null} section - Section name, or null to clear filter.
   */
  function selectSection(section) {
    batchState.selectedSection = section || null;
    batchState.availableRounds = window.BatchNaming.getAvailableRounds(
      batchState.allGames || new Map(), { section: batchState.selectedSection });
    // Clear any prior round selection — the round IDs in the new section
    // may not exist in the old section, so forcing re-pick is safer than
    // silently leaving a stale selection in batchState.selectedRound.
    batchState.selectedRound = null;
  }

  /**
   * Select a round and populate the game list.
   * @param {number} round
   */
  function selectRound(round) {
    batchState.selectedRound = round;
    var roundGames = window.BatchNaming.filterGamesByRound(
      batchState.allGames, round, batchState.selectedSection);

    // Build game status entries
    batchState.games = new Map();
    roundGames.forEach(function(game, gameId) {
      batchState.games.set(gameId, {
        gameId: game.gameId,
        section: game.section,
        round: game.round,
        board: game.board,
        // Carry board provenance so attachPairings knows a directory-derived
        // board ("…/Board 6/") is authoritative and must not be overwritten
        // by the tournament file's (possibly section-local or synthetic)
        // board number. Dropping it here was silently re-enabling the clobber.
        boardFromDirectory: game.boardFromDirectory,
        files: game.files,
        status: GAME_STATUS.QUEUED,
        ocrCellCount: 0,
        pairing: null  // Populated later if tournament file loaded
      });
    });

    batchState.active = true;

    // Phase 4: if a tournament file has been loaded, attach pairing data
    // to every game. Games keep `pairing: null` when no match is found
    // (e.g. missing tournament file or unmatchable section/round/board).
    var tournamentData = window._batchTournamentData || null;
    if (tournamentData && window.BatchTournament &&
        typeof window.BatchTournament.attachPairings === 'function') {
      var matched = window.BatchTournament.attachPairings(batchState.games, tournamentData);
      if (typeof log === 'function') {
        log('[Batch] Matched ' + matched + '/' + batchState.games.size +
            ' games to tournament pairings');
      }
    }

    renderGameList();
  }

  // =========================================================================
  // OCR queue integration
  // =========================================================================

  /**
   * Start batch OCR processing for the selected round.
   */
  function startBatchOcr() {
    if (!batchState.active || batchState.games.size === 0) return;

    // Reset per-game flags from any prior batch run so Cancel → Start again
    // doesn't inherit stale noise / tier / method-status indicators. The
    // queues themselves are fresh (created below), but batchState.games
    // entries persist with whatever the last run left on them.
    batchState.games.forEach(function(game) {
      game.status = GAME_STATUS.QUEUED;
      game.hasTrailingNoise = false;
      game.noiseResolved = false;
      game.methodStatus = null;
      game.tier = null;
      game.triageReason = null;
      game.triageDetails = null;
      game.reconstructPicked = null;
      game.ocrCellCount = 0;
    });
    batchState.ocrResults = {};
    batchState.reconstructResults = {};
    // Drop any row-badge freezes left over from a prior batch run (Cancel →
    // Start again). See _completedRowGameIds.
    _completedRowGameIds = {};

    var queue = new window.BatchOcrQueue.Queue();
    batchState.ocrQueue = queue;

    // Phase 2: spin up the reconstruction orchestrator alongside OCR so each
    // game flows OCR → reconstruct (Greedy, auto-escalating to Beam/Dijkstra
    // on failure) → triage while the next game is still OCRing.
    var reconstructQueue = null;
    if (window.BatchReconstructOrchestrator) {
      reconstructQueue = new window.BatchReconstructOrchestrator.Orchestrator();
      batchState.reconstructQueue = reconstructQueue;

      // Feed the interactive right-sidebar panels from the orchestrator
      // instead of running duplicate searches. See batch-panel-bridge.js.
      if (window.BatchPanelBridge) {
        window.BatchPanelBridge.attach(reconstructQueue);
      }

      reconstructQueue.onProgress = function(gameId, phase, message, method) {
        // Row frozen at completion: a run still unwinding on the
        // pre-completion OCR must not flip g.status back to RECONSTRUCTING or
        // re-seed escalation badges (and the bridge breadcrumb) over the
        // panels' "✓ Game complete". Cleared by onGameReset on requeue.
        if (_completedRowGameIds[gameId]) return;
        var g = batchState.games.get(gameId);
        if (g) {
          // Force-link g.methodStatus to the orchestrator's aggregate on every
          // progress event. The orchestrator's per-method onProgress wrapper
          // mutates aggregate.methodStatus[method] BEFORE we get here; if
          // g.methodStatus is a separate object (because some reset path
          // earlier replaced it with a fresh literal, or onGameComplete
          // hasn't run yet to reference-copy the aggregate over), the
          // mutation lands on the aggregate but the renderer reads the
          // orphan. Re-binding here every event eliminates that whole class
          // of races — after this line, the renderer sees whatever the
          // orchestrator's wrapper just wrote.
          var _orchAgg = reconstructQueue.getResult && reconstructQueue.getResult(gameId);
          if (_orchAgg && _orchAgg.methodStatus) {
            g.methodStatus = _orchAgg.methodStatus;
          }
          if (phase === 'reconstructing') {
            g.status = GAME_STATUS.RECONSTRUCTING;
            // Defensive mutation in case the force-link above didn't fire
            // (no orchestrator aggregate yet — shouldn't happen for an
            // enqueued game, but harmless to keep).
            if (method) {
              if (!g.methodStatus) g.methodStatus = {};
              g.methodStatus[method] = 'running';
            }
          } else if (phase === 'reconstruct_error') {
            g.status = GAME_STATUS.RECONSTRUCT_ERROR;
            if (method) {
              if (!g.methodStatus) g.methodStatus = {};
              g.methodStatus[method] = 'error';
            }
          } else if (phase === 'escalating' && method) {
            // The next method (beam / dijkstra) is about to pick up this
            // game. Reflect it so the strip and row accent show the
            // handoff in real time.
            var nextMethod = (method === 'greedy') ? 'beam'
                           : (method === 'beam') ? 'dijkstra' : null;
            if (nextMethod) {
              if (!g.methodStatus) g.methodStatus = {};
              g.methodStatus[nextMethod] = 'queued';
            }
          }
        }
        var tag = method ? (' [' + method + ']') : '';
        if (typeof log === 'function') log('[Batch] ' + gameId + tag + ': ' + message);
        if (window.BatchPanelBridge) {
          window.BatchPanelBridge.onProgress(gameId, phase, message, method);
        }
        renderGameList();
      };

      reconstructQueue.onMethodStep = function(gameId, method, step) {
        // Row frozen at completion — same rationale as onProgress. Skip both
        // the bridge forward (panels are frozen too) and the row re-seed.
        if (_completedRowGameIds[gameId]) return;
        if (window.BatchPanelBridge) {
          window.BatchPanelBridge.onStep(gameId, method, step);
        }
        // Re-link g.methodStatus to the orchestrator's aggregate. Step events
        // fire continuously during a search, so this is the high-frequency
        // fallback that catches any decoupling the onProgress force-link
        // missed. Without this, the glyph for the currently-running game
        // could stay stuck at the pre-method-start value until the next
        // phase transition (which can be many seconds away for beam/dijkstra
        // on a large game).
        var _g = batchState.games.get(gameId);
        if (_g) {
          var _orchAgg = reconstructQueue.getResult && reconstructQueue.getResult(gameId);
          if (_orchAgg && _orchAgg.methodStatus) {
            _g.methodStatus = _orchAgg.methodStatus;
          }
        }
        // Throttled sidebar repaint so per-step worker progress (which only
        // flows through onMethodStep, not onProgress) eventually reaches the
        // G/B/D row glyphs. 150ms = ~6 fps for live progress; renderGameList
        // is cheap enough that this is invisible in CPU.
        _scheduleListRepaint();
      };

      reconstructQueue.onGameComplete = function(gameId, payload, method) {
        // Fires once per method (Greedy, then Beam if Greedy failed, etc.).
        // payload is the current aggregate — overwrite each time.
        var _g0 = batchState.games.get(gameId);
        console.log('[RECONSTRUCT-COMPLETE] ' + gameId + ' method=' + method +
                    ' (game.status=' + (_g0 && _g0.status) +
                    ', picked=' + (payload && payload.picked && payload.picked.method) +
                    '/' + (payload && payload.picked && payload.picked.result && payload.picked.result.status) +
                    ')');
        // Row frozen at completion (the visible game revalidated complete and
        // markPanelsGameComplete cleared the badges). A late method finishing
        // on the pre-completion OCR would otherwise overwrite reconstructResults
        // with a stale partial and repaint "G◐ B✗ D⋯". Discard like the
        // NEEDS_TRUNCATION case below. Cleared by onGameReset on requeue.
        if (_completedRowGameIds[gameId]) {
          console.log('[RECONSTRUCT-COMPLETE] ' + gameId +
                      ' ⛔ discarded — row frozen at completion');
          return;
        }
        // If the game has been flipped to NEEDS_TRUNCATION since the
        // method was enqueued (later OCR pass detected noise; user opened
        // the game and ui.js's noise detector fired; autoapply review
        // requeued and orchestrator's gate caught it), the algorithm's
        // result is moot — the user is about to truncate. Discard rather
        // than paint stale G/B/D badges on a game waiting for the
        // scissors panel. Without this, an in-flight method that was
        // launched on stale partial OCR returns its result here AFTER
        // BatchGameList.queue.onGameComplete already aborted + cleared,
        // and the badges reappear.
        if (_g0 && _g0.status === GAME_STATUS.NEEDS_TRUNCATION) {
          console.log('[RECONSTRUCT-COMPLETE] ' + gameId +
                      ' ⛔ discarded — game is NEEDS_TRUNCATION');
          if (batchState.reconstructResults) {
            delete batchState.reconstructResults[gameId];
          }
          renderGameList();
          return;
        }
        batchState.reconstructResults[gameId] = payload;
        var g = batchState.games.get(gameId);
        // If the user already verified (or exported) this game while a
        // late method was still in flight, do NOT clobber the sidebar:
        // writing payload.methodStatus would resurrect "G✗ B✗ D✗" on a
        // hand-completed game, and the status flip below would knock it
        // back to NEEDS_REVIEW. The orchestrator's reconstructResults
        // entry above is still updated for completeness; the panels'
        // VERIFIED special-case keeps showing "✓ Game complete".
        var alreadyDone = g && (g.status === GAME_STATUS.VERIFIED ||
                                g.status === GAME_STATUS.EXPORTED);
        if (g && !alreadyDone) {
          g.tier = payload.triage ? payload.triage.tier : null;
          g.triageReason = payload.triage ? payload.triage.reason : null;
          g.triageDetails = payload.triage ? payload.triage.details : null;
          g.reconstructPicked = payload.picked || null;
          g.methodStatus = payload.methodStatus || null;
          // Flip to NEEDS_REVIEW only when we have something definitive:
          //   (a) some method actually SOLVED the game, OR
          //   (b) the last method in the chain (dijkstra) has finished —
          //       failed, errored, or landed on PARTIAL. No further
          //       escalation possible, so the user should pick it up.
          // Otherwise stay RECONSTRUCTING — beam or dijkstra is still running.
          var _ps = payload.picked && payload.picked.result && payload.picked.result.status;
          var pickedSolved = (_ps === 'SOLVED' || _ps === 'VALID');
          var chainExhausted = payload.methodStatus &&
            ['failed', 'error', 'partial'].indexOf(payload.methodStatus.dijkstra) !== -1;
          if (pickedSolved || chainExhausted) {
            g.status = GAME_STATUS.NEEDS_REVIEW;
          }
          // Auto-save individual game PGN + round combined PGN whenever
          // reconstruction produces a SOLVED result. Runs fire-and-forget so
          // the file lands on disk without blocking the callback chain.
          // Only fires on SOLVED (not PARTIAL/FAILED) — we don't want to
          // write incomplete results to the round file automatically.
          if (pickedSolved) {
            _autoSaveGame(gameId, payload).catch(function(e) {
              console.warn('[Batch] Auto-save error for', gameId, e);
            });
          }
        }
        if (window.BatchPanelBridge) {
          window.BatchPanelBridge.onGameComplete(gameId, payload, method);
        }
        renderGameList();
      };

      reconstructQueue.onQueueComplete = function(results) {
        if (typeof log === 'function') {
          var n = Object.keys(results).length;
          log('[Batch] Reconstruction complete: ' + n + ' games triaged');
        }
      };

      // When the user overrides a fix during review, requeue() wipes the
      // per-method aggregate for that game. Mirror that reset on the game
      // record (methodStatus, tier, picked) and — if this is the game the
      // user is currently looking at — re-bind the interactive algorithm
      // panels so they clear instead of continuing to show the stale
      // pre-override result. Without this, the Greedy/Beam/Dijkstra panels
      // kept displaying whatever they had rendered before, even though the
      // algorithms were about to re-run on different OCR.
      reconstructQueue.onGameReset = function(gameId) {
        delete batchState.reconstructResults[gameId];
        var g = batchState.games.get(gameId);
        if (g) {
          // Point g.methodStatus at the orchestrator's fresh aggregate so the
          // two stay reference-linked. requeue() already called
          // this.results[gameId] = _freshAggregate('queued') before firing
          // this callback, so reading it back here picks up the exact object
          // the orchestrator's per-method onProgress wrapper will mutate
          // when the next greedy/beam/dijkstra run kicks off. Without this,
          // creating a fresh literal here decouples g.methodStatus from
          // the aggregate — subsequent 'reconstructing' events update the
          // aggregate but the row renderer reads the orphan, and the row
          // shows stale glyphs for the duration of the reconstruction
          // (the "B⋯ while beam is mid-search" symptom we tracked down).
          var _orchAgg = reconstructQueue.getResult(gameId);
          g.methodStatus = (_orchAgg && _orchAgg.methodStatus) ||
                           { greedy: 'queued', beam: 'idle', dijkstra: 'idle' };
          g.tier = null;
          g.triageReason = null;
          g.triageDetails = null;
          g.reconstructPicked = null;
        }
        // Drop the panel-frozen flag so live step events render again on
        // the re-run. Set by _clearStalenessAndAbort when the user finished
        // the game; an override+requeue means the user is going back into
        // it, so the panels need to come back to life.
        if (window.BatchPanelBridge &&
            typeof window.BatchPanelBridge.clearComplete === 'function') {
          try { window.BatchPanelBridge.clearComplete(gameId); } catch (e) {}
        }
        // Symmetric thaw for the game-list row: the re-run will legitimately
        // produce fresh G/B/D badges again.
        delete _completedRowGameIds[gameId];
        if (window.BatchPanelBridge &&
            typeof window.BatchPanelBridge.getBoundGameId === 'function' &&
            window.BatchPanelBridge.getBoundGameId() === gameId &&
            typeof window.BatchPanelBridge.bindGame === 'function') {
          window.BatchPanelBridge.bindGame(gameId);
        }
        renderGameList();
      };
    }

    // Set up output directory if available
    if (batchState.folderHandle) {
      queue.setOutputDir(batchState.folderHandle);
    }

    // Progress callback
    queue.onProgress = function(gameId, status, detail) {
      var game = batchState.games.get(gameId);
      if (game) {
        game.status = status;
        // Keep the latest short detail on the game so renderGameList can
        // paint a per-row progress line ("OCR 3/6" etc.) while OCR is
        // running. Cleared in onGameComplete below.
        if (status === GAME_STATUS.OCR_RUNNING && detail) {
          game.ocrProgress = _shortenOcrDetail(detail);
        } else if (status !== GAME_STATUS.OCR_RUNNING) {
          game.ocrProgress = null;
        }
        if (typeof log === 'function') {
          log('[Batch] ' + gameId + ': ' + detail);
        }
      }
      renderGameList();
    };

    // Game complete callback — hand off to reconstruction queue, unless the
    // tail cells look like noise. In that case block reconstruction until
    // the user has reviewed and truncated the game (otherwise Greedy/Beam/
    // Dijkstra all burn cycles on garbage then report FAILED, which is
    // exactly the confusing state the user complained about).
    queue.onGameComplete = function(gameId, result) {
      var s1Count = result && result.sheet1 ? result.sheet1.length : 0;
      var s2Count = result && result.sheet2 ? result.sheet2.length : 0;
      var ocrCount = result && result.ocrCells ? result.ocrCells.length : 0;
      // If onGameComplete fires multiple times for the same gameId (OCR
      // queue ran the game more than once -- pages OCR'd in batches,
      // file scanner producing duplicates, or any retry path), the LATEST
      // result is the authoritative one. ANY reconstruction launched by
      // an earlier call ran on stale partial input and must be aborted +
      // its aggregate discarded before we re-decide based on the new
      // result. Without this, an early "not noisy on the 40 moves we had
      // so far" decision leaks Greedy/Beam/Dijkstra results into the game
      // list even after a later call detects noise on the full content.
      var hadPriorResult = !!batchState.ocrResults[gameId];
      console.log('[ON-GAME-COMPLETE] ' + gameId +
                  ' fired (hadPrior=' + hadPriorResult +
                  ', isDualSheet=' + !!result.isDualSheet +
                  ', sheet1=' + s1Count + ', sheet2=' + s2Count +
                  ', ocrCells=' + ocrCount + ')');
      batchState.ocrResults[gameId] = result;
      if (hadPriorResult && reconstructQueue) {
        try {
          if (typeof reconstructQueue.abortGame === 'function') {
            reconstructQueue.abortGame(gameId);
            console.log('[ON-GAME-COMPLETE] ' + gameId +
                        ' aborted prior reconstruction (re-fire detected)');
          }
        } catch (e) {}
        if (batchState.reconstructResults) {
          delete batchState.reconstructResults[gameId];
        }
      }

      var game = batchState.games.get(gameId);
      var isNoisy = !!(window.BatchReconstructOrchestrator &&
        typeof window.BatchReconstructOrchestrator.hasTrailingNoise === 'function' &&
        window.BatchReconstructOrchestrator.hasTrailingNoise(result));
      console.log('[ON-GAME-COMPLETE] ' + gameId + ' noise verdict → ' + isNoisy +
                  (isNoisy ? ' ⇒ NEEDS_TRUNCATION, will NOT enqueue'
                           : ' ⇒ will enqueue reconstruction'));

      if (game) {
        game.hasTrailingNoise = isNoisy;
        game.ocrProgress = null;  // OCR finished — drop the progress text
        game.ocrCellCount = result.isDualSheet
          ? (result.sheet1.length + result.sheet2.length)
          : result.ocrCells.length;
        // Record the layout this game was OCR'd under so the game list can
        // flag a mismatch with the active profile (per-game re-OCR badge).
        // Cache hits carry result.cachedLayout (the file's "# layout:" stamp);
        // fresh OCR carries none → use the signature it was just OCR'd at.
        game.cachedLayout = result.cachedLayout ||
          (window.BatchOcrQueue && window.BatchOcrQueue.currentLayoutSignature
            ? window.BatchOcrQueue.currentLayoutSignature() : null);
        if (hadPriorResult) {
          // Re-running OCR replaces every per-method state from the prior
          // pass. Clear method/tier/picked state too so the game-list
          // doesn't show G◐5 B◐6 from the prior partial run.
          game.methodStatus = null;
          game.tier = null;
          game.triageDetails = null;
          game.reconstructPicked = null;
        }
        if (isNoisy) {
          // Wait for the user. selectGame + the existing noise-review UI in
          // ocr.js will surface this; when the user clicks "Continue to
          // Validation", BatchGameList.onTruncationComplete wires the fixed
          // OCR back into the orchestrator.
          game.status = GAME_STATUS.NEEDS_TRUNCATION;
          renderGameList();
          return;
        }
      }
      if (reconstructQueue) {
        reconstructQueue.enqueue(gameId, result);
      }
    };

    // Queue complete callback
    queue.onQueueComplete = function(results) {
      if (typeof log === 'function') {
        var count = Object.keys(results).length;
        log('[Batch] OCR complete: ' + count + ' games processed');
      }
    };

    // Enqueue all games in selected round
    var roundGames = new Map();
    batchState.games.forEach(function(game, gameId) {
      roundGames.set(gameId, game);
    });
    queue.enqueueGames(roundGames);
  }

  /**
   * Cancel batch OCR processing.
   */
  function cancelBatchOcr() {
    if (batchState.ocrQueue) {
      batchState.ocrQueue.cancel();
    }
    if (batchState.reconstructQueue) {
      batchState.reconstructQueue.cancel();
    }
  }

  // =========================================================================
  // Per-game re-OCR (layout mismatch)
  // =========================================================================

  /**
   * Compact a layout signature for a badge: "2col20|2col20" -> "2col20",
   * "2col20|3col20" -> "2col20+3col20" (collapse identical per-page tokens).
   */
  function _shortLayout(sig) {
    if (!sig) return '';
    var parts = String(sig).split('|');
    var uniq = parts.filter(function(v, i) { return parts.indexOf(v) === i; });
    return uniq.join('+');
  }

  /**
   * Delete a game's cached OCR sidecars (.txt + .grid.json, single and dual)
   * so the next OCR pass re-detects instead of serving the cache. Removes from
   * both the Zugwise/{OCR,grid} subfolders (current) and the flat scan-folder
   * root (pre-reorg). Missing files are ignored.
   */
  async function _deleteGameCacheFiles(folder, gameId) {
    if (!folder) return;
    var names = [
      gameId + '.txt', gameId + '.p1.txt', gameId + '.p2.txt',
      gameId + '.grid.json', gameId + '.p1.grid.json', gameId + '.p2.grid.json'
    ];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (window.BatchPaths) {
        try {
          var dir = await window.BatchPaths.resolveDir(folder, name, false);
          if (dir && dir !== folder) { try { await dir.removeEntry(name); } catch (e) {} }
        } catch (e) {}
      }
      try { await folder.removeEntry(name); } catch (e) {}
    }
  }

  /**
   * Re-OCR a single game at the currently-active sheet profile. Deletes only
   * THIS game's cache, resets only THIS game's row state, and re-enqueues it
   * into the existing OCR queue (whose onGameComplete already handles re-fires
   * via hadPriorResult → reconstruction re-runs). Every other game is left
   * untouched — the safe answer to a mixed 2col/3col round.
   */
  async function reOcrGameAtCurrentLayout(gameId) {
    var game = batchState.games.get(gameId);
    if (!game) return;
    var queue = batchState.ocrQueue;
    if (!queue) {
      if (typeof log === 'function') {
        log('[Batch] Re-OCR needs an active OCR queue — click "Start Batch Processing" first.');
      }
      return;
    }
    var sig = (window.BatchOcrQueue && window.BatchOcrQueue.currentLayoutSignature)
      ? window.BatchOcrQueue.currentLayoutSignature() : null;

    // Drop this game's cache so _processGame re-runs OCR rather than cache-hits.
    await _deleteGameCacheFiles(batchState.folderHandle, gameId);

    // Reset only this game's row state: thaw the badge freeze and clear the
    // prior pass's per-method / tier / picked badges so the row shows fresh
    // OCR progress (mirrors startBatchOcr's per-game reset + the re-run thaw).
    delete _completedRowGameIds[gameId];
    game.methodStatus = null;
    game.tier = null;
    game.triageDetails = null;
    game.reconstructPicked = null;
    game.cachedLayout = null;
    game.ocrProgress = null;
    game.status = GAME_STATUS.QUEUED;

    if (typeof log === 'function') {
      log('[Batch] Re-OCR ' + gameId + (sig ? ' at ' + sig : '') + ' (this game only)');
    }

    // If a prior batch was cancelled, the queue's cancelled flag would make
    // _processNext bail immediately — clear it so this single game runs.
    queue.cancelled = false;

    var one = new Map();
    one.set(gameId, game);
    queue.enqueueGames(one);
    renderGameList();
  }

  // =========================================================================
  // Per-game working-state snapshot
  // =========================================================================
  // Switching games used to throw away everything the user had done on the
  // outgoing game — fix statuses, confirmedPly, alignment cache, dismissed
  // notices — and re-run processAllSheets from scratch on return. Per-sheet
  // OCR cells already persist via reference (state.ocrCellsSheet1/2 IS the
  // same array as result.sheet1/2, so structural edits propagate), but the
  // per-game progress on top of those cells was being lost.
  //
  // These helpers snapshot the relevant state into game.workingState before
  // the switch and overlay it back after processAllSheets has rebuilt the
  // base UI. Snapshots are deep copies (JSON round-trip) so later mutations
  // don't bleed into the saved view.

  function _deepCopy(obj) {
    if (obj === null || obj === undefined) return obj;
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  // ── Cross-game poison detection (safety net) ─────────────────────────
  // The pristine OCR in batchState.ocrResults[gameId] is the authoritative
  // size of a game. A dual sheet records the FULL game per player, so plies
  // ≈ the longer sheet's cell count; rows = plies / 2. Single-sheet uses the
  // flat ocrCells length. Returns 0 when the game's OCR isn't available.
  function _expectedMoveRows(gameId) {
    var r = batchState.ocrResults[gameId];
    if (!r) return 0;
    var plies = r.isDualSheet
      ? Math.max((r.sheet1 || []).length, (r.sheet2 || []).length)
      : (r.ocrCells || []).length;
    return Math.round(plies / 2);
  }

  // True when an N-row move list is far too short to belong to this game's
  // OCR — the fingerprint of a cross-game-poisoned snapshot or picked result
  // (e.g. B3 had 80-ply OCR but its workingState/picked held B5's 8 moves).
  // Legit truncation rewrites ocrResults to the cleaned length, so for a
  // truncated game `expected` tracks `rows` and this stays false. Conservative
  // thresholds (sizeable game, >2x shortfall, >8-row absolute gap) keep it
  // from firing on short games or normal partial reconstructions, whose
  // move arrays carry the full input length anyway.
  function _moveCountLooksPoisoned(gameId, rows) {
    var expected = _expectedMoveRows(gameId);
    return expected >= 12 && rows > 0 &&
           rows < expected * 0.5 && (expected - rows) > 8;
  }

  function _saveGameWorkingState(gameId) {
    if (!gameId || typeof state === 'undefined') return;
    // Ownership guard: the global `state` always mirrors the currently-loaded
    // game (currentGameId). Snapshotting any OTHER game from it would copy the
    // wrong game's moves into that game's workingState — the exact corruption
    // the switch-serialization fix prevents at its source. Belt-and-suspenders
    // against any future caller that passes a non-current gameId.
    if (batchState.currentGameId && gameId !== batchState.currentGameId) {
      if (typeof log === 'function') {
        log('  ⚠ refusing to snapshot ' + gameId + ' — loaded game is ' +
            batchState.currentGameId + ' (state mirrors the loaded game, not ' +
            gameId + ')');
      }
      return;
    }
    var game = batchState.games.get(gameId);
    if (!game) return;
    // Don't snapshot if processAllSheets hasn't even populated state.moves yet
    // (e.g. we never actually opened this game).
    if (!state.moves || !state.moves.length) return;

    // Count user confirmations so we can correlate save → restore → verify.
    var _diagFix = 0, _diagLock = 0;
    if (Array.isArray(state.moves)) {
      state.moves.forEach(function(m) {
        if (m.wStatus === 'fixed') _diagFix++;
        if (m.bStatus === 'fixed') _diagFix++;
        if (m.wStatus === 'locked') _diagLock++;
        if (m.bStatus === 'locked') _diagLock++;
      });
    }
    if (typeof log === 'function') {
      var confirmedStr = _diagFix + (_diagLock > 0 ? ' (+' + _diagLock + ' locked)' : '');
      log('  💾 snapshot ' + gameId + ' — ' + confirmedStr + ' confirmed plies, ' +
          'confirmedPly=' + (state.confirmedPly || 0));
    }

    game.workingState = {
      moves:               _deepCopy(state.moves),
      sans:                (state.sans || []).slice(),
      ocrCells:            _deepCopy(state.ocrCells),
      confirmedPly:        state.confirmedPly || 0,
      currentPly:          state.currentPly || 0,
      stuckPly:            state.stuckPly,
      stuckInfo:           _deepCopy(state.stuckInfo),
      fixedPlies:          (state.fixedPlies || []).slice(),
      lockedPlies:         (state.lockedPlies || []).slice(),
      approvedPlies:       (state.approvedPlies || []).slice(),
      mergeLockedPlies:    (state.mergeLockedPlies || []).slice(),
      mergeTierMap:        _deepCopy(state.mergeTierMap),
      alignmentAnalysis:   _deepCopy(state.alignmentAnalysis),
      noiseBannerDismissed: !!state.noiseBannerDismissed,
      inputMode:           state.inputMode,
      // NW alignment per-game state. Without these, dismissals leak (a key
      // dismissed on game A would carry over into B's pipeline) and
      // alignmentAutoSurfaceMode stays false, so the first banner on a
      // re-opened game fails to auto-pop. alignmentPendingIssues is
      // regenerated on each _runNWAlignmentCheck, but saving it keeps the
      // count badge consistent in the brief window before re-enumeration.
      nwSearchFrom:           state.nwSearchFrom || 0,
      alignmentAutoSurfaceMode: state.alignmentAutoSurfaceMode !== false,
      dismissedNWKeys:        _deepCopy(state.dismissedNWKeys) || {},
      postponedNWKeys:        _deepCopy(state.postponedNWKeys) || {},
      alignmentPendingIssues: _deepCopy(state.alignmentPendingIssues) || [],
      // Noise-truncation in-progress state. When the user deletes cells via
      // the 🗑️ buttons but hasn't clicked "Continue to Validation" yet,
      // batchState.ocrResults[gameId] is still the pristine OCR — their
      // in-progress truncation lives ONLY in state.ocrCellsSheet1/2 and
      // state.pendingNoiseReview. Snapshotting these means switching away
      // and back re-shows the yellow review panel (from processAllSheets
      // on pristine OCR) with the user's partial truncation in the move
      // list, so they can finish and confirm.
      pendingNoiseReview:  !!state.pendingNoiseReview,
      ocrCellsSheet1:      state.ocrCellsSheet1 ? _deepCopy(state.ocrCellsSheet1) : null,
      ocrCellsSheet2:      state.ocrCellsSheet2 ? _deepCopy(state.ocrCellsSheet2) : null,
      // User override stamp list, produced by _requeueAndExit. Used by
      // _applyPickedToState on re-entry to re-stamp 'fixed' on plies whose
      // SANs survive into the new algo result. Not snapshotting it meant a
      // multi-override session (override 21.B, switch games, switch back,
      // override 30.W) re-entered verification with only the most recent
      // override restamped — earlier confirmations silently demoted to 'ok'.
      _userOverridePlies: _deepCopy(state._userOverridePlies) || null
    };

    // Auto-mark the game as VERIFIED if validation reached the end with no
    // stuck point. Without this, the user has to Save PGN to get the ✅
    // checkmark in the game selector — but they often review through to the
    // end and switch games without exporting yet. Runs BEFORE the IN_REVIEW
    // → NEEDS_REVIEW flip in selectGame (that flip only fires when status
    // === IN_REVIEW, so VERIFIED is sticky).
    //
    // Guards beyond "stuckPly === null":
    //   - !state.pendingNoiseReview — a game parked on the noise-review
    //     panel has stuckPly=null simply because validateAndDisplay never
    //     ran yet (sheets.js skips it when pendingNoiseReview is true).
    //     Don't confuse "no validation happened" with "validation passed".
    //   - !game.hasTrailingNoise || game.noiseResolved — same idea at
    //     the game-state level: if the game's noise hasn't been cut, it
    //     hasn't been reviewed.
    //   - all state.moves entries have a non-pending, non-error status —
    //     a game mid-review can have stuckPly momentarily null while
    //     some moves are still 'pending'. Only flip to VERIFIED when
    //     every populated cell is 'ok' / 'fixed' / 'locked'.
    function _isAllMovesValidated(moves) {
      if (!Array.isArray(moves) || moves.length === 0) return false;
      var ok = { ok: 1, fixed: 1, locked: 1 };
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        if (m.white && !ok[m.wStatus]) return false;
        if (m.black && !ok[m.bStatus]) return false;
      }
      return true;
    }
    if (state.stuckPly === null && !state.stuckInfo &&
        !state.pendingNoiseReview &&
        (!game.hasTrailingNoise || game.noiseResolved) &&
        state.sans && state.sans.length > 0 &&
        _isAllMovesValidated(state.moves) &&
        game.status !== GAME_STATUS.VERIFIED &&
        game.status !== GAME_STATUS.EXPORTED) {
      game.status = GAME_STATUS.VERIFIED;
      // Same staleness clear + orchestrator abort as markVerified() — keep
      // the sidebar from showing the pre-review G/B/D failure glyphs and
      // Tier badge on a game that's now hand-verified, and stop in-flight
      // searches so they can't re-seed methodStatus afterwards.
      _clearStalenessAndAbort(game);
      if (typeof log === 'function') {
        log('✅ Auto-marked ' + gameId + ' as VERIFIED (' +
            state.sans.length + ' moves validated, no stuck point)');
      }
    }
  }

  function _restoreGameWorkingState(gameId) {
    if (!gameId || typeof state === 'undefined') return false;
    // Ownership guard: restore writes the snapshot INTO the global `state`,
    // so it must only run for the currently-loaded game. Restoring a
    // non-current game's snapshot would stomp the loaded game's move list.
    if (batchState.currentGameId && gameId !== batchState.currentGameId) {
      if (typeof log === 'function') {
        log('  ⚠ refusing to restore ' + gameId + ' into state — loaded game is ' +
            batchState.currentGameId);
      }
      return false;
    }
    var game = batchState.games.get(gameId);
    if (!game || !game.workingState) return false;
    var ws = game.workingState;

    // Poison safety net: a snapshot whose move list is far shorter than this
    // game's own OCR was cross-contaminated from a different (shorter) game.
    // Discard it so the poisoned overlay can NEVER render on top of the fresh
    // processAllSheets output — the user sees their real game instead. Keep a
    // backup on the game object so nothing is truly destroyed, and log loudly
    // so a recurrence is visible. Skip mid-truncation snapshots, which are
    // legitimately short while ocrResults still holds the pristine length.
    if (!ws.pendingNoiseReview &&
        _moveCountLooksPoisoned(gameId, (ws.moves || []).length)) {
      console.warn('[Batch] DISCARDING poisoned workingState for ' + gameId +
        ' — ' + (ws.moves || []).length + ' move rows vs ~' +
        _expectedMoveRows(gameId) + ' expected from OCR.');
      if (typeof log === 'function') {
        log('  ⚠ discarded poisoned snapshot for ' + gameId + ' (' +
            (ws.moves || []).length + ' rows ≪ ~' + _expectedMoveRows(gameId) +
            ' expected) — showing fresh OCR. Re-run reconstruction to refill.');
      }
      game._discardedWorkingState = ws;
      game.workingState = null;
      return false;
    }

    // Restore the user-progress fields on top of whatever processAllSheets
    // produced. The per-sheet cells (state.ocrCellsSheet1/2) are kept as-is —
    // they reference the SAME arrays as result.sheet1/2, so any structural
    // edits made earlier are already reflected.
    state.moves            = _deepCopy(ws.moves);
    state.sans             = ws.sans.slice();
    if (ws.ocrCells) state.ocrCells = _deepCopy(ws.ocrCells);
    state.confirmedPly     = ws.confirmedPly;
    state.currentPly       = ws.currentPly;
    state.stuckPly         = ws.stuckPly;
    state.stuckInfo        = _deepCopy(ws.stuckInfo);
    state.fixedPlies       = ws.fixedPlies.slice();
    state.lockedPlies      = ws.lockedPlies.slice();
    state.approvedPlies    = ws.approvedPlies.slice();
    state.mergeLockedPlies = ws.mergeLockedPlies.slice();
    state.mergeTierMap     = _deepCopy(ws.mergeTierMap);
    state.alignmentAnalysis    = _deepCopy(ws.alignmentAnalysis);
    state.noiseBannerDismissed = !!ws.noiseBannerDismissed;
    if (ws.inputMode) state.inputMode = ws.inputMode;

    // Restore NW alignment per-game state on top of processAllSheets' fresh
    // defaults (sheets.js sets these back to auto-surface=true, searchFrom=0,
    // dismissed={} on every dual-sheet merge). Must run before the
    // evaluateAtPointAlignment call below so the banner decision uses the
    // saved dismissals and auto-surface flag.
    state.nwSearchFrom           = ws.nwSearchFrom || 0;
    state.alignmentAutoSurfaceMode = ws.alignmentAutoSurfaceMode !== false;
    state.dismissedNWKeys        = _deepCopy(ws.dismissedNWKeys) || {};
    state.postponedNWKeys        = _deepCopy(ws.postponedNWKeys) || {};
    state.alignmentPendingIssues = _deepCopy(ws.alignmentPendingIssues) || [];

    // Restore in-progress noise-truncation state. The per-sheet arrays were
    // truncated in place by deleteMovesFromPly — we replace what
    // processAllSheets built (from pristine OCR) with the user's truncated
    // versions. state.pendingNoiseReview restored last so the revalidate
    // skip below respects it.
    if (ws.ocrCellsSheet1) state.ocrCellsSheet1 = _deepCopy(ws.ocrCellsSheet1);
    if (ws.ocrCellsSheet2) state.ocrCellsSheet2 = _deepCopy(ws.ocrCellsSheet2);
    state.pendingNoiseReview = !!ws.pendingNoiseReview;

    // Defensive: if the snapshot says noise was already confirmed
    // (pendingNoiseReview === false) but processAllSheets just re-ran the
    // suspicious-tail detector against pristine OCR and rendered the yellow
    // "⚠️ Potential OCR noise at end" UI into stuck-info / fix-list, wipe
    // that residue. Revalidate normally overwrites these elements with the
    // green "🎉 Game complete!" line, but skippingForVerify can suppress
    // revalidate when the game has a picked reconstruct result, leaving the
    // stale noise prompt visible. Reported: "Sometimes when reopening the
    // game, it still shows: ⚠️ Potential OCR noise at end".
    if (!state.pendingNoiseReview) {
      var stuckEl = document.getElementById('stuck-info');
      if (stuckEl && stuckEl.innerHTML &&
          stuckEl.innerHTML.indexOf('Potential OCR noise') >= 0) {
        stuckEl.innerHTML = '';
      }
      var fixEl = document.getElementById('fix-list');
      if (fixEl && fixEl.innerHTML &&
          fixEl.innerHTML.indexOf('Low-confidence moves detected') >= 0) {
        fixEl.innerHTML = '';
      }
    }

    // Restore the override stamp list so _applyPickedToState can re-stamp
    // multi-override confirmations on re-entry. Explicitly clear when the
    // snapshot had none, so stale data from a different game doesn't leak.
    state._userOverridePlies = ws._userOverridePlies ? _deepCopy(ws._userOverridePlies) : null;

    // Re-render the move list with the restored fix statuses, then jump the
    // board back to where the user was working.
    if (typeof renderMoveList === 'function') renderMoveList();
    if (typeof goToPly === 'function') {
      try { goToPly(state.currentPly || 0, { preserveErrorArrow: true }); } catch (e) {}
    }

    // Re-evaluate structural banners. evaluateAtPointAlignment reads the
    // restored state.stuckPly + state.alignmentAnalysis and re-shows the
    // banner if a suggestion is in range. Noise notice is informational —
    // re-detect from current per-sheet cells (in case structural edits
    // changed the count) and respect the saved dismissal flag.
    if (window.SheetAlignment) {
      window.SheetAlignment.clearAllStructuralBanners();
      window.SheetAlignment.evaluateAtPointAlignment();
      if (state.ocrCellsSheet1 && state.ocrCellsSheet2 && !state.noiseBannerDismissed) {
        var noise = window.SheetAlignment.detectTrailingNoise(
          state.ocrCellsSheet1, state.ocrCellsSheet2
        );
        if (noise && noise.total > 0) window.SheetAlignment.showNoiseBanner(noise);
      }
    }

    if (typeof log === 'function') {
      var _rF = 0, _rL = 0;
      if (Array.isArray(state.moves)) {
        state.moves.forEach(function(m) {
          if (m.wStatus === 'fixed') _rF++;
          if (m.bStatus === 'fixed') _rF++;
          if (m.wStatus === 'locked') _rL++;
          if (m.bStatus === 'locked') _rL++;
        });
      }
      var confStr = _rF + (_rL > 0 ? ' (+' + _rL + ' locked)' : '');
      log('  💾 restored ' + gameId + ' — ' + confStr + ' confirmed plies, ' +
          'confirmedPly=' + state.confirmedPly);
    }

    // Re-validate against the RESTORED state.moves so the UI reflects the
    // user's actual progress, not what processAllSheets → validateAndDisplay
    // just computed from the raw un-fixed OCR cells. Without this, a game the
    // user had worked through to completion (stuckPly=null) re-opens showing
    // the ORIGINAL first stuck point — because processAllSheets re-merges the
    // source OCR (which still has the errors) and paints the fix panel for
    // the first illegal move. For a completed game, revalidate() sees "no
    // stuck", clears errorArrow/stuckInfo, cancels any background searches
    // that just (re)launched, and renders "🎉 Game complete!". For partial
    // games, it sets stuckPly to the next real error given the user's fixes.
    // Fire-and-forget — revalidate is async but the overwrite on completion
    // is the only thing we care about here.
    //
    // EXCEPTION — in-progress noise truncation. When the user was deleting
    // trailing noise cells but hadn't clicked "Continue to Validation" yet,
    // processAllSheets re-ran on the pristine OCR and re-set up the yellow
    // noise-review panel. revalidate() would immediately clear that panel
    // ("Game complete!" for a truncated-to-legal game, or "Next error at..."
    // otherwise), leaving the user stuck mid-truncation without the Continue
    // button. Skip revalidate so the panel stays visible; user clicks
    // Continue to commit their truncation and validate.
    //
    // EXCEPTION 2 — game is about to auto-enter verification mode. When a
    // batch game's reconstructPicked is SOLVED, selectGame immediately
    // calls VerificationUI.enterVerificationMode, which paints the
    // strike-through/arrow overlays via renderVerificationMoveList. If we
    // ALSO fire an async revalidate() here, it completes a second or two
    // later and calls renderMoveList() (validation.js:665) which rebuilds
    // #move-tbody from scratch — wiping every overlay the user was
    // supposed to see in the walkthrough. They see Greedy's moves in the
    // move list but no review indicators, and have to click the Review
    // button to re-enter the walkthrough. Skip revalidate for SOLVED
    // games; verification mode manages state.stuckPly / stuckInfo itself
    // and doesn't need a ground-truth revalidation to display correctly.
    var skippingForVerify = false;
    if (!state.pendingNoiseReview) {
      var __g = batchState.games.get(gameId);
      var __picked = __g && __g.reconstructPicked;
      var __greedyPartial = __g && batchState.reconstructResults[gameId] &&
                            batchState.reconstructResults[gameId].results &&
                            batchState.reconstructResults[gameId].results.greedy;
      var __pickedStatus = __picked && __picked.result && __picked.result.status;
      var __pickedSolved = (__pickedStatus === 'SOLVED' || __pickedStatus === 'VALID');
      // Mirror the auto-enter reviewability rule from the openGame path
      // (SOLVED → pick as-is; otherwise fall back to Greedy partial with
      // fixes). Without matching this, auto-entry into PARTIAL review was
      // painting the strike-through overlays, then the save-phase
      // revalidate a second later called renderMoveList and wiped them —
      // user saw only "6.W Bf5 ❌" with no algo-proposed indicators, and
      // had to click the Review button manually to see the walkthrough.
      var __pickedPartialReviewable = (!__pickedSolved) && __greedyPartial &&
                                      __greedyPartial.status === 'PARTIAL' &&
                                      __greedyPartial.fixes &&
                                      __greedyPartial.fixes.length > 0;
      var __pickedAnyReviewable = __picked && __picked.result &&
                                  __picked.result.status === 'PARTIAL' &&
                                  __picked.result.fixes &&
                                  __picked.result.fixes.length > 0;
      if ((__pickedSolved || __pickedPartialReviewable || __pickedAnyReviewable) &&
          window.VerificationUI) {
        skippingForVerify = true;
        if (typeof log === 'function') {
          log('💾 (skipping revalidate for ' + gameId +
              ': verification mode will take over)');
        }
        // The workingState snapshot may have captured a stale stuckPly/stuckInfo
        // (e.g. from before the user applied a fix that moved the stuck point
        // forward). Verification mode calls state.stuckPly = null internally at
        // line 924 of verification-ui.js, but _savedState is captured at line 258
        // BEFORE that — so it would record the stale value and restore it on
        // exit. Reset here so _savedState sees null, and exit-verification's
        // revalidate() lands on the real stuck point.
        state.stuckPly = null;
        state.stuckInfo = null;
      }
    }
    if (typeof revalidate === 'function' && !state.pendingNoiseReview &&
        !skippingForVerify) {
      revalidate().catch(function(e) {
        console.warn('[Batch] Revalidate-on-restore failed for ' + gameId + ':', e);
      });
    }
    return true;
  }

  // =========================================================================
  // Game selection (load into main UI)
  // =========================================================================

  /**
   * Load a game's OCR results into the main Zugwise interface.
   * @param {string} gameId
   */
  // ── Serialize game switches (re-entrancy guard) ──────────────────────
  // _selectGameInner is async: it awaits processAllSheets (which itself
  // awaits OCR merge + validation). Two switches overlapping at that await
  // both mutate the SAME shared globals — state, sheetsState, and
  // batchState.currentGameId. The stale continuation of the first switch
  // resumes AFTER the second has repointed those globals, so it writes the
  // newer game's globals using the older game's data and snapshots the
  // wrong move list into workingState. Reported symptom: "clicking back and
  // forth between games overwrote / truncated one game's moves to the
  // other's length."
  //
  // Run the loader through a promise chain so only one switch runs at a
  // time, and COALESCE: if newer clicks arrive while a load is in flight,
  // skip the superseded ones and land only on the most recent target.
  // Skipped games were never loaded (currentGameId never moved to them),
  // so no working-state snapshot is lost.
  var _selectChain = Promise.resolve();
  var _selectLatest = null;
  function selectGame(gameId) {
    _selectLatest = gameId;
    _selectChain = _selectChain.then(function() {
      if (_selectLatest !== gameId) {
        if (typeof log === 'function') {
          log('  ⏭ skip stale selectGame(' + gameId + ') — superseded by ' +
              _selectLatest);
        }
        return;
      }
      return _selectGameInner(gameId);
    }).catch(function(e) {
      console.warn('[Batch] selectGame(' + gameId + ') failed:', e);
      if (typeof log === 'function') {
        log('  ⚠ selectGame(' + gameId + ') threw — ' + (e && e.message || e));
      }
    });
    return _selectChain;
  }

  async function _selectGameInner(gameId) {
    var result = batchState.ocrResults[gameId];
    var hasData = result && (
      // Either half of a dual-sheet result is enough — a game whose LEFT
      // sheet OCR'd to zero cells (e.g. transient model-load failure) must
      // stay clickable; processAllSheets collapses one-half-empty games
      // into the single-sheet flow.
      (result.isDualSheet && ((result.sheet1 && result.sheet1.length > 0) ||
                              (result.sheet2 && result.sheet2.length > 0))) ||
      (result.ocrCells && result.ocrCells.length > 0)
    );
    if (!hasData) {
      if (typeof log === 'function') {
        log('No OCR results for ' + gameId + ' yet');
      }
      return;
    }

    // Clear cross-game stale UI state before loading the next game. The
    // showOcrResults / processAllSheets flows reset some of this (stuckPly,
    // moves, sans) but NOT the board overlays (errorArrow / fixArrow /
    // ocrArrow) or the legal-moves panel, so without this the red box
    // around an illegal move from the previous game survives the switch.
    if (typeof state !== 'undefined') {
      state.errorArrow = null;
      state.fixArrow = null;
      state.ocrArrow = null;
      state.legalMoves = [];
      state.selectedFix = null;
      state.previewPly = null;
      state.pendingConfirmation = null;
      state.boardSelection = null;
      state.missingMoveCandidates = [];
      // Clear the override stamp list so stale entries from the previous
      // game don't leak into _applyPickedToState on the incoming game.
      // Restore will overwrite this from the per-game snapshot below if
      // one exists.
      state._userOverridePlies = null;
      // Drop edit-mode state so the next selectFix on the incoming game
      // doesn't paint the Apply button orange. selectGame doesn't go
      // through exitEditMode, so without this the prior game's edit-mode
      // flag survives the switch — user-reported "after I edited a move
      // in a different game, the confirm button in some other game is
      // still orange again."
      state.editMode = null;
      // Reset navigation position so the NW gap-proximity gate doesn't
      // misfire during processAllSheets. The gate computes
      // effPly = max(stuckPly, currentPly). If currentPly/stuckPly still
      // hold the OUTGOING game's values (e.g. ply 108 from B1), and the
      // INCOMING game's OCR cells are set first (e.g. B3's gap at ply 25),
      // the first runStructuralChecks inside processAllSheets sees
      // effPly=108 >> 23 and surfaces the gap before the proximity gate
      // can suppress it — producing a one-frame banner flash of the wrong
      // game. processAllSheets resets both fields for the new game anyway;
      // zeroing them here just closes the window between the OCR-cell swap
      // and the stuckPly/currentPly update.
      state.currentPly = 0;
      state.stuckPly = null;
    }
    // Reset the Apply button to its neutral disabled state. Subsequent
    // render flows for the incoming game (validateAndDisplay → fetchFixes,
    // verification entry, etc.) repaint it in the correct color for that
    // game's mode. Without this the button keeps the prior game's color
    // (orange edit, blue review) until the user clicks something.
    if (typeof resetApplyButton === 'function') {
      try { resetApplyButton(); } catch (e) { /* non-fatal */ }
    }

    // Clear any NW alignment or noise banner from the OUTGOING game immediately.
    // Without this the previous game's banner remains visible for the entire
    // duration of processAllSheets (100–500 ms), causing a brief flash of a
    // stale suggestion on the new game before _runNWAlignmentCheck eventually
    // reaches the proximity gate and calls clearAlignmentBanner.
    if (window.SheetAlignment) {
      try { window.SheetAlignment.clearAllStructuralBanners(); } catch (e) {}
    }

    // Remove the dual-sheet tier summary banner (🟢/🟡/🔴 + Lock radios).
    // It's only (re)created inside mergePlayerMoves, which runs only when
    // processAllSheets takes the two-player path. Switching to a truly
    // single-sheet game, or to a dual-sheet game with an empty half (which
    // collapses into the single-player branch), never fires that path — so
    // the previous game's banner would otherwise linger. Dual→dual is fine
    // because showTierSummaryBanner removes the old one before inserting.
    var tierBanner = document.getElementById('tier-summary-banner');
    if (tierBanner) tierBanner.remove();

    // Flush any pending debounced requeueAfterFix for the OUTGOING game
    // before switching. Without this, _doRequeueNow's currentGameId guard
    // drops the requeue on game switch — the orchestrator never sees the
    // user's just-confirmed fixes, its picked stays at the pre-fix greedy
    // partial, and the next time the user clicks back the stale-picked
    // guard detects the divergence at a confirmed ply and fires a rerun,
    // wiping the panel results. Firing here uses the still-current `state`
    // for the outgoing game and gives the orchestrator the latest input.
    if (batchState.currentGameId && batchState.currentGameId !== gameId &&
        _requeueTimer && _requeuePendingForGame === batchState.currentGameId) {
      var _flushGameId = _requeuePendingForGame;
      clearTimeout(_requeueTimer);
      _requeueTimer = null;
      _requeuePendingForGame = null;
      try { _doRequeueNow(_flushGameId); } catch (e) {
        console.warn('[Batch] flush-on-switch requeue failed:', e);
      }
    }

    // Snapshot the OUTGOING game's working state (fix statuses, confirmedPly,
    // alignment cache, noise dismissal, etc.) BEFORE we change currentGameId
    // and clobber `state` with the new game's data. Per-sheet cells already
    // persist via array reference; this captures the user-progress overlay.
    if (batchState.currentGameId && batchState.currentGameId !== gameId) {
      _saveGameWorkingState(batchState.currentGameId);
    }

    // Update batch state
    if (batchState.currentGameId) {
      var prevGame = batchState.games.get(batchState.currentGameId);
      if (prevGame && prevGame.status === GAME_STATUS.IN_REVIEW) {
        prevGame.status = GAME_STATUS.NEEDS_REVIEW;
      }
    }
    batchState.currentGameId = gameId;
    var game = batchState.games.get(gameId);
    if (game && game.status !== GAME_STATUS.VERIFIED &&
        game.status !== GAME_STATUS.EXPORTED) {
      game.status = GAME_STATUS.IN_REVIEW;
    }

    // Invalidate any inflight per-ply backtrack search launched for the
    // PREVIOUS game. validation.js/fetchFixes captures searchGeneration at
    // launch and aborts on mismatch — bumping it here means a B6 search
    // that completes after the user switches to B7 cannot overwrite B7's
    // fix-suggestions / noise-confirm panel. Reported bug: confirming noise
    // cutoff on B6 launched a backtrack search for its stuck ply; switching
    // to B7 to work on it while B6's search was still running let B6's fix
    // list land in B7's middle panel when it finally finished.
    if (typeof state !== 'undefined' && state) {
      state.searchGeneration = (state.searchGeneration || 0) + 1;
    }

    // Load OCR results into the main UI via the existing sheets.js pipeline.
    // For dual-sheet results, populate sheetsState and call processAllSheets()
    // so we get the full merge, tier classification, locked plies, layout, and
    // validation flow — exactly like the Image tab's two-sheet upload.
    if (result.isDualSheet && result.sheet1 && result.sheet2 &&
        typeof sheetsState !== 'undefined' && typeof processAllSheets === 'function') {

      // Get profile info for format/rowCount on the sheet entries
      var profile = window.SheetProfiles ? window.SheetProfiles.getActiveProfile() : null;
      var pg1 = (profile && profile.pages && profile.pages[0]) || { format: '2col', rowCount: 20 };

      // Populate sheetsState with one entry per physical page. Multi-page
      // games need pages[0], pages[1], ... in separate slots so
      // processAllSheets renumbers moves correctly (page 2's moves start at
      // num=21 etc. instead of colliding with page 1). If the OCR queue
      // didn't emit per-page arrays (single-page game), fall back to
      // putting everything in slot [0].
      function _buildSheetSlots(pagesArr, flat, primaryImage, imagePages) {
        var slots = [null, null, null];
        var pages = Array.isArray(pagesArr) && pagesArr.length > 0
          ? pagesArr
          : [flat];
        for (var i = 0; i < Math.min(pages.length, 3); i++) {
          var cells = pages[i] || [];
          if (cells.length === 0) continue;
          var prof = (profile && profile.pages && profile.pages[i]) || pg1;
          // Prefer the per-page image; fall back to the primary (page 0)
          // image only for slot 0 so P1.2 / P2.2 links render correctly
          // when we have multi-page thumbnails but a user's second page
          // is missing.
          var slotImage = (imagePages && imagePages[i]) || null;
          if (!slotImage && i === 0) slotImage = primaryImage || null;
          slots[i] = {
            file: null,
            image: slotImage,
            corners: null,
            status: 'ocr_done',
            ocrResult: { moves: cells },
            moveCount: cells.length,
            format: prof.format || pg1.format,
            rowCount: prof.rowCount || pg1.rowCount
          };
        }
        return slots;
      }

      sheetsState.player1 = _buildSheetSlots(result.sheet1Pages, result.sheet1,
        result.sheet1Image, result.sheet1ImagePages);
      sheetsState.player2 = _buildSheetSlots(result.sheet2Pages, result.sheet2,
        result.sheet2Image, result.sheet2ImagePages);
      sheetsState.player1Color = 'white';  // left = white by convention
      sheetsState.player2Color = 'black';

      if (typeof log === 'function') {
        var s1Len = result.sheet1.length;
        var s2Len = result.sheet2.length;
        var oneHalfMissing = (s1Len === 0 || s2Len === 0);
        log('Loading dual-sheet game ' + gameId + ': left=' + s1Len +
            ' cells, right=' + s2Len + ' cells' +
            (oneHalfMissing ? ' → one half empty, will fall through to single-sheet flow' : ''));
      }

      // Surface any NW corrections the reconstruct queue auto-applied to
      // this game's OCR before running the algorithms. The sheets the
      // user is looking at here already reflect those edits, so they
      // should know — otherwise the "c3 ghost move" they see on White's
      // sheet looks like a mystery OCR result.
      var autoApplies = result && result.nwAutoApplies;
      if (autoApplies && autoApplies.length > 0 && typeof log === 'function' &&
          window.BatchNWAutoApply) {
        log('⚙️ This game had ' + autoApplies.length + ' NW correction(s) ' +
            'auto-applied (anchors ≥ ' +
            (result.nwAutoApplyThreshold || 0).toFixed(2) + '):');
        autoApplies.forEach(function(e) {
          log('   • ' + window.BatchNWAutoApply.describeApplied(e));
        });
      }

      // Use the full sheets.js pipeline — merge, tiers, layout, validation.
      // Suppress alignment banners during the load: runStructuralChecks fires
      // inside mergePlayerMoves (before showOcrResults has had a chance to set
      // pendingNoiseReview=true for noisy games), so the banner could surface
      // while the user is about to be put into the truncation-review flow.
      // _suppressAlignmentBanners is honoured by _runNWAlignmentCheck.
      if (typeof state !== 'undefined') state._suppressAlignmentBanners = true;
      try {
        await processAllSheets();
      } finally {
        if (typeof state !== 'undefined') state._suppressAlignmentBanners = false;
      }

    } else if (typeof state !== 'undefined') {
      // Single-sheet mode
      state.ocrCells = result.ocrCells;
      state.ocrCellsSheet1 = null;
      state.ocrCellsSheet2 = null;
      state.hasGridImage = result.ocrCells.some(function(m) { return m.imageDataUrl; });
      state.inputMode = 'image';

      if (typeof log === 'function') {
        log('Loaded game ' + gameId + ' (' + result.ocrCells.length + ' cells)');
      }

      // Trigger the normal OCR-loaded flow
      if (typeof showOcrResults === 'function') {
        showOcrResults(result.ocrCells);
      } else if (typeof window.showOcrResults === 'function') {
        window.showOcrResults(result.ocrCells);
      }
    }

    // If this game was opened before, overlay the saved user-progress state
    // (fix statuses, confirmedPly, alignment cache, noise dismissal, current
    // ply) on top of what processAllSheets just produced. First-time visits
    // skip this and use the fresh validation result as-is.
    _restoreGameWorkingState(gameId);

    // FALSE-POSITIVE TRUNCATION RECONCILE — break the NEEDS_TRUNCATION deadlock.
    // The orchestrator's enqueue gate (_hasTrailingNoise) and the user-facing
    // detector (showOcrResults → _earliestNoiseStart, which set
    // state.pendingNoiseReview during the processAllSheets call above) run the
    // SAME four NoiseDetection detectors but on DIFFERENT inputs: the gate uses
    // _cellsToPaired(mergeSheets(s1,s2)); the user-facing path uses the merged
    // moves actually shown. On dual-sheet games these can disagree — the gate
    // flags a low-confidence tail (e.g. "Rh4 (38%)") while the user-facing
    // detector sees the real last move ("Ra3") as clean.
    //
    // When they disagree this way the game is wedged. The orchestrator/nav
    // gates read the stale `hasTrailingNoise && !noiseResolved` pair as "still
    // needs truncation" (e.g. _isGameReadyForReview at ~:2484) REGARDLESS of
    // the game's status — so the game can sit at NEEDS_TRUNCATION *or* drift to
    // in_review via live fix-finding and still be blocked from reconstruction.
    // Meanwhile no yellow "Continue to Validation" panel ever appears
    // (pendingNoiseReview is false), so the user has nothing to truncate and no
    // button to dismiss it — they just see fix-finding spin on the first
    // forced-stop. The user-facing detector is authoritative (it's the one the
    // user can act on); if it found the tail clean, the gate's flag was a false
    // positive. Clear it the same way an explicit "Continue to Validation" click
    // would: onTruncationComplete marks the game noiseResolved, clears
    // hasTrailingNoise, and enqueues reconstruction against the (un-truncated)
    // OCR. Keyed on hasTrailingNoise (not status) so the in_review case below is
    // covered too.
    console.log('[TRUNC-DIAG] ' + gameId +
                ' active=' + (batchState && batchState.active) +
                ' status=' + (game && game.status) +
                ' noiseResolved=' + (game && game.noiseResolved) +
                ' hasTrailingNoise=' + (game && game.hasTrailingNoise) +
                ' pendingNoiseReview=' + (typeof state !== 'undefined' && state.pendingNoiseReview) +
                ' reconstructPicked=' + !!(game && game.reconstructPicked));
    if (batchState.active && game &&
        game.hasTrailingNoise && !game.noiseResolved &&
        typeof state !== 'undefined' && !state.pendingNoiseReview) {
      if (typeof log === 'function') {
        log('  ↪ ' + gameId + ' flagged NEEDS_TRUNCATION but user-facing noise ' +
            'detector found no tail to cut — clearing false-positive flag and ' +
            'enqueuing reconstruction');
      }
      console.log('[TRUNC-RECONCILE] ' + gameId + ' — orchestrator gate vs ' +
                  'user-facing detector disagree; treating as no-noise and ' +
                  'enqueuing reconstruction.');
      onTruncationComplete(gameId);
    }

    // Populate the tournament/pairing header above the move list. If no
    // pairing data is available (e.g. no tournament file loaded), renderGameHeader
    // keeps the panel hidden.
    if (typeof window.renderGameHeader === 'function') {
      window.renderGameHeader(game, window._batchTournamentData || null);
    }

    renderGameList();

    // Bind the interactive Greedy/Beam/Dijkstra panels to this game's
    // orchestrator results. If the orchestrator has already finished, the
    // panels show the final state (with Apply/Review buttons). If it's
    // still running, live progress streams in. If it hasn't reached this
    // game yet, the panels sit blank until it does.
    if (window.BatchPanelBridge) {
      window.BatchPanelBridge.bindGame(gameId);
    }

    // Phase 3: drop into the verification walkthrough when we have a
    // reviewable result. Two paths:
    //   (a) SOLVED — use the picked solved result (dijkstra > beam > greedy
    //       tiebreak handled by BatchTriage.pickBestResult).
    //   (b) No SOLVED, but Greedy produced a PARTIAL with fixes — enter
    //       Greedy's partial review so the user can work from some real
    //       corrections instead of staring at raw OCR. Beam/Dijkstra may
    //       still be running in the background; if one later solves the
    //       game the user can switch to that panel's Review button.
    // We deliberately DO NOT auto-enter a failed run (no fixes) because
    // dropping the user into a pile of cascade garbage at 3.W — the case
    // this branch used to be guarded against — is worse than the blank
    // interactive screen.
    var picked = game && game.reconstructPicked;
    var pickedStatus = (picked && picked.result && picked.result.status) || 'none';
    var pickedSolved = (pickedStatus === 'SOLVED' || pickedStatus === 'VALID');

    // Fallback: pick Greedy's partial if no SOLVED pick exists. User
    // explicitly asked for Greedy here — it finishes first and its fixes
    // are the most conservative, so it's the most useful starting point
    // for review. If Greedy has no fixes we leave picked as-is (which may
    // be beam/dijkstra partial; same rule about not auto-entering garbage).
    if (!pickedSolved) {
      var greedyResult = batchState.reconstructResults[gameId] &&
                         batchState.reconstructResults[gameId].results &&
                         batchState.reconstructResults[gameId].results.greedy;
      var greedyPartialUsable = greedyResult &&
                                greedyResult.status === 'PARTIAL' &&
                                greedyResult.fixes &&
                                greedyResult.fixes.length > 0;
      if (greedyPartialUsable) {
        picked = { method: 'greedy', result: greedyResult };
        pickedStatus = 'PARTIAL';
      }
    }
    var pickedReviewable = pickedSolved ||
      (picked && picked.result && picked.result.status === 'PARTIAL' &&
       picked.result.fixes && picked.result.fixes.length > 0);

    // POISON GUARD — a picked whose move list is far shorter than this game's
    // OCR was computed against a cross-game-contaminated input (the requeue
    // ownership guard now blocks the source, but a pre-existing poisoned
    // aggregate can still be cached). Partial/solved results carry the full
    // input length, so a gross shortfall is unambiguous poison. Don't
    // auto-enter verification with it — fall through to revalidate so the
    // user sees their real game, not 8 moves from a different one.
    if (pickedReviewable && picked && picked.result &&
        Array.isArray(picked.result.moves) &&
        _moveCountLooksPoisoned(gameId, Math.round(picked.result.moves.length / 2))) {
      if (typeof log === 'function') {
        log('  ⚠ picked for ' + gameId + ' looks poisoned (' +
            Math.round(picked.result.moves.length / 2) + ' rows ≪ ~' +
            _expectedMoveRows(gameId) + ' expected) — skipping auto-verify, ' +
            'falling back to revalidate. Re-run reconstruction to refill.');
      }
      picked = null;
      pickedStatus = 'none';
      pickedSolved = false;
      pickedReviewable = false;
    }

    // STALE-PICKED GUARD — if any user-confirmed ply in state.moves has
    // text that disagrees with picked.result.moves at the same ply, the
    // picked was computed against an OCR sequence that didn't have the
    // user's confirmations spliced in (typical scenario: browser reopen
    // wipes batchState.reconstructResults; orchestrator re-runs Greedy
    // on raw OCR before workingState restore can splice user fixes
    // through _buildOcrMovesFromState). Auto-entering Review on a stale
    // picked would route into _applyPickedToState's text-mismatch path
    // and silently overwrite confirmed plies with the algorithm's stale
    // view — reported symptom: confirmed 4.W=c4 reverted to e4 after
    // reopen.
    //
    // When stale: skip auto-Review, kick off rerunCurrentGame() so the
    // orchestrator re-runs with the confirmation-aware OCR. The user
    // sees their confirmed move list intact, the panel shows
    // "Queued/Running…", and they can hit Review when the fresh result
    // lands. _applyPickedToState's Fix-A confirmation override is the
    // downstream complement that catches the stale case if this guard
    // ever misses one.
    var pickedStale = false;
    var pickedStaleAt = null;
    // Strip trailing +/# before comparing — picked.result.moves and
    // state.moves can pick up different annotation rendering when they
    // come from different code paths (algorithm output vs UI revalidate
    // vs sheet merge), and a check/mate marker mismatch is NOT a
    // confirmation-vs-staleness signal. Without this, switching back to
    // a fully-solved game (37/37, 0 fixes) where some merge-locked ply
    // had picked="Bg5" but state="Bg5+" wrongly tripped the guard,
    // triggering rerunCurrentGame and resetting the methodStatus chain
    // even though the game was already done.
    function _normSan(s) { return (typeof s === 'string') ? s.replace(/[+#]+$/, '') : ''; }
    // For PARTIAL picks, only compare plies the algorithm actually validated.
    // Greedy/Beam build moves[] in place from the input, applying fixes up to
    // reached_ply but leaving everything past it as raw-OCR passthrough they
    // never inspected. Comparing those untouched plies against tier-1
    // merge-locked SANs in state.moves produces spurious mismatches — the
    // user reported clicking a game with `G◐33` triggered rerunCurrentGame,
    // wiping the partial result and bouncing all three method statuses.
    var _maxPly = Infinity;
    if (picked && picked.result && picked.result.status === 'PARTIAL' &&
        typeof picked.result.reached_ply === 'number') {
      _maxPly = picked.result.reached_ply;
    }
    if (pickedReviewable && picked && picked.result && picked.result.moves &&
        typeof state !== 'undefined' && Array.isArray(state.moves)) {
      for (var _smi = 0; _smi < state.moves.length && !pickedStale; _smi++) {
        var _smv = state.moves[_smi];
        if (!_smv) continue;
        var _wPly = _smi * 2;
        var _bPly = _wPly + 1;
        if (_wPly >= _maxPly) break;
        if (_smv.white && (_smv.wStatus === 'fixed' || _smv.wStatus === 'locked') &&
            _normSan(picked.result.moves[_wPly]) !== _normSan(_smv.white)) {
          pickedStale = true;
          pickedStaleAt = (_smi + 1) + '.W (confirmed "' + _smv.white +
                          '" but picked has "' + (picked.result.moves[_wPly] || '∅') + '")';
        }
        if (!pickedStale && _bPly < _maxPly && _smv.black &&
            (_smv.bStatus === 'fixed' || _smv.bStatus === 'locked') &&
            _normSan(picked.result.moves[_bPly]) !== _normSan(_smv.black)) {
          pickedStale = true;
          pickedStaleAt = (_smi + 1) + '.B (confirmed "' + _smv.black +
                          '" but picked has "' + (picked.result.moves[_bPly] || '∅') + '")';
        }
      }
    }
    if (pickedStale) {
      // DON'T set pickedReviewable=false — let auto-entry into Review
      // proceed even when picked disagrees with confirmed plies.
      // _applyPickedToState's section (c) ("UNCONDITIONAL CONFIRMATION
      // OVERRIDE") in verification-ui.js forcibly restores user-
      // confirmed text + status when the algorithm's output disagrees,
      // so the stale picked can't silently overwrite the user's work.
      // Skipping auto-entry here was overcautious — the user lost the
      // walkthrough on every game switch even though section (c) had
      // them covered.
      // We still don't auto-rerun (that's a separate question — caller
      // can hit Rerun All if they want a fresh run).
      if (typeof log === 'function') {
        log('  ⚠ picked is stale at ' + pickedStaleAt +
            ' — auto-entering Review anyway; confirmation override ' +
            'will preserve confirmed text');
      }
    }

    // Do NOT auto-enter verification mode while the user is still in the
    // noise-review UI. The batch orchestrator's noise check (only the
    // last 1-2 cells' confidence) is LESS strict than the UI's detector
    // (detectSuspiciousTail + same-SAN-neighbour + repeating-run rules),
    // so games that pass the batch check can still trigger the yellow
    // "Continue to Validation" panel here. Entering verification would
    // clobber that panel with _applyPickedToState + quick-fix rendering
    // for the algorithm's first "stuck" ply — the user reported exactly
    // this: "it suddenly starts finding move suggestions instead" while
    // they were still checking the noise tail. Defer verification until
    // the user commits the truncation (onTruncationComplete re-enqueues
    // for reconstruction against the cleaned input anyway).
    var _verifEntered = false;
    if (pickedReviewable && state && state.pendingNoiseReview) {
      if (typeof log === 'function') {
        log('  ◦ skipping auto-verify for ' + gameId +
            ' — user is in noise-review (truncation pending)');
      }
    } else if (pickedReviewable && window.VerificationUI) {
      try {
        var _entered = window.VerificationUI.enterVerificationMode(gameId, picked, result);
        if (_entered === false) {
          // Verification declined — e.g. every algo fix is already
          // confirmed in state.moves. Falls through to the revalidate
          // fallback below so the panel shows the real state (likely
          // "Game complete!" or the next remaining stuck point);
          // otherwise the user is left looking at the stale fix-panel
          // DOM from the pre-switch session.
        } else {
          _verifEntered = true;
          if (typeof log === 'function') {
            log('  → auto-entered ' + pickedStatus + ' review for ' + gameId +
                ' (' + (picked.method || '?') + ')');
          }
        }
      } catch (e) {
        console.warn('[Batch] Could not enter verification mode for ' + gameId + ':', e);
        if (typeof log === 'function') {
          log('  ⚠ verify entry THREW for ' + gameId + ' — ' + (e.message || e));
        }
      }
    } else if (typeof log === 'function' && picked) {
      log('  ◦ no auto-verify for ' + gameId + ' — pickedStatus=' + pickedStatus);
    }

    // Revalidate fallback when verification mode didn't take over.
    // _restoreGameWorkingState skipped its own revalidate on the assumption
    // verification would render the move list itself; if verification was
    // declined (already-confirmed plies), short-circuited (stale picked
    // sets pickedReviewable=false), or never had a picked at all, the
    // fix-list and stuck-info elements stay frozen on whatever the
    // previous game left them at — user reported being permanently
    // stuck on "Checking moves..." with no way to advance. Skip in
    // noise-review mode so the yellow "Continue to Validation" panel
    // isn't clobbered by validation chrome.
    if (!_verifEntered && state && !state.pendingNoiseReview &&
        typeof revalidate === 'function') {
      // Reset the fix-panel header — revalidate() repaints stuck-info and
      // fix-list but NOT fix-panel-title, so when the previous game was in
      // verification mode its "Review — Greedy / N/M at X.W / ◀ ▶ Exit"
      // header survives the switch and the user sees stale review chrome
      // on a game that has no orchestrator result to review. Putting the
      // default "Fix Suggestions" string back here is the smallest fix
      // that doesn't risk side-effecting the outgoing game (calling
      // VerificationUI.exitVerificationMode here would trigger its own
      // revalidate on the OUTGOING game's state and race the incoming
      // game's repaint).
      var _titleEl = document.getElementById('fix-panel-title');
      if (_titleEl) _titleEl.innerHTML = 'Fix Suggestions';
      revalidate().catch(function(e) {
        console.warn('[Batch] Post-skip revalidate failed for ' + gameId + ':', e);
      });
    }
  }

  /**
   * Rebuild an ocrResult from the current app state. Called after the user
   * truncates a noisy game — state.ocrCells (single-sheet) or
   * state.ocrCellsSheet1/Sheet2 (dual-sheet) have been truncated in place
   * by deleteMovesFromPly, so we can persist the cleaned version.
   * @private
   */
  // Truncate a per-page cell array to match the post-truncation flat array.
  // The flat array is the cumulative truncation target; pages contribute
  // cells in order (page-0 first, page-1 next, etc.), and truncation is
  // always tail-truncation via deleteMovesFromPly — so we just take cells
  // off the END page by page until we've matched the new total.
  //
  // Why this exists: _rebuildOcrResultFromState used to copy orig.sheet1
  // truncated but pass orig.sheet1Pages through Object.assign untouched.
  // The next selectGame → _buildSheetSlots PREFERS pagesArr over flat,
  // so the un-truncated pages were silently re-loaded and the noise tail
  // reappeared in the move list. User-reported: confirm "Continue to
  // Validation", click off and back onto the same game, noise back —
  // even though the game list correctly showed truncation completed.
  // sheet1ImagePages stays untouched: those are page IMAGES (used for
  // thumbnails), not cells, and a page still exists as a sheet even if
  // its moves were all truncated.
  function _trimPagesToFlatLen(pages, flat) {
    if (!Array.isArray(pages)) return pages;
    var keep = (Array.isArray(flat) ? flat.length : 0);
    var trimmed = [];
    for (var i = 0; i < pages.length; i++) {
      var pg = pages[i];
      if (!Array.isArray(pg)) { trimmed.push(pg); continue; }
      if (keep <= 0) { trimmed.push([]); continue; }
      if (pg.length <= keep) {
        trimmed.push(pg);
        keep -= pg.length;
      } else {
        trimmed.push(pg.slice(0, keep));
        keep = 0;
      }
    }
    return trimmed;
  }

  function _rebuildOcrResultFromState(gameId) {
    if (typeof state === 'undefined') return null;
    var orig = batchState.ocrResults[gameId] || {};
    if (orig.isDualSheet || state.ocrCellsSheet1 || state.ocrCellsSheet2) {
      // Clone `orig` so we carry through every field we don't explicitly
      // override — sheet1Pages / sheet2Pages / sheet1ImagePages /
      // sheet2ImagePages in particular. Without those, the next selectGame
      // → _buildSheetSlots collapses multi-page games into a single slot,
      // and the Moves-header thumbnails for P1.2 / P2.2 disappear even
      // though the reconstructed game spans two pages per player.
      var rebuilt = Object.assign({}, orig);
      rebuilt.isDualSheet = true;
      rebuilt.sheet1 = (state.ocrCellsSheet1 || orig.sheet1 || []).slice();
      rebuilt.sheet2 = (state.ocrCellsSheet2 || orig.sheet2 || []).slice();
      // Trim the per-page cell arrays to match. See _trimPagesToFlatLen
      // for why — without this, re-selecting a truncated game resurrects
      // the noise tail through _buildSheetSlots's pagesArr preference.
      if (Array.isArray(orig.sheet1Pages)) {
        rebuilt.sheet1Pages = _trimPagesToFlatLen(orig.sheet1Pages, rebuilt.sheet1);
      }
      if (Array.isArray(orig.sheet2Pages)) {
        rebuilt.sheet2Pages = _trimPagesToFlatLen(orig.sheet2Pages, rebuilt.sheet2);
      }
      return rebuilt;
    }
    return Object.assign({}, orig, {
      ocrCells: (state.ocrCells || orig.ocrCells || []).slice()
    });
  }

  /**
   * Called from the "Continue to Validation" button handler in ocr.js when
   * a batch game is active. Persists the truncated OCR (so revisiting the
   * game doesn't re-trigger the noise-review prompt), marks the game as
   * noise-resolved, and enqueues it for reconstruction now that the input
   * is clean.
   */
  function onTruncationComplete(gameId) {
    if (!gameId) gameId = batchState.currentGameId;
    if (!gameId) return;
    var game = batchState.games.get(gameId);
    if (!game) return;

    var cleaned = _rebuildOcrResultFromState(gameId);
    if (cleaned) batchState.ocrResults[gameId] = cleaned;

    game.hasTrailingNoise = false;
    game.noiseResolved = true;
    if (game.status === GAME_STATUS.NEEDS_TRUNCATION) {
      game.status = GAME_STATUS.RECONSTRUCTING;
    }

    if (batchState.reconstructQueue && cleaned) {
      // Thaw any row freeze before re-enqueuing: this is a deliberate fresh
      // reconstruction on the truncated OCR (via enqueue, which — unlike
      // requeue — never fires onGameReset), so its G/B/D badges must render.
      delete _completedRowGameIds[gameId];
      // Thaw the panel-bridge freeze too. The truncation path runs through
      // syncAfterTruncation → _clearStalenessAndAbort, which calls
      // BatchPanelBridge.markComplete(gameId). If we don't clear it, the
      // reconstruction we're about to launch fires progress events that the
      // bridge discards (panels stay on "✓ Game complete"), so the user sees
      // no algorithm activity.
      if (window.BatchPanelBridge &&
          typeof window.BatchPanelBridge.clearComplete === 'function') {
        try { window.BatchPanelBridge.clearComplete(gameId); } catch (e) {}
      }
      // Resume the orchestrator BEFORE enqueue. If the per-method queues were
      // ever cancelled (e.g. the user hit "Cancel Batch Processing" earlier
      // and is now coming back to truncate + continue a game), enqueue() would
      // append the game but its `if (!processing && !cancelled)` pump guard
      // would refuse to start — the game sits in the queue forever and "the
      // algorithms simply don't start on it". resume() clears the sticky
      // cancelled flag and kicks the pump; it's a near-no-op in the normal
      // (never-cancelled) flow.
      if (typeof batchState.reconstructQueue.resume === 'function') {
        try { batchState.reconstructQueue.resume(); } catch (e) {}
      }
      try { batchState.reconstructQueue.enqueue(gameId, cleaned); } catch (e) {}
    }
    renderGameList();
  }

  /**
   * Build a friendlier .pgn filename than the raw gameId. The internal
   * gameId is "{section}_R{round}_B{board}" and section falls back to
   * "Unknown" when neither the directory layout nor the filename pattern
   * carries a section name (common when the user uploads loose files
   * named just "P1.pdf" / "P2.pdf"). For the saved file we'd rather pull
   * the section from the loaded tournament file than leave "Unknown" as
   * the prefix.
   *
   * Resolution order:
   *   1. game.section (if truthy and not "Unknown") — the per-game value
   *      derived from directory path or filename pattern.
   *   2. tournamentData.sections (SJSON only — short, specific section
   *      names like "Premier"). Prefer this over the event name: it's
   *      consistent with how SJSON tournaments are organized and short
   *      enough for a filename. Only auto-pick when the tournament has
   *      exactly one section; with multiple, we can't tell which one
   *      this game belongs to.
   *   3. tournamentData.event (SwissManager fallback — event name, no
   *      sections array). E.g. "2026 Royal Ladder Round Robin".
   *   4. Whatever's already in gameId (final fallback — preserves old
   *      behavior when no replacement is available).
   */
  function _buildPgnFilename(gameId, game) {
    if (!gameId) return null;
    var sanitize = function(s) {
      if (!s) return '';
      return String(s).replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '');
    };
    var section = (game && game.section) || '';
    if (!section || section === 'Unknown') {
      var td = window._batchTournamentData || null;
      if (td && Array.isArray(td.sections) && td.sections.length === 1) {
        section = td.sections[0];
      } else if (td && td.event) {
        section = td.event;
      }
    }
    if (!section || section === 'Unknown') {
      // No replacement available — keep the original gameId-based name.
      return gameId + '.pgn';
    }
    var round = (game && game.round != null) ? game.round : null;
    var board = (game && game.board != null) ? game.board : null;
    if (round == null || board == null) return gameId + '.pgn';
    return sanitize(section) + '_R' + round + '_B' + board + '.pgn';
  }

  /**
   * Sync batch-level caches to the post-truncation state. Called from
   * ui.js::deleteMovesFromPly after the user chops trailing noise in an
   * already-reconstructed game (so not via the initial noise-review flow
   * that onTruncationComplete handles).
   *
   * Does four things:
   *   1. Rebuilds batchState.ocrResults[gameId] from the now-truncated
   *      state.ocrCells / ocrCellsSheet1/2. Without this the game-list
   *      counter reads the pre-truncation sheet length — user-reported
   *      "113/113" on a 111-move game after cutting two noise cells.
   *   2. Invalidates batchState.reconstructResults[gameId]. The
   *      stored fix list was computed against the pre-truncation OCR
   *      and may reference plies that no longer exist or contradict
   *      the user's now-baked-in moves.
   *   3. Aborts the orchestrator's in-flight + queued reconstruction
   *      and clears game.reconstructPicked/methodStatus/tier/triage.
   *      Truncating "during the reconstruction phase" leaves a method
   *      running on the pre-truncation OCR; if allowed to finish, its
   *      onGameComplete refills the result we just cleared and selectGame
   *      replays the noisy picked on switch-back — user-reported "the
   *      truncation doesn't stick, the noise comes back."
   *   4. Clears the per-game side-panel result globals + log, so the
   *      next selectGame or bindGame doesn't replay a stale SOLVED
   *      log with dangling plies.
   */
  function syncAfterTruncation(gameId) {
    if (!gameId) gameId = batchState.currentGameId;
    if (!gameId) return;

    var cleaned = _rebuildOcrResultFromState(gameId);
    if (cleaned) batchState.ocrResults[gameId] = cleaned;

    if (batchState.reconstructResults) {
      delete batchState.reconstructResults[gameId];
    }

    // Abort the orchestrator's in-flight + queued reconstruction for this
    // game and clear the stale per-game badges/picked. Without this, a
    // method still running against the PRE-truncation OCR (the "during the
    // reconstruction phase" case) finishes after we clear reconstructResults
    // above, and onGameComplete — which only discards when status is
    // NEEDS_TRUNCATION — pours the noisy result straight back into
    // reconstructResults[gameId] and game.reconstructPicked. selectGame then
    // replays that picked on switch-back (it carries extra trailing noise
    // plies that neither the poison nor stale-picked guard catches), so the
    // noise the user just chopped reappears. _clearStalenessAndAbort kills
    // the in-flight runs (they return CANCELLED → discarded), clears
    // methodStatus/tier/triage, and freezes the panel bridge so a worker
    // mid-step can't fire a last stale event.
    var _g = batchState.games.get(gameId);
    if (_g) {
      _clearStalenessAndAbort(_g);
      _g.reconstructPicked = null;
    }

    if (typeof window.greedyResult !== 'undefined') window.greedyResult = null;
    if (typeof window.beamResult !== 'undefined') window.beamResult = null;
    if (typeof window.dijkstraResult !== 'undefined') window.dijkstraResult = null;
    if (typeof clearPanelLog === 'function') {
      try {
        clearPanelLog('greedy');
        clearPanelLog('beam');
        clearPanelLog('dijkstra');
      } catch (e) { /* non-fatal */ }
    }

    renderGameList();
    if (typeof log === 'function') {
      log('🗑️ Truncation synced for ' + gameId + ' — ocrResults updated, reconstructResults cleared');
    }
  }

  // Internal helper — when a game finishes (whether by user verification, by
  // the auto-mark on game-switch, by the catch-up promotion in renderGameList,
  // or by revalidate finding no stuck point), do two things:
  //
  //   1. Clear the row's pre-completion methodStatus / tier / triage. Without
  //      this, the sidebar keeps showing "G◐35 B✓ D✓ Tier C" alongside the
  //      panels' "✓ Game complete" — user-reported as inconsistent state.
  //
  //   2. Abort the orchestrator's in-flight + queued work for this game.
  //      The orchestrator's per-method queues run their own SearchManager
  //      instances; cancelSearch() (which only cancels the UI singleton)
  //      doesn't reach them, so a still-running Dijkstra would (a) waste
  //      CPU on a solved game, and (b) keep emitting step events that the
  //      panel bridge re-renders, overwriting the "✓ Game complete" header.
  //
  // The caller decides what to do with `game.status` (VERIFIED vs leave-alone);
  // this helper only handles the orthogonal staleness/abort cleanup.
  // Games whose game-LIST row has been frozen at "complete" — the mirror of
  // the panel bridge's _completedGameIds (which freezes the side panels). Set
  // by _clearStalenessAndAbort when a game becomes functionally complete or is
  // verified; consulted by the orchestrator forwarders (onProgress /
  // onMethodStep / onGameComplete) so a late escalation event from a run still
  // unwinding on the pre-completion OCR can't re-seed g.methodStatus and
  // repaint "G◐ B✗ D⋯" next to the panels' "✓ Game complete". Cleared on
  // requeue (onGameReset), when the user goes back into the game.
  var _completedRowGameIds = {};

  function _clearStalenessAndAbort(game) {
    if (!game) return;
    game.methodStatus = null;
    game.tier = null;
    game.triageReason = null;
    game.triageDetails = null;
    _completedRowGameIds[game.gameId] = true;
    if (batchState.reconstructQueue &&
        typeof batchState.reconstructQueue.abortGame === 'function') {
      try { batchState.reconstructQueue.abortGame(game.gameId); } catch (e) {}
    }
    // Freeze the bridge so a worker mid-step at abort time can't fire one
    // last progress event that overwrites the panels' "✓ Game complete"
    // header with "Step N Q:M" — the queue's cancel flag is only checked
    // at iteration boundaries.
    if (window.BatchPanelBridge &&
        typeof window.BatchPanelBridge.markComplete === 'function') {
      try { window.BatchPanelBridge.markComplete(game.gameId); } catch (e) {}
    }
  }

  // Public entry point used by markPanelsGameComplete (beam.js) when
  // revalidate detects the current game has no stuck point. Clears row
  // staleness and stops the orchestrator's runs so the panels' "✓ Game
  // complete" header stays put.
  //
  // Also auto-promotes game.status to VERIFIED when the live state passes
  // the same gates _saveGameWorkingState uses on game-switch (no stuck
  // point, noise resolved, every populated cell ok/fixed/locked). Without
  // this, the row icon stayed 🟡 (NEEDS_REVIEW) until the user switched
  // games and back — at which point _saveGameWorkingState's auto-VERIFY
  // would fire and flip it to ✅. The row's per-game length indicator
  // already showed "N/N ✓ (P plies)" in green via _isCurrentGameReadyToSave,
  // so the icon trailing the badge was a visible inconsistency.
  function onCurrentGameFunctionallyComplete() {
    if (!batchState.currentGameId) return;
    var game = batchState.games.get(batchState.currentGameId);
    if (!game) return;
    _clearStalenessAndAbort(game);

    // Cancel any pending requeueAfterFix debounce. The game just reached a
    // complete state — there is nothing to requeue. Without this, the 1500ms
    // debounce fires after game completion, re-runs Greedy (VALID), and the
    // always-chain policy escalates to Beam/Dijkstra which lack user_confirmed_plies
    // and re-flag the user-accepted absurdity (keep-as-is), spinning indefinitely.
    if (_requeueTimer && _requeuePendingForGame === batchState.currentGameId) {
      clearTimeout(_requeueTimer);
      _requeueTimer = null;
      _requeuePendingForGame = null;
    }

    if (game.status !== GAME_STATUS.VERIFIED &&
        game.status !== GAME_STATUS.EXPORTED &&
        (!game.hasTrailingNoise || game.noiseResolved) &&
        _isCurrentGameReadyToSave()) {
      game.status = GAME_STATUS.VERIFIED;
      if (typeof log === 'function') {
        log('✅ Auto-marked ' + batchState.currentGameId + ' as VERIFIED (' +
            (state.sans ? state.sans.length : 0) + ' moves validated, no stuck point)');
      }
    }

    renderGameList();
  }

  /**
   * Mark the current game as verified.
   */
  function markVerified() {
    if (!batchState.currentGameId) return;
    var game = batchState.games.get(batchState.currentGameId);
    if (game) {
      game.status = GAME_STATUS.VERIFIED;
      // Clear the sidebar's stale per-method status, tier, and triage AND
      // stop any orchestrator runs still in flight on the pre-verify input.
      // Without the abort, a late Dijkstra finishing afterwards would re-seed
      // methodStatus={dijkstra:'running'} via onProgress and the row would
      // flip back to G· B· D↻ on a verified game.
      _clearStalenessAndAbort(game);
    }

    // Clear the side panels' stored results and replace the status labels
    // with "Game complete". Otherwise the Greedy/Beam/Dijkstra panels keep
    // showing "SOLVED (N fixes)" with a Review button even though every
    // fix has been applied and the game is done — user-reported "the
    // algorithms are also still showing leftover from their previous runs."
    if (typeof window.greedyResult !== 'undefined') window.greedyResult = null;
    if (typeof window.beamResult !== 'undefined') window.beamResult = null;
    if (typeof window.dijkstraResult !== 'undefined') window.dijkstraResult = null;
    ['greedy', 'beam', 'dijkstra'].forEach(function(m) {
      if (typeof clearPanelLog === 'function') {
        try { clearPanelLog(m); } catch (e) { /* non-fatal */ }
      }
      if (typeof updateSearchPanel === 'function') {
        try { updateSearchPanel(m, '✓ Game complete', 100); } catch (e) {}
      }
    });

    renderGameList();

    // Refresh the on-disk round combined PGN so it reflects the user-confirmed
    // move list, not the pre-review algorithm proposal. _autoSaveGame writes
    // this file when each game *completes reconstruction* (before the user
    // overrides any fix), so without this re-save the round file keeps the raw
    // algorithm suggestion — e.g. Greedy's Qxe7+ instead of the user's Qf7# —
    // for any game whose verification isn't followed by another game finishing.
    // Fire-and-forget (mirrors _autoSaveGame); _movesForGame now reads the
    // confirmed state.sans for this current game.
    if (batchState.selectedRound != null &&
        window.BatchExport && window.BatchExport.exportAndSaveRoundCombinedPgn) {
      window.BatchExport.exportAndSaveRoundCombinedPgn(batchState.selectedRound)
        .then(function() {
          if (typeof log === 'function') {
            log('[Verify] Round ' + batchState.selectedRound +
                ' combined PGN refreshed with confirmed moves');
          }
        })
        .catch(function(e) {
          console.warn('[Batch] Round PGN refresh after verify failed:', e);
        });
    }
  }

  // =========================================================================
  // PGN Save + Navigation
  // =========================================================================

  // Per-method status indicator rendering.
  // Keeps the row compact: "G✓ B⟳ D·" = Greedy solved, Beam running, Dijkstra idle.
  var _METHOD_LETTER = { greedy: 'G', beam: 'B', dijkstra: 'D' };
  var _METHOD_GLYPH = {
    idle:    { glyph: '\u00B7',  cls: 'text-gray-600',                label: 'not run' },       // ·
    queued:  { glyph: '\u22EF',  cls: 'text-gray-400',                label: 'queued' },        // ⋯
    running: { glyph: '\u21BB',  cls: 'text-blue-400 animate-pulse',  label: 'running' },       // ↻
    solved:  { glyph: '\u2713',  cls: 'text-green-400',               label: 'solved' },        // ✓
    partial: { glyph: '\u25D0',  cls: 'text-amber-400',               label: 'partial' },       // ◐ — fixes applied but game not fully solved
    failed:  { glyph: '\u2717',  cls: 'text-red-400',                 label: 'did not solve' }, // ✗
    error:   { glyph: '!',       cls: 'text-red-500',                 label: 'error' }
  };
  function _renderMethodStatus(methodStatus, results) {
    if (!methodStatus) return '';
    // Sized to match the main row label so the G/B/D indicator reads
    // alongside "B6 · White vs Black — 1-0" rather than squeezing into the
    // right margin — plenty of horizontal space in the sidebar to use.
    var out = '<span class="inline-flex gap-1.5 text-sm font-mono leading-none" title="Greedy / Beam / Dijkstra">';
    ['greedy', 'beam', 'dijkstra'].forEach(function(m) {
      var s = methodStatus[m] || 'idle';
      var g = _METHOD_GLYPH[s] || _METHOD_GLYPH.idle;
      var letter = _METHOD_LETTER[m];
      // For partial results, append the move number reached — lets the user
      // triage "which game did Greedy get furthest on?" without opening each
      // one. Same information would be buried in the algorithm panel otherwise.
      // Prefer the worker-reported reached_ply (where the algo actually got
      // stuck); fall back to the highest applied fix's ply, then to
      // result.moves.length only as a last resort. moves.length is the input
      // game length and overstates progress when the algo committed fixes
      // but couldn't validate downstream — user-reported "G◐37 ... 37" for
      // a 37-move game where partial actually got stuck mid-game.
      var suffixHtml = '';
      var title = letter + ': ' + g.label;
      if (s === 'partial' && results && results[m]) {
        var r = results[m];
        var ply = null;
        if (typeof r.reached_ply === 'number' && r.reached_ply >= 0) {
          ply = r.reached_ply;
        } else if (Array.isArray(r.fixes) && r.fixes.length > 0) {
          var maxFixPly = -1;
          r.fixes.forEach(function(f) {
            if (typeof f.ply === 'number' && f.ply > maxFixPly) maxFixPly = f.ply;
          });
          if (maxFixPly >= 0) ply = maxFixPly + 1;
        } else if (Array.isArray(r.moves)) {
          ply = r.moves.length;
        }
        if (ply != null && ply > 0) {
          var moveNo = Math.ceil(ply / 2);
          // Brighter shade than the partial-disc so the number stands out.
          suffixHtml = '<span class="text-amber-200 font-semibold">' + moveNo + '</span>';
          title += ' (reached move ' + moveNo + ', ply ' + ply + ')';
        }
      }
      out += '<span class="' + g.cls + '" title="' + title + '">' +
             letter + g.glyph + suffixHtml + '</span>';
    });
    out += '</span>';
    return out;
  }

  // Color theme for the main status icon during RECONSTRUCTING, keyed by the
  // method currently running. Mirrors the log-line colors in beam.js so the
  // user builds one mental color map: green=greedy, cyan=beam, purple=dijkstra.
  var _METHOD_THEME = {
    greedy:   { cssClass: 'text-green-400',  label: 'Greedy' },
    beam:     { cssClass: 'text-cyan-400',   label: 'Beam' },
    dijkstra: { cssClass: 'text-purple-400', label: 'Dijkstra' }
  };
  /**
   * Shorten the OCR queue's progress detail into something readable in a
   * narrow game-list row. Queue emits strings like
   *   "OCR 3/6: Undriadi Vs Adhrit P1.pdf (left)"
   *   "Converting PDF: 0001__Section1__Round2__Board6__Page1.pdf"
   *   "Dual-sheet detected (3024x4032, ratio 0.75) — splitting: xyz.jpg"
   * We keep counter + filename so the user can see which sheet is being
   * processed; long filenames are truncated and the dual-sheet (left)/(right)
   * suffix is preserved.
   */
  function _shortenOcrDetail(detail) {
    if (!detail) return null;
    var m = detail.match(/^OCR\s+(\d+)\/(\d+)(?::\s*(.*))?$/i);
    if (m) {
      var head = 'OCR ' + m[1] + '/' + m[2];
      var rest = (m[3] || '').trim();
      if (!rest) return head;
      var sideMatch = rest.match(/\s*\((left|right)\)\s*$/i);
      var side = '';
      if (sideMatch) {
        side = ' (' + sideMatch[1].toLowerCase() + ')';
        rest = rest.slice(0, sideMatch.index).trim();
      }
      var base = rest.replace(/\.(jpe?g|png|tiff?|pdf)$/i, '');
      if (base.length > 28) base = base.slice(0, 26) + '\u2026';
      return head + ': ' + base + side;
    }
    if (/^Converting PDF/i.test(detail)) return 'Converting PDF\u2026';
    if (/^Dual-sheet detected/i.test(detail)) return 'Splitting dual-sheet\u2026';
    // Fallback: truncate long strings.
    return detail.length > 32 ? detail.slice(0, 30) + '\u2026' : detail;
  }

  function _activeMethodTheme(methodStatus) {
    if (!methodStatus) return null;
    // 'running' takes priority over 'queued' — which method is actually
    // burning cycles right now is what the user wants to see. The
    // caller needs to know WHICH state too so it can label "Reconstructing:"
    // vs "Queued for" correctly (two games used to both say
    // "Reconstructing: Dijkstra" when only one was actually running and
    // the other was sitting in the dijkstra queue).
    var order = ['greedy', 'beam', 'dijkstra'];
    for (var i = 0; i < order.length; i++) {
      if (methodStatus[order[i]] === 'running') {
        return { theme: _METHOD_THEME[order[i]], state: 'running' };
      }
    }
    for (var j = 0; j < order.length; j++) {
      if (methodStatus[order[j]] === 'queued') {
        return { theme: _METHOD_THEME[order[j]], state: 'queued' };
      }
    }
    return null;
  }

  /**
   * Compute the length/progress indicator rendered at the far right of
   * each row. Three states:
   *   - Unopened game: just the total-plies estimate ("80"). Estimate
   *     comes from the merged OCR cell count (single sheet = plies;
   *     dual sheet = max(sheet1, sheet2) because each sheet is written
   *     independently by one player and either side's count is a ply
   *     upper bound — noise / missing cells aside).
   *   - In progress: "valid / total" derived from the live state if
   *     this is the current game, or from the saved workingState if
   *     previously opened. Valid = state.sans.length; total = plies
   *     estimate. Shrinks after truncation (ocrResult mutates), grows
   *     as the user fixes stuck points.
   *   - Verified: "N/N ✓" in green.
   *
   * Returns {text, cls, tooltip} or null if no number to show.
   */
  function _gameLengthIndicator(game) {
    if (!game) return null;
    var ocr = batchState.ocrResults[game.gameId];
    var totalPlies = 0;
    if (ocr) {
      if (ocr.isDualSheet) {
        totalPlies = Math.max(
          (ocr.sheet1 || []).length,
          (ocr.sheet2 || []).length
        );
      } else if (ocr.ocrCells) {
        totalPlies = ocr.ocrCells.length;
      }
      // Self-heal the cached ocrCellCount from the authoritative OCR. It's a
      // derived copy stamped at OCR-complete time and consumed by the export
      // CSV (batch-export.js); cross-game contamination could leave it stale
      // (observed: B5's read 160 — B3's count — instead of 32). Recompute so
      // the cached copy can't drift from the OCR it's supposed to summarize.
      var _authCellCount = ocr.isDualSheet
        ? ((ocr.sheet1 || []).length + (ocr.sheet2 || []).length)
        : (ocr.ocrCells || []).length;
      if (_authCellCount > 0 && game.ocrCellCount !== _authCellCount) {
        game.ocrCellCount = _authCellCount;
      }
    }
    // Fallback to the (possibly pre-truncation) count saved at OCR
    // time — ocrCellCount sums BOTH sheets for dual-sheet, so halve.
    if (!totalPlies && game.ocrCellCount > 0) {
      totalPlies = Math.ceil(game.ocrCellCount / 2);
    }

    // User-confirmed prefix: how far the user has SIGNED OFF on, not
    // how far the algorithms got. For a Greedy SOLVED game with 35
    // fixes, all 73 plies pass validation immediately (state.sans.length
    // = 73), but the user hasn't reviewed any of them yet — so reading
    // sans.length here would mislabel "73/73" before they did anything.
    // confirmedPly grows as the user clicks Confirm in the walkthrough
    // (or applies a fix in the interactive UI), so it's the right
    // "how much have I personally signed off on" measure.
    var confirmedPly = null;
    var isCurrent = (batchState.currentGameId === game.gameId);
    if (isCurrent && typeof state !== 'undefined' &&
        typeof state.confirmedPly === 'number') {
      confirmedPly = state.confirmedPly;
    } else if (game.workingState &&
               typeof game.workingState.confirmedPly === 'number') {
      confirmedPly = game.workingState.confirmedPly;
    }

    var isVerified = (game.status === GAME_STATUS.VERIFIED ||
                      game.status === GAME_STATUS.EXPORTED);

    // A game whose validation reached its natural end (no stuck point,
    // no pending noise review, every populated cell ok/fixed/locked)
    // is "complete" for display purposes — the chess engine has played
    // through to checkmate / resignation / draw, so state.sans.length
    // (or workingState.sans.length) is the ground-truth ply count. The
    // OCR cell count can overshoot it: trailing "1-0" markings written
    // into score cells, dual-sheet length imbalance where the longer
    // sheet still has scribble after the game ended, etc. Without this,
    // a finished 47-ply game with 49 OCR cells displayed as
    // "24/25 (47/49 plies)" — the user reads two outstanding plies that
    // don't actually exist. Treat ready-to-save like VERIFIED for the
    // indicator (auto-VERIFY in _saveGameWorkingState catches it on
    // game switch anyway; this just stops the misleading display while
    // the game is still the active one).
    var isCompleteUnsaved = false;
    if (!isVerified) {
      if (isCurrent && _isCurrentGameReadyToSave() &&
          state.sans && state.sans.length > 0) {
        totalPlies = state.sans.length;
        isCompleteUnsaved = true;
      } else if (!isCurrent && _isWorkingStateComplete(game)) {
        totalPlies = game.workingState.sans.length;
        isCompleteUnsaved = true;
      }
    }
    if (!totalPlies) return null;

    // Report moves rather than plies so the total lines up with the
    // partial-result badge (\u25D031 = "reached move 31") and with how
    // chess players read game lengths. Math.ceil covers the half-move
    // case: 73 plies \u2192 37 moves (white's 37th move, black to respond).
    // Tooltips include both so the precise ply count stays recoverable.
    var totalMoves = Math.ceil(totalPlies / 2);
    var confirmedMoves = (confirmedPly != null && confirmedPly >= 0)
        ? Math.ceil(confirmedPly / 2) : null;

    // Display shows both moves (intuitive for chess players) and plies
    // (precise, no half-move ambiguity). Format: "M (P plies)" for total
    // and "M/M (P/P plies)" for confirmed/total. Tooltips repeat the
    // breakdown for screen readers and kept-around precision.
    if (isVerified || isCompleteUnsaved) {
      return {
        text: totalMoves + '/' + totalMoves + ' \u2713 (' + totalPlies + ' plies)',
        cls: 'text-green-400 font-semibold',
        tooltip: (isVerified ? 'Verified' : 'Complete \u2014 click Save PGN to verify') +
                 ' \u2014 ' + totalMoves + ' moves reconstructed (' +
                 totalPlies + ' plies)'
      };
    }
    if (confirmedMoves != null && confirmedMoves > 0) {
      var allConfirmed = (confirmedPly >= totalPlies);
      return {
        text: confirmedMoves + '/' + totalMoves +
              ' (' + confirmedPly + '/' + totalPlies + ' plies)',
        cls: allConfirmed ? 'text-green-400' : 'text-gray-400',
        tooltip: confirmedMoves + ' of ' + totalMoves + ' moves confirmed (' +
                 confirmedPly + '/' + totalPlies + ' plies)' +
                 (allConfirmed ? ' \u2014 review complete, Save PGN to verify' : '')
      };
    }
    return {
      text: totalMoves + ' (' + totalPlies + ' plies)',
      cls: 'text-gray-500',
      tooltip: totalMoves + ' moves / ' + totalPlies + ' plies (estimate from OCR; will refine as you review)'
    };
  }

  /**
   * Find the next game that needs review (OCR complete but not yet verified).
   * @param {Array} sortedGames - Games sorted by board number
   * @returns {string|null} - gameId of next game, or null
   */
  function _findNextGame(sortedGames) {
    if (!sortedGames || sortedGames.length === 0) return null;

    // Find current game's position in the sorted list
    var currentIdx = -1;
    for (var i = 0; i < sortedGames.length; i++) {
      if (sortedGames[i].gameId === batchState.currentGameId) {
        currentIdx = i;
        break;
      }
    }

    // Look for next unreviewed game after current
    for (var j = 1; j < sortedGames.length; j++) {
      var idx = (currentIdx + j) % sortedGames.length;
      var g = sortedGames[idx];
      if (g.status !== GAME_STATUS.QUEUED &&
          g.status !== GAME_STATUS.OCR_RUNNING &&
          g.status !== GAME_STATUS.VERIFIED &&
          g.status !== GAME_STATUS.EXPORTED) {
        return g.gameId;
      }
    }
    return null;
  }

  // Whether the currently-loaded game has reached a complete state that's
  // safe to write to disk and mark as verified. Mirrors the auto-VERIFY
  // guards in _saveGameWorkingState (no stuck point, noise review confirmed,
  // every populated cell ok/fixed/locked) so Save PGN can't flip an
  // incomplete game to ✅ and bake a partial result into a saved file.
  function _isCurrentGameReadyToSave() {
    if (typeof state === 'undefined' || !state) return false;
    if (state.stuckPly !== null && state.stuckPly !== undefined) return false;
    if (state.stuckInfo) return false;
    if (state.pendingNoiseReview) return false;
    if (!state.sans || state.sans.length === 0) return false;
    if (!Array.isArray(state.moves) || state.moves.length === 0) return false;
    var ok = { ok: 1, fixed: 1, locked: 1 };
    for (var i = 0; i < state.moves.length; i++) {
      var m = state.moves[i];
      if (m.white && !ok[m.wStatus]) return false;
      if (m.black && !ok[m.bStatus]) return false;
    }
    return true;
  }

  // Same completeness check, but against game.workingState — used by the
  // length indicator for non-active games. In normal flow, _saveGameWorkingState
  // already auto-promotes complete games to VERIFIED when the user switches
  // away, so this branch is mostly defensive (e.g. snapshots written before
  // the auto-VERIFY conditions were satisfied).
  function _isWorkingStateComplete(game) {
    if (!game || !game.workingState) return false;
    var ws = game.workingState;
    if (ws.stuckPly !== null && ws.stuckPly !== undefined) return false;
    if (ws.stuckInfo) return false;
    if (ws.pendingNoiseReview) return false;
    if (!ws.sans || ws.sans.length === 0) return false;
    if (!Array.isArray(ws.moves) || ws.moves.length === 0) return false;
    var ok = { ok: 1, fixed: 1, locked: 1 };
    for (var i = 0; i < ws.moves.length; i++) {
      var m = ws.moves[i];
      if (m.white && !ok[m.wStatus]) return false;
      if (m.black && !ok[m.bStatus]) return false;
    }
    return true;
  }

  // Mirror of _findNextGame, walking backwards through the sorted list.
  // Used by the "◀ Prev" button beside "Next ▶".
  function _findPrevGame(sortedGames) {
    if (!sortedGames || sortedGames.length === 0) return null;
    var currentIdx = -1;
    for (var i = 0; i < sortedGames.length; i++) {
      if (sortedGames[i].gameId === batchState.currentGameId) {
        currentIdx = i;
        break;
      }
    }
    for (var j = 1; j < sortedGames.length; j++) {
      var idx = (currentIdx - j + sortedGames.length) % sortedGames.length;
      var g = sortedGames[idx];
      if (g.status !== GAME_STATUS.QUEUED &&
          g.status !== GAME_STATUS.OCR_RUNNING &&
          g.status !== GAME_STATUS.VERIFIED &&
          g.status !== GAME_STATUS.EXPORTED) {
        return g.gameId;
      }
    }
    return null;
  }

  // =========================================================================
  // "Next ready for review" navigation
  // =========================================================================
  // Lets the user jump from the game they're reviewing straight to another
  // game whose reconstruction is done and waiting — without scrolling back up
  // to the game list. "Ready" is deliberately tighter than _findNextGame's
  // "anything in progress": only games an algorithm has actually produced a
  // reviewable result for (NEEDS_REVIEW — a method solved it or the chain is
  // exhausted on a PARTIAL) or that the user already started but left
  // (IN_REVIEW). RECONSTRUCTING (still working), NEEDS_TRUNCATION (needs a
  // different action first), and error states are intentionally excluded.

  // A game has something the user can actually start reviewing the moment ANY
  // single algorithm has produced a result — usually Greedy, sometimes Beam.
  // The orchestrator sets aggregate.picked (best-so-far) and fires
  // onGameComplete after EACH method finishes, so reconstructResults[gameId]
  // carries a usable partial/solved sequence even while later methods are
  // still running (status stays RECONSTRUCTING until solved or the chain is
  // exhausted). One partial is enough — we don't wait for the whole chain.
  function _hasUsablePartial(gameId) {
    var rr = batchState.reconstructResults[gameId];
    var res = rr && rr.picked && rr.picked.result;
    return !!(res && Array.isArray(res.moves) && res.moves.length > 0);
  }

  // Whether a game is ready for the user to step into and review/continue.
  // Tighter than "any in-progress game": excludes games still awaiting
  // truncation (the user must cut the noise first — that's not an algorithm
  // result), and games already done. Broader than "NEEDS_REVIEW only":
  // includes a still-RECONSTRUCTING game once one algorithm has a partial.
  function _isGameReviewable(game) {
    if (!game) return false;
    var s = game.status;
    // Already finished — nothing to review.
    if (s === GAME_STATUS.VERIFIED || s === GAME_STATUS.EXPORTED) return false;
    // Awaiting truncation. Covers the explicit NEEDS_TRUNCATION status AND the
    // case where opening the game flipped it to IN_REVIEW (selectGame) while
    // the trailing noise is still unresolved — the user complained that "Next
    // ready" was landing on games that actually need scissors first.
    if (s === GAME_STATUS.NEEDS_TRUNCATION) return false;
    if (game.hasTrailingNoise && !game.noiseResolved) return false;
    // A method solved it, the chain is exhausted, or the user already started.
    if (s === GAME_STATUS.NEEDS_REVIEW || s === GAME_STATUS.IN_REVIEW) return true;
    // Still reconstructing, but at least one algorithm already produced a
    // usable result — let the user dive in on the partial.
    if (s === GAME_STATUS.RECONSTRUCTING && _hasUsablePartial(game.gameId)) return true;
    return false;
  }

  // A game that needs the user to cut trailing noise before reconstruction can
  // run. Covers the explicit NEEDS_TRUNCATION status AND the case where opening
  // the game flipped it to IN_REVIEW (selectGame) while the noise is still
  // unresolved. Disjoint from _isGameReviewable (which excludes both). These
  // are folded into the "Next" cycle and PRIORITIZED — clearing them lets the
  // algorithms start sooner, and the user shouldn't have to scroll the game
  // list to find each one.
  function _needsTruncation(game) {
    if (!game) return false;
    if (game.status === GAME_STATUS.VERIFIED || game.status === GAME_STATUS.EXPORTED) return false;
    return game.status === GAME_STATUS.NEEDS_TRUNCATION ||
           (game.hasTrailingNoise && !game.noiseResolved);
  }

  // Anything the "Next" button should cycle through: a game awaiting truncation
  // OR a game ready for review.
  function _isActionable(game) {
    return _needsTruncation(game) || _isGameReviewable(game);
  }

  /**
   * Count games other than `excludeGameId` (defaults to the current game) that
   * need the user's attention — awaiting truncation OR ready for review. Drives
   * the Next button's enabled state and its "(N)" badge.
   */
  function countReviewableGames(excludeGameId) {
    var ex = excludeGameId || batchState.currentGameId;
    var n = 0;
    batchState.games.forEach(function(g, id) {
      if (id === ex) return;
      if (_isActionable(g)) n++;
    });
    return n;
  }

  // Walk the board-sorted game list outward from the current game (ascending
  // board, wrapping around) and return the gameId of the first game matching
  // `pred`, or null. Proximity order keeps "Next" predictable.
  function _proximityWalk(ex, pred) {
    var arr = [];
    batchState.games.forEach(function(g) { arr.push(g); });
    if (arr.length === 0) return null;
    arr.sort(function(a, b) { return (a.board || 0) - (b.board || 0); });
    var curIdx = -1;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].gameId === ex) { curIdx = i; break; }
    }
    for (var j = 1; j <= arr.length; j++) {
      var idx = ((curIdx < 0 ? -1 : curIdx) + j) % arr.length;
      var g = arr[idx];
      if (g.gameId === ex) continue;
      if (pred(g)) return g.gameId;
    }
    return null;
  }

  /**
   * Resolve the next game needing attention. Truncation games come FIRST
   * (clearing them unblocks reconstruction), each by proximity; only when none
   * remain do we cycle through review-ready games by proximity. Returns a
   * gameId or null.
   */
  function _findNextReviewable(excludeGameId) {
    var ex = excludeGameId || batchState.currentGameId;
    return _proximityWalk(ex, _needsTruncation) ||
           _proximityWalk(ex, _isGameReviewable);
  }

  /**
   * Jump to the next game needing attention (truncation prioritized, then
   * review). Resolved at call time (not when the button was rendered) so
   * games that changed state in the meantime are taken into account. Routes
   * through selectGame so the switch is serialized against the selectGame
   * re-entrancy guard.
   * @returns {boolean} - true if it navigated, false if nothing was pending.
   */
  function gotoNextReviewable() {
    var next = _findNextReviewable(batchState.currentGameId);
    if (!next) {
      if (typeof log === 'function') log('No other game needs attention yet.');
      return false;
    }
    if (typeof log === 'function') {
      var g = batchState.games.get(next);
      log('⏭ Jumping to next game (' +
          (g && _needsTruncation(g) ? 'truncation' : 'review') + '): ' + next);
    }
    selectGame(next);
    return true;
  }

  /**
   * Build PGN string for the current game with headers from batch metadata.
   * Delegates to BatchTournament (header builder) and BatchExport (writer)
   * when available so single-game and round-export paths share formatting.
   * @returns {string} - PGN text
   */
  function _buildBatchPgn() {
    if (typeof state === 'undefined' || !state.moves || state.moves.length === 0) return '';

    var game = batchState.currentGameId ? batchState.games.get(batchState.currentGameId) : null;
    var tournamentData = window._batchTournamentData || null;

    var moves = Array.isArray(state.sans) && state.sans.length > 0
      ? state.sans.slice()
      : state.moves.reduce(function(acc, m) {
          if (m.white) acc.push(m.white);
          if (m.black) acc.push(m.black);
          return acc;
        }, []);

    // Legality net — even a "ready to save" game can carry a validator-
    // accepted-yet-illegal tail in state.sans (the "board freezes mid-replay
    // while the movelist stays green" case). chess.js replay is a no-op for a
    // genuinely legal game and only trims an actually-illegal continuation, so
    // a complete export is never illegal.
    if (window.BatchExport &&
        typeof window.BatchExport.truncateToLegalPrefix === 'function') {
      moves = window.BatchExport.truncateToLegalPrefix(moves);
    }

    // Preferred path — shared builders used by round export.
    if (window.BatchTournament && window.BatchExport && game) {
      var headers = window.BatchTournament.buildPgnHeaders(game, tournamentData);
      return window.BatchExport.generatePgn(game, moves, headers);
    }

    // Fallback — minimal inline headers (pre-Phase-4 path).
    var pairing = game ? game.pairing : null;
    var result = (pairing && pairing.result) || '*';
    var headers2 = [];
    var roundStr2 = '?';
    if (game && game.round != null && game.board != null) {
      roundStr2 = game.round + '.' + game.board;
    } else if (game && game.round != null) {
      roundStr2 = String(game.round);
    } else if (game && game.board != null) {
      roundStr2 = '?.' + game.board;
    }
    headers2.push('[Event "' + ((tournamentData && tournamentData.event) || 'Tournament') + '"]');
    headers2.push('[Site "?"]');
    headers2.push('[Date "' + new Date().toISOString().slice(0, 10).replace(/-/g, '.') + '"]');
    headers2.push('[Round "' + roundStr2 + '"]');
    headers2.push('[White "' + ((pairing && pairing.whiteName) || '?') + '"]');
    headers2.push('[Black "' + ((pairing && pairing.blackName) || '?') + '"]');
    headers2.push('[Result "' + result + '"]');
    if (moves && moves.length > 0) headers2.push('[PlyCount "' + moves.length + '"]');
    headers2.push('[Source "Zugwise (gerhardtrippen.github.io/Zugwise)"]');

    var moveText = '';
    for (var i = 0; i < moves.length; i += 2) {
      var moveNum = Math.floor(i / 2) + 1;
      moveText += moveNum + '. ' + moves[i];
      if (moves[i + 1]) moveText += ' ' + moves[i + 1];
      moveText += ' ';
      if (moveNum % 5 === 0) moveText += '\n';
    }
    moveText += result;

    return headers2.join('\n') + '\n\n' + moveText.trim() + '\n';
  }

  /**
   * Build a partial PGN for a game that hasn't reached full reconstruction.
   * Uses moves up to the stuck point (stuckPly), result=*, Termination tag.
   * Falls back to a header-only PGN when no moves have been confirmed yet.
   */
  function _buildIncompleteBatchPgn() {
    var game = batchState.currentGameId ? batchState.games.get(batchState.currentGameId) : null;
    var tournamentData = window._batchTournamentData || null;

    // Confirmed prefix: plies before the stuck point. Plies at/after stuckPly
    // haven't been validated by the chess engine yet (algorithm proposals,
    // OCR candidates, or empty cells). If there's no stuck point but the
    // game still failed the full completeness check (pending noise review,
    // un-reviewed cells), use all of state.sans.
    var stuckAt = (typeof state !== 'undefined' && state != null &&
                   state.stuckPly != null)
      ? state.stuckPly
      : (typeof state !== 'undefined' && state != null &&
         Array.isArray(state.sans) ? state.sans.length : 0);
    var confirmedMoves = (typeof state !== 'undefined' && state != null &&
                          Array.isArray(state.sans))
      ? state.sans.slice(0, stuckAt)
      : [];

    // Legality net — when stuckPly is null (game validated complete, or only
    // pendingNoiseReview blocked it) the slice above is the FULL sans, which
    // can carry a polluted post-stuck tail (e.g. B3 "...39.Qxf5+ d3 40.f4 O-O"
    // where O-O is illegal). Truncate at the first move chess.js can't replay
    // so the saved PGN is never illegal and the "stopped at ply N" comment
    // below reflects the real legal length.
    if (window.BatchExport &&
        typeof window.BatchExport.truncateToLegalPrefix === 'function') {
      confirmedMoves = window.BatchExport.truncateToLegalPrefix(confirmedMoves);
    }

    var endComment = confirmedMoves.length === 0
      ? 'No moves verified — algorithm output not reviewed'
      : 'Reconstruction stopped at ply ' + confirmedMoves.length + ' — review pending';

    if (window.BatchTournament && window.BatchExport && game) {
      var headers = window.BatchTournament.buildPgnHeaders(game, tournamentData);
      var hdrs = {};
      Object.keys(headers).forEach(function(k) { hdrs[k] = headers[k]; });
      // Keep the pairing result (1-0 / 0-1 / 1/2-1/2) even for incomplete
      // reconstructions — the TD recorded the outcome regardless of whether we
      // have all the moves. Only fall back to '*' when no result is known.
      if (!hdrs.Result || hdrs.Result === '?') hdrs.Result = '*';
      hdrs.Termination = 'Reconstruction incomplete (Zugwise)';
      return window.BatchExport.generatePgn(game, confirmedMoves, hdrs, { endComment: endComment });
    }

    // Fallback — minimal inline headers (no BatchTournament/BatchExport).
    var pairing = game ? game.pairing : null;
    var pairingResult = (pairing && pairing.result) || '*';
    var roundStr = '?';
    if (game && game.round != null && game.board != null) {
      roundStr = game.round + '.' + game.board;
    } else if (game && game.round != null) {
      roundStr = String(game.round);
    } else if (game && game.board != null) {
      roundStr = '?.' + game.board;
    }
    var lines = [
      '[Event "' + ((tournamentData && tournamentData.event) || 'Tournament') + '"]',
      '[Site "' + ((tournamentData && tournamentData.site) || '?') + '"]',
      '[Date "' + new Date().toISOString().slice(0, 10).replace(/-/g, '.') + '"]',
      '[Round "' + roundStr + '"]',
      '[White "' + ((pairing && pairing.whiteName) || '?') + '"]',
      '[Black "' + ((pairing && pairing.blackName) || '?') + '"]',
      '[Result "' + pairingResult + '"]',
      '[Termination "Reconstruction incomplete (Zugwise)"]',
      '[Source "Zugwise (gerhardtrippen.github.io/Zugwise)"]',
      ''
    ];
    var moveText = '';
    for (var i = 0; i < confirmedMoves.length; i += 2) {
      var moveNum = Math.floor(i / 2) + 1;
      moveText += moveNum + '. ' + confirmedMoves[i];
      if (confirmedMoves[i + 1]) moveText += ' ' + confirmedMoves[i + 1];
      moveText += ' ';
      if (moveNum % 5 === 0) moveText += '\n';
    }
    moveText += '{' + endComment + '} ' + pairingResult;
    lines.push(moveText.trim());
    return lines.join('\n') + '\n';
  }

  /**
   * Save PGN for the current batch game.
   * Uses File System Access API if folder handle is available, otherwise browser download.
   */
  async function saveBatchGamePgn() {
    // Guard: only fire when the OCR-batch sidebar is active. Without this,
    // verification-ui.js's "save on confirm" hooks (intended for OCR
    // batch's per-game .pgn export) fire in PGN-batch mode too, downloading
    // one .pgn per game as the user moves through the tournament. PGN
    // batch has its own "Export combined PGN" link for the user-initiated
    // single-file download.
    if (!batchState.active) return;
    // Guard: refuse to save and mark verified if the game still has stuck
    // moves, pending noise review, or pending/error cells. Without this the
    // user could click Save on a partial reconstruction and get a ✅ on a
    // game whose move list is missing the actual ending — and the saved
    // .pgn would be a broken half-game. Already-verified games keep saving
    // freely (re-export with the same content is harmless).
    var curGame = batchState.currentGameId ? batchState.games.get(batchState.currentGameId) : null;
    var alreadyVerified = curGame && (curGame.status === GAME_STATUS.VERIFIED ||
                                       curGame.status === GAME_STATUS.EXPORTED);
    var isComplete = alreadyVerified || _isCurrentGameReadyToSave();

    var pgn;
    if (isComplete) {
      pgn = _buildBatchPgn();
      if (!pgn) {
        if (typeof log === 'function') log('No moves to save');
        return;
      }
    } else {
      // Partial save: confirmed prefix only, result=*, Termination tag added.
      // Does NOT mark the game verified — user can keep working on it.
      pgn = _buildIncompleteBatchPgn();
    }

    var gameId = batchState.currentGameId || 'game';
    var fileName = _buildPgnFilename(gameId, curGame) || (gameId + '.pgn');

    // Try to save to the scan folder via File System Access API
    var savedTo = 'download';
    if (batchState.folderHandle) {
      try {
        // Route into Zugwise/PGN (BatchPaths); fall back to the base folder.
        var saveDir = window.BatchPaths
          ? (await window.BatchPaths.resolveDir(batchState.folderHandle, fileName, true)) || batchState.folderHandle
          : batchState.folderHandle;
        var fileHandle = await saveDir.getFileHandle(fileName, { create: true });
        var writable = await fileHandle.createWritable();
        await writable.write(pgn);
        await writable.close();
        savedTo = 'folder';
        if (typeof log === 'function') log('Saved ' + (isComplete ? '' : '(partial) ') + fileName + ' to scan folder');
      } catch (e) {
        // File System Access API failed — fall back to browser download
        console.warn('[Batch] File save failed, falling back to download:', e);
        _downloadPgnFile(pgn, fileName);
      }
    } else {
      _downloadPgnFile(pgn, fileName);
    }

    // Only complete games earn the verified checkmark.
    if (isComplete) markVerified();

    // Visual confirmation on the button. For complete saves markVerified() just
    // re-rendered the button as "✓ Saved" — we overwrite with location info.
    // For partial saves the button would stay "💾 Save PGN"; we flash confirmation
    // then restore after 2.5 s (a subsequent renderGameList will also restore it).
    var _savedBtn = document.getElementById('btn-batch-save-pgn');
    if (_savedBtn) {
      var _whereStr = (savedTo === 'folder') ? ' → folder' : ' → downloaded';
      if (isComplete) {
        _savedBtn.innerHTML = '&#10003; Saved' + _whereStr;
      } else {
        _savedBtn.innerHTML = '&#128190; Saved (partial)' + _whereStr;
        setTimeout(function() {
          var _b = document.getElementById('btn-batch-save-pgn');
          if (_b && _b.innerHTML.indexOf('partial') >= 0) {
            _b.innerHTML = '&#128190; Save PGN';
          }
        }, 2500);
      }
    }
  }

  /**
   * Auto-save a game's PGN when reconstruction produces a SOLVED result, and
   * also refresh the round combined PGN. Called fire-and-forget from
   * onGameComplete so the file is on disk even before the user opens the game.
   * Does NOT mark the game verified — the user still reviews before confirming.
   */
  async function _autoSaveGame(gameId, payload) {
    if (!window.BatchExport) return;
    var game = batchState.games.get(gameId);
    if (!game) return;
    var picked = payload && payload.picked;
    var moves = picked && picked.result && picked.result.moves;
    if (!moves || moves.length === 0) return;

    var tournamentData = window._batchTournamentData || null;
    var headers = (window.BatchTournament && window.BatchTournament.buildPgnHeaders)
      ? window.BatchTournament.buildPgnHeaders(game, tournamentData)
      : { Event: 'Tournament', Site: '?', Date: '?', Round: '?',
          White: '?', Black: '?', Result: '*' };
    var pgn = window.BatchExport.generatePgn(game, moves, headers);
    var fileName = _buildPgnFilename(gameId, game) || (gameId + '.pgn');

    var savedTo = await window.BatchExport.saveText(pgn, fileName, 'application/x-chess-pgn');
    if (typeof log === 'function') {
      log('[Auto-save] ' + gameId + ' → ' + fileName +
          (savedTo === 'folder' ? ' (folder)' : ' (downloaded)'));
    }

    // Refresh the round combined PGN so the TD can open an up-to-date file
    // even while remaining games are still being reviewed.
    if (batchState.selectedRound != null && window.BatchExport.exportAndSaveRoundCombinedPgn) {
      try {
        await window.BatchExport.exportAndSaveRoundCombinedPgn(batchState.selectedRound);
        if (typeof log === 'function') {
          log('[Auto-save] Round ' + batchState.selectedRound + ' combined PGN updated');
        }
      } catch (e) {
        console.warn('[Batch] Round PGN auto-save failed:', e);
      }
    }
  }

  /**
   * Trigger a browser download for a PGN file.
   */
  function _downloadPgnFile(pgn, fileName) {
    var blob = new Blob([pgn], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    if (typeof log === 'function') log('Downloaded ' + fileName);
  }

  // =========================================================================
  // UI Rendering
  // =========================================================================

  // Trailing-edge throttle around renderGameList for high-frequency callers
  // like the per-step worker forwarder. The phase-transition callbacks call
  // renderGameList() directly (immediate paint); this is for the step
  // events that fire many times per second per running method and would
  // melt the DOM if they triggered full re-renders unthrottled.
  // 150ms = ~6 fps for live progress visibility; renderGameList is a string
  // concat + one innerHTML assignment so the DOM cost at this rate is
  // negligible even with all three methods streaming steps in parallel.
  var _listRepaintPending = false;
  function _scheduleListRepaint() {
    if (_listRepaintPending) return;
    _listRepaintPending = true;
    setTimeout(function() {
      _listRepaintPending = false;
      renderGameList();
    }, 150);
  }

  /**
   * Render the game list sidebar.
   * Creates/updates the game-list panel in the DOM.
   */
  function renderGameList() {
    var container = document.getElementById('batch-game-list');
    if (!container) return;

    if (!batchState.active || batchState.games.size === 0) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return;
    }

    container.classList.remove('hidden');

    // Sort: 3 tiers, board number is the tiebreaker within each so the
    // order stays stable.
    //   top    — needs truncation (user must act before reconstruction)
    //   middle — everything in progress or not yet done
    //   bottom — verified / exported (done; pushed out of the way so the
    //            "what's left to work on" list stays compact in big sections)
    var sortedGames = [];
    batchState.games.forEach(function(game) {
      sortedGames.push(game);
    });
    function _sortBucket(g) {
      if (g.status === GAME_STATUS.VERIFIED || g.status === GAME_STATUS.EXPORTED) return 2;
      if (g.hasTrailingNoise) return 0;
      return 1;
    }
    sortedGames.sort(function(a, b) {
      var ba = _sortBucket(a), bb = _sortBucket(b);
      if (ba !== bb) return ba - bb;
      return a.board - b.board;
    });

    // Catch-up promotion: any NEEDS_REVIEW game whose snapshotted workingState
    // shows a fully validated game (no stuck point, every populated cell is
    // ok/fixed/locked, sans non-empty) gets promoted to VERIFIED here. The
    // _saveGameWorkingState path already does this on game-switch, but its
    // (!hasTrailingNoise || noiseResolved) guard kept games stuck at 🟡 when
    // the noise turned out to be benign — every cell still validated. The
    // counter and the ✅/🟡 icon both depend on game.status, so promoting
    // here keeps "X verified" consistent with the per-row "N/N ✓" indicators.
    sortedGames.forEach(function(g) {
      if (g.status !== GAME_STATUS.NEEDS_REVIEW) return;
      var ws = g.workingState;
      if (!ws || !Array.isArray(ws.moves) || ws.moves.length === 0) return;
      if (ws.stuckPly !== null && ws.stuckPly !== undefined) return;
      if (ws.stuckInfo) return;
      if (ws.pendingNoiseReview) return;
      if (!Array.isArray(ws.sans) || ws.sans.length === 0) return;
      var ok = { ok: 1, fixed: 1, locked: 1 };
      var allOk = true;
      for (var _i = 0; _i < ws.moves.length; _i++) {
        var _m = ws.moves[_i];
        if (_m.white && !ok[_m.wStatus]) { allOk = false; break; }
        if (_m.black && !ok[_m.bStatus]) { allOk = false; break; }
      }
      if (!allOk) return;
      g.status = GAME_STATUS.VERIFIED;
      if (g.hasTrailingNoise) g.noiseResolved = true;
      // Clear the same pre-verify staleness markVerified() and the
      // _saveGameWorkingState auto-mark do, plus abort any in-flight
      // orchestrator runs. Without this clear, a game promoted by this
      // catch-up path keeps the algorithm-era "G◐35 B✓ D✓ Tier C" badges
      // alongside its now-✅ status icon — user-reported inconsistency.
      _clearStalenessAndAbort(g);
    });

    // Count statuses
    var verified = 0, ocrDone = 0, total = sortedGames.length;
    sortedGames.forEach(function(g) {
      if (g.status === GAME_STATUS.VERIFIED || g.status === GAME_STATUS.EXPORTED) verified++;
      if (g.status !== GAME_STATUS.QUEUED && g.status !== GAME_STATUS.OCR_RUNNING) ocrDone++;
    });

    // Orchestrator-plan snapshot. Walk the game list once and pick up:
    //   - which game each of the 3 methods is CURRENTLY running on
    //   - how many games have reconstruction pending (RECONSTRUCTING status
    //     on the game record, i.e. OCR is done but no final result yet)
    // The user had to click through every row to figure out where Greedy
    // was; showing this at-a-glance avoids that.
    var runningBy = { greedy: null, beam: null, dijkstra: null };
    var reconstructingCount = 0;
    sortedGames.forEach(function(g) {
      if (g.methodStatus) {
        if (!runningBy.greedy && g.methodStatus.greedy === 'running') runningBy.greedy = g;
        if (!runningBy.beam && g.methodStatus.beam === 'running')       runningBy.beam = g;
        if (!runningBy.dijkstra && g.methodStatus.dijkstra === 'running') runningBy.dijkstra = g;
      }
      if (g.status === GAME_STATUS.RECONSTRUCTING) reconstructingCount++;
    });

    function _esc(s) {
      if (s === null || s === undefined) return '';
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function _gameLabelShort(g) {
      if (!g) return '';
      // Prefer a compact board label — gameDisplayLabel includes file counts
      // that are noisy for a status line. Fall back to gameId.
      if (g.section && g.board != null) return g.section + ' B' + g.board;
      if (g.board != null) return 'B' + g.board;
      return g.gameId || '?';
    }
    function _lookupRoundDate(tData, round) {
      if (!tData || !tData.pairings || round == null) return '';
      var keys = Object.keys(tData.pairings);
      for (var i = 0; i < keys.length; i++) {
        var m = keys[i].match(/_R(\d+)$|R(\d+)$/);
        if (!m) continue;
        if (parseInt(m[1] || m[2]) !== round) continue;
        var list = tData.pairings[keys[i]] || [];
        for (var j = 0; j < list.length; j++) {
          if (list[j].date) return list[j].date;
        }
      }
      return '';
    }

    var html = '';

    // Tournament header — kept visible here because the Batch panel above
    // collapses once processing starts, and the user needs quick access to
    // tournament name + round date while working through the game list.
    var tData = window._batchTournamentData || null;
    if (tData && (tData.event || tData.site || tData.startDate)) {
      var roundDate = _lookupRoundDate(tData, batchState.selectedRound) ||
                      tData.startDate || '';
      var subParts = [];
      if (tData.site) subParts.push(tData.site);
      if (roundDate) subParts.push(roundDate);
      html += '<div class="px-3 py-2 border-b border-gray-700 bg-gray-900/40">';
      if (tData.event) {
        html += '<div class="text-sm font-semibold text-gray-200 truncate" title="' +
                _esc(tData.event) + '">' + _esc(tData.event) + '</div>';
      }
      if (subParts.length > 0) {
        html += '<div class="text-xs text-gray-400 truncate">' +
                _esc(subParts.join(' · ')) + '</div>';
      }
      html += '</div>';
    }

    // Header — round info on the left, round-level export buttons on the
    // right (Round PGN / CSV / Dashboard mirror the Step 4 buttons at the
    // top of the page so they remain reachable while scrolled into review).
    html += '<div class="px-3 py-2 border-b border-gray-700 flex justify-between items-center gap-2">';
    html += '<div class="flex items-baseline gap-2 min-w-0">';
    html += '<span class="text-sm font-semibold text-gray-300 truncate">';
    html += 'Round ' + (batchState.selectedRound || '?');
    if (sortedGames.length > 0 && sortedGames[0].section) {
      html += ' &mdash; ' + sortedGames[0].section;
    }
    html += '</span>';
    html += '<span class="text-xs text-gray-500 shrink-0">' + verified + '/' + total + ' done</span>';
    html += '</div>';
    html += '<div class="flex items-center gap-1 shrink-0">';
    html += '<button id="btn-batch-export-round-list" class="px-2 py-1 bg-indigo-700 hover:bg-indigo-600 rounded text-xs font-medium text-white" ' +
            'title="Concatenate all games in this round into one PGN file">' +
            '&#128229; Round PGN</button>';
    html += '<button id="btn-batch-export-csv-list" class="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-white" ' +
            'title="Save a CSV report of reconstruction diagnostics">CSV</button>';
    html += '<button id="btn-batch-dashboard-list" class="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-white" ' +
            'title="Show compact color-grid dashboard for this round">Dashboard</button>';
    html += '</div>';
    html += '</div>';

    // Orchestrator status strip — one line showing Greedy / Beam / Dijkstra
    // current targets. Clicking a method's target game loads it. Hidden when
    // nothing is running AND nothing is pending (clean tournament view).
    var anyRunning = runningBy.greedy || runningBy.beam || runningBy.dijkstra;
    if (anyRunning || reconstructingCount > 0) {
      html += '<div class="px-3 py-1.5 border-b border-gray-800 flex items-center gap-3 text-xs bg-gray-900/70">';
      ['greedy', 'beam', 'dijkstra'].forEach(function(m, i) {
        var theme = _METHOD_THEME[m];
        var letter = _METHOD_LETTER[m];
        var target = runningBy[m];
        if (i > 0) html += '<span class="text-gray-700">|</span>';
        if (target) {
          html += '<button data-jump-game="' + _esc(target.gameId) + '" ' +
                  'class="' + theme.cssClass + ' hover:underline cursor-pointer" ' +
                  'title="Jump to ' + _esc(target.gameId) + ' ' +
                  '(' + theme.label + ' running)">' +
                  letter + ' \u21BB <span class="font-mono">' +
                  _esc(_gameLabelShort(target)) + '</span></button>';
        } else {
          html += '<span class="text-gray-500">' + letter + ' \u00B7 <span class="italic">idle</span></span>';
        }
      });
      if (reconstructingCount > 0) {
        html += '<span class="text-gray-400 ml-auto" title="Games with reconstruction still pending">' +
                reconstructingCount + ' pending</span>';
      }
      html += '</div>';
    }

    // Active sheet-profile layout signature — games whose cached OCR was
    // produced under a different layout get a per-game re-OCR badge (mixed
    // 2col/3col rounds). Computed once per render.
    var curLayoutSig = (window.BatchOcrQueue && window.BatchOcrQueue.currentLayoutSignature)
      ? window.BatchOcrQueue.currentLayoutSignature() : null;

    // Game entries
    sortedGames.forEach(function(game) {
      var statusInfo = STATUS_DISPLAY[game.status] || STATUS_DISPLAY[GAME_STATUS.QUEUED];
      var isActive = game.gameId === batchState.currentGameId;
      var isClickable = game.status !== GAME_STATUS.QUEUED &&
                        game.status !== GAME_STATUS.OCR_RUNNING;

      var classes = 'px-3 py-2 flex items-center gap-2 text-sm border-b border-gray-800';
      // Method-running accent: thin left border in the method's theme
      // colour so the user can eyeball which row Greedy (green) / Beam
      // (cyan) / Dijkstra (purple) is grinding away on, without reading
      // the G/B/D glyphs on each row. Active selection still wins — the
      // user's own focus gets the full blue highlight. We only draw the
      // accent for a method in 'running' state; 'queued' games get no
      // accent (they're not currently chewing CPU).
      var activeMethod = game.methodStatus && _activeMethodTheme(game.methodStatus);
      var isActuallyRunning = activeMethod && activeMethod.state === 'running';
      if (isActive) {
        classes += ' bg-blue-900/40 border-l-2 border-l-blue-400';
      } else if (isActuallyRunning) {
        classes += ' bg-gray-800/40 border-l-2 ';
        // Tailwind needs the full class name at build-time; inline the
        // three possibilities rather than synthesizing the string.
        var methodCss = activeMethod.theme.cssClass;
        if (methodCss.indexOf('green') >= 0) classes += 'border-l-green-500/80';
        else if (methodCss.indexOf('cyan') >= 0) classes += 'border-l-cyan-500/80';
        else if (methodCss.indexOf('purple') >= 0) classes += 'border-l-purple-500/80';
        else classes += 'border-l-blue-500/80';
        if (isClickable) classes += ' hover:bg-gray-800/60 cursor-pointer';
      } else if (isClickable) {
        classes += ' hover:bg-gray-800/50 cursor-pointer';
      } else {
        classes += ' opacity-60';
      }

      html += '<div class="' + classes + '" data-game-id="' + game.gameId + '">';
      // Status icon — for RECONSTRUCTING, override color + tooltip to surface
      // which method is currently running OR queued (the two states produce
      // different labels so the user can tell apart "actually running on
      // this game" from "waiting its turn").
      var iconCls = statusInfo.cssClass;
      var iconLabel = statusInfo.label;
      if (game.status === GAME_STATUS.RECONSTRUCTING && game.methodStatus) {
        var active = _activeMethodTheme(game.methodStatus);
        if (active) {
          if (active.state === 'running') {
            iconCls = active.theme.cssClass + ' animate-pulse';
            iconLabel = 'Reconstructing: ' + active.theme.label;
          } else {
            // queued — colour the icon in the theme but without the pulse,
            // and a different label. Games stacked up behind a running
            // Dijkstra shouldn't all say "Reconstructing".
            iconCls = active.theme.cssClass + '/70';
            iconLabel = 'Queued for ' + active.theme.label;
          }
        }
      }
      html += '<span class="' + iconCls + '" title="' + iconLabel + '">' + statusInfo.icon + '</span>';
      // Dedicated noise marker — survives status changes from selectGame
      // (which flips to IN_REVIEW / NEEDS_REVIEW), so the user doesn't lose
      // track of which games still need truncation when they click around.
      // Suppress when the status icon IS already the scissors (status ===
      // NEEDS_TRUNCATION), otherwise we render two scissors side by side.
      //   Needs truncation  → status icon covers it (skip dedicated marker).
      //   Other status but still noisy → orange pulsing scissors.
      //   Resolved          → green crossed-out scissors (done — historical).
      if (game.hasTrailingNoise && !game.noiseResolved &&
          game.status !== GAME_STATUS.NEEDS_TRUNCATION) {
        html += '<span class="text-orange-400 animate-pulse" title="Trailing-cell noise — truncate before reconstructing">\u2702\uFE0F</span>';
      } else if (game.noiseResolved) {
        html += '<span class="text-green-400 line-through" title="Trailing noise truncated">\u2702\uFE0F</span>';
      }
      html += '<span class="flex-1 truncate">';
      html += window.BatchNaming.gameDisplayLabel(game, game.pairing);
      // Inline OCR progress while the per-image OCR queue is chewing on
      // this game. Similar to the single-game in-line progress the user
      // is used to seeing; just smaller to fit a row. Cleared by
      // onGameComplete.
      if (game.ocrProgress) {
        html += ' <span class="text-xs text-blue-300">\u2014 ' +
                _esc(game.ocrProgress) + '</span>';
      }
      html += '</span>';
      // Phase 2: per-method status (greedy/beam/dijkstra) — compact indicator
      // shows G/B/D with a glyph for each method's state (solved/failed/
      // running/queued/idle). Useful during auto-escalation so the user can
      // see "Greedy failed, Beam is running now" at a glance.
      if (game.methodStatus) {
        var recResults = (batchState.reconstructResults[game.gameId] &&
                          batchState.reconstructResults[game.gameId].results) || null;
        html += _renderMethodStatus(game.methodStatus, recResults);
      }
      // Phase 2: tier badge (Tier A/B/C from triage)
      if (game.tier && window.BatchTriage && window.BatchTriage.TIER_DISPLAY[game.tier]) {
        var td = window.BatchTriage.TIER_DISPLAY[game.tier];
        var tierTitle = td.label +
          (game.triageDetails && game.triageDetails.totalFixes != null
            ? ' \u2014 ' + game.triageDetails.totalFixes + ' fix(es)'
            : '');
        html += '<span class="text-[10px] px-1.5 py-0.5 rounded ' + td.badgeClass +
                '" title="' + tierTitle + '">Tier ' + game.tier + '</span>';
      }
      // NW auto-apply badge — gear + count for games where the queue
      // auto-applied high-anchor alignment edits before reconstruction.
      // Click opens the review modal (BatchAutoApplyReview) where the user
      // can revert entries.
      var ocrRes = batchState.ocrResults[game.gameId];
      var autoCount = (ocrRes && ocrRes.nwAutoApplies) ? ocrRes.nwAutoApplies.length : 0;
      if (autoCount > 0) {
        html += '<button data-autoapply-review="' + game.gameId + '" ' +
                'class="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/60 hover:bg-purple-800 text-purple-200 cursor-pointer"' +
                ' title="' + autoCount + ' NW correction(s) auto-applied \u2014 click to review / revert">' +
                '\u2699\uFE0F ' + autoCount + '</button>';
      }
      // Per-game re-OCR badge: shown only when this game's cached OCR layout
      // differs from the active sheet profile (e.g. game OCR'd as 2col×20 but
      // the user has since switched to 3col×20). Click re-OCRs THIS game at the
      // active layout — non-destructive to every other game. See
      // reOcrGameAtCurrentLayout.
      // Suppressed on VERIFIED/EXPORTED games: in a mixed round a finished 2col
      // game legitimately differs from a 3col active profile, and re-OCR would
      // discard its verification — don't nag (or risk) completed work. Also
      // suppressed mid-OCR / pre-OCR (nothing to compare yet).
      var _reocrEligible = game.status !== GAME_STATUS.QUEUED &&
                           game.status !== GAME_STATUS.OCR_RUNNING &&
                           game.status !== GAME_STATUS.VERIFIED &&
                           game.status !== GAME_STATUS.EXPORTED;
      if (curLayoutSig && game.cachedLayout && game.cachedLayout !== curLayoutSig &&
          _reocrEligible) {
        var reocrTitle = 'OCR\'d as ' + game.cachedLayout + '; active profile is ' +
          curLayoutSig + ' — click to re-OCR this game at ' + curLayoutSig +
          ' (other games untouched)';
        html += '<button data-reocr-layout="' + game.gameId + '" ' +
                'class="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/60 hover:bg-amber-800 text-amber-200 cursor-pointer" ' +
                'title="' + _esc(reocrTitle) + '">↻ ' +
                _esc(_shortLayout(game.cachedLayout)) + '→' +
                _esc(_shortLayout(curLayoutSig)) + '</button>';
      }
      var lenLabel = _gameLengthIndicator(game);
      if (lenLabel) {
        html += '<span class="text-xs ' + lenLabel.cls +
                '" title="' + _esc(lenLabel.tooltip) + '">' +
                _esc(lenLabel.text) + '</span>';
      }
      html += '</div>';
    });

    // Action bar (visible when a game is loaded for review)
    if (batchState.currentGameId) {
      var curGame = batchState.games.get(batchState.currentGameId);
      var isVerified = curGame && (curGame.status === GAME_STATUS.VERIFIED || curGame.status === GAME_STATUS.EXPORTED);
      var readyToSave = isVerified || _isCurrentGameReadyToSave();
      html += '<div class="px-3 py-2 border-t border-gray-700 flex gap-2">';
      var prevId = _findPrevGame(sortedGames);
      if (prevId) {
        html += '<button id="btn-batch-prev" class="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs text-white" title="Previous unreviewed game">&#9664; Prev</button>';
      }
      var saveTitle;
      if (isVerified) {
        saveTitle = 'This game\'s PGN is already saved';
      } else if (readyToSave) {
        saveTitle = 'Save this game as a PGN file (use Round Export from the dashboard for a combined multi-game PGN)';
      } else {
        saveTitle = 'Save partial PGN — incomplete reconstruction; result=*, for manual completion later';
      }
      var saveCls = readyToSave
        ? 'flex-1 px-2 py-1.5 bg-green-700 hover:bg-green-600 rounded text-xs font-medium text-white'
        : 'flex-1 px-2 py-1.5 bg-yellow-700 hover:bg-yellow-600 rounded text-xs font-medium text-white';
      html += '<button id="btn-batch-save-pgn" class="' + saveCls + '" title="' +
              _esc(saveTitle) + '">';
      html += isVerified ? '&#10003; Saved' : '&#128190; Save PGN';
      html += '</button>';
      // Reset button — clears all user fixes/confirmations on the current
      // game and re-runs reconstruction from the pristine OCR. There's no
      // undo on individual confirmations, so this is the escape hatch for
      // "I want to start over."
      html += '<button id="btn-batch-reset-game" class="px-2 py-1.5 bg-gray-700 hover:bg-red-900 rounded text-xs text-white" ' +
              'title="Discard all fixes/confirmations on this game and re-run reconstruction from the original OCR (no undo)">' +
              '↺ Reset</button>';
      // Find next unreviewed game
      var nextId = _findNextGame(sortedGames);
      if (nextId) {
        html += '<button id="btn-batch-next" class="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs text-white" title="Next unreviewed game">Next &#9654;</button>';
      }
      html += '</div>';
    }

    // Progress bar — stacked: green = verified games, blue = OCR done but
    // not yet verified, gray = queued / OCR running. Lets the user see at
    // a glance how much of the round is finished vs. still-to-review.
    html += '<div class="px-3 py-2 border-t border-gray-700">';
    var verifiedPct = total > 0 ? (verified / total) * 100 : 0;
    var pendingPct = total > 0 ? Math.max(0, ocrDone - verified) / total * 100 : 0;
    html += '<div class="w-full bg-gray-700 rounded-full h-1.5 flex overflow-hidden">';
    html += '<div class="bg-green-500 h-full transition-all" style="width: ' + verifiedPct.toFixed(2) + '%"></div>';
    html += '<div class="bg-blue-500 h-full transition-all" style="width: ' + pendingPct.toFixed(2) + '%"></div>';
    html += '</div>';
    html += '<div class="text-xs text-gray-500 mt-1">' +
            '<span class="text-green-400">' + verified + ' verified</span>' +
            ' · ' + ocrDone + '/' + total + ' OCR done' +
            '</div>';
    html += '</div>';

    container.innerHTML = html;

    // Attach click handlers
    var entries = container.querySelectorAll('[data-game-id]');
    entries.forEach(function(el) {
      el.addEventListener('click', function() {
        var gid = el.getAttribute('data-game-id');
        selectGame(gid);
      });
    });

    // Auto-apply review badges — stop propagation so the row click
    // doesn't ALSO fire and reload the game. Clicking the badge only
    // opens the review modal; the game load is a separate explicit action.
    container.querySelectorAll('button[data-autoapply-review]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var gid = btn.getAttribute('data-autoapply-review');
        if (window.BatchAutoApplyReview) {
          window.BatchAutoApplyReview.openReviewModal(gid);
        }
      });
    });

    // Orchestrator status-strip "jump to running game" shortcuts.
    container.querySelectorAll('button[data-jump-game]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var gid = btn.getAttribute('data-jump-game');
        if (gid) selectGame(gid);
      });
    });

    // Per-game re-OCR badges — stop propagation so the row click doesn't ALSO
    // fire and load the game; the re-OCR is a deliberate, isolated action.
    container.querySelectorAll('button[data-reocr-layout]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var gid = btn.getAttribute('data-reocr-layout');
        if (gid) reOcrGameAtCurrentLayout(gid);
      });
    });

    // Save PGN button
    var btnSave = document.getElementById('btn-batch-save-pgn');
    if (btnSave) {
      btnSave.onclick = function() { saveBatchGamePgn(); };
    }

    // Prev game button (mirror of Next)
    var btnPrev = document.getElementById('btn-batch-prev');
    if (btnPrev) {
      btnPrev.onclick = function() {
        var prev = _findPrevGame(sortedGames);
        if (prev) selectGame(prev);
      };
    }

    // Next game button
    var btnNext = document.getElementById('btn-batch-next');
    if (btnNext) {
      btnNext.onclick = function() {
        var next = _findNextGame(sortedGames);
        if (next) selectGame(next);
      };
    }

    // Reset current game — re-run reconstruction from pristine OCR.
    var btnReset = document.getElementById('btn-batch-reset-game');
    if (btnReset) {
      btnReset.onclick = function() {
        var gid = batchState.currentGameId;
        if (!gid) return;
        var ok = window.confirm(
          'Reset this game?\n\n' +
          'All your fixes and confirmations on ' + gid + ' will be discarded ' +
          'and reconstruction will re-run from the original OCR.\n\n' +
          'This cannot be undone.'
        );
        if (!ok) return;
        resetCurrentGame();
      };
    }

    // Round-level export buttons in the game list footer — delegate to the
    // top-of-page handlers so we don't duplicate the export logic.
    var btnExportRoundList = document.getElementById('btn-batch-export-round-list');
    if (btnExportRoundList) {
      btnExportRoundList.onclick = function() {
        var src = document.getElementById('btn-batch-export-round');
        if (src) src.click();
      };
    }
    var btnExportCsvList = document.getElementById('btn-batch-export-csv-list');
    if (btnExportCsvList) {
      btnExportCsvList.onclick = function() {
        var src = document.getElementById('btn-batch-export-csv');
        if (src) src.click();
      };
    }
    var btnDashboardList = document.getElementById('btn-batch-dashboard-list');
    if (btnDashboardList) {
      btnDashboardList.onclick = function() {
        var src = document.getElementById('btn-batch-dashboard');
        if (src) src.click();
      };
    }

    // Keep dashboard in sync when it's open.
    if (window.BatchDashboard && typeof window.BatchDashboard.refreshIfOpen === 'function') {
      window.BatchDashboard.refreshIfOpen();
    }

    // Refresh the persistent "Next ready" nav in the fix panel. renderGameList
    // is the central re-render that fires on every orchestrator progress/
    // complete event, so this is what lets the button light up (and its count
    // tick up) as background reconstructions finish — in both review and
    // interactive modes.
    renderNextReadyNav();
  }

  // =========================================================================
  // Persistent "Next ready" nav (#batch-next-ready-nav in the fix panel)
  // =========================================================================
  // Lives in its own container beside #fix-panel-title (not inside it), so it
  // survives both the interactive title and the review header without being
  // clobbered when either repaints. Right-aligned by the flex row in
  // index.html — "Next" on the right = moving forward to the next game.

  function renderNextReadyNav() {
    var el = document.getElementById('batch-next-ready-nav');
    if (!el) return;

    // Only relevant once a batch game is actually loaded in the panel.
    if (!batchState.active || !batchState.currentGameId) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');

    var n = countReviewableGames();
    var disabled = n <= 0;
    // Peek at what the next jump would land on so the button signals it. A
    // truncation target gets a scissors (it's a different action than review)
    // and an amber tint matching the game list's NEEDS_TRUNCATION accent.
    var nextId = disabled ? null : _findNextReviewable(batchState.currentGameId);
    var nextGame = nextId ? batchState.games.get(nextId) : null;
    var nextIsTrunc = !!(nextGame && _needsTruncation(nextGame));

    var cls = 'text-xs px-2 py-0.5 rounded ' +
      (disabled
        ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
        : nextIsTrunc
          ? 'bg-amber-700 hover:bg-amber-600 text-white'
          : 'bg-blue-700 hover:bg-blue-600 text-white');
    var title = disabled
      ? 'No other game needs attention yet'
      : nextIsTrunc
        ? 'Go to the next game that needs trailing-noise truncation'
        : 'Go to the next game whose reconstruction is ready for review';
    var label = disabled
      ? 'Next ready →'
      : (nextIsTrunc ? '✂️ Next' : 'Next ready') + ' (' + n + ') →';

    var btn = document.getElementById('btn-next-ready');
    if (!btn) {
      el.innerHTML = '<button id="btn-next-ready"></button>';
      btn = document.getElementById('btn-next-ready');
      btn.onclick = function() {
        if (btn.disabled) return;
        gotoNextReviewable();
      };
    }
    btn.disabled = disabled;
    btn.className = cls;
    btn.title = title;
    btn.textContent = label;
  }

  /**
   * Render the round selector dropdown.
   * @param {HTMLElement} selectEl - The <select> element
   */
  function renderRoundSelector(selectEl) {
    if (!selectEl) return;

    selectEl.innerHTML = '<option value="">-- Select Round --</option>';
    batchState.availableRounds.forEach(function(r) {
      var opt = document.createElement('option');
      opt.value = r.round;
      opt.textContent = 'Round ' + r.round + ' (' + r.gameCount + ' game' +
                        (r.gameCount !== 1 ? 's' : '') + ')';
      selectEl.appendChild(opt);
    });
  }

  /**
   * Render the section selector dropdown. Includes only named sections
   * (skips the empty-string entry that arises when some scans lack any
   * section classification). Caller decides whether to show or hide the
   * element based on whether multiple sections were discovered.
   * @param {HTMLElement} selectEl
   */
  function renderSectionSelector(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    (batchState.availableSections || []).forEach(function(s) {
      if (!s.section) return;
      var opt = document.createElement('option');
      opt.value = s.section;
      opt.textContent = s.section + ' (' + s.gameCount + ' game' +
                        (s.gameCount !== 1 ? 's' : '') + ')';
      selectEl.appendChild(opt);
    });
  }

  // =========================================================================
  // Requeue-after-fix hook
  // =========================================================================
  // When the user applies a manual fix in the interactive review UI
  // (fixes.js::applyFix → revalidate) on a batch game, the algorithm
  // results in the side panels (Greedy/Beam/Dijkstra) are now stale —
  // they were computed against the pre-fix OCR. The orchestrator's
  // .requeue() path exists (verification-ui.js uses it during 3-panel
  // overrides) but nothing called it from the interactive flow. Now
  // applyFix calls this helper, which rebuilds merged OCR from the
  // current state.moves (includes the just-applied fix) and asks the
  // orchestrator to restart Greedy from confirmedPly. Beam/Dijkstra
  // in-flight work gets aborted; escalation runs fresh if Greedy fails
  // on the corrected input.

  // Build the requeue input from the PRISTINE OCR + the user's
  // confirmations as overrides. Using state.moves directly was wrong:
  // after the user had been through verification mode, state.moves[i]
  // carried the ALGORITHM's chosen SAN at every algo-proposed ply (not
  // the raw OCR), so a requeue fed Greedy's own previous output back
  // into it. On a complex game that cascade pushed Greedy off the
  // successful path — the initial 35-fix SOLVED result became an
  // UNSOLVABLE 27-fix FAILED when re-run, because alternatives no
  // longer contained the moves Greedy originally needed.
  //
  // New flow:
  //   1. Start from batchState.ocrResults[gameId] — the untouched OCR
  //      captured at OCR-queue time. For dual-sheet, merge fresh via
  //      MergeSheets.mergeSheets; for single-sheet, use ocrCells.
  //   2. For every ply in state.moves with wStatus / bStatus = 'fixed'
  //      or 'locked' (user-confirmed), splice that cell with move =
  //      user's SAN, confidence = 1.0, alternatives = []. These go into
  //      lockedPlies so Greedy never overrides them.
  //   3. Everything else stays as the original OCR: top candidate + full
  //      alternatives list, unchanged. Greedy re-explores with the same
  //      ranking / search space it had originally.
  function _buildOcrMovesFromState() {
    if (typeof state === 'undefined' || !state.moves) return null;
    var gameId = batchState.currentGameId;
    var ocrResult = gameId ? batchState.ocrResults[gameId] : null;
    if (!ocrResult) return null;

    // Get the merged baseline.
    //
    // Dual-sheet: merge fresh from state.ocrCellsSheet1 / state.ocrCellsSheet2.
    // These are the LIVE per-sheet arrays — they reflect any NW alignment
    // changes (gap-insert, duplicate-delete, backfill from the other sheet)
    // the user has applied. batchState.ocrResults[gameId].sheet1/.sheet2 is
    // the pristine pre-NW snapshot captured at OCR-queue time and does NOT
    // see those structural edits. Using the pristine arrays here would feed
    // Greedy a sequence whose ply count and content disagree with what's
    // actually in state.moves: post-NW state.moves[43] (44.W after a 4-ply
    // insert at 43.B) is a backfilled placeholder valued 'Ra6' from Black,
    // but pristine pre-NW White's row 44.W is a different cell entirely
    // ('a5' shifted up after a duplicate-delete). The result is Greedy
    // proposes fixes for plies that already match what's in the move list.
    //
    // Per-sheet cells preserve raw OCR in .move (syncCorrectionsToOcrCells
    // writes corrections to _correctedMove, not .move, when preserveMove is
    // true), so re-merging from state.ocrCellsSheet1/2 still gives a clean
    // baseline — it doesn't bleed algorithm corrections back into Greedy's
    // input. The user's confirmed fixes get spliced on top below; that's
    // the only path SANs from state.moves enter the requeue baseline.
    //
    // Single-sheet: stick with ocrResult.ocrCells, since state.ocrCells
    // (preserveMove=false) DOES carry algorithm corrections in .move and
    // would feed Greedy's own previous output back to it. Single-sheet
    // doesn't have NW alignment edits anyway.
    var merged;
    if (ocrResult.isDualSheet && window.MergeSheets &&
        typeof window.MergeSheets.mergeSheets === 'function') {
      var _s1 = (state.ocrCellsSheet1 && state.ocrCellsSheet1.length > 0)
        ? state.ocrCellsSheet1 : (ocrResult.sheet1 || []);
      var _s2 = (state.ocrCellsSheet2 && state.ocrCellsSheet2.length > 0)
        ? state.ocrCellsSheet2 : (ocrResult.sheet2 || []);
      merged = window.MergeSheets.mergeSheets(_s1, _s2) || [];
    } else if (ocrResult.ocrCells) {
      merged = ocrResult.ocrCells.slice();
    } else {
      return null;
    }

    // Index the merge by (num, color) so we can splice in overrides.
    // mergeSheets produces one cell per ply with num + color fields.
    function _idxOf(num, color) {
      for (var i = 0; i < merged.length; i++) {
        var c = merged[i];
        var ccol = (c.color || '').toLowerCase();
        if (c.num === num && ccol === color) return i;
      }
      return -1;
    }

    // Splice two classes of cells:
    //   (a) user-confirmed (wStatus='fixed' / 'locked') — also locks the ply
    //   (b) algorithm-proposed but not explicitly confirmed (wAlgoProposed=true
    //       with a SAN that differs from the original OCR) — the user walked
    //       past without hitting Confirm but those moves are what the current
    //       state.moves + stuck-point analysis is built on, so a requeue
    //       must carry them or Greedy will re-stuck at the first algo fix.
    // Before adding (b), an interactive-mode manual fix after Greedy review
    // was resetting the algo-accepted plies to raw OCR in the requeue
    // baseline; Greedy then re-stuck at the first algo fix (user reported:
    // confirmed 24.W via Greedy review, manually fixed 25.W, Greedy came
    // back stuck at 24.W).
    var lockedPlies = [];
    var _diagSpliced = 0, _diagMissed = 0;
    state.moves.forEach(function(m) {
      var wConfirmed = m.white && (m.wStatus === 'fixed' || m.wStatus === 'locked');
      var bConfirmed = m.black && (m.bStatus === 'fixed' || m.bStatus === 'locked');
      // Splice any cell whose current SAN differs from the original OCR,
      // regardless of HOW it got there. wAlgoProposed catches algorithm
      // review picks; wOriginal (without wAlgoProposed) catches
      // validate_moves Layer-1 auto-corrections (similarity swaps, OCR
      // alternatives) — those produced the right SAN but did not flip
      // wStatus to 'fixed', so the narrower condition was missing them.
      // Without this, an auto-corrected cell at 24.W kept its raw
      // pristine OCR in the merged baseline, Greedy played that and
      // predictably stuck at 24.W on rerun.
      var wCorrected = m.white && m.wOriginal && m.white !== m.wOriginal;
      var bCorrected = m.black && m.bOriginal && m.black !== m.bOriginal;
      // Edge case (rare but real): algorithm review proposed a fix whose SAN
      // happens to equal wOriginal — wCorrected is false, but wAlgoProposed
      // still flags this as algorithm-confirmed and we must splice it. Without
      // the OR, an algo "Confirm: keep OCR" pick fell back to raw OCR with
      // alternatives intact, so Greedy could re-propose a different fix at
      // the same ply on requeue.
      var wAlgo = wCorrected || !!m.wAlgoProposed;
      var bAlgo = bCorrected || !!m.bAlgoProposed;

      if (wConfirmed || wAlgo) {
        var wi = _idxOf(m.num, 'w');
        if (wi >= 0) {
          merged[wi] = Object.assign({}, merged[wi], {
            move: m.white, confidence: 1.0, alternatives: []
          });
          if (wConfirmed) lockedPlies.push((m.num - 1) * 2);
          _diagSpliced++;
        } else {
          _diagMissed++;
        }
      }
      if (bConfirmed || bAlgo) {
        var bi = _idxOf(m.num, 'b');
        if (bi >= 0) {
          merged[bi] = Object.assign({}, merged[bi], {
            move: m.black, confidence: 1.0, alternatives: []
          });
          if (bConfirmed) lockedPlies.push((m.num - 1) * 2 + 1);
          _diagSpliced++;
        } else {
          _diagMissed++;
        }
      }
    });
    if (typeof log === 'function' && (_diagSpliced > 0 || _diagMissed > 0)) {
      log('  🔨 [' + (batchState.currentGameId || '?') +
          '] interactive requeue baseline: ' + _diagSpliced +
          ' confirmed/algo fix(es) spliced' +
          (_diagMissed > 0 ? ' (' + _diagMissed + ' missed)' : '') +
          ', ' + lockedPlies.length + ' locked');
    } else if (typeof log === 'function') {
      // Log the NO-OP case too so we can tell when a requeue fires against
      // a game whose state.moves carries zero user-acceptable cells.
      log('  🔨 [' + (batchState.currentGameId || '?') +
          '] interactive requeue baseline: NOTHING spliced (no confirmed / no algo-proposed in state.moves — merged OCR is raw)');
    }

    return { cells: merged, lockedPlies: lockedPlies };
  }

  // Debounce window. A user applying a burst of fixes (e.g. walking
  // through 5 quick fixes in the fix panel in ~3 seconds) would otherwise
  // fire 5 requeues in a row — each one aborting the last before it had
  // a chance to run. With the debounce, the 5 calls collapse into one
  // requeue that fires once the burst settles.
  //
  // 1500ms is short enough to feel responsive (the orchestrator starts
  // chewing on the final state almost immediately after the user's last
  // click) and long enough to swallow typical rapid-fire clicks.
  var REQUEUE_DEBOUNCE_MS = 1500;
  var _requeueTimer = null;
  var _requeuePendingForGame = null;

  function _doRequeueNow(gameId) {
    if (!batchState.active || batchState.currentGameId !== gameId) {
      // User switched games during the debounce window; drop the requeue.
      // Whatever the user cares about is in the NEW current game, not this
      // one. The algorithm results on this game are already as stale as
      // they're going to get.
      return;
    }
    // Don't requeue a completed game. onCurrentGameFunctionallyComplete
    // cancels the debounce timer, but a concurrent applyFix → requeueAfterFix
    // call that races the completion can still land here. Guard defensively.
    var _gChk = batchState.games.get(gameId);
    if (_gChk && (_gChk.status === GAME_STATUS.VERIFIED ||
                  _gChk.status === GAME_STATUS.EXPORTED)) {
      if (typeof log === 'function') {
        log('🔄 requeue skipped — ' + gameId + ' already VERIFIED/EXPORTED');
      }
      return;
    }
    var rq = batchState.reconstructQueue;
    if (!rq || typeof rq.requeue !== 'function') return;
    var built = _buildOcrMovesFromState();
    if (!built || !built.cells || built.cells.length === 0) return;
    // Combine locks from the helper (user-confirmed plies lifted into
    // locked status) with any pre-existing state.lockedPlies
    // (e.g. merge-locked tier-1 agreement plies).
    var lockedPlies = built.lockedPlies.slice();
    (state.lockedPlies || []).forEach(function(p) {
      if (lockedPlies.indexOf(p) === -1) lockedPlies.push(p);
    });
    var fromPly = state.confirmedPly || 0;
    if (typeof log === 'function') {
      log('🔄 Re-queuing ' + gameId + ' for reconstruction after manual fix ' +
          '(from ply ' + fromPly + ', ' + built.cells.length + ' cells, ' +
          lockedPlies.length + ' locked — pristine OCR baseline)');
    }
    try {
      rq.requeue(gameId, built.cells, lockedPlies, fromPly);
    } catch (e) {
      console.warn('[Batch] requeue after fix failed:', e);
    }
  }

  function requeueAfterFix() {
    if (!batchState.active || !batchState.currentGameId) return;
    var rq = batchState.reconstructQueue;
    if (!rq || typeof rq.requeue !== 'function') return;
    var gameId = batchState.currentGameId;

    // Reset the debounce timer on every new fix so a quick burst of
    // fixes collapses into a single requeue after the burst settles.
    if (_requeueTimer) clearTimeout(_requeueTimer);
    _requeuePendingForGame = gameId;
    _requeueTimer = setTimeout(function() {
      _requeueTimer = null;
      _requeuePendingForGame = null;
      _doRequeueNow(gameId);
    }, REQUEUE_DEBOUNCE_MS);
  }

  /**
   * Immediate (non-debounced) orchestrator-level rerun of the current game.
   *
   * Used by beam.js's "Rerun All Algorithms" button. Without this, clicking
   * Rerun All fired window.searchManager.launchSearches which runs the three
   * algorithms locally but leaves the orchestrator's aggregate stale — the
   * game list keeps showing the old methodStatus / tier / picked, and the
   * onGameReset + panel bridge flow never engages. Going through the
   * orchestrator means:
   *   - panels clear via onGameReset
   *   - methodStatus resets to queued/idle/idle and row indicator updates
   *   - any in-flight Beam/Dijkstra work for this game gets aborted
   *   - escalation chain restarts cleanly
   * Bypasses the 1.5s debounce because the user just clicked an explicit
   * rerun button, not burst-applied fixes.
   */
  function rerunCurrentGame() {
    if (!batchState.active || !batchState.currentGameId) return false;
    var rq = batchState.reconstructQueue;
    if (!rq || typeof rq.requeue !== 'function') return false;
    if (_requeueTimer) {
      clearTimeout(_requeueTimer);
      _requeueTimer = null;
      _requeuePendingForGame = null;
    }
    _doRequeueNow(batchState.currentGameId);
    return true;
  }

  /**
   * Reset the current game — discard all user fixes/confirmations, drop the
   * snapshotted workingState, clear the orchestrator's cached aggregate, and
   * re-run reconstruction against the pristine OCR captured at OCR-queue
   * time. The pristine snapshot lives in batchState.ocrResults[gameId].
   *
   * Distinct from rerunCurrentGame, which preserves user fixes by going
   * through _buildOcrMovesFromState (splicing them back as locks).
   *
   * Side effects:
   *   - game.workingState = null  (no overlay on next selectGame)
   *   - game.status drops out of VERIFIED/EXPORTED  (counter decrements)
   *   - game.methodStatus / tier / triage* / reconstructPicked cleared
   *   - hasTrailingNoise stays as-is; noiseResolved cleared so the user
   *     re-confirms truncation if the original OCR was flagged
   *   - batchState.reconstructResults[gameId] deleted
   *   - reconstructQueue.requeue called with pristine merged OCR, no locks
   *   - selectGame reloads the UI with a clean slate
   */
  function resetCurrentGame() {
    if (!batchState.active || !batchState.currentGameId) return false;
    var gameId = batchState.currentGameId;
    var ocrResult = batchState.ocrResults[gameId];
    if (!ocrResult) {
      if (typeof log === 'function') {
        log('Cannot reset ' + gameId + ': no pristine OCR snapshot available');
      }
      return false;
    }

    // Build the pristine merged baseline. Same shape as _buildOcrMovesFromState
    // but WITHOUT the user-fix splice loop — that's the whole point of reset.
    // Use the ocrResult.sheet1/sheet2 (pre-NW snapshot) rather than the live
    // state.ocrCellsSheet1/2, because state per-sheet arrays carry NW edits
    // (gap-insert, duplicate-delete) the user may have applied; reset means
    // start from the truly-original OCR.
    var merged;
    if (ocrResult.isDualSheet && window.MergeSheets &&
        typeof window.MergeSheets.mergeSheets === 'function') {
      merged = window.MergeSheets.mergeSheets(
        ocrResult.sheet1 || [], ocrResult.sheet2 || []) || [];
    } else if (ocrResult.ocrCells) {
      merged = ocrResult.ocrCells.slice();
    } else {
      if (typeof log === 'function') {
        log('Cannot reset ' + gameId + ': pristine OCR snapshot has no cells');
      }
      return false;
    }
    if (merged.length === 0) {
      if (typeof log === 'function') {
        log('Cannot reset ' + gameId + ': merged baseline is empty');
      }
      return false;
    }

    // Cancel any pending debounced requeue — it would race with us.
    if (_requeueTimer) {
      clearTimeout(_requeueTimer);
      _requeueTimer = null;
      _requeuePendingForGame = null;
    }

    // Drop the per-game working-state overlay so _restoreGameWorkingState
    // is a no-op on the upcoming selectGame call. Without this, the user's
    // fix statuses, confirmedPly, etc. would re-overlay on top of the fresh
    // processAllSheets output and the reset would be invisible.
    var game = batchState.games.get(gameId);
    if (game) {
      game.workingState = null;
      game.tier = null;
      game.triageReason = null;
      game.triageDetails = null;
      game.reconstructPicked = null;
      game.methodStatus = { greedy: 'queued', beam: 'idle', dijkstra: 'idle' };
      // Re-flag noise for review if the original OCR carried trailing noise.
      // The user gets to re-confirm truncation rather than inheriting the
      // last session's decision. hasTrailingNoise itself reflects the OCR
      // and stays as-is.
      if (game.hasTrailingNoise) {
        game.noiseResolved = false;
        game.status = GAME_STATUS.NEEDS_TRUNCATION;
      } else {
        game.status = GAME_STATUS.RECONSTRUCTING;
      }
    }

    // Clear the orchestrator's aggregate so the panels re-bind clean.
    delete batchState.reconstructResults[gameId];

    if (typeof log === 'function') {
      log('↺ Reset ' + gameId + ' — ' +
          (game && game.hasTrailingNoise
            ? 're-running noise review (reconstruction blocked until user truncates)'
            : 're-running reconstruction from ' + merged.length + ' pristine OCR cells'));
    }

    // Kick off fresh reconstruction — but ONLY for non-noisy games. Mirrors
    // the OCR-complete path (queue.onGameComplete) which short-circuits on
    // isNoisy and waits for onTruncationComplete to enqueue. Reconstructing
    // on un-truncated input would burn cycles on garbage and produce the
    // same FAILED Tier-C result the original guard avoids.
    if (!(game && game.hasTrailingNoise)) {
      var rq = batchState.reconstructQueue;
      if (rq && typeof rq.requeue === 'function') {
        try {
          rq.requeue(gameId, merged, [], 0);
        } catch (e) {
          console.warn('[Batch] reset requeue failed:', e);
        }
      }
    }

    // Reload the game so processAllSheets re-builds state.moves from the
    // pristine OCR. workingState is null, so the restore step is skipped
    // and the user sees a clean review surface. selectGame is async but we
    // don't need to await — the orchestrator and UI both run independently.
    selectGame(gameId);
    return true;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    GAME_STATUS: GAME_STATUS,
    batchState: batchState,
    initFromFolder: initFromFolder,
    initFromFiles: initFromFiles,
    selectRound: selectRound,
    selectSection: selectSection,
    startBatchOcr: startBatchOcr,
    cancelBatchOcr: cancelBatchOcr,
    selectGame: selectGame,
    gotoNextReviewable: gotoNextReviewable,
    countReviewableGames: countReviewableGames,
    renderNextReadyNav: renderNextReadyNav,
    markVerified: markVerified,
    onCurrentGameFunctionallyComplete: onCurrentGameFunctionallyComplete,
    onTruncationComplete: onTruncationComplete,
    syncAfterTruncation: syncAfterTruncation,
    saveBatchGamePgn: saveBatchGamePgn,
    renderGameList: renderGameList,
    renderRoundSelector: renderRoundSelector,
    renderSectionSelector: renderSectionSelector,
    requeueAfterFix: requeueAfterFix,
    rerunCurrentGame: rerunCurrentGame,
    resetCurrentGame: resetCurrentGame
  };
})();

// Expose globally
window.BatchGameList = BatchGameList;
