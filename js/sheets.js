// =============================================================================
// SHEETS.JS - Multi-Sheet Upload Component for Zugwise
// =============================================================================
// Handles upload of up to 6 scoresheets (2 players × 3 pages each)
// with automatic grid detection and manual corner correction fallback.
//
// Dependencies: Assumes app.js globals (CONFIG, state, log, etc.)
// =============================================================================

var sheetsState = {
  // Each player can have up to 3 sheets (pages)
  // Each sheet: { file, image, corners, status, ocrResult, moveCount }
  player1: [null, null, null],
  player2: [null, null, null],
  
  // Color assignment (auto-detected from header or manual)
  player1Color: null,  // 'white' | 'black' | null
  player2Color: null,
  
  // Currently active corner picker
  activeCornerPicker: null,  // { player: 1|2, sheet: 0|1|2 }
  
  // Processing state
  isProcessing: false
};

// Status types for each sheet
var SHEET_STATUS = {
  EMPTY: 'empty',
  LOADING: 'loading',
  GRID_OK: 'grid_ok',
  NEEDS_CORNERS: 'needs_corners',
  OCR_RUNNING: 'ocr_running',
  OCR_DONE: 'ocr_done',
  ERROR: 'error'
};

// =============================================================================
// INITIALIZATION
// =============================================================================

function initSheetsUploader() {
  var container = document.getElementById('sheets-uploader');
  if (!container) {
    console.warn('sheets-uploader container not found');
    return;
  }
  
  container.innerHTML = renderSheetsUploader();
  attachSheetEventListeners();
  log('📋 Multi-sheet uploader initialized');
}

// =============================================================================
// RENDERING
// =============================================================================

function renderSheetsUploader() {
  return `
    <div class="sheets-container">
      <div class="sheets-header flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold text-gray-200">Upload Scoresheets</h3>
        <div class="flex items-center gap-2">
          <button id="btn-swap-players" class="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded" title="Swap Player 1 and Player 2">
            ⇄ Swap
          </button>
          <button id="btn-clear-sheets" class="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-red-400" title="Clear all sheets">
            ✕ Clear
          </button>
        </div>
      </div>
      
      <!-- Player 1 Row -->
      <div class="player-row mb-4">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-sm font-medium text-gray-300">Player 1:</span>
          <button class="color-toggle px-2 py-0.5 text-xs rounded ${sheetsState.player1Color === 'white' ? 'bg-white text-black' : 'bg-gray-700 text-gray-300'}" 
                  data-player="1" data-color="white">White</button>
          <button class="color-toggle px-2 py-0.5 text-xs rounded ${sheetsState.player1Color === 'black' ? 'bg-gray-900 text-white border border-gray-500' : 'bg-gray-700 text-gray-300'}" 
                  data-player="1" data-color="black">Black</button>
          <span class="text-xs text-gray-500 ml-2">(auto-detected if possible)</span>
        </div>
        <div class="flex gap-3">
          ${renderSheetBox(1, 0)}
          ${renderSheetBox(1, 1)}
          ${renderSheetBox(1, 2)}
        </div>
      </div>
      
      <!-- Player 2 Row -->
      <div class="player-row mb-4">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-sm font-medium text-gray-300">Player 2:</span>
          <button class="color-toggle px-2 py-0.5 text-xs rounded ${sheetsState.player2Color === 'white' ? 'bg-white text-black' : 'bg-gray-700 text-gray-300'}" 
                  data-player="2" data-color="white">White</button>
          <button class="color-toggle px-2 py-0.5 text-xs rounded ${sheetsState.player2Color === 'black' ? 'bg-gray-900 text-white border border-gray-500' : 'bg-gray-700 text-gray-300'}" 
                  data-player="2" data-color="black">Black</button>
          <span class="text-xs text-gray-500 ml-2">(optional - improves accuracy)</span>
        </div>
        <div class="flex gap-3">
          ${renderSheetBox(2, 0)}
          ${renderSheetBox(2, 1)}
          ${renderSheetBox(2, 2)}
        </div>
      </div>
      
      <!-- Status Legend -->
      <div class="flex items-center gap-4 text-xs text-gray-400 mb-4">
        <span><span class="inline-block w-2 h-2 rounded-full bg-green-500"></span> Grid OK</span>
        <span><span class="inline-block w-2 h-2 rounded-full bg-yellow-500"></span> Needs corners</span>
        <span><span class="inline-block w-2 h-2 rounded-full bg-blue-500"></span> OCR running</span>
        <span><span class="inline-block w-2 h-2 rounded-full bg-purple-500"></span> Done</span>
      </div>
      
      <!-- Process Button -->
      <div class="flex justify-end">
        <button id="btn-process-sheets" class="px-6 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium" disabled>
          Process All Sheets →
        </button>
      </div>
    </div>
  `;
}

