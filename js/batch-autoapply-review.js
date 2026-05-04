// =============================================================================
// batch-autoapply-review.js — Review modal for NW auto-applied corrections
// =============================================================================
// Companion to batch-nw-autoapply.js. When the reconstruction queue auto-
// applies high-anchor NW corrections, the user should be able to see what
// was applied and revert entries that turn out to be wrong.
//
// Revert semantics:
//   Per-entry Revert = "revert THIS entry AND ALL LATER entries".
//   Because each applied entry's ply positions are expressed in the
//   coordinate frame AFTER earlier entries were applied, you cannot safely
//   skip an entry in the middle and replay the rest — the later entries'
//   coordinates would point at different cells than intended. Reverting
//   in reverse (LIFO) is the only order where the remaining applies stay
//   valid, so that's what we enforce. Revert on entry 0 = revert all.
//
// After revert:
//   1. Trim ocrResult.nwAutoApplies to [0 .. index-1]
//   2. Rebuild ocrResult.sheet1/sheet2 from originalSheet1/originalSheet2
//      by replaying the remaining entries
//   3. Re-enqueue the game for reconstruction (old results are stale)
//   4. Reload the game into the main UI
//
// Dependencies: BatchNWAutoApply, BatchGameList (selectGame, batchState),
//               BatchReconstructOrchestrator or reconstructQueue for requeue.
// =============================================================================

