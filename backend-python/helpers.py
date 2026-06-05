"""
Score2PGN - Helper Functions
============================
Basic utilities for chess move handling and conversion.
"""

import chess
import re
from typing import List, Tuple, Optional, Dict
from data_structures import OCRMove

# =============================================================================
# CONSTANTS
# =============================================================================

# Use piece_type integers as keys (same as chess_quiescence.py and absurdity.py)
# This avoids shadowing issues when all modules share global namespace in Pyodide
PIECE_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
PIECE_NAMES = {'P': 'Pawn', 'N': 'Knight', 'B': 'Bishop', 'R': 'Rook', 'Q': 'Queen', 'K': 'King'}

# Piece confusion pairs - common handwriting confusions
# NOTE: These are the DEFAULT confusions. The actual confusions used are
# controlled by user settings passed to auto_correct_piece_confusion().
PIECE_CONFUSIONS_DEFAULT = [
    ('R', 'K'), ('K', 'R'),  # Rook / King - very common!
    ('B', 'R'), ('R', 'B'),  # Bishop / Rook
    ('N', 'K'), ('K', 'N'),  # Knight / King
    # B↔N removed - these letters look very different in handwriting
]

# Piece letter <-> file letter confusions (for captures only)
# E.g., "Kxg4" (King capture) vs "hxg4" (h-file pawn capture)
PIECE_FILE_CONFUSIONS = [
    ('K', 'h'), ('h', 'K'),  # King vs h-file pawn
    ('B', 'b'), ('b', 'B'),  # Bishop vs b-file pawn
]

# =============================================================================
# PIECE UTILITIES
# =============================================================================

def piece_value(piece: chess.Piece) -> int:
    """Get the material value of a piece."""
    return PIECE_VALUES.get(piece.piece_type, 0)

def piece_name(symbol: str) -> str:
    """Get the human-readable name of a piece from its symbol."""
    return PIECE_NAMES.get(symbol.upper(), symbol)

# =============================================================================
# PLY/MOVE UTILITIES
# =============================================================================

def ply_to_str(ply: int) -> str:
    """Convert ply number to human-readable format (e.g., '5.W' or '5.B')."""
    return f"{ply // 2 + 1}.{'W' if ply % 2 == 0 else 'B'}"

def parse_pgn(pgn: str) -> List[str]:
    """Parse a PGN string into a list of SAN moves."""
    cleaned = re.sub(r'\d+\.+\s*', ' ', pgn)
    cleaned = re.sub(r'(1-0|0-1|1/2-1/2|\*)', '', cleaned)
    return [m.strip() for m in cleaned.split() if m.strip()]

# =============================================================================
# AUTO-FIX SAFETY CONSTRAINT: "ONE OR NOTHING"
# =============================================================================
#
# ██████████████████████████████████████████████████████████████████████████████
# ██                                                                          ██
# ██   CRITICAL: Auto-fix ONLY applies when EXACTLY ONE correction is legal   ██
# ██                                                                          ██
# ██   - ZERO legal corrections  →  return None (fall back to deep search)    ██
# ██   - ONE legal correction    →  return it (safe to auto-apply)            ██
# ██   - MULTIPLE legal          →  return None (too ambiguous!)              ██
# ██                                                                          ██
# ██████████████████████████████████████████████████████████████████████████████
#
# WHY: If OCR reads "d4" (illegal), many moves might be legal:
#      a4 (1 change), b4 (1 change), h4 (1 change), Qd3 (2 changes)...
#
#      Picking "a4" because it's fewest changes would be WRONG.
#      Only deep backtracking can find that "Qd3" is correct.
#
# CONTRAST: If OCR reads "Rd1" (illegal), maybe only "Kd1" is legal.
#           Here auto-fix is safe - no ambiguity exists.
#
# NEVER weaken this constraint! NEVER show "multiple auto-fix candidates"!
# The "one or nothing" rule is what makes auto-fix reliable.
#
# =============================================================================

# =============================================================================
# AUTO-CORRECTION HELPERS
# =============================================================================

def _add_capture_x(move: str) -> Optional[str]:
    """Add 'x' to a move string. E.g., Bd4 -> Bxd4, ed4 -> exd4"""
    if not move or len(move) < 2:
        return None

    # Piece moves: Bd4 -> Bxd4
    if move[0] in 'KQRBN':
        for i in range(1, len(move)):
            if move[i] in 'abcdefgh':
                return move[:i] + 'x' + move[i:]
        return move[0] + 'x' + move[1:]

    # Pawn captures: ed4 -> exd4
    elif move[0] in 'abcdefgh':
        if len(move) >= 3 and move[1] in 'abcdefgh':
            return move[0] + 'x' + move[1:]

    return None


def _is_valid_move_notation(san: str, move: chess.Move, board: chess.Board) -> bool:
    """
    Validate that move notation matches actual move properties.

    CRITICAL: python-chess ignores notation symbols that don't match reality!
    - "Bxc4" parses as "Bishop to c4" even if nothing is on c4 (phantom capture)
    - "Qb4+" parses as "Queen to b4" even if it doesn't give check (phantom check)
    - "Qb4#" parses as "Queen to b4" even if it's not checkmate (phantom mate)
    - "Rba1" parses successfully even if 'b' disambiguation is wrong/unnecessary

    This function rejects such phantom notation.

    Returns True if notation is consistent with move, False otherwise.
    """
    # If notation says capture ('x'), verify it's actually a capture
    if 'x' in san and not board.is_capture(move):
        return False

    # If notation says check ('+') or checkmate ('#'), verify by playing the move
    if '+' in san or '#' in san:
        # Make the move temporarily to check if it gives check/checkmate
        board.push(move)
        gives_check = board.is_check()
        is_checkmate = board.is_checkmate()
        board.pop()

        # Notation says check but move doesn't give check
        if ('+' in san or '#' in san) and not gives_check:
            return False

        # Notation says checkmate but it's not checkmate
        if '#' in san and not is_checkmate:
            return False

    # Compare against canonical SAN to catch wrong/phantom disambiguation
    # e.g., "Rba1" when the rook is on the a-file (not b).
    # Strip check/mate symbols since those are handled above.
    canonical = board.san(move).rstrip('+#')
    input_clean = san.rstrip('+#')
    if canonical != input_clean:
        # Tolerate "unnecessary but correct" disambiguation: many PGN tools
        # emit a file/rank disambiguator even when only one piece can legally
        # make the move (e.g. "Nge2" when Nc3 is pinned, so canonical is just
        # "Ne2"). The disambiguator is still meaningful — it just isn't
        # strictly required. Reject only when the disambiguator points at the
        # WRONG square (e.g. "Rba1" with rook on a-file).
        if not _disambig_consistent_with_move(input_clean, move):
            return False

    return True


