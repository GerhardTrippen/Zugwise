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

    // Per-column CC detail for diagnostics: a REAL number column has ~rowCount
    // components spanning the full sheet height; a noise/partial artifact has
    // few CCs or a short span. Surfaced on failure so we can tell whether the
    // robust detector found clean columns (→ seam math is the bug) or junk
    // (→ the detection is the bug).
    var colDetail = anchorCols.map(function(a) {
        var cys = a.cys || [];
        var y0 = Infinity, y1 = -Infinity;
        for (var ci = 0; ci < cys.length; ci++) {
            if (cys[ci] < y0) y0 = cys[ci];
            if (cys[ci] > y1) y1 = cys[ci];
        }
        return { cx: Math.round(a.cx), n: cys.length,
                 span: cys.length ? Math.round(y1 - y0) : 0 };
    });
    var colDetailStr = colDetail.map(function(d) {
        return 'x' + d.cx + '(' + d.n + 'cc,' + d.span + 'px)';
    }).join(' ');

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
            maxWithinSpacing: spacingCheck.maxWithin,
            // 2D-row-validated column X-positions — surfaced for the seam
            // fallback's diagnostics (these filter noise via row structure,
            // unlike the 1D density peaks).
            colXs: colXs.map(function(x) { return Math.round(x); }),
            colDetail: colDetailStr
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

// =============================================================================
// 6-COLUMN-PEAK SEAM FALLBACK
// =============================================================================
//
// When detectMidpoint's anchor path fails (mis-grouped columns on a skewed or
// noisy photo) the caller drops to the legacy ink-valley split. On a badly-
// centered photo the globally-deepest valley is a WITHIN-sheet gap, not the
// seam — so the cut lops a column (the "rightmost column ~155px vs ~516px,
// hugs the image edge" templateWarning).
//
// This fallback places the seam by COLUMN COUNT instead of valley depth. Two
// copies of the same sheet contribute (leftCols + rightCols) evenly-spaced ink
// columns; the seam is the gap between column[leftCols-1] and column[leftCols]
// (a 3|3 split for 3-col sheets). Detecting the columns as smoothed-density
// humps and splitting by count is robust to overall left/right ink imbalance
// and to non-column-shaped noise blobs, which never become one of the top-
// (leftCols+rightCols) regularly-spaced humps.
//
// Returns { seamX, confident, reason }. confident:false means "the hump
// structure didn't match a clean N+N column layout" — the caller keeps the
// ink-valley fallback, so this can only improve on it, never regress.

// Centered box-filter via a single running sum. lo/hi are non-decreasing as c
// advances, so L and R move monotonically — O(n) total.
function boxSmooth(arr, win) {
    var n = arr.length;
    var out = new Float64Array(n);
    if (win < 2 || n === 0) { for (var i = 0; i < n; i++) out[i] = arr[i]; return out; }
    var half = Math.floor(win / 2);
    var run = 0, L = 0, R = -1;
    for (var c = 0; c < n; c++) {
        var lo = c - half; if (lo < 0) lo = 0;
        var hi = c + half; if (hi > n - 1) hi = n - 1;
        while (R < hi) { R++; run += arr[R]; }
        while (L < lo) { run -= arr[L]; L++; }
        out[c] = run / (R - L + 1);
    }
    return out;
}

