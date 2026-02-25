// =============================================================================
// GRID-DETECTION.JS - Main orchestration for grid detection
// =============================================================================
// Part of Zugwise Grid Detection v34
// 
// Dependencies: 
//   - OpenCV.js (cv global)
//   - grid-geometry.js (orderPoints, fourPointTransform, checkContourDistortion, mapWarpedToOriginal)
//   - grid-columns.js (detectColumns, findBestColumnCombination)
//   - grid-rows.js (detectRows, buildGridFromBottom, interpolateRows)
//
// Main entry points:
//   - runDetection(srcMat, config, log) - Auto-detect with format selection
//   - runDetectionWithCorners(srcMat, corners, config, log) - Manual corner mode
// =============================================================================

/**
 * Get configuration from format settings
 * @param {number} rowCount - Moves per column (20, 25, or 30)
 * @param {string} format - '2col' or '3col'
 * @returns {Object} - Full configuration object
 */
function getGridConfig(rowCount, format) {
    return {
        rowCount: rowCount,
        format: format,
        expectedCols: format === '2col' ? 7 : 10,
        internalDividers: format === '2col' ? 5 : 8
    };
}

/**
 * Find grid contour in image
 * @param {cv.Mat} srcMat - Source image (RGBA)
 * @param {Function} log - Logging function
 * @returns {Object} - {corners, needsCropHack, display} or null
 */
function findGridContour(srcMat, log) {
    log = log || console.log;
    const h = srcMat.rows, w = srcMat.cols;
    
    // Convert to grayscale
    const gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    
    // Edge detection
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const dilated = new cv.Mat();
    cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 2);
    
    // Find contours
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(dilated, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    
    log('Total contours found: ' + contours.size());
    
    // Analyze all contours
    const allContours = [];
    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        const peri = cv.arcLength(cnt, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
        const rect = cv.minAreaRect(cnt);
        const rectArea = rect.size.width * rect.size.height;
        
        allContours.push({
            index: i,
            area: area,
            areaPercent: (area / w / h * 100).toFixed(2),
            approxPoints: approx.rows,
            minAreaRect: rect,
            minAreaRectPercent: (rectArea / w / h * 100).toFixed(2)
        });
        approx.delete();
    }
    
    allContours.sort((a, b) => b.area - a.area);
    
    let result = null;
    
    // Check if largest contour is usable (>15% of image)
    if (allContours.length > 0 && parseFloat(allContours[0].minAreaRectPercent) > 15) {
        const largest = allContours[0];
        
        if (largest.approxPoints === 4) {
            // Clean 4-point quad - no crop hack needed
            log('Found clean 4-point quad (' + largest.areaPercent + '%)');
            const cnt = contours.get(largest.index);
            const peri = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
            
            const corners = [];
            for (let j = 0; j < 4; j++) {
                corners.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
            }
            approx.delete();
            
            result = { corners, needsCropHack: false };
        } else {
            // 5+ point contour (grid+header) - use minAreaRect and crop hack
            log('Found ' + largest.approxPoints + '-point contour (' + largest.areaPercent + '%) - will apply crop hack');
            const rect = largest.minAreaRect;
            const vertices = cv.RotatedRect.points(rect);
            
            const corners = [];
            for (let i = 0; i < 4; i++) {
                corners.push({ x: vertices[i].x, y: vertices[i].y });
            }
            
            result = { corners, needsCropHack: true };
        }
    }
    
    // Cleanup
    gray.delete();
    blurred.delete();
    edges.delete();
    kernel.delete();
    dilated.delete();
    contours.delete();
    hier.delete();
    
    return result;
}

/**
 * Run hybrid detection (no deskew) for thumb-distorted images
 * Maps warped coordinates back to original image space
 * 
 * @param {cv.Mat} image - Original source image
 * @param {Array<{x,y}>} contourCorners - Original 4 corners
 * @param {Array<number>} warpedColBoundaries - Column boundaries in warped space
 * @param {number} warpedW - Warped width
 * @param {number} warpedH - Warped height
 * @param {Object} config - Grid configuration
 * @param {Function} log - Logging function
 * @returns {Object} - {columns, rows} in original image coordinates
 */
