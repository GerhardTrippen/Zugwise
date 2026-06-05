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

  // Dual-sheet thumbnails (original landscape image data URLs, per page slot)
  dualSheetThumbnails: [null, null, null],

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
  log('📋 Sheet uploader initialized');
}

// =============================================================================
// INFO PANEL
// =============================================================================

function renderSheetsInfoPanel() {
  return `
    <div class="text-xs text-gray-300 space-y-2 pl-2 border-l border-gray-700">
      <div>
        <span class="text-gray-200 font-medium">Built-in OCR</span><br>
        ~80% move recognition accuracy (MRA) using the offline BiLSTM model.
        Zugwise's auto-fix engine corrects most remaining errors.
      </div>
      <div>
        <span class="text-gray-200 font-medium">Want higher accuracy?</span><br>
        Use an LLM (Claude, GPT) for OCR to achieve 90%+ MRA.
        Paste the result under the
        <a href="ocr-prompt.md" target="_blank" class="text-blue-400 hover:text-blue-300 underline">OCR Text</a> tab.
      </div>
      <div class="text-gray-400">
        Tip: Use <b class="text-gray-300">Batch</b> mode for tournament processing,
        or open multiple tabs for ad-hoc games.
      </div>
    </div>
  `;
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
          <button id="btn-change-input-expanded" class="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded" title="Discard everything (sheets, OCR, batch state) and start fresh">
            🔄 Change
          </button>
        </div>
      </div>
      
      ${renderDualSheetRow()}

      <div class="flex gap-4 items-start">
        <!-- Player Rows -->
        <div class="flex-shrink-0">
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
        </div>

        ${renderSheetsInfoPanel()}
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
          Process Sheets →
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
        <div class="flex flex-col items-center justify-center h-full text-gray-400">
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
      if (sheet && sheet.method !== 'contour') {
        content = renderSheetThumbnail(sheet, pageNum, '⚠️ Click to adjust') +
          '<button class="sheet-try-contour absolute top-7 left-1/2 -translate-x-1/2 bg-blue-600 hover:bg-blue-500 text-white text-xs px-2 py-0.5 rounded z-20 whitespace-nowrap" data-player="' + player + '" data-sheet="' + sheetIndex + '">Try Contour</button>';
      } else {
        content = renderSheetThumbnail(sheet, pageNum, '⚠️ Click to adjust');
      }
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
      statusClass = 'border-red-500 cursor-pointer';
      statusIndicator = '<span class="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500"></span>';
      if (sheet && sheet.method !== 'contour') {
        content = renderSheetThumbnail(sheet, pageNum, '❌ Failed') +
          '<button class="sheet-try-contour absolute top-7 left-1/2 -translate-x-1/2 bg-blue-600 hover:bg-blue-500 text-white text-xs px-2 py-0.5 rounded z-20 whitespace-nowrap" data-player="' + player + '" data-sheet="' + sheetIndex + '">Try Contour</button>';
      } else {
        content = renderSheetThumbnail(sheet, pageNum, '❌ Failed — adjust corners');
      }
      break;
  }
  
  // Per-sheet override dropdowns (visible when image is loaded)
  var sheetOverrides = '';
  if (sheet && (status === SHEET_STATUS.GRID_OK || status === SHEET_STATUS.OCR_RUNNING ||
                status === SHEET_STATUS.OCR_DONE || status === SHEET_STATUS.NEEDS_CORNERS ||
                status === SHEET_STATUS.ERROR)) {
    sheetOverrides = `
      <div class="absolute bottom-0 left-0 right-0 bg-black/80 p-0.5 text-xs flex gap-1 z-10 sheet-overrides">
        <select class="sheet-method-select bg-gray-700 text-white rounded px-1 text-xs"
                data-player="${player}" data-sheet="${sheetIndex}" title="Grid detection method">
          <option value="slide" ${(sheet.method||'slide')==='slide'?'selected':''}>Slide</option>
          <option value="anchor" ${sheet.method==='anchor'?'selected':''}>Anchor</option>
          <option value="contour" ${sheet.method==='contour'?'selected':''}>Contour</option>
        </select>
        <select class="sheet-format-select bg-gray-700 text-white rounded px-1 text-xs flex-1"
                data-player="${player}" data-sheet="${sheetIndex}">
          <option value="2col" ${sheet.format==='2col'?'selected':''}>2col</option>
          <option value="3col" ${sheet.format==='3col'?'selected':''}>3col</option>
        </select>
        <input type="number" min="5" max="60" step="1" list="rowcount-suggestions"
               value="${sheet.rowCount || 20}"
               class="sheet-rows-select bg-gray-700 text-white rounded px-1 text-xs flex-1 w-12"
               data-player="${player}" data-sheet="${sheetIndex}"
               title="Rows per column (any value, suggestions: 15/20/24/25/26/30/35)">
      </div>
    `;
  }

  return `
    <div id="${id}" class="sheet-box relative w-28 h-36 border-2 rounded-lg bg-gray-700/50 overflow-hidden transition-all ${statusClass}"
         data-player="${player}" data-sheet="${sheetIndex}">
      ${statusIndicator}
      <input type="file" accept="image/*,.pdf" class="sheet-file-input hidden" data-player="${player}" data-sheet="${sheetIndex}">
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
// DUAL-SHEET BOXES (3 per-page upload slots)
// =============================================================================

/**
 * Render a single dual-sheet upload box for a page slot (0, 1, 2).
 * Landscape-oriented box that accepts one dual-sheet scan (PDF or image)
 * and auto-splits into Player 1 + Player 2 for that page.
 */
function renderDualSheetBox(pageIndex) {
  var pageNum = pageIndex + 1;
  var thumbnail = sheetsState.dualSheetThumbnails[pageIndex];
  var hasP1 = !!sheetsState.player1[pageIndex];
  var hasP2 = !!sheetsState.player2[pageIndex];
  var hasBoth = hasP1 && hasP2;

  var content = '';
  var borderClass = '';

  if (thumbnail && hasBoth) {
    // Loaded — show landscape thumbnail
    borderClass = 'border-green-500';
    content = `
      <div class="relative w-full h-full">
        <img src="${thumbnail}" class="w-full h-full object-cover" alt="Dual Page ${pageNum}">
        <div class="absolute top-0.5 left-0.5 bg-black/60 text-xs px-1 rounded text-gray-300">P${pageNum}</div>
        <div class="absolute bottom-0 left-0 right-0 bg-black/70 text-xs text-center py-0.5 text-green-300">&#x2713; Split → P1.${pageNum} + P2.${pageNum}</div>
      </div>`;
  } else {
    // Empty — show drop prompt
    borderClass = 'border-dashed border-gray-600 hover:border-blue-400';
    content = `
      <div class="flex flex-col items-center justify-center h-full text-gray-400">
        <span class="text-lg mb-0.5">+</span>
        <span class="text-xs">Page ${pageNum}</span>
      </div>`;
  }

  return `
    <div class="dual-sheet-box relative w-36 h-24 border-2 rounded-lg bg-gray-700/50 overflow-hidden transition-all cursor-pointer ${borderClass}"
         data-page="${pageIndex}" title="Drop dual-sheet scan for page ${pageNum} (PDF or image)">
      <input type="file" accept="image/*,.pdf" class="dual-sheet-box-input hidden" data-page="${pageIndex}">
      ${content}
    </div>
  `;
}

/**
 * Render a row of 3 dual-sheet upload boxes with a label.
 */
function renderDualSheetRow() {
  return `
    <div class="dual-sheet-row mb-4">
      <div class="flex items-center gap-2 mb-1">
        <span class="text-xs text-gray-400">Dual-sheet scans</span>
        <span class="text-xs text-gray-500">(side-by-side scoresheets — auto-splits into P1 + P2)</span>
      </div>
      <div class="flex gap-3">
        ${renderDualSheetBox(0)}
        ${renderDualSheetBox(1)}
        ${renderDualSheetBox(2)}
      </div>
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

  // Change button (full reset — wired to the same handler app.js uses for the
  // collapsed-view button). Re-bound on every refresh because the renderer
  // recreates the DOM node.
  var changeBtn = document.getElementById('btn-change-input-expanded');
  if (changeBtn && typeof window.handleChangeInput === 'function') {
    changeBtn.addEventListener('click', window.handleChangeInput);
  }
  
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
  document.querySelectorAll('.sheet-method-select').forEach(function(sel) {
    sel.addEventListener('click', function(e) { e.stopPropagation(); });
    sel.addEventListener('change', function(e) {
      e.stopPropagation();
      var player = parseInt(sel.dataset.player);
      var sheetIdx = parseInt(sel.dataset.sheet);
      var sheet = sheetsState['player' + player][sheetIdx];
      if (sheet) {
        sheet.method = sel.value;
        redetectGrid(player, sheetIdx);
      }
    });
  });
  // "Try Contour" buttons
  document.querySelectorAll('.sheet-try-contour').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var player = parseInt(btn.dataset.player);
      var sheetIdx = parseInt(btn.dataset.sheet);
      var sheet = sheetsState['player' + player][sheetIdx];
      if (sheet) {
        sheet.method = 'contour';
        redetectGrid(player, sheetIdx);
      }
    });
  });

  // Dual-sheet drop zone
  attachDualSheetDropZone(document.getElementById('sheets-uploader'));
}

