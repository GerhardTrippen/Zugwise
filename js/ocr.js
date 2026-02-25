// =============================================================================
// OCR - File handling, image processing, OCR parsing
// =============================================================================
// Pure client-side OCR using OpenCV.js + ONNX Runtime Web + Pyodide.
// NO FLASK FALLBACK - "Free. Private. Offline. Forever."

async function handleFiles(files){
  log('📁 Processing '+files.length+' file(s)...');
  showProcessing(true,'Processing OCR... (0/'+files.length+')');
  var allMoves=[];
  state.ocrCells=[];  // Reset OCR cells
  state.ocrCellsSheet1=null;  // Clear dual-sheet data
  state.ocrCellsSheet2=null;
  state.mergeTierMap=null;
  state.hasGridImage=false;
  state.inputMode='image';
  // Store original files for re-OCR with manual corners
  state.ocrOriginalFiles = Array.from(files);

  // Verify client-side components are ready
  if (!window.OpenCVImageProcessor) {
    log('⚠ OpenCV.js not loaded. Please wait for initialization.');
    showProcessing(false);
    return;
  }
  if (!window.zugwise || !window.zugwise.isReady) {
    log('⚠ OCR engine not ready. Please wait for initialization.');
    showProcessing(false);
    return;
  }

  for(var i=0;i<files.length;i++){
    showProcessing(true,'Processing OCR... ('+(i+1)+'/'+files.length+')');
    try {
      // Pure client-side processing with OpenCV.js + ONNX
      var result = await processImageClientSide(files[i], function(msg) {
        showProcessing(true, msg);
      });
      allMoves=allMoves.concat(result.moves);
      state.ocrCells=state.ocrCells.concat(result.moves);
      if(result.hasGridImage || result.has_grid_image) state.hasGridImage=true;
      if(result.rowsPerColumn) state.rowsPerColumn=result.rowsPerColumn;
      log('✓ '+files[i].name+': '+result.moves.length+' cells (client-side)');
      // Display OCR validation warnings
      if(result.warnings && result.warnings.length > 0){
        result.warnings.forEach(function(w){ log(w); });
      }
    } catch(e) {
      log('⚠ '+files[i].name+': '+e.message);
    }
  }
  showProcessing(false);
  if(allMoves.length===0){document.getElementById('move-status').innerHTML='<span class="text-red-400">❌ No moves detected</span>';return;}
  log('📊 OCR returned '+allMoves.length+' cells');
  var paired=pairMoves(allMoves);
  log('📊 Paired into '+paired.length+' move pairs');

  // Show OCR results immediately (before validation)
  var filename = files.map(function(f){return f.name;}).join(', ');
  showOcrResults(paired, filename);

  // If there's suspicious noise, showOcrResults will pause for user review
  // Otherwise, validate now
  if(!state.pendingNoiseReview){
    await validateAndDisplay(paired, filename);
    // Launch background search workers after validation (if stuck)
    launchBackgroundSearches(paired);
  }
  // If pendingNoiseReview is true, validation will be triggered by "Continue" button
}

async function handleReOCR() {
  if (!state.ocrOriginalFiles || state.ocrOriginalFiles.length === 0) {
    log('No original image available for re-OCR');
    return;
  }
  if (!window.showCornerPickerGeneric || !window.readFileAsDataURL) {
    log('Corner picker not available');
    return;
  }

  // Use the first file for corner picking
  var file = state.ocrOriginalFiles[0];
  var imageDataURL = await window.readFileAsDataURL(file);

  log('🎯 Showing corner picker for re-OCR...');
  window.showCornerPickerGeneric(imageDataURL, null, async function(corners) {
    log('🎯 Re-processing with manual corners...');
    showProcessing(true, 'Re-OCR with manual corners...');
    try {
      var gridConfig = (window.SheetProfiles && window.SheetProfiles.getProfileGridConfig)
          ? window.SheetProfiles.getProfileGridConfig(1)
          : null;

      var allMoves = [];
      state.ocrCells = [];
      for (var i = 0; i < state.ocrOriginalFiles.length; i++) {
        var f = state.ocrOriginalFiles[i];
        var result = await window.zugwise.processScoresheet(f, function(msg) {
          showProcessing(true, msg);
        }, gridConfig, corners);
        if (result.moves) {
          allMoves = allMoves.concat(result.moves);
          state.ocrCells = state.ocrCells.concat(result.moves);
          if(result.rowsPerColumn) state.rowsPerColumn=result.rowsPerColumn;
        }
      }
      showProcessing(false);
      if (allMoves.length === 0) {
        log('❌ Re-OCR produced no moves');
        return;
      }
      log('✓ Re-OCR: ' + allMoves.length + ' cells');
      var paired = pairMoves(allMoves);
      var filename = state.ocrOriginalFiles.map(function(f){return f.name;}).join(', ');
      showOcrResults(paired, filename);
      if (!state.pendingNoiseReview) {
        await validateAndDisplay(paired, filename);
      }
    } catch (err) {
      showProcessing(false);
      log('❌ Re-OCR error: ' + err.message);
    }
  });
}

