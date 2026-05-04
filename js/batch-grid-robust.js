// =============================================================================
// batch-grid-robust.js — Grid detection fallback cascade + alignment check
// =============================================================================
// Phase 5 of Batch Mode (item #22 of the spec). Batch processing can't afford
// to stop on every grid-detection failure — with 100+ games per round, even
// a 5% failure rate means five interruptions. This module:
//
//   1. Wraps the existing grid detectors (slide → anchor) in a cascade that
//      never throws, always returns a result (possibly degraded), and records
//      warnings for the triage classifier.
//   2. Provides `checkAnchorAlignment` for dual-sheet side-by-side scans —
//      six anchor columns (3 per sheet) should produce consistent row Y
//      positions on both sides. A large cross-sheet deviation is a strong
//      signal the grid detection went wrong.
//
// Module API:
//   BatchGridRobust.batchGridDetect(srcMat, config, log)
//       -> Promise<{cells, method, confidence, warnings}>
//   BatchGridRobust.checkAnchorAlignment(leftCells, rightCells, opts)
//       -> {aligned, rowYDeviation, rowCountDiff, confidence}
//   BatchGridRobust.deduplicateWithTolerance(values, tolerance)
//       -> number[]
//   BatchGridRobust.validateCells(cells)
//       -> {ok, reason, cellCount}
//
// Dependencies:
//   - window.SlideGrid.processScoresheet (primary)
//   - window.AnchorGrid.anchorProcessScoresheet (fallback)
// =============================================================================

