var CONFIG={pieceStyle:localStorage.getItem('zugwise_pieceStyle')||'maestro',apiUrl:'http://localhost:5000',usePyodide:false};
var chess=null;
var state={board:null,moves:[],sans:[],currentPly:0,stuckPly:null,stuckInfo:null,lastScrolledStuckPly:null,legalMoves:[],selectedFix:null,debugVisible:false,errorArrow:null,fixArrow:null,ocrArrow:null,missingMoveCandidates:[],editMode:null,editSortMode:'similarity',confirmedPly:0,fixedPlies:[],hasGridImage:false,ocrCells:[],inputMode:null,previewPly:null,pendingConfirmation:null,approvedPlies:[],lockedPlies:[],boardSelection:null,boardFlipped:false,mergeTierMap:null,mergeLockedPlies:null,mergeSettings:{lockMode:'tier1'}};
var INITIAL_FEN='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ============================================
// Service Worker Registration for PWA/Offline
// ============================================

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Workers not supported in this browser');
    return null;
  }
  
  try {
    const registration = await navigator.serviceWorker.register('./service-worker.js', {
      scope: './'
    });
    
    console.log('[SW] Service Worker registered successfully');
    console.log('[SW] Scope:', registration.scope);
    
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      console.log('[SW] New Service Worker found, installing...');
      
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed') {
          if (navigator.serviceWorker.controller) {
            showUpdateNotification();
          } else {
            console.log('[SW] Zugwise is ready for offline use!');
            showOfflineReadyNotification();
          }
        }
      });
    });
    
    return registration;
    
  } catch (error) {
    console.error('[SW] Service Worker registration failed:', error);
    return null;
  }
}

function setupOfflineDetection() {
  function updateOnlineStatus() {
    const statusEl = document.getElementById('offline-status');
    if (!statusEl) return;
    
    if (navigator.onLine) {
      statusEl.style.display = 'none';
    } else {
      statusEl.style.display = 'block';
      statusEl.textContent = 'You are offline - Zugwise still works!';
    }
  }
  
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();
}

function showUpdateNotification() {
  const notification = document.createElement('div');
  notification.id = 'update-notification';
  notification.className = 'fixed bottom-5 left-1/2 transform -translate-x-1/2 bg-blue-600 text-white px-6 py-3 rounded-lg shadow-lg z-50 flex items-center gap-3';
  notification.innerHTML = `
    <span>A new version of Zugwise is available!</span>
    <button onclick="updateApp()" class="bg-white text-blue-600 px-3 py-1 rounded font-semibold">Update</button>
    <button onclick="this.parentElement.remove()" class="text-blue-200 hover:text-white">Later</button>
  `;
  document.body.appendChild(notification);
}

function showOfflineReadyNotification() {
  const notification = document.createElement('div');
  notification.className = 'fixed bottom-5 left-1/2 transform -translate-x-1/2 bg-green-600 text-white px-6 py-3 rounded-lg shadow-lg z-50';
  notification.textContent = 'Zugwise is ready for offline use!';
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 4000);
}

async function updateApp() {
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration && registration.waiting) {
    registration.waiting.postMessage('skipWaiting');
  }
  window.location.reload();
}

// Register SW on page load
registerServiceWorker();
setupOfflineDetection();

// Handle SW controller change - show notification instead of auto-reloading,
// because an auto-reload kills the Pyodide worker during initialization
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  console.log('[SW] Controller changed - new service worker active');
  showUpdateNotification();
});


// Pyodide initialization progress stages (for loading bar)
var PYODIDE_STAGES={
  'Initializing...':5,
  'Loading Pyodide runtime...':20,
  'Installing python-chess...':50,
  'Loading ONNX model...':70,
  'Loading Python modules...':90,
  'Loading OCR workers...':95,
  'Ready!':100
};

function updatePyodideLoadingStatus(message){
  var statusEl=document.getElementById('pyodide-loading-status');
  var barEl=document.getElementById('pyodide-loading-bar');
  if(statusEl)statusEl.textContent=message;
  if(barEl){
    var progress=PYODIDE_STAGES[message]||50;
    barEl.style.width=progress+'%';
  }
}

function hidePyodideLoadingOverlay(){
  var overlay=document.getElementById('pyodide-loading-overlay');
  if(overlay){
    overlay.style.opacity='0';
    overlay.style.transition='opacity 0.5s';
    setTimeout(function(){overlay.classList.add('hidden');},500);
  }
}

async function initPyodideWorker(){
  // Check if worker-api.js loaded the ZugwiseAPI class
  if(typeof ZugwiseAPI==='undefined'||!window.zugwise){
    console.log('Pyodide worker not available, using Flask backend');
    hidePyodideLoadingOverlay();
    return false;
  }

  try{
    updatePyodideLoadingStatus('Initializing...');
    await window.zugwise.init(updatePyodideLoadingStatus);
    CONFIG.usePyodide=true;
    updatePyodideLoadingStatus('Ready!');
    log('✅ Pyodide worker ready - running fully client-side!');
    setTimeout(hidePyodideLoadingOverlay,500);
    return true;
  }catch(err){
    console.error('Pyodide init failed:',err);
    log('⚠️ Pyodide init failed, falling back to Flask backend: '+err.message);
    hidePyodideLoadingOverlay();
    return false;
  }
}

document.addEventListener('DOMContentLoaded',async function(){
  if(typeof Chess!=='undefined')chess=new Chess();
  state.board=fenToBoard(chess?chess.fen():INITIAL_FEN);
  currentSettings=loadSettings();
  if(window.SheetProfiles){window.SheetProfiles.loadProfiles();window.SheetProfiles.renderProfileDropdown();window.SheetProfiles.renderProfileSummary();}
  var pieceSelect=document.getElementById('piece-style');if(pieceSelect)pieceSelect.value=CONFIG.pieceStyle;
  renderBoard();setupEventListeners();
  if(typeof initContextMenu==='function')initContextMenu();
  if(typeof initSheetsUploader==='function')initSheetsUploader();

  // Try to initialize Pyodide worker (non-blocking, falls back to Flask)
  var usePyodide=await initPyodideWorker();
  if(!usePyodide){
    // If Pyodide failed, hide overlay and continue with Flask
    hidePyodideLoadingOverlay();
  }

  log('Zugwise v0.8.0 ready'+(CONFIG.usePyodide?' (client-side mode)':' (server mode)'));
});

