// =============================================================================
// SHEET-ALIGNMENT.JS — Cross-ply pool overlap shift detection + smoking-gun
// =============================================================================
// Detects structural misalignment between two scoresheets: a player wrote the
// same move twice (duplication) or skipped a move (omission). The output is
// a prioritized list of insert/delete suggestions presented to the user in a
// banner — never auto-applied.
//
// Two independent signals corroborate each other:
//   1. Smoking-gun: consecutive near-identical full-move pairs on one sheet.
//      A real game cannot have the same move repeated by the same player two
//      moves in a row (the position would have changed), so this is always a
//      sheet error.
//   2. Cross-ply pool overlap: comparing OCR candidate pools at offsets ±N
//      detects where the best alignment shifts from 0 to ±2 plies.
//
// When both signals agree on the location and direction, we have a confident
// duplication suggestion. When only the shift detector fires (no smoking gun),
// the cause is more likely an omission on the other sheet.
//
// Dependencies: window.MergeSheets (normalizeSanForComparison)
// =============================================================================

(function() {
  'use strict';

  // Stashed simulated cell arrays from the most recent _renderPostApplyEvidence
  // run. Used by _drawAlignmentMatchOverlay so AFTER-table edges can compute
  // pool overlap against the post-edit state.
  var _previewAfterS1 = null;
  var _previewAfterS2 = null;
  // Stashed suggestion for the active banner (drives same-sheet duplicate
  // edges in the BEFORE table for delete_duplicate cases).
  var _currentSuggestion = null;
  // ResizeObserver for the active banner — redraws curves on layout shifts.
  var _overlayResizeObserver = null;
  var _overlayResizeListener = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function _norm(san) {
    if (window.MergeSheets && window.MergeSheets.normalizeSanForComparison) {
      return window.MergeSheets.normalizeSanForComparison(san);
    }
    if (!san) return '';
    return String(san).replace(/[+#]/g, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O').trim();
  }

  // Accept either {move, confidence} objects or [move, confidence] tuples.
  function _altMove(a) {
    if (!a) return null;
    if (typeof a === 'string') return a;
    if (Array.isArray(a)) return a[0];
    return a.move;
  }
  function _altConf(a) {
    if (!a) return 0;
    if (typeof a === 'string') return 0.1;
    if (Array.isArray(a)) return (a[1] || 0.1);
    return (typeof a.confidence === 'number') ? a.confidence : 0.1;
  }

  function _plyOf(cell) {
    return (cell.num - 1) * 2 + (cell.color === 'w' ? 0 : 1);
  }

  function _indexByPly(cells) {
    var idx = {};
    if (!cells) return idx;
    cells.forEach(function(c) { idx[_plyOf(c)] = c; });
    return idx;
  }

  // ---------------------------------------------------------------------------
  // Pool overlap between two cells' alternative lists
  // ---------------------------------------------------------------------------

  function poolOverlap(altsA, altsB) {
    if (!altsA || !altsB || !altsA.length || !altsB.length) {
      return { score: 0, shared: [] };
    }
    var byNorm = {};
    altsA.forEach(function(a) {
      var n = _norm(_altMove(a));
      if (n) byNorm[n] = _altConf(a);
    });
    var shared = [];
    altsB.forEach(function(b) {
      var n = _norm(_altMove(b));
      if (n && byNorm[n] !== undefined) {
        shared.push({ move: n, confA: byNorm[n], confB: _altConf(b) });
      }
    });
    var score = 0;
    shared.forEach(function(s) { score += s.confA + s.confB; });
    shared.sort(function(x, y) { return (y.confA + y.confB) - (x.confA + x.confB); });
    return { score: score, shared: shared };
  }

  // ---------------------------------------------------------------------------
  // TRAILING-NOISE TRIM
  // ---------------------------------------------------------------------------
  // OCR scans of blank/placeholder cells past the real game end often read as
  // the same garbage repeatedly (e.g. c4/c4/c4...). Without trimming, these
  // would generate false-positive smoking-gun hits. We strip trailing runs of
  // identical consecutive full-move pairs, keeping the FIRST occurrence (the
  // first noise row often can't be distinguished from a real move and is left
  // alone — the surviving row may still produce a single low-priority warning,
  // which is acceptable). Returns a NEW array; original is not mutated.
  // ---------------------------------------------------------------------------

  function trimTrailingNoise(cells) {
    if (!cells || cells.length < 4) return { trimmed: cells || [], removed: 0 };
    var sorted = cells.slice().sort(function(a, b) { return _plyOf(a) - _plyOf(b); });

    while (sorted.length >= 4) {
      var n = sorted.length;
      var lastB = sorted[n - 1];
      var lastW = sorted[n - 2];
      if (!lastW || !lastB || lastW.color !== 'w' || lastB.color !== 'b') break;

      var prevB = sorted[n - 3];
      var prevW = sorted[n - 4];
      if (!prevW || !prevB || prevW.color !== 'w' || prevB.color !== 'b') break;

      var nLastW = _norm(lastW.move);
      var nLastB = _norm(lastB.move);
      var nPrevW = _norm(prevW.move);
      var nPrevB = _norm(prevB.move);
      if (!nLastW || !nLastB || !nPrevW || !nPrevB) break;
      if (nLastW !== nPrevW || nLastB !== nPrevB) break;

      // A real game cannot have the same full move twice in a row, so the last
      // pair is OCR noise. Drop both halves.
      sorted.pop();
      sorted.pop();
    }
    return { trimmed: sorted, removed: cells.length - sorted.length };
  }

  // ---------------------------------------------------------------------------
  // SMOKING-GUN PRE-PASS
  // ---------------------------------------------------------------------------
  // Scan each sheet for two consecutive full-move rows that look identical.
  // A real player CANNOT play the same move twice in a row (the position
  // wouldn't allow it), so when both rows show the same handwriting, OCR
  // sees the same top-1 SAN on both. This is the core signal.
  //
  // STRICT TOP-1 MATCH: We require that the normalized top-1 SAN match
  // EXACTLY on both rows (white half and black half). The earlier version
  // used pool-overlap alone, which false-positived on disambiguation
  // differences like "Rcd1" vs "Rd1" (these share "Rd1" in alternatives,
  // but they're DIFFERENT moves — not a duplication). The pool overlap
  // is still computed and reported as supplementary evidence.
  // ---------------------------------------------------------------------------

  var SMOKING_GUN_W = 0.6;  // pool-overlap threshold for white half
  var SMOKING_GUN_B = 0.3;  // pool-overlap threshold for black half (noisier)

  function findSmokingGuns(cells, sheetTag) {
    var hits = [];
    if (!cells || cells.length < 4) return hits;

    var byPly = _indexByPly(cells);
    var maxPly = Math.max.apply(null, Object.keys(byPly).map(Number));

    for (var ply = 0; ply + 3 <= maxPly; ply += 2) {
      var w1 = byPly[ply];
      var b1 = byPly[ply + 1];
      var w2 = byPly[ply + 2];
      var b2 = byPly[ply + 3];
      if (!w1 || !b1 || !w2 || !b2) continue;

      // STRICT: top-1 normalized SAN must match on BOTH halves. This is the
      // primary signal — same handwriting two rows in a row → same OCR top-1.
      var w1Top = _norm(w1.move);
      var w2Top = _norm(w2.move);
      var b1Top = _norm(b1.move);
      var b2Top = _norm(b2.move);
      if (!w1Top || !w2Top || !b1Top || !b2Top) continue;
      if (w1Top !== w2Top || b1Top !== b2Top) continue;

      // Pool overlap as supplementary evidence — confirms both rows have
      // the same OCR confidence pattern, not just the same top pick by
      // chance. Lower thresholds since top-1 match is the gating signal.
      if (!w1.alternatives || !w2.alternatives) continue;
      var ow = poolOverlap(w1.alternatives, w2.alternatives);
      var ob = poolOverlap(b1.alternatives, b2.alternatives);
      if (ow.score < SMOKING_GUN_W || ob.score < SMOKING_GUN_B) continue;

      var moveNum = Math.floor(ply / 2) + 1;
      hits.push({
        sheet: sheetTag,
        moveNumDuplicated: moveNum,
        moveNumRedundant: moveNum + 1,
        score: ow.score + ob.score,
        evidence:
          'Sheet ' + (sheetTag === 'w' ? "(White's)" : "(Black's)") +
          ' move ' + moveNum + ' (' + (w1.move || '?') + ' / ' + (b1.move || '?') + ')' +
          ' = move ' + (moveNum + 1) + ' (' + (w2.move || '?') + ' / ' + (b2.move || '?') + ')' +
          '; identical top-1 OCR on both halves; pool overlap ' +
          (ow.score + ob.score).toFixed(2)
      });
    }
    return hits;
  }

  // ---------------------------------------------------------------------------
  // CROSS-PLY POOL OVERLAP — sliding-window shift detection
  // ---------------------------------------------------------------------------

  function _rangeOverlapAtOffset(s1ByPly, s2ByPly, startPly, endPly, offset) {
    var totalScore = 0, withOverlap = 0, checked = 0;
    for (var ply = startPly; ply <= endPly; ply++) {
      var m1 = s1ByPly[ply];
      var m2 = s2ByPly[ply + offset];
      if (!m1 || !m2) continue;
      checked++;
      var r = poolOverlap(m1.alternatives, m2.alternatives);
      totalScore += r.score;
      if (r.shared.length) withOverlap++;
    }
    return { totalScore: totalScore, withOverlap: withOverlap, checked: checked };
  }

  function detectShifts(sheet1Cells, sheet2Cells, opts) {
    opts = opts || {};
    var windowSize = opts.windowSize || 8;
    var stepSize = opts.stepSize || 2;
    // localRange controls the size of the per-window search around the
    // running cumulative offset. ±4 plies = ±2 full moves of structural
    // change per single shift transition, which covers smoking-gun
    // duplications, single-move omissions, and 2-move blocks.
    var localRange = opts.localRange || 4;
    // Absolute safety bound — we never search beyond this in either
    // direction. 12 plies = 6 full moves of cumulative offset,
    // generous for "this player stopped writing for a while" cases.
    var absMaxOffset = opts.maxOffset || 12;
    // Lowered iteratively: 0.5 → 0.3 → 0.2. Real OCR signals are often weak
    // in the endgame. 0.2 catches transitions where one anchor (Re5, Kc7,
    // Bb6) provides ~1.0 of overlap against ~0 at other offsets — these
    // genuine signals were being filtered out at 0.3. The cost is more
    // low-confidence "weak shifts" the user can dismiss.
    var minImprovement = (opts.minImprovement !== undefined) ? opts.minImprovement : 0.2;

    var s1 = _indexByPly(sheet1Cells);
    var s2 = _indexByPly(sheet2Cells);

    var allKeys = Object.keys(s1).map(Number).concat(Object.keys(s2).map(Number));
    if (!allKeys.length) return [];
    var maxPly = Math.max.apply(null, allKeys);

    // LOCAL detection: track the running cumulative offset and search each
    // window LOCALLY around it. This way, a player who skips 3 full moves
    // over the course of the game produces 3 separate delta=+2 transitions
    // (cumulative +6) instead of one impossible delta=+6 jump or — worse —
    // silently falling off the absolute search range.
    var shifts = [];
    var windowMap = [];  // per-window assessment for the shift-map debug log
    var currentBase = 0;
    // Build the list of window-start positions. With stepSize=2, the loop
    // misses the last window when (maxPly - windowSize + 1) is odd — which
    // means the very last ply or two of the game aren't covered by any
    // window and end-of-game shifts are invisible. Build the start list
    // explicitly and append the final boundary if needed.
    var lastValidStart = Math.max(0, maxPly - windowSize + 1);
    var startPositions = [];
    for (var stp = 0; stp <= lastValidStart; stp += stepSize) startPositions.push(stp);
    if (startPositions.length === 0 || startPositions[startPositions.length - 1] !== lastValidStart) {
      startPositions.push(lastValidStart);
    }
    for (var spi = 0; spi < startPositions.length; spi++) {
      var start = startPositions[spi];
      var end = start + windowSize - 1;

      // Search range: ±localRange around currentBase, clamped to ±absMaxOffset
      var searchLo = Math.max(-absMaxOffset, currentBase - localRange);
      var searchHi = Math.min(absMaxOffset, currentBase + localRange);

      var bestOffset = currentBase;
      var bestScore = -1;
      var scoreAtBase = 0;
      for (var off = searchLo; off <= searchHi; off++) {
        var r = _rangeOverlapAtOffset(s1, s2, start, end, off);
        if (off === currentBase) scoreAtBase = r.totalScore;
        if (r.totalScore > bestScore) { bestScore = r.totalScore; bestOffset = off; }
      }

      // A shift transition fires when a NEW offset wins by minImprovement
      // over the current base. If best == currentBase or the improvement
      // is too small, the running offset stays put (we're just inside
      // the same alignment regime).
      var emitTransition = (bestOffset !== currentBase) &&
                           (bestScore > scoreAtBase + minImprovement);
      windowMap.push({
        startPly: start,
        moveNum: Math.floor(start / 2) + 1,
        color: (start % 2 === 0) ? 'w' : 'b',
        currentBase: currentBase,
        bestOffset: bestOffset,
        scoreAtBase: scoreAtBase,
        scoreAtBest: bestScore,
        transition: emitTransition
      });
      if (emitTransition) {
        shifts.push({
          ply: start,
          moveNum: Math.floor(start / 2) + 1,
          color: (start % 2 === 0) ? 'w' : 'b',
          bestOffset: bestOffset,
          // delta = local structural change at this transition. Suggestions
          // act on delta so cascading shifts get correctly-sized fixes
          // (inserting 1 more full move when going +2 → +4, not 2 fresh).
          prevOffset: currentBase,
          delta: bestOffset - currentBase,
          overlapAtBase: scoreAtBase,         // score at the prior running offset
          overlapAtBest: bestScore,           // score at the new (winning) offset
          // overlapAtZero kept as alias for back-compat with suggestion text
          overlapAtZero: scoreAtBase,
          confidence: bestScore - scoreAtBase
        });
        currentBase = bestOffset;
      }
    }
    // Stash the window map on the shifts array so the caller can log it.
    // (Returning a {shifts, windowMap} object would change the API for
    // existing callers.)
    shifts.windowMap = windowMap;
    return shifts;
  }

  // ---------------------------------------------------------------------------
  // TOP-LEVEL ANALYSIS
  // ---------------------------------------------------------------------------
  //
  // Smoking guns ALWAYS produce delete-suggestions, regardless of whether the
  // shift detector corroborates them (and regardless of where in the game the
  // shift is detected). The smoking gun is an absolute signal — a player
  // physically cannot make the same move twice in a row, so a hit is sheet
  // error every time.
  //
  // Shifts contribute INSERT-suggestions only when they are NOT explained by a
  // smoking gun on the relevant sheet. A shift's direction tells us which
  // sheet is ahead: offset=-2 means S1 (white) is ahead, so a smoking gun on
  // S1 fully accounts for it; offset=+2 means S2 (black) is ahead. If the
  // sheet that's ahead has no smoking gun, the OTHER sheet is genuinely
  // missing a move, and we suggest insert.
  // ---------------------------------------------------------------------------

  function analyzeSheetAlignment(sheet1Cells, sheet2Cells) {
    if (!sheet1Cells || !sheet2Cells || sheet1Cells.length < 6 || sheet2Cells.length < 6) {
      return { suggestions: [], shifts: [], guns: { s1: [], s2: [] }, trim: { s1: 0, s2: 0 } };
    }
    // Strip trailing noise as a pure analysis filter — the caller's noise gate
    // governs whether the underlying state.ocrCellsSheet1/Sheet2 get mutated.
    var t1 = trimTrailingNoise(sheet1Cells);
    var t2 = trimTrailingNoise(sheet2Cells);
    var s1 = t1.trimmed;
    var s2 = t2.trimmed;

    var gunsS1 = findSmokingGuns(s1, 'w');
    var gunsS2 = findSmokingGuns(s2, 'b');
    var shifts = detectShifts(s1, s2);

    var suggestions = [];

    // STEP 1 — Smoking guns: always emit a delete-suggestion. High confidence.
    gunsS1.forEach(function(g) {
      suggestions.push({
        cause: 'duplication_s1',
        sheet: 'w',
        action: 'delete',
        atMoveNum: g.moveNumRedundant,
        atColor: 'w',
        confidence: 'high',
        priority: g.moveNumDuplicated,
        description: "White's sheet has move " + g.moveNumDuplicated +
                     ' written twice (also at move ' + g.moveNumRedundant + '). Delete the duplicate?',
        evidence: g.evidence
      });
    });
    gunsS2.forEach(function(g) {
      suggestions.push({
        cause: 'duplication_s2',
        sheet: 'b',
        action: 'delete',
        atMoveNum: g.moveNumRedundant,
        atColor: 'w',
        confidence: 'high',
        priority: g.moveNumDuplicated,
        description: "Black's sheet has move " + g.moveNumDuplicated +
                     ' written twice (also at move ' + g.moveNumRedundant + '). Delete the duplicate?',
        evidence: g.evidence
      });
    });

    // STEP 2 — Shifts WITHOUT a corroborating smoking gun on the ahead-sheet.
    // Dispatch on the DELTA (= new offset − previous offset) rather than the
    // absolute offset, so cascading shifts (e.g. +2 → +4 means "ONE more
    // full move missing now," delta=+2) get correctly-sized suggestions.
    // delta < 0 means the AHEAD sheet (the one further forward in plies)
    // gained extra content — interpret as duplication on that sheet OR
    // omission on the other. delta > 0 means the BEHIND sheet fell further
    // behind — interpret as missing on that sheet OR duplication on the
    // other.
    shifts.forEach(function(shift) {
      var delta = shift.delta;
      if (!delta) return;  // delta=0 (alignment restored) → no action needed

      var aheadIsS1 = (delta < 0);    // delta<0: S1 jumped further ahead
      var aheadSheet = aheadIsS1 ? 'w' : 'b';
      var behindSheet = aheadIsS1 ? 'b' : 'w';
      var aheadLabel = aheadIsS1 ? "White" : "Black";
      var behindLabel = aheadIsS1 ? "Black" : "White";
      var absDelta = Math.abs(delta);
      var deltaStr = (delta > 0 ? '+' : '') + delta;
      var contextStr = shift.prevOffset === 0
        ? '(starting from neutral alignment)'
        : '(transition from offset ' + (shift.prevOffset > 0 ? '+' : '') + shift.prevOffset +
          ' to ' + (shift.bestOffset > 0 ? '+' : '') + shift.bestOffset + ')';
      // Weak-score demotion: a shift whose winning offset only had a low
      // absolute pool-overlap score is suspect (probably accidental match
      // amid OCR noise rather than a real structural transition). Demote
      // its confidence so it surfaces only when the user is RIGHT NEXT to
      // it, rather than from further upstream.
      var weakSignal = (shift.overlapAtBest || 0) < 0.4;
      function _conf(base) {
        if (weakSignal) return 'low';
        return base;
      }

      // Skip if a smoking gun on the ahead sheet already covers this region.
      var coveredByGun = (aheadIsS1 ? gunsS1 : gunsS2).length > 0 &&
                         (absDelta === 2);  // smoking-gun covers single-move dups only
      if (coveredByGun) return;

      // delta = ±2  →  1 full move structural change
      if (absDelta === 2) {
        // Primary: delete on ahead sheet (assume duplication, slightly more common)
        suggestions.push({
          cause: 'shift_delta_2_delete',
          sheet: aheadSheet,
          action: 'delete',
          atMoveNum: shift.moveNum,
          atColor: 'w',
          confidence: _conf('medium'),
          priority: shift.moveNum + 1000,
          description: aheadLabel + "'s sheet appears to have an extra full move near move " +
                       shift.moveNum + ". Delete the duplicate?",
          evidence: 'Shift delta ' + deltaStr + ' plies near move ' + shift.moveNum +
                    ' ' + contextStr + '. Default action: delete on ' + aheadLabel +
                    '. Alternative: ' + behindLabel + ' missed a full move starting at ' +
                    shift.moveNum + '.' + shift.color.toUpperCase() +
                    ' — dismiss this banner for the "insert" option.'
        });
        // Alternative: insert on behind sheet at the shift's color boundary
        suggestions.push({
          cause: 'shift_delta_2_insert',
          sheet: behindSheet,
          action: 'insert_pair',
          atMoveNum: shift.moveNum,
          atColor: shift.color,
          confidence: _conf('low'),
          priority: shift.moveNum + 1100,
          description: "Alternative: " + behindLabel + "'s sheet may be missing a full move " +
                       "starting at " + shift.moveNum + '.' + shift.color.toUpperCase() +
                       ". Insert 2 placeholders on " + behindLabel + "'s sheet?",
          evidence: 'Same shift interpreted as omission on ' + behindLabel +
                    '. Placeholders will be backfilled from ' + aheadLabel +
                    "'s content where possible. Boundary " + shift.moveNum +
                    '.' + shift.color.toUpperCase() +
                    ' — handles "missing starts at black-half" cases too.'
        });
      }
      // delta = ±4  →  2 full moves structural change
      else if (absDelta === 4) {
        // No bias — local shift detection puts shift.moveNum at the actual
        // transition point. Insert at shift.moveNum so the placeholders
        // land on the moves the user expects.
        var insertMove4 = Math.max(1, shift.moveNum);
        suggestions.push({
          cause: 'shift_delta_4_insert',
          sheet: behindSheet,
          action: 'insert_double',
          atMoveNum: insertMove4,
          atColor: 'w',
          confidence: _conf('medium'),
          priority: insertMove4 + 800,
          description: behindLabel + "'s sheet appears to be missing TWO full moves near move " +
                       insertMove4 + ". Insert 2 placeholders on " + behindLabel + "'s sheet?",
          evidence: 'Shift delta ' + deltaStr + ' plies (= 2 full moves) at move ' +
                    shift.moveNum + ' ' + contextStr + '. If placeholders land on the ' +
                    'wrong rows, dismiss this and use right-click insert at the correct ' +
                    'position. Alternative interpretation: ' + aheadLabel + ' has 2 ' +
                    'duplicated full moves (delete those instead via right-click).'
        });
      }
      // delta = ±1  →  half-move shift (color flip, single ply off)
      else if (absDelta === 1) {
        suggestions.push({
          cause: 'shift_delta_1',
          sheet: aheadSheet,
          action: 'investigate',
          atMoveNum: shift.moveNum,
          atColor: shift.color,
          confidence: 'low',
          priority: shift.moveNum + 1500,
          description: "Half-move shift (delta " + deltaStr + ") near move " + shift.moveNum +
                       ". " + aheadLabel + "'s sheet may have an extra ply (color flip — " +
                       "a move recorded in the wrong column). Right-click \u2192 delete the " +
                       "suspect ply on " + aheadLabel + ", OR right-click \u2192 insert a " +
                       "placeholder on " + behindLabel + ".",
          evidence: 'Shift delta ' + deltaStr + ' ply ' + contextStr + '. ' +
                    'Single-ply shifts are often caused by a player recording a move in ' +
                    'the wrong column.'
        });
      }
      // delta = ±3  →  1 full move + 1 ply (two co-located structural problems)
      else if (absDelta === 3) {
        suggestions.push({
          cause: 'shift_delta_3',
          sheet: aheadSheet,
          action: 'investigate',
          atMoveNum: shift.moveNum,
          atColor: shift.color,
          confidence: 'low',
          priority: shift.moveNum + 1700,
          description: "3-ply shift (delta " + deltaStr + ") near move " + shift.moveNum +
                       ". " + aheadLabel + "'s sheet seems ahead by 1 full move + 1 ply. " +
                       "Likely a combination: a duplicated move plus an extra ply on " +
                       aheadLabel + ", OR a missing move plus a missing ply on " +
                       behindLabel + ". Investigate the per-sheet OCR around here.",
          evidence: 'Shift delta ' + deltaStr + ' plies ' + contextStr + '. Three-ply ' +
                    'shifts are uncommon and usually indicate two co-located structural ' +
                    'problems — manual inspection recommended.'
        });
      }
      // |delta| > 4 intentionally ignored — detector's maxOffset is 4 so the
      // largest single-step delta is ±8 (e.g. +4 → -4) and that's vanishingly
      // rare in real games.
    });

    // STEP 3 — Sustained-disagreement regions. The smoking-gun and ±2-shift
    // detectors miss many real misalignments: larger shifts (e.g. ±4), non-
    // adjacent duplicates, OCR variance below the smoking-gun threshold, or
    // omissions on the AHEAD sheet (which look like duplications on the
    // OTHER sheet). When the merged sequence shows a long run of
    // disagreement (red dots), it's a strong signal of structural trouble
    // even if no specific cause is pinpointed. Surface as low-priority
    // "investigate this region" suggestions so the user gets a banner
    // when they navigate near a red-dot zone.
    var disagreements = detectSustainedDisagreement();
    disagreements.forEach(function(region) {
      // Skip if already covered by a smoking-gun or shift suggestion at
      // approximately the same move.
      var coveredByOther = suggestions.some(function(s) {
        return Math.abs(s.atMoveNum - region.startMoveNum) <= 2;
      });
      if (coveredByOther) return;
      var confidence = _confidenceForStrongCount(region.strongCount);
      var weakCount = region.length - region.strongCount;
      var avgPct = Math.round((region.avgEditRatio || 0) * 100);
      suggestions.push({
        cause: 'sustained_disagreement',
        sheet: 'w',
        action: 'investigate',
        atMoveNum: region.startMoveNum,
        atColor: region.startColor,
        confidence: confidence,
        // Long runs surface earlier (lower priority number = higher in list).
        priority: region.startMoveNum + (confidence === 'high' ? 500 : 2000),
        description:
          (confidence === 'high'
            ? 'Strong structural misalignment: '
            : 'Possible structural misalignment: ') +
          region.strongCount + ' strong disagreement' +
          (region.strongCount === 1 ? '' : 's') +
          ' across ' + region.length + ' consecutive plies starting at move ' +
          region.startMoveNum + '. ' +
          (confidence === 'high'
            ? 'Inspect both sheets — likely a missing or duplicated full move on one side.'
            : 'May be a missing/duplicated move on one sheet, or just OCR variance.'),
        evidence: 'Run of ' + region.length + ' disagreeing plies; ' +
                  region.strongCount + ' "strong" (edit-distance ratio ≥ ' +
                  SUSTAINED_STRONG_RATIO + ') and ' + weakCount + ' "weak" ' +
                  '(small character variations like Rcd1↔Rd1 or Qxc5↔Qxe5). ' +
                  'Average edit-distance ratio across the run: ' + avgPct + '%. ' +
                  'Smoking-gun and ±2-shift detectors did not pinpoint a specific ' +
                  'cause for this region.'
      });
    });

    suggestions.sort(function(a, b) { return a.priority - b.priority; });

    return {
      suggestions: suggestions,
      shifts: shifts,
      guns: { s1: gunsS1, s2: gunsS2 },
      trim: { s1: t1.removed, s2: t2.removed },
      disagreements: disagreements
    };
  }

  // ---------------------------------------------------------------------------
  // SUSTAINED-DISAGREEMENT DETECTOR — fallback for things smoking-gun and
  // shift detectors miss. Reads the merged ocrCells and finds runs where
  // sheets disagree (cell._agree === false on dual-sheet cells).
  //
  // Each disagreement is weighted by Levenshtein edit-distance RATIO between
  // the two sheets' top-1 OCR text. Small differences (Rcd1 vs Rd1 — same
  // move plus disambiguation; Qxc5 vs Qxe5 — single character) are noise,
  // not structural misalignment. Only "strong" disagreements (edit-distance
  // ratio >= 0.4) count toward the run threshold and the confidence level.
  // ---------------------------------------------------------------------------

  var SUSTAINED_RUN_MIN_PLIES = 4;     // minimum total run length to consider
  var SUSTAINED_STRONG_MIN = 3;        // minimum strong-disagreement count to surface
  var SUSTAINED_STRONG_RATIO = 0.4;    // ed / maxLen >= this counts as "strong"

  // Edit-distance is the shared `editDistance` from utils.js. Falls back to
  // a tiny inline shim if utils.js hasn't loaded yet (defensive — utils.js
  // is loaded before this file in index.html, so this is just paranoia).
  function _ed(a, b) {
    if (typeof editDistance === 'function') return editDistance(a, b);
    return (a === b) ? 0 : Math.max((a || '').length, (b || '').length);
  }

  function _disagreementStrength(a, b) {
    var na = _norm(a), nb = _norm(b);
    if (!na || !nb) return 0;            // can't judge; treat as weak
    if (na === nb) return 0;
    var ed = _ed(na, nb);
    var maxLen = Math.max(na.length, nb.length);
    return maxLen > 0 ? ed / maxLen : 0;
  }

  function detectSustainedDisagreement() {
    var regions = [];
    if (!state.ocrCells || !state.ocrCells.length) return regions;

    var runStart = -1;
    var runLength = 0;
    var runStartCell = null;
    var runStrongCount = 0;
    var runEditSum = 0;

    function emitRun() {
      if (runLength < SUSTAINED_RUN_MIN_PLIES || !runStartCell) return;
      if (runStrongCount < SUSTAINED_STRONG_MIN) return;
      regions.push({
        startPly: runStart,
        startMoveNum: runStartCell.num,
        startColor: runStartCell.color,
        length: runLength,
        strongCount: runStrongCount,
        avgEditRatio: runLength > 0 ? runEditSum / runLength : 0
      });
    }

    for (var i = 0; i < state.ocrCells.length; i++) {
      var c = state.ocrCells[i];
      var disagrees = c && c._sheetCount === 2 && c._agree === false;
      if (disagrees) {
        if (runStart === -1) {
          runStart = i;
          runStartCell = c;
          runLength = 0;
          runStrongCount = 0;
          runEditSum = 0;
        }
        runLength++;
        var strength = _disagreementStrength(c._sheet1Move, c._sheet2Move);
        runEditSum += strength;
        if (strength >= SUSTAINED_STRONG_RATIO) runStrongCount++;
      } else {
        if (runStart !== -1) {
          emitRun();
          runStart = -1;
          runStartCell = null;
          runLength = 0;
          runStrongCount = 0;
          runEditSum = 0;
        }
      }
    }
    if (runStart !== -1) emitRun();

    return regions;
  }

  function _confidenceForStrongCount(n) {
    // Lowered: 15→10 for high. A 10-ply run of strong disagreements is
    // almost always structural (5 full moves of disagreement). Promoting
    // it to high gives the wider 24-ply lookahead so the banner surfaces
    // from further upstream — useful when the user is stuck at move N
    // and the disagreement is at move N+10.
    if (n >= 10) return 'high';
    if (n >= 5)  return 'medium';
    return 'low';
  }

  // ---------------------------------------------------------------------------
  // BANNER UI — show top suggestion, confirm before applying
  // ---------------------------------------------------------------------------

  function _bannerEl() {
    return document.getElementById('alignment-suggestion-banner');
  }

  function clearAlignmentBanner() {
    var el = _bannerEl();
    if (el) el.remove();
    _previewAfterS1 = null;
    _previewAfterS2 = null;
    _currentSuggestion = null;
    if (_overlayResizeObserver) {
      try { _overlayResizeObserver.disconnect(); } catch (e) {}
      _overlayResizeObserver = null;
    }
    if (_overlayResizeListener) {
      try { window.removeEventListener('resize', _overlayResizeListener); } catch (e) {}
      _overlayResizeListener = null;
    }
    if (typeof _hideCellTooltip === 'function') _hideCellTooltip();
  }

  // ---------------------------------------------------------------------------
  // EVIDENCE MINI-GRID — ±2 rows from each sheet centered on the suggested move
  // ---------------------------------------------------------------------------
  // Renders a compact 5-row × 4-cell table (W half / B half on each sheet) so
  // the user can visually verify the duplication or omission without having to
  // scroll the main handwritten panel. The suspect row on the relevant sheet
  // is highlighted; for insert suggestions an extra dashed row is shown at the
  // proposed insertion point.
  // ---------------------------------------------------------------------------

  var EVIDENCE_RADIUS = 2;  // rows above/below the suggested move

  function _cellText(cells, num, color) {
    if (!cells) return '';
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].num === num && cells[i].color === color) {
        return cells[i].move || '';
      }
    }
    return '';
  }

  function _esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _renderEvidenceGrid(top) {
    if (!state.ocrCellsSheet1 || !state.ocrCellsSheet2) return '';
    if (typeof top.atMoveNum !== 'number') return '';

    var center = top.atMoveNum;
    var lo = Math.max(1, center - EVIDENCE_RADIUS);
    var hi = center + EVIDENCE_RADIUS;
    // Don't show empty rows past the end of either sheet.
    var maxNum1 = 0, maxNum2 = 0;
    state.ocrCellsSheet1.forEach(function(c) { if (c.num > maxNum1) maxNum1 = c.num; });
    state.ocrCellsSheet2.forEach(function(c) { if (c.num > maxNum2) maxNum2 = c.num; });
    var maxAny = Math.max(maxNum1, maxNum2);
    if (hi > maxAny) hi = maxAny;
    if (lo > hi) return '';

    var suspectSheet = top.sheet;          // 'w' or 'b' — which sheet has the issue
    var isInsert = top.action === 'insert';
    // For multi-ply (possibly non-contiguous) deletes, caller passes
    // top.deletedPlySet keyed by 'num_color' so each cell is marked
    // individually (strikethrough). Legacy single-ply delete falls back
    // to the row-highlight on the center row.
    var deletedSet = top.deletedPlySet || null;
    var killCls = ' bg-red-900/40 text-red-200 line-through';
    var hilightCls = ' bg-orange-900/40 text-orange-100';

    var rows = [];
    for (var n = lo; n <= hi; n++) {
      var w1 = _cellContentHtml(state.ocrCellsSheet1, n, 'w', 's1');
      var b1 = _cellContentHtml(state.ocrCellsSheet1, n, 'b', 's1');
      var w2 = _cellContentHtml(state.ocrCellsSheet2, n, 'w', 's2');
      var b2 = _cellContentHtml(state.ocrCellsSheet2, n, 'b', 's2');

      // Per-cell delete marking. The suspect sheet determines whether
      // marks land in the W's columns (s1Cls/s1bCls) or B's columns
      // (s2Cls/s2bCls).
      var s1Cls = '', s1bCls = '', s2Cls = '', s2bCls = '';
      var markerW = '', markerB = '';
      if (!isInsert) {
        if (deletedSet) {
          var killW = !!deletedSet[n + '_w'];
          var killB = !!deletedSet[n + '_b'];
          if (suspectSheet === 'w') {
            if (killW) s1Cls = killCls;
            if (killB) s1bCls = killCls;
          } else {
            if (killW) s2Cls = killCls;
            if (killB) s2bCls = killCls;
          }
        } else if (n === center) {
          if (suspectSheet === 'w') { s1Cls = hilightCls; s1bCls = hilightCls; markerW = ' ←'; }
          else { s2Cls = hilightCls; s2bCls = hilightCls; markerB = ' ←'; }
        }
      }

      rows.push(
        '<tr>' +
          '<td class="text-gray-500 pr-2 text-right">' + n + '.</td>' +
          '<td data-c-row="' + n + '" data-c-side="s1" data-c-color="w" class="px-1' + s1Cls + '">' + (w1 || '<span class="text-gray-600">—</span>') + '</td>' +
          '<td data-c-row="' + n + '" data-c-side="s1" data-c-color="b" class="px-1' + s1bCls + '">' + (b1 || '<span class="text-gray-600">—</span>') + markerW + '</td>' +
          '<td class="px-2 text-gray-700">·</td>' +
          '<td data-c-row="' + n + '" data-c-side="s2" data-c-color="w" class="px-1' + s2Cls + '">' + (w2 || '<span class="text-gray-600">—</span>') + '</td>' +
          '<td data-c-row="' + n + '" data-c-side="s2" data-c-color="b" class="px-1' + s2bCls + '">' + (b2 || '<span class="text-gray-600">—</span>') + markerB + '</td>' +
        '</tr>'
      );

      // For insert suggestions, render a dashed insertion marker BEFORE the
      // suggested row on the suggested sheet's column.
      if (isInsert && n === center) {
        var insertW = (suspectSheet === 'w');
        var dashCellEmpty = '<td></td>';
        var dashCellMark = '<td colspan="2" class="px-1 text-blue-300 italic border-t border-dashed border-blue-400/60">↳ insert here</td>';
        rows.push(
          '<tr>' +
            '<td></td>' +
            (insertW ? dashCellMark : dashCellEmpty + dashCellEmpty) +
            '<td></td>' +
            (insertW ? dashCellEmpty + dashCellEmpty : dashCellMark) +
          '</tr>'
        );
      }
    }

    var beforeLabel = top.deletedPlySet || isInsert
      ? '<div class="text-orange-300 mb-0.5 text-xs">BEFORE:</div>' : '';
    return (
      '<div class="alignment-evidence-wrap mt-2 mb-1 text-[11px] font-mono relative isolate" data-evidence="before">' +
        beforeLabel +
        '<table class="w-full" id="alignment-evidence-table">' +
          '<thead class="text-gray-400">' +
            '<tr>' +
              '<th></th>' +
              '<th colspan="2" class="text-left pl-1 font-normal">White\'s sheet</th>' +
              '<th></th>' +
              '<th colspan="2" class="text-left pl-1 font-normal">Black\'s sheet</th>' +
            '</tr>' +
            '<tr class="text-gray-600">' +
              '<th></th>' +
              '<th class="text-left pl-1 font-normal">W</th>' +
              '<th class="text-left pl-1 font-normal">B</th>' +
              '<th></th>' +
              '<th class="text-left pl-1 font-normal">W</th>' +
              '<th class="text-left pl-1 font-normal">B</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody class="text-gray-200">' +
            rows.join('') +
          '</tbody>' +
        '</table>' +
        '<svg class="alignment-match-overlay absolute inset-0 pointer-events-none" style="overflow:visible; z-index:-1"></svg>' +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // CROSS-SHEET MATCH GRAPH OVERLAY
  // ---------------------------------------------------------------------------
  // After the BEFORE evidence grid is in the DOM, draw SVG curves from each
  // row's W1<->W2 and B1<->B2 cells. Curve opacity/width = pool overlap of
  // OCR candidate sets between the two sheets at that ply (range 0..2.0,
  // mirrors the anchor-strength metric in the banner). Bows up for white,
  // down for black, so curves don't overlap visually within a row.
  // ---------------------------------------------------------------------------

  function _altsForOverlay(cell) {
    if (!cell) return [];
    var out = [];
    if (cell.move) {
      out.push({ move: cell.move,
                 confidence: (typeof cell.confidence === 'number') ? cell.confidence : 0.1 });
    }
    if (cell.alternatives && cell.alternatives.length) {
      for (var i = 0; i < cell.alternatives.length; i++) out.push(cell.alternatives[i]);
    }
    return out;
  }

  // Compute pre- and post-fix cross-sheet pool overlap of the cells AT the
  // gap position. Different from the boundary anchor metric (which scores
  // the cells just OUTSIDE the gap and is invariant pre/post). This is the
  // metric the user asked for: a real before/after comparison of how well
  // the gap region matches the other sheet.
  //
  // Insert: pre = original cells at gap position cross-match S2;
  //         post = placeholders filled from S2 → close to 100% by
  //                construction (the placeholder IS the other sheet's move).
  // Delete: pre = cells being removed vs other sheet (low — they're the
  //               misaligned ones); post = cells that shift up to those
  //               positions vs other sheet (recovered alignment).
  function _computeGapRegionMatch(sug) {
    if (!sug || !state.ocrCellsSheet1 || !state.ocrCellsSheet2) return null;
    if (!window.SheetNWAlignment || !window.SheetNWAlignment.poolOverlap) return null;
    var po = window.SheetNWAlignment.poolOverlap;
    function _pliesToCellPairs(cells, plies) {
      var out = [];
      for (var i = 0; i < plies.length; i++) {
        var p = plies[i];
        var num = Math.floor(p / 2) + 1;
        var col = (p % 2 === 0) ? 'w' : 'b';
        out.push({ ply: p, num: num, col: col, cell: _findCellAt(cells, num, col) });
      }
      return out;
    }
    function _avgPct(pairsA, pairsB) {
      var total = 0, count = 0;
      for (var i = 0; i < pairsA.length; i++) {
        var a = pairsA[i].cell;
        var b = pairsB[i] && pairsB[i].cell;
        if (!a || !b) continue;
        var ov = po(_altsForOverlay(a), _altsForOverlay(b));
        total += ov ? ov.score : 0;
        count++;
      }
      return count > 0 ? Math.max(0, Math.min(100, (total / count / 2.0) * 100)) : null;
    }
    if (sug.action === 'insert') {
      var startPly = sug.afterPly + 1;
      var plies = [];
      for (var k = 0; k < sug.nPlies; k++) plies.push(startPly + k);
      var sheetSPre = (sug.onSheet === 's1') ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
      var sheetOther = (sug.onSheet === 's1') ? state.ocrCellsSheet2 : state.ocrCellsSheet1;
      var prePairsS = _pliesToCellPairs(sheetSPre, plies);
      var pairsOther = _pliesToCellPairs(sheetOther, plies);
      var prePct = _avgPct(prePairsS, pairsOther);
      // Post: each placeholder is filled from the corresponding cell on
      // sheetOther → pool overlap = self-overlap of that cell.
      var postPairs = pairsOther.map(function(p) { return { cell: p.cell }; });
      var postPct = _avgPct(postPairs, pairsOther);
      return { prePct: prePct, postPct: postPct };
    }
    if (sug.action === 'delete' || sug.action === 'delete_duplicate') {
      var sheetMod = (sug.fromSheet === 's1') ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
      var sheetOther2 = (sug.fromSheet === 's1') ? state.ocrCellsSheet2 : state.ocrCellsSheet1;
      var plies2 = sug.plies || [];
      if (!plies2.length) return null;
      var prePairs = _pliesToCellPairs(sheetMod, plies2);
      var pairsOther2 = _pliesToCellPairs(sheetOther2, plies2);
      var prePct2 = _avgPct(prePairs, pairsOther2);
      // Simulate the deletion on a copy, renumber, then look up the cells
      // that now sit at those ply positions.
      var modCopy = sheetMod.map(function(c) { return Object.assign({}, c); });
      var sortedDesc = plies2.slice().sort(function(a, b) { return b - a; });
      sortedDesc.forEach(function(p) { modCopy.splice(p, 1); });
      for (var ri = 0; ri < modCopy.length; ri++) {
        modCopy[ri].num = Math.floor(ri / 2) + 1;
        modCopy[ri].color = (ri % 2 === 0) ? 'w' : 'b';
      }
      var postPairs2 = _pliesToCellPairs(modCopy, plies2);
      var postPct2 = _avgPct(postPairs2, pairsOther2);
      return { prePct: prePct2, postPct: postPct2 };
    }
    return null;
  }

  // Look up the confidence for a specific normalized SAN within a cell's
  // alts list. Used in all-alts edge drawing so curve thickness reflects
  // the SAN's confidence in each sheet, not just whether it appears.
  function _confForNormSan(cell, sanNorm) {
    if (!cell || !sanNorm) return 0;
    var alts = _altsForOverlay(cell);
    var best = 0;
    for (var i = 0; i < alts.length; i++) {
      var a = alts[i];
      var move = (typeof a === 'string') ? a :
                 (Array.isArray(a) ? a[0] : a.move);
      if (!move) continue;
      if (_norm(move) !== sanNorm) continue;
      var conf = (typeof a === 'string') ? 0.1 :
                 (Array.isArray(a) ? (a[1] || 0.1) : (typeof a.confidence === 'number' ? a.confidence : 0.1));
      if (conf > best) best = conf;
    }
    return best;
  }

  function _isMatchGraphEnabled() {
    try {
      var v = localStorage.getItem('zugwise.alignment.showMatchGraph');
      return v === null ? true : (v === 'true');
    } catch (e) { return true; }
  }

  function _setMatchGraphEnabled(b) {
    try { localStorage.setItem('zugwise.alignment.showMatchGraph', b ? 'true' : 'false'); } catch (e) {}
  }

  function _isAllAltsEnabled() {
    try {
      // Default OFF: stacking 5 alts per cell roughly 5x's row height.
      return localStorage.getItem('zugwise.alignment.showAllAlts') === 'true';
    } catch (e) { return false; }
  }

  function _setAllAltsEnabled(b) {
    try { localStorage.setItem('zugwise.alignment.showAllAlts', b ? 'true' : 'false'); } catch (e) {}
  }

  // Returns HTML for a cell's content. In top-1 mode, renders just the top
  // SAN as plain escaped text. In all-alts mode, renders up to 5 deduplicated
  // candidates stacked vertically, each in a div tagged with data-c-row/side/
  // color/alt/san so the SVG overlay can draw one curve per shared SAN.
  function _cellContentHtml(cells, num, color, side) {
    var allAlts = _isAllAltsEnabled();
    if (!allAlts) {
      var top = _esc(_cellText(cells, num, color));
      return top || '<span class="text-gray-600">—</span>';
    }
    var cell = _findCellAt(cells, num, color);
    if (!cell) return '<span class="text-gray-600">—</span>';
    var raw = _altsForOverlay(cell);
    if (!raw || !raw.length) return '<span class="text-gray-600">—</span>';
    // Dedup by normalized SAN, keeping highest confidence per move.
    var dedup = {};
    var order = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      var move = (typeof item === 'string') ? item :
                 (Array.isArray(item) ? item[0] : item.move);
      if (!move) continue;
      var conf = (typeof item === 'string') ? 0.1 :
                 (Array.isArray(item) ? (item[1] || 0.1) : (typeof item.confidence === 'number' ? item.confidence : 0.1));
      var nm = _norm(move);
      if (!nm) continue;
      if (!dedup[nm]) {
        dedup[nm] = { move: move, normalized: nm, confidence: conf };
        order.push(nm);
      } else if (dedup[nm].confidence < conf) {
        dedup[nm].confidence = conf;
        dedup[nm].move = move;
      }
    }
    order.sort(function(a, b) { return dedup[b].confidence - dedup[a].confidence; });
    var top5 = order.slice(0, 5);
    return top5.map(function(nm, idx) {
      var a = dedup[nm];
      var pct = Math.max(0, Math.min(100, Math.round(a.confidence * 100)));
      // Use data-c-san-norm rather than the raw SAN so it matches across
      // sheets even if punctuation differs (e.g. "Nf3+" vs "Nf3").
      return '<span class="inline-flex items-baseline gap-0.5 mr-1.5 whitespace-nowrap" ' +
             'data-c-row="' + num + '" data-c-side="' + side + '" data-c-color="' + color +
             '" data-c-alt="' + idx + '" data-c-san-norm="' + _esc(nm) + '">' +
             _esc(a.move) +
             '<span class="text-gray-500 text-[9px]">' + pct + '%</span>' +
             '</span>';
    }).join('');
  }

  function _drawAlignmentMatchOverlay() {
    if (!window.SheetNWAlignment || !window.SheetNWAlignment.poolOverlap) return;
    var poolOverlap = window.SheetNWAlignment.poolOverlap;
    var wraps = document.querySelectorAll('.alignment-evidence-wrap');
    var enabled = _isMatchGraphEnabled();
    for (var w = 0; w < wraps.length; w++) {
      _drawOverlayForWrap(wraps[w], poolOverlap, enabled);
    }
  }

  function _drawOverlayForWrap(wrap, poolOverlap, enabled) {
    var svg = wrap.querySelector('.alignment-match-overlay');
    if (!svg) return;
    svg.style.display = enabled ? '' : 'none';
    if (!enabled) { svg.innerHTML = ''; return; }

    // Pick which sheet arrays to use for pool-overlap computation.
    var which = wrap.getAttribute('data-evidence');
    var s1Cells, s2Cells;
    if (which === 'after' && _previewAfterS1 && _previewAfterS2) {
      s1Cells = _previewAfterS1;
      s2Cells = _previewAfterS2;
    } else {
      s1Cells = state.ocrCellsSheet1;
      s2Cells = state.ocrCellsSheet2;
    }
    if (!s1Cells || !s2Cells) return;

    var wrapRect = wrap.getBoundingClientRect();
    svg.setAttribute('width', wrapRect.width);
    svg.setAttribute('height', wrapRect.height);

    var COLOR_W = '#60a5fa';   // sky-400 — white-move edges
    var COLOR_B = '#f472b6';   // pink-400 — black-move edges

    // Anchor at the LEFT edge of each cell (where the SAN text begins),
    // inset slightly so the curve visibly attaches to the move text rather
    // than the cell border. Front-to-front: line travels above/below the
    // intervening cells via a quadratic-ish bow.
    var INSET = 2;
    function _anchor(rect) {
      return { x: rect.left - wrapRect.left + INSET, y: rect.top + rect.height / 2 - wrapRect.top };
    }
    function _curve(p1, p2, bowDir) {
      var dx = p2.x - p1.x;
      var bow = Math.min(16, Math.abs(dx) * 0.15) * (bowDir === 'up' ? -1 : 1);
      var cx1 = p1.x + dx * 0.25;
      var cx2 = p1.x + dx * 0.75;
      var cy = (p1.y + p2.y) / 2 + bow;
      return 'M ' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1) +
             ' C ' + cx1.toFixed(1) + ' ' + cy.toFixed(1) +
             ' ' + cx2.toFixed(1) + ' ' + cy.toFixed(1) +
             ' ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
    }
    // Smaller-bow variant for all-alts mode where many curves can stack on
    // the same cell pair — keep them mostly straight so the y-position of
    // each alt does the visual separation work.
    function _curveSmall(p1, p2, bowDir) {
      var dx = p2.x - p1.x;
      var bow = Math.min(7, Math.abs(dx) * 0.06) * (bowDir === 'up' ? -1 : 1);
      var cx1 = p1.x + dx * 0.30;
      var cx2 = p1.x + dx * 0.70;
      var cy = (p1.y + p2.y) / 2 + bow;
      return 'M ' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1) +
             ' C ' + cx1.toFixed(1) + ' ' + cy.toFixed(1) +
             ' ' + cx2.toFixed(1) + ' ' + cy.toFixed(1) +
             ' ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
    }

    // For delete_duplicate in the BEFORE wrap, rows AT and AFTER the
    // duplicate row are inherently misaligned across sheets (the suspect
    // sheet is shifted by one move-number relative to the other sheet).
    // Drawing cross-sheet edges in those rows just adds noise — the user
    // already understands they don't match. We still draw the same-sheet
    // duplicate edge below to point at what to remove. AFTER stays full
    // so the recovered alignment shows.
    var sugForFiltering = _currentSuggestion;
    var skipCrossFromRow = null;
    if (sugForFiltering && sugForFiltering.action === 'delete_duplicate' &&
        which === 'before' && typeof sugForFiltering.moveNum === 'number') {
      skipCrossFromRow = sugForFiltering.moveNum;
    }

    var allAlts = _isAllAltsEnabled();
    var paths = [];

    if (allAlts) {
      // Per-alt edges: one curve per shared SAN (matched by data-c-san-norm)
      // between corresponding cells on the two sheets. Width/opacity scales
      // with the sum of the two alt confidences (combined 0..2 → faint..solid).
      // Bow stays direction-by-color (up for W, down for B) but smaller in
      // magnitude since we now have potentially multiple curves per cell pair.
      var s1AltDivs = wrap.querySelectorAll('[data-c-alt][data-c-side="s1"]');
      for (var i = 0; i < s1AltDivs.length; i++) {
        var a1 = s1AltDivs[i];
        var n = +a1.getAttribute('data-c-row');
        if (!n) continue;
        if (skipCrossFromRow !== null && n >= skipCrossFromRow) continue;
        var col = a1.getAttribute('data-c-color');
        var sanNorm = a1.getAttribute('data-c-san-norm');
        if (!sanNorm) continue;
        var s2AltsRow = wrap.querySelectorAll('[data-c-alt][data-c-side="s2"][data-c-row="' + n + '"][data-c-color="' + col + '"]');
        var a2 = null;
        for (var j = 0; j < s2AltsRow.length; j++) {
          if (s2AltsRow[j].getAttribute('data-c-san-norm') === sanNorm) { a2 = s2AltsRow[j]; break; }
        }
        if (!a2) continue;
        var c1 = _findCellAt(s1Cells, n, col);
        var c2 = _findCellAt(s2Cells, n, col);
        if (!c1 || !c2) continue;
        var conf1 = _confForNormSan(c1, sanNorm);
        var conf2 = _confForNormSan(c2, sanNorm);
        var combined = conf1 + conf2;
        if (combined <= 0) continue;
        var pt1 = _anchor(a1.getBoundingClientRect());
        var pt2 = _anchor(a2.getBoundingClientRect());
        var bow = (col === 'w') ? 'up' : 'down';
        var d = _curveSmall(pt1, pt2, bow);
        var sw = 0.4 + Math.min(2.0, combined * 1.5);
        var op = Math.min(0.95, 0.20 + combined * 0.45);
        var stroke = (col === 'w') ? COLOR_W : COLOR_B;
        paths.push('<path d="' + d + '" stroke="' + stroke +
                   '" stroke-width="' + sw.toFixed(2) +
                   '" fill="none" opacity="' + op.toFixed(2) + '"/>');
      }
    } else {
      var s1wCells = wrap.querySelectorAll('td[data-c-side="s1"][data-c-color="w"]');
      for (var ci = 0; ci < s1wCells.length; ci++) {
        var nn = +s1wCells[ci].getAttribute('data-c-row');
        if (!nn) continue;
        if (skipCrossFromRow !== null && nn >= skipCrossFromRow) continue;
        var pairs = [
          { color: 'w', bow: 'up',   stroke: COLOR_W },
          { color: 'b', bow: 'down', stroke: COLOR_B }
        ];
        for (var pi = 0; pi < pairs.length; pi++) {
          var p = pairs[pi];
          var s1Cell = wrap.querySelector('td[data-c-row="' + nn + '"][data-c-side="s1"][data-c-color="' + p.color + '"]');
          var s2Cell = wrap.querySelector('td[data-c-row="' + nn + '"][data-c-side="s2"][data-c-color="' + p.color + '"]');
          if (!s1Cell || !s2Cell) continue;
          var c1c = _findCellAt(s1Cells, nn, p.color);
          var c2c = _findCellAt(s2Cells, nn, p.color);
          if (!c1c || !c2c) continue;
          var ov = poolOverlap(_altsForOverlay(c1c), _altsForOverlay(c2c));
          var pt1c = _anchor(s1Cell.getBoundingClientRect());
          var pt2c = _anchor(s2Cell.getBoundingClientRect());
          var dc = _curve(pt1c, pt2c, p.bow);
          if (!ov || ov.score <= 0) continue;
          var swc = 0.6 + Math.min(2.4, ov.score * 1.3);
          var opc = Math.min(0.95, 0.18 + ov.score * 0.4);
          paths.push('<path d="' + dc + '" stroke="' + p.stroke +
                     '" stroke-width="' + swc.toFixed(2) +
                     '" fill="none" opacity="' + opc.toFixed(2) + '"/>');
        }
      }
    }

    // Same-sheet vertical edges for delete_duplicate suggestions: highlight
    // the duplicated row's pool overlap with its predecessor on the SAME
    // sheet. That's the smoking-gun signal the algorithm used to flag the
    // duplicate (findDuplicateNear: same SAN top + high pool overlap on
    // adjacent rows). Only drawn in the BEFORE wrap — the duplicate row
    // is gone in AFTER, so there's nothing left to connect.
    var sug = _currentSuggestion;
    if (sug && sug.action === 'delete_duplicate' && which === 'before' &&
        typeof sug.dupPrevMoveNum === 'number' && typeof sug.moveNum === 'number') {
      var sideKey = (sug.fromSheet === 's1') ? 's1' : 's2';
      var bowDirH = (sideKey === 's1') ? 'left' : 'right';
      // Two same-sheet curves: one in the W column, one in the B column.
      ['w', 'b'].forEach(function(col) {
        var topCell = wrap.querySelector('td[data-c-row="' + sug.dupPrevMoveNum + '"][data-c-side="' + sideKey + '"][data-c-color="' + col + '"]');
        var botCell = wrap.querySelector('td[data-c-row="' + sug.moveNum + '"][data-c-side="' + sideKey + '"][data-c-color="' + col + '"]');
        if (!topCell || !botCell) return;
        var score = (col === 'w') ? sug.dupWScore : sug.dupBScore;
        if (typeof score !== 'number' || score <= 0) return;
        var pt1 = _anchor(topCell.getBoundingClientRect());
        var pt2 = _anchor(botCell.getBoundingClientRect());
        var d2 = _vCurve(pt1, pt2, bowDirH);
        var sw2 = 0.8 + Math.min(2.6, score * 1.4);
        var op2 = Math.min(0.95, 0.25 + score * 0.4);
        var stroke = (col === 'w') ? COLOR_W : COLOR_B;
        paths.push('<path d="' + d2 + '" stroke="' + stroke +
                   '" stroke-width="' + sw2.toFixed(2) +
                   '" fill="none" opacity="' + op2.toFixed(2) + '"/>');
      });
    }

    svg.innerHTML = paths.join('');
  }

  // Vertical curve between two cells in the same column, bowing horizontally
  // outward (left for s1 sheet, right for s2 sheet) so it doesn't fight with
  // the cross-sheet horizontal curves on the same row.
  function _vCurve(p1, p2, bowDir) {
    var dy = p2.y - p1.y;
    var bowMag = Math.min(20, Math.abs(dy) * 0.45);
    var bow = bowMag * (bowDir === 'left' ? -1 : 1);
    var bx1 = p1.x + bow;
    var bx2 = p2.x + bow;
    return 'M ' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1) +
           ' C ' + bx1.toFixed(1) + ' ' + (p1.y + dy * 0.25).toFixed(1) +
           ' ' + bx2.toFixed(1) + ' ' + (p1.y + dy * 0.75).toFixed(1) +
           ' ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
  }

  function _toggleAlignmentMatchOverlay() {
    var next = !_isMatchGraphEnabled();
    _setMatchGraphEnabled(next);
    var btn = document.getElementById('alignment-graph-toggle');
    if (btn) btn.textContent = next ? 'graph: on' : 'graph: off';
    _drawAlignmentMatchOverlay();
  }

  // Toggling all-5 mode changes cell content (adds DOM nodes), so we need
  // to re-render the banner, not just redraw the SVG. Save the current sug
  // before clearAlignmentBanner wipes module state.
  function _toggleAllAlts() {
    var next = !_isAllAltsEnabled();
    _setAllAltsEnabled(next);
    var sug = _currentSuggestion;
    if (!sug) return;
    clearAlignmentBanner();
    showNWAlignmentBanner(sug);
  }

  // ---------------------------------------------------------------------------
  // PER-CELL HOVER TOOLTIP — full normalized alt distribution
  // ---------------------------------------------------------------------------
  // Hovering on a cell in the BEFORE or AFTER evidence table pops a tooltip
  // showing all OCR alternatives that cell carries with their confidences,
  // deduplicated by normalized SAN. Lets the user verify pool-overlap and
  // structured-match numbers against the raw distributions.
  // ---------------------------------------------------------------------------

  var _tooltipDelegationInstalled = false;

  function _ensureCellTooltip() {
    var tip = document.getElementById('alignment-cell-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'alignment-cell-tooltip';
      tip.className = 'fixed z-50 px-2 py-1.5 rounded bg-gray-900/95 border border-gray-600 text-gray-100 text-xs font-mono pointer-events-none shadow-lg';
      tip.style.display = 'none';
      tip.style.minWidth = '120px';
      document.body.appendChild(tip);
    }
    return tip;
  }

  function _showCellTooltip(cell) {
    var n = +cell.getAttribute('data-c-row');
    var side = cell.getAttribute('data-c-side');
    var color = cell.getAttribute('data-c-color');
    if (!n || !side || !color) return;
    var wrap = cell.closest('.alignment-evidence-wrap');
    var which = wrap ? wrap.getAttribute('data-evidence') : 'before';
    var s1 = (which === 'after' && _previewAfterS1) ? _previewAfterS1 : state.ocrCellsSheet1;
    var s2 = (which === 'after' && _previewAfterS2) ? _previewAfterS2 : state.ocrCellsSheet2;
    var cells = (side === 's1') ? s1 : s2;
    if (!cells) return;
    var cellData = _findCellAt(cells, n, color);
    if (!cellData) return;
    var alts = _altsForOverlay(cellData);
    // Dedup by normalized SAN, keep highest conf
    var dedup = {};
    var order = [];
    for (var i = 0; i < alts.length; i++) {
      var a = alts[i];
      var move = (typeof a === 'string') ? a : (Array.isArray(a) ? a[0] : a.move);
      if (!move) continue;
      var conf = (typeof a === 'string') ? 0.1 :
                 (Array.isArray(a) ? (a[1] || 0.1) :
                  (typeof a.confidence === 'number' ? a.confidence : 0.1));
      var nm = _norm(move);
      if (!nm) continue;
      if (!dedup[nm]) {
        dedup[nm] = { move: move, conf: conf };
        order.push(nm);
      } else if (dedup[nm].conf < conf) {
        dedup[nm].move = move;
        dedup[nm].conf = conf;
      }
    }
    order.sort(function(a, b) { return dedup[b].conf - dedup[a].conf; });
    var sheetLabel = (side === 's1') ? "White's sheet" : "Black's sheet";
    var moveColorLabel = (color === 'w') ? "White's move" : "Black's move";
    var stateLabel = (which === 'after') ? ' (after fix)' : '';
    var html = '<div class="text-orange-300 mb-1 text-[10px]">' +
               'Move ' + n + ' · ' + moveColorLabel + ' · ' + sheetLabel + stateLabel +
               '</div>';
    if (order.length === 0) {
      html += '<div class="text-gray-500">(no candidates)</div>';
    } else {
      var rows = order.map(function(nm) {
        var d = dedup[nm];
        var pct = Math.max(0, Math.min(100, Math.round(d.conf * 100)));
        return '<div class="flex justify-between gap-3">' +
               '<span>' + _esc(d.move) + '</span>' +
               '<span class="text-gray-400">' + pct + '%</span></div>';
      });
      html += rows.join('');
    }
    var tip = _ensureCellTooltip();
    tip.innerHTML = html;
    tip.style.display = 'block';
    var rect = cell.getBoundingClientRect();
    var tipRect = tip.getBoundingClientRect();
    var x = rect.left + rect.width / 2 - tipRect.width / 2;
    var y = rect.top - tipRect.height - 4;
    if (y < 4) y = rect.bottom + 4;
    if (x < 4) x = 4;
    if (x + tipRect.width > window.innerWidth - 4) x = window.innerWidth - tipRect.width - 4;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function _hideCellTooltip() {
    var tip = document.getElementById('alignment-cell-tooltip');
    if (tip) tip.style.display = 'none';
  }

  function _ensureTooltipDelegation() {
    if (_tooltipDelegationInstalled) return;
    _tooltipDelegationInstalled = true;
    document.body.addEventListener('mouseover', function(e) {
      if (!e.target || !e.target.closest) return;
      var cell = e.target.closest('td[data-c-row][data-c-side]');
      if (!cell) return;
      if (!cell.closest('.alignment-evidence-wrap')) return;
      _showCellTooltip(cell);
    });
    document.body.addEventListener('mouseout', function(e) {
      if (!e.target || !e.target.closest) return;
      var cell = e.target.closest('td[data-c-row][data-c-side]');
      if (!cell) return;
      var to = e.relatedTarget;
      if (to && to.closest && to.closest('td[data-c-row][data-c-side]')) return;
      _hideCellTooltip();
    });
  }

  // ---------------------------------------------------------------------------
  // POST-APPLY EVIDENCE — render the AFTER state next to BEFORE
  // ---------------------------------------------------------------------------
  // For NW suggestions, simulate the splice on COPIES of the per-sheet cell
  // arrays and render the resulting state alongside the BEFORE view, so the
  // user can see how the placeholders fall into place / how subsequent rows
  // shift to fill the gap. Original state is not mutated.
  // ---------------------------------------------------------------------------

  function _findCellAt(cells, num, color) {
    if (!cells) return null;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].num === num && cells[i].color === color) return cells[i];
    }
    return null;
  }

  function _renderPostApplyEvidence(sug) {
    if (!state.ocrCellsSheet1 || !state.ocrCellsSheet2) return '';
    if (!sug || (sug.action !== 'insert' && sug.action !== 'delete' && sug.action !== 'delete_duplicate')) return '';

    var modifiedSheetTag = sug.fromSheet || sug.onSheet;  // 's1' or 's2'
    if (!modifiedSheetTag) return '';
    var actionPly = (sug.action === 'insert') ? sug.afterPly + 1 : sug.plies[0];
    var center = Math.floor(actionPly / 2) + 1;
    var lo = Math.max(1, center - 2);
    var hi = center + 3;

    // Simulate the apply on copies — never touch real state.
    var s1Copy = state.ocrCellsSheet1.map(function(c) { return Object.assign({}, c); });
    var s2Copy = state.ocrCellsSheet2.map(function(c) { return Object.assign({}, c); });
    var modified = (modifiedSheetTag === 's1') ? s1Copy : s2Copy;
    var otherSheet = (modifiedSheetTag === 's1') ? s2Copy : s1Copy;

    // Track which (num, color) cells in the AFTER state are "new" (just
    // inserted placeholders) so we can highlight them.
    var newCellKeys = {};

    if (sug.action === 'delete' || sug.action === 'delete_duplicate') {
      var sortedDesc = sug.plies.slice().sort(function(a, b) { return b - a; });
      sortedDesc.forEach(function(p) { modified.splice(p, 1); });
    } else {
      var insertAt = sug.afterPly + 1;
      var placeholders = [];
      for (var k = 0; k < sug.nPlies; k++) {
        var pIdx = insertAt + k;
        var pNum = Math.floor(pIdx / 2) + 1;
        var pCol = (pIdx % 2 === 0) ? 'w' : 'b';
        var oth = _findCellAt(otherSheet, pNum, pCol);
        var fillText = (oth && oth.move) ? oth.move : '???';
        placeholders.push({ num: pNum, color: pCol, move: fillText, _new: true });
        newCellKeys[pNum + '_' + pCol] = true;
      }
      modified.splice.apply(modified, [insertAt, 0].concat(placeholders));
    }

    // Renumber the modified copy so num/color reflect new positions.
    for (var i = 0; i < modified.length; i++) {
      modified[i].num = Math.floor(i / 2) + 1;
      modified[i].color = (i % 2 === 0) ? 'w' : 'b';
    }

    var afterS1 = (modifiedSheetTag === 's1') ? modified : state.ocrCellsSheet1;
    var afterS2 = (modifiedSheetTag === 's2') ? modified : state.ocrCellsSheet2;

    // Stash so the SVG overlay can compute pool overlap on the post-apply
    // state when drawing edges in the AFTER table.
    _previewAfterS1 = afterS1;
    _previewAfterS2 = afterS2;

    // Don't run past the new sheet ends.
    var maxNumA = 0;
    afterS1.forEach(function(c) { if (c.num > maxNumA) maxNumA = c.num; });
    afterS2.forEach(function(c) { if (c.num > maxNumA) maxNumA = c.num; });
    var afterHi = Math.min(hi, maxNumA);

    var rows = [];
    for (var n = lo; n <= afterHi; n++) {
      var w1 = _cellContentHtml(afterS1, n, 'w', 's1');
      var b1 = _cellContentHtml(afterS1, n, 'b', 's1');
      var w2 = _cellContentHtml(afterS2, n, 'w', 's2');
      var b2 = _cellContentHtml(afterS2, n, 'b', 's2');
      var newW = !!newCellKeys[n + '_w'];
      var newB = !!newCellKeys[n + '_b'];
      var w1Cls = (newW && modifiedSheetTag === 's1') ? ' bg-emerald-900/40 text-emerald-100' : '';
      var b1Cls = (newB && modifiedSheetTag === 's1') ? ' bg-emerald-900/40 text-emerald-100' : '';
      var w2Cls = (newW && modifiedSheetTag === 's2') ? ' bg-emerald-900/40 text-emerald-100' : '';
      var b2Cls = (newB && modifiedSheetTag === 's2') ? ' bg-emerald-900/40 text-emerald-100' : '';
      rows.push(
        '<tr>' +
          '<td class="text-gray-500 pr-2 text-right">' + n + '.</td>' +
          '<td data-c-row="' + n + '" data-c-side="s1" data-c-color="w" class="px-1' + w1Cls + '">' + (w1 || '<span class="text-gray-600">—</span>') + '</td>' +
          '<td data-c-row="' + n + '" data-c-side="s1" data-c-color="b" class="px-1' + b1Cls + '">' + (b1 || '<span class="text-gray-600">—</span>') + '</td>' +
          '<td class="px-2 text-gray-700">·</td>' +
          '<td data-c-row="' + n + '" data-c-side="s2" data-c-color="w" class="px-1' + w2Cls + '">' + (w2 || '<span class="text-gray-600">—</span>') + '</td>' +
          '<td data-c-row="' + n + '" data-c-side="s2" data-c-color="b" class="px-1' + b2Cls + '">' + (b2 || '<span class="text-gray-600">—</span>') + '</td>' +
        '</tr>'
      );
    }

    return (
      '<div class="alignment-evidence-wrap mt-1 text-[11px] font-mono relative isolate" data-evidence="after">' +
        '<div class="text-emerald-300 mb-0.5 text-xs">→ AFTER apply:</div>' +
        '<table class="w-full">' +
          '<tbody class="text-gray-200">' + rows.join('') + '</tbody>' +
        '</table>' +
        '<svg class="alignment-match-overlay absolute inset-0 pointer-events-none" style="overflow:visible; z-index:-1"></svg>' +
      '</div>'
    );
  }

  function showAlignmentBanner(analysis) {
    clearAlignmentBanner();
    if (!analysis || !analysis.suggestions || !analysis.suggestions.length) return;

    var top = analysis.suggestions[0];
    var more = analysis.suggestions.length - 1;

    var icon = top.action === 'delete' ? '✂️' :
               top.action === 'insert' ? '➕' :
               top.action === 'insert_pair' ? '➕➕' :
               top.action === 'insert_double' ? '➕➕➕➕' :
               '🔍';  // investigate
    var confColor = top.confidence === 'high' ? 'border-orange-500/60 bg-orange-900/20' :
                    top.confidence === 'medium' ? 'border-yellow-500/40 bg-yellow-900/15' :
                    'border-gray-500/40 bg-gray-800/40';                       // low
    var confLabel = top.confidence === 'high' ? 'High confidence' :
                    top.confidence === 'medium' ? 'Medium confidence' :
                    'Low confidence — investigate';
    var hasApplyAction = (top.action === 'delete' ||
                          top.action === 'insert' ||
                          top.action === 'insert_pair' ||
                          top.action === 'insert_double');
    var applyLabel = top.action === 'delete' ? 'Delete & Re-merge' :
                     top.action === 'insert' ? 'Insert & Re-merge' :
                     top.action === 'insert_pair' ? 'Insert 1 move & Re-merge' :
                     top.action === 'insert_double' ? 'Insert 2 moves & Re-merge' :
                     '';

    var banner = document.createElement('div');
    banner.id = 'alignment-suggestion-banner';
    banner.dataset.suggestionKey = _suggestionKey(top);
    banner.className = 'mx-3 my-2 p-3 rounded-lg border ' + confColor + ' text-sm';
    banner.innerHTML =
      '<div class="flex items-start gap-3">' +
        '<div class="text-lg leading-none">' + icon + '</div>' +
        '<div class="flex-1 min-w-0">' +
          '<div class="text-orange-200 font-semibold mb-1">' +
            'Possible structural issue · ' + confLabel +
          '</div>' +
          '<div class="text-gray-200 mb-1">' + top.description + '</div>' +
          _renderEvidenceGrid(top) +
          '<div class="text-gray-400 text-xs italic">' + top.evidence + '</div>' +
          (more > 0 ? '<div class="text-gray-500 text-xs mt-1">' +
            '+ ' + more + ' more suggestion' + (more > 1 ? 's' : '') +
            ' will be re-checked after this is resolved.</div>' : '') +
        '</div>' +
        '<div class="flex flex-col gap-1 shrink-0">' +
          (hasApplyAction
            ? '<button id="align-apply-btn" class="px-3 py-1 rounded bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold">' +
                applyLabel +
              '</button>'
            : '') +
          '<button id="align-dismiss-btn" class="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs">Dismiss</button>' +
        '</div>' +
      '</div>';

    // Insert below the input bar so it's visible without crowding the tier strip.
    var anchor = document.getElementById('input-collapsed') ||
                 document.getElementById('input-section') ||
                 document.body;
    if (anchor.parentNode && anchor !== document.body) {
      anchor.parentNode.insertBefore(banner, anchor.nextSibling);
    } else {
      anchor.appendChild(banner);
    }

    var applyBtn = document.getElementById('align-apply-btn');
    if (applyBtn) {
      applyBtn.onclick = function() { _applySuggestion(top); };
    }
    document.getElementById('align-dismiss-btn').onclick = function() {
      clearAlignmentBanner();
      // Remember this dismissal so navigation/revalidation doesn't re-pop
      // the same suggestion. Cleared whenever the alignment cache is
      // refreshed by runStructuralChecks (after a structural edit).
      if (!state.dismissedAlignmentKeys) state.dismissedAlignmentKeys = {};
      state.dismissedAlignmentKeys[_suggestionKey(top)] = true;
      if (typeof log === 'function') log('ℹ️ Alignment suggestion dismissed by user');
      _retryReconstructionLaunch();
    };

    // Scroll the move list to the suggestion's ply so the user sees both the
    // banner and the relevant reconstruction context at the same time.
    if (typeof goToPly === 'function' && typeof top.atMoveNum === 'number') {
      var targetPly = (top.atMoveNum - 1) * 2 + (top.atColor === 'w' ? 0 : 1);
      try { goToPly(targetPly, { silent: true }); } catch (e) { /* non-fatal */ }
    }

    // Scroll the WINDOW to the banner and flash it briefly so it's hard to
    // miss. scrollIntoView alone has been unreliable — depending on the
    // surrounding scroll container architecture it sometimes barely moves
    // the page. Belt-and-suspenders: try scrollIntoView first, then read
    // the rect and explicitly window.scrollTo if the banner isn't already
    // near the top of the viewport. The box-shadow flash ensures the user
    // sees motion even if the page didn't need to scroll much.
    _scrollWindowToBanner(banner);
    _flashBanner(banner);
  }

  function _scrollWindowToBanner(banner) {
    // Use INSTANT behavior, not smooth. A smooth scroll runs ~300-500ms and
    // races with any other window.scrollTo / scrollIntoView fired during
    // that window — any of which can interrupt the animation before the
    // banner is settled and leave the page parked wherever the racing
    // scroll left it. Instant wins immediately. We then re-assert the
    // position on a few rAF / timeout ticks to catch late-arriving
    // scrolls (e.g. from async fetchFixes paths or worker callbacks).
    function _ensureBannerVisible() {
      try {
        var rect = banner.getBoundingClientRect();
        if (rect.top < 0 || rect.top > 120) {
          var target = window.pageYOffset + rect.top - 60;
          window.scrollTo({ top: Math.max(0, target), behavior: 'instant' });
        }
      } catch (e) {}
    }
    try { banner.scrollIntoView({ block: 'start', behavior: 'instant' }); }
    catch (e) {
      // Older browsers may reject 'instant' on scrollIntoView; fall back.
      try { banner.scrollIntoView({ block: 'start' }); } catch (e2) {}
    }
    // Re-check at increasing intervals. Catches:
    //   - Late scrolls from revalidate's continuation (fetchFixes etc.)
    //   - Smooth scrolls already in flight when the banner appeared
    //   - Layout shifts from async DOM updates
    setTimeout(_ensureBannerVisible, 50);
    setTimeout(_ensureBannerVisible, 250);
    setTimeout(_ensureBannerVisible, 600);
  }

  function _flashBanner(banner) {
    try {
      banner.style.transition = 'box-shadow 0.45s ease-out';
      banner.style.boxShadow = '0 0 24px 6px rgba(251, 146, 60, 0.65)';
      setTimeout(function() {
        try { banner.style.boxShadow = '0 0 0 0 transparent'; } catch (e) {}
      }, 700);
    } catch (e) {}
  }

  // Capture (white, black, wStatus, bStatus) for every move strictly BEFORE
  // changeMoveNum. After the structural edit, _diffMovesBefore compares and
  // logs any mismatch — those would represent unintended drift in the
  // pre-change part of the game.
  function _snapshotMovesBefore(changeMoveNum) {
    if (!state.moves) return null;
    var snap = [];
    for (var i = 0; i < state.moves.length && i < (changeMoveNum - 1); i++) {
      var m = state.moves[i];
      snap.push({
        num: m.num,
        white: m.white || '',
        black: m.black || '',
        wStatus: m.wStatus || '',
        bStatus: m.bStatus || ''
      });
    }
    return snap;
  }

  function _diffMovesBefore(preState, changeMoveNum) {
    if (!preState || !state.moves) return;
    var textDiffs = [];
    var statusDiffs = [];
    for (var i = 0; i < preState.length; i++) {
      var pre = preState[i];
      var post = state.moves[i];
      if (!post) {
        textDiffs.push('move ' + pre.num + ': vanished');
        continue;
      }
      if ((post.white || '') !== pre.white) {
        textDiffs.push(pre.num + '.W: "' + pre.white + '" → "' + (post.white || '') + '"');
      }
      if ((post.black || '') !== pre.black) {
        textDiffs.push(pre.num + '.B: "' + pre.black + '" → "' + (post.black || '') + '"');
      }
      if ((post.wStatus || '') !== pre.wStatus) {
        statusDiffs.push(pre.num + '.W status: ' + pre.wStatus + ' → ' + (post.wStatus || ''));
      }
      if ((post.bStatus || '') !== pre.bStatus) {
        statusDiffs.push(pre.num + '.B status: ' + pre.bStatus + ' → ' + (post.bStatus || ''));
      }
    }
    if (typeof log !== 'function') return;
    if (textDiffs.length) {
      // Text drifts are the real concern. Show all of them, capped higher.
      log('🚨 TEXT drift in moves before structural change point (move ' +
          changeMoveNum + '): ' + textDiffs.slice(0, 40).join('; ') +
          (textDiffs.length > 40 ? '; +' + (textDiffs.length - 40) + ' more' : ''));
      // Also dump the first text-drifted move to console for inspection.
      try {
        console.warn('[ALIGNMENT] Text drift detected; pre/post state:',
          { pre: preState, post: state.moves.slice(0, preState.length) });
      } catch (e) {}
    } else if (statusDiffs.length) {
      // Status-only drift is cosmetic — revalidate will reset them. Mention
      // it briefly so the user knows it was checked.
      log('ℹ️ Pre-change text intact; ' + statusDiffs.length +
          ' status fields reset (benign — revalidate will re-set them).');
    } else {
      log('✓ Pre-change moves intact across re-merge (' + preState.length + ' moves checked)');
    }
  }

  function _applySuggestion(s) {
    clearAlignmentBanner();

    if (s.action === 'delete') {
      // Delete BOTH halves of the redundant full move (W and B cells).
      // deleteDualPly only deletes one half, so we splice directly.
      var sheet = (s.sheet === 'w') ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
      if (!sheet) {
        if (typeof log === 'function') log('⚠️ Sheet not available for alignment fix');
        return;
      }

      var idx = -1;
      for (var i = 0; i < sheet.length; i++) {
        var n = sheet[i].num || sheet[i].move_number;
        if (n === s.atMoveNum && sheet[i].color === 'w') { idx = i; break; }
      }
      if (idx === -1) {
        if (typeof log === 'function') log('⚠️ Cannot find move ' + s.atMoveNum + ' on the sheet');
        return;
      }

      var sheetLabel = (s.sheet === 'w') ? "White's" : "Black's";
      if (typeof log === 'function') {
        log('🛠️ Deleting duplicated full move ' + s.atMoveNum + ' from ' + sheetLabel + ' sheet');
      }

      if (typeof syncCorrectionsToOcrCells === 'function') syncCorrectionsToOcrCells();
      if (typeof clearStaleState === 'function') clearStaleState();

      // Splice 2 cells if the next cell is the matching black half, else 1.
      var spliceCount = (sheet[idx + 1] && sheet[idx + 1].color === 'b') ? 2 : 1;
      sheet.splice(idx, spliceCount);

      if (typeof renumberSheetCells === 'function') renumberSheetCells(sheet);
      // changePly = ply of the deleted full move on the merged sequence —
      // moves before this stay confirmed so re-validation resumes near the
      // edit instead of jumping back to move 1.
      var changePly = (s.atMoveNum - 1) * 2;

      // Drop stale per-sheet metadata at/after the change point — the OTHER
      // sheet's _correctedMove was set against the OLD merge context and
      // would otherwise contaminate the new merge values. See the helper's
      // docstring in shift-ops.js for the full explanation.
      if (typeof clearStaleMetadataFromMoveNum === 'function') {
        clearStaleMetadataFromMoveNum(s.atMoveNum);
      }

      // Snapshot moves BEFORE the change point so we can detect (and log) any
      // unexpected mutation across the re-merge. The user's principle is that
      // moves before the structural edit must be untouched — if any of them
      // change, that's a real bug we need to see.
      var preState = _snapshotMovesBefore(s.atMoveNum);

      if (typeof reMergeAndRevalidate === 'function') reMergeAndRevalidate(changePly);

      _diffMovesBefore(preState, s.atMoveNum);

      // The post-reMerge hook re-runs analyzeSheetAlignment and surfaces the
      // next suggestion (if any) automatically.
      return;
    }

    if (s.action === 'insert' && typeof insertDualPly === 'function') {
      if (typeof log === 'function') {
        log('🛠️ Inserting placeholder on ' + (s.sheet === 'w' ? "White's" : "Black's") +
            " sheet before " + s.atMoveNum + '.' + (s.atColor === 'w' ? 'W' : 'B'));
      }
      insertDualPly(s.atMoveNum, s.atColor, s.sheet, 'before');
      return;
    }

    if (s.action === 'insert_pair') {
      // One full move missing on the named sheet, starting at (atMoveNum,
      // atColor). Splice 2 placeholder cells atomically — handles both the
      // "starts at W half" case (W + B of same move) and the "starts at B
      // half" case (B of moveNum + W of moveNum+1).
      var spSheet = (s.sheet === 'w') ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
      if (!spSheet) {
        if (typeof log === 'function') log('⚠️ Sheet not available for Insert-1');
        return;
      }
      // Locate the target half on the named sheet.
      var spIdx = -1;
      for (var spI = 0; spI < spSheet.length; spI++) {
        var spN = spSheet[spI].num || spSheet[spI].move_number;
        if (spN === s.atMoveNum && spSheet[spI].color === s.atColor) { spIdx = spI; break; }
      }
      if (spIdx === -1) {
        if (typeof log === 'function') {
          log('⚠️ Insert-1: cannot find ' + s.atMoveNum + '.' + s.atColor.toUpperCase() +
              ' on ' + (s.sheet === 'w' ? "White's" : "Black's") + ' sheet');
        }
        return;
      }

      var spLabel = (s.sheet === 'w' ? "White's" : "Black's");
      if (typeof log === 'function') {
        log('🛠️ Inserting 2 placeholder plies on ' + spLabel +
            ' sheet at ' + s.atMoveNum + '.' + s.atColor.toUpperCase());
      }

      if (typeof syncCorrectionsToOcrCells === 'function') syncCorrectionsToOcrCells();
      if (typeof clearStaleState === 'function') clearStaleState();

      // Two placeholders. The exact (num, color) here will be overwritten
      // by renumberSheetCells based on position; we set sensible values.
      var sp1 = createSyntheticOcrCell('???', s.atMoveNum, s.atColor);
      var sp2color = (s.atColor === 'w') ? 'b' : 'w';
      var sp2num = (s.atColor === 'w') ? s.atMoveNum : s.atMoveNum + 1;
      var sp2 = createSyntheticOcrCell('???', sp2num, sp2color);
      spSheet.splice(spIdx, 0, sp1, sp2);

      if (typeof renumberSheetCells === 'function') renumberSheetCells(spSheet);
      if (typeof _backfillPlaceholdersFromOtherSheet === 'function') {
        _backfillPlaceholdersFromOtherSheet(spSheet, s.sheet);
      }
      if (typeof clearStaleMetadataFromMoveNum === 'function') {
        clearStaleMetadataFromMoveNum(s.atMoveNum);
      }
      var spChangePly = (s.atMoveNum - 1) * 2 + (s.atColor === 'w' ? 0 : 1);
      if (typeof reMergeAndRevalidate === 'function') reMergeAndRevalidate(spChangePly);
      return;
    }

    if (s.action === 'insert_double') {
      // Two full moves missing → splice 4 placeholder cells atomically into
      // the named sheet, then renumber + re-merge ONCE. The previous
      // implementation called insertDualPly four times, each of which
      // triggered reMergeAndRevalidate + clearStaleMetadataFromMoveNum;
      // the cascading mutations made calls 2-4 operate on a shifted sheet
      // and only one placeholder ended up where it should.
      var sheet = (s.sheet === 'w') ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
      if (!sheet) {
        if (typeof log === 'function') log('⚠️ Sheet not available for Insert-2');
        return;
      }
      // Locate the white half of s.atMoveNum on the named sheet — that's
      // where the four placeholders go (before this position).
      var idx = -1;
      for (var i = 0; i < sheet.length; i++) {
        var n = sheet[i].num || sheet[i].move_number;
        if (n === s.atMoveNum && sheet[i].color === 'w') { idx = i; break; }
      }
      if (idx === -1) {
        if (typeof log === 'function') {
          log('⚠️ Insert-2: cannot find ' + s.atMoveNum + '.W on ' +
              (s.sheet === 'w' ? "White's" : "Black's") + ' sheet');
        }
        return;
      }

      var sheetLabel = (s.sheet === 'w' ? "White's" : "Black's");
      if (typeof log === 'function') {
        log('🛠️ Inserting 4 placeholder plies on ' + sheetLabel +
            ' sheet at position ' + idx + ' (move ' + s.atMoveNum + '.W)');
      }

      if (typeof syncCorrectionsToOcrCells === 'function') syncCorrectionsToOcrCells();
      if (typeof clearStaleState === 'function') clearStaleState();

      // Build 4 placeholders. The exact (num, color) we set here will be
      // overwritten by renumberSheetCells based on position, but we set
      // sensible values for clarity.
      var p1 = createSyntheticOcrCell('???', s.atMoveNum,     'w');
      var p2 = createSyntheticOcrCell('???', s.atMoveNum,     'b');
      var p3 = createSyntheticOcrCell('???', s.atMoveNum + 1, 'w');
      var p4 = createSyntheticOcrCell('???', s.atMoveNum + 1, 'b');
      sheet.splice(idx, 0, p1, p2, p3, p4);

      if (typeof renumberSheetCells === 'function') renumberSheetCells(sheet);
      // Backfill any of the 4 new placeholders from the other sheet's
      // content at the same (num, color). Reuses the same helper that
      // single-ply insertDualPly uses, so behavior matches.
      if (typeof _backfillPlaceholdersFromOtherSheet === 'function') {
        _backfillPlaceholdersFromOtherSheet(sheet, s.sheet);
      }
      if (typeof clearStaleMetadataFromMoveNum === 'function') {
        clearStaleMetadataFromMoveNum(s.atMoveNum);
      }
      var changePly = (s.atMoveNum - 1) * 2;
      if (typeof reMergeAndRevalidate === 'function') reMergeAndRevalidate(changePly);
      return;
    }

    if (typeof log === 'function') log('⚠️ Cannot apply alignment fix: helper functions not available');
  }

  // ---------------------------------------------------------------------------
  // NOISE NOTICE — informational only
  // ---------------------------------------------------------------------------
  // Trailing-noise detection is now a count-only check that drives a small
  // notice strip. It does NOT gate alignment (analyzeSheetAlignment internally
  // filters trailing noise so smoking-gun detection is safe regardless) and
  // does NOT block reconstruction launches. The user typically resolves noise
  // via the right-click "Delete from here onward" context menu; runStructural-
  // Checks is re-fired from that path so the notice clears automatically when
  // the count reaches zero. A small × dismiss button suppresses the notice for
  // the rest of the session if the user wants to keep the rows.
  // ---------------------------------------------------------------------------

  function detectTrailingNoise(sheet1Cells, sheet2Cells) {
    var t1 = trimTrailingNoise(sheet1Cells);
    var t2 = trimTrailingNoise(sheet2Cells);
    return {
      s1Removed: t1.removed,
      s2Removed: t2.removed,
      total: (t1.removed || 0) + (t2.removed || 0)
    };
  }

  function _noiseBannerEl() { return document.getElementById('alignment-noise-banner'); }
  function clearNoiseBanner() { var el = _noiseBannerEl(); if (el) el.remove(); }

  function showNoiseBanner(noise) {
    clearNoiseBanner();
    if (!noise || noise.total <= 0) return;
    if (state.noiseBannerDismissed) return;  // user has chosen to hide it this session

    var banner = document.createElement('div');
    banner.id = 'alignment-noise-banner';
    banner.className = 'mx-3 my-2 p-2 rounded-lg border border-blue-500/40 bg-blue-900/15 text-xs';
    banner.innerHTML =
      '<div class="flex items-center gap-2">' +
        '<span>🧹</span>' +
        '<span class="text-blue-200">Trailing OCR noise detected. Use the ' +
          '<span class="text-red-300">🗑️</span> buttons in the move list to clean up &mdash; ' +
          'or right-click the <em>first</em> noise row and pick ' +
          '<span class="font-mono text-gray-300">Delete from here onward</span> ' +
          'if the 🗑️ buttons aren\'t on the rows you want.</span>' +
        '<span class="flex-1"></span>' +
        '<button id="noise-dismiss-btn" class="text-gray-500 hover:text-gray-200 px-1" title="Dismiss this notice">&times;</button>' +
      '</div>';

    var anchor = document.getElementById('input-collapsed') ||
                 document.getElementById('input-section') ||
                 document.body;
    if (anchor.parentNode && anchor !== document.body) {
      anchor.parentNode.insertBefore(banner, anchor.nextSibling);
    } else {
      anchor.appendChild(banner);
    }

    document.getElementById('noise-dismiss-btn').onclick = function() {
      clearNoiseBanner();
      state.noiseBannerDismissed = true;
    };
  }

  // ---------------------------------------------------------------------------
  // PIPELINE ENTRY — call after every merge. Updates the (informational) noise
  // notice and refreshes the alignment cache. Noise no longer gates anything;
  // analyzeSheetAlignment internally filters trailing noise so the analysis is
  // safe even when the sheets still contain it.
  // ---------------------------------------------------------------------------

  function runStructuralChecks() {
    var hasNW = !!(window.SheetNWAlignment &&
                   typeof window.SheetNWAlignment.detectNextAlignmentIssue === 'function');
    if (typeof log === 'function') {
      log('🧭 runStructuralChecks called — pipeline: ' +
          (hasNW ? 'NW cascade' : 'OLD windowed-shift fallback') +
          ' | sheets: ' + (state.ocrCellsSheet1 ? 'S1=' + state.ocrCellsSheet1.length : 'S1=null') +
          ', ' + (state.ocrCellsSheet2 ? 'S2=' + state.ocrCellsSheet2.length : 'S2=null'));
    }
    if (!state.ocrCellsSheet1 || !state.ocrCellsSheet2) {
      clearNoiseBanner();
      clearAlignmentBanner();
      state.alignmentAnalysis = null;
      return;
    }

    var noise = detectTrailingNoise(state.ocrCellsSheet1, state.ocrCellsSheet2);
    if (noise.total > 0) {
      showNoiseBanner(noise);
    } else {
      clearNoiseBanner();
    }

    // Use the new Needleman-Wunsch cascade if available; falls back to the
    // old multi-suggestion cache pipeline if the NW module didn't load.
    if (hasNW) {
      _runNWAlignmentCheck();
    } else {
      _cacheAlignmentAnalysis();
      evaluateAtPointAlignment();
    }
  }

  // ---------------------------------------------------------------------------
  // NW cascade integration — one suggestion at a time, iterative
  // ---------------------------------------------------------------------------

  function _runNWAlignmentCheck() {
    // Gate on noise just like the old pipeline did.
    if (state.pendingNoiseReview) {
      clearAlignmentBanner();
      return;
    }
    if (state.ocrCellsSheet1 && state.ocrCellsSheet2) {
      var noise = detectTrailingNoise(state.ocrCellsSheet1, state.ocrCellsSheet2);
      if (noise.total > 0 && !state.noiseBannerDismissed) {
        clearAlignmentBanner();
        return;
      }
    }

    var searchFrom = state.nwSearchFrom || 0;
    if (!state.dismissedNWKeys) state.dismissedNWKeys = {};
    if (!state.postponedNWKeys) state.postponedNWKeys = {};
    if (state.alignmentAutoSurfaceMode === undefined) {
      state.alignmentAutoSurfaceMode = true;  // fresh OCR default
    }

    // Auto-reset postponed keys once the user has cleared all stuck points.
    // The point of Postpone is "I'll come back to this after working
    // through the rest of the game" — so when stuckPly goes null, surface
    // whatever they parked. Re-enable auto-surface so the first re-surfaced
    // banner pops automatically (the user has earned it by finishing stuck
    // points; they're not in the middle of other work).
    var postponedKeys = Object.keys(state.postponedNWKeys);
    if (postponedKeys.length > 0 &&
        (state.stuckPly === null || state.stuckPly === undefined) &&
        !state.stuckInfo) {
      if (typeof log === 'function') {
        log('♻️ Stuck points cleared — re-surfacing ' + postponedKeys.length +
            ' postponed NW suggestion(s)');
      }
      state.postponedNWKeys = {};
      state.alignmentAutoSurfaceMode = true;
      state.nwSearchFrom = 0;  // restart enumeration from the top
    }

    // Enumerate all pending issues for the count badge / log summary.
    // Skips BOTH dismissed keys (permanent for this game) and postponed
    // keys (temporary until stuck points resolve). Approximate (no
    // hypothetical apply between), but good enough to tell the user how
    // much work is left.
    var allPending = [];
    var enumeratedTotal = 0;
    if (window.SheetNWAlignment.enumerateAlignmentIssues) {
      var enumerated = window.SheetNWAlignment.enumerateAlignmentIssues(
        state.ocrCellsSheet1, state.ocrCellsSheet2);
      enumeratedTotal = enumerated.length;
      for (var ei = 0; ei < enumerated.length; ei++) {
        var k = _nwSuggestionKey(enumerated[ei]);
        if (!state.dismissedNWKeys[k] && !state.postponedNWKeys[k]) {
          allPending.push(enumerated[ei]);
        }
      }
    }
    state.alignmentPendingIssues = allPending;

    // ALWAYS log the enumeration summary so the user can see at a glance
    // what the cascade thinks about the whole game, before any per-call
    // workflow gates kick in.
    if (typeof log === 'function') {
      var pendBits = allPending.slice(0, 6).map(function(s) {
        var p = (s.action === 'insert') ? s.afterPly : s.plies[0];
        var mv = Math.floor(p / 2) + 1 + '.' + (p % 2 === 0 ? 'W' : 'B');
        var act = s.action === 'insert' ? ('ins' + s.nPlies)
                : s.action === 'delete_duplicate' ? 'del_dup'
                : ('del' + s.nPlies);
        return act + '@' + mv;
      });
      var pendStr = pendBits.length ? ' [' + pendBits.join(' ') + (allPending.length > 6 ? ' …' : '') + ']' : '';
      var declinedN = Object.keys(state.dismissedNWKeys).length;
      var postponedN = Object.keys(state.postponedNWKeys).length;
      var filteredBits = [];
      if (declinedN > 0) filteredBits.push(declinedN + ' declined');
      if (postponedN > 0) filteredBits.push(postponedN + ' postponed');
      var filteredStr = filteredBits.length ? ' (' + filteredBits.join(', ') + ')' : '';
      log('🧭 NW enumerate: ' + enumeratedTotal + ' total, ' +
          allPending.length + ' pending' + filteredStr + pendStr);
    }

    // Pick the suggestion to surface from the enumerated pending list,
    // NOT by advancing searchFrom (which only exists to drive the
    // post-apply "find the next issue forward" flow). When the user
    // navigates back into a region that searchFrom has already passed
    // — e.g. searchFrom=122 after several applies, but the user is now
    // at ply 107 with pending issues at plies 100-115 — using searchFrom
    // hides all of them. Pick by proximity to currentPly instead.
    var sug = null;
    if (allPending.length > 0) {
      var refPlyForPick = (typeof state.currentPly === 'number') ? state.currentPly :
                          (typeof state.stuckPly === 'number') ? state.stuckPly : 0;
      // Auto-surface mode uses the first issue (initial fresh-OCR flow).
      // Otherwise pick the pending issue closest to where the user is.
      if (state.alignmentAutoSurfaceMode) {
        sug = allPending[0];
      } else {
        var bestDist = Infinity;
        for (var pi = 0; pi < allPending.length; pi++) {
          var p = allPending[pi];
          var pPly = (p.action === 'insert') ? p.afterPly : p.plies[0];
          var d = Math.abs(pPly - refPlyForPick);
          if (d < bestDist) { bestDist = d; sug = p; }
        }
      }
    }

    // Workflow gate: only auto-surface a banner if (a) we're in
    // auto-surface mode (fresh OCR — show the first issue immediately),
    // or (b) the user has navigated NEAR this issue's location.
    // Otherwise suppress the banner and just update the count.
    if (sug && !state.alignmentAutoSurfaceMode) {
      var sugPly = (sug.action === 'insert') ? sug.afterPly : sug.plies[0];
      var refPly = (typeof state.currentPly === 'number') ? state.currentPly :
                   (typeof state.stuckPly === 'number') ? state.stuckPly : 0;
      var nearby = Math.abs(sugPly - refPly) <= 8;
      if (!nearby) {
        // Don't surface; explain why so the user isn't left wondering.
        clearAlignmentBanner();
        var sugMove = Math.floor(sugPly / 2) + 1;
        if (typeof log === 'function') {
          log('🧭 NW workflow gate: next suggestion at move ' + sugMove +
              ' (ply ' + sugPly + ') is too far from currentPly=' + refPly +
              ' (auto-surface off after first apply/dismiss). Navigate near it to see the banner.');
        }
        _retryReconstructionLaunch();
        return;
      }
    }

    if (typeof log === 'function') {
      if (sug) {
        var lab = sug.action === 'delete_duplicate'
          ? 'delete_dup ' + sug.nPlies + 'p on ' + (sug.fromSheet === 's1' ? 'White' : 'Black') +
            ' @ply ' + sug.plies[0] + ' (move ' + (sug.moveNum || '?') + ')'
          : sug.action === 'delete'
            ? 'delete ' + sug.nPlies + 'p on ' + (sug.fromSheet === 's1' ? 'White' : 'Black') +
              ' @plies ' + sug.plies.join(',') +
              ' anchors ' + (sug.beforeScore || 0).toFixed(2) + '/' + (sug.afterScore || 0).toFixed(2)
            : 'insert ' + sug.nPlies + 'p on ' + (sug.onSheet === 's1' ? 'White' : 'Black') +
              ' after ply ' + sug.afterPly +
              ' anchors ' + (sug.beforeScore || 0).toFixed(2) + '/' + (sug.afterScore || 0).toFixed(2);
        log('🧭 NW alignment: surfacing → ' + lab);
      } else {
        log('🧭 NW alignment: nothing to surface (no pending issues after dismissals)');
        // Diagnostic dump: why did each layer come up empty?
        var d = window.SheetNWAlignment.detectNextAlignmentIssue.lastDiag || {};
        var dup1 = d.dup1 || {};
        var dup2 = d.dup2 || {};
        var d1Best = dup1.best
          ? ('best wScore=' + dup1.best.wScore.toFixed(2) +
             ' bScore=' + dup1.best.bScore.toFixed(2) +
             ' @ply ' + dup1.best.i + ' (' + dup1.best.w1Top + ')')
          : 'none';
        var d2Best = dup2.best
          ? ('best wScore=' + dup2.best.wScore.toFixed(2) +
             ' bScore=' + dup2.best.bScore.toFixed(2) +
             ' @ply ' + dup2.best.i + ' (' + dup2.best.w1Top + ')')
          : 'none';
        log('  dup1 (S1): topMatchPairs=' + (dup1.topMatches || 0) + ' ' + d1Best);
        log('  dup2 (S2): topMatchPairs=' + (dup2.topMatches || 0) + ' ' + d2Best);
        if (d.nw) {
          log('  NW from ply ' + d.nwStart + ': len=' + d.nw.alignmentLen +
              ' matches=' + d.nw.counts.match +
              ' gap_s1=' + d.nw.counts.gap_s1 +
              ' gap_s2=' + d.nw.counts.gap_s2 +
              ' maxMatch=' + (d.nw.maxMatch === -Infinity ? '-' : d.nw.maxMatch.toFixed(3)) +
              ' top5=[' + d.nw.top5MatchScores.join(',') + ']');
        }
        if (d.extract && d.extract.rejections && d.extract.rejections.length) {
          log('  rejected ' + d.extract.rejections.length + ' gap(s):');
          d.extract.rejections.slice(0, 5).forEach(function(r) {
            var extra = '';
            if (r.bestBeforeScore !== undefined) extra += ' bestBefore=' + r.bestBeforeScore.toFixed(3);
            if (r.bestAfterScore !== undefined) extra += ' bestAfter=' + r.bestAfterScore.toFixed(3);
            if (r.adjacentOpposite !== undefined) extra += ' adjacentOpposite=' + r.adjacentOpposite;
            if (r.before !== undefined) extra += ' anchors=' + r.before.toFixed(2) + '/' + r.after.toFixed(2);
            if (r.required !== undefined) extra += ' need>=' + r.required.toFixed(2);
            log('    ' + r.gapType + ' size=' + r.size + ' @' + r.gapStart +
                ' reason=' + r.reason + extra);
          });
        }
        // Forward-simulation suppression: if a 1-ply candidate was emitted
        // by extractFirstSuggestion but the simulation check rejected it,
        // the cascade returns null. Tell the user which safety signal
        // fired — otherwise it looks like nothing happened.
        if (d.suppressed) {
          var s = d.suppressed;
          var sPly = (s.action === 'insert') ? s.afterPly : (s.plies && s.plies[0]);
          var sim = d.simulation || {};
          var reason = sim.suppressReason || (sim.isReversed ? 'reverse_proposal' : 'unknown');
          var follow = sim.followUp || null;
          var scoreInfo = (typeof sim.scoreDelta === 'number')
            ? ' Δ=' + sim.scoreDelta.toFixed(2) +
              ' (pre=' + (sim.preScore || 0).toFixed(2) +
              ' post=' + (sim.postScore || 0).toFixed(2) + ')'
            : '';
          log('  ⊘ Forward-sim suppressed ' + s.action + ' @ply ' + sPly +
              ' reason=' + reason + scoreInfo +
              (follow ? ' sim-follow=' + follow : ''));
        }
      }
    }

    if (!sug) {
      clearAlignmentBanner();
      _retryReconstructionLaunch();
      return;
    }
    showNWAlignmentBanner(sug);
  }

  // Banner UI for NW suggestions. Shape differs from the old suggestion
  // (action/onSheet/plies/afterPly/labels) so we render fresh markup.
  function showNWAlignmentBanner(sug) {
    // Skip re-render + re-scroll if the banner already shows the SAME
    // suggestion. _runNWAlignmentCheck fires on every revalidation and
    // navigation tick; without this guard, the full clearAlignmentBanner
    // + rebuild + scrollIntoView runs each time, yanking the user back
    // to the banner while they're trying to work on other stuck points.
    // Genuine new suggestions (different key) re-render and scroll as
    // before. Navigation-near triggers also re-render because the
    // "surface" selection in _runNWAlignmentCheck can switch to a
    // closer suggestion, producing a new key.
    var newKey = _nwSuggestionKey(sug);
    var existingBanner = document.getElementById('alignment-suggestion-banner');
    if (existingBanner && existingBanner.dataset.suggestionKey === newKey) {
      return;
    }
    clearAlignmentBanner();

    var icon = sug.action === 'insert' ? '➕' : '✂️';
    var sheetLabel = sug.fromSheet === 's1' || sug.onSheet === 's1' ? "White's" : "Black's";
    var actionLabel = sug.action === 'insert'
      ? ('Insert ' + sug.nPlies + ' placeholder ' + (sug.nPlies > 1 ? 'plies' : 'ply') +
         ' on ' + sheetLabel + " sheet")
      : sug.action === 'delete_duplicate'
        ? ('Delete duplicated full move ' + sug.moveNum + ' from ' + sheetLabel + " sheet")
        : ('Delete ' + sug.nPlies + ' extra ' + (sug.nPlies > 1 ? 'plies' : 'ply') +
           ' from ' + sheetLabel + " sheet");

    // Evidence lines beneath the AFTER block. Two flavors:
    // - NW gap insert/delete: "gap boundary match" (pool-overlap of anchor
    //   cells across sheets, expressed as % of 2.00 = "fraction of OCR
    //   confidence shared between the two sheets at the boundary").
    // - delete_duplicate: "duplicate match" (pool-overlap between the
    //   suspected-duplicate row and the row above it on the SAME sheet —
    //   that's how findDuplicateNear identifies the duplicate in the first
    //   place: same SAN top + very high pool overlap on adjacent rows).
    // Both flavors append "alignment improvement vs. no fix" (the NW score
    // delta on the local window WITH vs. WITHOUT the proposed edit).
    var evidenceLines = [];
    if (sug.action === 'delete_duplicate' &&
        typeof sug.dupWScore === 'number' && typeof sug.dupBScore === 'number') {
      var dupSheetLabel = (sug.fromSheet === 's1') ? "White's" : "Black's";
      var prevNum = (typeof sug.dupPrevMoveNum === 'number') ? sug.dupPrevMoveNum : '?';
      var pctDupW = Math.round((sug.dupWScore / 2.0) * 100);
      var pctDupB = Math.round((sug.dupBScore / 2.0) * 100);
      evidenceLines.push(
        'duplicate match on ' + dupSheetLabel + ' sheet (rows ' + prevNum + ' ↔ ' + sug.moveNum + '): ' +
        '<span class="text-gray-200">White\'s move pool: ' + pctDupW + '% / Black\'s move pool: ' + pctDupB + '%</span>' +
        ' <span class="text-gray-500">(exact-SAN overlap ' + sug.dupWScore.toFixed(2) + ' / ' +
        sug.dupBScore.toFixed(2) + ' of 2.00 max)</span>'
      );
      // Structured (chess-aware) match: gives partial credit for shared
      // target square / rank / file / piece. Helpful when both cells point
      // strongly at the same square but the OCR couldn't agree on which
      // piece moved there. Read-only add-on — does not change the algorithm.
      var structOverlap = window.SheetNWAlignment && window.SheetNWAlignment.poolOverlapStructured;
      if (structOverlap && state.ocrCellsSheet1 && state.ocrCellsSheet2 &&
          typeof sug.dupPrevMoveNum === 'number' && typeof sug.moveNum === 'number') {
        var dupSheetCells = (sug.fromSheet === 's1') ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
        var prevW = _findCellAt(dupSheetCells, sug.dupPrevMoveNum, 'w');
        var thisW = _findCellAt(dupSheetCells, sug.moveNum, 'w');
        var prevB = _findCellAt(dupSheetCells, sug.dupPrevMoveNum, 'b');
        var thisB = _findCellAt(dupSheetCells, sug.moveNum, 'b');
        if (prevW && thisW && prevB && thisB) {
          var sW = structOverlap(_altsForOverlay(prevW), _altsForOverlay(thisW));
          var sB = structOverlap(_altsForOverlay(prevB), _altsForOverlay(thisB));
          if (sW && sB) {
            evidenceLines.push(
              'structured match (square/rank/piece weighted): ' +
              '<span class="text-gray-200">White\'s ' + Math.round((sW.combinedScore / 2.0) * 100) +
              '% / Black\'s ' + Math.round((sB.combinedScore / 2.0) * 100) + '%</span>' +
              ' <span class="text-gray-500">' +
              '(square ' + Math.round((sW.squareScore / 2.0) * 100) + '/' + Math.round((sB.squareScore / 2.0) * 100) +
              ', rank ' + Math.round((sW.rankScore / 2.0) * 100) + '/' + Math.round((sB.rankScore / 2.0) * 100) +
              ', piece ' + Math.round((sW.pieceScore / 2.0) * 100) + '/' + Math.round((sB.pieceScore / 2.0) * 100) +
              ')</span>'
            );
          }
        }
      }
      // Also surface gap-region pre/post for delete_duplicate. Pre = the
      // duplicated row's cells cross-match other sheet (low — they're the
      // misalignment); post = the row that shifts up after the delete vs
      // other sheet (recovered alignment).
      var dupGapMatch = _computeGapRegionMatch(sug);
      if (dupGapMatch && typeof dupGapMatch.prePct === 'number' && typeof dupGapMatch.postPct === 'number') {
        var dupDeltaPp = dupGapMatch.postPct - dupGapMatch.prePct;
        var dupSign = dupDeltaPp >= 0 ? '+' : '';
        evidenceLines.push(
          'gap cells cross-sheet match: <span class="text-gray-200">' +
          Math.round(dupGapMatch.prePct) + '% → ' + Math.round(dupGapMatch.postPct) +
          '% (' + dupSign + Math.round(dupDeltaPp) + 'pp)</span>' +
          ' <span class="text-gray-500">(removed cells vs. other sheet → cells that shift up vs. other sheet)</span>'
        );
      }
    } else if (sug.beforeScore !== undefined && sug.afterScore !== undefined) {
      var pctBefore = Math.round((sug.beforeScore / 2.0) * 100);
      var pctAfter  = Math.round((sug.afterScore  / 2.0) * 100);
      // Static metric — these are pool overlaps of the cells that DO align
      // across sheets, immediately bracketing the gap. The cells don't move
      // with the proposed insert/delete, so there's no pre/post version of
      // this number; it just is. The pre/post comparison the user wants is
      // captured by "alignment quality" and "gap cells cross-sheet match"
      // lines below.
      evidenceLines.push(
        'before-gap anchor: <span class="text-gray-200">' + pctBefore + '%</span>' +
        ', after-gap anchor: <span class="text-gray-200">' + pctAfter + '%</span>' +
        ' <span class="text-gray-500">(' + sug.beforeScore.toFixed(2) + ' / ' +
        sug.afterScore.toFixed(2) + ' of 2.00 max — static across pre/post)</span>'
      );
      // Pre/post of the GAP CELLS specifically: how well do the cells AT
      // the gap position match the other sheet, before vs after the fix?
      // Insert: pre = original cells at that position cross-match S2;
      //         post = placeholders filled from S2 → ~100% by construction.
      // Delete: pre = cells being removed vs other sheet (low — they're
      //               misaligned cells);
      //         post = cells that shift up vs other sheet (recovered).
      var gapMatch = _computeGapRegionMatch(sug);
      if (gapMatch && typeof gapMatch.prePct === 'number' && typeof gapMatch.postPct === 'number') {
        var deltaPp = gapMatch.postPct - gapMatch.prePct;
        var deltaSign = deltaPp >= 0 ? '+' : '';
        evidenceLines.push(
          'gap cells cross-sheet match: <span class="text-gray-200">' +
          Math.round(gapMatch.prePct) + '% → ' + Math.round(gapMatch.postPct) +
          '% (' + deltaSign + Math.round(deltaPp) + 'pp)</span>' +
          ' <span class="text-gray-500">(avg pool overlap of cells at the gap position vs. the other sheet)</span>'
        );
      }
      // Structured match on the boundary anchors. Same pairs that produced
      // beforeScore/afterScore (which use exact-SAN matching only), but
      // scored with the chess-aware decomposition: agreement on target
      // square, rank, file, piece. Surfaces structural agreement that
      // exact-SAN matching can miss (e.g. both alts target rank 5 but
      // disagree on which piece goes there).
      var structOverlap2 = window.SheetNWAlignment && window.SheetNWAlignment.poolOverlapStructured;
      if (structOverlap2 && state.ocrCellsSheet1 && state.ocrCellsSheet2 &&
          typeof sug.beforeAnchorS1Ply === 'number' &&
          typeof sug.afterAnchorS1Ply === 'number') {
        function _cellByPly(cells, ply) {
          if (typeof ply !== 'number' || ply < 0) return null;
          var num = Math.floor(ply / 2) + 1;
          var col = (ply % 2 === 0) ? 'w' : 'b';
          return _findCellAt(cells, num, col);
        }
        var beS1 = _cellByPly(state.ocrCellsSheet1, sug.beforeAnchorS1Ply);
        var beS2 = _cellByPly(state.ocrCellsSheet2, sug.beforeAnchorS2Ply);
        var afS1 = _cellByPly(state.ocrCellsSheet1, sug.afterAnchorS1Ply);
        var afS2 = _cellByPly(state.ocrCellsSheet2, sug.afterAnchorS2Ply);
        if (beS1 && beS2 && afS1 && afS2) {
          var sBefore = structOverlap2(_altsForOverlay(beS1), _altsForOverlay(beS2));
          var sAfter  = structOverlap2(_altsForOverlay(afS1), _altsForOverlay(afS2));
          if (sBefore && sAfter) {
            evidenceLines.push(
              'structured anchor match (square/rank/piece weighted): ' +
              '<span class="text-gray-200">before-gap ' + Math.round((sBefore.combinedScore / 2.0) * 100) +
              '%, after-gap ' + Math.round((sAfter.combinedScore / 2.0) * 100) + '%</span>' +
              ' <span class="text-gray-500">' +
              '(square ' + Math.round((sBefore.squareScore / 2.0) * 100) + '/' + Math.round((sAfter.squareScore / 2.0) * 100) +
              ', rank ' + Math.round((sBefore.rankScore / 2.0) * 100) + '/' + Math.round((sAfter.rankScore / 2.0) * 100) +
              ', piece ' + Math.round((sBefore.pieceScore / 2.0) * 100) + '/' + Math.round((sAfter.pieceScore / 2.0) * 100) +
              ')</span>'
            );
          }
        }
      }
    }
    if (typeof sug.scoreDelta === 'number') {
      // Convert raw NW alignment scores (sum over a window of cells, where
      // each match contributes up to ~1.95) into per-cell-average percentages
      // of "perfect alignment." This puts pre/post on the same 0..100 scale
      // as the anchor and duplicate-match numbers above so the banner stops
      // mixing units.
      var MAX_PER_CELL = 1.95;
      var prePct = null, postPct = null;
      if (typeof sug.preCells === 'number' && sug.preCells > 0) {
        prePct = Math.max(0, Math.min(100, (sug.preScore / (sug.preCells * MAX_PER_CELL)) * 100));
      }
      if (typeof sug.postCells === 'number' && sug.postCells > 0) {
        postPct = Math.max(0, Math.min(100, (sug.postScore / (sug.postCells * MAX_PER_CELL)) * 100));
      }
      var deltaSign = sug.scoreDelta >= 0 ? '+' : '';
      var pctPart = '';
      if (prePct !== null && postPct !== null) {
        var pctDeltaSign = (postPct - prePct) >= 0 ? '+' : '';
        pctPart =
          '<span class="text-gray-200">' + Math.round(prePct) + '% → ' + Math.round(postPct) +
          '% (' + pctDeltaSign + (postPct - prePct).toFixed(0) + 'pp)</span>';
      }
      evidenceLines.push(
        'alignment quality (per-cell match avg): ' +
        (pctPart || '<span class="text-gray-200">' + deltaSign + sug.scoreDelta.toFixed(2) + '</span>') +
        ' <span class="text-gray-500">(raw NW ' + sug.preScore.toFixed(2) + ' → ' +
        sug.postScore.toFixed(2) + ', ' + deltaSign + sug.scoreDelta.toFixed(2) + ')</span>'
      );
    }
    var anchorStr = evidenceLines.join('<br/>');

    var detailHtml = '';
    if (sug.action === 'insert' && sug.s2Content) {
      detailHtml = '<div class="text-gray-400 text-xs mt-1">Other sheet has at this gap: ' +
        sug.s2Content.map(function(c) {
          return '<span class="font-mono text-gray-300">' + c.label + ' ' + c.topMove + '</span>';
        }).join(', ') + '</div>';
    } else if (sug.labels) {
      detailHtml = '<div class="text-gray-400 text-xs mt-1">Plies to delete: ' +
        sug.labels.map(function(c) {
          return '<span class="font-mono text-gray-300">' + c.label + ' ' + c.topMove + '</span>';
        }).join(', ') + '</div>';
    }

    // Evidence strip: re-use the existing _renderEvidenceGrid, which expects
    // {atMoveNum, sheet ('w'|'b'), action ('insert'|'delete')}.
    var actionPly = (sug.action === 'insert') ? sug.afterPly : sug.plies[0];
    var atMoveNum = (typeof actionPly === 'number') ? Math.floor(actionPly / 2) + 1 : null;
    var sheetLetter = (sug.fromSheet === 's1' || sug.onSheet === 's1') ? 'w' : 'b';
    // Build a per-cell delete map so multi-ply (and non-contiguous) deletes
    // get accurate strikethrough on each individual cell.
    var deletedPlySet = null;
    if (sug.action === 'delete' || sug.action === 'delete_duplicate') {
      deletedPlySet = {};
      sug.plies.forEach(function(p) {
        var num = Math.floor(p / 2) + 1;
        var col = (p % 2 === 0) ? 'w' : 'b';
        deletedPlySet[num + '_' + col] = true;
      });
    }
    var evidenceShape = {
      atMoveNum: atMoveNum,
      sheet: sheetLetter,
      action: (sug.action === 'insert') ? 'insert' : 'delete',
      deletedPlySet: deletedPlySet
    };
    var evidenceHtml = _renderEvidenceGrid(evidenceShape);
    // AFTER block — show what the sheets look like once the operation is
    // applied. Inserted placeholders highlighted in green, subsequent rows
    // shift to fill the new positions.
    var afterHtml = _renderPostApplyEvidence(sug);

    var banner = document.createElement('div');
    banner.id = 'alignment-suggestion-banner';
    banner.dataset.suggestionKey = _nwSuggestionKey(sug);
    banner.className = 'mx-3 my-2 p-3 rounded-lg border border-orange-500/60 bg-orange-900/20 text-sm';
    banner.innerHTML =
      '<div class="flex items-start gap-3">' +
        '<div class="text-lg leading-none">' + icon + '</div>' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-2 mb-1">' +
            '<span class="text-orange-200 font-semibold">Alignment suggestion</span>' +
            '<button id="alignment-graph-toggle" class="text-[10px] px-1.5 py-0.5 rounded bg-gray-700/50 hover:bg-gray-600/60 text-gray-300" title="Toggle the cross-sheet OCR-match graph">' +
              (_isMatchGraphEnabled() ? 'graph: on' : 'graph: off') +
            '</button>' +
            '<button id="alignment-alts-toggle" class="text-[10px] px-1.5 py-0.5 rounded bg-gray-700/50 hover:bg-gray-600/60 text-gray-300" title="Toggle showing the top-5 OCR alternatives per cell with confidence (default: top-1 only)">' +
              (_isAllAltsEnabled() ? 'alts: top-5' : 'alts: top-1') +
            '</button>' +
          '</div>' +
          '<div class="text-gray-200 mb-1">' + actionLabel + '</div>' +
          detailHtml +
          evidenceHtml +
          afterHtml +
          (anchorStr ? '<div class="text-gray-400 text-xs italic mt-1">' + anchorStr + '</div>' : '') +
        '</div>' +
        '<div class="flex flex-col gap-1 shrink-0">' +
          '<button id="align-apply-btn" class="px-3 py-1 rounded bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold" title="Apply the suggested edit and re-merge">Apply &amp; Re-merge</button>' +
          '<button id="align-postpone-btn" class="px-3 py-1 rounded bg-yellow-700 hover:bg-yellow-600 text-yellow-100 text-xs" title="Hide for now; re-surface once all stuck points are resolved">Postpone</button>' +
          '<button id="align-decline-btn" class="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs" title="Reject this suggestion — don\'t show again">Decline</button>' +
        '</div>' +
      '</div>';

    var anchor = document.getElementById('input-collapsed') ||
                 document.getElementById('input-section') || document.body;
    if (anchor.parentNode && anchor !== document.body) {
      anchor.parentNode.insertBefore(banner, anchor.nextSibling);
    } else {
      anchor.appendChild(banner);
    }

    document.getElementById('align-apply-btn').onclick = function() {
      _applyNWSuggestion(sug);
    };

    var graphBtn = document.getElementById('alignment-graph-toggle');
    if (graphBtn) graphBtn.onclick = _toggleAlignmentMatchOverlay;

    var altsBtn = document.getElementById('alignment-alts-toggle');
    if (altsBtn) altsBtn.onclick = _toggleAllAlts;

    // One-time install of cell-hover tooltip delegation. Listener stays on
    // body across banner re-renders; harmless when no evidence cells exist.
    _ensureTooltipDelegation();

    // Stash the current suggestion so the overlay can draw context-sensitive
    // edges (e.g. same-sheet duplicate edges for delete_duplicate).
    _currentSuggestion = sug;

    // Defer one frame so layout has settled before measuring cell rects.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(_drawAlignmentMatchOverlay);
    } else {
      setTimeout(_drawAlignmentMatchOverlay, 0);
    }

    // Redraw curves whenever the banner's layout changes (font load, fold
    // open, container resize) or the window is resized.
    if (typeof ResizeObserver === 'function' && !_overlayResizeObserver) {
      _overlayResizeObserver = new ResizeObserver(function() {
        _drawAlignmentMatchOverlay();
      });
      _overlayResizeObserver.observe(banner);
    }
    if (!_overlayResizeListener) {
      _overlayResizeListener = function() { _drawAlignmentMatchOverlay(); };
      window.addEventListener('resize', _overlayResizeListener);
    }

    // Common post-action bookkeeping for both Decline and Postpone: skip
    // past this region on the next pass, turn off auto-surface so further
    // issues only show when the user navigates near them, clear the
    // banner, and re-run the cascade so the NEXT suggestion (if any)
    // surfaces appropriately.
    function _afterDeclineOrPostpone() {
      var skipPly = (sug.action === 'insert')
        ? (sug.afterPly + sug.nPlies + 4)
        : (sug.plies[sug.plies.length - 1] + 4);
      state.nwSearchFrom = skipPly;
      state.alignmentAutoSurfaceMode = false;
      clearAlignmentBanner();
      _runNWAlignmentCheck();
    }

    document.getElementById('align-decline-btn').onclick = function() {
      if (!state.dismissedNWKeys) state.dismissedNWKeys = {};
      state.dismissedNWKeys[_nwSuggestionKey(sug)] = true;
      if (typeof log === 'function') log('✖ NW alignment DECLINED — will not show again for this game');
      _afterDeclineOrPostpone();
    };
    document.getElementById('align-postpone-btn').onclick = function() {
      if (!state.postponedNWKeys) state.postponedNWKeys = {};
      state.postponedNWKeys[_nwSuggestionKey(sug)] = true;
      if (typeof log === 'function') log('⏸ NW alignment POSTPONED — will re-surface once all stuck points are resolved');
      _afterDeclineOrPostpone();
    };

    // Scroll the window so the banner is unmistakable, with a brief flash.
    // Instant + re-asserted at intervals — same rationale as
    // _scrollWindowToBanner above (smooth scrolls race with whatever
    // else fires window.scrollTo during their ~300-500ms animation).
    function _ensureNWBannerVisible() {
      try {
        var rect = banner.getBoundingClientRect();
        if (rect.top < 0 || rect.top > 120) {
          window.scrollTo({ top: window.pageYOffset + rect.top - 60, behavior: 'instant' });
        }
      } catch (e) {}
    }
    try { banner.scrollIntoView({ block: 'start', behavior: 'instant' }); }
    catch (e) {
      try { banner.scrollIntoView({ block: 'start' }); } catch (e2) {}
    }
    setTimeout(_ensureNWBannerVisible, 50);
    setTimeout(_ensureNWBannerVisible, 250);
    setTimeout(_ensureNWBannerVisible, 600);
    try {
      banner.style.transition = 'box-shadow 0.45s ease-out';
      banner.style.boxShadow = '0 0 24px 6px rgba(251, 146, 60, 0.65)';
      setTimeout(function() { try { banner.style.boxShadow = '0 0 0 0 transparent'; } catch (e) {} }, 700);
    } catch (e) {}

    // Reminder log: tell the user a banner is up so they know to scroll
    // up if they're focused on the move list. Also include count of
    // remaining pending issues so they know the workload.
    if (typeof log === 'function') {
      var pendingCount = (state.alignmentPendingIssues || []).length;
      var remaining = Math.max(0, pendingCount - 1);
      var moveLabel = (typeof atMoveNum === 'number') ? ('move ' + atMoveNum) : 'top of game';
      var tail = remaining > 0
        ? (' — ' + remaining + ' more pending after this one')
        : '';
      log('🧭 Alignment suggestion shown for ' + moveLabel +
          ' — scroll up to see it' + tail + '.');
    }
  }

  function _nwSuggestionKey(sug) {
    return [sug.action, sug.fromSheet || sug.onSheet, sug.nPlies,
            (sug.plies || []).join(','), sug.afterPly || ''].join('|');
  }

  // Apply an NW suggestion by mutating per-sheet cells directly, then
  // re-merging. Each apply triggers a fresh _runNWAlignmentCheck via the
  // reMergeAndRevalidate post-hook (which calls runStructuralChecks).
  function _applyNWSuggestion(sug) {
    clearAlignmentBanner();
    var sheet, sheetTag;
    if (sug.action === 'insert') {
      sheetTag = sug.onSheet;
    } else {
      sheetTag = sug.fromSheet;
    }
    sheet = (sheetTag === 's1') ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
    if (!sheet) {
      if (typeof log === 'function') log('⚠️ NW apply: sheet unavailable');
      return;
    }
    var sheetSide = (sheetTag === 's1') ? 'w' : 'b';

    if (typeof syncCorrectionsToOcrCells === 'function') syncCorrectionsToOcrCells();
    if (typeof clearStaleState === 'function') clearStaleState();

    var changePly;
    if (sug.action === 'delete' || sug.action === 'delete_duplicate') {
      // Plies may be NON-CONTIGUOUS (bridging skips matched cells). Splice
      // each in REVERSE ply order so earlier indices stay valid as later
      // ones are removed.
      var sortedPliesDesc = sug.plies.slice().sort(function(a, b) { return b - a; });
      sortedPliesDesc.forEach(function(p) { sheet.splice(p, 1); });
      changePly = sortedPliesDesc[sortedPliesDesc.length - 1];  // earliest
      if (typeof log === 'function') {
        var contiguous = sortedPliesDesc.every(function(p, i) {
          return i === 0 || p === sortedPliesDesc[i - 1] - 1;
        });
        log('🛠️ NW: deleted ' + sug.plies.length + ' ' +
            (contiguous ? 'contiguous' : 'non-contiguous') + ' plies [' +
            sug.plies.slice().sort(function(a, b) { return a - b; }).join(',') + '] from ' +
            (sheetTag === 's1' ? "White's" : "Black's") + ' sheet');
      }
    } else if (sug.action === 'insert') {
      var insertAt = sug.afterPly + 1;
      var placeholders = [];
      for (var k = 0; k < sug.nPlies; k++) {
        var pIdx = insertAt + k;
        var pNum = Math.floor(pIdx / 2) + 1;
        var pCol = (pIdx % 2 === 0) ? 'w' : 'b';
        placeholders.push(createSyntheticOcrCell('???', pNum, pCol));
      }
      sheet.splice.apply(sheet, [insertAt, 0].concat(placeholders));
      changePly = insertAt;
      if (typeof log === 'function') {
        log('🛠️ NW: inserted ' + sug.nPlies + ' placeholder plies at ply ' + insertAt +
            ' on ' + (sheetTag === 's1' ? "White's" : "Black's") + ' sheet');
      }
    } else {
      if (typeof log === 'function') log('⚠️ NW apply: unknown action ' + sug.action);
      return;
    }

    if (typeof renumberSheetCells === 'function') renumberSheetCells(sheet);
    var changeMoveNum = Math.floor(changePly / 2) + 1;
    if (typeof clearStaleMetadataFromMoveNum === 'function') {
      clearStaleMetadataFromMoveNum(changeMoveNum);
    }
    // Backfill placeholders from other sheet for inserts.
    if (sug.action === 'insert' && typeof _backfillPlaceholdersFromOtherSheet === 'function') {
      _backfillPlaceholdersFromOtherSheet(sheet, sheetSide);
    }
    // Advance searchFrom past the change so the next pass continues forward.
    state.nwSearchFrom = Math.max(0, changePly - 4);
    // After the first apply, stop auto-popping new banners. Subsequent
    // alignment issues surface only when navigation lands near them.
    state.alignmentAutoSurfaceMode = false;
    if (typeof reMergeAndRevalidate === 'function') {
      reMergeAndRevalidate(changePly);
    }
  }

  function _cacheAlignmentAnalysis() {
    var analysis = analyzeSheetAlignment(state.ocrCellsSheet1, state.ocrCellsSheet2);
    state.alignmentAnalysis = analysis;
    // Refresh of analysis = new structural picture. Forget previous dismissals
    // so the user sees fresh suggestions (some may genuinely be different now).
    state.dismissedAlignmentKeys = {};

    // ALWAYS log a brief summary (in the main log panel) — just one line per
    // detector run so the user can see whether the detector fired and what
    // it found, without enabling any debug flag.
    if (typeof log === 'function') {
      var shifts = analysis.shifts || [];
      var sugs = analysis.suggestions || [];
      var shiftBits = shifts.map(function(sh) {
        return sh.moveNum + '.' + sh.color.toUpperCase() +
               '(' + (sh.delta > 0 ? '+' : '') + sh.delta + ')';
      });
      var shiftStr = shiftBits.length ? '[' + shiftBits.join(' ') + ']' : '[none]';
      var sugBits = sugs.map(function(s) {
        var act = s.action === 'delete' ? 'del' :
                  s.action === 'insert' ? 'ins1' :
                  s.action === 'insert_pair' ? 'ins2' :
                  s.action === 'insert_double' ? 'ins4' :
                  'inv';
        return act + '@' + s.atMoveNum + '.' + (s.atColor || 'w').toUpperCase() +
               '/' + (s.sheet === 'w' ? 'W' : 'B') + '(' + s.confidence.charAt(0) + ')';
      });
      var sugStr = sugBits.length ? ' → [' + sugBits.join(' ') + ']' : '';
      log('🧭 Alignment ran: ' + shifts.length + ' shifts ' + shiftStr +
          ', ' + sugs.length + ' suggestion(s) cached' + sugStr);
    }

    // SHIFT MAP — always log the per-window assessment to the BROWSER CONSOLE
    // (not the main log panel; would flood it). One line per window so the
    // user can scan the whole game and see exactly where the detector's
    // view of alignment changes (or doesn't, when it should).
    // Format per line:
    //   ply 76 (39.W) base= 0 best=-2 score 2.41>0.92 ★TRANSITION delta=-2
    //   ply 78 (40.W) base=-2 best=-2 score 2.10
    var wm = (analysis.shifts && analysis.shifts.windowMap) || [];
    if (wm.length) {
      try {
        var lines = ['[shift map] ' + wm.length + ' window(s) scanned:'];
        wm.forEach(function(w) {
          var basePad = (w.currentBase >= 0 ? '+' : '') + w.currentBase;
          var bestPad = (w.bestOffset  >= 0 ? '+' : '') + w.bestOffset;
          var marker = w.transition
            ? ' ★ TRANSITION delta=' + (w.bestOffset - w.currentBase > 0 ? '+' : '') +
              (w.bestOffset - w.currentBase)
            : '';
          lines.push('  ply ' + w.startPly + ' (' + w.moveNum + '.' +
                     w.color.toUpperCase() + ')  base=' + basePad +
                     ' best=' + bestPad + '  score ' +
                     w.scoreAtBest.toFixed(2) + '>' + w.scoreAtBase.toFixed(2) +
                     marker);
        });
        console.log(lines.join('\n'));
      } catch (e) {}
    }

    // Detailed per-shift / per-suggestion dump (set state._debugScroll = true
    // in DevTools to enable). Plain one-line strings so the user can copy-
    // paste from the console without unfolding nested objects.
    if (state._debugScroll) {
      try {
        var dShifts = analysis.shifts || [];
        var dSugs = analysis.suggestions || [];
        console.log('[alignment cache] ' + dShifts.length + ' shifts, ' +
                    dSugs.length + ' suggestions');
        dShifts.forEach(function(sh, i) {
          console.log('  shift[' + i + '] move ' + sh.moveNum + '.' + sh.color.toUpperCase() +
                      ' (ply ' + sh.ply + ')  prevOffset=' + sh.prevOffset +
                      ' → newOffset=' + sh.bestOffset + ' (delta ' +
                      (sh.delta > 0 ? '+' : '') + sh.delta + ')' +
                      '  scoreAtBase=' + (sh.overlapAtBase || 0).toFixed(2) +
                      ' scoreAtBest=' + (sh.overlapAtBest || 0).toFixed(2));
        });
        dSugs.forEach(function(s, i) {
          console.log('  sug[' + i + '] ' + s.cause + ' / ' + s.action +
                      ' on ' + (s.sheet === 'w' ? 'White' : 'Black') +
                      ' at ' + s.atMoveNum + '.' + (s.atColor || 'w').toUpperCase() +
                      '  conf=' + s.confidence + ' priority=' + s.priority);
        });
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------------------------
  // AT-POINT TRIGGER — surface banner when reconstruction is stuck near a
  // cached suggestion OR when the user has navigated near one, and only
  // when:
  //   - trailing noise has been resolved (or notice dismissed)
  //   - the suggestion is at or after the user's confirmed frontier
  //     (no surfacing ancient suggestions for moves they've worked past)
  //   - the suggestion hasn't been dismissed in this session
  // ---------------------------------------------------------------------------

  // Lookahead is confidence-scaled: low/medium suggestions surface only when
  // the user is close to them (±2 full moves), but a HIGH-confidence
  // misalignment several full moves downstream is too important to keep
  // hidden — surface those even when the user is much further upstream.
  var AT_POINT_LOOKAHEAD_PLIES = {
    low:    8,    // ±4 full moves
    medium: 14,   // ±7 full moves
    high:   24    // ±12 full moves — long enough to catch endgame issues
  };
  function _lookaheadFor(conf) {
    return AT_POINT_LOOKAHEAD_PLIES[conf] || AT_POINT_LOOKAHEAD_PLIES.low;
  }

  function evaluateAtPointAlignment() {
    // GATE 1 — noise review must be resolved before any alignment work.
    // Two complementary checks:
    //   (a) state.pendingNoiseReview is the existing suspicious-tail review
    //       mode (drives the 🗑️ buttons and "Continue to Validation"
    //       prompt). While true, the user is in the middle of cleaning
    //       trailing OCR garbage — alignment is off-limits.
    //   (b) detectTrailingNoise (this module's stricter check) finding any
    //       trailing identical-pair runs that the user hasn't dismissed yet.
    // Either condition keeps alignment suppressed.
    if (state.pendingNoiseReview) {
      clearAlignmentBanner();
      return;
    }
    if (state.ocrCellsSheet1 && state.ocrCellsSheet2) {
      var noise = detectTrailingNoise(state.ocrCellsSheet1, state.ocrCellsSheet2);
      if (noise.total > 0 && !state.noiseBannerDismissed) {
        clearAlignmentBanner();
        return;
      }
    }

    var analysis = state.alignmentAnalysis;
    if (!analysis || !analysis.suggestions || !analysis.suggestions.length) {
      clearAlignmentBanner();
      _retryReconstructionLaunch();
      return;
    }

    // Trigger ply is whichever is FURTHER along: where the user is currently
    // looking (state.currentPly) or where reconstruction is stuck.
    var stuckPly = (state.stuckPly === undefined || state.stuckPly === null) ? -1 : state.stuckPly;
    var currentPly = state.currentPly || 0;
    var triggerPly = Math.max(stuckPly, currentPly);

    if (triggerPly < 0) {
      clearAlignmentBanner();
      _retryReconstructionLaunch();
      return;
    }

    // GATE 2 — suggestions before the confirmed frontier are off the table.
    // If the user has worked past move 17 (confirmedPly > 32 or so), they
    // don't want to keep seeing a banner about move 17.
    var confirmedPly = state.confirmedPly || 0;
    var minMoveNum = Math.floor(confirmedPly / 2) + 1;

    // GATE 3 — never surface dismissed suggestions again this session.
    var dismissed = state.dismissedAlignmentKeys || {};

    // Per-suggestion lookahead: high-confidence suggestions surface from
    // much further away (up to ~12 full moves downstream), while
    // low-confidence ones stay gated close to the user's position.
    var debugFiltered = state._debugScroll ? [] : null;
    var relevant = analysis.suggestions.filter(function(s) {
      if (s.atMoveNum < minMoveNum) {
        if (debugFiltered) debugFiltered.push({ s: _suggestionKey(s), reason: 'before-confirmedPly', atMoveNum: s.atMoveNum, minMoveNum: minMoveNum });
        return false;
      }
      if (dismissed[_suggestionKey(s)]) {
        if (debugFiltered) debugFiltered.push({ s: _suggestionKey(s), reason: 'dismissed' });
        return false;
      }
      var sPly = (s.atMoveNum - 1) * 2 + (s.atColor === 'w' ? 0 : 1);
      var maxRelevantPly = triggerPly + _lookaheadFor(s.confidence);
      if (sPly > maxRelevantPly) {
        if (debugFiltered) debugFiltered.push({ s: _suggestionKey(s), reason: 'beyond-lookahead', sPly: sPly, triggerPly: triggerPly, maxRelevantPly: maxRelevantPly, confidence: s.confidence });
        return false;
      }
      return true;
    });
    if (debugFiltered && debugFiltered.length) {
      try {
        console.log('[evaluateAtPoint] triggerPly=' + triggerPly +
                    ' (stuck=' + stuckPly + ' current=' + currentPly + ')' +
                    '  ' + debugFiltered.length + ' suggestion(s) filtered out:');
        debugFiltered.forEach(function(d, i) {
          var bits = [];
          for (var k in d) if (d.hasOwnProperty(k)) bits.push(k + '=' + d[k]);
          console.log('  filt[' + i + '] ' + bits.join(' '));
        });
      } catch (e) {}
    }

    if (!relevant.length) {
      // Brief log so the user can see WHY no banner is showing even with
      // suggestions cached (e.g. all filtered out).
      if (typeof log === 'function' && analysis.suggestions.length) {
        log('🧭 At-point: trigger=ply ' + triggerPly + ' (stuck=' + stuckPly +
            ' current=' + currentPly + '), confirmedPly=' + confirmedPly +
            ' → 0/' + analysis.suggestions.length + ' suggestion(s) in range — no banner');
      }
      clearAlignmentBanner();
      _retryReconstructionLaunch();
      return;
    }

    // Don't re-render if the same top suggestion is already showing — would
    // re-flash/re-scroll on every navigation tick.
    var top = relevant[0];
    var existing = _bannerEl();
    if (existing && existing.dataset.suggestionKey === _suggestionKey(top)) return;

    if (typeof log === 'function') {
      log('🧭 At-point: trigger=ply ' + triggerPly + ' → showing ' +
          relevant.length + '/' + analysis.suggestions.length +
          ' (top: ' + top.cause + ' at ' + top.atMoveNum + '.' +
          (top.atColor || 'w').toUpperCase() + ', ' + top.confidence + ')');
    }
    showAlignmentBanner({ suggestions: relevant });
  }

  function _suggestionKey(s) {
    return [s.cause || '', s.action || '', s.atMoveNum || '', s.atColor || '', s.sheet || ''].join('|');
  }

  function _retryReconstructionLaunch() {
    if (hasActiveStructuralBanner()) return;
    if (typeof launchBackgroundSearches !== 'function') return;
    if (state.stuckPly === undefined || state.stuckPly === null) return;
    // Don't relaunch while the user is reviewing an algorithm's result.
    // goToPly (called by _focusFix on every Confirm → next fix) triggers
    // runStructuralChecks, which used to cascade into a full greedy+beam+
    // dijkstra relaunch — making Confirm look like it was restarting the
    // three algorithms. Verification IS the review of algorithm output;
    // kicking off fresh searches during it is pure waste.
    if (window.VerificationUI && typeof window.VerificationUI.isActive === 'function'
        && window.VerificationUI.isActive()) {
      return;
    }
    // Only fire if the search panels haven't been populated yet OR the stuck
    // point has changed. The launcher itself handles its own idempotency.
    launchBackgroundSearches();
  }

  // ---------------------------------------------------------------------------
  // PREDICATE — used by reconstruction launcher to know when to stand down
  // ---------------------------------------------------------------------------

  function hasActiveStructuralBanner() {
    // Only the alignment banner blocks reconstruction. The noise banner is
    // purely informational — the user typically resolves it via the right-click
    // "Delete from here onward" context menu, and shouldn't have to dismiss
    // anything before greedy/beam/dijkstra start running.
    return !!_bannerEl();
  }

  function clearAllStructuralBanners() {
    clearNoiseBanner();
    clearAlignmentBanner();
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  window.SheetAlignment = {
    analyzeSheetAlignment: analyzeSheetAlignment,
    showAlignmentBanner: showAlignmentBanner,
    clearAlignmentBanner: clearAlignmentBanner,
    showNoiseBanner: showNoiseBanner,
    clearNoiseBanner: clearNoiseBanner,
    detectTrailingNoise: detectTrailingNoise,
    runStructuralChecks: runStructuralChecks,
    evaluateAtPointAlignment: evaluateAtPointAlignment,
    hasActiveStructuralBanner: hasActiveStructuralBanner,
    clearAllStructuralBanners: clearAllStructuralBanners,
    // exposed for testing / batch use
    findSmokingGuns: findSmokingGuns,
    detectShifts: detectShifts,
    trimTrailingNoise: trimTrailingNoise,
    poolOverlap: poolOverlap
  };
})();
