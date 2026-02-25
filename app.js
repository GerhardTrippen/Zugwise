var CONFIG={pieceStyle:localStorage.getItem('zugwise_pieceStyle')||'chessnut',apiUrl:'http://localhost:5000',usePyodide:false};
var chess=null;
var state={board:null,moves:[],sans:[],currentPly:0,stuckPly:null,stuckInfo:null,legalMoves:[],selectedFix:null,debugVisible:false,errorArrow:null,fixArrow:null,ocrArrow:null,missingMoveCandidates:[],editMode:null,editSortMode:'similarity',confirmedPly:0,fixedPlies:[],hasGridImage:false,ocrCells:[],inputMode:null,previewPly:null,pendingConfirmation:null,approvedPlies:[],lockedPlies:[],boardSelection:null,mergeTierMap:null,mergeLockedPlies:null,mergeSettings:{lockMode:'tier1'}};
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
  renderBoard();setupEventListeners();setupFileUpload();

  // Try to initialize Pyodide worker (non-blocking, falls back to Flask)
  var usePyodide=await initPyodideWorker();
  if(!usePyodide){
    // If Pyodide failed, hide overlay and continue with Flask
    hidePyodideLoadingOverlay();
  }

  log('Zugwise v0.5 ready'+(CONFIG.usePyodide?' (client-side mode)':' (server mode)'));
});