function renderSheetBox(player, sheetIndex) {
  var sheet = sheetsState['player' + player][sheetIndex];
  var status = sheet ? sheet.status : SHEET_STATUS.EMPTY;
  var pageNum = sheetIndex + 1;
  var id = 'sheet-' + player + '-' + sheetIndex;
  
  var statusIndicator = '';
  var statusClass = '';
  var content = '';
  
  switch (status) {
    case SHEET_STATUS.EMPTY:
      statusClass = 'border-dashed border-gray-600 hover:border-gray-500';
      content = `
        <div class="flex flex-col items-center justify-center h-full text-gray-500">
          <span class="text-2xl mb-1">+</span>
          <span class="text-xs">Page ${pageNum}</span>
        </div>
      `;
      break;
      
    case SHEET_STATUS.LOADING:
      statusClass = 'border-blue-500';
      statusIndicator = '<span class="absolute top-1 right-1 w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>';
      content = `<div class="flex items-center justify-center h-full"><div class="spinner-small"></div></div>`;
      break;
      
    case SHEET_STATUS.GRID_OK:
      statusClass = 'border-green-500 cursor-pointer';
      statusIndicator = '<span class="absolute top-1 right-1 w-2 h-2 rounded-full bg-green-500"></span>';
      content = renderSheetThumbnail(sheet, pageNum, 'click to adjust');
      break;
      
    case SHEET_STATUS.NEEDS_CORNERS:
      statusClass = 'border-yellow-500 cursor-pointer';
      statusIndicator = '<span class="absolute top-1 right-1 w-2 h-2 rounded-full bg-yellow-500"></span>';
      content = renderSheetThumbnail(sheet, pageNum, '⚠️ Click to adjust');
      break;
      
    case SHEET_STATUS.OCR_RUNNING:
      statusClass = 'border-blue-500';
      statusIndicator = '<span class="absolute top-1 right-1"><div class="spinner-small"></div></span>';
      content = renderSheetThumbnail(sheet, pageNum, sheet.ocrProgress || '🔄 OCR...');
      break;
      
    case SHEET_STATUS.OCR_DONE:
      statusClass = 'border-purple-500 cursor-pointer';
      statusIndicator = '<span class="absolute top-1 right-1 w-2 h-2 rounded-full bg-purple-500"></span>';
      content = renderSheetThumbnail(sheet, pageNum, '✓ ' + (sheet.moveCount || '?') + ' moves · click to re-OCR');
      break;
      
    case SHEET_STATUS.ERROR:
      statusClass = 'border-red-500';
      statusIndicator = '<span class="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500"></span>';
      content = renderSheetThumbnail(sheet, pageNum, '❌ Error');
      break;
  }
  
  // Per-sheet override dropdowns (visible when image is loaded)
  var sheetOverrides = '';
  if (sheet && (status === SHEET_STATUS.GRID_OK || status === SHEET_STATUS.OCR_RUNNING ||
                status === SHEET_STATUS.OCR_DONE || status === SHEET_STATUS.NEEDS_CORNERS ||
                status === SHEET_STATUS.ERROR)) {
    sheetOverrides = `
      <div class="absolute bottom-0 left-0 right-0 bg-black/80 p-0.5 text-xs flex gap-1 z-10 sheet-overrides">
        <select class="sheet-format-select bg-gray-700 text-white rounded px-1 text-xs flex-1"
                data-player="${player}" data-sheet="${sheetIndex}">
          <option value="2col" ${sheet.format==='2col'?'selected':''}>2col</option>
          <option value="3col" ${sheet.format==='3col'?'selected':''}>3col</option>
        </select>
        <select class="sheet-rows-select bg-gray-700 text-white rounded px-1 text-xs flex-1"
                data-player="${player}" data-sheet="${sheetIndex}">
          <option value="15" ${sheet.rowCount==15?'selected':''}>15r</option>
          <option value="20" ${sheet.rowCount==20?'selected':''}>20r</option>
          <option value="25" ${sheet.rowCount==25?'selected':''}>25r</option>
          <option value="30" ${sheet.rowCount==30?'selected':''}>30r</option>
        </select>
      </div>
    `;
  }

  return `
    <div id="${id}" class="sheet-box relative w-28 h-36 border-2 rounded-lg bg-gray-700/50 overflow-hidden transition-all ${statusClass}"
         data-player="${player}" data-sheet="${sheetIndex}">
      ${statusIndicator}
      <input type="file" accept="image/*" class="sheet-file-input hidden" data-player="${player}" data-sheet="${sheetIndex}">
      ${content}
      ${sheetOverrides}
    </div>
  `;
}

function renderSheetThumbnail(sheet, pageNum, overlayText) {
  var imgSrc = sheet.thumbnail || '';
  var overlay = overlayText ? `<div class="absolute bottom-0 left-0 right-0 bg-black/70 text-xs text-center py-1 text-gray-200">${overlayText}</div>` : '';
  
  return `
    <div class="relative w-full h-full">
      <img src="${imgSrc}" class="w-full h-full object-cover" alt="Page ${pageNum}">
      <div class="absolute top-1 left-1 bg-black/50 text-xs px-1 rounded text-gray-300">P${pageNum}</div>
      ${overlay}
    </div>
  `;
}

// =============================================================================
// EVENT HANDLERS
// =============================================================================

function attachSheetEventListeners() {
  // Sheet box clicks (for upload or corner adjustment)
  document.querySelectorAll('.sheet-box').forEach(function(box) {
    box.addEventListener('click', handleSheetBoxClick);
  });
  
  // File input changes
  document.querySelectorAll('.sheet-file-input').forEach(function(input) {
    input.addEventListener('change', handleSheetFileChange);
  });
  
  // Color toggle buttons
  document.querySelectorAll('.color-toggle').forEach(function(btn) {
    btn.addEventListener('click', handleColorToggle);
  });
  
  // Swap players button
  var swapBtn = document.getElementById('btn-swap-players');
  if (swapBtn) swapBtn.addEventListener('click', handleSwapPlayers);
  
  // Clear all button
  var clearBtn = document.getElementById('btn-clear-sheets');
  if (clearBtn) clearBtn.addEventListener('click', handleClearSheets);
  
  // Process button
  var processBtn = document.getElementById('btn-process-sheets');
  if (processBtn) processBtn.addEventListener('click', handleProcessSheets);
  
  // Corner picker close button
  var closePickerBtn = document.getElementById('btn-close-corner-picker');
  if (closePickerBtn) closePickerBtn.addEventListener('click', hideCornerPicker);
  
  // Allow drag & drop on sheet boxes
  document.querySelectorAll('.sheet-box').forEach(function(box) {
    box.addEventListener('dragover', function(e) { e.preventDefault(); box.classList.add('ring-2', 'ring-blue-400'); });
    box.addEventListener('dragleave', function(e) { e.preventDefault(); box.classList.remove('ring-2', 'ring-blue-400'); });
    box.addEventListener('drop', handleSheetDrop);
  });

  // Per-sheet format/rowCount override dropdowns
  document.querySelectorAll('.sheet-format-select').forEach(function(sel) {
    sel.addEventListener('click', function(e) { e.stopPropagation(); });
    sel.addEventListener('change', function(e) {
      e.stopPropagation();
      var player = parseInt(sel.dataset.player);
      var sheetIdx = parseInt(sel.dataset.sheet);
      var sheet = sheetsState['player' + player][sheetIdx];
      if (sheet) {
        sheet.format = sel.value;
        redetectGrid(player, sheetIdx);
      }
    });
  });
  document.querySelectorAll('.sheet-rows-select').forEach(function(sel) {
    sel.addEventListener('click', function(e) { e.stopPropagation(); });
    sel.addEventListener('change', function(e) {
      e.stopPropagation();
      var player = parseInt(sel.dataset.player);
      var sheetIdx = parseInt(sel.dataset.sheet);
      var sheet = sheetsState['player' + player][sheetIdx];
      if (sheet) {
        sheet.rowCount = parseInt(sel.value) || 20;
        redetectGrid(player, sheetIdx);
      }
    });
  });
}

function handleSheetBoxClick(e) {
  var box = e.currentTarget;
  var player = parseInt(box.dataset.player);
  var sheetIndex = parseInt(box.dataset.sheet);
  var sheet = sheetsState['player' + player][sheetIndex];
  
  if (!sheet || sheet.status === SHEET_STATUS.EMPTY) {
    // Trigger file upload
    var input = box.querySelector('.sheet-file-input');
    if (input) input.click();
  } else if (sheet.status === SHEET_STATUS.NEEDS_CORNERS) {
    // Show corner picker
    showCornerPicker(player, sheetIndex);
  } else if (sheet.status === SHEET_STATUS.OCR_DONE || sheet.status === SHEET_STATUS.GRID_OK) {
    // Re-OCR: show corner picker to adjust and re-run OCR
    showCornerPicker(player, sheetIndex);
  }
}

