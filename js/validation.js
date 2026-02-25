// =============================================================================
// VALIDATION - Move validation, fix finding, revalidation
// =============================================================================
// Pure client-side using Pyodide. NO FLASK FALLBACK.

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

async function validateAndDisplay(paired,filename){
  var flat=[];var ocrData=[];
  paired.forEach(function(m){
    if(m.white){
      flat.push(m.white);
      var alts=[];
      if(m.wAlts&&m.wAlts.length>0){m.wAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});}
      var lenientAlts=[];
      if(m.wLenientAlts&&m.wLenientAlts.length>0){m.wLenientAlts.forEach(function(a){lenientAlts.push({move:a.move||a,confidence:a.confidence||0.1});});}
      ocrData.push({move:m.white,confidence:m.wConf||0.9,alternatives:alts,lenientAlternatives:lenientAlts});
    }
    if(m.black){
      flat.push(m.black);
      var alts=[];
      if(m.bAlts&&m.bAlts.length>0){m.bAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});}
      var lenientAlts=[];
      if(m.bLenientAlts&&m.bLenientAlts.length>0){m.bLenientAlts.forEach(function(a){lenientAlts.push({move:a.move||a,confidence:a.confidence||0.1});});}
      ocrData.push({move:m.black,confidence:m.bConf||0.9,alternatives:alts,lenientAlternatives:lenientAlts});
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

  try{
    var val=await callValidateAPI(flat, ocrData, getAutoFixSettings(), null);
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
      // Use corrected SANs from validation response if available
      var wPly=currentPlyInLoop;
      var bPly=currentPlyInLoop+(m.white?1:0);
      var wSan=correctedSans[wPly]||m.white;
      var bSan=correctedSans[bPly]||m.black;
      // Store originals and log auto-corrections
      var wOrig=(m.white&&wSan!==m.white)?m.white:null;
      var bOrig=(m.black&&bSan!==m.black)?m.black:null;
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
      var entry={num:m.num,white:wSan,black:bSan,wConf:m.wConf,bConf:m.bConf,wAlts:m.wAlts,bAlts:m.bAlts,wStatus:'ok',bStatus:'ok',wOriginal:wOrig,bOriginal:bOrig,wOcrAlt:!!wOcrAlt,bOcrAlt:!!bOcrAlt};
      if(m.white){if(val.stuck_at===currentPlyInLoop)entry.wStatus='error';else if(val.stuck_at!==null&&currentPlyInLoop>val.stuck_at)entry.wStatus='pending';else state.sans.push(wSan);currentPlyInLoop++;}
      if(m.black){if(val.stuck_at===currentPlyInLoop)entry.bStatus='error';else if(val.stuck_at!==null&&currentPlyInLoop>val.stuck_at)entry.bStatus='pending';else if(entry.wStatus==='ok')state.sans.push(bSan);currentPlyInLoop++;}
      state.moves.push(entry);
    });
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
    }

    // FIRST: Render move list and show stuck position immediately
    renderMoveList();
    toggleInputArea(true);
    document.getElementById('loaded-info').textContent='📄 '+filename;
    goToPly(state.sans.length, {preserveErrorArrow: true});
    renderArrows();

    // THEN: Start finding fixes (user sees stuck position while this runs)
    if(state.stuckInfo){
      fetchFixes(); // Don't await - let it run while user sees the stuck position
    }

  }catch(e){log('⚠ Validation error: '+e.message);}
}

