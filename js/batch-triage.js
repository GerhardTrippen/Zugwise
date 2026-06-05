// =============================================================================
// batch-triage.js — Tier A/B/C classification for batch mode
// =============================================================================
// Phase 2 of Batch Mode. Pure classifier — takes the results of the three
// reconstruction algorithms (greedy, beam, dijkstra) for one game and returns
// a tier with a reason and diagnostic details.
//
// Tier definitions (from BATCH-MODE-SPEC.md §8):
//   A — Quick Review    : all 3 algorithms agree, every fix similarity ≥ 0.7,
//                         total fixes ≤ 5
//   B — Standard Review : mostly agree (≤2 disagreements) or 6–12 fixes
//   C — Deep Review     : significant divergence, or any algorithm failed to
//                         solve, or fixes > 12
//
// Algorithm characteristics (NOT a trust hierarchy — see BATCH-MODE-SPEC §8):
//   all three are heuristic. Dijkstra is cost-optimal given the scoring
//   function but running time can be unbounded. Beam is bounded-width and may
//   prune the right path. Greedy commits locally. Cross-algorithm agreement
//   matters more than any single algorithm's output. Ordering is used only as
//   a weak tiebreaker in pickBestResult for display.
//
// Dependencies: none (stateless).
// =============================================================================

