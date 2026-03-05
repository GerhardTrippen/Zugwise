// shift-ops.js — Single-move insert & delete with OCR metadata preservation
// Works in both single-player and dual-sheet modes.

// =====================
// Utility functions
// =====================

/**
 * Adjust ply indices in a tracking array after insert/delete.
 * @param {number[]} arr - e.g. state.fixedPlies, state.lockedPlies, state.approvedPlies
 * @param {number} atPly - the ply where the operation occurred
 * @param {'insert'|'delete'} op
 * @returns {number[]} new adjusted array
 */
function adjustPlyArray(arr, atPly, op) {
  if (!arr || !arr.length) return arr || [];
  if (op === 'delete') {
    return arr.filter(function(p) { return p !== atPly; })
              .map(function(p) { return p > atPly ? p - 1 : p; });
  } else {
    // insert: shift everything >= atPly up by 1
    return arr.map(function(p) { return p >= atPly ? p + 1 : p; });
  }
}

/**
 * Adjust the confirmedPly frontier after insert/delete.
 */
function adjustConfirmedPly(confirmedPly, atPly, op) {
  if (confirmedPly <= 0) return confirmedPly;
  if (op === 'delete') {
    return confirmedPly > atPly ? confirmedPly - 1 : confirmedPly;
  } else {
    return confirmedPly >= atPly ? confirmedPly + 1 : confirmedPly;
  }
}

/**
 * Re-assign num and color fields on an ocrCells array based on array position.
 * Position 0 = move 1 white, 1 = move 1 black, 2 = move 2 white, etc.
 */
function renumberOcrCells(cells) {
  for (var i = 0; i < cells.length; i++) {
    cells[i].num = Math.floor(i / 2) + 1;
    cells[i].color = (i % 2 === 0) ? 'w' : 'b';
  }
}

/**
 * Create a synthetic OCR cell for an inserted placeholder move.
 */
function createSyntheticOcrCell(move, num, color) {
  return {
    move: move || '???',
    num: num || 1,
    color: color || 'w',
    confidence: 0,
    alternatives: [],
    lenientAlternatives: [],
    _source: 'user-insert'
  };
}

/**
 * Sync applied corrections from state.moves back into state.ocrCells.
 * This ensures that when we splice/renumber ocrCells, the corrected move
 * text (from applyFix, auto-corrections, etc.) is preserved, not the
 * original OCR text.
 *
 * Must be called BEFORE any splice operation on ocrCells.
 */
function syncCorrectionsToOcrCells() {
  if (!state.moves) return;

  // Build correction map keyed by (moveNum, color) → {move, status, original, ocrAlt}
  var corrections = {};
  state.moves.forEach(function(m) {
    if (m.white) {
      corrections[m.num + '_w'] = { move: m.white, status: m.wStatus, original: m.wOriginal, ocrAlt: m.wOcrAlt };
    }
    if (m.black) {
      corrections[m.num + '_b'] = { move: m.black, status: m.bStatus, original: m.bOriginal, ocrAlt: m.bOcrAlt };
    }
  });

  // Apply corrections to an array of cells.
  // When preserveMove is true, the cell's move text is NOT overwritten (keeps
  // original OCR) — the corrected text is stored as _correctedMove instead.
  // This is used for per-sheet arrays so mergeSheets() can compute agreement
  // from the original OCR texts, not the corrected ones.
  function applyToArray(cells, preserveMove) {
    if (!cells) return;
    for (var i = 0; i < cells.length; i++) {
      var key = cells[i].num + '_' + cells[i].color;
      var corr = corrections[key];
      if (!corr) continue;
      if (corr.move && corr.move !== cells[i].move) {
        if (!cells[i]._originalOcr) cells[i]._originalOcr = cells[i].move;
        if (preserveMove) {
          // Store corrected text as metadata; keep original OCR in move field
          cells[i]._correctedMove = corr.move;
        } else {
          cells[i].move = corr.move;
        }
      }
      if (corr.status) cells[i]._status = corr.status;
      if (corr.original) cells[i]._fixOriginal = corr.original;
      if (corr.ocrAlt) cells[i]._ocrAlt = true;
    }
  }

  // Sync to merged ocrCells (overwrite move text — used for single-player rebuild)
  if (state.ocrCells && state.ocrCells.length) {
    applyToArray(state.ocrCells, false);
  }

  // Sync to per-sheet arrays (preserve original OCR move text so mergeSheets()
  // computes agreement from original OCR, not corrected values)
  if (state.ocrCellsSheet1) applyToArray(state.ocrCellsSheet1, true);
  if (state.ocrCellsSheet2) applyToArray(state.ocrCellsSheet2, true);
}

