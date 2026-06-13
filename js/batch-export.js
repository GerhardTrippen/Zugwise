// =============================================================================
// batch-export.js — Round PGN export + error report CSV for batch mode
// =============================================================================
// Phase 4 of Batch Mode. Concatenates all verified games in a round into a
// single PGN file (ready for chess-results.com upload), and writes an
// accompanying CSV with per-game diagnostics (tier, fix count, overrides,
// time spent) for quality auditing.
//
// Module API:
//   BatchExport.generatePgn(game, moves, headers) -> string
//   BatchExport.exportRoundPgn(round, options)     -> Promise<{pgn, filename, count}>
//   BatchExport.exportErrorReportCsv(round, opts)  -> Promise<{csv, filename, count}>
//   BatchExport.saveText(content, filename, mime)  -> writes to folder or downloads
//
// Dependencies:
//   - BatchTournament.buildPgnHeaders  (optional; falls back to minimal headers)
//   - BatchGameList.batchState         (reads games, reconstructResults)
// =============================================================================

var BatchExport = (function() {
  'use strict';

  var PGN_SEVEN_TAG = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  // Note: no 'Board' tag — board number is embedded in the compound Round
  // ("R.B" form, PGN §9.5). Order roughly mirrors the ChessBase convention:
  // Section, ratings/IDs/titles, ECO, PlyCount, then Event* metadata.
  var PGN_OPTIONAL_TAGS = ['Section',
                           'WhiteElo', 'BlackElo',
                           'WhiteTitle', 'BlackTitle',
                           'WhiteCfcId', 'BlackCfcId',
                           'ECO', 'PlyCount',
                           'EventDate', 'EventType', 'EventRounds', 'EventCountry',
                           'Source', 'Termination'];

  // Termination tag value used for the incomplete-PGN export. Standard PGN
  // (§9.8.1) defines a small set of values (abandoned, normal, time forfeit,
  // unterminated, ...) — for our case "unterminated" is closest, but a more
  // descriptive custom value is preferable since most readers preserve the
  // raw string and a Zugwise-specific note tells the operator exactly why
  // the result is `*`.
  var TERMINATION_INCOMPLETE = 'Reconstruction incomplete (Zugwise)';

  // =========================================================================
  // PGN generation
  // =========================================================================

  /**
   * Generate a complete PGN string for one game.
   * @param {Object} game - Batch game entry (used for Result fallback + gameId)
   * @param {Array<string>} moves - Flat SAN list
   * @param {Object} headers - From BatchTournament.buildPgnHeaders (or hand-built)
   * @param {Object} [opts]
   * @param {string} [opts.endComment] - Inline {comment} placed before the
   *   result token. Used by the incomplete export to mark where
   *   reconstruction stopped, e.g. "Reconstruction stopped at ply N —
   *   review pending" or "No moves verified".
   * @returns {string}
   */
  function generatePgn(game, moves, headers, opts) {
    headers = headers || {};
    opts = opts || {};
    var safeMoves = Array.isArray(moves) ? moves : [];

    // Final guard for EVERY export path (round / incomplete / combined /
    // single-game / verified): a Zugwise PGN must never contain an illegal
    // move. Idempotent and a no-op on a genuinely legal game; only an
    // actually-illegal continuation gets trimmed. Callers that show a
    // "stopped at ply N" comment truncate first so their N stays accurate —
    // this is belt-and-suspenders for the verified path that doesn't.
    safeMoves = _truncateToLegalPrefix(safeMoves);

    // Local copy so we can inject computed tags (PlyCount) without mutating
    // the caller's headers object.
    var hdrs = {};
    Object.keys(headers).forEach(function(k) { hdrs[k] = headers[k]; });
    if (!hdrs.PlyCount && safeMoves.length > 0) {
      hdrs.PlyCount = String(safeMoves.length);
    }

    var lines = [];

    // Seven-tag roster in required order.
    PGN_SEVEN_TAG.forEach(function(tag) {
      lines.push('[' + tag + ' "' + _escapeHeader(hdrs[tag] || '?') + '"]');
    });

    // Optional tags (only if present).
    PGN_OPTIONAL_TAGS.forEach(function(tag) {
      if (hdrs[tag]) {
        lines.push('[' + tag + ' "' + _escapeHeader(hdrs[tag]) + '"]');
      }
    });

    // Always include Source if not already added above.
    if (!hdrs.Source) {
      lines.push('[Source "Zugwise (gerhardtrippen.github.io/Zugwise)"]');
    }

    lines.push('');

    // Move text — 5 full moves per line.
    var moveText = '';
    for (var i = 0; i < safeMoves.length; i += 2) {
      var moveNum = Math.floor(i / 2) + 1;
      moveText += moveNum + '. ' + safeMoves[i];
      if (safeMoves[i + 1]) moveText += ' ' + safeMoves[i + 1];
      moveText += ' ';
      if (moveNum % 5 === 0) moveText += '\n';
    }
    if (opts.endComment) {
      // Strip braces from user input — PGN comments cannot contain braces.
      moveText += '{' + String(opts.endComment).replace(/[{}]/g, '') + '} ';
    }
    moveText += hdrs.Result || '*';
    lines.push(moveText.trim());

    return lines.join('\n') + '\n';
  }

  function _escapeHeader(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Truncate a SAN list at the first move that cannot legally be played from
   * the initial position. The confirmed-prefix builders slice state.sans to
   * stuckPly, but when there's no stuck point they fall back to the FULL sans
   * length — and a polluted tail (post-stuck moves the validator accepted in a
   * stale line, or unreviewed algorithm output that leaked into sans) then
   * ships verbatim. That produced PGNs with genuinely illegal continuations,
   * e.g. B3 "...39.Qxf5+ d3 40.f4 O-O" where O-O is illegal 40 moves in, plus
   * a wrong "stopped at ply 84" comment.
   *
   * chess.js is the same engine the board / navigation already replays
   * state.sans through, so a legitimately reconstructed game passes untouched.
   * `sloppy:true` matches the known SAN-leniency gap (chess.js v0.12.0 strict
   * mode rejects some legal-but-lenient SANs python-chess accepts) so we don't
   * truncate a good game on notation alone — only genuinely illegal moves cut.
   * If chess.js isn't loaded, return the input unchanged (conservative).
   */
  function _truncateToLegalPrefix(sans) {
    if (!Array.isArray(sans) || sans.length === 0) return sans || [];
    if (typeof Chess === 'undefined') return sans;
    var chess;
    try { chess = new Chess(); } catch (e) { return sans; }
    // Re-emit chess.js's canonical SAN for each legal move so the exported
    // PGN always carries the check '+'/'#' and capture 'x' marks even when the
    // stored/locked SAN dropped them — e.g. a "Keep as-is" lock of OCR "Nd4"
    // for the canonical "Nd4+", or "Ra8" for "Rxa8+". Same move, canonical
    // notation (chess.js parsed exactly this move). Length matches the legal
    // prefix, so truncation semantics are unchanged.
    var canonical = [];
    for (var i = 0; i < sans.length; i++) {
      var mv = null;
      try { mv = chess.move(sans[i], { sloppy: true }); } catch (e) { mv = null; }
      if (!mv) {
        if (typeof console !== 'undefined') {
          console.warn('[BatchExport] Truncating PGN at ply ' + i +
                       ' — "' + sans[i] + '" is not legal from the running ' +
                       'position; dropped ' + (sans.length - i) +
                       ' trailing ply(s) to avoid an illegal export.');
        }
        return canonical;
      }
      canonical.push((mv && mv.san) ? mv.san : sans[i]);
    }
    return canonical;
  }

  // =========================================================================
  // Round PGN export
  // =========================================================================

  /**
   * Export all verified games in a round as a single PGN file.
   * Falls back to including any game that has a reconstructed result if there
   * are no strictly-verified games yet — the user can still export work in
   * progress for manual review.
   *
   * @param {number} [round] - Round number; defaults to batchState.selectedRound
   * @param {Object} [options] - {includeUnverified:false, tournamentData, site}
   * @returns {Promise<{pgn:string, filename:string, count:number, sections:Array}>}
   */
  async function exportRoundPgn(round, options) {
    options = options || {};
    var bgl = window.BatchGameList;
    if (!bgl || !bgl.batchState) {
      throw new Error('BatchGameList not available');
    }
    var bs = bgl.batchState;
    round = round != null ? round : bs.selectedRound;
    if (round == null) throw new Error('No round selected');

    var tournamentData = options.tournamentData ||
      (window._batchTournamentData || null);
    var includeUnverified = !!options.includeUnverified;

    // Collect games in this round, sorted by section then board.
    var games = [];
    var sections = {};
    bs.games.forEach(function(g) {
      if (g.round !== round) return;
      // Verified state comes from game-list status constants.
      var isVerified = (g.status === 'verified' || g.status === 'exported');
      var hasResult = !!(bs.reconstructResults && bs.reconstructResults[g.gameId] &&
                         bs.reconstructResults[g.gameId].picked);
      if (!isVerified && !(includeUnverified && hasResult)) return;
      games.push(g);
      if (g.section) sections[g.section] = true;
    });
    games.sort(function(a, b) {
      if ((a.section || '') !== (b.section || '')) {
        return (a.section || '').localeCompare(b.section || '');
      }
      return (a.board || 0) - (b.board || 0);
    });

    var pgns = [];
    games.forEach(function(g) {
      var moves = _movesForGame(g, bs);
      if (!moves || moves.length === 0) return;

      var headers = _headersForGame(g, tournamentData, options);
      pgns.push(generatePgn(g, moves, headers));
    });

    var filename = _buildRoundFilename(round, tournamentData, Object.keys(sections));
    var fullPgn = pgns.join('\n');

    return {
      pgn: fullPgn,
      filename: filename,
      count: pgns.length,
      sections: Object.keys(sections)
    };
  }

  /**
   * Export the round PGN and write it (File System Access API preferred).
   * Convenience wrapper that handles saving for the caller.
   * @returns {Promise<{count, filename, savedTo}>}
   */
  async function exportAndSaveRoundPgn(round, options) {
    var out = await exportRoundPgn(round, options);
    if (out.count === 0) {
      return { count: 0, filename: out.filename, savedTo: null };
    }
    var savedTo = await saveText(out.pgn, out.filename, 'application/x-chess-pgn');
    return { count: out.count, filename: out.filename, savedTo: savedTo };
  }

  // =========================================================================
  // Incomplete-game PGN export
  // =========================================================================

  /**
   * Export ALL non-verified games in the round into a `_incomplete.pgn` file.
   * The result is `*`, a `[Termination]` tag flags the file as WIP, and an
   * end-of-line comment tells the reader where reconstruction stopped.
   *
   * Games with confirmed moves: move list truncated to the user's confirmed
   * prefix (wStatus/bStatus === 'fixed' || 'locked'). Algorithm-staged but
   * unreviewed plies are dropped — shipping those produced nonsense PGNs
   * (repeated moves, impossible positions; see B7 incident).
   *
   * Games not yet loaded / processed: zero-move PGN — headers + Termination
   * + `{No moves verified} *`. The pairing metadata is already present so
   * the operator can fill in moves manually without starting from scratch.
   *
   * @param {number} [round] - Defaults to batchState.selectedRound
   * @param {Object} [options] - {tournamentData, site}
   * @returns {Promise<{pgn:string, filename:string, count:number}>}
   */
  async function exportRoundIncompletePgn(round, options) {
    options = options || {};
    var bgl = window.BatchGameList;
    if (!bgl || !bgl.batchState) {
      throw new Error('BatchGameList not available');
    }
    var bs = bgl.batchState;
    round = round != null ? round : bs.selectedRound;
    if (round == null) throw new Error('No round selected');

    var tournamentData = options.tournamentData ||
      (window._batchTournamentData || null);

    // Collect ALL non-verified games in this round. Header-only entries for
    // untouched games are intentional — the pairing metadata (names, ratings,
    // round, result) is already there so the operator can fill in moves
    // manually, rather than reconstructing from scratch.
    var games = [];
    var sections = {};
    bs.games.forEach(function(g) {
      if (g.round !== round) return;
      var isVerified = (g.status === 'verified' || g.status === 'exported');
      if (isVerified) return;
      games.push(g);
      if (g.section) sections[g.section] = true;
    });
    games.sort(function(a, b) {
      if ((a.section || '') !== (b.section || '')) {
        return (a.section || '').localeCompare(b.section || '');
      }
      return (a.board || 0) - (b.board || 0);
    });

    var pgns = [];
    games.forEach(function(g) {
      var moves = _confirmedPrefixForGame(g, bs);
      var headers = _headersForGame(g, tournamentData, options);

      // Add Termination to flag reconstruction as incomplete.
      // Keep the pairing result in Result — the TD recorded 1-0/0-1/½-½
      // regardless of whether we've reconstructed the moves yet. Only fall
      // back to '*' when no result is known (e.g. no tournament file loaded).
      var hdrs = {};
      Object.keys(headers).forEach(function(k) { hdrs[k] = headers[k]; });
      if (!hdrs.Result || hdrs.Result === '?') hdrs.Result = '*';
      hdrs.Termination = TERMINATION_INCOMPLETE;

      var endComment = (moves.length === 0)
        ? 'No moves verified — algorithm output not reviewed'
        : ('Reconstruction stopped at ply ' + moves.length + ' — review pending');

      pgns.push(generatePgn(g, moves, hdrs, { endComment: endComment }));
    });

    var filename = _buildRoundFilename(round, tournamentData, Object.keys(sections));
    filename = filename.replace(/\.pgn$/i, '_incomplete.pgn');
    var fullPgn = pgns.join('\n');

    return {
      pgn: fullPgn,
      filename: filename,
      count: pgns.length,
      sections: Object.keys(sections)
    };
  }

  async function exportAndSaveRoundIncompletePgn(round, options) {
    var out = await exportRoundIncompletePgn(round, options);
    if (out.count === 0) {
      return { count: 0, filename: out.filename, savedTo: null };
    }
    var savedTo = await saveText(out.pgn, out.filename, 'application/x-chess-pgn');
    return { count: out.count, filename: out.filename, savedTo: savedTo };
  }

  /**
   * Last-confirmed-prefix lookup. Walks state.moves for the
   * currently-loaded game; returns the prefix of state.sans up to and
   * including the highest ply with status 'fixed' or 'locked'. Returns
   * [] if the game isn't currently loaded (per-ply status only lives in
   * state.moves) or no plies have been confirmed.
   */
  function _confirmedPrefixForGame(game, bs) {
    var sans, stuckPly;

    if (game && game.gameId === bs.currentGameId) {
      // Currently loaded game — read live state.
      if (typeof state === 'undefined' || !state) return [];
      sans = Array.isArray(state.sans) ? state.sans : [];
      stuckPly = (state.stuckPly != null) ? state.stuckPly : sans.length;
    } else {
      // Non-current game — read from workingState saved on game-switch.
      var ws = game && game.workingState;
      if (!ws || !Array.isArray(ws.sans) || ws.sans.length === 0) return [];
      sans = ws.sans;
      stuckPly = (ws.stuckPly != null) ? ws.stuckPly : sans.length;
    }

    // Legality net: when stuckPly is null the slice is the full sans, which can
    // carry a polluted post-stuck tail. Never ship an illegal continuation.
    return _truncateToLegalPrefix(sans.slice(0, stuckPly));
  }

  // =========================================================================
  // Combined round export (single file: verified + incomplete)
  // =========================================================================

  /**
   * Export ALL games in a round into one PGN file.
   * Verified games appear first with their actual result.
   * Non-verified games follow with result=* and a [Termination] tag;
   * their move list is the confirmed prefix (stuckPly cutoff).
   *
   * @param {number} [round] - Defaults to batchState.selectedRound
   * @param {Object} [options] - {tournamentData, site}
   * @returns {Promise<{pgn, filename, count, verifiedCount, incompleteCount, sections}>}
   */
  async function exportRoundCombinedPgn(round, options) {
    options = options || {};
    var bgl = window.BatchGameList;
    if (!bgl || !bgl.batchState) throw new Error('BatchGameList not available');
    var bs = bgl.batchState;
    round = round != null ? round : bs.selectedRound;
    if (round == null) throw new Error('No round selected');

    var tournamentData = options.tournamentData || (window._batchTournamentData || null);

    var games = [];
    var sections = {};
    bs.games.forEach(function(g) {
      if (g.round !== round) return;
      games.push(g);
      if (g.section) sections[g.section] = true;
    });
    games.sort(function(a, b) {
      if ((a.section || '') !== (b.section || '')) {
        return (a.section || '').localeCompare(b.section || '');
      }
      return (a.board || 0) - (b.board || 0);
    });

    var pgns = [];
    var verifiedCount = 0;
    var incompleteCount = 0;

    games.forEach(function(g) {
      var isVerified = (g.status === 'verified' || g.status === 'exported');
      var headers = _headersForGame(g, tournamentData, options);

      if (isVerified) {
        var moves = _movesForGame(g, bs);
        pgns.push(generatePgn(g, moves, headers));
        verifiedCount++;
      } else {
        var confirmedMoves = _confirmedPrefixForGame(g, bs);
        var hdrs = {};
        Object.keys(headers).forEach(function(k) { hdrs[k] = headers[k]; });
        if (!hdrs.Result || hdrs.Result === '?') hdrs.Result = '*';
        hdrs.Termination = TERMINATION_INCOMPLETE;
        var endComment = (confirmedMoves.length === 0)
          ? 'No moves verified — algorithm output not reviewed'
          : 'Reconstruction stopped at ply ' + confirmedMoves.length + ' — review pending';
        pgns.push(generatePgn(g, confirmedMoves, hdrs, { endComment: endComment }));
        incompleteCount++;
      }
    });

    var filename = _buildRoundFilename(round, tournamentData, Object.keys(sections));
    return {
      pgn: pgns.join('\n'),
      filename: filename,
      count: pgns.length,
      verifiedCount: verifiedCount,
      incompleteCount: incompleteCount,
      sections: Object.keys(sections)
    };
  }

  async function exportAndSaveRoundCombinedPgn(round, options) {
    var out = await exportRoundCombinedPgn(round, options);
    if (out.count === 0) {
      return { count: 0, filename: out.filename, savedTo: null,
               verifiedCount: 0, incompleteCount: 0 };
    }
    var savedTo = await saveText(out.pgn, out.filename, 'application/x-chess-pgn');
    return {
      count: out.count,
      filename: out.filename,
      savedTo: savedTo,
      verifiedCount: out.verifiedCount,
      incompleteCount: out.incompleteCount
    };
  }

  // =========================================================================
  // Error report CSV
  // =========================================================================

  /**
   * Build a CSV report of reconstruction diagnostics for all games in a round.
   *
   * Columns:
   *   GameId, Section, Board, White, Black, Result, TotalMoves,
   *   OcrCells, AlgorithmFixes, UserOverrides, Confirmations, Keeps,
   *   ReviewEdits, SurfacedDecisions, ReviewSeconds, ReviewSessions,
   *   Tier, TriageReason, Status
   *
   * The operator-effort columns (Confirmations..ReviewSessions) are fed by
   * g.reviewStats, written by verification-ui.js as the user reviews:
   *   Confirmations    - algorithm fixes accepted as proposed (✓ → 'fixed')
   *   Keeps            - moves accepted as written (🔒 → 'locked')
   *   UserOverrides    - moves the user typed over the proposal
   *   ReviewEdits      - manual edits launched from review mode
   *   SurfacedDecisions- distinct plies the walkthrough presented
   *   ReviewSeconds    - wall-clock seconds in verification mode (all visits;
   *                      excludes interactive-mode work after exiting review,
   *                      so it is a lower bound on per-game attention)
   *   AttentionSeconds - seconds of hands-on attention while the game was
   *                      open, ANY mode (interaction-event timer with a 2-min
   *                      idle cutoff; batch-game-list.js _attentionTick).
   *                      Catches the interactive-mode work ReviewSeconds
   *                      misses; tighter, but still a lower bound.
   *   ReviewSessions   - number of verification entries for the game
   * Stats live in batchState (memory only) — export before reloading or
   * restarting batch processing.
   *
   * @param {number} [round] - Defaults to selectedRound
   * @param {Object} [options]
   * @returns {Promise<{csv:string, filename:string, count:number}>}
   */
  async function exportErrorReportCsv(round, options) {
    options = options || {};
    var bgl = window.BatchGameList;
    if (!bgl || !bgl.batchState) throw new Error('BatchGameList not available');
    var bs = bgl.batchState;
    round = round != null ? round : bs.selectedRound;
    if (round == null) throw new Error('No round selected');

    var tournamentData = options.tournamentData || window._batchTournamentData || null;

    var header = [
      'GameId', 'Section', 'Board', 'White', 'Black', 'Result',
      'TotalMoves', 'OcrCells', 'AlgorithmFixes', 'UserOverrides',
      'Confirmations', 'Keeps', 'ReviewEdits', 'SurfacedDecisions',
      'ReviewSeconds', 'AttentionSeconds', 'ReviewSessions',
      'Tier', 'TriageReason', 'Status'
    ];
    var lines = [header.join(',')];

    var games = [];
    bs.games.forEach(function(g) {
      if (g.round === round) games.push(g);
    });
    games.sort(function(a, b) { return (a.board || 0) - (b.board || 0); });

    games.forEach(function(g) {
      var rec = (bs.reconstructResults && bs.reconstructResults[g.gameId]) || {};
      var picked = rec.picked || null;
      var pairing = g.pairing || (tournamentData
        ? (window.BatchTournament && window.BatchTournament.matchGameToPairing(g, tournamentData))
        : null);

      // Prefer the ply count stamped at verification time (markVerified) —
      // it reflects the user-confirmed game. picked.result.moves is the
      // algorithm proposal and is gone for edit-only / post-requeue
      // completions (those rows used to report TotalMoves=0).
      var totalMoves = g.finalPlyCount ||
        (picked && picked.result && picked.result.moves
          ? picked.result.moves.length : 0);
      var algoFixes = picked && picked.result && picked.result.fixes
        ? picked.result.fixes.length : 0;
      var overrides = (rec.userOverrides && rec.userOverrides.length) ||
                      (g.userOverrides && g.userOverrides.length) || 0;
      var rs = g.reviewStats || {};

      var row = [
        g.gameId,
        g.section || '',
        g.board || '',
        (pairing && pairing.whiteName) || '',
        (pairing && pairing.blackName) || '',
        (pairing && pairing.result) || '',
        totalMoves,
        g.ocrCellCount || 0,
        algoFixes,
        overrides,
        rs.confirms || 0,
        rs.keeps || 0,
        rs.edits || 0,
        (rs.surfacedPlies && rs.surfacedPlies.length) || 0,
        rs.activeMs ? Math.round(rs.activeMs / 1000) : 0,
        g.attentionMs ? Math.round(g.attentionMs / 1000) : 0,
        rs.sessions || 0,
        g.tier || '',
        g.triageReason || '',
        g.status || ''
      ].map(_csvCell);
      lines.push(row.join(','));
    });

    var tournamentPart = tournamentData && tournamentData.event
      ? tournamentData.event.replace(/[^A-Za-z0-9_-]+/g, '_')
      : 'Tournament';
    var filename = tournamentPart + '_Round' + round + '_report.csv';

    return { csv: lines.join('\n') + '\n', filename: filename, count: games.length };
  }

  /**
   * Build the per-decision log CSV for a round — one row per operator
   * action recorded by verification-ui.js in g.reviewStats.decisions.
   *
   * This is the companion to the per-game report above: the report
   * aggregates effort into counters, this log preserves WHICH plies were
   * decided, what the OCR read, what the algorithm proposed, and what the
   * user finally accepted. From it one can rebuild OCR-vs-final confusion
   * tables (e.g. a foreign-notation scoresheet) and decision-latency
   * distributions offline.
   *
   * Columns:
   *   GameId, Board, Ply, Move, Action, OcrText, ProposedSan, FinalSan,
   *   Method, Session, TSec
   *     Ply      - 0-based ply index
   *     Move     - human label ("29.B")
   *     Action   - confirm | keep | override | edit (edit rows have
   *                FinalSan='' — the committed move lands in the PGN)
   *     Session  - which verification visit produced the row (1-based)
   *     TSec     - seconds since that session's entry
   * Like reviewStats, decisions are memory-only — export before reloading.
   *
   * @param {number} [round] - Defaults to selectedRound
   * @returns {Promise<{csv:string, filename:string, rowCount:number}>}
   */
  async function exportDecisionLogCsv(round, options) {
    options = options || {};
    var bgl = window.BatchGameList;
    if (!bgl || !bgl.batchState) throw new Error('BatchGameList not available');
    var bs = bgl.batchState;
    round = round != null ? round : bs.selectedRound;
    if (round == null) throw new Error('No round selected');

    var tournamentData = options.tournamentData || window._batchTournamentData || null;

    var header = [
      'GameId', 'Board', 'Ply', 'Move', 'Action',
      'OcrText', 'ProposedSan', 'FinalSan', 'Method', 'Session', 'TSec'
    ];
    var lines = [header.join(',')];
    var rowCount = 0;

    var games = [];
    bs.games.forEach(function(g) {
      if (g.round === round) games.push(g);
    });
    games.sort(function(a, b) { return (a.board || 0) - (b.board || 0); });

    games.forEach(function(g) {
      var decisions = (g.reviewStats && g.reviewStats.decisions) || [];
      decisions.forEach(function(d) {
        var moveLabel = (typeof d.ply === 'number')
          ? (Math.floor(d.ply / 2) + 1) + '.' + (d.ply % 2 === 0 ? 'W' : 'B')
          : '';
        var row = [
          g.gameId,
          g.board || '',
          (typeof d.ply === 'number') ? d.ply : '',
          moveLabel,
          d.action || '',
          d.ocr || '',
          d.proposed || '',
          d.finalSan || '',
          d.method || '',
          d.session || '',
          (d.tSec != null) ? d.tSec : ''
        ].map(_csvCell);
        lines.push(row.join(','));
        rowCount++;
      });
    });

    var tournamentPart = tournamentData && tournamentData.event
      ? tournamentData.event.replace(/[^A-Za-z0-9_-]+/g, '_')
      : 'Tournament';
    var filename = tournamentPart + '_Round' + round + '_decisions.csv';

    return { csv: lines.join('\n') + '\n', filename: filename, rowCount: rowCount };
  }

  async function exportAndSaveErrorCsv(round, options) {
    var out = await exportErrorReportCsv(round, options);
    var savedTo = await saveText(out.csv, out.filename, 'text/csv');
    // Companion per-decision log — only written when this session actually
    // recorded decisions (an empty file would just shadow a previous
    // session's real log on disk).
    var decisions = null;
    try {
      var dec = await exportDecisionLogCsv(round, options);
      if (dec.rowCount > 0) {
        var decSavedTo = await saveText(dec.csv, dec.filename, 'text/csv');
        decisions = { filename: dec.filename, count: dec.rowCount, savedTo: decSavedTo };
      }
    } catch (e) {
      console.warn('[BatchExport] decision log export failed:', e);
    }
    return { count: out.count, filename: out.filename, savedTo: savedTo,
             decisions: decisions };
  }

  // =========================================================================
  // Round bundle (PGN + CSV) — ZIP fallback when no folder handle available
  // =========================================================================

  /**
   * Export the round PGN plus the error CSV together. If a folder handle is
   * available, writes both as separate files (same as calling the two
   * functions individually). Otherwise bundles them into a single ZIP
   * download — much more ergonomic than multiple sequential downloads.
   *
   * @param {number} [round]
   * @param {Object} [options] - Passed through to each export
   * @returns {Promise<{savedTo:string, filename:string, files:Array}>}
   */
  async function exportRoundBundle(round, options) {
    options = options || {};
    var pgnOut = await exportRoundPgn(round, options);
    var csvOut = await exportErrorReportCsv(round, options);
    // Per-decision log rides along when any review decisions were recorded.
    var decOut = null;
    try {
      var _dec = await exportDecisionLogCsv(round, options);
      if (_dec.rowCount > 0) decOut = _dec;
    } catch (e) {
      console.warn('[BatchExport] decision log export failed:', e);
    }

    var bs = window.BatchGameList && window.BatchGameList.batchState;
    var folder = bs && bs.folderHandle;

    // If we have a folder, write separately — the user wants both files
    // visible in their scan directory, not stuffed in a ZIP.
    if (folder) {
      var savedPgn = pgnOut.count > 0
        ? await saveText(pgnOut.pgn, pgnOut.filename, 'application/x-chess-pgn')
        : null;
      var savedCsv = await saveText(csvOut.csv, csvOut.filename, 'text/csv');
      var outFiles = [
        { name: pgnOut.filename, savedTo: savedPgn, count: pgnOut.count },
        { name: csvOut.filename, savedTo: savedCsv, count: csvOut.count }
      ];
      if (decOut) {
        var savedDec = await saveText(decOut.csv, decOut.filename, 'text/csv');
        outFiles.push({ name: decOut.filename, savedTo: savedDec, count: decOut.rowCount });
      }
      return {
        savedTo: 'folder',
        filename: null,
        files: outFiles
      };
    }

    // No folder — bundle into a ZIP.
    if (!window.BatchZip) {
      // Degrade further: fall back to sequential downloads.
      if (pgnOut.count > 0) {
        await saveText(pgnOut.pgn, pgnOut.filename, 'application/x-chess-pgn');
      }
      await saveText(csvOut.csv, csvOut.filename, 'text/csv');
      if (decOut) await saveText(decOut.csv, decOut.filename, 'text/csv');
      return {
        savedTo: 'download',
        filename: null,
        files: [
          { name: pgnOut.filename, count: pgnOut.count },
          { name: csvOut.filename, count: csvOut.count }
        ]
      };
    }

    var files = [];
    if (pgnOut.count > 0) {
      files.push({ name: pgnOut.filename, content: pgnOut.pgn });
    }
    files.push({ name: csvOut.filename, content: csvOut.csv });
    if (decOut) files.push({ name: decOut.filename, content: decOut.csv });

    var zipName = _buildBundleFilename(pgnOut.filename, csvOut.filename);
    window.BatchZip.download(files, zipName);

    return {
      savedTo: 'zip',
      filename: zipName,
      files: [
        { name: pgnOut.filename, count: pgnOut.count },
        { name: csvOut.filename, count: csvOut.count }
      ]
    };
  }

  function _buildBundleFilename(pgnFilename, csvFilename) {
    // PGN filename already carries the tournament+round prefix; swap .pgn
    // for _bundle.zip so both files in the archive read obviously together.
    if (pgnFilename && /\.pgn$/i.test(pgnFilename)) {
      return pgnFilename.replace(/\.pgn$/i, '_bundle.zip');
    }
    if (csvFilename && /\.csv$/i.test(csvFilename)) {
      return csvFilename.replace(/\.csv$/i, '_bundle.zip');
    }
    return 'Tournament_Round_bundle.zip';
  }

  function _csvCell(v) {
    if (v == null) return '';
    var s = String(v);
    if (/[",\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // =========================================================================
  // File I/O — File System Access API preferred, download fallback
  // =========================================================================

  /**
   * Save a text blob. Prefers the batch folder handle (File System Access
   * API), falls back to a browser download.
   * @returns {Promise<string>} - 'folder' or 'download', for telemetry
   */
  async function saveText(content, filename, mimeType) {
    var bs = window.BatchGameList && window.BatchGameList.batchState;
    var folder = bs && bs.folderHandle;

    if (folder) {
      try {
        // Route into Zugwise/PGN (BatchPaths); fall back to the base folder.
        var dir = window.BatchPaths
          ? (await window.BatchPaths.resolveDir(folder, filename, true)) || folder
          : folder;
        var fh = await dir.getFileHandle(filename, { create: true });
        var w = await fh.createWritable();
        await w.write(content);
        await w.close();
        if (typeof log === 'function') log('Saved ' + filename + ' to scan folder');
        return 'folder';
      } catch (e) {
        console.warn('[BatchExport] File save failed, falling back to download:', e);
      }
    }

    _downloadBlob(content, filename, mimeType || 'text/plain');
    return 'download';
  }

  function _downloadBlob(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    if (typeof log === 'function') log('Downloaded ' + filename);
  }

  // =========================================================================
  // Helpers — shared
  // =========================================================================

  function _movesForGame(game, bs) {
    // The user-confirmed move list is authoritative — NOT the raw algorithm
    // `picked` output. `picked.result.moves` is the algorithm's *proposal*; it
    // is never rewritten when the user overrides a fix during verification
    // (e.g. Greedy proposed Qxe7+, the user chose Qf7#). Reading picked here
    // shipped the algorithm's suggestion in the round PGN even though the
    // movelist and the single-game .pgn both correctly showed the user's
    // choice — the "no silent apply" invariant: only user-confirmed fixes
    // survive into an export.
    //
    // Source priority mirrors the single-game export (_buildBatchPgn):
    //   1. Currently-loaded game  → live state.sans (what the movelist/board show)
    //   2. Non-current game       → workingState.sans (snapshotted on switch)
    //   3. Neither (game never opened in verification, e.g. an auto-solved
    //      game pulled in via includeUnverified) → fall back to picked.
    if (game.gameId === bs.currentGameId &&
        typeof state !== 'undefined' && Array.isArray(state.sans) &&
        state.sans.length > 0) {
      return state.sans.slice();
    }
    if (game.workingState && Array.isArray(game.workingState.sans) &&
        game.workingState.sans.length > 0) {
      return game.workingState.sans.slice();
    }
    var rec = bs.reconstructResults && bs.reconstructResults[game.gameId];
    if (rec && rec.picked && rec.picked.result && rec.picked.result.moves) {
      return rec.picked.result.moves.slice();
    }
    return [];
  }

  function _headersForGame(game, tournamentData, options) {
    // Preferred: BatchTournament builder (applies pairing data + fallbacks).
    if (window.BatchTournament && window.BatchTournament.buildPgnHeaders) {
      var extra = {};
      if (options.site) extra.Site = options.site;
      return window.BatchTournament.buildPgnHeaders(game, tournamentData, extra);
    }

    // Minimal inline fallback — no tournament module available.
    var p = game.pairing || null;
    var roundStr;
    if (game.round != null && game.board != null) {
      roundStr = game.round + '.' + game.board;
    } else if (game.round != null) {
      roundStr = String(game.round);
    } else if (game.board != null) {
      roundStr = '?.' + game.board;
    } else {
      roundStr = '?';
    }
    var h = {
      Event: (tournamentData && tournamentData.event) || 'Tournament',
      Site: options.site || (tournamentData && tournamentData.site) || '?',
      Date: (p && p.date) || (tournamentData && tournamentData.startDate) ||
            new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      Round: roundStr,
      White: (p && p.whiteName) || '?',
      Black: (p && p.blackName) || '?',
      Result: (p && p.result) || '*',
      Source: 'Zugwise (gerhardtrippen.github.io/Zugwise)'
    };
    if (game.section) h.Section = game.section;
    if (p && p.whiteRtg) h.WhiteElo = String(p.whiteRtg);
    if (p && p.blackRtg) h.BlackElo = String(p.blackRtg);
    if (tournamentData) {
      if (tournamentData.startDate) h.EventDate = tournamentData.startDate;
      if (tournamentData.country) h.EventCountry = tournamentData.country;
      h.EventType = 'tourn';
    }
    return h;
  }

  function _buildRoundFilename(round, tournamentData, sectionNames) {
    var base = tournamentData && tournamentData.event
      ? tournamentData.event.replace(/[^A-Za-z0-9_-]+/g, '_')
      : 'Tournament';
    var sectionPart = '';
    if (sectionNames && sectionNames.length === 1 && sectionNames[0]) {
      sectionPart = '_' + sectionNames[0].replace(/[^A-Za-z0-9_-]+/g, '_');
    }
    return base + sectionPart + '_Round' + round + '.pgn';
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    generatePgn: generatePgn,
    truncateToLegalPrefix: _truncateToLegalPrefix,
    exportRoundPgn: exportRoundPgn,
    exportAndSaveRoundPgn: exportAndSaveRoundPgn,
    exportRoundIncompletePgn: exportRoundIncompletePgn,
    exportAndSaveRoundIncompletePgn: exportAndSaveRoundIncompletePgn,
    exportRoundCombinedPgn: exportRoundCombinedPgn,
    exportAndSaveRoundCombinedPgn: exportAndSaveRoundCombinedPgn,
    exportErrorReportCsv: exportErrorReportCsv,
    exportAndSaveErrorCsv: exportAndSaveErrorCsv,
    exportDecisionLogCsv: exportDecisionLogCsv,
    exportRoundBundle: exportRoundBundle,
    saveText: saveText
  };
})();

// Expose globally (consistent with other batch-mode modules).
window.BatchExport = BatchExport;