function handleSheetFileChange(e) {
  var input = e.target;
  var player = parseInt(input.dataset.player);
  var sheetIndex = parseInt(input.dataset.sheet);
  
  if (input.files && input.files.length > 0) {
    loadSheetImage(player, sheetIndex, input.files[0]);
  }
}

function handleSheetDrop(e) {
  e.preventDefault();
  var box = e.currentTarget;
  box.classList.remove('ring-2', 'ring-blue-400');
  
  var player = parseInt(box.dataset.player);
  var sheetIndex = parseInt(box.dataset.sheet);
  
  var files = Array.from(e.dataTransfer.files).filter(function(f) {
    return f.type.startsWith('image/');
  });
  
  if (files.length > 0) {
    loadSheetImage(player, sheetIndex, files[0]);
  }
}

function handleColorToggle(e) {
  var btn = e.currentTarget;
  var player = parseInt(btn.dataset.player);
  var color = btn.dataset.color;
  
  sheetsState['player' + player + 'Color'] = color;
  
  // If setting one player's color, auto-set the other
  var otherPlayer = player === 1 ? 2 : 1;
  var otherColor = color === 'white' ? 'black' : 'white';
  if (sheetsState['player' + otherPlayer + 'Color'] === color) {
    sheetsState['player' + otherPlayer + 'Color'] = otherColor;
  }
  
  refreshSheetsUI();
  log('🎨 Player ' + player + ' set to ' + color);
}

function handleSwapPlayers() {
  // Swap sheet arrays
  var temp = sheetsState.player1;
  sheetsState.player1 = sheetsState.player2;
  sheetsState.player2 = temp;
  
  // Swap colors
  var tempColor = sheetsState.player1Color;
  sheetsState.player1Color = sheetsState.player2Color;
  sheetsState.player2Color = tempColor;
  
  refreshSheetsUI();
  log('⇄ Swapped players');
}

function handleClearSheets() {
  sheetsState.player1 = [null, null, null];
  sheetsState.player2 = [null, null, null];
  sheetsState.player1Color = null;
  sheetsState.player2Color = null;
  
  refreshSheetsUI();
  log('🗑️ Cleared all sheets');
}

async function handleProcessSheets() {
  if (sheetsState.isProcessing) return;
  
  // Check if any sheets need corner adjustment
  var needsCorners = false;
  for (var p = 1; p <= 2; p++) {
    for (var s = 0; s < 3; s++) {
      var sheet = sheetsState['player' + p][s];
      if (sheet && sheet.status === SHEET_STATUS.NEEDS_CORNERS) {
        needsCorners = true;
        break;
      }
    }
  }
  
  if (needsCorners) {
    log('⚠️ Please adjust corners on sheets marked with ⚠️');
    return;
  }
  
  sheetsState.isProcessing = true;
  updateProcessButton();
  
  try {
    await processAllSheets();
  } catch (err) {
    log('❌ Processing error: ' + err.message);
  } finally {
    sheetsState.isProcessing = false;
    updateProcessButton();
  }
}

// =============================================================================
// IMAGE LOADING & GRID DETECTION
// =============================================================================

async function loadSheetImage(player, sheetIndex, file) {
  log('📷 Loading ' + file.name + ' for Player ' + player + ' Page ' + (sheetIndex + 1));
  
  // Create sheet object
  var sheet = {
    file: file,
    image: null,
    thumbnail: null,
    corners: null,
    status: SHEET_STATUS.LOADING,
    ocrResult: null,
    moveCount: null,
    detectedColor: null,
    format: (window.SheetProfiles ? window.SheetProfiles.getProfileGridConfig(sheetIndex + 1).format : '2col'),
    rowCount: (window.SheetProfiles ? window.SheetProfiles.getProfileGridConfig(sheetIndex + 1).rowCount : 20)
  };
  
  sheetsState['player' + player][sheetIndex] = sheet;
  refreshSheetsUI();
  
  try {
    // Load image
    var imageData = await readFileAsDataURL(file);
    sheet.image = imageData;
    sheet.thumbnail = imageData;  // For now, use same image (could resize)
    
    // Try auto-detect grid (use profile config with sheet overrides)
    var gridConfig;
    if (window.SheetProfiles) {
      gridConfig = window.SheetProfiles.getProfileGridConfig(sheetIndex + 1, {
        format: sheet.format,
        rowCount: sheet.rowCount
      });
    } else {
      gridConfig = getGridConfig(sheet.rowCount, sheet.format);
    }
    var gridResult = await detectGrid(imageData, gridConfig);
    
    if (gridResult.success) {
      sheet.corners = gridResult.corners;
      sheet.status = SHEET_STATUS.GRID_OK;
      sheet.detectedColor = gridResult.detectedColor || null;
      
      // Auto-set player color if detected
      if (sheet.detectedColor && !sheetsState['player' + player + 'Color']) {
        sheetsState['player' + player + 'Color'] = sheet.detectedColor;
      }
      
      log('✓ Grid detected for Player ' + player + ' Page ' + (sheetIndex + 1));
      
      // Start OCR in background
      startBackgroundOCR(player, sheetIndex);
    } else {
      sheet.status = SHEET_STATUS.NEEDS_CORNERS;
      log('⚠️ Grid detection failed - manual corners needed');
    }
    
  } catch (err) {
    sheet.status = SHEET_STATUS.ERROR;
    log('❌ Error loading image: ' + err.message);
  }
  
  refreshSheetsUI();
  updateProcessButton();
}

function readFileAsDataURL(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) { resolve(e.target.result); };
    reader.onerror = function(e) { reject(new Error('File read error')); };
    reader.readAsDataURL(file);
  });
}

