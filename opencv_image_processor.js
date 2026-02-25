// =============================================================================
// opencv-image-processor.js - OpenCV.js image processing for chess scoresheet OCR
// =============================================================================
// This module provides FULL client-side image processing using OpenCV.js.
// It is a direct port of bilstm_ocr.py functions: deskew, perspective transform,
// grid detection, cell extraction, and preprocessing.
//
// NO FLASK FALLBACK - everything runs in the browser.
// =============================================================================

// OpenCV.js will be loaded from CDN and sets `cv` as global

let opencvReady = false;

/**
 * Initialize OpenCV.js
 * Call this once when the page loads.
 */
function initOpenCV() {
    return new Promise((resolve, reject) => {
        if (typeof cv !== 'undefined' && cv.Mat) {
            opencvReady = true;
            console.log('[OpenCV.js] Already loaded');
            resolve();
            return;
        }

        // OpenCV.js onRuntimeInitialized callback
        if (typeof cv !== 'undefined') {
            cv['onRuntimeInitialized'] = () => {
                opencvReady = true;
                console.log('[OpenCV.js] Initialized');
                resolve();
            };
        } else {
            // Wait for script to load
            const checkInterval = setInterval(() => {
                if (typeof cv !== 'undefined' && cv.Mat) {
                    clearInterval(checkInterval);
                    opencvReady = true;
                    console.log('[OpenCV.js] Ready');
                    resolve();
                }
            }, 100);

            // Timeout after 30 seconds
            setTimeout(() => {
                clearInterval(checkInterval);
                if (!opencvReady) {
                    reject(new Error('OpenCV.js failed to load'));
                }
            }, 30000);
        }
    });
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Load an image file into an OpenCV Mat.
 * @param {File|Blob} file - The image file
 * @returns {Promise<cv.Mat>} - OpenCV Mat (BGR format)
 */
async function loadImageToMat(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const mat = cv.imread(canvas);
                resolve(mat);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Convert Mat to grayscale.
 * @param {cv.Mat} src - Source image (BGR or RGBA)
 * @returns {cv.Mat} - Grayscale image
 */
function toGray(src) {
    const gray = new cv.Mat();
    if (src.channels() === 4) {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    } else if (src.channels() === 3) {
        cv.cvtColor(src, gray, cv.COLOR_BGR2GRAY);
    } else {
        src.copyTo(gray);
    }
    return gray;
}

/**
 * Convert OpenCV Mat to base64 data URL for display in <img> tags.
 * @param {cv.Mat} mat - Source image (any format)
 * @returns {string} - Base64 data URL (image/png)
 */
function matToDataURL(mat) {
    const canvas = document.createElement('canvas');
    canvas.width = mat.cols;
    canvas.height = mat.rows;
    cv.imshow(canvas, mat);
    return canvas.toDataURL('image/png');
}

/**
 * Validate extracted move numbers for gaps and suspicious counts.
 * Scoresheets typically have rows in multiples of 5 or 10 (20, 25, 30, 40 per page).
 * Gaps like 19→21 indicate missed rows during grid extraction.
 *
 * @param {Array} cells - Array of cell objects with moveNumber
 * @returns {Array<string>} - Array of warning messages
 */
function validateMoveNumbers(cells) {
    const warnings = [];
    if (!cells || cells.length === 0) return warnings;

    // Get unique move numbers, sorted
    const moveNums = [...new Set(cells.map(c => c.moveNumber))].sort((a, b) => a - b);

    // Check for gaps in sequence
    for (let i = 1; i < moveNums.length; i++) {
        const expected = moveNums[i - 1] + 1;
        if (moveNums[i] !== expected) {
            const missing = [];
            for (let m = expected; m < moveNums[i]; m++) {
                missing.push(m);
            }
            warnings.push(`⚠ Missing move(s): ${missing.join(', ')} (gap: ${moveNums[i-1]} → ${moveNums[i]})`);
        }
    }

    // Check for suspicious row count (not multiple of 5)
    // Typical counts: 20, 25, 30, 40, 50 per page
    const rowCount = moveNums.length;
    const typicalCounts = [20, 25, 30, 35, 40, 45, 50];
    if (rowCount > 0 && !typicalCounts.includes(rowCount) && rowCount % 5 !== 0) {
        warnings.push(`⚠ Unusual row count: ${rowCount} (typically multiples of 5: 20, 25, 30, 40...)`);
    }

    // Check if first move number is reasonable (usually 1, or 21/41 for continuation sheets)
    const firstMove = moveNums[0];
    if (firstMove !== 1 && firstMove !== 21 && firstMove !== 41 && firstMove !== 61) {
        warnings.push(`⚠ Unusual starting move: ${firstMove} (expected 1, 21, 41, or 61)`);
    }

    return warnings;
}

/**
 * Draw detected grid lines on image and output to console as data URL.
 * Uses HIGH CONTRAST colors: GREEN for horizontal, RED for vertical.
 * @param {cv.Mat} image - Original image (BGR or grayscale)
 * @param {number[]} hPositions - Horizontal line positions (y values)
 * @param {number[]} vPositions - Vertical line positions (x values)
 * @param {string} label - Label for console output
 */
function debugDrawGrid(image, hPositions, vPositions, label = 'Grid Debug') {
    // Create color copy for drawing
    let colorImg;
    if (image.channels() === 1) {
        colorImg = new cv.Mat();
        cv.cvtColor(image, colorImg, cv.COLOR_GRAY2BGR);
    } else {
        colorImg = image.clone();
    }
    
    // Scale line thickness and font for large images
    const lineScale = Math.max(1, Math.round(Math.max(colorImg.cols, colorImg.rows) / 1200));
    const lineThick = 2 * lineScale;
    const fontScale = 0.5 * lineScale;
    const labelOffset = 5 * lineScale;

    // Draw horizontal lines in BRIGHT YELLOW (BGR: 0, 255, 255) for contrast
    for (let i = 0; i < hPositions.length; i++) {
        const y = hPositions[i];
        cv.line(colorImg, new cv.Point(0, y), new cv.Point(colorImg.cols, y),
                new cv.Scalar(0, 255, 255), lineThick);
        const xPos = (i % 2 === 0) ? labelOffset : colorImg.cols - 40 * lineScale;
        cv.putText(colorImg, `${i}`, new cv.Point(xPos, y - labelOffset),
                  cv.FONT_HERSHEY_SIMPLEX, fontScale, new cv.Scalar(0, 255, 255), lineThick);
    }

    // Draw vertical lines in BRIGHT RED (BGR: 0, 0, 255)
    // Also label with column role (#, W, B)
    const colRoles = colorImg.cols > 0 ? ['#1', 'W1', 'B1', '#2', 'W2', 'B2', '#3', 'W3', 'B3'] : [];
    for (let i = 0; i < vPositions.length; i++) {
        const x = vPositions[i];
        cv.line(colorImg, new cv.Point(x, 0), new cv.Point(x, colorImg.rows),
                new cv.Scalar(0, 0, 255), lineThick);
        const colLabel = (i < vPositions.length - 1 && i < colRoles.length)
            ? `${i}:${colRoles[i]}`
            : `${i}`;
        cv.putText(colorImg, colLabel, new cv.Point(x + labelOffset, 25 * lineScale),
                  cv.FONT_HERSHEY_SIMPLEX, fontScale * 1.2, new cv.Scalar(0, 0, 255), lineThick);
    }

    // Downscale for data URL if image is large (keeps data URL under ~1MB)
    const maxDim = 1200;
    let outputImg;
    if (colorImg.cols > maxDim || colorImg.rows > maxDim) {
        const scale = maxDim / Math.max(colorImg.cols, colorImg.rows);
        outputImg = new cv.Mat();
        cv.resize(colorImg, outputImg, new cv.Size(
            Math.round(colorImg.cols * scale),
            Math.round(colorImg.rows * scale)
        ), 0, 0, cv.INTER_AREA);
    } else {
        outputImg = colorImg;
    }

    const dataUrl = matToDataURL(outputImg);
    console.log(`[DEBUG IMAGE] ${label}: ${outputImg.cols}x${outputImg.rows}`);

    if (outputImg !== colorImg) outputImg.delete();
    colorImg.delete();
    return dataUrl;
}


/**
 * Debug: draw corners on image and output to console.
 * Uses THICK BRIGHT lines for visibility.
 */
function debugDrawCorners(image, corners, label = 'Corners') {
    if (!corners || corners.length !== 4) return;
    
    let colorImg;
    if (image.channels() === 1) {
        colorImg = new cv.Mat();
        cv.cvtColor(image, colorImg, cv.COLOR_GRAY2BGR);
    } else {
        colorImg = image.clone();
    }
    
    // Bright, distinct colors for each corner
    const colors = [
        new cv.Scalar(0, 255, 0),    // TL - bright green
        new cv.Scalar(0, 255, 255),  // TR - yellow
        new cv.Scalar(0, 0, 255),    // BR - red
        new cv.Scalar(255, 0, 255)   // BL - magenta
    ];
    const labels = ['TL', 'TR', 'BR', 'BL'];
    
    // Draw the quadrilateral outline in CYAN (thick)
    for (let i = 0; i < 4; i++) {
        const c = corners[i];
        const next = corners[(i + 1) % 4];
        cv.line(colorImg, new cv.Point(c.x, c.y), new cv.Point(next.x, next.y), 
               new cv.Scalar(255, 255, 0), 3);  // Cyan, thickness 3
    }
    
    // Draw corner circles and labels
    for (let i = 0; i < 4; i++) {
        const c = corners[i];
        cv.circle(colorImg, new cv.Point(c.x, c.y), 20, colors[i], -1);  // Filled circle
        cv.circle(colorImg, new cv.Point(c.x, c.y), 20, new cv.Scalar(0, 0, 0), 2);  // Black outline
        cv.putText(colorImg, labels[i], new cv.Point(c.x + 25, c.y + 5), 
                  cv.FONT_HERSHEY_SIMPLEX, 1, colors[i], 3);
    }
    
    const dataUrl = matToDataURL(colorImg);
    console.log(`[DEBUG IMAGE] ${label}:`);
    console.log(dataUrl);
    
    colorImg.delete();
    return dataUrl;
}


// =============================================================================
// DESKEW IMAGE (Port of bilstm_ocr.py deskew_image)
// =============================================================================

/**
 * Deskew an image by detecting dominant line angles.
 * @param {cv.Mat} image - Input image (BGR)
 * @returns {cv.Mat} - Deskewed image
 */
function deskewImage(image) {
    const gray = toGray(image);
    
    // Edge detection
    const edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150, 3);
    
    // Hough lines
    const lines = new cv.Mat();
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 100, 100, 10);
    
    if (lines.rows === 0) {
        gray.delete();
        edges.delete();
        lines.delete();
        return image.clone();
    }
    
    // Collect angles
    const angles = [];
    for (let i = 0; i < lines.rows; i++) {
        const x1 = lines.data32S[i * 4];
        const y1 = lines.data32S[i * 4 + 1];
        const x2 = lines.data32S[i * 4 + 2];
        const y2 = lines.data32S[i * 4 + 3];
        
        if (x2 !== x1) {
            const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
            if (Math.abs(angle) < 30) {
                angles.push(angle);
            }
        }
    }
    
    gray.delete();
    edges.delete();
    lines.delete();
    
    if (angles.length === 0) {
        return image.clone();
    }
    
    // Median angle
    angles.sort((a, b) => a - b);
    const medianAngle = angles[Math.floor(angles.length / 2)];
    
    if (Math.abs(medianAngle) < 0.5) {
        return image.clone();
    }
    
    // Rotate image
    const h = image.rows;
    const w = image.cols;
    const center = new cv.Point(w / 2, h / 2);
    const M = cv.getRotationMatrix2D(center, medianAngle, 1.0);
    const deskewed = new cv.Mat();
    cv.warpAffine(image, deskewed, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    
    M.delete();
    
    console.log(`[Deskew] Rotated by ${medianAngle.toFixed(2)}°`);
    return deskewed;
}

// =============================================================================
// PERSPECTIVE TRANSFORM (Port of bilstm_ocr.py four_point_transform)
// =============================================================================

// orderPoints() and fourPointTransform() are now provided by grid-geometry.js
// (loaded before this file). Legacy versions renamed to avoid overwriting.

/**
 * Order 4 points as: top-left, top-right, bottom-right, bottom-left.
 * Legacy version - use orderPoints() from grid-geometry.js instead.
 */
function orderPointsLegacy(pts) {
    const sortedBySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = sortedBySum[0];
    const br = sortedBySum[3];
    const sortedByDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    const tr = sortedByDiff[0];
    const bl = sortedByDiff[3];
    return [tl, tr, br, bl];
}

/**
 * Apply perspective transform to extract a quadrilateral region.
 * Legacy version - use fourPointTransform() from grid-geometry.js instead.
 */
function fourPointTransformLegacy(image, pts) {
    const ordered = orderPoints(pts);
    const [tl, tr, br, bl] = ordered;
    const widthA = Math.sqrt((br.x - bl.x) ** 2 + (br.y - bl.y) ** 2);
    const widthB = Math.sqrt((tr.x - tl.x) ** 2 + (tr.y - tl.y) ** 2);
    const maxWidth = Math.max(Math.round(widthA), Math.round(widthB));
    const heightA = Math.sqrt((tr.x - br.x) ** 2 + (tr.y - br.y) ** 2);
    const heightB = Math.sqrt((tl.x - bl.x) ** 2 + (tl.y - bl.y) ** 2);
    const maxHeight = Math.max(Math.round(heightA), Math.round(heightB));
    const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y
    ]);
    const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, maxWidth - 1, 0, maxWidth - 1, maxHeight - 1, 0, maxHeight - 1
    ]);
    const M = cv.getPerspectiveTransform(srcPoints, dstPoints);
    const warped = new cv.Mat();
    cv.warpPerspective(image, warped, M, new cv.Size(maxWidth, maxHeight));
    srcPoints.delete();
    dstPoints.delete();
    M.delete();
    return warped;
}