def _disambig_consistent_with_move(san: str, move: chess.Move) -> bool:
    """Does the disambiguator in this piece-move SAN match move.from_square?

    Used by _is_valid_move_notation to distinguish "unnecessary but correct"
    disambiguation (accept) from "wrong/phantom" disambiguation (reject).
    Pawn moves are out of scope — they never carry an unnecessary
    disambiguator under standard SAN.
    """
    body = re.sub(r'=[QRBNqrbn]$', '', san)
    # Only piece moves (N/B/R/Q/K) have the unnecessary-disambig case.
    if not body or body[0] not in 'NBRQK':
        return False
    m = re.match(r'^[NBRQK]([a-h]?)([1-8]?)x?[a-h][1-8]$', body)
    if not m:
        return False
    disamb_file, disamb_rank = m.groups()
    if disamb_file and chess.square_file(move.from_square) != ord(disamb_file) - ord('a'):
        return False
    if disamb_rank and chess.square_rank(move.from_square) != int(disamb_rank) - 1:
        return False
    return True


def auto_correct_capture(san: str, board: chess.Board) -> Optional[str]:
    """
    Try to fix capture notation errors. Returns corrected move or None.

    - If "Bd4" is illegal but "Bxd4" is legal -> returns "Bxd4"
    - If "Bxd4" is illegal but "Bd4" is legal -> returns "Bd4"
    """
    if not san:
        return None

    # Try adding 'x' if missing
    if 'x' not in san:
        capture_variant = _add_capture_x(san)
        if capture_variant:
            try:
                m = board.parse_san(capture_variant)
                if m in board.legal_moves:
                    # CRITICAL: Validate notation matches move (reject phantom captures)
                    if not _is_valid_move_notation(capture_variant, m, board):
                        pass  # Phantom capture - skip
                    else:
                        return capture_variant
            except:
                pass

    # Try removing 'x' if present (original has 'x' but it's not a capture)
    if 'x' in san:
        non_capture = san.replace('x', '')
        try:
            m = board.parse_san(non_capture)
            if m in board.legal_moves:
                return non_capture
        except:
            pass

    return None


def auto_correct_piece_confusion(san: str, board: chess.Board,
                                  enabled_confusions: List[Tuple[str, str]] = None) -> Optional[str]:
    """
    Try to fix piece letter confusion (R<->K, B<->R, etc.). Returns corrected move or None.
    Only returns a correction if exactly ONE alternative is legal.

    Args:
        san: Move in SAN notation
        board: Current board state
        enabled_confusions: List of (orig, replacement) pairs to try.
                           If None, uses PIECE_CONFUSIONS_DEFAULT.
    """
    if not san or len(san) < 2 or san[0] not in 'KQRBN':
        return None

    confusions = enabled_confusions if enabled_confusions is not None else PIECE_CONFUSIONS_DEFAULT
    first_char = san[0]
    legal_alternatives = []

    for orig, replacement in confusions:
        if first_char == orig:
            alt_move = replacement + san[1:]
            try:
                m = board.parse_san(alt_move)
                if m in board.legal_moves:
                    # CRITICAL: Validate notation matches move (reject phantom captures)
                    if not _is_valid_move_notation(alt_move, m, board):
                        continue  # Phantom capture - skip
                    legal_alternatives.append(alt_move)
            except:
                pass

    # CRITICAL: "One or Nothing" rule - only auto-fix if exactly ONE alternative
    # is legal. Multiple legal alternatives = ambiguous = must use deep search.
    # See CLAUDE.md for full explanation. DO NOT CHANGE THIS CONSTRAINT!
    if len(legal_alternatives) == 1:
        return legal_alternatives[0]

    # Multiple legal alternatives found - DO NOT auto-fix!
    # This is intentional, not a bug. Deep search will handle it.
    if len(legal_alternatives) > 1:
        print(f"  [AUTO-FIX] '{san}' has {len(legal_alternatives)} legal piece corrections - "
              f"too ambiguous, skipping auto-fix: {legal_alternatives[:5]}")

    return None


def auto_correct_piece_file_capture(san: str, board: chess.Board,
                                    enabled_confusions: List[Tuple[str, str]] = None) -> Optional[str]:
    """
    Try piece↔file correction for captures.

    Examples:
      - "Kxg4" illegal, "hxg4" legal -> return "hxg4" (K->h)
      - "Bxa3" illegal, "bxa3" legal -> return "bxa3" (B->b)
      - "bxc4" illegal, "Bxc4" legal -> return "Bxc4" (b->B)

    Only applies to moves containing 'x' (captures).
    Returns corrected move or None if no fix found.

    Args:
        san: Move in SAN notation
        board: Current board state
        enabled_confusions: List of (orig, replacement) pairs to try.
                           If None, uses PIECE_FILE_CONFUSIONS.
    """
    if not san or 'x' not in san or len(san) < 4:
        return None

    confusions = enabled_confusions if enabled_confusions is not None else PIECE_FILE_CONFUSIONS
    first_char = san[0]
    legal_alternatives = []

    for orig, replacement in confusions:
        if first_char == orig:
            alt_move = replacement + san[1:]
            try:
                m = board.parse_san(alt_move)
                if m in board.legal_moves:
                    # CRITICAL: Validate notation matches move (reject phantom captures)
                    # This is especially important here since all these moves have 'x'
                    if not _is_valid_move_notation(alt_move, m, board):
                        continue  # Phantom capture - skip
                    legal_alternatives.append(alt_move)
            except:
                pass

    # CRITICAL: "One or Nothing" rule - only auto-fix if exactly ONE alternative
    # is legal. Multiple legal alternatives = ambiguous = must use deep search.
    # See CLAUDE.md for full explanation. DO NOT CHANGE THIS CONSTRAINT!
    if len(legal_alternatives) == 1:
        return legal_alternatives[0]

    # Multiple legal alternatives found - DO NOT auto-fix!
    # This is intentional, not a bug. Deep search will handle it.
    if len(legal_alternatives) > 1:
        print(f"  [AUTO-FIX] '{san}' has {len(legal_alternatives)} legal piece-file corrections - "
              f"too ambiguous, skipping auto-fix: {legal_alternatives[:5]}")

    return None


