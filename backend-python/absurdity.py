"""
Score2PGN - Absurdity Detection (Hybrid Quiescence Search)
==========================================================
Detects suspicious positions that indicate likely OCR errors.

REPLACED edge-case-prone hand-coded patterns with unified quiescence search.

Architecture:
- Layer 1 (INSTANT): Simple hanging piece detection via piece counting
- Layer 2 (QUIESCENCE): Deep tactical search only when needed

Key insight: If a piece is "hanging" but the opponent doesn't capture it,
AND capturing would be good for them (not a trap), then either:
(a) the move that left it hanging is wrong, or 
(b) the opponent's response is wrong.

This is the signal for OCR errors!
"""

import chess
from typing import List, Dict, Optional, Tuple
from data_structures import Absurdity
from helpers import piece_value, piece_name, ply_to_str, try_move


# =============================================================================
# PIECE VALUES (if not imported from helpers)
# =============================================================================

PIECE_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3,
                chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}

def _piece_value(piece: chess.Piece) -> int:
    """Get piece value. Uses local dict as fallback."""
    if hasattr(piece, 'piece_type'):
        return PIECE_VALUES.get(piece.piece_type, 0)
    return piece_value(piece)  # Fall back to helpers version


# =============================================================================
# LAYER 1: INSTANT HANGING DETECTION
# =============================================================================

def get_min_attacker_value(board: chess.Board, square: chess.Square, by_color: chess.Color) -> int:
    """Get the minimum value attacker of a square (pin-aware)."""
    min_val = 99
    for sq in board.attackers(by_color, square):
        # Skip pinned attackers that can't actually move to the target square
        pin_mask = board.pin(by_color, sq)
        if square not in pin_mask:
            continue  # Pinned and target not on pin line
        p = board.piece_at(sq)
        if p:
            min_val = min(min_val, _piece_value(p))
    return min_val


def _has_unpinned_attacker(board: chess.Board, square: chess.Square, by_color: chess.Color) -> bool:
    """
    Check if there's at least one attacker of 'square' that isn't pinned
    (or is pinned but the target square is along the pin line).

    board.is_attacked_by() doesn't account for pins — a pawn on f2 pinned
    by a bishop on c5 "attacks" g3 but can't actually move there.
    """
    for attacker_sq in board.attackers(by_color, square):
        pin_mask = board.pin(by_color, attacker_sq)
        if square in pin_mask:
            return True  # This attacker can actually move to the square
    return False


def is_apparently_hanging(board: chess.Board, square: chess.Square, piece: chess.Piece) -> bool:
    """
    Quick check: Is this piece apparently hanging?

    A piece is hanging if:
    1. It's attacked by opponent AND not defended, OR
    2. It's attacked by a lower-value piece (even if defended)

    Pin-aware: defenders that are pinned and can't actually recapture
    are not counted as real defenders.
    """
    owner = piece.color
    opponent = not owner

    if not _has_unpinned_attacker(board, square, opponent):
        return False  # Not attacked by any unpinned opponent piece = safe

    if not _has_unpinned_attacker(board, square, owner):
        return True  # Attacked but no real (unpinned) defender = hanging

    # Attacked and defended - check if attacker is lower value
    min_attacker = get_min_attacker_value(board, square, opponent)
    return min_attacker < _piece_value(piece)


def find_hanging_pieces(board: chess.Board, side: chess.Color, min_value: int = 3) -> List[Tuple[chess.Square, chess.Piece, int]]:
    """
    Find all pieces of 'side' that are apparently hanging.
    
    Returns list of (square, piece, value) for pieces worth >= min_value.
    """
    hanging = []
    for sq in chess.SQUARES:
        p = board.piece_at(sq)
        if p and p.color == side and _piece_value(p) >= min_value:
            if is_apparently_hanging(board, sq, p):
                hanging.append((sq, p, _piece_value(p)))
    return hanging


# =============================================================================
# SINGLE SOURCE OF TRUTH: Is Piece Genuinely Hanging?
# =============================================================================

