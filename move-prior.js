/**
 * move-prior.js — the human move prior in the browser.
 *
 * Pairs with backend/move_prior/. The model reports what fraction of club
 * players played each legal move; it is a MEASUREMENT over a population, not an
 * opinion about the position, which is why CLAUDE.md permits it where the
 * removed piece-value signals are banned. See the W_PRIOR block in
 * fix_finding.py for the four conditions it has to satisfy.
 *
 * WHY THIS EXISTS AS A SEPARATE JS MODULE AT ALL. Python does the ranking —
 * that was settled in d61c66c, "one ranking path" — but the model cannot run
 * where the ranking runs. Pyodide has no torch, and it cannot call an async JS
 * ONNX session synchronously from Python. So the split is the same one the CTC
 * signal already uses: JS produces DATA, Python does the scoring. Here the data
 * is a table {ply: {san: logProb}}, which fix_finding.apply_prior_rescore
 * accepts directly as its dict form.
 *
 * THE ENCODING MUST MATCH backend/move_prior/encode.py EXACTLY. Not
 * approximately — a transposed plane or an unflipped square does not throw, it
 * just returns confident nonsense, and a ranking signal that is confidently
 * wrong is worse than one that is absent. test-move-prior-parity.js runs this
 * file under node against Python's own encoder for that reason; run it after
 * touching anything in planesFromFen or moveIndex.
 *
 * Layout, mirrored from encode.py:
 *    0-5    side-to-move pieces   P N B R Q K
 *    6-11   opponent pieces       P N B R Q K
 *    12-13  side-to-move castling  kingside, queenside
 *    14-15  opponent castling      kingside, queenside
 *    16     en-passant target square
 * The board is FLIPPED so the side to move always plays up the board, exactly
 * as lc0 and Maia do it, so there is no side-to-move plane.
 */
