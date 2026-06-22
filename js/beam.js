// =============================================================================
// FULL GAME SEARCH - User-initiated greedy and beam search
// =============================================================================
// UI layer for search panels. Delegates to search-manager.js which runs
// search-worker.js instances (separate Pyodide, separate thread from OCR).
//
// Architecture:
//   zugwise-worker.js  ← OCR + ONNX + interactive validation
//   search-worker.js   ← background greedy/beam (separate Pyodide, no ONNX)
//   search-manager.js  ← main thread coordinator, step loop
//   beam.js (this)     ← UI: panels, progress bars, apply buttons

// Store results for Apply buttons (don't auto-apply)
var greedyResult = null;
var beamResult = null;
var dijkstraResult = null;

// Legacy compat flags
var searchInProgress = false;
var searchCancelFlag = { cancelled: false };

// Fingerprint of the last input we kicked off background searches for.
// Captures the algorithms' actual inputs (OCR moves + alts + confidences,
// stuck point, locked plies). When launchBackgroundSearches is invoked
// repeatedly with the same fingerprint — e.g. by goToPly →
// runStructuralChecks → _retryReconstructionLaunch on every move-list click
// — we skip the relaunch instead of terminating + respawning workers for
// no reason. Manual buttons (runGreedySearch/runBeamSearch/runDijkstraSearch)
// bypass launchBackgroundSearches entirely, so they always rerun.
var _lastLaunchFingerprint = null;

function _altKey(a) {
  var mv = Array.isArray(a) ? a[0] : (a && (a.move || a));
  var c = Array.isArray(a) ? (a[1] || 0) : (a && (a.confidence || 0));
  return mv + '@' + c;
}

function _computeLaunchFingerprint() {
  if (!state.moves || !state.moves.length) return null;
  var parts = [];
  state.moves.forEach(function(m) {
    var w = (m.white || '') + ':' + (m.wConf || 0);
    if (m.wAlts && m.wAlts.length) w += '[' + m.wAlts.map(_altKey).join(',') + ']';
    var b = (m.black || '') + ':' + (m.bConf || 0);
    if (m.bAlts && m.bAlts.length) b += '[' + m.bAlts.map(_altKey).join(',') + ']';
    parts.push(m.num + 'w=' + w + 'b=' + b);
  });
  parts.push('stuck=' + state.stuckPly);
  // Use the EFFECTIVE locked set (state.lockedPlies + status-fixed/locked) so a
  // status flip to 'fixed' (e.g. an override/keep that doesn't change the SAN
  // text) still re-fingerprints and relaunches — matching what we now pass to
  // the worker via _effectiveLockedPlies().
  var locked = _effectiveLockedPlies().slice().sort(function(a, b) { return a - b; }).join(',');
  parts.push('locked=' + locked);
  return parts.join('|');
}

// =============================================================================
// PANEL UI HELPERS
// =============================================================================