function runHybridDetection(image, contourCorners, warpedColBoundaries, warpedW, warpedH, config, log) {
    log = log || console.log;
    log('HYBRID MODE: No deskew (thumb distortion detected)');
    
    const [tl, tr, br, bl] = orderPoints(contourCorners);
    
    // Map column boundaries back to original
    const mappedCols = warpedColBoundaries.map(wx => ({
        top: mapWarpedToOriginal(contourCorners, warpedW, warpedH, wx, 0),
        bot: mapWarpedToOriginal(contourCorners, warpedW, warpedH, wx, warpedH)
    }));
    
    // Use shorter edge for row height calculation (less distorted)
    const rightLen = Math.sqrt((br.x - tr.x) ** 2 + (br.y - tr.y) ** 2);
    const leftLen = Math.sqrt((bl.x - tl.x) ** 2 + (bl.y - tl.y) ** 2);
    const edgeLen = Math.min(rightLen, leftLen);
    const scale = edgeLen / warpedH;
    const rowH = (warpedH / (config.rowCount + 1)) * scale;
    
    // Use direction from shorter (less distorted) edge
    const downX = leftLen < rightLen ? (bl.x - tl.x) / leftLen : (br.x - tr.x) / rightLen;
    const downY = leftLen < rightLen ? (bl.y - tl.y) / leftLen : (br.y - tr.y) / rightLen;
    
    // Generate row lines
    const gridRows = [];
    for (let i = 0; i < config.rowCount + 2; i++) {
        gridRows.push({
            leftX: tl.x + i * rowH * downX,
            leftY: tl.y + i * rowH * downY,
            rightX: tr.x + i * rowH * downX,
            rightY: tr.y + i * rowH * downY
        });
    }
    
    log('Columns: ' + mappedCols.length + ', Rows: ' + (gridRows.length - 1));
    
    return { columns: mappedCols, rows: gridRows, mode: 'hybrid' };
}

/**
 * Run fallback detection directly on original image (no perspective correction)
 * 
 * @param {cv.Mat} image - Source image
 * @param {Object} config - Grid configuration
 * @param {Function} log - Logging function
 * @returns {Object} - {columnBoundaries, rowCandidates}
 */