// =============================================================================
// GRID CONTOUR DETECTION (Port of bilstm_ocr.py find_grid_contour)
// =============================================================================

/**
 * Find the main grid contour (quadrilateral) in an image.
 * @param {cv.Mat} image - Input image (BGR)
 * @returns {Array|null} - 4 corner points or null if not found
 */
function findGridContourLegacy(image) {
    const gray = toGray(image);
    
    // Gaussian blur
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    
    // Canny edge detection
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);
    
    // Dilate to connect edges
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const dilated = new cv.Mat();
    cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 2);
    
    // Find contours
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    
    // Sort by area and find quadrilateral
    const imageArea = image.rows * image.cols;
    let bestContour = null;
    let bestArea = 0;
    
    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        
        if (area > 0.15 * imageArea && area > bestArea) {
            const peri = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
            
            if (approx.rows === 4) {
                bestContour = [];
                for (let j = 0; j < 4; j++) {
                    bestContour.push({
                        x: approx.data32S[j * 2],
                        y: approx.data32S[j * 2 + 1]
                    });
                }
                bestArea = area;
            }
            approx.delete();
        }
    }
    
    // Cleanup
    gray.delete();
    blurred.delete();
    edges.delete();
    kernel.delete();
    dilated.delete();
    contours.delete();
    hierarchy.delete();
    
    return bestContour;
}

// =============================================================================
// EXTRACT GRID (Port of bilstm_ocr.py extract_grid)
// =============================================================================

// =============================================================================
// IMPROVED GRID DETECTION WITH PERSPECTIVE CORRECTION
// Replace/augment extractGrid() in opencv_image_processor.js
// =============================================================================

/**
 * Find the four corners of the grid using line intersections.
 * Returns array of 4 corner points [{x,y},...] or null.
 */
function findGridCornersByLines(image) {
    const gray = toGray(image);
    const h = gray.rows;
    const w = gray.cols;
    
    // Adaptive threshold
    const thresh = new cv.Mat();
    cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_MEAN_C, 
                         cv.THRESH_BINARY_INV, 21, 10);
    
    // Find strong horizontal lines (use longer kernel for outer borders)
    const hKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.floor(w / 10), 1));
    const hLines = new cv.Mat();
    cv.morphologyEx(thresh, hLines, cv.MORPH_OPEN, hKernel, new cv.Point(-1, -1), 2);
    
    // Find strong vertical lines
    const vKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.floor(h / 10)));
    const vLines = new cv.Mat();
    cv.morphologyEx(thresh, vLines, cv.MORPH_OPEN, vKernel, new cv.Point(-1, -1), 2);
    
    // Project to find line positions
    const hProj = [];
    for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let x = 0; x < w; x++) {
            sum += hLines.ucharAt(y, x);
        }
        if (sum > w * 0.3 * 255) {
            hProj.push(y);
        }
    }
    
    const vProj = [];
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = 0; y < h; y++) {
            sum += vLines.ucharAt(y, x);
        }
        if (sum > h * 0.3 * 255) {
            vProj.push(x);
        }
    }
    
    // Cluster to get distinct lines
    const hPositions = clusterLines(hProj, Math.floor(h / 50));
    const vPositions = clusterLines(vProj, Math.floor(w / 50));
    
    console.log(`[FindGridCorners] Found ${hPositions.length} horizontal, ${vPositions.length} vertical strong lines`);
    
    // Cleanup
    gray.delete();
    thresh.delete();
    hKernel.delete();
    hLines.delete();
    vKernel.delete();
    vLines.delete();
    
    // Need at least 2 horizontal (top/bottom) and 2 vertical (left/right)
    if (hPositions.length < 2 || vPositions.length < 2) {
        console.log('[FindGridCorners] Not enough lines for corner detection');
        return null;
    }
    
    // Grid corners are intersections of outermost lines
    const top = hPositions[0];
    const bottom = hPositions[hPositions.length - 1];
    const left = vPositions[0];
    const right = vPositions[vPositions.length - 1];
    
    // Return 4 corners: TL, TR, BR, BL
    const corners = [
        { x: left, y: top },      // Top-left
        { x: right, y: top },     // Top-right
        { x: right, y: bottom },  // Bottom-right
        { x: left, y: bottom }    // Bottom-left
    ];
    
    console.log(`[FindGridCorners] Corners: TL(${left},${top}) TR(${right},${top}) BR(${right},${bottom}) BL(${left},${bottom})`);
    
    return corners;
}

