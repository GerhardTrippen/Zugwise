// =============================================================================
// GRID-COLUMNS.JS - Column detection and pattern validation
// =============================================================================
// Part of Zugwise Grid Detection v34
// 
// Dependencies: OpenCV.js (cv global)
// Used by: grid-detection.js
//
// Scoresheet column patterns:
//   2-column: n/w/w/n/w/w (7 boundaries = 6 widths)
//     [moveNum][White][Black][moveNum][White][Black]
//   3-column: n/w/w/n/w/w/n/w/w (10 boundaries = 9 widths)
//     [moveNum][White][Black][moveNum][White][Black][moveNum][White][Black]
// =============================================================================

/**
 * Score how well a set of column boundaries matches expected pattern
 * Lower score = better match, Infinity = invalid
 * 
 * @param {Array<{x,score}>} cols - Column boundary candidates with x positions
 * @param {Object} config - {expectedCols, format}
 * @param {number} gridWidth - Total width of grid
 * @returns {number} - Pattern error score (lower is better)
 */
function scoreColumnPattern(cols, config, gridWidth) {
    if (cols.length !== config.expectedCols) return Infinity;
    
    const gw = cols[cols.length - 1].x - cols[0].x;
    if (gw < gridWidth * 0.60) return Infinity;

    // Calculate relative widths
    const widths = [];
    for (let i = 0; i < cols.length - 1; i++) {
        widths.push((cols[i + 1].x - cols[i].x) / gw);
    }
    
    let narrowIndices, wideIndices, pattern;
    if (config.format === '2col') {
        // n/w/w/n/w/w pattern for 2-column
        narrowIndices = [0, 3];
        wideIndices = [1, 2, 4, 5];
        pattern = [1, 2.3, 2.2, 1, 2.3, 2.2];
    } else {
        // n/w/w/n/w/w/n/w/w pattern for 3-column
        narrowIndices = [0, 3, 6];
        wideIndices = [1, 2, 4, 5, 7, 8];
        pattern = [1, 2.2, 2.2, 1, 2.2, 2.2, 1, 2.2, 2.2];
    }
    
    // Check consistency within narrow and wide groups
    const narrowWidths = narrowIndices.map(i => widths[i]);
    const wideWidths = wideIndices.map(i => widths[i]);
    const narrowAvg = narrowWidths.reduce((a, b) => a + b, 0) / narrowWidths.length;
    const wideAvg = wideWidths.reduce((a, b) => a + b, 0) / wideWidths.length;
    const narrowVar = Math.max(...narrowWidths.map(w => Math.abs(w - narrowAvg))) / narrowAvg;
    const wideVar = Math.max(...wideWidths.map(w => Math.abs(w - wideAvg))) / wideAvg;
    
    // Reject if too much variance within groups
    if (narrowVar > 0.25 || wideVar > 0.25) return Infinity;
    
    // Check narrow/wide ratio is reasonable
    const ratio = narrowAvg / wideAvg;
    if (ratio > 0.60 || ratio < 0.30) return Infinity;
    
    // Calculate pattern match error
    const pSum = pattern.reduce((a, b) => a + b, 0);
    const pNorm = pattern.map(p => p / pSum);
    let err = 0;
    for (let i = 0; i < widths.length; i++) {
        err += Math.pow(widths[i] - pNorm[i], 2);
    }

    // Prefer patterns that cover more of the image width
    // A pattern covering 56% should lose to one covering 85% even if the shape match is similar
    const coverage = gw / gridWidth;
    const coveragePenalty = Math.pow(1 - coverage, 2) * 0.05;

    return err + coveragePenalty;
}

/**
 * Generate all k-combinations from array
 * @param {Array} arr - Source array
 * @param {number} k - Combination size
 * @returns {Array<Array>} - All combinations
 */
function getCombinations(arr, k) {
    const results = [];
    function combine(start, combo) {
        if (combo.length === k) {
            results.push([...combo]);
            return;
        }
        for (let i = start; i <= arr.length - (k - combo.length); i++) {
            combo.push(arr[i]);
            combine(i + 1, combo);
            combo.pop();
        }
    }
    combine(0, []);
    return results;
}

/**
 * Find the best combination of column boundaries matching expected pattern
 * 
 * @param {Array<{x,score}>} clusteredCols - Detected column candidates
 * @param {Object} config - {expectedCols, internalDividers, format}
 * @param {number} gridWidth - Total width of grid
 * @param {number} [leftEdge=0] - Left grid boundary x
 * @param {number} [rightEdge=gridWidth] - Right grid boundary x
 * @returns {Object} - {cols, score, valid}
 */