function setupEventListeners(){
  document.getElementById('btn-first').onclick=function(){goToPly(0);};
  document.getElementById('btn-prev').onclick=function(){goToPly(state.currentPly-1);};
  document.getElementById('btn-next').onclick=function(){goToPly(state.currentPly+1);};
  document.getElementById('btn-last').onclick=function(){goToPly(state.sans.length);};
  document.getElementById('btn-flip').onclick=function(){state.boardFlipped=!state.boardFlipped;renderBoard();};
  document.getElementById('btn-debug').onclick=function(){state.debugVisible=!state.debugVisible;document.getElementById('debug-console').classList.toggle('hidden',!state.debugVisible);};
  document.getElementById('btn-clear-debug').onclick=function(){document.getElementById('debug-log').innerHTML='';};
  // Settings modal (with null checks for safety)
  var btnSettings=document.getElementById('btn-settings');
  var settingsClose=document.getElementById('settings-close');
  var settingsSave=document.getElementById('settings-save');
  var settingsReset=document.getElementById('settings-reset');
  var settingsModal=document.getElementById('settings-modal');
  if(btnSettings)btnSettings.onclick=openSettings;
  if(settingsClose)settingsClose.onclick=closeSettings;
  if(settingsSave)settingsSave.onclick=saveSettingsUI;
  if(settingsReset)settingsReset.onclick=resetSettingsUI;
  if(settingsModal)settingsModal.onclick=function(e){if(e.target.id==='settings-modal')closeSettings();};
  // Profile editor modal
  var btnEditProfile=document.getElementById('btn-edit-profile');
  var profileModalClose=document.getElementById('profile-modal-close');
  var profileModal=document.getElementById('profile-modal');
  if(btnEditProfile)btnEditProfile.onclick=function(){var name=document.getElementById('profile-select').value;if(window.SheetProfiles)window.SheetProfiles.openProfileEditor(name);};
  if(profileModalClose)profileModalClose.onclick=function(){if(window.SheetProfiles)window.SheetProfiles.closeProfileEditor();};
  if(profileModal)profileModal.onclick=function(e){if(e.target.id==='profile-modal'&&window.SheetProfiles)window.SheetProfiles.closeProfileEditor();};
  var btnSaveProfile=document.getElementById('btn-save-profile');
  if(btnSaveProfile)btnSaveProfile.onclick=function(){if(window.SheetProfiles)window.SheetProfiles.saveProfileFromEditor();};
  var btnDeleteProfile=document.getElementById('btn-delete-profile');
  if(btnDeleteProfile)btnDeleteProfile.onclick=function(){if(window.SheetProfiles)window.SheetProfiles.deleteProfileFromEditor();};
  var btnExportProfile=document.getElementById('btn-export-profile');
  if(btnExportProfile)btnExportProfile.onclick=function(){if(window.SheetProfiles)window.SheetProfiles.exportProfileFromEditor();};
  var btnImportProfile=document.getElementById('btn-import-profile');
  if(btnImportProfile)btnImportProfile.onclick=function(){document.getElementById('profile-import-file').click();};
  var profileImportFile=document.getElementById('profile-import-file');
  if(profileImportFile)profileImportFile.onchange=function(e){if(window.SheetProfiles&&e.target.files[0])window.SheetProfiles.importProfile(e.target.files[0]);};
  var profileSelect=document.getElementById('profile-select');
  if(profileSelect)profileSelect.onchange=function(e){if(window.SheetProfiles){window.SheetProfiles.setActiveProfile(e.target.value);window.SheetProfiles.renderProfileSummary();}};
  var btnAddPage=document.getElementById('btn-add-page');
  if(btnAddPage)btnAddPage.onclick=function(){if(window.SheetProfiles)window.SheetProfiles.addPageToEditor();};
  document.querySelectorAll('.input-tab').forEach(function(tab){
    tab.onclick=function(){
      var mode=tab.dataset.mode;
      document.querySelectorAll('.input-tab').forEach(function(t){t.classList.toggle('bg-blue-600',t.dataset.mode===mode);t.classList.toggle('text-white',t.dataset.mode===mode);t.classList.toggle('bg-gray-700',t.dataset.mode!==mode);});
      document.querySelectorAll('.input-content').forEach(function(c){c.classList.add('hidden');});
      document.getElementById('mode-'+mode).classList.remove('hidden');
    };
  });
  document.getElementById('btn-apply').onclick=applyFix;
  document.getElementById('btn-download').onclick=downloadPGN;
  document.getElementById('btn-lichess').onclick=openLichess;
  // Shared handler for both Change buttons (collapsed view header + the
  // expanded view's Upload Scoresheets header). Same full-reset semantics —
  // gives the user one escape hatch even when they're partway through an
  // upload, since Clear only nulls the sheet slots and leaves state, OCR,
  // batch, and search panels in place. Exposed on window because the
  // expanded copy lives inside sheets.js's render output and gets re-bound
  // there on every refreshSheetsUI call (the DOM node is recreated each time).
  window.handleChangeInput = function handleChangeInput() {
    var batchActive = !!(window.BatchGameList && window.BatchGameList.batchState && window.BatchGameList.batchState.active);
    var pgnBatchActive = !!(window.PgnBatch && window.PgnBatch.state && window.PgnBatch.state.active);
    var gameLoaded = Array.isArray(state.moves) && state.moves.length > 0;
    var hasSheets = typeof sheetsState !== 'undefined' && sheetsState && (
      (sheetsState.player1 || []).some(function(s){ return s; }) ||
      (sheetsState.player2 || []).some(function(s){ return s; })
    );
    if (batchActive || pgnBatchActive || gameLoaded || hasSheets) {
      var msg = batchActive
        ? 'Discard the current batch round? All OCR results, reconstructions, and per-game progress will be lost.'
        : (pgnBatchActive
            ? 'Discard the current PGN batch? All games, applied fixes, and Greedy results will be lost.'
            : (gameLoaded
                ? 'Discard the current game? Your fixes and OCR will be lost.'
                : 'Discard the uploaded sheets and start fresh?'));
      if (!window.confirm(msg)) return;
    }
    resetGameState();
    toggleInputArea(false);
  };
  document.getElementById('btn-change-input').onclick = window.handleChangeInput;
  document.getElementById('btn-download-ocr').onclick=downloadOCRText;
  document.getElementById('btn-download-ocr-sheet1').onclick=function(){downloadOCRTextForSheet(1);};
  document.getElementById('btn-download-ocr-sheet2').onclick=function(){downloadOCRTextForSheet(2);};
  document.getElementById('btn-reocr').onclick=handleReOCR;
  document.getElementById('btn-reset-reconstruct').onclick=restartReconstruction;
  document.getElementById('btn-copy-fen').onclick=function(){
    if(!chess)return;var fen=chess.fen();navigator.clipboard.writeText(fen);log('📋 FEN copied: '+fen);
    var btn=document.getElementById('btn-copy-fen');
    var orig=btn.textContent;btn.textContent='✓';btn.classList.add('text-green-400');
    setTimeout(function(){btn.textContent=orig;btn.classList.remove('text-green-400');},1500);
  };
  document.getElementById('btn-fen-lichess').onclick=function(){
    if(!chess)return;var fen=chess.fen();window.open('https://lichess.org/editor/'+encodeURIComponent(fen),'_blank');
  };
  document.getElementById('btn-toggle-help').onclick=function(){
    var helpDiv=document.getElementById('quick-help');
    var toggleText=document.getElementById('help-toggle-text');
    var isHidden=helpDiv.classList.contains('hidden');
    helpDiv.classList.toggle('hidden');
    toggleText.textContent=isHidden?'Hide':'Tips';
  };
  document.getElementById('btn-load-pgn').onclick=loadPGNWithImage;
  document.getElementById('btn-load-ocr').onclick=loadOCRWithImage;
  // (simple/advanced toggle removed — unified uploader)
  // OCR/PGN dual mode toggles
  var btnToggleOcrDual=document.getElementById('btn-toggle-ocr-dual');
  if(btnToggleOcrDual)btnToggleOcrDual.onclick=toggleOcrDualMode;
  var btnTogglePgnDual=document.getElementById('btn-toggle-pgn-dual');
  if(btnTogglePgnDual)btnTogglePgnDual.onclick=togglePgnDualMode;
  // Batch mode handlers
  initBatchHandlers();
  document.getElementById('piece-style').onchange=function(e){CONFIG.pieceStyle=e.target.value;localStorage.setItem('zugwise_pieceStyle',e.target.value);renderBoard();};
  document.onkeydown=function(e){
    if(e.target.tagName==='TEXTAREA'||e.target.tagName==='INPUT')return;
    if(e.key==='ArrowLeft'){e.preventDefault();goToPly(state.currentPly-1);}
    if(e.key==='ArrowRight'){e.preventDefault();goToPly(state.currentPly+1);}
    if(e.key==='Home'){e.preventDefault();goToPly(0);}
    if(e.key==='End'){e.preventDefault();goToPly(state.sans.length);}
    if(e.key==='Enter'&&state.selectedFix)applyFix();
    if(e.key==='Escape'&&state.boardSelection){clearBoardSelection();return;}
    if(e.key==='Escape'&&state.editMode)exitEditMode();
    if(e.key==='f'||e.key==='F'){state.boardFlipped=!state.boardFlipped;renderBoard();}
  };
}

// setupFileUpload - legacy drop zone removed in v0.6; simple mode now uses sheet boxes

