// =============================================================================
// ocr-worker.js - Lightweight OCR worker (ONNX + beam decode, NO Pyodide)
// =============================================================================
// Pool member for parallel per-cell OCR. Profiling established that runOCR is
// CPU-saturated on a single core (ORT runs single-threaded WASM because the
// github.io origin is not cross-origin isolated, so SharedArrayBuffer — and
// therefore multi-threaded WASM — is unavailable). A pool of these workers
// divides the per-cell ONNX cost across cores.
//
// This worker deliberately does NOT load Pyodide. It owns only the parts of
// the old monolithic zugwise-worker that touch ONNX / logits / beam decode:
//   - runOCR (per-cell inference + strict/lenient beam decode)
//   - constrainedReOCR / constrainedReOCRDual (CTC forced alignment)
//   - storedLogits (per-cell logit cache the constrained passes read back)
// These were lifted VERBATIM from zugwise-worker.js. All Pyodide-bound work
// (find-fixes, reconstruct, validate, check-absurdities) stays in
// zugwise-worker.js.
//
// LOGIT AFFINITY: constrained re-OCR reads storedLogits worker-side, so the
// pool must route the OCR for a given ply AND its later constrained re-OCR to
// the SAME worker. ocr-pool.js does this with ply-based affinity (ply % size).
// At pool size 1 this is moot; the invariant is baked in so growing the pool
// later does not strand logits.
// =============================================================================

importScripts('chess-grammar.js', 'lenient-grammar.js', 'beam-decoder.js');

// Kept identical to zugwise-worker.js so behavior matches exactly.
const OCR_VERBOSE_LOG = false;
const OCR_TIMING = true;
const OCR_OMIT_LOGITS_IN_RESPONSE = true;

let onnxSession = null;
let isReady = false;

// -----------------------------------------------------------------------------
// INITIALIZATION (ONNX only — no Pyodide)
// -----------------------------------------------------------------------------

async function initWorker() {
    try {
        postMessage({ type: 'status', message: 'Loading ONNX model (OCR worker)...' });

        importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/ort.min.js');
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/';

        const modelUrl = 'https://huggingface.co/GerhardTrippen/chess-ocr-bilstm/resolve/main/chess_ocr.onnx';
        onnxSession = await ort.InferenceSession.create(modelUrl);

        isReady = true;
        postMessage({ type: 'ready' });
    } catch (error) {
        postMessage({ type: 'error', message: `OCR worker init failed: ${error.message}` });
    }
}

// -----------------------------------------------------------------------------
// MESSAGE HANDLER
// -----------------------------------------------------------------------------

onmessage = async function(e) {
    const { id, type, data } = e.data;

    const _tMsgRecv = (OCR_TIMING && type === 'ocr') ? performance.now() : 0;

    if (!isReady && type !== 'init') {
        postMessage({ id, type: 'error', error: 'OCR worker not ready' });
        return;
    }

    try {
        let result;

        switch (type) {
            case 'init':
                await initWorker();
                return;

            case 'ocr':
                result = await runOCR(data.imageData, data.width, data.height, data.cellBelow || null, data.moveInfo || null);
                break;

            case 'constrained-reocr':
                result = constrainedReOCR(data.ply, data.legalMoves, data.ocrMoves);
                break;

            case 'constrained-reocr-dual':
                result = constrainedReOCRDual(data.ply, data.legalMoves);
                break;

            default:
                throw new Error(`Unknown message type for OCR worker: ${type}`);
        }

        if (OCR_TIMING && type === 'ocr' && result && result.timing) {
            result.timing.workerWall = performance.now() - _tMsgRecv;
        }

        postMessage({ id, type: 'result', result });

    } catch (error) {
        postMessage({ id, type: 'error', error: error.message });
    }
};

// =============================================================================
// OCR WITH BEAM DECODER  (lifted verbatim from zugwise-worker.js)
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

// =============================================================================
// CONSTRAINED RE-OCR  (lifted verbatim from zugwise-worker.js)
// =============================================================================

/**
 * Re-decode stored CTC logits constrained to a specific set of legal moves.
 * Uses CTC forced alignment to score each legal move against the raw logits.
 */
function constrainedReOCR(ply, legalMoves, ocrMoves) {
    if (!legalMoves || legalMoves.length === 0) {
        return { candidates: [], error: 'No legal moves provided' };
    }

    // Find the stored logits for this ply. Key format: "moveNum_color"
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
