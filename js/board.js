// =============================================================================
// BOARD RENDERING
// =============================================================================

function fenToBoard(fen){
  var board=[],rows=fen.split(' ')[0].split('/');
  for(var i=0;i<rows.length;i++){
    var row=[];
    for(var j=0;j<rows[i].length;j++){
      var c=rows[i][j];
      if(c>='1'&&c<='8')for(var k=0;k<parseInt(c);k++)row.push('');
      else row.push(c);
    }
    board.push(row);
  }
  return board;
}

function getPieceUrl(p){
  if(!p)return null;
  var c=p===p.toUpperCase()?'w':'b';
  return'pieces/'+CONFIG.pieceStyle+'/'+c+p.toUpperCase()+'.svg';
}

function renderBoard(){
  var grid=document.getElementById('board-grid');
  grid.innerHTML='';
  var flip=state.boardFlipped;
  for(var r=0;r<8;r++){
    for(var c=0;c<8;c++){
      var br=flip?7-r:r, bc=flip?7-c:c;
      var isLight=(br+bc)%2===0,sqName='abcdefgh'[bc]+(8-br);
      var sq=document.createElement('div');
      sq.className='relative flex items-center justify-center '+(isLight?'square-light':'square-dark');
      sq.dataset.square=sqName;
      var piece=state.board[br]?state.board[br][bc]:'';
      if(piece){
        var pd=document.createElement('div');
        pd.className='piece';
        pd.style.backgroundImage="url('"+getPieceUrl(piece)+"')";
        sq.appendChild(pd);
      }
      if(c===0){
        var cr=document.createElement('span');
        cr.className='absolute left-0.5 top-0 text-xs font-bold '+(isLight?'text-amber-800':'text-amber-200');
        cr.textContent=8-br;
        sq.appendChild(cr);
      }
      if(r===7){
        var cf=document.createElement('span');
        cf.className='absolute right-0.5 bottom-0 text-xs font-bold '+(isLight?'text-amber-800':'text-amber-200');
        cf.textContent='abcdefgh'[bc];
        sq.appendChild(cf);
      }
      grid.appendChild(sq);
    }
  }
  renderArrows();
  setupBoardInteraction();
}

function squareToCoords(sq){
  if(!sq||sq.length!==2)return null;
  var f=sq.charCodeAt(0)-97,rk=parseInt(sq[1])-1;
  if(state.boardFlipped){
    return{x:(7-f)*100+50,y:rk*100+50};
  }
  return{x:f*100+50,y:(7-rk)*100+50};
}