function runFallbackDetection(image, config, log) {
    log = log || console.log;
    log('[BRANCH] fallback');
    log('FALLBACK: Direct detection on original image');
    
    const h = image.rows, w = image.cols;
    const gray = new cv.Mat();
    cv.cvtColor(image, gray, cv.COLOR_RGBA2GRAY);
    
    // Column detection (same algorithm as detectColumns but on full image)
    const sobelX = new cv.Mat();
    cv.Sobel(gray, sobelX, cv.CV_16S, 1, 0, 3);
    const absSobelX = new cv.Mat();
    cv.convertScaleAbs(sobelX, absSobelX);
    
    const colSums = new Array(w).fill(0);
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            colSums[x] += absSobelX.ucharAt(y, x);
        }
    }
    
    const radius = 5;
    const smoothedCols = new Array(w).fill(0);
    for (let x = radius; x < w - radius; x++) {
        let sum = 0;
        for (let dx = -radius; dx <= radius; dx++) {
            sum += colSums[x + dx];
        }
        smoothedCols[x] = sum / (radius * 2 + 1);
    }
    
    const maxColSum = Math.max(...smoothedCols);
    const edgeMargin = Math.round(w * 0.04);
    const colThreshold = maxColSum * 0.15;
    
    const colPeaks = [];
    for (let x = edgeMargin; x < w - edgeMargin; x++) {
        let isMax = true;
        for (let dx = -10; dx <= 10; dx++) {
            if (dx !== 0 && smoothedCols[x + dx] > smoothedCols[x]) {
                isMax = false;
                break;
            }
        }
        if (isMax && smoothedCols[x] > colThreshold) {
            colPeaks.push({ x: x, score: smoothedCols[x] });
        }
    }
    
    const minColGap = w * 0.03;
    const clusteredCols = [];
    colPeaks.sort((a, b) => a.x - b.x);
    for (const p of colPeaks) {
        if (clusteredCols.length === 0 || p.x - clusteredCols[clusteredCols.length - 1].x > minColGap) {
            clusteredCols.push(p);
        } else if (p.score > clusteredCols[clusteredCols.length - 1].score) {
            clusteredCols[clusteredCols.length - 1] = p;
        }
    }
    
    let columnBoundaries;
    const colResult = findBestColumnCombination(clusteredCols, config, w);
    if (colResult.valid) {
        columnBoundaries = colResult.cols.map(c => c.x);
        log('Pattern validated (with 0/w edges)');
    } else {
        // Second attempt: try all C(n,7) combinations WITHOUT forcing 0/w as edges
        // In fallback mode (no warp), the grid may not span the full image
        log('Pattern failed with 0/w edges (' + clusteredCols.length + ' candidates), trying free-boundary search...');
        let bestCols = null, bestScore = Infinity;
        const sortedCandidates = [...clusteredCols].sort((a, b) => a.x - b.x);
        // Limit to top candidates by score to keep combinatorics manageable
        const topCandidates = sortedCandidates.length <= 20
            ? sortedCandidates
            : [...clusteredCols].sort((a, b) => b.score - a.score).slice(0, 15).sort((a, b) => a.x - b.x);
        if (topCandidates.length >= config.expectedCols) {
            const combos7 = getCombinations(topCandidates, config.expectedCols);
            for (const combo of combos7) {
                const score = scoreColumnPattern(combo, config, w);
                if (score < bestScore) {
                    bestScore = score;
                    bestCols = combo;
                }
            }
        }
        if (bestCols && bestScore < Infinity) {
            columnBoundaries = bestCols.map(c => c.x);
            log('Free-boundary pattern found (score=' + bestScore.toFixed(6) + ')');
        } else {
            // Both pattern searches failed - signal failure so corner picker triggers
            log('Column pattern detection FAILED - manual corners needed');

            // Cleanup before early return
            gray.delete();
            sobelX.delete();
            absSobelX.delete();

            return { columnBoundaries: null, gridRows: null, warped: null, contourCorners: null, mode: 'fallback-failed' };
        }
    }
    // Log column widths for debugging
    var colWidths = [];
    var colLabels = config.format === '2col'
        ? ['#1', 'W1', 'B1', '#2', 'W2', 'B2']
        : ['#1', 'W1', 'B1', '#2', 'W2', 'B2', '#3', 'W3', 'B3'];
    for (var ci = 0; ci < columnBoundaries.length - 1; ci++) {
        var cw = columnBoundaries[ci + 1] - columnBoundaries[ci];
        var pct = (cw / w * 100).toFixed(1);
        var label = ci < colLabels.length ? colLabels[ci] : '?';
        colWidths.push(label + ':' + cw + 'px(' + pct + '%)');
    }
    log('Columns: ' + columnBoundaries.length + ' boundaries at [' + columnBoundaries.join(', ') + ']');
    log('Column widths: ' + colWidths.join(' | '));
    
    // Row detection
    const sobelY = new cv.Mat();
    cv.Sobel(gray, sobelY, cv.CV_16S, 0, 1, 3);
    const absSobelY = new cv.Mat();
    cv.convertScaleAbs(sobelY, absSobelY);
    
    const rowSums = new Array(h).fill(0);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            rowSums[y] += absSobelY.ucharAt(y, x);
        }
    }
    
    const smoothedRows = new Array(h).fill(0);
    for (let y = radius; y < h - radius; y++) {
        let sum = 0;
        for (let dy = -radius; dy <= radius; dy++) {
            sum += rowSums[y + dy];
        }
        smoothedRows[y] = sum / (radius * 2 + 1);
    }
    
    const maxRowSum = Math.max(...smoothedRows);
    const rowThreshold = maxRowSum * 0.20;
    
    const rowPeaks = [];
    for (let y = 10; y < h - 10; y++) {
        let isMax = true;
        for (let dy = -8; dy <= 8; dy++) {
            if (dy !== 0 && smoothedRows[y + dy] > smoothedRows[y]) {
                isMax = false;
                break;
            }
        }
        if (isMax && smoothedRows[y] > rowThreshold) {
            rowPeaks.push({ y: y, score: smoothedRows[y] });
        }
    }
    
    const expectedRowH = h / (config.rowCount + 3);
    const minRowGap = expectedRowH * 0.4;
    const clusteredRows = [];
    rowPeaks.sort((a, b) => a.y - b.y);
    for (const p of rowPeaks) {
        if (clusteredRows.length === 0 || p.y - clusteredRows[clusteredRows.length - 1].y > minRowGap) {
            clusteredRows.push(p);
        } else if (p.score > clusteredRows[clusteredRows.length - 1].score) {
            clusteredRows[clusteredRows.length - 1] = p;
        }
    }
    log('Rows: ' + clusteredRows.length);
    
    // Cleanup
    gray.delete();
    sobelX.delete();
    absSobelX.delete();
    sobelY.delete();
    absSobelY.delete();
    
    // Build proper gridRows from candidates
    let gridRows = buildGridFromBottom(clusteredRows, h, config, log);
    if (!gridRows || gridRows.length < config.rowCount + 2) {
        const topY = clusteredRows.length > 0 ? clusteredRows[0].y : 0;
        const botY = clusteredRows.length > 0 ? clusteredRows[clusteredRows.length - 1].y : h;
        gridRows = interpolateRows(topY, botY, config);
    }

    return { columnBoundaries, gridRows, warped: null, contourCorners: null, mode: 'fallback' };
}

