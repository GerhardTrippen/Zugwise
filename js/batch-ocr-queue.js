// =============================================================================
// batch-ocr-queue.js — Sequential OCR processing queue for batch mode
// =============================================================================
// Phase 1 of Batch Mode. Processes scoresheet images one at a time through
// the existing zugwise-worker.js OCR pipeline. Saves OCR text files and
// grid coordinate sidecar files (.grid.json) for later use.
//
// Dependencies: worker-api.js (window.zugwise), batch-naming.js
// =============================================================================

var BatchOcrQueue = (function() {
  'use strict';

  // =========================================================================
  // OCR Text File Format (matches existing downloadOCRText format)
  // =========================================================================

  /**
   * Format OCR cells into the standard text file format.
   * Format: {moveNumber}.{Color} {topMove} {topConfidence} [{altMove} {altConf} ...]
   *
   * @param {Array} ocrCells - Array of {num, color, move, confidence, alternatives}
   * @returns {string} - Text file contents
   */
  function formatOcrText(ocrCells) {
    var lines = [];
    ocrCells.forEach(function(cell) {
      var line = cell.num + '.' + cell.color.toUpperCase() + ' ' +
                 cell.move + ' ' + parseFloat((cell.confidence || 0.9).toFixed(6));
      if (cell.alternatives && cell.alternatives.length > 0) {
        cell.alternatives.forEach(function(alt) {
          var altMove = alt.move || alt;
          var altConf = alt.confidence || 0.1;
          line += ' ' + altMove + ' ' + parseFloat(altConf.toFixed(6));
        });
      }
      lines.push(line);
    });
    return lines.join('\n');
  }

  /**
   * Parse a Zugwise OCR text file into ocrCells format.
   * @param {string} text - File contents
   * @returns {Array} - Array of {num, color, move, confidence, alternatives}
   */
  function parseOcrTextFile(text) {
    var cells = [];
    text.trim().split('\n').forEach(function(line) {
      line = line.trim();
      if (!line) return;
      var match = line.match(/^(\d+)\.([WB])\s+(.+)$/);
      if (!match) return;
      var num = parseInt(match[1]);
      var color = match[2].toLowerCase();
      var tokens = match[3].split(/\s+/);
      var move = tokens[0];
      var confidence = parseFloat(tokens[1]) || 0.9;
      var alternatives = [];
      for (var i = 2; i < tokens.length; i += 2) {
        if (tokens[i] && tokens[i + 1] !== undefined) {
          alternatives.push({
            move: tokens[i],
            confidence: parseFloat(tokens[i + 1]) || 0.1
          });
        }
      }
      cells.push({
        num: num,
        color: color,
        move: move,
        confidence: confidence,
        alternatives: alternatives
      });
    });
    return cells;
  }

  // =========================================================================
  // Dual-sheet text format with page-count header
  // =========================================================================

  /**
   * Like formatOcrText but prepends a "# pages: N,M,..." comment when the
   * move list spans multiple pages, so the per-page breakdown survives the cache.
   * Single-page output is identical to formatOcrText (no header added).
   */
  function formatOcrTextWithPages(cells, pagesArr) {
    var header = '';
    if (pagesArr && pagesArr.length > 1) {
      var counts = pagesArr.map(function(p) { return (p || []).length; });
      header = '# pages: ' + counts.join(',') + '\n';
    }
    return header + formatOcrText(cells);
  }

  /**
   * Parse a text file written by formatOcrTextWithPages.
   * Returns {cells, pagesArr} where pagesArr is null for single-page files
   * (no header) and an array-of-arrays for multi-page files.
   * The "# pages:" line is skipped by parseOcrTextFile's regex, so cells
   * is always the flat move list regardless of whether a header is present.
   */
  function parseOcrTextWithPages(text) {
    var pagesArr = null;
    var firstLine = (text || '').trim().split('\n')[0];
    var m = firstLine.match(/^#\s*pages:\s*(.+)$/);
    if (m) {
      var counts = m[1].split(',').map(function(s) { return parseInt(s, 10) || 0; });
      if (counts.length > 1) {
        var cells = parseOcrTextFile(text);
        pagesArr = [];
        var offset = 0;
        for (var i = 0; i < counts.length; i++) {
          pagesArr.push(cells.slice(offset, offset + counts[i]));
          offset += counts[i];
        }
        return { cells: cells, pagesArr: pagesArr };
      }
    }
    return { cells: parseOcrTextFile(text), pagesArr: null };
  }

  // =========================================================================
  // Layout-aware cache invalidation
  // =========================================================================
  // A cached OCR result is only valid for the sheet layout it was produced
  // with. If the user switches the active sheet profile (e.g. 2col×20 →
  // 3col×20) and reprocesses, the old .txt would otherwise be served from
  // cache and the new layout silently ignored (the exact bug the user hit
  // with a mixed 2×20 / 3×20 round). We stamp the active profile's layout
  // signature into a "# layout:" header on every .txt and refuse the cache
  // when it no longer matches the active profile.

  /**
   * Signature of the active sheet profile's page layout — "<format><rows>"
   * per page, e.g. "2col20|2col20" or "3col20|3col20". Null when profiles are
   * unavailable (invalidation is then skipped — fail open, keep the cache).
   */
  function currentLayoutSignature() {
    try {
      if (!window.SheetProfiles || !window.SheetProfiles.getActiveProfile) return null;
      var profile = window.SheetProfiles.getActiveProfile();
      if (!profile || !profile.pages || !profile.pages.length) return null;
      return profile.pages.map(function(p) {
        return (p.format || '2col') + String(p.rowCount || 0);
      }).join('|');
    } catch (e) {
      return null;
    }
  }

  /**
   * Prepend a "# layout: <sig>" header to OCR text. Inserted AFTER any
   * leading "# pages:" header so parseOcrTextWithPages (which inspects only
   * the first line) still detects the per-page breakdown. parseOcrTextFile
   * skips all "#" lines, so the parsed cells are unaffected either way.
   */
  function withLayoutHeader(body) {
    var sig = currentLayoutSignature();
    if (!sig) return body;
    if (/^#\s*pages:/.test(body)) {
      var nl = body.indexOf('\n');
      if (nl >= 0) {
        return body.slice(0, nl + 1) + '# layout: ' + sig + '\n' + body.slice(nl + 1);
      }
    }
    return '# layout: ' + sig + '\n' + body;
  }

  /**
   * Extract the "# layout:" signature from cached OCR text, or null if the
   * file predates layout stamping (older caches — treated as still valid).
   */
  function readLayoutHeader(text) {
    if (!text) return null;
    var lines = text.split('\n');
    for (var i = 0; i < lines.length && i < 4; i++) {
      var t = lines[i].trim();
      if (!t) continue;
      var m = t.match(/^#\s*layout:\s*(.+)$/);
      if (m) return m[1].trim();
      if (t.charAt(0) !== '#') break; // reached the first move line
    }
    return null;
  }

  /**
   * Non-destructive layout check. If a cached game's layout stamp differs
   * from the active profile, log a visible note so the user can see which
   * games were OCR'd under a different layout — but NEVER auto-re-OCR.
   *
   * Rationale: the active profile is global, but a round can legitimately mix
   * layouts (some boards 2col×20, others 3col×20). Auto-reprocessing every
   * cached game whose stamp != the current profile would clobber correct work
   * the moment the user switches the profile to handle the *other* games. So
   * the global profile is a DEFAULT for NEW OCR only; redoing a specific
   * mis-layout game is a deliberate per-game action (delete its .txt, or the
   * per-game re-OCR control). Returns the cached layout (or null) for callers
   * that want to surface it.
   */
  function noteLayoutMismatch(text, gameId) {
    var cached = readLayoutHeader(text);
    if (!cached) return null;
    var current = currentLayoutSignature();
    if (!current || cached === current) return cached;
    var msg = '[BatchOCR] ' + gameId + ': cached layout "' + cached +
              '" differs from active profile "' + current +
              '" — keeping cached OCR (delete its .txt to re-OCR at ' + current + ')';
    console.warn(msg);
    if (typeof log === 'function') log(msg);
    return cached;
  }

  /**
   * Build a lookup Map from a loaded grid sidecar so cache-hit paths can
   * attach imageDataUrl/cellBelowImageUrl to parsed .txt cells without any
   * OpenCV re-run.
   * Key format: "page_num_color" (e.g. "0_3_w", "1_3_b").
   * Older sidecars without a page field default to page 0 — unambiguous for
   * single-sheet games where move numbers are globally unique across pages.
   */
  function makeCellImageMap(sidecar) {
    var map = new Map();
    ((sidecar && sidecar.cells) || []).forEach(function(c) {
      if (c.imageDataUrl) {
        map.set((c.page || 0) + '_' + c.num + '_' + (c.color || '').toLowerCase(), {
          imageDataUrl: c.imageDataUrl,
          cellBelowImageUrl: c.cellBelowImageUrl || null
        });
      }
    });
    return map;
  }

  /**
   * Returns true if the sidecar contains page-tagged cells (format >= "1.1").
   * Older sidecars have cells without a page field and must be refreshed for
   * multi-page dual-sheet games to avoid key collisions across pages.
   */
  function hasPageTags(grid) {
    if (!grid || !grid.cells || grid.cells.length === 0) return false;
    return grid.cells[0].page !== undefined;
  }

  // =========================================================================
  // Grid Coordinate Sidecar (.grid.json)
  // =========================================================================

  /**
   * Build a grid coordinate sidecar object from processed cells.
   * @param {Array} processedCells - Cells with bbox data from grid detection
   * @param {string} sourceImage - Source image filename
   * @param {string} gridMethod - Detection method used ('slide', 'anchor', 'contour')
   * @param {number} imageWidth - Original image width
   * @param {number} imageHeight - Original image height
   * @returns {Object} - Grid sidecar data
   */
  function buildGridSidecar(processedCells, sourceImage, gridMethod, imageWidth, imageHeight) {
    var cells = [];
    processedCells.forEach(function(cell) {
      if (cell.bbox) {
        cells.push({
          page: cell._pageIdx !== undefined ? cell._pageIdx : (cell.page !== undefined ? cell.page : 0),
          num: cell.moveNumber || cell.num,
          color: cell.color,
          bbox: {
            x: cell.bbox.x,
            y: cell.bbox.y,
            w: cell.bbox.width || cell.bbox.w,
            h: cell.bbox.height || cell.bbox.h
          },
          imageDataUrl: cell.imageDataUrl || null,
          cellBelowImageUrl: cell.cellBelowImageUrl || null
        });
      }
    });

    return {
      version: '1.0',
      sourceImage: sourceImage || '',
      gridMethod: gridMethod || 'slide',
      layout: currentLayoutSignature(),  // active sheet profile at OCR time
      imageWidth: imageWidth || 0,
      imageHeight: imageHeight || 0,
      cells: cells
    };
  }

  // =========================================================================
  // File I/O helpers (File System Access API + download fallback)
  // =========================================================================

  /**
   * Write a text file to a directory handle (File System Access API).
   * @param {FileSystemDirectoryHandle} dirHandle
   * @param {string} filename
   * @param {string} content
   */
  async function writeTextFile(dirHandle, filename, content) {
    // Route into the Zugwise/<kind> subfolder (BatchPaths). dirHandle is the
    // scan-folder base; the resolver picks PGN/OCR/grid by extension.
    if (window.BatchPaths) {
      await window.BatchPaths.writeText(dirHandle, filename, content);
      return;
    }
    var fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    var writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  /**
   * Read a text file from a directory handle.
   * @param {FileSystemDirectoryHandle} dirHandle
   * @param {string} filename
   * @returns {Promise<string|null>} - File contents or null if not found
   */
  async function readTextFile(dirHandle, filename) {
    // Prefer the Zugwise/<kind> subfolder, fall back to the flat root for
    // tournaments processed before the subfolder layout (BatchPaths.readText).
    if (window.BatchPaths) {
      return await window.BatchPaths.readText(dirHandle, filename);
    }
    try {
      var fileHandle = await dirHandle.getFileHandle(filename);
      var file = await fileHandle.getFile();
      return await file.text();
    } catch (e) {
      return null;
    }
  }

  /**
   * Download a text string as a file (fallback when no directory handle).
   * @param {string} content
   * @param {string} filename
   * @param {string} mimeType
   */
  function downloadAsFile(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // =========================================================================
  // Queue class
  // =========================================================================

  /**
   * @constructor
   * Manages sequential OCR processing of scoresheet images.
   */
  function Queue() {
    this.queue = [];
    this.processing = false;
    this.cancelled = false;
    this.results = {};        // gameId -> {ocrCells, gridSidecar}
    this.outputDirHandle = null;  // File System Access API handle for output
    this.onProgress = null;   // function(gameId, status, detail)
    this.onGameComplete = null;  // function(gameId, result)
    this.onQueueComplete = null; // function(results)
  }

  /**
   * Set the output directory for saving OCR files.
   * @param {FileSystemDirectoryHandle} dirHandle
   */
  Queue.prototype.setOutputDir = function(dirHandle) {
    this.outputDirHandle = dirHandle;
  };

  /**
   * Enqueue games for OCR processing.
   * @param {Map<string, Object>} games - From BatchNaming.groupFilesIntoGames()
   */
  Queue.prototype.enqueueGames = function(games) {
    var self = this;
    // Sort by board number so processing order matches the game list display
    var sorted = [];
    games.forEach(function(game, gameId) {
      sorted.push({ gameId: gameId, game: game });
    });
    sorted.sort(function(a, b) { return (a.game.board || 0) - (b.game.board || 0); });
    sorted.forEach(function(item) {
      self.queue.push({
        gameId: item.gameId,
        game: item.game,
        status: 'queued'
      });
    });
    if (!this.processing) {
      this._processNext();
    }
  };

  /**
   * Cancel processing after current game completes.
   */
  Queue.prototype.cancel = function() {
    this.cancelled = true;
  };

  /**
   * Get current queue status.
   * @returns {Object} - {total, completed, remaining, currentGameId, processing}
   */
  Queue.prototype.getStatus = function() {
    var completed = Object.keys(this.results).length;
    return {
      total: completed + this.queue.length + (this.processing ? 1 : 0),
      completed: completed,
      remaining: this.queue.length,
      currentGameId: this._currentGameId || null,
      processing: this.processing
    };
  };

  /**
   * Process next item in queue.
   */
  Queue.prototype._processNext = async function() {
    if (this.cancelled || this.queue.length === 0) {
      this.processing = false;
      this._currentGameId = null;
      if (this.onQueueComplete) {
        this.onQueueComplete(this.results);
      }
      return;
    }

    this.processing = true;
    var item = this.queue.shift();
    this._currentGameId = item.gameId;

    if (this.onProgress) {
      this.onProgress(item.gameId, 'ocr_running', 'Starting OCR...');
    }

    try {
      var result = await this._processGame(item.game);
      this.results[item.gameId] = result;

      // Save OCR files if output directory is set (skip on cache hits — already on disk)
      if (this.outputDirHandle && !result.fromCache) {
        await this._saveOcrFiles(item.gameId, result);
      }

      if (this.onProgress) {
        var _cellCount = result.isDualSheet
          ? ((result.sheet1 || []).length + (result.sheet2 || []).length)
          : (result.ocrCells || []).length;
        var detail = result.fromCache
          ? _cellCount + ' cells (cached)'
          : _cellCount + ' cells recognized';
        this.onProgress(item.gameId, 'ocr_complete', detail);
      }

      if (this.onGameComplete) {
        this.onGameComplete(item.gameId, result);
      }

    } catch (e) {
      console.error('[BatchOCR] Error processing ' + item.gameId + ':', e);
      if (this.onProgress) {
        this.onProgress(item.gameId, 'ocr_error',
          (e && e.message) ? e.message : String(e));
      }
    }

    // Continue with next
    this._processNext();
  };

  // =========================================================================
  // Dual-sheet detection and splitting
  // =========================================================================

  // detectDualSheet, splitDualSheet, isPDF — shared from utils.js
  // fileToDataUrl — local helper for batch image capture
  function fileToDataUrl(file) {
    return new Promise(function(resolve) {
      var reader = new FileReader();
      reader.onload = function() { resolve(reader.result); };
      reader.onerror = function() { resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  /**
   * Process a single game (all its image files through OCR).
   * @param {Object} game - Game object with files array
   * @returns {Object} - {ocrCells, gridSidecar, method}
   */
  Queue.prototype._processGame = async function(game) {
    if (!window.zugwise || !window.zugwise.isReady) {
      throw new Error('OCR worker not ready');
    }

    // Cache check — skip OCR if sidecars already exist for this game.
    // Dual-sheet: .p1.txt + .p2.txt (sheet per player).
    // Single-sheet: .txt (all moves flat).
    // Image thumbnails (sheet1Image etc.) are NOT cached — too large for disk;
    // _buildSheetSlots handles null images gracefully.
    if (this.outputDirHandle && game.gameId) {
      var _loadGrid = async function(dirHandle, gameId) {
        var gt = await readTextFile(dirHandle, gameId + '.grid.json');
        if (!gt) return null;
        try { return JSON.parse(gt); } catch (e) { return null; }
      };

      // Dual-sheet cache: presence of .p1.txt is the signal
      var cachedP1Text = await readTextFile(this.outputDirHandle, game.gameId + '.p1.txt');
      if (cachedP1Text !== null) {
        var p1parsed = parseOcrTextWithPages(cachedP1Text);
        var cachedSheet1 = p1parsed.cells;
        var cachedSheet1Pages = p1parsed.pagesArr;
        var cachedP2Text = await readTextFile(this.outputDirHandle, game.gameId + '.p2.txt');
        var p2parsed = cachedP2Text && cachedP2Text.trim()
          ? parseOcrTextWithPages(cachedP2Text)
          : { cells: [], pagesArr: null };
        var cachedSheet2 = p2parsed.cells;
        var cachedSheet2Pages = p2parsed.pagesArr;
        console.log('[BatchOCR] Cache hit (dual) for ' + game.gameId +
                    ' — sheet1=' + cachedSheet1.length + ' (' +
                    (cachedSheet1Pages ? cachedSheet1Pages.length + ' pages' : '1 page') +
                    '), sheet2=' + cachedSheet2.length + ', skipping OCR');
        noteLayoutMismatch(cachedP1Text, game.gameId);
        // Restore per-cell images from .p1.grid.json / .p2.grid.json sidecars.
        // Auto-refresh if sidecars predate image storage (one-time grid-only pass).
        var p1GridText = await readTextFile(this.outputDirHandle, game.gameId + '.p1.grid.json');
        var p1Grid = p1GridText ? JSON.parse(p1GridText) : null;
        var p2GridText = await readTextFile(this.outputDirHandle, game.gameId + '.p2.grid.json');
        var p2Grid = p2GridText ? JSON.parse(p2GridText) : null;
        var sheet1ImgMap = makeCellImageMap(p1Grid);
        var sheet2ImgMap = makeCellImageMap(p2Grid);
        // Refresh old sidecars that lack page tags (multi-page games need page_num_color
        // keys to avoid page-N images overwriting page-1 images in the lookup map).
        var _p1Stale = sheet1ImgMap.size === 0 || !hasPageTags(p1Grid);
        var _p2Stale = sheet2ImgMap.size === 0 || !hasPageTags(p2Grid);
        if (_p1Stale || _p2Stale) {
          console.log('[BatchOCR] Old dual sidecars — refreshing images for ' + game.gameId);
          var dualRefreshed = await this._refreshGridSidecar(game, game.gameId);
          if (dualRefreshed.p1Grid && _p1Stale) {
            p1Grid = dualRefreshed.p1Grid; sheet1ImgMap = makeCellImageMap(p1Grid);
          }
          if (dualRefreshed.p2Grid && _p2Stale) {
            p2Grid = dualRefreshed.p2Grid; sheet2ImgMap = makeCellImageMap(p2Grid);
          }
        }
        // Page-aware merge: if we have per-page breakdown, look up by pageIdx_num_color
        // so page-3 cells (same move nums as page-1) get the right images.
        if (cachedSheet1Pages) {
          cachedSheet1Pages.forEach(function(pageArr, pageIdx) {
            (pageArr || []).forEach(function(cell) {
              var img = sheet1ImgMap.get(pageIdx + '_' + cell.num + '_' + (cell.color || '').toLowerCase());
              if (img) { cell.imageDataUrl = img.imageDataUrl; cell.cellBelowImageUrl = img.cellBelowImageUrl; }
            });
          });
        } else {
          cachedSheet1.forEach(function(cell) {
            var img = sheet1ImgMap.get('0_' + cell.num + '_' + (cell.color || '').toLowerCase());
            if (img) { cell.imageDataUrl = img.imageDataUrl; cell.cellBelowImageUrl = img.cellBelowImageUrl; }
          });
        }
        if (cachedSheet2Pages) {
          cachedSheet2Pages.forEach(function(pageArr, pageIdx) {
            (pageArr || []).forEach(function(cell) {
              var img = sheet2ImgMap.get(pageIdx + '_' + cell.num + '_' + (cell.color || '').toLowerCase());
              if (img) { cell.imageDataUrl = img.imageDataUrl; cell.cellBelowImageUrl = img.cellBelowImageUrl; }
            });
          });
        } else {
          cachedSheet2.forEach(function(cell) {
            var img = sheet2ImgMap.get('0_' + cell.num + '_' + (cell.color || '').toLowerCase());
            if (img) { cell.imageDataUrl = img.imageDataUrl; cell.cellBelowImageUrl = img.cellBelowImageUrl; }
          });
        }
        // Load page-level thumbnails for 📄P1.1 / 📄P2.1 links (fast — canvas split only)
        var pageImgs = await this._loadPageImages(game);
        return {
          ocrCells: [],
          sheet1: cachedSheet1,
          sheet2: cachedSheet2,
          sheet1Pages: cachedSheet1Pages,
          sheet2Pages: cachedSheet2Pages,
          sheet1Image: pageImgs.sheet1Image || null,
          sheet2Image: pageImgs.sheet2Image || null,
          sheet1ImagePages: pageImgs.sheet1ImagePages || null,
          sheet2ImagePages: pageImgs.sheet2ImagePages || null,
          isDualSheet: true,
          gridSidecar: p1Grid,
          sheet1Sidecar: p1Grid,
          sheet2Sidecar: p2Grid,
          fromCache: true,
          cachedLayout: readLayoutHeader(cachedP1Text)
        };
      }

      // Single-sheet cache
      var cachedText = await readTextFile(this.outputDirHandle, game.gameId + '.txt');
      if (cachedText && cachedText.trim().length > 0) {
        var cachedCells = parseOcrTextFile(cachedText);
        if (cachedCells.length > 0) {
          console.log('[BatchOCR] Cache hit for ' + game.gameId +
                      ' — ' + cachedCells.length + ' cells, skipping OCR');
          noteLayoutMismatch(cachedText, game.gameId);
          // Restore per-cell images from .grid.json sidecar — no OCR or OpenCV needed.
          // If the sidecar predates image storage, auto-refresh it once (grid detection
          // only, no ONNX) so subsequent hits are instant.
          var cachedGrid = await _loadGrid(this.outputDirHandle, game.gameId);
          var singleImgMap = makeCellImageMap(cachedGrid);
          if (singleImgMap.size === 0) {
            console.log('[BatchOCR] Old sidecar — refreshing images for ' + game.gameId);
            var refreshed = await this._refreshGridSidecar(game, game.gameId);
            if (refreshed.singleGrid) { cachedGrid = refreshed.singleGrid; singleImgMap = makeCellImageMap(cachedGrid); }
          }
          cachedCells.forEach(function(cell) {
            var img = singleImgMap.get('0_' + cell.num + '_' + (cell.color || '').toLowerCase());
            if (img) { cell.imageDataUrl = img.imageDataUrl; cell.cellBelowImageUrl = img.cellBelowImageUrl; }
          });
          return {
            ocrCells: cachedCells,
            gridSidecar: cachedGrid,
            fromCache: true,
            cachedLayout: readLayoutHeader(cachedText)
          };
        }
      }
    }

    // Heavy diagnostic — see exactly what game.files contains, so we
    // can detect duplicates that slipped past batch-naming's dedup
    // (e.g., entries added by a different code path that bypassed
    // groupFilesIntoGames). User has reported the same PDF getting
    // OCR'd multiple times for the same game.
    var _gid = game && game.gameId;
    var _files = (game && game.files) || [];
    console.log('[OCR-PROCESS-GAME] ' + _gid + ' has ' + _files.length +
                ' fileEntry(s):');
    _files.forEach(function(fe, idx) {
      console.log('  [' + idx + '] name=' + (fe && fe.name) +
                  ' path=' + ((fe && fe.path) || '(none)') +
                  ' page=' + ((fe && fe.page) || '(none)') +
                  ' isPDF=' + !!(fe && fe.isPDF));
    });
    // Cross-check for in-place duplicates
    var _seenInPlace = {};
    var _localDupes = 0;
    _files.forEach(function(fe) {
      var k = (fe && fe.name || '').toLowerCase();
      if (k && _seenInPlace[k]) _localDupes++;
      if (k) _seenInPlace[k] = true;
    });
    if (_localDupes > 0) {
      console.warn('[OCR-PROCESS-GAME] ' + _gid + ' has ' + _localDupes +
                   ' duplicate fileEntry(s) by name — the OCR loop will OCR each ' +
                   'duplicate as a separate iteration. Upstream dedup missed these.');
    }

    var allMoves = [];
    var gridSidecar = null;
    var sheet1Sidecar = null;  // dual-sheet left half sidecar (.p1.grid.json)
    var sheet2Sidecar = null;  // dual-sheet right half sidecar (.p2.grid.json)
    // Accumulators for page-tagged cells — all pages for each half are collected
    // here, then buildGridSidecar is called once after the loops so every page's
    // cells carry the correct _pageIdx and the resulting Map keys are unique
    // (page_num_color instead of just num_color).
    var sheet1SidecarCells = [], sheet2SidecarCells = [], singleSidecarCells = [];
    var sheet1SidecarName = '', sheet2SidecarName = '', singleSidecarName = '';
    var sheet1SidecarW = 0, sheet1SidecarH = 0;
    var sheet2SidecarW = 0, sheet2SidecarH = 0;
    var singleSidecarW = 0, singleSidecarH = 0;
    var hasDualSheet = false;
    var dualSheetLeft = [];   // Moves from left half (one player) — flat across pages
    var dualSheetRight = [];  // Moves from right half (other player) — flat across pages
    // Per-page arrays indexed by pageNum-1. Needed for multi-page games so
    // sheets.js::processAllSheets sees one page per sheetsState slot and
    // renumbers correctly — otherwise all pages land in slot[0] with
    // duplicate move numbers across pages.
    var dualSheetLeftPages = [];
    var dualSheetRightPages = [];
    var sheetImages = { left: null, right: null };  // Data URLs for scoresheet viewer — first page only
    // Per-page images indexed by pageIdx (= pageNum - 1). Populated in
    // parallel with dualSheet{Left,Right}Pages so multi-page games get one
    // thumbnail per physical page, which is what ui.js's scoresheet-links
    // renderer needs to show P1.2 / P2.2 links.
    var sheetImagePages = { left: [], right: [] };

    for (var i = 0; i < game.files.length; i++) {
      var fileEntry = game.files[i];

      // Build list of image files to process for this entry
      // PDFs may produce multiple pages; images are single files
      var imageFiles = [];

      if (fileEntry.isPDF || /\.pdf$/i.test(fileEntry.name)) {
        // Convert PDF to image(s) first
        if (!window.BatchPdf) {
          throw new Error('PDF support not loaded (batch-pdf.js). Cannot process ' + fileEntry.name);
        }
        if (this.onProgress) {
          this.onProgress(game.gameId, 'ocr_running',
            'Converting PDF: ' + fileEntry.name);
        }
        var pdfImages = await window.BatchPdf.pdfToImages(fileEntry.file);
        if (pdfImages.length === 0) {
          throw new Error('PDF conversion failed for ' + fileEntry.name);
        }
        // Multi-page games often split one physical page per PDF (e.g.
        // "Undriadi Vs Adhrit P1.pdf" and "...P2.pdf"). Without this the
        // PDF loop resets pageNum to 1 for each file and all pages collapse
        // into slot[0] again. Seed from the filename-derived page number if
        // present, otherwise from the file's position in game.files.
        var pdfBasePageNum = fileEntry.page || (i + 1);
        for (var p = 0; p < pdfImages.length; p++) {
          imageFiles.push({
            file: pdfImages[p].file,
            name: pdfImages[p].file.name,
            pageNum: pdfBasePageNum + p,
            totalPages: pdfImages.length
          });
        }
      } else {
        // fileEntry.page comes from batch-naming's filename-pattern scan
        // ("Page2", "P2", etc.). If the filenames don't include a page
        // marker, fall back to the 1-based index of this file within the
        // game — game.files is ordered by the naming scanner so index
        // reflects page order for typical batch layouts.
        imageFiles.push({
          file: fileEntry.file,
          name: fileEntry.name,
          pageNum: fileEntry.page || (i + 1),
          totalPages: game.files.length
        });
      }

      // Check each image for dual-sheet scans and expand into individual sheets
      var ocrInputs = [];  // Final list of {file, name, pageNum, label} to OCR

      for (var j = 0; j < imageFiles.length; j++) {
        var imgEntry = imageFiles[j];

        // Detect dual-sheet (two scoresheets side-by-side in one scan)
        var dualInfo = await detectDualSheet(imgEntry.file);

        if (dualInfo.isDual) {
          if (this.onProgress) {
            this.onProgress(game.gameId, 'ocr_running',
              'Dual-sheet detected (' + dualInfo.width + 'x' + dualInfo.height +
              ', ratio ' + dualInfo.ratio.toFixed(2) + ') — splitting: ' + imgEntry.name);
          }
          var unsplit = (typeof findUnsplitMidpoint === 'function')
            ? await findUnsplitMidpoint(imgEntry.file, (imgEntry.pageNum || 1) - 1)
            : { midpoint: null, failureReason: null };
          if (unsplit.failureReason) {
            var unsplitMsg = '⚠ Anchor detection: ' + unsplit.failureReason
                + ' — using ink-valley fallback. If results look wrong, try a different Format / Cols × Rows.';
            if (typeof log === 'function') log(unsplitMsg);
            if (typeof showHintBanner === 'function') showHintBanner(unsplitMsg);
          }
          var halves = await splitDualSheet(imgEntry.file, dualInfo.width, dualInfo.height,
            unsplit.midpoint !== null ? { cutX: unsplit.midpoint } : null);
          // Grid Detection Report panel: dual-pipeline framing (mirrors the
          // grid-slide-testbed.html report). Per-half internals + config +
          // summary are emitted in the OCR loop below.
          if (window.GridDebugPanel) {
            window.GridDebugPanel.section('=== source: ' + imgEntry.name + '  '
              + dualInfo.width + 'x' + dualInfo.height + '  [DUAL] ===');
            window.GridDebugPanel.section('=== DUAL PIPELINE (batch-ocr-queue.js) ===');
            if (unsplit.failureReason) {
              window.GridDebugPanel.line('⚠ GridUnsplit: ' + unsplit.failureReason
                + ' — splitDualSheet used ink-valley fallback', 'warn');
            } else {
              window.GridDebugPanel.line('GridUnsplit midpoint=' + Math.round(unsplit.midpoint)
                + (unsplit.inferredLeftColumn ? ' (left col extrapolated)' : ''));
            }
          }
          // inferredLeftColumn: when GridUnsplit extrapolated a clipped
          // leftmost column, per-half detection can't see it — OCR path will
          // use the anchors directly instead of attempting clean per-half first.
          var inferredLeftCol3 = !!unsplit.inferredLeftColumn;
          ocrInputs.push({
            file: halves.left, name: imgEntry.name + ' (left)',
            pageNum: imgEntry.pageNum, label: 'left',
            predefinedAnchorXs: unsplit.leftHalfAnchorXs || null,
            inferredLeftColumn: inferredLeftCol3
          });
          ocrInputs.push({
            file: halves.right, name: imgEntry.name + ' (right)',
            pageNum: imgEntry.pageNum, label: 'right',
            predefinedAnchorXs: unsplit.rightHalfAnchorXs || null,
            inferredLeftColumn: inferredLeftCol3
          });
        } else {
          if (window.GridDebugPanel) {
            window.GridDebugPanel.section('=== source: ' + imgEntry.name + '  '
              + dualInfo.width + 'x' + dualInfo.height + '  [single] ===');
          }
          ocrInputs.push({
            file: imgEntry.file, name: imgEntry.name,
            pageNum: imgEntry.pageNum, label: 'single'
          });
        }
      }

      // Check if this file produced dual-sheet halves
      if (ocrInputs.some(function(inp) { return inp.label === 'left' || inp.label === 'right'; })) {
        hasDualSheet = true;
      }

      // Process each OCR input through the pipeline
      for (var k = 0; k < ocrInputs.length; k++) {
        var ocrInput = ocrInputs[k];

        // Determine grid config based on page number.
        // NB: pass NO overrides to getProfileGridConfig — overrides win over
        // the profile (sheet-profiles.js:454), so a hardcoded {format,rowCount}
        // here would pin every batch game to 2col/20 and silently ignore the
        // selected profile (matches single-game ocr.js usage). pageType is not
        // read by getProfileGridConfig, so re-attach it for grid-slide's
        // back-page handling.
        var pageType = (ocrInput.pageNum === 2) ? 'back' : 'front';
        var gridConfig = { format: '2col', rowCount: 20, pageType: pageType };

        // Use sheet profiles if available — use correct page number
        if (window.SheetProfiles) {
          gridConfig = window.SheetProfiles.getProfileGridConfig(ocrInput.pageNum);
          gridConfig.pageType = pageType;
        }

        // Plumb GridUnsplit-derived per-half anchors through to per-half OCR
        if (ocrInput.predefinedAnchorXs && ocrInput.predefinedAnchorXs.length > 0) {
          gridConfig.predefinedAnchorXs = ocrInput.predefinedAnchorXs;
          gridConfig.inferredLeftColumn = ocrInput.inferredLeftColumn;
        }

        if (this.onProgress) {
          var detail = 'OCR ' + (k + 1) + '/' + ocrInputs.length + ': ' + ocrInput.name;
          this.onProgress(game.gameId, 'ocr_running', detail);
        }

        // Grid Detection Report panel: per-half header + config, then arm
        // capture so opencv_image_processor.js routes the grid-slide internals
        // here for the duration of this OCR call.
        if (window.GridDebugPanel) {
          var _halfLabel = (ocrInput.label === 'left' || ocrInput.label === 'right')
            ? '--- ' + ocrInput.label.toUpperCase() + ' half ---'
            : '--- ' + ocrInput.name + ' ---';
          window.GridDebugPanel.section(_halfLabel);
          window.GridDebugPanel.line('=== config: ' + JSON.stringify(gridConfig) + ' ===', 'dim');
          window.GridDebugPanel.capturing = true;
        }

        // Run OCR through existing pipeline
        try {
          var result = await window.zugwise.processScoresheet(ocrInput.file, function(msg) {
            // Progress callback
          }, gridConfig, null, null, 'slide');

          if (window.GridDebugPanel) {
            window.GridDebugPanel.capturing = false;
            var _nMoves = (result && result.moves) ? result.moves.length : 0;
            window.GridDebugPanel.line('  ' + (ocrInput.label || 'sheet') + ': '
              + _nMoves + ' move-cell(s) OCR\'d'
              + (result && result.error ? '  ⚠ ' + result.error : ''),
              _nMoves > 0 ? 'good' : 'warn');
          }

          if (result.moves && result.moves.length > 0) {
            if (hasDualSheet) {
              // Store halves separately for later merge
              var pageIdx = Math.max(0, (ocrInput.pageNum | 0) - 1);
              if (ocrInput.label === 'left') {
                dualSheetLeft = dualSheetLeft.concat(result.moves);
                if (!dualSheetLeftPages[pageIdx]) dualSheetLeftPages[pageIdx] = [];
                dualSheetLeftPages[pageIdx] = dualSheetLeftPages[pageIdx].concat(result.moves);
                if (!sheetImagePages.left[pageIdx]) {
                  sheetImagePages.left[pageIdx] = await fileToDataUrl(ocrInput.file);
                }
                if (!sheetImages.left) sheetImages.left = sheetImagePages.left[pageIdx];
              } else if (ocrInput.label === 'right') {
                dualSheetRight = dualSheetRight.concat(result.moves);
                if (!dualSheetRightPages[pageIdx]) dualSheetRightPages[pageIdx] = [];
                dualSheetRightPages[pageIdx] = dualSheetRightPages[pageIdx].concat(result.moves);
                if (!sheetImagePages.right[pageIdx]) {
                  sheetImagePages.right[pageIdx] = await fileToDataUrl(ocrInput.file);
                }
                if (!sheetImages.right) sheetImages.right = sheetImagePages.right[pageIdx];
              } else {
                // Non-dual page in a mixed set (e.g. page 2 is single)
                allMoves = allMoves.concat(result.moves);
              }
            } else {
              allMoves = allMoves.concat(result.moves);
            }
          } else if (result.error) {
            console.warn('[BatchOCR] Grid/OCR failed for ' + ocrInput.name + ': ' + result.error);
          }

          // Accumulate page-tagged cells for sidecar (built after all pages loop).
          // Each cell gets _pageIdx so buildGridSidecar can stamp page: N and
          // makeCellImageMap can produce unique page_num_color keys.
          if (result.moves && result.moves.length > 0) {
            var _pi = Math.max(0, (ocrInput.pageNum | 0) - 1);
            var _tagged = result.moves.map(function(m) {
              return Object.assign({}, m, { _pageIdx: _pi });
            });
            if (hasDualSheet) {
              if (ocrInput.label === 'left') {
                sheet1SidecarCells = sheet1SidecarCells.concat(_tagged);
                if (!sheet1SidecarName) { sheet1SidecarName = ocrInput.name; sheet1SidecarW = result.imageWidth || 0; sheet1SidecarH = result.imageHeight || 0; }
              } else if (ocrInput.label === 'right') {
                sheet2SidecarCells = sheet2SidecarCells.concat(_tagged);
                if (!sheet2SidecarName) { sheet2SidecarName = ocrInput.name; sheet2SidecarW = result.imageWidth || 0; sheet2SidecarH = result.imageHeight || 0; }
              }
            } else {
              singleSidecarCells = singleSidecarCells.concat(_tagged);
              if (!singleSidecarName) { singleSidecarName = fileEntry.name; singleSidecarW = result.imageWidth || 0; singleSidecarH = result.imageHeight || 0; }
            }
          }
        } catch (ocrErr) {
          if (window.GridDebugPanel && window.GridDebugPanel.capturing) {
            window.GridDebugPanel.capturing = false;
            window.GridDebugPanel.line('  ' + (ocrInput.label || 'sheet')
              + ': OCR error — ' + (ocrErr && ocrErr.message ? ocrErr.message : ocrErr), 'err');
          }
          console.warn('[BatchOCR] OCR error for ' + ocrInput.name + ':',
                       ocrErr && ocrErr.message ? ocrErr.message : ocrErr);
          // Don't stop the whole game — continue with remaining inputs
        }
      }
    }

    // Build sidecars from page-tagged accumulated cells (all pages, not just first).
    if (sheet1SidecarCells.length > 0)
      sheet1Sidecar = buildGridSidecar(sheet1SidecarCells, sheet1SidecarName, 'slide', sheet1SidecarW, sheet1SidecarH);
    if (sheet2SidecarCells.length > 0)
      sheet2Sidecar = buildGridSidecar(sheet2SidecarCells, sheet2SidecarName, 'slide', sheet2SidecarW, sheet2SidecarH);
    if (singleSidecarCells.length > 0)
      gridSidecar = buildGridSidecar(singleSidecarCells, singleSidecarName, 'slide', singleSidecarW, singleSidecarH);

    // If dual-sheet, return both halves separately for proper merge
    if (hasDualSheet && (dualSheetLeft.length > 0 || dualSheetRight.length > 0)) {
      return {
        ocrCells: allMoves,  // Any non-dual pages (usually empty)
        sheet1: dualSheetLeft,
        sheet2: dualSheetRight,
        // Per-page arrays — sparse if a page failed. batch-game-list uses
        // these to populate sheetsState.player1[p] / player2[p] correctly
        // for multi-page games; consumers of the flat sheet1/sheet2 arrays
        // (difficulty, noise detection, merge) still work.
        sheet1Pages: dualSheetLeftPages,
        sheet2Pages: dualSheetRightPages,
        sheet1Image: sheetImages.left,
        sheet2Image: sheetImages.right,
        sheet1ImagePages: sheetImagePages.left,
        sheet2ImagePages: sheetImagePages.right,
        isDualSheet: true,
        gridSidecar: sheet1Sidecar,   // compat: verification-ui uses this for player1 overlay
        sheet1Sidecar: sheet1Sidecar,
        sheet2Sidecar: sheet2Sidecar
      };
    }

    return {
      ocrCells: allMoves,
      gridSidecar: gridSidecar
    };
  };

  /**
   * Load page-level scoresheet thumbnail images for dual-sheet cache hits.
   * Only runs detectDualSheet + splitDualSheet + fileToDataUrl — no OpenCV
   * grid detection, no ONNX.  Per-cell images come from the .grid.json sidecar.
   * Returns {sheet1Image, sheet2Image, sheet1ImagePages, sheet2ImagePages}.
   */

  /**
   * Rebuild grid sidecars with imageDataUrl by re-running OpenCV grid detection
   * (no ONNX inference) when an existing sidecar is missing image data.
   * Saves the refreshed sidecars to disk and returns them.
   * Returns { singleGrid, p1Grid, p2Grid } — null for any that weren't produced.
   */
  Queue.prototype._refreshGridSidecar = async function(game, gameId) {
    var empty = { singleGrid: null, p1Grid: null, p2Grid: null };
    if (!window.OpenCVImageProcessor || !this.outputDirHandle) return empty;
    try { await window.OpenCVImageProcessor.initOpenCV(); } catch (e) { return empty; }

    var singleCells = [], p1Cells = [], p2Cells = [];
    var singleName = '', p1Name = '', p2Name = '';
    var singleW = 0, singleH = 0, p1W = 0, p1H = 0, p2W = 0, p2H = 0;

    async function gridOnly(file, gridConfig) {
      try {
        var r = await window.OpenCVImageProcessor.processScoresheet(file, gridConfig, null, 'slide');
        var w = (r.grid && r.grid.cols) ? r.grid.cols : 0;
        var h = (r.grid && r.grid.rows) ? r.grid.rows : 0;
        if (r.grid && r.grid.delete) r.grid.delete();
        return { cells: r.gridDetected ? r.cells : [], w: w, h: h };
      } catch (e) { return { cells: [], w: 0, h: 0 }; }
    }

    for (var i = 0; i < game.files.length; i++) {
      var fileEntry = game.files[i];
      var imageFiles = [];
      if (fileEntry.isPDF || /\.pdf$/i.test(fileEntry.name)) {
        if (!window.BatchPdf) continue;
        try {
          var pdfImages = await window.BatchPdf.pdfToImages(fileEntry.file);
          var pdfBase = fileEntry.page || (i + 1);
          for (var p = 0; p < pdfImages.length; p++) {
            imageFiles.push({ file: pdfImages[p].file, pageNum: pdfBase + p, name: fileEntry.name });
          }
        } catch (e) { continue; }
      } else {
        imageFiles.push({ file: fileEntry.file, pageNum: fileEntry.page || (i + 1), name: fileEntry.name });
      }

      for (var j = 0; j < imageFiles.length; j++) {
        var imgEntry = imageFiles[j];
        var pageIdx = Math.max(0, (imgEntry.pageNum | 0) - 1);
        // No overrides — let the active profile drive format/rowCount per page
        // (overrides win over the profile; see the OCR loop above). Re-attach
        // pageType after, since getProfileGridConfig drops it.
        var pageType = imgEntry.pageNum === 2 ? 'back' : 'front';
        var gridConfig = { format: '2col', rowCount: 20, pageType: pageType };
        if (window.SheetProfiles) {
          gridConfig = window.SheetProfiles.getProfileGridConfig(imgEntry.pageNum);
          gridConfig.pageType = pageType;
        }
        try {
          var dualInfo = await detectDualSheet(imgEntry.file);
          if (dualInfo.isDual) {
            var unsplit = (typeof findUnsplitMidpoint === 'function')
              ? await findUnsplitMidpoint(imgEntry.file, pageIdx) : { midpoint: null };
            var halves = await splitDualSheet(imgEntry.file, dualInfo.width, dualInfo.height,
              unsplit.midpoint !== null ? { cutX: unsplit.midpoint } : null);
            var r1 = await gridOnly(halves.left, gridConfig);
            if (r1.cells.length > 0) {
              r1.cells.forEach(function(c) { c._pageIdx = pageIdx; });
              p1Cells = p1Cells.concat(r1.cells); p1Name = imgEntry.name;
              if (!p1W) { p1W = r1.w; p1H = r1.h; }
            }
            var r2 = await gridOnly(halves.right, gridConfig);
            if (r2.cells.length > 0) {
              r2.cells.forEach(function(c) { c._pageIdx = pageIdx; });
              p2Cells = p2Cells.concat(r2.cells); p2Name = imgEntry.name;
              if (!p2W) { p2W = r2.w; p2H = r2.h; }
            }
          } else {
            var rs = await gridOnly(imgEntry.file, gridConfig);
            if (rs.cells.length > 0) {
              rs.cells.forEach(function(c) { c._pageIdx = pageIdx; });
              singleCells = singleCells.concat(rs.cells); singleName = imgEntry.name;
              if (!singleW) { singleW = rs.w; singleH = rs.h; }
            }
          }
        } catch (e) {
          console.warn('[_refreshGridSidecar] page ' + pageIdx + ' failed:', e && e.message);
        }
      }
    }

    var singleGrid = null, p1Grid = null, p2Grid = null;
    if (singleCells.length > 0) {
      singleGrid = buildGridSidecar(singleCells, singleName, 'slide', singleW, singleH);
      if (singleGrid.cells.length > 0)
        await writeTextFile(this.outputDirHandle, gameId + '.grid.json', JSON.stringify(singleGrid, null, 2));
    }
    if (p1Cells.length > 0) {
      p1Grid = buildGridSidecar(p1Cells, p1Name, 'slide', p1W, p1H);
      if (p1Grid.cells.length > 0)
        await writeTextFile(this.outputDirHandle, gameId + '.p1.grid.json', JSON.stringify(p1Grid, null, 2));
    }
    if (p2Cells.length > 0) {
      p2Grid = buildGridSidecar(p2Cells, p2Name, 'slide', p2W, p2H);
      if (p2Grid.cells.length > 0)
        await writeTextFile(this.outputDirHandle, gameId + '.p2.grid.json', JSON.stringify(p2Grid, null, 2));
    }
    console.log('[BatchOCR] Sidecar refreshed for ' + gameId +
      ': single=' + (singleGrid ? singleGrid.cells.length : 0) +
      ' p1=' + (p1Grid ? p1Grid.cells.length : 0) +
      ' p2=' + (p2Grid ? p2Grid.cells.length : 0) + ' cells');
    return { singleGrid: singleGrid, p1Grid: p1Grid, p2Grid: p2Grid };
  };

  Queue.prototype._loadPageImages = async function(game) {
    var sheetImages = { left: null, right: null };
    var sheetImagePages = { left: [], right: [] };

    for (var i = 0; i < game.files.length; i++) {
      var fileEntry = game.files[i];
      var imageFiles = [];

      if (fileEntry.isPDF || /\.pdf$/i.test(fileEntry.name)) {
        if (!window.BatchPdf) continue;
        try {
          var pdfImages = await window.BatchPdf.pdfToImages(fileEntry.file);
          var pdfBase = fileEntry.page || (i + 1);
          for (var p = 0; p < pdfImages.length; p++) {
            imageFiles.push({ file: pdfImages[p].file, pageNum: pdfBase + p });
          }
        } catch (e) { continue; }
      } else {
        imageFiles.push({ file: fileEntry.file, pageNum: fileEntry.page || (i + 1) });
      }

      for (var j = 0; j < imageFiles.length; j++) {
        var imgEntry = imageFiles[j];
        var pageIdx = Math.max(0, (imgEntry.pageNum | 0) - 1);
        try {
          var dualInfo = await detectDualSheet(imgEntry.file);
          if (!dualInfo.isDual) continue;
          var unsplit = (typeof findUnsplitMidpoint === 'function')
            ? await findUnsplitMidpoint(imgEntry.file, pageIdx)
            : { midpoint: null };
          var halves = await splitDualSheet(
            imgEntry.file, dualInfo.width, dualInfo.height,
            unsplit.midpoint !== null ? { cutX: unsplit.midpoint } : null
          );
          if (!sheetImagePages.left[pageIdx]) {
            sheetImagePages.left[pageIdx] = await fileToDataUrl(halves.left);
          }
          if (!sheetImagePages.right[pageIdx]) {
            sheetImagePages.right[pageIdx] = await fileToDataUrl(halves.right);
          }
          if (!sheetImages.left) sheetImages.left = sheetImagePages.left[pageIdx];
          if (!sheetImages.right) sheetImages.right = sheetImagePages.right[pageIdx];
        } catch (e) {
          console.warn('[_loadPageImages] page ' + pageIdx + ' failed:', e && e.message);
        }
      }
    }

    return {
      sheet1Image: sheetImages.left,
      sheet2Image: sheetImages.right,
      sheet1ImagePages: sheetImagePages.left,
      sheet2ImagePages: sheetImagePages.right
    };
  };

  /**
   * Save OCR text and grid sidecar files for a game.
   * @param {string} gameId
   * @param {Object} result - {ocrCells, gridSidecar}
   */
  Queue.prototype._saveOcrFiles = async function(gameId, result) {
    if (!this.outputDirHandle) return;

    try {
      if (result.isDualSheet) {
        // Dual-sheet: save each player's flat move list separately.
        // .p1.txt presence is the cache signal on reload, so always write it
        // (even if sheet1 is empty) so the cache check correctly identifies
        // this as a dual-sheet game rather than falling through to re-run OCR.
        await writeTextFile(this.outputDirHandle, gameId + '.p1.txt',
          withLayoutHeader(formatOcrTextWithPages(result.sheet1 || [], result.sheet1Pages)));
        if (result.sheet2 && result.sheet2.length > 0) {
          await writeTextFile(this.outputDirHandle, gameId + '.p2.txt',
            withLayoutHeader(formatOcrTextWithPages(result.sheet2, result.sheet2Pages)));
        }
      } else {
        // Single-sheet: skip if empty (empty file is indistinguishable from
        // "not yet processed").
        if (result.ocrCells && result.ocrCells.length > 0) {
          await writeTextFile(this.outputDirHandle, gameId + '.txt',
            withLayoutHeader(formatOcrText(result.ocrCells)));
        }
      }

      // Save grid sidecars only when cells are populated.
      if (result.isDualSheet) {
        if (result.sheet1Sidecar && result.sheet1Sidecar.cells.length > 0) {
          await writeTextFile(this.outputDirHandle, gameId + '.p1.grid.json',
            JSON.stringify(result.sheet1Sidecar, null, 2));
        }
        if (result.sheet2Sidecar && result.sheet2Sidecar.cells.length > 0) {
          await writeTextFile(this.outputDirHandle, gameId + '.p2.grid.json',
            JSON.stringify(result.sheet2Sidecar, null, 2));
        }
      } else if (result.gridSidecar && result.gridSidecar.cells.length > 0) {
        await writeTextFile(this.outputDirHandle, gameId + '.grid.json',
          JSON.stringify(result.gridSidecar, null, 2));
      }
    } catch (e) {
      console.warn('[BatchOCR] Failed to save files for ' + gameId + ':', e);
    }
  };

  // =========================================================================
  // Static helpers for loading saved OCR data
  // =========================================================================

  /**
   * Load OCR results from a text file.
   * @param {File} file - The .txt file
   * @returns {Promise<Array>} - Parsed ocrCells
   */
  async function loadOcrFromFile(file) {
    var text = await file.text();
    return parseOcrTextFile(text);
  }

  /**
   * Load grid sidecar from a JSON file.
   * @param {File} file - The .grid.json file
   * @returns {Promise<Object>} - Parsed grid sidecar
   */
  async function loadGridFromFile(file) {
    var text = await file.text();
    return JSON.parse(text);
  }

  /**
   * Load pre-saved OCR results for a game from a directory.
   * @param {FileSystemDirectoryHandle} dirHandle
   * @param {string} gameId
   * @returns {Promise<{ocrCells: Array, gridSidecar: Object}|null>}
   */
  async function loadSavedOcr(dirHandle, gameId) {
    var ocrText = await readTextFile(dirHandle, gameId + '.txt');
    if (!ocrText) return null;

    var ocrCells = parseOcrTextFile(ocrText);
    var gridText = await readTextFile(dirHandle, gameId + '.grid.json');
    var gridSidecar = gridText ? JSON.parse(gridText) : null;

    return {
      ocrCells: ocrCells,
      gridSidecar: gridSidecar
    };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    Queue: Queue,
    formatOcrText: formatOcrText,
    parseOcrTextFile: parseOcrTextFile,
    buildGridSidecar: buildGridSidecar,
    loadOcrFromFile: loadOcrFromFile,
    loadGridFromFile: loadGridFromFile,
    loadSavedOcr: loadSavedOcr,
    downloadAsFile: downloadAsFile,
    currentLayoutSignature: currentLayoutSignature
  };
})();

// Expose globally
window.BatchOcrQueue = BatchOcrQueue;
