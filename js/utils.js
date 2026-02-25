// =============================================================================
// UTILITIES - Small helper functions
// =============================================================================

// Simple similarity fallback - exact match only
// For proper similarity, use backend /api/similarity endpoint or Pyodide
function simpleSim(a, b){
  return a === b ? 100 : 0;
}

// Character similarity for OCR - matches common handwriting confusions
// This is a JavaScript implementation of the Python similarity.py logic
function charSimilarity(a, b) {
  if (a === b) return 100;
  if (!a || !b) return 0;

  // Common OCR confusion pairs (score 0-100)
  var confusions = {
    'g_a': 80, 'a_g': 80,
    '4_3': 70, '3_4': 70,
    '5_s': 70, 's_5': 70,
    '6_G': 60, 'G_6': 60,
    '6_b': 60, 'b_6': 60,
    'R_K': 75, 'K_R': 75,
    'B_R': 65, 'R_B': 65,
    'B_K': 60, 'K_B': 60,
    'O_0': 90, '0_O': 90,
    'K_h': 55, 'h_K': 55,
    'B_b': 55, 'b_B': 55,
    '1_7': 60, '7_1': 60,
    '2_7': 55, '7_2': 55,
    '3_8': 55, '8_3': 55,
    '4_5': 50, '5_4': 50
  };

  // Calculate similarity based on character-by-character comparison
  var maxLen = Math.max(a.length, b.length);
  var minLen = Math.min(a.length, b.length);
  var matches = 0;
  var confusionScore = 0;

  for (var i = 0; i < minLen; i++) {
    if (a[i] === b[i]) {
      matches++;
    } else {
      var key = a[i] + '_' + b[i];
      if (confusions[key]) {
        confusionScore += confusions[key] / 100;
      }
    }
  }

  // Base score from exact matches
  var baseScore = (matches / maxLen) * 100;
  // Add confusion bonus (weighted lower)
  var confusionBonus = (confusionScore / maxLen) * 30;
  // Length penalty
  var lengthPenalty = (maxLen - minLen) * 10;

  return Math.max(0, Math.min(100, baseScore + confusionBonus - lengthPenalty));
}

// Compare moves alphabetically for sorting
// Order: pawns (lowercase start), B, K, N, O (castling), Q, R
function compareMoveAlpha(a, b){
  var pieceOrder = {'B':1, 'K':2, 'N':3, 'O':4, 'Q':5, 'R':6};

  var aFirst = a.charAt(0);
  var bFirst = b.charAt(0);
  var aIsPawn = aFirst >= 'a' && aFirst <= 'h';
  var bIsPawn = bFirst >= 'a' && bFirst <= 'h';

  if(aIsPawn && !bIsPawn) return -1;
  if(!aIsPawn && bIsPawn) return 1;
  if(aIsPawn && bIsPawn) return a.localeCompare(b);

  var aOrder = pieceOrder[aFirst] || 99;
  var bOrder = pieceOrder[bFirst] || 99;
  if(aOrder !== bOrder) return aOrder - bOrder;

  return a.localeCompare(b);
}

// Get similarity-sorted moves (Pyodide, Flask, or local fallback)
async function getSimilaritySortedMoves(legalMoves, ocrMove){
  // Try Pyodide first
  if (CONFIG.usePyodide && window.zugwise && window.zugwise.isReady) {
    try {
      var scores = [];
      for (var i = 0; i < legalMoves.length; i++) {
        var result = await window.zugwise.getSimilarity(ocrMove, legalMoves[i]);
        scores.push({ san: legalMoves[i], sim: Math.round((result.similarity || 0) * 100) });
      }
      return scores.sort(function(a, b){ return b.sim - a.sim; });
    } catch (e) {
      log('⚠ Pyodide similarity error: ' + e.message);
    }
  }

  // Try Flask backend
  if (!CONFIG.usePyodide) {
    try {
      var resp = await fetch(CONFIG.apiUrl + '/api/similarity', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ocr: ocrMove, candidates: legalMoves})
      });

      if(resp.ok){
        var data = await resp.json();
        // data.scores = [{ san: 'Nf3', sim: 75 }, ...]
        return data.scores.sort(function(a, b){ return b.sim - a.sim; });
      }
    } catch(e) {
      log('⚠ Similarity fetch error: ' + e.message);
    }
  }

  // Local fallback using charSimilarity
  var scores = legalMoves.map(function(san) {
    return { san: san, sim: Math.round(charSimilarity(ocrMove, san)) };
  });
  return scores.sort(function(a, b){ return b.sim - a.sim; });
}