/**
 * Find grid corners using Hough line detection for better angle detection.
 * This handles rotated grids better than morphological projection.
 */
/**
 * Find grid corners using Hough line detection.
 * Improved: prioritize LONG lines that span most of the image.
 */
function findGridCornersHough(image) {
    const gray = toGray(image);
    const h = gray.rows;
    const w = gray.cols;
    
    // Edge detection
    const edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);
    
    // Hough line detection - require longer minimum length
    const lines = new cv.Mat();
    const minLineLength = Math.floor(Math.min(w, h) / 4);  // At least 25% of image dimension
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 80, minLineLength, 30);
    
    if (lines.rows === 0) {
        gray.delete();
        edges.delete();
        lines.delete();
        return null;
    }
    
    // Separate horizontal and vertical lines by angle
    const horizontals = [];
    const verticals = [];
    
    for (let i = 0; i < lines.rows; i++) {
        const x1 = lines.data32S[i * 4];
        const y1 = lines.data32S[i * 4 + 1];
        const x2 = lines.data32S[i * 4 + 2];
        const y2 = lines.data32S[i * 4 + 3];
        
        const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        const length = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
        
        // Horizontal: angle close to 0 or ±180
        if (Math.abs(angle) < 15 || Math.abs(angle) > 165) {
            // Only keep lines that span significant width
            const xSpan = Math.abs(x2 - x1);
            if (xSpan > w * 0.3) {  // Must span at least 30% of image width
                horizontals.push({ 
                    x1, y1, x2, y2, angle, length, 
                    yMid: (y1 + y2) / 2,
                    xMin: Math.min(x1, x2),
                    xMax: Math.max(x1, x2)
                });
            }
        }
        // Vertical: angle close to ±90
        else if (Math.abs(Math.abs(angle) - 90) < 15) {
            // Only keep lines that span significant height
            const ySpan = Math.abs(y2 - y1);
            if (ySpan > h * 0.3) {  // Must span at least 30% of image height
                verticals.push({ 
                    x1, y1, x2, y2, angle, length, 
                    xMid: (x1 + x2) / 2,
                    yMin: Math.min(y1, y2),
                    yMax: Math.max(y1, y2)
                });
            }
        }
    }
    
    console.log(`[FindGridCornersHough] Found ${horizontals.length} wide horizontal, ${verticals.length} tall vertical lines`);
    
    // Debug: log the lines we found
    if (horizontals.length > 0) {
        horizontals.sort((a, b) => a.yMid - b.yMid);
        console.log(`[FindGridCornersHough] Horizontal lines Y positions: ${horizontals.map(l => Math.round(l.yMid)).join(', ')}`);
    }
    if (verticals.length > 0) {
        verticals.sort((a, b) => a.xMid - b.xMid);
        console.log(`[FindGridCornersHough] Vertical lines X positions: ${verticals.map(l => Math.round(l.xMid)).join(', ')}`);
    }
    
    // Cleanup
    gray.delete();
    edges.delete();
    lines.delete();
    
    if (horizontals.length < 2 || verticals.length < 2) {
        console.log('[FindGridCornersHough] Not enough long lines found');
        return null;
    }
    
    // Sort to get outermost
    horizontals.sort((a, b) => a.yMid - b.yMid);
    verticals.sort((a, b) => a.xMid - b.xMid);
    
    // Take the FIRST (topmost) and LAST (bottommost) horizontal lines
    // But validate they're not too close together
    const topLine = horizontals[0];
    const bottomLine = horizontals[horizontals.length - 1];
    const leftLine = verticals[0];
    const rightLine = verticals[verticals.length - 1];
    
    // Validate reasonable grid size
    const gridHeight = bottomLine.yMid - topLine.yMid;
    const gridWidth = rightLine.xMid - leftLine.xMid;
    
    if (gridHeight < h * 0.3 || gridWidth < w * 0.4) {
        console.log(`[FindGridCornersHough] Grid too small: ${gridWidth}x${gridHeight} (image: ${w}x${h})`);
        return null;
    }
    
    // Calculate intersection points for true corners
    function lineIntersection(l1, l2) {
        const x1 = l1.x1, y1 = l1.y1, x2 = l1.x2, y2 = l1.y2;
        const x3 = l2.x1, y3 = l2.y1, x4 = l2.x2, y4 = l2.y2;
        
        const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(denom) < 1e-10) return null;
        
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        
        return {
            x: Math.round(x1 + t * (x2 - x1)),
            y: Math.round(y1 + t * (y2 - y1))
        };
    }
    
    const topLeft = lineIntersection(topLine, leftLine);
    const topRight = lineIntersection(topLine, rightLine);
    const bottomRight = lineIntersection(bottomLine, rightLine);
    const bottomLeft = lineIntersection(bottomLine, leftLine);
    
    if (!topLeft || !topRight || !bottomRight || !bottomLeft) {
        console.log('[FindGridCornersHough] Could not compute all intersections');
        return null;
    }
    
    // Clamp corners to image bounds
    const corners = [topLeft, topRight, bottomRight, bottomLeft];
    for (const c of corners) {
        c.x = Math.max(0, Math.min(w - 1, c.x));
        c.y = Math.max(0, Math.min(h - 1, c.y));
    }
    
    console.log(`[FindGridCornersHough] Corners: TL(${topLeft.x},${topLeft.y}) TR(${topRight.x},${topRight.y}) BR(${bottomRight.x},${bottomRight.y}) BL(${bottomLeft.x},${bottomLeft.y})`);
    
    return corners;
}

/**
 * Find dark rectangular regions (like the BLACK header cells on scoresheets).
 * Returns array of {x, y, width, height} sorted left-to-right.
 */
function findDarkHeaderCells(image) {
    const gray = toGray(image);
    const h = gray.rows;
    const w = gray.cols;
    
    // Threshold to find dark regions
    const binary = new cv.Mat();
    cv.threshold(gray, binary, 80, 255, cv.THRESH_BINARY_INV);
    
    // Find contours
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    
    const candidates = [];
    
    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);
        
        // Header cells: 5-25% width, 1-5% height, in top 40%
        const widthRatio = rect.width / w;
        const heightRatio = rect.height / h;
        const yRatio = rect.y / h;
        
        if (widthRatio > 0.05 && widthRatio < 0.25 &&
            heightRatio > 0.008 && heightRatio < 0.05 &&
            yRatio < 0.4) {
            
            const roi = gray.roi(rect);
            const mean = cv.mean(roi);
            roi.delete();
            
            if (mean[0] < 100) {
                candidates.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            }
        }
    }
    
    gray.delete();
    binary.delete();
    contours.delete();
    hierarchy.delete();
    
    candidates.sort((a, b) => a.x - b.x);
    console.log(`[FindDarkHeaders] Found ${candidates.length} dark header candidates`);
    
    return candidates;
}


/**
 * Extract the scoresheet grid from an image using new grid detection v34 modules.
 * Uses runDetection() for pattern-validated columns, bottom-up rows, distortion handling.
 *
 * @param {cv.Mat} image - Input image (BGR/RGBA)
 * @param {Object} gridConfig - Optional {rowCount, format} (default: {20, '2col'})
 * @returns {Object} - {gridImage: cv.Mat, detectionResult: Object, config: Object}
 */
function extractGrid(image, gridConfig) {
    var config = gridConfig || getGridConfig(20, '2col');

    console.log(`[ExtractGrid v34] Running detection (${config.rowCount} rows, ${config.format})...`);

    var result = runDetection(image, config, function(msg) {
        console.log('[ExtractGrid v34] ' + msg);
    });

    // The warped image is our grid image (or null for hybrid/fallback modes)
    var gridImage = result.warped || image.clone();

    console.log(`[ExtractGrid v34] Mode: ${result.mode}, Columns: ${result.columnBoundaries ? result.columnBoundaries.length : 'none'}, Rows: ${result.gridRows ? result.gridRows.length : 'N/A'}`);

    if (!result.columnBoundaries || !result.gridRows) {
        throw new Error('Grid detection failed — column or row detection unsuccessful. Try manual corners.');
    }

    return {
        gridImage: gridImage,
        detectionResult: result,
        config: config
    };
}

/**
 * Extract the scoresheet grid using manually specified corners.
 * Uses runDetectionWithCorners() for perspective correction + column/row detection.
 *
 * @param {cv.Mat} image - Input image (BGR/RGBA)
 * @param {Object} corners - {topLeft, topRight, bottomRight, bottomLeft} each {x, y}
 * @param {Object} gridConfig - Optional {rowCount, format}
 * @returns {Object} - {gridImage: cv.Mat, detectionResult: Object, config: Object}
 */