function showOcrResults(paired, filename){
  // Reset state for new game
  state.moves = [];
  state.sans = [];
  state.stuckPly = null;
  state.stuckInfo = null;
  state.confirmedPly = 0;
  state.fixedPlies = [];
  state.approvedPlies = [];
  // Preserve merge-locked plies if set (dual-sheet mode)
  if (state._pendingMergeLockedPlies && state._pendingMergeLockedPlies.length > 0) {
    state.lockedPlies = state._pendingMergeLockedPlies.slice();
  } else {
    state.lockedPlies = [];
  }
  state.pendingNoiseReview = false;
  state.noiseCleanupDone = false;  // Reset so detection runs on new game

  // Create preliminary move list showing OCR results (all pending)
  paired.forEach(function(m){
    state.moves.push({
      num: m.num,
      white: m.white || '',
      black: m.black || '',
      wStatus: m.white ? 'pending' : 'pending',
      bStatus: m.black ? 'pending' : 'pending',
      wConf: m.wConf || 0.9,
      bConf: m.bConf || 0.9,
      wAlts: m.wAlts || [],
      bAlts: m.bAlts || []
    });
    if(m.white) state.sans.push(m.white);
    if(m.black) state.sans.push(m.black);
  });

  // Show preliminary state
  renderMoveList();
  toggleInputArea(true);
  document.getElementById('loaded-info').textContent = '📄 ' + filename;
  document.getElementById('source-preview').classList.add('hidden');
  // Show re-OCR button if we have stored image files
  var reocrBtn = document.getElementById('btn-reocr');
  if (reocrBtn) reocrBtn.classList.toggle('hidden', !state.ocrOriginalFiles || state.ocrOriginalFiles.length === 0);
  resetApplyButton();

  // Check for suspicious tail BEFORE validation
  var suspiciousTailStart = detectSuspiciousTail();
  if(suspiciousTailStart === null) suspiciousTailStart = detectTrailingNoise();
  if(suspiciousTailStart !== null){
    // Navigate to end so user can review/delete noise
    state.pendingNoiseReview = true;
    goToPly(state.sans.length);
    log('⚠️ Suspicious low-confidence moves detected at end - please review before validation');

    // Show noise review UI
    document.getElementById('stuck-info').innerHTML =
      '<div class="text-yellow-400">⚠️ Potential OCR noise at end</div>' +
      '<div class="text-xs text-gray-400 mt-1">Review highlighted moves and delete noise before continuing</div>';
    document.getElementById('fix-list').innerHTML =
      '<div class="p-3 bg-yellow-900/30 rounded border border-yellow-700 mb-3">' +
        '<div class="text-yellow-300 text-sm font-medium mb-2">🗑️ Low-confidence moves detected</div>' +
        '<div class="text-xs text-gray-300 mb-3">Click 🗑️ next to any move to delete it and all moves after.</div>' +
        '<button id="btn-continue-validation" class="w-full py-2 bg-green-600 hover:bg-green-500 rounded text-sm font-medium">✓ Continue to Validation</button>' +
      '</div>';

    // Add click handler for continue button
    document.getElementById('btn-continue-validation').onclick = function(){
      state.pendingNoiseReview = false;
      document.getElementById('stuck-info').innerHTML = '<span class="text-blue-300">🔍 Validating...</span>';
      document.getElementById('fix-list').innerHTML = '<div class="text-gray-400 text-sm p-4 text-center">Checking moves...</div>';
      // Trigger validation (rebuild paired from current state)
      var currentPaired = [];
      state.moves.forEach(function(m){
        currentPaired.push({
          num: m.num,
          white: m.white,
          black: m.black,
          wConf: m.wConf,
          bConf: m.bConf,
          wAlts: m.wAlts,
          bAlts: m.bAlts
        });
      });
      validateAndDisplay(currentPaired, filename).then(function(){
        launchBackgroundSearches(currentPaired);
      });
    };
  } else {
    // No suspicious tail - proceed normally
    document.getElementById('stuck-info').innerHTML = '<span class="text-blue-300">🔍 Validating...</span>';
    document.getElementById('fix-list').innerHTML = '<div class="text-gray-400 text-sm p-4 text-center">Checking moves...</div>';
    goToPly(0);  // Start at beginning
  }
}

