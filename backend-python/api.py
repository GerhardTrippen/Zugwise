#!/usr/bin/env python3
"""
Zugwise Backend API
===================
Flask server that wraps the Score2PGN reconstruction engine.

Endpoints:
  GET  /api/health        - Health check
  POST /api/ocr           - Run OCR on uploaded image
  POST /api/ocr-context   - Get cropped OCR context image
  POST /api/extract-grid  - Extract grid from image (no OCR)
  POST /api/validate      - Validate a move list
  POST /api/find-fixes    - Get fix suggestions for stuck position
  POST /api/position      - Get position at specific ply
  POST /api/legal-moves   - Get legal moves for a position
  POST /api/similarity    - Score candidate moves against OCR text
  POST /api/reconstruct   - Run beam search reconstruction
  POST /api/quick-scan    - Quick 1-2-3 error beam search
"""

import os
import sys
import json
import base64
import tempfile
import traceback
from flask import Flask, request, jsonify
from flask_cors import CORS
import chess

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import reconstruction modules
try:
    from data_structures import OCRMove, ReconstructionResult
    from helpers import play_until_stuck, ply_to_str, try_move, count_changes, infer_move_squares, get_semantic_changes, has_semantic_changes
    from validation import validate_moves
    from full_game_search import reconstruct_game, reconstruct_game_beam
    from fix_finding import find_deep_backtrack_fixes, find_fixes_two_phase, generate_fix_explanation
    from missing_moves import find_missing_move_candidates
    from similarity import move_similarity
    from absurdity import would_capture_be_bad, is_piece_adequately_defended
    HAS_RECONSTRUCTION = True
    print("[OK] Reconstruction modules loaded")
except ImportError as e:
    print(f"[WARN] Reconstruction modules not available: {e}")
    HAS_RECONSTRUCTION = False

# Import OCR module
try:
    from bilstm_ocr import ChessOCR, extract_grid, extract_cells, process_scoresheet
    HAS_OCR = True
    print("[OK] OCR module loaded")
except ImportError as e:
    print(f"[WARN] OCR module not available: {e}")
    HAS_OCR = False

# Helper to extract confusion settings from auto_fix_settings
def parse_auto_fix_settings(auto_fix_settings):
    """Extract max_changes and confusion lists from auto_fix_settings.

    Returns: (max_changes, piece_confusions, piece_file_confusions)
    """
    max_changes = auto_fix_settings.get('max_changes', 2)

    # Convert arrays of [orig, replacement] to tuples
    piece_confusions_raw = auto_fix_settings.get('piece_confusions')
    piece_file_confusions_raw = auto_fix_settings.get('piece_file_confusions')

    # Convert to tuples if provided, otherwise None (use defaults)
    piece_confusions = None
    if piece_confusions_raw is not None:
        piece_confusions = [tuple(pair) for pair in piece_confusions_raw]

    piece_file_confusions = None
    if piece_file_confusions_raw is not None:
        piece_file_confusions = [tuple(pair) for pair in piece_file_confusions_raw]

    return max_changes, piece_confusions, piece_file_confusions


# Create Flask app
app = Flask(__name__)
CORS(app)

# Global OCR model (lazy loaded)
_ocr_model = None
_ocr_model_path = os.environ.get('OCR_MODEL_PATH', 'models/hcs-bilstm-zugwise.pth')

# Store last OCR grid image and cell info for context panel
_ocr_grid_image = None
_ocr_cells_info = []  # List of {num, color, bbox: (x, y, w, h)}

# Beam search progress tracking
import threading
import uuid
_beam_jobs = {}  # job_id -> {status, iteration, max_iterations, result, error}


def get_ocr_model():
    """Lazy-load the OCR model."""
    global _ocr_model
    if _ocr_model is None and HAS_OCR:
        if os.path.exists(_ocr_model_path):
            try:
                _ocr_model = ChessOCR(_ocr_model_path)
            except Exception as e:
                print(f"[WARN] Failed to load OCR model: {e}")
                _ocr_model = "failed"
        else:
            print(f"[WARN] OCR model not found: {_ocr_model_path}")
            _ocr_model = "not_found"
    return None if isinstance(_ocr_model, str) else _ocr_model


# =============================================================================
# CHESS UTILITIES
# =============================================================================

def get_position_at_ply(moves, ply, max_changes=2, piece_confusions=None, piece_file_confusions=None):
    """Get board position after applying moves up to ply."""
    board = chess.Board()
    applied = []
    last_move = None

    for i, san in enumerate(moves):
        if i >= ply:
            break
        try:
            if HAS_RECONSTRUCTION:
                move = try_move(board, san, max_changes=max_changes,
                               piece_confusions=piece_confusions,
                               piece_file_confusions=piece_file_confusions)
                if move is None:
                    break
            else:
                move = board.parse_san(san)
            board.push(move)
            applied.append(san)
            last_move = move
        except Exception:
            break
    
    result = {
        'fen': board.fen(),
        'ply': len(applied),
        'turn': 'white' if board.turn else 'black',
        'legal_moves': sorted([board.san(m) for m in board.legal_moves]),
        'is_check': board.is_check(),
        'is_checkmate': board.is_checkmate(),
        'is_stalemate': board.is_stalemate(),
    }
    if last_move:
        result['last_move'] = {
            'from': chess.square_name(last_move.from_square),
            'to': chess.square_name(last_move.to_square)
        }
    return result


