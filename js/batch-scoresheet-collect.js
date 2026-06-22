// =============================================================================
// batch-scoresheet-collect.js — Bundle one player's scoresheets for hand-back
// =============================================================================
// Small utility for the common TD request: "a player wants copies of their own
// scoresheets." In player batch mode the app already knows every game that
// player played (across rounds) and the source scan files for each board. A
// board's scans include BOTH players' copies — the player's own sheet and the
// opponent's write-up of the same game — which is exactly the "dual-sheet"
// collection the player wants.
//
// This module reads those source files straight from the scan folder (no OCR,
// no reconstruction) and bundles them into a ZIP organized as
//   <Player>/Round N/Board N - vs Opponent/<original filename>
// plus an INDEX.txt listing the games. Format-preserving: whatever the scans
// are (JPG / PNG / PDF), they go in untouched.
//
// Module API:
//   BatchScoresheetCollect.collectPlayerScoresheets(playerKey?)
//     -> Promise<{filename, files, games, missing}>
//
// Dependencies: BatchGameList.batchState (player mode), BatchNaming.playerIdentity,
//               BatchZip.
// =============================================================================

var BatchScoresheetCollect = (function() {
  'use strict';

  function _bs() {
    return (window.BatchGameList && window.BatchGameList.batchState) || null;
  }

  // Read a game.files entry to a Uint8Array. Entries carry either a File
  // object (file-input path) or a FileSystemFileHandle (folder-picker path);
  // both yield a File/Blob with .arrayBuffer().
  async function _readBytes(fileEntry) {
    var file = fileEntry.file || null;
    if (!file && fileEntry.handle && typeof fileEntry.handle.getFile === 'function') {
      try { file = await fileEntry.handle.getFile(); } catch (e) { file = null; }
    }
    if (!file || typeof file.arrayBuffer !== 'function') return null;
    var buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  function _sanitize(s) {
    var out = String(s == null ? '' : s).replace(/[^A-Za-z0-9 _.-]+/g, '_').trim();
    return out || 'unknown';
  }

  // Insert a numeric suffix before the extension, e.g. a/b.jpg -> a/b_2.jpg.
  function _suffixName(path, n) {
    var dot = path.lastIndexOf('.');
    if (dot <= path.lastIndexOf('/')) return path + '_' + n;  // no extension
    return path.slice(0, dot) + '_' + n + path.slice(dot);
  }

  // Opponent name + the player's colour for one game, or nulls if unknown.
  function _opponentOf(game, playerKey) {
    if (!window.BatchNaming || !window.BatchNaming.playerIdentity) {
      return { name: null, color: null };
    }
    var p = game.pairing || null;
    if (!p) return { name: null, color: null };
    var idW = window.BatchNaming.playerIdentity(game, 'w');
    if (idW && idW.key === playerKey) {
      return { name: p.blackName || null, color: 'White' };
    }
    var idB = window.BatchNaming.playerIdentity(game, 'b');
    if (idB && idB.key === playerKey) {
      return { name: p.whiteName || null, color: 'Black' };
    }
    return { name: null, color: null };
  }

  /**
   * Collect the selected player's scoresheets (both sheets per game, every
   * round) into a ZIP download. Source files are bundled untouched.
   *
   * @param {string} [playerKey] - Defaults to batchState.selectedPlayer.
   * @returns {Promise<{filename:string, files:number, games:number, missing:number}>}
   */
  async function collectPlayerScoresheets(playerKey) {
    var bs = _bs();
    if (!bs || !bs.active) throw new Error('Batch mode not active');
    if (bs.batchMode !== 'player') throw new Error('Switch to "By Player" mode first');
    var pk = (playerKey != null) ? playerKey : bs.selectedPlayer;
    if (pk == null) throw new Error('No player selected');
    if (!window.BatchZip) throw new Error('ZIP module not loaded');

    var games = [];
    bs.games.forEach(function(g) { games.push(g); });
    games.sort(function(a, b) {
      if ((a.round || 0) !== (b.round || 0)) return (a.round || 0) - (b.round || 0);
      return (a.board || 0) - (b.board || 0);
    });

    var playerName = bs.selectedPlayerName || 'Player';
    var root = _sanitize(playerName);

    var entries = [];
    var usedPaths = {};
    var indexLines = ['Scoresheets for ' + playerName, ''];
    var fileCount = 0, gameCount = 0, missing = 0;

    for (var gi = 0; gi < games.length; gi++) {
      var g = games[gi];
      var files = g.files || [];
      var opp = _opponentOf(g, pk);
      var roundDir = 'Round ' + (g.round != null ? g.round : '?');
      var boardLabel = 'Board ' + (g.board != null ? g.board : '?') +
                       (opp.name ? ' - vs ' + opp.name : '');
      var boardDir = _sanitize(boardLabel);

      var result = (g.pairing && g.pairing.result) || '';
      indexLines.push(roundDir + ' / ' + boardLabel +
        (opp.color ? '  [' + opp.color + ']' : '') +
        (result ? '  ' + result : '') +
        '  (' + files.length + ' sheet' + (files.length !== 1 ? 's' : '') + ')');

      if (!files.length) { missing++; continue; }
      var anyForGame = false;
      for (var fi = 0; fi < files.length; fi++) {
        var bytes = await _readBytes(files[fi]);
        if (!bytes) continue;
        var fname = _sanitize(files[fi].name || ('sheet_' + (fi + 1)));
        var path = root + '/' + roundDir + '/' + boardDir + '/' + fname;
        if (usedPaths[path]) {
          var n = 2;
          while (usedPaths[_suffixName(path, n)]) n++;
          path = _suffixName(path, n);
        }
        usedPaths[path] = true;
        entries.push({ name: path, content: bytes });
        fileCount++;
        anyForGame = true;
      }
      if (anyForGame) gameCount++; else missing++;
    }

    if (entries.length === 0) {
      throw new Error('No scoresheet files found for ' + playerName +
        ' — the source images may not be loaded (re-pick the scan folder).');
    }

    entries.push({ name: root + '/INDEX.txt', content: indexLines.join('\n') + '\n' });

    var zipName = root + '_scoresheets.zip';
    window.BatchZip.download(entries, zipName);
    return { filename: zipName, files: fileCount, games: gameCount, missing: missing };
  }

  return {
    collectPlayerScoresheets: collectPlayerScoresheets
  };
})();

window.BatchScoresheetCollect = BatchScoresheetCollect;