// Client-side image processing using OpenCV.js + ONNX Runtime Web
// NO FLASK FALLBACK
async function processImageClientSide(file, onProgress) {
  if (!window.zugwise || !window.zugwise.isReady) {
    throw new Error('OCR engine not ready');
  }
  if (!window.OpenCVImageProcessor) {
    throw new Error('OpenCV.js not loaded');
  }

  // Get grid config from active profile (page 1 for single-image upload)
  var gridConfig = (window.SheetProfiles && window.SheetProfiles.getProfileGridConfig)
      ? window.SheetProfiles.getProfileGridConfig(1)
      : null;

  // Use the worker API's processScoresheet method (uses OpenCV.js internally)
  var result = await window.zugwise.processScoresheet(file, onProgress, gridConfig);

  if (result.error && result.error.indexOf('Grid detection failed') !== -1) {
    // Offer corner picker fallback for single-image uploads
    if (window.showCornerPickerGeneric && window.readFileAsDataURL) {
      var imageDataURL = await window.readFileAsDataURL(file);
      return new Promise(function(resolve, reject) {
        log('Grid detection failed - showing corner picker for manual selection');
        window.showCornerPickerGeneric(imageDataURL, null, async function(corners) {
          try {
            // Re-process with manual corners
            var retryResult = await window.zugwise.processScoresheet(file, onProgress, gridConfig, corners);
            if (retryResult.error) {
              reject(new Error(retryResult.error));
            } else {
              // Show grid overlay from manual corner detection
              if (retryResult.gridOverlayUrl && window.logImage) {
                window.logImage(retryResult.gridOverlayUrl, 'Grid detection overlay (manual corners)');
              }
              resolve({ moves: retryResult.moves || [], hasGridImage: true, warnings: retryResult.warnings || [], rowsPerColumn: retryResult.rowsPerColumn || null });
            }
          } catch (err) {
            reject(err);
          }
        });
      });
    }
    throw new Error(result.error);
  }

  if (result.error) {
    throw new Error(result.error);
  }

  // Show grid overlay in debug log if available
  if (result.gridOverlayUrl && window.logImage) {
    window.logImage(result.gridOverlayUrl, 'Grid detection overlay');
  }

  return {
    moves: result.moves || [],
    hasGridImage: result.has_grid_image || true,
    warnings: result.warnings || [],
    rowsPerColumn: result.rowsPerColumn || null
  };
}

function pairMoves(ocrMoves){var map={};ocrMoves.forEach(function(m){if(!map[m.num])map[m.num]={num:m.num,white:'',black:'',wConf:0,bConf:0,wAlts:[],bAlts:[],wLenientAlts:[],bLenientAlts:[]};if(m.color==='w'){map[m.num].white=m.move;map[m.num].wConf=m.confidence;map[m.num].wAlts=m.alternatives||[];map[m.num].wLenientAlts=m.lenientAlternatives||[];}else{map[m.num].black=m.move;map[m.num].bConf=m.confidence;map[m.num].bAlts=m.alternatives||[];map[m.num].bLenientAlts=m.lenientAlternatives||[];}});return Object.keys(map).map(Number).sort(function(a,b){return a-b;}).map(function(n){return map[n];});}

