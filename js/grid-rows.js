// =============================================================================
// GRID-ROWS.JS - Row detection and grid building
// =============================================================================
// Part of Zugwise Grid Detection v34
// 
// Dependencies: OpenCV.js (cv global)
// Used by: grid-detection.js
//
// Row detection strategy:
//   1. Detect horizontal edges using Sobel filter
//   2. Focus on areas near vertical column lines (less handwriting noise)
//   3. Find peaks in the row profile
//   4. Build grid from bottom up (bottom lines are more reliable)
//   5. Interpolate missing rows if needed
// =============================================================================

/**
 * Detect row candidates using horizontal edge detection
 * Focuses on areas near vertical lines to avoid handwriting noise
 * 
 * @param {cv.Mat} warpGray - Grayscale warped grid image
 * @param {Array<number>} columnBoundaries - Detected column x positions
 * @param {number} ww - Warped width
 * @param {number} wh - Warped height
 * @param {Object} config - {rowCount}
 * @param {Function} log - Logging function
 * @returns {Object} - {peaks: Array<{y,score}>, hSobel: cv.Mat} - Caller must delete hSobel!
 */
function detectRows(warpGray, columnBoundaries, ww, wh, config, log) {
    log = log || console.log;
    
    // Sobel edge detection for horizontal lines
    const sobelY = new cv.Mat();
    cv.Sobel(warpGray, sobelY, cv.CV_16S, 0, 1, 3);
    const absSobel = new cv.Mat();
    cv.convertScaleAbs(sobelY, absSobel);
    
    // Focus on areas near vertical lines (less handwriting noise)
    const lineWidth = Math.max(5, Math.round(ww * 0.008));
    const verticalLineXs = columnBoundaries.slice(1, -1);  // Internal dividers only
    
    const rowSums = new Array(wh).fill(0);
    for (let y = 0; y < wh; y++) {
        for (const vx of verticalLineXs) {
            const left = Math.max(0, vx - lineWidth);
            const right = Math.min(ww - 1, vx + lineWidth);
            for (let x = left; x <= right; x++) {
                rowSums[y] += absSobel.ucharAt(y, x);
            }
        }
    }
    
    // Smooth the profile
    const radius = 2;
    const smoothed = new Array(wh).fill(0);
    for (let y = radius; y < wh - radius; y++) {
        let sum = 0;
        for (let dy = -radius; dy <= radius; dy++) {
            sum += rowSums[y + dy];
        }
        smoothed[y] = sum / (radius * 2 + 1);
    }
    
    const maxSum = Math.max(...smoothed);
    const threshold = maxSum * 0.25;
    
    // Find local maxima (peaks)
    const allPeaks = [];
    for (let y = 5; y < wh - 5; y++) {
        let isMax = true;
        for (let dy = -4; dy <= 4; dy++) {
            if (dy !== 0 && smoothed[y + dy] > smoothed[y]) {
                isMax = false;
                break;
            }
        }
        if (isMax && smoothed[y] > threshold) {
            allPeaks.push({ y: y, score: smoothed[y] });
        }
    }
    
    // Cluster nearby peaks
    const expectedH = wh / (config.rowCount + 1);
    const minGap = expectedH * 0.4;
    const clustered = [];
    allPeaks.sort((a, b) => a.y - b.y);
    for (const p of allPeaks) {
        if (clustered.length === 0 || p.y - clustered[clustered.length - 1].y > minGap) {
            clustered.push(p);
        } else if (p.score > clustered[clustered.length - 1].score) {
            clustered[clustered.length - 1] = p;
        }
    }
    
    // Cleanup (keep absSobel for measureGridWidth - caller must delete hSobel!)
    sobelY.delete();

    return { peaks: clustered, hSobel: absSobel };
}

