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
    SearchManager.prototype.launchSearches = function(ocrMoves, methods, methodOptions) {
        methods = methods || ['greedy', 'beam'];
        methodOptions = methodOptions || {};

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

    return SearchManager;
})();

window.searchManager = new SearchManager();
