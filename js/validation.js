// =============================================================================
// VALIDATION - Move validation, fix finding, revalidation
// =============================================================================
// Pure client-side using Pyodide. NO FLASK FALLBACK.

// A move whose top OCR confidence is below this floor is treated as a
// forced-stop ply: validate_moves stops there for mandatory user review, the
// same mechanism as a dual-sheet near-tie disagreement. This catches the
// "very low probability" single readings that today only get a red % badge and
// otherwise play straight through if legal. Exposed on window so the move-list
// renderer (ui.js forcedStopInd) shows the 🔍 badge at the same threshold.
// TUNABLE: raise to review more aggressively, lower to reduce stops. Kept
// below the 0.7 red-confidence band so only weak reads force a stop. Set to
// 0.50 (Jun 2026) so coin-flip reads like 7.B f5 @43% force a review.
var FORCED_STOP_MIN_CONFIDENCE = 0.50;
if (typeof window !== 'undefined') window.FORCED_STOP_MIN_CONFIDENCE = FORCED_STOP_MIN_CONFIDENCE;

// Ply indices flagged as dual-sheet ambiguous (near-tie disagreement). Single
// source for the forced-stop readers (validate builders + the 🔍 badge).
//
// DERIVED FROM state.ocrCells (the merged cells' own _ambiguous flag) on every
// call — NOT from the state.ambiguousPlies cache. ocrCells is the merged
// ground truth kept fresh in every path: interactive merge, batch fresh load +
// restore, re-merge after edits, and single-move splice+renumber (the flag
// travels with each cell object). It's the same array the tier dots read, so
// this is correct wherever the dots are. The state.ambiguousPlies index set is
// NOT reset on batch game load, so consulting it risked a stale carry-over from
// a prior interactive game; deriving here sidesteps that entirely.
// (state.ambiguousPlies is now a vestigial cache — left in place, not read.)
function getAmbiguousPlies() {
  var out = [];
  if (Array.isArray(state.ocrCells)) {
    // Plies the user has already RESOLVED (picked an alternative / kept / locked
    // / overrode) are no longer ambiguous. Excluding them stops the re-flag
    // ping-pong: without this, after the user picks c3 at an ambiguous 4.W the
    // cell still carries _ambiguous, so validate re-stops there and the fix
    // finder proposes the OTHER reading (Nc3) — visibly "undoing" the pick.
    // Mirrors classifyTiers' currentMovesMap carve-out. Derived from the
    // resolution arrays (reset on game load, so not stale like ambiguousPlies).
    var resolved = {};
    [state.approvedPlies, state.lockedPlies, state.fixedPlies].forEach(function(arr) {
      if (Array.isArray(arr)) arr.forEach(function(p) { resolved[p] = true; });
    });
    state.ocrCells.forEach(function(c) {
      if (!c || !c._ambiguous) return;
      var ply = (c.num - 1) * 2 + (c.color === 'w' ? 0 : 1);
      if (resolved[ply]) return;
      // Also treat a fixed/locked MOVE STATUS as resolved: confirming a fix in
      // review (_confirmCurrentFix) flips wStatus/bStatus to 'fixed' without
      // always touching the arrays above, so the status is the robust signal
      // that the user has settled this ply.
      var mv = Array.isArray(state.moves) ? state.moves[c.num - 1] : null;
      var st = mv ? (c.color === 'w' ? mv.wStatus : mv.bStatus) : null;
      if (st === 'fixed' || st === 'locked') return;
      out.push(ply);
    });
  }
  return out;
}
if (typeof window !== 'undefined') window.getAmbiguousPlies = getAmbiguousPlies;

