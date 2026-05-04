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
   * Format: {Section}R{Round}B{Board}p{Page}.ext
   * @param {string} filename - e.g. "OpenR1B4p1.jpg"
   * @returns {Object|null} - {section, round, board, page} or null if invalid
   */
  function parseImageFilename(filename) {
    var base = filename.replace(/\.\w+$/, '');
    var match = base.match(/^(.+?)R(\d+)B(\d+)p(\d+)$/);
    if (!match) return null;
    return {
      section: match[1],
      round: parseInt(match[2]),
      board: parseInt(match[3]),
      page: parseInt(match[4]),
      filename: filename
    };
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
   * @returns {Object} - {games: Map<string, Object>, unmatched: Array}
   *   Each game: {gameId, section, round, board, files: [...]}
   */
  function groupFilesIntoGames(files) {
    var games = new Map();
    var unmatched = [];

    // Filter to scan files only
    var scanFiles = files.filter(function(f) {
      return isScanFile(f.name);
    });

    scanFiles.forEach(function(f) {
      // Track A: Try directory-based inference first
      var meta = inferFromDirectoryPath(f.path);

      // Track B: Fall back to filename convention
      if (!meta || meta.round === null || meta.board === null) {
        var fnMeta = parseImageFilename(f.name);
        if (fnMeta) {
          meta = {
            section: fnMeta.section,
            round: fnMeta.round,
            board: fnMeta.board,
            page: fnMeta.page,
            filename: f.name
          };
        }
      }

      if (!meta || meta.round === null || meta.board === null) {
        unmatched.push(f);
        return;
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
   * Get unique round numbers from a set of games.
   * @param {Map<string, Object>} games - From groupFilesIntoGames()
   * @returns {Array<{round: number, gameCount: number}>} - Sorted by round number
   */
  function getAvailableRounds(games) {
    var roundCounts = {};
    games.forEach(function(game) {
      if (!roundCounts[game.round]) {
        roundCounts[game.round] = 0;
      }
      roundCounts[game.round]++;
    });

    return Object.keys(roundCounts).map(function(r) {
      return { round: parseInt(r), gameCount: roundCounts[r] };
    }).sort(function(a, b) {
      return a.round - b.round;
    });
  }

  /**
   * Filter games to a specific round.
   * @param {Map<string, Object>} games
   * @param {number} round
   * @returns {Map<string, Object>} - Filtered games for that round
   */
  function filterGamesByRound(games, round) {
    var filtered = new Map();
    games.forEach(function(game, gameId) {
      if (game.round === round) {
        filtered.set(gameId, game);
      }
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
    filterGamesByRound: filterGamesByRound,
    gameDisplayLabel: gameDisplayLabel
  };
})();

// Expose globally
window.BatchNaming = BatchNaming;