var BatchGridRobust = (function() {
  'use strict';

  var MIN_CELLS = 10;              // Below this → treat as failed
  var ROW_Y_TOLERANCE = 10;        // Pixels — cells on same row
  var ALIGNED_DEVIATION_PX = 15;   // Pixels — max avg row-Y deviation
  var ALIGNED_ROWCOUNT_DIFF = 2;   // Rows — max row-count diff

  // =========================================================================
  // Primary: cascading detector
  // =========================================================================

  /**
   * Run grid detection with automatic fallback. Never throws. Returns a
   * result object that always has `cells`, `method`, `confidence`, and
   * `warnings` — even when every detector has failed.
   *
   * @param {cv.Mat} srcMat - OpenCV image matrix
   * @param {Object} [config] - Passed to underlying detectors
   * @param {Function} [log] - Progress callback (msg)
   * @returns {Promise<{cells, method, confidence, warnings}>}
   */
  async function batchGridDetect(srcMat, config, log) {
    config = config || {};
    var warnings = [];
    log = log || function() {};

    // 1. Slide method (most robust, default)
    if (window.SlideGrid && typeof window.SlideGrid.processScoresheet === 'function') {
      try {
        var slide = await _callMaybeAsync(window.SlideGrid.processScoresheet, srcMat, config, log);
        var v1 = validateCells(slide && slide.cells);
        if (v1.ok) {
          return {
            cells: slide.cells,
            method: 'slide',
            confidence: (slide && slide.confidence) || 0.9,
            warnings: warnings,
            raw: slide
          };
        }
        warnings.push('Slide method: ' + v1.reason);
      } catch (e) {
        warnings.push('Slide method failed: ' + (e && e.message ? e.message : e));
      }
    } else {
      warnings.push('SlideGrid not loaded');
    }

    // 2. Anchor method
    if (window.AnchorGrid && typeof window.AnchorGrid.anchorProcessScoresheet === 'function') {
      try {
        var anchor = await _callMaybeAsync(
          window.AnchorGrid.anchorProcessScoresheet, srcMat, config, log);
        var v2 = validateCells(anchor && anchor.cells);
        if (v2.ok) {
          warnings.push('Fell back to anchor method');
          return {
            cells: anchor.cells,
            method: 'anchor',
            confidence: 0.7,
            warnings: warnings,
            raw: anchor
          };
        }
        warnings.push('Anchor method: ' + v2.reason);
      } catch (e) {
        warnings.push('Anchor method failed: ' + (e && e.message ? e.message : e));
      }
    } else {
      warnings.push('AnchorGrid not loaded');
    }

    // All methods failed — return empty result rather than throw.
    warnings.push('ALL grid detection methods failed');
    return {
      cells: [],
      method: 'none',
      confidence: 0,
      warnings: warnings,
      raw: null
    };
  }

  async function _callMaybeAsync(fn, a, b, c) {
    var out = fn(a, b, c);
    return (out && typeof out.then === 'function') ? await out : out;
  }

  // =========================================================================
  // Anchor alignment sanity check (dual-sheet scans)
  // =========================================================================

  /**
   * Verify that left-sheet and right-sheet grid anchors produce consistent
   * row Y positions. Both sheets scanned together should share the same
   * horizontal row lines — if they disagree wildly, the grid on at least
   * one side has drifted.
   *
   * @param {Array} leftCells  - Cells from left scoresheet
   * @param {Array} rightCells - Cells from right scoresheet
   * @param {Object} [opts] - {tolerance, maxDeviation, maxRowCountDiff}
   * @returns {{aligned, rowYDeviation, rowCountDiff, confidence,
   *            leftRowCount, rightRowCount}}
   */
  function checkAnchorAlignment(leftCells, rightCells, opts) {
    opts = opts || {};
    var tolerance = opts.tolerance || ROW_Y_TOLERANCE;
    var maxDev = opts.maxDeviation || ALIGNED_DEVIATION_PX;
    var maxRowCountDiff = opts.maxRowCountDiff || ALIGNED_ROWCOUNT_DIFF;

    if (!Array.isArray(leftCells) || !Array.isArray(rightCells)) {
      return { aligned: false, confidence: 0, reason: 'missing cells' };
    }
    if (leftCells.length === 0 || rightCells.length === 0) {
      return { aligned: false, confidence: 0, reason: 'empty cells' };
    }

    var leftYs = deduplicateWithTolerance(_cellYs(leftCells), tolerance);
    var rightYs = deduplicateWithTolerance(_cellYs(rightCells), tolerance);

    var minLen = Math.min(leftYs.length, rightYs.length);
    var totalDev = 0;
    for (var i = 0; i < minLen; i++) {
      totalDev += Math.abs(leftYs[i] - rightYs[i]);
    }
    var avgDev = minLen > 0 ? totalDev / minLen : Infinity;
    var rowCountDiff = Math.abs(leftYs.length - rightYs.length);
    var rowCountOk = rowCountDiff <= maxRowCountDiff;
    var aligned = avgDev < maxDev && rowCountOk;

    return {
      aligned: aligned,
      rowYDeviation: avgDev,
      rowCountDiff: rowCountDiff,
      leftRowCount: leftYs.length,
      rightRowCount: rightYs.length,
      confidence: rowCountOk ? Math.max(0, 1 - avgDev / 50) : 0.3
    };
  }

  function _cellYs(cells) {
    var ys = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var y = null;
      if (c && c.bbox && typeof c.bbox.y === 'number') y = c.bbox.y;
      else if (c && typeof c.y === 'number') y = c.y;
      else if (c && typeof c.top === 'number') y = c.top;
      if (y != null) ys.push(y);
    }
    return ys;
  }

  /**
   * Collapse values that are within `tolerance` of each other into a single
   * representative (the cluster mean), then return the sorted unique list.
   * Used to extract distinct row Y positions from a cell list where many
   * cells share a row.
   */
  function deduplicateWithTolerance(values, tolerance) {
    if (!Array.isArray(values) || values.length === 0) return [];
    var sorted = values.slice().sort(function(a, b) { return a - b; });
    var clusters = [[sorted[0]]];
    for (var i = 1; i < sorted.length; i++) {
      var v = sorted[i];
      var last = clusters[clusters.length - 1];
      if (v - last[last.length - 1] <= tolerance) {
        last.push(v);
      } else {
        clusters.push([v]);
      }
    }
    return clusters.map(function(cluster) {
      var sum = 0;
      for (var j = 0; j < cluster.length; j++) sum += cluster[j];
      return sum / cluster.length;
    });
  }

  // =========================================================================
  // Cheap quality check — cell count threshold
  // =========================================================================

  function validateCells(cells) {
    if (!Array.isArray(cells)) {
      return { ok: false, reason: 'no cells array', cellCount: 0 };
    }
    if (cells.length < MIN_CELLS) {
      return {
        ok: false,
        reason: 'too few cells (' + cells.length + ' < ' + MIN_CELLS + ')',
        cellCount: cells.length
      };
    }
    return { ok: true, reason: '', cellCount: cells.length };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    batchGridDetect: batchGridDetect,
    checkAnchorAlignment: checkAnchorAlignment,
    deduplicateWithTolerance: deduplicateWithTolerance,
    validateCells: validateCells,
    // Tunables (exposed so tests / dashboard can inspect)
    MIN_CELLS: MIN_CELLS,
    ROW_Y_TOLERANCE: ROW_Y_TOLERANCE
  };
})();

window.BatchGridRobust = BatchGridRobust;
