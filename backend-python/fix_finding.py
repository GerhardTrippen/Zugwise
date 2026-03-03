"""
Score2PGN - Fix Finding
=======================
Core logic for finding candidate fixes for illegal or suspicious moves.

Combines multiple strategies:
- Deep backtrack (search all plies from 0 to stuck point)
- Character similarity scoring
- OCR confidence from alternative candidates
- Absurdity detection and resolution
- Future piece move enabling
- Hanging piece penalty (scaled by piece value)
"""

import chess
from typing import List, Dict, Optional, Set, Tuple
from data_structures import OCRMove, Absurdity
from helpers import piece_value, piece_name, ply_to_str, try_move, play_until_stuck
from similarity import move_similarity
from absurdity import (find_all_absurdities, find_check_symbol_mismatches,
                       find_duplicate_pawn_moves, find_duplicate_pawn_moves_in_ocr,
                       is_piece_genuinely_hanging)
from lenient_normalize import normalize_lenient_move
from collections import Counter
# === EARLY STOPPING (January 2026) ===
from play import play_until_absurd_or_stuck
USE_EARLY_STOPPING = True

print("=== NEW VERSION OF FIX_FINDING.PY LOADED ===")

# =============================================================================
# OCR CANDIDATE PATTERN ANALYSIS
# =============================================================================

def extract_destination(move: str) -> Optional[str]:
    """
    Extract destination square from a move string.
    Handles: e4, Nf3, Bxc4, Qd3, exd5, Nxe5+, O-O
    """
    if not move or move.startswith('O-O'):
        return None

    # Find file (a-h) followed by rank (1-8)
    for i in range(len(move) - 1):
        if move[i] in 'abcdefgh' and move[i+1] in '12345678':
            return move[i:i+2]
    return None


def extract_piece_type(san: str) -> str:
    """Extract piece letter from SAN. Returns 'P' for pawn moves."""
    if not san:
        return 'P'
    return san[0] if san[0] in 'KQRBN' else 'P'


def is_geometrically_reachable(from_sq_name: str, to_sq_name: str, piece: str) -> bool:
    """Check if to_sq is on the same diagonal/file/rank as from_sq for sliding pieces."""
    if piece not in ('Q', 'B', 'R'):
        return False
    file_diff = ord(to_sq_name[0]) - ord(from_sq_name[0])
    rank_diff = int(to_sq_name[1]) - int(from_sq_name[1])
    if file_diff == 0 and rank_diff == 0:
        return False
    is_diagonal = abs(file_diff) == abs(rank_diff) and file_diff != 0
    is_straight = (file_diff == 0) != (rank_diff == 0)
    if piece == 'B': return is_diagonal
    if piece == 'R': return is_straight
    return is_diagonal or is_straight  # Queen


def analyze_ocr_candidates(candidates: List[Tuple[str, float]], verbose: bool = False) -> dict:
    """
    Analyze OCR candidates to extract patterns.

    Args:
        candidates: List of (move_string, confidence) tuples (normalized by OCRMove.__post_init__)
        verbose: Print debug info

    Returns:
        dict with pattern analysis:
        - 'piece_prefixes': Counter of piece letters seen (K, Q, R, B, N)
        - 'has_capture': how many candidates have 'x'
        - 'destinations': Counter of destination squares
        - 'piece_move_ratio': fraction of candidates that are piece moves
    """
    piece_prefixes = Counter()
    destinations = Counter()
    capture_count = 0
    piece_move_count = 0

    if verbose:
        print(f"      ANALYZE_OCR: {len(candidates)} candidates: {candidates[:5]}")

    for move, conf in candidates:
        if not move:
            continue

        # Check for piece prefix
        if move[0] in 'KQRBN':
            piece_prefixes[move[0]] += 1
            piece_move_count += 1

        # Check for capture
        if 'x' in move:
            capture_count += 1

        # Extract destination square (last file+rank)
        dest = extract_destination(move)
        if dest:
            destinations[dest] += 1

    total = len(candidates)
    return {
        'piece_prefixes': piece_prefixes,
        'has_capture': capture_count,
        'destinations': destinations,
        'piece_move_ratio': piece_move_count / total if total > 0 else 0,
        'capture_ratio': capture_count / total if total > 0 else 0,
        'top_pieces': piece_prefixes.most_common(2),  # Top 2 suggested pieces
    }


def calculate_ocr_candidate_bonus(fix_move: str, ocr_candidates: List[Tuple[str, float]],
                                   ocr_analysis: dict = None, verbose: bool = False) -> int:
    """
    Calculate bonus for a fix based on OCR candidate patterns.

    If the OCR candidates show a pattern (e.g., multiple piece moves with Q or N prefix),
    fixes that match this pattern get a bonus.

    Args:
        fix_move: The proposed fix move (e.g., "Qd3")
        ocr_candidates: List of (move, confidence) from OCR
        ocr_analysis: Pre-computed analysis (optional)
        verbose: Print debug info

    Returns:
        Bonus score (0-30 points)
    """
    if not ocr_candidates or not fix_move:
        return 0

    if ocr_analysis is None:
        ocr_analysis = analyze_ocr_candidates(ocr_candidates)

    bonus = 0
    reasons = []

    # === Bonus 1: Fix matches a piece pattern seen in candidates ===
    if fix_move[0] in 'KQRBN':
        fix_piece = fix_move[0]

        # Direct match: fix piece appears in OCR candidates
        if fix_piece in ocr_analysis['piece_prefixes']:
            count = ocr_analysis['piece_prefixes'][fix_piece]
            # More candidates with this piece = stronger signal
            piece_bonus = min(10 * count, 20)  # e.g., Q appears 2x -> +20, cap at 20
            bonus += piece_bonus
            reasons.append(f"{fix_piece} in {count} candidates: +{piece_bonus}")

        # Indirect match: OCR candidates suggest piece move but top is pawn
        # If majority of candidates are piece moves, boost all piece fixes
        if ocr_analysis['piece_move_ratio'] >= 0.5:
            bonus += 5  # General piece move bonus
            reasons.append(f"piece_move_ratio={ocr_analysis['piece_move_ratio']:.0%}: +5")

    # === Bonus 2: Fix matches destination pattern ===
    fix_dest = extract_destination(fix_move)
    if fix_dest:
        # Check similar destinations (same file or adjacent squares)
        for dest, count in ocr_analysis['destinations'].items():
            if dest == fix_dest:
                dest_bonus = min(5 * count, 10)  # Exact match, cap at 10
                bonus += dest_bonus
                reasons.append(f"exact dest {dest}: +{dest_bonus}")
            elif dest and fix_dest and dest[0] == fix_dest[0]:
                # Same file (e.g., d4 vs d3)
                file_bonus = min(2 * count, 6)  # Cap at 6
                bonus += file_bonus
                reasons.append(f"same file {dest[0]}: +{file_bonus}")
            elif dest and fix_dest and len(dest) >= 2 and len(fix_dest) >= 2 and dest[1] == fix_dest[1]:
                # Same rank (e.g., e4 vs d4)
                rank_bonus = min(2 * count, 6)  # Cap at 6
                bonus += rank_bonus
                reasons.append(f"same rank {dest[1]}: +{rank_bonus}")

    # === Bonus 3: Fix matches capture pattern ===
    fix_has_capture = 'x' in fix_move
    if fix_has_capture and ocr_analysis['capture_ratio'] >= 0.3:
        bonus += 5  # OCR saw capture evidence
        reasons.append("capture pattern: +5")

    # === Bonus 4: Fix appears directly in OCR candidates ===
    for ocr_move, ocr_conf in ocr_candidates:
        if ocr_move == fix_move:
            # Direct match! Big bonus
            bonus += 15
            reasons.append(f"direct match in candidates: +15")
            break
        # Partial match (same move without check/checkmate symbols)
        clean_fix = fix_move.rstrip('+#') if fix_move else ''
        clean_ocr = ocr_move.rstrip('+#') if ocr_move else ''
        if clean_fix and clean_fix == clean_ocr:
            bonus += 10
            reasons.append(f"partial match {clean_ocr}: +10")
            break

    final_bonus = min(bonus, 30)  # Cap at 30 to avoid overwhelming other factors

    if verbose and (final_bonus > 0 or (fix_move and fix_move[0] in 'QRNB')):
        # Show bonus calculation for piece moves (even if 0) and any non-zero bonus
        reasons_str = ', '.join(reasons) if reasons else 'none'
        print(f"      [TARGET] OCR BONUS '{fix_move}': {final_bonus} (raw={bonus}, capped=30) | {reasons_str}")

    return final_bonus


# =============================================================================
# BACKTRACK PIECE CONFUSION DETECTION (R<->K, B<->R, etc.)
# =============================================================================

# Piece confusion pairs - common handwriting confusions where both are legal
CONFUSABLE_PIECES = [
    ('R', 'K'),  # Rook / King - very common!
    ('K', 'R'),
    ('B', 'R'),  # Bishop / Rook
    ('R', 'B'),
    ('N', 'K'),  # Knight / King
    ('K', 'N'),
    ('B', 'N'),  # Bishop / Knight
    ('N', 'B'),
]


def get_piece_alternatives(move: str) -> List[str]:
    """
    Generate alternative moves by swapping confusable piece letters.

    Args:
        move: SAN move string like "Rxe1"

    Returns:
        List of alternative moves: ["Kxe1", "Bxe1", ...]
    """
    if not move or move[0] not in 'KQRBN':
        return []

    alternatives = []
    original_piece = move[0]

    for p1, p2 in CONFUSABLE_PIECES:
        if original_piece == p1:
            alt_move = p2 + move[1:]
            if alt_move not in alternatives:
                alternatives.append(alt_move)

    return alternatives


def find_piece_confusion_candidates(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove],
    stuck_ply: int,
    lookback: int = 10
) -> List[dict]:
    """
    Look back through recent moves to find where piece confusion might have occurred.

    Focus on moves where:
    1. The piece letter is confusable (R<->K, B<->R, etc.)
    2. The OCR candidates included an alternative piece
    3. Both the original and alternative were legal at that position

    Returns:
        List of candidate fixes with details
    """
    candidates = []
    start_ply = max(0, stuck_ply - lookback)

    for ply in range(start_ply, stuck_ply):
        if ply >= len(moves):
            continue

        move = moves[ply]

        # Skip non-piece moves
        if not move or move[0] not in 'KQRBN':
            continue

        # Get OCR candidates for this ply
        ocr_m = ocr_lookup.get(ply)
        ocr_cands = []
        if ocr_m and ocr_m.candidates:
            ocr_cands = ocr_m.candidates

        # Get piece alternatives
        alternatives = get_piece_alternatives(move)

        if not alternatives:
            continue

        # Replay board to this position
        board = chess.Board()
        valid_replay = True
        for i in range(ply):
            try:
                board.push_san(moves[i])
            except:
                valid_replay = False
                break

        if not valid_replay:
            continue

        # Check each alternative
        for alt_move in alternatives:
            # Was this alternative in OCR candidates?
            in_candidates = False
            ocr_conf = 0.0
            for cand, conf in ocr_cands:
                if cand == alt_move:
                    in_candidates = True
                    ocr_conf = conf
                    break

            # Was the alternative legal at that position?
            alt_legal = False
            try:
                board.parse_san(alt_move)
                alt_legal = True
            except:
                pass

            # Was original legal?
            orig_legal = False
            try:
                board.parse_san(move)
                orig_legal = True
            except:
                pass

            # If both were legal, this is a confusion candidate!
            if orig_legal and alt_legal:
                candidates.append({
                    'ply': ply,
                    'original': move,
                    'alternative': alt_move,
                    'ocr_conf': ocr_conf,
                    'in_candidates': in_candidates,
                    'both_legal': True,
                    'piece_swap': (move[0], alt_move[0]),
                })

    return candidates


def test_piece_confusion_fix(
    moves: List[str],
    ply: int,
    alternative: str,
    stuck_ply: int
) -> dict:
    """
    Test if swapping a piece at an earlier ply fixes the downstream stuck position.

    Returns:
        Dict with fixes_problem, new_stuck_ply, plies_gained
    """
    # Create modified move list
    modified_moves = moves[:ply] + [alternative] + moves[ply + 1:]

    # Use play_until_stuck for consistent validation (phantom capture/check detection)
    new_stuck_ply, _ = play_until_stuck(modified_moves)

    # If we played all moves, new_stuck_ply == len(modified_moves), meaning we completed
    if new_stuck_ply >= len(modified_moves):
        new_stuck_ply = None  # None means "completed"

    # Did we get further than before?
    if new_stuck_ply is None:
        plies_gained = len(moves) - stuck_ply
        fixes_problem = True
    elif new_stuck_ply > stuck_ply:
        plies_gained = new_stuck_ply - stuck_ply
        fixes_problem = True
    else:
        plies_gained = 0
        fixes_problem = False

    return {
        'fixes_problem': fixes_problem,
        'new_stuck_ply': new_stuck_ply,
        'plies_gained': plies_gained,
    }


def score_backtrack_piece_fix(candidate: dict, test_result: dict, stuck_ply: int) -> float:
    """
    Score a backtrack piece confusion fix.

    Factors:
    1. Does it fix the problem? (plies gained)
    2. Was alternative in OCR candidates? (bonus)
    3. How far back is the fix? (prefer recent)
    4. Piece confusion likelihood (R<->K more common than B<->N)
    """
    score = 0.0

    # Factor 1: Plies gained (most important)
    score += test_result['plies_gained'] * 15

    # Factor 2: OCR candidate bonus
    if candidate['in_candidates']:
        score += 25
        if candidate['ocr_conf'] > 0.01:
            score += 10
        elif candidate['ocr_conf'] > 0.001:
            score += 5

    # Factor 3: Recency bonus
    ply_distance = stuck_ply - candidate['ply']
    if ply_distance <= 3:
        score += 10
    elif ply_distance <= 6:
        score += 5

    # Factor 4: Piece confusion likelihood
    piece_swap = candidate['piece_swap']
    if piece_swap in [('R', 'K'), ('K', 'R')]:
        score += 8  # Very common confusion
    elif piece_swap in [('B', 'R'), ('R', 'B')]:
        score += 5  # Common confusion
    else:
        score += 2  # Less common

    # Factor 5: Capture moves more likely to have confusion
    if 'x' in candidate['original']:
        score += 5

    return score


def find_backtrack_piece_fixes(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove],
    stuck_ply: int,
    top_k: int = 5,
    verbose: bool = False
) -> List[dict]:
    """
    Main function: Find and rank backtrack piece confusion fixes.

    Args:
        moves: List of SAN moves
        ocr_lookup: Dict mapping ply -> OCRMove
        stuck_ply: Where game got stuck
        top_k: Number of top fixes to return
        verbose: Print debug info

    Returns:
        List of ranked fixes with scores
    """
    # Find candidates
    candidates = find_piece_confusion_candidates(moves, ocr_lookup, stuck_ply)

    if not candidates:
        if verbose:
            print(f"   [PIECE CONFUSION] No R/K, B/R swappable piece moves found in lookback range")
        return []

    if verbose:
        print(f"   [PIECE CONFUSION] Testing {len(candidates)} potential swaps...")

    # Test each candidate
    scored_fixes = []

    for cand in candidates:
        test_result = test_piece_confusion_fix(
            moves,
            cand['ply'],
            cand['alternative'],
            stuck_ply
        )

        if test_result['fixes_problem']:
            score = score_backtrack_piece_fix(cand, test_result, stuck_ply)

            fix = {
                **cand,
                **test_result,
                'score': score,
                'type': 'backtrack_piece_confusion',
            }
            scored_fixes.append(fix)

            if verbose:
                print(f"      [OK] {ply_to_str(cand['ply'])}: '{cand['original']}' -> '{cand['alternative']}' "
                      f"| +{test_result['plies_gained']} plies | score={score:.0f}")
        else:
            if verbose:
                print(f"      [--] {ply_to_str(cand['ply'])}: '{cand['original']}' -> '{cand['alternative']}' "
                      f"| doesn't fix problem")

    # Sort by score
    scored_fixes.sort(key=lambda x: -x['score'])

    if verbose:
        if scored_fixes:
            print(f"   [PIECE CONFUSION] {len(scored_fixes)} swap(s) actually fix the problem")
        else:
            print(f"   [PIECE CONFUSION] None of the swaps fixed the problem")

    return scored_fixes[:top_k]


# =============================================================================
# BLOCKER DETECTION HEURISTIC
# =============================================================================

def get_path_squares(from_sq: int, to_sq: int, piece_type: int) -> List[int]:
    """
    Get all squares between from_sq and to_sq (exclusive) for sliding pieces.
    Returns empty list for non-sliding pieces, adjacent squares, or invalid paths.
    """
    if piece_type not in (chess.BISHOP, chess.ROOK, chess.QUEEN):
        return []

    from_file, from_rank = chess.square_file(from_sq), chess.square_rank(from_sq)
    to_file, to_rank = chess.square_file(to_sq), chess.square_rank(to_sq)

    file_diff = to_file - from_file
    rank_diff = to_rank - from_rank

    # Determine direction
    file_step = 0 if file_diff == 0 else (1 if file_diff > 0 else -1)
    rank_step = 0 if rank_diff == 0 else (1 if rank_diff > 0 else -1)

    # Validate path is actually reachable by piece type
    is_diagonal = abs(file_diff) == abs(rank_diff) and file_diff != 0
    is_straight = (file_diff == 0) != (rank_diff == 0)  # XOR: exactly one is zero

    if piece_type == chess.BISHOP and not is_diagonal:
        return []
    if piece_type == chess.ROOK and not is_straight:
        return []
    if piece_type == chess.QUEEN and not (is_diagonal or is_straight):
        return []  # Queen must move diagonally OR straight, not knight-like

    path = []
    curr_file, curr_rank = from_file + file_step, from_rank + rank_step
    max_iterations = 8  # Safety limit: max 7 squares between any two squares
    iterations = 0
    while (curr_file, curr_rank) != (to_file, to_rank) and iterations < max_iterations:
        if 0 <= curr_file < 8 and 0 <= curr_rank < 8:
            path.append(chess.square(curr_file, curr_rank))
        curr_file += file_step
        curr_rank += rank_step
        iterations += 1

    return path


def find_blocker_candidates(
    moves: List[str],
    stuck_ply: int,
    stuck_move: str,
    ocr_lookup: Dict[int, OCRMove],
    verbose: bool = False
) -> List[Tuple[int, float]]:
    """
    If stuck_move is illegal due to a friendly piece blocking the path,
    find earlier same-color moves that look similar to moves that would clear the blocker.

    Returns: List of (ply, similarity) tuples for candidate plies to add to search

    Example:
        Ba3 is illegal because pawn on b2 blocks the diagonal.
        Clearing moves: b3, b4
        If 12.W was "g3", and "g3" has 67% similarity to "b3", return [(ply_12W, 0.67)]
    """
    if not stuck_move or stuck_ply >= len(moves):
        return []

    # Parse the stuck move to understand intent
    # Format: [KQRBN]?[a-h]?[x]?[a-h][1-8][+#]?
    piece_char = stuck_move[0] if stuck_move[0] in 'KQRBN' else None
    piece_type = {'K': chess.KING, 'Q': chess.QUEEN, 'R': chess.ROOK,
                  'B': chess.BISHOP, 'N': chess.KNIGHT}.get(piece_char)
    is_pawn_move = stuck_move[0] in 'abcdefgh'

    # Extract destination square (last [a-h][1-8] in the move)
    dest_square = None
    for i in range(len(stuck_move) - 1, 0, -1):
        if stuck_move[i-1] in 'abcdefgh' and stuck_move[i] in '12345678':
            dest_square = chess.parse_square(stuck_move[i-1:i+1])
            break

    if dest_square is None:
        return []

    # Build position at stuck_ply
    board = chess.Board()
    for i in range(stuck_ply):
        m = try_move(board, moves[i])
        if m:
            board.push(m)
        else:
            return []  # Can't build position

    color = board.turn
    blockers = []

    if is_pawn_move and 'x' not in stuck_move:
        # PAWN PATH BLOCKER: check intermediate squares for pawn pushes
        # For a pawn double push (e.g., g5 from g7), the intermediate square must be clear
        dest_file = chess.square_file(dest_square)
        dest_rank = chess.square_rank(dest_square)

        # Determine pawn start square and path
        if color == chess.WHITE:
            # White pawn pushes up (rank increases)
            # Single push: pawn on (dest_rank - 1), path = {dest}
            # Double push: pawn on rank 1 (index), dest_rank=3 (rank 4), path = {rank 2, rank 3}
            if dest_rank == 3:  # rank 4 = double push from rank 2
                intermediate_sq = chess.square(dest_file, 2)  # rank 3
                piece_on_intermediate = board.piece_at(intermediate_sq)
                if piece_on_intermediate:
                    blockers.append((intermediate_sq, piece_on_intermediate))
        else:
            # Black pawn pushes down (rank decreases)
            # Double push: pawn on rank 6 (index), dest_rank=4 (rank 5), path = {rank 5, rank 4}
            if dest_rank == 4:  # rank 5 = double push from rank 7
                intermediate_sq = chess.square(dest_file, 5)  # rank 6
                piece_on_intermediate = board.piece_at(intermediate_sq)
                if piece_on_intermediate:
                    blockers.append((intermediate_sq, piece_on_intermediate))

        # Also check: any piece on the destination itself (single or double push)
        dest_piece = board.piece_at(dest_square)
        if dest_piece:
            blockers.append((dest_square, dest_piece))

    elif piece_type in (chess.BISHOP, chess.ROOK, chess.QUEEN):
        # SLIDING PIECE BLOCKER: check path squares
        piece_squares = list(board.pieces(piece_type, color))
        if not piece_squares:
            return []

        for piece_sq in piece_squares:
            path = get_path_squares(piece_sq, dest_square, piece_type)
            for sq in path:
                blocker_piece = board.piece_at(sq)
                if blocker_piece and blocker_piece.color == color:
                    blockers.append((sq, blocker_piece))
    else:
        return []  # Knights, kings — no path blocking possible

    if not blockers:
        return []  # No blockers found

    # === APPROACH 1: Find clearing moves (existing logic for sliding pieces) ===
    clearing_moves = []
    for blocker_sq, blocker_piece in blockers:
        sq_name = chess.square_name(blocker_sq)
        if blocker_piece.piece_type == chess.PAWN:
            file_char = sq_name[0]
            rank = int(sq_name[1])
            if color == chess.WHITE:
                clearing_moves.append(f"{file_char}{rank + 1}")
                if rank == 2:
                    clearing_moves.append(f"{file_char}4")
            else:
                clearing_moves.append(f"{file_char}{rank - 1}")
                if rank == 7:
                    clearing_moves.append(f"{file_char}5")

    # === APPROACH 2: Trace which ply PLACED the blocking piece there ===
    # This catches cases like Ng6 (should be h6) blocking g7-g5
    arrival_candidates = []
    for blocker_sq, blocker_piece in blockers:
        # Replay game to find when this piece arrived at the blocking square
        trace_board = chess.Board()
        for i in range(stuck_ply):
            m = try_move(trace_board, moves[i])
            if m:
                if m.to_square == blocker_sq:
                    # This move placed a piece on the blocking square
                    arrival_candidates.append({
                        'ply': i,
                        'original': moves[i],
                        'clearing_move': f"(placed {blocker_piece.symbol()} on {chess.square_name(blocker_sq)})",
                        'similarity': 0.0,  # Will be rescored in the search loop
                    })
                trace_board.push(m)
            else:
                break

    if verbose:
        print(f"   [BLOCKER] '{stuck_move}' blocked by pieces at: {[chess.square_name(sq) for sq, _ in blockers]}")
        if clearing_moves:
            print(f"   [BLOCKER] Clearing moves: {clearing_moves}")
        if arrival_candidates:
            for ac in arrival_candidates:
                print(f"   [BLOCKER] Piece placed at blocker by ply {ply_to_str(ac['ply'])}: '{ac['original']}'")

    # Search earlier same-color moves for similarity to clearing moves
    candidates = []
    stuck_color = stuck_ply % 2  # 0 = White, 1 = Black

    if clearing_moves:
        for ply in range(stuck_color, stuck_ply, 2):  # Same color's moves only
            if ply >= len(moves):
                continue
            original_move = moves[ply]
            if not original_move:
                continue

            for clear_move in clearing_moves:
                sim = move_similarity(original_move, clear_move)
                if sim >= 0.50:  # Reasonable similarity threshold
                    candidates.append({
                        'ply': ply,
                        'original': original_move,
                        'clearing_move': clear_move,
                        'similarity': sim,
                    })

    # Add arrival candidates (the ply that placed the blocking piece)
    # These always get added regardless of similarity — the search loop will score them properly
    for ac in arrival_candidates:
        candidates.append(ac)

    # Keep best candidate per ply (highest similarity)
    best_by_ply = {}
    for cand in candidates:
        ply = cand['ply']
        if ply not in best_by_ply or cand['similarity'] > best_by_ply[ply]['similarity']:
            best_by_ply[ply] = cand

    return list(best_by_ply.values())


