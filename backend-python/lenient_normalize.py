"""
Score2PGN - Lenient Move Normalization
=======================================
Converts non-standard chess notation (from lenient grammar decode) into
standard SAN that can be validated against a chess.Board.

Supported patterns:
  - P prefix: Pe4 -> e4, Pxe4 -> exd4, Pe8=Q -> e8=Q
  - File-captures-file: cd -> cxd?, cxd -> cxd?  (find legal pawn capture)
  - Piece-captures-piece: BxN -> find legal bishop capturing knight
  - Piece-captures-piece-on-square: NxBc4 -> verify knight captures bishop on c4
  - Extended notation: Nf3-e5 -> Ne5, e2-e4 -> e4, Bc1-f4 -> Bf4
  - Zero castling: 0-0 -> O-O, 0-0-0 -> O-O-O
"""

import re
import chess
from typing import Optional, Dict, List


# Piece letter to chess piece type mapping
PIECE_MAP = {
    'K': chess.KING, 'Q': chess.QUEEN, 'R': chess.ROOK,
    'B': chess.BISHOP, 'N': chess.KNIGHT, 'P': chess.PAWN,
}


def normalize_lenient_move(raw: str, board: chess.Board) -> Dict:
    """
    Convert a lenient grammar output to standard SAN.

    Args:
        raw: Non-standard move string (e.g., "Pe4", "cd", "BxN", "Nf3-e5", "0-0")
        board: Current chess.Board position

    Returns:
        dict with keys:
            san: str or None (resolved standard SAN, None if cannot resolve)
            raw: str (original input)
            notation_type: str (which pattern matched)
            ambiguous: bool (True if multiple legal moves matched)
    """
    if not raw or not raw.strip():
        return {'san': None, 'raw': raw, 'notation_type': 'empty', 'ambiguous': False}

    raw = raw.strip()

    # Pattern 6: Zero castling (0-0 -> O-O, 0-0-0 -> O-O-O)
    result = _try_zero_castling(raw, board)
    if result:
        return result

    # Pattern 5: Extended notation with dash (Nf3-e5, e2-e4, Bc1-f4)
    result = _try_extended_notation(raw, board)
    if result:
        return result

    # Pattern 7: Square-captures-square (c6xd4, e4xd5)
    result = _try_square_captures_square(raw, board)
    if result:
        return result

    # Pattern 1: P prefix (Pe4, Pxe4, Pe8=Q)
    result = _try_p_prefix(raw, board)
    if result:
        return result

    # Pattern 3: Piece-captures-piece (BxN, RxR, QxB, PxP)
    result = _try_piece_captures_piece(raw, board)
    if result:
        return result

    # Pattern 4: Piece-captures-piece-on-square (NxBc4, QxRa1)
    result = _try_piece_captures_piece_on_square(raw, board)
    if result:
        return result

    # Pattern 2: File-captures-file (cd, cxd, ef, exf)
    result = _try_file_capture(raw, board)
    if result:
        return result

    return {'san': None, 'raw': raw, 'notation_type': 'unknown', 'ambiguous': False}


def _try_zero_castling(raw: str, board: chess.Board) -> Optional[Dict]:
    """0-0 -> O-O, 0-0-0 -> O-O-O"""
    clean = raw.rstrip('+#')
    suffix = raw[len(clean):]

    if clean == '0-0-0':
        san = 'O-O-O'
        try:
            board.parse_san(san)
            return {'san': san + suffix, 'raw': raw, 'notation_type': 'zero_castling', 'ambiguous': False}
        except:
            return {'san': None, 'raw': raw, 'notation_type': 'zero_castling', 'ambiguous': False}
    elif clean == '0-0':
        san = 'O-O'
        try:
            board.parse_san(san)
            return {'san': san + suffix, 'raw': raw, 'notation_type': 'zero_castling', 'ambiguous': False}
        except:
            return {'san': None, 'raw': raw, 'notation_type': 'zero_castling', 'ambiguous': False}
    return None


