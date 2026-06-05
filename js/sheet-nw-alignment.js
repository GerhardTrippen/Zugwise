// =============================================================================
// SHEET-NW-ALIGNMENT.JS — Cross-ply pool overlap with Needleman-Wunsch cascade
// =============================================================================
// Three-layer detector (spec by Claude.Opus, ported from the Python proof at
// backend/Needleman_Wunsch_proof_cascade.py):
//
//   LAYER 1: Sliding-window pool overlap finds WHERE alignment breaks
//            (first window where avg overlap drops below threshold).
//   LAYER 2: Near the drop point, check for consecutive near-identical
//            full-move rows on either sheet (the "smoking gun" — player
//            wrote the same move twice).
//   LAYER 3: If no duplicate, run Needleman-Wunsch on a small slice around
//            the drop point. Pool overlap = match score, gap penalty = -0.3.
//            Extract the FIRST gap bracketed by strong anchors (score > 0.5)
//            on BOTH sides. Substitution filter: delete+insert of equal size
//            with no anchor between them is suppressed (it's a substitution,
//            not a structural edit — the normal fix-finder handles those).
//
// Returns ONE suggestion per call. The caller (UI layer) shows the banner,
// applies the fix on user confirm, re-merges, and calls again with an updated
// searchFrom to skip the now-fixed region.
//
// Dependencies: window.MergeSheets.normalizeSanForComparison
// =============================================================================