function loadOCRFromInput(){
  // Check if dual input mode is active
  var dualInput=document.getElementById('ocr-dual-input');
  var isDual=dualInput&&!dualInput.classList.contains('hidden');

  var moves=[];

  if(isDual){
    // Dual input mode - parse white and black separately
    var whiteText=(document.getElementById('ocr-input-white').value||'').trim();
    var blackText=(document.getElementById('ocr-input-black').value||'').trim();

    var whiteMoves=parseSimpleMoveList(whiteText,'w');
    var blackMoves=parseSimpleMoveList(blackText,'b');

    // Interleave moves
    var maxNum=Math.max(
      whiteMoves.length>0?whiteMoves[whiteMoves.length-1].num:0,
      blackMoves.length>0?blackMoves[blackMoves.length-1].num:0
    );

    var whiteMap={};whiteMoves.forEach(function(m){whiteMap[m.num]=m;});
    var blackMap={};blackMoves.forEach(function(m){blackMap[m.num]=m;});

    for(var n=1;n<=maxNum;n++){
      if(whiteMap[n])moves.push(whiteMap[n]);
      if(blackMap[n])moves.push(blackMap[n]);
    }

    if(moves.length===0){log('⚠ No moves found in dual input');return;}
    log('✓ Parsed '+whiteMoves.length+' white + '+blackMoves.length+' black moves');
  }else{
    // Single input mode - original behavior
    var text=document.getElementById('ocr-input').value.trim();
    if(!text){log('⚠ No OCR text entered');return;}
    log('📝 Parsing LLM OCR format...');
    var lines=text.split('\n').filter(function(l){return l.trim();});
    var mainPattern=/^(\d+)\.(W|B)\s+(\S+)\s+([\d.]+)(.*)/i;
    lines.forEach(function(line){
      var match=line.match(mainPattern);
      if(match){
        var m={num:parseInt(match[1]),color:match[2].toLowerCase(),move:match[3],confidence:parseFloat(match[4]),alternatives:[]};
        // Parse all remaining alternatives as "move confidence" pairs
        var rest=match[5].trim();
        if(rest){
          var altPattern=/(\S+)\s+([\d.]+)/g;
          var altMatch;
          while((altMatch=altPattern.exec(rest))!==null){
            m.alternatives.push({move:altMatch[1],confidence:parseFloat(altMatch[2])});
          }
        }
        moves.push(m);
      }
    });
    if(moves.length===0){log('⚠ Could not parse any moves.');return;}
    log('✓ Parsed '+moves.length+' moves from OCR text');
  }

  state.ocrCells=moves;  // Store for OCR context panel
  state.hasGridImage=false;
  state.inputMode='ocr-text';
  var paired=pairMoves(moves);
  validateAndDisplay(paired,'OCR text input');
}

// Parse simple move list format: "1. e4\n2. Nf3" or "e4\nNf3"
function parseSimpleMoveList(text,color){
  if(!text)return[];
  var moves=[];
  var lines=text.split('\n').filter(function(l){return l.trim();});
  var moveNum=1;

  lines.forEach(function(line){
    line=line.trim();
    // Try to extract move number: "1. e4" or "1... e5" or just "e4"
    var match=line.match(/^(\d+)\.+\s*(.+)/);
    var san;
    if(match){
      moveNum=parseInt(match[1]);
      san=match[2].trim();
    }else{
      san=line;
    }
    // Clean up the move (remove check symbols at end for parsing)
    san=san.split(/\s+/)[0];  // Take first word only
    if(san){
      moves.push({num:moveNum,color:color,move:san,confidence:0.9,alternatives:[]});
      moveNum++;
    }
  });
  return moves;
}