def auto_correct_a_to_g(san: str, board: chess.Board) -> Optional[str]:
    """
    Try to fix a->g confusion (descender tail cut off). Returns corrected move or None.
    Only returns 'g' variant if 'a' is ILLEGAL and 'g' is legal.
    This is safe: we never change a legal move.
    """
    if not san or 'a' not in san:
        return None

    # SAFETY: First check if the original 'a' move is already legal
    try:
        m = board.parse_san(san)
        if m in board.legal_moves:
            return None  # Original is legal, don't "correct" it!
    except:
        pass  # Original is illegal, proceed with correction attempt

    # Replace last 'a' with 'g'
    last_a_idx = san.rfind('a')
    g_variant = san[:last_a_idx] + 'g' + san[last_a_idx + 1:]

    # Check if g variant is legal
    try:
        m = board.parse_san(g_variant)
        if m in board.legal_moves:
            # CRITICAL: Validate notation matches move (reject phantom captures)
            if not _is_valid_move_notation(g_variant, m, board):
                return None  # Phantom capture - skip
            return g_variant
    except:
        pass

    return None


# =============================================================================
# FILE CONFUSION PAIRS
# =============================================================================

FILE_CONFUSIONS = [
    ('a', 'g'), ('g', 'a'),  # Very common - descender issue
    ('a', 'd'), ('d', 'a'),
    ('b', 'd'), ('d', 'b'),
    ('e', 'c'), ('c', 'e'),
    ('b', 'h'), ('h', 'b'),
]

RANK_CONFUSIONS = [
    ('1', '7'), ('7', '1'),
    ('2', '7'), ('7', '2'),
    ('3', '8'), ('8', '3'),
    ('4', '5'), ('5', '4'),
    ('1', '4'), ('4', '1'),
    ('6', '8'), ('8', '6'),
]


# =============================================================================
# AUTO-FIX SAFETY FUNCTIONS
# =============================================================================

def extract_destination(san: str) -> Optional[str]:
    """Extract destination square from SAN move (e.g., 'Bxg4' -> 'g4')."""
    if not san:
        return None
    clean = san.rstrip('+#').replace('x', '')
    # Handle castling
    if clean in ('O-O', 'O-O-O', '0-0', '0-0-0'):
        return None
    # Find last file+rank pair
    for i in range(len(clean) - 1, 0, -1):
        if clean[i] in '12345678' and clean[i-1] in 'abcdefgh':
            return clean[i-1:i+1]
    # Pawn move like 'e4'
    if len(clean) >= 2 and clean[0] in 'abcdefgh' and clean[1] in '12345678':
        return clean[0:2]
    return None


def count_changes(original: str, corrected: str) -> int:
    """Count number of differences between original and corrected move."""
    changes = 0

    # Piece change
    orig_piece = original[0] if original and original[0] in 'KQRBN' else 'P'
    corr_piece = corrected[0] if corrected and corrected[0] in 'KQRBN' else 'P'
    if orig_piece != corr_piece:
        changes += 1

    # Destination
    orig_dest = extract_destination(original)
    corr_dest = extract_destination(corrected)
    if orig_dest and corr_dest:
        if orig_dest[0] != corr_dest[0]:  # File
            changes += 1
        if len(orig_dest) > 1 and len(corr_dest) > 1:
            if orig_dest[1] != corr_dest[1]:  # Rank
                changes += 1

    # Capture notation
    if ('x' in original) != ('x' in corrected):
        changes += 1

    # CHECK SYMBOL - removing/adding a + should count as a change!
    # These symbols are visually distinctive and OCR is usually reliable on them.
    # E.g., Qd2+ → Qxg2 = 3 changes (d→g, +removed, x added)
    #       Qd2+ → Qg3+ = 2 changes (d→g, 2→3) - preserves +, ranks higher!
    if ('+' in original) != ('+' in corrected):
        changes += 1

    # CHECKMATE SYMBOL - same logic for #
    if ('#' in original) != ('#' in corrected):
        changes += 1

    return changes


def get_semantic_changes(original: str, corrected: str) -> List[str]:
    """
    Detect semantic changes that should ALWAYS require user confirmation.

    These are changes that alter the meaning of the move, not just notation:
    - Removing check (+) - the move may actually give check
    - Removing checkmate (#) - the move may actually be checkmate
    - Removing capture (x) - the move may actually capture a piece
    - Changing piece type (B→R, Q→N, etc.) - completely different move

    EXCEPTION: Upgrading + to # (check to checkmate) is NOT semantic - it's
    just notation correction. The move itself is the same, python-chess knows
    if it's checkmate. This should be applied silently.

    Returns a list of reasons (empty if no semantic changes).
    """
    reasons = []

    # SPECIAL CASE: + in original replaced by # in corrected = checkmate upgrade
    # This is NOT a semantic change - the move is the same, notation is corrected
    check_upgraded_to_mate = ('+' in original and '+' not in corrected and '#' in corrected)

    # Check symbol removed (+ was in original but not in corrected)
    # UNLESS it was upgraded to checkmate (#)
    if '+' in original and '+' not in corrected and not check_upgraded_to_mate:
        reasons.append('removes check (+)')

    # Checkmate symbol removed (# was in original but not in corrected)
    if '#' in original and '#' not in corrected:
        reasons.append('removes checkmate (#)')

    # Capture symbol removed (x was in original but not in corrected)
    if 'x' in original and 'x' not in corrected:
        reasons.append('removes capture (x)')

    # Piece type changed
    orig_piece = original[0] if original and original[0] in 'KQRBN' else None
    corr_piece = corrected[0] if corrected and corrected[0] in 'KQRBN' else None
    if orig_piece and corr_piece and orig_piece != corr_piece:
        reasons.append(f'changes piece ({orig_piece}→{corr_piece})')

    return reasons


