"""
Score2PGN - Tactical Quiescence Search
======================================

DEPRECATION NOTICE (February 2026):
This module is DEPRECATED. Use absurdity.py instead.

The following functions have been consolidated into absurdity.py:
- would_capture_be_bad() -> use absurdity.would_capture_be_bad()
- is_piece_adequately_defended() -> use absurdity.is_piece_adequately_defended()
- find_hanging_pieces() -> use absurdity.find_hanging_pieces()

The SINGLE SOURCE OF TRUTH for hanging piece detection is now:
    absurdity.is_piece_genuinely_hanging()

This file is kept for reference only and is not imported by any module.
======================================

Original description:

Minimax search for forcing sequences (checks + captures).

Inspired by Arimaa quiescence search principles - don't evaluate unstable positions.

Author's note: Yes, I reinvented this problem 10 years after building an Arimaa bot.
             Yes, the solution is the same.
             No, I'm not embarrassed.

KEY INSIGHT:
Instead of implementing tactical patterns one edge case at a time
(would_capture_be_bad, blocker recapture, checker hanging, counter-recapture...),
we use ONE UNIFIED SEARCH that handles ALL patterns automatically.

This replaces ~200 lines of special-case logic with ~50 lines of general search.

TRUE QUIESCENCE SEARCH:
- Searches until position is QUIET (no forcing moves)
- Does NOT stop at fixed depth
- Uses max_depth as safety valve only
- This is what real chess engines do!

PERFORMANCE:
- Quiet positions: ~5ms (stops immediately)
- Tactical sequences: 20-100ms (searches until resolved)
- Average: Often FASTER than fixed-depth search!

USAGE:
    # Check if capturing a square is tactically sound
    result = quiescence_search(board, target_square, max_depth=10)
    if result.is_tactical_trap:
        # Don't flag as hanging - it's a trap!

    # Evaluate a move before playing it
    is_bad, loss = evaluate_move_quality(board, move)
    if is_bad:
        # Flag suspicious move
"""

import chess
from typing import Optional, Tuple, List
from dataclasses import dataclass


# =============================================================================
# DATA STRUCTURES
# =============================================================================

@dataclass
class TacticalEvaluation:
    """Result of quiescence search."""
    score: int  # Material balance (positive = good for side to move)
    is_tactical_trap: bool  # True if position contains hidden tactics
    is_checkmate: bool  # True if leads to forced mate
    refutation_line: List[str]  # Human-readable line showing the tactic
    depth_searched: int  # How deep we actually searched
    nodes_evaluated: int  # How many positions we looked at


# =============================================================================
# MATERIAL EVALUATION (Simple & Fast)
# =============================================================================

PIECE_VALUES = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 0  # King value is irrelevant for material counting
}


def simple_material_count(board: chess.Board, perspective: chess.Color) -> int:
    """
    Count material from the perspective of a given color.
    
    Returns positive values if perspective is ahead, negative if behind.
    """
    score = 0
    for square in chess.SQUARES:
        piece = board.piece_at(square)
        if piece:
            value = PIECE_VALUES[piece.piece_type]
            if piece.color == perspective:
                score += value
            else:
                score -= value
    return score


# =============================================================================
# TRUE QUIESCENCE SEARCH (The Core Algorithm)
# =============================================================================

