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
  var PGN_OPTIONAL_TAGS = ['Board', 'Section', 'WhiteElo', 'BlackElo',
                           'WhiteTitle', 'BlackTitle', 'ECO', 'Source'];

  // =========================================================================
  // PGN generation
  // =========================================================================

  /**
   * Generate a complete PGN string for one game.
   * @param {Object} game - Batch game entry (used for Result fallback + gameId)
   * @param {Array<string>} moves - Flat SAN list
   * @param {Object} headers - From BatchTournament.buildPgnHeaders (or hand-built)
   * @returns {string}
   */
  function generatePgn(game, moves, headers) {
    headers = headers || {};
    var lines = [];

    // Seven-tag roster in required order.
    PGN_SEVEN_TAG.forEach(function(tag) {
      lines.push('[' + tag + ' "' + _escapeHeader(headers[tag] || '?') + '"]');
    });

    // Optional tags (only if present).
    PGN_OPTIONAL_TAGS.forEach(function(tag) {
      if (headers[tag]) {
        lines.push('[' + tag + ' "' + _escapeHeader(headers[tag]) + '"]');
      }
    });

    // Always include Source if not already added above.
    if (!headers.Source) {
      lines.push('[Source "Zugwise (gerhardtrippen.github.io/zugwise)"]');
    }

    lines.push('');

    // Move text — 5 full moves per line.
    var safeMoves = Array.isArray(moves) ? moves : [];
    var moveText = '';
    for (var i = 0; i < safeMoves.length; i += 2) {
      var moveNum = Math.floor(i / 2) + 1;
      moveText += moveNum + '. ' + safeMoves[i];
      if (safeMoves[i + 1]) moveText += ' ' + safeMoves[i + 1];
      moveText += ' ';
      if (moveNum % 5 === 0) moveText += '\n';
    }
    moveText += headers.Result || '*';
    lines.push(moveText.trim());

    return lines.join('\n') + '\n';
  }

  function _escapeHeader(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
  // Error report CSV
  // =========================================================================

  /**
   * Build a CSV report of reconstruction diagnostics for all games in a round.
   *
   * Columns:
   *   GameId, Section, Board, White, Black, Result, TotalMoves,
   *   OcrCells, AlgorithmFixes, UserOverrides, Tier, TriageReason, Status
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

      var totalMoves = picked && picked.result && picked.result.moves
        ? picked.result.moves.length : 0;
      var algoFixes = picked && picked.result && picked.result.fixes
        ? picked.result.fixes.length : 0;
      var overrides = (rec.userOverrides && rec.userOverrides.length) ||
                      (g.userOverrides && g.userOverrides.length) || 0;

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

  async function exportAndSaveErrorCsv(round, options) {
    var out = await exportErrorReportCsv(round, options);
    var savedTo = await saveText(out.csv, out.filename, 'text/csv');
    return { count: out.count, filename: out.filename, savedTo: savedTo };
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

    var bs = window.BatchGameList && window.BatchGameList.batchState;
    var folder = bs && bs.folderHandle;

    // If we have a folder, write separately — the user wants both files
    // visible in their scan directory, not stuffed in a ZIP.
    if (folder) {
      var savedPgn = pgnOut.count > 0
        ? await saveText(pgnOut.pgn, pgnOut.filename, 'application/x-chess-pgn')
        : null;
      var savedCsv = await saveText(csvOut.csv, csvOut.filename, 'text/csv');
      return {
        savedTo: 'folder',
        filename: null,
        files: [
          { name: pgnOut.filename, savedTo: savedPgn, count: pgnOut.count },
          { name: csvOut.filename, savedTo: savedCsv, count: csvOut.count }
        ]
      };
    }

    // No folder — bundle into a ZIP.
    if (!window.BatchZip) {
      // Degrade further: fall back to sequential downloads.
      if (pgnOut.count > 0) {
        await saveText(pgnOut.pgn, pgnOut.filename, 'application/x-chess-pgn');
      }
      await saveText(csvOut.csv, csvOut.filename, 'text/csv');
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
        var fh = await folder.getFileHandle(filename, { create: true });
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
    // Prefer the picked reconstruction result (the algorithm output the user
    // reviewed). If none, fall back to whatever live state the current-loaded
    // game has — covers the single-game case where the user finalized via
    // the interactive UI rather than via verification.
    var rec = bs.reconstructResults && bs.reconstructResults[game.gameId];
    if (rec && rec.picked && rec.picked.result && rec.picked.result.moves) {
      return rec.picked.result.moves.slice();
    }
    if (game.gameId === bs.currentGameId &&
        typeof state !== 'undefined' && Array.isArray(state.sans)) {
      return state.sans.slice();
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
    var h = {
      Event: (tournamentData && tournamentData.event) || 'Tournament',
      Site: options.site || (tournamentData && tournamentData.site) || '?',
      Date: (p && p.date) ||
            new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      Round: game.round != null ? String(game.round) : '?',
      White: (p && p.whiteName) || '?',
      Black: (p && p.blackName) || '?',
      Result: (p && p.result) || '*',
      Source: 'Zugwise (gerhardtrippen.github.io/zugwise)'
    };
    if (game.board != null) h.Board = String(game.board);
    if (game.section) h.Section = game.section;
    if (p && p.whiteRtg) h.WhiteElo = String(p.whiteRtg);
    if (p && p.blackRtg) h.BlackElo = String(p.blackRtg);
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
    exportRoundPgn: exportRoundPgn,
    exportAndSaveRoundPgn: exportAndSaveRoundPgn,
    exportErrorReportCsv: exportErrorReportCsv,
    exportAndSaveErrorCsv: exportAndSaveErrorCsv,
    exportRoundBundle: exportRoundBundle,
    saveText: saveText
  };
})();

// Expose globally (consistent with other batch-mode modules).
window.BatchExport = BatchExport;
