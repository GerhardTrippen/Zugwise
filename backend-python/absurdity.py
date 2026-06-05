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


def is_classically_hanging_free(board: chess.Board, square: chess.Square, piece: chess.Piece) -> bool:
    """
    Classical-hang check: can opponent's cheapest attacker capture at `square`
    and sit safely afterwards (no recapture)?

    Stricter than is_piece_genuinely_hanging because it does NOT consider
    cross-board tactical compensation. Useful for EAD, where mutual-hang
    positions (two undefended pieces on opposite sides) should fire even
    though quiescence correctly nets them to zero.

    Returns True only when the capture is genuinely free — i.e. no defender
    attacks the square after the capture. Pieces that can be recaptured or
    that create legitimate sacrificial compensation fall through to
    is_piece_genuinely_hanging instead.

    Turn-independent: if it isn't currently the attacker's turn, the board
    turn is flipped in a local copy so the legal-move check works symmetrically
    for either side (needed when probing the non-moving side's captures).
    """
    opponent = not piece.color
    attackers = list(board.attackers(opponent, square))
    if not attackers:
        return False

    if board.turn != opponent:
        probe_board = board.copy()
        probe_board.turn = opponent
        probe_board.ep_square = None  # avoid stale ep state after flip
    else:
        probe_board = board

    # Try attackers in order from cheapest up. The first legal capture
    # decides — if that capture sits safely, piece is classically hanging.
    attackers.sort(key=lambda s: _piece_value(board.piece_at(s)) if board.piece_at(s) else 10**6)
    for att_sq in attackers:
        ap = probe_board.piece_at(att_sq)
        if ap is None:
            continue
        capture_move = chess.Move(att_sq, square)
        if capture_move not in probe_board.legal_moves:
            continue
        test_board = probe_board.copy()
        test_board.push(capture_move)
        return not test_board.is_attacked_by(piece.color, square)

    return False


def side_has_independent_free_capture(board: chess.Board, by_color: chess.Color) -> bool:
    """
    Does `by_color` have a classically-free capture in the current position,
    independent of any prospective capture by the opponent?

    Used to gate the classical-hang fallback in EAD. When quiescence cancels
    a mutual-hang to net 0, either:
    (a) both sides have a pre-existing free capture that net out — two
        independent absurdities; flag.
    (b) compensation only exists because the opponent's capture removes a
        defender (overloaded-defender trade) — legitimate exchange; don't flag.

    This helper detects (a).
    """
    opp = not by_color
    for sq in chess.SQUARES:
        op = board.piece_at(sq)
        if op is None or op.color != opp:
            continue
        if _piece_value(op) < 3:
            continue
        if is_classically_hanging_free(board, sq, op):
            return True
    return False