# validate_moves is now imported from validation.py - SINGLE SOURCE OF TRUTH


def flatten_moves(moves):
    """Convert paired move format to flat list."""
    if not moves:
        return []
    if isinstance(moves[0], str):
        return moves
    flat = []
    for m in moves:
        w = m.get('white') or m.get('w', '')
        b = m.get('black') or m.get('b', '')
        if w:
            flat.append(w)
        if b:
            flat.append(b)
    return flat


def simple_similarity(a, b):
    """Simple character overlap similarity (0-100)."""
    if a == b:
        return 100
    a = a.replace('+', '').replace('#', '').upper()
    b = b.replace('+', '').replace('#', '').upper()
    if a == b:
        return 95
    common = sum(1 for c in a if c in b)
    total = max(len(a), len(b))
    return int((common / total) * 100) if total > 0 else 0


# =============================================================================
# API ENDPOINTS
# =============================================================================

@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({
        'status': 'ok',
        'has_ocr': HAS_OCR,
        'has_reconstruction': HAS_RECONSTRUCTION,
        'ocr_model_loaded': get_ocr_model() is not None,
        'ocr_model_path': _ocr_model_path,
    })


@app.route('/api/validate', methods=['POST'])
def api_validate():
    """Validate a list of moves."""
    try:
        data = request.json
        moves = flatten_moves(data.get('moves', []))
        ocr_data = data.get('ocr_data', [])
        settings = data.get('auto_fix_settings', {})
        # approved_plies: list of ply numbers where user approved the move despite EAD warning
        approved_plies = set(data.get('approved_plies', []))
        result = validate_moves(moves, ocr_data=ocr_data, settings=settings, approved_plies=approved_plies)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/position', methods=['POST'])
def api_position():
    """Get position at a specific ply."""
    try:
        data = request.json
        moves = flatten_moves(data.get('moves', []))
        ply = data.get('ply', len(moves))
        auto_fix_settings = data.get('auto_fix_settings', {})
        max_changes, piece_confusions, piece_file_confusions = parse_auto_fix_settings(auto_fix_settings)
        result = get_position_at_ply(moves, ply, max_changes=max_changes,
                                     piece_confusions=piece_confusions,
                                     piece_file_confusions=piece_file_confusions)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/legal-moves', methods=['POST'])
def api_legal_moves():
    """Get legal moves for a position."""
    try:
        data = request.json
        if 'fen' in data:
            board = chess.Board(data['fen'])
        else:
            moves = flatten_moves(data.get('moves', []))
            ply = data.get('ply', len(moves))
            auto_fix_settings = data.get('auto_fix_settings', {})
            max_changes, piece_confusions, piece_file_confusions = parse_auto_fix_settings(auto_fix_settings)
            pos = get_position_at_ply(moves, ply, max_changes=max_changes,
                                      piece_confusions=piece_confusions,
                                      piece_file_confusions=piece_file_confusions)
            board = chess.Board(pos['fen'])
        legal = sorted([board.san(m) for m in board.legal_moves])
        return jsonify({'legal_moves': legal, 'count': len(legal)})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/similarity', methods=['POST'])
def api_similarity():
    """Score candidate moves against OCR text for similarity.

    Uses the proper similarity scoring from similarity.py with 50+ OCR confusion pairs.

    Request: { ocr: string, candidates: string[] }
    Response: { scores: [{ san: string, sim: number }, ...] }
    """
    try:
        data = request.json
        ocr = data.get('ocr', '')
        candidates = data.get('candidates', [])

        if not ocr or not candidates:
            return jsonify({'scores': []})

        scores = []
        for san in candidates:
            sim = move_similarity(ocr, san)
            scores.append({'san': san, 'sim': int(sim * 100)})

        # Sort by similarity descending
        scores.sort(key=lambda x: -x['sim'])

        return jsonify({'scores': scores})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/ocr', methods=['POST'])
def api_ocr():
    """Run OCR on an uploaded scoresheet image."""
    global _ocr_grid_image, _ocr_cells_info
    
    if not HAS_OCR:
        return jsonify({'error': 'OCR module not available'}), 501
    
    try:
        if 'image' not in request.files:
            return jsonify({'error': 'No image file provided'}), 400
        
        image_file = request.files['image']
        if image_file.filename == '':
            return jsonify({'error': 'Empty filename'}), 400
        
        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            image_file.save(tmp.name)
            tmp_path = tmp.name
        
        try:
            model = get_ocr_model()
            if model is None:
                return jsonify({'error': 'OCR model not loaded'}), 500

            # Debug output directory
            debug_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'ocr_debug')
            os.makedirs(debug_dir, exist_ok=True)

            # Use unified process_scoresheet for all OCR processing
            # NOTE: apply_auto_corrections=False - let validation phase handle corrections
            # OCR should return raw results, not "fix" based on potentially wrong board state
            ocr_results, grid, cells_info = process_scoresheet(
                tmp_path,
                ocr=model,
                debug_dir=debug_dir,
                apply_auto_corrections=False,
                return_context=True
            )

            # Store grid and cells info for context panel
            _ocr_grid_image = grid.copy() if grid is not None else None
            _ocr_cells_info = cells_info

            # Convert OCRResult objects to dicts for JSON response
            results = []
            for r in ocr_results:
                results.append({
                    'num': r.move_number,
                    'color': r.color,
                    'move': r.move,
                    'confidence': r.confidence,
                    'alternatives': [{'move': m, 'confidence': c} for m, c in r.alternatives],
                })

            response = {'moves': results, 'total_cells': len(results), 'has_grid_image': _ocr_grid_image is not None}
            response['debug_dir'] = debug_dir
            return jsonify(response)
        finally:
            os.unlink(tmp_path)
    
    except Exception as e:
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 400