/**
 * Metadata-preserving rebuild of state.moves + state.sans from state.ocrCells.
 * Uses the existing pairMoves() function to pair white/black, preserving
 * OCR alternatives, confidence, etc. Also carries forward fix statuses
 * (fixed/locked/wOriginal/bOriginal) stored on ocrCells.
 */
function rebuildFromOcrCells() {
  if (!state.ocrCells || !state.ocrCells.length) return;

  // Use pairMoves (from ocr.js) to rebuild the paired structure
  var paired = pairMoves(state.ocrCells);

  // Carry forward fix statuses and correction metadata stored on ocrCells
  for (var i = 0; i < state.ocrCells.length; i++) {
    var cell = state.ocrCells[i];
    // Skip cells with no metadata at all
    if (!cell._status && !cell._fixOriginal && !cell._correctedMove) continue;

    var mIdx = cell.num - 1;
    if (mIdx < 0 || mIdx >= paired.length) continue;
    var m = paired[mIdx];

    if (cell.color === 'w') {
      // Restore fixed/locked status (protects from revalidation overwrite)
      if (cell._status === 'fixed' || cell._status === 'locked') {
        m.wStatus = cell._status;
        // Apply corrected move text for fixed/locked (per-sheet cells kept
        // original OCR for merge agreement, so merged text is uncorrected)
        if (cell._correctedMove) m.white = cell._correctedMove;
      }
      // Restore correction metadata for ALL corrected moves (auto or manual)
      // so 🔄/⚡ indicators and "was:" tooltips survive structural changes
      if (cell._fixOriginal) m.wOriginal = cell._fixOriginal;
      if (cell._ocrAlt) m.wOcrAlt = true;
    } else {
      if (cell._status === 'fixed' || cell._status === 'locked') {
        m.bStatus = cell._status;
        if (cell._correctedMove) m.black = cell._correctedMove;
      }
      if (cell._fixOriginal) m.bOriginal = cell._fixOriginal;
      if (cell._ocrAlt) m.bOcrAlt = true;
    }
  }

  state.moves = paired;

  // Rebuild flat sans from the paired moves
  state.sans = [];
  paired.forEach(function(m) {
    if (m.white) state.sans.push(m.white);
    if (m.black) state.sans.push(m.black);
  });
}

// =====================
// Single-player operations
// =====================

/**
 * Clear stale state before structural changes.
 */
function clearStaleState() {
  // If in edit mode, quietly exit without triggering fetchFixes
  if (state.editMode) {
    state.editMode = null;
    if (typeof clearBoardSelection === 'function') clearBoardSelection();
    document.getElementById('fix-panel-title').textContent = 'Fix Suggestions';
  }
  state.stuckPly = null;
  state.stuckInfo = null;
  state.errorArrow = null;
  state.fixArrow = null;
  state.ocrArrow = null;
  state.selectedFix = null;
  state.missingMoveCandidates = [];
  state.pendingConfirmation = null;
  // Bump search generation to abort in-flight searches
  state.searchGeneration = (state.searchGeneration || 0) + 1;
  // Clear beam search data so it rebuilds from current state
  state.ocrDataForBeam = null;
}

/**
 * Adjust all tracking arrays after an insert or delete.
 * Sets confirmedPly to the operation point so revalidation starts from
 * the structural change — all moves before atPly are unchanged and trusted.
 */
function adjustAllTrackingArrays(atPly, op) {
  state.fixedPlies = adjustPlyArray(state.fixedPlies, atPly, op);
  state.lockedPlies = adjustPlyArray(state.lockedPlies, atPly, op);
  state.approvedPlies = adjustPlyArray(state.approvedPlies, atPly, op);
  // Trust all moves before atPly — they haven't changed.
  // Revalidation (EAD) will start from atPly, which is where the shift happens.
  state.confirmedPly = atPly;
}

/**
 * Delete a single move at the given ply, shifting all subsequent moves up.
 */