def is_piece_genuinely_hanging(
    board: chess.Board,
    square: chess.Square,
    piece: chess.Piece,
    move_just_played: Optional[chess.Move] = None,
    fast_mode: bool = False,
    debug: bool = False
) -> Tuple[bool, int, str]:
    """
    SINGLE SOURCE OF TRUTH: Is this piece genuinely hanging?

    A piece is "genuinely hanging" if:
    1. It's attacked by opponent
    2. It's NOT adequately defended (or attacked by lower-value piece)
    3. There is NO counterattack justifying leaving it en prise
    4. Capturing it is NOT a trap (unless fast_mode - skip this expensive check)

    This function is used by:
    - detect_absurdity_at_ply() in absurdity.py (fix-finding)
    - check_piece_hanging() in play.py (EAD forward play)
    - is_move_absurd() in api.py

    Args:
        board: Position AFTER the move has been made
        square: Square where the piece is
        piece: The piece to check
        move_just_played: The move that was just made (for counterattack check)
        fast_mode: Skip quiescence search (faster but may have false positives)
        debug: Print debug info

    Returns:
        (is_hanging: bool, net_gain: int, reason: str)
        - is_hanging: True if piece is genuinely hanging
        - net_gain: Material gain for opponent if they capture (0 if not hanging)
        - reason: Explanation of why/why not
    """
    opponent = not piece.color
    value = _piece_value(piece)
    sq_name = chess.square_name(square)

    # Layer 0: If opponent is in check, can they even capture this piece?
    # A piece is only "hanging" if capturing it is a legal response to check
    if board.is_check():
        can_capture_legally = False
        for legal_move in board.legal_moves:
            if legal_move.to_square == square and board.is_capture(legal_move):
                can_capture_legally = True
                break
        if not can_capture_legally:
            if debug:
                print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: opponent in check, capture not legal")
            return False, 0, "opponent in check, capture not legal"

    # Layer 1a: Is it attacked?
    if not board.is_attacked_by(opponent, square):
        if debug:
            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: not attacked")
        return False, 0, "not attacked"

    # Layer 1b: Is it adequately defended?
    if not is_apparently_hanging(board, square, piece):
        if debug:
            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: adequately defended")
        return False, 0, "adequately defended"

    # Layer 1c: Counterattack check (if move provided)
    # A counterattack is only valid if the threatened piece is NOT the capturer.
    # Example: Ng5 attacks Qe7, Rh5 can take → valid counterattack (taking knight costs queen)
    # Counter-example: Bg5 attacks Qe7, Qe7 can take → NOT a counterattack (threat IS capturer)
    if move_just_played:
        move_to_sq = move_just_played.to_square
        for attacked_sq in board.attacks(move_to_sq):
            target = board.piece_at(attacked_sq)
            if target and target.color == opponent:
                target_val = _piece_value(target)
                if target_val >= value:
                    # CRITICAL: Check if the target piece can itself capture our piece.
                    # If so, it's NOT a valid counterattack - they just take our piece!
                    if attacked_sq in board.attackers(opponent, move_to_sq):
                        if debug:
                            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                                  f"false counterattack - {target.symbol()} at {chess.square_name(attacked_sq)} "
                                  f"can capture us")
                        continue  # Target can capture us - not a real counterattack
                    target_sq_name = chess.square_name(attacked_sq)
                    if debug:
                        print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                              f"counterattack on {target.symbol()} at {target_sq_name}")
                    return False, 0, f"counterattack on {target.symbol()} at {target_sq_name}"

    # Layer 1d: Pin-release check
    # If every attacker of the piece is also the pinner of a defender, then
    # capturing releases the pinned defender who can recapture.
    # Example: Qc4 attacks Rd5, pins c6 pawn. Qxd5 releases pin → cxd5 recaptures queen.
    # Only applies when the attacker's value >= piece value (so recapture is a net loss for capturer).
    pinned_defenders = []
    for def_sq in board.attackers(piece.color, square):
        if board.is_pinned(piece.color, def_sq):
            pinned_defenders.append(def_sq)

    if pinned_defenders:
        # Check if every unpinned attacker is also pinning a defender
        all_attackers_pin_defenders = True
        unpinned_attacker_count = 0
        for att_sq in board.attackers(opponent, square):
            att_pin_mask = board.pin(opponent, att_sq)
            if square not in att_pin_mask:
                continue  # This attacker is itself pinned and can't reach square
            unpinned_attacker_count += 1

            # Is this attacker on the pin line of any pinned defender?
            pins_a_defender = False
            for def_sq in pinned_defenders:
                def_pin_mask = board.pin(piece.color, def_sq)
                if att_sq in def_pin_mask:
                    pins_a_defender = True
                    break

            if not pins_a_defender:
                all_attackers_pin_defenders = False
                break

        if unpinned_attacker_count > 0 and all_attackers_pin_defenders:
            # Verify recapture is favorable: min attacker value must be >= piece value
            # (otherwise the capture is profitable even after recapture)
            min_att_val = get_min_attacker_value(board, square, opponent)
            if min_att_val >= value:
                if debug:
                    print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                          f"pin-release - capture releases pinned defender (attacker val={min_att_val} >= piece val={value})")
                return False, 0, "pin-release: capture releases pinned defender"

    # Layer 2: Trap check (skip if fast_mode for performance)
    # Note: fast_mode may produce false positives for tactical positions (e.g., back-rank traps).
    # These are handled by verification at the top level (find_fixes_two_phase).
    if fast_mode:
        # Fast mode: skip full quiescence but do a QUICK 2-ply exchange check
        # ONLY FOR QUEENS (value >= 9). Queen hanging gives -90 penalty which
        # buries the fix so far down that the VERIFY step (top 8) can't rescue it.
        # For minor pieces/rooks (-30/-50 penalty), the fix stays in the top 8
        # and the VERIFY step re-checks with full quiescence (fast_mode=False).
        #
        # Why only queens: the 2-ply check can't distinguish "real compensation"
        # from "independent captures that were available anyway." For example,
        # Ba6 hangs to bxa6, and exd5 captures an undefended knight — but that
        # knight was capturable before Ba6 too. Only queen trades have penalties
        # severe enough (-90) to justify the risk of false negatives.
        if value >= 9:
            opponent = not piece.color

            # Collect legal captures of our queen, sorted by attacker value (lowest first).
            # The opponent will use the cheapest capture — if that doesn't lead to a trade,
            # the queen is genuinely hanging regardless of what higher-value captures exist.
            # E.g., Bxd5 wins the queen outright; Qxd5 Nxd5 is a trade — but opponent plays Bxd5.
            attacker_captures = []
            for att_sq in board.attackers(opponent, square):
                att_piece = board.piece_at(att_sq)
                if att_piece is None:
                    continue
                capture_move = chess.Move(att_sq, square)
                if capture_move not in board.legal_moves:
                    continue
                attacker_captures.append((_piece_value(att_piece), att_sq, att_piece, capture_move))
            attacker_captures.sort(key=lambda x: x[0])  # Lowest value attacker first

            for att_val, att_sq, att_piece, capture_move in attacker_captures:
                test_board = board.copy()
                test_board.push(capture_move)

                # Can we recapture THEIR queen (or higher)?
                found_trade = False
                for our_move in test_board.legal_moves:
                    if test_board.is_capture(our_move):
                        target = test_board.piece_at(our_move.to_square)
                        if target and _piece_value(target) >= value:
                            if debug:
                                recapture_san = test_board.san(our_move)
                                print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                                      f"fast mode - NOT hanging (queen trade: {recapture_san} "
                                      f"recovers {_piece_value(target)} pts)")
                            found_trade = True
                            return False, 0, f"fast mode: queen trade ({test_board.san(our_move)})"

                if not found_trade:
                    # Before declaring hanging, check promotion compensation:
                    # After opponent captures our queen, can we promote on our
                    # reply? Check test_board (our turn after capture) for any
                    # legal promotion move. This properly handles blocked pawns
                    # (e.g., pawn on g7 blocked by rook on g8 with nothing on f8/h8).
                    has_promotion = False
                    for lm in test_board.legal_moves:
                        if lm.promotion is not None:
                            has_promotion = True
                            break
                    if has_promotion:
                        if debug:
                            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                                  f"fast mode - NOT hanging (promotion compensation available)")
                        return False, 0, "fast mode: promotion compensation"

                    # Cheapest capture doesn't lead to a trade — queen is genuinely hanging.
                    # Don't check higher-value captures (opponent will use this one).
                    if debug:
                        print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                              f"fast mode - hanging ({att_piece.symbol()} on "
                              f"{chess.square_name(att_sq)} captures with no trade)")
                    return True, value, "hanging (fast mode)"

        if debug:
            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: hanging (fast mode)")
        return True, value, "hanging (fast mode)"

    # Full quiescence check - is capturing this piece actually bad for opponent?
    is_trap, net_gain, expl = would_capture_be_bad_quiescence(
        board, square, threshold=0, max_depth=8, debug=debug
    )

    if is_trap:
        if debug:
            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: trap - {expl}")
        return False, 0, f"trap: {expl}"

    # Check threshold - only flag if significant gain
    if net_gain >= 3:  # Minor piece or higher
        if debug:
            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: genuinely hanging, opponent gains {net_gain}")
        return True, net_gain, f"hanging, opponent gains {net_gain}"

    if debug:
        print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: minor gain only ({net_gain})")
    return False, 0, f"minor gain only ({net_gain})"


