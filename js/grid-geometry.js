// =============================================================================
// GRID-GEOMETRY.JS - Coordinate math and transforms for grid detection
// =============================================================================
// Part of Zugwise Grid Detection v34
// 
// Dependencies: OpenCV.js (cv global)
// Used by: grid-detection.js, grid-columns.js, grid-rows.js
// =============================================================================

/**
 * Order 4 points into [topLeft, topRight, bottomRight, bottomLeft]
 * @param {Array<{x,y}>} pts - 4 corner points in any order
 * @returns {Array<{x,y}>} - Ordered [TL, TR, BR, BL]
 */
function orderPoints(pts) {
    const sorted = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = sorted[0], br = sorted[3];
    const sorted2 = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    const tr = sorted2[0], bl = sorted2[3];
    return [tl, tr, br, bl];
}

/**
 * Apply perspective transform to extract quadrilateral region
 * @param {cv.Mat} image - Source image
 * @param {Array<{x,y}>} pts - 4 corner points
 * @returns {cv.Mat} - Warped rectangular image (caller must delete!)
 */
function fourPointTransform(image, pts) {
    const [tl, tr, br, bl] = orderPoints(pts);
    const maxW = Math.max(
        Math.sqrt((br.x - bl.x) ** 2 + (br.y - bl.y) ** 2),
        Math.sqrt((tr.x - tl.x) ** 2 + (tr.y - tl.y) ** 2)
    );
    const maxH = Math.max(
        Math.sqrt((tr.x - br.x) ** 2 + (tr.y - br.y) ** 2),
        Math.sqrt((tl.x - bl.x) ** 2 + (tl.y - bl.y) ** 2)
    );
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y
    ]);
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, maxW - 1, 0, maxW - 1, maxH - 1, 0, maxH - 1
    ]);
    const M = cv.getPerspectiveTransform(src, dst);
    const warped = new cv.Mat();
    cv.warpPerspective(image, warped, M, new cv.Size(maxW, maxH));
    src.delete();
    dst.delete();
    M.delete();
    return warped;
}

/**
 * Calculate angle at vertex between two lines
 * @param {Object} p1 - First point {x, y}
 * @param {Object} vertex - Vertex point {x, y}
 * @param {Object} p2 - Second point {x, y}
 * @returns {number} - Angle in degrees
 */
function calcAngle(p1, vertex, p2) {
    const v1x = p1.x - vertex.x, v1y = p1.y - vertex.y;
    const v2x = p2.x - vertex.x, v2y = p2.y - vertex.y;
    const dot = v1x * v2x + v1y * v2y;
    const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
    const cosA = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
    return Math.acos(cosA) * 180 / Math.PI;
}

/**
 * Detect thumb distortion by checking if opposite corners have angles 
 * on different sides of 90°
 * 
 * For perspective: both corners on same edge deviate same direction from 90°
 * For thumb: corners on same edge deviate opposite directions
 * 
 * @param {Array<{x,y}>} corners - 4 corner points
 * @returns {Object} - Distortion analysis with angles and isDistorted flag
 */
function checkContourDistortion(corners) {
    const [tl, tr, br, bl] = orderPoints(corners);
    
    const angleTL = calcAngle(bl, tl, tr);
    const angleTR = calcAngle(tl, tr, br);
    const angleBR = calcAngle(tr, br, bl);
    const angleBL = calcAngle(br, bl, tl);
    
    // For perspective: both corners on same edge deviate same direction from 90°
    // For thumb: corners on same edge deviate opposite directions
    const topDiff = (angleTL - 90) * (angleTR - 90);
    const bottomDiff = (angleBL - 90) * (angleBR - 90);
    
    const maxDev = Math.max(
        Math.abs(angleTL - 90),
        Math.abs(angleTR - 90),
        Math.abs(angleBR - 90),
        Math.abs(angleBL - 90)
    );
    const hasOpposite = topDiff < 0 || bottomDiff < 0;
    const isDistorted = hasOpposite && maxDev > 3;
    
    return {
        angleTL, angleTR, angleBR, angleBL,
        topDiff, bottomDiff, maxDev, isDistorted
    };
}

/**
 * Map warped coordinates back to original image coordinates
 * Used in hybrid mode when we can't deskew due to thumb distortion
 * 
 * @param {Array<{x,y}>} contourCorners - Original 4 corners in image
 * @param {number} warpedW - Width of warped image
 * @param {number} warpedH - Height of warped image
 * @param {number} wx - X coordinate in warped space
 * @param {number} wy - Y coordinate in warped space
 * @returns {{x,y}} - Corresponding point in original image
 */
function mapWarpedToOriginal(contourCorners, warpedW, warpedH, wx, wy) {
    const [tl, tr, br, bl] = orderPoints(contourCorners);
    
    const t = wx / warpedW;
    const yRatio = wy / warpedH;
    const topX = tl.x + t * (tr.x - tl.x);
    const topY = tl.y + t * (tr.y - tl.y);
    const botX = bl.x + t * (br.x - bl.x);
    const botY = bl.y + t * (br.y - bl.y);
    
    return {
        x: topX + yRatio * (botX - topX),
        y: topY + yRatio * (botY - topY)
    };
}

// =============================================================================
// EXPORTS (for module systems) or globals (for browser)
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        orderPoints,
        fourPointTransform,
        calcAngle,
        checkContourDistortion,
        mapWarpedToOriginal
    };
}
