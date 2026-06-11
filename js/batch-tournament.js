// =============================================================================
// batch-tournament.js — Tournament file parsing + pairing matching
// =============================================================================
// Phase 4 of Batch Mode. Parses SwissManager (.xls/.xlsx) and SwissSys (.sjson)
// exports into a common `tournamentData` shape, matches discovered scan games
// to their pairings, and builds PGN headers.
//
// Module API:
//   BatchTournament.parseTournamentFile(File)             -> Promise<tournamentData>
//   BatchTournament.parseTournamentFiles(File[])          -> Promise<tournamentData>
//   BatchTournament.parseSwissSysSJSON(object)            -> tournamentData
//   BatchTournament.parseSwissManagerXLS(buf)             -> tournamentData (needs XLSX)
//   BatchTournament.parseSwissManagerCrosstableXLS(buf)   -> tournamentData (needs XLSX)
//   BatchTournament.parseChessManagerCSV(text)            -> tournamentData (all-rounds)
//   BatchTournament.parseChessManagerRoundCSV(text,opts)  -> tournamentData (one round, w/ boards)
//   BatchTournament.parseChessManagerRosterCSV(text)      -> tournamentData (players only)
//   BatchTournament.parseChessManagerPgnHeaders(text)     -> tournamentData (per-round, boards in Round tag)
//   BatchTournament.mergeTournamentData(td[])             -> tournamentData
//   BatchTournament.detectEventType(td)                   -> "swiss" | "round robin" | null
//   BatchTournament.matchGameToPairing(game, td)          -> pairing|null
//   BatchTournament.attachPairings(games, td)             -> count matched
//   BatchTournament.buildPgnHeaders(game, td)             -> headers object
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

  // -------------------------------------------------------------------------
  // Section extraction from SwissManager filename. SwissManager exports
  // pairings/crosstable XLS as
  //   "{TournamentName}_{SECTION}_{Pairings_Results_for_Round_N
  //                                 | Crosstable_Tiebreaks
  //                                 | Standings_...}.xls"
  // The section token sits between underscores immediately before one of
  // those well-known suffix anchors. Returns the raw section string
  // (case preserved for display) or '' when no pattern matches.
  //
  // Caveat: section names containing underscores (e.g. "U_1800") would
  // confuse this — but every chess-tournament section name we have seen
  // in the wild is alnum-only (OPEN, Crown, Premier, U1800, U1500, …).
  // -------------------------------------------------------------------------
  function extractSectionFromFilename(filename) {
    if (!filename) return '';
    var base = filename.replace(/\.\w+$/, '');
    var m = base.match(/_([^_]+)_(?:Pairings|Crosstable|Standings|Berger|Ranking)/i);
    return m ? m[1] : '';
  }

  // Per-section key helpers. When section is empty, keys stay in the legacy
  // bare form ("R1", "1") for backward compatibility with single-section
  // tournaments that have always parsed this way. When section is set,
  // keys become "OPEN_R1", "OPEN_1" — same shape as SwissSys SJSON already
  // uses, which lights up matchGameToPairing's existing section filter.
  function _pairingKey(section, round) {
    return section ? (section + '_R' + round) : ('R' + round);
  }
  function _playerKey(section, sno) {
    return section ? (section + '_' + sno) : String(sno);
  }

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

    if (ext === 'csv' || ext === 'pgn') {
      var csvText = await file.text();
      var csvSec = extractSectionFromFilename(file.name);
      var csvOpts = csvSec ? { section: csvSec } : undefined;
      var kind = _sniffChessManagerKind(file.name, csvText);
      if (kind === 'pgn') {
        return parseChessManagerPgnHeaders(csvText, csvOpts);
      }
      if (kind === 'round') {
        return parseChessManagerRoundCSV(csvText, {
          section: csvSec || '', round: _roundFromName(file.name) || 1
        });
      }
      if (kind === 'roster') {
        return parseChessManagerRosterCSV(csvText, csvOpts);
      }
      return parseChessManagerCSV(csvText, csvOpts);
    }

    if (ext === 'xls' || ext === 'xlsx') {
      await _ensureXlsxLoaded();
      var buffer = await file.arrayBuffer();
      var sec = extractSectionFromFilename(file.name);
      var sectionOpts = sec ? { section: sec } : undefined;
      var kind = _sniffXlsKind(file.name, buffer);
      if (kind === 'crosstable') {
        return parseSwissManagerCrosstableXLS(buffer, sectionOpts);
      }
      return parseSwissManagerXLS(buffer, sectionOpts);
    }

    throw new Error('Unsupported format: .' + ext +
      '. Use SwissManager XLS (.xls/.xlsx), SwissSys SJSON (.sjson/.json), ' +
      'or chessmanager.com CSV/PGN (.csv/.pgn).');
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
    if (data.Country && String(data.Country).trim()) {
      tournament.country = String(data.Country).trim();
    }
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
            whiteId: wp.id || '', blackId: bp.id || '',
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

  function parseSwissManagerXLS(buffer, opts) {
    if (typeof XLSX === 'undefined') {
      throw new Error('SheetJS (XLSX) library not loaded');
    }
    var section = (opts && opts.section) || '';
    var workbook = XLSX.read(buffer, { type: 'array' });
    var sheet = workbook.Sheets[workbook.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    var tournament = { event: '', site: '', players: {}, pairings: {}, sections: [] };
    if (section) tournament.sections.push(section);
    var currentRound = null, currentDate = '', boardCounter = 0;
    // cols is populated when we see a table-header row (Bo./SNo./No./Board ...).
    // It survives across rounds and is reset each round (a new round may emit a
    // fresh header line; we use the most recent one we've seen).
    var cols = null;

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
        // New round → forget the previous round's column-layout state. The
        // table-header detector below will set it correctly when (or if) the
        // round emits its own header row.
        cols = null;
        var dateStr = _findDate(row);
        if (dateStr) {
          currentDate = dateStr;
          if (!tournament.startDate) tournament.startDate = currentDate;
          tournament.endDate = currentDate;
        }
        tournament.pairings[_pairingKey(section, currentRound)] = [];
        continue;
      }

      if (!currentRound) continue;
      if (row[0] === '' && (cols == null || cols.bo < 0)) continue;

      // Table-header row, e.g. "SNo. White Rtg Res. Black Rtg SNo." or
      // "Bo. SNo. _ White Pts Res. Pts _ Black SNo." — column positions vary
      // across SwissManager export profiles, so map header labels to indices
      // and use them as the source of truth for data-row extraction.
      if (/^(SNo\.?|No\.?|Bo\.?|Board)$/i.test(row[0])) {
        cols = _parseHeaderRow(row);
        continue;
      }

      if (row[0].indexOf('Swiss-Manager') >= 0 || row[0].indexOf('Program') >= 0) continue;
      if (cols == null) continue;   // can't safely interpret data without header

      // Skip byes / unplayed rows. SwissManager flags these with the black
      // cell literally set to "Bye" or "-" (forfeit / pairing-allocated bye).
      var blackCellRaw = (cols.black >= 0) ? row[cols.black] : '';
      if (/^bye$/i.test(blackCellRaw) || blackCellRaw === '-' || blackCellRaw === '') continue;

      var snoWhite = (cols.snoWhite >= 0) ? parseInt(row[cols.snoWhite]) : NaN;
      if (isNaN(snoWhite)) continue;

      boardCounter++;
      // Prefer the explicit Bo. column when present; this is robust to byes
      // inserted between numbered boards (the counter would otherwise drift).
      var board = boardCounter;
      if (cols.bo >= 0) {
        var boRaw = parseInt(row[cols.bo]);
        if (!isNaN(boRaw)) board = boRaw;
      }

      var whiteName  = row[cols.white] || '';
      var whiteTitle = (cols.titleWhite >= 0) ? (row[cols.titleWhite] || '') : '';
      var whiteRtg   = (cols.rtgWhite >= 0) ? (parseInt(row[cols.rtgWhite]) || 0) : 0;
      var result     = (cols.result >= 0) ? row[cols.result] : '';
      var blackName  = blackCellRaw;
      var blackTitle = (cols.titleBlack >= 0) ? (row[cols.titleBlack] || '') : '';
      var blackRtg   = (cols.rtgBlack >= 0) ? (parseInt(row[cols.rtgBlack]) || 0) : 0;
      var snoBlack   = (cols.snoBlack >= 0) ? (parseInt(row[cols.snoBlack]) || 0) : 0;

      result = _normalizeResult(result);

      var wKey = _playerKey(section, snoWhite);
      var bKey = snoBlack ? _playerKey(section, snoBlack) : '';
      if (!tournament.players[wKey]) {
        tournament.players[wKey] = {
          name: whiteName, rating: whiteRtg, title: whiteTitle, section: section
        };
      }
      if (bKey && !tournament.players[bKey]) {
        tournament.players[bKey] = {
          name: blackName, rating: blackRtg, title: blackTitle, section: section
        };
      }

      tournament.pairings[_pairingKey(section, currentRound)].push({
        board: board, section: section,
        whiteSNo: snoWhite, blackSNo: snoBlack,
        whiteName: whiteName, blackName: blackName,
        whiteRtg: whiteRtg, blackRtg: blackRtg,
        whiteTitle: whiteTitle, blackTitle: blackTitle,
        result: result, date: currentDate
      });
    }

    return tournament;
  }

  // -------------------------------------------------------------------------
  // Header-row → column-index map for SwissManager pairing tables.
  //
  // Returns: { bo, snoWhite, snoBlack, white, black, result,
  //            rtgWhite, rtgBlack, titleWhite, titleBlack }
  // with -1 for absent columns. Title columns are detected as the empty-string
  // header cell immediately preceding "White" or "Black" (SwissManager omits a
  // header label on title columns).
  // -------------------------------------------------------------------------
  function _parseHeaderRow(row) {
    var cols = {
      bo: -1, snoWhite: -1, snoBlack: -1, white: -1, black: -1,
      result: -1, rtgWhite: -1, rtgBlack: -1, titleWhite: -1, titleBlack: -1
    };
    var snoCols = [], rtgCols = [];
    for (var c = 0; c < row.length; c++) {
      var h = String(row[c] || '').trim().toLowerCase().replace(/\.+$/, '');
      if (h === 'bo' || h === 'board' || h === 'no') {
        if (cols.bo < 0) cols.bo = c;
      } else if (h === 'sno') {
        snoCols.push(c);
      } else if (h === 'white') {
        cols.white = c;
      } else if (h === 'black') {
        cols.black = c;
      } else if (h === 'res' || h === 'result') {
        cols.result = c;
      } else if (h === 'rtg' || h === 'rating') {
        rtgCols.push(c);
      }
      // 'Pts' columns are intentionally ignored.
    }
    if (snoCols.length >= 1) cols.snoWhite = snoCols[0];
    if (snoCols.length >= 2) cols.snoBlack = snoCols[snoCols.length - 1];
    if (rtgCols.length >= 1) cols.rtgWhite = rtgCols[0];
    if (rtgCols.length >= 2) cols.rtgBlack = rtgCols[rtgCols.length - 1];
    if (cols.white > 0 && String(row[cols.white - 1] || '').trim() === '') {
      cols.titleWhite = cols.white - 1;
    }
    if (cols.black > 0 && String(row[cols.black - 1] || '').trim() === '') {
      cols.titleBlack = cols.black - 1;
    }
    return cols;
  }

  // -------------------------------------------------------------------------
  // Date sniffer for SwissManager round-banner rows. Accepts the three
  // formats seen in the wild: "2025-Jun-07", "2025.06.07", "2025/06/07".
  // Normalizes to PGN-friendly "YYYY.MM.DD" for slash/dash variants; leaves
  // the textual-month form untouched (downstream code already handled it).
  // -------------------------------------------------------------------------
  function _findDate(row) {
    var joined = row.join(' ');
    var m = joined.match(/(\d{4})-(\w{3})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = joined.match(/(\d{4})[\.\/](\d{2})[\.\/](\d{2})/);
    if (m) return m[1] + '.' + m[2] + '.' + m[3];
    return '';
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
  // SwissManager Crosstable XLS (round-by-round layout)
  //
  // A crosstable export carries strictly more player metadata than a per-round
  // pairings file: ratings, federation codes, titles, and tournament-wide
  // metadata (organizer, arbiter, site address, date range). Per-round files
  // are still the source of board numbers — the crosstable lists matchups
  // chronologically but does NOT preserve the per-round board assignment.
  //
  // Expected sheet layout:
  //   row 0          : tournament title
  //   rows 1..N      : "Organizer", "Chief Arbiter", "Town", "Date" labelled rows
  //   row K          : "Final ranking" / "Standings"
  //   row K+2        : ["Rank","SNo.","","Name","Rtg","FED","1.Rd.","","",
  //                     "2.Rd.","","",...,"Pts","DE","BH:GP",...]
  //   row K+3..      : data rows; per-round cell triple is opponent SNo, color
  //                    (w/b/-), and result (1 / ½ / 0 / -).
  // =========================================================================
  function parseSwissManagerCrosstableXLS(buffer, opts) {
    if (typeof XLSX === 'undefined') {
      throw new Error('SheetJS (XLSX) library not loaded');
    }
    var section = (opts && opts.section) || '';
    var workbook = XLSX.read(buffer, { type: 'array' });
    var sheet = workbook.Sheets[workbook.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    var tournament = {
      event: '', site: '', players: {}, pairings: {}, sections: [],
      fromCrosstable: true
    };
    if (section) tournament.sections.push(section);

    // Pre-scan labelled header rows. SwissManager crosstables use
    // "Label : value" pairs that often contain Unicode garbage in the label
    // (e.g. "Rating-Ø") — we match on the prefix label only.
    var headerTitle = '';
    var townLine = '', dateLine = '';
    var organizer = '', chiefArbiter = '';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i].map(function(c) { return String(c).trim(); });
      var first = row[0] || '';
      if (!first) continue;
      if (/^Rank\b/i.test(first)) break;
      if (i === 0 && first) { headerTitle = first; continue; }
      var labelMatch = first.match(/^([^:]+)\s*:\s*(.+)$/);
      if (!labelMatch) continue;
      var label = labelMatch[1].trim().toLowerCase();
      var value = labelMatch[2].trim();
      if (/^organi[sz]er/.test(label)) organizer = value;
      else if (/^chief arbiter/.test(label)) chiefArbiter = value;
      else if (/^town/.test(label) || /^city/.test(label) || /^venue/.test(label)) {
        townLine = value;
      } else if (/^date/.test(label)) dateLine = value;
    }
    tournament.event = headerTitle;
    if (townLine) tournament.site = townLine;
    if (organizer) tournament.organizer = organizer;
    if (chiefArbiter) tournament.chiefArbiter = chiefArbiter;

    // Date range: "2025/06/07 To 2025/06/08" → startDate / endDate (PGN format).
    if (dateLine) {
      var dateMatches = dateLine.match(/(\d{4})[\.\/\-](\d{2})[\.\/\-](\d{2})/g) || [];
      if (dateMatches.length >= 1) {
        tournament.startDate = dateMatches[0].replace(/[\/\-]/g, '.');
      }
      if (dateMatches.length >= 2) {
        tournament.endDate = dateMatches[dateMatches.length - 1].replace(/[\/\-]/g, '.');
      } else if (tournament.startDate) {
        tournament.endDate = tournament.startDate;
      }
    }

    // Find the player-table header row + map columns by label.
    var headerIdx = -1, cols = null, roundCols = [];
    for (var hi = 0; hi < rows.length; hi++) {
      var hrow = rows[hi].map(function(c) { return String(c).trim(); });
      if (!/^Rank\b/i.test(hrow[0] || '')) continue;
      headerIdx = hi;
      cols = { rank: -1, sno: -1, title: -1, name: -1, rating: -1, fed: -1, pts: -1 };
      for (var c = 0; c < hrow.length; c++) {
        var h = hrow[c].toLowerCase().replace(/\.+$/, '');
        if (h === 'rank') cols.rank = c;
        else if (h === 'sno') cols.sno = c;
        else if (h === 'name') cols.name = c;
        else if (h === 'rtg' || h === 'rating') cols.rating = c;
        else if (h === 'fed' || h === 'federation') cols.fed = c;
        else if (h === 'pts' || h === 'points') cols.pts = c;
        else {
          var rdMatch = h.match(/^(\d+)\.?\s*rd$/);   // "1.rd", "1rd", "1 rd"
          if (rdMatch) {
            roundCols.push({ round: parseInt(rdMatch[1]), col: c });
          }
        }
      }
      // Title is at name-1 IF that header cell is empty (same convention as
      // per-round files; SwissManager omits the label for the Title column).
      if (cols.name > 0 && hrow[cols.name - 1] === '') cols.title = cols.name - 1;
      break;
    }
    if (headerIdx < 0 || cols == null || cols.sno < 0 || cols.name < 0) {
      throw new Error('Crosstable parse failed: could not find player-table header');
    }

    // Initialise empty pairing lists for each round we discovered.
    roundCols.sort(function(a, b) { return a.round - b.round; });
    roundCols.forEach(function(rc) {
      tournament.pairings[_pairingKey(section, rc.round)] = [];
    });

    // Two-pass over data rows. Pass 1: build the player map. Pass 2: synthesise
    // pairings (we need both sides' names/ratings to fill them in).
    var dataRows = [];
    for (var dr = headerIdx + 1; dr < rows.length; dr++) {
      var drow = rows[dr].map(function(c) { return String(c).trim(); });
      if (drow.length < cols.sno + 1) continue;
      var snoRaw = parseInt(drow[cols.sno]);
      if (isNaN(snoRaw)) continue;
      dataRows.push(drow);
    }

    // Build a position → SNo lookup. The per-round opponent cells reference
    // opponents by their **standings position** (1-based row index in the
    // crosstable), NOT by SNo. Verified by cross-checking against per-round
    // files: Hua (rank 1, SNo 1) shows R1 opp="11", and position 11 in the
    // standings is SNo 15 (Lau Jayden) — which matches Round 1 board 1.
    // Tied ranks (multiple players sharing the same Rank display value)
    // still occupy distinct row positions, so a positional index resolves
    // them unambiguously where the rank value alone would not.
    var positionToSNo = {};
    dataRows.forEach(function(drow, idx) {
      var sno = parseInt(drow[cols.sno]);
      var name = drow[cols.name] || '';
      var rating = (cols.rating >= 0) ? (parseInt(drow[cols.rating]) || 0) : 0;
      var title = (cols.title >= 0) ? (drow[cols.title] || '') : '';
      var fed = (cols.fed >= 0) ? (drow[cols.fed] || '') : '';
      tournament.players[_playerKey(section, sno)] = {
        name: name, rating: rating, title: title, fed: fed, section: section
      };
      positionToSNo[idx + 1] = sno;
    });

    // Pairing synthesis: for each player × round, read (oppPos, color, result),
    // map oppPos → oppSNo via positionToSNo, and emit each game exactly once.
    // Tracking by (round, unorderedPair) prevents double-counting from the
    // two perspectives the crosstable records each game in.
    var seen = {};
    dataRows.forEach(function(drow) {
      var sno = parseInt(drow[cols.sno]);
      roundCols.forEach(function(rc) {
        var oppRaw = drow[rc.col];
        var color  = (drow[rc.col + 1] || '').toLowerCase();
        var rsCell = drow[rc.col + 2] || '';
        var oppPos = parseInt(oppRaw);
        if (isNaN(oppPos) || oppPos <= 0) return;       // bye / unpaired
        if (color !== 'w' && color !== 'b') return;     // skip 'half-point bye' etc.
        var opp = positionToSNo[oppPos];
        if (!opp) return;                                // unresolvable opponent
        var a = Math.min(sno, opp), b = Math.max(sno, opp);
        var key = rc.round + ':' + a + 'v' + b;
        if (seen[key]) return;
        seen[key] = true;
        var whiteSNo = (color === 'w') ? sno : opp;
        var blackSNo = (color === 'w') ? opp : sno;
        var wp = tournament.players[_playerKey(section, whiteSNo)] || {};
        var bp = tournament.players[_playerKey(section, blackSNo)] || {};
        // Result normalisation: crosstable cell is the result FROM THE
        // PERSPECTIVE of the row's player. Flip it if the row was black.
        var rsStr = String(rsCell).replace(/½/g, '1/2').trim();
        var result = '*';
        if (rsStr === '1' || rsStr === '+') {
          result = (color === 'w') ? '1-0' : '0-1';
        } else if (rsStr === '0' || rsStr === '-') {
          result = (color === 'w') ? '0-1' : '1-0';
        } else if (rsStr === '1/2' || rsStr === '=') {
          result = '1/2-1/2';
        }
        tournament.pairings[_pairingKey(section, rc.round)].push({
          board: null,              // crosstable does not carry board numbers
          section: section,
          whiteSNo: whiteSNo, blackSNo: blackSNo,
          whiteName: wp.name || '', blackName: bp.name || '',
          whiteRtg: wp.rating || 0, blackRtg: bp.rating || 0,
          whiteTitle: wp.title || '', blackTitle: bp.title || '',
          whiteFed: wp.fed || '', blackFed: bp.fed || '',
          result: result, date: tournament.startDate || ''
        });
      });
    });

    return tournament;
  }

  // =========================================================================
  // chessmanager.com CSV
  //
  // chessmanager.com (the online pairing tool) exports a single CSV that
  // carries everything we need in one file: tournament metadata, the full
  // player roster (name, rating, federation, FIDE ID, birthdate), and each
  // player's per-round pairing history. Layout:
  //
  //   row 0..K       : "Label,Value" metadata
  //                    (Tournament Name, City, Federation, Start/End Date,
  //                     Number of Rounds, Chief Arbiter, Time Control, ...)
  //   blank row
  //   header row     : Player No,Sex,Title,Name,Rating,Federation,FIDE ID,
  //                    Birthdate,Points,Rank, then nothing — the per-round
  //                    triples have no column labels.
  //   data rows      : the 10 fixed columns above, then one (opponent, color,
  //                    result) triple per round.
  //
  // Unlike the SwissManager crosstable, the per-round opponent cell references
  // the opponent by **Player No** (= starting rank / SNo) directly, NOT by
  // standings position. Verified: player 1's R1 cell "18,b,1" pairs with
  // player 18's R1 cell "1,w,0" — same game from both sides.
  //
  // Cell encoding:
  //   opponent : a player number, or "0000" for a bye (no game)
  //   color    : "w" / "b", or "-" for a bye
  //   result   : "1" win, "0" loss, "=" draw, "+" win by forfeit,
  //              "-" loss by forfeit; bye codes "H" (half), "Z" (zero/withdraw),
  //              "U" (unplayed) appear with opponent "0000" / color "-".
  //
  // Board numbers are not present in this export (like the crosstable), so
  // pairings carry board:null. Section is taken from the filename when present
  // (rare for chessmanager single-section exports) and is otherwise empty,
  // keeping the legacy bare "R{n}" pairing keys.
  // =========================================================================
  function parseChessManagerCSV(text, opts) {
    var section = (opts && opts.section) || '';
    var rows = String(text || '')
      .split(/\r\n|\r|\n/)
      .map(_parseCsvLine);

    var tournament = {
      event: '', site: '', players: {}, pairings: {}, sections: [],
      fromCrosstable: true
    };
    if (section) tournament.sections.push(section);

    // Scan the leading "Label,Value" rows until we reach the player table
    // header (first cell === "Player No"). Labels are matched case-folded.
    var headerIdx = -1;
    var meta = {};
    for (var i = 0; i < rows.length; i++) {
      var first = (rows[i][0] || '').trim();
      if (/^player\s*no$/i.test(first)) { headerIdx = i; break; }
      if (!first) continue;
      meta[first.toLowerCase()] = (rows[i][1] || '').trim();
    }
    if (headerIdx < 0) {
      throw new Error('chessmanager CSV: could not find the "Player No" header row');
    }

    tournament.event = meta['tournament name'] || '';
    if (meta['city']) tournament.site = meta['city'];
    if (meta['federation']) tournament.country = meta['federation'];
    if (meta['start date']) tournament.startDate = _normCsvDate(meta['start date']);
    if (meta['end date']) tournament.endDate = _normCsvDate(meta['end date']);
    // SwissManager exports misspell this as "Chier Arbiter"; accept both.
    var arbiter = meta['chief arbiter'] || meta['chier arbiter'];
    if (arbiter) tournament.chiefArbiter = arbiter;
    var numRounds = parseInt(meta['number of rounds'], 10) || 0;

    // Fixed leading columns before the per-round triples:
    // Player No, Sex, Title, Name, Rating, Federation, FIDE ID, Birthdate,
    // Points, Rank.
    var FIXED = 10;

    // Pass 1: player roster.
    var dataRows = [];
    for (var dr = headerIdx + 1; dr < rows.length; dr++) {
      var drow = rows[dr];
      var sno = parseInt((drow[0] || '').trim(), 10);
      if (isNaN(sno)) continue;
      dataRows.push(drow);
      tournament.players[_playerKey(section, sno)] = {
        name:   (drow[3] || '').trim(),
        rating: parseInt((drow[4] || '').trim(), 10) || 0,
        title:  (drow[2] || '').trim(),
        fed:    (drow[5] || '').trim(),
        id:     (drow[6] || '').trim(),
        section: section
      };
    }

    // Pass 2: synthesise pairings. Each game is recorded from both players'
    // perspectives; dedup on (round, unordered player pair) so it lands once.
    var seen = {};
    dataRows.forEach(function(drow) {
      var sno = parseInt((drow[0] || '').trim(), 10);
      for (var r = 1; ; r++) {
        var base = FIXED + (r - 1) * 3;
        if (base + 2 >= drow.length) break;
        if (numRounds && r > numRounds) break;
        var opp = parseInt((drow[base] || '').trim(), 10);
        var color = (drow[base + 1] || '').trim().toLowerCase();
        var rsCell = (drow[base + 2] || '').trim();
        if (isNaN(opp) || opp <= 0) continue;          // bye (opponent "0000")
        if (color !== 'w' && color !== 'b') continue;  // bye / unplayed
        var a = Math.min(sno, opp), b = Math.max(sno, opp);
        var key = r + ':' + a + 'v' + b;
        if (seen[key]) continue;
        seen[key] = true;

        var whiteSNo = (color === 'w') ? sno : opp;
        var blackSNo = (color === 'w') ? opp : sno;
        var wp = tournament.players[_playerKey(section, whiteSNo)] || {};
        var bp = tournament.players[_playerKey(section, blackSNo)] || {};
        var result = _csvResult(rsCell, color);

        var rk = _pairingKey(section, r);
        if (!tournament.pairings[rk]) tournament.pairings[rk] = [];
        tournament.pairings[rk].push({
          board: null, section: section,
          whiteSNo: whiteSNo, blackSNo: blackSNo,
          whiteName: wp.name || '', blackName: bp.name || '',
          whiteRtg: wp.rating || 0, blackRtg: bp.rating || 0,
          whiteTitle: wp.title || '', blackTitle: bp.title || '',
          whiteFed: wp.fed || '', blackFed: bp.fed || '',
          whiteFideId: wp.id || '', blackFideId: bp.id || '',
          result: result, date: tournament.startDate || ''
        });
      }
    });

    return tournament;
  }

  // Minimal RFC-4180-ish single-line CSV splitter: handles double-quoted
  // fields (the Name column is quoted because it contains "Last, First") and
  // doubled "" escapes. chessmanager rows never embed newlines inside a field,
  // so a line-at-a-time split upstream is safe.
  function _parseCsvLine(line) {
    var fields = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  }

  // chessmanager dates are "YYYY/MM/DD"; PGN wants "YYYY.MM.DD".
  function _normCsvDate(s) {
    return String(s || '').trim().replace(/[\/\-]/g, '.');
  }

  // Per-round result cell → PGN result string, from the row player's color.
  function _csvResult(rsCell, color) {
    var rs = String(rsCell).replace(/½/g, '1/2').trim();
    if (rs === '1' || rs === '+') return (color === 'w') ? '1-0' : '0-1';
    if (rs === '0' || rs === '-') return (color === 'w') ? '0-1' : '1-0';
    if (rs === '1/2' || rs === '=') return '1/2-1/2';
    return '*';
  }

  // =========================================================================
  // chessmanager.com per-round CSV  (the "... - round N.csv" export)
  //
  // Unlike the all-rounds file, this one carries an explicit board number per
  // game and embeds both players' details inline (identified by NAME, not by
  // player number). Header row, comma-quoted:
  //
  //   board, playerW.federation, playerW.title, playerW.name, playerW.rating,
  //   playerW.scores, playerB.federation, playerB.title, playerB.name,
  //   playerB.rating, playerB.rating_local, playerB.scores, result
  //
  // Columns are mapped by their header labels (the layout is mildly asymmetric
  // — black carries an extra rating_local — so positional parsing is unsafe).
  // Byes show one side blank; we skip them (no game to digitise).
  //
  // The primary use of this file is to DONATE board numbers to the all-rounds
  // pairings by name match (see _attachBoardsByName). Its own result cell is
  // therefore best-effort and only consulted when no all-rounds file is loaded.
  // =========================================================================
  function parseChessManagerRoundCSV(text, opts) {
    opts = opts || {};
    var section = opts.section || '';
    var round = opts.round || 1;
    var rows = String(text || '').split(/\r\n|\r|\n/).map(_parseCsvLine);

    var header = (rows[0] || []).map(function(h) {
      return String(h || '').trim().toLowerCase();
    });
    var colOf = {};
    header.forEach(function(h, i) { if (colOf[h] == null) colOf[h] = i; });
    function idx(name) { return (colOf[name] != null) ? colOf[name] : -1; }
    var c = {
      board:  idx('board'),
      wFed:   idx('playerw.federation'), wTitle: idx('playerw.title'),
      wName:  idx('playerw.name'),       wRtg:   idx('playerw.rating'),
      bFed:   idx('playerb.federation'), bTitle: idx('playerb.title'),
      bName:  idx('playerb.name'),       bRtg:   idx('playerb.rating'),
      result: idx('result')
    };

    var tournament = { event: '', site: '', players: {}, pairings: {}, sections: [] };
    if (section) tournament.sections.push(section);
    var rk = _pairingKey(section, round);
    tournament.pairings[rk] = [];

    function cell(row, i) { return (i >= 0 && i < row.length) ? String(row[i] || '').trim() : ''; }

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var board = parseInt(cell(row, c.board), 10);
      if (isNaN(board)) continue;
      var wName = cell(row, c.wName);
      var bName = cell(row, c.bName);
      if (!wName || !bName) continue;   // bye / unpaired — one side blank

      tournament.pairings[rk].push({
        board: board, section: section,
        whiteSNo: null, blackSNo: null,
        whiteName: wName, blackName: bName,
        whiteRtg: parseInt(cell(row, c.wRtg), 10) || 0,
        blackRtg: parseInt(cell(row, c.bRtg), 10) || 0,
        whiteTitle: cell(row, c.wTitle), blackTitle: cell(row, c.bTitle),
        whiteFed: cell(row, c.wFed), blackFed: cell(row, c.bFed),
        whiteFideId: '', blackFideId: '',
        result: _csvRoundResult(cell(row, c.result)), date: ''
      });
    }
    tournament.pairings[rk].sort(function(a, b) { return a.board - b.board; });
    return tournament;
  }

  // Per-round result cell → PGN string. chessmanager writes a compact two-
  // symbol code, White's outcome then Black's, where each symbol is:
  //   win  = '1' or '+' (forfeit win)    loss = '0' or '-' (forfeit loss)
  //   draw = '=' or '½'/'5' (half point)
  // So: "10" (1-0), "01" (0-1), "==" / "½½" (draw), "+-" (white forfeit win
  // → 1-0), "-+" (black forfeit win → 0-1). Whole-cell bye/unplayed markers
  // "U "/"H "/"Z " → '*' (these rows are byes with one side blank anyway).
  // Verbose spellings ("1-0", "½-½", "1/2-1/2", "1:0", "draw") are accepted
  // defensively. Only consulted in the no-all-rounds fallback — with an
  // all-rounds file present, results come from there (boards donated by name).
  function _csvRoundResult(cell) {
    var s = String(cell || '').trim();
    if (!s) return '*';
    var low = s.toLowerCase();
    if (/^[uhz]/.test(low)) return '*';            // bye / unplayed / withdrawn
    if (low.indexOf('draw') >= 0) return '1/2-1/2';

    // Verbose separated form: "1-0", "0-1", "1:0", "½-½", "1/2-1/2", "0.5-0.5".
    var v = low.replace(/½/g, '5').replace(/1\/2/g, '5').replace(/0\.5/g, '5');
    var vm = v.match(/^([015])\s*[-:]\s*([015])$/);
    if (vm) return _wbResult(vm[1], vm[2]);

    // Compact two-symbol code [White][Black] over {1,0,=,+,-,½}.
    var compact = s.replace(/\s+/g, '').replace(/½/g, '5');
    if (compact.length === 2 && /^[10=+\-5]{2}$/.test(compact)) {
      return _wbResult(compact.charAt(0), compact.charAt(1));
    }
    return '*';
  }

  // Map a (White-symbol, Black-symbol) outcome pair to a PGN result string.
  // A draw on either side wins (both should agree); an inconsistent pair
  // (e.g. "00" double forfeit) returns '*'.
  function _wbResult(w, b) {
    function outcome(ch) {
      if (ch === '1' || ch === '+') return 'W';
      if (ch === '0' || ch === '-') return 'L';
      if (ch === '=' || ch === '5') return 'D';
      return '?';
    }
    var ow = outcome(w), ob = outcome(b);
    if (ow === 'D' || ob === 'D') return '1/2-1/2';
    if (ow === 'W' && ob === 'L') return '1-0';
    if (ow === 'L' && ob === 'W') return '0-1';
    return '*';
  }

  // =========================================================================
  // chessmanager.com roster CSV  (the "... - players.csv" and
  // "... - standings N.csv" exports)
  //
  // Both are header-driven roster tables keyed by the player's start `number`
  // (the same numbering the all-rounds file uses as Player No). players.csv
  // and standings.csv differ in column order and tiebreak columns, but both
  // expose number / name / rating / fide_id / federation / title / birthdate,
  // so one header-mapped parser handles both. No pairings are produced — this
  // file enriches the player roster only.
  // =========================================================================
  function parseChessManagerRosterCSV(text, opts) {
    var section = (opts && opts.section) || '';
    var rows = String(text || '').split(/\r\n|\r|\n/).map(_parseCsvLine);
    var header = (rows[0] || []).map(function(h) {
      return String(h || '').trim().toLowerCase();
    });
    var colOf = {};
    header.forEach(function(h, i) { if (colOf[h] == null) colOf[h] = i; });
    function idx() {
      for (var k = 0; k < arguments.length; k++) {
        if (colOf[arguments[k]] != null) return colOf[arguments[k]];
      }
      return -1;
    }
    var c = {
      number: idx('number'), name: idx('name'), rating: idx('rating'),
      title: idx('title'), fed: idx('federation'), fideId: idx('fide_id'),
      birth: idx('birthdate'), club: idx('club'), sex: idx('sex')
    };

    var tournament = { event: '', site: '', players: {}, pairings: {}, sections: [], fromRoster: true };
    if (section) tournament.sections.push(section);
    if (c.number < 0 || c.name < 0) {
      throw new Error('chessmanager roster CSV: missing "number"/"name" columns');
    }
    function cell(row, i) { return (i >= 0 && i < row.length) ? String(row[i] || '').trim() : ''; }

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var sno = parseInt(cell(row, c.number), 10);
      if (isNaN(sno)) continue;
      tournament.players[_playerKey(section, sno)] = {
        name: cell(row, c.name),
        rating: parseInt(cell(row, c.rating), 10) || 0,
        title: cell(row, c.title),
        fed: cell(row, c.fed),
        id: cell(row, c.fideId),
        birthdate: cell(row, c.birth),
        club: cell(row, c.club),
        sex: cell(row, c.sex),
        sno: sno, section: section
      };
    }
    return tournament;
  }

  // =========================================================================
  // chessmanager.com PGN-headers export (the "{id} - N.pgn" file)
  //
  // A per-round file of empty PGN game stubs — one [Event]…[Result] header
  // block per board, with movetext just "*". This is the richest single
  // chessmanager input: the board number is encoded directly in the Round tag
  // ("round.board", PGN §9.5 compound form — exactly what buildPgnHeaders
  // emits), so pairings come out board-numbered with no name-matching needed.
  // A file may hold one round or several; each game is placed by its own Round
  // tag. Players are identified by name (no player number / FIDE ID here).
  //
  // Guard: if any block carries real movetext (SAN moves, not just "*"), this
  // is a recorded-games PGN, not a pairings export — we throw so the caller
  // (and folder auto-detect) rejects it rather than fabricating pairings.
  // =========================================================================
  function parseChessManagerPgnHeaders(text, opts) {
    var section = (opts && opts.section) || '';
    var lines = String(text || '').split(/\r\n|\r|\n/);
    var tournament = { event: '', site: '', players: {}, pairings: {}, sections: [] };
    if (section) tournament.sections.push(section);

    var cur = null, hasMoves = false, gameCount = 0;
    function flush() {
      if (cur && (cur.White || cur.Black)) { _addPgnPairing(tournament, cur, section); gameCount++; }
      cur = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line === '') continue;
      var m = line.match(/^\[(\w+)\s+"(.*)"\]\s*$/);
      if (m) {
        // A fresh [Event] starts a new block even when no movetext separated them.
        if (m[1] === 'Event' && cur && (cur.White || cur.Black || cur.Round)) flush();
        if (!cur) cur = {};
        cur[m[1]] = m[2];
      } else {
        // Movetext line. Strip result tokens / move numbers — anything left is
        // a real move, which means this is a games PGN, not a pairings export.
        var mv = line.replace(/1-0|0-1|1\/2-1\/2|\*/g, '')
                     .replace(/\d+\.(\.\.)?/g, '').trim();
        if (mv !== '') hasMoves = true;
        flush();
      }
    }
    flush();
    if (hasMoves) {
      throw new Error('PGN contains game moves — looks like a recorded-games ' +
        'export, not a pairings/headers export');
    }
    if (gameCount === 0) {
      throw new Error('PGN headers: no game blocks with White/Black found');
    }
    return tournament;
  }

  function _addPgnPairing(td, h, section) {
    if (!h.White || !h.Black) return;   // bye / unpaired stub
    var round = null, board = null;
    if (h.Round) {
      var rp = String(h.Round).split('.');
      var r = parseInt(rp[0], 10);
      if (!isNaN(r)) round = r;
      if (rp.length > 1) {
        var b = parseInt(rp[1], 10);
        if (!isNaN(b)) board = b;
      }
    }
    if (round == null) return;   // can't place a game without a round
    if (!td.event && h.Event) td.event = h.Event;
    if (!td.site && h.Site) td.site = h.Site;
    var dateOk = h.Date && /^\d{4}\./.test(h.Date);
    if (!td.startDate && dateOk) td.startDate = h.Date;

    var rk = _pairingKey(section, round);
    if (!td.pairings[rk]) td.pairings[rk] = [];
    td.pairings[rk].push({
      board: board, section: section,
      whiteSNo: null, blackSNo: null,
      whiteName: h.White, blackName: h.Black,
      whiteRtg: parseInt(h.WhiteElo, 10) || 0,
      blackRtg: parseInt(h.BlackElo, 10) || 0,
      whiteTitle: h.WhiteTitle || '', blackTitle: h.BlackTitle || '',
      whiteFed: '', blackFed: '',
      whiteFideId: h.WhiteFideId || '', blackFideId: h.BlackFideId || '',
      result: _normalizeResult(h.Result || '*'),
      date: dateOk ? h.Date : (td.startDate || '')
    });
  }

  // =========================================================================
  // chessmanager file-family combiner. Given a set of chessmanager exports of
  // mixed kind (all-rounds CSV, per-round CSV, roster CSV, PGN-headers),
  // produce one tournamentData:
  //
  //   - The all-rounds file is authoritative for pairings, results, and event
  //     metadata. (When several are present — e.g. a folder holding two
  //     tournaments' exports — the richest one wins: most rounds, then most
  //     players.)
  //   - "Donor" files (per-round CSV + PGN-headers) donate board numbers onto
  //     the all-rounds pairings by name match. Results are NOT taken from them
  //     when an all-rounds file exists, sidestepping per-file result formats.
  //   - Roster files (players / standings) enrich player records (FIDE ID,
  //     birthdate, club) and back-fill pairing FIDE IDs.
  //   - Fallback with no all-rounds file: the donor files become the pairings
  //     directly (board-numbered, name-based), enriched from a roster. PGN
  //     donors also carry event/site/date, so those flow through too.
  // =========================================================================
  async function _combineChessManagerFiles(files) {
    var loaded = [];
    for (var i = 0; i < files.length; i++) {
      var text = await files[i].text();
      loaded.push({
        name: files[i].name, text: text,
        kind: _sniffChessManagerKind(files[i].name, text),
        round: _roundFromName(files[i].name)
      });
    }

    var rosterTd = null;
    loaded.filter(function(l) { return l.kind === 'roster'; }).forEach(function(l) {
      var td;
      try { td = parseChessManagerRosterCSV(l.text); } catch (e) { return; }
      rosterTd = rosterTd ? mergeTournamentData([rosterTd, td]) : td;
    });

    var allCandidates = loaded
      .filter(function(l) { return l.kind === 'allrounds'; })
      .map(function(l) { return parseChessManagerCSV(l.text); });
    var allTd = _pickRichestTournament(allCandidates);

    // Board donors: per-round CSVs (round# from filename) and PGN-headers
    // (round# from each game's Round tag). Both yield pairings[R{n}] with a
    // board number and player names. A broken donor is skipped, not fatal.
    var donorParts = [];
    loaded.filter(function(l) { return l.kind === 'round'; }).forEach(function(l) {
      try { donorParts.push(parseChessManagerRoundCSV(l.text, { round: l.round || 1 })); }
      catch (e) { /* skip unparseable donor */ }
    });
    loaded.filter(function(l) { return l.kind === 'pgn'; }).forEach(function(l) {
      try { donorParts.push(parseChessManagerPgnHeaders(l.text)); }
      catch (e) { /* not a pairings PGN (e.g. recorded games) — skip */ }
    });

    if (allTd) {
      donorParts.forEach(function(rt) {
        Object.keys(rt.pairings).forEach(function(rk) {
          _attachBoardsByName(allTd, rt, _roundOfKey(rk));
        });
      });
      if (rosterTd) _enrichPlayersFrom(allTd, rosterTd);
      _backfillPairingFideIds(allTd);
      return allTd;
    }

    // No all-rounds file: build pairings straight from the donor files.
    // Distinct round keys never collide, so a plain concat is safe (and avoids
    // mergeTournamentData's SNo-based dedup, which the null-SNo donor pairings
    // would trip over).
    if (donorParts.length > 0) {
      var td = { event: '', site: '', players: {}, pairings: {}, sections: [] };
      donorParts.forEach(function(rt) {
        if (!td.event && rt.event) td.event = rt.event;
        if (!td.site && rt.site) td.site = rt.site;
        if (!td.startDate && rt.startDate) td.startDate = rt.startDate;
        Object.keys(rt.pairings).forEach(function(rk) {
          td.pairings[rk] = (td.pairings[rk] || []).concat(rt.pairings[rk]);
        });
      });
      if (rosterTd) {
        Object.keys(rosterTd.players).forEach(function(k) {
          if (!td.players[k]) td.players[k] = Object.assign({}, rosterTd.players[k]);
        });
        _attachPairingMetaByName(td, rosterTd);
      }
      return td;
    }

    // Only a roster (no pairings) — return it so players are at least loaded.
    return rosterTd || { event: '', site: '', players: {}, pairings: {}, sections: [] };
  }

  // Header sniff across the whole chessmanager family (CSV + PGN).
  function _sniffChessManagerKind(name, text) {
    if (/\.pgn$/i.test(name || '') || /^\s*\[Event\b/.test(String(text || ''))) {
      return 'pgn';
    }
    return _sniffChessManagerCsvKind(text);
  }

  // Header sniff: which chessmanager CSV variant is this?
  function _sniffChessManagerCsvKind(text) {
    var lines = String(text || '').split(/\r\n|\r|\n/);
    var first = '';
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) { first = lines[i]; break; }
    }
    var low = first.toLowerCase();
    if (low.indexOf('playerw.name') >= 0 || /(^|,)\s*"?board"?\s*,/.test(low)) {
      return 'round';
    }
    if (low.indexOf('fide_id') >= 0 &&
        (low.indexOf('number') >= 0 || low.indexOf('place') >= 0)) {
      return 'roster';
    }
    return 'allrounds';
  }

  function _roundFromName(name) {
    var m = String(name || '').match(/round\s*[_-]?\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }
  function _roundOfKey(rk) {
    var m = String(rk).match(/R(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  }
  function _normName(n) {
    return String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  // Color-agnostic key for an unordered name pair.
  function _pairNameKey(a, b) {
    var x = _normName(a), y = _normName(b);
    return (x < y) ? (x + '||' + y) : (y + '||' + x);
  }

  function _pickRichestTournament(cands) {
    if (!cands || cands.length === 0) return null;
    return cands.slice().sort(function(a, b) {
      var ra = _countRounds(a), rb = _countRounds(b);
      if (rb !== ra) return rb - ra;
      return Object.keys(b.players).length - Object.keys(a.players).length;
    })[0];
  }

  // Donate per-round board numbers onto base pairings, matched by name pair.
  function _attachBoardsByName(baseTd, roundTd, round) {
    if (round == null) return;
    var baseList = baseTd.pairings[_pairingKey('', round)] || [];
    if (baseList.length === 0) return;
    var byPair = {};
    baseList.forEach(function(p) { byPair[_pairNameKey(p.whiteName, p.blackName)] = p; });
    var rList = roundTd.pairings[_pairingKey('', round)] || [];
    rList.forEach(function(rp) {
      var hit = byPair[_pairNameKey(rp.whiteName, rp.blackName)];
      if (hit && hit.board == null) hit.board = rp.board;
    });
  }

  function _enrichPlayersFrom(dst, srcTd) {
    Object.keys(srcTd.players).forEach(function(k) {
      var s = srcTd.players[k];
      if (!dst.players[k]) { dst.players[k] = Object.assign({}, s); return; }
      var d = dst.players[k];
      ['name', 'rating', 'title', 'fed', 'id', 'birthdate', 'club', 'sex'].forEach(function(f) {
        if (!d[f] && s[f]) d[f] = s[f];
      });
    });
  }

  function _backfillPairingFideIds(td) {
    Object.keys(td.pairings).forEach(function(rk) {
      td.pairings[rk].forEach(function(p) {
        var w = td.players[_playerKey('', p.whiteSNo)];
        var b = td.players[_playerKey('', p.blackSNo)];
        if (w && !p.whiteFideId && w.id) p.whiteFideId = w.id;
        if (b && !p.blackFideId && b.id) p.blackFideId = b.id;
      });
    });
  }

  // No-all-rounds fallback: fill pairing rtg/fideId from a roster, matched by
  // name (the per-round pairings have no player number to key on).
  function _attachPairingMetaByName(td, rosterTd) {
    var byName = {};
    Object.keys(rosterTd.players).forEach(function(k) {
      var p = rosterTd.players[k];
      if (p.name) byName[_normName(p.name)] = p;
    });
    Object.keys(td.pairings).forEach(function(rk) {
      td.pairings[rk].forEach(function(p) {
        var w = byName[_normName(p.whiteName)];
        var b = byName[_normName(p.blackName)];
        if (w) {
          if (!p.whiteFideId && w.id) p.whiteFideId = w.id;
          if (!p.whiteRtg && w.rating) p.whiteRtg = w.rating;
          if (!p.whiteTitle && w.title) p.whiteTitle = w.title;
        }
        if (b) {
          if (!p.blackFideId && b.id) p.blackFideId = b.id;
          if (!p.blackRtg && b.rating) p.blackRtg = b.rating;
          if (!p.blackTitle && b.title) p.blackTitle = b.title;
        }
      });
    });
  }

  // =========================================================================
  // Tournament-data merge — used to combine a crosstable (rich player meta
  // + no board numbers) with one or more per-round pairings files (board
  // numbers + results, no ratings or federation in the MCC export profile).
  //
  // Strategy:
  //   - Player records merge by SNo. Non-empty crosstable fields win over
  //     empty per-round fields, and vice-versa (last writer of a non-empty
  //     value wins, but never overwrites a non-empty value with an empty one).
  //   - Pairing lists merge by round key. Pairings carrying a real board
  //     number always win over board=null entries from the crosstable. If
  //     both a per-round and a crosstable pairing exist for the same
  //     (round, players) tuple, we keep the per-round one and discard the
  //     crosstable shadow.
  //   - Tournament metadata (event, site, organizer, arbiter, startDate,
  //     endDate, country, fromCrosstable) prefers non-empty fields.
  //   - After merging, per-pairing rtg/title/fed fields are back-filled from
  //     the merged player records when they're missing on the pairing
  //     itself. This is what makes the per-round files inherit ratings from
  //     the crosstable.
  // =========================================================================
  function mergeTournamentData(parts) {
    if (!Array.isArray(parts) || parts.length === 0) return null;
    if (parts.length === 1) return parts[0];

    var merged = {
      event: '', site: '', players: {}, pairings: {}, sections: []
    };

    function mergeNonEmpty(target, key, value) {
      if (value && String(value).trim() && !target[key]) {
        target[key] = value;
      } else if (value && String(value).trim()) {
        // Both present — keep first non-empty unless target is shorter/placeholder.
        if (!target[key] || target[key] === '?' || target[key] === '-') {
          target[key] = value;
        }
      }
    }

    parts.forEach(function(td) {
      if (!td) return;
      ['event', 'site', 'organizer', 'chiefArbiter',
       'startDate', 'endDate', 'country'].forEach(function(k) {
        mergeNonEmpty(merged, k, td[k]);
      });
      if (td.fromCrosstable) merged.fromCrosstable = true;
      (td.sections || []).forEach(function(s) {
        if (merged.sections.indexOf(s) < 0) merged.sections.push(s);
      });
      Object.keys(td.players || {}).forEach(function(snoKey) {
        var p = td.players[snoKey];
        if (!merged.players[snoKey]) {
          merged.players[snoKey] = Object.assign({}, p);
        } else {
          var mp = merged.players[snoKey];
          ['name', 'rating', 'title', 'fed', 'id'].forEach(function(field) {
            if (!mp[field] && p[field]) mp[field] = p[field];
          });
        }
      });
      Object.keys(td.pairings || {}).forEach(function(rk) {
        if (!merged.pairings[rk]) merged.pairings[rk] = [];
        (td.pairings[rk] || []).forEach(function(np) {
          var aNew = Math.min(np.whiteSNo, np.blackSNo);
          var bNew = Math.max(np.whiteSNo, np.blackSNo);
          var existingIdx = -1;
          for (var ei = 0; ei < merged.pairings[rk].length; ei++) {
            var ep = merged.pairings[rk][ei];
            var aOld = Math.min(ep.whiteSNo, ep.blackSNo);
            var bOld = Math.max(ep.whiteSNo, ep.blackSNo);
            if (aOld === aNew && bOld === bNew) { existingIdx = ei; break; }
          }
          if (existingIdx < 0) {
            merged.pairings[rk].push(Object.assign({}, np));
          } else {
            // Merge: prefer the entry with a real board number.
            var ep = merged.pairings[rk][existingIdx];
            var keepNew = (np.board != null && ep.board == null);
            var base = keepNew ? np : ep;
            var addl = keepNew ? ep : np;
            var combined = Object.assign({}, base);
            ['whiteName', 'blackName', 'whiteRtg', 'blackRtg',
             'whiteTitle', 'blackTitle', 'whiteFed', 'blackFed',
             'result', 'date'].forEach(function(field) {
              if ((!combined[field] || combined[field] === '*') && addl[field]) {
                combined[field] = addl[field];
              }
            });
            merged.pairings[rk][existingIdx] = combined;
          }
        });
        merged.pairings[rk].sort(function(a, b) {
          var ba = (a.board == null) ? 9999 : a.board;
          var bb = (b.board == null) ? 9999 : b.board;
          return ba - bb;
        });
      });
    });

    // Back-fill pairing rtg/title/fed from merged player records. Lookup
    // honours the pairing's section so per-section player tables stay
    // isolated (an "OPEN player #1" cannot accidentally pull from a
    // "U1800 player #1" record).
    Object.keys(merged.pairings).forEach(function(rk) {
      merged.pairings[rk].forEach(function(p) {
        var w = merged.players[_playerKey(p.section || '', p.whiteSNo)];
        var b = merged.players[_playerKey(p.section || '', p.blackSNo)];
        if (w) {
          if (!p.whiteName && w.name) p.whiteName = w.name;
          if (!p.whiteRtg && w.rating) p.whiteRtg = w.rating;
          if (!p.whiteTitle && w.title) p.whiteTitle = w.title;
          if (!p.whiteFed && w.fed) p.whiteFed = w.fed;
        }
        if (b) {
          if (!p.blackName && b.name) p.blackName = b.name;
          if (!p.blackRtg && b.rating) p.blackRtg = b.rating;
          if (!p.blackTitle && b.title) p.blackTitle = b.title;
          if (!p.blackFed && b.fed) p.blackFed = b.fed;
        }
      });
    });

    return merged;
  }

  // =========================================================================
  // Multi-file tournament loader. Accepts a FileList / File[] of mixed
  // SwissManager exports — per-round pairings, crosstable, or a single
  // SwissSys SJSON — sniffs the type of each one, parses it, then merges.
  //
  // File-type detection priority:
  //   1. Filename hints: "crosstable" / "tiebreak" / "standings" / "ranking"
  //      → crosstable; "round" / "pairings" → per-round.
  //   2. Structural sniff: if the sheet's first 30 rows include a row whose
  //      first cell starts with "Rank", treat as crosstable; otherwise
  //      per-round.
  // =========================================================================
  async function parseTournamentFiles(files) {
    if (!files || files.length === 0) throw new Error('No tournament files provided');
    var fileArray = Array.from(files);
    if (fileArray.length === 1) return parseTournamentFile(fileArray[0]);

    function extOf(f) { return (f.name.split('.').pop() || '').toLowerCase(); }
    function isFamily(f) { var e = extOf(f); return e === 'csv' || e === 'pgn'; }
    var familyFiles = fileArray.filter(isFamily);
    var otherFiles = fileArray.filter(function(f) { return !isFamily(f); });

    var parts = [];

    // chessmanager.com export family (CSV + PGN-headers) — combined together
    // so per-round / PGN files can donate board numbers onto the all-rounds
    // pairings by name, which a per-file parse + generic merge cannot do.
    if (familyFiles.length > 0) {
      parts.push(await _combineChessManagerFiles(familyFiles));
    }

    if (otherFiles.length > 0) {
      var needsXlsx = otherFiles.some(function(f) {
        var e = extOf(f);
        return e === 'xls' || e === 'xlsx';
      });
      if (needsXlsx) await _ensureXlsxLoaded();
      for (var i = 0; i < otherFiles.length; i++) {
        var file = otherFiles[i];
        var ext = extOf(file);
        if (ext === 'sjson' || ext === 'json') {
          parts.push(await parseTournamentFile(file));
          continue;
        }
        if (ext !== 'xls' && ext !== 'xlsx') continue;
        var buffer = await file.arrayBuffer();
        var kind = _sniffXlsKind(file.name, buffer);
        var sec = extractSectionFromFilename(file.name);
        var sectionOpts = sec ? { section: sec } : undefined;
        if (kind === 'crosstable') {
          parts.push(parseSwissManagerCrosstableXLS(buffer, sectionOpts));
        } else {
          parts.push(parseSwissManagerXLS(buffer, sectionOpts));
        }
      }
    }

    if (parts.length === 0) throw new Error('No parseable tournament files found');
    if (parts.length === 1) return parts[0];
    return mergeTournamentData(parts);
  }

  function _sniffXlsKind(fileName, buffer) {
    if (/crosstable|tiebreak|standings|ranking|berger/i.test(fileName)) {
      return 'crosstable';
    }
    if (/round|pairing/i.test(fileName)) return 'per-round';
    // Structural fallback: peek at the sheet.
    try {
      var wb = XLSX.read(buffer, { type: 'array' });
      var sheet = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      for (var i = 0; i < Math.min(rows.length, 30); i++) {
        var first = String(rows[i][0] || '').trim();
        if (/^Rank\b/i.test(first)) return 'crosstable';
        if (/^Round\s+\d+/i.test(first)) return 'per-round';
      }
    } catch (e) { /* fall through */ }
    return 'per-round';
  }

  // =========================================================================
  // Swiss / Round-Robin auto-detection
  //
  // Heuristic:
  //   - Round Robin if rounds == players-1 (even player count) OR
  //     rounds == players (odd count, with one bye per round)
  //     AND every unordered player-pair appears at most once across all
  //     rounds.
  //   - Swiss otherwise.
  //
  // Returns 'round robin' or 'swiss'. Tournaments with too little data
  // (no players, no rounds) return null so callers can fall back to a
  // default rather than picking one.
  // =========================================================================
  function detectEventType(td) {
    if (!td || !td.players || !td.pairings) return null;
    var playerCount = Object.keys(td.players).length;
    var roundKeys = Object.keys(td.pairings);
    if (playerCount === 0 || roundKeys.length === 0) return null;
    var seen = {};
    var rematch = false;
    roundKeys.forEach(function(rk) {
      (td.pairings[rk] || []).forEach(function(p) {
        if (!p.whiteSNo || !p.blackSNo) return;
        var a = Math.min(p.whiteSNo, p.blackSNo);
        var b = Math.max(p.whiteSNo, p.blackSNo);
        var key = a + 'v' + b;
        if (seen[key]) rematch = true;
        seen[key] = true;
      });
    });
    if (!rematch &&
        (roundKeys.length === playerCount - 1 ||
         roundKeys.length === playerCount)) {
      return 'round robin';
    }
    return 'swiss';
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

    // Section-relative offset fallback. SwissManager assigns absolute
    // board numbers across the whole playing hall — e.g. OPEN gets
    // boards 1-14, U1800 gets 15-41, U1300 gets 42-57. A user labelling
    // stubs "b1.jpg" inside the U1300 folder means "the first board in
    // U1300", not "the absolute board 1 (which is OPEN's top board)".
    //
    // We only fire this when ALL of these hold:
    //   1. The exact (section, round, board) match above already failed.
    //   2. There is at least one pairing for this (section, round).
    //   3. The section's lowest pairing board > 1 — a clear signal that
    //      this section uses absolute (not 1-based) numbering. Sections
    //      starting at board 1 keep strict exact matching.
    //   4. The user's board is within 1..count_of_pairings — prevents a
    //      stray "b100" from being silently remapped into a real
    //      pairing.
    //
    // When triggered, we add (min_board - 1) to the user's board and
    // re-look up. Correctly-named stubs always win the exact match
    // above and never reach this code, so no surprises for users who
    // already use absolute numbers.
    for (var ci = 0; ci < candidates.length; ci++) {
      var clist = tournamentData.pairings[candidates[ci]] || [];
      if (clist.length === 0) continue;
      var minBoard = Infinity;
      for (var bi = 0; bi < clist.length; bi++) {
        if (clist[bi].board != null && clist[bi].board < minBoard) {
          minBoard = clist[bi].board;
        }
      }
      if (minBoard === Infinity || minBoard <= 1) continue;
      if (board < 1 || board > clist.length) continue;
      var adjusted = board + (minBoard - 1);
      var offsetHit = clist.find(function(p) { return p.board === adjusted; });
      if (offsetHit) return offsetHit;
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
        // Adopt the XLS's board number as the canonical one for this
        // game. The filename's board may have been a short-form local
        // index ("R5B3.jpg" inside U1300) that matchGameToPairing
        // resolved to the actual playing-hall board (44). Carry the
        // original on scanBoard for diagnostics / file-name correlation.
        //
        // EXCEPTION: a directory-derived board ("Premier/Round 2/Board 6/")
        // is the reliable playing-hall number — it's what's written on the
        // scoresheet. Never let the tournament file override it. This is the
        // inverse of the U1300 case above: here the FILE numbers a section's
        // round-robin pairings locally (1-5) while the FOLDERS use the
        // absolute hall numbers (6-10). Trust the folders. (See CLAUDE.md:
        // "Trust directory structure".)
        if (p.board != null && p.board !== game.board && !game.boardFromDirectory) {
          if (game.scanBoard == null) game.scanBoard = game.board;
          game.board = p.board;
        }
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
        // Same adoption as Pass 1: replace scan-folder board with the
        // XLS's actual playing-hall board number, preserving the
        // original under scanBoard. Same directory-derived carve-out:
        // a board read from "…/Board 6/" is the real hall number and must
        // not be overwritten by a section-local pairing index.
        if (availablePairings[i].board != null &&
            availablePairings[i].board !== gamesInRound[i].board &&
            !gamesInRound[i].boardFromDirectory) {
          if (gamesInRound[i].scanBoard == null) {
            gamesInRound[i].scanBoard = gamesInRound[i].board;
          }
          gamesInRound[i].board = availablePairings[i].board;
        }
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
   *
   * Round is emitted in PGN §9.5 compound form ("R.B" — round.board) when both
   * are known, matching the convention used by ChessBase and chess-results.com.
   * The non-standard `Board` tag is intentionally not emitted.
   *
   * @param {Object} game - {section, round, board, pairing?, gameId}
   * @param {Object} [tournamentData]
   * @param {Object} [extra] - Override/append headers (e.g., {Site: 'Toronto'})
   * @returns {Object} - Standard seven-tag roster plus optional ratings, IDs,
   *                     titles, and Event* metadata derived from tournamentData.
   */
  function buildPgnHeaders(game, tournamentData, extra) {
    game = game || {};
    extra = extra || {};
    var pairing = game.pairing ||
                  (tournamentData ? matchGameToPairing(game, tournamentData) : null);

    var roundStr;
    if (game.round != null && game.board != null) {
      roundStr = game.round + '.' + game.board;
    } else if (game.round != null) {
      roundStr = String(game.round);
    } else if (game.board != null) {
      roundStr = '?.' + game.board;
    } else {
      roundStr = extra.Round || '?';
    }

    var headers = {
      Event: (tournamentData && tournamentData.event) || extra.Event || 'Tournament',
      Site: (tournamentData && tournamentData.site) || extra.Site || '?',
      Date: extra.Date || (pairing && pairing.date) ||
            (tournamentData && tournamentData.startDate) ||
            new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      Round: roundStr,
      White: (pairing && pairing.whiteName) || extra.White || '?',
      Black: (pairing && pairing.blackName) || extra.Black || '?',
      Result: (pairing && pairing.result) || extra.Result || '*',
      Source: 'Zugwise (gerhardtrippen.github.io/Zugwise)'
    };

    if (game.section) headers.Section = game.section;

    if (pairing) {
      if (pairing.whiteRtg) headers.WhiteElo = String(pairing.whiteRtg);
      if (pairing.blackRtg) headers.BlackElo = String(pairing.blackRtg);
      if (pairing.whiteTitle) headers.WhiteTitle = pairing.whiteTitle;
      if (pairing.blackTitle) headers.BlackTitle = pairing.blackTitle;
      if (pairing.whiteId) headers.WhiteCfcId = String(pairing.whiteId);
      if (pairing.blackId) headers.BlackCfcId = String(pairing.blackId);
      // chessmanager exports carry a FIDE ID rather than a CFC number.
      if (pairing.whiteFideId) headers.WhiteFideId = String(pairing.whiteFideId);
      if (pairing.blackFideId) headers.BlackFideId = String(pairing.blackFideId);
    }

    if (tournamentData) {
      if (tournamentData.startDate) headers.EventDate = tournamentData.startDate;
      if (tournamentData.country) headers.EventCountry = tournamentData.country;
      // Prefer the structurally-detected type when available; fall back to the
      // generic "tourn" tag for backward compatibility with existing exports.
      var detected = tournamentData.eventType ||
                     (typeof detectEventType === 'function' ? detectEventType(tournamentData) : null);
      headers.EventType = detected || 'tourn';
      var rounds = _countRounds(tournamentData);
      if (rounds > 0) headers.EventRounds = String(rounds);
    }

    // Caller overrides win.
    Object.keys(extra).forEach(function(k) { headers[k] = extra[k]; });
    return headers;
  }

  function _countRounds(tournamentData) {
    if (!tournamentData || !tournamentData.pairings) return 0;
    var seen = {};
    Object.keys(tournamentData.pairings).forEach(function(k) {
      var m = k.match(/_R(\d+)$|^R(\d+)$/);
      if (m) seen[parseInt(m[1] || m[2])] = true;
    });
    return Object.keys(seen).length;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    parseTournamentFile: parseTournamentFile,
    parseTournamentFiles: parseTournamentFiles,
    parseSwissSysSJSON: parseSwissSysSJSON,
    parseSwissManagerXLS: parseSwissManagerXLS,
    parseSwissManagerCrosstableXLS: parseSwissManagerCrosstableXLS,
    parseChessManagerCSV: parseChessManagerCSV,
    parseChessManagerRoundCSV: parseChessManagerRoundCSV,
    parseChessManagerRosterCSV: parseChessManagerRosterCSV,
    parseChessManagerPgnHeaders: parseChessManagerPgnHeaders,
    mergeTournamentData: mergeTournamentData,
    detectEventType: detectEventType,
    extractSectionFromFilename: extractSectionFromFilename,
    matchGameToPairing: matchGameToPairing,
    attachPairings: attachPairings,
    buildPgnHeaders: buildPgnHeaders
  };
})();

// Expose globally (consistent with other batch-mode modules).
window.BatchTournament = BatchTournament;
