// =============================================================================
// zugwise-worker.js - Web Worker running Pyodide + ONNX inference
// =============================================================================
// This is the main worker file. It imports:
//   - chess-grammar.js (ChessGrammar class)
//   - beam-decoder.js (BeamDecoder class, CHARSET, CHAR_TO_IDX)
// =============================================================================

// Import grammar, decoder, and shared Python loader modules
importScripts('chess-grammar.js', 'lenient-grammar.js', 'beam-decoder.js', 'python-loader.js');

// Per-cell OCR verbosity. The DEBUG / ONNX-dims / CANDIDATES / LENIENT-RAW
// lines fire once per cell — ~80 per scoresheet half, ~320 per game in
// dual-sheet mode — and flood the console past the point of usefulness once
// the OCR pipeline is stable. Flip to true to re-enable when actively
// debugging the ML side. Independent variable so flipping it doesn't
// also re-enable noisier non-ML debug paths.
const OCR_VERBOSE_LOG = false;

// Per-cell OCR timing. When true, runOCR returns a `timing` object with
// onnx/softmax/decodeStrict/decodeLenient/total in ms. Aggregated by
// worker-api.js into a per-sheet summary. Cheap; safe to leave on.
const OCR_TIMING = true;

// EXPERIMENT: drop `logits` from the worker→main response. The raw CTC
// logits buffer (~seqLen × vocabSize × 4 bytes per cell) is structured-cloned
// on every cell, but nothing on the main thread reads it — constrained re-OCR
// looks up `storedLogits` worker-side via the sheet-specific key. Flip to
// false to confirm or restore.
const OCR_OMIT_LOGITS_IN_RESPONSE = true;

let pyodide = null;
let onnxSession = null;
let isReady = false;

// -----------------------------------------------------------------------------
// INITIALIZATION
// -----------------------------------------------------------------------------

async function initWorker(loadOnnx = true) {
    try {
        postMessage({ type: 'status', message: 'Loading Pyodide runtime...' });

        // Load Pyodide (v0.26.x API) with micropip pre-loaded
        importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
        pyodide = await loadPyodide({
            indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
            packages: ['micropip']
        });

        postMessage({ type: 'status', message: 'Installing python-chess...' });

        // Install python-chess via micropip
        await pyodide.runPythonAsync(`
import micropip
await micropip.install('chess')
        `);

        // Load ONNX only when this worker will actually serve OCR. With the OCR
        // pool enabled (the default), the pool workers own all ONNX work, so we
        // skip the redundant model download + session here. runOCR /
        // constrained-reocr stay defined but are never called in that mode.
        if (loadOnnx) {
            postMessage({ type: 'status', message: 'Loading ONNX model...' });

            // Load ONNX Runtime Web and model
            importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/ort.min.js');

            ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/';

            const modelUrl = 'https://huggingface.co/GerhardTrippen/chess-ocr-bilstm/resolve/main/chess_ocr.onnx';
            onnxSession = await ort.InferenceSession.create(modelUrl);
        }

        postMessage({ type: 'status', message: 'Loading Python modules...' });

        // Load Python reconstruction modules (shared loader from python-loader.js)
        await loadPythonModules(pyodide);

        isReady = true;
        postMessage({ type: 'ready' });

    } catch (error) {
        postMessage({ type: 'error', message: `Init failed: ${error.message}` });
    }
}

// loadPythonModules is now provided by python-loader.js (imported via importScripts)
// It accepts a pyodide instance and loads all reconstruction modules into its global scope.

// -----------------------------------------------------------------------------
// MESSAGE HANDLER
// -----------------------------------------------------------------------------

onmessage = async function(e) {
    const { id, type, data } = e.data;

    // Stamp arrival time for OCR messages so we can measure full worker-wall
    // (recv → just-before-postMessage) and isolate pure postMessage cost.
    const _tMsgRecv = (OCR_TIMING && type === 'ocr') ? performance.now() : 0;

    if (!isReady && type !== 'init') {
        postMessage({ id, type: 'error', error: 'Worker not ready' });
        return;
    }

    try {
        let result;

        switch (type) {
            case 'init':
                // Default to loading ONNX unless explicitly told not to, so any
                // caller that omits the flag still gets a fully capable worker.
                await initWorker(!data || data.loadOnnx !== false);
                return;

            case 'ocr':
                if (!onnxSession) {
                    throw new Error('OCR requested on the Pyodide worker but ONNX was not loaded (OCR pool is active — this path should not be used). Set USE_OCR_POOL=false to serve OCR here.');
                }
                result = await runOCR(data.imageData, data.width, data.height, data.cellBelow || null, data.moveInfo || null);
                break;

            case 'validate':
                result = await validateMoves(data.moves, data.ocrData, data.autoFixSettings, data.approvedPlies, data.startPly);
                break;

            case 'position':
                result = await getPosition(data.moves, data.ply);
                break;

            case 'legal-moves':
                result = await getLegalMoves(data.fen);
                break;

            case 'find-fixes':
                result = await findFixes(data.moves, data.stuckAt, data.ocrMoves, data.minPly, data.fixedPlies, data.phase2Depth, data.lockedPlies);
                break;

            case 'reconstruct':
                result = await reconstruct(data.ocrMoves, data.options);
                break;

            case 'similarity':
                result = await getSimilarity(data.text1, data.text2);
                break;

            case 'similarity-batch':
                result = await getSimilarityBatch(data.ocrText, data.candidates);
                break;

            // Streaming backtrack search
            case 'backtrack-create':
                result = await createBacktrackState(data.moves, data.stuckAt, data.ocrMoves, data.minPly, data.fixedPlies, data.phase2Depth, data.lockedPlies, data.stuckReason);
                break;

            case 'backtrack-step':
                result = await backtrackSearchStep(data.stateId);
                break;

            case 'backtrack-finalize':
                result = await backtrackFinalize(data.stateId);
                break;

            case 'backtrack-finalize-phase1':
                result = await backtrackFinalizePhase1(data.stateId);
                break;

            case 'backtrack-phase2-step':
                result = await backtrackPhase2Step(data.stateId);
                break;

            case 'backtrack-finalize-complete':
                result = await backtrackFinalizeComplete(data.stateId);
                break;

            case 'backtrack-dual-search':
                result = await backtrackDualSearch(data.stateId);
                break;

            case 'backtrack-dual-verify':
                result = await backtrackDualVerify(data.stateId);
                break;

            case 'backtrack-dual-merge':
                result = await backtrackDualMerge(data.stateId, data.primaryFixes);
                break;

            case 'check-absurdities':
                result = checkAbsurdities(data.moves, data.candidates);
                break;

            case 'constrained-reocr':
                result = constrainedReOCR(data.ply, data.legalMoves, data.ocrMoves);
                break;

            case 'constrained-reocr-dual':
                result = constrainedReOCRDual(data.ply, data.legalMoves);
                break;

            default:
                throw new Error(`Unknown message type: ${type}`);
        }

        if (OCR_TIMING && type === 'ocr' && result && result.timing) {
            // workerWall = from message recv to just-before-postMessage.
            // Subtracting result.timing.total gives un-instrumented worker-side
            // work (input prep + storedLogits + response construction).
            result.timing.workerWall = performance.now() - _tMsgRecv;
        }

        postMessage({ id, type: 'result', result });

    } catch (error) {
        postMessage({ id, type: 'error', error: error.message });
    }
};

// =============================================================================
// OCR WITH BEAM DECODER
// =============================================================================

// Storage for per-ply logits (populated during OCR, keyed by "moveNum_color")
const storedLogits = new Map();

const beamDecoder = new BeamDecoder(15, 5);  // beamWidth=15, topK=5

