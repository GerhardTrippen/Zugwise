// =============================================================================
// GRID-UNSPLIT.JS — Pre-split anchor detection for dual-sheet images
// =============================================================================
//
// When two scoresheets are scanned side-by-side into one image, today's
// pipeline splits at an ink-valley midpoint and runs anchor detection on
// each half independently. That can fail when:
//   - the split point is off (lops a number column)
//   - the leftmost number column is cut off at the page edge
//   - one column slope/start disagrees with the other (header noise)
//
// This module runs anchor detection on the UNSPLIT image with the combined
// expected column count (page1.cols + page2.cols), derives the split midpoint
// from the largest x-gap between sheet clusters, and applies two sanity
// cross-checks before accepting the result:
//   * row-slope check (rows should be horizontal across columns — catches
//     header-noise misalignment that produces a 45°-tilted "row line")
//   * column-spacing check (the seam between sheets should be the widest
//     gap, and within-sheet spacings should be roughly uniform — catches
//     cases where the right count of columns is detected but at the wrong
//     X positions, e.g., one column missed and another spurious)
//
// SlideGrid is invoked with anchorsOnly:true so we skip the hole-alignment
// phase. That phase assumes a single sheet (col k starts at move k*rows+1),
// which is wrong for unsplit dual-sheets where both halves restart at 1 —
// the alignment errors cascade into garbled row Ys and break our slope check.
// With anchorsOnly we operate on raw CC positions per column, which are
// alignment-independent.
//
// Public API:
//   GridUnsplit.detectMidpoint(srcMat, profilePage1, profilePage2, opts)
//     → { midpoint, leftCols, rightCols, inferredLeftColumn,
//         pageSlopeDeg, maxSlopeDeviationDeg, slopeWarn, failureReason }
//
// Caller (Phase 4) is responsible for falling back to the legacy ink-valley
// split when failureReason is non-null.
//
// Dependencies: window.SlideGrid (grid-slide.js)
// Export: window.GridUnsplit
// =============================================================================