def has_semantic_changes(original: str, corrected: str) -> bool:
    """Check if correction has any semantic changes requiring confirmation."""
    return len(get_semantic_changes(original, corrected)) > 0


def is_safe_auto_correction(original: str, corrected: str, max_changes: int = 2) -> bool:
    """
    Check if correction is safe:
    - Never change both file AND rank (would change destination entirely)
    - Respect max_changes setting
    """
    orig_dest = extract_destination(original)
    corr_dest = extract_destination(corrected)

    if not orig_dest or not corr_dest or len(orig_dest) < 2 or len(corr_dest) < 2:
        # Can't determine safety - allow but use max_changes check
        num_changes = count_changes(original, corrected)
        return num_changes <= max_changes

    orig_file, orig_rank = orig_dest[0], orig_dest[1]
    corr_file, corr_rank = corr_dest[0], corr_dest[1]

    file_changed = (orig_file != corr_file)
    rank_changed = (orig_rank != corr_rank)

    # CRITICAL: Never allow both file AND rank to change
    if file_changed and rank_changed:
        return False

    # Also check max changes
    num_changes = count_changes(original, corrected)
    return num_changes <= max_changes


def auto_correct_combined(san: str, board: chess.Board, max_changes: int = 2) -> Optional[Tuple[str, str, int]]:
    """
    Try combined fixes: piece + file, piece + rank, file + rank.
    Only returns a fix if exactly ONE safe legal variant is found.

    Returns (corrected_san, description, num_changes) or None.
    """
    if not san or len(san) < 2:
        return None

    all_variants = []

    # Generate piece variants
    piece_variants = []
    if san[0] in 'KQRBN':
        for orig, repl in PIECE_CONFUSIONS_DEFAULT:
            if san[0] == orig:
                piece_variants.append((repl + san[1:], f"{orig}->{repl}"))

    # Generate file variants
    file_variants = []
    for i, c in enumerate(san):
        if c in 'abcdefgh':
            for orig, repl in FILE_CONFUSIONS:
                if c == orig:
                    variant = san[:i] + repl + san[i+1:]
                    file_variants.append((variant, f"{orig}->{repl}"))

    # Generate rank variants
    rank_variants = []
    for i, c in enumerate(san):
        if c in '12345678':
            for orig, repl in RANK_CONFUSIONS:
                if c == orig:
                    variant = san[:i] + repl + san[i+1:]
                    rank_variants.append((variant, f"{orig}->{repl}"))

    # Try COMBINED fixes (piece + file) - SAFE: doesn't change both file AND rank
    for pv, p_desc in piece_variants:
        for i, c in enumerate(pv):
            if c in 'abcdefgh':
                for orig, repl in FILE_CONFUSIONS:
                    if c == orig:
                        combined = pv[:i] + repl + pv[i+1:]
                        all_variants.append((combined, f"{p_desc} + {orig}->{repl}"))

    # Try COMBINED fixes (piece + rank) - SAFE: doesn't change both file AND rank
    for pv, p_desc in piece_variants:
        for i, c in enumerate(pv):
            if c in '12345678':
                for orig, repl in RANK_CONFUSIONS:
                    if c == orig:
                        combined = pv[:i] + repl + pv[i+1:]
                        all_variants.append((combined, f"{p_desc} + {orig}->{repl}"))

    # NOTE: We skip file + rank combined - it's NOT SAFE (changes destination entirely)

    # Filter variants by safety rules and legality
    safe_legal_variants = []
    for (variant, desc) in all_variants:
        # Safety check: no file+rank both changing, respect max_changes
        if not is_safe_auto_correction(san, variant, max_changes):
            continue

        # Legality check
        try:
            m = board.parse_san(variant)
            if m in board.legal_moves:
                # CRITICAL: Validate notation matches move (reject phantom captures)
                if not _is_valid_move_notation(variant, m, board):
                    continue  # Phantom capture - skip
                num_changes = count_changes(san, variant)
                safe_legal_variants.append((variant, desc, num_changes))
        except:
            pass

    # CRITICAL: "One or Nothing" rule - only auto-fix if exactly ONE alternative
    # is legal. Multiple legal alternatives = ambiguous = must use deep search.
    # See CLAUDE.md for full explanation. DO NOT CHANGE THIS CONSTRAINT!
    if len(safe_legal_variants) == 1:
        return safe_legal_variants[0]

    # Multiple legal alternatives found - DO NOT auto-fix!
    # This is intentional, not a bug. Deep search will handle it.
    if len(safe_legal_variants) > 1:
        display_variants = [v[0] for v in safe_legal_variants[:5]]
        print(f"  [AUTO-FIX] '{san}' has {len(safe_legal_variants)} legal combined corrections - "
              f"too ambiguous, skipping auto-fix: {display_variants}")

    return None


def _auto_correct_disambiguation(san: str, board: chess.Board) -> Optional[Tuple[str, str, int]]:
    """
    Try inserting a file/rank disambiguator into an ambiguous piece move.
    Called only when board.parse_san() raised AmbiguousMoveError.

    E.g., "Rd1" with two rooks on c1 and e1 → tries "Rad1".."Rhd1", "R1d1".."R8d1".
    Applies "One or Nothing": returns (corrected, desc, 1) if exactly one is legal,
    None if zero or two-or-more legal options exist.
    """
    if not san or len(san) < 2 or san[0] not in 'KQRBN':
        return None

    suffix = ''
    clean = san
    if clean.endswith(('+', '#')):
        suffix = clean[-1]
        clean = clean[:-1]

    piece = clean[0]
    rest = clean[1:]  # e.g. 'd1', 'xd1', 'd1=Q'

    legal_variants = []
    for disambig in 'abcdefgh12345678':
        variant = piece + disambig + rest + suffix
        try:
            m = board.parse_san(variant)
            if m in board.legal_moves and _is_valid_move_notation(variant, m, board):
                legal_variants.append((variant, f'disambig +{disambig}', 1))
        except Exception:
            pass

    if len(legal_variants) == 1:
        return legal_variants[0]

    if len(legal_variants) > 1:
        print(f"  [DISAMBIG] '{san}' still ambiguous: {[v[0] for v in legal_variants]}")

    return None