async function detectGrid(imageDataURL, sheetConfig) {
  // Client-side grid detection using v34 modules
  log('🔍 Running client-side grid detection...');

  try {
    // Wait for OpenCV
    if (typeof cv === 'undefined' || !cv.Mat) {
      log('  Waiting for OpenCV.js...');
      await new Promise(function(resolve) {
        if (typeof cv !== 'undefined' && cv.onRuntimeInitialized) {
          cv.onRuntimeInitialized = resolve;
        } else {
          var checkInterval = setInterval(function() {
            if (typeof cv !== 'undefined' && cv.Mat) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);
          setTimeout(function() { clearInterval(checkInterval); resolve(); }, 10000);
        }
      });
    }

    if (typeof cv === 'undefined' || !cv.Mat) {
      log('  OpenCV.js not available, grid detection skipped');
      return { success: false, corners: null };
    }

    // Load image into OpenCV Mat
    var img = new Image();
    img.src = imageDataURL;
    await new Promise(function(resolve) { img.onload = resolve; });
    var canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    var srcMat = cv.imread(canvas);

    var config = sheetConfig || getGridConfig(20, '2col');
    var result = runDetection(srcMat, config, function(msg) {
      log('  [Grid] ' + msg);
    });

    var success = (
      result.columnBoundaries.length === config.expectedCols &&
      result.gridRows && result.gridRows.length >= config.rowCount
    );

    var corners = null;
    if (result.contourCorners) {
      var ordered = orderPoints(result.contourCorners);
      corners = {
        topLeft: ordered[0],
        topRight: ordered[1],
        bottomRight: ordered[2],
        bottomLeft: ordered[3]
      };
    }

    log('  Grid detection: ' + (success ? 'SUCCESS' : 'FAILED') +
        ' (cols=' + result.columnBoundaries.length + '/' + config.expectedCols +
        ', rows=' + (result.gridRows ? result.gridRows.length : 0) + ')');

    // Cleanup
    srcMat.delete();
    if (result.warped) result.warped.delete();

    return { success: success, corners: corners, detectedColor: null };

  } catch (err) {
    log('❌ Grid detection error: ' + err.message);
    console.error('Grid detection error:', err);
    return { success: false, corners: null };
  }
}

/**
 * Re-run grid detection for a sheet after format/rowCount override change.
 */
async function redetectGrid(player, sheetIndex) {
  var sheet = sheetsState['player' + player][sheetIndex];
  if (!sheet || !sheet.image) return;

  log('🔄 Re-detecting grid for Player ' + player + ' Page ' + (sheetIndex + 1) +
      ' (' + sheet.format + ', ' + sheet.rowCount + ' rows)');

  sheet.status = SHEET_STATUS.LOADING;
  refreshSheetsUI();

  var gridConfig;
  if (window.SheetProfiles) {
    gridConfig = window.SheetProfiles.getProfileGridConfig(sheetIndex + 1, {
      format: sheet.format,
      rowCount: sheet.rowCount
    });
  } else {
    gridConfig = getGridConfig(sheet.rowCount, sheet.format);
  }

  var gridResult = await detectGrid(sheet.image, gridConfig);

  if (gridResult.success) {
    sheet.corners = gridResult.corners;
    sheet.status = SHEET_STATUS.GRID_OK;
    log('✓ Grid re-detected successfully');
    startBackgroundOCR(player, sheetIndex);
  } else {
    sheet.status = SHEET_STATUS.NEEDS_CORNERS;
    log('⚠️ Grid re-detection failed, manual corners needed');
  }

  refreshSheetsUI();
  updateProcessButton();
}

// =============================================================================
// CORNER PICKER
// =============================================================================

/**
 * Ensure corner picker modal exists on document.body.
 * Uses a full-page takeover: all other body children are hidden while
 * the modal is open, avoiding all z-index/compositing issues.
 */
function ensureCornerPickerModal() {
  var modal = document.getElementById('corner-picker-modal');
  // Remove any stale version (dialog or nested div)
  if (modal) {
    modal.remove();
    modal = null;
  }
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'corner-picker-modal';
    modal.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.85); overflow-y:auto; padding:24px 0;';
    modal.innerHTML =
      '<div style="max-width:56rem; margin:0 auto; background:#1f2937; border-radius:8px; padding:16px; max-height:90vh; overflow:auto;">' +
        '<div class="flex items-center justify-between mb-4">' +
          '<h3 class="text-lg font-semibold text-gray-200">Adjust Grid Corners</h3>' +
          '<button id="btn-close-corner-picker" class="text-gray-400 hover:text-white text-xl" style="cursor:pointer; background:none; border:none; font-size:1.25rem;">&#10005;</button>' +
        '</div>' +
        '<div id="corner-picker-content"></div>' +
      '</div>';
    document.body.appendChild(modal);
    document.getElementById('btn-close-corner-picker').addEventListener('click', hideCornerPicker);
  }
  return modal;
}

function showCornerPickerModal(modal) {
  // Hide all other body children so nothing can render on top
  Array.from(document.body.children).forEach(function(el) {
    if (el.id !== 'corner-picker-modal') {
      el._cpWasHidden = el.style.display;
      el.style.display = 'none';
    }
  });
  modal.style.display = 'block';
}

function hideCornerPickerModal() {
  var modal = document.getElementById('corner-picker-modal');
  if (modal) modal.style.display = 'none';
  // Restore all body children
  Array.from(document.body.children).forEach(function(el) {
    if (el.id !== 'corner-picker-modal' && '_cpWasHidden' in el) {
      el.style.display = el._cpWasHidden;
      delete el._cpWasHidden;
    }
  });
}

function showCornerPicker(player, sheetIndex) {
  var sheet = sheetsState['player' + player][sheetIndex];
  if (!sheet || !sheet.image) return;
  
  sheetsState.activeCornerPicker = { player: player, sheet: sheetIndex };

  var modal = ensureCornerPickerModal();
  var content = document.getElementById('corner-picker-content');

  content.innerHTML = `
    <div class="relative inline-block">
      <canvas id="corner-picker-canvas" class="max-w-full max-h-[60vh]"></canvas>
      <svg id="corner-picker-svg" class="absolute inset-0 w-full h-full" style="pointer-events: none;"></svg>
    </div>
    <div class="mt-4 flex items-center justify-between">
      <div class="text-sm text-gray-400">
        Drag the corners to match the grid boundaries
      </div>
      <div class="flex gap-2">
        <button id="btn-reset-corners" class="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded">Reset</button>
        <button id="btn-apply-corners" class="px-4 py-2 bg-green-600 hover:bg-green-500 rounded font-medium">Apply</button>
      </div>
    </div>
    <div id="corner-coords" class="mt-2 text-xs text-gray-500 font-mono"></div>
  `;

  showCornerPickerModal(modal);

  // Initialize corner picker after DOM update
  setTimeout(function() {
    initCornerPickerCanvas(sheet);
  }, 50);

  // Attach button handlers
  document.getElementById('btn-reset-corners').addEventListener('click', resetCornerPicker);
  document.getElementById('btn-apply-corners').addEventListener('click', applyCornerPicker);
}

function hideCornerPicker() {
  hideCornerPickerModal();
  sheetsState.activeCornerPicker = null;
  cornerPickerState.genericMode = false;
  cornerPickerState.onApplyCallback = null;
}

/**
 * Show the corner picker for any image, with a callback when corners are applied.
 * @param {string} imageDataURL - The image to show
 * @param {Object} existingCorners - Optional existing corners {topLeft, topRight, bottomRight, bottomLeft}
 * @param {function} onApply - Called with the selected corners (in original image coordinates) when user clicks Apply
 */
