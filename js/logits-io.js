/**
 * logits-io.js
 *
 * Codec for the `Zugwise/logits/*.logits.bin` sidecar: the raw per-cell CTC
 * log-probabilities the OCR model produced, which the decoded text throws
 * away. backend/fix_finding.py scores candidate moves against these by CTC
 * alignment (see W_CTC there) instead of comparing strings — the only evidence
 * available where char_sim is uninformative, which at a stop is by definition.
 *
 * Format (defined in batch-folder-paths.js, deliberately library-free so both
 * this file and numpy can read it):
 *
 *     uint32 LE nCells, uint32 LE seqLen, uint32 LE vocab, then
 *     nCells * seqLen * vocab float16 LE log-probabilities,
 *     cells in the same order as the .txt and .grid.json sidecars.
 *
 * WHY float16 IS SAFE, and not a guess: log-probabilities reach -90, where
 * float16 spacing is ~0.06, and CTC alignment SUMS seqLen of them. Measured on
 * the 45-game Crown corpus by quantising every cell float32 -> float16 ->
 * float32 and re-running the ranking: 948 decisions, +98 rank-1 either way,
 * ZERO decisions changed. Half precision costs nothing here and halves a
 * ~413 KB-per-sheet sidecar.
 *
 * Every cell in one file shares seqLen and vocab — true of the ONNX model's
 * fixed-width output (seqLen 63, vocab 28) and what makes the flat layout
 * possible. encode() enforces it rather than silently writing a file whose
 * cells cannot be indexed.
 */