(function() {
  'use strict';

  function _norm(san) {
    if (window.MergeSheets && window.MergeSheets.normalizeSanForComparison) {
      return window.MergeSheets.normalizeSanForComparison(san);
    }
    if (!san) return '';
    return String(san).replace(/[+#]/g, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O').trim();
  }

  function _altMove(a) {
    if (!a) return null;
    if (typeof a === 'string') return a;
    if (Array.isArray(a)) return a[0];
    return a.move;
  }
  function _altConf(a) {
    if (!a) return 0;
    if (typeof a === 'string') return 0.1;
    if (Array.isArray(a)) return (a[1] || 0.1);
    return (typeof a.confidence === 'number') ? a.confidence : 0.1;
  }

  // CRITICAL: the OCR worker stores top-1 in cell.move/cell.confidence and
  // only ranks 2..N in cell.alternatives. The python proof's parser, by
  // contrast, includes top-1 at index 0 of alternatives. Without this
  // helper, pool overlap would compare only the *secondary* candidates
  // between sheets — yielding ~0.05 even on perfectly aligned plies and
  // making every NW match score collapse to noise.
  function _fullAlts(cell) {
    if (!cell) return [];
    var out = [];
    if (cell.move) {
      out.push({ move: cell.move,
                 confidence: (typeof cell.confidence === 'number') ? cell.confidence : 0.1 });
    }
    if (cell.alternatives && cell.alternatives.length) {
      for (var i = 0; i < cell.alternatives.length; i++) out.push(cell.alternatives[i]);
    }
    return out;
  }

  function _topMove(cell) {
    if (!cell) return '';
    if (cell.move) return cell.move;
    if (cell.alternatives && cell.alternatives.length) return _altMove(cell.alternatives[0]);
    return '';
  }

  // ---------------------------------------------------------------------------
  // CORE: Pool overlap between two cells' alternative lists
  // ---------------------------------------------------------------------------
  // Two cells reading the same handwritten move share OCR alternative
  // candidates; two cells reading different moves don't. Score = sum of
  // (conf_a + conf_b) for each shared normalized SAN. Range: 0 (no overlap)
  // to ~2.0 (perfect agreement on top candidate).
  // ---------------------------------------------------------------------------

  // Parse a SAN string into chess-meaningful components: target square,
  // file, rank, piece type, capture flag, promotion, castling. Used by
  // poolOverlapStructured to compute per-component agreement between two
  // OCR alt distributions. Tolerates the lenient grammar's relaxed forms
  // (e.g. "Pf4" → pawn to f4, "cd" → pawn capture from c to file d).
  function _parseSan(san) {
    if (!san) return null;
    var s = String(san).replace(/[+#!?]/g, '').trim();
    if (!s) return null;
    if (s === 'O-O' || s === '0-0') return { castle: 'short' };
    if (s === 'O-O-O' || s === '0-0-0') return { castle: 'long' };
    var promo = null;
    var pm = s.match(/=([QRBN])$/);
    if (pm) { promo = pm[1]; s = s.slice(0, -2); }
    var m = s.match(/([a-h])([1-8])$/);
    if (!m) {
      var m2 = s.match(/^([a-h])([a-h])$/);  // lenient "cd"
      if (m2) return { piece: 'P', file: m2[2], rank: null, capture: true };
      return null;
    }
    var file = m[1];
    var rank = m[2];
    var rest = s.slice(0, -2);
    var capture = false;
    if (rest && (rest.charAt(rest.length - 1) === 'x' || rest.charAt(rest.length - 1) === 'X')) {
      capture = true;
      rest = rest.slice(0, -1);
    }
    var piece;
    if (rest === '') piece = 'P';
    else if (/^[RNBQK]/.test(rest)) piece = rest.charAt(0);
    else if (/^[Pp]/.test(rest)) piece = 'P';
    else if (/^[a-h]/.test(rest)) piece = 'P';  // pawn capture from <file>
    else piece = rest.charAt(0);
    return {
      piece: piece, target: file + rank,
      file: file, rank: rank, capture: capture, promo: promo
    };
  }

  // A SAN is "truncated" when it can't be parsed into a destination square —
  // typical OCR output when the original handwriting was illegible or cut off
  // (e.g. "Nx" with no target, single-char "K", "Nf" without a rank). Real
  // moves always have a destination, so a truncated primary SAN is a strong
  // signal that the cell is a write-error rather than a real move missed by
  // the other player. Used by detectNextAlignmentIssue to bias direction
  // toward delete (rather than insert) when a structural gap contains such
  // cells on the long sheet.
  function _isSanTruncated(san) {
    if (!san || typeof san !== 'string') return true;
    var trimmed = san.trim();
    if (!trimmed || trimmed === '???') return true;
    return _parseSan(trimmed) === null;
  }

  // Structured pool overlap: existing exact-SAN score + per-component
  // agreement on target square / rank / file / piece. Captures cases where
  // both cells strongly agree on chess structure (e.g. all alts target f4)
  // but diverge on which piece moved — exact-SAN matching misses that.
  // The original poolOverlap is left alone; this is a read-only sibling.
  function poolOverlapStructured(alts1, alts2) {
    var exact = poolOverlap(alts1, alts2);
    function _buildDists(alts) {
      var sq = {}, rk = {}, fl = {}, pc = {};
      if (!alts) return { sq: sq, rk: rk, fl: fl, pc: pc };
      for (var i = 0; i < alts.length; i++) {
        var move = _altMove(alts[i]);
        var conf = _altConf(alts[i]);
        if (!move || conf <= 0) continue;
        var p = _parseSan(move);
        if (!p) continue;
        if (p.castle) {
          sq[p.castle] = (sq[p.castle] || 0) + conf;
          pc.K = (pc.K || 0) + conf;
          continue;
        }
        if (p.target) sq[p.target] = (sq[p.target] || 0) + conf;
        if (p.rank)   rk[p.rank]   = (rk[p.rank]   || 0) + conf;
        if (p.file)   fl[p.file]   = (fl[p.file]   || 0) + conf;
        if (p.piece)  pc[p.piece]  = (pc[p.piece]  || 0) + conf;
      }
      return { sq: sq, rk: rk, fl: fl, pc: pc };
    }
    function _distOverlap(da, db) {
      var score = 0;
      var keys = Object.keys(da);
      for (var i = 0; i < keys.length; i++) {
        if (db[keys[i]] !== undefined) score += da[keys[i]] + db[keys[i]];
      }
      return Math.min(score, 2.0);
    }
    var d1 = _buildDists(alts1);
    var d2 = _buildDists(alts2);
    var sqScore = _distOverlap(d1.sq, d2.sq);
    var rkScore = _distOverlap(d1.rk, d2.rk);
    var flScore = _distOverlap(d1.fl, d2.fl);
    var pcScore = _distOverlap(d1.pc, d2.pc);
    // Weighted blend (weights sum to 1.0). Exact SAN still dominates;
    // structured components add credit for agreement that exact-SAN missed.
    var W = { exact: 0.40, sq: 0.30, rk: 0.10, fl: 0.05, pc: 0.15 };
    var combined = W.exact * exact.score + W.sq * sqScore + W.rk * rkScore +
                   W.fl * flScore + W.pc * pcScore;
    return {
      score: exact.score,             // unchanged for compat
      shared: exact.shared,
      exactScore: exact.score,
      squareScore: sqScore,
      rankScore: rkScore,
      fileScore: flScore,
      pieceScore: pcScore,
      combinedScore: combined
    };
  }

  function poolOverlap(alts1, alts2) {
    if (!alts1 || !alts2 || !alts1.length || !alts2.length) {
      return { score: 0, shared: [] };
    }
    var d1 = {};
    alts1.forEach(function(a) {
      var n = _norm(_altMove(a));
      if (n) d1[n] = _altConf(a);
    });
    var shared = [];
    alts2.forEach(function(a) {
      var n = _norm(_altMove(a));
      if (n && d1[n] !== undefined) {
        shared.push({ move: n, conf1: d1[n], conf2: _altConf(a) });
      }
    });
    var score = 0;
    shared.forEach(function(s) { score += s.conf1 + s.conf2; });
    shared.sort(function(a, b) { return (b.conf1 + b.conf2) - (a.conf1 + a.conf2); });
    return { score: score, shared: shared };
  }

  // ---------------------------------------------------------------------------
  // LAYER 1 — sliding-window: find the first ply where overlap drops
  // ---------------------------------------------------------------------------

  function findOverlapDrop(s1, s2, startFrom, windowSize, threshold) {
    windowSize = windowSize || 8;
    threshold = (threshold !== undefined) ? threshold : 0.3;
    startFrom = startFrom || 0;
    var limit = Math.min(s1.length, s2.length);
    for (var start = startFrom; start <= limit - windowSize; start += 2) {
      var total = 0;
      var n = 0;
      for (var p = start; p < Math.min(start + windowSize, limit); p++) {
        if (!s1[p] || !s2[p]) continue;
        var r = poolOverlap(_fullAlts(s1[p]), _fullAlts(s2[p]));
        total += r.score;
        n++;
      }
      var avg = n > 0 ? total / n : 0;
      if (avg < threshold) return start;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // LAYER 2 — consecutive-row duplicate detection on a single sheet
  // ---------------------------------------------------------------------------
  // A real player CANNOT make the same move twice in a row (the position
  // wouldn't allow it), so two adjacent rows whose top-1 SAN matches AND
  // whose pool overlap exceeds 0.8 are definitively a sheet duplication.
  // Returns { deleteFrom, deleteTo } — the second row to delete — or null.
  // ---------------------------------------------------------------------------

  function findDuplicateNear(cells, nearPly, searchRadius, diag) {
    searchRadius = searchRadius || 10;
    var start = Math.max(0, nearPly - searchRadius);
    start = start - (start % 2);                       // align to full-move
    var end = Math.min(cells.length - 3, nearPly + searchRadius);
    var topMatchCount = 0;
    var bestPair = null;
    for (var i = start; i < end; i += 2) {
      var w1 = cells[i];
      var w2 = cells[i + 2];
      var b1 = cells[i + 1];
      var b2 = cells[i + 3];
      if (!w1 || !w2 || !b1 || !b2) continue;
      var w1Top = _norm(_topMove(w1));
      var w2Top = _norm(_topMove(w2));
      if (!w1Top || w1Top !== w2Top) continue;
      topMatchCount++;
      var wScore = poolOverlap(_fullAlts(w1), _fullAlts(w2)).score;
      var bScore = poolOverlap(_fullAlts(b1), _fullAlts(b2)).score;
      // Structured B-overlap as a fuzzy fallback: catches near-duplicates
      // where the W half exact-matches but the B half has different rank
      // guesses on the same piece+file (e.g. Rxf6/Rxf2 vs Rxf7/Rxf1).
      // bStructPF measures combined piece+file agreement (max ≈ 4.0 when
      // both are 100% maxed); >3.2 = 80% agreement on both components.
      var bStructPF = 0;
      var bStructObj = null;
      bStructObj = poolOverlapStructured(_fullAlts(b1), _fullAlts(b2));
      if (bStructObj) bStructPF = bStructObj.pieceScore + bStructObj.fileScore;
      if (!bestPair ||
          (wScore + bScore) > bestPair.combined ||
          (wScore + Math.max(bScore, bStructPF * 0.25)) > bestPair.combined) {
        bestPair = {
          i: i, w1Top: w1Top, wScore: wScore, bScore: bScore,
          bStructPF: bStructPF,
          combined: wScore + bScore
        };
      }
      var exactHit = (wScore > 0.8 && bScore > 0.4);
      var structHit = (wScore > 0.8 && bScore <= 0.4 && bStructPF >= 3.2);
      if (exactHit || structHit) {
        if (diag) diag.duplicate = {
          hit: true, ply: i + 2, wScore: wScore, bScore: bScore,
          bMatchType: exactHit ? 'exact' : 'structured',
          bStructPF: bStructPF
        };
        return {
          deleteFrom: i + 2, deleteTo: i + 4,
          wScore: wScore, bScore: bScore,
          bMatchType: exactHit ? 'exact' : 'structured',
          bStructPF: bStructPF
        };
      }
    }
    if (diag) {
      diag.duplicate = { hit: false, topMatches: topMatchCount, best: bestPair };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // LAYER 3 — local Needleman-Wunsch alignment
  // ---------------------------------------------------------------------------
  // Match score = pool overlap minus a small threshold (so plies with
  // essentially zero overlap don't accumulate spurious diagonal bonuses).
  // Gap penalty = -0.3 per ply.
  //
  // Output: an alignment array, each entry one of:
  //   { type: 'match',   s1Idx, s2Idx, score, shared }
  //   { type: 'gap_s1',  s2Idx }      — S2 has extra ply (S1 missing)
  //   { type: 'gap_s2',  s1Idx }      — S1 has extra ply (S2 missing)
  // ---------------------------------------------------------------------------

  function localNeedlemanWunsch(s1Slice, s2Slice, gapPenalty, matchThreshold) {
    if (gapPenalty === undefined) gapPenalty = -0.3;
    if (matchThreshold === undefined) matchThreshold = 0.05;
    var n = s1Slice.length;
    var m = s2Slice.length;
    var cache = {};
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < m; j++) {
        var r = (s1Slice[i] && s2Slice[j])
          ? poolOverlap(_fullAlts(s1Slice[i]), _fullAlts(s2Slice[j]))
          : { score: 0, shared: [] };
        cache[i + ',' + j] = { score: r.score - matchThreshold, shared: r.shared };
      }
    }
    var dp = new Array(n + 1);
    var trace = new Array(n + 1);
    for (var i = 0; i <= n; i++) {
      dp[i] = new Array(m + 1);
      trace[i] = new Array(m + 1);
      dp[i][0] = i * gapPenalty;
      trace[i][0] = i > 0 ? 'up' : null;
    }
    for (var j = 0; j <= m; j++) {
      dp[0][j] = j * gapPenalty;
      trace[0][j] = j > 0 ? 'left' : null;
    }
    for (var i = 1; i <= n; i++) {
      for (var j = 1; j <= m; j++) {
        var ms = cache[(i - 1) + ',' + (j - 1)].score;
        var diag = dp[i - 1][j - 1] + ms;
        var up = dp[i - 1][j] + gapPenalty;
        var left = dp[i][j - 1] + gapPenalty;
        var best = Math.max(diag, up, left);
        dp[i][j] = best;
        if (best === diag) trace[i][j] = 'diag';
        else if (best === up) trace[i][j] = 'up';
        else trace[i][j] = 'left';
      }
    }
    var alignment = [];
    var ci = n, cj = m;
    while (ci > 0 || cj > 0) {
      if (ci > 0 && cj > 0 && trace[ci][cj] === 'diag') {
        var c = cache[(ci - 1) + ',' + (cj - 1)];
        alignment.push({
          type: 'match', s1Idx: ci - 1, s2Idx: cj - 1,
          score: c.score + matchThreshold, shared: c.shared
        });
        ci--; cj--;
      } else if (ci > 0 && (cj === 0 || trace[ci][cj] === 'up')) {
        alignment.push({ type: 'gap_s2', s1Idx: ci - 1 });   // S1 has extra
        ci--;
      } else {
        alignment.push({ type: 'gap_s1', s2Idx: cj - 1 });   // S2 has extra
        cj--;
      }
    }
    alignment.reverse();
    return alignment;
  }

  // ---------------------------------------------------------------------------
  // SUGGESTION EXTRACTION — bracketing-anchor filter + substitution filter
  // ---------------------------------------------------------------------------

  function extractFirstSuggestion(alignment, s1Slice, s2Slice, s1Offset, s2Offset, minAnchor, diag) {
    if (minAnchor === undefined) minAnchor = 0.5;
    if (s2Offset === undefined) s2Offset = s1Offset;

    var rejections = [];

    for (var i = 0; i < alignment.length; i++) {
      var entry = alignment[i];
      if (entry.type !== 'gap_s1' && entry.type !== 'gap_s2') continue;
      var gapType = entry.type;
      var gapStart = i;
      var gapEnd = i;
      // Track which alignment indices contribute to the suggestion.
      //   gapPlyIndices = entries that translate to ply DELETIONS (gap_s2)
      //                   or insertion-content (gap_s1).
      //   gapEnd        = last alignment index covered (for anchor search).
      // For DELETE (gap_s2), we bridge across a single weak match (score
      // < minAnchor=0.5) to the next gap_s2 — but the matched cell is NOT
      // added to the deletion list. The apply path does separate splices
      // in reverse ply order to handle the non-contiguous deletion. This
      // captures the common case where two consecutive S1 cells are both
      // wrong (e.g., a duplicate "Ke8" written twice) but NW picked a
      // low-quality alignment for the middle one. INSERT (gap_s1) doesn't
      // bridge — placeholder insertion around a real S1 cell would mangle
      // the surrounding context.
      var gapPlyIndices = [gapStart];
      gapEnd = gapStart;
      while (true) {
        var nextIdx = gapEnd + 1;
        if (nextIdx >= alignment.length) break;
        var next = alignment[nextIdx];
        if (next.type === gapType) {
          gapPlyIndices.push(nextIdx);
          gapEnd = nextIdx;
          continue;
        }
        if (gapType === 'gap_s2' && next.type === 'match' && next.score < minAnchor) {
          var afterIdx = nextIdx + 1;
          if (afterIdx < alignment.length && alignment[afterIdx].type === gapType) {
            // Bridge across the weak match, but don't include it in the
            // deletion list. gapEnd advances past the bridged region for
            // anchor-search purposes.
            gapPlyIndices.push(afterIdx);
            gapEnd = afterIdx;
            continue;
          }
        }
        break;
      }
      // POST-BRIDGE SWAP: if a bridged match cell has the same TEXT as
      // the next gap cell, swap them in the deletion list so the
      // deletion becomes contiguous (one full move's W+B half-moves)
      // instead of skipping a half-move. Same chess outcome — the kept
      // cell has identical text either way — but a contiguous full-move
      // deletion is far more natural to describe and review than
      // "delete 56.W and 57.W (skip 56.B)".
      if (gapType === 'gap_s2') {
        for (var pi = 0; pi + 1 < gapPlyIndices.length; pi++) {
          var aAi = gapPlyIndices[pi];
          var bAi = gapPlyIndices[pi + 1];
          if (bAi - aAi !== 2) continue;  // no bridged match between
          var matchAi = aAi + 1;
          var matchEntry = alignment[matchAi];
          if (matchEntry.type !== 'match') continue;
          var matchCell = s1Slice[matchEntry.s1Idx];
          var nextCell = s1Slice[alignment[bAi].s1Idx];
          if (!matchCell || !nextCell) continue;
          var mTop = _norm(_topMove(matchCell));
          var nTop = _norm(_topMove(nextCell));
          if (mTop && mTop === nTop) {
            gapPlyIndices[pi + 1] = matchAi;
          }
        }
        // Re-sort in case any swap broke ordering (shouldn't with a single
        // bridge but defensive).
        gapPlyIndices.sort(function(a, b) { return a - b; });
      }

      var gapSize = gapPlyIndices.length;

      // Anchor scan. For 1-PLY gaps only, look at the K nearest matches
      // and pick the STRONGEST — not the first match meeting the floor.
      // The cell immediately adjacent to a 1-ply missing-ply gap is often
      // OCR-noisy (the player's own write-error around the skipped cell),
      // so the true structural anchor sits one or two cells further out.
      // Without this, a noisy neighbor at score 1.22 wins over the real
      // anchor at 1.95 and fails the strict 1.5 1-ply gate downstream.
      //
      // For MULTI-PLY gaps, preserve the original "first match >= 0.5
      // wins, however far" behavior. Multi-ply uses the loose 0.5 floor;
      // capping the scan to K would regress the rare case where the
      // immediate neighbors are all sub-floor but a strong anchor lives
      // 4+ positions out.
      var ANCHOR_SCAN_K = (gapSize === 1) ? 3 : Infinity;
      var beforeAnchor = null;
      var bestBeforeScore = -Infinity;
      var beforeMatchesSeen = 0;
      for (var jj = gapStart - 1; jj >= 0; jj--) {
        if (alignment[jj].type !== 'match') continue;
        if (alignment[jj].score > bestBeforeScore) bestBeforeScore = alignment[jj].score;
        if (alignment[jj].score >= minAnchor) {
          if (!beforeAnchor || alignment[jj].score > beforeAnchor.score) {
            beforeAnchor = alignment[jj];
          }
          // Multi-ply: first qualifying match wins (original behavior).
          // 1-ply: keep scanning to K matches to find the strongest.
          if (gapSize > 1) break;
        }
        beforeMatchesSeen++;
        if (beforeMatchesSeen >= ANCHOR_SCAN_K) break;
      }
      var afterAnchor = null;
      var bestAfterScore = -Infinity;
      var afterMatchesSeen = 0;
      for (var jj2 = gapEnd + 1; jj2 < alignment.length; jj2++) {
        if (alignment[jj2].type !== 'match') continue;
        if (alignment[jj2].score > bestAfterScore) bestAfterScore = alignment[jj2].score;
        if (alignment[jj2].score >= minAnchor) {
          if (!afterAnchor || alignment[jj2].score > afterAnchor.score) {
            afterAnchor = alignment[jj2];
          }
          if (gapSize > 1) break;
        }
        afterMatchesSeen++;
        if (afterMatchesSeen >= ANCHOR_SCAN_K) break;
      }
      // BOTH anchors required, no relaxation.
      if (!beforeAnchor) {
        rejections.push({ gapType: gapType, gapStart: gapStart, size: gapSize,
                          reason: 'no_before_anchor', bestBeforeScore: bestBeforeScore });
        continue;
      }
      if (!afterAnchor) {
        rejections.push({ gapType: gapType, gapStart: gapStart, size: gapSize,
                          reason: 'no_after_anchor', bestAfterScore: bestAfterScore });
        continue;
      }

      // Anchor-strength gate. 1-ply edits are the most noise-sensitive —
      // a single misaligned cell in an OCR-noisy region can produce a
      // plausible-looking insert/delete suggestion whose anchors are only
      // moderate. Empirically:
      //   user-accepted 1-ply: 1.72-1.99
      //   user-accepted multi-ply: 0.92-1.99
      //   false-positive 1-ply: 1.02-1.10
      // Require both anchors >= 1.5 for 1-ply edits; keep the 0.5 floor
      // for multi-ply where the size itself is supporting evidence.
      var minAnchorRequired = (gapSize === 1) ? 1.5 : minAnchor;
      if (beforeAnchor.score < minAnchorRequired ||
          afterAnchor.score < minAnchorRequired) {
        rejections.push({ gapType: gapType, gapStart: gapStart, size: gapSize,
                          reason: 'anchors_too_weak',
                          before: beforeAnchor.score, after: afterAnchor.score,
                          required: minAnchorRequired });
        continue;
      }

      // Substitution filter — ONLY suppress the unambiguous 1-for-1 case:
      // exactly 1 delete IMMEDIATELY followed by exactly 1 insert (or
      // vice versa), with no anchor between. That's a single-cell OCR
      // substitution the normal fix-finder handles. Everything else
      // (any multi-ply gap, or any asymmetric mix of inserts/deletes)
      // deserves to surface — even if it looks substitution-like, the
      // user should see the evidence. Cross-pass 1-ply thrash is caught
      // by the forward-simulation safety check at the cascade level.
      if (gapSize === 1) {
        var oppositeType = (gapType === 'gap_s1') ? 'gap_s2' : 'gap_s1';
        var adjacentOpposite = 0;
        for (var jj3 = gapEnd + 1; jj3 < alignment.length; jj3++) {
          if (alignment[jj3].type === oppositeType) adjacentOpposite++;
          else if (alignment[jj3].type === 'match' && alignment[jj3].score >= minAnchor) break;
          else if (alignment[jj3].type === gapType) break;
          else if (adjacentOpposite > 0) break;  // stop after the opposite-run ends
        }
        if (adjacentOpposite === 1) {
          rejections.push({ gapType: gapType, gapStart: gapStart, size: gapSize,
                            reason: 'substitution_filter_1to1',
                            adjacentOpposite: adjacentOpposite });
          continue;
        }
      }

      // Build the suggestion. Both anchors are guaranteed non-null here
      // (filtered above).
      var bScore = beforeAnchor.score;
      var aScore = afterAnchor.score;
      var anchorPlies = {
        beforeAnchorS1Ply: s1Offset + beforeAnchor.s1Idx,
        beforeAnchorS2Ply: s2Offset + beforeAnchor.s2Idx,
        afterAnchorS1Ply:  s1Offset + afterAnchor.s1Idx,
        afterAnchorS2Ply:  s2Offset + afterAnchor.s2Idx
      };

      // Compute BOTH directions for any gap. A gap_s2 (S1 has extra) can be
      // resolved by either deleting from S1 (current default) OR inserting
      // those same N placeholders into S2 — symmetric in NW alignment terms,
      // chess-meaningfully different. Same idea for gap_s1. Surfacing both
      // lets the user pick the one that matches what they see on the
      // physical sheets, instead of trusting NW's lower-cost-edit pick
      // (which is OCR-pool-overlap math, not chess plausibility).
      var primarySug, inverseSug;
      if (gapType === 'gap_s1') {
        // S2 has extra plies. Primary = insert on S1; inverse = delete from S2.
        var s2Content = [];
        var s2Plies = [];
        var s2Labels = [];
        for (var jj4 = 0; jj4 < gapPlyIndices.length; jj4++) {
          var aEntry = alignment[gapPlyIndices[jj4]];
          var cell = s2Slice[aEntry.s2Idx];
          if (!cell) continue;
          s2Content.push({
            label: cell.num + '.' + (cell.color || 'w').toUpperCase(),
            topMove: _topMove(cell) || '???'
          });
          s2Plies.push(s2Offset + aEntry.s2Idx);
          s2Labels.push({
            label: cell.num + '.' + (cell.color || 'w').toUpperCase(),
            topMove: _topMove(cell) || '???'
          });
        }
        // Insert on S1 at the SAME ABSOLUTE PLY as the gap cell on S2.
        // Previously used beforeAnchor.s1Idx, which sits right after the
        // anchor. When NW places weak matches between the anchor and the
        // first gap entry, the gap cell drifts downstream of the anchor;
        // s2Plies[0]-1 always equals "ply right before the gap" regardless
        // of intervening weak matches. For clean alignments (no weak
        // matches in between) this is identical to the old computation.
        var afterPlyS1 = (s2Plies.length > 0)
                         ? (s2Plies[0] - 1)
                         : (s1Offset + beforeAnchor.s1Idx);
        primarySug = {
          action: 'insert',
          onSheet: 's1',
          nPlies: gapSize,
          afterPly: afterPlyS1,
          beforeScore: bScore,
          afterScore: aScore,
          s2Content: s2Content
        };
        inverseSug = {
          action: 'delete',
          fromSheet: 's2',
          nPlies: gapSize,
          plies: s2Plies,
          labels: s2Labels,
          beforeScore: bScore,
          afterScore: aScore
        };
      } else {
        // S1 has extra plies. Primary = delete from S1; inverse = insert on S2.
        var s1Plies = [];
        var s1Labels = [];
        for (var jj5 = 0; jj5 < gapPlyIndices.length; jj5++) {
          var aEntry2 = alignment[gapPlyIndices[jj5]];
          var idx = s1Offset + aEntry2.s1Idx;
          var c1 = s1Slice[aEntry2.s1Idx];
          s1Plies.push(idx);
          s1Labels.push({
            label: (c1 ? c1.num + '.' + (c1.color || 'w').toUpperCase() : '?'),
            topMove: _topMove(c1) || '???'
          });
        }
        primarySug = {
          action: 'delete',
          fromSheet: 's1',
          nPlies: gapSize,
          plies: s1Plies,
          labels: s1Labels,
          beforeScore: bScore,
          afterScore: aScore
        };
        // Inverse: insert into S2 at the SAME ABSOLUTE PLY as the gap cell
        // on S1. Previously used beforeAnchor.s2Idx, which sits right
        // after the anchor. When NW places weak matches between the
        // anchor and the first gap_s2 entry on S1, the gap cell drifts
        // downstream of the anchor; s1Plies[0]-1 always equals "ply
        // right before the gap" regardless of intervening weak matches.
        // For clean alignments this matches the old computation; for
        // the user-flagged 49.W gap with weak match at 50, the insertion
        // now lands at 51.W (matching primary's 51.W deletion target)
        // instead of at 50.W (right after the 49.B anchor).
        // Side benefit: the descriptor s2Content labels (e.g., "51.W h6")
        // now correctly describe what fills the placeholder — the
        // placeholder lands at the same absolute ply as the labeled cell.
        var afterPlyS2 = (s1Plies.length > 0)
                         ? (s1Plies[0] - 1)
                         : (s2Offset + beforeAnchor.s2Idx);
        inverseSug = {
          action: 'insert',
          onSheet: 's2',
          nPlies: gapSize,
          afterPly: afterPlyS2,
          beforeScore: bScore,
          afterScore: aScore,
          // For the "Other sheet has at this gap:" preview line — reuses the
          // s2Content slot but holds S1 content (the source for placeholder
          // fills when inserting into S2).
          s2Content: s1Labels.slice()
        };
      }

      // Attach anchor plies to both, and cross-link so each suggestion's
      // .inverseDirection points at the other. Symmetric — swapping is just
      // promoting the inverse to primary.
      Object.assign(primarySug, anchorPlies);
      Object.assign(inverseSug, anchorPlies);

      // SHARED WINDOW CENTER for score-delta simulation. Both directions
      // analyze the same structural gap, but their natural action plies
      // (plies[0] for delete, afterPly+1 for insert) can differ when the
      // first gap_s2 entry sits a few plies past the before-anchor — e.g.,
      // weak matches between the anchor and the gap shift plies[0]
      // downstream while afterPly stays anchored at beforeAnchor. The
      // window in _computeScoreDeltaForSug is centered on actionPly, so
      // mismatched actionPlys produce mismatched pre-comparison windows
      // and the pp deltas stop being apples-to-apples (user observed
      // pre-scores differing by ~1.7 between directions on the same gap).
      //
      // Use the before-anchor's s1 ply + 1 as the canonical center — that's
      // the natural "gap-start" position and lives between the anchor and
      // the gap proper for both directions.
      var sharedCenter = anchorPlies.beforeAnchorS1Ply + 1;
      primarySug.scoreWindowCenter = sharedCenter;
      inverseSug.scoreWindowCenter = sharedCenter;

      primarySug.inverseDirection = inverseSug;
      inverseSug.inverseDirection = primarySug;
      return primarySug;
    }
    if (diag) diag.extract = { rejections: rejections };
    return null;
  }

  // ---------------------------------------------------------------------------
  // TOP LEVEL — one cascade pass; returns ONE suggestion or null
  // ---------------------------------------------------------------------------

  function _summarizeAlignment(alignment) {
    var counts = { match: 0, gap_s1: 0, gap_s2: 0 };
    var maxMatch = -Infinity;
    var matchScores = [];
    for (var i = 0; i < alignment.length; i++) {
      var e = alignment[i];
      counts[e.type] = (counts[e.type] || 0) + 1;
      if (e.type === 'match') {
        if (e.score > maxMatch) maxMatch = e.score;
        matchScores.push(e.score);
      }
    }
    matchScores.sort(function(a, b) { return b - a; });
    var top5 = matchScores.slice(0, 5).map(function(s) { return s.toFixed(3); });
    return { counts: counts, maxMatch: maxMatch, top5MatchScores: top5,
             alignmentLen: alignment.length };
  }

  // True when scoring was deferred because _buildVerifiedFen could not
  // reach the gap's pre-edge (reconstruction is stuck before the gap).
  // Used to GATE banner emission so the user only sees suggestions whose
  // legality + piece-presence numbers are real. When reconstruction
  // advances past the gap, _runNWAlignmentCheck re-fires and scoring
  // becomes available — at which point this returns false and the
  // suggestion surfaces.
  function _isScoringDeferred(sug) {
    return !!(sug && sug.cleanFenSrc &&
              sug.cleanFenSrc.indexOf('deferred') === 0);
  }

  // Finalize a structural-gap suggestion before it leaves detectNextAlignmentIssue:
  //   1) forward-sim safety check (1-ply edits only) — may suppress (return null)
  //   2) attach scoreDelta + chess-aware fields to primary
  //   3) attach scoreDelta + chess-aware fields to inverse, cross-link
  //   4) apply the direction rule (insert-primary unless truncated-SAN on delete side)
  //
  // Used by BOTH the LAYER 3 NW path (the main gap detector) and the
  // silent-tail-mismatch path. Previously only LAYER 3 ran this logic
  // inline; silent-tail returned its tailSug bare, which left the banner
  // without a Δpp badge when the picker surfaced a silent-tail suggestion.
  // Centralizing here keeps both paths in sync.
  function _attachScoresAndApplyDirectionRule(sug, sheet1Cells, sheet2Cells, searchFrom, diag, reconMoves) {
    if (!sug || (sug.action !== 'insert' && sug.action !== 'delete')) return sug;

    // Forward-sim safety check (1-ply edits only).
    if (sug.nPlies === 1) {
      var simResult = _simulateAndCheckReverse(sug, sheet1Cells, sheet2Cells, searchFrom, reconMoves);
      var suppressReason = null;
      if (simResult.isReversed) {
        suppressReason = 'reverse_proposal';
      } else {
        var checkDelta = (typeof simResult.rawScoreDelta === 'number')
                         ? simResult.rawScoreDelta : simResult.scoreDelta;
        if (typeof checkDelta === 'number' && checkDelta < SCORE_DELTA_MIN) {
          suppressReason = 'score_not_improved';
        }
      }
      if (suppressReason) {
        simResult.suppressReason = suppressReason;
        diag.simulation = simResult;
        diag.suppressed = sug;
        if (typeof console !== 'undefined' && console.log) {
          var sugLabel = sug.action + ' ' + sug.nPlies + 'p ' +
                         (sug.fromSheet || sug.onSheet) +
                         ' @ply ' + (sug.action === 'insert' ? sug.afterPly : sug.plies[0]);
          console.log('🧭 NW suppress (' + suppressReason + '): ' + sugLabel +
                      ' | pre=' + (simResult.preScore || 0).toFixed(2) +
                      ' post=' + (simResult.postScore || 0).toFixed(2) +
                      ' Δ=' + (simResult.scoreDelta || 0).toFixed(2) +
                      (simResult.followUp ? ' | followUp=' + simResult.followUp : ''));
        }
        return null;
      }
      diag.simulation = simResult;
    }

    // Attach scoreDelta to primary. For 1-ply that passed safety, reuse
    // simResult; for multi-ply or non-1-ply paths, compute fresh.
    if (diag.simulation && typeof diag.simulation.scoreDelta === 'number') {
      sug.preScore = diag.simulation.preScore;
      sug.postScore = diag.simulation.postScore;
      sug.scoreDelta = diag.simulation.scoreDelta;
      if (typeof diag.simulation.preCells === 'number') sug.preCells = diag.simulation.preCells;
      if (typeof diag.simulation.postCells === 'number') sug.postCells = diag.simulation.postCells;
      if (typeof diag.simulation.preIllegals === 'number') sug.preIllegals = diag.simulation.preIllegals;
      if (typeof diag.simulation.postIllegals === 'number') sug.postIllegals = diag.simulation.postIllegals;
      if (typeof diag.simulation.legalityPenalty === 'number') sug.legalityPenalty = diag.simulation.legalityPenalty;
      if (typeof diag.simulation.endStatePenalty === 'number') sug.endStatePenalty = diag.simulation.endStatePenalty;
      if (typeof diag.simulation.endStateCellsTested === 'number') sug.endStateCellsTested = diag.simulation.endStateCellsTested;
      if (typeof diag.simulation.rawScoreDelta === 'number') sug.rawScoreDelta = diag.simulation.rawScoreDelta;
      if (typeof diag.simulation.pieceImpSelf === 'number') sug.pieceImpSelf = diag.simulation.pieceImpSelf;
      if (typeof diag.simulation.pieceImpOther === 'number') sug.pieceImpOther = diag.simulation.pieceImpOther;
      if (typeof diag.simulation.piecePresenceAdj === 'number') sug.piecePresenceAdj = diag.simulation.piecePresenceAdj;
    } else {
      var deltaInfo = null;
      try {
        deltaInfo = _computeScoreDeltaForSug(sug, sheet1Cells, sheet2Cells, reconMoves);
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) {
          var sugPlyDbg = (sug.action === 'insert') ? sug.afterPly : (sug.plies && sug.plies[0]);
          console.error('🧭 NW _computeScoreDeltaForSug THREW on primary ' +
            sug.action + ' ' + sug.nPlies + 'p @ply ' + sugPlyDbg + ': ' +
            (e && e.message ? e.message : e), e && e.stack);
        }
      }
      if (deltaInfo) {
        sug.preScore = deltaInfo.preScore;
        sug.postScore = deltaInfo.postScore;
        sug.scoreDelta = deltaInfo.scoreDelta;
        sug.rawScoreDelta = deltaInfo.rawScoreDelta;
        sug.preCells = deltaInfo.preCells;
        sug.postCells = deltaInfo.postCells;
        sug.preIllegals = deltaInfo.preIllegals;
        sug.postIllegals = deltaInfo.postIllegals;
        sug.legalityPenalty = deltaInfo.legalityPenalty;
        sug.endStatePenalty = deltaInfo.endStatePenalty;
        sug.endStateCellsTested = deltaInfo.endStateCellsTested;
        sug.pieceImpSelf = deltaInfo.pieceImpSelf;
        sug.pieceImpOther = deltaInfo.pieceImpOther;
        sug.piecePresenceAdj = deltaInfo.piecePresenceAdj;
        sug.cleanFenSrc = deltaInfo.cleanFenSrc;
      } else if (typeof console !== 'undefined' && console.warn) {
        var sugPlyDbg2 = (sug.action === 'insert') ? sug.afterPly : (sug.plies && sug.plies[0]);
        console.warn('🧭 NW _computeScoreDeltaForSug returned null/undefined on primary ' +
          sug.action + ' ' + sug.nPlies + 'p @ply ' + sugPlyDbg2 +
          ' — scoreDelta will be missing on banner');
      }
    }

    // Attach scoreDelta to inverse.
    if (sug.inverseDirection) {
      var invDelta = null;
      try {
        invDelta = _computeScoreDeltaForSug(sug.inverseDirection,
                                            sheet1Cells, sheet2Cells, reconMoves);
      } catch (e2) {
        if (typeof console !== 'undefined' && console.error) {
          var invSug = sug.inverseDirection;
          var invPlyDbg = (invSug.action === 'insert') ? invSug.afterPly : (invSug.plies && invSug.plies[0]);
          console.error('🧭 NW _computeScoreDeltaForSug THREW on inverse ' +
            invSug.action + ' ' + invSug.nPlies + 'p @ply ' + invPlyDbg + ': ' +
            (e2 && e2.message ? e2.message : e2), e2 && e2.stack);
        }
      }
      if (invDelta) {
        sug.inverseDirection.preScore = invDelta.preScore;
        sug.inverseDirection.postScore = invDelta.postScore;
        sug.inverseDirection.scoreDelta = invDelta.scoreDelta;
        sug.inverseDirection.rawScoreDelta = invDelta.rawScoreDelta;
        sug.inverseDirection.preCells = invDelta.preCells;
        sug.inverseDirection.postCells = invDelta.postCells;
        sug.inverseDirection.preIllegals = invDelta.preIllegals;
        sug.inverseDirection.postIllegals = invDelta.postIllegals;
        sug.inverseDirection.legalityPenalty = invDelta.legalityPenalty;
        sug.inverseDirection.endStatePenalty = invDelta.endStatePenalty;
        sug.inverseDirection.endStateCellsTested = invDelta.endStateCellsTested;
        sug.inverseDirection.pieceImpSelf = invDelta.pieceImpSelf;
        sug.inverseDirection.pieceImpOther = invDelta.pieceImpOther;
        sug.inverseDirection.piecePresenceAdj = invDelta.piecePresenceAdj;
        sug.inverseDirection.cleanFenSrc = invDelta.cleanFenSrc;
      } else if (typeof console !== 'undefined' && console.warn) {
        var invSug2 = sug.inverseDirection;
        var invPlyDbg2 = (invSug2.action === 'insert') ? invSug2.afterPly : (invSug2.plies && invSug2.plies[0]);
        console.warn('🧭 NW _computeScoreDeltaForSug returned null/undefined on inverse ' +
          invSug2.action + ' ' + invSug2.nPlies + 'p @ply ' + invPlyDbg2 +
          ' — scoreDelta will be missing on swap target');
      }
      // Keep the cross-link symmetric after both sides have score info.
      sug.inverseDirection.inverseDirection = sug;
    }

    // Direction rule. Priority order:
    //   1) Truncated-SAN on delete side → always delete (catches "Nx-style
    //      write errors" — d2f9904 rationale)
    //   2) Higher scoreDelta wins. With the verified-FEN gate now holding
    //      banners until reconstruction has confirmed the gap's pre-edge,
    //      scoreDelta carries real legality + piece-presence signal grounded
    //      in chess truth. User explicitly asked to "show the direction with
    //      the higher score first" once direction selection became reliable.
    //   3) When scoreDelta is unavailable or tied (within 0.05pp tolerance),
    //      fall back to insert-default (d2f9904's structural prior).
    //
    // Previous rule was insert-default unless truncated-SAN. That made sense
    // when scoring was unreliable (deferred / drift-confounded), but now the
    // gate ensures we only see scored suggestions when scoring is real, so
    // we can trust it.
    if (sug.inverseDirection) {
      var primaryAct = sug.action;
      var inverseAct = sug.inverseDirection.action;
      if ((primaryAct === 'delete' && inverseAct === 'insert') ||
          (primaryAct === 'insert' && inverseAct === 'delete')) {
        var delSug = (primaryAct === 'delete') ? sug : sug.inverseDirection;
        var insSug = (primaryAct === 'insert') ? sug : sug.inverseDirection;
        var delSheet = (delSug.fromSheet === 's1') ? sheet1Cells : sheet2Cells;
        var truncated = false;
        if (delSug.plies && delSheet) {
          for (var ti = 0; ti < delSug.plies.length; ti++) {
            var ccc = delSheet[delSug.plies[ti]];
            if (ccc && _isSanTruncated(ccc.move)) { truncated = true; break; }
          }
        }
        var desired;
        var reason;
        var primaryDelta = sug.scoreDelta;
        var inverseDelta = sug.inverseDirection.scoreDelta;
        var bothScored = (typeof primaryDelta === 'number' &&
                          typeof inverseDelta === 'number');
        // Deferred scoring means legality + piece-presence haven't run yet —
        // the raw NW delta alone is not reliable enough to override the
        // insert-default structural prior. Fall back to insert-default even
        // when both deltas are numerically present. (Anti-flap guards can keep
        // a banner alive past the gap-proximity gate, so deferred scoring can
        // reach here; we must not trust it for direction selection.)
        var eitherDeferred = (
          (sug.cleanFenSrc && sug.cleanFenSrc.indexOf('deferred') === 0) ||
          (sug.inverseDirection.cleanFenSrc &&
           sug.inverseDirection.cleanFenSrc.indexOf('deferred') === 0));
        if (truncated) {
          desired = delSug;
          reason = 'truncated-SAN on delete side';
        } else if (bothScored && !eitherDeferred && Math.abs(primaryDelta - inverseDelta) > 0.05) {
          desired = (primaryDelta >= inverseDelta) ? sug : sug.inverseDirection;
          reason = 'higher scoreDelta (' + desired.scoreDelta.toFixed(2) +
                   ' vs ' + (desired === sug ? inverseDelta : primaryDelta).toFixed(2) + ')';
        } else {
          desired = insSug;
          reason = eitherDeferred ? 'insert-default (scoring deferred — will re-select once legality runs)'
                 : bothScored ? 'insert-default (scoreDelta tied)' : 'insert-default (scoreDelta missing)';
        }
        if (sug !== desired) {
          sug = desired;
        }
        if (typeof console !== 'undefined' && console.log) {
          var sheetLabel = sug.action === 'insert'
            ? (sug.onSheet === 's1' ? 'White' : 'Black')
            : (sug.fromSheet === 's1' ? 'White' : 'Black');
          console.log('🧭 NW direction rule: ' + sug.action +
            ' on ' + sheetLabel + ' (' + reason + ')');
        }
      }
    }

    return sug;
  }

  function detectNextAlignmentIssue(sheet1Cells, sheet2Cells, searchFrom, reconMoves) {
    searchFrom = searchFrom || 0;
    if (!sheet1Cells || !sheet2Cells) return null;

    var diag = { dup1: {}, dup2: {} };

    // SILENT-TAIL GUARD — when sheets differ substantially in length, one
    // player stopped writing well before the other. The asymmetry produces
    // spurious NW edits in two distinct ways:
    //   (a) the tail-length-mismatch branch (dropPly === null) contrives
    //       "delete from the longer sheet" suggestions to balance lengths;
    //   (b) Layer 1 succeeds in finding dropPly right at the boundary of the
    //       shorter sheet (where alts go empty), then Layer 3 NW finds
    //       plausible-looking gaps inside the diminishing alignment region —
    //       producing mid-game-looking suggestions whose AFTER preview
    //       shows the silent-tail moves (the user's "delete 49.W but
    //       preview shows 87-92" case).
    // Both are the wrong policy: the user's intent is for reconstruction
    // to use the single available sheet for the silent tail rather than
    // align them at all. Gate at the top so both paths are covered.
    //
    // Threshold tuned to distinguish legitimate structural edits (lenDiff
    // up to ~4 plies from a missing/duplicated move) from "one player
    // stopped." >6 plies of asymmetry = stopped writing.
    var lenDiff = Math.abs(sheet1Cells.length - sheet2Cells.length);
    var SILENT_TAIL_THRESHOLD = 6;
    if (lenDiff > SILENT_TAIL_THRESHOLD) {
      diag.silentTail = {
        lenDiff: lenDiff,
        threshold: SILENT_TAIL_THRESHOLD,
        shorterLen: Math.min(sheet1Cells.length, sheet2Cells.length),
        longerLen: Math.max(sheet1Cells.length, sheet2Cells.length)
      };
      detectNextAlignmentIssue.lastDiag = diag;
      return null;
    }

    // LAYER 1 — find first window where overlap drops below threshold.
    var dropPly = findOverlapDrop(sheet1Cells, sheet2Cells, searchFrom);
    diag.dropPly = dropPly;

    if (dropPly === null) {
      // Aligned on the prefix. If lengths differ within the silent-tail
      // threshold (1-6 plies), run NW on the whole tail to surface
      // legitimate single-move insert/delete cases.
      if (sheet1Cells.length !== sheet2Cells.length) {
        var tailStart = Math.max(0, searchFrom - 6);
        var s1Tail = sheet1Cells.slice(tailStart);
        var s2Tail = sheet2Cells.slice(tailStart);
        var tailAlign = localNeedlemanWunsch(s1Tail, s2Tail);
        var tailExtract = {};
        var tailSug = extractFirstSuggestion(tailAlign, s1Tail, s2Tail, tailStart, tailStart,
                                             undefined, tailExtract);
        diag.nw = _summarizeAlignment(tailAlign);
        diag.nwStart = tailStart;
        diag.extract = tailExtract.extract;
        // Run the same finalization (forward-sim safety, scoreDelta attach,
        // direction rule) as the LAYER 3 path so silent-tail suggestions
        // arrive at the banner with Δpp badges and consistent direction.
        // Without this, the picker can surface a silent-tail sug whose
        // scoreDelta is undefined, hiding the badge on both directions.
        tailSug = _attachScoresAndApplyDirectionRule(tailSug, sheet1Cells, sheet2Cells, searchFrom, diag, reconMoves);
        if (_isScoringDeferred(tailSug)) {
          diag.deferred = { src: tailSug.cleanFenSrc, sug: tailSug };
          detectNextAlignmentIssue.lastDiag = diag;
          return null;
        }
        detectNextAlignmentIssue.lastDiag = diag;
        return tailSug;
      }
      detectNextAlignmentIssue.lastDiag = diag;
      return null;
    }

    // LAYER 2 — duplicate detection near the drop point.
    var dup1 = findDuplicateNear(sheet1Cells, dropPly, 10, diag.dup1);
    if (dup1) {
      var c = sheet1Cells[dup1.deleteFrom];
      detectNextAlignmentIssue.lastDiag = diag;
      var dup1Sug = {
        action: 'delete_duplicate',
        fromSheet: 's1',
        nPlies: 2,
        plies: [dup1.deleteFrom, dup1.deleteFrom + 1],
        moveNum: c ? c.num : Math.floor(dup1.deleteFrom / 2) + 1,
        description: "White's sheet move " + (c ? c.num : '?') +
                     (dup1.bMatchType === 'structured'
                       ? ' is near-duplicated (W half identical, B half same piece+file)'
                       : ' is duplicated'),
        dupWScore: dup1.wScore,
        dupBScore: dup1.bScore,
        dupBMatchType: dup1.bMatchType || 'exact',
        dupBStructPF: dup1.bStructPF || 0,
        dupPrevMoveNum: c ? c.num - 1 : null
      };
      var dup1Delta = _computeScoreDeltaForSug(dup1Sug, sheet1Cells, sheet2Cells, reconMoves);
      if (dup1Delta) {
        dup1Sug.preScore = dup1Delta.preScore;
        dup1Sug.postScore = dup1Delta.postScore;
        dup1Sug.scoreDelta = dup1Delta.scoreDelta;
        dup1Sug.preCells = dup1Delta.preCells;
        dup1Sug.postCells = dup1Delta.postCells;
        dup1Sug.cleanFenSrc = dup1Delta.cleanFenSrc;
      }
      if (_isScoringDeferred(dup1Sug)) {
        diag.deferred = { src: dup1Sug.cleanFenSrc, sug: dup1Sug };
        return null;
      }
      return dup1Sug;
    }
    var dup2 = findDuplicateNear(sheet2Cells, dropPly, 10, diag.dup2);
    if (dup2) {
      var c2 = sheet2Cells[dup2.deleteFrom];
      detectNextAlignmentIssue.lastDiag = diag;
      var dup2Sug = {
        action: 'delete_duplicate',
        fromSheet: 's2',
        nPlies: 2,
        plies: [dup2.deleteFrom, dup2.deleteFrom + 1],
        moveNum: c2 ? c2.num : Math.floor(dup2.deleteFrom / 2) + 1,
        description: "Black's sheet move " + (c2 ? c2.num : '?') +
                     (dup2.bMatchType === 'structured'
                       ? ' is near-duplicated (W half identical, B half same piece+file)'
                       : ' is duplicated'),
        dupWScore: dup2.wScore,
        dupBScore: dup2.bScore,
        dupBMatchType: dup2.bMatchType || 'exact',
        dupBStructPF: dup2.bStructPF || 0,
        dupPrevMoveNum: c2 ? c2.num - 1 : null
      };
      var dup2Delta = _computeScoreDeltaForSug(dup2Sug, sheet1Cells, sheet2Cells, reconMoves);
      if (dup2Delta) {
        dup2Sug.preScore = dup2Delta.preScore;
        dup2Sug.postScore = dup2Delta.postScore;
        dup2Sug.scoreDelta = dup2Delta.scoreDelta;
        dup2Sug.preCells = dup2Delta.preCells;
        dup2Sug.postCells = dup2Delta.postCells;
        dup2Sug.cleanFenSrc = dup2Delta.cleanFenSrc;
      }
      if (_isScoringDeferred(dup2Sug)) {
        diag.deferred = { src: dup2Sug.cleanFenSrc, sug: dup2Sug };
        return null;
      }
      return dup2Sug;
    }

    // LAYER 3 — local NW around the drop.
    var nwStart = Math.max(0, dropPly - 6);
    var nwEndS1 = Math.min(dropPly + 20, sheet1Cells.length);
    var nwEndS2 = Math.min(dropPly + 20, sheet2Cells.length);
    var s1Slice = sheet1Cells.slice(nwStart, nwEndS1);
    var s2Slice = sheet2Cells.slice(nwStart, nwEndS2);
    var alignment = localNeedlemanWunsch(s1Slice, s2Slice);
    var extractDiag = {};
    var sug = extractFirstSuggestion(alignment, s1Slice, s2Slice, nwStart, nwStart,
                                     undefined, extractDiag);
    diag.nw = _summarizeAlignment(alignment);
    diag.nwStart = nwStart;
    diag.extract = extractDiag.extract;

    // Forward-sim safety check + scoreDelta attachment + direction rule.
    // Encapsulated in _attachScoresAndApplyDirectionRule so the silent-tail
    // path above can run the same logic. Returns null if the 1-ply safety
    // check suppressed the suggestion.
    sug = _attachScoresAndApplyDirectionRule(sug, sheet1Cells, sheet2Cells, searchFrom, diag, reconMoves);
    if (!sug) {
      detectNextAlignmentIssue.lastDiag = diag;
      return null;
    }
    // Gate: hold the suggestion silent until reconstruction has confirmed
    // the position before the gap. The user gets a fully-scored banner
    // when it surfaces, not a deferred-scoring placeholder. Once recon
    // advances past the gap's pre-edge, _runNWAlignmentCheck re-fires,
    // _buildVerifiedFen succeeds, and this gate releases.
    if (_isScoringDeferred(sug)) {
      diag.deferred = { src: sug.cleanFenSrc, sug: sug };
      detectNextAlignmentIssue.lastDiag = diag;
      return null;
    }
    // Diagnostic: which scoreDelta-derived fields ended up missing on the
    // primary suggestion. Triggers only when at least one is missing so the
    // console doesn't fill with no-op lines for healthy suggestions.
    if (typeof console !== 'undefined' && console.log) {
      var missingPrimary = [];
      if (typeof sug.scoreDelta !== 'number')  missingPrimary.push('scoreDelta');
      if (typeof sug.preCells !== 'number')    missingPrimary.push('preCells');
      if (typeof sug.preIllegals !== 'number') missingPrimary.push('preIllegals');
      if (typeof sug.pieceImpSelf !== 'number') missingPrimary.push('pieceImpSelf');
      if (missingPrimary.length) {
        var sugPlyDbg3 = (sug.action === 'insert') ? sug.afterPly : (sug.plies && sug.plies[0]);
        console.log('🧭 NW primary-fields-missing on ' + sug.action + ' ' +
          sug.nPlies + 'p @ply ' + sugPlyDbg3 + ': [' + missingPrimary.join(',') +
          '] (simBranch=' + !!(diag.simulation && typeof diag.simulation.scoreDelta === 'number') +
          ', ChessLoaded=' + (typeof Chess !== 'undefined') + ')');
      }
    }

    detectNextAlignmentIssue.lastDiag = diag;
    return sug;
  }

  // ---------------------------------------------------------------------------
  // ALIGNMENT SCORE — sum of match scores (pool-overlap adjusted) + gap
  // penalties. Same formula the internal DP uses, so the number returned
  // equals dp[n][m] from localNeedlemanWunsch. Needed for the score-delta
  // safety check: compare pre-edit vs post-edit alignment on the same
  // window, suppress the edit if it doesn't IMPROVE alignment quality.
  // ---------------------------------------------------------------------------

  function _alignmentScore(alignment, matchThreshold, gapPenalty) {
    if (matchThreshold === undefined) matchThreshold = 0.05;
    if (gapPenalty === undefined) gapPenalty = -0.3;
    var total = 0;
    for (var i = 0; i < alignment.length; i++) {
      var a = alignment[i];
      if (a.type === 'match') total += (a.score - matchThreshold);
      else total += gapPenalty;
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // CHESS-AWARE LEGALITY COUNT — walks a sheet through chess.js from ply 0,
  // tries each cell's primary OCR move (and alternatives), counts how many
  // moves in [simStart, simEnd) cannot be played. When a move fails, flips
  // the side-to-move and continues so cascading-illegality doesn't blow up
  // the count past the first error. Placeholders ('???' or empty) are
  // skipped (turn flipped) but not counted.
  //
  // Used by _computeScoreDeltaForSug to penalize NW edits that would make
  // the modified sheet's move sequence less playable — catches cases where
  // NW suggests deleting from the CORRECT sheet because the wrong sheet has
  // more cells. Example: white plays correctly, black mis-records; NW sees
  // black has spurious cells and suggests deleting from white. Without
  // legality awareness NW happily proposes the wrong direction. With it,
  // we observe that deleting white's legal moves increases illegal-count,
  // and the suggestion gets the correct sign.
  // ---------------------------------------------------------------------------

  function _flipTurn(chess) {
    try {
      var fen = chess.fen();
      var parts = fen.split(' ');
      if (parts.length < 4) return;
      parts[1] = (parts[1] === 'w') ? 'b' : 'w';
      parts[3] = '-';
      chess.load(parts.join(' '));
    } catch(e) {}
  }

  // Build a FEN representing the VERIFIED reconstructed game state up to
  // `throughPly`, by replaying state.moves through chess.js. Each entry in
  // `reconMoves` is { num, white, black, wStatus, bStatus } from the
  // reconstruction pipeline.
  //
  // Returns the FEN ONLY when reconstruction has VERIFIED moves all the way
  // through `throughPly`. Returns null otherwise — letting callers fall back
  // to _buildLocalCleanFen. Why this is critical: if reconstruction is stuck
  // at a stuck point BEFORE throughPly, the trailing entries are 'pending'
  // (post-stuck unverified) or missing. Walking past them either (a) flips
  // turn without advancing pieces (missing entries) or (b) plays a pending
  // SAN from the wrong drifted position that happens to coincidentally
  // succeed — both leave chess.js in a wrecked state. The legality walk
  // then counts every cell as illegal from that wrecked position, including
  // the legitimately correct backfilled placeholders, producing a +N
  // illegality penalty exactly equal to the number of placeholders.
  //
  // Verified = status ∈ {'ok', 'locked', 'fixed'} AND chess.move accepts it.
  // 'pending' and 'error' both disqualify; missing white/black disqualifies.
  function _buildVerifiedFen(reconMoves, throughPly) {
    if (typeof Chess === 'undefined') return null;
    if (throughPly <= 0) {
      try { return new Chess().fen(); } catch(e) { return null; }
    }
    if (!reconMoves || !reconMoves.length) return null;
    var chess;
    try { chess = new Chess(); } catch(e) { return null; }
    function _isVerifiedStatus(s) {
      return s === 'ok' || s === 'locked' || s === 'fixed';
    }
    // Diagnostic: track what stopped the walk so we can surface the latent
    // gate-bypass bug (user report: stuck at 39.W with illegal Rg2, but
    // _buildVerifiedFen reaches ply 87 and banner surfaces with real
    // legality numbers — which should be impossible if state.moves[38]
    // .wStatus === 'error'). Capture the last accepted ply and any halt
    // reason, log only on demand via _buildVerifiedFen.lastTrace.
    var lastAcceptedPly = -1;
    var haltReason = null;
    var haltAt = null;
    for (var i = 0; i < reconMoves.length; i++) {
      var m = reconMoves[i];
      if (!m) { haltReason = 'null-entry'; haltAt = i; break; }
      var wPly = (m.num - 1) * 2;
      if (wPly >= throughPly) {
        _buildVerifiedFen.lastTrace = { throughPly: throughPly, lastAcceptedPly: lastAcceptedPly,
          haltReason: 'reached-throughPly-at-wPly', haltAt: i, mNum: m.num, returned: 'fen' };
        return chess.fen();
      }
      if (!m.white) { haltReason = 'empty-white'; haltAt = i; break; }
      if (m.white === '???') { haltReason = 'placeholder-white'; haltAt = i; break; }
      if (!_isVerifiedStatus(m.wStatus)) {
        haltReason = 'unverified-wStatus:' + (m.wStatus || 'undef');
        haltAt = i;
        break;
      }
      try {
        if (!chess.move(m.white)) {
          haltReason = 'chess-rejects-white:' + m.white;
          haltAt = i;
          break;
        }
      } catch(e) {
        haltReason = 'chess-threw-white:' + m.white;
        haltAt = i;
        break;
      }
      lastAcceptedPly = wPly;
      var bPly = wPly + 1;
      if (bPly >= throughPly) {
        _buildVerifiedFen.lastTrace = { throughPly: throughPly, lastAcceptedPly: lastAcceptedPly,
          haltReason: 'reached-throughPly-at-bPly', haltAt: i, mNum: m.num, returned: 'fen' };
        return chess.fen();
      }
      if (!m.black) { haltReason = 'empty-black'; haltAt = i; break; }
      if (m.black === '???') { haltReason = 'placeholder-black'; haltAt = i; break; }
      if (!_isVerifiedStatus(m.bStatus)) {
        haltReason = 'unverified-bStatus:' + (m.bStatus || 'undef');
        haltAt = i;
        break;
      }
      try {
        if (!chess.move(m.black)) {
          haltReason = 'chess-rejects-black:' + m.black;
          haltAt = i;
          break;
        }
      } catch(e2) {
        haltReason = 'chess-threw-black:' + m.black;
        haltAt = i;
        break;
      }
      lastAcceptedPly = bPly;
    }
    // If we exhausted reconMoves (or hit the stuck-point move) but already
    // verified through throughPly-1, that IS sufficient — the FEN after
    // 54.B is ground truth when stuck at 55.W. No better info is coming.
    if (lastAcceptedPly >= throughPly - 1) {
      _buildVerifiedFen.lastTrace = { throughPly: throughPly, lastAcceptedPly: lastAcceptedPly,
        haltReason: haltReason || 'ran-out-of-moves', haltAt: haltAt, returned: 'fen-pre-edge' };
      return chess.fen();
    }
    _buildVerifiedFen.lastTrace = { throughPly: throughPly, lastAcceptedPly: lastAcceptedPly,
      haltReason: haltReason || 'ran-out-of-moves', haltAt: haltAt, returned: 'null' };
    return null;
  }

  // Build a FEN representing the BEST-EFFORT game state up to `throughIdx`
  // by playing best-of-both-sheets cell-by-cell. At each ply, picks the
  // higher-confidence sheet's primary SAN; falls back to OCR alternatives
  // and to the other sheet's content if needed. Cells where both fail
  // flip-turn-only (same fuzzy-play logic as _countIllegalsInRange).
  //
  // Used as FALLBACK when no reconstruction-verified moves are available
  // (e.g. early in the user's workflow before reconstruction has run, or
  // when state.moves isn't accessible). Prefer _buildVerifiedFen when
  // reconstruction state IS available — the OCR-only guess here can itself
  // accumulate drift over the 50+ plies it walks.
  function _buildLocalCleanFen(sheet1Cells, sheet2Cells, throughIdx) {
    if (typeof Chess === 'undefined') return null;
    var chess;
    try { chess = new Chess(); } catch(e) { return null; }
    if (throughIdx <= 0) return chess.fen();
    var maxLen = Math.max(
      sheet1Cells ? sheet1Cells.length : 0,
      sheet2Cells ? sheet2Cells.length : 0
    );
    var stopAt = Math.min(throughIdx, maxLen);
    for (var i = 0; i < stopAt; i++) {
      var c1 = (sheet1Cells && sheet1Cells[i]) || null;
      var c2 = (sheet2Cells && sheet2Cells[i]) || null;
      // Pick the more-confident sheet's cell as primary, keep the other as
      // a secondary fallback if both primary + its alts fail.
      var picked = null, alternate = null;
      if (c1 && c2) {
        var conf1 = (typeof c1.confidence === 'number') ? c1.confidence : 0.1;
        var conf2 = (typeof c2.confidence === 'number') ? c2.confidence : 0.1;
        if (conf2 > conf1) { picked = c2; alternate = c1; }
        else                { picked = c1; alternate = c2; }
      } else {
        picked = c1 || c2;
      }
      if (!picked || !picked.move || picked.move === '???') {
        _flipTurn(chess);
        continue;
      }
      var played = false;
      try { if (chess.move(picked.move)) played = true; } catch(e) {}
      if (!played && picked.alternatives && picked.alternatives.length) {
        for (var k = 0; k < picked.alternatives.length; k++) {
          var alt = picked.alternatives[k];
          var altSan = (typeof alt === 'string') ? alt : (alt && alt.move);
          if (!altSan || altSan === picked.move) continue;
          try { if (chess.move(altSan)) { played = true; break; } } catch(e) {}
        }
      }
      // Fall back to the alternate sheet's content if the primary one's
      // cell + all its alts failed. This is the key "cross-sheet repair"
      // that keeps the position synced even when one sheet has noise.
      if (!played && alternate && alternate.move && alternate.move !== '???') {
        try { if (chess.move(alternate.move)) played = true; } catch(e) {}
        if (!played && alternate.alternatives && alternate.alternatives.length) {
          for (var k2 = 0; k2 < alternate.alternatives.length; k2++) {
            var alt2 = alternate.alternatives[k2];
            var altSan2 = (typeof alt2 === 'string') ? alt2 : (alt2 && alt2.move);
            if (!altSan2 || altSan2 === alternate.move) continue;
            try { if (chess.move(altSan2)) { played = true; break; } } catch(e) {}
          }
        }
      }
      if (!played) _flipTurn(chess);
    }
    return chess.fen();
  }

  // Optional `startFen` + `startIdx` seed the walker with a non-default
  // position and skip the cells in [0, startIdx). Used by _computeScoreDeltaForSug
  // to seed near-the-gap walks with a clean position computed via
  // _buildLocalCleanFen — eliminates the upstream-drift problem where a
  // single illegal at ply 12 corrupts every illegal-count comparison through
  // the rest of the game.
  function _countIllegalsInRange(cells, simStart, simEnd, startFen, startIdx) {
    if (typeof Chess === 'undefined') return null;
    if (!cells || !cells.length) return 0;
    var chess;
    try {
      chess = new Chess();
      if (startFen) chess.load(startFen);
    } catch(e) { return null; }

    var beginIdx = (typeof startIdx === 'number' && startIdx > 0) ? startIdx : 0;
    var endIdx = Math.min(simEnd, cells.length);
    if (endIdx <= beginIdx) {
      _countIllegalsInRange.lastTrace = { range: [beginIdx, endIdx], simStart: simStart,
        played: [], illegal: [], skipped: [], total: 0 };
      return 0;
    }
    var illegalCount = 0;
    // Diagnostic trace — capture per-cell what happened, exposed via
    // _countIllegalsInRange.lastTrace so the caller can dump a detailed
    // illegal-list to the console. User can then see exactly which cells
    // contributed to the 7 / 9 / 11 etc. counts in the banner.
    var trace = { range: [beginIdx, endIdx], simStart: simStart,
                  played: [], illegal: [], skipped: [], total: 0 };

    function _plyLabel(idx) {
      var moveNum = Math.floor(idx / 2) + 1;
      var color = idx % 2 === 0 ? 'W' : 'B';
      return moveNum + '.' + color;
    }

    for (var i = beginIdx; i < endIdx; i++) {
      var cell = cells[i];
      var san = cell && cell.move;

      if (!san || san === '???') {
        // Placeholder — skip without counting, advance side-to-move so
        // subsequent cells get checked from the right turn.
        _flipTurn(chess);
        trace.skipped.push({ idx: i, label: _plyLabel(i), reason: 'placeholder' });
        continue;
      }

      var playedOk = false;
      var playedWith = null;
      try { if (chess.move(san)) { playedOk = true; playedWith = san; } } catch(e) {}

      // Try OCR alternatives if primary failed — gives the sheet the
      // benefit of the doubt for OCR-recognition errors (the cell could
      // legitimately be any of its candidates). This is NOT about picking
      // the "right" move, just about answering "is at least one OCR-
      // suggested move legal here?".
      var triedAlts = [];
      if (!playedOk && cell && cell.alternatives && cell.alternatives.length) {
        for (var k = 0; k < cell.alternatives.length; k++) {
          var alt = cell.alternatives[k];
          var altSan = (typeof alt === 'string') ? alt : (alt && alt.move);
          if (!altSan || altSan === san) continue;
          triedAlts.push(altSan);
          try { if (chess.move(altSan)) { playedOk = true; playedWith = altSan; break; } } catch(e) {}
        }
      }

      if (playedOk) {
        trace.played.push({ idx: i, label: _plyLabel(i), san: san,
          playedWith: playedWith, viaAlt: playedWith !== san });
      } else {
        if (i >= simStart) illegalCount++;
        _flipTurn(chess);
        trace.illegal.push({ idx: i, label: _plyLabel(i), san: san,
          alts: triedAlts, counted: (i >= simStart),
          backfilled: !!(cell && cell._backfilled) });
      }
    }
    trace.total = illegalCount;
    _countIllegalsInRange.lastTrace = trace;
    return illegalCount;
  }

  // Each illegal move on the modified sheet costs this much raw NW score.
  // Scale calibrated against _alignmentScore: a match contributes up to
  // +0.95, a gap costs -0.3. 0.3 means "one new illegal is roughly as bad
  // as introducing one fresh gap"; large enough to flip a borderline
  // direction decision (delta ±1pp territory) but not so large that one
  // false-positive illegal-flag overwhelms genuine NW signal.
  var LEGALITY_PENALTY_PER_MOVE = 0.3;

  // Cap on the absolute |postIllegals - preIllegals| that feeds the score.
  // A fully-corrupted sheet (Black-is-a-mess case) can produce double-digit
  // illegal counts; without a cap, the legality term then dominates raw NW
  // and the direction is decided entirely by which sheet happened to be
  // dirtier. ±5 means the legality term saturates at ±1.5 raw NW units,
  // which is enough to flip a tied raw NW decision but not enough to
  // override a clear NW signal (|raw Δ| > 2).
  var LEGALITY_DELTA_CAP = 5;

  // Number of cells AFTER the gap to include in the legality count window.
  // The walk seeds at gap_pre_edge (verified state) and walks forward; the
  // count window is then [gapStartPly, gapStartPly + nPlies + LEG_BUFFER).
  //
  // Why narrow? Wider windows let downstream cells on the BROKEN sheet
  // (which is why we're modifying it) inflate the post-INSERT illegal
  // count, biasing direction selection toward DELETE — even when INSERT is
  // the correct fix. User-caught case (43.B-45.W 4-ply insert): White's
  // sheet has "Q1 Rx Rx" garbage at the gap and misaligned content
  // downstream. Wide window counted the misaligned downstream as +N illegals
  // on INSERT POST (correct from a "modified sheet plays" standpoint, but
  // misleading because the misalignment is exactly what INSERT is fixing).
  //
  // Why not zero? Buffer=0 gives a single-cell-window for 1-ply edits which
  // is too noisy. Buffer=2 means the walk also tests the 1-2 cells right
  // after the gap, catching transition failures where the edit shifts
  // cells into incompatible positions. Both PRE and POST use the same
  // buffer so the comparison stays apples-to-apples.
  var LEGALITY_GAP_BUFFER = 2;

  // Odd-ply edits (1, 3, 5 ply count) shift every downstream cell into the
  // wrong color column. Raw NW similarity is color-blind — "Nc3" is valid
  // SAN for either side — so the post-edit sheets can keep matching by
  // coincidence even when the edit is structurally wrong. Legality, by
  // contrast, sees color: an odd-ply edit asks half the downstream cells
  // to play in the wrong turn, which usually fails. Per-move legality
  // delta at 0.3 each can be overpowered by spurious NW string matches
  // (user case: 55.W 1-ply DELETE wins +2.53 raw NW vs INSERT +0.25 even
  // though DELETE leaves 3/3 downstream cells illegal).
  //
  // For odd-ply edits, end-state legality is the load-bearing signal: if
  // the post-edit walk leaves the merged game broken, the edit is
  // structurally wrong regardless of how well the OCR strings line up.
  // This penalty fires when the post-edit illegal rate is high (>= 50% of
  // tested cells AND >= 2 absolute), adding a penalty proportional to the
  // post-illegal count. The rate gate prevents false fires from a single
  // stray OCR-noise illegal downstream of an otherwise-correct edit.
  //
  // Even-ply edits (2, 4, ...) preserve color columns, so raw NW
  // similarity remains trustworthy there and this returns 0 — the three
  // canonical cases (43.B-45.W 4p INSERT, 54.B 2p INSERT, 56.W-56.B 2p
  // DELETE) are byte-identical to pre-change scoring.
  var ODD_PLY_END_STATE_PENALTY_PER_MOVE = 0.5;
  var ODD_PLY_END_STATE_RATE_THRESHOLD = 0.5;
  var ODD_PLY_END_STATE_MIN_COUNT = 2;
  var ODD_PLY_END_STATE_MIN_CELLS = 2;

  // Returns { penalty, cellsTested }. cellsTested is reported regardless of
  // whether the penalty fired (caller may want to surface it in the banner
  // to show why the gate did or didn't trigger). penalty is the raw NW
  // amount to SUBTRACT from the adjusted score delta — 0 when the gate
  // didn't fire (even-ply, sparse illegals, or insufficient cells tested).
  function _oddPlyEndStatePenalty(nPlies, postIllegals, postTrace) {
    var out = { penalty: 0, cellsTested: 0 };
    if (!postTrace) return out;
    var sStart = postTrace.simStart;
    var played = postTrace.played || [];
    for (var i = 0; i < played.length; i++) { if (played[i].idx >= sStart) out.cellsTested++; }
    var illegal = postTrace.illegal || [];
    for (var j = 0; j < illegal.length; j++) { if (illegal[j].counted) out.cellsTested++; }
    if (!nPlies || (nPlies % 2) === 0) return out;
    if (postIllegals == null || postIllegals < ODD_PLY_END_STATE_MIN_COUNT) return out;
    if (out.cellsTested < ODD_PLY_END_STATE_MIN_CELLS) return out;
    var rate = postIllegals / out.cellsTested;
    if (rate < ODD_PLY_END_STATE_RATE_THRESHOLD) return out;
    out.penalty = ODD_PLY_END_STATE_PENALTY_PER_MOVE * postIllegals;
    return out;
  }

  // Build a backfilled placeholder cell for the LEGALITY WALK ONLY.
  // The placeholder is filled with the other sheet's content at the same
  // absolute index — same logic as _renderPostApplyEvidence's AFTER preview.
  // This makes the legality walk measure the MERGED candidate's chess
  // validity (what the user would actually see after accepting the insert).
  //
  // Why this only feeds the legality walk and NOT the raw NW alignment:
  // raw NW is a structural similarity score. Backfilling a placeholder
  // with the source it was copied from would tautologically score it as
  // a perfect match against that source, inflating insert's raw NW by
  // ~1.0 per placeholder relative to delete. This was tried as one big
  // fix and regressed direction selection on the 56.W/56.B case: insert's
  // raw NW went +0.45 → +2.93 from pure backfill bonus, overwhelming the
  // chess legality signal that correctly pointed at delete. Keeping NW
  // honest (placeholders ARE gaps structurally) and using backfill only
  // for the legality walk decouples the two signals: NW asks "do the
  // sheets fit structurally?"; legality asks "does the merged game play?"
  //
  // Without backfill, _countIllegalsInRange skips '???' cells via
  // _flipTurn, so an insert with bare placeholders never gets a legality
  // reward or penalty. Delete, by contrast, just removes cells, so its
  // postIllegals naturally reflects the post-edit walk. That asymmetry
  // creates a structural bias toward delete on the legality term (delete
  // always earns the reward if any removed cell was illegal). Backfilling
  // closes that gap: insert now gets credit when the backfilled moves are
  // legal in context, and penalty when they're not. Both directions are
  // measured against the same merged-game target on the legality axis.
  function _buildBackfilledPlaceholder(otherSheet, idx) {
    if (otherSheet && idx >= 0 && idx < otherSheet.length) {
      var src = otherSheet[idx];
      if (src && src.move) {
        return {
          move: src.move,
          confidence: 0.0,
          alternatives: src.alternatives || [],
          _backfilled: true
        };
      }
    }
    return { move: '???', confidence: 0.0, alternatives: [] };
  }

  // ---------------------------------------------------------------------------
  // PIECE-PRESENCE — counts cells whose primary OCR (and alternatives) name
  // a piece type that doesn't exist on the board for the side to move. Coarser
  // than legality (only checks "do we have a B/N/R/Q somewhere?"), but much
  // more robust to chess.js position-drift from earlier OCR noise: even if the
  // simulated board has wandered far from reality, the inventory of pieces is
  // usually still approximately right. Fires especially in endgames after
  // captures/exchanges, exactly where players are most likely to misrecord.
  //
  // The signal we extract is per-sheet: how many cells in a window are
  // piece-impossible? Both pre and post are compared at the same window for
  // both sheets, then the edit's scoreDelta gets adjusted by
  //     (modifiedPieceImp - otherPieceImp) × PIECE_PRESENCE_WEIGHT
  // — reward edits that target the dirtier sheet (high modified, low other);
  // penalize edits that align the cleaner sheet to fit the dirtier one.
  // Mirror-symmetric across inverse direction: if delete-from-X gets +K,
  // insert-on-Y gets -K, so the primary/inverse comparison shifts by 2K.
  // ---------------------------------------------------------------------------

  function _sanPiece(san) {
    if (!san) return null;
    var c = san[0];
    if (c === 'O' || c === '0') return 'K';  // O-O / 0-0 castling
    if ('BNRQK'.indexOf(c) !== -1) return c;
    return 'P';  // pawn move (e4, exd5, etc.)
  }

  function _pieceCensus(chess) {
    var fen = chess.fen();
    var placement = fen.split(' ')[0];
    var w = {}, b = {};
    for (var i = 0; i < placement.length; i++) {
      var c = placement[i];
      if (c === '/' || (c >= '0' && c <= '9')) continue;
      if (c >= 'A' && c <= 'Z') w[c] = (w[c] || 0) + 1;
      else if (c >= 'a' && c <= 'z') b[c] = (b[c] || 0) + 1;
    }
    return { w: w, b: b };
  }

  function _piecePresent(census, side, pieceLetter) {
    if (!pieceLetter) return false;
    var bucket = census[side];
    if (!bucket) return false;
    var key = (side === 'w') ? pieceLetter : pieceLetter.toLowerCase();
    return (bucket[key] || 0) > 0;
  }

  // See _countIllegalsInRange — same optional clean-FEN seeding so the
  // piece census starts from a near-the-gap position rather than drifting
  // from move 1.
  function _countPieceImpossiblesInRange(cells, simStart, simEnd, startFen, startIdx) {
    if (typeof Chess === 'undefined') return null;
    if (!cells || !cells.length) return 0;
    var chess;
    try {
      chess = new Chess();
      if (startFen) chess.load(startFen);
    } catch(e) { return null; }

    var beginIdx = (typeof startIdx === 'number' && startIdx > 0) ? startIdx : 0;
    var endIdx = Math.min(simEnd, cells.length);
    if (endIdx <= beginIdx) return 0;
    var impCount = 0;

    for (var i = beginIdx; i < endIdx; i++) {
      var cell = cells[i];
      var san = cell && cell.move;

      if (!san || san === '???') { _flipTurn(chess); continue; }

      // Piece-presence check BEFORE attempting the move so the census
      // reflects the position about to be played, not after.
      var side = chess.turn();
      var census = _pieceCensus(chess);
      var anyPossible = false;
      var primaryPiece = _sanPiece(san);
      if (primaryPiece && _piecePresent(census, side, primaryPiece)) {
        anyPossible = true;
      }
      if (!anyPossible && cell.alternatives && cell.alternatives.length) {
        for (var k = 0; k < cell.alternatives.length; k++) {
          var alt = cell.alternatives[k];
          var altSan = (typeof alt === 'string') ? alt : (alt && alt.move);
          if (!altSan) continue;
          var altPiece = _sanPiece(altSan);
          if (altPiece && _piecePresent(census, side, altPiece)) {
            anyPossible = true; break;
          }
        }
      }
      if (!anyPossible && i >= simStart) impCount++;

      // Advance chess.js, same fuzzy-play logic as _countIllegalsInRange,
      // so the census stays roughly synced with the sheet's narrative.
      var playedOk = false;
      try { if (chess.move(san)) playedOk = true; } catch(e) {}
      if (!playedOk && cell.alternatives && cell.alternatives.length) {
        for (var k2 = 0; k2 < cell.alternatives.length; k2++) {
          var alt2 = cell.alternatives[k2];
          var altSan2 = (typeof alt2 === 'string') ? alt2 : (alt2 && alt2.move);
          if (!altSan2 || altSan2 === san) continue;
          try { if (chess.move(altSan2)) { playedOk = true; break; } } catch(e) {}
        }
      }
      if (!playedOk) _flipTurn(chess);
    }
    return impCount;
  }

  // Per-cell weight for piece-impossibility. Lighter than the illegal-move
  // weight (0.3) because piece-presence is a coarser binary signal and counts
  // can be larger per sheet (multiple bishop ghosts add up); 0.1 keeps the
  // total adjustment within ~1 raw NW unit even when the per-sheet difference
  // is 10+ cells, which is a meaningful but non-dominating tiebreaker.
  var PIECE_PRESENCE_WEIGHT = 0.1;

  // Compute piece-presence adjustment for a suggestion. Returns
  //   { selfImp, otherImp, adjustment }
  // where adjustment is "raw NW units to add to scoreDelta for THIS
  // direction." Inverse direction will receive the negation of this.
  function _piecePresenceAdjustment(modifiedIsS1, sheet1Cells, sheet2Cells,
                                     simStart, endOriginal, startFen, startIdx) {
    var self  = modifiedIsS1 ? sheet1Cells : sheet2Cells;
    var other = modifiedIsS1 ? sheet2Cells : sheet1Cells;
    var selfImp  = _countPieceImpossiblesInRange(self,  simStart, endOriginal, startFen, startIdx);
    var otherImp = _countPieceImpossiblesInRange(other, simStart, endOriginal, startFen, startIdx);
    if (selfImp === null || otherImp === null) {
      return { selfImp: selfImp, otherImp: otherImp, adjustment: 0 };
    }
    // Modify dirty sheet = positive (rewarded); modify clean sheet to match
    // dirty one = negative (penalized).
    return {
      selfImp: selfImp, otherImp: otherImp,
      adjustment: (selfImp - otherImp) * PIECE_PRESENCE_WEIGHT
    };
  }

  // Minimum score improvement required for an edit to pass the safety
  // check. Legitimate inserts/deletes save ≈ +0.25 per fixed ply (the
  // -0.3 gap penalty becomes a -0.05 placeholder mismatch, or the noise
  // cell that was costing -0.3 gap + downstream mismatches goes away).
  // Bogus edits either leave the score unchanged (delta ≈ 0) or degrade
  // it (delta < 0). Threshold 0.1 accepts clean improvements and rejects
  // no-ops and degradations. Tunable per game-data patterns.
  var SCORE_DELTA_MIN = 0.1;

  // ---------------------------------------------------------------------------
  // FORWARD SIMULATION — apply the candidate edit on copies, re-run NW
  // on a local window, and evaluate two safety signals:
  //   (1) REVERSE PROPOSAL — does the simulated NW propose the opposite
  //       edit near the same ply? (substitution thrash check).
  //   (2) SCORE DELTA — does the post-edit NW score BEAT the pre-edit
  //       NW score on the same window? A legitimate edit fills a gap
  //       (+0.25 per ply) or removes a noise cell (+big); a bogus edit
  //       breaks downstream matches (−1.9 per lost match) or just adds
  //       a pointless gap penalty (−0.3).
  // (2) catches cases (1) misses: when the "reverse" IS what NW would do
  // structurally but gets filtered by extractFirstSuggestion's anchor
  // gate. Score-delta reads the alignment directly.
  // ---------------------------------------------------------------------------

  function _simulateAndCheckReverse(sug, sheet1Cells, sheet2Cells, searchFrom, reconMoves) {
    var s1 = sheet1Cells.slice();
    var s2 = sheet2Cells.slice();
    var actionPly;
    if (sug.action === 'delete') {
      var sheetRef = (sug.fromSheet === 's1') ? s1 : s2;
      actionPly = sug.plies[0];
      sheetRef.splice(actionPly, 1);
      if (sug.fromSheet === 's1') s1 = sheetRef; else s2 = sheetRef;
    } else if (sug.action === 'insert') {
      var sheetRef2 = (sug.onSheet === 's1') ? s1 : s2;
      actionPly = sug.afterPly + 1;
      // BARE placeholder for the NW alignment: placeholders ARE structural
      // gaps in the modified sheet, and treating them as such keeps raw NW
      // an honest measurement (placeholders score 0 against any other cell).
      // Backfilling placeholders here would tautologically score them as
      // perfect matches against the source they were copied from, inflating
      // insert's raw NW by ~1.0 per placeholder vs delete — which biased
      // direction selection toward insert even when delete was correct.
      // The legality walk below uses a separate backfilled version.
      sheetRef2.splice(actionPly, 0, { move: '???', confidence: 0.0, alternatives: [] });
      if (sug.onSheet === 's1') s1 = sheetRef2; else s2 = sheetRef2;
    } else {
      return { isReversed: false, reason: 'unsupported_action' };
    }

    // Re-run a small local NW around the change point.
    var simStart = Math.max(0, actionPly - 6);
    var simEndS1 = Math.min(actionPly + 12, s1.length);
    var simEndS2 = Math.min(actionPly + 12, s2.length);
    var simS1 = s1.slice(simStart, simEndS1);
    var simS2 = s2.slice(simStart, simEndS2);
    var simAlign = localNeedlemanWunsch(simS1, simS2);
    var postScore = _alignmentScore(simAlign);
    var simExtract = {};
    var simSug = extractFirstSuggestion(simAlign, simS1, simS2, simStart, simStart,
                                        undefined, simExtract);

    // Pre-edit NW on the SAME window (anchored at the same simStart) so
    // the two scores are directly comparable. Window ends at the same
    // absolute ply boundary; the sheets just have ±1 cell depending on
    // whether the edit was an insert or delete.
    var preEndS1 = Math.min(actionPly + 12, sheet1Cells.length);
    var preEndS2 = Math.min(actionPly + 12, sheet2Cells.length);
    var preS1 = sheet1Cells.slice(simStart, preEndS1);
    var preS2 = sheet2Cells.slice(simStart, preEndS2);
    var preAlign = localNeedlemanWunsch(preS1, preS2);
    var preScore = _alignmentScore(preAlign);
    var rawScoreDelta = postScore - preScore;

    // Chess-aware legality on the modified sheet (mirror of the logic in
    // _computeScoreDeltaForSug). Without this, 1-ply edits route through
    // _simulateAndCheckReverse and never get illegal counts attached, so
    // the chess-aware evidence line silently goes missing on the primary
    // while the inverse (which always goes through _computeScoreDeltaForSug)
    // shows it. User caught this when a 1-ply delete had no legality row
    // but the 1-ply insert inverse did.
    var modifiedIsS1 = (sug.action === 'delete' && sug.fromSheet === 's1') ||
                       (sug.action === 'insert' && sug.onSheet === 's1');
    var deletedCount = (sug.action === 'delete') ? 1 : 0;
    var insertedCount = (sug.action === 'insert') ? 1 : 0;
    var endOriginal = actionPly + 12;
    var postWindowEnd = endOriginal - deletedCount + insertedCount;
    var preIllegals = null, postIllegals = null, legalityScale = 0;
    var pieceImpSelf = null, pieceImpOther = null, piecePresenceAdj = 0;
    var endStatePenalty = 0;
    var endStateCellsTested = 0;
    var postTrace1 = null;
    if (typeof Chess !== 'undefined') {
      var modifiedPre  = modifiedIsS1 ? sheet1Cells : sheet2Cells;
      var modifiedPost = modifiedIsS1 ? s1 : s2;
      // CLEAN-FEN seeding — same as _computeScoreDeltaForSug. See the
      // longer rationale there: builds a position close to the gap by
      // playing best-of-both-sheets up to simStart-2, so the legality walk
      // measures chess validity at the gap rather than accumulated drift
      // from move 1.
      var cleanStartIdx1ply = Math.max(0, simStart - 2);
      // Only seed from reconstruction-verified moves. No OCR-merge fallback —
      // see _computeScoreDeltaForSug for the rationale (drift-prone walks
      // pollute the legality signal). Defer scoring when verified is short.
      var gapStartPly1ply;
      if (sug.action === 'insert') {
        gapStartPly1ply = (typeof sug.afterPly === 'number' ? sug.afterPly : -1) + 1;
      } else if (sug.plies && sug.plies.length) {
        gapStartPly1ply = sug.plies[0];
      } else {
        gapStartPly1ply = cleanStartIdx1ply;
      }
      var cleanFen1ply = null;
      if (reconMoves && reconMoves.length) {
        var gapVerified1ply = _buildVerifiedFen(reconMoves, gapStartPly1ply);
        if (gapVerified1ply) {
          // Anchor the walk at gap_pre_edge (= gapStartPly) — see the longer
          // rationale in _computeScoreDeltaForSug. Was seeding at
          // cleanStartIdx1ply (= simStart - 2), which forced chess.js to play
          // through ~8 plies of the sheet's noisy OCR content to reach the
          // gap, leaving the board in a stale state by the time it got there
          // (verified user-fixes like 53.B Ke6 weren't reflected in the
          // chess board, so legal-via-alt moves at the gap failed).
          cleanFen1ply = gapVerified1ply;
          cleanStartIdx1ply = gapStartPly1ply;
        }
      }
      // For the legality walk only: replace the bare '???' placeholder
      // with the unmodified other sheet's content at that index. This
      // measures the chess validity of the MERGED CANDIDATE (the AFTER
      // preview's actual content), not bare placeholders that the walker
      // skips. Raw NW above measured structural alignment with bare
      // placeholders; legality measures merged-game validity with backfill.
      // Decoupling these two: raw NW asks "do the sheets fit structurally?";
      // legality asks "does the merged game play through chess.js?"
      var modifiedForLegality = modifiedPost;
      if (sug.action === 'insert') {
        var otherSheetLeg = modifiedIsS1 ? sheet2Cells : sheet1Cells;
        var phIdx = actionPly;
        var existing = modifiedPost[phIdx];
        if (existing && existing.move === '???') {
          modifiedForLegality = modifiedPost.slice();
          modifiedForLegality[phIdx] = _buildBackfilledPlaceholder(otherSheetLeg, phIdx);
        }
      }
      // Only score legality + piece-presence when cleanFen1ply is a verified
      // ground-truth FEN. With null we'd be walking from initial chess
      // position, polluting the signal.
      if (cleanFen1ply) {
        // Tight legality window — see LEGALITY_GAP_BUFFER for rationale.
        var legEndIdx1 = actionPly + 1 + LEGALITY_GAP_BUFFER;
        var legPreEnd1 = Math.min(endOriginal, legEndIdx1);
        var legPostEnd1 = Math.min(postWindowEnd, legEndIdx1);
        preIllegals  = _countIllegalsInRange(modifiedPre,         simStart, legPreEnd1,  cleanFen1ply, cleanStartIdx1ply);
        postIllegals = _countIllegalsInRange(modifiedForLegality, simStart, legPostEnd1, cleanFen1ply, cleanStartIdx1ply);
        postTrace1 = _countIllegalsInRange.lastTrace;
        if (preIllegals !== null && postIllegals !== null) {
          // Cap the delta so a fully-corrupted backfill (Black-is-a-mess
          // games) can't make legality dominate raw NW.
          var legDelta = postIllegals - preIllegals;
          if (legDelta > LEGALITY_DELTA_CAP)  legDelta = LEGALITY_DELTA_CAP;
          if (legDelta < -LEGALITY_DELTA_CAP) legDelta = -LEGALITY_DELTA_CAP;
          legalityScale = legDelta * LEGALITY_PENALTY_PER_MOVE;
        }
        var ppRes = _piecePresenceAdjustment(modifiedIsS1, sheet1Cells, sheet2Cells,
                                              simStart, endOriginal, cleanFen1ply, cleanStartIdx1ply);
        pieceImpSelf = ppRes.selfImp;
        pieceImpOther = ppRes.otherImp;
        piecePresenceAdj = ppRes.adjustment;
      }
    }
    // 1-ply edits are always odd, so the odd-ply end-state penalty is
    // unconditionally eligible to fire here (subject to the rate + min-count
    // gates inside the helper). See ODD_PLY_END_STATE_PENALTY_PER_MOVE.
    var espInfo1 = _oddPlyEndStatePenalty(1, postIllegals, postTrace1);
    endStatePenalty = espInfo1.penalty;
    endStateCellsTested = espInfo1.cellsTested;
    var scoreDelta = rawScoreDelta - legalityScale - endStatePenalty + piecePresenceAdj;

    // Reverse-proposal check (may be null if extractFirstSuggestion
    // filters it out on anchor strength).
    var isReversed = false;
    var simPly = null;
    if (simSug) {
      var sameSheet = (sug.action === 'delete' && simSug.action === 'insert' &&
                       sug.fromSheet === simSug.onSheet) ||
                      (sug.action === 'insert' && simSug.action === 'delete' &&
                       sug.onSheet === simSug.fromSheet);
      simPly = (simSug.action === 'insert') ? simSug.afterPly : simSug.plies[0];
      var nearBy = Math.abs(simPly - actionPly) <= 3;
      var sameSize = simSug.nPlies === 1;
      isReversed = sameSheet && nearBy && sameSize;
    }
    return {
      isReversed: isReversed,
      followUp: simSug ? (simSug.action + ' @ply ' + simPly + ' (' + simSug.nPlies + 'p)') : null,
      actionPly: actionPly,
      preScore: preScore,
      postScore: postScore,
      scoreDelta: scoreDelta,
      rawScoreDelta: rawScoreDelta,
      preIllegals: preIllegals,
      postIllegals: postIllegals,
      legalityPenalty: legalityScale,
      endStatePenalty: endStatePenalty,
      endStateCellsTested: endStateCellsTested,
      pieceImpSelf: pieceImpSelf,
      pieceImpOther: pieceImpOther,
      piecePresenceAdj: piecePresenceAdj,
      preCells: preAlign.length,
      postCells: simAlign.length
    };
  }

  // ---------------------------------------------------------------------------
  // SCORE DELTA — display-only metric for the suggestion banner. Same
  // window/scoring math as _simulateAndCheckReverse, but generalized for
  // multi-ply edits and stripped of the reverse-proposal check (which only
  // makes sense for 1-ply substitution thrash). Returns null on unsupported
  // actions.
  // ---------------------------------------------------------------------------

  function _computeScoreDeltaForSug(sug, sheet1Cells, sheet2Cells, reconMoves) {
    if (!sug) return null;
    var s1 = sheet1Cells.slice();
    var s2 = sheet2Cells.slice();
    var actionPly;
    // Track which sheet was modified and by how many cells, so the post
    // slice can be adjusted to span the SAME ORIGINAL ply range as the
    // pre slice. Previously both pre and post used the same slice
    // indices [simStart, actionPly+12), which was biased: a delete made
    // the post-slice "reach further downstream" (extra cells outside
    // the original window snuck in), and an insert "reached less far"
    // (cells past the window got squeezed out). User caught this:
    // raw Δ favored delete by ~1.3 over insert in a case where the
    // percentage deltas differed by only 1pp. Make both directions
    // span the same absolute pre-edit ply range so the comparison is
    // apples-to-apples.
    var modifiedIsS1 = false;
    var deletedCount = 0;
    var insertedCount = 0;

    if (sug.action === 'delete' || sug.action === 'delete_duplicate') {
      if (!sug.plies || !sug.plies.length) return null;
      var sheetRefDel = (sug.fromSheet === 's1') ? s1 : s2;
      // Delete in descending order so earlier indices stay valid.
      var sortedPlies = sug.plies.slice().sort(function(a, b) { return b - a; });
      actionPly = sug.plies[0];
      for (var di = 0; di < sortedPlies.length; di++) {
        sheetRefDel.splice(sortedPlies[di], 1);
      }
      if (sug.fromSheet === 's1') s1 = sheetRefDel; else s2 = sheetRefDel;
      modifiedIsS1 = (sug.fromSheet === 's1');
      deletedCount = sortedPlies.length;
    } else if (sug.action === 'insert') {
      var sheetRefIns = (sug.onSheet === 's1') ? s1 : s2;
      actionPly = sug.afterPly + 1;
      var nPlies = sug.nPlies || 1;
      var spliceArgs = [actionPly, 0];
      for (var ii = 0; ii < nPlies; ii++) {
        // BARE placeholders for the NW alignment: placeholders ARE structural
        // gaps in the modified sheet, and treating them as such keeps raw NW
        // honest. Backfilling here would tautologically score every
        // placeholder as a perfect match against the source it was copied
        // from, inflating insert's raw NW by ~1.0/ply — which biased
        // direction selection toward insert even when delete was correct
        // (user-flagged 56.W/56.B case where backfill boost overwhelmed the
        // legality signal). The legality walk below uses a separate
        // backfilled version, so chess validity of the merged candidate
        // still gets measured.
        spliceArgs.push({ move: '???', confidence: 0.0, alternatives: [] });
      }
      Array.prototype.splice.apply(sheetRefIns, spliceArgs);
      if (sug.onSheet === 's1') s1 = sheetRefIns; else s2 = sheetRefIns;
      modifiedIsS1 = (sug.onSheet === 's1');
      insertedCount = nPlies;
    } else {
      return null;
    }

    // Window center: prefer the suggestion's scoreWindowCenter (set by
    // extractFirstSuggestion so primary + inverse share the same center,
    // regardless of where their natural action plies happen to land).
    // Falls back to the action ply when not set (delete_duplicate and any
    // legacy caller path that doesn't go through extractFirstSuggestion).
    var windowCenter = (typeof sug.scoreWindowCenter === 'number')
                       ? sug.scoreWindowCenter : actionPly;
    // Window in PRE-edit absolute ply space: [simStart, endOriginal).
    var simStart = Math.max(0, windowCenter - 6);
    var endOriginal = windowCenter + 12;

    // PRE slice — same on both sheets, capped at original length.
    var preEnd1 = Math.min(endOriginal, sheet1Cells.length);
    var preEnd2 = Math.min(endOriginal, sheet2Cells.length);
    var preAlign = localNeedlemanWunsch(sheet1Cells.slice(simStart, preEnd1),
                                         sheet2Cells.slice(simStart, preEnd2));
    var preScore = _alignmentScore(preAlign);

    // POST slice — adjust the modified sheet's slice end so it covers the
    // same ORIGINAL ply range. Cells at original indices [simStart, endOriginal)
    // now live at post indices [simStart, endOriginal - deletedCount + insertedCount).
    // The unmodified sheet is unchanged.
    var postEnd1, postEnd2;
    if (modifiedIsS1) {
      postEnd1 = Math.min(endOriginal - deletedCount + insertedCount, s1.length);
      postEnd2 = preEnd2;
    } else {
      postEnd1 = preEnd1;
      postEnd2 = Math.min(endOriginal - deletedCount + insertedCount, s2.length);
    }
    var postAlign = localNeedlemanWunsch(s1.slice(simStart, postEnd1),
                                          s2.slice(simStart, postEnd2));
    var postScore = _alignmentScore(postAlign);

    // CHESS-AWARE LEGALITY: count illegal moves on the modified sheet
    // BEFORE and AFTER the edit, over the same original window. If the edit
    // removes/avoids illegal moves, illegalDelta < 0 (good — credit it).
    // If the edit introduces or shifts cells into illegal positions,
    // illegalDelta > 0 (bad — penalize). This catches the bishop-case
    // class of bugs where NW suggests deleting from the chess-consistent
    // sheet because the inconsistent sheet has more cells.
    //
    // Bounded window for the pre-side: only count illegals that fall in
    // the same absolute ply range we're scoring on, so the comparison
    // mirrors the NW score window. For the post-side, extend the window
    // to absorb the cell-count shift introduced by the edit.
    var legalityScale = 0;
    var endStatePenalty = 0;
    var endStateCellsTested = 0;
    var preIllegals = null, postIllegals = null;
    var pieceImpSelf = null, pieceImpOther = null, piecePresenceAdj = 0;
    var cleanStartIdx = 0, cleanFen = null;
    var cleanFenSrc = 'none';
    if (typeof Chess !== 'undefined') {
      var modifiedPre  = modifiedIsS1 ? sheet1Cells : sheet2Cells;
      var modifiedPost = modifiedIsS1 ? s1 : s2;
      var postWindowEnd = endOriginal - deletedCount + insertedCount;
      // CLEAN-FEN seeding: build a position close to the gap by playing the
      // best-of-both-sheets merge up to a few plies before simStart. Without
      // this, _countIllegalsInRange walks from move 1 and accumulates drift
      // from any upstream OCR-noise illegal — so the at-gap illegal count
      // reflects "how many moves chess.js failed since move 1" rather than
      // "is this candidate edit's content legal in the actual game state."
      // Both directions (pre and post) walk from the SAME clean FEN, so the
      // legality delta becomes a genuine apples-to-apples chess-meaningful
      // comparison rather than a tautology of which sheet shrunk.
      cleanStartIdx = Math.max(0, simStart - 2);
      // Legality + piece-presence MUST seed chess.js from a GROUND-TRUTH FEN
      // at cleanStartIdx. The only source of ground truth is reconstruction:
      // state.moves entries verified as 'ok'/'locked'/'fixed' through the
      // window's pre-edge are chess-legal by definition.
      //
      // No OCR-merge fallback. When reconstruction is stuck BEFORE the gap
      // (e.g. user stuck at move 39W while gap is at move 43B), walking
      // best-of-both-sheets from move 1 accumulates ~80 plies of drift and
      // puts chess.js in a wrong position by the time the walk hits the
      // edit window. The legality count then reflects "how broken is
      // chess.js's drifted state" not "is this candidate chess-legal" —
      // which is what we saw in user cases where the +N illegals exactly
      // matched the number of (correct) backfilled placeholders.
      //
      // Better: defer legality entirely when verified FEN is unavailable.
      // The alignment banner still surfaces — raw NW carries the structural
      // signal, the insert-default direction rule applies, and piece-presence
      // is similarly deferred (it also walks chess.js from cleanFen). Once
      // reconstruction advances past the gap's pre-edge, _runNWAlignmentCheck
      // re-fires (it re-fires on every revalidation), _buildVerifiedFen now
      // succeeds, and legality+piece-presence kick in with a perfect seed.
      // Compute the GAP'S START PLY — the first ply the user's edit touches.
      // For insert: afterPly + 1 (where the first placeholder lands).
      // For delete: plies[0] (first cell to remove).
      // For delete_duplicate: plies[0] (first cell of the duplicate pair).
      var gapStartPly;
      if (sug.action === 'insert') {
        gapStartPly = (typeof sug.afterPly === 'number' ? sug.afterPly : -1) + 1;
      } else if (sug.plies && sug.plies.length) {
        gapStartPly = sug.plies[0];
      } else {
        gapStartPly = cleanStartIdx;
      }
      // Gate: reconstruction must verify state ALL THE WAY to gapStartPly,
      // not just to cleanStartIdx. cleanStartIdx (= simStart - 2) is where
      // the walk's seed FEN sits; the walk then advances through plies
      // [cleanStartIdx, gapStartPly) using OCR cells before reaching the
      // edit window. If those cells are unverified (recon stuck before the
      // gap), the walk drifts even from a perfect seed — and the legality
      // count at the gap reflects that drift, not real chess validity.
      //
      // Previous bug: gate only checked cleanStartIdx. User stuck at 52.B
      // (ply 103), gap at 54.B (ply 107), cleanStartIdx = 99. Recon verified
      // through 102 covers cleanStartIdx but NOT the cells 103-107. Banner
      // surfaced "too early" with misleading legality numbers.
      cleanFen = null;
      if (reconMoves && reconMoves.length) {
        var gapVerified = _buildVerifiedFen(reconMoves, gapStartPly);
        if (gapVerified) {
          // Anchor the legality walk at gap_pre_edge (= gapStartPly) — the
          // last fully-verified ply before the gap. Use the verified
          // merged-game FEN directly as cleanFen, and bump cleanStartIdx
          // up to gapStartPly so the walk only plays cells AT and AFTER
          // the gap.
          //
          // Previously cleanStartIdx was simStart - 2 (~8 plies before
          // the gap), which forced the walk to play through 8+ cells of
          // the sheet's noisy OCR content before reaching the edit window.
          // Sheet cells that failed (Black's 52.B "Rd2", 53.W "Ra3",
          // 53.B "Kc6" — the user's pre-fix OCR) triggered _flipTurn,
          // which alternates side-to-move but DOESN'T update the board.
          // The chess.js board never saw the user's 53.B Ke6 fix (that
          // lives in state.moves, not in the sheet), so by the time the
          // walk stepped into the gap at idx 107, the Black king wasn't
          // on e6 — and Kd6 (the correct alt at 54.B from a king on e6)
          // failed because the king wasn't there. The walk reported 54.B
          // as illegal even with Kd6 in alts.
          //
          // Seeding at gap_pre_edge means chess.js loads the verified
          // state (with all user fixes applied) and the walk's first
          // played cell is the first cell AT the gap. Legal-via-alt
          // moves at the gap now succeed.
          //
          // Side effect: cells in [simStart, gapStartPly) are no longer
          // walked. Their legality is already settled by reconstruction
          // (they're in the verified region), so excluding them from the
          // count is correct — they have nothing to do with whether the
          // INSERT or DELETE edit improves chess validity.
          cleanFen = gapVerified;
          cleanStartIdx = gapStartPly;
          cleanFenSrc = 'verified';
          if (typeof console !== 'undefined' && console.log &&
              _buildVerifiedFen.lastTrace) {
            var trc = _buildVerifiedFen.lastTrace;
            console.log('🧭 NW verified-FEN PASSED for gap@' + gapStartPly +
              ': lastAcceptedPly=' + trc.lastAcceptedPly +
              ', haltReason=' + trc.haltReason +
              ', haltAt=' + trc.haltAt + ', returned=' + trc.returned);
          }
        } else {
          cleanFenSrc = 'deferred(gapNotVerified)';
        }
      } else {
        cleanFenSrc = 'deferred(noRecon)';
      }
      // For the legality walk only: replace bare '???' placeholders with
      // the unmodified other sheet's content at the same absolute index.
      // This measures the chess validity of the MERGED CANDIDATE (the
      // AFTER preview's actual content), not bare placeholders that the
      // walker skips. Raw NW above measured structural alignment with
      // bare placeholders; legality measures merged-game validity with
      // backfill. Decoupling: raw NW asks "do the sheets fit?"; legality
      // asks "does the merged game play through chess.js?"
      var modifiedForLegality = modifiedPost;
      if (sug.action === 'insert' && insertedCount > 0) {
        var otherSheetLeg2 = modifiedIsS1 ? sheet2Cells : sheet1Cells;
        modifiedForLegality = modifiedPost.slice();
        for (var li = 0; li < insertedCount; li++) {
          var phIdx2 = actionPly + li;
          var existing2 = modifiedForLegality[phIdx2];
          // Diagnostic: capture what's at the placeholder slot and what
          // the backfill source contains. User reported trace shows
          // backfilled placeholder at modified-index 108 with content
          // "Bc5+" + alts that look like the OTHER sheet's 55.B — but the
          // backfill should pull from sheet2Cells[phIdx2] (= Black's 55.W
          // "Ke8" per the BEFORE pane). Log both source and result so we
          // can confirm whether the bug is in the source array or in the
          // _buildBackfilledPlaceholder return value.
          if (typeof console !== 'undefined' && console.log) {
            var srcCell = otherSheetLeg2 && otherSheetLeg2[phIdx2];
            var altCnt = (srcCell && srcCell.alternatives) ? srcCell.alternatives.length : 0;
            var altStr = '';
            if (srcCell && srcCell.alternatives) {
              altStr = srcCell.alternatives.slice(0, 5).map(function(a) {
                return (typeof a === 'string') ? a : (a && a.move) || '?';
              }).join(',');
            }
            console.log('🧭 NW backfill phIdx=' + phIdx2 +
              ' existing=' + (existing2 ? '{move:"' + existing2.move + '"' +
                (existing2._backfilled ? ',BF' : '') + '}' : 'null') +
              ' source=' + (srcCell
                ? '{num:' + srcCell.num + ',color:' + srcCell.color +
                  ',move:"' + srcCell.move + '"' +
                  ',alts[' + altCnt + ']=[' + altStr + ']}'
                : 'null'));
          }
          if (existing2 && existing2.move === '???') {
            modifiedForLegality[phIdx2] =
              _buildBackfilledPlaceholder(otherSheetLeg2, phIdx2);
          }
        }
      }
      // Only score legality + piece-presence when cleanFen is a verified
      // ground-truth FEN. With cleanFen=null we'd be walking from initial
      // chess position, which is even more wrong than the OCR-merge fallback
      // we deliberately removed above.
      if (cleanFen) {
        // Tight legality window: [gapStartPly, gapStartPly + nPlies + buffer).
        // The walk seeds at the gap pre-edge (cleanStartIdx == gapStartPly
        // after the verified-FEN anchor fix), so this means we walk only the
        // gap cells + a small follow-up buffer. See LEGALITY_GAP_BUFFER.
        var legNPlies = Math.max(insertedCount, deletedCount, 1);
        var legEndIdx = actionPly + legNPlies + LEGALITY_GAP_BUFFER;
        var legPreEnd = Math.min(endOriginal, legEndIdx);
        var legPostEnd = Math.min(postWindowEnd, legEndIdx);
        preIllegals  = _countIllegalsInRange(modifiedPre,         simStart, legPreEnd,  cleanFen, cleanStartIdx);
        var preTrace = _countIllegalsInRange.lastTrace;
        postIllegals = _countIllegalsInRange(modifiedForLegality, simStart, legPostEnd, cleanFen, cleanStartIdx);
        var postTrace = _countIllegalsInRange.lastTrace;
        // Stash both traces on the sug so the caller (banner renderer or
        // user) can dump them to console without recomputing.
        sug._legalityPreTrace = preTrace;
        sug._legalityPostTrace = postTrace;
        // Per-cell console dump: only the ILLEGAL cells, with the alts that
        // were tried. User asked "which moves are included and which are
        // not?" — this answers it directly.
        if (typeof console !== 'undefined' && console.log) {
          var sheetLbl = (modifiedIsS1 ? 'White' : 'Black');
          var sugTagL = sug.action + (sug.nPlies ? sug.nPlies : '') + 'p ' + sheetLbl;
          if (preTrace && preTrace.illegal && preTrace.illegal.length) {
            var preCounted = preTrace.illegal.filter(function(x) { return x.counted; });
            var preStr = preCounted.map(function(x) {
              return x.label + ' "' + x.san + '"' +
                     (x.alts && x.alts.length ? ' alts=[' + x.alts.join(',') + ']' : '');
            }).join('; ');
            console.log('🧭 NW legality PRE  ' + sugTagL + ' (' + sheetLbl + " sheet, " +
                        preCounted.length + ' illegal): ' + preStr);
          }
          if (postTrace && postTrace.illegal && postTrace.illegal.length) {
            var postCounted = postTrace.illegal.filter(function(x) { return x.counted; });
            var postStr = postCounted.map(function(x) {
              return x.label + ' "' + x.san + '"' + (x.backfilled ? '*BF' : '') +
                     (x.alts && x.alts.length ? ' alts=[' + x.alts.join(',') + ']' : '');
            }).join('; ');
            console.log('🧭 NW legality POST ' + sugTagL + ' (' + sheetLbl + " sheet, " +
                        postCounted.length + ' illegal): ' + postStr +
                        '   [*BF = backfilled placeholder]');
          }
        }
        if (preIllegals !== null && postIllegals !== null) {
          // Negative legalityScale subtracted from postScore = penalty when
          // postIllegals > preIllegals; reward when postIllegals < preIllegals.
          // Cap the delta so a fully-corrupted backfill (Black-is-a-mess
          // games) can't make legality dominate raw NW.
          var legDelta2 = postIllegals - preIllegals;
          if (legDelta2 > LEGALITY_DELTA_CAP)  legDelta2 = LEGALITY_DELTA_CAP;
          if (legDelta2 < -LEGALITY_DELTA_CAP) legDelta2 = -LEGALITY_DELTA_CAP;
          legalityScale = legDelta2 * LEGALITY_PENALTY_PER_MOVE;
        }
        // Odd-ply end-state penalty — fires only when legNPlies is odd
        // (color-column-flipping edit) AND post-edit illegality is dense.
        // Returns 0 for even-ply edits; the three canonical cases
        // (43.B-45.W 4p INSERT, 54.B 2p INSERT, 56.W-56.B 2p DELETE) are
        // untouched. See ODD_PLY_END_STATE_PENALTY_PER_MOVE for full
        // rationale.
        var espInfo = _oddPlyEndStatePenalty(legNPlies, postIllegals, postTrace);
        endStatePenalty = espInfo.penalty;
        endStateCellsTested = espInfo.cellsTested;
        var ppRes = _piecePresenceAdjustment(modifiedIsS1, sheet1Cells, sheet2Cells,
                                              simStart, endOriginal, cleanFen, cleanStartIdx);
        pieceImpSelf = ppRes.selfImp;
        pieceImpOther = ppRes.otherImp;
        piecePresenceAdj = ppRes.adjustment;
      }
    }

    // Cell counts so callers can normalize raw NW scores to per-cell %.
    // Now well-defined: pre and post cover the same original ply range,
    // post differs only by the modified sheet's adjusted count.
    var adjustedScoreDelta = (postScore - preScore) - legalityScale - endStatePenalty + piecePresenceAdj;
    // Diagnostic trace: emit one line per call so we can confirm the function
    // is being invoked for the suggestions that appear in the banner, and
    // that the slice bounds + chess-aware adjustments are sensible. Look for
    // matching "🧭 NW _computeScoreDelta:" lines for the primary AND inverse
    // of a banner pair. If a banner is missing fields, we should see either
    // (a) no entry line at all (function never called), (b) an entry line
    // but with NaN/null values (computation went wrong), or (c) a normal
    // entry line, which would mean the values were dropped between here
    // and the banner.
    if (typeof console !== 'undefined' && console.log) {
      var pdbg = (sug.action === 'insert') ? sug.afterPly : sug.plies[0];
      console.log('🧭 NW _computeScoreDelta: ' + sug.action + ' ' + (sug.nPlies || '?') +
        'p @ply ' + pdbg +
        ' modS1=' + modifiedIsS1 +
        ' window=[' + simStart + ',' + endOriginal + ')' +
        ' cleanFrom=' + cleanStartIdx + ' src=' + cleanFenSrc + (cleanFen ? '' : '(failed)') +
        ' preCells=' + preAlign.length + ' postCells=' + postAlign.length +
        ' pre=' + preScore.toFixed(2) + ' post=' + postScore.toFixed(2) +
        ' rawΔ=' + (postScore - preScore).toFixed(2) +
        ' legΔ=' + (preIllegals === null ? 'n/a' : (preIllegals + '→' + postIllegals)) +
        ' legScale=' + legalityScale.toFixed(2) +
        ' endStatePen=' + endStatePenalty.toFixed(2) +
        ' ppAdj=' + piecePresenceAdj.toFixed(2) +
        ' adjΔ=' + adjustedScoreDelta.toFixed(2));
    }
    return {
      preScore: preScore, postScore: postScore,
      scoreDelta: adjustedScoreDelta,
      rawScoreDelta: postScore - preScore,
      preIllegals: preIllegals, postIllegals: postIllegals,
      legalityPenalty: legalityScale,
      endStatePenalty: endStatePenalty,
      endStateCellsTested: endStateCellsTested,
      pieceImpSelf: pieceImpSelf, pieceImpOther: pieceImpOther,
      piecePresenceAdj: piecePresenceAdj,
      preCells: preAlign.length, postCells: postAlign.length,
      cleanFenSrc: cleanFenSrc
    };
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  // Enumerate ALL pending alignment issues (approximate count). Each call
  // advances searchFrom past the previous suggestion; this does NOT
  // hypothetically apply any edit, so the enumerated list reflects the
  // CURRENT alignment as if every issue were independent. Good enough for
  // a UI count badge.
  function _sugKey(sug) {
    if (!sug) return '';
    var ply = (sug.action === 'insert') ? sug.afterPly : (sug.plies && sug.plies[0]);
    return [sug.action, sug.fromSheet || sug.onSheet, sug.nPlies, ply].join('|');
  }

  function enumerateAlignmentIssues(sheet1Cells, sheet2Cells, maxCount, reconMoves) {
    if (!maxCount) maxCount = 30;
    var out = [];
    var seen = {};
    if (!sheet1Cells || !sheet2Cells) return out;
    var sf = 0;
    for (var i = 0; i < maxCount; i++) {
      var sug = detectNextAlignmentIssue(sheet1Cells, sheet2Cells, sf, reconMoves);
      if (!sug) {
        // Mirror cascade behavior: if forward-sim suppressed the first
        // candidate, advance past it and try again. Otherwise we'd
        // undercount when an early sim-suppression hides downstream
        // structural issues.
        var diag = detectNextAlignmentIssue.lastDiag;
        if (diag && diag.suppressed) {
          var sup = diag.suppressed;
          var supPly = (sup.action === 'insert') ? sup.afterPly : sup.plies[0];
          var nextSfSim = Math.max(sf + 2, supPly + 2);
          if (nextSfSim <= sf) break;
          sf = nextSfSim;
          continue;
        }
        // Deferred (scoring not yet possible because reconstruction
        // hasn't confirmed the position before the gap) — advance past
        // and keep looking. The deferred gap itself is invisible to the
        // user until verifiable, but downstream gaps in already-verified
        // territory can still surface.
        if (diag && diag.deferred && diag.deferred.sug) {
          var defSug = diag.deferred.sug;
          var defPly = (defSug.action === 'insert')
            ? (defSug.afterPly + (defSug.nPlies || 1))
            : (defSug.plies[defSug.plies.length - 1]);
          var nextSfDef = Math.max(sf + 2, defPly + 2);
          if (nextSfDef <= sf) break;
          sf = nextSfDef;
          continue;
        }
        break;
      }
      // Dedupe — successive slices can re-find the same gap because the
      // NW slice extends backward of the drop point. Without dedup the
      // pending list shows phantom duplicates like ins2@54.W twice.
      var key = _sugKey(sug);
      if (!seen[key]) { seen[key] = true; out.push(sug); }
      var endPly = (sug.action === 'insert')
        ? (sug.afterPly + sug.nPlies + 4)
        : (sug.plies[sug.plies.length - 1] + 4);
      var nextSf = Math.max(sf + 2, endPly);
      if (nextSf <= sf) break;
      sf = nextSf;
    }
    return out;
  }

  window.SheetNWAlignment = {
    detectNextAlignmentIssue: detectNextAlignmentIssue,
    enumerateAlignmentIssues: enumerateAlignmentIssues,
    findOverlapDrop: findOverlapDrop,
    findDuplicateNear: findDuplicateNear,
    localNeedlemanWunsch: localNeedlemanWunsch,
    extractFirstSuggestion: extractFirstSuggestion,
    poolOverlap: poolOverlap,
    poolOverlapStructured: poolOverlapStructured,
    parseSan: _parseSan,
    buildVerifiedFen: _buildVerifiedFen
  };
})();