def find_destination_occupant_candidates(
    moves: List[str],
    stuck_ply: int,
    stuck_move: str,
    ocr_lookup: Dict[int, OCRMove],
    verbose: bool = False
) -> List[dict]:
    """
    If stuck_move is illegal because a FRIENDLY piece occupies the destination square,
    trace back to find the move that placed that piece there. That move is likely wrong.

    Example: Nb6 illegal because own pawn on b6 (was "b6" but should have been "h6").

    Returns: List of dicts with 'ply', 'original', 'similarity' for candidate plies.
    """
    if not stuck_move or stuck_ply >= len(moves):
        return []

    # Extract destination square from stuck move (last [a-h][1-8])
    dest_square = None
    for i in range(len(stuck_move) - 1, 0, -1):
        if stuck_move[i-1] in 'abcdefgh' and stuck_move[i] in '12345678':
            dest_square = chess.parse_square(stuck_move[i-1:i+1])
            break

    if dest_square is None:
        return []

    # Build position at stuck_ply
    board = chess.Board()
    for i in range(stuck_ply):
        m = try_move(board, moves[i])
        if m:
            board.push(m)
        else:
            return []  # Can't build position

    # Check: is there a friendly piece on the destination square?
    occupant = board.piece_at(dest_square)
    if occupant is None or occupant.color != board.turn:
        return []  # Not occupied by friendly piece

    dest_name = chess.square_name(dest_square)

    # Check if the stuck move's piece type can actually reach the destination
    stuck_piece_type = None
    clean_stuck = stuck_move.replace('+', '').replace('#', '')
    if clean_stuck and clean_stuck[0] in 'KQRBN':
        stuck_piece_type = {'K': chess.KING, 'Q': chess.QUEEN, 'R': chess.ROOK, 'B': chess.BISHOP, 'N': chess.KNIGHT}[clean_stuck[0]]
    elif clean_stuck and clean_stuck[0] in 'abcdefgh':
        stuck_piece_type = chess.PAWN

    if stuck_piece_type is not None:
        # Temporarily remove the occupant to check if the stuck piece could reach
        # the destination if it were empty. Without this, board.legal_moves won't
        # include moves to the occupied square — which is the very problem we detect.
        saved_occupant = board.piece_at(dest_square)
        board.remove_piece_at(dest_square)
        can_reach = False
        for legal_move in board.legal_moves:
            if legal_move.to_square == dest_square:
                moving_piece = board.piece_at(legal_move.from_square)
                if moving_piece and moving_piece.piece_type == stuck_piece_type:
                    can_reach = True
                    break
        # Restore the occupant
        if saved_occupant:
            board.set_piece_at(dest_square, saved_occupant)
        if not can_reach:
            if verbose:
                piece_name = chess.piece_name(stuck_piece_type) if stuck_piece_type else '?'
                print(f"   [OCCUPANT] No {piece_name} can reach {dest_name} — skipping occupant logic")
            return []
    if verbose:
        print(f"   [OCCUPANT] '{stuck_move}' blocked by friendly {occupant.symbol()} on {dest_name}")

    # Trace backwards: find which move placed that piece on the destination
    # Replay the game tracking piece positions
    trace_board = chess.Board()
    arrival_plies = []  # plies where a piece arrived at dest_square

    for i in range(stuck_ply):
        m = try_move(trace_board, moves[i])
        if m:
            # Check if this move lands on our destination square
            if m.to_square == dest_square:
                arrival_plies.append(i)
            trace_board.push(m)
        else:
            break  # Position broken

    if not arrival_plies:
        return []

    if verbose:
        for ap in arrival_plies:
            print(f"   [OCCUPANT] Piece arrived at {dest_name} via move at ply {ply_to_str(ap)}: '{moves[ap]}'")

    # For each arrival ply, check similarity of that move to legal alternatives
    candidates = []
    for arrival_ply in arrival_plies:
        original_move = moves[arrival_ply]

        # Build position at arrival_ply to find legal alternatives
        alt_board = chess.Board()
        valid = True
        for i in range(arrival_ply):
            m = try_move(alt_board, moves[i])
            if m:
                alt_board.push(m)
            else:
                valid = False
                break
        if not valid:
            continue

        # Find legal moves that DON'T land on dest_square
        for legal_move in alt_board.legal_moves:
            if legal_move.to_square == dest_square:
                continue  # Skip moves that still go to the blocked square
            legal_san = alt_board.san(legal_move)
            sim = move_similarity(original_move, legal_san)
            if sim >= 0.50:
                candidates.append({
                    'ply': arrival_ply,
                    'original': original_move,
                    'alternative': legal_san,
                    'similarity': sim,
                })

    # Keep best candidate per ply
    best_by_ply = {}
    for cand in candidates:
        ply = cand['ply']
        if ply not in best_by_ply or cand['similarity'] > best_by_ply[ply]['similarity']:
            best_by_ply[ply] = cand

    if verbose and best_by_ply:
        for ply, cand in sorted(best_by_ply.items()):
            print(f"   [OCCUPANT] Candidate: {ply_to_str(ply)} '{cand['original']}' -> '{cand['alternative']}' (sim={cand['similarity']:.0%})")

    return list(best_by_ply.values())


# =============================================================================
# MOVE NORMALIZATION
# =============================================================================

def normalize_move_for_comparison(san: str) -> str:
    """
    Normalize a move for comparison by removing notation variants.
    This ensures equivalent moves are treated as the same:
    - a1=Q and a1Q (promotion notation)
    - Qd4+ and Qd4 (check/mate symbols)

    NOTE: We do NOT remove 'x' because Qd4 and Qxd4 are DIFFERENT moves!
    - Qxd4 = queen captures on d4
    - Qd4 = queen moves to d4 (no capture)
    """
    result = san.rstrip('+#')
    # Normalize promotion: a1=Q -> a1Q (remove the =)
    result = result.replace('=', '')
    return result


# =============================================================================
# FIX EXPLANATION
# =============================================================================

def generate_fix_explanation(fix: dict, ocr_lookup: Dict[int, OCRMove] = None) -> str:
    """Generate human-readable explanation for why a fix was chosen."""
    ocr_text = fix.get("ocr", "?")
    san = fix.get("san", "?")
    char_sim = fix.get("char_sim", 0)
    ocr_conf = fix.get("ocr_conf", 0)
    was_illegal = not fix.get("original_was_legal", True)
    
    reasons = []
    
    # Primary reason first
    if was_illegal:
        reasons.append(f"'{ocr_text}' is illegal in this position")
    
    if fix.get('resolves_absurdity'):
        absurdity = fix['resolves_absurdity']
        piece = piece_name(absurdity.hanging_piece) if hasattr(absurdity, 'hanging_piece') else "piece"
        square = absurdity.hanging_square if hasattr(absurdity, 'hanging_square') else "?"
        reasons.append(f"'{ocr_text}' leaves {piece} on {square} hanging")
    
    # Similarity explanation
    if char_sim >= 0.8:
        reasons.append(f"'{san}' looks very similar to '{ocr_text}'")
    elif char_sim >= 0.6:
        reasons.append(f"'{san}' is visually similar to '{ocr_text}'")
    elif char_sim >= 0.4:
        reasons.append(f"'{san}' has some similarity to '{ocr_text}'")
    
    # OCR alternative
    if ocr_conf >= 0.1:
        reasons.append(f"OCR detected '{san}' as alternative ({ocr_conf:.0%})")
    
    # Future moves - be specific about what it enables
    if fix.get("enables_future") and fix.get("future_moves_enabled", 0) > 0:
        future_count = fix.get('future_moves_enabled', 0)
        moved_piece = fix.get('moved_piece', '?')
        piece_names = {'K': 'King', 'Q': 'Queen', 'R': 'Rook', 'B': 'Bishop', 'N': 'Knight', 'P': 'pawn'}
        piece_name_str = piece_names.get(moved_piece, moved_piece)
        
        # Try to describe what future moves are enabled
        to_sq = fix.get('to_square', '')
        if to_sq:
            reasons.append(f"opens lines for {future_count} future {piece_name_str} move(s) via {to_sq}")
        else:
            reasons.append(f"enables {future_count} future {piece_name_str} move(s)")
    
    # Completion
    if fix.get("completes"):
        reasons.append("allows game to complete successfully")
    
    # Constraint/development fix
    if fix.get("constraint_fix"):
        reasons.append("enables blocked piece to develop")
    
    # Reach improvement
    reach_imp = fix.get("reach_improvement", 0)
    if reach_imp > 5 and not fix.get("completes"):
        reasons.append(f"allows {reach_imp} more plies to validate")
    
    # Warning about hanging
    if fix.get("is_hanging"):
        hanging_val = fix.get('hanging_value', 0)
        piece_names = {3: 'minor piece', 5: 'Rook', 9: 'Queen'}
        piece_desc = piece_names.get(hanging_val, f'piece (value={hanging_val})')
        reasons.append(f"[!] WARNING: leaves {piece_desc} hanging")
    
    if not reasons:
        reasons.append("legal move that continues the game")
    
    return "; ".join(reasons)


# =============================================================================
# HANGING PIECE CHECK FOR FIXES
# =============================================================================

def is_piece_hanging_after_move(board: chess.Board, move: chess.Move) -> Tuple[bool, int]:
    """
    Check if the moved piece is hanging after the move.
    Returns (is_hanging: bool, piece_value: int).

    Uses is_piece_genuinely_hanging() from absurdity.py as SINGLE SOURCE OF TRUTH.

    FIXED: If the move is a capture, the piece is not considered "hanging"
    because it just won material (or at worst traded). Even if it can be
    recaptured, the trade might be favorable or equal.
    """
    # If this is a capture, evaluate the trade.
    # Capturing equal or higher value = fine (fair trade or better).
    # Capturing LESS value = check if our piece gets recaptured (bad trade).
    # Example: Bxb7 (bishop=3 takes pawn=1), queen recaptures = bad, net loss of 2.
    if board.is_capture(move):
        captured_piece = board.piece_at(move.to_square)
        captured_val = piece_value(captured_piece) if captured_piece else 0
        moving_piece = board.piece_at(move.from_square)
        moving_val = piece_value(moving_piece) if moving_piece else 0

        # Captured equal or higher value - always fine (fair trade or winning)
        if captured_val >= moving_val:
            return False, 0

        # Captured less value - check if we're now hanging after the capture
        test_board = board.copy()
        test_board.push(move)
        to_square = move.to_square
        our_piece = test_board.piece_at(to_square)
        if our_piece is None:
            return False, 0

        opponent = test_board.turn
        # Check: can opponent LEGALLY capture our piece?
        # Using legal_moves instead of is_attacked_by correctly handles:
        # - King can't capture on defended square (mutual defense, e.g. Q+B both attack b7)
        # - King can't capture when in check (gives-check captures like Qxb7+)
        # - Pinned pieces can't capture
        legal_captures_on_sq = [m for m in test_board.legal_moves if m.to_square == to_square]

        if not legal_captures_on_sq:
            return False, 0  # No legal recapture possible

        # Check if adequately defended against legal captures
        if test_board.is_attacked_by(our_piece.color, to_square):
            # Defended - check if lowest LEGAL capturer is lower value (losing exchange)
            min_attacker_val = 99
            for cap_move in legal_captures_on_sq:
                att_piece = test_board.piece_at(cap_move.from_square)
                if att_piece:
                    min_attacker_val = min(min_attacker_val, piece_value(att_piece))
            if min_attacker_val >= moving_val:
                return False, 0  # Only attacked by equal/higher value AND defended

        # Our piece is hanging after the capture - bad trade
        net_loss = moving_val - captured_val
        if net_loss >= 2:  # Significant material loss
            return True, net_loss

        return False, 0

    test_board = board.copy()
    test_board.push(move)

    to_square = move.to_square
    piece = test_board.piece_at(to_square)
    if piece is None:
        return False, 0

    piece_val = piece_value(piece)

    if piece_val < 3:
        # For pawns: simple attacked-and-undefended check (no expensive quiescence needed)
        if piece_val >= 1:
            opponent = not piece.color
            if test_board.is_attacked_by(opponent, to_square):
                if not test_board.is_attacked_by(piece.color, to_square):
                    return True, piece_val  # Pawn hanging for free
        return False, 0

    # Use SINGLE SOURCE OF TRUTH from absurdity.py
    # fast_mode=True for performance in fix-finding
    is_hanging, net_gain, reason = is_piece_genuinely_hanging(
        test_board, to_square, piece,
        move_just_played=move,
        fast_mode=True,
        debug=False
    )

    return is_hanging, piece_val if is_hanging else 0


def count_hanging_pawns_after_move(board: chess.Board, move: chess.Move) -> int:
    """Count friendly pawns that are attacked and undefended after a move.

    This catches cases like a rook moving away and leaving a pawn undefended.
    Only checks the side that just moved (their pawns might now be hanging).
    """
    test_board = board.copy()
    test_board.push(move)

    our_color = not test_board.turn  # Side that just moved
    opponent = test_board.turn

    count = 0
    for sq in test_board.pieces(chess.PAWN, our_color):
        if test_board.is_attacked_by(opponent, sq):
            if not test_board.is_attacked_by(our_color, sq):
                count += 1

    return count


def find_best_capture_gain(board: chess.Board) -> int:
    """Find the best net material gain from any available capture.

    Checks all opponent pieces: if attacked by us and undefended, the full
    piece value is available. If defended, the gain is our lowest attacker's
    trade advantage (captured_val - attacker_val if positive).

    Returns the best net gain (0 if no winning captures available).
    Used to penalize fix candidates that ignore free material.
    """
    our_color = board.turn
    opponent = not our_color
    best_gain = 0

    for sq in chess.SQUARES:
        piece = board.piece_at(sq)
        if piece is None or piece.color != opponent:
            continue
        val = piece_value(piece)
        if val < 2:
            continue  # Skip pawns - too noisy

        if not board.is_attacked_by(our_color, sq):
            continue

        # Find our lowest-value attacker that can LEGALLY capture
        attackers = board.attackers(our_color, sq)
        min_attacker_val = 99
        has_legal_capture = False
        for att_sq in attackers:
            att_piece = board.piece_at(att_sq)
            if att_piece:
                capture_move = chess.Move(att_sq, sq)
                if capture_move in board.legal_moves:
                    has_legal_capture = True
                    min_attacker_val = min(min_attacker_val, piece_value(att_piece))
        if not has_legal_capture:
            continue  # All attackers are pinned — can't actually capture

        if board.is_attacked_by(opponent, sq):
            # Defended - gain is captured_val - attacker_val (trade advantage)
            net = val - min_attacker_val
        else:
            # Undefended - free capture, full value
            net = val

        if net >= 2:
            # Check for opponent's tactical reply (e.g., promotion-capture compensation)
            # Find the actual legal capture move for our cheapest attacker
            best_capture_move = None
            for att_sq in attackers:
                att_piece = board.piece_at(att_sq)
                if att_piece and piece_value(att_piece) == min_attacker_val:
                    cm = chess.Move(att_sq, sq)
                    if cm in board.legal_moves:
                        best_capture_move = cm
                        break
            if best_capture_move:
                board.push(best_capture_move)
                # Check if opponent has a RELATED reply (recapture or promotion)
                # Unrelated captures elsewhere don't count — they were available before
                opp_best_recovery = 0
                for opp_reply in board.legal_moves:
                    is_recapture = (opp_reply.to_square == sq and board.is_capture(opp_reply))
                    is_promotion = opp_reply.promotion is not None
                    if not is_recapture and not is_promotion:
                        continue
                    reply_gain = 0
                    if board.is_capture(opp_reply):
                        target = board.piece_at(opp_reply.to_square)
                        if target:
                            reply_gain += piece_value(target)
                    if is_promotion:
                        reply_gain += 8  # queen(9) - pawn(1)
                    if reply_gain > opp_best_recovery:
                        opp_best_recovery = reply_gain
                board.pop()
                # Reduce net by opponent's recovery
                net = net - opp_best_recovery
            best_gain = max(best_gain, net)

    return best_gain


def see_capture_value(board: chess.Board, capture_move: chess.Move) -> int:
    """Static Exchange Evaluation for a specific capture move.

    Evaluates the full exchange sequence on the target square, starting with
    the given move, then alternating sides always using the cheapest attacker.
    Returns the net material gain for the side making the initial capture.

    This is O(number of attackers on the square) — typically microseconds.
    Unlike quiescence search, no tree exploration is needed.

    Example: Qxc4 (capturing knight), Qxc4, Bxc4 → net = +3 (knight) - 9 (queen) + 9 (queen) = +3
    """
    target_sq = capture_move.to_square
    captured_piece = board.piece_at(target_sq)
    if not captured_piece:
        return 0

    # Build the sequence of piece values involved in the exchange
    # gain[i] = material balance from the perspective of side making move i
    # We use the "negamax" style: gain[i] = captured_value - gain[i+1]
    attacker_piece = board.piece_at(capture_move.from_square)
    if not attacker_piece:
        return 0

    # Work on a copy to avoid mutating the board
    b = board.copy()

    # Track the exchange: alternating captures on target_sq
    gain = []
    gain.append(piece_value(captured_piece))  # Initial capture value

    current_attacker_val = piece_value(attacker_piece)
    b.push(capture_move)

    while True:
        # Find cheapest attacker for the side to move
        side = b.turn
        attackers = b.attackers(side, target_sq)
        if not attackers:
            break

        # Find cheapest legal attacker
        min_val = 99
        best_att_move = None
        for att_sq in attackers:
            att_piece = b.piece_at(att_sq)
            if att_piece:
                att_move = chess.Move(att_sq, target_sq)
                # Handle pawn promotion captures
                if att_piece.piece_type == chess.PAWN and chess.square_rank(target_sq) in (0, 7):
                    att_move = chess.Move(att_sq, target_sq, promotion=chess.QUEEN)
                if att_move in b.legal_moves and piece_value(att_piece) < min_val:
                    min_val = piece_value(att_piece)
                    best_att_move = att_move

        if best_att_move is None:
            break  # No legal recapture (all pinned, etc.)

        # This recapture gains the previous attacker's value
        gain.append(current_attacker_val)
        current_attacker_val = min_val
        b.push(best_att_move)

    # Evaluate from the end: each side can choose to stop the exchange
    # gain[i] = captured_value - max(0, gain[i+1])  (can choose not to recapture)
    while len(gain) > 1:
        gain[-2] = gain[-2] - max(0, gain[-1])
        gain.pop()

    return gain[0]


# =============================================================================
# FUTURE PIECE MOVE SCANNING
# =============================================================================

def scan_future_piece_moves(ocr_lookup: Dict[int, OCRMove], stuck_ply: int, 
                            total_moves: int) -> Dict[str, List[Tuple[int, str, float]]]:
    """
    Scan OCR for future high-confidence piece moves.
    
    Key: piece letter + color, e.g., 'Q_W' for White Queen, 'Q_B' for Black Queen.
    This ensures we don't confuse White's and Black's pieces!
    
    Note: Starts from stuck_ply + 1 because the move AT stuck_ply is the one
    we're trying to fix - it's not a valid future move target.
    """
    future_piece_moves = {}
    for ply in range(stuck_ply + 1, total_moves):  # Start AFTER stuck_ply
        ocr_m = ocr_lookup.get(ply)
        if ocr_m and ocr_m.top_confidence >= 0.70:
            move = ocr_m.top_move
            if move and len(move) >= 2:
                piece = move[0] if move[0] in 'KQRBN' else 'P'
                color = 'W' if ply % 2 == 0 else 'B'
                key = f"{piece}_{color}"  # e.g., "Q_W" for White Queen
                if key not in future_piece_moves:
                    future_piece_moves[key] = []
                future_piece_moves[key].append((ply, move, ocr_m.top_confidence))
    return future_piece_moves


def find_unblocked_pieces(board: chess.Board, candidate_san: str, color: chess.Color) -> List[str]:
    """
    Check if making this move unblocks any piece that was previously stuck.

    A piece is considered "stuck" if it has 0 legal moves before the candidate move.
    It becomes "unblocked" if it has at least 1 legal move after.

    Returns list of piece types that become unblocked (e.g., ['B'] or ['R', 'B'] or [])
    """
    unblocked = []

    # Parse the candidate move
    try:
        move = board.parse_san(candidate_san)
    except:
        return []

    # Check each piece type: was it blocked before, can it move after?
    for piece_type in [chess.BISHOP, chess.ROOK, chess.QUEEN, chess.KNIGHT]:
        piece_symbol = chess.piece_symbol(piece_type).upper()

        # Count legal moves for this piece type BEFORE the candidate move
        moves_before = 0
        for m in board.legal_moves:
            piece = board.piece_at(m.from_square)
            if piece and piece.piece_type == piece_type and piece.color == color:
                moves_before += 1
                break  # Just need to know if ANY move exists

        # Make the candidate move on a test board
        test_board = board.copy()
        test_board.push(move)

        # After our move, it's opponent's turn. Skip opponent's turn to see our next legal moves.
        # Use a null move to switch turns (only works if not in check)
        try:
            test_board.push(chess.Move.null())
        except:
            # Can't do null move if in check - skip this piece type check
            continue

        # Count legal moves for this piece type AFTER
        moves_after = 0
        for m in test_board.legal_moves:
            piece = test_board.piece_at(m.from_square)
            if piece and piece.piece_type == piece_type and piece.color == color:
                moves_after += 1
                break  # Just need to know if ANY move exists

        # Was blocked before (0 moves) but can move after?
        if moves_before == 0 and moves_after > 0:
            unblocked.append(piece_symbol)

    return unblocked


