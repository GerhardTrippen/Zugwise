// =============================================================================
// batch-zip.js — Minimal store-mode ZIP writer (no dependencies)
// =============================================================================
// Phase 5 of Batch Mode. When the File System Access API is unavailable (or
// the user hasn't picked a folder), we fall back to bundling multiple output
// files into a single ZIP download. Compression would pull in a ~30KB deflate
// library; PGN text is small and compresses inline in transit (gzip over
// HTTP), so we use STORE (method 0 — no compression) and keep this module
// under 200 lines.
//
// Only standard ZIP fields are written — no ZIP64, no encryption, no
// multi-disk. Max archive size ~4GB (fine for a round of PGNs + a CSV).
//
// Module API:
//   BatchZip.create()                      -> writer
//   writer.addText(name, contents)         // UTF-8 text entry
//   writer.addBytes(name, uint8array)      // binary entry
//   writer.build()                         -> Blob ('application/zip')
//   BatchZip.download(files, filename)     // one-shot: [{name, content}]
// =============================================================================

var BatchZip = (function() {
  'use strict';

  // Precompute CRC-32 table once.
  var CRC_TABLE = (function() {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str);
    }
    // Fallback (older browsers).
    var utf8 = unescape(encodeURIComponent(str));
    var arr = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) arr[i] = utf8.charCodeAt(i) & 0xFF;
    return arr;
  }

  // Convert a JS Date to DOS date/time (used in local + central headers).
  function dosDateTime(d) {
    d = d || new Date();
    var dosTime = ((d.getHours() & 0x1F) << 11) |
                  ((d.getMinutes() & 0x3F) << 5)  |
                  ((d.getSeconds() >>> 1) & 0x1F);
    var dosDate = (((d.getFullYear() - 1980) & 0x7F) << 9) |
                  (((d.getMonth() + 1) & 0x0F) << 5) |
                  (d.getDate() & 0x1F);
    return { time: dosTime, date: dosDate };
  }

  function create() {
    var entries = [];

    function addBytes(name, bytes) {
      if (!(bytes instanceof Uint8Array)) {
        throw new Error('addBytes expects a Uint8Array');
      }
      entries.push({
        name: name,
        nameBytes: utf8Bytes(name),
        data: bytes,
        crc: crc32(bytes),
        size: bytes.length
      });
    }

    function addText(name, text) {
      addBytes(name, utf8Bytes(text));
    }

    function build() {
      var dt = dosDateTime();
      var chunks = [];
      var offset = 0;
      var centralChunks = [];

      entries.forEach(function(e) {
        var localHeader = new Uint8Array(30 + e.nameBytes.length);
        var dv = new DataView(localHeader.buffer);
        // Local file header signature
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);           // version needed (2.0)
        dv.setUint16(6, 0, true);            // general purpose bit flag
        dv.setUint16(8, 0, true);            // compression method: 0 (store)
        dv.setUint16(10, dt.time, true);
        dv.setUint16(12, dt.date, true);
        dv.setUint32(14, e.crc, true);
        dv.setUint32(18, e.size, true);      // compressed size == uncompressed
        dv.setUint32(22, e.size, true);
        dv.setUint16(26, e.nameBytes.length, true);
        dv.setUint16(28, 0, true);           // extra field length
        localHeader.set(e.nameBytes, 30);

        chunks.push(localHeader);
        chunks.push(e.data);

        var localOffset = offset;
        offset += localHeader.length + e.data.length;

        // Central directory entry
        var central = new Uint8Array(46 + e.nameBytes.length);
        var cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);   // central dir signature
        cv.setUint16(4, 20, true);           // version made by
        cv.setUint16(6, 20, true);           // version needed
        cv.setUint16(8, 0, true);            // gp flag
        cv.setUint16(10, 0, true);           // method
        cv.setUint16(12, dt.time, true);
        cv.setUint16(14, dt.date, true);
        cv.setUint32(16, e.crc, true);
        cv.setUint32(20, e.size, true);
        cv.setUint32(24, e.size, true);
        cv.setUint16(28, e.nameBytes.length, true);
        cv.setUint16(30, 0, true);           // extra
        cv.setUint16(32, 0, true);           // comment
        cv.setUint16(34, 0, true);           // disk start
        cv.setUint16(36, 0, true);           // internal attrs
        cv.setUint32(38, 0, true);           // external attrs
        cv.setUint32(42, localOffset, true);
        central.set(e.nameBytes, 46);
        centralChunks.push(central);
      });

      var centralStart = offset;
      var centralSize = 0;
      centralChunks.forEach(function(c) { centralSize += c.length; });

      // End of central directory record
      var eocd = new Uint8Array(22);
      var ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(4, 0, true);              // disk number
      ev.setUint16(6, 0, true);              // disk with central dir
      ev.setUint16(8, entries.length, true); // entries on this disk
      ev.setUint16(10, entries.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, centralStart, true);
      ev.setUint16(20, 0, true);             // comment length

      return new Blob(chunks.concat(centralChunks).concat([eocd]),
                      { type: 'application/zip' });
    }

    return {
      addText: addText,
      addBytes: addBytes,
      build: build,
      entries: entries
    };
  }

  /**
   * One-shot helper: bundle an array of {name, content} entries into a ZIP
   * and trigger a browser download.
   * @param {Array<{name:string, content:string|Uint8Array}>} files
   * @param {string} filename
   */
  function download(files, filename) {
    var w = create();
    files.forEach(function(f) {
      if (f.content instanceof Uint8Array) {
        w.addBytes(f.name, f.content);
      } else {
        w.addText(f.name, String(f.content));
      }
    });
    var blob = w.build();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return {
    create: create,
    download: download,
    crc32: crc32    // exposed for tests
  };
})();

window.BatchZip = BatchZip;