async function loadOCRWithImage() {
  // Check if dual input mode is active
  var dualInput=document.getElementById('ocr-dual-input');
  var isDual=dualInput&&!dualInput.classList.contains('hidden');

  // Validate input exists
  if(isDual){
    var whiteText=(document.getElementById('ocr-input-white').value||'').trim();
    var blackText=(document.getElementById('ocr-input-black').value||'').trim();
    if(!whiteText&&!blackText){
      log('⚠ No OCR text entered');
      return;
    }
  }else{
    var text=document.getElementById('ocr-input').value.trim();
    if(!text){
      log('⚠ No OCR text entered');
      return;
    }
  }

  // Check if image was provided - process with OpenCV.js for visualization
  var imageInput = document.getElementById('ocr-image-input');
  if (imageInput && imageInput.files && imageInput.files.length > 0 && window.OpenCVImageProcessor) {
    try {
      await window.OpenCVImageProcessor.initOpenCV();
      var result = await window.OpenCVImageProcessor.processScoresheet(imageInput.files[0]);
      state.hasGridImage = result.gridDetected || false;
      if (result.grid && result.grid.delete) result.grid.delete();
      log('✓ Image loaded for visualization (client-side)');
    } catch (e) {
      log('⚠ Could not load image: ' + e.message);
    }
  }

  // Now load the OCR text
  loadOCRFromInput();
}

function loadPGNFromInput(){
  // Check if dual input mode is active
  var dualInput=document.getElementById('pgn-dual-input');
  var isDual=dualInput&&!dualInput.classList.contains('hidden');

  var sans=[];

  if(isDual){
    // Dual input mode - parse white and black separately
    var whiteText=(document.getElementById('pgn-input-white').value||'').trim();
    var blackText=(document.getElementById('pgn-input-black').value||'').trim();

    var whiteMoves=parsePgnMoveList(whiteText);
    var blackMoves=parsePgnMoveList(blackText);

    // Interleave moves (white, black, white, black, ...)
    var maxLen=Math.max(whiteMoves.length,blackMoves.length);
    for(var i=0;i<maxLen;i++){
      if(i<whiteMoves.length)sans.push(whiteMoves[i]);
      if(i<blackMoves.length)sans.push(blackMoves[i]);
    }

    if(sans.length===0){log('⚠ No moves found in dual PGN input');return;}
    log('✓ Parsed '+whiteMoves.length+' white + '+blackMoves.length+' black moves');
  }else{
    // Single input mode - original behavior
    var text=document.getElementById('pgn-input').value.trim();
    if(!text)return;
    var cleaned=text.replace(/\[.*?\]/g,'').replace(/\{.*?\}/g,'').replace(/\d+\./g,' ').trim();
    sans=cleaned.split(/\s+/).filter(function(m){return m&&m!=='*'&&!/^[01]-[01]$/.test(m)&&!/^1\/2/.test(m);});
  }

  state.moves=[];state.sans=[];state.ocrCells=[];state.ocrCellsSheet1=null;state.ocrCellsSheet2=null;state.mergeTierMap=null;state.hasGridImage=false;state.inputMode='pgn';
  if(chess){chess.reset();for(var i=0;i<sans.length;i++){try{chess.move(sans[i]);var num=Math.floor(i/2)+1;if(i%2===0)state.moves.push({num:num,white:sans[i],black:'',wStatus:'ok',bStatus:'ok',wConf:1,bConf:1});else state.moves[state.moves.length-1].black=sans[i];state.sans.push(sans[i]);}catch(e){log('⚠ Invalid: '+sans[i]);break;}}}
  state.stuckPly=null;state.stuckInfo=null;
  document.getElementById('stuck-info').innerHTML='<span class="text-green-400">✓ All moves valid!</span>';
  document.getElementById('fix-list').innerHTML='<div class="text-green-400 text-sm p-4 text-center">🎉 Loaded!</div>';
  document.getElementById('source-preview').classList.add('hidden');
  document.getElementById('ocr-context-panel').classList.add('hidden');
  resetApplyButton();renderMoveList();toggleInputArea(true);
  document.getElementById('loaded-info').textContent='📄 PGN input';
  log('✓ Loaded '+state.sans.length+' moves from PGN');
  goToPly(state.sans.length);
}

