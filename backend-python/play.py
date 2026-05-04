"""
Score2PGN - Play Module with Early Absurdity Detection
======================================================
FINALLY IMPLEMENTED after being designed on January 4, 2026!

This module provides enhanced move execution that stops forward play
when a PERSISTENT absurdity is detected (not just when illegal).

Key insight: Real blunders get punished within 1-2 moves.
If a piece hangs for 2+ moves with no reaction from EITHER player,
that's almost certainly OCR corruption, not real chess.

SINGLE SOURCE OF TRUTH (January 2026):
The function `check_piece_hanging()` is the canonical implementation
for detecting when a move leaves a piece (B/N/R/Q) hanging. Both this module
and api.py's validate_moves should use this function to avoid inconsistencies.

Usage:
    from play import play_until_absurd_or_stuck

    ply, reason, absurdity = play_until_absurd_or_stuck(moves)
    if reason == "persistent_absurdity":
        print(f"Stopped early at ply {ply}: {absurdity}")
        # Search only plies 0 to ply, not 0 to wherever it eventually gets stuck!
"""

import chess
from typing import List, Tuple, Optional, Dict, Set
from dataclasses import dataclass

# Import from existing modules
from helpers import try_move, piece_value
from absurdity import (
    detect_absurdity_at_ply,
    would_capture_be_bad,
    is_piece_adequately_defended,
    find_all_absurdities,
    is_bad_trade_move,  # Instant bad trade detection
    is_piece_genuinely_hanging,  # SINGLE SOURCE OF TRUTH for hanging detection
    is_classically_hanging_free,  # EAD-only stricter check, no cross-board offset
    side_has_independent_free_capture,  # gate: distinguish mutual-hang from overloaded trade
)


# =============================================================================
# SINGLE SOURCE OF TRUTH: Piece Hanging Detection
# =============================================================================

def check_piece_hanging(
    board: chess.Board,
    move_just_played: chess.Move,
    debug: bool = False
) -> Optional[Tuple[str, int, str]]:
    """
    Check if a move leaves a piece (Bishop/Knight/Rook/Queen) hanging.

    Uses is_piece_genuinely_hanging() from absurdity.py as SINGLE SOURCE OF TRUTH.

    Rationale: If a player leaves ANY piece hanging with no tactical
    compensation, it's almost certainly an OCR error. If it IS a real
    blunder, the user can click "Keep it" to approve the move.

    Args:
        board: Board state AFTER the move has been played
        move_just_played: The move that was just made
        debug: Print debug information

    Returns:
        None if no piece is hanging, otherwise:
        (square_name, piece_value, explanation)

    Example:
        board.push(move)
        result = check_piece_hanging(board, move)
        if result:
            sq, val, explanation = result
            print(f"STOP: {explanation}")
    """
    # If it's checkmate, the game is over - no pieces can be captured!
    if board.is_checkmate():
        return None

    side_that_moved = not board.turn  # Side that just moved

    # If the move was a capture, determine what was captured.
    # Pieces hanging elsewhere worth <= captured value are not absurd
    # (capturing a higher-value piece is a rational priority over saving them).
    captured_value = 0
    board_before = board.copy()
    board_before.pop()  # Go back to before the move
    if board_before.is_capture(move_just_played):
        cap_piece = board_before.piece_at(move_just_played.to_square)
        if cap_piece:
            captured_value = piece_value(cap_piece)

    for sq in chess.SQUARES:
        piece = board.piece_at(sq)
        if piece is None or piece.color != side_that_moved:
            continue

        value = piece_value(piece)
        if value < 3:  # Flag minor pieces (3), Rooks (5), and Queens (9)
            continue

        # For capture moves, bad_trade detection handles the moved piece.
        # For non-capture moves landing on a hanging square (e.g. Bh6), check it here.
        if sq == move_just_played.to_square and captured_value > 0:
            continue

        # Skip pieces worth <= what we just captured (capture priority is rational)
        if captured_value > 0 and value <= captured_value:
            continue

        # Use SINGLE SOURCE OF TRUTH from absurdity.py
        # Note: Check-response filtering is handled by is_piece_genuinely_hanging itself
        # Note: fast_mode=False because EAD wants accuracy over speed
        is_hanging, net_gain, reason = is_piece_genuinely_hanging(
            board, sq, piece,
            move_just_played=move_just_played,
            fast_mode=False,
            debug=debug
        )

        if is_hanging:
            sq_name = chess.square_name(sq)
            piece_name_str = {3: "minor piece", 5: "Rook", 9: "Queen"}.get(value, f"piece({value})")
            explanation = f"Move leaves {piece_name_str} on {sq_name} hanging"
            return (sq_name, value, explanation)

        # EAD-only fallback: fire classical-hang ONLY when quiescence
        # deemed the hang "not bad enough" due to cross-board compensation
        # (the "minor gain only" branch — net_gain < 2 after offsetting
        # captures elsewhere). This branch has two sub-cases:
        #   - independent mutual-hang: both sides already have a classical
        #     free capture that happen to net out → two absurdities, flag.
        #   - overloaded-defender trade: the compensation only exists
        #     *because* the opponent's capture removes a defender (e.g. a
        #     pawn attacks our bishop AND defends a knight we can take —
        #     capturing the bishop uncovers the knight) → valid exchange,
        #     don't flag.
        # side_has_independent_free_capture distinguishes them by checking
        # whether side_that_moved already has a pre-existing classical free
        # capture in the *current* position, before any hypothetical trade.
        if (reason.startswith("minor gain only")
                and is_classically_hanging_free(board, sq, piece)
                and side_has_independent_free_capture(board, side_that_moved)):
            sq_name = chess.square_name(sq)
            piece_name_str = {3: "minor piece", 5: "Rook", 9: "Queen"}.get(value, f"piece({value})")
            explanation = f"Move leaves {piece_name_str} on {sq_name} hanging (classical)"
            return (sq_name, value, explanation)

    return None


