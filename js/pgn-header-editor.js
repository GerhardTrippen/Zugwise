// =============================================================================
// pgn-header-editor.js — simple structured PGN header editor (window.PgnHeaderEditor)
//
// Two entry points:
//   PgnHeaderEditor.openSingle()        — edits state.pgnHeaders for the single/
//                                          dual game export (downloadPGN reads it).
//   PgnHeaderEditor.openBatchDefaults() — edits window._batchHeaderDefaults, a
//                                          round/tournament-level OVERRIDE store
//                                          that batch-export.js merges into every
//                                          exported game's headers.
//
// Why this exists:
//   - Single/dual PGNs were a hardcoded stub ([Event "Zugwise"], no players/date).
//   - chess-results.com per-round XLS (Premier/Crown) carries no venue, so batch
//     PGNs got [Site "?"]. There was no UI to supply the value the file lacked.
//
// Design rules (see CLAUDE.md):
//   - Structured fields only (no raw text — Zugwise builds valid PGN around values).
//   - Batch defaults are OVERRIDES that only fill/replace when non-empty; a blank
//     field never clobbers good tournament data.
//   - No new export logic here — both modes funnel through BatchExport.generatePgn.
// =============================================================================

(function () {
  'use strict';

  var MODAL_ID = 'pgn-header-editor-modal';

  // Standard result tokens for the dropdown.
  var RESULT_OPTIONS = ['*', '1-0', '0-1', '1/2-1/2'];

  // Field definitions for the single/dual editor (full seven-tag roster + Elo).
  // key = PGN tag, label = display, type = 'text' | 'select' | 'date'.
  var SINGLE_FIELDS = [
    { key: 'Event', label: 'Event', type: 'text', placeholder: 'Tournament name' },
    { key: 'Site', label: 'Site', type: 'text', placeholder: 'City, COUNTRY' },
    { key: 'Date', label: 'Date', type: 'text', placeholder: 'YYYY.MM.DD' },
    { key: 'Round', label: 'Round', type: 'text', placeholder: 'e.g. 3 or 3.1' },
    { key: 'White', label: 'White', type: 'text', placeholder: 'Last, First' },
    { key: 'Black', label: 'Black', type: 'text', placeholder: 'Last, First' },
    { key: 'Result', label: 'Result', type: 'select', options: RESULT_OPTIONS },
    { key: 'WhiteElo', label: 'White Elo', type: 'text', placeholder: 'optional' },
    { key: 'BlackElo', label: 'Black Elo', type: 'text', placeholder: 'optional' }
  ];

  // Field definitions for the batch round-defaults editor. These are the tags
  // that are genuinely tournament-wide. Per-game tags (Round/White/Black/Result)
  // come from the tournament file and are NOT overridable here.
  var BATCH_FIELDS = [
    { key: 'Event', label: 'Event', type: 'text', placeholder: 'Override event name' },
    { key: 'Site', label: 'Site', type: 'text', placeholder: 'City, COUNTRY' },
    { key: 'Date', label: 'Date', type: 'text', placeholder: 'YYYY.MM.DD' },
    { key: 'EventCountry', label: 'Country', type: 'text', placeholder: 'e.g. CAN' }
  ];

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _close() {
    var existing = document.getElementById(MODAL_ID);
    if (existing) existing.remove();
  }

  /**
   * Render the editor modal.
   * @param {Object} cfg
   * @param {string} cfg.title    - heading text
   * @param {string} cfg.subtitle - small grey note under the heading
   * @param {Array}  cfg.fields   - field defs (see *_FIELDS above)
   * @param {Object} cfg.values   - current values keyed by field.key
   * @param {Function} cfg.onSave - receives a values object {key: string}
   */
  function _renderModal(cfg) {
    _close();
    var values = cfg.values || {};

    var rowsHtml = cfg.fields.map(function (f) {
      var cur = values[f.key] != null ? String(values[f.key]) : '';
      var input;
      if (f.type === 'select') {
        input = '<select data-key="' + f.key + '" ' +
          'class="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-gray-100 w-full">' +
          (f.options || []).map(function (o) {
            return '<option value="' + _esc(o) + '"' +
              (o === cur ? ' selected' : '') + '>' + _esc(o) + '</option>';
          }).join('') +
          '</select>';
      } else {
        input = '<input data-key="' + f.key + '" type="text" ' +
          'value="' + _esc(cur) + '" ' +
          'placeholder="' + _esc(f.placeholder || '') + '" ' +
          'class="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-gray-100 w-full" />';
      }
      return '<label class="grid grid-cols-3 items-center gap-3">' +
        '<span class="text-sm text-gray-300 text-right">' + _esc(f.label) + '</span>' +
        '<span class="col-span-2">' + input + '</span>' +
        '</label>';
    }).join('');

    var modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4';
    modal.innerHTML =
      '<div class="bg-gray-900 border border-gray-700 rounded-lg max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col shadow-2xl">' +
        '<div class="p-4 border-b border-gray-700 flex items-start justify-between gap-3">' +
          '<div>' +
            '<div class="text-indigo-300 font-semibold text-sm flex items-center gap-2">' +
              '✎ ' + _esc(cfg.title) +
            '</div>' +
            (cfg.subtitle ? '<div class="text-xs text-gray-400 mt-1">' + _esc(cfg.subtitle) + '</div>' : '') +
          '</div>' +
          '<button id="pgn-hdr-close" class="text-gray-400 hover:text-gray-100 text-xl leading-none">&times;</button>' +
        '</div>' +
        '<div class="p-4 overflow-y-auto flex-1 flex flex-col gap-3">' +
          rowsHtml +
        '</div>' +
        '<div class="p-3 border-t border-gray-700 flex justify-end gap-2">' +
          '<button id="pgn-hdr-cancel" class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-100">Cancel</button>' +
          '<button id="pgn-hdr-save" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-sm text-white font-medium">Save</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    // Close on backdrop / X / Cancel.
    modal.addEventListener('click', function (e) {
      if (e.target === modal || e.target.id === 'pgn-hdr-close' ||
          e.target.id === 'pgn-hdr-cancel') {
        _close();
      }
    });

    document.getElementById('pgn-hdr-save').addEventListener('click', function () {
      var out = {};
      modal.querySelectorAll('[data-key]').forEach(function (el) {
        out[el.getAttribute('data-key')] = (el.value || '').trim();
      });
      _close();
      if (typeof cfg.onSave === 'function') cfg.onSave(out);
    });
  }

  // ---------------------------------------------------------------------------
  // Single / dual game editor
  // ---------------------------------------------------------------------------
  function openSingle() {
    if (typeof state === 'undefined') return;
    if (!state.pgnHeaders) state.pgnHeaders = {};
    _renderModal({
      title: 'Edit PGN headers',
      subtitle: 'These tags are written into the downloaded PGN. Blank fields use a sensible default.',
      fields: SINGLE_FIELDS,
      values: state.pgnHeaders,
      onSave: function (vals) {
        // Keep only non-empty values so downloadPGN can apply its own defaults.
        var clean = {};
        Object.keys(vals).forEach(function (k) {
          if (vals[k] !== '') clean[k] = vals[k];
        });
        state.pgnHeaders = clean;
        if (typeof log === 'function') log('✎ PGN headers updated');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Batch round/tournament defaults editor
  // ---------------------------------------------------------------------------
  function openBatchDefaults() {
    if (!window._batchHeaderDefaults) window._batchHeaderDefaults = {};
    _renderModal({
      title: 'Edit round PGN header defaults',
      subtitle: 'Fills gaps the tournament file left blank (e.g. Site). Blank = keep the value from the tournament file. Applies to every game on export.',
      fields: BATCH_FIELDS,
      values: window._batchHeaderDefaults,
      onSave: function (vals) {
        var clean = {};
        Object.keys(vals).forEach(function (k) {
          if (vals[k] !== '') clean[k] = vals[k];
        });
        window._batchHeaderDefaults = clean;
        if (typeof log === 'function') {
          var n = Object.keys(clean).length;
          log('✎ Round header defaults updated (' + n + ' field' + (n === 1 ? '' : 's') + ')');
        }
      }
    });
  }

  window.PgnHeaderEditor = {
    openSingle: openSingle,
    openBatchDefaults: openBatchDefaults,
    close: _close
  };
})();
