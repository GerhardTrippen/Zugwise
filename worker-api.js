// =============================================================================
// worker-api.js - Promise-based API for the Zugwise Web Worker
// =============================================================================

// =============================================================================
// NOISE FILTERING - Port of bilstm_ocr.py filter_noise_tail()
// =============================================================================

/**
 * Filter out noise tail from OCR results.
 * Detects the pattern where empty cells produce repeated garbage like:
 * 26.e4 e4, 27.e4 e4, 28.c4 e4, ...
 *
 * @param {Array} moves - Array of {num, color, move, confidence, ...}
 * @param {number} confidenceThreshold - Below this is "suspicious" (default 0.40)
 * @param {number} minRealMoves - Minimum moves to keep (default 5)
 * @returns {Array} - Filtered moves
 */
function filterNoiseTail(moves, confidenceThreshold = 0.40, minRealMoves = 5) {
    if (!moves || moves.length < minRealMoves * 2) {
        return moves || [];
    }

    // Group by move number
    const byNum = {};
    moves.forEach(m => {
        if (!byNum[m.num]) byNum[m.num] = {};
        byNum[m.num][m.color] = m;
    });

    const moveNums = Object.keys(byNum).map(Number).sort((a, b) => a - b);
    if (moveNums.length === 0) return moves;

    // Simple pawn moves that are common noise patterns
    const NOISE_MOVES = new Set([
        'e4', 'e5', 'd4', 'd5', 'c4', 'c5', 'c3', 'e3', 'd3',
        'a3', 'a4', 'b3', 'b4', 'f3', 'f4', 'g3', 'g4', 'h3', 'h4',
        'a6', 'b6', 'c6', 'd6', 'e6', 'f6', 'g6', 'h6'
    ]);

    // Find where noise starts by looking for the pattern
    let noiseStart = null;
    let consecutiveSuspicious = 0;

    for (const n of moveNums) {
        const w = byNum[n]['w'];
        const b = byNum[n]['b'];

        let suspiciousSignals = 0;

        // Signal 1: Both colors have low confidence
        if (w && b) {
            if (w.confidence < confidenceThreshold && b.confidence < confidenceThreshold) {
                suspiciousSignals += 1;
            }
        }

        // Signal 2: Both colors show the same move (very suspicious)
        if (w && b && w.move === b.move) {
            suspiciousSignals += 2; // Strong signal
        }

        // Signal 3: Both are simple pawn moves commonly seen as noise AND low confidence
        if (w && b) {
            const wIsNoise = NOISE_MOVES.has(w.move) && w.confidence < confidenceThreshold;
            const bIsNoise = NOISE_MOVES.has(b.move) && b.confidence < confidenceThreshold;
            if (wIsNoise && bIsNoise) {
                suspiciousSignals += 1;
            }
        }

        // Signal 4: One side is missing (White-only or Black-only after complete moves)
        if ((w && !b) || (!w && b)) {
            const move = w || b;
            if (NOISE_MOVES.has(move.move) && move.confidence < confidenceThreshold) {
                suspiciousSignals += 1;
            }
        }

        console.log(`[NOISE DEBUG] Move ${n}: signals=${suspiciousSignals}, consecutive=${consecutiveSuspicious}, w=${w?.move}(${w?.confidence?.toFixed(2)}), b=${b?.move}(${b?.confidence?.toFixed(2)})`);

        // Track consecutive suspicious moves - require 3+ signals and 4+ consecutive
        if (suspiciousSignals >= 3) {
            consecutiveSuspicious += 1;
            if (consecutiveSuspicious >= 4 && noiseStart === null) {
                // Found noise start - back up to first suspicious move
                noiseStart = n - consecutiveSuspicious + 1;
            }
        } else {
            consecutiveSuspicious = 0;
        }
    }

    // Also check for massive repetition - ONLY LOW CONFIDENCE MOVES
    const moveCounts = {};
    moves.forEach(m => {
        if (m.move && m.confidence < 0.50) {
            moveCounts[m.move] = (moveCounts[m.move] || 0) + 1;
        }
    });

    // If any simple move appears 5+ times at low confidence, find where CONSECUTIVE repetition starts
    // IMPORTANT: Both colors at a move number must look noisy for it to count.
    // A move number with one real-looking move (e.g. Rxe1) should NOT be treated as noise.
    for (const [mv, count] of Object.entries(moveCounts)) {
        if (NOISE_MOVES.has(mv) && count >= 5) {
            let consecutiveStart = null;
            let consecutiveCount = 0;

            for (const n of moveNums) {
                const w = byNum[n]['w'];
                const b = byNum[n]['b'];

                // A move number counts as noisy only if BOTH sides look suspicious:
                // - Both present and both are low-confidence noise moves
                // - Or only one side present and it matches the noise pattern
                let moveNumIsNoisy = false;
                if (w && b) {
                    const wNoisy = NOISE_MOVES.has(w.move) && w.confidence < 0.50;
                    const bNoisy = NOISE_MOVES.has(b.move) && b.confidence < 0.50;
                    moveNumIsNoisy = wNoisy && bNoisy;
                } else if (w || b) {
                    const move = w || b;
                    moveNumIsNoisy = move.move === mv && move.confidence < 0.50;
                }

                if (moveNumIsNoisy) {
                    if (consecutiveStart === null) consecutiveStart = n;
                    consecutiveCount++;
                } else {
                    consecutiveStart = null;
                    consecutiveCount = 0;
                }

                if (consecutiveCount >= 5) {
                    console.log(`[NOISE DEBUG] Repetition detected: '${mv}' x${consecutiveCount} starting at move ${consecutiveStart}`);
                    if (noiseStart === null || consecutiveStart < noiseStart) {
                        noiseStart = consecutiveStart;
                    }
                    break;
                }
            }
        }
    }

    if (noiseStart !== null) {
        console.log(`[NOISE] Detected noise tail starting at move ${noiseStart}`);
        const filtered = moves.filter(m => m.num < noiseStart);
        console.log(`[NOISE] Kept ${filtered.length}/${moves.length} moves`);
        return filtered;
    }

    return moves;
}