# Backwards compatibility alias
check_major_piece_hanging = check_piece_hanging


@dataclass
class PersistentAbsurdity:
    """Tracks an absurdity that persists across multiple moves without reaction."""
    start_ply: int
    absurdity_type: str
    piece_symbol: str
    square: str
    severity: int
    persistence: int  # How many half-moves it's been ignored
    
    def __str__(self):
        return (f"{self.piece_symbol} hanging on {self.square} "
                f"for {self.persistence} moves (severity {self.severity})")


def play_until_absurd_or_stuck(
    moves: List[str],
    severity_threshold: int = 3,      # Bishop/Knight or higher
    persistence_threshold: int = 2,   # Stop if ignored for 2+ moves
    auto_correct: bool = False,
    verbose: bool = False,
    approved_plies: Optional[Set[int]] = None,  # User-confirmed: skip EAD
) -> Tuple[int, str, Optional[PersistentAbsurdity]]:
    """
    Play through moves, stopping at:
    - First ILLEGAL move, OR
    - PERSISTENT absurdity (piece hanging for multiple moves without reaction)
    
    The key insight: Real blunders get punished or saved within 1-2 moves.
    If a piece hangs for persistence_threshold+ moves with no reaction from
    EITHER player, that's almost certainly OCR corruption, not real chess.
    
    Parameters
    ----------
    moves : List[str]
        The move list to play through
    severity_threshold : int
        Minimum piece value to track (3 = Bishop/Knight, 5 = Rook, 9 = Queen)
        Default is 3 - even bishops shouldn't hang for multiple moves ignored
    persistence_threshold : int  
        How many moves an absurdity can persist before we stop
        (2 means: hang on move N, ignored on N+1, STOP at N+2)
    auto_correct : bool
        Whether to use auto-correction in try_move (passed through)
    verbose : bool
        Print debug information
    approved_plies : Optional[Set[int]]
        Plies the user has confirmed (or that came from a tier-1 merge
        agreement). Skip all EAD checks on these — bad-trade,
        moved-piece-hanging, persistent-absurdity tracking. The move is
        still played (illegality is still detected), but its quality is
        not second-guessed. Mirrors validation.py::check_ead_after_move's
        early return on `ply in approved_plies`. Without this, Greedy/Beam/
        Dijkstra stop at user-confirmed plies the user has explicitly told
        them to accept, while interactive validate happily plays through.
        
    Returns
    -------
    Tuple of (ply, reason, absurdity_info)
    - ply: Where we stopped
    - reason: "illegal", "persistent_absurdity", or "complete"
    - absurdity_info: PersistentAbsurdity if reason=="persistent_absurdity", else None
    
    Examples
    --------
    # Normal usage
    ply, reason, absurdity = play_until_absurd_or_stuck(moves)
    
    if reason == "illegal":
        print(f"Illegal move at ply {ply}")
    elif reason == "persistent_absurdity":
        print(f"OCR corruption detected: {absurdity}")
        print(f"Search should focus on plies 0 to {ply}")
    else:
        print("Game completed successfully")
    """
    board = chess.Board()
    approved_plies = approved_plies or set()

    # Track active absurdities by square: {square_name: PersistentAbsurdity}
    active_absurdities: Dict[str, PersistentAbsurdity] = {}

    for ply, san in enumerate(moves):
        # Try to make the move
        move = try_move(board, san, auto_correct=auto_correct)
        if not move:
            if verbose:
                print(f"  [X] Illegal at ply {ply}: '{san}'")
            return ply, "illegal", None

        # User-confirmed (or tier-1 merge-locked) move — skip every EAD check
        # and just play it. This mirrors validation.py::check_ead_after_move's
        # `if ply in approved_plies: return False, None, None`. Without this,
        # Greedy/Beam/Dijkstra stop at user-confirmed plies that the user has
        # explicitly told them to accept, while interactive validate plays
        # right through. Any active hanging-piece tracking from earlier plies
        # gets dropped by the resolver below at the next non-approved ply
        # (an approved move counts as "the position has moved on").
        if ply in approved_plies:
            board.push(move)
            active_absurdities = {}
            continue

        # NEW: Check for bad trade BEFORE playing the move
        # This catches blunders like Qxd4 where Queen can be recaptured,
        # Rf6 (rook walks into exchange sac vs bishop) and Bxc5 (bishop for pawn).
        # Threshold is `loss >= 2` (decoupled from severity_threshold, which
        # filters by piece value for persistent-hanging tracking).
        # Skip if move is forced (only legal move in check) — no choice available.
        is_forced_move = board.is_check() and len(list(board.legal_moves)) == 1
        is_bad, loss, explanation = is_bad_trade_move(board, move)
        if is_bad and loss >= 2 and not is_forced_move:
            trade_square = move.to_square
            moving_piece = board.piece_at(move.from_square)
            piece_sym = moving_piece.symbol() if moving_piece else '?'
            bad_trade_abs = PersistentAbsurdity(
                start_ply=ply,
                absurdity_type='bad_trade',
                piece_symbol=piece_sym,
                square=chess.square_name(trade_square),
                severity=loss,
                persistence=0  # Immediate detection
            )
            if verbose:
                print(f"  [!] BAD TRADE at ply {ply}: {explanation}")
            return ply, "bad_trade", bad_trade_abs

        # Check if side is in check BEFORE making the move
        was_in_check_before_move = board.is_check()

        board.push(move)

        # IMMEDIATE detection for pieces (B/N/R/Q) left hanging
        # Uses the single source of truth: check_piece_hanging()
        # BUT: if we were in check, we were forced to respond — pieces hanging
        # elsewhere that couldn't help with the check are not absurd.
        hanging_result = None
        if was_in_check_before_move:
            # We were in check. Check if king move was the only option.
            board.pop()
            legal_responses = list(board.legal_moves)
            king_sq = board.king(board.turn)
            only_king_moves = all(lm.from_square == king_sq for lm in legal_responses)
            board.push(move)

            if not only_king_moves:
                # There were alternatives (block/capture). Only flag hanging
                # pieces that COULD have been involved in the check defense.
                hanging_result = check_piece_hanging(board, move, debug=verbose)
                # Further filter: the hanging piece must have been able to
                # participate in the check response. If it's a "collateral"
                # piece, it's not absurd. We handle this below.
            # else: only king moves → skip hanging check entirely
        else:
            hanging_result = check_piece_hanging(board, move, debug=verbose)

        if hanging_result:
            sq_name, piece_val, explanation = hanging_result
            hanging_square = chess.parse_square(sq_name)

            # If opponent gives CHECK on the very next move, that's a strong
            # tactical choice — not evidence of OCR error.
            # We no longer exempt the case where opponent captures the hanging piece:
            # losing a piece for nothing is absurd even if the opponent takes it.
            opponent_gives_check = False
            if ply + 1 < len(moves):
                next_move = try_move(board, moves[ply + 1], auto_correct=auto_correct)
                if next_move:
                    board.push(next_move)
                    opponent_gives_check = board.is_check()
                    board.pop()

            if opponent_gives_check:
                if verbose:
                    print(f"  [EAD] Piece hanging on {sq_name} but opponent "
                          f"gives check instead — tactical choice, not absurd")
                # Don't return — opponent chose check over capture, that's fine
            else:
                piece_at_sq = board.piece_at(hanging_square)
                hanging_abs = PersistentAbsurdity(
                    start_ply=ply,
                    absurdity_type='piece_hanging',
                    piece_symbol=piece_at_sq.symbol() if piece_at_sq else '?',
                    square=sq_name,
                    severity=piece_val,
                    persistence=0  # Immediate detection
                )
                if verbose:
                    print(f"  [!] PIECE HANGING at ply {ply}: {explanation}")
                return ply, "piece_hanging", hanging_abs

        # Detect absurdities at this position using existing detection
        current_hanging = _detect_hanging_pieces(board, ply, moves, move_just_played=move)
        
        # Update tracking: which absurdities are still active?
        new_active: Dict[str, PersistentAbsurdity] = {}
        
        for hang_info in current_hanging:
            if hang_info['severity'] < severity_threshold:
                continue  # Below threshold, ignore
            
            square = hang_info['square']
            
            if square in active_absurdities:
                # Existing absurdity - increment persistence
                existing = active_absurdities[square]
                existing.persistence += 1
                
                if verbose:
                    print(f"  [WARN] Ply {ply}: {existing.piece_symbol} still hanging on {square} "
                          f"(persistence={existing.persistence})")

                if existing.persistence >= persistence_threshold:
                    # PERSISTENT ABSURDITY DETECTED!
                    if verbose:
                        print(f"  [STOP] PERSISTENT ABSURDITY at ply {existing.start_ply}: {existing}")
                        print(f"     Neither player reacted for {existing.persistence} moves!")
                    return existing.start_ply, "persistent_absurdity", existing
                
                new_active[square] = existing
            else:
                # New absurdity - start tracking
                new_abs = PersistentAbsurdity(
                    start_ply=ply,
                    absurdity_type=hang_info['type'],
                    piece_symbol=hang_info['piece'],
                    square=square,
                    severity=hang_info['severity'],
                    persistence=0
                )
                new_active[square] = new_abs
                
                if verbose:
                    print(f"  [WARN] New absurdity at ply {ply}: {hang_info['piece']} "
                          f"hanging on {square} (severity {hang_info['severity']})")
        
        # Absurdities no longer in new_active were resolved (captured or moved)
        resolved = set(active_absurdities.keys()) - set(new_active.keys())
        if verbose and resolved:
            for sq in resolved:
                print(f"  [OK] Ply {ply}: Absurdity resolved - "
                      f"{active_absurdities[sq].piece_symbol} on {sq}")
        
        active_absurdities = new_active
    
    # Made it through all moves!
    return len(moves), "complete", None


