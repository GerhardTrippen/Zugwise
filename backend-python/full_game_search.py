"""
Score2PGN - Full Game Search Algorithms
=======================================
User-initiated search algorithms for fixing entire games.

These are OPTIONAL tools that run when the user clicks a button.
They are NOT part of the default validation pipeline.

Features:
- Unified input interface (always List[str])
- Interruptible via cancel_flag
- Progress callbacks for UI updates
- Clear separation from instant validation

Usage:
    from full_game_search import run_greedy_search, run_beam_search
    
    # With cancel support
    cancel_flag = {"cancelled": False}
    result = run_greedy_search(moves, cancel_flag=cancel_flag, 
                                on_progress=update_ui)
    
    # To cancel from another thread:
    cancel_flag["cancelled"] = True
"""

import time
from typing import List, Dict, Optional, Callable, Set
from dataclasses import dataclass, field

import chess

from data_structures import OCRMove, ReconstructionResult
from helpers import (
    ply_to_str, try_move, play_until_stuck,
    ocr_moves_to_list, create_ocr_lookup, moves_to_ocr_moves
)
from similarity import move_similarity
from absurdity import find_all_absurdities
from fix_finding import find_deep_backtrack_fixes

# Early Absurdity Detection (January 2026)
from play import play_until_absurd_or_stuck

# Flag to enable/disable EAD in full game search
USE_EAD_IN_SEARCH = True


# =============================================================================
# PROGRESS REPORTING
# =============================================================================

@dataclass
class SearchProgress:
    """Progress update for UI callbacks."""
    iteration: int
    max_iterations: int
    current_ply: int
    total_plies: int
    status: str  # "searching", "applying_fix", "validating", "complete", "cancelled"
    message: str
    elapsed: float
    fixes_applied: int = 0


# =============================================================================
# GREEDY SEARCH (Single-path with backtracking)
# =============================================================================