function findBestColumnCombination(clusteredCols, config, gridWidth, leftEdge, rightEdge) {
    if (leftEdge === undefined || leftEdge === null) leftEdge = 0;
    if (rightEdge === undefined || rightEdge === null) rightEdge = gridWidth;
    let bestCols = [], bestScore = Infinity;

    if (clusteredCols.length < config.internalDividers) {
        return { cols: [], score: Infinity, valid: false };
    }

    // Limit candidates to top scorers if too many
    const candidates = clusteredCols.length <= 15
        ? clusteredCols
        : [...clusteredCols].sort((a, b) => b.score - a.score).slice(0, 10).sort((a, b) => a.x - b.x);

    const combos = getCombinations(candidates, config.internalDividers);
    for (const combo of combos) {
        // Add implicit left and right boundaries
        const cols = [{ x: leftEdge }, ...combo, { x: rightEdge }];
        const score = scoreColumnPattern(cols, config, gridWidth);
        if (score < bestScore) {
            bestScore = score;
            bestCols = cols;
        }
    }

    return { cols: bestCols, score: bestScore, valid: bestScore < Infinity };
}

/**
 * Detect column boundaries using vertical edge detection
 * 
 * @param {cv.Mat} warpGray - Grayscale warped grid image
 * @param {number} ww - Warped width
 * @param {number} wh - Warped height
 * @param {Object} config - {expectedCols, internalDividers, format}
 * @param {Function} log - Logging function
 * @param {number} [leftEdge] - Left grid boundary x (default 0)
 * @param {number} [rightEdge] - Right grid boundary x (default ww)
 * @returns {Object} - {columnBoundaries: Array<number>, patternValid: boolean}
 */
function detectColumns(warpGray, ww, wh, config, log, leftEdge, rightEdge) {
    log = log || console.log;
    
    // Sobel edge detection for vertical lines
    const sobelX = new cv.Mat();
    cv.Sobel(warpGray, sobelX, cv.CV_16S, 1, 0, 3);
    const absSobel = new cv.Mat();
    cv.convertScaleAbs(sobelX, absSobel);
    
    // Sum columns to create profile
    const colSums = new Array(ww).fill(0);
    for (let x = 0; x < ww; x++) {
        for (let y = 0; y < wh; y++) {
            colSums[x] += absSobel.ucharAt(y, x);
        }
    }
    
    // Smooth the profile
    const radius = 5;
    const smoothed = new Array(ww).fill(0);
    for (let x = radius; x < ww - radius; x++) {
        let sum = 0;
        for (let dx = -radius; dx <= radius; dx++) {
            sum += colSums[x + dx];
        }
        smoothed[x] = sum / (radius * 2 + 1);
    }
    
    const maxSum = Math.max(...smoothed);
    const edgeMargin = Math.round(ww * 0.04);  // 4% margin to avoid detecting edges
    const threshold = maxSum * 0.15;
    
    // Find local maxima (peaks)
    const allPeaks = [];
    for (let x = edgeMargin; x < ww - edgeMargin; x++) {
        let isMax = true;
        for (let dx = -10; dx <= 10; dx++) {
            if (dx !== 0 && smoothed[x + dx] > smoothed[x]) {
                isMax = false;
                break;
            }
        }
        if (isMax && smoothed[x] > threshold) {
            allPeaks.push({ x: x, score: smoothed[x] });
        }
    }
    
    // Cluster nearby peaks
    const minGap = ww * 0.03;
    const clustered = [];
    allPeaks.sort((a, b) => a.x - b.x);
    for (const p of allPeaks) {
        if (clustered.length === 0 || p.x - clustered[clustered.length - 1].x > minGap) {
            clustered.push(p);
        } else if (p.score > clustered[clustered.length - 1].score) {
            clustered[clustered.length - 1] = p;
        }
    }
    
    log('Found ' + clustered.length + ' column peaks');
    
    // Try pattern matching
    let columnBoundaries;
    let patternValid = false;
    const result = findBestColumnCombination(clustered, config, ww, leftEdge, rightEdge);
    
    if (result.valid) {
        columnBoundaries = result.cols.map(c => c.x);
        patternValid = true;
        const widths = [];
        for (let i = 0; i < columnBoundaries.length - 1; i++) {
            widths.push(((columnBoundaries[i + 1] - columnBoundaries[i]) / ww * 100).toFixed(0) + '%');
        }
        log('Pattern validated: ' + widths.join(' | '));
    } else {
        log('Pattern failed, using top peaks');
        clustered.sort((a, b) => b.score - a.score);
        const topN = clustered.slice(0, config.internalDividers);
        topN.sort((a, b) => a.x - b.x);
        var fallbackLeft = (leftEdge !== undefined && leftEdge !== null) ? leftEdge : 0;
        var fallbackRight = (rightEdge !== undefined && rightEdge !== null) ? rightEdge : ww;
        columnBoundaries = [fallbackLeft, ...topN.map(p => p.x), fallbackRight];
    }
    
    // Cleanup
    sobelX.delete();
    absSobel.delete();
    
    return { 
        columnBoundaries, 
        patternValid,
        // Return smoothed profile for visualization
        profile: smoothed,
        maxSum,
        edgeMargin
    };
}

