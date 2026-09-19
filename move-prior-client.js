/**
 * move-prior-client.js — main-thread lifecycle for move-prior-worker.js.
 *
 * One object, `window.MovePriorClient`, that the launch sites can call without
 * knowing anything about workers or ONNX:
 *
 *     const table = await MovePriorClient.tableFor(sans);   // {} if unavailable
 *
 * EVERY FAILURE PATH RETURNS {}. No model deployed, worker refused to start,
 * ORT missing, network down mid-fetch — all of them mean "no evidence", and
 * fix_finding.apply_prior_rescore treats an empty table as the signal being
 * absent rather than as every candidate scoring badly. That asymmetry is the
 * whole safety property here: a prior that fails silently costs an improvement,
 * while a prior that fails LOUDLY (throwing into a search launch) would cost the
 * search. Never let this module throw into a caller.
 *
 * The model is loaded lazily on first use. It is ~1.2 MB and most sessions
 * never open a fix panel at all, so paying for it at page load would be a
 * regression for the common case.
 */
(function (root) {
    'use strict';

    var worker = null;
    var initPromise = null;
    var disabled = false;      // set once a load has definitively failed
    var seq = 0;
    var pending = {};
    var meta = null;

    function ensureWorker() {
        if (disabled) return Promise.resolve(null);
        if (initPromise) return initPromise;

        initPromise = new Promise(function (resolve) {
            try {
                worker = new Worker('move-prior-worker.js');
            } catch (e) {
                console.warn('[PRIOR] worker could not start:', e && e.message);
                disabled = true;
                return resolve(null);
            }
            worker.onmessage = function (ev) {
                var m = ev.data || {};
                var p = pending[m.id];
                if (!p) return;
                delete pending[m.id];
                if (m.type === 'error') p.reject(new Error(m.error));
                else p.resolve(m.result);
            };
            worker.onerror = function (err) {
                console.warn('[PRIOR] worker error:', err && err.message);
                // Fail the whole client rather than leaving callers hanging on
                // promises that will never settle.
                Object.keys(pending).forEach(function (k) {
                    pending[k].resolve({});
                    delete pending[k];
                });
                disabled = true;
            };
            send('init', {}).then(function (r) {
                meta = r && r.meta;
                if (meta) {
                    console.log('[PRIOR] model ready: ' + meta.blocks + 'x' + meta.filters +
                                ', move-match ' + (meta.val_move_match || 0).toFixed(4));
                }
                resolve(worker);
            }).catch(function (e) {
                console.warn('[PRIOR] model unavailable, ranking without it:', e && e.message);
                disabled = true;
                resolve(null);
            });
        });
        return initPromise;
    }

    function send(type, data) {
        return new Promise(function (resolve, reject) {
            var id = ++seq;
            pending[id] = { resolve: resolve, reject: reject };
            worker.postMessage({ id: id, type: type, data: data });
        });
    }

    /**
     * {ply: {san: logProb}} for the given move list, or {} if the prior is not
     * available for any reason.
     */
    // Accumulated {positionKey: {san: logProb}} for this game.
    //
    // The table is keyed by POSITION, which is what makes a cache possible at
    // all: an entry is true about that position for ever, so two different move
    // lists that pass through it share the work, and a line that is re-scored
    // after a fix only pays for the positions the fix actually changed.
    //
    // This is what makes refreshing affordable. The first attempt at coverage
    // (e6f9f99) re-scored the WHOLE prefix on every step through the single
    // shared prior worker and stalled dijkstra for 39s on one branch; it was
    // reverted in acfd030. Scoring only unseen positions is the difference.
    var cache = {};
    var cacheKeys = 0;

    function clearCache() { cache = {}; cacheKeys = 0; }

    /** Position key = the 4 FEN fields the network reads. Must match
     *  MovePrior.positionKey (worker side) and fix_finding.position_key
     *  (Python), including the RAW en-passant square. */
    function positionKey(fen) {
        return String(fen).trim().split(/\s+/).slice(0, 4).join(' ');
    }

    /**
     * {positionKey: {san: logProb}} for the line `sans`, or {} if unavailable.
     *
     * Replays locally, asks the worker to score ONLY the positions not already
     * cached, and returns the union. A call whose positions are all cached
     * costs one replay and no ONNX at all.
     */
    async function tableFor(sans, fromPly, toPly) {
        if (!sans || !sans.length) return {};
        var w = await ensureWorker();
        if (!w) return {};
        if (typeof Chess === 'undefined') {
            // No local replay available — fall back to the worker doing it.
            try {
                return await send('score-window', {
                    sans: sans, fromPly: fromPly || 0,
                    toPly: (toPly === undefined) ? sans.length : toPly
                }) || {};
            } catch (e) {
                console.warn('[PRIOR] scoring failed, ranking without it:', e && e.message);
                return {};
            }
        }
        try {
            // Replay the line, stopping at the first illegal move — nothing
            // after it is a real position.
            var game = new Chess();
            var seen = [];
            var limit = (toPly === undefined || toPly === null) ? sans.length
                                                                : Math.min(toPly, sans.length);
            for (var ply = 0; ply <= limit; ply++) {
                if (ply >= (fromPly || 0)) {
                    var fen = game.fen();
                    seen.push({ ply: ply, fen: fen, key: positionKey(fen) });
                }
                if (ply === limit) break;
                if (!game.move(sans[ply], { sloppy: true })) break;
            }

            var want = [];
            var wantKeys = {};
            for (var i = 0; i < seen.length; i++) {
                var k = seen[i].key;
                if (cache[k] === undefined && !wantKeys[k]) {
                    wantKeys[k] = true;
                    want.push({ ply: seen[i].ply, fen: seen[i].fen });
                }
            }

            if (want.length) {
                var scored = await send('score-positions', { entries: want }) || {};
                Object.keys(scored).forEach(function (k) {
                    if (cache[k] === undefined) cacheKeys++;
                    cache[k] = scored[k];
                });
            }

            var out = {};
            for (var j = 0; j < seen.length; j++) {
                var kk = seen[j].key;
                if (cache[kk] !== undefined) out[kk] = cache[kk];
            }
            return out;
        } catch (e) {
            console.warn('[PRIOR] scoring failed, ranking without it:', e && e.message);
            return {};
        }
    }

    function isAvailable() { return !disabled; }
    function getMeta() { return meta; }

    root.MovePriorClient = {
        tableFor: tableFor,
        clearCache: clearCache,
        isAvailable: isAvailable,
        getMeta: getMeta
    };
})(typeof window !== 'undefined' ? window : self);
