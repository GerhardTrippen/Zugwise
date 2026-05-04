// =============================================================================
// UI HELPERS - Generic UI functions
// =============================================================================

function showProcessing(show, text){
  var overlay = document.getElementById('processing-overlay');
  if(overlay) overlay.classList.toggle('hidden', !show);
  var textEl = document.getElementById('processing-text');
  if(text && textEl) textEl.textContent = text;
}

function showCalculating(show){
  document.getElementById('calculating-fixes').classList.toggle('hidden', !show);
}

// NOTE: showBeamSearch removed - replaced by showSearchProgress in beam.js

function toggleInputArea(collapsed){
  document.getElementById('input-collapsed').classList.toggle('hidden', !collapsed);
  document.getElementById('input-collapsed').classList.toggle('flex', collapsed);
  document.getElementById('input-expanded').classList.toggle('hidden', collapsed);
  // Show/hide OCR download button based on whether we have OCR data
  var hasOcr = state.ocrCells && state.ocrCells.length > 0;
  var isDual = state.ocrCellsSheet1 && state.ocrCellsSheet1.length > 0;
  // In dual mode, show per-sheet buttons instead of the single combined one
  document.getElementById('btn-download-ocr').classList.toggle('hidden', !collapsed || !hasOcr || isDual);
  var btn1 = document.getElementById('btn-download-ocr-sheet1');
  var btn2 = document.getElementById('btn-download-ocr-sheet2');
  if (btn1) btn1.classList.toggle('hidden', !collapsed || !isDual);
  if (btn2) btn2.classList.toggle('hidden', !collapsed || !isDual);
  // Reset button: visible whenever a game is loaded with OCR data, in either
  // single-game or batch mode (batch delegates to its own reset path).
  var btnReset = document.getElementById('btn-reset-reconstruct');
  if (btnReset) {
    var batchActive = !!(window.BatchGameList && window.BatchGameList.batchState && window.BatchGameList.batchState.active);
    btnReset.classList.toggle('hidden', !collapsed || (!hasOcr && !batchActive));
  }

  // Populate scoresheet image links next to "Moves" header
  var linksEl = document.getElementById('scoresheet-links');
  if (linksEl) {
    linksEl.innerHTML = '';
    if (collapsed && typeof sheetsState !== 'undefined') {
      var players = ['player1', 'player2'];
      var labels = ['P1', 'P2'];
      for (var p = 0; p < players.length; p++) {
        var sheets = sheetsState[players[p]];
        if (!sheets) continue;
        for (var s = 0; s < sheets.length; s++) {
          if (sheets[s] && sheets[s].image) {
            var label = labels[p] + '.' + (s + 1);
            var link = document.createElement('a');
            link.className = 'text-xs text-gray-500 hover:text-blue-400 cursor-pointer';
            link.title = 'View scoresheet ' + label;
            link.textContent = '📄' + label;
            link.dataset.player = p + 1;
            link.dataset.sheet = s;
            link.onclick = function() {
              var pl = this.dataset.player;
              var sh = this.dataset.sheet;
              var sheet = sheetsState['player' + pl][sh];
              if (sheet && sheet.image) {
                var w = window.open('', '_blank');
                w.document.write('<html><head><title>Scoresheet P' + pl + '.' + (parseInt(sh)+1) + '</title>' +
                  '<style>body{margin:0;background:#111;display:flex;justify-content:center;align-items:start}' +
                  'img{max-width:100%;height:auto}</style></head>' +
                  '<body><img src="' + sheet.image + '"></body></html>');
                w.document.close();
              }
            };
            linksEl.appendChild(link);
          }
        }
      }
    }
  }

  // Reset panel layout when switching away from dual-sheet mode
  var mainEl = document.getElementById('main-content');
  var panelBoard = document.getElementById('panel-board');
  var panelMoves = document.getElementById('panel-moves');
  var inputBar = document.getElementById('input-bar');
  if (!isDual && mainEl && panelBoard && panelMoves) {
    mainEl.classList.add('max-w-7xl');
    panelBoard.classList.remove('col-span-3');
    panelBoard.classList.add('col-span-4');
    panelMoves.classList.remove('col-span-5');
    panelMoves.classList.add('col-span-4');
    if (inputBar) inputBar.classList.add('max-w-7xl');
  }
}

function log(msg){
  var el = document.getElementById('debug-log');
  var div = document.createElement('div');
  div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  console.log(msg);
}

/**
 * Log an image to the debug panel as a clickable thumbnail.
 * Useful for grid detection debug overlays.
 * @param {string} dataUrl - Base64 data URL of the image
 * @param {string} label - Description shown next to the image
 */
