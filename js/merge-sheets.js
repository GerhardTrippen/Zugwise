// =============================================================================
// MERGE-SHEETS.JS - Dual-Sheet Scoresheet Merge Logic
// =============================================================================
// Merges OCR results from two players' scoresheets into enriched move data.
// Output shape is identical to single-sheet OCR format — compatible with pairMoves().
//
// Dependencies: chess.js (already loaded in frontend)
// =============================================================================

// =============================================================================
// SAN NORMALIZATION
// =============================================================================

/**
 * Normalize a SAN string for comparison purposes.
 * Strips +/# check/mate indicators and normalizes castling.
 */
function normalizeSanForComparison(san) {
  if (!san) return '';
  var s = san.replace(/[+#]/g, '').trim();
  // Normalize zero-zero to O-O
  s = s.replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O');
  return s;
}

// =============================================================================
// ALTERNATIVE MERGING
// =============================================================================

/**
 * Merge two arrays of alternatives, deduplicating by normalized SAN.
 * Sums confidences for duplicates (capped at 1.5), sorts descending, keeps top 10.
 *
 * @param {Array} alts1 - Alternatives from sheet 1 [{move, confidence, ...}]
 * @param {Array} alts2 - Alternatives from sheet 2 [{move, confidence, ...}]
 * @returns {Array} Merged alternatives
 */
function mergeAlternatives(alts1, alts2) {
  var byNorm = {};

  function addAlts(alts, sheetNum) {
    if (!alts) return;
    alts.forEach(function(alt) {
      var move = alt.move || (Array.isArray(alt) ? alt[0] : alt);
      var conf = alt.confidence || (Array.isArray(alt) ? (alt[1] || 0.1) : 0.1);
      if (!move) return;
      var norm = normalizeSanForComparison(move);
      if (!byNorm[norm]) {
        byNorm[norm] = { move: move, confidence: conf, sources: [sheetNum] };
      } else {
        byNorm[norm].confidence = Math.min(byNorm[norm].confidence + conf, 1.5);
        if (byNorm[norm].sources.indexOf(sheetNum) === -1) {
          byNorm[norm].sources.push(sheetNum);
        }
      }
    });
  }

  addAlts(alts1, 1);
  addAlts(alts2, 2);

  var result = Object.keys(byNorm).map(function(k) { return byNorm[k]; });
  result.sort(function(a, b) { return b.confidence - a.confidence; });
  return result.slice(0, 10);
}

// When the two sheets disagree on the top move and their confidences are
// within this margin, the pick is a coin flip — emit an ambiguity marker
// (forced illegal stop) instead of silently committing to one. TUNABLE: too
// loose floods the user with stops; too tight lets silent wrong picks through.
// 12.B Qb8/Rb8 had a 0.030 gap; Bh7/Qb2 both-0.90 has 0.000.
var AMBIGUITY_TIE_MARGIN = 0.15;

// ...AND at least one reading must clear this confidence floor. The marker
// means "two REASONABLY-CONFIDENT sheets disagree" (12.B 0.557/0.527; Bh7/Qb2
// 0.90/0.90), NOT "both sheets emitted weak OCR noise that happens to be
// close" (e.g. both ~0.2). Without this floor a game with pervasively bad OCR
// on one sheet marks the majority of plies — 25/39 on a real test — which is
// a broken pairing, not 25 resolvable ambiguities. A both-low disagreement is
// just an ordinary low-confidence cell; let the normal pick/tier path handle
// it. TUNABLE alongside the margin.
var AMBIGUITY_MIN_CONFIDENCE = 0.45;

// Tier-1 consensus elevation. A legal disagree-cell move (the sheets' raw TOP
// moves differ) is still elevated to Tier 1 (auto-lockable, never touched by the
// algorithms) when BOTH sheets saw the chosen move AND its SUMMED cross-sheet
// confidence clears this bar. Rationale: a move both passes saw strongly (e.g.
// 6.B Bb7 = sheet1 0.719 + sheet2 0.321 = 1.04) is at least as trustworthy as a
// bare raw-top agreement, and locking it prevents the algorithms from
// mis-attributing a downstream error onto it (the 6.B Rb7-garbage class). The
// min-each floor excludes "one sheet ~1.0, the other a trace" — that is one
// confident sheet, not a consensus. TUNABLE.
var TIER1_CONSENSUS_SUMMED = 1.0;
var TIER1_CONSENSUS_MIN_EACH = 0.15;

/**
 * Confidence a single sheet cell assigns to `move` — whether it is the cell's
 * top move OR sits in its alternatives. Returns 0 if absent. Used to sum a
 * candidate's confidence symmetrically across both sheets so the top-move
 * promotion compares like with like (see mergePly).
 */
function confForMoveInCell(cell, move) {
  if (!cell || !move) return 0;
  var norm = normalizeSanForComparison(move);
  if (cell.move && normalizeSanForComparison(cell.move) === norm) {
    return cell.confidence || 0;
  }
  var alts = cell.alternatives || [];
  for (var i = 0; i < alts.length; i++) {
    var am = alts[i].move || (Array.isArray(alts[i]) ? alts[i][0] : null);
    if (am && normalizeSanForComparison(am) === norm) {
      return alts[i].confidence || (Array.isArray(alts[i]) ? (alts[i][1] || 0) : 0);
    }
  }
  return 0;
}

// =============================================================================
// SINGLE PLY MERGE
// =============================================================================

/**
 * Merge OCR data for a single ply from two sheets.
 * If both sheets have data: combines candidates, sums confidences.
 * If only one: returns as-is with metadata.
 *
 * @param {Object|null} cell1 - OCR cell from sheet 1 {move, confidence, alternatives, lenientAlternatives, ...}
 * @param {Object|null} cell2 - OCR cell from sheet 2
 * @param {number} num - Move number
 * @param {string} color - 'w' or 'b'
 * @returns {Object} Merged cell in standard OCR format
 */
function mergePly(cell1, cell2, num, color) {
  // Only one sheet has data
  if (!cell1 && !cell2) return null;
  if (!cell1) return Object.assign({}, cell2, { _sheet2Move: cell2.move, _sheetCount: 1 });
  if (!cell2) return Object.assign({}, cell1, { _sheet1Move: cell1.move, _sheetCount: 1 });

  var norm1 = normalizeSanForComparison(cell1.move);
  var norm2 = normalizeSanForComparison(cell2.move);
  var agree = (norm1 === norm2);

  // Choose the top move: if they agree, boost confidence; otherwise pick higher confidence
  var topMove, topConf;
  if (agree) {
    // Use the normalized form (strips +/#, canonicalizes 0-0 → O-O).
    // If one sheet has h6+ and the other h6, the sheets agree on the
    // underlying move but disagree on the check annotation; keeping S1's
    // raw "h6+" lets a spurious + ride into a Tier 1–locked ply and blocks
    // deep search (chess.js v0.12 doesn't validate +/#, so the ply passes
    // classifyTiers' legality check even though python-chess later rejects
    // it). Chess validation reattaches +/# canonically when the move is
    // actually check, so nothing is lost.
    topMove = norm1;
    topConf = Math.min(cell1.confidence + cell2.confidence * 0.5, 1.5);
  } else {
    // Disagreement: pick the reading with the higher SUMMED cross-sheet
    // confidence (consensus), NOT the higher single-sheet top. A move both
    // sheets saw accumulates more total evidence; single-sheet max ignored that
    // and disagreed with the promotion + near-tie logic (both summed). Example
    // (6.B): sheet1 Bb7@0.719 vs sheet2 Nb7@0.618 by raw tops, but Bb7's
    // cross-sheet sum is 0.719+0.321=1.04 vs Nb7's 0.618 -> Bb7 is the consensus
    // pick. See project_merge_promotion_asymmetry.
    var _c1Summed = Math.min(confForMoveInCell(cell1, cell1.move) + confForMoveInCell(cell2, cell1.move), 1.5);
    var _c2Summed = Math.min(confForMoveInCell(cell1, cell2.move) + confForMoveInCell(cell2, cell2.move), 1.5);
    if (_c1Summed >= _c2Summed) {
      topMove = cell1.move;
      topConf = _c1Summed;
    } else {
      topMove = cell2.move;
      topConf = _c2Summed;
    }
  }

  // Check notation includes + or #
  var hasCheck = false;
  if (cell1.move && (cell1.move.indexOf('+') >= 0 || cell1.move.indexOf('#') >= 0)) hasCheck = true;
  if (cell2.move && (cell2.move.indexOf('+') >= 0 || cell2.move.indexOf('#') >= 0)) hasCheck = true;

  // Build merged alternatives: include the non-top move from both sheets + their alts
  var extraAlts = [];
  if (!agree) {
    // Add the losing top move as an alternative
    var loser = (cell1.confidence >= cell2.confidence) ? cell2 : cell1;
    extraAlts.push({ move: loser.move, confidence: loser.confidence });
  }

  var mergedAlts = mergeAlternatives(
    (cell1.alternatives || []).concat(extraAlts.filter(function(a) { return a.move === cell2.move; })),
    (cell2.alternatives || []).concat(extraAlts.filter(function(a) { return a.move === cell1.move; }))
  );

  // Also add non-top moves that aren't already in alts
  if (!agree) {
    var loserMove = (cell1.confidence >= cell2.confidence) ? cell2.move : cell1.move;
    var loserConf = (cell1.confidence >= cell2.confidence) ? cell2.confidence : cell1.confidence;
    var alreadyThere = mergedAlts.some(function(a) {
      return normalizeSanForComparison(a.move) === normalizeSanForComparison(loserMove);
    });
    if (!alreadyThere) {
      mergedAlts.unshift({ move: loserMove, confidence: loserConf, sources: [cell1.confidence >= cell2.confidence ? 2 : 1] });
      if (mergedAlts.length > 10) mergedAlts.pop();
    }
  }

  var mergedLenient = mergeAlternatives(
    cell1.lenientAlternatives || [],
    cell2.lenientAlternatives || []
  );

  // Top-move promotion: if a merged alternative (with summed confidence
  // across both sheets) beats the raw top-move confidence picked above,
  // promote it to top. The raw topMove selection only compared cell1.move
  // vs cell2.move confidences; a move that appears as an *alternative* in
  // both sheets (summed by mergeAlternatives) can easily exceed either
  // sheet's top-move conf. Example: cell1.top=Rfc1@0.53, cell2.top=Kf1@0.30,
  // but both sheets' alts contain Rxd7 — summed to 0.76. Without this
  // promotion, Rfc1 stays as top and the DUAL SEARCH secondary/primary
  // slots get inverted relative to true confidence.
  // Compare against the top move's SYMMETRIC cross-sheet confidence. The raw
  // topConf above is only one sheet's value (the disagreement branch took
  // max(cell1.top, cell2.top)), but the same move usually ALSO appears in the
  // other sheet's alternatives. mergedAlts entries are already summed across
  // both sheets, so comparing a summed alt against an un-summed top
  // systematically over-promotes alternatives. Sum the top too before the
  // compare. Confirmed regression: 12.B top Qb8 (sheet1 0.557) lost to Rb8
  // (summed 0.394+0.527=0.921) even though Qb8's true cross-sheet sum is
  // 0.557+0.345=0.902 — see project_merge_promotion_asymmetry.
  var topConfSummed = Math.min(
    confForMoveInCell(cell1, topMove) + confForMoveInCell(cell2, topMove), 1.5);
  if (mergedAlts.length > 0 && mergedAlts[0].confidence > topConfSummed) {
    var newTop = mergedAlts.shift();
    // Demote the old top into alts at its SUMMED confidence. Remove any
    // existing entry for it first: the demoted move frequently already sits in
    // mergedAlts from the other sheet's alt list (e.g. Qb8 demoted while a
    // stale Qb8@0.345 lingers), which would otherwise leave a duplicate.
    var demotedNorm = normalizeSanForComparison(topMove);
    mergedAlts = mergedAlts.filter(function(a) {
      return normalizeSanForComparison(a.move) !== demotedNorm;
    });
    mergedAlts.push({ move: topMove, confidence: topConfSummed });
    mergedAlts.sort(function(a, b) { return b.confidence - a.confidence; });
    if (mergedAlts.length > 10) mergedAlts.length = 10;
    topMove = newTop.move;
    topConf = newTop.confidence;
  }

  // ---------------------------------------------------------------------------
  // FORCED STOP on ambiguous near-tie disagreement.
  // When both sheets disagree on the top move AND their confidences are a coin
  // flip, committing to either is a silent guess that only detonates downstream
  // (e.g. 12.B Rb8 vs Qb8: both legal, but Rb8 hangs the queen 9 plies later).
  // Instead emit an illegal marker so the move list stops AT this ply, with
  // both readings in `alternatives` for the fix-finder; reach then ranks the
  // candidate that lets the game continue. This is the same mechanism as the
  // '???' insertion placeholder (shift-ops.js) — an illegal token that forces
  // a stuck point — just with the two real candidates attached. classifyTiers
  // already maps illegal → Tier 3 + stop, so this subsumes a separate
  // "down-tier disagreements" rule. See project_merge_promotion_asymmetry.
  //
  // Guard: skip if top-move promotion elevated a CONSENSUS alternative (a move
  // both sheets saw, summed above either top). That's more reliable than either
  // sheet's pick, not a coin flip — trust it. Detected by the final topMove no
  // longer matching either sheet's raw top.
  var _fNorm = normalizeSanForComparison(topMove);
  var _topIsSheetPick = (_fNorm === norm1 || _fNorm === norm2);
  // Near-tie must compare the two competing readings' TOTAL cross-sheet evidence,
  // NOT each sheet's raw top conf — those are confidences for DIFFERENT moves
  // (cell1.move vs cell2.move). A move that one sheet tops and the other ALSO saw
  // (as top or alt) accumulates a far higher summed conf. Example (6.B): sheet1
  // Bb7@0.719, sheet2 Nb7@0.618 — by raw tops |0.719-0.618|=0.10 looks like a
  // coin flip, but Bb7's cross-sheet sum is 0.719+0.321=1.04 vs Nb7's 0.618, so
  // Bb7 DOMINATES — there is no ambiguity. (12.B stays a genuine tie: Qb8 summed
  // 0.902 vs Rb8 0.921 -> |Δ|=0.019.) This is the "use sums everywhere" fix:
  // compare summed-vs-summed, like the top-move promotion above already does.
  var _top1Summed = Math.min(
    confForMoveInCell(cell1, cell1.move) + confForMoveInCell(cell2, cell1.move), 1.5);
  var _top2Summed = Math.min(
    confForMoveInCell(cell1, cell2.move) + confForMoveInCell(cell2, cell2.move), 1.5);
  var _nearTie = Math.abs(_top1Summed - _top2Summed) < AMBIGUITY_TIE_MARGIN;
  // Floor: don't force a stop on a disagreement between two weak readings —
  // that's a bad cell, not a genuine "two strong opinions" tie.
  var _bothNotNoise = Math.max(cell1.confidence || 0, cell2.confidence || 0) >= AMBIGUITY_MIN_CONFIDENCE;
  if (!agree && _nearTie && _topIsSheetPick && _bothNotNoise) {
    // Default to the higher SUMMED reading (consensus), consistent with the
    // disagree pick + near-tie above. _top1Summed/_top2Summed (computed for the
    // near-tie) are cell1.move and cell2.move summed across both sheets.
    var hiMove = (_top1Summed >= _top2Summed) ? cell1.move : cell2.move;
    var loMove = (_top1Summed >= _top2Summed) ? cell2.move : cell1.move;
    var hiSummed = Math.max(_top1Summed, _top2Summed);
    var loSummed = Math.min(_top1Summed, _top2Summed);
    // Both competing readings MUST be in alternatives (with cross-sheet summed
    // conf) so the fix-finder tries both. Remove any existing entries first to
    // avoid stale-conf duplicates, then unshift both.
    var hiN = normalizeSanForComparison(hiMove);
    var loN = normalizeSanForComparison(loMove);
    mergedAlts = mergedAlts.filter(function(a) {
      var n = normalizeSanForComparison(a.move);
      return n !== hiN && n !== loN;
    });
    mergedAlts.unshift({ move: loMove, confidence: loSummed });
    mergedAlts.unshift({ move: hiMove, confidence: hiSummed });
    mergedAlts.sort(function(a, b) { return b.confidence - a.confidence; });
    if (mergedAlts.length > 10) mergedAlts.length = 10;
    // Emit the higher-confidence REAL move as the cell text (legal, replayable,
    // visible to noise truncation/export/navigation as ordinary data) plus an
    // `_ambiguous` flag. The flag — NOT an illegal text token — is what makes
    // interactive validation and the algorithms stop at this ply (see
    // validate_moves / play_until_absurd_or_stuck forced_stop handling). A text
    // marker ("Q/Rb8") was tried first but leaked into every consumer that
    // assumes move text is a real move (silent auto-apply, broken noise
    // truncation); the flag is checked only where stopping matters.
    // _ambiguousCandidates carries both readings for the fix UI to surface;
    // the 🔍 badge is rendered from `_ambiguous`.
    return {
      num: num,
      color: color,
      move: hiMove,
      confidence: hiSummed,
      alternatives: mergedAlts,
      lenientAlternatives: mergedLenient,
      _sheet1Move: cell1.move,
      _sheet2Move: cell2.move,
      _sheet1Conf: cell1.confidence,
      _sheet2Conf: cell2.confidence,
      _agree: false,
      _ambiguous: true,
      _ambiguousCandidates: [hiMove, loMove],
      _hasCheck: hasCheck,
      _sheetCount: 2
    };
  }

  // Consensus-top: does the final top move have strong cross-sheet support?
  // True if the sheets AGREED on it, OR (tops disagreed but) BOTH sheets saw it
  // with at least TIER1_CONSENSUS_MIN_EACH and its summed conf clears
  // TIER1_CONSENSUS_SUMMED. classifyTiers elevates such a legal move to Tier 1
  // (auto-locked) even without raw top-agreement — see the constants above.
  var _topC1 = confForMoveInCell(cell1, topMove);
  var _topC2 = confForMoveInCell(cell2, topMove);
  var _consensusTop = agree || (
    _topC1 >= TIER1_CONSENSUS_MIN_EACH &&
    _topC2 >= TIER1_CONSENSUS_MIN_EACH &&
    Math.min(_topC1 + _topC2, 1.5) >= TIER1_CONSENSUS_SUMMED
  );

  return {
    num: num,
    color: color,
    move: topMove,
    confidence: topConf,
    alternatives: mergedAlts,
    lenientAlternatives: mergedLenient,
    _sheet1Move: cell1.move,
    _sheet2Move: cell2.move,
    _sheet1Conf: cell1.confidence,
    _sheet2Conf: cell2.confidence,
    _agree: agree,
    _consensusTop: _consensusTop,
    _hasCheck: hasCheck,
    _sheetCount: 2
  };
}

// =============================================================================
// MAIN MERGE ENTRY POINT
// =============================================================================

/**
 * Merge OCR results from two sheets into a single enriched move array.
 * Both sheets should already be assigned colors (white/black).
 *
 * @param {Array} sheet1Moves - Flat array of OCR moves from sheet 1 [{num, color, move, confidence, alternatives, ...}]
 * @param {Array} sheet2Moves - Flat array of OCR moves from sheet 2
 * @returns {Array} Merged move array in same shape as single-sheet OCR
 */
function mergeSheets(sheet1Moves, sheet2Moves) {
  // Index both sheets by (num, color)
  function indexByPly(moves) {
    var idx = {};
    if (!moves) return idx;
    moves.forEach(function(m) {
      var key = m.num + '_' + m.color;
      idx[key] = m;
    });
    return idx;
  }

  var idx1 = indexByPly(sheet1Moves);
  var idx2 = indexByPly(sheet2Moves);

  // Collect all unique (num, color) keys
  var allKeys = {};
  Object.keys(idx1).forEach(function(k) { allKeys[k] = true; });
  Object.keys(idx2).forEach(function(k) { allKeys[k] = true; });

  // Sort keys by move number then color
  var sortedKeys = Object.keys(allKeys).sort(function(a, b) {
    var pa = a.split('_'), pb = b.split('_');
    var na = parseInt(pa[0]), nb = parseInt(pb[0]);
    if (na !== nb) return na - nb;
    // w before b
    return (pa[1] === 'w' ? 0 : 1) - (pb[1] === 'w' ? 0 : 1);
  });

  var merged = [];
  sortedKeys.forEach(function(key) {
    var parts = key.split('_');
    var num = parseInt(parts[0]);
    var color = parts[1];
    var cell = mergePly(idx1[key] || null, idx2[key] || null, num, color);
    if (cell) merged.push(cell);
  });

  return merged;
}

// =============================================================================
// AGREEMENT DETECTION
// =============================================================================

/**
 * Find plies where both sheets agree on the top-1 move (after normalization).
 *
 * @param {Array} sheet1Moves - Flat array from sheet 1
 * @param {Array} sheet2Moves - Flat array from sheet 2
 * @returns {Set<number>} Set of ply indices where sheets agree
 */
function findAgreementPlies(sheet1Moves, sheet2Moves) {
  var idx1 = {}, idx2 = {};
  if (sheet1Moves) sheet1Moves.forEach(function(m) { idx1[m.num + '_' + m.color] = m; });
  if (sheet2Moves) sheet2Moves.forEach(function(m) { idx2[m.num + '_' + m.color] = m; });

  var agreePlySet = new Set();
  Object.keys(idx1).forEach(function(key) {
    if (!idx2[key]) return;
    var n1 = normalizeSanForComparison(idx1[key].move);
    var n2 = normalizeSanForComparison(idx2[key].move);
    if (n1 && n2 && n1 === n2) {
      var parts = key.split('_');
      var num = parseInt(parts[0]);
      var color = parts[1];
      var ply = (num - 1) * 2 + (color === 'w' ? 0 : 1);
      agreePlySet.add(ply);
    }
  });

  return agreePlySet;
}

// =============================================================================
// SHIFT DETECTION
// =============================================================================

/**
 * Detect if one sheet is shifted by N rows relative to the other.
 * Uses sliding window agreement collapse detection.
 *
 * @param {Array} sheet1Moves - Flat array from sheet 1
 * @param {Array} sheet2Moves - Flat array from sheet 2
 * @returns {Object} { detected: bool, offset: number, confidence: number }
 */
function detectShift(sheet1Moves, sheet2Moves) {
  if (!sheet1Moves || !sheet2Moves || sheet1Moves.length < 5 || sheet2Moves.length < 5) {
    return { detected: false, offset: 0, confidence: 0 };
  }

  // Try offsets from -5 to +5 (sheet2 shifted by N moves relative to sheet1)
  var bestOffset = 0;
  var bestAgreement = 0;

  // Index sheet2 by (num, color)
  var idx2 = {};
  sheet2Moves.forEach(function(m) { idx2[m.num + '_' + m.color] = m; });

  for (var offset = -5; offset <= 5; offset++) {
    var agreement = 0;
    var compared = 0;

    sheet1Moves.forEach(function(m1) {
      // Sheet2's move at (num + offset, color) should match sheet1's (num, color)
      var shiftedNum = m1.num + offset;
      var key2 = shiftedNum + '_' + m1.color;
      if (idx2[key2]) {
        compared++;
        var n1 = normalizeSanForComparison(m1.move);
        var n2 = normalizeSanForComparison(idx2[key2].move);
        if (n1 === n2) agreement++;
      }
    });

    if (compared > 0 && agreement > bestAgreement) {
      bestAgreement = agreement;
      bestOffset = offset;
    }
  }

  // Agreement at offset=0 (no shift)
  var baseAgreement = 0;
  var baseCompared = 0;
  sheet1Moves.forEach(function(m1) {
    var key2 = m1.num + '_' + m1.color;
    if (idx2[key2]) {
      baseCompared++;
      if (normalizeSanForComparison(m1.move) === normalizeSanForComparison(idx2[key2].move)) {
        baseAgreement++;
      }
    }
  });

  var baseRate = baseCompared > 0 ? baseAgreement / baseCompared : 0;
  var bestRate = sheet1Moves.length > 0 ? bestAgreement / sheet1Moves.length : 0;

  // Only report shift if offset != 0 and significantly better than no-shift
  if (bestOffset !== 0 && bestRate > baseRate + 0.2 && bestAgreement >= 5) {
    return { detected: true, offset: bestOffset, confidence: bestRate };
  }

  return { detected: false, offset: 0, confidence: baseRate };
}

// =============================================================================
// TIER CLASSIFICATION
// =============================================================================

/**
 * Classify each ply into tiers based on agreement + legality.
 * Uses chess.js to validate moves forward from the start position.
 *
 * Tier 1: Both sheets agree AND move is legal — high confidence
 * Tier 2: Only one sheet has data, OR sheets disagree but one is legal — medium
 * Tier 3: Sheets disagree and neither/both might be legal, OR no data — low
 *
 * Stops classification at first Tier 3 (board state uncertain beyond).
 *
 * @param {Array} mergedMoves - Output from mergeSheets()
 * @returns {Object} tierMap: {ply → 1|2|3}
 */
/**
 * @param {Array} mergedMoves - Output from mergeSheets()
 * @param {Object} [currentMovesMap] - Optional {ply → san} map of current (possibly fixed) moves.
 *   If provided, uses these SANs for legality checks instead of the original OCR move.
 *   Agreement dots still come from _agree/_sheetCount (static OCR metadata).
 * @returns {Object} tierMap: {ply → 1|2|3}
 */
function classifyTiers(mergedMoves, currentMovesMap) {
  if (typeof Chess === 'undefined') {
    console.warn('[MERGE] chess.js not loaded, cannot classify tiers');
    return {};
  }

  var tierMap = {};
  var chessBoard = new Chess();
  var stopped = false;

  mergedMoves.forEach(function(m) {
    var ply = (m.num - 1) * 2 + (m.color === 'w' ? 0 : 1);

    if (stopped) {
      tierMap[ply] = 3;
      return;
    }

    var agree = m._agree;
    var sheetCount = m._sheetCount || 1;

    // Forced-stop ambiguity (dual-sheet near-tie disagreement): the cell text is
    // the higher-confidence reading, but it's unresolved, so the board beyond
    // this ply is uncertain. Tier 3 + stop — never auto-lockable, user must
    // resolve. Mirrors the old illegal-token behaviour without corrupting the
    // move text. Skip once the user has confirmed the ply (currentMovesMap holds
    // their pick and the cell is no longer flagged on re-merge).
    if (m._ambiguous && !(currentMovesMap && currentMovesMap[ply] !== undefined)) {
      tierMap[ply] = 3;
      stopped = true;
      return;
    }

    // Use current (possibly fixed) move for legality, fall back to original OCR
    var moveToPlay = (currentMovesMap && currentMovesMap[ply] !== undefined) ? currentMovesMap[ply] : m.move;

    // Try to play the move
    var isLegal = false;
    try {
      var result = chessBoard.move(moveToPlay);
      if (result) {
        isLegal = true;
      }
    } catch (e) {}

    // Tier 1 = both sheets, legal, AND strong cross-sheet support: either the
    // raw tops agreed (_agree) OR the chosen move is a summed-consensus pick both
    // sheets saw (_consensusTop, set in mergePly per TIER1_CONSENSUS_*). The
    // latter elevates e.g. 6.B Bb7 (summed 1.04) so the algorithms never touch it.
    if (sheetCount === 2 && (agree || m._consensusTop) && isLegal) {
      tierMap[ply] = 1;
    } else if (isLegal) {
      tierMap[ply] = 2;
    } else {
      tierMap[ply] = 3;
      stopped = true;
    }
  });

  return tierMap;
}

/**
 * Compute which plies should be locked based on tier classification.
 *
 * @param {Object} tierMap - {ply → 1|2|3} from classifyTiers()
 * @param {string} lockMode - 'none' | 'tier1' | 'tier1+2'
 * @returns {Array<number>} Array of ply indices to lock
 */
function computeLockedPlies(tierMap, lockMode) {
  if (!lockMode || lockMode === 'none') return [];

  var locked = [];
  var plies = Object.keys(tierMap).map(Number).sort(function(a, b) { return a - b; });

  plies.forEach(function(ply) {
    var tier = tierMap[ply];
    if (lockMode === 'tier1' && tier === 1) {
      locked.push(ply);
    } else if (lockMode === 'tier1+2' && (tier === 1 || tier === 2)) {
      locked.push(ply);
    }
  });

  return locked;
}

// =============================================================================
// TIER SUMMARY
// =============================================================================

/**
 * Generate a summary string of tier counts (used for locking logic).
 *
 * @param {Object} tierMap - {ply → 1|2|3}
 * @returns {Object} { tier1: n, tier2: n, tier3: n, total: n, summary: string }
 */
function tierSummary(tierMap) {
  var counts = { 1: 0, 2: 0, 3: 0 };
  var plies = Object.keys(tierMap);
  plies.forEach(function(ply) {
    var t = tierMap[ply];
    if (counts[t] !== undefined) counts[t]++;
  });
  var total = plies.length;
  var summary = counts[1] + ' agree (locked) | ' + counts[2] + ' one-legal | ' + counts[3] + ' ambiguous';
  return { tier1: counts[1], tier2: counts[2], tier3: counts[3], total: total, summary: summary };
}

/**
 * Generate agreement summary from ocrCells metadata (matches dot colors exactly).
 * Only counts cells that have a non-empty move.
 *
 * @param {Array} ocrCells - Merged OCR cells with _agree and _sheetCount metadata
 * @returns {Object} { agree: n, oneSheet: n, disagree: n, total: n }
 */
function agreementSummary(ocrCells) {
  var agree = 0, oneSheet = 0, disagree = 0;
  if (!ocrCells) return { agree: 0, oneSheet: 0, disagree: 0, total: 0 };
  ocrCells.forEach(function(cell) {
    if (!cell.move) return; // skip empty cells
    var sheetCount = cell._sheetCount || 1;
    if (sheetCount === 2 && cell._agree) {
      agree++;
    } else if (sheetCount === 1) {
      oneSheet++;
    } else {
      disagree++;
    }
  });
  return { agree: agree, oneSheet: oneSheet, disagree: disagree, total: agree + oneSheet + disagree };
}

// =============================================================================
// EXPORTS
// =============================================================================

window.MergeSheets = {
  normalizeSanForComparison: normalizeSanForComparison,
  mergeSheets: mergeSheets,
  mergePly: mergePly,
  mergeAlternatives: mergeAlternatives,
  findAgreementPlies: findAgreementPlies,
  detectShift: detectShift,
  classifyTiers: classifyTiers,
  computeLockedPlies: computeLockedPlies,
  tierSummary: tierSummary,
  agreementSummary: agreementSummary
};
