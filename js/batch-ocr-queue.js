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
          num: cell.moveNumber || cell.num,
          color: cell.color,
          bbox: {
            x: cell.bbox.x,
            y: cell.bbox.y,
            w: cell.bbox.width || cell.bbox.w,
            h: cell.bbox.height || cell.bbox.h
          }
        });
      }
    });

    return {
      version: '1.0',
      sourceImage: sourceImage || '',
      gridMethod: gridMethod || 'slide',
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

      // Save OCR files if output directory is set
      if (this.outputDirHandle) {
        await this._saveOcrFiles(item.gameId, result);
      }

      if (this.onProgress) {
        this.onProgress(item.gameId, 'ocr_complete',
          result.ocrCells.length + ' cells recognized');
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

    var allMoves = [];
    var gridSidecar = null;
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
          var halves = await splitDualSheet(imgEntry.file, dualInfo.width, dualInfo.height);
          ocrInputs.push({
            file: halves.left, name: imgEntry.name + ' (left)',
            pageNum: imgEntry.pageNum, label: 'left'
          });
          ocrInputs.push({
            file: halves.right, name: imgEntry.name + ' (right)',
            pageNum: imgEntry.pageNum, label: 'right'
          });
        } else {
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

        // Determine grid config based on page number
        var gridConfig = {
          format: '2col',
          rowCount: 20,
          pageType: (ocrInput.pageNum === 2) ? 'back' : 'front'
        };

        // Use sheet profiles if available — use correct page number
        if (window.SheetProfiles) {
          gridConfig = window.SheetProfiles.getProfileGridConfig(ocrInput.pageNum, gridConfig);
        }

        if (this.onProgress) {
          var detail = 'OCR ' + (k + 1) + '/' + ocrInputs.length + ': ' + ocrInput.name;
          this.onProgress(game.gameId, 'ocr_running', detail);
        }

        // Run OCR through existing pipeline
        try {
          var result = await window.zugwise.processScoresheet(ocrInput.file, function(msg) {
            // Progress callback
          }, gridConfig, null, null, 'slide');

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

          // Build grid sidecar from first successful detection
          if (!gridSidecar && result.moves && result.moves.length > 0) {
            gridSidecar = buildGridSidecar(
              result.moves,
              fileEntry.name,
              'slide',
              0, 0
            );
          }
        } catch (ocrErr) {
          console.warn('[BatchOCR] OCR error for ' + ocrInput.name + ':',
                       ocrErr && ocrErr.message ? ocrErr.message : ocrErr);
          // Don't stop the whole game — continue with remaining inputs
        }
      }
    }

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
        gridSidecar: gridSidecar
      };
    }

    return {
      ocrCells: allMoves,
      gridSidecar: gridSidecar
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
      // Save OCR text file
      var ocrText = formatOcrText(result.ocrCells);
      await writeTextFile(this.outputDirHandle, gameId + '.txt', ocrText);

      // Save grid sidecar
      if (result.gridSidecar) {
        var gridJson = JSON.stringify(result.gridSidecar, null, 2);
        await writeTextFile(this.outputDirHandle, gameId + '.grid.json', gridJson);
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
    downloadAsFile: downloadAsFile
  };
})();

// Expose globally
window.BatchOcrQueue = BatchOcrQueue;
