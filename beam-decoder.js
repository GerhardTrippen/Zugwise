// =============================================================================
// beam-decoder.js - CTC Beam Search Decoder with Chess Grammar Constraints
// =============================================================================
// Decodes CTC output from the BiLSTM OCR model into chess move candidates.
// Uses ChessGrammar to prune invalid hypotheses during search.
// =============================================================================

// Character set (must match training - same as Python CHARSET)
const CHARSET = ['', 'K', 'Q', 'R', 'B', 'N', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
                 '1', '2', '3', '4', '5', '6', '7', '8', 'x', '+', '#', '=', 'O', '-'];

// Build char-to-index map
const CHAR_TO_IDX = {};
CHARSET.forEach((c, i) => { CHAR_TO_IDX[c] = i; });

class BeamDecoder {
    constructor(beamWidth = 15, topK = 5) {
        this.beamWidth = beamWidth;
        this.topK = topK;
        this.blankIdx = 0;
        this.grammar = new ChessGrammar();
        // Lenient grammar for secondary decode pass (if available)
        this.lenientGrammar = (typeof LenientChessGrammar !== 'undefined') ? new LenientChessGrammar() : null;
    }

    /**
     * Decode CTC output using beam search with grammar constraints.
     * @param {Float32Array} ctcOutput - Log probabilities [seqLen * vocabSize]
     * @param {number} seqLen - Sequence length (time steps)
     * @param {number} vocabSize - Vocabulary size
     * @param {string|null} color - 'w' for white, 'b' for black, null if unknown
     * @param {ChessGrammar|null} grammar - Grammar to use (default: this.grammar)
     * @returns {Array<{move: string, confidence: number}>} - Candidates sorted by confidence
     */
    decode(ctcOutput, seqLen, vocabSize, color = null, grammar = null) {
        const g = grammar || this.grammar;
        let beam = [{ sequence: '', logProb: 0.0, lastCharIdx: this.blankIdx }];

        for (let t = 0; t < seqLen; t++) {
            const candidates = [];
            const frameOffset = t * vocabSize;

            for (const hyp of beam) {
                // Option 1: Emit blank (stay in same state)
                const blankLogProb = ctcOutput[frameOffset + this.blankIdx];
                candidates.push({
                    sequence: hyp.sequence,
                    logProb: hyp.logProb + blankLogProb,
                    lastCharIdx: this.blankIdx
                });

                // Option 2: Emit each character
                for (let idx = 1; idx < vocabSize; idx++) {
                    const char = CHARSET[idx];
                    if (!char) continue;

                    // CTC rule: don't repeat same char unless blank in between
                    const newSeq = (idx === hyp.lastCharIdx) ? hyp.sequence : hyp.sequence + char;

                    // Grammar pruning - reject invalid partial moves early
                    if (!g.isValidPartial(newSeq, color)) continue;

                    candidates.push({
                        sequence: newSeq,
                        logProb: hyp.logProb + ctcOutput[frameOffset + idx],
                        lastCharIdx: idx
                    });
                }
            }

            // Merge hypotheses with same (sequence, lastCharIdx)
            const merged = new Map();
            for (const c of candidates) {
                const key = c.sequence + '|' + c.lastCharIdx;
                if (!merged.has(key) || c.logProb > merged.get(key).logProb) {
                    merged.set(key, c);
                }
            }

            // Keep top beamWidth hypotheses
            beam = Array.from(merged.values())
                .sort((a, b) => b.logProb - a.logProb)
                .slice(0, this.beamWidth);
        }

        // Filter to complete, grammar-valid moves
        const final = new Map();
        for (const hyp of beam) {
            if (hyp.sequence && g.isValidComplete(hyp.sequence, color)) {
                if (!final.has(hyp.sequence) || hyp.logProb > final.get(hyp.sequence)) {
                    final.set(hyp.sequence, hyp.logProb);
                }
            }
        }

        // If no valid moves found, return best hypothesis as fallback
        // with low confidence to signal it's not grammar-validated
        if (final.size === 0) {
            const best = beam.length > 0 ? beam[0] : null;
            if (best && best.sequence) {
                console.log(`[BEAM] No grammar-valid complete move found, fallback to partial: "${best.sequence}"`);
                return [{ move: best.sequence, confidence: 0.1 }];
            }
            return [{ move: '', confidence: 0.0 }];
        }

        // Sort by log probability and take top K
        const sorted = Array.from(final.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, this.topK);

        // Convert log probs to normalized probabilities
        const logProbs = sorted.map(([_, lp]) => lp);
        const maxLogProb = Math.max(...logProbs);
        const probs = logProbs.map(lp => Math.exp(lp - maxLogProb));
        const sumProbs = probs.reduce((a, b) => a + b, 0);
        const normProbs = probs.map(p => p / sumProbs);

        return sorted.map(([move, _], i) => ({
            move: move,
            confidence: normProbs[i]
        }));
    }

    /**
     * Decode CTC output using lenient grammar (accepts non-standard notations).
     * Returns empty array if lenient grammar is not available.
     */
    decodeLenient(ctcOutput, seqLen, vocabSize, color = null) {
        if (!this.lenientGrammar) return [];
        return this.decode(ctcOutput, seqLen, vocabSize, color, this.lenientGrammar);
    }