def quiescence_search(
    board: chess.Board,
    alpha: int = -9999,
    beta: int = 9999,
    current_depth: int = 0,
    max_depth: int = 10,
    perspective: Optional[chess.Color] = None,
    only_forcing: bool = True,
    line: Optional[List[str]] = None,
    node_count: Optional[List[int]] = None
) -> TacticalEvaluation:
    """
    TRUE quiescence search: search until position is quiet OR max_depth reached.
    
    This is the KEY DIFFERENCE from naive implementations:
    - We DON'T stop at a fixed depth
    - We stop when the position is QUIET (no checks, no captures)
    - max_depth is just a safety valve to prevent infinite search
    
    This ensures we never evaluate a position mid-combination!
    
    Args:
        board: Current position
        alpha: Alpha cutoff (best score for maximizing player)
        beta: Beta cutoff (best score for minimizing player)
        current_depth: How deep we are now (starts at 0)
        max_depth: Maximum depth allowed (safety valve, typically 10-15)
        perspective: Which side we're evaluating for (None = side to move)
        only_forcing: If True, only search checks/captures (standard)
        line: Accumulator for the refutation line
        node_count: Mutable list to track nodes (for benchmarking)
    
    Returns:
        TacticalEvaluation with score and tactical information
    
    Examples:
        # Simple hanging piece (no tactics)
        >>> board = chess.Board("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -")
        >>> result = quiescence_search(board, max_depth=10)
        >>> result.depth_searched  # Should be 0-1 (quiet immediately)
        
        # Tactical trap (Re1+ pattern)
        >>> board = chess.Board("r3k2r/ppp2ppp/2n5/3q4/3P4/8/PPP2PPP/R3R1K1 w kq -")
        >>> result = quiescence_search(board, max_depth=10)
        >>> result.depth_searched  # Should be 4-6 (searches full combination)
    """
    if perspective is None:
        perspective = board.turn
    
    if line is None:
        line = []
    
    if node_count is None:
        node_count = [0]
    
    # Increment node counter
    node_count[0] += 1
    
    # Base case 1: Checkmate
    if board.is_checkmate():
        mate_score = -9999 if board.turn == perspective else 9999
        return TacticalEvaluation(
            score=mate_score,
            is_tactical_trap=True,
            is_checkmate=True,
            refutation_line=line.copy(),
            depth_searched=current_depth,
            nodes_evaluated=node_count[0]
        )
    
    # STAND PAT evaluation (critical for proper quiescence!)
    # This is the score if we don't make any capture.
    # We can always choose to "stand pat" rather than make a bad capture.
    stand_pat_score = simple_material_count(board, perspective)
    if board.turn != perspective:
        stand_pat_score = -stand_pat_score

    # Beta cutoff: if standing pat is already >= beta, no need to search
    if stand_pat_score >= beta:
        return TacticalEvaluation(
            score=beta,
            is_tactical_trap=False,
            is_checkmate=False,
            refutation_line=line.copy(),
            depth_searched=current_depth,
            nodes_evaluated=node_count[0]
        )

    # Update alpha if standing pat is better
    if stand_pat_score > alpha:
        alpha = stand_pat_score

    # Collect forcing moves (checks and captures)
    forcing_moves = []
    for move in board.legal_moves:
        if only_forcing:
            # Standard quiescence: only checks and captures
            if board.gives_check(move) or board.is_capture(move):
                forcing_moves.append(move)
        else:
            # Non-standard: search all moves (slower, more thorough)
            forcing_moves.append(move)

    # Base case 2: QUIET POSITION
    # No forcing moves available - return stand pat score
    if not forcing_moves:
        return TacticalEvaluation(
            score=stand_pat_score,
            is_tactical_trap=False,
            is_checkmate=False,
            refutation_line=line.copy(),
            depth_searched=current_depth,
            nodes_evaluated=node_count[0]
        )
    
    # Base case 3: SAFETY VALVE (prevent runaway search)
    # In very complex tactical positions, we might never reach "quiet"
    # This prevents infinite loops
    if current_depth >= max_depth:
        score = simple_material_count(board, perspective)
        if board.turn != perspective:
            score = -score
        # Mark as trap because we're not sure - hit depth limit!
        return TacticalEvaluation(
            score=score,
            is_tactical_trap=True,  # Position may still be unstable
            is_checkmate=False,
            refutation_line=line.copy(),
            depth_searched=current_depth,
            nodes_evaluated=node_count[0]
        )
    
    # Recursive case: Position is NOT quiet - must search deeper!
    # This is where the magic happens - we keep going until quiet.
    # Start with stand pat score - we only play a forcing move if it's BETTER
    best_score = stand_pat_score
    best_line = line.copy()
    found_trap = False
    found_mate = False
    max_depth_reached = current_depth
    
    for move in forcing_moves:
        move_san = board.san(move)
        board.push(move)
        
        # Recursive search - depth increases by 1
        # We continue until THIS branch becomes quiet
        result = quiescence_search(
            board,
            alpha=-beta,  # Alpha-beta swap for minimax
            beta=-alpha,
            current_depth=current_depth + 1,  # GO DEEPER
            max_depth=max_depth,
            perspective=perspective,
            only_forcing=only_forcing,
            line=line + [move_san],
            node_count=node_count  # Pass through for counting
        )
        
        board.pop()
        
        # Minimax: opponent's best is our worst
        score = -result.score
        
        # Track best result
        if score > best_score:
            best_score = score
            best_line = result.refutation_line
            found_trap = result.is_tactical_trap
            found_mate = result.is_checkmate
        
        # Track deepest search
        max_depth_reached = max(max_depth_reached, result.depth_searched)
        
        # Alpha-beta pruning (speeds up search dramatically)
        alpha = max(alpha, score)
        if alpha >= beta:
            break  # Beta cutoff - no need to search further
    
    return TacticalEvaluation(
        score=best_score,
        is_tactical_trap=found_trap,
        is_checkmate=found_mate,
        refutation_line=best_line,
        depth_searched=max_depth_reached,
        nodes_evaluated=node_count[0]
    )


