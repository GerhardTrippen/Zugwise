// =============================================================================
// batch-tournament.js — Tournament file parsing + pairing matching
// =============================================================================
// Phase 4 of Batch Mode. Parses SwissManager (.xls/.xlsx) and SwissSys (.sjson)
// exports into a common `tournamentData` shape, matches discovered scan games
// to their pairings, and builds PGN headers.
//
// Module API:
//   BatchTournament.parseTournamentFile(File)  -> Promise<tournamentData>
//   BatchTournament.parseSwissSysSJSON(object) -> tournamentData
//   BatchTournament.parseSwissManagerXLS(buf)  -> tournamentData  (needs XLSX)
//   BatchTournament.matchGameToPairing(game, tournamentData) -> pairing|null
//   BatchTournament.attachPairings(games, tournamentData) -> count matched
//   BatchTournament.buildPgnHeaders(game, tournamentData) -> headers object
//
// Dependencies:
//   - SheetJS (XLSX global) is dynamically loaded only when needed.
//   - No other runtime deps.
//
// tournamentData shape:
//   {
//     event: string, site: string,
//     startDate?: string, endDate?: string,
//     sections: [sectionName, ...],     // SwissSys only
//     players: { key -> {name, rating, title, id?, pair?} },
//     pairings: { "R{n}" | "{section}_R{n}" ->
//                 [{board, whiteName, blackName, whiteRtg, blackRtg,
//                   whiteTitle?, blackTitle?, result, date?}, ...] }
//   }
// =============================================================================

