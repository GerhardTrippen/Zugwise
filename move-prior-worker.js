// =============================================================================
// move-prior-worker.js - runs the human move prior (ONNX) off the main thread
// =============================================================================
// Its whole job: turn a move list into {ply: {san: logProb}} and hand that back.
// The table then goes to the Pyodide workers, where fix_finding scores with it.
//
// WHY A THIRD WORKER, rather than folding this into one of the two that exist:
//
//   - search-worker.js declares "NO ONNX" in its header and means it; it is the
//     lightweight Pyodide worker and loading a model there would undo that.
//   - zugwise-worker.js does have ONNX, but it is the OCR worker and is busy
//     exactly when a game is being scanned.
//   - the main thread must not run a 150-position batch inline; that is a
//     visible stall in the middle of a click.
//
// So the model gets one small worker with one responsibility. It holds ORT and
// chess.js and nothing else.
//
// It produces DATA, never a ranking. Ranking happens in Python, in one place —
// that was settled in d61c66c after the panel and the algorithms were found
// ranking the same candidates differently.
// =============================================================================

importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.12.0/chess.min.js');
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/ort.min.js');
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/';
importScripts('move-prior.js');

let ready = false;

// WHERE THE WEIGHTS COME FROM. *.onnx is gitignored project-wide, so like the
// BiLSTM the move prior ships from HuggingFace rather than the repo. A local
// build (backend/move_prior/export_onnx.py writes frontend/models/) is tried
// FIRST so that re-training and testing needs no upload; the hosted copy is the
// fallback that makes the deployed site work.
//
// UNTIL THAT UPLOAD EXISTS this whole path is inert, exactly as the CTC signal
// was inert until something wrote the sidecar: no model, empty table, Python
// treats it as no evidence, ranking is unchanged.
const MOVE_PRIOR_LOCAL_URL = 'models/move-prior.onnx';
const MOVE_PRIOR_MODEL_URL =
    'https://huggingface.co/GerhardTrippen/chess-move-prior/resolve/main/move-prior.onnx';

async function init(modelUrl, metaUrl) {
    // Resolve against the worker's own location so this works under any deploy
    // path (github.io/Zugwise/ included) — the same reason the vendored chess
    // wheel is resolved that way in search-worker.js.
    const meta = new URL(metaUrl || 'models/move-prior.json', self.location).href;
    const candidates = modelUrl
        ? [modelUrl]
        : [new URL(MOVE_PRIOR_LOCAL_URL, self.location).href, MOVE_PRIOR_MODEL_URL];

    let lastErr = null;
    for (const url of candidates) {
        try {
            await MovePrior.load(url, meta);
            ready = true;
            return { ready: true, source: url, meta: MovePrior.getMeta() };
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error('no move-prior model available (' +
                    (lastErr && lastErr.message ? lastErr.message : 'unknown') + ')');
}

onmessage = async function (e) {
    const { id, type, data } = e.data || {};
    try {
        let result;
        switch (type) {
            case 'init':
                result = await init(data && data.modelUrl, data && data.metaUrl);
                break;

            case 'score-window':
                // A whole prefix is cheap — one batched forward pass over ~100
                // positions of a 1.2 MB net — and the search decides where to
                // backtrack only AFTER this runs, so scoring a window rather
                // than a guessed set of plies is what keeps the signal present
                // wherever the search goes.
                if (!ready) { result = {}; break; }
                result = await MovePrior.scoreWindow(
                    data.sans || [],
                    data.fromPly || 0,
                    (data.toPly === undefined || data.toPly === null)
                        ? (data.sans || []).length : data.toPly);
                break;

            case 'score-positions':
                result = ready ? await MovePrior.scorePositions(data.entries || []) : {};
                break;

            default:
                throw new Error('unknown message type: ' + type);
        }
        postMessage({ id, type: 'result', result });
    } catch (err) {
        // A prior that fails must cost the SIGNAL, never the search. The Python
        // side treats a missing table as "no evidence", which is exactly right.
        postMessage({ id, type: 'error', error: err && err.message ? err.message : String(err) });
    }
};
