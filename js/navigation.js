// =============================================================================
// NAVIGATION - Moving through the game
// =============================================================================

function goToPly(ply, options){
  options = options || {};
  ply=Math.max(0,Math.min(ply,state.sans.length));
  state.currentPly=ply;

  clearBoardSelection();

  // Clear arrows unless preserveErrorArrow is set (for stuck position display)
  if(!options.preserveErrorArrow){
    state.errorArrow=null;
  }
  state.fixArrow=null;
  state.ocrArrow=null;
  state.previewPly=null;  // Clear preview mode when navigating

  if(chess){
    chess.reset();
    var lastMove=null;
    for(var i=0;i<ply;i++){
      try{
        lastMove=chess.move(state.sans[i]);
      }catch(e){
        break;
      }
    }
    state.board=fenToBoard(chess.fen());
    highlightSquares(lastMove?[lastMove.from,lastMove.to]:[]);
  }

  renderBoard();
  updatePositionInfo();
  highlightCurrentMove();
  scrollCurrentMoveIntoView();
  // When at stuck position, show the stuck move (not the last valid move)
  if(state.stuckPly !== null && ply === state.sans.length){
    updateOcrContextPanel(state.stuckPly + 1);
  } else {
    updateOcrContextPanel();
  }
}

function showPositionAtPly(ply){
  // Temporarily show board at this ply without changing state.currentPly
  // Used for previewing fix positions
  if(!chess)return;

  clearBoardSelection();

  chess.reset();
  var lastMove=null;
  for(var i=0;i<ply;i++){
    try{
      lastMove=chess.move(state.sans[i]);
    }catch(e){
      break;
    }
  }
  state.board=fenToBoard(chess.fen());
  highlightSquares(lastMove?[lastMove.from,lastMove.to]:[]);
  renderBoard();

  // Update position info to show we're viewing a preview
  // Use "At N.W" / "At N.B" format to match fix suggestion labels (e.g. "18.W")
  var moveNum=Math.floor(ply/2)+1;
  var color=ply%2===0?'.W':'.B';
  var info=ply===0?'Start position':'At '+moveNum+color;
  document.getElementById('position-info').innerHTML=info+' <span class="text-blue-400">(fix preview)</span>';

  state.previewPly=ply;
}

function scrollCurrentMoveIntoView(){
  var container=document.getElementById('move-list-container');
  var rows=document.querySelectorAll('#move-tbody tr');
  var idx=state.currentPly>0?Math.floor((state.currentPly-1)/2):0;
  if(rows[idx]&&container){
    var row=rows[idx];
    var containerRect=container.getBoundingClientRect();
    var rowRect=row.getBoundingClientRect();
    if(rowRect.top<containerRect.top||rowRect.bottom>containerRect.bottom){
      row.scrollIntoView({block:'center',behavior:'smooth'});
    }
  }
}

function updatePositionInfo(){
  // "After N.W" / "After N.B" format — consistent with fix preview's "At N.W"
  var navNum=Math.floor((state.currentPly-1)/2)+1;
  var navColor=((state.currentPly-1)%2===0)?'.W':'.B';
  var info=state.currentPly===0?'Start position':'After '+navNum+navColor;
  if(chess&&chess.in_checkmate())info='# Checkmate!';
  else if(chess&&chess.in_check())info+=' +';
  document.getElementById('position-info').textContent=info;
}

function highlightCurrentMove(){
  document.querySelectorAll('#move-tbody td').forEach(function(td){
    td.classList.remove('move-current');
  });

  // If we're at the stuck position, highlight the stuck move instead of the last valid move
  if(state.stuckInfo && state.currentPly === state.sans.length){
    var idx = state.stuckInfo.num - 1; // move number to array index
    var isBlack = state.stuckInfo.color === 'b';
    var rows = document.querySelectorAll('#move-tbody tr');
    if(rows[idx]){
      var tds = rows[idx].querySelectorAll('td');
      if(tds[isBlack ? 2 : 1]) tds[isBlack ? 2 : 1].classList.add('move-current');
    }
    return;
  }

  if(state.currentPly>0){
    var idx=Math.floor((state.currentPly-1)/2);
    var isBlack=(state.currentPly-1)%2===1;
    var rows=document.querySelectorAll('#move-tbody tr');
    if(rows[idx]){
      var tds=rows[idx].querySelectorAll('td');
      if(tds[isBlack?2:1])tds[isBlack?2:1].classList.add('move-current');
    }
  }
}

