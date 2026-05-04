"""
Score2PGN - Character/Move Similarity
=====================================
OCR-aware similarity scoring for chess moves.
"""

# =============================================================================
# CHARACTER SIMILARITY MAP
# =============================================================================

# Characters that look similar in handwritten/OCR chess notation
CHAR_SIMILARITIES = {
    # Piece confusions
    ('K', 'R'): 0.6, ('K', 'N'): 0.4, ('R', 'B'): 0.5, ('R', 'P'): 0.3,
    ('B', 'R'): 0.5, ('B', 'D'): 0.4, ('N', 'H'): 0.5, ('N', 'M'): 0.4, 
    ('N', 'B'): 0.6, ('B', 'N'): 0.6,  # B<->N common confusion (vertical line + curves)
    ('Q', 'O'): 0.5, ('Q', 'G'): 0.3,
    
    # File letter confusions
    ('a', 'd'): 0.6, ('a', 'o'): 0.5, ('a', 'e'): 0.4,
    ('a', 'g'): 0.8, ('g', 'a'): 0.8,  # g with cut-off tail looks like a - VERY common!
    ('b', 'd'): 0.6, ('b', 'h'): 0.5, ('c', 'e'): 0.7, ('c', 'o'): 0.4,
    ('c', 'd'): 0.5, ('d', 'a'): 0.6, ('d', 'h'): 0.7, ('d', 'c'): 0.5,
    ('e', 'c'): 0.7, ('e', 'f'): 0.5, ('e', 'a'): 0.4,
    ('f', 'e'): 0.5, ('g', 'q'): 0.6,
    ('h', 'b'): 0.5, ('h', 'n'): 0.4, ('h', 'd'): 0.7,
    ('c', 'f'): 0.4, ('f', 'c'): 0.4,
    ('d', 'g'): 0.5, ('g', 'd'): 0.5, # Both have round body, but different orientation

    # Rank number confusions - EXPANDED
    # Calibrated against ABBYY Cloud confusion matrix (Horvath/Dreher thesis §11.2.4)
    # and adjusted upward since our BiLSTM has higher confusion rates than ABBYY.
    ('1', '7'): 0.5, ('1', 'l'): 0.6, ('1', '5'): 0.4, ('1', '4'): 0.4,
    ('1', '2'): 0.3, ('1', '3'): 0.4, ('1', '6'): 0.5, ('1', '8'): 0.3,  # ABBYY: 6→1=53, 3→1=29
    ('2', '7'): 0.6, ('2', 'z'): 0.4, ('2', '6'): 0.6,  # Added 2<->6
    ('2', '4'): 0.4, ('2', '5'): 0.5, ('2', '8'): 0.3,  # ABBYY: 5→2=36, 4→2=27
    ('3', '8'): 0.5, ('3', '5'): 0.6, ('3', '6'): 0.5,
    ('3', '4'): 0.6, ('4', '3'): 0.6,  # 3<->4 confusion
    ('3', '7'): 0.3,  # ABBYY: 7→3=5, 3→7=1
    ('4', '9'): 0.4, ('4', '1'): 0.4,
    ('4', '5'): 0.3, ('4', '6'): 0.3, ('4', '7'): 0.3, ('4', '8'): 0.2,  # ABBYY: 4→5=9, 4→7=6
    ('5', '3'): 0.6, ('5', '6'): 0.6, ('5', 's'): 0.4,
    ('5', '7'): 0.2, ('5', '8'): 0.3,  # ABBYY: 5→8=4, 8→5=5
    ('6', '5'): 0.6, ('6', '8'): 0.5, ('6', 'b'): 0.4, ('6', '2'): 0.6,  # Added 6<->2
    ('6', '7'): 0.2,  # ABBYY: rare
    ('7', '1'): 0.5, ('7', '2'): 0.6,
    ('7', '8'): 0.2,  # ABBYY: 0 confusions, but keep non-default
    ('8', '3'): 0.5, ('8', '6'): 0.5, ('8', 'B'): 0.3,
    ('2', '3'): 0.5, ('3', '2'): 0.5, # Similar curves, but keep below 2↔7 (0.6) mirror confusion
   
    # Special characters
    ('x', 'X'): 0.95, ('O', '0'): 0.95,
    
    # Q confusions (curved letter with tail)
    ('Q', 'C'): 0.5, ('c', 'Q'): 0.5, ('Q', 'c'): 0.5, ('C', 'Q'): 0.5,
    ('Q', 'G'): 0.4, ('G', 'Q'): 0.4,
    ('x', 'Q'): 0.3, ('Q', 'x'): 0.3,
    ('Q', 'd'): 0.4, ('d', 'Q'): 0.4,  # Q can look like d (round shape)
    
    # B vs other round letters
    ('B', 'D'): 0.5, ('D', 'B'): 0.5,
    ('B', 'P'): 0.4, ('P', 'B'): 0.4,
    
    # B vs Q - these are quite different
    ('B', 'Q'): 0.2, ('Q', 'B'): 0.2,

    # Piece letter <-> file letter confusions (for captures: Kxg4 vs hxg4)
    ('K', 'h'): 0.6, ('h', 'K'): 0.6,  # King looks like h-file in handwriting
    ('B', 'b'): 0.7, ('b', 'B'): 0.7,  # Bishop B very similar to b-file
}