// =============================================================================
// HORIZONTAL-LINES-ONLY: Infer columns from segment gaps
// =============================================================================

/**
 * Infer column boundaries from horizontal line segments.
 * For scoresheets with horizontal lines only (no vertical dividers),
 * column boundaries are inferred from the gaps between line segments.
 *
 * @param {Array<Array<{startX, endX}>>} allRowSegments - Segments per row from detectLineSegments()
 * @param {number} ww - Image width
 * @param {Object} config - {expectedCols, format}
 * @param {Function} log - Logging function
 * @returns {Object} - {columnBoundaries: Array<number>, valid: boolean}
 */
function inferColumnsFromSegments(allRowSegments, ww, config, log) {
    log = log || console.log;

    // Count segments per row, find the dominant count
    var countMap = {};
    for (var i = 0; i < allRowSegments.length; i++) {
        var n = allRowSegments[i].length;
        if (n > 0) {
            countMap[n] = (countMap[n] || 0) + 1;
        }
    }

    var dominantCount = 0;
    var dominantFreq = 0;
    for (var key in countMap) {
        if (countMap[key] > dominantFreq) {
            dominantFreq = countMap[key];
            dominantCount = parseInt(key);
        }
    }

    log('inferColumnsFromSegments: dominant segment count = ' + dominantCount + ' (' + dominantFreq + '/' + allRowSegments.length + ' rows)');

    if (dominantCount <= 0) {
        log('No segments detected — cannot infer columns');
        return { columnBoundaries: null, valid: false };
    }

    // Use only rows with the dominant segment count
    var consistentRows = allRowSegments.filter(function(segs) {
        return segs.length === dominantCount;
    });

    if (dominantCount === 1) {
        // Single continuous line per row — no gap info, use ratio fallback
        var leftXs = consistentRows.map(function(segs) { return segs[0].startX; });
        var rightXs = consistentRows.map(function(segs) { return segs[0].endX; });
        leftXs.sort(function(a, b) { return a - b; });
        rightXs.sort(function(a, b) { return a - b; });
        var leftEdge = leftXs[Math.floor(leftXs.length / 2)];
        var rightEdge = rightXs[Math.floor(rightXs.length / 2)];
        log('Single segment per row — falling back to ratio-based inference');
        return inferColumnsByRatio(leftEdge, rightEdge, config, log);
    }

    // Multiple segments: collect boundary positions and gap midpoints
    // For each consistent row, collect: leftmost startX, rightmost endX,
    // and midpoints between consecutive segments (these are the column gaps)
    var allLeftEdges = [];
    var allRightEdges = [];
    var gapMidpoints = []; // array of arrays, one per gap position
    for (var g = 0; g < dominantCount - 1; g++) {
        gapMidpoints.push([]);
    }

    for (var ri = 0; ri < consistentRows.length; ri++) {
        var segs = consistentRows[ri];
        allLeftEdges.push(segs[0].startX);
        allRightEdges.push(segs[segs.length - 1].endX);
        for (var g = 0; g < segs.length - 1; g++) {
            var mid = Math.round((segs[g].endX + segs[g + 1].startX) / 2);
            gapMidpoints[g].push(mid);
        }
    }

    // Take median of each position across rows
    allLeftEdges.sort(function(a, b) { return a - b; });
    allRightEdges.sort(function(a, b) { return a - b; });
    var leftEdge = allLeftEdges[Math.floor(allLeftEdges.length / 2)];
    var rightEdge = allRightEdges[Math.floor(allRightEdges.length / 2)];

    var medianGaps = [];
    for (var g = 0; g < gapMidpoints.length; g++) {
        gapMidpoints[g].sort(function(a, b) { return a - b; });
        medianGaps.push(gapMidpoints[g][Math.floor(gapMidpoints[g].length / 2)]);
    }

    // Build boundaries: [leftEdge, gap1, gap2, ..., rightEdge]
    var boundaries = [leftEdge].concat(medianGaps).concat([rightEdge]);
    log('Raw boundaries from segments: [' + boundaries.join(', ') + '] (' + boundaries.length + ' boundaries)');

    // Check if boundaries count matches expectedCols
    if (boundaries.length === config.expectedCols) {
        // Validate with scoreColumnPattern
        var cols = boundaries.map(function(x) { return { x: x }; });
        var score = scoreColumnPattern(cols, config, rightEdge - leftEdge);
        if (score < Infinity) {
            log('Segment boundaries match expected pattern (score=' + score.toFixed(6) + ')');
            return { columnBoundaries: boundaries, valid: true };
        }
    }

    // Try subdividing if we have fewer boundaries than expected
    if (boundaries.length < config.expectedCols) {
        log('Only ' + boundaries.length + ' boundaries, need ' + config.expectedCols + ' — trying subdivision');
        var subdivided = subdivideColumns(boundaries, config, log);
        if (subdivided) {
            return { columnBoundaries: subdivided, valid: true };
        }
    }

    // Last resort: ratio-based fallback
    log('Segment-based inference failed — falling back to ratio');
    return inferColumnsByRatio(leftEdge, rightEdge, config, log);
}