def count_future_moves_enabled(candidate_san: str, future_piece_moves: Dict,
                                fix_ply: int, stuck_ply: int, board: chess.Board,
                                verbose: bool = False) -> tuple:
    """
    Count how many future piece moves this fix might enable.

    IMPORTANT: Only counts future moves if this fix UNBLOCKS a piece that
    was previously unable to move. This prevents false positives like
    'Rg1' getting bonus for unrelated future rook moves.

    Returns (count, nearest_ply_bonus):
      - count: number of future moves by unblocked pieces
      - nearest_ply_bonus: bonus points for enabling the NEAREST future move

    Args:
        candidate_san: The proposed fix move in SAN notation
        future_piece_moves: Dict of piece_key -> list of (ply, move, confidence)
        fix_ply: The ply being fixed
        stuck_ply: The ply where we're stuck
        board: The chess board at fix_ply (before the candidate move)
        verbose: Print debug info
    """
    fix_piece = candidate_san[0] if candidate_san[0] in 'KQRBN' else 'P'
    fix_color_chess = chess.WHITE if fix_ply % 2 == 0 else chess.BLACK
    fix_color = 'W' if fix_ply % 2 == 0 else 'B'

    # Skip future move checking for pawns
    if fix_piece == 'P':
        return 0, 0

    # === KEY FIX: Check if this move UNBLOCKS any piece ===
    unblocked_piece_types = find_unblocked_pieces(board, candidate_san, fix_color_chess)

    if not unblocked_piece_types:
        # This fix doesn't unblock anything - no fut bonus
        if verbose:
            print(f"      FUT: {candidate_san} doesn't unblock any piece - no bonus")
        return 0, 0

    if verbose:
        print(f"      FUT: {candidate_san} unblocks: {unblocked_piece_types}")

    # === Only count future moves for UNBLOCKED piece types ===
    future_moves_enabled = 0
    nearest_reachable_ply = None

    for unblocked_piece in unblocked_piece_types:
        piece_key = f"{unblocked_piece}_{fix_color}"

        if piece_key not in future_piece_moves:
            continue

        for future_ply, future_move, future_conf in future_piece_moves[piece_key]:
            if future_conf < 0.70:
                continue

            # Count this future move (it's by the piece we unblocked)
            future_moves_enabled += 1

            if nearest_reachable_ply is None or future_ply < nearest_reachable_ply:
                nearest_reachable_ply = future_ply

            if verbose:
                print(f"        -> {future_move} @ ply {future_ply}: by unblocked {unblocked_piece}")

    # Calculate nearest ply bonus
    nearest_ply_bonus = 0
    if nearest_reachable_ply is not None:
        # Bonus for enabling moves soon after the fix
        ply_distance = nearest_reachable_ply - fix_ply
        if ply_distance <= 4:
            nearest_ply_bonus = 5
        elif ply_distance <= 8:
            nearest_ply_bonus = 3
        if verbose:
            print(f"      * BONUS: Enables future {unblocked_piece_types} move at ply {nearest_reachable_ply} "
                  f"(distance={ply_distance}, bonus={nearest_ply_bonus})")

    if verbose and future_moves_enabled > 0:
        print(f"      FUT RESULT: {candidate_san} enables {future_moves_enabled} future moves for {unblocked_piece_types}")

    return future_moves_enabled, nearest_ply_bonus


# =============================================================================
# ABSURDITY SEVERITY CALCULATION
# =============================================================================

def calculate_absurdity_penalty(absurdities: List[Absurdity]) -> int:
    """
    Calculate total absurdity penalty based on piece values at risk.

    Uses piece_value * 10 for penalties:
    - Queen hanging (severity=9): -90 points (devastating)
    - Rook hanging (severity=5): -50 points (very bad)
    - Minor piece hanging (severity=3): -30 points (bad)

    This ensures moves that hang pieces score MUCH lower,
    effectively disqualifying them as valid fixes.

    Note: The absurdity detection (would_capture_be_bad) uses quiescence
    search to distinguish real sacrifices from blunders. If a move is
    flagged as absurd, the system has determined there's no compensation.
    """
    if not absurdities:
        return 0

    total_penalty = 0
    for abs_item in absurdities:
        severity = abs_item.severity if hasattr(abs_item, 'severity') else 3
        # Penalty = piece_value * 10
        total_penalty += severity * 10

    return total_penalty


# =============================================================================
# FUTURE-CAPTURE BONUS (applies to ALL phases)
# =============================================================================

def compute_future_capture_bonus(candidate_san: str, fix_ply: int, moves: List[str],
                                  ocr_lookup: Dict[int, OCRMove], stuck_ply: int,
                                  verbose: bool = False) -> int:
    """
    For a fix that places a piece on square X, scan forward through raw OCR text
    for the first future reference to square X.

    - Opponent captures on X (OCR contains 'x' + square): +8 bonus
    - Same-color moves to X (no capture): -4 penalty
    - No future reference: no adjustment

    Only checks the FIRST reference, then stops.
    """
    dest = extract_destination(candidate_san)
    if not dest:
        return 0

    fix_piece = extract_piece_type(candidate_san)
    fix_color_is_white = (fix_ply % 2 == 0)

    # Scan forward from fix_ply+1 through all available OCR text
    for ply in range(fix_ply + 1, max(stuck_ply + 5, len(moves))):
        ocr_move = ocr_lookup.get(ply)
        if not ocr_move:
            continue
        ocr_text = ocr_move.top_move
        if not ocr_text:
            continue

        ocr_dest = extract_destination(ocr_text)
        is_same_color = (ply % 2 == 0) == fix_color_is_white

        # Departure check: same-color, same piece type moves AWAY from dest
        if is_same_color and extract_piece_type(ocr_text) == fix_piece:
            if ocr_dest and ocr_dest != dest:
                # Piece has left the fix square — stop scanning
                if is_geometrically_reachable(dest, ocr_dest, fix_piece):
                    if verbose:
                        print(f"      [FUTURE-CAPTURE] {candidate_san} -> {dest}: {fix_piece} departs to "
                              f"{ocr_dest} at {ply_to_str(ply)} (reachable) -> +4")
                    return 4
                else:
                    if verbose:
                        print(f"      [FUTURE-CAPTURE] {candidate_san} -> {dest}: {fix_piece} departs to "
                              f"{ocr_dest} at {ply_to_str(ply)} (not reachable) -> 0")
                    return 0

        # Check if this move references our destination square
        if ocr_dest != dest:
            continue

        # Found a reference! Is it a capture?
        is_opponent = not is_same_color
        is_capture = 'x' in ocr_text

        if is_opponent and is_capture:
            if verbose:
                print(f"      [FUTURE-CAPTURE] {candidate_san} -> {dest}: opponent captures at "
                      f"{ply_to_str(ply)} '{ocr_text}' -> +8")
            return 8
        elif not is_opponent and not is_capture:
            # Only penalize if same piece type returns to the square
            # Different piece type landing here is neutral (stop scanning)
            ocr_piece = extract_piece_type(ocr_text)
            if ocr_piece == fix_piece:
                if verbose:
                    print(f"      [FUTURE-CAPTURE] {candidate_san} -> {dest}: same-color same-piece moves to "
                          f"{ply_to_str(ply)} '{ocr_text}' -> -4")
                return -4
            else:
                if verbose:
                    print(f"      [FUTURE-CAPTURE] {candidate_san} -> {dest}: different piece {ocr_piece} moves to "
                          f"{ply_to_str(ply)} '{ocr_text}' -> 0 (neutral)")
                return 0
        else:
            # Same-color capture or opponent non-capture — neutral, stop looking
            return 0

    return 0  # No reference found


# =============================================================================
# PHASE 3: CHECK-BLOCKING SQUARE SEARCH
# =============================================================================

def _get_check_blocking_squares(board: chess.Board) -> Set[int]:
    """
    Get squares that would block the current check.
    Returns set of square indices, or empty set for knight/pawn checks.
    """
    if not board.is_check():
        return set()

    king_square = board.king(board.turn)
    checkers = board.checkers()
    blocking = set()

    for checker_sq in chess.scan_forward(checkers):
        checker_piece = board.piece_at(checker_sq)
        if checker_piece is None:
            continue

        piece_type = checker_piece.piece_type

        # Knights and pawns: no blocking squares (only king moves or capture)
        if piece_type in (chess.KNIGHT, chess.PAWN):
            continue

        # Sliding pieces (B, R, Q): find ray squares between checker and king
        between = chess.between(checker_sq, king_square)
        for sq in chess.scan_forward(between):
            blocking.add(sq)

    # Also include the checker square itself (capturing the checking piece)
    for checker_sq in chess.scan_forward(checkers):
        blocking.add(checker_sq)

    return blocking


def find_check_blocking_fixes(
    moves: List[str],
    stuck_ply: int,
    check_ply: int,
    ocr_lookup: Dict[int, OCRMove],
    locked_plies: Set[int] = None,
    fixed_plies: Set[int] = None,
    verbose: bool = False
) -> List[dict]:
    """
    Phase 3: Search ALL previous plies for moves that land on check-blocking squares.

    Triggered when:
    - A check symbol was auto-corrected at check_ply (e.g., Be6 -> Be6+)
    - The next move (stuck_ply = check_ply + 1) is illegal because it doesn't escape check

    Algorithm:
    1. Identify the check geometry (blocking squares)
    2. Search ALL plies (0 to stuck_ply) for moves landing on blocking squares
    3. Score each candidate normally (similarity, reach, absurdity, future-capture)
    """
    locked_plies = locked_plies or set()
    fixed_plies = fixed_plies or set()

    # Play to check_ply to get the check position
    board = chess.Board()
    for i in range(check_ply):
        m = try_move(board, moves[i])
        if not m:
            return []
        board.push(m)

    # Play the checking move
    check_move = try_move(board, moves[check_ply])
    if not check_move:
        return []
    board.push(check_move)

    # Now board is AFTER the checking move — opponent is in check
    if not board.is_check():
        if verbose:
            print(f"   [PHASE 3] Board not in check after {ply_to_str(check_ply)} — aborting")
        return []

    blocking_squares = _get_check_blocking_squares(board)
    if not blocking_squares:
        if verbose:
            print(f"   [PHASE 3] No blocking squares (knight/pawn check) — aborting")
        return []

    blocking_names = [chess.square_name(sq) for sq in blocking_squares]
    if verbose:
        print(f"\n   [PHASE 3] CHECK-BLOCKING SEARCH")
        print(f"   Check at {ply_to_str(check_ply)}, stuck at {ply_to_str(stuck_ply)}")
        print(f"   Blocking/capture squares: {blocking_names}")

    # Search all plies for moves landing on blocking squares
    fixes = []
    for fix_ply in range(stuck_ply):  # 0 to stuck_ply-1
        if fix_ply in locked_plies:
            continue
        if fix_ply >= len(moves):
            continue

        # Build position at fix_ply
        test_board = chess.Board()
        valid = True
        for i in range(fix_ply):
            m = try_move(test_board, moves[i])
            if m:
                test_board.push(m)
            else:
                valid = False
                break
        if not valid:
            continue

        # Check all legal moves at this ply — only consider those landing on blocking squares
        original_ocr = moves[fix_ply]
        candidates_found = 0

        for legal_move in test_board.legal_moves:
            if legal_move.to_square not in blocking_squares:
                continue

            candidate_san = test_board.san(legal_move)
            if candidate_san == original_ocr:
                continue  # Same as current move

            candidates_found += 1

            # Play forward: replace this move, then play remaining moves
            test_board_copy = test_board.copy()
            test_board_copy.push(legal_move)
            test_reach = fix_ply + 1
            for j in range(fix_ply + 1, len(moves)):
                m = try_move(test_board_copy, moves[j])
                if m:
                    test_board_copy.push(m)
                    test_reach = j + 1
                else:
                    break

            reach_improvement = test_reach - stuck_ply
            if reach_improvement <= 0:
                continue  # Must at least get past stuck point

            completes = (test_reach >= len(moves))
            char_sim = move_similarity(original_ocr, candidate_san)

            # OCR confidence
            ocr_move = ocr_lookup.get(fix_ply)
            ocr_conf = ocr_move.top_confidence if ocr_move else 0.5

            # Absurdity count (simplified — count how many absurdities in play-forward)
            absurdity_count = 0

            # Future-capture bonus
            future_bonus = compute_future_capture_bonus(
                candidate_san, fix_ply, moves, ocr_lookup, stuck_ply, verbose)

            # Unified score (simplified version of main scoring)
            unified_score = (
                char_sim * 40 +
                (25 if char_sim >= 0.90 else 0) +
                min(reach_improvement * 10, 50) +
                max(reach_improvement - 5, 0) +
                (30 if reach_improvement >= 10 and fix_ply >= stuck_ply else 0) +  # Only at stuck ply
                (5 if completes and absurdity_count <= 1 else 0) +
                ocr_conf * 15 +
                future_bonus
            )

            if verbose:
                blocking_sq_name = chess.square_name(legal_move.to_square)
                print(f"   [PHASE 3] {ply_to_str(fix_ply)} '{original_ocr}' -> '{candidate_san}' "
                      f"(lands on {blocking_sq_name}) | sim={char_sim:.0%}, +{reach_improvement} plies, "
                      f"future={future_bonus:+d}, score={unified_score:.0f}"
                      f"{' COMPLETES!' if completes else ''}")

            fixes.append({
                'ply': fix_ply,
                'san': candidate_san,
                'ocr': original_ocr,
                'reach': test_reach,
                'completes': completes,
                'reach_improvement': reach_improvement,
                'char_sim': char_sim,
                'ocr_conf': ocr_conf,
                'ocr_candidate_bonus': 0,
                'absurdity_count': absurdity_count,
                'absurdity_penalty': 0,
                'unified_score': unified_score,
                'original_was_legal': True,
                'is_absurdity_fix': False,
                'is_low_conf_fix': False,
                'is_check_mismatch_fix': False,
                'resolves_check_mismatch': False,
                'is_duplicate_fix': False,
                'resolves_duplicate': False,
                'is_duplicate_suspect': False,
                'is_duplicate_partner_fix': False,
                'duplicate_resolution_bonus': 0,
                'check_enabling_bonus': 0,
                'check_enabling_move': None,
                'check_forcing_bonus': 0,
                'check_forcing_response_fix': False,
                'future_capture_bonus': future_bonus,
                'phase': 'PHASE_3',
                'ply_str': ply_to_str(fix_ply),
                'similarity': round(char_sim * 100),
                'num_changes': sum(1 for a, b in zip(original_ocr, candidate_san) if a != b) +
                               abs(len(original_ocr) - len(candidate_san)),
            })

        if verbose and candidates_found > 0:
            pass  # Already printed above

    fixes.sort(key=lambda x: -x['unified_score'])

    if verbose:
        print(f"   [PHASE 3] Found {len(fixes)} check-blocking fixes")

    return fixes


# =============================================================================
# CORE FIX FINDING - DEEP BACKTRACK
# =============================================================================

