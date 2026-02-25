// =============================================================================
// lenient-grammar.js - Lenient Chess notation grammar validator
// =============================================================================
// Extends ChessGrammar to accept non-standard chess notations commonly found
// in handwritten scoresheets. Used as a secondary decode pass when strict
// grammar produces no legal candidates.
//
// Additional patterns accepted:
//   - P prefix: Pe4, Pd5, Pxe4, Pe8=Q
//   - File-captures-file: cd, cxd, ef, exf (adjacent files, no rank)
//   - Piece-captures-piece: BxN, RxR, QxB, PxP, NxB
//   - Piece-captures-piece-on-square: NxBc4, QxRa1
//   - Square-captures-square: c6xd4, e4xd5 (source_square x dest_square)
//   - Extended notation: Nf3-e5, Bc1-f4, e2-e4
//   - Zero castling: 0-0, 0-0-0
// =============================================================================

class LenientChessGrammar extends ChessGrammar {
    constructor() {
        super();

        // Additional complete-move patterns for lenient mode
        this.lenientCompletePatterns = [
            // P prefix: Pe4, Pd5, Pxe4, Pxd5, Pe8=Q, Pxe8=Q
            /^P[a-h]?x?[a-h][1-8](=[QRBN])?[+#]?$/,
            // File-captures-file shorthand: cd, cxd, ef, exf (no rank)
            /^[a-h]x?[a-h][+#]?$/,
            // Piece-captures-piece: BxN, RxR, QxB, PxP, NxB, KxQ etc.
            /^[KQRBNP]x[KQRBNP][+#]?$/,
            // Piece-captures-piece-on-square: NxBc4, QxRa1, BxNf6
            /^[KQRBN]x[KQRBNP][a-h][1-8][+#]?$/,
            // Square-captures-square: c6xd4, e4xd5 (piece on source captures dest)
            /^[a-h][1-8]x[a-h][1-8](=[QRBN])?[+#]?$/,
            // Extended/long notation with dash: Nf3-e5, Bc1-f4, e2-e4, Qd1-d3
            /^[KQRBN]?[a-h][1-8]-[a-h][1-8](=[QRBN])?[+#]?$/,
            // Zero castling: 0-0, 0-0-0
            /^0-0(-0)?[+#]?$/,
        ];
    }

    /**
     * Check if a complete move string is valid chess notation (lenient).
     * First tries strict, then lenient patterns.
     */
    isValidComplete(move, color = null) {
        // Try strict grammar first
        if (super.isValidComplete(move, color)) return true;

        // Try lenient patterns
        if (!move) return false;
        if (!this.lenientCompletePatterns.some(p => p.test(move))) return false;

        // Validate file-captures-file adjacency (cd, ef, etc.)
        if (this._isFileCapture(move) && !this._checkFileCaptureAdjacency(move)) return false;

        // Validate extended notation dash format
        if (move.includes('-') && !move.startsWith('O') && !move.startsWith('0')) {
            if (!this._checkExtendedNotation(move)) return false;
        }

        // Check color-specific impossible pawn destinations for P-prefix moves
        if (move.startsWith('P')) {
            const stripped = move.slice(1); // Remove P prefix
            if (this._isImpossiblePawnDestination(stripped, color)) return false;
        }

        return true;
    }

    /**
     * Check if a partial move could become valid (lenient).
     * Relaxes validation to allow lenient prefixes during beam search.
     */
    isValidPartial(partial, color = null) {
        // Try strict first
        if (super.isValidPartial(partial, color)) return true;

        if (!partial) return true;
        if (partial.length > 10) return false; // Lenient allows slightly longer (extended notation)

        // Allow '0' for zero-castling
        const validChars = new Set([
            ...this.PIECES, ...this.FILES, ...this.RANKS,
            'x', 'O', '-', '=', '+', '#', 'P', '0'
        ]);
        for (const c of partial) {
            if (!validChars.has(c)) return false;
        }

        // Zero-castling partials
        if (partial.includes('0')) {
            const valid = ['0', '0-', '0-0', '0-0-', '0-0-0', '0-0+', '0-0#', '0-0-0+', '0-0-0#'];
            return valid.includes(partial);
        }

        // P prefix: allow P followed by normal pawn structure
        if (partial.startsWith('P')) {
            // Check the rest as a pawn move
            const rest = partial.slice(1);
            if (!rest) return true; // Just "P" is valid partial
            // Validate the rest has valid chars for pawn moves
            for (const c of rest) {
                if (!this.FILES.has(c) && !this.RANKS.has(c) && c !== 'x' && c !== '=' && c !== '+' && c !== '#' &&
                    !this.PROMO_PIECES.has(c)) return false;
            }
            return true;
        }

        // Piece-captures-piece partials: Bx, BxN, etc.
        if (partial.length >= 2 && this.PIECES.has(partial[0]) && partial[1] === 'x') {
            const afterX = partial.slice(2);
            if (!afterX) return true; // "Bx" is valid
            // Allow piece letter after x (BxN, BxR, etc.)
            if (this.PIECES.has(afterX[0]) || afterX[0] === 'P') {
                // Could be PxP, BxN, or BxNc4
                const afterPiece = afterX.slice(1);
                if (!afterPiece) return true;
                // After piece, allow square: BxNc4
                return this._isValidSquarePartial(afterPiece);
            }
        }

        // File-captures-file: c, cx, cxd, cd (all valid partials)
        if (this.FILES.has(partial[0])) {
            if (partial.length === 2 && this.FILES.has(partial[1])) return true; // "cd"
            if (partial.length === 2 && partial[1] === 'x') return true; // "cx"
            if (partial.length === 3 && partial[1] === 'x' && this.FILES.has(partial[2])) return true; // "cxd"
        }

        // Square-captures-square: c6x, c6xd, c6xd4
        if (partial.length >= 3 && this.FILES.has(partial[0]) && this.RANKS.has(partial[1]) && partial[2] === 'x') {
            const after = partial.slice(3);
            if (!after) return true; // "c6x"
            if (after.length === 1 && this.FILES.has(after[0])) return true; // "c6xd"
            if (after.length === 2 && this.FILES.has(after[0]) && this.RANKS.has(after[1])) return true; // "c6xd4"
            if (after.length >= 2 && this.FILES.has(after[0]) && this.RANKS.has(after[1])) {
                // Allow promotion/check suffix: c6xd8=Q, c6xd4+
                const rest = after.slice(2);
                if (!rest) return true;
                if (rest[0] === '=' && rest.length <= 2) return true;
                if (this.CHECK.has(rest[0]) && rest.length === 1) return true;
            }
            return false;
        }

        // Extended notation with dash: e2-, Nf3-, Nf3-e, Nf3-e5
        if (partial.includes('-') && !partial.includes('O') && !partial.includes('0')) {
            return this._isValidExtendedPartial(partial);
        }

        return false;
    }

    /**
     * Check if a move is a file-captures-file shorthand (cd, cxd, ef, exf).
     */
    _isFileCapture(move) {
        const clean = move.replace(/[+#]/g, '');
        if (clean.length === 2 && this.FILES.has(clean[0]) && this.FILES.has(clean[1])) return true;
        if (clean.length === 3 && this.FILES.has(clean[0]) && clean[1] === 'x' && this.FILES.has(clean[2])) return true;
        return false;
    }

    /**
     * Check that file-captures-file has adjacent files.
     */
    _checkFileCaptureAdjacency(move) {
        const clean = move.replace(/[+#]/g, '');
        let sourceFile, destFile;
        if (clean.includes('x')) {
            sourceFile = clean[0];
            destFile = clean[clean.indexOf('x') + 1];
        } else {
            sourceFile = clean[0];
            destFile = clean[1];
        }
        if (!this.FILES.has(sourceFile) || !this.FILES.has(destFile)) return false;
        const srcIdx = this.FILE_ORDER.indexOf(sourceFile);
        const dstIdx = this.FILE_ORDER.indexOf(destFile);
        return Math.abs(srcIdx - dstIdx) === 1;
    }

    /**
     * Validate extended notation (e2-e4, Nf3-e5, etc.).
     */
    _checkExtendedNotation(move) {
        const clean = move.replace(/[+#]/g, '').replace(/=[QRBN]$/, '');
        const dashIdx = clean.indexOf('-');
        if (dashIdx < 0) return false;

        const before = clean.slice(0, dashIdx);
        const after = clean.slice(dashIdx + 1);

        // After dash: must be file+rank (destination square)
        if (after.length !== 2 || !this.FILES.has(after[0]) || !this.RANKS.has(after[1])) return false;

        // Before dash: piece + file + rank, or file + rank
        let pos = 0;
        if (before.length > 0 && this.PIECES.has(before[0])) pos = 1;
        if (before.length - pos !== 2) return false;
        if (!this.FILES.has(before[pos]) || !this.RANKS.has(before[pos + 1])) return false;

        return true;
    }

    /**
     * Check if a string is a valid partial square (file, or file+rank).
     */
    _isValidSquarePartial(s) {
        if (!s) return true;
        if (s.length === 1) return this.FILES.has(s[0]) || this.CHECK.has(s[0]);
        if (s.length === 2) return this.FILES.has(s[0]) && (this.RANKS.has(s[1]) || this.CHECK.has(s[1]));
        if (s.length === 3) return this.FILES.has(s[0]) && this.RANKS.has(s[1]) && this.CHECK.has(s[2]);
        return false;
    }

    /**
     * Check if extended notation partial is valid (e2-, Nf3-, Nf3-e, Nf3-e5).
     */
    _isValidExtendedPartial(partial) {
        const dashIdx = partial.indexOf('-');
        if (dashIdx < 0) return false;

        const before = partial.slice(0, dashIdx);
        const after = partial.slice(dashIdx + 1);

        // Before dash: [Piece]file rank
        let pos = 0;
        if (before.length > 0 && (this.PIECES.has(before[0]) || before[0] === 'P')) pos = 1;
        const coord = before.slice(pos);
        if (coord.length < 2) return false;
        if (!this.FILES.has(coord[0]) || !this.RANKS.has(coord[1])) return false;
        if (coord.length > 2) return false;

        // After dash: empty, file, or file+rank [+promo] [+check]
        if (after.length === 0) return true;
        if (after.length === 1) return this.FILES.has(after[0]);
        if (after.length >= 2 && this.FILES.has(after[0]) && this.RANKS.has(after[1])) {
            // Optional promotion and check
            const rest = after.slice(2);
            if (!rest) return true;
            // Allow =Q, =R, etc.
            if (rest[0] === '=' && rest.length <= 2) return true;
            if (this.CHECK.has(rest[0]) && rest.length === 1) return true;
            return false;
        }
        return false;
    }
}

// Export for use in other modules (works in both browser and Node.js)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LenientChessGrammar };
}
