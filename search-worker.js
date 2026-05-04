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
    const maxQueueSize = (options && options.max_queue_size) || 50;
    const maxSteps = (options && options.max_steps) || 1000;
    const confirmedPly = (options && options.confirmed_ply) | 0;
    // Backtrack lookback cap — mirrors the interactive Deep Search Depth
    // setting. Caller (search-manager) resolves it from UI settings and
    // passes it here; fallback to 5 matches the UI default.
    const maxBacktrack = (options && options.max_backtrack != null)
        ? (options.max_backtrack | 0)
        : 5;
    // Normalize lockedPlies to a JSON-safe integer array; used to seed
    // fixed_plies so streaming greedy never touches user-confirmed moves.
    const lockedArr = Array.isArray(lockedPlies)
        ? lockedPlies.map(function(p){ return p|0; })
        : [];

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
    _search_state_${stateId} = {
        'method': 'beam',
        # Seed path.fixed_plies with lockedArr so Beam matches Greedy's
        # behaviour: residual-absurdity filtering (in both the auto-solve
        # check and the second-loop retarget) excludes plies the user has
        # confirmed or that are tier-1 merge-locked. Without this, Beam
        # retargets to an earlier "absurdity" at a locked ply, opens a
        # 1-ply search window there, and dead-ends with zero fixes even
        # when Greedy finds the right cascade one ply further on.
        'beam': [BeamPath(
            moves=_search_moves_${stateId}.copy(),
            fixes=[],
            fixed_plies=set(${JSON.stringify(lockedArr)}),
            cumulative_cost=0.0,
            last_stuck_ply=-1
        )],
        'iteration': 0,
        'max_iterations': ${maxIterations},
        'beam_width': ${beamWidth},
        'max_fixes_per_path': ${maxFixesPerPath},
        'total_plies': len(_search_moves_${stateId}),
        # Game-level sacred plies (user confirmed / merge high-tier).
        # find_deep_backtrack_fixes skips these so no path proposes a fix here.
        'locked_plies': set(${JSON.stringify(lockedArr)}),
        # Review frontier — plies below this are the user's confirmed
        # baseline after an override + requeue. Beam must not propose
        # fixes below this line (same contract greedy has).
        'confirmed_ply': ${confirmedPly},
        # Backtrack lookback cap — mirrors Deep Search Depth setting.
        'max_backtrack': ${maxBacktrack},
        'done': False,
        'result': None,
        'start_time': _search_start_time_${stateId}
    }
elif _search_method_${stateId} == 'dijkstra':
    import heapq as _heapq_mod
    # Seed initial node.fixed_plies with lockedArr (same reasoning as
    # Beam above — keep residual-absurdity retargeting aligned with
    # Greedy so Dijkstra doesn't dead-end at a locked ply).
    _dijk_initial_node_${stateId} = DijkstraNode(
        cost=0.0,
        moves=_search_moves_${stateId}.copy(),
        fixes=[],
        fixed_plies=set(${JSON.stringify(lockedArr)})
    )
    _dijk_queue_${stateId} = [_dijk_initial_node_${stateId}]
    _heapq_mod.heapify(_dijk_queue_${stateId})
    _search_state_${stateId} = {
        'method': 'dijkstra',
        'queue': _dijk_queue_${stateId},
        'step': 0,
        'max_steps': ${maxSteps},
        'max_queue_size': ${maxQueueSize},
        'max_fixes_per_path': ${maxFixesPerPath},
        'total_plies': len(_search_moves_${stateId}),
        'paths_explored': 0,
        'best_partial': _dijk_initial_node_${stateId},
        'LAMBDA': 21,
        'REGRET_THRESHOLD': 42,
        # Game-level sacred plies (user confirmed / merge high-tier).
        # find_deep_backtrack_fixes skips these so no node proposes a fix here.
        'locked_plies': set(${JSON.stringify(lockedArr)}),
        # Review frontier — same contract as beam/greedy above.
        'confirmed_ply': ${confirmedPly},
        # Backtrack lookback cap — mirrors Deep Search Depth setting.
        'max_backtrack': ${maxBacktrack},
        'done': False,
        'result': None,
        'start_time': _search_start_time_${stateId}
    }