function extractGridWithCorners(image, corners, gridConfig) {
    var config = gridConfig || getGridConfig(20, '2col');

    console.log('[ExtractGrid Manual] Using manual corners...');

    var cornerArray = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
    var result = runDetectionWithCorners(image, cornerArray, config, function(msg) {
        console.log('[ExtractGrid Manual] ' + msg);
    });

    var gridImage = result.warped || image.clone();

    console.log('[ExtractGrid Manual] Mode: ' + result.mode +
        ', Columns: ' + (result.columnBoundaries ? result.columnBoundaries.length : 'none') +
        ', Rows: ' + (result.gridRows ? result.gridRows.length : 'N/A'));

    if (!result.columnBoundaries || !result.gridRows) {
        throw new Error('Grid detection failed — column or row detection unsuccessful. Try adjusting corners.');
    }

    return {
        gridImage: gridImage,
        detectionResult: result,
        config: config
    };
}

/**
 * Extract cells from a grid image using detection results from v34 grid modules.
 * Supports both 2-column and 3-column scoresheet layouts.
 *
 * 2-col layout (7 boundaries, 6 columns):
 *   [#][W][B][#][W][B] (indices 0-6)
 *   Left half: moves 1..rowCount (column pairs 1-2)
 *   Right half: moves rowCount+1..2*rowCount (column pairs 4-5)
 *
 * 3-col layout (10 boundaries, 9 columns):
 *   [#][W][B][#][W][B][#][W][B] (indices 0-9)
 *   Left third: moves 1..rowCount (column pairs 1-2)
 *   Middle third: moves rowCount+1..2*rowCount (column pairs 4-5)
 *   Right third: moves 2*rowCount+1..3*rowCount (column pairs 7-8)
 *
 * @param {cv.Mat} gridImage - The warped/corrected grid image
 * @param {Object} detectionResult - From runDetection(): {columnBoundaries, gridRows, mode, ...}
 * @param {Object} config - From getGridConfig(): {rowCount, format, expectedCols}
 * @returns {Array} - Array of cell objects {moveNumber, color, image, bbox}
 */
function extractCellsFromGrid(gridImage, detectionResult, config) {
    var colBounds = detectionResult.columnBoundaries;
    var gridRows = detectionResult.gridRows;

    if (!colBounds || !gridRows) {
        console.log('[ExtractCellsFromGrid] Missing column boundaries or grid rows');
        return [];
    }

    console.log(`[ExtractCellsFromGrid] ${colBounds.length} cols, ${gridRows.length} rows, format=${config.format}`);

    // Debug: log column widths and assignments
    var colLabels = config.format === '2col'
        ? ['#1', 'W1', 'B1', '#2', 'W2', 'B2']
        : ['#1', 'W1', 'B1', '#2', 'W2', 'B2', '#3', 'W3', 'B3'];
    var totalW = gridImage.cols;
    var colDebug = [];
    for (var ci = 0; ci < colBounds.length - 1; ci++) {
        var cw = colBounds[ci + 1] - colBounds[ci];
        var pct = (cw / totalW * 100).toFixed(1);
        var label = ci < colLabels.length ? colLabels[ci] : '?';
        colDebug.push(label + ':[' + colBounds[ci] + '-' + colBounds[ci + 1] + '] ' + cw + 'px(' + pct + '%)');
    }
    console.log('[ExtractCellsFromGrid] Column layout:\n  ' + colDebug.join('\n  '));

    // Build column mappings based on format
    // Each mapping: [colIndex, color, moveNumberOffset]
    var columnMappings;
    if (config.format === '3col' && colBounds.length >= 10) {
        columnMappings = [
            [1, 'w', 0],                    // Left third: White moves 1..rowCount
            [2, 'b', 0],                    // Left third: Black moves 1..rowCount
            [4, 'w', config.rowCount],       // Middle third: White moves rowCount+1..2*rowCount
            [5, 'b', config.rowCount],       // Middle third: Black moves rowCount+1..2*rowCount
            [7, 'w', config.rowCount * 2],   // Right third: White moves 2*rowCount+1..3*rowCount
            [8, 'b', config.rowCount * 2]    // Right third: Black moves 2*rowCount+1..3*rowCount
        ];
    } else {
        // 2-col (default)
        columnMappings = [
            [1, 'w', 0],                    // Left half: White moves 1..rowCount
            [2, 'b', 0],                    // Left half: Black moves 1..rowCount
            [4, 'w', config.rowCount],       // Right half: White moves rowCount+1..2*rowCount
            [5, 'b', config.rowCount]        // Right half: Black moves rowCount+1..2*rowCount
        ];
    }

    var cells = [];
    var xPadding = 5;
    var descenderExtra = 15;

    // Support headerRows/footerRows/startingMove from profile config
    var skipTopRows = config.headerRows || 0;
    var skipBottomRows = config.footerRows || 0;
    var startingMoveOffset = (config.startingMove || 1) - 1;

    // Check if detection result says no header (manual corners mode)
    var hasHeader = detectionResult.hasHeader !== false;  // default true

    // With header: gridRows has rowCount+2 entries (header + data + bottom), skip row 0
    // Without header: gridRows has rowCount+1 entries (data + bottom), start at row 0
    var firstDataRow = (hasHeader ? 1 : 0) + skipTopRows;
    var lastDataRow = gridRows.length - 1 - skipBottomRows;

    for (var rowIdx = firstDataRow; rowIdx < lastDataRow; rowIdx++) {
        var y1 = (gridRows[rowIdx].y !== undefined ? gridRows[rowIdx].y : gridRows[rowIdx]) - 2;
        var y2Candidate = (gridRows[rowIdx + 1].y !== undefined ? gridRows[rowIdx + 1].y : gridRows[rowIdx + 1]) + descenderExtra;
        var y2 = Math.min(y2Candidate, gridImage.rows);

        if (y2 <= y1 || y1 < 0) continue;

        for (var m = 0; m < columnMappings.length; m++) {
            var colIndex = columnMappings[m][0];
            var color = columnMappings[m][1];
            var numOffset = columnMappings[m][2];

            if (colIndex + 1 >= colBounds.length) continue;

            var x1 = colBounds[colIndex] + xPadding;
            var x2 = colBounds[colIndex + 1] - xPadding;

            if (x2 <= x1 || x2 > gridImage.cols) continue;

            var rect = new cv.Rect(
                Math.max(0, x1),
                Math.max(0, y1),
                Math.min(x2 - x1, gridImage.cols - x1),
                Math.min(y2 - y1, gridImage.rows - y1)
            );

            if (rect.width <= 0 || rect.height <= 0) continue;

            var cellImage = gridImage.roi(rect).clone();

            if (!isCellEmpty(cellImage)) {
                cells.push({
                    moveNumber: (rowIdx - firstDataRow + 1) + numOffset + startingMoveOffset,
                    color: color,
                    image: cellImage,
                    bbox: { x: x1, y: y1, width: rect.width, height: rect.height }
                });
            } else {
                cellImage.delete();
            }
        }
    }

    // Sort by move number and color
    cells.sort(function(a, b) {
        if (a.moveNumber !== b.moveNumber) return a.moveNumber - b.moveNumber;
        return a.color === 'w' ? -1 : 1;
    });

    // Recover missing cells (same logic as original extractCells)
    var existingMoves = {};
    cells.forEach(function(c) { existingMoves[c.moveNumber + '-' + c.color] = true; });
    var maxMoveNum = cells.length > 0 ? Math.max.apply(null, cells.map(function(c) { return c.moveNumber; })) : 0;
    var minMoveNum = cells.length > 0 ? Math.min.apply(null, cells.map(function(c) { return c.moveNumber; })) : 1;

    for (var moveNum = minMoveNum; moveNum <= maxMoveNum; moveNum++) {
        var colors = ['w', 'b'];
        for (var ci = 0; ci < colors.length; ci++) {
            var clr = colors[ci];
            var key = moveNum + '-' + clr;
            if (existingMoves[key]) continue;

            console.log('[ExtractCellsFromGrid] Recovering missing cell ' + moveNum + '.' + clr.toUpperCase() + '...');

            // Determine row and column
            var recRowIdx, recColIndex;
            // Find which section this move belongs to
            var section = Math.floor((moveNum - 1) / config.rowCount);
            var rowInSection = ((moveNum - 1) % config.rowCount) + 1;

            if (config.format === '3col') {
                recColIndex = (clr === 'w') ? (section * 3 + 1) : (section * 3 + 2);
            } else {
                recColIndex = (clr === 'w') ? (section * 3 + 1) : (section * 3 + 2);
            }
            recRowIdx = rowInSection;

            if (recRowIdx >= 1 && recRowIdx < gridRows.length && recColIndex + 1 < colBounds.length) {
                var ry1 = Math.max(0, (gridRows[recRowIdx].y !== undefined ? gridRows[recRowIdx].y : gridRows[recRowIdx]) - 2);
                var ry2Raw = (recRowIdx + 1 < gridRows.length) ? (gridRows[recRowIdx + 1].y !== undefined ? gridRows[recRowIdx + 1].y : gridRows[recRowIdx + 1]) + descenderExtra : gridImage.rows;
                var ry2 = Math.min(ry2Raw, gridImage.rows);
                var rx1 = colBounds[recColIndex] + xPadding;
                var rx2 = Math.min(colBounds[recColIndex + 1] - xPadding, gridImage.cols);

                if (rx2 > rx1 && ry2 > ry1) {
                    var rRect = new cv.Rect(rx1, ry1, rx2 - rx1, ry2 - ry1);
                    var rCellImage = gridImage.roi(rRect).clone();

                    cells.push({
                        moveNumber: moveNum,
                        color: clr,
                        image: rCellImage,
                        bbox: { x: rx1, y: ry1, width: rx2 - rx1, height: ry2 - ry1 },
                        recovered: true
                    });
                    console.log('[ExtractCellsFromGrid] Recovered ' + moveNum + '.' + clr.toUpperCase());
                }
            }
        }
    }

    // Final sort
    cells.sort(function(a, b) {
        if (a.moveNumber !== b.moveNumber) return a.moveNumber - b.moveNumber;
        return a.color === 'w' ? -1 : 1;
    });

    console.log('[ExtractCellsFromGrid] Extracted ' + cells.length + ' cells (including recovered)');
    return cells;
}

