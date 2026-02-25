"""
Score2PGN - Missing Move Detection
==================================
Detects when a move was OMITTED from the scoresheet (not just written wrong).

RESTORED from v4.9.2

Key insight: Sometimes a player forgets to write down a move entirely.
This shifts all subsequent moves by one ply, causing illegal positions.
We detect this by trying to INSERT a move rather than REPLACE one.
"""

import chess
from typing import List, Dict, Optional
from data_structures import OCRMove
from helpers import try_move, play_until_stuck, ply_to_str
from similarity import move_similarity
from absurdity import find_all_absurdities

# =============================================================================
# MISSING MOVE DETECTION
# =============================================================================

def find_missing_move_candidates(
    moves: List[str], 
    stuck_ply: int, 
    ocr_lookup: Dict[int, OCRMove], 
    max_candidates: int = 10
) -> List[dict]:
    """
    When stuck at a position, check if INSERTING a move (rather than replacing) could help.
    
    This handles the case where a player forgot to write down a move.
    Also handles compound case: missing move + OCR error in the next move.
    
    Returns list of candidates sorted by quality.
    """
    if stuck_ply >= len(moves):
        return []
    
    # Play up to just before the stuck position
    board = chess.Board()
    for i in range(stuck_ply):
        m = try_move(board, moves[i])
        if m:
            board.push(m)
        else:
            return []  # Can't even get to the stuck position
    
    stuck_move_san = moves[stuck_ply]
    total_moves = len(moves)
    candidates = []
    
    # Try inserting each legal move
    for legal_move in board.legal_moves:
        inserted_san = board.san(legal_move)
        
        # Make the inserted move
        test_board = board.copy()
        test_board.push(legal_move)
        
        # CASE 1: Check if the stuck move is NOW legal (exact match)
        stuck_move_obj = try_move(test_board, stuck_move_san)
        
        if stuck_move_obj is not None:
            # Exact match - the stuck move works after insertion
            test_moves = moves[:stuck_ply] + [inserted_san] + moves[stuck_ply:]
            reach, _ = play_until_stuck(test_moves)
            improvement = reach - stuck_ply
            
            if improvement > 0:
                completes = reach >= len(test_moves)
                suspicious_count = len(find_all_absurdities(test_moves)) if completes else 99
                
                candidates.append({
                    'type': 'missing_move',
                    'insert_at_ply': stuck_ply,
                    'inserted_move': inserted_san,
                    'original_stuck_move': stuck_move_san,
                    'corrected_stuck_move': None,  # No correction needed
                    'reach': reach,
                    'improvement': improvement,
                    'completes': completes,
                    'suspicious_count': suspicious_count,
                    'char_sim': 1.0,  # Exact match
                    'match_type': 'exact',
                })
        else:
            # CASE 2: Stuck move still illegal - check if any legal move is SIMILAR
            for next_legal in test_board.legal_moves:
                next_san = test_board.san(next_legal)
                similarity = move_similarity(stuck_move_san, next_san)
                
                # Only consider if reasonably similar (likely OCR error)
                if similarity < 0.4:
                    continue
                
                # Try: insert + replace stuck move with similar legal move
                test_moves = moves[:stuck_ply] + [inserted_san, next_san] + moves[stuck_ply + 1:]
                reach, _ = play_until_stuck(test_moves)
                improvement = reach - stuck_ply
                
                if improvement > 1:  # Must get past both inserted and corrected moves
                    completes = reach >= len(test_moves)
                    suspicious_count = len(find_all_absurdities(test_moves)) if completes else 99
                    
                    candidates.append({
                        'type': 'missing_move_with_correction',
                        'insert_at_ply': stuck_ply,
                        'inserted_move': inserted_san,
                        'original_stuck_move': stuck_move_san,
                        'corrected_stuck_move': next_san,  # The OCR correction
                        'reach': reach,
                        'improvement': improvement,
                        'completes': completes,
                        'suspicious_count': suspicious_count,
                        'char_sim': similarity,
                        'match_type': 'approximate',
                    })
    
    # Sort: prefer exact matches, then by completion, reach, and suspicious count
    candidates.sort(key=lambda x: (
        0 if x['match_type'] == 'exact' else 1,  # Exact matches first
        0 if x['completes'] else 1,
        -x['reach'],
        x['suspicious_count'],
        -x['char_sim'],
    ))
    
    return candidates[:max_candidates]