def _precompute_backtrack_context(
    moves: List[str],
    stuck_ply: int,
    ocr_lookup: Dict[int, OCRMove],
    fixed_plies: Set[int],
    min_ply: int,
    verbose: bool,
    phase_label: str = None,  # e.g., "PHASE 1", "PHASE 2" - shown in output header
    original_stuck_ply: int = None,  # The real stuck ply from the user's perspective (for Phase 2 absurdity checking)
    locked_plies: Set[int] = None,  # Sacred plies — user confirmed OCR is correct, never search
    stuck_reason: str = None  # If provided from validation, skip redundant EAD replay
) -> dict:
    """
    Extract ALL precomputation from find_deep_backtrack_fixes into a reusable context.

    This is the SINGLE SOURCE OF TRUTH for backtrack search context.
    Both find_deep_backtrack_fixes() and BacktrackSearchState MUST use this function.

    DO NOT SIMPLIFY. This must be IDENTICAL to what find_deep_backtrack_fixes computed.

    Returns:
        dict with all precomputed state needed for the search loop
    """
    ctx = {}
    locked_plies = locked_plies or set()
    ctx['locked_plies'] = locked_plies

    # Store original stuck ply for absurdity checking
    # If not provided, assume this IS the original (Phase 1 case)
    ctx['original_stuck_ply'] = original_stuck_ply if original_stuck_ply is not None else stuck_ply

    # === EARLY ABSURDITY DETECTION (January 2026) ===
    # If a persistent absurdity is detected BEFORE the stuck_ply,
    # that's where the error actually is - we should search there instead.
    effective_stuck_ply = stuck_ply
    early_stop_reason = None
    early_absurdity = None

    if USE_EARLY_STOPPING:
        if stuck_reason:
            # Validation already ran EAD — skip the expensive full-game replay
            if stuck_reason in ("persistent_absurdity", "bad_trade", "piece_hanging"):
                early_stop_reason = stuck_reason
            if verbose:
                print(f"   [EAD] Skipped (reason from validation: {stuck_reason})")
        else:
            # CLI/API path — no prior validation, run full EAD
            ead_ply, stop_reason, absurdity_info = play_until_absurd_or_stuck(
                moves, severity_threshold=3, persistence_threshold=2
            )

            if stop_reason in ("persistent_absurdity", "bad_trade", "piece_hanging") and ead_ply <= stuck_ply:
                # BUT: If user already approved this ply (clicked "keep as-is"), don't override stuck_ply!
                if ead_ply in fixed_plies:
                    if verbose:
                        print(f"\n   [EAD] Absurdity at {ply_to_str(ead_ply)} but ply is APPROVED - ignoring")
                else:
                    # Absurdity detected - the error is likely at or before this ply
                    effective_stuck_ply = ead_ply
                    early_stop_reason = stop_reason
                    early_absurdity = absurdity_info

                # For bad trades and piece_hanging, flag but DON'T restrict search
                # The bad trade may be a SYMPTOM of an earlier OCR error
                if stop_reason == "bad_trade":
                    # DON'T restrict min_ply - allow backtracking to find root cause
                    if verbose:
                        print(f"\n   [!] BAD TRADE DETECTED at {ply_to_str(ead_ply)}:")
                        print(f"      {absurdity_info}")
                        print(f"      -> Bad trade may be SYMPTOM of earlier error - searching backward")
                elif stop_reason == "piece_hanging":
                    # Piece left hanging - search at this ply
                    if verbose:
                        print(f"\n   [!] PIECE HANGING at {ply_to_str(ead_ply)}:")
                        print(f"      {absurdity_info}")
                        print(f"      -> Searching at {ply_to_str(ead_ply)} for correct move")
                elif verbose:
                    print(f"\n   [!] EARLY ABSURDITY DETECTION (PERSISTENT ABSURDITY):")
                    print(f"      Original stuck at: {ply_to_str(stuck_ply)} (illegal move)")
                    print(f"      EAD detected: {ply_to_str(ead_ply)} ({absurdity_info})")
                    print(f"      -> Focusing search on earlier error location")
            elif stop_reason == "illegal" and ead_ply < stuck_ply:
                # EAD found illegal move earlier than expected (shouldn't happen often)
                effective_stuck_ply = ead_ply
                if verbose:
                    print(f"   [EAD] Illegal move at ply {ply_to_str(ead_ply)} (before expected {ply_to_str(stuck_ply)})")
            elif verbose:
                # No early stop or same stop point
                if stop_reason == "complete":
                    print(f"   [EAD] Game plays through completely (no absurdity detected)")
                else:
                    print(f"   [EAD] Stop at {ply_to_str(ead_ply)} ({stop_reason})")

    # Update search limit based on EAD
    ctx['effective_stuck_ply'] = effective_stuck_ply
    ctx['early_stop_reason'] = early_stop_reason
    ctx['early_absurdity'] = early_absurdity

    # NEW: Detect duplicate pawn moves in RAW OCR (before any board operations)
    # This catches impossible cases like h5 appearing twice for same color
    ocr_duplicates = find_duplicate_pawn_moves_in_ocr(ocr_lookup)
    duplicate_suspect_plies = set()

    # NEW: Build a mapping from each duplicate ply to its "partner" ply
    # So if 7.B and 15.B are duplicates, we can quickly find the partner
    duplicate_partners = {}  # ply -> partner_ply

    if ocr_duplicates:
        if verbose:
            print(f"\n   [WARN] DUPLICATE PAWN DETECTION (from raw OCR):")
        for dup in ocr_duplicates:
            duplicate_suspect_plies.add(dup['suspect_ply'])
            # Store BOTH plies as partners of each other
            duplicate_partners[dup['first_ply']] = dup['second_ply']
            duplicate_partners[dup['second_ply']] = dup['first_ply']
            if verbose:
                print(f"      - '{dup['move']}' ({dup['color']}) at "
                      f"{ply_to_str(dup['first_ply'])} ({dup['first_confidence']:.0%}) AND "
                      f"{ply_to_str(dup['second_ply'])} ({dup['second_confidence']:.0%})")
                print(f"        -> Suspect: {ply_to_str(dup['suspect_ply'])} (lower confidence)")
                print(f"        -> Partners linked: {ply_to_str(dup['first_ply'])} <-> {ply_to_str(dup['second_ply'])}")

    ctx['ocr_duplicates'] = ocr_duplicates
    ctx['duplicate_suspect_plies'] = duplicate_suspect_plies
    ctx['duplicate_partners'] = duplicate_partners

    total_moves = len(moves)
    search_limit = min(effective_stuck_ply, total_moves - 1)
    ctx['total_moves'] = total_moves
    ctx['search_limit'] = search_limit

    # Detect absurdities and suspicious plies (fast_mode for performance)
    absurdities = find_all_absurdities(moves, verbose=False, fast_mode=True)
    absurdity_plies = {a.ply for a in absurdities if a.ply < effective_stuck_ply and a.ply >= min_ply}
    ctx['absurdities'] = absurdities
    ctx['absurdity_plies'] = absurdity_plies

    # NEW: Detect check symbol mismatches - strong signal of earlier error
    if verbose:
        print(f"\n   [DEBUG] DETECTION PHASE: Scanning for check mismatches and duplicates...")
    check_mismatches = find_check_symbol_mismatches(moves[:effective_stuck_ply], verbose=verbose)
    check_mismatch_plies = {m['ply'] for m in check_mismatches}
    ctx['check_mismatches'] = check_mismatches
    ctx['check_mismatch_plies'] = check_mismatch_plies

    if verbose:
        if check_mismatches:
            print(f"   [WARN] FOUND {len(check_mismatches)} CHECK MISMATCH(ES)!")
            for cm in check_mismatches:
                print(f"      - {ply_to_str(cm['ply'])}: '{cm['move']}' - written as check but ISN'T check in our position")
        else:
            print(f"   [OK] No check mismatches found")

    # NEW: Detect duplicate pawn moves - impossible, one of them is wrong
    duplicate_pawns = find_duplicate_pawn_moves(moves[:effective_stuck_ply], verbose=verbose)

    if verbose:
        if duplicate_pawns:
            print(f"   [WARN] FOUND {len(duplicate_pawns)} DUPLICATE PAWN MOVE(S)!")
            for dp in duplicate_pawns:
                print(f"      - '{dp['move']}' at {ply_to_str(dp['first_ply'])} AND {ply_to_str(dp['second_ply'])} - impossible!")
        else:
            print(f"   [OK] No duplicate pawn moves found")
    duplicate_pawn_plies = set()
    for dup in duplicate_pawns:
        duplicate_pawn_plies.add(dup['first_ply'])  # Earlier one is likely wrong
        duplicate_pawn_plies.add(dup['second_ply'])
    ctx['duplicate_pawns'] = duplicate_pawns
    ctx['duplicate_pawn_plies'] = duplicate_pawn_plies

    # If we found check mismatches or duplicates, we need to search further back!
    # These are strong signals that errors occurred before min_ply
    extended_search_plies = set()

    # In Phase 2, skip check mismatch / duplicate pawn extended plies.
    # Phase 1 already searched those plies — Phase 2's job is to search the narrow
    # backward window, plus any TARGETED heuristics (blocker/occupant) for the real stuck move.
    is_phase_2 = (original_stuck_ply is not None and original_stuck_ply != stuck_ply)

    if check_mismatches and not is_phase_2:
        # OPTIMIZATION: Before expensive backward search, check if it's a simple typo
        # e.g., Qg5+ should be Qg3+ - same piece, different square
        for mismatch in check_mismatches:
            mismatch_ply = mismatch['ply']
            mismatch_move = mismatch['move']

            # Try to find a quick fix at the mismatch ply itself
            quick_fix_found = False

            # Build position at mismatch ply
            test_board = chess.Board()
            valid_position = True
            for i in range(mismatch_ply):
                m = try_move(test_board, moves[i])
                if m:
                    test_board.push(m)
                else:
                    valid_position = False
                    break

            if valid_position:
                # Extract piece type from mismatch move (e.g., Q from Qg5+)
                piece_char = mismatch_move[0] if mismatch_move[0] in 'KQRBN' else None

                # Find all legal moves by same piece that give check
                checking_moves = []
                for legal_move in test_board.legal_moves:
                    # Check if move gives check
                    if test_board.gives_check(legal_move):
                        san = test_board.san(legal_move)
                        # Check if same piece type (or pawn if no piece prefix)
                        move_piece = san[0] if san[0] in 'KQRBN' else None
                        if move_piece == piece_char:
                            sim = move_similarity(mismatch_move, san)
                            checking_moves.append((san, sim))

                # If we found a high-similarity checking move, it's likely the fix!
                if checking_moves:
                    best_check = max(checking_moves, key=lambda x: x[1])
                    if best_check[1] >= 0.70:  # High similarity threshold
                        quick_fix_found = True
                        # Only add the mismatch ply to search - no need for full backward search
                        extended_search_plies.add(mismatch_ply)
                        if verbose:
                            print(f"   [SEARCH] CHECK MISMATCH at {ply_to_str(mismatch_ply)}: '{mismatch_move}' has + but doesn't give check!")
                            print(f"      -> QUICK FIX FOUND: '{best_check[0]}' gives check (similarity {best_check[1]:.0%})")
                            print(f"      -> Searching only mismatch ply (no backward search needed)")

            # If no quick fix, do full backward search
            if not quick_fix_found:
                # Search ALL plies from 0 to the mismatch - the error could be anywhere!
                for search_ply in range(0, mismatch_ply + 1):
                    extended_search_plies.add(search_ply)
                if verbose:
                    print(f"   [SEARCH] CHECK MISMATCH at {ply_to_str(mismatch_ply)}: '{mismatch_move}' has + but doesn't give check!")
                    print(f"      -> No quick fix found, searching ALL plies 0 to {ply_to_str(mismatch_ply)} for root cause")
    elif check_mismatches and is_phase_2 and verbose:
        print(f"   [PHASE 2] Skipping {len(check_mismatches)} check mismatch extended plies (already searched in Phase 1)")

    if duplicate_pawns and not is_phase_2:
        for dup in duplicate_pawns:
            extended_search_plies.add(dup['first_ply'])
            if verbose:
                print(f"   [SEARCH] Duplicate pawn '{dup['move']}' - adding ply {ply_to_str(dup['first_ply'])} to search")
    elif duplicate_pawns and is_phase_2 and verbose:
        print(f"   [PHASE 2] Skipping {len(duplicate_pawns)} duplicate pawn extended plies (already searched in Phase 1)")

    if not is_phase_2:
        # Also add OCR duplicate suspects to extended search
        for suspect_ply in duplicate_suspect_plies:
            extended_search_plies.add(suspect_ply)

        # TARGETED DUPLICATE PARTNER SEARCH
        # If we're stuck at a ply that's part of a duplicate pair,
        # add the PARTNER ply to the search WITHOUT doing full backward search!
        if effective_stuck_ply in duplicate_partners:
            partner_ply = duplicate_partners[effective_stuck_ply]
            extended_search_plies.add(partner_ply)
            if verbose:
                print(f"   [LINK] TARGETED DUPLICATE SEARCH: Stuck at {ply_to_str(effective_stuck_ply)}, "
                      f"adding partner ply {ply_to_str(partner_ply)} to search")

        # Also check: if ANY ply in the normal search range has a partner outside the range,
        # add that partner too
        for ply in range(min_ply, search_limit + 1):
            if ply in duplicate_partners:
                partner = duplicate_partners[ply]
                if partner < min_ply:  # Partner is before our search range
                    extended_search_plies.add(partner)
                    if verbose:
                        print(f"   [LINK] TARGETED: {ply_to_str(ply)} has duplicate partner at "
                              f"{ply_to_str(partner)} (before frontier) - adding to search")

    # BLOCKER DETECTION HEURISTIC
    # If stuck move is illegal due to a friendly piece blocking, add candidate plies to search.
    # The candidates go through the normal search loop so they get full/correct scoring.
    # In Phase 2, use the REAL stuck move (original_stuck_ply) — Phase 2's stuck_ply is artificial.
    blocker_stuck_ply = ctx['original_stuck_ply']
    stuck_move = moves[blocker_stuck_ply] if blocker_stuck_ply < len(moves) else ''
    blocker_candidates = []
    if stuck_move:
        blocker_candidates = find_blocker_candidates(moves, blocker_stuck_ply, stuck_move, ocr_lookup, verbose=verbose)
        # Add candidate plies to extended search (they'll be searched with full scoring)
        for cand in blocker_candidates:
            extended_search_plies.add(cand['ply'])

        if verbose:
            if blocker_candidates:
                print(f"   [BLOCKER] Found {len(blocker_candidates)} candidate(s) - adding plies to search:")
                for cand in blocker_candidates:
                    print(f"      -> {ply_to_str(cand['ply'])} '{cand['original']}' -> '{cand['clearing_move']}' (sim={cand['similarity']:.0%})")
            else:
                print(f"   [BLOCKER] No blocker candidates for '{stuck_move}'")

    ctx['blocker_candidates'] = blocker_candidates

    # DESTINATION OCCUPANT HEURISTIC
    # If stuck move is illegal because a friendly piece sits on the destination square,
    # find the move that placed it there and add that ply to the search.
    # Uses same blocker_stuck_ply as blocker heuristic (real stuck move in Phase 2).
    occupant_candidates = []
    if stuck_move:
        occupant_candidates = find_destination_occupant_candidates(moves, blocker_stuck_ply, stuck_move, ocr_lookup, verbose=verbose)
        for cand in occupant_candidates:
            extended_search_plies.add(cand['ply'])

        if verbose:
            if occupant_candidates:
                print(f"   [OCCUPANT] Found {len(occupant_candidates)} candidate(s) - adding plies to search:")
                for cand in occupant_candidates:
                    print(f"      -> {ply_to_str(cand['ply'])} '{cand['original']}' -> '{cand['alternative']}' (sim={cand['similarity']:.0%})")
            else:
                print(f"   [OCCUPANT] No destination occupant candidates for '{stuck_move}'")

    ctx['occupant_candidates'] = occupant_candidates

    # Find suspicious plies (low OCR confidence)
    suspicious_plies = set()
    for ply in range(min_ply, effective_stuck_ply):
        ocr_m = ocr_lookup.get(ply)
        if ocr_m:
            if ocr_m.top_confidence < 0.80:
                suspicious_plies.add(ply)
            if len(ocr_m.candidates) > 1 and ocr_m.candidates[1][1] > 0.05:
                suspicious_plies.add(ply)

    # Also check extended search range for low confidence
    for ply in extended_search_plies:
        ocr_m = ocr_lookup.get(ply)
        if ocr_m and ocr_m.top_confidence < 0.80:
            suspicious_plies.add(ply)

    ctx['suspicious_plies'] = suspicious_plies

    if verbose:
        print(f"\n   {'='*60}")
        print(f"   [SEARCH] DEEP BACKTRACK SEARCH [v2.0.1 - 2026-02-06]")
        print(f"   {'='*60}")
        print(f"   - Normal search range: plies {min_ply} to {search_limit}")
        print(f"   - Total plies in normal range: {search_limit - min_ply + 1}")
        # DEBUG: Show moves around stuck ply and ply 7 (4.B)
        print(f"   - MOVES around stuck ply ({effective_stuck_ply}):")
        for dbg_ply in range(max(0, effective_stuck_ply-3), min(len(moves), effective_stuck_ply+3)):
            marker = " <-- STUCK" if dbg_ply == effective_stuck_ply else ""
            print(f"     Ply {dbg_ply} ({ply_to_str(dbg_ply)}): '{moves[dbg_ply]}'{marker}")
        if effective_stuck_ply > 10:
            print(f"   - MOVES around ply 7 (4.B):")
            for dbg_ply in range(5, min(len(moves), 12)):
                print(f"     Ply {dbg_ply} ({ply_to_str(dbg_ply)}): '{moves[dbg_ply]}'")
        if extended_search_plies:
            print(f"   - DETECTED extended plies: {len(extended_search_plies)} (from heuristics)")
            # Show which plies are before frontier vs in normal range
            before_frontier = [p for p in extended_search_plies if p < min_ply]
            in_normal_range = [p for p in extended_search_plies if min_ply <= p <= effective_stuck_ply]
            beyond_stuck = [p for p in extended_search_plies if p > effective_stuck_ply]
            if before_frontier:
                print(f"     -> BEFORE FRONTIER: {sorted(before_frontier)} (will search - heuristic override)")
            if in_normal_range:
                print(f"     -> IN RANGE [{min_ply}-{effective_stuck_ply}]: {sorted(in_normal_range)} (will search)")
            if beyond_stuck:
                print(f"     -> BEYOND STUCK: {sorted(beyond_stuck)} (ignored - can't search past stuck point)")
        print(f"   - Absurdity plies: {sorted(absurdity_plies) if absurdity_plies else 'none'}")
        print(f"   - Check mismatch plies: {sorted(check_mismatch_plies) if check_mismatch_plies else 'none'}")
        print(f"   - Duplicate pawn plies: {sorted(duplicate_pawn_plies) if duplicate_pawn_plies else 'none'}")
        print(f"   - Low-confidence plies: {sorted(suspicious_plies) if suspicious_plies else 'none'}")
        print(f"   {'='*60}")

    # Scan for future piece moves
    if verbose:
        print(f"   [TRACE] About to scan future piece moves...")
    future_piece_moves = scan_future_piece_moves(ocr_lookup, effective_stuck_ply, total_moves)
    ctx['future_piece_moves'] = future_piece_moves
    if verbose:
        print(f"   [TRACE] Scanned {len(future_piece_moves)} future piece move types")

    # NEW: Detect if stuck move has check symbol but is illegal
    # This is DIFFERENT from check_mismatches which handles LEGAL moves that don't give check
    stuck_move_has_check = False
    stuck_move_ocr = ""
    if effective_stuck_ply < len(moves):
        stuck_move_ocr = moves[effective_stuck_ply]
        stuck_move_has_check = '+' in stuck_move_ocr
        if stuck_move_has_check and verbose:
            print(f"   [CHECK-ENABLE] Stuck move '{stuck_move_ocr}' has check symbol but is illegal")
            print(f"   [CHECK-ENABLE] Will bonus earlier fixes that enable similar checking moves")

    ctx['stuck_move_has_check'] = stuck_move_has_check
    ctx['stuck_move_ocr'] = stuck_move_ocr

    # Parse stuck move destination square for "clears destination" bonus
    # Use the ORIGINAL stuck ply (before EAD adjustment) because the bonus is about
    # clearing the square that the original stuck move wants to reach (e.g., Qd4 → d4),
    # not the EAD absurdity point (e.g., Bxc5 → c5).
    stuck_dest_square = None
    original_stuck_ply_val = ctx['original_stuck_ply']
    original_stuck_move = moves[original_stuck_ply_val] if original_stuck_ply_val < len(moves) else ""
    if original_stuck_move:
        clean = original_stuck_move.replace('+', '').replace('#', '').replace('x', '')
        for idx in range(len(clean) - 1, 0, -1):
            if clean[idx-1] in 'abcdefgh' and clean[idx] in '12345678':
                try:
                    stuck_dest_square = chess.parse_square(clean[idx-1:idx+1])
                except:
                    pass
                break
    ctx['stuck_dest_square'] = stuck_dest_square
    if verbose and stuck_dest_square is not None:
        src = "original" if original_stuck_ply_val != effective_stuck_ply else "stuck"
        print(f"   [DEST] {src.title()} stuck move '{original_stuck_move}' targets {chess.square_name(stuck_dest_square)}")

    if verbose and future_piece_moves:
        for piece_key, moves_list in future_piece_moves.items():
            if len(moves_list) >= 1:
                preview = moves_list[:3]
                print(f"   [PREVIEW] Future {piece_key} moves: {[(ply_to_str(p), m) for p, m, _ in preview]}")

    # Filter extended_search_plies:
    # - Upper bound (stuck_ply): NEVER search beyond where we're stuck
    # - Lower bound: DO allow searching before min_ply!
    #   The whole point of heuristics (blocker, check mismatch, duplicates) is to find
    #   candidates BEFORE the frontier that might be causing the problem.
    extended_search_plies = {p for p in extended_search_plies if p <= effective_stuck_ply}
    ctx['extended_search_plies'] = extended_search_plies

    # Track which extended plies are before the frontier (for debug output)
    extended_before_frontier = {p for p in extended_search_plies if p < min_ply}
    if verbose and extended_before_frontier:
        print(f"\n   [EXTENDED] {len(extended_before_frontier)} plies BEFORE frontier added by heuristics:")
        for p in sorted(extended_before_frontier):
            print(f"      -> {ply_to_str(p)} '{moves[p] if p < len(moves) else '?'}'")

    # Search each ply (starting from min_ply, plus any extended search plies INCLUDING those before frontier)
    all_search_plies = set(range(min_ply, search_limit + 1)) | extended_search_plies
    ctx['all_search_plies'] = all_search_plies
    if verbose:
        print(f"   [TRACE] Built all_search_plies: {len(all_search_plies)} plies")

    # === SEARCH ORDER OPTIMIZATION ===
    # Search stuck_ply FIRST (highest ply), then work backwards.
    # This allows early exit to trigger immediately for simple OCR errors
    # at the stuck point, avoiding unnecessary searches at earlier plies.
    # Filter out locked plies (sacred — user confirmed OCR is correct)
    if locked_plies:
        all_search_plies -= locked_plies
        if verbose:
            removed = locked_plies & (all_search_plies | locked_plies)
            if removed:
                print(f"   [LOCK] Excluded locked plies from search: {[ply_to_str(p) for p in sorted(removed)]}")
    search_order = sorted(all_search_plies, reverse=True)
    ctx['search_order'] = search_order
    ctx['min_ply'] = min_ply  # Store min_ply in context for use by _search_single_ply_for_fixes
    ctx['phase_label'] = phase_label  # Store phase_label so search loop can reference it
    if verbose:
        print(f"   [TRACE] Built search_order: {len(search_order)} plies, phase_label={phase_label!r}")

    if verbose:
        label = f"[{phase_label}]" if phase_label else "[BACKTRACK]"
        stuck_move_text = moves[effective_stuck_ply] if effective_stuck_ply < len(moves) else '?'
        search_type = ""
        if phase_label == "DUAL":
            search_type = f" (DUAL SEARCH — using secondary candidate: '{stuck_move_text}')"
        elif phase_label == "PHASE 1":
            search_type = f" (PRIMARY SEARCH — OCR top: '{stuck_move_text}')"
        print(f"\n   {'='*60}")
        print(f"   {label} SEARCHING BACKWARDS: {ply_to_str(effective_stuck_ply)} down to {ply_to_str(min_ply)}{search_type}")
        print(f"   {'='*60}")
        print(f"   - stuck_ply={effective_stuck_ply} ({ply_to_str(effective_stuck_ply)}), search_limit={search_limit} ({ply_to_str(search_limit)})")
        print(f"   - min_ply={min_ply} ({ply_to_str(min_ply)}), total plies to search: {len(all_search_plies)}")
        print(f"   - Search order (backwards): {[ply_to_str(p) for p in search_order[:10]]}{'...' if len(search_order) > 10 else ''}")

    # Cache board at min_ply for efficient per-ply replay in search_next_ply()
    # Instead of replaying from ply 0 for every ply searched, start from this cached position
    cached_board = chess.Board()
    cached_board_ply = 0
    for i in range(min_ply):
        m = try_move(cached_board, moves[i])
        if m:
            cached_board.push(m)
            cached_board_ply = i + 1
        else:
            break
    ctx['cached_board_at_min_ply'] = cached_board
    ctx['cached_board_ply'] = cached_board_ply

    return ctx


# =============================================================================
# LENIENT CANDIDATE SEARCH
# =============================================================================

def find_lenient_candidates(
    ply: int,
    board: chess.Board,
    ocr_lookup: Dict[int, OCRMove],
    verbose: bool = False
) -> List[dict]:
    """
    Search lenient OCR alternatives for the given ply and normalize to legal SAN.

    Only called at the stuck ply (or plies where standard fixes failed).
    Uses the lenient_candidates field on OCRMove, which contains non-standard
    notation alternatives from the lenient grammar decode.

    Args:
        ply: The ply to search
        board: Chess board at this ply position
        ocr_lookup: Dict mapping ply -> OCRMove
        verbose: Print debug info

    Returns:
        List of fix candidate dicts with keys: san, raw, notation_type, ambiguous,
        confidence, source='lenient_grammar'
    """
    ocr_m = ocr_lookup.get(ply)
    if not ocr_m or not ocr_m.lenient_candidates:
        return []

    results = []
    seen_san = set()

    if verbose:
        print(f"      [LENIENT] {len(ocr_m.lenient_candidates)} lenient candidates at {ply_to_str(ply)}: "
              f"{ocr_m.lenient_candidates[:5]}")

    for raw_move, confidence in ocr_m.lenient_candidates:
        if not raw_move:
            continue

        norm = normalize_lenient_move(raw_move, board)

        if verbose:
            print(f"        [LENIENT] '{raw_move}' -> {norm['san']} ({norm['notation_type']}"
                  f"{', AMBIGUOUS' if norm['ambiguous'] else ''})")

        if norm['san'] and norm['san'] not in seen_san:
            # Verify it's actually legal
            m = try_move(board, norm['san'], auto_correct=False)
            if m:
                seen_san.add(norm['san'])
                results.append({
                    'san': norm['san'],
                    'raw': raw_move,
                    'notation_type': norm['notation_type'],
                    'ambiguous': norm['ambiguous'],
                    'confidence': confidence,
                    'source': 'lenient_grammar',
                })

    if verbose and results:
        print(f"      [LENIENT] Found {len(results)} legal lenient candidates: "
              f"{[(r['san'], r['raw']) for r in results]}")

    return results


