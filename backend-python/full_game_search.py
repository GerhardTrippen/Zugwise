"""
Score2PGN - Full Game Search Algorithms
=======================================
User-initiated search algorithms for fixing entire games.

These are OPTIONAL tools that run when the user clicks a button.
They are NOT part of the default validation pipeline.

Features:
- Unified input interface (always List[str])
- Interruptible via cancel_flag
- Progress callbacks for UI updates
- Clear separation from instant validation

Usage:
    from full_game_search import run_greedy_search, run_beam_search
    
    # With cancel support
    cancel_flag = {"cancelled": False}
    result = run_greedy_search(moves, cancel_flag=cancel_flag, 
                                on_progress=update_ui)
    
    # To cancel from another thread:
    cancel_flag["cancelled"] = True
"""

import time
from typing import List, Dict, Optional, Callable, Set
from dataclasses import dataclass, field

import chess

from data_structures import OCRMove, ReconstructionResult
from helpers import (
    ply_to_str, try_move, play_until_stuck,
    ocr_moves_to_list, create_ocr_lookup, moves_to_ocr_moves,
    legal_san_disambiguations
)
from similarity import move_similarity
from absurdity import find_all_absurdities, AbsurditiesPrefixCache
from fix_finding import find_deep_backtrack_fixes, _postprocess_phase2_fixes, find_fixes_two_phase

# Early Absurdity Detection (January 2026)
from play import play_until_absurd_or_stuck, EadPrefixCache

# Flag to enable/disable EAD in full game search
USE_EAD_IN_SEARCH = True


class LegalPrefixCache:
    """Cache of the deepest known-legal prefix of a mutating move list.

    Invariant: ``board`` is the position after playing ``moves[0..ply-1]``,
    where those plies were verified legal the last time the cache advanced.

    Lifecycle:
      - ``play_until_stuck(moves)`` reuses the cached prefix instead of
        rebuilding from ply 0, then advances if the call reached further.
      - ``invalidate_from(F)`` MUST be called after any mutation to
        ``moves[F]`` (replacement, insertion, or deletion at index F).
        Without this the cached board will drift from the move list.
      - The cache is keyed on a single move list. Don't share it across
        greedy paths or beam paths — each path needs its own cache.

    Restricted to ``play_until_stuck`` with default args (no auto_correct,
    no piece confusions). Callers that pass non-default options must
    bypass the cache or the cached board can encode a move spelling
    different from what the next caller expects.
    """

    __slots__ = ("ply", "board")

    def __init__(self):
        self.ply = 0
        self.board = chess.Board()

    def play_until_stuck(self, moves):
        reach, board = play_until_stuck(moves, board=self.board, start=self.ply)
        if reach > self.ply:
            # play_until_stuck copies the input board internally, so the
            # returned object is safe to adopt without an extra copy.
            self.ply = reach
            self.board = board
        return reach, board

    def invalidate_from(self, ply):
        # Pop the cached board so it again reflects only moves[0..ply-1].
        # chess.Board.pop() reverses the last push() and is O(1)-ish.
        while self.ply > ply:
            self.board.pop()
            self.ply -= 1

    def copy(self) -> "LegalPrefixCache":
        """Independent clone with the same legal prefix.

        Beam paths diverge after branching, so each new path needs its own
        cache instance. The board is deep-copied; subsequent push/pop on
        either instance cannot bleed into the other.
        """
        other = LegalPrefixCache()
        other.ply = self.ply
        other.board = self.board.copy()
        return other


# =============================================================================
# PROGRESS REPORTING
# =============================================================================

@dataclass
class SearchProgress:
    """Progress update for UI callbacks."""
    iteration: int
    max_iterations: int
    current_ply: int
    total_plies: int
    status: str  # "searching", "applying_fix", "validating", "complete", "cancelled"
    message: str
    elapsed: float
    fixes_applied: int = 0


# =============================================================================
# GREEDY SEARCH (Single-path with backtracking)
# =============================================================================
#
# Two-function API: ``greedy_init`` builds a state dict, ``greedy_step``
# advances it by one iteration. Both ``run_greedy_search`` below (Python's
# in-process loop) and the browser's ``search-worker.js`` (the JS step-then-
# yield-to-UI loop) call into this single implementation. Before this split,
# greedy lived in two places with material divergence — find_deep_backtrack_
# fixes vs find_fixes_two_phase, different EAD-approved sets, no caches in
# the worker, no Phase 2 floor filter in the Python copy, etc. — and the
# CLI test suite only exercised the Python copy, so silent drift between
# them produced the e5-vs-c4 bug.
#
# Canonical semantics here match the prior worker behavior (Phase 1 + Phase 2
# via find_fixes_two_phase, EAD approved = range(confirmed_ply) only, lock-
# aware backtrack filter, verify_top_n=15, score_floor=0). The prefix caches
# from full_game_search.py are layered on top — the worker gets them for free
# as a side-effect of using this function.
#
# State dict is Pyodide-friendly: contains plain Python objects (list, set,
# int, dict) plus the three prefix-cache instances. ``greedy_step``'s return
# dict is JSON-friendly so the worker can ``json.dumps`` it directly to post
# back to the UI thread.

# Threshold of consecutive plies that triggers anti-drift stop.
_GREEDY_ANTI_DRIFT_RUN = 5


# =============================================================================
# REVIEW-FIX PACKAGING (single source of truth for JS review panel)
# =============================================================================
# Both the streaming finalize path (search-worker.js searchFinalize) AND the
# per-step greedy event (greedy_step's 'applied_fix' field, consumed by
# search-manager's instant-cancel partial builder) must hand the JS review UI
# *identically shaped* fix dicts — same keys, same similarity scaling, same
# packaged all_candidates with the score-component pills. If the two diverge,
# fixes kept via Cancel render without the alternative-candidate detail the
# user relies on. Keep this the ONE place that shape is defined.

# Fields the review fix-details panel reads off each candidate. Mirrors the
# passthrough list in full_game_search's path packaging; without these the
# color-coded score-component pills don't render in review mode.
_REVIEW_DETAIL_FIELDS = (
    'ply', 'san', 'ocr', 'unified_score',
    'reach', 'reach_improvement', 'completes',
    'score_components', 'sim_source',
    'char_sim', 'ocr_conf', 'ocr_candidate_bonus',
    'absurdity_count', 'absurdity_penalty',
    'is_hanging', 'is_absurdity_fix', 'is_low_conf_fix',
    'original_was_legal', 'ply_str',
    # Backtracking metadata so the review UI's alternative-list buttons can
    # distinguish backtrack proposals from at-stuck repairs.
    'is_backtrack', 'origin_stuck_ply',
)


def _review_sim_pct(d: dict) -> int:
    """Phase 3 fixes store 'similarity' (0-100); Phase 2 store 'char_sim' (0-1)."""
    s = d.get('similarity')
    if s is not None:
        return int(round(s))
    cs = d.get('char_sim')
    if cs is None:
        return 0
    return int(round(cs * 100))


def package_review_candidate(c: dict, fallback_ply: int = 0) -> dict:
    """Package one candidate dict into the JS-ready review shape."""
    co = {k: c[k] for k in _REVIEW_DETAIL_FIELDS if k in c}
    co['similarity'] = _review_sim_pct(c)
    if not co.get('ply_str'):
        co['ply_str'] = ply_to_str(co.get('ply', fallback_ply))
    return co


def package_review_fix(fix: dict) -> dict:
    """Package one applied/chosen fix (with its all_candidates) for the JS
    review panel. Single source of truth shared by searchFinalize and the
    per-step greedy 'applied_fix' event."""
    out = {
        'ply': fix.get('ply', 0),
        'ply_str': fix.get('ply_str', '') or ply_to_str(fix.get('ply', 0)),
        'san': fix.get('san', ''),
        'ocr': fix.get('ocr', ''),
        'original': fix.get('ocr', ''),
        'similarity': _review_sim_pct(fix),
        # Backtracking metadata: when fix_ply < origin_stuck_ply, this is a
        # backtrack proposal — the algorithm got stuck at origin_stuck_ply and
        # offered to repair an earlier ply. Review UI shows the stuck ply (red)
        # and the backtrack proposal (yellow) distinctly.
        'is_backtrack': bool(fix.get('is_backtrack', False)),
        'origin_stuck_ply': fix.get('origin_stuck_ply', fix.get('ply', 0)),
        # Per-fix stop reason (why origin_stuck_ply was stuck when THIS fix was
        # found). None for algos that don't stamp it -> JS falls back to global.
        'origin_stop_reason': fix.get('origin_stop_reason', None),
    }
    cands = fix.get('all_candidates') or []
    if cands:
        out['all_candidates'] = [
            package_review_candidate(c, out['ply'])
            for c in cands if isinstance(c, dict)
        ]
    return out


def _rescore_forced_stop_candidates(fixes, forced_stop_ply, cur_reach):
    """Re-score find_fixes candidates FAIRLY for a forced-stop (a LEGAL ply).

    A forced-stop is NOT a real stuck point — the game is not broken at this
    ply (the move is legal); the consequence of a wrong reading is DOWNSTREAM.
    So find_fixes' reach term, measured from a baseline that collapses to the
    ply, INFLATES earlier backtrack fixes: every fix trivially "reaches past"
    the legal forced-stop, and an EARLIER fix_ply earns a bigger reach bonus
    for reaching the SAME downstream wall (the observed 2.B d5 reach+50 vs
    4.W c3 reach+20, both only reaching 5.W). find_fixes' Phase-2 penalty,
    which would normally suppress such a no-progress backtrack fix, ALSO
    misfires here: it waives itself whenever ``reach > stuck_ply``, and every
    fix trivially reaches past the LEGAL forced-stop ply — so the penalty never
    fires and high-similarity backtrack phantoms (3.B Nd7->Bd7 sim 100%) out-
    rank the review ply's own readings.

    This re-score is DELIBERATELY DISTINCT from the real-stuck-point scoring in
    find_fixes (do NOT merge the two — see CLAUDE.md "stuck-stuck vs
    stuck-by-low-confidence"). It keeps the RECONSTRUCTION signals find_fixes
    computed (char_sim, ocr_conf, ocr_pat, hi_sim, lo_conf) and re-derives the
    two reach-relative terms against a SINGLE consistent baseline
    (``cur_reach`` = play_until_stuck of the current move list = the REAL
    downstream wall):
      - FAIR reach bonus: only a candidate that genuinely unsticks the real
        break (reaches further, e.g. a6->Nf6) earns it; same-wall fixes get 0.
      - FAIR Phase-2 penalty: a BACKTRACK fix (fix_ply < forced_stop_ply) that
        does NOT advance past the real wall is penalised exactly like find_fixes
        does at a real stuck point — reach == wall -> -70, reach < wall ->
        -70 -10/ply short. Measured against cur_reach (the real wall) instead of
        the legal forced-stop ply, this restores the consistency the user
        expects with illegal stops (where a 2.W backtrack fix reaching only the
        5.W stuck ply correctly gets -70).
    stuck+15 is kept only for the review ply's OWN readings (fix_ply ==
    forced_stop_ply), not for backtrack fixes.

    Mutates each fix in place: ``unified_score`` becomes the fair score (the
    original is preserved under ``_real_stuck_score``), ``fair_reach`` records
    the fair reach bonus, and the stripped components are zeroed in
    ``score_components`` so the UI breakdown reflects the fair score.
    """
    for f in fixes:
        orig = f.get('unified_score', 0.0)
        score = orig
        sc = f.get('score_components')
        if isinstance(sc, dict):
            # Main path (_search_single_ply_for_fixes): strip the reach-derived
            # terms and the real-stuck penalties via the component breakdown
            # (read before zeroing below).
            for k in ('reach', 'reach_tb', 'reach10', 'zero_r', 'dist', 'p2_pen'):
                score -= sc.get(k, 0)
            # stuck+15 belongs only to the review ply's own readings.
            if f.get('ply') != forced_stop_ply:
                score -= sc.get('stuck', 0)
        else:
            # Component-less dicts (e.g. backtrack_piece_confusion from
            # find_deep_backtrack_fixes) have NO score_components. Their score
            # formula adds the SAME reach term — min(reach_improvement*10, 50)
            # (+30 only when reach_improvement>=10 AND fix_ply>=stuck_ply) — but
            # none of the zero_r/dist/stuck terms. Mirror that exactly so these
            # backtrack candidates (e.g. 3.B Nd7->Bd7) lose the reach inflation
            # too, instead of riding in with an un-rescored unified_score.
            ri = f.get('reach_improvement', 0)
            score -= min(ri * 10, 50)
            if ri >= 10 and f.get('ply') == forced_stop_ply:
                score -= 30
        # FAIR reach: one baseline for ALL candidates.
        cand_reach = f.get('reach', cur_reach)
        improvement = cand_reach - cur_reach
        fair_reach = min(max(improvement, 0) * 10, 50)
        score += fair_reach

        # FAIR Phase-2 penalty: a BACKTRACK fix (before the forced-stop
        # frontier) that doesn't advance past the REAL wall is a no-progress
        # lateral edit to a move the user already has. Mirror find_fixes'
        # p2 penalty but against cur_reach (the real wall) rather than the legal
        # forced-stop ply, so it actually fires (find_fixes waives it because
        # every fix passes the legal ply). At-ply readings (fix_ply ==
        # forced_stop_ply) are AT the frontier, not before it -> no penalty.
        fair_p2 = 0
        if f.get('ply', forced_stop_ply) < forced_stop_ply:
            if cand_reach > cur_reach:
                fair_p2 = 0
            elif cand_reach == cur_reach:
                fair_p2 = 70
            else:
                fair_p2 = 70 + (cur_reach - cand_reach) * 10
            score -= fair_p2

        f['_real_stuck_score'] = orig
        f['fair_reach'] = fair_reach
        f['unified_score'] = score
        # Reflect the fair decomposition in the recorded breakdown (when present).
        if isinstance(sc, dict):
            sc['fair_reach'] = fair_reach
            for k in ('reach', 'reach_tb', 'reach10', 'zero_r', 'dist'):
                sc[k] = 0
            sc['p2_pen'] = -fair_p2
            if f.get('ply') != forced_stop_ply:
                sc['stuck'] = 0
    return fixes