// Parse PGN move list (handles "1. e4" or "1... e5" or just "e4")
function parsePgnMoveList(text){
  if(!text)return[];
  // Remove PGN headers and comments
  var cleaned=text.replace(/\[.*?\]/g,'').replace(/\{.*?\}/g,'').trim();
  // Split by move numbers or whitespace
  var tokens=cleaned.split(/\d+\.+\s*|\s+/).filter(function(t){
    return t&&t!=='*'&&!/^[01]-[01]$/.test(t)&&!/^1\/2/.test(t);
  });
  return tokens;
}

async function loadPGNWithImage() {
  // Check if dual input mode is active
  var dualInput=document.getElementById('pgn-dual-input');
  var isDual=dualInput&&!dualInput.classList.contains('hidden');

  // Validate input exists
  if(isDual){
    var whiteText=(document.getElementById('pgn-input-white').value||'').trim();
    var blackText=(document.getElementById('pgn-input-black').value||'').trim();
    if(!whiteText&&!blackText){
      log('⚠ No PGN text entered');
      return;
    }
  }else{
    var text=document.getElementById('pgn-input').value.trim();
    if(!text){
      log('⚠ No PGN text entered');
      return;
    }
  }

  // Check if image was provided - process with OpenCV.js for visualization
  var imageInput = document.getElementById('pgn-image-input');
  if (imageInput && imageInput.files && imageInput.files.length > 0 && window.OpenCVImageProcessor) {
    try {
      await window.OpenCVImageProcessor.initOpenCV();
      var result = await window.OpenCVImageProcessor.processScoresheet(imageInput.files[0]);
      state.hasGridImage = result.gridDetected || false;
      if (result.grid && result.grid.delete) result.grid.delete();
      log('✓ Image loaded for visualization (client-side)');
    } catch (e) {
      log('⚠ Could not load image: ' + e.message);
    }
  }

  // Now load PGN
  loadPGNFromInput();
}

function downloadOCRText() {
  if (!state.ocrCells || state.ocrCells.length === 0) {
    log('⚠ No OCR data to download');
    return;
  }

  // Format: 1.W e4 0.99 e3 0.01
  var lines = [];
  state.ocrCells.forEach(function(cell) {
    var line = cell.num + '.' + cell.color.toUpperCase() + ' ' + cell.move + ' ' + parseFloat((cell.confidence || 0.9).toFixed(6));
    // Add alternatives if available
    if (cell.alternatives && cell.alternatives.length > 0) {
      cell.alternatives.forEach(function(alt) {
        var altMove = alt.move || alt;
        var altConf = alt.confidence || 0.1;
        line += ' ' + altMove + ' ' + parseFloat(altConf.toFixed(6));
      });
    }
    lines.push(line);
  });

  var text = lines.join('\n');
  var blob = new Blob([text], {type: 'text/plain'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ocr_moves.txt';
  a.click();
  log('📥 Downloaded OCR text (' + state.ocrCells.length + ' moves)');
}

function downloadOCRTextForSheet(sheetNum) {
  var cells = (sheetNum === 1) ? state.ocrCellsSheet1 : state.ocrCellsSheet2;
  if (!cells || cells.length === 0) {
    log('⚠ No OCR data for sheet ' + sheetNum);
    return;
  }

  var lines = [];
  cells.forEach(function(cell) {
    var line = cell.num + '.' + cell.color.toUpperCase() + ' ' + cell.move + ' ' + parseFloat((cell.confidence || 0.9).toFixed(6));
    if (cell.alternatives && cell.alternatives.length > 0) {
      cell.alternatives.forEach(function(alt) {
        var altMove = alt.move || alt;
        var altConf = alt.confidence || 0.1;
        line += ' ' + altMove + ' ' + parseFloat(altConf.toFixed(6));
      });
    }
    lines.push(line);
  });

  var text = lines.join('\n');
  var blob = new Blob([text], {type: 'text/plain'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ocr_sheet' + sheetNum + '_moves.txt';
  a.click();
  log('📥 Downloaded Sheet ' + sheetNum + ' OCR text (' + cells.length + ' moves)');
}
