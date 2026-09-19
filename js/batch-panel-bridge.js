// =============================================================================
// batch-panel-bridge.js — Feed the interactive search panels from the batch
// orchestrator so the user sees the orchestrator's per-game progress and
// results (instead of the panels running their own parallel searches).
// =============================================================================
// The right-sidebar Greedy / Beam / Dijkstra panels were originally driven by
// `window.searchManager` via launchBackgroundSearches — which ran the same
// three algorithms the batch orchestrator was already running, and killed all
// progress on game switch. In batch mode this bridge replaces that source:
//
//   - bindGame(id) is called from selectGame. It clears the panels, then
//     replays whatever the orchestrator currently has for that game (a
//     solved result becomes "SOLVED" with Apply/Review buttons; a running
//     method becomes a live status label; queued/idle methods are blanked).
//
//   - As the orchestrator makes progress on the currently-bound game, its
//     onMethodStep / onGameComplete callbacks flow through forwarders on
//     batch-game-list.js into this bridge. The bridge re-dispatches them to
//     the same beam.js renderers that handled live SearchManager updates,
//     so the rendering contract is preserved.
//
//   - Switching games just rebinds. The orchestrator's per-game results
//     survive the switch, so returning to a game picks up where the
//     orchestrator left off — not from ply 1.
//
// Out-of-scope (handled elsewhere):
//   - Suppressing launchBackgroundSearches in batch mode (beam.js guard).
//   - Persisting verification state per game (separate concern).
// =============================================================================