def _detect_hanging_pieces(
    board: chess.Board,
    ply: int,
    moves: List[str],
    move_just_played: Optional[chess.Move] = None
) -> List[dict]:
    """
    Detect hanging pieces in the current position.

    Returns list of dicts with: type, piece, square, severity

    Uses is_piece_genuinely_hanging() from absurdity.py as SINGLE SOURCE OF TRUTH.
    """
    hanging = []
    side_just_moved = not board.turn  # The side that just made a move

    # Check all pieces of the side that just moved
    for square in chess.SQUARES:
        piece = board.piece_at(square)
        if piece is None or piece.color != side_just_moved:
            continue

        value = piece_value(piece)
        if value < 3:  # Skip pawns
            continue

        # Use SINGLE SOURCE OF TRUTH from absurdity.py
        # fast_mode=False for accuracy in EAD
        is_hanging, net_gain, reason = is_piece_genuinely_hanging(
            board, square, piece,
            move_just_played=move_just_played,
            fast_mode=False,
            debug=False
        )

        if is_hanging:
            hanging.append({
                'type': 'hanging_piece',
                'piece': piece.symbol(),
                'square': chess.square_name(square),
                'severity': value
            })
    
    # Also check: is there a free capture available that's being ignored?
    # (This detects the other side of the absurdity - opponent not taking)
    # Note: `board` is the position AFTER side_just_moved played. It is now
    # the opponent's turn, so board.legal_moves enumerates opponent options.
    opponent = board.turn
    target_side = side_just_moved
    if ply + 1 < len(moves):
        next_san = moves[ply + 1]
        for move in board.legal_moves:
            if not board.is_capture(move):
                continue

            captured = board.piece_at(move.to_square)
            if not captured:
                continue

            cap_value = piece_value(captured)
            if cap_value < 3:
                continue

            # Is this capture being ignored?
            try:
                next_move = board.parse_san(next_san)
                if next_move.to_square != move.to_square:
                    # Opponent is not taking the hanging piece of side_just_moved.
                    # Check the captured piece has no own-side defender.
                    if not board.is_attacked_by(target_side, move.to_square):
                        hanging.append({
                            'type': 'free_capture_ignored',
                            'piece': captured.symbol(),
                            'square': chess.square_name(move.to_square),
                            'severity': cap_value
                        })
                        break  # Only report once
            except:
                pass  # Next move might be illegal, handled separately
    
    return hanging