def _try_extended_notation(raw: str, board: chess.Board) -> Optional[Dict]:
    """Nf3-e5 -> Ne5, e2-e4 -> e4, Bc1-f4 -> Bf4"""
    clean = raw.rstrip('+#')
    suffix = raw[len(clean):]

    # Strip promotion if present
    promo = ''
    if '=' in clean:
        eq_idx = clean.index('=')
        promo = clean[eq_idx:]
        clean = clean[:eq_idx]

    if '-' not in clean:
        return None
    # Skip castling-like patterns
    if clean.startswith('O') or clean.startswith('0'):
        return None

    dash_idx = clean.index('-')
    before = clean[:dash_idx]
    after = clean[dash_idx + 1:]

    # Extract destination square
    if len(after) != 2 or after[0] not in 'abcdefgh' or after[1] not in '12345678':
        return None

    dest_sq = after

    # Extract piece (if any) and source square
    piece = ''
    if before and before[0] in 'KQRBN':
        piece = before[0]
        src = before[1:]
    else:
        src = before

    if len(src) != 2 or src[0] not in 'abcdefgh' or src[1] not in '12345678':
        return None

    # Try to find the legal move: piece from src to dest
    dest_square = chess.parse_square(dest_sq)
    src_square = chess.parse_square(src)

    matches = []
    for move in board.legal_moves:
        if move.to_square != dest_square or move.from_square != src_square:
            continue
        san = board.san(move)
        if piece:
            # Verify piece type matches
            moved_piece = board.piece_at(move.from_square)
            if moved_piece and moved_piece.symbol().upper() == piece:
                matches.append(san)
        else:
            # Pawn move
            moved_piece = board.piece_at(move.from_square)
            if moved_piece and moved_piece.piece_type == chess.PAWN:
                matches.append(san)

    if len(matches) == 1:
        san = matches[0]
        # Add promotion if needed
        if promo and '=' not in san:
            san = san + promo
        return {'san': san + suffix, 'raw': raw, 'notation_type': 'extended', 'ambiguous': False}
    elif len(matches) > 1:
        return {'san': matches[0] + suffix, 'raw': raw, 'notation_type': 'extended', 'ambiguous': True}

    return None


def _try_square_captures_square(raw: str, board: chess.Board) -> Optional[Dict]:
    """c6xd4 -> Nxd4 (find piece on source square that captures destination)"""
    clean = raw.rstrip('+#')
    suffix = raw[len(clean):]

    # Strip promotion if present
    promo = ''
    if '=' in clean:
        eq_idx = clean.index('=')
        promo = clean[eq_idx:]
        clean = clean[:eq_idx]

    # Pattern: [file][rank]x[file][rank]
    m = re.match(r'^([a-h][1-8])x([a-h][1-8])$', clean)
    if not m:
        return None

    src_sq = m.group(1)
    dst_sq = m.group(2)
    src_square = chess.parse_square(src_sq)
    dst_square = chess.parse_square(dst_sq)

    matches = []
    for move in board.legal_moves:
        if move.from_square == src_square and move.to_square == dst_square:
            san = board.san(move)
            matches.append(san)

    if len(matches) == 1:
        san = matches[0]
        if promo and '=' not in san:
            san = san + promo
        return {'san': san + suffix, 'raw': raw, 'notation_type': 'square_captures_square', 'ambiguous': False}
    elif len(matches) > 1:
        return {'san': matches[0] + suffix, 'raw': raw, 'notation_type': 'square_captures_square', 'ambiguous': True}

    return None


def _try_p_prefix(raw: str, board: chess.Board) -> Optional[Dict]:
    """Pe4 -> e4, Pxe4 -> pawn capture, Pe8=Q -> e8=Q"""
    if not raw.startswith('P'):
        return None

    # Strip P prefix and try as pawn move
    stripped = raw[1:]
    if not stripped:
        return None

    # Direct: Pe4 -> e4, Pd5 -> d5
    try:
        board.parse_san(stripped)
        return {'san': stripped, 'raw': raw, 'notation_type': 'p_prefix', 'ambiguous': False}
    except:
        pass

    # Try with capture x added/removed
    if 'x' not in stripped and len(stripped) >= 3 and stripped[0] in 'abcdefgh' and stripped[1] in 'abcdefgh':
        with_x = stripped[0] + 'x' + stripped[1:]
        try:
            board.parse_san(with_x)
            return {'san': with_x, 'raw': raw, 'notation_type': 'p_prefix', 'ambiguous': False}
        except:
            pass

    # Handle Pxd5 / Pxe4 pattern: "x" + destination, find pawn that can capture there
    if stripped.startswith('x') and len(stripped) >= 3:
        dest_str = stripped[1:3]  # e.g., "d5"
        promo_suffix = stripped[3:]  # e.g., "=Q" or ""
        if dest_str[0] in 'abcdefgh' and dest_str[1] in '12345678':
            try:
                dest_square = chess.parse_square(dest_str)
            except:
                return None
            matches = []
            for move in board.legal_moves:
                if move.to_square != dest_square:
                    continue
                if not board.is_capture(move):
                    continue
                moved = board.piece_at(move.from_square)
                if moved and moved.piece_type == chess.PAWN:
                    san = board.san(move)
                    # Add promotion suffix if specified and not already in SAN
                    if promo_suffix and '=' not in san:
                        san = san + promo_suffix
                    matches.append(san)
            if len(matches) == 1:
                return {'san': matches[0], 'raw': raw, 'notation_type': 'p_prefix', 'ambiguous': False}
            elif len(matches) > 1:
                return {'san': matches[0], 'raw': raw, 'notation_type': 'p_prefix', 'ambiguous': True}

    # Handle Pd5 where d5 is a capture (pawn push notation but it's a capture square)
    # Find any legal pawn move to this square
    if len(stripped) >= 2 and stripped[0] in 'abcdefgh' and stripped[1] in '12345678':
        dest_str = stripped[:2]
        promo_suffix = stripped[2:]
        try:
            dest_square = chess.parse_square(dest_str)
        except:
            return None
        matches = []
        for move in board.legal_moves:
            if move.to_square != dest_square:
                continue
            moved = board.piece_at(move.from_square)
            if moved and moved.piece_type == chess.PAWN:
                san = board.san(move)
                if promo_suffix and '=' not in san:
                    san = san + promo_suffix
                matches.append(san)
        if len(matches) == 1:
            return {'san': matches[0], 'raw': raw, 'notation_type': 'p_prefix', 'ambiguous': False}
        elif len(matches) > 1:
            return {'san': matches[0], 'raw': raw, 'notation_type': 'p_prefix', 'ambiguous': True}

    return None