/**
 * Detect row candidates using horizontal edge detection (full-width scan)
 * Variant of detectRows() for horizontal-lines-only scoresheets where
 * there are no vertical lines to focus near.
 *
 * @param {cv.Mat} warpGray - Grayscale warped grid image
 * @param {number} ww - Warped width
 * @param {number} wh - Warped height
 * @param {Object} config - {rowCount}
 * @param {Function} log - Logging function
 * @returns {Object} - {peaks: Array<{y,score}>, hSobel: cv.Mat} - Caller must delete hSobel!
 */
function detectRowsFullWidth(warpGray, ww, wh, config, log) {
    log = log || console.log;

    // Sobel edge detection for horizontal lines
    const sobelY = new cv.Mat();
    cv.Sobel(warpGray, sobelY, cv.CV_16S, 0, 1, 3);
    const absSobel = new cv.Mat();
    cv.convertScaleAbs(sobelY, absSobel);

    // Sum across full image width (no vertical line focus)
    const rowSums = new Array(wh).fill(0);
    for (let y = 0; y < wh; y++) {
        for (let x = 0; x < ww; x++) {
            rowSums[y] += absSobel.ucharAt(y, x);
        }
    }

    // Smooth the profile
    const radius = 2;
    const smoothed = new Array(wh).fill(0);
    for (let y = radius; y < wh - radius; y++) {
        let sum = 0;
        for (let dy = -radius; dy <= radius; dy++) {
            sum += rowSums[y + dy];
        }
        smoothed[y] = sum / (radius * 2 + 1);
    }

    const maxSum = Math.max(...smoothed);
    const threshold = maxSum * 0.25;

    // Find local maxima (peaks)
    const allPeaks = [];
    for (let y = 5; y < wh - 5; y++) {
        let isMax = true;
        for (let dy = -4; dy <= 4; dy++) {
            if (dy !== 0 && smoothed[y + dy] > smoothed[y]) {
                isMax = false;
                break;
            }
        }
        if (isMax && smoothed[y] > threshold) {
            allPeaks.push({ y: y, score: smoothed[y] });
        }
    }

    // Cluster nearby peaks
    const expectedH = wh / (config.rowCount + 1);
    const minGap = expectedH * 0.4;
    const clustered = [];
    allPeaks.sort((a, b) => a.y - b.y);
    for (const p of allPeaks) {
        if (clustered.length === 0 || p.y - clustered[clustered.length - 1].y > minGap) {
            clustered.push(p);
        } else if (p.score > clustered[clustered.length - 1].score) {
            clustered[clustered.length - 1] = p;
        }
    }

    log('detectRowsFullWidth: ' + clustered.length + ' row candidates (threshold=' + Math.round(threshold) + ')');

    // Cleanup (keep absSobel for caller - caller must delete hSobel!)
    sobelY.delete();

    return { peaks: clustered, hSobel: absSobel };
}

/**
 * Detect horizontal line segments per row
 * Scans each detected row line to find where the horizontal line exists vs gaps.
 * Used by horizontal-lines-only mode to infer column boundaries from segment gaps.
 *
 * @param {cv.Mat} hSobel - Absolute horizontal Sobel image (from detectRowsFullWidth)
 * @param {Array<{y,score}>} rowPeaks - Detected row candidates
 * @param {number} ww - Image width
 * @param {Function} log - Logging function
 * @returns {Array<Array<{startX, endX}>>} - Segments per row
 */