(function() {
'use strict';

function colsFromFormat(format) {
    if (format === '3col') return 3;
    return 2;
}

function totalToFormat(n) {
    if (n === 6) return '6col';
    if (n === 5) return '5col';
    if (n === 4) return '4col';
    return null;
}

function median(arr) {
    if (!arr || arr.length === 0) return 0;
    var sorted = arr.slice().sort(function(a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
}

// Discard the cell mats from a SlideGrid result — we only want colR.
// Without this, every detection run leaks ~150 cv.Mat instances.
function releaseCells(result) {
    if (!result || !result.cells) return;
    for (var i = 0; i < result.cells.length; i++) {
        var cell = result.cells[i];
        if (cell && cell.image && typeof cell.image.delete === 'function') {
            try { cell.image.delete(); } catch (e) { /* already deleted */ }
        }
    }
    result.cells = null;
}

// Spacing sanity: the seam between the two sheets should be the WIDEST gap,
// and within-sheet column spacings should be roughly uniform. Catches the
// case where processScoresheet returned the right count of columns but at
// the wrong X-positions (e.g., missed an anchor column on one sheet and
// picked up a spurious one on the other), which would make a naive
// index-based 2+2 split land inside a sheet instead of between sheets.
function checkColumnSpacing(colXs, leftColCount, log) {
    var n = colXs.length;
    if (n < 2) {
        return { ok: false, reason: 'too few columns for spacing check' };
    }

    var spacings = [];
    for (var i = 1; i < n; i++) spacings.push(colXs[i] - colXs[i - 1]);

    var seamIdx = leftColCount - 1;
    if (seamIdx < 0 || seamIdx >= spacings.length) {
        return { ok: false, reason: 'invalid seam index ' + seamIdx };
    }

    var seamSpacing = spacings[seamIdx];
    var within = [];
    for (var s = 0; s < spacings.length; s++) {
        if (s !== seamIdx) within.push(spacings[s]);
    }

    // 1+1 case: only one spacing exists, which IS the seam. No within-sheet
    // comparison possible — accept.
    if (within.length === 0) {
        return { ok: true, seamSpacing: seamSpacing, maxWithin: 0, minWithin: 0 };
    }

    var maxW = Math.max.apply(null, within);
    var minW = Math.min.apply(null, within);

    var WITHIN_MAX_RATIO = 2.0;

    // The seam must be the widest gap — i.e., the spacing at the expected
    // seam index must be at least as wide as every within-sheet spacing.
    // No "much wider" margin: tightly-packed dual sheets (Scarborough's
    // sheets sit nearly edge-to-edge with seam ~1.3x within-sheet) are
    // legitimate geometry. The B8_broken regression case still gets caught
    // because there the seam landed at the WRONG index — a within-sheet
    // gap was wider than the supposed seam.
    if (seamSpacing < maxW) {
        return {
            ok: false,
            reason: 'seam (' + Math.round(seamSpacing) + 'px) is narrower than '
                + 'widest within-sheet (' + Math.round(maxW) + 'px) — likely a '
                + 'cluster was missed or mis-grouped',
            seamSpacing: seamSpacing, maxWithin: maxW, minWithin: minW
        };
    }

    if (minW > 0 && maxW > minW * WITHIN_MAX_RATIO) {
        return {
            ok: false,
            reason: 'within-sheet spacings vary too much: max=' + Math.round(maxW)
                + ' min=' + Math.round(minW) + 'px (ratio '
                + (maxW / minW).toFixed(2) + ' > ' + WITHIN_MAX_RATIO + ')',
            seamSpacing: seamSpacing, maxWithin: maxW, minWithin: minW
        };
    }

    // Upper bound on the seam: a seam much WIDER than the within-sheet column
    // spacing means a whole column likely sits hidden inside the gap — i.e.,
    // each sheet has MORE columns than the selected Format claims (e.g. a
    // 3-col scoresheet detected as 2-col). The number columns that ARE found
    // look evenly spaced, the count matches, and the seam is the widest gap —
    // so every other check passes — yet the seam was placed straight across a
    // real (often narrow, sparse-ink) column, slicing it off. A genuine
    // sheet-to-sheet seam is only modestly wider than within-sheet spacing
    // (~1.3x for edge-to-edge sheets); ~2x means two within-sheet gaps with an
    // undetected column between them. This is the "rightmost column is much
    // narrower / got cut off" failure surfaced as a hard reject so the caller
    // falls back instead of confidently mis-splitting.
    var medWithinSp = median(within);
    var SEAM_MAX_RATIO = 1.6;
    if (medWithinSp > 0 && seamSpacing > medWithinSp * SEAM_MAX_RATIO) {
        var seamRatio = seamSpacing / medWithinSp;
        return {
            ok: false,
            reason: 'seam (' + Math.round(seamSpacing) + 'px) is ' + seamRatio.toFixed(1)
                + 'x the within-sheet spacing (' + Math.round(medWithinSp) + 'px) — a column '
                + 'is likely hidden inside the gap; the sheet probably has more columns per '
                + 'side than the selected Format (e.g. a 3-col sheet read as 2-col)',
            seamSpacing: seamSpacing, maxWithin: maxW, minWithin: minW
        };
    }

    return { ok: true, seamSpacing: seamSpacing, maxWithin: maxW, minWithin: minW };
}

// Slope cross-check using raw CC Y-positions per column (anchorsOnly mode).
// Rows should be horizontal across columns. For each pair of adjacent columns,
// match each CC's Y to the nearest CC in the other column (by Y-proximity)
// and compute slope dy/dx between matched pairs. All observed slopes should
// cluster around the page tilt (typically <0.5° for scans). A column whose
// CCs disagree with its neighbors — e.g., header noise inflating the count
// or hole-alignment errors shifting row Ys — produces a steep slope.
//
// Operating on raw CCs (instead of post-alignment row Ys) sidesteps the
// hole-alignment errors that occur when SlideGrid is given an unsplit
// dual-sheet image: each sheet restarts at move 1 but the alignment thinks
// later columns should start at higher move numbers, which scrambles row Ys.
function checkSlopeConsistencyFromCCs(anchorCols, log) {
    var n = anchorCols.length;
    if (n < 2) {
        return { pageSlopeDeg: 0, maxDevDeg: 0, severe: false, reason: 'too few columns' };
    }

    // Estimate Y-tolerance from median row spacing within the densest column.
    // Use ~60% of typical inter-CC spacing so we don't match across rows.
    var refCol = anchorCols[0];
    for (var c = 1; c < n; c++) {
        if (anchorCols[c].cys.length > refCol.cys.length) refCol = anchorCols[c];
    }
    var refSpacings = [];
    for (var s = 1; s < refCol.cys.length; s++) refSpacings.push(refCol.cys[s] - refCol.cys[s - 1]);
    refSpacings.sort(function(a, b) { return a - b; });
    var medRowSpacing = refSpacings.length
        ? refSpacings[Math.floor(refSpacings.length / 2)] : 16;
    var yTol = Math.max(8, medRowSpacing * 0.6);

    var allSlopes = [];
    var perPair = [];
    for (var k = 1; k < n; k++) {
        var colA = anchorCols[k - 1];
        var colB = anchorCols[k];
        var dx = colB.cx - colA.cx;
        if (Math.abs(dx) < 1) continue;

        for (var i = 0; i < colA.cys.length; i++) {
            var yA = colA.cys[i];
            var bestB = null;
            var bestDist = Infinity;
            for (var j = 0; j < colB.cys.length; j++) {
                var dist = Math.abs(colB.cys[j] - yA);
                if (dist < bestDist) { bestDist = dist; bestB = colB.cys[j]; }
            }
            if (bestB === null || bestDist > yTol) continue;
            var slope = (bestB - yA) / dx;
            allSlopes.push(slope);
            perPair.push({ leftCol: k - 1, rightCol: k, yA: yA, yB: bestB, slope: slope });
        }
    }

    if (allSlopes.length === 0) {
        return { pageSlopeDeg: 0, maxDevDeg: 0, severe: false, reason: 'no slopes computed' };
    }

    var pageSlope = median(allSlopes);
    var pageSlopeDeg = Math.atan(pageSlope) * 180 / Math.PI;

    var maxDev = 0;
    var maxDevPair = null;
    for (var p = 0; p < perPair.length; p++) {
        var dev = Math.abs(perPair[p].slope - pageSlope);
        if (dev > maxDev) {
            maxDev = dev;
            maxDevPair = perPair[p];
        }
    }
    var maxDevDeg = Math.atan(maxDev) * 180 / Math.PI;

    var SEVERE_DEG = 10;
    var WARN_DEG = 2;
    var severe = maxDevDeg > SEVERE_DEG;
    var warn = !severe && maxDevDeg > WARN_DEG;

    if (log) {
        log('Slope check: page=' + pageSlopeDeg.toFixed(2) + '° maxDev=' + maxDevDeg.toFixed(2)
            + '° (' + perPair.length + ' matched-CC observations, yTol=' + Math.round(yTol) + 'px)'
            + (severe ? ' SEVERE' : (warn ? ' (warn)' : ' OK')));
        if ((severe || warn) && maxDevPair) {
            var devSlopeDeg = Math.atan(maxDevPair.slope) * 180 / Math.PI;
            log('  Worst pair: cols ' + maxDevPair.leftCol + '↔' + maxDevPair.rightCol
                + ' yA=' + Math.round(maxDevPair.yA) + ' yB=' + Math.round(maxDevPair.yB)
                + ' slope=' + devSlopeDeg.toFixed(2) + '°');
        }
    }

    return {
        pageSlopeDeg: pageSlopeDeg,
        maxDevDeg: maxDevDeg,
        maxDevPair: maxDevPair,
        severe: severe,
        warn: warn
    };
}

function detectMidpoint(srcMat, profilePage1, profilePage2, opts) {
    opts = opts || {};
    // Fallback log when no caller-provided fn. Honors window.GRID_VERBOSE_LOG
    // so direct invocations stay silent unless the flag is set.
    var log = opts.log || function(msg) {
        if (typeof window !== 'undefined' && window.GRID_VERBOSE_LOG) {
            console.log('[GridUnsplit] ' + msg);
        }
    };

    if (typeof window === 'undefined' || !window.SlideGrid || !window.SlideGrid.processScoresheet) {
        return { midpoint: null, failureReason: 'SlideGrid module not loaded' };
    }
    if (!profilePage1 || !profilePage2) {
        return { midpoint: null, failureReason: 'missing profile' };
    }

    var leftColCount = colsFromFormat(profilePage1.format);
    var rightColCount = colsFromFormat(profilePage2.format);
    var totalCols = leftColCount + rightColCount;
    var combinedFormat = totalToFormat(totalCols);
    if (!combinedFormat) {
        return { midpoint: null, failureReason: 'unsupported total column count: ' + totalCols };
    }

    var rowCount = profilePage1.rowCount || 20;

    log('Image ' + srcMat.cols + 'x' + srcMat.rows + ', expecting ' + totalCols + ' columns ('
        + leftColCount + ' left + ' + rightColCount + ' right), rowCount=' + rowCount
        + ', combinedFormat=' + combinedFormat);

    function runSlideGrid(formatStr, label) {
        var slideConfig = {
            format: formatStr,
            rowCount: rowCount,
            maxColWidthPct: 7,
            pageType: opts.pageType || 'front',
            anchorsOnly: true
        };
        try {
            var r = window.SlideGrid.processScoresheet(srcMat, slideConfig, function(msg) {
                log('[' + label + '] ' + msg);
            });
            releaseCells(r);  // no-op for anchorsOnly results (no .cells)
            return r;
        } catch (e) {
            log('[' + label + '] threw: ' + (e && e.message || e));
            return null;
        }
    }

    // First attempt: ask for the full expected column count.
    var result = runSlideGrid(combinedFormat, 'Slide');

    // Retry with one fewer column if the first attempt produced nothing.
    // This handles the cut-off-leftmost case (Hugh's Scarborough): when the
    // leftmost number column is clipped at the page edge, SlideGrid finds
    // only totalCols-1 clean clusters and fails to score the totalCols-pattern.
    // Asking for totalCols-1 succeeds; the missing column is inferred below.
    if (!result || !result.anchorCols || result.anchorCols.length === 0) {
        var retryFormat = totalToFormat(totalCols - 1);
        if (retryFormat && retryFormat !== combinedFormat) {
            log('First attempt with ' + combinedFormat + ' failed; retrying with '
                + retryFormat + ' (left column may be clipped)');
            result = runSlideGrid(retryFormat, 'SlideRetry');
        }
    }

    if (!result) {
        return { midpoint: null, failureReason: 'SlideGrid returned null' };
    }
    if (!result.anchorCols || result.anchorCols.length === 0) {
        return { midpoint: null, failureReason: 'no anchor columns detected' };
    }

    // anchorCols is sorted by cx (slideRunPipeline sorts before returning).
    var anchorCols = result.anchorCols;

    var slopeCheck = checkSlopeConsistencyFromCCs(anchorCols, log);
    if (slopeCheck.severe) {
        var pairInfo = slopeCheck.maxDevPair
            ? (' cols ' + slopeCheck.maxDevPair.leftCol + '↔' + slopeCheck.maxDevPair.rightCol)
            : '';
        return {
            midpoint: null,
            failureReason: 'severe slope inconsistency: ' + slopeCheck.maxDevDeg.toFixed(1)
                + '°' + pairInfo,
            pageSlopeDeg: slopeCheck.pageSlopeDeg,
            maxSlopeDeviationDeg: slopeCheck.maxDevDeg
        };
    }

    var colXs = anchorCols.map(function(a) { return a.cx; });
    log('Detected ' + colXs.length + ' columns at X = ['
        + colXs.map(function(x) { return Math.round(x); }).join(', ') + ']');

    var detected = colXs.length;
    var inferredLeftColumn = false;

    if (detected === totalCols - 1) {
        // One column short. Localize WHICH sheet lost the column instead of
        // blindly assuming it's the global leftmost. Two recoverable shapes:
        //   (a) LEFT sheet's outer (leftmost) column clipped at the page edge
        //       — Hugh's Scarborough cropped-page case.
        //   (b) RIGHT sheet's outer (rightmost) column obliterated by a
        //       signature — Oscar-vs-Shashwath moves 47-51. The move data is
        //       physically present, just not detectable as CCs, so it must be
        //       interpolated (NOT abandoned as "cropped too tight"). The
        //       on-page check below still rejects a genuinely cropped right
        //       column (inferred X past the image edge), preserving the
        //       original "lost data is user error" guard for that real case.
        // The missing END column always sits on the OUTER side of its sheet
        // (away from the seam); inner columns adjacent to the seam survive.
        var spacings = [];
        for (var si = 1; si < colXs.length; si++) spacings.push(colXs[si] - colXs[si - 1]);

        // The seam between the two sheets is the widest gap. It partitions the
        // detected columns into a left group and a right group, telling us
        // which sheet is short.
        var seamGapIdx = 0;
        for (var gi = 1; gi < spacings.length; gi++) {
            if (spacings[gi] > spacings[seamGapIdx]) seamGapIdx = gi;
        }
        var leftDetected = seamGapIdx + 1;
        var rightDetected = detected - leftDetected;

        // Within-sheet spacing: median of all gaps EXCEPT the seam (which is
        // wider and would skew the estimate upward).
        var withinSpacings = spacings.slice(0, seamGapIdx)
            .concat(spacings.slice(seamGapIdx + 1));
        var medSpacing = withinSpacings.length ? median(withinSpacings) : median(spacings);

        if (leftDetected === leftColCount - 1 && rightDetected === rightColCount) {
            // (a) Left sheet short its outer (leftmost) column.
            var inferredLX = colXs[0] - medSpacing;
            if (inferredLX < -medSpacing * 0.3) {
                return {
                    midpoint: null,
                    failureReason: 'left sheet short 1 col, inferred leftmost X='
                        + Math.round(inferredLX) + ' is too far off-page'
                        + ' (within-spacing=' + Math.round(medSpacing) + 'px)'
                };
            }
            colXs.unshift(Math.max(0, inferredLX));
            inferredLeftColumn = true;
            log('Extrapolated missing LEFT-sheet leftmost column at X='
                + Math.round(Math.max(0, inferredLX)) + ' (within-sheet spacing='
                + Math.round(medSpacing) + 'px from ' + withinSpacings.length + ' within-gaps)');
        } else if (rightDetected === rightColCount - 1 && leftDetected === leftColCount) {
            // (b) Right sheet short its outer (rightmost) column — signature
            // damage. Interpolate it just past the last detected column.
            var lastX = colXs[colXs.length - 1];
            var inferredRX = lastX + medSpacing;
            // On-page guard: a column inferred past the image edge IS the
            // "cropped photo too tight" case — genuinely lost, reject.
            if (inferredRX > srcMat.cols + medSpacing * 0.3) {
                return {
                    midpoint: null,
                    failureReason: 'right sheet short 1 col, inferred rightmost X='
                        + Math.round(inferredRX) + ' is past the image edge ('
                        + srcMat.cols + 'px) — likely cropped too tight, not recoverable'
                };
            }
            colXs.push(Math.min(srcMat.cols - 1, inferredRX));
            inferredLeftColumn = true;  // tells callers to trust anchors over clean per-half (col is damaged)
            log('Extrapolated missing RIGHT-sheet rightmost column at X='
                + Math.round(Math.min(srcMat.cols - 1, inferredRX)) + ' (within-sheet spacing='
                + Math.round(medSpacing) + 'px) — signature-damaged column, will be interpolated');
        } else {
            // Missing column is interior (a within-sheet gap ~2x the others)
            // or the layout is too ambiguous to localize. Try the interior
            // case; otherwise reject.
            var interiorIdx = -1;
            for (var wi = 0; wi < spacings.length; wi++) {
                if (wi === seamGapIdx) continue;
                if (medSpacing > 0 && spacings[wi] > medSpacing * 1.6) { interiorIdx = wi; break; }
            }
            if (interiorIdx >= 0) {
                var interX = colXs[interiorIdx] + medSpacing;
                colXs.splice(interiorIdx + 1, 0, interX);
                inferredLeftColumn = true;
                log('Inserted missing interior column at X=' + Math.round(interX)
                    + ' (gap ' + Math.round(spacings[interiorIdx]) + 'px ~2x within-spacing '
                    + Math.round(medSpacing) + 'px)');
            } else {
                return {
                    midpoint: null,
                    failureReason: 'count short by 1 but could not localize the missing column'
                        + ' (left=' + leftDetected + ' right=' + rightDetected + ' detected, expected '
                        + leftColCount + '+' + rightColCount + ')'
                };
            }
        }
    } else if (detected !== totalCols) {
        return {
            midpoint: null,
            failureReason: 'detected ' + detected + ' columns, expected ' + totalCols
        };
    }

    var spacingCheck = checkColumnSpacing(colXs, leftColCount, log);
    log('Spacing: seam=' + Math.round(spacingCheck.seamSpacing || 0)
        + ' maxWithin=' + Math.round(spacingCheck.maxWithin || 0)
        + ' minWithin=' + Math.round(spacingCheck.minWithin || 0)
        + (spacingCheck.ok ? ' OK' : ' BAD'));
    if (!spacingCheck.ok) {
        return {
            midpoint: null,
            failureReason: 'column spacing: ' + spacingCheck.reason,
            pageSlopeDeg: slopeCheck.pageSlopeDeg,
            maxSlopeDeviationDeg: slopeCheck.maxDevDeg,
            seamSpacing: spacingCheck.seamSpacing,
            maxWithinSpacing: spacingCheck.maxWithin
        };
    }

    var leftSet = colXs.slice(0, leftColCount);
    var rightSet = colXs.slice(leftColCount);

    // Midpoint of the inter-sheet gap. The naive (last_left + first_right)/2
    // averages the boundary number columns — but the rightmost num column of
    // sheet 1 is NOT at sheet 1's right edge: another full column-pair (W
    // and B move columns) extends past it by ~one within-spacing. So that
    // midpoint plops the cut deep inside sheet 1's last column-pair, often
    // through Black's moves. Especially severe for 2col layouts where each
    // num column is followed by a wide W+B span.
    //
    // Better: estimate sheet 1's right edge as last_left_num + within_spacing,
    // and sheet 2's left edge as first_right_num - first_left_num (mirror
    // sheet 1's left margin). Midpoint of those two bounds.
    var midSpacings = [];
    for (var msi = 1; msi < colXs.length; msi++) midSpacings.push(colXs[msi] - colXs[msi - 1]);
    var midSeamIdx = leftColCount - 1;
    var midWithin = [];
    for (var mwi = 0; mwi < midSpacings.length; mwi++) {
        if (mwi !== midSeamIdx) midWithin.push(midSpacings[mwi]);
    }
    var medWithin = midWithin.length ? median(midWithin) : 0;

    var firstLeftNum = leftSet[0];
    var lastLeftNum = leftSet[leftSet.length - 1];
    var firstRightNum = rightSet[0];
    var sheet1End = lastLeftNum + medWithin;
    var sheet2Start = firstRightNum - firstLeftNum;
    var midpoint = Math.round((sheet1End + sheet2Start) / 2);

    log('Sheet split: left X=[' + leftSet.map(function(x) { return Math.round(x); }).join(',')
        + '] right X=[' + rightSet.map(function(x) { return Math.round(x); }).join(',')
        + '] sheet1End=' + Math.round(sheet1End)
        + ' sheet2Start=' + Math.round(sheet2Start)
        + ' midpoint=' + midpoint);

    // Per-half anchor positions in each half's local coordinate system.
    // Left half spans [0, midpoint] in original coords → no offset needed.
    // Right half spans [midpoint, width] in original coords → subtract midpoint.
    var leftHalfAnchorXs = leftSet.slice();
    var rightHalfAnchorXs = rightSet.map(function(x) { return x - midpoint; });

    return {
        midpoint: midpoint,
        leftCols: leftSet,
        rightCols: rightSet,
        leftHalfAnchorXs: leftHalfAnchorXs,
        rightHalfAnchorXs: rightHalfAnchorXs,
        inferredLeftColumn: inferredLeftColumn,
        pageSlopeDeg: slopeCheck.pageSlopeDeg,
        maxSlopeDeviationDeg: slopeCheck.maxDevDeg,
        slopeWarn: slopeCheck.warn,
        failureReason: null
    };
}

if (typeof window !== 'undefined') {
    window.GridUnsplit = {
        detectMidpoint: detectMidpoint
    };
}

})();