else:
    _search_state_${stateId} = {
        'method': 'greedy',
        'moves': _search_moves_${stateId}.copy(),
        'all_fixes': [],
        # Seed with user-confirmed plies so streaming greedy never rewrites them.
        'fixed_plies': set(${JSON.stringify(lockedArr)}),
        'locked_plies': set(${JSON.stringify(lockedArr)}),
        'confirmed_ply': ${confirmedPly},
        # Backtrack lookback cap — mirrors Deep Search Depth setting.
        'max_backtrack': ${maxBacktrack},
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
elif _st['method'] == 'dijkstra':
    # === DIJKSTRA: one step (pop cheapest, expand) ===
    import heapq as _heapq
    _d_queue = _st['queue']
    _d_total = _st['total_plies']
    _d_LAMBDA = _st['LAMBDA']
    _d_REGRET_THRESHOLD = _st['REGRET_THRESHOLD']
    _d_elapsed = time.time() - _st['start_time']

    if not _d_queue:
        _st['done'] = True
        _d_bp = _st['best_partial']
        _d_bp_reach, _ = play_until_stuck(_d_bp.moves) if _d_bp.moves else (0, None)
        _st['result'] = {'status': 'FAILED' if not _d_bp.fixes else 'PARTIAL', 'moves': _d_bp.moves, 'fixes': _d_bp.fixes, 'reached_ply': _d_bp_reach}
        _step_result = json.dumps({
            'done': True, 'status': _st['result']['status'],
            'fixes_so_far': len(_d_bp.fixes),
            'elapsed': round(_d_elapsed, 1),
            'message': 'Queue empty (' + str(round(_d_elapsed, 1)) + 's)'
        })
    elif _st['step'] >= _st['max_steps']:
        _st['done'] = True
        _d_bp = _st['best_partial']
        _d_bp_reach2, _ = play_until_stuck(_d_bp.moves) if _d_bp.moves else (0, None)
        _st['result'] = {'status': 'PARTIAL', 'moves': _d_bp.moves, 'fixes': _d_bp.fixes, 'reached_ply': _d_bp_reach2}
        _step_result = json.dumps({
            'done': True, 'status': 'PARTIAL',
            'fixes_so_far': len(_d_bp.fixes),
            'elapsed': round(_d_elapsed, 1),
            'message': 'Max steps (' + str(_st['max_steps']) + ') reached (' + str(round(_d_elapsed, 1)) + 's)'
        })
    else:
        _d_node = _heapq.heappop(_d_queue)
        _st['paths_explored'] += 1
        _st['step'] += 1

        # Approved-plies set: locked cells ∪ pre-frontier prefix — see
        # greedy above for rationale.
        _d_approved = set(_st['locked_plies']) if _st['locked_plies'] else set()
        _d_cp = _st.get('confirmed_ply', 0)
        if _d_cp and _d_cp > 0:
            _d_approved |= set(range(_d_cp))
        _d_ead_ply, _d_stop_reason, _d_abs_info = play_until_absurd_or_stuck(
            _d_node.moves, severity_threshold=3, persistence_threshold=2,
            approved_plies=_d_approved
        )
        _d_stuck = _d_ead_ply

        # Check if solved (zero residual absurdities required — see Qe4 incident)
        _d_residual_pending = False
        if _d_stuck >= _d_total:
            _d_absurdities = find_all_absurdities(_d_node.moves)
            _d_absurdities = [a for a in _d_absurdities if a.ply not in _d_node.fixed_plies]
            if len(_d_absurdities) == 0:
                # Already-valid → VALID; otherwise SOLVED. Mirrors backend
                # dijkstra_search line 211 — the "this game was clean from
                # the start" signal vs "we fixed it to validity."
                _d_already_valid = (len(_d_node.fixes) == 0)
                _d_status = 'VALID' if _d_already_valid else 'SOLVED'
                _d_message = ('Game already valid' if _d_already_valid
                              else 'Solved with ' + str(len(_d_node.fixes)) + ' fix(es) in ' + str(round(_d_elapsed, 1)) + 's')
                _st['done'] = True
                _st['result'] = {'status': _d_status, 'moves': _d_node.moves, 'fixes': _d_node.fixes}
                _step_result = json.dumps({
                    'done': True, 'status': _d_status,
                    'fixes_so_far': len(_d_node.fixes),
                    'elapsed': round(_d_elapsed, 1),
                    'message': _d_message
                })
            else:
                # Reached end but residual absurdities exist — re-target the earliest as
                # the new stuck point so expansion below can try to repair it.
                _d_stuck = min(a.ply for a in _d_absurdities)
                _d_residual_pending = True
        if _d_residual_pending or _d_stuck < _d_total:
            # Update best partial
            _d_bp = _st['best_partial']
            _d_bp_reach = play_until_stuck(_d_bp.moves)[0]
            if _d_stuck > _d_bp_reach:
                _st['best_partial'] = _d_node

            # Check max fixes
            if len(_d_node.fixes) >= _st['max_fixes_per_path']:
                _step_result = json.dumps({
                    'done': False, 'step': _st['step'],
                    'queue_size': len(_d_queue), 'current_cost': int(_d_node.cost),
                    'depth': len(_d_node.fixes), 'reach': _d_stuck,
                    'reach_str': ply_to_str(_d_stuck), 'total_plies': _d_total,
                    'elapsed': round(_d_elapsed, 1),
                    'message': 'Max fixes reached at depth ' + str(len(_d_node.fixes))
                })
            else:
                # Find fixes — honour the review frontier (confirmed_ply) and
                # user-locked plies so dijkstra never branches into a ply the
                # user has already settled. Without min_ply, overrides during
                # a review walkthrough let dijkstra re-explore every earlier
                # ply on escalation — user-reported as Beam/Dijkstra starting
                # at 17.W after an override at 24.W.
                # Same bounded window as greedy/beam above: anchor at
                # _d_stuck, cap lookback at MAX_BACKTRACK, unlock _d_stuck
                # itself, respect user frontier when not stale.
                _d_confirmed = _st.get('confirmed_ply', 0)
                _d_MAX_BACKTRACK = _st.get('max_backtrack', 5)
                _d_frontier = 0 if _d_stuck < _d_confirmed else _d_confirmed
                _d_eff_min_ply = max(_d_frontier, _d_stuck - _d_MAX_BACKTRACK)
                _d_eff_min_ply = max(0, min(_d_eff_min_ply, _d_stuck))
                _d_eff_locked = set(_st['locked_plies']) if _st['locked_plies'] else set()
                _d_eff_locked.discard(_d_stuck)
                _d_fixes = find_deep_backtrack_fixes(
                    _d_node.moves, _d_stuck, _search_ocr_lookup_${stateId},
                    verbose=False, fixed_plies=_d_node.fixed_plies,
                    locked_plies=_d_eff_locked, min_ply=_d_eff_min_ply
                )
                _d_fixes = [f for f in _d_fixes if f['ply'] not in _d_node.fixed_plies]
                _d_fixes = [f for f in _d_fixes if f['ply'] >= _d_eff_min_ply]
                _d_fixes = [f for f in _d_fixes if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')]
                # Verify pass: deep-quiescence re-rank top candidates. Mirrors
                # backend dijkstra_search.run_dijkstra_search and prevents
                # fast-mode OFC false positives at branch expansion.
                _d_fixes = _postprocess_phase2_fixes(
                    _d_fixes, _d_node.moves, _d_stuck, verbose=False, verify_top_n=5
                )
                # Defensive: drop any fix at a locked ply. Mirrors backend
                # Dijkstra — find_deep_backtrack_fixes's extended_search_plies
                # heuristic can reach into locked plies and a dijkstra branch
                # on a user-locked ply silently overwrites it.
                if _d_eff_min_ply > 0 or _d_eff_locked:
                    _d_fixes = [f for f in _d_fixes
                                if f.get('ply', 0) >= _d_eff_min_ply
                                and f.get('ply', 0) not in _d_eff_locked]

                if not _d_fixes:
                    _step_result = json.dumps({
                        'done': False, 'step': _st['step'],
                        'queue_size': len(_d_queue), 'current_cost': int(_d_node.cost),
                        'depth': len(_d_node.fixes), 'reach': _d_stuck,
                        'reach_str': ply_to_str(_d_stuck), 'total_plies': _d_total,
                        'elapsed': round(_d_elapsed, 1),
                        'message': 'Dead end at ' + ply_to_str(_d_stuck)
                    })
                else:
                    _d_best_score = _d_fixes[0].get('unified_score', 0)
                    _d_pushed = 0
                    _d_first_fix = _d_fixes[0]

                    for _d_fix in _d_fixes:
                        _d_this_score = _d_fix.get('unified_score', 0)
                        _d_regret = max(0, _d_best_score - _d_this_score)
                        if _d_regret > _d_REGRET_THRESHOLD:
                            break
                        _d_edge_cost = _d_LAMBDA + _d_regret
                        _d_new_cost = _d_node.cost + _d_edge_cost
                        # Cache the full ranked candidate list on the chosen fix so the
                        # Review UI can show alternatives without another backtrack run
                        # (mirrors Greedy/Beam pattern).
                        _d_fix_with_cands = dict(_d_fix)
                        _d_fix_with_cands['all_candidates'] = _d_fixes
                        _d_new_node = _d_node.copy_with_fix(_d_fix_with_cands, _d_new_cost)
                        _heapq.heappush(_d_queue, _d_new_node)
                        _d_pushed += 1

                    # Prune queue
                    if len(_d_queue) > _st['max_queue_size']:
                        _d_pruned = _heapq.nsmallest(_st['max_queue_size'], _d_queue)
                        _st['queue'] = _d_pruned
                        _d_queue = _d_pruned
                        _heapq.heapify(_d_queue)

                    _d_status = 'exploring' if _d_pushed == 1 else 'branching'
                    _step_result = json.dumps({
                        'done': False, 'step': _st['step'],
                        'queue_size': len(_d_queue), 'current_cost': int(_d_node.cost),
                        'depth': len(_d_node.fixes), 'reach': _d_stuck,
                        'reach_str': ply_to_str(_d_stuck), 'total_plies': _d_total,
                        'status': _d_status, 'pushed': _d_pushed,
                        'elapsed': round(_d_elapsed, 1),
                        'fix_ply': ply_to_str(_d_first_fix['ply']),
                        'fix_from': _d_first_fix.get('ocr', ''),
                        'fix_to': _d_first_fix.get('san', ''),
                        'message': ('Greedy' if _d_pushed == 1 else 'Branch(' + str(_d_pushed) + ')') + ' at ' + ply_to_str(_d_stuck) + ', cost=' + str(int(_d_node.cost)) + ', depth=' + str(len(_d_node.fixes)) + ', queue=' + str(len(_d_queue))
                    })

elif _st['method'] == 'greedy':
    # === GREEDY: one fix iteration ===
    _g_moves = _st['moves']
    _g_total = _st['total_plies']

    # Approved-plies set: every locked cell PLUS every ply below the review
    # frontier. Mirrors validation.py — check_ead_after_move skips approved
    # plies (line 169) and validate_moves skips the entire pre-frontier
    # prefix (line 321). Without the prefix, a single hanging-piece sequence
    # in already-validated territory stops Greedy at a ply the user has
    # walked past long ago.
    _g_approved = set(_st['locked_plies']) if _st['locked_plies'] else set()
    _g_cp = _st.get('confirmed_ply', 0)
    if _g_cp and _g_cp > 0:
        _g_approved |= set(range(_g_cp))
    _g_ead_ply, _g_stop_reason, _g_abs_info = play_until_absurd_or_stuck(
        _g_moves, severity_threshold=3, persistence_threshold=2,
        approved_plies=_g_approved
    )
    _g_stuck = _g_ead_ply

    _g_elapsed = time.time() - _st['start_time']

    _g_residual_pending = False
    if _g_stuck >= _g_total:
        _g_absurdities = find_all_absurdities(_g_moves)
        _g_absurdities = [a for a in _g_absurdities if a.ply not in _st['fixed_plies']]
        if len(_g_absurdities) == 0:
            # If we reached the end on the very first iteration without
            # applying any fixes, the game was already valid — emit VALID
            # rather than SOLVED so the UI can distinguish "nothing was wrong"
            # from "we fixed it to validity." Mirrors backend Greedy line 145.
            _g_already_valid = (len(_st['all_fixes']) == 0)
            _g_status = 'VALID' if _g_already_valid else 'SOLVED'
            _g_message = ('Game already valid' if _g_already_valid
                          else 'Solved with ' + str(len(_st['all_fixes'])) + ' fix(es) in ' + str(round(_g_elapsed, 1)) + 's')
            _st['done'] = True
            _st['result'] = {'status': _g_status, 'moves': _g_moves, 'fixes': _st['all_fixes']}
            _step_result = json.dumps({
                'done': True, 'status': _g_status,
                'fixes_so_far': len(_st['all_fixes']),
                'elapsed': round(_g_elapsed, 1),
                'message': _g_message
            })
        else:
            # Reached end but residual absurdities remain — retarget stuck to earliest
            # residual ply and try to fix it (zero-tolerance: see Qe4 incident).
            _g_stuck = min(a.ply for a in _g_absurdities)
            _g_residual_pending = True
    if _g_residual_pending or _g_stuck < _g_total:
        _g_confirmed = _st.get('confirmed_ply', 0)
        _g_locked = _st.get('locked_plies', set())
        # Search window anchored at _g_stuck with capped lookback. Without
        # the cap, a fresh batch run (confirmed_ply=0) let Greedy pick fixes
        # 15+ plies back from the stuck point — reported as "Greedy fixed
        # 17.W Qd1->Qc2 when stuck was 26.W, total nonsense because the
        # queen moves again at 23.W." The cap matches the user's Deep Search
        # Depth setting so Greedy considers the same candidate pool the
        # interactive Deep Search panel does.
        #  - Frontier: confirmed_ply, unless stale (stuck<confirmed) then 0.
        #  - Cap: never search more than max_backtrack plies before stuck.
        #  - Unlock _g_stuck itself so a fix there becomes proposable even
        #    when it is tier-1 merge-locked; other locked plies stay sacred.
        _g_MAX_BACKTRACK = _st.get('max_backtrack', 5)
        _g_frontier = 0 if _g_stuck < _g_confirmed else _g_confirmed
        _g_eff_min_ply = max(_g_frontier, _g_stuck - _g_MAX_BACKTRACK)
        _g_eff_min_ply = max(0, min(_g_eff_min_ply, _g_stuck))
        _g_eff_locked = set(_g_locked) if _g_locked else set()
        _g_eff_locked.discard(_g_stuck)
        _g_fixes = find_deep_backtrack_fixes(
            _g_moves, _g_stuck, _search_ocr_lookup_${stateId},
            verbose=False, fixed_plies=_st['fixed_plies'],
            locked_plies=_g_eff_locked, min_ply=_g_eff_min_ply,
        )
        _g_fixes = [f for f in _g_fixes if f['ply'] not in _st['fixed_plies']]
        _g_fixes = [f for f in _g_fixes if f['ply'] >= _g_eff_min_ply]
        _g_fixes = [f for f in _g_fixes if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')]
        # Verify pass — re-run deep quiescence on the top-5 candidates so that
        # fast-mode false positives (notably the documented depth=6 OFC mis-flag
        # on Rxg7+ Kxg7 ... chains) can't promote a wrong candidate above the
        # right one. Mirrors backend full_game_search.run_greedy_search.
        # _postprocess_phase2_fixes is the single source of truth for verify.
        _g_fixes = _postprocess_phase2_fixes(
            _g_fixes, _g_moves, _g_stuck, verbose=False, verify_top_n=5
        )
        # Score floor — when the backtracking ladder starts producing fixes
        # with deeply negative unified_score (e.g. "exd5 -> e5  score=-223"
        # at ply 4), Greedy is effectively cascading into nonsense at earlier
        # plies because the real problem is further down. Reject fixes below
        # the floor so Greedy stops and reports FAILED with the reasonable
        # fixes it did find, instead of burying them under garbage.
        _g_score_floor = 0
        _g_fixes = [f for f in _g_fixes if f.get('unified_score', 0) >= _g_score_floor]

        # Lock-aware backtrack: when the stuck ply is user-locked, candidates
        # that don't advance past it can't unstick anything — the lock
        # prevents changing the stuck SAN itself, so any earlier-ply edit
        # whose only effect is to reach back to the same stuck point is
        # definitionally vacuous. Reported case: locked illegal SAN at 21.B
        # ('Red8' — no e-rook), Greedy backtracked to 21.W and surfaced
        # Na5->Na3 (sim=94%, reach_improvement=0) as a "fix" that didn't
        # actually fix anything. Drop those so Greedy falls into the
        # existing 'no candidate' PARTIAL branch below and reports honestly.
        _g_locked_set = set(_g_locked) if _g_locked else set()
        if _g_stuck in _g_locked_set:
            _g_fixes = [f for f in _g_fixes if f.get('reach_improvement', 0) > 0]

        if not _g_fixes:
            # No fix at the current stuck ply. Return PARTIAL (not FAILED) so
            # any fixes made so far stay reviewable in the panel.
            _st['done'] = True
            _g_msg = 'Stopped at ' + ply_to_str(_g_stuck) + ' — no candidate met Greedy\\'s score threshold (' + str(round(_g_elapsed, 1)) + 's). Fix Suggestions panel has the ranked candidates.'
            _st['result'] = {'status': 'PARTIAL', 'moves': _g_moves, 'fixes': _st['all_fixes'], 'reached_ply': _g_stuck, 'stop_reason': _g_stop_reason, 'stop_message': _g_msg}
            _step_result = json.dumps({
                'done': True, 'status': 'PARTIAL',
                'stuck_at': ply_to_str(_g_stuck),
                'fixes_so_far': len(_st['all_fixes']),
                'elapsed': round(_g_elapsed, 1),
                'message': _g_msg
            })
        else:
            # Anti-regression: once Greedy has applied fixes up to max_fixed_ply,
            # a new candidate at ply <= max_fixed_ply is a backward jump (often
            # "fixing" a perfectly legal move that only looks illegal because an
            # earlier Greedy fix subtly shifted the position). Stop with PARTIAL
            # and let the user review the forward-progressing fixes we have.
            # Seed max_fixed_ply from user-locked plies too so Greedy can't loop
            # back to re-fix past a user-confirmed boundary.
            _g_own_fixed = [_f['ply'] for _f in _st['all_fixes']]
            _g_max_fixed_ply = max(_g_own_fixed) if _g_own_fixed else -1
            _g_best = dict(_g_fixes[0])
            if _g_max_fixed_ply >= 0 and _g_best['ply'] <= _g_max_fixed_ply:
                _st['done'] = True
                _g_msg = 'Backward regression (ply ' + ply_to_str(_g_best['ply']) + ' <= max fixed ' + ply_to_str(_g_max_fixed_ply) + ') — stopping (' + str(round(_g_elapsed, 1)) + 's)'
                _st['result'] = {'status': 'PARTIAL', 'moves': _g_moves, 'fixes': _st['all_fixes'], 'reached_ply': _g_stuck, 'stop_reason': _g_stop_reason, 'stop_message': _g_msg}
                _step_result = json.dumps({
                    'done': True, 'status': 'PARTIAL',
                    'stuck_at': ply_to_str(_g_stuck),
                    'fixes_so_far': len(_st['all_fixes']),
                    'elapsed': round(_g_elapsed, 1),
                    'message': _g_msg
                })
            else:
                # Cache the full ranked candidate list on the chosen fix so the
                # review UI can show alternatives without another backtrack run.
                _g_best['all_candidates'] = _g_fixes
                _g_moves[_g_best['ply']] = _g_best['san']
                _st['all_fixes'].append(_g_best)
                _st['fixed_plies'].add(_g_best['ply'])
                _st['iteration'] += 1

                # Anti-drift: N consecutive plies fixed in a row means Greedy
                # has diverged from the actual game and is now guessing — every
                # subsequent fix extends an alternate-reality position. Stop
                # with PARTIAL and let the user review what we have. Sister
                # rule to the backward-regression check above.
                # Threshold=5 gives margin for legitimate capture-chain misreads
                # (dxe5/dxe5/Nxe5 type sequences where 'x' is the most OCR-prone
                # character).
                _g_drift = False
                _ANTI_DRIFT_RUN = 5
                if len(_st['all_fixes']) >= _ANTI_DRIFT_RUN:
                    _last_plies = [_f['ply'] for _f in _st['all_fixes'][-_ANTI_DRIFT_RUN:]]
                    _consecutive = all(_last_plies[_i + 1] == _last_plies[_i] + 1
                                       for _i in range(_ANTI_DRIFT_RUN - 1))
                    if _consecutive:
                        _g_drift = True
                        _st['done'] = True
                        _plies_str = ', '.join(ply_to_str(_p) for _p in _last_plies)
                        _g_msg = ('Anti-drift: ' + str(_ANTI_DRIFT_RUN) + ' consecutive plies fixed (' +
                                  _plies_str + ') — stopping (' + str(round(_g_elapsed, 1)) + 's)')
                        _st['result'] = {'status': 'PARTIAL', 'moves': _g_moves, 'fixes': _st['all_fixes'], 'reached_ply': _g_stuck, 'stop_reason': _g_stop_reason, 'stop_message': _g_msg}
                        _step_result = json.dumps({
                            'done': True, 'status': 'PARTIAL',
                            'stuck_at': ply_to_str(_g_stuck),
                            'fixes_so_far': len(_st['all_fixes']),
                            'elapsed': round(_g_elapsed, 1),
                            'message': _g_msg
                        })

                if not _g_drift:
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
        _b_best_reach_g1, _ = play_until_stuck(_b_best.moves)
        _st['done'] = True
        _st['result'] = {'status': 'PARTIAL', 'moves': _b_best.moves, 'fixes': _b_best.fixes, 'reached_ply': _b_best_reach_g1}
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
                _b_absurdities = [a for a in _b_absurdities if a.ply not in _b_path.fixed_plies]
                if len(_b_absurdities) == 0:
                    # Already-valid → VALID; otherwise SOLVED. A beam path
                    # with zero fixes that reaches the end with no absurdities
                    # is the original game, untouched.
                    _b_already_valid = (len(_b_path.fixes) == 0)
                    _b_status = 'VALID' if _b_already_valid else 'SOLVED'
                    _b_message = ('Game already valid' if _b_already_valid
                                  else 'Solved with ' + str(len(_b_path.fixes)) + ' fix(es) in ' + str(round(_b_elapsed, 1)) + 's')
                    _st['done'] = True
                    _st['result'] = {'status': _b_status, 'moves': _b_path.moves, 'fixes': _b_path.fixes}
                    _step_result = json.dumps({
                        'done': True, 'status': _b_status,
                        'fixes_so_far': len(_b_path.fixes),
                        'elapsed': round(_b_elapsed, 1),
                        'winning_fixes': _b_build_win_fixes(_b_path.fixes),
                        'message': _b_message
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

                # Approved-plies set: locked cells ∪ pre-frontier prefix —
                # see greedy above for rationale.
                _b_approved = set(_st['locked_plies']) if _st['locked_plies'] else set()
                _b_cp = _st.get('confirmed_ply', 0)
                if _b_cp and _b_cp > 0:
                    _b_approved |= set(range(_b_cp))
                _b_ead_ply, _b_stop_reason, _ = play_until_absurd_or_stuck(
                    _b_path.moves, severity_threshold=3, persistence_threshold=2,
                    approved_plies=_b_approved
                )
                _b_reach = _b_ead_ply

                if _b_reach >= _b_total:
                    # EAD's persistence_threshold can skip short-lived absurdities
                    # (hanging queen, opponent fails to capture, game ends soon after).
                    # Catch those via find_all_absurdities and re-target the earliest.
                    _b_residual = find_all_absurdities(_b_path.moves)
                    _b_residual = [a for a in _b_residual if a.ply not in _b_path.fixed_plies]
                    if not _b_residual:
                        _b_new_beam.append(_b_path)
                        continue
                    _b_reach = min(a.ply for a in _b_residual)

                # Dead-end: stuck at same ply as last time, no point re-expanding
                if _b_reach == _b_path.last_stuck_ply and _b_reach < _b_total:
                    _b_new_beam.append(_b_path)
                    continue

                # Honour the review frontier + user-locked plies (same
                # reasoning as dijkstra above — review overrides were not
                # constraining beam's escalation path). Same bounded window
                # as greedy above: anchor at _b_reach, cap lookback at
                # MAX_BACKTRACK, unlock _b_reach itself, respect the user
                # frontier when not stale. Without the cap Beam was
                # branching into 17.W alternatives when reach was 26.W.
                _b_confirmed = _st.get('confirmed_ply', 0)
                _b_MAX_BACKTRACK = _st.get('max_backtrack', 5)
                _b_frontier = 0 if _b_reach < _b_confirmed else _b_confirmed
                _b_eff_min_ply = max(_b_frontier, _b_reach - _b_MAX_BACKTRACK)
                _b_eff_min_ply = max(0, min(_b_eff_min_ply, _b_reach))
                _b_eff_locked = set(_st['locked_plies']) if _st['locked_plies'] else set()
                _b_eff_locked.discard(_b_reach)
                _b_fixes = find_deep_backtrack_fixes(
                    _b_path.moves, _b_reach, _search_ocr_lookup_${stateId},
                    verbose=False, fixed_plies=_b_path.fixed_plies,
                    locked_plies=_b_eff_locked, min_ply=_b_eff_min_ply
                )

                _b_fixes = [f for f in _b_fixes if f['ply'] >= _b_eff_min_ply]
                _b_fixes = [f for f in _b_fixes if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')]
                # Verify pass: deep-quiescence re-rank top candidates. Mirrors
                # backend full_game_search.run_beam_search and prevents fast-mode
                # OFC false positives from steering this beam path.
                _b_fixes = _postprocess_phase2_fixes(
                    _b_fixes, _b_path.moves, _b_reach, verbose=False, verify_top_n=5
                )
                # Defensive: drop any fix at a locked ply. Mirrors backend
                # Beam — find_deep_backtrack_fixes's extended_search_plies
                # heuristic can reach into locked plies (piece-blocker /
                # check-mismatch hits), and a beam branch on a user-locked
                # ply silently overwrites it.
                if _b_eff_min_ply > 0 or _b_eff_locked:
                    _b_fixes = [f for f in _b_fixes
                                if f.get('ply', 0) >= _b_eff_min_ply
                                and f.get('ply', 0) not in _b_eff_locked]

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
                    # Cache the full ranked candidate list on the chosen fix so the
                    # Review UI can show alternatives without another backtrack run
                    # (mirrors Greedy's pattern at _g_best above).
                    _b_fix_with_cands = dict(_b_fix)
                    _b_fix_with_cands['all_candidates'] = _b_fixes
                    _b_new_path.fixes.append(_b_fix_with_cands)
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
                    _st['result'] = {'status': 'PARTIAL', 'moves': _b_best.moves, 'fixes': _b_best.fixes, 'reached_ply': _b_best_reach}
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
                        _st['result'] = {'status': 'PARTIAL', 'moves': _b_best.moves, 'fixes': _b_best.fixes, 'reached_ply': _b_best_reach}
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
    'elapsed': 0,
    'reached_ply': _res.get('reached_ply', None),
    # stop_message is set by Greedy's PARTIAL stop branches (no acceptable
    # fix / backward regression / anti-drift) on _st['result']. Carry it
    # through so handleSearchComplete in beam.js can render the reason
    # when the panel re-renders on game-switch (and on the live final
    # step, where handleSearchStep suppresses done=true messages).
    'stop_message': _res.get('stop_message', None)
}

def _sim_pct(_d):
    # Phase 3 fixes store 'similarity' (0-100); Phase 2 fixes store 'char_sim' (0-1).
    _s = _d.get('similarity')
    if _s is not None:
        return int(round(_s))
    _cs = _d.get('char_sim')
    if _cs is None:
        return 0
    return int(round(_cs * 100))

for _fix in _res.get('fixes', []):
    if isinstance(_fix, dict):
        _fix_out = {
            'ply': _fix.get('ply', 0),
            'ply_str': _fix.get('ply_str', '') or ply_to_str(_fix.get('ply', 0)),
            'san': _fix.get('san', ''),
            'ocr': _fix.get('ocr', ''),
            'original': _fix.get('ocr', ''),
            'similarity': _sim_pct(_fix),
            # Backtracking metadata: when fix_ply < origin_stuck_ply, this
            # candidate is a backtrack proposal — the algorithm got stuck
            # at origin_stuck_ply and is offering to repair an earlier ply.
            # Review UI uses these fields to show the stuck ply (red) and
            # the backtrack proposal (yellow) distinctly.
            'is_backtrack': bool(_fix.get('is_backtrack', False)),
            'origin_stuck_ply': _fix.get('origin_stuck_ply', _fix.get('ply', 0)),
        }
        # Carry the cached candidate list through to JS so the review panel
        # can populate alternatives without a round-trip to backtrack.
        # Include EVERY field the fix-details panel reads (reach, score
        # breakdown, etc.) — same passthrough list as full_game_search.py.
        # Without these, the color-coded score-component pills don't render
        # in review mode.
        _cands = _fix.get('all_candidates') or []
        if _cands:
            _DETAIL_FIELDS = (
                'ply', 'san', 'ocr', 'unified_score',
                'reach', 'reach_improvement', 'completes',
                'score_components', 'sim_source',
                'char_sim', 'ocr_conf', 'ocr_candidate_bonus',
                'absurdity_count', 'absurdity_penalty',
                'is_hanging', 'is_absurdity_fix', 'is_low_conf_fix',
                'original_was_legal', 'ply_str',
                # Backtracking metadata so review UI's alternative-list
                # buttons can also distinguish backtrack proposals from
                # at-stuck repairs (mirroring the chosen-fix headline).
                'is_backtrack', 'origin_stuck_ply',
            )
            _packaged_cands = []
            for _c in _cands:
                if not isinstance(_c, dict):
                    continue
                _co = {k: _c[k] for k in _DETAIL_FIELDS if k in _c}
                _co['similarity'] = _sim_pct(_c)
                if not _co.get('ply_str'):
                    _co['ply_str'] = ply_to_str(_co.get('ply', _fix.get('ply', 0)))
                _packaged_cands.append(_co)
            _fix_out['all_candidates'] = _packaged_cands
        _output['fixes'].append(_fix_out)

# Cleanup globals
for _varname in [
    '_search_state_${stateId}', '_search_moves_${stateId}',
    '_search_ocr_lookup_${stateId}', '_search_ocr_data_${stateId}',
    '_search_method_${stateId}', '_max_ply_${stateId}',
    '_dijk_initial_node_${stateId}', '_dijk_queue_${stateId}'
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