function deleteSingleMove(ply) {
  log('🗑️ Deleting single move at ply ' + ply + ' (shift up)');
  clearStaleState();

  if (state.ocrCells && state.ocrCells.length > 0) {
    // Sync corrections into ocrCells BEFORE splice so corrected text survives
    syncCorrectionsToOcrCells();
    // OCR mode: splice from ocrCells, renumber, rebuild
    if (ply < 0 || ply >= state.ocrCells.length) return;
    state.ocrCells.splice(ply, 1);
    renumberOcrCells(state.ocrCells);
    rebuildFromOcrCells();
  } else {
    // Non-OCR fallback: operate on sans directly
    if (ply < 0 || ply >= state.sans.length) return;
    state.sans.splice(ply, 1);
    rebuildMovesFromSans();
  }

  adjustAllTrackingArrays(ply, 'delete');
  renderMoveList();
  revalidate();
}

/**
 * Insert a single synthetic move at the given ply, shifting all subsequent moves down.
 * @param {number} ply - position to insert at
 * @param {string} [move] - move text (defaults to '???')
 */
function insertSingleMove(ply, move) {
  var moveText = move || '???';
  log('➕ Inserting move "' + moveText + '" at ply ' + ply + ' (shift down)');
  clearStaleState();

  if (state.ocrCells && state.ocrCells.length > 0) {
    // Sync corrections into ocrCells BEFORE splice so corrected text survives
    syncCorrectionsToOcrCells();
    // OCR mode: splice into ocrCells
    var num = Math.floor(ply / 2) + 1;
    var color = (ply % 2 === 0) ? 'w' : 'b';
    var cell = createSyntheticOcrCell(moveText, num, color);
    state.ocrCells.splice(ply, 0, cell);
    renumberOcrCells(state.ocrCells);
    rebuildFromOcrCells();
  } else {
    // Non-OCR fallback
    state.sans.splice(ply, 0, moveText);
    rebuildMovesFromSans();
  }

  adjustAllTrackingArrays(ply, 'insert');
  renderMoveList();
  revalidate();
}

// =====================
// Dual-player operations
// =====================

/**
 * Find all indices in a per-player sheet array for a given move number.
 * Each move number typically has TWO cells (one W, one B) on each sheet.
 * @param {Array} sheetCells - state.ocrCellsSheet1 or Sheet2
 * @param {number} moveNum - the move number to find
 * @returns {number[]} array of indices (usually 2: [wIdx, bIdx])
 */
function findSheetIndices(sheetCells, moveNum) {
  var indices = [];
  if (!sheetCells) return indices;
  for (var i = 0; i < sheetCells.length; i++) {
    if ((sheetCells[i].num || sheetCells[i].move_number) === moveNum) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Find the index of a single cell in a per-player sheet matching moveNum AND plyColor.
 * @param {Array} sheetCells - state.ocrCellsSheet1 or Sheet2
 * @param {number} moveNum - the move number to find
 * @param {'w'|'b'} plyColor - which half-move (W or B cell) to match
 * @returns {number} index of the matching cell, or -1 if not found
 */
function findSheetCellIndex(sheetCells, moveNum, plyColor) {
  if (!sheetCells) return -1;
  for (var i = 0; i < sheetCells.length; i++) {
    var cellNum = sheetCells[i].num || sheetCells[i].move_number;
    if (cellNum === moveNum && sheetCells[i].color === plyColor) {
      return i;
    }
  }
  return -1;
}

/**
 * Copy fix metadata from per-sheet cells onto the merged cells.
 * mergeSheets() creates fresh objects that drop these fields, so this step
 * restores them so rebuildFromOcrCells() can pick them up.
 */
function _copySheetMetadataToMerged(merged, sheet1, sheet2) {
  // Build metadata index from both sheets keyed by (num, color)
  var meta = {};
  function indexSheet(cells) {
    if (!cells) return;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!c._status && !c._correctedMove) continue;
      var key = c.num + '_' + c.color;
      // First sheet wins (both were synced from same state.moves, so same values)
      if (!meta[key]) {
        meta[key] = {};
        if (c._status) meta[key]._status = c._status;
        if (c._fixOriginal) meta[key]._fixOriginal = c._fixOriginal;
        if (c._originalOcr) meta[key]._originalOcr = c._originalOcr;
        if (c._ocrAlt) meta[key]._ocrAlt = true;
        if (c._correctedMove) meta[key]._correctedMove = c._correctedMove;
      }
    }
  }
  indexSheet(sheet1);
  indexSheet(sheet2);

  // Copy onto merged cells
  for (var i = 0; i < merged.length; i++) {
    var key = merged[i].num + '_' + merged[i].color;
    var m = meta[key];
    if (m) {
      if (m._status) merged[i]._status = m._status;
      if (m._fixOriginal) merged[i]._fixOriginal = m._fixOriginal;
      if (m._originalOcr) merged[i]._originalOcr = m._originalOcr;
      if (m._ocrAlt) merged[i]._ocrAlt = true;
      if (m._correctedMove) merged[i]._correctedMove = m._correctedMove;
    }
  }
}