def _decide_forced_stop_change(at_ply, cur):
    """Greedy: pick the HIGHEST-SCORING at-ply candidate. Return it to APPLY, or
    None meaning KEEP ``cur`` (when the top-scoring candidate IS the current
    reading).

    A forced-stop is a LEGAL ply, so the kept reading is itself a scored at-ply
    candidate. There is NO special 'unstick' rule: the fair re-score already
    folds reach (bonus when a candidate advances past the real wall) and the
    Phase-2 penalty (when a backtrack fix makes no progress) INTO unified_score,
    so the right move simply has the highest score. The kept reading wins when it
    scores highest (10.W cxd4 sim 100% score 105 beats a +1-ply Bb3 score 58); a
    genuine correction wins when ITS score is highest (a6 score 20 -> Nf6 score
    95). Either way the review still surfaces every candidate.
    """
    if not at_ply:
        return None
    top = max(at_ply, key=lambda f: f.get('unified_score', 0.0))
    if top.get('keep_as_is') or top.get('san') == cur:
        return None
    return top


def resolve_forced_stop_choice(moves, ply, ocr_lookup, forced_stop_plies=None,
                               fixed_plies=None, locked_plies=None,
                               min_ply=0, phase2_depth=5):
    """Run the SAME backtracking search interactive runs at this stuck ply, so the
    review's deep-search is the full backtracking search (Phase 1 + Phase 2),
    identical in spirit to interactive's live deep-search on the same game state.

    The ply is LEGAL but dual-sheet ambiguous / low-confidence. Two parts:

    1) GATE — only surface a review step when >= 2 of the actual SHEET READINGS
       (OCR candidates) are legal here. A single-legal disagreement (the other
       reading illegal, e.g. 8.W Qe2 / 6.B Bb7) has nothing to choose; return None
       so the caller keeps it silently (no empty "choose" step). (find_fixes alone
       can't tell this apart — it expands to ALL legal moves.)

    2) CANDIDATES — find_fixes_two_phase(stuck_ply=ply, Phase 2 on), exactly the
       call the algorithm uses for any stuck point and interactive uses live. It
       returns the keep, the at-ply alternatives (7.B f5/Ngf6/f6), AND the
       backtrack fixes at earlier plies, each with the full unified score. These
       become all_candidates so the review deep-search matches interactive.

    DECISION (which move the caller applies/keeps): see _decide_forced_stop_change
    — Greedy picks the highest-scoring at-ply candidate (the kept reading is one
    of them). So a6->Nf6 (score 95) applies; 10.W cxd4 (score 105) keeps over a
    +1-ply Bb3 (score 58). No special unstick rule — reach is already in the score.

    Returns the chosen fix dict with all_candidates = the full backtracking list,
    or None (single-legal / nothing found).
    """
    ocr_m = ocr_lookup.get(ply)
    if not ocr_m or not getattr(ocr_m, 'candidates', None):
        return None
    cur = moves[ply] if ply < len(moves) else ''
    # --- GATE: >= 2 LEGAL sheet readings? ---
    prefix = chess.Board()
    for k in range(ply):
        mv = try_move(prefix, moves[k], auto_correct=False) if k < len(moves) else None
        if mv is None:
            return None  # prefix broken — let the normal path handle it
        prefix.push(mv)
    legal_readings = 0
    for cand in {c for c, _ in ocr_m.candidates if c}:
        # STRICT (auto_correct=False) so an illegal reading like 'Rb7' isn't
        # silently legalised into the count.
        if try_move(prefix, cand, auto_correct=False) is not None:
            legal_readings += 1
    # SAN-AMBIGUITY: the current reading itself may be illegal ONLY because it is
    # under-specified (e.g. "Nd7" with knights on b8 and f6). play stops here
    # with stop_reason 'ambiguous' for that case too. Here the competing
    # "readings" are the legal disambiguation variants (Nbd7 / Nfd7), not the
    # dual-sheet OCR candidates — so count those toward the >= 2 gate. Without
    # this the gate bails (cur is illegal -> legal_readings is 0/1) and the caller
    # would never make progress, re-stopping at this ply forever.
    _san_variants = legal_san_disambiguations(prefix, cur)
    _is_san_ambig = len(_san_variants) >= 2
    if legal_readings < 2 and not _is_san_ambig:
        return None

    # --- CANDIDATES: the full backtracking search (same as interactive) ---
    # For SAN-ambiguity, unlock this ply so find_fixes can propose the
    # disambiguation. A Tier-1 lock here means "both sheets read 'Nd7'" — i.e.
    # the OCR is correct, the PLAYER under-specified. Disambiguating is not
    # second-guessing the OCR, so the lock must not suppress the variants
    # (otherwise the at-ply candidate list is empty and cur stays illegal).
    _eff_locked = set(locked_plies) if locked_plies else set()
    if _is_san_ambig:
        _eff_locked.discard(ply)
    fixes = find_fixes_two_phase(
        moves, ply, ocr_lookup,
        fixed_plies=set(fixed_plies) if fixed_plies else set(),
        locked_plies=_eff_locked,
        min_ply=int(min_ply), phase2_depth=int(phase2_depth), verify_top_n=15,
    )
    if not fixes:
        return None

    # --- FAIR RE-SCORE: forced-stops are LEGAL plies, not real stuck points ---
    # find_fixes generates the candidates (Phase 1 all-legal-at-ply + Phase 2
    # backtrack), but its reach/penalty terms inflate earlier backtrack fixes
    # at a fake stuck point. Re-score against ONE consistent baseline so
    # same-wall fixes don't out-earn the review ply's own readings. This keeps
    # the forced-stop scoring CLEARLY DISTINCT from the working real-stuck
    # scoring in find_fixes.
    cur_reach, _ = play_until_stuck(moves)
    fixes = _rescore_forced_stop_candidates(fixes, ply, cur_reach)
    fixes.sort(key=lambda f: -f.get('unified_score', 0))

    # --- DECISION: Greedy picks the highest-scoring at-ply candidate. The kept
    # reading is itself a scored candidate, so it wins when it scores highest;
    # a genuine correction wins when its (fair-rescored) score is highest. The
    # review still surfaces every candidate in all_candidates. ---
    at_ply = [f for f in fixes if f.get('ply') == ply]
    chosen = _decide_forced_stop_change(at_ply, cur)
    # SAN-AMBIGUITY: cur (e.g. "Re8") is ILLEGAL as written — under-specified,
    # with >= 2 legal disambiguations (Rde8 / Rhe8). A "keep cur" outcome is
    # NEVER valid here: it leaves the ambiguous SAN in moves[], so the very next
    # play_until_absurd_or_stuck re-detects the SAME ambiguity and re-stops at
    # this ply forever (the Greedy/Dijkstra spin the user hit: "[DISAMBIG]
    # 'Re8' still ambiguous ['Rde8','Rhe8']", Dijkstra cost climbing by LAM each
    # pop). _decide_forced_stop_change can still pick "keep" because find_fixes
    # surfaces the kept reading as a sim=100% candidate that out-scores the
    # variants. The forced_stop_plies/fixed_plies guards can't break the loop —
    # the ambiguity is re-derived from the board, not from that set. Force a
    # CONCRETE variant so the move list advances; both variants ride in
    # all_candidates for user review.
    if _is_san_ambig and (chosen is None or chosen.get('san') == cur):
        _variant_set = set(_san_variants)
        _variant_cands = [f for f in at_ply
                          if f.get('san') in _variant_set and f.get('san') != cur]
        if _variant_cands:
            chosen = max(_variant_cands, key=lambda f: f.get('unified_score', 0.0))
        else:
            # find_fixes didn't surface the variants — synthesize the best by
            # reach (the rooks land differently, so downstream legality can
            # differ) so the game still advances past this ply.
            _best_variant, _best_reach = _san_variants[0], -1
            for _v in _san_variants:
                _trial = list(moves)
                _trial[ply] = _v
                _vr, _ = play_until_stuck(_trial)
                if _vr > _best_reach:
                    _best_reach, _best_variant = _vr, _v
            chosen = {
                'ply': ply, 'ply_str': ply_to_str(ply), 'ocr': cur,
                'san': _best_variant, 'char_sim': 1.0, 'unified_score': 0.0,
            }
    if chosen is None:
        best = {
            'ply': ply, 'ply_str': ply_to_str(ply), 'ocr': cur, 'san': cur,
            'char_sim': 1.0, 'unified_score': 0.0,
            'keep_as_is': True, 'is_keep_as_is': True,
        }
    else:
        best = dict(chosen)
    best['all_candidates'] = fixes
    best['is_backtrack'] = False
    best['origin_stuck_ply'] = ply
    best['origin_stop_reason'] = 'ambiguous'
    return best