function renderArrows(){
  var svg=document.getElementById('arrow-overlay');
  svg.querySelectorAll('line.arrow').forEach(function(a){a.remove();});
  
  // Red arrow = stuck/illegal move - widest, with outline
  if(state.errorArrow&&state.errorArrow.from&&state.errorArrow.to){
    var f=squareToCoords(state.errorArrow.from),t=squareToCoords(state.errorArrow.to);
    if(f&&t){
      // Black outline
      var ol=document.createElementNS('http://www.w3.org/2000/svg','line');
      ol.setAttribute('class','arrow');
      ol.setAttribute('x1',f.x);ol.setAttribute('y1',f.y);
      ol.setAttribute('x2',t.x);ol.setAttribute('y2',t.y);
      ol.setAttribute('stroke','rgba(0,0,0,0.7)');
      ol.setAttribute('stroke-width','16');
      ol.setAttribute('stroke-linecap','round');
      svg.appendChild(ol);
      // Red fill
      var ln=document.createElementNS('http://www.w3.org/2000/svg','line');
      ln.setAttribute('class','arrow');
      ln.setAttribute('x1',f.x);ln.setAttribute('y1',f.y);
      ln.setAttribute('x2',t.x);ln.setAttribute('y2',t.y);
      ln.setAttribute('stroke','rgba(239,68,68,0.9)');
      ln.setAttribute('stroke-width','12');
      ln.setAttribute('stroke-linecap','round');
      ln.setAttribute('marker-end','url(#ah-red)');
      svg.appendChild(ln);
    }
  }
  
  // Yellow arrow = OCR move being substituted (what was read) - thinner, with outline
  if(state.ocrArrow&&state.ocrArrow.from&&state.ocrArrow.to){
    var f=squareToCoords(state.ocrArrow.from),t=squareToCoords(state.ocrArrow.to);
    if(f&&t){
      // Black outline
      var ol=document.createElementNS('http://www.w3.org/2000/svg','line');
      ol.setAttribute('class','arrow');
      ol.setAttribute('x1',f.x);ol.setAttribute('y1',f.y);
      ol.setAttribute('x2',t.x);ol.setAttribute('y2',t.y);
      ol.setAttribute('stroke','rgba(0,0,0,0.7)');
      ol.setAttribute('stroke-width','10');
      ol.setAttribute('stroke-linecap','round');
      svg.appendChild(ol);
      // Yellow fill
      var ln=document.createElementNS('http://www.w3.org/2000/svg','line');
      ln.setAttribute('class','arrow');
      ln.setAttribute('x1',f.x);ln.setAttribute('y1',f.y);
      ln.setAttribute('x2',t.x);ln.setAttribute('y2',t.y);
      ln.setAttribute('stroke','rgba(250,204,21,0.95)');
      ln.setAttribute('stroke-width','6');
      ln.setAttribute('stroke-linecap','round');
      ln.setAttribute('marker-end','url(#ah-yellow)');
      svg.appendChild(ln);
    }
  }
  
  // Green arrow = suggested fix - with outline
  if(state.fixArrow&&state.fixArrow.from&&state.fixArrow.to){
    var f=squareToCoords(state.fixArrow.from),t=squareToCoords(state.fixArrow.to);
    if(f&&t){
      // Black outline
      var ol=document.createElementNS('http://www.w3.org/2000/svg','line');
      ol.setAttribute('class','arrow');
      ol.setAttribute('x1',f.x);ol.setAttribute('y1',f.y);
      ol.setAttribute('x2',t.x);ol.setAttribute('y2',t.y);
      ol.setAttribute('stroke','rgba(0,0,0,0.7)');
      ol.setAttribute('stroke-width','12');
      ol.setAttribute('stroke-linecap','round');
      svg.appendChild(ol);
      // Green fill
      var ln=document.createElementNS('http://www.w3.org/2000/svg','line');
      ln.setAttribute('class','arrow');
      ln.setAttribute('x1',f.x);ln.setAttribute('y1',f.y);
      ln.setAttribute('x2',t.x);ln.setAttribute('y2',t.y);
      ln.setAttribute('stroke','rgba(34,197,94,0.95)');
      ln.setAttribute('stroke-width','8');
      ln.setAttribute('stroke-linecap','round');
      ln.setAttribute('marker-end','url(#ah-green)');
      svg.appendChild(ln);
    }
  }
}

function highlightSquares(sqs){
  document.querySelectorAll('#board-grid > div').forEach(function(sq){
    sq.classList.remove('square-highlight');
  });
  sqs.forEach(function(n){
    var el=document.querySelector('[data-square="'+n+'"]');
    if(el)el.classList.add('square-highlight');
  });
}

// =============================================================================
// CLICK-TO-MOVE + DRAG-AND-DROP: Board interaction for inputting moves
// =============================================================================

var dragState=null; // {square, piece, ghostEl, startX, startY, isDragging, origPieceEl}

function isBoardInteractive(){
  return state.stuckPly !== null || state.editMode;
}

function setupBoardInteraction(){
  var grid=document.getElementById('board-grid');
  if(!grid||!chess)return;

  // Prevent native browser drag on piece images (background-image divs)
  grid.ondragstart=function(e){e.preventDefault();};

  grid.querySelectorAll('[data-square]').forEach(function(sqEl){
    // Remove old onclick in favor of mousedown/mouseup
    sqEl.onclick=null;

    sqEl.onmousedown=function(e){
      if(e.button!==0)return; // left button only
      if(e.target.tagName==='SPAN')return;
      if(!isBoardInteractive())return;
      e.preventDefault(); // prevent native drag and text selection
      handleBoardMouseDown(sqEl.dataset.square,e);
    };

    // Touch support
    sqEl.ontouchstart=function(e){
      if(!isBoardInteractive())return;
      var touch=e.touches[0];
      var target=document.elementFromPoint(touch.clientX,touch.clientY);
      if(target&&target.tagName==='SPAN')return;
      e.preventDefault(); // prevent scrolling
      handleBoardMouseDown(sqEl.dataset.square,{clientX:touch.clientX,clientY:touch.clientY,preventDefault:function(){}});
    };
  });

  // Show grab cursor on own pieces when interactive, and add hover tooltips
  if(isBoardInteractive()){
    var turn=chess.turn();
    grid.querySelectorAll('[data-square]').forEach(function(sqEl){
      var sq=sqEl.dataset.square;
      var piece=chess.get(sq);
      if(piece&&piece.color===turn){
        sqEl.classList.add('square-interactive');
        sqEl.title='Click to select, then click target square\nOr drag and drop to move';
      }else{
        sqEl.title='';
      }
    });
  }
}

