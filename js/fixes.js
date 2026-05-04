// =============================================================================
// FIXES - Fix suggestions, edit mode, apply fixes
// =============================================================================

// Convert a 0-indexed ply to "N.W" or "N.B" string
function plyToStr(ply) {
  var num = Math.floor(ply / 2) + 1;
  var color = ply % 2 === 0 ? 'W' : 'B';
  return num + '.' + color;
}

// Human-readable descriptions for the score components attached to every fix.
// Used to build a hover tooltip on fix buttons so a curious user can see why
// a fix ranked where it did without reading the code.
var SCORE_COMPONENT_DESCRIPTIONS = {
  sim:         'Character similarity to OCR text (sim × 40)',
  hi_sim:      'Bonus for very high similarity (≥90%)',
  reach:       'Plies the game continues after this fix (capped at 50)',
  reach_tb:    'Reach tiebreaker for fixes that reach far beyond the stuck ply',
  reach10:     'Bonus for reaching 10+ plies past the stuck point',
  complete:    'Bonus if this fix completes the whole game',
  abs_fix:     'Bonus if this fix resolves an existing absurdity',
  lo_conf:     'Bonus if the original OCR had very low confidence',
  chk_mm:      'Bonus if this fix resolves a check/notation mismatch',
  chk_en:      'Bonus if this fix enables a future check in the game',
  chk_fc:      'Bonus for a forcing check in the fix sequence',
  stk_chk:     'Bonus tied to the check symbol on the stuck move',
  clr_dst:     'Bonus if this fix clears the destination of a later move',
  dup_fix:     'Bonus if this fix resolves a duplicate-move conflict',
  dup_res:     'Bonus for resolving a broader duplicate-move cluster',
  future:      'Bonus for enabling more legal future moves',
  near:        'Bonus for being near the stuck ply (smaller edits preferred)',
  ocr_c:       'Bonus scaled by OCR confidence of the candidate',
  ocr_pat:     'Bonus if this candidate was already in the OCR alternatives',
  abs_pen:     'Penalty: leaves a piece hanging (quiescence-backed)',
  hang:        '(legacy, unused) simple hanging penalty',
  pwn_h:       '(legacy, unused) pawn-hanging penalty',
  win_cap:     '(legacy, unused) winning-capture bonus',
  miss_c:      '(legacy, unused) missed-capture penalty',
  mfc:         'Penalty: ignores a free capture of a major piece',
  ofc:         'Penalty: lets opponent make a free capture with check',
  bad_tr:      'Penalty: SEE-verified losing exchange initiated by this move',
  zero_r:      'Penalty: this fix does not advance the game',
  dist:        'Penalty scaled by ply distance from the stuck point',
  stuck:       'Bonus for fixes AT the stuck ply that advance',
  fut_cap:     'Bonus if a future OCR move references this fix\u2019s square',
  p2_pen:      'Phase-2 penalty (fixes found during extended search)',
  v_mate:      'Verification penalty (fix creates material loss confirmed by quiescence)'
};