var LogitsIO = (function() {
  'use strict';

  var HEADER_BYTES = 12;

  // float16 finite range. log_softmax output is bounded well inside this
  // (a -90 log-prob is already e^-90), but clamping means a pathological
  // -Infinity from a saturated logit degrades to "impossible" rather than
  // writing a NaN that would poison every alignment through this cell.
  var F16_MAX = 65504;

  var _f32 = new Float32Array(1);
  var _u32 = new Uint32Array(_f32.buffer);

  /**
   * IEEE 754 binary32 -> binary16 bits, round-to-nearest-even.
   * @param {number} value
   * @returns {number} the 16 raw bits
   */
  function toHalf(value) {
    if (value > F16_MAX) value = F16_MAX;
    else if (value < -F16_MAX) value = -F16_MAX;
    _f32[0] = value;
    var x = _u32[0];
    var sign = (x >>> 16) & 0x8000;
    var exp = (x >>> 23) & 0xff;
    var mant = x & 0x7fffff;

    if (exp === 0xff) {                 // Inf / NaN
      return sign | 0x7c00 | (mant ? 0x200 : 0);
    }
    var e = exp - 127 + 15;
    if (e >= 0x1f) return sign | 0x7c00;              // overflow -> Inf
    if (e <= 0) {                                      // subnormal / zero
      if (e < -10) return sign;
      mant |= 0x800000;
      var shift = 14 - e;
      var sub = mant >>> shift;
      // round half to even
      var rem = mant & ((1 << shift) - 1);
      var half = 1 << (shift - 1);
      if (rem > half || (rem === half && (sub & 1))) sub += 1;
      return sign | sub;
    }
    var h = sign | (e << 10) | (mant >>> 13);
    var rem13 = mant & 0x1fff;
    if (rem13 > 0x1000 || (rem13 === 0x1000 && (h & 1))) h += 1;
    return h;
  }

  /**
   * IEEE 754 binary16 bits -> a JS number.
   * @param {number} bits
   * @returns {number}
   */
  function fromHalf(bits) {
    var sign = (bits & 0x8000) ? -1 : 1;
    var exp = (bits >>> 10) & 0x1f;
    var mant = bits & 0x3ff;
    if (exp === 0) return sign * mant * Math.pow(2, -24);
    if (exp === 0x1f) return mant ? NaN : sign * Infinity;
    return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
  }

  /**
   * Serialise per-cell logits to the sidecar format.
   *
   * @param {Array<{data: (Float32Array|Array<number>), seqLen: number, vocabSize: number}>} cells
   *        In sidecar order — the same order as the .txt and .grid.json cells.
   * @returns {ArrayBuffer}
   */
  function encode(cells) {
    if (!cells || !cells.length) throw new Error('LogitsIO.encode: no cells');
    var seqLen = cells[0].seqLen;
    var vocab = cells[0].vocabSize;
    var stride = seqLen * vocab;

    for (var c = 0; c < cells.length; c++) {
      if (cells[c].seqLen !== seqLen || cells[c].vocabSize !== vocab) {
        throw new Error('LogitsIO.encode: cell ' + c + ' is ' + cells[c].seqLen + 'x' +
                        cells[c].vocabSize + ', expected ' + seqLen + 'x' + vocab +
                        ' — the flat layout requires one shape per file');
      }
      if (cells[c].data.length !== stride) {
        throw new Error('LogitsIO.encode: cell ' + c + ' has ' + cells[c].data.length +
                        ' values, expected ' + stride);
      }
    }

    var buf = new ArrayBuffer(HEADER_BYTES + cells.length * stride * 2);
    var view = new DataView(buf);
    view.setUint32(0, cells.length, true);
    view.setUint32(4, seqLen, true);
    view.setUint32(8, vocab, true);

    var off = HEADER_BYTES;
    for (var i = 0; i < cells.length; i++) {
      var d = cells[i].data;
      for (var j = 0; j < stride; j++) {
        view.setUint16(off, toHalf(d[j]), true);
        off += 2;
      }
    }
    return buf;
  }

  /**
   * Parse a sidecar.
   *
   * @param {ArrayBuffer|Uint8Array} buffer
   * @returns {{nCells:number, seqLen:number, vocab:number,
   *            cell:function(number):Float32Array,
   *            rows:function(number):Array<Array<number>>}}
   *          `cell(i)` is the flat [seqLen*vocab] block; `rows(i)` is the
   *          [seqLen][vocab] nested form ctc_align expects.
   */
  function decode(buffer) {
    var ab = (buffer instanceof ArrayBuffer) ? buffer
      : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    if (ab.byteLength < HEADER_BYTES) throw new Error('LogitsIO.decode: truncated header');

    var view = new DataView(ab);
    var nCells = view.getUint32(0, true);
    var seqLen = view.getUint32(4, true);
    var vocab = view.getUint32(8, true);
    var stride = seqLen * vocab;
    var need = HEADER_BYTES + nCells * stride * 2;
    if (ab.byteLength < need) {
      throw new Error('LogitsIO.decode: expected ' + need + ' bytes for ' + nCells +
                      ' cells of ' + seqLen + 'x' + vocab + ', got ' + ab.byteLength);
    }

    function cell(i) {
      if (i < 0 || i >= nCells) throw new Error('LogitsIO: cell ' + i + ' out of range');
      var out = new Float32Array(stride);
      var off = HEADER_BYTES + i * stride * 2;
      for (var j = 0; j < stride; j++) out[j] = fromHalf(view.getUint16(off + j * 2, true));
      return out;
    }

    function rows(i) {
      var flat = cell(i);
      var out = new Array(seqLen);
      for (var t = 0; t < seqLen; t++) {
        var r = new Array(vocab);
        for (var v = 0; v < vocab; v++) r[v] = flat[t * vocab + v];
        out[t] = r;
      }
      return out;
    }

    return { nCells: nCells, seqLen: seqLen, vocab: vocab, cell: cell, rows: rows };
  }

  return {
    HEADER_BYTES: HEADER_BYTES,
    toHalf: toHalf,
    fromHalf: fromHalf,
    encode: encode,
    decode: decode
  };
})();

if (typeof window !== 'undefined') window.LogitsIO = LogitsIO;
if (typeof module !== 'undefined' && module.exports) module.exports = LogitsIO;
