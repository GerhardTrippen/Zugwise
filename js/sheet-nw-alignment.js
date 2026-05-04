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
      if (!bestPair || (wScore + bScore) > bestPair.combined) {
        bestPair = { i: i, w1Top: w1Top, wScore: wScore, bScore: bScore, combined: wScore + bScore };
      }
      if (wScore > 0.8 && bScore > 0.4) {
        if (diag) diag.duplicate = { hit: true, ply: i + 2, wScore: wScore, bScore: bScore };
        return { deleteFrom: i + 2, deleteTo: i + 4, wScore: wScore, bScore: bScore };
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

      var beforeAnchor = null;
      var bestBeforeScore = -Infinity;
      for (var jj = gapStart - 1; jj >= 0; jj--) {
        if (alignment[jj].type === 'match') {
          if (alignment[jj].score > bestBeforeScore) bestBeforeScore = alignment[jj].score;
          if (alignment[jj].score >= minAnchor) {
            beforeAnchor = alignment[jj];
            break;
          }
        }
      }
      var afterAnchor = null;
      var bestAfterScore = -Infinity;
      for (var jj2 = gapEnd + 1; jj2 < alignment.length; jj2++) {
        if (alignment[jj2].type === 'match') {
          if (alignment[jj2].score > bestAfterScore) bestAfterScore = alignment[jj2].score;
          if (alignment[jj2].score >= minAnchor) {
            afterAnchor = alignment[jj2];
            break;
          }
        }
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
      if (gapType === 'gap_s1') {
        // S2 has extra plies → insert on S1
        var afterPlyS1 = s1Offset + beforeAnchor.s1Idx;
        var s2Content = [];
        for (var jj4 = 0; jj4 < gapPlyIndices.length; jj4++) {
          var aEntry = alignment[gapPlyIndices[jj4]];
          var cell = s2Slice[aEntry.s2Idx];
          if (!cell) continue;
          s2Content.push({
            label: cell.num + '.' + (cell.color || 'w').toUpperCase(),
            topMove: _topMove(cell) || '???'
          });
        }
        return {
          action: 'insert',
          onSheet: 's1',
          nPlies: gapSize,
          afterPly: afterPlyS1,
          beforeScore: bScore,
          afterScore: aScore,
          s2Content: s2Content,
          beforeAnchorS1Ply: s1Offset + beforeAnchor.s1Idx,
          beforeAnchorS2Ply: s2Offset + beforeAnchor.s2Idx,
          afterAnchorS1Ply:  s1Offset + afterAnchor.s1Idx,
          afterAnchorS2Ply:  s2Offset + afterAnchor.s2Idx
        };
      } else {
        // S1 has extra plies → delete from S1. Plies may be NON-CONTIGUOUS
        // when the bridging logic skipped over a weak-match S1 cell.
        var plies = [];
        var labels = [];
        for (var jj5 = 0; jj5 < gapPlyIndices.length; jj5++) {
          var aEntry2 = alignment[gapPlyIndices[jj5]];
          var idx = s1Offset + aEntry2.s1Idx;
          var cell = s1Slice[aEntry2.s1Idx];
          plies.push(idx);
          labels.push({
            label: (cell ? cell.num + '.' + (cell.color || 'w').toUpperCase() : '?'),
            topMove: _topMove(cell) || '???'
          });
        }
        return {
          action: 'delete',
          fromSheet: 's1',
          nPlies: gapSize,
          plies: plies,
          labels: labels,
          beforeScore: bScore,
          afterScore: aScore,
          beforeAnchorS1Ply: s1Offset + beforeAnchor.s1Idx,
          beforeAnchorS2Ply: s2Offset + beforeAnchor.s2Idx,
          afterAnchorS1Ply:  s1Offset + afterAnchor.s1Idx,
          afterAnchorS2Ply:  s2Offset + afterAnchor.s2Idx
        };
      }
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

  function detectNextAlignmentIssue(sheet1Cells, sheet2Cells, searchFrom) {
    searchFrom = searchFrom || 0;
    if (!sheet1Cells || !sheet2Cells) return null;

    var diag = { dup1: {}, dup2: {} };

    // LAYER 1 — find first window where overlap drops below threshold.
    var dropPly = findOverlapDrop(sheet1Cells, sheet2Cells, searchFrom);
    diag.dropPly = dropPly;

    if (dropPly === null) {
      // Aligned on the prefix. If lengths differ, run NW on the whole tail.
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
        description: "White's sheet move " + (c ? c.num : '?') + ' is duplicated',
        dupWScore: dup1.wScore,
        dupBScore: dup1.bScore,
        dupPrevMoveNum: c ? c.num - 1 : null
      };
      var dup1Delta = _computeScoreDeltaForSug(dup1Sug, sheet1Cells, sheet2Cells);
      if (dup1Delta) {
        dup1Sug.preScore = dup1Delta.preScore;
        dup1Sug.postScore = dup1Delta.postScore;
        dup1Sug.scoreDelta = dup1Delta.scoreDelta;
        dup1Sug.preCells = dup1Delta.preCells;
        dup1Sug.postCells = dup1Delta.postCells;
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
        description: "Black's sheet move " + (c2 ? c2.num : '?') + ' is duplicated',
        dupWScore: dup2.wScore,
        dupBScore: dup2.bScore,
        dupPrevMoveNum: c2 ? c2.num - 1 : null
      };
      var dup2Delta = _computeScoreDeltaForSug(dup2Sug, sheet1Cells, sheet2Cells);
      if (dup2Delta) {
        dup2Sug.preScore = dup2Delta.preScore;
        dup2Sug.postScore = dup2Delta.postScore;
        dup2Sug.scoreDelta = dup2Delta.scoreDelta;
        dup2Sug.preCells = dup2Delta.preCells;
        dup2Sug.postCells = dup2Delta.postCells;
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

    // Forward-simulation safety check for 1-ply edits — these are the most
    // likely candidates for substitution-thrash (delete one, then on the
    // next pass insert one at the same spot, repeating). Two conditions
    // suppress:
    //   (a) REVERSE PROPOSAL — the NW pass on simulated sheets proposes
    //       the opposite 1-ply edit at approximately the same location
    //       (substitution masquerading as structural).
    //   (b) SCORE DELTA — applying the edit does NOT improve the NW
    //       alignment score on a local window. A legitimate insert fills
    //       a structural gap (saves gap penalty 0.3 → mismatch 0.05,
    //       delta ≈ +0.25 per missing ply); a legitimate delete removes a
    //       noise cell that was forcing misalignment (delta > 0). A bogus
    //       edit breaks existing downstream matches (b6==b6, Nxc6==Nxc6,
    //       Rxc6==Rxc6 in the user's 30.B case) and the delta is negative.
    //
    // (b) catches the case that (a) misses: when NW on the simulated
    // sheets WOULD route around the placeholder (finding the reverse
    // structurally), but the reverse proposal is filtered out by
    // extractFirstSuggestion's own anchor-strength gate. Score-delta
    // looks at the alignment directly, bypassing that gate.
    if (sug && sug.nPlies === 1 && (sug.action === 'insert' || sug.action === 'delete')) {
      var simResult = _simulateAndCheckReverse(sug, sheet1Cells, sheet2Cells, searchFrom);
      var suppressReason = null;
      if (simResult.isReversed) {
        suppressReason = 'reverse_proposal';
      } else if (typeof simResult.scoreDelta === 'number' &&
                 simResult.scoreDelta < SCORE_DELTA_MIN) {
        suppressReason = 'score_not_improved';
      }
      if (suppressReason) {
        simResult.suppressReason = suppressReason;
        diag.simulation = simResult;
        diag.suppressed = sug;
        detectNextAlignmentIssue.lastDiag = diag;
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

    // Attach score-delta info for the banner. For 1-ply edits that passed
    // the safety check, reuse simResult; for multi-ply or duplicate edits,
    // compute fresh.
    if (sug && (sug.action === 'insert' || sug.action === 'delete')) {
      if (diag.simulation && typeof diag.simulation.scoreDelta === 'number') {
        sug.preScore = diag.simulation.preScore;
        sug.postScore = diag.simulation.postScore;
        sug.scoreDelta = diag.simulation.scoreDelta;
        // simResult from _simulateAndCheckReverse also returns cell counts
        // when computed via _computeScoreDeltaForSug-style internals.
        if (typeof diag.simulation.preCells === 'number') sug.preCells = diag.simulation.preCells;
        if (typeof diag.simulation.postCells === 'number') sug.postCells = diag.simulation.postCells;
      } else {
        var deltaInfo = _computeScoreDeltaForSug(sug, sheet1Cells, sheet2Cells);
        if (deltaInfo) {
          sug.preScore = deltaInfo.preScore;
          sug.postScore = deltaInfo.postScore;
          sug.scoreDelta = deltaInfo.scoreDelta;
          sug.preCells = deltaInfo.preCells;
          sug.postCells = deltaInfo.postCells;
        }
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

  function _simulateAndCheckReverse(sug, sheet1Cells, sheet2Cells, searchFrom) {
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
    var scoreDelta = postScore - preScore;

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

  function _computeScoreDeltaForSug(sug, sheet1Cells, sheet2Cells) {
    if (!sug) return null;
    var s1 = sheet1Cells.slice();
    var s2 = sheet2Cells.slice();
    var actionPly;

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
    } else if (sug.action === 'insert') {
      var sheetRefIns = (sug.onSheet === 's1') ? s1 : s2;
      actionPly = sug.afterPly + 1;
      var nPlies = sug.nPlies || 1;
      var spliceArgs = [actionPly, 0];
      for (var ii = 0; ii < nPlies; ii++) {
        spliceArgs.push({ move: '???', confidence: 0.0, alternatives: [] });
      }
      Array.prototype.splice.apply(sheetRefIns, spliceArgs);
      if (sug.onSheet === 's1') s1 = sheetRefIns; else s2 = sheetRefIns;
    } else {
      return null;
    }

    var simStart = Math.max(0, actionPly - 6);
    var simEndS1 = Math.min(actionPly + 12, s1.length);
    var simEndS2 = Math.min(actionPly + 12, s2.length);
    var postAlign = localNeedlemanWunsch(s1.slice(simStart, simEndS1),
                                          s2.slice(simStart, simEndS2));
    var postScore = _alignmentScore(postAlign);

    var preEndS1 = Math.min(actionPly + 12, sheet1Cells.length);
    var preEndS2 = Math.min(actionPly + 12, sheet2Cells.length);
    var preAlign = localNeedlemanWunsch(sheet1Cells.slice(simStart, preEndS1),
                                         sheet2Cells.slice(simStart, preEndS2));
    var preScore = _alignmentScore(preAlign);

    // Cell counts so callers can normalize raw NW scores to per-cell %.
    return {
      preScore: preScore, postScore: postScore, scoreDelta: postScore - preScore,
      preCells: preAlign.length, postCells: postAlign.length
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

  function enumerateAlignmentIssues(sheet1Cells, sheet2Cells, maxCount) {
    if (!maxCount) maxCount = 30;
    var out = [];
    var seen = {};
    if (!sheet1Cells || !sheet2Cells) return out;
    var sf = 0;
    for (var i = 0; i < maxCount; i++) {
      var sug = detectNextAlignmentIssue(sheet1Cells, sheet2Cells, sf);
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
    parseSan: _parseSan
  };
})();
