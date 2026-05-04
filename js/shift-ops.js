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
      // Restore ANY stored status (ok/fixed/locked). Fixed/locked protects
      // the move from revalidation overwrite; 'ok' is cosmetic (revalidate
      // will reset it anyway) but restoring it here avoids a noisy-looking
      // "status drifted" gap between rebuild and revalidate completion.
      if (cell._status) m.wStatus = cell._status;
      // Apply corrected move text for ANY corrected move — fixed/locked AND
      // auto-corrected (status='ok' but EAD applied an OCR alternative). Per-
      // sheet cells kept the original OCR text so merge agreement could be
      // computed from raw OCR; without restoring the corrected text here, the
      // re-merge would silently revert auto-corrections to their original
      // (often illegal) OCR, dragging validation back to the earliest such move.
      if (cell._correctedMove) m.white = cell._correctedMove;
      // Restore correction metadata for ALL corrected moves (auto or manual)
      // so 🔄/⚡ indicators and "was:" tooltips survive structural changes.
      if (cell._fixOriginal) m.wOriginal = cell._fixOriginal;
      if (cell._ocrAlt) m.wOcrAlt = true;
    } else {
      if (cell._status) m.bStatus = cell._status;
      if (cell._correctedMove) m.black = cell._correctedMove;
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
 * Truncate the move list to keep only the first `keepCount` plies — used to
 * delete likely-noise cells after the game is validated (e.g. trailing OCR
 * after checkmate).
 */
function truncateTrailingNoise(keepCount) {
  if (keepCount == null || keepCount < 0) return;
  var removed = 0;
  clearStaleState();

  if (state.ocrCells && state.ocrCells.length > keepCount) {
    syncCorrectionsToOcrCells();
    removed = state.ocrCells.length - keepCount;
    state.ocrCells.splice(keepCount);
    renumberOcrCells(state.ocrCells);

    // Truncate per-sheet arrays too. In dual-sheet mode these are the
    // source of truth for re-merge — splicing only state.ocrCells leaves
    // the per-sheet data un-truncated, so any subsequent re-merge
    // (Apply & Re-merge, alignment, game switch + restore) rebuilds
    // state.ocrCells from per-sheet and the deleted cells reappear.
    // Reported: trash button after checkmate removed 2 trailing noise
    // plies, sidebar showed 57/57 ✓, but the moves came back
    // repeatedly and Greedy kept proposing fixes for the resurrected
    // plies. Mirrors the (moveNum, color)-boundary filter used in
    // deleteMovesFromPly.
    var truncMoveNum = Math.floor(keepCount / 2) + 1;
    var truncIsBlack = keepCount % 2 === 1;
    function _truncateSheet(cells) {
      if (!cells) return cells;
      return cells.filter(function(c) {
        if (c.num < truncMoveNum) return true;
        if (c.num === truncMoveNum && truncIsBlack && c.color === 'w') return true;
        return false;
      });
    }
    if (state.ocrCellsSheet1) state.ocrCellsSheet1 = _truncateSheet(state.ocrCellsSheet1);
    if (state.ocrCellsSheet2) state.ocrCellsSheet2 = _truncateSheet(state.ocrCellsSheet2);

    rebuildFromOcrCells();
  } else {
    var plyCount = 0;
    (state.moves || []).forEach(function(m) {
      if (m.white) plyCount++;
      if (m.black) plyCount++;
    });
    if (plyCount <= keepCount) return;
    if (state.sans) state.sans = state.sans.slice(0, keepCount);
    if (typeof rebuildMovesFromSans === 'function') rebuildMovesFromSans();
    removed = plyCount - keepCount;
  }

  state.confirmedPly = keepCount;
  // The user has explicitly chopped the trailing noise via the per-row 🗑️
  // button (or post-checkmate "🗑️ Delete" link in validation.js:679) — the
  // yellow noise-review panel's purpose is fulfilled. Without this clear,
  // pendingNoiseReview stays true forever for users who use these buttons
  // instead of the yellow Continue panel, and the snapshot persists it
  // across game switches (batch-game-list.js:494).
  state.pendingNoiseReview = false;
  log('🗑️ Trimmed ' + removed + ' trailing noise move' + (removed === 1 ? '' : 's'));
  renderMoveList();
  if (typeof revalidate === 'function') revalidate();

  // Refresh structural pipeline (alignment cache, noise count) — the
  // per-cell delete-from-here path runs this; the trash-button path
  // didn't, which left stale alignment suggestions in place.
  if (window.SheetAlignment &&
      typeof window.SheetAlignment.runStructuralChecks === 'function') {
    try { window.SheetAlignment.runStructuralChecks(); } catch (e) {
      console.warn('[shift-ops] runStructuralChecks after truncate failed:', e);
    }
  }

  // Sync the batch-mode caches with the truncated state — without this,
  // batchState.ocrResults[gameId] keeps the pre-truncation length (the
  // sidebar counter and the round-export totalMoves both pull from this)
  // and batchState.reconstructResults[gameId] keeps the stale Greedy
  // SOLVED list with dangling plies. Mirrors the call from
  // deleteMovesFromPly.
  if (window.BatchGameList &&
      typeof window.BatchGameList.syncAfterTruncation === 'function') {
    try { window.BatchGameList.syncAfterTruncation(); } catch (e) {
      console.warn('[Batch] syncAfterTruncation after truncate failed:', e);
    }
  }
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
 *
 * IMPORTANT — per-key field merge, not "first sheet wins":
 * syncCorrectionsToOcrCells only sets _correctedMove on a per-sheet cell when
 * corr.move differs from cells[i].move. So if ONE sheet's raw OCR happens to
 * match the corrected text (e.g. sheet2 wrote "Re8" while sheet1 misread as
 * "Ke8" and validation corrected to "Re8"), only the OTHER sheet's cell ends
 * up with _correctedMove. If we use a "first sheet wins" scheme and the sheet
 * WITHOUT _correctedMove happens to get indexed first (it has _status so it
 * isn't skipped), the _correctedMove from the other sheet is silently lost
 * and the move reverts to raw OCR on re-merge.
 *
 * The fix: merge fields independently — for each key, take _correctedMove
 * from whichever sheet has it, _fixOriginal from whichever has it, etc.
 * For _status, prefer fixed > locked > ok when they differ.
 */
function _copySheetMetadataToMerged(merged, sheet1, sheet2) {
  var meta = {};
  var _STATUS_PRIORITY = { fixed: 3, locked: 2, ok: 1 };

  function indexSheet(cells) {
    if (!cells) return;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!c._status && !c._correctedMove && !c._fixOriginal && !c._originalOcr && !c._ocrAlt) continue;
      var key = c.num + '_' + c.color;
      if (!meta[key]) meta[key] = {};
      // _correctedMove: take from whichever sheet has it. If both sheets have
      // different values (shouldn't normally happen — both sync from the same
      // state.moves), the later-indexed sheet wins, matching how status sync
      // has always worked.
      if (c._correctedMove) meta[key]._correctedMove = c._correctedMove;
      if (c._fixOriginal && !meta[key]._fixOriginal) meta[key]._fixOriginal = c._fixOriginal;
      if (c._originalOcr && !meta[key]._originalOcr) meta[key]._originalOcr = c._originalOcr;
      if (c._ocrAlt) meta[key]._ocrAlt = true;
      if (c._status) {
        var existing = _STATUS_PRIORITY[meta[key]._status] || 0;
        var incoming = _STATUS_PRIORITY[c._status] || 0;
        if (incoming > existing) meta[key]._status = c._status;
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
 *
 * @param {number} [changePly] - Ply where the structural edit happened. When
 *   provided, confirmedPly is clamped to changePly (so moves before the edit
 *   stay confirmed and re-validation walks forward from the change point
 *   instead of from move 1). When omitted, confirmedPly is preserved as-is —
 *   the previous "always reset to 0" behavior caused validation to jump back
 *   to the earliest still-broken move on every re-merge, losing the user's
 *   working position.
 */
function _rebuildFixedPliesFromMoves(changePly) {
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
  if (typeof changePly === 'number' && changePly >= 0) {
    var prev = state.confirmedPly || 0;
    state.confirmedPly = Math.min(prev, changePly);
  }
  // else: leave confirmedPly alone — caller didn't tell us where the edit
  // happened, so we can't know what to invalidate.
}

/**
 * Re-merge dual sheets and revalidate after a structural change.
 *
 * @param {number} [changePly] - Ply where the structural edit happened.
 *   Threaded into _rebuildFixedPliesFromMoves to clamp confirmedPly so
 *   re-validation resumes near the change point instead of restarting at 0.
 */
function reMergeAndRevalidate(changePly) {
  if (!state.ocrCellsSheet1 || !state.ocrCellsSheet2) return;
  if (!window.MergeSheets) return;

  // Snapshot the user's approved fixes BEFORE the re-merge wipes metadata
  // at/after the change point. We restore them by content matching after
  // revalidate so a structural shift doesn't lose downstream work.
  var fixSnapshot = _snapshotApprovedFixesByContent();

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

  // Restore approved fixes by content matching against the new move sequence.
  // Runs BEFORE _rebuildFixedPliesFromMoves so the rebuilt arrays include the
  // restored fixes.
  var restored = _restoreApprovedFixesByContent(fixSnapshot, changePly);

  // Rebuild tracking arrays from the restored statuses
  _rebuildFixedPliesFromMoves(changePly);

  // Push confirmedPly past the highest restored fix so the user resumes after
  // their preserved work, not before it.
  if (restored.maxRestoredPly >= 0) {
    state.confirmedPly = Math.max(state.confirmedPly || 0, restored.maxRestoredPly + 1);
  }

  renderMoveList();
  revalidate();

  // Re-run the structural pipeline (noise gate first, then alignment) after
  // every structural edit. If noise reappears (rare — usually only after very
  // odd manual edits), the noise banner takes precedence again.
  if (window.SheetAlignment) {
    window.SheetAlignment.runStructuralChecks();
  }

  // Structural edits invalidate any stored algorithm results: those were
  // computed against a different OCR sequence (different ply positions,
  // different content at the change region), so applying them now would
  // place fixes at wrong logical plies. Symptom this guards against:
  // user applies NW gap-insert, switches games, switches back — auto-
  // enter Review fires with the stale pre-NW Greedy picked and stages
  // its old fixes (e.g. 44.W → Rg5) over the freshly-merged Ra6. That
  // leaks algorithm proposals into state.moves with no Review approval.
  //
  // In batch mode: orchestrator.requeue resets per-game aggregate AND
  // fires onGameReset, which clears batchState.reconstructResults +
  // game.reconstructPicked + the side panels via BatchPanelBridge —
  // so subsequent selectGame can no longer auto-enter on stale data,
  // and the algorithms re-run on the new OCR. rerunCurrentGame skips
  // the 1.5s fix-debounce because a structural edit isn't a "burst of
  // fixes" — we want the invalidation to land immediately.
  //
  // Outside batch mode: still null the interactive globals + clear
  // panels so the Review buttons can't fire on stale results.
  if (typeof window !== 'undefined') {
    window.greedyResult = null;
    window.beamResult = null;
    window.dijkstraResult = null;
  }
  ['greedy', 'beam', 'dijkstra'].forEach(function(panel) {
    if (typeof clearPanelLog === 'function') {
      try { clearPanelLog(panel); } catch (e) { /* non-fatal */ }
    }
  });
  if (window.BatchGameList && window.BatchGameList.batchState &&
      window.BatchGameList.batchState.active &&
      typeof window.BatchGameList.rerunCurrentGame === 'function') {
    try { window.BatchGameList.rerunCurrentGame(); } catch (e) {
      console.warn('[shift-ops] rerunCurrentGame after structural edit failed:', e);
    }
  } else if (typeof runAllSearches === 'function') {
    // Interactive mode parity with batch: a structural edit invalidates
    // every prior algorithm result (different ply positions, different
    // content at the change region), so kick off Greedy/Beam/Dijkstra
    // automatically rather than leaving the user staring at a stale Review
    // panel and having to click Rerun All themselves.
    try { runAllSearches(); } catch (e) {
      console.warn('[shift-ops] runAllSearches after structural edit failed:', e);
    }
  }
}

/**
 * Snapshot user-approved fixes by their move text, keyed by old ply position.
 * Each entry records what the move *resolved to* (the corrected text the user
 * accepted), so we can find the same move in the new sequence after a
 * structural shift moves it to a different position.
 */
function _snapshotApprovedFixesByContent() {
  var fixes = [];
  if (!state.moves) return fixes;
  var ply = 0;
  state.moves.forEach(function(m) {
    if (m.white) {
      // Capture three categories that need preserving across re-merge:
      //   - 'fixed': explicit user fix (Apply button)
      //   - 'locked': merge-agreement lock
      //   - 'ok' + wOcrAlt: auto-corrected via OCR alternative (raw OCR
      //     was illegal, validate picked an alternative). The new merge
      //     can flip its top-1 default after structural edits, dropping
      //     the auto-correction; without snapshotting these, validation
      //     re-breaks at moves that previously worked.
      var isApproved = (m.wStatus === 'fixed' || m.wStatus === 'locked' ||
                        (m.wStatus === 'ok' && m.wOcrAlt));
      if (isApproved && m.white) {
        // wAlgoProposed marks cells whose 'fixed' came from confirming an
        // algorithm suggestion (vs. a typed override or OCR-alt rescue).
        // _beginReviewEdit walks back algo-proposed cells when the user
        // diverges; without carrying this flag, a survived fix would lose
        // its origin marker and the downstream-revert would skip it.
        fixes.push({ oldPly: ply, color: 'w', text: m.white,
                     status: m.wStatus, original: m.wOriginal || null,
                     ocrAlt: !!m.wOcrAlt,
                     algoProposed: !!m.wAlgoProposed });
      }
      ply++;
    }
    if (m.black) {
      var isApprovedB = (m.bStatus === 'fixed' || m.bStatus === 'locked' ||
                         (m.bStatus === 'ok' && m.bOcrAlt));
      if (isApprovedB && m.black) {
        fixes.push({ oldPly: ply, color: 'b', text: m.black,
                     status: m.bStatus, original: m.bOriginal || null,
                     ocrAlt: !!m.bOcrAlt,
                     algoProposed: !!m.bAlgoProposed });
      }
      ply++;
    }
  });
  return fixes;
}

/**
 * Re-apply snapshotted approved fixes by content matching against state.moves.
 * For each prior fix, search a window of nearby plies in the new sequence for
 * a same-color cell whose text matches the snapshotted text. If found, restore
 * the wStatus/bStatus/wOriginal/bOriginal so revalidate preserves the fix.
 *
 * Search window: ±6 plies around the expected new position. The expected new
 * position is oldPly itself for fixes BEFORE changePly (no shift), and a
 * widened range AROUND oldPly for fixes at/after changePly (we don't know the
 * exact shift amount, so search broadly).
 */
function _restoreApprovedFixesByContent(fixes, changePly) {
  var result = { restored: 0, lost: 0, maxRestoredPly: -1 };
  if (!fixes || !fixes.length || !state.moves) return result;
  var changeP = (typeof changePly === 'number') ? changePly : 0;

  // Index new moves by ply for fast lookup.
  var byPly = [];
  var ply = 0;
  state.moves.forEach(function(m) {
    if (m.white) { byPly.push({ m: m, color: 'w' }); ply++; }
    if (m.black) { byPly.push({ m: m, color: 'b' }); ply++; }
  });

  var lostDetails = [];
  var restoredDetails = [];
  var overriddenDetails = [];
  fixes.forEach(function(f) {
    var beforeChange = f.oldPly < changeP;
    // Tight window for unaffected fixes; broader sweep for shifted ones.
    // Widened the post-change window to ±10 (was -6/+8) so cascaded shifts
    // from earlier edits don't drop fixes that landed slightly farther.
    var lo, hi;
    if (beforeChange) { lo = Math.max(0, f.oldPly - 2); hi = Math.min(byPly.length - 1, f.oldPly + 2); }
    else { lo = Math.max(0, f.oldPly - 10); hi = Math.min(byPly.length - 1, f.oldPly + 10); }

    // PASS 1 — search for content match in the window. Succeeds when the
    // user-confirmed text matches the freshly-merged top SAN at a same-
    // color ply in the window (typically the unmodified case where merge
    // just produced what the user already saw).
    var foundAt = -1;
    for (var p = lo; p <= hi; p++) {
      var entry = byPly[p];
      if (!entry || entry.color !== f.color) continue;
      var text = (entry.color === 'w') ? entry.m.white : entry.m.black;
      if (text === f.text) { foundAt = p; break; }
    }

    // PASS 2 (BEFORE-CHANGE ONLY) — content match failed. The user
    // confirmed a SAN that diverges from what the new merge produced
    // (e.g. confirmed 4.W=c4 over an OCR top of e4 — the entire point of
    // confirming a fix). For plies BEFORE the structural-edit change
    // point, oldPly maps to the same logical cell in the new sequence
    // (no shift), so it's safe to force the user's text at oldPly.
    // Without this, every override-style confirmation gets silently
    // dropped on every re-merge and the user re-walks the whole game.
    //
    // Restricted to beforeChange because at/after the change point,
    // oldPly can refer to a different logical ply (NW gap insert, etc.).
    // Force-applying there put algorithm-confirmed text at wrong
    // positions and produced the synthetic-green-dot bug; PASS 2 stays
    // disabled for that region. Confirmations after the change point
    // that lose their content match are dropped — the user reviews the
    // structurally-changed region against the new merge.
    var overridden = false;
    if (foundAt < 0 && beforeChange) {
      if (f.oldPly < byPly.length) {
        var cand = byPly[f.oldPly];
        if (cand && cand.color === f.color) {
          foundAt = f.oldPly;
          overridden = true;
        }
      }
    }

    if (foundAt < 0) {
      result.lost++;
      var atOld = byPly[f.oldPly];
      var atOldText = atOld ? ((atOld.color === 'w') ? atOld.m.white : atOld.m.black) : null;
      lostDetails.push({ oldPly: f.oldPly, color: f.color, text: f.text,
                         window: lo + '..' + hi,
                         atOldPosNow: atOldText });
      return;
    }
    var entry = byPly[foundAt];
    if (entry.color === 'w') {
      entry.m.wStatus = f.status;
      if (overridden) {
        entry.m.wOriginal = entry.m.wOriginal || entry.m.white;
        entry.m.white = f.text;
      }
      if (f.original && !entry.m.wOriginal) entry.m.wOriginal = f.original;
      if (f.ocrAlt) entry.m.wOcrAlt = true;
      if (f.algoProposed) entry.m.wAlgoProposed = true;
    } else {
      entry.m.bStatus = f.status;
      if (overridden) {
        entry.m.bOriginal = entry.m.bOriginal || entry.m.black;
        entry.m.black = f.text;
      }
      if (f.original && !entry.m.bOriginal) entry.m.bOriginal = f.original;
      if (f.ocrAlt) entry.m.bOcrAlt = true;
      if (f.algoProposed) entry.m.bAlgoProposed = true;
    }
    result.restored++;
    if (foundAt > result.maxRestoredPly) result.maxRestoredPly = foundAt;
    if (overridden) {
      overriddenDetails.push({ ply: foundAt, color: f.color, text: f.text });
    } else if (foundAt !== f.oldPly) {
      restoredDetails.push({ oldPly: f.oldPly, newPly: foundAt, color: f.color, text: f.text });
    }
  });

  if (typeof log === 'function' && (result.restored || result.lost)) {
    log('🔁 Restored ' + result.restored + '/' + (result.restored + result.lost) +
        ' approved fixes after structural edit' +
        (result.lost ? ' (' + result.lost + ' could not be re-located)' : ''));
    restoredDetails.slice(0, 8).forEach(function(d) {
      var oldMoveNum = Math.floor(d.oldPly / 2) + 1;
      var newMoveNum = Math.floor(d.newPly / 2) + 1;
      log('   → Moved: ' + oldMoveNum + '.' + d.color.toUpperCase() +
          ' (ply ' + d.oldPly + ') → ' + newMoveNum + '.' + d.color.toUpperCase() +
          ' (ply ' + d.newPly + ') text="' + d.text + '"');
    });
    overriddenDetails.slice(0, 8).forEach(function(d) {
      var moveNum = Math.floor(d.ply / 2) + 1;
      log('   ⚡ Override (before change): ' + moveNum + '.' + d.color.toUpperCase() +
          ' (ply ' + d.ply + ') forced to "' + d.text + '" (user choice over merge default)');
    });
    lostDetails.forEach(function(d) {
      var moveNum = Math.floor(d.oldPly / 2) + 1;
      var label = moveNum + '.' + d.color.toUpperCase();
      log('   ✗ Lost: ' + label + ' (old ply ' + d.oldPly + ') wanted "' + d.text +
          '"; search window plies ' + d.window +
          '; at old position now: ' +
          (d.atOldPosNow === null ? '(missing)' : '"' + d.atOldPosNow + '"'));
    });
  }
  return result;
}

/**
 * Clear correction-related metadata from per-sheet cells at or after a given
 * move number. Call this AFTER splice+renumber but BEFORE reMergeAndRevalidate
 * on any structural edit.
 *
 * Why this is needed: syncCorrectionsToOcrCells stores fields like
 * _correctedMove on per-sheet cells based on what state.moves held at the
 * time of the call — i.e., relative to the PRE-edit merged sequence. After
 * a structural edit shifts one sheet's content, the (num, color) keys at
 * and beyond the change point now refer to a DIFFERENT logical move in the
 * new merged sequence. The other sheet's cells didn't move, so their
 * _correctedMove (set against the old merge) silently overrides the new
 * merged value via _copySheetMetadataToMerged + rebuildFromOcrCells —
 * causing moves at/after the change point to display the OLD merged text
 * instead of the freshly-merged content.
 *
 * The clean fix is to drop that stale metadata and let revalidation re-
 * derive any corrections against the new merged context. User-applied
 * fixes (status='fixed') after the change point are sacrificed too, since
 * the move at that position is no longer the one the user fixed.
 *
 * Cells BEFORE the change point are untouched — moves before the edit
 * are sacred (they're stable and their corrections are still meaningful).
 *
 * @param {number} changeMoveNum - All cells with cell.num >= this lose
 *   correction metadata. Pass `Math.floor(changePly / 2) + 1` if you have
 *   a ply rather than a move number.
 */
function clearStaleMetadataFromMoveNum(changeMoveNum) {
  function clearCells(cells) {
    if (!cells) return;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].num >= changeMoveNum) {
        delete cells[i]._correctedMove;
        delete cells[i]._fixOriginal;
        delete cells[i]._originalOcr;
        delete cells[i]._ocrAlt;
        delete cells[i]._status;
      }
    }
  }
  clearCells(state.ocrCellsSheet1);
  clearCells(state.ocrCellsSheet2);
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
  var changePly = (moveNum - 1) * 2 + (plyColor === 'w' ? 0 : 1);
  // Drop stale per-sheet metadata at/after the change point — see helper docs.
  clearStaleMetadataFromMoveNum(moveNum);
  reMergeAndRevalidate(changePly);
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
  var changePly = (moveNum - 1) * 2 + (plyColor === 'w' ? 0 : 1);
  // Drop stale per-sheet metadata at/after the change point — see helper docs.
  clearStaleMetadataFromMoveNum(moveNum);
  reMergeAndRevalidate(changePly);
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

  // "Delete from here onward" first — it's the most-used bulk action
  // (chopping trailing OCR noise) and belongs at the top of the menu.
  html += _menuItem('Delete from here onward', '✂', 'delete-onward');
  html += _menuItem('Edit move', '✏', 'edit-move');
  html += _menuSeparator();

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
    case 'edit-move':
      enterEditMode(moveNum, color);
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
