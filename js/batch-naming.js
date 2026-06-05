// =============================================================================
// batch-naming.js — Directory-path inference, filename convention, game grouping
// =============================================================================
// Phase 1 of Batch Mode. Handles two tracks:
//   Track A: Directory-based inference (real-world TD submissions)
//   Track B: Filename convention {Section}R{Round}B{Board}p{Page}.ext (optional)
// Also handles PDF detection and recursive directory traversal.
// =============================================================================

var BatchNaming = (function() {
  'use strict';

  // =========================================================================
  // Track B: Filename convention parser
  // =========================================================================

  /**
   * Parse a Zugwise image filename into structured metadata.
   *
   * Accepts any combination of r/b/p tokens in any order, case-insensitive,
   * with optional [-_] separators between tokens. Each token is one of the
   * letter prefixes (r, rd, rnd, round | b, bd, board | p, page) followed
   * immediately by digits. The section name, if present, is whatever sits
   * before the first such token.
   *
   * Returns null when neither a board nor a round token is found — the
   * caller will then rely on directory inference for that file.
   *
   * Examples:
   *   "b1.jpg"               → {board:1}             (round/section from dir)
   *   "b3p2.jpg"             → {board:3, page:2}     (round/section from dir)
   *   "r1b7p3.jpg"           → {round:1, board:7, page:3}
   *   "R1B7p3.jpg"           → {round:1, board:7, page:3}
   *   "R1-B7-P3.jpg"         → {round:1, board:7, page:3}
   *   "OpenR1B4p1.jpg"       → {section:"Open", round:1, board:4, page:1}
   *   "Round1Board7Page3.jpg"→ {round:1, board:7, page:3}
   *   "IMG_0001.jpg"         → null (no r/b token; falls back to dir)
   *   "scoresheet_p1.jpg"    → null (only page; can't identify a board)
   *
   * @param {string} filename
   * @returns {Object|null} - {section, round, board, page, filename}
   */
  function parseImageFilename(filename) {
    var base = filename.replace(/\.\w+$/, '');
    var result = {
      section: null, round: null, board: null, page: null, filename: filename
    };

    // Tokenize. Each token: long-or-short letter prefix + optional separator
    // + digits. We walk via re.exec to capture token start positions, which
    // we need to locate the section (everything before the first token).
    var re = /(round|rnd|rd|r|board|bd|b|page|p)\s*[-_]?\s*(\d+)/gi;
    var anyMatch = false, firstTokenStart = base.length;
    while (true) {
      var m = re.exec(base);
      if (!m) break;
      anyMatch = true;
      if (m.index < firstTokenStart) firstTokenStart = m.index;
      var letter = m[1].toLowerCase()[0];
      var num = parseInt(m[2]);
      if (letter === 'r' && result.round === null) result.round = num;
      else if (letter === 'b' && result.board === null) result.board = num;
      else if (letter === 'p' && result.page === null) result.page = num;
    }

    if (!anyMatch) return null;
    // A filename carrying only a page number ("p1.jpg", "scoresheet_p3.jpg")
    // can't identify a game on its own — neither the round nor the board is
    // known. Reject so the caller falls back to directory inference (which
    // is the right source for round/board in that case).
    if (result.board === null && result.round === null) return null;

    if (firstTokenStart > 0) {
      var head = base.substring(0, firstTokenStart).replace(/[-_\s]+$/, '');
      if (head) result.section = head;
    }
    return result;
  }

  /**
   * Parse a Zugwise OCR output filename.
   * Format: {Section}R{Round}B{Board}{Color}.txt
   * @param {string} filename - e.g. "U1000R2B42W.txt"
   * @returns {Object|null} - {section, round, board, color}
   */
  function parseOcrFilename(filename) {
    var base = filename.replace(/\.\w+$/, '');
    var match = base.match(/^(.+?)R(\d+)B(\d+)([WB])$/);
    if (!match) return null;
    return {
      section: match[1],
      round: parseInt(match[2]),
      board: parseInt(match[3]),
      color: match[4] === 'W' ? 'w' : 'b'
    };
  }

  // =========================================================================
  // Track A: Directory-based inference
  // =========================================================================

  /**
   * Infer section, round, and board from a file's directory path.
   * Handles common real-world patterns:
   *   "Premier/Round 2/Board 9/file.pdf"
   *   "Crown/Rd 3/Bd 5/file.jpg"
   *   "Open/R1/B4/file.pdf"
   *   "U1300/Round3/Board27/file.jpg"
   *
   * @param {string} relativePath - e.g. "Premier/Round 2/Board 9/Antarip Vs Vihaan P1.pdf"
   * @returns {Object|null} - {section, round, board, filename, page} or null
   */
  function inferFromDirectoryPath(relativePath) {
    var parts = relativePath.split('/');
    if (parts.length < 2) return null;

    var result = {
      section: null,
      round: null,
      board: null,
      filename: parts[parts.length - 1],
      page: null
    };

    // Walk path components looking for recognizable patterns
    for (var i = 0; i < parts.length - 1; i++) {
      var part = parts[i].trim();

      // Try to extract round number: "Round 2", "Rd 3", "R1", "Round3"
      var roundMatch = part.match(/^(?:Round|Rd|R)\s*(\d+)$/i);
      if (roundMatch) {
        result.round = parseInt(roundMatch[1]);
        continue;
      }

      // Try to extract board number: "Board 9", "Bd 5", "B4", "Board27"
      var boardMatch = part.match(/^(?:Board|Bd|B)\s*(\d+)$/i);
      if (boardMatch) {
        result.board = parseInt(boardMatch[1]);
        continue;
      }

      // If no round or board pattern, treat as section name
      if (!result.section) {
        result.section = part;
      }
    }

    // Try to infer page number from filename
    var pageMatch = result.filename.match(/[Pp](?:age)?\s*(\d+)/);
    if (pageMatch) {
      result.page = parseInt(pageMatch[1]);
    }

    return result;
  }

  // =========================================================================
  // Recursive directory traversal (File System Access API)
  // =========================================================================

  /**
   * Recursively read all files from a directory tree.
   * @param {FileSystemDirectoryHandle} dirHandle
   * @param {string} basePath - relative path accumulator
   * @returns {Promise<Array<{name, path, handle, file}>>}
   */
  async function readDirectoryRecursive(dirHandle, basePath) {
    basePath = basePath || '';
    var files = [];
    for await (var entry of dirHandle.values()) {
      var entryPath = basePath ? basePath + '/' + entry.name : entry.name;
      if (entry.kind === 'file') {
        var file = await entry.getFile();
        files.push({
          name: entry.name,
          path: entryPath,
          handle: entry,
          file: file
        });
      } else if (entry.kind === 'directory') {
        // Skip Zugwise's own output subtree (PGN/OCR/grid) — it holds only
        // generated artifacts, never source scans (see batch-folder-paths.js).
        if (window.BatchPaths && entry.name === window.BatchPaths.ROOT_DIR) {
          continue;
        }
        var children = await readDirectoryRecursive(entry, entryPath);
        files = files.concat(children);
      }
    }
    return files;
  }

  // =========================================================================
  // File type detection
  // =========================================================================

  var SCAN_FILE_REGEX = /\.(jpg|jpeg|png|tiff?|pdf)$/i;

  /**
   * Check if a filename is a supported scan file (image or PDF).
   * @param {string} filename
   * @returns {boolean}
   */
  function isScanFile(filename) {
    return SCAN_FILE_REGEX.test(filename);
  }

  /**
   * Check if a filename is a PDF.
   * @param {string} filename
   * @returns {boolean}
   */
  function isPDF(filename) {
    return /\.pdf$/i.test(filename);
  }

  // =========================================================================
  // Game grouping
  // =========================================================================

  /**
   * Group discovered files into games.
   * A "game" is identified by (section, round, board).
   * Uses two-track approach: directory inference first, filename convention fallback.
   *
   * @param {Array} files - Array of {name, path, handle, file}
   * @param {Object} [opts] - Optional options.
   * @param {string} [opts.defaultSection] - Section name to use when neither
   *   directory inference nor filename convention yielded one. Used when the
   *   user picked a section folder directly via showDirectoryPicker — the
   *   picked folder's name is not part of the per-file paths returned by the
   *   File System Access API, so without this fallback the section field
   *   stays empty.
   * @returns {Object} - {games: Map<string, Object>, unmatched: Array}
   *   Each game: {gameId, section, round, board, files: [...]}
   */
  function groupFilesIntoGames(files, opts) {
    var games = new Map();
    var unmatched = [];
    var defaultSection = (opts && opts.defaultSection) || null;

    // Filter to scan files only
    var scanFiles = files.filter(function(f) {
      return isScanFile(f.name);
    });

    // Always log what came in, even when no duplicates -- helps confirm
    // groupFilesIntoGames is the path producing game.files (vs some other
    // code path that bypasses this function).
    console.log('[GROUP-FILES] groupFilesIntoGames called with ' +
                files.length + ' input file(s), ' + scanFiles.length +
                ' after scan-file filter');
    var _seenKeys = {};
    var _dupes = [];
    scanFiles.forEach(function(f) {
      var key = (f.path || '') + '|' + (f.name || '');
      if (_seenKeys[key]) _dupes.push({ key: key, name: f.name, path: f.path || '(no path)' });
      _seenKeys[key] = true;
    });
    if (_dupes.length > 0) {
      console.warn('[GROUP-FILES] BEFORE dedup: ' + _dupes.length +
                   ' duplicate(s) by path+name:');
      _dupes.forEach(function(d) {
        console.warn('  dup: name=' + d.name + ' path=' + d.path);
      });
    }
    // Also surface name-only duplicates so we can see if path differs.
    var _nameSeen = {};
    var _nameDupes = [];
    scanFiles.forEach(function(f) {
      var n = f.name || '';
      if (_nameSeen[n]) _nameDupes.push({ name: n, path: f.path || '(no path)' });
      _nameSeen[n] = true;
    });
    if (_nameDupes.length > 0 && _nameDupes.length !== _dupes.length) {
      console.warn('[GROUP-FILES] BEFORE dedup: ' + _nameDupes.length +
                   ' duplicate(s) by NAME-only (different paths):');
      _nameDupes.forEach(function(d) {
        console.warn('  dup-by-name: name=' + d.name + ' path=' + d.path);
      });
    }

    // Dedup by path+name. The original assumption ("tournament directories
    // never have two scoresheet files with identical names") doesn't hold
    // up in practice — real TD submissions routinely have generic names
    // like page1.pdf, IMG_0123.jpg, scoresheet.pdf repeated across boards
    // because that's what scanners and phone apps emit by default.
    // Dropping by name-only collapsed legitimate per-board scans into one
    // game; e.g. OPEN/Round 1/Board 2/p1.jpg and OPEN/Round 1/Board 3/p1.jpg
    // both got discarded as "duplicates" of OPEN/Round 1/Board 1/p1.jpg.
    // Path+name still catches the original target of the dedup (a single
    // physical file walked via two paths — directory + symlink/shortcut),
    // because true aliases produce the same (path, name) tuple via the
    // recursive walk.
    var seenKeys = {};
    var dedupCount = 0;
    scanFiles = scanFiles.filter(function(f) {
      var key = ((f.path || '') + '|' + (f.name || '')).toLowerCase();
      if (seenKeys[key]) {
        dedupCount++;
        console.warn('[GROUP-FILES] DROPPING duplicate: name=' + f.name +
                     ' path=' + (f.path || '(no path)'));
        return false;
      }
      seenKeys[key] = true;
      return true;
    });
    if (dedupCount > 0) {
      console.warn('[GROUP-FILES] Dropped ' + dedupCount +
                   ' duplicate file entries (path+name dedup). ' +
                   scanFiles.length + ' unique files remain.');
    }

    // Second-pass content dedup. The path+name pass above only catches a
    // single physical file revisited via the same path during the walk.
    // Real-world tournament folders often have the same sheet reachable via
    // multiple paths — e.g. "Crown/Round 1/Board 1/sheet1.pdf" AND
    // "Crown/Crown/Round 1/Board 1/sheet1.pdf" when a TD nests a backup copy
    // of the section folder inside itself. Both paths point to byte-identical
    // files, but path+name differ so the first pass keeps both. They then
    // collide on (section, round, board), get appended into one game's
    // files[] as 6 entries instead of 3, and the OCR queue iterates each
    // twice — doubling cell counts and runtime. Fingerprint by
    // (name, size, lastModified) per File object: a real duplicate scan
    // matches all three, while same-named files from different boards
    // (IMG_0001.jpg from two phones) diverge on size and/or mtime.
    var seenFingerprints = {};
    var contentDupes = 0;
    scanFiles = scanFiles.filter(function(f) {
      var file = f.file;
      if (!file || typeof file.size !== 'number') return true;  // can't fingerprint
      var fp = (f.name || '').toLowerCase() + '|' + file.size + '|' +
               (file.lastModified || 0);
      if (seenFingerprints[fp]) {
        contentDupes++;
        console.warn('[GROUP-FILES] DROPPING content-duplicate: name=' + f.name +
                     ' path=' + (f.path || '(no path)') +
                     ' (size=' + file.size + ', mtime=' + (file.lastModified || 0) +
                     ' already seen at: ' + seenFingerprints[fp] + ')');
        return false;
      }
      seenFingerprints[fp] = f.path || '(no path)';
      return true;
    });
    if (contentDupes > 0) {
      console.warn('[GROUP-FILES] Dropped ' + contentDupes +
                   ' content-duplicate file entries (name+size+mtime). ' +
                   scanFiles.length + ' unique files remain.');
    } else if (dedupCount === 0) {
      console.log('[GROUP-FILES] No duplicates found. ' + scanFiles.length +
                  ' unique files proceed to grouping.');
    }

    scanFiles.forEach(function(f) {
      // Combine Track A (directory inference) and Track B (filename
      // convention) field-by-field. Either alone may be incomplete:
      //   - "Round 1/Board 5/IMG_0001.jpg" → A has round+board, B is null
      //   - "scans/b3p2.jpg"               → A has neither, B has board+page
      //   - "scans/Round 1/b3p2.jpg"       → A has round, B has board+page
      // Filename wins for round/board/page (it's more specific and the
      // user typed it deliberately); directory wins for section because
      // sections are almost always folder names.
      var dirMeta = inferFromDirectoryPath(f.path) || {};
      var fnMeta  = parseImageFilename(f.name)    || {};
      var meta = {
        section: dirMeta.section || fnMeta.section || null,
        round:   (fnMeta.round  != null) ? fnMeta.round  : (dirMeta.round  || null),
        board:   (fnMeta.board  != null) ? fnMeta.board  : (dirMeta.board  || null),
        page:    (fnMeta.page   != null) ? fnMeta.page   : (dirMeta.page   || null),
        filename: f.name
      };

      if (meta.round === null || meta.board === null) {
        unmatched.push(f);
        return;
      }

      // Section fallback — only fills the slot if neither inference path
      // already produced one. Multi-section layouts (Tournament/Premier/…)
      // keep the inferred per-section name.
      if (!meta.section && defaultSection) {
        meta.section = defaultSection;
      }

      var gameId = (meta.section || 'Unknown') + '_R' + meta.round + '_B' + meta.board;

      if (!games.has(gameId)) {
        games.set(gameId, {
          gameId: gameId,
          section: meta.section,
          round: meta.round,
          board: meta.board,
          files: []
        });
      }

      games.get(gameId).files.push({
        name: f.name,
        path: f.path,
        handle: f.handle,
        file: f.file,
        page: meta.page || null,
        isPDF: isPDF(f.name)
      });
    });

    // Sort files within each game by page number, then by name
    games.forEach(function(game) {
      game.files.sort(function(a, b) {
        if (a.page !== null && b.page !== null) return a.page - b.page;
        if (a.page !== null) return -1;
        if (b.page !== null) return 1;
        return a.name.localeCompare(b.name);
      });
    });

    return { games: games, unmatched: unmatched };
  }

  /**
   * Get unique round numbers from a set of games, optionally narrowed to
   * one section. Pass `opts.section` to count only games in that section —
   * this is what makes the round dropdown shrink to "rounds in OPEN" once
   * a section is selected in a multi-section tournament.
   *
   * @param {Map<string, Object>} games - From groupFilesIntoGames()
   * @param {Object} [opts]
   * @param {string} [opts.section] - When set, only count games whose
   *   `game.section` matches (case-sensitive).
   * @returns {Array<{round: number, gameCount: number}>} - Sorted by round number
   */
  function getAvailableRounds(games, opts) {
    var section = (opts && opts.section) || null;
    var roundCounts = {};
    games.forEach(function(game) {
      if (section && game.section !== section) return;
      if (!roundCounts[game.round]) roundCounts[game.round] = 0;
      roundCounts[game.round]++;
    });

    return Object.keys(roundCounts).map(function(r) {
      return { round: parseInt(r), gameCount: roundCounts[r] };
    }).sort(function(a, b) {
      return a.round - b.round;
    });
  }

  /**
   * Get unique section names from a set of games. Used to decide whether
   * to surface a section selector in the UI (only when >1 named section).
   *
   * @param {Map<string, Object>} games - From groupFilesIntoGames()
   * @returns {Array<{section: string, gameCount: number}>} - Sorted by name.
   *   Includes an entry with section="" for any games lacking a section,
   *   so callers can warn about partial classification.
   */
  function getAvailableSections(games) {
    var sectionCounts = {};
    games.forEach(function(game) {
      var s = game.section || '';
      sectionCounts[s] = (sectionCounts[s] || 0) + 1;
    });
    return Object.keys(sectionCounts).sort().map(function(s) {
      return { section: s, gameCount: sectionCounts[s] };
    });
  }

  /**
   * Filter games to a specific round, optionally narrowed to one section.
   *
   * @param {Map<string, Object>} games
   * @param {number} round
   * @param {string} [section] - When set, also require game.section === section.
   * @returns {Map<string, Object>} - Filtered games
   */
  function filterGamesByRound(games, round, section) {
    var filtered = new Map();
    // Defensive: a stale round dropdown can fire selectRound after the batch
    // state (allGames) has been discarded by a reset. Returning empty here —
    // rather than throwing on null.forEach — keeps the onchange handler that
    // re-enables the Start button from aborting mid-flight.
    if (!games || typeof games.forEach !== 'function') return filtered;
    games.forEach(function(game, gameId) {
      if (game.round !== round) return;
      if (section && game.section !== section) return;
      filtered.set(gameId, game);
    });
    return filtered;
  }

  /**
   * Build a display label for a game.
   *
   * With pairing data: "B4 · White Name (1650) vs Black Name (1520) — 1-0"
   *   - Ratings omitted when missing/0, result omitted when missing or "*".
   *   - Useful for scanning the round list and cross-checking reconstructions
   *     against what the TD recorded.
   * Without pairing: "B4 (2 files)" fallback.
   *
   * @param {Object} game - Game object from groupFilesIntoGames
   * @param {Object} pairing - Optional pairing data from tournament file
   * @returns {string}
   */
  function gameDisplayLabel(game, pairing) {
    var label = 'B' + game.board;
    if (!pairing) {
      label += ' (' + game.files.length + ' file' +
               (game.files.length !== 1 ? 's' : '') + ')';
      return label;
    }
    function _player(name, rating) {
      if (!name) return '?';
      return rating ? name + ' (' + rating + ')' : name;
    }
    label += ' · ' + _player(pairing.whiteName, pairing.whiteRtg) +
             ' vs ' + _player(pairing.blackName, pairing.blackRtg);
    if (pairing.result && pairing.result !== '*') {
      label += ' — ' + pairing.result;
    }
    return label;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    parseImageFilename: parseImageFilename,
    parseOcrFilename: parseOcrFilename,
    inferFromDirectoryPath: inferFromDirectoryPath,
    readDirectoryRecursive: readDirectoryRecursive,
    isScanFile: isScanFile,
    isPDF: isPDF,
    groupFilesIntoGames: groupFilesIntoGames,
    getAvailableRounds: getAvailableRounds,
    getAvailableSections: getAvailableSections,
    filterGamesByRound: filterGamesByRound,
    gameDisplayLabel: gameDisplayLabel
  };
})();

// Expose globally
window.BatchNaming = BatchNaming;
