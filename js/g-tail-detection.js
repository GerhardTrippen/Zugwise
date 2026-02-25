// =============================================================================
// G-TAIL-DETECTION.JS - Descender tail detection for a/g disambiguation
// =============================================================================
// Port of detect_any_g_tail() and _apply_ag_tail_detection() from bilstm_ocr.py
//
// Dependencies: OpenCV.js (cv global)
// Used by: worker-api.js processScoresheet()
//
// When a cell contains 'a' (e.g., "a4", "Ba3"), we check the cell BELOW
// for a descender tail bleeding from a 'g'. If found, we boost the 'g'
// variant's confidence.
// =============================================================================

/**
 * Detect a 'g' descender tail in the top strip of cellBelow.
 * Port of bilstm_ocr.py detect_any_g_tail()
 *
 * @param {Uint8Array} cellBelowPreprocessed - Preprocessed grayscale image (64x256)
 * @param {number} topPixels - How many pixels from top to search (default 15)
 * @returns {{detected: boolean, confidence: number, debugInfo: Object}}
 */
function detectGTail(cellBelowPreprocessed, topPixels) {
    topPixels = topPixels || 15;

    if (!cellBelowPreprocessed || cellBelowPreprocessed.length === 0) {
        return { detected: false, confidence: 0, debugInfo: { numBlobs: 0, candidates: [] } };
    }

    var width = 256;
    var height = 64;

    // Create cv.Mat from preprocessed data
    var mat = cv.matFromArray(height, width, cv.CV_8UC1, Array.from(cellBelowPreprocessed));

    // Extract top strip
    var topStrip = mat.roi(new cv.Rect(0, 0, width, topPixels));

    // Apply Otsu threshold with binary inversion
    var binary = new cv.Mat();
    cv.threshold(topStrip, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    // Connected components analysis
    var labels = new cv.Mat();
    var stats = new cv.Mat();
    var centroids = new cv.Mat();
    var numLabels = cv.connectedComponentsWithStats(binary, labels, stats, centroids);

    var tailCandidates = [];

    for (var i = 1; i < numLabels; i++) { // Skip background (0)
        var x = stats.intAt(i, cv.CC_STAT_LEFT);
        var y = stats.intAt(i, cv.CC_STAT_TOP);
        var bw = stats.intAt(i, cv.CC_STAT_WIDTH);
        var bh = stats.intAt(i, cv.CC_STAT_HEIGHT);
        var area = stats.intAt(i, cv.CC_STAT_AREA);

        // Tail characteristics
        var isNarrow = bw < 15;
        var hasHeight = bh >= 3;
        var smallArea = area < 150;
        var notTiny = area >= 5;
        var verticallyOriented = (bh >= bw * 0.5) || (area < 50);

        if (isNarrow && hasHeight && smallArea && notTiny && verticallyOriented) {
            var confidence = 0.5;

            // Bonus if very narrow
            if (bw < 8) {
                confidence += 0.2;
            } else if (bw < 12) {
                confidence += 0.1;
            }

            // Bonus if clearly vertical
            if (bh > bw) {
                confidence += 0.15;
            }

            // Bonus if near top edge
            if (y <= 2) {
                confidence += 0.1;
            }

            // Penalty if too wide
            if (bw > 10) {
                confidence -= 0.1;
            }

            tailCandidates.push({
                x: x, y: y, width: bw, height: bh,
                area: area, confidence: confidence
            });
        }
    }

    // Cleanup
    mat.delete();
    topStrip.delete();
    binary.delete();
    labels.delete();
    stats.delete();
    centroids.delete();

    if (tailCandidates.length === 0) {
        return { detected: false, confidence: 0, debugInfo: { numBlobs: numLabels - 1, candidates: [] } };
    }

    // Return best candidate
    var best = tailCandidates[0];
    for (var j = 1; j < tailCandidates.length; j++) {
        if (tailCandidates[j].confidence > best.confidence) {
            best = tailCandidates[j];
        }
    }

    var detected = best.confidence >= 0.4;

    return {
        detected: detected,
        confidence: best.confidence,
        debugInfo: {
            numBlobs: numLabels - 1,
            bestCandidate: best,
            allCandidates: tailCandidates
        }
    };
}

/**
 * Apply g-tail boost to OCR result.
 * Port of bilstm_ocr.py _apply_ag_tail_detection()
 *
 * @param {Object} ocrResult - {move, confidence, alternatives: [{move, confidence}]}
 * @param {Uint8Array} cellBelowData - Preprocessed grayscale data (64x256) of cell below
 * @returns {Object} - Modified ocrResult with boosted g variants
 */
function applyGTailBoost(ocrResult, cellBelowData) {
    if (!ocrResult || !ocrResult.move) return ocrResult;
    if (!cellBelowData) return ocrResult;

    var topMove = ocrResult.move;
    var topConf = ocrResult.confidence || 0;

    // Only process if top candidate contains 'a'
    if (topMove.indexOf('a') === -1) {
        return ocrResult;
    }

    // Check if OpenCV is available
    if (typeof cv === 'undefined' || !cv.Mat) {
        return ocrResult;
    }

    // Run tail detection
    var tailResult = detectGTail(cellBelowData, 15);

    if (!tailResult.detected || tailResult.confidence < 0.4) {
        return ocrResult;
    }

    // Skip boost if BiLSTM is very confident (>90%)
    var CONFIDENCE_THRESHOLD = 0.90;
    if (topConf > CONFIDENCE_THRESHOLD) {
        console.log('[G-Tail] Boost skipped: BiLSTM confident in \'' + topMove + '\' (' + (topConf * 100).toFixed(0) + '% > 90%)');
        return ocrResult;
    }

    // Generate 'g' variant (replace LAST 'a' with 'g')
    var lastAIdx = topMove.lastIndexOf('a');
    var gVariant = topMove.substring(0, lastAIdx) + 'g' + topMove.substring(lastAIdx + 1);

    // Build alternatives list with all candidates
    var alts = [];
    // Add the top move
    alts.push({ move: topMove, confidence: topConf });
    // Add existing alternatives
    if (ocrResult.alternatives) {
        for (var i = 0; i < ocrResult.alternatives.length; i++) {
            var alt = ocrResult.alternatives[i];
            if (alt.move !== topMove) {
                alts.push({ move: alt.move, confidence: alt.confidence || 0 });
            }
        }
    }

    // Find g variant in list
    var gIdx = -1;
    var gConfOriginal = 0;
    for (var j = 0; j < alts.length; j++) {
        if (alts[j].move === gVariant) {
            gIdx = j;
            gConfOriginal = alts[j].confidence;
            break;
        }
    }

    // Calculate boost
    var tailConf = tailResult.confidence;
    var boostFactor = tailConf * 0.6;
    var boostAmount = topConf * boostFactor;
    var gConfBoosted = Math.min(0.98, gConfOriginal + boostAmount);

    // Update or add g variant
    if (gIdx >= 0) {
        alts[gIdx].confidence = gConfBoosted;
    } else {
        alts.push({ move: gVariant, confidence: gConfBoosted });
    }

    // Sort by confidence descending
    alts.sort(function(a, b) { return b.confidence - a.confidence; });

    // Build result
    var winner = alts[0];
    var newAlts = alts.slice(1);

    if (winner.move === gVariant) {
        console.log('[G-Tail] BOOST: \'' + topMove + '\' -> \'' + gVariant + '\' (g: ' +
            gConfOriginal.toFixed(2) + ' -> ' + gConfBoosted.toFixed(2) + ', a: ' + topConf.toFixed(2) + ') -> g wins!');
    } else {
        console.log('[G-Tail] Boosted \'' + gVariant + '\' (' + gConfOriginal.toFixed(2) + ' -> ' + gConfBoosted.toFixed(2) +
            ') but \'' + winner.move + '\' still wins (' + winner.confidence.toFixed(2) + ')');
    }

    return {
        move: winner.move,
        confidence: winner.confidence,
        alternatives: newAlts
    };
}

// =============================================================================
// EXPORTS
// =============================================================================
if (typeof window !== 'undefined') {
    window.GTailDetection = {
        detectGTail: detectGTail,
        applyGTailBoost: applyGTailBoost
    };
}