@app.route('/api/ocr-context', methods=['POST'])
def api_ocr_context():
    """Get cropped OCR image for context panel (3 rows centered on move).

    Handles column boundary edge cases (e.g., move 20 vs 21) by reducing
    the context window to avoid spanning columns.
    """
    global _ocr_grid_image, _ocr_cells_info

    if _ocr_grid_image is None:
        return jsonify({'error': 'No OCR image available'}), 404

    try:
        import cv2
        import base64

        data = request.json
        move_num = data.get('move_num', 1)
        highlight_color = data.get('color', 'w')  # Which cell to highlight

        # Detect column boundary from actual cell data
        # Standard scoresheets have 20 moves per column, but some have 25 or 30
        max_move = max((c['num'] for c in _ocr_cells_info), default=40)
        column_size = 20  # Default assumption
        if max_move > 20:
            # Try to detect column boundary from cell positions
            # Left column cells should have similar x positions, right column different
            left_cells = [c for c in _ocr_cells_info if c['num'] <= 20]
            right_cells = [c for c in _ocr_cells_info if c['num'] > 20]
            if left_cells and right_cells:
                left_x = sum(c['bbox'][0] for c in left_cells) / len(left_cells)
                right_x = sum(c['bbox'][0] for c in right_cells) / len(right_cells)
                # If right column is significantly to the right, column boundary is at 20
                if right_x > left_x + 50:
                    column_size = 20
                else:
                    # Single column or different layout
                    column_size = max_move

        # Find rows to include (3 rows centered on move_num)
        start_row = max(1, move_num - 1)
        end_row = start_row + 2

        # Check if range spans column boundary
        is_left = move_num <= column_size
        spans_columns = (start_row <= column_size < end_row)

        if spans_columns:
            # Reduce to 2 rows to avoid spanning columns
            if is_left:
                # Show moves before boundary
                start_row = max(1, move_num - 1)
                end_row = min(column_size, move_num + 1)
            else:
                # Show moves after boundary
                start_row = max(column_size + 1, move_num - 1)
                end_row = min(max_move, move_num + 1)

        # Find bounding box that covers all cells in these rows
        relevant_cells = [c for c in _ocr_cells_info if start_row <= c['num'] <= end_row]
        
        if not relevant_cells:
            return jsonify({'error': 'No cells found for this range'}), 404
        
        # Calculate combined bounding box
        min_x = min(c['bbox'][0] for c in relevant_cells)
        min_y = min(c['bbox'][1] for c in relevant_cells)
        max_x = max(c['bbox'][0] + c['bbox'][2] for c in relevant_cells)
        max_y = max(c['bbox'][1] + c['bbox'][3] for c in relevant_cells)
        
        # Add padding
        padding = 10
        h, w = _ocr_grid_image.shape[:2]
        min_x = max(0, min_x - padding)
        min_y = max(0, min_y - padding)
        max_x = min(w, max_x + padding)
        max_y = min(h, max_y + padding)
        
        # Crop the region
        cropped = _ocr_grid_image[min_y:max_y, min_x:max_x].copy()
        
        # Draw highlight rectangle around the current cell
        highlight_cell = next((c for c in relevant_cells 
                               if c['num'] == move_num and c['color'] == highlight_color), None)
        if highlight_cell:
            hx = highlight_cell['bbox'][0] - min_x
            hy = highlight_cell['bbox'][1] - min_y
            hw = highlight_cell['bbox'][2]
            hh = highlight_cell['bbox'][3]
            # Yellow highlight rectangle
            cv2.rectangle(cropped, (hx, hy), (hx + hw, hy + hh), (0, 255, 255), 3)
        
        # Encode as JPEG base64
        _, buffer = cv2.imencode('.jpg', cropped, [cv2.IMWRITE_JPEG_QUALITY, 85])
        img_base64 = base64.b64encode(buffer).decode('utf-8')
        
        return jsonify({
            'image': img_base64,
            'start_row': start_row,
            'end_row': end_row,
            'width': max_x - min_x,
            'height': max_y - min_y
        })
    
    except Exception as e:
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 400