def legal_san_disambiguations(board: chess.Board, san: str) -> List[str]:
    """Return the legal file/rank-disambiguated variants of an under-specified
    piece move.

    A move like "Nd7" with knights on b8 AND f6 is genuinely ambiguous: chess.js
    and python-chess both REFUSE to play it (AmbiguousMoveError), so the
    interactive validator and the board playback stop there. The search
    algorithms must stop too — they must NOT silently commit to one reading.

    Returns the list of legal variants (e.g. ['Nbd7', 'Nfd7']). An empty or
    length-1 result means the move is NOT genuinely ambiguous:
      - parses cleanly (already unambiguous / fully specified) -> []
      - exactly one legal disambiguation -> [that variant]  (the normal fix path
        auto-applies it; "One or Nothing" — no review needed)
      - >= 2 legal disambiguations -> the genuine-ambiguity case.
    Mirrors the variant enumeration in ``_auto_correct_disambiguation``.
    """
    if not san or len(san) < 2 or san[0] not in 'KQRBN':
        return []
    try:
        board.parse_san(san)
        return []  # parses cleanly — not ambiguous
    except chess.AmbiguousMoveError:
        pass
    except Exception:
        return []  # illegal for some other reason — not an ambiguity

    suffix = ''
    clean = san
    if clean.endswith(('+', '#')):
        suffix = clean[-1]
        clean = clean[:-1]
    piece = clean[0]
    rest = clean[1:]  # e.g. 'd7', 'xd7'

    variants: List[str] = []
    for disambig in 'abcdefgh12345678':
        variant = piece + disambig + rest + suffix
        try:
            m = board.parse_san(variant)
            if m in board.legal_moves and _is_valid_move_notation(variant, m, board):
                variants.append(variant)
        except Exception:
            pass
    return variants


# =============================================================================
# MOVE EXECUTION
# =============================================================================

def try_move(board: chess.Board, san: str, auto_correct: bool = True, max_changes: int = 2,
             piece_confusions: List[Tuple[str, str]] = None,
             piece_file_confusions: List[Tuple[str, str]] = None) -> Optional[chess.Move]:
    """
    Try to parse and validate a SAN move. Returns None if illegal.

    If auto_correct=True (default), tries these corrections before giving up:
    0. Disambiguation (if AmbiguousMoveError: insert file/rank disambiguator)
    1. A->G confusion (descender tail)
    2. Capture notation (add/remove 'x')
    3. Piece confusion (R<->K, B<->R, etc.)
    4. Piece-file capture confusion (K<->h, B<->b)
    5. Combined fixes (piece+file, piece+rank) - with safety limits

    Args:
        board: Current chess board state
        san: Move in SAN notation
        auto_correct: Whether to try auto-corrections
        max_changes: Maximum number of character changes allowed (default 2)
        piece_confusions: List of (orig, replacement) pairs for piece corrections.
                         If None, uses PIECE_CONFUSIONS_DEFAULT.
        piece_file_confusions: List of (orig, replacement) pairs for piece↔file corrections.
                              If None, uses PIECE_FILE_CONFUSIONS.
    """
    if not san:
        return None

    # First, try the move as-is
    _ambiguous = False
    try:
        m = board.parse_san(san)
        if m in board.legal_moves:
            # CRITICAL: Validate that notation matches reality (reject phantom captures/checks)
            if _is_valid_move_notation(san, m, board):
                return m
            # Notation doesn't match - fall through to auto-correct if enabled
    except chess.AmbiguousMoveError:
        _ambiguous = True
    except Exception:
        pass

    # If auto_correct is disabled, stop here
    if not auto_correct:
        return None

    # 0. Disambiguation: if the move is ambiguous (multiple pieces can reach that square),
    # try inserting a file/rank disambiguator. Either way, stop here — applying piece/file
    # corrections to an ambiguous move would suggest a completely different move.
    if _ambiguous:
        disambig_result = _auto_correct_disambiguation(san, board)
        if disambig_result:
            corrected, desc, _ = disambig_result
            print(f"  DISAMBIG: '{san}' -> '{corrected}' ({desc})")
            try:
                m = board.parse_san(corrected)
                if m in board.legal_moves:
                    return m
            except Exception:
                pass
        return None

    # Try auto-corrections in order of likelihood
    # Single-character fixes (always allowed - they are 1 change each)

    # 1. A->G confusion (very common - descender tail cut off)
    corrected = auto_correct_a_to_g(san, board)
    if corrected:
        try:
            m = board.parse_san(corrected)
            if m in board.legal_moves:
                final_san = board.san(m)
                final_changes = count_changes(san, final_san)
                if final_changes <= max_changes:
                    print(f"  A->G: '{san}' -> '{final_san}' ({final_changes} changes)")
                    return m
                else:
                    print(f"  A->G REJECTED: '{san}' -> '{final_san}' ({final_changes} changes > {max_changes})")
        except:
            pass

    # 2. Capture notation (add/remove 'x')
    corrected = auto_correct_capture(san, board)
    if corrected:
        try:
            m = board.parse_san(corrected)
            if m in board.legal_moves:
                final_san = board.san(m)
                final_changes = count_changes(san, final_san)
                if final_changes <= max_changes:
                    print(f"  CAPTURE: '{san}' -> '{final_san}' ({final_changes} changes)")
                    return m
                else:
                    print(f"  CAPTURE REJECTED: '{san}' -> '{final_san}' ({final_changes} changes > {max_changes})")
        except:
            pass

    # 3. Piece confusion (R<->K, B<->R, etc.)
    corrected = auto_correct_piece_confusion(san, board, enabled_confusions=piece_confusions)
    if corrected:
        try:
            m = board.parse_san(corrected)
            if m in board.legal_moves:
                final_san = board.san(m)
                final_changes = count_changes(san, final_san)
                if final_changes <= max_changes:
                    print(f"  PIECE-CONFUSION: '{san}' -> '{final_san}' ({final_changes} changes)")
                    return m
                else:
                    print(f"  PIECE-CONFUSION REJECTED: '{san}' -> '{final_san}' ({final_changes} changes > {max_changes})")
        except:
            pass

    # 4. Piece-file capture confusion (K<->h, B<->b for captures)
    corrected = auto_correct_piece_file_capture(san, board, enabled_confusions=piece_file_confusions)
    if corrected:
        try:
            m = board.parse_san(corrected)
            if m in board.legal_moves:
                final_san = board.san(m)
                final_changes = count_changes(san, final_san)
                if final_changes <= max_changes:
                    print(f"  PIECE-FILE: '{san}' -> '{final_san}' ({final_changes} changes)")
                    return m
                else:
                    print(f"  PIECE-FILE REJECTED: '{san}' -> '{final_san}' ({final_changes} changes > {max_changes})")
        except:
            pass

    # 5. Combined fixes (piece+file, piece+rank) - with safety checks and max_changes limit
    combined_result = auto_correct_combined(san, board, max_changes=max_changes)
    if combined_result:
        corrected, desc, num_changes = combined_result
        try:
            m = board.parse_san(corrected)
            if m in board.legal_moves:
                # CRITICAL: Check max_changes against the FINAL normalized SAN
                # (board.san() may drop 'x' if nothing to capture, changing the count)
                final_san = board.san(m)
                final_changes = count_changes(san, final_san)
                if final_changes > max_changes:
                    print(f"  COMBINED REJECTED: '{san}' -> '{final_san}' ({final_changes} changes > {max_changes})")
                else:
                    print(f"  COMBINED: '{san}' -> '{final_san}' ({desc}, {final_changes} changes)")
                    return m
        except:
            pass

    return None