(function() {
  'use strict';

  var MODAL_ID = 'batch-autoapply-modal';

  function _esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Replay the given nwAutoApplies entries against a fresh copy of the
   * original per-sheet cells. Used during revert to derive the new
   * working state from (originals) + (remaining entries).
   *
   * Reuses the same apply path as the original auto-apply by calling
   * BatchNWAutoApply.autoApplyHighAnchor with Infinity threshold (so
   * no NEW entries get added) — but we can't do that directly because
   * autoApplyHighAnchor re-detects rather than replaying. Instead, we
   * inline the apply logic here using the stored suggestion snapshots.
   */
  function _replayApplies(originalS1, originalS2, entries) {
    var s1 = originalS1.slice();
    var s2 = originalS2.slice();
    for (var i = 0; i < entries.length; i++) {
      var sug = entries[i].suggestion;
      if (!sug) continue;
      var targetTag = sug.fromSheet || sug.onSheet;
      var target = (targetTag === 's1') ? s1 : s2;

      if (sug.action === 'delete' || sug.action === 'delete_duplicate') {
        var plies = (sug.plies || []).slice().sort(function(a, b) { return b - a; });
        plies.forEach(function(p) { target.splice(p, 1); });
      } else if (sug.action === 'insert') {
        var insertAt = sug.afterPly + 1;
        var placeholders = [];
        for (var k = 0; k < sug.nPlies; k++) {
          var pIdx = insertAt + k;
          var pNum = Math.floor(pIdx / 2) + 1;
          var pCol = (pIdx % 2 === 0) ? 'w' : 'b';
          var cell = (typeof createSyntheticOcrCell === 'function')
            ? createSyntheticOcrCell('???', pNum, pCol)
            : { move: '???', num: pNum, color: pCol,
                confidence: 0, alternatives: [], lenientAlternatives: [],
                _source: 'nw-autoapply-replay' };
          placeholders.push(cell);
        }
        target.splice.apply(target, [insertAt, 0].concat(placeholders));
      }
      if (typeof renumberSheetCells === 'function') {
        renumberSheetCells(target);
      }
    }
    return { sheet1: s1, sheet2: s2 };
  }

  /**
   * Revert entries from `fromIndex` onward on `gameId`. Called when the
   * user clicks a Revert button in the modal.
   */
  function revertFrom(gameId, fromIndex) {
    var batchState = window.BatchGameList && window.BatchGameList.batchState
      ? window.BatchGameList.batchState
      : null;
    if (!batchState) {
      console.warn('[AutoApplyReview] batchState unavailable');
      return;
    }
    var ocrResult = batchState.ocrResults[gameId];
    if (!ocrResult || !ocrResult.nwAutoApplies) {
      console.warn('[AutoApplyReview] no nwAutoApplies on', gameId);
      return;
    }
    if (!ocrResult.originalSheet1 || !ocrResult.originalSheet2) {
      console.warn('[AutoApplyReview] missing pristine originals on', gameId);
      return;
    }

    var allEntries = ocrResult.nwAutoApplies;
    var keep = allEntries.slice(0, fromIndex);
    var drop = allEntries.slice(fromIndex);

    var confirmMsg = 'Revert ' + drop.length +
      ' auto-applied NW correction(s) on ' + gameId + '?\n\n' +
      'Any manual fixes you\'ve made to this game in the Review UI will ' +
      'be kept (working state snapshot is preserved), but the base OCR ' +
      'will change and reconstruction will re-run.';
    if (!window.confirm(confirmMsg)) return;

    // Rebuild sheets from originals + kept entries.
    var rebuilt = _replayApplies(ocrResult.originalSheet1,
                                 ocrResult.originalSheet2,
                                 keep);
    ocrResult.sheet1 = rebuilt.sheet1;
    ocrResult.sheet2 = rebuilt.sheet2;
    if (keep.length === 0) {
      // No auto-applies remain. Clean up the tracking fields so the
      // game list badge disappears and future _prepareOcrInput runs
      // consider auto-apply fresh (though normally we'd skip since
      // this ocrResult has already been through the queue).
      delete ocrResult.nwAutoApplies;
      delete ocrResult.originalSheet1;
      delete ocrResult.originalSheet2;
      delete ocrResult.nwAutoApplyThreshold;
    } else {
      ocrResult.nwAutoApplies = keep;
    }

    // Discard stale reconstruction results for this game and re-enqueue
    // for a fresh run against the new OCR.
    if (batchState.reconstructResults) {
      delete batchState.reconstructResults[gameId];
    }
    var game = batchState.games.get(gameId);
    if (game) {
      // Reset game.status so the reconstruction queue will pick it up
      // again. Clear method + tier state from the prior run.
      game.methodStatus = null;
      game.tier = null;
      game.triageDetails = null;
      game.reconstructPicked = null;
      if (game.status !== window.BatchGameList.GAME_STATUS.NEEDS_TRUNCATION) {
        game.status = window.BatchGameList.GAME_STATUS.OCR_COMPLETE;
      }
    }

    if (typeof log === 'function') {
      log('↺ Reverted ' + drop.length + ' NW correction(s) on ' + gameId +
          (keep.length > 0 ? ' (' + keep.length + ' still applied)' : ' (all reverted)'));
    }

    // Re-enqueue for reconstruction. batchState.reconstructQueue holds a
    // BatchReconstructOrchestrator instance with .enqueue(gameId, ocrResult).
    // If the queue hasn't been initialized (rare — game was opened before
    // batch run?), the new OCR will be picked up on the next batch start.
    var reconstructQueue = batchState.reconstructQueue;
    if (reconstructQueue && typeof reconstructQueue.enqueue === 'function' &&
        game && game.status !== window.BatchGameList.GAME_STATUS.NEEDS_TRUNCATION) {
      reconstructQueue.enqueue(gameId, ocrResult);
    }

    // Refresh UI.
    closeReviewModal();
    if (typeof window.BatchGameList.renderGameList === 'function') {
      window.BatchGameList.renderGameList();
    }
    // If the game is currently open, reload it so the user sees the
    // reverted OCR in the sheets panel immediately.
    if (batchState.currentGameId === gameId &&
        typeof window.BatchGameList.selectGame === 'function') {
      window.BatchGameList.selectGame(gameId);
    }
  }

  /**
   * Build + show the review modal for the given game.
   */
  function openReviewModal(gameId) {
    var batchState = window.BatchGameList && window.BatchGameList.batchState
      ? window.BatchGameList.batchState
      : null;
    if (!batchState) return;
    var ocrResult = batchState.ocrResults[gameId];
    if (!ocrResult || !ocrResult.nwAutoApplies || ocrResult.nwAutoApplies.length === 0) {
      if (typeof log === 'function') log('No NW auto-applies to review for ' + gameId);
      return;
    }

    closeReviewModal();

    var entries = ocrResult.nwAutoApplies;
    var threshold = ocrResult.nwAutoApplyThreshold || 0;

    var rowsHtml = entries.map(function(entry, idx) {
      var desc = window.BatchNWAutoApply
        ? window.BatchNWAutoApply.describeApplied(entry)
        : (entry.action + ' @ ' + (entry.sheet || '?'));
      var revertLabel = (idx === 0)
        ? 'Revert all'
        : 'Revert from #' + (idx + 1);
      var revertTitle = (idx === 0)
        ? 'Revert every auto-applied correction on this game'
        : 'Revert this correction and all ' + (entries.length - idx - 1) +
          ' after it (order matters — later entries\' positions depend on this one)';
      return (
        '<div class="flex items-start gap-2 p-2 bg-gray-800/60 rounded border border-gray-700">' +
          '<div class="text-xs text-gray-500 font-mono pt-0.5">#' + (idx + 1) + '</div>' +
          '<div class="flex-1 text-sm text-gray-200">' + _esc(desc) + '</div>' +
          '<button data-revert-idx="' + idx + '" ' +
            'class="shrink-0 px-2 py-1 bg-red-900/60 hover:bg-red-800 rounded text-xs text-red-100" ' +
            'title="' + _esc(revertTitle) + '">' +
            _esc(revertLabel) + '</button>' +
        '</div>'
      );
    }).join('');

    var modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4';
    modal.innerHTML =
      '<div class="bg-gray-900 border border-gray-700 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col shadow-2xl">' +
        '<div class="p-4 border-b border-gray-700 flex items-start justify-between gap-3">' +
          '<div>' +
            '<div class="text-purple-300 font-semibold text-sm flex items-center gap-2">' +
              '\u2699\uFE0F Auto-applied NW corrections — ' + _esc(gameId) +
            '</div>' +
            '<div class="text-xs text-gray-400 mt-1">' +
              entries.length + ' correction(s) auto-applied before reconstruction ' +
              '(anchor threshold \u2265 ' + threshold.toFixed(2) + ').' +
            '</div>' +
          '</div>' +
          '<button id="autoapply-modal-close" class="text-gray-400 hover:text-gray-100 text-xl leading-none">&times;</button>' +
        '</div>' +
        '<div class="p-4 overflow-y-auto flex-1 flex flex-col gap-2">' +
          rowsHtml +
        '</div>' +
        '<div class="p-3 border-t border-gray-700 text-xs text-gray-400">' +
          'Revert is LIFO: reverting correction #N also reverts everything applied after it, ' +
          'because later positions are expressed in the shifted frame. ' +
          'Reconstruction re-runs on the reverted OCR.' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    // Close on X or clicking the backdrop (but not on the inner panel).
    modal.addEventListener('click', function(e) {
      if (e.target === modal || e.target.id === 'autoapply-modal-close') {
        closeReviewModal();
      }
    });
    // Revert buttons.
    modal.querySelectorAll('button[data-revert-idx]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.getAttribute('data-revert-idx'), 10);
        if (!isNaN(idx)) revertFrom(gameId, idx);
      });
    });
  }

  function closeReviewModal() {
    var existing = document.getElementById(MODAL_ID);
    if (existing) existing.remove();
  }

  window.BatchAutoApplyReview = {
    openReviewModal: openReviewModal,
    closeReviewModal: closeReviewModal,
    revertFrom: revertFrom
  };
})();
