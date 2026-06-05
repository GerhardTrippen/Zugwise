// grid-debug-panel.js
// ---------------------------------------------------------------------------
// Routes the dual-pipeline "Grid Detection Report" into the MAIN debug console
// (#debug-log — the panel reached by the upper-right "Debug" button) instead of
// a separate floating popup. This file used to build its own fixed-position
// overlay in the bottom-right corner; per product decision the grid report
// belongs in the single debug surface the user already knows, not a second
// window.
//
// Wiring contract (UNCHANGED — callers don't know the panel moved):
//   - batch-ocr-queue.js calls .section()/.line() for the DUAL PIPELINE
//     framing, and flips .capturing = true/false around each per-half OCR call.
//   - opencv_image_processor.js's slideLog forwards every grid-slide line to
//     .line(msg, 'dim') when .capturing is true.
//
// Lines are appended DIRECTLY to #debug-log, bypassing the global log()'s
// verbose 'dim' suppression (ui.js), so the complete grid report is always
// present in the console when the user opens it. Severity is conveyed via text
// colour so the section / warn / good / dim distinctions survive.
(function () {
  'use strict';

  var capturing = false; // toggled by batch-ocr-queue.js around each per-half OCR call

  function sevColor(sev) {
    switch (sev) {
      case 'section': return '#b06bff';
      case 'warn':    return '#ffcf6b';
      case 'err':     return '#ff6b6b';
      case 'good':    return '#7ddf86';
      case 'dim':     return '#8a93a6';
      default:        return '';
    }
  }

  function append(text, sev) {
    var el = (typeof document !== 'undefined') && document.getElementById('debug-log');
    if (!el) { if (typeof console !== 'undefined') console.log(text); return; }
    var div = document.createElement('div');
    div.style.whiteSpace = 'pre-wrap';
    div.style.wordBreak = 'break-word';
    var c = sevColor(sev);
    if (c) div.style.color = c;
    if (sev === 'section') { div.style.fontWeight = 'bold'; div.style.marginTop = '6px'; }
    div.textContent = text;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  var api = {
    // Mirror grid-slide's (msg, severity) logging shape.
    line: function (msg, sev) { append(String(msg), sev || ''); },
    // A bold separator line (config / source / DUAL PIPELINE / --- half ---).
    section: function (title) { append(String(title), 'section'); },
    clear: function () {
      var el = (typeof document !== 'undefined') && document.getElementById('debug-log');
      if (el) el.innerHTML = '';
    },
    // Reveal the main debug console so the report is visible.
    show: function () {
      var c = (typeof document !== 'undefined') && document.getElementById('debug-console');
      if (c) c.classList.remove('hidden');
    },
    hide: function () { /* the main console is user-controlled via the Debug button */ }
  };

  // `capturing` is a plain boolean toggled by batch-ocr-queue.js around each
  // per-half OCR call; opencv_image_processor.js reads it to decide whether to
  // forward grid-slide lines here.
  Object.defineProperty(api, 'capturing', {
    get: function () { return capturing; },
    set: function (v) { capturing = !!v; }
  });

  window.GridDebugPanel = api;
})();
