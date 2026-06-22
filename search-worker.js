// =============================================================================
// search-worker.js - Lightweight Pyodide worker for background greedy/beam search
// =============================================================================
// NO ONNX, no image processing - just chess logic + reconstruction modules.
// Supports streaming step-by-step protocol:
//   search-create  → initialize search state, return metadata
//   search-step    → run ONE iteration, return progress
//   search-finalize → return final result and cleanup
// Also supports legacy single-shot 'reconstruct' for backward compat.
// =============================================================================

importScripts('python-loader.js');

let pyodide = null;
let isReady = false;

// Live user fixes received while search is running
let userFixes = {};  // ply -> san
let searchRunning = false;

async function initSearchWorker() {
    try {
        postMessage({ type: 'status', message: 'Loading Pyodide...' });

        importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
        pyodide = await loadPyodide({
            indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
            packages: ['micropip']
        });

        postMessage({ type: 'status', message: 'Installing python-chess...' });
        // Vendored wheel for true offline install (precached by the service worker).
        // Resolve against the worker's own location so it works under any deploy path
        // (e.g. github.io/Zugwise/). Fall back to PyPI if the local file is missing.
        const chessWheelUrl = new URL('vendor/chess-1.10.0-py3-none-any.whl', self.location).href;
        pyodide.globals.set('CHESS_WHEEL_URL', chessWheelUrl);
        await pyodide.runPythonAsync(`
import micropip
try:
    await micropip.install(CHESS_WHEEL_URL)
except Exception:
    await micropip.install('chess')  # network fallback
        `);

        postMessage({ type: 'status', message: 'Loading reconstruction modules...' });
        await loadPythonModules(pyodide);

        isReady = true;
        postMessage({ type: 'ready' });

    } catch (error) {
        postMessage({ type: 'error', message: `Init failed: ${error.message}` });
    }
}

let searchStateCounter = 0;

