"""
Zugwise - Move Validation Module
================================
Single source of truth for move validation logic.
Used by both Flask backend and Pyodide frontend.
"""

import chess
from typing import List, Dict, Any, Optional, Set, Tuple

from helpers import (
    try_move, count_changes, get_semantic_changes, infer_move_squares,
    piece_value, _is_valid_move_notation, _disambig_consistent_with_move,
    extract_destination
)
from absurdity import would_capture_be_bad, is_piece_adequately_defended, is_piece_genuinely_hanging
from play import is_bad_trade_move, check_piece_hanging

# Constants
OCR_ALT_MIN_CONFIDENCE = 0.05
PERSISTENCE_THRESHOLD = 2


def is_forced_piece_substitution(board: chess.Board, original_san: str, corrected_san: str) -> bool:
    """Auto-fix K<->R when only one piece type remains on the board.

    If a player has no rooks left, any R->K correction is forced (only king can move).
    Similarly, if there's no king confusion possible (always exists), we skip that direction.

    A forced substitution swaps ONLY the piece letter (Rg1 -> Kg1); the
    destination square must be unchanged. A correction that also moves the
    piece to a different square (Rg1 -> Ka1) is a 2-change fix, not a forced
    notation swap — it must go through the normal confirmation / deep-search
    path so a same-destination alternative (e.g. Qg1) isn't silently lost.
    """
    if not original_san or not corrected_san:
        return False
    orig_piece = original_san[0] if original_san[0] in 'KQRBN' else None
    corr_piece = corrected_san[0] if corrected_san[0] in 'KQRBN' else None
    if not orig_piece or not corr_piece:
        return False
    if set([orig_piece, corr_piece]) != set(['K', 'R']):
        return False  # Only K<->R
    # Destination must be identical — otherwise this is a different move, not a
    # forced piece-letter swap.
    if extract_destination(original_san) != extract_destination(corrected_san):
        return False
    color = board.turn
    rook_count = len(board.pieces(chess.ROOK, color))
    if rook_count == 0:
        # No rooks - any R->K correction is forced (only king can move)
        return orig_piece == 'R'
    return False


def normalize_candidate(alt) -> Optional[Tuple[str, float]]:
    """Normalize OCR alternative to (move, confidence) tuple."""
    if isinstance(alt, dict):
        move = alt.get('move') or alt.get('san', '')
        conf = alt.get('confidence', 0.1)
        return (move, conf) if move else None
    elif isinstance(alt, str):
        return (alt, 0.1)
    elif isinstance(alt, (list, tuple)) and len(alt) >= 2:
        return (str(alt[0]), float(alt[1]))
    return None


def is_move_absurd(board: chess.Board, move: chess.Move) -> bool:
    """Check if a move is obviously absurd (hangs the moved piece for free)."""
    board.push(move)
    try:
        to_square = move.to_square
        piece = board.piece_at(to_square)
        if piece is None:
            return False
        opponent = not piece.color
        if board.is_attacked_by(opponent, to_square):
            if not is_piece_adequately_defended(board, to_square, piece):
                if not would_capture_be_bad(board, to_square):
                    return True
        return False
    finally:
        board.pop()


def describe_suggested_move_warning(board: chess.Board, move: chess.Move) -> Optional[str]:
    """
    Run the same EAD checks we'd apply if the move were actually played, but
    speculatively — return a human-readable warning string if the move creates
    an absurdity, None otherwise. Used to warn users before they accept a
    similarity-based pending_confirmation (the move wasn't pushed, so the
    regular check_ead_after_move path never ran).

    Covers: bad_trade (before push), piece hanging after push (moved piece
    and any other piece of side_that_moved).
    """
    # Bad trade check (captures where we lose net material, and non-captures
    # where the moved piece walks into a losing exchange)
    is_bad, loss, explanation = is_bad_trade_move(board, move)
    if is_bad and loss >= 2:
        return f"Bad trade: {explanation}"

    # Hanging check (after the move is played)
    test_board = board.copy()
    test_board.push(move)
    hang = check_piece_hanging(test_board, move)
    if hang:
        _sq_name, _piece_val, hang_explanation = hang
        return hang_explanation
    return None