    /**
     * Decode CTC output constrained to a specific set of legal moves.
     * Scores each legal move by its CTC probability using forced alignment.
     *
     * For each legal move string, computes the best CTC alignment score
     * (allowing blank frames between characters) and returns moves above
     * a minimum confidence threshold.
     *
     * @param {Float32Array} ctcOutput - Log probabilities [seqLen * vocabSize]
     * @param {number} seqLen - Sequence length (time steps)
     * @param {number} vocabSize - Vocabulary size
     * @param {Array<string>} legalMoves - List of legal SAN move strings
     * @param {number} minConfidence - Minimum confidence threshold (default 0.3)
     * @returns {Array<{move: string, confidence: number, source: string}>}
     */
    decodeConstrained(ctcOutput, seqLen, vocabSize, legalMoves, minConfidence = 0.3) {
        if (!legalMoves || legalMoves.length === 0) return { filtered: [], top5: [] };

        const scored = [];

        for (const san of legalMoves) {
            if (!san) continue;

            // Score this move using CTC forced alignment (Viterbi-style)
            // For a move string like "Nf3", find the best alignment of
            // characters N, f, 3 across the CTC time steps (with blanks between)
            const score = this._ctcForcedAlign(ctcOutput, seqLen, vocabSize, san);
            if (score !== null) {
                scored.push({ move: san, logProb: score });
            }
        }

        if (scored.length === 0) return { filtered: [], top5: [], scoreMap: {} };

        // Normalize ALL scored moves to probabilities
        scored.sort((a, b) => b.logProb - a.logProb);
        const maxLP = scored[0].logProb;
        const allProbs = scored.map(s => Math.exp(s.logProb - maxLP));
        const sumAll = allProbs.reduce((a, b) => a + b, 0);

        // Build score map: move → normalized probability (for cross-referencing)
        const scoreMap = {};
        scored.forEach((s, i) => { scoreMap[s.move] = allProbs[i] / sumAll; });

        // Top-5 for display
        const top5 = scored.slice(0, this.topK).map(s => ({
            move: s.move,
            confidence: scoreMap[s.move],
            source: 'constrained_reocr'
        }));

        const filtered = top5.filter(c => c.confidence >= minConfidence);

        return { filtered, top5, scoreMap };
    }

    /**
     * CTC forced alignment: compute the best alignment score for a given string.
     * Uses dynamic programming over (time, char_position) with blank transitions.
     *
     * @param {Float32Array} ctcOutput - Log probabilities [seqLen * vocabSize]
     * @param {number} seqLen - Time steps
     * @param {number} vocabSize - Vocab size
     * @param {string} target - Target string to align
     * @returns {number|null} - Log probability score, or null if alignment impossible
     */
    _ctcForcedAlign(ctcOutput, seqLen, vocabSize, target) {
        if (!target) return null;

        const charLen = target.length;
        // States: blank before each char + the char itself + trailing blank
        // Total states = 2 * charLen + 1
        // State 0: leading blank
        // State 2k-1: char k (1-indexed) -> target[k-1]
        // State 2k: blank after char k
        const numStates = 2 * charLen + 1;

        // Get char indices for the target string
        const charIndices = [];
        for (let i = 0; i < charLen; i++) {
            const idx = CHAR_TO_IDX[target[i]];
            if (idx === undefined) return null; // Unknown character
            charIndices.push(idx);
        }

        // DP table: dp[state] = best log prob reaching this state
        let dp = new Float64Array(numStates).fill(-Infinity);
        // Initialize: can start at leading blank or first character
        dp[0] = ctcOutput[0 * vocabSize + this.blankIdx]; // Start with blank
        dp[1] = ctcOutput[0 * vocabSize + charIndices[0]]; // Start with first char

        for (let t = 1; t < seqLen; t++) {
            const newDp = new Float64Array(numStates).fill(-Infinity);
            const frameOffset = t * vocabSize;

            for (let s = 0; s < numStates; s++) {
                if (dp[s] === -Infinity) continue;

                if (s % 2 === 0) {
                    // Blank state
                    const blankLP = ctcOutput[frameOffset + this.blankIdx];
                    // Stay in blank
                    newDp[s] = Math.max(newDp[s], dp[s] + blankLP);
                    // Transition to next char (if exists)
                    if (s + 1 < numStates) {
                        const charIdx = charIndices[Math.floor(s / 2)];
                        const charLP = ctcOutput[frameOffset + charIdx];
                        newDp[s + 1] = Math.max(newDp[s + 1], dp[s] + charLP);
                    }
                } else {
                    // Character state
                    const ci = Math.floor(s / 2); // 0-indexed char position
                    const charIdx = charIndices[ci];
                    const charLP = ctcOutput[frameOffset + charIdx];
                    const blankLP = ctcOutput[frameOffset + this.blankIdx];

                    // Repeat same char (CTC allows consecutive same-char frames)
                    newDp[s] = Math.max(newDp[s], dp[s] + charLP);
                    // Transition to blank after this char
                    if (s + 1 < numStates) {
                        newDp[s + 1] = Math.max(newDp[s + 1], dp[s] + blankLP);
                    }
                    // Transition to next char (skip blank, only if different char)
                    if (s + 2 < numStates) {
                        const nextCI = Math.floor((s + 2) / 2);
                        if (nextCI < charLen) {
                            const nextCharIdx = charIndices[nextCI];
                            // Only skip blank if chars are different
                            if (nextCharIdx !== charIdx) {
                                const nextCharLP = ctcOutput[frameOffset + nextCharIdx];
                                newDp[s + 2] = Math.max(newDp[s + 2], dp[s] + nextCharLP);
                            }
                        }
                    }
                }
            }

            dp = newDp;
        }

        // Result: best score at final char state or final blank state
        const lastCharState = numStates - 2; // Last character
        const lastBlankState = numStates - 1; // Trailing blank
        return Math.max(dp[lastCharState], dp[lastBlankState]);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { BeamDecoder, CHARSET, CHAR_TO_IDX };
}