function appendPanelLog(panel, text, cssClass) {
  var logEl = document.getElementById(panel + '-log');
  if (!logEl) return;
  var line = document.createElement('div');
  line.textContent = text;
  if (cssClass) line.className = cssClass;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function appendPanelLogHtml(panel, html) {
  var logEl = document.getElementById(panel + '-log');
  if (!logEl) return;
  var line = document.createElement('div');
  line.innerHTML = html;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function updateSearchPanel(panel, statusText, percent) {
  var statusEl = document.getElementById(panel + '-status');
  var barEl = document.getElementById(panel + '-progress-bar');
  if (statusEl) statusEl.textContent = statusText;
  if (barEl && typeof percent === 'number') {
    barEl.style.width = Math.min(100, Math.max(0, percent)) + '%';
  }
}

function clearPanelLog(panel) {
  var logEl = document.getElementById(panel + '-log');
  if (logEl) logEl.innerHTML = '';
  updateSearchPanel(panel, 'Idle', 0);
  showReviewButton(panel, false);
  var cancelBtn = document.getElementById('btn-cancel-' + panel);
  if (cancelBtn) cancelBtn.classList.add('hidden');
}

function resetSearchPanels() {
  greedyResult = null;
  beamResult = null;
  dijkstraResult = null;
  clearPanelLog('greedy');
  clearPanelLog('beam');
  clearPanelLog('dijkstra');
  setSearchButtonsEnabled(true);
  var sp = document.getElementById('search-progress');
  if (sp) sp.classList.add('hidden');
}

// Called from revalidate when a game reaches no-stuck-point. Wipes any cached
// algorithm result (so Review/Apply buttons go away), clears the per-method
// log, and labels each panel as complete. Mirrors the inline logic in
// markVerified() — kept separate so it can fire on functional completion
// (game-complete via revalidate) as well as explicit user verification.
function markPanelsGameComplete() {
  greedyResult = null;
  beamResult = null;
  dijkstraResult = null;
  if (typeof window !== 'undefined') {
    window.greedyResult = null;
    window.beamResult = null;
    window.dijkstraResult = null;
  }
  ['greedy', 'beam', 'dijkstra'].forEach(function(m) {
    try { clearPanelLog(m); } catch (e) {}
    try { updateSearchPanel(m, '✓ Game complete', 100); } catch (e) {}
  });
  // Fade the per-method ↻ rerun buttons so they don't sit at full opacity
  // next to "✓ Game complete" looking like a running spinner. They get
  // re-enabled when bindGame loads a non-complete game (or when the user
  // clicks "Rerun All" at the top of the search panel).
  try { setSearchButtonsEnabled(false); } catch (e) {}
  // In batch mode, stop the orchestrator's per-method queues for this
  // game and clear the row's pre-completion methodStatus/tier. Without
  // this, a still-running Dijkstra emits step events through the panel
  // bridge that overwrite "✓ Game complete" with "Step N Q:M" — and the
  // sidebar keeps showing G· B· D↻ alongside the panels' green banner.
  // cancelSearch() (called by revalidate before us) only cancels the UI
  // singleton's workers, not the orchestrator's per-queue instances.
  try {
    if (window.BatchGameList &&
        typeof window.BatchGameList.onCurrentGameFunctionallyComplete === 'function') {
      window.BatchGameList.onCurrentGameFunctionallyComplete();
    }
  } catch (e) {}
}

function showSearchPanels(show) {
  var el = document.getElementById('search-progress');
  if (!el) return;
  if (show) el.classList.remove('hidden');
}

function showReviewButton(panel, show) {
  // No auto-apply path exists. The Review button enters the walkthrough
  // with the algorithm's fixes shown as *suggestions*; the user confirms
  // each one, which is the only way an algorithm result reaches state.moves.
  var reviewBtn = document.getElementById('btn-review-' + panel);
  if (reviewBtn) {
    if (show) reviewBtn.classList.remove('hidden');
    else reviewBtn.classList.add('hidden');
  }
}

// =============================================================================
// LEGACY COMPAT (some code may still call these)
// =============================================================================

function showSearchProgress(show) { showSearchPanels(show); }
function clearSearchLog() {}
function appendSearchLog() {}
function showSearchFixLog() {}
function setSearchButtonsEnabled(enabled) {
  var greedy = document.getElementById('btn-greedy-search');
  var beam = document.getElementById('btn-beam-search');
  var dijkstra = document.getElementById('btn-dijkstra-search');
  if (greedy) greedy.disabled = !enabled;
  if (beam) beam.disabled = !enabled;
  if (dijkstra) dijkstra.disabled = !enabled;
}

// =============================================================================
// BUILD OCR DATA from state.moves (or from a paired array)
// =============================================================================

function buildSearchOcrMoves(paired) {
  var source = paired || state.moves;
  var ocrMoves = [];
  // Carry the same forced_stop signal the interactive validator uses, so the
  // search worker can stop/defer at dual-sheet ambiguities and very-low-
  // confidence reads (see search-worker.js / play_until_absurd_or_stuck).
  // Derive from getAmbiguousPlies() (live state.ocrCells._ambiguous flags) —
  // the SAME source validation.js + ui.js read — NOT the vestigial
  // state.ambiguousPlies cache. That cache is set from _pendingAmbiguousPlies
  // only on the dual-sheet merge path and is never cleared on a single-sheet
  // load, so reading it here force-stopped the search at stale near-tie plies
  // from a PRIOR dual-sheet game — surfacing no-op "f6 -> f6" fixes and bogus
  // "sheets disagree" review steps on 0.999-confidence single-sheet cells.
  var _ambig = (typeof getAmbiguousPlies === 'function')
    ? getAmbiguousPlies() : (state.ambiguousPlies || []);
  var _LOW = (typeof window !== 'undefined' && window.FORCED_STOP_MIN_CONFIDENCE) || 0.50;
  // Resolved-ply carve-out for the low-confidence gate — mirror validation.js.
  // _ambig (getAmbiguousPlies) already drops user-resolved plies, but the
  // low-confidence branch below must too, or a sub-threshold move the user has
  // overridden/kept/locked (e.g. exd5 @49%) stays in forced_stop_plies and the
  // search re-stops at it every relaunch (play.py:403 re-stops on forced_stop
  // unless approved), surfacing an endless no-op "[fix] 9.B exd5 -> exd5".
  var _resolved = (typeof isPlyResolved === 'function')
    ? isPlyResolved : function () { return false; };
  source.forEach(function(m) {
    if (m.white) {
      var alts = [];
      if (m.wAlts && m.wAlts.length > 0) {
        m.wAlts.forEach(function(a) {
          alts.push({
            move: Array.isArray(a) ? a[0] : (a.move || a),
            confidence: Array.isArray(a) ? (a[1] || 0.1) : (a.confidence || 0.1)
          });
        });
      }
      var wPly = (m.num - 1) * 2;
      ocrMoves.push({ num: m.num, color: 'w', move: m.white, confidence: m.wConf || 0.9, alternatives: alts,
                      forced_stop: (_ambig.indexOf(wPly) >= 0) || ((m.wConf || 0.9) < _LOW && !_resolved(wPly)) });
    }
    if (m.black) {
      var alts = [];
      if (m.bAlts && m.bAlts.length > 0) {
        m.bAlts.forEach(function(a) {
          alts.push({
            move: Array.isArray(a) ? a[0] : (a.move || a),
            confidence: Array.isArray(a) ? (a[1] || 0.1) : (a.confidence || 0.1)
          });
        });
      }
      var bPly = (m.num - 1) * 2 + 1;
      ocrMoves.push({ num: m.num, color: 'b', move: m.black, confidence: m.bConf || 0.9, alternatives: alts,
                      forced_stop: (_ambig.indexOf(bPly) >= 0) || ((m.bConf || 0.9) < _LOW && !_resolved(bPly)) });
    }
  });
  return ocrMoves;
}

// =============================================================================
// SEARCH-MANAGER CALLBACKS → PANEL UI
// =============================================================================

function handleSearchStep(method, step) {
  var panel = method;
  var totalPlies = step.totalPlies || 0;
  var elapsed = step.elapsed ? ' <span class="text-gray-500">[' + step.elapsed + 's]</span>' : '';

  if (step.message) {
    // Color fix lines green for greedy
    if (method === 'greedy' && step.fix_to) {
      appendPanelLogHtml(panel,
        '<span class="text-green-400">[fix] ' + (step.fix_ply || '') + ': ' +
        (step.fix_from || '') + ' \u2192 ' + (step.fix_to || '') + '</span>' +
        (step.fix_score ? ' <span class="text-gray-500">score=' + Math.round(step.fix_score) + '</span>' : '') +
        elapsed
      );
    } else if (method === 'beam' && step.fixes_this_step && step.fixes_this_step.length > 0) {
      // Show fix details for each beam iteration
      var fixes = step.fixes_this_step;
      for (var i = 0; i < fixes.length; i++) {
        var f = fixes[i];
        appendPanelLogHtml(panel,
          '<span class="text-cyan-400">[fix] ' + f.ply_str + ': ' +
          f.ocr + ' \u2192 ' + f.san +
          ' (regret=' + (f.regret || 0) + ')</span>' +
          ' \u2014 ' + (f.num_branches || 1) + ' paths'
        );
      }
      // Summary line with path count and best reach
      appendPanelLogHtml(panel,
        '<span class="text-sky-300">Beam iter ' + (step.iteration || '?') + ': ' +
        (step.paths_in_beam || '?') + ' paths, best at ' + (step.best_reach_str || '?') +
        '</span>' + elapsed
      );
    } else if (method === 'dijkstra' && step.fix_to) {
      if (step.pushed && step.pushed > 1) {
        appendPanelLogHtml(panel,
          '<span class="text-purple-400">[branch] ' + (step.fix_ply || '') + ': ' +
          step.pushed + ' candidates</span>' +
          ' <span class="text-gray-500">cost=' + Math.round(step.current_cost || 0) + '</span>' +
          elapsed
        );
      } else {
        appendPanelLogHtml(panel,
          '<span class="text-purple-400">[fix] ' + (step.fix_ply || '') + ': ' +
          (step.fix_from || '') + ' \u2192 ' + (step.fix_to || '') + '</span>' +
          ' <span class="text-gray-500">cost=' + Math.round(step.current_cost || 0) + '</span>' +
          elapsed
        );
      }
    } else if (!step.done || step.status === 'CANCELLED') {
      // Live status / progress messages render here. Suppress the final
      // done=true stop message — handleSearchComplete renders it from
      // result.stop_message so that re-rendering on game-switch keeps the
      // reason visible. CANCELLED is the exception: handleSearchComplete
      // doesn't run on cancel, so we keep emitting that one here.
      appendPanelLogHtml(panel, step.message + elapsed);
    }
  }

  // Dump winning path fixes when beam completes via step (done=true with winning_fixes)
  if (method === 'beam' && step.done && step.winning_fixes && step.winning_fixes.length > 0) {
    for (var wi = 0; wi < step.winning_fixes.length; wi++) {
      var wf = step.winning_fixes[wi];
      appendPanelLogHtml(panel,
        '<span class="text-green-400">  [fix] ' + wf.ply_str + ': ' +
        wf.ocr + ' \u2192 ' + wf.san + '</span>'
      );
    }
  }

  // Update progress bar
  if (!step.done) {
    if (method === 'greedy') {
      var gPct = step.fixes_so_far ? (step.fixes_so_far / 15) * 100 : 0;
      var gStatus = 'Fix ' + (step.fixes_so_far || 0) + '...';
      if (step.elapsed) gStatus += ' (' + step.elapsed + 's)';
      updateSearchPanel(panel, gStatus, gPct);
    } else if (method === 'beam') {
      var bPct = step.best_reach && totalPlies ? (step.best_reach / totalPlies) * 100 : 0;
      var bStatus = 'Iter ' + (step.iteration || 0);
      if (step.elapsed) bStatus += ' (' + step.elapsed + 's)';
      updateSearchPanel(panel, bStatus, bPct);
    } else if (method === 'dijkstra') {
      var dPct = step.reach && totalPlies ? (step.reach / totalPlies) * 100 : 0;
      var dStatus = 'Step ' + (step.step || 0);
      if (step.queue_size) dStatus += ' Q:' + step.queue_size;
      if (step.elapsed) dStatus += ' (' + step.elapsed + 's)';
      updateSearchPanel(panel, dStatus, dPct);
    }
  }
}

function handleSearchComplete(method, result) {
  var panel = method;
  var fixes = result.fixes || [];
  var elapsed = result.elapsed ? ' in ' + result.elapsed + 's' : '';

  var isSolved = (result.status === 'SOLVED' || result.status === 'VALID');
  var isPartial = (result.status === 'PARTIAL');

  // Stale-result check: the search ran on whatever state.moves looked like
  // when it was launched. Only a deliberately LOCKED ply (🔒 — the user's hard
  // commitment) blocks the result: if the algorithm's answer there differs, it
  // would overwrite that lock on Review, so we treat it as STALE, don't store
  // it, and don't enable the Review button (the fixes are still surfaced for
  // inspection). A merely 'fixed' (confirmed-in-a-prior-run) ply is NOT a
  // blocker: re-running the search means "reconsider", and the algorithm
  // changing its mind there — when the live deep-search agrees — is exactly
  // what the user wants to review, not a stale conflict (reported: a prior run
  // confirmed 16.W Rfc1, this run + the panel both propose Rfe1). Review is
  // non-destructive (per-fix), so a 'fixed' difference is reviewable, not
  // clobbering.
  var isStale = false;
  var staleAtPlyLabel = null;
  if ((isSolved || isPartial) && result.moves && typeof state !== 'undefined' &&
      Array.isArray(state.moves)) {
    for (var idx2 = 0; idx2 < state.moves.length && !isStale; idx2++) {
      var m2 = state.moves[idx2];
      if (!m2) continue;
      var wPly = idx2 * 2;
      var bPly = wPly + 1;
      if (m2.white && m2.wStatus === 'locked') {
        if (result.moves[wPly] !== m2.white) {
          isStale = true;
          staleAtPlyLabel = (idx2 + 1) + '.W';
        }
      }
      if (!isStale && m2.black && m2.bStatus === 'locked') {
        if (result.moves[bPly] !== m2.black) {
          isStale = true;
          staleAtPlyLabel = (idx2 + 1) + '.B';
        }
      }
    }
  }

  if (isSolved && !isStale) {
    appendPanelLogHtml(panel,
      '<span class="text-green-400 font-bold">SOLVED (' + fixes.length + ' fixes' + elapsed + ')</span>'
    );
    // Dump winning path fixes (same format as greedy)
    if (fixes.length > 0) {
      for (var i = 0; i < fixes.length; i++) {
        var f = fixes[i];
        var plyStr = f.ply_str || f.ply_str || '';
        var ocr = f.ocr || f.original || '';
        var san = f.san || f.replacement || '';
        appendPanelLogHtml(panel,
          '<span class="text-green-400">  [fix] ' + plyStr + ': ' +
          ocr + ' \u2192 ' + san + '</span>'
        );
      }
    }
    updateSearchPanel(panel, 'Solved!' + elapsed, 100);
  } else if (isSolved && isStale) {
    // STALE: algorithm produced a full solution but it diverges from
    // the user's manual work since launch. Render in amber and do NOT
    // enable Review — clicking Review on this would clobber the user's
    // fixes with the algorithm's parallel-universe answer.
    appendPanelLogHtml(panel,
      '<span class="text-amber-400 font-bold">STALE (' + fixes.length +
      ' fixes' + elapsed + ')</span>'
    );
    appendPanelLogHtml(panel,
      '<span class="text-amber-300/80 italic text-xs">' +
      '  result disagrees with your ' + staleAtPlyLabel + ' \u2014 ' +
      'Review disabled; re-apply a fix to re-launch on your current input</span>'
    );
    for (var si = 0; si < fixes.length; si++) {
      var sf = fixes[si];
      var sPlyStr = sf.ply_str || '';
      var sOcr = sf.ocr || sf.original || '';
      var sSan = sf.san || sf.replacement || '';
      appendPanelLogHtml(panel,
        '<span class="text-amber-300/70">  [stale] ' + sPlyStr + ': ' +
        sOcr + ' \u2192 ' + sSan + '</span>'
      );
    }
    updateSearchPanel(panel, 'Stale' + elapsed, 0);
  } else {
    // FAILED / PARTIAL behavior depends on the method AND status:
    //   - Greedy PARTIAL: backend stops cleanly at backward-regression
    //     (never re-fixes a ply <= max already-fixed ply). These fixes are
    //     strictly forward-progressing and orderly — worth showing.
    //   - Greedy FAILED: legacy path, back-and-forth cascades possible.
    //     Keep hidden to avoid inviting the user to accept garbage.
    //   - Beam: partial fixes are from the best-path frontier at timeout.
    //     Each fix was coherent at the moment it was committed to the
    //     winning beam, so they're at least structurally self-consistent.
    //     Worth showing.
    //   - Dijkstra: partial fixes trace the optimal-cost path up to
    //     wherever search stopped. Cost-optimal under the scoring function.
    //     Worth showing.
    var isGreedy = (method === 'greedy');
    var showPartialFixes = fixes.length > 0 && (!isGreedy || isPartial);
    var discardFixes = isGreedy && !isPartial && fixes.length > 0;

    // Diagnostic: a PARTIAL+stale result hides the Review button below
    // (acceptResult requires !isStale) but — unlike SOLVED+stale — gave no
    // reason, so "the review button just isn't there" was a mystery. Surface
    // WHICH fixed/locked ply the algorithm's result disagrees with, so a
    // false-positive staleness (result.moves vs your move) is debuggable.
    if (isStale && isPartial) {
      appendPanelLogHtml(panel,
        '<span class="text-amber-300/80 italic text-xs">  Review disabled — ' +
        'result disagrees with your ' + staleAtPlyLabel +
        ' (re-apply a fix to re-launch on your current input)</span>'
      );
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[' + method + '] PARTIAL stale at ' + staleAtPlyLabel +
          ': algorithm result.moves differs from your fixed/locked move there.');
      }
    }

    // Filter out fixes for plies the user has already confirmed (or locked
    // via merge-agreement) in state.moves. The partial-fix list is the OLD
    // Greedy result frozen at search-completion time; even after the user
    // walks through Review and confirms 3.B, 4.W, 5.B etc., the panel still
    // shows them as "[partial] 3.B: Be5 \u2192 Bf5" because nothing re-renders
    // it. Hide already-handled plies so the list reflects what's actually
    // still pending; show the count separately so the math is visible.
    var alreadyHandledFixes = [];
    var pendingFixes = fixes;
    if (showPartialFixes && typeof state !== 'undefined' && Array.isArray(state.moves)) {
      pendingFixes = [];
      fixes.forEach(function(f) {
        var pp = (typeof f.ply === 'number') ? f.ply : null;
        if (pp == null) { pendingFixes.push(f); return; }
        var mv = state.moves[Math.floor(pp / 2)];
        if (!mv) { pendingFixes.push(f); return; }
        var st = (pp % 2 === 0) ? mv.wStatus : mv.bStatus;
        if (st === 'fixed' || st === 'locked') {
          alreadyHandledFixes.push(f);
        } else {
          pendingFixes.push(f);
        }
      });
    }

    // Stop message \u2014 surfaced live via handleSearchStep but ALSO persisted
    // on the result so that re-rendering the panel after navigating away
    // and back keeps the reason visible. Without this the panel restored
    // to "PARTIAL \u2014 N partial fix(es):" with no hint of why Greedy stopped.
    if (result.stop_message) {
      appendPanelLogHtml(panel,
        '<span class="text-yellow-300/80 text-xs">' + result.stop_message + '</span>'
      );
    }
    var pendingCount = pendingFixes.length;
    var handledCount = alreadyHandledFixes.length;
    var countSummary;
    if (fixes.length === 0) {
      countSummary = '';
    } else if (discardFixes) {
      countSummary = ' \u2014 ' + fixes.length + ' partial fix(es) discarded';
    } else if (handledCount > 0) {
      countSummary = ' \u2014 ' + pendingCount + ' partial fix(es) pending' +
                     ' (' + handledCount + ' already confirmed):';
    } else {
      countSummary = ' \u2014 ' + fixes.length + ' partial fix(es):';
    }
    appendPanelLogHtml(panel,
      '<span class="text-yellow-400">' + (result.status || 'FAILED') +
      elapsed + countSummary + '</span>'
    );
    if (showPartialFixes) {
      for (var pi = 0; pi < pendingFixes.length; pi++) {
        var pf = pendingFixes[pi];
        var pPlyStr = pf.ply_str || '';
        var pOcr = pf.ocr || pf.original || '';
        var pSan = pf.san || pf.replacement || '';
        appendPanelLogHtml(panel,
          '<span class="text-yellow-300/80">  [partial] ' + pPlyStr + ': ' +
          pOcr + ' \u2192 ' + pSan + '</span>'
        );
      }
    }
    updateSearchPanel(panel, (result.status || 'Failed') + elapsed, 0);
  }

  // Store result when it's reviewable AND not stale:
  //   - SOLVED with fixes: full solution, obviously reviewable
  //   - PARTIAL with fixes: orderly forward-progress fixes worth reviewing
  //     (Greedy stops at backward regression; Beam/Dijkstra stop at timeout
  //     but report coherent frontier fixes)
  // VALID (0 fixes) is not reviewable — the game needed no corrections and
  // enterVerificationMode returns false for an empty fix list anyway, making
  // the Review button a dead end. STALE or empty-PARTIAL also not reviewable.
  var hasReviewableFixes = fixes.length > 0 && (isSolved || isPartial);
  var acceptResult = hasReviewableFixes && !isStale;
  var storedResult = acceptResult ? result : null;
  if (method === 'greedy') greedyResult = storedResult;
  else if (method === 'beam') beamResult = storedResult;
  else if (method === 'dijkstra') dijkstraResult = storedResult;

  // PGN-batch mode: persist the result into the current game's slot so a
  // game-switch round-trip reloads this run instead of the stale cached
  // background-Greedy result. Without this, clicking the ↻ rerun button
  // produces a fresh result that's only stored in beam.js's module-level
  // greedyResult — _loadGame repaints from g.algoResult on return.
  if (method === 'greedy'
      && window.PgnBatch && window.PgnBatch.state && window.PgnBatch.state.active
      && typeof window.PgnBatch.updateCurrentGameAlgoResult === 'function') {
    try {
      window.PgnBatch.updateCurrentGameAlgoResult(result);
    } catch (_e) {
      if (typeof console !== 'undefined') console.warn('PgnBatch.updateCurrentGameAlgoResult failed:', _e);
    }
  }

  // Show Review button for SOLVED or PARTIAL-with-fixes (when not stale).
  // A STALE result would overwrite the user's own manual fixes with the
  // algorithm's parallel-universe answer, so stays disabled.
  if (acceptResult) {
    showReviewButton(panel, true);
  }

  // Hide cancel, enable rerun
  var cancelBtn = document.getElementById('btn-cancel-' + panel);
  if (cancelBtn) cancelBtn.classList.add('hidden');
  var rerunBtn = document.getElementById('btn-' + panel + '-search');
  if (rerunBtn) rerunBtn.disabled = false;

  log(method + ': ' + result.status + ' (' + fixes.length + ' fixes' + elapsed + ')');
}

