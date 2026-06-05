"""
Score2PGN - Dijkstra Search with Regret-Based Cost
====================================================
"The Answer to the Ultimate Question of Life, the Universe,
 and Chess Scoresheet Reconstruction" - Douglas Adams, probably

This is a pruned best-first search (Dijkstra) on the space of game
reconstructions, where edge costs are defined by REGRET: how much worse
a fix is compared to the best available fix at each stuck point.

Formally:
  - Nodes: partial game states (moves applied so far + set of fixes)
  - Edges: applying a fix at a stuck point
  - Edge cost: LAMBDA + regret(fix)
  - regret(fix) = score(best_fix) - score(this_fix)  [0 for the top fix]
  - LAMBDA: base cost per stuck point (penalizes cascading errors)

Key insight: a wrong early fix tends to CREATE extra stuck points
downstream. Each extra stuck point adds at least LAMBDA to the path cost,
eventually making the correct alternative (with fewer stuck points) cheaper.

The REGRET_THRESHOLD limits what enters the priority queue. If the gap
between fix #1 and fix #K exceeds the threshold, fix #K is not pushed.
This prevents the queue from flooding with mediocre alternatives that
would waste time being explored before the correct path advances.

This is NOT A* because we have no heuristic h(n) estimating remaining
cost to the goal. It's closest to "branch-and-bound" or "pruned
best-first search." When all gaps exceed the threshold (common case),
it degenerates to greedy and runs at identical speed.

Usage:
    result = run_dijkstra_search(moves, ocr_lookup=ocr_lookup)
"""

import heapq
import time
from typing import List, Dict, Optional, Callable, Set, Tuple
from dataclasses import dataclass, field

from data_structures import OCRMove, ReconstructionResult
from helpers import (
    ply_to_str, play_until_stuck,
    create_ocr_lookup, moves_to_ocr_moves
)
from absurdity import find_all_absurdities, AbsurditiesPrefixCache
from fix_finding import find_deep_backtrack_fixes, _postprocess_phase2_fixes, find_fixes_two_phase
from play import play_until_absurd_or_stuck, EadPrefixCache
from full_game_search import LegalPrefixCache, _recompute_auto_locks_into, resolve_forced_stop_choice

# Flag to enable/disable EAD in full game search
USE_EAD_IN_SEARCH = True


# =============================================================================
# COST PARAMETERS
# =============================================================================

# The Answer to the Ultimate Question of Life, the Universe,
# and Chess Scoresheet Reconstruction.
REGRET_THRESHOLD = 42  # Don't explore alternatives with regret > 42

# Half the Answer: base cost per stuck point encountered.
# Penalizes paths that cascade into many stuck points (sign of wrong early fix).
LAMBDA = 21


# =============================================================================
# PROGRESS REPORTING
# =============================================================================

@dataclass
class DijkstraProgress:
    """Progress update for UI callbacks."""
    step: int
    queue_size: int
    current_cost: float
    current_depth: int  # number of fixes on this path
    current_reach: int  # how far this path plays
    total_plies: int
    status: str  # "exploring", "branching", "solved", "failed", "cancelled"
    message: str
    elapsed: float
    paths_explored: int = 0


# =============================================================================
# SEARCH STATE
# =============================================================================

# Tiebreaker counter for heap ordering when costs are equal
_tiebreaker = 0