function logImage(dataUrl, label) {
  if (!dataUrl) return;
  var el = document.getElementById('debug-log');
  var container = document.createElement('div');
  container.className = 'my-1';

  var labelSpan = document.createElement('span');
  labelSpan.textContent = '[' + new Date().toLocaleTimeString() + '] ' + (label || 'Debug image') + ' ';
  container.appendChild(labelSpan);

  // Convert data URL to Blob URL for reliable "open in new tab"
  // (data URLs are often blocked or truncated by browsers)
  function dataUrlToBlobUrl(dataUrl) {
    try {
      var parts = dataUrl.split(',');
      var mime = parts[0].match(/:(.*?);/)[1];
      var binary = atob(parts[1]);
      var arr = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      var blob = new Blob([arr], { type: mime });
      return URL.createObjectURL(blob);
    } catch (e) {
      return dataUrl; // fallback
    }
  }
  var blobUrl = dataUrlToBlobUrl(dataUrl);

  var link = document.createElement('a');
  link.href = blobUrl;
  link.target = '_blank';
  link.textContent = '(open full size)';
  link.className = 'text-blue-400 underline';
  container.appendChild(link);

  var img = document.createElement('img');
  img.src = dataUrl;
  img.style.maxWidth = '100%';
  img.style.maxHeight = '200px';
  img.style.marginTop = '4px';
  img.style.border = '1px solid #4B5563';
  img.style.borderRadius = '4px';
  img.style.cursor = 'pointer';
  img.title = 'Click to open full size';
  img.onclick = function() { window.open(blobUrl, '_blank'); };
  container.appendChild(img);

  el.appendChild(container);
  el.scrollTop = el.scrollHeight;
  console.log('[DEBUG IMAGE] ' + (label || 'Debug image'));
}

window.logImage = logImage;

// =============================================================================
// Tournament / pairing header above the move list
// =============================================================================
// Populated in batch mode when a tournament file has been loaded AND the open
// game matched a pairing. Hidden otherwise (single-game uploads, or batch games
// with no pairing match). See #game-header in index.html.

function renderGameHeader(game, tournamentData) {
  var hostEl = document.getElementById('game-header');
  if (!hostEl) return;

  var pairing = game && game.pairing;
  // Panel is strictly a pairing surface — no pairing, nothing to show. The
  // tournament name already lives in the Step-1 status line of the Batch
  // panel and doesn't need to be repeated here.
  if (!pairing) {
    hostEl.classList.add('hidden');
    return;
  }

  // Round / Board / Date / Section line.
  var parts = [];
  if (game.round != null) parts.push('Round ' + game.round);
  if (game.board != null) parts.push('Board ' + game.board);
  if (pairing.date) parts.push(pairing.date);
  else if (tournamentData && tournamentData.startDate)
    parts.push(tournamentData.startDate);
  if (game.section) parts.push(game.section);
  var roundInfoEl = document.getElementById('game-header-roundinfo');
  if (roundInfoEl) roundInfoEl.textContent = parts.join(' · ');

  // Player lines: "Title Name (Rating)" for each colour.
  function _formatPlayerLine(title, name, rating) {
    if (!name) return '';
    var out = '';
    if (title) out += title + ' ';
    out += name;
    if (rating) out += ' (' + rating + ')';
    return out;
  }
  var whiteEl = document.getElementById('game-header-white');
  var blackEl = document.getElementById('game-header-black');
  if (whiteEl) whiteEl.textContent = _formatPlayerLine(pairing.whiteTitle,
                                                       pairing.whiteName,
                                                       pairing.whiteRtg);
  if (blackEl) blackEl.textContent = _formatPlayerLine(pairing.blackTitle,
                                                       pairing.blackName,
                                                       pairing.blackRtg);

  var resultEl = document.getElementById('game-header-result');
  if (resultEl) {
    var res = pairing.result || '';
    resultEl.textContent = (res && res !== '*') ? res : '';
  }

  hostEl.classList.remove('hidden');
}

function clearGameHeader() {
  var hostEl = document.getElementById('game-header');
  if (hostEl) hostEl.classList.add('hidden');
}

window.renderGameHeader = renderGameHeader;
window.clearGameHeader = clearGameHeader;

function resetApplyButton(){
  var applyBtn = document.getElementById('btn-apply');
  applyBtn.disabled = true;
  applyBtn.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-gray-700 text-gray-500 cursor-not-allowed';
  applyBtn.textContent = 'Select a fix';
  state.selectedFix = null;
  state.errorArrow = null;
  state.fixArrow = null;
  state.ocrArrow = null;
  hideFixDetails();
}

