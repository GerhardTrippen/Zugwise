// =============================================================================
// batch-nw-autoapply.js — Auto-apply high-anchor NW alignment suggestions
// =============================================================================
// When batch reconstruction runs, if a game has structural alignment issues
// (missing plies on one sheet, duplicate plies, etc.), the algorithms can't
// cross those boundaries without human intervention. For suggestions where
// both bracketing anchors are very strong (empirically ≥ 1.7 = right ~100%
// of the time on real data), we can apply the edit automatically BEFORE
// reconstruction, turning "this game needs a human" into "this game goes
// through unattended".
//
// The engine is pure — it takes sheet arrays and returns modified copies +
// a log of what was applied. The caller stores the original sheets
// separately so revert can re-derive from (original) + (applied[0..k-1]).
//
// detectNextAlignmentIssue already includes the full safety cascade
// (forward-sim + score-delta + anchor gate + substitution filter), so the
// only extra filter here is the anchor-strength threshold.
//
// Dependencies: window.SheetNWAlignment, renumberSheetCells (shift-ops.js),
//               createSyntheticOcrCell (shift-ops.js).
// =============================================================================

(function() {
  'use strict';

  // Empirically, bracketing-anchor scores ≥1.7 in user-accepted edits have
  // been right ~100% of the time. The existing manual-review gate is 1.5
  // for 1-ply edits; this threshold is stricter. Multi-ply edits already
  // get size-as-evidence support, so the same threshold applies.
  var DEFAULT_ANCHOR_MIN = Infinity;  // disabled by default

  // Safety cap. Each apply re-runs detectNextAlignmentIssue on the
  // mutated sheets; if something pathological loops, stop after this
  // many iterations rather than spinning forever.
  var MAX_AUTO_APPLIES = 20;

  /**
   * Apply a single NW suggestion to the per-sheet arrays (in place).
   * Mirrors _applyNWSuggestion in sheet-alignment.js but without the UI
   * dependencies. Renumbers the modified sheet after splice so the
   * merge step sees correct num/color pairing.
   */
  function _applySuggestion(sug, sheet1, sheet2) {
    var target, targetTag;
    if (sug.action === 'insert') {
      targetTag = sug.onSheet;
    } else {
      targetTag = sug.fromSheet;
    }
    target = (targetTag === 's1') ? sheet1 : sheet2;

    if (sug.action === 'delete' || sug.action === 'delete_duplicate') {
      // Plies may be NON-CONTIGUOUS (the bridging logic can skip over a
      // matched cell). Splice in REVERSE ply order so earlier indices
      // stay valid as later ones are removed.
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
              _source: 'nw-autoapply' };
        placeholders.push(cell);
      }
      target.splice.apply(target, [insertAt, 0].concat(placeholders));
    }

    // Renumber positions on the modified sheet so subsequent cells have
    // the right (num, color). Without this, merge keys collide.
    if (typeof renumberSheetCells === 'function') {
      renumberSheetCells(target);
    }
  }

  /**
   * Repeatedly detect + apply high-anchor NW suggestions until no more
   * pass the threshold. Returns modified copies (input is not mutated)
   * plus an ordered log of applied suggestions.
   *
   * @param {Array}  sheet1Cells - White's sheet
   * @param {Array}  sheet2Cells - Black's sheet
   * @param {number} anchorMin   - required min for BOTH beforeScore and
   *                               afterScore (Infinity = disabled)
   * @returns {{sheet1: Array, sheet2: Array, applied: Array}}
   */
  function autoApplyHighAnchor(sheet1Cells, sheet2Cells, anchorMin) {
    var applied = [];
    if (!Array.isArray(sheet1Cells) || !Array.isArray(sheet2Cells)) {
      return { sheet1: sheet1Cells, sheet2: sheet2Cells, applied: applied };
    }
    if (typeof anchorMin !== 'number' || !isFinite(anchorMin)) {
      return { sheet1: sheet1Cells, sheet2: sheet2Cells, applied: applied };
    }
    if (!window.SheetNWAlignment ||
        typeof window.SheetNWAlignment.detectNextAlignmentIssue !== 'function') {
      return { sheet1: sheet1Cells, sheet2: sheet2Cells, applied: applied };
    }

    // Shallow copy the top-level arrays. Cells themselves are not cloned
    // — we don't modify cell internals, only splice in/out references.
    var s1 = sheet1Cells.slice();
    var s2 = sheet2Cells.slice();

    for (var i = 0; i < MAX_AUTO_APPLIES; i++) {
      var sug = window.SheetNWAlignment.detectNextAlignmentIssue(s1, s2, 0);
      if (!sug) break;

      // Both anchors must meet the threshold. Duplicate-delete (Layer 2)
      // suggestions don't carry beforeScore/afterScore in the same way;
      // treat missing fields as failing the gate so Layer 2 edits still
      // require manual confirmation (conservative — Layer 2 is rare).
      var bScore = (typeof sug.beforeScore === 'number') ? sug.beforeScore : -Infinity;
      var aScore = (typeof sug.afterScore  === 'number') ? sug.afterScore  : -Infinity;
      if (bScore < anchorMin || aScore < anchorMin) break;

      // Build a compact log entry BEFORE mutating — the suggestion object
      // carries references (plies array, etc.) that may stay stable but
      // we want a frozen snapshot for the review UI.
      var entry = {
        index: applied.length,
        action: sug.action,
        sheet: sug.fromSheet || sug.onSheet,
        nPlies: sug.nPlies,
        afterPly: (typeof sug.afterPly === 'number') ? sug.afterPly : null,
        plies: Array.isArray(sug.plies) ? sug.plies.slice() : null,
        beforeScore: bScore,
        afterScore: aScore,
        // Full suggestion retained so the review UI can render BEFORE/AFTER
        // strips via the existing _renderPostApplyEvidence path.
        suggestion: JSON.parse(JSON.stringify(sug))
      };

      _applySuggestion(sug, s1, s2);
      applied.push(entry);
    }

    return { sheet1: s1, sheet2: s2, applied: applied };
  }

  /**
   * Look up the active threshold. Priority:
   *   1. window._batchAutoApplyAnchorMin (live override, e.g. from console)
   *   2. localStorage['zugwise.batchAutoApplyAnchorMin']
   *   3. DEFAULT_ANCHOR_MIN (Infinity — disabled)
   *
   * To enable for testing, run in the browser console:
   *   localStorage.setItem('zugwise.batchAutoApplyAnchorMin', '1.7')
   * or set window._batchAutoApplyAnchorMin = 1.7 before batch runs.
   */
  function getAnchorMinSetting() {
    if (typeof window._batchAutoApplyAnchorMin === 'number') {
      return window._batchAutoApplyAnchorMin;
    }
    try {
      var raw = localStorage.getItem('zugwise.batchAutoApplyAnchorMin');
      if (raw) {
        var n = parseFloat(raw);
        if (!isNaN(n)) return n;
      }
    } catch (e) { /* localStorage unavailable */ }
    return DEFAULT_ANCHOR_MIN;
  }

  /**
   * Human-readable description of an applied entry — for log lines and
   * the review UI's at-a-glance list.
   */
  function describeApplied(entry) {
    if (!entry) return '';
    var sheetLabel = (entry.sheet === 's1') ? "White's" : "Black's";
    var pluralP = entry.nPlies > 1 ? 'plies' : 'ply';
    if (entry.action === 'insert') {
      var afterMove = Math.floor(entry.afterPly / 2) + 1;
      var afterCol  = (entry.afterPly % 2 === 0) ? 'W' : 'B';
      return 'Insert ' + entry.nPlies + ' ' + pluralP + ' on ' + sheetLabel +
             ' sheet after ' + afterMove + '.' + afterCol +
             ' (anchors ' + entry.beforeScore.toFixed(2) + '/' +
             entry.afterScore.toFixed(2) + ')';
    }
    if (entry.action === 'delete' || entry.action === 'delete_duplicate') {
      var firstPly = entry.plies && entry.plies[0];
      var firstMove = (firstPly != null) ? Math.floor(firstPly / 2) + 1 : '?';
      var firstCol  = (firstPly != null) ? ((firstPly % 2 === 0) ? 'W' : 'B') : '?';
      return 'Delete ' + entry.nPlies + ' ' + pluralP + ' from ' + sheetLabel +
             ' sheet at ' + firstMove + '.' + firstCol +
             ' (anchors ' + entry.beforeScore.toFixed(2) + '/' +
             entry.afterScore.toFixed(2) + ')';
    }
    return entry.action + ' @ ' + entry.sheet;
  }

  window.BatchNWAutoApply = {
    autoApplyHighAnchor: autoApplyHighAnchor,
    getAnchorMinSetting: getAnchorMinSetting,
    describeApplied: describeApplied,
    DEFAULT_ANCHOR_MIN: DEFAULT_ANCHOR_MIN,
    MAX_AUTO_APPLIES: MAX_AUTO_APPLIES
  };
})();