@dataclass
class DijkstraNode:
    """A node in the search: a partial game reconstruction."""
    cost: float
    moves: List[str]
    fixes: List[dict]
    fixed_plies: Set[int]

    # For heap ordering: (cost, tiebreaker)
    # Lower cost = higher priority (explored first)
    _tiebreaker: int = 0

    # Per-node Tier 1 auto-locks. Different nodes diverge at different fix
    # plies, so the reachable Tier 1 set is node-specific. Recomputed via
    # ``_recompute_auto_locks_into`` after every applied fix in copy_with_fix.
    tier1_locked: Set[int] = field(default_factory=set)

    # Per-node caches. Like BeamPath, Dijkstra nodes diverge after
    # ``copy_with_fix`` so each must own its own cache instance — a shared
    # cache would let one branch's ``invalidate_from`` corrupt another's
    # prefix. ``copy_with_fix`` clones each alongside the move list and
    # invalidates them at the new fix ply.
    legal_prefix: LegalPrefixCache = field(default_factory=LegalPrefixCache)
    ead_prefix: EadPrefixCache = field(default_factory=EadPrefixCache)
    absurdities_prefix: AbsurditiesPrefixCache = field(default_factory=AbsurditiesPrefixCache)

    def __lt__(self, other):
        if self.cost != other.cost:
            return self.cost < other.cost
        return self._tiebreaker < other._tiebreaker

    def copy_with_fix(self, fix: dict, new_cost: float,
                      tier1_agreed_plies: Set[int] = None,
                      record: bool = True) -> 'DijkstraNode':
        # record=False: advance the node (mark fix['ply'] resolved in
        # fixed_plies so the forced-stop subtraction lets play continue past it)
        # WITHOUT adding a visible review step to node.fixes. Used for a
        # single-legal forced-stop (only one reading is legal — accept it
        # silently, no "choose" prompt; mirrors greedy/beam which record nothing).
        global _tiebreaker
        _tiebreaker += 1
        new_moves = self.moves.copy()
        new_moves[fix['ply']] = fix['san']
        new_legal = self.legal_prefix.copy()
        new_ead = self.ead_prefix.copy()
        new_absurdities = self.absurdities_prefix.copy()
        new_legal.invalidate_from(fix['ply'])
        new_ead.invalidate_from(fix['ply'])
        new_absurdities.invalidate_from(fix['ply'])
        new_tier1_locked = self.tier1_locked.copy()
        if tier1_agreed_plies:
            _recompute_auto_locks_into(new_moves, tier1_agreed_plies, new_tier1_locked)
        return DijkstraNode(
            cost=new_cost,
            moves=new_moves,
            fixes=self.fixes + ([fix] if record else []),
            fixed_plies=self.fixed_plies | {fix['ply']},
            _tiebreaker=_tiebreaker,
            tier1_locked=new_tier1_locked,
            legal_prefix=new_legal,
            ead_prefix=new_ead,
            absurdities_prefix=new_absurdities,
        )


# =============================================================================
# DIJKSTRA SEARCH
# =============================================================================

# Two-function API: ``dijkstra_init`` builds a state dict, ``dijkstra_step``
# pops one node and expands it. Both ``run_dijkstra_search`` (the CLI/test
# in-process loop in this file) and ``search-worker.js`` call into this
# single implementation. Before this split, Dijkstra lived in two places
# with material divergence — find_deep_backtrack_fixes vs find_fixes_two_
# phase, locked plies in EAD approved, missing phase2_floor window, no
# all_candidates cache, no fixed_plies seeding from user locks, etc. Same
# story as Greedy and Beam.
#
# Worker-canonical semantics: find_fixes_two_phase + verify_top_n=15,
# phase2_floor window with from_heuristic/before_frontier exemption, EAD
# approved = pre-frontier prefix only, fixed_plies seeded with user locks,
# VALID vs SOLVED distinction, explicit max_steps branch. Per-node prefix
# caches are layered on top here (port from the old Python copy). The
# best_partial comparison uses EAD-aware reach on both sides (a small
# tightening over the worker's mixed EAD-vs-play_until_stuck comparison).