function handleBoardMouseDown(square,e){
  if(!chess)return;
  var turn=chess.turn();
  var piece=chess.get(square);
  var sel=state.boardSelection;

  // If clicking a legal target while a piece is selected, execute immediately (no drag)
  if(sel&&sel.legalTargets.indexOf(square)!==-1){
    executeBoardMove(sel.square,square);
    return;
  }

  // Only start drag on own pieces
  if(!piece||piece.color!==turn){
    // Clicked empty or opponent piece with no selection — deselect
    if(sel)clearBoardSelection();
    return;
  }

  // If already selected on same square — mark for deselect on click (not drag)
  var wasAlreadySelected=sel&&sel.square===square;

  // Select (or switch selection to) this piece
  if(!wasAlreadySelected){
    clearBoardSelection();
    selectBoardSquare(square,piece);
  }

  // Init drag state — snapshot legal targets and chess FEN so drag survives async board re-renders
  var sqEl=document.querySelector('[data-square="'+square+'"]');
  var pieceEl=sqEl?sqEl.querySelector('.piece'):null;
  var currentSel=state.boardSelection;
  dragState={
    square:square,
    piece:piece,
    ghostEl:null,
    startX:e.clientX,
    startY:e.clientY,
    isDragging:false,
    origPieceEl:pieceEl,
    wasAlreadySelected:wasAlreadySelected,
    legalTargets:currentSel?currentSel.legalTargets.slice():[],
    verboseMoves:currentSel?currentSel.verboseMoves.slice():[],
    chessFen:chess.fen()
  };

  document.addEventListener('mousemove',handleDragMove);
  document.addEventListener('mouseup',handleDragEnd);
  document.addEventListener('touchmove',handleDragTouchMove,{passive:false});
  document.addEventListener('touchend',handleDragTouchEnd);
}

function handleDragMove(e){
  if(!dragState)return;
  var dx=e.clientX-dragState.startX;
  var dy=e.clientY-dragState.startY;

  if(!dragState.isDragging&&(dx*dx+dy*dy)>16){ // 4px threshold
    dragState.isDragging=true;
    document.body.classList.add('board-dragging');
    // Create ghost piece
    var ghost=document.createElement('div');
    ghost.className='piece drag-ghost';
    var pieceChar=dragState.piece.color==='w'?dragState.piece.type.toUpperCase():dragState.piece.type;
    ghost.style.backgroundImage="url('"+getPieceUrl(pieceChar)+"')";
    // Size ghost to match square
    var sqEl=document.querySelector('[data-square="'+dragState.square+'"]');
    if(sqEl){
      var rect=sqEl.getBoundingClientRect();
      ghost.style.width=rect.width+'px';
      ghost.style.height=rect.height+'px';
    }
    document.body.appendChild(ghost);
    dragState.ghostEl=ghost;
    // Hide original piece
    if(dragState.origPieceEl)dragState.origPieceEl.style.opacity='0';
  }

  if(dragState.isDragging&&dragState.ghostEl){
    dragState.ghostEl.style.left=(e.clientX-dragState.ghostEl.offsetWidth/2)+'px';
    dragState.ghostEl.style.top=(e.clientY-dragState.ghostEl.offsetHeight/2)+'px';
  }
}

function handleDragEnd(e){
  document.removeEventListener('mousemove',handleDragMove);
  document.removeEventListener('mouseup',handleDragEnd);
  document.removeEventListener('touchmove',handleDragTouchMove);
  document.removeEventListener('touchend',handleDragTouchEnd);

  if(!dragState)return;
  var wasDragging=dragState.isDragging;
  var fromSquare=dragState.square;

  if(wasDragging){
    document.body.classList.remove('board-dragging');
    // Find target square under cursor
    if(dragState.ghostEl)dragState.ghostEl.style.display='none'; // hide ghost so elementFromPoint hits square
    var target=document.elementFromPoint(e.clientX,e.clientY);
    if(dragState.ghostEl)dragState.ghostEl.style.display='';

    // Walk up to find [data-square] element
    var targetSq=null;
    while(target&&target!==document.body){
      if(target.dataset&&target.dataset.square){targetSq=target.dataset.square;break;}
      target=target.parentElement;
    }

    // Use dragState's snapshot of legal targets (immune to async clearBoardSelection)
    if(targetSq&&dragState.legalTargets.indexOf(targetSq)!==-1){
      // Restore chess position if it was changed by async re-render during drag
      if(chess.fen()!==dragState.chessFen){
        chess.load(dragState.chessFen);
      }
      // Ensure boardSelection exists for executeBoardMove (may have been cleared by async re-render)
      if(!state.boardSelection){
        state.boardSelection={square:fromSquare,piece:dragState.piece,legalTargets:dragState.legalTargets,verboseMoves:dragState.verboseMoves};
      }
      cleanupDrag();
      executeBoardMove(fromSquare,targetSq);
      return;
    }

    // Invalid drop — cancel
    cleanupDrag();
    clearBoardSelection();
  }else{
    // Was a click (no drag movement)
    var wasAlready=dragState?dragState.wasAlreadySelected:false;
    cleanupDrag();
    // If piece was already selected before this mousedown, deselect it (toggle)
    if(wasAlready){
      clearBoardSelection();
    }
  }
}