function showCornerPickerGeneric(imageDataURL, existingCorners, onApply) {
  cornerPickerState.onApplyCallback = onApply;
  cornerPickerState.genericMode = true;

  var modal = ensureCornerPickerModal();
  var content = document.getElementById('corner-picker-content');
  content.innerHTML =
    '<div class="relative inline-block">' +
      '<canvas id="corner-picker-canvas" class="max-w-full max-h-[60vh]"></canvas>' +
      '<svg id="corner-picker-svg" class="absolute inset-0 w-full h-full" style="pointer-events: none;"></svg>' +
    '</div>' +
    '<div class="mt-4 flex items-center justify-between">' +
      '<div class="text-sm text-gray-400">Drag the corners to match the grid boundaries</div>' +
      '<div class="flex gap-2">' +
        '<button id="btn-reset-corners" class="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded">Reset</button>' +
        '<button id="btn-apply-corners" class="px-4 py-2 bg-green-600 hover:bg-green-500 rounded font-medium">Apply</button>' +
      '</div>' +
    '</div>' +
    '<div id="corner-coords" class="mt-2 text-xs text-gray-500 font-mono"></div>';

  showCornerPickerModal(modal);

  // Initialize corner picker after DOM update
  setTimeout(function() {
    initCornerPickerCanvas(imageDataURL, existingCorners);
  }, 50);

  // Attach button handlers
  document.getElementById('btn-reset-corners').addEventListener('click', resetCornerPicker);
  document.getElementById('btn-apply-corners').addEventListener('click', applyCornerPicker);
}

var cornerPickerState = {
  corners: null,
  imageSize: { width: 0, height: 0 },
  dragging: null,
  genericMode: false,
  onApplyCallback: null
};

function initCornerPickerCanvas(sheetOrImageURL, existingCorners) {
  var canvas = document.getElementById('corner-picker-canvas');
  var ctx = canvas.getContext('2d');

  // Support both sheet object and raw imageDataURL
  var imageURL, corners;
  if (typeof sheetOrImageURL === 'string') {
    imageURL = sheetOrImageURL;
    corners = existingCorners || null;
  } else {
    imageURL = sheetOrImageURL.image;
    corners = sheetOrImageURL.corners || null;
  }

  var img = new Image();
  img.onload = function() {
    // Scale to fit
    var maxW = 800, maxH = 600;
    var scale = Math.min(maxW / img.width, maxH / img.height, 1);
    var w = Math.round(img.width * scale);
    var h = Math.round(img.height * scale);

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);

    cornerPickerState.imageSize = { width: w, height: h };
    cornerPickerState.imageScale = scale;
    cornerPickerState.originalWidth = img.width;
    cornerPickerState.originalHeight = img.height;

    // Initialize corners (default to 10% padding or use existing)
    if (corners) {
      cornerPickerState.corners = JSON.parse(JSON.stringify(corners));
    } else {
      var pad = 0.1;
      cornerPickerState.corners = {
        topLeft: { x: w * pad, y: h * pad },
        topRight: { x: w * (1 - pad), y: h * pad },
        bottomRight: { x: w * (1 - pad), y: h * (1 - pad) },
        bottomLeft: { x: w * pad, y: h * (1 - pad) }
      };
    }

    // Setup SVG overlay
    var svg = document.getElementById('corner-picker-svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.style.pointerEvents = 'auto';

    renderCornerPickerOverlay();
    attachCornerPickerEvents(svg);
  };
  img.src = imageURL;
}

function renderCornerPickerOverlay() {
  var svg = document.getElementById('corner-picker-svg');
  var c = cornerPickerState.corners;
  if (!c) return;
  
  var points = `${c.topLeft.x},${c.topLeft.y} ${c.topRight.x},${c.topRight.y} ${c.bottomRight.x},${c.bottomRight.y} ${c.bottomLeft.x},${c.bottomLeft.y}`;
  
  svg.innerHTML = `
    <!-- Darkened area outside selection -->
    <defs>
      <mask id="holeMask">
        <rect width="100%" height="100%" fill="white"/>
        <polygon points="${points}" fill="black"/>
      </mask>
    </defs>
    <rect width="100%" height="100%" fill="rgba(0,0,0,0.5)" mask="url(#holeMask)"/>
    
    <!-- Selection border -->
    <polygon points="${points}" fill="none" stroke="#00ff00" stroke-width="2"/>
    
    <!-- Corner handles -->
    ${renderCornerHandle('topLeft', c.topLeft, 'TL')}
    ${renderCornerHandle('topRight', c.topRight, 'TR')}
    ${renderCornerHandle('bottomRight', c.bottomRight, 'BR')}
    ${renderCornerHandle('bottomLeft', c.bottomLeft, 'BL')}
    
    <!-- Edge handles -->
    ${renderEdgeHandle('top', c.topLeft, c.topRight)}
    ${renderEdgeHandle('right', c.topRight, c.bottomRight)}
    ${renderEdgeHandle('bottom', c.bottomRight, c.bottomLeft)}
    ${renderEdgeHandle('left', c.bottomLeft, c.topLeft)}
  `;
  
  // Update coordinates display
  var coordsDiv = document.getElementById('corner-coords');
  if (coordsDiv) {
    coordsDiv.textContent = `TL:(${Math.round(c.topLeft.x)},${Math.round(c.topLeft.y)}) TR:(${Math.round(c.topRight.x)},${Math.round(c.topRight.y)}) BR:(${Math.round(c.bottomRight.x)},${Math.round(c.bottomRight.y)}) BL:(${Math.round(c.bottomLeft.x)},${Math.round(c.bottomLeft.y)})`;
  }
}

function renderCornerHandle(key, pos, label) {
  return `
    <g class="corner-handle" data-corner="${key}" style="cursor: grab;">
      <circle cx="${pos.x}" cy="${pos.y}" r="12" fill="#ff0000" stroke="white" stroke-width="2"/>
      <text x="${pos.x}" y="${pos.y + 4}" text-anchor="middle" fill="white" font-size="10" font-weight="bold" style="pointer-events: none;">${label}</text>
    </g>
  `;
}

function renderEdgeHandle(key, p1, p2) {
  var mx = (p1.x + p2.x) / 2;
  var my = (p1.y + p2.y) / 2;
  return `
    <circle class="edge-handle" data-edge="${key}" cx="${mx}" cy="${my}" r="6" fill="#ffff00" stroke="white" stroke-width="1" style="cursor: grab; opacity: 0.7;"/>
  `;
}