// Restart reconstruction from the cached OCR — drops user fixes, locks,
// confirmations, NW edits, and search results, but keeps the per-sheet
// ocrResult.moves arrays produced by the OCR worker. processAllSheets
// re-reads those, re-merges, re-validates, and relaunches background
// searches. In batch mode, delegates to BatchGameList.resetCurrentGame
// which also handles orchestrator/workingState bookkeeping.
async function restartReconstruction(){
  if (window.BatchGameList && window.BatchGameList.batchState && window.BatchGameList.batchState.active) {
    if (typeof window.BatchGameList.resetCurrentGame === 'function') {
      window.BatchGameList.resetCurrentGame();
    }
    return;
  }

  var hasCachedOcr = false;
  if (typeof sheetsState !== 'undefined') {
    for (var p = 1; p <= 2 && !hasCachedOcr; p++) {
      var arr = sheetsState['player' + p];
      if (!arr) continue;
      for (var s = 0; s < arr.length && !hasCachedOcr; s++) {
        var sh = arr[s];
        if (sh && sh.ocrResult && sh.ocrResult.moves && sh.ocrResult.moves.length > 0) hasCachedOcr = true;
      }
    }
  }
  if (!hasCachedOcr) {
    log('Nothing to reset — no cached OCR found for this game.');
    return;
  }

  if (!window.confirm(
    'Restart reconstruction?\n\n' +
    'All your fixes and confirmations will be discarded and reconstruction will re-run from the original OCR.\n\n' +
    'OCR will not be re-run. This cannot be undone.'
  )) return;

  try { if (typeof cancelSearch === 'function') cancelSearch(); } catch(e){}
  try { if (typeof resetSearchPanels === 'function') resetSearchPanels(); } catch(e){}

  // Drop transient per-game state that survives processAllSheets's own
  // reset path (showOcrResults handles moves/sans/locked plies; the merge
  // path resets NW/banner state). What's left is fix-selection arrows,
  // board selection, edit mode, and the search-manager lock cache.
  state.currentPly = 0;
  state.legalMoves = [];
  state.selectedFix = null;
  state.errorArrow = null;
  state.fixArrow = null;
  state.ocrArrow = null;
  state.missingMoveCandidates = [];
  state.previewPly = null;
  state.pendingConfirmation = null;
  state.boardSelection = null;
  state.editMode = null;
  state.mergeTierMap = null;
  state.mergeLockedPlies = null;
  state._pendingMergeLockedPlies = null;
  if (window.searchManager && window.searchManager.lockedPlies) {
    window.searchManager.lockedPlies.clear();
  }

  // Force the cancel-+-relaunch path inside processAllSheets even though
  // the upload files are unchanged. Without this, the fingerprint matches
  // and launchBackgroundSearches at the bottom is skipped, so the user
  // sees a fresh validation but no fresh Greedy/Beam/Dijkstra runs.
  if (typeof sheetsState !== 'undefined') sheetsState._lastProcessedFingerprint = '';

  log('↺ Restarting reconstruction from original OCR...');

  try {
    if (typeof handleProcessSheets === 'function') {
      await handleProcessSheets();
    } else if (typeof processAllSheets === 'function') {
      await processAllSheets();
    }
  } catch (e) {
    log('❌ Reset failed: ' + (e && e.message ? e.message : e));
  }
}

// Full reset — wipe movelist, fixes, board, uploaded files, OCR data, search state
function resetGameState(){
  // Cancel any running searches and clear algorithm panels
  try { if (typeof cancelSearch === 'function') cancelSearch(); } catch(e){}
  try { if (typeof resetSearchPanels === 'function') resetSearchPanels(); } catch(e){}

  // Invalidate any inflight per-ply backtrack search launched for the
  // outgoing game. validation.js/fetchFixes captures searchGeneration at
  // entry and bails on mismatch — without bumping here, a fetchFixes that
  // was awaiting computeQuickFixes when the user clicked Change resumes
  // afterward, calls renderQuickFixes(state.quickFixes) with the prior
  // game's data, and the auto-select of the first quick fix (fixes.js:1977)
  // re-paints the green/yellow arrows AND restores the red arrow from the
  // still-stale state.savedErrorArrow. Mirrors the bump in selectGame.
  state.searchGeneration = (state.searchGeneration || 0) + 1;

  // Reset core game state
  state.moves=[];
  state.sans=[];
  state.currentPly=0;
  state.stuckPly=null;
  state.originStuckPly=null;
  state.stuckInfo=null;
  state.legalMoves=[];
  state.selectedFix=null;
  state.errorArrow=null;
  state.fixArrow=null;
  state.ocrArrow=null;
  // Clear the persistent red-arrow memory used by selectFix (fixes.js:520)
  // — otherwise a late selectFix call after reset would restore the prior
  // game's stuck-move arrow even though state.errorArrow itself was cleared.
  state.savedErrorArrow=null;
  state.quickFixes=[];
  state.missingMoveCandidates=[];
  state.confirmedPly=0;
  state.fixedPlies=[];
  state.approvedPlies=[];
  state.lockedPlies=[];
  // SearchManager.lockedPlies is on the singleton — clear it too so prior-game
  // locks don't leak into the next search.
  if (window.searchManager) window.searchManager.lockedPlies.clear();
  state.previewPly=null;
  state.pendingConfirmation=null;
  state.boardSelection=null;
  state.editMode=null;
  state.hasGridImage=false;
  state.ocrCells=[];
  state.ocrCellsSheet1=null;
  state.ocrCellsSheet2=null;
  state.mergeTierMap=null;
  state.mergeLockedPlies=null;
  state.inputMode=null;
  state.ocrOriginalFiles=null;

  // Reset uploaded sheets
  if (typeof sheetsState !== 'undefined') {
    sheetsState.player1=[null,null,null];
    sheetsState.player2=[null,null,null];
    sheetsState.player1Color=null;
    sheetsState.player2Color=null;
    sheetsState.dualSheetThumbnails=[null,null,null];
    sheetsState.isProcessing=false;
  }
  if (typeof refreshSheetsUI === 'function') refreshSheetsUI();

  // Clear fix/stuck UI
  var stuckDiv=document.getElementById('stuck-info');
  if(stuckDiv) stuckDiv.innerHTML='';
  var fixList=document.getElementById('fix-list');
  if(fixList) fixList.innerHTML='';
  var legalMoves=document.getElementById('legal-moves');
  if(legalMoves) legalMoves.innerHTML='';
  var srcPreview=document.getElementById('source-preview');
  if(srcPreview) srcPreview.classList.add('hidden');
  var ocrCtx=document.getElementById('ocr-context-panel');
  if(ocrCtx) ocrCtx.classList.add('hidden');
  var loadedInfo=document.getElementById('loaded-info');
  if(loadedInfo) loadedInfo.textContent='';
  // Remove the dual-sheet tier-summary banner (🟢/🟡/🔴 + Lock radios). It
  // lives inside #input-collapsed and is only (re)created by mergePlayerMoves
  // — switching to a single-sheet game (or just clearing) leaves it stranded.
  // Mirrors the batch-mode game-switch cleanup in batch-game-list.js.
  var tierBanner=document.getElementById('tier-summary-banner');
  if(tierBanner) tierBanner.remove();

  // Reset apply button
  if (typeof resetApplyButton === 'function') resetApplyButton();

  // Clear movelist & re-render empty board
  if (typeof renderMoveList === 'function') renderMoveList();
  if (chess && typeof chess.reset === 'function') chess.reset();
  if (typeof fenToBoard === 'function' && chess) state.board = fenToBoard(chess.fen());
  if (typeof renderBoard === 'function') renderBoard();

  // Exit verification mode if active (user is about to load a fresh game,
  // whatever we were reviewing is no longer relevant).
  if (window.VerificationUI && typeof window.VerificationUI.exitVerificationMode === 'function') {
    try { window.VerificationUI.exitVerificationMode(); } catch (e) {}
  }

  // Wipe batch-mode state too. Before this, clicking Change while a batch
  // round was loaded left the game list, per-game workingState snapshots,
  // orchestrator results, currentGameId, and a live orchestrator queue all
  // in memory — so the next Change + new batch round saw leftover data
  // from the previous round (wrong game list, stale Greedy results, etc.).
  if (window.BatchGameList && window.BatchGameList.batchState) {
    var bs = window.BatchGameList.batchState;
    try { if (bs.ocrQueue && typeof bs.ocrQueue.cancel === 'function') bs.ocrQueue.cancel(); } catch (e) {}
    try { if (bs.reconstructQueue && typeof bs.reconstructQueue.cancel === 'function') bs.reconstructQueue.cancel(); } catch (e) {}
    bs.active = false;
    bs.games = new Map();
    bs.ocrResults = {};
    bs.reconstructResults = {};
    bs.currentGameId = null;
    bs.selectedRound = null;
    bs.allGames = null;
    bs.availableRounds = [];
    bs.folderHandle = null;
    bs.ocrQueue = null;
    bs.reconstructQueue = null;
    if (typeof window.BatchGameList.renderGameList === 'function') {
      try { window.BatchGameList.renderGameList(); } catch (e) {}
    }
    // Hide the game-list container explicitly (renderGameList returns
    // early on !bs.active but only toggles the class on re-render).
    var glEl = document.getElementById('batch-game-list');
    if (glEl) glEl.classList.add('hidden');

    // The round dropdown was populated from the now-discarded allGames. Before
    // this, the stale <option>s survived the reset, so the user could pick a
    // round (e.g. switch round 4 → round 5) and selectRound would call
    // filterGamesByRound(null, ...) → throw, aborting the onchange handler
    // before it re-enabled Start. Result: "Start Batch OCR" stayed disabled
    // with no recovery short of reloading the folder. Repaint the dropdown
    // empty (availableRounds is [] now), collapse the selector, and reset the
    // Start/Cancel/summary/export controls so the only path forward is loading
    // a folder again — which re-shows and repopulates the selector cleanly.
    var roundSelEl = document.getElementById('batch-round-select');
    if (roundSelEl && typeof window.BatchGameList.renderRoundSelector === 'function') {
      try { window.BatchGameList.renderRoundSelector(roundSelEl); } catch (e) {}
      roundSelEl.value = '';
    }
    var sectionSelEl = document.getElementById('batch-section-select');
    if (sectionSelEl) { sectionSelEl.innerHTML = ''; sectionSelEl.classList.add('hidden'); }
    var roundSelectorDiv = document.getElementById('batch-round-selector');
    if (roundSelectorDiv) roundSelectorDiv.classList.add('hidden');
    var startBtn = document.getElementById('btn-batch-start');
    if (startBtn) startBtn.disabled = true;
    var cancelBtn = document.getElementById('btn-batch-cancel');
    if (cancelBtn) cancelBtn.classList.add('hidden');
    var summaryEl = document.getElementById('batch-summary');
    if (summaryEl) summaryEl.classList.add('hidden');
    ['btn-batch-export-round', 'btn-batch-export-csv', 'btn-batch-dashboard']
      .forEach(function(id) {
        var b = document.getElementById(id);
        if (b) b.classList.add('hidden');
      });
    var folderStatusEl = document.getElementById('batch-folder-status');
    if (folderStatusEl) folderStatusEl.textContent = '';
  }

  // Same cleanup for PGN-batch mode. Without this, clicking Change while a
  // multi-game PGN was loaded left pgnBatchState.games + the rendered
  // sidebar rows + the background algo queue alive, so the next interactive
  // OCR session opened with a leftover PGN game list on the left rail and
  // a still-active algo queue eating Pyodide cycles. PgnBatch.reset hides
  // the sidebar container, restores the PGN-input disclosure to its
  // single-game default ("Paste a PGN", open), and cancels the algo queue.
  if (window.PgnBatch && typeof window.PgnBatch.reset === 'function') {
    try { window.PgnBatch.reset(); } catch (e) {}
  }

  log('🔄 Reset — ready for new game');
}