def _search_single_ply_for_fixes(
    fix_ply: int,
    board: chess.Board,
    moves: List[str],
    stuck_ply: int,
    ocr_lookup: Dict[int, OCRMove],
    ctx: dict,
    fixed_plies: Set[int],
    verbose: bool = False
) -> Tuple[List[dict], bool]:
    """
    Search a single ply for fixes. SINGLE SOURCE OF TRUTH for all scoring.

    This function contains the EXACT logic that was inside the
    `for fix_ply in search_order:` loop of find_deep_backtrack_fixes.
    NOTHING has been simplified, removed, or changed.

    Both find_deep_backtrack_fixes() and BacktrackSearchState.search_next_ply()
    MUST call this function. No other code path may compute fix scores.

    Args:
        fix_ply: The ply to search for fixes
        board: Chess board at position fix_ply (caller builds this)
        moves: Full list of moves
        stuck_ply: The effective stuck ply (may be adjusted by EAD)
        ocr_lookup: Dict mapping ply -> OCRMove
        ctx: Precomputed context from _precompute_backtrack_context()
        fixed_plies: Set of already-fixed plies to skip
        verbose: Print debug info

    Returns:
        Tuple of (list of fix dicts, early_exit flag)
    """
    fixes = []
    early_exit = False

    # Extract context variables
    total_moves = ctx['total_moves']
    search_limit = ctx['search_limit']
    absurdity_plies = ctx['absurdity_plies']
    check_mismatches = ctx['check_mismatches']
    check_mismatch_plies = ctx['check_mismatch_plies']
    duplicate_pawn_plies = ctx['duplicate_pawn_plies']
    duplicate_suspect_plies = ctx['duplicate_suspect_plies']
    duplicate_partners = ctx['duplicate_partners']
    extended_search_plies = ctx['extended_search_plies']
    suspicious_plies = ctx['suspicious_plies']
    future_piece_moves = ctx['future_piece_moves']
    stuck_move_has_check = ctx['stuck_move_has_check']
    stuck_move_ocr = ctx['stuck_move_ocr']
    stuck_dest_square = ctx.get('stuck_dest_square')
    min_ply = ctx.get('min_ply', 0)

    original_move = moves[fix_ply]
    ocr_m = ocr_lookup.get(fix_ply)
    original_ocr = ocr_m.top_move if ocr_m else original_move

    # Check if original move is legal (without auto-correct at stuck_ply!)
    # At stuck_ply: if we're stuck here, the move is effectively illegal
    # (either truly illegal, or blocked by semantic check after auto-correct)
    # So we MUST NOT skip similar moves like Qxd4 when OCR says Qxd4+
    if fix_ply == stuck_ply:
        # Force False at stuck_ply - if it were legal, we wouldn't be stuck!
        original_was_legal = False
    else:
        original_was_legal = try_move(board, original_move) is not None

    # DEBUG: Show OCR candidates for EVERY ply being searched
    if verbose:
        legal_str = "LEGAL" if original_was_legal else "ILLEGAL"
        if ocr_m:
            cands = ocr_m.candidates
            print(f"       [OCR] {len(cands)} candidates = {cands[:5]} | original '{original_move}' is {legal_str}")
        else:
            print(f"       [OCR] NO OCR DATA | original '{original_move}' is {legal_str}")

    # DEBUG: Show OCR candidate analysis for this ply (once per ply)
    if verbose and ocr_m and ocr_m.candidates and fix_ply == stuck_ply:
        print(f"\n   [ANALYSIS] OCR CANDIDATE ANALYSIS for {ply_to_str(fix_ply)} (OCR: '{original_ocr}'):")
        print(f"      Candidates: {ocr_m.candidates[:5]}")
        ply_analysis = analyze_ocr_candidates(ocr_m.candidates, verbose=True)
        print(f"      piece_prefixes: {dict(ply_analysis['piece_prefixes'])}")
        print(f"      piece_move_ratio: {ply_analysis['piece_move_ratio']:.0%}")
        print(f"      destinations: {dict(ply_analysis['destinations'])}")
        print(f"      capture_ratio: {ply_analysis['capture_ratio']:.0%}")
        print(f"      top_pieces: {ply_analysis['top_pieces']}")

    # Try each legal move as a fix
    legal_moves_list = list(board.legal_moves)

    # Compute best available capture gain ONCE per ply (used to penalize missed captures)
    # BUT: if the side is in check, they can't freely capture — any capture must also
    # address the check. find_best_capture_gain uses is_attacked_by which doesn't respect
    # legality, so we zero it out when in check to avoid unfair penalties.
    position_is_check = board.is_check()
    # If only one legal move exists, the move is completely forced — no penalties should apply
    forced_move = position_is_check and len(legal_moves_list) == 1
    best_capture_gain = 0 if position_is_check else find_best_capture_gain(board)

    if verbose:
        sample_sans = [board.san(m) for m in legal_moves_list[:8]]
        print(f"       [LEGAL] {len(legal_moves_list)} legal moves: {sample_sans}{'...' if len(legal_moves_list) > 8 else ''}")
        if best_capture_gain >= 2:
            print(f"       [CAPTURE] Best available capture gain: {best_capture_gain} (fixes ignoring this will be penalized)")
        # Check specifically for xd4 moves (common issue area)
        xd4_moves = [board.san(m) for m in legal_moves_list if 'd4' in board.san(m)]
        if xd4_moves:
            print(f"       [DEBUG] d4 moves in legal list: {xd4_moves}")

    fixes_at_ply = 0
    skipped_same = 0
    for legal_move in legal_moves_list:
        candidate_san = board.san(legal_move)

        # Skip if this is effectively the same move as the OCR text (ignoring check notation)
        # Compare against original_ocr (what OCR read) not original_move (which may have been fixed)
        # BUT only skip if the original was legal - if it was illegal, we want to suggest similar moves!
        # Example: OCR says "Qxd4+" but it's illegal (no check), we should suggest "Qxd4"
        norm_cand = normalize_move_for_comparison(candidate_san)
        norm_ocr = normalize_move_for_comparison(original_ocr)
        if original_was_legal and norm_cand == norm_ocr:
            skipped_same += 1
            # Show skipped moves at stuck_ply (helps debug normalization issues)
            if verbose and fix_ply == stuck_ply:
                print(f"         [SKIP] {candidate_san} - same as '{original_ocr}' (norm: {norm_cand})")
            continue

        # DEBUG: Track captures on d4 (common issue area)
        if 'xd4' in candidate_san:
            if verbose:
                print(f"   [DEBUG] CONSIDERING '{candidate_san}' at {ply_to_str(fix_ply)}: "
                      f"ocr='{original_ocr}', was_legal={original_was_legal}, "
                      f"norm_cand='{norm_cand}', norm_ocr='{norm_ocr}'")

        # Test the fix — start from current position instead of replaying from ply 0
        test_board_start = board.copy()
        test_board_start.push(legal_move)
        test_moves = moves.copy()
        test_moves[fix_ply] = candidate_san
        test_reach, test_board = play_until_stuck(test_moves, board=test_board_start, start=fix_ply + 1)

        reach_improvement = test_reach - stuck_ply

        # DEBUG: Show what's happening for promising fixes (d6-like pawn moves)
        if verbose and fix_ply < stuck_ply and candidate_san in ['d6', 'd5', 'd4', 'd3']:
            print(f"   [REACH DEBUG] Testing {original_ocr}->{candidate_san} at ply {ply_to_str(fix_ply)}")
            print(f"   [REACH DEBUG]   stuck_ply={stuck_ply}, test_reach={test_reach}, reach_improvement={reach_improvement}")
            if test_reach < len(test_moves):
                print(f"   [REACH DEBUG]   Failed at ply {test_reach}: move='{test_moves[test_reach]}'")
                print(f"   [REACH DEBUG]   Position FEN: {test_board.fen()}")
                print(f"   [REACH DEBUG]   Legal moves: {[test_board.san(m) for m in list(test_board.legal_moves)[:10]]}")
        char_sim = move_similarity(original_ocr, candidate_san)
        ocr_conf = ocr_m.get_confidence(candidate_san) if ocr_m else 0.0

        # === Calculate absurdity count early (needed for check-enabling bonus) ===
        # IMPORTANT: Only count absurdities FROM fix_ply onwards!
        # Pre-existing absurdities (before fix_ply) shouldn't penalize this fix.
        # E.g., if user accepted a "bad trade" at 11.W, that shouldn't hurt a fix at 18.W.
        # Absurdities AFTER stuck_ply are caused by later OCR errors, not this fix.
        # NOTE: Using fast_mode=True here for speed. Top candidates are re-verified later with fast_mode=False.
        # Use the ORIGINAL stuck ply for absurdity checking, not the Phase 2 search limit.
        # Phase 2 fixes must be checked for absurdities all the way up to where the user
        # is actually stuck, not just up to the Phase 2 search boundary.
        original_stuck = ctx.get('original_stuck_ply', stuck_ply)
        absurdity_check_limit = min(test_reach, original_stuck + 1)
        absurdities_result = find_all_absurdities(test_moves[:absurdity_check_limit], verbose=False, fast_mode=True,
                                                    start_ply=fix_ply, board=board)
        # Filter is no longer needed — start_ply=fix_ply already skips earlier plies
        # But keep filtering for safety (no-op since all results are >= fix_ply)
        absurdities_result = [a for a in absurdities_result if a.ply >= fix_ply]
        # If the move at fix_ply is forced (only legal move in check), don't penalize
        # absurdities AT that ply — the player had no choice
        if forced_move:
            absurdities_result = [a for a in absurdities_result if a.ply != fix_ply]
        absurdity_count = len(absurdities_result)

        # === NEW: Check-Forcing Bonus ===
        # If this fix gives check and we get stuck immediately after,
        # it's likely because the opponent's response has an OCR error
        # (e.g., R→K confusion: "Rd7" should be "Kd7" to respond to check)
        check_forcing_bonus = 0
        check_forcing_response_fix = None

        if reach_improvement == 1 and test_board.is_check():
            # The fix gives check, but we got stuck on the very next move
            # This is likely because the opponent's response doesn't handle check
            next_ply = fix_ply + 1
            if next_ply < len(moves):
                next_ocr = moves[next_ply]
                # Check for common piece confusions that could fix the response
                # R→K is the most common (Rd7 → Kd7)
                if next_ocr and len(next_ocr) > 0 and next_ocr[0] in 'RQBN':
                    # Try King instead of the piece
                    k_variant = 'K' + next_ocr[1:]
                    try:
                        k_move = test_board.parse_san(k_variant)
                        if k_move in test_board.legal_moves:
                            # Yes! K-version of the response is legal
                            check_forcing_bonus = 35  # Significant bonus
                            check_forcing_response_fix = k_variant
                            if verbose:
                                print(f"      [CHECK-FORCE] {candidate_san} gives check, response '{next_ocr}' "
                                      f"fixable as '{k_variant}' (bonus=+{check_forcing_bonus})")
                    except:
                        pass

                # If no specific fix found, still give a smaller bonus for check-giving moves
                # that get stuck immediately (the response is LIKELY wrong)
                if check_forcing_bonus == 0:
                    check_forcing_bonus = 15
                    if verbose:
                        print(f"      [CHECK-FORCE] {candidate_san} gives check, response '{next_ocr}' "
                              f"doesn't handle check (bonus=+{check_forcing_bonus})")

        # === NEW: Check-Enabling Bonus ===
        # If the stuck move has a check symbol (+) but was illegal,
        # give bonus to earlier fixes that ENABLE a checking move
        # with reasonable similarity to the stuck move.
        check_enabling_bonus = 0
        check_enabling_move = None

        if stuck_move_has_check and fix_ply < stuck_ply:
            # This is an earlier fix - check if it enables a plausible check
            # We need to replay to the stuck position with this fix applied

            # Only evaluate if we can reach the stuck_ply with this fix
            if test_reach >= stuck_ply:
                # Build board position at stuck_ply with this fix applied
                check_test_board = chess.Board()
                check_test_valid = True
                for i in range(stuck_ply):
                    if i < len(test_moves):
                        m = try_move(check_test_board, test_moves[i])
                        if m:
                            check_test_board.push(m)
                        else:
                            check_test_valid = False
                            break

                if check_test_valid:
                    # First, find what checking moves are already legal in ORIGINAL position
                    # (without this fix applied). Only give bonus if the fix ENABLES a NEW check.
                    original_check_board = chess.Board()
                    original_check_valid = True
                    for i in range(stuck_ply):
                        if i < len(moves):  # Use ORIGINAL moves, not test_moves
                            m = try_move(original_check_board, moves[i])
                            if m:
                                original_check_board.push(m)
                            else:
                                original_check_valid = False
                                break

                    # Get set of checking moves already possible in original position
                    original_legal_checks = set()
                    if original_check_valid:
                        for m in original_check_board.legal_moves:
                            if original_check_board.gives_check(m):
                                original_legal_checks.add(original_check_board.san(m))

                    # Find all legal moves that give check
                    # (This is usually 0-5 moves, very cheap to compute)
                    best_check_sim = 0.0
                    best_check_move = None

                    for legal_check_move in check_test_board.legal_moves:
                        if check_test_board.gives_check(legal_check_move):
                            check_san = check_test_board.san(legal_check_move)
                            # Skip if this check was already possible without the fix
                            if check_san in original_legal_checks:
                                continue
                            # Compare to the stuck move OCR text
                            check_sim = move_similarity(stuck_move_ocr, check_san)
                            if check_sim > best_check_sim:
                                best_check_sim = check_sim
                                best_check_move = check_san

                    # Award bonus if we found a similar checking move that is NEWLY enabled
                    # BUT block the bonus if this fix creates absurdities (e.g., hangs a piece)
                    if best_check_sim >= 0.40 and absurdity_count == 0:
                        # Scale bonus by similarity: 40% sim = 20 pts, 60% sim = 35 pts, 80% sim = 50 pts
                        check_enabling_bonus = int(20 + (best_check_sim - 0.40) * 75)
                        check_enabling_move = best_check_move
                        if verbose:
                            print(f"      [CHECK-ENABLE] Fix {candidate_san} at {ply_to_str(fix_ply)} "
                                  f"enables '{best_check_move}' (sim={best_check_sim:.0%}, bonus=+{check_enabling_bonus})")
                    elif best_check_sim >= 0.40 and absurdity_count > 0:
                        if verbose:
                            print(f"      [CHECK-ENABLE] Bonus blocked for {candidate_san} - fix creates {absurdity_count} absurdity(ies)")

        # === NEW: Stuck Move Check Bonus ===
        # If the stuck move has a check symbol (+) AND we're fixing the stuck move itself
        # AND the candidate move gives check, give a strong bonus.
        # This addresses the case where Qd2+ → Qg3+ should be highly preferred over
        # an earlier fix that merely "enables" a checking move.
        stuck_move_check_bonus = 0
        if stuck_move_has_check and fix_ply == stuck_ply:
            if board.gives_check(legal_move):
                # Fix at stuck ply from one check to another check - strong signal!
                stuck_move_check_bonus = 50
                if verbose:
                    print(f"      [STUCK-CHECK] Fix {candidate_san} at stuck ply gives check matching OCR check symbol (bonus=+{stuck_move_check_bonus})")

        # Check if piece hangs after this move
        # When move is forced (only legal move in check), skip ALL penalties
        if forced_move:
            is_hanging, hanging_value = False, 0
            pawn_hang_count = 0
        else:
            is_hanging, hanging_value = is_piece_hanging_after_move(board, legal_move)
            # When in check, pawns hanging elsewhere are collateral — can't help them
            pawn_hang_count = 0 if position_is_check else count_hanging_pawns_after_move(board, legal_move)

        # Inclusion logic
        is_suspicious_ply = (fix_ply in absurdity_plies or
                            fix_ply in suspicious_plies or
                            fix_ply in check_mismatch_plies or
                            fix_ply in duplicate_pawn_plies or
                            fix_ply in extended_search_plies)

        # No similarity filter — let the scoring system rank all legal moves.
        # Low-similarity moves will naturally get low scores and sort to the bottom.

        completes = test_reach >= total_moves
        # Note: absurdities_result and absurdity_count already calculated above
        # (needed earlier for check-enabling bonus decision)

        is_absurdity_fix = fix_ply in absurdity_plies
        is_low_conf_fix = fix_ply in suspicious_plies
        is_check_mismatch_fix = fix_ply in extended_search_plies and len(check_mismatches) > 0
        is_duplicate_fix = fix_ply in duplicate_pawn_plies

        # NEW: Check if this fix resolves a check mismatch
        # IMPORTANT: Only award bonus for fixes AT or BEFORE the mismatch ply
        # NOT for fixes at adjacent plies that just move pieces into check-giving positions!
        resolves_check_mismatch = False
        check_mismatch_bonus = 0  # Variable bonus based on fix location
        if check_mismatches:
            # Get the earliest mismatch ply
            earliest_mismatch = min(check_mismatch_plies)

            # Test if this fix makes a previously non-checking move actually give check
            test_board_cm = chess.Board()
            test_valid = True
            for i in range(len(test_moves)):
                if i >= test_reach:
                    break
                m = try_move(test_board_cm, test_moves[i])
                if m:
                    # Check if this is one of the mismatch plies
                    if i in check_mismatch_plies:
                        test_board_cm.push(m)
                        if test_board_cm.is_check():
                            resolves_check_mismatch = True

                            # Award bonus based on DISTANCE from the mismatch
                            # Fixes close to the mismatch are suspicious ("cheating")
                            # Fixes well before are likely root causes
                            distance_from_mismatch = earliest_mismatch - fix_ply

                            if fix_ply in check_mismatch_plies:
                                # Fix AT the mismatch ply (e.g., Qg5+ -> Qg3+) - full bonus!
                                check_mismatch_bonus = 50
                                if verbose:
                                    print(f"      *** FIX {candidate_san} at {ply_to_str(fix_ply)} RESOLVES check mismatch (AT mismatch ply)!")
                            elif distance_from_mismatch >= 4:
                                # Fix 4+ plies before - likely root cause (e.g., 10.W Qe2 for 14.B Bb4+)
                                check_mismatch_bonus = 30
                                if verbose:
                                    print(f"      ** FIX {candidate_san} at {ply_to_str(fix_ply)} resolves check mismatch (root cause, {distance_from_mismatch} plies before)")
                            elif distance_from_mismatch >= 2:
                                # Fix 2-3 plies before - possible but less likely
                                check_mismatch_bonus = 10
                                if verbose:
                                    print(f"      * FIX {candidate_san} at {ply_to_str(fix_ply)} resolves check mismatch ({distance_from_mismatch} plies before)")
                            else:
                                # Fix immediately before (0-1 ply) - likely "cheating", NO bonus
                                # This catches cases like moving Q to c1 to let Bb4+ give check
                                check_mismatch_bonus = 0
                                if verbose:
                                    print(f"      [WARN] FIX {candidate_san} at {ply_to_str(fix_ply)} resolves check but may be 'cheating' (only {distance_from_mismatch} ply before)")
                        test_board_cm.pop()
                    test_board_cm.push(m)
                else:
                    test_valid = False
                    break

        # Count future moves enabled (only if this move UNBLOCKS a piece)
        future_moves_enabled, nearest_ply_bonus = count_future_moves_enabled(
            candidate_san, future_piece_moves, fix_ply, stuck_ply, board, verbose=verbose
        )
        enables_future = future_moves_enabled > 0

        # === OCR CANDIDATE PATTERN BONUS ===
        # If OCR candidates show a pattern (e.g., piece moves), reward fixes that match
        ocr_candidate_bonus = 0
        ocr_analysis = None
        if ocr_m and ocr_m.candidates:
            ocr_analysis = analyze_ocr_candidates(ocr_m.candidates, verbose=False)
            ocr_candidate_bonus = calculate_ocr_candidate_bonus(
                candidate_san, ocr_m.candidates, ocr_analysis=ocr_analysis, verbose=verbose
            )

        # === LENIENT GRAMMAR BONUS ===
        # If this legal move was also found via lenient grammar decode, it gets
        # a bonus because there's independent evidence from the CTC logits.
        lenient_bonus = 0
        lenient_raw = None
        if ocr_m and ocr_m.lenient_candidates:
            lenient_fixes = find_lenient_candidates(fix_ply, board, ocr_lookup, verbose=False)
            for lf in lenient_fixes:
                if lf['san'] == candidate_san:
                    lenient_bonus = 20 if not lf['ambiguous'] else 10
                    lenient_raw = lf['raw']
                    if verbose:
                        print(f"      [LENIENT] '{candidate_san}' matched lenient '{lf['raw']}' "
                              f"({lf['notation_type']}) bonus=+{lenient_bonus}")
                    break

        # === UNIFIED SCORING ===
        # Hanging penalty scaled by piece value
        hanging_penalty = hanging_value * 10 if is_hanging else 0

        # Pawn hanging penalty: -10 per undefended pawn (modest demerit)
        # But offset by captured material — if we capture a pawn and leave one
        # hanging, it's roughly a wash (e.g. Bxd5 captures d5 pawn but f5 hangs)
        pawn_hanging_penalty = pawn_hang_count * 10
        if pawn_hanging_penalty > 0 and board.is_capture(legal_move):
            captured_piece = board.piece_at(legal_move.to_square)
            if captured_piece:
                capture_offset = piece_value(captured_piece) * 10
                pawn_hanging_penalty = max(0, pawn_hanging_penalty - capture_offset)

        # Missed capture penalty: if there's a clearly winning capture available
        # and this move doesn't take it, penalize proportionally
        missed_capture_penalty = 0
        winning_capture_bonus = 0
        our_capture_val = 0
        if board.is_capture(legal_move):
            captured = board.piece_at(legal_move.to_square)
            if captured:
                our_capture_val = piece_value(captured)
        if best_capture_gain >= 2:
            missed = best_capture_gain - our_capture_val
            if missed >= 2:
                missed_capture_penalty = missed * 10
            # Winning capture bonus: reward moves that TAKE the best available capture
            if our_capture_val >= 3 and missed <= 0:
                winning_capture_bonus = our_capture_val * 5
        # SEE bonus: if capturing a piece worth >= 3 and simple analysis missed it,
        # use Static Exchange Evaluation to check if the exchange actually wins material
        # (e.g., Qxc4 where queen gets recaptured but bishop takes back)
        if winning_capture_bonus == 0 and our_capture_val >= 3 and board.is_capture(legal_move):
            see_val = see_capture_value(board, legal_move)
            if see_val >= 2:
                winning_capture_bonus = see_val * 5
                if verbose:
                    print(f"      [SEE] {candidate_san} wins {see_val} material by exchange (bonus=+{winning_capture_bonus})")

        # Absurdity penalty scaled by piece values at risk
        absurdity_penalty = calculate_absurdity_penalty(absurdities_result)

        # === CLEARS DESTINATION BONUS ===
        # If this fix moves a piece OFF the ORIGINAL stuck move's destination square,
        # it directly enables the stuck move. Strong signal for earlier-ply fixes.
        # Use original_stuck_ply (not effective, which may be EAD-adjusted).
        original_stuck_ply = ctx.get('original_stuck_ply', stuck_ply)
        clears_dest_bonus = 0
        if (stuck_dest_square is not None and
            fix_ply != original_stuck_ply and
            legal_move.from_square == stuck_dest_square):
            clears_dest_bonus = 25
            if verbose:
                original_stuck_move = moves[original_stuck_ply] if original_stuck_ply < len(moves) else '?'
                print(f"      [CLEARS-DEST] {candidate_san} vacates {chess.square_name(stuck_dest_square)} "
                      f"(target of original stuck move '{original_stuck_move}') bonus=+{clears_dest_bonus}")

        # Cap hi_sim + ocr_pat at 35 to prevent double-counting
        raw_hi_sim = 25 if char_sim >= 0.90 else 0
        capped_hi_sim = min(raw_hi_sim, max(0, 35 - ocr_candidate_bonus))

        unified_score = (
            char_sim * 40 +                                      # Similarity is key!
            capped_hi_sim +                                      # Bonus for very high similarity (capped with ocr_pat)
            min(reach_improvement * 10, 50) +                    # Cap reach bonus at 50 (5 plies worth)
            (max(reach_improvement - 5, 0) if fix_ply >= stuck_ply else 0) +  # Tiebreaker: +1 per ply beyond 5 (only at/after stuck ply)
            (30 if reach_improvement >= 10 and fix_ply >= stuck_ply else 0) +  # Only at stuck ply (backtrack fixes get reach for free)
            (5 if completes and absurdity_count <= 1 else 0) +
            (20 if is_absurdity_fix else 0) +
            (10 if is_low_conf_fix and ocr_conf > 0.01 else 0) +
            check_mismatch_bonus +                               # Variable bonus: 50 at mismatch, 20 before, 0 adjacent
            check_enabling_bonus +                               # Bonus for enabling check
            check_forcing_bonus +                                # Bonus for check that gets stuck on response
            stuck_move_check_bonus +                             # Bonus for fixing stuck move from check to check
            clears_dest_bonus +                                  # Bonus for clearing stuck move's destination
            (15 if is_duplicate_fix else 0) +                    # Bonus for fixing duplicate
            future_moves_enabled * 2 +
            nearest_ply_bonus +
            ocr_conf * 15 +
            ocr_candidate_bonus +                                # OCR candidate pattern bonus
            lenient_bonus +                                      # Lenient grammar match bonus
            winning_capture_bonus -                              # Bonus for taking best available capture
            absurdity_penalty -                                  # Scaled by piece value!
            hanging_penalty -
            pawn_hanging_penalty -                               # -10 per undefended pawn
            missed_capture_penalty                               # Penalty for ignoring free material
        )

        # BONUS: Fix resolves a duplicate pawn situation
        # Partner-aware bonus: higher if fixing the PARTNER ply (root cause)
        resolves_duplicate = False
        duplicate_resolution_bonus = 0
        if fix_ply in duplicate_suspect_plies:
            # Check if the new move has a DIFFERENT destination
            old_dest = None
            new_dest = None

            old_clean = original_ocr.replace('+', '').replace('#', '').replace('x', '')
            if len(old_clean) >= 2:
                old_dest = old_clean[-2:]

            new_clean = candidate_san.replace('+', '').replace('#', '').replace('x', '')
            if len(new_clean) >= 2:
                new_dest = new_clean[-2:]

            if old_dest and new_dest and old_dest != new_dest:
                resolves_duplicate = True
                # Higher bonus if this is the PARTNER ply (fixing earlier root cause)
                if fix_ply in duplicate_partners and fix_ply != stuck_ply:
                    duplicate_resolution_bonus = 25  # ROOT CAUSE bonus - earlier error
                else:
                    duplicate_resolution_bonus = 15  # Regular bonus - error at stuck point
                unified_score += duplicate_resolution_bonus

        # === PENALTY: Zero-improvement fixes (GRADUATED by similarity) ===
        zero_reach_penalty = 0
        if reach_improvement <= 0:
            if char_sim >= 0.95:
                zero_reach_penalty = 5
            elif char_sim >= 0.90:
                zero_reach_penalty = 15
            elif char_sim >= 0.80:
                zero_reach_penalty = 25
            elif char_sim >= 0.70:
                zero_reach_penalty = 32
            else:
                zero_reach_penalty = 40
            unified_score -= zero_reach_penalty

        # === PENALTY: Distance from stuck ply for zero-reach fixes ===
        distance_penalty = 0
        if reach_improvement <= 0 and fix_ply != stuck_ply:
            ply_distance = stuck_ply - fix_ply
            distance_penalty = min(ply_distance * 5, 30)
            unified_score -= distance_penalty

        # === BONUS: Direct fix at stuck point ===
        stuck_bonus = 0
        if fix_ply == stuck_ply and reach_improvement > 0:
            stuck_bonus = 15
            unified_score += stuck_bonus

        # === BONUS: Future-capture bonus ===
        future_capture_bonus = compute_future_capture_bonus(
            candidate_san, fix_ply, moves, ocr_lookup, stuck_ply, verbose)
        if future_capture_bonus != 0:
            unified_score += future_capture_bonus

        # === VERBOSE: Show scoring breakdown for candidates ===
        # At stuck_ply: show ALL candidates that advance (reach_improvement > 0)
        # At other plies: only show high-scoring candidates (score > 50)
        # Format matches the final summary for consistency
        if verbose and (unified_score > 50 or (fix_ply == stuck_ply and reach_improvement > 0)):
            reach_str = ply_to_str(test_reach) if test_reach < len(moves) else "END"
            print(f"         {ply_to_str(fix_ply)} '{original_ocr}'->'{candidate_san}' | "
                  f"+{reach_improvement} plies, abs={absurdity_count}, sim={char_sim:.0%}, ocr={ocr_conf:.0%} | "
                  f"score={unified_score:.0f} | reach={reach_str}")

        # Build score component breakdown for debugging
        score_components = {
            'sim': round(char_sim * 40, 1),
            'hi_sim': capped_hi_sim,
            'reach': min(reach_improvement * 10, 50),
            'reach_tb': max(reach_improvement - 5, 0) if fix_ply >= stuck_ply else 0,
            'reach10': 30 if reach_improvement >= 10 and fix_ply >= stuck_ply else 0,
            'complete': 5 if completes and absurdity_count <= 1 else 0,
            'abs_fix': 20 if is_absurdity_fix else 0,
            'lo_conf': 10 if is_low_conf_fix and ocr_conf > 0.01 else 0,
            'chk_mm': check_mismatch_bonus,
            'chk_en': check_enabling_bonus,
            'chk_fc': check_forcing_bonus,
            'stk_chk': stuck_move_check_bonus,
            'clr_dst': clears_dest_bonus,
            'dup_fix': 15 if is_duplicate_fix else 0,
            'dup_res': duplicate_resolution_bonus,
            'future': future_moves_enabled * 2,
            'near': nearest_ply_bonus,
            'ocr_c': round(ocr_conf * 15, 1),
            'ocr_pat': ocr_candidate_bonus,
            'abs_pen': -absurdity_penalty,
            'hang': -hanging_penalty,
            'pwn_h': -pawn_hanging_penalty,
            'win_cap': winning_capture_bonus,
            'miss_c': -missed_capture_penalty,
            'zero_r': -zero_reach_penalty,
            'dist': -distance_penalty,
            'stuck': stuck_bonus,
            'fut_cap': future_capture_bonus,
        }

        fixes.append({
            'ply': fix_ply,
            'san': candidate_san,
            'ocr': original_ocr,
            'reach': test_reach,
            'completes': completes,
            'reach_improvement': reach_improvement,
            'char_sim': char_sim,
            'ocr_conf': ocr_conf,
            'ocr_candidate_bonus': ocr_candidate_bonus,
            'absurdity_count': absurdity_count,
            'absurdity_penalty': absurdity_penalty,
            'unified_score': unified_score,
            'original_was_legal': original_was_legal,
            'is_absurdity_fix': is_absurdity_fix,
            'is_low_conf_fix': is_low_conf_fix,
            'is_check_mismatch_fix': is_check_mismatch_fix,
            'resolves_check_mismatch': resolves_check_mismatch,
            'is_duplicate_fix': is_duplicate_fix,
            'resolves_duplicate': resolves_duplicate,
            'is_duplicate_suspect': fix_ply in duplicate_suspect_plies,
            'is_duplicate_partner_fix': fix_ply in duplicate_partners and fix_ply != stuck_ply,
            'duplicate_resolution_bonus': duplicate_resolution_bonus,
            'check_enabling_bonus': check_enabling_bonus,
            'check_enabling_move': check_enabling_move,
            'check_forcing_bonus': check_forcing_bonus,
            'check_forcing_response_fix': check_forcing_response_fix,
            'enables_future': enables_future,
            'future_moves_enabled': future_moves_enabled,
            'future_capture_bonus': future_capture_bonus,
            'nearest_ply_bonus': nearest_ply_bonus,
            'is_hanging': is_hanging,
            'hanging_value': hanging_value,
            'lenient_bonus': lenient_bonus,
            'lenient_raw': lenient_raw,
            'to_square': chess.square_name(legal_move.to_square),
            'moved_piece': candidate_san[0] if candidate_san[0] in 'KQRBN' else 'P',
            'score_components': score_components,
        })
        fixes_at_ply += 1

        # === EARLY EXIT: High-confidence completing fix found ===
        # If we find a fix that:
        # 1. Completes the game (plays to the end)
        # 2. Has very high similarity (>=90%, likely OCR typo)
        # 3. Has zero absurdities (no tactical problems)
        # Then stop searching - this is almost certainly the correct fix.
        #
        # This optimization dramatically speeds up end-game fixes where
        # a simple OCR error (like 5->3) has an obvious correction.
        if completes and char_sim >= 0.90 and absurdity_count == 0:
            if verbose:
                print(f"\n   [EARLY EXIT] Found high-confidence completing fix!")
                print(f"      {ply_to_str(fix_ply)} '{original_ocr}'->'{candidate_san}' "
                      f"(sim={char_sim:.0%}, score={unified_score:.0f}, completes game)")
                print(f"      Skipping remaining candidates...")
            early_exit = True
            break

    if verbose:
        processed = len(legal_moves_list) - skipped_same
        print(f"       [RESULT] {fixes_at_ply} fixes found ({processed} candidates tested)")

    return fixes, early_exit