def validate_moves(
    moves: List[str],
    ocr_data: List[Dict] = None,
    settings: Dict = None,
    approved_plies: Set[int] = None,
    start_ply: int = 0
) -> Dict[str, Any]:
    """
    Validate a list of chess moves and return validation result.

    Args:
        moves: List of moves in SAN notation
        ocr_data: Optional OCR data with alternatives for each move
        settings: Optional settings dict with:
            - max_changes: Maximum character changes for auto-correct (default 2)
            - piece_confusions: List of [orig, repl] pairs for piece confusion
            - piece_file_confusions: List of [orig, repl] pairs for piece/file confusion
        approved_plies: Set of ply indices that are pre-approved (skip EAD checks)
        start_ply: Start full validation from this ply (moves before this are played without checks)

    Returns:
        Dict with validation results including:
            - valid: bool - True if all moves validated
            - moves: List of validated move dicts
            - stuck_at: Optional ply index where validation stopped
            - stuck_move: The move that caused validation to stop
            - stuck_reason: Why validation stopped
            - pending_confirmation: Optional auto-correct needing user confirmation
    """
    if ocr_data is None:
        ocr_data = []
    if settings is None:
        settings = {}
    if approved_plies is None:
        approved_plies = set()

    print(f"[VALIDATE] approved_plies = {approved_plies}, start_ply = {start_ply}")

    # Extract settings
    max_changes = settings.get('max_changes', 2)
    ocr_autofix = settings.get('ocr_autofix', False)
    similarity_autofix = settings.get('similarity_autofix', False)
    use_ead = True

    piece_confusions_raw = settings.get('piece_confusions')
    piece_file_confusions_raw = settings.get('piece_file_confusions')
    piece_confusions = [tuple(pair) for pair in piece_confusions_raw] if piece_confusions_raw else None
    piece_file_confusions = [tuple(pair) for pair in piece_file_confusions_raw] if piece_file_confusions_raw else None

    # State
    board = chess.Board()
    validated = []
    stuck_at = None
    stuck_move = None
    stuck_reason = None
    stuck_explanation = None
    pending_confirmation = None
    hanging_pieces = {}

    def check_ead_after_move(ply: int, move_obj: chess.Move, move_san: str):
        """Check for Early Absurdity Detection after a move."""
        nonlocal hanging_pieces

        if not use_ead:
            return False, None, None

        if ply in approved_plies:
            return False, None, None

        # Check for bad trade
        board.pop()
        # Skip bad trade check if move is forced (only legal move in check)
        is_forced = board.is_check() and len(list(board.legal_moves)) == 1
        is_bad, loss, explanation = is_bad_trade_move(board, move_obj)
        board.push(move_obj)

        if is_bad and loss >= 2 and not is_forced:
            print(f"[EAD] Ply {ply} BAD TRADE: {explanation}")
            return True, "bad_trade", f"Bad trade: {explanation}"

        # Check if the MOVED piece is now hanging (e.g., Be5 where e5 is attacked by pawn)
        # This is NOT covered by is_bad_trade_move (only checks captures) or
        # check_piece_hanging (skips the piece that just moved)
        #
        # Use is_piece_genuinely_hanging (SINGLE SOURCE OF TRUTH) which handles:
        # - Check/checkmate detection
        # - Defense evaluation
        # - Counterattack check
        # - Trap detection
        if not board.is_checkmate():
            to_square = move_obj.to_square
            moved_piece = board.piece_at(to_square)
            if moved_piece and piece_value(moved_piece) >= 3:  # B/N/R/Q
                sq_name = chess.square_name(to_square)

                # Skip if this was a winning or equal capture — being "hanging" after
                # capturing a higher-value piece is just the second half of a favorable trade.
                # E.g., Nxe3 captures rook (5) — knight (3) is recapturable but net gain is +2.
                board.pop()
                was_winning_capture = False
                if board.is_capture(move_obj):
                    captured = board.piece_at(move_obj.to_square)
                    if captured and piece_value(captured) >= piece_value(moved_piece):
                        was_winning_capture = True
                board.push(move_obj)

                if was_winning_capture:
                    pass  # Fair/winning trade - not absurd
                else:
                    # Use SINGLE SOURCE OF TRUTH (no counterattack check for moved piece)
                    is_hanging, net_gain, reason = is_piece_genuinely_hanging(
                        board, to_square, moved_piece,
                        move_just_played=None,  # No counterattack check for the piece that just moved
                        fast_mode=False
                    )

                    if is_hanging:
                        # The moved piece is hanging for free!
                        # Check if opponent captures it next move
                        if ply + 1 < len(moves):
                            next_san = moves[ply + 1]
                            next_move = try_move(board, next_san, piece_confusions=piece_confusions,
                                                piece_file_confusions=piece_file_confusions)
                            if next_move is not None:
                                if next_move.to_square == to_square and board.is_capture(next_move):
                                    pass  # Opponent captures - real blunder, not OCR error
                                else:
                                    # Opponent IGNORES hanging piece - absurd!
                                    piece_name = {3: "minor piece", 5: "Rook", 9: "Queen"}.get(
                                        piece_value(moved_piece), "piece")
                                    explanation = f"{move_san} puts {piece_name} on {sq_name} en prise, opponent ignores it"
                                    print(f"[EAD] Ply {ply} MOVED PIECE HANGING - {explanation}")
                                    return True, "piece_hanging", explanation
                        else:
                            # Last move - flag it
                            piece_name = {3: "minor piece", 5: "Rook", 9: "Queen"}.get(
                                piece_value(moved_piece), "piece")
                            explanation = f"{move_san} puts {piece_name} on {sq_name} en prise"
                            print(f"[EAD] Ply {ply} MOVED PIECE HANGING (end) - {explanation}")
                            return True, "piece_hanging", explanation

        # Check for piece hanging (OTHER pieces, not the one that just moved)
        hanging_result = check_piece_hanging(board, move_obj, debug=False)
        if hanging_result:
            sq_name, piece_val, explanation = hanging_result
            hanging_square = chess.parse_square(sq_name)

            # Check if opponent captures it next move
            if ply + 1 < len(moves):
                next_san = moves[ply + 1]
                next_move = try_move(board, next_san, piece_confusions=piece_confusions,
                                    piece_file_confusions=piece_file_confusions)

                if next_move is not None:
                    if next_move.to_square == hanging_square and board.is_capture(next_move):
                        pass  # Opponent takes it - not absurd
                    else:
                        print(f"[EAD] Ply {ply} PIECE HANGING: {explanation}")
                        return True, "piece_hanging", explanation
                else:
                    pass  # Can't parse next move
            else:
                print(f"[EAD] Ply {ply} PIECE HANGING (last move): {explanation}")
                return True, "piece_hanging", explanation

        # Check for persistent hanging pieces
        side_just_moved = not board.turn
        opponent = board.turn

        current_hanging = set()
        for sq in chess.SQUARES:
            piece = board.piece_at(sq)
            if piece is None or piece.color != side_just_moved:
                continue
            value = piece_value(piece)
            if value < 3:
                continue
            if not board.is_attacked_by(opponent, sq):
                continue
            if is_piece_adequately_defended(board, sq, piece):
                continue
            if would_capture_be_bad(board, sq):
                continue

            sq_name = chess.square_name(sq)
            current_hanging.add(sq_name)

            if sq_name in hanging_pieces:
                hanging_pieces[sq_name]['persistence'] += 1
                if hanging_pieces[sq_name]['persistence'] >= PERSISTENCE_THRESHOLD:
                    hp = hanging_pieces[sq_name]
                    info = f"{hp['piece']} hanging on {sq_name} for {hp['persistence']} moves"
                    print(f"[EAD] Ply {ply} PERSISTENT ABSURDITY - approved_plies={approved_plies}")
                    return True, "persistent_absurdity", info
            else:
                hanging_pieces[sq_name] = {
                    'start_ply': ply,
                    'piece': piece.symbol(),
                    'severity': value,
                    'persistence': 0
                }

        # Remove pieces no longer hanging
        for sq_name in list(hanging_pieces.keys()):
            if sq_name not in current_hanging:
                del hanging_pieces[sq_name]

        return False, None, None

    # Track arrow squares for EAD stops (legal moves where we know from/to)
    stuck_from_square = None
    stuck_to_square = None

    # Main validation loop
    for i, san in enumerate(moves):
        try:
            # FAST PATH: For moves before start_ply, just play them without checks
            # These have already been validated/confirmed by the user
            if i < start_ply:
                move = try_move(board, san, max_changes=2,
                               piece_confusions=piece_confusions,
                               piece_file_confusions=piece_file_confusions)
                if move is None:
                    raise ValueError(f"Previously confirmed move is now illegal: {san}")
                corrected_san = board.san(move)
                board.push(move)
                validated.append({'ply': i, 'san': corrected_san, 'status': 'ok',
                                'original': san if san != corrected_san else None})
                continue

            # FORCED STOP: dual-sheet ambiguity. The merge flags a ply
            # (ocr_data[i]['forced_stop']) when two confident sheets disagree on
            # the move (near-tie). The cell text is the higher-confidence reading,
            # but it is unresolved and must NOT be silently played through — stop
            # here so the user chooses between the candidates (the fix UI surfaces
            # the ocr_data alternatives). This replaces the old illegal "/"-marker
            # trick: the move text stays a real, replayable move (so noise
            # truncation / export / display see ordinary data) while this explicit
            # flag — checked only here and in the search driver — does the
            # stopping. Skipped once the user confirms the ply (approved_plies);
            # resolution also clears the flag on the next merge.
            #
            # LEGALITY GUARD: only stop as 'ambiguous' when the flagged reading is
            # actually LEGAL. The merge can pick an illegal higher-confidence
            # reading (e.g. 1.B 'Kc5' @52%, illegal, vs legal 'c5'); that must be
            # handled as a normal illegal fix below (which surfaces c5) — NOT as a
            # keepable ambiguity (a "Keep Kc5" button is nonsense). So an illegal
            # forced-stop reading falls through to Step 0.5 / the fix search.
            if (ocr_data and i < len(ocr_data)
                    and ocr_data[i].get('forced_stop')
                    and i not in approved_plies
                    and try_move(board, san, auto_correct=False) is not None):
                stuck_at = i
                stuck_move = san
                stuck_reason = 'ambiguous'
                stuck_explanation = ocr_data[i].get('ambiguous_explanation')
                validated.append({'ply': i, 'san': san, 'status': 'error',
                                  'original': san, 'forced_stop': True})
                break

            # Step 0.5: High-confidence fallback (runs BEFORE try_move)
            # If top move is illegal AND there's an alternative with >50% confidence
            # (in dual mode this is the other sheet's top pick), try it directly.
            # This must run before try_move because try_move might find a correction
            # (e.g., Kd7→Kxd7 via capture fix) that then requires confirmation,
            # whereas the >50% alt from the other sheet should auto-apply.
            # In single-sheet mode, at most one candidate can exceed 50%, so this
            # is naturally gated without needing a dual_mode flag.
            move = None
            # Use try_move(auto_correct=False) to check strict legality.
            # Raw parse_san is too lenient — e.g., it accepts "Kd7" as a capture
            # when d7 is occupied, but the notation is wrong (should be "Kxd7").
            if try_move(board, san, auto_correct=False) is not None:
                pass  # Top move is strictly legal — skip to Step 1
            else:
                # Top move is illegal — check for high-confidence alternatives.
                #
                # DUAL-SHEET DISAGREEMENT GUARD (pre-scan): before falling back
                # to the OTHER sheet's >50% reading, find the legal alternative
                # that is the CLOSEST (fewest char edits) to the illegal primary
                # text. If that nearest legal reading is STRICTLY closer than the
                # >50% fallback AND points to a different move, the two sheets
                # genuinely disagree and the higher-confidence sheet (whose
                # reading became the cell text) plainly meant its own closer
                # move. Example (15.B): sheet1 'Rb4'@0.88 — a b-file rook move
                # whose only legal reading is 'Rb8' (4->8, 1 edit) — vs sheet2
                # 'Rd8'@0.67 (the OTHER rook, 2 edits, blocked from b8 by Bc8).
                # The old dual fallback silently applied 'Rd8' because 'Rb4'->
                # 'Rd8' isn't a SEMANTIC change (no piece/capture swap). That is
                # a confident-wrong commit: it overrides the more-confident sheet
                # with the less-confident one. Surface it as an 'ambiguous'
                # forced-stop displaying the closer legal reading so the user
                # picks (Keep Rb8 / replace with Rd8). See CLAUDE.md "One or
                # Nothing" — when two legal readings compete, don't auto-apply.
                nearest_legal_san = None
                nearest_legal_changes = None
                if i < len(ocr_data) and ocr_data[i].get('alternatives'):
                    for alt in ocr_data[i]['alternatives']:
                        normalized = normalize_candidate(alt)
                        if not normalized:
                            continue
                        nl_move, _nl_conf = normalized
                        try:
                            nl_parsed = board.parse_san(nl_move)
                        except Exception:
                            continue
                        if nl_parsed not in board.legal_moves:
                            continue
                        if not _is_valid_move_notation(nl_move, nl_parsed, board):
                            continue
                        nl_canon = board.san(nl_parsed)
                        nl_changes = count_changes(san, nl_canon)
                        if nearest_legal_changes is None or nl_changes < nearest_legal_changes:
                            nearest_legal_changes = nl_changes
                            nearest_legal_san = nl_canon

                # PAWN-MOVE PROBE (one-or-nothing): a phantom leading piece
                # letter on a pawn push is a common OCR error — a stray mark
                # before 'e3' reads as 'N', giving the illegal 'Ne3'. Dropping
                # the piece letter yields the pawn move 'e3' (SAME destination
                # square), a candidate the character corrector never generates
                # and the dual fallback never considers. It competes head-on
                # with the piece-move fix at EQUAL edit distance (Ne3->Nf3 vs
                # Ne3->e3, both 1 edit), so the strictly-closer guard above
                # misses it. Surface that as ambiguous instead of silently
                # committing the piece move.
                #
                # GROUNDING: require the pawn move to actually appear in the
                # alternatives (a sheet genuinely read it). This keeps the probe
                # tied to OCR evidence and — critically — avoids the 15.B 'Rb4'
                # regression: there 'b4' (pawn b5->b4) is legal but NO sheet
                # read it, so the rook reading 'Rb8' (handled by the strictly-
                # closer guard) must win, not a synthesized pawn push.
                pawn_legal_san = None
                if san and san[0] in 'NBRQK':
                    _pawn_txt = san[1:]  # 'e3', 'e3+', 'e8=Q' ...
                    if (_pawn_txt and _pawn_txt[0] in 'abcdefgh' and 'x' not in _pawn_txt):
                        _alt_sans = set()
                        if i < len(ocr_data) and ocr_data[i].get('alternatives'):
                            for _a in ocr_data[i]['alternatives']:
                                _n = normalize_candidate(_a)
                                if _n:
                                    _alt_sans.add(_n[0])
                        if _pawn_txt in _alt_sans:
                            try:
                                _pp = board.parse_san(_pawn_txt)
                                if (_pp in board.legal_moves
                                        and _is_valid_move_notation(_pawn_txt, _pp, board)):
                                    pawn_legal_san = board.san(_pp)
                            except Exception:
                                pass

                if i < len(ocr_data) and ocr_data[i].get('alternatives'):
                    for alt in ocr_data[i]['alternatives']:
                        normalized = normalize_candidate(alt)
                        if not normalized:
                            continue
                        alt_move, alt_conf = normalized
                        if alt_conf < 0.50:
                            break  # Alternatives sorted by confidence, no point continuing
                        try:
                            parsed = board.parse_san(alt_move)
                            # Reject phantom notation (e.g., "Rd7+" when not check, "Qxd6" when d6 empty).
                            # python-chess's parse_san silently accepts these; we don't.
                            if not _is_valid_move_notation(alt_move, parsed, board):
                                continue
                            # Reject alts that represent a semantic change vs the primary
                            # (piece swap, removing +/#/x). In dual-sheet mode this means the
                            # two sheets disagree on the piece/capture — the user should confirm,
                            # not have one sheet silently override the other.
                            if get_semantic_changes(san, alt_move):
                                continue
                            if is_move_absurd(board, parsed):
                                continue
                            # Legal and not absurd — play it.
                            # Canonicalize via board.san(parsed) before push: an OCR alt
                            # like "Rbc8" carries the player's over-specified disambig,
                            # which chess.js 0.12.0 strictly rejects (canonical is just
                            # "Rc8" when only one rook can reach c8 — the b3 rook can't).
                            # Storing the alt verbatim leaves state.sans with a SAN the
                            # frontend can't replay, freezing the board at that ply.
                            # python-chess's board.san emits canonical SAN; everything
                            # downstream (move list, navigation, PGN export) needs it.
                            canon_san = board.san(parsed)
                            # DISAGREEMENT GUARD: a genuinely competing legal
                            # reading of the illegal primary exists -> don't
                            # auto-apply this fallback; stop as 'ambiguous' so
                            # the user picks. Two triggers, in priority order:
                            #   1. A strictly-closer cross-sheet reading (15.B
                            #      'Rb4'@0.88 -> 'Rb8' (1 edit) beats fallback
                            #      'Rd8' (2 edits)) — the higher-confidence
                            #      sheet plainly meant its own closer move.
                            #   2. The pawn-move version (phantom piece letter,
                            #      4.W 'Ne3' -> 'e3' vs fallback 'Nf3', both 1
                            #      edit) — equal distance, so it isn't caught by
                            #      (1), but a sheet read the pawn push and it is
                            #      legal, so the reading is ambiguous.
                            ambiguous_alt = None
                            if (nearest_legal_san is not None
                                    and nearest_legal_changes < count_changes(san, canon_san)
                                    and nearest_legal_san != canon_san):
                                ambiguous_alt = nearest_legal_san
                            elif pawn_legal_san is not None and pawn_legal_san != canon_san:
                                ambiguous_alt = pawn_legal_san
                            if ambiguous_alt is not None:
                                print(f"  [DUAL DISAGREE] ply {i}: '{san}' illegal; "
                                      f"competing legal reading '{ambiguous_alt}' vs "
                                      f"fallback '{canon_san}' — surfacing as ambiguous")
                                stuck_at = i
                                stuck_move = ambiguous_alt
                                stuck_reason = 'ambiguous'
                                stuck_explanation = (
                                    f"Two readings: '{ambiguous_alt}' vs "
                                    f"'{canon_san}' (OCR read '{san}')")
                                validated.append({'ply': i, 'san': ambiguous_alt,
                                                  'status': 'error', 'original': san,
                                                  'forced_stop': True})
                                move = parsed  # non-None: signals "handled" below
                                break
                            print(f"  [DUAL FALLBACK] ply {i}: '{san}' illegal, using high-conf alt '{alt_move}' ({alt_conf:.0%}) -> canon '{canon_san}'")
                            board.push(parsed)
                            should_stop, ead_reason, ead_info = check_ead_after_move(i, parsed, canon_san)
                            if should_stop:
                                stuck_at = i
                                stuck_move = canon_san
                                stuck_reason = ead_reason
                                stuck_explanation = ead_info
                                stuck_from_square = chess.square_name(parsed.from_square)
                                stuck_to_square = chess.square_name(parsed.to_square)
                                validated.append({'ply': i, 'san': canon_san, 'status': 'warning',
                                                'warning': ead_info, 'original': san})
                                break
                            validated.append({
                                'ply': i, 'san': canon_san, 'status': 'ok',
                                'original': san,
                                'ocr_alt_applied': True,
                                'ocr_alt_confidence': alt_conf,
                                'ocr_alt_count': 1,
                                'dual_fallback': True
                            })
                            move = parsed  # Signal that we found a move
                            break  # Use first legal >50% candidate
                        except (ValueError, chess.InvalidMoveError, chess.IllegalMoveError):
                            pass
            if move is not None:
                if stuck_at is not None:
                    break  # EAD stopped us
                continue  # Move was played, proceed to next ply

            # Step 1: Try with max_changes=1 (safe auto-apply for non-semantic changes)
            move = try_move(board, san, max_changes=1,
                           piece_confusions=piece_confusions,
                           piece_file_confusions=piece_file_confusions)

            if move is None:
                # Step 2: Check OCR alternatives (only auto-apply if ocr_autofix is on)
                if ocr_autofix and i < len(ocr_data) and ocr_data[i].get('alternatives'):
                    alternatives = ocr_data[i]['alternatives']
                    valid_alts = []
                    for alt in alternatives:
                        normalized = normalize_candidate(alt)
                        if not normalized:
                            continue
                        alt_move, alt_conf = normalized
                        try:
                            parsed = board.parse_san(alt_move)
                            if alt_conf < OCR_ALT_MIN_CONFIDENCE:
                                continue
                            # Reject phantom notation (e.g., "Rd7+" when not check).
                            if not _is_valid_move_notation(alt_move, parsed, board):
                                continue
                            # Reject alts that represent a semantic change vs the primary
                            # (piece swap, removing +/#/x) — those need user confirmation.
                            if get_semantic_changes(san, alt_move):
                                continue
                            if is_move_absurd(board, parsed):
                                continue
                            valid_alts.append((alt_move, alt_conf, parsed))
                        except:
                            pass

                    # One-or-nothing: only auto-apply if exactly ONE legal alt
                    if len(valid_alts) == 1:
                        best_alt, best_conf, best_move = valid_alts[0]

                        # Two-change correction needs user confirmation, even
                        # when reached via the OCR-alt path. Without this gate
                        # the OCR-alt path silently applied any single legal
                        # alt regardless of character distance, so e.g. a
                        # Kf3 → Kg1 alt (file+rank, 2 changes) sneaked through
                        # without surfacing as a pending confirmation. Mirror
                        # Step 3's gating: ≥2 changes → pending_confirmation.
                        # Semantic swaps (piece change, removed +/#/x) are
                        # already filtered upstream by get_semantic_changes.
                        corrected_san = board.san(best_move)
                        num_changes = count_changes(san, corrected_san)
                        if num_changes >= 2:
                            absurd_warning = describe_suggested_move_warning(board, best_move)
                            pending_confirmation = {
                                'ply': i,
                                'original': san,
                                'suggested': corrected_san,
                                'num_changes': num_changes,
                                'semantic_reasons': [],
                                'absurd_warning': absurd_warning,
                            }
                            raise ValueError(f"Needs confirmation: {san} -> {corrected_san}")

                        board.push(best_move)

                        # Store canonical SAN (corrected_san = board.san(best_move),
                        # already computed above for the num_changes gate). Mirrors
                        # the DUAL FALLBACK fix: an OCR alt like "Rbc8" canonicalizes
                        # to "Rc8" and the frontend (chess.js 0.12.0) can only replay
                        # canonical SAN.
                        should_stop, ead_reason, ead_info = check_ead_after_move(i, best_move, corrected_san)
                        if should_stop:
                            stuck_at = i
                            stuck_move = corrected_san
                            stuck_reason = ead_reason
                            stuck_explanation = ead_info
                            stuck_from_square = chess.square_name(best_move.from_square)
                            stuck_to_square = chess.square_name(best_move.to_square)
                            validated.append({'ply': i, 'san': corrected_san, 'status': 'warning',
                                            'warning': ead_info, 'original': san})
                            break

                        validated.append({
                            'ply': i,
                            'san': corrected_san,
                            'status': 'ok',
                            'original': san,
                            'ocr_alt_applied': True,
                            'ocr_alt_confidence': best_conf,
                            'ocr_alt_count': len(valid_alts)
                        })
                        continue

                # Step 3: Try with more changes
                move = try_move(board, san, max_changes=max_changes,
                               piece_confusions=piece_confusions,
                               piece_file_confusions=piece_file_confusions)

                if move is not None:
                    corrected_san = board.san(move)
                    num_changes = count_changes(san, corrected_san)
                    semantic_reasons = get_semantic_changes(san, corrected_san)

                    # Require confirmation if:
                    # - similarity_autofix OFF: ALL corrections
                    # - similarity_autofix ON: 2+ changes OR any semantic changes
                    # Exception: forced K/R substitution (no rooks left) always auto-applies
                    if (not similarity_autofix or num_changes >= 2 or semantic_reasons) and \
                       not is_forced_piece_substitution(board, san, corrected_san):
                        absurd_warning = describe_suggested_move_warning(board, move)
                        pending_confirmation = {
                            'ply': i,
                            'original': san,
                            'suggested': corrected_san,
                            'num_changes': num_changes,
                            'semantic_reasons': semantic_reasons,
                            'absurd_warning': absurd_warning,
                        }
                        raise ValueError(f"Needs confirmation: {san} -> {corrected_san}")
                    else:
                        # Safe 1-change correction (no semantic changes, similarity_autofix on)
                        board.push(move)
                        should_stop, ead_reason, ead_info = check_ead_after_move(i, move, corrected_san)
                        if should_stop:
                            stuck_at = i
                            stuck_move = corrected_san
                            stuck_reason = ead_reason
                            stuck_explanation = ead_info
                            stuck_from_square = chess.square_name(move.from_square)
                            stuck_to_square = chess.square_name(move.to_square)
                            validated.append({'ply': i, 'san': corrected_san, 'status': 'warning',
                                            'warning': ead_info, 'original': san})
                            break
                        validated.append({'ply': i, 'san': corrected_san, 'status': 'ok', 'original': san})
                        continue
                else:
                    raise ValueError(f"Illegal: {san}")

            # max_changes=1 succeeded - check for semantic changes
            corrected_san = board.san(move)

            # Unnecessary-but-correct disambiguation (e.g. "Nge2" canonicalizes
            # to "Ne2" when Nc3 is pinned) is a notation-only normalization,
            # not a substitution. Skip the confirmation flow entirely and
            # suppress the ⚡ "auto-corrected" indicator on the move list —
            # many PGN tools emit redundant disambig and flagging every one
            # as needing review is noise. The user typed valid SAN; there is
            # literally no semantic correction happening, just python-chess's
            # minimal-SAN preference. Same suppression that similarity_autofix=on
            # already does for clean 1-change diffs, but unconditional here
            # because this isn't a substitution at all.
            is_only_disambig_cleanup = (
                san != corrected_san and
                san.rstrip('+#') != corrected_san.rstrip('+#') and
                not get_semantic_changes(san, corrected_san) and
                _disambig_consistent_with_move(san, move)
            )

            # Inferred capture: the player omitted the 'x' and we added it
            # (e.g. "Nb5" -> "Nxb5" because b5 is occupied). When b5 is
            # occupied there is no non-capturing reading, so adding 'x' is
            # normally safe notation cleanup — handwritten scoresheets omit
            # 'x' constantly — and falls through is_only_disambig_cleanup
            # silently. But because WE inferred a capture the player never
            # marked, a material LOSS is evidence the OCR/inference is wrong:
            # surface it for review instead of committing it silently.
            #
            # Tighter SEE threshold than the explicit-capture EAD gate
            # (loss >= 1 here vs loss >= 2 in check_ead_after_move): if the
            # player HAD written "Nxb5" we'd trust their intent and only flag
            # a >=2 loss, but an UNMARKED capture that even slightly loses
            # material is suspect. Clean/winning/equal inferred captures
            # (loss <= 0) stay silent — the common, safe case. SEE-backed, so
            # this stays within the "no chess-quality signals" rule.
            if (use_ead and 'x' not in san and board.is_capture(move)
                    and i not in approved_plies):
                is_forced = board.is_check() and len(list(board.legal_moves)) == 1
                is_bad, loss, explanation = is_bad_trade_move(board, move, threshold=1)
                if is_bad and not is_forced:
                    print(f"  [CONFIRM] ply {i}: inferred capture '{san}' -> "
                          f"'{corrected_san}' loses {loss}: {explanation}")
                    pending_confirmation = {
                        'ply': i,
                        'original': san,
                        'suggested': corrected_san,
                        'num_changes': count_changes(san, corrected_san),
                        'semantic_reasons': ['inferred capture (added x) loses material'],
                        'absurd_warning': f"Inferred capture loses material: {explanation}",
                    }
                    raise ValueError(f"Needs confirmation: {san} -> {corrected_san}")

            if san != corrected_san and not is_only_disambig_cleanup:
                # Always auto-apply if only difference is check/checkmate symbols (+/#)
                # These are pure notation corrections, not semantic changes
                if san.rstrip('+#') != corrected_san.rstrip('+#'):
                    semantic_reasons = get_semantic_changes(san, corrected_san)
                    if (not similarity_autofix or semantic_reasons) and \
                       not is_forced_piece_substitution(board, san, corrected_san):
                        # When similarity_autofix is off, ALL corrections require confirmation
                        # When on, only semantic changes require confirmation
                        # Exception: forced K/R substitution (no rooks left) always auto-applies
                        reasons = semantic_reasons or []
                        if not similarity_autofix and not reasons:
                            reasons = [f"similarity autofix disabled"]
                        print(f"  [CONFIRM] ply {i}: '{san}' -> '{corrected_san}' requires confirmation: {reasons}")
                        absurd_warning = describe_suggested_move_warning(board, move)
                        pending_confirmation = {
                            'ply': i,
                            'original': san,
                            'suggested': corrected_san,
                            'num_changes': count_changes(san, corrected_san),
                            'semantic_reasons': semantic_reasons,
                            'absurd_warning': absurd_warning,
                        }
                        raise ValueError(f"Needs confirmation: {san} -> {corrected_san}")

            board.push(move)

            # Pass original=None for disambig-only cleanup so the frontend
            # doesn't render a ⚡ "auto-corrected from Nge2" indicator. The
            # canonical SAN ("Ne2") is what gets stored; the input SAN was
            # just a redundantly-disambiguated representation of the same
            # move and there's nothing to surface to the user.
            _orig_for_validated = None if is_only_disambig_cleanup else (san if san != corrected_san else None)

            should_stop, ead_reason, ead_info = check_ead_after_move(i, move, corrected_san)
            if should_stop:
                stuck_at = i
                stuck_move = corrected_san
                stuck_reason = ead_reason
                stuck_explanation = ead_info
                stuck_from_square = chess.square_name(move.from_square)
                stuck_to_square = chess.square_name(move.to_square)
                validated.append({'ply': i, 'san': corrected_san, 'status': 'warning',
                                'warning': ead_info, 'original': _orig_for_validated})
                break

            validated.append({'ply': i, 'san': corrected_san, 'status': 'ok',
                            'original': _orig_for_validated})

            # Position is checkmate but the scoresheet has more moves.
            #
            # Two very different situations look the same here:
            #   - ONE trailing token  -> genuine noise (a stray mark, or the
            #     "1-0"/result digit OCR'd as a move). Trim it; the game really
            #     did end in mate.
            #   - TWO OR MORE trailing moves -> the players physically kept
            #     recording moves, so the game did NOT end. This "mate" is a
            #     reconstruction error UPSTREAM (e.g. 24.Qh6# is only mate
            #     because 23...Rc8 should have been 23...Qc8, which keeps e8
            #     open for the king). Silently trimming hides the error and the
            #     board freezes at a phantom mate. Instead, get stuck on the
            #     move that can't be played and let the backtracker search the
            #     earlier plies for the correction that un-mates the position.
            #
            # This is a reconstruction-plausibility signal ("the game provably
            # continued"), NOT a chess-quality judgement, so it belongs here.
            if board.is_checkmate() and i + 1 < len(moves):
                remaining = len(moves) - i - 1
                if remaining <= 1:
                    print(f"[VALIDATE] Checkmate after ply {i} - trimming {remaining} trailing move(s) as noise")
                    break
                # Spurious mate: stick on the next (unplayable) move so the
                # backtracker runs from there back through the earlier plies.
                stuck_at = i + 1
                stuck_move = moves[i + 1]
                stuck_reason = "premature_mate"
                stuck_explanation = (
                    f"{corrected_san} is checkmate, but {remaining} more moves were "
                    f"recorded after it. The game continued, so this mate is likely a "
                    f"reconstruction error in an earlier move - the engine should "
                    f"backtrack to find the correction that keeps the game going."
                )
                print(f"[VALIDATE] Premature mate at ply {i} ({corrected_san}) "
                      f"with {remaining} moves still recorded - stuck at ply {i + 1}")
                validated.append({'ply': i + 1, 'san': moves[i + 1], 'status': 'error',
                                  'error': stuck_explanation})
                break

        except Exception as e:
            stuck_at = i
            stuck_move = san
            if stuck_reason is None:
                stuck_reason = "illegal"
            error_msg = str(e)
            stuck_explanation = error_msg
            validated.append({'ply': i, 'san': san, 'status': 'error', 'error': error_msg})
            break

    # Infer stuck move squares for arrow display (only if not already known from EAD stops)
    if stuck_at is not None and stuck_move and stuck_from_square is None:
        try:
            stuck_from_square, stuck_to_square = infer_move_squares(board, stuck_move, is_legal=False)
        except Exception:
            # Fallback: just extract destination square
            clean = stuck_move.replace('+', '').replace('#', '').replace('x', '')
            for idx in range(len(clean) - 1, 0, -1):
                if clean[idx-1] in 'abcdefgh' and clean[idx] in '12345678':
                    stuck_to_square = clean[idx-1:idx+1]
                    break

    result = {
        'valid': stuck_at is None,
        'moves': validated,
        'stuck_at': stuck_at,
        'stuck_move': stuck_move,
        'stuck_reason': stuck_reason,
        'stuck_explanation': stuck_explanation,
        'stuck_from_square': stuck_from_square,
        'stuck_to_square': stuck_to_square,
        'final_fen': board.fen(),
        'legal_moves': sorted([board.san(m) for m in board.legal_moves]) if stuck_at is not None else [],
        'is_checkmate': board.is_checkmate(),
    }

    if pending_confirmation:
        result['pending_confirmation'] = pending_confirmation

    return result