// Stop at the first move ending in '#' (checkmate). Anything past that is
// treated as OCR noise for export purposes. Mutates a copy, not state.moves.
function trimMovesAtCheckmate(moves){
  var out=[];var trimmed=false;
  for(var i=0;i<moves.length;i++){
    var m=moves[i];if(!m)continue;
    var wMate=m.white&&/#/.test(m.white);
    var bMate=m.black&&/#/.test(m.black);
    if(wMate){out.push({num:m.num,white:m.white,black:''});trimmed=true;break;}
    out.push({num:m.num,white:m.white||'',black:m.black||''});
    if(bMate){trimmed=true;break;}
  }
  if(trimmed&&moves.length>out.length)log('✂️ Export: truncated '+(moves.length-out.length)+' trailing move row'+(moves.length-out.length===1?'':'s')+' after #');
  return out;
}

function downloadPGN(){var moves=trimMovesAtCheckmate(state.moves);var pgn='[Event "Zugwise"]\n[Result "*"]\n[Source "Zugwise (gerhardtrippen.github.io/Zugwise)"]\n\n';moves.forEach(function(m,i){pgn+=m.num+'. '+m.white+' '+(m.black||'')+' ';if((i+1)%5===0)pgn+='\n';});pgn+='*';var blob=new Blob([pgn],{type:'text/plain'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='game.pgn';a.click();log('📥 Downloaded PGN');}

function openLichess(){var moves=trimMovesAtCheckmate(state.moves);var pgn=moves.map(function(m){return m.num+'. '+m.white+' '+(m.black||'');}).join(' ');window.open('https://lichess.org/paste?pgn='+encodeURIComponent(pgn),'_blank');log('🔗 Opened in Lichess');}

function toggleOcrDualMode(){
  var single=document.getElementById('ocr-single-input');
  var dual=document.getElementById('ocr-dual-input');
  var icon=document.getElementById('ocr-dual-toggle-icon');
  var text=document.getElementById('ocr-dual-toggle-text');
  if(!single||!dual)return;
  var isHidden=dual.classList.contains('hidden');
  if(isHidden){
    dual.classList.remove('hidden');
    single.classList.add('hidden');
    icon.innerHTML='&#9650;';
    text.textContent='Single combined input';
  }else{
    dual.classList.add('hidden');
    single.classList.remove('hidden');
    icon.innerHTML='&#9660;';
    text.textContent='Separate White/Black input';
  }
}

function togglePgnDualMode(){
  var single=document.getElementById('pgn-single-input');
  var dual=document.getElementById('pgn-dual-input');
  var icon=document.getElementById('pgn-dual-toggle-icon');
  var text=document.getElementById('pgn-dual-toggle-text');
  if(!single||!dual)return;
  var isHidden=dual.classList.contains('hidden');
  if(isHidden){
    dual.classList.remove('hidden');
    single.classList.add('hidden');
    icon.innerHTML='&#9650;';
    text.textContent='Single combined input';
  }else{
    dual.classList.add('hidden');
    single.classList.remove('hidden');
    icon.innerHTML='&#9660;';
    text.textContent='Separate White/Black input';
  }
}

// =============================================================================
// Batch Mode Handlers
// =============================================================================

function initBatchHandlers() {
  var btnFolder = document.getElementById('btn-batch-folder');
  var btnFiles = document.getElementById('btn-batch-files');
  var fileInput = document.getElementById('batch-file-input');
  var roundSelect = document.getElementById('batch-round-select');
  var btnStart = document.getElementById('btn-batch-start');
  var btnCancel = document.getElementById('btn-batch-cancel');
  var btnTournament = document.getElementById('btn-batch-tournament');
  var tournamentInput = document.getElementById('batch-tournament-input');

  if (!btnFolder) return;  // Batch UI not present

  // --- Step 2: Sheet profile selector ---
  var batchProfileSelect = document.getElementById('batch-profile-select');
  if (batchProfileSelect && window.SheetProfiles) {
    // Populate with same profiles as the Image tab
    var profiles = window.SheetProfiles.loadProfiles();
    var active = window.SheetProfiles.getActiveProfile();
    batchProfileSelect.innerHTML = '';
    profiles.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      if (p.name === active.name) opt.selected = true;
      batchProfileSelect.appendChild(opt);
    });
    // Show summary (full multi-page format matching Image tab)
    var batchProfileSummary = document.getElementById('batch-profile-summary');
    function updateBatchProfileSummary(profile) {
      if (!batchProfileSummary || !profile) return;
      var parts = [];
      profile.pages.forEach(function(pg, i) {
        var desc = pg.format + ' ' + pg.rowCount + 'r';
        if (pg.headerRows > 0) desc += ' +' + pg.headerRows + 'h';
        if (pg.footerRows > 0) desc += ' +' + pg.footerRows + 'f';
        if (pg.startingMove > 1) desc += ' @' + pg.startingMove;
        parts.push('P' + (i + 1) + ':' + desc);
      });
      batchProfileSummary.textContent = parts.join(' | ');
    }
    updateBatchProfileSummary(active);
    batchProfileSelect.onchange = function() {
      window.SheetProfiles.setActiveProfile(batchProfileSelect.value);
      updateBatchProfileSummary(window.SheetProfiles.getActiveProfile());
    };
    // Edit button opens the profile editor
    var btnBatchEditProfile = document.getElementById('btn-batch-edit-profile');
    if (btnBatchEditProfile) {
      btnBatchEditProfile.onclick = function() {
        if (typeof window.SheetProfiles.openProfileEditor === 'function') {
          window.SheetProfiles.openProfileEditor(batchProfileSelect.value);
        }
      };
    }
  }

  // --- Tournament file load helper (shared by manual upload + auto-detect) ---
  // Accepts either a single File or a FileList/array. When given multiple
  // files, delegates to BatchTournament.parseTournamentFiles which dispatches
  // each one to the per-round or crosstable parser and merges. The crosstable
  // (when present) contributes ratings / federation / event metadata that
  // the per-round XLS export does not carry.
  async function _loadTournamentFile(fileOrFiles, opts) {
    opts = opts || {};
    var files = (fileOrFiles && typeof fileOrFiles.length === 'number' &&
                 typeof fileOrFiles[0] !== 'undefined')
                 ? Array.from(fileOrFiles) : [fileOrFiles];
    files = files.filter(Boolean);
    if (files.length === 0) return null;
    var statusEl = document.getElementById('batch-tournament-status');
    var loadingLabel = (files.length === 1)
      ? files[0].name
      : (files.length + ' files (' + files.map(function(f) { return f.name; }).join(', ') + ')');
    statusEl.textContent = 'Loading ' + loadingLabel + '...';
    statusEl.classList.remove('text-green-400', 'text-red-400');
    statusEl.classList.add('text-gray-500');
    try {
      var data;
      if (files.length > 1 &&
          window.BatchTournament &&
          typeof window.BatchTournament.parseTournamentFiles === 'function') {
        data = await window.BatchTournament.parseTournamentFiles(files);
      } else {
        data = await parseTournamentFile(files[0]);
      }
      var playerCount = Object.keys(data.players).length;
      // Pairing keys are section-qualified (OPEN_R1, U1800_R1, ...) when a
      // tournament has multiple sections — naive Object.keys would report
      // "15 rounds" for a 3-section × 5-round event. Count distinct round
      // NUMBERS instead, and report the section count separately.
      var roundNumbers = {};
      Object.keys(data.pairings || {}).forEach(function(k) {
        var m = k.match(/_R(\d+)$|^R(\d+)$/);
        if (m) roundNumbers[parseInt(m[1] || m[2])] = true;
      });
      var roundCount = Object.keys(roundNumbers).length;
      var sectionCount = (data.sections || []).length;
      // Auto-detected files (the ones without named sections / pairings) are
      // treated as "no match" so the manual status line is not overwritten
      // with a misleading empty-load success.
      if (roundCount === 0) {
        throw new Error('no rounds parsed from ' + loadingLabel);
      }
      window._batchTournamentData = data;
      var eventType = window.BatchTournament &&
                      typeof window.BatchTournament.detectEventType === 'function'
                      ? window.BatchTournament.detectEventType(data) : null;
      var prefix = data.event ? data.event + ' — ' : (loadingLabel + ' — ');
      var tag = opts.auto ? ' ⚙ auto-loaded from scan folder' : '';
      var typeTag = eventType ? ' [' + eventType + ']' : '';
      var sectionTag = sectionCount > 1
        ? ' in ' + sectionCount + ' sections'
        : '';
      statusEl.textContent = prefix + playerCount + ' players, ' +
                             roundCount + ' round(s)' + sectionTag + typeTag + tag;
      statusEl.classList.remove('text-gray-500');
      statusEl.classList.add('text-green-400');
      log((opts.auto ? 'Tournament file(s) auto-loaded: ' : 'Tournament file(s) loaded: ') +
          loadingLabel);
      // Rewire pairings onto any games already in the list (happens when the
      // user re-selects a folder and a new tournament file appears alongside).
      if (window.BatchGameList && window.BatchGameList.batchState &&
          window.BatchGameList.batchState.games.size > 0) {
        window.BatchTournament.attachPairings(
          window.BatchGameList.batchState.games, data);
        if (typeof window.BatchGameList.renderGameList === 'function') {
          window.BatchGameList.renderGameList();
        }
      }
      return data;
    } catch (e) {
      if (opts.auto) {
        // Silent fallthrough — no file is not an error.
        return null;
      }
      statusEl.textContent = 'Error: ' + e.message;
      statusEl.classList.remove('text-gray-500', 'text-green-400');
      statusEl.classList.add('text-red-400');
      log('Tournament file error: ' + e.message);
      return null;
    }
  }

  // --- Step 3: Tournament file upload (manual) ---
  if (btnTournament) {
    btnTournament.onclick = function() { tournamentInput.click(); };
    tournamentInput.onchange = function() {
      if (tournamentInput.files.length === 0) return;
      // Pass the whole FileList — the helper auto-dispatches to the
      // multi-file merger when more than one file was selected.
      _loadTournamentFile(tournamentInput.files, { auto: false });
    };
  }

  // Tournament-file auto-detection. When the user selects a scan folder, look
  // for .xls/.xlsx/.sjson/.json at the top level and try to parse them. If they
  // produce pairings, load them automatically so the user does not have to also
  // pick up the tournament file by hand when the TD dropped it into the same
  // folder as the scans.
  //
  // SwissSys: a single .sjson is authoritative — return that one file alone.
  // SwissManager: pick up ALL related XLS exports (per-round pairings AND the
  //   crosstable). The crosstable carries ratings / federation / event metadata
  //   that the per-round files don't, so merging both produces strictly richer
  //   tournament data than either source alone.
  function _selectTournamentCandidates(names) {
    // Classification regex applies to the filename only — a parent folder
    // literally named "Crosstable" or "MyPairings" must not change how a
    // file inside it is bucketed. The returned keys are still the original
    // input strings (which may contain paths) so callers can look them up.
    function base(n) { return n.split('/').pop(); }
    // .grid.json is an OCR-pipeline sidecar, never a tournament file —
    // reject up front in case a caller fed us a path the discovery
    // filter missed (e.g. manual file picker).
    names = names.filter(function(n) { return !/\.grid\.json$/i.test(base(n)); });
    var sjson = names.filter(function(n) { return /\.(sjson|json)$/i.test(base(n)); });
    if (sjson.length > 0) {
      // Authoritative single-file format — return just the first one.
      sjson.sort();
      return [sjson[0]];
    }
    var xls = names.filter(function(n) { return /\.xlsx?$/i.test(base(n)); });
    var perRound = xls.filter(function(n) {
      var b = base(n);
      return /round|pairing/i.test(b) && !/crosstable|tiebreak|standings|ranking/i.test(b);
    });
    var crosstable = xls.filter(function(n) {
      return /crosstable|tiebreak|standings|ranking|berger/i.test(base(n));
    });
    if (perRound.length > 0 || crosstable.length > 0) {
      // Sort per-round files for stable ordering ("Round_1.xls" before
      // "Round_2.xls"); crosstable order is irrelevant — there's usually one.
      perRound.sort();
      crosstable.sort();
      return crosstable.concat(perRound);
    }
    if (xls.length > 0) {
      // No filename hints matched — fall back to all XLS files; the parser's
      // structural sniff will sort them out.
      xls.sort();
      return xls;
    }
    // chessmanager.com export family (CSV + PGN-headers). Lowest priority:
    // only when no XLS / SJSON candidates exist, since a folder may also hold
    // a Zugwise diagnostics CSV or a recorded-games PGN. Both are rejected by
    // their parsers (CSV throws on a missing "Player No"/header; a games PGN
    // throws on real movetext) and the auto-load path ignores the throw.
    var family = names.filter(function(n) { return /\.(csv|pgn)$/i.test(base(n)); });
    family.sort();
    return family;
  }
  // Tournament-file shape: .xls / .xlsx / .sjson / .json, but NOT scan-side
  // sidecar JSON files written by the OCR pipeline (.grid.json, etc.).
  // Without this filter, "Crown_R1_B1.grid.json" gets picked as a SwissSys
  // SJSON candidate, the parser throws "Unrecognized JSON format", and the
  // auto-load looks stuck on its "Loading ..." status line.
  function _isTournamentFile(name) {
    if (!/\.(xlsx?|sjson|json|csv|pgn)$/i.test(name)) return false;
    if (/\.grid\.json$/i.test(name)) return false;   // OCR grid sidecar
    return true;
  }
  async function _findTournamentFilesInDir(dirHandle) {
    // Walk the picker root AND each immediate subfolder one level deep.
    // Two layouts in the wild:
    //   Layout B: MCC_root/{XLS files}, MCC_root/OPEN/{scans}, ...
    //   Layout A: MCC_root/OPEN/{XLS files + scans}, MCC_root/U1800/{...}
    // Walking one extra level catches Layout A without descending into
    // arbitrarily deep scan trees. Path-keyed dict prevents a filename
    // collision between sibling subfolders (theoretical: two sections
    // shipping XLS with the same bare filename).
    var byPath = {};
    async function walk(handle, prefix) {
      try {
        for await (var entry of handle.values()) {
          var rel = prefix ? prefix + '/' + entry.name : entry.name;
          if (entry.kind === 'file') {
            if (_isTournamentFile(entry.name)) {
              byPath[rel] = entry;
            }
          } else if (entry.kind === 'directory' && prefix === '') {
            await walk(entry, entry.name);
          }
        }
      } catch (e) { /* skip unreadable subtree */ }
    }
    await walk(dirHandle, '');
    var selected = _selectTournamentCandidates(Object.keys(byPath));
    var files = [];
    for (var i = 0; i < selected.length; i++) {
      try { files.push(await byPath[selected[i]].getFile()); }
      catch (e) { /* skip unreadable entry */ }
    }
    return files;
  }
  function _findTournamentFilesInList(fileList) {
    // Accept either the picker root (depth 2) or one-folder-deep section
    // subfolders (depth 3). With <input webkitdirectory> the first segment
    // is the chosen folder name, so "MCC_root/file.xls" has 2 segments and
    // "MCC_root/OPEN/file.xls" has 3.
    var candidates = Array.from(fileList).filter(function(f) {
      var rel = f.webkitRelativePath || f.name;
      var depth = rel.split('/').length;
      return depth >= 2 && depth <= 3 && _isTournamentFile(f.name);
    });
    if (candidates.length === 0) return [];
    var pathToFile = {};
    candidates.forEach(function(f) {
      pathToFile[f.webkitRelativePath || f.name] = f;
    });
    var selected = _selectTournamentCandidates(Object.keys(pathToFile));
    return selected.map(function(n) { return pathToFile[n]; }).filter(Boolean);
  }

  // --- Step 2: Select folder (File System Access API — Chrome/Edge) ---
  async function _adoptDirHandle(dirHandle) {
    var result = await window.BatchGameList.initFromFolder(dirHandle);
    onBatchFilesDiscovered(result);
    if (window.BatchFolderStore) {
      try { await window.BatchFolderStore.saveHandle(dirHandle); } catch (e) { /* ignore */ }
    }
    _renderReuseLink(null);
    // Auto-detect tournament file(s) alongside the scans. Always try — a new
    // folder usually corresponds to a new tournament, so replacing a prior
    // manually-selected file is the expected behaviour. For SwissManager
    // tournaments this picks up both per-round pairings AND the crosstable
    // when present, so ratings/federation/event-metadata come along.
    var autoFiles = await _findTournamentFilesInDir(dirHandle);
    if (autoFiles && autoFiles.length > 0) {
      _loadTournamentFile(autoFiles, { auto: true });
    }
  }

  btnFolder.onclick = async function() {
    if (!('showDirectoryPicker' in window)) {
      log('Folder picker not supported in this browser. Use "Select Files" instead.');
      return;
    }
    try {
      var dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      await _adoptDirHandle(dirHandle);
    } catch (e) {
      if (e.name !== 'AbortError') {
        log('Error selecting folder: ' + e.message);
      }
    }
  };

  // Offer to reuse the most recent scan folder (permission must be re-granted).
  function _renderReuseLink(handle) {
    var host = btnFolder.parentElement;
    if (!host) return;
    var link = document.getElementById('btn-batch-reuse-folder');
    if (!handle) {
      if (link) link.remove();
      return;
    }
    if (!link) {
      link = document.createElement('button');
      link.id = 'btn-batch-reuse-folder';
      link.className = 'ml-2 text-xs text-blue-400 hover:text-blue-300 underline';
      host.appendChild(link);
    }
    link.textContent = 'Reuse "' + (handle.name || 'last folder') + '"';
    link.title = 'Re-open the last tournament folder you used';
    link.onclick = async function() {
      try {
        var ok = await window.BatchFolderStore.verifyPermission(handle, 'read');
        if (!ok) { log('Permission to access "' + handle.name + '" was denied'); return; }
        await _adoptDirHandle(handle);
      } catch (e) {
        log('Could not reopen folder: ' + (e && e.message ? e.message : e));
        if (window.BatchFolderStore) window.BatchFolderStore.clearHandle();
        _renderReuseLink(null);
      }
    };
  }

  (async function initReuseLink() {
    if (!window.BatchFolderStore || !window.BatchFolderStore.isSupported()) return;
    var saved = await window.BatchFolderStore.loadHandle();
    if (saved) _renderReuseLink(saved);
  })();

  // Select files fallback
  btnFiles.onclick = function() {
    fileInput.click();
  };
  fileInput.onchange = function() {
    if (fileInput.files.length === 0) return;
    var result = window.BatchGameList.initFromFiles(fileInput.files);
    onBatchFilesDiscovered(result);
    // Auto-detect tournament file(s) at the top level of the chosen directory.
    var autoFiles = _findTournamentFilesInList(fileInput.files);
    if (autoFiles && autoFiles.length > 0) {
      _loadTournamentFile(autoFiles, { auto: true });
    }
  };

  // --- Step 4: Section + round selection ---
  // Section is optional; only fired when the dropdown is visible (i.e.
  // multi-section tournament). Picking a new section invalidates the
  // current round selection — the round dropdown is re-rendered with
  // only the rounds present in that section.
  var sectionSelect = document.getElementById('batch-section-select');
  if (sectionSelect) {
    sectionSelect.onchange = function() {
      window.BatchGameList.selectSection(sectionSelect.value || null);
      window.BatchGameList.renderRoundSelector(roundSelect);
      roundSelect.value = '';
      btnStart.disabled = true;
      var summary = document.getElementById('batch-summary');
      if (summary) summary.classList.add('hidden');
    };
  }
  roundSelect.onchange = function() {
    var round = parseInt(roundSelect.value);
    if (isNaN(round)) {
      btnStart.disabled = true;
      return;
    }
    window.BatchGameList.selectRound(round);
    btnStart.disabled = false;
    var summary = document.getElementById('batch-summary');
    var games = window.BatchGameList.batchState.games;
    var sec = window.BatchGameList.batchState.selectedSection;
    var prefix = sec ? (sec + ' — ') : '';
    summary.textContent = prefix + games.size + ' game' + (games.size !== 1 ? 's' : '') +
                          ' in Round ' + round;
    summary.classList.remove('hidden');
  };

  // Start batch OCR
  btnStart.onclick = function() {
    btnStart.disabled = true;
    btnCancel.classList.remove('hidden');
    window.BatchGameList.startBatchOcr();
  };

  // Cancel batch OCR
  btnCancel.onclick = function() {
    window.BatchGameList.cancelBatchOcr();
    btnCancel.classList.add('hidden');
    btnStart.disabled = false;
    log('Batch OCR cancelled');
  };

  // --- Step 5: Round export (PGN + diagnostics CSV) ---
  var btnExportRound = document.getElementById('btn-batch-export-round');
  var btnExportCsv = document.getElementById('btn-batch-export-csv');
  var btnDashboard = document.getElementById('btn-batch-dashboard');

  function _exportButtonsVisible(show) {
    [btnExportRound, btnExportCsv, btnDashboard].forEach(function(b) {
      if (!b) return;
      if (show) b.classList.remove('hidden');
      else b.classList.add('hidden');
    });
  }

  // Show export buttons whenever the round selector is populated.
  roundSelect.addEventListener('change', function() {
    _exportButtonsVisible(!!roundSelect.value);
  });

  if (btnExportRound) {
    btnExportRound.onclick = async function() {
      if (!window.BatchExport) { log('BatchExport module not loaded'); return; }
      btnExportRound.disabled = true;
      try {
        // All games go into one file: verified games with their actual result,
        // non-verified games with result=* and a [Termination] tag, move list
        // truncated to the confirmed prefix (stuckPly cutoff — never ships
        // algorithm-staged moves the user hasn't reviewed).
        var out = await window.BatchExport.exportAndSaveRoundCombinedPgn();

        if (out.count === 0) {
          log('No games in this round to export');
        } else {
          var where = (out.savedTo === 'folder') ? 'saved to scan folder' : 'downloaded';
          var detail = '';
          if (out.verifiedCount > 0 && out.incompleteCount > 0) {
            detail = out.verifiedCount + ' verified, ' + out.incompleteCount + ' incomplete (result=*)';
          } else if (out.verifiedCount > 0) {
            detail = out.verifiedCount + ' verified game(s)';
          } else {
            detail = out.incompleteCount + ' game(s), none verified yet (result=*)';
          }
          log('✅ ' + out.filename + ' ' + where + ' — ' + detail);

          // Flash the button green for 3 seconds so the save is unmissable.
          function _flashSaved(btn, origHtml, greenCls, removeCls) {
            if (!btn) return;
            btn.innerHTML = '✓ Saved!';
            btn.classList.add(greenCls);
            btn.classList.remove(removeCls);
            setTimeout(function() {
              btn.innerHTML = origHtml;
              btn.classList.remove(greenCls);
              btn.classList.add(removeCls);
            }, 3000);
          }
          _flashSaved(btnExportRound,
                      'Export Round PGN', 'bg-green-600', 'bg-indigo-600');
          _flashSaved(document.getElementById('btn-batch-export-round-list'),
                      '&#128229; Round PGN', 'bg-green-700', 'bg-indigo-700');
        }
      } catch (e) {
        log('Export failed: ' + (e && e.message ? e.message : e));
      }
      btnExportRound.disabled = false;
    };
  }

  if (btnExportCsv) {
    btnExportCsv.onclick = async function() {
      if (!window.BatchExport) { log('BatchExport module not loaded'); return; }
      btnExportCsv.disabled = true;
      try {
        var out = await window.BatchExport.exportAndSaveErrorCsv();
        log('Wrote ' + out.filename + ' (' + out.count + ' row(s), ' +
            out.savedTo + ')');
        if (out.decisions) {
          log('Wrote ' + out.decisions.filename + ' (' + out.decisions.count +
              ' decision(s), ' + out.decisions.savedTo + ')');
        }
        // Temporary ✓ on the button — same save-is-unmissable feedback as
        // the Export Round PGN button. Also flash the game-list footer's
        // "CSV" button, which delegates its click here.
        function _flashCsvSaved(btn, origHtml, removeCls) {
          if (!btn) return;
          btn.innerHTML = '✓ Saved!';
          btn.classList.add('bg-green-600');
          btn.classList.remove(removeCls);
          setTimeout(function() {
            btn.innerHTML = origHtml;
            btn.classList.remove('bg-green-600');
            btn.classList.add(removeCls);
          }, 3000);
        }
        _flashCsvSaved(btnExportCsv, 'Export CSV', 'bg-gray-600');
        _flashCsvSaved(document.getElementById('btn-batch-export-csv-list'),
                       'CSV', 'bg-gray-700');
      } catch (e) {
        log('CSV export failed: ' + (e && e.message ? e.message : e));
      }
      btnExportCsv.disabled = false;
    };
  }

  if (btnDashboard) {
    btnDashboard.onclick = function() {
      if (window.BatchDashboard && typeof window.BatchDashboard.toggle === 'function') {
        window.BatchDashboard.toggle();
      } else {
        log('Dashboard module not loaded');
      }
    };
  }

  // --- Help buttons ---
  initBatchHelpButtons();
}

