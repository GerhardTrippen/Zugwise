// =============================================================================
// UTILITIES - Small helper functions
// =============================================================================

// =============================================================================
// Dual-sheet detection & splitting (shared by Image tab + Batch mode)
// =============================================================================

/**
 * Check if an image is a dual-sheet side-by-side scan (landscape orientation).
 * Two portrait scoresheets scanned together on a flatbed produce a landscape
 * image with aspect ratio typically 1.2-1.4.
 *
 * @param {File} file - Image file
 * @returns {Promise<{isDual: boolean, width: number, height: number, ratio: number}>}
 */
function detectDualSheet(file) {
  return new Promise(function(resolve) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function() {
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      URL.revokeObjectURL(url);
      var ratio = w / h;
      var isDual = ratio > 1.15;
      console.log('[DualSheet] detectDualSheet: ' + file.name +
                  ' ' + w + 'x' + h + ' ratio=' + ratio.toFixed(3) +
                  ' → ' + (isDual ? 'DUAL' : 'single'));
      resolve({ isDual: isDual, width: w, height: h, ratio: ratio });
    };
    img.onerror = function(e) {
      console.warn('[DualSheet] detectDualSheet: failed to load image ' + file.name, e);
      URL.revokeObjectURL(url);
      resolve({ isDual: false, width: 0, height: 0, ratio: 0 });
    };
    img.src = url;
  });
}

/**
 * Find the optimal vertical cut position for a dual-sheet scan using an
 * ink-density projection. Two side-by-side scoresheets each contribute two
 * column clusters (move numbers + moves), giving the signature:
 *
 *   col1  col2     [SEAM]     col3  col4
 *   ████  ████                ████  ████
 *       ↑    ↑            ↑       ↑
 *    narrow gap       WIDE gap  narrow gap
 *
 * The seam is the widest, deepest valley. If no clear valley is found
 * (uncentered, noisy, or not actually dual) the caller falls back to the
 * midpoint, so this can only improve on the old behaviour — never regress.
 *
 * @param {HTMLImageElement} img - Loaded image
 * @param {number} width - Image width (original, full resolution)
 * @param {number} height - Image height (original, full resolution)
 * @returns {{cutX: number, confident: boolean, reason: string}}
 */