def greedy_init(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove],
    *,
    confirmed_ply: int = 0,
    locked_plies: Optional[Set[int]] = None,
    tier1_agreed_plies: Optional[Set[int]] = None,
    max_backtrack: int = 5,
    max_fixes: int = 15,
    forced_stop_plies: Optional[Set[int]] = None,
) -> dict:
    """Build a greedy search state dict. See greedy_step for the iteration.

    ``forced_stop_plies``: plies the dual-sheet merge flagged as ambiguous
    (near-tie disagreement) or very-low-confidence. Greedy stops (PARTIAL) at
    the first such ply rather than guessing — the user resolves it. Empty /
    None is a no-op (single-sheet, CLI tests).

    ``tier1_agreed_plies``: the *static* set of plies where both OCR sheets
    agreed on the move (dual-sheet ``_agree && _sheetCount===2``). This is
    independent of legality — Greedy uses it to recompute the auto-lock set
    after each applied fix, mirroring what the frontend's classifyTiers +
    computeLockedPlies would compute on a manual revalidate. Empty / None
    is a no-op (legacy callers, CLI tests).
    """
    locked_set = set(locked_plies) if locked_plies else set()
    tier1_set = set(tier1_agreed_plies) if tier1_agreed_plies else set()
    # User-confirmed plies: JS-side locked plies minus raw Tier-1 agreed plies.
    # These are moves the user explicitly fixed or accepted (override, keep-as-
    # is). Unlike Tier-1 auto-locks, EAD should be skipped — the user has
    # deliberately accepted any apparent absurdity (e.g. an exchange sacrifice).
    # Snapshot BEFORE _recompute_auto_locks adds Tier-1 auto-locks to locked_set.
    user_confirmed = frozenset(locked_set - tier1_set)
    state = {
        'moves': list(moves),                        # mutable current_moves
        'ocr_lookup': ocr_lookup,
        'total_plies': len(moves),
        'confirmed_ply': int(confirmed_ply) if confirmed_ply else 0,
        'locked_plies': locked_set,
        'tier1_agreed_plies': tier1_set,
        'user_confirmed_plies': user_confirmed,
        'forced_stop_plies': set(forced_stop_plies) if forced_stop_plies else set(),
        'max_backtrack': int(max_backtrack),
        'max_fixes': int(max_fixes),
        # Seed fixed_plies with user-locked plies so greedy never overwrites
        # them. Own fixes are added as they get applied.
        'fixed_plies': set(locked_set),
        'all_fixes': [],
        'iteration': 0,
        'start_time': time.time(),
        'done': False,
        # When done, ``result`` is a fully-populated dict (status, moves,
        # fixes, etc.) that the wrapper turns into a ReconstructionResult and
        # the worker passes back to JS.
        'result': None,
        # Prefix caches for the three forward-replay-heavy calls (per
        # commits d4079d5, c8d41b4): mutated in place across iterations,
        # invalidated whenever moves[F] changes.
        'legal_prefix': LegalPrefixCache(),
        'ead_prefix': EadPrefixCache(),
        'absurdities_prefix': AbsurditiesPrefixCache(),
    }
    # Initial auto-lock pass — covers the case where greedy_init is called
    # mid-game with a move list that has the early plies already legal.
    _recompute_auto_locks(state)
    return state


def _recompute_auto_locks_into(moves, tier1_agreed_plies, locked_set) -> None:
    """Walk ``moves``; for each legal ply that is in ``tier1_agreed_plies``,
    add it to ``locked_set`` (mutated in place). Stop at the first illegal
    move — plies after that are not Tier 1 even if both sheets agreed
    (mirrors the JS ``classifyTiers`` ``stopped = true`` behavior).

    Greedy operates on a single ``state['locked_plies']`` set. Beam/Dijkstra
    have a per-path / per-node ``tier1_locked`` so the helper takes the
    target set explicitly.
    """
    if not tier1_agreed_plies:
        return
    board = chess.Board()
    for ply in range(len(moves)):
        m = try_move(board, moves[ply])
        if m is None:
            return
        board.push(m)
        if ply in tier1_agreed_plies:
            locked_set.add(ply)


def _recompute_auto_locks(state: dict) -> None:
    """Greedy entry point. Mutates ``state['locked_plies']`` to include
    every currently-legal Tier 1 ply. Called after every applied fix in
    greedy_step. Without this, Greedy iter N+1 sees a stale locked set
    (the initial snapshot from when the worker was launched), so it
    considers fixes at plies that a manual "confirm + re-run Greedy"
    would have auto-locked.
    """
    _recompute_auto_locks_into(
        state['moves'], state['tier1_agreed_plies'], state['locked_plies']
    )