/**
 * Rebuild state.fixedPlies and state.approvedPlies from current state.moves.
 * Called after structural changes in dual mode where ply indices shift and
 * the old arrays become stale.
 */
function _rebuildFixedPliesFromMoves() {
  var fixed = [];
  var approved = [];
  if (!state.moves) return;
  var ply = 0;
  state.moves.forEach(function(m) {
    if (m.white) {
      if (m.wStatus === 'fixed') fixed.push(ply);
      if (m.wStatus === 'fixed' || m.wStatus === 'locked') approved.push(ply);
      ply++;
    }
    if (m.black) {
      if (m.bStatus === 'fixed') fixed.push(ply);
      if (m.bStatus === 'fixed' || m.bStatus === 'locked') approved.push(ply);
      ply++;
    }
  });
  state.fixedPlies = fixed;
  state.approvedPlies = approved;
  // Reset confirmedPly — structural change can affect the whole game
  state.confirmedPly = 0;
}

/**
 * Re-merge dual sheets and revalidate after a structural change.
 */
function reMergeAndRevalidate() {
  if (!state.ocrCellsSheet1 || !state.ocrCellsSheet2) return;
  if (!window.MergeSheets) return;

  // Re-merge
  var whiteMoves = state.ocrCellsSheet1;
  var blackMoves = state.ocrCellsSheet2;
  var merged = window.MergeSheets.mergeSheets(whiteMoves, blackMoves);

  // Restore fix metadata that mergeSheets() drops when creating fresh objects
  _copySheetMetadataToMerged(merged, whiteMoves, blackMoves);

  state.ocrCells = merged;

  // Reclassify tiers
  var tierMap = window.MergeSheets.classifyTiers(merged);
  state.mergeTierMap = tierMap;

  // Recompute locked plies
  var lockMode = (state.mergeSettings && state.mergeSettings.lockMode) || 'tier1';
  var lockedPlies = window.MergeSheets.computeLockedPlies(tierMap, lockMode);
  state.mergeLockedPlies = lockedPlies;

  // Rebuild from merged cells (restores wStatus/bStatus from _status on cells)
  rebuildFromOcrCells();

  // Rebuild tracking arrays from the restored statuses
  _rebuildFixedPliesFromMoves();

  renderMoveList();
  revalidate();
}

/**
 * Renumber a per-player sheet array (1-based sequential).
 * Each move number has paired W+B cells, so renumber by pairs:
 * cells[0].num=1(w), cells[1].num=1(b), cells[2].num=2(w), cells[3].num=2(b), ...
 */
function renumberSheetCells(cells) {
  for (var i = 0; i < cells.length; i++) {
    var moveNum = Math.floor(i / 2) + 1;
    cells[i].num = moveNum;
    if (cells[i].move_number !== undefined) cells[i].move_number = moveNum;
    // Ensure color alternates correctly within each pair
    cells[i].color = (i % 2 === 0) ? 'w' : 'b';
  }
}

/**
 * Delete a single ply (one W or B cell) from one player's sheet in dual mode.
 * @param {number} moveNum - the move number on the sheet
 * @param {'w'|'b'} plyColor - which half-move cell to delete (W or B)
 * @param {'w'|'b'} sheetColor - which player's sheet ('w' = White's, 'b' = Black's)
 */