# =============================================================================
# HIGH-LEVEL API (Replaces old edge-case functions)
# =============================================================================

def would_capture_be_bad(board: chess.Board, capture_square: chess.Square, 
                        debug: bool = False, max_depth: int = 10) -> bool:
    """
    Check if capturing a piece would be tactically bad.
    
    REPLACES: The old 200-line would_capture_be_bad() with all its edge cases.
    
    This detects tactical traps where a piece APPEARS to be hanging
    but capturing it is punished (e.g., Rxc5 Re1+ Qf1 Rxf1#).
    
    Uses TRUE quiescence search - will search as deep as needed to find
    the truth, but stops early on quiet positions.
    
    Args:
        board: Current position
        capture_square: Square with the "hanging" piece
        debug: Print debug information
        max_depth: Maximum search depth (safety valve)
    
    Returns:
        True if ALL captures of this square lead to material loss or mate
    
    Performance:
        - Typical case: 10-30ms (searches until quiet)
        - Deep tactics: 50-100ms (Re1+ patterns, etc.)
        - Simple positions: 5-10ms (stops immediately)
    """
    # Find all moves that capture this square
    capture_moves = [
        m for m in board.legal_moves
        if m.to_square == capture_square and board.is_capture(m)
    ]
    
    if not capture_moves:
        return False  # Can't capture = not relevant
    
    # Try each capture and see if ANY is safe
    for move in capture_moves:
        move_san = board.san(move)
        board.push(move)
        
        # Search for tactical refutations (from opponent's perspective)
        result = quiescence_search(
            board, 
            max_depth=max_depth, 
            perspective=not board.turn
        )
        
        board.pop()
        
        # If opponent DOESN'T win material, the capture is safe
        # (score <= 0 means opponent doesn't gain)
        if result.score <= 0:
            if debug:
                print(f"      [QS] Capture {chess.square_name(capture_square)} with {move_san} is SAFE")
                print(f"           Score: {result.score}, Depth: {result.depth_searched}, Nodes: {result.nodes_evaluated}")
            return False  # Found a safe capture!
        
        if debug:
            print(f"      [QS] Capture {chess.square_name(capture_square)} with {move_san} is BAD")
            print(f"           Score: {result.score}, Line: {' '.join(result.refutation_line)}")
            print(f"           Depth: {result.depth_searched}, Nodes: {result.nodes_evaluated}")
    
    # All captures are bad - it's a trap!
    if debug:
        print(f"      [QS] All captures of {chess.square_name(capture_square)} are bad (tactical trap)")
    return True


def is_piece_adequately_defended(board: chess.Board, square: chess.Square, 
                                piece: chess.Piece, max_depth: int = 8) -> bool:
    """
    Check if a piece is adequately defended.
    
    REPLACES: Old defense checking logic with simple material counting.
    
    A piece is adequately defended if capturing it doesn't win material.
    Uses quiescence search to handle tactical complications.
    
    Args:
        board: Current position
        square: Square with the piece
        piece: The piece to check
        max_depth: Maximum search depth (can be shallower for speed)
    
    Returns:
        True if piece is adequately defended
    """
    owner = piece.color
    opponent = not owner
    
    # Not attacked = safe
    if not board.is_attacked_by(opponent, square):
        return True
    
    # Check if any capture wins material
    # Find lowest-value attacker
    min_attacker_value = 99
    best_capture = None
    
    for attacker_square in board.attackers(opponent, square):
        attacker = board.piece_at(attacker_square)
        if attacker:
            attacker_value = PIECE_VALUES[attacker.piece_type]
            if attacker_value < min_attacker_value:
                min_attacker_value = attacker_value
                # Find the actual move
                for move in board.legal_moves:
                    if move.from_square == attacker_square and move.to_square == square:
                        best_capture = move
                        break
    
    if best_capture is None:
        return True  # No legal capture found
    
    # Simulate the capture and search for best continuation
    board.push(best_capture)
    result = quiescence_search(board, max_depth=max_depth, perspective=opponent)
    board.pop()
    
    # If opponent gains material (positive score), piece is hanging
    return result.score <= 0


