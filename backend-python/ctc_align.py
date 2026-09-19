"""CTC scoring of a candidate move against raw OCR logits.

WHY: candidate ranking is dominated by char_sim, a string comparison against
the DECODED text - which has already thrown information away. In the third of
decisions where char_sim is uninformative (correct fix below 0.5 similarity),
it cannot separate the candidates at all. The raw logits still can: scoring a
candidate SAN by alignment against them asks the model directly "how likely is
this cell to read bxc4?", never comparing strings.

This is the likelihood term, not a chess-quality signal: it is OCR confidence,
a core permitted signal (see the ranking HARD RULE in CLAUDE.md).

PARITY WITH THE FRONTEND IS THE POINT. frontend/beam-decoder.js already ships
`_ctcForcedAlign`, used reactively by the `constrained-reocr` worker message.
If the Python and JS scorers disagree, the CLI/recorder and the browser rank
differently - the "two parallel fix paths" failure this codebase keeps hitting.
So `viterbi` here is a faithful port of that function, including its quirks:

  - MAX over alignments (best single path), not the CTC forward SUM
  - states = 2*len(target)+1, blanks interleaved
  - a blank may be skipped only between DIFFERENT characters
  - initialised at state 0 (blank) and state 1 (first char)
  - result = max(final char state, final blank state)

`forward` is the true CTC log-likelihood (sum over all alignments). It is the
more principled quantity and is provided for comparison, but the frontend does
not implement it - do not make it the default without changing beam-decoder.js
too, or the paths diverge.

Both return None for an unscorable target (unknown character, or a target
longer than the available time steps).
"""
from typing import List, Optional, Sequence
import math

# Must match frontend/beam-decoder.js CHARSET and the training charset.
CHARSET = ['', 'K', 'Q', 'R', 'B', 'N', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
           '1', '2', '3', '4', '5', '6', '7', '8', 'x', '+', '#', '=', 'O', '-']
CHAR_TO_IDX = {c: i for i, c in enumerate(CHARSET)}
BLANK_IDX = 0
NEG_INF = float('-inf')


def _indices(target: str) -> Optional[List[int]]:
    if not target:
        return None
    out = []
    for ch in target:
        i = CHAR_TO_IDX.get(ch)
        if i is None:
            return None
        out.append(i)
    return out


def viterbi(logits: Sequence[Sequence[float]], target: str) -> Optional[float]:
    """Best-alignment log probability. Faithful port of JS _ctcForcedAlign.

    logits: [seq_len][vocab_size] LOG probabilities (already log-softmaxed).
    """
    ids = _indices(target)
    if ids is None:
        return None
    T = len(logits)
    if T == 0:
        return None
    n = 2 * len(ids) + 1

    dp = [NEG_INF] * n
    dp[0] = logits[0][BLANK_IDX]
    if n > 1:
        dp[1] = logits[0][ids[0]]

    for t in range(1, T):
        nd = [NEG_INF] * n
        frame = logits[t]
        blank_lp = frame[BLANK_IDX]
        for s in range(n):
            cur = dp[s]
            if cur == NEG_INF:
                continue
            if s % 2 == 0:                       # blank state
                if cur + blank_lp > nd[s]:
                    nd[s] = cur + blank_lp
                if s + 1 < n:
                    v = cur + frame[ids[s // 2]]
                    if v > nd[s + 1]:
                        nd[s + 1] = v
            else:                                # character state
                ci = s // 2
                char_idx = ids[ci]
                v = cur + frame[char_idx]
                if v > nd[s]:                    # repeat the same char
                    nd[s] = v
                if s + 1 < n:
                    v = cur + blank_lp
                    if v > nd[s + 1]:
                        nd[s + 1] = v
                if s + 2 < n:
                    nxt = (s + 2) // 2
                    if nxt < len(ids) and ids[nxt] != char_idx:
                        v = cur + frame[ids[nxt]]
                        if v > nd[s + 2]:
                            nd[s + 2] = v
        dp = nd

    best = dp[n - 1]
    if n >= 2 and dp[n - 2] > best:
        best = dp[n - 2]
    return None if best == NEG_INF else best


def forward(logits: Sequence[Sequence[float]], target: str) -> Optional[float]:
    """True CTC log-likelihood: log-sum over every valid alignment."""
    ids = _indices(target)
    if ids is None:
        return None
    T = len(logits)
    if T == 0 or T < len(ids):
        return None
    ext = [BLANK_IDX]
    for i in ids:
        ext += [i, BLANK_IDX]
    n = len(ext)

    def lse(a, b):
        if a == NEG_INF:
            return b
        if b == NEG_INF:
            return a
        hi, lo = (a, b) if a > b else (b, a)
        return hi + math.log1p(math.exp(lo - hi))

    dp = [NEG_INF] * n
    dp[0] = logits[0][ext[0]]
    if n > 1:
        dp[1] = logits[0][ext[1]]
    for t in range(1, T):
        nd = [NEG_INF] * n
        frame = logits[t]
        for s in range(n):
            acc = dp[s]
            if s >= 1:
                acc = lse(acc, dp[s - 1])
            if s >= 2 and ext[s] != BLANK_IDX and ext[s] != ext[s - 2]:
                acc = lse(acc, dp[s - 2])
            if acc != NEG_INF:
                nd[s] = acc + frame[ext[s]]
        dp = nd
    best = lse(dp[n - 1], dp[n - 2]) if n > 1 else dp[0]
    return None if best == NEG_INF else best


def score_candidates(logits, candidates, mode: str = "viterbi") -> dict:
    """-> {san: log score}, skipping anything unscorable.

    `mode` defaults to viterbi for parity with the frontend.
    """
    fn = viterbi if mode == "viterbi" else forward
    out = {}
    for san in candidates:
        if not san:
            continue
        v = fn(logits, san.replace('0-0', 'O-O'))
        if v is not None:
            out[san] = v
    return out