(function (root) {
  'use strict';

  var N_PLANES = 17;
  var N_SQUARES = 64;
  var PIECE_ORDER = ['p', 'n', 'b', 'r', 'q', 'k'];

  /** Mirror a square vertically (a1<->a8) — chess.square_mirror, inlined. */
  function flipSq(sq) { return sq ^ 56; }

  /** Algebraic ("e4") -> python-chess square index (0 = a1, 63 = h8). */
  function sqFromAlgebraic(s) {
    return (s.charCodeAt(1) - 49) * 8 + (s.charCodeAt(0) - 97);
  }

  /**
   * FEN -> Float32Array(17*64), the network's input for one position.
   *
   * Driven off the FEN string rather than a chess.js Board on purpose: the FEN
   * carries every field the encoding needs (placement, side to move, castling,
   * en passant) and it is the one representation that cannot drift with the
   * chess.js version. python-chess sets ep_square straight from the FEN field
   * without asking whether the capture is legal, so reading the field directly
   * is what matches — do NOT "improve" this by filtering on legality.
   */
  function planesFromFen(fen) {
    var parts = String(fen).trim().split(/\s+/);
    var placement = parts[0], stm = parts[1] || 'w';
    var castling = parts[2] || '-', ep = parts[3] || '-';
    var flip = (stm === 'b');
    var out = new Float32Array(N_PLANES * N_SQUARES);

    var rows = placement.split('/');
    for (var r = 0; r < rows.length; r++) {
      var rank = 7 - r;              // rows[0] is rank 8
      var file = 0;
      for (var i = 0; i < rows[r].length; i++) {
        var ch = rows[r][i];
        if (ch >= '1' && ch <= '8') { file += (ch.charCodeAt(0) - 48); continue; }
        var lower = ch.toLowerCase();
        var pi = PIECE_ORDER.indexOf(lower);
        if (pi >= 0) {
          var isWhite = (ch !== lower);
          var mine = (isWhite === (stm === 'w'));
          var sq = rank * 8 + file;
          if (flip) sq = flipSq(sq);
          out[(mine ? pi : 6 + pi) * N_SQUARES + sq] = 1;
        }
        file++;
      }
    }

    // Rights are listed side-to-move first, so the network never has to learn
    // "white's rights" and "black's rights" as separate concepts.
    var wk = castling.indexOf('K') >= 0, wq = castling.indexOf('Q') >= 0;
    var bk = castling.indexOf('k') >= 0, bq = castling.indexOf('q') >= 0;
    var rights = (stm === 'w') ? [wk, wq, bk, bq] : [bk, bq, wk, wq];
    for (var j = 0; j < 4; j++) {
      if (!rights[j]) continue;
      var base = (12 + j) * N_SQUARES;
      for (var s = 0; s < N_SQUARES; s++) out[base + s] = 1;
    }

    if (ep !== '-' && ep.length >= 2) {
      var esq = sqFromAlgebraic(ep);
      out[16 * N_SQUARES + (flip ? flipSq(esq) : esq)] = 1;
    }
    return out;
  }

  /** from*64 + to in the flipped frame — encode.py move_index. */
  function moveIndex(fromAlg, toAlg, blackToMove) {
    var f = sqFromAlgebraic(fromAlg), t = sqFromAlgebraic(toAlg);
    if (blackToMove) { f = flipSq(f); t = flipSq(t); }
    return f * 64 + t;
  }

  function stripSuffix(san) { return String(san).replace(/[+#]+$/, ''); }

  var session = null;
  var meta = null;
  var loadPromise = null;

  /**
   * Load the ONNX model once. Safe to call repeatedly; concurrent callers share
   * the same in-flight promise rather than creating two sessions.
   */
  function load(modelUrl, metaUrl) {
    if (session) return Promise.resolve(session);
    if (loadPromise) return loadPromise;
    loadPromise = (async function () {
      try {
        session = await ort.InferenceSession.create(modelUrl);
      } catch (e) {
        // Clear the memo before rethrowing. Leaving a REJECTED promise cached
        // means every later call — including the caller's fallback URL —
        // receives that same rejection and the model can never load, which
        // looks exactly like "the model does not exist".
        loadPromise = null;
        throw e;
      }
      if (metaUrl) {
        try { meta = await (await fetch(metaUrl)).json(); } catch (e) { meta = null; }
      }
      return session;
    })();
    return loadPromise;
  }

  function isLoaded() { return !!session; }
  function getMeta() { return meta; }

  /**
   * Score positions in ONE batched forward pass.
   *
   * entries: [{ply, fen}]  ->  {ply: {san: logProb}} over every LEGAL move.
   *
   * Every legal move is scored, not just a candidate list, because the browser
   * has to precompute before it knows which candidates the search will invent.
   * That costs nothing worth counting: ~35 moves a position, and the table is
   * plain JSON handed to Python once.
   *
   * Probabilities are renormalised over LEGAL moves only. That is what lc0
   * reports as P, and therefore what every corpus measurement behind W_PRIOR
   * was made with; softmaxing over all 4096 classes instead would leave mass on
   * illegal moves and make these numbers incomparable with those.
   */
  /**
   * The four FEN fields the network actually reads: placement, side to move,
   * castling, en passant. Keying the prior table by POSITION rather than by ply
   * is what lets one table serve every search path — a ply names a position
   * only relative to some move list, and each path has its own.
   *
   * The ep field is taken RAW, exactly as chess.js prints it (after any double
   * push, legal capture or not). That matches encode.py, which sets the plane
   * from python-chess's board.ep_square, and it is why fix_finding.position_key
   * must pass en_passant='fen' — python-chess's fen() DEFAULT prints '-' unless
   * the capture is legal, which would silently produce keys this never emits.
   */
  function positionKey(fen) {
    return String(fen).trim().split(/\s+/).slice(0, 4).join(' ');
  }

  async function scorePositions(entries) {
    var out = {};
    if (!session || !entries || !entries.length) return out;

    var batch = entries.length;
    var input = new Float32Array(batch * N_PLANES * N_SQUARES);
    for (var i = 0; i < batch; i++) {
      input.set(planesFromFen(entries[i].fen), i * N_PLANES * N_SQUARES);
    }
    var tensor = new ort.Tensor('float32', input, [batch, N_PLANES, 8, 8]);
    var res = await session.run({ planes: tensor });
    var logits = res.logits.data;         // [batch, 4096]

    for (var b = 0; b < batch; b++) {
      var entry = entries[b];
      var game = new Chess(entry.fen);
      var legal = game.moves({ verbose: true });
      if (!legal.length) { out[positionKey(entry.fen)] = {}; continue; }
      var blackToMove = (String(entry.fen).split(/\s+/)[1] === 'b');
      var off = b * 4096;

      // Gather WITH duplicates. Two promotions to the same square share a move
      // index (encode.py deliberately does not encode the promotion piece), and
      // torch's log_softmax over the per-legal-move vector counts that index
      // twice. Deduplicating here would renormalise differently from the
      // measurement.
      var vals = new Array(legal.length);
      var max = -Infinity;
      for (var k = 0; k < legal.length; k++) {
        var v = logits[off + moveIndex(legal[k].from, legal[k].to, blackToMove)];
        vals[k] = v;
        if (v > max) max = v;
      }
      var sum = 0;
      for (var k2 = 0; k2 < vals.length; k2++) sum += Math.exp(vals[k2] - max);
      var logZ = max + Math.log(sum);

      var table = {};
      for (var k3 = 0; k3 < legal.length; k3++) {
        var lp = vals[k3] - logZ;
        var san = legal[k3].san;
        table[san] = lp;
        // Also key without the check/mate suffix: fix SANs reaching Python are
        // canonicalised, but the panel and the algorithms do not always agree
        // about a trailing '+', and a missed key silently becomes an
        // abstention rather than a visible error.
        var bare = stripSuffix(san);
        if (bare !== san && table[bare] === undefined) table[bare] = lp;
      }
      out[positionKey(entry.fen)] = table;
    }
    return out;
  }

  /**
   * Build the ply window a fix search is about to need, and score it.
   *
   * sans: the current move list. Returns {positionKey: {san: logProb}} for every
   * ply in [from, to] whose position can be reconstructed. Keyed by position, so
   * merging two windows from different move lists is a cache fill, never a
   * conflict — the same position always carries the same entry.
   *
   * A window, rather than the exact plies, because the search decides where to
   * backtrack after this runs — the same reason the CTC sidecar ships a whole
   * sheet. A prefix that will not replay ends the window: the game is broken at
   * that point and no position after it is meaningful.
   */
  async function scoreWindow(sans, fromPly, toPly) {
    if (!session) return {};
    var game = new Chess();
    var entries = [];
    var limit = Math.min(toPly, sans.length);
    for (var ply = 0; ply <= limit; ply++) {
      if (ply >= fromPly) entries.push({ ply: ply, fen: game.fen() });
      if (ply === limit) break;
      var mv = game.move(sans[ply], { sloppy: true });
      if (!mv) break;   // broken prefix: nothing after this is a real position
    }
    return scorePositions(entries);
  }

  root.MovePrior = {
    load: load,
    isLoaded: isLoaded,
    getMeta: getMeta,
    scorePositions: scorePositions,
    scoreWindow: scoreWindow,
    positionKey: positionKey,
    // exported for the parity test — not part of the app-facing API
    _planesFromFen: planesFromFen,
    _moveIndex: moveIndex,
    N_PLANES: N_PLANES
  };
})(typeof self !== 'undefined' ? self : this);