function handleDragTouchMove(e){
  if(!dragState)return;
  e.preventDefault();
  var touch=e.touches[0];
  handleDragMove({clientX:touch.clientX,clientY:touch.clientY});
}

function handleDragTouchEnd(e){
  if(!dragState)return;
  var touch=e.changedTouches[0];
  handleDragEnd({clientX:touch.clientX,clientY:touch.clientY});
}

function cleanupDrag(){
  if(!dragState)return;
  if(dragState.ghostEl){
    dragState.ghostEl.remove();
  }
  if(dragState.origPieceEl){
    dragState.origPieceEl.style.opacity='';
  }
  document.body.classList.remove('board-dragging');
  dragState=null;
}

function handleBoardClick(square){
  if(!chess)return;
  var sel=state.boardSelection;
  var turn=chess.turn();
  var piece=chess.get(square);

  // Case 1: No selection — click on own piece to select it
  if(!sel){
    if(piece&&piece.color===turn){
      selectBoardSquare(square,piece);
    }
    return;
  }

  // Case 2: Already selected, click same square — deselect
  if(sel.square===square){
    clearBoardSelection();
    return;
  }

  // Case 3: Already selected, click another own piece — switch selection
  if(piece&&piece.color===turn){
    clearBoardSelection();
    selectBoardSquare(square,piece);
    return;
  }

  // Case 4: Already selected, click a legal target — execute move
  if(sel.legalTargets.indexOf(square)!==-1){
    executeBoardMove(sel.square,square);
    return;
  }

  // Case 5: Click on non-target — deselect
  clearBoardSelection();
}

function selectBoardSquare(square,piece){
  clearBoardSelection();

  // Compute legal targets from this square
  var moves=chess.moves({square:square,verbose:true});
  var targets=moves.map(function(m){return m.to;});
  // Deduplicate (promotions create multiple moves to same square)
  targets=targets.filter(function(t,i){return targets.indexOf(t)===i;});

  if(targets.length===0)return; // No legal moves from this square

  state.boardSelection={square:square,piece:piece,legalTargets:targets,verboseMoves:moves};

  // Highlight selected square
  var selEl=document.querySelector('[data-square="'+square+'"]');
  if(selEl)selEl.classList.add('square-selected');

  // Show legal targets
  targets.forEach(function(t){
    var tEl=document.querySelector('[data-square="'+t+'"]');
    if(!tEl)return;
    var isCapture=moves.some(function(m){return m.to===t&&(m.captured||m.flags.indexOf('e')!==-1);});
    tEl.classList.add(isCapture?'square-legal-target-capture':'square-legal-target');
    tEl.classList.add('square-interactive');
  });
}

function clearBoardSelection(){
  state.boardSelection=null;
  document.querySelectorAll('#board-grid > div').forEach(function(sq){
    sq.classList.remove('square-selected','square-legal-target','square-legal-target-capture','square-interactive');
  });
  // Remove promotion picker if open
  var picker=document.getElementById('promotion-picker');
  if(picker)picker.remove();
}

function executeBoardMove(from,to){
  var sel=state.boardSelection;
  if(!sel)return;

  // Check if this is a promotion
  var promoMoves=sel.verboseMoves.filter(function(m){
    return m.from===from&&m.to===to&&m.promotion;
  });

  if(promoMoves.length>0){
    showPromotionPicker(from,to,promoMoves);
    return;
  }

  // Normal move
  var moveObj=chess.move({from:from,to:to});
  if(!moveObj)return;
  chess.undo(); // Undo — we just needed the SAN

  finalizeBoardMove(moveObj.san,from,to);
}