# =============================================================================
# LAYER 2: QUIESCENCE SEARCH
# =============================================================================

def count_material(board: chess.Board, color: chess.Color) -> int:
    """Count total material for one side."""
    total = 0
    for sq in chess.SQUARES:
        p = board.piece_at(sq)
        if p and p.color == color:
            total += _piece_value(p)
    return total


def get_forcing_moves_ordered(board: chess.Board) -> List[chess.Move]:
    """
    Get forcing moves, ordered by priority.
    
    CRITICAL: When in check, ALL legal moves are forcing (must escape check).
    Otherwise, only captures and checks are forcing.
    """
    moves = []
    in_check = board.is_check()
    
    for m in board.legal_moves:
        is_check = board.gives_check(m)
        is_cap = board.is_capture(m)
        
        if in_check or is_check or is_cap:
            cap_val = _piece_value(board.piece_at(m.to_square)) if is_cap and board.piece_at(m.to_square) else 0
            priority = (100 if is_check else 0) + cap_val + (0 if (is_check or is_cap) else -50)
            moves.append((priority, m))
    
    moves.sort(key=lambda x: x[0], reverse=True)
    return [m for _, m in moves]


def would_capture_be_bad(board: chess.Board, capture_square: chess.Square, 
                          threshold: int = 0, max_depth: int = 8, debug: bool = False) -> bool:
    """
    Check if capturing the piece at capture_square would be bad for the capturer.
    
    Uses quiescence search to evaluate all forcing move sequences.
    
    Returns True if capturing loses material (is a trap).
    Returns False if capturing is good/neutral (piece is truly hanging).
    
    This replaces the old edge-case-prone hand-coded tactical patterns.
    """
    is_trap, net_gain, _ = would_capture_be_bad_quiescence(board, capture_square, threshold, max_depth, debug)
    return is_trap