function attachCornerPickerEvents(svg) {
  svg.addEventListener('mousedown', function(e) {
    var corner = e.target.closest('.corner-handle');
    var edge = e.target.closest('.edge-handle');
    
    if (corner) {
      cornerPickerState.dragging = { type: 'corner', key: corner.dataset.corner };
    } else if (edge) {
      cornerPickerState.dragging = { type: 'edge', key: edge.dataset.edge };
    }
  });
  
  svg.addEventListener('mousemove', function(e) {
    if (!cornerPickerState.dragging) return;
    
    var rect = svg.getBoundingClientRect();
    var x = (e.clientX - rect.left) * (cornerPickerState.imageSize.width / rect.width);
    var y = (e.clientY - rect.top) * (cornerPickerState.imageSize.height / rect.height);
    
    // Clamp to image bounds
    x = Math.max(0, Math.min(cornerPickerState.imageSize.width, x));
    y = Math.max(0, Math.min(cornerPickerState.imageSize.height, y));
    
    var c = cornerPickerState.corners;
    var d = cornerPickerState.dragging;
    
    if (d.type === 'corner') {
      c[d.key] = { x: x, y: y };
    } else if (d.type === 'edge') {
      // Move both corners of the edge
      var edgeMap = {
        top: ['topLeft', 'topRight'],
        right: ['topRight', 'bottomRight'],
        bottom: ['bottomRight', 'bottomLeft'],
        left: ['bottomLeft', 'topLeft']
      };
      var corners = edgeMap[d.key];
      var isVertical = (d.key === 'left' || d.key === 'right');
      
      if (isVertical) {
        var dx = x - (c[corners[0]].x + c[corners[1]].x) / 2;
        c[corners[0]].x += dx;
        c[corners[1]].x += dx;
      } else {
        var dy = y - (c[corners[0]].y + c[corners[1]].y) / 2;
        c[corners[0]].y += dy;
        c[corners[1]].y += dy;
      }
    }
    
    renderCornerPickerOverlay();
  });
  
  svg.addEventListener('mouseup', function() {
    cornerPickerState.dragging = null;
  });
  
  svg.addEventListener('mouseleave', function() {
    cornerPickerState.dragging = null;
  });
}

function resetCornerPicker() {
  var w = cornerPickerState.imageSize.width;
  var h = cornerPickerState.imageSize.height;
  var pad = 0.1;
  
  cornerPickerState.corners = {
    topLeft: { x: w * pad, y: h * pad },
    topRight: { x: w * (1 - pad), y: h * pad },
    bottomRight: { x: w * (1 - pad), y: h * (1 - pad) },
    bottomLeft: { x: w * pad, y: h * (1 - pad) }
  };
  
  renderCornerPickerOverlay();
}

function applyCornerPicker() {
  // Generic mode: call the stored callback with corners scaled to original image size
  if (cornerPickerState.genericMode && cornerPickerState.onApplyCallback) {
    var scale = cornerPickerState.imageScale || 1;
    var scaledCorners = {};
    var keys = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      scaledCorners[k] = {
        x: Math.round(cornerPickerState.corners[k].x / scale),
        y: Math.round(cornerPickerState.corners[k].y / scale)
      };
    }
    cornerPickerState.onApplyCallback(scaledCorners);
    hideCornerPicker();
    return;
  }

  // Sheet-specific mode
  var active = sheetsState.activeCornerPicker;
  if (!active) return;

  var sheet = sheetsState['player' + active.player][active.sheet];
  if (sheet) {
    sheet.corners = JSON.parse(JSON.stringify(cornerPickerState.corners));
    sheet.status = SHEET_STATUS.GRID_OK;

    log('✓ Corners applied for Player ' + active.player + ' Page ' + (active.sheet + 1));

    // Start OCR in background
    startBackgroundOCR(active.player, active.sheet);
  }

  hideCornerPicker();
  refreshSheetsUI();
  updateProcessButton();
}

// =============================================================================
// OCR PROCESSING
// =============================================================================


async function startBackgroundOCR(player, sheetIndex) {
  var sheet = sheetsState['player' + player][sheetIndex];
  if (!sheet || sheet.status !== SHEET_STATUS.GRID_OK) return;

  sheet.status = SHEET_STATUS.OCR_RUNNING;
  refreshSheetsUI();

  try {
    // Build grid config from profile
    var gridConfig;
    if (window.SheetProfiles) {
      gridConfig = window.SheetProfiles.getProfileGridConfig(sheetIndex + 1, {
        format: sheet.format, rowCount: sheet.rowCount
      });
    } else {
      gridConfig = getGridConfig(sheet.rowCount || 20, sheet.format || '2col');
    }

    // Use client-side pipeline if available, WITH corners for perspective correction
    if (window.zugwise && window.zugwise.isReady) {
      // Convert dataURL to File for processScoresheet
      var blob = await fetch(sheet.image).then(function(r) { return r.blob(); });
      var file = new File([blob], 'sheet.png', { type: blob.type });

      // Scale corners to original image size if they were set in picker coordinates
      var corners = sheet.corners || null;

      var sheetId = player;  // Use player number as sheet ID for dual logit storage
      var result = await window.zugwise.processScoresheet(file, function(msg) {
        sheet.ocrProgress = msg;
        updateProcessButton();
      }, gridConfig, corners, sheetId);

      sheet.ocrResult = { moves: result.moves || [] };
      sheet.moveCount = result.moves ? result.moves.length : 0;
      sheet.status = SHEET_STATUS.OCR_DONE;

      log('✓ OCR done: ' + sheet.moveCount + ' moves for Player ' + player + ' Page ' + (sheetIndex + 1));
    } else {
      // Fallback to backend OCR
      var ocrResult = await runOCR(sheet.image);
      sheet.ocrResult = ocrResult;
      sheet.moveCount = ocrResult.moves ? ocrResult.moves.length : 0;
      sheet.status = SHEET_STATUS.OCR_DONE;

      log('✓ OCR done: ' + sheet.moveCount + ' moves for Player ' + player + ' Page ' + (sheetIndex + 1));
    }
  } catch (err) {
    sheet.status = SHEET_STATUS.ERROR;
    log('✗ OCR error: ' + err.message);
  }

  refreshSheetsUI();
  updateProcessButton();
}


async function applyPerspectiveCorrection(imageDataURL, corners) {
  // TODO: Implement client-side perspective correction using OpenCV.js
  // For now, send to backend
  
  try {
    var blob = await fetch(imageDataURL).then(function(r) { return r.blob(); });
    var formData = new FormData();
    formData.append('image', blob);
    formData.append('corners', JSON.stringify(corners));
    
    var resp = await fetch(CONFIG.apiUrl + '/api/perspective-correct', {
      method: 'POST',
      body: formData
    });
    
    if (resp.ok) {
      var data = await resp.json();
      return data.corrected_image || imageDataURL;
    }
  } catch (err) {
    console.warn('Perspective correction API error:', err);
  }
  
  return imageDataURL;
}

async function runOCR(imageDataURL) {
  // Use existing OCR endpoint
  var blob = await fetch(imageDataURL).then(function(r) { return r.blob(); });
  var formData = new FormData();
  formData.append('image', blob);
  
  var resp = await fetch(CONFIG.apiUrl + '/api/ocr', {
    method: 'POST',
    body: formData
  });
  
  if (!resp.ok) {
    throw new Error('OCR request failed');
  }
  
  return await resp.json();
}