def move_attacks_compensating_target(
    board: chess.Board,
    move: chess.Move,
    min_value: int,
) -> bool:
    """
    Did the move-just-played itself create an attack on an opponent piece of
    value >= min_value that is classically free in the resulting position?

    Distinguishes a structural sacrifice (Ulvestad 5...b5: pawn attacks Bc4
    while leaving Nc6 hanging — the pawn fork IS the compensation) from a
    coincidental mutual-hang OCR ghost (two unrelated free captures fluking
    to net 0). In a real fork the moved piece directly threatens the
    opponent's hanging material; in an OCR ghost the geometry is unrelated.

    Args:
        board:     position AFTER the move was played
        move:      the move just played (its to_square is the moved piece's
                   new location, whose attacks are examined)
        min_value: minimum value of the attacked piece for it to count as
                   compensation — typically the value of our hanging piece,
                   so the trade is at least even.

    Returns: True if at least one opponent piece worth >= min_value is
             attacked from move.to_square AND is classically free.
    """
    moved_piece = board.piece_at(move.to_square)
    if moved_piece is None:
        return False
    side_that_moved = moved_piece.color
    for atk_sq in board.attacks(move.to_square):
        opp_piece = board.piece_at(atk_sq)
        if opp_piece is None or opp_piece.color == side_that_moved:
            continue
        if _piece_value(opp_piece) < min_value:
            continue
        if is_classically_hanging_free(board, atk_sq, opp_piece):
            return True
    return False


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
        # Fast mode: skip full quiescence but do a QUICK 2-ply exchange check.
        # After the opponent's cheapest capture of our piece, if we have a
        # legal capture worth >= our loss, treat as a fair trade and not hanging.
        #
        # Two activation regimes:
        #  - Queens (value >= 9): unconditional. The -90 penalty would otherwise
        #    bury the fix below the top-N verify cut, and queen swaps are
        #    unambiguous enough that the false-negative risk is acceptable.
        #  - Non-queens: gated on "trade enabled by our move" — the recapture
        #    target must be attacked by our just-moved piece. Without this gate
        #    an independent pre-existing free capture (e.g. Ba6 hangs to bxa6
        #    while exd5 captures an unrelated free knight that was capturable
        #    before Ba6 too) would falsely suppress a real minor-piece hang.
        #    The gate is what makes Red8/Rad8 work: rook lands on d8 attacking
        #    d7, so the Rxd7 recapture counts as compensation for losing Bd1;
        #    it would NOT count for an unrelated h2->h4 push.
        opponent = not piece.color

        # Collect legal captures of our piece, sorted by attacker value (lowest first).
        # The opponent will use the cheapest capture — if that doesn't lead to a trade,
        # the piece is genuinely hanging regardless of what higher-value captures exist.
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

        # No legal captures of the target — the piece is not actually
        # capturable, so it isn't hanging. Layer 1 (is_apparently_hanging)
        # returned True based on raw board.attackers() geometry, which can
        # include pieces that can't legally capture (e.g., a king that
        # would move into check from a defender). Without this guard, those
        # cases fell through to the unconditional "hanging (fast mode)"
        # return at the bottom of this block. Reported: knight on c6 after
        # 41.W axb5 — only geometric attacker is Kb7, but Kxc6 is illegal
        # (the b5 pawn defends c6, king would move into check). Knight is
        # safe; fast-mode falsely flagged it as hanging and made the
        # algorithms propose spurious upstream fixes.
        if not attacker_captures:
            if debug:
                print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                      f"fast mode - NOT hanging (no legal captures)")
            return False, 0, "fast mode: no legal captures"

        # Squares attacked by our just-moved piece — used to gate the
        # non-queen trade check (see comment above). Empty when no move
        # context is available; non-queens then fall through to "hanging".
        moved_piece_attacks = (
            set(board.attacks(move_just_played.to_square))
            if move_just_played is not None else set()
        )

        for att_val, att_sq, att_piece, capture_move in attacker_captures:
            test_board = board.copy()
            test_board.push(capture_move)

            # Can we recapture a piece of equal or greater value?
            found_trade = False
            for our_move in test_board.legal_moves:
                if test_board.is_capture(our_move):
                    target = test_board.piece_at(our_move.to_square)
                    if target and _piece_value(target) >= value:
                        # Non-queen gate: only count this trade as
                        # compensation if it's enabled by our move
                        # (target attacked by the piece we just moved).
                        if value < 9 and our_move.to_square not in moved_piece_attacks:
                            continue
                        if debug:
                            recapture_san = test_board.san(our_move)
                            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                                  f"fast mode - NOT hanging (trade: {recapture_san} "
                                  f"recovers {_piece_value(target)} pts)")
                        found_trade = True
                        return False, 0, f"fast mode: trade ({test_board.san(our_move)})"

            if not found_trade:
                # Before declaring hanging, check promotion compensation:
                # after opponent captures our piece, can we promote on our
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

                # Cheapest capture doesn't lead to a trade — piece is genuinely hanging.
                # Don't check higher-value captures (opponent will use this one).
                if debug:
                    print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                          f"fast mode - hanging ({att_piece.symbol()} on "
                          f"{chess.square_name(att_sq)} captures with no trade)")
                return True, value, "hanging (fast mode)"

        if debug:
            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: hanging (fast mode)")
        return True, value, "hanging (fast mode)"

    # Promotion-compensation check (mirrors the fast_mode block above).
    # If opponent captures our hanging piece and on our reply we have a
    # legal pawn promotion that survives (the new queen isn't immediately
    # captured), the "hang" is a deliberate sacrifice — the player traded
    # a minor/rook for a queen. Standard quiescence skips non-capture
    # promotions, so without this check the EAD non-fast path flagged
    # promotion-threat sacrifices as OCR errors. Reported case: 33.B c2
    # (pushing to the 7th) "leaves Bd7 hanging" — but after Qxd7, Black
    # plays c1=Q for +9 promotion vs −3 bishop, a clear sac.
    # Cheapest attacker only — opponent will use that one — and we
    # confirm survival to avoid greenlighting promotions that simply
    # walk into another capture.
    _opp = not piece.color
    _att_list = []
    for _a_sq in board.attackers(_opp, square):
        _a_p = board.piece_at(_a_sq)
        if _a_p is None:
            continue
        _cap_mv = chess.Move(_a_sq, square)
        if _cap_mv not in board.legal_moves:
            continue
        _att_list.append((_piece_value(_a_p), _a_sq, _cap_mv))
    _att_list.sort(key=lambda x: x[0])
    if _att_list:
        _att_val, _a_sq, _cap_mv = _att_list[0]
        _tb = board.copy()
        _tb.push(_cap_mv)
        for _promo_mv in _tb.legal_moves:
            if _promo_mv.promotion is None:
                continue
            _tb2 = _tb.copy()
            _tb2.push(_promo_mv)
            if not _tb2.is_attacked_by(_opp, _promo_mv.to_square):
                if debug:
                    print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: "
                          f"NOT hanging (promotion compensation: {_tb.san(_promo_mv)} "
                          f"survives after {board.san(_cap_mv)})")
                return False, 0, "promotion compensation"

    # Full quiescence check - is capturing this piece actually bad for opponent?
    is_trap, net_gain, expl = would_capture_be_bad_quiescence(
        board, square, threshold=0, max_depth=8, debug=debug
    )

    if is_trap:
        if debug:
            print(f"    [HANG-DEBUG] {piece.symbol()} on {sq_name}: trap - {expl}")
        return False, 0, f"trap: {expl}"

    # Check threshold - flag if opponent gains 2+ material.
    # Using 2 rather than 3 catches cases where the bishop/knight is "sort of" hanging:
    # e.g. Bh6 gxh6, where white can grab a pawn back via Bxa6 later (net=+2 for black).
    # Net gain of 2+ is still highly suspicious for a non-capturing move.
    if net_gain >= 2:
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
    """Count total material for one side.

    Bitboard popcount instead of a 64-square piece_at scan: this is called
    twice per quiescence node (my_mat / opp_mat) and was a top profiler entry
    (~25M piece_at calls). Values mirror PIECE_VALUES exactly (king=0, so it
    is omitted). Verified identical to the old scan across 3000 random games.
    """
    occ = board.occupied_co[color]
    return (chess.popcount(board.pawns & occ)
            + chess.popcount(board.knights & occ) * 3
            + chess.popcount(board.bishops & occ) * 3
            + chess.popcount(board.rooks & occ) * 5
            + chess.popcount(board.queens & occ) * 9)