def greedy_step(state: dict) -> dict:
    """Run one greedy iteration. Mutates ``state`` in place.

    Returns a dict describing the outcome. Always has ``done``, ``message``,
    ``elapsed``. When ``done=False`` also has ``iteration``, ``stuck_at``,
    ``fix_ply``, ``fix_from``, ``fix_to``, ``fix_score``, ``fixes_so_far``.
    When ``done=True`` also has ``status`` ('VALID' | 'SOLVED' | 'PARTIAL'),
    ``stuck_at`` (if a stuck point was identified), ``fixes_so_far``.

    Output dict is JSON-serializable so the worker can post it to the UI
    thread directly. State dict is NOT JSON-serializable (it contains the
    Python cache objects) but is Pyodide-friendly — JS holds a PyProxy to it
    across step calls.
    """
    if state['done']:
        prior = state.get('result') or {}
        return {
            'done': True,
            'status': prior.get('status', 'DONE'),
            'message': 'Already done',
            'elapsed': round(time.time() - state['start_time'], 1),
            'fixes_so_far': len(state['all_fixes']),
        }

    moves = state['moves']
    total = state['total_plies']
    elapsed = time.time() - state['start_time']

    # === EAD: detect stuck / absurd ===
    # WORKER-CANONICAL: Tier-1 auto-locked plies are deliberately NOT in
    # approved_plies. Tier 1 OCR agreement says "the player wrote that move",
    # not "the resulting chess position is fine". When a locked move creates an
    # absurdity (e.g. Kb1 leaves Q hanging on d2 because earlier 10.W Qd2
    # should have been Qe2), EAD must still fire at the locked ply so Greedy
    # can stop there and Phase 2 backtrack can find the upstream cause. The
    # old Python copy included locked_plies in approved_plies, which made it
    # walk past these absurdities and grind on downstream symptoms.
    #
    # User-confirmed plies (overrides, keep-as-is, applied fixes) ARE approved:
    # the user has deliberately accepted any apparent absurdity at those plies
    # (e.g. an exchange sacrifice). Tier-1 agreed plies are excluded from
    # user_confirmed_plies so this invariant still holds for auto-locks.
    approved = set()
    if state['confirmed_ply'] and state['confirmed_ply'] > 0:
        approved |= set(range(int(state['confirmed_ply'])))
    approved |= state.get('user_confirmed_plies', frozenset())
    ead_ply, stop_reason, _abs_info = play_until_absurd_or_stuck(
        moves, severity_threshold=3, persistence_threshold=2,
        approved_plies=approved, prefix_cache=state['ead_prefix'],
        forced_stop_plies=state.get('forced_stop_plies', set()),
    )
    stuck = ead_ply

    # === Forced-stop ambiguity → SCORE the readings, suggest / keep the best ===
    # The ply is legal but dual-sheet near-tie / very-low-confidence. We run the
    # FULL unified scorer over the candidate readings anchored at this ply (see
    # resolve_forced_stop_choice). The winner may be a CHANGE (e.g. 7.B Ngf6,
    # which reaches much further) — applied like a normal fix — or the KEEP
    # (e.g. 12.B Qb8, when the readings tie on reach and char_sim decides) —
    # surfaced as a keep-marker. Either way the ply is a review step with the
    # candidates PROPERLY SCORED; Greedy proposes, the user confirms/overrides.
    if stop_reason == 'ambiguous':
        marker = resolve_forced_stop_choice(
            moves, stuck, state['ocr_lookup'],
            fixed_plies=state['fixed_plies'], locked_plies=state['locked_plies'],
            min_ply=state['confirmed_ply'], phase2_depth=state['max_backtrack'])
        cur = moves[stuck] if stuck < len(moves) else ''
        state['fixed_plies'].add(stuck)
        state['confirmed_ply'] = max(state['confirmed_ply'], stuck + 1)
        state['iteration'] += 1
        if marker and marker.get('san') and marker['san'] != cur:
            # Proper scoring favours a DIFFERENT reading — apply it as a fix.
            moves[stuck] = marker['san']
            state['legal_prefix'].invalidate_from(stuck)
            state['ead_prefix'].invalidate_from(stuck)
            state['absurdities_prefix'].invalidate_from(stuck)
            state['all_fixes'].append(marker)
            _recompute_auto_locks(state)
            return {
                'done': False, 'iteration': state['iteration'],
                'stuck_at': ply_to_str(stuck),
                'fix_ply': ply_to_str(stuck),
                'fix_from': marker.get('ocr', ''), 'fix_to': marker.get('san', ''),
                'fix_score': marker.get('unified_score', 0),
                'fixes_so_far': len(state['all_fixes']),
                'elapsed': round(elapsed, 1),
                'message': (f"[ambiguity] {ply_to_str(stuck)}: "
                            f"{marker.get('ocr', '')} -> {marker.get('san', '')} "
                            f"(score {marker.get('unified_score', 0):.0f})"),
                'applied_fix': package_review_fix(marker),
            }
        if marker:
            # The KEEP scored highest — move unchanged; surface for review with
            # the properly-scored candidates riding in all_candidates.
            state['all_fixes'].append(marker)
            return {
                'done': False, 'iteration': state['iteration'],
                'stuck_at': ply_to_str(stuck),
                'fix_ply': ply_to_str(stuck),
                'fix_from': marker.get('ocr', ''), 'fix_to': marker.get('san', ''),
                'fix_score': 0,
                'fixes_so_far': len(state['all_fixes']),
                'elapsed': round(elapsed, 1),
                'message': (f"[ambiguity] {ply_to_str(stuck)} kept as-is "
                            f"({marker.get('san', '')}); flagged for review"),
                'applied_fix': package_review_fix(marker),
            }
        # Single legal candidate — nothing to choose. Accept and advance; the
        # 🔍 badge + interactive forced-stop still surface it for review.
        return {
            'done': False, 'iteration': state['iteration'],
            'stuck_at': ply_to_str(stuck),
            'fixes_so_far': len(state['all_fixes']),
            'elapsed': round(elapsed, 1),
            'message': (f"[ambiguity] {ply_to_str(stuck)} kept as-is; "
                        f"flagged for review"),
        }

    # === Reached end? Either we're done, or there are residual absurdities ===
    residual_pending = False
    if stuck >= total:
        residual = find_all_absurdities(moves, prefix_cache=state['absurdities_prefix'])
        residual = [a for a in residual if a.ply not in state['fixed_plies']]
        if not residual:
            # Game reaches the end with no absurdities — done.
            # VALID if no fixes applied (game was already correct);
            # SOLVED if we got here by fixing things.
            already_valid = (len(state['all_fixes']) == 0)
            status = 'VALID' if already_valid else 'SOLVED'
            message = ('Game already valid'
                       if already_valid else
                       f"Solved with {len(state['all_fixes'])} fix(es) in {round(elapsed, 1)}s")
            state['done'] = True
            state['result'] = {
                'status': status,
                'moves': list(moves),
                'fixes': list(state['all_fixes']),
            }
            return {
                'done': True, 'status': status,
                'fixes_so_far': len(state['all_fixes']),
                'elapsed': round(elapsed, 1),
                'message': message,
            }
        # Reached the end but residual absurdities remain — retarget stuck
        # to the earliest residual ply (zero-tolerance, mirrors Qe4 incident).
        stuck = min(a.ply for a in residual)
        residual_pending = True

    # === Find fixes anchored at stuck, with capped lookback ===
    confirmed = state['confirmed_ply']
    locked = state['locked_plies']
    max_backtrack = state['max_backtrack']

    def _search_and_funnel(stuck_ply, stuck_reason=None):
        """Run the two-phase search anchored at ``stuck_ply`` and push the result
        through Greedy's post-search filter funnel. Returns
        ``(fixes, eff_min_ply, phase2_floor, funnel, raw_snapshot, emptied_by)``
        — everything the DIAG/PARTIAL code below consumes. Factored into a local
        so the forward-fallback can re-run the IDENTICAL pipeline at a different
        anchor without duplicating any filter. ``stuck_reason='illegal'``
        suppresses find_fixes' internal EAD re-adjustment, used by the fallback
        so the anchor stays at the downstream illegal move."""
        # Frontier: confirmed_ply unless stale (stuck < confirmed → 0); cap the
        # search window at max_backtrack plies before stuck; unlock stuck itself
        # so a fix there stays proposable even when it's locked.
        frontier = 0 if stuck_ply < confirmed else confirmed
        eff_min_ply = max(frontier, stuck_ply - max_backtrack)
        eff_min_ply = max(0, min(eff_min_ply, stuck_ply))
        eff_locked = set(locked) if locked else set()
        # Unlock stuck so a fix there is proposable — UNLESS stuck is Tier 1
        # agreed (both OCR sheets concur). Tier 1 means "the player wrote this
        # move", so any fix there is almost certainly wrong; the error is
        # upstream, search Phase 2 will find it. The discard remains for
        # stale-confirmation locks (single-sheet locks, user clicked confirm
        # earlier and later evidence contradicts).
        if stuck_ply not in state.get('tier1_agreed_plies', set()):
            eff_locked.discard(stuck_ply)

        # Two-phase search with floor at eff_min_ply. find_fixes_two_phase calls
        # _postprocess_phase2_fixes internally (verify pass), so we don't need to
        # invoke it here.
        _fixes = find_fixes_two_phase(
            moves, stuck_ply, state['ocr_lookup'],
            verbose=False, fixed_plies=state['fixed_plies'],
            locked_plies=eff_locked, min_ply=eff_min_ply,
            phase2_depth=max_backtrack, verify_top_n=15,
            stuck_reason=stuck_reason,
        )

        # Filter funnel — record the surviving candidate count after each post-
        # search filter so an empty result can name WHICH filter emptied it. The
        # PARTIAL message below used to blame "score threshold" unconditionally,
        # which misattributes lock/window/cosmetic drops (and is plain wrong when
        # the engine returned nothing at all). The Fix Suggestions panel shows the
        # RAW two-phase output with none of these post-filters, so a populated
        # panel beside an empty Greedy result means one of these stages cut every
        # candidate. verbose=False above means there's no two-phase trace, so this
        # funnel is the only console window into a premature stop.
        _funnel = [('engine', len(_fixes))]
        # Snapshot the raw engine output (before ANY filter) with the per-candidate
        # flags each filter keys off. When the list empties we dump this so the
        # console shows exactly why each candidate was dropped — without it the
        # GREEDY-DIAG top-5 loop prints nothing on an empty result, hiding the
        # cause. Cheap: a tuple per candidate, only built for the diag dump.
        _raw_snapshot = [
            (f.get('ply', -1), f.get('san', '?'),
             bool(f.get('before_frontier')), bool(f.get('from_heuristic')),
             f.get('unified_score', 0), f.get('reach', -1),
             f.get('reach_improvement', 0))
            for f in _fixes
        ]
        _fixes = [f for f in _fixes if f['ply'] not in state['fixed_plies']]
        _funnel.append(('fixed_plies', len(_fixes)))
        # Window-restrict: Phase 1 → [eff_min_ply, stuck], Phase 2 → [phase2_floor,
        # eff_min_ply). Drop heuristic-extended candidates outside both windows.
        # Exception: from_heuristic-tagged fixes bypass the window check (their
        # narrow suspect-specific heuristic vetted the ply).
        _phase2_floor = max(0, eff_min_ply - max_backtrack)
        _fixes = [
            f for f in _fixes
            if f.get('from_heuristic')
            or (f.get('before_frontier')
                and _phase2_floor <= f['ply'] < eff_min_ply)
            or (not f.get('before_frontier') and f['ply'] >= eff_min_ply)
        ]
        _funnel.append(('window', len(_fixes)))
        # Drop cosmetic no-ops (san == ocr ignoring +/#) EXCEPT the phantom-check
        # repair: when OCR read e.g. "Bf4+" but Bf4 gives no check, the move is
        # illegal in-position and dropping the bogus "+" IS the fix. That candidate
        # ("Bf4") differs from the OCR only by the suffix, so a plain strip-and-
        # compare would delete the ONLY correct fix at the stuck ply before it ever
        # reaches all_candidates (reported: 39.W Bf4+). Keep it when the raw texts
        # differ AND original_was_legal is False (the stuck ply forces this False).
        _fixes = [
            f for f in _fixes
            if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')
            or (f['san'] != f.get('ocr', '') and f.get('original_was_legal') is False)
        ]
        _funnel.append(('cosmetic_noop', len(_fixes)))
        # Score floor — reject deeply-negative cascading fixes.
        _fixes = [f for f in _fixes if f.get('unified_score', 0) >= 0]
        _funnel.append(('score_floor>=0', len(_fixes)))
        # Lock-aware backtrack: when stuck is user-locked, a backtrack candidate
        # that doesn't advance past it can't unstick anything (the lock prevents
        # changing the stuck SAN itself).
        if stuck_ply in locked:
            _fixes = [f for f in _fixes if f.get('reach_improvement', 0) > 0]
        _funnel.append(('lock_reach', len(_fixes)))

        # Which stage took the list to zero: the first stage whose count is 0 while
        # the immediately preceding stage was > 0. If the engine itself returned
        # nothing, attribute it there (no panel candidates to be inconsistent with).
        _emptied = None
        if _funnel[0][1] == 0:
            _emptied = 'engine'
        else:
            for _si in range(1, len(_funnel)):
                if _funnel[_si][1] == 0 and _funnel[_si - 1][1] > 0:
                    _emptied = _funnel[_si][0]
                    break
        return _fixes, eff_min_ply, _phase2_floor, _funnel, _raw_snapshot, _emptied

    fixes, eff_min_ply, phase2_floor, _funnel, _raw_snapshot, _emptied_by = \
        _search_and_funnel(stuck)

    # FORWARD FALLBACK: Greedy anchors on EAD (play_until_absurd_or_stuck), so it
    # halts at the earliest *absurdity* — which can be a Tier-1 locked move whose
    # hanging piece is a sharp-but-real position with no upstream OCR cause (e.g.
    # a knight on d5 attacked by the e6 pawn, defended by c4). The lock-design
    # assumes Phase 2 finds the upstream error, but when there ISN'T one the
    # window yields nothing and Greedy reports "no candidates" — even though the
    # genuinely fixable error is the next ILLEGAL move downstream. The Fix
    # Suggestions panel finds it because it anchors on legality (not EAD) and
    # passes stuck_reason='illegal', which suppresses find_fixes' internal EAD
    # re-adjustment (otherwise it pulls effective_stuck_ply back to the absurd
    # ply and never proposes a fix at the illegal move). Mirror the panel here.
    # Reported case: 20.W flagged absurd, real error 21.W Be5->Be3 (a 3<->5
    # confusion). Guard tightly: only when the EAD stop was an absurdity (not an
    # illegal move we already anchored on), we're not in the residual-absurdity
    # pass (that retargets stuck deliberately), and a real illegal move exists
    # strictly ahead — legality_stuck == total means only the locked absurdity
    # remains, so don't bounce forward (it would loop without making progress).
    if not fixes and stop_reason != 'illegal' and not residual_pending:
        # Probe for the real downstream illegal ply with a FRESH legality scan
        # from ply 0 — NOT the legal_prefix cache. The cache replays forward-only
        # from its cached prefix depth (LegalPrefixCache.play_until_stuck), so if
        # that depth has drifted at/ahead of the first illegal move it returns
        # `total` and this fallback silently fails to bounce forward — leaving
        # Greedy reporting the upstream absurdity (e.g. 21.B) while the genuinely
        # fixable error sits at a later illegal move (e.g. 23.W Rc6). This is a
        # correctness decision, not a hot path (only runs when the absurdity
        # search came back empty), so the O(N) uncached scan is the right call.
        legality_stuck, _ = play_until_stuck(moves)
        if stuck < legality_stuck < total:
            stuck = legality_stuck
            fixes, eff_min_ply, phase2_floor, _funnel, _raw_snapshot, _emptied_by = \
                _search_and_funnel(stuck, stuck_reason='illegal')

    # TEMP DIAG: show top 5 after all filters so we can compare iter-N
    # rankings against manual "confirm + re-run" rankings. The e5-vs-c4
    # case is hunting why two paths with identical state pick differently.
    print(f"[GREEDY-DIAG] iter={state['iteration'] + 1} stuck={ply_to_str(stuck)} "
          f"min_ply={eff_min_ply} confirmed={confirmed} "
          f"locked={sorted(locked)} fixed={sorted(state['fixed_plies'])}:")
    print("[GREEDY-DIAG]   funnel: "
          + " -> ".join(f"{_n}={_c}" for _n, _c in _funnel)
          + (f"  | EMPTIED BY: {_emptied_by}" if not fixes else ""))
    if not fixes and _raw_snapshot:
        # The post-filter list is empty but the engine DID return candidates —
        # dump them with the flags each filter keys off, plus the window bounds,
        # so the drop reason is unambiguous. fixed=already-fixed ply; window=
        # bf-vs-range mismatch (bf needs phase2_floor<=ply<min_ply; non-bf needs
        # ply>=min_ply); from_heuristic bypasses the window.
        print(f"[GREEDY-DIAG]   window bounds: phase2_floor={phase2_floor} "
              f"eff_min_ply={eff_min_ply} stuck={stuck}")
        for _pl, _sn, _bf, _hr, _sc, _rch, _ri in _raw_snapshot[:12]:
            print(f"[GREEDY-DIAG]   raw ply={ply_to_str(_pl)} '{_sn}' "
                  f"bf={_bf} heur={_hr} score={_sc:.0f} "
                  f"reach={ply_to_str(_rch)} reach_impr={_ri}")
    for _i, _f in enumerate(fixes[:5]):
        print(f"[GREEDY-DIAG]   #{_i+1} ply={ply_to_str(_f.get('ply',-1))} "
              f"'{_f.get('ocr','?')}'->'{_f.get('san','?')}' "
              f"score={_f.get('unified_score',0):.0f} "
              f"sim={_f.get('char_sim',0):.0%} "
              f"reach={ply_to_str(_f.get('reach',-1))} "
              f"heur={bool(_f.get('from_heuristic'))} "
              f"bf={bool(_f.get('before_frontier'))} "
              f"abs={_f.get('absurdity_count',0)}")

    if not fixes:
        # PARTIAL: keep already-applied fixes reviewable in the panel. Name the
        # filter that actually emptied the list instead of always blaming a
        # "score threshold" — the panel shows the raw two-phase output (no post-
        # filters), so when it's populated beside this empty result, _emptied_by
        # points at the post-filter that diverged. Only 'engine' means there
        # genuinely were no candidates (panel will be empty too).
        _reason_txt = {
            'engine': "the search produced no candidates",
            'fixed_plies': "every candidate was at an already-fixed ply",
            'window': "every candidate fell outside the backtrack window",
            'cosmetic_noop': "every candidate was a cosmetic no-op",
            'score_floor>=0': "every candidate scored below 0 (Greedy's auto-apply floor)",
            'lock_reach': "the stuck ply is locked and no candidate advanced past it",
        }.get(_emptied_by, "no candidate survived Greedy's filters")
        msg = (f"Stopped at {ply_to_str(stuck)} — {_reason_txt} "
               f"({round(elapsed, 1)}s). Fix Suggestions panel has the ranked "
               f"candidates.")
        state['done'] = True
        state['result'] = {
            'status': 'PARTIAL',
            'moves': list(moves),
            'fixes': list(state['all_fixes']),
            'reached_ply': stuck,
            'stop_reason': stop_reason,
            'stop_message': msg,
        }
        return {
            'done': True, 'status': 'PARTIAL',
            'stuck_at': ply_to_str(stuck),
            'fixes_so_far': len(state['all_fixes']),
            'elapsed': round(elapsed, 1),
            'message': msg,
        }

    # Anti-regression: once Greedy has applied fixes up to max_fixed_ply, any
    # new candidate at ply <= max_fixed_ply is a backward jump (often
    # "fixing" a perfectly legal move that only looks illegal because an
    # earlier Greedy fix subtly shifted the position). Seed max_fixed_ply
    # from own fixes only (worker-canonical: don't seed from locked_plies).
    own_fixed = [f['ply'] for f in state['all_fixes']]
    max_fixed_ply = max(own_fixed) if own_fixed else -1
    best = dict(fixes[0])
    if max_fixed_ply >= 0 and best['ply'] <= max_fixed_ply:
        msg = (f"Backward regression (ply {ply_to_str(best['ply'])} <= max fixed "
               f"{ply_to_str(max_fixed_ply)}) — stopping ({round(elapsed, 1)}s)")
        state['done'] = True
        state['result'] = {
            'status': 'PARTIAL',
            'moves': list(moves),
            'fixes': list(state['all_fixes']),
            'reached_ply': stuck,
            'stop_reason': stop_reason,
            'stop_message': msg,
        }
        return {
            'done': True, 'status': 'PARTIAL',
            'stuck_at': ply_to_str(stuck),
            'fixes_so_far': len(state['all_fixes']),
            'elapsed': round(elapsed, 1),
            'message': msg,
        }

    # Apply the fix.
    best['all_candidates'] = fixes
    # Stamp the PER-FIX stop reason so the review headline can describe WHY
    # this fix's origin_stuck_ply was a stuck point, instead of borrowing the
    # run-global result.stop_reason (which reflects the run's FINAL stuck
    # point — usually a different, later ply than a backtrack proposal's
    # origin). Pairing the per-fix origin ply with the global reason produced
    # nonsense like "23.B Kf7 — bad trade?" (a king move can never be a bad
    # trade). residual_pending retargets `stuck` to a leftover absurdity, so
    # `stop_reason` ('complete' there) is stale — use 'persistent_absurdity'.
    best['origin_stop_reason'] = ('persistent_absurdity' if residual_pending
                                  else stop_reason)
    # Substantiating explanation for a genuine SEE bad-trade verdict. The
    # review headline only prints "bad trade?" when this is present — a bare
    # 'bad_trade' reason with no explanation is unverifiable against the
    # displayed board (it may have fired on Greedy's own corrected line) and
    # must NOT assert a material verdict the user can't see. _abs_info is the
    # bad_trade PersistentAbsurdity here (stop_reason=='bad_trade' implies
    # stuck<total, so residual_pending is False and the reason isn't retargeted).
    best['origin_stop_explanation'] = None
    if not residual_pending and _abs_info is not None:
        _pnames = {'p': 'Pawn', 'n': 'Knight', 'b': 'Bishop',
                   'r': 'Rook', 'q': 'Queen', 'k': 'King'}
        _pname = _pnames.get(str(_abs_info.piece_symbol).lower(), 'piece')
        if stop_reason == 'bad_trade':
            best['origin_stop_explanation'] = (
                f"{_pname} on {_abs_info.square} loses ~{_abs_info.severity} "
                f"in the exchange")
        elif stop_reason == 'piece_hanging':
            # Name the actual hanging piece + square so the review headline
            # reads "Queen on c7 hanging" instead of the bare "piece
            # hanging?" — the user can't act on an unnamed piece, and on a
            # crowded board the hanging one is easy to miss. _abs_info here is
            # the piece_hanging PersistentAbsurdity from
            # play_until_absurd_or_stuck (play.py), carrying piece_symbol +
            # square. Like bad_trade, gated on `not residual_pending` so a
            # retargeted residual absurdity never borrows this _abs_info.
            best['origin_stop_explanation'] = (
                f"{_pname} on {_abs_info.square} hanging")
    moves[best['ply']] = best['san']
    state['legal_prefix'].invalidate_from(best['ply'])
    state['ead_prefix'].invalidate_from(best['ply'])
    state['absurdities_prefix'].invalidate_from(best['ply'])
    state['all_fixes'].append(best)
    state['fixed_plies'].add(best['ply'])
    # Advance the session-confirmed frontier so iter N+1 sees the same
    # search window as "user confirms this fix and re-runs Greedy". Without
    # this, iter N+1 computes effective_min_ply from the caller's original
    # confirmed_ply (typically 0) and picks differently from the manual
    # "confirm + re-run" workflow — the e5/c4 inconsistency from May 2026.
    # Greedy mutating moves[F] is functionally the same as the user
    # accepting the fix, so the frontier should advance in both cases. The
    # _frontier=0 reset rule above still kicks in if a later stuck_at
    # retreats below this frontier (downstream change exposes upstream).
    state['confirmed_ply'] = max(state['confirmed_ply'], best['ply'] + 1)
    state['iteration'] += 1
    # Re-evaluate auto-locks now that current_moves changed at best['ply'].
    # Mirrors the frontend's classifyTiers re-run that happens after every
    # revalidate. Without this, iter N+1 sees the stale lock snapshot.
    _recompute_auto_locks(state)

    # Anti-drift: N consecutive plies fixed in a row means Greedy has
    # diverged and is guessing — every fix extends an alternate-reality
    # position. Threshold=5 gives margin for legitimate capture-chain
    # misreads (dxe5/dxe5/Nxe5 type).
    if len(state['all_fixes']) >= _GREEDY_ANTI_DRIFT_RUN:
        last_plies = [f['ply'] for f in state['all_fixes'][-_GREEDY_ANTI_DRIFT_RUN:]]
        consecutive = all(last_plies[i + 1] == last_plies[i] + 1
                          for i in range(_GREEDY_ANTI_DRIFT_RUN - 1))
        if consecutive:
            plies_str = ', '.join(ply_to_str(p) for p in last_plies)
            msg = (f"Anti-drift: {_GREEDY_ANTI_DRIFT_RUN} consecutive plies fixed "
                   f"({plies_str}) — stopping ({round(elapsed, 1)}s)")
            state['done'] = True
            state['result'] = {
                'status': 'PARTIAL',
                'moves': list(moves),
                'fixes': list(state['all_fixes']),
                'reached_ply': stuck,
                'stop_reason': stop_reason,
                'stop_message': msg,
            }
            return {
                'done': True, 'status': 'PARTIAL',
                'stuck_at': ply_to_str(stuck),
                'fixes_so_far': len(state['all_fixes']),
                'elapsed': round(elapsed, 1),
                'message': msg,
            }

    # Max-fixes safety net (Python had this as `for ... range(max_fixes)`;
    # worker had no explicit cap, just stopped via regression/drift checks).
    # Capping here is safer; the wrapper and worker both benefit.
    if state['iteration'] >= state['max_fixes']:
        msg = (f"Hit max_fixes ({state['max_fixes']}) — stuck at "
               f"{ply_to_str(stuck)} ({round(elapsed, 1)}s)")
        state['done'] = True
        state['result'] = {
            'status': 'PARTIAL',
            'moves': list(moves),
            'fixes': list(state['all_fixes']),
            'reached_ply': stuck,
            'stop_reason': 'max_fixes',
            'stop_message': msg,
        }
        return {
            'done': True, 'status': 'PARTIAL',
            'stuck_at': ply_to_str(stuck),
            'fixes_so_far': len(state['all_fixes']),
            'elapsed': round(elapsed, 1),
            'message': msg,
        }

    # Progress: one fix applied this iter.
    return {
        'done': False,
        'iteration': state['iteration'],
        'stuck_at': ply_to_str(stuck),
        'fix_ply': ply_to_str(best['ply']),
        'fix_from': best.get('ocr', ''),
        'fix_to': best.get('san', ''),
        'fix_score': best.get('unified_score', 0),
        'fixes_so_far': len(state['all_fixes']),
        'elapsed': round(elapsed, 1),
        'message': f"[fix] {ply_to_str(best['ply'])}: {best.get('ocr', '')} -> {best.get('san', '')}",
        # Full review-ready packaging of THIS applied fix (with all_candidates
        # and score-component pills). The JS search-manager accumulates these
        # so an instant Cancel (worker terminate) can rebuild a PARTIAL result
        # with full alternative detail for every fix found so far — without
        # waiting for a long in-flight step to finish. 'best' carries
        # all_candidates (set above) plus the origin_* backtrack metadata.
        'applied_fix': package_review_fix(best),
    }