/**
 * Handle a single file dropped/selected in a specific dual-sheet page box.
 * Converts PDF → image(s) if needed, detects dual-sheet, splits into P1 + P2.
 * Multi-page PDFs fill consecutive page slots starting from pageIndex.
 */
async function handleDualSheetBoxFile(pageIndex, file) {
  if (!file) return;

  // Expand PDF into page images
  var pageImages = [];
  if (typeof isPDF === 'function' && isPDF(file)) {
    log('📄 Converting PDF: ' + file.name);
    try {
      pageImages = await pdfToImageFiles(file);
    } catch (e) {
      log('❌ PDF conversion error: ' + ((e && e.message) ? e.message : String(e)));
      return;
    }
  } else {
    pageImages = [file];
  }

  if (pageImages.length === 0) {
    log('No pages to process');
    return;
  }

  var hasDual = false;

  // Process each page image into consecutive slots starting from pageIndex
  for (var i = 0; i < pageImages.length && (pageIndex + i) < 3; i++) {
    var slot = pageIndex + i;
    var pageFile = pageImages[i];
    var dualInfo = typeof detectDualSheet === 'function' ? await detectDualSheet(pageFile) : { isDual: false };

    if (dualInfo.isDual) {
      hasDual = true;
      var unsplit = (typeof findUnsplitMidpoint === 'function')
        ? await findUnsplitMidpoint(pageFile, slot)
        : { midpoint: null, failureReason: null };
      if (unsplit.failureReason) {
        var unsplitMsg = '⚠ Anchor detection: ' + unsplit.failureReason
            + ' — using ink-valley fallback. If results look wrong, try a different Format / Cols × Rows.';
        log(unsplitMsg);
        if (typeof showHintBanner === 'function') showHintBanner(unsplitMsg);
      }
      var halves = await splitDualSheet(pageFile, dualInfo.width, dualInfo.height,
        unsplit.midpoint !== null ? { cutX: unsplit.midpoint } : null);
      log('  Page ' + (slot + 1) + ': dual-sheet (' + dualInfo.width + 'x' + dualInfo.height +
          ') → P1.' + (slot + 1) + ' + P2.' + (slot + 1));
      var leftAnchors = unsplit.leftHalfAnchorXs;
      var rightAnchors = unsplit.rightHalfAnchorXs;
      // When GridUnsplit had to infer a missing leftmost column, per-half
      // detection can't see that column — force-use the anchors instead of
      // trying clean per-half first.
      var inferredLeftCol = !!unsplit.inferredLeftColumn;

      // Store landscape thumbnail for the dual-sheet box display
      try {
        var thumbUrl = await readFileAsDataURL(pageFile);
        sheetsState.dualSheetThumbnails[slot] = thumbUrl;
      } catch (e) {
        // Non-critical — box will still show "Split" status
      }

      loadSheetImage(1, slot, halves.left, {
        predefinedAnchorXs: leftAnchors,
        inferredLeftColumn: inferredLeftCol
      });
      loadSheetImage(2, slot, halves.right, {
        predefinedAnchorXs: rightAnchors,
        inferredLeftColumn: inferredLeftCol
      });
    } else {
      // Not landscape — load as single sheet into Player 1
      log('  Page ' + (slot + 1) + ': single sheet → P1.' + (slot + 1));
      sheetsState.dualSheetThumbnails[slot] = null;
      loadSheetImage(1, slot, pageFile);
    }
  }

}