def would_capture_be_bad_quiescence(board: chess.Board, capture_square: chess.Square,
                                     threshold: int = 0, max_depth: int = 8, 
                                     debug: bool = False) -> Tuple[bool, int, str]:
    """
    Full quiescence search to evaluate if capturing is bad.
    
    Returns: (is_trap, net_gain_for_capturer, explanation)
    - is_trap: True if capturing loses material
    - net_gain: Material change for the capturer (positive = good)
    - explanation: Best capture move and result
    """
    target = board.piece_at(capture_square)
    if not target:
        return False, 0, "No piece"
    
    capturer_color = not target.color
    captures = [m for m in board.legal_moves if m.to_square == capture_square and board.is_capture(m)]
    if not captures:
        return False, 0, "No captures"
    
    # Material advantage BEFORE any capture
    my_mat_before = count_material(board, capturer_color)
    opp_mat_before = count_material(board, not capturer_color)
    advantage_before = my_mat_before - opp_mat_before
    
    best_gain = -9999
    best_expl = ""
    
    def quiescence(b: chess.Board, depth: int, alpha: int, beta: int) -> int:
        """Quiescence search from capturer's perspective."""
        in_check = b.is_check()
        
        # Terminal conditions
        if b.is_checkmate():
            return -9999 if b.turn == capturer_color else 9999
        if b.is_stalemate() or b.can_claim_draw():
            return 0
        
        # Current material advantage for capturer
        my_mat = count_material(b, capturer_color)
        opp_mat = count_material(b, not capturer_color)
        stand_pat = my_mat - opp_mat
        
        # Depth limit
        if depth >= max_depth:
            return stand_pat
        
        # Get forcing moves
        forcing = get_forcing_moves_ordered(b)
        
        # If no forcing moves and not in check, position is quiet
        if not forcing and not in_check:
            return stand_pat
        
        # If in check but no legal moves, checkmate
        if not forcing and in_check:
            return -9999 if b.turn == capturer_color else 9999
        
        if b.turn == capturer_color:
            # Maximize our advantage
            if not in_check:
                if stand_pat >= beta:
                    return beta
                if stand_pat > alpha:
                    alpha = stand_pat
            
            best = stand_pat if not in_check else -9999
            for m in forcing:
                b.push(m)
                score = quiescence(b, depth + 1, alpha, beta)
                b.pop()
                if score > best:
                    best = score
                if score > alpha:
                    alpha = score
                if alpha >= beta:
                    break
            return best
        else:
            # Opponent minimizes our advantage
            if not in_check:
                if stand_pat <= alpha:
                    return alpha
                if stand_pat < beta:
                    beta = stand_pat
            
            best = stand_pat if not in_check else 9999
            for m in forcing:
                b.push(m)
                score = quiescence(b, depth + 1, alpha, beta)
                b.pop()
                if score < best:
                    best = score
                if score < beta:
                    beta = score
                if alpha >= beta:
                    break
            return best
    
    # Try each capture
    for move in captures:
        san = board.san(move)
        board.push(move)
        final_advantage = quiescence(board, 0, -9999, 9999)
        board.pop()
        
        net = final_advantage - advantage_before
        if debug:
            print(f"      {san}: final_adv={final_advantage:+d}, net={net:+d}")
        
        if net > best_gain:
            best_gain = net
            best_expl = f"{san}: {net:+d}"
    
    is_trap = best_gain < 0
    if debug:
        print(f"      Result: {'TRAP' if is_trap else 'SAFE'}, best_gain={best_gain:+d}")
    
    return is_trap, best_gain, best_expl


# =============================================================================
# LEGACY COMPATIBILITY FUNCTIONS
# =============================================================================

def is_piece_adequately_defended(board: chess.Board, square: chess.Square, piece: chess.Piece) -> bool:
    """Legacy wrapper - returns opposite of is_apparently_hanging."""
    return not is_apparently_hanging(board, square, piece)


def detect_missed_free_capture(board: chess.Board, candidate_san: str,
                               min_value: int = 5) -> Optional[Tuple[int, str]]:
    """
    Check if a candidate move ignores an obvious free capture.

    Looks for opponent pieces that are hanging (undefended or attacked by
    lower-value piece) and capturable by a legal move, but the candidate
    move doesn't capture them.

    Args:
        board: Position BEFORE the candidate move (side to move plays candidate)
        candidate_san: The proposed move in SAN
        min_value: Minimum piece value to flag (default 5 = rook+)

    Returns:
        (value, description) if a free capture is missed, None otherwise
    """
    side = board.turn
    opponent = not side

    # Find opponent pieces that are hanging
    hanging = find_hanging_pieces(board, opponent, min_value=min_value)
    if not hanging:
        return None

    # Which hanging pieces can we actually capture with a legal move?
    capturable = {}  # square → (piece, value)
    for sq, pc, val in hanging:
        for lm in board.legal_moves:
            if lm.to_square == sq and board.is_capture(lm):
                capturable[sq] = (pc, val)
                break

    if not capturable:
        return None

    # Parse the candidate move
    candidate_move = try_move(board, candidate_san)
    if not candidate_move:
        return None

    # Does the candidate capture any of the hanging pieces?
    if candidate_move.to_square in capturable:
        return None  # Candidate does capture it — no missed capture

    # Find the most valuable missed capture
    best_sq = max(capturable, key=lambda sq: capturable[sq][1])
    best_pc, best_val = capturable[best_sq]
    sq_name = chess.square_name(best_sq)
    piece_sym = best_pc.symbol().upper()

    return best_val, f"Ignores free {piece_name(piece_sym)} on {sq_name} (worth {best_val})"