# Full queen-line mask (rank | file | both diagonals, blockers IGNORED) per
# square, precomputed once. NOT chess.BB_*_MASKS — those are magic occupancy
# masks that EXCLUDE edge squares (e.g. they drop g8 from the g-file), which
# would miss edge-square checks. get_forcing_moves_ordered uses this to cheaply
# pre-filter quiet moves that cannot possibly give check.
_KING_LINE_MASK = []
for _k in range(64):
    _kf, _kr = _k & 7, _k >> 3
    _m = 0
    for _s in range(64):
        _x, _y = _s & 7, _s >> 3
        if _x == _kf or _y == _kr or abs(_x - _kf) == abs(_y - _kr):
            _m |= 1 << _s
    _KING_LINE_MASK.append(_m)


def get_forcing_moves_ordered(board: chess.Board) -> List[chess.Move]:
    """
    Get forcing moves, ordered by priority.

    CRITICAL: When in check, ALL legal moves are forcing (must escape check).
    Otherwise: captures, checks, AND non-capture promotions are forcing.
    Promotions are forcing because they swing material by ~8 (queen − pawn);
    without them quiescence misses winning sacrifices like 51.B Nb4 where
    Black gives up the knight expecting 52.W Nxb4 a1=Q — the standard
    "captures only" quiescence let White stand-pat after Nxb4 and never
    saw a1=Q, falsely flagging Nb4 as a hanging blunder.

    PERF: board.gives_check(m) (an internal push/is_check/pop) was 60% of the
    quiescence runtime, and ~88% of those calls were on quiet moves just to
    decide whether they're forcing. A quiet move can only give check if its
    destination attacks the enemy king (lands on a king queen-line for
    sliders/pawns, or a knight-jump) or its origin vacates a king queen-line
    (discovered check) — or it's a castling move (rook can check). That test is
    a strict SUPERSET of checking moves (over-approximates by ignoring blockers),
    so we skip gives_check on quiet moves that fail it and still call it on the
    survivors to confirm. The emitted list is byte-identical to the unfiltered
    version — verified across ~40k random positions and the superset invariant
    (gives_check ⟹ filter) across 667k quiet moves. Filters ~61% of quiet
    moves; gives_check is still used as-is for captures/promos/in-check moves
    (where it only refines ordering), so their order is untouched.
    """
    moves = []
    in_check = board.is_check()

    # Pre-filter masks (only meaningful when not already in check — in check,
    # every legal move is forcing and gives_check just orders).
    if not in_check:
        opp_king = board.king(not board.turn)
        my_king = board.king(board.turn)
        if opp_king is not None:
            king_lines = _KING_LINE_MASK[opp_king]
            check_to = king_lines | chess.BB_KNIGHT_ATTACKS[opp_king]
        else:
            king_lines = check_to = ~0  # no enemy king (degenerate) → filter nothing

    for m in board.legal_moves:
        is_cap = board.is_capture(m)
        is_promo = m.promotion is not None

        if in_check or is_cap or is_promo:
            # Forcing regardless; gives_check only refines ordering (unchanged).
            is_check = board.gives_check(m)
        else:
            # Quiet move, not in check: forcing iff it gives check. Skip the
            # expensive gives_check when geometry proves it can't.
            could_check = (bool(check_to & chess.BB_SQUARES[m.to_square])
                           or bool(king_lines & chess.BB_SQUARES[m.from_square])
                           or (m.from_square == my_king
                               and abs((m.to_square & 7) - (m.from_square & 7)) == 2))
            if not could_check:
                continue
            is_check = board.gives_check(m)
            if not is_check:
                continue

        cap_val = _piece_value(board.piece_at(m.to_square)) if is_cap and board.piece_at(m.to_square) else 0
        promo_bonus = 8 if is_promo else 0  # queen − pawn material swing
        tactical = is_check or is_cap or is_promo
        priority = (100 if is_check else 0) + cap_val + promo_bonus + (0 if tactical else -50)
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
    
    def _opp_has_near_promo_pawn(b: chess.Board) -> bool:
        """Does b.turn's opponent have a pawn one ply from promoting?
        White pawn on rank 7 (index 6) or black pawn on rank 2 (index 1).
        Such a position is NOT quiet — the side to move cannot stand-pat
        because the opponent's next move will be a promotion (~+8 material)."""
        # Bitboard test instead of a 64-square scan: called once per
        # quiescence node (~120K times) and was a top profiler entry. White
        # pawn on rank 7 (BB_RANK_7) or black pawn on rank 2 (BB_RANK_2) is one
        # ply from promoting. Verified identical to the old scan across 3000
        # random games.
        opp = not b.turn
        opp_pawns = b.pawns & b.occupied_co[opp]
        near_rank = chess.BB_RANK_7 if opp == chess.WHITE else chess.BB_RANK_2
        return bool(opp_pawns & near_rank)

    def quiescence(b: chess.Board, depth: int, alpha: int, beta: int) -> int:
        """Quiescence search from capturer's perspective."""
        in_check = b.is_check()
        # Disable stand-pat when opponent has a pawn one square from
        # promoting. Reported case: 39...Ra2 (rook sacrifice). After
        # 40.Bxa2 bxa2, the b-pawn lands on a2 (rank 2 for Black =
        # one ply from a1=Q). Standard quiescence let White stand-pat
        # at +2 (gained rook, lost bishop) and never saw that not
        # capturing the pawn loses ~8 to the promotion — so it flagged
        # Ra2 as hanging. Treating "opp has near-promo pawn" the same
        # as being in check (no stand-pat, must explore forcing moves)
        # corrects the eval to net 0, well below the hanging threshold.
        opp_promo_threat = _opp_has_near_promo_pawn(b)
        must_move = in_check or opp_promo_threat

        # Terminal conditions
        if b.is_checkmate():
            return -9999 if b.turn == capturer_color else 9999
        # Draw detection: use is_repetition(3) (position has actually repeated
        # 3 times on the board) rather than can_claim_draw(). can_claim_draw()
        # loops over EVERY legal move pushing/popping each to test a *claimable*
        # repetition, plus runs the fifty-move scan — both walk the full
        # real-game move stack carried into quiescence, making each node O(stack
        # * legal_moves). That dominated runtime (~40% of total, scaling with
        # game depth). is_repetition(3) is the only draw condition that
        # meaningfully arises inside a short capture/check quiescence, and is
        # ~5x cheaper overall. A genuine threefold still evaluates to 0.
        if b.is_stalemate() or b.is_repetition(3):
            return 0

        # Current material advantage for capturer
        my_mat = count_material(b, capturer_color)
        opp_mat = count_material(b, not capturer_color)
        stand_pat = my_mat - opp_mat

        # Depth limit — when opp is about to promote, deduct the queen-pawn
        # swing so the truncated branch isn't artificially optimistic for
        # the side to move.
        if depth >= max_depth:
            if opp_promo_threat:
                return stand_pat - 8 if b.turn == capturer_color else stand_pat + 8
            return stand_pat

        # Get forcing moves
        forcing = get_forcing_moves_ordered(b)

        # If no forcing moves and not must-move, position is quiet
        if not forcing and not must_move:
            return stand_pat

        # If must-move but no legal moves (only possible when in_check):
        # checkmate. opp_promo_threat without legal moves means stalemate,
        # already handled above.
        if not forcing and in_check:
            return -9999 if b.turn == capturer_color else 9999
        if not forcing and opp_promo_threat:
            # No forcing options to stop the promotion — concede the swing.
            return stand_pat - 8 if b.turn == capturer_color else stand_pat + 8

        if b.turn == capturer_color:
            # Maximize our advantage
            if not must_move:
                if stand_pat >= beta:
                    return beta
                if stand_pat > alpha:
                    alpha = stand_pat

            best = stand_pat if not must_move else -9999
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
            if not must_move:
                if stand_pat <= alpha:
                    return alpha
                if stand_pat < beta:
                    beta = stand_pat

            best = stand_pat if not must_move else 9999
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