var BatchTriage = (function() {
  'use strict';

  var TIER = { A: 'A', B: 'B', C: 'C' };

  // Tier display metadata — consumed by batch-game-list.js for rendering.
  var TIER_DISPLAY = {};
  TIER_DISPLAY[TIER.A] = {
    label: 'Quick Review',
    icon: '\uD83D\uDFE2',              // 🟢
    cssClass: 'text-green-400',
    badgeClass: 'bg-green-900 text-green-300 border border-green-700'
  };
  TIER_DISPLAY[TIER.B] = {
    label: 'Standard Review',
    icon: '\uD83D\uDFE1',              // 🟡
    cssClass: 'text-yellow-400',
    badgeClass: 'bg-yellow-900 text-yellow-300 border border-yellow-700'
  };
  TIER_DISPLAY[TIER.C] = {
    label: 'Deep Review',
    icon: '\uD83D\uDD34',              // 🔴
    cssClass: 'text-red-400',
    badgeClass: 'bg-red-900 text-red-300 border border-red-700'
  };

  // Per-spec thresholds — exposed so tests / callers can override.
  var THRESHOLDS = {
    tierA_maxFixes: 5,
    tierA_minSimilarity: 0.7,
    tierB_maxDisagreements: 2,
    tierB_maxFixes: 12
  };

  // =========================================================================
  // Fix normalization helpers
  // =========================================================================

  /**
   * Extract (ply, san) from a fix dict. Fix dicts come from the Python
   * reconstruction engine via the search worker — schema is a moving target,
   * so try a few keys. A fix with no identifiable ply is skipped.
   * @private
   */
  function _fixPly(fix) {
    if (!fix) return null;
    if (typeof fix.ply === 'number') return fix.ply;
    if (typeof fix.ply_idx === 'number') return fix.ply_idx;
    // ply_str form: "12.W" / "12.B" → (num-1)*2 + (w?0:1)
    if (typeof fix.ply_str === 'string') {
      var m = fix.ply_str.match(/^(\d+)\.([WB])$/i);
      if (m) {
        return (parseInt(m[1]) - 1) * 2 + (m[2].toUpperCase() === 'W' ? 0 : 1);
      }
    }
    return null;
  }

  function _fixSan(fix) {
    if (!fix) return null;
    return fix.san || fix.fix_san || fix.new_san || null;
  }

  function _fixSimilarity(fix) {
    if (!fix) return null;
    // similarity may be 0–1 or 0–100; normalize to 0–1.
    var s = fix.similarity;
    if (s == null) s = fix.score;
    if (s == null) return null;
    if (s > 1.0) s = s / 100.0;
    return s;
  }

  /**
   * Build a {ply: san} map from a fix list.
   * Fixes without a recoverable ply are dropped.
   */
  function fixesToPlyMap(fixes) {
    var map = {};
    if (!fixes) return map;
    for (var i = 0; i < fixes.length; i++) {
      var ply = _fixPly(fixes[i]);
      if (ply == null) continue;
      var san = _fixSan(fixes[i]);
      if (san == null) continue;
      map[ply] = san.replace(/[+#]$/g, '');
    }
    return map;
  }

  // =========================================================================
  // Agreement analysis
  // =========================================================================

  /**
   * Compare fix lists across whichever algorithms actually ran.
   *
   * A ply "agrees" when every present algorithm proposed the same SAN at that
   * ply. Plies touched by only a subset of present algorithms count as
   * disagreements (one alg thinks the ply needs a fix, the others don't).
   *
   * With a single-method run (e.g., batch Greedy-only), every touched ply is
   * trivially an agreement — there is nothing to disagree with. The caller
   * should not read "fullAgreement" as a correctness signal in that case; it
   * just means the sole algorithm's output is self-consistent.
   *
   * @param {Object} fixesByMethod - {greedy?, beam?, dijkstra?} → fix arrays.
   *                 Only methods whose entry is an array count as "present".
   * @returns {Object} - {
   *     fullAgreement: boolean,
   *     agreements:    number,
   *     disagreements: number,
   *     totalFixes:    number,       // size of the union of touched plies
   *     minSimilarity: number,       // min similarity across the ranked-best
   *                                  // present method's fixes
   *     presentMethods: Array<string>
   * }
   */
  function compareFixLists(fixesByMethod) {
    fixesByMethod = fixesByMethod || {};

    // Ranked by tiebreaker preference (see pickBestResult): dijkstra, beam,
    // greedy. We walk this order to find the "trust method" for minSimilarity.
    var ORDER = ['dijkstra', 'beam', 'greedy'];

    var present = [];
    var plyMaps = {};
    ORDER.forEach(function(m) {
      if (Array.isArray(fixesByMethod[m])) {
        present.push(m);
        plyMaps[m] = fixesToPlyMap(fixesByMethod[m]);
      }
    });

    var plies = {};
    present.forEach(function(m) {
      Object.keys(plyMaps[m]).forEach(function(p) { plies[p] = true; });
    });
    var plyList = Object.keys(plies);

    var agreements = 0;
    var disagreements = 0;
    plyList.forEach(function(p) {
      // Every present method must both touch this ply and propose the same SAN.
      var firstSan = null;
      var allAgree = true;
      for (var i = 0; i < present.length; i++) {
        var map = plyMaps[present[i]];
        if (!map.hasOwnProperty(p)) { allAgree = false; break; }
        if (firstSan == null) {
          firstSan = map[p];
        } else if (map[p] !== firstSan) {
          allAgree = false;
          break;
        }
      }
      if (allAgree) agreements++; else disagreements++;
    });

    // minSimilarity from the ranked-best present method's fixes (display only).
    var minSim = 1.0;
    var trustFixes = [];
    for (var j = 0; j < ORDER.length; j++) {
      var arr = fixesByMethod[ORDER[j]];
      if (Array.isArray(arr) && arr.length > 0) { trustFixes = arr; break; }
    }
    trustFixes.forEach(function(f) {
      var s = _fixSimilarity(f);
      if (s != null && s < minSim) minSim = s;
    });

    return {
      fullAgreement: disagreements === 0 && plyList.length >= 0,
      agreements: agreements,
      disagreements: disagreements,
      totalFixes: plyList.length,
      minSimilarity: minSim,
      presentMethods: present
    };
  }

  // =========================================================================
  // Tier classification
  // =========================================================================

  /**
   * Classify a game into a triage tier.
   *
   * @param {Object} results - {greedy, beam, dijkstra}, each either null
   *                           (algorithm didn't run) or {status, moves, fixes}.
   * @returns {Object} - {
   *     tier:    'A'|'B'|'C',
   *     reason:  string,          // short machine-readable code
   *     details: Object           // diagnostic data (agreements, fix count…)
   * }
   */
  function classifyTier(results) {
    results = results || {};

    // Operate on whichever algorithms actually ran — batch mode may run only
    // Greedy, interactive/review may run all three.
    var ORDER = ['greedy', 'beam', 'dijkstra'];
    var present = ORDER.filter(function(m) { return !!results[m]; });

    if (present.length === 0) {
      return { tier: TIER.C, reason: 'no_algorithm_ran', details: {} };
    }

    var notSolved = present.filter(function(m) { return results[m].status !== 'SOLVED'; });
    if (notSolved.length > 0) {
      var statuses = {};
      present.forEach(function(m) { statuses[m] = results[m].status; });
      return {
        tier: TIER.C,
        reason: 'algorithm_not_solved',
        details: { notSolved: notSolved, statuses: statuses }
      };
    }

    var fixesByMethod = {};
    present.forEach(function(m) { fixesByMethod[m] = results[m].fixes || []; });
    var agreement = compareFixLists(fixesByMethod);

    // Tier A: full agreement, small fix count, high min similarity.
    if (agreement.fullAgreement &&
        agreement.totalFixes <= THRESHOLDS.tierA_maxFixes &&
        agreement.minSimilarity >= THRESHOLDS.tierA_minSimilarity) {
      return {
        tier: TIER.A,
        reason: 'all_agree_low_cost',
        details: agreement
      };
    }

    // Tier B: mostly agree, moderate fix count.
    if (agreement.disagreements <= THRESHOLDS.tierB_maxDisagreements &&
        agreement.totalFixes <= THRESHOLDS.tierB_maxFixes) {
      return {
        tier: TIER.B,
        reason: 'mostly_agree',
        details: agreement
      };
    }

    // Everything else is Tier C.
    return {
      tier: TIER.C,
      reason: 'significant_divergence',
      details: agreement
    };
  }

  /**
   * Pick a "default" reconstruction to show in verification UI.
   * When multiple methods SOLVED, prefer dijkstra > beam > greedy purely as a
   * display tiebreaker — this is NOT a claim that Dijkstra's answer is more
   * correct. All three are heuristic and can be wrong in the same way. When
   * the user has intentionally excluded slower methods from the run, we just
   * take whichever method is present.
   * @param {Object} results - same shape as classifyTier input
   * @returns {Object|null} - {method, result} or null if nothing solved
   */
  function pickBestResult(results) {
    results = results || {};
    var order = ['dijkstra', 'beam', 'greedy'];
    for (var i = 0; i < order.length; i++) {
      var m = order[i];
      var r = results[m];
      // VALID counts as solved here too — same reasoning as _solved() in the
      // orchestrator: worker emits VALID when the input was already a clean
      // game (0 fixes). Excluding VALID here let pickBestResult fall through
      // to null on already-valid games, which kept them RECONSTRUCTING.
      if (r && (r.status === 'SOLVED' || r.status === 'VALID')) {
        return { method: m, result: r };
      }
    }
    // Nothing solved — fall back to whatever has fixes, but ONLY when its
    // status is at least PARTIAL. A FAILED (X glyph) result can still carry
    // fixes the worker had committed before bailing; picking it here would
    // route the user into that method's review pane for a run the sidebar
    // is showing as failed. The SOLVED/VALID disjuncts are redundant given
    // the first loop above already returns on those — included for
    // readability so this condition states the rule directly ("at least
    // partial") rather than depending on loop ordering.
    for (var j = 0; j < order.length; j++) {
      var mm = order[j];
      var rr = results[mm];
      if (rr && (rr.status === 'SOLVED' || rr.status === 'VALID' || rr.status === 'PARTIAL')
             && rr.fixes && rr.fixes.length > 0) {
        return { method: mm, result: rr };
      }
    }
    return null;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    TIER: TIER,
    TIER_DISPLAY: TIER_DISPLAY,
    THRESHOLDS: THRESHOLDS,
    classifyTier: classifyTier,
    compareFixLists: compareFixLists,
    fixesToPlyMap: fixesToPlyMap,
    pickBestResult: pickBestResult
  };
})();

// Expose globally
window.BatchTriage = BatchTriage;
