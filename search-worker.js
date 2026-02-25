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
        await pyodide.runPythonAsync(`
import micropip
await micropip.install('chess')
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
                result = await createSearchState(data.ocrMoves, data.method, data.options, data.lockedPlies);
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

async function createSearchState(ocrMoves, method, options, lockedPlies) {
    const stateId = ++searchStateCounter;
    const ocrJson = JSON.stringify(ocrMoves || []);
    const ocrB64 = btoa(unescape(encodeURIComponent(ocrJson)));
    const maxFixes = (options && options.max_fixes) || 15;
    const beamWidth = (options && options.beam_width) || 5;
    const maxIterations = (options && options.max_iterations) || 20;
    const maxFixesPerPath = (options && options.max_fixes_per_path) || 10;

    const result = await pyodide.runPythonAsync(`
import json, base64

_search_ocr_data_${stateId} = json.loads(base64.b64decode('${ocrB64}').decode('utf-8'))

# Build OCR lookup and move list from ocrMoves array
_search_ocr_lookup_${stateId} = {}
_search_moves_${stateId} = []
_max_ply_${stateId} = 0

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
    _search_ocr_lookup_${stateId}[_ply] = OCRMove(_num, _color, _candidates)

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
    _search_state_${stateId} = {
        'method': 'beam',
        'beam': [BeamPath(
            moves=_search_moves_${stateId}.copy(),
            fixes=[],
            fixed_plies=set(),
            cumulative_cost=0.0,
            last_stuck_ply=-1
        )],
        'iteration': 0,
        'max_iterations': ${maxIterations},
        'beam_width': ${beamWidth},
        'max_fixes_per_path': ${maxFixesPerPath},
        'total_plies': len(_search_moves_${stateId}),
        'done': False,
        'result': None,
        'start_time': _search_start_time_${stateId}
    }
else:
    _search_state_${stateId} = {
        'method': 'greedy',
        'moves': _search_moves_${stateId}.copy(),
        'all_fixes': [],
        'fixed_plies': set(),
        'iteration': 0,
        'max_fixes': ${maxFixes},
        'total_plies': len(_search_moves_${stateId}),
        'done': False,
        'result': None,
        'start_time': _search_start_time_${stateId}
    }

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
elif _st['method'] == 'greedy':
    # === GREEDY: one fix iteration ===
    _g_moves = _st['moves']
    _g_total = _st['total_plies']

    _g_ead_ply, _g_stop_reason, _g_abs_info = play_until_absurd_or_stuck(
        _g_moves, severity_threshold=3, persistence_threshold=2
    )
    _g_stuck = _g_ead_ply

    _g_elapsed = time.time() - _st['start_time']

    if _g_stuck >= _g_total:
        _g_absurdities = find_all_absurdities(_g_moves)
        if len(_g_absurdities) <= 2:
            _st['done'] = True
            _st['result'] = {'status': 'SOLVED', 'moves': _g_moves, 'fixes': _st['all_fixes']}
            _step_result = json.dumps({
                'done': True, 'status': 'SOLVED',
                'fixes_so_far': len(_st['all_fixes']),
                'elapsed': round(_g_elapsed, 1),
                'message': 'Solved with ' + str(len(_st['all_fixes'])) + ' fix(es) in ' + str(round(_g_elapsed, 1)) + 's'
            })
        else:
            _st['done'] = True
            _st['result'] = {'status': 'PARTIAL', 'moves': _g_moves, 'fixes': _st['all_fixes']}
            _step_result = json.dumps({
                'done': True, 'status': 'PARTIAL',
                'fixes_so_far': len(_st['all_fixes']),
                'elapsed': round(_g_elapsed, 1),
                'message': 'Reached end but ' + str(len(_g_absurdities)) + ' absurdities remain (' + str(round(_g_elapsed, 1)) + 's)'
            })
    else:
        _g_fixes = find_deep_backtrack_fixes(
            _g_moves, _g_stuck, _search_ocr_lookup_${stateId},
            verbose=False, fixed_plies=_st['fixed_plies']
        )
        _g_fixes = [f for f in _g_fixes if f['ply'] not in _st['fixed_plies']]
        _g_fixes = [f for f in _g_fixes if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')]

        if not _g_fixes:
            _st['done'] = True
            _st['result'] = {'status': 'FAILED', 'moves': _g_moves, 'fixes': _st['all_fixes']}
            _step_result = json.dumps({
                'done': True, 'status': 'STUCK',
                'stuck_at': ply_to_str(_g_stuck),
                'fixes_so_far': len(_st['all_fixes']),
                'elapsed': round(_g_elapsed, 1),
                'message': 'No fixes found at ' + ply_to_str(_g_stuck) + ' (' + str(round(_g_elapsed, 1)) + 's)'
            })
        else:
            _g_best = _g_fixes[0]
            _g_moves[_g_best['ply']] = _g_best['san']
            _st['all_fixes'].append(_g_best)
            _st['fixed_plies'].add(_g_best['ply'])
            _st['iteration'] += 1

            _step_result = json.dumps({
                'done': False,
                'iteration': _st['iteration'],
                'stuck_at': ply_to_str(_g_stuck),
                'fix_ply': ply_to_str(_g_best['ply']),
                'fix_from': _g_best.get('ocr', ''),
                'fix_to': _g_best.get('san', ''),
                'fix_score': _g_best.get('unified_score', 0),
                'fixes_so_far': len(_st['all_fixes']),
                'elapsed': round(_g_elapsed, 1),
                'message': '[fix] ' + ply_to_str(_g_best['ply']) + ': ' + _g_best.get('ocr', '') + ' -> ' + _g_best.get('san', '')
            })

else:
    # === BEAM: one beam iteration ===
    _b_beam = _st['beam']
    _b_total = _st['total_plies']
    _b_beam_width = _st['beam_width']
    _b_LAMBDA = 21
    _b_elapsed = time.time() - _st['start_time']

    # Helper to build fix summary for any path
    def _b_build_win_fixes(_fixes_list):
        _wfl = []
        for _wf in _fixes_list:
            _wfl.append({
                'ply_str': ply_to_str(_wf['ply']),
                'ocr': _wf.get('ocr', ''),
                'san': _wf.get('san', ''),
                'score': _wf.get('unified_score', 0)
            })
        return _wfl

    # --- Guard 1: max_iterations cap ---
    if _st['iteration'] >= _st['max_iterations']:
        _b_best = max(_b_beam, key=lambda p: (1 if play_until_stuck(p.moves)[0] >= _b_total else 0, play_until_stuck(p.moves)[0], -p.cumulative_cost))
        _st['done'] = True
        _st['result'] = {'status': 'PARTIAL', 'moves': _b_best.moves, 'fixes': _b_best.fixes}
        _step_result = json.dumps({
            'done': True, 'status': 'PARTIAL',
            'fixes_so_far': len(_b_best.fixes),
            'elapsed': round(_b_elapsed, 1),
            'winning_fixes': _b_build_win_fixes(_b_best.fixes),
            'message': 'Max iterations (' + str(_st['max_iterations']) + ') reached (' + str(round(_b_elapsed, 1)) + 's)'
        })
    else:
        _b_found_solution = False
        for _b_path in _b_beam:
            _b_reach, _ = play_until_stuck(_b_path.moves)
            if _b_reach >= _b_total:
                _b_absurdities = find_all_absurdities(_b_path.moves)
                if len(_b_absurdities) <= 2:
                    _st['done'] = True
                    _st['result'] = {'status': 'SOLVED', 'moves': _b_path.moves, 'fixes': _b_path.fixes}
                    _step_result = json.dumps({
                        'done': True, 'status': 'SOLVED',
                        'fixes_so_far': len(_b_path.fixes),
                        'elapsed': round(_b_elapsed, 1),
                        'winning_fixes': _b_build_win_fixes(_b_path.fixes),
                        'message': 'Solved with ' + str(len(_b_path.fixes)) + ' fix(es) in ' + str(round(_b_elapsed, 1)) + 's'
                    })
                    _b_found_solution = True
                    break

        if not _b_found_solution:
            _b_new_beam = []
            _b_step_fixes = []
            _b_any_expanded = False

            for _b_path in _b_beam:
                # Dead weight: at max fixes, keep but never expand
                if len(_b_path.fixes) >= _st['max_fixes_per_path']:
                    _b_new_beam.append(_b_path)
                    continue

                _b_ead_ply, _b_stop_reason, _ = play_until_absurd_or_stuck(
                    _b_path.moves, severity_threshold=3, persistence_threshold=2
                )
                _b_reach = _b_ead_ply

                if _b_reach >= _b_total:
                    _b_new_beam.append(_b_path)
                    continue

                # Dead-end: stuck at same ply as last time, no point re-expanding
                if _b_reach == _b_path.last_stuck_ply and _b_reach < _b_total:
                    _b_new_beam.append(_b_path)
                    continue

                _b_fixes = find_deep_backtrack_fixes(
                    _b_path.moves, _b_reach, _search_ocr_lookup_${stateId},
                    verbose=False, fixed_plies=_b_path.fixed_plies
                )

                _b_fixes = [f for f in _b_fixes if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')]

                if not _b_fixes:
                    _b_path.last_stuck_ply = _b_reach
                    _b_new_beam.append(_b_path)
                    continue

                # This path actually produced new branches
                _b_any_expanded = True
                _b_num_branches = min(_b_beam_width, len(_b_fixes), 3)
                _b_best_score = _b_fixes[0].get('unified_score', 0)

                # Track the first fix from this stuck point (for iteration log)
                _b_first_fix = _b_fixes[0]
                _b_step_fixes.append({
                    'ply_str': ply_to_str(_b_first_fix['ply']),
                    'ocr': _b_first_fix.get('ocr', ''),
                    'san': _b_first_fix.get('san', ''),
                    'regret': 0,
                    'num_branches': _b_num_branches
                })

                for _b_fix in _b_fixes[:_b_num_branches]:
                    _b_new_path = _b_path.copy()
                    _b_new_path.moves[_b_fix['ply']] = _b_fix['san']
                    _b_new_path.fixes.append(_b_fix)
                    _b_new_path.fixed_plies.add(_b_fix['ply'])

                    _b_this_score = _b_fix.get('unified_score', 0)
                    _b_regret = max(0, _b_best_score - _b_this_score)
                    _b_new_path.cumulative_cost += _b_LAMBDA + _b_regret
                    _b_new_path.last_stuck_ply = _b_reach

                    _b_new_beam.append(_b_new_path)

            if not _b_new_beam:
                _st['done'] = True
                _st['result'] = {'status': 'FAILED', 'moves': _b_beam[0].moves if _b_beam else [], 'fixes': []}
                _step_result = json.dumps({'done': True, 'status': 'FAILED', 'elapsed': round(_b_elapsed, 1), 'message': 'No paths remain (' + str(round(_b_elapsed, 1)) + 's)'})
            else:
                def _b_score_path(p):
                    _r, _ = play_until_stuck(p.moves)
                    _c = 1 if _r >= _b_total else 0
                    _rr = _r / _b_total if _b_total > 0 else 0
                    return (_c, _rr, -p.cumulative_cost, -len(p.fixes))

                _b_new_beam.sort(key=_b_score_path, reverse=True)
                _st['beam'] = _b_new_beam[:_b_beam_width]
                _st['iteration'] += 1

                _b_best = _st['beam'][0]
                _b_best_reach, _ = play_until_stuck(_b_best.moves)
                _b_best_cost = _b_best.cumulative_cost

                # --- Guard 2: stall detection ---
                # If no path was expanded (all dead-ends), terminate immediately
                if not _b_any_expanded:
                    _st['done'] = True
                    _st['result'] = {'status': 'PARTIAL', 'moves': _b_best.moves, 'fixes': _b_best.fixes}
                    _step_result = json.dumps({
                        'done': True, 'status': 'PARTIAL',
                        'fixes_so_far': len(_b_best.fixes),
                        'elapsed': round(_b_elapsed, 1),
                        'winning_fixes': _b_build_win_fixes(_b_best.fixes),
                        'message': 'All paths exhausted (' + str(round(_b_elapsed, 1)) + 's)'
                    })
                else:
                    # Track stall: same best_reach and best_cost as previous iteration
                    _b_prev_reach = _st.get('prev_best_reach', -1)
                    _b_prev_cost = _st.get('prev_best_cost', -1)
                    if _b_best_reach == _b_prev_reach and _b_best_cost == _b_prev_cost:
                        _st['stall_count'] = _st.get('stall_count', 0) + 1
                    else:
                        _st['stall_count'] = 0
                    _st['prev_best_reach'] = _b_best_reach
                    _st['prev_best_cost'] = _b_best_cost

                    # --- Guard 3: stall limit (5 iterations with no progress) ---
                    if _st['stall_count'] >= 5:
                        _st['done'] = True
                        _st['result'] = {'status': 'PARTIAL', 'moves': _b_best.moves, 'fixes': _b_best.fixes}
                        _step_result = json.dumps({
                            'done': True, 'status': 'PARTIAL',
                            'fixes_so_far': len(_b_best.fixes),
                            'elapsed': round(_b_elapsed, 1),
                            'winning_fixes': _b_build_win_fixes(_b_best.fixes),
                            'message': 'Stalled for 5 iterations at ' + ply_to_str(_b_best_reach) + ' (' + str(round(_b_elapsed, 1)) + 's)'
                        })
                    else:
                        _step_result = json.dumps({
                            'done': False,
                            'iteration': _st['iteration'],
                            'paths_in_beam': len(_st['beam']),
                            'best_reach': _b_best_reach,
                            'best_reach_str': ply_to_str(_b_best_reach),
                            'best_fixes': len(_b_best.fixes),
                            'best_cost': _b_best_cost,
                            'total_plies': _b_total,
                            'elapsed': round(_b_elapsed, 1),
                            'fixes_this_step': _b_step_fixes,
                            'message': 'Beam iter ' + str(_st['iteration']) + ': ' + str(len(_st['beam'])) + ' paths, best at ' + ply_to_str(_b_best_reach) + '/' + str(_b_total) + ' (' + str(len(_b_best.fixes)) + ' fixes, cost=' + str(int(_b_best_cost)) + ')'
                        })

_step_result
    `);
    return JSON.parse(result);
}

async function searchFinalize(stateId) {
    const result = await pyodide.runPythonAsync(`
import json

_st = _search_state_${stateId}
_res = _st.get('result') or {}

_output = {
    'status': _res.get('status', 'FAILED'),
    'moves': _res.get('moves', _st.get('moves', [])),
    'fixes': [],
    'elapsed': 0
}

for _fix in _res.get('fixes', []):
    if isinstance(_fix, dict):
        _output['fixes'].append({
            'ply': _fix.get('ply', 0),
            'ply_str': _fix.get('ply_str', '') or ply_to_str(_fix.get('ply', 0)),
            'san': _fix.get('san', ''),
            'ocr': _fix.get('ocr', ''),
            'original': _fix.get('ocr', ''),
            'similarity': _fix.get('similarity', 0)
        })

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

if method == 'greedy':
    result = reconstruct_greedy_background(
        moves_list, ocr_lookup, _locked_plies, _user_fixes
    )
elif method == 'beam':
    beam_width = options.get('beam_width', 5)
    max_fixes = options.get('max_fixes', 3)
    result = reconstruct_beam_background(
        moves_list, ocr_lookup, _locked_plies, _user_fixes,
        beam_width, max_fixes
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
