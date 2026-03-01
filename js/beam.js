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
  showApplyButton(panel, false);
  var cancelBtn = document.getElementById('btn-cancel-' + panel);
  if (cancelBtn) cancelBtn.classList.add('hidden');
}

function showSearchPanels(show) {
  var el = document.getElementById('search-progress');
  if (!el) return;
  if (show) el.classList.remove('hidden');
}

function showApplyButton(panel, show) {
  var btn = document.getElementById('btn-apply-' + panel);
  if (btn) {
    if (show) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
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
      ocrMoves.push({ num: m.num, color: 'w', move: m.white, confidence: m.wConf || 0.9, alternatives: alts });
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
      ocrMoves.push({ num: m.num, color: 'b', move: m.black, confidence: m.bConf || 0.9, alternatives: alts });
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
        '<span class="text-blue-300">Beam iter ' + (step.iteration || '?') + ': ' +
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
    } else {
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

  if (result.status === 'SOLVED' || result.status === 'VALID') {
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
  } else {
    appendPanelLogHtml(panel,
      '<span class="text-yellow-400">' + (result.status || 'FAILED') +
      (fixes.length > 0 ? ' (' + fixes.length + ' fixes)' : '') + elapsed + '</span>'
    );
    // Dump partial result fixes too
    if (fixes.length > 0) {
      for (var i = 0; i < fixes.length; i++) {
        var f = fixes[i];
        var plyStr = f.ply_str || '';
        var ocr = f.ocr || f.original || '';
        var san = f.san || f.replacement || '';
        appendPanelLogHtml(panel,
          '<span class="text-yellow-400">  [fix] ' + plyStr + ': ' +
          ocr + ' \u2192 ' + san + '</span>'
        );
      }
    }
    updateSearchPanel(panel, (result.status || 'Failed') + elapsed, 0);
  }

  // Store result
  if (method === 'greedy') greedyResult = result;
  else if (method === 'beam') beamResult = result;
  else if (method === 'dijkstra') dijkstraResult = result;

  // Show Apply button if there are usable results
  if (result.status === 'SOLVED' || result.status === 'VALID' ||
      (fixes.length > 0)) {
    showApplyButton(panel, true);
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
    if (rerunBtn) rerunBtn.disabled = true;
  } else if (status === 'running') {
    updateSearchPanel(panel, 'Running...', 0);
    if (rerunBtn) rerunBtn.disabled = true;
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

  var ocrMoves = buildSearchOcrMoves(paired);

  // Show and clear panels
  showSearchPanels(true);
  clearPanelLog('greedy');
  clearPanelLog('beam');
  clearPanelLog('dijkstra');

  greedyResult = null;
  beamResult = null;
  dijkstraResult = null;

  // Check which searches are enabled for auto-run
  var methods = [];
  var methodOptions = {};
  if (!currentSettings || currentSettings.autorun_greedy) {
    methods.push('greedy');
    methodOptions.greedy = { max_fixes: 15 };
  }
  if (!currentSettings || currentSettings.autorun_beam) {
    methods.push('beam');
    methodOptions.beam = { beam_width: 5, max_iterations: 20, max_fixes_per_path: 10 };
  }
  if (!currentSettings || currentSettings.autorun_dijkstra) {
    methods.push('dijkstra');
    methodOptions.dijkstra = { max_queue_size: 50, max_steps: 1000, max_fixes_per_path: 15 };
  }

  if (methods.length === 0) {
    log('All background searches disabled in settings.');
    return;
  }

  log('Launching background searches (' + methods.join(' + ') + ')...');
  window.searchManager.launchSearches(ocrMoves, methods, methodOptions);
}

/**
 * Manual greedy button click.
 */
function runGreedySearch() {
  if (window.searchManager && window.searchManager.isRunning) {
    log('Search already in progress');
    return;
  }
  if (!state.moves || state.moves.length === 0) {
    log('No moves to search');
    return;
  }

  showSearchPanels(true);
  clearPanelLog('greedy');
  greedyResult = null;

  var ocrMoves = buildSearchOcrMoves();
  window.searchManager.launchSearches(ocrMoves, ['greedy'], {
    greedy: { max_fixes: 15 }
  });
}

/**
 * Manual beam button click.
 */
function runBeamSearch() {
  if (window.searchManager && window.searchManager.isRunning) {
    log('Search already in progress');
    return;
  }
  if (!state.moves || state.moves.length === 0) {
    log('No moves to search');
    return;
  }

  showSearchPanels(true);
  clearPanelLog('beam');
  beamResult = null;

  var ocrMoves = buildSearchOcrMoves();
  window.searchManager.launchSearches(ocrMoves, ['beam'], {
    beam: { beam_width: 5, max_iterations: 20, max_fixes_per_path: 10 }
  });
}

/**
 * Manual dijkstra button click.
 */
function runDijkstraSearch() {
  if (window.searchManager && window.searchManager.isRunning) {
    log('Search already in progress');
    return;
  }
  if (!state.moves || state.moves.length === 0) {
    log('No moves to search');
    return;
  }

  showSearchPanels(true);
  clearPanelLog('dijkstra');
  dijkstraResult = null;

  var ocrMoves = buildSearchOcrMoves();
  window.searchManager.launchSearches(ocrMoves, ['dijkstra'], {
    dijkstra: { max_queue_size: 50, max_steps: 1000, max_fixes_per_path: 15 }
  });
}

// =============================================================================
// CANCEL
// =============================================================================

function cancelSearch() {
  if (window.searchManager) window.searchManager.cancel();
}

function cancelGreedySearch() {
  if (window.searchManager) window.searchManager.cancelMethod('greedy');
}

function cancelBeamSearch() {
  if (window.searchManager) window.searchManager.cancelMethod('beam');
}

function cancelDijkstraSearch() {
  if (window.searchManager) window.searchManager.cancelMethod('dijkstra');
}

// =============================================================================
// APPLY SEARCH RESULT (user clicks Apply button)
// =============================================================================

function applyGreedyResult() {
  if (greedyResult) applySearchResult(greedyResult, 'greedy');
}

function applyBeamResult() {
  if (beamResult) applySearchResult(beamResult, 'beam');
}

function applyDijkstraResult() {
  if (dijkstraResult) applySearchResult(dijkstraResult, 'dijkstra');
}

function applySearchResult(data, method) {
  if (!data.moves || data.moves.length === 0) {
    log('No moves in search result');
    return;
  }

  var paired = [];
  for (var i = 0; i < data.moves.length; i += 2) {
    var num = Math.floor(i / 2) + 1;
    paired.push({
      num: num,
      white: data.moves[i] || '',
      black: data.moves[i + 1] || '',
      wStatus: 'ok',
      bStatus: data.moves[i + 1] ? 'ok' : 'pending',
      wConf: 0.9,
      bConf: 0.9
    });
  }

  if (data.fixes && data.fixes.length > 0) {
    data.fixes.forEach(function(fix) {
      var fixNum = Math.floor(fix.ply / 2) + 1;
      var fixColor = fix.ply % 2 === 0 ? 'w' : 'b';
      for (var j = 0; j < paired.length; j++) {
        if (paired[j].num === fixNum) {
          if (fixColor === 'w') {
            paired[j].wStatus = 'fixed';
            if (fix.ocr && fix.ocr !== fix.san) {
              paired[j].wOriginal = fix.ocr;
              showAutoFixFlash(fix.ocr, fix.san, 0, method + ' fix');
            }
          } else {
            paired[j].bStatus = 'fixed';
            if (fix.ocr && fix.ocr !== fix.san) {
              paired[j].bOriginal = fix.ocr;
              showAutoFixFlash(fix.ocr, fix.san, 0, method + ' fix');
            }
          }
          break;
        }
      }
    });
  }

  state.moves = paired;
  state.sans = data.moves.slice();
  state.stuckPly = null;
  state.stuckInfo = null;
  state.errorArrow = null;
  state.fixArrow = null;
  state.ocrArrow = null;

  var statusText = data.status === 'SOLVED' ? 'All moves valid!' : 'Partial result';
  var fixCount = (data.fixes || []).length;
  document.getElementById('stuck-info').innerHTML =
    '<span class="text-green-400">' + statusText + '</span> ' +
    '<span class="text-blue-300 text-xs">(' + method + ': ' + fixCount + ' fixes)</span>';

  if (data.status === 'SOLVED' || data.status === 'VALID') {
    document.getElementById('fix-list').innerHTML =
      '<div class="text-green-400 text-sm p-4 text-center">Game completed by ' + method + ' search!</div>';
  } else {
    document.getElementById('fix-list').innerHTML =
      '<div class="text-yellow-400 text-sm p-4 text-center">Partial result - some issues remain</div>';
  }

  document.getElementById('source-preview').classList.add('hidden');
  resetApplyButton();

  renderMoveList();
  renderArrows();
  goToPly(state.sans.length);

  log('Applied ' + fixCount + ' ' + method + ' fixes');
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

  // Per-panel cancel buttons
  var cancelGreedyBtn = document.getElementById('btn-cancel-greedy');
  var cancelBeamBtn = document.getElementById('btn-cancel-beam');
  var cancelDijkstraBtn = document.getElementById('btn-cancel-dijkstra');
  if (cancelGreedyBtn) cancelGreedyBtn.addEventListener('click', cancelGreedySearch);
  if (cancelBeamBtn) cancelBeamBtn.addEventListener('click', cancelBeamSearch);
  if (cancelDijkstraBtn) cancelDijkstraBtn.addEventListener('click', cancelDijkstraSearch);

  // Per-panel apply buttons
  var applyGreedyBtn = document.getElementById('btn-apply-greedy');
  var applyBeamBtn = document.getElementById('btn-apply-beam');
  var applyDijkstraBtn = document.getElementById('btn-apply-dijkstra');
  if (applyGreedyBtn) applyGreedyBtn.addEventListener('click', applyGreedyResult);
  if (applyBeamBtn) applyBeamBtn.addEventListener('click', applyBeamResult);
  if (applyDijkstraBtn) applyDijkstraBtn.addEventListener('click', applyDijkstraResult);

  // Wire up search-manager callbacks
  if (window.searchManager) {
    window.searchManager.onStepUpdate = handleSearchStep;
    window.searchManager.onComplete = handleSearchComplete;
    window.searchManager.onStatusChange = handleSearchStatusChange;
  }
});