async function updateOcrContextPanel(overridePly){
  // overridePly: optional - if provided, show this ply instead of currentPly
  // This allows fix suggestions and navigation to show the correct position
  var panel=document.getElementById('ocr-context-panel');
  var content=document.getElementById('ocr-context-content');
  if(!panel||!content)return;

  // Hide for PGN input (no OCR data)
  if(state.inputMode==='pgn'||(!state.hasGridImage&&(!state.ocrCells||state.ocrCells.length===0))){
    panel.classList.add('hidden');
    return;
  }

  // Determine which move to highlight - use override if provided, else currentPly
  var highlightMoveNum, highlightColor;
  var displayPly = (typeof overridePly === 'number') ? overridePly : state.currentPly;

  if(displayPly > 0){
    // Show the move AT this ply (ply 1 = move 1 white, ply 2 = move 1 black, etc.)
    highlightMoveNum = Math.floor((displayPly - 1) / 2) + 1;
    highlightColor = (displayPly - 1) % 2 === 0 ? 'w' : 'b';
  } else {
    // At start position, show first moves
    highlightMoveNum = 1;
    highlightColor = 'w';
  }

  // If we have a grid image and Flask backend is available, fetch the cropped context
  // In Pyodide mode, skip Flask and fall through to text-based display using ocrCells
  if(state.hasGridImage && typeof CONFIG !== 'undefined' && CONFIG.usePyodide === false){
    try{
      var resp=await fetch(CONFIG.apiUrl+'/api/ocr-context',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({move_num:highlightMoveNum,color:highlightColor})
      });
      if(resp.ok){
        var data=await resp.json();
        if(data.image){
          // Add move numbers alongside the image using CSS grid for alignment
          var startRow = data.start_row || Math.max(1, highlightMoveNum - 1);
          var endRow = data.end_row || (startRow + 2);
          var rowCount = endRow - startRow + 1;

          // Build move number labels - each centered vertically in its grid cell
          var labels = '';
          for(var r = startRow; r <= endRow; r++){
            var isCurrent = (r === highlightMoveNum);
            labels += '<div class="flex items-center justify-end pr-1 ' + (isCurrent ? 'text-yellow-300 font-bold' : 'text-gray-500') + '">' + r + '.</div>';
          }

          // Use grid layout: numbers column + image column
          // The grid rows divide equally to match image rows
          var numHtml = '<div style="display:grid;grid-template-columns:auto 1fr;gap:4px">';
          numHtml += '<div class="text-xs" style="display:grid;grid-template-rows:repeat(' + rowCount + ',1fr)">' + labels + '</div>';
          numHtml += '<img src="data:image/jpeg;base64,' + data.image + '" class="rounded border border-gray-600 w-full" alt="OCR context">';
          numHtml += '</div>';
          content.innerHTML = numHtml;
          panel.classList.remove('hidden');
          return;
        }
      }
    }catch(e){
      log('⚠ OCR context fetch error: '+e.message);
    }
  }

  // Dual-sheet mode: show both sheets' OCR context side by side
  var isDualSheet = state.ocrCellsSheet1 && state.ocrCellsSheet1.length > 0 &&
                    state.ocrCellsSheet2 && state.ocrCellsSheet2.length > 0;

  if(isDualSheet){
    // Side-by-side with flex-wrap: wraps to stacked on narrow screens
    var html = '<div style="display:flex;gap:6px;flex-wrap:wrap">';
    html += _buildOcrContextGrid(state.ocrCellsSheet1, highlightMoveNum, highlightColor, 'white');
    html += _buildOcrContextGrid(state.ocrCellsSheet2, highlightMoveNum, highlightColor, 'black');
    html += '</div>';
    content.innerHTML = html;
    panel.classList.remove('hidden');
  } else if(state.ocrCells&&state.ocrCells.length>0){
    // Single-sheet mode: show one panel (existing behavior)
    content.innerHTML = _buildOcrContextGrid(state.ocrCells, highlightMoveNum, highlightColor, null);
    panel.classList.remove('hidden');
  }else{
    panel.classList.add('hidden');
  }
}