var BatchTournament = (function() {
  'use strict';

  var XLSX_CDN_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var TITLE_CODES = ['GM','IM','WGM','FM','WIM','CM','WFM','WCM','NM','ACM','AFM','AGM'];

  // =========================================================================
  // File-format dispatcher
  // =========================================================================

  async function parseTournamentFile(file) {
    if (!file) throw new Error('No tournament file provided');
    var ext = (file.name.split('.').pop() || '').toLowerCase();

    if (ext === 'sjson' || ext === 'json') {
      var text = await file.text();
      var data = JSON.parse(text);
      if (data.Sections && Array.isArray(data.Sections)) {
        return parseSwissSysSJSON(data);
      }
      throw new Error('Unrecognized JSON format. Expected SwissSys SJSON with "Sections" array.');
    }

    if (ext === 'xls' || ext === 'xlsx') {
      await _ensureXlsxLoaded();
      var buffer = await file.arrayBuffer();
      return parseSwissManagerXLS(buffer);
    }

    throw new Error('Unsupported format: .' + ext +
      '. Use SwissManager XLS (.xls/.xlsx) or SwissSys SJSON (.sjson/.json).');
  }

  async function _ensureXlsxLoaded() {
    if (typeof XLSX !== 'undefined') return;
    await new Promise(function(resolve, reject) {
      var script = document.createElement('script');
      script.src = XLSX_CDN_URL;
      script.onload = resolve;
      script.onerror = function() { reject(new Error('Failed to load SheetJS library')); };
      document.head.appendChild(script);
    });
  }

  // =========================================================================
  // SwissSys SJSON
  // =========================================================================

  function parseSwissSysSJSON(data) {
    var tournament = { event: '', site: '', players: {}, pairings: {}, sections: [] };

    // SwissSys top-level metadata — field names vary across SwissSys versions,
    // so try a handful of common spellings and fall back to empty strings.
    tournament.event = data['Tournament name'] || data.Name || data.Event ||
                       data.Title || data['Tournament Name'] || '';
    var cityParts = [data.City, data.State, data.Country]
      .filter(function(x) { return x && String(x).trim(); })
      .map(function(x) { return String(x).trim(); });
    tournament.site = cityParts.join(', ') ||
                      data.Site || data.Location || data['Site/City'] || '';
    var startDate = data['Start date'] || data.StartDate || data['Start Date'] || '';
    var endDate = data['End date'] || data.EndDate || data['End Date'] || '';
    if (startDate) tournament.startDate = String(startDate).trim();
    if (endDate) tournament.endDate = String(endDate).trim();

    (data.Sections || []).forEach(function(section) {
      var sectionName = section['Section name'] || 'Unknown';
      tournament.sections.push(sectionName);
      var roundsPlayed = section['Rounds played'] || 0;

      var playerByPair = {};
      (section.Players || []).forEach(function(p) {
        var pair = p.Pair;
        var name = ((p['Last name'] || '') + ', ' + (p['First name'] || ''))
          .trim().replace(/^,\s*/, '');
        playerByPair[pair] = {
          name: name, rating: p.Rating || 0, title: p.Title || '',
          id: p.ID || '', pair: pair
        };
        tournament.players[sectionName + '_P' + pair] = playerByPair[pair];
      });

      for (var round = 1; round <= roundsPlayed; round++) {
        var roundKey = sectionName + '_R' + round;
        if (!tournament.pairings[roundKey]) tournament.pairings[roundKey] = [];
        var seenBoards = {};

        (section.Players || []).forEach(function(p) {
          if (!p.Results || p.Results.length < round) return;
          var parts = p.Results[round - 1].split(';');
          var resultCode = parts[0];
          var opponentPair = parseInt(parts[1]) || 0;
          var color = parts[2];
          var boardNum = parseInt(parts[3]) || 0;
          if (opponentPair <= 0 || color === '-') return;
          if (seenBoards[boardNum]) return;
          seenBoards[boardNum] = true;

          var whitePair, blackPair, result;
          if (color === 'W') {
            whitePair = p.Pair; blackPair = opponentPair;
            result = resultCode === '+' ? '1-0' : resultCode === '-' ? '0-1' :
                     resultCode === '=' ? '1/2-1/2' : '*';
          } else {
            whitePair = opponentPair; blackPair = p.Pair;
            result = resultCode === '+' ? '0-1' : resultCode === '-' ? '1-0' :
                     resultCode === '=' ? '1/2-1/2' : '*';
          }

          var wp = playerByPair[whitePair] || {};
          var bp = playerByPair[blackPair] || {};
          tournament.pairings[roundKey].push({
            board: boardNum,
            whiteName: wp.name || 'Unknown', blackName: bp.name || 'Unknown',
            whiteRtg: wp.rating || 0, blackRtg: bp.rating || 0,
            whiteTitle: wp.title || '', blackTitle: bp.title || '',
            result: result
          });
        });

        tournament.pairings[roundKey].sort(function(a, b) { return a.board - b.board; });
      }
    });
    return tournament;
  }

  // =========================================================================
  // SwissManager XLS
  // =========================================================================

  function parseSwissManagerXLS(buffer) {
    if (typeof XLSX === 'undefined') {
      throw new Error('SheetJS (XLSX) library not loaded');
    }
    var workbook = XLSX.read(buffer, { type: 'array' });
    var sheet = workbook.Sheets[workbook.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    var tournament = { event: '', site: '', players: {}, pairings: {}, sections: [] };
    var currentRound = null, currentDate = '', boardCounter = 0, hasTitle = false;

    // Pre-scan header rows (everything before the first "Round N" line) for the
    // tournament name + a location/date line. SwissManager exports conventionally
    // put the tournament title in one of the first rows, optionally followed by
    // organizer/location/federation info. We take the first human-looking cell
    // as `event` and (if another distinct row exists) the next as `site`.
    // Program-banner rows ("Swiss-Manager Unicode v14.x") are skipped.
    var headerCandidates = [];
    for (var hi = 0; hi < rows.length; hi++) {
      var hrow = rows[hi].map(function(c) { return String(c).trim(); });
      if (/^Round\s+\d+/i.test(hrow[0] || '')) break;
      var nonEmpty = hrow.filter(function(c) { return c !== ''; });
      if (nonEmpty.length === 0) continue;
      var joined = nonEmpty.join(' ');
      if (/swiss[- ]?manager/i.test(joined)) continue;   // program banner
      if (/^(SNo|No\.?|Bo\.?|Board)$/i.test(nonEmpty[0])) continue;  // table header
      headerCandidates.push(nonEmpty[0]);
      if (headerCandidates.length >= 3) break;
    }
    if (headerCandidates.length > 0) tournament.event = headerCandidates[0];
    if (headerCandidates.length > 1) tournament.site = headerCandidates[1];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i].map(function(c) { return String(c).trim(); });
      if (row.length < 5) continue;

      var roundHeaderMatch = row[0].match(/^Round\s+(\d+)/i);
      if (roundHeaderMatch) {
        currentRound = parseInt(roundHeaderMatch[1]);
        boardCounter = 0;
        var dateMatch = row.join(' ').match(/(\d{4}-\w{3}-\d{2}|\d{4}\.\d{2}\.\d{2})/);
        if (dateMatch) {
          currentDate = dateMatch[1];
          if (!tournament.startDate) tournament.startDate = currentDate;
          tournament.endDate = currentDate;
        }
        tournament.pairings['R' + currentRound] = [];
        continue;
      }

      if (!currentRound) continue;
      if (row[0] === '' || row[0] === 'SNo') continue;
      if (row[0].indexOf('Swiss-Manager') >= 0 || row[0].indexOf('Program') >= 0) continue;

      var snoWhite = parseInt(row[0]);
      if (isNaN(snoWhite)) continue;
      boardCounter++;

      if (boardCounter === 1 && tournament.pairings['R' + currentRound].length === 0) {
        hasTitle = TITLE_CODES.indexOf(row[1].toUpperCase()) >= 0;
      }

      var whiteTitle, whiteName, whiteRtg, result, blackTitle, blackName, blackRtg, snoBlack;
      if (hasTitle) {
        whiteTitle = row[1]; whiteName = row[2]; whiteRtg = parseInt(row[3]) || 0;
        result = row[4];
        blackTitle = row[5]; blackName = row[6]; blackRtg = parseInt(row[7]) || 0;
        snoBlack = parseInt(row[8]) || 0;
      } else {
        whiteTitle = ''; whiteName = row[1]; whiteRtg = parseInt(row[2]) || 0;
        result = row[3];
        blackTitle = ''; blackName = row[4]; blackRtg = parseInt(row[5]) || 0;
        snoBlack = parseInt(row[6]) || 0;
      }

      result = _normalizeResult(result);

      if (!tournament.players[snoWhite]) {
        tournament.players[snoWhite] = { name: whiteName, rating: whiteRtg, title: whiteTitle };
      }
      if (snoBlack && !tournament.players[snoBlack]) {
        tournament.players[snoBlack] = { name: blackName, rating: blackRtg, title: blackTitle };
      }

      tournament.pairings['R' + currentRound].push({
        board: boardCounter,
        whiteSNo: snoWhite, blackSNo: snoBlack,
        whiteName: whiteName, blackName: blackName,
        whiteRtg: whiteRtg, blackRtg: blackRtg,
        whiteTitle: whiteTitle, blackTitle: blackTitle,
        result: result, date: currentDate
      });
    }

    return tournament;
  }

  function _normalizeResult(res) {
    if (!res) return '*';
    res = String(res).replace(/\s+/g, '').replace(/½/g, '1/2');
    if (/^1-0$/.test(res)) return '1-0';
    if (/^0-1$/.test(res)) return '0-1';
    if (/1\/2-1\/2/.test(res)) return '1/2-1/2';
    return res || '*';
  }

  // =========================================================================
  // Pairing match — games discovered from scans ↔ tournament pairings
  // =========================================================================

  /**
   * Look up a single game's pairing from tournamentData.
   *
   * Match strategy:
   *   1. Prefer section-qualified key: "{section}_R{round}" or "{section}R{round}"
   *   2. Fall back to "R{round}" (SwissManager when section is implicit)
   *   3. Within the chosen round, match by board number.
   *
   * @param {Object} game - {section, round, board, ...}
   * @param {Object} tournamentData - From parseTournamentFile()
   * @returns {Object|null} - pairing entry or null
   */
  function matchGameToPairing(game, tournamentData) {
    if (!game || !tournamentData || !tournamentData.pairings) return null;
    if (game.round == null || game.board == null) return null;

    var round = game.round;
    var board = game.board;
    var section = (game.section || '').toLowerCase();

    // 1. Try section-qualified keys first (SwissSys style).
    var candidates = Object.keys(tournamentData.pairings).filter(function(k) {
      var m = k.match(/_R(\d+)$|R(\d+)$/);
      if (!m) return false;
      return parseInt(m[1] || m[2]) === round;
    });

    // Section match — be forgiving about case and partial overlap.
    if (section) {
      var sectionHits = candidates.filter(function(k) {
        return k.toLowerCase().indexOf(section) >= 0;
      });
      if (sectionHits.length > 0) candidates = sectionHits;
    }

    for (var i = 0; i < candidates.length; i++) {
      var list = tournamentData.pairings[candidates[i]] || [];
      var hit = list.find(function(p) { return p.board === board; });
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Attach pairings to every game in a Map in place.
   *
   * Two-pass strategy:
   *   Pass 1 — direct (round, board) match via matchGameToPairing.
   *   Pass 2 — board-index fallback for multi-section tournaments where the
   *     physical scan-folder board numbers diverge from the per-section XLS
   *     numbering. E.g. Crown section uses boards 1-5 in the folder, Premier
   *     uses 6-10, but the per-section Premier XLS lists boards as 1-5.
   *     Pass 1 misses every Premier game; Pass 2 notices the game count in
   *     round R matches the remaining-pairings count for the same
   *     (round, section) and zips them by sorted board number.
   *
   * Pass 2 only fires when counts line up exactly — if a scan is missing
   * or there are extra files, we'd rather leave those games unpaired than
   * invent a wrong mapping. Games matched this way get
   * `game.pairingViaBoardOffset = true` so callers can warn the user.
   *
   * @param {Map<string, Object>} games
   * @param {Object} tournamentData
   * @returns {number} - count of games with successful match
   */
  function attachPairings(games, tournamentData) {
    if (!games || !tournamentData) return 0;
    var matched = 0;
    var usedPairings = new Set();

    // Pass 1: direct match.
    games.forEach(function(game) {
      var p = matchGameToPairing(game, tournamentData);
      if (p) {
        game.pairing = p;
        usedPairings.add(p);
        matched++;
      }
    });

    // Group leftover games by (round, section) for Pass 2.
    var unmatchedByKey = {};
    games.forEach(function(game) {
      if (game.pairing) return;
      if (game.round == null || game.board == null) return;
      var section = (game.section || '').toLowerCase();
      var key = 'R' + game.round + '|' + section;
      if (!unmatchedByKey[key]) unmatchedByKey[key] = [];
      unmatchedByKey[key].push(game);
    });

    Object.keys(unmatchedByKey).forEach(function(key) {
      var parts = key.split('|');
      var round = parseInt(parts[0].substr(1));
      var section = parts[1];
      var gamesInRound = unmatchedByKey[key];

      // Resolve candidate pairings keys the same way matchGameToPairing does.
      var candidates = Object.keys(tournamentData.pairings).filter(function(k) {
        var m = k.match(/_R(\d+)$|R(\d+)$/);
        if (!m) return false;
        return parseInt(m[1] || m[2]) === round;
      });
      if (section) {
        var sectionHits = candidates.filter(function(k) {
          return k.toLowerCase().indexOf(section) >= 0;
        });
        if (sectionHits.length > 0) candidates = sectionHits;
      }

      // Remaining pairings for this (round, section).
      var availablePairings = [];
      candidates.forEach(function(c) {
        (tournamentData.pairings[c] || []).forEach(function(p) {
          if (!usedPairings.has(p)) availablePairings.push(p);
        });
      });

      if (availablePairings.length === 0) return;
      if (availablePairings.length !== gamesInRound.length) return;

      // Zip by sorted board number. Same relative order on both sides
      // means the Nth physical scan corresponds to the Nth XLS pairing.
      gamesInRound.sort(function(a, b) { return a.board - b.board; });
      availablePairings.sort(function(a, b) { return a.board - b.board; });
      for (var i = 0; i < gamesInRound.length; i++) {
        gamesInRound[i].pairing = availablePairings[i];
        gamesInRound[i].pairingViaBoardOffset = true;
        usedPairings.add(availablePairings[i]);
        matched++;
      }
    });

    return matched;
  }

  // =========================================================================
  // PGN header builder
  // =========================================================================

  /**
   * Build the full PGN header set for a game.
   * @param {Object} game - {section, round, board, pairing?, gameId}
   * @param {Object} [tournamentData]
   * @param {Object} [extra] - Override/append headers (e.g., {Site: 'Toronto'})
   * @returns {Object} - {Event, Site, Date, Round, Board, White, Black, Result,
   *                      WhiteElo?, BlackElo?, WhiteTitle?, BlackTitle?, Source}
   */
  function buildPgnHeaders(game, tournamentData, extra) {
    game = game || {};
    extra = extra || {};
    var pairing = game.pairing ||
                  (tournamentData ? matchGameToPairing(game, tournamentData) : null);

    var headers = {
      Event: (tournamentData && tournamentData.event) || extra.Event || 'Tournament',
      Site: (tournamentData && tournamentData.site) || extra.Site || '?',
      Date: extra.Date || (pairing && pairing.date) ||
            new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      Round: game.round != null ? String(game.round) : (extra.Round || '?'),
      White: (pairing && pairing.whiteName) || extra.White || '?',
      Black: (pairing && pairing.blackName) || extra.Black || '?',
      Result: (pairing && pairing.result) || extra.Result || '*',
      Source: 'Zugwise (gerhardtrippen.github.io/zugwise)'
    };

    if (game.board != null) headers.Board = String(game.board);
    if (game.section) headers.Section = game.section;

    if (pairing) {
      if (pairing.whiteRtg) headers.WhiteElo = String(pairing.whiteRtg);
      if (pairing.blackRtg) headers.BlackElo = String(pairing.blackRtg);
      if (pairing.whiteTitle) headers.WhiteTitle = pairing.whiteTitle;
      if (pairing.blackTitle) headers.BlackTitle = pairing.blackTitle;
    }

    // Caller overrides win.
    Object.keys(extra).forEach(function(k) { headers[k] = extra[k]; });
    return headers;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    parseTournamentFile: parseTournamentFile,
    parseSwissSysSJSON: parseSwissSysSJSON,
    parseSwissManagerXLS: parseSwissManagerXLS,
    matchGameToPairing: matchGameToPairing,
    attachPairings: attachPairings,
    buildPgnHeaders: buildPgnHeaders
  };
})();

// Expose globally (consistent with other batch-mode modules).
window.BatchTournament = BatchTournament;
