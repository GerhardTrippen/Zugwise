"""
Score2PGN - Constraint Satisfaction
===================================
Detects when pieces are blocked from developing due to earlier OCR errors.

Key insight: If the OCR shows a Bishop moving to a light square later in the game,
but the light-squared Bishop is currently blocked, an earlier move must be wrong.

RESTORED from v4.8
"""

import chess
from typing import List, Optional, Dict
from data_structures import OCRMove
from helpers import try_move, ply_to_str
from similarity import move_similarity

# =============================================================================
# SQUARE COLOR UTILITIES
# =============================================================================

def is_light_square(square_name: str) -> bool:
    """Determine if a square is light-colored."""
    if len(square_name) != 2:
        return False
    file_num = ord(square_name[0]) - ord('a')
    rank_num = int(square_name[1]) - 1
    return (file_num + rank_num) % 2 == 1


def get_bishop_square_color(move: str) -> Optional[str]:
    """
    Determine if a Bishop move is to a light or dark square.
    Returns 'light', 'dark', or None if not a Bishop move.
    """
    if not move or move[0] != 'B':
        return None
    clean = move.rstrip('+#')
    if len(clean) < 3:
        return None
    dest = clean[-2:]
    if dest[0] in 'abcdefgh' and dest[1] in '12345678':
        return 'light' if is_light_square(dest) else 'dark'
    return None


# =============================================================================
# FUTURE MOVE SCANNING
# =============================================================================

def find_future_piece_moves(
    ocr_lookup: Dict[int, OCRMove], 
    piece_type: str, 
    color: str, 
    from_ply: int, 
    total_moves: int, 
    bishop_square_color: Optional[str] = None, 
    min_confidence: float = 0.85
) -> List[dict]:
    """
    Scan OCR data for future moves of a specific piece type.
    
    For Bishops, can filter by square color (light/dark).
    Returns list of {'ply': int, 'move': str, 'confidence': float}
    """
    future_moves = []
    for ply in range(from_ply, total_moves):
        ply_color = 'w' if ply % 2 == 0 else 'b'
        if ply_color != color:
            continue
        ocr_move = ocr_lookup.get(ply)
        if not ocr_move:
            continue
        top_move = ocr_move.top_move
        confidence = ocr_move.top_confidence
        if confidence < min_confidence:
            continue
        if top_move and len(top_move) >= 1 and top_move[0] == piece_type:
            # For Bishops, check square color matches
            if piece_type == 'B' and bishop_square_color:
                move_square_color = get_bishop_square_color(top_move)
                if move_square_color and move_square_color != bishop_square_color:
                    continue
            future_moves.append({'ply': ply, 'move': top_move, 'confidence': confidence})
    return future_moves


# =============================================================================
# CONSTRAINT CLUSTER DETECTION
# =============================================================================

def find_piece_constraint_cluster(
    moves: List[str], 
    ocr_lookup: Dict[int, OCRMove], 
    stuck_ply: int, 
    total_moves: int, 
    verbose: bool = False
) -> Optional[dict]:
    """
    Check if we're stuck because a piece can't move at all (blocked).
    
    This differs from a simple illegal move - here the piece TYPE cannot make ANY
    legal move, suggesting an earlier error put pieces in wrong positions.
    
    Returns cluster info if found, None otherwise.
    """
    if stuck_ply >= len(moves):
        return None
    
    stuck_move = moves[stuck_ply]
    if not stuck_move or len(stuck_move) < 2:
        return None
    
    piece_type = stuck_move[0]
    if piece_type not in 'KQRBN':
        return None
    
    color = 'w' if stuck_ply % 2 == 0 else 'b'
    
    # Build position
    board = chess.Board()
    for i in range(stuck_ply):
        m = try_move(board, moves[i])
        if m:
            board.push(m)
        else:
            return None
    
    bishop_square_color = get_bishop_square_color(stuck_move) if piece_type == 'B' else None
    
    # Check if this piece type can make ANY legal move
    piece_can_move = False
    for move in board.legal_moves:
        moving_piece = board.piece_at(move.from_square)
        if moving_piece and moving_piece.symbol().upper() == piece_type:
            if piece_type == 'B' and bishop_square_color:
                from_sq = chess.square_name(move.from_square)
                if (bishop_square_color == 'light') == is_light_square(from_sq):
                    piece_can_move = True
                    break
            else:
                piece_can_move = True
                break
    
    if piece_can_move:
        if verbose:
            print(f"\n   [i]  {piece_type} can move (just not to OCR destination) - not a development issue")
        return None
    
    if verbose:
        bishop_info = f" ({bishop_square_color}-squared)" if bishop_square_color else ""
        print(f"\n   [!]  {piece_type}{bishop_info} is BLOCKED - checking for development issue...")
    
    # Look for future moves of this piece (suggests it SHOULD be able to move)
    future_moves = find_future_piece_moves(
        ocr_lookup, piece_type, color, stuck_ply + 1, total_moves, 
        bishop_square_color, min_confidence=0.85
    )
    
    if not future_moves:
        return None
    
    stuck_ocr = ocr_lookup.get(stuck_ply)
    stuck_confidence = stuck_ocr.top_confidence if stuck_ocr else 0.0
    
    cluster = {
        'piece_type': piece_type,
        'color': color,
        'stuck_ply': stuck_ply,
        'stuck_move': stuck_move,
        'stuck_confidence': stuck_confidence,
        'future_moves': future_moves,
        'high_confidence_future': sum(1 for m in future_moves if m['confidence'] >= 0.9),
        'bishop_square_color': bishop_square_color
    }
    
    if verbose:
        print(f"\n   [SEARCH] Constraint cluster for {piece_type} ({color}):")
        print(f"      Stuck: {ply_to_str(stuck_ply)} {stuck_move} ({stuck_confidence:.0%})")
        print(f"      Future moves: {len(future_moves)} ({cluster['high_confidence_future']} high-conf)")
    
    return cluster


