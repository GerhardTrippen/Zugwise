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
    piece_value, _is_valid_move_notation
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
    """
    if not original_san or not corrected_san:
        return False
    orig_piece = original_san[0] if original_san[0] in 'KQRBN' else None
    corr_piece = corrected_san[0] if corrected_san[0] in 'KQRBN' else None
    if not orig_piece or not corr_piece:
        return False
    if set([orig_piece, corr_piece]) != set(['K', 'R']):
        return False  # Only K<->R
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
                # Top move is illegal — check for high-confidence alternatives
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
                            # Legal and not absurd — play it
                            print(f"  [DUAL FALLBACK] ply {i}: '{san}' illegal, using high-conf alt '{alt_move}' ({alt_conf:.0%})")
                            board.push(parsed)
                            should_stop, ead_reason, ead_info = check_ead_after_move(i, parsed, alt_move)
                            if should_stop:
                                stuck_at = i
                                stuck_move = alt_move
                                stuck_reason = ead_reason
                                stuck_explanation = ead_info
                                stuck_from_square = chess.square_name(parsed.from_square)
                                stuck_to_square = chess.square_name(parsed.to_square)
                                validated.append({'ply': i, 'san': alt_move, 'status': 'warning',
                                                'warning': ead_info, 'original': san})
                                break
                            validated.append({
                                'ply': i, 'san': alt_move, 'status': 'ok',
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

                        should_stop, ead_reason, ead_info = check_ead_after_move(i, best_move, best_alt)
                        if should_stop:
                            stuck_at = i
                            stuck_move = best_alt
                            stuck_reason = ead_reason
                            stuck_explanation = ead_info
                            stuck_from_square = chess.square_name(best_move.from_square)
                            stuck_to_square = chess.square_name(best_move.to_square)
                            validated.append({'ply': i, 'san': best_alt, 'status': 'warning',
                                            'warning': ead_info, 'original': san})
                            break

                        validated.append({
                            'ply': i,
                            'san': best_alt,
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

            if san != corrected_san:
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

            should_stop, ead_reason, ead_info = check_ead_after_move(i, move, corrected_san)
            if should_stop:
                stuck_at = i
                stuck_move = corrected_san
                stuck_reason = ead_reason
                stuck_explanation = ead_info
                stuck_from_square = chess.square_name(move.from_square)
                stuck_to_square = chess.square_name(move.to_square)
                validated.append({'ply': i, 'san': corrected_san, 'status': 'warning',
                                'warning': ead_info, 'original': san if san != corrected_san else None})
                break

            validated.append({'ply': i, 'san': corrected_san, 'status': 'ok',
                            'original': san if san != corrected_san else None})

            # If position is checkmate, game is over - remaining moves are noise
            if board.is_checkmate() and i + 1 < len(moves):
                print(f"[VALIDATE] Checkmate after ply {i} - trimming {len(moves) - i - 1} remaining moves")
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
