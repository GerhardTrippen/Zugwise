/**
 * batch-edit-log.js
 *
 * Persisted, ordered log of the STRUCTURAL edits an operator makes to a batch
 * game's OCR cells, replayed onto the pristine OCR when the game is reopened.
 *
 * Why this exists: batch mode restores a finished game's PGN (batch-game-list
 * _restoreSavedPgns) and its OCR cells (the .txt / .grid.json / .logits.bin
 * sidecars), but the sidecars are the RAW OCR. Everything the operator did to
 * the cell list while reconstructing — cutting trailing noise (scissors /
 * "Delete from here onward" / trim), inserting and deleting plies
 * (shift-ops.js), accepting Needleman-Wunsch gap-insert / duplicate-delete
 * suggestions (sheet-alignment.js) — lived only in memory. Reopening the game
 * showed the raw OCR, not what the OCR panel showed when it was verified.
 *
 *   <scan folder>/Zugwise/OCR/<gameId>.edits.json    (routed by BatchPaths)
 *
 * HOW EDITS ARE CAPTURED
 * ----------------------
 * Every pristine cell gets a stable id (`_zid` = "<sheet>:<index>", sheet is
 * "1"/"2" for the dual sheets, "s" for a single sheet). Structural edits only
 * splice, filter and renumber — they move references, never rebuild cells —
 * so the id travels with the cell through every edit, deep copy and page
 * copy. A cell without an id is one an edit created (a placeholder); it is
 * given an id "<sheet>:n<seq>.<k>" the first time a checkpoint sees it.
 *
 * A checkpoint compares the live per-sheet arrays (state.ocrCellsSheet1/2, or
 * state.ocrCells for a single sheet) with the log's mirror of the previous
 * state and appends ONE entry holding exactly what changed: ids deleted, ids
 * inserted (with the new cells' content), content updates to inserted cells
 * (a placeholder later back-filled from the other sheet), and the numbering.
 * Checkpoints run after every named edit (the shift-ops/ui.js functions are
 * wrapped below), after every re-merge (the path every NW apply takes), and
 * as a safety net when the game is switched away from or verified. Because an
 * entry records the ARRAY EFFECT, not the UI gesture, replay is exact however
 * the edit was made — the gesture is kept alongside for the operator
 * (type/ply/sheet/source).
 *
 * The file is only ever appended to: a later truncation or edit adds entries,
 * existing ones are never rewritten. (Each write stores the whole document so
 * the file is always valid JSON; createWritable commits atomically.)
 *
 * REPLAY
 * ------
 * attach() is called by the OCR queue for every game it produces. On a cache
 * hit it reads the log, checks it was recorded against THESE cells (baseline
 * count + checksum per sheet; a mismatch sets the log aside as
 * <gameId>.edits.stale.json instead of replaying it onto the wrong cells),
 * replays the entries in order and puts the result into the OCR result before
 * anything else sees it. On a fresh OCR the old log describes cells that no
 * longer exist, so it is deleted — as _deleteGameCacheFiles does for a re-OCR.
 *
 * FINISHED GAMES
 * --------------
 * A game resumed from its saved PGN (game.savedPgn) is locked: its PGN is not
 * rewritten and structural edits are not recorded until the operator chooses
 * "Reopen for editing", which seeds the move list from the saved PGN and makes
 * the game reviewable again. The saved PGN is only replaced when the reopened
 * game is verified again.
 */
