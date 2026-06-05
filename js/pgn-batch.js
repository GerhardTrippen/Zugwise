// =============================================================================
// pgn-batch.js — Minimal multi-game PGN review
// =============================================================================
// Paste a tournament PGN (multiple [Event ...] blocks). The module parses
// every game, eagerly validates them against the same validate-moves
// pipeline the single-game PGN review uses, and renders a sidebar listing
// every game with a status icon (valid / needs review / verified). Clicking
// a row loads that game's moves into state.moves and the existing review
// UI handles the rest.
//
// Per-game state (moves, confirmedPly, fixedPlies) is snapshotted on
// switch-away and restored on switch-back so the user can move between
// games without losing applied fixes. Export concatenates each game's
// tag block with the (possibly corrected) move list.
//
// Intentionally NOT depending on BatchGameList — the tournament-OCR
// sidebar has too much OCR-pipeline state to subset cleanly. This module
// renders into the same #batch-game-list DOM element directly, in
// read-only style.
// =============================================================================

window.PgnBatch = (function() {
  'use strict';

  var STATUS_DISPLAY = {
    unvalidated: { icon: '⏳', label: 'Validating',   cssClass: 'text-gray-400 animate-pulse' },
    valid:       { icon: '✅', label: 'Valid',        cssClass: 'text-green-400' },
    stuck:       { icon: '🟡', label: 'Needs review', cssClass: 'text-yellow-400' },
    verified:    { icon: '✅', label: 'Verified',     cssClass: 'text-green-400' },
    error:       { icon: '🔴', label: 'Parse error', cssClass: 'text-red-400' },
  };

  var pgnBatchState = {
    active: false,
    games: [],
    currentIndex: -1,
    // Background algorithm scheduler — Greedy runs on every stuck game in
    // sequence after import so the user can step into each game and see
    // a pre-computed Review proposal instead of waiting for the search
    // to finish on click. State is per-game (game.algoStatus / .algoResult)
    // plus a global queue marker so concurrent calls don't reentrantly
    // start the queue.
    algoQueue: [],
    algoBusy: false,
    algoCancelled: false,
  };

  // Per-method status glyphs — mirrors the OCR batch sidebar
  // (batch-game-list.js _METHOD_GLYPH) so the user sees the same vocabulary
  // in both batch modes: G + glyph, with the optional move-number suffix
  // for partial results indicating how far the algorithm got.
  //   ·  idle / not run
  //   ⋯  queued
  //   ↻  running
  //   ✓  solved (or already valid)
  //   ◐  partial — fixes applied but game not fully solved (with move-no)
  //   ✗  failed / no fixes found
  //   !  error
  var ALGO_STATUS_DISPLAY = {
    pending: { glyph: '⋯', label: 'Greedy queued',  cssClass: 'text-gray-400' },                // ⋯
    running: { glyph: '↻', label: 'Greedy running', cssClass: 'text-blue-400 animate-pulse' },  // ↻
    solved:  { glyph: '✓', label: 'Greedy solved',  cssClass: 'text-green-400' },               // ✓
    valid:   { glyph: '✓', label: 'Already valid',  cssClass: 'text-green-400' },               // ✓
    partial: { glyph: '◐', label: 'Greedy partial', cssClass: 'text-amber-400' },               // ◐
    failed:  { glyph: '✗', label: 'Greedy failed',  cssClass: 'text-red-400' },                 // ✗
    error:   { glyph: '!',      label: 'Greedy error',   cssClass: 'text-red-500' },
  };

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  // Multi-game heuristic: at least 2 [Event ...] tags at line start. The
  // single-game [Event "..."] tag at the top of a normal PGN paste passes
  // through unchanged.
  function isMultiGame(text) {
    if (!text) return false;
    var matches = text.match(/^\s*\[Event\s/gm);
    return !!(matches && matches.length >= 2);
  }

  // Split on the [Event ... ] header at line start. The lookahead keeps the
  // delimiter on the next block (so each block starts with [Event ...).
  function parseMultiGamePgn(text) {
    if (!text) return [];
    var games = [];
    var blocks = text.split(/(?=^\s*\[Event\s)/gm);
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i].trim();
      if (!block) continue;
      var game = _parseSingleGameBlock(block);
      if (game) games.push(game);
    }
    return games;
  }

  function _parseSingleGameBlock(blockText) {
    // Extract tags. Keep them in the order they appear so opaque round-trip
    // preserves any non-standard tags the user's PGN file contained.
    var tags = {};
    var tagOrder = [];
    var tagRegex = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/gm;
    var m;
    while ((m = tagRegex.exec(blockText)) !== null) {
      var key = m[1];
      // Unescape \\\\ and \\"
      var val = m[2].replace(/\\(.)/g, '$1');
      if (!(key in tags)) {
        tagOrder.push(key);
      }
      tags[key] = val;
    }

    // Strip tags + braced comments + move numbers, then split out the SAN
    // tokens. Result token and "*" placeholder are dropped.
    var cleaned = blockText
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\d+\.+\s*/g, ' ')
      .trim();
    var sans = cleaned.split(/\s+/).filter(function(t) {
      return t && t !== '*'
          && !/^[01]-[01]$/.test(t)
          && !/^1\/2-1\/2$/.test(t);
    });

    if (sans.length === 0 && Object.keys(tags).length === 0) return null;

    return {
      tags: tags,
      tagOrder: tagOrder,
      origSans: sans.slice(),  // never mutated — used to compare against current
      sans: sans,
      // Snapshotted per-game state (populated on switch-away, replayed on switch-back)
      snapshot: null,
      status: 'unvalidated',
      validateResult: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  async function _validateOne(sans) {
    if (!window.zugwise || !window.zugwise.isReady) {
      throw new Error('Pyodide not ready');
    }
    var ocrData = sans.map(function(s) {
      return { move: s, confidence: 1.0, alternatives: [] };
    });
    var settings = (typeof getAutoFixSettings === 'function') ? getAutoFixSettings() : {};
    return await window.zugwise.validate(sans, ocrData, settings, [], 0);
  }

  function _computeStatusFromValidate(v) {
    if (!v) return 'unvalidated';
    if (v.valid) return 'valid';
    return 'stuck';
  }

  // ---------------------------------------------------------------------------
  // State swap
  // ---------------------------------------------------------------------------

  function _buildPairedFromSans(sans) {
    var paired = [];
    for (var i = 0; i < sans.length; i += 2) {
      paired.push({
        num: Math.floor(i / 2) + 1,
        white: sans[i] || '',
        black: sans[i + 1] || '',
        wConf: 1.0,
        bConf: 1.0,
        wAlts: [],
        bAlts: [],
        wLenientAlts: [],
        bLenientAlts: [],
      });
    }
    return paired;
  }

  function _snapshotCurrent() {
    if (pgnBatchState.currentIndex < 0) return;
    var g = pgnBatchState.games[pgnBatchState.currentIndex];
    if (!g) return;
    g.snapshot = {
      moves: state.moves ? JSON.parse(JSON.stringify(state.moves)) : null,
      sans: state.sans ? state.sans.slice() : null,
      fixedPlies: state.fixedPlies ? state.fixedPlies.slice() : [],
      lockedPlies: state.lockedPlies ? state.lockedPlies.slice() : [],
      // approvedPlies is the union (fixed ∪ locked) that revalidate passes
      // to the validator to skip EAD on signed-off plies. Snapshot it
      // explicitly so a game-switch round-trip restores the EAD-skip set
      // and the bad-trade banner doesn't re-fire on locked plies.
      approvedPlies: state.approvedPlies ? state.approvedPlies.slice() : [],
      confirmedPly: state.confirmedPly || 0,
    };
  }

  function _loadGame(index) {
    var g = pgnBatchState.games[index];
    if (!g) return;

    // Reset transient UI state from previous game
    state.selectedFix = null;
    state.legalMoves = [];
    state.fixArrow = null;
    state.ocrArrow = null;
    state.errorArrow = null;
    state.savedErrorArrow = null;
    state.stuckPly = null;
    // originStuckPly carries the *origin* ply for backtrack-fix highlighting
    // (red outline on the actual stuck cell while yellow marks the proposed
    // repair ply). If the previous game's verification walkthrough left this
    // set, it leaks into the next game and paints the red outline at a stale
    // cell — reported as "16.B has a red rectangle but the stuck point is
    // 18.B." Clear alongside the other arrow/highlight state.
    state.originStuckPly = null;
    state.stuckInfo = null;
    state.inputMode = 'pgn';

    if (g.snapshot) {
      // Resume from snapshot — user has touched this game before.
      state.moves = JSON.parse(JSON.stringify(g.snapshot.moves || []));
      state.fixedPlies = g.snapshot.fixedPlies.slice();
      state.lockedPlies = g.snapshot.lockedPlies.slice();
      state.approvedPlies = (g.snapshot.approvedPlies || []).slice();
      state.confirmedPly = g.snapshot.confirmedPly || 0;
      // validateAndDisplay below resets lockedPlies/fixedPlies/confirmedPly
      // to empty and runs auto-fix against the raw text — which would
      // overwrite the user's "keep-as-is" Qd2 with Qe2 etc. Stash the
      // values through pending fields so the validator's reset can be
      // restored, and the move-rebuild loop honors m.wStatus='locked'/'fixed'
      // from the snapshot's paired array.
      state._pendingPgnLockedPlies = g.snapshot.lockedPlies.slice();
      state._pendingPgnFixedPlies = g.snapshot.fixedPlies.slice();
      state._pendingPgnApprovedPlies = (g.snapshot.approvedPlies || []).slice();
      state._pendingPgnConfirmedPly = g.snapshot.confirmedPly || 0;
    } else {
      // First visit — build paired from the parsed PGN sans.
      state.moves = _buildPairedFromSans(g.sans);
      state.fixedPlies = [];
      state.lockedPlies = [];
      state.approvedPlies = [];
      state.confirmedPly = 0;
    }

    // Clear the middle-panel DOM directly. validateAndDisplay's initial-
    // validation path doesn't reset #stuck-info / #fix-list for the
    // "game already valid" case, so without this the user sees the
    // previous game's stuck info and deep-search list flash through.
    // Also kill the in-flight deep search and fix-details overlay.
    state.searchGeneration = (state.searchGeneration || 0) + 1;
    try { if (typeof cancelSearch === 'function') cancelSearch(); } catch (e) {}
    try { if (typeof hideFixDetails === 'function') hideFixDetails(); } catch (e) {}
    var stuckInfo = document.getElementById('stuck-info');
    if (stuckInfo) stuckInfo.innerHTML = '<span class="text-blue-300">🔍 Validating ' + _esc(_gameLabel(g, index)) + '…</span>';
    var fixList = document.getElementById('fix-list');
    if (fixList) fixList.innerHTML = '<div class="text-gray-400 text-sm p-4 text-center">Loading game…</div>';
    var lc = document.getElementById('legal-moves');
    if (lc) lc.innerHTML = '';
    var lcCount = document.getElementById('legal-count');
    if (lcCount) lcCount.textContent = '0';
    var lcPos = document.getElementById('legal-position');
    if (lcPos) lcPos.textContent = '';

    // Drive the standard PGN-review flow. validateAndDisplay re-validates,
    // sets state.stuckPly / state.stuckInfo / state.sans, paints the board,
    // and triggers fetchFixes if stuck. Same code path the single-game
    // paste already exercises.
    var label = _gameLabel(g, index);
    if (typeof validateAndDisplay === 'function') {
      // validateAndDisplay is async — wait for it so we know stuckPly and
      // can decide between painting the cached background-Greedy result
      // vs launching a fresh foreground run.
      validateAndDisplay(state.moves, label).then(function() {
        if (!state.stuckInfo) {
          // Game is valid on this switch. validation.js's valid branch
          // already calls markPanelsGameComplete to clear stale Greedy/
          // Beam/Dijkstra panels left over from the previous game, but
          // call it defensively here too: switching into a finished game
          // and seeing the prior game's PARTIAL log or "⏳ Queued for
          // background Greedy" placeholder is the single most-visible
          // regression of this flow, and the cost of a duplicate
          // idempotent call is zero. Belt-and-suspenders for the
          // game-switch surface specifically.
          if (typeof markPanelsGameComplete === 'function') {
            try { markPanelsGameComplete(); } catch (_e) {}
          }
          return;
        }

        // Make the algorithm panels visible + clear any prior content.
        // launchBackgroundSearches normally does this before kicking off
        // workers, but in PGN-batch mode that function bails early
        // (beam.js guard) — so we have to do it ourselves or the user
        // sees no panel at all for stuck games. Mirrors beam.js's setup
        // step: showSearchPanels(true) + clearPanelLog per method.
        if (typeof showSearchPanels === 'function') showSearchPanels(true);
        if (typeof clearPanelLog === 'function') {
          clearPanelLog('greedy');
          clearPanelLog('beam');
          clearPanelLog('dijkstra');
        }

        // Prefer the cached background-Greedy result when fresh — the
        // scheduler already ran on this game, so the foreground panel
        // can light up immediately with the proposal instead of doing
        // the same work over. "Fresh" = user hasn't applied a fix since
        // the cache was populated (algoResultDirty flag).
        var haveCached = g.algoResult && !g.algoResultDirty &&
                         (g.algoStatus === 'solved' || g.algoStatus === 'partial');
        if (haveCached && typeof handleSearchComplete === 'function') {
          try {
            handleSearchComplete('greedy', g.algoResult);
          } catch (e) {
            if (typeof console !== 'undefined') console.error('PgnBatch paint cached greedy result failed:', e);
          }
          return;  // skip foreground launch — cached is the panel content
        }

        // No fresh cached result. In PGN batch mode the foreground
        // launchBackgroundSearches is suppressed (beam.js guard) to
        // avoid duplicating the background queue's work, so we don't
        // even call it. Instead, move this game to the front of the
        // queue so the user's clicked game runs next. If the queue
        // isn't already busy we kick it off; if it is, this game gets
        // priority once the current one finishes.
        _prioritizeInQueue(index);
        // Show a "waiting" status in the Greedy panel so the user
        // knows what's coming.
        if (typeof appendPanelLog === 'function') {
          appendPanelLog('greedy', '⏳ Queued for background Greedy — will appear shortly.', 'text-gray-400');
        }
      });
    }

    var loadedInfo = document.getElementById('loaded-info');
    if (loadedInfo) loadedInfo.textContent = '📚 ' + label;

    // Populate the round/players/result header from PGN tags so the leftover
    // OCR-batch tournament info doesn't linger on the screen when the user
    // switches modes. Hide it entirely if the tags have nothing usable.
    _renderGameHeader(g);
  }

  function _renderGameHeader(g) {
    var header = document.getElementById('game-header');
    var roundinfo = document.getElementById('game-header-roundinfo');
    var whiteEl = document.getElementById('game-header-white');
    var blackEl = document.getElementById('game-header-black');
    var resultEl = document.getElementById('game-header-result');
    if (!header) return;
    var t = g.tags || {};

    // Build the "Event · Round X · Board Y · Date" line
    var roundParts = [];
    if (t.Event)  roundParts.push(_esc(t.Event));
    if (t.Round)  roundParts.push('Round ' + _esc(t.Round));
    if (t.Board)  roundParts.push('Board ' + _esc(t.Board));
    if (t.Date && t.Date !== '????.??.??') roundParts.push(_esc(t.Date));
    if (t.Site)   roundParts.push(_esc(t.Site));
    var roundLine = roundParts.join(' · ');

    // Player names with optional rating
    function _playerWithRating(name, elo) {
      var s = _esc(name || '?');
      if (elo) s += ' <span class="text-gray-400">(' + _esc(elo) + ')</span>';
      return s;
    }

    var hasAny = !!(roundLine || t.White || t.Black || t.Result);
    if (!hasAny) {
      header.classList.add('hidden');
      return;
    }

    if (roundinfo) roundinfo.innerHTML = roundLine || '&nbsp;';
    if (whiteEl)   whiteEl.innerHTML   = _playerWithRating(t.White, t.WhiteElo);
    if (blackEl)   blackEl.innerHTML   = _playerWithRating(t.Black, t.BlackElo);
    if (resultEl)  resultEl.textContent = t.Result || '';
    header.classList.remove('hidden');
  }

  // Repurpose the big #btn-apply button as the verify-and-advance
  // action when the current PGN-batch game has reached 'valid' status
  // (user resolved every stuck point but hasn't yet confirmed). In
  // every other state (stuck/unvalidated/error/verified) we restore
  // the button to its default applyFix wiring; validation.js's
  // resetApplyButton handles the gray "Select a fix" styling for the
  // truly-idle case. Hooked into onCurrentGameValidated so it runs
  // after validation paints "Game complete!" into #fix-list.
  function _overrideApplyForVerify() {
    if (!pgnBatchState.active) return;
    if (pgnBatchState.currentIndex < 0) return;
    var g = pgnBatchState.games[pgnBatchState.currentIndex];
    if (!g) return;
    var btn = document.getElementById('btn-apply');
    if (!btn) return;
    if (g.status === 'valid') {
      // Label adapts so the user knows whether clicking will advance
      // to another game or wrap up the tournament. Re-evaluating
      // hasOtherStuck on every paint keeps the label accurate as the
      // remaining-stuck count changes during a session.
      var hasOtherStuck = pgnBatchState.games.some(function(other, k) {
        if (k === pgnBatchState.currentIndex) return false;
        var s = other.status;
        return (s === 'stuck' || s === 'unvalidated' || s === 'error');
      });
      btn.textContent = hasOtherStuck
        ? '✓ Verified — Next stuck game →'
        : '✓ Verified — Done!';
      btn.disabled = false;
      btn.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-green-600 hover:bg-green-500 text-white';
      btn.onclick = verifyAndContinue;
      btn.dataset.pgnBatchVerify = '1';
    } else {
      // Restore default — applyFix is the global click handler for
      // every non-PGN-batch use of the button, and stays valid for
      // PGN-batch games that still have a stuck point to fix.
      if (typeof applyFix === 'function') btn.onclick = applyFix;
      // If we previously hijacked the button for verify, restore the
      // idle gray "Select a fix" visual. validation.js's
      // resetApplyButton already runs on every revalidate that finds
      // no stuck point, so for the typical "user fixed everything →
      // clicked verify → moved to next game" flow the visual is
      // already correct; this branch handles the "user clicked verify
      // when no other stuck games remain → stays put as 'verified'"
      // case, where no revalidate fires.
      if (btn.dataset.pgnBatchVerify === '1') {
        if (typeof resetApplyButton === 'function') resetApplyButton();
        delete btn.dataset.pgnBatchVerify;
      }
    }
  }

  // Mark the current game verified and load the next game still needing
  // review (sorted display order). Wired to the green button in
  // #game-header-verify-row; the button is only visible when the game is
  // in 'valid' status, but guard here too for direct API callers.
  function verifyAndContinue() {
    if (pgnBatchState.currentIndex < 0) return;
    var g = pgnBatchState.games[pgnBatchState.currentIndex];
    if (!g || g.status !== 'valid') return;
    markVerifiedCurrent();

    // Walk the sorted display order to find the next stuck/unvalidated/
    // error game. Using _compareGameIndices means "next" matches the
    // visible list — important since the user picked the sort order
    // specifically so the top row is the next game to work on.
    var games = pgnBatchState.games;
    var sortedIndices = games.map(function(_, k) { return k; });
    sortedIndices.sort(_compareGameIndices);
    for (var k = 0; k < sortedIndices.length; k++) {
      var idx = sortedIndices[k];
      if (idx === pgnBatchState.currentIndex) continue;
      var c = games[idx];
      if (c.status === 'stuck' || c.status === 'unvalidated' || c.status === 'error') {
        selectGame(idx);
        return;
      }
    }
    // No more stuck games — refresh the sidebar so the row's status
    // icon updates, then re-run the apply-button override so the big
    // button stops being green-and-clickable now that the game is
    // 'verified' (the override's else branch restores applyFix as the
    // default click). validation.js's earlier resetApplyButton call
    // has already left the button in its idle "Select a fix" state.
    renderSidebar();
    _overrideApplyForVerify();
    if (typeof log === 'function') log('✅ All games verified.');
  }

  // Called by validation.js after each validate / revalidate finishes so
  // the sidebar status icon stays in sync with the actual play-through.
  // val is the validate-API response (or a minimal object exposing
  // .valid / .stuck_at / .stuck_reason).
  function onCurrentGameValidated(val) {
    if (!pgnBatchState.active) return;
    if (pgnBatchState.currentIndex < 0) return;
    var g = pgnBatchState.games[pgnBatchState.currentIndex];
    if (!g) return;
    g.validateResult = val;
    // If this fired from the revalidate path (user applied a fix or
    // override-rejected a Greedy proposal), the cached background-Greedy
    // result was computed against the pre-action position and is now
    // stale. Mark it so the next switch-back to this game launches a
    // fresh foreground search instead of re-painting outdated cached
    // fixes.
    if (val && val.fromRevalidate) {
      // Decide whether the user's action actually invalidates the
      // cached algoResult:
      //
      //   A) A fix changed a move's SAN (state.fixedPlies grew). Greedy
      //      ran against pre-fix OCR text, so its proposed path is no
      //      longer reachable. Always invalidate.
      //
      //   B) A keep-as-is added a lock (state.lockedPlies grew) but no
      //      SAN changed. The cached path is still valid AS LONG AS it
      //      didn't propose to change the now-locked ply. If the newly-
      //      locked ply appears in algoResult.fixes, the user has
      //      directly rejected one of Greedy's proposals — invalidate.
      //      Otherwise the lock is purely additive metadata and the
      //      cached result is still the right answer; don't re-run.
      var baselineLocks = g.algoResultBaselineLockedPlies || [];
      var baselineFixes = g.algoResultBaselineFixedPlies || [];
      var curLocks = (state.lockedPlies || []);
      var curFixes = (state.fixedPlies || []);
      var newlyLocked = curLocks.filter(function(p) {
        return baselineLocks.indexOf(p) === -1;
      });
      var newlyFixed = curFixes.filter(function(p) {
        return baselineFixes.indexOf(p) === -1;
      });

      var invalidatesCache;
      if (newlyFixed.length > 0) {
        invalidatesCache = true;  // case A
      } else if (newlyLocked.length > 0 && g.algoResult) {
        // Cached SOLVED is the optimum — a lock on an unrelated ply can't
        // improve on it, so keep it (avoid the user-reported regression
        // where keep-as-is on a non-fix ply downgraded SOLVED to PARTIAL).
        // Cached PARTIAL/FAILED, on the other hand, means Greedy gave up
        // at a backward regression. New locks REDUCE the search-back
        // space (locked plies are sacred and skipped), which can let
        // Greedy push further this time. Always re-run for those.
        var algoStatus = (g.algoResult.status || '').toUpperCase();
        if (algoStatus === 'SOLVED' || algoStatus === 'VALID') {
          var algoFixPlies = (g.algoResult.fixes || []).map(function(f) { return f.ply; });
          invalidatesCache = newlyLocked.some(function(p) {
            return algoFixPlies.indexOf(p) !== -1;
          });
        } else {
          // PARTIAL / FAILED — the cached run hit a wall; new locks change
          // the constraint surface and might unlock a SOLVED path.
          invalidatesCache = true;
        }
      } else {
        // No cached result yet, or no new locks/fixes — nothing to do.
        invalidatesCache = false;
      }

      // Always snapshot the latest state (locks, confirmedPly, moves) so
      // a future game-switch resume sees the user's progress, even when
      // we keep the cached algoResult.
      _snapshotCurrent();

      if (invalidatesCache) {
        g.algoResultDirty = true;
        // If still stuck after the user's action, re-queue this game so
        // Greedy can try again with the updated locks. _prioritizeInQueue
        // both adds the game to the front and kicks the queue if idle.
        if (!val.valid && pgnBatchState.currentIndex >= 0) {
          _prioritizeInQueue(pgnBatchState.currentIndex);
        }
      }
    }
    // Don't overwrite an explicitly user-verified status — only auto-flip
    // valid <-> stuck. If the user has marked it verified (future button),
    // leave it.
    if (g.status !== 'verified') {
      g.status = _computeStatusFromValidate(val);
    }
    // Sync algo badge with reality: once the user has manually got the
    // game to valid (or verified), the algorithm's cached partial/failed
    // verdict is stale — promote to solved so the badge stops showing
    // G◐(2) next to a ✅ row. Reported user case: R1.5 Tan vs Momic
    // shown as "✅ R1.5 ... G◐(2) 0-1" after the fix was applied.
    if (g.status === 'valid' || g.status === 'verified') {
      // 'valid' from a game that was never stuck stays 'valid' (we
      // recorded that on import). Anything else (running / partial /
      // failed / pending after the user fixed it themselves) promotes
      // to 'solved'.
      if (g.algoStatus !== 'valid') {
        g.algoStatus = 'solved';
      }
    }
    renderSidebar();
    // Repurpose the big Apply button as the verify-and-advance action
    // when this game just reached 'valid' status. Runs after validation
    // already reset the button to its idle "Select a fix" state.
    _overrideApplyForVerify();
  }

  // Called by handleSearchComplete in beam.js when a manual ↻ rerun finishes
  // in PGN-batch mode. The singleton SearchManager (used by runGreedySearch)
  // stores its result only in beam.js's module-level greedyResult var — so
  // without this hook, switching games and back would restore the older
  // background-queue cached result, hiding the user's fresh manual rerun.
  // Captures the same baseline (locks/fixes) the background queue captures
  // so subsequent revalidate diffs work the same way.
  function updateCurrentGameAlgoResult(result) {
    if (!pgnBatchState.active) return;
    if (pgnBatchState.currentIndex < 0) return;
    var g = pgnBatchState.games[pgnBatchState.currentIndex];
    if (!g) return;
    g.algoResult = result || null;
    g.algoResultBaselineLockedPlies = (state.lockedPlies || []).slice();
    g.algoResultBaselineFixedPlies = (state.fixedPlies || []).slice();
    g.algoResultDirty = false;
    if (g.status !== 'verified' && g.status !== 'valid') {
      g.algoStatus = _computeAlgoStatus(g.algoResult);
    }
    renderSidebar();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async function initBatch(games) {
    if (!games || games.length === 0) return;
    pgnBatchState.active = true;
    pgnBatchState.games = games;
    pgnBatchState.currentIndex = -1;

    // Collapse the load-PGN inputs while a batch session is active —
    // the dual-input toggle / image-picker / second textarea are all
    // single-game review artifacts that don't apply when reviewing a
    // multi-game tournament PGN. Summary wording shifts to imply
    // "switch to a different one" rather than "paste your first PGN".
    var _disc = document.getElementById('pgn-input-disclosure');
    var _summ = document.getElementById('pgn-input-disclosure-summary');
    if (_disc) _disc.open = false;
    if (_summ) _summ.textContent = 'Load a different PGN';

    renderSidebar();
    if (typeof log === 'function') log('📚 PGN batch: ' + games.length + ' games loaded');

    // Validate every game eagerly (cheap — ms per game). Update sidebar as
    // we go so the user sees status icons fill in progressively. Yield a
    // tick between games so user clicks (which queue a validate of their
    // own through the same Pyodide worker) don't have to wait behind 50
    // consecutive validates before getting a turn.
    for (var i = 0; i < games.length; i++) {
      try {
        var v = await _validateOne(games[i].sans);
        games[i].validateResult = v;
        games[i].status = _computeStatusFromValidate(v);
      } catch (e) {
        games[i].status = 'error';
        if (typeof log === 'function') log('⚠ Game ' + (i + 1) + ' validation error: ' + e.message);
      }
      renderSidebar();
      // setTimeout(0) yields the event loop so any pending click-handler
      // validate gets dispatched before the next iteration of this loop
      // posts its own validate to the worker. Without this, a 50-game
      // tournament's eager-validation queue can block a user click for
      // up to ~10 seconds.
      await new Promise(function(r) { setTimeout(r, 0); });
    }

    // Queue Greedy in the background for every stuck game so the user can
    // step into each one and see a pre-computed proposal. Skips games that
    // are already valid (no fixes needed) or had a parse error.
    games.forEach(function(g, i) {
      if (g.status === 'stuck') {
        g.algoStatus = 'pending';
        pgnBatchState.algoQueue.push(i);
      } else if (g.status === 'valid') {
        g.algoStatus = 'valid';
      }
    });
    _runAlgoQueue();  // fire and forget

    // Auto-select the first game that needs review in display order
    // (sidebar sort: needs-review first, then by round → board → parse
    // order). Falls back to the first game in display order if every
    // game is already valid.
    var displayOrder = games.map(function(_, k) { return k; });
    displayOrder.sort(_compareGameIndices);
    var firstStuckIdx = -1;
    for (var di = 0; di < displayOrder.length; di++) {
      if (games[displayOrder[di]].status === 'stuck') {
        firstStuckIdx = displayOrder[di];
        break;
      }
    }
    selectGame(firstStuckIdx >= 0 ? firstStuckIdx : displayOrder[0]);
  }

  // ---------------------------------------------------------------------------
  // Background algorithm scheduler
  // ---------------------------------------------------------------------------

  function _buildOcrMovesForAlgo(g) {
    // Build the ocrMoves shape SearchManager expects: per-ply
    // { num, color, move, confidence, alternatives }. PGN review has no
    // OCR alternatives, just the typed move at confidence 1.0.
    return g.sans.map(function(san, i) {
      return {
        num: Math.floor(i / 2) + 1,
        color: i % 2 === 0 ? 'w' : 'b',
        move: san,
        confidence: 1.0,
        alternatives: []
      };
    });
  }

  function _computeAlgoStatus(result) {
    if (!result) return 'failed';
    var s = result.status;
    if (s === 'SOLVED')  return 'solved';
    if (s === 'VALID')   return 'valid';
    if (s === 'PARTIAL') return 'partial';
    return 'failed';
  }

  // Move `index` to the front of the algo queue so the user's clicked
  // game runs next. If it's not currently queued (already processed or
  // not stuck), re-queue it.
  function _prioritizeInQueue(index) {
    var g = pgnBatchState.games[index];
    if (!g) return;
    if (g.status !== 'stuck') return;
    // If this game is currently running (shifted off the queue but its
    // launchSearchesPromise hasn't resolved), do NOT re-queue it. Without
    // this guard the queue loop would pick the same game up again after
    // the current iteration finishes — producing duplicate "SOLVED (1
    // fixes) [fix] X" entries in the panel and a second wasted Greedy
    // pass against identical input. _loadGame already paints a "Queued..."
    // placeholder; the in-flight run will resolve and call
    // handleSearchComplete normally, which paints the result once.
    if (pgnBatchState.algoCurrentIndex === index) {
      return;
    }
    // Remove any existing entry for this index, then unshift to front.
    pgnBatchState.algoQueue = pgnBatchState.algoQueue.filter(function(i) {
      return i !== index;
    });
    pgnBatchState.algoQueue.unshift(index);
    g.algoStatus = 'pending';
    renderSidebar();

    // If this is the game the user is currently looking at, wipe the
    // Greedy panel right now — don't wait for _runAlgoQueue to reach
    // this index. The panel was showing the now-stale result (e.g.
    // "PARTIAL — 2 partial fix(es): [partial] 4.W: b4 → b3 ...")
    // computed against a different lock set. Leaving it in place after
    // a keep-as-is causes the user to doubt whether their action took
    // effect ("did the lock invalidate the cache or not?"). _runAlgoQueue
    // also performs this clear when it picks the game up, but here we
    // run as soon as the requeue is recorded so the visual matches the
    // internal state.
    if (index === pgnBatchState.currentIndex) {
      if (typeof clearPanelLog === 'function') {
        try { clearPanelLog('greedy'); } catch (_e) {}
      }
      if (typeof updateSearchPanel === 'function') {
        try { updateSearchPanel('greedy', 'Queued — re-running with new locks', 0); } catch (_e) {}
      }
      if (typeof showReviewButton === 'function') {
        try { showReviewButton('greedy', false); } catch (_e) {}
      }
    }

    if (!pgnBatchState.algoBusy) {
      _runAlgoQueue();  // kick off if idle
    }
  }

  async function _runAlgoQueue() {
    if (pgnBatchState.algoBusy) return;
    pgnBatchState.algoBusy = true;
    pgnBatchState.algoCancelled = false;
    try {
      while (pgnBatchState.algoQueue.length > 0 && !pgnBatchState.algoCancelled) {
        var index = pgnBatchState.algoQueue.shift();
        var g = pgnBatchState.games[index];
        if (!g) continue;
        // Skip games the user has already verified or that are no longer
        // stuck (e.g. the user manually fixed it while the queue was
        // catching up to this row).
        if (g.status === 'verified' || g.status === 'valid') {
          g.algoStatus = g.status === 'valid' ? 'valid' : 'solved';
          renderSidebar();
          continue;
        }

        // Mark which game is in flight so _prioritizeInQueue can skip
        // re-adding the same game (otherwise _loadGame's "no cache yet"
        // fallback queues it twice and the user sees doubled output).
        pgnBatchState.algoCurrentIndex = index;
        g.algoStatus = 'running';
        renderSidebar();

        // If this is the currently-displayed game, wipe the Greedy panel
        // immediately so the user doesn't keep looking at the stale
        // cached result (e.g. "PARTIAL — 2 partial fix(es) [partial] 4.W:
        // b4 → b3 ...") while the new run grinds for 20-40s. Without
        // this, _loadGame's "Queued..." placeholder appears only on the
        // initial-load path, not on user-action-triggered requeues, so
        // the stale content sits there until handleSearchComplete fires.
        if (index === pgnBatchState.currentIndex) {
          if (typeof clearPanelLog === 'function') {
            try { clearPanelLog('greedy'); } catch (_e) {}
          }
          if (typeof updateSearchPanel === 'function') {
            try { updateSearchPanel('greedy', 'Running...', 0); } catch (_e) {}
          }
          // Hide stale Review/Apply buttons left over from the prior
          // run — they reference the cached result which we're about
          // to replace, and a click would walk through a stale fix list.
          if (typeof showReviewButton === 'function') {
            try { showReviewButton('greedy', false); } catch (_e) {}
          }
        }

        try {
          // If the user has interacted with this game (snapshot exists),
          // feed Greedy the snapshot's corrected moves AND the user's
          // lockedPlies so the re-run respects overrides. Otherwise use
          // the original parsed sans with empty locks. Reported case:
          // user "Keep Qe1" override needs Greedy to re-run with 10.W
          // locked so it doesn't re-propose Qe1 → Qe2.
          var sansForAlgo = g.sans;
          var lockedForAlgo = [];
          var confirmedPlyForAlgo = 0;
          if (g.snapshot && Array.isArray(g.snapshot.moves) && g.snapshot.moves.length) {
            sansForAlgo = [];
            g.snapshot.moves.forEach(function(m) {
              if (m.white) sansForAlgo.push(m.white);
              if (m.black) sansForAlgo.push(m.black);
            });
            if (Array.isArray(g.snapshot.lockedPlies)) {
              lockedForAlgo = g.snapshot.lockedPlies.slice();
            }
            // The snapshot's confirmedPly is the user's frontier — every
            // ply below it is auto-approved for EAD bypass (see search-
            // worker.js's _g_approved = set(range(confirmed_ply))). Without
            // threading this through, the background Greedy runs with
            // confirmed_ply=0, EAD re-detects "bad trade" at the locked
            // 4.W Nxf7, and Greedy proposes upstream fixes for a move
            // the user explicitly accepted.
            confirmedPlyForAlgo = g.snapshot.confirmedPly | 0;
          }
          var ocrMoves = _buildOcrMovesForAlgo({ sans: sansForAlgo });
          // Fresh SearchManager per game so background work doesn't
          // clobber the user's foreground interactive search workers.
          var mgr = new SearchManager();
          var results = await mgr.launchSearchesPromise(
            ocrMoves,
            ['greedy'],
            {
              greedy: {
                max_fixes: 15,
                confirmed_ply: confirmedPlyForAlgo,
                max_backtrack: 999  // PGN-review depth
              }
            },
            {},  // no per-step callbacks needed for background runs
            lockedForAlgo
          );
          g.algoResult = results && results.greedy ? results.greedy : null;
          // Record the locks/fixes baseline this result was computed
          // against. onCurrentGameValidated diffs current state against
          // this to decide whether a follow-up user action (keep-as-is
          // / apply fix) actually invalidates the cached result.
          g.algoResultBaselineLockedPlies = lockedForAlgo.slice();
          g.algoResultBaselineFixedPlies =
            (g.snapshot && Array.isArray(g.snapshot.fixedPlies))
              ? g.snapshot.fixedPlies.slice()
              : [];
          // If the user got the game to valid/verified while this background
          // Greedy was in flight, the result is computed against the
          // pre-completion position and is moot — don't let it override the
          // 'valid'/'solved' status set by onCurrentGameValidated, and
          // don't paint it over the "✓ Game complete" banner that
          // markPanelsGameComplete just put in the Greedy panel.
          var gameAlreadyDone = (g.status === 'valid' || g.status === 'verified');
          if (!gameAlreadyDone) {
            g.algoStatus = _computeAlgoStatus(g.algoResult);
          }
          // Fresh result — clear the stale-after-user-fix marker.
          g.algoResultDirty = false;
          // If this is the currently-displayed game, paint the result
          // into the Greedy panel immediately so the user sees it
          // without having to click away and back. The same handler
          // single-shot fires when launchSearchesPromise resolves in
          // the regular flow.
          if (index === pgnBatchState.currentIndex
              && g.algoResult
              && !gameAlreadyDone
              && typeof handleSearchComplete === 'function') {
            try {
              // Clear the "⏳ Queued for background Greedy" placeholder
              // (and any other prior log lines for this panel) before
              // painting the result, so the panel reads cleanly
              // "SOLVED (N fixes) [fix] ..." instead of "Queued..."
              // followed by the result.
              if (typeof clearPanelLog === 'function') clearPanelLog('greedy');
              handleSearchComplete('greedy', g.algoResult);
            } catch (_paintErr) {
              if (typeof console !== 'undefined') console.error('PgnBatch live-paint after queue:', _paintErr);
            }
          }
        } catch (e) {
          g.algoStatus = 'failed';
          if (typeof console !== 'undefined') console.error('PgnBatch Greedy failed for game ' + (index + 1) + ':', e);
        }
        renderSidebar();

        // This iteration is done — clear the in-flight marker so a
        // _prioritizeInQueue for this index (e.g. user keep-as-is that
        // invalidated the cache) can re-queue without being skipped.
        pgnBatchState.algoCurrentIndex = null;

        // Tiny yield so the UI thread can repaint between games.
        await new Promise(function(r) { setTimeout(r, 50); });
      }
    } finally {
      pgnBatchState.algoBusy = false;
      pgnBatchState.algoCurrentIndex = null;
    }
  }

  function cancelAlgoQueue() {
    pgnBatchState.algoCancelled = true;
    pgnBatchState.algoQueue.length = 0;
    renderSidebar();
  }

  function selectGame(index) {
    if (index < 0 || index >= pgnBatchState.games.length) return;
    if (index === pgnBatchState.currentIndex) return;
    _snapshotCurrent();
    pgnBatchState.currentIndex = index;
    _loadGame(index);
    renderSidebar();
  }

  function markVerifiedCurrent() {
    if (pgnBatchState.currentIndex < 0) return;
    var g = pgnBatchState.games[pgnBatchState.currentIndex];
    if (g) {
      g.status = 'verified';
      renderSidebar();
    }
  }

  // Build a PGN string for one game, using the current (possibly corrected)
  // moves plus the original tags. Reconstruct the flat SAN list from the
  // snapshotted paired-moves array — state.sans only covers plies up to the
  // stuck point, so falling back on state.sans would truncate the export.
  function _buildGamePgn(g, index) {
    var sans;
    if (g.snapshot && g.snapshot.moves && g.snapshot.moves.length) {
      sans = [];
      g.snapshot.moves.forEach(function(m) {
        if (m.white) sans.push(m.white);
        if (m.black) sans.push(m.black);
      });
    } else {
      sans = g.sans;
    }
    var lines = [];
    // Tags in original order
    g.tagOrder.forEach(function(k) {
      var v = (g.tags[k] || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push('[' + k + ' "' + v + '"]');
    });
    // Source tag per CLAUDE.md
    if (!('Source' in g.tags)) {
      lines.push('[Source "Zugwise (gerhardtrippen.github.io/zugwise)"]');
    }
    lines.push('');
    // Move text: "1. e4 c5 2. Nf3 Nc6 ..." plus result
    var move_text = [];
    for (var i = 0; i < sans.length; i += 2) {
      var num = (i / 2 + 1) + '.';
      var w = sans[i] || '';
      var b = sans[i + 1] || '';
      move_text.push(num + ' ' + w + (b ? ' ' + b : ''));
    }
    var result = g.tags.Result || '*';
    lines.push(move_text.join(' ') + ' ' + result);
    return lines.join('\n');
  }

  function exportCombinedPgn() {
    // Snapshot the current game first so its in-progress fixes are included.
    _snapshotCurrent();
    var blocks = pgnBatchState.games.map(_buildGamePgn);
    return blocks.join('\n\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // Sidebar rendering
  // ---------------------------------------------------------------------------

  function _esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _shortName(full) {
    if (!full) return '?';
    // "Lastname, Firstname" → "Lastname"
    return String(full).split(',')[0].trim() || '?';
  }

  function _gameLabel(g, index) {
    var rb = '';
    if (g.tags.Round)  rb += 'R' + g.tags.Round;
    if (g.tags.Board)  rb += (rb ? '.B' : 'B') + g.tags.Board;
    if (!rb) rb = 'Game ' + (index + 1);
    var w = _shortName(g.tags.White);
    var b = _shortName(g.tags.Black);
    return rb + ': ' + w + ' vs ' + b;
  }

  // Compact per-game algorithm-status pill, matching the OCR batch's
  // _renderMethodStatus output: letter + glyph (+ ply suffix for partial).
  // Hidden when the game has no algo activity (status='unvalidated' /
  // 'error', or pending+queue idle).
  function _renderAlgoBadge(g) {
    var s = g.algoStatus;
    if (!s) return '';
    // Hide the badge when the game was already valid on import — Greedy
    // wasn't run on it, so showing G✓ "Already valid" implies algo
    // activity that didn't happen. The game's overall ✅ status icon
    // already tells the user the game is fine.
    if (s === 'valid') return '';
    var info = ALGO_STATUS_DISPLAY[s];
    if (!info) return '';

    // For "partial" results, append the highest ply the algorithm reached
    // — same heuristic OCR batch uses. Prefer reached_ply, then highest
    // applied-fix ply+1, then moves.length as a last resort. moves.length
    // alone overstates progress when fixes were applied but downstream
    // didn't validate.
    var suffixHtml = '';
    var titleSuffix = '';
    if (s === 'partial' && g.algoResult) {
      var r = g.algoResult;
      var ply = null;
      if (typeof r.reached_ply === 'number' && r.reached_ply >= 0) {
        ply = r.reached_ply;
      } else if (Array.isArray(r.fixes) && r.fixes.length > 0) {
        var maxFixPly = -1;
        r.fixes.forEach(function(f) {
          if (typeof f.ply === 'number' && f.ply > maxFixPly) maxFixPly = f.ply;
        });
        if (maxFixPly >= 0) ply = maxFixPly + 1;
      } else if (Array.isArray(r.moves)) {
        ply = r.moves.length;
      }
      if (ply != null && ply > 0) {
        var moveNo = Math.ceil(ply / 2);
        suffixHtml = '<span class="text-amber-200 font-semibold">' + moveNo + '</span>';
        titleSuffix = ' (reached move ' + moveNo + ', ply ' + ply + ')';
      }
    }

    return '<span class="' + info.cssClass + ' text-sm font-mono leading-none shrink-0" '
         +    'title="G: ' + _esc(info.label) + titleSuffix + '">'
         +    'G' + info.glyph + suffixHtml
         + '</span>';
  }

  // Sort buckets for the sidebar display order. Games still needing
  // review (stuck/unvalidated/error) sort above games already finished
  // (valid/verified) so the user can pick up the next unfinished game
  // without scrolling past completed ones. Within each bucket, sort by
  // Greedy progress → round → board → original parse order.
  function _reviewBucket(status) {
    return (status === 'valid' || status === 'verified') ? 1 : 0;
  }

  // Greedy-progress bucket: games with a finished Greedy result (or
  // already-valid games that didn't need Greedy at all) sort first
  // within the review bucket, because the user can act on those right
  // away — the suggestions are sitting there. Then in-flight runs,
  // then queued, then "no algoStatus at all" at the bottom. Order
  // matches the user's actionability gradient: ready > running >
  // waiting > unknown.
  function _greedyBucket(algoStatus) {
    if (algoStatus === 'solved' || algoStatus === 'partial'
        || algoStatus === 'failed' || algoStatus === 'valid') return 0;
    if (algoStatus === 'running') return 1;
    if (algoStatus === 'pending') return 2;
    return 3;  // undefined / null / anything else
  }

  // Numeric comparator that pushes NaN to the end so games missing the
  // Round (or Board) tag don't randomly leapfrog tagged games.
  function _cmpNumWithNaNLast(a, b) {
    var na = isNaN(a), nb = isNaN(b);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a - b;
  }

  // Index-comparator used by both renderSidebar and verifyAndContinue
  // so "next game" matches the visible list order.
  function _compareGameIndices(ai, bi) {
    var games = pgnBatchState.games;
    var a = games[ai], b = games[bi];
    var ba = _reviewBucket(a.status), bb = _reviewBucket(b.status);
    if (ba !== bb) return ba - bb;
    var ga = _greedyBucket(a.algoStatus), gb = _greedyBucket(b.algoStatus);
    if (ga !== gb) return ga - gb;
    var rd = _cmpNumWithNaNLast(parseInt(a.tags.Round, 10), parseInt(b.tags.Round, 10));
    if (rd !== 0) return rd;
    var bd = _cmpNumWithNaNLast(parseInt(a.tags.Board, 10), parseInt(b.tags.Board, 10));
    if (bd !== 0) return bd;
    return ai - bi;  // tie-break on parse order
  }

  function _stuckLabel(g) {
    if (g.status !== 'stuck' || !g.validateResult) return '';
    var ply = g.validateResult.stuck_at;
    if (ply === null || ply === undefined) return '';
    var moveNum = Math.floor(ply / 2) + 1;
    var color = ply % 2 === 0 ? 'W' : 'B';
    var reason = g.validateResult.stuck_reason || 'illegal';
    return ' <span class="text-yellow-300 text-xs">@' + moveNum + '.' + color
         + ' <span class="text-gray-500">(' + _esc(reason).replace(/_/g, ' ') + ')</span></span>';
  }

  function renderSidebar() {
    var container = document.getElementById('batch-game-list');
    if (!container) return;

    if (!pgnBatchState.active || pgnBatchState.games.length === 0) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return;
    }

    container.classList.remove('hidden');

    var games = pgnBatchState.games;
    var verifiedCount = games.filter(function(g) { return g.status === 'verified'; }).length;
    var stuckCount    = games.filter(function(g) { return g.status === 'stuck'; }).length;
    var algoRunning   = games.filter(function(g) { return g.algoStatus === 'running'; }).length;
    var algoPending   = pgnBatchState.algoQueue.length;

    var html = '';
    // Header
    html += '<div class="px-3 py-2 border-b border-gray-700 text-sm flex items-center justify-between">'
         +    '<span class="font-semibold">📚 PGN Batch: ' + games.length + ' games</span>'
         +    '<span class="text-xs text-gray-400">'
         +      verifiedCount + ' verified'
         +      (stuckCount > 0 ? ' · <span class="text-yellow-300">' + stuckCount + ' to review</span>' : '')
         +      ((algoRunning + algoPending) > 0
                  ? ' · <span class="text-blue-300">⚙️ Greedy ' + (algoRunning ? 'running' : 'queued')
                    + (algoPending > 0 ? ' (' + algoPending + ' pending)' : '')
                    + '</span>'
                  : '')
         +      ' · <button onclick="PgnBatch._exportClicked()" class="text-blue-300 hover:text-blue-200 underline">Export combined PGN</button>'
         +    '</span>'
         + '</div>';

    // Display order: needs-review first (stuck/unvalidated/error), then
    // by round → board → parse order. The underlying games array stays
    // in parse order so selectGame(index) / algoQueue / snapshot lookups
    // continue to use the original indices; we only reorder the view.
    var sortedIndices = games.map(function(_, k) { return k; });
    sortedIndices.sort(_compareGameIndices);

    sortedIndices.forEach(function(i) {
      var g = games[i];
      var statusInfo = STATUS_DISPLAY[g.status] || STATUS_DISPLAY.unvalidated;
      var isCurrent = (i === pgnBatchState.currentIndex);
      var rowClass = 'pgn-batch-row px-3 py-1.5 border-b border-gray-700/60 cursor-pointer text-sm flex items-center gap-2 '
                   + (isCurrent ? 'bg-blue-900/40 border-l-2 border-l-blue-400' : 'hover:bg-gray-700/60');

      var rb = '';
      if (g.tags.Round) rb += 'R' + g.tags.Round;
      if (g.tags.Board) rb += (rb ? '.B' : 'B') + g.tags.Board;
      if (!rb) rb = 'G' + (i + 1);

      var white = _shortName(g.tags.White);
      var black = _shortName(g.tags.Black);
      var result = g.tags.Result || '';

      // Greedy badge: "G" + glyph (+ optional move-number suffix for
      // partial). Format matches the OCR batch sidebar so the user sees
      // the same vocabulary across both batch modes. Suffix appears only
      // for partial (reached move N — same heuristic OCR batch uses).
      var algoBadge = _renderAlgoBadge(g);

      html += '<div class="' + rowClass + '" onclick="PgnBatch.selectGame(' + i + ')">'
           +    '<span class="' + statusInfo.cssClass + ' shrink-0" title="' + _esc(statusInfo.label) + '">' + statusInfo.icon + '</span>'
           +    '<span class="text-gray-300 text-xs w-20 shrink-0 font-mono">' + _esc(rb) + '</span>'
           +    '<span class="flex-1 truncate text-gray-200">' + _esc(white) + ' vs ' + _esc(black) + _stuckLabel(g) + '</span>'
           +    algoBadge
           +    '<span class="text-xs text-gray-500 shrink-0 w-12 text-right">' + _esc(result) + '</span>'
           + '</div>';
    });

    container.innerHTML = html;
  }

  function _exportClicked() {
    var pgn = exportCombinedPgn();
    var blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'zugwise_batch_' + new Date().toISOString().replace(/[:.]/g, '-') + '.pgn';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof log === 'function') log('💾 Exported combined PGN (' + pgnBatchState.games.length + ' games)');
  }

  function reset() {
    // Cancel any in-flight algorithm queue so it stops touching pgnBatchState
    // (and re-rendering) after we wipe games.
    pgnBatchState.algoCancelled = true;
    pgnBatchState.algoQueue.length = 0;
    pgnBatchState.active = false;
    pgnBatchState.games = [];
    pgnBatchState.currentIndex = -1;
    renderSidebar();
    var header = document.getElementById('game-header');
    if (header) header.classList.add('hidden');
    // Restore the PGN-input disclosure to its default open state +
    // "Paste a PGN" label — the user is back to single-game review,
    // so the textareas should be visible without an extra click.
    var _disc = document.getElementById('pgn-input-disclosure');
    var _summ = document.getElementById('pgn-input-disclosure-summary');
    if (_disc) _disc.open = true;
    if (_summ) _summ.textContent = 'Paste a PGN';
  }

  return {
    isMultiGame: isMultiGame,
    parseMultiGamePgn: parseMultiGamePgn,
    initBatch: initBatch,
    selectGame: selectGame,
    markVerifiedCurrent: markVerifiedCurrent,
    verifyAndContinue: verifyAndContinue,
    onCurrentGameValidated: onCurrentGameValidated,
    updateCurrentGameAlgoResult: updateCurrentGameAlgoResult,
    exportCombinedPgn: exportCombinedPgn,
    cancelAlgoQueue: cancelAlgoQueue,
    reset: reset,
    _exportClicked: _exportClicked,
    state: pgnBatchState,
  };
})();