def run_greedy_search(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove] = None,
    max_fixes: int = 15,
    verbose: bool = False,
    cancel_flag: Dict = None,
    on_progress: Callable[[SearchProgress], None] = None,
    confirmed_ply: int = 0,
    locked_plies: Set[int] = None,
    max_backtrack: int = 5,
) -> ReconstructionResult:
    """
    Greedy reconstruction: iteratively fix one error at a time.

    Algorithm:
    1. Play forward until stuck
    2. Use backtracking to find best fix
    3. Apply fix, repeat

    This is FAST for games with few errors, but may fail on complex
    cases where the "best local fix" isn't globally correct.

    Args:
        moves: List of SAN move strings
        ocr_lookup: Optional OCR data for similarity scoring
        max_fixes: Maximum fixes to attempt before giving up
        verbose: Print debug output
        cancel_flag: Dict with "cancelled" key - set to True to interrupt
        on_progress: Callback for progress updates
        confirmed_ply: Don't propose fixes for plies < this (user-confirmed frontier)
        locked_plies: Plies the user has confirmed — never modify

    Returns:
        ReconstructionResult with status, fixed moves, and metadata
    """
    cancel_flag = cancel_flag or {"cancelled": False}

    # Build OCR lookup if not provided
    if ocr_lookup is None:
        ocr_lookup = create_ocr_lookup(moves_to_ocr_moves(moves))

    if verbose:
        print("=" * 60)
        print("GREEDY SEARCH")
        print("=" * 60)

    state = greedy_init(
        moves, ocr_lookup,
        confirmed_ply=confirmed_ply,
        locked_plies=locked_plies,
        max_backtrack=max_backtrack,
        max_fixes=max_fixes,
    )

    def _emit_progress(step_result: dict):
        if not on_progress:
            return
        on_progress(SearchProgress(
            iteration=state['iteration'],
            max_iterations=max_fixes,
            current_ply=0,
            total_plies=state['total_plies'],
            status=step_result.get('status', 'searching').lower(),
            message=step_result.get('message', ''),
            elapsed=time.time() - state['start_time'],
            fixes_applied=len(state['all_fixes']),
        ))

    while not state['done']:
        if cancel_flag.get("cancelled"):
            elapsed = time.time() - state['start_time']
            if on_progress:
                on_progress(SearchProgress(
                    iteration=state['iteration'], max_iterations=max_fixes,
                    current_ply=0, total_plies=state['total_plies'],
                    status='cancelled', message='Search cancelled by user',
                    elapsed=elapsed, fixes_applied=len(state['all_fixes']),
                ))
            return ReconstructionResult(
                status="CANCELLED",
                path=state['moves'],
                fixes=state['all_fixes'],
                elapsed=elapsed,
                method="greedy",
            )
        step_result = greedy_step(state)
        _emit_progress(step_result)
        if verbose and step_result.get('message'):
            print(f"   {step_result['message']}")

    result = state['result'] or {}
    return ReconstructionResult(
        status=result.get('status', 'PARTIAL'),
        path=state['moves'],
        fixes=state['all_fixes'],
        elapsed=time.time() - state['start_time'],
        method="greedy",
    )


# =============================================================================
# BEAM SEARCH (Multi-path exploration)
# =============================================================================

