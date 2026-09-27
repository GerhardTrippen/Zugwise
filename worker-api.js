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
        this._ctcByGame = new Map();  // gameKey -> [{data, plies}] (see _ctcKey)
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

    /**
     * Tag subsequent OCR with the game it belongs to, so stored logits can be
     * scoped later. Batch mode calls this before each game; single-game mode
     * leaves it null, where there is nothing to disambiguate.
     */
    setOcrGameTag(gameId) {
        // Starting (re-)OCR of a batch game invalidates THAT game's logits:
        // the pass about to run replaces them. Other games keep theirs — they
        // are still being reconstructed or reviewed (see _ctcByGame).
        // Single-game mode (null tag) is left exactly as it was.
        if (gameId) this._ctcByGame.set(this._ctcKey(gameId), []);
        this._ocrGameTag = gameId || null;
    }

    // -------------------------------------------------------------------------
    // CTC logits, stored PER GAME
    // -------------------------------------------------------------------------
    // This used to be ONE slot (_ctcSheets), reset whenever the OCR queue moved
    // to the next game, and handed out only when the game under review was the
    // game OCR happened to be on. Batch OCR runs ahead of both review and
    // reconstruction, so a background search for game X almost always got
    // NOTHING — and in the one case the tags did match (OCR finished, user
    // reviewing the last game, a slow Dijkstra still running on game 1), it got
    // the reviewed game's handwriting against game 1's plies. Keyed by game,
    // every consumer asks for the game it is actually working on.
    //
    // Key '' is single-game mode (null tags), which therefore behaves as the
    // old single slot did. Bounded LRU: a sheet-page is ~0.4 MB, so the cap is
    // generous for a round; an evicted game simply ranks without CTC.

    _ctcKey(gameId) {
        return gameId == null ? '' : String(gameId);
    }

    _ctcSheetsFor(gameId) {
        const key = this._ctcKey(gameId);
        let sheets = this._ctcByGame.get(key);
        if (!sheets) {
            sheets = [];
            this._ctcByGame.set(key, sheets);
            while (this._ctcByGame.size > ZugwiseAPI.CTC_MAX_GAMES) {
                this._ctcByGame.delete(this._ctcByGame.keys().next().value);
            }
        }
        return sheets;
    }

    /**
     * A sidecar's bytes are usable only if their cell count equals the ply
     * list. Plies are POSITIONAL (entry i of the sidecar is plies[i]), so a
     * mismatch does not degrade, it attaches one move's handwriting to another.
     */
    _ctcSheetOk(data, plies) {
        if (!data || !plies || !plies.length) return false;
        if (typeof LogitsIO !== 'undefined' && LogitsIO.decode) {
            let nCells = null;
            try {
                nCells = LogitsIO.decode(data).nCells;
            } catch (e) {
                console.warn('[CTC] sidecar unreadable, skipping:', e.message);
                return false;
            }
            if (nCells !== plies.length) {
                console.warn('[CTC] sidecar has ' + nCells + ' cells but the text has ' +
                             plies.length + ' — refusing it rather than misaligning the evidence.');
                return false;
            }
        }
        return true;
    }

    /**
     * The logits for one game, as {data, plies} per sheet, in preference order.
     * Handed to the search worker so greedy/beam/dijkstra rank on the SAME
     * evidence as the interactive panel — the divergence that made the
     * algorithms pick a 4.W fabrication over the correct 7.W Bg5.
     *
     * With no argument: the game under REVIEW (the interactive panel's game).
     * Background reconstruction MUST pass the game it is reconstructing — the
     * reviewed game is a different game most of the time.
     * Missing evidence is a lost improvement. Wrong evidence is a wrong answer.
     */
    getCtcSheets(gameId) {
        const key = arguments.length ? this._ctcKey(gameId)
                                     : this._ctcKey(this._reviewGameTag);
        return this._ctcByGame.get(key) || [];
    }

    /**
     * Install the REVIEWED game's logits into this worker's Python namespace.
     * With none, CLEAR the installed default — a no-op would leave the
     * previous install (possibly from before a re-OCR) scoring this game.
     */
    async installCtcLogits() {
        const sheets = this.getCtcSheets();
        if (!sheets.length) {
            await this._send('clear-ctc-logits', {});
            return { plies: 0 };
        }
        return this._send('set-ctc-logits', { sheets });
    }

    /**
     * Replace one game's logits with the given sheets ({data, plies}, in
     * preference order — the first sheet to cover a ply wins). Each sheet is
     * checked by _ctcSheetOk and dropped individually if it fails.
     *
     * The batch OCR queue calls this once per game, on a cache hit AND after a
     * fresh pass, from the same sidecar bytes and the same page-aware plies —
     * so a game ranks on identical evidence whether or not it was just OCR'd.
     */
    async setGameCtcSheets(gameId, sheets) {
        const kept = (sheets || []).filter((s) => s && this._ctcSheetOk(s.data, s.plies))
                                   .map((s) => ({ data: s.data, plies: s.plies }));
        const key = this._ctcKey(gameId);
        this._ctcByGame.delete(key);          // re-insert = most recently used
        this._ctcSheetsFor(gameId).push(...kept);
        if (key === this._ctcKey(this._reviewGameTag)) await this.installCtcLogits();
        return { sheets: kept.length };
    }

    /**
     * Install the move prior for `moves` into this worker's Python namespace.
     *
     * Called by EVERY path that ranks fixes in this worker, which is the whole
     * point: findFixes and createBacktrackState both end in
     * _postprocess_phase2_fixes, and for a while only the first of them
     * installed the prior. The streaming backtrack path is the one that fills
     * the "Deep Search (backtracking)" list, so the panel the user reads was
     * ranking without a signal the algorithms had — the panel/algorithm
     * divergence this project keeps re-creating at a new layer (it was CTC
     * last time, applied in JS for the panel only).
     *
     * The table is keyed by POSITION, so installing it for one move list and
     * having the state evolve underneath is safe: an entry either describes the
     * position being ranked or is absent, and absent abstains.
     *
     * Every skip is LOGGED. They were silent, and a silent skip is
     * indistinguishable from a prior that simply did not change the order —
     * which is what made this disagreement impossible to attribute from a log.
     */
    async _installMovePrior(moves, who) {
        try {
            if (typeof window === 'undefined' || !window.MovePriorClient) {
                console.warn('[PRIOR] ' + who + ': MovePriorClient not loaded — ranking WITHOUT the prior');
                return;
            }
            const table = await window.MovePriorClient.tableFor(moves || []);
            const n = table ? Object.keys(table).length : 0;
            if (n) {
                await this._send('set-move-prior', { table });
            } else {
                console.warn('[PRIOR] ' + who + ': empty table for ' + (moves || []).length +
                             ' moves — ranking WITHOUT the prior');
            }
        } catch (e) {
            console.warn('[PRIOR] ' + who + ' ranking without the prior:', e.message);
        }
    }

    /**
     * Re-attach one sheet's logits from its on-disk `.logits.bin` sidecar.
     *
     * The fresh-OCR path accumulates _ctcSheets as it decodes each sheet. A
     * CACHE HIT runs no OCR, so nothing accumulated and getCtcSheets() returned
     * empty — constrainedReOCR then answered "No stored logits for ply N" and
     * every reopened tournament reconstructed without the CTC signal, silently.
     * The sidecar had been written on the first pass and never read back.
     *
     * `data` is the sidecar's bytes verbatim: the file format IS the wire
     * format set-ctc-logits hands to Python's LazyPlyLogits, so nothing is
     * decoded in JS on the way through.
     *
     * REFUSES on a cell/ply count mismatch rather than installing. The plies
     * are positional — entry i of the sidecar is plies[i] — so a short or long
     * list does not degrade, it attaches one move's handwriting to another
     * move. Refusing loses the signal for this game; accepting corrupts the
     * ranking with confident nonsense. Same rule as exportLogits' stale-pass
     * check on the way out.
     */
    async addCachedCtcSheet(data, plies) {
        if (!this._ctcSheetOk(data, plies)) return { plies: 0 };
        // Appends to the game currently being OCR'd. The batch queue now uses
        // setGameCtcSheets (explicit game, replace); kept for other callers.
        this._ctcSheetsFor(this._ocrGameTag).push({ data: data, plies: plies });
        return this.installCtcLogits();
    }

    /** Forget ALL stored logits (every game) and the installed default. */
    clearCtcLogits() {
        this._ctcByGame.clear();
        try { this._send('clear-ctc-logits', {}); } catch (e) { /* worker may be down */ }
    }

    /**
     * Tag the game currently under REVIEW. Distinct from the OCR tag because
     * batch OCR runs ahead: the user reviews game 3 while game 7 is being
     * scanned, and the two must not be confused.
     */
    setReviewGameTag(gameId) {
        this._reviewGameTag = gameId || null;
        try {
            if (typeof window !== 'undefined' && window.MovePriorClient
                    && window.MovePriorClient.clearCache) {
                window.MovePriorClient.clearCache();
            }
        } catch (e) { /* never fatal */ }
        // Keep the Python-side default in step with the guard above: install
        // this game's logits, or clear whatever a previous game left behind.
        try {
            if (this.getCtcSheets().length) {
                this.installCtcLogits();
            } else {
                this._send('clear-ctc-logits', {});
            }
        } catch (e) {
            console.warn('[CTC] Could not update installed logits:', e.message);
        }
        // Drop the previous game's move-prior table AND the client-side
        // position cache. The table itself is position-keyed and so cannot be
        // wrong across a game switch (a key either matches the position being
        // ranked or is absent), but the cache would keep the previous game's
        // positions alive for the rest of the session for no benefit.
        try {
            this._send('clear-move-prior', {});
        } catch (e) { /* worker may be down */ }
    }

    async findFixes(moves, stuckAt, ocrMoves, minPly, fixedPlies, phase2Depth, lockedPlies) {
        // The CTC term is applied INSIDE Python (fix_finding.apply_ctc_rescore),
        // using the logits installed by installCtcLogits. It used to be applied
        // here in JS, which meant the interactive panel had the signal and the
        // greedy/beam/dijkstra searches did not — the two then ranked the same
        // 50 candidates differently, which is how the algorithms came to prefer
        // a 4.W fabrication (134) over the correct 7.W Bg5 (113). One
        // implementation, one ranking.
        //
        // The move prior is installed the same way, from the CURRENT move list
        // rather than the OCR reads: the panel ranks candidates against the
        // board the user is looking at, which already carries their accepted
        // fixes. Awaited before the request so the table is in place when
        // Python ranks; every failure path yields {} and the panel simply ranks
        // without the signal.
        await this._installMovePrior(moves, 'fix panel');
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

    /**
     * Collect stored per-cell logits for the .logits.bin sidecar.
     *
     * @param {string[]} keys - cell keys ("<moveNum>_<color>", or
     *        "..._sheet<N>" in dual-sheet mode), in sidecar order
     * @param {string} pass - OCR pass token; stale entries are skipped
     * @returns {Promise<{seqLen:number|null, vocabSize:number|null, cells:Object}>}
     *          `cells` maps key -> Float32Array; keys never OCR'd are absent.
     */
    async exportLogits(keys, pass) {
        if (USE_OCR_POOL && this.ocrPool) {
            return this.ocrPool.exportLogits(keys, pass);
        }
        return this._send('export-logits', { keys, pass });
    }

    // =========================================================================
    // STREAMING BACKTRACK SEARCH
    // =========================================================================

    /**
     * Create a backtrack search state. Returns state info including stateId.
     */
    async createBacktrackState(moves, stuckAt, ocrMoves, minPly, fixedPlies, phase2Depth, lockedPlies, stuckReason) {
        // Same evidence as findFixes and as the algorithms — see _installMovePrior.
        // This is the path that fills the Deep Search list the user actually reads.
        await this._installMovePrior(moves, 'deep search');
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

        // One token per sheet-OCR call. storedLogits keys ("<moveNum>_<color>")
        // are NOT unique across a batch run — page 2 restarts move numbering,
        // and every game has a 1_w — and entries are never evicted, so a key
        // holds whichever pass wrote it last. Stamping each cell lets the
        // export reject anything not from THIS pass, which turns a silent
        // cross-game mix-up into a refused sidecar.
        //
        // Today the loops are strictly sequential (one page, then the next;
        // one game, then the next), so nothing is stale by the time we export.
        // This exists so that parallelising either loop later cannot quietly
        // corrupt the evidence.
        this._ocrPassSeq = (this._ocrPassSeq || 0) + 1;
        const _ocrPass = `p${this._ocrPassSeq}`;

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
            const moveInfo = { num: cell.moveNumber, color: cell.color, pass: _ocrPass,
                               game: this._ocrGameTag || null };
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
                `  postMessage cost : ${fmt(_sum.rtOverhead)}  | ${fmtAvg(_sum.rtOverhead)}  (roundtrip − workerWall; mostly QUEUE WAIT when pool>1, not transport)`
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

        // Collect this PAGE's raw CTC logits for the .logits.bin sidecar.
        // Gathered HERE because this is the only place holding the cell order
        // and the sheetId together — the same order the .txt is written in,
        // which is what the sidecar format requires.
        //
        // Returned UNENCODED: one .p1.txt can span several page images, so the
        // caller concatenates pages before encoding. Encoding here would
        // produce one file per page and there is nowhere to put them.
        //
        // Best-effort by construction: any failure leaves logitsCells null,
        // meaning the CTC signal is unavailable for this game and nothing else
        // changes. It must never take down an OCR run that otherwise succeeded.
        let logitsCells = null;
        try {
            logitsCells = await this._collectLogitsCells(result.cells, sheetId, _ocrPass);
            if (logitsCells && typeof LogitsIO !== 'undefined') {
                // Keep an encoded copy per sheet: the sidecar format is already
                // what both Python readers understand, so the browser, the
                // search worker and the recorder all consume the same bytes.
                // Interim, per page, printed move numbers: batch mode REPLACES
                // this game's entry when the whole game is done
                // (BatchOcrQueue -> setGameCtcSheets, page-aware plies).
                this._ctcSheetsFor(this._ocrGameTag).push({
                    data: LogitsIO.encode(logitsCells.data.map((d) => ({
                        data: d, seqLen: logitsCells.seqLen, vocabSize: logitsCells.vocabSize
                    }))),
                    plies: result.cells.map((c) => (c.moveNumber - 1) * 2 + (c.color === 'w' ? 0 : 1))
                });
                // Only the reviewed game's logits live in the panel worker;
                // a page of a game running ahead changes nothing there.
                if (this._ctcKey(this._ocrGameTag) === this._ctcKey(this._reviewGameTag)) {
                    await this.installCtcLogits();
                }
            }
        } catch (e) {
            // NB: sheetTag is const-scoped to the OCR_TIMING block above.
            console.warn('[Logits] Not collected for sheet ' + (sheetId || '1') + ':', e.message);
        }

        return {
            moves: filteredMoves,
            has_grid_image: true,
            warnings: result.warnings || [],
            // "This template does not match this page" — the caller (batch or
            // single-sheet) is responsible for showing it. Dropping it here is
            // how a whole round got OCR'd against the wrong profile in silence.
            templateWarning: result.templateWarning || null,
            gridOverlayUrl: result.gridOverlayUrl || null,
            rowsPerColumn: result.rowsPerColumn || null,
            imageWidth: gridWidth,
            imageHeight: gridHeight,
            logitsCells: logitsCells
        };
    }

    /**
     * Gather one page's stored logits, in cell order, for the sidecar.
     *
     * Returns null — never throws to the caller — when the signal is simply
     * unavailable: nothing stored, or a page whose cells were not all OCR'd.
     * A PARTIAL page is refused deliberately. The format is a flat array
     * indexed by position and the reader pairs cell i with OCR move i, so a
     * file with holes would attach one move's logits to another. That is worse
     * than no sidecar, and unlike a missing file it would not be obvious.
     *
     * @param {Array} cells - grid cells in sidecar order
     * @param {number|string|null} sheetId - dual-sheet id, if any
     * @returns {Promise<{seqLen:number, vocabSize:number, data:Float32Array[]}|null>}
     */
    async _collectLogitsCells(cells, sheetId, pass) {
        if (!cells || !cells.length) return null;

        const keys = cells.map((c) => {
            const base = `${c.moveNumber}_${c.color}`;
            return sheetId ? `${base}_sheet${sheetId}` : base;
        });
        const got = await this.exportLogits(keys, pass);
        if (!got || !got.cells || got.seqLen === null) return null;

        const missing = keys.filter((k) => !got.cells[k]).length;
        if (missing) {
            const staleNote = got.stale
                ? ` (${got.stale} belonged to a later OCR pass — another page or game)`
                : '';
            console.warn(`[Logits] ${missing}/${keys.length} cell(s) had no stored ` +
                         `logits${staleNote} — page skipped rather than recorded with holes`);
            return null;
        }

        return {
            seqLen: got.seqLen,
            vocabSize: got.vocabSize,
            data: keys.map((k) => got.cells[k])
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

// Games whose CTC logits are kept in memory (LRU). ~0.4 MB per sheet-page.
ZugwiseAPI.CTC_MAX_GAMES = 64;

// Global instance
window.zugwise = new ZugwiseAPI();