class ZugwiseAPI {
    constructor() {
        this.worker = null;
        this.callbacks = new Map();
        this.nextId = 1;
        this.isReady = false;
        this.onStatusChange = null;
        this.useWorker = true; // Toggle between worker and Flask backend
    }

    async init(onStatus) {
        this.onStatusChange = onStatus;

        return new Promise((resolve, reject) => {
            this.worker = new Worker('zugwise-worker.js');

            this.worker.onmessage = (e) => {
                const { id, type, result, error, message } = e.data;

                if (type === 'status') {
                    if (this.onStatusChange) {
                        this.onStatusChange(message);
                    }
                    return;
                }

                if (type === 'ready') {
                    this.isReady = true;
                    resolve();
                    return;
                }

                if (type === 'error' && !id) {
                    reject(new Error(error || message));
                    return;
                }

                // Handle response to specific request
                const callback = this.callbacks.get(id);
                if (callback) {
                    this.callbacks.delete(id);
                    if (type === 'error') {
                        callback.reject(new Error(error));
                    } else {
                        callback.resolve(result);
                    }
                }
            };

            this.worker.onerror = (e) => {
                reject(new Error(`Worker error: ${e.message}`));
            };

            // Trigger initialization
            this.worker.postMessage({ type: 'init' });
        });
    }

    _send(type, data) {
        return new Promise((resolve, reject) => {
            if (!this.worker) {
                reject(new Error('Worker not initialized'));
                return;
            }
            const id = this.nextId++;
            this.callbacks.set(id, { resolve, reject });
            this.worker.postMessage({ id, type, data });
        });
    }

    // API methods matching Flask endpoints
    async validate(moves, ocrData, autoFixSettings, approvedPlies, startPly = 0) {
        return this._send('validate', { moves, ocrData, autoFixSettings, approvedPlies, startPly });
    }

    async getPosition(moves, ply) {
        return this._send('position', { moves, ply });
    }

    async getLegalMoves(fen) {
        return this._send('legal-moves', { fen });
    }

    async findFixes(moves, stuckAt, ocrMoves, minPly, fixedPlies, phase2Depth, lockedPlies) {
        return this._send('find-fixes', { moves, stuckAt, ocrMoves, minPly, fixedPlies: fixedPlies || [], phase2Depth: phase2Depth ?? 5, lockedPlies: lockedPlies || [] });
    }

    async reconstruct(ocrMoves, options) {
        return this._send('reconstruct', { ocrMoves, options });
    }

    async runOCR(imageData, width, height) {
        return this._send('ocr', { imageData, width, height });
    }