async function fetchFixes(){
  if(!state.stuckInfo)return;var lbl=state.stuckInfo.num+'.'+state.stuckInfo.color.toUpperCase();

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
  hideFixDetails();
  renderQuickFixes(state.quickFixes);
  renderLegalMoves();

  // Increment search generation to invalidate any pending backtrack results
  state.searchGeneration = (state.searchGeneration || 0) + 1;
  var thisSearchGeneration = state.searchGeneration;

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
  var fixedPliesArray = state.fixedPlies || [];
  var lockedPliesArray = state.lockedPlies || [];
  log('🔍 Finding fix suggestions (searchGen='+thisSearchGeneration+'):');
  log('   stuck_ply='+state.stuckPly+' ('+Math.floor(state.stuckPly/2+1)+'.'+(state.stuckPly%2===0?'W':'B')+')');
  log('   min_ply='+searchMinPly+' ('+Math.floor(searchMinPly/2+1)+'.'+(searchMinPly%2===0?'W':'B')+')');
  log('   fixed_plies=['+fixedPliesArray.join(',')+']');
  log('   locked_plies=['+lockedPliesArray.join(',')+']');
  log('   approvedPlies=['+(state.approvedPlies||[]).join(',')+']');
  try{
    var flat=[];var ocrData=[];
    state.moves.forEach(function(m){
      if(m.white){
        flat.push(m.white);
        // Build OCR data with alternatives for this move
        var alts=[];
        if(m.wAlts&&m.wAlts.length>0){
          m.wAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});
        }
        ocrData.push({move:m.white,confidence:m.wConf||0.9,alternatives:alts});
      }
      if(m.black){
        flat.push(m.black);
        var alts=[];
        if(m.bAlts&&m.bAlts.length>0){
          m.bAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});
        }
        ocrData.push({move:m.black,confidence:m.bConf||0.9,alternatives:alts});
      }
    });

    // === STREAMING BACKTRACK SEARCH ===
    // Create backtrack state
    var phase2Depth = settings?.deep_search_depth ?? currentSettings?.deep_search_depth ?? 5;
    var stateInfo = await window.zugwise.createBacktrackState(flat, state.stuckPly, ocrData, searchMinPly, fixedPliesArray, phase2Depth, lockedPliesArray, reason);
    var stateId = stateInfo.stateId;
    var totalPlies = stateInfo.totalPlies;
    log('🔍 Streaming backtrack: '+totalPlies+' plies to search');

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
      // Check if search was superseded
      if(state.searchGeneration !== thisSearchGeneration){
        log('🔍 Streaming search aborted (superseded by newer search)');
        // Cleanup - finalize will delete state vars
        try { await window.zugwise.backtrackFinalize(stateId); } catch(e){}
        return;
      }

      // Search next ply
      var stepResult = await window.zugwise.backtrackSearchStep(stateId);

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
        if(state.searchGeneration !== thisSearchGeneration){
          log('🔍 Phase 2 aborted (superseded by newer search)');
          try { await window.zugwise.backtrackFinalizeComplete(stateId); } catch(e){}
          return;
        }
        var p2Step = await window.zugwise.backtrackPhase2Step(stateId);
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

    // Check if search was superseded (user applied a fix while we were searching)
    if(state.searchGeneration !== thisSearchGeneration){
      log('🔍 Deep search result ignored (superseded by newer search)');
      showCalculating(false);
      return;
    }

    // Dual search: if both sheets' top candidates are illegal, search with the second one too
    if(data && data.dual_search_info && data.dual_search_info.needed){
      var dsi = data.dual_search_info;
      var primaryCount = (data.fixes||[]).length;
      var deepSection = document.getElementById('deep-search-section');
      log('🔍 Dual search: both "'+dsi.primary_move+'" and "'+dsi.secondary_move+'" illegal at '+dsi.stuck_ply_str);

      // Step 1: Raw search with secondary candidate
      if(deepSection){
        deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2"><span class="calculating">🔍</span><span>Searching with 2nd candidate: <b>'+dsi.secondary_move+'</b> ('+Math.round(dsi.secondary_conf*100)+'%) at '+dsi.stuck_ply_str+'...</span></div>';
      }
      await new Promise(function(resolve){ setTimeout(resolve, 0); });
      if(state.searchGeneration !== thisSearchGeneration){ showCalculating(false); return; }

      var searchResult = await window.zugwise.backtrackDualSearch(stateId);

      if(searchResult && !searchResult.error && searchResult.raw_count > 0){
        // Step 2: Verify top candidates with quiescence
        log('🔍 Dual search found '+searchResult.raw_count+' raw candidates, verifying...');
        if(deepSection){
          deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2"><span class="calculating">🔍</span><span>Verifying '+Math.min(searchResult.raw_count, 8)+' dual search fixes...</span></div>';
        }
        await new Promise(function(resolve){ setTimeout(resolve, 0); });
        if(state.searchGeneration !== thisSearchGeneration){ showCalculating(false); return; }

        var verifyResult = await window.zugwise.backtrackDualVerify(stateId);

        // Step 3: Merge into primary results
        log('🔍 Verified '+verifyResult.verified_count+' dual fixes, merging...');
        if(deepSection){
          deepSection.innerHTML = '<div class="text-xs text-gray-500 mt-3 mb-2 pt-2 border-t border-gray-600 flex items-center gap-2"><span class="calculating">🔍</span><span>Merging '+primaryCount+' + '+verifyResult.verified_count+' fixes...</span></div>';
        }
        await new Promise(function(resolve){ setTimeout(resolve, 0); });
        if(state.searchGeneration !== thisSearchGeneration){ showCalculating(false); return; }

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

async function revalidate(){
  var flat=[];var ocrData=[];
  state.moves.forEach(function(m){
    if(m.white){
      flat.push(m.white);
      var alts=[];
      if(m.wAlts&&m.wAlts.length>0){m.wAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});}
      ocrData.push({move:m.white,confidence:m.wConf||0.9,alternatives:alts});
    }
    if(m.black){
      flat.push(m.black);
      var alts=[];
      if(m.bAlts&&m.bAlts.length>0){m.bAlts.forEach(function(a){alts.push({move:Array.isArray(a)?a[0]:(a.move||a),confidence:Array.isArray(a)?(a[1]||0.1):(a.confidence||0.1)});});}
      ocrData.push({move:m.black,confidence:m.bConf||0.9,alternatives:alts});
    }
  });
  // Pass confirmedPly as startPly to skip re-checking already-confirmed moves
  var startPly = state.confirmedPly || 0;
  log('🔄 Revalidating '+flat.length+' moves (starting EAD from ply '+startPly+')...');
  try{var val=await callValidateAPI(flat, ocrData, getAutoFixSettings(), state.approvedPlies||[], startPly);
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
      if(m.white&&correctedSans[ply]&&correctedSans[ply]!==m.white){
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
      }
      if(m.black&&correctedSans[ply+(m.white?1:0)]&&correctedSans[ply+(m.white?1:0)]!==m.black){
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
      }
      if(m.white){if(m.wStatus!=='fixed'&&m.wStatus!=='locked'){if(val.stuck_at===ply)m.wStatus='error';else if(val.stuck_at!==null&&ply>val.stuck_at)m.wStatus='pending';else m.wStatus='ok';}if(m.wStatus==='ok'||m.wStatus==='fixed'||m.wStatus==='locked')state.sans.push(m.white);ply++;}if(m.black){if(m.bStatus!=='fixed'&&m.bStatus!=='locked'){if(val.stuck_at===ply)m.bStatus='error';else if(val.stuck_at!==null&&ply>val.stuck_at)m.bStatus='pending';else m.bStatus='ok';}if((m.wStatus==='ok'||m.wStatus==='fixed'||m.wStatus==='locked')&&(m.bStatus==='ok'||m.bStatus==='fixed'||m.bStatus==='locked'))state.sans.push(m.black);ply++;}});
    // NOTE: Do NOT update confirmedPly here - it's the user's search boundary,
    // set by applyFix()/keepCurrentMove(). Updating it would defeat the purpose.
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
      // Invalidate any in-flight deep searches
      state.searchGeneration = (state.searchGeneration || 0) + 1;
      showCalculating(false);
      if(val.is_checkmate){
        document.getElementById('stuck-info').innerHTML='<span class="text-green-400">✓ Checkmate! Game complete!</span>';
        document.getElementById('fix-list').innerHTML='<div class="text-green-400 text-sm p-4 text-center">♔ Checkmate! Game complete!</div>';
        log('♔ Checkmate! Game complete! '+state.sans.length+' moves validated');
      }else{
        document.getElementById('stuck-info').innerHTML='<span class="text-green-400">✓ All moves valid!</span>';
        document.getElementById('fix-list').innerHTML='<div class="text-green-400 text-sm p-4 text-center">🎉 Game complete!</div>';
        log('🎉 Game complete! '+state.sans.length+' moves validated');
      }
      document.getElementById('source-preview').classList.add('hidden');
      resetApplyButton();
    }
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
    fetchFixes();
  }
}

