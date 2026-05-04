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
from absurdity import find_all_absurdities
from fix_finding import find_deep_backtrack_fixes, _postprocess_phase2_fixes
from play import play_until_absurd_or_stuck

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

    def __lt__(self, other):
        if self.cost != other.cost:
            return self.cost < other.cost
        return self._tiebreaker < other._tiebreaker

    def copy_with_fix(self, fix: dict, new_cost: float) -> 'DijkstraNode':
        global _tiebreaker
        _tiebreaker += 1
        new_moves = self.moves.copy()
        new_moves[fix['ply']] = fix['san']
        return DijkstraNode(
            cost=new_cost,
            moves=new_moves,
            fixes=self.fixes + [fix],
            fixed_plies=self.fixed_plies | {fix['ply']},
            _tiebreaker=_tiebreaker
        )


# =============================================================================
# DIJKSTRA SEARCH
# =============================================================================

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
    max_backtrack: int = 5,
) -> ReconstructionResult:
    """
    Dijkstra search on game reconstructions with regret-based costs.

    At each stuck point, the search finds candidate fixes (ranked by
    unified_score from find_deep_backtrack_fixes). The cost of choosing
    fix #k is:

        edge_cost = LAMBDA + max(0, best_score - this_score)

    The top fix always costs LAMBDA (regret=0). Alternatives cost more.
    Alternatives with regret > REGRET_THRESHOLD are never pushed.

    When all alternatives exceed the threshold (common on "obvious" fixes),
    only the top fix is pushed — identical to greedy. Dijkstra only
    branches at genuinely uncertain stuck points.

    Args:
        moves:              List of SAN move strings (OCR output)
        ocr_lookup:         OCR candidate data for similarity scoring
        max_queue_size:     Cap on priority queue size (prune most expensive)
        max_steps:          Maximum nodes popped before giving up
        max_fixes_per_path: Maximum fixes on any single path
        regret_threshold:   Don't push alternatives with regret above this (42)
        lam:                Base cost per stuck point (21)
        verbose:            Print debug output
        cancel_flag:        Dict with "cancelled" key for interruption
        on_progress:        Callback for step-by-step UI updates

    Returns:
        ReconstructionResult with status, fixed moves, and metadata
    """
    global _tiebreaker
    _tiebreaker = 0

    cancel_flag = cancel_flag or {"cancelled": False}
    locked_plies = locked_plies or set()
    start_time = time.time()

    # Build OCR lookup if not provided
    if ocr_lookup is None:
        ocr_lookup = create_ocr_lookup(moves_to_ocr_moves(moves))

    total_plies = len(moves)

    def report(step, queue_size, node, status, message, paths_explored):
        if on_progress:
            reach = _get_reach(node.moves, total_plies)
            on_progress(DijkstraProgress(
                step=step,
                queue_size=queue_size,
                current_cost=node.cost,
                current_depth=len(node.fixes),
                current_reach=reach,
                total_plies=total_plies,
                status=status,
                message=message,
                elapsed=time.time() - start_time,
                paths_explored=paths_explored
            ))

    if verbose:
        print("=" * 60)
        print(f"DIJKSTRA SEARCH (λ={lam}, threshold={regret_threshold})")
        print("=" * 60)

    # Check if already valid. Zero-tolerance for residual absurdities
    # (mirrors frontend search-worker, see "Qe4 incident"). User-locked
    # plies are skipped because the user has already accepted them.
    initial_reach = _get_reach(moves, total_plies)
    if initial_reach >= total_plies:
        absurdities = find_all_absurdities(moves)
        _seed_locked = set(locked_plies) if locked_plies else set()
        residual = [a for a in absurdities if a.ply not in _seed_locked]
        if len(residual) == 0:
            return ReconstructionResult(
                status="VALID", path=moves, fixes=[],
                elapsed=time.time() - start_time, method="dijkstra"
            )

    # Initialize priority queue with the original (unfixed) game
    initial_node = DijkstraNode(
        cost=0.0, moves=moves.copy(), fixes=[], fixed_plies=set()
    )
    queue: List[DijkstraNode] = [initial_node]
    heapq.heapify(queue)

    paths_explored = 0
    best_partial = initial_node  # Track best incomplete result

    # Main search loop
    for step in range(max_steps):
        # Check cancellation
        if cancel_flag.get("cancelled"):
            report(step, len(queue), best_partial, "cancelled",
                   "Search cancelled", paths_explored)
            return ReconstructionResult(
                status="CANCELLED", path=best_partial.moves,
                fixes=best_partial.fixes,
                elapsed=time.time() - start_time, method="dijkstra"
            )

        # Queue empty = all paths exhausted
        if not queue:
            if verbose:
                print(f"\n❌ Queue empty after {paths_explored} paths explored")
            report(step, 0, best_partial, "failed",
                   "All paths exhausted", paths_explored)
            break

        # Pop cheapest node
        node = heapq.heappop(queue)
        paths_explored += 1

        # Find where this path gets stuck. Approved-plies set: locked_plies
        # ∪ range(confirmed_ply) so EAD skips both user-confirmed cells and
        # every ply below the review frontier (matches validation.py's
        # `if i < start_ply` prefix skip). Same rationale as greedy.
        _approved = set(locked_plies) if locked_plies else set()
        if confirmed_ply and confirmed_ply > 0:
            _approved |= set(range(int(confirmed_ply)))
        if USE_EAD_IN_SEARCH:
            stuck_at, stop_reason, absurdity_info = play_until_absurd_or_stuck(
                node.moves, severity_threshold=3, persistence_threshold=2,
                approved_plies=_approved
            )
        else:
            stuck_at, _ = play_until_stuck(node.moves)

        # Check if this path completes the game. Zero-tolerance for residual
        # absurdities (mirrors frontend search-worker, see "Qe4 incident").
        # If residual absurdities remain on plies this path hasn't fixed,
        # retarget stuck_at to the earliest one and fall through to the
        # expansion block so this node can branch on a fix there.
        if stuck_at >= total_plies:
            absurdities = find_all_absurdities(node.moves)
            residual = [a for a in absurdities if a.ply not in node.fixed_plies]
            if len(residual) == 0:
                elapsed = time.time() - start_time
                if verbose:
                    print(f"\n✅ SOLVED: cost={node.cost:.0f}, "
                          f"{len(node.fixes)} fixes, "
                          f"{paths_explored} paths explored, "
                          f"{elapsed:.2f}s")
                    for f in node.fixes:
                        print(f"   {ply_to_str(f['ply'])}: "
                              f"{f.get('ocr','')} → {f.get('san','')}")
                report(step, len(queue), node, "solved",
                       f"Solved! {len(node.fixes)} fixes, cost={node.cost:.0f}",
                       paths_explored)
                return ReconstructionResult(
                    status="SOLVED", path=node.moves, fixes=node.fixes,
                    elapsed=elapsed, method="dijkstra"
                )
            else:
                stuck_at = min(a.ply for a in residual)
                if verbose:
                    print(f"   [{step}] [RESIDUAL] retarget stuck to "
                          f"{ply_to_str(stuck_at)} ({len(residual)} absurdity/ies)")

        # Track best partial result (furthest reach)
        if stuck_at > _get_reach(best_partial.moves, total_plies):
            best_partial = node

        # Don't expand if already at max fixes
        if len(node.fixes) >= max_fixes_per_path:
            if verbose:
                print(f"   [{step}] cost={node.cost:.0f} depth={len(node.fixes)} "
                      f"reach={ply_to_str(stuck_at)} — max fixes reached")
            continue

        # Find fixes at this stuck point. Same bounded window as greedy above:
        # anchor at stuck_at, cap lookback at max_backtrack, unlock stuck_at
        # itself, respect user frontier when fresh. Without the cap a fresh
        # batch call with confirmed_ply=0 would let Dijkstra explore fixes
        # 15+ plies back from the stuck point. max_backtrack mirrors the
        # user's Deep Search Depth setting in the UI.
        _frontier = 0 if stuck_at < confirmed_ply else confirmed_ply
        effective_min_ply = max(_frontier, stuck_at - max_backtrack)
        effective_min_ply = max(0, min(effective_min_ply, stuck_at))
        effective_locked = set(locked_plies) if locked_plies else set()
        effective_locked.discard(stuck_at)
        fixes = find_deep_backtrack_fixes(
            node.moves, stuck_at, ocr_lookup,
            verbose=False, fixed_plies=node.fixed_plies,
            locked_plies=effective_locked, min_ply=effective_min_ply
        )
        fixes = [f for f in fixes if f['ply'] not in node.fixed_plies]
        # Same verify-pass rationale as Greedy/Beam in full_game_search.py.
        # Dijkstra branches based on a regret threshold against fixes[0]'s
        # score; without verification, a false-positive OFC-demoted
        # candidate would be priced as if it were a worse path than it
        # actually is, distorting the cost ordering. verify_top_n=5 covers
        # the candidates that typically fall inside the regret window.
        fixes = _postprocess_phase2_fixes(
            fixes, node.moves, stuck_at, verbose=False, verify_top_n=5
        )
        # Defensive: strip any fix that violates the effective frontier so
        # a node expanded in dijkstra never branches into a locked or
        # pre-confirmed ply, even if find_deep_backtrack_fixes's heuristic
        # extended_search_plies reach below min_ply.
        if effective_min_ply > 0 or effective_locked:
            fixes = [f for f in fixes
                     if f.get('ply', 0) >= effective_min_ply
                     and f.get('ply', 0) not in effective_locked]

        if not fixes:
            if verbose:
                print(f"   [{step}] cost={node.cost:.0f} depth={len(node.fixes)} "
                      f"reach={ply_to_str(stuck_at)} — dead end (no fixes)")
            continue  # Dead end; Dijkstra will try next from queue

        # Determine best score for regret calculation
        best_score = fixes[0].get('unified_score', 0)

        # Push candidates that pass the regret threshold
        pushed = 0
        for fix in fixes:
            this_score = fix.get('unified_score', 0)
            regret = max(0, best_score - this_score)

            # The Answer: don't explore alternatives with regret > 42
            if regret > regret_threshold:
                break  # Fixes are sorted by score, rest will be worse

            edge_cost = lam + regret
            new_cost = node.cost + edge_cost
            new_node = node.copy_with_fix(fix, new_cost)
            heapq.heappush(queue, new_node)
            pushed += 1

        if verbose:
            mode = "greedy" if pushed == 1 else f"branching({pushed})"
            print(f"   [{step}] cost={node.cost:.0f} depth={len(node.fixes)} "
                  f"reach={ply_to_str(stuck_at)} → {mode} "
                  f"(gap={best_score - fixes[min(1,len(fixes)-1)].get('unified_score',0):.0f})")
            if pushed > 1:
                for fix in fixes[:pushed]:
                    r = max(0, best_score - fix.get('unified_score', 0))
                    print(f"      {ply_to_str(fix['ply'])}: "
                          f"{fix.get('ocr','')} → {fix.get('san','')} "
                          f"(score={fix.get('unified_score',0):.0f}, regret={r:.0f})")

        report(step, len(queue), node,
               "exploring" if pushed == 1 else "branching",
               f"{'Greedy' if pushed == 1 else f'Branch({pushed})'} at "
               f"{ply_to_str(stuck_at)}, cost={node.cost:.0f}, "
               f"depth={len(node.fixes)}, queue={len(queue)}",
               paths_explored)

        # Prune queue if it exceeds max size (keep cheapest)
        if len(queue) > max_queue_size:
            pruned = heapq.nsmallest(max_queue_size, queue)
            queue = pruned
            heapq.heapify(queue)
            if verbose:
                print(f"   ⚠ Queue pruned: {len(queue)} → {max_queue_size}")

    # Return best partial result
    elapsed = time.time() - start_time
    final_reach = _get_reach(best_partial.moves, total_plies)

    if verbose:
        print(f"\n⚠ PARTIAL: reached {ply_to_str(final_reach)}/{total_plies}, "
              f"{len(best_partial.fixes)} fixes, "
              f"{paths_explored} paths explored, {elapsed:.2f}s")

    return ReconstructionResult(
        status="PARTIAL" if best_partial.fixes else "FAILED",
        path=best_partial.moves,
        fixes=best_partial.fixes,
        elapsed=elapsed,
        method="dijkstra"
    )


def _get_reach(moves: List[str], total_plies: int) -> int:
    """Get how far a move list plays before getting stuck."""
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