// =============================================================================
// PRINTED-GRID SEAM DETECTION (primary fallback)
// =============================================================================
//
// When detectMidpoint's anchor path fails, this is the first fallback — it is
// the most robust because it keys on the PRINTED TABLE GRID, not ink density.
//
// Why density fails on real phone photos (verified on PXL_20260606_222707000):
//   - a strong left-bright/right-dark lighting gradient makes any global
//     brightness/darkness threshold meaningless (one side saturates);
//   - one sheet's pencil can be much fainter than the other's, so its ink
//     density is no higher than the whitespace between its own columns;
//   - the inter-sheet gap is thin and (under skew) diagonal.
// Density-based valley finding then picks a within-sheet gap and the split
// lops a column.
//
// The printed grid is invariant to all three: every scoresheet is covered in
// printed rule lines (a border + a line per row), so an ADAPTIVE (local-
// contrast) threshold lights up each sheet as a dense foreground plateau
// regardless of global lighting or how faint the handwriting is. The table
// surface BETWEEN the two sheets has no printed structure → an empty band.
// The seam is the widest empty band between the two plateaus; its center is
// the cut.
//
// Returns { seamX, confident, reason }. confident:false → caller tries the
// next fallback (column-count, then ink-valley), so this only ever improves.
function detectSeamByGrid(srcMat, log) {
    log = log || function() {};
    function done(confident, seamX, reason) {
        log('[grid-seam] ' + (confident ? 'OK — ' : 'reject — ') + reason);
        return { seamX: seamX, confident: confident, reason: reason };
    }
    if (!srcMat) return done(false, null, 'no image');
    if (typeof cv === 'undefined' || !cv.Mat) return done(false, null, 'OpenCV unavailable');

    var W = srcMat.cols;
    var gray = new cv.Mat(), bw = new cv.Mat(), colSum = new cv.Mat();
    var fg = new Float64Array(W);
    try {
        if (srcMat.channels() === 4) cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
        else if (srcMat.channels() === 3) cv.cvtColor(srcMat, gray, cv.COLOR_RGB2GRAY);
        else srcMat.copyTo(gray);
        // Foreground = darker than the local mean (printed lines + ink). Block
        // size 41 captures the rule-line scale; C=8 rejects flat page/table.
        // adaptiveThreshold needs an odd block; 41 is odd.
        cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C,
            cv.THRESH_BINARY_INV, 41, 8);
        cv.reduce(bw, colSum, 0, cv.REDUCE_SUM, cv.CV_32S);  // 1×W foreground sums
        var sd = colSum.data32S;
        for (var x = 0; x < W; x++) fg[x] = sd[x] / 255;     // → pixel count
    } catch (e) {
        return done(false, null, 'adaptive threshold failed: ' + (e && e.message || e));
    } finally {
        gray.delete(); bw.delete(); colSum.delete();
    }

    var win = Math.max(5, Math.round(W / 60));
    var fgs = boxSmooth(fg, win);
    var peak = 0;
    for (var i = 0; i < W; i++) if (fgs[i] > peak) peak = fgs[i];
    if (peak < 1) return done(false, null, 'no printed structure detected');

    // Compact spatial profile (40 bins, 0–9 of peak) for diagnostics.
    var BINS = 40, prof = '', binW = W / BINS;
    for (var b = 0; b < BINS; b++) {
        var bm = 0, bEnd = Math.floor((b + 1) * binW);
        for (var bx = Math.floor(b * binW); bx < bEnd && bx < W; bx++) {
            if (fgs[bx] > bm) bm = fgs[bx];
        }
        prof += String.fromCharCode(48 + Math.min(9, Math.round(bm / peak * 9)));
    }
    log('[grid-seam] printed-grid profile (' + BINS + ' bins ~' + Math.round(binW)
        + 'px, 0–9 of peak ' + Math.round(peak) + '): ' + prof);

    // Seed one column inside each sheet = the strongest-grid column in each
    // outer half (the seam lies between them). Then find the LOW-foreground
    // runs between the seeds: within a sheet the printed grid keeps foreground
    // high even over blank/unfilled cells, so the genuine inter-sheet gap
    // (no printed grid) drops out.
    var gapThr = peak * 0.35;
    var plateauThr = peak * 0.5;
    var gL = 0, gR = (W >> 1);
    for (var l = 0; l < (W >> 1); l++) if (fgs[l] > fgs[gL]) gL = l;
    for (var r = (W >> 1); r < W; r++) if (fgs[r] > fgs[gR]) gR = r;
    if (fgs[gL] < plateauThr || fgs[gR] < plateauThr) {
        return done(false, null, 'one half lacks a printed-grid plateau (left peak '
            + Math.round(fgs[gL]) + ', right peak ' + Math.round(fgs[gR]) + ', need '
            + Math.round(plateauThr) + ') — may be a single sheet');
    }
    // Collect EVERY empty band between the seeds, then pick by SYMMETRY, not
    // width. Two-up scoresheets are framed symmetrically, so the real inter-
    // sheet gutter sits near the image centre; an unruled gutter *inside* one
    // sheet can be WIDER but is off-centre. (Board5/MississaugaOpen2026: a 71px
    // within-sheet band at 40% beat the true 44px-but-totally-empty gutter at
    // 50%, clipping a column off each half.) Among real bands (>= a noise
    // floor) choose the one whose centre is nearest W/2; near-ties on
    // centrality break toward the emptier (deeper) band.
    var center = W / 2;
    var minBandW = Math.max(8, win >> 1);
    var bands = [], cur = 0, start = gL;
    for (var x2 = gL; x2 < gR; x2++) {
        if (fgs[x2] < gapThr) {
            if (cur === 0) start = x2;
            cur++;
        } else {
            if (cur > 0) bands.push({ lo: start, len: cur });
            cur = 0;
        }
    }
    if (cur > 0) bands.push({ lo: start, len: cur });
    // Reject sub-floor noise bands, but never filter down to nothing.
    var real = bands.filter(function(bd) { return bd.len >= minBandW; });
    if (!real.length) real = bands;
    if (!real.length) {
        return done(false, null, 'no empty band (<' + Math.round(gapThr) + ') between the two '
            + 'grid plateaus at x=' + gL + ' and x=' + gR + ' — sheets abut or single sheet');
    }
    real.forEach(function(bd) {
        bd.center = bd.lo + (bd.len >> 1);
        var m = Infinity;
        for (var i = bd.lo; i < bd.lo + bd.len; i++) if (fgs[i] < m) m = fgs[i];
        bd.depth = m;  // emptiest column inside the band
    });
    real.sort(function(p, q) {
        var d = Math.abs(p.center - center) - Math.abs(q.center - center);
        if (Math.abs(d) > win) return d;   // clearly more central wins
        return p.depth - q.depth;          // near-tie → emptier (deeper) wins
    });
    var best = real[0], widest = real[0];
    for (var bi = 1; bi < real.length; bi++) if (real[bi].len > widest.len) widest = real[bi];
    if (widest !== best) {
        log('[grid-seam] symmetry prior: chose central band [' + best.lo + '..'
            + (best.lo + best.len) + '] (' + best.len + 'px, depth ' + Math.round(best.depth)
            + ', ' + Math.round(best.center / W * 100) + '%) over wider off-centre band ['
            + widest.lo + '..' + (widest.lo + widest.len) + '] (' + widest.len + 'px, '
            + Math.round(widest.center / W * 100) + '%)');
    }
    var bestLo = best.lo, bestLen = best.len;
    var seamX = best.center;
    if (seamX < W * 0.20 || seamX > W * 0.80) {
        return done(false, null, 'seam x=' + seamX + ' (' + Math.round(seamX / W * 100)
            + '%) outside central 20–80% band');
    }
    return done(true, seamX, 'inter-sheet gap [' + bestLo + '..' + (bestLo + bestLen)
        + '] (' + bestLen + 'px wide, fg ' + Math.round(fgs[seamX]) + ' vs peak '
        + Math.round(peak) + ') → cut at x=' + seamX + ' (' + Math.round(seamX / W * 100) + '%)');
}