// Legacy extractGrid for backward compatibility (returns just the warped Mat)
function extractGridLegacy(image) {
    var result = extractGrid(image);
    return result.gridImage;
}


// =============================================================================
// CELL EXTRACTION (Port of bilstm_ocr.py extract_cells)
// =============================================================================

/**
 * Cluster nearby line positions with adaptive gap based on expected row count.
 * @param {number[]} lines - Array of line positions
 * @param {number} minGap - Minimum gap between clusters
 * @returns {number[]} - Clustered positions
 */
function clusterLines(lines, minGap = 15) {
    if (lines.length === 0) return [];
    
    lines.sort((a, b) => a - b);
    const clusters = [[lines[0]]];
    
    for (let i = 1; i < lines.length; i++) {
        const lastCluster = clusters[clusters.length - 1];
        if (lines[i] - lastCluster[lastCluster.length - 1] < minGap) {
            lastCluster.push(lines[i]);
        } else {
            clusters.push([lines[i]]);
        }
    }
    
    return clusters.map(c => Math.round(c.reduce((a, b) => a + b, 0) / c.length));
}


/**
 * Validate horizontal line spacing and remove spurious detections.
 * Chess scoresheets have consistent row heights - use this to filter noise.
 */
function validateHorizontalLines(hPositions, imageHeight) {
    if (hPositions.length < 5) return hPositions;
    
    // Calculate all gaps
    const gaps = [];
    for (let i = 1; i < hPositions.length; i++) {
        gaps.push(hPositions[i] - hPositions[i-1]);
    }
    
    // Sort gaps to find the MODE (most common gap) rather than median
    // This is more robust when there's noise at the bottom
    const gapCounts = {};
    const bucketSize = 10; // Group gaps within 10px
    for (const g of gaps) {
        const bucket = Math.round(g / bucketSize) * bucketSize;
        gapCounts[bucket] = (gapCounts[bucket] || 0) + 1;
    }
    
    // Find most common bucket
    let modeGap = 0;
    let modeCount = 0;
    for (const [bucket, count] of Object.entries(gapCounts)) {
        if (count > modeCount) {
            modeCount = count;
            modeGap = parseInt(bucket);
        }
    }
    
    // Also calculate median for comparison
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
    
    // Use the larger of mode or median as expected row height
    const expectedRowHeight = Math.max(modeGap, medianGap);
    
    console.log(`[ValidateHLines] Expected row height: ${expectedRowHeight}px (mode=${modeGap}, median=${medianGap})`);
    console.log(`[ValidateHLines] Gap distribution: ${JSON.stringify(gapCounts)}`);
    
    // STRICTER filter: gaps must be at least 70% of expected height
    const minValidGap = expectedRowHeight * 0.7;
    
    const validPositions = [hPositions[0]];
    
    for (let i = 1; i < hPositions.length; i++) {
        const gap = hPositions[i] - validPositions[validPositions.length - 1];
        
        if (gap >= minValidGap) {
            validPositions.push(hPositions[i]);
        } else {
            console.log(`[ValidateHLines] ✗ Removing y=${hPositions[i]} (gap=${gap} < ${minValidGap.toFixed(0)})`);
        }
    }
    
    // ALSO: Check if we have roughly the right number of rows (20-22 for standard scoresheet)
    // If we have way too many, the threshold might still be too low
    if (validPositions.length > 25) {
        console.log(`[ValidateHLines] ⚠️ Still too many rows (${validPositions.length}), applying stricter filter`);
        
        // Re-filter with 85% threshold
        const stricterMinGap = expectedRowHeight * 0.85;
        const stricterPositions = [validPositions[0]];
        
        for (let i = 1; i < validPositions.length; i++) {
            const gap = validPositions[i] - stricterPositions[stricterPositions.length - 1];
            if (gap >= stricterMinGap) {
                stricterPositions.push(validPositions[i]);
            }
        }
        
        console.log(`[ValidateHLines] Stricter filter: ${validPositions.length} → ${stricterPositions.length} rows`);
        return stricterPositions;
    }
    
    console.log(`[ValidateHLines] Filtered: ${hPositions.length} → ${validPositions.length} horizontal lines`);
    return validPositions;
}


/**
 * Check if a cell is empty (no handwriting).
 * @param {cv.Mat} cellImage - Cell image
 * @param {number} darkThreshold - Pixel value considered dark
 * @param {number} darkPixelRatio - Minimum ratio of dark pixels
 * @returns {boolean} - True if empty
 */
function isCellEmpty(cellImage, darkThreshold = 100, darkPixelRatio = 0.025) {
    if (cellImage.empty()) return true;
    
    const gray = toGray(cellImage);
    const total = gray.rows * gray.cols;
    let darkCount = 0;
    
    for (let i = 0; i < gray.data.length; i++) {
        if (gray.data[i] < darkThreshold) darkCount++;
    }
    
    gray.delete();
    return (darkCount / total) < darkPixelRatio;
}

/**
 * Find the dark "BLACK" header cells and use them to determine column positions.
 * Returns array of 7 x-positions for column boundaries, or null if detection fails.
 */
function detectColumnsFromHeaders(gridImage) {
    console.log(`[DetectHeaders] Starting header detection on ${gridImage.cols}x${gridImage.rows} image`);
    
    const gray = toGray(gridImage);
    const h = gray.rows;
    const w = gray.cols;
    
    // Look only at the top ~10% of the image (header row area)
    const headerHeight = Math.floor(h * 0.10);
    console.log(`[DetectHeaders] Examining header region: 0-${headerHeight}px (top 10%)`);
    
    const headerRegion = gray.roi(new cv.Rect(0, 0, w, headerHeight));
    
    // Threshold to find dark regions
    const binary = new cv.Mat();
    cv.threshold(headerRegion, binary, 120, 255, cv.THRESH_BINARY_INV);
    
    // Debug: show the binary header
    const headerDebugUrl = matToDataURL(binary);
    console.log(`[DEBUG IMAGE] Header binary threshold:`);
    console.log(headerDebugUrl);
    
    // Find contours of dark regions
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    
    console.log(`[DetectHeaders] Found ${contours.size()} contours in header region`);
    
    // Find rectangular dark regions (the "BLACK" header cells)
    const darkCells = [];
    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);
        
        const widthRatio = rect.width / w;
        const heightRatio = rect.height / headerHeight;
        const area = rect.width * rect.height;
        
        console.log(`[DetectHeaders] Contour ${i}: x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}, widthRatio=${(widthRatio*100).toFixed(1)}%, heightRatio=${(heightRatio*100).toFixed(1)}%, area=${area}`);
        
        // Header cells should be:
        // - Width: 8-35% of image width (the BLACK cells are substantial)
        // - Height: 30-100% of header region height
        // - Reasonable area
        if (widthRatio > 0.08 && widthRatio < 0.35 && 
            heightRatio > 0.3 && 
            rect.width > 30 && rect.height > 10) {
            darkCells.push({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                right: rect.x + rect.width,
                center: rect.x + rect.width / 2
            });
            console.log(`[DetectHeaders] ✓ Accepted as dark header cell`);
        }
    }
    
    // Cleanup
    headerRegion.delete();
    binary.delete();
    contours.delete();
    hierarchy.delete();
    gray.delete();
    
    // Sort by x position
    darkCells.sort((a, b) => a.x - b.x);
    
    console.log(`[DetectHeaders] Found ${darkCells.length} dark header cells total`);
    
    if (darkCells.length < 2) {
        console.log(`[DetectHeaders] ❌ Need at least 2 dark cells, got ${darkCells.length}`);
        return null;
    }
    
    // Use the two largest/most prominent dark cells (should be the BLACK headers)
    // Sort by area and take top 2
    const sortedByArea = [...darkCells].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const leftBlack = sortedByArea[0].x < sortedByArea[1].x ? sortedByArea[0] : sortedByArea[1];
    const rightBlack = sortedByArea[0].x < sortedByArea[1].x ? sortedByArea[1] : sortedByArea[0];
    
    console.log(`[DetectHeaders] Left BLACK cell: x=${leftBlack.x}, w=${leftBlack.width}, right=${leftBlack.right}`);
    console.log(`[DetectHeaders] Right BLACK cell: x=${rightBlack.x}, w=${rightBlack.width}, right=${rightBlack.right}`);
    
    // Calculate column positions based on the BLACK cells
    const gridWidth = w;
    
    // The BLACK cells give us key reference points:
    // - leftBlack.x = start of left BLACK column (end of left WHITE)
    // - leftBlack.right = end of left BLACK column (start of center # column)
    // - rightBlack.x = start of right BLACK column (end of right WHITE)
    // - rightBlack.right = end of right BLACK column (end of grid)
    
    // Estimate narrow # column width from the center gap
    // Center gap = space between leftBlack.right and rightBlack.x
    // This contains: # column + WHITE column
    // WHITE column ≈ same width as BLACK column
    const centerGap = rightBlack.x - leftBlack.right;
    const blackWidth = (leftBlack.width + rightBlack.width) / 2;
    const numColWidth = Math.max(centerGap - blackWidth, gridWidth * 0.04); // At least 4%
    
    console.log(`[DetectHeaders] Center gap: ${centerGap}px, avg BLACK width: ${blackWidth.toFixed(0)}px, estimated # col: ${numColWidth.toFixed(0)}px`);
    
    // Calculate all 7 column boundaries
    // Pattern: | # | WHITE | BLACK | # | WHITE | BLACK |
    const col0 = 0;                                          // Left edge
    const col1 = Math.max(numColWidth * 0.8, leftBlack.x - blackWidth - numColWidth * 0.2);  // End of left #
    const col2 = leftBlack.x;                                // Start of left BLACK (end of left WHITE)
    const col3 = leftBlack.right;                            // End of left BLACK (start of center #)
    const col4 = leftBlack.right + numColWidth;              // End of center # (start of right WHITE)
    const col5 = rightBlack.x;                               // Start of right BLACK (end of right WHITE)
    const col6 = Math.min(rightBlack.right, w);              // End of right BLACK
    
    let positions = [col0, col1, col2, col3, col4, col5, col6].map(x => Math.round(Math.max(0, Math.min(x, w))));
    
    // Ensure monotonically increasing
    for (let i = 1; i < positions.length; i++) {
        if (positions[i] <= positions[i-1]) {
            positions[i] = positions[i-1] + 10;
        }
    }
    
    console.log(`[DetectHeaders] Column positions: [${positions.join(', ')}]`);
    
    // Validate: positions should span most of the image
    const coverage = (positions[6] - positions[0]) / w;
    if (coverage < 0.7) {
        console.log(`[DetectHeaders] ❌ Poor coverage: ${(coverage*100).toFixed(1)}% < 70%`);
        return null;
    }
    
    console.log(`[DetectHeaders] ✓ Coverage: ${(coverage*100).toFixed(1)}%`);
    return positions;
}