def run_greedy_search(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove] = None,
    max_fixes: int = 15,
    verbose: bool = False,
    cancel_flag: Dict = None,
    on_progress: Callable[[SearchProgress], None] = None
) -> ReconstructionResult:
    """
    Greedy reconstruction: iteratively fix one error at a time.
    
    Algorithm:
    1. Play forward until stuck
    2. Use backtracking to find best fix
    3. Apply fix, repeat
    
    This is FAST for games with few errors, but may fail on complex
    cases where the "best local fix" isn't globally correct.
    
    Args:
        moves: List of SAN move strings
        ocr_lookup: Optional OCR data for similarity scoring
        max_fixes: Maximum fixes to attempt before giving up
        verbose: Print debug output
        cancel_flag: Dict with "cancelled" key - set to True to interrupt
        on_progress: Callback for progress updates
        
    Returns:
        ReconstructionResult with status, fixed moves, and metadata
    """
    cancel_flag = cancel_flag or {"cancelled": False}
    start_time = time.time()
    
    # Build OCR lookup if not provided
    if ocr_lookup is None:
        ocr_lookup = create_ocr_lookup(moves_to_ocr_moves(moves))
    
    current_moves = moves.copy()
    total_plies = len(moves)
    all_fixes = []
    fixed_plies: Set[int] = set()
    
    def report_progress(iteration: int, status: str, message: str, current_ply: int = 0):
        if on_progress:
            on_progress(SearchProgress(
                iteration=iteration,
                max_iterations=max_fixes,
                current_ply=current_ply,
                total_plies=total_plies,
                status=status,
                message=message,
                elapsed=time.time() - start_time,
                fixes_applied=len(all_fixes)
            ))
    
    if verbose:
        print("=" * 60)
        print("GREEDY SEARCH")
        print("=" * 60)
    
    # Check if already valid
    initial_reach, _ = play_until_stuck(current_moves)
    if initial_reach >= total_plies:
        absurdities = find_all_absurdities(current_moves)
        if len(absurdities) <= 2:
            report_progress(0, "complete", "Game already valid!")
            return ReconstructionResult(
                status="VALID",
                path=current_moves,
                fixes=[],
                elapsed=time.time() - start_time,
                method="greedy"
            )
    
    # Iterative fixing
    for iteration in range(max_fixes):
        # Check for cancellation
        if cancel_flag.get("cancelled"):
            report_progress(iteration, "cancelled", "Search cancelled by user")
            return ReconstructionResult(
                status="CANCELLED",
                path=current_moves,
                fixes=all_fixes,
                elapsed=time.time() - start_time,
                method="greedy"
            )

        # Use EAD to detect persistent absurdity/bad trade (error location) vs just illegal
        if USE_EAD_IN_SEARCH:
            ead_ply, stop_reason, absurdity_info = play_until_absurd_or_stuck(
                current_moves, severity_threshold=3, persistence_threshold=2
            )
            if stop_reason in ("persistent_absurdity", "bad_trade"):
                stuck_at = ead_ply  # Focus on where the absurdity/bad trade started
                if verbose:
                    label = "Bad trade" if stop_reason == "bad_trade" else "Persistent absurdity"
                    print(f"   [!] EAD: {label} at ply {ead_ply}: {absurdity_info}")
            else:
                stuck_at = ead_ply  # Either illegal or complete
        else:
            stuck_at, _ = play_until_stuck(current_moves)
        
        # Check if we're done
        if stuck_at >= total_plies:
            absurdities = find_all_absurdities(current_moves)
            if len(absurdities) <= 2:
                elapsed = time.time() - start_time
                report_progress(iteration, "complete", 
                               f"Solved with {len(all_fixes)} fix(es)!")
                if verbose:
                    print(f"\n✅ SOLVED with {len(all_fixes)} fix(es) in {elapsed:.2f}s")
                return ReconstructionResult(
                    status="SOLVED",
                    path=current_moves,
                    fixes=all_fixes,
                    elapsed=elapsed,
                    method="greedy"
                )
        
        report_progress(iteration, "searching", 
                       f"Stuck at {ply_to_str(stuck_at)}, searching for fixes...",
                       stuck_at)
        
        if verbose:
            print(f"\n--- Iteration {iteration + 1}: stuck at {ply_to_str(stuck_at)} ---")
        
        # Find fixes
        fixes = find_deep_backtrack_fixes(
            current_moves, stuck_at, ocr_lookup,
            verbose=verbose, fixed_plies=fixed_plies
        )
        fixes = [f for f in fixes if f['ply'] not in fixed_plies]
        fixes = [f for f in fixes if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')]

        if not fixes:
            if verbose:
                print("   No fixes found!")
            report_progress(iteration, "complete", "No fixes found - giving up")
            break
        
        # Apply best fix
        best = fixes[0]
        current_moves[best['ply']] = best['san']
        all_fixes.append(best)
        fixed_plies.add(best['ply'])
        
        report_progress(iteration, "applying_fix",
                       f"Applied: {ply_to_str(best['ply'])} '{best['ocr']}' → '{best['san']}'")
        
        if verbose:
            print(f"   ✓ Applied: {ply_to_str(best['ply'])} '{best['ocr']}' → '{best['san']}'")
    
    # Final result
    elapsed = time.time() - start_time
    final_reach, _ = play_until_stuck(current_moves)
    
    if final_reach >= total_plies:
        return ReconstructionResult(
            status="SOLVED",
            path=current_moves,
            fixes=all_fixes,
            elapsed=elapsed,
            method="greedy"
        )
    
    if verbose:
        print(f"\n❌ FAILED: still stuck at {ply_to_str(final_reach)}")
    
    return ReconstructionResult(
        status="FAILED",
        path=current_moves,
        fixes=all_fixes,
        elapsed=elapsed,
        method="greedy"
    )


# =============================================================================
# BEAM SEARCH (Multi-path exploration)
# =============================================================================

@dataclass
class BeamPath:
    """A single hypothesis in beam search."""
    moves: List[str]
    fixes: List[dict]
    fixed_plies: Set[int]
    cumulative_cost: float = 0.0
    last_stuck_ply: int = -1

    def copy(self) -> 'BeamPath':
        return BeamPath(
            moves=self.moves.copy(),
            fixes=self.fixes.copy(),
            fixed_plies=self.fixed_plies.copy(),
            cumulative_cost=self.cumulative_cost,
            last_stuck_ply=self.last_stuck_ply
        )


def run_beam_search(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove] = None,
    beam_width: int = 5,
    max_iterations: int = 20,
    max_fixes_per_path: int = 10,
    verbose: bool = False,
    cancel_flag: Dict = None,
    on_progress: Callable[[SearchProgress], None] = None
) -> ReconstructionResult:
    """
    Beam search reconstruction: explore multiple paths in parallel.
    
    Algorithm:
    1. Maintain N best paths (beam)
    2. For each path: find fixes, branch into new paths
    3. Prune to keep only top N paths
    4. Repeat until a path completes or we give up
    
    This handles complex cases where greedy fails, but is slower.
    
    Args:
        moves: List of SAN move strings
        ocr_lookup: Optional OCR data for similarity scoring
        beam_width: Number of parallel paths to maintain
        max_iterations: Maximum search iterations
        max_fixes_per_path: Maximum fixes per individual path
        verbose: Print debug output
        cancel_flag: Dict with "cancelled" key - set to True to interrupt
        on_progress: Callback for progress updates
        
    Returns:
        ReconstructionResult with status, fixed moves, and metadata
    """
    cancel_flag = cancel_flag or {"cancelled": False}
    start_time = time.time()
    
    # Build OCR lookup if not provided
    if ocr_lookup is None:
        ocr_lookup = create_ocr_lookup(moves_to_ocr_moves(moves))
    
    total_plies = len(moves)
    
    def report_progress(iteration: int, status: str, message: str, current_ply: int = 0):
        if on_progress:
            on_progress(SearchProgress(
                iteration=iteration,
                max_iterations=max_iterations,
                current_ply=current_ply,
                total_plies=total_plies,
                status=status,
                message=message,
                elapsed=time.time() - start_time,
                fixes_applied=0
            ))
    
    if verbose:
        print("=" * 60)
        print(f"BEAM SEARCH (width={beam_width})")
        print("=" * 60)
    
    # Initialize beam with single path
    initial_path = BeamPath(
        moves=moves.copy(),
        fixes=[],
        fixed_plies=set(),
        cumulative_cost=0.0,
        last_stuck_ply=-1
    )
    beam = [initial_path]
    prev_best_reach = -1
    prev_best_cost = -1.0
    stall_count = 0
    
    # Check if already valid
    initial_reach, _ = play_until_stuck(moves)
    if initial_reach >= total_plies:
        absurdities = find_all_absurdities(moves)
        if len(absurdities) <= 2:
            report_progress(0, "complete", "Game already valid!")
            return ReconstructionResult(
                status="VALID",
                path=moves,
                fixes=[],
                elapsed=time.time() - start_time,
                method="beam"
            )
    
    # Main search loop
    for iteration in range(max_iterations):
        # Check for cancellation
        if cancel_flag.get("cancelled"):
            report_progress(iteration, "cancelled", "Search cancelled by user")
            best_path = max(beam, key=lambda p: _score_path(p, total_plies))
            return ReconstructionResult(
                status="CANCELLED",
                path=best_path.moves,
                fixes=best_path.fixes,
                elapsed=time.time() - start_time,
                method="beam"
            )
        
        report_progress(iteration, "searching",
                       f"Iteration {iteration + 1}: exploring {len(beam)} paths...")
        
        if verbose:
            print(f"\n--- Iteration {iteration + 1}: {len(beam)} paths in beam ---")
        
        # Check for complete paths
        for path in beam:
            reach, _ = play_until_stuck(path.moves)
            if reach >= total_plies:
                absurdities = find_all_absurdities(path.moves)
                if len(absurdities) <= 2:
                    elapsed = time.time() - start_time
                    report_progress(iteration, "complete",
                                   f"Solved with {len(path.fixes)} fix(es)!")
                    if verbose:
                        print(f"\n✅ SOLVED with {len(path.fixes)} fix(es) in {elapsed:.2f}s")
                    return ReconstructionResult(
                        status="SOLVED",
                        path=path.moves,
                        fixes=path.fixes,
                        elapsed=elapsed,
                        method="beam"
                    )
        
        # Expand paths
        new_beam = []
        any_expanded = False

        for path_idx, path in enumerate(beam):
            if len(path.fixes) >= max_fixes_per_path:
                new_beam.append(path)  # Keep but don't expand
                continue

            # Use EAD to detect persistent absurdity (error location) vs just illegal
            if USE_EAD_IN_SEARCH:
                ead_ply, stop_reason, _ = play_until_absurd_or_stuck(
                    path.moves, severity_threshold=3, persistence_threshold=2
                )
                reach = ead_ply  # Use EAD result as stuck point
            else:
                reach, _ = play_until_stuck(path.moves)

            if reach >= total_plies:
                new_beam.append(path)  # Complete, keep as-is
                continue

            # Skip dead-end paths (stuck at same place as last iteration)
            if reach == path.last_stuck_ply and reach < total_plies:
                new_beam.append(path)
                continue

            # Find fixes for this path
            # Note: find_deep_backtrack_fixes also has internal EAD, which may refine further
            fixes = find_deep_backtrack_fixes(
                path.moves, reach, ocr_lookup,
                verbose=False, fixed_plies=path.fixed_plies
            )

            fixes = [f for f in fixes if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')]

            if not fixes:
                path.last_stuck_ply = reach
                new_beam.append(path)  # No fixes, keep as-is
                continue

            # This path actually produced new branches
            any_expanded = True

            # Branch with REGRET-BASED SCORING
            LAMBDA = 21  # per-stuck-point base penalty
            num_branches = min(beam_width, len(fixes), 3)
            best_score = fixes[0].get('unified_score', 0)

            for fix in fixes[:num_branches]:
                new_path = path.copy()
                new_path.moves[fix['ply']] = fix['san']
                new_path.fixes.append(fix)
                new_path.fixed_plies.add(fix['ply'])

                # Regret = how much worse than the best fix at this stuck point
                this_score = fix.get('unified_score', 0)
                regret = max(0, best_score - this_score)
                new_path.cumulative_cost += LAMBDA + regret
                new_path.last_stuck_ply = reach

                new_beam.append(new_path)

        if not new_beam:
            break

        # All paths are dead-ends (none expanded) — stop immediately
        if not any_expanded:
            if verbose:
                print(f"   All paths exhausted — no path could be expanded")
            beam = new_beam[:beam_width]
            break

        # Score and prune beam
        scored = [(p, _score_path(p, total_plies)) for p in new_beam]
        scored.sort(key=lambda x: x[1], reverse=True)
        beam = [p for p, _ in scored[:beam_width]]

        # Stall detection: best path unchanged for 5 iterations → give up
        best_path_now = beam[0]
        best_reach_now, _ = play_until_stuck(best_path_now.moves)
        best_cost_now = best_path_now.cumulative_cost
        if best_reach_now == prev_best_reach and best_cost_now == prev_best_cost:
            stall_count += 1
            if stall_count >= 5:
                if verbose:
                    print(f"   Stalled for 5 iterations at {ply_to_str(best_reach_now)} — giving up")
                break
        else:
            stall_count = 0
        prev_best_reach = best_reach_now
        prev_best_cost = best_cost_now

        if verbose:
            print(f"   Pruned to {len(beam)} paths")
    
    # Return best partial result
    elapsed = time.time() - start_time
    
    if beam:
        best_path = max(beam, key=lambda p: _score_path(p, total_plies))
        reach, _ = play_until_stuck(best_path.moves)
        
        if reach >= total_plies:
            return ReconstructionResult(
                status="SOLVED",
                path=best_path.moves,
                fixes=best_path.fixes,
                elapsed=elapsed,
                method="beam"
            )
        
        report_progress(max_iterations, "complete",
                       f"Partial result: reached {ply_to_str(reach)}")
        
        return ReconstructionResult(
            status="PARTIAL",
            path=best_path.moves,
            fixes=best_path.fixes,
            elapsed=elapsed,
            method="beam"
        )
    
    return ReconstructionResult(
        status="FAILED",
        path=moves,
        fixes=[],
        elapsed=elapsed,
        method="beam"
    )


def _score_path(path: BeamPath, total_plies: int) -> tuple:
    """Score a beam path for ranking. Higher is better."""
    reach, _ = play_until_stuck(path.moves)
    completes = 1 if reach >= total_plies else 0
    reach_ratio = reach / total_plies if total_plies > 0 else 0
    num_fixes = len(path.fixes)

    return (completes, reach_ratio, -path.cumulative_cost, -num_fixes)


# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

# =============================================================================
# BACKWARDS-COMPATIBLE WRAPPERS (for beam_search.py migration)
# =============================================================================

def reconstruct_game_beam(
    ocr_moves: List[OCRMove],
    beam_width: int = 10,
    max_fixes_per_path: int = 10,
    verbose: bool = True,
    progress_callback: Callable = None,
    collect_iterations: bool = False
) -> ReconstructionResult:
    """
    Beam search reconstruction - wrapper for OCRMove input.

    This maintains compatibility with the old beam_search.py interface.

    Parameters:
    - ocr_moves: List of OCRMove objects from OCR
    - beam_width: Number of parallel hypotheses to maintain
    - max_fixes_per_path: Maximum fixes per path before giving up
    - verbose: Print progress
    - progress_callback: Callback for progress updates
    - collect_iterations: If True, collect iteration details for debug output

    Returns ReconstructionResult with best path found.
    """
    moves = ocr_moves_to_list(ocr_moves)
    ocr_lookup = create_ocr_lookup(ocr_moves)

    # Create a wrapper for progress callback
    def on_progress(progress: SearchProgress):
        if progress_callback:
            progress_callback(progress.iteration, progress.max_iterations, 0)

    result = run_beam_search(
        moves=moves,
        ocr_lookup=ocr_lookup,
        beam_width=beam_width,
        max_iterations=max_fixes_per_path * 3,
        max_fixes_per_path=max_fixes_per_path,
        verbose=verbose,
        on_progress=on_progress if progress_callback else None
    )

    # Add iterations attribute if requested (for API compatibility)
    if collect_iterations:
        result.iterations = []  # Simplified - could track in run_beam_search

    return result


def reconstruct_with_deep_backtrack(
    moves: List[str],
    verbose: bool = True,
    max_fixes: int = 10
) -> ReconstructionResult:
    """
    Greedy reconstruction using deep backtrack.

    This is a wrapper around run_greedy_search for backward compatibility
    with the old beam_search.py interface.

    Parameters:
    - moves: List of SAN move strings
    - verbose: Print progress
    - max_fixes: Maximum fixes to apply

    Returns ReconstructionResult.
    """
    return run_greedy_search(
        moves=moves,
        max_fixes=max_fixes,
        verbose=verbose
    )


def reconstruct_game(
    ocr_moves: List[OCRMove],
    method: str = "greedy",
    verbose: bool = True,
    progress_callback: Callable = None,
    **kwargs
) -> ReconstructionResult:
    """
    Main reconstruction entry point - wrapper for OCRMove input.

    This maintains compatibility with the old beam_search.py interface.

    Parameters:
    - ocr_moves: List of OCRMove objects
    - method: "greedy" or "beam"
    - verbose: Print progress
    - **kwargs: Additional arguments passed to specific method

    Returns ReconstructionResult.
    """
    if method == "beam":
        return reconstruct_game_beam(
            ocr_moves,
            verbose=verbose,
            progress_callback=progress_callback,
            **kwargs
        )
    else:
        moves = ocr_moves_to_list(ocr_moves)
        return reconstruct_with_deep_backtrack(moves, verbose=verbose, **kwargs)


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def search_with_timeout(
    moves: List[str],
    method: str = "greedy",
    timeout: float = 30.0,
    **kwargs
) -> ReconstructionResult:
    """
    Run search with automatic timeout.
    
    Note: This uses a simple polling approach. For true async cancellation,
    use threading with cancel_flag.
    """
    import threading
    
    cancel_flag = {"cancelled": False}
    result_holder = {"result": None}
    
    def run_search():
        if method == "beam":
            result_holder["result"] = run_beam_search(
                moves, cancel_flag=cancel_flag, **kwargs
            )
        else:
            result_holder["result"] = run_greedy_search(
                moves, cancel_flag=cancel_flag, **kwargs
            )
    
    thread = threading.Thread(target=run_search)
    thread.start()
    thread.join(timeout=timeout)
    
    if thread.is_alive():
        cancel_flag["cancelled"] = True
        thread.join(timeout=2.0)  # Give it a moment to clean up
        
        if result_holder["result"] is None:
            return ReconstructionResult(
                status="TIMEOUT",
                path=moves,
                fixes=[],
                elapsed=timeout,
                method=method
            )
    
    return result_holder["result"]


# =============================================================================
# BACKGROUND WORKER RECONSTRUCTION (thin wrappers for search-worker.js)
# =============================================================================
# These are thin wrappers around the existing run_greedy_search / run_beam_search.
# They accept raw OCR data (list of tuples) and user_fixes, convert to the proper
# OCRMove format, apply user fixes, then delegate to the existing working functions.
# =============================================================================

def reconstruct_greedy_background(
    moves_list, ocr_lookup_raw,
    locked_plies=None, user_fixes=None,
    max_fixes=15
):
    """
    Background greedy search wrapper.

    Args:
        moves_list: List[str] of SAN moves (top OCR candidates)
        ocr_lookup_raw: Dict[int, List[Tuple[str, float]]] - raw OCR candidates per ply
        locked_plies: Set of plies the user has fixed (never modify)
        user_fixes: Dict[int, str] of live user fixes
        max_fixes: Max fix iterations
    """
    if user_fixes is None:
        user_fixes = {}

    # Apply user fixes to the move list before searching
    moves = list(moves_list)
    for ply, san in user_fixes.items():
        if ply < len(moves):
            moves[ply] = san

    # Convert raw OCR lookup to proper OCRMove format
    ocr_lookup = _raw_to_ocr_lookup(ocr_lookup_raw, moves)

    # Delegate to the existing working greedy search
    result = run_greedy_search(
        moves, ocr_lookup=ocr_lookup, max_fixes=max_fixes, verbose=False
    )

    # Convert ReconstructionResult to dict for JSON serialization
    return _result_to_dict(result)


def reconstruct_beam_background(
    moves_list, ocr_lookup_raw,
    locked_plies=None, user_fixes=None,
    beam_width=5, max_fixes=3
):
    """
    Background beam search wrapper.

    Args:
        moves_list: List[str] of SAN moves (top OCR candidates)
        ocr_lookup_raw: Dict[int, List[Tuple[str, float]]] - raw OCR candidates per ply
        locked_plies: Set of plies the user has fixed (never modify)
        user_fixes: Dict[int, str] of live user fixes
        beam_width: Number of parallel paths
        max_fixes: Max fixes per path
    """
    if user_fixes is None:
        user_fixes = {}

    # Apply user fixes to the move list before searching
    moves = list(moves_list)
    for ply, san in user_fixes.items():
        if ply < len(moves):
            moves[ply] = san

    # Convert raw OCR lookup to proper OCRMove format
    ocr_lookup = _raw_to_ocr_lookup(ocr_lookup_raw, moves)

    # Delegate to the existing working beam search
    result = run_beam_search(
        moves, ocr_lookup=ocr_lookup, beam_width=beam_width,
        max_fixes_per_path=max_fixes, verbose=False
    )

    # Convert ReconstructionResult to dict for JSON serialization
    return _result_to_dict(result)


def _raw_to_ocr_lookup(ocr_lookup_raw, moves):
    """Convert raw ply->[(san, conf)] dict to Dict[int, OCRMove]."""
    ocr_lookup = {}
    for ply, candidates in ocr_lookup_raw.items():
        ply = int(ply)  # JSON keys may be strings
        if not candidates:
            continue
        move_number = ply // 2 + 1
        color = 'w' if ply % 2 == 0 else 'b'
        # OCRMove expects candidates as List[Tuple[str, float]]
        ocr_lookup[ply] = OCRMove(
            move_number=move_number,
            color=color,
            candidates=[(c[0], c[1]) for c in candidates]
        )
    return ocr_lookup


def _result_to_dict(result):
    """Convert ReconstructionResult to a plain dict for JSON serialization."""
    fixes_applied = []
    for f in (result.fixes or []):
        fix_ply = f.get('ply', 0)
        fixes_applied.append({
            'ply': fix_ply,
            'ply_str': f.get('ply_str', '') or ply_to_str(fix_ply),
            'original': f.get('ocr', ''),
            'replacement': f.get('san', ''),
            'score': f.get('similarity', 0),
            'type': 'fix'
        })

    final_reach, _ = play_until_stuck(result.path)
    completed = result.status in ('SOLVED', 'VALID')

    return {
        'moves': result.path,
        'pgn': '',  # Not needed for background results
        'fixes_applied': fixes_applied,
        'stuck_points': len(fixes_applied),
        'completed': completed,
        'final_ply': final_reach if final_reach else len(result.path),
        'total_plies': len(result.path),
        'status': result.status,
        'elapsed': result.elapsed,
        'errors_remaining': 0 if completed else 1
    }