def find_free_captures(board: chess.Board, side_to_move: chess.Color) -> List[Tuple[chess.Move, chess.Piece, int]]:
    """
    Find captures that win significant material.
    
    Uses quiescence search to verify the capture is actually good.
    """
    free_captures = []
    
    for move in board.legal_moves:
        if not board.is_capture(move) or board.is_en_passant(move):
            continue
        
        captured_piece = board.piece_at(move.to_square)
        if not captured_piece or _piece_value(captured_piece) < 3:
            continue
        
        # Use quiescence to check if capture is actually good
        is_trap, net_gain, _ = would_capture_be_bad_quiescence(board, move.to_square, threshold=0, max_depth=6)
        
        if not is_trap and net_gain >= 3:
            free_captures.append((move, captured_piece, net_gain))
    
    return free_captures


# =============================================================================
# CORE ABSURDITY DETECTION
# =============================================================================

def detect_absurdity_at_ply(moves: List[str], check_ply: int,
                            verbose: bool = False, threshold: int = 3,
                            fast_mode: bool = False,
                            board: chess.Board = None) -> Optional[Absurdity]:
    """
    Check if the move at check_ply creates an absurd situation.

    An absurdity is when:
    1. A move leaves a piece hanging (or inadequately defended)
    2. The opponent does NOT capture it on the next move
    3. Capturing would be GOOD for the opponent (not a trap)

    Uses is_piece_genuinely_hanging() as SINGLE SOURCE OF TRUTH for hanging detection.

    Args:
        fast_mode: If True, skip expensive quiescence search in Layer 2.
                   Use for fix-finding where speed matters more than precision.
        board: If provided, the board position AT check_ply (before the move).
               Skips replaying moves 0..check_ply-1. Caller is responsible for correctness.
    """
    if check_ply >= len(moves):
        return None

    # Build position up to check_ply (skip if caller provided board)
    if board is None:
        board = chess.Board()
        for i in range(check_ply):
            m = try_move(board, moves[i])
            if not m:
                return None
            board.push(m)
    else:
        board = board.copy()  # Don't mutate caller's board

    # Parse the move at check_ply
    move_san = moves[check_ply]
    move = try_move(board, move_san)
    if not move:
        return None

    side = board.turn  # Side making the move

    # Check if the side to move is in check BEFORE they move
    was_in_check = board.is_check()

    # Check if this move is a capture - we'll need this for trade detection
    was_capture = board.is_capture(move)
    captured_value = 0
    if was_capture:
        captured_piece = board.piece_at(move.to_square)
        if captured_piece:
            captured_value = piece_value(captured_piece)

    board.push(move)

    # Check for checkmate - no absurdity possible
    if board.is_checkmate():
        return None

    # Quick filter: find pieces that are apparently hanging (Layer 1 only)
    # This is a fast pre-filter before the full is_piece_genuinely_hanging check
    # Note: Check-response filtering is handled by is_piece_genuinely_hanging itself
    candidates = find_hanging_pieces(board, side, min_value=3)

    if not candidates:
        return None

    # === CHECK-RESPONSE FILTER ===
    # If the side was in check before moving, they were FORCED to deal with it.
    # Pieces hanging elsewhere that couldn't help defend against the check are
    # not absurd - the player had no choice but to ignore them.
    if was_in_check and candidates:
        # Undo the move to inspect the check position
        board.pop()
        # Find all legal moves that respond to check
        legal_responses = list(board.legal_moves)
        # Check if king move is the only type of response
        king_sq = board.king(side)
        only_king_moves = all(lm.from_square == king_sq for lm in legal_responses)

        if only_king_moves:
            # King move was forced — no piece could have been used to block/capture.
            # Leaving ANY piece hanging is not absurd.
            board.push(move)  # Restore the position
            return None

        # There are non-king responses (blocks/captures). Find squares that
        # COULD be involved in check defense: the checker's square (for captures)
        # and blocking squares (between checker and king on rays).
        checkers = board.checkers()
        check_relevant_squares = set()
        for checker_sq in checkers:
            check_relevant_squares.add(checker_sq)  # Can capture the checker
            # Add squares between checker and king (for blocking)
            # chess.between() returns an int bitboard, wrap in SquareSet to iterate
            between = chess.SquareSet(chess.between(checker_sq, king_sq))
            for bsq in between:
                check_relevant_squares.add(bsq)

        board.push(move)  # Restore the position

        # Filter out hanging pieces that are NOT on check-relevant squares
        # and whose from-square (before the move) couldn't have reached a
        # check-relevant square. In other words: pieces that are "collateral"
        # — they were already hanging and couldn't help with the check.
        # Simple approach: if a hanging piece is NOT on the moved-to square
        # (i.e., it's not the piece that responded to check), and it can't
        # itself capture the checker or block, it's collateral.
        filtered = []
        for sq, pc, val in candidates:
            if sq == move.to_square:
                # This is the piece that responded to check — still evaluate it
                filtered.append((sq, pc, val))
            else:
                # This piece is elsewhere. Could it have helped with the check?
                # Check if it has any legal move to a check-relevant square
                board.pop()  # Back to pre-move position
                could_help = False
                for lm in legal_responses:
                    if lm.from_square != king_sq and lm.to_square in check_relevant_squares:
                        # Some non-king piece could have addressed the check
                        # But is THIS specific hanging piece the one that could have moved?
                        if board.piece_at(lm.from_square) == pc and lm.from_square == sq:
                            could_help = True
                            break
                board.push(move)  # Restore
                if could_help:
                    filtered.append((sq, pc, val))
                # else: collateral hanging piece, not absurd
        candidates = filtered

    if not candidates:
        return None

    # Check if opponent captures any hanging piece on next move
    # If so, it's a blunder, not an absurdity (opponent DID react)
    # ALSO: if opponent gives CHECK instead of capturing, that's a strong
    # alternative — the check maintains initiative and they can likely
    # capture the hanging piece later. Not absurd.
    if check_ply + 1 < len(moves):
        next_move = try_move(board, moves[check_ply + 1])
        if next_move:
            # Filter out pieces that opponent captures on next move
            candidates = [(sq, pc, val) for sq, pc, val in candidates
                          if not (next_move.to_square == sq and board.is_capture(next_move))]
            # If next move gives check, opponent chose check over capturing —
            # that's a legitimate tactical choice, not evidence of OCR error
            if candidates:
                board.push(next_move)
                next_move_gives_check = board.is_check()
                board.pop()
                if next_move_gives_check:
                    # Opponent gave check instead of capturing hanging piece(s).
                    # Filter out hanging pieces that opponent COULD still capture
                    # later (i.e., they're not going anywhere). The check is likely
                    # stronger. Only keep candidates where the hanging piece can
                    # escape on the move after check response (complex - for now,
                    # just exempt all candidates since check > capture is normal chess).
                    candidates = []

    if not candidates:
        return None

    # Filter: if we just captured a piece of equal or greater value, leaving our
    # piece(s) "hanging" is NOT absurd when the hanging piece is worth <= what we captured.
    # Case 1 (trade): Qxd4 captures queen, our queen on d4 is now attackable — fair trade.
    # Case 2 (capture priority): Nxe3 captures rook (5), bishop on g6 (3) is hanging —
    #   net gain +2, leaving the bishop is rational, not absurd.
    if was_capture and captured_value > 0:
        candidates = [(sq, pc, val) for sq, pc, val in candidates
                      if val > captured_value]

    if not candidates:
        return None

    # Full check using SINGLE SOURCE OF TRUTH
    # This includes: counterattack check, quiescence trap check (unless fast_mode)
    for sq, pc, val in candidates:
        is_hanging, net_gain, reason = is_piece_genuinely_hanging(
            board, sq, pc,
            move_just_played=move,
            fast_mode=fast_mode,
            debug=verbose
        )

        if is_hanging and net_gain >= threshold:
            square_name = chess.square_name(sq)
            piece_sym = pc.symbol().upper()

            return Absurdity(
                ply=check_ply,
                move_played=move_san,
                absurdity_type='piece_left_hanging',
                details=f"Left {piece_name(piece_sym)} hanging on {square_name} (opponent gains {net_gain:+d}), opponent ignored it",
                severity=net_gain,
                hanging_piece=piece_sym,
                hanging_square=square_name
            )

    return None