// =============================================================================
// Tournament File Parsing — delegates to BatchTournament module when loaded.
// Inline fallback kept for backward compatibility if the module is missing.
// =============================================================================

async function parseTournamentFile(file) {
  if (window.BatchTournament && typeof window.BatchTournament.parseTournamentFile === 'function') {
    return window.BatchTournament.parseTournamentFile(file);
  }
  return _parseTournamentFileInline(file);
}

async function _parseTournamentFileInline(file) {
  var ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'sjson' || ext === 'json') {
    var text = await file.text();
    var data = JSON.parse(text);
    // Detect SwissSys SJSON by looking for Sections array
    if (data.Sections && Array.isArray(data.Sections)) {
      return parseSwissSysSJSON(data);
    }
    throw new Error('Unrecognized JSON format. Expected SwissSys SJSON with "Sections" array.');
  }

  if (ext === 'xls' || ext === 'xlsx') {
    // Need SheetJS library for XLS parsing
    if (typeof XLSX === 'undefined') {
      // Try loading SheetJS dynamically
      await new Promise(function(resolve, reject) {
        var script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        script.onload = resolve;
        script.onerror = function() { reject(new Error('Failed to load SheetJS library')); };
        document.head.appendChild(script);
      });
    }
    var buffer = await file.arrayBuffer();
    return parseSwissManagerXLS(buffer);
  }

  throw new Error('Unsupported format: .' + ext +
    '. Use SwissManager XLS (.xls/.xlsx) or SwissSys SJSON (.sjson/.json).');
}