// Helper: build one OCR context grid for a set of cells
function _buildOcrContextGrid(cells, highlightMoveNum, highlightColor, label){
    // Find max row in OCR data to avoid showing empty rows beyond the scoresheet
    var maxRow=0;
    cells.forEach(function(c){if(c.num>maxRow)maxRow=c.num;});
    // Detect column boundary: with rowsPerColumn, don't show rows from a different column
    var rpc = state.rowsPerColumn || 0;
    // Find which column the highlighted move is in (0-indexed)
    var highlightCol = rpc > 0 ? Math.floor((highlightMoveNum - 1) / rpc) : 0;
    // Column boundaries: first and last move number in this column
    var colStart = rpc > 0 ? highlightCol * rpc + 1 : 1;
    var colEnd = rpc > 0 ? (highlightCol + 1) * rpc : maxRow;
    // Clamp colEnd to actual data
    colEnd = Math.min(colEnd, maxRow);

    var startRow=Math.max(colStart,highlightMoveNum-1);
    var endRow=startRow+2;
    // Clamp to column boundary and actual data range
    if(endRow>colEnd){
      endRow=colEnd;
      startRow=Math.max(colStart,endRow-2);
    }

    // Check if stuck position is in view
    var stuckMoveNum = state.stuckInfo ? state.stuckInfo.num : null;
    var stuckColor = state.stuckInfo ? state.stuckInfo.color : null;

    // Check if we should show g-tail area below the last row
    var showGTail = (endRow === colEnd);
    var wLastCell = showGTail ? cells.find(function(c){return c.num===endRow&&c.color==='w';}) : null;
    var bLastCell = showGTail ? cells.find(function(c){return c.num===endRow&&c.color==='b';}) : null;
    var hasGTailImages = (wLastCell && wLastCell.cellBelowImageUrl) || (bLastCell && bLastCell.cellBelowImageUrl);
    var hasLastCellImages = showGTail && !hasGTailImages && ((wLastCell && wLastCell.imageDataUrl) || (bLastCell && bLastCell.imageDataUrl));
    var showGTailRow = hasGTailImages || hasLastCellImages;

    var rowCount = endRow - startRow + 1 + (showGTailRow ? 1 : 0);

    // Wrapper: color-coded left border in dual mode (white=light, black=dark)
    // min-width:140px ensures wrapping to stacked on narrow screens
    var borderStyle = '';
    if(label === 'white') borderStyle = 'border-left:3px solid #e5e7eb;padding-left:4px;';
    else if(label === 'black') borderStyle = 'border-left:3px solid #4b5563;padding-left:4px;';
    var html='<div style="flex:1;min-width:140px;'+borderStyle+'">';

    // Two-container layout: move numbers outside, image grid inside
    html+='<div style="display:flex;align-items:stretch;gap:4px">';

    // Move numbers column
    html+='<div style="display:flex;flex-direction:column;justify-content:space-around;flex-shrink:0">';
    for(var row=startRow;row<=endRow;row++){
      var numClass = (row === highlightMoveNum) ? 'text-yellow-300 font-bold' : 'text-gray-500';
      html+='<div class="text-xs '+numClass+'" style="text-align:right;padding-right:4px">'+row+'.</div>';
    }
    html+='</div>';

    // Image grid - NO gaps, looks like one continuous scoresheet crop
    html+='<div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:repeat('+rowCount+',auto);gap:0;line-height:0;overflow:hidden;border-radius:4px">';
    for(var row=startRow;row<=endRow;row++){
      var wCell=cells.find(function(c){return c.num===row&&c.color==='w';});
      var bCell=cells.find(function(c){return c.num===row&&c.color==='b';});
      var isCurrentW = (row === highlightMoveNum && highlightColor === 'w');
      var isCurrentB = (row === highlightMoveNum && highlightColor === 'b');
      var isStuckW = (row===stuckMoveNum && stuckColor==='w');
      var isStuckB = (row===stuckMoveNum && stuckColor==='b');

      // White cell - outline with negative offset draws INSIDE the cell
      var wOutline = isCurrentW ? 'outline:2px solid #facc15;outline-offset:-1px;position:relative;z-index:1;' :
                     (isStuckW  ? 'outline:2px solid #f87171;outline-offset:-1px;position:relative;z-index:1;' : '');
      html+='<div style="line-height:0;'+wOutline+'">';
      if(wCell && wCell.imageDataUrl){
        html+='<img src="'+wCell.imageDataUrl+'" style="width:100%;display:block;margin-top:-2px;margin-bottom:-2px" alt="'+(wCell.move||'')+'">';
      }else if(wCell){
        html+='<div style="height:32px;background:#d4c8a8;line-height:32px" class="px-1 text-xs text-gray-600">'+wCell.move+'</div>';
      }else{
        html+='<div style="height:32px;background:#d4c8a8"></div>';
      }
      html+='</div>';

      // Black cell
      var bOutline = isCurrentB ? 'outline:2px solid #facc15;outline-offset:-1px;position:relative;z-index:1;' :
                     (isStuckB  ? 'outline:2px solid #f87171;outline-offset:-1px;position:relative;z-index:1;' : '');
      html+='<div style="line-height:0;'+bOutline+'">';
      if(bCell && bCell.imageDataUrl){
        html+='<img src="'+bCell.imageDataUrl+'" style="width:100%;display:block;margin-top:-2px;margin-bottom:-2px" alt="'+(bCell.move||'')+'">';
      }else if(bCell){
        html+='<div style="height:32px;background:#d4c8a8;line-height:32px" class="px-1 text-xs text-gray-600">'+bCell.move+'</div>';
      }else{
        html+='<div style="height:32px;background:#d4c8a8"></div>';
      }
      html+='</div>';
    }
    // G-tail area row
    if(showGTailRow){
      var wGTail = wLastCell && wLastCell.cellBelowImageUrl;
      var bGTail = bLastCell && bLastCell.cellBelowImageUrl;
      var wFallback = !wGTail && wLastCell && wLastCell.imageDataUrl;
      var bFallback = !bGTail && bLastCell && bLastCell.imageDataUrl;
      html+='<div style="line-height:0;opacity:0.6">';
      if(wGTail){
        html+='<img src="'+wGTail+'" style="width:100%;display:block;margin-top:-2px;margin-bottom:-2px;max-height:20px;object-fit:cover;object-position:top" alt="g-tail area">';
      }else if(wFallback){
        html+='<div style="height:0;overflow:hidden;position:relative;line-height:0"><img src="'+wLastCell.imageDataUrl+'" style="width:100%;display:block;position:absolute;bottom:0" onload="this.parentNode.style.height=Math.round(15*this.clientWidth/this.naturalWidth)+\'px\'" alt="g-tail area"></div>';
      }else{
        html+='<div style="height:20px;background:#d4c8a8"></div>';
      }
      html+='</div>';
      html+='<div style="line-height:0;opacity:0.6">';
      if(bGTail){
        html+='<img src="'+bGTail+'" style="width:100%;display:block;margin-top:-2px;margin-bottom:-2px;max-height:20px;object-fit:cover;object-position:top" alt="g-tail area">';
      }else if(bFallback){
        html+='<div style="height:0;overflow:hidden;position:relative;line-height:0"><img src="'+bLastCell.imageDataUrl+'" style="width:100%;display:block;position:absolute;bottom:0" onload="this.parentNode.style.height=Math.round(15*this.clientWidth/this.naturalWidth)+\'px\'" alt="g-tail area"></div>';
      }else{
        html+='<div style="height:20px;background:#d4c8a8"></div>';
      }
      html+='</div>';
    }
    html+='</div></div></div>';
    return html;
}