function findDualSheetCut(img, width, height) {
  // Downsample for speed — 1D projection doesn't need full resolution.
  var targetW = Math.min(width, 1200);
  var scale = targetW / width;
  var targetH = Math.max(1, Math.round(height * scale));

  var canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, targetW, targetH);
  var data;
  try {
    data = ctx.getImageData(0, 0, targetW, targetH).data;
  } catch (e) {
    return { cutX: Math.floor(width / 2), confident: false,
             reason: 'getImageData failed: ' + e.message };
  }

  // Ink density per column: count of dark pixels (luma < threshold).
  var THRESHOLD = 160;
  var density = new Float32Array(targetW);
  for (var y = 0; y < targetH; y++) {
    var rowStart = y * targetW * 4;
    for (var x = 0; x < targetW; x++) {
      var i = rowStart + x * 4;
      var luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma < THRESHOLD) density[x] += 1;
    }
  }

  // Box-filter smoothing (window ~1% of width) to suppress single-column noise
  // from handwriting strokes while preserving the ~column-width valley shape.
  var smoothWin = Math.max(5, Math.floor(targetW / 100));
  var smooth = new Float32Array(targetW);
  var runSum = 0;
  for (var x = 0; x < targetW; x++) {
    runSum += density[x];
    if (x >= smoothWin) runSum -= density[x - smoothWin];
    smooth[x] = runSum / Math.min(x + 1, smoothWin);
  }

  var peakDensity = 0;
  for (var x = 0; x < targetW; x++) {
    if (smooth[x] > peakDensity) peakDensity = smooth[x];
  }
  if (peakDensity < 1) {
    return { cutX: Math.floor(width / 2), confident: false,
             reason: 'blank image — no ink detected' };
  }

  // Find deepest valley in the middle 30%–70% range (candidate seam).
  var searchStart = Math.floor(targetW * 0.30);
  var searchEnd = Math.floor(targetW * 0.70);
  var minDensity = Infinity;
  var minIdx = Math.floor(targetW / 2);
  for (var x = searchStart; x < searchEnd; x++) {
    if (smooth[x] < minDensity) { minDensity = smooth[x]; minIdx = x; }
  }

  // Measure valley extent: expand from the minimum while density stays under
  // 40% of peak. This defines the "quiet band" around the seam.
  var valleyThreshold = peakDensity * 0.40;
  var left = minIdx, right = minIdx;
  while (left > 0 && smooth[left] < valleyThreshold) left--;
  while (right < targetW - 1 && smooth[right] < valleyThreshold) right++;
  var valleyWidth = right - left;

  // Widest intra-sheet gap on either side of the seam — our comparison baseline.
  // Skip outer 5% to ignore page margins that would look like a giant valley.
  function widestValleyInRange(lo, hi) {
    var best = 0, cur = 0;
    for (var x = lo; x < hi; x++) {
      if (smooth[x] < valleyThreshold) { cur++; if (cur > best) best = cur; }
      else cur = 0;
    }
    return best;
  }
  var leftGap = widestValleyInRange(Math.floor(targetW * 0.05), searchStart);
  var rightGap = widestValleyInRange(searchEnd, Math.floor(targetW * 0.95));
  var maxIntraGap = Math.max(leftGap, rightGap);

  var midX = Math.floor(width / 2);

  // Acceptance tests — only override midpoint when the evidence is strong.
  if (minDensity > peakDensity * 0.30) {
    return { cutX: midX, confident: false,
             reason: 'shallow valley (min=' + Math.round(minDensity) +
                     ' vs peak=' + Math.round(peakDensity) + ')' };
  }
  if (maxIntraGap > 0 && valleyWidth < maxIntraGap * 1.5) {
    return { cutX: midX, confident: false,
             reason: 'seam gap ' + valleyWidth + 'px not clearly wider than ' +
                     'intra-sheet gap ' + maxIntraGap + 'px' };
  }

  // Asymmetric valley: when one sheet has much sparser ink than the other,
  // the valley walk extends far on the sparse side and barely on the dense
  // side. The (left+right)/2 midpoint then lands deep inside the sparse
  // sheet, not at the seam. Detect this and fall back to the page midpoint.
  var leftReach = minIdx - left;
  var rightReach = right - minIdx;
  var minReach = Math.min(leftReach, rightReach);
  var maxReach = Math.max(leftReach, rightReach);
  if (minReach > 0 && maxReach > 3 * minReach) {
    return { cutX: midX, confident: false,
             reason: 'asymmetric valley (reach left=' + leftReach +
                     'px, right=' + rightReach + 'px) — sparse on one side, ' +
                     'falling back to midpoint' };
  }

  // Use minIdx (the densest minimum within the search range) as the cut
  // rather than the midpoint of the (potentially asymmetric) valley.
  var cutX = Math.round(minIdx / scale);
  return { cutX: cutX, confident: true,
           reason: 'valley min at x=' + cutX + ' (width=' + Math.round(valleyWidth / scale) +
                   'px, depth=' + Math.round((1 - minDensity / peakDensity) * 100) + '%)' };
}

/**
 * Try to find the optimal split midpoint by running anchor detection on the
 * UNSPLIT dual-sheet image (Phase 4 entry into Phase 2/3 logic).
 *
 * Returns {midpoint, failureReason}:
 *   - midpoint: integer X-coordinate on success, null on any failure
 *   - failureReason: string describing what went wrong (when GridUnsplit
 *     produced a diagnostic), null otherwise. Caller can surface this as
 *     a user-visible hint suggesting Format / Cols × Rows may be wrong.
 *
 * Silent (no failureReason) for setup failures the user cannot act on:
 * missing modules, missing profile, OpenCV init failure.
 *
 * @param {File} file - The wide image file
 * @param {number} pageIndex - 0-based page slot (0, 1, or 2)
 * @returns {Promise<{midpoint: number|null, failureReason: string|null}>}
 */