@app.route('/api/extract-grid', methods=['POST'])
def api_extract_grid():
    """Extract grid from image for visualization only (no OCR).

    Used when user pastes OCR text manually but wants to attach
    the original image for context visualization.
    """
    global _ocr_grid_image, _ocr_cells_info

    if not HAS_OCR:
        return jsonify({'error': 'OCR module not available', 'has_grid_image': False}), 501

    try:
        if 'image' not in request.files:
            return jsonify({'error': 'No image file provided', 'has_grid_image': False}), 400

        image_file = request.files['image']
        if image_file.filename == '':
            return jsonify({'error': 'Empty filename', 'has_grid_image': False}), 400

        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            image_file.save(tmp.name)
            tmp_path = tmp.name

        try:
            import cv2
            image = cv2.imread(tmp_path)
            if image is None:
                return jsonify({'error': 'Could not read image', 'has_grid_image': False}), 400

            # Extract grid (but don't run OCR)
            grid = extract_grid(image)
            if grid is None:
                return jsonify({'error': 'Could not extract grid', 'has_grid_image': False}), 400

            # Store grid image for context panel
            _ocr_grid_image = grid.copy()

            # Extract cells for bounding box info (but don't OCR them)
            cells = extract_cells(grid)
            _ocr_cells_info = []
            for cell in cells:
                if cell.bbox:
                    _ocr_cells_info.append({
                        'num': cell.move_number,
                        'color': cell.color,
                        'bbox': cell.bbox
                    })

            return jsonify({
                'has_grid_image': True,
                'cells_found': len(_ocr_cells_info),
                'success': True
            })
        finally:
            os.unlink(tmp_path)

    except Exception as e:
        return jsonify({
            'error': str(e),
            'has_grid_image': False,
            'traceback': traceback.format_exc()
        }), 400