var BatchEditLog = (function() {
  'use strict';

  var FORMAT = 'zugwise-edit-log';
  var VERSION = 1;
  var ID = '_zid';

  var _logs = {};      // gameId -> in-memory log
  var _handles = {};   // gameId -> scan-folder handle the OCR queue used
  var _chain = {};     // gameId -> write promise chain (serialises writes)
  var _depth = 0;      // nesting of wrapped edit operations

  function fileNameFor(gameId) { return gameId + '.edits.json'; }
  function staleNameFor(gameId) { return gameId + '.edits.stale.json'; }

  function _log(msg) { if (typeof log === 'function') log(msg); }

  function _batchState() {
    return (window.BatchGameList && window.BatchGameList.batchState) || null;
  }
  function _game(gameId) {
    var bs = _batchState();
    return (bs && bs.games && gameId) ? bs.games.get(gameId) : null;
  }
  function _currentGameId() {
    var bs = _batchState();
    return (bs && bs.active !== false && bs.currentGameId) || null;
  }

  // =========================================================================
  // Pristine cells: ids and baseline
  // =========================================================================

  function _sheetsOf(result) {
    if (!result) return {};
    if (result.isDualSheet) return { '1': result.sheet1 || [], '2': result.sheet2 || [] };
    return { 's': result.ocrCells || [] };
  }

  // The .txt sidecar is lossy (an empty move text does not survive the round
  // trip), and a later session sees the PARSED cells. Index ids and the
  // checksum against that canonical form so a log written in the session that
  // ran the OCR still matches the cache the next session loads.
  function _canonical(cells) {
    var q = window.BatchOcrQueue;
    if (!q || typeof q.formatOcrText !== 'function' || typeof q.parseOcrTextFile !== 'function') {
      return cells;
    }
    try { return q.parseOcrTextFile(q.formatOcrText(cells)); } catch (e) { return null; }
  }

  // FNV-1a, 32 bit. A change-detection checksum (has the cached OCR changed
  // under this log?), not a security control.
  function _fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function _checksum(cells) {
    return _fnv1a(cells.map(function(c) {
      return (c.num) + '.' + String(c.color || '').toLowerCase() + ' ' + (c.move || '');
    }).join('\n'));
  }

  /**
   * Stamp ids on the pristine cells and describe them. Returns null when the
   * in-memory cells cannot be matched to what the cache will hold (the log is
   * then disabled for this game rather than recording ids that would not line
   * up next session).
   */
  function _tagPristine(result) {
    var sheets = _sheetsOf(result);
    var baseline = { dual: !!result.isDualSheet, sheets: {} };
    var ok = true;
    Object.keys(sheets).forEach(function(k) {
      var cells = sheets[k];
      var canon = _canonical(cells);
      if (!canon || canon.length !== cells.length) ok = false;
      cells.forEach(function(c, i) { if (c) c[ID] = k + ':' + i; });
      // Fresh multi-page results may hold the pages as separate objects;
      // pages are the flat list in order, so the cumulative index is the id.
      var pages = result.isDualSheet ? result['sheet' + k + 'Pages'] : null;
      if (Array.isArray(pages)) {
        var j = 0;
        pages.forEach(function(pg) {
          (pg || []).forEach(function(c) { if (c && !c[ID]) c[ID] = k + ':' + j; j++; });
        });
      }
      baseline.sheets[k] = {
        count: cells.length,
        checksum: _checksum(canon || cells),
        pages: (Array.isArray(pages) && pages.length > 1)
          ? pages.map(function(p) { return (p || []).length; }) : null
      };
    });
    return ok ? baseline : null;
  }

  function _sameBaseline(a, b) {
    if (!a || !b || !!a.dual !== !!b.dual) return false;
    var ka = Object.keys(a.sheets || {}).sort(), kb = Object.keys(b.sheets || {}).sort();
    if (ka.join() !== kb.join()) return false;
    for (var i = 0; i < ka.length; i++) {
      var x = a.sheets[ka[i]], y = b.sheets[ka[i]];
      if (!x || !y || x.count !== y.count || x.checksum !== y.checksum) return false;
      if (JSON.stringify(x.pages || null) !== JSON.stringify(y.pages || null)) return false;
    }
    return true;
  }

  function _newLog(gameId, baseline) {
    var mirror = {};
    Object.keys(baseline.sheets).forEach(function(k) {
      var ids = [];
      for (var i = 0; i < baseline.sheets[k].count; i++) ids.push(k + ':' + i);
      mirror[k] = ids;
    });
    var now = new Date().toISOString();
    return {
      gameId: gameId,
      created: now,
      baseline: baseline,
      entries: [],
      mirror: mirror,        // sheet -> ids after the last entry
      payloads: {},          // id -> content of a cell an edit created
      _written: 0
    };
  }

  function _serialize(lg) {
    return JSON.stringify({
      format: FORMAT,
      version: VERSION,
      gameId: lg.gameId,
      created: lg.created,
      updated: new Date().toISOString(),
      baseline: lg.baseline,
      entries: lg.entries
    }, null, 1);
  }

  // =========================================================================
  // Capture
  // =========================================================================

  var _SKIP_FIELDS = { num: 1, move_number: 1, color: 1, imageDataUrl: 1, cellBelowImageUrl: 1 };

  /** Content of an edit-created cell, minus position, images and transient markers. */
  function _payloadOf(c) {
    var p = {};
    Object.keys(c).forEach(function(k) {
      if (k === ID || _SKIP_FIELDS[k]) return;
      if (k.charAt(0) === '_' && k !== '_source') return;
      var v = c[k];
      if (typeof v === 'function' || v === undefined) return;
      try { p[k] = JSON.parse(JSON.stringify(v)); } catch (e) { /* unserialisable: drop */ }
    });
    return p;
  }

  function _cellNum(c) { return (c.num != null) ? c.num : c.move_number; }

  /** Cells whose (num, color) differ from positional numbering — usually none. */
  function _numberingExceptions(cells) {
    var out = [];
    for (var i = 0; i < cells.length; i++) {
      var n = Math.floor(i / 2) + 1, col = (i % 2 === 0) ? 'w' : 'b';
      if (_cellNum(cells[i]) !== n || cells[i].color !== col) {
        out.push([i, _cellNum(cells[i]), cells[i].color]);
      }
    }
    return out;
  }

  function _set(arr) { var s = {}; arr.forEach(function(x) { s[x] = true; }); return s; }

  function _knownId(lg, key, id) {
    if (typeof id !== 'string' || id.indexOf(key + ':') !== 0) return false;
    if (lg.payloads[id]) return true;
    var m = /^[^:]+:(\d+)$/.exec(id);
    return !!(m && +m[1] < ((lg.baseline.sheets[key] || {}).count || 0));
  }

  /**
   * Diff one live sheet array against the mirror. Returns the change record
   * (or null when nothing structural changed). Tags new cells in place.
   */
  function _captureKey(lg, key, live, seqNo) {
    var prev = lg.mirror[key] || [];
    var prevSet = _set(prev);
    var seen = {}, curIds = [], add = {}, fresh = 0;
    for (var i = 0; i < live.length; i++) {
      var c = live[i];
      if (!c || typeof c !== 'object') return null;
      var id = c[ID];
      if (!_knownId(lg, key, id) || seen[id]) {
        var nid = key + ':n' + seqNo + '.' + (fresh++);
        // A second occurrence of the same object keeps its tag; only untagged
        // or foreign cells are re-tagged.
        if (!seen[id]) c[ID] = nid;
        id = nid;
        add[id] = _payloadOf(c);
      }
      seen[id] = true;
      curIds.push(id);
    }
    var curSet = _set(curIds);
    var del = prev.filter(function(x) { return !curSet[x]; });
    var ins = [];
    curIds.forEach(function(x, p) { if (!prevSet[x]) ins.push([p, x]); });
    var upd = [];
    curIds.forEach(function(x, p) {
      if (!prevSet[x] || !lg.payloads[x]) return;
      var now = _payloadOf(live[p]);
      if (JSON.stringify(now) !== JSON.stringify(lg.payloads[x])) upd.push([x, now]);
    });
    var survPrev = prev.filter(function(x) { return curSet[x]; });
    var survCur = curIds.filter(function(x) { return prevSet[x]; });
    var ordered = survPrev.join('|') === survCur.join('|');
    if (!del.length && !ins.length && !upd.length && ordered) return null;

    var ch = { len: curIds.length, num: _numberingExceptions(live) };
    if (ordered) {
      if (del.length) ch.del = del;
      if (ins.length) ch.ins = ins;
    } else {
      ch.seq = curIds.slice();   // survivors reordered: record the whole order
    }
    if (upd.length) ch.upd = upd;
    // Content for ids this log has never stored (brand new, or re-inserted).
    var needed = {};
    ins.forEach(function(e) {
      if (add[e[1]]) needed[e[1]] = add[e[1]];
    });
    if (ch.seq) Object.keys(add).forEach(function(x) { needed[x] = add[x]; });
    if (Object.keys(needed).length) ch.add = needed;

    // First changed position (sheet index ≈ ply) for the human-readable ply.
    var first = Infinity;
    del.forEach(function(x) { first = Math.min(first, prev.indexOf(x)); });
    ins.forEach(function(e) { first = Math.min(first, e[0]); });
    upd.forEach(function(e) { first = Math.min(first, curIds.indexOf(e[0])); });
    ch._first = isFinite(first) ? first : 0;
    ch._tail = !ins.length && !upd.length && ordered && del.length > 0 &&
               survPrev.length === prev.length - del.length &&
               prev.slice(survPrev.length).join('|') === del.join('|');
    ch._curIds = curIds;
    return ch;
  }

  var _SHEET_NAME = { '1': 'white', '2': 'black', 's': 'single' };

  function _deriveType(changes) {
    var keys = Object.keys(changes);
    var anyIns = false, anyDel = false, anyUpd = false, allTail = true;
    keys.forEach(function(k) {
      var ch = changes[k];
      if (ch.ins || ch.seq) anyIns = true;
      if (ch.del || ch.seq) anyDel = true;
      if (ch.upd) anyUpd = true;
      if (!ch._tail) allTail = false;
    });
    if (!anyIns && !anyDel && anyUpd) return 'update';   // e.g. placeholder back-filled
    if (anyDel && !anyIns && allTail) return 'truncate';
    if (anyDel && !anyIns) return 'duplicate-delete';
    if (anyIns && !anyDel) return 'gap-insert';
    return 'realign';
  }

  /**
   * Append one entry for whatever changed in `live` ({sheetKey: cells[]}).
   * Exposed (as record) for tests and for callers holding arrays that are not
   * in `state`. Returns the entry, or null when nothing changed.
   */
  function record(gameId, live, meta) {
    var lg = _logs[gameId];
    if (!lg || lg.disabled) return null;
    meta = meta || {};
    var seqNo = lg.entries.length + 1;
    var changes = {};
    Object.keys(live).forEach(function(k) {
      if (!lg.mirror[k] || !Array.isArray(live[k])) return;
      var arr = live[k];
      // A non-empty view with none of this game's ids is not this game's
      // cells (or was rebuilt from scratch) — never record it as "everything
      // deleted, everything new".
      if (arr.length && lg.mirror[k].length &&
          !arr.some(function(c) { return c && _knownId(lg, k, c[ID]); })) {
        console.warn('[EditLog] ' + gameId + ' sheet ' + k + ': live cells carry no ids — not recorded');
        return;
      }
      var ch = _captureKey(lg, k, arr, seqNo);
      if (ch) changes[k] = ch;
    });
    var keys = Object.keys(changes);
    if (!keys.length) return null;

    var first = Infinity;
    keys.forEach(function(k) { first = Math.min(first, changes[k]._first); });
    var entry = {
      seq: seqNo,
      ts: new Date().toISOString(),
      type: meta.type || _deriveType(changes),
      source: meta.source || 'checkpoint',
      ply: (typeof meta.ply === 'number') ? meta.ply : first,
      sheet: meta.sheet || (keys.length === 1 ? _SHEET_NAME[keys[0]] : 'both'),
      changes: {}
    };
    if (meta.moveNum != null) entry.moveNum = meta.moveNum;
    if (meta.color) entry.color = meta.color;
    if (meta.payload) entry.payload = meta.payload;
    keys.forEach(function(k) {
      var ch = changes[k];
      lg.mirror[k] = ch._curIds;
      if (ch.add) Object.keys(ch.add).forEach(function(x) { lg.payloads[x] = ch.add[x]; });
      if (ch.upd) ch.upd.forEach(function(u) { lg.payloads[u[0]] = u[1]; });
      delete ch._first; delete ch._tail; delete ch._curIds;
      entry.changes[k] = ch;
    });
    lg.entries.push(entry);
    _scheduleWrite(gameId);
    return entry;
  }

  /** Live per-sheet arrays of the game on screen, keyed like the log. */
  function _liveSheets(lg) {
    if (typeof state === 'undefined' || !state) return {};
    var out = {};
    function keyOf(arr, fallback) {
      var counts = {};
      arr.forEach(function(c) {
        var id = c && c[ID];
        if (typeof id === 'string') { var k = id.split(':')[0]; counts[k] = (counts[k] || 0) + 1; }
      });
      var best = null;
      Object.keys(counts).forEach(function(k) { if (!best || counts[k] > counts[best]) best = k; });
      return (best && lg.mirror[best]) ? best : fallback;
    }
    if (state.ocrCellsSheet1 || state.ocrCellsSheet2) {
      var k1 = Array.isArray(state.ocrCellsSheet1) ? keyOf(state.ocrCellsSheet1, '1') : null;
      var k2 = Array.isArray(state.ocrCellsSheet2) ? keyOf(state.ocrCellsSheet2, '2') : null;
      if (k1 && k2 && k1 === k2) { k1 = '1'; k2 = '2'; }
      if (k1) out[k1] = state.ocrCellsSheet1;
      if (k2) out[k2] = state.ocrCellsSheet2;
    } else if (Array.isArray(state.ocrCells)) {
      // Single sheet, or a dual game with one empty half (processAllSheets
      // collapses those into the single-sheet flow).
      var ks = keyOf(state.ocrCells, lg.mirror.s ? 's' : null);
      if (ks) out[ks] = state.ocrCells;
    }
    return out;
  }

  /**
   * Record whatever the on-screen game's cells changed since the last entry.
   * Safe to call any time; a no-op when nothing changed, when the game is not
   * the one in `state`, or while a finished game is locked.
   */
  function checkpoint(gameId, meta) {
    gameId = gameId || _currentGameId();
    if (!gameId || gameId !== _currentGameId()) return null;
    var lg = _logs[gameId];
    if (!lg || lg.disabled) return null;
    var g = _game(gameId);
    if (g && g._reOcrPending) return null;
    if (isLocked(gameId)) return null;
    try {
      var entry = record(gameId, _liveSheets(lg), meta);
      if (entry) {
        console.log('[EditLog] ' + gameId + ' #' + entry.seq + ' ' + entry.type +
                    ' (' + entry.source + ', ' + entry.sheet + ', ply ' + entry.ply + ')');
      }
      return entry;
    } catch (e) {
      console.warn('[EditLog] checkpoint failed for ' + gameId + ':', e);
      return null;
    }
  }

  // =========================================================================
  // Replay
  // =========================================================================

  /**
   * Replay entries onto pristine ids. Pure: {sheetKey: ids[]} in, final ids,
   * cell contents and numbering out. Throws on any inconsistency so a
   * damaged log is set aside instead of producing a half-applied sheet.
   */
  function replayIds(pristineIds, entries) {
    var seqs = {}, payloads = {}, numx = {}, touched = {};
    Object.keys(pristineIds).forEach(function(k) { seqs[k] = pristineIds[k].slice(); });
    (entries || []).forEach(function(e, n) {
      Object.keys(e.changes || {}).forEach(function(k) {
        var ch = e.changes[k];
        if (!seqs[k]) throw new Error('entry ' + (n + 1) + ': unknown sheet ' + k);
        if (ch.add) Object.keys(ch.add).forEach(function(x) { payloads[x] = ch.add[x]; });
        if (ch.upd) ch.upd.forEach(function(u) { payloads[u[0]] = u[1]; });
        var cur;
        if (ch.seq) {
          cur = ch.seq.slice();
        } else {
          cur = seqs[k];
          var have = _set(cur);
          (ch.del || []).forEach(function(x) {
            if (!have[x]) throw new Error('entry ' + (n + 1) + ': deletes absent cell ' + x);
          });
          var del = _set(ch.del || []);
          cur = cur.filter(function(x) { return !del[x]; });
          (ch.ins || []).slice().sort(function(a, b) { return a[0] - b[0]; }).forEach(function(p) {
            if (p[0] > cur.length) throw new Error('entry ' + (n + 1) + ': insert past end');
            cur.splice(p[0], 0, p[1]);
          });
        }
        if (typeof ch.len === 'number' && cur.length !== ch.len) {
          throw new Error('entry ' + (n + 1) + ': sheet ' + k + ' length ' + cur.length +
                          ' != recorded ' + ch.len);
        }
        seqs[k] = cur;
        numx[k] = ch.num || [];
        touched[k] = true;
      });
    });
    return { seqs: seqs, payloads: payloads, numx: numx, touched: touched };
  }

  /**
   * Build cell objects for one replayed sheet. Pristine cells are copied, so a
   * replay that fails on a later sheet leaves the OCR result untouched.
   */
  function _materialize(ids, pristineById, payloads, numx) {
    var cells = ids.map(function(id) {
      var c;
      if (pristineById[id]) {
        c = Object.assign({}, pristineById[id]);
      } else if (payloads[id]) {
        c = JSON.parse(JSON.stringify(payloads[id]));
        c[ID] = id;
      } else {
        throw new Error('no content for cell ' + id);
      }
      return c;
    });
    cells.forEach(function(c, i) {
      c.num = Math.floor(i / 2) + 1;
      c.color = (i % 2 === 0) ? 'w' : 'b';
      if (c.move_number !== undefined) c.move_number = c.num;
    });
    (numx || []).forEach(function(x) {
      var c = cells[x[0]];
      if (!c) return;
      c.num = x[1];
      c.color = x[2];
      if (c.move_number !== undefined) c.move_number = x[1];
    });
    return cells;
  }

  /**
   * Split a replayed multi-page sheet back into pages with page-local move
   * numbers, the inverse of what processAllSheets/_buildSheetSlots do (they
   * add rowCount*cols of each earlier non-empty page), so the session's
   * numbering comes back exactly and page thumbnails keep working.
   */
  function _splitPages(cells, counts) {
    var bounds = [], acc = 0;
    counts.forEach(function(n) { acc += n; bounds.push(acc); });
    function pageOfIndex(i) {
      for (var p = 0; p < bounds.length; p++) if (i < bounds[p]) return p;
      return bounds.length - 1;
    }
    var pages = cells.map(function(c) {
      var m = /^[^:]+:(\d+)$/.exec(c[ID] || '');
      return m ? pageOfIndex(+m[1]) : null;
    });
    var firstKnown = 0;
    for (var f = 0; f < pages.length; f++) if (pages[f] !== null) { firstKnown = pages[f]; break; }
    var last = firstKnown;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i] === null || pages[i] < last) pages[i] = last;   // inherit, never go back
      last = pages[i];
    }
    var groups = counts.map(function() { return []; });
    cells.forEach(function(c, i) { groups[pages[i]].push(c); });

    var profile = (window.SheetProfiles && window.SheetProfiles.getActiveProfile)
      ? window.SheetProfiles.getActiveProfile() : null;
    var pg1 = (profile && profile.pages && profile.pages[0]) || { format: '2col', rowCount: 20 };
    var offset = 0;
    return groups.map(function(g, p) {
      var here = offset;
      if (g.length > 0 && p < 3) {
        var prof = (profile && profile.pages && profile.pages[p]) || pg1;
        var fmt = prof.format || pg1.format, rows = prof.rowCount || pg1.rowCount;
        offset += rows * (fmt === '3col' ? 3 : 2);
      }
      if (here === 0) return g;
      return g.map(function(c) {
        var copy = Object.assign({}, c);
        copy.num = c.num - here;
        if (copy.move_number !== undefined) copy.move_number = copy.num;
        return copy;
      });
    });
  }

  /** Replay a parsed log document onto an OCR result in place. */
  function _applyToResult(result, lg) {
    var sheets = _sheetsOf(result);
    var pristineIds = {}, pristineById = {};
    Object.keys(sheets).forEach(function(k) {
      pristineIds[k] = sheets[k].map(function(c, i) {
        var id = k + ':' + i;
        pristineById[id] = c;
        return id;
      });
    });
    var rep = replayIds(pristineIds, lg.entries);
    var built = {};
    Object.keys(rep.touched).forEach(function(k) {
      built[k] = _materialize(rep.seqs[k], pristineById, rep.payloads, rep.numx[k]);
    });
    Object.keys(built).forEach(function(k) {
      if (k === 's') { result.ocrCells = built[k]; return; }
      result['sheet' + k] = built[k];
      var counts = lg.baseline.sheets[k] && lg.baseline.sheets[k].pages;
      if (counts) {
        result['sheet' + k + 'Pages'] = _splitPages(built[k], counts);
      } else if (Array.isArray(result['sheet' + k + 'Pages'])) {
        // _buildSheetSlots prefers pages over the flat list; a stale
        // one-page array would hide the replay.
        result['sheet' + k + 'Pages'] = null;
      }
    });
    lg.mirror = rep.seqs;
    lg.payloads = rep.payloads;
    return Object.keys(built).length;
  }

  // =========================================================================
  // Attach (called by the OCR queue for every game it produces)
  // =========================================================================

  async function _removeFile(dirHandle, name) {
    if (!dirHandle) return;
    if (window.BatchPaths) {
      try {
        var dir = await window.BatchPaths.resolveDir(dirHandle, name, false);
        if (dir && dir !== dirHandle) { try { await dir.removeEntry(name); } catch (e) {} }
      } catch (e) {}
    }
    try { await dirHandle.removeEntry(name); } catch (e) {}
  }

  async function _setAside(dirHandle, gameId, text, why) {
    _log('⚠ [EditLog] ' + gameId + ': saved edit log not replayed — ' + why +
         '. Kept as ' + staleNameFor(gameId) + '; the OCR panel shows the cached OCR.');
    if (!dirHandle || !window.BatchPaths) return;
    try {
      await window.BatchPaths.writeText(dirHandle, staleNameFor(gameId), text);
      await _removeFile(dirHandle, fileNameFor(gameId));
    } catch (e) {
      console.warn('[EditLog] could not set aside the log for ' + gameId + ':', e);
    }
  }

  /**
   * Stamp ids on a freshly produced OCR result and, for a cache hit, replay
   * the game's saved edit log onto it (in place). Never throws; a failure
   * leaves the result exactly as the OCR queue produced it.
   * @returns {Promise<object>} the same result
   */
  async function attach(dirHandle, gameId, result) {
    if (!gameId || !result) return result;
    try {
      var prior = _logs[gameId];
      if (prior) await flush(gameId);   // re-fire: disk has everything first
      _handles[gameId] = dirHandle || null;
      var baseline = _tagPristine(result);
      if (!baseline) {
        await discard(gameId);
        _logs[gameId] = { gameId: gameId, disabled: true, entries: [], mirror: {}, payloads: {} };
        console.warn('[EditLog] ' + gameId + ': in-memory OCR does not match its cache form; ' +
                     'structural edits will not be recorded for this game');
        return result;
      }
      var lg = _newLog(gameId, baseline);

      if (!result.fromCache) {
        // Fresh OCR: any saved log describes cells that no longer exist.
        await discard(gameId);
        await _removeFile(dirHandle, fileNameFor(gameId));
        _logs[gameId] = lg;
        return result;
      }

      var text = null;
      if (dirHandle && window.BatchPaths) {
        try { text = await window.BatchPaths.readText(dirHandle, fileNameFor(gameId)); } catch (e) { text = null; }
      }
      _logs[gameId] = lg;
      if (!text && prior && !prior.disabled && prior.entries.length &&
          _sameBaseline(prior.baseline, baseline)) {
        // No folder to read from (or the write had not landed): this session's
        // own entries are still the record, so replay those.
        text = _serialize(prior);
      }
      if (!text) return result;

      var doc = null;
      try { doc = JSON.parse(text); } catch (e) { doc = null; }
      if (!doc || doc.format !== FORMAT || !Array.isArray(doc.entries)) {
        await _setAside(dirHandle, gameId, text, 'unreadable');
        return result;
      }
      if (doc.version > VERSION) {
        // Written by a newer Zugwise: leave it alone and do not append to it.
        lg.disabled = true;
        _log('⚠ [EditLog] ' + gameId + ': edit log is version ' + doc.version +
             ' (this app reads ' + VERSION + ') — not replayed, not changed.');
        return result;
      }
      if (!_sameBaseline(doc.baseline, baseline)) {
        await _setAside(dirHandle, gameId, text, 'it was recorded against different OCR');
        return result;
      }
      var trial = { baseline: baseline, entries: doc.entries, mirror: {}, payloads: {} };
      try {
        _applyToResult(result, trial);
      } catch (e) {
        await _setAside(dirHandle, gameId, text, 'replay failed (' + e.message + ')');
        return result;
      }
      lg.created = doc.created || lg.created;
      lg.entries = doc.entries;
      lg.mirror = trial.mirror;
      lg.payloads = trial.payloads;
      lg._written = doc.entries.length;
      if (doc.entries.length) {
        // The replayed cells already carry any NW auto-apply the session made
        // (a checkpoint recorded it with everything else); running it again on
        // them could apply a second, different correction.
        if (result.isDualSheet && !result.nwAutoApplies) result.nwAutoApplies = [];
        result.editLogReplayed = doc.entries.length;
        _log('[EditLog] ' + gameId + ': replayed ' + doc.entries.length +
             ' structural edit(s) onto the cached OCR (' + _summary(doc.entries) + ')');
      }
    } catch (e) {
      console.warn('[EditLog] attach failed for ' + gameId + ':', e);
    }
    return result;
  }

  function _summary(entries) {
    var n = {};
    entries.forEach(function(e) { n[e.type] = (n[e.type] || 0) + 1; });
    return Object.keys(n).map(function(t) { return n[t] + ' ' + t; }).join(', ');
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  function _handleFor(gameId) {
    var bs = _batchState();
    return _handles[gameId] || (bs && bs.folderHandle) || null;
  }

  function _enqueueWrite(gameId) {
    var lg = _logs[gameId];
    var prior = _chain[gameId] || Promise.resolve();
    _chain[gameId] = prior.then(function() {
      // Discarded (re-OCR) or replaced since this write was queued: skip.
      if (!lg || _logs[gameId] !== lg || lg.disabled) return;
      if (lg._written >= lg.entries.length) return;
      var handle = _handleFor(gameId);
      if (!handle || !window.BatchPaths) {
        if (!lg._warnedNoFolder) {
          lg._warnedNoFolder = true;
          _log('[EditLog] ' + gameId + ': no scan folder — structural edits are kept for ' +
               'this session only.');
        }
        return;
      }
      var n = lg.entries.length;
      return window.BatchPaths.writeText(handle, fileNameFor(gameId), _serialize(lg))
        .then(function() { if (_logs[gameId] === lg) lg._written = Math.max(lg._written, n); });
    }).catch(function(e) {
      console.warn('[EditLog] write failed for ' + gameId + ':', e);
      _log('⚠ [EditLog] ' + gameId + ': structural edits could not be saved (' +
           ((e && e.message) || e) + '); they will be retried with the next edit.');
    });
    return _chain[gameId];
  }

  function _scheduleWrite(gameId) {
    var lg = _logs[gameId];
    if (!lg) return;
    if (lg._timer) clearTimeout(lg._timer);
    lg._timer = setTimeout(function() { lg._timer = null; _enqueueWrite(gameId); }, 250);
  }

  /** Write any pending entries now. */
  function flush(gameId) {
    var lg = _logs[gameId];
    if (lg && lg._timer) { clearTimeout(lg._timer); lg._timer = null; }
    return _enqueueWrite(gameId);
  }

  /**
   * Forget a game's log (re-OCR). Waits for an in-flight write so the caller
   * can delete the file without a late write re-creating it.
   */
  async function discard(gameId) {
    var lg = _logs[gameId];
    if (lg && lg._timer) { clearTimeout(lg._timer); lg._timer = null; }
    delete _logs[gameId];
    try { await _chain[gameId]; } catch (e) { /* already reported */ }
  }

  function entriesFor(gameId) {
    var lg = _logs[gameId];
    return lg ? lg.entries.slice() : [];
  }

  // =========================================================================
  // Finished games: lock and "Reopen for editing"
  // =========================================================================

  /** A game resumed from its saved PGN and not reopened. */
  function isLocked(gameId) {
    var g = _game(gameId);
    return !!(g && g.savedPgn);
  }

  function _normSan(s) { return (typeof s === 'string') ? s.replace(/[+#!?]+$/, '') : ''; }

  // Put the saved PGN's moves into the live move list as confirmed fixes, so a
  // reopened game starts from the verified record rather than the raw OCR —
  // otherwise re-verifying would replace a correct PGN with the OCR's reading.
  function _seedFromSaved(sans) {
    if (typeof state === 'undefined' || !Array.isArray(state.moves) || !sans || !sans.length) return;
    if (!Array.isArray(state.fixedPlies)) state.fixedPlies = [];
    var seeded = 0;
    for (var i = 0; i < sans.length; i++) {
      var row = state.moves[Math.floor(i / 2)];
      if (!row) break;
      var w = (i % 2 === 0);
      var cur = w ? row.white : row.black;
      if (_normSan(cur) === _normSan(sans[i])) continue;
      if (w) {
        if (cur && !row.wOriginal) row.wOriginal = cur;
        row.white = sans[i]; row.wStatus = 'fixed'; row.wAlgoProposed = false;
      } else {
        if (cur && !row.bOriginal) row.bOriginal = cur;
        row.black = sans[i]; row.bStatus = 'fixed'; row.bAlgoProposed = false;
      }
      if (state.fixedPlies.indexOf(i) < 0) state.fixedPlies.push(i);
      seeded++;
    }
    state.sans = [];
    state.moves.forEach(function(m) {
      if (m.white) state.sans.push(m.white);
      if (m.black) state.sans.push(m.black);
    });
    if (seeded) _log('[EditLog] seeded ' + seeded + ' move(s) from the saved PGN');
    if (state.sans.length < sans.length) {
      _log('⚠ [EditLog] the saved PGN has ' + sans.length + ' plies but the OCR panel only ' +
           state.sans.length + ' — the last ' + (sans.length - state.sans.length) +
           ' are not in the move list; insert cells for them before verifying again.');
    }
    if (state.sans.length > sans.length && typeof truncateTrailingNoise === 'function') {
      // The saved game ends here; the cells past it were cut in that session
      // (or before the edit log existed). Recorded as a truncation.
      truncateTrailingNoise(sans.length);
    } else {
      if (typeof renderMoveList === 'function') renderMoveList();
      if (typeof revalidate === 'function') {
        Promise.resolve(revalidate()).catch(function(e) {
          console.warn('[EditLog] revalidate after reopen failed:', e);
        });
      }
    }
  }

  /**
   * Make a finished (resumed) game editable again. The saved PGN stays on disk
   * until the game is verified again. Returns true when the game was reopened.
   */
  function reopenForEditing(gameId, opts) {
    opts = opts || {};
    gameId = gameId || _currentGameId();
    var g = _game(gameId);
    if (!g || !g.savedPgn) return false;
    var saved = g.savedPgn;
    g._reopenedFrom = saved;
    delete g.savedPgn;
    delete g._persistedSans;
    g.hasTrailingNoise = false;
    g.noiseResolved = true;
    var GS = window.BatchGameList && window.BatchGameList.GAME_STATUS;
    if (GS) g.status = (gameId === _currentGameId()) ? GS.IN_REVIEW : GS.NEEDS_REVIEW;
    _log('[Batch] ' + gameId + ' reopened for editing — ' + saved.fileName +
         ' is replaced only when the game is verified again.');
    if (gameId === _currentGameId() && !opts.noSeed) {
      _depth++;   // the seed's own truncation is recorded once, below
      try { _seedFromSaved(saved.sans); } finally { _depth--; }
      checkpoint(gameId, { type: 'truncate', source: 'reopen', ply: saved.sans.length });
    }
    if (window.BatchGameList && typeof window.BatchGameList.renderGameList === 'function') {
      window.BatchGameList.renderGameList();
    }
    return true;
  }

  // An edit gesture on a locked game: ask before it happens.
  function _allowEdit(gameId) {
    if (!gameId || !isLocked(gameId)) return true;
    var g = _game(gameId);
    var ok = (typeof confirm === 'function') && confirm(
      'This game was finished in an earlier session (saved as ' +
      (g.savedPgn.fileName || 'a PGN') + ').\n\n' +
      'Reopen it for editing? The saved PGN is replaced only when you verify ' +
      'the game again.');
    if (!ok) {
      _log('[Batch] edit cancelled — ' + gameId + ' is finished. Use "Reopen for editing" to change it.');
      return false;
    }
    // Keep the live move list: the gesture being allowed was made on it.
    reopenForEditing(gameId, { noSeed: true });
    return true;
  }

  /** Action-bar button for the game on screen (empty unless it is locked). */
  function actionBarHtml(game) {
    if (!game || !game.savedPgn) return '';
    return '<button id="btn-batch-reopen-edit" class="px-2 py-1.5 bg-gray-700 hover:bg-amber-800 ' +
           'rounded text-xs text-white" title="This game was finished in an earlier session. ' +
           'Reopen it to change moves or cells; its saved PGN is replaced only when you ' +
           'verify it again.">&#9998; Reopen</button>';
  }

  function bindActionBar() {
    var btn = document.getElementById('btn-batch-reopen-edit');
    if (btn) btn.onclick = function() { reopenForEditing(_currentGameId()); };
  }

  // =========================================================================
  // Hooks into the existing edit functions (wrapped, not modified)
  // =========================================================================

  function _plyOf(moveNum, plyColor) { return (moveNum - 1) * 2 + (plyColor === 'w' ? 0 : 1); }

  var _WRAPS = {
    deleteMovesFromPly: function(ply) {
      return { type: 'truncate', source: 'delete-onward', ply: ply };
    },
    truncateTrailingNoise: function(keep) {
      return { type: 'truncate', source: 'trim-noise', ply: keep };
    },
    deleteSingleMove: function(ply) {
      return { type: 'delete', source: 'context-menu', ply: ply };
    },
    insertSingleMove: function(ply, move) {
      return { type: 'insert', source: 'context-menu', ply: ply, payload: { move: move || '???' } };
    },
    deleteDualPly: function(moveNum, plyColor, sheetColor) {
      return { type: 'delete', source: 'context-menu', ply: _plyOf(moveNum, plyColor),
               moveNum: moveNum, color: plyColor, sheet: sheetColor === 'w' ? 'white' : 'black' };
    },
    insertDualPly: function(moveNum, plyColor, sheetColor, position) {
      return { type: 'insert', source: 'context-menu', ply: _plyOf(moveNum, plyColor),
               moveNum: moveNum, color: plyColor, sheet: sheetColor === 'w' ? 'white' : 'black',
               payload: { position: position || 'before' } };
    },
    // Every NW apply (gap-insert, duplicate-delete, shift) ends here after its
    // splice; nested inside the dual-ply ops above it is theirs, not an NW edit.
    reMergeAndRevalidate: function(changePly) {
      return { type: null, source: 'nw-align', ply: changePly, postHoc: true };
    }
  };

  function _wrap(name, metaFn) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__editLogWrapped) return false;
    var wrapped = function() {
      var gid = _currentGameId();
      var meta = metaFn.apply(null, arguments);
      if (_depth === 0 && gid && isLocked(gid)) {
        if (!meta.postHoc) {
          if (!_allowEdit(gid)) return undefined;
        } else if (!_allowEdit(gid)) {
          // The cells already changed (the splice ran before the re-merge);
          // leave the change on screen but out of the finished game's record.
          return orig.apply(this, arguments);
        }
      }
      _depth++;
      try {
        return orig.apply(this, arguments);
      } finally {
        _depth--;
        if (_depth === 0 && gid) checkpoint(gid, meta);
      }
    };
    wrapped.__editLogWrapped = true;
    wrapped.__editLogOriginal = orig;
    window[name] = wrapped;
    return true;
  }

  function installHooks() {
    var n = 0;
    Object.keys(_WRAPS).forEach(function(name) { if (_wrap(name, _WRAPS[name])) n++; });
    return n;
  }

  if (typeof window !== 'undefined' && !window.__BATCH_EDIT_LOG_NO_HOOKS) installHooks();

  return {
    ID_FIELD: ID,
    fileNameFor: fileNameFor,
    attach: attach,
    checkpoint: checkpoint,
    record: record,
    flush: flush,
    discard: discard,
    entriesFor: entriesFor,
    isLocked: isLocked,
    reopenForEditing: reopenForEditing,
    actionBarHtml: actionBarHtml,
    bindActionBar: bindActionBar,
    installHooks: installHooks,
    // Pure helpers, exported for frontend/tests/batch-edit-log.check.js.
    _replayIds: replayIds,
    _applyToResult: _applyToResult,
    _splitPages: _splitPages
  };
})();

window.BatchEditLog = BatchEditLog;