function detectSeamByColumns(srcMat, leftCols, rightCols, log) {
    log = log || function() {};
    var totalCols = leftCols + rightCols;
    // Every exit funnels through done() so the decision trace always reaches
    // the caller's log (and is returned in .reason) — even on the reject paths.
    function done(confident, seamX, reason) {
        log('[6col-peak] ' + (confident ? 'OK — ' : 'reject — ') + reason);
        return { seamX: seamX, confident: confident, reason: reason };
    }
    if (!srcMat || totalCols < 2) {
        return done(false, null, 'bad args (totalCols=' + totalCols + ')');
    }
    if (typeof cv === 'undefined' || !cv.Mat) {
        return done(false, null, 'OpenCV unavailable');
    }

    var W = srcMat.cols;
    log('[6col-peak] start: W=' + W + ' expecting ' + leftCols + '+' + rightCols
        + '=' + totalCols + ' column humps');

    // --- column ink-density projection: count of dark pixels per column ---
    var gray = new cv.Mat(), bw = new cv.Mat(), colSum = new cv.Mat();
    var density = new Float64Array(W);
    try {
        if (srcMat.channels() === 4) cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
        else if (srcMat.channels() === 3) cv.cvtColor(srcMat, gray, cv.COLOR_RGB2GRAY);
        else srcMat.copyTo(gray);
        cv.threshold(gray, bw, 160, 1, cv.THRESH_BINARY_INV);  // dark ink → 1
        cv.reduce(bw, colSum, 0, cv.REDUCE_SUM, cv.CV_32S);    // 1×W column sums
        var sd = colSum.data32S;
        for (var x = 0; x < W; x++) density[x] = sd[x];
    } catch (e) {
        return done(false, null, 'projection failed: ' + (e && e.message || e));
    } finally {
        gray.delete(); bw.delete(); colSum.delete();
    }

    // --- smooth at ~0.4× the expected column width: enough to merge a column's
    //     number + White/Black move sub-columns into ONE hump and to drop stray
    //     handwriting strokes, while preserving the wider inter-column dips. ---
    var expColW = 0.9 * W / totalCols;
    var win = Math.max(5, Math.round(expColW * 0.4));
    var smooth = boxSmooth(density, win);

    var peakMax = 0;
    for (var i2 = 0; i2 < W; i2++) if (smooth[i2] > peakMax) peakMax = smooth[i2];
    if (peakMax < 1) return done(false, null, 'blank projection');

    // Compact spatial ink profile (40 bins, each digit = max smoothed density
    // in that bin as 0–9 of peak). Reveals the [left sheet][right sheet][noise]
    // layout at a glance — a trailing run of 9s is a dense edge noise blob.
    var BINS = 40, prof = '', binW = W / BINS;
    for (var b = 0; b < BINS; b++) {
        var bm = 0, bEnd = Math.floor((b + 1) * binW);
        for (var bx = Math.floor(b * binW); bx < bEnd && bx < W; bx++) {
            if (smooth[bx] > bm) bm = smooth[bx];
        }
        prof += String.fromCharCode(48 + Math.min(9, Math.round(bm / peakMax * 9)));
    }
    log('[6col-peak] ink profile (' + BINS + ' bins ~' + Math.round(binW) + 'px each, 0–9 of peak '
        + Math.round(peakMax) + '): ' + prof);

    // --- column humps: local maxima, then greedy non-max suppression so two
    //     adjacent columns can't both collapse onto one pick and a noise blob
    //     near a real column gets absorbed. Keep the top (totalCols) by height. ---
    var minProm = peakMax * 0.12;
    var maxima = [];
    for (var p = 1; p < W - 1; p++) {
        if (smooth[p] >= smooth[p - 1] && smooth[p] > smooth[p + 1] && smooth[p] >= minProm) {
            maxima.push({ x: p, h: smooth[p] });
        }
    }
    maxima.sort(function(a, b) { return b.h - a.h; });
    log('[6col-peak] smooth win=' + win + 'px peakMax=' + Math.round(peakMax)
        + ' → ' + maxima.length + ' local maxima (>=' + Math.round(minProm) + '); top'
        + ' by height: ' + maxima.slice(0, Math.min(maxima.length, totalCols + 3))
            .map(function(o) { return Math.round(o.x) + '(' + Math.round(o.h) + ')'; }).join(' '));
    var minDist = expColW * 0.6;
    var picked = [];
    for (var m = 0; m < maxima.length && picked.length < totalCols; m++) {
        var ok = true;
        for (var q = 0; q < picked.length; q++) {
            if (Math.abs(maxima[m].x - picked[q].x) < minDist) { ok = false; break; }
        }
        if (ok) picked.push(maxima[m]);
    }
    if (picked.length < totalCols) {
        return done(false, null, 'found only ' + picked.length + ' of ' + totalCols
            + ' column humps (minDist=' + Math.round(minDist) + 'px) at X=['
            + picked.map(function(o) { return Math.round(o.x); }).join(', ') + ']');
    }
    picked.sort(function(a, b) { return a.x - b.x; });

    // --- the seam is the gap between the two innermost columns (index
    //     leftCols-1 → leftCols). It must be the WIDEST gap, and the within-
    //     sheet gaps must be roughly uniform; otherwise the hump structure
    //     does not match a clean N+N layout and we should not trust it. ---
    var gaps = [];
    for (var g = 1; g < picked.length; g++) gaps.push(picked[g].x - picked[g - 1].x);
    var seamGapIdx = leftCols - 1;
    var seamGap = gaps[seamGapIdx];
    var widestIdx = 0;
    for (var gi = 1; gi < gaps.length; gi++) if (gaps[gi] > gaps[widestIdx]) widestIdx = gi;
    log('[6col-peak] humps X=[' + picked.map(function(o) { return Math.round(o.x); }).join(', ')
        + '] gaps=[' + gaps.map(function(v) { return Math.round(v); }).join(', ')
        + '] expected seam at gap#' + (seamGapIdx + 1) + ' (=' + Math.round(seamGap)
        + 'px); widest gap is #' + (widestIdx + 1) + ' (=' + Math.round(gaps[widestIdx]) + 'px)');
    if (widestIdx !== seamGapIdx) {
        return done(false, null, 'widest hump gap at boundary ' + (widestIdx + 1) + ', not the expected '
            + leftCols + '|' + rightCols + ' seam (boundary ' + (seamGapIdx + 1) + ')');
    }
    var within = gaps.filter(function(_, idx) { return idx !== seamGapIdx; });
    var medWithin = median(within);
    if (medWithin > 0 && seamGap < medWithin * 1.25) {
        return done(false, null, 'seam gap ' + Math.round(seamGap) + 'px not clearly wider than within-sheet '
            + Math.round(medWithin) + 'px (columns too uniform — may be a single sheet)');
    }
    var maxWithin = Math.max.apply(null, within);
    var minWithin = Math.min.apply(null, within);
    if (minWithin > 0 && maxWithin > minWithin * 2.5) {
        return done(false, null, 'within-sheet hump spacing too irregular (' + Math.round(minWithin)
            + '..' + Math.round(maxWithin) + 'px, ratio ' + (maxWithin / minWithin).toFixed(1)
            + ') — detection unreliable');
    }

    // --- place the cut at the density minimum inside the seam gap; that lands
    //     in the real whitespace even when the two sheets are unequal widths
    //     or skewed, which the gap midpoint would miss. ---
    var lo2 = picked[seamGapIdx].x, hi2 = picked[seamGapIdx + 1].x;
    var seamX = Math.round((lo2 + hi2) / 2), seamMin = Infinity;
    for (var sx = lo2; sx <= hi2; sx++) {
        if (smooth[sx] < seamMin) { seamMin = smooth[sx]; seamX = sx; }
    }

    // Two copies of the same sheet put the seam near center; reject an extreme
    // (that would be the within-sheet valley the ink-valley path already finds).
    if (seamX < W * 0.20 || seamX > W * 0.80) {
        return done(false, null, 'seam X=' + seamX + ' (' + Math.round(seamX / W * 100)
            + '% of W) outside central 20–80% band');
    }

    return done(true, seamX, totalCols + ' column humps, ' + leftCols + '|' + rightCols
        + ' split at x=' + seamX + ' (seamGap=' + Math.round(seamGap) + 'px, within~'
        + Math.round(medWithin) + 'px)');
}

if (typeof window !== 'undefined') {
    window.GridUnsplit = {
        detectMidpoint: detectMidpoint,
        detectSeamByGrid: detectSeamByGrid,
        detectSeamByColumns: detectSeamByColumns
    };
}

})();