def find_free_captures_with_check(board: chess.Board, side_to_move: chess.Color,
                                   max_depth: int = 10) -> List[Tuple[chess.Move, chess.Piece, int]]:
    """
    Find captures that give check AND win material, verified by quiescence.

    Much narrower than find_free_captures — only fires on captures that also
    give check. A free capture with check is an immediate forcing threat that
    no human would allow, regardless of skill level (reconstruction plausibility).

    Only runs quiescence on captures that give check, so in most positions
    (where zero captures give check) this is essentially free.

    Default max_depth=10 is needed for deep exchanges on the captured square
    (e.g., Rxg7+ Rxg7 Bxg7 Rxg7 Rxg5 Rxg5 hxg5 hxg5 needs ~8 plies to fully
    resolve). Shallower search returns premature material counts mid-exchange,
    falsely flagging non-free captures as free.

    For per-candidate scoring during fix-finding (where this is called 30+
    times per ply), pass max_depth=6 — fast path. Top candidates get re-checked
    at full depth in _postprocess_phase2_fixes' verify pass, so any false
    negatives at depth=6 are caught for the candidates that matter.
    """
    free_captures = []

    for move in board.legal_moves:
        if not board.is_capture(move) or board.is_en_passant(move):
            continue

        # Cheap gate: does this capture give check?
        board.push(move)
        gives_check = board.is_check()
        board.pop()
        if not gives_check:
            continue

        captured_piece = board.piece_at(move.to_square)
        if not captured_piece:
            continue

        # Quiescence to verify capture is genuinely free (not a trap)
        is_trap, net_gain, _ = would_capture_be_bad_quiescence(board, move.to_square, threshold=0, max_depth=max_depth)

        if not is_trap and net_gain >= 1:
            free_captures.append((move, captured_piece, net_gain))

    return free_captures