function parseSwissSysSJSON(data) {
  var tournament = { event: '', site: '', players: {}, pairings: {}, sections: [] };

  data.Sections.forEach(function(section) {
    var sectionName = section['Section name'] || 'Unknown';
    tournament.sections.push(sectionName);
    var roundsPlayed = section['Rounds played'] || 0;

    var playerByPair = {};
    section.Players.forEach(function(p) {
      var pair = p.Pair;
      var name = ((p['Last name'] || '') + ', ' + (p['First name'] || '')).trim().replace(/^,\s*/, '');
      playerByPair[pair] = {
        name: name, rating: p.Rating || 0, title: p.Title || '', id: p.ID || '', pair: pair
      };
      tournament.players[sectionName + '_P' + pair] = playerByPair[pair];
    });

    for (var round = 1; round <= roundsPlayed; round++) {
      var roundKey = sectionName + '_R' + round;
      if (!tournament.pairings[roundKey]) tournament.pairings[roundKey] = [];
      var seenBoards = {};

      section.Players.forEach(function(p) {
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
          board: boardNum, whiteName: wp.name || 'Unknown', blackName: bp.name || 'Unknown',
          whiteRtg: wp.rating || 0, blackRtg: bp.rating || 0, result: result
        });
      });

      tournament.pairings[roundKey].sort(function(a, b) { return a.board - b.board; });
    }
  });
  return tournament;
}

