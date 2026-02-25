// =============================================================================
// chess-grammar.js - Chess notation grammar validator
// =============================================================================
// Validates partial and complete chess moves in Standard Algebraic Notation.
// Used by BeamDecoder to prune invalid hypotheses during CTC decoding.
// =============================================================================

class ChessGrammar {
    constructor() {
        this.PIECES = new Set(['K', 'Q', 'R', 'B', 'N']);
        this.FILES = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
        this.RANKS = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);
        this.PROMO_PIECES = new Set(['Q', 'R', 'B', 'N']);
        this.CHECK = new Set(['+', '#']);
        this.FILE_ORDER = 'abcdefgh';
        
        // Complete move patterns (same as Python bilstm_ocr.py)
        this.completePatterns = [
            /^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8][+#]?$/,      // SAN
            /^[KQRBN]?[a-h][1-8]x?[a-h][1-8][+#]?$/,        // LAN
            /^[a-h]?x?[a-h][18]=[QRBN][+#]?$/,              // Promotion with =
            /^[a-h]?x?[a-h][18][QRBN][+#]?$/,               // Promotion shorthand
            /^[a-h][27]x?[a-h][18]=?[QRBN][+#]?$/,          // LAN promotion
            /^O-O(-O)?[+#]?$/,                              // Castling
        ];
    }

    /**
     * Check if a complete move string is valid chess notation.
     * @param {string} move - The move string
     * @param {string|null} color - 'w' for white, 'b' for black, null if unknown
     * @returns {boolean}
     */
    isValidComplete(move, color = null) {
        if (!move) return false;
        if (!this.completePatterns.some(p => p.test(move))) return false;
        if (!this._checkGrammarRules(move)) return false;
        if (!this._checkPawnCaptureAdjacency(move)) return false;
        if (!this._checkPieceDisambiguation(move)) return false;
        if (this._isImpossiblePawnDestination(move, color)) return false;
        if (this._isPawnMissingPromotion(move)) return false;
        return true;
    }

    /**
     * Check if a partial move could become valid.
     * @param {string} partial - The partial move string being built
     * @param {string|null} color - 'w' for white, 'b' for black, null if unknown
     * @returns {boolean}
     */
    isValidPartial(partial, color = null) {
        if (!partial) return true;
        if (partial.length > 8) return false;
        
        const validChars = new Set([
            ...this.PIECES, ...this.FILES, ...this.RANKS, 
            'x', 'O', '-', '=', '+', '#'
        ]);
        for (const c of partial) {
            if (!validChars.has(c)) return false;
        }
        
        if (!this._checkGrammarRules(partial)) return false;
        if (!this._checkPawnCaptureAdjacency(partial)) return false;
        
        return true;
    }

    /**
     * Core grammar rules check.
     */
    _checkGrammarRules(s) {
        // Castling
        if (s.includes('O')) {
            const valid = ['O', 'O-', 'O-O', 'O-O-', 'O-O-O', 'O-O+', 'O-O#', 'O-O-O+', 'O-O-O#'];
            return valid.includes(s);
        }
        
        // Count elements
        let pieces = 0, files = 0, ranks = 0, captures = 0, checks = 0, equals = 0;
        for (const c of s) {
            if (this.PIECES.has(c)) pieces++;
            if (this.FILES.has(c)) files++;
            if (this.RANKS.has(c)) ranks++;
            if (c === 'x') captures++;
            if (this.CHECK.has(c)) checks++;
            if (c === '=') equals++;
        }
        
        // Basic limits
        if (pieces > 1) return false;
        if (captures > 1) return false;
        if (files > 4) return false;
        if (ranks > 4) return false;
        if (checks > 1) return false;
        if (equals > 1) return false;
        
        // Can't start with 'x'
        if (s && s[0] === 'x') return false;
        
        // Check/mate must be at end
        for (let i = 0; i < s.length - 1; i++) {
            if (this.CHECK.has(s[i])) return false;
        }
        
        // Promotion validation
        if (s.includes('=')) {
            const eq = s.indexOf('=');
            if (eq === 0) return false;
            if (eq < s.length - 1) {
                const after = s[eq + 1];
                if (!this.PROMO_PIECES.has(after) && !this.CHECK.has(after)) {
                    return false;
                }
            }
        }
        
        // Structure validation - rejects patterns like "bg3"
        if (!this._validateStructure(s)) return false;
        
        return true;
    }

    /**
     * Validate move structure - rejects invalid patterns like "bg3".
     * Builds a segment string (f=file, r=rank, x=capture, etc.) and checks
     * that the pattern is valid for chess notation.
     */
    _validateStructure(s) {
        if (!s) return true;
        
        let pos = 0;
        let leadingPiece = null;
        
        // Check for leading piece
        if (this.PIECES.has(s[0])) {
            leadingPiece = s[0];
            pos = 1;
        }
        
        // Build segment string: f=file, r=rank, x=capture, ==equals, P=promo piece, +=check
        const segs = [];
        while (pos < s.length) {
            const c = s[pos];
            if (this.FILES.has(c)) {
                segs.push('f');
            } else if (this.RANKS.has(c)) {
                segs.push('r');
            } else if (c === 'x') {
                segs.push('x');
            } else if (c === '=') {
                segs.push('=');
                pos++;
                if (pos < s.length) {
                    if (this.PROMO_PIECES.has(s[pos])) {
                        segs.push('P');
                        pos++;
                    } else if (this.CHECK.has(s[pos])) {
                        // Check after =, will be handled in next iteration
                    } else {
                        return false;
                    }
                }
                continue;
            } else if (this.CHECK.has(c)) {
                segs.push('+');
            } else if (this.PROMO_PIECES.has(c) && !leadingPiece) {
                segs.push('P');
            } else {
                return false;
            }
            pos++;
        }
        
        const segStr = segs.join('');
        
        // =====================================================================
        // PAWN MOVE VALIDATION - Key rule that rejects "bg3" etc.
        // =====================================================================
        if (!leadingPiece) {  // Pawn move (no piece prefix)
            // Can't start with capture
            if (segStr.startsWith('x')) return false;

            // Reject pawn LAN: "frfr" pattern (e.g., "e2e4", "g7e5")
            // Pawns in SAN never use full source+destination notation
            const segBase = segStr.replace(/\+/g, '');
            if (segBase === 'frfr') return false;

            // Check for "ff" pattern (file-file)
            // "ff" is only valid in LAN format where it's preceded by a rank
            // e.g., "e4xd5" -> "frxfr" is valid (LAN capture)
            // but "bg3" -> "ffr" is NOT valid (no rank before ff)
            const ffIndex = segStr.indexOf('ff');
            if (ffIndex !== -1) {
                if (ffIndex === 0 || segStr[ffIndex - 1] !== 'r') {
                    return false;
                }
            }
        }
        
        // Promotion piece must follow rank or '='
        for (let i = 0; i < segs.length; i++) {
            if (segs[i] === 'P') {
                if (i === 0) return false;
                if (segs[i - 1] !== 'r' && segs[i - 1] !== '=') return false;
            }
        }
        
        return true;
    }

    /**
     * Check that pawn captures are to adjacent files only.
     * e.g., exd4 is valid (e and d are adjacent), but exf4 is not.
     */
    _checkPawnCaptureAdjacency(move) {
        const s = move.replace(/[+#]/g, '');  // Remove check/mate symbols
        
        if (!s.includes('x')) return true;  // Not a capture
        if (s && this.PIECES.has(s[0])) return true;  // Piece capture, not pawn
        
        const xPos = s.indexOf('x');
        if (xPos === 0) return true;  // Malformed, let other checks handle
        
        const sourceChar = s[xPos - 1];
        if (!this.FILES.has(sourceChar)) return true;  // Source is not a file
        
        if (xPos + 1 >= s.length) return true;  // Nothing after x
        const destChar = s[xPos + 1];
        if (!this.FILES.has(destChar)) return true;  // Dest is not a file
        
        const sourceIdx = this.FILE_ORDER.indexOf(sourceChar);
        const destIdx = this.FILE_ORDER.indexOf(destChar);
        
        // Files must be adjacent (difference of 1)
        return Math.abs(sourceIdx - destIdx) === 1;
    }

    /**
     * Check piece disambiguation rules.
     * - King: never needs disambiguation (only one king)
     * - Bishop: rarely needs disambiguation (opposite colors)
     */
    _checkPieceDisambiguation(move) {
        const clean = move.replace(/[+#]/g, '');
        
        // King: never needs file/rank disambiguation
        if (clean.startsWith('K')) {
            const afterK = clean.slice(1).replace('x', '');
            if (afterK.length > 2) return false;  // Kae1 or K1e1 would be invalid
        }
        
        // Bishop: rarely needs disambiguation (only in rare promotions)
        if (clean.startsWith('B')) {
            const afterB = clean.slice(1).replace('x', '');
            if (afterB.length > 2) return false;  // Bae5 would be invalid
        }
        
        return true;
    }

    /**
     * Check for impossible pawn destinations based on color.
     * e.g., White pawns can't move TO rank 1 or 2.
     */
    _isImpossiblePawnDestination(move, color) {
        if (!move) return false;
        if (!this.FILES.has(move[0])) return false;  // Not a pawn move
        
        const clean = move.replace(/[+#]/g, '');
        let destRank = null;
        
        if (clean.includes('x')) {
            // Capture: destination rank is after the destination file
            const xPos = clean.indexOf('x');
            if (xPos + 2 < clean.length && this.RANKS.has(clean[xPos + 2])) {
                destRank = clean[xPos + 2];
            }
        } else {
            // Push: rank is second character
            if (clean.length >= 2 && this.RANKS.has(clean[1])) {
                destRank = clean[1];
            }
        }
        
        if (!destRank) return false;
        
        // White can't move TO rank 1 or 2
        if (color === 'w' && (destRank === '1' || destRank === '2')) return true;
        // Black can't move TO rank 7 or 8
        if (color === 'b' && (destRank === '7' || destRank === '8')) return true;
        
        return false;
    }

    /**
     * Check if a pawn move reaches rank 1 or 8 without a promotion piece.
     * In chess, promotion is mandatory when a pawn reaches the last rank.
     * e.g., "e8" is invalid, "e8=Q" and "e8Q" are valid.
     */
    _isPawnMissingPromotion(move) {
        if (!move || !this.FILES.has(move[0])) return false;  // Not a pawn move

        const clean = move.replace(/[+#]/g, '');

        // Find destination rank
        let destRank = null;
        if (clean.includes('x')) {
            const xPos = clean.indexOf('x');
            if (xPos + 2 < clean.length && this.RANKS.has(clean[xPos + 2])) {
                destRank = clean[xPos + 2];
            }
        } else {
            // Non-capture: find last rank digit (handles both "e8" and LAN "e7e8")
            for (let i = clean.length - 1; i >= 0; i--) {
                if (this.RANKS.has(clean[i])) {
                    destRank = clean[i];
                    break;
                }
            }
        }

        if (destRank !== '1' && destRank !== '8') return false;

        // Check for promotion with '='
        if (clean.includes('=')) return false;

        // Check for shorthand promotion: promo piece directly after destination rank
        const lastRankIdx = clean.lastIndexOf(destRank);
        if (lastRankIdx < clean.length - 1 && this.PROMO_PIECES.has(clean[lastRankIdx + 1])) {
            return false;
        }

        return true;  // Pawn reaches rank 1/8 without promotion
    }
}

// Export for use in other modules (works in both browser and Node.js)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ChessGrammar };
}