/**
 * Infer missing vertical column dividers based on scoresheet structure.
 * Pattern: | # | WHITE | BLACK | # | WHITE | BLACK |
 * The # columns are narrow, WHITE and BLACK are equal width.
 * 
 * @param {number[]} detected - Detected vertical line positions
 * @param {number} gridWidth - Total width of grid
 * @returns {number[]} - Complete array of 7 column positions
 */
function inferColumnPositions(detected, gridWidth) {
    console.log(`[InferColumns] Input: ${detected.length} lines at [${detected.join(', ')}], gridWidth=${gridWidth}`);
    
    if (detected.length < 3) {
        console.log(`[InferColumns] ❌ Need at least 3 detected lines`);
        return null;
    }
    
    // Calculate gaps between detected lines
    const gaps = [];
    for (let i = 1; i < detected.length; i++) {
        gaps.push({
            index: i,
            left: detected[i-1],
            right: detected[i],
            width: detected[i] - detected[i-1]
        });
    }
    
    // Sort gaps by width to identify narrow vs wide
    const sortedGaps = [...gaps].sort((a, b) => a.width - b.width);
    console.log(`[InferColumns] Gaps sorted by width: ${sortedGaps.map(g => g.width).join(', ')}`);
    
    // The narrow gaps should be the # columns (there should be 2 of them)
    // The wide gaps are WHITE+BLACK combined (missing the divider between them)
    
    // Find the narrow column width (should be ~8-12% of grid width)
    const narrowGaps = sortedGaps.filter(g => g.width < gridWidth * 0.15);
    const wideGaps = sortedGaps.filter(g => g.width >= gridWidth * 0.15);
    
    console.log(`[InferColumns] Narrow gaps (< 15%): ${narrowGaps.length}, Wide gaps: ${wideGaps.length}`);
    
    if (narrowGaps.length < 2 || wideGaps.length < 1) {
        console.log(`[InferColumns] ❌ Expected 2 narrow gaps and at least 1 wide gap`);
        return null;
    }
    
    // Calculate expected column widths
    const narrowWidth = narrowGaps.reduce((sum, g) => sum + g.width, 0) / narrowGaps.length;
    
    // Wide gaps should be WHITE + BLACK = approximately 2 * moveColumnWidth
    // So moveColumnWidth ≈ wideGap / 2
    const avgWideGap = wideGaps.reduce((sum, g) => sum + g.width, 0) / wideGaps.length;
    const moveColumnWidth = avgWideGap / 2;
    
    console.log(`[InferColumns] Narrow col width: ${narrowWidth.toFixed(0)}px, Move col width: ${moveColumnWidth.toFixed(0)}px`);
    
    // Now reconstruct all 7 positions
    // We need to figure out which detected lines correspond to which boundaries
    
    // Strategy: Start from leftmost and rightmost detected lines
    const leftEdge = detected[0];
    const rightEdge = detected[detected.length - 1];
    
    // The center # column dividers should be near the middle
    // Find detected lines closest to the center
    const center = gridWidth / 2;
    const centerLines = detected.filter(x => Math.abs(x - center) < gridWidth * 0.15);
    
    console.log(`[InferColumns] Center region lines: [${centerLines.join(', ')}]`);
    
    // Build the 7 positions
    let positions;
    
    if (centerLines.length >= 2) {
        // We found the center # column boundaries
        const centerLeft = Math.min(...centerLines);
        const centerRight = Math.max(...centerLines);
        
        // Work outward from center
        const col3 = centerLeft;   // End of left BLACK
        const col4 = centerRight;  // End of center #
        const col2 = col3 - moveColumnWidth;  // End of left WHITE
        const col1 = col2 - moveColumnWidth;  // End of left #
        const col5 = col4 + moveColumnWidth;  // End of right WHITE
        const col6 = col5 + moveColumnWidth;  // End of right BLACK
        const col0 = leftEdge;
        
        positions = [col0, col1, col2, col3, col4, col5, col6];
    } else {
        // Fallback: use detected edges and interpolate
        // Assume pattern: narrow | wide | wide | narrow | wide | wide
        
        const col0 = leftEdge;
        const col1 = col0 + narrowWidth;
        const col2 = col1 + moveColumnWidth;
        const col3 = col2 + moveColumnWidth;
        const col4 = col3 + narrowWidth;
        const col5 = col4 + moveColumnWidth;
        const col6 = rightEdge;
        
        positions = [col0, col1, col2, col3, col4, col5, col6];
    }
    
    // Round and clamp to grid bounds
    positions = positions.map(x => Math.round(Math.max(0, Math.min(x, gridWidth))));
    
    // Ensure monotonically increasing
    for (let i = 1; i < positions.length; i++) {
        if (positions[i] <= positions[i-1]) {
            positions[i] = positions[i-1] + 20;
        }
    }
    
    console.log(`[InferColumns] ✓ Final positions: [${positions.join(', ')}]`);
    
    return positions;
}


/**
 * Extract cells from a grid image.
 * @param {cv.Mat} gridImage - Grid image (BGR)
 * @returns {Array} - Array of cell objects {num, color, image, bbox}
 */
function extractCells(gridImage) {
    const gray = toGray(gridImage);
    const h = gray.rows;
    const w = gray.cols;
    
    // Adaptive threshold
    const thresh = new cv.Mat();
    cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 21, 10);
    
    // =========================================================================
    // HORIZONTAL LINE DETECTION
    // =========================================================================
    const hKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.floor(w / 25), 1));
    const hLines = new cv.Mat();
    cv.morphologyEx(thresh, hLines, cv.MORPH_OPEN, hKernel, new cv.Point(-1, -1), 2);
    
    // Project horizontally
    const hProj = [];
    for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let x = 0; x < w; x++) {
            sum += hLines.ucharAt(y, x);
        }
        if (sum > w * 0.15 * 255) {
            hProj.push(y);
        }
    }
    let hPositions = clusterLines(hProj);
    hPositions = validateHorizontalLines(hPositions, h);

    // Interpolate missing horizontal lines
    if (hPositions.length >= 3) {
        const gaps = [];
        for (let i = 1; i < hPositions.length; i++) {
            gaps.push(hPositions[i] - hPositions[i-1]);
        }
        const medianGap = gaps.slice().sort((a,b) => a-b)[Math.floor(gaps.length/2)];

        const fixedPositions = [hPositions[0]];
        for (let i = 1; i < hPositions.length; i++) {
            const gap = hPositions[i] - hPositions[i-1];
            if (gap > medianGap * 1.7 && gap < medianGap * 2.5) {
                const missingLine = Math.round(hPositions[i-1] + medianGap);
                console.log(`[ExtractCells] 🔧 Interpolating missing line at y=${missingLine}`);
                fixedPositions.push(missingLine);
            } else if (gap > medianGap * 2.5) {
                const numMissing = Math.round(gap / medianGap) - 1;
                for (let j = 1; j <= numMissing; j++) {
                    const missingLine = Math.round(hPositions[i-1] + medianGap * j);
                    console.log(`[ExtractCells] 🔧 Interpolating missing line ${j}/${numMissing} at y=${missingLine}`);
                    fixedPositions.push(missingLine);
                }
            }
            fixedPositions.push(hPositions[i]);
        }

        if (fixedPositions.length > hPositions.length) {
            console.log(`[ExtractCells] 🔧 Fixed: ${hPositions.length} → ${fixedPositions.length} horizontal lines`);
            hPositions = fixedPositions;
        }
    }
    
    // =============================================================================