var BatchPanelBridge = (function() {
  'use strict';

  var _boundGameId = null;
  var _orchestrator = null;
  // Games whose panels have been frozen at "✓ Game complete" — set by
  // markComplete and consulted by onStep so a late step event from a
  // worker that hadn't yet noticed its cancel flag can't overwrite the
  // green completion banner with a stale "Step N Q:M" line. Cleared on
  // re-bind and on orchestrator.requeue (via onGameReset in batch-game-list).
  var _completedGameIds = {};
  var METHODS = ['greedy', 'beam', 'dijkstra'];

  // Per-game step history, so a search that runs while you are looking at a
  // DIFFERENT game is not lost.
  //
  // onStep used to drop every step whose gameId wasn't bound. Nothing else
  // keeps them: the orchestrator retains only the final result, so returning
  // to a background-run game replayed the completion summary alone — the
  // yellow [partial] list with no green [fix] lines and no [Ns] timings. The
  // work happened; the record of it was discarded. (Reported by the user:
  // "If I stay in the game while Greedy runs, I get much more info and much
  // better output.")
  //
  // We buffer the step OBJECTS, not rendered HTML, and replay them through the
  // same handleSearchStep on rebind — one renderer, so a background game's log
  // cannot drift from a foreground one's.
  var _stepLog = {};                 // gameId -> { method -> [step, ...] }
  var STEP_LOG_CAP = 600;            // per game per method; ~10x a long run

  function _recordStep(gameId, method, step) {
    if (!gameId || !step || step.done) return;   // 'done' is replayed from the result
    var byMethod = _stepLog[gameId] || (_stepLog[gameId] = {});
    var arr = byMethod[method] || (byMethod[method] = []);
    // Keep the TAIL on overflow: the end of a run is where the stop reason and
    // the last fixes are, and that is what the user came back to read.
    if (arr.length >= STEP_LOG_CAP) arr.shift();
    arr.push(step);
  }

  function clearStepLog(gameId) {
    if (gameId) delete _stepLog[gameId];
    else _stepLog = {};
  }

  // Show/hide a method panel's Cancel (✕) button. In single mode beam.js's
  // handleSearchStatusChange toggles this on the 'running' status; the batch
  // bridge renders progress via updateSearchPanel (which doesn't touch the
  // button), so we toggle it here whenever we paint a running/non-running
  // state. Without this the ✕ stays at its index.html `hidden` default for the
  // whole batch run and the user can never cancel an in-flight Greedy.
  function _setCancelVisible(method, visible) {
    var btn = document.getElementById('btn-cancel-' + method);
    if (!btn) return;
    if (visible) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
  }

  // Attach is called once from batch-game-list.js when the orchestrator is
  // created. The bridge does not construct the orchestrator — it just needs
  // a reference to call getResult(gameId) during bindGame.
  function attach(orchestrator) {
    _orchestrator = orchestrator;
  }

  // Bind the panels to a specific gameId. Full re-render: clear everything,
  // then replay the orchestrator's current state for each method.
  function bindGame(gameId) {
    _boundGameId = gameId;

    // Clear all three panels and the cached result globals that the Apply /
    // Review buttons read from.
    METHODS.forEach(function(m) {
      if (typeof clearPanelLog === 'function') clearPanelLog(m);
    });
    window.greedyResult = null;
    window.beamResult = null;
    window.dijkstraResult = null;
    // Default the per-method ↻ rerun buttons to enabled. The VERIFIED
    // early-return below disables them again for completed games — symmetric
    // with markPanelsGameComplete in beam.js — so switching to a fresh game
    // restores the normal enabled state.
    if (typeof setSearchButtonsEnabled === 'function') {
      try { setSearchButtonsEnabled(true); } catch (e) {}
    }

    if (!_orchestrator || typeof _orchestrator.getResult !== 'function') return;
    var agg = _orchestrator.getResult(gameId);
    if (!agg) return;

    // Make sure the panels are visible — clearPanelLog doesn't toggle the
    // container, and the user may have hit this game before the orchestrator
    // ever reached it.
    if (typeof showSearchPanels === 'function') showSearchPanels(true);

    // If the game is already verified (or exported), the stored orchestrator
    // result is a completed-past-tense view — replaying it would paint
    // "SOLVED (3 fixes)" with Review buttons for fixes the user already
    // walked through. Show a single "Game complete" line in each panel
    // instead so the state matches reality.
    var _game = window.BatchGameList && window.BatchGameList.batchState &&
                window.BatchGameList.batchState.games &&
                window.BatchGameList.batchState.games.get(gameId);
    var _GS = window.BatchGameList && window.BatchGameList.GAME_STATUS;
    var _isVerified = _game && _GS && (_game.status === _GS.VERIFIED ||
                                        _game.status === _GS.EXPORTED);
    if (_isVerified) {
      METHODS.forEach(function(m) {
        if (typeof updateSearchPanel === 'function') {
          updateSearchPanel(m, '✓ Game complete', 100);
        }
        if (typeof showReviewButton === 'function') showReviewButton(m, false);
      });
      if (typeof setSearchButtonsEnabled === 'function') {
        try { setSearchButtonsEnabled(false); } catch (e) {}
      }
      return;
    }

    // Replay this game's step history BEFORE the per-method final state, so
    // the panel reads in the same order a foreground run produced it: the
    // running commentary ([fix] … score=N [Ns], [ambiguity] …), then the
    // completion summary. Without this a game reconstructed in the background
    // came back with the summary only.
    var _hist = _stepLog[gameId];
    if (_hist) {
      METHODS.forEach(function(m) {
        var steps = _hist[m];
        if (!steps || !steps.length) return;
        if (steps.length >= STEP_LOG_CAP && typeof appendPanelLogHtml === 'function') {
          appendPanelLogHtml(m, '<span class="text-gray-500">… earlier steps trimmed …</span>');
        }
        for (var i = 0; i < steps.length; i++) {
          if (typeof handleSearchStep === 'function') {
            try { handleSearchStep(m, steps[i]); } catch (e) {}
          }
        }
      });
    }

    METHODS.forEach(function(m) {
      var status = (agg.methodStatus && agg.methodStatus[m]) || 'idle';
      var result = agg.results && agg.results[m];

      if ((status === 'solved' || status === 'partial' || status === 'failed') && result) {
        // Replay the final state into the panel. handleSearchComplete sets
        // window.*Result and unhides Apply/Review when appropriate, and
        // already branches internally on PARTIAL vs SOLVED. Before we added
        // 'partial' here, a partial run fell through to "idle" and the user
        // was stuck: partial fixes were computed but unreachable — no Review
        // button, panel stayed blank.
        if (typeof handleSearchComplete === 'function') {
          handleSearchComplete(m, result);
        }
      } else if (status === 'running') {
        if (typeof updateSearchPanel === 'function') {
          updateSearchPanel(m, 'Running\u2026', 0);
        }
        _setCancelVisible(m, true);
      } else if (status === 'queued') {
        if (typeof updateSearchPanel === 'function') {
          updateSearchPanel(m, 'Queued', 0);
        }
      } else if (status === 'error') {
        if (typeof updateSearchPanel === 'function') {
          updateSearchPanel(m, 'Error', 0);
        }
      }
      // 'idle' → leave the panel at its post-clear default (blank).
    });
  }

  function unbindGame() {
    _boundGameId = null;
  }

  function getBoundGameId() {
    return _boundGameId;
  }

  // Called from the orchestrator's onMethodStep forwarder in
  // batch-game-list.js. We filter by the bound game so background progress
  // on other games doesn't leak into the visible panels.
  function onStep(gameId, method, step) {
    // Record FIRST, and for every game — including the one on screen, so that
    // re-binding to it later shows the same history rather than a blank panel.
    // A completed game is frozen (see below) and gets no further history.
    if (!_completedGameIds[gameId]) _recordStep(gameId, method, step);
    if (gameId !== _boundGameId) return;
    // Once a game is marked complete, freeze the panel headers at "✓ Game
    // complete". The orchestrator's queues check their cancel flag at the
    // top of each step iteration, so a worker mid-step at abort time still
    // emits one final progress event with done=false; without this guard,
    // handleSearchStep would render that as "Step N Q:M" and overwrite the
    // completion banner the user just saw turn green.
    if (_completedGameIds[gameId]) return;
    // A live (non-done) step means this method is actively running on the
    // open game — make sure its Cancel (✕) is visible even if the user opened
    // the game while the method was still 'queued' (bindGame only shows it for
    // an already-'running' method). handleSearchComplete hides it again on
    // completion.
    if (step && !step.done) _setCancelVisible(method, true);
    if (typeof handleSearchStep === 'function') {
      handleSearchStep(method, step);
    }
  }

  // Called from BatchGameList.onCurrentGameFunctionallyComplete (and any
  // other "this game is now done" entry point). The orchestrator should
  // already have been aborted by the caller; this just freezes the bridge.
  function markComplete(gameId) {
    if (!gameId) return;
    _completedGameIds[gameId] = true;
  }

  // Called from onGameReset in batch-game-list when the orchestrator's
  // aggregate is wiped (user overrode a fix → requeue), so subsequent step
  // events on that game render normally again.
  function clearComplete(gameId) {
    if (!gameId) return;
    delete _completedGameIds[gameId];
    // A requeue re-runs the algorithms from the override point, so the old
    // commentary describes a run that no longer exists. Drop it rather than
    // replaying a stale history above the new one.
    clearStepLog(gameId);
  }

  // Called from the orchestrator's onGameComplete forwarder. Fires once per
  // method completion with the aggregated payload; we render the finishing
  // method's final state here.
  function onGameComplete(gameId, aggregate, completedMethod) {
    if (gameId !== _boundGameId) return;
    if (!aggregate) return;
    // Same freeze rule as onStep — once the game is marked complete, don't
    // let a late completion (or its sibling 'Running…' / 'Queued' badges
    // for not-yet-completed methods below) overwrite "✓ Game complete".
    if (_completedGameIds[gameId]) return;

    if (completedMethod) {
      var result = aggregate.results && aggregate.results[completedMethod];
      if (result && typeof handleSearchComplete === 'function') {
        handleSearchComplete(completedMethod, result);
      }
    }

    // Reflect escalation state for methods that haven't started yet. When
    // greedy finishes failing, beam goes from 'idle' to 'queued' to
    // 'running'; the status label should track that.
    if (aggregate.methodStatus && typeof updateSearchPanel === 'function') {
      METHODS.forEach(function(m) {
        if (m === completedMethod) return;
        var s = aggregate.methodStatus[m];
        if (s === 'queued') {
          updateSearchPanel(m, 'Queued (escalating\u2026)', 0);
        } else if (s === 'running') {
          updateSearchPanel(m, 'Running\u2026', 0);
          _setCancelVisible(m, true);
        }
      });
    }
  }

  // Called from the orchestrator's onProgress forwarder. Mostly for the
  // 'escalating' phase, to put a visible breadcrumb in the downstream
  // method's panel log so the user knows the game got handed off.
  function onProgress(gameId, phase, message, method) {
    if (gameId !== _boundGameId) return;
    if (phase === 'escalating' && method && typeof appendPanelLog === 'function') {
      var nextMethod = (method === 'greedy') ? 'beam' :
                       (method === 'beam')   ? 'dijkstra' : null;
      if (nextMethod) {
        appendPanelLog(nextMethod,
          '\u2192 escalated from ' + method + ' on this game',
          'text-blue-300');
      }
    }
  }

  return {
    attach: attach,
    bindGame: bindGame,
    unbindGame: unbindGame,
    getBoundGameId: getBoundGameId,
    onStep: onStep,
    onGameComplete: onGameComplete,
    onProgress: onProgress,
    markComplete: markComplete,
    clearComplete: clearComplete,
    clearStepLog: clearStepLog
  };
})();

window.BatchPanelBridge = BatchPanelBridge;
