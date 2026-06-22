// =============================================================================
// batch-grid-template.js — Per-round geometric grid template (auto-consensus)
// =============================================================================
// Batch processing runs the SAME physical scoresheet form over and over. Each
// image, though, is grid-detected from scratch by the worker (grid-slide). A
// sheet whose printed grid is obscured — a signature crossing the table, move
// numbers scribbled over — can defeat slide detection and yield almost no
// cells, even though the column geometry is identical to every other sheet in
// the round.
//
// This module learns that shared geometry from the sheets that DO detect
// cleanly (auto-consensus), then offers it back as a FALLBACK PRIOR for the
// sheets that fail. It is geometry only — it answers "where are the columns?",
// never "what is written?". It does not evaluate OCR content.
//
// How it plugs in (see batch-ocr-queue.js):
//   - contribute(sidecar):           fold a clean detection into the consensus
//   - toPredefinedAnchorXs(...):      column X positions for a failing image,
//                                     fed back through the proven
//                                     `gridConfig.predefinedAnchorXs` path
//
// Why columns only: `predefinedAnchorXs` is the single injection point that
// already reaches grid-slide, and it consumes column-content centroid X
// positions — exactly what clustered sidecar cell-centers produce. Row
// positions are learned and persisted too (for diagnostics / future use) but
// are not injectable through today's worker path. grid-slide's override keeps
// its auto-detected columns if a supplied position doesn't gather enough
// connected components, so an imperfect template can never DEGRADE detection —
// at worst it is ignored.
//
// Keyed by (layout signature, aspect-ratio bucket). The aspect bucket keeps a
// full single sheet and a dual-sheet half — same logical layout, very
// different page geometry — in separate consensuses.
//
// Module API (window.BatchGridTemplate):
//   contribute(sidecar, [sig])              -> void
//   get(sig, aspect)                        -> {colXFracs, nCols, sampleCount} | null
//   toPredefinedAnchorXs(sig, aspect, w)    -> number[] | null
//   ensureLoaded(sig, aspect)               -> Promise<void>   (lazy disk seed)
//   setPersistDir(baseHandle)               -> void
//   reset()                                 -> void            (new tournament)
//
// Dependencies (all optional / best-effort): window.BatchPaths for persistence.
// =============================================================================