# =============================================================================
# SIMILARITY FUNCTIONS
# =============================================================================

def get_char_similarity(c1: str, c2: str) -> float:
    """Get visual similarity score between two characters (0.0 to 1.0)."""
    if c1 == c2:
        return 1.0
    key = (c1, c2)
    if key in CHAR_SIMILARITIES:
        return CHAR_SIMILARITIES[key]
    key = (c2, c1)
    if key in CHAR_SIMILARITIES:
        return CHAR_SIMILARITIES[key]
    # Same letter different case
    if c1.lower() == c2.lower():
        return 0.9
    return 0.1


def move_similarity(ocr_move: str, candidate_move: str) -> float:
    """
    Calculate visual similarity between OCR text and a candidate move.
    Returns 0.0 to 1.0.
    """
    # Extract check/capture flags BEFORE stripping
    ocr_has_check = '+' in ocr_move
    ocr_has_mate = '#' in ocr_move
    ocr_has_capture = 'x' in ocr_move
    cand_has_check = '+' in candidate_move
    cand_has_mate = '#' in candidate_move
    cand_has_capture = 'x' in candidate_move

    ocr = ocr_move.rstrip('+#')
    cand = candidate_move.rstrip('+#')

    # Track if this is an exact match (100% allowed) vs similar (cap at 98%)
    is_exact_match = False

    # Exact match (after stripping check/mate)
    if ocr == cand:
        # Still apply check bonus for exact match
        best_score = 1.0
        is_exact_match = True
    elif ocr.upper().replace('0', 'O') in ['O-O', 'OO'] and cand == 'O-O':
        return 1.0  # Castling normalization - exact match
    elif ocr.upper().replace('0', 'O') in ['O-O-O', 'OOO'] and cand == 'O-O-O':
        return 1.0  # Castling normalization - exact match
    elif 'O' in ocr.upper().replace('0', 'O') or cand in ['O-O', 'O-O-O']:
        return 0.1
    elif len(ocr) == 0 or len(cand) == 0:
        return 0.1
    else:
        # === COMPUTE BASE SCORE ===
        len_diff = abs(len(ocr) - len(cand))
        length_penalty = 0.15 * len_diff if len_diff >= 2 else 0
        
        ocr_piece = ocr[0] if ocr[0] in 'KQRBN' else 'P'
        cand_piece = cand[0] if cand[0] in 'KQRBN' else 'P'
        piece_match = (ocr_piece == cand_piece)
        
        # Extract destinations
        ocr_dest = None
        cand_dest = None
        ocr_clean = ocr.replace('x', '')
        cand_clean = cand.replace('x', '')
        if len(ocr_clean) >= 2 and ocr_clean[-2] in 'abcdefgh' and ocr_clean[-1] in '12345678':
            ocr_dest = ocr_clean[-2:]
        if len(cand_clean) >= 2 and cand_clean[-2] in 'abcdefgh' and cand_clean[-1] in '12345678':
            cand_dest = cand_clean[-2:]
        
        best_score = None
        
        # === SAME DESTINATION SQUARE ===
        if ocr_dest and cand_dest and ocr_dest == cand_dest:
            # Check for disambiguation presence mismatch (e.g., "Rfa8" vs "Ra8")
            # One has disambiguation char, the other doesn't - penalize
            disambig_penalty = 0
            if piece_match and ocr_piece != 'P':
                ocr_has_disambig = len(ocr_clean) >= 4 and ocr_clean[1] in 'abcdefgh12345678'
                cand_has_disambig = len(cand_clean) >= 4 and cand_clean[1] in 'abcdefgh12345678'
                if ocr_has_disambig != cand_has_disambig:
                    disambig_penalty = 0.12
            if piece_match:
                best_score = max(0.1, 0.98 - length_penalty - disambig_penalty)
            else:
                piece_sim = get_char_similarity(ocr_piece, cand_piece)
                if ocr_piece != 'P' and cand_piece != 'P':
                    best_score = max(0.1, 0.80 + 0.15 * piece_sim - length_penalty)
                else:
                    best_score = max(0.1, 0.70 + 0.15 * piece_sim - length_penalty)
        
        # === SAME PIECE + SAME FILE ===
        if best_score is None and piece_match and ocr_dest and cand_dest:
            if ocr_dest[0] == cand_dest[0]:
                rank_sim = get_char_similarity(ocr_dest[1], cand_dest[1])
                base_score = 0.85 + 0.15 * rank_sim
                
                # Check for disambiguation character mismatch (e.g., Rad6 vs Rfd8)
                # OCR: "Rad6" -> ocr_clean = "Rad6", disambiguation = 'a'
                # Cand: "Rfd8" -> cand_clean = "Rfd8", disambiguation = 'f'
                ocr_disambig = None
                cand_disambig = None
                if len(ocr_clean) >= 4 and ocr_clean[1] in 'abcdefgh12345678':
                    ocr_disambig = ocr_clean[1]
                if len(cand_clean) >= 4 and cand_clean[1] in 'abcdefgh12345678':
                    cand_disambig = cand_clean[1]
                
                if ocr_disambig and cand_disambig and ocr_disambig != cand_disambig:
                    disambig_sim = get_char_similarity(ocr_disambig, cand_disambig)
                    base_score = base_score * (0.5 + 0.5 * disambig_sim)  # Penalize mismatch
                
                best_score = max(0.1, base_score - length_penalty)

        # === SAME PIECE + SAME RANK ===
        if best_score is None and piece_match and ocr_dest and cand_dest:
            if ocr_dest[1] == cand_dest[1]:
                file_sim = get_char_similarity(ocr_dest[0], cand_dest[0])
                base_score = 0.75 + 0.20 * file_sim

                # Check disambiguation (e.g., "Rfa8" vs "Rfd8" - both have 'f')
                if ocr_piece != 'P':
                    ocr_disambig = ocr_clean[1] if len(ocr_clean) >= 4 and ocr_clean[1] in 'abcdefgh12345678' else None
                    cand_disambig = cand_clean[1] if len(cand_clean) >= 4 and cand_clean[1] in 'abcdefgh12345678' else None
                    if ocr_disambig and cand_disambig:
                        if ocr_disambig == cand_disambig:
                            base_score += 0.05  # Reward matching disambiguation
                        else:
                            disambig_sim = get_char_similarity(ocr_disambig, cand_disambig)
                            base_score = base_score * (0.5 + 0.5 * disambig_sim)  # Penalize mismatch

                best_score = max(0.1, base_score - length_penalty)
        
        # === STANDARD CHARACTER COMPARISON (fallback) ===
        if best_score is None:
            max_len = max(len(ocr), len(cand))
            direct_score = sum(get_char_similarity(ocr[i], cand[i]) 
                              for i in range(min(len(ocr), len(cand)))) / max_len
            best_score = direct_score
            
            # Handle off-by-one length
            if abs(len(ocr) - len(cand)) == 1:
                longer, shorter = (ocr, cand) if len(ocr) > len(cand) else (cand, ocr)
                for skip_pos in range(len(longer)):
                    score = 0
                    shorter_idx = 0
                    for j in range(len(longer)):
                        if j == skip_pos:
                            continue
                        if shorter_idx < len(shorter):
                            score += get_char_similarity(longer[j], shorter[shorter_idx])
                            shorter_idx += 1
                    best_score = max(best_score, score / max_len)
            
            # Destination weighting
            if ocr_dest and cand_dest:
                dest_sim = (get_char_similarity(ocr_dest[0], cand_dest[0]) + 
                           get_char_similarity(ocr_dest[1], cand_dest[1])) / 2
                best_score = best_score * 0.4 + dest_sim * 0.6
            
            # Piece match bonus / mismatch penalty
            if piece_match and ocr_piece != 'P':
                # Got the piece right — ensure a minimum floor (e.g., Qa7 vs Qxh3)
                best_score = max(best_score, 0.35)
            elif not piece_match and ocr_piece != 'P' and cand_piece != 'P':
                best_score *= 0.7

            best_score = best_score - length_penalty

    # === CAPTURE BONUS/PENALTY (always applied) ===
    if ocr_has_capture:
        if cand_has_capture:
            best_score += 0.08
        else:
            best_score -= 0.06
    elif cand_has_capture:
        best_score -= 0.03

    # === CHECK SYMBOL BONUS/PENALTY (always applied) ===
    if ocr_has_check:
        if cand_has_check:
            best_score += 0.25  # Both have + : strong match!
        else:
            best_score -= 0.15  # OCR has + but candidate doesn't: penalty
    if ocr_has_mate:
        if cand_has_mate:
            best_score += 0.30
        else:
            best_score -= 0.20

    # Cap at 100% for exact matches, 98% for similar-but-different moves
    # This distinguishes "Qb3 vs Qb3" (100%) from "Qxb4+ vs Qxb7+" (98% max)
    max_score = 1.0 if is_exact_match else 0.98
    return min(max_score, max(0.0, best_score))