    async getSimilarity(text1, text2) {
        return this._send('similarity', { text1, text2 });
    }

    /**
     * Check candidates for tactical absurdity using Python quiescence search.
     * @param {Array<string>} moves - Current move list
     * @param {Array<{ply: number, san: string}>} candidates - Candidates to check
     * @returns {Promise<Array<{ply, san, is_absurd, reason}>>}
     */
    async checkAbsurdities(moves, candidates) {
        return this._send('check-absurdities', { moves, candidates });
    }

    // =========================================================================
    // CONSTRAINED RE-OCR
    // =========================================================================

    /**
     * Re-decode stored CTC logits constrained to legal moves at a position.
     * Returns ranked candidates above confidence threshold.
     *
     * @param {number} ply - The ply to re-decode
     * @param {Array<string>} legalMoves - Legal SAN moves at this position
     * @param {Array} ocrMoves - OCR data (to find logits for this ply)
     * @returns {Promise<{candidates: Array, error: string|null}>}
     */
    async constrainedReOCR(ply, legalMoves, ocrMoves) {
        return this._send('constrained-reocr', { ply, legalMoves, ocrMoves });
    }

    /**
     * Dual-sheet constrained re-OCR: score legal moves against logits from both sheets.
     * Falls back to single-sheet if no dual logits are stored.
     *
     * @param {number} ply - The ply to re-decode
     * @param {Array<string>} legalMoves - Legal SAN moves at this position
     * @returns {Promise<{candidates: Array, top5: Array, scoreMap: Object, error: string|null}>}
     */
    async constrainedReOCRDual(ply, legalMoves) {
        return this._send('constrained-reocr-dual', { ply, legalMoves });
    }

    // =========================================================================
    // STREAMING BACKTRACK SEARCH
    // =========================================================================

    /**
     * Create a backtrack search state. Returns state info including stateId.
     */
    async createBacktrackState(moves, stuckAt, ocrMoves, minPly, fixedPlies, phase2Depth, lockedPlies, stuckReason) {
        return this._send('backtrack-create', { moves, stuckAt, ocrMoves, minPly, fixedPlies: fixedPlies || [], phase2Depth: phase2Depth ?? 5, lockedPlies: lockedPlies || [], stuckReason: stuckReason || '' });
    }

    /**
     * Search the next ply in the backtrack state.
     * Returns: { done, ply, ply_str, remaining, fixes_found, best_score, fixes_at_ply, early_exit }
     */
    async backtrackSearchStep(stateId) {
        return this._send('backtrack-step', { stateId });
    }

    /**
     * Finalize the backtrack search and get the sorted fixes.
     * Returns: { fixes, legal_moves }
     */
    async backtrackFinalize(stateId) {
        return this._send('backtrack-finalize', { stateId });
    }

    /**
     * Start finalization: sort Phase 1, decide if Phase 2 needed.
     * Returns: { need_phase_2, phase2_total_plies }
     */
    async backtrackFinalizePhase1(stateId) {
        return this._send('backtrack-finalize-phase1', { stateId });
    }

    /**
     * Search next ply in Phase 2.
     * Returns: { done, remaining, fixes_found, ... }
     */
    async backtrackPhase2Step(stateId) {
        return this._send('backtrack-phase2-step', { stateId });
    }

    /**
     * Complete finalization: merge Phase 2 results, postprocess, add arrows.
     * Returns: { fixes, legal_moves }
     */
    async backtrackFinalizeComplete(stateId) {
        return this._send('backtrack-finalize-complete', { stateId });
    }

    /**
     * Dual search step 1: raw search with secondary candidate (Phase 1 only).
     * Returns: { raw_count, error }
     */
    async backtrackDualSearch(stateId) {
        return this._send('backtrack-dual-search', { stateId });
    }

    /**
     * Dual search step 2: verify top candidates with full quiescence.
     * Returns: { verified_count }
     */
    async backtrackDualVerify(stateId) {
        return this._send('backtrack-dual-verify', { stateId });
    }

    /**
     * Dual search step 3: merge verified secondary fixes into primary, add arrows, cleanup.
     * Returns: { fixes, total }
     */
    async backtrackDualMerge(stateId, primaryFixes) {
        return this._send('backtrack-dual-merge', { stateId, primaryFixes });
    }