function handleSearchStatusChange(method, status) {
  var panel = method;
  var rerunBtn = document.getElementById('btn-' + panel + '-search');
  if (status === 'loading') {
    updateSearchPanel(panel, 'Loading...', 0);
  } else if (status === 'running') {
    updateSearchPanel(panel, 'Running...', 0);
    if (rerunBtn) rerunBtn.disabled = false;
    var cancelBtn = document.getElementById('btn-cancel-' + panel);
    if (cancelBtn) cancelBtn.classList.remove('hidden');
  } else if (status === 'error') {
    appendPanelLog(panel, 'Error', 'text-red-400');
    updateSearchPanel(panel, 'Error', 0);
    if (rerunBtn) rerunBtn.disabled = false;
    var cancelBtn = document.getElementById('btn-cancel-' + panel);
    if (cancelBtn) cancelBtn.classList.add('hidden');
  }

  // Update legacy flag
  searchInProgress = window.searchManager && window.searchManager.isRunning;
}

// =============================================================================
// LAUNCH SEARCHES
// =============================================================================

/**
 * Auto-launch after validation (called from ocr.js).
 * Spawns separate search workers — does NOT block the main zugwise worker.
 */
function launchBackgroundSearches(paired) {
  if (!window.searchManager) return;
  if (!state.stuckPly && state.stuckPly !== 0) {
    return;  // Game is valid, no search needed
  }
  // Noise truncation must be resolved before reconstruction runs at all —
  // running Greedy/Beam/Dijkstra on noise-laden input wastes worker time
  // on suggestions the user is about to truncate away, and any algorithm
  // result computed against the pre-truncation tail is stale the moment
  // truncation happens. _retryReconstructionLaunch has the same gate; this
  // one defends every other call site (batch panel bridge, verification
  // re-entry, sheets.js, ocr.js).
  if (state.pendingNoiseReview) {
    if (typeof log === 'function') {
      log('⏸️ Reconstruction launch deferred: noise-review panel pending — confirm or dismiss truncation first.');
    }
    return;
  }
  if (window.NoiseDetection &&
      typeof window.NoiseDetection.isTailNoisy === 'function' &&
      state.moves && !state.noiseBannerDismissed &&
      window.NoiseDetection.isTailNoisy(state.moves)) {
    if (typeof log === 'function') {
      log('⏸️ Reconstruction launch deferred: trailing noise detected — resolve via noise-review first.');
    }
    return;
  }
  // Don't burn worker time on a game whose structure is still being negotiated
  // — every accepted noise/alignment fix triggers a re-merge that would abort
  // and re-launch this anyway.
  //
  // EXCEPTION (dual-sheet edit parity): defer only while the inputs are
  // UNCHANGED since the last launch. If the user has edited a move since then,
  // the cached Greedy/Beam/Dijkstra result is stale and must be recomputed even
  // with an alignment banner up. Single-sheet mode has no banner and always
  // relaunched on an edit; this keeps dual-sheet in parity instead of leaving
  // stale panels until the user happens to resolve the banner. A plain
  // navigation tick (unchanged fingerprint) or a game that never launched yet
  // (initial structure negotiation, _lastLaunchFingerprint === null) still
  // defers, preserving the original "don't launch mid-negotiation" intent.
  if (window.SheetAlignment && window.SheetAlignment.hasActiveStructuralBanner()) {
    var _fpBanner = _computeLaunchFingerprint();
    if (_lastLaunchFingerprint === null || !_fpBanner || _fpBanner === _lastLaunchFingerprint) {
      if (typeof log === 'function') {
        log('⏸️ Reconstruction launch deferred: structural suggestion(s) pending user decision.');
      }
      return;
    }
    if (typeof log === 'function') {
      log('▶️ Reconstruction relaunch allowed despite structural banner: move inputs changed since last run (stale result).');
    }
  }
  // Batch mode: the orchestrator drives the panels via BatchPanelBridge.
  // Spawning duplicate interactive searches would run the same algorithms
  // twice on the same game, and cancel each other on game switch. The
  // orchestrator's per-game results stream into the panels instead.
  if (window.BatchGameList && window.BatchGameList.batchState &&
      window.BatchGameList.batchState.active) {
    return;
  }
  // PGN batch mode: same logic. The PGN-batch scheduler runs Greedy on
  // every stuck game in the background and paints results into the
  // Greedy panel via handleSearchComplete. Foreground launches here
  // would duplicate that work and clash on game switch (logs from two
  // games interleaving, "Loading game…" appearing to hang behind a
  // foreground search the user can't see).
  if (window.PgnBatch && window.PgnBatch.state && window.PgnBatch.state.active) {
    return;
  }

  // Idempotency: if the algorithm inputs are unchanged since the last
  // launch and at least one worker exists for this game, skip the relaunch.
  // navigation.js calls SheetAlignment.runStructuralChecks on every
  // goToPly, and that path cascades into _retryReconstructionLaunch →
  // launchBackgroundSearches even when the user is just scrolling through
  // the move list. Without this guard, every click terminates and respawns
  // the greedy/beam/dijkstra workers — pure waste.
  var fingerprint = _computeLaunchFingerprint();
  var hasExistingWorker = !!(window.searchManager && window.searchManager.workers &&
                             Object.keys(window.searchManager.workers).length > 0);
  if (fingerprint && fingerprint === _lastLaunchFingerprint && hasExistingWorker) {
    if (typeof log === 'function') {
      log('⏭️ Background searches already running for this input — skipping relaunch.');
    }
    return;
  }

  var ocrMoves = buildSearchOcrMoves(paired);

  // Show and clear panels
  showSearchPanels(true);
  clearPanelLog('greedy');
  clearPanelLog('beam');
  clearPanelLog('dijkstra');

  greedyResult = null;
  beamResult = null;
  dijkstraResult = null;

  // Check which searches are enabled for auto-run. Pass the user's
  // confirmed-prefix frontier so the algorithms respect it the same way
  // the live deep-search panel does. Without this, Greedy/Beam/Dijkstra
  // launched with confirmed_ply=0 and ran with min_ply = stuck - 5
  // regardless of which plies the user had already accepted — producing
  // rankings that disagreed with the live panel for the same game.
  // Matches the per-method injection in batch-reconstruct-queue.js.
  //
  // PGN review override: when state.inputMode === 'pgn', typed games can
  // carry rare-but-deep typos (e.g. Qd2 for Qe2 surfacing as an
  // absurdity 10+ plies later). Mirror getAutoFixSettings()' depth=999
  // bump so algorithms get the same full-game lookback as the live
  // deep-search panel. Without this, Greedy/Beam/Dijkstra stay capped
  // at max_backtrack=5 in PGN mode and can't reach upstream errors past
  // 5 plies before the stuck point.
  var _confirmedPly = (state && state.confirmedPly) | 0;
  var _isPgnReview = (state && state.inputMode === 'pgn');
  var _maxBacktrackOverride = _isPgnReview ? 999 : null;
  function _algoOpts(base) {
    base.confirmed_ply = _confirmedPly;
    if (_maxBacktrackOverride != null) base.max_backtrack = _maxBacktrackOverride;
    return base;
  }
  var methods = [];
  var methodOptions = {};
  if (!currentSettings || currentSettings.autorun_greedy) {
    methods.push('greedy');
    methodOptions.greedy = _algoOpts({ max_fixes: 15 });
  }
  if (!currentSettings || currentSettings.autorun_beam) {
    methods.push('beam');
    methodOptions.beam = _algoOpts({ beam_width: 5, max_iterations: 20, max_fixes_per_path: 10 });
  }
  if (!currentSettings || currentSettings.autorun_dijkstra) {
    methods.push('dijkstra');
    methodOptions.dijkstra = _algoOpts({ max_queue_size: 50, max_steps: 1000, max_fixes_per_path: 15 });
  }

  if (methods.length === 0) {
    log('All background searches disabled in settings.');
    return;
  }

  log('Launching background searches (' + methods.join(' + ') + ')...');
  window.searchManager.launchSearches(ocrMoves, methods, methodOptions,
    _effectiveLockedPlies(), _collectTier1AgreedPlies());
  _lastLaunchFingerprint = fingerprint;
}

