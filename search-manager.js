// =============================================================================
// search-manager.js - Manages background search workers with streaming progress
// =============================================================================
// Spawns search-worker.js instances (separate Pyodide, no ONNX).
// Uses streaming protocol: search-create → search-step → search-finalize
// Each method gets its own worker running in true parallel.
// =============================================================================

var SearchManager = (function() {

    function SearchManager() {
        this.workers = {};       // method -> Worker
        this.statuses = {};      // method -> 'idle'|'loading'|'running'|'complete'|'error'
        this.results = {};       // method -> final result
        this.cancelFlags = {};   // method -> boolean
        this.nextId = {};        // method -> counter

        // Callbacks for UI
        this.onStepUpdate = null;   // function(method, stepData)
        this.onComplete = null;     // function(method, result)
        this.onStatusChange = null; // function(method, status)

        // Track user-locked plies
        this.lockedPlies = new Set();
    }

    /**
     * Launch streaming searches for given methods.
     * @param {Array} ocrMoves - OCR data [{num, color, move, confidence, alternatives}]
     * @param {Array<string>} methods - ['greedy', 'beam'] or ['greedy', 'beam', 'dijkstra']
     * @param {Object} methodOptions - per-method options, e.g. { greedy: {max_fixes: 15}, beam: {beam_width: 5} }
     */
    SearchManager.prototype.launchSearches = function(ocrMoves, methods, methodOptions, lockedPlies) {
        methods = methods || ['greedy', 'beam'];
        methodOptions = methodOptions || {};

        // If caller passes the current locked-plies array, rebuild the singleton
        // set before launch so merge-locked plies and user confirmations are
        // honored by every algorithm — not only by sendUserFix additions.
        if (Array.isArray(lockedPlies)) {
            this.lockedPlies.clear();
            var selfL = this;
            lockedPlies.forEach(function(p) { selfL.lockedPlies.add(p | 0); });
        }

        var self = this;
        methods.forEach(function(method) {
            self._launchStreamingWorker(method, ocrMoves, methodOptions[method] || {});
        });
    };

    /**
     * Cancel a specific method's search.
     */
    SearchManager.prototype.cancelMethod = function(method) {
        this.cancelFlags[method] = true;
    };

    /**
     * Cancel all running searches.
     */
    SearchManager.prototype.cancel = function() {
        var self = this;
        Object.keys(this.workers).forEach(function(method) {
            self.cancelFlags[method] = true;
        });
    };

    /**
     * Send a live user fix hint to all running workers.
     */
    SearchManager.prototype.sendUserFix = function(ply, san) {
        this.lockedPlies.add(ply);
        var self = this;
        Object.keys(this.workers).forEach(function(method) {
            if (self.workers[method] && self.statuses[method] === 'running') {
                self.workers[method].postMessage({
                    type: 'user_fix',
                    data: { ply: ply, san: san }
                });
            }
        });
    };

    /** Check if any search is running */
    Object.defineProperty(SearchManager.prototype, 'isRunning', {
        get: function() {
            var self = this;
            return Object.keys(self.statuses).some(function(m) {
                return self.statuses[m] === 'running' || self.statuses[m] === 'loading';
            });
        }
    });

    // =========================================================================
    // INTERNAL: Launch one streaming worker
    // =========================================================================

    SearchManager.prototype._launchStreamingWorker = function(method, ocrMoves, options) {
        var self = this;

        // Terminate existing worker for this method
        if (this.workers[method]) {
            this.workers[method].terminate();
        }

        this.statuses[method] = 'loading';
        this.results[method] = null;
        this.cancelFlags[method] = false;
        this.nextId[method] = 1;

        if (this.onStatusChange) this.onStatusChange(method, 'loading');

        var worker = new Worker('search-worker.js');
        this.workers[method] = worker;

        // Promise-based message passing
        var callbacks = {};

        worker.onmessage = function(e) {
            var msg = e.data;

            if (msg.type === 'status') {
                console.log('[' + method + '] ' + msg.message);
                return;
            }

            if (msg.type === 'ready') {
                // Worker is ready - start the streaming search
                self.statuses[method] = 'running';
                if (self.onStatusChange) self.onStatusChange(method, 'running');
                self._runStreamingLoop(method, ocrMoves, options, callbacks);
                return;
            }

            if (msg.type === 'error' && !msg.id) {
                self.statuses[method] = 'error';
                if (self.onStatusChange) self.onStatusChange(method, 'error');
                console.error('[' + method + '] Worker error:', msg.error || msg.message);
                return;
            }

            // Handle response to specific request
            var cb = callbacks[msg.id];
            if (cb) {
                delete callbacks[msg.id];
                if (msg.type === 'error') {
                    cb.reject(new Error(msg.error));
                } else {
                    cb.resolve(msg.result);
                }
            }
        };

        worker.onerror = function(e) {
            self.statuses[method] = 'error';
            if (self.onStatusChange) self.onStatusChange(method, 'error');
            console.error('[' + method + '] Worker error:', e.message);
        };

        // Store send helper on the worker
        worker._send = function(type, data) {
            return new Promise(function(resolve, reject) {
                var id = self.nextId[method]++;
                callbacks[id] = { resolve: resolve, reject: reject };
                worker.postMessage({ id: id, type: type, data: data });
            });
        };

        // Start initialization
        worker.postMessage({ type: 'init' });
    };

    // =========================================================================
    // INTERNAL: Run the step loop for one method
    // =========================================================================

    SearchManager.prototype._runStreamingLoop = async function(method, ocrMoves, options, callbacks) {
        var self = this;
        var worker = this.workers[method];
        if (!worker) return;

        try {
            // Merge default options per method
            var opts = {};
            if (method === 'greedy') {
                opts.max_fixes = (options && options.max_fixes) || 15;
            } else if (method === 'beam') {
                opts.beam_width = (options && options.beam_width) || 5;
                opts.max_iterations = (options && options.max_iterations) || 20;
                opts.max_fixes_per_path = (options && options.max_fixes_per_path) || 10;
            } else if (method === 'dijkstra') {
                opts.max_queue_size = (options && options.max_queue_size) || 50;
                opts.max_steps = (options && options.max_steps) || 1000;
                opts.max_fixes_per_path = (options && options.max_fixes_per_path) || 15;
            }
            // Review-requeue frontier: tells the worker to never propose
            // fixes for plies < confirmed_ply (only greedy honors this today).
            if (options && options.confirmed_ply) {
                opts.confirmed_ply = options.confirmed_ply | 0;
            }
            // Backtrack lookback cap. Mirrors the user's Deep Search Depth
            // setting so Greedy/Beam/Dijkstra consider the same candidate
            // pool the interactive Deep Search panel does. Explicit option
            // wins, then currentSettings.deep_search_depth, then default 5.
            var _maxBacktrack;
            if (options && options.max_backtrack != null) {
                _maxBacktrack = options.max_backtrack | 0;
            } else if (typeof window !== 'undefined' &&
                       window.currentSettings &&
                       typeof window.currentSettings.deep_search_depth === 'number') {
                _maxBacktrack = window.currentSettings.deep_search_depth | 0;
            } else {
                _maxBacktrack = 5;
            }
            opts.max_backtrack = _maxBacktrack;

            // Create search state
            var stateInfo = await worker._send('search-create', {
                ocrMoves: ocrMoves,
                method: method,
                options: opts,
                lockedPlies: Array.from(this.lockedPlies)
            });

            var stateId = stateInfo.stateId;

            // Report initial info
            if (self.onStepUpdate) {
                self.onStepUpdate(method, {
                    done: false,
                    message: method + ' search: ' + stateInfo.totalPlies + ' plies',
                    totalPlies: stateInfo.totalPlies
                });
            }

            // Step loop
            var done = false;
            while (!done) {
                if (self.cancelFlags[method]) {
                    await worker._send('search-finalize', { stateId: stateId });
                    if (self.onStepUpdate) {
                        self.onStepUpdate(method, { done: true, status: 'CANCELLED', message: 'Cancelled' });
                    }
                    break;
                }

                var step = await worker._send('search-step', { stateId: stateId });
                done = step.done;

                // Report step to UI
                if (self.onStepUpdate) {
                    self.onStepUpdate(method, step);
                }
            }

            // Finalize
            if (!self.cancelFlags[method]) {
                var result = await worker._send('search-finalize', { stateId: stateId });
                self.results[method] = result;
                self.statuses[method] = 'complete';

                if (self.onComplete) self.onComplete(method, result);
                if (self.onStatusChange) self.onStatusChange(method, 'complete');
            } else {
                self.statuses[method] = 'idle';
                if (self.onStatusChange) self.onStatusChange(method, 'idle');
            }

        } catch (e) {
            console.error('[' + method + '] Streaming error:', e.message);
            self.statuses[method] = 'error';
            if (self.onStatusChange) self.onStatusChange(method, 'error');
            if (self.onStepUpdate) {
                self.onStepUpdate(method, { done: true, status: 'ERROR', message: 'Error: ' + e.message });
            }
        }

        // Terminate worker after search completes (free memory)
        if (worker) {
            worker.terminate();
            delete self.workers[method];
        }
    };

    // =========================================================================
    // Background / headless launch — for batch reconstruction queue
    // =========================================================================
    //
    // Promise-wrapped variant that takes per-call callbacks instead of using
    // the instance-level onStepUpdate/onComplete/onStatusChange fields.
    //
    // Typical use (from batch-reconstruct-queue.js):
    //     var mgr = new SearchManager();  // fresh instance, NOT window.searchManager
    //     var results = await mgr.launchSearchesPromise(ocrMoves,
    //         ['greedy','beam','dijkstra'], methodOptions, {
    //             onStepUpdate: function(method, step) { ... },
    //             onStatusChange: function(method, status) { ... }
    //         });
    //     // results = { greedy: {status,moves,fixes}, beam: {...}, dijkstra: {...} }
    //
    // Uses a fresh instance so background work does not clobber the UI
    // singleton's worker pool, statuses, or callbacks. Per-call callbacks are
    // restored at settle time so a re-used instance is still safe.

    SearchManager.prototype.launchSearchesPromise = function(ocrMoves, methods, methodOptions, callbacks, lockedPlies) {
        var self = this;
        methods = methods || ['greedy', 'beam'];
        methodOptions = methodOptions || {};
        callbacks = callbacks || {};

        var prevStepUpdate = self.onStepUpdate;
        var prevStatusChange = self.onStatusChange;
        var prevComplete = self.onComplete;

        return new Promise(function(resolve) {
            var settled = {};
            var results = {};
            var resolved = false;

            function markDone(method, result) {
                if (resolved) return;
                if (settled[method]) return;  // don't double-count per method
                settled[method] = true;
                if (result !== undefined && result !== null) {
                    results[method] = result;
                }
                var allDone = methods.every(function(m) { return settled[m]; });
                if (allDone) {
                    resolved = true;
                    self.onStepUpdate = prevStepUpdate;
                    self.onStatusChange = prevStatusChange;
                    self.onComplete = prevComplete;
                    resolve(results);
                }
            }

            self.onStepUpdate = function(method, step) {
                if (callbacks.onStepUpdate) {
                    try { callbacks.onStepUpdate(method, step); } catch (e) {}
                }
            };
            self.onStatusChange = function(method, status) {
                if (callbacks.onStatusChange) {
                    try { callbacks.onStatusChange(method, status); } catch (e) {}
                }
                // Terminal non-complete statuses also settle the method so
                // cancelled/errored methods don't leave the promise hanging.
                if (status === 'error' || status === 'idle') {
                    markDone(method, null);
                }
            };
            self.onComplete = function(method, result) {
                markDone(method, result);
            };

            self.launchSearches(ocrMoves, methods, methodOptions, lockedPlies);
        });
    };

    return SearchManager;
})();

// UI singleton — foreground/interactive searches use this.
// Background batch jobs should instantiate their own `new SearchManager()`.
window.searchManager = new SearchManager();
window.SearchManager = SearchManager;