def dijkstra_init(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove],
    *,
    confirmed_ply: int = 0,
    locked_plies: Optional[Set[int]] = None,
    tier1_agreed_plies: Optional[Set[int]] = None,
    max_queue_size: int = 50,
    max_steps: int = 1000,
    max_fixes_per_path: int = 15,
    regret_threshold: float = REGRET_THRESHOLD,
    lam: float = LAMBDA,
    max_backtrack: int = 5,
    forced_stop_plies: Optional[Set[int]] = None,
) -> dict:
    """Build a Dijkstra search state dict. See dijkstra_step for the iteration.

    ``forced_stop_plies``: see greedy_init / beam_init. A node reaching a
    forced-stop ply is consumed without expansion — Dijkstra defers the
    near-tie / low-confidence choice to the user rather than guessing.

    ``tier1_agreed_plies``: see greedy_init / beam_init. Dijkstra tracks an
    auto-lock set per-node (``DijkstraNode.tier1_locked``) because different
    nodes diverge at different fix plies and therefore have different
    reachable Tier 1 prefixes.
    """
    global _tiebreaker
    _tiebreaker = 0

    locked_set = set(locked_plies) if locked_plies else set()
    tier1_set = set(tier1_agreed_plies) if tier1_agreed_plies else set()

    initial_node = DijkstraNode(
        cost=0.0,
        moves=list(moves),
        fixes=[],
        # Seed with user locks (worker-canonical): residual-absurdity
        # retargeting excludes plies the user has confirmed or that are
        # tier-1 merge-locked. See beam_init for the full rationale.
        fixed_plies=set(locked_set),
    )
    # Initial auto-lock pass on the seed node (mirrors greedy/beam init).
    _recompute_auto_locks_into(initial_node.moves, tier1_set, initial_node.tier1_locked)

    queue: List[DijkstraNode] = [initial_node]
    heapq.heapify(queue)

    return {
        'method': 'dijkstra',
        'queue': queue,
        'ocr_lookup': ocr_lookup,
        'total_plies': len(moves),
        'confirmed_ply': int(confirmed_ply) if confirmed_ply else 0,
        'locked_plies': locked_set,
        'tier1_agreed_plies': tier1_set,
        'max_queue_size': int(max_queue_size),
        'max_steps': int(max_steps),
        'max_fixes_per_path': int(max_fixes_per_path),
        'max_backtrack': int(max_backtrack),
        'forced_stop_plies': set(forced_stop_plies) if forced_stop_plies else set(),
        'regret_threshold': float(regret_threshold),
        'LAMBDA': float(lam),
        'step': 0,
        'paths_explored': 0,
        'best_partial': initial_node,
        'start_time': time.time(),
        'done': False,
        'result': None,
    }


def _dijk_reach_cached(node: DijkstraNode) -> int:
    """EAD-aware reach for best_partial comparison, using the node's own
    prefix cache so repeat calls stay O(1) per ply rather than restarting
    from ply 0. The worker had a small inconsistency here — comparing the
    candidate's EAD reach to ``play_until_stuck`` of best_partial. Aligning
    both sides to EAD (with caches) tightens that without changing the
    overall ranking direction.
    """
    if USE_EAD_IN_SEARCH:
        reach, _, _ = play_until_absurd_or_stuck(
            node.moves, severity_threshold=3, persistence_threshold=2,
            prefix_cache=node.ead_prefix,
        )
        return reach
    reach, _ = node.legal_prefix.play_until_stuck(node.moves)
    return reach