/**
 * Collect plies where both OCR sheets strongly back the move (dual-sheet,
 * _sheetCount===2, and either raw top-agreement _agree OR a summed-consensus
 * pick _consensusTop set by mergePly). Static — does NOT depend on legality.
 * Greedy/Beam/Dijkstra use this to recompute their locked set after each applied
 * fix, mirroring what the frontend's classifyTiers + computeLockedPlies('tier1')
 * would compute on a manual revalidate (classifyTiers elevates the same
 * _agree||_consensusTop cells to Tier 1). For single-sheet OCR the set is empty
 * and auto-lock behavior is unchanged.
 */
function _collectTier1AgreedPlies() {
  if (!state.ocrCells || !Array.isArray(state.ocrCells)) return [];
  var out = [];
  state.ocrCells.forEach(function(cell, ply) {
    if (cell && cell._sheetCount === 2 && (cell._agree || cell._consensusTop)) {
      out.push(ply | 0);
    }
  });
  return out;
}

/**
 * Plies the user has settled — state.lockedPlies UNION every move whose live
 * status is 'fixed'/'locked'. The worker treats locked_plies as user_confirmed
 * (approved → EAD + forced_stop skipped, never modified). Passing only
 * state.lockedPlies misses overrides/keeps/applied-fixes that flip bStatus to
 * 'fixed' WITHOUT touching state.lockedPlies, so the worker re-derives a
 * forced_stop from the still-stale sub-threshold confidence (search-worker.js
 * _conf < lowConfFloor) at a ply the user already resolved — Greedy then
 * re-stops there every relaunch with a no-op "[fix] 9.B exd5 -> exd5". The
 * interactive validator already sees these via isPlyResolved (status branch),
 * and the review requeue path already augments its locked set the same way
 * (verification-ui.js _exitVerificationMode); this brings the background /
 * manual launches to parity. Mirrors feedback_lock_enforce_at_launch: derive
 * locked from visible cell statuses at launch.
 */
