// =============================================================================
// worker-api.js - Promise-based API for the Zugwise Web Worker
// =============================================================================

// OCR worker pool. When true, per-cell OCR and constrained re-OCR run in a
// dedicated pool of lightweight ocr-worker.js instances instead of the
// monolithic Pyodide worker, and processScoresheet dispatches cells
// concurrently across the pool. OCR_POOL_SIZE = 0 means auto-size from core
// count (OcrPool caps it at min(4, cores/2), leaving headroom for the main
// thread and the Pyodide worker). Set a positive integer to pin the size, or
// USE_OCR_POOL=false for an instant rollback to the serial in-Pyodide-worker
// OCR path.
const USE_OCR_POOL = true;
const OCR_POOL_SIZE = 0;

class ZugwiseAPI {
    constructor() {
        this.worker = null;
        this.callbacks = new Map();
        this.nextId = 1;
        this.isReady = false;
        this.onStatusChange = null;
        this.useWorker = true; // Toggle between worker and Flask backend
        this.ocrPool = null;   // OcrPool instance when USE_OCR_POOL
    }

    async init(onStatus) {
        this.onStatusChange = onStatus;

        // Bring up the Pyodide worker (chess logic) first, then the OCR pool.
        await this._initPyodideWorker();

        if (USE_OCR_POOL) {
            if (typeof OcrPool === 'undefined') {
                throw new Error('OcrPool not loaded — include ocr-pool.js before worker-api.js');
            }
            // Emit ONE recognized status for the loading bar rather than letting
            // each pool worker's "Loading ONNX model..." reset it (those strings
            // aren't in the bar's stage map, so they'd snap it backward). Init
            // the pool without a status callback to keep it quiet.
            if (onStatus) onStatus('Loading OCR workers...');
            this.ocrPool = new OcrPool(OCR_POOL_SIZE);
            await this.ocrPool.init();
        }
    }