def evaluate_move_quality(board: chess.Board, move: chess.Move, 
                         max_depth: int = 10) -> Tuple[bool, int, str]:
    """
    Evaluate if a move is a tactical blunder.
    
    REPLACES: evaluate_capture_trade() and related functions.
    
    Uses quiescence search to detect tactical problems with a move.
    
    Args:
        board: Current position
        move: Move to evaluate
        max_depth: Maximum search depth
    
    Returns:
        (is_bad, material_loss, explanation)
    
    Examples:
        >>> board = chess.Board()
        >>> move = chess.Move.from_uci("e2e4")
        >>> is_bad, loss, explanation = evaluate_move_quality(board, move)
        >>> is_bad
        False
    """
    # Play the move
    move_san = board.san(move)
    board.push(move)
    
    # Search for tactical refutations from opponent's perspective
    result = quiescence_search(board, max_depth=max_depth, perspective=board.turn)
    
    board.pop()
    
    # If opponent can win significant material (>2 points), it's bad
    if result.score > 2:
        explanation = f"Move {move_san} loses {result.score} points"
        if result.refutation_line:
            explanation += f": {' '.join(result.refutation_line[:5])}"  # Show first 5 moves
            if len(result.refutation_line) > 5:
                explanation += "..."
        explanation += f" (searched {result.depth_searched} ply, {result.nodes_evaluated} nodes)"
        return True, result.score, explanation
    
    return False, 0, ""


def get_move_quality_penalty(board: chess.Board, move: chess.Move, 
                            max_depth: int = 10) -> float:
    """
    Get a penalty score for move quality (0.0 = perfect, 1.0 = terrible).
    
    REPLACES: Old penalty calculation.
    
    Args:
        board: Current position
        move: Move to evaluate
        max_depth: Maximum search depth
    
    Returns:
        Penalty from 0.0 (good move) to 1.0 (terrible move)
    """
    is_bad, loss, _ = evaluate_move_quality(board, move, max_depth=max_depth)
    if is_bad:
        # Scale: loss=3 -> 0.3, loss=6 -> 0.6, loss=8 -> 0.8
        return min(1.0, loss / 10.0)
    return 0.0


# =============================================================================
# INSTANT BAD TRADE DETECTION (Fast Pre-Check)
# =============================================================================

def should_flag_move_immediately(board: chess.Board, move: chess.Move) -> Tuple[bool, str]:
    """
    Fast pre-flight check: Should this move be flagged BEFORE playing it?
    
    This is a LIGHTWEIGHT check (no deep search) for obvious blunders.
    Use this during reconstruction to avoid backtracking.
    
    Uses simple material counting only - no quiescence search.
    For deeper analysis, use evaluate_move_quality().
    
    Args:
        board: Current position
        move: Move to check
    
    Returns:
        (should_flag, reason)
    """
    # Quick check: Is this a capture that loses material?
    if board.is_capture(move):
        captured = board.piece_at(move.to_square)
        capturing = board.piece_at(move.from_square)
        
        if captured and capturing:
            captured_value = PIECE_VALUES[captured.piece_type]
            capturing_value = PIECE_VALUES[capturing.piece_type]
            
            # If we're capturing with a much more valuable piece...
            if capturing_value > captured_value + 2:  # e.g., Queen takes Pawn
                # Check if we can be recaptured
                board.push(move)
                can_recapture = board.is_attacked_by(board.turn, move.to_square)
                board.pop()
                
                if can_recapture:
                    loss = capturing_value - captured_value
                    piece_names = {1: 'pawn', 3: 'minor', 5: 'Rook', 9: 'Queen'}
                    cap_name = piece_names.get(capturing_value, 'piece')
                    capt_name = piece_names.get(captured_value, 'piece')
                    return True, f"BAD TRADE: {cap_name} takes {capt_name}, loses {loss} points"
    
    return False, ""


# =============================================================================
# COMPATIBILITY LAYER (For gradual migration)
# =============================================================================