/**
 * Infer column boundaries using standard width ratios.
 * Fallback when segments give no gap info (single continuous line per row).
 *
 * Standard ratios for 2col (7 boundaries, 6 widths):
 *   moveNum/white/black/moveNum/white/black ≈ 8%/21%/21%/8%/21%/21%
 *
 * Standard ratios for 3col (10 boundaries, 9 widths):
 *   (moveNum/white/black) × 3 ≈ 5.5%/14%/14% × 3
 *
 * @param {number} leftEdge - Left boundary x
 * @param {number} rightEdge - Right boundary x
 * @param {Object} config - {expectedCols, format}
 * @param {Function} log - Logging function
 * @returns {Object} - {columnBoundaries: Array<number>, valid: boolean}
 */
function inferColumnsByRatio(leftEdge, rightEdge, config, log) {
    log = log || console.log;
    var totalW = rightEdge - leftEdge;

    var ratios;
    if (config.format === '2col') {
        // n/w/w/n/w/w — 6 widths for 7 boundaries
        ratios = [0.08, 0.21, 0.21, 0.08, 0.21, 0.21];
    } else {
        // n/w/w/n/w/w/n/w/w — 9 widths for 10 boundaries
        ratios = [0.055, 0.14, 0.14, 0.055, 0.14, 0.14, 0.055, 0.14, 0.14];
    }

    // Normalize ratios to sum to 1
    var rSum = ratios.reduce(function(a, b) { return a + b; }, 0);
    ratios = ratios.map(function(r) { return r / rSum; });

    var boundaries = [leftEdge];
    var cumX = leftEdge;
    for (var i = 0; i < ratios.length; i++) {
        cumX += ratios[i] * totalW;
        boundaries.push(Math.round(cumX));
    }

    log('inferColumnsByRatio: [' + boundaries.join(', ') + ']');
    return { columnBoundaries: boundaries, valid: true };
}

/**
 * Iteratively split the widest column at its midpoint until we reach expectedCols.
 *
 * @param {Array<number>} boundaries - Current column boundary positions
 * @param {Object} config - {expectedCols, format}
 * @param {Function} log - Logging function
 * @returns {Array<number>|null} - Subdivided boundaries, or null if validation fails
 */
function subdivideColumns(boundaries, config, log) {
    log = log || console.log;
    var result = boundaries.slice();

    var maxIter = 20; // safety limit
    while (result.length < config.expectedCols && maxIter-- > 0) {
        // Find widest column
        var maxWidth = 0;
        var maxIdx = 0;
        for (var i = 0; i < result.length - 1; i++) {
            var w = result[i + 1] - result[i];
            if (w > maxWidth) {
                maxWidth = w;
                maxIdx = i;
            }
        }
        // Split at midpoint
        var mid = Math.round((result[maxIdx] + result[maxIdx + 1]) / 2);
        result.splice(maxIdx + 1, 0, mid);
    }

    if (result.length !== config.expectedCols) {
        log('subdivideColumns: ended with ' + result.length + ' boundaries (expected ' + config.expectedCols + ')');
        return null;
    }

    // Validate with scoreColumnPattern
    var gridWidth = result[result.length - 1] - result[0];
    var cols = result.map(function(x) { return { x: x }; });
    var score = scoreColumnPattern(cols, config, gridWidth);
    if (score < Infinity) {
        log('subdivideColumns: valid pattern (score=' + score.toFixed(6) + ')');
        return result;
    }

    log('subdivideColumns: pattern validation failed');
    return null;
}

// =============================================================================
// EXPORTS
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        scoreColumnPattern,
        getCombinations,
        findBestColumnCombination,
        detectColumns,
        inferColumnsFromSegments,
        inferColumnsByRatio,
        subdivideColumns
    };
}