/**
 * Main detection for 3-column format
 * Handles the crop hack for 5+ point contours (grid+header)
 * 
 * @param {cv.Mat} srcMat - Source image
 * @param {Object} config - Grid configuration
 * @param {Function} log - Logging function
 * @returns {Object} - Detection result
 */
function runDetection3Col(srcMat, config, log) {
    log = log || console.log;
    
    const contourResult = findGridContour(srcMat, log);
    
    if (!contourResult) {
        log('No suitable contour found - using FALLBACK');
        return runFallbackDetection(srcMat, config, log);
    }
    
    const { corners: bestContour, needsCropHack } = contourResult;
    
    // Warp to rectangle
    const warped = fourPointTransform(srcMat, bestContour);
    const ww = warped.cols, wh = warped.rows;
    log('Warped: ' + ww + 'x' + wh);
    
    const warpGray = new cv.Mat();
    cv.cvtColor(warped, warpGray, cv.COLOR_RGBA2GRAY);
    
    const colResult = detectColumns(warpGray, ww, wh, config, log);
    const rowResult = detectRows(warpGray, colResult.columnBoundaries, ww, wh, config, log);
    const detectedRows = rowResult.peaks;

    // Measure true grid width from row line extent
    var gridExtent3 = measureGridWidth(rowResult.hSobel, detectedRows.map(function(r) { return r.y; }), ww, log);
    rowResult.hSobel.delete();

    // Re-detect columns if grid is narrower than contour
    if (gridExtent3.leftEdge > ww * 0.02 || gridExtent3.rightEdge < ww * 0.98) {
        log('Grid width correction (3col): left=' + gridExtent3.leftEdge + ', right=' + gridExtent3.rightEdge + ' (ww=' + ww + ')');
        var correctedColResult3 = detectColumns(warpGray, ww, wh, config, log, gridExtent3.leftEdge, gridExtent3.rightEdge);
        if (correctedColResult3.patternValid) {
            colResult.columnBoundaries = correctedColResult3.columnBoundaries;
            colResult.patternValid = correctedColResult3.patternValid;
            log('Column boundaries corrected with measured grid width (3col)');
        } else {
            log('Corrected column detection failed (3col), keeping original');
        }
    }

    let result;

    if (needsCropHack) {
        log('[BRANCH] 3col-crop');
        log('Applying crop hack (header included in contour)');
        const gridRows = buildGridFromBottom(detectedRows, wh, config, log);
        
        // Crop from first row to below last row
        const topY = gridRows[0].y;
        const avgRowHeight = (gridRows[gridRows.length - 1].y - gridRows[0].y) / (gridRows.length - 1);
        const bottomY = Math.min(wh, gridRows[gridRows.length - 1].y + Math.round(avgRowHeight));
        const cropH = bottomY - topY;
        log('Cropping: y=' + topY + ' to ' + bottomY);
        
        // Adjust row positions for cropped image
        const adjustedRows = gridRows.map(r => ({ y: r.y - topY }));
        
        result = {
            columnBoundaries: colResult.columnBoundaries,
            gridRows: adjustedRows,
            cropRegion: { topY, bottomY, cropH },
            warped,
            mode: '3col-crop'
        };
    } else {
        log('[BRANCH] 3col-clean');
        let gridRows = buildGridFromBottom(detectedRows, wh, config, log);

        if (!gridRows || gridRows.length < config.rowCount + 2) {
            log('Bottom-up detection failed, using interpolation fallback');
            const topY = detectedRows.length > 0 
                ? Math.min(...detectedRows.filter(c => c.y < wh * 0.15).map(c => c.y)) || 0 
                : 0;
            const botY = detectedRows.length > 0 
                ? Math.max(...detectedRows.filter(c => c.y > wh * 0.85).map(c => c.y)) || wh 
                : wh;
            gridRows = interpolateRows(topY, botY, config);
        }
        
        result = {
            columnBoundaries: colResult.columnBoundaries,
            gridRows,
            warped,
            mode: '3col-clean'
        };
    }
    
    // Cleanup
    warpGray.delete();
    // Note: caller must delete warped when done!
    
    log('Columns: ' + result.columnBoundaries.length + ', Rows: ' + (result.gridRows.length - 1));
    if (result.columnBoundaries.length === config.expectedCols && result.gridRows.length === config.rowCount + 2) {
        log('SUCCESS (' + result.mode + ')');
    }
    
    return result;
}