/**
 * Wire up the dual-sheet page boxes within a container element.
 * Each box gets click, drag/drop, and file input handlers.
 * @param {HTMLElement} container - Parent element to search within
 */
function attachDualSheetDropZone(container) {
  if (!container) return;
  container.querySelectorAll('.dual-sheet-box').forEach(function(box) {
    var pageIndex = parseInt(box.dataset.page);
    var fileInput = box.querySelector('.dual-sheet-box-input');

    // Click → open file picker
    box.addEventListener('click', function() {
      if (fileInput) fileInput.click();
    });

    // Drag & drop
    box.addEventListener('dragover', function(e) {
      e.preventDefault();
      box.classList.add('ring-2', 'ring-blue-400');
    });
    box.addEventListener('dragleave', function(e) {
      e.preventDefault();
      box.classList.remove('ring-2', 'ring-blue-400');
    });
    box.addEventListener('drop', function(e) {
      e.preventDefault();
      box.classList.remove('ring-2', 'ring-blue-400');
      var files = Array.from(e.dataTransfer.files).filter(function(f) {
        return f.type.startsWith('image/') || isPDF(f);
      });
      if (files.length > 0) {
        handleDualSheetBoxFile(pageIndex, files[0]);
      }
    });

    // File input change
    if (fileInput) {
      fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files.length > 0) {
          handleDualSheetBoxFile(pageIndex, fileInput.files[0]);
        }
        fileInput.value = '';  // Reset so same file can be re-selected
      });
    }
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
  } else if (sheet.status === SHEET_STATUS.OCR_DONE || sheet.status === SHEET_STATUS.GRID_OK ||
             sheet.status === SHEET_STATUS.ERROR) {
    // Re-OCR: show corner picker to adjust and re-run OCR
    showCornerPicker(player, sheetIndex);
  }
}

function handleSheetFileChange(e) {
  var input = e.target;
  var player = parseInt(input.dataset.player);
  var sheetIndex = parseInt(input.dataset.sheet);

  if (input.files && input.files.length > 0) {
    loadSheetFile(player, sheetIndex, input.files[0]);
  }
}