# =============================================================================
# ABSURDITY SEARCH FUNCTIONS
# =============================================================================

def find_first_absurdity(moves: List[str], verbose: bool = False,
                         fast_mode: bool = False) -> Optional[int]:
    """Find the first move that creates an absurd situation. Returns ply number."""
    for ply in range(len(moves)):
        absurdity = detect_absurdity_at_ply(moves, ply, verbose=False, fast_mode=fast_mode)
        if absurdity and absurdity.severity >= 3:
            if verbose:
                print(f"   Absurdity at {ply_to_str(ply)}: {absurdity.details}")
            return ply
    return None


def find_first_absurdity_full(moves: List[str], verbose: bool = False,
                              fast_mode: bool = False) -> Optional[Absurdity]:
    """Find the first absurdity and return the full Absurdity object."""
    for ply in range(len(moves)):
        absurdity = detect_absurdity_at_ply(moves, ply, verbose=False, fast_mode=fast_mode)
        if absurdity and absurdity.severity >= 3:
            if verbose:
                print(f"   Absurdity at {ply_to_str(ply)}: {absurdity.details}")
            return absurdity
    return None


def find_all_absurdities(moves: List[str], verbose: bool = False,
                         fast_mode: bool = False,
                         start_ply: int = 0, board: chess.Board = None) -> List[Absurdity]:
    """
    Find all absurdities in the move list.

    Args:
        fast_mode: If True, skip expensive quiescence search. Use for fix-finding.
        start_ply: Start checking from this ply (default 0). Skips earlier plies.
        board: Board position AT start_ply. If provided with start_ply, avoids
               replaying moves 0..start_ply-1 for each ply. If None, builds
               the board incrementally from the start.
    """
    absurdities = []
    # Build board incrementally to avoid O(n^2) replays
    if board is not None:
        incremental_board = board.copy()
    elif start_ply > 0:
        incremental_board = chess.Board()
        for i in range(start_ply):
            m = try_move(incremental_board, moves[i])
            if not m:
                return absurdities
            incremental_board.push(m)
    else:
        incremental_board = chess.Board()

    for ply in range(start_ply, len(moves)):
        # Pass the pre-built board to avoid replay from ply 0
        absurdity = detect_absurdity_at_ply(moves, ply, verbose=False, fast_mode=fast_mode,
                                             board=incremental_board)
        if absurdity and absurdity.severity >= 3:
            if verbose:
                print(f"   Absurdity at {ply_to_str(ply)}: {absurdity.details}")
            absurdities.append(absurdity)
        # Advance the incremental board
        m = try_move(incremental_board, moves[ply])
        if not m:
            break
        incremental_board.push(m)
    return absurdities


