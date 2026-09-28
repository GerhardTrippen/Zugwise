// =============================================================================
// MOVE-LIST-SHEETS.JS — Optional side-by-side review layout
// =============================================================================
// Alternative to the stacked layout (OCR context panel above, move list
// below). When enabled via the "Side by side" toggle in the Moves header,
// every move-list row grows to (dual-sheet):
//
//   #  | Sheet 1 W | W move | Sheet 2 W || Sheet 1 B | B move | Sheet 2 B
//
// or, single-sheet (state.ocrCells):
//
//   #  | Sheet W | W move || Sheet B | B move
//
// DOM contract (why sheet cells are <th>, not <td>): navigation.js,
// verification-ui.js and ocr.js all address a move row as
// row.querySelectorAll('td') -> [num, white, black]. The sheet cells are
// inserted as <th> elements, so that contract, the stock click / dblclick /
// context-menu handlers and every verification overlay keep working
// unchanged. On a narrow panel, styles.css (container query) splits each row
// into a W line and a B line.
//
// Rows line up by aligned ply: cells are looked up by their current
// (num, color), which renumberSheetCells / renumberOcrCells rewrite after
// every shift. Inserted placeholders (_source 'user-insert') never show their
// own move text — that is a copy of the other sheet's reading
// (_backfillPlaceholdersFromOtherSheet), not something written on this sheet.
// They show '—', or, once the ply is settled (ok/fixed/locked), the move-list
// move in a muted dashed box.
// The list fills the column height (styles.css .mls-tall) since the OCR
// context panel is hidden in this layout.
//
// Setting: currentSettings.move_list_layout ('stacked' | 'side_by_side'),
// persisted via settings.js (localStorage 'zugwise_settings').
// =============================================================================

