// =============================================================================
// batch-folder-store.js — Persist the batch scan folder across sessions
// =============================================================================
// Phase 5 of Batch Mode. The File System Access API returns opaque directory
// handles that are IndexedDB-serializable — storing them in IDB lets the user
// reopen the same tournament folder on the next page load without hunting for
// it again. Permissions don't persist across sessions, so `verifyPermission`
// re-requests access on demand (a one-click prompt).
//
// Module API:
//   BatchFolderStore.saveHandle(handle)         -> Promise<void>
//   BatchFolderStore.loadHandle()                -> Promise<handle|null>
//   BatchFolderStore.clearHandle()               -> Promise<void>
//   BatchFolderStore.verifyPermission(handle, mode) -> Promise<boolean>
//   BatchFolderStore.isSupported()               -> boolean
// =============================================================================

var BatchFolderStore = (function() {
  'use strict';

  var DB_NAME = 'zugwise';
  var DB_VERSION = 1;
  var STORE = 'batch-handles';
  var KEY = 'scanFolder';

  function isSupported() {
    return typeof indexedDB !== 'undefined' &&
           typeof window !== 'undefined' &&
           'showDirectoryPicker' in window;
  }

  function _openDb() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function() {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    });
  }

  function _tx(mode) {
    return _openDb().then(function(db) {
      var t = db.transaction(STORE, mode);
      return { db: db, store: t.objectStore(STORE), tx: t };
    });
  }

  async function saveHandle(handle) {
    if (!handle) return;
    var ctx = await _tx('readwrite');
    return new Promise(function(resolve, reject) {
      var req = ctx.store.put(handle, KEY);
      req.onsuccess = function() { resolve(); };
      req.onerror = function() { reject(req.error); };
    });
  }

  async function loadHandle() {
    try {
      var ctx = await _tx('readonly');
      return new Promise(function(resolve) {
        var req = ctx.store.get(KEY);
        req.onsuccess = function() { resolve(req.result || null); };
        req.onerror = function() { resolve(null); };
      });
    } catch (e) {
      return null;
    }
  }

  async function clearHandle() {
    try {
      var ctx = await _tx('readwrite');
      return new Promise(function(resolve) {
        var req = ctx.store.delete(KEY);
        req.onsuccess = function() { resolve(); };
        req.onerror = function() { resolve(); };
      });
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Check and (if needed) request permission for a restored handle. Chromium
   * revokes file-system permissions at the end of each session, so a stored
   * handle always requires a user gesture to re-authorize on the first use.
   *
   * @param {FileSystemHandle} handle
   * @param {'read'|'readwrite'} mode
   * @returns {Promise<boolean>}
   */
  async function verifyPermission(handle, mode) {
    if (!handle || typeof handle.queryPermission !== 'function') return false;
    var opts = { mode: mode || 'read' };
    var state = await handle.queryPermission(opts);
    if (state === 'granted') return true;
    var req = await handle.requestPermission(opts);
    return req === 'granted';
  }

  return {
    saveHandle: saveHandle,
    loadHandle: loadHandle,
    clearHandle: clearHandle,
    verifyPermission: verifyPermission,
    isSupported: isSupported
  };
})();

window.BatchFolderStore = BatchFolderStore;