/**
 * Run detection for horizontal-lines-only scoresheets.
 * No vertical line detection — column boundaries are inferred from
 * horizontal line segment gaps or standard ratios.
 *
 * @param {cv.Mat} warpGray - Grayscale warped grid image
 * @param {number} ww - Warped width
 * @param {number} wh - Warped height
 * @param {Object} config - Grid configuration (with gridType === 'horizontal-lines')
 * @param {Function} log - Logging function
 * @returns {Object} - {columnBoundaries, gridRows, mode}
 */
function runDetectionHorizontalOnly(warpGray, ww, wh, config, log) {
    log = log || console.log;
    log('Horizontal-lines-only mode: detecting rows full-width...');

    // Step 1: Detect rows across full image width
    var rowResult = detectRowsFullWidth(warpGray, ww, wh, config, log);
    var rowPeaks = rowResult.peaks;
    log('Row candidates: ' + rowPeaks.length);

    // Step 2: Detect line segments per row
    var segments = detectLineSegments(rowResult.hSobel, rowPeaks, ww, log);

    // Step 3: Measure grid width from row line extent
    var gridExtent = measureGridWidth(rowResult.hSobel, rowPeaks.map(function(r) { return r.y; }), ww, log);
    rowResult.hSobel.delete();

    // Step 4: Infer column boundaries from segments
    var colResult = inferColumnsFromSegments(segments, ww, config, log);

    if (!colResult.valid || !colResult.columnBoundaries) {
        // Fallback: infer columns by ratio using measured grid extent
        log('Segment inference failed — using ratio fallback with grid extent');
        colResult = inferColumnsByRatio(gridExtent.leftEdge, gridExtent.rightEdge, config, log);
    }

    var columnBoundaries = colResult.columnBoundaries;

    // Step 5: Build grid rows from detected peaks
    var gridRows = buildGridFromBottom(rowPeaks, wh, config, log);

    if (!gridRows || gridRows.length < config.rowCount + 2) {
        log('Bottom-up row building failed, using interpolation fallback');
        var topY = rowPeaks.length > 0
            ? Math.min.apply(null, rowPeaks.filter(function(c) { return c.y < wh * 0.15; }).map(function(c) { return c.y; })) || 0
            : 0;
        var botY = rowPeaks.length > 0
            ? Math.max.apply(null, rowPeaks.filter(function(c) { return c.y > wh * 0.85; }).map(function(c) { return c.y; })) || wh
            : wh;
        gridRows = interpolateRows(topY, botY, config);
    }

    log('Horizontal-lines result: ' + columnBoundaries.length + ' cols, ' + gridRows.length + ' row lines');

    return {
        columnBoundaries: columnBoundaries,
        gridRows: gridRows,
        mode: 'horizontal-lines'
    };
}