// Inline fallback used only when js/batch-tournament.js failed to load. It
// mirrors the module's header-driven layout detection so the fallback
// produces the same per-pairing output for SwissManager export profiles that
// vary in column count (no Bo., with Bo., with/without Pts, with/without
// title, with/without Rtg). Kept in one function — the inline fallback does
// not need crosstable / multi-file support.
function parseSwissManagerXLS(buffer) {
  var workbook = XLSX.read(buffer, { type: 'array' });
  var sheet = workbook.Sheets[workbook.SheetNames[0]];
  var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  var tournament = { event: '', site: '', players: {}, pairings: {} };
  var currentRound = null, currentDate = '', boardCounter = 0;
  var cols = null;

  function parseHeader(row) {
    var c = {
      bo: -1, snoWhite: -1, snoBlack: -1, white: -1, black: -1,
      result: -1, rtgWhite: -1, rtgBlack: -1, titleWhite: -1, titleBlack: -1
    };
    var snoCols = [], rtgCols = [];
    for (var k = 0; k < row.length; k++) {
      var h = String(row[k] || '').trim().toLowerCase().replace(/\.+$/, '');
      if (h === 'bo' || h === 'board' || h === 'no') { if (c.bo < 0) c.bo = k; }
      else if (h === 'sno') snoCols.push(k);
      else if (h === 'white') c.white = k;
      else if (h === 'black') c.black = k;
      else if (h === 'res' || h === 'result') c.result = k;
      else if (h === 'rtg' || h === 'rating') rtgCols.push(k);
    }
    if (snoCols.length >= 1) c.snoWhite = snoCols[0];
    if (snoCols.length >= 2) c.snoBlack = snoCols[snoCols.length - 1];
    if (rtgCols.length >= 1) c.rtgWhite = rtgCols[0];
    if (rtgCols.length >= 2) c.rtgBlack = rtgCols[rtgCols.length - 1];
    if (c.white > 0 && String(row[c.white - 1] || '').trim() === '') c.titleWhite = c.white - 1;
    if (c.black > 0 && String(row[c.black - 1] || '').trim() === '') c.titleBlack = c.black - 1;
    return c;
  }
  function findDate(row) {
    var joined = row.join(' ');
    var m = joined.match(/(\d{4})-(\w{3})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = joined.match(/(\d{4})[\.\/](\d{2})[\.\/](\d{2})/);
    if (m) return m[1] + '.' + m[2] + '.' + m[3];
    return '';
  }

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i].map(function(c) { return String(c).trim(); });
    if (row.length < 5) continue;

    var roundHeaderMatch = row[0].match(/^Round\s+(\d+)/i);
    if (roundHeaderMatch) {
      currentRound = parseInt(roundHeaderMatch[1]);
      boardCounter = 0;
      cols = null;
      var d = findDate(row);
      if (d) currentDate = d;
      tournament.pairings['R' + currentRound] = [];
      continue;
    }

    if (!currentRound) continue;
    if (row[0] === '' && (cols == null || cols.bo < 0)) continue;

    if (/^(SNo\.?|No\.?|Bo\.?|Board)$/i.test(row[0])) {
      cols = parseHeader(row);
      continue;
    }

    if (row[0].indexOf('Swiss-Manager') >= 0 || row[0].indexOf('Program') >= 0) continue;
    if (cols == null) continue;

    var blackCellRaw = (cols.black >= 0) ? row[cols.black] : '';
    if (/^bye$/i.test(blackCellRaw) || blackCellRaw === '-' || blackCellRaw === '') continue;

    var snoWhite = (cols.snoWhite >= 0) ? parseInt(row[cols.snoWhite]) : NaN;
    if (isNaN(snoWhite)) continue;

    boardCounter++;
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

    result = (result || '').replace(/\s+/g, '').replace(/½/g, '1/2');
    if (/1\/2-1\/2/.test(result)) result = '1/2-1/2';
    else if (!/^(1-0|0-1)$/.test(result)) result = result || '*';

    if (!tournament.players[snoWhite]) {
      tournament.players[snoWhite] = { name: whiteName, rating: whiteRtg, title: whiteTitle };
    }
    if (snoBlack && !tournament.players[snoBlack]) {
      tournament.players[snoBlack] = { name: blackName, rating: blackRtg, title: blackTitle };
    }

    tournament.pairings['R' + currentRound].push({
      board: board,
      whiteSNo: snoWhite, blackSNo: snoBlack,
      whiteName: whiteName, blackName: blackName,
      whiteRtg: whiteRtg, blackRtg: blackRtg,
      whiteTitle: whiteTitle, blackTitle: blackTitle,
      result: result, date: currentDate
    });
  }

  return tournament;
}

