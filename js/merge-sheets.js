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
    topMove = cell1.move; // prefer sheet 1's exact notation
    topConf = Math.min(cell1.confidence + cell2.confidence * 0.5, 1.5);
  } else {
    // Pick the one with higher confidence as top
    if (cell1.confidence >= cell2.confidence) {
      topMove = cell1.move;
      topConf = cell1.confidence;
    } else {
      topMove = cell2.move;
      topConf = cell2.confidence;
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

    if (sheetCount === 2 && agree && isLegal) {
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