def try_insert_missing_move(
    moves: List[str], 
    insert_ply: int, 
    inserted_move: str, 
    correction: dict = None
) -> List[str]:
    """
    Insert a move at the given ply, shifting all subsequent moves.
    Optionally also correct the move that was at insert_ply (now at insert_ply + 1).
    
    Returns the new move list.
    """
    new_moves = moves[:insert_ply] + [inserted_move] + moves[insert_ply:]
    
    # If there's a correction for the next move, apply it
    if correction and correction.get('corrected_stuck_move'):
        corrected_ply = insert_ply + 1
        if corrected_ply < len(new_moves):
            new_moves[corrected_ply] = correction['corrected_stuck_move']
    
    return new_moves


def detect_likely_missing_vs_wrong(
    moves: List[str], 
    stuck_ply: int, 
    ocr_lookup: Dict[int, OCRMove],
    find_all_fixes_func  # Pass this in to avoid circular import
) -> dict:
    """
    Analyze whether the problem is more likely a WRONG move or a MISSING move.
    
    Returns analysis with recommendation and confidence.
    """
    # Get candidates for both approaches
    wrong_move_fixes = find_all_fixes_func(moves, stuck_ply, ocr_lookup, len(moves), set(), None)[:5]
    missing_move_candidates = find_missing_move_candidates(moves, stuck_ply, ocr_lookup)[:5]
    
    analysis = {
        'stuck_ply': stuck_ply,
        'stuck_move': moves[stuck_ply] if stuck_ply < len(moves) else None,
        'wrong_move_fixes': wrong_move_fixes,
        'missing_move_candidates': missing_move_candidates,
        'recommendation': None,
        'confidence': 'low',
    }
    
    best_wrong = wrong_move_fixes[0] if wrong_move_fixes else None
    best_missing = missing_move_candidates[0] if missing_move_candidates else None
    
    if not best_wrong and not best_missing:
        analysis['recommendation'] = 'no_solution_found'
        return analysis
    
    if not best_missing:
        analysis['recommendation'] = 'wrong_move'
        analysis['confidence'] = 'high' if best_wrong and best_wrong.get('completes') else 'medium'
        return analysis
    
    if not best_wrong:
        analysis['recommendation'] = 'missing_move'
        analysis['confidence'] = 'high' if best_missing.get('completes') else 'medium'
        return analysis
    
    # Both have candidates - compare them
    wrong_completes = best_wrong.get('completes', False)
    missing_completes = best_missing.get('completes', False)
    
    if wrong_completes and not missing_completes:
        analysis['recommendation'] = 'wrong_move'
        analysis['confidence'] = 'medium'
    elif missing_completes and not wrong_completes:
        analysis['recommendation'] = 'missing_move'
        analysis['confidence'] = 'medium'
    else:
        # Both complete or both don't - use suspicious count
        wrong_susp = best_wrong.get('new_suspicious_count', 99)
        missing_susp = best_missing.get('suspicious_count', 99)
        
        if wrong_susp < missing_susp:
            analysis['recommendation'] = 'wrong_move'
            analysis['confidence'] = 'low'
        elif missing_susp < wrong_susp:
            analysis['recommendation'] = 'missing_move'
            analysis['confidence'] = 'low'
        else:
            # Tie - prefer wrong move (more common case)
            analysis['recommendation'] = 'wrong_move'
            analysis['confidence'] = 'low'
    
    return analysis