async function runOCR(imageData, width, height, cellBelow = null, moveInfo = null) {
    const moveLabel = `${moveInfo?.num || '?'}_${moveInfo?.color || '?'}`;

    // DEBUG: Log image statistics
    let sum = 0, min = 255, max = 0;
    for (let i = 0; i < imageData.length; i++) {
        sum += imageData[i];
        if (imageData[i] < min) min = imageData[i];
        if (imageData[i] > max) max = imageData[i];
    }

    const w = width;
    const leftQuadEnd = Math.floor(w / 4);
    const rightQuadStart = Math.floor(3 * w / 4);
    let leftSum = 0, centerSum = 0, rightSum = 0;
    let leftCount = 0, centerCount = 0, rightCount = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const val = imageData[y * width + x];
            if (x < leftQuadEnd) { leftSum += val; leftCount++; }
            else if (x >= rightQuadStart) { rightSum += val; rightCount++; }
            else { centerSum += val; centerCount++; }
        }
    }

    const leftMean = leftSum / leftCount;
    const centerMean = centerSum / centerCount;
    const rightMean = rightSum / rightCount;

    if (OCR_VERBOSE_LOG) {
        console.log(`  DEBUG ${moveLabel}: shape=${height}x${width}, left=${leftMean.toFixed(0)}, center=${centerMean.toFixed(0)}, right=${rightMean.toFixed(0)}, min=${min}, max=${max}`);
    }

    // Normalize to [-1, 1]
    const floatData = new Float32Array(imageData.length);
    for (let i = 0; i < imageData.length; i++) {
        floatData[i] = (imageData[i] / 255.0 - 0.5) / 0.5;
    }

    // Create tensor [1, 1, 64, 256]
    const tensor = new ort.Tensor('float32', floatData, [1, 1, height, width]);

    const _tStart = OCR_TIMING ? performance.now() : 0;

    // Run inference
    const results = await onnxSession.run({ input: tensor });
    const output = results.output;

    const _tAfterOnnx = OCR_TIMING ? performance.now() : 0;

    if (OCR_VERBOSE_LOG) {
        console.log("ONNX output dims:", output.dims);
    }

    const dims = output.dims;
    const seqLen = dims[0];
    const vocabSize = dims[2];

    // Apply log_softmax to get log probabilities
    const logProbs = new Float32Array(seqLen * vocabSize);
    for (let t = 0; t < seqLen; t++) {
        let maxVal = -Infinity;
        for (let v = 0; v < vocabSize; v++) {
            const val = output.data[t * vocabSize + v];
            if (val > maxVal) maxVal = val;
        }
        
        let sumExp = 0;
        for (let v = 0; v < vocabSize; v++) {
            sumExp += Math.exp(output.data[t * vocabSize + v] - maxVal);
        }
        const logSumExp = maxVal + Math.log(sumExp);
        
        for (let v = 0; v < vocabSize; v++) {
            logProbs[t * vocabSize + v] = output.data[t * vocabSize + v] - logSumExp;
        }
    }
    
    // Get color from moveInfo for grammar-aware decoding
    const color = moveInfo?.color || null;
    
    // Store logits for potential constrained re-OCR later
    storedLogits.set(moveLabel, { data: logProbs, seqLen, vocabSize });
    // If sheet ID provided (dual-sheet mode), also store under sheet-specific key
    if (moveInfo?.sheet) {
        const sheetKey = `${moveLabel}_sheet${moveInfo.sheet}`;
        storedLogits.set(sheetKey, { data: logProbs, seqLen, vocabSize });
    }

    const _tAfterSoftmax = OCR_TIMING ? performance.now() : 0;

    // Beam decode with grammar constraints (strict)
    const candidates = beamDecoder.decode(logProbs, seqLen, vocabSize, color);

    const _tAfterStrict = OCR_TIMING ? performance.now() : 0;

    if (OCR_VERBOSE_LOG) {
        const candidatesStr = candidates.map(c => `('${c.move}', ${c.confidence.toFixed(4)})`).join(', ');
        console.log(`  CANDIDATES ${moveLabel}: [${candidatesStr}]`);
    }

    // Lenient decode (secondary pass - accepts non-standard notations)
    const strictMoves = new Set(candidates.map(c => c.move));
    let lenientAlternatives = [];
    try {
        const lenientRaw = beamDecoder.decodeLenient(logProbs, seqLen, vocabSize, color);
        if (OCR_VERBOSE_LOG && lenientRaw.length > 0) {
            const rawStr = lenientRaw.map(c => `${c.move}(${c.confidence.toFixed(3)})`).join(', ');
            const dupes = lenientRaw.filter(c => strictMoves.has(c.move)).map(c => c.move);
            console.log(`  LENIENT-RAW ${moveLabel}: [${rawStr}]${dupes.length ? ' (dupes of strict: ' + dupes.join(',') + ')' : ''}`);
        }
        // Filter to unique-only (not in strict results), apply confidence penalty
        lenientAlternatives = lenientRaw
            .filter(c => c.move && !strictMoves.has(c.move))
            .map(c => ({ move: c.move, confidence: c.confidence * 0.5, source: 'lenient' }));
        if (OCR_VERBOSE_LOG && lenientAlternatives.length > 0) {
            const lenientStr = lenientAlternatives.map(c => `('${c.move}', ${c.confidence.toFixed(4)})`).join(', ');
            console.log(`  LENIENT-UNIQUE ${moveLabel}: [${lenientStr}]`);
        }
    } catch (e) {
        console.warn(`  Lenient decode failed for ${moveLabel}: ${e.message}`);
    }

    const _tAfterLenient = OCR_TIMING ? performance.now() : 0;

    // Return in format expected by rest of system
    const topMove = candidates[0]?.move || '';
    const topConf = candidates[0]?.confidence || 0;
    const alternatives = candidates.slice(1).map(c => ({move: c.move, confidence: c.confidence}));

    const out = {
        move: topMove,
        confidence: topConf,
        alternatives: alternatives,
        lenientAlternatives: lenientAlternatives
    };
    if (!OCR_OMIT_LOGITS_IN_RESPONSE) {
        out.logits = { data: logProbs, seqLen, vocabSize };
    }

    if (OCR_TIMING) {
        out.timing = {
            onnx: _tAfterOnnx - _tStart,
            softmax: _tAfterSoftmax - _tAfterOnnx,
            decodeStrict: _tAfterStrict - _tAfterSoftmax,
            decodeLenient: _tAfterLenient - _tAfterStrict,
            total: _tAfterLenient - _tStart
        };
    }

    return out;
}

// -----------------------------------------------------------------------------
// CHESS LOGIC (Pyodide)
// -----------------------------------------------------------------------------

const OCR_ALT_MIN_CONFIDENCE = 0.05;

async function validateMoves(moves, ocrData, autoFixSettings, approvedPlies, startPly = 0) {
    // NO INLINE PYTHON - use the validate_moves function from validation.py
    const movesJson = JSON.stringify(moves);
    const ocrDataJson = JSON.stringify(ocrData || []);
    const settingsJson = JSON.stringify(autoFixSettings || {});
    const approvedPliesJson = JSON.stringify(approvedPlies || []);
    const safeStartPly = typeof startPly === 'number' ? startPly : 0;

    const result = await pyodide.runPythonAsync(`
import json

moves_list = json.loads('''${movesJson}''')
ocr_data = json.loads('''${ocrDataJson}''')
settings = json.loads('''${settingsJson}''')
approved_plies_list = json.loads('''${approvedPliesJson}''')
approved_plies = set(approved_plies_list)
start_ply = ${safeStartPly}

result = validate_moves(moves_list, ocr_data, settings, approved_plies, start_ply)
json.dumps(result)
    `);
    return JSON.parse(result);
}

async function getPosition(moves, ply) {
    const movesJson = JSON.stringify(moves);
    const safePly = typeof ply === 'number' ? ply : 0;
    const result = await pyodide.runPythonAsync(`
import json

moves = json.loads('''${movesJson}''')
ply = ${safePly}

board = get_position_at(moves, ply)
if board is None:
    board = chess.Board()

_result = json.dumps({
    'fen': board.fen(),
    'legal_moves': sorted([board.san(m) for m in board.legal_moves])
})
_result
    `);
    return JSON.parse(result);
}