def find_development_blocker(
    moves: List[str], 
    ocr_lookup: Dict[int, OCRMove], 
    cluster: dict, 
    verbose: bool = False
) -> List[dict]:
    """
    Find earlier moves that, if changed, would allow the blocked piece to develop.
    
    Returns list of potential enablers sorted by (constraints_satisfied, char_sim).
    """
    piece_type = cluster['piece_type']
    color = cluster['color']
    stuck_ply = cluster['stuck_ply']
    stuck_move = cluster['stuck_move']
    total_constraints = 1 + len(cluster['future_moves'])
    
    enablers = []
    
    # Extract destination square from stuck move
    dest = None
    for i in range(len(stuck_move)-1, 0, -1):
        if stuck_move[i] in '12345678' and i > 0 and stuck_move[i-1] in 'abcdefgh':
            dest = stuck_move[i-1:i+1]
            break
    
    if not dest:
        return []
    
    # Search earlier plies for potential fixes
    for fix_ply in range(stuck_ply):
        # Only check same-color moves
        if (fix_ply % 2 == 0) != (color == 'w'):
            continue
        
        original_move = moves[fix_ply]
        
        # Build position at fix_ply
        board_at_fix = chess.Board()
        valid = True
        for i in range(fix_ply):
            m = try_move(board_at_fix, moves[i])
            if m:
                board_at_fix.push(m)
            else:
                valid = False
                break
        
        if not valid:
            continue
        
        # Try each legal alternative
        for candidate_move in board_at_fix.legal_moves:
            candidate_san = board_at_fix.san(candidate_move)
            if candidate_san.rstrip('+#') == original_move.rstrip('+#'):
                continue
            
            # Test if this alternative allows the stuck move
            test_moves = moves.copy()
            test_moves[fix_ply] = candidate_san
            
            test_board = chess.Board()
            can_reach = True
            for i in range(stuck_ply):
                move_to_play = candidate_san if i == fix_ply else moves[i]
                m = try_move(test_board, move_to_play)
                if m:
                    test_board.push(m)
                else:
                    can_reach = False
                    break
            
            if not can_reach:
                continue
            
            # Check if stuck move is now legal
            if try_move(test_board, stuck_move) is None:
                continue
            
            char_sim = move_similarity(original_move, candidate_san)
            ocr_m = ocr_lookup.get(fix_ply)
            ocr_conf = ocr_m.get_confidence(candidate_san) if ocr_m else 0.0
            
            enablers.append({
                'fix_ply': fix_ply,
                'original': original_move,
                'replacement': candidate_san,
                'constraints_satisfied': total_constraints,
                'char_sim': char_sim,
                'ocr_conf': ocr_conf,
            })
    
    enablers.sort(key=lambda x: (-x['constraints_satisfied'], -x['char_sim']))
    return enablers


def scan_ocr_for_piece_clusters(
    ocr_lookup: Dict[int, OCRMove], 
    total_moves: int, 
    verbose: bool = False
) -> List[dict]:
    """
    Pre-scan OCR data to identify pieces with multiple high-confidence moves.
    
    This helps prioritize which pieces are "real" vs OCR errors.
    """
    clusters = []
    piece_moves = {}
    
    for ply in range(total_moves):
        ocr_m = ocr_lookup.get(ply)
        if not ocr_m:
            continue
        top_move = ocr_m.top_move
        if not top_move or len(top_move) < 2:
            continue
        piece = top_move[0]
        if piece not in 'QRBN':
            continue
        color = 'w' if ply % 2 == 0 else 'b'
        key = (piece, color)
        if key not in piece_moves:
            piece_moves[key] = []
        piece_moves[key].append({'ply': ply, 'move': top_move, 'confidence': ocr_m.top_confidence})
    
    for (piece, color), moves_list in piece_moves.items():
        high_conf = [m for m in moves_list if m['confidence'] >= 0.9]
        if len(high_conf) >= 2:
            clusters.append({
                'piece_type': piece,
                'color': color,
                'high_confidence_moves': high_conf,
                'count': len(high_conf),
                'first_ply': min(m['ply'] for m in high_conf)
            })
    
    clusters.sort(key=lambda x: (-x['count'], x['first_ply']))
    
    if verbose and clusters:
        print(f"\n   [ANALYSIS] OCR piece clusters detected:")
        for c in clusters[:3]:
            moves_str = [(ply_to_str(m['ply']), m['move'], f"{m['confidence']:.0%}") 
                        for m in c['high_confidence_moves'][:4]]
            print(f"      {c['piece_type']} ({c['color']}): {c['count']} high-conf moves - {moves_str}")
    
    return clusters