# =============================================================================
# ROOT CAUSE ANALYSIS
# =============================================================================

def find_when_piece_started_hanging(moves: List[str], absurdity: Absurdity, 
                                     verbose: bool = False) -> Optional[int]:
    """
    The absurdity ply is when the piece was LEFT hanging.
    The CAUSE is often the opponent's move just before.
    """
    if absurdity.ply > 0:
        return absurdity.ply - 1
    return absurdity.ply


def analyze_absurdities_for_root_cause(absurdities: List[Absurdity], 
                                        moves: List[str] = None) -> dict:
    """
    Analyze absurdities to find likely root causes (OCR error locations).
    
    Groups absurdities by piece/square and identifies the earliest occurrence.
    """
    if not absurdities:
        return {"root_causes": []}
    
    piece_sequences = {}
    for a in absurdities:
        key = (a.hanging_piece, a.hanging_square)
        if key not in piece_sequences:
            piece_sequences[key] = []
        piece_sequences[key].append(a)
    
    root_causes = []
    for (piece, square), abs_list in piece_sequences.items():
        first_abs = min(abs_list, key=lambda x: x.ply)
        likely_error_ply = first_abs.ply - 1 if first_abs.ply > 0 else 0
        
        root_causes.append({
            "likely_error_ply": likely_error_ply,
            "first_absurdity_ply": first_abs.ply,
            "occurrences": len(abs_list),
            "details": first_abs.details,
            "hanging_piece": piece,
            "hanging_square": square
        })
    
    root_causes.sort(key=lambda x: x["first_absurdity_ply"])
    return {"root_causes": root_causes}


# =============================================================================
# DUPLICATE PAWN DETECTION (preserved from original)
# =============================================================================

def find_duplicate_pawn_destinations(ocr_lookup: Dict[int, 'OCRMove']) -> List[dict]:
    """
    Find cases where the same pawn destination appears twice for one color.
    A pawn can only move to a specific square once, so one must be wrong.
    """
    pawn_destinations = {}
    duplicates = []

    for ply in sorted(ocr_lookup.keys()):
        ocr_move = ocr_lookup[ply]
        san = ocr_move.top_move if hasattr(ocr_move, 'top_move') else (
            ocr_move.candidates[0][0] if ocr_move.candidates else None
        )

        if not san or san[0] not in 'abcdefgh':
            continue

        color = 'W' if ply % 2 == 0 else 'B'
        clean = san.replace('+', '').replace('#', '').replace('x', '').replace('=', '')
        
        if len(clean) >= 3 and clean[-1] in 'QRBN':
            clean = clean[:-1]

        if len(clean) >= 2:
            dest = clean[-2:]
            if dest[0] in 'abcdefgh' and dest[1] in '12345678':
                # Use source file to distinguish different pawns
                # san[0] is always the source file for pawn moves
                # e.g., 'c' for c6 (push), 'b' for bxc6 (capture)
                source_file = san[0]
                key = (color, source_file, dest)
                conf = ocr_move.top_confidence if hasattr(ocr_move, 'top_confidence') else 0.5

                if key in pawn_destinations:
                    first_ply, first_conf = pawn_destinations[key]
                    suspect_ply = first_ply if first_conf < conf else ply

                    duplicates.append({
                        'first_ply': first_ply,
                        'second_ply': ply,
                        'move': san,
                        'color': color,
                        'destination': dest,
                        'first_confidence': first_conf,
                        'second_confidence': conf,
                        'suspect_ply': suspect_ply
                    })
                else:
                    pawn_destinations[key] = (ply, conf)

    return duplicates


# Alias for backward compatibility
find_duplicate_pawn_moves_in_ocr = find_duplicate_pawn_destinations


