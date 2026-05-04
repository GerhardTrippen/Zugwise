// =============================================================================
// batch-pdf.js — PDF-to-image conversion wrapper using pdf.js
// =============================================================================
// Converts PDF files (common from phone scanning apps and flatbed scanners)
// to image data that can be fed into the grid detection + OCR pipeline.
//
// Uses pdf.js: https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs
// =============================================================================

var BatchPdf = (function() {
  'use strict';

  var pdfjsLoaded = false;
  var pdfjsLoadPromise = null;

  /**
   * Ensure pdf.js is loaded. Lazy-loads on first use.
   */
  async function ensurePdfJs() {
    if (pdfjsLoaded) return;
    if (pdfjsLoadPromise) return pdfjsLoadPromise;

    pdfjsLoadPromise = new Promise(function(resolve, reject) {
      // Check if already loaded globally
      if (typeof pdfjsLib !== 'undefined') {
        pdfjsLoaded = true;
        resolve();
        return;
      }

      // Load via script tag (ESM import not supported in all contexts)
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs';
      script.type = 'module';

      // Fallback: try the UMD build if module fails
      script.onerror = function() {
        var fallback = document.createElement('script');
        fallback.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.js';
        fallback.onload = function() {
          if (typeof pdfjsLib !== 'undefined') {
            pdfjsLib.GlobalWorkerOptions.workerSrc =
              'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.js';
            pdfjsLoaded = true;
            resolve();
          } else {
            reject(new Error('pdf.js failed to load'));
          }
        };
        fallback.onerror = function() {
          reject(new Error('pdf.js CDN unavailable'));
        };
        document.head.appendChild(fallback);
      };

      // For module script, we need a different approach
      // Use dynamic import instead
      script.onload = function() {
        if (typeof pdfjsLib !== 'undefined') {
          pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';
          pdfjsLoaded = true;
          resolve();
        }
      };

      // Actually use dynamic import for proper ESM loading
      import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs')
        .then(function(module) {
          window.pdfjsLib = module;
          module.GlobalWorkerOptions.workerSrc =
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';
          pdfjsLoaded = true;
          resolve();
        })
        .catch(function() {
          // Try UMD fallback
          var fallback = document.createElement('script');
          fallback.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.js';
          fallback.onload = function() {
            if (typeof pdfjsLib !== 'undefined') {
              pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.js';
              pdfjsLoaded = true;
              resolve();
            } else {
              reject(new Error('pdf.js failed to load'));
            }
          };
          fallback.onerror = function() {
            reject(new Error('pdf.js CDN unavailable'));
          };
          document.head.appendChild(fallback);
        });
    });

    return pdfjsLoadPromise;
  }

  /**
   * Convert a PDF file to image File(s) using pdf.js.
   * Returns one File per page, rendered at high resolution for OCR quality.
   *
   * @param {File} pdfFile - The PDF file
   * @param {number} scale - Render scale (default 2.0 for good OCR quality)
   * @returns {Promise<Array<{pageNum, file, width, height, canvas}>>}
   */
  async function pdfToImages(pdfFile, scale) {
    scale = scale || 2.0;

    await ensurePdfJs();

    var arrayBuffer = await pdfFile.arrayBuffer();
    var pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    var images = [];

    for (var i = 1; i <= pdf.numPages; i++) {
      var page = await pdf.getPage(i);
      var viewport = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      var ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;

      // Convert canvas to File object for the OCR pipeline
      var blob = await new Promise(function(resolve) {
        canvas.toBlob(function(b) { resolve(b); }, 'image/png');
      });
      var fileName = pdfFile.name.replace(/\.pdf$/i, '') + '_page' + i + '.png';
      var file = new File([blob], fileName, { type: 'image/png' });

      images.push({
        pageNum: i,
        file: file,
        width: canvas.width,
        height: canvas.height,
        canvas: canvas
      });
    }

    return images;
  }

  /**
   * Check if a file is a PDF.
   * @param {File} file
   * @returns {boolean}
   */
  function isPDF(file) {
    return /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  }

  /**
   * Check if pdf.js is available.
   * @returns {boolean}
   */
  function isAvailable() {
    return pdfjsLoaded || typeof pdfjsLib !== 'undefined';
  }

  return {
    pdfToImages: pdfToImages,
    isPDF: isPDF,
    isAvailable: isAvailable,
    ensurePdfJs: ensurePdfJs
  };
})();

window.BatchPdf = BatchPdf;