// A locked/fixed ply preserves the user's chosen MOVE, but its stored SAN must
// still be one the board renderer (chess.js v0.12.0, strict) can replay. OCR
// routinely drops the capture 'x' (e.g. "Ra8" for a rook capture whose
// canonical SAN is "Rxa8+") or the check '+'. python-chess accepts those
// non-canonical forms; chess.js does NOT — so the raw text freezes the board
// at that ply while the move list shows the move green ("board stuck, movelist
// continues"). The validator returns the canonical SAN (board.san) for the
// ply; adopt it for a locked/fixed ply ONLY when it is the SAME move written
// canonically — i.e. the two SANs differ exclusively by capture 'x' and check
// '+'/'#'/'!'/'?' marks. Any difference in piece, destination, promotion, or
// disambiguation means a semantic correction (e.g. the lock-preserving
// "keep Qd2, not Qe2" case, or Nbd7 vs Nfd7) and MUST be left to the lock.
function _sanCore(san){
  if(!san) return null;
  var s=String(san).replace(/[+#?!]+$/,'').replace(/x/g,'');
  if(s==='0-0') s='O-O'; else if(s==='0-0-0') s='O-O-O';
  return s;
}
function _notationOnlyCanonicalization(raw, canon){
  if(!canon||!raw||canon===raw) return false;
  var rc=_sanCore(raw), cc=_sanCore(canon);
  return rc!==null && rc===cc;
}

// Helper function to call validate API (Pyodide only - NO FLASK)
async function callValidateAPI(flat, ocrData, autoFixSettings, approvedPlies, startPly = 0) {
  if (!window.zugwise || !window.zugwise.isReady) {
    throw new Error('Pyodide not ready - please wait for initialization');
  }
  var result = await window.zugwise.validate(flat, ocrData, autoFixSettings, approvedPlies, startPly);
  return result;
}

// Helper function to call find-fixes API (Pyodide only - NO FLASK)
async function callFindFixesAPI(flat, stuckPly, confirmedPly, ocrData, autoFixSettings, fixedPlies, lockedPlies) {
  if (!window.zugwise || !window.zugwise.isReady) {
    throw new Error('Pyodide not ready - please wait for initialization');
  }
  // Pass confirmedPly as min_ply (soft boundary - backend will expand if needed)
  // Pass fixedPlies to prevent undoing recent fixes
  // Pass lockedPlies to permanently exclude plies from all search phases
  // Pass phase2_depth from settings (how far before frontier to search)
  var phase2Depth = autoFixSettings?.deep_search_depth ?? currentSettings?.deep_search_depth ?? 5;
  var result = await window.zugwise.findFixes(flat, stuckPly, ocrData, confirmedPly, fixedPlies || [], phase2Depth, lockedPlies || []);
  return result;
}

// Snapshot the batch gameId at function entry so a mid-call game switch
// (user clicks a different game in the sidebar while we're awaiting
// callValidateAPI) can be detected after the await. Returns null outside
// batch mode (no guard) or the gameId to expect when the await resolves.
// Callers MAY pass opts.expectedGameId to pin against a gameId captured
// earlier (e.g. ocr.js's noise-review onContinue captures it at button
// click time and forwards it through here).
function _captureBatchGuard(opts) {
  if (opts && opts.skipGameGuard) return null;
  if (!window.BatchGameList || !window.BatchGameList.batchState ||
      !window.BatchGameList.batchState.active) {
    return null;
  }
  return (opts && opts.expectedGameId) ||
         window.BatchGameList.batchState.currentGameId ||
         null;
}

// True if the batch gameId has changed since _captureBatchGuard. Callers
// use this after every await that yields to the event loop, BEFORE
// mutating state.moves / state.sans / etc — those slots belong to whichever
// game is active NOW, and overwriting them with the pre-switch game's
// results corrupts the displayed game. Reported user symptom: "Both games
// claim to have the same movelist" — B2's validateAndDisplay resolved
// while user was on B4 and B4's state.moves got overwritten with B2's
// validated paired list.
function _batchGuardChanged(guardId) {
  if (!guardId) return false;
  if (!window.BatchGameList || !window.BatchGameList.batchState ||
      !window.BatchGameList.batchState.active) {
    return false;  // batch deactivated — don't strand the call
  }
  return window.BatchGameList.batchState.currentGameId !== guardId;
}

async function validateAndDisplay(paired,filename,opts){
  var _batchGuard = _captureBatchGuard(opts);
  var flat=[];var ocrData=[];
  // Dual-sheet forced-stop plies (merge flagged a near-tie disagreement). Stamp
  // forced_stop per ply so validate_moves stops there for user resolution.
  var _ambigPlies = getAmbiguousPlies();
  paired.forEach(function(m){
    if(m.white){
      flat.push(m.white);
      var alts=[];
      if(m.wAlts&&m.wAlts.length>0){m.wAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});}
      var lenientAlts=[];
      if(m.wLenientAlts&&m.wLenientAlts.length>0){m.wLenientAlts.forEach(function(a){lenientAlts.push({move:a.move||a,confidence:a.confidence||0.1});});}
      ocrData.push({move:m.white,confidence:m.wConf||0.9,alternatives:alts,lenientAlternatives:lenientAlts,forced_stop:(_ambigPlies.indexOf((m.num-1)*2)>=0)||((m.wConf||0.9)<FORCED_STOP_MIN_CONFIDENCE)});
    }
    if(m.black){
      flat.push(m.black);
      var alts=[];
      if(m.bAlts&&m.bAlts.length>0){m.bAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});}
      var lenientAlts=[];
      if(m.bLenientAlts&&m.bLenientAlts.length>0){m.bLenientAlts.forEach(function(a){lenientAlts.push({move:a.move||a,confidence:a.confidence||0.1});});}
      ocrData.push({move:m.black,confidence:m.bConf||0.9,alternatives:alts,lenientAlternatives:lenientAlts,forced_stop:(_ambigPlies.indexOf((m.num-1)*2+1)>=0)||((m.bConf||0.9)<FORCED_STOP_MIN_CONFIDENCE)});
    }
  });
  // Debug: count lenient alternatives in OCR data
  var lenientTotal = ocrData.reduce(function(sum, d) { return sum + (d.lenientAlternatives ? d.lenientAlternatives.length : 0); }, 0);
  if (lenientTotal > 0) console.log('[LENIENT] ' + lenientTotal + ' lenient alternatives across ' + ocrData.length + ' plies');
  log('🔍 Validating '+flat.length+' moves...');
  state.confirmedPly=0; // Reset confirmed ply for new game
  state.fixedPlies=[]; // Reset fixed plies for new game
  state.approvedPlies=[]; // Reset approved plies for new game
  // Restore merge-locked plies if dual-sheet mode set them before calling us
  if (state._pendingMergeLockedPlies && state._pendingMergeLockedPlies.length > 0) {
    state.lockedPlies = state._pendingMergeLockedPlies.slice();
    state._pendingMergeLockedPlies = null;
    log('🔒 Restored ' + state.lockedPlies.length + ' merge-locked plies');
  } else {
    state.lockedPlies=[]; // Reset locked plies for new game
  }
  // Restore PGN-batch snapshot's lock/fix/confirm state if a snapshot just
  // ran _loadGame. Without this, switching games and back loses every
  // "keep-as-is" the user applied (the validator's auto-fix overrides them
  // when it sees the illegal raw SAN like Qd2).
  if (state._pendingPgnLockedPlies && state._pendingPgnLockedPlies.length > 0) {
    state.lockedPlies = state._pendingPgnLockedPlies.slice();
    state._pendingPgnLockedPlies = null;
  }
  if (state._pendingPgnFixedPlies && state._pendingPgnFixedPlies.length > 0) {
    state.fixedPlies = state._pendingPgnFixedPlies.slice();
    state._pendingPgnFixedPlies = null;
  }
  if (state._pendingPgnApprovedPlies && state._pendingPgnApprovedPlies.length > 0) {
    state.approvedPlies = state._pendingPgnApprovedPlies.slice();
    state._pendingPgnApprovedPlies = null;
  }
  if (typeof state._pendingPgnConfirmedPly === 'number') {
    state.confirmedPly = state._pendingPgnConfirmedPly;
    state._pendingPgnConfirmedPly = null;
  }

  try{
    // Pass approvedPlies into the validator so EAD checks (bad-trade,
    // piece-hanging, persistent-absurdity) skip plies the user has
    // signed off on. Without this, switching back to a game whose
    // locked "bad trade" was previously accepted re-fires the warning
    // banner because the initial-validate call was passing null.
    var val=await callValidateAPI(flat, ocrData, getAutoFixSettings(),
                                  state.approvedPlies || null);
    // If the user switched games while we were awaiting Pyodide, bail out
    // BEFORE clobbering state.moves/state.sans — those slots belong to a
    // different game now. The new game's selectGame → processAllSheets path
    // will run its own validate. See _batchGuardChanged docstring above.
    if (_batchGuardChanged(_batchGuard)) {
      log('🔇 validateAndDisplay aborted — game switched from ' + _batchGuard +
          ' to ' + (window.BatchGameList && window.BatchGameList.batchState &&
                    window.BatchGameList.batchState.currentGameId) +
          ' mid-await; not mutating state');
      return;
    }
    state.moves=[];state.sans=[];var ply=0;
    // Debug: Log validation result including infer_error
    if(val.infer_error) console.log('DEBUG: infer_error =', val.infer_error);
    console.log('DEBUG: stuck_from_square =', val.stuck_from_square, 'stuck_to_square =', val.stuck_to_square);
    // Build lookup from ply to corrected SAN and OCR alt info
    var correctedSans={};
    var ocrAltInfo={};
    console.log('DEBUG: val.moves length =', val.moves ? val.moves.length : 'undefined');
    if(val.moves){
      val.moves.forEach(function(vm){
        correctedSans[vm.ply]=vm.san;
        if(vm.ocr_alt_applied){
          ocrAltInfo[vm.ply]={confidence:vm.ocr_alt_confidence,count:vm.ocr_alt_count};
        }
        if(vm.original) console.log('DEBUG: Correction at ply '+vm.ply+': '+vm.original+' -> '+vm.san+(vm.ocr_alt_applied?' (OCR alt)':''));
      });
    }

    // Track current ply for corrections
    var currentPlyInLoop=0;

    paired.forEach(function(m){
      // Use corrected SANs from validation response if available — but
      // never override a user-confirmed 'locked'/'fixed' move on the input
      // paired array (this fires for PGN-batch snapshot restore: the user
      // pressed "keep Qd2 as-is" earlier, so Qd2 must survive even though
      // the validator's auto-fix would correct it to Qe2).
      var wPly=currentPlyInLoop;
      var bPly=currentPlyInLoop+(m.white?1:0);
      var wPreserve=(m.wStatus==='locked'||m.wStatus==='fixed');
      var bPreserve=(m.bStatus==='locked'||m.bStatus==='fixed');
      // Even a preserved (locked/fixed) ply adopts the validator's canonical SAN
      // when it's the SAME move written canonically (raw "Ra8" → "Rxa8+").
      // Otherwise the non-canonical text freezes the board renderer while the
      // move list shows it green. Semantic differences are still preserved.
      var wNotationOnly=wPreserve&&_notationOnlyCanonicalization(m.white,correctedSans[wPly]);
      var bNotationOnly=bPreserve&&_notationOnlyCanonicalization(m.black,correctedSans[bPly]);
      var wSan=wPreserve?(wNotationOnly?correctedSans[wPly]:m.white):(correctedSans[wPly]||m.white);
      var bSan=bPreserve?(bNotationOnly?correctedSans[bPly]:m.black):(correctedSans[bPly]||m.black);
      // Store originals and log auto-corrections. A notation-only
      // canonicalization of a locked/fixed move is not a user-visible
      // correction (same move) — don't flash it or set wOriginal.
      var wOrig=(m.white&&wSan!==m.white&&!wNotationOnly)?m.white:null;
      var bOrig=(m.black&&bSan!==m.black&&!bNotationOnly)?m.black:null;
      // Check if OCR alternative was applied
      var wOcrAlt=ocrAltInfo[wPly];
      var bOcrAlt=ocrAltInfo[bPly];
      // Show auto-fix flash notifications (popup only, no board animation)
      if(wOrig){
        if(wOcrAlt){
          log('🔄 OCR-ALT '+m.num+'.W: "'+wOrig+'" illegal, applied OCR candidate: "'+wSan+'" ('+(wOcrAlt.confidence*100).toFixed(0)+'%)');
          showAutoFixFlash(wOrig,wSan,0,'OCR candidate');
        }else{
          log('Quick fix '+m.num+'.W: '+wOrig+' -> '+wSan);
          showAutoFixFlash(wOrig,wSan);
        }
      }
      if(bOrig){
        if(bOcrAlt){
          log('🔄 OCR-ALT '+m.num+'.B: "'+bOrig+'" illegal, applied OCR candidate: "'+bSan+'" ('+(bOcrAlt.confidence*100).toFixed(0)+'%)');
          showAutoFixFlash(bOrig,bSan,0,'OCR candidate');
        }else{
          log('Quick fix '+m.num+'.B: '+bOrig+' -> '+bSan);
          showAutoFixFlash(bOrig,bSan);
        }
      }
      // Preserve carried-over wOriginal/bOriginal for locked/fixed plies —
      // the snapshot's original-OCR memory shouldn't be wiped on restore.
      var carryWOriginal = wPreserve ? (m.wOriginal || null) : wOrig;
      var carryBOriginal = bPreserve ? (m.bOriginal || null) : bOrig;
      var entry={num:m.num,white:wSan,black:bSan,wConf:m.wConf,bConf:m.bConf,wAlts:m.wAlts,bAlts:m.bAlts,wStatus:wPreserve?m.wStatus:'ok',bStatus:bPreserve?m.bStatus:'ok',wOriginal:carryWOriginal,bOriginal:carryBOriginal,wOcrAlt:wPreserve?!!m.wOcrAlt:!!wOcrAlt,bOcrAlt:bPreserve?!!m.bOcrAlt:!!bOcrAlt};
      // sans push + stuck_at status flip: don't override 'locked'/'fixed'
      // status, just decide sans inclusion based on val.stuck_at like before.
      if(m.white){
        if(val.stuck_at===currentPlyInLoop){if(!wPreserve)entry.wStatus='error';}
        else if(val.stuck_at!==null&&currentPlyInLoop>val.stuck_at){if(!wPreserve)entry.wStatus='pending';}
        else state.sans.push(wSan);
        currentPlyInLoop++;
      }
      if(m.black){
        if(val.stuck_at===currentPlyInLoop){if(!bPreserve)entry.bStatus='error';}
        else if(val.stuck_at!==null&&currentPlyInLoop>val.stuck_at){if(!bPreserve)entry.bStatus='pending';}
        else if(entry.wStatus==='ok'||entry.wStatus==='locked'||entry.wStatus==='fixed') state.sans.push(bSan);
        currentPlyInLoop++;
      }
      state.moves.push(entry);
    });
    // Reconstruct lockedPlies/fixedPlies from the preserved cell statuses.
    // The loop above carries 'locked'/'fixed' wStatus/bStatus over from the
    // input `paired` array (wPreserve/bPreserve), so the 🔒/✓ icons render —
    // but state.lockedPlies was reset to [] above (only restored when a
    // pending merge/PGN snapshot exists). Without this, a move shows 🔒 yet
    // fetchFixes() passes an empty locked set, so live backtracking proposes
    // changing a locked move (e.g. "12.W Ng5 → Ng1") — exactly what the
    // search algorithms already refuse to do. Union (don't overwrite) so any
    // merge tier-locks restored before the loop (which don't carry a 'locked'
    // cell status) survive too.
    var _lockedSet = new Set(state.lockedPlies || []);
    var _fixedSet = new Set(state.fixedPlies || []);
    state.moves.forEach(function(em, ei){
      if(em.wStatus === 'locked') _lockedSet.add(ei*2);
      else if(em.wStatus === 'fixed') _fixedSet.add(ei*2);
      if(em.bStatus === 'locked') _lockedSet.add(ei*2+1);
      else if(em.bStatus === 'fixed') _fixedSet.add(ei*2+1);
    });
    state.lockedPlies = Array.from(_lockedSet).sort(function(a,b){return a-b;});
    state.fixedPlies = Array.from(_fixedSet).sort(function(a,b){return a-b;});
    if(state.lockedPlies.length || state.fixedPlies.length){
      log('🔒 Derived from statuses: locked_plies=['+state.lockedPlies.join(',')+'] fixed_plies=['+state.fixedPlies.join(',')+']');
    }
    log('✓ Validated: '+state.sans.length+'/'+flat.length+' moves OK');
    // Store pending confirmation for display in fix panel (not modal)
    state.pendingConfirmation = val.pending_confirmation || null;

    // Store OCR data for beam search
    state.ocrDataForBeam = ocrData;

    // NOTE: Do NOT set confirmedPly to sans.length here!
    // confirmedPly is a user-controlled frontier, only advanced by applyFix().
    // Setting it here would make min_ply = stuck_at, preventing backward search.
    // Keep it at 0 so Phase 1 searches all plies (0 to stuck_at).

    if(val.stuck_at!==null){
      state.stuckPly=val.stuck_at;
      state.legalMoves=val.legal_moves||[];
      state.stuckInfo={
        num:Math.floor(val.stuck_at/2)+1,
        color:val.stuck_at%2===0?'w':'b',
        move:val.stuck_move,
        reason:val.stuck_reason||'illegal',
        explanation:val.stuck_explanation||null
      };
      // Always clear old arrow before setting new one (prevents stale arrows when from_square is null)
      state.errorArrow=null;
      state.savedErrorArrow=null;
      // Set error arrow from validate response if available
      if(val.stuck_from_square&&val.stuck_to_square){
        state.errorArrow={from:val.stuck_from_square,to:val.stuck_to_square};
        state.savedErrorArrow={from:val.stuck_from_square,to:val.stuck_to_square};
      }
      console.log('[DEBUG] API response stuck_reason:', val.stuck_reason, 'state.stuckInfo.reason:', state.stuckInfo.reason);
      log('❌ Stuck at ply '+val.stuck_at+' ('+state.stuckInfo.num+'.'+state.stuckInfo.color.toUpperCase()+'): "'+val.stuck_move+'" ('+state.stuckInfo.reason+')');
    } else {
      state.stuckPly=null;
      state.stuckInfo=null;
      state.errorArrow=null;
      state.savedErrorArrow=null;
      // No stuck point on initial validation = game is already valid.
      // Cancel any background searches that just got launched (e.g. by
      // mergePlayerMoves) since there's nothing to search for.
      try { if (typeof cancelSearch === 'function') cancelSearch(); } catch(e){}
    }

    // At-point alignment trigger: surface a structural suggestion (or hide a
    // stale one) now that we know where reconstruction stopped.
    if (window.SheetAlignment) window.SheetAlignment.evaluateAtPointAlignment();

    // FIRST: Render move list and show stuck position immediately
    renderMoveList();
    toggleInputArea(true);
    document.getElementById('loaded-info').textContent='📄 '+filename;
    goToPly(state.sans.length, {preserveErrorArrow: true});
    renderArrows();

    // THEN: Start finding fixes (user sees stuck position while this runs)
    if(state.stuckInfo){
      if(window.VerificationUI && typeof window.VerificationUI.scrollPanelsToTop === 'function') window.VerificationUI.scrollPanelsToTop();
      fetchFixes(); // Don't await - let it run while user sees the stuck position
    } else {
      // No stuck point on initial validation — game is already valid.
      // The initial path historically didn't paint the green completion
      // banner; only revalidate did. For PGN-batch game-switching we DO
      // want it (otherwise switching back to a completed game leaves the
      // previous game's stuck content visible).
      var stuckDiv2=document.getElementById('stuck-info');
      if(stuckDiv2) stuckDiv2.innerHTML='<span class="text-green-400">✓ All '+state.sans.length+' moves valid'+(val.is_checkmate?' — Checkmate!':'')+'</span>';
      var fixDiv2=document.getElementById('fix-list');
      if(fixDiv2) fixDiv2.innerHTML='<div class="text-green-400 text-sm p-4 text-center">'+(val.is_checkmate?'♔ Checkmate! Game complete!':'🎉 Game complete!')+'</div>';
      try { if (typeof hideFixDetails === 'function') hideFixDetails(); } catch(_e){}
      // Also refresh the Greedy/Beam/Dijkstra panels — otherwise switching
      // back to a finished game leaves the prior session's content visible
      // (e.g. "⏳ Queued for background Greedy" or a stale SOLVED list).
      // Mirrors the revalidate-path call site below, addressing the same
      // "previous game's stuck content visible" concern the comment above
      // already flagged but only partially fixed.
      if (typeof markPanelsGameComplete === 'function') {
        try { markPanelsGameComplete(); } catch (_e) {}
      }
    }

    // Notify PGN-batch (if active) so the sidebar status icon stays in
    // sync with this game's validation result. fromRevalidate=false here
    // — this is the initial-validate path triggered by a game switch,
    // not a user-applied fix.
    try {
      if (window.PgnBatch && window.PgnBatch.state && window.PgnBatch.state.active) {
        window.PgnBatch.onCurrentGameValidated({
          valid: val.stuck_at === null || val.stuck_at === undefined,
          stuck_at: val.stuck_at,
          stuck_reason: val.stuck_reason,
          stuck_move: val.stuck_move,
          is_checkmate: !!val.is_checkmate,
          fromRevalidate: false
        });
      }
    } catch(_e){}

  }catch(e){
    log('⚠ Validation error: '+e.message);
    var stuckDiv=document.getElementById('stuck-info');
    if(stuckDiv) stuckDiv.innerHTML='<span class="text-red-400">⚠ Validation failed: '+e.message+'</span>';
    var fixDiv=document.getElementById('fix-list');
    if(fixDiv) fixDiv.innerHTML='<div class="text-gray-400 text-sm p-4 text-center">Check the log for details</div>';
  }
}

