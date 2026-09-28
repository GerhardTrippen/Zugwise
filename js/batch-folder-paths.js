/**
 * batch-folder-paths.js
 *
 * Single source of truth for where Zugwise writes its generated artifacts
 * inside the user's scan folder. Keeps the scan-folder root clean (just the
 * original images) by routing every generated file into a `Zugwise/`
 * subtree, grouped by kind:
 *
 *   <scan folder>/
 *     <original images, e.g. Section/Round N/Board N/...>   (untouched)
 *     Zugwise/
 *       PGN/    .pgn, _incomplete.pgn, error .csv
 *       OCR/    .txt, .p1.txt, .p2.txt, .edits.json (structural edit log)
 *       grid/   .grid.json, .p1.grid.json, .p2.grid.json
 *       logits/ .logits.bin — raw per-cell CTC logits (see below)
 *
 * Routing is by filename extension so the ~15 existing call sites need no
 * per-site changes — they keep passing the base scan-folder handle, and the
 * read/write helpers resolve the correct subfolder internally.
 *
 * The logits sidecar carries what the decoded text throws away: the model's
 * full per-timestep distribution. It lets the scorer ask "how likely is this
 * cell to read bxc4?" by CTC alignment (backend/ctc_align.py) instead of
 * comparing strings, which is the only evidence available where char_sim is
 * uninformative. Layout is deliberately trivial so both the browser and numpy
 * can read it without a library:
 *
 *     uint32 LE nCells, uint32 LE seqLen, uint32 LE vocab, then
 *     nCells * seqLen * vocab float16 LE log-probabilities,
 *     cells in the same order as the .txt and .grid.json sidecars.
 *
 * A missing sidecar simply means the signal is unavailable and contributes
 * nothing — the same graceful degradation as a missing .grid.json.
 *
 * Backward compatibility: tournaments processed before this layout existed
 * have their files flat in the scan-folder root. Reads therefore try the
 * Zugwise subfolder first, then fall back to the root, so prior work is
 * never lost (and never needlessly re-OCR'd).
 */