def find_duplicate_pawn_moves(moves: List[str], verbose: bool = False) -> List[dict]:
    """
    Find duplicate pawn destination squares in a move list.
    """
    pawn_destinations = {}
    duplicates = []
    board = chess.Board()

    for ply, san in enumerate(moves):
        move = try_move(board, san)
        if move is None:
            break

        # Check if pawn move
        if san[0] in 'abcdefgh':
            color = 'W' if ply % 2 == 0 else 'B'
            source_file = san[0]
            clean = san.replace('+', '').replace('#', '').replace('x', '')
            if len(clean) >= 2:
                dest = clean[-2:]
                if dest[0] in 'abcdefgh' and dest[1] in '12345678':
                    key = (color, source_file, dest)
                    if key in pawn_destinations:
                        first_ply = pawn_destinations[key]
                        duplicates.append({
                            'first_ply': first_ply,
                            'second_ply': ply,
                            'move': san,
                            'color': color,
                            'destination': dest
                        })
                    else:
                        pawn_destinations[key] = ply

        board.push(move)

    return duplicates


def find_check_symbol_mismatches(moves: List[str], verbose: bool = False) -> List[dict]:
    """
    Find moves where OCR shows a check symbol (+) but the move doesn't give check.
    This signals that an earlier move was misread causing position divergence.
    """
    mismatches = []
    board = chess.Board()

    for ply, san in enumerate(moves):
        has_check_symbol = '+' in san or '#' in san
        move = try_move(board, san)

        if move is None:
            if has_check_symbol:
                mismatches.append({
                    'ply': ply,
                    'move': san,
                    'expected_check': True,
                    'actual_check': None,
                    'type': 'illegal_with_check_symbol'
                })
            break

        board.push(move)
        gives_check = board.is_check()
        board.pop()

        if has_check_symbol and not gives_check:
            mismatches.append({
                'ply': ply,
                'move': san,
                'expected_check': True,
                'actual_check': False,
                'type': 'false_check'
            })

        board.push(move)

    return mismatches


# =============================================================================
# BAD TRADE DETECTION (for instant flagging)
# =============================================================================

def is_bad_trade_move(board: chess.Board, move: chess.Move) -> Tuple[bool, int, str]:
    """
    Check if a capture is a bad trade - BEFORE making the move.

    Returns: (is_bad_trade, material_loss, explanation)

    Uses QUIESCENCE SEARCH for accurate exchange evaluation.
    This handles arbitrarily deep exchange sequences like:
    Rxd5 Qxd5 cxd5 Bxd5 exd5...

    Only called in forward pass (EAD), not in fix-finding, so the
    ~1-5ms cost per capture is acceptable for accuracy.
    """
    if not board.is_capture(move):
        return False, 0, ""

    captured = board.piece_at(move.to_square)
    if not captured:  # en passant - pawn for pawn, never bad
        return False, 0, ""

    capturing = board.piece_at(move.from_square)
    if not capturing:
        return False, 0, ""

    captured_val = _piece_value(captured)
    capturing_val = _piece_value(capturing)

    # If capturing with equal or lesser value, it's fine
    if capturing_val <= captured_val:
        return False, 0, ""

    # Quick check: can we even be recaptured?
    test_board = board.copy()
    test_board.push(move)
    opponent = test_board.turn
    to_square = move.to_square

    if not test_board.is_attacked_by(opponent, to_square):
        return False, 0, ""  # Can't be recaptured - trade is safe

    # Use QUIESCENCE SEARCH for accurate exchange evaluation
    # This searches all forcing moves until the position is quiet
    #
    # IMPORTANT: After our capture, it's OPPONENT's turn.
    # would_capture_be_bad_quiescence evaluates from OPPONENT's perspective.
    # - is_trap=True means opponent's recapture is bad for OPPONENT
    #   → our original capture was GOOD (not a bad trade)
    # - is_trap=False means opponent's recapture is safe/good for OPPONENT
    #   → our original capture was BAD
    # - net_gain is from OPPONENT's view (positive = good for opponent)
    is_trap, net_gain, _ = would_capture_be_bad_quiescence(
        test_board, to_square, threshold=0, max_depth=8
    )

    # If opponent's recapture is a trap (bad for them), our capture was GOOD
    if is_trap:
        return False, 0, ""

    # If opponent gains significant material by recapturing, our capture was BAD
    # net_gain > 0 means opponent profits from the exchange
    if net_gain > 2:
        piece_names = {1: "pawn", 3: "minor", 5: "Rook", 9: "Queen"}
        expl = f"{piece_names.get(capturing_val, 'piece')} takes {piece_names.get(captured_val, 'piece')}, loses {net_gain}"
        return True, net_gain, expl

    return False, 0, ""


def evaluate_capture_trade(board: chess.Board, move: chess.Move) -> Tuple[bool, int, str]:
    """Alias for is_bad_trade_move for backward compatibility."""
    return is_bad_trade_move(board, move)


def should_flag_move_immediately(board: chess.Board, move: chess.Move) -> Tuple[bool, str]:
    """Pre-flight check: Should this move be flagged BEFORE playing it?"""
    is_bad, loss, explanation = is_bad_trade_move(board, move)
    if is_bad and loss >= 3:
        return True, f"BAD TRADE: {explanation}"
    return False, ""


def get_move_quality_penalty(board: chess.Board, move: chess.Move) -> float:
    """Get penalty score for move quality (0.0 = good, 1.0 = terrible)."""
    is_bad, loss, _ = is_bad_trade_move(board, move)
    if is_bad:
        return min(1.0, loss / 10.0)
    return 0.0