def find_deep_backtrack_fixes(
    moves: List[str],
    stuck_ply: int,
    ocr_lookup: Dict[int, OCRMove],
    verbose: bool = False,
    fixed_plies: Set[int] = None,
    locked_plies: Set[int] = None,
    min_ply: int = 0,  # Don't search before this ply (confirmed moves)
    phase_label: str = None,  # e.g., "PHASE 1", "PHASE 2" - shown in output header
    original_stuck_ply: int = None  # The real stuck ply (for Phase 2 absurdity checking)
) -> List[dict]:
    """
    Deep backtrack fix finding with unified scoring.
    
    Searches all plies from min_ply to stuck_ply for possible corrections.
    Uses unified scoring that balances:
    - Character similarity (OCR likelihood)
    - Reach improvement (how many more moves become legal)
    - Absurdity penalty (scaled by piece value at risk)
    - Future piece moves enabled
    - Hanging piece penalty
    
    ENHANCED: Now detects check symbol mismatches and duplicate pawn moves,
    which can expand the search to earlier plies where errors likely occurred.
    
    Args:
        moves: List of SAN moves
        stuck_ply: The ply where we're stuck (illegal move)
        ocr_lookup: Dict mapping ply -> OCRMove with candidates
        verbose: Print debug info
        fixed_plies: Set of plies that have already been fixed (skip these)
        min_ply: Don't search for fixes before this ply (user confirmed these)
    """
    fixed_plies = fixed_plies or set()
    locked_plies = locked_plies or set()

    # === Use shared precomputation (SINGLE SOURCE OF TRUTH) ===
    ctx = _precompute_backtrack_context(moves, stuck_ply, ocr_lookup, fixed_plies, min_ply, verbose, phase_label, original_stuck_ply, locked_plies=locked_plies)

    # Extract all context variables for use in the loop
    stuck_ply = ctx['effective_stuck_ply']  # May have been adjusted by EAD
    total_moves = ctx['total_moves']
    search_limit = ctx['search_limit']
    absurdities = ctx['absurdities']
    absurdity_plies = ctx['absurdity_plies']
    check_mismatches = ctx['check_mismatches']
    check_mismatch_plies = ctx['check_mismatch_plies']
    duplicate_pawns = ctx['duplicate_pawns']
    duplicate_pawn_plies = ctx['duplicate_pawn_plies']
    duplicate_suspect_plies = ctx['duplicate_suspect_plies']
    duplicate_partners = ctx['duplicate_partners']
    extended_search_plies = ctx['extended_search_plies']
    suspicious_plies = ctx['suspicious_plies']
    future_piece_moves = ctx['future_piece_moves']
    stuck_move_has_check = ctx['stuck_move_has_check']
    stuck_move_ocr = ctx['stuck_move_ocr']
    search_order = ctx['search_order']
    phase_tag = f"[{ctx.get('phase_label', 'BACKTRACK')}]" if ctx.get('phase_label') else "[BACKTRACK]"

    fixes = []

    for fix_ply in search_order:
        if verbose:
            # Check if this ply is from heuristics (outside normal range) or in normal range
            in_normal_range = min_ply <= fix_ply <= search_limit
            if in_normal_range:
                if fix_ply == stuck_ply:
                    why = "stuck point (illegal/absurd move)"
                elif fix_ply in ctx.get('suspicious_plies', set()):
                    why = "suspicious (check mismatch / duplicate pawn / absurdity)"
                else:
                    why = "normal backtrack range"
                range_info = f"[{why}]"
            else:
                # Explain WHY this heuristic ply is included
                reasons = []
                if fix_ply in ctx.get('check_mismatch_plies', set()):
                    reasons.append("check mismatch")
                if fix_ply in ctx.get('duplicate_pawn_plies', set()):
                    reasons.append("duplicate pawn")
                if fix_ply in ctx.get('duplicate_suspect_plies', set()):
                    reasons.append("duplicate pawn partner")
                if fix_ply in ctx.get('absurdity_plies', set()):
                    reasons.append("absurdity detected")
                reason_str = ", ".join(reasons) if reasons else "extended search"
                range_info = f"[HEURISTIC: {reason_str}]"
            print(f"\n   {phase_tag} >>> Searching {ply_to_str(fix_ply)} (ply {fix_ply}): '{moves[fix_ply] if fix_ply < len(moves) else '?'}' {range_info}")

        if fix_ply in locked_plies:
            if verbose:
                print(f"       [SKIP] LOCKED (user confirmed)")
            continue
        if fix_ply in fixed_plies:
            if verbose:
                print(f"       [SKIP] already fixed")
            continue
        if fix_ply >= len(moves):
            if verbose:
                print(f"       [SKIP] beyond moves list (len={len(moves)})")
            continue

        # Build position at fix_ply — start from cached board at min_ply when possible
        cached_ply = ctx.get('cached_board_ply', 0)
        if fix_ply >= cached_ply and 'cached_board_at_min_ply' in ctx:
            board = ctx['cached_board_at_min_ply'].copy()
            valid = True
            for i in range(cached_ply, fix_ply):
                m = try_move(board, moves[i])
                if m:
                    board.push(m)
                else:
                    valid = False
                    if verbose:
                        print(f"       [SKIP] replay failed at ply {i} ({ply_to_str(i)}), move='{moves[i]}'")
                    break
        else:
            # Fix ply is before cached position (extended search), replay from 0
            board = chess.Board()
            valid = True
            for i in range(fix_ply):
                m = try_move(board, moves[i])
                if m:
                    board.push(m)
                else:
                    valid = False
                    if verbose:
                        print(f"       [SKIP] replay failed at ply {i} ({ply_to_str(i)}), move='{moves[i]}'")
                    break

        if not valid or fix_ply >= len(moves):
            continue

        # Call the SINGLE SOURCE OF TRUTH for fix scoring
        ply_fixes, early_exit = _search_single_ply_for_fixes(
            fix_ply, board, moves, stuck_ply, ocr_lookup, ctx, fixed_plies, verbose
        )
        fixes.extend(ply_fixes)

        # Handle early exit
        if early_exit:
            fixes.sort(key=lambda x: -x['unified_score'])
            return fixes

    # Sort by unified score
    fixes.sort(key=lambda x: -x['unified_score'])

    # Concise summary of fixes by ply (before deduplication)
    if verbose and fixes:
        from collections import defaultdict
        fixes_by_ply = defaultdict(list)
        for f in fixes:
            fixes_by_ply[f['ply']].append(f)

        # One-line summary
        completing = sum(1 for f in fixes if f.get('completes'))
        print(f"\n   [SUMMARY] {len(fixes)} fixes across {len(fixes_by_ply)} plies ({completing} completing)")
        # Show best fix per ply in compact format
        ply_summary = []
        for ply in sorted(fixes_by_ply.keys(), reverse=True)[:8]:  # Top 8 plies
            best = max(fixes_by_ply[ply], key=lambda x: x['unified_score'])
            ply_summary.append(f"{ply_to_str(ply)}:{best['san']}({best['unified_score']:.0f})")
        print(f"   Top by ply: {' | '.join(ply_summary)}")
    
    # Deduplicate: keep only best move per (ply, san)
    # NOTE: Using SAN in key to preserve disambiguated moves like Ncxe5 vs Nfxe5
    # (Previously used (ply, piece, destination) which incorrectly merged them)
    seen_moves = set()
    deduped_fixes = []
    for f in fixes:
        key = (f['ply'], f['san'])  # SAN includes disambiguation
        if key not in seen_moves:
            seen_moves.add(key)
            deduped_fixes.append(f)
    fixes = deduped_fixes
    
    # === BACKTRACK PIECE CONFUSION SEARCH ===
    # Look for R<->K, B<->R type confusions at earlier plies where both were legal
    # (The function itself prints verbose output now)
    backtrack_fixes = find_backtrack_piece_fixes(moves, ocr_lookup, stuck_ply, top_k=5, verbose=verbose)

    # Convert backtrack fixes to standard fix format and add to fixes list
    if backtrack_fixes:
        if verbose:
            print(f"   [PIECE CONFUSION] Adding {len(backtrack_fixes)} to fix candidates")
        for bf in backtrack_fixes:
            # Get OCR info for this ply
            ocr_m = ocr_lookup.get(bf['ply'])
            original_ocr = ocr_m.top_move if ocr_m else bf['original']

            # Calculate character similarity
            char_sim = move_similarity(bf['original'], bf['alternative'])

            # Calculate unified_score using the SAME formula as regular fixes
            # (Don't use bf['score'] which has a different scale)
            reach_improvement = bf['plies_gained']
            completes = bf.get('new_stuck_ply') is None
            ocr_conf = bf['ocr_conf']
            ocr_candidate_bonus = 25 if bf['in_candidates'] else 0

            # === ABSURDITY DETECTION FOR PIECE CONFUSION FIXES ===
            # Build test_moves with the swap applied
            fix_ply = bf['ply']
            test_moves = moves[:fix_ply] + [bf['alternative']] + moves[fix_ply + 1:]
            test_reach = bf.get('new_stuck_ply') or len(test_moves)

            # Check for absurdities in the test sequence (up to stuck_ply + 2)
            # Only count absurdities FROM fix_ply onwards - pre-existing ones shouldn't penalize this fix
            # NOTE: Using fast_mode=True here for speed. Top candidates are re-verified later with fast_mode=False.
            absurdity_check_limit = min(test_reach, stuck_ply + 1)
            absurdities_result = find_all_absurdities(test_moves[:absurdity_check_limit], verbose=False, fast_mode=True,
                                                       start_ply=fix_ply)
            absurdities_result = [a for a in absurdities_result if a.ply >= fix_ply]
            absurdity_count = len(absurdities_result)
            absurdity_penalty = calculate_absurdity_penalty(absurdities_result)

            # Check if the swapped piece hangs after the move
            is_hanging = False
            hanging_value = 0
            pawn_hang_count = 0
            try:
                board_for_hang = chess.Board()
                for i in range(fix_ply):
                    m = try_move(board_for_hang, moves[i])
                    if m:
                        board_for_hang.push(m)
                swap_move = try_move(board_for_hang, bf['alternative'])
                if swap_move:
                    is_hanging, hanging_value = is_piece_hanging_after_move(board_for_hang, swap_move)
                    # When in check, pawns hanging elsewhere are collateral
                    if not board_for_hang.is_check():
                        pawn_hang_count = count_hanging_pawns_after_move(board_for_hang, swap_move)
            except:
                pass

            hanging_penalty = hanging_value * 10 if is_hanging else 0
            pawn_hanging_penalty = pawn_hang_count * 10
            # Offset pawn hanging penalty by captured material (same as main path)
            if pawn_hanging_penalty > 0 and swap_move and board_for_hang.is_capture(swap_move):
                cap_p = board_for_hang.piece_at(swap_move.to_square)
                if cap_p:
                    pawn_hanging_penalty = max(0, pawn_hanging_penalty - piece_value(cap_p) * 10)

            # Missed capture penalty for piece confusion path
            # Skip when in check — can't freely capture when responding to check
            missed_capture_penalty = 0
            try:
                if board_for_hang.is_check():
                    pc_capture_gain = 0
                else:
                    pc_capture_gain = find_best_capture_gain(board_for_hang)
                if pc_capture_gain >= 2 and swap_move and not board_for_hang.is_capture(swap_move):
                    missed_capture_penalty = pc_capture_gain * 10
            except:
                pass

            # Clears destination bonus for piece confusion path
            stuck_dest_square = ctx.get('stuck_dest_square')
            original_stuck_ply_val = ctx.get('original_stuck_ply', stuck_ply)
            pc_clears_dest_bonus = 0
            if (stuck_dest_square is not None and
                fix_ply != original_stuck_ply_val and
                swap_move and swap_move.from_square == stuck_dest_square):
                pc_clears_dest_bonus = 25

            # Cap hi_sim + ocr_pat at 35 to prevent double-counting
            pc_raw_hi_sim = 25 if char_sim >= 0.90 else 0
            pc_capped_hi_sim = min(pc_raw_hi_sim, max(0, 35 - ocr_candidate_bonus))

            unified_score = (
                char_sim * 40 +                                      # Similarity
                pc_capped_hi_sim +                                   # High similarity bonus (capped with ocr_pat)
                min(reach_improvement * 10, 50) +                    # Reach (capped at 50)
                (30 if reach_improvement >= 10 and fix_ply >= stuck_ply else 0) +  # Only at stuck ply
                (5 if completes and absurdity_count <= 1 else 0) +  # Completion bonus (reduced if absurd)
                ocr_conf * 15 +                                      # OCR confidence
                ocr_candidate_bonus +                                # In OCR candidates
                pc_clears_dest_bonus +                               # Bonus for clearing stuck move's destination
                10 -                                                 # Bonus for piece confusion (common OCR error)
                absurdity_penalty -                                  # Penalty for absurdities!
                hanging_penalty -                                    # Penalty for hanging piece
                pawn_hanging_penalty -                               # -10 per undefended pawn
                missed_capture_penalty                               # Penalty for ignoring free material
            )

            fix = {
                'ply': bf['ply'],
                'san': bf['alternative'],
                'ocr': bf['original'],
                'reach': bf.get('new_stuck_ply') or total_moves,
                'completes': completes,
                'reach_improvement': reach_improvement,
                'char_sim': char_sim,
                'ocr_conf': ocr_conf,
                'ocr_candidate_bonus': ocr_candidate_bonus,
                'absurdity_count': absurdity_count,
                'absurdity_penalty': absurdity_penalty,
                'unified_score': unified_score,
                'original_was_legal': True,  # Both were legal
                'is_absurdity_fix': False,
                'is_low_conf_fix': False,
                'is_check_mismatch_fix': False,
                'resolves_check_mismatch': False,
                'is_duplicate_fix': False,
                'resolves_duplicate': False,
                'is_duplicate_suspect': False,
                'is_duplicate_partner_fix': False,
                'duplicate_resolution_bonus': 0,
                'enables_future': False,
                'future_moves_enabled': 0,
                'nearest_ply_bonus': 0,
                'is_hanging': is_hanging,
                'hanging_value': hanging_value,
                'to_square': '',
                'moved_piece': bf['alternative'][0] if bf['alternative'] else '?',
                'type': 'backtrack_piece_confusion',
                'piece_swap': bf['piece_swap'],
                'in_ocr_candidates': bf['in_candidates'],
            }
            fixes.append(fix)

        # Re-sort with backtrack fixes included
        fixes.sort(key=lambda x: -x['unified_score'])

    # === SUMMARY (after all fixes including piece confusion are processed) ===
    # NOTE: fast_mode is used for absurdity detection (for speed), which may have false positives
    # in tactical positions (e.g., "hanging" pieces that are actually traps due to back-rank threats).
    # For accurate absurdity counts, one could re-verify with fast_mode=False, but this is too slow.
    if verbose and fixes:
        print(f"\n   Found {len(fixes)} candidate fixes")
        # Show top fixes with new info
        for f in fixes[:8]:
            complete_str = "[COMPLETE]COMPLETE" if f['completes'] else f"reach={ply_to_str(f['reach'])}"
            fut_str = f" fut={f['future_moves_enabled']}" if f['future_moves_enabled'] > 0 else ""
            hang_str = " [WARN]HANG" if f['is_hanging'] else ""
            check_str = " [OK]CHECK" if f.get('resolves_check_mismatch') else ""
            chk_en_str = f" [CHK-EN:{f.get('check_enabling_move', '?')}+{f['check_enabling_bonus']}]" if f.get('check_enabling_bonus', 0) > 0 else ""
            dup_str = " [OK]DUP" if f.get('resolves_duplicate') else ""
            ocr_conf_str = f", ocr={f['ocr_conf']:.0%}" if f['ocr_conf'] > 0 else ", ocr=0%"
            print(f"      {ply_to_str(f['ply'])} '{f['ocr']}'->'{f['san']}' | "
                  f"+{f['reach_improvement']} plies, abs={f['absurdity_count']}, "
                  f"sim={f['char_sim']:.0%}{ocr_conf_str}{fut_str}{hang_str}{check_str}{chk_en_str}{dup_str} | "
                  f"score={f['unified_score']:.0f} | {complete_str}")

    return fixes


# =============================================================================
# SHARED POST-PHASE-2 PROCESSING
# =============================================================================
# Called by BOTH BacktrackSearchState.finalize() AND find_fixes_two_phase()
# to ensure identical post-processing after Phase 1+2 merge.