async function fetchFixes(){
  if(!state.stuckInfo)return;var lbl=state.stuckInfo.num+'.'+state.stuckInfo.color.toUpperCase();

  // Capture searchGeneration BEFORE any await so other code paths
  // (verification entry, game switch, manual fix) can supersede this
  // fetchFixes by bumping state.searchGeneration. The original code
  // bumped-and-captured only AFTER the await computeQuickFixes, which
  // meant any bump that happened during that await was swallowed —
  // fetchFixes resumed, bumped itself, captured the new value, and the
  // subsequent checkpoints always matched. Result: a fetchFixes fired by
  // the pre-review validate pass would happily overwrite the review
  // panels (quick fixes + deep search) after the user had already entered
  // verification mode for a different stuck ply.
  state.searchGeneration = (state.searchGeneration || 0) + 1;
  var thisSearchGeneration = state.searchGeneration;
  if(state._verificationActive){
    // Verification mode took over before fetchFixes could meaningfully
    // run — don't paint anything into the verification panels.
    return;
  }

  // Build message based on stuck reason
  var stuckHtml='';
  var reason=state.stuckInfo.reason||'illegal';
  console.log('[DEBUG] fetchFixes: reason="'+reason+'"', state.stuckInfo);
  if(reason==='bad_trade'){
    // Bad trade - concise with explanation
    var explanation=state.stuckInfo.explanation||'seems like a bad trade';
    explanation=explanation.replace(/^Bad trade:\s*/i,'');
    stuckHtml='<div class="text-yellow-400">⚠️ '+lbl+' '+state.stuckInfo.move+' <span class="text-yellow-300/70 text-xs">— bad trade?</span></div>'+
      '<div class="text-xs text-gray-400 mt-1">'+explanation+'</div>';
  }else if(reason==='persistent_absurdity'){
    // Persistent absurdity - concise
    var explanation=state.stuckInfo.explanation||'piece hanging for multiple moves';
    stuckHtml='<div class="text-yellow-400">⚠️ '+lbl+' '+state.stuckInfo.move+' <span class="text-yellow-300/70 text-xs">— suspicious</span></div>'+
      '<div class="text-xs text-gray-400 mt-1">'+explanation+'</div>';
  }else if(reason==='piece_hanging'){
    // Piece left hanging - legal move but suspicious
    var explanation=state.stuckInfo.explanation||'piece left hanging';
    stuckHtml='<div class="text-yellow-400">⚠️ '+lbl+' '+state.stuckInfo.move+' <span class="text-yellow-300/70 text-xs">— leaves piece hanging</span></div>'+
      '<div class="text-xs text-gray-400 mt-1">'+explanation+'</div>';
  }else if(reason==='ambiguous'){
    // Forced stop: dual-sheet near-tie disagreement or very-low-confidence
    // read. The move is LEGAL — we stopped so the user picks among the
    // candidates below. Must NOT fall into the "is illegal" default.
    var explanation=state.stuckInfo.explanation||'the two sheets disagree or this reading is low-confidence — choose the correct move below';
    stuckHtml='<div class="text-amber-400">🔍 '+lbl+' '+state.stuckInfo.move+' <span class="text-amber-300/70 text-xs">— needs review</span></div>'+
      '<div class="text-xs text-gray-400 mt-1">'+explanation+'</div>';
  }else{
    // Default: illegal move - show explanation if available
    var explanation=state.stuckInfo.explanation;
    if(explanation){
      stuckHtml='<div class="text-red-400">❌ '+lbl+' '+state.stuckInfo.move+' is illegal</div>'+
        '<div class="text-xs text-gray-400 mt-1">'+explanation+'</div>';
    }else{
      stuckHtml='<span class="text-red-400">❌ '+lbl+' '+state.stuckInfo.move+' is illegal</span>';
    }
  }
  document.getElementById('stuck-info').innerHTML=stuckHtml;
  // Hide OCR preview - move is already shown in stuck-info above
  document.getElementById('source-preview').classList.add('hidden');

  // QUICK FIXES: Compute and show OCR alternatives (uses Pyodide similarity if available)
  state.quickFixes = await computeQuickFixes();

  // Superseded check BEFORE any DOM paint. If verification entry (or a
  // game switch) happened during the computeQuickFixes await, the review
  // panels are already showing content for a different ply and we must
  // not overwrite them.
  if(state.searchGeneration !== thisSearchGeneration || state._verificationActive){
    log('🔍 Quick-fix render for search #'+thisSearchGeneration+' suppressed (superseded by #'+state.searchGeneration+' or verification active)');
    return;
  }

  hideFixDetails();
  renderQuickFixes(state.quickFixes);
  renderLegalMoves();

  // Update apply button based on quick fixes
  var applyBtn=document.getElementById('btn-apply');
  if(state.quickFixes.length > 0 || state.pendingConfirmation){
    // Quick fixes available - button is ready
    applyBtn.disabled=false;
    applyBtn.className='w-full mb-3 py-3 rounded-lg font-semibold bg-purple-600 hover:bg-purple-500 cursor-pointer';
    if(state.selectedFix){
      applyBtn.textContent='✓ Apply: '+(state.selectedFix.ply_str||'')+' '+state.selectedFix.ocr+' → '+state.selectedFix.san;
    }else{
      applyBtn.textContent='Select a quick fix';
    }
  }else{
    applyBtn.disabled=true;
    applyBtn.className='w-full mb-3 py-3 rounded-lg font-semibold bg-gray-700 text-gray-400 cursor-not-allowed';
    applyBtn.textContent='🔍 Searching...';
  }

  // Only clear arrows if no fix was already selected by quick fixes / pending confirmation
  if(!state.selectedFix){
    state.fixArrow=null;
    state.ocrArrow=null;
  }

  // Check if deep search is enabled in settings
  var settings = getAutoFixSettings();
  if(!settings.enable_deep_search){
    // Deep search disabled - only show quick fixes
    showCalculating(false);
    var deepSection = document.getElementById('deep-search-section');
    if(deepSection){
      deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 pt-2 border-t border-gray-600">Deep search disabled in settings</div>';
    }
    return;
  }

  // Show calculating indicator for deep search
  showCalculating(true);

  // Use confirmedPly as soft boundary - backend will expand backward if no good fixes found
  // fixedPlies prevents undoing fixes the user just applied
  var searchMinPly = state.confirmedPly || 0;
  // Derive locked/fixed sets from the move-cell statuses (the 🔒/✓ the user
  // actually sees) and union them with state.lockedPlies/fixedPlies. This is
  // the single chokepoint where the live backtracking is launched, so it
  // enforces the invariant regardless of which path populated state: if a
  // cell shows 🔒, ply gets locked here and the search can never propose
  // changing it (e.g. "12.W Ng5 → Ng1"). The search algorithms already do
  // this by recomputing locks fresh; the live path used to trust a
  // state.lockedPlies that some reload/restore paths leave out of sync with
  // the visible 'locked' status.
  var _lk = new Set(state.lockedPlies || []);
  var _fx = new Set(state.fixedPlies || []);
  (state.moves || []).forEach(function(em, ei){
    if(em.wStatus === 'locked') _lk.add(ei*2);
    else if(em.wStatus === 'fixed') _fx.add(ei*2);
    if(em.bStatus === 'locked') _lk.add(ei*2+1);
    else if(em.bStatus === 'fixed') _fx.add(ei*2+1);
  });
  var fixedPliesArray = Array.from(_fx).sort(function(a,b){return a-b;});
  var lockedPliesArray = Array.from(_lk).sort(function(a,b){return a-b;});
  // Keep state in sync so downstream consumers see the reconciled sets.
  state.lockedPlies = lockedPliesArray.slice();
  state.fixedPlies = fixedPliesArray.slice();
  var isDualSheet = state.inputMode === 'dual-sheets';
  log('🔍 Finding fix suggestions (searchGen='+thisSearchGeneration+'):'+(isDualSheet ? ' [DUAL-SHEET MODE]' : ''));
  log('   stuck_ply='+state.stuckPly+' ('+Math.floor(state.stuckPly/2+1)+'.'+(state.stuckPly%2===0?'W':'B')+')');
  log('   min_ply='+searchMinPly+' ('+Math.floor(searchMinPly/2+1)+'.'+(searchMinPly%2===0?'W':'B')+')');
  log('   fixed_plies=['+fixedPliesArray.join(',')+']');
  log('   locked_plies=['+lockedPliesArray.join(',')+']');
  log('   approvedPlies=['+(state.approvedPlies||[]).join(',')+']');
  try{
    var flat=[];var ocrData=[];
    var _ambigPlies = getAmbiguousPlies();
    state.moves.forEach(function(m){
      if(m.white){
        flat.push(m.white);
        // Build OCR data with alternatives for this move
        var alts=[];
        if(m.wAlts&&m.wAlts.length>0){
          m.wAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});
        }
        var lenientAlts=[];
        if(m.wLenientAlts&&m.wLenientAlts.length>0){m.wLenientAlts.forEach(function(a){lenientAlts.push({move:a.move||a,confidence:a.confidence||0.1});});}
        ocrData.push({move:m.white,confidence:m.wConf||0.9,alternatives:alts,lenientAlternatives:lenientAlts,forced_stop:(_ambigPlies.indexOf((m.num-1)*2)>=0)||((m.wConf||0.9)<FORCED_STOP_MIN_CONFIDENCE)});
      }
      if(m.black){
        flat.push(m.black);
        var alts=[];
        if(m.bAlts&&m.bAlts.length>0){
          m.bAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});
        }
        var lenientAlts=[];
        if(m.bLenientAlts&&m.bLenientAlts.length>0){m.bLenientAlts.forEach(function(a){lenientAlts.push({move:a.move||a,confidence:a.confidence||0.1});});}
        ocrData.push({move:m.black,confidence:m.bConf||0.9,alternatives:alts,lenientAlternatives:lenientAlts,forced_stop:(_ambigPlies.indexOf((m.num-1)*2+1)>=0)||((m.bConf||0.9)<FORCED_STOP_MIN_CONFIDENCE)});
      }
    });

    // === STREAMING BACKTRACK SEARCH ===
    // Build ply-to-sheet-info map for dual-sheet debug logging
    var sheetInfoByPly = {};
    if(state.ocrCells && state.ocrCells.length > 0 && state.ocrCells[0]._sheetCount !== undefined){
      state.ocrCells.forEach(function(cell){
        var num = cell.num || cell.move_number || 1;
        var color = cell.color;
        var ply = (num - 1) * 2 + (color === 'w' || color === 'white' ? 0 : 1);
        var info = '';
        if(cell._sheetCount === 2){
          info = cell._agree ? 'S1+S2 agree' : 'S1="'+(cell._sheet1Move||'?')+'" S2="'+(cell._sheet2Move||'?')+'"';
        } else if(cell._sheet1Move){
          info = 'S1 only';
        } else if(cell._sheet2Move){
          info = 'S2 only';
        }
        if(info) sheetInfoByPly[ply] = info;
      });
    }

    // Create backtrack state
    var phase2Depth = settings?.deep_search_depth ?? currentSettings?.deep_search_depth ?? 5;
    var stateInfo = await window.zugwise.createBacktrackState(flat, state.stuckPly, ocrData, searchMinPly, fixedPliesArray, phase2Depth, lockedPliesArray, reason);
    var stateId = stateInfo.stateId;
    var totalPlies = stateInfo.totalPlies;
    var stuckMove = flat[state.stuckPly] || '?';
    var sheetDetail = sheetInfoByPly[state.stuckPly] ? ' {'+sheetInfoByPly[state.stuckPly]+'}' : '';
    log('🔍 PRIMARY SEARCH (OCR top: "'+stuckMove+'"'+sheetDetail+'): '+totalPlies+' plies to search (order: '+(stateInfo.searchOrder||[]).join(', ')+( totalPlies > 5 ? '...' : '') +')');

    // Update deep search section with countdown
    var deepSection = document.getElementById('deep-search-section');
    function updateDeepSearchProgress(remaining, fixesFound, bestScore, currentPly, phaseLabel) {
      if(deepSection){
        var phase = phaseLabel || 'Phase 1';
        var progressText;
        if(remaining > 0){
          progressText = 'Searching... Remaining plies: '+remaining+' in '+phase+(fixesFound > 0 ? ' ('+fixesFound+' found)' : '');
        } else {
          progressText = phase+' complete, finalizing...';
        }
        if(currentPly){
          progressText += ' ['+currentPly+']';
        }
        deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2"><span class="calculating">🔍</span><span>'+progressText+'</span></div>';
      }
    }

    // Search one ply at a time with setTimeout(0) to yield control
    var searchComplete = false;
    var earlyExit = false;

    while(!searchComplete){
      // Check if search was superseded — by a newer search, or by review
      // mode taking over (review uses cached algorithm candidates and only
      // needs computeQuickFixes; deep-search results would never be used).
      if(state.searchGeneration !== thisSearchGeneration || state._verificationActive){
        var reasonStr = state._verificationActive
          ? 'review mode entered'
          : 'superseded by search #'+state.searchGeneration+' — fix applied or revalidation triggered';
        log('🔍 Streaming search #'+thisSearchGeneration+' aborted ('+reasonStr+')');
        // Cleanup - finalize will delete state vars
        try { await window.zugwise.backtrackFinalize(stateId); } catch(e){}
        showCalculating(false);
        return;
      }

      // Search next ply
      var stepResult = await window.zugwise.backtrackSearchStep(stateId);

      // Detailed per-ply console logging
      if(stepResult.ply_str){
        var sheetTag = sheetInfoByPly[stepResult.ply] ? ' {'+sheetInfoByPly[stepResult.ply]+'}' : '';
        var plyDetail = '['+( stepResult.phase_label||'PHASE 1')+'] >>> '+stepResult.ply_str+': \''+( stepResult.move_text||'?')+'\' '+( stepResult.range_info||'')+sheetTag;
        if(stepResult.skipped){ plyDetail += ' [SKIPPED]'; }
        else { plyDetail += ' => '+stepResult.fixes_at_ply+' fixes'; }
        console.log(plyDetail);
      }

      // Update progress UI
      updateDeepSearchProgress(stepResult.remaining, stepResult.fixes_found, stepResult.best_score, stepResult.ply_str);

      searchComplete = stepResult.done;
      earlyExit = stepResult.early_exit;

      // Yield control to browser (allow user interaction)
      if(!searchComplete){
        await new Promise(function(resolve){ setTimeout(resolve, 0); });
      }
    }

    // Finalize Phase 1 and check if Phase 2 needed
    var phase2Info = await window.zugwise.backtrackFinalizePhase1(stateId);

    // Stream Phase 2 if needed (same pattern as Phase 1)
    if(phase2Info.need_phase_2 && phase2Info.phase2_total_plies > 0){
      log('🔍 Phase 2: '+phase2Info.phase2_total_plies+' plies to search');
      var phase2Done = false;
      while(!phase2Done){
        if(state.searchGeneration !== thisSearchGeneration || state._verificationActive){
          var p2Reason = state._verificationActive
            ? 'review mode entered'
            : 'superseded by search #'+state.searchGeneration;
          log('🔍 Phase 2 search #'+thisSearchGeneration+' aborted ('+p2Reason+')');
          try { await window.zugwise.backtrackFinalizeComplete(stateId); } catch(e){}
          showCalculating(false);
          return;
        }
        var p2Step = await window.zugwise.backtrackPhase2Step(stateId);

        // Detailed per-ply console logging for Phase 2
        if(p2Step.ply_str){
          var p2SheetTag = sheetInfoByPly[p2Step.ply] ? ' {'+sheetInfoByPly[p2Step.ply]+'}' : '';
          var p2Detail = '['+( p2Step.phase_label||'PHASE 2')+'] >>> '+p2Step.ply_str+': \''+( p2Step.move_text||'?')+'\' '+( p2Step.range_info||'')+p2SheetTag;
          if(p2Step.skipped){ p2Detail += ' [SKIPPED]'; }
          else { p2Detail += ' => '+p2Step.fixes_at_ply+' fixes'; }
          console.log(p2Detail);
        }

        updateDeepSearchProgress(p2Step.remaining, p2Step.fixes_found, p2Step.best_score, p2Step.ply_str, 'Phase 2');
        phase2Done = p2Step.done;
        if(!phase2Done){
          await new Promise(function(resolve){ setTimeout(resolve, 0); });
        }
      }
    }

    // Complete finalization (merge, postprocess, add arrows)
    updateDeepSearchProgress(0, 0, 0, null, 'Verifying fixes');
    var data = await window.zugwise.backtrackFinalizeComplete(stateId);

    // Check if search was superseded (user applied a fix / switched game /
    // entered verification while we were searching)
    if(state.searchGeneration !== thisSearchGeneration || state._verificationActive){
      log('🔍 Deep search #'+thisSearchGeneration+' result ignored (superseded by search #'+state.searchGeneration+' or verification active)');
      showCalculating(false);
      return;
    }

    // Dual search: if both sheets' top candidates are illegal, search with the second one too
    if(data && data.dual_search_info && data.dual_search_info.needed){
      var dsi = data.dual_search_info;
      var primaryCount = (data.fixes||[]).length;
      var deepSection = document.getElementById('deep-search-section');
      log('🔍 DUAL SEARCH (secondary candidate: "'+dsi.secondary_move+'" from S2): primary "'+dsi.primary_move+'" was illegal at '+dsi.stuck_ply_str);

      // Step 1: Raw search with secondary candidate
      if(deepSection){
        deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2"><span class="calculating">🔍</span><span>Searching with 2nd candidate: <b>'+dsi.secondary_move+'</b> ('+Math.round(dsi.secondary_conf*100)+'%) at '+dsi.stuck_ply_str+'...</span></div>';
      }
      await new Promise(function(resolve){ setTimeout(resolve, 0); });
      if(state.searchGeneration !== thisSearchGeneration || state._verificationActive){ showCalculating(false); return; }

      var searchResult = await window.zugwise.backtrackDualSearch(stateId);

      if(searchResult && !searchResult.error && searchResult.raw_count > 0){
        // Step 2: Verify top candidates with quiescence
        log('🔍 Dual search found '+searchResult.raw_count+' raw candidates, verifying...');
        if(deepSection){
          deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2"><span class="calculating">🔍</span><span>Verifying '+Math.min(searchResult.raw_count, 8)+' dual search fixes...</span></div>';
        }
        await new Promise(function(resolve){ setTimeout(resolve, 0); });
        if(state.searchGeneration !== thisSearchGeneration || state._verificationActive){ showCalculating(false); return; }

        var verifyResult = await window.zugwise.backtrackDualVerify(stateId);

        // Step 3: Merge into primary results
        log('🔍 Verified '+verifyResult.verified_count+' dual fixes, merging...');
        if(deepSection){
          deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2"><span class="calculating">🔍</span><span>Merging '+primaryCount+' + '+verifyResult.verified_count+' fixes...</span></div>';
        }
        await new Promise(function(resolve){ setTimeout(resolve, 0); });
        if(state.searchGeneration !== thisSearchGeneration || state._verificationActive){ showCalculating(false); return; }

        var mergedResult = await window.zugwise.backtrackDualMerge(stateId, data.fixes||[]);
        if(mergedResult && mergedResult.fixes){
          log('🔍 Merged: '+mergedResult.total+' unique fixes from both searches');
          data.fixes = mergedResult.fixes;
        }
      } else {
        // No secondary fixes or error — clean up state vars
        if(searchResult && searchResult.error){
          log('⚠ Dual search error: '+searchResult.error);
        }
        // Still need to cleanup state vars since backtrackFinalizeComplete didn't
        try { await window.zugwise.backtrackDualMerge(stateId, data.fixes||[]); } catch(e){}
      }
    }

    showCalculating(false);

    if(data){
      if(earlyExit){
        log('✓ Early exit: found high-confidence completing fix');
      }
      if(data.fixes&&data.fixes.length>0){
        var f=data.fixes[0];
        log('DEBUG fix[0] ply='+f.ply+' ply_str='+f.ply_str+' ocr='+f.ocr+' san='+f.san+' keep_as_is='+f.keep_as_is);
        // Log ply distribution
        var plyCounts = {};
        data.fixes.forEach(function(fix){ var p = fix.ply_str || '?'; plyCounts[p] = (plyCounts[p]||0) + 1; });
        log('DEBUG fix plies: ' + JSON.stringify(plyCounts));
        var p2Count = data.fixes.filter(function(fix){ return fix.before_frontier; }).length;
        var keepCount = data.fixes.filter(function(fix){ return fix.keep_as_is; }).length;
        log('DEBUG ' + data.fixes.length + ' fixes total: ' + p2Count + ' from Phase 2, ' + keepCount + ' keep-as-is');
      }
      log('✓ Found '+(data.fixes||[]).length+' deep search fixes');

      // Merge backtracking results with quick fixes (quick fixes stay at top)
      mergeBacktrackFixes(data.fixes||[], data.missing_move_candidates||[]);
      // Render legal moves (no tooltip - was misleading)
      renderLegalMoves();
      renderArrows();
      return;
    }
  }catch(e){
    log('⚠ Fix fetch error: '+e.message);
    console.error('Backtrack search error:', e);
  }
  showCalculating(false);
  // On error, just clear the deep search placeholder (quick fixes already shown)
  var deepSection = document.getElementById('deep-search-section');
  if(deepSection){
    deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 pt-2 border-t border-gray-600">Deep search unavailable</div>';
  }
}

