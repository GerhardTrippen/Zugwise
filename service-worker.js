// sw.js - Service Worker for Zugwise PWA
// Place this file in your root directory (same level as index.html)

// This is the app's version register: bump it on every shipped change, and
// update the footer in index.html to match (they silently diverged for 18
// versions after v0.8.0).
const CACHE_NAME = 'zugwise-v0.12.7';    // re-copy inserted placeholders after deletes too

// Origins that don't send CORS headers — must use no-cors (gives opaque responses)
const NO_CORS_ORIGINS = ['docs.opencv.org', 'cdn.tailwindcss.com'];

// Origins the service worker must NOT touch. External assets are served
// cache-first, which is right for versioned CDN files and wrong for analytics:
// a cached count.js and, worse, a cached count request would make every repeat
// visit invisible. Letting these through unhandled also means they simply fail
// offline, which is the correct behaviour for a page-view counter.
const NO_CACHE_ORIGINS = ['gc.zgo.at', 'zugwise.goatcounter.com'];

// Generate piece asset paths: 12 sets × 12 pieces = 144 SVGs
const PIECE_SETS = ['maestro','chessnut','california','fresca','cardinal','gioco','tatiana','dubrovny','icpieces','kosal','staunty','rhosgfx'];
const PIECE_FILES = ['wK','wQ','wR','wB','wN','wP','bK','bQ','bR','bB','bN','bP'];
const PIECE_ASSETS = PIECE_SETS.flatMap(s => PIECE_FILES.map(p => `./pieces/${s}/${p}.svg`));

// Files to cache for offline use (relative to frontend/)
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  
  // Icons
  './icons/zugwise-icon.svg',
  './icons/zugwise-icon.png',
  './icons/zugwise-icon-192.png',
  './icons/zugwise-icon-512.png',
  
  // Main JS files (in frontend root)
  './app.js',
  './worker-api.js',
  './ocr-pool.js',
  './ocr-worker.js',
  './zugwise-worker.js',
  './search-worker.js',
  './python-loader.js',
  './search-manager.js',
  './move-prior.js',
  './move-prior-client.js',
  './move-prior-worker.js',
  // The move-prior weights themselves are NOT here: *.onnx is gitignored, so
  // like the BiLSTM they ship from HuggingFace, not the repo. See
  // MOVE_PRIOR_MODEL_URL in move-prior-worker.js.
  './models/move-prior.json',
  './chess-grammar.js',
  './lenient-grammar.js',
  './beam-decoder.js',
  './opencv_image_processor.js',

  // JS modules (in js/ subfolder) — keep in sync with the <script> tags in index.html
  // Grid detection
  './js/grid-geometry.js',
  './js/grid-columns.js',
  './js/grid-rows.js',
  './js/grid-detection.js',
  './js/grid-anchor.js',
  './js/grid-slide.js',
  './js/grid-debug-panel.js',
  './js/grid-unsplit.js',
  './js/g-tail-detection.js',
  // Settings / profiles / utils
  './js/settings.js',
  './js/sheet-profiles.js',
  './js/utils.js',
  // Sheet handling
  './js/batch-pdf.js',
  './js/merge-sheets.js',
  './js/sheet-alignment.js',
  './js/sheet-nw-alignment.js',
  './js/sheets.js',
  './js/board.js',
  './js/navigation.js',
  './js/move-list-sheets.js',
  './js/ui.js',
  './js/fixes.js',
  './js/shift-ops.js',
  './js/ocr.js',
  './js/validation.js',
  './js/beam.js',
  // Batch mode
  './js/batch-naming.js',
  './js/batch-folder-paths.js',
  './js/logits-io.js',
  './js/batch-ocr-queue.js',
  './js/batch-triage.js',
  './js/batch-nw-autoapply.js',
  './js/batch-autoapply-review.js',
  './js/batch-reconstruct-queue.js',
  './js/batch-reconstruct-orchestrator.js',
  './js/batch-panel-bridge.js',
  './js/batch-tournament.js',
  './js/batch-folder-store.js',
  './js/batch-grid-robust.js',
  './js/batch-zip.js',
  './js/batch-export.js',
  './js/verification-ui.js',
  './js/batch-dashboard.js',
  './js/batch-game-list.js',
  './js/batch-edit-log.js',
  './js/pgn-batch.js',
  './js/batch-grid-template.js',
  './js/batch-scoresheet-collect.js',
  './js/pgn-header-editor.js',

  // Python modules (served by dev server at /backend-python/).
  // Keep in sync with PYTHON_MODULES in python-loader.js.
  './backend-python/data_structures.py',
  './backend-python/helpers.py',
  './backend-python/similarity.py',
  './backend-python/chess_quiescence.py',
  './backend-python/absurdity.py',
  './backend-python/play.py',
  './backend-python/constraints.py',
  './backend-python/missing_moves.py',
  './backend-python/lenient_normalize.py',
  './backend-python/logits_io.py',
  './backend-python/ctc_align.py',
  './backend-python/fix_finding.py',
  './backend-python/full_game_search.py',
  './backend-python/dijkstra_search.py',
  './backend-python/validation.py',

  // Vendored Python wheel (installed by search-worker.js via micropip for offline use)
  './vendor/chess-1.10.0-py3-none-any.whl',

  // ONNX model (loaded from HuggingFace, but could cache)
  // 'https://huggingface.co/GerhardTrippen/chess-ocr-bilstm/resolve/main/chess_ocr.onnx',
];