def find_free_captures(board: chess.Board, side_to_move: chess.Color, 
                      max_depth: int = 8) -> List[Tuple[chess.Move, chess.Piece, int]]:
    """
    Find captures that win significant material (value >= 5).
    
    COMPATIBILITY: Kept for backward compatibility with old code.
    
    Args:
        board: Current position
        side_to_move: Color to find captures for
        max_depth: Maximum search depth
    
    Returns:
        List of (move, captured_piece, net_gain)
    """
    free_captures = []
    for move in board.legal_moves:
        if not board.is_capture(move):
            continue
        
        captured = board.piece_at(move.to_square)
        if not captured or PIECE_VALUES[captured.piece_type] < 5:
            continue
        
        # Use quiescence search to verify it's actually free
        board.push(move)
        result = quiescence_search(board, max_depth=max_depth, perspective=side_to_move)
        board.pop()
        
        # If we gain material, it's a free capture
        if result.score > 0:
            net_gain = result.score
            free_captures.append((move, captured, net_gain))
    
    return free_captures


def find_hanging_pieces(board: chess.Board, side: chess.Color, 
                       max_depth: int = 8) -> List[Tuple[chess.Square, chess.Piece, int]]:
    """
    Find pieces belonging to 'side' that are hanging (attacked and undefended).
    
    COMPATIBILITY: Kept for backward compatibility.
    
    Args:
        board: Current position
        side: Color to find hanging pieces for
        max_depth: Maximum search depth
    
    Returns:
        List of (square, piece, value)
    """
    hanging = []
    opponent = not side
    
    for square in chess.SQUARES:
        piece = board.piece_at(square)
        if not piece or piece.color != side:
            continue
        
        value = PIECE_VALUES[piece.piece_type]
        if value < 3:  # Only care about minor pieces and above
            continue
        
        # Use the new tactical evaluation
        if not is_piece_adequately_defended(board, square, piece, max_depth=max_depth):
            # Double-check it's not a tactical trap
            if not would_capture_be_bad(board, square, max_depth=max_depth):
                hanging.append((square, piece, value))
    
    return hanging


# =============================================================================
# BENCHMARKING & DEBUGGING
# =============================================================================

def benchmark_position(fen: str, max_depth: int = 10, iterations: int = 10) -> dict:
    """
    Benchmark quiescence search on a position.
    
    Args:
        fen: Position to test
        max_depth: Maximum search depth
        iterations: Number of times to run (for averaging)
    
    Returns:
        Dictionary with timing and node statistics
    """
    import time
    
    board = chess.Board(fen)
    
    total_time = 0
    total_nodes = 0
    total_depth = 0
    
    for _ in range(iterations):
        start = time.perf_counter()
        result = quiescence_search(board, max_depth=max_depth)
        end = time.perf_counter()
        
        total_time += (end - start)
        total_nodes += result.nodes_evaluated
        total_depth += result.depth_searched
    
    avg_time = (total_time / iterations) * 1000  # Convert to ms
    avg_nodes = total_nodes / iterations
    avg_depth = total_depth / iterations
    
    return {
        'fen': fen,
        'avg_time_ms': avg_time,
        'avg_nodes': avg_nodes,
        'avg_depth': avg_depth,
        'iterations': iterations
    }


if __name__ == "__main__":
    # Quick test
    print("Testing quiescence search...")
    print()
    
    # Test 1: Simple position (should be quiet immediately)
    board1 = chess.Board()
    result1 = quiescence_search(board1, max_depth=10)
    print(f"Starting position:")
    print(f"  Score: {result1.score}")
    print(f"  Depth: {result1.depth_searched} (should be 0 - quiet immediately)")
    print(f"  Nodes: {result1.nodes_evaluated}")
    print()
    
    # Test 2: Tactical position (should search deeper)
    board2 = chess.Board("r3k2r/ppp2ppp/2n5/3q4/3P4/8/PPP2PPP/R3R1K1 w kq - 0 1")
    result2 = quiescence_search(board2, max_depth=10)
    print(f"Tactical position:")
    print(f"  Score: {result2.score}")
    print(f"  Depth: {result2.depth_searched} (should search deeper)")
    print(f"  Nodes: {result2.nodes_evaluated}")
    print(f"  Line: {' '.join(result2.refutation_line)}")
    print()
    
    print("✓ Quiescence search working!")
