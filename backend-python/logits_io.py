"""Reader for the `Zugwise/logits/*.logits.bin` sidecar.

The counterpart of frontend/js/logits-io.js. Both must agree byte for byte;
backend/test_logits_io.py checks that by having node run the JS encoder and
reading its output here, rather than trusting two independent implementations
of the same paragraph of prose.

Format (defined in frontend/js/batch-folder-paths.js):

    uint32 LE nCells, uint32 LE seqLen, uint32 LE vocab, then
    nCells * seqLen * vocab float16 LE log-probabilities,
    cells in the same order as the .txt and .grid.json sidecars.

Consumers want {ply: [seq_len][vocab]} to hand to fix_finding's ctc_logits, so
`load_by_ply` pairs a sidecar with the OCRMove list parsed from the matching
.txt. A missing or unreadable sidecar yields {} — the signal is simply
unavailable and contributes nothing, the same graceful degradation as a missing
.grid.json.
"""
import os
import struct

HEADER = struct.Struct('<III')
HEADER_BYTES = HEADER.size


def _decode_f16(payload, count):
    """-> flat list of floats. Uses numpy when present, else a pure-Python fallback."""
    try:
        import numpy as np
        return np.frombuffer(payload, dtype='<f2', count=count).astype('float32').tolist()
    except ImportError:
        pass
    out = []
    for (bits,) in struct.iter_unpack('<H', payload[:count * 2]):
        sign = -1.0 if (bits & 0x8000) else 1.0
        exp = (bits >> 10) & 0x1F
        mant = bits & 0x3FF
        if exp == 0:
            out.append(sign * mant * 2.0 ** -24)
        elif exp == 0x1F:
            out.append(float('nan') if mant else sign * float('inf'))
        else:
            out.append(sign * (1.0 + mant / 1024.0) * 2.0 ** (exp - 15))
    return out


class LazyPlyLogits(object):
    """{ply: [seq_len][vocab]} that decodes a cell only when it is asked for.

    Built for the browser: shipping a sheet's logits into Pyodide as bytes is
    cheap (~413 KB, a transferable ArrayBuffer), but eagerly expanding it into
    Python floats is not — 120 cells x 63 x 28 is 211,680 floats per sheet, and
    this Pyodide has no numpy to do it quickly.

    Eager expansion is also almost entirely wasted. Measured over 554 corpus
    stops, a fix list touches a MEDIAN OF 2 distinct plies (p95 6, max 10), so
    a stop needs a handful of cells out of a hundred-odd. Decoding on demand
    and caching turns a per-game cost into a per-stop one.

    Quacks like the dict `apply_ctc_rescore` expects: only `.get(ply)` is used.
    """

    __slots__ = ('_data', '_index', '_cache', '_seq_len', '_vocab')

    def __init__(self):
        self._data = []          # one entry per source sheet
        self._index = {}         # ply -> (source, cell index)
        self._cache = {}
        self._seq_len = None
        self._vocab = None

    def add(self, data, plies):
        """Register a sidecar's bytes and the ply of each cell, in cell order.

        FIRST WINS on a repeated ply, matching load_by_ply's setdefault: in
        dual-sheet games both sheets carry every ply, and the caller decides
        preference by the order it adds them.

        A cell-count mismatch is refused outright rather than aligned — the
        same rule as load_by_ply, and for the same reason: attaching one move's
        logits to another is silent and confident.
        """
        if not data or not plies:
            return self
        n_cells, seq_len, vocab = HEADER.unpack_from(data, 0)
        if n_cells != len(plies):
            return self
        if self._seq_len is None:
            self._seq_len, self._vocab = seq_len, vocab
        elif (seq_len, vocab) != (self._seq_len, self._vocab):
            return self          # different model shape; refuse to mix
        src = len(self._data)
        self._data.append(data)
        for i, ply in enumerate(plies):
            if ply not in self._index:
                self._index[ply] = (src, i)
        return self

    def __len__(self):
        return len(self._index)

    def __bool__(self):
        return bool(self._index)

    __nonzero__ = __bool__       # (Pyodide runs py3, but keep it explicit)

    def get(self, ply, default=None):
        if ply in self._cache:
            return self._cache[ply]
        loc = self._index.get(ply)
        if loc is None:
            return default
        src, i = loc
        stride = self._seq_len * self._vocab
        start = HEADER_BYTES + i * stride * 2
        flat = _decode_f16(self._data[src][start:start + stride * 2], stride)
        rows = [flat[t * self._vocab:(t + 1) * self._vocab] for t in range(self._seq_len)]
        self._cache[ply] = rows
        return rows


def parse(data):
    """Parse sidecar bytes.

    Returns (cells, seq_len, vocab) where `cells` is a list of nCells nested
    [seq_len][vocab] float lists — the shape ctc_align.viterbi expects.
    """
    if len(data) < HEADER_BYTES:
        raise ValueError('logits sidecar: truncated header (%d bytes)' % len(data))
    n_cells, seq_len, vocab = HEADER.unpack_from(data, 0)
    stride = seq_len * vocab
    need = HEADER_BYTES + n_cells * stride * 2
    if len(data) < need:
        raise ValueError('logits sidecar: expected %d bytes for %d cells of %dx%d, got %d'
                         % (need, n_cells, seq_len, vocab, len(data)))

    flat = _decode_f16(data[HEADER_BYTES:need], n_cells * stride)
    cells = []
    for c in range(n_cells):
        base = c * stride
        cells.append([flat[base + t * vocab: base + (t + 1) * vocab] for t in range(seq_len)])
    return cells, seq_len, vocab


def read(path):
    """parse() the file at `path`. Returns (cells, seq_len, vocab)."""
    with open(path, 'rb') as fh:
        return parse(fh.read())


def load_by_ply(path, ocr_moves):
    """-> {ply: [seq_len][vocab]}, ready to pass as fix_finding's `ctc_logits`.

    `ocr_moves` is the OCRMove list parsed from the sidecar's matching .txt, in
    the same cell order. A count mismatch means the two files describe
    different scans, so the sidecar is refused outright rather than silently
    aligning the wrong cell to a ply - which would attach one move's logits to
    another and score confident nonsense.

    Returns {} for a missing or unreadable file.
    """
    if not path or not os.path.exists(path):
        return {}
    try:
        cells, _seq, _vocab = read(path)
    except (ValueError, OSError):
        return {}
    if len(cells) != len(ocr_moves):
        return {}
    out = {}
    for move, cell in zip(ocr_moves, cells):
        out.setdefault(move.ply, cell)
    return out