    /**
     * Process a scoresheet image fully client-side using OpenCV.js.
     * NO FLASK FALLBACK - everything runs in the browser.
     *
     * @param {File} file - The image file to process
     * @param {function} onProgress - Progress callback (optional)
     * @returns {Promise<{moves: Array, has_grid_image: boolean, error?: string}>}
     */
    async processScoresheet(file, onProgress, gridConfig, corners, sheetId) {
        // Use OpenCV.js - NO FLASK FALLBACK
        if (!window.OpenCVImageProcessor) {
            throw new Error('OpenCV.js image processor not loaded');
        }

        if (onProgress) onProgress('Initializing OpenCV...');

        // Ensure OpenCV is initialized
        await window.OpenCVImageProcessor.initOpenCV();

        if (onProgress) onProgress('Extracting grid...');

        // Use OpenCV for grid extraction (deskew, perspective transform, cell extraction)
        const result = await window.OpenCVImageProcessor.processScoresheet(file, gridConfig, corners);

        if (!result.gridDetected || result.cells.length === 0) {
            return {
                moves: [],
                has_grid_image: false,
                error: result.error || 'Grid detection failed'
            };
        }

        if (onProgress) onProgress(`Running OCR on ${result.cells.length} cells...`);

        // Run OCR inference on each cell using the Pyodide worker
        const moves = [];
        for (let i = 0; i < result.cells.length; i++) {
            const cell = result.cells[i];

            if (onProgress && i % 5 === 0) {
                onProgress(`OCR: ${i + 1}/${result.cells.length}`);
            }

            try {
                // Send preprocessed cell data to worker for ONNX inference
                // Include cellBelow for A/G tail detection
                const moveInfo = { num: cell.moveNumber, color: cell.color };
                if (sheetId) moveInfo.sheet = sheetId;
                let ocrResult = await this._send('ocr', {
                    imageData: cell.preprocessed,
                    width: 256,
                    height: 64,
                    cellBelow: cell.cellBelow,
                    moveInfo: moveInfo
                });

                // Apply g-tail boost if available (JS-side detection)
                if (ocrResult && ocrResult.move && window.GTailDetection && cell.cellBelow) {
                    try {
                        ocrResult = window.GTailDetection.applyGTailBoost(
                            ocrResult, cell.cellBelow
                        );
                    } catch (gtailErr) {
                        console.warn('[G-Tail] Error:', gtailErr.message);
                    }
                }

                if (ocrResult && ocrResult.move) {
                    moves.push({
                        num: cell.moveNumber,
                        color: cell.color,
                        move: ocrResult.move,
                        confidence: ocrResult.confidence || 0.9,
                        alternatives: ocrResult.alternatives || [],
                        lenientAlternatives: ocrResult.lenientAlternatives || [],
                        logits: ocrResult.logits || null,
                        imageDataUrl: cell.imageDataUrl,  // Pass through cell image for OCR Context
                        cellBelowImageUrl: cell.cellBelowImageUrl || null  // G-tail area image
                    });
                }
            } catch (e) {
                console.warn(`OCR failed for cell ${cell.moveNumber}${cell.color}: ${e.message}`);
            }
        }

        // Debug: summary of lenient alternatives
        const lenientCount = moves.filter(m => m.lenientAlternatives && m.lenientAlternatives.length > 0).length;
        if (lenientCount > 0) {
            console.log(`[LENIENT] ${lenientCount}/${moves.length} cells have lenient alternatives`);
            moves.filter(m => m.lenientAlternatives && m.lenientAlternatives.length > 0).forEach(m => {
                console.log(`  ${m.num}.${m.color}: ${m.move} + lenient=[${m.lenientAlternatives.map(a => a.move).join(', ')}]`);
            });
        }

        // Cleanup grid Mat if it exists
        if (result.grid && result.grid.delete) {
            result.grid.delete();
        }

        // Filter noise tail (repeated garbage moves at end of game)
        if (onProgress) onProgress('Filtering noise...');
        const filteredMoves = filterNoiseTail(moves);

        return {
            moves: filteredMoves,
            has_grid_image: true,
            warnings: result.warnings || [],
            gridOverlayUrl: result.gridOverlayUrl || null,
            rowsPerColumn: result.rowsPerColumn || null
        };
    }

    // Terminate the worker
    terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.isReady = false;
        }
    }
}

// Global instance
window.zugwise = new ZugwiseAPI();