// Count changes between original and corrected move
function countMoveChanges(original, corrected) {
  if (!original || !corrected) return 0;
  var changes = 0;

  // Piece change
  var origPiece = (original[0] && 'KQRBN'.indexOf(original[0]) >= 0) ? original[0] : 'P';
  var corrPiece = (corrected[0] && 'KQRBN'.indexOf(corrected[0]) >= 0) ? corrected[0] : 'P';
  if (origPiece !== corrPiece) changes++;

  // Extract destination (last 2 chars that look like a square)
  function getDest(san) {
    var clean = san.replace(/[+#x]/g, '');
    for (var i = clean.length - 1; i > 0; i--) {
      if ('12345678'.indexOf(clean[i]) >= 0 && 'abcdefgh'.indexOf(clean[i-1]) >= 0) {
        return clean.substring(i-1, i+1);
      }
    }
    if (clean.length >= 2 && 'abcdefgh'.indexOf(clean[0]) >= 0 && '12345678'.indexOf(clean[1]) >= 0) {
      return clean.substring(0, 2);
    }
    return null;
  }

  var origDest = getDest(original);
  var corrDest = getDest(corrected);
  if (origDest && corrDest) {
    if (origDest[0] !== corrDest[0]) changes++; // File
    if (origDest[1] !== corrDest[1]) changes++; // Rank
  }

  // Capture notation
  if ((original.indexOf('x') >= 0) !== (corrected.indexOf('x') >= 0)) changes++;

  return changes;
}

function showAutoFixFlash(original, corrected, numChanges, label, duration) {
  // Calculate if not provided
  if (typeof numChanges !== 'number') {
    numChanges = countMoveChanges(original, corrected);
  }

  // Use custom label or default
  var displayLabel = label || 'Quick Fix';

  // Default duration 2.5s, but allow shorter for sequential flashes
  var displayDuration = duration || 2500;

  // Color and icon based on label type
  var colorClass, bgClass, borderClass, icon;
  if (label === 'OCR candidate') {
    colorClass = 'text-cyan-400';
    bgClass = 'bg-cyan-900';
    borderClass = 'border-cyan-700';
    icon = '🔄';
  } else if (label === 'Fixed') {
    // Manual fix by user - always green with checkmark
    colorClass = 'text-green-400';
    bgClass = 'bg-green-900';
    borderClass = 'border-green-700';
    icon = '✓';
  } else {
    // Quick fix (similarity) - color based on number of changes, show ⚡
    icon = '⚡';
    if (numChanges <= 1) {
      colorClass = 'text-green-400';
      bgClass = 'bg-green-900';
      borderClass = 'border-green-700';
    } else if (numChanges === 2) {
      colorClass = 'text-yellow-400';
      bgClass = 'bg-yellow-900';
      borderClass = 'border-yellow-700';
    } else {
      colorClass = 'text-red-400';
      bgClass = 'bg-red-900';
      borderClass = 'border-red-700';
    }
  }

  // Create flash element
  var flash = document.createElement('div');
  flash.className = 'fixed bottom-4 right-4 ' + bgClass + ' border ' + borderClass + ' px-4 py-3 rounded-lg shadow-xl z-50 flex items-center gap-3';
  flash.innerHTML =
    '<div>' +
      '<div class="text-xs text-gray-400 uppercase tracking-wide">' + displayLabel + '</div>' +
      '<div class="font-mono">' +
        '<span class="text-gray-400">' + original + '</span>' +
        '<span class="text-gray-500 mx-1">→</span>' +
        '<span class="' + colorClass + ' font-bold">' + corrected + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="flex items-center justify-center w-8 h-8 rounded-full ' + bgClass + ' border ' + borderClass + ' ' + colorClass + ' font-bold">' +
      icon +
    '</div>';

  document.body.appendChild(flash);

  // Remove after duration with fade
  setTimeout(function() {
    flash.style.transition = 'opacity 0.3s';
    flash.style.opacity = '0';
    setTimeout(function() { flash.remove(); }, 300);
  }, displayDuration);
}

// Flash through corrections sequentially with board position updates
function flashCorrectionsSequentially(corrections, callback) {
  if (!corrections || corrections.length === 0) {
    if (callback) callback();
    return;
  }

  var index = 0;
  var flashDuration = 800; // Show each correction for 800ms

  function flashNext() {
    if (index >= corrections.length) {
      // All done - call completion callback
      if (callback) callback();
      return;
    }

    var c = corrections[index];

    // Update board to show position AFTER this corrected move
    goToPly(c.ply);

    // Show the flash notification (shorter duration for sequential)
    showAutoFixFlash(c.orig, c.san, 0, c.label, flashDuration - 100);

    index++;

    // Schedule next flash
    setTimeout(flashNext, flashDuration);
  }

  // Start the sequence
  flashNext();
}

function renderMoveList(){
  var tbody = document.getElementById('move-tbody');
  // Preserve the user's scroll position across the rebuild. innerHTML='' wipes
  // all rows, which can reset container.scrollTop to 0 in some browsers. If
  // the user had scrolled down to look at a region, this would snap them back
  // to the top. We restore inside requestAnimationFrame so the new rows have
  // had a layout pass and scrollTop can actually take effect.
  // If scrollTop was already 0 (e.g., initial load), the restore is a no-op.
  // Anything that genuinely needs to move the viewport (a new stuck point,
  // explicit goToPly navigation) calls scrollCurrentMoveIntoView AFTER
  // renderMoveList returns and overrides this restore.
  var _msContainer = document.getElementById('move-list-container');
  var _msSavedScrollTop = _msContainer ? _msContainer.scrollTop : 0;
  tbody.innerHTML = '';
  var valid = 0, total = 0;

  // Detect suspicious tail (low confidence moves at end + repetition run)
  var suspiciousTailStart = detectSuspiciousTail();
  if(suspiciousTailStart === null) suspiciousTailStart = detectRepeatingTail();
  if(suspiciousTailStart === null) suspiciousTailStart = detectTrailingNoise();

  state.moves.forEach(function(m, idx){
    var tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-700/30';
    tr.id = 'move-row-' + m.num;

    // Check if this move is in the suspicious tail
    var wPly = idx * 2;
    var bPly = idx * 2 + 1;
    var wSuspicious = suspiciousTailStart !== null && wPly >= suspiciousTailStart;
    var bSuspicious = suspiciousTailStart !== null && bPly >= suspiciousTailStart;

    var cls = function(s){
      return {ok:'move-ok', error:'move-error', fixed:'move-fixed', locked:'move-locked', pending:'move-pending'}[s] || 'move-ok';
    };
    var icon = function(s, orig, num, color){
      if(s === 'fixed' && orig){
        return ' <span class="revert-fix cursor-pointer text-green-400 hover:text-green-300" data-num="' + num + '" data-color="' + color + '" title="was: ' + orig + ' — double-click to revert">✓</span>';
      }
      return {error:' ❌', fixed:' ✓', locked:' 🔒'}[s] || '';
    };
    var confInd = function(c){
      if(!c || c >= 0.7) return '';
      return ' <span class="text-red-400 text-xs">(' + Math.round(c*100) + '%)</span>';
    };
    // Correction indicator: 🔄 for OCR candidate, ⚡ for similarity fix.
    // Hidden when status is fixed/locked (the ✓/🔒 icon already conveys
    // "corrected") OR when the cell is an algorithm proposal — those have
    // their own review affordance (the strike-through <s>old</s>→new in
    // review mode) and shouldn't flash ⚡ too, which is reserved for
    // validate_moves quick-fixes and misleads the user into thinking the
    // algorithm's choice was a similarity-fix swap.
    var corrInd = function(orig, isOcrAlt, status, isAlgoProposed){
      if(!orig) return '';
      if(status === 'fixed' || status === 'locked') return '';
      if(isAlgoProposed) return '';
      if(isOcrAlt){
        return ' <span class="text-cyan-400 text-xs cursor-help" title="Auto-corrected from: ' + orig + '">🔄</span>';
      }
      return ' <span class="text-yellow-400 text-xs cursor-help" title="Auto-corrected from: ' + orig + '">⚡</span>';
    };
    // Delete button for suspicious tail moves (OCR noise)
    var deleteBtn = function(ply, color){
      return ' <span class="text-red-400/60 hover:text-red-400 text-xs cursor-pointer delete-from-here" ' +
             'data-ply="' + ply + '" title="Delete from here (remove OCR noise)">🗑️</span>';
    };

    // Tier indicator for dual-sheet mode — shows agreement status (static), not legality
    var tierInd = function(ply) {
      if (!state.mergeTierMap) return '';
      // Use agreement metadata from ocrCells (static, doesn't depend on legality)
      var cell = state.ocrCells ? state.ocrCells.find(function(c) {
        return (c.num - 1) * 2 + (c.color === 'w' ? 0 : 1) === ply;
      }) : null;
      if (!cell) return '';
      var sheetCount = cell._sheetCount || 1;
      var agree = cell._agree;
      if (sheetCount === 2 && agree) {
        return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1" title="Both sheets agree"></span>';
      } else if (sheetCount === 1) {
        return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 mr-1" title="Only one sheet"></span>';
      } else {
        return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-red-400 mr-1" title="Sheets disagree"></span>';
      }
    };

    if(m.white){ total++; if(m.wStatus === 'ok' || m.wStatus === 'fixed' || m.wStatus === 'locked') valid++; }
    if(m.black){ total++; if(m.bStatus === 'ok' || m.bStatus === 'fixed' || m.bStatus === 'locked') valid++; }

    var wTd = document.createElement('td');
    var wClass = 'py-1 pl-2 cursor-pointer ' + cls(m.wStatus) + (m.wOriginal ? ' move-corrected' : '');
    if(wSuspicious) wClass += ' bg-red-900/20';
    wTd.className = wClass;
    wTd.title = m.wOriginal ? 'was: ' + m.wOriginal + (m.wStatus === 'fixed' ? ' — double-click ✓ to revert' : '') : 'Click to view • Double-click to edit • Right-click for insert/delete';
    wTd.innerHTML = tierInd(wPly) + (m.white || '') + corrInd(m.wOriginal, m.wOcrAlt, m.wStatus, m.wAlgoProposed) + confInd(m.wConf) + icon(m.wStatus, m.wOriginal, m.num, 'w') + (wSuspicious ? deleteBtn(wPly, 'w') : '');
    wTd.onclick = function(e){ if(!e.target.classList.contains('delete-from-here')) goToPly(idx*2 + 1, { skipScroll: true }); };
    wTd.ondblclick = function(e){ if(e.target.classList.contains('delete-from-here')) return; if(e.target.classList.contains('revert-fix')){ e.stopPropagation(); revertToOriginalOcr(parseInt(e.target.dataset.num), e.target.dataset.color); return; } e.stopPropagation(); enterEditMode(m.num, 'w'); };
    wTd.oncontextmenu = function(e){ e.preventDefault(); showMoveContextMenu(e, idx*2, m.num, 'w'); };

    var bTd = document.createElement('td');
    var bClass = 'py-1 pl-2 cursor-pointer ' + cls(m.bStatus) + (m.bOriginal ? ' move-corrected' : '');
    if(bSuspicious) bClass += ' bg-red-900/20';
    bTd.className = bClass;
    bTd.title = m.bOriginal ? 'was: ' + m.bOriginal + (m.bStatus === 'fixed' ? ' — double-click ✓ to revert' : '') : 'Click to view • Double-click to edit • Right-click for insert/delete';
    bTd.innerHTML = tierInd(bPly) + (m.black || '') + corrInd(m.bOriginal, m.bOcrAlt, m.bStatus, m.bAlgoProposed) + confInd(m.bConf) + icon(m.bStatus, m.bOriginal, m.num, 'b') + (bSuspicious && m.black ? deleteBtn(bPly, 'b') : '');
    bTd.onclick = function(e){ if(!e.target.classList.contains('delete-from-here')) goToPly(idx*2 + 2, { skipScroll: true }); };
    bTd.ondblclick = function(e){ if(e.target.classList.contains('delete-from-here')) return; if(e.target.classList.contains('revert-fix')){ e.stopPropagation(); revertToOriginalOcr(parseInt(e.target.dataset.num), e.target.dataset.color); return; } e.stopPropagation(); enterEditMode(m.num, 'b'); };
    bTd.oncontextmenu = function(e){ e.preventDefault(); showMoveContextMenu(e, idx*2+1, m.num, 'b'); };

    var numTd = document.createElement('td');
    numTd.className = 'text-gray-500 py-1';
    numTd.textContent = m.num + '.';

    tr.appendChild(numTd);
    tr.appendChild(wTd);
    tr.appendChild(bTd);
    tbody.appendChild(tr);
  });

  // Add click handlers for delete buttons
  document.querySelectorAll('.delete-from-here').forEach(function(btn){
    btn.onclick = function(e){
      e.stopPropagation();
      var ply = parseInt(btn.getAttribute('data-ply'));
      showDeleteConfirmation(ply);
    };
  });

  var status = '✅ ' + valid + '/' + total;
  if(state.stuckInfo) status += ' • <span class="text-red-400">❌ ' + state.stuckInfo.num + '.' + state.stuckInfo.color.toUpperCase() + '</span>';
  document.getElementById('move-status').innerHTML = status;

  // Restore the preserved scroll position SYNCHRONOUSLY. rAF restoration
  // races when renderMoveList is called multiple times in rapid succession
  // (the second call captures scrollTop=0 from the wipe before the first
  // rAF fires, then both rAFs race and the second wins → list at 0).
  // Synchronous restore happens before the caller can do anything else;
  // any subsequent goToPly's scrollCurrentMoveIntoView runs AFTER and can
  // override if it really needs to (e.g., new stuck point centering).
  if (_msContainer && _msSavedScrollTop > 0) {
    _msContainer.scrollTop = _msSavedScrollTop;
  }
  // Diagnostic — gated on a flag the user can flip in DevTools to debug
  // stuck-at-1 reports without flooding the console for everyone else.
  if (state._debugScroll) {
    var nowTop = _msContainer ? _msContainer.scrollTop : 'no-container';
    console.log('[renderMoveList] saved=' + _msSavedScrollTop +
                ' restored=' + nowTop +
                ' rows=' + (state.moves ? state.moves.length : 0) +
                ' currentPly=' + state.currentPly +
                ' stuckPly=' + state.stuckPly +
                ' lastScrolledStuckPly=' + state.lastScrolledStuckPly);
  }
}

/**
 * Get complexity level of a move (0-2):
 * - 2 = HIGHLY complex (captures, checks, castling, promotion) - very unlikely noise
 * - 1 = MODERATE (piece move without capture/check, like Kb3, Rd7) - less likely noise
 * - 0 = SIMPLE (pawn moves like c4, e5, d6) - could easily be noise
 *
 * Note: Game results written on scoresheet (1-0, ½-½) often OCR as simple
 * piece moves like "Kb3" - so we can't fully trust piece moves without
 * captures/checks.
 */
function getMoveComplexity(san){
  if(!san || san.length < 2) return 0;

  // HIGHLY complex (level 2): captures, checks, castling, promotion
  // These are very unlikely to come from OCR noise
  if(san.indexOf('x') >= 0) return 2;  // Capture
  if(san.indexOf('+') >= 0 || san.indexOf('#') >= 0) return 2;  // Check/mate
  if(san.indexOf('O') >= 0 || san.indexOf('0') >= 0) return 2;  // Castling
  if(san.indexOf('=') >= 0) return 2;  // Promotion

  // MODERATE complexity (level 1): piece moves without capture/check
  // Could be real, but "Kb3" could also be OCR misreading "1-0"
  if('KQRBN'.indexOf(san[0]) >= 0) return 1;

  // Pawn captures without 'x' (like "ed5") are moderate
  if(san.length >= 3 && 'abcdefgh'.indexOf(san[0]) >= 0 && 'abcdefgh'.indexOf(san[1]) >= 0) return 1;

  // SIMPLE (level 0): basic pawn moves like "e4", "c5", "d6"
  return 0;
}

/**
 * Detect where the "suspicious tail" starts - low confidence moves at the end.
 * Returns the ply index where suspicious tail starts, or null if no suspicious tail.
 *
 * SMARTER DETECTION: Scan backwards from end to find where OCR noise starts.
 * Uses 3-tier complexity system:
 * - Highly complex (Qxb4+, Bc6+, O-O): very unlikely noise, low threshold
 * - Moderate (Kb3, Rd7): could be misread game result, medium threshold
 * - Simple (c4, b4, d6): likely noise, high threshold
 */
function detectSuspiciousTail(){
  // After user has done cleanup, don't re-detect (they made their choice)
  if(state.noiseCleanupDone) return null;

  if(!state.moves || state.moves.length < 3) return null;

  // Different confidence thresholds by complexity level
  // Aggressive thresholds are OK: user must click 🗑️ to confirm deletion
  var THRESHOLD_SIMPLE = 0.60;     // Level 0: pawn moves need 60%+
  var THRESHOLD_MODERATE = 0.60;   // Level 1: piece moves need 60%+ (signatures can misread as piece moves)
  var THRESHOLD_COMPLEX = 0.30;    // Level 2: captures/checks need 30%+
  var MIN_SUSPICIOUS = 3;  // Need at least 3 suspicious moves total
  var GOOD_STREAK_TO_STOP = 4;  // 4 consecutive good moves = real game, stop scanning (signatures can produce 1-2 confident noise moves)

  // Build flat list with move info. Use REAL game ply derived from m.num
  // so a game with missing cells produces indices the renderer's
  // comparison (wPly = stateIdx * 2) can match against. Flat-list index
  // diverges from real ply when Black is blank for several consecutive
  // rows (state.moves index stays 0-based contiguous but real ply jumps).
  var moves = [];
  state.moves.forEach(function(m){
    if(m.white) moves.push({ply: (m.num - 1) * 2, conf: m.wConf || 0.9, san: m.white});
    if(m.black) moves.push({ply: (m.num - 1) * 2 + 1, conf: m.bConf || 0.9, san: m.black});
  });

  if(moves.length < 4) return null;

  // Determine if each move is "suspicious" based on complexity + confidence
  // PLUS a structural same-SAN-as-neighbor check. In real chess no player
  // plays the same SAN twice in a row, and two consecutive identical SANs
  // across White/Black (e.g. W plays c4 then B plays c4) requires a very
  // specific piece constellation — three in a row is essentially impossible.
  // When OCR reads a scribble / signature / blank as the same simple SAN
  // over and over, each instance scores high confidence on its own, so the
  // confidence-only check used to let a "c4 c4 c4 c4" run count as 4
  // "consecutive good" moves and break the backward scan BEFORE it could
  // reach the low-confidence cells that preceded the run.
  function isSuspicious(mv, neighbor){
    var complexity = getMoveComplexity(mv.san);
    // Same-SAN rule catches scribble-scribble noise patterns (c4 c4 c4 …)
    // but EXEMPT captures/checks/castling/promotion (complexity 2). Those
    // can legitimately appear back-to-back — the canonical case is a
    // recapture on the same square: 35.B Rxd7 followed by 36.W Rxd7
    // means black's rook captured on d7 and white's rook recaptured.
    // Flagging that as noise stretched the noise window back past the
    // real game, dropping the suspicious-ratio below 50% and hiding
    // the genuine scribble tail from the user.
    if(complexity < 2 && neighbor && mv.san && neighbor.san && mv.san === neighbor.san){
      return true;
    }
    var threshold;
    if(complexity === 2) threshold = THRESHOLD_COMPLEX;
    else if(complexity === 1) threshold = THRESHOLD_MODERATE;
    else threshold = THRESHOLD_SIMPLE;
    return mv.conf < threshold;
  }

  // Scan backwards from end, looking for where noise starts
  // Stop when we find a streak of GOOD_STREAK_TO_STOP consecutive good moves
  var noiseStartCandidate = null;
  var consecutiveGood = 0;
  var suspiciousCount = 0;

  for(var i = moves.length - 1; i >= 0; i--){
    // Compare each cell against the NEXT-in-flat-order neighbor (which we
    // already scanned in the previous iteration since we're walking
    // backwards). Mid-run and run-start cells get flagged by the same-SAN
    // rule; only the tail cell has no neighbor.
    var neighbor = (i + 1 < moves.length) ? moves[i + 1] : null;
    if(isSuspicious(moves[i], neighbor)){
      suspiciousCount++;
      consecutiveGood = 0;
      noiseStartCandidate = i;
    } else {
      consecutiveGood++;
      if(consecutiveGood >= GOOD_STREAK_TO_STOP){
        break;
      }
    }
  }

  // Check if we found enough noise
  if(noiseStartCandidate === null || suspiciousCount < MIN_SUSPICIOUS){
    return null;
  }

  // Check the ratio of suspicious moves in the tail
  var tailLength = moves.length - noiseStartCandidate;
  var badRatio = suspiciousCount / tailLength;

  // If less than 50% are suspicious, probably not noise
  if(badRatio < 0.5){
    return null;
  }

  // Find the actual start: first suspicious move in the noisy region.
  // Same neighbor-aware check so the first cell of a same-SAN run gets
  // flagged even when its own confidence passes (c4@90% as the first
  // c4 in a run counts because c4@90% at idx+1 is its neighbor).
  for(var j = noiseStartCandidate; j < moves.length; j++){
    var jNeighbor = (j + 1 < moves.length) ? moves[j + 1] : null;
    if(isSuspicious(moves[j], jNeighbor)){
      return j;
    }
  }

  return noiseStartCandidate;
}

/**
 * Repetition-based tail detector. The confidence-only detectSuspiciousTail
 * misses the common noise pattern where a scribble / signature / blank row
 * gets OCR'd as the same simple SAN over and over (c4 c4 c4 c4 …) — each
 * instance is high-confidence on its own but the repetition is impossible
 * in real chess. A white pawn can only reach c4 once in a game; two
 * consecutive identical SANs in the flat list means W=X then B=X at the
 * next move, which requires an exactly-right piece constellation; three
 * in a row in real chess is essentially never legitimate.
 *
 * Returns the flat ply index of the first move in the longest run of
 * consecutive identical SANs at the tail, IF that run is length >= 3.
 * Otherwise null.
 */
function detectRepeatingTail(){
  if(state.noiseCleanupDone) return null;
  if(!state.moves || state.moves.length < 2) return null;

  // Use the REAL game ply (derived from m.num + color) rather than the
  // flat-list index. For games with missing cells (e.g. Black's column is
  // blank for several consecutive rows because the player stopped writing)
  // these diverge — flat-list index 86 could correspond to game ply 88,
  // and the renderer's `wPly = idx * 2` comparison would miss the first
  // row of the run.
  var moves = [];
  state.moves.forEach(function(m){
    if(m.white) moves.push({ply: (m.num - 1) * 2, san: m.white});
    if(m.black) moves.push({ply: (m.num - 1) * 2 + 1, san: m.black});
  });
  if(moves.length < 3) return null;

  // Walk backwards from the tail. Count the run of identical SANs.
  var tailSan = moves[moves.length - 1].san;
  if(!tailSan) return null;
  var runStartIdx = moves.length - 1;
  for(var i = moves.length - 2; i >= 0; i--){
    if(moves[i].san === tailSan){
      runStartIdx = i;
    } else {
      break;
    }
  }
  var runLen = moves.length - runStartIdx;
  if(runLen >= 3){
    if(typeof log === 'function'){
      var startPly = moves[runStartIdx].ply;
      var endPly = moves[moves.length - 1].ply;
      var startMv = Math.floor(startPly / 2) + 1 + '.' + (startPly % 2 === 0 ? 'W' : 'B');
      var endMv = Math.floor(endPly / 2) + 1 + '.' + (endPly % 2 === 0 ? 'W' : 'B');
      log('🗑️ Repeating SAN tail: "' + tailSan + '" x' + runLen +
          ' at ' + startMv + '..' + endMv + ' (flagged from ply ' + startPly + ')');
    }
    return moves[runStartIdx].ply;
  }
  return null;
}

/**
 * Check the very last 1-2 moves for low confidence, bypassing MIN_SUSPICIOUS.
 * Called after detectSuspiciousTail() returns null for the main scan.
 * Returns: ply index to flag from, or null.
 */
function detectTrailingNoise(){
  if(state.noiseCleanupDone) return null;
  if(!state.moves || state.moves.length < 3) return null;

  var THRESHOLD_MODERATE = 0.50;
  var THRESHOLD_PAIR = 0.55;

  // Build flat list with move info. Use REAL game ply derived from m.num
  // so a game with missing cells produces indices the renderer's
  // comparison (wPly = stateIdx * 2) can match against. Flat-list index
  // diverges from real ply when Black is blank for several consecutive
  // rows (state.moves index stays 0-based contiguous but real ply jumps).
  var moves = [];
  state.moves.forEach(function(m){
    if(m.white) moves.push({ply: (m.num - 1) * 2, conf: m.wConf || 0.9, san: m.white});
    if(m.black) moves.push({ply: (m.num - 1) * 2 + 1, conf: m.bConf || 0.9, san: m.black});
  });

  if(moves.length < 4) return null;

  var last = moves[moves.length - 1];
  var secondLast = moves[moves.length - 2];

  // Check pair FIRST (returns earlier ply, covering both moves)
  // If the last 2 moves both have confidence < 50% → flag from earlier one
  if(last.conf < THRESHOLD_PAIR && secondLast.conf < THRESHOLD_PAIR){
    return secondLast.ply;
  }

  // If only the absolute last move has confidence < 40% → flag it
  if(last.conf < THRESHOLD_MODERATE){
    return last.ply;
  }

  return null;
}

/**
 * Auto-truncate very obvious tail noise without user confirmation.
 * Only fires when ALL trailing moves are below 25% confidence and there are
 * at least 4 consecutive such moves. Returns the ply where truncation happened,
 * or null if no auto-truncation was done.
 *
 * This is intentionally extremely conservative — only fires for unmistakable
 * garbage (scribbles, blank cells, game results written on scoresheet).
 */
function autoTruncateObviousTail(){
  if(!state.moves || state.moves.length < 4) return null;
  if(state.noiseCleanupDone) return null;

  var CONFIDENCE_FLOOR = 0.25;  // Below this = almost certainly garbage
  var MIN_CONSECUTIVE = 4;      // Need 4+ in a row to be sure

  // Build flat list
  var moves = [];
  state.moves.forEach(function(m){
    if(m.white) moves.push({conf: m.wConf || 0.9, san: m.white});
    if(m.black) moves.push({conf: m.bConf || 0.9, san: m.black});
  });

  if(moves.length < MIN_CONSECUTIVE + 4) return null; // Don't truncate very short games

  // Scan backward: find how many consecutive trailing moves are below floor
  var trailingGarbage = 0;
  for(var i = moves.length - 1; i >= 0; i--){
    if(moves[i].conf < CONFIDENCE_FLOOR){
      trailingGarbage++;
    } else {
      break;
    }
  }

  if(trailingGarbage < MIN_CONSECUTIVE) return null;

  var truncPly = moves.length - trailingGarbage;
  log('🗑️ Auto-truncating ' + trailingGarbage + ' obvious noise moves from ply ' + truncPly + ' (all below ' + (CONFIDENCE_FLOOR * 100) + '% confidence)');

  // Truncate (deleteMovesFromPly now also truncates ocrCells + per-sheet arrays)
  deleteMovesFromPly(truncPly);

  return truncPly;
}

/**
 * Show inline delete confirmation instead of browser confirm() dialog.
 */
function showDeleteConfirmation(ply){
  // Remove any existing confirmation
  var existing = document.getElementById('delete-confirm-overlay');
  if(existing) existing.remove();

  var moveNum = Math.floor(ply / 2) + 1;
  var color = ply % 2 === 0 ? 'W' : 'B';
  var moveLabel = moveNum + '.' + color;

  var overlay = document.createElement('div');
  overlay.id = 'delete-confirm-overlay';
  overlay.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center';
  overlay.innerHTML =
    '<div class="bg-gray-800 border border-red-500/50 rounded-xl p-6 mx-4 max-w-sm shadow-2xl">' +
      '<div class="text-red-400 font-semibold mb-2">🗑️ Delete moves?</div>' +
      '<div class="text-gray-300 text-sm mb-4">Delete <span class="text-white font-mono">' + moveLabel + '</span> and all moves after it?</div>' +
      '<div class="flex gap-3">' +
        '<button id="delete-confirm-yes" class="flex-1 py-2 px-4 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold text-sm">Delete</button>' +
        '<button id="delete-confirm-no" class="flex-1 py-2 px-4 rounded-lg bg-gray-600 hover:bg-gray-500 text-gray-200 font-semibold text-sm">Cancel</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  document.getElementById('delete-confirm-yes').onclick = function(){
    overlay.remove();
    deleteMovesFromPly(ply);
  };
  document.getElementById('delete-confirm-no').onclick = function(){
    overlay.remove();
  };
  // Click outside to cancel
  overlay.onclick = function(e){
    if(e.target === overlay) overlay.remove();
  };
}

/**
 * Delete all moves from the given ply onwards.
 */
function deleteMovesFromPly(ply){
  if(!state.moves) return;

  log('🗑️ Deleting moves from ply ' + ply + ' onwards');

  // Calculate which move row and color
  var moveIdx = Math.floor(ply / 2);
  var isBlack = ply % 2 === 1;

  // Truncate state.moves
  if(isBlack){
    // Delete black move and all subsequent rows
    if(moveIdx < state.moves.length){
      state.moves[moveIdx].black = '';
      state.moves[moveIdx].bStatus = 'pending';
      state.moves[moveIdx].bConf = null;
      state.moves[moveIdx].bAlts = null;
    }
    state.moves = state.moves.slice(0, moveIdx + 1);
  } else {
    // Delete from white move onwards
    state.moves = state.moves.slice(0, moveIdx);
  }

  // Truncate state.sans
  state.sans = state.sans.slice(0, ply);

  // Truncate OCR cell arrays so remerge doesn't resurrect deleted moves
  if(state.ocrCells && state.ocrCells.length > ply){
    state.ocrCells = state.ocrCells.slice(0, ply);
  }
  // Also truncate per-sheet arrays (dual mode) by (moveNum, color) boundary
  var truncMoveNum = Math.floor(ply / 2) + 1;
  var truncIsBlack = ply % 2 === 1;
  function _truncateSheet(cells){
    if(!cells) return cells;
    return cells.filter(function(c){
      if(c.num < truncMoveNum) return true;
      if(c.num === truncMoveNum && truncIsBlack && c.color === 'w') return true;
      return false;
    });
  }
  if(state.ocrCellsSheet1) state.ocrCellsSheet1 = _truncateSheet(state.ocrCellsSheet1);
  if(state.ocrCellsSheet2) state.ocrCellsSheet2 = _truncateSheet(state.ocrCellsSheet2);

  // Clear stuck info if it was after the truncation point
  if(state.stuckPly !== null && state.stuckPly >= ply){
    state.stuckPly = null;
    state.stuckInfo = null;
    state.errorArrow = null;
  }

  // IMPORTANT: After user deletes noise, DON'T re-detect suspicious tail
  // The user has made their choice - don't keep expanding the flagged zone
  state.noiseCleanupDone = true;

  // Re-render without re-detecting
  renderMoveList();
  goToPly(state.sans.length);

  // If we're in noise review mode, stay there - don't auto-validate
  if(state.pendingNoiseReview){
    // Update the UI to show deletion was successful
    document.getElementById('stuck-info').innerHTML =
      '<div class="text-green-400">✓ Moves deleted</div>' +
      '<div class="text-xs text-gray-400 mt-1">Click "Continue to Validation" when ready</div>';
  } else {
    // Normal mode - revalidate
    revalidate();
  }

  // Refresh the structural pipeline: recount noise, refresh alignment cache,
  // re-evaluate at-point trigger. The user typically uses this menu item to
  // chop trailing noise, so this is what makes the noise notice auto-clear
  // and lets the algorithms launch right after.
  if (window.SheetAlignment) {
    window.SheetAlignment.runStructuralChecks();
  }

  // In batch mode, sync the per-game caches with the truncated state.
  // Without this, batchState.ocrResults[gameId].sheet1/sheet2 stay pointed
  // at the pre-truncation array (state.ocrCellsSheet1/2 were reassigned
  // above, breaking reference equality), so the game-list counter reads
  // the old length — user-reported "113/113" for a 111-move game after
  // cutting two noise cells. The reconstruction result is invalidated too
  // so the side panels don't replay stale "SOLVED (N fixes)" referencing
  // plies that no longer exist.
  if (window.BatchGameList &&
      typeof window.BatchGameList.syncAfterTruncation === 'function') {
    try { window.BatchGameList.syncAfterTruncation(); } catch (e) {
      console.warn('[Batch] syncAfterTruncation failed:', e);
    }
  }
}