def play_until_stuck(moves: List[str], board: chess.Board = None, start: int = 0,
                     auto_correct: bool = False, max_changes: int = 2,
                     piece_confusions: List[Tuple[str, str]] = None,
                     piece_file_confusions: List[Tuple[str, str]] = None) -> Tuple[int, chess.Board]:
    """
    Play moves until an illegal move is encountered.
    Returns (ply_reached, final_board_state).
    If all moves are legal, ply_reached == len(moves).

    Args:
        auto_correct: If False (default), moves must be exactly legal.
                      If True, allows auto-correction of OCR errors.
        max_changes: Maximum number of character changes allowed for auto-correction.
        piece_confusions: List of enabled piece confusion pairs for auto-correction.
        piece_file_confusions: List of enabled piece↔file confusion pairs.
    """
    b = board.copy() if board else chess.Board()
    for i in range(start, len(moves)):
        m = try_move(b, moves[i], auto_correct=auto_correct, max_changes=max_changes,
                     piece_confusions=piece_confusions, piece_file_confusions=piece_file_confusions)
        if not m:
            return i, b
        b.push(m)
    return len(moves), b


def canonicalize_played_moves(moves: List[str]) -> List[str]:
    """Return a copy of ``moves`` with each entry replaced by its canonical
    SAN (``board.san`` of the move parsed in the position before playing it).

    python-chess's ``parse_san`` silently accepts non-canonical forms like
    "Be5" for a capture whose canonical SAN is "Bxe5". chess.js v0.12.0
    (used by the frontend's navigation/board renderer) is strict and rejects
    these. When greedy/beam/dijkstra play through the OCR list with
    ``auto_correct=False``, the algorithm advances on "Be5" but
    ``state['moves']`` still holds the raw OCR; copying that into
    ``state.sans`` on the JS side leaves chess.js unable to replay the move,
    so the board freezes at the affected ply.

    Stops at the first move that doesn't parse legally; remaining entries
    are kept as-is (defensive: callers typically pass fully-played lists).
    """
    out = list(moves)
    board = chess.Board()
    for i, san in enumerate(moves):
        try:
            move = board.parse_san(san)
        except Exception:
            break
        if move not in board.legal_moves:
            break
        out[i] = board.san(move)
        board.push(move)
    return out


# =============================================================================
# NOISE DETECTION AND TRUNCATION
# =============================================================================

def detect_noise_start(ocr_moves: List[OCRMove]) -> Optional[int]:
    """
    Detect where real moves end and noise begins in OCR results.

    CONSERVATIVE: Only auto-truncate OBVIOUS noise that continues to the end.
    Don't cut if there's recovery (high-confidence moves after low-confidence).
    User can manually delete suspicious moves via the UI.

    Returns:
        Index of first noise move, or None if no noise detected
    """
    from collections import Counter

    if len(ocr_moves) < 4:
        return None  # Too short to have noise

    CONFIDENCE_THRESHOLD = 0.40    # Below this is suspicious (lowered for safety)
    MIN_CONSECUTIVE_LOW = 4        # 4+ low confidence in a row = noise (raised)
    REPETITION_WINDOW = 6
    REPETITION_THRESHOLD = 4

    n = len(ocr_moves)

    # Rule 1: Trailing low-confidence moves (must be at the very end)
    trailing_low_start = n
    for i in range(n - 1, -1, -1):
        if ocr_moves[i].top_confidence < CONFIDENCE_THRESHOLD:
            trailing_low_start = i
        else:
            break

    trailing_low_count = n - trailing_low_start
    if trailing_low_count >= MIN_CONSECUTIVE_LOW:
        print(f"  NOISE TRUNCATION: {trailing_low_count} trailing low-confidence moves from index {trailing_low_start}")
        return trailing_low_start

    # Rule 2: Repetitive moves at the end (same move 4+ times in last 6)
    if n >= REPETITION_WINDOW:
        last_moves = [m.top_move for m in ocr_moves[-REPETITION_WINDOW:]]
        counts = Counter(last_moves)
        most_common_move, most_common_count = counts.most_common(1)[0]

        if most_common_count >= REPETITION_THRESHOLD:
            for i in range(n - REPETITION_WINDOW, n):
                if ocr_moves[i].top_move == most_common_move:
                    print(f"  NOISE TRUNCATION: '{most_common_move}' repeated {most_common_count}x")
                    return i

    # Rule 3: Mixed garbage at the end - very low avg confidence in last few moves
    if n >= 4:
        last_4_avg = sum(m.top_confidence for m in ocr_moves[-4:]) / 4
        if last_4_avg < 0.35:
            cutoff = n
            for i in range(n - 1, max(0, n - 8), -1):
                if ocr_moves[i].top_confidence < 0.40:
                    cutoff = i
                else:
                    break
            if n - cutoff >= 3:
                print(f"  NOISE TRUNCATION: Low average confidence ({last_4_avg:.0%}) from index {cutoff}")
                return cutoff

    return None