var BatchPaths = (function() {
  'use strict';

  var ROOT_DIR = 'Zugwise';

  /**
   * Map a filename to its Zugwise subfolder by extension.
   * Returns null for filenames with no mapped kind (write to base as-is).
   * @param {string} filename
   * @returns {string|null} - 'PGN' | 'OCR' | 'grid' | 'logits' | null
   */
  function subdirFor(filename) {
    if (/\.logits\.(bin|npz)$/i.test(filename)) return 'logits';
    if (/\.grid\.json$/i.test(filename)) return 'grid';
    // Structural edit log (batch-edit-log.js) lives beside the OCR it edits;
    // .edits.stale.json is the set-aside copy of a log that no longer fits.
    if (/\.edits(\.stale)?\.json$/i.test(filename)) return 'OCR';
    if (/\.txt$/i.test(filename)) return 'OCR';
    if (/\.(pgn|csv)$/i.test(filename)) return 'PGN';
    return null;
  }

  /**
   * Resolve (and optionally create) the Zugwise subfolder handle for a file.
   * @param {FileSystemDirectoryHandle} baseHandle - the scan-folder handle
   * @param {string} filename
   * @param {boolean} create - create the subtree if missing (writes pass true)
   * @returns {Promise<FileSystemDirectoryHandle|null>} the target directory,
   *   the base handle itself when the filename has no mapped subfolder, or
   *   null when create=false and the subfolder does not exist.
   */
  async function resolveDir(baseHandle, filename, create) {
    var sub = subdirFor(filename);
    if (!sub) return baseHandle;
    try {
      var zug = await baseHandle.getDirectoryHandle(ROOT_DIR, { create: create });
      return await zug.getDirectoryHandle(sub, { create: create });
    } catch (e) {
      // create=false and the subfolder doesn't exist yet — signal "not here".
      return null;
    }
  }

  async function _readFrom(dirHandle, filename) {
    try {
      var fh = await dirHandle.getFileHandle(filename);
      var file = await fh.getFile();
      return await file.text();
    } catch (e) {
      return null;
    }
  }

  /**
   * Write a text file into its Zugwise subfolder (creating the subtree).
   * @param {FileSystemDirectoryHandle} baseHandle
   * @param {string} filename
   * @param {string} content
   * @returns {Promise<FileSystemDirectoryHandle>} the directory written to
   */
  async function writeText(baseHandle, filename, content) {
    var dir = (await resolveDir(baseHandle, filename, true)) || baseHandle;
    var fh = await dir.getFileHandle(filename, { create: true });
    var w = await fh.createWritable();
    await w.write(content);
    await w.close();
    return dir;
  }

  /**
   * Read a text file, preferring its Zugwise subfolder and falling back to
   * the flat scan-folder root (pre-subfolder tournaments).
   * @param {FileSystemDirectoryHandle} baseHandle
   * @param {string} filename
   * @returns {Promise<string|null>}
   */
  async function readText(baseHandle, filename) {
    var dir = await resolveDir(baseHandle, filename, false);
    if (dir && dir !== baseHandle) {
      var hit = await _readFrom(dir, filename);
      if (hit !== null) return hit;
    }
    return await _readFrom(baseHandle, filename);
  }

  /**
   * Write binary content (the .logits.bin sidecar) into its Zugwise subfolder.
   * Separate from writeText only because the read side must not decode as
   * UTF-8; the write path itself is identical.
   * @param {FileSystemDirectoryHandle} baseHandle
   * @param {string} filename
   * @param {ArrayBuffer|Uint8Array|Blob} content
   * @returns {Promise<FileSystemDirectoryHandle>} the directory written to
   */
  async function writeBinary(baseHandle, filename, content) {
    var dir = (await resolveDir(baseHandle, filename, true)) || baseHandle;
    var fh = await dir.getFileHandle(filename, { create: true });
    var w = await fh.createWritable();
    await w.write(content);
    await w.close();
    return dir;
  }

  async function _readBinFrom(dirHandle, filename) {
    try {
      var fh = await dirHandle.getFileHandle(filename);
      var file = await fh.getFile();
      return await file.arrayBuffer();
    } catch (e) {
      return null;
    }
  }

  /**
   * Read a binary file, preferring its Zugwise subfolder and falling back to
   * the flat scan-folder root, exactly as readText does.
   * @returns {Promise<ArrayBuffer|null>} null when absent — for the logits
   *          sidecar that simply means the CTC signal is unavailable.
   */
  async function readBinary(baseHandle, filename) {
    var dir = await resolveDir(baseHandle, filename, false);
    if (dir && dir !== baseHandle) {
      var hit = await _readBinFrom(dir, filename);
      if (hit !== null) return hit;
    }
    return await _readBinFrom(baseHandle, filename);
  }

  /**
   * readText plus the file's lastModified (ms), with the same subfolder-first
   * fallback. Used by resume to tell which of two saved records is newer.
   * @returns {Promise<{text:string, lastModified:number}|null>}
   */
  async function readTextWithMeta(baseHandle, filename) {
    async function from(dirHandle) {
      try {
        var fh = await dirHandle.getFileHandle(filename);
        var file = await fh.getFile();
        return { text: await file.text(), lastModified: file.lastModified || 0 };
      } catch (e) { return null; }
    }
    var dir = await resolveDir(baseHandle, filename, false);
    if (dir && dir !== baseHandle) {
      var hit = await from(dir);
      if (hit) return hit;
    }
    return await from(baseHandle);
  }

  return {
    ROOT_DIR: ROOT_DIR,
    subdirFor: subdirFor,
    resolveDir: resolveDir,
    writeText: writeText,
    readText: readText,
    readTextWithMeta: readTextWithMeta,
    writeBinary: writeBinary,
    readBinary: readBinary
  };
})();

window.BatchPaths = BatchPaths;