/**
 * Main detection entry point
 * 
 * @param {cv.Mat} srcMat - Source image (RGBA)
 * @param {Object} config - {rowCount, format} or use getGridConfig()
 * @param {Function} log - Logging function
 * @returns {Object} - Detection result with columnBoundaries, gridRows, mode, etc.
 */
function runDetection(srcMat, config, log) {
    log = log || console.log;
    log('Running detection (' + config.rowCount + ' rows, ' + config.format + ')...');
    
    if (config.format === '3col') {
        return runDetection3Col(srcMat, config, log);
    }

    // Horizontal-lines-only path: find contour, warp, then use horizontal-only detection
    if (config.gridType === 'horizontal-lines') {
        log('[BRANCH] horizontal-lines-only');
        var hlContour = findGridContour(srcMat, log);
        if (!hlContour) {
            log('No contour found for horizontal-lines mode — using fallback');
            return runFallbackDetection(srcMat, config, log);
        }
        var hlWarped = fourPointTransform(srcMat, hlContour.corners);
        var hlWW = hlWarped.cols, hlWH = hlWarped.rows;
        var hlGray = new cv.Mat();
        cv.cvtColor(hlWarped, hlGray, cv.COLOR_RGBA2GRAY);

        var hlResult = runDetectionHorizontalOnly(hlGray, hlWW, hlWH, config, log);
        hlGray.delete();

        hlResult.warped = hlWarped;
        hlResult.contourCorners = hlContour.corners;
        log('Columns: ' + hlResult.columnBoundaries.length + ', Rows: ' + (hlResult.gridRows.length - 1));
        return hlResult;
    }

    // 2-column path
    const h = srcMat.rows, w = srcMat.cols;
    
    // Find contour (simplified for 2-col - expects clean 4-point quad)
    const gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const dilated = new cv.Mat();
    cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 2);
    
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(dilated, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    
    const quads = [];
    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
        if (approx.rows === 4 && area > 0.05 * w * h) {
            const corners = [];
            for (let j = 0; j < 4; j++) {
                corners.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
            }
            quads.push({ corners, area });
        }
        approx.delete();
    }
    quads.sort((a, b) => b.area - a.area);
    
    // Cleanup edge detection mats
    gray.delete();
    blurred.delete();
    edges.delete();
    kernel.delete();
    dilated.delete();
    contours.delete();
    hier.delete();
    
    let bestContour = null;
    if (quads.length > 0 && quads[0].area > 0.15 * w * h) {
        bestContour = quads[0].corners;
        log('Using contour (' + (quads[0].area / w / h * 100).toFixed(1) + '%)');
        log('Contour corners: ' + bestContour.map(function(c) { return '(' + c.x + ',' + c.y + ')'; }).join(' → '));
    }
    
    if (!bestContour) {
        log('No contour found');
        return runFallbackDetection(srcMat, config, log);
    }
    
    // Check for thumb distortion
    const distCheck = checkContourDistortion(bestContour);
    log('Angles: TL=' + distCheck.angleTL.toFixed(1) + ', TR=' + distCheck.angleTR.toFixed(1) +
        ', BR=' + distCheck.angleBR.toFixed(1) + ', BL=' + distCheck.angleBL.toFixed(1));
    
    if (distCheck.isDistorted) {
        log('Thumb distortion detected!');
    }
    
    // Warp to rectangle
    const warped = fourPointTransform(srcMat, bestContour);
    const ww = warped.cols, wh = warped.rows;
    log('Warped: ' + ww + 'x' + wh);
    
    const warpGray = new cv.Mat();
    cv.cvtColor(warped, warpGray, cv.COLOR_RGBA2GRAY);
    
    const colResult = detectColumns(warpGray, ww, wh, config, log);
    
    // If pattern invalid OR contour distorted, signal failure for corner picker
    if (!colResult.patternValid || distCheck.isDistorted) {
        log('[BRANCH] detection-failed: pattern invalid or distortion detected');
        warped.delete();
        warpGray.delete();
        return { columnBoundaries: null, gridRows: null, warped: null, contourCorners: bestContour, mode: 'detection-failed' };
    }

    log('[BRANCH] deskewed');

    const rowResult = detectRows(warpGray, colResult.columnBoundaries, ww, wh, config, log);
    const rowCandidates = rowResult.peaks;
    log('Row candidates (' + rowCandidates.length + '): ' + rowCandidates.map(function(r) { return r.y; }).join(', '));

    // Measure true grid width from row line extent
    var gridExtent = measureGridWidth(rowResult.hSobel, rowCandidates.map(function(r) { return r.y; }), ww, log);
    rowResult.hSobel.delete();

    // Re-detect columns if grid is narrower than contour
    if (gridExtent.leftEdge > ww * 0.02 || gridExtent.rightEdge < ww * 0.98) {
        log('Grid width correction: left=' + gridExtent.leftEdge + ', right=' + gridExtent.rightEdge + ' (ww=' + ww + ')');
        var correctedColResult = detectColumns(warpGray, ww, wh, config, log, gridExtent.leftEdge, gridExtent.rightEdge);
        if (correctedColResult.patternValid) {
            colResult.columnBoundaries = correctedColResult.columnBoundaries;
            colResult.patternValid = correctedColResult.patternValid;
            log('Column boundaries corrected with measured grid width');
        } else {
            log('Corrected column detection failed, keeping original');
        }
    }

    let gridRows = buildGridFromBottom(rowCandidates, wh, config, log);

    if (!gridRows || gridRows.length < config.rowCount + 2) {
        log('Bottom-up detection failed, using interpolation fallback');
        const topY = rowCandidates.length > 0
            ? Math.min(...rowCandidates.filter(c => c.y < wh * 0.15).map(c => c.y)) || 0
            : 0;
        const botY = rowCandidates.length > 0
            ? Math.max(...rowCandidates.filter(c => c.y > wh * 0.85).map(c => c.y)) || wh
            : wh;
        gridRows = interpolateRows(topY, botY, config);
    }

    warpGray.delete();
    
    const result = {
        columnBoundaries: colResult.columnBoundaries,
        gridRows,
        warped,
        contourCorners: bestContour,
        mode: 'deskewed'
    };
    
    log('Columns: ' + result.columnBoundaries.length + ', Rows: ' + (result.gridRows.length - 1));
    if (result.columnBoundaries.length === config.expectedCols && result.gridRows.length === config.rowCount + 2) {
        log('SUCCESS (deskewed)');
    }
    
    return result;
}