onmessage = async function(e) {
    const { id, type, data } = e.data;

    if (!isReady && type !== 'init') {
        postMessage({ id, type: 'error', error: 'Worker not ready' });
        return;
    }

    try {
        let result;

        switch (type) {
            case 'init':
                await initSearchWorker();
                return;

            // =================================================================
            // STREAMING SEARCH PROTOCOL
            // =================================================================

            case 'search-create':
                result = await createSearchState(data.ocrMoves, data.method, data.options, data.lockedPlies, data.tier1AgreedPlies);
                break;

            case 'search-step':
                result = await searchStep(data.stateId);
                break;

            case 'search-finalize':
                result = await searchFinalize(data.stateId);
                break;

            // =================================================================
            // LEGACY SINGLE-SHOT (kept for backward compat)
            // =================================================================

            case 'reconstruct':
                searchRunning = true;
                userFixes = {};

                if (data.lockedPlies && data.lockedPlies.length > 0) {
                    await pyodide.runPythonAsync(
                        `_locked_plies = set(${JSON.stringify(data.lockedPlies)})`
                    );
                } else {
                    await pyodide.runPythonAsync(`_locked_plies = set()`);
                }
                await pyodide.runPythonAsync(`_user_fixes = {}`);

                result = await runReconstruction(
                    data.ocrMoves,
                    data.method,
                    data.options
                );
                searchRunning = false;
                break;

            case 'user_fix':
                userFixes[data.ply] = data.san;
                if (searchRunning) {
                    try {
                        const safeSan = data.san.replace(/'/g, "\\'");
                        await pyodide.runPythonAsync(
                            `_user_fixes[${data.ply}] = '${safeSan}'\n_locked_plies.add(${data.ply})`
                        );
                    } catch (e) {
                        console.log('Could not inject user fix:', e.message);
                    }
                }
                return;

            default:
                throw new Error(`Unknown message type: ${type}`);
        }

        postMessage({ id, type: 'result', result });

    } catch (error) {
        postMessage({ id, type: 'error', error: error.message });
    }
};

// =============================================================================
// STREAMING SEARCH FUNCTIONS
// =============================================================================

async function createSearchState(ocrMoves, method, options, lockedPlies, tier1AgreedPlies) {
    const stateId = ++searchStateCounter;
    const ocrJson = JSON.stringify(ocrMoves || []);
    const ocrB64 = btoa(unescape(encodeURIComponent(ocrJson)));
    const maxFixes = (options && options.max_fixes) || 15;
    const beamWidth = (options && options.beam_width) || 5;
    const maxIterations = (options && options.max_iterations) || 20;
    const maxFixesPerPath = (options && options.max_fixes_per_path) || 10;
    const maxQueueSize = (options && options.max_queue_size) || 50;
    const maxSteps = (options && options.max_steps) || 1000;
    const confirmedPly = (options && options.confirmed_ply) | 0;
    // Backtrack lookback cap — mirrors the interactive Deep Search Depth
    // setting. Caller (search-manager) resolves it from UI settings and
    // passes it here; fallback to 5 matches the UI default.
    const maxBacktrack = (options && options.max_backtrack != null)
        ? (options.max_backtrack | 0)
        : 5;
    // Forced-stop confidence floor — mirrors the interactive "Uncertain-move
    // review threshold" setting (validation.js FORCED_STOP_MIN_CONFIDENCE).
    // Caller (search-manager) resolves it from UI settings and passes it here;
    // fallback 0.50 matches the UI default. Used for the BATCH path where raw
    // merged cells arrive without a pre-stamped forced_stop flag.
    const lowConfFloor = (options && options.low_conf_floor != null)
        ? Number(options.low_conf_floor)
        : 0.50;
    // Normalize lockedPlies to a JSON-safe integer array; used to seed
    // fixed_plies so streaming greedy never touches user-confirmed moves.
    const lockedArr = Array.isArray(lockedPlies)
        ? lockedPlies.map(function(p){ return p|0; })
        : [];
    // Tier 1 agreed plies (S1+S2 agree, independent of legality). Used by
    // greedy_step to recompute the locked set after each applied fix,
    // matching the frontend's classifyTiers behavior on revalidate.
    const tier1Arr = Array.isArray(tier1AgreedPlies)
        ? tier1AgreedPlies.map(function(p){ return p|0; })
        : [];

    const result = await pyodide.runPythonAsync(`
import json, base64

_search_ocr_data_${stateId} = json.loads(base64.b64decode('${ocrB64}').decode('utf-8'))

# Build OCR lookup and move list from ocrMoves array
_search_ocr_lookup_${stateId} = {}
_search_moves_${stateId} = []
_max_ply_${stateId} = 0
# Plies the dual-sheet merge flagged forced_stop (near-tie disagreement) or
# that carry a very-low-confidence single reading. The algorithms stop/defer
# here rather than guessing — same flag validate_moves uses interactively.
_forced_stop_plies_${stateId} = set()

for _entry in _search_ocr_data_${stateId}:
    _num = _entry.get('num', 0)
    _color = _entry.get('color', 'w')
    _ply = (_num - 1) * 2 + (0 if _color == 'w' else 1)
    if _ply > _max_ply_${stateId}:
        _max_ply_${stateId} = _ply

    _move_str = _entry.get('move', '')
    _conf = _entry.get('confidence', 0.9)
    _candidates = [(_move_str, _conf)]
    for _alt in _entry.get('alternatives', []):
        if isinstance(_alt, dict):
            _candidates.append((_alt.get('move', ''), _alt.get('confidence', 0.1)))
        elif isinstance(_alt, (list, tuple)) and len(_alt) >= 2:
            _candidates.append((str(_alt[0]), float(_alt[1])))
    # Forced-stop for the ALGORITHMS only when there's a REAL choice (>=2
    # distinct candidates) to rank by reach. A lone low-confidence reading has
    # nothing to choose between, so the algorithms play it and continue
    # (stopping would just dead-end beam/dijkstra with no candidate to branch
    # on); it's still flagged 🔍 for interactive review. The interactive
    # validator keeps ALL forced_stop plies — only this algorithm-side set is
    # gated on candidate count.
    #
    # The trigger arrives one of three ways: an explicit 'forced_stop' flag
    # (interactive payload, stamped by beam.js buildSearchOcrMoves), the merge's
    # '_ambiguous' flag (BATCH passes raw merged cells straight through), or a
    # very-low-confidence top read. The floor mirrors
    # FORCED_STOP_MIN_CONFIDENCE (validation.js) and is resolved from the user's
    # "Uncertain-move review threshold" setting by search-manager. This is the
    # BATCH fallback: interactive launches pre-stamp 'forced_stop' via beam.js
    # using the same threshold, so batch raw cells (no flag) still get caught.
    _is_forced = (_entry.get('forced_stop') or _entry.get('_ambiguous')
                  or (_conf < ${lowConfFloor}))
    if _is_forced and len(set(_c[0] for _c in _candidates if _c[0])) >= 2:
        _forced_stop_plies_${stateId}.add(_ply)
    _lenient_cands = []
    for _lalt in _entry.get('lenientAlternatives', []):
        if isinstance(_lalt, dict):
            _lenient_cands.append((_lalt.get('move', ''), float(_lalt.get('confidence', 0.1))))
        elif isinstance(_lalt, (list, tuple)) and len(_lalt) >= 2:
            _lenient_cands.append((str(_lalt[0]), float(_lalt[1])))
    _search_ocr_lookup_${stateId}[_ply] = OCRMove(_num, _color, _candidates, lenient_candidates=_lenient_cands)

# Build move list from top candidates
for _ply in range(_max_ply_${stateId} + 1):
    if _ply in _search_ocr_lookup_${stateId}:
        _search_moves_${stateId}.append(_search_ocr_lookup_${stateId}[_ply].top_move)
    else:
        _search_moves_${stateId}.append('')

_search_method_${stateId} = '${method}'

import time as _time_mod
_search_start_time_${stateId} = _time_mod.time()

if _search_method_${stateId} == 'beam':
    # Beam state — built by beam_init (full_game_search.py) so the worker
    # and Python's run_beam_search share one canonical implementation.
    # method, start_time (overridden to match this worker call) are added
    # on top of what beam_init returns.
    _search_state_${stateId} = beam_init(
        _search_moves_${stateId},
        _search_ocr_lookup_${stateId},
        confirmed_ply=${confirmedPly},
        locked_plies=set(${JSON.stringify(lockedArr)}),
        tier1_agreed_plies=set(${JSON.stringify(tier1Arr)}),
        beam_width=${beamWidth},
        max_iterations=${maxIterations},
        max_fixes_per_path=${maxFixesPerPath},
        max_backtrack=${maxBacktrack},
        forced_stop_plies=_forced_stop_plies_${stateId},
    )
    _search_state_${stateId}['method'] = 'beam'
    _search_state_${stateId}['start_time'] = _search_start_time_${stateId}
elif _search_method_${stateId} == 'dijkstra':
    # Dijkstra state — built by dijkstra_init (dijkstra_search.py) so the
    # worker and Python's run_dijkstra_search share one canonical
    # implementation. method, start_time (overridden to match this worker
    # call) are added on top of what dijkstra_init returns.
    _search_state_${stateId} = dijkstra_init(
        _search_moves_${stateId},
        _search_ocr_lookup_${stateId},
        confirmed_ply=${confirmedPly},
        locked_plies=set(${JSON.stringify(lockedArr)}),
        tier1_agreed_plies=set(${JSON.stringify(tier1Arr)}),
        max_queue_size=${maxQueueSize},
        max_steps=${maxSteps},
        max_fixes_per_path=${maxFixesPerPath},
        max_backtrack=${maxBacktrack},
        forced_stop_plies=_forced_stop_plies_${stateId},
    )
    _search_state_${stateId}['method'] = 'dijkstra'
    _search_state_${stateId}['start_time'] = _search_start_time_${stateId}
else:
    # Greedy state — built by greedy_init (full_game_search.py) so the worker
    # and Python's run_greedy_search share one canonical implementation.
    # method, start_time (overridden to match this worker call), and
    # total_plies are added on top of what greedy_init returns.
    _search_state_${stateId} = greedy_init(
        _search_moves_${stateId},
        _search_ocr_lookup_${stateId},
        confirmed_ply=${confirmedPly},
        locked_plies=set(${JSON.stringify(lockedArr)}),
        tier1_agreed_plies=set(${JSON.stringify(tier1Arr)}),
        max_backtrack=${maxBacktrack},
        max_fixes=${maxFixes},
        forced_stop_plies=_forced_stop_plies_${stateId},
    )
    _search_state_${stateId}['method'] = 'greedy'
    _search_state_${stateId}['start_time'] = _search_start_time_${stateId}

json.dumps({
    'stateId': ${stateId},
    'method': _search_state_${stateId}['method'],
    'totalPlies': _search_state_${stateId}['total_plies']
})
    `);
    return JSON.parse(result);
}

async function searchStep(stateId) {
    const result = await pyodide.runPythonAsync(`
import json, time

_st = _search_state_${stateId}

if _st['done']:
    _step_result = json.dumps({'done': True, 'status': _st.get('result', {}).get('status', 'DONE'), 'message': 'Already done'})
elif _st['method'] == 'dijkstra':
    # === DIJKSTRA: pop cheapest, expand once ===
    # All iteration logic lives in dijkstra_step (dijkstra_search.py).
    # Python's run_dijkstra_search uses the same dijkstra_step in a
    # Python loop. One source of truth.
    _step_result = json.dumps(dijkstra_step(_st))

elif _st['method'] == 'greedy':
    # === GREEDY: one fix iteration ===
    # All iteration logic lives in greedy_step (full_game_search.py).
    # The worker is now just a JS dispatcher; Python's run_greedy_search
    # uses the same greedy_step in a Python loop. One source of truth.
    _step_result = json.dumps(greedy_step(_st))

elif _st['method'] == 'beam':
    # === BEAM: one iteration ===
    # All iteration logic lives in beam_step (full_game_search.py). The
    # worker is now just a JS dispatcher; Python's run_beam_search uses
    # the same beam_step in a Python loop. One source of truth.
    _step_result = json.dumps(beam_step(_st))

else:
    _step_result = json.dumps({'done': True, 'status': 'ERROR', 'message': 'Unknown method: ' + str(_st.get('method', '?'))})

_step_result
    `);
    return JSON.parse(result);
}

async function searchFinalize(stateId) {
    const result = await pyodide.runPythonAsync(`
import json

_st = _search_state_${stateId}
_res = _st.get('result') or {}

# Canonicalize moves before crossing to JS. python-chess's parse_san accepts
# non-canonical SAN like "Be5" for a capture (canonical "Bxe5") and the
# algorithm advances on it, but chess.js v0.12.0 strict mode rejects the
# same string — leaving state.sans replayable up to the affected ply only,
# so the board renderer freezes there. See helpers.canonicalize_played_moves.
_raw_moves = _res.get('moves', _st.get('moves', []))
try:
    _canon_moves = canonicalize_played_moves(list(_raw_moves))
except Exception:
    _canon_moves = list(_raw_moves)

_output = {
    'status': _res.get('status', 'FAILED'),
    'moves': _canon_moves,
    'fixes': [],
    'elapsed': 0,
    'reached_ply': _res.get('reached_ply', None),
    # stop_message is set by Greedy's PARTIAL stop branches (no acceptable
    # fix / backward regression / anti-drift) on _st['result']. Carry it
    # through so handleSearchComplete in beam.js can render the reason
    # when the panel re-renders on game-switch (and on the live final
    # step, where handleSearchStep suppresses done=true messages).
    'stop_message': _res.get('stop_message', None)
}

# package_review_fix (full_game_search.py) is the SINGLE source of truth for
# the JS review-fix shape: ply/ply_str/san/ocr/original/similarity, the
# origin_* backtrack metadata, and the packaged all_candidates with score
# pills. The instant-cancel partial path (greedy_step's 'applied_fix' event,
# accumulated in search-manager) packages each fix with the SAME helper, so a
# fix kept via Cancel is shaped identically to one returned by a full finalize.
for _fix in _res.get('fixes', []):
    if isinstance(_fix, dict):
        _output['fixes'].append(package_review_fix(_fix))

# Cleanup globals
for _varname in [
    '_search_state_${stateId}', '_search_moves_${stateId}',
    '_search_ocr_lookup_${stateId}', '_search_ocr_data_${stateId}',
    '_search_method_${stateId}', '_max_ply_${stateId}'
]:
    try:
        exec(f'del {_varname}')
    except:
        pass

json.dumps(_output)
    `);
    return JSON.parse(result);
}

// =============================================================================
// LEGACY SINGLE-SHOT RECONSTRUCTION
// =============================================================================

async function runReconstruction(ocrMoves, method, options) {
    const ocrJson = JSON.stringify(ocrMoves);
    const optionsJson = JSON.stringify(options || {});

    const ocrB64 = btoa(unescape(encodeURIComponent(ocrJson)));
    const optB64 = btoa(unescape(encodeURIComponent(optionsJson)));

    const result = await pyodide.runPythonAsync(`
import json, time, base64

ocr_data = json.loads(base64.b64decode('${ocrB64}').decode('utf-8'))
method = '${method}'
options = json.loads(base64.b64decode('${optB64}').decode('utf-8'))

ocr_lookup = {}
for entry in ocr_data:
    num = entry.get('num', 0)
    color = entry.get('color', 'w')
    ply = (num - 1) * 2 + (0 if color == 'w' else 1)

    candidates = []
    top_move = entry.get('move', '')
    top_conf = entry.get('confidence', 0.9)
    if top_move:
        candidates.append((top_move, top_conf))

    for alt in entry.get('alternatives', []):
        if isinstance(alt, dict):
            candidates.append((alt.get('move', ''), alt.get('confidence', 0.1)))
        elif isinstance(alt, (list, tuple)) and len(alt) >= 2:
            candidates.append((str(alt[0]), float(alt[1])))

    ocr_lookup[ply] = candidates

moves_list = []
max_ply = max(ocr_lookup.keys()) if ocr_lookup else 0
for ply in range(max_ply + 1):
    if ply in ocr_lookup and ocr_lookup[ply]:
        moves_list.append(ocr_lookup[ply][0][0])
    else:
        moves_list.append('')

start_time = time.time()

_confirmed_ply = int(options.get('confirmed_ply', 0) or 0)
# Backtrack lookback cap (mirrors the UI's Deep Search Depth setting).
_max_backtrack = int(options.get('max_backtrack', 5) or 5)

if method == 'greedy':
    result = reconstruct_greedy_background(
        moves_list, ocr_lookup, _locked_plies, _user_fixes,
        confirmed_ply=_confirmed_ply,
        max_backtrack=_max_backtrack
    )
elif method == 'beam':
    beam_width = options.get('beam_width', 5)
    max_fixes = options.get('max_fixes', 3)
    # Forward confirmed_ply so Beam respects the review frontier (see
    # reconstruct_beam_background docstring). Previously this kwarg
    # defaulted to 0 and Beam ignored the user's confirmed prefix.
    result = reconstruct_beam_background(
        moves_list, ocr_lookup, _locked_plies, _user_fixes,
        beam_width, max_fixes,
        confirmed_ply=_confirmed_ply,
        max_backtrack=_max_backtrack
    )
else:
    result = {'error': f'Unknown method: {method}'}

elapsed = time.time() - start_time
result['elapsed_seconds'] = round(elapsed, 2)
result['method'] = method

json.dumps(result)
    `);

    return JSON.parse(result);
}