// =============================================================================
// PROCESS ALL SHEETS
// =============================================================================

async function processAllSheets() {
  log('🚀 Processing all sheets...');
  
  var allMoves = [];
  
  // Collect moves in order: P1-1, P1-2, P1-3, P2-1, P2-2, P2-3
  // But actually we want: White sheets first, then Black sheets
  // Or: interleaved by move number if we have both players
  
  // For now, simple concatenation by player order
  for (var p = 1; p <= 2; p++) {
    var playerMoves = [];
    for (var s = 0; s < 3; s++) {
      var sheet = sheetsState['player' + p][s];
      if (sheet && sheet.ocrResult && sheet.ocrResult.moves) {
        playerMoves = playerMoves.concat(sheet.ocrResult.moves);
      }
    }
    
    if (playerMoves.length > 0) {
      var color = sheetsState['player' + p + 'Color'] || (p === 1 ? 'white' : 'black');
      allMoves.push({
        player: p,
        color: color,
        moves: playerMoves
      });
    }
  }
  
  if (allMoves.length === 0) {
    log('⚠️ No moves to process');
    return;
  }
  
  // If we have both players, merge their moves
  if (allMoves.length === 2) {
    var merged = mergePlayerMoves(allMoves[0], allMoves[1]);
    log('✓ Merged moves from both players: ' + merged.length + ' total');

    // Store per-sheet OCR cells for context panel and download
    var whiteData = allMoves[0].color === 'white' ? allMoves[0] : allMoves[1];
    var blackData = allMoves[0].color === 'black' ? allMoves[0] : allMoves[1];
    state.ocrCellsSheet1 = whiteData.moves;
    state.ocrCellsSheet2 = blackData.moves;
    state.ocrCells = merged;  // Combined cells for OCR context panel
    state.hasGridImage = merged.some(function(m) { return m.imageDataUrl; });
    state.inputMode = 'dual-sheets';

    // Widen layout: remove page max-width and grow the right panel
    var mainEl = document.getElementById('main-content');
    if (mainEl) {
      mainEl.classList.remove('max-w-7xl');
    }
    // Shrink board to 3 cols, keep fixes at 4, give moves panel 5
    var panelBoard = document.getElementById('panel-board');
    var panelMoves = document.getElementById('panel-moves');
    if (panelBoard) { panelBoard.classList.remove('col-span-4'); panelBoard.classList.add('col-span-3'); }
    if (panelMoves) { panelMoves.classList.remove('col-span-4'); panelMoves.classList.add('col-span-5'); }
    var inputBar = document.getElementById('input-bar');
    if (inputBar) inputBar.classList.remove('max-w-7xl');

    // Set locked plies from merge before validation
    // Store them so validateAndDisplay's reset can be overridden
    if (state.mergeLockedPlies && state.mergeLockedPlies.length > 0) {
      state._pendingMergeLockedPlies = state.mergeLockedPlies.slice();
      log('🔒 Will lock ' + state._pendingMergeLockedPlies.length + ' plies from dual-sheet agreement');
    }
    // Route through showOcrResults for noise review, then validate
    var paired = pairMoves(merged);
    showOcrResults(paired, 'Dual scoresheets');
    if (!state.pendingNoiseReview) {
      await validateAndDisplay(paired, 'Dual scoresheets');
    }
  } else {
    // Single player
    var moves = allMoves[0].moves;
    state.ocrCells = moves;
    state.ocrCellsSheet1 = null;
    state.ocrCellsSheet2 = null;
    state.hasGridImage = moves.some(function(m) { return m.imageDataUrl; });
    state.inputMode = 'image';
    log('✓ Single player moves: ' + moves.length + ' total');
    var paired = pairMoves(moves);
    showOcrResults(paired, 'Single scoresheet');
    if (!state.pendingNoiseReview) {
      await validateAndDisplay(paired, 'Single scoresheet');
    }
  }
}

function mergePlayerMoves(player1Data, player2Data) {
  if (!window.MergeSheets) {
    log('⚠️ merge-sheets.js not loaded, falling back to player 1 data');
    return player1Data.moves;
  }

  var whiteMoves = player1Data.color === 'white' ? player1Data.moves : player2Data.moves;
  var blackMoves = player1Data.color === 'black' ? player1Data.moves : player2Data.moves;

  // Detect shift before merging
  var shiftResult = window.MergeSheets.detectShift(whiteMoves, blackMoves);
  if (shiftResult.detected) {
    log('⚠️ Sheet shift detected: offset=' + shiftResult.offset + ' (confidence=' + Math.round(shiftResult.confidence * 100) + '%)');
  }

  // Merge the two sheets
  var merged = window.MergeSheets.mergeSheets(whiteMoves, blackMoves);
  log('✓ Merged ' + whiteMoves.length + ' + ' + blackMoves.length + ' → ' + merged.length + ' moves');

  // Classify tiers
  var tierMap = window.MergeSheets.classifyTiers(merged);
  state.mergeTierMap = tierMap;

  // Compute locked plies based on current lock mode
  var lockMode = (state.mergeSettings && state.mergeSettings.lockMode) || 'tier1';
  var lockedPlies = window.MergeSheets.computeLockedPlies(tierMap, lockMode);
  state.mergeLockedPlies = lockedPlies;

  // Log tier summary
  var tSummary = window.MergeSheets.tierSummary(tierMap);
  log('📊 Tiers: ' + tSummary.summary);

  // Show agreement summary banner (matches dot colors)
  var aSummary = window.MergeSheets.agreementSummary(merged);
  showTierSummaryBanner(aSummary, lockMode);

  return merged;
}

function pairMoves(ocrMoves) {
  // Convert flat OCR moves to paired format expected by app.js
  // This may already exist in ocr.js
  if (typeof window.pairMoves === 'function') {
    return window.pairMoves(ocrMoves);
  }
  
  // Fallback implementation
  var map = {};
  ocrMoves.forEach(function(m) {
    var num = m.num || m.move_number || 1;
    if (!map[num]) map[num] = { num: num, white: '', black: '', wConf: 0, bConf: 0 };
    if (m.color === 'w' || m.color === 'white') {
      map[num].white = m.move || m.san;
      map[num].wConf = m.confidence || 0.9;
    } else {
      map[num].black = m.move || m.san;
      map[num].bConf = m.confidence || 0.9;
    }
  });
  
  return Object.keys(map).map(Number).sort(function(a, b) { return a - b; }).map(function(n) { return map[n]; });
}

// =============================================================================
// UI HELPERS
// =============================================================================

function refreshSheetsUI() {
  var container = document.getElementById('sheets-uploader');
  if (container) {
    container.innerHTML = renderSheetsUploader();
    attachSheetEventListeners();
  }
}