@dataclass
class BeamPath:
    """A single hypothesis in beam search."""
    moves: List[str]
    fixes: List[dict]
    fixed_plies: Set[int]
    cumulative_cost: float = 0.0
    last_stuck_ply: int = -1
    # Per-path Tier 1 auto-locks. Different paths have different moves and
    # therefore different legal prefixes, so the reachable Tier 1 set is
    # path-specific (state['locked_plies'] holds only the game-level static
    # user locks shared across paths). Recomputed via
    # ``_recompute_auto_locks_into`` after every applied fix.
    tier1_locked: Set[int] = field(default_factory=set)
    # Per-path caches — paths diverge after branching, so sharing a cache
    # instance across siblings would let one path's invalidate corrupt
    # another's prefix. ``copy()`` clones them alongside the move list.
    legal_prefix: LegalPrefixCache = field(default_factory=LegalPrefixCache)
    ead_prefix: EadPrefixCache = field(default_factory=EadPrefixCache)
    absurdities_prefix: AbsurditiesPrefixCache = field(default_factory=AbsurditiesPrefixCache)

    def copy(self) -> 'BeamPath':
        return BeamPath(
            moves=self.moves.copy(),
            fixes=self.fixes.copy(),
            fixed_plies=self.fixed_plies.copy(),
            cumulative_cost=self.cumulative_cost,
            last_stuck_ply=self.last_stuck_ply,
            tier1_locked=self.tier1_locked.copy(),
            legal_prefix=self.legal_prefix.copy(),
            ead_prefix=self.ead_prefix.copy(),
            absurdities_prefix=self.absurdities_prefix.copy(),
        )


# Two-function API: ``beam_init`` builds a state dict, ``beam_step`` advances
# it by one iteration. Both ``run_beam_search`` (the CLI/test in-process loop
# in this file) and ``search-worker.js`` call into this single implementation.
# Before this split, Beam lived in two places with material divergence:
# find_deep_backtrack_fixes vs find_fixes_two_phase, locked_plies in EAD
# approved set vs not, missing phase2_floor window discipline in the Python
# copy, no all_candidates cache, no fixed_plies seeding from user locks, etc.
# CLI tests only exercised the Python copy so the worker's worker-only
# improvements were invisible until something broke in browser.
#
# Worker-canonical: find_fixes_two_phase + verify_top_n=15, phase2_floor
# window with from_heuristic/before_frontier exemption, EAD approved = pre-
# frontier prefix only (locked NOT included — see greedy comment for why),
# fixed_plies seeded with user locks, VALID vs SOLVED distinction. Per-path
# prefix caches come from the Python copy and are layered on top here.

_BEAM_LAMBDA = 21  # per-stuck-point base penalty (regret scoring)


def beam_init(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove],
    *,
    confirmed_ply: int = 0,
    locked_plies: Optional[Set[int]] = None,
    tier1_agreed_plies: Optional[Set[int]] = None,
    beam_width: int = 5,
    max_iterations: int = 20,
    max_fixes_per_path: int = 10,
    max_backtrack: int = 5,
    forced_stop_plies: Optional[Set[int]] = None,
) -> dict:
    """Build a beam search state dict. See beam_step for the iteration.

    ``forced_stop_plies``: see greedy_init. A path that reaches a forced-stop
    ply is parked (not expanded) — beam defers the ambiguity to the user
    instead of guessing a candidate.

    ``tier1_agreed_plies``: see greedy_init. Beam tracks an auto-lock set
    per-path (``BeamPath.tier1_locked``) because different paths have
    different legal prefixes and therefore different reachable Tier 1 plies.
    """
    locked_set = set(locked_plies) if locked_plies else set()
    tier1_set = set(tier1_agreed_plies) if tier1_agreed_plies else set()
    initial_path = BeamPath(
        moves=list(moves),
        fixes=[],
        # Seed with user locks (worker-canonical): residual-absurdity
        # retargeting excludes plies the user has confirmed or that are
        # tier-1 merge-locked. Without this, Beam can retarget to an
        # "absurdity" at a locked ply, open a 1-ply search window there,
        # and dead-end with zero fixes even when greedy finds the right
        # cascade one ply further on.
        fixed_plies=set(locked_set),
        cumulative_cost=0.0,
        last_stuck_ply=-1,
    )
    state = {
        'method': 'beam',
        'beam': [initial_path],
        'ocr_lookup': ocr_lookup,
        'total_plies': len(moves),
        'confirmed_ply': int(confirmed_ply) if confirmed_ply else 0,
        'locked_plies': locked_set,
        'tier1_agreed_plies': tier1_set,
        'beam_width': int(beam_width),
        'max_iterations': int(max_iterations),
        'max_fixes_per_path': int(max_fixes_per_path),
        'max_backtrack': int(max_backtrack),
        'forced_stop_plies': set(forced_stop_plies) if forced_stop_plies else set(),
        'iteration': 0,
        'start_time': time.time(),
        'done': False,
        'result': None,
        'prev_best_reach': -1,
        'prev_best_cost': -1.0,
        'stall_count': 0,
    }
    # Initial auto-lock pass on the seed path (mirrors greedy_init).
    _recompute_auto_locks_into(initial_path.moves, tier1_set, initial_path.tier1_locked)
    return state


def _beam_winning_fixes(fixes_list):
    """Build the {ply_str, ocr, san, score} list the UI renders on done."""
    return [{
        'ply_str': ply_to_str(f['ply']),
        'ocr': f.get('ocr', ''),
        'san': f.get('san', ''),
        'score': f.get('unified_score', 0),
    } for f in fixes_list]