def dijkstra_step(state: dict) -> dict:
    """Pop the cheapest node and expand it. Mutates ``state`` in place.
    JSON-serializable return dict (same contract as greedy_step / beam_step).
    """
    if state['done']:
        prior = state.get('result') or {}
        return {
            'done': True,
            'status': prior.get('status', 'DONE'),
            'message': 'Already done',
            'elapsed': round(time.time() - state['start_time'], 1),
            'fixes_so_far': len(prior.get('fixes', [])),
        }

    queue = state['queue']
    total = state['total_plies']
    LAM = state['LAMBDA']
    regret_threshold = state['regret_threshold']
    elapsed = time.time() - state['start_time']
    tier1 = state.get('tier1_agreed_plies', set())
    confirmed = state['confirmed_ply']
    max_backtrack = state['max_backtrack']
    locked = state['locked_plies']

    # === Guard 1: queue empty ===
    if not queue:
        bp = state['best_partial']
        bp_reach = _dijk_reach_cached(bp) if bp.moves else 0
        status = 'FAILED' if not bp.fixes else 'PARTIAL'
        state['done'] = True
        state['result'] = {
            'status': status, 'moves': bp.moves, 'fixes': bp.fixes,
            'reached_ply': bp_reach,
        }
        return {
            'done': True, 'status': status,
            'fixes_so_far': len(bp.fixes),
            'elapsed': round(elapsed, 1),
            'message': f"Queue empty ({round(elapsed, 1)}s)",
        }

    # === Guard 2: max_steps reached ===
    if state['step'] >= state['max_steps']:
        bp = state['best_partial']
        bp_reach = _dijk_reach_cached(bp) if bp.moves else 0
        state['done'] = True
        state['result'] = {
            'status': 'PARTIAL', 'moves': bp.moves, 'fixes': bp.fixes,
            'reached_ply': bp_reach,
        }
        return {
            'done': True, 'status': 'PARTIAL',
            'fixes_so_far': len(bp.fixes),
            'elapsed': round(elapsed, 1),
            'message': (f"Max steps ({state['max_steps']}) reached "
                        f"({round(elapsed, 1)}s)"),
        }

    # Pop cheapest node
    node = heapq.heappop(queue)
    state['paths_explored'] += 1
    state['step'] += 1

    # Approved-plies set: pre-frontier prefix ONLY. locked_plies are
    # deliberately NOT included — see greedy_step for the full rationale.
    approved = set()
    if confirmed and confirmed > 0:
        approved |= set(range(int(confirmed)))
    if USE_EAD_IN_SEARCH:
        stuck_at, _stop_reason, _abs_info = play_until_absurd_or_stuck(
            node.moves, severity_threshold=3, persistence_threshold=2,
            approved_plies=approved, prefix_cache=node.ead_prefix,
            # A forced-stop ply this node already CHOSE at (fixed_plies) is
            # resolved — don't re-stop, or Dijkstra would re-queue it forever.
            forced_stop_plies=state.get('forced_stop_plies', set()) - node.fixed_plies,
        )
    else:
        stuck_at, _ = node.legal_prefix.play_until_stuck(node.moves)

    # NOTE: stop_reason 'ambiguous' (forced-stop ply) is NOT special-cased. The
    # forced_stop_plies passed into the play call above make it STOP here (a
    # legal but dual-sheet-ambiguous / very-low-confidence ply) so expansion
    # runs at the right anchor; the two-phase search then ranks the OCR
    # candidates by reach and pushes the best (e.g. Qb8 over the downstream-
    # hanging Rb8). When reach can't decide, no fix is found and the node
    # dead-ends — Dijkstra defers to the user only when it genuinely can't pick.

    # === Check if this path completes the game ===
    residual_pending = False
    if stuck_at >= total:
        absurdities = find_all_absurdities(node.moves, prefix_cache=node.absurdities_prefix)
        residual = [a for a in absurdities if a.ply not in node.fixed_plies]
        if len(residual) == 0:
            already_valid = (len(node.fixes) == 0)
            status = 'VALID' if already_valid else 'SOLVED'
            message = ('Game already valid' if already_valid
                       else f"Solved with {len(node.fixes)} fix(es) "
                            f"in {round(elapsed, 1)}s")
            state['done'] = True
            state['result'] = {
                'status': status, 'moves': node.moves, 'fixes': node.fixes,
            }
            return {
                'done': True, 'status': status,
                'fixes_so_far': len(node.fixes),
                'elapsed': round(elapsed, 1),
                'message': message,
            }
        # Retarget stuck_at to earliest residual and fall through to expand.
        stuck_at = min(a.ply for a in residual)
        residual_pending = True

    # Track best partial result (furthest reach). EAD-aware on both sides
    # via the per-node cache.
    if stuck_at > _dijk_reach_cached(state['best_partial']):
        state['best_partial'] = node

    # === Don't expand at max fixes ===
    if len(node.fixes) >= state['max_fixes_per_path']:
        return {
            'done': False, 'step': state['step'],
            'queue_size': len(queue), 'current_cost': int(node.cost),
            'depth': len(node.fixes), 'reach': stuck_at,
            'reach_str': ply_to_str(stuck_at), 'total_plies': total,
            'elapsed': round(elapsed, 1),
            'message': f"Max fixes reached at depth {len(node.fixes)}",
        }

    # Bounded search window: anchor at stuck_at, cap lookback at
    # max_backtrack, unlock stuck_at itself (unless Tier 1 agreed — then OCR
    # is almost certainly correct and the error is upstream).
    _frontier = 0 if stuck_at < confirmed else confirmed
    eff_min_ply = max(_frontier, stuck_at - max_backtrack)
    eff_min_ply = max(0, min(eff_min_ply, stuck_at))
    # Compose effective locks: game-level + this node's auto-locks.
    if locked or node.tier1_locked:
        eff_locked = set(locked) | set(node.tier1_locked)
    else:
        eff_locked = set()
    if stuck_at not in tier1:
        eff_locked.discard(stuck_at)

    # Two-phase search — see greedy_step / beam_step for rationale.
    fixes = find_fixes_two_phase(
        node.moves, stuck_at, state['ocr_lookup'],
        verbose=False, fixed_plies=node.fixed_plies,
        locked_plies=eff_locked, min_ply=eff_min_ply,
        phase2_depth=max_backtrack, verify_top_n=15,
    )
    fixes = [f for f in fixes if f['ply'] not in node.fixed_plies]
    # Keep the phantom-check repair (e.g. illegal "Bf4+" → "Bf4"); see
    # greedy_step for the full rationale.
    fixes = [
        f for f in fixes
        if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')
        or (f['san'] != f.get('ocr', '') and f.get('original_was_legal') is False)
    ]
    # Restrict to declared Phase 1 + Phase 2 windows; drop heuristic
    # extensions outside both. See greedy_step / beam_step.
    phase2_floor = max(0, eff_min_ply - max_backtrack)
    fixes = [
        f for f in fixes
        if f.get('from_heuristic')
        or (f.get('before_frontier')
            and phase2_floor <= f.get('ply', 0) < eff_min_ply)
        or (not f.get('before_frontier') and f.get('ply', 0) >= eff_min_ply)
    ]
    # Defensive: drop any fix at a locked ply.
    if eff_locked:
        fixes = [f for f in fixes
                 if f.get('ply', 0) not in eff_locked]

    # Forced-stop ambiguity: SCORE the readings (proper unified score, see
    # resolve_forced_stop_choice) and push ONE node with the result — copy_with_fix
    # applies marker['san'], which may be a CHANGE (best-scored reading, e.g. 7.B
    # Ngf6) or the KEEP (san==current, e.g. 12.B Qb8). Either way the ply is added
    # to fixed_plies so exploration continues past it. When there are >=2 legal
    # readings the marker is RECORDED as a review step (user chooses); when only
    # ONE reading is legal (resolve returns None) we advance but record NOTHING —
    # an unambiguous "only Bb7 is legal" ply needs no "choose" prompt.
    if USE_EAD_IN_SEARCH and _stop_reason == 'ambiguous':
        _cur = node.moves[stuck_at] if stuck_at < len(node.moves) else ''
        marker = resolve_forced_stop_choice(
            node.moves, stuck_at, state['ocr_lookup'],
            fixed_plies=node.fixed_plies, locked_plies=eff_locked,
            min_ply=eff_min_ply, phase2_depth=max_backtrack)
        _record = marker is not None
        if marker is None:
            marker = {
                'ply': stuck_at, 'ply_str': ply_to_str(stuck_at),
                'ocr': _cur, 'san': _cur, 'char_sim': 1.0, 'unified_score': 0.0,
                'keep_as_is': True, 'is_keep_as_is': True,
                'is_backtrack': False, 'origin_stuck_ply': stuck_at,
                'origin_stop_reason': 'ambiguous',
            }
        _is_change = bool(marker.get('san') and marker['san'] != _cur)
        new_node = node.copy_with_fix(
            dict(marker), node.cost + LAM, tier1_agreed_plies=tier1, record=_record)
        heapq.heappush(queue, new_node)
        return {
            'done': False, 'step': state['step'],
            'queue_size': len(queue), 'current_cost': int(node.cost),
            'depth': len(node.fixes), 'reach': stuck_at,
            'reach_str': ply_to_str(stuck_at), 'total_plies': total,
            'status': 'exploring', 'pushed': 1,
            'elapsed': round(elapsed, 1),
            'fix_ply': ply_to_str(stuck_at),
            'fix_from': marker.get('ocr', ''), 'fix_to': marker.get('san', ''),
            'message': ((f"[ambiguity] {ply_to_str(stuck_at)}: {marker.get('ocr','')} "
                         f"-> {marker.get('san','')} (score {marker.get('unified_score',0):.0f})")
                        if _is_change else
                        f"[ambiguity] {ply_to_str(stuck_at)} kept as-is; flagged for review"),
        }

    # TEMP DIAG (mirrors GREEDY-DIAG / BEAM-DIAG).
    print(f"[DIJK-DIAG] step={state['step']} depth={len(node.fixes)} "
          f"cost={int(node.cost)} reach={ply_to_str(stuck_at)} "
          f"min_ply={eff_min_ply} confirmed={confirmed} "
          f"eff_locked={sorted(eff_locked)} "
          f"node_fixed={sorted(node.fixed_plies)} "
          f"queue={len(queue)}:")
    for _i, _f in enumerate(fixes[:5]):
        print(f"[DIJK-DIAG]   #{_i+1} ply={ply_to_str(_f.get('ply',-1))} "
              f"'{_f.get('ocr','?')}'->'{_f.get('san','?')}' "
              f"score={_f.get('unified_score',0):.0f} "
              f"sim={_f.get('char_sim',0):.0%} "
              f"reach={ply_to_str(_f.get('reach',-1))} "
              f"heur={bool(_f.get('from_heuristic'))} "
              f"bf={bool(_f.get('before_frontier'))} "
              f"abs={_f.get('absurdity_count',0)}")

    if not fixes:
        return {
            'done': False, 'step': state['step'],
            'queue_size': len(queue), 'current_cost': int(node.cost),
            'depth': len(node.fixes), 'reach': stuck_at,
            'reach_str': ply_to_str(stuck_at), 'total_plies': total,
            'elapsed': round(elapsed, 1),
            'message': f"Dead end at {ply_to_str(stuck_at)}",
        }

    # Push candidates that pass the regret threshold.
    best_score = fixes[0].get('unified_score', 0)
    pushed = 0
    first_fix = fixes[0]

    for fix in fixes:
        this_score = fix.get('unified_score', 0)
        regret = max(0, best_score - this_score)
        # The Answer: don't explore alternatives with regret > 42.
        if regret > regret_threshold:
            break
        edge_cost = LAM + regret
        new_cost = node.cost + edge_cost
        # Cache the full ranked candidate list on the chosen fix so the
        # Review UI can show alternatives without another backtrack run.
        fix_with_cands = dict(fix)
        fix_with_cands['all_candidates'] = fixes
        new_node = node.copy_with_fix(
            fix_with_cands, new_cost, tier1_agreed_plies=tier1
        )
        heapq.heappush(queue, new_node)
        pushed += 1

    # Prune queue
    if len(queue) > state['max_queue_size']:
        pruned = heapq.nsmallest(state['max_queue_size'], queue)
        state['queue'] = pruned
        queue = pruned
        heapq.heapify(queue)

    status = 'exploring' if pushed == 1 else 'branching'
    return {
        'done': False, 'step': state['step'],
        'queue_size': len(queue), 'current_cost': int(node.cost),
        'depth': len(node.fixes), 'reach': stuck_at,
        'reach_str': ply_to_str(stuck_at), 'total_plies': total,
        'status': status, 'pushed': pushed,
        'elapsed': round(elapsed, 1),
        'fix_ply': ply_to_str(first_fix['ply']),
        'fix_from': first_fix.get('ocr', ''),
        'fix_to': first_fix.get('san', ''),
        'message': (f"{'Greedy' if pushed == 1 else f'Branch({pushed})'} at "
                    f"{ply_to_str(stuck_at)}, cost={int(node.cost)}, "
                    f"depth={len(node.fixes)}, queue={len(queue)}"),
    }