function detectLineSegments(hSobel, rowPeaks, ww, log) {
    log = log || console.log;
    var wh = hSobel.rows;
    var band = 3; // scan ±3px around each row Y
    var mergeGap = Math.max(4, Math.round(ww * 0.02)); // merge gaps < 2% of width
    var minSegLen = Math.round(ww * 0.05); // filter segments < 5% of width

    var allSegments = [];

    for (var ri = 0; ri < rowPeaks.length; ri++) {
        var ry = rowPeaks[ri].y;

        // Build 1D profile: for each X, max Sobel magnitude in the band
        var profile = new Array(ww).fill(0);
        var rowMax = 0;
        for (var x = 0; x < ww; x++) {
            for (var dy = -band; dy <= band; dy++) {
                var yy = ry + dy;
                if (yy >= 0 && yy < wh) {
                    var v = hSobel.ucharAt(yy, x);
                    if (v > profile[x]) profile[x] = v;
                }
            }
            if (profile[x] > rowMax) rowMax = profile[x];
        }

        // Threshold at 20% of this row's max
        var thresh = rowMax * 0.20;
        if (rowMax < 10) {
            // Very weak row — no meaningful segments
            allSegments.push([]);
            continue;
        }

        // Find continuous runs of above-threshold pixels
        var rawSegments = [];
        var inSegment = false;
        var segStart = 0;
        for (var x = 0; x < ww; x++) {
            if (profile[x] >= thresh) {
                if (!inSegment) {
                    inSegment = true;
                    segStart = x;
                }
            } else {
                if (inSegment) {
                    rawSegments.push({ startX: segStart, endX: x - 1 });
                    inSegment = false;
                }
            }
        }
        if (inSegment) {
            rawSegments.push({ startX: segStart, endX: ww - 1 });
        }

        // Merge small gaps (< 2% of width) — noise within a single line
        var merged = [];
        for (var si = 0; si < rawSegments.length; si++) {
            if (merged.length > 0 && rawSegments[si].startX - merged[merged.length - 1].endX <= mergeGap) {
                merged[merged.length - 1].endX = rawSegments[si].endX;
            } else {
                merged.push({ startX: rawSegments[si].startX, endX: rawSegments[si].endX });
            }
        }

        // Filter out tiny segments (< 5% of width) — handwriting artifacts
        var filtered = merged.filter(function(seg) {
            return (seg.endX - seg.startX) >= minSegLen;
        });

        allSegments.push(filtered);
    }

    // Log summary
    var segCounts = allSegments.map(function(s) { return s.length; });
    log('detectLineSegments: segments per row = [' + segCounts.join(', ') + ']');

    return allSegments;
}

/**
 * Interpolate rows between top and bottom boundaries
 * Fallback when detection fails
 * 
 * @param {number} topY - Top row y position
 * @param {number} bottomY - Bottom row y position
 * @param {Object} config - {rowCount}
 * @returns {Array<{y}>} - Interpolated row positions
 */
function interpolateRows(topY, bottomY, config) {
    var hasHeader = config.hasHeader !== false;
    const numIntervals = config.rowCount + (hasHeader ? 1 : 0);  // header + data rows OR just data rows
    const rows = [];
    for (let i = 0; i <= numIntervals; i++) {
        rows.push({ y: Math.round(topY + (bottomY - topY) * i / numIntervals) });
    }
    return rows;
}

/**
 * Build grid rows from bottom up
 * Bottom lines are more reliable anchors than top (headers can vary)
 * 
 * @param {Array<{y,score}>} clusteredRows - Detected row candidates
 * @param {number} wh - Warped height
 * @param {Object} config - {rowCount}
 * @param {Function} log - Logging function
 * @returns {Array<{y}>} - Final row positions (rowCount+2 lines for rowCount+1 rows)
 */