    _initPyodideWorker() {
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

            // Trigger initialization. When the OCR pool is enabled it owns all
            // ONNX work, so tell the Pyodide worker to skip loading the model
            // (saves a redundant download + session + heap). The flag is tied
            // to USE_OCR_POOL so OCR routing and ONNX loading can never drift:
            // if the pool is off, the worker loads ONNX and serves OCR itself.
            this.worker.postMessage({ type: 'init', data: { loadOnnx: !USE_OCR_POOL } });
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

    // Route a single-cell OCR request to the pool when enabled, else fall back
    // to the Pyodide worker. Affinity (ply → worker) is computed inside the
    // pool from data.moveInfo, keeping logits and constrained re-OCR colocated.
    _sendOCR(data) {
        if (USE_OCR_POOL && this.ocrPool) {
            return this.ocrPool.runOCR(data);
        }
        return this._send('ocr', data);
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

    // Batch similarity: score many candidates against one OCR text in a
    // single worker round-trip. Use for edit-mode's legal-move sort (30+
    // candidates) — the per-call version is too slow for that use case.
    async getSimilarityBatch(ocrText, candidates) {
        return this._send('similarity-batch', { ocrText, candidates });
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
        if (USE_OCR_POOL && this.ocrPool) {
            return this.ocrPool.constrainedReOCR(ply, legalMoves, ocrMoves);
        }
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
        if (USE_OCR_POOL && this.ocrPool) {
            return this.ocrPool.constrainedReOCRDual(ply, legalMoves);
        }
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
    async processScoresheet(file, onProgress, gridConfig, corners, sheetId, method) {
        // Use OpenCV.js - NO FLASK FALLBACK
        if (!window.OpenCVImageProcessor) {
            throw new Error('OpenCV.js image processor not loaded');
        }

        const _tT0 = performance.now();

        if (onProgress) onProgress('Initializing OpenCV...');

        // Ensure OpenCV is initialized
        await window.OpenCVImageProcessor.initOpenCV();

        const _tAfterInit = performance.now();

        if (onProgress) onProgress('Extracting grid...');

        // Use OpenCV for grid extraction (deskew, perspective transform, cell extraction).
        // deferPreviews: return cell images as cheap canvases instead of eagerly
        // base64-encoding them here — we encode below, concurrently with OCR.
        const result = await window.OpenCVImageProcessor.processScoresheet(file, gridConfig, corners, method, { deferPreviews: true });

        const _tAfterGrid = performance.now();

        if (!result.gridDetected || result.cells.length === 0) {
            return {
                moves: [],
                has_grid_image: false,
                error: result.error || 'Grid detection failed'
            };
        }

        if (onProgress) onProgress(`Running OCR on ${result.cells.length} cells...`);

        // Per-sheet OCR timing accumulators (populated when worker returns `timing`)
        const _sum = { onnx: 0, softmax: 0, decodeStrict: 0, decodeLenient: 0, total: 0, workerWall: 0, rtOverhead: 0, count: 0 };

        // Run OCR inference on every cell via the OCR pool. The pool routes
        // each cell to a worker by ply affinity; with size > 1 the workers run
        // concurrently. We therefore dispatch ALL cells up front and reassemble
        // in cell order afterwards — worker completion order is
        // non-deterministic, but the output array must stay in cell order. At
        // pool size 1 this is equivalent to the old serial loop.
        const moves = [];
        const _cellResults = new Array(result.cells.length).fill(null);
        let _completed = 0;

        const _ocrTasks = result.cells.map((cell, i) => {
            // Send preprocessed cell data for ONNX inference.
            // Include cellBelow for A/G tail detection.
            const moveInfo = { num: cell.moveNumber, color: cell.color };
            if (sheetId) moveInfo.sheet = sheetId;
            const _tSendStart = performance.now();
            return this._sendOCR({
                imageData: cell.preprocessed,
                width: 256,
                height: 64,
                cellBelow: cell.cellBelow,
                moveInfo: moveInfo
            }).then((ocrResult) => {
                const _tRoundtrip = performance.now() - _tSendStart;

                if (ocrResult && ocrResult.timing) {
                    _sum.onnx          += ocrResult.timing.onnx;
                    _sum.softmax       += ocrResult.timing.softmax;
                    _sum.decodeStrict  += ocrResult.timing.decodeStrict;
                    _sum.decodeLenient += ocrResult.timing.decodeLenient;
                    _sum.total         += ocrResult.timing.total;
                    _sum.workerWall    += (ocrResult.timing.workerWall || ocrResult.timing.total);
                    // NOTE: under concurrent dispatch a cell's roundtrip includes
                    // time spent queued behind other cells on its worker, so
                    // rtOverhead/workerWall sums overlap and are no longer a clean
                    // transport measure. The OCR-loop WALL time logged below is the
                    // real throughput metric once the pool size is > 1.
                    _sum.rtOverhead    += (_tRoundtrip - (ocrResult.timing.workerWall || ocrResult.timing.total));
                    _sum.count         += 1;
                }

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

                _cellResults[i] = ocrResult;
            }).catch((e) => {
                console.warn(`OCR failed for cell ${cell.moveNumber}${cell.color}: ${e.message}`);
                _cellResults[i] = null;
            }).finally(() => {
                _completed++;
                if (onProgress && _completed % 5 === 0) {
                    onProgress(`OCR: ${_completed}/${result.cells.length}`);
                }
            });
        });

        // Encode cell previews to base64 OFF the OCR critical path. The grid
        // processor now returns each cell's image as a cheap canvas
        // (previewCanvas/cellBelowCanvas) rather than an eagerly-encoded data
        // URL, because toDataURL is expensive and system-load-sensitive (it was
        // ~77% of "grid detect" time and froze the main thread before OCR could
        // start). This task runs on the main thread concurrently with the pool's
        // OCR (which is on worker threads), so the encode hides behind inference.
        // It yields periodically so OCR result callbacks and the UI interleave,
        // and it populates the SAME cell objects the assembly loop reads, so the
        // move shape (imageDataUrl/cellBelowImageUrl) is unchanged.
        const _encodePreviews = (async () => {
            for (let i = 0; i < result.cells.length; i++) {
                const cell = result.cells[i];
                try {
                    if (cell.previewCanvas) {
                        cell.imageDataUrl = cell.previewCanvas.toDataURL('image/jpeg', 0.85);
                        cell.previewCanvas = null;  // release the backing store
                    }
                    if (cell.cellBelowCanvas) {
                        cell.cellBelowImageUrl = cell.cellBelowCanvas.toDataURL('image/jpeg', 0.85);
                        cell.cellBelowCanvas = null;
                    }
                } catch (e) {
                    console.warn(`[Preview] encode failed for cell ${cell.moveNumber}${cell.color}: ${e.message}`);
                }
                if ((i & 7) === 0) await new Promise(r => setTimeout(r, 0));  // yield
            }
        })();

        await Promise.all([..._ocrTasks, _encodePreviews]);

        // Reassemble results in cell order (completion order was concurrent).
        for (let i = 0; i < result.cells.length; i++) {
            const cell = result.cells[i];
            const ocrResult = _cellResults[i];
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
                    cellBelowImageUrl: cell.cellBelowImageUrl || null,  // G-tail area image
                    bbox: cell.bbox || null  // Pixel bounding box in warped grid image
                });
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

        const _tAfterOcr = performance.now();

        if (_sum.count > 0) {
            const n = _sum.count;
            const fmt = (ms) => ms.toFixed(1).padStart(7) + ' ms';
            const fmtAvg = (ms) => (ms / n).toFixed(2).padStart(6) + ' ms';
            const initMs    = _tAfterInit - _tT0;
            const gridMs    = _tAfterGrid - _tAfterInit;
            const ocrLoopMs = _tAfterOcr - _tAfterGrid;
            const workerNonInner = _sum.workerWall - _sum.total;  // un-instrumented worker-side work
            const sheetTag = sheetId ? `sheet ${sheetId}` : 'sheet';
            console.log(
                `[OCR-TIMING] ${sheetTag} (${n} cells, method=${method || 'default'}):\n` +
                `  OpenCV init      : ${fmt(initMs)}\n` +
                `  Grid detect      : ${fmt(gridMs)}\n` +
                `  OCR loop         : ${fmt(ocrLoopMs)}  (avg ${(ocrLoopMs/n).toFixed(2)} ms/cell)\n` +
                `  ── per-cell breakdown (sum over ${n} cells | avg/cell) ──\n` +
                `  ONNX run         : ${fmt(_sum.onnx)}  | ${fmtAvg(_sum.onnx)}\n` +
                `  log_softmax      : ${fmt(_sum.softmax)}  | ${fmtAvg(_sum.softmax)}\n` +
                `  Beam strict      : ${fmt(_sum.decodeStrict)}  | ${fmtAvg(_sum.decodeStrict)}\n` +
                `  Beam lenient     : ${fmt(_sum.decodeLenient)}  | ${fmtAvg(_sum.decodeLenient)}\n` +
                `  Inner total      : ${fmt(_sum.total)}  | ${fmtAvg(_sum.total)}  (sum of above)\n` +
                `  Worker wall      : ${fmt(_sum.workerWall)}  | ${fmtAvg(_sum.workerWall)}  (recv → just-before-postMessage)\n` +
                `  Worker non-inner : ${fmt(workerNonInner)}  | ${fmtAvg(workerNonInner)}  (input prep + storedLogits + response build)\n` +
                `  postMessage cost : ${fmt(_sum.rtOverhead)}  | ${fmtAvg(_sum.rtOverhead)}  (roundtrip − workerWall = pure transport)`
            );
        }

        // Capture dimensions before deleting the grid Mat
        const gridWidth = (result.grid && result.grid.cols) ? result.grid.cols : 0;
        const gridHeight = (result.grid && result.grid.rows) ? result.grid.rows : 0;

        // Cleanup grid Mat if it exists
        if (result.grid && result.grid.delete) {
            result.grid.delete();
        }

        // Skip silent noise filtering — let showOcrResults() detectSuspiciousTail()
        // present noise to the user for review instead of auto-truncating
        const filteredMoves = moves;

        return {
            moves: filteredMoves,
            has_grid_image: true,
            warnings: result.warnings || [],
            gridOverlayUrl: result.gridOverlayUrl || null,
            rowsPerColumn: result.rowsPerColumn || null,
            imageWidth: gridWidth,
            imageHeight: gridHeight
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