(function() {
  'use strict';

  var LAYOUT_KEY = 'move_list_layout';
  var _stockThead = null;

  function _norm(san) {
    if (window.MergeSheets && window.MergeSheets.normalizeSanForComparison) {
      return window.MergeSheets.normalizeSanForComparison(san);
    }
    if (!san) return '';
    return String(san).replace(/[+#!?]/g, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O').trim();
  }

  function _hasDualSheets() {
    return !!(state.ocrCellsSheet1 && state.ocrCellsSheet1.length > 0 &&
              state.ocrCellsSheet2 && state.ocrCellsSheet2.length > 0);
  }

  /** 'dual' | 'single' | null — which sheet data the layout can show. */
  function _mode() {
    if (state.inputMode === 'pgn') return null;
    if (_hasDualSheets()) return 'dual';
    if (state.ocrCells && state.ocrCells.length > 0) return 'single';
    return null;
  }

  function isEnabled() {
    return !!(currentSettings && currentSettings[LAYOUT_KEY] === 'side_by_side');
  }

  /** True when the side-by-side layout is actually being shown. */
  function isActive() {
    return isEnabled() && _mode() !== null;
  }

  function setEnabled(on) {
    if (!currentSettings) return;
    currentSettings[LAYOUT_KEY] = on ? 'side_by_side' : 'stacked';
    saveSettings(currentSettings);
    if (typeof renderMoveList === 'function') renderMoveList();
    if (typeof highlightCurrentMove === 'function') highlightCurrentMove();
    if (typeof updateOcrContextPanel === 'function') updateOcrContextPanel();
  }

  function _indexSheet(cells) {
    var out = {};
    (cells || []).forEach(function(c) {
      var n = (c.num != null) ? c.num : c.move_number;
      out[n + '_' + c.color] = c;
    });
    return out;
  }

  function _isPlaceholder(cell) {
    return !cell || !cell.move || cell.move === '???';
  }

  /** Build one sheet cell (<th>) for a ply. All text goes through textContent. */
  function _sheetCell(cell, ply, moveSan, status, slotCls, sheetLabel) {
    var th = document.createElement('th');
    th.className = 'mls-cell ' + slotCls;
    th.scope = 'row';
    var plyLabel = (Math.floor(ply / 2) + 1) + '.' + (ply % 2 === 0 ? 'W' : 'B');

    if (!cell) {
      th.classList.add('mls-missing');
      th.textContent = '—';
      th.title = sheetLabel + ': no cell at ' + plyLabel;
      return th;
    }

    // Same action as clicking the move-list cell: go to the position after this ply.
    th.onclick = function() { goToPly(ply + 1, { skipScroll: true }); };

    if (cell._source === 'user-insert') {
      // Nothing was written here; once the ply is settled in the move list,
      // echo that move (muted, dashed) so the column reads as a full game.
      var settled = moveSan && (status === 'ok' || status === 'fixed' || status === 'locked');
      th.classList.add('mls-missing');
      if (settled) th.classList.add('mls-inserted');
      th.textContent = settled ? moveSan : '—';
      th.title = sheetLabel + ' ' + plyLabel + ': inserted — not written on this sheet' +
                 (settled ? ' (showing the move list)' : '');
      return th;
    }

    // Single-sheet corrections overwrite cell.move (syncCorrectionsToOcrCells);
    // _originalOcr keeps what was read.
    var reading = cell._originalOcr || cell.move || '';
    var conf = Math.round((cell.confidence || 0) * 100);
    var titleParts = [sheetLabel + ' ' + plyLabel + ': ' + (reading || '?') + ' (' + conf + '%)'];

    var img = cell.imageDataUrl;
    if (typeof img === 'string' && img.indexOf('data:image/') === 0) {
      var el = document.createElement('img');
      el.className = 'mls-img';
      el.src = img;
      el.alt = reading;
      el.loading = 'lazy';
      th.appendChild(el);
    } else {
      th.classList.add('mls-text');
      th.textContent = reading || '?';
    }

    if (!_isPlaceholder(cell) && moveSan && _norm(reading) !== _norm(moveSan)) {
      th.classList.add('mls-disagree');
      titleParts.push('differs from the move list (' + moveSan + ')');
    }
    if (_isPlaceholder(cell)) th.classList.add('mls-placeholder');

    th.title = titleParts.join(' — ');
    return th;
  }

  function _renderThead(on, mode) {
    var table = document.getElementById('move-tbody');
    table = table ? table.parentNode : null;
    if (!table) return;
    var thead = table.querySelector('thead');
    if (!thead) return;
    if (_stockThead === null) _stockThead = thead.innerHTML;
    table.classList.toggle('mls-on', on);
    table.classList.toggle('mls-single', on && mode === 'single');
    var container = document.getElementById('move-list-container');
    if (container) container.classList.toggle('mls-tall', on);
    if (!on) {
      thead.innerHTML = _stockThead;
      return;
    }
    // Static labels only — no data interpolated.
    if (mode === 'single') {
      thead.innerHTML =
        '<tr class="text-gray-500 text-xs">' +
          '<th class="w-8 text-left mls-h-num">#</th>' +
          '<th class="mls-h mls-s1w"><span class="mls-wide">Sheet · W</span><span class="mls-narrow">Sheet</span></th>' +
          '<th class="mls-h mls-mw"><span class="mls-wide">White</span><span class="mls-narrow">Move</span></th>' +
          '<th class="mls-h mls-s1b">Sheet · B</th>' +
          '<th class="mls-h mls-mb">Black</th>' +
        '</tr>';
      return;
    }
    thead.innerHTML =
      '<tr class="text-gray-500 text-xs">' +
        '<th class="w-8 text-left mls-h-num">#</th>' +
        '<th class="mls-h mls-s1w" title="White\'s scoresheet"><span class="mls-wide">Sheet 1 · W</span><span class="mls-narrow">Sheet 1</span></th>' +
        '<th class="mls-h mls-mw"><span class="mls-wide">White</span><span class="mls-narrow">Move</span></th>' +
        '<th class="mls-h mls-s2w" title="Black\'s scoresheet"><span class="mls-wide">Sheet 2 · W</span><span class="mls-narrow">Sheet 2</span></th>' +
        '<th class="mls-h mls-s1b" title="White\'s scoresheet">Sheet 1 · B</th>' +
        '<th class="mls-h mls-mb">Black</th>' +
        '<th class="mls-h mls-s2b" title="Black\'s scoresheet">Sheet 2 · B</th>' +
      '</tr>';
  }

  /**
   * Called at the end of renderMoveList(). Inserts the sheet cells into the
   * rows it just built, or restores the stock header when inactive.
   */
  function decorate() {
    var mode = _mode();
    var on = isEnabled() && mode !== null;
    _renderThead(on, mode);
    _renderToggle(mode);
    if (!on) return;

    var single = (mode === 'single');
    var s1 = _indexSheet(single ? state.ocrCells : state.ocrCellsSheet1);
    var s2 = single ? null : _indexSheet(state.ocrCellsSheet2);
    var s1Label = single ? 'Sheet' : 'Sheet 1';

    state.moves.forEach(function(m) {
      var tr = document.getElementById('move-row-' + m.num);
      if (!tr) return;
      var tds = tr.querySelectorAll('td');
      if (tds.length < 3) return;
      var wPly = (m.num - 1) * 2, bPly = wPly + 1;
      tds[1].classList.add('mls-mw');
      tds[2].classList.add('mls-mb');
      tr.insertBefore(_sheetCell(s1[m.num + '_w'], wPly, m.white, m.wStatus, 'mls-s1w', s1Label), tds[1]);
      if (!single) tr.insertBefore(_sheetCell(s2[m.num + '_w'], wPly, m.white, m.wStatus, 'mls-s2w', 'Sheet 2'), tds[2]);
      tr.insertBefore(_sheetCell(s1[m.num + '_b'], bPly, m.black, m.bStatus, 'mls-s1b', s1Label), tds[2]);
      if (!single) tr.appendChild(_sheetCell(s2[m.num + '_b'], bPly, m.black, m.bStatus, 'mls-s2b', 'Sheet 2'));
    });
  }

  /** Stacked / Side-by-side switch in the Moves header; only shown when there are sheet cells. */
  function _renderToggle(mode) {
    var host = document.getElementById('move-layout-toggle');
    if (!host) return;
    var show = mode !== null;
    host.classList.toggle('hidden', !show);
    if (!show) return;
    if (!host.dataset.wired) {
      host.dataset.wired = '1';
      host.querySelectorAll('button[data-layout]').forEach(function(b) {
        b.onclick = function() { setEnabled(b.dataset.layout === 'side_by_side'); };
      });
    }
    var cur = isEnabled() ? 'side_by_side' : 'stacked';
    host.querySelectorAll('button[data-layout]').forEach(function(b) {
      var sel = b.dataset.layout === cur;
      b.classList.toggle('mls-toggle-on', sel);
      b.setAttribute('aria-pressed', sel ? 'true' : 'false');
    });
  }

  window.MoveListSheets = {
    isEnabled: isEnabled,
    isActive: isActive,
    setEnabled: setEnabled,
    decorate: decorate
  };
})();