function handleSheetDrop(e) {
  e.preventDefault();
  var box = e.currentTarget;
  box.classList.remove('ring-2', 'ring-blue-400');

  var player = parseInt(box.dataset.player);
  var sheetIndex = parseInt(box.dataset.sheet);

  var files = Array.from(e.dataTransfer.files).filter(function(f) {
    return f.type.startsWith('image/') || isPDF(f);
  });

  if (files.length > 0) {
    loadSheetFile(player, sheetIndex, files[0]);
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
  sheetsState.dualSheetThumbnails = [null, null, null];

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
// FILE INTAKE — PDF conversion + dual-sheet detection
// =============================================================================

/**
 * Entry point for all file uploads (drop or file-input).
 * Handles PDF → image conversion and dual-sheet auto-split before
 * delegating to loadSheetImage() for grid detection + OCR.
 */
async function loadSheetFile(player, sheetIndex, file) {
  var imageFile = file;

  // PDF → image conversion
  if (typeof isPDF === 'function' && isPDF(file)) {
    log('📄 Converting PDF: ' + file.name);
    try {
      var imageFiles = await pdfToImageFiles(file);
      if (imageFiles.length === 0) {
        log('❌ PDF conversion produced no pages');
        return;
      }
      // For multi-page PDFs, load page 1 into current slot, page 2+ into next slots
      if (imageFiles.length > 1) {
        log('📄 PDF has ' + imageFiles.length + ' pages — loading into consecutive slots');
        for (var p = 0; p < imageFiles.length && (sheetIndex + p) < 3; p++) {
          if (p === 0) {
            imageFile = imageFiles[0];  // Will be processed below (may be dual-sheet)
          } else {
            // Load subsequent pages into next sheet slots (same player)
            loadSheetFile(player, sheetIndex + p, imageFiles[p]);
          }
        }
      } else {
        imageFile = imageFiles[0];
      }
    } catch (e) {
      log('❌ PDF conversion error: ' + ((e && e.message) ? e.message : String(e)));
      return;
    }
  }

  // Dual-sheet detection: if the image is landscape, split into two players
  if (typeof detectDualSheet === 'function') {
    var dualInfo = await detectDualSheet(imageFile);
    if (dualInfo.isDual) {
      log('📐 Dual-sheet detected (' + dualInfo.width + 'x' + dualInfo.height +
          ', ratio ' + dualInfo.ratio.toFixed(2) + ') — splitting into Player 1 + Player 2');
      var unsplit = (typeof findUnsplitMidpoint === 'function')
        ? await findUnsplitMidpoint(imageFile, sheetIndex)
        : { midpoint: null, failureReason: null };
      if (unsplit.failureReason) {
        var unsplitMsg = '⚠ Anchor detection: ' + unsplit.failureReason
            + ' — using ink-valley fallback. If results look wrong, try a different Format / Cols × Rows.';
        log(unsplitMsg);
        if (typeof showHintBanner === 'function') showHintBanner(unsplitMsg);
      }
      var halves = await splitDualSheet(imageFile, dualInfo.width, dualInfo.height,
        unsplit.midpoint !== null ? { cutX: unsplit.midpoint } : null);

      // Load left half into Player 1, right half into Player 2 (same page slot).
      // inferredLeftColumn: when GridUnsplit had to extrapolate a clipped
      // leftmost column, per-half detection can't recover it on its own.
      var inferredLeftCol2 = !!unsplit.inferredLeftColumn;
      loadSheetImage(1, sheetIndex, halves.left, {
        predefinedAnchorXs: unsplit.leftHalfAnchorXs,
        inferredLeftColumn: inferredLeftCol2
      });
      loadSheetImage(2, sheetIndex, halves.right, {
        predefinedAnchorXs: unsplit.rightHalfAnchorXs,
        inferredLeftColumn: inferredLeftCol2
      });
      return;
    }
  }

  // Normal single-sheet image
  loadSheetImage(player, sheetIndex, imageFile);
}

// =============================================================================
// IMAGE LOADING & GRID DETECTION
// =============================================================================

async function loadSheetImage(player, sheetIndex, file, opts) {
  log('📷 Loading ' + file.name + ' for Player ' + player + ' Page ' + (sheetIndex + 1));
  opts = opts || {};

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
    rowCount: (window.SheetProfiles ? window.SheetProfiles.getProfileGridConfig(sheetIndex + 1).rowCount : 20),
    method: 'slide',  // default method for new uploads
    // Optional: column X positions in this half-image's coords, supplied by
    // GridUnsplit when the unsplit dual-sheet image yielded reliable anchors.
    // Used to bypass per-half SlideGrid auto-detection that would otherwise
    // fail on a clipped left-most column.
    predefinedAnchorXs: opts.predefinedAnchorXs || null,
    // True when GridUnsplit extrapolated a missing leftmost column. Tells the
    // OCR path to skip clean per-half detection and use the anchors directly
    // (per-half can't find the clipped column on its own).
    inferredLeftColumn: !!opts.inferredLeftColumn
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
    // Pass GridUnsplit-derived per-half anchors into the initial grid detection
    // step (in addition to startBackgroundOCR's later use). Without this, grid
    // detection runs auto-find on a clipped half image and fails before OCR
    // even gets a chance.
    if (sheet.predefinedAnchorXs && sheet.predefinedAnchorXs.length > 0) {
      gridConfig.predefinedAnchorXs = sheet.predefinedAnchorXs;
      gridConfig.inferredLeftColumn = sheet.inferredLeftColumn;
    }
    var gridResult = await detectGrid(imageData, gridConfig, sheet.method);

    // Template-mismatch hint: surface even on successful detection so the
    // user can fix their Format/Rows×Cols selection before OCR results
    // come out wrong. (slide method only — contour path doesn't compute it.)
    if (gridResult.templateWarning) {
      var tmMsg = '⚠ Detection looks off (' + gridResult.templateWarning
                + '). Verify Format / Rows × Cols matches this scoresheet.';
      log(tmMsg);
      if (typeof showHintBanner === 'function') showHintBanner(tmMsg);
    }

    // Leftmost-column-missing hint: surface so the user can verify the
    // synthesized col1 W/B move cells line up with the actual move text.
    if (gridResult.leftmostSynthHint) {
      log(gridResult.leftmostSynthHint);
      if (typeof showHintBanner === 'function') showHintBanner(gridResult.leftmostSynthHint);
    }

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
      log('⚠️ Grid detection failed' + (sheet.method !== 'contour' ? ' — try Contour method or adjust corners' : ' — adjust corners manually'));
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

async function detectGrid(imageDataURL, sheetConfig, method) {
  var useMethod = method || 'slide';
  log('🔍 Running client-side grid detection (' + useMethod + ')...');

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

    if (useMethod === 'anchor' && window.AnchorGrid) {
      // === ANCHOR-BASED DETECTION ===
      var anchorConfig = {
        format: config.format || '2col',
        rowCount: config.rowCount || 20,
        maxColWidthPct: 7,
        minDigitH: 0.8,
        maxDigitH: 4.0,
        maxDigitW: 2.5,
        blockSize: 2.0,
        xWeight: 4,
        stripColors: false
      };

      var anchorResult = window.AnchorGrid.anchorProcessScoresheet(srcMat, anchorConfig, function(msg) {
        log('  [Anchor] ' + msg);
      });

      srcMat.delete();

      var success = anchorResult && anchorResult.cells && anchorResult.cells.length > 0;

      // Build corners in the format sheets.js expects
      var corners = null;
      if (anchorResult && anchorResult.corners) {
        corners = {
          topLeft: anchorResult.corners.TL,
          topRight: anchorResult.corners.TR,
          bottomRight: anchorResult.corners.BR,
          bottomLeft: anchorResult.corners.BL
        };
      }

      // Cleanup warped Mat from anchor result
      if (anchorResult && anchorResult.warped) anchorResult.warped.delete();
      // Cleanup cell images from anchor result
      if (anchorResult && anchorResult.cells) {
        anchorResult.cells.forEach(function(c) { if (c.image && c.image.delete) c.image.delete(); });
      }

      log('  Anchor detection: ' + (success ? 'SUCCESS' : 'FAILED') +
          ' (' + (anchorResult ? anchorResult.cells.length : 0) + ' cells)');

      return { success: success, corners: corners, detectedColor: null };

    } else if (useMethod === 'slide' && window.SlideGrid) {
      // === SLIDE-BASED DETECTION (hole-aligned anchors, no global warp) ===
      var slideConfig = {
        format: config.format || '2col',
        rowCount: config.rowCount || 20,
        maxColWidthPct: 7,
        pageType: 'front'
      };

      // Forward GridUnsplit-derived per-half column anchors into the PREVIEW
      // detection. Without this, detectGrid rebuilt slideConfig from scratch and
      // dropped them, so the preview re-ran blind AutoFind on a dual-sheet half
      // and invented squished/misplaced columns — even though the OCR-extraction
      // path (opencv_image_processor.js) already honored the same anchors. Only
      // ever set for dual-sheet halves, so single-sheet detection is unchanged.
      if (config.predefinedAnchorXs && config.predefinedAnchorXs.length > 0) {
        slideConfig.predefinedAnchorXs = config.predefinedAnchorXs;
        slideConfig.inferredLeftColumn = config.inferredLeftColumn;
      }

      var slideResult = window.SlideGrid.processScoresheet(srcMat, slideConfig, function(msg) {
        // Same gate as opencv_image_processor.js. Flip via
        // `window.SLIDE_VERBOSE_LOG = true` in DevTools.
        if (window.SLIDE_VERBOSE_LOG) log('  [Slide] ' + msg);
      });

      srcMat.delete();

      var success = slideResult && slideResult.cells && slideResult.cells.length > 0;

      // Cleanup slide cell images (detectGrid only checks success, doesn't keep cells)
      if (slideResult && slideResult.cells) {
        slideResult.cells.forEach(function(c) { if (c.image && c.image.delete) c.image.delete(); });
      }

      log('  Slide detection: ' + (success ? 'SUCCESS' : 'FAILED') +
          ' (' + (slideResult ? slideResult.cells.length : 0) + ' cells)');

      return {
        success: success,
        corners: null,
        detectedColor: null,
        templateWarning: slideResult ? slideResult.templateWarning : null,
        leftmostSynthHint: slideResult ? slideResult.leftmostSynthHint : null
      };

    } else {
      // === CONTOUR-BASED DETECTION (v34) ===
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
    }

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

  var gridResult = await detectGrid(sheet.image, gridConfig, sheet.method);

  if (gridResult.success) {
    sheet.corners = gridResult.corners;
    sheet.status = SHEET_STATUS.GRID_OK;
    log('✓ Grid re-detected successfully');
    startBackgroundOCR(player, sheetIndex);
  } else {
    sheet.status = SHEET_STATUS.NEEDS_CORNERS;
    log('⚠️ Grid re-detection failed' + (sheet.method !== 'contour' ? ' — try Contour method' : ' — adjust corners manually'));
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

  var currentMethod = sheet.method || 'slide';
  content.innerHTML = `
    <div class="relative inline-block">
      <canvas id="corner-picker-canvas" class="max-w-full max-h-[60vh]"></canvas>
      <svg id="corner-picker-svg" class="absolute inset-0 w-full h-full" style="pointer-events: none;"></svg>
    </div>
    <div class="mt-4 flex items-center justify-between">
      <div class="text-sm text-gray-400 flex items-center gap-3">
        Drag the corners to match the grid boundaries
        <select id="corner-picker-method" class="bg-gray-700 text-white rounded px-2 py-1 text-xs" title="Grid detection method">
          <option value="slide" ${currentMethod==='slide'?'selected':''}>Slide</option>
          <option value="anchor" ${currentMethod==='anchor'?'selected':''}>Anchor</option>
          <option value="contour" ${currentMethod==='contour'?'selected':''}>Contour</option>
        </select>
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

  // Method selector in corner picker — updates the sheet's method
  var methodSel = document.getElementById('corner-picker-method');
  if (methodSel) {
    methodSel.addEventListener('change', function() {
      var active = sheetsState.activeCornerPicker;
      if (active) {
        var s = sheetsState['player' + active.player][active.sheet];
        if (s) s.method = methodSel.value;
      }
    });
  }
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
    // Existing corners are in original image coordinates — scale to canvas
    if (corners) {
      cornerPickerState.corners = {
        topLeft: { x: corners.topLeft.x * scale, y: corners.topLeft.y * scale },
        topRight: { x: corners.topRight.x * scale, y: corners.topRight.y * scale },
        bottomRight: { x: corners.bottomRight.x * scale, y: corners.bottomRight.y * scale },
        bottomLeft: { x: corners.bottomLeft.x * scale, y: corners.bottomLeft.y * scale }
      };
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
    // Scale corners from canvas coordinates back to original image coordinates
    var scale = cornerPickerState.imageScale || 1;
    var keys = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
    var scaledCorners = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      scaledCorners[k] = {
        x: Math.round(cornerPickerState.corners[k].x / scale),
        y: Math.round(cornerPickerState.corners[k].y / scale)
      };
    }
    sheet.corners = scaledCorners;
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

    // Pass GridUnsplit-derived per-half anchor positions through, when set
    if (sheet.predefinedAnchorXs && sheet.predefinedAnchorXs.length > 0) {
      gridConfig.predefinedAnchorXs = sheet.predefinedAnchorXs;
      gridConfig.inferredLeftColumn = sheet.inferredLeftColumn;
    }

    // Use client-side pipeline if available, WITH corners for perspective correction
    if (window.zugwise && window.zugwise.isReady) {
      // Convert dataURL to File for processScoresheet
      var blob = await fetch(sheet.image).then(function(r) { return r.blob(); });
      var file = new File([blob], 'sheet.png', { type: blob.type });

      // Scale corners to original image size if they were set in picker coordinates
      var corners = sheet.corners || null;

      var sheetId = player;  // Use player number as sheet ID for dual logit storage
      var sheetMethod = sheet.method || 'slide';
      // For manual corners with anchor method, use manual-anchor variant
      var ocrMethod = (sheetMethod === 'anchor' && corners) ? 'manual-anchor' : sheetMethod;
      var result = await window.zugwise.processScoresheet(file, function(msg) {
        sheet.ocrProgress = msg;
        updateProcessButton();
      }, gridConfig, corners, sheetId, ocrMethod);

      sheet.ocrResult = { moves: result.moves || [] };
      sheet.moveCount = result.moves ? result.moves.length : 0;
      sheet.status = SHEET_STATUS.OCR_DONE;

      // Show grid overlay in debug panel
      if (result.gridOverlayUrl && window.logImage) {
        window.logImage(result.gridOverlayUrl, 'Grid overlay — P' + player + ' Page ' + (sheetIndex + 1) + ' (' + ocrMethod + ')');
      }

      log('✓ OCR done: ' + sheet.moveCount + ' moves for Player ' + player + ' Page ' + (sheetIndex + 1));
    } else {
      // Fallback to backend OCR
      var ocrResult = await runOCR(sheet.image);
      sheet.ocrResult = ocrResult;
      sheet.moveCount = ocrResult.moves ? ocrResult.moves.length : 0;
      sheet.status = SHEET_STATUS.OCR_DONE;

      // Show grid overlay in debug panel
      if (ocrResult.gridOverlayUrl && window.logImage) {
        window.logImage(ocrResult.gridOverlayUrl, 'Grid overlay — P' + player + ' Page ' + (sheetIndex + 1));
      }

      log('✓ OCR done: ' + sheet.moveCount + ' moves for Player ' + player + ' Page ' + (sheetIndex + 1));
    }
  } catch (err) {
    sheet.status = SHEET_STATUS.ERROR;
    var methodHint = (sheet.method !== 'contour') ? ' — try switching to Contour method' : '';
    log('✗ OCR error: ' + err.message + methodHint);
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

  // Detect whether files changed since last process
  var fingerprint = '';
  for (var fp = 1; fp <= 2; fp++) {
    for (var fs = 0; fs < 3; fs++) {
      var fsheet = sheetsState['player' + fp][fs];
      if (fsheet && fsheet.file) {
        fingerprint += fsheet.file.name + ':' + fsheet.file.size + ':' + fsheet.file.lastModified + ';';
      }
    }
  }
  var filesChanged = (fingerprint !== sheetsState._lastProcessedFingerprint);
  sheetsState._lastProcessedFingerprint = fingerprint;

  if (filesChanged) {
    // New files uploaded — cancel running searches and fully reset
    if (window.searchManager && window.searchManager.isRunning) {
      cancelSearch();
      log('⏹ Cancelled previous searches');
    }
  }
  // Board, move list, and algorithm output are reset by showOcrResults() below

  var allMoves = [];

  // Collect moves in order: P1-1, P1-2, P1-3, P2-1, P2-2, P2-3
  // But actually we want: White sheets first, then Black sheets
  // Or: interleaved by move number if we have both players
  
  // Concatenate by player order, renumbering page 2+ moves to avoid collisions
  for (var p = 1; p <= 2; p++) {
    var playerMoves = [];
    var moveNumOffset = 0;
    for (var s = 0; s < 3; s++) {
      var sheet = sheetsState['player' + p][s];
      if (sheet && sheet.ocrResult && sheet.ocrResult.moves && sheet.ocrResult.moves.length > 0) {
        var sheetMoves = sheet.ocrResult.moves;
        if (moveNumOffset > 0) {
          // Renumber moves for page 2+ so they don't collide with page 1
          log('📄 Page ' + (s + 1) + ': renumbering moves +' + moveNumOffset + ' (moves ' + sheetMoves[0].num + '-' + sheetMoves[sheetMoves.length - 1].num + ' → ' + (sheetMoves[0].num + moveNumOffset) + '-' + (sheetMoves[sheetMoves.length - 1].num + moveNumOffset) + ')');
          sheetMoves = sheetMoves.map(function(m) {
            var copy = Object.assign({}, m);
            copy.num = m.num + moveNumOffset;
            return copy;
          });
        }
        playerMoves = playerMoves.concat(sheetMoves);
        // Calculate offset for next page: max move number from this sheet's format
        var sheetCols = (sheet.format === '3col') ? 3 : 2;
        moveNumOffset += sheet.rowCount * sheetCols;
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
    // Fresh OCR for a new game — un-dismiss the informational noise notice so
    // it shows for this game (if any noise exists). Also reset the NW
    // alignment iteration cursor so the cascade starts from the beginning.
    state.noiseBannerDismissed = false;
    state.nwSearchFrom = 0;
    state.alignmentAutoSurfaceMode = true;
    state.dismissedNWKeys = {};
    state.postponedNWKeys = {};
    if (window.SheetAlignment) window.SheetAlignment.clearAllStructuralBanners();

    // Store per-sheet OCR cells BEFORE merging so the structural pipeline
    // (run from inside mergePlayerMoves) can see them via state.
    var whiteData = allMoves[0].color === 'white' ? allMoves[0] : allMoves[1];
    var blackData = allMoves[0].color === 'black' ? allMoves[0] : allMoves[1];
    state.ocrCellsSheet1 = whiteData.moves;
    state.ocrCellsSheet2 = blackData.moves;

    var merged = mergePlayerMoves(allMoves[0], allMoves[1]);
    log('✓ Merged moves from both players: ' + merged.length + ' total');
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
    // Skip validateAndDisplay when this batch game is about to auto-enter
    // verification mode (selectGame will fire enterVerificationMode
    // immediately after processAllSheets returns). validateAndDisplay
    // would fire an async fetchFixes against the PRE-Greedy OCR (which
    // finds a stuck point somewhere early, like 6.W), renderQuickFixes
    // resolves seconds later AFTER verification's _focusFix has already
    // rendered its own quick-fixes for the user's resumed fix (say
    // 19.W), and the stale pre-verify render stomps the fresh one.
    // Skip = no stale fetchFixes = no stomp.
    if (!state.pendingNoiseReview && !_willAutoVerify()) {
      await validateAndDisplay(paired, 'Dual scoresheets');
      if (filesChanged) launchBackgroundSearches();
    }
  } else {
    // Single player
    var moves = allMoves[0].moves;
    state.ocrCells = moves;
    state.ocrCellsSheet1 = null;
    state.ocrCellsSheet2 = null;
    // Drop the dual-sheet tier-summary banner if it survived from a prior
    // dual-sheet pass — single-sheet has no merge tiers to display.
    var leftoverTierBanner = document.getElementById('tier-summary-banner');
    if (leftoverTierBanner) leftoverTierBanner.remove();
    state.noiseBannerDismissed = true;  // single-sheet has no per-sheet noise to flag
    if (window.SheetAlignment) window.SheetAlignment.clearAllStructuralBanners();
    state.hasGridImage = moves.some(function(m) { return m.imageDataUrl; });
    state.inputMode = 'image';
    log('✓ Single player moves: ' + moves.length + ' total');
    var paired = pairMoves(moves);
    showOcrResults(paired, 'Single scoresheet');
    if (!state.pendingNoiseReview && !_willAutoVerify()) {
      await validateAndDisplay(paired, 'Single scoresheet');
      if (filesChanged) launchBackgroundSearches();
    }
  }
}

// Returns true if the currently-loading batch game will auto-enter
// verification mode right after processAllSheets finishes. Prevents the
// pre-verify validateAndDisplay → fetchFixes race with verification's
// own quick-fix render.
function _willAutoVerify() {
  if (!window.BatchGameList || !window.BatchGameList.batchState) return false;
  var bs = window.BatchGameList.batchState;
  if (!bs.active || !bs.currentGameId) return false;
  if (!window.VerificationUI) return false;
  var game = bs.games.get(bs.currentGameId);
  if (!game || !game.reconstructPicked) return false;
  var res = game.reconstructPicked.result;
  return !!(res && (res.status === 'SOLVED' || res.status === 'VALID'));
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

  // Forced-stop ambiguity plies: cells the merge flagged (_ambiguous) because
  // two confident sheets disagree on the move (near-tie). validate_moves and
  // the search algorithms stop at these so the user resolves them instead of
  // the higher-confidence reading being silently played through (the 12.B
  // Rb8/Qb8 corruption). Stored as a ply-set + a _pending copy so the
  // validateAndDisplay reset can re-apply it (mirrors mergeLockedPlies). This
  // is the single source of truth the ocrData builders read to stamp
  // forced_stop — no per-cell field threaded through pairMoves/state.moves.
  var ambiguousPlies = [];
  merged.forEach(function(m) {
    if (m && m._ambiguous) {
      ambiguousPlies.push((m.num - 1) * 2 + (m.color === 'w' ? 0 : 1));
    }
  });
  state.ambiguousPlies = ambiguousPlies;
  if (ambiguousPlies.length > 0) {
    state._pendingAmbiguousPlies = ambiguousPlies.slice();
    log('🔍 ' + ambiguousPlies.length + ' ambiguous ply(ies) flagged for forced review');
  }

  // Log tier summary
  var tSummary = window.MergeSheets.tierSummary(tierMap);
  log('📊 Tiers: ' + tSummary.summary);

  // Show agreement summary banner (matches dot colors)
  var aSummary = window.MergeSheets.agreementSummary(merged);
  showTierSummaryBanner(aSummary, lockMode);

  // Structural pipeline: noise gate first, alignment only after noise resolved.
  // Re-runs automatically on every merge (including after reMergeAndRevalidate).
  if (window.SheetAlignment) {
    window.SheetAlignment.runStructuralChecks();
  }

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
    btn.textContent = 'Process Sheets →';
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

  // Tooltips explain the dot-color → tier mapping and what each lock mode
  // actually freezes. &#10; renders as a line break inside the title attr
  // across all major browsers, so we can give a real explanation without
  // resorting to a custom popover.
  var tipAgree = 'Both sheets wrote the same move.&#10;If the move is also legal, it&apos;s classified as Tier 1.';
  var tipOneSheet = 'Only one sheet has data for this ply (the other was blank or unread).&#10;Classified as Tier 2 when the move is legal.';
  var tipDisagree = 'Both sheets have data but the moves differ.&#10;Tier 2 if exactly one of the two is legal, Tier 3 otherwise.';
  var tipLockHeader =
    'Locked plies are frozen: the fix-finder, Greedy, Beam, and Dijkstra&#10;' +
    'will not propose changes to them, and the user can&apos;t accidentally&#10;' +
    'overwrite them via auto-fix. Higher tiers = more confident agreement&#10;' +
    'between the two scoresheets.';
  var tipLockOff =
    'No plies locked.&#10;' +
    'Every move is fair game for the fix-finder and the search algorithms,&#10;' +
    'including ones both sheets agreed on. Use this if you suspect the&#10;' +
    'agreement itself is wrong (e.g. both sheets copied the same misread).';
  var tipLockT1 =
    'Lock Tier 1 only.&#10;' +
    'Tier 1 = both sheets wrote the same move AND it&apos;s legal from the&#10;' +
    'preceding position. These are treated as ground truth — the fix-finder&#10;' +
    'works around them. One-sheet plies and disagreements stay editable.';
  var tipLockT12 =
    'Lock Tier 1 + Tier 2.&#10;' +
    'Adds the plies where only one sheet has data, or the sheets disagree&#10;' +
    'but one of the two options is legal. The fix-finder is then restricted&#10;' +
    'to plies where neither candidate plays out legally (Tier 3 / red).&#10;' +
    'Most aggressive setting — use when you trust the OCR pass.';

  banner.innerHTML =
    '<span class="text-gray-500">|</span>' +
    '<span class="text-green-400 cursor-help" title="' + tipAgree + '">' +
      '<span class="inline-block w-2 h-2 rounded-full bg-green-400 mr-0.5"></span>' + agreeSummary.agree + '</span>' +
    (agreeSummary.oneSheet > 0 ?
      '<span class="text-yellow-400 cursor-help" title="' + tipOneSheet + '">' +
        '<span class="inline-block w-2 h-2 rounded-full bg-yellow-400 mr-0.5"></span>' + agreeSummary.oneSheet + '</span>'
      : '') +
    (agreeSummary.disagree > 0 ?
      '<span class="text-red-400 cursor-help" title="' + tipDisagree + '">' +
        '<span class="inline-block w-2 h-2 rounded-full bg-red-400 mr-0.5"></span>' + agreeSummary.disagree + '</span>'
      : '') +
    '<span class="text-gray-500">|</span>' +
    '<span class="cursor-help text-gray-400" title="' + tipLockHeader + '">Lock:</span>' +
    '<label class="flex items-center gap-0.5 cursor-pointer" title="' + tipLockOff + '">' +
      '<input type="radio" name="lock-mode" value="none" ' + (lockMode === 'none' ? 'checked' : '') + ' class="lock-mode-radio"> <span class="text-gray-400">Off</span>' +
    '</label>' +
    '<label class="flex items-center gap-0.5 cursor-pointer" title="' + tipLockT1 + '">' +
      '<input type="radio" name="lock-mode" value="tier1" ' + (lockMode === 'tier1' ? 'checked' : '') + ' class="lock-mode-radio"> <span class="text-gray-400">T1</span>' +
    '</label>' +
    '<label class="flex items-center gap-0.5 cursor-pointer" title="' + tipLockT12 + '">' +
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
