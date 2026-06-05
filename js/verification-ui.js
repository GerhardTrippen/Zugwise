// =============================================================================
// verification-ui.js — Three-panel verification UI for batch reconstruction
// =============================================================================
// Phase 3 of Batch Mode. Replaces the blind "Apply" flow on algorithm results
// with a guided walkthrough: user eyeballs each algorithm fix against the
// original scoresheet image and the move list, and either confirms or
// overrides it. Overrides trigger a requeue via BatchReconstructQueue.
//
// Integration model:
//   - Entry via `Review Solution` buttons next to existing Apply buttons
//     (beam.js / index.html), or auto-enter via batch-game-list.selectGame()
//     when a reconstruction result has been picked for the game.
//   - Verification state lives on `state.verification` — additive, does not
//     modify pre-existing state fields.
//   - Existing panel-fixes DOM is snapshotted and restored on exit.
//   - Move list is rendered by the existing renderMoveList() from ui.js;
//     we overlay fix indicators and matching-color classes on top of it.
//
// Dependencies (loaded before this file):
//   - state / chess (app.js)
//   - renderMoveList, showAutoFixFlash (ui.js)
//   - goToPly (navigation.js)
//   - BatchGameList, BatchReconstructQueue (batch-*.js)
// =============================================================================

var VerificationUI = (function() {
  'use strict';

  // Matching colors — fixes in both the scoresheet canvas and the move list
  // rotate through these so the eye can pair them up at a glance.
  var FIX_COLORS = [
    { fill: 'rgba(239, 68, 68, 0.35)',  stroke: 'rgba(239, 68, 68, 1.0)',  cls: 'vfix-red' },
    { fill: 'rgba(59, 130, 246, 0.35)', stroke: 'rgba(59, 130, 246, 1.0)', cls: 'vfix-blue' },
    { fill: 'rgba(234, 179, 8, 0.35)',  stroke: 'rgba(234, 179, 8, 1.0)',  cls: 'vfix-yellow' },
    { fill: 'rgba(34, 197, 94, 0.35)',  stroke: 'rgba(34, 197, 94, 1.0)',  cls: 'vfix-green' },
    { fill: 'rgba(168, 85, 247, 0.35)', stroke: 'rgba(168, 85, 247, 1.0)', cls: 'vfix-purple' }
  ];

  // Display labels for algorithm keys. Internal code uses lowercase keys;
  // user-visible strings use the capitalized form ("Greedy", "Beam", "Dijkstra").
  var _METHOD_LABELS = {
    greedy:   'Greedy',
    beam:     'Beam',
    dijkstra: 'Dijkstra'
  };
  function _labelForMethod(m) {
    if (!m) return 'Algorithm';
    var key = String(m).toLowerCase();
    return _METHOD_LABELS[key] || (m.charAt(0).toUpperCase() + m.slice(1));
  }

  // =========================================================================
  // State helpers — live on state.verification so nothing else is clobbered
  // =========================================================================

  function _ensureState() {
    if (typeof state === 'undefined') return null;
    if (!state.verification) {
      state.verification = {
        active: false,
        gameId: null,
        method: null,
        fixes: [],
        currentFixIndex: 0,
        overrides: [],
        picked: null,
        ocrResult: null
      };
    }
    return state.verification;
  }

  function isActive() {
    return typeof state !== 'undefined' &&
           state.verification && state.verification.active === true;
  }

  // =========================================================================
  // Enter / Exit
  // =========================================================================

  /**
   * Enter verification mode for a game.
   *
   * @param {string} gameId
   * @param {Object} picked - {method, result:{status, moves, fixes}} from
   *                          BatchTriage.pickBestResult().
   * @param {Object} [ocrResult] - The OCR result dict from the batch queue
   *                               (carries sheet1Image/sheet2Image/gridSidecar).
   * @returns {boolean} - true if entered, false if picked had no solution
   */
  function enterVerificationMode(gameId, picked, ocrResult) {
    var v = _ensureState();
    if (!v) return false;
    if (!picked || !picked.result || !picked.result.moves || picked.result.moves.length === 0) {
      if (typeof log === 'function') log('No reconstruction result to verify for ' + gameId);
      return false;
    }

    // All-confirmed short-circuit: if every algorithm-proposed fix already
    // has wStatus/bStatus='fixed' or 'locked' in state.moves, there's
    // nothing to walk through — the user finished reviewing in a prior
    // session. Previously we'd still enter verification, clamp the
    // walkthrough cursor to the last fix, and dump the user at a fake
    // "re-confirm the last fix" screen; reported: closing and reopening a
    // finished game showed "36.B Rd4 is illegal" with a Confirm button
    // for Rd4 → Rd8 even though Rd8 was already baked into the move list.
    // Decline entry so the caller's post-select flow can run revalidate()
    // and show the real state ("Game complete!" or the next remaining
    // stuck point).
    var _pickedFixes = picked.result.fixes || [];
    if (_pickedFixes.length > 0 && typeof state !== 'undefined' &&
        Array.isArray(state.moves)) {
      var _acAll = true;
      for (var _aci = 0; _aci < _pickedFixes.length; _aci++) {
        var _acPly = _fixPly(_pickedFixes[_aci]);
        if (_acPly == null) { _acAll = false; break; }
        var _acM = state.moves[Math.floor(_acPly / 2)];
        if (!_acM) { _acAll = false; break; }
        var _acStat = (_acPly % 2 === 0) ? _acM.wStatus : _acM.bStatus;
        if (_acStat !== 'fixed' && _acStat !== 'locked') {
          _acAll = false;
          break;
        }
      }
      if (_acAll) {
        if (typeof log === 'function') {
          log('  ◦ skipping verify entry for ' + gameId + ' — all ' +
              _pickedFixes.length + ' fix(es) already confirmed');
        }
        return false;
      }
    }

    // Note: earlier attempt here was a hard short-circuit when v.active
    // && v.gameId === incoming gameId. That turned out to be too
    // aggressive — switching A → B → A legitimately needs to re-enter
    // the walkthrough on A because processAllSheets + restore between
    // the switches clear the move-list overlays that renderVerificationMoveList
    // originally painted. Skipping re-entry left the move list with no
    // strike-through indicators even though verify state still pointed
    // at A. The _focusFixGeneration guard below is enough to handle the
    // stale-async-tail race, so let the full entry run every time.

    if (typeof log === 'function') {
      var _enF = 0, _enL = 0;
      if (typeof state !== 'undefined' && Array.isArray(state.moves)) {
        state.moves.forEach(function(m) {
          if (m.wStatus === 'fixed') _enF++;
          if (m.bStatus === 'fixed') _enF++;
          if (m.wStatus === 'locked') _enL++;
          if (m.bStatus === 'locked') _enL++;
        });
      }
      var confEntry = _enF + (_enL > 0 ? ' (+' + _enL + ' locked)' : '');
      log('  🔎 enter verify ' + gameId + ' — ' + _labelForMethod(picked.method) +
          ' solved with ' + ((picked.result.fixes || []).length) + ' fixes; ' +
          confEntry + ' already confirmed');
    }

    v.active = true;
    v.gameId = gameId;
    v.method = picked.method || null;
    v.methodLabel = _labelForMethod(v.method);
    v.picked = picked;
    v.ocrResult = ocrResult || null;
    // Stamp each fix with its iteration index BEFORE sorting. picked.result.fixes
    // arrives in the algorithm's application order — e.g. for greedy, the order
    // in which each fix came out of the backtracking loop, which isn't
    // monotonic in ply (later fixes can backtrack to earlier plies). Sorting
    // by ply for the walkthrough is still the right default (the user reads
    // the game chronologically), but we preserve the algorithm's step number
    // so the header can show "step 13" for a fix that landed 13th in the
    // greedy cascade even though it's shown at position 2 in review.
    // Build the locked-ply set from ALL authoritative sources. A backtrack
    // fix whose origin_stuck_ply is locked/approved is stale: the user
    // already accepted that move (keep-as-is or override), so proposing to
    // repair an EARLIER ply to avoid it makes no sense.
    //
    // state.lockedPlies / state.approvedPlies can diverge from state.moves in
    // async save/restore edge cases, so we derive primarily from state.moves
    // (the 🔒 display is driven by its .wStatus/.bStatus fields, making it
    // the definitive truth about what the user has locked).
    var _lockedForEntry = new Set();
    if (typeof state !== 'undefined') {
      if (Array.isArray(state.lockedPlies)) {
        state.lockedPlies.forEach(function(p) { _lockedForEntry.add(Number(p)); });
      }
      if (Array.isArray(state.approvedPlies)) {
        state.approvedPlies.forEach(function(p) { _lockedForEntry.add(Number(p)); });
      }
      // Derive from state.moves — most reliable; directly drives the 🔒 display.
      if (Array.isArray(state.moves)) {
        state.moves.forEach(function(m, mi) {
          if (m && m.wStatus === 'locked') _lockedForEntry.add(mi * 2);
          if (m && m.bStatus === 'locked') _lockedForEntry.add(mi * 2 + 1);
        });
      }
    }
    v.fixes = (picked.result.fixes || []).map(function(f, i) {
      f._algoStepIdx = i;  // 0-based position in the algorithm's sequence
      return f;
    }).filter(function(f) {
      if (f.is_backtrack && typeof f.origin_stuck_ply === 'number' &&
          _lockedForEntry.has(f.origin_stuck_ply)) {
        if (typeof log === 'function') {
          log('  ◦ dropping stale backtrack fix ply=' + f.ply +
              ' (origin_stuck_ply=' + f.origin_stuck_ply + ' is locked)');
        }
        return false;
      }
      return true;
    }).slice().sort(function(a, b) {
      return (_fixPly(a) || 0) - (_fixPly(b) || 0);
    });
    if (v.fixes.length === 0) {
      if (typeof log === 'function') {
        log('  ◦ skipping verify entry for ' + gameId +
            ' — all fix proposals stale (origin stuck plies are locked)');
      }
      return false;
    }
    v.overrides = [];

    // Resume-at-first-unconfirmed: if the user already walked through some
    // fixes in a prior session on this game (wStatus='fixed' / 'locked' on
    // the corresponding ply in the pre-entry state.moves), skip past those
    // and open the walkthrough at the first still-pending one. Without
    // this, switching away and back always dumped the user at fix #1
    // even if they'd already confirmed 5 — no way to continue from where
    // they left off.
    v.currentFixIndex = 0;
    var _resumeDiag = [];
    if (typeof state !== 'undefined' && Array.isArray(state.moves)) {
      var _resumeFound = false;
      for (var fi = 0; fi < v.fixes.length; fi++) {
        var fp = _fixPly(v.fixes[fi]);
        if (fp == null) continue;
        var fmIdx = Math.floor(fp / 2);
        var fm = state.moves[fmIdx];
        if (!fm) {
          v.currentFixIndex = fi;
          _resumeDiag.push('ply' + fp + ':no-entry');
          _resumeFound = true;
          break;
        }
        var stat = (fp % 2 === 0) ? fm.wStatus : fm.bStatus;
        var curMove = (fp % 2 === 0) ? fm.white : fm.black;
        var fixSan = _fixSan(v.fixes[fi]);
        // A confirmed ply is "done" (skippable) ONLY if the fix proposes the
        // SAME move that's already there. If the algorithm changed its mind
        // (different SAN) at a previously-confirmed ply, that fix MODIFIES the
        // board and MUST be reviewed — skipping it leaves the displayed board on
        // the old move while the downstream fixes were computed against the new
        // one, so a later fix goes illegal (reported: prior run confirmed
        // 35.B Nd6, this run proposes Nd6->Nd8; skipping it kept Nd6 on the board
        // and 38.W Bd6 — computed for Nd8 — became illegal).
        var sameMove = curMove && fixSan &&
                       curMove.replace(/[+#]$/, '') === fixSan.replace(/[+#]$/, '');
        var confirmed = (stat === 'fixed' || stat === 'locked') && sameMove;
        if (!confirmed) {
          v.currentFixIndex = fi;
          _resumeDiag.push('ply' + fp + ':' + (stat || 'null') +
                           (sameMove ? '' : '/changed') + '=stop');
          _resumeFound = true;
          break;
        }
        // Loop continues — this fix exactly repeats an already-confirmed move.
        v.currentFixIndex = fi + 1;
        if (fi < 3) _resumeDiag.push('ply' + fp + ':' + stat + '=skip');
      }
      if (!_resumeFound && v.currentFixIndex >= v.fixes.length) {
        // Every fix already confirmed? Clamp so _focusFix doesn't blow up;
        // the walkthrough will still show "N/N" and _finishReview is a
        // single Confirm away.
        v.currentFixIndex = Math.max(0, v.fixes.length - 1);
        _resumeDiag.push('ALL-CONFIRMED:clamp');
      }
    }
    if (typeof log === 'function') {
      var resumeHuman = 'resuming at fix #' + (v.currentFixIndex + 1) +
                       ' of ' + v.fixes.length;
      if (v.currentFixIndex < v.fixes.length) {
        var rfix = v.fixes[v.currentFixIndex];
        var rPly = _fixPly(rfix);
        if (rPly != null) {
          var rNum = Math.floor(rPly / 2) + 1;
          var rCol = (rPly % 2 === 0) ? 'W' : 'B';
          resumeHuman += ' (' + rNum + '.' + rCol + ' → ' + _fixSan(rfix) + ')';
        }
      }
      log('  🔎 ' + resumeHuman);
    }

    // Set _verificationActive + bump searchGeneration so any inflight
    // fetchFixes launched by the pre-entry validate pass aborts cleanly.
    // Scenario: openGame → processAllSheets → revalidate → stuck at
    // (say) 28.B piece-hanging → fetchFixes kicks off async. We enter
    // verification with Greedy's partial, _focusFix paints 6.W content,
    // but the slower fetchFixes completion later writes 28.B content on
    // top. fetchFixes now captures searchGeneration at entry AND checks
    // state._verificationActive at every DOM-paint checkpoint, so both
    // its quick-fix render and its backtrack result get dropped.
    if (typeof state !== 'undefined' && state) {
      state.searchGeneration = (state.searchGeneration || 0) + 1;
      state._verificationActive = true;
    }

    // Save pre-review interactive state so we can restore it on exit.
    // Deep-clone moves/sans so override-exit can roll the timeline back
    // to the raw OCR baseline (pre-greedy-fixes) and rerun from there.
    v._savedState = {
      stuckPly: state.stuckPly,
      stuckInfo: state.stuckInfo,
      legalMoves: state.legalMoves,
      errorArrow: state.errorArrow,
      savedErrorArrow: state.savedErrorArrow,
      fixArrow: state.fixArrow,
      ocrArrow: state.ocrArrow,
      selectedFix: state.selectedFix,
      quickFixes: state.quickFixes,
      pendingConfirmation: state.pendingConfirmation,
      missingMoveCandidates: state.missingMoveCandidates
    };
    // Scrub stale wAlgoProposed cells (from a prior method's review
    // session that didn't exit cleanly) BEFORE snapshotting, so the
    // baseline we capture here is OCR + user confirmations only — never
    // a previous algorithm's suggested-only reconstruction. Without this,
    // a Review Beam → Review Greedy switch followed by a manual override
    // restores Beam's downstream moves as if confirmed; the game jumps
    // to "finished" carrying suggestion-only output.
    var _scrubbed = _revertUnconfirmedAlgoProposed();
    if (_scrubbed > 0 && typeof log === 'function') {
      log('  🔎 scrubbed ' + _scrubbed +
          ' stale algo-proposed cell(s) from prior review before snapshot');
    }
    v._preReviewMoves = _cloneMoves(state.moves);
    v._preReviewSans = (state.sans || []).slice();

    // Patch global selectFix/applyFix while in review mode so:
    //  - any selection (including from interactive's own button handlers)
    //    moves the yellow move-list highlight to the picked ply
    //  - any apply (double-click on a fix button or Confirm) that diverges
    //    from greedy's choice immediately exits review and requeues from
    //    the override ply (greedy's downstream fixes are now stale)
    _patchInteractiveFns();

    // Stage the picked solution into state.moves so the board + move list
    // reflect the full reconstructed game. Algorithm fixes are stamped
    // 'ok' + wAlgoProposed (suggestion-only); each ply is promoted to
    // 'fixed' only when the user confirms it via _confirmCurrentFix.
    _applyPickedToState(picked.result);

    // Snapshot #panel-fixes so exit can restore it, then inject the
    // scoresheet viewer + fix-review area.
    _swapPanelFixesToVerificationView();

    // Paint scoresheet highlights.
    _drawScoresheetHighlights();

    // Overlay fix indicators on the move list.
    renderVerificationMoveList();

    // Jump board to the CURRENT fix (respecting the resume-advance logic
    // above, which may have skipped past already-confirmed leading fixes
    // on re-entry into a partially-reviewed game). Passing the computed
    // v.currentFixIndex instead of a hard 0 is what makes "resume where
    // I left off" actually work — the previous _focusFix(0) call
    // blew away the advance decision on every entry, forcing users to
    // walk through every confirmed fix again after a game switch.
    if (v.fixes.length > 0) {
      _focusFix(v.currentFixIndex);
    } else if (typeof goToPly === 'function') {
      goToPly(state.sans.length);
    }

    if (typeof log === 'function') {
      log('\uD83D\uDD0D Verifying ' + gameId + ' (' + _labelForMethod(v.method) + ') \u2014 ' +
          v.fixes.length + ' fix(es) to review');
    }
    return true;
  }

  /**
   * Exit verification mode. Restores the panel-fixes DOM; leaves state.moves
   * intact so the user can keep editing interactively if they choose.
   */
  function exitVerificationMode(opts) {
    opts = opts || {};
    var clearAndRequeue = opts.clearAndRequeue === true;
    var v = _ensureState();
    if (!v || !v.active) return;

    // Revert every algo-proposed cell that the user did NOT confirm during
    // the walkthrough back to its pre-review value. _applyPickedToState
    // staged the algorithm's full reconstruction into state.moves on entry
    // (necessary so the move list can show the proposed sequence while the
    // user reviews each fix). Without rolling unconfirmed plies back on
    // exit, suggestion-only fixes silently outlive their Review session
    // and end up indistinguishable from accepted moves on game-switch /
    // re-open — the exact "algorithms must not survive without user
    // confirmation" leak this exit path is responsible for.
    //
    // Confirmed plies (wStatus='fixed' or 'locked') keep their user-
    // approved text — that's the point of Review. Cells that weren't
    // algo-proposed (wAlgoProposed not set) are left alone — those are
    // pre-existing OCR / corrections that Review didn't touch.
    var revertedCount = _revertUnconfirmedAlgoProposed();
    if (revertedCount > 0 && typeof log === 'function') {
      log('Exit Review: reverted ' + revertedCount +
          ' unconfirmed algo-proposed cell(s) to pre-review baseline');
    }

    // Plain Exit (clearAndRequeue=true): wipe all three search panels and
    // requeue the game so Greedy/Beam/Dijkstra re-run against the post-
    // revert baseline. Computed BEFORE we clear v.gameId/v.ocrResult since
    // _buildOcrMovesWithOverrides reads v.ocrResult. Override exits go via
    // _requeueAndExit which already dispatched its own requeue and then
    // calls exitVerificationMode() without the flag, so we don't double-
    // requeue here. Save / finish-review paths also skip this branch.
    var _exitedGameId = v.gameId;
    var _exitedMethodLabel = (typeof _labelForMethod === 'function')
      ? _labelForMethod(v.method) : v.method;
    var _requeueDispatch = null;
    if (clearAndRequeue && _exitedGameId) {
      var rq = (window.BatchGameList && window.BatchGameList.batchState &&
                window.BatchGameList.batchState.reconstructQueue) || null;
      if (rq && typeof rq.requeue === 'function') {
        var _ocrMoves = _buildOcrMovesWithOverrides(v.overrides || []);
        var _lockedPlies = [];
        if (Array.isArray(state.moves)) {
          state.moves.forEach(function(m) {
            if (!m) return;
            var wp = (m.num - 1) * 2;
            var bp = wp + 1;
            if (m.wStatus === 'fixed' || m.wStatus === 'locked') {
              if (_lockedPlies.indexOf(wp) === -1) _lockedPlies.push(wp);
            }
            if (m.bStatus === 'fixed' || m.bStatus === 'locked') {
              if (_lockedPlies.indexOf(bp) === -1) _lockedPlies.push(bp);
            }
          });
        }
        var _fromPly = (typeof state.confirmedPly === 'number' && state.confirmedPly >= 0)
          ? state.confirmedPly : 0;
        _requeueDispatch = {
          rq: rq,
          gameId: _exitedGameId,
          ocrMoves: _ocrMoves,
          lockedPlies: _lockedPlies,
          fromPly: _fromPly
        };
      }
    }

    v.active = false;
    v.gameId = null;
    v.fixes = [];
    v.currentFixIndex = 0;
    v.overrides = [];
    // Clear the fetchFixes abort guard — once verification is done, the
    // interactive stuck-position flow is allowed to paint again.
    if (typeof state !== 'undefined' && state) state._verificationActive = false;

    // Restore state fields we mutated during review. revalidate() will
    // override these with the true post-review values but we clear them
    // first so nothing lingers if revalidate is unavailable.
    if (v._savedState) {
      var s = v._savedState;
      state.stuckPly = s.stuckPly;
      state.stuckInfo = s.stuckInfo;
      state.legalMoves = s.legalMoves || [];
      state.errorArrow = s.errorArrow;
      state.savedErrorArrow = s.savedErrorArrow;
      state.fixArrow = s.fixArrow;
      state.ocrArrow = s.ocrArrow;
      state.selectedFix = s.selectedFix;
      state.quickFixes = s.quickFixes || [];
      state.pendingConfirmation = s.pendingConfirmation;
      state.missingMoveCandidates = s.missingMoveCandidates || [];
      v._savedState = null;
    }

    // Undo the global-fn patches before any further interactive code runs.
    _unpatchInteractiveFns();

    // Plain Exit: dispatch the deferred clear+requeue now that v is torn
    // down. Mirror the override path's order — invalidate caches first
    // (panels go "Superseded"), enqueue the game, then re-bind the panel
    // bridge so the fresh (empty) per-game aggregate renders into the
    // panels instead of leaving them on "Superseded" until the first
    // worker step lands.
    if (_requeueDispatch) {
      _invalidateSearchCaches();
      try {
        _requeueDispatch.rq.requeue(
          _requeueDispatch.gameId,
          _requeueDispatch.ocrMoves,
          _requeueDispatch.lockedPlies.slice(),
          _requeueDispatch.fromPly
        );
      } catch (e) { /* non-fatal */ }
      if (window.BatchPanelBridge) {
        try { window.BatchPanelBridge.bindGame(_requeueDispatch.gameId); } catch (e) {}
      }
      if (typeof log === 'function') {
        log('🔄 Exit Review (' + _exitedMethodLabel +
            ') — panels cleared, requeued ' + _requeueDispatch.gameId);
      }
    }

    // Restore the interactive #panel-fixes DOM from the snapshot we took on
    // entry, then let revalidate() repaint it with the real post-review
    // status ("Game complete" or the next remaining stuck point).
    _restorePanelFixes();
    if (typeof renderMoveList === 'function') renderMoveList();
    if (typeof renderArrows === 'function') {
      try { renderArrows(); } catch (e) {}
    }
    if (typeof revalidate === 'function') {
      try {
        var p = revalidate();
        if (p && typeof p.then === 'function') return p;
      } catch (e) { /* non-fatal */ }
    }
    return Promise.resolve();
  }

  // =========================================================================
  // Interactive-fn patching
  // =========================================================================
  // While in review, callers everywhere (button onclick handlers, keyboard
  // Enter, double-click, etc.) reach selectFix/applyFix through the global
  // bindings. Wrapping those bindings is cleaner than walking every button
  // in #fix-list and replacing handlers piecemeal — and it covers paths we
  // don't render ourselves (legal-move buttons, "Revert to OCR", etc.).

  var _origSelectFix = null;
  var _origApplyFix = null;

  function _patchInteractiveFns() {
    if (typeof window.selectFix === 'function' && _origSelectFix === null) {
      _origSelectFix = window.selectFix;
      window.selectFix = function(fix, btn) {
        var ret = _origSelectFix.apply(this, arguments);
        var v = _ensureState();
        if (v && v.active) {
          var sPly = (fix && typeof fix.ply === 'number') ? fix.ply
                   : (state.selectedFix && typeof state.selectedFix.ply === 'number') ? state.selectedFix.ply
                   : null;
          v.selectedPly = sPly;
          var stuckPly = _fixPly(v.fixes[v.currentFixIndex]);
          _paintReviewHighlights(stuckPly, sPly);

          // Confirm button must show the algorithm's EXACT SAN when the
          // clicked fix matches the algorithm's pick for this ply. The
          // fix-list buttons come from renderQuickFixes / mergeBacktrackFixes,
          // whose SAN is re-derived by python-chess against the UI's current
          // board state — which can diverge from the algorithm's stored SAN
          // in the +/# suffix (panel prints "R1d7+ → Rd7", button shows
          // "R1d7+ → Rd7+"). Align the button to the panel here; if the user
          // picks a different fix (override), leave the button alone — that's
          // the user's own choice and the requeue flow handles it.
          var algoFix = v.fixes[v.currentFixIndex];
          if (algoFix && fix && sPly != null && _fixPly(algoFix) === sPly) {
            var _normSan = function(s) { return s == null ? '' : String(s).replace(/[+#]+$/, ''); };
            var algoSan = _fixSan(algoFix);
            var clickedSan = fix.san || fix.fix_san || fix.new_san || '';
            if (algoSan && _normSan(algoSan) === _normSan(clickedSan) && algoSan !== clickedSan) {
              var applyBtn = document.getElementById('btn-apply');
              if (applyBtn) {
                applyBtn.textContent = '✓ Confirm: ' +
                                       (algoFix.ply_str || fix.ply_str || '') + ' ' +
                                       (algoFix.ocr || fix.ocr || '') +
                                       ' → ' + algoSan;
              }
            }
          }
        }
        return ret;
      };
    }
    if (typeof window.applyFix === 'function' && _origApplyFix === null) {
      _origApplyFix = window.applyFix;
      window.applyFix = function() {
        var v = _ensureState();
        if (v && v.active && state.selectedFix && v.fixes.length > 0) {
          var sel = state.selectedFix;
          var sPly = (typeof sel.ply === 'number') ? sel.ply : null;
          if (sPly == null && sel.ply_str) {
            var m = sel.ply_str.match(/^(\d+)\.([WB])$/i);
            if (m) sPly = (parseInt(m[1]) - 1) * 2 + (m[2].toUpperCase() === 'W' ? 0 : 1);
          }
          var sSan = sel.san || sel.fix_san || sel.new_san;
          var chosen = v.fixes[v.currentFixIndex];
          var chosenSan = _fixSan(chosen);
          var chosenPly = _fixPly(chosen);
          // Strip trailing +/# — see _onConfirmClick for why.
          var _normSan = function(s) { return s == null ? s : String(s).replace(/[+#]+$/, ''); };
          var _sanDiffers = sSan && _normSan(sSan) !== _normSan(chosenSan);
          var _plyDiffers = sPly != null && sPly !== chosenPly;
          if (sPly != null && sSan && (_sanDiffers || _plyDiffers)) {
            // Diverged from greedy = override + exit + requeue. Greedy's
            // downstream fixes were computed against a different timeline,
            // so we re-run from the override ply rather than keep walking
            // a stale fix list.
            _requeueAndExit(sPly, sSan);
          } else {
            // Same SAN at the same ply as greedy — just advance.
            _confirmCurrentFix();
          }
          return;
        }
        return _origApplyFix.apply(this, arguments);
      };
    }
  }

  function _unpatchInteractiveFns() {
    if (_origSelectFix !== null) {
      window.selectFix = _origSelectFix;
      _origSelectFix = null;
    }
    if (_origApplyFix !== null) {
      window.applyFix = _origApplyFix;
      _origApplyFix = null;
    }
  }

  // Collect OCR cells in a form that respects the dual-sheet merge:
  // both sheets' alternatives summed by confidence and exposed on the
  // merged cell. The previous approach (concat sheet1 + sheet2, then
  // overwrite cellByPly[ply]) silently kept only sheet 2's alternatives
  // for every ply because both sheets carry an entry at every ply and
  // sheet 2 was always last in concat order. Single-sheet input keeps
  // returning v.ocrResult.ocrCells unchanged.
  function _collectOcrCells(v) {
    if (!v || !v.ocrResult) return [];
    if (v.ocrResult.isDualSheet) {
      if (window.MergeSheets && typeof window.MergeSheets.mergeSheets === 'function') {
        var s1 = (typeof state !== 'undefined' && state.ocrCellsSheet1 &&
                  state.ocrCellsSheet1.length > 0)
          ? state.ocrCellsSheet1 : (v.ocrResult.sheet1 || []);
        var s2 = (typeof state !== 'undefined' && state.ocrCellsSheet2 &&
                  state.ocrCellsSheet2.length > 0)
          ? state.ocrCellsSheet2 : (v.ocrResult.sheet2 || []);
        return window.MergeSheets.mergeSheets(s1, s2) || [];
      }
      // Fallback if MergeSheets isn't loaded (shouldn't happen in practice).
      var fallback = [];
      if (v.ocrResult.sheet1) fallback = fallback.concat(v.ocrResult.sheet1);
      if (v.ocrResult.sheet2) fallback = fallback.concat(v.ocrResult.sheet2);
      return fallback;
    }
    return v.ocrResult.ocrCells || [];
  }

  // =========================================================================
  // Stage picked result into state.moves for the verification walkthrough.
  // Algorithm fixes land as 'ok' + wAlgoProposed (suggestion-only). The user
  // promotes each one to 'fixed' via _confirmCurrentFix during the walkthrough;
  // there is no auto-apply path.
  // =========================================================================

  function _applyPickedToState(result) {
    if (!result || !result.moves || typeof state === 'undefined') return;

    // Source OCR alts/conf from two places (whichever is populated):
    //   1. v._preReviewMoves — in interactive mode, state.moves already has
    //      wAlts/bAlts/wLenientAlts/bLenientAlts/wConf/bConf from OCR.
    //   2. v.ocrResult cells — in batch mode, the queue carries raw OCR
    //      cells (no state.moves yet). Fall back to these.
    // Without either, computeQuickFixes() sees empty alts and the Quick
    // Fixes section renders empty.
    var cellByPly = {};
    var v = _ensureState();
    _collectOcrCells(v).forEach(function(c) {
      var cp = (c.num - 1) * 2 + ((c.color === 'w' || c.color === 'W') ? 0 : 1);
      cellByPly[cp] = c;
    });

    function altsFromCell(cell) {
      if (!cell || !cell.alternatives) return [];
      return cell.alternatives.map(function(a) {
        var m = typeof a === 'string' ? a : (a && (a.move || a.san));
        var conf = typeof a === 'string' ? 0.1 : (a && a.confidence || 0.1);
        return { move: m, confidence: conf };
      }).filter(function(a) { return a.move; });
    }
    function lenientFromCell(cell) {
      // The JS pipeline (worker, merge-sheets, pairMoves) produces
      // `lenientAlternatives` (camelCase). `lenient_candidates` (snake_case)
      // is the Python OCRMove field name. Accept either so the batch-mode
      // fallback path (cells coming straight from the worker, no _preReviewMoves)
      // doesn't silently empty the lenient pool.
      if (!cell) return [];
      var src = cell.lenientAlternatives || cell.lenient_candidates;
      if (!src) return [];
      return src.map(function(a) {
        var m = typeof a === 'string' ? a : (a && (a.move || a.san));
        var conf = typeof a === 'string' ? 0.1 : (a && a.confidence || 0.1);
        return { move: m, confidence: conf };
      }).filter(function(a) { return a.move; });
    }
    // state.moves-style alts list (already in {move,confidence} shape).
    function altsFromPre(arr) {
      if (!arr || !arr.length) return [];
      return arr.map(function(a) {
        var m = Array.isArray(a) ? a[0] : (typeof a === 'string' ? a : (a && (a.move || a.san)));
        var conf = Array.isArray(a) ? (a[1] || 0.1) : (typeof a === 'string' ? 0.1 : (a && a.confidence || 0.1));
        return { move: m, confidence: conf };
      }).filter(function(a) { return a.move; });
    }

    var preMoves = (v && v._preReviewMoves) || [];
    var paired = [];
    for (var i = 0; i < result.moves.length; i += 2) {
      var moveIdx = i / 2;
      var wCell = cellByPly[i];
      var bCell = cellByPly[i + 1];
      var preEntry = preMoves[moveIdx] || null;

      // Prefer pre-review state.moves entries (interactive) for alts; fall
      // back to raw OCR cells (batch).
      var wAltsResolved = (preEntry && preEntry.wAlts && preEntry.wAlts.length > 0)
        ? altsFromPre(preEntry.wAlts) : altsFromCell(wCell);
      var bAltsResolved = (preEntry && preEntry.bAlts && preEntry.bAlts.length > 0)
        ? altsFromPre(preEntry.bAlts) : altsFromCell(bCell);
      var wLenResolved = (preEntry && preEntry.wLenientAlts && preEntry.wLenientAlts.length > 0)
        ? altsFromPre(preEntry.wLenientAlts) : lenientFromCell(wCell);
      var bLenResolved = (preEntry && preEntry.bLenientAlts && preEntry.bLenientAlts.length > 0)
        ? altsFromPre(preEntry.bLenientAlts) : lenientFromCell(bCell);
      var wConfResolved = (preEntry && typeof preEntry.wConf === 'number') ? preEntry.wConf
        : (wCell && typeof wCell.confidence === 'number' ? wCell.confidence : 0.9);
      var bConfResolved = (preEntry && typeof preEntry.bConf === 'number') ? preEntry.bConf
        : (bCell && typeof bCell.confidence === 'number' ? bCell.confidence : 0.9);

      paired.push({
        num: moveIdx + 1,
        white: result.moves[i] || '',
        black: result.moves[i + 1] || '',
        wStatus: 'ok',
        bStatus: result.moves[i + 1] ? 'ok' : 'pending',
        wConf: wConfResolved,
        bConf: bConfResolved,
        wAlts: wAltsResolved,
        bAlts: bAltsResolved,
        wLenientAlts: wLenResolved,
        bLenientAlts: bLenResolved
      });
    }

    var _diagPreservedCount = 0, _diagOkCount = 0, _diagCarriedCount = 0;
    if (result.fixes && result.fixes.length > 0) {
      result.fixes.forEach(function(fix) {
        var p = _fixPly(fix);
        if (p == null) return;
        var moveIdx = Math.floor(p / 2);
        if (!paired[moveIdx]) return;
        var color = (p % 2 === 0) ? 'w' : 'b';
        // Stamp as 'ok' + wOriginal + wAlgoProposed flag. The algo-
        // proposed flag tells ui.js's corrInd to SUPPRESS the ⚡ "auto-
        // corrected by quick-fix" marker — that's reserved for
        // validate_moves's similarity swaps. Algorithm fixes have their
        // own review affordance (the <s>old</s>→new strike-through
        // overlay in review mode) and shouldn't double-stamp with ⚡.
        // User promotes individual plies to 'fixed' (green ✓) via
        // _confirmCurrentFix as they step through the walkthrough.
        //
        // EXCEPTION — if this ply was ALREADY confirmed by the user in
        // a prior walkthrough session (pre-entry state.moves has
        // wStatus='fixed' / 'locked' AND the SAN matches the algo's
        // pick), carry the 'fixed' status over. Otherwise switching
        // away and back would silently demote every confirmation to
        // "not yet reviewed" because _applyPickedToState rebuilds
        // paired from scratch.
        var preEntry2 = preMoves[moveIdx] || null;
        var preStatus = null, preSan = null;
        if (preEntry2) {
          if (color === 'w') {
            preStatus = preEntry2.wStatus;
            preSan = preEntry2.white;
          } else {
            preStatus = preEntry2.bStatus;
            preSan = preEntry2.black;
          }
        }
        var preConfirmed = (preStatus === 'fixed' || preStatus === 'locked') &&
                           preSan && preSan === _fixSan(fix);
        var stampStatus = preConfirmed ? preStatus : 'ok';
        if (preConfirmed) _diagPreservedCount++; else _diagOkCount++;

        if (color === 'w') {
          paired[moveIdx].wStatus = stampStatus;
          paired[moveIdx].wAlgoProposed = true;
          if (fix.ocr && fix.ocr !== _fixSan(fix)) paired[moveIdx].wOriginal = fix.ocr;
        } else {
          paired[moveIdx].bStatus = stampStatus;
          paired[moveIdx].bAlgoProposed = true;
          if (fix.ocr && fix.ocr !== _fixSan(fix)) paired[moveIdx].bOriginal = fix.ocr;
        }
      });
    }
    // Re-stamp earlier-cycle fixes that survived into this review. Without
    // this, paired[] has wStatus='ok' for those plies (the new result
    // doesn't list them as fixes since they were already legal SANs), and
    // the 2nd override's harvest from state.moves would find nothing.
    if (state._userOverridePlies) {
      state._userOverridePlies.forEach(function(o) {
        if (o.ply == null) return;
        var mi = Math.floor(o.ply / 2);
        if (!paired[mi]) return;
        if (o.ply % 2 === 0) {
          if (paired[mi].white === o.san && paired[mi].wStatus !== 'fixed') {
            paired[mi].wStatus = 'fixed';
            if (o.ocr && o.ocr !== o.san) paired[mi].wOriginal = o.ocr;
          }
        } else {
          if (paired[mi].black === o.san && paired[mi].bStatus !== 'fixed') {
            paired[mi].bStatus = 'fixed';
            if (o.ocr && o.ocr !== o.san) paired[mi].bOriginal = o.ocr;
          }
        }
      });
    }

    // Carry over 'fixed' statuses from pre-review state.moves for ALL plies
    // whose SAN survived unchanged into the new result — not just those in
    // result.fixes. Without this, switching games away and back re-enters
    // verification with every prior user confirmation silently reset to
    // 'ok' because the algo's new fix list doesn't overlap plies that were
    // already baked in as legal SANs. Scenario (reported): iteration 1
    // confirmed 8 fixes, iteration 2 overrode 30.W and requeued, iteration
    // 3 re-entered with 10 new fixes at earlier plies — the result.fixes
    // loop above found zero overlap, the override re-stamp fired against
    // undefined state._userOverridePlies (not snapshotted across switches),
    // and the 8 confirmations vanished from the move list.
    //
    // Scope: only 'fixed' status carries over (user confirmations + user
    // overrides, both of which mean "user signed off"). Merge-locks ('locked')
    // are intentionally excluded — their visual treatment elsewhere differs
    // from 'ok', so carrying them over would change first-entry rendering.
    //
    // Condition for carry-over:
    //   - pre-review status was 'fixed',
    //   - paired[] currently shows 'ok' (don't clobber override re-stamps
    //     or result.fixes re-stamps above),
    //   - SANs still match (if the new result put a different SAN at this
    //     ply, the pre-review confirmation is no longer compatible — leave
    //     paired's 'ok' so the walkthrough can surface it).
    if (preMoves && preMoves.length) {
      for (var pmi = 0; pmi < paired.length && pmi < preMoves.length; pmi++) {
        var preE = preMoves[pmi];
        if (!preE) continue;

        // (a) Preserve wOriginal/bOriginal from preMoves whenever the text
        // matches, regardless of status. paired[] starts with no
        // wOriginal because it's rebuilt from result.moves; for cells the
        // new result does NOT propose a fix on (because they were already
        // legal in the previous staging's spliced input), the wOriginal
        // metadata would otherwise be wiped. _buildOcrMovesWithOverrides
        // and _buildOcrMovesFromState both use `wOriginal && white !==
        // wOriginal` to decide whether to carry the corrected SAN into a
        // requeue — clearing it forces them to fall back to raw OCR, and
        // the next Greedy run re-proposes the same fix that was already
        // staged. Reported symptom: override at 42.W made the next
        // Greedy run jump back to 38.W with `d4 → f4`, even though
        // 38.W's `f4` was already in state.moves[].white.
        if (preE.white && paired[pmi].white === preE.white &&
            preE.wOriginal && !paired[pmi].wOriginal) {
          paired[pmi].wOriginal = preE.wOriginal;
        }
        if (preE.black && paired[pmi].black === preE.black &&
            preE.bOriginal && !paired[pmi].bOriginal) {
          paired[pmi].bOriginal = preE.bOriginal;
        }

        // (b) Carry over 'fixed' AND 'locked' status (both are user
        // signoffs — 'fixed' for "user accepted a fix", 'locked' for
        // "user pressed keep-as-is on this OCR text"). Without
        // carrying 'locked', entering Greedy Review demotes a kept-as-is
        // ply to 'ok'; wOriginal is preserved by block (a) above; and
        // ui.js's corrInd renders ⚡ ("auto-corrected by quick-fix") on
        // a ply the user explicitly locked, hiding the 🔒 indicator the
        // user expects. Reported case: locked 10.B Nxe4 and 12.W Bxd5
        // shown as ⚡ instead of 🔒 after entering Greedy Review.
        if ((preE.wStatus === 'fixed' || preE.wStatus === 'locked') &&
            paired[pmi].wStatus === 'ok' &&
            preE.white && paired[pmi].white === preE.white) {
          paired[pmi].wStatus = preE.wStatus;
          if (preE.wOriginal) paired[pmi].wOriginal = preE.wOriginal;
          _diagCarriedCount++;
        }
        if ((preE.bStatus === 'fixed' || preE.bStatus === 'locked') &&
            paired[pmi].bStatus === 'ok' &&
            preE.black && paired[pmi].black === preE.black) {
          paired[pmi].bStatus = preE.bStatus;
          if (preE.bOriginal) paired[pmi].bOriginal = preE.bOriginal;
          _diagCarriedCount++;
        }

        // (c) UNCONDITIONAL CONFIRMATION OVERRIDE — user confirmations
        // always win, even when the algorithm's output disagrees. Required
        // when the orchestrator re-runs on stale input (e.g., on browser
        // reopen, batchState.reconstructResults is wiped and Greedy re-
        // runs against raw OCR without seeing the user-confirmed splice
        // that _buildOcrMovesFromState would normally produce). Without
        // this override, paired[i].white = result.moves[i*2] (the
        // algorithm's stale view) silently overwrites the user's
        // confirmed text, dropping the confirmation to 'ok'. Reported
        // symptom: confirmed `4.W = c4` reverted to `e4` after reopen.
        //
        // Distinct from (b) above: (b) only fires when texts already
        // match (the normal case where the algorithm honoured locks);
        // (c) fires when texts disagree (the stale-input case) and
        // forcibly restores the user's text + status. The downstream
        // game state in result.moves may be inconsistent with the
        // confirmed text, but revalidate() will re-derive that and the
        // override-Review-stale-picked guard in selectGame should have
        // already prevented this re-entry; (c) is the second line of
        // defense.
        // Force-restore ONLY when it's safe to do so:
        //   - LOCKED (🔒): inviolable, always restore.
        //   - 'fixed' BUT the current run did NOT propose a fix here
        //     (!wAlgoProposed): the divergence is stale-input noise (the algo
        //     ran on raw OCR and never saw the confirmation), so restore it.
        // When the current run DID propose a fix at a 'fixed' ply (wAlgoProposed
        // — a deliberate change of mind, e.g. 35.B Nd6->Nd8), DON'T revert: the
        // new move stays for review. Reverting it desyncs the board from the
        // downstream fixes the algorithm computed against the new move and turns
        // a later fix illegal (35.B reverted to Nd6 made 38.W Bd6 illegal).
        var _wRestore = preE.wStatus === 'locked' ||
            (preE.wStatus === 'fixed' && !paired[pmi].wAlgoProposed);
        if (_wRestore && preE.white && paired[pmi].white !== preE.white) {
          paired[pmi].white = preE.white;
          paired[pmi].wStatus = preE.wStatus;
          if (preE.wOriginal) paired[pmi].wOriginal = preE.wOriginal;
          if (preE.wAlgoProposed) paired[pmi].wAlgoProposed = true;
          _diagCarriedCount++;
        }
        var _bRestore = preE.bStatus === 'locked' ||
            (preE.bStatus === 'fixed' && !paired[pmi].bAlgoProposed);
        if (_bRestore && preE.black && paired[pmi].black !== preE.black) {
          paired[pmi].black = preE.black;
          paired[pmi].bStatus = preE.bStatus;
          if (preE.bOriginal) paired[pmi].bOriginal = preE.bOriginal;
          if (preE.bAlgoProposed) paired[pmi].bAlgoProposed = true;
          _diagCarriedCount++;
        }
      }
    }

    if (typeof log === 'function' &&
        (_diagPreservedCount > 0 || _diagOkCount > 0 || _diagCarriedCount > 0)) {
      log('  🔎 applying picked solution — ' + _diagPreservedCount +
          ' confirmations preserved, ' + _diagOkCount + ' fixes awaiting review' +
          (_diagCarriedCount > 0 ? ', ' + _diagCarriedCount + ' carried from prior session' : ''));
    }

    state.moves = paired;
    state.sans = result.moves.slice();
    // Sync state.sans with state.moves for any ply where the unconditional
    // confirmation override (or the simple carry-over above) rewrote
    // paired[].white/black to differ from result.moves. Without this, the
    // move list shows the user's confirmed text while the board plays
    // greedy's reconstructed SAN — reported as "the board position and
    // the movelist diverge — that is terrible. The movelist is correct,
    // the board is not." Concrete case: user-confirmed Red8 at 15.B was
    // carried over by the override at line 818-825, but state.sans kept
    // greedy's "Rad8" pick, so the board played Rad8 (rook on a8 → d8)
    // while the movelist still showed Red8 ✓.
    var _sansSynced = 0;
    for (var _ssi = 0; _ssi < paired.length; _ssi++) {
      var _ssm = paired[_ssi];
      if (!_ssm) continue;
      var _wp = _ssi * 2;
      var _bp = _wp + 1;
      if (_ssm.white && state.sans[_wp] !== _ssm.white) {
        state.sans[_wp] = _ssm.white;
        _sansSynced++;
      }
      if (_ssm.black && state.sans[_bp] !== _ssm.black) {
        state.sans[_bp] = _ssm.black;
        _sansSynced++;
      }
    }
    if (_sansSynced > 0 && typeof log === 'function') {
      log('  🔎 synced ' + _sansSynced +
          ' state.sans entr(ies) with carried-over user confirmations');
    }
    state.stuckPly = null;
    state.originStuckPly = null;
    state.stuckInfo = null;
    state.errorArrow = null;
    state.fixArrow = null;
    state.ocrArrow = null;
  }

  // =========================================================================
  // Fix ply / SAN extraction (duplicate of batch-triage.js helpers, inlined
  // so verification-ui.js does not hard-depend on BatchTriage)
  // =========================================================================

  function _fixPly(fix) {
    if (!fix) return null;
    if (typeof fix.ply === 'number') return fix.ply;
    if (typeof fix.ply_idx === 'number') return fix.ply_idx;
    if (typeof fix.ply_str === 'string') {
      var m = fix.ply_str.match(/^(\d+)\.([WB])$/i);
      if (m) return (parseInt(m[1]) - 1) * 2 + (m[2].toUpperCase() === 'W' ? 0 : 1);
    }
    return null;
  }

  function _fixSan(fix) {
    if (!fix) return null;
    return fix.san || fix.fix_san || fix.new_san || null;
  }

  // Shallow-clone each move entry; arrays inside (wAlts etc.) are reused,
  // which is fine because _requeueAndExit doesn't mutate them.
  function _cloneMoves(moves) {
    if (!moves) return [];
    return moves.map(function(m) { return Object.assign({}, m); });
  }

  // Revert algo-proposed cells the user did NOT confirm back to their
  // pre-review (OCR baseline) text/conf/alts, using the existing
  // v._preReviewMoves snapshot. Cells with wStatus='fixed' or 'locked'
  // are user signoffs and left alone. Idempotent: a no-op on fresh entry
  // (no wAlgoProposed cells exist) and on already-clean state.
  //
  // Called from BOTH exit (clear suggestions on the way out) AND enter
  // (scrub before re-snapshotting _preReviewMoves on a method-switch
  // re-entry — Review Beam → Review Greedy with no exit between would
  // otherwise bake Beam's reconstruction into the snapshot, and a later
  // _requeueAndExit revert would silently restore Beam's downstream
  // moves as if the user had confirmed them).
  function _revertUnconfirmedAlgoProposed() {
    var v = _ensureState();
    if (!v || typeof state === 'undefined' || !Array.isArray(state.moves)) {
      return 0;
    }
    var pre = v._preReviewMoves || [];
    var revertedCount = 0;
    for (var i = 0; i < state.moves.length; i++) {
      var mv = state.moves[i];
      if (!mv) continue;
      var preEntry = pre[i] || null;
      if (mv.wAlgoProposed && mv.wStatus !== 'fixed' && mv.wStatus !== 'locked') {
        if (preEntry) {
          mv.white = preEntry.white || '';
          if (typeof preEntry.wConf === 'number') mv.wConf = preEntry.wConf;
          if (preEntry.wAlts) mv.wAlts = preEntry.wAlts;
          if (preEntry.wLenientAlts) mv.wLenientAlts = preEntry.wLenientAlts;
        }
        mv.wOriginal = null;
        mv.wAlgoProposed = false;
        mv.wStatus = 'pending';
        revertedCount++;
      }
      if (mv.bAlgoProposed && mv.bStatus !== 'fixed' && mv.bStatus !== 'locked') {
        if (preEntry) {
          mv.black = preEntry.black || '';
          if (typeof preEntry.bConf === 'number') mv.bConf = preEntry.bConf;
          if (preEntry.bAlts) mv.bAlts = preEntry.bAlts;
          if (preEntry.bLenientAlts) mv.bLenientAlts = preEntry.bLenientAlts;
        }
        mv.bOriginal = null;
        mv.bAlgoProposed = false;
        mv.bStatus = 'pending';
        revertedCount++;
      }
    }
    return revertedCount;
  }

  function _colorFor(i) {
    return FIX_COLORS[i % FIX_COLORS.length];
  }

  // =========================================================================
  // Panel swap — scoresheet viewer + fix review area in place of #panel-fixes
  // =========================================================================

  // Snapshots of the specific children we rewrite, so exit can restore them
  // without touching the surrounding DOM (apply button state, legal-moves
  // details, source-preview, etc.).
  var _panelSnapshots = null;

  function _swapPanelFixesToVerificationView() {
    var panel = document.getElementById('panel-fixes');
    if (!panel) return;

    // Snapshot the children we rewrite (first time only).
    if (_panelSnapshots === null) {
      _panelSnapshots = {
        titleHtml: _getHtml('fix-panel-title'),
        stuckHtml: _getHtml('stuck-info'),
        fixListHtml: _getHtml('fix-list'),
        applyText: _getText('btn-apply'),
        applyClassName: _getClass('btn-apply'),
        applyDisabled: _getDisabled('btn-apply')
      };
    }

    // Panel title → "Review — <method> | ◀ N/M at X.W ▶ | Exit | Confirm & Save"
    // (counter lives here so stuck-info can hold the interactive-style stuck line).
    _renderReviewHeader();

    // Repurpose #btn-apply as the Confirm button for the current fix. Enable it
    // so the user can confirm with keyboard (Enter) just like interactive mode.
    // Blue to match the "Review" button in the algorithm panels and the
    // per-fix styling selectFix applies — see fixes.js isReview branch.
    // Leave the label empty; _focusFix → selectFix fills it in synchronously
    // with the fix-specific "✓ Confirm: N.W ocr → san" text. Presetting
    // "✓ Confirm & next" here caused a brief flash of that placeholder text
    // between entering review and selectFix firing (user-reported).
    var applyBtn = document.getElementById('btn-apply');
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-blue-700 hover:bg-blue-600 text-white';
      applyBtn.textContent = '';
      applyBtn.onclick = _onConfirmClick;
    }
  }

  function _getHtml(id) { var el = document.getElementById(id); return el ? el.innerHTML : ''; }
  function _getText(id) { var el = document.getElementById(id); return el ? el.textContent : ''; }
  function _getClass(id) { var el = document.getElementById(id); return el ? el.className : ''; }
  function _getDisabled(id) { var el = document.getElementById(id); return el ? !!el.disabled : false; }

  function _restorePanelFixes() {
    if (_panelSnapshots === null) return;
    var s = _panelSnapshots;
    var title = document.getElementById('fix-panel-title');
    if (title) title.innerHTML = s.titleHtml;
    var stuck = document.getElementById('stuck-info');
    if (stuck) stuck.innerHTML = s.stuckHtml;
    var fixList = document.getElementById('fix-list');
    if (fixList) fixList.innerHTML = s.fixListHtml;
    var applyBtn = document.getElementById('btn-apply');
    if (applyBtn) {
      applyBtn.textContent = s.applyText;
      applyBtn.className = s.applyClassName;
      applyBtn.disabled = s.applyDisabled;
      // Re-wire the interactive-mode applyFix handler.
      if (typeof applyFix === 'function') applyBtn.onclick = applyFix;
    }
    _panelSnapshots = null;
  }

  // Header lives in #fix-panel-title: review label + counter + nav + Exit +
  // Confirm & Save. stuck-info is left for the interactive-style stuck line
  // (set by _focusFix).
  function _renderReviewHeader() {
    var v = _ensureState();
    var title = document.getElementById('fix-panel-title');
    if (!title) return;

    var counter = '';
    if (v.fixes && v.fixes.length > 0) {
      var fix = v.fixes[v.currentFixIndex];
      var p = _fixPly(fix);
      // If the algorithm applied this fix at a different position than where
      // ply-order puts it, show the original step number — lets the user spot
      // backtracks (e.g. "step 13 of 15" showing up at display position 2/15
      // means greedy backtracked to this early ply late in its search).
      var algoStepBadge = '';
      if (typeof fix._algoStepIdx === 'number' &&
          fix._algoStepIdx !== v.currentFixIndex) {
        algoStepBadge = '<span class="text-[10px] text-gray-500 ml-1" ' +
          'title="This fix landed at step ' + (fix._algoStepIdx + 1) +
          ' in the algorithm\'s actual search order. Review shows fixes in ' +
          'ply order so you can walk the game chronologically; the algorithm ' +
          'may have applied them non-monotonically via backtracking.">' +
          '\u2190 ' + _labelForMethod(v.method) + ' step ' + (fix._algoStepIdx + 1) + '</span>';
      }
      counter =
        '<button id="btn-verify-prev" class="px-1.5 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-200 text-[11px]" title="Previous fix">&#9664;</button>' +
        '<span class="text-[11px] text-gray-300 mx-1">' +
          '<span class="text-gray-100 font-semibold">' + (v.currentFixIndex + 1) + '/' + v.fixes.length + '</span>' +
          ' at <span class="text-yellow-300 font-semibold">' + _plyLabel(p) + '</span>' +
          algoStepBadge +
        '</span>' +
        '<button id="btn-verify-next" class="px-1.5 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-200 text-[11px]" title="Next fix">&#9654;</button>';
    }

    // Per-method color matches the algorithm panel labels so the connection
    // between the walkthrough and the panel that produced it is visible at
    // a glance: greedy=green, beam=blue, dijkstra=purple.
    var _methodKey = String(v.method || '').toLowerCase();
    var _methodColor =
      _methodKey === 'greedy'   ? 'text-green-400' :
      _methodKey === 'beam'     ? 'text-sky-400'   :
      _methodKey === 'dijkstra' ? 'text-purple-400' :
                                  'text-sky-300';

    // Skip-and-keep button: one-click way to reject the entire Greedy /
    // Beam / Dijkstra proposal chain AND accept the original stuck move
    // as-is. Equivalent to Exit + click "Keep <stuck-move> \u2014 accept as-is"
    // in the live Fix Suggestions panel, but one click instead of two.
    // Useful when the user decides upfront that the algorithm's whole
    // chain is wrong (e.g. the "bad trade" at the stuck point is a real
    // tactical sacrifice they want to keep).
    //
    // Gate on stuck reason: keep-as-is only makes sense when the stuck
    // move is legal but flagged (bad_trade / persistent_absurdity /
    // piece_hanging \u2014 the user may be intentionally accepting a sac;
    // 'ambiguous' \u2014 a forced-stop ply whose displayed move is the
    // higher-confidence real reading the user may want to lock).
    // When the stuck reason is 'illegal' the move cannot be played at
    // all, so "keep" is nonsensical. Mirrors the same reason gate
    // used by createKeepAsIsButton callers in fixes.js (lines 260, 385,
    // 1902).
    var skipBtn = '';
    var saved = v._savedState;
    var savedReason = (saved && saved.stuckInfo) ? saved.stuckInfo.reason : null;
    var keepEligible = (savedReason === 'bad_trade' ||
                        savedReason === 'persistent_absurdity' ||
                        savedReason === 'piece_hanging' ||
                        savedReason === 'ambiguous');
    if (keepEligible && typeof saved.stuckPly === 'number' && saved.stuckInfo.move) {
      var stuckLbl = saved.stuckInfo.num + '.' + saved.stuckInfo.color.toUpperCase();
      // Show the canonical SAN's check/mate marker and capture "x" (OCR
      // "Rf4" for an actual "Rf4+", "Kh5" for an actual "Kxh5") so this chip
      // matches the "Keep Rf4+"/"Keep Kxh5" suggestion button. Same
      // body-unchanged guard as createKeepAsIsButton.
      var skipMove = saved.stuckInfo.move;
      try {
        if (typeof Chess === 'function' && state.sans && state.sans.length >= saved.stuckPly) {
          var _sc = new Chess();
          for (var _si = 0; _si < saved.stuckPly; _si++) { _sc.move(state.sans[_si]); }
          var _smo = _sc.move(skipMove);
          if (_smo && _smo.san && _smo.san.replace(/[+#x]/g, '') === skipMove.replace(/[+#x]/g, '')) {
            skipMove = _smo.san;
          }
        }
      } catch (_e) {}
      skipBtn = '<button id="btn-verify-skip-keep" class="ml-2 text-xs px-2 py-0.5 bg-yellow-700 hover:bg-yellow-600 rounded text-white" title="Reject this proposal chain and accept the stuck move as-is \u2014 equivalent to Exit + Keep in the live panel">\u23ed Skip \u2014 keep ' +
                _escapeHtml(stuckLbl) + ' ' + _escapeHtml(skipMove) +
                '</button>';
    }

    title.innerHTML =
      '<span class="text-blue-400">Review</span> \u2014 ' +
      '<span class="' + _methodColor + '">' + _escapeHtml(_labelForMethod(v.method)) + '</span>' +
      '<span class="inline-flex items-center gap-1 ml-2">' + counter + '</span>' +
      '<button id="btn-verify-exit" class="ml-2 text-xs px-2 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-200" title="Exit verification">Exit</button>' +
      skipBtn +
      '<button id="btn-verify-confirm-all" class="ml-2 text-xs px-2 py-0.5 bg-green-700 hover:bg-green-600 rounded text-white" title="Save PGN">Save PGN</button>';

    var prev = document.getElementById('btn-verify-prev');
    var next = document.getElementById('btn-verify-next');
    var exitBtn = document.getElementById('btn-verify-exit');
    var skipBtnEl = document.getElementById('btn-verify-skip-keep');
    var saveBtn = document.getElementById('btn-verify-confirm-all');
    if (prev) prev.onclick = function(){ _navFix(-1); };
    if (next) next.onclick = function(){ _navFix(+1); };
    if (exitBtn) exitBtn.onclick = function() {
      // Plain Exit click: clear the search panels and requeue this game so
      // Greedy/Beam/Dijkstra re-run from the post-revert baseline (with any
      // walkthrough-confirmed fixes locked in). Other exit paths
      // (_requeueAndExit, _finishReview, _confirmAndSave) handle their own
      // requeue semantics and call exitVerificationMode() without this flag.
      exitVerificationMode({ clearAndRequeue: true });
    };
    if (skipBtnEl) skipBtnEl.onclick = _onSkipKeepStuck;
    if (saveBtn) saveBtn.onclick = _confirmAndSave;
    // The "Next ready" nav is a persistent element (#batch-next-ready-nav)
    // owned by batch-game-list.js so it survives both this review header and
    // the interactive title. Refresh it here so entering review reflects the
    // current ready-count immediately.
    if (window.BatchGameList &&
        typeof window.BatchGameList.renderNextReadyNav === 'function') {
      try { window.BatchGameList.renderNextReadyNav(); } catch (e) {}
    }
  }

  // Handler for the new "Skip \u2014 keep <stuck-move> as-is" button. Mirrors
  // the live panel's createKeepAsIsButton flow: exit review, then synthesize
  // a keep_as_is fix at state.stuckPly and route it through the standard
  // selectFix \u2192 applyFix path so the ply gets locked + the game revalidates.
  async function _onSkipKeepStuck() {
    var v = _ensureState();
    if (!v || !v.active) return;

    // Capture the saved stuck info BEFORE exiting, in case the exit path
    // mutates it.
    var saved = v._savedState || {};
    var stuckPly = (typeof saved.stuckPly === 'number') ? saved.stuckPly : null;
    var stuckInfo = saved.stuckInfo || null;
    if (stuckPly === null || !stuckInfo) {
      // No stuck info to lock \u2014 just exit cleanly.
      exitVerificationMode();
      return;
    }

    // Exit review. This restores state, reverts unconfirmed algo cells,
    // and triggers revalidate(). exitVerificationMode returns the
    // revalidate Promise \u2014 wait for it so applyFix doesn't race against
    // an in-flight revalidate that could clobber state.stuckPly.
    var exitPromise = exitVerificationMode();
    if (exitPromise && typeof exitPromise.then === 'function') {
      try { await exitPromise; } catch (_e) {}
    }

    // If revalidate decided the game is now valid (e.g., user confirmed
    // some fixes inside Review that resolved everything), there's nothing
    // left to keep \u2014 return.
    if (state.stuckPly === null || state.stuckPly === undefined) return;

    var lbl = stuckInfo.num + '.' + stuckInfo.color.toUpperCase();
    var move = stuckInfo.move;
    var ply = state.stuckPly;

    // Compute from/to squares so the kept-move arrow lights up correctly,
    // and recover the canonical SAN's check/mate marker and capture "x"
    // (OCR "Rf4" for an actual "Rf4+", "Kh5" for an actual "Kxh5"),
    // mirroring createKeepAsIsButton in fixes.js. Only adopt the canonical
    // SAN when the move body is unchanged (strip +/#/x) so the strict-disambig
    // guard still catches a different resolved disambiguator.
    var fromSq = null, toSq = null;
    var keepSan = move;
    try {
      if (typeof Chess === 'function' && state.sans && state.sans.length >= ply) {
        var tempChess = new Chess();
        for (var j = 0; j < ply; j++) { tempChess.move(state.sans[j]); }
        var moveObj = tempChess.move(move);
        if (moveObj) {
          fromSq = moveObj.from; toSq = moveObj.to;
          if (moveObj.san && moveObj.san.replace(/[+#x]/g, '') === move.replace(/[+#x]/g, '')) {
            keepSan = moveObj.san;
          }
        }
      }
    } catch (_e) {}

    var keepFix = {
      ocr: move,
      san: keepSan,
      ply: ply,
      ply_str: lbl,
      similarity: 100,
      keep_as_is: true,
      num_changes: 0,
      source: 'keep_as_is',
      from_square: fromSq,
      to_square: toSq
    };

    if (typeof selectFix === 'function') selectFix(keepFix, null);
    if (typeof applyFix === 'function') applyFix();
  }

  // Simulate the interactive "stuck at ply P" state so renderQuickFixes /
  // mergeBacktrackFixes paint the fix-list IDENTICALLY to interactive mode.
  // Data source differs: backtrack fixes come from greedy's cached
  // fix.all_candidates instead of a live find_deep_backtrack_fixes call.
  function _setupStuckStateForFix(fix, p) {
    if (p == null || typeof state === 'undefined') return;
    var v = _ensureState();
    var num = Math.floor(p / 2) + 1;
    var color = (p % 2 === 0) ? 'w' : 'b';
    var ocrText = fix.ocr || _fixSan(fix) || '';
    state.stuckPly = p;
    // Origin stuck ply for backtrack-aware highlighting in the move list.
    // When the focused fix is a backtrack proposal, set this to the actual
    // stuck ply so navigation.js::highlightCurrentMove can paint that cell
    // red while leaving the focus ply (state.stuckPly) yellow. For
    // non-backtrack fixes this stays null so no extra red outline appears.
    state.originStuckPly = (fix && fix.is_backtrack
                            && typeof fix.origin_stuck_ply === 'number'
                            && fix.origin_stuck_ply !== p)
      ? fix.origin_stuck_ply : null;
    state.legalMoves = _legalMovesAtPly(p);

    // Determine the stop reason for the headline. Prefer the worker's
    // play_until_absurd_or_stuck verdict (carried through in
    // picked.result.stop_reason — 'illegal'/'bad_trade'/'piece_hanging'/
    // 'persistent_absurdity') because it's the actual reason the algorithm
    // stopped; chess.js sloppy parsing here is a fallback that can be wrong
    // when the OCR text is unparseable in strict mode but happens to match
    // some legal move under sloppy disambiguation rules. Reported case: OCR
    // "Red8" (no rook on the e-file) is illegal under Python strict, but
    // chess.js sloppy resolves it to Rad8 and labelled the cell "bad
    // trade?" instead of "is illegal" — confusing because there is no bad
    // trade, the move just doesn't parse.
    // Determine the stuck reason. The principle: the user's mental model
    // is the OCR sequence with all currently-staged corrections applied,
    // EXCEPT they imagine rejecting the focused backtrack proposal —
    // does the stuck-ply OCR move become illegal in that view?
    //
    // Earlier we ran two separate paths: a worker-reason-respecting
    // hybrid replay (98a131b) and a chess.js-sloppy fallback that only
    // tested the focus ply (legacy). When the worker didn't supply
    // stop_reason (which Greedy does for some stops but not all), the
    // fallback handled backtracks wrong: it tested a6 at 52.W (legal —
    // a6 is just a pawn push) and labelled it "bad_trade", regardless
    // of whether the actual stuck point at 53.W was illegal. The
    // override never ran because the legacy branch already produced
    // a label. Reported recurrence: 52.W a6 → g6 backtrack with no
    // worker reason kept showing "53.W Rg5 — bad trade?" forever.
    //
    // Unify: always run the hybrid replay when feasible. If it returns
    // a definite illegal verdict, use it. Otherwise prefer the worker's
    // reason (if any), else default to 'bad_trade'/'illegal' based on
    // the legacy single-ply check.
    var _isBacktrackCheck = !!(fix && fix.is_backtrack &&
                                typeof fix.origin_stuck_ply === 'number' &&
                                fix.origin_stuck_ply !== p);
    var _stuckPlyForCheck = _isBacktrackCheck ? fix.origin_stuck_ply : p;
    var _stuckOcrText = ocrText;
    if (_stuckPlyForCheck !== p && Array.isArray(state.moves)) {
      var _smi2 = Math.floor(_stuckPlyForCheck / 2);
      var _sm2 = state.moves[_smi2];
      if (_sm2) {
        _stuckOcrText = (_stuckPlyForCheck % 2 === 0)
          ? (_sm2.wOriginal || _sm2.white)
          : (_sm2.bOriginal || _sm2.black);
      }
    }
    var _replayOk = false, _testedIllegal = null;
    var _haltAt = null, _haltSan = null;
    if (_stuckOcrText && typeof Chess === 'function' &&
        Array.isArray(state.moves)) {
      try {
        var _ocrChess = new Chess();
        _replayOk = true;
        for (var _k = 0; _k < _stuckPlyForCheck && _replayOk; _k++) {
          var _kmi = Math.floor(_k / 2);
          var _km = state.moves[_kmi];
          if (!_km) { _replayOk = false; _haltAt = _k; _haltSan = '<missing-move-entry>'; break; }
          // At the focus fix ply (backtrack only), simulate "user
          // rejects the backtrack" by playing the focus's OCR original
          // (ocrText = fix.ocr). Everywhere else, use the current
          // (Greedy-resolved or user-confirmed) SAN so the replay can
          // reach the stuck ply even when earlier plies had OCR errors
          // that the algorithm or user already fixed.
          var _kSan;
          if (_isBacktrackCheck && _k === p) {
            _kSan = ocrText;
          } else {
            _kSan = (_k % 2 === 0) ? _km.white : _km.black;
          }
          if (!_kSan) { _replayOk = false; _haltAt = _k; _haltSan = '<empty-san>'; break; }
          if (!_ocrChess.move(_kSan, { sloppy: true })) {
            _replayOk = false;
            _haltAt = _k;
            _haltSan = _kSan;
            break;
          }
        }
        if (_replayOk) {
          var _ocrMoveObj = _ocrChess.move(_stuckOcrText, { sloppy: true });
          if (!_ocrMoveObj) {
            _testedIllegal = true;
          } else {
            // chess.js sloppy mode silently accepts moves whose +/#
            // markers don't match the actual position (e.g., "h6+" when
            // h6 doesn't give check). The OCR-as-written claims a check
            // the position can't deliver — treat that as illegal so the
            // headline reads "is illegal" instead of "bad trade?". Mate
            // implies check, so a "+" written on an actual mate still
            // parses fine (under-marked, but the move is real).
            var _claimsMate = /#/.test(_stuckOcrText);
            var _claimsCheck = !_claimsMate && /\+/.test(_stuckOcrText);
            var _actualCheck = (typeof _ocrChess.in_check === 'function') && _ocrChess.in_check();
            var _actualMate = (typeof _ocrChess.in_checkmate === 'function') && _ocrChess.in_checkmate();
            if (_claimsMate && !_actualMate) {
              _testedIllegal = true;
            } else if (_claimsCheck && !_actualCheck) {
              _testedIllegal = true;
            } else {
              _testedIllegal = false;
            }
          }
        }
      } catch (_e2) {
        console.warn('[STUCK-CHECK] threw:', _e2);
      }
    }

    // Prefer the PER-FIX stop reason (stamped by greedy when this fix was
    // found) over the run-global result.stop_reason. The global reason
    // describes the run's FINAL stuck point, which for a backtrack proposal
    // is usually a different, later ply than this fix's origin_stuck_ply —
    // pairing them produced nonsense like "23.B Kf7 — bad trade?" (a king
    // move can never be a bad trade, and the game wasn't even stuck there).
    // Falls back to the global reason for algorithms that don't stamp a
    // per-fix reason (beam/dijkstra) or for older cached results.
    var _fixReason = (fix && typeof fix.origin_stop_reason === 'string'
                      && fix.origin_stop_reason)
      ? fix.origin_stop_reason : null;
    var _workerReason = _fixReason ||
                        ((v.picked && v.picked.result &&
                          typeof v.picked.result.stop_reason === 'string')
                           ? v.picked.result.stop_reason : null);
    var _stuckReason;
    // True when the JS replay demoted 'illegal' → 'persistent_absurdity'
    // because the move IS legal in the user-confirmed sequence. Distinct from
    // the worker reporting 'persistent_absurdity' directly (a real absurdity
    // at that ply). Used to choose a clearer headline label below.
    var _isDowngraded = false;
    if (_testedIllegal === true) {
      _stuckReason = 'illegal';
    } else if (_workerReason) {
      // The hybrid replay, when it reached a verdict, is authoritative on
      // legality for the CURRENT sequence. If it played the origin move
      // successfully (_testedIllegal === false), that move is legal here, so
      // a stale 'illegal' reason — carried from the algorithm's own earlier
      // reality where the position differed — must not paint a red "is
      // illegal". Downgrade it to a legal-but-rejected warning. (Other reason
      // values are not contradicted by a legal verdict, so pass through.)
      if (_testedIllegal === false && _workerReason === 'illegal') {
        _stuckReason = 'persistent_absurdity';
        _isDowngraded = true;
      } else {
        _stuckReason = _workerReason;
      }
    } else {
      // Legacy fallback: chess.js sloppy parse of focus OCR against
      // user-confirmed sequence. Only fires when our hybrid replay
      // couldn't reach a verdict AND the worker didn't supply a
      // reason — covers the original-validation-stuck case where
      // state.moves[].white past the stuck ply is empty.
      var _ocrIsLegal = false;
      if (ocrText && typeof Chess === 'function' && state.sans) {
        try {
          var _c = new Chess();
          for (var _j = 0; _j < p; _j++) { _c.move(state.sans[_j]); }
          var _cMoveObj = _c.move(ocrText, { sloppy: true });
          if (_cMoveObj) {
            // Same check-marker sanity test as the hybrid replay above:
            // chess.js sloppy strips bogus +/#, so verify markers match.
            var _cClaimsMate = /#/.test(ocrText);
            var _cClaimsCheck = !_cClaimsMate && /\+/.test(ocrText);
            var _cActualCheck = (typeof _c.in_check === 'function') && _c.in_check();
            var _cActualMate = (typeof _c.in_checkmate === 'function') && _c.in_checkmate();
            if (_cClaimsMate && !_cActualMate) {
              _ocrIsLegal = false;
            } else if (_cClaimsCheck && !_cActualCheck) {
              _ocrIsLegal = false;
            } else {
              _ocrIsLegal = true;
            }
          }
        } catch (_e) { /* stays false */ }
      }
      _stuckReason = _ocrIsLegal ? 'bad_trade' : 'illegal';
    }
    console.log('[STUCK-CHECK]', {
      focusPly: p,
      stuckPlyForCheck: _stuckPlyForCheck,
      stuckOcrText: _stuckOcrText,
      focusOcrText: ocrText,
      workerReason: _workerReason,
      fixReason: _fixReason,
      globalReason: (v.picked && v.picked.result) ? v.picked.result.stop_reason : null,
      isBacktrack: _isBacktrackCheck,
      originStuckPly: fix && fix.origin_stuck_ply,
      replayOk: _replayOk,
      haltAt: _haltAt,
      haltSan: _haltSan,
      testedIllegal: _testedIllegal,
      finalReason: _stuckReason
    });
    // Substantiating explanation for a 'bad_trade' reason, plumbed from the
    // worker (full_game_search stamps origin_stop_explanation only when the
    // SEE detector genuinely fired). Used below to decide whether the headline
    // may assert "bad trade?" or must fall back to a neutral label. Stays null
    // for the unverifiable fallback default, so an unbacked 'bad_trade' never
    // claims a material verdict the user can't see on the board.
    var _stopExplanation = (fix && typeof fix.origin_stop_explanation === 'string'
                            && fix.origin_stop_explanation)
      ? fix.origin_stop_explanation : null;
    // Surface the KEEP candidate's score so the "Keep <move>" button can show
    // the SAME score breakdown as every other candidate. The keep candidate is
    // the at-ply candidate whose SAN equals the move the keep button keeps
    // (ocrText); it rides in fix.all_candidates carrying the fair-rescored
    // unified_score + score_components (a forced-stop is a LEGAL ply, so its own
    // reading IS scored by find_fixes). Without this the keep button's synthetic
    // fix has no score and the user sees no number for the kept move. Scoped to
    // candidate lookup (any reason); harmless when no match.
    var _keepScore = null, _keepComponents = null, _keepCharSim = null, _keepOcrConf = null;
    if (fix && Array.isArray(fix.all_candidates)) {
      var _keepNorm = (ocrText || '').replace(/[+#]$/, '');
      for (var _kc = 0; _kc < fix.all_candidates.length; _kc++) {
        var _cand = fix.all_candidates[_kc];
        if (!_cand) continue;
        var _candPly = (typeof _cand.ply === 'number') ? _cand.ply : p;
        var _candSan = (_cand.san || _cand.move || '').replace(/[+#]$/, '');
        if (_candPly === p && _candSan === _keepNorm) {
          if (typeof _cand.unified_score === 'number') _keepScore = _cand.unified_score;
          if (_cand.score_components) _keepComponents = _cand.score_components;
          if (typeof _cand.char_sim === 'number') _keepCharSim = _cand.char_sim;
          if (typeof _cand.ocr_conf === 'number') _keepOcrConf = _cand.ocr_conf;
          break;
        }
      }
    }
    state.stuckInfo = {
      num: num,
      color: color,
      move: ocrText,
      reason: _stuckReason,
      explanation: _stopExplanation,
      keepScore: _keepScore,
      keepComponents: _keepComponents,
      keepCharSim: _keepCharSim,
      keepOcrConf: _keepOcrConf
    };
    // Clear prior arrows, then re-derive the red OCR-error arrow by
    // attempting to parse the original OCR text at this position.
    state.errorArrow = null;
    state.savedErrorArrow = null;
    state.fixArrow = null;
    state.ocrArrow = null;
    state.selectedFix = null;
    state.pendingConfirmation = null;
    state.missingMoveCandidates = [];
    var sq = _inferMoveSquares(p, ocrText);
    if (sq && sq.from && sq.to) {
      state.errorArrow = { from: sq.from, to: sq.to };
      state.savedErrorArrow = { from: sq.from, to: sq.to };
    }

    // Detect whether the focused fix is a backtrack proposal (algorithm
    // got stuck downstream of the fix ply). Used both for the pending-
    // confirmation guard immediately below and the headline construction
    // further down.
    var _isBacktrack = !!(fix && fix.is_backtrack
                          && typeof fix.origin_stuck_ply === 'number'
                          && fix.origin_stuck_ply !== p);

    // Reconstruct the similarity "Quick Fix" pendingConfirmation that
    // interactive validation.js populates. It renders as the yellow
    // "Quick Fix (similarity, N changes)" section in fixes.js renderFixes.
    // Only shown when the algorithm's fix is at the same ply as the stuck
    // point AND the OCR differs from the SAN (i.e. a genuine replacement).
    //
    // Suppressed in backtrack scenarios: the candidate ply (focus, yellow)
    // differs from the actual stuck ply (red arrow), and the Confirm
    // button at the top of the walkthrough already surfaces the same fix.
    // Rendering the same SAN swap as a "Quick Fix (similarity, 1 changes)"
    // entry in the list duplicates that Confirm button AND surfaces the
    // wrong ply (candidate) instead of the red-arrow ply, which conflicts
    // with the convention OCR Quick Fixes already follows.
    var fixSan = _fixSan(fix);
    var fixPly = _fixPly(fix);
    if (fixSan && ocrText && fixSan !== ocrText && fixPly === p && !_isBacktrack) {
      state.pendingConfirmation = {
        ply: p,
        original: ocrText,
        suggested: fixSan,
        num_changes: _editDistance(ocrText, fixSan)
      };
    }

    // Write the interactive-style stuck line into #stuck-info so review
    // matches what the user sees when stuck in normal flow.
    var lbl = num + '.' + color.toUpperCase();
    var stuckEl = document.getElementById('stuck-info');
    if (stuckEl) {
      // Headline varies by reason to mirror validation.js::fetchFixes —
      // red-X "is illegal" for genuinely illegal moves, yellow warning
      // "bad trade?" for legal-but-rejected (absurdity / piece-hanging /
      // bad trade). Sub-types of legal-but-rejected aren’t recoverable
      // cheaply here so default to 'bad_trade'.
      // Backtracking metadata from the fix dict. When the algorithm got
      // stuck at one ply but proposes a repair at an earlier ply, the
      // headline must reflect THAT distinction so the user understands
      // the fix is here because of a downstream stuck point, not because
      // this move itself is broken. _isBacktrack is computed earlier
      // (above the pendingConfirmation guard) and reused here.
      var _stuckPly = _isBacktrack ? fix.origin_stuck_ply : p;
      var _stuckNum = Math.floor(_stuckPly / 2) + 1;
      var _stuckColor = (_stuckPly % 2 === 0) ? 'W' : 'B';
      var _stuckLbl = _stuckNum + '.' + _stuckColor;
      // Read OCR text at the origin stuck ply from state.moves. Prefer the
      // ORIGINAL OCR (wOriginal/bOriginal) over the current cell value: in a
      // backtrack scenario the algorithm has already overlaid its PROPOSED
      // replacement onto the stuck cell (e.g. O-O → Qd8), but the legality
      // verdict above (_stuckOcrText, line ~1357) was computed against the OCR
      // original. Showing the proposal here produced the nonsensical headline
      // "16.B Qd8 is illegal" — Qd8 is Greedy's own (illegal) guess, while the
      // move that actually got stuck is the OCR O-O. Mirror the verdict source
      // so the headline names the real culprit.
      var _stuckMoveText = ocrText || '?';
      if (_isBacktrack && typeof state !== 'undefined' && Array.isArray(state.moves)) {
        var _smi = _stuckNum - 1;
        if (_smi >= 0 && _smi < state.moves.length) {
          var _sm = state.moves[_smi];
          if (_sm) {
            _stuckMoveText = (_stuckColor === 'W'
              ? (_sm.wOriginal || _sm.white)
              : (_sm.bOriginal || _sm.black)) || '?';
          }
        }
      }

      // Stuck label reflects the ORIGIN stuck ply (where the algorithm
      // actually failed), even when the proposed fix lives at an earlier
      // backtrack ply.
      // 'illegal' \u2192 red \u274C. Anything else (bad_trade / piece_hanging /
      // persistent_absurdity) is legal-but-rejected \u2192 yellow \u26A0. The
      // sub-text varies a touch so the user knows which flavour fired
      // when the worker plumbed it through.
      var _headline;
      if (_stuckReason === 'illegal') {
        _headline = '<span class="text-red-400">\u274C ' + _stuckLbl + ' ' +
                    _escapeHtml(_stuckMoveText) + ' is illegal</span>';
      } else {
        // "bad trade?" is only honest when a real SEE verdict backs it
        // (_stopExplanation, plumbed from the worker). Without that, the
        // move is merely legal-but-rejected \u2014 the algorithm got stuck
        // downstream and proposes a change here \u2014 so assert nothing about
        // chess quality and use a neutral, accurate label instead. This is
        // the fix for the "24.B Rd8 \u2014 bad trade?" false positive: Rd8 is a
        // fair rook trade (Qc7 guards d8), but the catch-all default branded
        // every legal-but-rejected move a "bad trade".
        var _neutralLabel = _labelForMethod(v.method) + ' suggests a fix here';
        // When the worker plumbed a piece_hanging explanation (e.g. "Queen on
        // c7 hanging"), show it inline instead of the bare "piece hanging?" so
        // the user can see WHICH piece is en prise — easy to overlook on a
        // crowded board. Falls back to the bare label for beam/dijkstra or
        // older cached results that didn't stamp origin_stop_explanation.
        var _subLabel = (_stuckReason === 'ambiguous') ? 'sheets disagree / uncertain — choose'
                      : (_stuckReason === 'piece_hanging' && _stopExplanation) ? _stopExplanation
                      : (_stuckReason === 'piece_hanging') ? 'piece hanging?'
                      : (_stuckReason === 'persistent_absurdity' && _isDowngraded && _isBacktrack) ? 'later move illegal?'
                      : (_stuckReason === 'persistent_absurdity' && _isDowngraded) ? 'position mismatch?'
                      : (_stuckReason === 'persistent_absurdity') ? 'absurd position?'
                      : (_stuckReason === 'bad_trade' && _stopExplanation) ? 'bad trade?'
                      : _neutralLabel;
        // Surface the SEE explanation on a second line only when we kept the
        // "bad trade?" label \u2014 it's what makes the verdict checkable.
        var _explLine = (_stuckReason === 'bad_trade' && _stopExplanation)
          ? '<div class="text-[11px] text-gray-400 mt-0.5">' +
              _escapeHtml(_stopExplanation) + '</div>'
          : '';
        _headline = '<span class="text-yellow-400">\u26A0\uFE0F ' + _stuckLbl + ' ' +
                    _escapeHtml(_stuckMoveText) +
                    '</span> <span class="text-yellow-300/70 text-xs">\u2014 ' +
                    _subLabel + '</span>' + _explLine;
      }

      // Backtrack sub-line: stuck-ply (above) is where the algorithm
      // failed; the fix lives at an EARLIER ply (yellow, matching the
      // fix-target convention used throughout the UI).
      var _backtrackLine = '';
      if (_isBacktrack) {
        var _fixSanText = (typeof fix.san === 'string') ? fix.san : '';
        var _fixOcrText = (typeof fix.ocr === 'string' && fix.ocr) ? fix.ocr : ocrText;
        _backtrackLine =
          '<div class="text-xs mt-0.5">' +
            '<span class="text-gray-400">\u21A9 Backtrack proposal at </span>' +
            '<span class="text-yellow-400 font-medium">' + lbl + ' ' +
            _escapeHtml(_fixOcrText || '?') +
            (_fixSanText && _fixSanText !== _fixOcrText
              ? ' \u2192 ' + _escapeHtml(_fixSanText)
              : '') +
            '</span>' +
          '</div>';
      }

      stuckEl.innerHTML = _headline + _backtrackLine +
        '<div class="text-[11px] text-gray-500 mt-0.5">' +
          'Reviewing ' + _escapeHtml(_labelForMethod(v.method)) + '\u2019s choice. ' +
          'Confirm to accept, or pick a different fix to override ' +
          '(overrides exit review and rerun the search from that ply).' +
        '</div>';
    }
  }

  // Render quick fixes into #fix-list by calling interactive's
  // computeQuickFixes() — the single source of truth. It pulls from
  // state.moves[].wAlts/bAlts/wLenientAlts/bLenientAlts (which we
  // re-populate from OCR cells in _applyPickedToState) AND runs the
  // constrained re-OCR via window.zugwise, so review mode sees the exact
  // same list interactive mode does.
  // Compute-only version: returns the fix list, does NOT render. Render
  // is the caller's responsibility so a stale call (generation mismatch)
  // can skip the DOM write. Previous combined version rendered INSIDE
  // the await, so a stale call painted the fix-list before control
  // returned to _focusFix's generation check — producing the "mix of
  // suggestions for 6.W and 19.W" the user kept seeing.
  async function _computeQuickFixesAtPly(ply) {
    if (ply == null || typeof computeQuickFixes !== 'function') return [];
    // Same SAN swap as before: computeQuickFixes reads state.moves[i].white
    // as the "top OCR move" and filters alts equal to it. In review mode
    // that cell already holds greedy's fixed SAN, so we temporarily swap
    // it back to the OCR text from state.stuckInfo so computeQuickFixes
    // produces the same list interactive mode would.
    var moveIdx = Math.floor(ply / 2);
    var isWhite = (ply % 2 === 0);
    var entry = (state && state.moves) ? state.moves[moveIdx] : null;
    var ocrText = (state && state.stuckInfo && state.stuckInfo.move) || '';
    var savedSan = null, savedStatus = null, swapped = false;
    if (entry && ocrText) {
      if (isWhite) {
        savedSan = entry.white; savedStatus = entry.wStatus;
        if (ocrText !== savedSan) {
          entry.white = ocrText;
          entry.wStatus = 'illegal';
          swapped = true;
        }
      } else {
        savedSan = entry.black; savedStatus = entry.bStatus;
        if (ocrText !== savedSan) {
          entry.black = ocrText;
          entry.bStatus = 'illegal';
          swapped = true;
        }
      }
    }
    try {
      return (await computeQuickFixes()) || [];
    } catch (e) {
      return [];
    } finally {
      if (swapped) {
        if (isWhite) { entry.white = savedSan; entry.wStatus = savedStatus; }
        else { entry.black = savedSan; entry.bStatus = savedStatus; }
      }
    }
  }

  // Build the backtrack-fixes array mergeBacktrackFixes expects, from the
  // greedy cache (fix.all_candidates). Keep fixes at ALL plies — backtracking
  // often finds that the real error was earlier than the current stuck point,
  // and those earlier-ply suggestions are the important ones. Cap at 10 to
  // match interactive mode.
  function _buildBacktrackFixesFromCache(fix, ply, ocrText) {
    var chosenSan = _fixSan(fix);
    var cands = Array.isArray(fix.all_candidates) && fix.all_candidates.length
      ? fix.all_candidates.slice()
      : [fix];

    // Drop no-op fixes (san == ocr), too-far-future candidates, and
    // empty SANs. fix.all_candidates carries everything Greedy CONSIDERED
    // during its search, including later plies the algorithm touched.
    // For a non-backtrack fix (fix_ply == origin_stuck_ply), candidates at
    // ply > fix_ply are 'changes of moves in the future' and get cut here.
    // For a BACKTRACK fix (fix_ply < origin_stuck_ply), the user is
    // reviewing a proposal that lives BEFORE the actual stuck point — so
    // candidates at plies between fix_ply and origin_stuck_ply are legit
    // alternatives the user might want instead (e.g. fix the 16.B stuck
    // move directly rather than backtrack to 15.B). The cutoff becomes
    // origin_stuck_ply for backtrack fixes; candidates beyond that are
    // still cut as 'true future' moves the user can't reasonably review.
    var _cutoffPly = (fix && fix.is_backtrack && typeof fix.origin_stuck_ply === 'number'
                      && fix.origin_stuck_ply > ply)
      ? fix.origin_stuck_ply
      : ply;
    cands = cands.filter(function(c) {
      if (!c) return false;
      var rawSan = (c.san || c.move || '');
      if (!rawSan) return false;
      var san = rawSan.replace(/[+#]$/, '');
      var rawOcr = (c.ocr || '');
      var ocr = rawOcr.replace(/[+#]$/, '');
      var cPly = (typeof c.ply === 'number') ? c.ply : ply;
      // The algorithm's CHOSEN fix at the review ply must always survive the
      // no-op filters below. When the algorithm already APPLIED its pick (an
      // illegal-stop fix like 1.B Kc5→c5), that move is now the current move at
      // the ply, so the "san === ocr" and "move already at its ply" guards would
      // drop it — leaving the user with the chosen move's full score NOWHERE in
      // the deep-search list (only as a score-less OCR quick-fix). Keep it so
      // its score + component breakdown render like any other candidate.
      var _isChosenCand = !!(chosenSan && cPly === ply &&
                             san === chosenSan.replace(/[+#]$/, ''));
      // No-op filter: a candidate equal to the OCR text once trailing check/
      // mate symbols are ignored is normally cosmetic and dropped. EXCEPTION —
      // the phantom-check repair: OCR read e.g. "Bf4+" but Bf4 doesn't give
      // check, so the move is ILLEGAL in-position and the correct fix is to
      // drop the bogus '+'. That candidate ("Bf4") differs from the OCR only
      // by the suffix yet is a genuine repair, flagged by original_was_legal
      // === false. Without this carve-out the only correct fix at the stuck
      // ply silently vanishes from the deep-search list (reported: 39.W Bf4+).
      if (san === ocr && !_isChosenCand) {
        var phantomCheckFix = (rawSan !== rawOcr) && (c.original_was_legal === false);
        if (!phantomCheckFix) return false;
      }
      if (cPly > _cutoffPly) return false;
      // Drop a candidate that proposes the move ALREADY at its ply. Greedy's
      // cached candidates label `ocr` with the ORIGINAL OCR text (e.g. "Kc5"),
      // so a backtrack candidate re-proposing Greedy's own applied fix
      // ("Kc5 → c5", where c5 is already the move) slips past the san===ocr check
      // above and clutters the list with redundant self-fixes — which interactive
      // (it rebuilds OCR from the current move) never shows. Compare against the
      // current move at the candidate's ply.
      if (!_isChosenCand && state && Array.isArray(state.moves)) {
        var _cm = state.moves[Math.floor(cPly / 2)];
        var _curAtPly = _cm ? ((cPly % 2 === 0 ? _cm.white : _cm.black) || '') : '';
        if (_curAtPly && san === _curAtPly.replace(/[+#]$/, '')) return false;
      }
      return true;
    });

    // Rank the WHOLE candidate pool (at-ply readings + earlier-ply backtrack
    // fixes) together by score, then take the top 10. The earlier at-ply-vs-
    // earlier interleave was scaffolding for verifying P1/P2 scores side by
    // side; now that the scores are trusted, a single score sort is the honest
    // ranking — the best fix shows first regardless of which ply it's at.
    cands.sort(function(a, b) { return (b.unified_score || 0) - (a.unified_score || 0); });
    cands = cands.slice(0, 10);

    // Enrich each candidate with fields the interactive renderers expect.
    // Each candidate carries its own ply (may differ from the current stuck
    // ply); compute from/to squares AND ocr_from/to_square at the
    // candidate's OWN ply so the red + yellow arrows track when the user
    // clicks a cross-ply suggestion.
    return cands.map(function(c) {
      var san = c.san || c.move;
      var cPly = (typeof c.ply === 'number') ? c.ply : ply;
      var cLbl = c.ply_str || _plyLabel(cPly);
      var fromSq = c.from_square || null, toSq = c.to_square || null;
      if (!fromSq && san) {
        var sq = _inferMoveSquares(cPly, san);
        if (sq) { fromSq = sq.from; toSq = sq.to; }
      }
      // Compute OCR error squares at THIS candidate's ply (its own OCR text,
      // which may differ from the current stuck ply's OCR).
      var cOcr = c.ocr || (cPly === ply ? ocrText : _ocrTextAtPly(cPly));
      var ocrFrom = c.ocr_from_square || null, ocrTo = c.ocr_to_square || null;
      if (!ocrFrom && cOcr) {
        var sq2 = _inferMoveSquares(cPly, cOcr);
        if (sq2) { ocrFrom = sq2.from; ocrTo = sq2.to; }
      }
      return Object.assign({}, c, {
        san: san,
        ocr: cOcr,
        ply: cPly,
        ply_str: cLbl,
        similarity: typeof c.similarity === 'number' ? c.similarity : 0,
        from_square: fromSq,
        to_square: toSq,
        ocr_from_square: ocrFrom,
        ocr_to_square: ocrTo
      });
    });
  }

  // Look up the original OCR text for a given ply from the saved OCR result
  // (used when a backtrack candidate at an earlier ply needs its own OCR
  // text for arrow inference).
  function _ocrTextAtPly(ply) {
    var cell = _findOcrCellForPly(ply);
    if (cell && cell.move) return cell.move;
    // Fall back to the currently-applied SAN at that ply (may equal the fix).
    if (state && state.sans && ply >= 0 && ply < state.sans.length) {
      return state.sans[ply] || '';
    }
    return '';
  }

  function _findOcrCellForPly(ply) {
    var v = _ensureState();
    if (!v || !v.ocrResult || ply == null) return null;
    var cells = _collectOcrCells(v);
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var cp = (c.num - 1) * 2 + (c.color === 'w' || c.color === 'W' ? 0 : 1);
      if (cp === ply) return c;
    }
    return null;
  }

  // #btn-apply click (keyboard Enter) — confirm current selection. If the
  // selected fix differs from greedy's choice (in SAN OR ply — backtracking
  // surfaces fixes at earlier plies too), exit + requeue greedy. Otherwise
  // just advance to the next algorithm fix.
  function _onConfirmClick() {
    var v = _ensureState();
    if (!v || v.fixes.length === 0) return;
    var chosen = v.fixes[v.currentFixIndex];
    var chosenSan = _fixSan(chosen);
    var chosenPly = _fixPly(chosen);
    var sel = (typeof state !== 'undefined' && state.selectedFix) || null;
    var selPly = (sel && typeof sel.ply === 'number') ? sel.ply : null;
    // Keep-as-is selection (the yellow "✓ Keep <move> — accept as-is" button):
    // the user signed off on the move AS WRITTEN. This normally LOCKS the ply
    // (wStatus='locked' + state.lockedPlies), exactly like the live panel's
    // applyFix — not mark it merely 'fixed' (the _confirmCurrentFix default)
    // and not fire the SAN-differs requeue branch below (a keep is a signoff,
    // not an override that needs the algorithms to rebuild downstream). Route
    // BEFORE the generic differs check: a keep on a bad-trade/piece-hanging
    // warning carries the OCR move as its SAN, which differs from the
    // algorithm's PROPOSED change and would otherwise wrongly trigger
    // _requeueAndExit.
    //
    // EXCEPTION — keep that diverges from what the algorithm actually PLAYED:
    // at a sheets-disagree forced stop the algorithm may have applied the OTHER
    // candidate as its pick-max to continue (e.g. greedy played Rc1+ and built
    // its downstream — 40.W onward — on that), while the yellow "✓ Keep"
    // button keeps the merged reading (Rc2). Keeping Rc2 invalidates every fix
    // after this ply, because they were computed against the Rc1+ board. Just
    // advancing the walkthrough then surfaces stale, now-illegal proposals
    // (user-reported: after "Keep Rc2" the review still offered 40.W Ke1→Ke2,
    // which moves the king into check from the kept rook on c2). When the kept
    // move differs from state.sans[p] (what the algorithm ACTUALLY played, and
    // what the downstream depends on), treat the keep as an OVERRIDE: requeue +
    // exit so the search rebuilds from the kept reading. Compare against
    // state.sans[p], NOT the proposed-fix SAN — a bad-trade/piece-hanging
    // warning never applied its proposal (state.sans[p] still holds the kept
    // OCR move, or the board stopped at p so there is no downstream), so it
    // correctly stays a pure signoff.
    if (sel && sel.keep_as_is) {
      var keepPly = (selPly != null) ? selPly : chosenPly;
      var keepSan = sel.san;
      var core = function(s) {
        return s == null ? '' : String(s).replace(/x/g, '').replace(/[+#?!]+$/, '');
      };
      var algoPlayedSan = (typeof keepPly === 'number' && Array.isArray(state.sans) &&
                           keepPly < state.sans.length) ? state.sans[keepPly] : null;
      if (algoPlayedSan != null && keepSan != null &&
          core(algoPlayedSan) !== core(keepSan)) {
        _requeueAndExit(keepPly, keepSan);
      } else {
        _confirmKeepLock(sel);
      }
      return;
    }
    // Strip trailing +/# before comparing — fix-list buttons often carry the
    // stripped SAN ("Bg5") while the walkthrough fix carries the decorated
    // one ("Bg5+"). Without this normalization, merely confirming Beam's own
    // suggestion was firing the override branch and requeueing all three
    // algorithms for no semantic change.
    var normSan = function(s) { return s == null ? s : String(s).replace(/[+#]+$/, ''); };
    var sanDiffers = sel && sel.san && normSan(sel.san) !== normSan(chosenSan);
    var plyDiffers = sel && selPly != null && selPly !== chosenPly;
    if (sel && sel.san && (sanDiffers || plyDiffers)) {
      _requeueAndExit(selPly != null ? selPly : chosenPly, sel.san);
    } else {
      _confirmCurrentFix();
    }
  }

  // Mini JS port of backend helpers.infer_move_squares: best-guess from/to
  // squares for a SAN played at `ply`, even when the SAN is illegal in that
  // position (which is the whole point — we need arrows for the *stuck*
  // moves, and stuck moves are illegal by definition).
  function _inferMoveSquares(ply, san) {
    if (!san || ply == null || typeof Chess !== 'function' || !state || !state.sans) {
      return null;
    }
    var c;
    try {
      c = new Chess();
      for (var j = 0; j < ply; j++) c.move(state.sans[j]);
    } catch (e) { return null; }

    // Try a legal/sloppy parse first — covers most non-stuck cases (e.g. the
    // suggested fix square computation).
    try {
      var c2 = new Chess(c.fen());
      var mv = c2.move(san, { sloppy: true });
      if (mv) return { from: mv.from, to: mv.to };
    } catch (e) { /* fall through to inference */ }

    var clean = String(san).replace(/[+#]/g, '').trim();
    if (!clean) return null;

    // Castling
    var upper = clean.toUpperCase().replace(/0/g, 'O');
    if (upper === 'O-O' || upper === 'OO') {
      var r1 = c.turn() === 'w' ? '1' : '8';
      return { from: 'e' + r1, to: 'g' + r1 };
    }
    if (upper === 'O-O-O' || upper === 'OOO') {
      var r2 = c.turn() === 'w' ? '1' : '8';
      return { from: 'e' + r2, to: 'c' + r2 };
    }

    // Extract destination square (last "<file><rank>" in the SAN).
    var noX = clean.replace(/x/g, '');
    var toSq = null;
    for (var i = noX.length - 1; i >= 1; i--) {
      var f = noX[i - 1], r = noX[i];
      if (f >= 'a' && f <= 'h' && r >= '1' && r <= '8') { toSq = f + r; break; }
    }
    if (!toSq) return null;

    var pieceChar = (noX[0] && /[KQRBN]/.test(noX[0])) ? noX[0] : 'P';
    var pieceLower = pieceChar.toLowerCase();
    var color = c.turn();

    var candidates = [];
    var FILES = 'abcdefgh';
    for (var fi = 0; fi < 8; fi++) {
      for (var rk = 1; rk <= 8; rk++) {
        var s = FILES[fi] + rk;
        var pc = c.get(s);
        if (pc && pc.color === color && pc.type === pieceLower) candidates.push(s);
      }
    }
    if (candidates.length === 0) return { from: null, to: toSq };

    // Disambiguation char (e.g. Nbd2, R1e1).
    if (pieceChar !== 'P' && noX.length >= 3) {
      var dis = noX[1];
      for (var k = 0; k < candidates.length; k++) {
        if (dis >= 'a' && dis <= 'h' && candidates[k][0] === dis) return { from: candidates[k], to: toSq };
        if (dis >= '1' && dis <= '8' && candidates[k][1] === dis) return { from: candidates[k], to: toSq };
      }
    }

    // Pawn: pick by file (capture: source file is first char of SAN).
    if (pieceChar === 'P') {
      var isCap = /x/.test(clean);
      var srcFile = isCap ? clean[0] : toSq[0];
      var toRank = parseInt(toSq[1]);
      var dir = color === 'w' ? -1 : 1;
      // Try one square back, then two (initial double-push).
      var try1 = srcFile + (toRank + dir);
      var try2 = srcFile + (toRank + 2 * dir);
      if (candidates.indexOf(try1) !== -1) return { from: try1, to: toSq };
      if (candidates.indexOf(try2) !== -1) return { from: try2, to: toSq };
      // Fall through.
    }

    // Bishop: prefer most diagonal candidate.
    if (pieceChar === 'B') {
      var toF = FILES.indexOf(toSq[0]);
      var toR = parseInt(toSq[1]) - 1;
      candidates.sort(function(a, b) {
        var aF = FILES.indexOf(a[0]), aR = parseInt(a[1]) - 1;
        var bF = FILES.indexOf(b[0]), bR = parseInt(b[1]) - 1;
        var aDF = Math.abs(toF - aF), aDR = Math.abs(toR - aR);
        var bDF = Math.abs(toF - bF), bDR = Math.abs(toR - bR);
        var aScore = (aDF === aDR && aDF > 0) ? 0 : ((aDF > 0 && aDR > 0) ? Math.abs(aDF - aDR) : 100);
        var bScore = (bDF === bDR && bDF > 0) ? 0 : ((bDF > 0 && bDR > 0) ? Math.abs(bDF - bDR) : 100);
        return aScore - bScore;
      });
    }

    return { from: candidates[0], to: toSq };
  }

  function _legalMovesAtPly(ply) {
    if (ply == null || typeof Chess !== 'function' || !state || !state.sans) return [];
    try {
      var c = new Chess();
      for (var j = 0; j < ply; j++) { c.move(state.sans[j]); }
      return c.moves();
    } catch (e) {
      return [];
    }
  }

  // =========================================================================
  // Scoresheet canvas — draw source image + highlight changed cells
  // =========================================================================

  function _drawScoresheetHighlights() {
    var v = _ensureState();
    var canvas = document.getElementById('verify-scoresheet-canvas');
    var noImg = document.getElementById('verify-no-image');
    if (!canvas) return;

    // Try to locate a scoresheet image: the dual-sheet case has sheet1Image,
    // the single-sheet case may have an .image on ocrResult.
    var image = _sourceImageFromOcrResult(v.ocrResult);
    if (!image) {
      canvas.classList.add('hidden');
      if (noImg) noImg.classList.remove('hidden');
      return;
    }

    canvas.classList.remove('hidden');
    if (noImg) noImg.classList.add('hidden');

    var draw = function(img) {
      var ctx = canvas.getContext('2d');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      ctx.drawImage(img, 0, 0);

      // Overlay highlights from gridSidecar bboxes (if available).
      var grid = v.ocrResult && v.ocrResult.gridSidecar;
      if (!grid || !grid.cells) return;

      v.fixes.forEach(function(fix, i) {
        var p = _fixPly(fix);
        if (p == null) return;
        var cell = _findCellForPly(grid.cells, p);
        if (!cell || !cell.bbox) return;
        var c = _colorFor(i);
        ctx.fillStyle = c.fill;
        ctx.fillRect(cell.bbox.x, cell.bbox.y, cell.bbox.w, cell.bbox.h);
        ctx.strokeStyle = c.stroke;
        ctx.lineWidth = 3;
        ctx.strokeRect(cell.bbox.x, cell.bbox.y, cell.bbox.w, cell.bbox.h);
      });
    };

    if (image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0) {
      draw(image);
    } else if (typeof image === 'string') {
      var im = new Image();
      im.onload = function() { draw(im); };
      im.onerror = function() {
        canvas.classList.add('hidden');
        if (noImg) noImg.classList.remove('hidden');
      };
      im.src = image;
    } else if (image instanceof HTMLImageElement) {
      image.addEventListener('load', function() { draw(image); });
    }
  }

  function _sourceImageFromOcrResult(r) {
    if (!r) return null;
    // Dual-sheet: prefer a combined canvas if we had one, otherwise show left.
    if (r.isDualSheet) return r.sheet1Image || r.sheet2Image || null;
    return r.image || r.imageDataUrl || null;
  }

  function _findCellForPly(cells, ply) {
    if (!cells) return null;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var p = (c.num - 1) * 2 + (c.color === 'w' || c.color === 'W' ? 0 : 1);
      if (p === ply) return c;
    }
    return null;
  }

  // =========================================================================
  // Move list overlay — highlight fixed cells, attach click handlers
  // =========================================================================

  function renderVerificationMoveList() {
    var v = _ensureState();
    if (!v || !v.active) return;

    // Re-run the canonical move list renderer first. This also reinstates
    // the ondblclick → enterEditMode handler set by ui.js, so the user can
    // still double-click during review to manually correct a move (which
    // counts as an override via the edit-commit path).
    if (typeof renderMoveList === 'function') renderMoveList();

    // Then overlay fix indicators (inline old→new annotation + current-fix
    // yellow highlight). No per-fix cycling colors: they were visually
    // meaningless and collided with the normal green-check/strikethrough
    // convention used in interactive mode.
    v.fixes.forEach(function(fix, i) {
      var p = _fixPly(fix);
      if (p == null) return;
      var moveNum = Math.floor(p / 2) + 1;
      var isWhite = (p % 2 === 0);
      var row = document.getElementById('move-row-' + moveNum);
      if (!row) return;
      var tds = row.querySelectorAll('td');
      // layout: [num, white, black]
      var td = tds[isWhite ? 1 : 2];
      if (!td) return;

      // Skip the strike-through/arrow overlay for plies the user has
      // already confirmed via _confirmCurrentFix — those cells now carry
      // wStatus='fixed' and render the green ✓, and the strike-through
      // indicator would clash visually (user already signed off). Click
      // handlers still get re-attached below so navigation back to a
      // confirmed fix still works.
      var moveIdx = moveNum - 1;
      var mEntry = (typeof state !== 'undefined' && state.moves) ? state.moves[moveIdx] : null;
      var alreadyConfirmed = mEntry && (
        isWhite ? (mEntry.wStatus === 'fixed' || mEntry.wStatus === 'locked')
                : (mEntry.bStatus === 'fixed' || mEntry.bStatus === 'locked')
      );

      td.classList.add('verification-fix');
      td.dataset.fixIndex = i;
      td.dataset.verificationPly = p;

      // Inline old → new indicator (only if OCR differed from SAN, and
      // only if not yet confirmed).
      var ocrText = fix.ocr;
      var fixSan = _fixSan(fix);
      if (!alreadyConfirmed && ocrText && fixSan && ocrText !== fixSan &&
          !td.querySelector('.v-fix-indicator')) {
        var span = document.createElement('span');
        span.className = 'v-fix-indicator ml-1 text-[10px]';
        span.innerHTML = '<s class="text-red-300">' + _escapeHtml(ocrText) + '</s>' +
                         '<span class="text-green-300">\u2192' + _escapeHtml(fixSan) + '</span>';
        td.appendChild(span);
      }

      // Single-click → focus this fix. Use capture so it wins over the
      // default td.onclick = goToPly wired by ui.js.
      td.addEventListener('click', function(e) {
        if (e.target.classList && e.target.classList.contains('delete-from-here')) return;
        e.stopPropagation();
        _focusFix(i);
      }, true);

      // Double-click → manual edit. enterEditMode rewrites #panel-fixes
      // (fix-panel-title, stuck-info, fix-list) — those IDs don't exist in
      // the verification overlay, so we exit verification first, then call
      // the normal edit flow. The user's manual selection becomes an
      // override via selectFix/applyFix, and the requeue is triggered
      // post-commit by _onEditCommittedDuringReview (hooked below).
      var m = { num: moveNum, color: isWhite ? 'w' : 'b', ply: p, fixIndex: i };
      td.addEventListener('dblclick', function(e) {
        if (e.target.classList && e.target.classList.contains('delete-from-here')) return;
        if (e.target.classList && e.target.classList.contains('revert-fix')) return;
        e.stopPropagation();
        _beginReviewEdit(m);
      }, true);
    });

    // Highlight the currently-focused fix in yellow (only).
    _highlightCurrentFix();
  }

  /**
   * User double-clicked a reviewed move. The normal edit UI (enterEditMode)
   * paints into #fix-panel-title / #stuck-info / #fix-list which don't
   * exist inside the verification overlay — so we exit verification first
   * and let the standard edit flow take over. Any move the user commits
   * counts as a manual override of the algorithm's chosen fix; they can
   * re-enter review once they're done editing (or after a requeued greedy
   * run completes).
   *
   * Before exiting, revert every algorithm-proposed cell AT OR AFTER the
   * edit ply to its pre-review OCR baseline and drop `wStatus` off 'fixed'.
   * Without this, plies the user just confirmed during the walkthrough carry
   * wStatus='fixed' for what were only confirmations of Greedy's picks. When
   * 35.W gets overridden, Greedy's downstream choices no longer apply to the
   * new timeline, but fixes.js/applyFix's undo-downstream loop (line 773)
   * skips anything 'fixed' — so those stale choices stayed in state.moves
   * and revalidate happily reported "Game complete!" while the real game
   * was nowhere near complete (a new Greedy run in parallel found 3 more
   * fixes needed).
   */
  function _beginReviewEdit(m) {
    if (typeof enterEditMode !== 'function') return;
    var v = _ensureState();
    if (v && v.active && m && typeof m.ply === 'number' && typeof state !== 'undefined') {
      var overridePly = m.ply;
      var pre = v._preReviewMoves || [];
      var reverted = 0;
      for (var i = 0; i < (state.moves || []).length; i++) {
        var mv = state.moves[i];
        if (!mv) continue;
        var wPly = (mv.num - 1) * 2;
        var bPly = wPly + 1;
        var preEntry = pre[i] || null;
        // White side of the pair.
        if (mv.wAlgoProposed && wPly >= overridePly) {
          if (preEntry) {
            mv.white = preEntry.white || '';
            if (typeof preEntry.wConf === 'number') mv.wConf = preEntry.wConf;
            if (preEntry.wAlts) mv.wAlts = preEntry.wAlts;
            if (preEntry.wLenientAlts) mv.wLenientAlts = preEntry.wLenientAlts;
          }
          mv.wStatus = 'pending';
          mv.wOriginal = null;
          mv.wAlgoProposed = false;
          reverted++;
        }
        // Black side. Note: when overridePly is white's, we still revert
        // that move's black side because it's downstream of the override.
        if (mv.bAlgoProposed && bPly >= overridePly) {
          if (preEntry) {
            mv.black = preEntry.black || '';
            if (typeof preEntry.bConf === 'number') mv.bConf = preEntry.bConf;
            if (preEntry.bAlts) mv.bAlts = preEntry.bAlts;
            if (preEntry.bLenientAlts) mv.bLenientAlts = preEntry.bLenientAlts;
          }
          mv.bStatus = 'pending';
          mv.bOriginal = null;
          mv.bAlgoProposed = false;
          reverted++;
        }
      }
      if (reverted > 0 && typeof log === 'function') {
        log('✏️ Override at ' + _plyLabel(overridePly) + ': reverted ' +
            reverted + ' downstream algo-proposed cell(s) to OCR baseline');
      }
      // Tell the next revalidate (triggered by the user's edit commit) to
      // skip similarity / OCR-alt auto-fix so the user sees the real new
      // stuck point. Otherwise validate_moves' one-or-nothing rescue path
      // can re-derive the same fixes Greedy would propose and silently
      // auto-apply them, reporting "Game complete!" and skipping review.
      state._skipAutoFixNextRevalidate = true;
    }
    exitVerificationMode();
    // Defer to next tick so exit's DOM rewrite settles before enterEditMode
    // writes over it again.
    setTimeout(function() {
      try { enterEditMode(m.num, m.color); } catch (e) {
        if (typeof log === 'function') log('Edit failed: ' + e.message);
      }
    }, 0);
  }

  // Backwards-compat shim — paints the algorithm's stuck ply red and the
  // currently-focused fix yellow (both default to the algorithm's chosen
  // ply, but if the user has clicked a cross-ply candidate, yellow moves
  // to that earlier/later ply while red stays at the algorithm's stuck
  // point — same convention as the OCR context panel.
  function _highlightCurrentFix() {
    var v = _ensureState();
    if (!v || !v.active || v.fixes.length === 0) {
      _paintReviewHighlights(null, null);
      return;
    }
    var stuckPly = _fixPly(v.fixes[v.currentFixIndex]);
    var selPly = (typeof v.selectedPly === 'number') ? v.selectedPly : stuckPly;
    _paintReviewHighlights(stuckPly, selPly);
  }

  function _paintReviewHighlights(stuckPly, selectedPly) {
    document.querySelectorAll(
      'td.verification-fix-current, td.verification-fix-stuck'
    ).forEach(function(td) {
      td.classList.remove('verification-fix-current');
      td.classList.remove('verification-fix-stuck');
      td.style.boxShadow = '';
      td.style.backgroundColor = '';
    });

    function getTd(ply) {
      if (ply == null) return null;
      var moveNum = Math.floor(ply / 2) + 1;
      var isWhite = (ply % 2 === 0);
      var row = document.getElementById('move-row-' + moveNum);
      if (!row) return null;
      var tds = row.querySelectorAll('td');
      return tds[isWhite ? 1 : 2] || null;
    }

    var stuckTd = getTd(stuckPly);
    if (stuckTd) {
      stuckTd.classList.add('verification-fix-stuck');
      stuckTd.style.backgroundColor = 'rgba(239, 68, 68, 0.35)';
      stuckTd.style.boxShadow = 'inset 0 0 0 2px rgba(239, 68, 68, 1.0)';
    }

    var selTd = getTd(selectedPly);
    if (selTd) {
      selTd.classList.add('verification-fix-current');
      if (selectedPly === stuckPly) {
        // Same cell — keep the red bg, layer the yellow border on top so
        // it reads as "the stuck point IS the one we're currently editing".
        selTd.style.boxShadow = 'inset 0 0 0 3px rgba(234, 179, 8, 1.0)';
      } else {
        selTd.style.boxShadow = 'inset 0 0 0 2px rgba(234, 179, 8, 1.0)';
        selTd.style.backgroundColor = 'rgba(234, 179, 8, 0.4)';
      }
    }
  }

  function _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(ch) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch];
    });
  }

  // =========================================================================
  // Fix navigation + review panel
  // =========================================================================

  function _navFix(delta) {
    var v = _ensureState();
    if (!v || v.fixes.length === 0) return;
    var next = v.currentFixIndex + delta;
    if (next < 0) next = 0;
    if (next >= v.fixes.length) next = v.fixes.length - 1;
    _focusFix(next);
  }

  // Generation counter so a stale _focusFix call (started during a game
  // switch) can't clobber the DOM after the new _focusFix has already
  // rendered its own content. _renderQuickFixesForFocus awaits the
  // Python backend (computeQuickFixes), which can take ~100ms — plenty
  // of time for the user to switch games and for a new _focusFix to
  // start. Without the generation guard, the first call's backtrack
  // list and chosen-button click land in the DOM AFTER the second
  // call's renderQuickFixes has cleared fix-list, producing the "mess
  // of conflicting suggestions, some related to 6.W and others to 19.W"
  // the user reported. Every entry into _focusFix bumps the counter;
  // each call captures its generation on entry and aborts at every DOM-
  // write checkpoint if the counter has advanced.
  var _focusFixGeneration = 0;

  async function _focusFix(idx) {
    var v = _ensureState();
    if (!v || v.fixes.length === 0) return;
    if (idx < 0 || idx >= v.fixes.length) return;
    v.currentFixIndex = idx;
    // Reset the per-click selection — _selectChosenFixButton below will
    // re-set it via the patched selectFix to greedy's chosen ply.
    v.selectedPly = null;

    var myGen = ++_focusFixGeneration;
    function _stillCurrent() {
      if (myGen !== _focusFixGeneration) {
        if (typeof log === 'function') {
          log('  ✕ focus fix #' + (idx + 1) + ' aborted (superseded)');
        }
        return false;
      }
      return true;
    }

    var fix = v.fixes[idx];
    var p = _fixPly(fix);
    var ocrText = fix.ocr || _fixSan(fix) || '';
    if (typeof log === 'function' && p != null) {
      var fNum = Math.floor(p / 2) + 1;
      var fCol = (p % 2 === 0) ? 'W' : 'B';
      log('  → focus fix #' + (idx + 1) + ' of ' + v.fixes.length +
          ' at ' + fNum + '.' + fCol + ' — ' + (ocrText || '?') +
          ' → ' + _fixSan(fix));
    }

    // 1. Simulate state.stuckPly / stuckInfo / legalMoves / errorArrow
    //    BEFORE the board navigation. goToPly calls highlightCurrentMove
    //    internally, and that function's stuck-cell special case reads
    //    state.stuckPly / stuckInfo — if we don't set them first, the
    //    special case misses and highlightCurrentMove falls through to
    //    "highlight last played ply" (= stuckPly - 1), producing the
    //    second yellow outline on the PRIOR cell that the user kept
    //    reporting. Setting stuck state first means goToPly's highlight
    //    call sees consistent state and marks only the stuck cell.
    _setupStuckStateForFix(fix, p);

    // 2. Board: position BEFORE the stuck move. Use preserveErrorArrow
    //    so goToPly doesn't clobber the arrow we just set.
    if (p != null && typeof goToPly === 'function') {
      goToPly(p, { preserveErrorArrow: true });
    }

    // 3. Show a brief "Finding Quick Fixes…" placeholder while the worker
    //    computes them. We deliberately DON'T paint algo fixes here, even
    //    though fix.all_candidates is sync and could render instantly.
    //
    //    The previous flow painted algo fixes immediately, then on quick-fix
    //    arrival called renderQuickFixes(qfList) which wipes #fix-list and
    //    rebuilds with quick fixes on top + a fresh empty deep-search
    //    placeholder, then mergeBacktrackFixes re-filled the algo buttons
    //    BELOW. The algo buttons jumped to a different vertical position on
    //    arrival of quick fixes — a user once intended to double-click an
    //    algo fix and clicked a quick fix that had just slid into the same
    //    spot. Quick fixes are fast in the common case (post-recent
    //    optimizations); a single atomic paint at step 5 trades a small
    //    delay for eliminating that misfire.
    var backtrackFixes = _buildBacktrackFixesFromCache(fix, p, ocrText);
    state.quickFixes = [];
    var fixListEl = document.getElementById('fix-list');
    if (fixListEl) {
      fixListEl.innerHTML = '<div class="text-xs text-gray-500 mt-3 mb-2 ' +
        'flex items-center gap-2"><span class="calculating">⚡</span>' +
        '<span>Finding Quick Fixes…</span></div>';
    }

    // 4. Quick Fixes — delegate to interactive's computeQuickFixes so
    //    the three panels (strict alts / lenient / constrained re-OCR)
    //    render identically to interactive mode. Compute BEFORE the
    //    generation check, render AFTER — otherwise a stale call's
    //    renderQuickFixes paints the DOM before we get to abort it.
    var qfList = await _computeQuickFixesAtPly(p);
    if (!_stillCurrent()) return;
    state.quickFixes = qfList;
    // Re-assert the stuck-state we set before the await — some other code
    // path (fetchFixes triggered by the pre-entry validate, an overrided
    // revalidate finishing) can write state.stuckInfo during the await
    // window. renderQuickFixes reads state.stuckInfo to decide whether to
    // render the "Keep it / Revert to OCR" strip; if a stale piece-hanging
    // stuckInfo is in place at that moment it injects those buttons into
    // the current fix's panel (user-reported: "Keep g6 — accept as-is"
    // appeared above the 13.B Quick Fixes even though the current stuck
    // point is 13.B Nxe4 is illegal).
    _setupStuckStateForFix(fix, p);

    // 5. Atomic paint — quick fixes on top, algo fixes below, no shift.
    //    renderQuickFixes wipes #fix-list and rebuilds with the quick-fix
    //    section + empty deep-search placeholder; mergeBacktrackFixes then
    //    fills the placeholder with the algo buttons. From the user's
    //    perspective this happens in a single tick: the placeholder text
    //    flips to the populated panel.
    if (typeof renderQuickFixes === 'function') renderQuickFixes(qfList);
    if (typeof renderLegalMoves === 'function') {
      try { renderLegalMoves(); } catch (e) { /* non-fatal */ }
    }
    if (typeof mergeBacktrackFixes === 'function') {
      mergeBacktrackFixes(backtrackFixes, []);
    }
    if (!_stillCurrent()) return;
    // Wrap each backtrack button so clicking a cross-ply candidate updates
    // state.savedErrorArrow (interactive selectFix uses it as the persistent
    // red arrow). Without this, clicking an earlier-ply suggestion would
    // leave the red arrow pinned to the current stuck ply's OCR move.
    _wireBacktrackArrowOverride(backtrackFixes);
    _wireKeepButtonForReview();

    // 6. Re-select greedy's chosen fix (renderQuickFixes / mergeBacktrackFixes
    //    each try to auto-select their own first button — we override that
    //    to match greedy's actual choice).
    _selectChosenFixButton(_fixSan(fix), fix);

    // 7. Title/counter/override badge + move-list yellow highlight + arrows.
    _renderReviewHeader();
    _highlightCurrentFix();
    _scrollPanelsToTop();
    _scrollMoveIntoView(p);
    if (typeof renderArrows === 'function') {
      try { renderArrows(); } catch (e) { /* non-fatal */ }
    }
  }

  // Wrap onclick/ondblclick on each backtrack button so the persistent red
  // arrow (state.savedErrorArrow) follows the candidate the user picks.
  // Buttons in #deep-search-section are rendered in the same order as
  // `backtrackFixes`, capped at 8 (see mergeBacktrackFixes in fixes.js).
  function _wireBacktrackArrowOverride(backtrackFixes) {
    var deep = document.getElementById('deep-search-section');
    if (!deep || !backtrackFixes) return;
    var btns = deep.querySelectorAll('button');
    for (var i = 0; i < btns.length && i < backtrackFixes.length; i++) {
      (function(btn, fix) {
        var origClick = btn.onclick;
        var origDbl = btn.ondblclick;
        var setSaved = function() {
          if (fix.ocr_from_square && fix.ocr_to_square) {
            state.savedErrorArrow = { from: fix.ocr_from_square, to: fix.ocr_to_square };
          } else {
            state.savedErrorArrow = null;
          }
          // Force selectFix to restore from the new savedErrorArrow.
          state.errorArrow = null;
        };
        if (origClick) btn.onclick = function(e) { setSaved(); return origClick.call(this, e); };
        if (origDbl) btn.ondblclick = function(e) { setSaved(); return origDbl.call(this, e); };
      })(btns[i], backtrackFixes[i]);
    }
  }

  // Re-wire the yellow "✓ Keep <move> — accept as-is" button's double-click
  // for review mode. createKeepAsIsButton (fixes.js) wires ondblclick to the
  // live-panel applyFix(), which runs a full revalidate that fights the review
  // state machine and leaves the move un-locked (the user-reported bug). In
  // review the keep must go through the review confirm path: select the keep
  // fix (the button's own onclick), then run _onConfirmClick, which detects
  // keep_as_is and routes to _confirmKeepLock. The single-click path already
  // selects the keep fix, so the main Confirm button works without re-wiring.
  function _wireKeepButtonForReview() {
    var container = document.getElementById('fix-list');
    if (!container) return;
    var btns = container.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var ys = btns[i].querySelector('.text-yellow-300');
      if (ys && /✓\s*Keep\b/.test(ys.textContent)) {
        (function(btn) {
          var origClick = btn.onclick;
          btn.ondblclick = function(e) {
            if (origClick) origClick.call(this, e); // select the keep fix
            _onConfirmClick();                      // review confirm → lock
          };
        })(btns[i]);
        return;
      }
    }
  }

  // Find the fix-list button whose displayed SAN matches `chosenSan` and
  // programmatically click it so selectFix() runs with greedy's choice.
  function _selectChosenFixButton(chosenSan, fix) {
    var container = document.getElementById('fix-list');
    if (!container) return;

    // Forced-stop KEEP-marker (algorithm chose to KEEP the merged reading at an
    // ambiguous ply — san === ocr, origin_stop_reason 'ambiguous'). Every green
    // "fix → X" button here is an OVERRIDE; the algorithm's actual choice is the
    // YELLOW "✓ Keep <move>" button (createKeepAsIsButton, .text-yellow-300).
    // The green-span loop below can't match it (wrong colour, and no green
    // button shows the kept move), so it falls back to the first quick-fix — an
    // override — which makes the green Confirm bind to a CHANGE and EXIT+requeue
    // instead of advancing (the "switched" bug the user hit). Select the keep
    // button so Confirm == the algorithm's keep and advances normally; the
    // alternatives stay available as explicit overrides.
    var _norm = function(s) { return s == null ? '' : String(s).replace(/[+#]+$/, ''); };
    var _isKeepMarker = fix && fix.origin_stop_reason === 'ambiguous' &&
                        _fixSan(fix) && fix.ocr && _norm(_fixSan(fix)) === _norm(fix.ocr);
    if (_isKeepMarker) {
      var allBtns = container.querySelectorAll('button');
      for (var k = 0; k < allBtns.length; k++) {
        var ys = allBtns[k].querySelector('.text-yellow-300');
        if (ys && /✓\s*Keep\b/.test(ys.textContent)) {
          try { allBtns[k].click(); } catch (e) {}
          return;
        }
      }
      // No keep button found (shouldn't happen for an ambiguous step) — fall
      // through to the SAN match below rather than leaving a stale selection.
    }

    if (!chosenSan) return;
    var target = chosenSan.replace(/[+#]$/, '');
    var buttons = container.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      // Look for the green-SAN span (text contains chosen SAN).
      var sanSpan = btn.querySelector('.text-green-400.font-semibold, .text-cyan-400.font-semibold, .text-amber-400.font-semibold, .text-purple-400.font-semibold');
      var sanText = sanSpan ? sanSpan.textContent.replace(/[+#]$/, '').trim() : '';
      if (sanText === target) {
        try { btn.click(); } catch (e) {}
        return;
      }
    }
  }

  function _scrollPanelsToTop() {
    var grid = document.getElementById('main-grid');
    if (!grid) return;

    // Defer to an active alignment / structural-edit banner. The banner
    // sits above #main-grid in the DOM and renders during the same flush
    // as revalidate's awaited API response — without this guard,
    // _scrollWindowToBanner pulls the banner up first (user sees the
    // flash), then revalidate's continuation runs _scrollPanelsToTop and
    // scrolls past it, hiding the banner just as the user notices it.
    // Reported as: "I saw it flashing up at the top and then it scrolled
    // immediately down to the board, fix-suggestions and movelist."
    var alignBanner = document.getElementById('alignment-suggestion-banner');
    if (alignBanner) {
      var bRect = alignBanner.getBoundingClientRect();
      if (bRect.height > 0) return;
    }

    // Snap the grid's top to the viewport top whenever it's meaningfully off
    // (±2px tolerance only, to absorb sub-pixel layout rounding). The old
    // guard `rect.top < 0 || rect.top > innerHeight * 0.3` left a dead-zone:
    // any offset between 0 and ~30% of the viewport went UNcorrected. Clicking
    // the Apply button hits ~0 (already pinned) so it looked aligned, but
    // confirming via double-click on a fix / keep-as-is button nudges the
    // scroll into that band (board nav + focus on the first click), and the
    // dead-zone then left the Board/Suggestions/Moves panels a few pixels
    // high or low — the small up/down jump the user reported. A deterministic
    // snap keeps the three panels' tops aligned regardless of how the move was
    // confirmed. (The alignment-banner guard above still exempts NW-alignment.)
    var rect = grid.getBoundingClientRect();
    if (Math.abs(rect.top) > 2) {
      window.scrollTo({ top: window.scrollY + rect.top, behavior: 'instant' });
    }
  }

  function _scrollMoveIntoView(ply) {
    if (ply == null) return;
    var moveNum = Math.floor(ply / 2) + 1;
    var row = document.getElementById('move-row-' + moveNum);
    if (!row) return;
    // Scroll ONLY the move-list container — never the page. scrollIntoView
    // bubbles up to the nearest scrollable ancestor when the inner container
    // is already pinned to bottom (last ~5 moves), which scrolled the whole
    // page and kicked the board + fix panel off-screen. Compute target
    // scrollTop manually and clamp to the container's scrollable range so
    // rows near the end stay at the bottom instead of being re-centered.
    var container = document.getElementById('move-list-container');
    if (!container) return;
    var rowTop = row.offsetTop;
    var rowH = row.offsetHeight;
    var viewH = container.clientHeight;
    var curScroll = container.scrollTop;
    var maxScroll = Math.max(0, container.scrollHeight - viewH);
    // If already fully visible, no-op.
    if (rowTop >= curScroll && rowTop + rowH <= curScroll + viewH) return;
    var target = rowTop - viewH / 2 + rowH / 2;
    target = Math.max(0, Math.min(target, maxScroll));
    container.scrollTo({ top: target, behavior: 'smooth' });
  }

  function _plyLabel(p) {
    if (p == null) return '?';
    var num = Math.floor(p / 2) + 1;
    var color = (p % 2 === 0) ? 'W' : 'B';
    return num + '.' + color;
  }

  // =========================================================================
  // Confirm / override actions
  // =========================================================================

  function _confirmCurrentFix() {
    var v = _ensureState();
    if (!v || v.fixes.length === 0) return;

    // Promote THIS fix's ply on state.moves from 'ok' (algorithm-proposed,
    // shows the strike-through + arrow overlay) to 'fixed' (user-confirmed,
    // renders as green ✓ with the overlay removed). Moves already locked
    // stay where they were. renderVerificationMoveList re-runs the base
    // move-list renderer AND re-applies overlays for STILL-pending fixes,
    // so the newly-confirmed ply loses its strike-through (replaced by ✓)
    // while every other pending fix keeps its overlay.
    //
    // Also advance state.confirmedPly past this ply so the per-game
    // length indicator (renders "X/Y" in the game list) and resume-on-
    // re-entry walkthrough cursor know where the user actually stopped.
    // Without this update, switching to another game and back rolled the
    // walkthrough back to fix #1 (because confirmedPly=0 made the
    // resume-search find no confirmed prefix).
    var curFix = v.fixes[v.currentFixIndex];
    if (curFix && typeof state !== 'undefined' && state.moves) {
      var p = _fixPly(curFix);
      if (p != null) {
        var moveIdx = Math.floor(p / 2);
        var m = state.moves[moveIdx];
        if (m) {
          if (p % 2 === 0) {
            if (m.wStatus !== 'fixed' && m.wStatus !== 'locked') m.wStatus = 'fixed';
          } else {
            if (m.bStatus !== 'fixed' && m.bStatus !== 'locked') m.bStatus = 'fixed';
          }
          state.confirmedPly = Math.max(state.confirmedPly || 0, p + 1);
          renderVerificationMoveList();
        }
      }
    }

    if (v.currentFixIndex < v.fixes.length - 1) {
      _focusFix(v.currentFixIndex + 1);
    } else {
      _finishReview();
    }
  }

  // Replay the confirmed move prefix (state.sans[0..ply-1]) and return the
  // canonical SAN chess.js emits for `san` at that position ("Nd4" -> "Nd4+",
  // "Ra8" -> "Rxa8+"). Returns null when the prefix isn't fully available or
  // the move doesn't parse, so callers fall back to the raw text and let the
  // next revalidate canonicalize. chess.js parsed exactly this move, so the
  // move identity is preserved — only its notation (check/capture/castle
  // marks) is normalized.
  function _canonicalizeSanAtPly(ply, san) {
    if (typeof Chess === 'undefined' || !san || typeof ply !== 'number') return null;
    if (!Array.isArray(state.sans) || state.sans.length < ply) return null;
    try {
      var c = new Chess();
      for (var j = 0; j < ply; j++) {
        if (!c.move(state.sans[j], { sloppy: true })) return null;
      }
      var mv = c.move(san, { sloppy: true });
      if (!mv || !mv.san) return null;
      // Guard against a stale in-review prefix making `san` parse to a
      // DIFFERENT move (and a wrong canonical SAN): only adopt when the two
      // differ exclusively by capture 'x' and check '+'/'#'/'!'/'?' marks —
      // the same notation-only test validation.js applies. Any piece /
      // destination / disambiguation / promotion difference is rejected.
      var core = function (s) {
        var t = String(s).replace(/[+#?!]+$/, '').replace(/x/g, '');
        if (t === '0-0') t = 'O-O'; else if (t === '0-0-0') t = 'O-O-O';
        return t;
      };
      return core(mv.san) === core(san) ? mv.san : null;
    } catch (e) { return null; }
  }

  // Keep-as-is signoff inside review — the user accepted the move AS WRITTEN
  // via the yellow "✓ Keep <move>" button. Mirrors the live panel's applyFix
  // keep-as-is branch (fixes.js): promote the ply to 'locked' (not 'fixed'),
  // record it in state.lockedPlies / approvedPlies, and seed the search
  // manager's lock set so any re-launched search treats the ply as sacred.
  // A warning-type stop (bad_trade / piece_hanging / persistent_absurdity) is
  // the algorithm's terminal stuck point, so this is usually the last fix and
  // we finish; a forced-stop 'ambiguous' keep marker has the algorithm's own
  // downstream built on the same kept reading, so advancing is consistent.
  // Either way we never requeue — locking is a signoff, not an override.
  function _confirmKeepLock(keepFix) {
    var v = _ensureState();
    if (!v) return;
    var p = (typeof keepFix.ply === 'number') ? keepFix.ply : _fixPly(keepFix);
    if (p == null) p = _fixPly(v.fixes[v.currentFixIndex]);
    var keepSan = _fixSan(keepFix);
    // Canonicalize the kept SAN so a check / capture move keeps its '+'/'x'.
    // OCR (and therefore the keep candidate's text) routinely drops them:
    // "Nd4" for "Nd4+", "Ra8" for "Rxa8+". We store keepSan straight into
    // state.moves below, and that raw value can survive into a working-state
    // snapshot and the exported PGN before any canonicalizing revalidate runs
    // (revalidate's _notationOnlyCanonicalization would fix it, but a snapshot
    // restore / export can read the cell first). Stamping the canonical form
    // here closes that window. Same single-move guarantee as that helper:
    // chess.js parsed exactly this move, so only its notation changes.
    if (typeof p === 'number') {
      var _canon = _canonicalizeSanAtPly(p, keepSan);
      if (_canon) keepSan = _canon;
    }
    if (p != null && typeof state !== 'undefined' && state.moves) {
      var moveIdx = Math.floor(p / 2);
      var m = state.moves[moveIdx];
      if (m) {
        if (p % 2 === 0) {
          // Accept the move as written: stamp wOriginal if the cell currently
          // shows something else (an algorithm proposal), then write the kept
          // SAN and mark it locked.
          if (keepSan && m.white && m.white !== keepSan && !m.wOriginal) m.wOriginal = m.white;
          if (keepSan) m.white = keepSan;
          m.wStatus = 'locked';
        } else {
          if (keepSan && m.black && m.black !== keepSan && !m.bOriginal) m.bOriginal = m.black;
          if (keepSan) m.black = keepSan;
          m.bStatus = 'locked';
        }
        // Sync the board's source-of-truth with the locked move. At an
        // ambiguous (sheets-disagree) ply the algorithm may have APPLIED the
        // OTHER reading — e.g. greedy changed the merged "c5" to "Nc6" as its
        // pick-max choice — so state.sans[p] holds a DIFFERENT move than the
        // one the user is now locking via "✓ Keep". renderVerificationMoveList
        // repaints the move list from state.moves (so it shows the kept c5 🔒),
        // but the board replays state.sans, leaving it on the algorithm's Nc6.
        // Reported symptom: "movelist shows c5 locked, but the board still
        // moves Nc6." Mirror the staging-time sync in _applyPickedToState so
        // board and move list agree. Guard on p < length to avoid creating a
        // sparse hole when the board legitimately stopped before this ply (no
        // divergent move is shown there, and the exit revalidate rebuilds
        // state.sans from state.moves anyway).
        if (keepSan && Array.isArray(state.sans) &&
            p < state.sans.length && state.sans[p] !== keepSan) {
          state.sans[p] = keepSan;
          if (typeof log === 'function') {
            log('   ↳ board synced: ' + _plyLabel(p) + ' now plays ' + keepSan +
                ' (was a different algorithm reading)');
          }
        }
        state.confirmedPly = Math.max(state.confirmedPly || 0, p + 1);
        if (!state.lockedPlies) state.lockedPlies = [];
        if (state.lockedPlies.indexOf(p) === -1) state.lockedPlies.push(p);
        if (!state.approvedPlies) state.approvedPlies = [];
        if (state.approvedPlies.indexOf(p) === -1) state.approvedPlies.push(p);
        if (window.searchManager && window.searchManager.lockedPlies) {
          window.searchManager.lockedPlies.add(p);
        }
        if (typeof log === 'function') {
          log('🔒 LOCKED ' + _plyLabel(p) + ' ' + (keepSan || '') +
              ' — accepted as-is, will never be searched again');
        }
        renderVerificationMoveList();
      }
    }

    if (v.currentFixIndex < v.fixes.length - 1) {
      _focusFix(v.currentFixIndex + 1);
    } else {
      _finishReview();
    }
  }

  // All fixes confirmed — exit review, return to interactive mode at end
  // of game. In batch mode also auto-save PGN and mark game reviewed.
  function _finishReview() {
    var v = _ensureState();
    var numFixes = v ? v.fixes.length : 0;
    if (typeof log === 'function') {
      log('\u2713 All ' + numFixes + ' fix(es) reviewed \u2014 exiting review');
    }

    // Exit review → revalidate() shows "Game complete!" if all moves
    // validate, or the next stuck point if something remains. We must
    // wait for that revalidate before deciding what to do: if every fix
    // we applied happened to be from a PARTIAL reconstruction (Beam with
    // 10 fixes but game only legal up to 35.W, not 70.B), the game is
    // NOT actually complete and we must NOT mark VERIFIED.
    var done = exitVerificationMode();
    Promise.resolve(done).then(function() {
      var stuck = (typeof state !== 'undefined') ? state.stuckPly : null;
      var gameActuallyComplete = (stuck == null || stuck === undefined);

      if (typeof goToPly === 'function' && state && state.sans) {
        goToPly(state.sans.length);
      }

      if (!window.BatchGameList) return;

      if (gameActuallyComplete) {
        // All fixes applied AND the resulting game validates to the end.
        // Flip VERIFIED and kick the PGN save off in the background.
        if (typeof window.BatchGameList.markVerified === 'function') {
          try { window.BatchGameList.markVerified(); } catch (e) {}
        }
        if (typeof window.BatchGameList.saveBatchGamePgn === 'function') {
          window.BatchGameList.saveBatchGamePgn();
        }
        return;
      }

      // Reviewed fixes were correct as far as they went, but the game is
      // still stuck. Classic case: a PARTIAL reconstruction's fixes all
      // landed correctly but the algorithm never reached the end, so
      // there's still work past the fix list. DO NOT mark VERIFIED, and
      // ask the orchestrator to re-run from the new baseline so Greedy/
      // Beam/Dijkstra can take another shot with the confirmed fixes
      // locked in. The user stays in interactive mode at the fresh stuck
      // point while algorithms work in the background.
      if (typeof log === 'function') {
        log('  ⚠ Review finished but game still stuck at ply ' + stuck +
            ' — not marking VERIFIED; re-running algorithms from the ' +
            'confirmed-fix baseline.');
      }
      if (typeof window.BatchGameList.requeueAfterFix === 'function') {
        try { window.BatchGameList.requeueAfterFix(); } catch (e) {
          console.warn('[Review] requeueAfterFix failed:', e);
        }
      }
    });
  }

  // User-driven override of the algorithm's choice at `ply` (which may be
  // the current stuck ply OR an earlier ply that backtracking surfaced).
  //
  // Invalidation rule: algorithm fixes at plies >= overridePly are dropped
  // — they were computed in a timeline where the override hadn't happened,
  // so they may have been "lucky" legal pass-throughs that would now be
  // absurd. We revert those cells to OCR baseline and let the re-launched
  // search redo them with fresh absurdity detection. Plies < overridePly
  // are untouched: the user walked past them and the board state there is
  // unchanged by this override, so their algorithm fixes remain valid.
  function _requeueAndExit(ply, userSan) {
    var v = _ensureState();
    if (!v || ply == null || !userSan) return;

    v.overrides = (v.overrides || []).filter(function(o) { return o.ply !== ply; });
    v.overrides.push({ ply: ply, san: userSan });

    // Snapshot the OCR text at override ply BEFORE we overwrite it (needed
    // to stamp wOriginal on the move list so the user sees old→new).
    var ocrAtPly = _ocrTextAtPly(ply);

    // Revert plies >= overridePly to OCR baseline. Leave plies < override
    // alone — those fixes are still valid in the unchanged upstream board
    // state and were already absurdity-checked when greedy played them.
    //
    // IMPORTANT: _preReviewSans only covers plies up to the original stuck
    // point (validation.js stops pushing to state.sans at stuck_at), but
    // _preReviewMoves covers the FULL OCR move list. Iterate over state.moves
    // indices (not _preReviewSans length), and truncate state.sans at the
    // override ply — revalidate() will re-extend it by playing forward.
    if (v._preReviewMoves) {
      var startMi = Math.floor(ply / 2);
      var startSide = ply % 2;  // 0 = revert both white+black of startMi, 1 = only black
      for (var mi = startMi; mi < state.moves.length; mi++) {
        var preEntry = v._preReviewMoves[mi];
        if (!preEntry) {
          // Greedy extended the move list past OCR — truncate the tail.
          state.moves.length = mi;
          break;
        }
        if (!state.moves[mi]) continue;
        // Revert white (unless we're mid-move and white is already upstream).
        if (!(mi === startMi && startSide === 1)) {
          state.moves[mi].white = preEntry.white || '';
          state.moves[mi].wStatus = preEntry.wStatus || 'ok';
          state.moves[mi].wOriginal = preEntry.wOriginal || null;
          if (preEntry.wAlts) state.moves[mi].wAlts = preEntry.wAlts;
          if (preEntry.wLenientAlts) state.moves[mi].wLenientAlts = preEntry.wLenientAlts;
          if (typeof preEntry.wConf === 'number') state.moves[mi].wConf = preEntry.wConf;
        }
        // Revert black.
        state.moves[mi].black = preEntry.black || '';
        state.moves[mi].bStatus = preEntry.bStatus || 'ok';
        state.moves[mi].bOriginal = preEntry.bOriginal || null;
        if (preEntry.bAlts) state.moves[mi].bAlts = preEntry.bAlts;
        if (preEntry.bLenientAlts) state.moves[mi].bLenientAlts = preEntry.bLenientAlts;
        if (typeof preEntry.bConf === 'number') state.moves[mi].bConf = preEntry.bConf;
      }
      // Truncate sans at override — revalidate() will re-play legal upstream
      // moves and re-derive the new stuck point from the reverted tail.
      if (state.sans.length > ply) state.sans.length = ply;
    }

    // Apply user overrides on top. Earlier overrides (< ply) were already
    // baked into state.moves; re-applying is a no-op for those but ensures
    // any override ply >= ply in the reverted range is restored.
    var applyOverride = function(o) {
      if (o.ply == null) return;
      state.sans[o.ply] = o.san;
      var mi = Math.floor(o.ply / 2);
      if (!state.moves[mi]) {
        state.moves[mi] = {
          num: mi + 1, white: '', black: '',
          wStatus: 'pending', bStatus: 'pending'
        };
      }
      if (o.ply % 2 === 0) {
        if (state.moves[mi].white && state.moves[mi].white !== o.san &&
            !state.moves[mi].wOriginal) {
          state.moves[mi].wOriginal = state.moves[mi].white;
        }
        state.moves[mi].white = o.san;
        state.moves[mi].wStatus = 'fixed';
      } else {
        if (state.moves[mi].black && state.moves[mi].black !== o.san &&
            !state.moves[mi].bOriginal) {
          state.moves[mi].bOriginal = state.moves[mi].black;
        }
        state.moves[mi].black = o.san;
        state.moves[mi].bStatus = 'fixed';
      }
    };
    (v.overrides || []).forEach(applyOverride);

    // Remember ALL fix plies that should keep their checkmarks after
    // revalidate() rebuilds state.moves. Sources (in priority order):
    //  1. user overrides (explicit picks)
    //  2. current greedy/algorithm fixes at plies < override
    //  3. earlier-cycle fixes already baked into state.moves (wStatus/bStatus
    //     === 'fixed' with wOriginal/bOriginal set) — these survive in
    //     state.moves from prior review cycles but aren't in v.fixes.
    var stampList = (v.overrides || []).map(function(o) {
      return { ply: o.ply, san: o.san, ocr: o.ply === ply ? ocrAtPly : _ocrTextAtPly(o.ply) };
    });
    function addIfNew(fp, fSan, fOcr) {
      if (fp == null || fp >= ply) return;
      if (!fSan || fSan === fOcr) return;
      if (stampList.some(function(s) { return s.ply === fp; })) return;
      stampList.push({ ply: fp, san: fSan, ocr: fOcr });
    }
    (v.fixes || []).forEach(function(f) {
      addIfNew(_fixPly(f), _fixSan(f), f.ocr || '');
    });
    // Harvest fixes from earlier cycles that are in state.moves but not
    // in v.fixes (e.g. first greedy run fixed 7.W, second run doesn't
    // list it because it was already baked in as a legal SAN).
    if (state.moves) {
      var maxMi = Math.floor(ply / 2);
      for (var mi = 0; mi < maxMi && mi < state.moves.length; mi++) {
        var m = state.moves[mi];
        if (m.wStatus === 'fixed' && m.wOriginal) {
          addIfNew(mi * 2, m.white, m.wOriginal);
        }
        if (m.bStatus === 'fixed' && m.bOriginal) {
          addIfNew(mi * 2 + 1, m.black, m.bOriginal);
        }
      }
    }
    state._userOverridePlies = stampList;

    // Lock only plies that have been user-confirmed (wStatus=fixed/locked)
    // OR explicit overrides (including the current one). Do NOT lock every
    // ply 0..override wholesale — plies the user walked past without
    // confirming may carry raw OCR that is LEGAL in the pre-override
    // timeline but ILLEGAL once an override changes upstream board state,
    // and locking them means algorithms can never fix those cascading
    // illegalities.
    // User-reported symptom: override at 30.W → Greedy stuck at 21.B
    // (raw OCR became illegal after upstream fixes) → 21.B is in the
    // blanket-locked range so Greedy cannot propose a fix there →
    // PARTIAL with zero new fixes.
    state.lockedPlies = [];
    if (Array.isArray(state.moves)) {
      state.moves.forEach(function(m) {
        if (!m) return;
        var wp = (m.num - 1) * 2;
        var bp = wp + 1;
        if (m.wStatus === 'fixed' || m.wStatus === 'locked') {
          if (state.lockedPlies.indexOf(wp) === -1) state.lockedPlies.push(wp);
        }
        if (m.bStatus === 'fixed' || m.bStatus === 'locked') {
          if (state.lockedPlies.indexOf(bp) === -1) state.lockedPlies.push(bp);
        }
      });
    }
    // Every explicit override is also locked — by definition the user
    // picked that SAN and does not want the search to revise it.
    (v.overrides || []).forEach(function(o) {
      if (o.ply != null && state.lockedPlies.indexOf(o.ply) === -1) {
        state.lockedPlies.push(o.ply);
      }
    });
    // Always include the current override ply.
    if (state.lockedPlies.indexOf(ply) === -1) state.lockedPlies.push(ply);

    // Seed search-manager's lockedPlies set (interactive path reads this,
    // not state.lockedPlies) so the worker respects locks on re-launch.
    if (window.searchManager && window.searchManager.lockedPlies) {
      window.searchManager.lockedPlies.clear();
      state.lockedPlies.forEach(function(p) {
        window.searchManager.lockedPlies.add(p);
      });
    }

    // Kill stale search results: Apply/Review buttons for greedy/beam/
    // dijkstra in the search-panel otherwise still reflect the OLD
    // (pre-override) timeline.
    _invalidateSearchCaches();

    var rq = (window.BatchGameList && window.BatchGameList.batchState &&
              window.BatchGameList.batchState.reconstructQueue) || null;
    // Ownership guard: ocrMoves is built from the global `state`, which
    // mirrors the currently-loaded game. Requeue feeds it into v.gameId's
    // orchestrator slot — only valid when verification is still pointed at
    // the loaded game. If they've drifted (stale verify state after a
    // switch), requeuing would inject the loaded game's moves into a
    // different game's reconstruction. Skip rather than cross-contaminate.
    var _curGameId = (window.BatchGameList && window.BatchGameList.batchState &&
                      window.BatchGameList.batchState.currentGameId) || null;
    if (rq && _curGameId && v.gameId && v.gameId !== _curGameId) {
      if (typeof log === 'function') {
        log('  ⚠ skipping requeue — verify game ' + v.gameId +
            ' ≠ loaded game ' + _curGameId);
      }
      rq = null;
    }
    if (rq && typeof rq.requeue === 'function' && v.gameId) {
      var ocrMoves = _buildOcrMovesWithOverrides(v.overrides);
      // fromPly reflects the user's actual review frontier, not the
      // override ply. If the user only walked through 16.W before
      // overriding at 30.W, state.confirmedPly=31 (16.W+1), not 59.
      // Plies 31..57 may carry raw OCR that is legal in isolation but
      // becomes illegal once upstream fixes change the board — those
      // need to stay fixable, which requires fromPly < their ply.
      // lockedPlies separately protects user-confirmed/overridden plies
      // (only the plies user actually signed off on) so the search
      // cannot touch those.
      var _fromPly = (typeof state.confirmedPly === 'number' && state.confirmedPly >= 0)
        ? state.confirmedPly : 0;
      rq.requeue(v.gameId, ocrMoves, state.lockedPlies.slice(), _fromPly);
      // _invalidateSearchCaches above wrote "Superseded" into the panels and
      // cleared the cached result globals. The orchestrator just cleared its
      // per-game aggregate too, so re-bind now to render from the fresh
      // (empty) state — otherwise the three panels sit on "Superseded" until
      // greedy's first step comes in, and beam/dijkstra stay stale forever
      // if greedy resolves the game.
      if (window.BatchPanelBridge) {
        try { window.BatchPanelBridge.bindGame(v.gameId); } catch (e) {}
      }
      if (typeof log === 'function') {
        log('\uD83D\uDD04 Override ' + _plyLabel(ply) + ' \u2192 ' + userSan +
            ' \u2014 requeued from ply ' + ply);
      }
    } else {
      // Interactive mode: no batch queue, but we can still kick off a
      // fresh greedy/beam/dijkstra against the rolled-back baseline.
      if (typeof log === 'function') {
        log('\u270F\uFE0F Override ' + _plyLabel(ply) + ' \u2192 ' + userSan +
            ' \u2014 rerunning search');
      }
    }

    // Exit review; this calls revalidate() which finds the new stuck
    // point in the rolled-back timeline and repaints the movelist. The
    // returned promise resolves once revalidate is done, so we can
    // re-stamp override plies AFTER revalidate has overwritten state.moves.
    var done = exitVerificationMode();
    Promise.resolve(done).then(function() {
      _stampOverridesOnMoves();
      if (typeof renderMoveList === 'function') renderMoveList();
      // Keep the move list centered on the new stuck point — renderMoveList
      // rebuilds the DOM from scratch and leaves the scroll container at the
      // top otherwise, which is disorienting after a doubleclick-override.
      // Scroll ONLY the inner move-list container via _scrollMoveIntoView —
      // NOT row.scrollIntoView. scrollIntoView bubbles up and scrolls the
      // WINDOW too (see the warning at _scrollMoveIntoView), and because it
      // ran with behavior:'smooth' it animated the whole page AFTER revalidate
      // had already pinned the panels to the top — that was the small up/down
      // jump the user saw when confirming via double-click on a suggestion or
      // "keep as is" (both route through this override/requeue exit).
      var newStuck = (typeof state !== 'undefined') ? state.stuckPly : null;
      if (newStuck != null) {
        _scrollMoveIntoView(newStuck);
      }
      if (!rq && typeof launchBackgroundSearches === 'function') {
        try { launchBackgroundSearches(); } catch (e) { /* non-fatal */ }
      }
    });
  }

  // Clear cached search results + hide Apply/Review buttons in the search
  // panels. Called when the user diverges from an algorithm's solution so
  // the stale result can't be accidentally reapplied.
  function _invalidateSearchCaches() {
    // beam.js declares these as top-level `var` so they're also on window.
    window.greedyResult = null;
    window.beamResult = null;
    window.dijkstraResult = null;
    ['greedy', 'beam', 'dijkstra'].forEach(function(panel) {
      if (typeof showReviewButton === 'function') {
        try { showReviewButton(panel, false); } catch (e) {}
      }
      var logEl = document.getElementById(panel + '-log');
      if (logEl) logEl.innerHTML = '';
      var statusEl = document.getElementById(panel + '-status');
      if (statusEl) statusEl.textContent = 'Superseded';
      var barEl = document.getElementById(panel + '-progress-bar');
      if (barEl) barEl.style.width = '0%';
    });
  }

  // Re-stamp override plies as wStatus='fixed' (+ wOriginal) after
  // revalidate() overwrites our annotations. Called after exitVerificationMode.
  function _stampOverridesOnMoves() {
    var list = state._userOverridePlies;
    if (!list || list.length === 0) return;
    list.forEach(function(o) {
      if (o.ply == null) return;
      var mi = Math.floor(o.ply / 2);
      if (!state.moves[mi]) return;
      if (o.ply % 2 === 0) {
        state.moves[mi].wStatus = 'fixed';
        if (o.ocr && o.ocr !== o.san) state.moves[mi].wOriginal = o.ocr;
      } else {
        state.moves[mi].bStatus = 'fixed';
        if (o.ocr && o.ocr !== o.san) state.moves[mi].bOriginal = o.ocr;
      }
    });
  }

  /**
   * Merge user overrides into the OCR move list so the requeued
   * reconstruction sees them. Returns a plain array of OCR cells as the
   * reconstruction queue's _prepareOcrInput expects.
   */
  function _buildOcrMovesWithOverrides(overrides) {
    var v = _ensureState();
    if (!v || !v.ocrResult) return [];

    // Re-run the merge path if dual-sheet so we get a single merged list,
    // then splice in each override. MergeSheets is idempotent on already-
    // merged input so this works either way.
    //
    // Dual-sheet: prefer the LIVE per-sheet arrays (state.ocrCellsSheet1/2)
    // over v.ocrResult.sheet1/2. v.ocrResult was captured at Review entry
    // and points at batchState.ocrResults[gameId]'s pristine pre-NW
    // snapshot; if the user applied an NW alignment fix between Review
    // entry and override (e.g., a 4-ply insert that backfills placeholders
    // from the other sheet), the pristine arrays don't see those edits and
    // re-merging them produces the wrong baseline. State.ocrCellsSheet1/2
    // is the live data the alignment code mutates in-place. Per-sheet
    // cells keep raw OCR in .move (corrections go to _correctedMove via
    // syncCorrectionsToOcrCells), so this baseline doesn't feed algorithm
    // corrections back into Greedy.
    var merged;
    if (v.ocrResult.isDualSheet && window.MergeSheets) {
      var _s1 = (typeof state !== 'undefined' && state.ocrCellsSheet1 &&
                 state.ocrCellsSheet1.length > 0)
        ? state.ocrCellsSheet1 : (v.ocrResult.sheet1 || []);
      var _s2 = (typeof state !== 'undefined' && state.ocrCellsSheet2 &&
                 state.ocrCellsSheet2.length > 0)
        ? state.ocrCellsSheet2 : (v.ocrResult.sheet2 || []);
      merged = window.MergeSheets.mergeSheets(_s1, _s2) || [];
    } else {
      merged = (v.ocrResult.ocrCells || []).slice();
    }

    function _splice(moveNum, color, san, tag) {
      for (var i = 0; i < merged.length; i++) {
        var c = merged[i];
        if (c && c.num === moveNum &&
            (c.color === color || c.color === color.toUpperCase())) {
          var patch = { move: san, confidence: 1.0, alternatives: [] };
          patch[tag] = true;
          merged[i] = Object.assign({}, c, patch);
          return true;
        }
      }
      return false;
    }

    // Bake in every fix the user has walked past in review (state.moves
    // carries wStatus='fixed' / bStatus='fixed' with wOriginal/bOriginal
    // holding the raw OCR). Also include algorithm-proposed picks the
    // user hasn't explicitly confirmed yet (wAlgoProposed=true) — if
    // they're walking through a partial and override mid-stream, the
    // already-applied upstream algo SANs are the baseline the override
    // was computed against, so a rerun must honour them too. Otherwise
    // the requeue feeds Greedy raw OCR at plies the user tacitly
    // accepted, Greedy hits them as illegal, and stops before reaching
    // the real override frontier (reported: override at 25.W, Greedy
    // stuck at 24.W because 24.W's confirmed algo fix wasn't carried
    // into the merged OCR).
    // User overrides applied below trump everything.
    var _diagSpliced = 0, _diagMissed = 0;
    if (typeof state !== 'undefined' && Array.isArray(state.moves)) {
      for (var mi = 0; mi < state.moves.length; mi++) {
        var sm = state.moves[mi];
        if (!sm) continue;
        // Accept any cell whose current SAN differs from the original OCR,
        // regardless of which path put it there. Covers:
        //   - user-confirmed (wStatus=fixed/locked)
        //   - algorithm-proposed (wAlgoProposed=true)
        //   - validate_moves similarity swap / OCR-alt (just wOriginal set)
        // The broader condition is important: validate_moves corrections
        // produce the right SAN but never set wStatus='fixed', so the
        // narrower check was missing them and the merged baseline kept
        // pristine raw OCR at those plies.
        var wAccept = sm.white && (
          sm.wStatus === 'fixed' || sm.wStatus === 'locked' ||
          (sm.wOriginal && sm.white !== sm.wOriginal) ||
          !!sm.wAlgoProposed
        );
        var bAccept = sm.black && (
          sm.bStatus === 'fixed' || sm.bStatus === 'locked' ||
          (sm.bOriginal && sm.black !== sm.bOriginal) ||
          !!sm.bAlgoProposed
        );
        if (wAccept) {
          if (_splice(sm.num, 'w', sm.white, '_userAccepted')) _diagSpliced++;
          else _diagMissed++;
        }
        if (bAccept) {
          if (_splice(sm.num, 'b', sm.black, '_userAccepted')) _diagSpliced++;
          else _diagMissed++;
        }
      }
    }
    if (typeof log === 'function') {
      var _gid = (window.BatchGameList && window.BatchGameList.batchState &&
                  window.BatchGameList.batchState.currentGameId) || '?';
      if (_diagSpliced > 0 || _diagMissed > 0) {
        log('  🔨 [' + _gid + '] review requeue baseline: ' + _diagSpliced +
            ' confirmed/algo fix(es) spliced into merged OCR' +
            (_diagMissed > 0 ? ' (' + _diagMissed + ' missed — no matching cell)' : ''));
      } else {
        log('  🔨 [' + _gid + '] review requeue baseline: NOTHING spliced');
      }
    }

    (overrides || []).forEach(function(o) {
      var ply = o.ply, userSan = o.san;
      var moveNum = Math.floor(ply / 2) + 1;
      var color = (ply % 2 === 0) ? 'w' : 'b';
      if (!_splice(moveNum, color, userSan, '_userOverride')) {
        merged.push({
          num: moveNum, color: color, move: userSan,
          confidence: 1.0, alternatives: [], _userOverride: true
        });
      }
    });
    return merged;
  }

  // Save button — overrides now exit + requeue immediately at the moment
  // the user applies them, so by the time we reach Save there are no
  // pending overrides; just write the PGN and exit.
  function _confirmAndSave() {
    if (window.BatchGameList && typeof window.BatchGameList.saveBatchGamePgn === 'function') {
      window.BatchGameList.saveBatchGamePgn();
    } else if (typeof downloadPGN === 'function') {
      downloadPGN();
    }
    exitVerificationMode();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    FIX_COLORS: FIX_COLORS,
    enterVerificationMode: enterVerificationMode,
    exitVerificationMode: exitVerificationMode,
    isActive: isActive,
    renderVerificationMoveList: renderVerificationMoveList,
    scrollPanelsToTop: _scrollPanelsToTop
  };
})();

// Expose globally (consistent with other batch-mode modules).
window.VerificationUI = VerificationUI;