def _postprocess_phase2_fixes(fixes: List[dict], moves: List[str], stuck_ply: int, verbose: bool = False, verify_top_n: int = 15) -> List[dict]:
    """
    Post-process fixes after Phase 1 + Phase 2 merge.

    This is the SINGLE SOURCE OF TRUTH for all post-merge processing:
    1. KEEP-AS-IS score capping
    2. Remove Phase 2 KEEP-AS-IS fixes
    3. Phase 2 reach penalty
    4. Re-sort after penalties
    5. Verify top candidates (re-check absurdities with full quiescence)
    6. General keep_as_is UI marking
    7. Final summary table

    Args:
        fixes: Merged list of Phase 1 + Phase 2 fix dicts (mutated in place)
        moves: The original move list
        stuck_ply: The ply where the game is stuck
        verbose: Print debug info

    Returns:
        Processed and sorted list of fixes (top 50)
    """
    # === KEEP-AS-IS SCORE CAPPING ===
    # Phase 2 can return fixes where the "fix" is the same move already there
    # (e.g., f6 → f6 or Bxc5 → Bxc5). These change nothing about the position.
    #
    # KEEP-AS-IS is useful as a UI anchor when there's a BETTER alternative at the
    # same ply (e.g., Bxc5 anchor next to dxc5 with +5 plies helps user spot mistake).
    # But it's noise when no alternative at that ply advances past the stuck point.
    #
    # Rule: Cap KEEP-AS-IS score to 40 UNLESS another fix at the same ply
    # advances past the original stuck point (meaning the user's choice is genuinely questioned).
    keep_as_is_capped = 0
    for f in fixes:
        if f.get('before_frontier') and f['san'].rstrip('+#') == f['ocr'].rstrip('+#'):
            f['is_keep_as_is'] = True
            # Check if any OTHER fix at this ply advances past the original stuck point
            has_better_alternative = any(
                other['ply'] == f['ply'] and
                other['reach'] > stuck_ply and
                other['san'].rstrip('+#') != other['ocr'].rstrip('+#')
                for other in fixes
            )
            if not has_better_alternative:
                old_score = f['unified_score']
                f['unified_score'] = min(f['unified_score'], 40)
                keep_as_is_capped += 1
                if verbose:
                    print(f"   [KEEP-AS-IS] {ply_to_str(f['ply'])} '{f['san']}' capped {old_score:.0f} -> {f['unified_score']:.0f} (no better alternative at this ply)")
            else:
                if verbose:
                    print(f"   [KEEP-AS-IS] {ply_to_str(f['ply'])} '{f['san']}' kept as anchor (better alternative exists at this ply)")

    if verbose and keep_as_is_capped > 0:
        print(f"   [KEEP-AS-IS] Capped {keep_as_is_capped} KEEP-AS-IS fix(es)")

    # === REMOVE PHASE 2 KEEP-AS-IS FIXES ===
    # Phase 2 KEEP-AS-IS are noise: the move is already there, it changes nothing.
    # Stuck-ply KEEP-AS-IS (blunders flagged as absurd) are kept - those are NOT
    # before_frontier and are handled by the general keep_as_is marking below.
    before_count = len(fixes)
    fixes = [f for f in fixes if not f.get('is_keep_as_is')]
    removed_count = before_count - len(fixes)
    if verbose and removed_count > 0:
        print(f"   [KEEP-AS-IS] Removed {removed_count} Phase 2 KEEP-AS-IS fix(es) from results")

    # === PHASE 2 REACH PENALTY ===
    # Phase 2 fixes are evaluated against an earlier stuck ply, so their reach
    # numbers are inflated. Penalize based on whether they actually advance past
    # the ORIGINAL stuck point.
    #
    # - Reaches beyond original stuck point: no penalty (good root cause fix)
    # - Reaches exactly the original stuck point: -70 (lateral move, no progress)
    # - Falls short of original stuck point: -70 + -10 per ply short (wrong fix)
    #
    # Skip KEEP-AS-IS fixes (already removed above).
    phase2_penalized = 0
    for f in fixes:
        if f.get('before_frontier') and not f.get('is_keep_as_is'):
            if f['reach'] > stuck_ply:
                phase2_penalty = 0  # Good - advances past original stuck point
            elif f['reach'] == stuck_ply:
                phase2_penalty = 70  # Reaches stuck point but doesn't advance
            else:
                shortfall = stuck_ply - f['reach']
                phase2_penalty = 70 + shortfall * 10  # Heavy penalty
            if phase2_penalty > 0:
                f['unified_score'] -= phase2_penalty
                f['phase2_reach_penalty'] = phase2_penalty
                if 'score_components' in f:
                    f['score_components']['p2_pen'] = -phase2_penalty
                phase2_penalized += 1
                if verbose:
                    print(f"   [P2 PENALTY] {ply_to_str(f['ply'])} '{f['ocr']}'->'{f['san']}' "
                          f"reach={ply_to_str(f['reach'])} vs stuck={ply_to_str(stuck_ply)} "
                          f"-> penalty={phase2_penalty}")

    if phase2_penalized > 0:
        if verbose:
            print(f"   [P2 PENALTY] Penalized {phase2_penalized} Phase 2 fix(es) that don't advance past {ply_to_str(stuck_ply)}")

    # Re-sort after all penalties applied
    if keep_as_is_capped > 0 or phase2_penalized > 0:
        fixes = sorted(fixes, key=lambda f: f['unified_score'], reverse=True)

    # === VERIFY TOP CANDIDATES (full tactical verification) ===
    # Re-check absurdities with full quiescence on ALL top candidates (not just abs==1).
    # Also check for mate-in-1 and major material loss by opponent's reply.
    # This runs ONCE here at the top level, not inside find_deep_backtrack_fixes.
    verified_count = 0
    for f in fixes[:verify_top_n]:
        fix_ply = f['ply']
        test_moves = moves[:fix_ply] + [f['san']] + moves[fix_ply + 1:]
        test_reach = f['reach']
        absurdity_check_limit = min(test_reach, stuck_ply + 1)

        # --- Re-check absurdities with full quiescence (fast_mode=False) ---
        verified_absurdities = find_all_absurdities(
            test_moves[:absurdity_check_limit], verbose=False, fast_mode=False,
            start_ply=fix_ply
        )
        # Filter: only count absurdities at or after fix_ply
        verified_absurdities = [a for a in verified_absurdities if a.ply >= fix_ply]

        if len(verified_absurdities) != f.get('absurdity_count', 0):
            old_count = f.get('absurdity_count', 0)
            old_penalty = f.get('absurdity_penalty', 0)
            new_count = len(verified_absurdities)
            new_penalty = calculate_absurdity_penalty(verified_absurdities)

            f['absurdity_count'] = new_count
            f['absurdity_penalty'] = new_penalty
            f['unified_score'] = f['unified_score'] + old_penalty - new_penalty
            verified_count += 1

            if verbose:
                print(f"   [VERIFY] {ply_to_str(fix_ply)} '{f['san']}': abs {old_count}->{new_count}, score adjusted")

        # --- Tactical checks: mate-in-1 and major material loss ---
        # Build position up to fix_ply, push the candidate move, then check opponent threats
        try:
            verify_board = chess.Board()
            valid = True
            for i in range(fix_ply):
                m = test_moves[i] if i < len(test_moves) else None
                if m:
                    move_obj = try_move(verify_board, m)
                    if move_obj:
                        verify_board.push(move_obj)
                    else:
                        valid = False
                        break
                else:
                    valid = False
                    break

            if valid:
                candidate_move = try_move(verify_board, f['san'])
                if candidate_move:
                    # Track what the candidate move captures (for trade detection)
                    candidate_captured_val = 0
                    if verify_board.is_capture(candidate_move):
                        cap_piece = verify_board.piece_at(candidate_move.to_square)
                        if cap_piece:
                            candidate_captured_val = piece_value(cap_piece)
                    candidate_to_sq = candidate_move.to_square
                    verify_board.push(candidate_move)

                    # Check 1: Does opponent have mate-in-1?
                    mate_penalty = 0
                    for opp_move in verify_board.legal_moves:
                        verify_board.push(opp_move)
                        if verify_board.is_checkmate():
                            mate_penalty = 100
                            if verbose:
                                print(f"   [VERIFY] {ply_to_str(fix_ply)} '{f['san']}': "
                                      f"opponent has mate-in-1 ({verify_board.peek().uci()}) -> penalty -{mate_penalty}")
                            verify_board.pop()
                            break
                        verify_board.pop()

                    if mate_penalty > 0:
                        # Check if ALL legal moves allow mate-in-1 (unavoidable)
                        verify_board.pop()  # undo candidate move
                        all_allow_mate = True
                        for player_alt in verify_board.legal_moves:
                            verify_board.push(player_alt)
                            opp_has_mate = False
                            for opp_m in verify_board.legal_moves:
                                verify_board.push(opp_m)
                                if verify_board.is_checkmate():
                                    opp_has_mate = True
                                    verify_board.pop()
                                    break
                                verify_board.pop()
                            verify_board.pop()
                            if not opp_has_mate:
                                all_allow_mate = False
                                break
                        verify_board.push(candidate_move)  # re-push

                        if all_allow_mate:
                            mate_penalty = 0
                            if verbose:
                                print(f"   [VERIFY] {ply_to_str(fix_ply)} '{f['san']}': mate-in-1 unavoidable — no penalty")

                    if mate_penalty > 0:
                        f['unified_score'] -= mate_penalty
                        f['verify_mate_penalty'] = mate_penalty
                        if 'score_components' in f:
                            f['score_components']['v_mate'] = -mate_penalty
                        verified_count += 1

                    # Check 2: Opponent wins major material in 1 move
                    # But account for OUR best reply — only RELATED compensation:
                    # - Recapture on the same square (direct trade)
                    # - Promotion (with or without capture) — always relevant
                    # Unrelated captures elsewhere don't count (they were available before too).
                    worst_net_loss = 0  # Worst case material loss after opp capture + our reply
                    for opp_move in verify_board.legal_moves:
                        if verify_board.is_capture(opp_move):
                            captured = verify_board.piece_at(opp_move.to_square)
                            if not captured:
                                continue
                            opp_capture_val = piece_value(captured)
                            if opp_capture_val < 3:
                                continue  # Skip pawn captures, too noisy

                            opp_capture_sq = opp_move.to_square

                            # Simulate opponent's capture
                            verify_board.push(opp_move)

                            # Find our best RELATED reply:
                            # - Recapture on same square (trade)
                            # - Any promotion (with or without capture)
                            our_best_recovery = 0
                            for our_reply in verify_board.legal_moves:
                                reply_gain = 0
                                is_recapture = (our_reply.to_square == opp_capture_sq and
                                                verify_board.is_capture(our_reply))
                                is_promotion = our_reply.promotion is not None

                                if not is_recapture and not is_promotion:
                                    continue  # Skip unrelated captures

                                if verify_board.is_capture(our_reply):
                                    target = verify_board.piece_at(our_reply.to_square)
                                    if target:
                                        reply_gain += piece_value(target)
                                if is_promotion:
                                    reply_gain += 8  # queen(9) - pawn(1) = 8
                                if reply_gain > our_best_recovery:
                                    our_best_recovery = reply_gain

                            verify_board.pop()

                            # Net loss = what they captured minus what we recover
                            net_loss = opp_capture_val - our_best_recovery
                            # If opponent recaptures on the square we just captured on,
                            # it's a trade — offset by what our candidate move captured
                            if opp_move.to_square == candidate_to_sq and candidate_captured_val > 0:
                                net_loss = max(0, net_loss - candidate_captured_val)
                            if net_loss > worst_net_loss:
                                worst_net_loss = net_loss

                    if worst_net_loss >= 3:
                        # Check minimum material loss across ALL legal moves
                        # Only penalize the EXCESS over the best alternative
                        verify_board.pop()  # undo candidate move
                        min_loss_all = worst_net_loss  # default: assume this move is typical
                        for alt_move in verify_board.legal_moves:
                            verify_board.push(alt_move)
                            alt_worst = 0
                            for opp_m2 in verify_board.legal_moves:
                                if verify_board.is_capture(opp_m2):
                                    cap2 = verify_board.piece_at(opp_m2.to_square)
                                    if not cap2 or piece_value(cap2) < 3:
                                        continue
                                    opp_cap_sq2 = opp_m2.to_square
                                    opp_val2 = piece_value(cap2)
                                    verify_board.push(opp_m2)
                                    best_rec2 = 0
                                    for our_r2 in verify_board.legal_moves:
                                        is_recap2 = (our_r2.to_square == opp_cap_sq2 and verify_board.is_capture(our_r2))
                                        is_promo2 = our_r2.promotion is not None
                                        if not is_recap2 and not is_promo2:
                                            continue
                                        rg2 = 0
                                        if verify_board.is_capture(our_r2):
                                            t2 = verify_board.piece_at(our_r2.to_square)
                                            if t2:
                                                rg2 += piece_value(t2)
                                        if is_promo2:
                                            rg2 += 8
                                        if rg2 > best_rec2:
                                            best_rec2 = rg2
                                    verify_board.pop()
                                    nl2 = opp_val2 - best_rec2
                                    if nl2 > alt_worst:
                                        alt_worst = nl2
                            verify_board.pop()
                            if alt_worst < min_loss_all:
                                min_loss_all = alt_worst
                                if min_loss_all == 0:
                                    break  # Found a move with no loss
                        verify_board.push(candidate_move)  # re-push

                        # Only penalize the EXCESS material loss
                        excess_loss = worst_net_loss - min_loss_all
                        if excess_loss >= 3:
                            material_penalty = excess_loss * 10
                            f['unified_score'] -= material_penalty
                            f['verify_material_penalty'] = material_penalty
                            if 'score_components' in f:
                                f['score_components']['v_mat'] = -material_penalty
                            verified_count += 1
                            if verbose:
                                print(f"   [VERIFY] {ply_to_str(fix_ply)} '{f['san']}': "
                                      f"opponent wins material (net loss {worst_net_loss}, best alt loss {min_loss_all}, excess {excess_loss}) -> penalty -{material_penalty}")
                        elif verbose and worst_net_loss >= 3:
                            print(f"   [VERIFY] {ply_to_str(fix_ply)} '{f['san']}': "
                                  f"material loss {worst_net_loss} but unavoidable (best alt loss {min_loss_all}) — no penalty")
        except Exception:
            pass  # If position can't be rebuilt, skip tactical checks

    if verified_count > 0:
        fixes.sort(key=lambda x: -x['unified_score'])

    # === MARK "KEEP AS-IS" FIXES (for UI display) ===
    # Mark ALL fixes where san matches current move, not just Phase 2 ones
    for f in fixes:
        fix_ply = f.get('ply', -1)
        if 0 <= fix_ply < len(moves) and f['san'] == moves[fix_ply]:
            f['keep_as_is'] = True
        elif not f.get('is_keep_as_is'):
            f['keep_as_is'] = False

    top_fixes = fixes[:50]

    # === FINAL SUMMARY ===
    if verbose:
        print(f"\n   {'='*60}")
        print(f"   FINAL FIX CANDIDATES (top {min(len(top_fixes), 15)} of {len(top_fixes)})")
        print(f"   {'='*60}")
        print(f"   {'#':>3}  {'Ply':>5}  {'OCR':>8} -> {'Fix':<8}  {'Sim':>5}  {'OCR%':>5}  {'Reach':>8}  {'+Plies':>6}  {'Score':>6}  {'Status'}")
        print(f"   {'---':>3}  {'-----':>5}  {'--------':>8}    {'--------':<8}  {'-----':>5}  {'-----':>5}  {'--------':>8}  {'------':>6}  {'------':>6}  {'------'}")
        for i, f in enumerate(top_fixes[:15]):
            ply_str = ply_to_str(f['ply'])
            ocr = f.get('ocr', '?')[:8]
            san = f['san'][:8]
            sim = f.get('char_sim', 0)
            ocr_conf = f.get('ocr_conf', 0)
            reach = ply_to_str(f['reach']) if 'reach' in f else '?'
            improvement = f.get('reach_improvement', 0)
            score = f.get('unified_score', 0)
            phase = "P2" if f.get('before_frontier') else "P1"
            if f.get('keep_as_is'):
                status = "KEEP-AS-IS"
            elif f.get('completes'):
                status = "COMPLETE"
            elif f.get('type') == 'piece_confusion':
                status = "piece_swap"
            else:
                status = f"wall@{reach}"
            print(f"   {i+1:3d}  {ply_str:>5}  {ocr:>8} -> {san:<8}  {sim:>4.0%}  {ocr_conf:>4.0%}  {reach:>8}  {'+'+str(improvement):>6}  {score:>6.0f}  {phase}  {status}")
            # Print score component breakdown
            sc = f.get('score_components', {})
            if sc:
                nonzero = {k: v for k, v in sc.items() if v != 0}
                parts = [f"{k}={v:+.0f}" if isinstance(v, float) else f"{k}={v:+d}" for k, v in nonzero.items()]
                print(f"         [{' '.join(parts)}]")
        print(f"   {'='*60}")

    return top_fixes


# =============================================================================
# STREAMING BACKTRACK SEARCH (for interactive UI)
# =============================================================================

class BacktrackSearchState:
    """
    Stateful backtrack search that can be driven from JS one ply at a time.

    This allows the UI to:
    - Show progress (countdown of remaining plies)
    - Accept a quick fix before backtracking completes
    - Yield control back to the browser between plies

    IMPORTANT: Uses _precompute_backtrack_context() and _search_single_ply_for_fixes()
    as SINGLE SOURCE OF TRUTH. The streaming search produces IDENTICAL scores
    to find_deep_backtrack_fixes().

    Usage from JS:
        state = BacktrackSearchState(moves, stuck_ply, ocr_lookup, min_ply)
        while not state.is_done:
            result = state.search_next_ply()
            updateUI(result)
            if userAcceptedFix: break
        fixes = state.finalize()
    """

    def __init__(self, moves: List[str], stuck_ply: int, ocr_lookup: Dict[int, OCRMove],
                 min_ply: int = 0, fixed_plies: Set[int] = None, locked_plies: Set[int] = None,
                 verbose: bool = False,
                 phase_label: str = None, phase2_depth: int = 5,
                 original_stuck_ply: int = None, stuck_reason: str = None):
        self.moves = moves
        self.stuck_ply = stuck_ply
        self.ocr_lookup = ocr_lookup
        self.min_ply = min_ply
        self.fixed_plies = fixed_plies or set()
        self.locked_plies = locked_plies or set()
        self.verbose = verbose
        self.phase2_depth = phase2_depth
        self.stuck_reason = stuck_reason

        # Results
        self.fixes = []
        self.best_score = 0
        self.early_exit = False

        # Use SINGLE SOURCE OF TRUTH for precomputation
        self.ctx = _precompute_backtrack_context(
            moves, stuck_ply, ocr_lookup, self.fixed_plies, min_ply, verbose, phase_label,
            original_stuck_ply=original_stuck_ply, locked_plies=self.locked_plies,
            stuck_reason=stuck_reason
        )

        # Extract commonly needed values
        self.effective_stuck_ply = self.ctx['effective_stuck_ply']
        self.search_order = self.ctx['search_order']

        # State for iteration
        self.current_index = 0
        self.is_done = False

    def search_next_ply(self) -> dict:
        """
        Search one ply. Call repeatedly from JS.

        Returns dict with:
        - done: bool - True if all plies searched
        - ply: int - The ply just searched
        - ply_str: str - Human-readable ply (e.g., "18.W")
        - remaining: int - Plies remaining to search
        - fixes_found: int - Total fixes found so far
        - best_score: float - Best score so far
        - fixes_at_ply: int - Fixes found at this ply
        """
        if self.is_done or self.current_index >= len(self.search_order):
            self.is_done = True
            return {'done': True, 'remaining': 0, 'fixes_found': len(self.fixes), 'best_score': self.best_score,
                    'phase_label': self.ctx.get('phase_label', 'BACKTRACK')}

        fix_ply = self.search_order[self.current_index]
        self.current_index += 1

        # Compute range_info for both printing and return value
        phase_tag = f"[{self.ctx.get('phase_label', 'BACKTRACK')}]" if self.ctx.get('phase_label') else "[BACKTRACK]"
        search_limit = self.ctx.get('search_limit', self.effective_stuck_ply)
        min_ply_val = self.ctx.get('min_ply', 0)
        in_normal_range = min_ply_val <= fix_ply <= search_limit
        move_text = self.moves[fix_ply] if fix_ply < len(self.moves) else '?'
        if in_normal_range:
            if fix_ply == self.effective_stuck_ply:
                why = "stuck point (illegal/absurd move)"
            elif fix_ply in self.ctx.get('suspicious_plies', set()):
                why = "suspicious (check mismatch / duplicate pawn / absurdity)"
            else:
                why = "normal backtrack range"
            range_info = f"[{why}]"
        else:
            reasons = []
            if fix_ply in self.ctx.get('check_mismatch_plies', set()):
                reasons.append("check mismatch")
            if fix_ply in self.ctx.get('duplicate_pawn_plies', set()):
                reasons.append("duplicate pawn")
            if fix_ply in self.ctx.get('duplicate_suspect_plies', set()):
                reasons.append("duplicate pawn partner")
            if fix_ply in self.ctx.get('absurdity_plies', set()):
                reasons.append("absurdity detected")
            reason_str = ", ".join(reasons) if reasons else "extended search"
            range_info = f"[HEURISTIC: {reason_str}]"

        # Print per-ply header (same as find_deep_backtrack_fixes)
        if self.verbose:
            print(f"\n   {phase_tag} >>> Searching {ply_to_str(fix_ply)} (ply {fix_ply}): '{move_text}' {range_info}")

        # Skip locked plies (sacred — user confirmed OCR is correct) and fixed plies
        if fix_ply in self.locked_plies or fix_ply in self.fixed_plies or fix_ply >= len(self.moves):
            if self.verbose:
                reason = "LOCKED (user confirmed)" if fix_ply in self.locked_plies else (
                    "already fixed" if fix_ply in self.fixed_plies else f"beyond moves list (len={len(self.moves)})")
                print(f"       [SKIP] {reason}")
            return {
                'done': False,
                'ply': fix_ply,
                'ply_str': ply_to_str(fix_ply),
                'remaining': len(self.search_order) - self.current_index,
                'fixes_found': len(self.fixes),
                'best_score': self.best_score,
                'fixes_at_ply': 0,
                'skipped': True,
                'move_text': move_text,
                'range_info': range_info,
                'phase_label': self.ctx.get('phase_label', 'BACKTRACK'),
            }

        # Build position at fix_ply — start from cached board at min_ply when possible
        cached_ply = self.ctx.get('cached_board_ply', 0)
        if fix_ply >= cached_ply and 'cached_board_at_min_ply' in self.ctx:
            board = self.ctx['cached_board_at_min_ply'].copy()
            valid = True
            for i in range(cached_ply, fix_ply):
                m = try_move(board, self.moves[i])
                if m:
                    board.push(m)
                else:
                    valid = False
                    break
        else:
            # Fix ply is before cached position (extended search), replay from 0
            board = chess.Board()
            valid = True
            for i in range(fix_ply):
                m = try_move(board, self.moves[i])
                if m:
                    board.push(m)
                else:
                    valid = False
                    break

        if not valid:
            if self.verbose:
                print(f"       [SKIP] replay failed before this ply")
            return {
                'done': False,
                'ply': fix_ply,
                'ply_str': ply_to_str(fix_ply),
                'remaining': len(self.search_order) - self.current_index,
                'fixes_found': len(self.fixes),
                'best_score': self.best_score,
                'fixes_at_ply': 0,
                'skipped': True,
                'move_text': move_text,
                'range_info': range_info,
                'phase_label': self.ctx.get('phase_label', 'BACKTRACK'),
            }

        # Call the SINGLE SOURCE OF TRUTH for fix scoring
        fixes_at_ply, early_exit = _search_single_ply_for_fixes(
            fix_ply, board, self.moves, self.effective_stuck_ply,
            self.ocr_lookup, self.ctx, self.fixed_plies, self.verbose
        )
        self.fixes.extend(fixes_at_ply)

        # Update best score
        for f in fixes_at_ply:
            if f['unified_score'] > self.best_score:
                self.best_score = f['unified_score']

        # Handle early exit
        if early_exit:
            self.early_exit = True
            self.is_done = True

        remaining = len(self.search_order) - self.current_index
        if remaining == 0:
            self.is_done = True

        return {
            'done': self.is_done,
            'ply': fix_ply,
            'ply_str': ply_to_str(fix_ply),
            'remaining': remaining,
            'fixes_found': len(self.fixes),
            'best_score': self.best_score,
            'fixes_at_ply': len(fixes_at_ply),
            'early_exit': self.early_exit,
            'move_text': move_text,
            'range_info': range_info,
            'phase_label': self.ctx.get('phase_label', 'BACKTRACK'),
        }

    def finalize(self) -> List[dict]:
        """
        Finalize the search: sort, deduplicate, add piece confusion fixes,
        run Phase 2 if needed, and print final summary.
        Call this when done iterating (or when user accepts a fix early).

        Returns the final sorted list of fixes.

        NOTE: For streaming Phase 2 progress, use finalize_phase1() + phase2 streaming
        + finalize_complete() instead of this method.
        """
        phase2_info = self.finalize_phase1()

        if phase2_info['need_phase_2']:
            # Run Phase 2 synchronously (non-streaming path)
            phase2_state = self.phase2_state
            while not phase2_state.is_done:
                phase2_state.search_next_ply()
            self.finalize_complete()
        else:
            self.finalize_complete()

        return self.final_fixes

    def finalize_phase1(self) -> dict:
        """
        First part of finalization: sort, deduplicate, add piece confusion fixes,
        decide if Phase 2 is needed, and create Phase 2 state if so.

        Returns dict with:
        - need_phase_2: bool
        - phase2_total_plies: int (0 if no Phase 2)

        If Phase 2 is needed, self.phase2_state is set to a BacktrackSearchState
        that can be streamed with search_next_ply().
        """
        # Sort by score
        self.fixes.sort(key=lambda x: -x['unified_score'])

        # Deduplicate
        seen = set()
        deduped = []
        for f in self.fixes:
            key = (f['ply'], f['san'])
            if key not in seen:
                seen.add(key)
                deduped.append(f)
        self.fixes = deduped

        # Add piece confusion fixes (optional - can skip if user accepted early)
        if not self.early_exit:
            backtrack_fixes = find_backtrack_piece_fixes(
                self.moves, self.ocr_lookup, self.effective_stuck_ply, top_k=5, verbose=False
            )
            if backtrack_fixes:
                for bf in backtrack_fixes:
                    fix = {
                        'ply': bf['ply'],
                        'san': bf['alternative'],
                        'ocr': bf['original'],
                        'reach': bf.get('new_stuck_ply') or len(self.moves),
                        'completes': bf.get('new_stuck_ply') is None,
                        'reach_improvement': bf['plies_gained'],
                        'char_sim': move_similarity(bf['original'], bf['alternative']),
                        'ocr_conf': bf['ocr_conf'],
                        'unified_score': bf['score'] if 'score' in bf else 50,
                        'absurdity_count': 0,
                        'absurdity_penalty': 0,
                        'type': 'piece_confusion',
                    }
                    self.fixes.append(fix)
                self.fixes.sort(key=lambda x: -x['unified_score'])

        # === PHASE 1 RESULT + PHASE 2 DECISION ===
        has_completing = any(f.get('completes') for f in self.fixes)
        best_score = self.fixes[0]['unified_score'] if self.fixes else 0
        need_phase_2 = False

        if self.verbose:
            print(f"\n   {'='*60}")
            print(f"   [PHASE 1 RESULT] {len(self.fixes)} fixes found, best_score={best_score:.0f}, completes={has_completing}")
            if self.fixes:
                f = self.fixes[0]
                print(f"   [PHASE 1 RESULT] Top fix: {ply_to_str(f['ply'])} '{f.get('ocr','?')}'->'{f['san']}' score={f['unified_score']:.0f}")

        # Determine if Phase 2 is needed (same logic as find_fixes_two_phase)
        if self.min_ply > 0 and self.phase2_depth > 0:
            need_phase_2 = True
            if self.verbose:
                if not self.fixes:
                    print(f"   [PHASE 2 NEEDED] No fixes found in Phase 1 - searching {self.phase2_depth} plies before frontier")
                else:
                    print(f"   [PHASE 2 NEEDED] No completing fix in Phase 1 (best score={best_score:.0f}) "
                            f"- searching {self.phase2_depth} plies before frontier")
        elif self.min_ply > 0 and self.phase2_depth == 0:
            if self.verbose:
                print(f"   [PHASE 2 SKIPPED] phase2_depth=0 (user setting)")
        else:
            if self.verbose:
                print(f"   [PHASE 2 N/A] Already searching from beginning (min_ply=0)")

        # Create Phase 2 state if needed
        self.phase2_state = None
        phase2_total_plies = 0

        if need_phase_2:
            phase2_max_ply = self.min_ply - 1
            phase2_min_ply = max(0, self.min_ply - self.phase2_depth)

            if self.verbose:
                print(f"   [PHASE 2 STARTING] Searching {ply_to_str(phase2_max_ply)} down to {ply_to_str(phase2_min_ply)} "
                      f"(depth={self.phase2_depth})")

            self.phase2_state = BacktrackSearchState(
                moves=self.moves,
                stuck_ply=phase2_max_ply,
                ocr_lookup=self.ocr_lookup,
                min_ply=phase2_min_ply,
                fixed_plies=set(),  # Don't skip - Phase 2 questions earlier fixes
                locked_plies=self.locked_plies,  # ALWAYS respected - sacred plies
                verbose=self.verbose,
                phase_label="PHASE 2",
                phase2_depth=0,  # Phase 2 doesn't spawn its own Phase 2
                original_stuck_ply=self.stuck_ply,  # Pass the REAL stuck ply for absurdity checking
                stuck_reason=self.stuck_reason  # Phase 2 also skips redundant EAD
            )
            phase2_total_plies = len(self.phase2_state.search_order)

        return {
            'need_phase_2': need_phase_2,
            'phase2_total_plies': phase2_total_plies,
        }

    def finalize_complete(self) -> List[dict]:
        """
        Second part of finalization: merge Phase 2 fixes (if any), run postprocessing.

        Call this after Phase 2 streaming is done (or immediately if no Phase 2).
        Sets self.final_fixes and returns them.
        """
        if self.phase2_state is not None:
            # Collect Phase 2 fixes
            phase2_fixes = self.phase2_state.fixes

            # Mark Phase 2 fixes
            for f in phase2_fixes:
                f['before_frontier'] = True
            # Mark Phase 1 fixes
            for f in self.fixes:
                f['before_frontier'] = False

            # Merge and re-sort
            self.fixes = sorted(self.fixes + phase2_fixes, key=lambda f: f['unified_score'], reverse=True)

            if self.verbose:
                phase1_count = len([f for f in self.fixes if not f.get('before_frontier')])
                phase2_count = len([f for f in self.fixes if f.get('before_frontier')])
                print(f"\n   [PHASE 2 RESULT] Merged: {phase1_count} from Phase 1 + {phase2_count} from Phase 2 = {len(self.fixes)} total")
                if phase2_count > 0:
                    print(f"   [!] Found {phase2_count} fix(es) BEFORE frontier - earlier fix may have been incorrect!")

        # === PHASE 3: CHECK-BLOCKING SQUARE SEARCH ===
        if self.stuck_ply > 0:
            check_ply = self.stuck_ply - 1
            played_move = self.moves[check_ply] if check_ply < len(self.moves) else ''
            ocr_move = self.ocr_lookup.get(check_ply)
            ocr_text = ocr_move.top_move if ocr_move else played_move

            check_was_added = (
                ('+' in played_move or '#' in played_move) and
                '+' not in ocr_text and '#' not in ocr_text
            )

            if check_was_added:
                if self.verbose:
                    print(f"\n   [PHASE 3 TRIGGER] Auto-corrected check at {ply_to_str(check_ply)}: "
                          f"OCR='{ocr_text}' -> played='{played_move}'")

                phase3_fixes = find_check_blocking_fixes(
                    self.moves, self.stuck_ply, check_ply, self.ocr_lookup,
                    locked_plies=self.locked_plies, fixed_plies=self.fixed_plies,
                    verbose=self.verbose
                )

                if phase3_fixes:
                    for f in phase3_fixes:
                        f['before_frontier'] = f['ply'] < self.min_ply
                    self.fixes = sorted(self.fixes + phase3_fixes,
                                        key=lambda f: f['unified_score'], reverse=True)
                    if self.verbose:
                        print(f"   [PHASE 3 RESULT] Added {len(phase3_fixes)} check-blocking fixes")

        # === SHARED POST-PHASE-2 PROCESSING ===
        # Handles KEEP-AS-IS capping/removal, reach penalty, verify, UI marking, summary.
        # Safe to call even when Phase 2 didn't run (loops simply find no before_frontier fixes).
        self.final_fixes = _postprocess_phase2_fixes(self.fixes, self.moves, self.stuck_ply, self.verbose)

        return self.final_fixes

    def get_progress(self) -> dict:
        """Get current progress without searching."""
        return {
            'current_index': self.current_index,
            'total_plies': len(self.search_order),
            'remaining': len(self.search_order) - self.current_index,
            'fixes_found': len(self.fixes),
            'best_score': self.best_score,
            'is_done': self.is_done
        }