async function findUnsplitMidpoint(file, pageIndex) {
  var nullResult = { midpoint: null, failureReason: null };
  if (typeof window === 'undefined') return nullResult;
  if (!window.GridUnsplit || !window.GridUnsplit.detectMidpoint) return nullResult;
  if (!window.OpenCVImageProcessor || !window.OpenCVImageProcessor.loadImageToMat) return nullResult;
  if (!window.SheetProfiles || !window.SheetProfiles.getProfileGridConfig) return nullResult;

  // Both halves of an image record the same game → same per-page profile
  var pageProfile;
  try {
    pageProfile = window.SheetProfiles.getProfileGridConfig(pageIndex + 1);
  } catch (e) {
    console.warn('[GridUnsplit] getProfileGridConfig failed:', e);
    return nullResult;
  }
  if (!pageProfile || !pageProfile.format) return nullResult;

  try {
    if (window.OpenCVImageProcessor.initOpenCV) {
      await window.OpenCVImageProcessor.initOpenCV();
    }
  } catch (e) {
    console.warn('[GridUnsplit] OpenCV init failed:', e);
    return nullResult;
  }

  var srcMat = null;
  try {
    srcMat = await window.OpenCVImageProcessor.loadImageToMat(file);
  } catch (e) {
    console.warn('[GridUnsplit] loadImageToMat failed:', e);
    return { midpoint: null, failureReason: 'image load failed' };
  }

  try {
    var result = window.GridUnsplit.detectMidpoint(srcMat, pageProfile, pageProfile, {
      log: function(msg) {
        // Gate per-step detection trace behind window.GRID_VERBOSE_LOG.
        // Same flag as the [SmartCrop] / [CC] / [GridUnsplit] suppression
        // in ui.js. To re-enable: window.GRID_VERBOSE_LOG = true in DevTools.
        if (window.GRID_VERBOSE_LOG) console.log('[GridUnsplit] ' + msg);
      }
    });

    if (!result || result.failureReason) {
      var reason = (result && result.failureReason) || 'no result';
      if (window.GRID_VERBOSE_LOG) {
        console.log('[GridUnsplit] ' + reason + ' — falling back to ink-valley split');
      }
      return { midpoint: null, failureReason: reason };
    }

    if (window.GRID_VERBOSE_LOG) {
      console.log('[GridUnsplit] midpoint=' + Math.round(result.midpoint)
                  + ' pageSlope=' + result.pageSlopeDeg.toFixed(2) + '°'
                  + (result.inferredLeftColumn ? ' (left col extrapolated)' : '')
                  + (result.slopeWarn ? ' (slope warn)' : ''));
    }
    return {
      midpoint: result.midpoint,
      leftHalfAnchorXs: result.leftHalfAnchorXs || null,
      rightHalfAnchorXs: result.rightHalfAnchorXs || null,
      // True when GridUnsplit extrapolated a missing leftmost column (Hugh's
      // Scarborough clipped-page case). Per-half detection won't see that
      // column on its own, so callers must use the anchors instead of
      // attempting clean per-half first.
      inferredLeftColumn: !!result.inferredLeftColumn,
      failureReason: null
    };
  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    console.warn('[GridUnsplit] detectMidpoint threw:', e);
    return { midpoint: null, failureReason: 'exception: ' + msg };
  } finally {
    if (srcMat && srcMat.delete) {
      try { srcMat.delete(); } catch (e2) { /* ignore */ }
    }
  }
}

/**
 * Split a dual-sheet image, producing two separate image Files (left half =
 * one player's sheet, right half = the other player's sheet).
 *
 * Cut-point precedence:
 *   1. Caller-provided opts.cutX (e.g., from GridUnsplit anchor detection)
 *   2. Ink-valley detection via findDualSheetCut
 *   3. Midpoint fallback (built into findDualSheetCut)
 *
 * @param {File} file - The wide image file
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} [opts] - {cutX} optional explicit X-coordinate to split at
 * @returns {Promise<{left: File, right: File}>}
 */