# =============================================================================
# CONVENIENCE WRAPPERS
# =============================================================================

def get_early_stop_ply(
    moves: List[str],
    severity_threshold: int = 3,
    persistence_threshold: int = 2
) -> Tuple[int, str]:
    """
    Simple wrapper that returns just the stop ply and reason.
    
    Useful for quick checks without needing the full absurdity details.
    """
    ply, reason, _ = play_until_absurd_or_stuck(
        moves, 
        severity_threshold=severity_threshold,
        persistence_threshold=persistence_threshold
    )
    return ply, reason


def should_stop_early(
    moves: List[str],
    current_ply: int,
    severity_threshold: int = 3,
    persistence_threshold: int = 2
) -> bool:
    """
    Check if we should stop at the current ply due to persistent absurdity.
    
    Useful for inline checks during reconstruction.
    """
    ply, reason, _ = play_until_absurd_or_stuck(
        moves[:current_ply + 1],
        severity_threshold=severity_threshold,
        persistence_threshold=persistence_threshold
    )
    return reason == "persistent_absurdity"


# =============================================================================
# INTEGRATION HELPERS
# =============================================================================

def get_search_range(
    moves: List[str],
    use_early_stopping: bool = True,
    severity_threshold: int = 3,
    persistence_threshold: int = 2
) -> Tuple[int, int, str]:
    """
    Determine the optimal search range for fix finding.
    
    Returns (min_ply, max_ply, reason) where:
    - min_ply: Start of search range (usually 0)
    - max_ply: End of search range (where we stopped)
    - reason: Why we stopped ("illegal", "persistent_absurdity", "complete")
    
    This replaces the pattern:
        stuck_at, _ = play_until_stuck(moves)
        # search 0 to stuck_at
    
    With:
        min_ply, max_ply, reason = get_search_range(moves)
        # search min_ply to max_ply (potentially much smaller!)
    """
    if use_early_stopping:
        stop_ply, reason, absurdity = play_until_absurd_or_stuck(
            moves,
            severity_threshold=severity_threshold,
            persistence_threshold=persistence_threshold
        )
        
        if reason == "persistent_absurdity" and absurdity:
            # The error is likely near where the absurdity started
            # Search from a bit before that point
            min_ply = max(0, absurdity.start_ply - 2)
            return min_ply, stop_ply, reason
        else:
            return 0, stop_ply, reason
    else:
        # Fall back to original behavior
        from helpers import play_until_stuck
        stop_ply, _ = play_until_stuck(moves)
        return 0, stop_ply, "illegal" if stop_ply < len(moves) else "complete"


# =============================================================================
# TESTING
# =============================================================================

if __name__ == "__main__":
    print("=" * 60)
    print("Testing play_until_absurd_or_stuck()")
    print("=" * 60)
    
    # Test 1: A normal game should complete
    normal_moves = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]
    ply, reason, abs_info = play_until_absurd_or_stuck(normal_moves, verbose=True)
    print(f"\nTest 1 (normal): ply={ply}, reason={reason}")
    assert reason == "complete", f"Expected 'complete', got '{reason}'"
    
    # Test 2: Illegal move should stop
    illegal_moves = ["e4", "Ke7"]  # Ke7 is illegal - king blocked by pawn on e7
    ply, reason, abs_info = play_until_absurd_or_stuck(illegal_moves, verbose=True)
    print(f"\nTest 2 (illegal): ply={ply}, reason={reason}")
    assert reason == "illegal", f"Expected 'illegal', got '{reason}'"

    print("\n[OK] Basic tests passed!")
    print("\nNote: Full integration testing requires the actual game data.")