def run_dijkstra_search(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove] = None,
    max_queue_size: int = 50,
    max_steps: int = 1000,
    max_fixes_per_path: int = 15,
    regret_threshold: float = REGRET_THRESHOLD,
    lam: float = LAMBDA,
    verbose: bool = False,
    cancel_flag: Dict = None,
    on_progress: Callable[[DijkstraProgress], None] = None,
    confirmed_ply: int = 0,
    locked_plies: Set[int] = None,
    tier1_agreed_plies: Set[int] = None,
    max_backtrack: int = 5,
) -> ReconstructionResult:
    """Dijkstra search on game reconstructions with regret-based costs.

    Thin loop around ``dijkstra_init`` + ``dijkstra_step``. Both this
    wrapper and the browser's ``search-worker.js`` share that one canonical
    step implementation; see the comment above dijkstra_init for the full
    history.
    """
    cancel_flag = cancel_flag or {"cancelled": False}

    if ocr_lookup is None:
        ocr_lookup = create_ocr_lookup(moves_to_ocr_moves(moves))

    if verbose:
        print("=" * 60)
        print(f"DIJKSTRA SEARCH (lambda={lam}, threshold={regret_threshold})")
        print("=" * 60)

    state = dijkstra_init(
        moves, ocr_lookup,
        confirmed_ply=confirmed_ply, locked_plies=locked_plies,
        tier1_agreed_plies=tier1_agreed_plies,
        max_queue_size=max_queue_size, max_steps=max_steps,
        max_fixes_per_path=max_fixes_per_path,
        regret_threshold=regret_threshold, lam=lam,
        max_backtrack=max_backtrack,
    )

    def _emit_progress(step_result: dict):
        if not on_progress:
            return
        node = state['best_partial']
        reach = _dijk_reach_cached(node)
        on_progress(DijkstraProgress(
            step=state['step'],
            queue_size=len(state['queue']),
            current_cost=node.cost,
            current_depth=len(node.fixes),
            current_reach=reach,
            total_plies=state['total_plies'],
            status=step_result.get('status', 'exploring'),
            message=step_result.get('message', ''),
            elapsed=time.time() - state['start_time'],
            paths_explored=state['paths_explored'],
        ))

    while not state['done']:
        if cancel_flag.get("cancelled"):
            elapsed = time.time() - state['start_time']
            bp = state['best_partial']
            if on_progress:
                on_progress(DijkstraProgress(
                    step=state['step'], queue_size=len(state['queue']),
                    current_cost=bp.cost, current_depth=len(bp.fixes),
                    current_reach=_dijk_reach_cached(bp),
                    total_plies=state['total_plies'],
                    status='cancelled', message='Search cancelled',
                    elapsed=elapsed, paths_explored=state['paths_explored'],
                ))
            return ReconstructionResult(
                status="CANCELLED", path=bp.moves, fixes=bp.fixes,
                elapsed=elapsed, method="dijkstra",
            )
        step_result = dijkstra_step(state)
        _emit_progress(step_result)
        if verbose and step_result.get('message'):
            print(f"   {step_result['message']}")

    result = state['result'] or {}
    return ReconstructionResult(
        status=result.get('status', 'PARTIAL'),
        path=result.get('moves', state['best_partial'].moves),
        fixes=result.get('fixes', []),
        elapsed=time.time() - state['start_time'],
        method="dijkstra",
    )