@app.route('/api/find-fixes', methods=['POST'])
def api_find_fixes():
    """Find fix suggestions for a stuck position."""
    try:
        data = request.json
        moves = flatten_moves(data.get('moves', []))
        stuck_ply = data.get('stuck_ply')
        min_ply = data.get('confirmed_ply', 0)  # Don't search before this ply
        ocr_data = data.get('ocr_data', [])  # Full OCR data with alternatives
        auto_fix_settings = data.get('auto_fix_settings', {})
        max_changes, piece_confusions, piece_file_confusions = parse_auto_fix_settings(auto_fix_settings)

        # NOTE: Beam/Greedy search is now USER-INITIATED via buttons (per CLAUDE.md pipeline)
        # /api/find-fixes only returns interactive fix suggestions

        # Find where stuck if not provided
        if stuck_ply is None:
            validation = validate_moves(moves, max_changes=max_changes,
                                        piece_confusions=piece_confusions,
                                        piece_file_confusions=piece_file_confusions)
            stuck_ply = validation['stuck_at']
            if stuck_ply is None:
                return jsonify({'error': 'No stuck position', 'fixes': [], 'missing_move_candidates': []})

        pos = get_position_at_ply(moves, stuck_ply, max_changes=max_changes,
                                  piece_confusions=piece_confusions,
                                  piece_file_confusions=piece_file_confusions)
        stuck_move = moves[stuck_ply] if stuck_ply < len(moves) else ''

        # Get from/to squares for the stuck (illegal) move
        stuck_board = chess.Board(pos['fen'])
        stuck_from, stuck_to = infer_move_squares(stuck_board, stuck_move, is_legal=False)

        # Generate fix suggestions
        formatted = []
        missing_candidates = []

        if HAS_RECONSTRUCTION:
            # Build OCR lookup - use full OCR data if available, otherwise single-candidate fallback
            ocr_lookup = {}

            if ocr_data and len(ocr_data) > 0:
                # Use full OCR data with alternatives
                for i, item in enumerate(ocr_data):
                    if isinstance(item, dict):
                        move = item.get('move', '')
                        conf = item.get('confidence', 0.9)
                        alts = item.get('alternatives', [])
                        # Build candidates list: top move + all alternatives
                        candidates = [(move, conf)]
                        for alt in alts:
                            if isinstance(alt, dict):
                                candidates.append((alt.get('move', ''), alt.get('confidence', 0.1)))
                            elif isinstance(alt, (list, tuple)) and len(alt) >= 2:
                                candidates.append((alt[0], alt[1]))
                            else:
                                candidates.append((str(alt), 0.1))
                        # Build lenient candidates if present
                        lenient_cands = []
                        for la in item.get('lenientAlternatives', []):
                            if isinstance(la, dict):
                                lenient_cands.append((la.get('move', ''), la.get('confidence', 0.1)))
                            elif isinstance(la, (list, tuple)) and len(la) >= 2:
                                lenient_cands.append((la[0], la[1]))
                        ocr_lookup[i] = OCRMove(
                            move_number=(i // 2) + 1,
                            color='w' if i % 2 == 0 else 'b',
                            candidates=candidates,
                            lenient_candidates=lenient_cands
                        )
                    else:
                        # Simple string - single candidate
                        ocr_lookup[i] = OCRMove(
                            move_number=(i // 2) + 1,
                            color='w' if i % 2 == 0 else 'b',
                            candidates=[(str(item), 0.9)]
                        )
            else:
                # Fallback: just moves without alternatives
                for i, san in enumerate(moves):
                    ocr_lookup[i] = OCRMove(
                        move_number=(i // 2) + 1,
                        color='w' if i % 2 == 0 else 'b',
                        candidates=[(san, 0.9)]
                    )
            
            # Find replacement fixes with min_ply constraint
            # Use find_fixes_two_phase for Phase 1/Phase 2 logic and Same Wall heuristic
            print(f"   [API v2.0.1] find-fixes: stuck_ply={stuck_ply}, min_ply={min_ply}, moves={len(moves)}, ocr_lookup={len(ocr_lookup)}")
            try:
                fixes = find_fixes_two_phase(moves, stuck_ply, ocr_lookup,
                                             verbose=True, min_ply=min_ply)
                print(f"   [API v2.0.1] find-fixes: got {len(fixes)} fixes")
            except Exception as fix_err:
                print(f"   API find-fixes ERROR: {fix_err}")
                import traceback
                traceback.print_exc()
                raise
            
            # Show ALL fix suggestions to user - NO filtering by max_changes
            # max_changes filtering is ONLY for forward play auto-correction
            print(f"   API: processing {len(fixes)} fixes (NO filtering - showing all to user)")
            for f in fixes[:30]:
                ocr_move = f['ocr']
                fix_san = f['san']
                num_changes = count_changes(ocr_move, fix_san)
                print(f"      FIX: '{ocr_move}' -> '{fix_san}' num_changes={num_changes}")

                # Get from/to squares for this fix (the suggested move)
                fix_ply = f['ply']
                fix_board = chess.Board()
                for i in range(fix_ply):
                    m = try_move(fix_board, moves[i], auto_correct=False)
                    if m:
                        fix_board.push(m)

                fix_from, fix_to = infer_move_squares(fix_board, fix_san, is_legal=True)

                # Get from/to squares for the OCR move being substituted (may be legal or not)
                ocr_is_legal = try_move(fix_board, ocr_move) is not None
                ocr_from, ocr_to = infer_move_squares(fix_board, ocr_move, is_legal=ocr_is_legal)

                # Generate explanation
                explanation = generate_fix_explanation(f, ocr_lookup)

                # Semi-auto correct with confirmation:
                # - 1 change: can be applied silently (needs_confirmation=False)
                # - 2+ changes: needs user confirmation (needs_confirmation=True)
                # This allows the frontend to auto-apply trivial fixes while
                # still showing multi-change fixes for manual review.
                needs_confirmation = num_changes >= 2

                formatted.append({
                    'ply': f['ply'],
                    'ply_str': ply_to_str(f['ply']),
                    'ocr': ocr_move,
                    'san': fix_san,
                    'from_square': fix_from,
                    'to_square': fix_to,
                    'ocr_from_square': ocr_from,
                    'ocr_to_square': ocr_to,
                    'similarity': round(f.get('char_sim', 0) * 100),
                    'reach': f.get('reach', 0),
                    'reach_improvement': f.get('reach_improvement', 0),
                    'completes': f.get('completes', False),
                    'score': round(f.get('unified_score', 0)),
                    'absurdity_count': f.get('absurdity_count', 0),
                    'is_hanging': f.get('is_hanging', False),
                    'hanging_value': f.get('hanging_value', 0),
                    'is_absurdity_fix': f.get('is_absurdity_fix', False),
                    'is_low_conf_fix': f.get('is_low_conf_fix', False),
                    'enables_future': f.get('enables_future', False),
                    'future_moves_enabled': f.get('future_moves_enabled', 0),
                    'ocr_conf': f.get('ocr_conf', 0),
                    'explanation': explanation,
                    'num_changes': num_changes,
                    'needs_confirmation': needs_confirmation,
                })

                # Stop after 20 valid fixes
                if len(formatted) >= 20:
                    break
            
            # Find missing move candidates
            missing_raw = find_missing_move_candidates(moves, stuck_ply, ocr_lookup)
            for mc in missing_raw[:5]:
                missing_candidates.append({
                    'type': mc['type'],
                    'insert_at_ply': mc['insert_at_ply'],
                    'insert_at_ply_str': ply_to_str(mc['insert_at_ply']),
                    'inserted_move': mc['inserted_move'],
                    'original_stuck_move': mc['original_stuck_move'],
                    'corrected_stuck_move': mc.get('corrected_stuck_move'),
                    'improvement': mc['improvement'],
                    'completes': mc['completes'],
                    'char_sim': round(mc.get('char_sim', 0) * 100),
                })
        else:
            # Simple fallback
            stuck_board = chess.Board(pos['fen'])
            ocr_is_legal = try_move(stuck_board, stuck_move) is not None if HAS_RECONSTRUCTION else False
            ocr_from, ocr_to = infer_move_squares(stuck_board, stuck_move, is_legal=ocr_is_legal)
            
            for san in pos['legal_moves'][:20]:
                sim = simple_similarity(stuck_move, san)
                fix_from, fix_to = infer_move_squares(stuck_board, san, is_legal=True)
                num_changes_simple = 1 if sim >= 80 else 2 if sim >= 60 else 3
                formatted.append({
                    'ply': stuck_ply,
                    'ply_str': f"{(stuck_ply // 2) + 1}.{'W' if stuck_ply % 2 == 0 else 'B'}",
                    'ocr': stuck_move,
                    'san': san,
                    'from_square': fix_from,
                    'to_square': fix_to,
                    'ocr_from_square': ocr_from,
                    'ocr_to_square': ocr_to,
                    'similarity': sim,
                    'reach_improvement': 0,
                    'completes': False,
                    'score': sim,
                    'absurdity_count': 0,
                    'is_hanging': False,
                    'hanging_value': 0,
                    'is_absurdity_fix': False,
                    'is_low_conf_fix': False,
                    'enables_future': False,
                    'future_moves_enabled': 0,
                    'ocr_conf': 0,
                    'explanation': 'Legal move that continues the game',
                    'num_changes': num_changes_simple,
                    'needs_confirmation': num_changes_simple >= 2,
                })
            formatted.sort(key=lambda x: -x['similarity'])
        
        return jsonify({
            'stuck_ply': stuck_ply,
            'stuck_ply_str': f"{(stuck_ply // 2) + 1}.{'W' if stuck_ply % 2 == 0 else 'B'}",
            'stuck_move': stuck_move,
            'stuck_from_square': stuck_from,
            'stuck_to_square': stuck_to,
            'fixes': formatted,
            'missing_move_candidates': missing_candidates,
            'legal_moves': pos['legal_moves'],
            'position_fen': pos['fen'],
        })
    except Exception as e:
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 400


@app.route('/api/quick-scan', methods=['POST'])
def api_quick_scan():
    """Quick beam search to fix 1-2-3 errors automatically."""
    if not HAS_RECONSTRUCTION:
        return jsonify({'error': 'Reconstruction not available'}), 501
    
    try:
        data = request.json
        ocr_data = data.get('ocr_moves', [])
        beam_width = data.get('beam_width', 5)
        
        # Build OCRMove list
        ocr_moves = []
        for item in ocr_data:
            if isinstance(item, dict):
                num = item.get('num', len(ocr_moves) // 2 + 1)
                color = item.get('color', 'w' if len(ocr_moves) % 2 == 0 else 'b')
                move = item.get('move', '')
                conf = item.get('confidence', 0.9)
                alts = item.get('alternatives', [])
                candidates = [(move, conf)]
                for alt in alts:
                    if isinstance(alt, dict):
                        candidates.append((alt.get('move', ''), alt.get('confidence', 0.1)))
                    else:
                        candidates.append((alt, 0.1))
                ocr_moves.append(OCRMove(move_number=num, color=color, candidates=candidates))
            else:
                ocr_moves.append(OCRMove(
                    move_number=len(ocr_moves) // 2 + 1,
                    color='w' if len(ocr_moves) % 2 == 0 else 'b',
                    candidates=[(item, 0.9)]
                ))
        
        # Run beam search
        result = reconstruct_game_beam(ocr_moves, beam_width=beam_width, verbose=False)
        
        return jsonify({
            'status': result.status,
            'moves': result.path,
            'fixes': result.fixes,
            'elapsed': result.elapsed,
            'complete': result.status == 'SOLVED',
        })
    except Exception as e:
        return jsonify({'error': str(e), 'traceback': traceback.format_exc()}), 400


@app.route('/api/reconstruct', methods=['POST'])
def api_reconstruct():
    """
    Run greedy or beam search reconstruction.

    Accepts either:
    - 'moves': List of SAN strings (new format)
    - 'ocr_moves': List of OCRMove-like dicts (legacy format)

    Parameters:
    - method: 'greedy' (default) or 'beam'
    - max_fixes: Maximum fixes to attempt (default 15)
    - beam_width: Beam width for beam search (default 5)
    """
    if not HAS_RECONSTRUCTION:
        return jsonify({'error': 'Reconstruction not available'}), 501

    try:
        from full_game_search import run_greedy_search, run_beam_search
        from helpers import create_ocr_lookup, moves_to_ocr_moves

        data = request.json
        method = data.get('method', 'greedy')
        max_fixes = data.get('max_fixes', 15)
        beam_width = data.get('beam_width', 5)

        # Get moves - support both new 'moves' format and legacy 'ocr_moves'
        moves = data.get('moves', [])
        ocr_data = data.get('ocr_data', data.get('ocr_moves', []))

        # If moves not provided, extract from ocr_data
        if not moves and ocr_data:
            for item in ocr_data:
                if isinstance(item, dict):
                    moves.append(item.get('move', ''))
                else:
                    moves.append(str(item))

        if not moves:
            return jsonify({'error': 'No moves provided'}), 400

        # Build OCR lookup from ocr_data
        ocr_lookup = None
        if ocr_data:
            ocr_moves = []
            for i, item in enumerate(ocr_data):
                if isinstance(item, dict):
                    move = item.get('move', '')
                    conf = item.get('confidence', 0.9)
                    alts = item.get('alternatives', [])
                    candidates = [(move, conf)]
                    for alt in alts:
                        if isinstance(alt, dict):
                            candidates.append((alt.get('move', ''), alt.get('confidence', 0.1)))
                        else:
                            candidates.append((str(alt), 0.1))
                    ocr_moves.append(OCRMove(
                        move_number=i // 2 + 1,
                        color='w' if i % 2 == 0 else 'b',
                        candidates=candidates
                    ))
                else:
                    ocr_moves.append(OCRMove(
                        move_number=i // 2 + 1,
                        color='w' if i % 2 == 0 else 'b',
                        candidates=[(str(item), 0.9)]
                    ))
            ocr_lookup = create_ocr_lookup(ocr_moves)

        # Run search
        if method == 'beam':
            result = run_beam_search(
                moves=moves,
                ocr_lookup=ocr_lookup,
                beam_width=beam_width,
                max_iterations=max_fixes * 2,
                max_fixes_per_path=max_fixes,
                verbose=False
            )
        else:
            result = run_greedy_search(
                moves=moves,
                ocr_lookup=ocr_lookup,
                max_fixes=max_fixes,
                verbose=False
            )

        return jsonify({
            'status': result.status,
            'moves': result.path,
            'fixes': result.fixes,
            'elapsed': result.elapsed,
            'method': result.method
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 400


def _parse_ocr_data(ocr_data):
    """Parse OCR data into OCRMove objects."""
    ocr_moves = []
    for item in ocr_data:
        if isinstance(item, dict):
            num = item.get('num', len(ocr_moves) // 2 + 1)
            color = item.get('color', 'w' if len(ocr_moves) % 2 == 0 else 'b')
            move = item.get('move', '')
            conf = item.get('confidence', 0.9)
            alts = item.get('alternatives', [])
            candidates = [(move, conf)]
            for alt in alts:
                if isinstance(alt, dict):
                    candidates.append((alt.get('move', ''), alt.get('confidence', 0.1)))
                else:
                    candidates.append((alt, 0.1))
            ocr_moves.append(OCRMove(move_number=num, color=color, candidates=candidates))
        else:
            ocr_moves.append(OCRMove(
                move_number=len(ocr_moves) // 2 + 1,
                color='w' if len(ocr_moves) % 2 == 0 else 'b',
                candidates=[(item, 0.9)]
            ))
    return ocr_moves


def _run_beam_job(job_id, moves, ocr_lookup, method, max_fixes, beam_width):
    """Background worker for beam/greedy search with cancel support."""
    global _beam_jobs
    from full_game_search import run_greedy_search, run_beam_search

    try:
        # Create cancel flag that checks job status
        cancel_flag = {"cancelled": False}

        def check_cancel():
            if job_id in _beam_jobs and _beam_jobs[job_id].get('cancel_requested'):
                cancel_flag["cancelled"] = True
            return cancel_flag["cancelled"]

        def progress_cb(progress):
            if job_id in _beam_jobs:
                _beam_jobs[job_id]['iteration'] = progress.iteration
                _beam_jobs[job_id]['max_iterations'] = progress.max_iterations
                # Check if cancel was requested
                if _beam_jobs[job_id].get('cancel_requested'):
                    cancel_flag["cancelled"] = True

        if method == 'beam':
            result = run_beam_search(
                moves=moves,
                ocr_lookup=ocr_lookup,
                beam_width=beam_width,
                max_iterations=max_fixes * 2,
                max_fixes_per_path=max_fixes,
                verbose=False,
                cancel_flag=cancel_flag,
                on_progress=progress_cb
            )
        else:
            result = run_greedy_search(
                moves=moves,
                ocr_lookup=ocr_lookup,
                max_fixes=max_fixes,
                verbose=False,
                cancel_flag=cancel_flag,
                on_progress=progress_cb
            )

        if cancel_flag["cancelled"]:
            _beam_jobs[job_id]['status'] = 'cancelled'
        else:
            _beam_jobs[job_id]['status'] = 'completed'
            _beam_jobs[job_id]['result'] = {
                'status': result.status,
                'moves': result.path,
                'fixes': result.fixes,
                'elapsed': result.elapsed,
                'method': result.method
            }
    except Exception as e:
        _beam_jobs[job_id]['status'] = 'error'
        _beam_jobs[job_id]['error'] = str(e)


@app.route('/api/reconstruct-async', methods=['POST'])
def api_reconstruct_async():
    """Start greedy/beam search in background, return job ID for polling."""
    if not HAS_RECONSTRUCTION:
        return jsonify({'error': 'Reconstruction not available'}), 501

    try:
        from helpers import create_ocr_lookup

        data = request.json
        method = data.get('method', 'beam')
        max_fixes = data.get('max_fixes', 15)
        beam_width = data.get('beam_width', 5)

        # Get moves - support both formats
        moves = data.get('moves', [])
        ocr_data = data.get('ocr_data', data.get('ocr_moves', []))

        # If moves not provided, extract from ocr_data
        if not moves and ocr_data:
            for item in ocr_data:
                if isinstance(item, dict):
                    moves.append(item.get('move', ''))
                else:
                    moves.append(str(item))

        if not moves:
            return jsonify({'error': 'No moves provided'}), 400

        # Build OCR lookup
        ocr_lookup = None
        if ocr_data:
            ocr_moves = _parse_ocr_data(ocr_data)
            ocr_lookup = create_ocr_lookup(ocr_moves)

        job_id = str(uuid.uuid4())[:8]
        _beam_jobs[job_id] = {
            'status': 'running',
            'iteration': 0,
            'max_iterations': max_fixes * 2,
            'beam_size': 1,
            'result': None,
            'error': None,
            'cancel_requested': False
        }

        thread = threading.Thread(
            target=_run_beam_job,
            args=(job_id, moves, ocr_lookup, method, max_fixes, beam_width)
        )
        thread.daemon = True
        thread.start()

        return jsonify({'job_id': job_id, 'status': 'running', 'method': method})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/reconstruct-cancel/<job_id>', methods=['POST'])
def api_reconstruct_cancel(job_id):
    """Request cancellation of a running search job."""
    if job_id not in _beam_jobs:
        return jsonify({'error': 'Job not found'}), 404

    _beam_jobs[job_id]['cancel_requested'] = True
    return jsonify({'status': 'cancel_requested', 'job_id': job_id})


@app.route('/api/reconstruct-status/<job_id>', methods=['GET'])
def api_reconstruct_status(job_id):
    """Get status of a beam search job."""
    if job_id not in _beam_jobs:
        return jsonify({'error': 'Job not found'}), 404

    job = _beam_jobs[job_id]
    response = {
        'status': job['status'],
        'iteration': job['iteration'],
        'max_iterations': job['max_iterations'],
        'beam_size': job['beam_size'],
    }

    if job['status'] == 'completed':
        response['result'] = job['result']
        # Clean up old job after retrieving result
        del _beam_jobs[job_id]
    elif job['status'] == 'error':
        response['error'] = job['error']
        del _beam_jobs[job_id]

    return jsonify(response)


# =============================================================================
# MULTI-SHEET UPLOAD ENDPOINTS
# =============================================================================

@app.route('/api/detect-grid', methods=['POST'])
def api_detect_grid():
    """
    Detect grid in image, return corners if found.
    Uses the same preprocessing as /api/ocr (deskew + perspective detection).
    """
    try:
        import cv2
        import numpy as np

        if 'image' not in request.files:
            return jsonify({'error': 'No image provided', 'grid_found': False}), 400

        file = request.files['image']
        image_bytes = file.read()
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({'error': 'Could not decode image', 'grid_found': False}), 400

        # Use the SAME preprocessing as the OCR pipeline
        from grid_detection import deskew_image, find_grid_contour, order_points

        # Step 1: Deskew (rotation correction)
        deskewed = deskew_image(image)

        # Step 2: Find grid contour
        contour = find_grid_contour(deskewed)

        if contour is not None:
            # Order points: top-left, top-right, bottom-right, bottom-left
            ordered = order_points(contour.astype(np.float32))

            corners = {
                'topLeft': {'x': float(ordered[0][0]), 'y': float(ordered[0][1])},
                'topRight': {'x': float(ordered[1][0]), 'y': float(ordered[1][1])},
                'bottomRight': {'x': float(ordered[2][0]), 'y': float(ordered[2][1])},
                'bottomLeft': {'x': float(ordered[3][0]), 'y': float(ordered[3][1])}
            }

            # TODO: Detect player color from header (WHITE/BLACK text)
            detected_color = None

            return jsonify({
                'grid_found': True,
                'corners': corners,
                'detected_color': detected_color,
                'image_size': {'width': deskewed.shape[1], 'height': deskewed.shape[0]}
            })
        else:
            return jsonify({
                'grid_found': False,
                'corners': None,
                'image_size': {'width': deskewed.shape[1], 'height': deskewed.shape[0]}
            })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e), 'grid_found': False}), 500


@app.route('/api/perspective-correct', methods=['POST'])
def api_perspective_correct():
    """
    Apply perspective correction using user-provided corners.
    Returns the corrected image as base64.
    """
    try:
        import cv2
        import numpy as np

        if 'image' not in request.files:
            return jsonify({'error': 'No image provided'}), 400

        corners_json = request.form.get('corners')
        if not corners_json:
            return jsonify({'error': 'No corners provided'}), 400

        corners = json.loads(corners_json)

        file = request.files['image']
        image_bytes = file.read()
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({'error': 'Could not decode image'}), 400

        # Convert corners dict to numpy array in correct order
        pts = np.array([
            [corners['topLeft']['x'], corners['topLeft']['y']],
            [corners['topRight']['x'], corners['topRight']['y']],
            [corners['bottomRight']['x'], corners['bottomRight']['y']],
            [corners['bottomLeft']['x'], corners['bottomLeft']['y']]
        ], dtype=np.float32)

        from grid_detection import four_point_transform
        corrected = four_point_transform(image, pts)

        # Encode back to base64
        _, buffer = cv2.imencode('.jpg', corrected, [cv2.IMWRITE_JPEG_QUALITY, 90])
        corrected_b64 = 'data:image/jpeg;base64,' + base64.b64encode(buffer).decode('utf-8')

        return jsonify({
            'success': True,
            'corrected_image': corrected_b64
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# =============================================================================
# MAIN
# =============================================================================

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Zugwise Backend API')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=5000)
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args()
    
    print(f"\n{'='*60}")
    print("ZUGWISE BACKEND API")
    print(f"{'='*60}")
    print(f"URL: http://{args.host}:{args.port}")
    print(f"OCR: {HAS_OCR} | Reconstruction: {HAS_RECONSTRUCTION}")
    print(f"Model: {_ocr_model_path}")
    print(f"{'='*60}\n")
    
    if HAS_OCR:
        get_ocr_model()  # Pre-load
    
    app.run(host=args.host, port=args.port, debug=args.debug)