// External dependencies (Pyodide, ONNX Runtime, etc.)
const CDN_ASSETS = [
  // Pyodide v0.26.4 core
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js',
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.asm.wasm',
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.asm.js',
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/python_stdlib.zip',
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide-lock.json',
  
  // micropip (for installing python-chess)
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/micropip-0.6.0-py3-none-any.whl',
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/packaging-24.0-py3-none-any.whl',
  
  // ONNX Runtime Web v1.17.0 (for running the OCR model)
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/ort.min.js',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/ort-wasm.wasm',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/ort-wasm-simd.wasm',
  
  // ONNX model from HuggingFace
  'https://huggingface.co/GerhardTrippen/chess-ocr-bilstm/resolve/main/chess_ocr.onnx',

  // Move-prior weights (~9.6 MB). Cached for offline use like the BiLSTM; a
  // failed fetch here only costs the prior signal, never the app.
  'https://huggingface.co/GerhardTrippen/chess-move-prior/resolve/main/move-prior.onnx',
  
  // OpenCV.js (for image processing, grid detection)
  'https://docs.opencv.org/4.9.0/opencv.js',
  
  // Chess.js
  'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.12.0/chess.min.js',
  
  // Tailwind CSS (if using CDN version)
  'https://cdn.tailwindcss.com',

  // Lazily loaded libraries. These MUST be precached: the runtime cache-first
  // fallback only keeps what was fetched since the last CACHE_NAME bump, and
  // activate deletes the old cache, so a library used once before an update
  // silently stops working offline after it. Found offline in Sept 2026: PDF
  // scans failed with "pdf.js CDN unavailable".
  //   pdf.js 4.x ships ES modules only (batch-pdf.js imports these two).
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs',
  //   SheetJS, for SwissManager .xls/.xlsx pairing files (batch-tournament.js, app.js)
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
];

// Install event - cache all static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching static assets...');
      
      // Cache local assets (these should always succeed)
      const localPromise = cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Some local assets failed to cache:', err);
      });

      // Cache piece SVGs (fail silently if not all downloaded yet)
      const piecePromise = Promise.all(
        PIECE_ASSETS.map(url =>
          cache.add(url).catch(() => {/* piece not downloaded yet — skip silently */})
        )
      );
      
      // Cache CDN assets — use no-cors only for origins that block CORS,
      // normal cors mode for everything else (required for WASM files)
      const cdnPromise = Promise.all(
        CDN_ASSETS.map(url => {
          const needsNoCors = NO_CORS_ORIGINS.some(origin => url.includes(origin));
          const request = needsNoCors ? new Request(url, { mode: 'no-cors' }) : url;
          return fetch(request).then(response => {
            // Never precache an error: cache-first would then serve that 404
            // until the next CACHE_NAME bump (e.g. a model not yet uploaded).
            if (!response.ok && response.type !== 'opaque') {
              throw new Error('HTTP ' + response.status);
            }
            return cache.put(url, response);
          }).catch(err => {
            console.warn(`[SW] Failed to cache ${url}:`, err.message);
          });
        })
      );
      
      return Promise.all([localPromise, cdnPromise, piecePromise]);
    }).then(() => {
      console.log('[SW] Installation complete!');
      // Activate immediately without waiting
      return self.skipWaiting();
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log(`[SW] Deleting old cache: ${name}`);
            return caches.delete(name);
          })
      );
    }).then(() => {
      console.log('[SW] Activation complete!');
      // Take control of all pages immediately
      return self.clients.claim();
    })
  );
});

// Fetch strategy:
//   Local (same-origin) assets: NETWORK-FIRST
//     → Always gets the latest during development
//     → Falls back to cache when offline
//   External (CDN) assets: CACHE-FIRST
//     → These are versioned URLs that never change
//     → Avoids unnecessary CDN round-trips
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Skip analytics entirely — never cached, never served from cache
  if (NO_CACHE_ORIGINS.some(origin => url.hostname === origin)) {
    return;
  }

  if (url.origin === self.location.origin) {
    // LOCAL assets: network-first (always fresh during dev)
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Network failed (offline) — serve from cache
        return caches.match(event.request);
      })
    );
  } else {
    // EXTERNAL/CDN assets: cache-first (versioned, never change)
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then((networkResponse) => {
          // Cache both normal (200) and opaque (no-cors, status 0) responses
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        });
      })
    );
  }
});

// Listen for messages from the main app
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  
  // Force update cache
  if (event.data === 'updateCache') {
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => {
      event.source.postMessage('cacheUpdated');
    });
  }
});