function buildGridFromBottom(clusteredRows, wh, config, log) {
    log = log || console.log;
    
    var hasHeader = config.hasHeader !== false;  // default true for backward compat
    const targetLines = config.rowCount + (hasHeader ? 2 : 1);  // header+data+bottom OR data+bottom
    log('Building grid from bottom (with line detection)...');
    log('Target: ' + targetLines + ' lines for ' + (hasHeader ? (config.rowCount + 1) + ' rows (header + ' + config.rowCount + ' data)' : config.rowCount + ' data rows (no header)'));
    
    if (!clusteredRows || clusteredRows.length < 3) {
        log('Too few row candidates, using equal division fallback');
        const rows = [];
        const rowHeight = (wh * 0.95) / (targetLines - 1);
        for (let i = 0; i < targetLines; i++) {
            rows.push({ y: Math.round(wh * 0.02 + i * rowHeight) });
        }
        return rows;
    }
    
    // Sort by y position
    clusteredRows.sort((a, b) => a.y - b.y);
    
    // Find bottom anchor - strongest line in bottom 30% of image
    const maxRowScore = Math.max(...clusteredRows.map(r => r.score));
    const strongRows = clusteredRows.filter(r =>
        r.score > maxRowScore * 0.3 && r.y > wh * 0.70
    );
    
    let gridRows = [];
    let estHeight = wh / 25;
    
    if (strongRows.length > 0) {
        strongRows.sort((a, b) => b.y - a.y);
        const bottomLine = strongRows[0];
        log('Bottom anchor: y=' + bottomLine.y);
        const bottomIdx = clusteredRows.findIndex(r => r.y === bottomLine.y);
        gridRows = [bottomLine];
        
        // Estimate row height from gaps between bottom few lines
        if (bottomIdx > 0) {
            const near = clusteredRows.slice(Math.max(0, bottomIdx - 5), bottomIdx + 1);
            if (near.length >= 2) {
                const gaps = [];
                for (let i = 0; i < near.length - 1; i++) {
                    gaps.push(near[i + 1].y - near[i].y);
                }
                estHeight = gaps.reduce((a, b) => a + b, 0) / gaps.length;
                log('Estimated row height: ' + estHeight.toFixed(1) + 'px');
            }
        }
        
        // Walk upward from bottom, accepting only lines that match expected spacing
        const tol = estHeight * 0.5;
        for (let i = bottomIdx - 1; i >= 0 && gridRows.length < targetLines; i--) {
            const cand = clusteredRows[i];
            const expectedY = gridRows[gridRows.length - 1].y - estHeight;
            if (Math.abs(cand.y - expectedY) < tol) {
                gridRows.push(cand);
                // Adaptive height update: smooth the estimate
                estHeight = estHeight * 0.7 + (gridRows[gridRows.length - 2].y - cand.y) * 0.3;
            }
        }
        gridRows.reverse();
        log('Found ' + gridRows.length + ' consistent rows from detection');

        // Log all row positions and gaps
        var debugLines = [];
        for (var di = 0; di < gridRows.length; di++) {
            var gap = di > 0 ? (gridRows[di].y - gridRows[di - 1].y) : 0;
            debugLines.push('  line[' + di + '] y=' + gridRows[di].y + (di > 0 ? ' gap=' + Math.round(gap) : ''));
        }
        log('Row positions:\n' + debugLines.join('\n'));
    }

    // Merge short rows: if two consecutive gaps together ≈ one normal gap,
    // remove the boundary between them (the middle line is a false detection).
    // Example: rows 19,20,21 where gap(19-20) + gap(20-21) ≈ gap(18-19)
    if (gridRows.length >= 4) {
        var gaps = [];
        for (var gi = 0; gi < gridRows.length - 1; gi++) {
            gaps.push(gridRows[gi + 1].y - gridRows[gi].y);
        }
        var sortedGaps = gaps.slice().sort(function(a, b) { return a - b; });
        var medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
        log('Merge analysis: medianGap=' + Math.round(medianGap) + ', smallest=' + Math.round(sortedGaps[0]) + ', largest=' + Math.round(sortedGaps[sortedGaps.length - 1]));
        log('All gaps: ' + gaps.map(function(g) { return Math.round(g); }).join(', '));

        var merged = [gridRows[0]];
        for (var gi = 0; gi < gaps.length; gi++) {
            if (gi + 1 < gaps.length &&
                gaps[gi] < medianGap * 0.75 &&
                gaps[gi + 1] < medianGap * 0.75 &&
                Math.abs(gaps[gi] + gaps[gi + 1] - medianGap) < medianGap * 0.35) {
                // gaps[gi] and gaps[gi+1] together ≈ medianGap
                // Skip gridRows[gi+1] (the false middle line) — keep the line after the pair
                log('Merging short rows: gap[' + gi + ']=' + Math.round(gaps[gi]) + ' + gap[' + (gi + 1) + ']=' + Math.round(gaps[gi + 1]) + ' ≈ median=' + Math.round(medianGap));
                merged.push(gridRows[gi + 2]);
                gi++; // skip the next gap too (we consumed both)
            } else {
                merged.push(gridRows[gi + 1]);
            }
        }
        if (merged.length < gridRows.length) {
            log('Merged short rows: ' + gridRows.length + ' → ' + merged.length + ' lines');
            gridRows = merged;
        }
    }

    // In a warped/deskewed image, y=0 is the top grid boundary and y=wh is the bottom.
    // Add image edges as grid lines when there's enough space for a row.
    if (gridRows.length >= 2 && gridRows.length < targetLines) {
        var avgGap = (gridRows[gridRows.length - 1].y - gridRows[0].y) / (gridRows.length - 1);

        // Add top edge (y=0) if first detected line is far enough from top
        var spaceAbove = gridRows[0].y;
        if (spaceAbove > avgGap * 0.4 && gridRows.length < targetLines) {
            gridRows.unshift({ y: 0 });
            log('Added top line at y=0 (spaceAbove=' + Math.round(spaceAbove) + ', avgGap=' + Math.round(avgGap) + ')');
        }

        // Add bottom edge (y=wh) if last detected line is far enough from bottom
        var spaceBelow = wh - gridRows[gridRows.length - 1].y;
        if (spaceBelow > avgGap * 0.4 && gridRows.length < targetLines) {
            gridRows.push({ y: wh });
            log('Added bottom line at y=' + wh + ' (spaceBelow=' + Math.round(spaceBelow) + ')');
        }
    }

    // Check if there's substantial space below the last line for another row
    if (gridRows.length >= 3 && gridRows.length < targetLines) {
        var lastGap = gridRows[gridRows.length - 1].y - gridRows[gridRows.length - 2].y;
        var prevGap = gridRows[gridRows.length - 2].y - gridRows[gridRows.length - 3].y;
        var spaceBelow2 = wh - gridRows[gridRows.length - 1].y;

        // If there's at least 60% of a row height below the last line, add another row
        if (spaceBelow2 > prevGap * 0.6) {
            var newBottomY = Math.min(wh, gridRows[gridRows.length - 1].y + prevGap);
            gridRows.push({ y: Math.round(newBottomY) });
            log('Added extra bottom row at y=' + Math.round(newBottomY) + ' (space=' + Math.round(spaceBelow2) + ')');
        }
    }

    // If we still don't have enough rows, interpolate the missing ones
    if (gridRows.length < targetLines && gridRows.length >= 2) {
        log('Interpolating ' + (targetLines - gridRows.length) + ' missing rows...');
        const topY = gridRows[0].y;
        const bottomY = gridRows[gridRows.length - 1].y;
        const avgHeight = (bottomY - topY) / (gridRows.length - 1);

        // Extrapolate upward if needed
        while (gridRows[0].y > avgHeight * 0.5 && gridRows.length < targetLines) {
            gridRows.unshift({ y: Math.max(0, Math.round(gridRows[0].y - avgHeight)) });
        }

        // Extrapolate downward if needed
        while (gridRows.length < targetLines) {
            const newY = Math.min(wh, gridRows[gridRows.length - 1].y + avgHeight);
            // Prevent adding duplicate lines at the bottom edge
            if (Math.abs(newY - gridRows[gridRows.length - 1].y) < avgHeight * 0.3) break;
            gridRows.push({ y: Math.round(newY) });
        }
    }
    
    // Final fallback: equal division
    if (gridRows.length < targetLines) {
        log('Fallback to equal division');
        const rows = [];
        const rowHeight = (wh * 0.95) / (targetLines - 1);
        for (let i = 0; i < targetLines; i++) {
            rows.push({ y: Math.round(wh * 0.02 + i * rowHeight) });
        }
        return rows;
    }
    
    var spaceBelow = wh - gridRows[gridRows.length - 1].y;
    log('Built ' + gridRows.length + ' lines: top=' + gridRows[0].y + ', bottom=' + gridRows[gridRows.length - 1].y + ', spaceBelow=' + Math.round(spaceBelow) + ' (wh=' + wh + ')');
    return gridRows;
}