// =============================================================================
// Batch Help System
// =============================================================================

var BATCH_HELP_CONTENT = {
  profile: {
    title: 'Step 2: Scoresheet Profile',
    html: '<p><strong>What is this?</strong></p>' +
      '<p>A scoresheet profile tells Zugwise the physical layout of the scoresheets ' +
      'being scanned: how many rows per page, how many columns (2-column or 3-column), ' +
      'and any header/footer rows to skip.</p>' +
      '<p class="mt-2"><strong>Common layouts:</strong></p>' +
      '<ul class="list-disc ml-4 mt-1 space-y-1">' +
      '<li><strong>2-column</strong>: Move number | White\'s move | Black\'s move &mdash; ' +
      'the most common format (20, 25, or 30 rows per page)</li>' +
      '<li><strong>3-column</strong>: Three move-number columns per page (60+ moves ' +
      'on a single page)</li>' +
      '</ul>' +
      '<p class="mt-2"><strong>The same profile applies to all games in the batch.</strong> ' +
      'All scoresheets in a given tournament round typically use the same layout.</p>' +
      '<p class="mt-2"><strong>Club-specific profiles:</strong></p>' +
      '<p>Zugwise includes presets for several clubs (Annex Chess Club, Aurora Chess Club, etc.). ' +
      'If your club\'s scoresheet has a unique layout, you can create a custom profile in the ' +
      'Image tab\'s profile editor and it will appear here.</p>' +
      '<p class="mt-2 text-xs text-gray-400">This is the same profile selector as in the Image tab. ' +
      'Changing it here also changes the active profile globally.</p>'
  },
  tournament: {
    title: 'Step 1: Tournament Data (Optional)',
    html: '<p><strong>What is this?</strong></p>' +
      '<p>If you have a tournament file from your pairing software, loading it here ' +
      'lets Zugwise automatically populate PGN headers (player names, ratings, results) ' +
      'for each game.</p>' +
      '<p class="mt-2"><strong>Supported formats:</strong></p>' +
      '<ul class="list-disc ml-4 mt-1 space-y-1">' +
      '<li><strong>SwissManager XLS</strong> (.xls or .xlsx) &mdash; Use the ' +
      '"Pairings &amp; Results" export from SwissManager. This is the definitive source ' +
      'with player names, ratings, titles, and results per round.</li>' +
      '<li><strong>SwissSys SJSON</strong> (.sjson or .json) &mdash; The native SwissSys ' +
      'tournament file. Contains sections, players, pairings, and results.</li>' +
      '</ul>' +
      '<p class="mt-2"><strong>Don\'t have one?</strong></p>' +
      '<p>This step is optional. You can skip it and manually enter PGN headers later, ' +
      'or export games without headers. The scoresheet scans are all you truly need.</p>' +
      '<p class="mt-2 text-gray-400 text-xs">The tournament file is uploaded separately ' +
      'from the scan folder because it may cover multiple rounds or come from a different source.</p>'
  },
  scans: {
    title: 'Step 3: Scoresheet Scans',
    html: '<p><strong>Select the folder containing your scanned scoresheets.</strong></p>' +
      '<p class="mt-2"><strong>Recommended folder structure:</strong></p>' +
      '<pre class="bg-gray-900 rounded p-2 mt-1 text-xs overflow-x-auto">' +
      'Tournament/\n' +
      '  Premier/\n' +
      '    Round 2/\n' +
      '      Board 1/\n' +
      '        scan_page1.pdf\n' +
      '        scan_page2.pdf\n' +
      '      Board 2/\n' +
      '        scan.jpg\n' +
      '    Round 3/\n' +
      '      Board 1/\n' +
      '        ...\n' +
      '  U1300/\n' +
      '    Round 2/\n' +
      '      ...</pre>' +
      '<p class="mt-2">Zugwise reads the directory structure to figure out which section, ' +
      'round, and board each scan belongs to. Folder names like "Round 2", "Rd 3", "R2", ' +
      '"Board 5", "Bd 5", "B5" are all recognized.</p>' +
      '<p class="mt-2"><strong>Alternative: strict filename convention</strong></p>' +
      '<p>If your files are flat (not in subfolders), you can name them:</p>' +
      '<pre class="bg-gray-900 rounded p-2 mt-1 text-xs">{Section}R{Round}B{Board}p{Page}.jpg\n' +
      'Example: OpenR1B4p1.jpg  U1300R3B27p2.jpg</pre>' +
      '<p class="mt-2"><strong>Supported file types:</strong> JPEG, PNG, TIFF, PDF</p>' +
      '<p class="text-xs text-gray-400 mt-1">PDFs are common from phone scanning apps. ' +
      'Zugwise automatically converts them to images using pdf.js.</p>' +
      '<p class="mt-2"><strong>Browser support:</strong></p>' +
      '<ul class="list-disc ml-4 mt-1 space-y-1 text-xs">' +
      '<li><strong>"Select Scan Folder"</strong> uses the File System Access API ' +
      '(Chrome, Edge). This preserves the folder structure for automatic game detection.</li>' +
      '<li><strong>"Select Files"</strong> is a fallback for other browsers. ' +
      'Folder structure is preserved if your browser supports <code>webkitdirectory</code>.</li>' +
      '</ul>'
  },
  round: {
    title: 'Step 4: Select Round',
    html: '<p><strong>Choose which round to process.</strong></p>' +
      '<p class="mt-2">Your scan folder may contain multiple rounds. Zugwise discovers ' +
      'all of them and shows the round numbers with game counts here.</p>' +
      '<p class="mt-2">All operations &mdash; OCR, reconstruction, verification, and ' +
      'PGN export &mdash; are scoped to the selected round.</p>' +
      '<p class="mt-2"><strong>After completing one round:</strong> select the next round ' +
      'from the dropdown. No need to re-upload anything &mdash; all files stay loaded.</p>' +
      '<p class="mt-2"><strong>"Start Batch OCR"</strong> processes all games in the ' +
      'selected round sequentially. The OCR runs ahead &mdash; you can start reviewing ' +
      'completed games while remaining games are still being processed.</p>' +
      '<p class="mt-2 text-xs text-gray-400">Processing speed: ~30-60 seconds per game, ' +
      'depending on image quality and the number of moves.</p>'
  }
};

function initBatchHelpButtons() {
  var modal = document.getElementById('batch-help-modal');
  var closeBtn = document.getElementById('btn-batch-help-close');
  if (!modal) return;

  // Close button
  closeBtn.onclick = function() { modal.classList.add('hidden'); };

  // Click outside to close
  modal.onclick = function(e) {
    if (e.target === modal) modal.classList.add('hidden');
  };

  // Escape to close
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      modal.classList.add('hidden');
    }
  });

  // Help buttons
  document.querySelectorAll('.batch-help-btn').forEach(function(btn) {
    btn.onclick = function(e) {
      e.stopPropagation();
      var helpKey = btn.getAttribute('data-help');
      var content = BATCH_HELP_CONTENT[helpKey];
      if (!content) return;
      document.getElementById('batch-help-title').textContent = content.title;
      document.getElementById('batch-help-content').innerHTML = content.html;
      modal.classList.remove('hidden');
    };
  });
}

function onBatchFilesDiscovered(result) {
  var statusEl = document.getElementById('batch-folder-status');
  statusEl.textContent = result.games.size + ' game(s) found';

  // Show round selector (and inline section selector when >1 section).
  var roundDiv = document.getElementById('batch-round-selector');
  roundDiv.classList.remove('hidden');

  var sectionSelect = document.getElementById('batch-section-select');
  var step4Label = document.getElementById('batch-step4-label');
  var sections = (result.sections || []).filter(function(s) { return s.section; });

  if (sectionSelect && sections.length > 1) {
    // Multi-section tournament: surface the section dropdown, default to the
    // first section so the round dropdown isn't ambiguous from the start.
    window.BatchGameList.renderSectionSelector(sectionSelect);
    sectionSelect.value = sections[0].section;
    sectionSelect.classList.remove('hidden');
    window.BatchGameList.selectSection(sections[0].section);
    if (step4Label) step4Label.textContent = 'section + round';
  } else if (sectionSelect) {
    // Single-section (or zero-section): hide the chooser and clear any
    // prior selection so getAvailableRounds returns all rounds.
    sectionSelect.classList.add('hidden');
    sectionSelect.innerHTML = '';
    window.BatchGameList.selectSection(null);
    if (step4Label) step4Label.textContent = 'round';
  }

  var roundSelect = document.getElementById('batch-round-select');
  window.BatchGameList.renderRoundSelector(roundSelect);

  if (result.unmatched.length > 0) {
    log(result.unmatched.length + ' file(s) could not be matched to a game');
  }
}