def _try_piece_captures_piece(raw: str, board: chess.Board) -> Optional[Dict]:
    """BxN -> find legal bishop capturing knight, PxP -> pawn capturing pawn"""
    clean = raw.rstrip('+#')
    suffix = raw[len(clean):]

    if len(clean) != 3 or clean[1] != 'x':
        return None
    attacker_letter = clean[0]
    victim_letter = clean[2]

    if attacker_letter not in PIECE_MAP or victim_letter not in PIECE_MAP:
        return None

    attacker_type = PIECE_MAP[attacker_letter]
    victim_type = PIECE_MAP[victim_letter]

    matches = []
    for move in board.legal_moves:
        if not board.is_capture(move):
            continue
        moved_piece = board.piece_at(move.from_square)
        captured_piece = board.piece_at(move.to_square)
        if moved_piece and moved_piece.piece_type == attacker_type:
            if captured_piece and captured_piece.piece_type == victim_type:
                matches.append(board.san(move))

    if len(matches) == 1:
        return {'san': matches[0], 'raw': raw, 'notation_type': 'piece_captures_piece', 'ambiguous': False}
    elif len(matches) > 1:
        return {'san': matches[0], 'raw': raw, 'notation_type': 'piece_captures_piece', 'ambiguous': True}

    return None


def _try_piece_captures_piece_on_square(raw: str, board: chess.Board) -> Optional[Dict]:
    """NxBc4 -> verify knight captures bishop on c4"""
    clean = raw.rstrip('+#')
    suffix = raw[len(clean):]

    # Pattern: [KQRBN]x[KQRBNP][a-h][1-8]
    if len(clean) != 5 or clean[1] != 'x':
        return None
    attacker_letter = clean[0]
    victim_letter = clean[2]
    dest_file = clean[3]
    dest_rank = clean[4]

    if attacker_letter not in 'KQRBN' or victim_letter not in PIECE_MAP:
        return None
    if dest_file not in 'abcdefgh' or dest_rank not in '12345678':
        return None

    attacker_type = PIECE_MAP[attacker_letter]
    victim_type = PIECE_MAP[victim_letter]
    dest_square = chess.parse_square(dest_file + dest_rank)

    matches = []
    for move in board.legal_moves:
        if move.to_square != dest_square:
            continue
        if not board.is_capture(move):
            continue
        moved_piece = board.piece_at(move.from_square)
        captured_piece = board.piece_at(move.to_square)
        if moved_piece and moved_piece.piece_type == attacker_type:
            if captured_piece and captured_piece.piece_type == victim_type:
                matches.append(board.san(move))

    if len(matches) == 1:
        return {'san': matches[0], 'raw': raw, 'notation_type': 'piece_captures_piece_sq', 'ambiguous': False}
    elif len(matches) > 1:
        return {'san': matches[0], 'raw': raw, 'notation_type': 'piece_captures_piece_sq', 'ambiguous': True}

    return None