def beam_step(state: dict) -> dict:
    """Run one beam iteration. Mutates ``state`` in place. JSON-serializable
    return dict (same contract as greedy_step). State dict carries class
    instances (BeamPath, prefix caches) and is NOT JSON-serializable, but is
    Pyodide-friendly — JS holds a PyProxy across step calls.
    """
    if state['done']:
        prior = state.get('result') or {}
        return {
            'done': True,
            'status': prior.get('status', 'DONE'),
            'message': 'Already done',
            'elapsed': round(time.time() - state['start_time'], 1),
            'fixes_so_far': len(prior.get('fixes', [])),
        }

    beam = state['beam']
    total = state['total_plies']
    beam_width = state['beam_width']
    elapsed = time.time() - state['start_time']
    LAMBDA = _BEAM_LAMBDA
    tier1 = state.get('tier1_agreed_plies', set())
    confirmed = state['confirmed_ply']
    max_backtrack = state['max_backtrack']
    locked = state['locked_plies']

    # === Guard 1: max_iterations cap ===
    if state['iteration'] >= state['max_iterations']:
        best = max(beam, key=lambda p: _score_path(p, total))
        best_reach, _ = best.legal_prefix.play_until_stuck(best.moves)
        state['done'] = True
        state['result'] = {
            'status': 'PARTIAL', 'moves': best.moves, 'fixes': best.fixes,
            'reached_ply': best_reach,
        }
        return {
            'done': True, 'status': 'PARTIAL',
            'fixes_so_far': len(best.fixes),
            'elapsed': round(elapsed, 1),
            'winning_fixes': _beam_winning_fixes(best.fixes),
            'message': (f"Max iterations ({state['max_iterations']}) reached "
                        f"({round(elapsed, 1)}s)"),
        }

    # === Check for complete paths ===
    # Strict: a path is only SOLVED if zero absurdities remain. Any lingering
    # absurdity (e.g. a hanging queen the opponent failed to take) must be
    # fixed by beam — we would rather fail than ship a silent blunder.
    #
    # Unresolved forced-stop plies (dual-sheet ambiguity / very-low-confidence)
    # also block completion: a path that plays THROUGH one is not valid — the
    # user must choose first. legal_prefix.play_until_stuck below is legality-
    # only and can't see forced stops, so guard explicitly. Earliest unresolved
    # one is past the confirmed frontier (resolved plies sit before it).
    _forced = state.get('forced_stop_plies', set())
    for path in beam:
        reach, _ = path.legal_prefix.play_until_stuck(path.moves)
        # Per-path: a forced stop this path already CHOSE at (fixed_plies) is
        # resolved and no longer blocks completion.
        _ef = min((p for p in _forced
                   if p >= confirmed and p < total and p not in path.fixed_plies),
                  default=None)
        if _ef is not None and _ef < reach:
            continue  # path passed an unresolved ambiguity — not complete
        if reach >= total:
            absurdities = find_all_absurdities(path.moves, prefix_cache=path.absurdities_prefix)
            absurdities = [a for a in absurdities if a.ply not in path.fixed_plies]
            if len(absurdities) == 0:
                # Already-valid → VALID; otherwise SOLVED. A beam path with
                # zero fixes that reaches the end with no absurdities is the
                # original game, untouched.
                already_valid = (len(path.fixes) == 0)
                status = 'VALID' if already_valid else 'SOLVED'
                message = ('Game already valid' if already_valid
                           else f"Solved with {len(path.fixes)} fix(es) "
                                f"in {round(elapsed, 1)}s")
                state['done'] = True
                state['result'] = {
                    'status': status, 'moves': path.moves, 'fixes': path.fixes,
                }
                return {
                    'done': True, 'status': status,
                    'fixes_so_far': len(path.fixes),
                    'elapsed': round(elapsed, 1),
                    'winning_fixes': _beam_winning_fixes(path.fixes),
                    'message': message,
                }

    # === Expand paths ===
    new_beam = []
    step_fixes = []
    any_expanded = False

    for path in beam:
        if len(path.fixes) >= state['max_fixes_per_path']:
            new_beam.append(path)  # Keep but don't expand
            continue

        # Approved-plies set: pre-frontier prefix ONLY. locked_plies are
        # deliberately NOT included — see greedy_step for the full rationale
        # on why suppressing absurdity at locked plies makes the search
        # start at the wrong place.
        approved = set()
        if confirmed and confirmed > 0:
            approved |= set(range(int(confirmed)))
        ead_ply, _stop_reason, _ = play_until_absurd_or_stuck(
            path.moves, severity_threshold=3, persistence_threshold=2,
            approved_plies=approved, prefix_cache=path.ead_prefix,
            # A forced-stop ply this path already CHOSE at (in fixed_plies) is
            # resolved — don't re-stop on it, or beam would loop / never finish.
            forced_stop_plies=state.get('forced_stop_plies', set()) - path.fixed_plies,
        )
        reach = ead_ply

        # stop_reason 'ambiguous' (forced-stop ply) is handled like any other
        # stop: fall through so the two-phase search ranks the OCR candidates by
        # reach and branches on the best (e.g. Qb8 over the downstream-hanging
        # Rb8). The completeness guard above already prevented this path from
        # being declared VALID by playing through the ambiguity. When reach
        # can't decide, the search finds no fix and the path is parked below.

        if reach >= total:
            # EAD's persistence_threshold can skip short-lived absurdities
            # (hanging queen, opponent fails to capture, game ends soon
            # after). Catch those via find_all_absurdities and re-target
            # the earliest as the new stuck point so beam keeps repairing.
            residual = find_all_absurdities(path.moves, prefix_cache=path.absurdities_prefix)
            residual = [a for a in residual if a.ply not in path.fixed_plies]
            if not residual:
                new_beam.append(path)
                continue
            reach = min(a.ply for a in residual)

        # Dead-end: stuck at same ply as last time, no point re-expanding
        if reach == path.last_stuck_ply and reach < total:
            new_beam.append(path)
            continue

        # Bounded search window: anchor at reach, cap lookback at
        # max_backtrack, unlock reach itself (unless Tier 1 agreed — then
        # OCR is almost certainly correct and the error is upstream).
        _frontier = 0 if reach < confirmed else confirmed
        eff_min_ply = max(_frontier, reach - max_backtrack)
        eff_min_ply = max(0, min(eff_min_ply, reach))
        # Compose effective locks: game-level + this path's auto-locks.
        if locked or path.tier1_locked:
            eff_locked = set(locked) | set(path.tier1_locked)
        else:
            eff_locked = set()
        if reach not in tier1:
            eff_locked.discard(reach)

        # Two-phase search — see greedy_step for rationale. min_ply =
        # synthetic max_backtrack frontier so Phase 2 fires in batch /
        # algo-review mode too.
        fixes = find_fixes_two_phase(
            path.moves, reach, state['ocr_lookup'],
            verbose=False, fixed_plies=path.fixed_plies,
            locked_plies=eff_locked, min_ply=eff_min_ply,
            phase2_depth=max_backtrack, verify_top_n=15,
        )
        # Keep the phantom-check repair (e.g. illegal "Bf4+" → "Bf4"); see
        # greedy_step for the full rationale.
        fixes = [
            f for f in fixes
            if f['san'].rstrip('+#') != f.get('ocr', '').rstrip('+#')
            or (f['san'] != f.get('ocr', '') and f.get('original_was_legal') is False)
        ]
        # Restrict to declared Phase 1 + Phase 2 windows; drop heuristic
        # extensions outside both. from_heuristic exemption + before_frontier
        # window discipline — see greedy_step for the full rationale.
        phase2_floor = max(0, eff_min_ply - max_backtrack)
        fixes = [
            f for f in fixes
            if f.get('from_heuristic')
            or (f.get('before_frontier')
                and phase2_floor <= f.get('ply', 0) < eff_min_ply)
            or (not f.get('before_frontier') and f.get('ply', 0) >= eff_min_ply)
        ]
        # Defensive: drop any fix at a locked ply. find_fixes_two_phase
        # honours locked_plies internally, but find_deep_backtrack_fixes's
        # extended_search_plies heuristic (piece-blocker / check-mismatch
        # hits) can reach into them.
        if eff_locked:
            fixes = [f for f in fixes
                     if f.get('ply', 0) not in eff_locked]

        # Forced-stop ambiguity: SCORE the readings (proper unified score, see
        # resolve_forced_stop_choice) and either apply the best CHANGE or KEEP the
        # current reading. Either way mark the ply resolved (fixed_plies) so the
        # path proceeds past it and the completeness guard + play call don't
        # re-stop or block completion. Record the marker as a review step.
        if _stop_reason == 'ambiguous':
            marker = resolve_forced_stop_choice(
                path.moves, reach, state['ocr_lookup'],
                fixed_plies=path.fixed_plies, locked_plies=eff_locked,
                min_ply=eff_min_ply, phase2_depth=max_backtrack)
            _cur = path.moves[reach] if reach < len(path.moves) else ''
            path.fixed_plies.add(reach)
            # Parking a forced stop IS progress: the path's frontier advanced
            # (fixed_plies grew), so on the next iteration it completes or moves
            # to the next stuck point. Without this, a path whose only remaining
            # work is a forced stop (esp. a single-legal one resolved to None)
            # leaves any_expanded False -> Guard 2 wrongly reports PARTIAL on a
            # game that actually reaches the end.
            any_expanded = True
            if marker and marker.get('san') and marker['san'] != _cur:
                # Proper scoring favours a different reading — apply it.
                path.moves[reach] = marker['san']
                path.legal_prefix.invalidate_from(reach)
                path.ead_prefix.invalidate_from(reach)
                path.absurdities_prefix.invalidate_from(reach)
                path.fixes.append(dict(marker))
                _recompute_auto_locks_into(path.moves, tier1, path.tier1_locked)
                path.last_stuck_ply = -1   # re-evaluate from the new move
            else:
                if marker:
                    path.fixes.append(dict(marker))   # keep + review
                path.last_stuck_ply = reach
            new_beam.append(path)
            continue

        # TEMP DIAG: same contract as GREEDY-DIAG. Mirrors the iter-N
        # ranking so we can compare beam's branch picks against the manual
        # confirm + re-run case during debug.
        print(f"[BEAM-DIAG] iter={state['iteration'] + 1} "
              f"path_fixes={len(path.fixes)} reach={ply_to_str(reach)} "
              f"min_ply={eff_min_ply} confirmed={confirmed} "
              f"eff_locked={sorted(eff_locked)} "
              f"path_fixed={sorted(path.fixed_plies)}:")
        for _i, _f in enumerate(fixes[:5]):
            print(f"[BEAM-DIAG]   #{_i+1} ply={ply_to_str(_f.get('ply',-1))} "
                  f"'{_f.get('ocr','?')}'->'{_f.get('san','?')}' "
                  f"score={_f.get('unified_score',0):.0f} "
                  f"sim={_f.get('char_sim',0):.0%} "
                  f"reach={ply_to_str(_f.get('reach',-1))} "
                  f"heur={bool(_f.get('from_heuristic'))} "
                  f"bf={bool(_f.get('before_frontier'))} "
                  f"abs={_f.get('absurdity_count',0)}")

        if not fixes:
            path.last_stuck_ply = reach
            new_beam.append(path)
            continue

        # This path actually produced new branches.
        any_expanded = True
        num_branches = min(beam_width, len(fixes), 3)
        best_score = fixes[0].get('unified_score', 0)
        first_fix = fixes[0]
        step_fixes.append({
            'ply_str': ply_to_str(first_fix['ply']),
            'ocr': first_fix.get('ocr', ''),
            'san': first_fix.get('san', ''),
            'regret': 0,
            'num_branches': num_branches,
        })

        for fix in fixes[:num_branches]:
            new_path = path.copy()
            new_path.moves[fix['ply']] = fix['san']
            new_path.legal_prefix.invalidate_from(fix['ply'])
            new_path.ead_prefix.invalidate_from(fix['ply'])
            new_path.absurdities_prefix.invalidate_from(fix['ply'])
            # Cache the full ranked candidate list on the chosen fix so the
            # Review UI can show alternatives without another backtrack run
            # (mirrors Greedy's pattern).
            fix_with_cands = dict(fix)
            fix_with_cands['all_candidates'] = fixes
            new_path.fixes.append(fix_with_cands)
            new_path.fixed_plies.add(fix['ply'])

            # Regret = how much worse than the best fix at this stuck point
            this_score = fix.get('unified_score', 0)
            regret = max(0, best_score - this_score)
            new_path.cumulative_cost += LAMBDA + regret
            new_path.last_stuck_ply = reach

            # Recompute per-path tier1 auto-locks — moves[fix['ply']] just
            # changed, which may unlock or re-lock downstream Tier 1 plies.
            _recompute_auto_locks_into(new_path.moves, tier1, new_path.tier1_locked)

            new_beam.append(new_path)

    if not new_beam:
        state['done'] = True
        state['result'] = {
            'status': 'FAILED',
            'moves': beam[0].moves if beam else [],
            'fixes': [],
        }
        return {
            'done': True, 'status': 'FAILED',
            'elapsed': round(elapsed, 1),
            'message': f"No paths remain ({round(elapsed, 1)}s)",
        }

    # Score and prune beam.
    scored = sorted(new_beam, key=lambda p: _score_path(p, total), reverse=True)
    state['beam'] = scored[:beam_width]
    state['iteration'] += 1

    best = state['beam'][0]
    best_reach, _ = best.legal_prefix.play_until_stuck(best.moves)
    best_cost = best.cumulative_cost

    # === Guard 2: all paths exhausted (none expanded) ===
    if not any_expanded:
        state['done'] = True
        state['result'] = {
            'status': 'PARTIAL', 'moves': best.moves, 'fixes': best.fixes,
            'reached_ply': best_reach,
        }
        return {
            'done': True, 'status': 'PARTIAL',
            'fixes_so_far': len(best.fixes),
            'elapsed': round(elapsed, 1),
            'winning_fixes': _beam_winning_fixes(best.fixes),
            'message': f"All paths exhausted ({round(elapsed, 1)}s)",
        }

    # === Guard 3: stall detection (5 iters, no progress) ===
    if best_reach == state['prev_best_reach'] and best_cost == state['prev_best_cost']:
        state['stall_count'] += 1
    else:
        state['stall_count'] = 0
    state['prev_best_reach'] = best_reach
    state['prev_best_cost'] = best_cost

    if state['stall_count'] >= 5:
        state['done'] = True
        state['result'] = {
            'status': 'PARTIAL', 'moves': best.moves, 'fixes': best.fixes,
            'reached_ply': best_reach,
        }
        return {
            'done': True, 'status': 'PARTIAL',
            'fixes_so_far': len(best.fixes),
            'elapsed': round(elapsed, 1),
            'winning_fixes': _beam_winning_fixes(best.fixes),
            'message': (f"Stalled for 5 iterations at {ply_to_str(best_reach)} "
                        f"({round(elapsed, 1)}s)"),
        }

    return {
        'done': False,
        'iteration': state['iteration'],
        'paths_in_beam': len(state['beam']),
        'best_reach': best_reach,
        'best_reach_str': ply_to_str(best_reach),
        'best_fixes': len(best.fixes),
        'best_cost': best_cost,
        'total_plies': total,
        'elapsed': round(elapsed, 1),
        'fixes_this_step': step_fixes,
        'message': (f"Beam iter {state['iteration']}: {len(state['beam'])} paths, "
                    f"best at {ply_to_str(best_reach)}/{total} "
                    f"({len(best.fixes)} fixes, cost={int(best_cost)})"),
    }


def run_beam_search(
    moves: List[str],
    ocr_lookup: Dict[int, OCRMove] = None,
    beam_width: int = 5,
    max_iterations: int = 20,
    max_fixes_per_path: int = 10,
    verbose: bool = False,
    cancel_flag: Dict = None,
    on_progress: Callable[[SearchProgress], None] = None,
    confirmed_ply: int = 0,
    locked_plies: Set[int] = None,
    tier1_agreed_plies: Set[int] = None,
    max_backtrack: int = 5,
) -> ReconstructionResult:
    """Beam search reconstruction: explore multiple paths in parallel.

    Thin loop around ``beam_init`` + ``beam_step``. Both this wrapper and
    the browser's ``search-worker.js`` share that one canonical step
    implementation; see the comment above beam_init for the full history.
    """
    cancel_flag = cancel_flag or {"cancelled": False}

    if ocr_lookup is None:
        ocr_lookup = create_ocr_lookup(moves_to_ocr_moves(moves))

    if verbose:
        print("=" * 60)
        print(f"BEAM SEARCH (width={beam_width})")
        print("=" * 60)

    state = beam_init(
        moves, ocr_lookup,
        confirmed_ply=confirmed_ply, locked_plies=locked_plies,
        tier1_agreed_plies=tier1_agreed_plies,
        beam_width=beam_width, max_iterations=max_iterations,
        max_fixes_per_path=max_fixes_per_path,
        max_backtrack=max_backtrack,
    )

    def _emit_progress(step_result: dict):
        if not on_progress:
            return
        on_progress(SearchProgress(
            iteration=state['iteration'],
            max_iterations=max_iterations,
            current_ply=0,
            total_plies=state['total_plies'],
            status=step_result.get('status', 'searching').lower(),
            message=step_result.get('message', ''),
            elapsed=time.time() - state['start_time'],
            fixes_applied=0,
        ))

    while not state['done']:
        if cancel_flag.get("cancelled"):
            elapsed = time.time() - state['start_time']
            best = max(state['beam'], key=lambda p: _score_path(p, state['total_plies']))
            if on_progress:
                on_progress(SearchProgress(
                    iteration=state['iteration'], max_iterations=max_iterations,
                    current_ply=0, total_plies=state['total_plies'],
                    status='cancelled', message='Search cancelled by user',
                    elapsed=elapsed, fixes_applied=0,
                ))
            return ReconstructionResult(
                status="CANCELLED",
                path=best.moves, fixes=best.fixes,
                elapsed=elapsed, method="beam",
            )
        step_result = beam_step(state)
        _emit_progress(step_result)
        if verbose and step_result.get('message'):
            print(f"   {step_result['message']}")

    result = state['result'] or {}
    return ReconstructionResult(
        status=result.get('status', 'PARTIAL'),
        path=result.get('moves', state['beam'][0].moves if state['beam'] else moves),
        fixes=result.get('fixes', []),
        elapsed=time.time() - state['start_time'],
        method="beam",
    )


def _score_path(path: BeamPath, total_plies: int) -> tuple:
    """Score a beam path for ranking. Higher is better."""
    reach, _ = path.legal_prefix.play_until_stuck(path.moves)
    completes = 1 if reach >= total_plies else 0
    reach_ratio = reach / total_plies if total_plies > 0 else 0
    num_fixes = len(path.fixes)

    return (completes, reach_ratio, -path.cumulative_cost, -num_fixes)


# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

# =============================================================================
# BACKWARDS-COMPATIBLE WRAPPERS (for beam_search.py migration)
# =============================================================================

def reconstruct_game_beam(
    ocr_moves: List[OCRMove],
    beam_width: int = 10,
    max_fixes_per_path: int = 10,
    verbose: bool = True,
    progress_callback: Callable = None,
    collect_iterations: bool = False
) -> ReconstructionResult:
    """
    Beam search reconstruction - wrapper for OCRMove input.

    This maintains compatibility with the old beam_search.py interface.

    Parameters:
    - ocr_moves: List of OCRMove objects from OCR
    - beam_width: Number of parallel hypotheses to maintain
    - max_fixes_per_path: Maximum fixes per path before giving up
    - verbose: Print progress
    - progress_callback: Callback for progress updates
    - collect_iterations: If True, collect iteration details for debug output

    Returns ReconstructionResult with best path found.
    """
    moves = ocr_moves_to_list(ocr_moves)
    ocr_lookup = create_ocr_lookup(ocr_moves)

    # Create a wrapper for progress callback
    def on_progress(progress: SearchProgress):
        if progress_callback:
            progress_callback(progress.iteration, progress.max_iterations, 0)

    result = run_beam_search(
        moves=moves,
        ocr_lookup=ocr_lookup,
        beam_width=beam_width,
        max_iterations=max_fixes_per_path * 3,
        max_fixes_per_path=max_fixes_per_path,
        verbose=verbose,
        on_progress=on_progress if progress_callback else None
    )

    # Add iterations attribute if requested (for API compatibility)
    if collect_iterations:
        result.iterations = []  # Simplified - could track in run_beam_search

    return result


def reconstruct_with_deep_backtrack(
    moves: List[str],
    verbose: bool = True,
    max_fixes: int = 10
) -> ReconstructionResult:
    """
    Greedy reconstruction using deep backtrack.

    This is a wrapper around run_greedy_search for backward compatibility
    with the old beam_search.py interface.

    Parameters:
    - moves: List of SAN move strings
    - verbose: Print progress
    - max_fixes: Maximum fixes to apply

    Returns ReconstructionResult.
    """
    return run_greedy_search(
        moves=moves,
        max_fixes=max_fixes,
        verbose=verbose
    )


def reconstruct_game(
    ocr_moves: List[OCRMove],
    method: str = "greedy",
    verbose: bool = True,
    progress_callback: Callable = None,
    **kwargs
) -> ReconstructionResult:
    """
    Main reconstruction entry point - wrapper for OCRMove input.

    This maintains compatibility with the old beam_search.py interface.

    Parameters:
    - ocr_moves: List of OCRMove objects
    - method: "greedy" or "beam"
    - verbose: Print progress
    - **kwargs: Additional arguments passed to specific method

    Returns ReconstructionResult.
    """
    if method == "beam":
        return reconstruct_game_beam(
            ocr_moves,
            verbose=verbose,
            progress_callback=progress_callback,
            **kwargs
        )
    else:
        moves = ocr_moves_to_list(ocr_moves)
        return reconstruct_with_deep_backtrack(moves, verbose=verbose, **kwargs)


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def search_with_timeout(
    moves: List[str],
    method: str = "greedy",
    timeout: float = 30.0,
    **kwargs
) -> ReconstructionResult:
    """
    Run search with automatic timeout.
    
    Note: This uses a simple polling approach. For true async cancellation,
    use threading with cancel_flag.
    """
    import threading
    
    cancel_flag = {"cancelled": False}
    result_holder = {"result": None}
    
    def run_search():
        if method == "beam":
            result_holder["result"] = run_beam_search(
                moves, cancel_flag=cancel_flag, **kwargs
            )
        else:
            result_holder["result"] = run_greedy_search(
                moves, cancel_flag=cancel_flag, **kwargs
            )
    
    thread = threading.Thread(target=run_search)
    thread.start()
    thread.join(timeout=timeout)
    
    if thread.is_alive():
        cancel_flag["cancelled"] = True
        thread.join(timeout=2.0)  # Give it a moment to clean up
        
        if result_holder["result"] is None:
            return ReconstructionResult(
                status="TIMEOUT",
                path=moves,
                fixes=[],
                elapsed=timeout,
                method=method
            )
    
    return result_holder["result"]


# =============================================================================
# BACKGROUND WORKER RECONSTRUCTION (thin wrappers for search-worker.js)
# =============================================================================
# These are thin wrappers around the existing run_greedy_search / run_beam_search.
# They accept raw OCR data (list of tuples) and user_fixes, convert to the proper
# OCRMove format, apply user fixes, then delegate to the existing working functions.
# =============================================================================

def reconstruct_greedy_background(
    moves_list, ocr_lookup_raw,
    locked_plies=None, user_fixes=None,
    max_fixes=15, confirmed_ply=0, max_backtrack=5
):
    """
    Background greedy search wrapper.

    Args:
        moves_list: List[str] of SAN moves (top OCR candidates)
        ocr_lookup_raw: Dict[int, List[Tuple[str, float]]] - raw OCR candidates per ply
        locked_plies: Set of plies the user has fixed (never modify)
        user_fixes: Dict[int, str] of live user fixes
        max_fixes: Max fix iterations
        confirmed_ply: Don't propose fixes before this ply (review frontier)
    """
    if user_fixes is None:
        user_fixes = {}

    # Apply user fixes to the move list before searching
    moves = list(moves_list)
    for ply, san in user_fixes.items():
        if ply < len(moves):
            moves[int(ply)] = san

    # Normalize locked_plies (JSON may send list / int-keyed)
    locked_set = set(int(p) for p in locked_plies) if locked_plies else set()

    # Convert raw OCR lookup to proper OCRMove format
    ocr_lookup = _raw_to_ocr_lookup(ocr_lookup_raw, moves)

    # Delegate to the existing working greedy search, honoring the review frontier.
    result = run_greedy_search(
        moves, ocr_lookup=ocr_lookup, max_fixes=max_fixes, verbose=False,
        confirmed_ply=int(confirmed_ply or 0), locked_plies=locked_set,
        max_backtrack=int(max_backtrack or 5),
    )

    # Convert ReconstructionResult to dict for JSON serialization
    return _result_to_dict(result)


def reconstruct_beam_background(
    moves_list, ocr_lookup_raw,
    locked_plies=None, user_fixes=None,
    beam_width=5, max_fixes=3,
    confirmed_ply=0, max_backtrack=5
):
    """
    Background beam search wrapper.

    Args:
        moves_list: List[str] of SAN moves (top OCR candidates)
        ocr_lookup_raw: Dict[int, List[Tuple[str, float]]] - raw OCR candidates per ply
        locked_plies: Set of plies the user has fixed (never modify)
        user_fixes: Dict[int, str] of live user fixes
        beam_width: Number of parallel paths
        max_fixes: Max fixes per path
        confirmed_ply: Lower bound for fix proposals (review frontier).
    """
    if user_fixes is None:
        user_fixes = {}
    if locked_plies is None:
        locked_plies = set()
    else:
        locked_plies = set(locked_plies)

    # Apply user fixes to the move list before searching
    moves = list(moves_list)
    for ply, san in user_fixes.items():
        if ply < len(moves):
            moves[ply] = san

    # Convert raw OCR lookup to proper OCRMove format
    ocr_lookup = _raw_to_ocr_lookup(ocr_lookup_raw, moves)

    # Delegate to the existing working beam search, forwarding the review
    # frontier + locked-ply set so Beam respects the same boundaries Greedy
    # does. Without this, overrides during a Greedy-partial review didn't
    # constrain Beam on the escalation step — Beam happily proposed fixes
    # at plies before the override.
    result = run_beam_search(
        moves, ocr_lookup=ocr_lookup, beam_width=beam_width,
        max_fixes_per_path=max_fixes, verbose=False,
        confirmed_ply=int(confirmed_ply or 0),
        locked_plies=locked_plies,
        max_backtrack=int(max_backtrack or 5),
    )

    # Convert ReconstructionResult to dict for JSON serialization
    return _result_to_dict(result)


def _raw_to_ocr_lookup(ocr_lookup_raw, moves):
    """Convert raw ply->[(san, conf)] dict to Dict[int, OCRMove]."""
    ocr_lookup = {}
    for ply, candidates in ocr_lookup_raw.items():
        ply = int(ply)  # JSON keys may be strings
        if not candidates:
            continue
        move_number = ply // 2 + 1
        color = 'w' if ply % 2 == 0 else 'b'
        # OCRMove expects candidates as List[Tuple[str, float]]
        ocr_lookup[ply] = OCRMove(
            move_number=move_number,
            color=color,
            candidates=[(c[0], c[1]) for c in candidates]
        )
    return ocr_lookup


def _result_to_dict(result):
    """Convert ReconstructionResult to a plain dict for JSON serialization."""
    def _sim_pct(fix_dict):
        # Phase 3 fixes store 'similarity' as 0-100; Phase 2 fixes store
        # 'char_sim' as 0-1. Normalize to a 0-100 int for the UI.
        if 'similarity' in fix_dict and fix_dict['similarity'] is not None:
            return int(round(fix_dict['similarity']))
        cs = fix_dict.get('char_sim')
        if cs is None:
            return 0
        return int(round(cs * 100))

    fixes_applied = []
    for f in (result.fixes or []):
        fix_ply = f.get('ply', 0)
        entry = {
            'ply': fix_ply,
            'ply_str': f.get('ply_str', '') or ply_to_str(fix_ply),
            'original': f.get('ocr', ''),
            'replacement': f.get('san', ''),
            'score': _sim_pct(f),
            'type': 'fix'
        }
        # Carry the full ranked candidate list (if greedy stored one) so the
        # review panel can render alternatives without another backtrack call.
        # Carry every field the interactive fix-details panel reads — reach,
        # score_components, char_sim, ocr_conf, absurdity_count, etc. —
        # so the review UI renders identically to interactive mode.
        cands = f.get('all_candidates')
        if cands:
            _DETAIL_FIELDS = (
                'ply', 'san', 'ocr', 'unified_score',
                'reach', 'reach_improvement', 'completes',
                'score_components', 'sim_source',
                'char_sim', 'ocr_conf', 'ocr_candidate_bonus',
                'absurdity_count', 'absurdity_penalty',
                'is_hanging', 'is_absurdity_fix', 'is_low_conf_fix',
                'original_was_legal', 'ply_str',
            )
            packaged = []
            for c in cands:
                out = {k: c[k] for k in _DETAIL_FIELDS if k in c}
                # Keep the legacy 'similarity' (percentage) for UIs that rely on it.
                out['similarity'] = _sim_pct(c)
                # Also expose ply_str for review UI (computed if absent).
                if not out.get('ply_str'):
                    out['ply_str'] = ply_to_str(out.get('ply', fix_ply))
                packaged.append(out)
            entry['all_candidates'] = packaged
        fixes_applied.append(entry)

    final_reach, _ = play_until_stuck(result.path)
    completed = result.status in ('SOLVED', 'VALID')

    # Canonicalize before crossing back to JS — chess.js v0.12.0 strict mode
    # rejects non-canonical SAN like "Be5" for a capture (canonical "Bxe5"),
    # which freezes the board renderer at that ply. python-chess's parse_san
    # silently accepted "Be5" during play, so result.path holds the raw OCR
    # at the affected indices. See helpers.canonicalize_played_moves.
    from helpers import canonicalize_played_moves
    canonical_path = canonicalize_played_moves(result.path)

    return {
        'moves': canonical_path,
        'pgn': '',  # Not needed for background results
        'fixes_applied': fixes_applied,
        'stuck_points': len(fixes_applied),
        'completed': completed,
        'final_ply': final_reach if final_reach else len(canonical_path),
        'total_plies': len(canonical_path),
        'status': result.status,
        'elapsed': result.elapsed,
        'errors_remaining': 0 if completed else 1
    }