/**
 * Run detection with manually specified corners
 * 
 * @param {cv.Mat} srcMat - Source image
 * @param {Array<{x,y}>} corners - 4 manual corner points
 * @param {Object} config - Grid configuration
 * @param {Function} log - Logging function
 * @returns {Object} - Detection result
 */
function runDetectionWithCorners(srcMat, corners, config, log) {
    log = log || console.log;
    log('[BRANCH] manual corners');

    const warped = fourPointTransform(srcMat, corners);
    const ww = warped.cols, wh = warped.rows;

    const warpGray = new cv.Mat();
    cv.cvtColor(warped, warpGray, cv.COLOR_RGBA2GRAY);

    // Horizontal-lines-only path for manual corners
    if (config.gridType === 'horizontal-lines') {
        log('[BRANCH] manual corners + horizontal-lines-only');
        var hlManualResult = runDetectionHorizontalOnly(warpGray, ww, wh,
            Object.assign({}, config, { hasHeader: false }), log);
        warpGray.delete();

        // In manual mode, prefer interpolated rows (user-defined exact boundaries)
        var hlManualRows = interpolateRows(0, wh, Object.assign({}, config, { hasHeader: false }));
        log('Manual horizontal-lines: ' + hlManualRows.length + ' lines equally spaced');

        return {
            columnBoundaries: hlManualResult.columnBoundaries,
            gridRows: hlManualRows,
            warped: warped,
            contourCorners: corners,
            mode: 'manual-horizontal-lines'
        };
    }

    const colResult = detectColumns(warpGray, ww, wh, config, log);

    // Manual corners: user selects data area (no header), so target rowCount+1 lines
    var manualConfig = Object.assign({}, config, { hasHeader: false });
    const rowResult = detectRows(warpGray, colResult.columnBoundaries, ww, wh, manualConfig, log);
    const rowCandidates = rowResult.peaks;

    // Measure true grid width from row line extent
    var gridExtentManual = measureGridWidth(rowResult.hSobel, rowCandidates.map(function(r) { return r.y; }), ww, log);
    rowResult.hSobel.delete();

    // Re-detect columns if grid is narrower than contour
    if (gridExtentManual.leftEdge > ww * 0.02 || gridExtentManual.rightEdge < ww * 0.98) {
        log('Grid width correction (manual): left=' + gridExtentManual.leftEdge + ', right=' + gridExtentManual.rightEdge + ' (ww=' + ww + ')');
        var correctedColManual = detectColumns(warpGray, ww, wh, config, log, gridExtentManual.leftEdge, gridExtentManual.rightEdge);
        if (correctedColManual.patternValid) {
            colResult.columnBoundaries = correctedColManual.columnBoundaries;
            colResult.patternValid = correctedColManual.patternValid;
            log('Column boundaries corrected with measured grid width (manual)');
        } else {
            log('Corrected column detection failed (manual), keeping original');
        }
    }

    // Manual corners: user defined the exact grid boundaries, so rows span y=0 to y=wh
    // with equal spacing. Detection-based rows are unreliable (uneven gaps, false peaks).
    let gridRows = interpolateRows(0, wh, config);
    log('Manual mode: ' + gridRows.length + ' lines (' + (gridRows.length - 1) + ' rows) equally spaced from y=0 to y=' + wh +
        ' (rowHeight=' + Math.round(wh / (gridRows.length - 1)) + 'px)');

    warpGray.delete();

    log('Columns: ' + colResult.columnBoundaries.length + ', Rows: ' + (gridRows.length - 1) + ' (' + gridRows.length + ' lines)');

    return {
        columnBoundaries: colResult.columnBoundaries,
        gridRows,
        warped,
        contourCorners: corners,
        mode: 'manual'
    };
}

// =============================================================================
// EXPORTS
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getGridConfig,
        findGridContour,
        runDetection,
        runDetection3Col,
        runDetectionWithCorners,
        runDetectionHorizontalOnly,
        runHybridDetection,
        runFallbackDetection
    };
}