/**
 * Measure the true horizontal extent of the grid by scanning row lines
 * in the horizontal Sobel image. Returns the consensus left/right edges.
 *
 * @param {cv.Mat} hSobel - Absolute horizontal Sobel (from detectRows)
 * @param {Array<number>} rowYs - Y positions of detected rows
 * @param {number} ww - Warped image width
 * @param {Function} log - Logging function
 * @returns {{leftEdge: number, rightEdge: number}}
 */
function measureGridWidth(hSobel, rowYs, ww, log) {
    log = log || console.log;
    if (!rowYs || rowYs.length < 3) {
        return { leftEdge: 0, rightEdge: ww };
    }

    var wh = hSobel.rows;
    var leftXs = [];
    var rightXs = [];
    var band = 2; // scan ±2 pixels around each row y

    for (var ri = 0; ri < rowYs.length; ri++) {
        var ry = rowYs[ri];
        if (ry < band || ry >= wh - band) continue;

        // Find max edge strength in this band
        var maxVal = 0;
        for (var dy = -band; dy <= band; dy++) {
            for (var x = 0; x < ww; x++) {
                var v = hSobel.ucharAt(ry + dy, x);
                if (v > maxVal) maxVal = v;
            }
        }
        if (maxVal < 10) continue; // skip weak rows

        var thresh = maxVal * 0.25;

        // Scan left-to-right for first pixel above threshold
        var foundLeft = -1;
        for (var x = 0; x < ww; x++) {
            for (var dy = -band; dy <= band; dy++) {
                if (hSobel.ucharAt(ry + dy, x) >= thresh) {
                    foundLeft = x;
                    break;
                }
            }
            if (foundLeft >= 0) break;
        }

        // Scan right-to-left for last pixel above threshold
        var foundRight = -1;
        for (var x = ww - 1; x >= 0; x--) {
            for (var dy = -band; dy <= band; dy++) {
                if (hSobel.ucharAt(ry + dy, x) >= thresh) {
                    foundRight = x;
                    break;
                }
            }
            if (foundRight >= 0) break;
        }

        if (foundLeft >= 0 && foundRight >= 0 && foundRight > foundLeft) {
            leftXs.push(foundLeft);
            rightXs.push(foundRight);
        }
    }

    if (leftXs.length < 3) {
        log('measureGridWidth: too few valid rows (' + leftXs.length + '), using full width');
        return { leftEdge: 0, rightEdge: ww };
    }

    // Use median for robustness
    leftXs.sort(function(a, b) { return a - b; });
    rightXs.sort(function(a, b) { return a - b; });
    var leftEdge = leftXs[Math.floor(leftXs.length / 2)];
    var rightEdge = rightXs[Math.floor(rightXs.length / 2)];

    log('measureGridWidth: measured ' + leftXs.length + ' rows → leftEdge=' + leftEdge + ', rightEdge=' + rightEdge + ' (ww=' + ww + ')');

    return { leftEdge: leftEdge, rightEdge: rightEdge };
}

// =============================================================================
// EXPORTS
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        detectRows,
        detectRowsFullWidth,
        detectLineSegments,
        measureGridWidth,
        interpolateRows,
        buildGridFromBottom
    };
}