async function getLegalMoves(fen) {
    const safeFen = String(fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const result = await pyodide.runPythonAsync(`
import chess
import json

board = chess.Board('${safeFen}')
_result = json.dumps({'legal_moves': sorted([board.san(m) for m in board.legal_moves])})
_result
    `);
    return JSON.parse(result);
}

async function findFixes(moves, stuckAt, ocrMoves, minPly, fixedPlies, phase2Depth, lockedPlies) {
    if (ocrMoves && ocrMoves.length > 0) {
        const sampleIdx = Math.min(48, ocrMoves.length - 1);
        const sample = ocrMoves[sampleIdx];
        console.log(`[JS DEBUG] ocrMoves[${sampleIdx}] BEFORE stringify:`, {
            move: sample?.move,
            confidence: sample?.confidence,
            alternatives: sample?.alternatives,
            altTypes: sample?.alternatives?.map(a => ({
                type: typeof a,
                isArray: Array.isArray(a),
                value: a
            }))
        });
    }

    const movesJson = JSON.stringify(moves);
    const ocrMovesJson = JSON.stringify(ocrMoves || []);
    const fixedPliesJson = JSON.stringify(fixedPlies || []);
    const lockedPliesJson = JSON.stringify(lockedPlies || []);
    const safeStuckAt = typeof stuckAt === 'number' ? stuckAt : 0;
    const safeMinPly = typeof minPly === 'number' ? minPly : 0;
    const safePhase2Depth = typeof phase2Depth === 'number' ? phase2Depth : 5;

    const result = await pyodide.runPythonAsync(`
import chess
import json

moves_list = json.loads('''${movesJson}''')
stuck_at = ${safeStuckAt}
min_ply = ${safeMinPly}
phase2_depth = ${safePhase2Depth}
fixed_plies_list = json.loads('''${fixedPliesJson}''')
fixed_plies = set(fixed_plies_list)
locked_plies_list = json.loads('''${lockedPliesJson}''')
locked_plies = set(locked_plies_list)
ocr_moves_raw = json.loads('''${ocrMovesJson}''')

def normalize_alternative(alt):
    if isinstance(alt, dict):
        return (str(alt.get('move', '')), float(alt.get('confidence', 0.1)))
    elif isinstance(alt, (list, tuple)):
        if len(alt) >= 2:
            m, c = alt[0], alt[1]
            if isinstance(m, (list, tuple)) and len(m) >= 2:
                m, c = m[0], m[1]
            if isinstance(m, str) and isinstance(c, (int, float)):
                return (m, float(c))
            elif isinstance(m, str):
                return (m, 0.1)
        elif len(alt) == 1:
            inner = alt[0]
            if isinstance(inner, (list, tuple)) and len(inner) >= 2:
                return (str(inner[0]), float(inner[1]))
    elif isinstance(alt, str):
        return (alt, 0.1)
    return None

def build_candidates(ocr_entry):
    candidates = []
    top_move = ocr_entry.get('move', '') if isinstance(ocr_entry, dict) else ''
    top_conf = ocr_entry.get('confidence', 0.9) if isinstance(ocr_entry, dict) else 0.9
    if top_move:
        candidates.append((str(top_move), float(top_conf)))
    alternatives = ocr_entry.get('alternatives', []) if isinstance(ocr_entry, dict) else []
    for alt in alternatives:
        normalized = normalize_alternative(alt)
        if normalized and normalized[0]:
            candidates.append(normalized)
    return candidates if candidates else [('', 0.0)]

def build_lenient_candidates(ocr_entry):
    lenient = []
    if not isinstance(ocr_entry, dict):
        return lenient
    lenient_alts = ocr_entry.get('lenientAlternatives', [])
    for alt in lenient_alts:
        normalized = normalize_alternative(alt)
        if normalized and normalized[0]:
            lenient.append(normalized)
    return lenient

ocr_lookup = {}
ocr_debug_info = []

if ocr_moves_raw and len(ocr_moves_raw) > 0:
    first_entry = ocr_moves_raw[0] if ocr_moves_raw else None
    has_num_color = isinstance(first_entry, dict) and 'num' in first_entry and 'color' in first_entry

    if has_num_color:
        for ocr in ocr_moves_raw:
            if isinstance(ocr, dict) and 'num' in ocr and 'color' in ocr:
                move_number = ocr.get('num', 1)
                color = ocr.get('color', 'w')
                ply = (move_number - 1) * 2 + (0 if color == 'w' else 1)
                ocr_lookup[ply] = OCRMove(
                    move_number=move_number,
                    color=color,
                    candidates=build_candidates(ocr),
                    lenient_candidates=build_lenient_candidates(ocr)
                )
        ocr_debug_info.append(f"Used num/color format, got {len(ocr_lookup)} entries")
    else:
        for i, ocr in enumerate(ocr_moves_raw):
            move_number = (i // 2) + 1
            color = 'w' if i % 2 == 0 else 'b'
            if isinstance(ocr, dict):
                ocr_lookup[i] = OCRMove(
                    move_number=move_number,
                    color=color,
                    candidates=build_candidates(ocr),
                    lenient_candidates=build_lenient_candidates(ocr)
                )
            elif isinstance(ocr, str):
                ocr_lookup[i] = OCRMove(
                    move_number=move_number,
                    color=color,
                    candidates=[(ocr, 0.9)]
                )
        ocr_debug_info.append(f"Used index format, got {len(ocr_lookup)} entries")

if len(ocr_lookup) < len(moves_list) // 2:
    ocr_debug_info.append(f"Fallback: ocr_lookup too small ({len(ocr_lookup)}), using moves_list")
    ocr_lookup = {}
    for i, san in enumerate(moves_list):
        ocr_lookup[i] = OCRMove(
            move_number=(i // 2) + 1,
            color='w' if i % 2 == 0 else 'b',
            candidates=[(san, 0.9)]
        )

_missing_funcs = []
for fn in ['find_fixes_two_phase', 'find_deep_backtrack_fixes', 'find_all_absurdities',
           'play_until_stuck', 'try_move', 'move_similarity', 'ply_to_str', 'OCRMove']:
    if fn not in dir():
        _missing_funcs.append(fn)

fixes_result = []
backtrack_error = None

print(f"DEBUG: stuck_at = {stuck_at}, min_ply = {min_ply}, phase2_depth = {phase2_depth}, fixed_plies = {fixed_plies}, locked_plies = {locked_plies}")

if _missing_funcs:
    backtrack_error = f"Missing functions: {_missing_funcs}"
    stuck_ply, board = play_until_stuck(moves_list)
    stuck_move = moves_list[stuck_at] if stuck_at < len(moves_list) else ''
    for m in board.legal_moves:
        san = board.san(m)
        sim = round(move_similarity(stuck_move, san) * 100)
        fixes_result.append({
            'san': san,
            'ocr': stuck_move,
            'similarity': sim,
            'ply': stuck_at,
            'ply_str': ply_to_str(stuck_at),
            'reach_improvement': 1,
            'completes': False,
            'fallback': True
        })
    fixes_result.sort(key=lambda x: -x.get('similarity', 0))
    fixes_result = fixes_result[:20]
else:
    try:
        fixes_result = find_fixes_two_phase(
            moves_list,
            stuck_at,
            ocr_lookup,
            verbose=True,
            fixed_plies=fixed_plies,
            locked_plies=locked_plies,
            min_ply=min_ply,
            phase2_depth=phase2_depth
        )

        # DUAL SEARCH: If there's a second >50% candidate at stuck_ply that is
        # also illegal, run a secondary fix search using it as the stuck move.
        # In dual-sheet mode, this means both sheets' top picks were illegal.
        # The secondary search may find fixes with better similarity to the
        # second candidate (e.g., "g7" is close to "Ng7" but not to "e5").
        # In single-sheet mode, at most one candidate exceeds 50%, so this
        # naturally never triggers.
        if stuck_at in ocr_lookup:
            _dual_ocr = ocr_lookup[stuck_at]
            if len(_dual_ocr.candidates) >= 2:
                _second_move, _second_conf = _dual_ocr.candidates[1]
                if _second_conf > 0.50 and _second_move:
                    # Check if second candidate is also illegal
                    _test_board = chess.Board()
                    _second_is_illegal = True
                    for _ti in range(stuck_at):
                        if _ti < len(moves_list):
                            _tm = try_move(_test_board, moves_list[_ti], auto_correct=False)
                            if _tm:
                                _test_board.push(_tm)
                            else:
                                break
                    try:
                        _test_board.parse_san(_second_move)
                        _second_is_illegal = False
                    except:
                        pass

                    if _second_is_illegal:
                        print(f"[DUAL SEARCH] Both top candidates illegal at {ply_to_str(stuck_at)}:")
                        print(f"   Primary: '{moves_list[stuck_at]}' ({_dual_ocr.candidates[0][1]:.0%})")
                        print(f"   Secondary: '{_second_move}' ({_second_conf:.0%})")
                        print(f"   Running secondary fix search...")

                        _moves_list_2 = list(moves_list)
                        _moves_list_2[stuck_at] = _second_move

                        _ocr_lookup_2 = dict(ocr_lookup)
                        _ocr_lookup_2[stuck_at] = OCRMove(
                            move_number=_dual_ocr.move_number,
                            color=_dual_ocr.color,
                            candidates=[(_second_move, _second_conf)] +
                                      [(m, c) for m, c in _dual_ocr.candidates if m != _second_move]
                        )

                        try:
                            _fixes_2 = find_fixes_two_phase(
                                _moves_list_2, stuck_at, _ocr_lookup_2,
                                verbose=True,
                                fixed_plies=fixed_plies,
                                locked_plies=locked_plies,
                                min_ply=min_ply,
                                phase2_depth=phase2_depth,
                                verify_top_n=8
                            )
                            print(f"[DUAL SEARCH] Secondary search found {len(_fixes_2)} fixes")

                            # Tag each fix with its source before merging so the
                            # downstream debug dump can show which search produced it.
                            for _pf in fixes_result:
                                _pf.setdefault('_source', 'primary')
                            for _sf in _fixes_2:
                                _sf.setdefault('_source', 'secondary')

                            # Score-based dedup: on (ply, san) collision, keep the
                            # version with the higher unified_score. The old
                            # primary-wins policy silently dropped secondary fixes
                            # even when they scored better (e.g. secondary's
                            # Rxd7->Rxc7 at sim=93% losing to primary's
                            # Rfc1->Rxc7 at sim=89% on the same SAN). Score wins now.
                            _primary_keys = set((f.get('ply', -1), f.get('san', '')) for f in fixes_result)
                            _best_by_key = {}
                            for _fix in fixes_result + _fixes_2:
                                _key = (_fix.get('ply', -1), _fix.get('san', ''))
                                _existing = _best_by_key.get(_key)
                                if _existing is None or _fix.get('unified_score', 0) > _existing.get('unified_score', 0):
                                    _best_by_key[_key] = _fix
                            _merged = list(_best_by_key.values())
                            _merged.sort(key=lambda x: -x.get('unified_score', 0))
                            fixes_result = _merged
                            print(f"[DUAL SEARCH] Merged: {len(fixes_result)} unique fixes "
                                  f"(primary_keys={len(_primary_keys)}, secondary_unique={len(fixes_result) - len(_primary_keys)})")
                            # Full dump of the merged list so the user can see what
                            # actually survived the sort and what got cut at [:20].
                            print(f"[DUAL SEARCH] === Final merged fixes (showing all {len(fixes_result)}, top 20 returned to UI) ===")
                            for _i, _f in enumerate(fixes_result):
                                _marker = '  ' if _i < 20 else 'X '  # X = cut by [:20]
                                _src = _f.get('_source', '?')
                                _p = _f.get('ply_str') or ply_to_str(_f.get('ply', -1))
                                _o = _f.get('ocr', '')
                                _s = _f.get('san', '')
                                _sc = _f.get('unified_score', 0)
                                _sim = _f.get('similarity', 0)
                                print(f"[DUAL] {_marker}[{_i+1:>2}] {_p:>5}  {_o:>8} -> {_s:<8}  score={_sc:>5}  sim={_sim:>3}%  src={_src}")
                        except Exception as _e2:
                            print(f"[DUAL SEARCH] Secondary search error: {_e2}")

    except Exception as e:
        import traceback
        backtrack_error = str(e) + '\\n' + traceback.format_exc()
        stuck_ply, board = play_until_stuck(moves_list)
        stuck_move = moves_list[stuck_at] if stuck_at < len(moves_list) else ''
        for m in board.legal_moves:
            san = board.san(m)
            sim = round(move_similarity(stuck_move, san) * 100)
            fixes_result.append({
                'san': san,
                'ocr': stuck_move,
                'similarity': sim,
                'ply': stuck_at,
                'ply_str': ply_to_str(stuck_at),
                'reach_improvement': 1,
                'completes': False,
                'fallback': True
            })
        fixes_result.sort(key=lambda x: -x.get('similarity', 0))
        fixes_result = fixes_result[:20]

missing_candidates = []
try:
    print(f"DEBUG: Starting missing move search at ply {stuck_at}...")
    missing_raw = find_missing_move_candidates(moves_list, stuck_at, ocr_lookup)
    print(f"DEBUG: Missing move search found {len(missing_raw)} candidates")
    for mc in missing_raw[:5]:
        missing_candidates.append({
            'type': mc['type'],
            'insert_at_ply': mc['insert_at_ply'],
            'insert_at_ply_str': ply_to_str(mc['insert_at_ply']),
            'inserted_move': mc['inserted_move'],
            'original_stuck_move': mc['original_stuck_move'],
            'corrected_stuck_move': mc.get('corrected_stuck_move'),
            'improvement': mc['improvement'],
            'reach_improvement': mc['improvement'],
            'completes': mc['completes'],
            'char_sim': round(mc.get('char_sim', 0) * 100),
        })
except Exception as e:
    import traceback
    print(f"Missing move search error: {e}\n{traceback.format_exc()}")

for fix in fixes_result:
    if 'ply_str' not in fix and 'ply' in fix:
        fix['ply_str'] = ply_to_str(fix['ply'])
    if 'char_sim' in fix and 'similarity' not in fix:
        fix['similarity'] = round(fix['char_sim'] * 100)

    fix_ply = fix.get('ply', stuck_at)
    fix_san = fix.get('san', '')
    ocr_move = fix.get('ocr', '')

    fix_board = chess.Board()
    for i in range(fix_ply):
        if i < len(moves_list):
            m = try_move(fix_board, moves_list[i], auto_correct=False)
            if m:
                fix_board.push(m)
            else:
                break

    m = try_move(fix_board, fix_san, auto_correct=False)
    if m:
        fix['from_square'] = chess.square_name(m.from_square)
        fix['to_square'] = chess.square_name(m.to_square)
    else:
        fix['from_square'] = None
        fix['to_square'] = None

    ocr_m = try_move(fix_board, ocr_move, auto_correct=False)
    if ocr_m:
        fix['ocr_from_square'] = chess.square_name(ocr_m.from_square)
        fix['ocr_to_square'] = chess.square_name(ocr_m.to_square)
    else:
        fix['ocr_from_square'] = None
        fix['ocr_to_square'] = None

_, stuck_board = play_until_stuck(moves_list)
legal_moves = sorted([stuck_board.san(m) for m in stuck_board.legal_moves])

fix_plies = [f.get('ply', -1) for f in fixes_result[:20]]
unique_fix_plies = sorted(set(fix_plies))

from collections import Counter
all_fix_plies = [f.get('ply', -1) for f in fixes_result]
fixes_per_ply = dict(Counter(all_fix_plies))

_result = json.dumps({
    'fixes': fixes_result[:20],
    'missing_move_candidates': missing_candidates,
    'legal_moves': legal_moves,
    'backtrack_error': backtrack_error,
    'ocr_lookup_count': len(ocr_lookup),
    'ocr_debug_info': ocr_debug_info,
    'fix_plies': unique_fix_plies,
    'fixes_per_ply': fixes_per_ply,
    'total_fixes_found': len(fixes_result),
    'stuck_at': stuck_at,
    'moves_count': len(moves_list)
})
_result
    `);
    return JSON.parse(result);
}

async function reconstruct(ocrMoves, options) {
    const ocrDataJson = JSON.stringify(ocrMoves || []);
    const method = options?.method || 'greedy';
    const beamWidth = options?.beam_width || 5;
    const maxFixes = options?.max_fixes || 15;

    const result = await pyodide.runPythonAsync(`
import json

ocr_data = json.loads('''${ocrDataJson}''')
method = '${method}'
beam_width = ${beamWidth}
max_fixes = ${maxFixes}

ocr_moves_list = []
for i, entry in enumerate(ocr_data):
    move_str = entry.get('move', '')
    conf = entry.get('confidence', 0.9)
    alternatives = entry.get('alternatives', [])
    candidates = [(move_str, conf)] + list(alternatives)
    num = i // 2 + 1
    color = 'w' if i % 2 == 0 else 'b'
    ocr_move = OCRMove(num, color, candidates)
    ocr_moves_list.append(ocr_move)

try:
    result = reconstruct_game(
        ocr_moves=ocr_moves_list,
        method=method,
        verbose=False,
        beam_width=beam_width,
        max_fixes=max_fixes
    )
    output = {
        'status': result.status.name if hasattr(result.status, 'name') else str(result.status),
        'moves': result.moves,
        'fixes': [
            {
                'ply': fix.ply,
                'original': fix.ocr,
                'san': fix.san,
                'ocr': fix.ocr
            }
            for fix in result.fixes
        ],
        'elapsed': result.elapsed if hasattr(result, 'elapsed') else 0,
        'error': None
    }
except Exception as e:
    output = {
        'status': 'FAILED',
        'moves': [],
        'fixes': [],
        'error': str(e)
    }

_result = json.dumps(output)
_result
    `);
    return JSON.parse(result);
}

async function getSimilarity(text1, text2) {
    const safeText1 = String(text1 || '').replace(/'/g, "\\'");
    const safeText2 = String(text2 || '').replace(/'/g, "\\'");

    const result = await pyodide.runPythonAsync(`
import json

t1, t2 = '${safeText1}', '${safeText2}'
score = move_similarity(t1, t2)

_result = json.dumps({'similarity': score})
_result
    `);
    return JSON.parse(result);
}

// Batch version — score many candidates against one OCR text in a single
// Pyodide round-trip. Edit mode calls this once for all 30+ legal moves at
// the edit ply instead of 30+ individual getSimilarity calls (which were
// causing a multi-second 'Loading...' freeze).
async function getSimilarityBatch(ocrText, candidates) {
    const ocrJson = JSON.stringify(String(ocrText || ''));
    const candJson = JSON.stringify((candidates || []).map(String));

    const result = await pyodide.runPythonAsync(`
import json
_ocr = json.loads('${ocrJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
_cands = json.loads('${candJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
_scores = [move_similarity(_ocr, c) for c in _cands]
json.dumps({'similarities': _scores})
    `);
    return JSON.parse(result);
}

// =============================================================================
// ABSURDITY CHECK FOR QUICK FIXES
// =============================================================================

/**
 * Check a list of candidate moves for tactical absurdity using Python quiescence search.
 * @param {Array<string>} moves - Current move list (SAN strings)
 * @param {Array<{ply: number, san: string}>} candidates - Candidates to check
 * @returns {Array<{ply: number, san: string, is_absurd: boolean, reason: string|null}>}
 */
function checkAbsurdities(moves, candidates) {
    if (!candidates || candidates.length === 0) return [];

    const movesJson = JSON.stringify(moves);
    const candidatesJson = JSON.stringify(candidates);

    const result = pyodide.runPython(`
import json, chess

_moves = json.loads('${movesJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
_candidates = json.loads('${candidatesJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
_results = []

# Build board position once (all candidates are at the same ply)
_ply = _candidates[0]['ply'] if _candidates else 0
_board = chess.Board()
for _i in range(_ply):
    if _i < len(_moves):
        _m = try_move(_board, _moves[_i])
        if _m:
            _board.push(_m)
        else:
            break

for _cand in _candidates:
    _san = _cand['san']
    try:
        # Check 1: Does this move leave OUR piece hanging?
        # fast_mode=False so quiescence accounts for defender recapture
        # (a rook attacked by a knight but defended by king nets only +2
        # for opponent, not the full rook value).
        _test_moves = list(_moves[:_ply]) + [_san]
        _abs = detect_absurdity_at_ply(_test_moves, _ply, verbose=False, fast_mode=False)
        if _abs and _abs.severity >= 2:
            _results.append({'ply': _ply, 'san': _san, 'is_absurd': True, 'reason': _abs.details})
            continue

        # Check 2: Does this move ignore an obvious free capture?
        _missed = detect_missed_free_capture(_board, _san, min_value=5)
        if _missed:
            _val, _desc = _missed
            _results.append({'ply': _ply, 'san': _san, 'is_absurd': True, 'reason': _desc})
            continue

        _results.append({'ply': _ply, 'san': _san, 'is_absurd': False, 'reason': None})
    except Exception as _e:
        _results.append({'ply': _ply, 'san': _san, 'is_absurd': False, 'reason': None})

json.dumps(_results)
    `);
    return JSON.parse(result);
}

// =============================================================================
// CONSTRAINED RE-OCR
// =============================================================================

/**
 * Re-decode stored CTC logits constrained to a specific set of legal moves.
 * Uses CTC forced alignment to score each legal move against the raw logits.
 *
 * @param {number} ply - The ply to re-decode (0-indexed)
 * @param {Array<string>} legalMoves - Legal SAN moves at this position
 * @param {Array} ocrMoves - OCR data (to find the logits for this ply)
 * @returns {Object} - { candidates: [{move, confidence, source}], error: string|null }
 */
function constrainedReOCR(ply, legalMoves, ocrMoves) {
    if (!legalMoves || legalMoves.length === 0) {
        return { candidates: [], error: 'No legal moves provided' };
    }

    // Find the stored logits for this ply
    // Key format: "moveNum_color"
    const moveNum = Math.floor(ply / 2) + 1;
    const color = ply % 2 === 0 ? 'w' : 'b';
    const key = `${moveNum}_${color}`;

    const logitData = storedLogits.get(key);
    if (!logitData) {
        return { candidates: [], error: `No stored logits for ply ${ply} (key: ${key})` };
    }

    const { data: logProbs, seqLen, vocabSize } = logitData;

    // Run constrained decode (threshold 0.3 = 30%)
    const { filtered, top5, scoreMap } = beamDecoder.decodeConstrained(logProbs, seqLen, vocabSize, legalMoves, 0.3);

    // Always show top 5 candidates in debug console
    if (top5.length > 0) {
        const debugStr = top5.map(c => `${c.move}(${(c.confidence * 100).toFixed(1)}%)`).join(', ');
        console.log(`[CONSTRAINED] Ply ${ply} (${key}): top-5 = ${debugStr}`);
    } else {
        console.log(`[CONSTRAINED] Ply ${ply} (${key}): no alignment scores from ${legalMoves.length} legal moves`);
    }
    console.log(`[CONSTRAINED] Ply ${ply} (${key}): ${filtered.length}/${top5.length} passed ≥30% threshold`);

    return { candidates: filtered, top5: top5, scoreMap: scoreMap, error: null };
}

/**
 * Dual-sheet constrained re-OCR: look up logits from both sheets,
 * run decodeConstrained on each, merge results with 1.5x corroboration bonus.
 *
 * @param {number} ply - The ply to re-decode (0-indexed)
 * @param {Array<string>} legalMoves - Legal SAN moves at this position
 * @returns {Object} - { candidates, top5, scoreMap, error }
 */
function constrainedReOCRDual(ply, legalMoves) {
    if (!legalMoves || legalMoves.length === 0) {
        return { candidates: [], error: 'No legal moves provided' };
    }

    const moveNum = Math.floor(ply / 2) + 1;
    const color = ply % 2 === 0 ? 'w' : 'b';
    const baseKey = `${moveNum}_${color}`;
    const key1 = `${baseKey}_sheet1`;
    const key2 = `${baseKey}_sheet2`;

    const logits1 = storedLogits.get(key1);
    const logits2 = storedLogits.get(key2);

    // If neither sheet has logits, try the base key (backward compat)
    if (!logits1 && !logits2) {
        console.log(`[CONSTRAINED-DUAL] No sheet-specific logits for ply ${ply}, falling back to single`);
        return constrainedReOCR(ply, legalMoves, []);
    }

    // Decode each sheet independently
    let scoreMap1 = {}, scoreMap2 = {};
    let top5_1 = [], top5_2 = [];

    if (logits1) {
        const r1 = beamDecoder.decodeConstrained(logits1.data, logits1.seqLen, logits1.vocabSize, legalMoves, 0.0);
        scoreMap1 = r1.scoreMap || {};
        top5_1 = r1.top5 || [];
        console.log(`[CONSTRAINED-DUAL] Sheet 1 ply ${ply}: ${top5_1.length} scored`);
    }

    if (logits2) {
        const r2 = beamDecoder.decodeConstrained(logits2.data, logits2.seqLen, logits2.vocabSize, legalMoves, 0.0);
        scoreMap2 = r2.scoreMap || {};
        top5_2 = r2.top5 || [];
        console.log(`[CONSTRAINED-DUAL] Sheet 2 ply ${ply}: ${top5_2.length} scored`);
    }

    // Merge scores: average both, with 1.5x bonus for moves found in both sheets
    const mergedScoreMap = {};
    const allMoves = new Set([...Object.keys(scoreMap1), ...Object.keys(scoreMap2)]);

    for (const move of allMoves) {
        const s1 = scoreMap1[move] || 0;
        const s2 = scoreMap2[move] || 0;
        const inBoth = (s1 > 0 && s2 > 0);
        let combined;
        if (inBoth) {
            combined = ((s1 + s2) / 2) * 1.5; // corroboration bonus
        } else {
            combined = s1 + s2; // only one sheet has it
        }
        mergedScoreMap[move] = Math.min(combined, 1.0);
    }

    // Build sorted top-5 and filtered candidates
    const sorted = Object.entries(mergedScoreMap)
        .map(([move, confidence]) => ({ move, confidence, source: 'constrained_reocr_dual' }))
        .sort((a, b) => b.confidence - a.confidence);

    const top5 = sorted.slice(0, 5);
    const filtered = sorted.filter(c => c.confidence >= 0.3);

    if (top5.length > 0) {
        const debugStr = top5.map(c => `${c.move}(${(c.confidence * 100).toFixed(1)}%)`).join(', ');
        console.log(`[CONSTRAINED-DUAL] Ply ${ply} merged top-5: ${debugStr}`);
    }

    return { candidates: filtered, top5, scoreMap: mergedScoreMap, error: null };
}

// =============================================================================
// STREAMING BACKTRACK SEARCH
// =============================================================================

// Counter for unique state IDs
let backtrackStateCounter = 0;

async function createBacktrackState(moves, stuckAt, ocrMoves, minPly, fixedPlies, phase2Depth, lockedPlies, stuckReason) {
    const stateId = ++backtrackStateCounter;
    const movesJson = JSON.stringify(moves);
    const ocrMovesJson = JSON.stringify(ocrMoves || []);
    const fixedPliesJson = JSON.stringify(fixedPlies || []);
    const lockedPliesJson = JSON.stringify(lockedPlies || []);
    const safeStuckAt = typeof stuckAt === 'number' ? stuckAt : 0;
    const safeMinPly = typeof minPly === 'number' ? minPly : 0;
    const safePhase2Depth = typeof phase2Depth === 'number' ? phase2Depth : 5;
    const safeStuckReason = typeof stuckReason === 'string' ? stuckReason : '';

    const result = await pyodide.runPythonAsync(`
import json

# Parse inputs
_moves_list_${stateId} = json.loads('''${movesJson}''')
_stuck_reason_${stateId} = '''${safeStuckReason}''' or None
_stuck_at_${stateId} = ${safeStuckAt}
_min_ply_${stateId} = ${safeMinPly}
_phase2_depth_${stateId} = ${safePhase2Depth}
_fixed_plies_${stateId} = set(json.loads('''${fixedPliesJson}'''))
_locked_plies_${stateId} = set(json.loads('''${lockedPliesJson}'''))
_ocr_moves_raw_${stateId} = json.loads('''${ocrMovesJson}''')

# Build OCR lookup (reuse the normalize logic)
def _normalize_alternative(alt):
    if isinstance(alt, dict):
        return (str(alt.get('move', '')), float(alt.get('confidence', 0.1)))
    elif isinstance(alt, (list, tuple)):
        if len(alt) >= 2:
            m, c = alt[0], alt[1]
            if isinstance(m, (list, tuple)) and len(m) >= 2:
                m, c = m[0], m[1]
            if isinstance(m, str) and isinstance(c, (int, float)):
                return (m, float(c))
            elif isinstance(m, str):
                return (m, 0.1)
        elif len(alt) == 1:
            inner = alt[0]
            if isinstance(inner, (list, tuple)) and len(inner) >= 2:
                return (str(inner[0]), float(inner[1]))
    elif isinstance(alt, str):
        return (alt, 0.1)
    return None

def _build_candidates(ocr_entry):
    candidates = []
    top_move = ocr_entry.get('move', '') if isinstance(ocr_entry, dict) else ''
    top_conf = ocr_entry.get('confidence', 0.9) if isinstance(ocr_entry, dict) else 0.9
    if top_move:
        candidates.append((str(top_move), float(top_conf)))
    alternatives = ocr_entry.get('alternatives', []) if isinstance(ocr_entry, dict) else []
    for alt in alternatives:
        normalized = _normalize_alternative(alt)
        if normalized and normalized[0]:
            candidates.append(normalized)
    return candidates if candidates else [('', 0.0)]

def _build_lenient_candidates(ocr_entry):
    lenient = []
    if not isinstance(ocr_entry, dict):
        return lenient
    lenient_alts = ocr_entry.get('lenientAlternatives', [])
    for alt in lenient_alts:
        normalized = _normalize_alternative(alt)
        if normalized and normalized[0]:
            lenient.append(normalized)
    return lenient

_ocr_lookup_${stateId} = {}
if _ocr_moves_raw_${stateId} and len(_ocr_moves_raw_${stateId}) > 0:
    first_entry = _ocr_moves_raw_${stateId}[0]
    has_num_color = isinstance(first_entry, dict) and 'num' in first_entry and 'color' in first_entry

    if has_num_color:
        for ocr in _ocr_moves_raw_${stateId}:
            if isinstance(ocr, dict) and 'num' in ocr and 'color' in ocr:
                move_number = ocr.get('num', 1)
                color = ocr.get('color', 'w')
                ply = (move_number - 1) * 2 + (0 if color == 'w' else 1)
                _ocr_lookup_${stateId}[ply] = OCRMove(
                    move_number=move_number,
                    color=color,
                    candidates=_build_candidates(ocr),
                    lenient_candidates=_build_lenient_candidates(ocr)
                )
    else:
        for i, ocr in enumerate(_ocr_moves_raw_${stateId}):
            move_number = (i // 2) + 1
            color = 'w' if i % 2 == 0 else 'b'
            if isinstance(ocr, dict):
                _ocr_lookup_${stateId}[i] = OCRMove(
                    move_number=move_number,
                    color=color,
                    candidates=_build_candidates(ocr),
                    lenient_candidates=_build_lenient_candidates(ocr)
                )
            elif isinstance(ocr, str):
                _ocr_lookup_${stateId}[i] = OCRMove(
                    move_number=move_number,
                    color=color,
                    candidates=[(ocr, 0.9)]
                )

# Fallback if OCR lookup is too small
if len(_ocr_lookup_${stateId}) < len(_moves_list_${stateId}) // 2:
    _ocr_lookup_${stateId} = {}
    for i, san in enumerate(_moves_list_${stateId}):
        _ocr_lookup_${stateId}[i] = OCRMove(
            move_number=(i // 2) + 1,
            color='w' if i % 2 == 0 else 'b',
            candidates=[(san, 0.9)]
        )

# Create the BacktrackSearchState
_backtrack_state_${stateId} = BacktrackSearchState(
    moves=_moves_list_${stateId},
    stuck_ply=_stuck_at_${stateId},
    ocr_lookup=_ocr_lookup_${stateId},
    min_ply=_min_ply_${stateId},
    fixed_plies=_fixed_plies_${stateId},
    locked_plies=_locked_plies_${stateId},
    verbose=True,
    phase_label="PHASE 1",
    phase2_depth=_phase2_depth_${stateId},
    stuck_reason=_stuck_reason_${stateId}
)

# Return initial progress info
_progress = _backtrack_state_${stateId}.get_progress()
json.dumps({
    'stateId': ${stateId},
    'totalPlies': _progress['total_plies'],
    'remaining': _progress['remaining'],
    'searchOrder': [ply_to_str(p) for p in _backtrack_state_${stateId}.search_order[:5]]  # First 5 for debug
})
    `);
    return JSON.parse(result);
}

async function backtrackSearchStep(stateId) {
    const result = await pyodide.runPythonAsync(`
import json

_step_result = _backtrack_state_${stateId}.search_next_ply()
json.dumps(_step_result)
    `);
    return JSON.parse(result);
}

async function backtrackFinalizePhase1(stateId) {
    const result = await pyodide.runPythonAsync(`
import json

_phase2_info = _backtrack_state_${stateId}.finalize_phase1()
json.dumps(_phase2_info)
    `);
    return JSON.parse(result);
}

async function backtrackPhase2Step(stateId) {
    const result = await pyodide.runPythonAsync(`
import json

_step_result = _backtrack_state_${stateId}.phase2_state.search_next_ply()
json.dumps(_step_result)
    `);
    return JSON.parse(result);
}

async function backtrackFinalizeComplete(stateId) {
    const result = await pyodide.runPythonAsync(`
import json
import chess

# Complete finalization (merge Phase 2 if any, postprocess)
_final_fixes = _backtrack_state_${stateId}.finalize_complete()

# Check if dual search is needed: second >50% candidate that is also illegal
_dual_search_info = None
_dual_stuck = _stuck_at_${stateId}
if _dual_stuck in _ocr_lookup_${stateId}:
    _dual_ocr = _ocr_lookup_${stateId}[_dual_stuck]
    if len(_dual_ocr.candidates) >= 2:
        _second_move, _second_conf = _dual_ocr.candidates[1]
        if _second_conf > 0.50 and _second_move:
            _test_board = chess.Board()
            _second_is_illegal = True
            for _ti in range(_dual_stuck):
                if _ti < len(_moves_list_${stateId}):
                    _tm = try_move(_test_board, _moves_list_${stateId}[_ti], auto_correct=False)
                    if _tm:
                        _test_board.push(_tm)
                    else:
                        break
            try:
                _test_board.parse_san(_second_move)
                _second_is_illegal = False
            except:
                pass

            if _second_is_illegal:
                _dual_search_info = {
                    'needed': True,
                    'primary_move': _moves_list_${stateId}[_dual_stuck],
                    'primary_conf': _dual_ocr.candidates[0][1],
                    'secondary_move': _second_move,
                    'secondary_conf': _second_conf,
                    'stuck_ply_str': ply_to_str(_dual_stuck),
                }

# Add arrow data to each fix
for fix in _final_fixes:
    if 'ply_str' not in fix and 'ply' in fix:
        fix['ply_str'] = ply_to_str(fix['ply'])
    if 'char_sim' in fix and 'similarity' not in fix:
        fix['similarity'] = round(fix['char_sim'] * 100)

    fix_ply = fix.get('ply', 0)
    fix_san = fix.get('san', '')
    ocr_move = fix.get('ocr', '')

    # Build position at fix_ply
    fix_board = chess.Board()
    for i in range(fix_ply):
        if i < len(_moves_list_${stateId}):
            m = try_move(fix_board, _moves_list_${stateId}[i], auto_correct=False)
            if m:
                fix_board.push(m)
            else:
                break

    # Get arrow data for fix move
    m = try_move(fix_board, fix_san, auto_correct=False)
    if m:
        fix['from_square'] = chess.square_name(m.from_square)
        fix['to_square'] = chess.square_name(m.to_square)
    else:
        fix['from_square'] = None
        fix['to_square'] = None

    # Get arrow data for OCR move
    ocr_m = try_move(fix_board, ocr_move, auto_correct=False)
    if ocr_m:
        fix['ocr_from_square'] = chess.square_name(ocr_m.from_square)
        fix['ocr_to_square'] = chess.square_name(ocr_m.to_square)
    else:
        fix['ocr_from_square'] = None
        fix['ocr_to_square'] = None

# Get legal moves at stuck position
_, stuck_board = play_until_stuck(_moves_list_${stateId})
legal_moves = sorted([stuck_board.san(m) for m in stuck_board.legal_moves])

# Cleanup state variables (keep alive if dual search needed)
del _backtrack_state_${stateId}
if not _dual_search_info:
    del _moves_list_${stateId}
    del _ocr_lookup_${stateId}
    del _stuck_at_${stateId}
    del _min_ply_${stateId}
    del _fixed_plies_${stateId}
    del _locked_plies_${stateId}
    del _phase2_depth_${stateId}
del _ocr_moves_raw_${stateId}

json.dumps({
    'fixes': _final_fixes[:20],
    'legal_moves': legal_moves,
    'dual_search_info': _dual_search_info
})
    `);
    return JSON.parse(result);
}

// Dual search step 1: raw search only (Phase 1, no postprocessing/quiescence)
async function backtrackDualSearch(stateId) {
    const result = await pyodide.runPythonAsync(`
import json
import chess

_dual_stuck = _stuck_at_${stateId}
_dual_ocr = _ocr_lookup_${stateId}[_dual_stuck]
_second_move = _dual_ocr.candidates[1][0]
_second_conf = _dual_ocr.candidates[1][1]

print(f"[DUAL SEARCH] Both top candidates illegal at {ply_to_str(_dual_stuck)}:")
print(f"   Primary: '{_moves_list_${stateId}[_dual_stuck]}' ({_dual_ocr.candidates[0][1]:.0%})")
print(f"   Secondary: '{_second_move}' ({_second_conf:.0%})")

# Build modified move list and OCR lookup with secondary as primary
_dual_moves_list_${stateId} = list(_moves_list_${stateId})
_dual_moves_list_${stateId}[_dual_stuck] = _second_move

_dual_ocr_lookup_${stateId} = dict(_ocr_lookup_${stateId})
_dual_ocr_lookup_${stateId}[_dual_stuck] = OCRMove(
    move_number=_dual_ocr.move_number,
    color=_dual_ocr.color,
    candidates=[(_second_move, _second_conf)] +
              [(m, c) for m, c in _dual_ocr.candidates if m != _second_move]
)

_dual_raw_fixes_${stateId} = []
_dual_error = None
try:
    # Phase 1 only — skip Phase 2 (primary search already searched backward)
    _dual_raw_fixes_${stateId} = find_deep_backtrack_fixes(
        moves=_dual_moves_list_${stateId},
        stuck_ply=_dual_stuck,
        ocr_lookup=_dual_ocr_lookup_${stateId},
        verbose=True,
        fixed_plies=_fixed_plies_${stateId},
        locked_plies=_locked_plies_${stateId},
        min_ply=_min_ply_${stateId},
        phase_label="DUAL"
    )
    print(f"[DUAL SEARCH] Raw search found {len(_dual_raw_fixes_${stateId})} candidates")
except Exception as _e2:
    _dual_error = str(_e2)
    print(f"[DUAL SEARCH] Search error: {_e2}")
    import traceback
    traceback.print_exc()

json.dumps({
    'raw_count': len(_dual_raw_fixes_${stateId}),
    'error': _dual_error
})
    `);
    return JSON.parse(result);
}

// Dual search step 2: verify top candidates with full quiescence
async function backtrackDualVerify(stateId) {
    const result = await pyodide.runPythonAsync(`
import json

# Mark all dual fixes as not-before-frontier (they're at/near stuck ply)
for f in _dual_raw_fixes_${stateId}:
    f['before_frontier'] = False

# Run postprocessing (KEEP-AS-IS capping, quiescence verify top 8, mate checks)
_dual_verified_${stateId} = _postprocess_phase2_fixes(
    _dual_raw_fixes_${stateId},
    _dual_moves_list_${stateId},
    _stuck_at_${stateId},
    verbose=True,
    verify_top_n=8
)
print(f"[DUAL SEARCH] Verified: {len(_dual_verified_${stateId})} fixes after postprocessing")

# Clean up raw fixes
del _dual_raw_fixes_${stateId}
del _dual_moves_list_${stateId}
del _dual_ocr_lookup_${stateId}

json.dumps({
    'verified_count': len(_dual_verified_${stateId})
})
    `);
    return JSON.parse(result);
}

// Dual search step 3: merge verified secondary fixes into primary, add arrows, cleanup
async function backtrackDualMerge(stateId, primaryFixes) {
    const primaryJson = JSON.stringify(primaryFixes || []);
    const result = await pyodide.runPythonAsync(`
import json
import chess

_primary = json.loads('''${primaryJson}''')
_secondary = _dual_verified_${stateId} if '_dual_verified_${stateId}' in dir() else []

# Tag source on each fix for the debug dump.
for _pf in _primary:
    _pf.setdefault('_source', 'primary')
for _sf in _secondary:
    _sf.setdefault('_source', 'secondary')

# Score-based dedup: on (ply, san) collision, keep the version with the higher
# unified_score. The old primary-wins policy silently dropped secondary fixes
# that actually scored better (e.g. Rxd7->Rxc7 sim=93% was losing to
# Rfc1->Rxc7 sim=89% on the same SAN). Higher score wins now.
_best_by_key = {}
for _fix in _primary + _secondary:
    _key = (_fix.get('ply', -1), _fix.get('san', ''))
    _existing = _best_by_key.get(_key)
    if _existing is None or _fix.get('unified_score', 0) > _existing.get('unified_score', 0):
        _best_by_key[_key] = _fix
_merged = list(_best_by_key.values())
_merged.sort(key=lambda x: -x.get('unified_score', 0))
print(f"[DUAL SEARCH] Merged: {len(_merged)} unique fixes (primary={len(_primary)}, secondary={len(_secondary)})")

# Dump the OCRMove at stuck_ply so we can verify the worker's candidate
# ordering matches what merge-sheets.js should have produced. If primary
# ordering ever looks inverted (e.g. low-conf before high-conf), this log
# is the diagnostic.
_dbg_ocr = _ocr_lookup_${stateId}.get(_stuck_at_${stateId}) if '_ocr_lookup_${stateId}' in dir() else None
if _dbg_ocr is not None:
    print(f"[DUAL SEARCH] OCRMove at {ply_to_str(_stuck_at_${stateId})}: "
          f"{len(_dbg_ocr.candidates)} candidates in worker order:")
    for _ci, (_cm, _cc) in enumerate(_dbg_ocr.candidates):
        print(f"[DUAL]   cand[{_ci}] = '{_cm}' @ {_cc:.0%}")

# Full dump of the merged list. Marker X = cut by the [:20] slice returned
# to the UI. src tells you which search produced the fix.
print(f"[DUAL SEARCH] === Final merged fixes (showing all {len(_merged)}, top 20 returned to UI) ===")
for _i, _f in enumerate(_merged):
    _marker = '  ' if _i < 20 else 'X '
    _src = _f.get('_source', '?')
    _p = _f.get('ply_str') or ply_to_str(_f.get('ply', -1))
    _o = _f.get('ocr', '')
    _s = _f.get('san', '')
    _sc = _f.get('unified_score', 0)
    _sim = _f.get('similarity', 0)
    print(f"[DUAL] {_marker}[{_i+1:>2}] {_p:>5}  {_o:>8} -> {_s:<8}  score={_sc:>5}  sim={_sim:>3}%  src={_src}")

# Compute arrow data for any fix that doesn't already have it. Primary fixes
# come through with from_square/to_square set by the earlier finalize step;
# secondary fixes don't. With score-based dedup, a secondary fix can now
# occupy a slot whose (ply, san) also existed in primary — but the fix
# object itself is the secondary one without arrows. Gate on the actual
# presence of from_square in the fix dict, not on (ply, san) key membership.
for fix in _merged:
    if fix.get('from_square') is not None and fix.get('to_square') is not None:
        continue  # Already has arrow data

    if 'ply_str' not in fix and 'ply' in fix:
        fix['ply_str'] = ply_to_str(fix['ply'])
    if 'char_sim' in fix and 'similarity' not in fix:
        fix['similarity'] = round(fix['char_sim'] * 100)

    fix_ply = fix.get('ply', 0)
    fix_san = fix.get('san', '')
    ocr_move = fix.get('ocr', '')

    fix_board = chess.Board()
    for i in range(fix_ply):
        if i < len(_moves_list_${stateId}):
            m = try_move(fix_board, _moves_list_${stateId}[i], auto_correct=False)
            if m:
                fix_board.push(m)
            else:
                break

    m = try_move(fix_board, fix_san, auto_correct=False)
    if m:
        fix['from_square'] = chess.square_name(m.from_square)
        fix['to_square'] = chess.square_name(m.to_square)
    else:
        fix['from_square'] = None
        fix['to_square'] = None

    ocr_m = try_move(fix_board, ocr_move, auto_correct=False)
    if ocr_m:
        fix['ocr_from_square'] = chess.square_name(ocr_m.from_square)
        fix['ocr_to_square'] = chess.square_name(ocr_m.to_square)
    else:
        fix['ocr_from_square'] = None
        fix['ocr_to_square'] = None

# Cleanup state variables
if '_dual_verified_${stateId}' in dir():
    del _dual_verified_${stateId}
del _moves_list_${stateId}
del _ocr_lookup_${stateId}
del _stuck_at_${stateId}
del _min_ply_${stateId}
del _fixed_plies_${stateId}
del _locked_plies_${stateId}
del _phase2_depth_${stateId}

json.dumps({
    'fixes': _merged[:20],
    'total': len(_merged)
})
    `);
    return JSON.parse(result);
}

// Legacy: synchronous finalize (calls all three steps internally)
async function backtrackFinalize(stateId) {
    var phase2Info = await backtrackFinalizePhase1(stateId);
    if (phase2Info.need_phase_2) {
        var done = false;
        while (!done) {
            var step = await backtrackPhase2Step(stateId);
            done = step.done;
        }
    }
    return await backtrackFinalizeComplete(stateId);
}