function updateProcessButton() {
  var btn = document.getElementById('btn-process-sheets');
  if (!btn) return;
  
  // Enable if at least one sheet is ready (GRID_OK or OCR_DONE)
  // and no sheets are in NEEDS_CORNERS state
  var hasReady = false;
  var hasNeedsCorners = false;
  var hasProcessing = false;
  
  for (var p = 1; p <= 2; p++) {
    for (var s = 0; s < 3; s++) {
      var sheet = sheetsState['player' + p][s];
      if (sheet) {
        if (sheet.status === SHEET_STATUS.GRID_OK || sheet.status === SHEET_STATUS.OCR_DONE) {
          hasReady = true;
        }
        if (sheet.status === SHEET_STATUS.NEEDS_CORNERS) {
          hasNeedsCorners = true;
        }
        if (sheet.status === SHEET_STATUS.LOADING || sheet.status === SHEET_STATUS.OCR_RUNNING) {
          hasProcessing = true;
        }
      }
    }
  }
  
  var canProcess = hasReady && !hasNeedsCorners && !hasProcessing && !sheetsState.isProcessing;
  btn.disabled = !canProcess;
  
  if (sheetsState.isProcessing) {
    btn.textContent = 'Processing...';
  } else if (hasNeedsCorners) {
    btn.textContent = 'Fix corners first ⚠️';
  } else if (hasProcessing) {
    // Show OCR progress from running sheets
    var progressParts = [];
    for (var pp = 1; pp <= 2; pp++) {
      for (var ss = 0; ss < 3; ss++) {
        var sh = sheetsState['player' + pp][ss];
        if (sh && sh.status === SHEET_STATUS.OCR_RUNNING && sh.ocrProgress) {
          progressParts.push('P' + pp + ': ' + sh.ocrProgress);
        }
      }
    }
    btn.textContent = progressParts.length > 0 ? progressParts.join(' | ') : 'Please wait...';
  } else {
    btn.textContent = 'Process All Sheets →';
  }
}

// =============================================================================
// CSS STYLES (inject into page)
// =============================================================================

function injectSheetsStyles() {
  if (document.getElementById('sheets-styles')) return;
  
  var style = document.createElement('style');
  style.id = 'sheets-styles';
  style.textContent = `
    .sheets-container {
      background: rgba(31, 41, 55, 0.5);
      border: 1px solid #374151;
      border-radius: 0.5rem;
      padding: 1rem;
    }
    
    .sheet-box {
      transition: all 0.2s ease;
    }
    
    .sheet-box:hover {
      transform: scale(1.02);
    }
    
    .spinner-small {
      width: 20px;
      height: 20px;
      border: 2px solid #374151;
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .corner-handle:hover circle {
      r: 14;
      fill: #00ff00;
    }
    
    .edge-handle:hover {
      opacity: 1 !important;
      r: 8;
    }
  `;
  
  document.head.appendChild(style);
}

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    injectSheetsStyles();
  });
} else {
  injectSheetsStyles();
}

// =============================================================================
// TIER SUMMARY BANNER & LOCK MODE UI
// =============================================================================

/**
 * Show/update the tier summary banner after dual-sheet merge.
 */
function showTierSummaryBanner(agreeSummary, lockMode) {
  var existing = document.getElementById('tier-summary-banner');
  if (existing) existing.remove();

  // Place banner in input-collapsed so it stays visible after processing
  var container = document.getElementById('input-collapsed');
  if (!container) return;

  var banner = document.createElement('div');
  banner.id = 'tier-summary-banner';
  // Compact inline layout to fit within the collapsed input bar
  banner.className = 'flex items-center gap-3 ml-3 text-xs';

  banner.innerHTML =
    '<span class="text-gray-500">|</span>' +
    '<span class="text-green-400 cursor-help" title="Both sheets wrote the same move">' +
      '<span class="inline-block w-2 h-2 rounded-full bg-green-400 mr-0.5"></span>' + agreeSummary.agree + '</span>' +
    (agreeSummary.oneSheet > 0 ?
      '<span class="text-yellow-400 cursor-help" title="Only one sheet has data for this ply">' +
        '<span class="inline-block w-2 h-2 rounded-full bg-yellow-400 mr-0.5"></span>' + agreeSummary.oneSheet + '</span>'
      : '') +
    (agreeSummary.disagree > 0 ?
      '<span class="text-red-400 cursor-help" title="Both sheets have data but they disagree">' +
        '<span class="inline-block w-2 h-2 rounded-full bg-red-400 mr-0.5"></span>' + agreeSummary.disagree + '</span>'
      : '') +
    '<span class="text-gray-500">|</span>' +
    '<span class="cursor-help text-gray-400" title="Lock mode: which plies are protected from fix-finder">Lock:</span>' +
    '<label class="flex items-center gap-0.5 cursor-pointer" title="No plies locked">' +
      '<input type="radio" name="lock-mode" value="none" ' + (lockMode === 'none' ? 'checked' : '') + ' class="lock-mode-radio"> <span class="text-gray-400">Off</span>' +
    '</label>' +
    '<label class="flex items-center gap-0.5 cursor-pointer" title="Lock Tier 1 (both agree + legal)">' +
      '<input type="radio" name="lock-mode" value="tier1" ' + (lockMode === 'tier1' ? 'checked' : '') + ' class="lock-mode-radio"> <span class="text-gray-400">T1</span>' +
    '</label>' +
    '<label class="flex items-center gap-0.5 cursor-pointer" title="Lock Tier 1 + Tier 2">' +
      '<input type="radio" name="lock-mode" value="tier1+2" ' + (lockMode === 'tier1+2' ? 'checked' : '') + ' class="lock-mode-radio"> <span class="text-gray-400">T1+2</span>' +
    '</label>';

  // Insert banner into the first flex child (left side) of input-collapsed
  var leftSide = container.querySelector('.flex.items-center.gap-2');
  if (leftSide) {
    leftSide.appendChild(banner);
  } else {
    container.appendChild(banner);
  }

  // Attach lock mode radio handlers
  banner.querySelectorAll('.lock-mode-radio').forEach(function(radio) {
    radio.addEventListener('change', function() {
      var newMode = radio.value;
      if (!state.mergeSettings) state.mergeSettings = {};
      state.mergeSettings.lockMode = newMode;

      if (state.mergeTierMap) {
        var newLocked = window.MergeSheets.computeLockedPlies(state.mergeTierMap, newMode);
        state.mergeLockedPlies = newLocked;
        state.lockedPlies = newLocked.slice();
        log('🔒 Lock mode changed to ' + newMode + ': ' + newLocked.length + ' plies locked');
      }
    });
  });
}

// Export utilities for use by other modules
window.readFileAsDataURL = readFileAsDataURL;
window.showCornerPickerGeneric = showCornerPickerGeneric;