function deleteDualPly(moveNum, plyColor, sheetColor) {
  var sheet = (sheetColor === 'w') ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
  var sheetLabel = (sheetColor === 'w') ? "White's" : "Black's";
  var plyLabel = moveNum + '.' + (plyColor === 'w' ? 'W' : 'B');
  if (!sheet) return;

  var idx = findSheetCellIndex(sheet, moveNum, plyColor);
  if (idx === -1) { log('⚠ Ply ' + plyLabel + ' not found on ' + sheetLabel + ' sheet'); return; }

  log('🗑️ Deleting ply ' + plyLabel + ' from ' + sheetLabel + ' sheet (shift up)');
  syncCorrectionsToOcrCells();
  clearStaleState();

  sheet.splice(idx, 1);
  renumberSheetCells(sheet);
  reMergeAndRevalidate();
}

/**
 * Back-fill placeholder ('???') cells on a sheet from the other sheet's data.
 * After inserting plies on one sheet and renumbering, the new cells have final
 * (num, color) values. The other sheet likely has real OCR data at those positions.
 * @param {Array} sheet - the modified sheet (with placeholder cells)
 * @param {'w'|'b'} sheetColor - which sheet was modified
 */
function _backfillPlaceholdersFromOtherSheet(sheet, sheetColor) {
  var otherSheet = (sheetColor === 'w') ? state.ocrCellsSheet2 : state.ocrCellsSheet1;
  if (!otherSheet) return;

  // Index the other sheet by (num, color)
  var otherIndex = {};
  for (var i = 0; i < otherSheet.length; i++) {
    var c = otherSheet[i];
    otherIndex[c.num + '_' + c.color] = c;
  }

  // Fill in any user-inserted placeholder cells from the other sheet
  for (var i = 0; i < sheet.length; i++) {
    if (sheet[i]._source !== 'user-insert') continue;
    if (sheet[i].move !== '???') continue;

    var key = sheet[i].num + '_' + sheet[i].color;
    var other = otherIndex[key];
    if (other && other.move && other.move !== '???') {
      sheet[i].move = other.move;
      sheet[i].confidence = other.confidence || 0;
      if (other.alternatives) sheet[i].alternatives = other.alternatives.slice();
      if (other.lenientAlternatives) sheet[i].lenientAlternatives = other.lenientAlternatives.slice();
      log('📋 Back-filled ' + key + ' from other sheet: "' + other.move + '"');
    }
  }
}

/**
 * Insert a single placeholder ply (one cell) into one player's sheet in dual mode.
 * After renumbering, placeholder cells are back-filled from the other sheet's data
 * (since both sheets record the same game, the other sheet likely has the move).
 * @param {number} moveNum - the move number to anchor relative to
 * @param {'w'|'b'} plyColor - which half-move cell to anchor on (W or B)
 * @param {'w'|'b'} sheetColor - which player's sheet ('w' = White's, 'b' = Black's)
 * @param {'before'|'after'} position - before or after the anchor cell
 */
function insertDualPly(moveNum, plyColor, sheetColor, position) {
  var sheet = (sheetColor === 'w') ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
  var sheetLabel = (sheetColor === 'w') ? "White's" : "Black's";
  var plyLabel = moveNum + '.' + (plyColor === 'w' ? 'W' : 'B');
  if (!sheet) return;

  var idx = findSheetCellIndex(sheet, moveNum, plyColor);
  var insertAt;
  if (idx === -1) {
    insertAt = sheet.length; // append if not found
  } else if (position === 'after') {
    insertAt = idx + 1;
  } else {
    insertAt = idx;
  }

  log('➕ Inserting placeholder ply ' + position + ' ' + plyLabel + ' on ' + sheetLabel + ' sheet');
  syncCorrectionsToOcrCells();
  clearStaleState();

  var cell = createSyntheticOcrCell('???', moveNum, plyColor);
  sheet.splice(insertAt, 0, cell);
  renumberSheetCells(sheet);
  _backfillPlaceholdersFromOtherSheet(sheet, sheetColor);
  reMergeAndRevalidate();
}

// =====================
// Context menu
// =====================

var _ctxMenu = null;