function showPromotionPicker(from,to,promoMoves){
  // Remove existing picker
  var existing=document.getElementById('promotion-picker');
  if(existing)existing.remove();

  var boardGrid=document.getElementById('board-grid');
  var toEl=document.querySelector('[data-square="'+to+'"]');
  if(!toEl||!boardGrid)return;

  var turn=chess.turn();
  var pieces=['q','r','b','n'];
  var picker=document.createElement('div');
  picker.id='promotion-picker';
  picker.className='absolute z-20 flex flex-col bg-gray-800 border-2 border-blue-400 rounded shadow-lg';

  // Position at the destination square
  var gridRect=boardGrid.getBoundingClientRect();
  var toRect=toEl.getBoundingClientRect();
  var left=toRect.left-gridRect.left;
  var sqSize=toRect.width;

  // Stack vertically from destination square: promotion row is at top or bottom depending on flip
  var promoAtTop=(turn==='w')!==state.boardFlipped;
  if(promoAtTop){
    picker.style.top='0px';
    picker.style.left=left+'px';
  }else{
    picker.style.bottom='0px';
    picker.style.left=left+'px';
  }
  picker.style.width=sqSize+'px';

  pieces.forEach(function(p){
    var btn=document.createElement('button');
    btn.className='flex items-center justify-center hover:bg-blue-600/50';
    btn.style.width=sqSize+'px';
    btn.style.height=sqSize+'px';
    var pieceChar=turn==='w'?p.toUpperCase():p;
    var img=document.createElement('div');
    img.className='piece';
    img.style.width='90%';img.style.height='90%';
    img.style.backgroundImage="url('"+getPieceUrl(pieceChar)+"')";
    btn.appendChild(img);
    btn.onclick=function(e){
      e.stopPropagation();
      var moveObj=chess.move({from:from,to:to,promotion:p});
      if(!moveObj)return;
      chess.undo();
      picker.remove();
      finalizeBoardMove(moveObj.san,from,to);
    };
    picker.appendChild(btn);
  });

  boardGrid.appendChild(picker);

  // Close on Escape
  function onKey(e){
    if(e.key==='Escape'){
      picker.remove();
      document.removeEventListener('keydown',onKey);
    }
  }
  document.addEventListener('keydown',onKey);
}

function finalizeBoardMove(san,from,to){
  clearBoardSelection();

  if(state.editMode){
    // In edit mode: create an edit fix and apply it
    var em=state.editMode;
    var fix={
      san:san,
      ocr:em.currentMove,
      similarity:0,
      ply_str:em.num+'.'+em.color.toUpperCase(),
      ply:em.ply,
      isEditMode:true,
      from_square:from,
      to_square:to
    };
    selectFix(fix,null);
    applyFix();
  }else if(state.stuckPly!==null){
    // Check if a fix suggestion is selected that targets a DIFFERENT ply than stuckPly
    // (e.g., user selected "25.W Rxe1 -> Kxe1" while stuck at 26.B)
    // In that case, the board is showing the position at that earlier ply,
    // so the drag should apply to that ply, not to stuckPly.
    var sf=state.selectedFix;
    var targetPly=null, targetPlyStr=null, targetOcr=null;

    if(sf&&typeof sf.ply==='number'&&sf.ply!==state.stuckPly){
      targetPly=sf.ply;
      targetPlyStr=sf.ply_str||plyToStr(sf.ply);
      // Look up the OCR text for this ply from state.moves
      var tNum=Math.floor(targetPly/2)+1;
      var tColor=targetPly%2===0?'w':'b';
      for(var i=0;i<state.moves.length;i++){
        if(state.moves[i].num===tNum){
          targetOcr=tColor==='w'?state.moves[i].white:state.moves[i].black;
          break;
        }
      }
    }

    if(targetPly!==null){
      // Apply to the selected fix's ply (backtrack fix)
      var fix={
        san:san,
        ocr:targetOcr||'',
        similarity:0,
        ply_str:targetPlyStr,
        ply:targetPly,
        from_square:from,
        to_square:to,
        ocr_from_square:sf.ocr_from_square||null,
        ocr_to_square:sf.ocr_to_square||null
      };
      selectFix(fix,null);
      applyFix();
    }else{
      // Default: apply to stuck position
      var lbl=state.stuckInfo?state.stuckInfo.num+'.'+state.stuckInfo.color.toUpperCase():'';
      var ocr=state.stuckInfo?state.stuckInfo.move:'';
      var fix={
        san:san,
        ocr:ocr,
        similarity:0,
        ply_str:lbl,
        from_square:from,
        to_square:to,
        ocr_from_square:state.errorArrow?state.errorArrow.from:null,
        ocr_to_square:state.errorArrow?state.errorArrow.to:null
      };
      selectFix(fix,null);
      applyFix();
    }
  }
}