function _effectiveLockedPlies() {
  var seen = {};
  var out = [];
  function _add(p) {
    if (p == null || p < 0) return;
    p = p | 0;
    if (!seen[p]) { seen[p] = true; out.push(p); }
  }
  // Same sources isPlyResolved consults, so whatever the interactive validator
  // treats as settled, the worker's user_confirmed/approved set sees too.
  [state.lockedPlies, state.fixedPlies, state.approvedPlies].forEach(function(arr) {
    if (Array.isArray(arr)) arr.forEach(_add);
  });
  if (Array.isArray(state.moves)) {
    state.moves.forEach(function(m) {
      if (!m) return;
      var wp = (m.num - 1) * 2;
      if (m.wStatus === 'fixed' || m.wStatus === 'locked') _add(wp);
      if (m.bStatus === 'fixed' || m.bStatus === 'locked') _add(wp + 1);
    });
  }
  return out;
}

/**
 * Manual greedy button click.
 */
function runGreedySearch() {
  if (!state.moves || state.moves.length === 0) {
    log('No moves to search');
    return;
  }

  showSearchPanels(true);
  clearPanelLog('greedy');
  greedyResult = null;

  var ocrMoves = buildSearchOcrMoves();
  var _gOpts = { max_fixes: 15, confirmed_ply: (state && state.confirmedPly) | 0 };
  if (state && state.inputMode === 'pgn') _gOpts.max_backtrack = 999;
  window.searchManager.launchSearches(ocrMoves, ['greedy'], {
    greedy: _gOpts
  }, _effectiveLockedPlies(), _collectTier1AgreedPlies());
}

