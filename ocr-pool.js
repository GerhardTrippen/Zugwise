// =============================================================================
// ocr-pool.js - Main-thread manager for a pool of OCR workers
// =============================================================================
// Spawns N lightweight ocr-worker.js instances (ONNX + beam decode, no
// Pyodide) and dispatches per-cell OCR across them. Profiling established
// that runOCR is single-threaded-CPU-bound, so N workers ≈ N cores of speedup
// up to the grid-detection / overhead floor.
//
// STEP 1: size defaults to 1 (a pool of one). This is a behavior-preserving
// refactor — OCR moves out of zugwise-worker.js into a dedicated worker, but
// there is still exactly one of them, so output must be identical. Growing
// the pool (the actual speedup) is a later, isolated change: bump `size`.
//
// LOGIT AFFINITY (load-bearing even at size 1): constrained re-OCR reads
// storedLogits *inside* the worker that produced them. So the OCR for a ply
// and its later constrained re-OCR MUST land on the same worker. We route by
// ply: workerIndex = ply % size. In dual-sheet mode both sheets' copies of a
// ply therefore land on the same worker, so constrainedReOCRDual finds both
// sheet keys. Round-robin-by-ply also balances load. Do not change this to a
// next-idle scheduler without moving logits out of the workers first.
// =============================================================================

class OcrPool {
    constructor(size) {
        // Cap at a sensible ceiling; leave headroom for the main thread and the
        // Pyodide worker. hardwareConcurrency counts logical cores (hyperthreads
        // don't help SIMD-bound inference), so halving is intentional.
        const cores = (self.navigator && self.navigator.hardwareConcurrency) || 4;
        const auto = Math.max(1, Math.min(4, Math.floor(cores / 2)));
        this.size = size || auto;

        this.workers = [];
        // Per-worker callback maps and id counters (ids are only unique per worker).
        this.callbacks = [];
        this.nextId = [];
        // Per-worker FIFO queue + busy flag. We allow at most ONE in-flight
        // request per worker so the worker never starts a second
        // onnxSession.run() on the same session before the first resolves
        // (ORT-web concurrent run() on one session is unsupported / unbounded
        // in memory). Total concurrent inference is therefore capped at
        // this.size ≈ core count — exactly the parallelism we want, no more.
        this.queues = [];
        this.busy = [];
        this.onStatusChange = null;
        this.isReady = false;
    }

    async init(onStatus) {
        this.onStatusChange = onStatus || null;

        const readyPromises = [];

        for (let w = 0; w < this.size; w++) {
            const workerIndex = w;
            const worker = new Worker('ocr-worker.js');
            const callbacks = new Map();
            this.workers.push(worker);
            this.callbacks.push(callbacks);
            this.nextId.push(1);
            this.queues.push([]);
            this.busy.push(false);

            const readyPromise = new Promise((resolve, reject) => {
                worker.onmessage = (e) => {
                    const { id, type, result, error, message } = e.data;

                    if (type === 'status') {
                        if (this.onStatusChange) this.onStatusChange(message);
                        return;
                    }

                    if (type === 'ready') {
                        resolve();
                        return;
                    }

                    if (type === 'error' && !id) {
                        reject(new Error(error || message));
                        return;
                    }

                    const cb = callbacks.get(id);
                    if (cb) {
                        callbacks.delete(id);
                        if (type === 'error') cb.reject(new Error(error));
                        else cb.resolve(result);
                    }

                    // This worker just finished a request — free it and pump
                    // the next queued item (only id-bearing responses count).
                    if (id) {
                        this.busy[workerIndex] = false;
                        this._pump(workerIndex);
                    }
                };

                worker.onerror = (e) => reject(new Error(`OCR worker error: ${e.message}`));
            });

            readyPromises.push(readyPromise);
            worker.postMessage({ type: 'init' });
        }

        await Promise.all(readyPromises);
        this.isReady = true;
    }

    // Map a ply to a worker index. The single source of truth for affinity.
    _workerForPly(ply) {
        const p = (typeof ply === 'number' && ply >= 0) ? ply : 0;
        return p % this.size;
    }

    // Enqueue a request for a specific worker. _pump posts it when that worker
    // is idle, guaranteeing one in-flight inference per worker.
    _sendTo(workerIndex, type, data) {
        return new Promise((resolve, reject) => {
            if (!this.workers[workerIndex]) {
                reject(new Error(`OCR pool: no worker at index ${workerIndex}`));
                return;
            }
            this.queues[workerIndex].push({ type, data, resolve, reject });
            this._pump(workerIndex);
        });
    }

    // Post the next queued request to a worker if it is idle.
    _pump(workerIndex) {
        if (this.busy[workerIndex]) return;
        const queue = this.queues[workerIndex];
        if (queue.length === 0) return;

        const item = queue.shift();
        this.busy[workerIndex] = true;
        const id = this.nextId[workerIndex]++;
        this.callbacks[workerIndex].set(id, { resolve: item.resolve, reject: item.reject });
        this.workers[workerIndex].postMessage({ id, type: item.type, data: item.data });
    }

    // ---- OCR-specific dispatch (affinity by ply) ----------------------------

    runOCR(data) {
        const ply = OcrPool.plyFromMoveInfo(data && data.moveInfo);
        return this._sendTo(this._workerForPly(ply), 'ocr', data);
    }

    constrainedReOCR(ply, legalMoves, ocrMoves) {
        return this._sendTo(this._workerForPly(ply), 'constrained-reocr', { ply, legalMoves, ocrMoves });
    }

    constrainedReOCRDual(ply, legalMoves) {
        return this._sendTo(this._workerForPly(ply), 'constrained-reocr-dual', { ply, legalMoves });
    }

    // moveInfo carries {num, color}; derive the 0-indexed ply so OCR and its
    // later constrained re-OCR (which only knows ply) hash to the same worker.
    static plyFromMoveInfo(moveInfo) {
        if (!moveInfo || typeof moveInfo.num !== 'number') return 0;
        return (moveInfo.num - 1) * 2 + (moveInfo.color === 'w' ? 0 : 1);
    }

    terminate() {
        for (const w of this.workers) {
            try { w.terminate(); } catch (e) { /* ignore */ }
        }
        this.workers = [];
        this.callbacks = [];
        this.nextId = [];
        this.queues = [];
        this.busy = [];
        this.isReady = false;
    }
}

// Expose as a global for worker-api.js (loaded via <script> before it).
window.OcrPool = OcrPool;