function initContextMenu() {
  _ctxMenu = document.createElement('div');
  _ctxMenu.id = 'shift-ops-ctx-menu';
  _ctxMenu.className = 'fixed hidden z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-2xl py-1 text-sm min-w-48';
  _ctxMenu.style.fontFamily = 'inherit';
  document.body.appendChild(_ctxMenu);

  // Close on click elsewhere or Escape
  document.addEventListener('click', function() { hideContextMenu(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') hideContextMenu(); });
}

function hideContextMenu() {
  if (_ctxMenu) _ctxMenu.classList.add('hidden');
}

function _menuItem(label, icon, action) {
  return '<div class="px-3 py-1.5 hover:bg-gray-700 cursor-pointer text-gray-200 flex items-center gap-2" data-action="' + action + '">' +
    '<span class="w-4 text-center">' + icon + '</span>' +
    '<span>' + label + '</span></div>';
}

function _menuSeparator() {
  return '<div class="border-t border-gray-600 my-1"></div>';
}

/**
 * Show the context menu for a move cell.
 * @param {MouseEvent} e
 * @param {number} ply - 0-based ply index
 * @param {number} moveNum - 1-based move number
 * @param {'w'|'b'} color
 */
function showMoveContextMenu(e, ply, moveNum, color) {
  e.preventDefault();
  e.stopPropagation();
  if (!_ctxMenu) initContextMenu();

  var isDual = state.inputMode === 'dual-sheets';
  var colorLabel = color === 'w' ? 'White' : 'Black';
  var moveLabel = moveNum + '.' + (color === 'w' ? 'W' : 'B');
  var html = '';

  // Header
  html += '<div class="px-3 py-1.5 text-gray-400 text-xs font-semibold border-b border-gray-600">' + moveLabel + '</div>';

  if (isDual) {
    // Dual-sheet mode: per-ply operations on BOTH sheets
    html += '<div class="px-3 py-1 text-gray-500 text-xs">White\'s sheet</div>';
    html += _menuItem('Delete ' + moveLabel + ' from White\'s sheet', '🗑', 'dual-delete-w');
    html += _menuItem('Insert ply before ' + moveLabel + ' on White\'s sheet', '⬆', 'dual-insert-before-w');
    html += _menuItem('Insert ply after ' + moveLabel + ' on White\'s sheet', '⬇', 'dual-insert-after-w');
    html += _menuSeparator();
    html += '<div class="px-3 py-1 text-gray-500 text-xs">Black\'s sheet</div>';
    html += _menuItem('Delete ' + moveLabel + ' from Black\'s sheet', '🗑', 'dual-delete-b');
    html += _menuItem('Insert ply before ' + moveLabel + ' on Black\'s sheet', '⬆', 'dual-insert-before-b');
    html += _menuItem('Insert ply after ' + moveLabel + ' on Black\'s sheet', '⬇', 'dual-insert-after-b');
  } else {
    // Single-player mode items
    html += _menuItem('Delete this move (shift up)', '🗑', 'delete');
    html += _menuSeparator();
    html += _menuItem('Insert move before', '⬆', 'insert-before');
    html += _menuItem('Insert move after', '⬇', 'insert-after');
  }

  // Common: delete from here onward (both modes)
  html += _menuSeparator();
  html += _menuItem('Delete from here onward', '✂', 'delete-onward');

  _ctxMenu.innerHTML = html;

  // Position at cursor, keeping on-screen
  var x = e.clientX;
  var y = e.clientY;
  _ctxMenu.classList.remove('hidden');
  var rect = _ctxMenu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  _ctxMenu.style.left = x + 'px';
  _ctxMenu.style.top = y + 'px';

  // Attach click handlers
  _ctxMenu.querySelectorAll('[data-action]').forEach(function(el) {
    el.onclick = function(ev) {
      ev.stopPropagation();
      hideContextMenu();
      handleContextMenuAction(el.getAttribute('data-action'), ply, moveNum, color);
    };
  });
}

/**
 * Dispatch context menu actions.
 */
function handleContextMenuAction(action, ply, moveNum, color) {
  switch (action) {
    case 'delete':
      showDeleteSingleConfirmation(ply);
      break;
    case 'insert-before':
      insertSingleMove(ply);
      break;
    case 'insert-after':
      insertSingleMove(ply + 1);
      break;
    case 'delete-onward':
      showDeleteConfirmation(ply);
      break;
    case 'dual-delete-w':
      showDualDeleteConfirmation(moveNum, color, 'w');
      break;
    case 'dual-delete-b':
      showDualDeleteConfirmation(moveNum, color, 'b');
      break;
    case 'dual-insert-before-w':
      insertDualPly(moveNum, color, 'w', 'before');
      break;
    case 'dual-insert-after-w':
      insertDualPly(moveNum, color, 'w', 'after');
      break;
    case 'dual-insert-before-b':
      insertDualPly(moveNum, color, 'b', 'before');
      break;
    case 'dual-insert-after-b':
      insertDualPly(moveNum, color, 'b', 'after');
      break;
  }
}

// =====================
// Confirmation dialogs
// =====================

function showDeleteSingleConfirmation(ply) {
  var existing = document.getElementById('delete-confirm-overlay');
  if (existing) existing.remove();

  var moveNum = Math.floor(ply / 2) + 1;
  var color = ply % 2 === 0 ? 'W' : 'B';
  var moveLabel = moveNum + '.' + color;
  var moveText = '';
  if (state.ocrCells && state.ocrCells[ply]) {
    moveText = state.ocrCells[ply].move || '';
  } else if (state.sans && state.sans[ply]) {
    moveText = state.sans[ply];
  }

  var overlay = document.createElement('div');
  overlay.id = 'delete-confirm-overlay';
  overlay.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center';
  overlay.innerHTML =
    '<div class="bg-gray-800 border border-orange-500/50 rounded-xl p-6 mx-4 max-w-sm shadow-2xl">' +
      '<div class="text-orange-400 font-semibold mb-2">🗑️ Delete single move?</div>' +
      '<div class="text-gray-300 text-sm mb-2">Delete <span class="text-white font-mono">' + moveLabel + '</span>' +
        (moveText ? ' (<span class="text-white font-mono">' + moveText + '</span>)' : '') + '?</div>' +
      '<div class="text-yellow-400/80 text-xs mb-4">⚠ All subsequent moves will shift up by one half-move, swapping White/Black colors.</div>' +
      '<div class="flex gap-3">' +
        '<button id="delete-single-yes" class="flex-1 py-2 px-4 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold text-sm">Delete &amp; Shift</button>' +
        '<button id="delete-single-no" class="flex-1 py-2 px-4 rounded-lg bg-gray-600 hover:bg-gray-500 text-gray-200 font-semibold text-sm">Cancel</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  document.getElementById('delete-single-yes').onclick = function() {
    overlay.remove();
    deleteSingleMove(ply);
  };
  document.getElementById('delete-single-no').onclick = function() {
    overlay.remove();
  };
  overlay.onclick = function(e) {
    if (e.target === overlay) overlay.remove();
  };
}

function showDualDeleteConfirmation(moveNum, plyColor, sheetColor) {
  var existing = document.getElementById('delete-confirm-overlay');
  if (existing) existing.remove();

  var sheetLabel = sheetColor === 'w' ? "White's" : "Black's";
  var plyLabel = moveNum + '.' + (plyColor === 'w' ? 'W' : 'B');

  var overlay = document.createElement('div');
  overlay.id = 'delete-confirm-overlay';
  overlay.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center';
  overlay.innerHTML =
    '<div class="bg-gray-800 border border-orange-500/50 rounded-xl p-6 mx-4 max-w-sm shadow-2xl">' +
      '<div class="text-orange-400 font-semibold mb-2">🗑️ Delete ply from sheet?</div>' +
      '<div class="text-gray-300 text-sm mb-2">Delete ply <span class="text-white font-mono">' + plyLabel + '</span> from ' + sheetLabel + ' sheet?</div>' +
      '<div class="text-yellow-400/80 text-xs mb-4">⚠ Subsequent plies on ' + sheetLabel + ' sheet will shift by one half-move. Sheets will be re-merged.</div>' +
      '<div class="flex gap-3">' +
        '<button id="delete-dual-yes" class="flex-1 py-2 px-4 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold text-sm">Delete &amp; Shift</button>' +
        '<button id="delete-dual-no" class="flex-1 py-2 px-4 rounded-lg bg-gray-600 hover:bg-gray-500 text-gray-200 font-semibold text-sm">Cancel</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  document.getElementById('delete-dual-yes').onclick = function() {
    overlay.remove();
    deleteDualPly(moveNum, plyColor, sheetColor);
  };
  document.getElementById('delete-dual-no').onclick = function() {
    overlay.remove();
  };
  overlay.onclick = function(e) {
    if (e.target === overlay) overlay.remove();
  };
}
