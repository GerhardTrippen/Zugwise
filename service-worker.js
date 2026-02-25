// sw.js - Service Worker for Zugwise PWA
// Place this file in your root directory (same level as index.html)

const CACHE_NAME = 'zugwise-v0.5';

// Origins that don't send CORS headers — must use no-cors (gives opaque responses)
const NO_CORS_ORIGINS = ['docs.opencv.org', 'cdn.tailwindcss.com'];

// Generate piece asset paths: 12 sets × 12 pieces = 144 SVGs
const PIECE_SETS = ['chessnut','california','maestro','fresca','cardinal','gioco','tatiana','dubrovny','icpieces','kosal','staunty','rhosgfx'];
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
  './zugwise-worker.js',
  './search-worker.js',
  './python-loader.js',
  './search-manager.js',
  './chess-grammar.js',
  './lenient-grammar.js',
  './beam-decoder.js',
  './opencv_image_processor.js',
  
  // JS modules (in js/ subfolder)
  './js/settings.js',
  './js/sheets.js',
  './js/board.js',
  './js/navigation.js',
  './js/ui.js',
  './js/utils.js',
  './js/fixes.js',
  './js/ocr.js',
  './js/validation.js',
  './js/beam.js',
  './js/grid-geometry.js',
  './js/grid-columns.js',
  './js/grid-rows.js',
  './js/grid-detection.js',
  './js/sheet-profiles.js',
  './js/g-tail-detection.js',
  
  // Python modules (served by dev server at /backend-python/)
  './backend-python/data_structures.py',
  './backend-python/helpers.py',
  './backend-python/similarity.py',
  './backend-python/chess_quiescence.py',
  './backend-python/absurdity.py',
  './backend-python/play.py',
  './backend-python/constraints.py',
  './backend-python/missing_moves.py',
  './backend-python/lenient_normalize.py',
  './backend-python/fix_finding.py',
  './backend-python/full_game_search.py',
  './backend-python/validation.py',

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
  
  // OpenCV.js (for image processing, grid detection)
  'https://docs.opencv.org/4.9.0/opencv.js',
  
  // Chess.js
  'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.12.0/chess.min.js',
  
  // Tailwind CSS (if using CDN version)
  'https://cdn.tailwindcss.com',
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