// Drop a ply from every protected set (fixed / locked / approved). Called when
// revalidate() finds the backend stuck on a move the user had previously
// confirmed — the confirmation is invalid now (an upstream edit changed the
// board), so the ply must become searchable again. Without this, fetchFixes()
// re-derives the protected sets and unions in state.fixedPlies/lockedPlies,
// re-locking the very ply we need deep search to repair (e.g. 21.W Bf4→Qf4).
function _unconfirmPlyForRevalidate(ply){
  [state.fixedPlies, state.lockedPlies, state.approvedPlies].forEach(function(arr){
    if(!arr) return;
    var k = arr.indexOf(ply);
    if(k !== -1) arr.splice(k, 1);
  });
}

async function revalidate(opts){
  var _batchGuard = _captureBatchGuard(opts);
  var flat=[];var ocrData=[];
  var _ambigPlies = getAmbiguousPlies();
  state.moves.forEach(function(m){
    if(m.white){
      flat.push(m.white);
      var alts=[];
      if(m.wAlts&&m.wAlts.length>0){m.wAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});}
      var lenientAlts=[];
      if(m.wLenientAlts&&m.wLenientAlts.length>0){m.wLenientAlts.forEach(function(a){lenientAlts.push({move:a.move||a,confidence:a.confidence||0.1});});}
      ocrData.push({move:m.white,confidence:m.wConf||0.9,alternatives:alts,lenientAlternatives:lenientAlts,forced_stop:(_ambigPlies.indexOf((m.num-1)*2)>=0)||((m.wConf||0.9)<FORCED_STOP_MIN_CONFIDENCE)});
    }
    if(m.black){
      flat.push(m.black);
      var alts=[];
      if(m.bAlts&&m.bAlts.length>0){m.bAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});}
      var lenientAlts=[];
      if(m.bLenientAlts&&m.bLenientAlts.length>0){m.bLenientAlts.forEach(function(a){lenientAlts.push({move:a.move||a,confidence:a.confidence||0.1});});}
      ocrData.push({move:m.black,confidence:m.bConf||0.9,alternatives:alts,lenientAlternatives:lenientAlts,forced_stop:(_ambigPlies.indexOf((m.num-1)*2+1)>=0)||((m.bConf||0.9)<FORCED_STOP_MIN_CONFIDENCE)});
    }
  });
  // Pass confirmedPly as startPly to skip re-checking already-confirmed moves
  var startPly = state.confirmedPly || 0;
  // One-shot suppress of similarity / OCR-alternative auto-fix — set by the
  // post-override path (verification-ui.js _beginReviewEdit) so the user
  // sees the real new stuck point instead of validate_moves silently
  // applying one-or-nothing rescue fixes on plies they just reverted to OCR
  // baseline. Without this, the user overrides 35.W, revalidate auto-fixes
  // 35.B / 36.W / 36.B via similarity swaps, and the game reports
  // "complete" — stealing the fresh Greedy's review opportunity.
  var settings = getAutoFixSettings();
  if (state._skipAutoFixNextRevalidate) {
    settings = Object.assign({}, settings, {
      ocr_autofix: false,
      similarity_autofix: false
    });
    delete state._skipAutoFixNextRevalidate;
    log('🔄 (post-override: auto-fix suppressed for this revalidate)');
  }
  log('🔄 Revalidating '+flat.length+' moves (starting EAD from ply '+startPly+')...');
  try{var val=await callValidateAPI(flat, ocrData, settings, state.approvedPlies||[], startPly);
    // If the user switched games during the Pyodide await, bail BEFORE
    // mutating state. The new game has its own state.moves now — overwriting
    // it with this game's revalidation would corrupt the display until the
    // next user action triggers another revalidate / re-bind.
    if (_batchGuardChanged(_batchGuard)) {
      log('🔇 revalidate aborted — game switched from ' + _batchGuard +
          ' to ' + (window.BatchGameList && window.BatchGameList.batchState &&
                    window.BatchGameList.batchState.currentGameId) +
          ' mid-await; not mutating state');
      return;
    }
    // Store pending confirmation for display in fix panel (not modal)
    state.pendingConfirmation = val.pending_confirmation || null;
    // Build lookup from ply to corrected SAN and OCR alt info
    var correctedSans={};
    var ocrAltInfo={};
    if(val.moves){val.moves.forEach(function(vm){
      correctedSans[vm.ply]=vm.san;
      if(vm.ocr_alt_applied){ocrAltInfo[vm.ply]={confidence:vm.ocr_alt_confidence,count:vm.ocr_alt_count};}
    });}
    state.sans=[];var ply=0;state.moves.forEach(function(m){
      // Apply auto-corrections from validation response
      var origW=m.white,origB=m.black;
      var wOcrAlt=ocrAltInfo[ply];
      var bOcrAlt=ocrAltInfo[ply+(m.white?1:0)];
      if(m.white&&correctedSans[ply]&&correctedSans[ply]!==m.white&&m.wStatus!=='fixed'&&m.wStatus!=='locked'){
        if(!m.wOriginal)m.wOriginal=m.white;
        m.white=correctedSans[ply];
        m.wOcrAlt=!!wOcrAlt;
        if(wOcrAlt){
          log('🔄 OCR-ALT '+m.num+'.W: "'+origW+'" illegal, applied OCR candidate: "'+m.white+'" ('+(wOcrAlt.confidence*100).toFixed(0)+'%)');
          showAutoFixFlash(origW,m.white,0,'OCR candidate');
        }else{
          log('Quick fix '+m.num+'.W: '+origW+' -> '+m.white);
          showAutoFixFlash(origW,m.white);
        }
      }else if(m.white&&(m.wStatus==='fixed'||m.wStatus==='locked')&&_notationOnlyCanonicalization(m.white,correctedSans[ply])){
        // Locked/fixed ply: adopt the canonical SAN for the SAME move so the
        // board can replay it (raw "Ra8" → "Rxa8+"). No flash / ⚡ — the move is
        // unchanged, only its notation is normalized for chess.js.
        m.white=correctedSans[ply];
      }
      if(m.black&&correctedSans[ply+(m.white?1:0)]&&correctedSans[ply+(m.white?1:0)]!==m.black&&m.bStatus!=='fixed'&&m.bStatus!=='locked'){
        if(!m.bOriginal)m.bOriginal=m.black;
        m.black=correctedSans[ply+(m.white?1:0)];
        m.bOcrAlt=!!bOcrAlt;
        if(bOcrAlt){
          log('🔄 OCR-ALT '+m.num+'.B: "'+origB+'" illegal, applied OCR candidate: "'+m.black+'" ('+(bOcrAlt.confidence*100).toFixed(0)+'%)');
          showAutoFixFlash(origB,m.black,0,'OCR candidate');
        }else{
          log('Quick fix '+m.num+'.B: '+origB+' -> '+m.black);
          showAutoFixFlash(origB,m.black);
        }
      }else if(m.black&&(m.bStatus==='fixed'||m.bStatus==='locked')&&_notationOnlyCanonicalization(m.black,correctedSans[ply+(m.white?1:0)])){
        // Locked/fixed ply: adopt the canonical SAN for the SAME move (raw
        // "Ra8" → "Rxa8+") so the board can replay it. No flash / ⚡.
        m.black=correctedSans[ply+(m.white?1:0)];
      }
      if(m.white){
        if(val.stuck_at===ply){
          // Backend halted HERE. Reality overrides a stale 'fixed'/'locked'
          // tag: an upstream edit (e.g. 20.W Bd2→Qd2) can make a move the
          // user confirmed earlier (21.W Bf4) illegal. Surface it as the
          // error instead of leaving a green ✓ on a move the board cannot
          // play, and un-protect the ply so deep search can actually propose
          // a replacement (it would otherwise be skipped as fixed/locked).
          m.wStatus='error';
          _unconfirmPlyForRevalidate(ply);
        } else if(m.wStatus!=='fixed'&&m.wStatus!=='locked'){
          if(val.stuck_at!==null&&ply>val.stuck_at){
            m.wStatus='pending';
            // Past-stuck revert: when the game is stuck earlier, the board
            // state at this ply is no longer reachable, so any silent auto-
            // correct stored on this entry was derived from a now-invalid
            // position. Restore the OCR baseline so the ⚡ marker disappears
            // and the user sees the raw move at this ply (the auto-correct
            // will be re-derived from scratch on the next revalidate once
            // the stuck point is resolved). User-confirmed fixes
            // (status='fixed'/'locked') are skipped by the outer guard.
            if(m.wOriginal){m.white=m.wOriginal;m.wOriginal=null;m.wOcrAlt=false;}
          }
          else m.wStatus='ok';
        }
        // Only feed moves up to the stuck point into state.sans. A
        // fixed/locked move PAST the stuck point would otherwise leak in and
        // the board replay would diverge from the movelist — the reported
        // "board stuck, movelist continues" symptom.
        var wPastStuck=(val.stuck_at!==null&&ply>val.stuck_at);
        if(!wPastStuck&&(m.wStatus==='ok'||m.wStatus==='fixed'||m.wStatus==='locked'))state.sans.push(m.white);
        ply++;
      }
      if(m.black){
        if(val.stuck_at===ply){
          m.bStatus='error';
          _unconfirmPlyForRevalidate(ply);
        } else if(m.bStatus!=='fixed'&&m.bStatus!=='locked'){
          if(val.stuck_at!==null&&ply>val.stuck_at){
            m.bStatus='pending';
            if(m.bOriginal){m.black=m.bOriginal;m.bOriginal=null;m.bOcrAlt=false;}
          }
          else m.bStatus='ok';
        }
        var bPastStuck=(val.stuck_at!==null&&ply>val.stuck_at);
        if(!bPastStuck&&(m.wStatus==='ok'||m.wStatus==='fixed'||m.wStatus==='locked')&&(m.bStatus==='ok'||m.bStatus==='fixed'||m.bStatus==='locked'))state.sans.push(m.black);
        ply++;
      }
    });
    // NOTE: Do NOT update confirmedPly here - it's the user's search boundary,
    // set by applyFix(). Updating it would defeat the purpose.
    log('✓ After fix: '+state.sans.length+'/'+flat.length+' moves OK (confirmedPly='+state.confirmedPly+')');
    if(val.stuck_at!==null){
      state.stuckPly=val.stuck_at;
      state.legalMoves=val.legal_moves||[];
      state.stuckInfo={num:Math.floor(val.stuck_at/2)+1,color:val.stuck_at%2===0?'w':'b',move:val.stuck_move,reason:val.stuck_reason||'illegal',explanation:val.stuck_explanation||null};
      // Always clear old arrow before setting new one (prevents stale arrows when from_square is null)
      state.errorArrow=null;
      state.savedErrorArrow=null;
      // Set error arrow from validate response if available
      if(val.stuck_from_square&&val.stuck_to_square){
        state.errorArrow={from:val.stuck_from_square,to:val.stuck_to_square};
        state.savedErrorArrow={from:val.stuck_from_square,to:val.stuck_to_square};
      }
      log('❌ Next error at '+state.stuckInfo.num+'.'+state.stuckInfo.color.toUpperCase()+': "'+val.stuck_move+'" ('+state.stuckInfo.reason+')');
      log('   [DEBUG] val.stuck_at='+val.stuck_at+', state.stuckPly='+state.stuckPly+', state.confirmedPly='+state.confirmedPly);
    }else{
      state.stuckPly=null;
      state.stuckInfo=null;
      state.errorArrow=null;
      state.savedErrorArrow=null;
      // Game completed — drop the residual fix-suggestion state that was
      // built for the previous stuck point. Without this, the right panel
      // keeps showing the last selectedFix's score breakdown ("10.W
      // Qd2→Qe2 | score=209 ...") and the legal-moves list from the
      // previous stuck ply ("All legal moves at 22.W (41)") alongside the
      // green "Game complete!" banner.
      state.selectedFix = null;
      state.legalMoves = [];
      state.fixArrow = null;
      state.ocrArrow = null;
      try { if (typeof hideFixDetails === 'function') hideFixDetails(); } catch(e){}
      var _lc = document.getElementById('legal-moves');
      if (_lc) _lc.innerHTML = '';
      var _lcCount = document.getElementById('legal-count');
      if (_lcCount) _lcCount.textContent = '0';
      var _lcPos = document.getElementById('legal-position');
      if (_lcPos) _lcPos.textContent = '';
      // Invalidate any in-flight deep searches AND cancel any background
      // search workers (greedy / beam / dijkstra) — game is solved, no
      // reason to keep CPU spinning on it.
      state.searchGeneration = (state.searchGeneration || 0) + 1;
      try { if (typeof cancelSearch === 'function') cancelSearch(); } catch(e){}
      showCalculating(false);
      if(val.is_checkmate){
        var validated=state.sans.length;
        var noiseCount=0;
        if(state.ocrCells){
          noiseCount=Math.max(0,state.ocrCells.length-validated);
        }else{
          var plyCount=0;
          (state.moves||[]).forEach(function(m){if(m.white)plyCount++;if(m.black)plyCount++;});
          noiseCount=Math.max(0,plyCount-validated);
        }
        var trashHtml=noiseCount>0
          ? '<div class="mt-3 text-xs text-gray-400">'+noiseCount+' move'+(noiseCount===1?'':'s')
            +' after checkmate — likely OCR noise. '
            +'<button class="underline text-red-400 hover:text-red-300 ml-1" '
            +'onclick="truncateTrailingNoise('+validated+')" '
            +'title="Delete '+noiseCount+' trailing move'+(noiseCount===1?'':'s')+'">'
            +'🗑️ Delete</button></div>'
          : '';
        document.getElementById('stuck-info').innerHTML='<span class="text-green-400">✓ Checkmate! Game complete!</span>';
        document.getElementById('fix-list').innerHTML='<div class="text-green-400 text-sm p-4 text-center">♔ Checkmate! Game complete!'+trashHtml+'</div>';
        log('♔ Checkmate! Game complete! '+validated+' moves validated'+(noiseCount>0?' ('+noiseCount+' noise move'+(noiseCount===1?'':'s')+' past mate)':''));
      }else{
        document.getElementById('stuck-info').innerHTML='<span class="text-green-400">✓ All moves valid!</span>';
        document.getElementById('fix-list').innerHTML='<div class="text-green-400 text-sm p-4 text-center">🎉 Game complete!</div>';
        log('🎉 Game complete! '+state.sans.length+' moves validated');
      }
      document.getElementById('source-preview').classList.add('hidden');
      resetApplyButton();
      // Game has reached a complete state (checkmate or all-valid). Wipe
      // any leftover Greedy/Beam/Dijkstra panel state so a previously-run
      // algorithm result doesn't keep showing "SOLVED (N fixes)" / "Stale" /
      // "Queued" alongside the green completion banner. bindGame()'s
      // VERIFIED/EXPORTED early-return doesn't catch this case because the
      // game is functionally complete but not yet user-verified.
      if (typeof markPanelsGameComplete === 'function') {
        try { markPanelsGameComplete(); } catch (e) {}
      }
    }
    // Notify PGN-batch (if active) so the sidebar status icon stays in
    // sync with this game's validation result. Mirrors the hook in the
    // initial-validate path so applying a fix that makes the game valid
    // flips the sidebar row from 🟡 to ✅ immediately.
    try {
      if (window.PgnBatch && window.PgnBatch.state && window.PgnBatch.state.active) {
        window.PgnBatch.onCurrentGameValidated({
          valid: val.stuck_at === null || val.stuck_at === undefined,
          stuck_at: val.stuck_at,
          stuck_reason: val.stuck_reason,
          stuck_move: val.stuck_move,
          is_checkmate: !!val.is_checkmate,
          fromRevalidate: true  // distinguishes user-fix-triggered revalidate from initial validate
        });
      }
    } catch(_e){}
    // At-point alignment trigger after every revalidation.
    if (window.SheetAlignment) window.SheetAlignment.evaluateAtPointAlignment();
  }catch(e){log('⚠ Revalidation error: '+e.message);}
  // Recalculate tiers after fix application (legality may have changed)
  if (state.ocrCells && window.MergeSheets && state.mergeTierMap) {
    // Build current moves map from state.moves (includes applied fixes)
    var currentMovesMap = {};
    if (state.moves) {
      state.moves.forEach(function(m) {
        if (m.white) currentMovesMap[(m.num - 1) * 2] = m.white;
        if (m.black) currentMovesMap[(m.num - 1) * 2 + 1] = m.black;
      });
    }
    state.mergeTierMap = window.MergeSheets.classifyTiers(state.ocrCells, currentMovesMap);
    var lockMode = (state.mergeSettings && state.mergeSettings.lockMode) || 'tier1';
    state.mergeLockedPlies = window.MergeSheets.computeLockedPlies(state.mergeTierMap, lockMode);
    state.lockedPlies = state.mergeLockedPlies.slice();
    // Update the banner counts (agreement summary matches dot colors)
    var aSummary = window.MergeSheets.agreementSummary(state.ocrCells);
    showTierSummaryBanner(aSummary, lockMode);
  }
  // FIRST: Render move list and navigate to stuck position (same pattern as validateAndDisplay)
  renderMoveList();
  goToPly(state.sans.length, {preserveErrorArrow: !!state.stuckInfo});
  renderArrows();
  // THEN: Find fixes AFTER goToPly (so goToPly doesn't clear fixArrow set by fetchFixes)
  if(state.stuckInfo){
    if(window.VerificationUI && typeof window.VerificationUI.scrollPanelsToTop === 'function') window.VerificationUI.scrollPanelsToTop();
    fetchFixes();
  }
}

// =============================================================================
// NOTE: Full game search (greedy/beam) is now USER-INITIATED via buttons
// See js/beam.js for runGreedySearch() and runBeamSearch()
// =============================================================================
