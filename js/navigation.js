// =============================================================================
// NAVIGATION - Moving through the game
// =============================================================================

// chess.js 0.12.0 silently re-resolves SANs whose file/rank disambiguator
// doesn't match any piece. E.g. "Red8" with no rook on the e-file gets
// played as "Rad8" (a-rook → d8) when that's the only legal rook move to
// d8. The board ends up reflecting Rad8 even though state.moves still
// shows the user-confirmed "Red8" — a silent divergence between move list
// and board. This wrapper checks the disambiguator in the input SAN
// against the actual from-square of chess.js's resolved move; on mismatch
// it rolls the move back and returns null so the navigation loop stops at
// this ply, making the bad SAN visible instead of papering over it.
function _strictMove(chessInst, san){
  if(!san) return null;
  var move = chessInst.move(san);
  if(!move) return null;
  var clean = String(san).replace(/[+#?!]+$/, '');
  var m = clean.match(/^[NBKRQ]?([a-h])?([1-8])?x?[a-h][1-8](?:=[NBRQ])?$/);
  if(m){
    var fileDis = m[1];
    var rankDis = m[2];
    if((fileDis && move.from && move.from.charAt(0) !== fileDis) ||
       (rankDis && move.from && move.from.charAt(1) !== rankDis)){
      chessInst.undo();
      return null;
    }
  }
  return move;
}

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
        lastMove=_strictMove(chess, state.sans[i]);
        if(!lastMove) break;
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
  // options.skipScroll: callers that already know the target cell is under
  // the cursor (e.g. a user click on a move-list cell) should NOT trigger
  // auto-scroll. Otherwise the list can re-center between a double-click's
  // two clicks, causing the second click to land on an adjacent cell.
  if(!options.skipScroll) scrollCurrentMoveIntoView();
  // When at stuck position, show the stuck move (not the last valid move)
  if(state.stuckPly !== null && ply === state.sans.length){
    updateOcrContextPanel(state.stuckPly + 1);
  } else {
    updateOcrContextPanel();
  }
  // Re-evaluate alignment-banner trigger on navigation. The NW cascade
  // doesn't auto-run on navigation (it normally fires after each merge),
  // so call the same runStructuralChecks the merge path uses, gated to
  // skip the heavy work when a banner is already showing.
  if(window.SheetAlignment){
    if(typeof window.SheetAlignment.runStructuralChecks === 'function'
       && !window.SheetAlignment.hasActiveStructuralBanner()){
      window.SheetAlignment.runStructuralChecks();
    } else if(typeof window.SheetAlignment.evaluateAtPointAlignment === 'function'){
      window.SheetAlignment.evaluateAtPointAlignment();
      // Banner active: runStructuralChecks (and the dual-sheet relaunch it
      // cascades into) was skipped. An edit that changed the move list still
      // needs the searches re-run — the cached result is now stale. This is
      // reached on every post-edit revalidate (revalidate → goToPly) as well
      // as plain navigation; retryReconstructionLaunch → launchBackgroundSearches
      // self-gates so a navigation tick (unchanged inputs) is a no-op skip and
      // only a genuine edit relaunches. Without this, dual-sheet edits made
      // while an alignment banner is showing silently left stale algorithm
      // panels — the asymmetry vs single-sheet the user reported.
      if(typeof window.SheetAlignment.retryReconstructionLaunch === 'function'){
        window.SheetAlignment.retryReconstructionLaunch();
      }
    }
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
      lastMove=_strictMove(chess, state.sans[i]);
      if(!lastMove) break;
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
  if(!container) return;

  var stuckPly=state.stuckPly;
  var _scrollBefore = container.scrollTop;
  var _branch = 'none';
  var _scrollAfter = _scrollBefore;

  // Auto-center on the stuck row ONLY when stuckPly changes (first appearance
  // after validation, or a new stuck point after the user fixes the previous
  // one). On every other render/nav we leave the user's manual scroll alone —
  // previously this fired on every call, snapping the user back to the stuck
  // row whenever they clicked elsewhere in the move list.
  if(stuckPly!==null && stuckPly!==state.lastScrolledStuckPly){
    var stuckIdx=Math.floor(stuckPly/2);
    var stuckRow=rows[stuckIdx];
    if(stuckRow){
      // Use getBoundingClientRect to compute the row's position relative to
      // the container, INDEPENDENT of offsetParent semantics. (offsetTop is
      // relative to the nearest positioned ancestor, which may not be the
      // container — that's why earlier centering math sometimes put the
      // stuck row off-screen.)
      var stuckCRect = container.getBoundingClientRect();
      var stuckRRect = stuckRow.getBoundingClientRect();
      var rowTopInContainer = (stuckRRect.top - stuckCRect.top) + container.scrollTop;
      container.scrollTop = rowTopInContainer - container.clientHeight/2 + stuckRRect.height/2;
      _branch='center-on-new-stuck'; _scrollAfter=container.scrollTop;
    }
    state.lastScrolledStuckPly=stuckPly;
    if (state._debugScroll) console.log('[scrollCurrentMoveIntoView]', { branch:_branch, before:_scrollBefore, after:_scrollAfter, stuckPly:stuckPly, currentPly:state.currentPly });
    return;
  }
  // NOTE: deliberately NOT resetting lastScrolledStuckPly when stuckPly is
  // null. During fix-application flows, stuckPly briefly goes null between
  // applyFix and revalidate's response — resetting lastScrolledStuckPly on
  // that transient null caused every fix to re-center the list when stuckPly
  // came back to the same value. Leaving it set means: if stuckPly returns
  // as the SAME value, no re-center; if it returns as a NEW value, the
  // comparison above catches the genuine change.

  // No stuck-change scroll happened. Fall through to "only scroll if the
  // currently navigated row is off-screen" so manual clicks/keypresses
  // adjust the view minimally without snapping back to stuck.
  var idx=state.currentPly>0?Math.floor((state.currentPly-1)/2):0;
  if(rows[idx]){
    var row=rows[idx];
    var containerRect=container.getBoundingClientRect();
    var rowRect=row.getBoundingClientRect();
    if(rowRect.top<containerRect.top||rowRect.bottom>containerRect.bottom){
      // Same getBoundingClientRect-based math as the stuck-centering branch,
      // for consistency and offsetParent-independence.
      var rowTopInContainer2 = (rowRect.top - containerRect.top) + container.scrollTop;
      container.scrollTop = rowTopInContainer2 - container.clientHeight/2 + rowRect.height/2;
      _branch='center-on-currentPly-out-of-view'; _scrollAfter=container.scrollTop;
    } else {
      _branch='in-view-no-scroll';
    }
  } else {
    _branch='no-row-at-idx-'+idx+'-of-'+rows.length;
  }
  if (state._debugScroll) console.log('[scrollCurrentMoveIntoView]', { branch:_branch, before:_scrollBefore, after:_scrollAfter, stuckPly:stuckPly, currentPly:state.currentPly, idx:idx, rowCount:rows.length });
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
    td.classList.remove('move-origin-stuck');
  });

  // Backtrack-review extra paint: when the focused fix is a backtrack
  // proposal (state.originStuckPly set and != state.stuckPly), also
  // mark the ORIGIN stuck cell in red. Yellow outline still marks the
  // backtrack proposal (state.stuckPly) so the move list visually
  // matches the headline: red where the algorithm got stuck, yellow
  // where the proposed repair lives.
  if(state.originStuckPly !== null && state.originStuckPly !== undefined
     && state.originStuckPly !== state.stuckPly){
    var oIdx = Math.floor(state.originStuckPly / 2);
    var oIsBlack = (state.originStuckPly % 2 === 1);
    var oRows = document.querySelectorAll('#move-tbody tr');
    if(oRows[oIdx]){
      var oTds = oRows[oIdx].querySelectorAll('td');
      if(oTds[oIsBlack ? 2 : 1]) oTds[oIsBlack ? 2 : 1].classList.add('move-origin-stuck');
    }
  }

  // If we're AT the stuck/focused position, highlight the stuck cell
  // itself rather than the last-played ply. Two cases where this is
  // true:
  //   (a) Interactive mode: state.sans stops at the stuck point, so
  //       currentPly === state.sans.length coincides with "parked at
  //       stuck".
  //   (b) Verification mode: state.sans is the full reconstructed game
  //       (may be 73 plies), but we've just goToPly'd to a fix's ply
  //       in the middle, so currentPly === state.stuckPly matches the
  //       current fix's ply. The user's visual expectation is "only
  //       the cell I'm currently reviewing gets highlighted" — before
  //       this check we also painted the PRIOR cell (last played),
  //       producing two yellow outlines.
  if(state.stuckInfo &&
     (state.currentPly === state.sans.length ||
      state.currentPly === state.stuckPly)){
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
    // Layout: [move numbers] [panel1] [panel2] — move numbers separate so both grids are equal width.
    // Shared maxRow so a player who ran out of space (shorter sheet) still
    // gets placeholder rows drawn up to the other player's max move number;
    // otherwise one panel stops advancing while the other scrolls on.
    var s1Max = state.ocrCellsSheet1.reduce(function(m,c){return c.num>m?c.num:m;},0);
    var s2Max = state.ocrCellsSheet2.reduce(function(m,c){return c.num>m?c.num:m;},0);
    var sharedMax = Math.max(s1Max, s2Max);
    var html = '<div style="display:flex;gap:0;align-items:stretch">';
    html += _buildMoveNumberColumn(state.ocrCellsSheet1, highlightMoveNum, sharedMax);
    html += '<div style="display:flex;flex:1;gap:4px">';
    html += _buildOcrContextGrid(state.ocrCellsSheet1, highlightMoveNum, highlightColor, 'white', sharedMax);
    html += _buildOcrContextGrid(state.ocrCellsSheet2, highlightMoveNum, highlightColor, 'black', sharedMax);
    html += '</div></div>';
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

// Helper: build standalone move number column for dual mode
function _buildMoveNumberColumn(cells, highlightMoveNum, overrideMaxRow){
    var maxRow=0;
    cells.forEach(function(c){if(c.num>maxRow)maxRow=c.num;});
    if (typeof overrideMaxRow === 'number' && overrideMaxRow > maxRow) maxRow = overrideMaxRow;
    var rpc = state.rowsPerColumn || 0;
    var highlightCol = rpc > 0 ? Math.floor((highlightMoveNum - 1) / rpc) : 0;
    var colStart = rpc > 0 ? highlightCol * rpc + 1 : 1;
    var colEnd = rpc > 0 ? (highlightCol + 1) * rpc : maxRow;
    colEnd = Math.min(colEnd, maxRow);
    var startRow=Math.max(colStart,highlightMoveNum-1);
    var endRow=startRow+2;
    if(endRow>colEnd){endRow=colEnd;startRow=Math.max(colStart,endRow-2);}

    var html='<div style="display:flex;flex-direction:column;justify-content:space-around;flex-shrink:0;padding-right:4px">';
    for(var row=startRow;row<=endRow;row++){
      var numClass = (row === highlightMoveNum) ? 'text-yellow-300 font-bold' : 'text-gray-500';
      html+='<div class="text-xs '+numClass+'" style="text-align:right">'+row+'.</div>';
    }
    html+='</div>';
    return html;
}

// Helper: build one OCR context grid for a set of cells
function _buildOcrContextGrid(cells, highlightMoveNum, highlightColor, label, overrideMaxRow){
    // Find max row in OCR data to avoid showing empty rows beyond the scoresheet.
    // In dual-sheet mode the caller passes overrideMaxRow (shared across both
    // players) so a shorter sheet still renders placeholder rows up to the
    // other player's max move.
    var maxRow=0;
    cells.forEach(function(c){if(c.num>maxRow)maxRow=c.num;});
    if (typeof overrideMaxRow === 'number' && overrideMaxRow > maxRow) maxRow = overrideMaxRow;
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

    // Check if stuck position is in view. For backtrack-review (where
    // state.stuckPly is the focus ply, not the actual stuck point),
    // state.originStuckPly carries the real stuck ply so the red outline
    // lands on the right cell. Without this, the OCR-cell panel would
    // outline the focus ply (15.B) red — but the focus ply already gets
    // the yellow current-cell outline, and the red SHOULD be on the
    // actual stuck ply (16.B) to match the headline + move-list outlines.
    var stuckMoveNum, stuckColor;
    if (typeof state.originStuckPly === 'number'
        && state.originStuckPly !== state.stuckPly) {
      stuckMoveNum = Math.floor(state.originStuckPly / 2) + 1;
      stuckColor = (state.originStuckPly % 2 === 0) ? 'w' : 'b';
    } else if (state.stuckInfo) {
      stuckMoveNum = state.stuckInfo.num;
      stuckColor = state.stuckInfo.color;
    } else {
      stuckMoveNum = null;
      stuckColor = null;
    }

    // Check if we should show g-tail area below the last row
    var showGTail = (endRow === colEnd);
    var wLastCell = showGTail ? cells.find(function(c){return c.num===endRow&&c.color==='w';}) : null;
    var bLastCell = showGTail ? cells.find(function(c){return c.num===endRow&&c.color==='b';}) : null;
    var hasGTailImages = (wLastCell && wLastCell.cellBelowImageUrl) || (bLastCell && bLastCell.cellBelowImageUrl);
    var hasLastCellImages = showGTail && !hasGTailImages && ((wLastCell && wLastCell.imageDataUrl) || (bLastCell && bLastCell.imageDataUrl));
    var showGTailRow = hasGTailImages || hasLastCellImages;

    var rowCount = endRow - startRow + 1 + (showGTailRow ? 1 : 0);

    // Wrapper
    var isDual = (label === 'white' || label === 'black');
    var html='<div style="flex:1;' + (isDual ? '' : 'min-width:140px;') + '">';

    // In single-sheet mode, wrap with flex for move numbers + grid side by side
    if(!isDual){
      html+='<div style="display:flex;align-items:stretch;gap:4px">';
      html+='<div style="display:flex;flex-direction:column;justify-content:space-around;flex-shrink:0">';
      for(var row=startRow;row<=endRow;row++){
        var numClass = (row === highlightMoveNum) ? 'text-yellow-300 font-bold' : 'text-gray-500';
        html+='<div class="text-xs '+numClass+'" style="text-align:right;padding-right:4px">'+row+'.</div>';
      }
      html+='</div>';
    }

    // Image grid - seamless reconstruction of the scoresheet column.
    // Adjacent crops SHARE their boundaries (row i's yBot == row i+1's yTop,
    // and the white/black halves share xMid), so tiling them edge-to-edge with
    // object-fit:fill (below) rebuilds the original sheet with no gaps. This
    // also reconnects 'g' descenders: a tail clipped at one row's bottom
    // reappears at the top of the next cell's crop. All slide cells share the
    // same warp aspect ratio, so fill scales them uniformly (no visible skew).
    var cellH = 32;  // Fixed cell height in px
    html+='<div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:repeat('+rowCount+','+cellH+'px);gap:0;line-height:0;overflow:hidden;border-radius:4px">';
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
        html+='<img src="'+wCell.imageDataUrl+'" style="width:100%;height:100%;display:block;object-fit:fill" alt="'+(wCell.move||'')+'">';
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
        html+='<img src="'+bCell.imageDataUrl+'" style="width:100%;height:100%;display:block;object-fit:fill" alt="'+(bCell.move||'')+'">';
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
    html+='</div>';  // close image grid
    if(!isDual) html+='</div>';  // close flex wrapper (single-sheet only)
    html+='</div>';  // close outer wrapper
    return html;
}