# =============================================================================
# CORE ABSURDITY DETECTION
# =============================================================================

def detect_absurdity_at_ply(moves: List[str], check_ply: int,
                            verbose: bool = False, threshold: int = 2,
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

    # === BAD-TRADE ABSURDITY ===
    # Mirror of piece_left_hanging for the case where the destination *is*
    # defended yet outgunned: e.g. Bxe5 in 3rr1k1/1pp3pp/pnn5/3ppb2/8/
    # 1P2PNB1/P3BPPP/2RR2K1 — bishop captures pawn, defenders=1, attackers=3,
    # SEE nets -2. is_apparently_hanging treats the destination as defended
    # so piece_left_hanging never fires; SEE catches it.
    # is_bad_trade_move already includes a tactical-compensation escape hatch
    # (mate-in-1 / free big recapture) so genuine sacrifices don't trip it.
    # Skipped when the move is forced (only legal response to check).
    is_forced = was_in_check and len(list(board.legal_moves)) == 1
    if not is_forced:
        is_bad, loss, explanation = is_bad_trade_move(board, move)
        if is_bad and loss >= threshold:
            moving_piece = board.piece_at(move.from_square)
            piece_sym = moving_piece.symbol().upper() if moving_piece else '?'
            to_sq_name = chess.square_name(move.to_square)
            return Absurdity(
                ply=check_ply,
                move_played=move_san,
                absurdity_type='bad_trade',
                details=f"{piece_name(piece_sym)} {explanation} on {to_sq_name}",
                severity=loss,
                hanging_piece=piece_sym,
                hanging_square=to_sq_name,
            )

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

    # Two exemptions for the next-move check:
    #  (a) opponent gives check on the next move — strong tactical choice,
    #      not evidence of OCR error. Clear all candidates.
    #  (b) opponent captures the specific hanging candidate on the next
    #      move — normal exchange, not OCR error. Drop that candidate only.
    # Symmetric with the play.py/validation.py exemptions: a piece that
    # gets immediately taken IS a normal exchange, not a multi-ply hanging
    # absurdity. The persistent-absurdity tracker still flags pieces that
    # hang across multiple plies with no reaction. Reported case: 41.W axb5
    # leaves R on c8 attacked by Bf5 (SEE-loss of 2 for white); black plays
    # Bxc8 immediately. Live walked through cleanly; the algorithms found
    # the absurdity here via find_all_absurdities → detect_absurdity_at_ply
    # and proposed spurious upstream fixes.
    if check_ply + 1 < len(moves):
        next_move = try_move(board, moves[check_ply + 1])
        if next_move:
            board.push(next_move)
            next_move_gives_check = board.is_check()
            board.pop()
            if next_move_gives_check:
                candidates = []
            elif board.is_capture(next_move):
                captured_sq = next_move.to_square
                candidates = [c for c in candidates if c[0] != captured_sq]

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

        if is_hanging:
            # If this move was a capture, credit the material we gained
            # against the hanging loss. net_gain (and the fast_mode raw
            # piece value) only measure what the opponent earns at the
            # destination — they don't subtract what we already pocketed
            # with our capture. Without this, e.g. R6xg5 (rook takes
            # knight, rook then attackable by pawn) was scored severity=5
            # → -50 penalty, even though the actual exchange nets ~1-2.
            # Mirrors is_bad_trade_move which already returns severity=
            # opp_gain - captured_val.
            effective_loss = net_gain - captured_value if was_capture else net_gain
            if effective_loss >= threshold:
                square_name = chess.square_name(sq)
                piece_sym = pc.symbol().upper()

                return Absurdity(
                    ply=check_ply,
                    move_played=move_san,
                    absurdity_type='piece_left_hanging',
                    details=f"Left {piece_name(piece_sym)} hanging on {square_name} (opponent gains {net_gain:+d}, net loss {effective_loss:+d}), opponent ignored it",
                    severity=effective_loss,
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
        if absurdity and absurdity.severity >= 2:
            if verbose:
                print(f"   Absurdity at {ply_to_str(ply)}: {absurdity.details}")
            return ply
    return None


def find_first_absurdity_full(moves: List[str], verbose: bool = False,
                              fast_mode: bool = False) -> Optional[Absurdity]:
    """Find the first absurdity and return the full Absurdity object."""
    for ply in range(len(moves)):
        absurdity = detect_absurdity_at_ply(moves, ply, verbose=False, fast_mode=fast_mode)
        if absurdity and absurdity.severity >= 2:
            if verbose:
                print(f"   Absurdity at {ply_to_str(ply)}: {absurdity.details}")
            return absurdity
    return None


class AbsurditiesPrefixCache:
    """Snapshot cache for ``find_all_absurdities`` — board state + accumulated
    absurdities, snapshotted at each successfully-played ply.

    Lets ``find_all_absurdities`` resume mid-game instead of replaying from
    ply 0 every call. Search algorithms call it repeatedly across iterations
    with only a single move differing between calls, so without a cache the
    work compounds quickly.

    What's stored per ply: a board copy and the absurdities accumulated so
    far. ``Absurdity`` instances are constructed once and never mutated, so
    snapshot entries can be shared safely across cache copies (analogous to
    ``EadPrefixCache``).

    Invariants and rules:
      - ``snapshots[k]`` is the state AFTER processing ply k: board at
        position k+1 and absurdities at plies 0..k. Length = plies processed.
      - The cache is tied to ``fast_mode`` (Layer 2 quiescence on or off).
        Different ``fast_mode`` values produce different absurdities — never
        share a cache across them. (severity_threshold is hardcoded to 2.)
      - ``invalidate_from(F)`` MUST be called after any mutation to
        ``moves[F]``. ``detect_absurdity_at_ply`` consults ``moves[F+1-1] =
        moves[F]`` via the opponent-takes-hanging exemption (and
        ``_detect_hanging_pieces`` likewise), so a snapshot recorded at ply
        F-1 may have used the old ``moves[F]``. We drop snapshots[F-1:].
      - Like the other caches: one cache instance per mutating move list.
        Beam paths and Dijkstra nodes need their own (clone via ``copy``).
      - The ``verbose`` flag on ``find_all_absurdities`` only logs plies
        scanned in this call. Plies served from cache do not re-print.
    """

    __slots__ = ("_snapshots",)

    def __init__(self):
        self._snapshots: List[Tuple[chess.Board, List[Absurdity]]] = []

    @property
    def ply(self) -> int:
        return len(self._snapshots)

    def get_state(self) -> Tuple[chess.Board, List[Absurdity]]:
        """Fresh, independently-mutable copies of the latest snapshot."""
        if not self._snapshots:
            return chess.Board(), []
        board, absurdities = self._snapshots[-1]
        return board.copy(), list(absurdities)

    def record(self, board: chess.Board, absurdities: List[Absurdity]):
        """Append a snapshot. Call once per successfully processed ply."""
        self._snapshots.append((board.copy(), list(absurdities)))

    def invalidate_from(self, ply: int):
        """Drop snapshots that may have used moves[ply] in lookahead.

        ``detect_absurdity_at_ply`` and ``_detect_hanging_pieces`` consult
        ``moves[P+1]`` when processing ply P. Snapshot[P] embeds that lookahead
        result; if moves[P+1]=moves[ply] is mutated, snapshot[ply-1] is stale.
        Drop snapshots[ply-1:] (clamped at 0).
        """
        drop_from = max(0, ply - 1)
        if drop_from < len(self._snapshots):
            del self._snapshots[drop_from:]

    def copy(self) -> "AbsurditiesPrefixCache":
        """Independent clone sharing the (immutable) snapshot entries."""
        other = AbsurditiesPrefixCache()
        other._snapshots = list(self._snapshots)
        return other


def find_all_absurdities(moves: List[str], verbose: bool = False,
                         fast_mode: bool = False,
                         start_ply: int = 0, board: chess.Board = None,
                         prefix_cache: Optional["AbsurditiesPrefixCache"] = None,
                         end_ply: Optional[int] = None) -> List[Absurdity]:
    """
    Find all absurdities in the move list.

    Args:
        fast_mode: If True, skip expensive quiescence search. Use for fix-finding.
        start_ply: Start checking from this ply (default 0). Skips earlier plies.
        board: Board position AT start_ply. If provided with start_ply, avoids
               replaying moves 0..start_ply-1 for each ply. If None, builds
               the board incrementally from the start.
        prefix_cache: Optional snapshot cache. When provided AND non-empty,
               resume from cache state and ignore ``start_ply``/``board``. Caller
               is responsible for ensuring the cache was populated with the same
               ``fast_mode`` and a compatible move list (call
               ``cache.invalidate_from(F)`` after mutating ``moves[F]``).
        end_ply: Stop checking BEFORE this ply (exclusive). Default None = scan
               to the end. Limits only WHICH plies are checked — the full
               ``moves`` list is still available for detect_absurdity_at_ply's
               lookahead, so a windowed [start_ply, end_ply) scan yields results
               identical to a full scan filtered to that range. Lets callers
               that only consume in-window absurdities avoid re-running the
               hanging/quiescence check on early, already-confirmed plies every
               iteration (the per-step cost otherwise grows with game depth).
    """
    # Resume from cache when available. The cache supersedes start_ply/board.
    if prefix_cache is not None and prefix_cache.ply > 0:
        incremental_board, absurdities = prefix_cache.get_state()
        start_ply = prefix_cache.ply
    else:
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

    scan_end = len(moves) if end_ply is None else min(end_ply, len(moves))
    for ply in range(start_ply, scan_end):
        # Pass the pre-built board to avoid replay from ply 0
        absurdity = detect_absurdity_at_ply(moves, ply, verbose=False, fast_mode=fast_mode,
                                             board=incremental_board)
        if absurdity and absurdity.severity >= 2:
            if verbose:
                print(f"   Absurdity at {ply_to_str(ply)}: {absurdity.details}")
            absurdities.append(absurdity)
        # Advance the incremental board
        m = try_move(incremental_board, moves[ply])
        if not m:
            break
        incremental_board.push(m)
        if prefix_cache is not None:
            prefix_cache.record(incremental_board, absurdities)
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

def see_at_square(board: chess.Board, square: chess.Square, by_color: chess.Color) -> int:
    """
    Static Exchange Evaluation at `square`, initiated by `by_color`.

    Alternates cheapest captures at `square` and returns the minimax net
    material gain for the initiator. Unlike full quiescence, this does NOT
    explore cross-board tactics — it answers the narrow question "will an
    exchange sequence at this square win material?" without being influenced
    by pre-existing tactical opportunities elsewhere on the board.

    The distinction matters for bad_trade detection: a knight walking onto a
    square defended by an equal-value piece is a fair local trade even if the
    opponent has a separate winning move on a third piece.
    """
    b = board.copy()
    gains = []
    side = by_color
    while True:
        target = b.piece_at(square)
        if target is None:
            break
        attackers = list(b.attackers(side, square))
        if not attackers:
            break
        attackers.sort(key=lambda s: _piece_value(b.piece_at(s)) if b.piece_at(s) else 10**6)

        # Pick the cheapest attacker that can legally capture. Two gates:
        #  1. A king cannot capture into a square still defended by the
        #     opposite side (would move into check).
        #  2. A piece pinned along a line that doesn't pass through the
        #     target cannot legally capture the target (moving it would
        #     expose its own king to the pinner). Reported case: c8 queen
        #     pinned along the 8th rank by white Rd8 against black Kb8 —
        #     Qxc6 would expose the king and is illegal, so SEE must not
        #     count the queen as a recapturer. Without this filter SEE
        #     reported opp_gain=3 for Nxc6+, flagging a winning move as a
        #     bad trade.
        chosen = None
        for att_sq in attackers:
            ap = b.piece_at(att_sq)
            if ap is None:
                continue
            if ap.piece_type == chess.KING and b.is_attacked_by(not side, square):
                continue  # king can't move into a defended square
            # Pin filter: pin() returns BB_ALL for unpinned pieces, or
            # the SquareSet of squares on the pin line for pinned ones.
            # The destination must be on that line for the capture to be
            # legal. (King has no pin — pin() handles it correctly.)
            pin_mask = b.pin(side, att_sq)
            if pin_mask != chess.BB_ALL and not (pin_mask & chess.BB_SQUARES[square]):
                continue
            chosen = (att_sq, ap)
            break

        if chosen is None:
            break

        att_sq, att_piece = chosen
        gains.append(_piece_value(target))
        b.remove_piece_at(att_sq)
        b.remove_piece_at(square)
        b.set_piece_at(square, att_piece)
        side = not side

    # Minimax: each capturer can stop the sequence if continuing loses material.
    score = 0
    for g in reversed(gains):
        score = max(0, g - score)
    return score


def _capture_has_tactical_compensation(board: chess.Board, our_move: chess.Move,
                                       to_square: chess.Square, our_loss: int) -> bool:
    """
    After we play `our_move` and the opponent captures at `to_square` with
    their cheapest attacker, do we have a forcing reply (mate, or a free
    capture worth at least `our_loss`) that compensates for the material?

    SEE alone misses sacrifices that work because the opponent's capture
    enables a tactic for us — e.g. Bd6 unblocks the c-file so that after
    Bxd6, Rxc1 is mate. Without this check, every such sacrifice would be
    flagged as a bad trade.

    Scope is intentionally narrow: only mate-in-1 and "free big capture"
    after a single opponent recapture. Deeper tactics fall through to the
    user. The point is to avoid loud false positives on obvious sacrifices,
    not to do full engine search.
    """
    tb = board.copy()
    tb.push(our_move)

    captures = [m for m in tb.legal_moves
                if m.to_square == to_square and tb.is_capture(m)]
    if not captures:
        return False

    captures.sort(key=lambda m: _piece_value(tb.piece_at(m.from_square))
                  if tb.piece_at(m.from_square) else 10**6)
    opp_capture = captures[0]
    tb.push(opp_capture)

    for m in tb.legal_moves:
        gives_check = tb.gives_check(m)
        is_capture = tb.is_capture(m)
        is_promo = m.promotion is not None
        if not (gives_check or is_capture or is_promo):
            continue

        if gives_check:
            tb.push(m)
            if tb.is_checkmate():
                tb.pop()
                return True
            # Forced mate-in-2: opp is in check and has legal responses, but
            # every response leaves them in a position where we have a
            # mate-in-1 reply. Catches sacrifices that win via a forcing
            # check sequence, not just an immediate mate. Reported case:
            # 38.Nxg6 Kxg6 (capture) 39.Qxh5+ Kg7 (only legal) 40.Qh7#
            # — without this, Nxg6 was flagged as a "minor takes pawn,
            # loses 2" bad trade even though it's the winning move.
            legal_responses = list(tb.legal_moves)
            forced_mate = bool(legal_responses)
            for resp in legal_responses:
                tb.push(resp)
                mate_after_response = False
                for follow in tb.legal_moves:
                    if tb.gives_check(follow):
                        tb.push(follow)
                        if tb.is_checkmate():
                            mate_after_response = True
                        tb.pop()
                        if mate_after_response:
                            break
                tb.pop()
                if not mate_after_response:
                    forced_mate = False
                    break
            tb.pop()
            if forced_mate:
                return True

        if is_capture or is_promo:
            # A recapture on the SAME exchange square is NOT compensation —
            # it's the continuation of the static exchange that see_at_square
            # already folded into `our_loss`. Crediting it again double-counts
            # (e.g. N takes pawn, opp recaptures, we recapture the recapturing
            # pawn: that second pawn is why the net loss is already 1, not a
            # separate "free capture worth our_loss"). This was harmless at the
            # default threshold (a 1-point recapture never meets gain >= 2) but
            # spuriously cancels the flag at threshold=1. Genuine compensation
            # is mate (handled above) or a gain on a DIFFERENT square.
            if m.to_square == to_square:
                continue
            # Gross gain from this reply, before opponent's recapture:
            #   captured opponent piece + promotion bonus (queen - pawn = 8).
            # A pawn promotion is just as visible as a free capture and is in
            # scope for compensation (e.g. opp Rxg7 allowing our c8=Q).
            cap_val = 0
            if is_capture:
                captured = tb.piece_at(m.to_square)
                if captured is None:
                    continue  # en passant — no piece on to_square
                cap_val = _piece_value(captured)
            promo_bonus = 0
            if is_promo:
                promoted_val = _piece_value(chess.Piece(m.promotion, tb.turn))
                promo_bonus = promoted_val - 1  # pawn value
            gain = cap_val + promo_bonus
            if gain < our_loss:
                continue
            # Confirm the piece on the destination square isn't lost back.
            # After we push, it is opponent's turn (tb.turn == opponent),
            # so SEE is initiated by tb.turn. SEE reads the current piece
            # on the square, which is the promoted piece for promotions.
            tb.push(m)
            see_back = see_at_square(tb, m.to_square, tb.turn)
            tb.pop()
            if gain - see_back >= our_loss:
                return True

    return False


def is_bad_trade_move(board: chess.Board, move: chess.Move,
                      threshold: int = 2) -> Tuple[bool, int, str]:
    """
    Check if a move is a bad trade - BEFORE making the move.

    Handles both captures (where we take an opponent piece) and non-captures
    (where we walk a piece onto an attacked square). Returns our net material
    loss from the exchange that starts at the destination square.

    Returns: (is_bad_trade, our_material_loss, explanation)

    Uses a FOCUSED static exchange evaluation (SEE) at the target square —
    alternating cheapest captures only, no cross-board tactics. This keeps
    the check aligned with its intent ("is the piece immediately losing on
    this square?") and prevents false positives where a move would be flagged
    because the opponent has an unrelated winning capture elsewhere.

    Fires at our_loss >= ``threshold`` (default 2) to cover exchange
    sacrifices (rook-for-bishop) and minor-for-pawn — not just full-piece
    hangs. Callers handling an INFERRED capture (player omitted the 'x', we
    added it) pass threshold=1: an unmarked capture that even slightly loses
    material is suspect, whereas an explicitly-written capture is trusted at
    the default 2.
    """
    capturing = board.piece_at(move.from_square)
    if not capturing:
        return False, 0, ""

    capturing_val = _piece_value(capturing)
    is_capture = board.is_capture(move)

    captured_val = 0
    if is_capture:
        captured = board.piece_at(move.to_square)
        if not captured:  # en passant - pawn for pawn, never bad
            return False, 0, ""
        captured_val = _piece_value(captured)

        # If capturing with equal or lesser value, it's fine
        if capturing_val <= captured_val:
            return False, 0, ""
    else:
        # Non-capture: only worth checking pieces worth 3+
        # (pawns walking into attacks are too common to flag)
        if capturing_val < 3:
            return False, 0, ""

    test_board = board.copy()
    test_board.push(move)
    opponent = test_board.turn
    to_square = move.to_square

    if not test_board.is_attacked_by(opponent, to_square):
        return False, 0, ""  # Can't be recaptured - move is safe

    # Focused SEE: what does opponent net from the exchange sequence at
    # this square alone? (Independent of any other tactical opportunities.)
    opp_gain = see_at_square(test_board, to_square, opponent)

    # Our net loss = opponent's gain from this square minus anything we
    # pocketed with our original capture.
    our_loss = opp_gain - captured_val

    if our_loss >= threshold:
        # Tactical sacrifice check: opponent's capture may enable a forcing
        # reply (mate or big free capture) that compensates the material.
        if _capture_has_tactical_compensation(board, move, to_square, our_loss):
            return False, 0, ""

        piece_names = {1: "pawn", 3: "minor", 5: "Rook", 9: "Queen"}
        if is_capture:
            expl = f"{piece_names.get(capturing_val, 'piece')} takes {piece_names.get(captured_val, 'piece')}, loses {our_loss}"
        else:
            expl = f"{piece_names.get(capturing_val, 'piece')} walks into loss of {our_loss}"
        return True, our_loss, expl

    return False, 0, ""


def evaluate_capture_trade(board: chess.Board, move: chess.Move) -> Tuple[bool, int, str]:
    """Alias for is_bad_trade_move for backward compatibility."""
    return is_bad_trade_move(board, move)


def should_flag_move_immediately(board: chess.Board, move: chess.Move) -> Tuple[bool, str]:
    """Pre-flight check: Should this move be flagged BEFORE playing it?"""
    is_bad, loss, explanation = is_bad_trade_move(board, move)
    if is_bad and loss >= 2:
        return True, f"BAD TRADE: {explanation}"
    return False, ""


def get_move_quality_penalty(board: chess.Board, move: chess.Move) -> float:
    """Get penalty score for move quality (0.0 = good, 1.0 = terrible)."""
    is_bad, loss, _ = is_bad_trade_move(board, move)
    if is_bad:
        return min(1.0, loss / 10.0)
    return 0.0