def truncate_trailing_noise(ocr_moves: List[OCRMove]) -> List[OCRMove]:
    """
    Remove noise moves from the end of OCR results.
    """
    if not ocr_moves:
        return ocr_moves

    # Sort by ply first
    sorted_moves = sorted(ocr_moves, key=lambda x: x.ply)

    noise_start = detect_noise_start(sorted_moves)

    if noise_start is not None and noise_start < len(sorted_moves):
        real_moves = sorted_moves[:noise_start]
        noise_count = len(sorted_moves) - noise_start
        if noise_count > 0:
            print(f"  NOISE TRUNCATION: Keeping {len(real_moves)} moves, removing {noise_count} noise moves")
        return real_moves

    return sorted_moves


# =============================================================================
# OCR CONVERSION UTILITIES
# =============================================================================

def ocr_moves_to_list(ocr_moves: List[OCRMove], truncate_noise: bool = True) -> List[str]:
    """
    Convert OCRMove list to simple list of top move candidates.

    Args:
        ocr_moves: List of OCRMove objects
        truncate_noise: If True, remove trailing noise moves first
    """
    if not ocr_moves:
        return []

    # Truncate noise if requested
    if truncate_noise:
        ocr_moves = truncate_trailing_noise(ocr_moves)

    sorted_moves = sorted(ocr_moves, key=lambda x: x.ply)
    return [m.top_move for m in sorted_moves]

def create_ocr_lookup(ocr_moves: List[OCRMove]) -> Dict[int, OCRMove]:
    """Create a ply->OCRMove lookup dictionary."""
    return {m.ply: m for m in ocr_moves}