// =============================================================================
// BEAM SEARCH AUTO-SOLVE - Apply beam search result when it auto-completes game
// =============================================================================

function applyBeamSearchResult(data){
  // Build paired moves structure from beam search result
  var paired=[];
  for(var i=0;i<data.moves.length;i+=2){
    var num=Math.floor(i/2)+1;
    paired.push({
      num:num,
      white:data.moves[i]||'',
      black:data.moves[i+1]||'',
      wStatus:'ok',
      bStatus:data.moves[i+1]?'ok':'pending',
      wConf:0.9,
      bConf:0.9
    });
  }

  // Mark fixes and show flash notifications
  if(data.fixes&&data.fixes.length>0){
    data.fixes.forEach(function(fix){
      var fixNum=Math.floor(fix.ply/2)+1;
      var fixColor=fix.ply%2===0?'w':'b';
      for(var j=0;j<paired.length;j++){
        if(paired[j].num===fixNum){
          if(fixColor==='w'){
            paired[j].wStatus='fixed';
            if(fix.ocr&&fix.ocr!==fix.san){
              paired[j].wOriginal=fix.ocr;
              showAutoFixFlash(fix.ocr,fix.san,0,'Beam fix');
            }
          }else{
            paired[j].bStatus='fixed';
            if(fix.ocr&&fix.ocr!==fix.san){
              paired[j].bOriginal=fix.ocr;
              showAutoFixFlash(fix.ocr,fix.san,0,'Beam fix');
            }
          }
          break;
        }
      }
    });
  }

  // Update state
  state.moves=paired;
  state.sans=data.moves.slice();
  state.stuckPly=null;
  state.stuckInfo=null;
  state.errorArrow=null;
  state.fixArrow=null;
  state.ocrArrow=null;

  // Update UI to show game complete
  document.getElementById('stuck-info').innerHTML='<span class="text-green-400">✓ All moves valid!</span> <span class="text-blue-300 text-xs">(beam search: '+data.fixes.length+' fixes)</span>';
  document.getElementById('fix-list').innerHTML='<div class="text-green-400 text-sm p-4 text-center">🎉 Game auto-completed by beam search!</div>';
  document.getElementById('source-preview').classList.add('hidden');
  resetApplyButton();

  // Render and navigate
  renderMoveList();
  renderArrows();
  goToPly(state.sans.length);

  log('✓ Applied '+data.fixes.length+' beam search fixes, game complete');
}

// =============================================================================
// NOTE: Full game search (greedy/beam) is now USER-INITIATED via buttons
// See js/beam.js for runGreedySearch() and runBeamSearch()
// =============================================================================