// SIMPLE VERTICAL LINE DETECTION USING SOBEL EDGE DETECTION
// Replace the vertical line detection section in extractCells()
// =============================================================================

    // =========================================================================
    // VERTICAL LINE DETECTION using Sobel edge detection
    // =========================================================================
    
    const gray2 = toGray(gridImage);
    
    // Sobel in X direction detects vertical edges
    const sobelX = new cv.Mat();
    cv.Sobel(gray2, sobelX, cv.CV_16S, 1, 0, 3);  // dx=1, dy=0 → vertical edges
    
    // Convert to absolute values
    const absSobelX = new cv.Mat();
    cv.convertScaleAbs(sobelX, absSobelX);
    
    // Project vertically - sum each column
    const vProj = new Array(w).fill(0);
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            vProj[x] += absSobelX.ucharAt(y, x);
        }
    }
    
    // Find peaks in the projection (these are the vertical lines)
    const maxProj = Math.max(...vProj);
    const threshold = maxProj * 0.3;  // 30% of max
    
    // Find x positions where projection exceeds threshold
    const candidates = [];
    for (let x = 0; x < w; x++) {
        if (vProj[x] > threshold) {
            candidates.push(x);
        }
    }
    
    // Use larger clustering gap - columns are at least 8% of width apart
    // For 2486px width, minimum column = ~200px, so cluster within 150px
    const minColumnWidth = Math.floor(w * 0.06);  // 6% of width minimum gap
    let vPositions = clusterLines(candidates, minColumnWidth);
    
    console.log(`[ExtractCells] Sobel detected ${vPositions.length} vertical lines: [${vPositions.join(', ')}]`);
    console.log(`[ExtractCells] Max projection: ${maxProj}, threshold: ${threshold.toFixed(0)}`);
    
    // Debug: show the projection as a simple bar chart in console
    const projNormalized = vProj.map(v => Math.round(v / maxProj * 50));
    const projSampled = [];
    for (let i = 0; i < 80; i++) {
        const x = Math.floor(i * w / 80);
        projSampled.push(projNormalized[x]);
    }
    console.log(`[ExtractCells] Projection profile: ${projSampled.map(v => v > 25 ? '█' : v > 10 ? '▄' : '·').join('')}`);
    
    // Cleanup
    gray2.delete();
    sobelX.delete();
    absSobelX.delete();
    
    // If we don't have 7 lines, adjust threshold and try again
    if (vPositions.length < 7) {
        console.log(`[ExtractCells] Only ${vPositions.length} lines, trying lower threshold...`);
        
        const lowerThreshold = maxProj * 0.15;  // 15% of max
        const candidates2 = [];
        for (let x = 0; x < w; x++) {
            if (vProj[x] > lowerThreshold) {
                candidates2.push(x);
            }
        }
        vPositions = clusterLines(candidates2, minColumnWidth);
        console.log(`[ExtractCells] With lower threshold: ${vPositions.length} lines: [${vPositions.join(', ')}]`);
    }

    console.log(`[ExtractCells] Final vertical positions: [${vPositions.join(', ')}]`);
    
    // Check if we're missing the right edge (common problem)
    if (vPositions.length === 6) {
        const gaps = [];
        for (let i = 1; i < vPositions.length; i++) {
            gaps.push(vPositions[i] - vPositions[i-1]);
        }
        // Pattern should be n/w/w/n/w/w - if last gap matches 'w', we're missing right edge
        const sortedGaps = [...gaps].sort((a, b) => a - b);
        const wideWidth = sortedGaps[sortedGaps.length - 1];  // Largest gap = wide column
        
        // Add right edge
        const rightEdge = vPositions[vPositions.length - 1] + wideWidth;
        if (rightEdge <= w + 50) {  // Allow small overflow
            console.log(`[ExtractCells] Adding missing right edge at x=${Math.min(rightEdge, w - 1)}`);
            vPositions.push(Math.min(rightEdge, w - 1));
        }
    }
    
    console.log(`[ExtractCells] Final vertical positions: [${vPositions.join(', ')}]`);
    
    





    // Final check
    if (!vPositions || vPositions.length < 7) {
        console.log(`[ExtractCells] ❌ Could not determine 7 column positions (got ${vPositions ? vPositions.length : 0})`);
        // Try one more fallback: use fixed ratios based on typical scoresheet
        console.log(`[ExtractCells] Using fixed ratio fallback...`);
        vPositions = [0, 0.09, 0.30, 0.50, 0.59, 0.80, 1.0].map(r => Math.round(r * w));
        console.log(`[ExtractCells] Fixed ratio positions: [${vPositions.join(', ')}]`);
    }

    console.log(`[ExtractCells] Detected ${hPositions.length} rows, ${vPositions.length} columns`);
    console.log(`[DEBUG] vPositions: [${vPositions.join(',')}]`);
    console.log(`[DEBUG] hPositions: [${hPositions.join(',')}]`);
    
    // Debug visualization
    debugDrawGrid(gridImage, hPositions, vPositions, 'Detected Grid');

    // Cleanup morphology mats
    hKernel.delete();
    hLines.delete();
    thresh.delete();
    gray.delete();
    
    // =========================================================================
    // CELL EXTRACTION
    // =========================================================================
    const cells = [];
    
    if (vPositions.length < 7 || hPositions.length < 2) {
        console.log('[ExtractCells] ERROR: Not enough lines detected');
        return cells;
    }
    
    const xPadding = 5;
    
    // Extract cells for each row
    // Column layout: | # | WHITE | BLACK | # | WHITE | BLACK |
    // Indices:         0     1       2      3     4       5
    // vPositions:     [0]   [1]     [2]    [3]   [4]     [5]    [6]
    
    for (let rowIdx = 1; rowIdx < hPositions.length - 1; rowIdx++) {
        const y1 = hPositions[rowIdx] - 2;
        const y2 = hPositions[rowIdx + 1] + 15; // Extra for descenders
        
        if (y2 <= y1 || y2 > gridImage.rows) continue;
        
        // Column mappings: [colIndex, color, moveNumberOffset]
        // colIndex refers to which column (between vPositions[colIndex] and vPositions[colIndex+1])
        const columnMappings = [
            [1, 'w', 0],   // Left WHITE column (moves 1-20)
            [2, 'b', 0],   // Left BLACK column (moves 1-20)
            [4, 'w', 20],  // Right WHITE column (moves 21-40)
            [5, 'b', 20]   // Right BLACK column (moves 21-40)
        ];
        
        for (const [colIndex, color, numOffset] of columnMappings) {
            if (colIndex + 1 >= vPositions.length) continue;
            
            const x1 = vPositions[colIndex] + xPadding;
            const x2 = vPositions[colIndex + 1] - xPadding;
            
            if (x2 <= x1 || x2 > gridImage.cols) continue;
            
            // Extract cell ROI
            const rect = new cv.Rect(x1, y1, x2 - x1, y2 - y1);
            const cellImage = gridImage.roi(rect).clone();
            
            if (!isCellEmpty(cellImage)) {
                cells.push({
                    moveNumber: rowIdx + numOffset,
                    color: color,
                    image: cellImage,
                    bbox: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
                });
            } else {
                cellImage.delete();
            }
        }
    }
    
    // Sort by move number and color
    cells.sort((a, b) => {
        if (a.moveNumber !== b.moveNumber) return a.moveNumber - b.moveNumber;
        return a.color === 'w' ? -1 : 1;
    });

    // =========================================================================
    // RECOVER MISSING CELLS
    // =========================================================================
    const existingMoves = new Set(cells.map(c => `${c.moveNumber}-${c.color}`));
    const maxMoveNum = cells.length > 0 ? Math.max(...cells.map(c => c.moveNumber)) : 0;
    const minMoveNum = cells.length > 0 ? Math.min(...cells.map(c => c.moveNumber)) : 1;

    for (let moveNum = minMoveNum; moveNum <= maxMoveNum; moveNum++) {
        for (const color of ['w', 'b']) {
            const key = `${moveNum}-${color}`;
            if (existingMoves.has(key)) continue;
            
            console.log(`[ExtractCells] 🔧 Recovering missing cell ${moveNum}.${color.toUpperCase()}...`);

            // Determine row and column
            let rowIdx, colIndex;
            if (moveNum <= 20) {
                rowIdx = moveNum;
                colIndex = (color === 'w') ? 1 : 2;
            } else {
                rowIdx = moveNum - 20;
                colIndex = (color === 'w') ? 4 : 5;
            }

            if (rowIdx >= 1 && rowIdx < hPositions.length && colIndex + 1 < vPositions.length) {
                const y1 = Math.max(0, hPositions[rowIdx] - 2);
                const y2Raw = (rowIdx + 1 < hPositions.length) ? hPositions[rowIdx + 1] + 15 : gridImage.rows;
                const y2 = Math.min(y2Raw, gridImage.rows);
                const x1 = vPositions[colIndex] + xPadding;
                const x2 = Math.min(vPositions[colIndex + 1] - xPadding, gridImage.cols);

                if (x2 > x1 && y2 > y1) {
                    const rect = new cv.Rect(x1, y1, x2 - x1, y2 - y1);
                    const cellImage = gridImage.roi(rect).clone();

                    cells.push({
                        moveNumber: moveNum,
                        color: color,
                        image: cellImage,
                        bbox: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
                        recovered: true
                    });
                    console.log(`[ExtractCells] ✓ Recovered ${moveNum}.${color.toUpperCase()}`);
                }
            }
        }
    }

    // Final sort
    cells.sort((a, b) => {
        if (a.moveNumber !== b.moveNumber) return a.moveNumber - b.moveNumber;
        return a.color === 'w' ? -1 : 1;
    });

    console.log(`[ExtractCells] Extracted ${cells.length} cells (including recovered)`);
    return cells;
}