def moves_to_ocr_moves(moves: List[str]) -> List[OCRMove]:
    """Convert a simple move list to OCRMove objects with 100% confidence."""
    return [OCRMove(i // 2 + 1, 'w' if i % 2 == 0 else 'b', [(m, 1.0)]) for i, m in enumerate(moves)]


# =============================================================================
# MOVE SQUARE INFERENCE (for arrow display)
# =============================================================================

def infer_move_squares(board: chess.Board, san: str, is_legal: bool = True) -> Tuple[Optional[str], Optional[str]]:
    """
    Infer from_square and to_square for a move.
    For legal moves, use chess parsing.
    For illegal moves, make best guess based on piece locations.

    Returns (from_square, to_square) as strings like 'e2', 'e4' or (None, None).

    FIXED: For bishops, prefer pieces whose move would be "most diagonal".
    c8 to c3 is vertical (score=100), f8 to c3 is diagonal-ish (score=2).
    """
    if is_legal:
        try:
            move = board.parse_san(san)
            return chess.square_name(move.from_square), chess.square_name(move.to_square)
        except:
            pass

    # For illegal moves, try to infer
    clean = san.replace('+', '').replace('#', '')

    # Handle castling
    if clean.upper().replace('0', 'O') in ['O-O', 'OO', 'O-O-O', 'OOO']:
        rank = '1' if board.turn else '8'
        if 'O-O-O' in clean.upper() or '0-0-0' in clean:
            return 'e' + rank, 'c' + rank
        else:
            return 'e' + rank, 'g' + rank

    # Extract destination square (last 2 chars that look like a square)
    to_sq = None
    # Remove 'x' for parsing but remember if it was a capture
    is_capture = 'x' in clean
    clean_no_x = clean.replace('x', '')

    for i in range(len(clean_no_x) - 1, 0, -1):
        if clean_no_x[i-1] in 'abcdefgh' and clean_no_x[i] in '12345678':
            to_sq = clean_no_x[i-1:i+1]
            break

    if not to_sq:
        return None, None

    # Determine piece type
    piece_char = clean_no_x[0] if clean_no_x and clean_no_x[0] in 'KQRBN' else 'P'
    piece_type = {'K': chess.KING, 'Q': chess.QUEEN, 'R': chess.ROOK,
                  'B': chess.BISHOP, 'N': chess.KNIGHT, 'P': chess.PAWN}.get(piece_char, chess.PAWN)

    # Find pieces of this type that belong to the side to move
    color = board.turn
    candidates = []

    to_file_idx = ord(to_sq[0]) - ord('a')
    to_rank_idx = int(to_sq[1]) - 1

    # SPECIAL HANDLING FOR BISHOPS: score by "diagonalness"
    if piece_type == chess.BISHOP:
        bishop_candidates = []
        for square in chess.SQUARES:
            piece = board.piece_at(square)
            if piece and piece.piece_type == chess.BISHOP and piece.color == color:
                sq_name = chess.square_name(square)
                from_file_idx = ord(sq_name[0]) - ord('a')
                from_rank_idx = int(sq_name[1]) - 1

                file_diff = abs(to_file_idx - from_file_idx)
                rank_diff = abs(to_rank_idx - from_rank_idx)

                # Score by how "diagonal" the move is
                if file_diff == rank_diff and file_diff > 0:
                    # Perfect diagonal - best score
                    bishop_candidates.append((sq_name, 0))
                elif file_diff > 0 and rank_diff > 0:
                    # Diagonal-ish: score = difference from perfect diagonal
                    diag_score = abs(file_diff - rank_diff)
                    bishop_candidates.append((sq_name, diag_score))
                else:
                    # Vertical or horizontal - NOT bishop-like at all
                    bishop_candidates.append((sq_name, 100))

        # Sort by diagonalness (lowest score = most diagonal)
        bishop_candidates.sort(key=lambda x: x[1])
        if bishop_candidates:
            return bishop_candidates[0][0], to_sq
        return None, to_sq

    # For other pieces, collect all candidates
    for square in chess.SQUARES:
        piece = board.piece_at(square)
        if piece and piece.piece_type == piece_type and piece.color == color:
            candidates.append(chess.square_name(square))

    if not candidates:
        return None, to_sq

    if len(candidates) == 1:
        return candidates[0], to_sq

    # Multiple candidates - check for disambiguation in the SAN
    if piece_char != 'P' and len(clean_no_x) >= 3:
        disambig = clean_no_x[1]
        for sq in candidates:
            if disambig in 'abcdefgh' and sq[0] == disambig:
                return sq, to_sq
            elif disambig in '12345678' and sq[1] == disambig:
                return sq, to_sq

    # SPECIAL HANDLING FOR PAWNS - must respect movement geometry
    if piece_char == 'P':
        to_file = to_sq[0]
        to_rank = int(to_sq[1])
        to_file_idx = ord(to_file) - ord('a')

        # Determine if this is a capture based on the move notation
        capture_from_file = None
        if is_capture:
            # Standard capture notation: exd4, dxe5
            x_pos = san.find('x')
            if x_pos > 0 and san[x_pos-1] in 'abcdefgh':
                capture_from_file = san[x_pos-1]
            elif san[0] in 'abcdefgh' and san[0] != to_file:
                capture_from_file = san[0]
        elif len(clean_no_x) >= 2 and clean_no_x[0] in 'abcdefgh' and clean_no_x[0] != to_file:
            capture_from_file = clean_no_x[0]

        # Score candidates by geometric validity
        scored = []
        for sq in candidates:
            sq_file = sq[0]
            sq_rank = int(sq[1])
            sq_file_idx = ord(sq_file) - ord('a')
            file_diff = abs(sq_file_idx - to_file_idx)

            # Check direction is correct (pawns move forward)
            if color == chess.WHITE:
                rank_diff = to_rank - sq_rank
                correct_direction = rank_diff > 0
            else:
                rank_diff = sq_rank - to_rank
                correct_direction = rank_diff > 0

            if not correct_direction:
                continue

            abs_rank_diff = abs(to_rank - sq_rank)

            if capture_from_file:
                if sq_file == capture_from_file and file_diff == 1 and abs_rank_diff == 1:
                    scored.append((sq, 0))
                elif sq_file == capture_from_file and abs_rank_diff == 1:
                    scored.append((sq, 50))
            else:
                if sq_file == to_file:
                    if abs_rank_diff == 1:
                        scored.append((sq, 0))
                    elif abs_rank_diff == 2:
                        start_rank = '2' if color == chess.WHITE else '7'
                        if sq[1] == start_rank:
                            scored.append((sq, 1))
                        else:
                            scored.append((sq, 100))

        if scored:
            scored.sort(key=lambda x: x[1])
            return scored[0][0], to_sq

        # Fallback: no pawn found on this file, compute plausible source square
        # For "e4" by white: check e2 first (starting rank double push), else e3 (one behind)
        if not is_capture and not capture_from_file:
            default_from_rank = to_rank - 1 if color == chess.WHITE else to_rank + 1
            if 1 <= default_from_rank <= 8:
                # For double-push targets (rank 4 for white, rank 5 for black),
                # check if pawn is on starting rank first
                if (color == chess.WHITE and to_rank == 4):
                    start_sq = chess.parse_square(to_file + '2')
                    p = board.piece_at(start_sq)
                    if p and p.piece_type == chess.PAWN and p.color == color:
                        return to_file + '2', to_sq
                elif (color == chess.BLACK and to_rank == 5):
                    start_sq = chess.parse_square(to_file + '7')
                    p = board.piece_at(start_sq)
                    if p and p.piece_type == chess.PAWN and p.color == color:
                        return to_file + '7', to_sq
                return to_file + str(default_from_rank), to_sq
        else:
            # Capture: use capture file, one rank behind
            cap_file = capture_from_file or to_file
            src_rank = to_rank - 1 if color == chess.WHITE else to_rank + 1
            if 1 <= src_rank <= 8:
                return cap_file + str(src_rank), to_sq

        return None, to_sq

    # For pieces with multiple candidates, pick best geometrically
    for sq in candidates:
        from_file_idx = ord(sq[0]) - ord('a')
        from_rank_idx = int(sq[1]) - 1
        file_diff = abs(to_file_idx - from_file_idx)
        rank_diff = abs(to_rank_idx - from_rank_idx)

        can_reach = False
        if piece_type == chess.QUEEN:
            can_reach = (file_diff == 0 or rank_diff == 0 or file_diff == rank_diff)
        elif piece_type == chess.ROOK:
            can_reach = (file_diff == 0 or rank_diff == 0)
        elif piece_type == chess.BISHOP:
            can_reach = (file_diff == rank_diff and file_diff > 0)
        elif piece_type == chess.KNIGHT:
            can_reach = (file_diff, rank_diff) in [(1,2), (2,1)]
        elif piece_type == chess.KING:
            can_reach = (file_diff <= 1 and rank_diff <= 1)
        elif piece_type == chess.PAWN:
            if color == chess.WHITE:
                can_reach = (file_diff == 0 and 1 <= to_rank_idx - from_rank_idx <= 2)
            else:
                can_reach = (file_diff == 0 and 1 <= from_rank_idx - to_rank_idx <= 2)

        if can_reach:
            return sq, to_sq

    # Last resort: return CLOSEST candidate by Chebyshev distance (max of file/rank diff)
    if candidates:
        def chebyshev_dist(sq):
            f = abs(ord(sq[0]) - ord(to_sq[0]))
            r = abs(int(sq[1]) - int(to_sq[1]))
            return max(f, r)
        candidates.sort(key=chebyshev_dist)
        return candidates[0], to_sq
    return None, to_sq