def _try_file_capture(raw: str, board: chess.Board) -> Optional[Dict]:
    """cd -> find pawn capture c-file to d-file, cxd -> same"""
    clean = raw.rstrip('+#')
    suffix = raw[len(clean):]

    # Extract source and dest files
    if len(clean) == 2 and clean[0] in 'abcdefgh' and clean[1] in 'abcdefgh':
        src_file = clean[0]
        dst_file = clean[1]
    elif len(clean) == 3 and clean[0] in 'abcdefgh' and clean[1] == 'x' and clean[2] in 'abcdefgh':
        src_file = clean[0]
        dst_file = clean[2]
    else:
        return None

    # Check adjacency
    if abs(ord(src_file) - ord(dst_file)) != 1:
        return None

    # Find all legal pawn captures from src_file to dst_file
    matches = []
    for move in board.legal_moves:
        if not board.is_capture(move):
            continue
        moved_piece = board.piece_at(move.from_square)
        if not moved_piece or moved_piece.piece_type != chess.PAWN:
            continue
        from_file = chess.square_file(move.from_square)
        to_file = chess.square_file(move.to_square)
        if chr(from_file + ord('a')) == src_file and chr(to_file + ord('a')) == dst_file:
            matches.append(board.san(move))

    if len(matches) == 1:
        return {'san': matches[0], 'raw': raw, 'notation_type': 'file_capture', 'ambiguous': False}
    elif len(matches) > 1:
        return {'san': matches[0], 'raw': raw, 'notation_type': 'file_capture', 'ambiguous': True}

    return None


def extract_partial_info(raw: str) -> Dict:
    """
    Extract structured partial information from a lenient move string.
    Useful for future lookahead heuristics.

    Returns dict with:
        piece: str or None (K, Q, R, B, N, P)
        is_capture: bool
        source_file: str or None
        source_rank: str or None
        dest_file: str or None
        dest_rank: str or None
        notation_type: str
    """
    if not raw:
        return {'piece': None, 'is_capture': False, 'source_file': None, 'source_rank': None,
                'dest_file': None, 'dest_rank': None, 'notation_type': 'empty'}

    clean = raw.rstrip('+#')
    is_capture = 'x' in clean

    # Zero/O castling
    if clean.startswith('0') or clean.startswith('O'):
        return {'piece': 'K', 'is_capture': False, 'source_file': 'e', 'source_rank': None,
                'dest_file': 'g' if len(clean) <= 3 else 'c', 'dest_rank': None, 'notation_type': 'castling'}

    # Extended notation with dash
    if '-' in clean:
        piece = None
        pos = 0
        if clean[0] in 'KQRBNP':
            piece = clean[0]
            pos = 1
        before_dash = clean[pos:clean.index('-')]
        after_dash = clean[clean.index('-') + 1:]
        src_file = before_dash[0] if len(before_dash) >= 1 and before_dash[0] in 'abcdefgh' else None
        src_rank = before_dash[1] if len(before_dash) >= 2 and before_dash[1] in '12345678' else None
        dst_file = after_dash[0] if len(after_dash) >= 1 and after_dash[0] in 'abcdefgh' else None
        dst_rank = after_dash[1] if len(after_dash) >= 2 and after_dash[1] in '12345678' else None
        return {'piece': piece or 'P', 'is_capture': is_capture, 'source_file': src_file,
                'source_rank': src_rank, 'dest_file': dst_file, 'dest_rank': dst_rank,
                'notation_type': 'extended'}

    # P prefix
    if clean.startswith('P'):
        sub = extract_partial_info(clean[1:])
        sub['piece'] = 'P'
        sub['notation_type'] = 'p_prefix'
        return sub

    # Piece-captures-piece
    if len(clean) == 3 and clean[1] == 'x' and clean[0] in 'KQRBNP' and clean[2] in 'KQRBNP':
        return {'piece': clean[0], 'is_capture': True, 'source_file': None, 'source_rank': None,
                'dest_file': None, 'dest_rank': None, 'notation_type': 'piece_captures_piece'}

    # File-captures-file
    if len(clean) in (2, 3) and clean[0] in 'abcdefgh':
        if (len(clean) == 2 and clean[1] in 'abcdefgh') or \
           (len(clean) == 3 and clean[1] == 'x' and clean[2] in 'abcdefgh'):
            dst = clean[-1]
            return {'piece': 'P', 'is_capture': True, 'source_file': clean[0], 'source_rank': None,
                    'dest_file': dst, 'dest_rank': None, 'notation_type': 'file_capture'}

    # Standard-ish: extract what we can
    piece = None
    pos = 0
    if clean and clean[0] in 'KQRBN':
        piece = clean[0]
        pos = 1

    # Try to find destination (last file+rank pair)
    dest_file = dest_rank = None
    for i in range(len(clean) - 1, 0, -1):
        if clean[i] in '12345678' and clean[i - 1] in 'abcdefgh':
            dest_file = clean[i - 1]
            dest_rank = clean[i]
            break

    return {'piece': piece or 'P', 'is_capture': is_capture, 'source_file': None,
            'source_rank': None, 'dest_file': dest_file, 'dest_rank': dest_rank,
            'notation_type': 'standard'}