# =============================================================================
# TWO-PHASE SEARCH (FAST THEN FULL)
# =============================================================================

# Threshold for "good enough" fix - if best score is below this, expand search
GOOD_FIX_THRESHOLD = 60  # Roughly: 0.5 similarity + completes, or 0.8 similarity + some reach

def find_fixes_two_phase(
    moves: List[str],
    stuck_ply: int,
    ocr_lookup: Dict[int, OCRMove],
    verbose: bool = False,
    fixed_plies: Set[int] = None,
    locked_plies: Set[int] = None,
    min_ply: int = 0,  # The "frontier" - normally start search here
    phase2_depth: int = 999,  # How far before frontier to search (0=skip Phase 2, 999=full game)
    verify_top_n: int = 15  # How many top fixes to verify with full quiescence
) -> List[dict]:
    """
    Two-phase fix finding for better performance.

    Phase 1: Search from min_ply (frontier) to stuck_ply
             This is fast when frontier > 0 (we skip early plies)

    Phase 2: If no good fix found, expand search backward from frontier
             Limited by phase2_depth setting (0=none, 5=5 plies, 999=full game)

    The idea: Once user confirms a fix at ply N, we set frontier=N+1.
    Future searches start from frontier, making them faster.
    But if we can't find a good fix after the frontier, we fall back
    to deeper search - the earlier "confirmed" moves might have had
    an undetected error (like Qd2 instead of Qe2 - legal but wrong).

    Args:
        moves: List of SAN moves
        stuck_ply: The ply where we're stuck (illegal move or absurdity)
        ocr_lookup: Dict mapping ply -> OCRMove with candidates
        verbose: Print debug info
        fixed_plies: Set of plies that have already been fixed (skip these)
        min_ply: The validation frontier - start searching from here
        phase2_depth: How many plies before frontier to search (0=skip, 999=full game)

    Returns:
        List of fix candidates, sorted by unified_score
    """
    fixed_plies = fixed_plies or set()
    locked_plies = locked_plies or set()

    if verbose:
        print(f"\n   [TWO-PHASE SEARCH v2.0.1] stuck_ply={stuck_ply}, min_ply={min_ply}, phase2_depth={phase2_depth}")
        if locked_plies:
            print(f"   [LOCKED PLIES] {[ply_to_str(p) for p in sorted(locked_plies)]}")

    # Phase 1: Fast search from frontier to stuck_ply
    fixes = find_deep_backtrack_fixes(
        moves=moves,
        stuck_ply=stuck_ply,
        ocr_lookup=ocr_lookup,
        verbose=verbose,
        fixed_plies=fixed_plies,
        locked_plies=locked_plies,
        min_ply=min_ply,
        phase_label="PHASE 1"
    )

    # Check if we found a "good enough" fix
    has_completing_fix = any(f['completes'] for f in fixes)
    best_score = fixes[0]['unified_score'] if fixes else 0

    if verbose:
        print(f"\n   [PHASE 1 RESULT] Found {len(fixes)} fixes, best_score={best_score:.0f}, completes={has_completing_fix}")
        if fixes:
            print(f"   [PHASE 1 RESULT] Top fix: {ply_to_str(fixes[0]['ply'])} '{fixes[0]['ocr']}'->'{fixes[0]['san']}' score={fixes[0]['unified_score']:.0f}")

    # Debug: show top 10 fixes from Phase 1 (for diagnosing Phase 2 trigger)
    if verbose and fixes:
        print(f"\n   [PHASE 1 TOP 10] Fixes for Phase 2 decision:")
        for i, f in enumerate(fixes[:10]):
            complete_str = "COMPLETE" if f.get('completes') else f"reach={ply_to_str(f['reach'])}"
            print(f"      {i+1:2d}. {ply_to_str(f['ply'])} '{f['ocr']}'->'{f['san']}' | "
                  f"sim={f['char_sim']:.0%}, ocr={f['ocr_conf']:.0%} | "
                  f"+{f['reach_improvement']} plies | score={f['unified_score']:.0f} | {complete_str}")

    # Determine if we need Phase 2
    need_phase_2 = False

    if min_ply > 0 and phase2_depth > 0:
        need_phase_2 = True
        if verbose:
            if not fixes:
                print(f"   [PHASE 2 NEEDED] No fixes found in Phase 1 - searching {phase2_depth} plies before frontier")
            else:
                print(f"   [PHASE 2 NEEDED] No completing fix in Phase 1 (best score={best_score:.0f}) "
                        f"- searching {phase2_depth} plies before frontier")
    elif min_ply > 0 and phase2_depth == 0:
        if verbose:
            print(f"   [PHASE 2 SKIPPED] phase2_depth=0 (user setting)")
    elif min_ply == 0:
        if verbose:
            print(f"   [PHASE 2 N/A] Already searching from beginning (min_ply=0)")

    # Phase 2: Expand search to include plies before frontier
    # Limited by phase2_depth setting (0=skip, 5=5 plies before frontier, 999=full game)
    if need_phase_2:
        phase2_max_ply = min_ply - 1  # Search up to (but not including) the frontier
        # Calculate how far back to go: either phase2_depth plies, or to beginning
        phase2_min_ply = max(0, min_ply - phase2_depth)

        # Phase 2 intentionally ignores fixed_plies - its whole purpose is to
        # question earlier decisions that may have been wrong.
        # But locked_plies are ALWAYS respected - user explicitly confirmed these.
        phase2_fixes = find_deep_backtrack_fixes(
            moves=moves,
            stuck_ply=phase2_max_ply,  # Only search up to (frontier - 1)
            ocr_lookup=ocr_lookup,
            verbose=verbose,
            fixed_plies=set(),  # Don't skip - Phase 2 questions earlier fixes
            locked_plies=locked_plies,  # ALWAYS respected - sacred plies
            min_ply=phase2_min_ply,  # Respect depth limit
            phase_label="PHASE 2",
            original_stuck_ply=stuck_ply  # Pass the REAL stuck ply for absurdity checking
        )

        # Mark all Phase 2 fixes as "before frontier"
        for f in phase2_fixes:
            f['before_frontier'] = True

        # Mark Phase 1 fixes as NOT before frontier
        for f in fixes:
            f['before_frontier'] = False

        # Merge Phase 1 and Phase 2 results, re-sort by unified_score
        all_fixes = fixes + phase2_fixes
        fixes = sorted(all_fixes, key=lambda f: f['unified_score'], reverse=True)

        if verbose:
            phase1_count = len([f for f in fixes if not f.get('before_frontier')])
            phase2_count = len([f for f in fixes if f.get('before_frontier')])
            print(f"\n   [PHASE 2 RESULT] Merged: {phase1_count} from Phase 1 + {phase2_count} from Phase 2 = {len(fixes)} total")
            if phase2_count > 0:
                print(f"   [!] Found {phase2_count} fix(es) BEFORE frontier - earlier fix may have been incorrect!")

        # Post-processing for Phase 2 is done below (outside if block)

    # === PHASE 3: CHECK-BLOCKING SQUARE SEARCH ===
    # Triggered when: auto-corrected check at ply N AND ply N+1 = stuck_ply
    # Detects check by comparing OCR text (no +) with played move (has +)
    if stuck_ply > 0:
        check_ply = stuck_ply - 1
        played_move = moves[check_ply] if check_ply < len(moves) else ''
        ocr_move = ocr_lookup.get(check_ply)
        ocr_text = ocr_move.top_move if ocr_move else played_move

        # Check if + was added (not in original OCR, but in the corrected move)
        check_was_added = (
            ('+' in played_move or '#' in played_move) and
            '+' not in ocr_text and '#' not in ocr_text
        )

        if check_was_added:
            if verbose:
                print(f"\n   [PHASE 3 TRIGGER] Auto-corrected check at {ply_to_str(check_ply)}: "
                      f"OCR='{ocr_text}' -> played='{played_move}'")
                print(f"   Next move at {ply_to_str(stuck_ply)} is stuck (doesn't escape check)")

            phase3_fixes = find_check_blocking_fixes(
                moves, stuck_ply, check_ply, ocr_lookup,
                locked_plies=locked_plies, fixed_plies=fixed_plies,
                verbose=verbose
            )

            if phase3_fixes:
                for f in phase3_fixes:
                    f['before_frontier'] = f['ply'] < min_ply
                fixes = fixes + phase3_fixes
                fixes = sorted(fixes, key=lambda f: f['unified_score'], reverse=True)
                if verbose:
                    print(f"   [PHASE 3 RESULT] Added {len(phase3_fixes)} check-blocking fixes")

    # === SHARED POST-PHASE-2 PROCESSING ===
    # Handles KEEP-AS-IS capping/removal, reach penalty, verify, UI marking, summary.
    # Safe to call even when Phase 2 didn't run (loops simply find no before_frontier fixes).
    return _postprocess_phase2_fixes(fixes, moves, stuck_ply, verbose, verify_top_n=verify_top_n)


# =============================================================================
# CONSTRAINED RE-OCR HEURISTIC
# =============================================================================

def constrained_reocr_at_stuck(
    cell_image,  # Original image for this cell (numpy array)
    board: chess.Board,  # Current position (assumed correct)
    original_ocr_text: str,  # What OCR originally read
    ocr_model,  # The ChessOCR model instance
    min_confidence: float = 0.4,
    min_similarity: float = 0.5,
    verbose: bool = False
) -> Optional[Tuple[str, float, str]]:
    """
    Re-run OCR with grammar constrained to legal moves only.

    This assumes the current position is CORRECT and asks:
    "Which legal move does this image most look like?"

    Key difference from regular OCR:
        - Regular OCR: outputs ANY valid chess notation
        - Constrained OCR: outputs ONLY legal moves in this position

    Args:
        cell_image: Original cell image (numpy array or PIL Image)
        board: Current chess board position
        original_ocr_text: What OCR originally read for this cell
        ocr_model: ChessOCR model instance with predict_constrained method
        min_confidence: Minimum confidence threshold
        min_similarity: Minimum similarity to original OCR text
        verbose: Print debug info

    Returns:
        (matched_move, confidence, explanation) or None if no good match
    """
    if cell_image is None or ocr_model is None:
        return None

    # Get all legal moves in current position
    legal_moves = [board.san(m) for m in board.legal_moves]

    if verbose:
        print(f"   [CONSTRAINED OCR] {len(legal_moves)} legal moves in position")

    # Check if model has constrained prediction method
    if not hasattr(ocr_model, 'predict_constrained'):
        if verbose:
            print(f"   [CONSTRAINED OCR] Model doesn't support constrained prediction")
        return None

    # Run OCR with constrained grammar
    try:
        constrained_candidates = ocr_model.predict_constrained(
            cell_image,
            allowed_outputs=legal_moves
        )
    except Exception as e:
        if verbose:
            print(f"   [CONSTRAINED OCR] Error: {e}")
        return None

    if not constrained_candidates:
        if verbose:
            print(f"   [CONSTRAINED OCR] No candidates returned")
        return None

    # Get best candidate
    best_move, confidence = constrained_candidates[0]

    # Also check similarity to original OCR (sanity check)
    similarity = move_similarity(original_ocr_text, best_move)

    if verbose:
        print(f"   [CONSTRAINED OCR] Best: {best_move} ({confidence:.0%}), "
              f"sim to '{original_ocr_text}': {similarity:.0%}")

    # Accept if EITHER confidence is high OR similarity is high
    if confidence < min_confidence and similarity < min_similarity:
        if verbose:
            print(f"   [CONSTRAINED OCR] Rejected: confidence {confidence:.0%} < {min_confidence:.0%} "
                  f"and similarity {similarity:.0%} < {min_similarity:.0%}")
        return None

    # ONE-OR-NOTHING check: is there a clear winner?
    if len(constrained_candidates) >= 2:
        second_move, second_conf = constrained_candidates[1]
        margin = confidence - second_conf
        if margin < 0.15:  # Too close - not confident
            if verbose:
                print(f"   [CONSTRAINED OCR] Rejected: margin too small ({margin:.0%})")
            return None

    explanation = f"Constrained re-OCR matched '{best_move}' with {confidence:.0%} confidence"
    return (best_move, confidence, explanation)


def try_constrained_reocr_fixes(
    moves: List[str],
    stuck_ply: int,
    board: chess.Board,
    cell_images: Dict[int, any],  # Dict mapping ply -> cell image
    ocr_model,
    ocr_lookup: Dict[int, OCRMove],
    verbose: bool = False
) -> List[dict]:
    """
    Try to fix stuck position using constrained re-OCR.

    This is the "Step 1" in the new fix-finding flow:
    Assume the position is correct and re-read the image with only legal outputs.

    Args:
        moves: List of SAN moves
        stuck_ply: The ply where we're stuck
        board: Board position at stuck_ply (before the stuck move)
        cell_images: Dict mapping ply -> original cell image
        ocr_model: ChessOCR model instance
        ocr_lookup: Dict mapping ply -> OCRMove
        verbose: Print debug info

    Returns:
        List of fix suggestions from constrained re-OCR
    """
    fixes = []

    if not cell_images or ocr_model is None:
        return fixes

    # Get the cell image for the stuck ply
    cell_image = cell_images.get(stuck_ply)
    if cell_image is None:
        if verbose:
            print(f"   [CONSTRAINED OCR] No cell image for ply {stuck_ply}")
        return fixes

    # Get original OCR text
    ocr_m = ocr_lookup.get(stuck_ply)
    original_ocr = ocr_m.top_move if ocr_m else moves[stuck_ply] if stuck_ply < len(moves) else ''

    if verbose:
        print(f"\n   [CONSTRAINED OCR] Trying constrained re-OCR for '{original_ocr}' at ply {stuck_ply}...")

    result = constrained_reocr_at_stuck(
        cell_image=cell_image,
        board=board,
        original_ocr_text=original_ocr,
        ocr_model=ocr_model,
        verbose=verbose
    )

    if result:
        matched_move, confidence, explanation = result

        # Test if this fix actually helps
        test_moves = moves.copy()
        test_moves[stuck_ply] = matched_move
        test_reach, _ = play_until_stuck(test_moves)
        reach_improvement = test_reach - stuck_ply

        if reach_improvement > 0:
            fixes.append({
                'ply': stuck_ply,
                'san': matched_move,
                'ocr': original_ocr,
                'type': 'constrained_reocr',
                'confidence': confidence,
                'reach_improvement': reach_improvement,
                'completes': test_reach >= len(moves),
                'char_sim': move_similarity(original_ocr, matched_move),
                'explanation': explanation,
                'unified_score': confidence * 50 + reach_improvement * 10,
                'needs_confirmation': confidence < 0.7,  # High confidence = auto-apply
            })
            if verbose:
                print(f"   [CONSTRAINED OCR] Found fix: '{original_ocr}' -> '{matched_move}' "
                      f"(conf={confidence:.0%}, +{reach_improvement} plies)")

    return fixes


# =============================================================================
# LEGACY COMPATIBILITY WRAPPER
# =============================================================================

def find_all_fixes(
    path_moves: List[str],
    target_ply: int,
    ocr_lookup: Dict[int, OCRMove],
    total_moves: int,
    fixed_plies: Set[int] = None,
    current_absurdity: Optional[Absurdity] = None,
    verbose: bool = False
) -> List[dict]:
    """
    Legacy wrapper for find_deep_backtrack_fixes.
    Maintains compatibility with older code that used this signature.
    """
    return find_deep_backtrack_fixes(
        moves=path_moves,
        stuck_ply=target_ply,
        ocr_lookup=ocr_lookup,
        verbose=verbose,
        fixed_plies=fixed_plies
    )