function setupEventListeners(){
  document.getElementById('btn-demo').onclick=loadDemo;
  document.getElementById('btn-first').onclick=function(){goToPly(0);};
  document.getElementById('btn-prev').onclick=function(){goToPly(state.currentPly-1);};
  document.getElementById('btn-next').onclick=function(){goToPly(state.currentPly+1);};
  document.getElementById('btn-last').onclick=function(){goToPly(state.sans.length);};
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
  document.getElementById('btn-change-input').onclick=function(){toggleInputArea(false);};
  document.getElementById('btn-download-ocr').onclick=downloadOCRText;
  document.getElementById('btn-download-ocr-sheet1').onclick=function(){downloadOCRTextForSheet(1);};
  document.getElementById('btn-download-ocr-sheet2').onclick=function(){downloadOCRTextForSheet(2);};
  document.getElementById('btn-reocr').onclick=handleReOCR;
  document.getElementById('btn-copy-fen').onclick=function(){
    if(!chess)return;var fen=chess.fen();navigator.clipboard.writeText(fen);log('📋 FEN copied: '+fen);
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
  // Multi-sheet toggle
  var btnToggleMultisheet=document.getElementById('btn-toggle-multisheet');
  if(btnToggleMultisheet)btnToggleMultisheet.onclick=toggleMultisheetMode;
  // OCR/PGN dual mode toggles
  var btnToggleOcrDual=document.getElementById('btn-toggle-ocr-dual');
  if(btnToggleOcrDual)btnToggleOcrDual.onclick=toggleOcrDualMode;
  var btnTogglePgnDual=document.getElementById('btn-toggle-pgn-dual');
  if(btnTogglePgnDual)btnTogglePgnDual.onclick=togglePgnDualMode;
  document.getElementById('piece-style').onchange=function(e){CONFIG.pieceStyle=e.target.value;localStorage.setItem('zugwise_pieceStyle',e.target.value);renderBoard();};
  document.onkeydown=function(e){
    if(e.target.tagName==='TEXTAREA'||e.target.tagName==='INPUT')return;
    if(e.key==='ArrowLeft')goToPly(state.currentPly-1);
    if(e.key==='ArrowRight')goToPly(state.currentPly+1);
    if(e.key==='Enter'&&state.selectedFix)applyFix();
    if(e.key==='Escape'&&state.boardSelection){clearBoardSelection();return;}
    if(e.key==='Escape'&&state.editMode)exitEditMode();
  };
}

function setupFileUpload(){
  var fileInput=document.getElementById('file-input');
  var dropZone=document.getElementById('drop-zone');
  fileInput.onchange=function(e){if(e.target.files&&e.target.files.length>0)handleFiles(Array.from(e.target.files));};
  dropZone.onclick=function(e){if(e.target.tagName!=='INPUT')fileInput.click();};
  dropZone.ondragover=function(e){e.preventDefault();dropZone.classList.add('border-blue-400','bg-blue-900/20');};
  dropZone.ondragleave=function(e){e.preventDefault();dropZone.classList.remove('border-blue-400','bg-blue-900/20');};
  dropZone.ondrop=function(e){e.preventDefault();dropZone.classList.remove('border-blue-400','bg-blue-900/20');var files=Array.from(e.dataTransfer.files).filter(function(f){return f.type.startsWith('image/');});if(files.length>0)handleFiles(files);};
}

function loadDemo(){
  log('🎮 Loading demo...');
  state.moves=[{num:1,white:'e4',black:'e5',wStatus:'ok',bStatus:'ok',wConf:0.98,bConf:0.97},{num:2,white:'Nf3',black:'Nc6',wStatus:'ok',bStatus:'ok',wConf:0.95,bConf:0.94},{num:3,white:'Bc4',black:'Bc5',wStatus:'ok',bStatus:'ok',wConf:0.96,bConf:0.95},{num:4,white:'O-O',black:'d6',wStatus:'ok',bStatus:'ok',wConf:0.92,bConf:0.97},{num:5,white:'c3',black:'Nf6',wStatus:'ok',bStatus:'ok',wConf:0.94,bConf:0.96},{num:6,white:'Re1',black:'Bg4',wStatus:'ok',bStatus:'ok',wConf:0.93,bConf:0.91},{num:7,white:'h3',black:'Bh5',wStatus:'ok',bStatus:'ok',wConf:0.97,bConf:0.93},{num:8,white:'d4',black:'exd4',wStatus:'ok',bStatus:'ok',wConf:0.98,bConf:0.89},{num:9,white:'Qd3',black:'O-O',wStatus:'ok',bStatus:'ok',wConf:0.91,bConf:0.94},{num:10,white:'e5',black:'dxe5',wStatus:'ok',bStatus:'ok',wConf:0.96,bConf:0.88},{num:11,white:'Nxe5',black:'Nxe5',wStatus:'ok',bStatus:'ok',wConf:0.94,bConf:0.93},{num:12,white:'Rxe5',black:'Bg6',wStatus:'ok',bStatus:'error',wConf:0.92,bConf:0.65}];
  state.moves[11].black='Bg2';state.moves[11].bStatus='error';
  state.sans=[];for(var i=0;i<state.moves.length;i++){var m=state.moves[i];if(m.wStatus==='ok')state.sans.push(m.white);else break;if(m.bStatus==='ok')state.sans.push(m.black);else break;}
  state.stuckPly=state.sans.length;state.stuckInfo={num:12,color:'b',move:'Bg2'};state.legalMoves=['Bg6','Bg4','Bxf3','Be7','Qe7','g6','Re8','c6','Qd7'];
  state.errorArrow={from:'h5',to:'g2'};
  state.confirmedPly=0;
  state.fixedPlies=[];
  state.ocrCells=[];state.hasGridImage=false;state.inputMode='demo';
  renderMoveList();document.getElementById('stuck-info').innerHTML='<span class="text-red-400">❌ 12.B "Bg2" is illegal</span>';document.getElementById('source-preview').classList.remove('hidden');document.getElementById('ocr-preview-text').textContent='12.B Bg2';document.getElementById('legal-count').textContent=state.legalMoves.length;
  document.getElementById('ocr-context-panel').classList.add('hidden');
  renderFixes([{ocr:'Bg2',san:'Bg6',similarity:67,reach_improvement:13,completes:false,ply_str:'12.B',from_square:'h5',to_square:'g6',ocr_from_square:'h5',ocr_to_square:'g2',explanation:"'Bg6' looks similar to 'Bg2'",absurdity_count:0},{ocr:'Bg2',san:'Bxf3',similarity:40,reach_improvement:13,completes:false,ply_str:'12.B',from_square:'h5',to_square:'f3',ocr_from_square:'h5',ocr_to_square:'g2',explanation:"Legal move",absurdity_count:0},{ocr:'Bg2',san:'Be7',similarity:50,reach_improvement:13,completes:false,ply_str:'12.B',from_square:'c5',to_square:'e7',ocr_from_square:'h5',ocr_to_square:'g2',explanation:"Legal move",absurdity_count:1}]);
  var lc=document.getElementById('legal-moves');lc.innerHTML='';state.legalMoves.forEach(function(m){var btn=document.createElement('button');btn.className='px-1.5 py-0.5 bg-gray-600 hover:bg-gray-500 rounded text-xs';btn.textContent=m;btn.onclick=function(){selectFix({ocr:'Bg2',san:m,similarity:0,ply_str:'12.B'},btn);};lc.appendChild(btn);});
  toggleInputArea(true);document.getElementById('loaded-info').textContent='📄 Demo game';log('✅ Demo loaded - 12.B "Bg2" should be "Bg6"');goToPly(state.sans.length);
}

function downloadPGN(){var pgn='[Event "Zugwise"]\n[Result "*"]\n\n';state.moves.forEach(function(m,i){pgn+=m.num+'. '+m.white+' '+(m.black||'')+' ';if((i+1)%5===0)pgn+='\n';});pgn+='*';var blob=new Blob([pgn],{type:'text/plain'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='game.pgn';a.click();log('📥 Downloaded PGN');}

function openLichess(){var pgn=state.moves.map(function(m){return m.num+'. '+m.white+' '+(m.black||'');}).join(' ');window.open('https://lichess.org/paste?pgn='+encodeURIComponent(pgn),'_blank');log('🔗 Opened in Lichess');}

function toggleMultisheetMode(){
  var uploader=document.getElementById('sheets-uploader');
  var simpleUpload=document.getElementById('simple-upload');
  var icon=document.getElementById('multisheet-toggle-icon');
  var text=document.getElementById('multisheet-toggle-text');
  if(!uploader||!simpleUpload)return;
  var isHidden=uploader.classList.contains('hidden');
  if(isHidden){
    uploader.classList.remove('hidden');
    simpleUpload.classList.add('hidden');
    icon.innerHTML='&#9650;';
    text.textContent='Simple: Single image upload';
    if(typeof initSheetsUploader==='function')initSheetsUploader();
  }else{
    uploader.classList.add('hidden');
    simpleUpload.classList.remove('hidden');
    icon.innerHTML='&#9660;';
    text.textContent='Advanced: Multiple sheets / Both players';
  }
}

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