// Render a single color-coded score-component pill for the fix-details panel.
// Green = positive (bonus), red = negative (penalty), gray = zero. Description
// goes into the title attribute so curious users can hover for the meaning.
function renderScoreComponentPill(name, value) {
  if (value === null || value === undefined) return '';
  var rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return '';
  var sign = rounded > 0 ? '+' : '';
  var cls = rounded > 0
    ? 'bg-green-900/40 text-green-300 border-green-700'
    : 'bg-red-900/40 text-red-300 border-red-700';
  var desc = SCORE_COMPONENT_DESCRIPTIONS[name] || '';
  var title = desc ? (name + ' = ' + sign + rounded + '\n' + desc) : (name + ' = ' + sign + rounded);
  return '<span class="inline-block px-1.5 py-0.5 rounded border ' + cls +
    '" title="' + title.replace(/"/g, '&quot;') + '">' +
    name + sign + rounded + '</span>';
}

// OCR color class: red at stuck ply, yellow for backtrack fixes (matching board arrow colors)
function ocrColorClass(fix) {
  // Use the ORIGIN stuck ply when set (backtrack-review mode) so the
  // OCR-text color matches what the headline + move-list outline say:
  // red on the actual stuck ply, yellow on every other candidate
  // (including the currently-focused backtrack proposal). Without this,
  // state.stuckPly equals the focus ply during backtrack review, so the
  // 15.B fix would read as "stuck" (red) while the 16.B fix at the
  // actual stuck point read as "backtrack" (yellow) — exactly inverted.
  var stuckRefPly = (typeof state.originStuckPly === 'number')
    ? state.originStuckPly : state.stuckPly;
  if (typeof fix.ply === 'number' && stuckRefPly !== null && fix.ply !== stuckRefPly) {
    return 'text-yellow-400';  // backtrack / forward-alternative fix
  }
  return 'text-red-400';  // stuck ply fix — red like the error arrow
}

// Build the reach label for a fix: "Reach: 13.W" (absolute ply reached)
function reachLabel(fix) {
  if (fix.completes) return '\u2713 Complete';
  // Use absolute reach ply if available (set by backend)
  var reachPly = fix.reach;
  if (typeof reachPly === 'number' && reachPly > 0) return 'Reach:' + plyToStr(reachPly);
  // Fallback: compute from reach_improvement + stuckPly (NOT fix.ply, which may be an earlier backtrack ply)
  var ri = fix.reach_improvement || 0;
  if (ri <= 0) return '';
  if (state.stuckPly !== null && typeof state.stuckPly === 'number') {
    return 'Reach:' + plyToStr(state.stuckPly + ri);
  }
  return '+' + ri;
}

// Get absolute reach ply for a fix (for comparing/coloring)
function getAbsReach(fix) {
  if (fix.completes) return Infinity;
  if (typeof fix.reach === 'number' && fix.reach > 0) return fix.reach;
  var ri = fix.reach_improvement || 0;
  if (ri <= 0) return 0;
  if (state.stuckPly !== null && typeof state.stuckPly === 'number') return state.stuckPly + ri;
  return 0;
}

// Compute reachability badge color relative to the best reach among shown fixes
function reachBadgeColor(fix, maxReach) {
  if (fix.completes) return 'text-green-400';
  var r = getAbsReach(fix);
  if (r <= 0) return 'text-gray-500';
  // If this fix has the best reach (or close), show green
  if (r >= maxReach) return 'text-green-400';
  if (r >= maxReach * 0.6) return 'text-blue-400';
  return 'text-yellow-400';
}

// Check if the stuck ply has an original OCR value different from the current move
function getOriginalOcrForStuckPly() {
  if (!state.stuckInfo) return null;
  var num = state.stuckInfo.num, color = state.stuckInfo.color;
  for (var i = 0; i < state.moves.length; i++) {
    if (state.moves[i].num === num) {
      var orig = color === 'w' ? state.moves[i].wOriginal : state.moves[i].bOriginal;
      var current = color === 'w' ? state.moves[i].white : state.moves[i].black;
      if (orig && orig !== current) return orig;
      return null;
    }
  }
  return null;
}

// Create a "Revert to OCR" button element for the given original OCR text
function createRevertToOcrButton(originalOcr, container) {
  var lbl = state.stuckInfo.num + '.' + state.stuckInfo.color.toUpperCase();
  var currentMove = state.stuckInfo.move;
  var ply = state.stuckPly;

  var btn = document.createElement('button');
  btn.className = 'w-full text-left p-2 rounded-lg border bg-blue-600/30 border-blue-500 mb-2 hover:bg-blue-500/40';
  btn.title = 'Revert to the original OCR text before manual edits';
  btn.innerHTML = '<span class="text-blue-300 font-medium">↩ Revert to OCR: <span class="font-mono">' + originalOcr + '</span></span> <span class="text-blue-400/70 text-xs">— undo manual edit</span>';

  // Compute arrow squares for the revert move
  var fromSq = null, toSq = null;
  if (ply !== null) {
    try {
      var tempChess = new Chess();
      for (var j = 0; j < ply; j++) { tempChess.move(state.sans[j]); }
      var moveObj = tempChess.move(originalOcr);
      if (moveObj) { fromSq = moveObj.from; toSq = moveObj.to; }
    } catch (e) {}
  }

  var revertFix = {
    ocr: currentMove,
    san: originalOcr,
    similarity: 0,
    ply: ply,
    ply_str: lbl,
    source: 'revert_to_ocr',
    from_square: fromSq,
    to_square: toSq,
    ocr_from_square: state.errorArrow ? state.errorArrow.from : null,
    ocr_to_square: state.errorArrow ? state.errorArrow.to : null
  };

  btn.onclick = function() { selectFix(revertFix, btn); };
  btn.ondblclick = function() { selectFix(revertFix, btn); applyFix(); };
  container.appendChild(btn);
  return revertFix;
}

// Yellow "Keep <move> — accept as-is" button shown for bad-trade /
// persistent-absurdity / piece-hanging stuck reasons. Routed through
// selectFix → applyFix so it behaves like every other suggestion: a
// single click stages the choice on the main confirm button, the user
// then commits with the main button (or double-clicks here to apply
// in one step). Earlier this onclick called keepCurrentMove() directly,
// which felt inconsistent — clicking a "suggestion field" applied
// instantly while clicking other suggestion fields only selected them.
function createKeepAsIsButton(container) {
  if (!state.stuckInfo || state.stuckPly === null) return null;

  var lbl = state.stuckInfo.num + '.' + state.stuckInfo.color.toUpperCase();
  var move = state.stuckInfo.move;
  var ply = state.stuckPly;

  var btn = document.createElement('button');
  btn.className = 'w-full text-left p-2 rounded-lg border bg-yellow-600/30 border-yellow-500 mb-2 hover:bg-yellow-500/40';
  btn.title = 'Accept this move despite the warning (may be an intentional sacrifice or gambit) — click to select, then commit with the main button';
  btn.innerHTML = '<span class="text-yellow-300 font-medium">✓ Keep ' + move + '</span> <span class="text-yellow-400/70 text-xs">— accept as-is</span>';

  // Compute arrow squares so the kept move's from/to lights up like
  // any other selected fix.
  var fromSq = null, toSq = null;
  if (ply !== null) {
    try {
      var tempChess = new Chess();
      for (var j = 0; j < ply; j++) { tempChess.move(state.sans[j]); }
      var moveObj = tempChess.move(move);
      if (moveObj) { fromSq = moveObj.from; toSq = moveObj.to; }
    } catch (e) {}
  }

  var keepFix = {
    ocr: move,
    san: move,
    ply: ply,
    ply_str: lbl,
    similarity: 100,
    keep_as_is: true,
    num_changes: 0,
    source: 'keep_as_is',
    from_square: fromSq,
    to_square: toSq,
    ocr_from_square: state.errorArrow ? state.errorArrow.from : null,
    ocr_to_square: state.errorArrow ? state.errorArrow.to : null
  };

  btn.onclick = function() { selectFix(keepFix, btn); };
  btn.ondblclick = function() { selectFix(keepFix, btn); applyFix(); };
  container.appendChild(btn);
  return keepFix;
}

// Reset the Apply/Confirm button to a neutral disabled state. The per-mode
// colors (orange edit, blue review, green apply, purple insert) are written
// only by selectFix() and a few other call sites — none of them ran when
// the user exited a mode without clicking a new fix, so the button would
// linger in the previous mode's color. Scenarios the user reported:
//   - Edited a move, clicked Apply. applyFix() clears state.selectedFix
//     but nothing repaints the button, so it stays orange with stale text.
//   - Exited edit mode via Cancel. state.editMode is cleared but the
//     button keeps the orange styling from the last selectFix call.
//   - Exited review mode. _restorePanelFixes restores from a snapshot
//     taken on review entry; if the pre-review state already had a stale
//     orange/blue button, the restore brings it back.
// Call this whenever a mode is exited or selectedFix is cleared; selectFix
// will re-derive the correct color the next time the user picks a fix.
function resetApplyButton(){
  var applyBtn = document.getElementById('btn-apply');
  if (!applyBtn) return;
  applyBtn.disabled = true;
  applyBtn.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-gray-700 text-gray-400 cursor-not-allowed';
  applyBtn.textContent = 'Select a fix';
  if (typeof applyFix === 'function') applyBtn.onclick = applyFix;
}

function renderFixes(fixes){
  var container = document.getElementById('fix-list');
  container.innerHTML = '';

  // Show "Keep it" button for bad trades, persistent absurdities, or piece hanging
  var reason = state.stuckInfo ? state.stuckInfo.reason : null;
  if(reason === 'bad_trade' || reason === 'persistent_absurdity' || reason === 'piece_hanging'){
    createKeepAsIsButton(container);

    var sep = document.createElement('div');
    sep.className = 'text-xs text-gray-500 mb-2';
    sep.innerHTML = 'Or replace with:';
    container.appendChild(sep);
  }

  // Show pending similarity fix at top (2+ changes requiring user approval)
  if(state.pendingConfirmation){
    var pc = state.pendingConfirmation;
    var pcPly = pc.ply;
    var pcNum = Math.floor(pcPly/2) + 1;
    var pcColor = pcPly % 2 === 0 ? 'W' : 'B';
    var pcPlyStr = pcNum + '.' + pcColor;

    var header = document.createElement('div');
    header.className = 'text-xs text-yellow-400 mb-2 flex items-center gap-2';
    header.innerHTML = '<span>⚠️</span><span>Quick Fix (similarity, ' + pc.num_changes + ' changes):</span>';
    container.appendChild(header);

    var btn = document.createElement('button');
    btn.className = 'w-full text-left p-2.5 rounded-lg border bg-yellow-600/30 border-yellow-500 mb-3';
    btn.title = 'Click to select • Double-click to apply';
    var pcAbsurdTag2 = pc.absurd_warning
      ? ' <span class="text-red-400" title="' + pc.absurd_warning.replace(/"/g, '&quot;') + '">⚠️</span>'
      : '';
    var pcAbsurdLine2 = pc.absurd_warning
      ? '<div class="text-xs text-red-400 mt-1">' + pc.absurd_warning + '</div>'
      : '';
    // OCR text color: red on the actual stuck ply, yellow on a backtrack
    // proposal at an earlier ply. Reuses ocrColorClass to keep this
    // pending-similarity block consistent with the deep-search list and
    // the headline / move-list / OCR-cell highlights.
    var pcOcrColor = ocrColorClass({ ply: pcPly });
    btn.innerHTML = '<div class="flex justify-between items-center"><span class="font-mono text-sm"><span class="text-gray-400">' + pcPlyStr + '</span> <span class="' + pcOcrColor + '">' + pc.original + '</span> → <span class="text-yellow-300 font-semibold">' + pc.suggested + '</span>' + pcAbsurdTag2 + '</span><span class="text-yellow-400 text-xs">' + pc.num_changes + ' changes</span></div>' + pcAbsurdLine2 + '<div class="text-xs text-yellow-600 mt-1">Requires confirmation - click to accept</div>';
    // Compute arrow squares for pending confirmation
    var pcFrom = null, pcTo = null;
    try {
      var tempChess = new Chess();
      for(var j = 0; j < pcPly; j++){ tempChess.move(state.sans[j]); }
      var moveObj = tempChess.move(pc.suggested);
      if(moveObj){ pcFrom = moveObj.from; pcTo = moveObj.to; }
    } catch(e) {}
    var pcFix = {ocr: pc.original, san: pc.suggested, ply: pcPly, ply_str: pcPlyStr, similarity: 0, num_changes: pc.num_changes, type: 'auto_correct_confirm', from_square: pcFrom, to_square: pcTo, ocr_from_square: state.errorArrow ? state.errorArrow.from : null, ocr_to_square: state.errorArrow ? state.errorArrow.to : null};
    btn.onclick = function(){ selectFix(pcFix, btn); };
    btn.ondblclick = function(){ selectFix(pcFix, btn); applyFix(); };
    container.appendChild(btn);

    // Auto-select the pending confirmation
    selectFix(pcFix, btn);
  }

  // Show "Revert to OCR" button if stuck ply was manually edited away from OCR
  var originalOcr = getOriginalOcrForStuckPly();
  if (originalOcr) {
    createRevertToOcrButton(originalOcr, container);
  }

  if(!fixes.length && (!state.missingMoveCandidates || !state.missingMoveCandidates.length) && !state.pendingConfirmation && !originalOcr){
    container.innerHTML = '<div class="text-gray-500 text-sm p-4 text-center">No suggestions found</div>';
    return;
  }

  // Header for backtrack fixes if we have pending confirmation
  if(state.pendingConfirmation && fixes.length > 0){
    var sep = document.createElement('div');
    sep.className = 'text-xs text-gray-400 mt-1 mb-2 pt-2 border-t border-gray-600';
    sep.innerHTML = 'Or try backtracking:';
    container.appendChild(sep);
  }

  var shownFixes = fixes.slice(0, 10);
  var maxReach = 0;
  shownFixes.forEach(function(f){ if (!f.completes) { var ar = getAbsReach(f); if (ar > maxReach) maxReach = ar; } });
  shownFixes.forEach(function(fix, i){
    var btn = document.createElement('button');
    var isFirst = i === 0 && !state.pendingConfirmation;
    btn.className = 'w-full text-left p-2.5 rounded-lg border ' + (isFirst ? 'bg-green-600/30 border-green-500' : 'bg-gray-700 hover:bg-gray-600 border-gray-600');
    btn.title = 'Click to select • Double-click to apply';
    var reach = reachLabel(fix);
    var sim = typeof fix.similarity === 'number' ? fix.similarity : 0;
    var simBadge = sim >= 50 ? 'text-green-400' : (sim >= 25 ? 'text-yellow-400' : 'text-gray-500');
    var rBadge = reachBadgeColor(fix, maxReach);
    var plyLabel = fix.ply_str ? '<span class="text-gray-400">' + fix.ply_str + '</span> ' : '';
    btn.innerHTML = '<div class="flex justify-between items-center"><span class="font-mono text-sm">' + plyLabel + '<span class="' + ocrColorClass(fix) + '">' + fix.ocr + '</span> → <span class="text-green-400 font-semibold">' + fix.san + '</span></span><span class="text-xs"><span class="' + simBadge + '">Sim:' + sim + '%</span>' + (reach ? ' <span class="' + rBadge + '">' + reach + '</span>' : '') + '</span></div>';
    btn.onclick = function(){ selectFix(fix, btn); };
    btn.ondblclick = function(){ selectFix(fix, btn); applyFix(); };
    container.appendChild(btn);
    if(isFirst) selectFix(fix, btn);
  });

  // Render missing move candidates if any
  if(state.missingMoveCandidates && state.missingMoveCandidates.length > 0){
    var sep = document.createElement('div');
    sep.className = 'text-xs text-purple-400 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2';
    sep.innerHTML = '<span>🔍</span><span>Missing move detected - insert:</span>';
    container.appendChild(sep);

    state.missingMoveCandidates.slice(0, 3).forEach(function(mc, i){
      var btn = document.createElement('button');
      btn.className = 'w-full text-left p-2.5 rounded-lg border bg-purple-900/30 hover:bg-purple-800/30 border-purple-600';
      var status = reachLabel(mc) || '?';
      var insertInfo = 'Insert <span class="text-purple-300 font-semibold">' + mc.inserted_move + '</span>';
      if(mc.corrected_stuck_move){
        insertInfo += ' + change <span class="text-gray-400">' + mc.original_stuck_move + '</span> → <span class="text-purple-300">' + mc.corrected_stuck_move + '</span>';
      }
      btn.innerHTML = '<div class="flex justify-between items-center"><span class="font-mono text-sm">' + (i+1) + '. ' + insertInfo + '</span><span class="text-purple-400 text-xs">' + status + '</span></div>';
      btn.title = 'Insert missing move before stuck position';
      btn.onclick = function(){ selectMissingMoveFix(mc, btn); };
      btn.ondblclick = function(){ selectMissingMoveFix(mc, btn); applyFix(); };
      container.appendChild(btn);
    });
  }
}

function renderSimpleFixes(){
  var container = document.getElementById('fix-list');
  container.innerHTML = '';
  var ocr = state.stuckInfo.move;
  var lbl = state.stuckInfo.num + '.' + state.stuckInfo.color.toUpperCase();

  // Show "Keep it" button for bad trades, persistent absurdities, or piece hanging
  var reason = state.stuckInfo.reason || 'illegal';
  if(reason === 'bad_trade' || reason === 'persistent_absurdity' || reason === 'piece_hanging'){
    createKeepAsIsButton(container);

    var sep = document.createElement('div');
    sep.className = 'text-xs text-gray-500 mb-2';
    sep.innerHTML = 'Or replace with:';
    container.appendChild(sep);
  }

  // Show "Revert to OCR" button if stuck ply was manually edited away from OCR
  var originalOcr = getOriginalOcrForStuckPly();
  if (originalOcr) {
    createRevertToOcrButton(originalOcr, container);
  }

  var scored = state.legalMoves.map(function(san){
    return {san: san, sim: Math.round(charSimilarity(ocr, san))};
  }).sort(function(a, b){ return b.sim - a.sim; });

  scored.slice(0, 10).forEach(function(item, i){
    var btn = document.createElement('button');
    var isFirst = i === 0;
    btn.className = 'w-full text-left p-2.5 rounded-lg border ' + (isFirst ? 'bg-green-600/30 border-green-500' : 'bg-gray-700 hover:bg-gray-600 border-gray-600');
    btn.title = 'Click to select • Double-click to apply';
    var simBadge = item.sim >= 50 ? 'text-green-400' : (item.sim >= 25 ? 'text-yellow-400' : 'text-gray-500');
    btn.innerHTML = '<div class="flex justify-between"><span class="font-mono text-sm"><span class="text-gray-400">' + lbl + '</span> <span class="text-red-400">' + ocr + '</span> → <span class="text-green-400">' + item.san + '</span></span><span class="' + simBadge + ' text-xs">Sim:' + item.sim + '%</span></div>';
    var fix = {ocr: ocr, san: item.san, similarity: item.sim, ply_str: lbl};
    btn.onclick = function(){ selectFix(fix, btn); };
    btn.ondblclick = function(){ selectFix(fix, btn); applyFix(); };
    container.appendChild(btn);
    if(isFirst) selectFix(fix, btn);
  });
  renderLegalMoves();
}

function renderLegalMoves(){
  // Render all legal moves list without misleading similarity tooltip
  var lc = document.getElementById('legal-moves');
  lc.innerHTML = '';
  document.getElementById('legal-count').textContent = state.legalMoves.length;

  // Set position label
  var posLabel = state.stuckInfo ? 'at ' + state.stuckInfo.num + '.' + state.stuckInfo.color.toUpperCase() + ' ' : '';
  document.getElementById('legal-position').textContent = posLabel;

  var lbl = state.stuckInfo ? state.stuckInfo.num + '.' + state.stuckInfo.color.toUpperCase() : '';
  var stuckMove = state.stuckInfo ? state.stuckInfo.move : '';

  // Build fen at stuck position for computing arrow squares on click
  var stuckFen = null;
  if(state.stuckPly !== null){
    try {
      var tempChess = new Chess();
      for(var j = 0; j < state.stuckPly; j++){ tempChess.move(state.sans[j]); }
      stuckFen = tempChess.fen();
    } catch(e) {}
  }

  // Capture error arrow at render time (navigation may clear state.errorArrow later)
  var savedErrorArrow = state.errorArrow ? {from: state.errorArrow.from, to: state.errorArrow.to} : null;

  state.legalMoves.forEach(function(m){
    var btn = document.createElement('button');
    btn.className = 'px-1.5 py-0.5 bg-gray-600 hover:bg-gray-500 rounded text-xs';
    btn.textContent = m;
    // No tooltip - the old similarity % was misleading
    btn.onclick = function(){
      var fixObj = {
        ocr: stuckMove,
        san: m,
        similarity: 0,
        ply_str: lbl
      };
      // Compute arrow squares from stuck position
      if(stuckFen){
        try {
          var tc = new Chess(stuckFen);
          var moveObj = tc.move(m);
          if(moveObj){
            fixObj.from_square = moveObj.from;
            fixObj.to_square = moveObj.to;
          }
        } catch(e) {}
      }
      // OCR arrow from stuck move error (captured at render time)
      if(savedErrorArrow){
        fixObj.ocr_from_square = savedErrorArrow.from;
        fixObj.ocr_to_square = savedErrorArrow.to;
      }
      selectFix(fixObj, btn);
    };
    lc.appendChild(btn);
  });
}

function selectFix(fix, btn){
  state.selectedFix = fix;
  // Edit-mode detection MUST consult state.editMode (the live mode) and not
  // fix.isEditMode (a flag stamped onto fix objects when the legal-moves
  // panel was rendered for edit mode). After exitEditMode / applyFix clears
  // state.editMode, the panel's old buttons may still be in the DOM with
  // their fix.isEditMode flag set; clicking one would otherwise repaint the
  // Apply button orange even though we're back in interactive mode.
  // User-reported: "still remains orange after one double-click on a move."
  //
  // Review mode wins: if the verification walkthrough is active, never paint
  // orange. The user-flow that triggered this — double-click to edit during
  // Greedy review, apply, then re-enter review via the panel — leaves
  // state.editMode null, but earlier paths and snapshots could land here
  // with the button still orange from the edit. Forcing isEdit=false in
  // review mode keeps the Confirm button blue every time, matching the
  // panel's "Review" button color and matching the user's expectation:
  // orange is for manual edits only.
  var _reviewActive = window.VerificationUI &&
                      typeof window.VerificationUI.isActive === 'function' &&
                      window.VerificationUI.isActive();
  var isEdit = !!state.editMode && !_reviewActive;
  var hlClass = isEdit ? 'bg-blue-600/30 border-blue-500' : 'bg-green-600/30 border-green-500';
  document.querySelectorAll('#fix-list button').forEach(function(b){
    b.classList.remove('bg-green-600/30', 'border-green-500', 'bg-blue-600/30', 'border-blue-500');
    b.classList.add('bg-gray-700', 'border-gray-600');
  });
  if(btn){
    btn.classList.remove('bg-gray-700', 'border-gray-600');
    btn.classList.add(hlClass.split(' ')[0], hlClass.split(' ')[1]);
  }
  
  // Green arrow = the fix suggestion
  if(fix.from_square && fix.to_square){
    state.fixArrow = {from: fix.from_square, to: fix.to_square};
  } else {
    state.fixArrow = null;
  }

  // Red arrow = always the stuck move (restore from saved copy after navigation clears it)
  if(state.savedErrorArrow && !state.errorArrow){
    state.errorArrow = {from: state.savedErrorArrow.from, to: state.savedErrorArrow.to};
  }

  // Yellow arrow = the OCR move being substituted (what was originally read)
  if(fix.ocr_from_square && fix.ocr_to_square){
    state.ocrArrow = {from: fix.ocr_from_square, to: fix.ocr_to_square};
  } else {
    state.ocrArrow = null;
  }
  
  // DEBUG
  log('selectFix: fix_arrow from=' + fix.from_square + ' to=' + fix.to_square + ' | ocr_arrow from=' + fix.ocr_from_square + ' to=' + fix.ocr_to_square);

  // Navigate board to the fix's position (unless in edit mode)
  var fixPly = null;
  if(typeof fix.ply === 'number'){
    fixPly = fix.ply;
  } else if(fix.ply_str){
    var plyMatch = fix.ply_str.match(/^(\d+)\.(W|B)$/i);
    if(plyMatch){
      var num = parseInt(plyMatch[1]);
      var color = plyMatch[2].toLowerCase();
      fixPly = (num - 1) * 2 + (color === 'w' ? 0 : 1);
    }
  }
  if(fixPly !== null && !fix.isEditMode && !state.editMode){
    showPositionAtPly(fixPly);
  }

  renderArrows();

  // Update OCR context panel to show the fix's target position
  if(typeof fix.ply === 'number'){
    updateOcrContextPanel(fix.ply + 1); // +1 because fix.ply is 0-indexed
  } else if(fix.ply_str){
    var plyMatch = fix.ply_str.match(/^(\d+)\.(W|B)$/i);
    if(plyMatch){
      var num = parseInt(plyMatch[1]);
      var color = plyMatch[2].toLowerCase();
      var displayPly = (num - 1) * 2 + (color === 'w' ? 1 : 2);
      updateOcrContextPanel(displayPly);
    }
  }

  var applyBtn = document.getElementById('btn-apply');
  applyBtn.disabled = false;
  // Color legend in the fix panel:
  //   green  = apply (interactive mode)
  //   blue   = confirm (review mode — matches the "Review" button in the
  //            algorithm panels so the connection is obvious)
  //   orange = change/keep (edit mode — distinct from review blue)
  //   purple = insert missing move
  //   yellow = pending confirmation (2-change similarity fix)
  var isReview = window.VerificationUI &&
                 typeof window.VerificationUI.isActive === 'function' &&
                 window.VerificationUI.isActive();
  if(isEdit){
    var isSame = fix.san === fix.ocr || fix.similarity === 100;
    applyBtn.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-orange-600 hover:bg-orange-500 cursor-pointer';
    applyBtn.textContent = isSame ? '✓ Keep: ' + (fix.ply_str || '') + ' ' + fix.san : '✓ Change: ' + (fix.ply_str || '') + ' ' + fix.ocr + ' → ' + fix.san;
    hideFixDetails();
  } else if(isReview){
    applyBtn.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-blue-700 hover:bg-blue-600 cursor-pointer';
    // Show the algorithm's SAN exactly — including check/mate markers.
    // Earlier code stripped trailing +/# to "match" the algorithm's panel
    // log when the panel and the chess.js-derived button disagreed (panel
    // "R1d7+ -> Rd7" vs button "R1d7+ -> Rd7+"). User wants the EXACT
    // SAN preserved: if the algorithm says there's a check, the button
    // shows the check, and the move applied carries the check too.
    //
    // Note: this line uses the CLICKED fix's san. In review mode, that
    // fix comes from renderQuickFixes/mergeBacktrackFixes (python-chess
    // SAN against the UI's board state) which can still disagree with
    // the algorithm's stored SAN by +/#. The selectFix wrapper in
    // verification-ui.js rewrites this button text with the algorithm's
    // exact SAN when the clicked fix matches the algorithm's pick.
    applyBtn.textContent = fix.keep_as_is
      ? '✓ Confirm Keep: ' + (fix.ply_str || '') + ' ' + fix.san
      : '✓ Confirm: ' + (fix.ply_str || '') + ' ' + fix.ocr + ' → ' + (fix.san || '');
    showFixDetails(fix);
  } else {
    applyBtn.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-green-600 hover:bg-green-500 cursor-pointer';
    applyBtn.textContent = fix.keep_as_is
      ? '✓ Keep: ' + (fix.ply_str || '') + ' ' + fix.san
      : '✓ Apply: ' + (fix.ply_str || '') + ' ' + fix.ocr + ' → ' + fix.san;
    showFixDetails(fix);
  }
}

function showFixDetails(fix){
  var panel = document.getElementById('fix-details');
  var content = document.getElementById('fix-details-content');
  if(!panel || !content) return;

  // --- Summary line: 8.W Nd2→Nfd2 | sim=98% ocr=4% abs=1 | Reach:3.B | score=99
  var charSim = typeof fix.char_sim === 'number' ? fix.char_sim : (fix.similarity ? fix.similarity / 100 : 0);
  var ocrConf = fix.ocr_conf || 0;
  if(ocrConf > 0 && ocrConf < 1) ocrConf = Math.round(ocrConf * 100);
  else ocrConf = Math.round(ocrConf);
  var reachImp = fix.reach_improvement || 0;
  var absurd = fix.absurdity_count || 0;
  var score = fix.unified_score;

  var html = '<div class="flex items-center gap-2 text-xs font-mono flex-wrap">';

  if(fix.ply_str){
    html += '<span class="text-gray-400">' + fix.ply_str + '</span>';
  }
  html += '<span><span class="' + ocrColorClass(fix) + '">' + (fix.ocr || '?') + '</span>\u2192<span class="text-green-400">' + (fix.san || '?') + '</span></span>';
  html += '<span class="text-gray-600">|</span>';

  var simPct = Math.round(charSim * 100);
  var simColor = simPct >= 80 ? 'text-green-400' : simPct >= 50 ? 'text-yellow-400' : 'text-gray-400';
  var simText = 'sim=' + simPct + '%';
  if (fix.sim_source && fix.sim_source !== fix.ocr) {
    simText += ' (vs ' + fix.sim_source + ')';
  }
  html += '<span class="' + simColor + '">' + simText + '</span>';

  if(ocrConf > 0){
    html += ' <span class="text-purple-400">ocr=' + ocrConf + '%</span>';
  }
  if(absurd > 0){
    html += ' <span class="text-yellow-400">abs=' + absurd + '</span>';
  }
  if(fix.is_hanging){
    html += ' <span class="text-red-400">hanging!</span>';
  }

  var reachStr = reachLabel(fix);
  if(reachStr){
    var reachColor = fix.completes ? 'text-green-400' : (reachImp > 5 ? 'text-green-400' : 'text-blue-400');
    html += '<span class="text-gray-600">|</span><span class="' + reachColor + '">' + reachStr + '</span>';
  }

  if(typeof score === 'number'){
    html += '<span class="text-gray-600">|</span><span class="text-white font-semibold">score=' + Math.round(score) + '</span>';
  }
  html += '</div>';

  // --- Color-coded component breakdown (hover each pill for description).
  // Every scored fix (Deep Search, Phase 3, piece-confusion) now carries
  // score_components. The summary row above still renders for Quick Fix
  // OCR alts and manual legal-move picks, which have no scoring breakdown
  // by design — we just don't append a component row for those.
  if (fix.score_components) {
    var pills = [];
    Object.keys(fix.score_components).forEach(function(k) {
      var pill = renderScoreComponentPill(k, fix.score_components[k]);
      if (pill) pills.push(pill);
    });
    if (pills.length) {
      html += '<div class="mt-1.5 pt-1.5 border-t border-gray-600/60 flex flex-wrap gap-1 text-[10px] font-mono">' +
              pills.join('') + '</div>';
    }
  }

  content.innerHTML = html;
  panel.classList.remove('hidden');
}

function hideFixDetails(){
  var panel = document.getElementById('fix-details');
  if(panel) panel.classList.add('hidden');
}

function selectMissingMoveFix(mc, btn){
  // Deselect other buttons
  document.querySelectorAll('#fix-list button').forEach(function(b){
    b.classList.remove('bg-green-600/30', 'border-green-500', 'bg-purple-600/30', 'border-purple-400');
    if(b.classList.contains('bg-purple-900/30')){
      b.classList.add('border-purple-600');
    } else {
      b.classList.add('bg-gray-700', 'border-gray-600');
    }
  });

  // Highlight selected
  if(btn){
    btn.classList.remove('border-purple-600');
    btn.classList.add('bg-purple-600/30', 'border-purple-400');
  }

  // Store as selected fix with special flag
  state.selectedFix = {
    type: 'missing_move',
    inserted_move: mc.inserted_move,
    insert_at_ply: mc.insert_at_ply,
    corrected_stuck_move: mc.corrected_stuck_move,
    original_stuck_move: mc.original_stuck_move,
    completes: mc.completes
  };

  // Update apply button
  var applyBtn = document.getElementById('btn-apply');
  applyBtn.disabled = false;
  applyBtn.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-purple-600 hover:bg-purple-500 cursor-pointer';
  applyBtn.textContent = '✓ Insert: ' + mc.inserted_move + (mc.corrected_stuck_move ? ' + fix' : '');

  log('Selected missing move: INSERT ' + mc.inserted_move);
}

function applyMissingMoveFix(){
  if(!state.selectedFix || state.selectedFix.type !== 'missing_move') return;

  var mc = state.selectedFix;
  var insertPly = mc.insert_at_ply;

  log('✓ Inserted missing move: ' + mc.inserted_move + ' at ply ' + insertPly);

  // Same rationale as applyFix: inserting a missing move means validation
  // has progressed past the noise tail; clear the flag so exitEditMode and
  // the snapshot don't keep the yellow panel alive.
  state.pendingNoiseReview = false;

  if(state.ocrCells && state.ocrCells.length > 0 && typeof insertSingleMove === 'function'){
    // Use metadata-preserving insert (handles ocrCells + tracking arrays)
    insertSingleMove(insertPly, mc.inserted_move);
    // Apply correction to the next move if needed (now shifted by +1)
    if(mc.corrected_stuck_move && insertPly + 1 < state.ocrCells.length){
      state.ocrCells[insertPly + 1].move = mc.corrected_stuck_move;
      log('✓ Also corrected: ' + mc.original_stuck_move + ' → ' + mc.corrected_stuck_move);
      rebuildFromOcrCells();
      revalidate();
    }
  } else {
    // Non-OCR fallback: operate on sans directly
    state.sans.splice(insertPly, 0, mc.inserted_move);
    if(mc.corrected_stuck_move && insertPly + 1 < state.sans.length){
      state.sans[insertPly + 1] = mc.corrected_stuck_move;
    }
    if(mc.corrected_stuck_move){
      log('✓ Also corrected: ' + mc.original_stuck_move + ' → ' + mc.corrected_stuck_move);
    }
    rebuildMovesFromSans();
    revalidate();
  }
}

function rebuildMovesFromSans(){
  // Rebuild the paired moves structure from the flat sans array
  state.moves = [];
  for(var i = 0; i < state.sans.length; i += 2){
    var num = Math.floor(i/2) + 1;
    state.moves.push({
      num: num,
      white: state.sans[i] || '',
      black: state.sans[i + 1] || '',
      wStatus: 'ok',
      bStatus: state.sans[i + 1] ? 'ok' : 'pending',
      wConf: 0.9,
      bConf: 0.9
    });
  }
}

function applyFix(){
  if(!state.selectedFix) return;

  // Handle missing move type
  if(state.selectedFix.type === 'missing_move'){
    applyMissingMoveFix();
    return;
  }

  var fix = state.selectedFix;
  // Same rationale as selectFix: trust the live state.editMode, not the
  // potentially stale fix.isEditMode flag. Otherwise an old edit-mode fix
  // object that survived in state.selectedFix could push applyFix down the
  // edit path even after the user exited edit mode.
  var isEdit = !!state.editMode;

  // If in edit mode and selecting same move, just exit
  if(isEdit && (fix.san === fix.ocr || fix.similarity === 100)){
    log('✓ Kept move unchanged: ' + fix.san);
    exitEditMode();
    return;
  }
  
  var fixPlyStr = fix.ply_str || '';
  var fixMatch = fixPlyStr.match(/^(\d+)\.(W|B)$/i);
  var fixNum, fixColor, fixPly;
  if(fixMatch){
    fixNum = parseInt(fixMatch[1]);
    fixColor = fixMatch[2].toLowerCase();
    fixPly = (fixNum - 1) * 2 + (fixColor === 'w' ? 0 : 1);
  } else if(typeof fix.ply === 'number'){
    fixPly = fix.ply;
    fixNum = Math.floor(fix.ply/2) + 1;
    fixColor = fix.ply % 2 === 0 ? 'w' : 'b';
  } else if(state.editMode){
    fixNum = state.editMode.num;
    fixColor = state.editMode.color;
    fixPly = state.editMode.ply;
  } else {
    log('⚠ Warning: Fix missing ply info');
    fixNum = state.stuckInfo ? state.stuckInfo.num : 0;
    fixColor = state.stuckInfo ? state.stuckInfo.color : 'w';
    fixPly = (fixNum - 1) * 2 + (fixColor === 'w' ? 0 : 1);
  }
  var isKeepAsIs = fix.keep_as_is;

  // Strict-disambig guard for keep-as-is — refuse to lock a SAN that
  // can't be played AS WRITTEN at this position. chess.js silently
  // resolves wrong file/rank disambiguators (e.g. "Red8" with no e-rook
  // plays as Rad8); locking such a SAN would leave the movelist showing
  // "Red8 ✓" while the board navigates to Rad8 — a movelist/board
  // divergence reported as "terrible". _strictMove (navigation.js)
  // validates the disambiguator against the resolved move's from-square.
  // Lives here (not earlier in selectFix) so the user sees the warning
  // only when they commit, mirroring how illegality surfaces elsewhere.
  if (isKeepAsIs && typeof Chess === 'function' && typeof _strictMove === 'function') {
    var _kChess = new Chess();
    var _kSansOk = true;
    for (var _ki = 0; _ki < fixPly; _ki++) {
      if (!_kChess.move(state.sans[_ki])) { _kSansOk = false; break; }
    }
    if (_kSansOk && !_strictMove(_kChess, fix.san)) {
      log('⚠ Cannot Keep "' + fix.san + '" at ' + fixNum + '.' + fixColor.toUpperCase() +
          ' — not playable as written (illegal or wrong disambiguator). ' +
          'Pick a fix from the suggestions instead.');
      return;
    }
  }

  log((isKeepAsIs ? 'Locked' : 'Applied fix') + ' at ' + fixNum + '.' + fixColor.toUpperCase() + ': ' + (fix.ocr || '?') + ' -> ' + fix.san);

  // Show flash notification with num_changes (user-chosen fix, not auto)
  if(fix.ocr && fix.san && fix.ocr !== fix.san){
    showAutoFixFlash(fix.ocr, fix.san, fix.num_changes, 'Fixed');
  }

  // Determine status: 'locked' if keep-as-is, 'fixed' otherwise
  var newStatus = isKeepAsIs ? 'locked' : 'fixed';
  for(var i = 0; i < state.moves.length; i++){
    if(state.moves[i].num === fixNum){
      if(fixColor === 'w'){
        if(!state.moves[i].wOriginal) state.moves[i].wOriginal = state.moves[i].white;
        state.moves[i].white = fix.san;
        state.moves[i].wStatus = newStatus;
      } else {
        if(!state.moves[i].bOriginal) state.moves[i].bOriginal = state.moves[i].black;
        state.moves[i].black = fix.san;
        state.moves[i].bStatus = newStatus;
      }
      break;
    }
  }

  // Update confirmed ply - we've confirmed everything up to and including this fix
  state.confirmedPly = Math.max(state.confirmedPly, fixPly + 1);

  if (isKeepAsIs) {
    // LOCKED: user confirmed OCR is correct — sacred, never search this ply again
    if (!state.lockedPlies) state.lockedPlies = [];
    if (state.lockedPlies.indexOf(fixPly) === -1) {
      state.lockedPlies.push(fixPly);
    }
    log('🔒 LOCKED ply ' + fixNum + '.' + fixColor.toUpperCase() + ' — will never be searched again');
  } else {
    // FIXED: user chose a fix — protected but Phase 2 can revisit
    if (!state.fixedPlies) state.fixedPlies = [];
    if (state.fixedPlies.indexOf(fixPly) === -1) {
      state.fixedPlies.push(fixPly);
    }
  }
  log('🔒 Confirmed ply updated to: ' + state.confirmedPly + ', fixed_plies=[' + state.fixedPlies.join(',') + '], locked_plies=[' + (state.lockedPlies||[]).join(',') + ']');

  // Send live hint to background search workers (if running)
  if(window.searchManager && typeof fixPly === 'number'){
    window.searchManager.sendUserFix(fixPly, fix.san);
  }

  // Clear edit mode and pending confirmation before revalidate
  if(state.editMode){
    state.editMode = null;
    document.getElementById('fix-panel-title').textContent = 'Fix Suggestions';
  }
  state.pendingConfirmation = null;
  // Clear the selected fix too. Without this, state.selectedFix keeps the
  // fix object with isEditMode=true, and any subsequent render that re-runs
  // selectFix (e.g. entering Greedy review paints the Confirm button via
  // selectFix → line 496-510) sees isEdit truthy and repaints the button in
  // the orange edit-mode colour instead of the blue review-mode colour.
  // User-reported: after editing a move, the Confirm button stayed orange
  // even after entering Greedy review.
  state.selectedFix = null;

  // Successfully applying a chess fix means validation has run past the
  // noise tail — the yellow noise-review panel is no longer relevant.
  // Without clearing the flag here, exitEditMode below would re-paint the
  // panel (fixes.js:1241) and the next snapshot would persist
  // pendingNoiseReview=true, so re-entering the game keeps re-rendering
  // the panel and skips auto-verify (batch-game-list.js:1015).
  state.pendingNoiseReview = false;

  // Clear the button's stale text/color now that no fix is selected.
  // revalidate() below either finds a new stuck point (fetchFixes paints
  // the button from scratch) or reports "Game complete!" (no stuck point,
  // so nothing repaints) — without this reset, "Game complete!" would
  // appear next to an orange "Change: X → Y" button from the just-applied
  // edit.
  resetApplyButton();

  // UNDO QUICK FIXES AFTER THIS PLY
  // Quick fixes applied after fixPly were based on the OLD (wrong) position.
  // Now that we've changed the position at fixPly, those quick fixes might be wrong.
  // Restore original OCR values so revalidation can re-evaluate them.
  var undoneCount = 0;
  for(var j = 0; j < state.moves.length; j++){
    var m = state.moves[j];
    var wPly = (m.num - 1) * 2;
    var bPly = wPly + 1;

    // Check white move - if it was auto-corrected and is AFTER our fix
    if(m.wOriginal && wPly > fixPly && m.wStatus !== 'fixed' && m.wStatus !== 'locked'){
      log('↩️ Undoing quick fix at ' + m.num + '.W: "' + m.white + '" -> "' + m.wOriginal + '" (will re-evaluate)');
      m.white = m.wOriginal;
      m.wOriginal = null;
      m.wOcrAlt = false;
      m.wStatus = 'pending';
      undoneCount++;
    }

    // Check black move - if it was auto-corrected and is AFTER our fix
    if(m.bOriginal && bPly > fixPly && m.bStatus !== 'fixed' && m.bStatus !== 'locked'){
      log('↩️ Undoing quick fix at ' + m.num + '.B: "' + m.black + '" -> "' + m.bOriginal + '" (will re-evaluate)');
      m.black = m.bOriginal;
      m.bOriginal = null;
      m.bOcrAlt = false;
      m.bStatus = 'pending';
      undoneCount++;
    }
  }
  if(undoneCount > 0){
    log('↩️ Undid ' + undoneCount + ' quick fix(es) after ply ' + fixPly + ' - revalidating with original OCR');
  }

  revalidate();

  // In batch mode, the side-panel Greedy/Beam/Dijkstra results were computed
  // against the PRE-fix OCR. Ask the orchestrator to re-queue this game so
  // the panels reflect the corrected input. This aborts in-flight work on
  // Beam/Dijkstra and restarts Greedy from confirmedPly; escalation follows
  // normally if Greedy fails again.
  if (window.BatchGameList && window.BatchGameList.batchState &&
      window.BatchGameList.batchState.active &&
      typeof window.BatchGameList.requeueAfterFix === 'function') {
    try { window.BatchGameList.requeueAfterFix(); } catch (e) {
      console.warn('[Batch] requeueAfterFix call failed:', e);
    }
  }
}

// =============================================================================
// REVERT TO ORIGINAL OCR
// =============================================================================

function revertToOriginalOcr(num, color){
  for(var i = 0; i < state.moves.length; i++){
    if(state.moves[i].num === num){
      if(color === 'w' && state.moves[i].wOriginal){
        log('↩ Reverting ' + num + '.W to original OCR: ' + state.moves[i].wOriginal);
        state.moves[i].white = state.moves[i].wOriginal;
        state.moves[i].wOriginal = null;
        state.moves[i].wStatus = 'pending';
      } else if(color === 'b' && state.moves[i].bOriginal){
        log('↩ Reverting ' + num + '.B to original OCR: ' + state.moves[i].bOriginal);
        state.moves[i].black = state.moves[i].bOriginal;
        state.moves[i].bOriginal = null;
        state.moves[i].bStatus = 'pending';
      }
      break;
    }
  }
  // Remove from fixedPlies/lockedPlies so revalidation treats it fresh
  var ply = (num - 1) * 2 + (color === 'w' ? 0 : 1);
  if(state.fixedPlies){
    var idx = state.fixedPlies.indexOf(ply);
    if(idx !== -1) state.fixedPlies.splice(idx, 1);
  }
  if(state.lockedPlies){
    var idx = state.lockedPlies.indexOf(ply);
    if(idx !== -1) state.lockedPlies.splice(idx, 1);
  }
  revalidate();
}

// =============================================================================
// EDIT MODE
// =============================================================================

function enterEditMode(num, color){
  // Find the move
  var moveEntry = null;
  for(var i = 0; i < state.moves.length; i++){
    if(state.moves[i].num === num){
      moveEntry = state.moves[i];
      break;
    }
  }
  if(!moveEntry) return;
  var currentMove = color === 'w' ? moveEntry.white : moveEntry.black;
  if(!currentMove) return;

  // Calculate ply (0-indexed) for this move
  var ply = (num - 1) * 2 + (color === 'w' ? 0 : 1);

  state.editMode = {num: num, color: color, currentMove: currentMove, ply: ply};
  log('✏️ Edit mode: ' + num + '.' + color.toUpperCase() + ' ' + currentMove);

  // CLEAR stale state from the prior stuck flow. Without this, the Apply
  // button and "All legal moves" panel can still show the previous stuck
  // fix (e.g., "Change: 35.B Rxd7 → a5") even though we just entered edit
  // mode for a different ply (e.g., 35.W). renderEditModeMoves will
  // repopulate Apply-button state via selectFix(keepFix) once it finishes
  // its async work.
  state.selectedFix = null;
  state.fixArrow = null;
  state.ocrArrow = null;
  state.errorArrow = null;
  state.savedErrorArrow = null;
  var applyBtnEdit = document.getElementById('btn-apply');
  if (applyBtnEdit) {
    applyBtnEdit.disabled = true;
    applyBtnEdit.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-gray-700 text-gray-400 cursor-not-allowed';
    applyBtnEdit.textContent = 'Select a move';
  }
  hideFixDetails();

  // Update panel title with cancel button
  document.getElementById('fix-panel-title').innerHTML =
    '<span class="text-blue-400">✏️ Editing ' + num + '.' + color.toUpperCase() + '</span> ' +
    '<button id="btn-cancel-edit" class="text-xs text-gray-400 hover:text-white ml-2">✕ Cancel</button>';
  document.getElementById('btn-cancel-edit').onclick = exitEditMode;

  // Update stuck info area with sort toggle
  document.getElementById('stuck-info').innerHTML =
    '<span class="text-blue-300">Select a move:</span> ' +
    '<button id="btn-sort-toggle" class="ml-2 px-2 py-0.5 text-xs rounded bg-gray-600 hover:bg-gray-500" title="Click to change sort order">' +
    (state.editSortMode === 'alpha' ? '🔤 A-Z' : '🎯 Similar') +
    '</button>';
  document.getElementById('btn-sort-toggle').onclick = toggleEditSortMode;

  document.getElementById('source-preview').classList.add('hidden');

  // Navigate to this position
  goToPly(ply);

  // Refresh the "All legal moves" panel (labelled with edit target, not the
  // old stuck ply). state.stuckInfo stays pointed at the prior stuck state
  // so exitEditMode can restore it — we override the label via editMode.
  _refreshLegalMovesForEditMode(num, color, ply);

  // Render moves with current sort mode
  renderEditModeMoves(num, color, currentMove, ply);
}

function toggleEditSortMode(){
  if(!state.editMode) return;

  state.editSortMode = (state.editSortMode === 'alpha') ? 'similarity' : 'alpha';

  // Update toggle button text
  var btn = document.getElementById('btn-sort-toggle');
  if(btn){
    btn.textContent = (state.editSortMode === 'alpha') ? '🔤 A-Z' : '🎯 Similar';
  }

  // Re-render moves with new sort
  renderEditModeMoves(
    state.editMode.num,
    state.editMode.color,
    state.editMode.currentMove,
    state.editMode.ply
  );
}

async function renderEditModeMoves(num, color, currentMove, ply){
  var container = document.getElementById('fix-list');
  container.innerHTML = '<div class="text-gray-400 text-sm p-4 text-center">Loading...</div>';

  // Get legal moves at this position
  if(!chess) return;

  chess.reset();
  for(var j = 0; j < ply; j++){
    try{ chess.move(state.sans[j]); } catch(e){ break; }
  }
  var legalMoves = chess.moves();

  // Verbose legal moves give us from/to per SAN so the green fix-arrow on
  // the board updates as the user clicks through edit-mode candidates,
  // matching the behavior of the normal fix-suggestion list. Without this
  // the fix objects below have no from_square/to_square and selectFix
  // clears state.fixArrow — so the board sat with no arrow during edits.
  var legalVerbose = chess.moves({ verbose: true });
  var sanToFromTo = {};
  legalVerbose.forEach(function(mv) {
    if (mv && mv.san) sanToFromTo[mv.san] = { from: mv.from, to: mv.to };
  });
  var ocrSquares = sanToFromTo[currentMove] || null;

  // Check if current move is legal
  var currentIsLegal = legalMoves.indexOf(currentMove) !== -1;

  // Get sorted moves based on mode
  var sortedMoves;
  if(state.editSortMode === 'similarity'){
    // Call backend for similarity scores
    sortedMoves = await getSimilaritySortedMoves(legalMoves, currentMove);
  } else {
    // Sort alphabetically by piece type then move
    sortedMoves = legalMoves.map(function(san){
      return {san: san, sim: null};
    }).sort(function(a, b){
      return compareMoveAlpha(a.san, b.san);
    });
  }

  // Render
  container.innerHTML = '';

  // "Keep original" button if move is legal
  if(currentIsLegal){
    var keepBtn = document.createElement('button');
    keepBtn.className = 'w-full text-left p-2.5 rounded-lg border bg-green-600/30 border-green-500 mb-2';
    keepBtn.innerHTML = '<div class="flex justify-between items-center">' +
      '<span class="font-mono text-sm">✓ <span class="text-green-400">' + currentMove + '</span> ' +
      '<span class="text-green-300">(keep original)</span></span></div>';
    keepBtn.title = 'Keep the current move unchanged';
    var keepFix = {san: currentMove, ocr: currentMove, similarity: 100, ply_str: num + '.' + color.toUpperCase(), ply: ply, isEditMode: true};
    if (ocrSquares) {
      keepFix.from_square = ocrSquares.from;
      keepFix.to_square = ocrSquares.to;
      // Same square pair on the OCR arrow so the user sees one arrow
      // (overlapping yellow + green) for "keep" — distinct from the
      // change-to candidates which draw separate yellow (OCR) and green
      // (target) arrows.
      keepFix.ocr_from_square = ocrSquares.from;
      keepFix.ocr_to_square = ocrSquares.to;
    }
    keepBtn.onclick = function(){ selectFix(keepFix, keepBtn); };
    keepBtn.ondblclick = function(){ selectFix(keepFix, keepBtn); applyFix(); };
    container.appendChild(keepBtn);
    selectFix(keepFix, keepBtn);

    // Separator
    var sep = document.createElement('div');
    sep.className = 'text-xs text-gray-500 my-2 border-t border-gray-600 pt-2';
    sep.textContent = 'Or change to:';
    container.appendChild(sep);
  }

  // Render sorted moves
  var firstSelectable = null;
  sortedMoves.forEach(function(item, i){
    // Skip current move if already shown as "keep"
    if(currentIsLegal && item.san === currentMove) return;

    var btn = document.createElement('button');
    btn.className = 'w-full text-left p-2.5 rounded-lg border bg-gray-700 hover:bg-gray-600 border-gray-600';
    btn.title = 'Click to select • Double-click to apply';

    // Show similarity if available
    var simLabel = '';
    if(item.sim !== null && state.editSortMode === 'similarity'){
      var simClass = item.sim >= 60 ? 'text-green-400' : item.sim >= 40 ? 'text-yellow-400' : 'text-gray-400';
      simLabel = '<span class="' + simClass + ' text-xs">' + item.sim + '%</span>';
    }

    btn.innerHTML = '<div class="flex justify-between items-center">' +
      '<span class="font-mono text-sm"><span class="text-blue-400">' + item.san + '</span></span>' +
      simLabel + '</div>';

    var fix = {san: item.san, ocr: currentMove, similarity: item.sim || 0, ply_str: num + '.' + color.toUpperCase(), ply: ply, isEditMode: true};
    var candSquares = sanToFromTo[item.san];
    if (candSquares) {
      fix.from_square = candSquares.from;
      fix.to_square = candSquares.to;
    }
    if (ocrSquares) {
      fix.ocr_from_square = ocrSquares.from;
      fix.ocr_to_square = ocrSquares.to;
    }
    btn.onclick = function(){ selectFix(fix, btn); };
    btn.ondblclick = function(){ selectFix(fix, btn); applyFix(); };
    container.appendChild(btn);

    // Track first selectable if current wasn't legal
    if(!currentIsLegal && !firstSelectable){
      firstSelectable = {fix: fix, btn: btn};
    }
  });

  // Auto-select first if current move wasn't legal
  if(!currentIsLegal && firstSelectable){
    selectFix(firstSelectable.fix, firstSelectable.btn);
  }

  // --- Insert/Delete section ---
  var structSep = document.createElement('div');
  structSep.className = 'text-xs text-gray-500 my-2 border-t border-gray-600 pt-2';
  structSep.textContent = 'Structural edits:';
  container.appendChild(structSep);

  if (typeof insertSingleMove === 'function') {
    var isDual = state.inputMode === 'dual-sheets';

    if (isDual) {
      // Dual-mode: show operations for BOTH sheets since each sheet
      // records the full game and shifts can affect either sheet
      var moveNumForSheet = num;

      // --- White's sheet ---
      var wLabel = document.createElement('div');
      wLabel.className = 'text-xs text-gray-500 mt-1 mb-1';
      wLabel.textContent = "White's sheet:";
      container.appendChild(wLabel);

      var wInsB = document.createElement('button');
      wInsB.className = 'w-full text-left p-2 rounded-lg border bg-purple-900/30 hover:bg-purple-800/40 border-purple-600/50 text-purple-400 mb-1 text-sm';
      wInsB.innerHTML = "⬆ Insert before on White's sheet";
      wInsB.onclick = function(){ insertDualMove(moveNumForSheet, 'w', 'before'); };
      container.appendChild(wInsB);

      var wInsA = document.createElement('button');
      wInsA.className = 'w-full text-left p-2 rounded-lg border bg-purple-900/30 hover:bg-purple-800/40 border-purple-600/50 text-purple-400 mb-1 text-sm';
      wInsA.innerHTML = "⬇ Insert after on White's sheet";
      wInsA.onclick = function(){ insertDualMove(moveNumForSheet, 'w', 'after'); };
      container.appendChild(wInsA);

      var wDel = document.createElement('button');
      wDel.className = 'w-full text-left p-2 rounded-lg border bg-orange-900/30 hover:bg-orange-800/40 border-orange-600/50 text-orange-400 mb-1.5 text-sm';
      wDel.innerHTML = "🗑️ Delete from White's sheet (shift up)";
      wDel.onclick = function(){ showDualDeleteConfirmation(moveNumForSheet, 'w'); };
      container.appendChild(wDel);

      // --- Black's sheet ---
      var bLabel = document.createElement('div');
      bLabel.className = 'text-xs text-gray-500 mt-1 mb-1';
      bLabel.textContent = "Black's sheet:";
      container.appendChild(bLabel);

      var bInsB = document.createElement('button');
      bInsB.className = 'w-full text-left p-2 rounded-lg border bg-purple-900/30 hover:bg-purple-800/40 border-purple-600/50 text-purple-400 mb-1 text-sm';
      bInsB.innerHTML = "⬆ Insert before on Black's sheet";
      bInsB.onclick = function(){ insertDualMove(moveNumForSheet, 'b', 'before'); };
      container.appendChild(bInsB);

      var bInsA = document.createElement('button');
      bInsA.className = 'w-full text-left p-2 rounded-lg border bg-purple-900/30 hover:bg-purple-800/40 border-purple-600/50 text-purple-400 mb-1 text-sm';
      bInsA.innerHTML = "⬇ Insert after on Black's sheet";
      bInsA.onclick = function(){ insertDualMove(moveNumForSheet, 'b', 'after'); };
      container.appendChild(bInsA);

      var bDel = document.createElement('button');
      bDel.className = 'w-full text-left p-2 rounded-lg border bg-orange-900/30 hover:bg-orange-800/40 border-orange-600/50 text-orange-400 mb-1.5 text-sm';
      bDel.innerHTML = "🗑️ Delete from Black's sheet (shift up)";
      bDel.onclick = function(){ showDualDeleteConfirmation(moveNumForSheet, 'b'); };
      container.appendChild(bDel);
    } else {
      // Single-player: insert/delete shifting all subsequent moves
      var insertBeforeBtn = document.createElement('button');
      insertBeforeBtn.className = 'w-full text-left p-2.5 rounded-lg border bg-purple-900/30 hover:bg-purple-800/40 border-purple-600/50 text-purple-400 mb-1.5';
      insertBeforeBtn.innerHTML = '⬆ Insert move before this one';
      insertBeforeBtn.onclick = function(){ insertSingleMove(ply); };
      container.appendChild(insertBeforeBtn);

      var insertAfterBtn = document.createElement('button');
      insertAfterBtn.className = 'w-full text-left p-2.5 rounded-lg border bg-purple-900/30 hover:bg-purple-800/40 border-purple-600/50 text-purple-400 mb-1.5';
      insertAfterBtn.innerHTML = '⬇ Insert move after this one';
      insertAfterBtn.onclick = function(){ insertSingleMove(ply + 1); };
      container.appendChild(insertAfterBtn);

      var delSingleBtn = document.createElement('button');
      delSingleBtn.className = 'w-full text-left p-2.5 rounded-lg border bg-orange-900/30 hover:bg-orange-800/40 border-orange-600/50 text-orange-400 mb-1.5';
      delSingleBtn.innerHTML = '🗑️ Delete this move (shift up)';
      delSingleBtn.onclick = function(){ showDeleteSingleConfirmation(ply); };
      container.appendChild(delSingleBtn);
    }
  }

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'w-full text-left p-2.5 rounded-lg border bg-red-900/30 hover:bg-red-800/40 border-red-600/50 text-red-400';
  deleteBtn.innerHTML = '✂ Delete from here onward';
  deleteBtn.onclick = function(){
    exitEditMode();
    showDeleteConfirmation(ply);
  };
  container.appendChild(deleteBtn);

  document.getElementById('legal-count').textContent = legalMoves.length;
}

// Paint the "All legal moves at X" panel for the current edit target. Without
// this, the panel keeps the stuck-ply's label and move list (e.g., "35.B"
// with black's legal moves) even after we enter edit mode for a different
// ply. Structure mirrors renderLegalMoves but drives from edit context
// instead of state.stuckInfo.
function _refreshLegalMovesForEditMode(num, color, ply){
  if(!chess) return;
  var lc = document.getElementById('legal-moves');
  var posEl = document.getElementById('legal-position');
  var cntEl = document.getElementById('legal-count');
  if(!lc || !posEl || !cntEl) return;

  chess.reset();
  for(var j = 0; j < ply; j++){
    try{ chess.move(state.sans[j]); } catch(e){ break; }
  }
  var legalAtEdit = chess.moves();

  var lbl = num + '.' + color.toUpperCase();
  posEl.textContent = 'at ' + lbl + ' ';
  cntEl.textContent = legalAtEdit.length;

  lc.innerHTML = '';
  legalAtEdit.forEach(function(m){
    var btn = document.createElement('button');
    btn.className = 'px-1.5 py-0.5 bg-gray-600 hover:bg-gray-500 rounded text-xs';
    btn.textContent = m;
    btn.onclick = function(){
      var fixObj = {
        ocr: state.editMode ? state.editMode.currentMove : '',
        san: m,
        similarity: 0,
        ply_str: lbl,
        ply: ply,
        isEditMode: true
      };
      selectFix(fixObj, btn);
    };
    lc.appendChild(btn);
  });
}

function exitEditMode(){
  if(!state.editMode) return;
  log('✏️ Exited edit mode');
  state.editMode = null;
  state.selectedFix = null;
  state.fixArrow = null;
  state.ocrArrow = null;
  clearBoardSelection();

  // Wipe the orange edit-mode styling so it doesn't linger. The next
  // selectFix() call will paint the correct color for whatever mode the
  // user ends up in (interactive green, review blue, etc.).
  resetApplyButton();

  // Rebuild the "All legal moves" panel from the stuck state (it was
  // temporarily overridden for the edit target).
  if (typeof renderLegalMoves === 'function') {
    try { renderLegalMoves(); } catch (e) { /* non-fatal */ }
  }

  // Restore panel title
  document.getElementById('fix-panel-title').textContent = 'Fix Suggestions';

  // If in noise review mode, restore the noise review UI — but only when
  // no chess fixes have been applied yet. If state.moves has any 'fixed' or
  // 'locked' status, the user is past the noise stage; re-painting the
  // yellow panel here is what makes it "come back" after the user has
  // already worked through the game. Clear the stale flag too so the next
  // snapshot doesn't persist it. See applyFix / applyMissingMoveFix /
  // truncateTrailingNoise for the other clear sites.
  var _userHasFixes = false;
  if (state.moves) {
    for (var _i = 0; _i < state.moves.length; _i++) {
      var _m = state.moves[_i];
      if (_m.wStatus === 'fixed' || _m.wStatus === 'locked' ||
          _m.bStatus === 'fixed' || _m.bStatus === 'locked') {
        _userHasFixes = true;
        break;
      }
    }
  }
  if (state.pendingNoiseReview && _userHasFixes) {
    state.pendingNoiseReview = false;
  }
  if(state.pendingNoiseReview){
    document.getElementById('stuck-info').innerHTML =
      '<div class="text-yellow-400">⚠️ Potential OCR noise at end</div>' +
      '<div class="text-xs text-gray-400 mt-1">Review highlighted moves and delete noise before continuing</div>';
    document.getElementById('fix-list').innerHTML =
      '<div class="p-3 bg-yellow-900/30 rounded border border-yellow-700 mb-3">' +
        '<div class="text-yellow-300 text-sm font-medium mb-2">🗑️ Low-confidence moves detected</div>' +
        '<div class="text-xs text-gray-300 mb-3">Click 🗑️ next to any move to delete it and all moves after.</div>' +
        '<button id="btn-continue-validation" class="w-full py-2 bg-green-600 hover:bg-green-500 rounded text-sm font-medium">✓ Continue to Validation</button>' +
      '</div>';
    document.getElementById('btn-continue-validation').onclick = function(){
      state.pendingNoiseReview = false;
      document.getElementById('stuck-info').innerHTML = '<span class="text-blue-300">🔍 Validating...</span>';
      document.getElementById('fix-list').innerHTML = '<div class="text-gray-400 text-sm p-4 text-center">Checking moves...</div>';
      revalidate();
      // Mirror ocr.js's original Continue-to-Validation handler: in batch
      // mode, mark the game's noise as resolved so the auto-VERIFY guard
      // in _saveGameWorkingState can pass. Without this, a game where the
      // user navigated back from editing (which re-renders the noise UI
      // through this fixes.js copy of the panel) and then committed the
      // truncation here stayed IN_REVIEW / NEEDS_REVIEW forever —
      // game.hasTrailingNoise never flipped to false. Reported: B9
      // oscillating between 🔍 and 🟡 after walking the game through to
      // "🎉 Game complete! 80 moves".
      if (window.BatchGameList && window.BatchGameList.batchState &&
          window.BatchGameList.batchState.active &&
          typeof window.BatchGameList.onTruncationComplete === 'function') {
        try {
          window.BatchGameList.onTruncationComplete(
            window.BatchGameList.batchState.currentGameId);
        } catch (e) { /* non-fatal */ }
      }
    };
    renderArrows();
    return;
  }

  // If we have a stuck position, go back to showing fixes
  if(state.stuckInfo){
    fetchFixes();
  } else {
    document.getElementById('stuck-info').innerHTML = '<span class="text-green-400">✓ All moves valid!</span>';
    document.getElementById('fix-list').innerHTML = '<div class="text-green-400 text-sm p-4 text-center">🎉 Game complete!</div>';
    resetApplyButton();
  }
  renderArrows();
}

// =============================================================================
// QUICK FIXES - Instant OCR alternatives (before backtracking)
// =============================================================================

/**
 * Compute quick fixes from OCR alternatives at the stuck ply.
 * These are shown IMMEDIATELY while backtracking runs in background.
 * Only shows legal moves from the OCR beam decoder candidates.
 */
async function computeQuickFixes() {
  if (!state.stuckInfo || state.stuckPly === null) return [];

  // Target the red-arrow ply, not the focus ply. ocrColorClass uses
  // `originStuckPly || stuckPly` to decide red vs yellow on the same
  // convention; Quick Fixes follow suit so the alternatives offered are
  // for the move that's actually broken (red arrow), not for the
  // backtrack candidate the walkthrough is currently focused on. In
  // interactive mode `originStuckPly` is null and this is just stuckPly.
  // In Review with a backtrack-focused fix, `originStuckPly` points at
  // the actual stuck (e.g., 4.B's bad-trade `e6`) while stuckPly points
  // at the candidate ply Greedy proposed to fix it (e.g., 4.W's `e4`).
  // Quick Fixes for 4.B = alternatives to the broken move, which is
  // what the user is trying to choose between.
  var ply = (typeof state.originStuckPly === 'number') ? state.originStuckPly : state.stuckPly;
  var moveNum = Math.floor(ply / 2);
  var isWhite = ply % 2 === 0;
  var moveEntry = state.moves[moveNum];
  if (!moveEntry) return [];

  // Get OCR alternatives for this ply
  var alts = isWhite ? moveEntry.wAlts : moveEntry.bAlts;
  var lenientAlts = isWhite ? (moveEntry.wLenientAlts || []) : (moveEntry.bLenientAlts || []);
  var topMove = isWhite ? moveEntry.white : moveEntry.black;
  var topConf = isWhite ? moveEntry.wConf : moveEntry.bConf;

  // Build board position at the target ply.
  if (!chess) return [];
  chess.reset();
  for (var j = 0; j < ply; j++) {
    try { chess.move(state.sans[j]); } catch (e) { break; }
  }

  var quickFixes = [];
  var seenMoves = new Set();
  // Label from the target ply, not state.stuckInfo (which reflects the
  // focus ply in Review). Keeps the "[QUICK-FIX] 4.B …" log lines and
  // ply_str on each fix consistent with the row Quick Fixes is operating on.
  var lbl = (moveNum + 1) + '.' + (isWhite ? 'W' : 'B');

  // === Section 0: Try normalizing the illegal top move itself as lenient notation ===
  // If OCR decoded "e5xd4" or "Nf3-e5" etc., the top move IS the lenient candidate.
  var legalMovesForNorm = chess.moves();
  if (topMove) {
    var topNormalized = _normalizeLenientJS(topMove, chess, legalMovesForNorm);
    if (topNormalized && topNormalized !== topMove) {
      try {
        var result = chess.move(topNormalized);
        if (result) {
          chess.undo();
          seenMoves.add(topNormalized);
          var sim = Math.round(charSimilarity(topMove, topNormalized));
          quickFixes.push({
            ocr: topMove, san: topNormalized, similarity: sim,
            ocr_conf: Math.round(topConf * 100), ply: ply, ply_str: lbl,
            source: 'lenient_grammar', source_raw: topMove,
            is_quick_fix: true,
            from_square: result.from, to_square: result.to,
            ocr_from_square: state.errorArrow ? state.errorArrow.from : null,
            ocr_to_square: state.errorArrow ? state.errorArrow.to : null
          });
          console.log('[QUICK-FIX] Top move "' + topMove + '" is lenient notation → "' + topNormalized + '" (legal, conf=' + Math.round(topConf * 100) + '%)');
        }
      } catch (e) {}
    }
  }

  // === Section 1: Standard OCR alternatives ===
  if (alts && alts.length > 0) {
    alts.forEach(function(alt) {
      var move = Array.isArray(alt) ? alt[0] : (alt.move || alt);
      var conf = Array.isArray(alt) ? (alt[1] || 0.1) : (alt.confidence || 0.1);

      if (move === topMove || seenMoves.has(move)) return;

      try {
        var result = chess.move(move);
        if (result) {
          chess.undo();
          seenMoves.add(move);
          var sim = Math.round(charSimilarity(topMove, move));
          quickFixes.push({
            ocr: topMove, san: move, similarity: sim,
            ocr_conf: Math.round(conf * 100), ply: ply, ply_str: lbl,
            source: 'ocr_alternative', is_quick_fix: true,
            from_square: result.from, to_square: result.to,
            ocr_from_square: state.errorArrow ? state.errorArrow.from : null,
            ocr_to_square: state.errorArrow ? state.errorArrow.to : null
          });
        }
      } catch (e) {}
    });
    console.log('[QUICK-FIX] ' + alts.length + ' strict OCR alts → ' + quickFixes.length + ' legal');
  }

  // === Section 2: Lenient grammar alternatives ===
  // These are non-standard notations (Pe4, cd, BxN, Nf3-e5, 0-0) that need
  // normalization to standard SAN before checking legality.
  var lenientCount = 0;
  if (lenientAlts && lenientAlts.length > 0) {
    console.log('[QUICK-FIX] ' + lenientAlts.length + ' lenient alts to check: ' +
      lenientAlts.map(function(a) { return a.move || a; }).join(', '));

    // Get legal moves for normalization context
    var legalMoves = chess.moves();

    lenientAlts.forEach(function(alt) {
      var rawMove = alt.move || alt;
      var conf = alt.confidence || 0.1;

      if (!rawMove) return;

      // Normalize lenient notation to standard SAN
      var normalized = _normalizeLenientJS(rawMove, chess, legalMoves);
      if (!normalized) {
        console.log('[QUICK-FIX] Lenient: "' + rawMove + '" → could not normalize');
        return;
      }

      if (normalized === topMove) {
        // Lenient agrees with the OCR's top guess — nothing new to surface as a fix.
        return;
      }

      if (seenMoves.has(normalized)) {
        // Cross-sheet corroboration: another candidate already proposes this SAN.
        // Typical case: black's strict OCR has "Bxe5" at 11%, and white's lenient
        // "BxN" normalizes (against the current board) to the same "Bxe5". Without
        // this branch the signal was silently dropped; now we add the lenient conf
        // to the existing entry, mirroring how mergeAlternatives sums confidences
        // when a move appears in both sheets' alts.
        var existing = null;
        for (var qi = 0; qi < quickFixes.length; qi++) {
          if (quickFixes[qi].san === normalized) { existing = quickFixes[qi]; break; }
        }
        if (existing) {
          var lenientPct = Math.round(conf * 100);
          var prevConf = existing.ocr_conf;
          existing.ocr_conf = Math.min(prevConf + lenientPct, 100);
          existing.lenient_corroborated = true;
          if (!existing.lenient_source_raw) existing.lenient_source_raw = rawMove;
          console.log('[QUICK-FIX] Lenient: "' + rawMove + '" → "' + normalized +
                      '" corroborates existing candidate (' + prevConf + '% + ' + lenientPct + '% → ' + existing.ocr_conf + '%)');
        } else {
          console.log('[QUICK-FIX] Lenient: "' + rawMove + '" → "' + normalized + '" (already seen, no entry to corroborate)');
        }
        return;
      }

      try {
        var result = chess.move(normalized);
        if (result) {
          chess.undo();
          seenMoves.add(normalized);
          lenientCount++;
          var sim = Math.round(charSimilarity(topMove, normalized));
          quickFixes.push({
            ocr: topMove, san: normalized, similarity: sim,
            ocr_conf: Math.round(conf * 100), ply: ply, ply_str: lbl,
            source: 'lenient_grammar', source_raw: rawMove,
            is_quick_fix: true,
            from_square: result.from, to_square: result.to,
            ocr_from_square: state.errorArrow ? state.errorArrow.from : null,
            ocr_to_square: state.errorArrow ? state.errorArrow.to : null
          });
          console.log('[QUICK-FIX] Lenient: "' + rawMove + '" → "' + normalized + '" (legal)');
        }
      } catch (e) {}
    });
    console.log('[QUICK-FIX] Lenient: ' + lenientCount + '/' + lenientAlts.length + ' resolved to legal moves');
  } else {
    console.log('[QUICK-FIX] Lenient: no lenient alternatives from beam decoder for this ply');
  }

  // === Section 3: Constrained re-OCR ===
  // Re-decode raw CTC logits constrained to only legal moves at this position.
  // Also builds scoreMap so ALL quick fix candidates get a re-OCR score.
  var reOcrCount = 0;
  var reOcrScoreMap = {};  // move → re-OCR confidence (0-1)
  if (CONFIG.usePyodide && window.zugwise && window.zugwise.isReady) {
    try {
      var legalMovesList = chess.moves();
      console.log('[QUICK-FIX] Running constrained re-OCR against ' + legalMovesList.length + ' legal moves...');
      var reOcrResult;
      if (state.mergeTierMap) {
        // Dual-sheet mode: use both sheets' logits with corroboration bonus
        console.log('[QUICK-FIX] Using dual-sheet constrained re-OCR');
        reOcrResult = await window.zugwise.constrainedReOCRDual(ply, legalMovesList);
      } else {
        reOcrResult = await window.zugwise.constrainedReOCR(ply, legalMovesList, []);
      }
      // Always log top-5 re-OCR scores (before threshold filtering)
      if (reOcrResult && reOcrResult.top5 && reOcrResult.top5.length > 0) {
        console.log('[QUICK-FIX] Re-OCR top-5: ' + reOcrResult.top5.map(function(c) {
          return c.move + '(' + (c.confidence * 100).toFixed(1) + '%)';
        }).join(', '));
      } else if (reOcrResult && reOcrResult.error) {
        console.log('[QUICK-FIX] Re-OCR: ' + reOcrResult.error);
      } else {
        console.log('[QUICK-FIX] Re-OCR: no logits stored for this ply');
      }
      // Store scoreMap for annotating ALL quick fixes
      if (reOcrResult && reOcrResult.scoreMap) {
        reOcrScoreMap = reOcrResult.scoreMap;
      }
      // Add new candidates from re-OCR that passed threshold and aren't already seen
      if (reOcrResult && reOcrResult.candidates && reOcrResult.candidates.length > 0) {
        reOcrResult.candidates.forEach(function(c) {
          if (!c.move || c.move === topMove || seenMoves.has(c.move)) return;
          if (topMove && _editDistance(topMove, c.move) > 4) {
            console.log('[QUICK-FIX] Re-OCR rejected (too different): "' + c.move + '" vs OCR "' + topMove + '"');
            return;
          }
          seenMoves.add(c.move);
          reOcrCount++;
          try {
            var result = chess.move(c.move);
            if (result) {
              chess.undo();
              var sim = Math.round(charSimilarity(topMove, c.move));
              quickFixes.push({
                ocr: topMove, san: c.move, similarity: sim,
                ocr_conf: 0, ply: ply, ply_str: lbl,
                source: 'constrained_reocr', is_quick_fix: true,
                from_square: result.from, to_square: result.to,
                ocr_from_square: state.errorArrow ? state.errorArrow.from : null,
                ocr_to_square: state.errorArrow ? state.errorArrow.to : null
              });
              console.log('[QUICK-FIX] Re-OCR: "' + c.move + '" conf=' + (c.confidence * 100).toFixed(0) + '%');
            }
          } catch (e) {}
        });
        console.log('[QUICK-FIX] Re-OCR: ' + reOcrCount + ' new candidates from constrained decode');
      }
    } catch (e) {
      console.log('[QUICK-FIX] Re-OCR error: ' + e.message);
    }
  }

  // === Annotate all quick fixes with re-OCR score and compute combined ===
  quickFixes.forEach(function(fix) {
    var reScore = reOcrScoreMap[fix.san];
    fix.reocr_conf = (typeof reScore === 'number') ? Math.round(reScore * 100) : null;
    // Combined = OCR beam confidence + re-OCR confidence (both %)
    fix.combined = fix.ocr_conf + (fix.reocr_conf || 0);
  });

  // Log summary
  console.log('[QUICK-FIX] Total: ' + quickFixes.length + ' candidates (strict=' +
    (quickFixes.length - lenientCount - reOcrCount) + ', lenient=' + lenientCount + ', re-ocr=' + reOcrCount + ')');
  if (quickFixes.length > 0) {
    console.log('[QUICK-FIX] Combined scores: ' + quickFixes.map(function(f) {
      return f.san + '(OCR:' + f.ocr_conf + '% + ReOCR:' + (f.reocr_conf !== null ? f.reocr_conf + '%' : '?') + ' = ' + f.combined + ')';
    }).join(', '));
  }

  // Upgrade similarity scores using Pyodide (Python move_similarity) if available
  if (quickFixes.length > 0 && CONFIG.usePyodide && window.zugwise && window.zugwise.isReady) {
    try {
      for (var k = 0; k < quickFixes.length; k++) {
        var result = await window.zugwise.getSimilarity(topMove, quickFixes[k].san);
        if (result && typeof result.similarity === 'number') {
          quickFixes[k].similarity = Math.round(result.similarity * 100);
        }
      }
    } catch (e) {
      log('⚠ Pyodide similarity error in quick fixes: ' + e.message);
    }
  }

  // Sort by combined score (OCR + re-OCR), then by similarity as tiebreaker
  quickFixes.sort(function(a, b) {
    if (b.combined !== a.combined) return b.combined - a.combined;
    return b.similarity - a.similarity;
  });

  // Check for tactical absurdity using Pyodide quiescence search
  if (quickFixes.length > 0 && CONFIG.usePyodide && window.zugwise && window.zugwise.isReady) {
    try {
      var candidates = quickFixes.map(function(f) { return { ply: f.ply, san: f.san }; });
      var absResults = await window.zugwise.checkAbsurdities(state.sans.slice(0, ply), candidates);
      if (absResults && absResults.length === quickFixes.length) {
        for (var ai = 0; ai < absResults.length; ai++) {
          if (absResults[ai].is_absurd) {
            quickFixes[ai].absurd_warning = true;
            quickFixes[ai].absurd_reason = absResults[ai].reason || 'Tactically absurd';
            console.log('[QUICK-FIX] Absurd: ' + quickFixes[ai].san + ' — ' + absResults[ai].reason);
          }
        }
      }
    } catch (e) {
      console.log('[QUICK-FIX] Absurdity check error: ' + e.message);
    }
  }

  return quickFixes;
}

/**
 * Lightweight JS-side lenient move normalization.
 * Handles the most common patterns without needing Python.
 * Returns standard SAN or null if cannot resolve.
 */
function _normalizeLenientJS(raw, chessInstance, legalMoves) {
  if (!raw) return null;

  // 0-0 / 0-0-0 → O-O / O-O-O
  if (raw === '0-0') return 'O-O';
  if (raw === '0-0-0') return 'O-O-O';

  // P prefix: Pe4 → e4, Pxe4 → try all legal pawn captures to e4
  if (raw.startsWith('P')) {
    var stripped = raw.slice(1);
    if (!stripped) return null;
    // Direct: Pe4 → e4
    if (legalMoves.indexOf(stripped) >= 0) return stripped;
    // Pxd5: find pawn capture to d5
    if (stripped.startsWith('x') && stripped.length >= 3) {
      var dest = stripped.slice(1, 3);
      for (var i = 0; i < legalMoves.length; i++) {
        if (legalMoves[i].indexOf('x') >= 0 && legalMoves[i].indexOf(dest) >= 0 &&
            legalMoves[i][0] >= 'a' && legalMoves[i][0] <= 'h') {
          return legalMoves[i];
        }
      }
    }
    return null;
  }

  // Square-captures-square: c6xd4 → find which piece is on c6, generate SAN
  // Pattern: [file][rank]x[file][rank]
  var sqCapMatch = raw.match(/^([a-h][1-8])x([a-h][1-8])(=[QRBN])?[+#]?$/);
  if (sqCapMatch) {
    var srcSq = sqCapMatch[1];
    var dstSq = sqCapMatch[2];
    var promo = sqCapMatch[3] || '';
    // Find legal move that goes from srcSq to dstSq
    for (var i = 0; i < legalMoves.length; i++) {
      try {
        var result = chessInstance.move(legalMoves[i]);
        if (result) {
          var matches = result.from === srcSq && result.to === dstSq;
          chessInstance.undo();
          if (matches) return legalMoves[i];
        }
      } catch (e) { /* not legal */ }
    }
    return null;
  }

  // Extended notation: Nf3-e5 → Ne5, e2-e4 → e4
  var dashIdx = raw.indexOf('-');
  if (dashIdx > 0 && raw[0] !== 'O' && raw[0] !== '0') {
    var after = raw.slice(dashIdx + 1);
    var before = raw.slice(0, dashIdx);
    // Extract piece if any
    var piece = '';
    if (before[0] >= 'A' && before[0] <= 'Z' && before[0] !== 'P') {
      piece = before[0];
    }
    if (after.length >= 2) {
      // Try piece + dest
      var candidate = piece + after;
      if (legalMoves.indexOf(candidate) >= 0) return candidate;
      // Try with capture
      candidate = piece + 'x' + after;
      if (legalMoves.indexOf(candidate) >= 0) return candidate;
      // Pawn: just dest
      if (!piece && legalMoves.indexOf(after) >= 0) return after;
    }
    return null;
  }

  // File-captures-file: cd, cxd → find pawn capture
  if (raw.length <= 3 && raw[0] >= 'a' && raw[0] <= 'h') {
    var srcFile = raw[0];
    var dstFile = raw.indexOf('x') >= 0 ? raw[raw.indexOf('x') + 1] : raw[1];
    if (dstFile >= 'a' && dstFile <= 'h' && Math.abs(srcFile.charCodeAt(0) - dstFile.charCodeAt(0)) === 1) {
      for (var i = 0; i < legalMoves.length; i++) {
        var m = legalMoves[i];
        if (m[0] === srcFile && m.indexOf('x') >= 0 && m.indexOf(dstFile) >= 0) {
          return m;
        }
      }
    }
    return null;
  }

  // Piece-captures-piece: BxN, RxR → find matching capture using board state
  if (raw.length >= 3 && raw[1] === 'x' && raw[0] >= 'A' && raw[2] >= 'A') {
    var attackerPiece = raw[0] === 'P' ? '' : raw[0]; // P prefix → pawn
    var victimPiece = raw[2] === 'P' ? null : raw[2]; // what's being captured
    // Optional square after victim: NxBc4 → victim on c4
    var victimSquare = (raw.length >= 5 && raw[3] >= 'a' && raw[3] <= 'h' && raw[4] >= '1' && raw[4] <= '8') ? raw.slice(3, 5) : null;
    var matches = [];
    for (var i = 0; i < legalMoves.length; i++) {
      var m = legalMoves[i];
      if (m.indexOf('x') < 0) continue; // must be a capture
      // Check attacker piece matches
      var mPiece = (m[0] >= 'A' && m[0] <= 'Z') ? m[0] : ''; // '' = pawn
      if (mPiece !== attackerPiece) continue;
      // Check that captured piece matches by playing the move
      try {
        var result = chessInstance.move(m);
        if (result) {
          var capturedOk = true;
          if (victimPiece && result.captured) {
            var capturedUpper = result.captured.toUpperCase();
            if (victimPiece === 'P') capturedOk = (capturedUpper === 'P');
            else capturedOk = (capturedUpper === victimPiece);
          } else if (victimPiece && !result.captured) {
            capturedOk = false;
          }
          if (victimSquare && result.to !== victimSquare) capturedOk = false;
          chessInstance.undo();
          if (capturedOk) matches.push(m);
        }
      } catch (e) {}
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      console.log('[QUICK-FIX] Lenient: "' + raw + '" is ambiguous (' + matches.join(', ') + '), picking first');
      return matches[0];
    }
    return null;
  }

  return null;
}

// Shared edit-distance moved to utils.js (function `editDistance`).
// Local alias kept for back-compat with existing call sites in this file.
var _editDistance = editDistance;

/**
 * Render quick fixes immediately when stuck.
 * Called BEFORE backtracking starts.
 */
function renderQuickFixes(quickFixes) {
  var container = document.getElementById('fix-list');
  container.innerHTML = '';

  // Show "Keep it" button for bad trades, persistent absurdities, or piece hanging
  var reason = state.stuckInfo ? state.stuckInfo.reason : null;
  if (reason === 'bad_trade' || reason === 'persistent_absurdity' || reason === 'piece_hanging') {
    createKeepAsIsButton(container);

    var sep = document.createElement('div');
    sep.className = 'text-xs text-gray-500 mb-2';
    sep.innerHTML = 'Or replace with:';
    container.appendChild(sep);
  }

  // Show "Revert to OCR" button if stuck ply was manually edited away from OCR
  var originalOcr = getOriginalOcrForStuckPly();
  if (originalOcr) {
    createRevertToOcrButton(originalOcr, container);
  }

  // Quick Fixes section (OCR alternatives + lenient + re-OCR) - shown BEFORE similarity fixes
  if (quickFixes.length > 0) {
    var qfHeader = document.createElement('div');
    qfHeader.className = 'text-xs text-purple-400 mb-2 flex items-center gap-2';
    var sourceTypes = {};
    quickFixes.forEach(function(f) { sourceTypes[f.source || 'ocr_alternative'] = true; });
    var sourceLabels = [];
    if (sourceTypes['ocr_alternative']) sourceLabels.push('OCR');
    if (sourceTypes['lenient_grammar']) sourceLabels.push('lenient');
    if (sourceTypes['constrained_reocr']) sourceLabels.push('re-OCR');
    qfHeader.innerHTML = '<span>⚡</span><span>Quick Fixes</span><span class="text-gray-500">(' + sourceLabels.join(' + ') + ')</span>';
    container.appendChild(qfHeader);

    quickFixes.slice(0, 8).forEach(function(fix, i) {
      var btn = document.createElement('button');
      var isFirst = i === 0;

      // Color-code by source type
      var bgClass, borderClass, sanClass, sourceTag;
      if (fix.source === 'constrained_reocr') {
        bgClass = isFirst ? 'bg-cyan-600/30' : 'bg-gray-700 hover:bg-gray-600';
        borderClass = isFirst ? 'border-cyan-500' : 'border-gray-600';
        sanClass = 'text-cyan-400';
        sourceTag = '<span class="text-cyan-500 text-[10px] ml-1">RE-OCR</span>';
      } else if (fix.source === 'lenient_grammar') {
        bgClass = isFirst ? 'bg-amber-600/30' : 'bg-gray-700 hover:bg-gray-600';
        borderClass = isFirst ? 'border-amber-500' : 'border-gray-600';
        sanClass = 'text-amber-400';
        sourceTag = '<span class="text-amber-500 text-[10px] ml-1">LENIENT</span>';
        if (fix.source_raw) sourceTag += '<span class="text-gray-500 text-[10px] ml-1">(' + fix.source_raw + ')</span>';
      } else {
        bgClass = isFirst ? 'bg-purple-600/30' : 'bg-gray-700 hover:bg-gray-600';
        borderClass = isFirst ? 'border-purple-500' : 'border-gray-600';
        sanClass = 'text-purple-400';
        sourceTag = '';
      }
      if (fix.lenient_corroborated) {
        var lenientHint = fix.lenient_source_raw
          ? ' (lenient: ' + fix.lenient_source_raw + ')'
          : '';
        sourceTag += '<span class="text-amber-500 text-[10px] ml-1" title="Also matched by lenient notation from the other sheet' + lenientHint + '">↔ both</span>';
      }

      btn.className = 'w-full text-left p-2.5 rounded-lg border ' + bgClass + ' ' + borderClass;
      btn.title = (fix.source || 'OCR alternative') + ' • Click to select • Double-click to apply';
      var sim = typeof fix.similarity === 'number' ? fix.similarity : 0;
      var simBadge = sim >= 50 ? 'text-green-400' : (sim >= 25 ? 'text-yellow-400' : 'text-gray-500');
      var confBadge = fix.ocr_conf >= 10 ? 'text-purple-400' : 'text-gray-500';
      // Build score badges: OCR + re-OCR + combined
      var scoreParts = '<span class="' + confBadge + '">OCR:' + fix.ocr_conf + '%</span>';
      if (fix.reocr_conf !== null && fix.reocr_conf !== undefined) {
        var reBadge = fix.reocr_conf >= 30 ? 'text-cyan-400' : (fix.reocr_conf >= 10 ? 'text-cyan-600' : 'text-gray-500');
        scoreParts += ' <span class="' + reBadge + '">Re:' + fix.reocr_conf + '%</span>';
      }
      var absurdTag = fix.absurd_warning ? ' <span class="text-red-400" title="' + (fix.absurd_reason || 'Tactically absurd') + '">⚠️</span>' : '';
      btn.innerHTML = '<div class="flex justify-between items-center"><span class="font-mono text-sm"><span class="text-gray-400">' + fix.ply_str + '</span> <span class="' + ocrColorClass(fix) + '">' + fix.ocr + '</span> → <span class="' + sanClass + ' font-semibold">' + fix.san + '</span>' + sourceTag + absurdTag + '</span><span class="text-xs">' + scoreParts + '</span></div>';
      btn.onclick = function() { selectFix(fix, btn); };
      btn.ondblclick = function() { selectFix(fix, btn); applyFix(); };
      container.appendChild(btn);
      if (isFirst) selectFix(fix, btn);
    });
  }

  // Show pending similarity fix (requires confirmation) - shown AFTER OCR alternatives
  if (state.pendingConfirmation) {
    var pc = state.pendingConfirmation;
    var pcPly = pc.ply;
    var pcNum = Math.floor(pcPly / 2) + 1;
    var pcColor = pcPly % 2 === 0 ? 'W' : 'B';
    var pcPlyStr = pcNum + '.' + pcColor;

    // Build reason string - prefer semantic reasons over just change count
    var reasonStr = '';
    if (pc.semantic_reasons && pc.semantic_reasons.length > 0) {
      reasonStr = pc.semantic_reasons.join(', ');
    } else {
      reasonStr = pc.num_changes + ' changes';
    }

    var header = document.createElement('div');
    header.className = 'text-xs text-yellow-400 mb-2 flex items-center gap-2';
    header.innerHTML = '<span>⚠️</span><span>Quick Fix (similarity, ' + reasonStr + '):</span>';
    container.appendChild(header);

    var btn = document.createElement('button');
    btn.className = 'w-full text-left p-2.5 rounded-lg border bg-yellow-600/30 border-yellow-500 mb-3';
    btn.title = 'Click to select • Double-click to apply';
    var pcAbsurdTag = pc.absurd_warning
      ? ' <span class="text-red-400" title="' + pc.absurd_warning.replace(/"/g, '&quot;') + '">⚠️</span>'
      : '';
    var pcAbsurdLine = pc.absurd_warning
      ? '<div class="text-xs text-red-400 mt-1">' + pc.absurd_warning + '</div>'
      : '';
    btn.innerHTML = '<div class="flex justify-between items-center"><span class="font-mono text-sm"><span class="text-gray-400">' + pcPlyStr + '</span> <span class="text-red-400">' + pc.original + '</span> → <span class="text-yellow-300 font-semibold">' + pc.suggested + '</span>' + pcAbsurdTag + '</span><span class="text-yellow-400 text-xs">' + reasonStr + '</span></div>' + pcAbsurdLine + '<div class="text-xs text-yellow-600 mt-1">Requires confirmation - click to accept</div>';
    // Compute arrow squares for pending confirmation
    var pcFrom = null, pcTo = null;
    try {
      var tempChess = new Chess();
      for(var j = 0; j < pcPly; j++){ tempChess.move(state.sans[j]); }
      var moveObj = tempChess.move(pc.suggested);
      if(moveObj){ pcFrom = moveObj.from; pcTo = moveObj.to; }
    } catch(e) {}
    var pcFix = { ocr: pc.original, san: pc.suggested, ply: pcPly, ply_str: pcPlyStr, similarity: 0, num_changes: pc.num_changes, semantic_reasons: pc.semantic_reasons, type: 'auto_correct_confirm', from_square: pcFrom, to_square: pcTo, ocr_from_square: state.errorArrow ? state.errorArrow.from : null, ocr_to_square: state.errorArrow ? state.errorArrow.to : null };
    btn.onclick = function() { selectFix(pcFix, btn); };
    btn.ondblclick = function() { selectFix(pcFix, btn); applyFix(); };
    container.appendChild(btn);
    // Auto-select pending confirmation only if no OCR quick fixes available
    if (quickFixes.length === 0) selectFix(pcFix, btn);
  }

  // Deep search placeholder (will be filled by mergeBacktrackFixes)
  var deepSection = document.createElement('div');
  deepSection.id = 'deep-search-section';
  deepSection.className = 'mt-2';
  deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2"><span class="calculating">🔍</span><span>Searching for deeper fixes...</span></div>';
  container.appendChild(deepSection);

  // If no quick fixes and no pending confirmation, show message
  if (quickFixes.length === 0 && !state.pendingConfirmation) {
    var noQf = document.createElement('div');
    noQf.className = 'text-gray-500 text-sm mb-2';
    noQf.textContent = 'No OCR alternatives available';
    container.insertBefore(noQf, deepSection);
  }
}

/**
 * Merge backtracking results into the fix panel.
 * Called when backtracking completes.
 */
function mergeBacktrackFixes(backtrackFixes, missingMoveCandidates) {
  var deepSection = document.getElementById('deep-search-section');
  if (!deepSection) {
    // Quick fixes weren't shown, render normally
    renderFixes(backtrackFixes);
    state.missingMoveCandidates = missingMoveCandidates || [];
    return;
  }

  // Clear the placeholder
  deepSection.innerHTML = '';

  // NOTE: We intentionally show ALL backtrack fixes, even if they appear in Quick Fixes
  // or pending confirmation. The deep search shows different info (score, reach) that's
  // valuable even if the same move appears elsewhere.
  var allBacktrack = backtrackFixes || [];

  if (allBacktrack.length === 0 && (!missingMoveCandidates || missingMoveCandidates.length === 0)) {
    deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 pt-2 border-t border-gray-600">No additional fixes found</div>';
    return;
  }

  // "Revert to OCR" button is already shown in the quick fixes section (renderFixes) — don't duplicate here

  // Check if we need to auto-select first backtrack fix (no quick fixes, no pending confirmation)
  var originalOcr = getOriginalOcrForStuckPly();
  var needsAutoSelect = (!state.quickFixes || state.quickFixes.length === 0) && !state.pendingConfirmation && !originalOcr;
  var firstBacktrackBtn = null;
  var firstBacktrackFix = null;

  // Deep search header
  if (allBacktrack.length > 0) {
    var header = document.createElement('div');
    header.className = 'text-xs text-green-400 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2';
    header.innerHTML = '<span>🔍</span><span>Deep Search</span><span class="text-gray-500">(backtracking)</span>';
    deepSection.appendChild(header);

    var shownBacktrack = allBacktrack.slice(0, 8);
    var maxBacktrackReach = 0;
    shownBacktrack.forEach(function(f){ if (!f.completes && !f.keep_as_is) { var ar = getAbsReach(f); if (ar > maxBacktrackReach) maxBacktrackReach = ar; } });
    shownBacktrack.forEach(function(fix, i) {
      var btn = document.createElement('button');
      var isKeepAsIs = fix.keep_as_is;
      var isFirst = i === 0 && needsAutoSelect && !isKeepAsIs;
      var btnStyle = isKeepAsIs
        ? 'bg-yellow-900/30 hover:bg-yellow-800/30 border-yellow-600'
        : (isFirst ? 'bg-green-600/30 border-green-500' : 'bg-gray-700 hover:bg-gray-600 border-gray-600');
      btn.className = 'w-full text-left p-2.5 rounded-lg border ' + btnStyle;
      btn.title = isKeepAsIs ? 'Keep current move as-is (already applied)' : 'Backtrack fix • Click to select • Double-click to apply';
      var reach = reachLabel(fix);
      var sim = typeof fix.similarity === 'number' ? fix.similarity : 0;
      var simBadge = sim >= 50 ? 'text-green-400' : (sim >= 25 ? 'text-yellow-400' : 'text-gray-500');
      var rBadge = reachBadgeColor(fix, maxBacktrackReach);
      var plyLabel = fix.ply_str ? '<span class="text-gray-400">' + fix.ply_str + '</span> ' : '';
      if (isKeepAsIs) {
        btn.innerHTML = '<div class="flex justify-between items-center"><span class="font-mono text-sm">' + plyLabel + '<span class="text-yellow-400 font-semibold">Keep ' + fix.san + ' as-is</span></span><span class="text-yellow-500 text-xs">Current move</span></div>';
      } else {
        btn.innerHTML = '<div class="flex justify-between items-center"><span class="font-mono text-sm">' + plyLabel + '<span class="' + ocrColorClass(fix) + '">' + fix.ocr + '</span> → <span class="text-green-400 font-semibold">' + fix.san + '</span></span><span class="text-xs"><span class="' + simBadge + '">Sim:' + sim + '%</span>' + (reach ? ' <span class="' + rBadge + '">' + reach + '</span>' : '') + '</span></div>';
      }
      btn.onclick = function() { selectFix(fix, btn); };
      btn.ondblclick = function() { selectFix(fix, btn); applyFix(); };
      deepSection.appendChild(btn);

      // Track first button for auto-selection
      if (i === 0 && needsAutoSelect) {
        firstBacktrackBtn = btn;
        firstBacktrackFix = fix;
      }
    });
  }

  // Auto-select first backtrack fix if no quick fixes were available
  if (firstBacktrackFix && firstBacktrackBtn) {
    selectFix(firstBacktrackFix, firstBacktrackBtn);
  }

  // If no fix was auto-selected, update the apply button (it may still say "Searching...")
  if (!state.selectedFix) {
    var applyBtn = document.getElementById('btn-apply');
    if (applyBtn && applyBtn.textContent.indexOf('Searching') !== -1) {
      applyBtn.disabled = true;
      applyBtn.className = 'w-full mb-3 py-3 rounded-lg font-semibold bg-gray-700 text-gray-400 cursor-not-allowed';
      applyBtn.textContent = 'Select a fix';
    }
  }

  // Missing move candidates
  state.missingMoveCandidates = missingMoveCandidates || [];
  if (missingMoveCandidates && missingMoveCandidates.length > 0) {
    var sep = document.createElement('div');
    sep.className = 'text-xs text-purple-400 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2';
    sep.innerHTML = '<span>🔍</span><span>Missing move detected - insert:</span>';
    deepSection.appendChild(sep);

    missingMoveCandidates.slice(0, 3).forEach(function(mc, i) {
      var btn = document.createElement('button');
      btn.className = 'w-full text-left p-2.5 rounded-lg border bg-purple-900/30 hover:bg-purple-800/30 border-purple-600';
      var status = reachLabel(mc) || '?';
      var insertInfo = 'Insert <span class="text-purple-300 font-semibold">' + mc.inserted_move + '</span>';
      if (mc.corrected_stuck_move) {
        insertInfo += ' + change <span class="text-gray-400">' + mc.original_stuck_move + '</span> → <span class="text-purple-300">' + mc.corrected_stuck_move + '</span>';
      }
      btn.innerHTML = '<div class="flex justify-between items-center"><span class="font-mono text-sm">' + (i + 1) + '. ' + insertInfo + '</span><span class="text-purple-400 text-xs">' + status + '</span></div>';
      btn.title = 'Insert missing move before stuck position';
      btn.onclick = function() { selectMissingMoveFix(mc, btn); };
      btn.ondblclick = function() { selectMissingMoveFix(mc, btn); applyFix(); };
      deepSection.appendChild(btn);
    });
  }
}