/**
 * Manual beam button click.
 */
function runBeamSearch() {
  if (!state.moves || state.moves.length === 0) {
    log('No moves to search');
    return;
  }

  showSearchPanels(true);
  clearPanelLog('beam');
  beamResult = null;

  var ocrMoves = buildSearchOcrMoves();
  var _bOpts = { beam_width: 5, max_iterations: 20, max_fixes_per_path: 10, confirmed_ply: (state && state.confirmedPly) | 0 };
  if (state && state.inputMode === 'pgn') _bOpts.max_backtrack = 999;
  window.searchManager.launchSearches(ocrMoves, ['beam'], {
    beam: _bOpts
  }, _effectiveLockedPlies(), _collectTier1AgreedPlies());
}

/**
 * Manual dijkstra button click.
 */
function runDijkstraSearch() {
  if (!state.moves || state.moves.length === 0) {
    log('No moves to search');
    return;
  }

  showSearchPanels(true);
  clearPanelLog('dijkstra');
  dijkstraResult = null;

  var ocrMoves = buildSearchOcrMoves();
  var _dOpts = { max_queue_size: 50, max_steps: 1000, max_fixes_per_path: 15, confirmed_ply: (state && state.confirmedPly) | 0 };
  if (state && state.inputMode === 'pgn') _dOpts.max_backtrack = 999;
  window.searchManager.launchSearches(ocrMoves, ['dijkstra'], {
    dijkstra: _dOpts
  }, _effectiveLockedPlies(), _collectTier1AgreedPlies());
}