// =============================================================================
// CELL PREPROCESSING FOR CTC (Port of bilstm_ocr.py preprocess_cell_for_ctc)
// =============================================================================

/**
 * Preprocess a cell image for the BiLSTM OCR model.
 * Matches the Python training preprocessing exactly.
 *
 * @param {cv.Mat} cellImage - Cell image (BGR or grayscale)
 * @param {number} targetHeight - Target height (64)
 * @param {number} targetWidth - Target width (256)
 * @returns {Uint8Array} - Preprocessed grayscale image (64x256)
 */
function preprocessCellForCTC(cellImage, targetHeight = 64, targetWidth = 256) {
    // Convert to grayscale
    let gray;
    if (cellImage.channels() > 1) {
        gray = toGray(cellImage);
    } else {
        gray = cellImage.clone();
    }
    
    const h = gray.rows;
    const w = gray.cols;
    
    // Find handwriting extent using Otsu threshold
    const otsuResult = new cv.Mat();
    const threshold = cv.threshold(gray, otsuResult, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    otsuResult.delete();
    
    // Find bounding box of dark pixels
    let minX = w, maxX = 0, minY = h, maxY = 0;
    
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (gray.ucharAt(y, x) < threshold) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
        }
    }
    
    // Add padding
    const padding = Math.max(8, Math.round((maxX - minX) * 0.05));
    minX = Math.max(0, minX - padding);
    maxX = Math.min(w - 1, maxX + padding);
    minY = Math.max(0, minY - padding);
    maxY = Math.min(h - 1, maxY + padding);
    
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    
    if (cropW <= 0 || cropH <= 0) {
        // Empty cell - return white image
        gray.delete();
        return new Uint8Array(targetHeight * targetWidth).fill(255);
    }
    
    // Crop
    const cropped = gray.roi(new cv.Rect(minX, minY, cropW, cropH));
    
    // Normalize intensity
    const normalized = new cv.Mat();
    cv.normalize(cropped, normalized, 0, 255, cv.NORM_MINMAX);
    
    // Calculate resize dimensions (maintain aspect ratio)
    const newWidth = Math.max(1, Math.min(Math.round(targetHeight * cropW / cropH), targetWidth));
    
    // Resize
    const resized = new cv.Mat();
    cv.resize(normalized, resized, new cv.Size(newWidth, targetHeight), 0, 0, cv.INTER_AREA);
    
    // Create output with white background (CENTER-padded, matching training)
    const result = new Uint8Array(targetHeight * targetWidth).fill(255);
    const offsetX = Math.floor((targetWidth - newWidth) / 2);
    
    for (let y = 0; y < targetHeight; y++) {
        for (let x = 0; x < newWidth; x++) {
            result[y * targetWidth + offsetX + x] = resized.ucharAt(y, x);
        }
    }
    
    // Cleanup
    gray.delete();
    cropped.delete();
    normalized.delete();
    resized.delete();
    
    return result;
}

// =============================================================================
// HIGH-LEVEL API
// =============================================================================

/**
 * Process a scoresheet image and extract cells for OCR.
 * This is the main entry point - NO FLASK FALLBACK.
 * Uses grid detection v34 modules for pattern-validated column/row detection.
 *
 * @param {File} file - Image file
 * @param {Object} gridConfig - Optional {rowCount, format} (default: {20, '2col'})
 * @returns {Promise<{cells: Array, grid: cv.Mat, error?: string}>}
 */
async function processScoresheet(file, gridConfig, corners) {
    if (!opencvReady) {
        await initOpenCV();
    }

    try {
        console.log('[OpenCV] Loading image...');
        const image = await loadImageToMat(file);
        console.log(`[OpenCV] Image loaded: ${image.cols}x${image.rows}`);

        // Extract grid using v34 detection modules (with optional manual corners)
        console.log('[OpenCV] Extracting grid (v34)...');
        const gridResult = corners
            ? extractGridWithCorners(image, corners, gridConfig)
            : extractGrid(image, gridConfig);

        // Debug: draw grid overlay on the grid image
        let gridOverlayUrl = null;
        if (gridResult.detectionResult.gridRows && gridResult.detectionResult.columnBoundaries) {
            var hPositions = gridResult.detectionResult.gridRows.map(function(r) { return r.y !== undefined ? r.y : r; });
            var vPositions = gridResult.detectionResult.columnBoundaries;
            gridOverlayUrl = debugDrawGrid(gridResult.gridImage, hPositions, vPositions, 'Grid Overlay (' + gridResult.detectionResult.mode + ')');
        }

        // Extract cells using detection results
        console.log('[OpenCV] Extracting cells from grid...');
        const cells = extractCellsFromGrid(gridResult.gridImage, gridResult.detectionResult, gridResult.config);

        // Validate move numbers - check for gaps and suspicious counts
        const moveNumWarnings = validateMoveNumbers(cells);
        if (moveNumWarnings.length > 0) {
            moveNumWarnings.forEach(w => console.warn('[OCR Validation] ' + w));
        }

        // Preprocess each cell for OCR and save images as base64
        const processedCells = cells.map((cell, idx) => {
            const preprocessed = preprocessCellForCTC(cell.image);

            // Convert cell image to base64 data URL BEFORE deleting
            const imageDataUrl = matToDataURL(cell.image);

            // Get cell_below for A/G tail detection
            // Only use the next same-color cell if it's from the same physical column
            // (i.e., similar x position — not a jump to a different scoresheet column)
            let cellBelow = null;
            let cellBelowImageUrl = null;
            const cellBelowIdx = idx + 2; // Same color pattern: w,b,w,b...
            if (cellBelowIdx < cells.length && cells[cellBelowIdx].color === cell.color) {
                // Check if cells are in the same physical column by comparing bbox.x
                var sameColumn = true;
                if (cell.bbox && cells[cellBelowIdx].bbox) {
                    var xDiff = Math.abs(cell.bbox.x - cells[cellBelowIdx].bbox.x);
                    // If x positions differ by more than the cell width, they're in different columns
                    sameColumn = xDiff < (cell.bbox.width || 100);
                }
                if (sameColumn) {
                    cellBelow = preprocessCellForCTC(cells[cellBelowIdx].image);
                    // Store cell below image for g-tail area display in OCR context panel
                    cellBelowImageUrl = matToDataURL(cells[cellBelowIdx].image);
                }
            }

            return {
                moveNumber: cell.moveNumber,
                color: cell.color,
                preprocessed: preprocessed,
                cellBelow: cellBelow,
                cellBelowImageUrl: cellBelowImageUrl,
                bbox: cell.bbox,
                imageDataUrl: imageDataUrl  // Store cell image for OCR Context panel
            };
        });

        // Cleanup cell images (we have base64 versions now)
        cells.forEach(cell => cell.image.delete());

        image.delete();

        return {
            cells: processedCells,
            grid: gridResult.gridImage,
            gridDetected: true,
            detectionResult: gridResult.detectionResult,
            warnings: moveNumWarnings,
            gridOverlayUrl: gridOverlayUrl,
            rowsPerColumn: gridResult.config ? gridResult.config.rowCount : null
        };

    } catch (error) {
        console.warn('[OpenCV]', error.message);
        return {
            cells: [],
            grid: null,
            gridDetected: false,
            error: error.message
        };
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

if (typeof window !== 'undefined') {
    window.OpenCVImageProcessor = {
        initOpenCV,
        loadImageToMat,
        matToDataURL,
        deskewImage,
        findGridContourLegacy: findGridContourLegacy,
        extractGrid,
        extractGridWithCorners,
        extractGridLegacy,
        extractCells,
        extractCellsFromGrid,
        preprocessCellForCTC,
        processScoresheet,
        validateMoveNumbers,
        isReady: () => opencvReady
    };
}