var BatchGridTemplate = (function() {
  'use strict';

  // Samples needed before a consensus is offered. Below this, a single noisy
  // detection could mislead the fallback — wait for agreement.
  var MIN_SAMPLES = 3;
  // Cap retained samples per key; median over the most recent N is plenty and
  // bounds memory / disk. Oldest are dropped.
  var MAX_SAMPLES = 15;
  // Cell-center X values within this fraction of width collapse into one column.
  var COL_CLUSTER_FRAC = 0.025;
  // Same, vertical, for row learning (diagnostics only).
  var ROW_CLUSTER_FRAC = 0.012;
  // A column/row cluster needs at least this many cells to count as real
  // (mirrors grid-slide's ">3 CCs per column" requirement).
  var MIN_CLUSTER_CELLS = 4;
  // Aspect-ratio (w/h) bucket granularity.
  var ASPECT_BUCKET = 0.1;

  // key -> { samples: [ {colXFracs, rowYFracs, w, h} ], dirty }
  var _store = {};
  // base scan-folder handle for persistence (optional)
  var _persistDir = null;
  // keys whose disk file we've already tried to load (avoid repeat reads)
  var _loadAttempted = {};

  // =========================================================================
  // small numeric helpers
  // =========================================================================

  function _median(arr) {
    if (!arr.length) return NaN;
    var s = arr.slice().sort(function(a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Cluster sorted fractions by gap; return per-cluster {pos: median, n: count}
  // for clusters with at least MIN_CLUSTER_CELLS members.
  function _cluster(fracs, tol) {
    if (!fracs.length) return [];
    var sorted = fracs.slice().sort(function(a, b) { return a - b; });
    var groups = [[sorted[0]]];
    for (var i = 1; i < sorted.length; i++) {
      var last = groups[groups.length - 1];
      if (sorted[i] - last[last.length - 1] <= tol) last.push(sorted[i]);
      else groups.push([sorted[i]]);
    }
    var out = [];
    groups.forEach(function(g) {
      if (g.length >= MIN_CLUSTER_CELLS) out.push({ pos: _median(g), n: g.length });
    });
    return out;
  }

  function _aspectBucket(aspect) {
    if (!isFinite(aspect) || aspect <= 0) return 0;
    return Math.round(aspect / ASPECT_BUCKET);
  }

  function _safe(s) { return String(s || 'unknown').replace(/[^a-z0-9]+/gi, '_'); }

  function _key(sig, aspect) {
    return _safe(sig) + '@a' + _aspectBucket(aspect);
  }

  function _fileName(sig, aspect) {
    // Ends in .grid.json so BatchPaths routes it into Zugwise/grid/.
    return '_gridtemplate_' + _safe(sig) + '_a' + _aspectBucket(aspect) + '.grid.json';
  }

  // =========================================================================
  // extract normalized column/row geometry from a grid sidecar
  // =========================================================================

  // Returns { colXFracs:[...], rowYFracs:[...], w, h } or null if the sidecar
  // isn't a usable, well-populated grid (a near-failed detection contributes
  // nothing — that's the whole point).
  function _geometryFromSidecar(sidecar) {
    if (!sidecar || !sidecar.cells || !sidecar.cells.length) return null;
    var w = sidecar.imageWidth, h = sidecar.imageHeight;
    if (!w || !h) return null;

    var xfr = [], yfr = [];
    sidecar.cells.forEach(function(c) {
      var b = c && c.bbox;
      if (!b || typeof b.x !== 'number') return;
      var cw = (typeof b.w === 'number') ? b.w : 0;
      var ch = (typeof b.h === 'number') ? b.h : 0;
      var fx = (b.x + cw / 2) / w;
      var fy = (b.y + ch / 2) / h;
      if (isFinite(fx)) xfr.push(fx);
      if (isFinite(fy)) yfr.push(fy);
    });

    var cols = _cluster(xfr, COL_CLUSTER_FRAC);
    var rows = _cluster(yfr, ROW_CLUSTER_FRAC);
    // Need a real multi-column grid to be worth learning from.
    if (cols.length < 2) return null;

    return {
      colXFracs: cols.map(function(c) { return c.pos; }),
      rowYFracs: rows.map(function(r) { return r.pos; }),
      w: w,
      h: h
    };
  }

  // =========================================================================
  // consensus
  // =========================================================================

  // Build the consensus columns for a key: take the modal column count across
  // samples (robust to the odd partial detection), keep only samples with that
  // count, and median each column position index-wise.
  function _consensus(key) {
    var entry = _store[key];
    if (!entry || entry.samples.length < MIN_SAMPLES) return null;

    var counts = {};
    entry.samples.forEach(function(s) {
      var n = s.colXFracs.length;
      counts[n] = (counts[n] || 0) + 1;
    });
    var canon = Object.keys(counts).sort(function(a, b) {
      return counts[b] - counts[a] || (+a) - (+b);
    })[0];
    canon = +canon;
    if (!canon || canon < 2) return null;

    var used = entry.samples.filter(function(s) { return s.colXFracs.length === canon; });
    if (used.length < MIN_SAMPLES) return null;

    var colXFracs = [];
    for (var i = 0; i < canon; i++) {
      colXFracs.push(_median(used.map(function(s) { return s.colXFracs[i]; })));
    }
    return { colXFracs: colXFracs, nCols: canon, sampleCount: used.length };
  }

  // =========================================================================
  // public: contribute / get / apply
  // =========================================================================

  function contribute(sidecar, sig) {
    try {
      var geom = _geometryFromSidecar(sidecar);
      if (!geom) return;
      var useSig = sig || (sidecar && sidecar.layout) || null;
      var aspect = geom.w / geom.h;
      var key = _key(useSig, aspect);

      if (!_store[key]) _store[key] = { sig: useSig, aspect: aspect, samples: [] };
      var entry = _store[key];
      entry.samples.push({
        colXFracs: geom.colXFracs,
        rowYFracs: geom.rowYFracs,
        w: geom.w,
        h: geom.h
      });
      if (entry.samples.length > MAX_SAMPLES) {
        entry.samples = entry.samples.slice(entry.samples.length - MAX_SAMPLES);
      }
      _persist(key);  // best-effort, async, fire-and-forget
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[GridTemplate] contribute failed:', e && e.message);
    }
  }

  function get(sig, aspect) {
    return _consensus(_key(sig, aspect));
  }

  // Column X positions in the pixel coords of an image `imageWidth` wide.
  function toPredefinedAnchorXs(sig, aspect, imageWidth) {
    var c = _consensus(_key(sig, aspect));
    if (!c || !imageWidth) return null;
    return c.colXFracs.map(function(f) { return f * imageWidth; });
  }

  // =========================================================================
  // persistence (best-effort, via BatchPaths -> Zugwise/grid/)
  // =========================================================================

  function setPersistDir(baseHandle) {
    _persistDir = baseHandle || null;
  }

  async function _persist(key) {
    if (!_persistDir || !window.BatchPaths) return;
    var entry = _store[key];
    if (!entry) return;
    try {
      var body = JSON.stringify({
        version: '1.0',
        sig: entry.sig,
        aspect: entry.aspect,
        samples: entry.samples
      });
      await window.BatchPaths.writeText(_persistDir, _fileName(entry.sig, entry.aspect), body);
    } catch (e) {
      // Disk persistence is a convenience for paused/resumed rounds; never fatal.
    }
  }

  // Lazily seed a key's samples from disk the first time it's needed, so a
  // resumed round inherits the template learned before the pause.
  async function ensureLoaded(sig, aspect) {
    var key = _key(sig, aspect);
    if (_store[key] || _loadAttempted[key] || !_persistDir || !window.BatchPaths) return;
    _loadAttempted[key] = true;
    try {
      var text = await window.BatchPaths.readText(_persistDir, _fileName(sig, aspect));
      if (!text) return;
      var data = JSON.parse(text);
      if (data && Array.isArray(data.samples) && data.samples.length) {
        _store[key] = { sig: sig, aspect: aspect, samples: data.samples.slice(-MAX_SAMPLES) };
      }
    } catch (e) {
      // missing / unparseable file — start fresh
    }
  }

  function reset() {
    _store = {};
    _loadAttempted = {};
  }

  return {
    contribute: contribute,
    get: get,
    toPredefinedAnchorXs: toPredefinedAnchorXs,
    ensureLoaded: ensureLoaded,
    setPersistDir: setPersistDir,
    reset: reset,
    // tunables exposed for inspection / tests
    MIN_SAMPLES: MIN_SAMPLES
  };
})();

if (typeof window !== 'undefined') {
  window.BatchGridTemplate = BatchGridTemplate;
}