function runAllSearches() {
  // In batch mode, route through the orchestrator so a "Rerun All" click
  // is an actual scheduled reset: aggregate wiped, panels cleared via
  // onGameReset, in-flight Beam/Dijkstra aborted, escalation chain
  // restarted cleanly. Without this the local-searchManager path ran the
  // three algorithms against this game but the game list kept showing
  // the pre-rerun methodStatus/tier/picked (stale aggregate never reset).
  if (window.BatchGameList && window.BatchGameList.batchState &&
      window.BatchGameList.batchState.active &&
      typeof window.BatchGameList.rerunCurrentGame === 'function') {
    if (window.BatchGameList.rerunCurrentGame()) return;
    // rerunCurrentGame returned false (no orchestrator) — fall through to
    // the local path below as a best-effort last resort.
  }
  runGreedySearch();
  runBeamSearch();
  runDijkstraSearch();
}

// =============================================================================
// CANCEL
// =============================================================================

// In batch mode the panels are driven by the orchestrator's per-game
// SearchManager instances (via BatchPanelBridge), NOT the UI singleton. So a
// panel Cancel click must reach the orchestrator's run for the OPEN game, not
// window.searchManager (which is idle in batch). Returns true if it routed the
// cancel to the orchestrator; false to fall through to the singleton path used
// in single/dual mode. The orchestrator keeps the cancelled method's partial
// and surfaces it for Review — same outcome as cancelling Greedy in single mode.
function _cancelBatchBoundMethod(method) {
  try {
    var bs = window.BatchGameList && window.BatchGameList.batchState;
    if (!bs || !bs.active) return false;  // not in batch — use the singleton
    var bridge = window.BatchPanelBridge;
    var gid = bridge && typeof bridge.getBoundGameId === 'function'
      ? bridge.getBoundGameId() : null;
    if (!gid) return false;
    var orch = bs.reconstructQueue;
    if (!orch || typeof orch.cancelGameKeepPartial !== 'function') return false;
    orch.cancelGameKeepPartial(gid, method);
    return true;
  } catch (e) {
    return false;
  }
}