def _get_reach(moves: List[str], total_plies: int) -> int:
    """Get how far a move list plays before getting stuck. Uncached helper
    kept for backwards-compat with reconstruct_dijkstra and external callers
    that don't have a prefix cache to thread through. In-loop comparisons
    inside dijkstra_step use ``_dijk_reach_cached`` instead.
    """
    if USE_EAD_IN_SEARCH:
        reach, _, _ = play_until_absurd_or_stuck(
            moves, severity_threshold=3, persistence_threshold=2
        )
    else:
        reach, _ = play_until_stuck(moves)
    return reach


# =============================================================================
# CONVENIENCE WRAPPER (matches existing interface)
# =============================================================================

def reconstruct_dijkstra(
    ocr_moves: List[OCRMove],
    verbose: bool = True,
    progress_callback: Callable = None,
    **kwargs
) -> ReconstructionResult:
    """
    Dijkstra reconstruction - wrapper for OCRMove input.

    Maintains compatibility with reconstruct_game() interface.
    """
    from helpers import ocr_moves_to_list, create_ocr_lookup

    moves = ocr_moves_to_list(ocr_moves)
    ocr_lookup = create_ocr_lookup(ocr_moves)

    def on_progress(progress: DijkstraProgress):
        if progress_callback:
            progress_callback(progress.step, progress.paths_explored, 0)

    return run_dijkstra_search(
        moves=moves,
        ocr_lookup=ocr_lookup,
        verbose=verbose,
        on_progress=on_progress if progress_callback else None,
        **kwargs
    )