async function splitDualSheet(file, width, height, opts) {
  opts = opts || {};
  var url = URL.createObjectURL(file);
  var img = new Image();
  await new Promise(function(resolve) {
    img.onload = resolve;
    img.src = url;
  });
  URL.revokeObjectURL(url);

  var cutX, cutReason;
  if (typeof opts.cutX === 'number' && isFinite(opts.cutX)
      && opts.cutX > 0 && opts.cutX < width) {
    cutX = Math.round(opts.cutX);
    cutReason = 'caller-provided cutX=' + cutX;
  } else {
    var cut = findDualSheetCut(img, width, height);
    cutX = cut.cutX;
    cutReason = (cut.confident ? 'ink-valley cut at x=' + cutX
                               : 'midpoint fallback at x=' + cutX)
                + ' — ' + cut.reason;
  }
  console.log('[DualSheet] split ' + file.name + ': ' + cutReason);

  var baseName = file.name.replace(/\.\w+$/, '');

  // Left half [0, cutX]
  var canvasL = document.createElement('canvas');
  canvasL.width = cutX;
  canvasL.height = height;
  canvasL.getContext('2d').drawImage(img, 0, 0, cutX, height, 0, 0, cutX, height);
  var blobL = await new Promise(function(resolve) {
    canvasL.toBlob(function(b) { resolve(b); }, 'image/png');
  });
  var leftFile = new File([blobL], baseName + '_left.png', { type: 'image/png' });

  // Right half [cutX, width]
  var canvasR = document.createElement('canvas');
  canvasR.width = width - cutX;
  canvasR.height = height;
  canvasR.getContext('2d').drawImage(img, cutX, 0, width - cutX, height, 0, 0, width - cutX, height);
  var blobR = await new Promise(function(resolve) {
    canvasR.toBlob(function(b) { resolve(b); }, 'image/png');
  });
  var rightFile = new File([blobR], baseName + '_right.png', { type: 'image/png' });

  return { left: leftFile, right: rightFile };
}

/**
 * Convert a PDF file to image File(s) using BatchPdf (pdf.js).
 * Returns array of image Files, one per page.
 *
 * @param {File} pdfFile - The PDF file
 * @returns {Promise<Array<File>>}
 */
async function pdfToImageFiles(pdfFile) {
  if (!window.BatchPdf) {
    throw new Error('PDF support not loaded (batch-pdf.js)');
  }
  var pages = await window.BatchPdf.pdfToImages(pdfFile);
  return pages.map(function(p) { return p.file; });
}

/**
 * Check if a file is a PDF.
 * @param {File} file
 * @returns {boolean}
 */
function isPDF(file) {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
}

// Simple similarity fallback - exact match only
// For proper similarity, use backend /api/similarity endpoint or Pyodide
function simpleSim(a, b){
  return a === b ? 100 : 0;
}

// Levenshtein edit-distance between two strings. Used by fixes.js for fix
// safety checks and by sheet-alignment.js for filtering "structural" sheet
// disagreement vs single-character OCR variance. Two-row DP for memory.
function editDistance(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  var prev = new Array(b.length + 1);
  var cur  = new Array(b.length + 1);
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (var k = 1; k <= b.length; k++) {
      var cost = (a.charCodeAt(i - 1) === b.charCodeAt(k - 1)) ? 0 : 1;
      cur[k] = Math.min(cur[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
    }
    var tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
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
  // Try Pyodide first. Use the BATCH API — calling getSimilarity once per
  // legal move (30+ separate Pyodide round-trips for a typical position)
  // made edit-mode's 'Loading...' sit for seconds.
  if (CONFIG.usePyodide && window.zugwise && window.zugwise.isReady) {
    try {
      var batch = await window.zugwise.getSimilarityBatch(ocrMove, legalMoves);
      var sims = (batch && batch.similarities) || [];
      var scores = legalMoves.map(function(san, i){
        return { san: san, sim: Math.round((sims[i] || 0) * 100) };
      });
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