function cancelSearch() {
  if (window.searchManager) window.searchManager.cancel();
}

function cancelGreedySearch() {
  if (_cancelBatchBoundMethod('greedy')) return;
  if (window.searchManager) window.searchManager.cancelMethod('greedy');
}

function cancelBeamSearch() {
  if (_cancelBatchBoundMethod('beam')) return;
  if (window.searchManager) window.searchManager.cancelMethod('beam');
}

function cancelDijkstraSearch() {
  if (_cancelBatchBoundMethod('dijkstra')) return;
  if (window.searchManager) window.searchManager.cancelMethod('dijkstra');
}

// =============================================================================
// INITIALIZE
// =============================================================================

document.addEventListener('DOMContentLoaded', function() {
  // Search buttons
  var greedyBtn = document.getElementById('btn-greedy-search');
  var beamBtn = document.getElementById('btn-beam-search');
  var dijkstraBtn = document.getElementById('btn-dijkstra-search');
  if (greedyBtn) greedyBtn.addEventListener('click', runGreedySearch);
  if (beamBtn) beamBtn.addEventListener('click', runBeamSearch);
  if (dijkstraBtn) dijkstraBtn.addEventListener('click', runDijkstraSearch);

  var rerunAllBtn = document.getElementById('btn-rerun-all');
  var cancelAllBtn = document.getElementById('btn-cancel-all');
  if (rerunAllBtn) rerunAllBtn.addEventListener('click', runAllSearches);
  if (cancelAllBtn) cancelAllBtn.addEventListener('click', cancelSearch);

  // Per-panel cancel buttons
  var cancelGreedyBtn = document.getElementById('btn-cancel-greedy');
  var cancelBeamBtn = document.getElementById('btn-cancel-beam');
  var cancelDijkstraBtn = document.getElementById('btn-cancel-dijkstra');
  if (cancelGreedyBtn) cancelGreedyBtn.addEventListener('click', cancelGreedySearch);
  if (cancelBeamBtn) cancelBeamBtn.addEventListener('click', cancelBeamSearch);
  if (cancelDijkstraBtn) cancelDijkstraBtn.addEventListener('click', cancelDijkstraSearch);

  // Phase 3: Review Solution buttons — launch guided verification walkthrough.
  function reviewResult(method, result) {
    if (!result || !window.VerificationUI) return;
    var gameId = (window.BatchGameList && window.BatchGameList.batchState &&
                  window.BatchGameList.batchState.currentGameId) || 'current';
    var ocrResult = null;
    if (window.BatchGameList && window.BatchGameList.batchState) {
      ocrResult = window.BatchGameList.batchState.ocrResults[gameId] || null;
    }
    window.VerificationUI.enterVerificationMode(
      gameId,
      { method: method, result: result },
      ocrResult
    );
  }
  var reviewGreedyBtn = document.getElementById('btn-review-greedy');
  var reviewBeamBtn = document.getElementById('btn-review-beam');
  var reviewDijkstraBtn = document.getElementById('btn-review-dijkstra');
  if (reviewGreedyBtn) reviewGreedyBtn.addEventListener('click', function() { reviewResult('greedy', greedyResult); });
  if (reviewBeamBtn) reviewBeamBtn.addEventListener('click', function() { reviewResult('beam', beamResult); });
  if (reviewDijkstraBtn) reviewDijkstraBtn.addEventListener('click', function() { reviewResult('dijkstra', dijkstraResult); });

  // Wire up search-manager callbacks
  if (window.searchManager) {
    window.searchManager.onStepUpdate = handleSearchStep;
    window.searchManager.onComplete = handleSearchComplete;
    window.searchManager.onStatusChange = handleSearchStatusChange;
  }
});
