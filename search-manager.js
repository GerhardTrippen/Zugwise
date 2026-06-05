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
        // method -> array of review-ready applied fixes streamed from greedy
        // (greedy_step's 'applied_fix' event). Lets an instant Cancel rebuild a
        // PARTIAL result with full alternative detail without waiting for a
        // long in-flight step to finish.
        this.partialFixes = {};

        // Callbacks for UI
        this.onStepUpdate = null;   // function(method, stepData)
        this.onComplete = null;     // function(method, result)
        this.onStatusChange = null; // function(method, status)

        // Track user-locked plies
        this.lockedPlies = new Set();
        // Tier 1 candidate plies: plies where BOTH OCR sheets agreed on
        // the move (dual-sheet _agree && _sheetCount===2). Static — does
        // NOT depend on legality. Greedy uses this to recompute its
        // locked set after each applied fix, matching what the frontend's
        // classifyTiers would compute on a manual revalidate.
        this.tier1AgreedPlies = new Set();
    }

    /**
     * Launch streaming searches for given methods.
     * @param {Array} ocrMoves - OCR data [{num, color, move, confidence, alternatives}]
     * @param {Array<string>} methods - ['greedy', 'beam'] or ['greedy', 'beam', 'dijkstra']
     * @param {Object} methodOptions - per-method options, e.g. { greedy: {max_fixes: 15}, beam: {beam_width: 5} }
     */
    SearchManager.prototype.launchSearches = function(ocrMoves, methods, methodOptions, lockedPlies, tier1AgreedPlies) {
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
        // Tier 1 agreed plies: independent of legality. Greedy uses this to
        // re-evaluate its locked set after each applied fix, matching the
        // frontend's classifyTiers behavior on revalidate.
        if (Array.isArray(tier1AgreedPlies)) {
            this.tier1AgreedPlies.clear();
            var selfT = this;
            tier1AgreedPlies.forEach(function(p) { selfT.tier1AgreedPlies.add(p | 0); });
        }

        var self = this;
        methods.forEach(function(method) {
            self._launchStreamingWorker(method, ocrMoves, methodOptions[method] || {});
        });
    };

    /**
     * Cancel a specific method's search.
     *
     * Sets the cancel flag AND aborts any in-flight worker request. The cancel
     * flag alone only takes effect between steps — a single greedy step can
     * grind quiescence for minutes, and JS can't preempt Pyodide mid-call. So
     * we also reject the pending search-step promise (worker._abort) to unblock
     * the step loop immediately; the loop then rebuilds a PARTIAL result from
     * the fixes streamed so far and terminates the worker. Greedy keeps full
     * alternative detail because each fix's all_candidates were already shipped
     * via 'applied_fix' events before the worker is killed.
     */
    SearchManager.prototype.cancelMethod = function(method) {
        this.cancelFlags[method] = true;
        var worker = this.workers[method];
        if (worker && worker._abort) worker._abort();
    };

    /**
     * Cancel all running searches.
     */
    SearchManager.prototype.cancel = function() {
        var self = this;
        Object.keys(this.workers).forEach(function(method) {
            self.cancelFlags[method] = true;
            var worker = self.workers[method];
            if (worker && worker._abort) worker._abort();
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
        this.partialFixes[method] = [];

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

        // Abort all pending requests immediately (used by cancel). Rejecting
        // with __aborted lets the step loop distinguish a user cancel from a
        // real worker error and rebuild a PARTIAL from the streamed fixes. The
        // Pyodide call backing the pending request keeps running until the
        // worker is terminated at the end of the loop — that's fine, we no
        // longer await its result.
        worker._abort = function() {
            Object.keys(callbacks).forEach(function(id) {
                var cb = callbacks[id];
                delete callbacks[id];
                if (cb && cb.reject) cb.reject({ __aborted: true });
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
                lockedPlies: Array.from(this.lockedPlies),
                tier1AgreedPlies: Array.from(this.tier1AgreedPlies)
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

            // Step loop. The cancel flag is checked between steps; a long
            // in-flight step (greedy can grind quiescence for minutes) is
            // unblocked by worker._abort, which rejects the pending step
            // promise with __aborted so we can bail without waiting it out.
            var done = false;
            var aborted = false;
            while (!done) {
                if (self.cancelFlags[method]) { aborted = true; break; }

                var step;
                try {
                    step = await worker._send('search-step', { stateId: stateId });
                } catch (err) {
                    if (err && err.__aborted) { aborted = true; break; }
                    throw err;
                }
                done = step.done;

                // Accumulate greedy's review-ready applied fix (full detail,
                // incl. all_candidates) so an instant Cancel can rebuild a
                // PARTIAL without losing the alternatives.
                if (step && step.applied_fix) {
                    if (!self.partialFixes[method]) self.partialFixes[method] = [];
                    self.partialFixes[method].push(step.applied_fix);
                }

                // Report step to UI
                if (self.onStepUpdate) {
                    self.onStepUpdate(method, step);
                }
            }

            if (aborted) {
                // User cancelled. If fixes were streamed (greedy), rebuild a
                // PARTIAL result with full alternative detail and surface it
                // for Review instead of discarding the work. The worker is
                // terminated below; we never touch its Pyodide state again.
                var streamed = self.partialFixes[method] || [];
                if (streamed.length > 0) {
                    var partial = self._buildCancelledPartial(method, ocrMoves);
                    self.results[method] = partial;
                    self.statuses[method] = 'complete';
                    if (self.onComplete) self.onComplete(method, partial);
                    if (self.onStatusChange) self.onStatusChange(method, 'complete');
                } else {
                    // Nothing streamed to preserve (beam/dijkstra, or greedy
                    // cancelled before its first fix) — keep the old cancel UX.
                    if (self.onStepUpdate) {
                        self.onStepUpdate(method, { done: true, status: 'CANCELLED', message: 'Cancelled' });
                    }
                    self.statuses[method] = 'idle';
                    if (self.onStatusChange) self.onStatusChange(method, 'idle');
                }
            } else {
                // Natural completion — finalize as before.
                var result = await worker._send('search-finalize', { stateId: stateId });
                self.results[method] = result;
                self.statuses[method] = 'complete';

                if (self.onComplete) self.onComplete(method, result);
                if (self.onStatusChange) self.onStatusChange(method, 'complete');
            }

        } catch (e) {
            if (e && e.__aborted) {
                // Cancelled during a phase we can't preserve (e.g. the initial
                // search-create, before any fix streamed) — treat as a plain
                // cancel, not an error.
                self.statuses[method] = 'idle';
                if (self.onStatusChange) self.onStatusChange(method, 'idle');
                if (self.onStepUpdate) {
                    self.onStepUpdate(method, { done: true, status: 'CANCELLED', message: 'Cancelled' });
                }
            } else {
                console.error('[' + method + '] Streaming error:', e.message);
                self.statuses[method] = 'error';
                if (self.onStatusChange) self.onStatusChange(method, 'error');
                if (self.onStepUpdate) {
                    self.onStepUpdate(method, { done: true, status: 'ERROR', message: 'Error: ' + e.message });
                }
            }
        }

        // Terminate worker after search completes (free memory)
        if (worker) {
            worker.terminate();
            delete self.workers[method];
        }
    };

    // =========================================================================
    // INTERNAL: Build a PARTIAL result from fixes streamed before an instant
    // Cancel. Mirrors the shape searchFinalize returns (status/moves/fixes/
    // reached_ply/stop_*) so handleSearchComplete renders it — and enables
    // Review — exactly like a naturally-completed greedy PARTIAL. The fixes
    // carry full all_candidates detail (packaged by package_review_fix in the
    // worker before each 'applied_fix' event), so no alternatives are lost.
    // =========================================================================
    SearchManager.prototype._buildCancelledPartial = function(method, ocrMoves) {
        var fixes = (this.partialFixes[method] || []).slice();
        // Reconstruct the corrected move list: base SAN from the launched OCR
        // moves, then overlay each applied fix at its ply. Unfixed plies keep
        // their raw OCR text (they replayed legally, which is why greedy never
        // touched them). This matches how locked/unfixed plies appear in a
        // full finalize for the stale-check + board preview in beam.js.
        var moves = this._ocrMovesToSanList(ocrMoves);
        var maxFixPly = -1;
        fixes.forEach(function(f) {
            var p = (typeof f.ply === 'number') ? f.ply : -1;
            if (p >= 0 && p < moves.length) moves[p] = f.san;
            if (p > maxFixPly) maxFixPly = p;
        });
        return {
            status: 'PARTIAL',
            moves: moves,
            fixes: fixes,
            elapsed: 0,
            reached_ply: (maxFixPly >= 0) ? (maxFixPly + 1) : null,
            stop_reason: 'cancelled',
            stop_message: 'Cancelled — kept ' + fixes.length + ' fix(es) found ' +
                'so far. Review them or use the Fix Suggestions panel for the ' +
                'ranked candidates.'
        };
    };

    // Build a ply-indexed SAN array from the launched ocrMoves payload
    // ([{num, color, move, ...}]). Index = (num-1)*2 + (white?0:1).
    SearchManager.prototype._ocrMovesToSanList = function(ocrMoves) {
        var maxPly = -1;
        (ocrMoves || []).forEach(function(e) {
            var ply = (e.num - 1) * 2 + (e.color === 'w' ? 0 : 1);
            if (ply > maxPly) maxPly = ply;
        });
        var arr = [];
        for (var i = 0; i <= maxPly; i++) arr.push('');
        (ocrMoves || []).forEach(function(e) {
            var ply = (e.num - 1) * 2 + (e.color === 'w' ? 0 : 1);
            if (ply >= 0) arr[ply] = e.move;
        });
        return arr;
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

    SearchManager.prototype.launchSearchesPromise = function(ocrMoves, methods, methodOptions, callbacks, lockedPlies, tier1AgreedPlies) {
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

            self.launchSearches(ocrMoves, methods, methodOptions, lockedPlies, tier1AgreedPlies);
        });
    };

    return SearchManager;
})();

// UI singleton — foreground/interactive searches use this.
// Background batch jobs should instantiate their own `new SearchManager()`.
window.searchManager = new SearchManager();
window.SearchManager = SearchManager;
