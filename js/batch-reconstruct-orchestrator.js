// =============================================================================
// batch-reconstruct-orchestrator.js — Auto-escalating reconstruction queue
// =============================================================================
// Wraps three per-method BatchReconstructQueue.Queue instances (greedy, beam,
// dijkstra) and coordinates auto-escalation:
//
//   Greedy fails on game K  -->  beam queue enqueues K
//   Beam fails on game K    -->  dijkstra queue enqueues K
//   Greedy solves K         -->  nothing further runs on K by default
//
// Escalation honors the interactive "Auto-Run Searches" toggles
// (autorun_beam / autorun_dijkstra): a disabled method is skipped, so the
// chain might be greedy->dijkstra (beam off) or greedy-only (both off).
// Greedy is the mandatory base and is always enabled. See _enabledMethods().
//
// All three per-method queues process sequentially within themselves but in
// parallel across methods — i.e., greedy can be on game 20 while beam is on
// game 3 and dijkstra is on game 1, each from their own SearchManager
// instance. Peak worker count is 3.
//
// Speculative work-ahead (Beam only):
//   Normally Beam only sees a game after Greedy escalates it. But near the end
//   of a round, Greedy is the bottleneck and Beam sits idle. When Beam's queue
//   is idle we hand it the HARDEST game Greedy has not yet finished (greedy
//   status still 'queued'/'running'), so Beam works ahead from the hard end
//   while Greedy works up from the easy end — they converge in the middle. If
//   Beam solves first, great; if Greedy gets there first, the per-game
//   escalation guard skips re-queuing Beam. Dijkstra is deliberately NOT
//   speculated (its running time is unbounded — see CLAUDE.md); it still only
//   runs via escalation after Beam fails/partials.
//
// Exposes the same callback surface as the underlying Queue so existing
// callers (batch-game-list.js) can swap in without restructuring. The
// onGameComplete callback now fires once per method completion with an
// aggregated payload (results.{greedy,beam,dijkstra}), so the UI can show
// incremental progress as escalation runs.
//
// Dependencies:
//   - BatchReconstructQueue (batch-reconstruct-queue.js)
//   - BatchTriage (batch-triage.js)
// =============================================================================

var BatchReconstructOrchestrator = (function() {
  'use strict';

  var METHOD_ORDER = ['greedy', 'beam', 'dijkstra'];

  function _solved(methodResult) {
    // VALID = worker found the input already valid (0 fixes needed); SOLVED =
    // worker had to apply fixes. Both mean "this method produced a fully
    // validated game" — treat them identically. Without VALID here, a 0-fixes
    // game flips methodStatus to 'failed', the sidebar paints G✗B✗D✗ on a
    // game the panels render as "Solved!", and pickBestResult drops the
    // result so the game stays RECONSTRUCTING.
    return !!(methodResult &&
              (methodResult.status === 'SOLVED' ||
               methodResult.status === 'VALID'));
  }

  /**
   * @param {Object} [options]
   * @param {Object} [options.methodOptions] — per-method search options, same
   *                 shape as Queue's methodOptions. Split across the three
   *                 per-method queues internally.
   * @param {string} [options.lockMode='tier1'] — MergeSheets lock mode (forwarded).
   * @param {boolean} [options.escalate=true] — set false to disable auto-escalation
   *                  (Greedy-only; same as the old single-Queue behavior).
   */
  function Orchestrator(options) {
    options = options || {};
    this.methodOptions = options.methodOptions || {};
    this.lockMode = options.lockMode || 'tier1';
    this.escalate = options.escalate !== false;
    // Beam-only speculative work-ahead (see file header). Default on; pass
    // { speculative: false } to restore strict escalation-only behavior.
    this.speculative = options.speculative !== false;

    // Auto-escalation method gating. Mirrors the interactive "Auto-Run
    // Searches" toggles so batch and interactive agree on which algorithms
    // run: autorun_beam / autorun_dijkstra off stops the queue from ever
    // escalating to that method (notably Dijkstra, whose runtime is unbounded
    // — see CLAUDE.md). Greedy is the mandatory base (batch can't reconstruct
    // without it) and is always enabled. Resolved live from currentSettings
    // at each escalation (_enabledMethods) so a mid-session toggle takes
    // effect; an explicit options.enabledMethods array overrides for tests.
    this._enabledOverride = Array.isArray(options.enabledMethods)
        ? options.enabledMethods.slice()
        : null;

    // Original ocrResult per gameId, retained so escalation queues run from
    // the same raw input rather than from Greedy's partially-fixed moves.
    this._ocrByGame = {};
    // Override prepared-input per gameId — set by requeue() when the user
    // edits a fix during review. Escalation after a requeue must use the
    // overridden moves, not the stale raw OCR.
    this._overrideByGame = {};
    // Games where the user pressed the panel Cancel button (cancelGameKeepPartial).
    // The cancelled method's PARTIAL is kept and surfaced for review, but
    // auto-escalation to the next method is suppressed — matching single-mode
    // behavior where cancelling Greedy stops there and waits for the user
    // rather than silently spinning up Beam/Dijkstra. Cleared on enqueue/requeue
    // so a later fresh run for the same game behaves normally again.
    this._escalationSuppressed = {};
    // Aggregated per-game results: gameId -> {results: {greedy,beam,dijkstra},
    //                                         triage, picked, methodStatus}
    this.results = {};
    this.cancelled = false;

    // Callbacks (match Queue's shape)
    this.onProgress = null;       // (gameId, phase, message)
    this.onMethodStep = null;     // (gameId, method, step)
    this.onGameComplete = null;   // (gameId, aggregatedPayload) — fires per method
    this.onQueueComplete = null;  // (results) — fires when all three queues idle

    var Q = window.BatchReconstructQueue && window.BatchReconstructQueue.Queue;
    if (typeof Q !== 'function') {
      throw new Error('BatchReconstructQueue.Queue not available — load batch-reconstruct-queue.js first');
    }

    var self = this;
    this._queues = {};
    METHOD_ORDER.forEach(function(method) {
      var mo = {};
      if (self.methodOptions[method]) mo[method] = self.methodOptions[method];

      var q = new Q({
        methods: [method],
        methodOptions: mo,
        lockMode: self.lockMode
      });

      q.onProgress = function(gameId, phase, message) {
        // Surface "this method just started on this game" as methodStatus=running
        // so the status indicator can animate. The Queue fires 'reconstructing'
        // when it picks up a new item from its queue.
        if (phase === 'reconstructing' && self.results[gameId]) {
          self.results[gameId].methodStatus[method] = 'running';
        } else if (phase === 'reconstruct_error' && self.results[gameId]) {
          self.results[gameId].methodStatus[method] = 'error';
        }
        if (self.onProgress) {
          try { self.onProgress(gameId, phase, message, method); } catch (e) {}
        }
      };
      q.onMethodStep = function(gameId, m, step) {
        if (self.onMethodStep) {
          try { self.onMethodStep(gameId, m, step); } catch (e) {}
        }
      };
      q.onGameComplete = function(gameId, payload) {
        self._handleMethodComplete(method, gameId, payload);
      };
      q.onQueueComplete = function() {
        // Idle Beam works ahead on a game Greedy hasn't finished. No-op for
        // greedy/dijkstra (the feeder self-restricts to beam). If it feeds a
        // game the beam queue goes processing=true again, so the
        // _maybeFireQueueComplete below won't prematurely signal batch-done.
        self._feedSpeculative(method);
        self._maybeFireQueueComplete();
      };

      self._queues[method] = q;
    });
  }

  // =========================================================================
  // Public API — mirrors Queue's shape for drop-in use
  // =========================================================================

  /**
   * Enqueue a game. Always lands in the greedy queue first; escalation to
   * beam/dijkstra happens automatically on failure (if escalate=true).
   */
  Orchestrator.prototype.enqueue = function(gameId, ocrResult) {
    console.log('[ORCH-ENQUEUE] ' + gameId + ' .enqueue() called');
    this._ocrByGame[gameId] = ocrResult;
    // A fresh enqueue supersedes any earlier override.
    delete this._overrideByGame[gameId];
    // A fresh enqueue restarts the full pipeline — any prior user cancel no
    // longer applies, so re-enable auto-escalation for this game.
    delete this._escalationSuppressed[gameId];

    // DEFENSIVE NOISE GATE — refuse to enqueue games with trailing noise.
    // BatchGameList.onGameComplete is supposed to gate this via _hasTrailingNoise
    // before calling reconstructQueue.enqueue, but it has missed cases (cached
    // pre-fix detector output, NoiseDetection not yet loaded at OCR time,
    // detector blind spots). Calling _hasTrailingNoise again here uses the
    // CURRENT detector logic and protects every caller (autoapply-review,
    // future paths) without each having to remember the gate.
    //
    // EXCEPTION: if the user already walked through the truncation review
    // for this game (BatchGameList sets game.noiseResolved on the
    // "Continue to Validation" click), trust them. The trailing-noise
    // detector is single-move sensitive (a sub-50% last move trips it),
    // which produces false positives on legitimate low-confidence endgame
    // captures like "Kxg6"; without this bypass, onTruncationComplete's
    // re-enqueue keeps getting refused and the game is locked out of
    // reconstruction even though the user said the cleanup is done.
    var _gameRec = (window.BatchGameList && window.BatchGameList.batchState &&
                    window.BatchGameList.batchState.games &&
                    window.BatchGameList.batchState.games.get(gameId)) || null;
    var _noiseResolved = !!(_gameRec && _gameRec.noiseResolved);
    if (!_noiseResolved && _hasTrailingNoise(ocrResult)) {
      console.log('[ORCH-ENQUEUE] ' + gameId +
                  ' ⛔ REFUSED — trailing noise detected, not enqueued');
      this.results[gameId] = _freshAggregate('needs_truncation');
      return;
    }
    if (_noiseResolved) {
      console.log('[ORCH-ENQUEUE] ' + gameId +
                  ' ↪ noise gate BYPASSED — user already confirmed truncation');
    }

    console.log('[ORCH-ENQUEUE] ' + gameId + ' ✅ ACCEPTED — added to greedy queue');
    this.results[gameId] = _freshAggregate('queued');
    // Sort the greedy queue so easier games (fewer low-confidence cells) are
    // processed first. The user gets a steady stream of ready games while
    // Greedy chews on the hard ones at the back of the queue. Escalation to
    // beam/dijkstra keeps FIFO-by-failure-order (unpriorityed enqueue).
    var priority = _computeDifficulty(ocrResult);
    // Stash the difficulty so the Beam speculative feeder can pick the HARDEST
    // not-yet-finished game (Greedy goes easy-first; idle Beam attacks the hard
    // end so the two lanes converge instead of Beam re-solving easy wins).
    this.results[gameId]._difficulty = priority;
    this._queues.greedy.enqueue(gameId, ocrResult, priority);

    // Kick the feeder so an idle Beam starts on the hardest pending game right
    // away instead of waiting for its (empty) queue to fire onQueueComplete.
    this._feedSpeculative('beam');
  };

  // Count low-confidence cells as a cheap difficulty proxy. Works uniformly
  // for single- and dual-sheet games. Not a great signal — cells with
  // low-confidence OCR are often salvageable via the candidate list — but
  // it's strictly better than FIFO for batch ordering and available the
  // moment OCR completes (no merge needed).
  var _LOW_CONF_THRESHOLD = 0.8;
  function _computeDifficulty(ocrResult) {
    // Games with trailing noise need user attention before reconstruction
    // can succeed (the garbage cells at the end produce illegal moves that
    // reconstruction can't fix on its own). Boost them to the very front
    // of the queue so the user sees and truncates them first.
    if (_hasTrailingNoise(ocrResult)) return -1000;

    if (!ocrResult) return 0;
    var count = 0;
    function scan(cells) {
      if (!Array.isArray(cells)) return;
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        var conf = (c && typeof c.confidence === 'number') ? c.confidence : 1;
        if (conf < _LOW_CONF_THRESHOLD) count++;
      }
    }
    if (ocrResult.isDualSheet) {
      scan(ocrResult.sheet1);
      scan(ocrResult.sheet2);
    } else {
      scan(ocrResult.ocrCells);
    }
    return count;
  }

  // Convert a flat OCR cell list ([{num, color, move, confidence, ...}]) into
  // the paired-moves shape ([{num, white, black, wConf, bConf}]) that the
  // shared noise detectors expect.
  function _cellsToPaired(cells) {
    if (!Array.isArray(cells)) return [];

    // First check: are there duplicate (num, color) keys? This happens
    // when a multi-page game uses a profile whose page count is smaller
    // than the actual page count -- getProfileGridConfig clamps pageIdx
    // to the last profile page, so pages beyond that fall back to the
    // last profile entry's startingMove and produce cell.num values that
    // collide with the preceding page. Map-keyed pairing then collapses
    // all those collisions and the tail of the game (where the noise
    // typically lives) is silently overwritten by the duplicates.
    //
    // Detect by scanning for repeated (num, color) keys. If any exist,
    // fall back to position-based pairing: ignore cell.num entirely,
    // walk the array in order, and pair consecutive same-numbered W+B
    // halves into sequential paired moves.
    var seenKeys = {};
    var hasDuplicates = false;
    for (var di = 0; di < cells.length; di++) {
      var dc = cells[di];
      if (!dc || dc.num == null) continue;
      var dk = dc.num + '_' + dc.color;
      if (seenKeys[dk]) { hasDuplicates = true; break; }
      seenKeys[dk] = true;
    }

    if (hasDuplicates) {
      if (typeof console !== 'undefined') {
        console.warn('[CELLS-TO-PAIRED] Duplicate (num, color) keys detected in ' +
                     cells.length + ' cells. Profile likely has fewer pages than ' +
                     'this game has — extra pages get clamped to the last profile ' +
                     'page\'s startingMove and collide with the previous page. ' +
                     'Falling back to position-based pairing (cell.num ignored).');
      }
      // Position-based: walk the array in order. Use a running counter
      // that advances when we see a (num, color) we've already filled
      // in the current "page slot" -- that signals page boundary.
      var paired = [];
      var current = null;
      var nextNum = 1;
      var pageFingerprint = {};
      for (var pi = 0; pi < cells.length; pi++) {
        var pc = cells[pi];
        if (!pc) continue;
        var pcConf = (typeof pc.confidence === 'number') ? pc.confidence : 0.9;
        var fpKey = (pc.num || 0) + '_' + pc.color;
        // First sighting of (num,color) in the current page → continue.
        // Second sighting → close the current page slot, advance counter.
        if (pageFingerprint[fpKey]) {
          pageFingerprint = {};                     // new page slot
        }
        pageFingerprint[fpKey] = true;
        if (pc.color === 'w') {
          // Start a new paired move with sequential num.
          current = { num: nextNum, white: pc.move || '', black: '',
                      wConf: pcConf, bConf: 0.9 };
          paired.push(current);
          nextNum++;
        } else if (pc.color === 'b') {
          if (current && current.black === '') {
            current.black = pc.move || '';
            current.bConf = pcConf;
          } else {
            // Orphan B (no preceding W) — emit standalone
            paired.push({ num: nextNum, white: '', black: pc.move || '',
                          wConf: 0.9, bConf: pcConf });
            nextNum++;
            current = null;
          }
        }
      }
      return paired;
    }

    // Normal path — no duplicates, key by (num, color).
    var map = {};
    cells.forEach(function(c) {
      if (!c || c.num == null) return;
      var n = c.num;
      if (!map[n]) map[n] = { num: n, white: '', black: '', wConf: 0.9, bConf: 0.9 };
      var conf = (typeof c.confidence === 'number') ? c.confidence : 0.9;
      if (c.color === 'w') {
        map[n].white = c.move || '';
        map[n].wConf = conf;
      } else if (c.color === 'b') {
        map[n].black = c.move || '';
        map[n].bConf = conf;
      }
    });
    return Object.keys(map).map(Number).sort(function(a, b) { return a - b; })
      .map(function(n) { return map[n]; });
  }

  // Run the same three detectors `showOcrResults` will run when the user
  // opens this game (`window.NoiseDetection`, exposed by ui.js). Matching
  // the user-facing detection here means the enqueue gate flags the same
  // games the user will see flagged — no double-enqueue when the user
  // truncates after the orchestrator missed noise that ui.js catches.
  //
  // For dual-sheet input, merge first to mirror the merged sequence the
  // user actually sees in the move list. If the merge helper isn't loaded
  // (shouldn't happen given index.html load order, but be defensive),
  // fall back to scanning each sheet's cells separately under the same
  // detectors.
  function _hasTrailingNoise(ocrResult) {
    if (!ocrResult) return false;
    if (!window.NoiseDetection ||
        typeof window.NoiseDetection.isTailNoisy !== 'function') {
      if (typeof console !== 'undefined') {
        console.warn('[BatchReconstruct] NoiseDetection helper not loaded ' +
                     'at _hasTrailingNoise time — returning false (conservative). ' +
                     'Any game enqueued now will skip the noise gate.');
      }
      // Helper not loaded — be conservative and return false rather than
      // false-positive on a dropped check.
      return false;
    }

    var paired;
    var dualSplit = null;
    if (ocrResult.isDualSheet) {
      var s1 = ocrResult.sheet1 || [];
      var s2 = ocrResult.sheet2 || [];
      if (s1.length === 0 && s2.length === 0) return false;

      // Pre-check for (num, color) duplicates in either sheet. If found,
      // mergeSheets would silently collapse them (its indexByPly keys on
      // num+color too), and we'd lose the tail. Bypass merge entirely
      // and pair each sheet position-based via _cellsToPaired's duplicate
      // fallback. Either sheet being noisy qualifies the game.
      function _hasNumColorDupes(cells) {
        if (!Array.isArray(cells)) return false;
        var seen = {};
        for (var i = 0; i < cells.length; i++) {
          var c = cells[i];
          if (!c || c.num == null) continue;
          var k = c.num + '_' + c.color;
          if (seen[k]) return true;
          seen[k] = true;
        }
        return false;
      }
      var s1Dup = _hasNumColorDupes(s1);
      var s2Dup = _hasNumColorDupes(s2);
      if (s1Dup || s2Dup) {
        console.warn('[NOISE-CHECK] Profile/page mismatch detected — sheet1 has ' +
                     s1.length + ' cells (dupes=' + s1Dup + '), sheet2 has ' +
                     s2.length + ' cells (dupes=' + s2Dup + '). Bypassing mergeSheets ' +
                     '(which keys on num+color and would collapse duplicates) and ' +
                     'checking each sheet independently with position-based pairing.');
        // Surface the actual num distribution so we can see WHY the dupes
        // happen even with profile-config extrapolation. Counts unique nums
        // and reports min/max + the collision keys.
        function _numDist(cells, label) {
          if (!Array.isArray(cells)) return;
          var counts = {};
          var minNum = Infinity, maxNum = -Infinity;
          for (var i = 0; i < cells.length; i++) {
            var c = cells[i];
            if (!c || c.num == null) continue;
            var k = c.num + '_' + c.color;
            counts[k] = (counts[k] || 0) + 1;
            if (c.num < minNum) minNum = c.num;
            if (c.num > maxNum) maxNum = c.num;
          }
          var dupKeys = Object.keys(counts).filter(function(k) { return counts[k] > 1; });
          console.log('[NOISE-CHECK] ' + label + ' num range: ' + minNum + '..' + maxNum +
                      ', unique (num,color) keys: ' + Object.keys(counts).length +
                      ', duplicate keys: ' + dupKeys.length);
          if (dupKeys.length > 0) {
            console.log('[NOISE-CHECK] ' + label + ' first 10 dup keys: ' +
                        dupKeys.slice(0, 10).map(function(k) {
                          return k + '×' + counts[k];
                        }).join(', '));
          }
        }
        _numDist(s1, 'sheet1');
        _numDist(s2, 'sheet2');
        var p1 = _cellsToPaired(s1);
        var p2 = _cellsToPaired(s2);
        var noisy1 = window.NoiseDetection.isTailNoisy(p1);
        var noisy2 = window.NoiseDetection.isTailNoisy(p2);
        console.log('[NOISE-CHECK] dup-bypass: sheet1 paired=' + p1.length +
                    ' noisy=' + noisy1 + ', sheet2 paired=' + p2.length +
                    ' noisy=' + noisy2);
        if (p1.length > 0) {
          var t1Tail = p1.slice(-10).map(function(m) {
            return m.num + ':' + (m.white || '—') + '/' + (m.black || '—') +
                   '(' + (m.wConf || 0).toFixed(2) + '/' + (m.bConf || 0).toFixed(2) + ')';
          }).join(' ');
          console.log('[NOISE-CHECK] dup-bypass sheet1 tail10: ' + t1Tail);
        }
        return noisy1 || noisy2;
      }

      if (window.MergeSheets &&
          typeof window.MergeSheets.mergeSheets === 'function') {
        var merged = window.MergeSheets.mergeSheets(s1, s2) || [];
        paired = _cellsToPaired(merged);
      } else {
        // No merge available — check each sheet independently. Either being
        // noisy qualifies, matching the old per-sheet semantics.
        var p1 = _cellsToPaired(s1);
        var p2 = _cellsToPaired(s2);
        dualSplit = { s1Noisy: window.NoiseDetection.isTailNoisy(p1),
                      s2Noisy: window.NoiseDetection.isTailNoisy(p2),
                      s1Len: p1.length, s2Len: p2.length };
        var result = dualSplit.s1Noisy || dualSplit.s2Noisy;
        if (typeof console !== 'undefined') {
          console.log('[BatchReconstruct] noise(no-merge) → ' + result +
                      ' (s1Noisy=' + dualSplit.s1Noisy + ' s2Noisy=' + dualSplit.s2Noisy +
                      ', s1Len=' + dualSplit.s1Len + ' s2Len=' + dualSplit.s2Len + ')');
        }
        return result;
      }
    } else {
      paired = _cellsToPaired(ocrResult.ocrCells || []);
    }

    // Individual detector breakdown so we can see WHICH one fired (or
    // why none fired). Helps diagnose the "orchestrator missed the
    // noise but ui.js caught it" case.
    var nd = window.NoiseDetection;
    var t1 = (typeof nd.detectSuspiciousTailFromPaired === 'function')
      ? nd.detectSuspiciousTailFromPaired(paired) : null;
    var t2 = (typeof nd.detectRepeatingTailFromPaired === 'function')
      ? nd.detectRepeatingTailFromPaired(paired) : null;
    var t4 = (typeof nd.detectRepeatedPawnPushTailFromPaired === 'function')
      ? nd.detectRepeatedPawnPushTailFromPaired(paired) : null;
    var t3 = (typeof nd.detectTrailingNoiseFromPaired === 'function')
      ? nd.detectTrailingNoiseFromPaired(paired) : null;
    var isNoisy = (t1 !== null) || (t2 !== null) || (t4 !== null) || (t3 !== null);
    if (typeof console !== 'undefined') {
      // Print last 10 paired moves so we can see the actual tail content,
      // not just the final two. The 40-vs-120-move mystery is impossible
      // to debug from a 2-move tail summary.
      var lastTen = paired.slice(-10).map(function(m) {
        return m.num + ':' + (m.white || '—') + '/' + (m.black || '—') +
               '(' + (m.wConf || 0).toFixed(2) + '/' + (m.bConf || 0).toFixed(2) + ')';
      }).join(' ');
      console.log('[NOISE-CHECK] noise → ' + isNoisy +
                  ' (paired=' + paired.length + ' moves' +
                  ', suspiciousTail@ply=' + t1 +
                  ', repeatingTail@ply=' + t2 +
                  ', pawnPushRepeat@ply=' + t4 +
                  ', trailingNoise@ply=' + t3 + ')');
      console.log('[NOISE-CHECK] tail10: ' + lastTen);
    }
    return isNoisy;
  }

  /**
   * Re-enqueue after user override. Goes back through greedy first — the
   * override changes the input, so every method has to re-run if escalation
   * fires again. Clears prior per-game results to avoid stale triage.
   *
   * Also aborts any in-flight Beam/Dijkstra work for this game. Those are
   * running against the pre-override input; if we let them finish, their
   * onGameComplete callback would pour stale results back into the
   * aggregate we just reset. The aborted searches fire with
   * status='CANCELLED', which _handleMethodComplete discards.
   */
  Orchestrator.prototype.requeue = function(gameId, updatedOcrMoves, lockedPlies, fromPly) {
    // Remember the overridden input so that if greedy fails on the override,
    // escalation to beam/dijkstra runs on the SAME overridden moves, not on
    // the stale raw OCR we stored at original-enqueue time.
    this._overrideByGame[gameId] = {
      ocrMoves: updatedOcrMoves,
      lockedPlies: (lockedPlies || []).slice(),
      fromPly: fromPly || 0
    };
    this.results[gameId] = _freshAggregate('queued');
    // A user edit re-runs the pipeline from scratch — any earlier panel-Cancel
    // suppression no longer applies, so auto-escalation is back on.
    delete this._escalationSuppressed[gameId];

    // Kill every in-flight run for this game across all three queues. Greedy
    // will be restarted right below via requeue; beam/dijkstra just get
    // purged of any pending work so they don't fire stale completions.
    METHOD_ORDER.forEach(function(m) {
      if (m === 'greedy') return;  // greedy.requeue below handles greedy
      try { this._queues[m].abortGame(gameId); } catch (e) {}
    }, this);
    // Greedy is also likely processing this game — abort + requeue covers
    // both the in-flight and the pending case.
    try { this._queues.greedy.abortGame(gameId); } catch (e) {}
    this._queues.greedy.requeue(gameId, updatedOcrMoves, lockedPlies, fromPly);

    // An idle Beam can start on the overridden input in parallel with Greedy's
    // requeue run (greedy is now 'queued', beam reset to 'idle'). Mirrors the
    // kick in enqueue() so the user doesn't wait for the next queue event.
    this._feedSpeculative('beam');

    // Notify listeners that all prior per-method results for this game are
    // invalidated. The interactive panel bridge needs this: otherwise panels
    // keep showing the stale Beam/Dijkstra partial result the user was
    // reviewing when they triggered the override, even though the aggregate
    // above is already empty. Fires AFTER state is reset so listeners see a
    // clean aggregate.
    if (this.onGameReset) {
      try { this.onGameReset(gameId); } catch (e) {}
    }
  };

  function _freshAggregate(greedyStatus) {
    return {
      results: {},
      triage: null,
      picked: null,
      methodStatus: { greedy: greedyStatus, beam: 'idle', dijkstra: 'idle' }
    };
  }

  Orchestrator.prototype.cancel = function() {
    this.cancelled = true;
    METHOD_ORDER.forEach(function(m) {
      try { this._queues[m].cancel(); } catch (e) {}
    }, this);
  };

  /**
   * Abort all in-flight + queued work for a single game across all three
   * per-method queues, without affecting other games or disabling future
   * enqueues. Used when a game becomes functionally complete (revalidate
   * found no stuck point) or is explicitly verified — the algorithms are
   * no longer needed and their continued step events would overwrite the
   * "✓ Game complete" panel header set by markPanelsGameComplete.
   *
   * Mirrors the per-method abort fan-out that requeue() already does, but
   * does not re-enqueue. The aborted searches return CANCELLED, which
   * _handleMethodComplete discards, so no stale aggregate is written.
   */
  Orchestrator.prototype.abortGame = function(gameId) {
    if (!gameId) return;
    METHOD_ORDER.forEach(function(m) {
      try { this._queues[m].abortGame(gameId); } catch (e) {}
    }, this);
  };

  /**
   * User pressed the per-panel Cancel (✕) button while the game was open in
   * review. Cancel the given method's in-flight run for this game but KEEP
   * whatever partial it has produced — the cancelled method's worker rebuilds
   * a PARTIAL result (Greedy streams its applied fixes, so the partial carries
   * full review detail) and that flows through onGameComplete → the panel
   * bridge → handleSearchComplete, surfacing the Review button exactly like a
   * cancelled Greedy run in single mode.
   *
   * Differs from abortGame in two ways:
   *   1. It targets ONE method (the one whose ✕ was clicked), not all three —
   *      a sibling Beam/Dijkstra running speculatively is left alone.
   *   2. It SUPPRESSES auto-escalation for the game, so the kept partial does
   *      not silently chain to the next method. The user asked to stop here;
   *      they can still hit a method's ↻ rerun button to escalate manually.
   *
   * The cancel itself is delegated to the per-method queue's abortGame, which
   * fires the underlying SearchManager's cancel → partial-rebuild path. We set
   * the suppress flag BEFORE that call so the resulting _handleMethodComplete
   * (microtask later) sees it.
   */
  Orchestrator.prototype.cancelGameKeepPartial = function(gameId, method) {
    if (!gameId) return;
    method = method || 'greedy';
    this._escalationSuppressed[gameId] = true;
    if (this._queues[method]) {
      try { this._queues[method].abortGame(gameId); } catch (e) {}
    }
  };

  Orchestrator.prototype.resume = function() {
    this.cancelled = false;
    METHOD_ORDER.forEach(function(m) {
      try { this._queues[m].resume(); } catch (e) {}
    }, this);
  };

  Orchestrator.prototype.getStatus = function() {
    var out = { byMethod: {}, processing: false };
    var total = 0, remaining = 0;
    METHOD_ORDER.forEach(function(m) {
      var s = this._queues[m].getStatus();
      out.byMethod[m] = s;
      total += s.total; remaining += s.remaining;
      if (s.processing) out.processing = true;
    }, this);
    out.total = total;
    out.remaining = remaining;
    return out;
  };

  Orchestrator.prototype.getResult = function(gameId) {
    return this.results[gameId] || null;
  };

  // =========================================================================
  // Internal: aggregation, escalation, triage
  // =========================================================================

  Orchestrator.prototype._handleMethodComplete = function(method, gameId, payload) {
    // payload is {results, triage, picked} from the single-method queue —
    // results[method] is the interesting slot.
    var aggregate = this.results[gameId] || (this.results[gameId] = {
      results: {}, triage: null, picked: null,
      methodStatus: { greedy: 'idle', beam: 'idle', dijkstra: 'idle' }
    });

    var methodResult = (payload && payload.results && payload.results[method]) || null;

    // Cancelled completions come from abortGame (called by requeue to kill
    // stale in-flight work on the pre-override input). Discarding them
    // entirely — don't store results, don't update methodStatus, don't
    // escalate — keeps the aggregate clean while fresh work flows in.
    if (methodResult && methodResult.status === 'CANCELLED') {
      return;
    }

    aggregate.results[method] = methodResult;

    // Per-method status: 'solved' | 'partial' | 'failed' | 'error'.
    // Partial = search-worker returned status=PARTIAL: applied some fixes but
    // could not reach the end of the game. Still useful (the partial fixes
    // are real corrections), and the orchestrator escalates to the next
    // method the same way it does on failure (_solved() is strict about
    // SOLVED so the escalation path below picks this up unchanged).
    if (!payload || !payload.results) {
      aggregate.methodStatus[method] = 'error';
    } else if (_solved(methodResult)) {
      aggregate.methodStatus[method] = 'solved';
    } else if (methodResult && methodResult.status === 'PARTIAL') {
      aggregate.methodStatus[method] = 'partial';
    } else {
      aggregate.methodStatus[method] = 'failed';
    }

    // Re-triage on the current aggregate (only present methods are considered).
    if (window.BatchTriage) {
      try {
        aggregate.triage = window.BatchTriage.classifyTier(aggregate.results);
        aggregate.picked = window.BatchTriage.pickBestResult(aggregate.results);
      } catch (e) {
        aggregate.triage = { tier: 'C', reason: 'triage_error', details: { message: String(e && e.message || e) } };
      }
    }

    // Decide on escalation BEFORE firing onGameComplete so the methodStatus
    // we hand to the UI reflects the next-method queued state (otherwise the
    // panel for the next method keeps showing 'Idle' until its first step
    // event, which can be seconds or minutes away).
    //
    // Always-chain policy: if a later method exists, hand the game off,
    // even on SOLVED. CLAUDE.md says "cross-algorithm agreement is a
    // stronger signal than any single algorithm's output" — idling Beam
    // and Dijkstra after Greedy solves throws away free corroboration
    // AND lets the triage classifier actually distinguish Tier A (all
    // agree) from Tier B (some disagreement). The three queues run in
    // parallel so this doesn't block the next game moving through the
    // greedy queue; it just uses the beam/dijkstra queues that would
    // otherwise sit idle.
    //
    // Exception: VALID means the game was already valid before the
    // algorithm touched it (0 fixes, no corrections needed). Beam and
    // Dijkstra only know confirmed_ply for EAD suppression — they lack
    // Greedy's user_confirmed_plies and will re-flag user-accepted moves
    // (keep-as-is, overrides) as absurd, spinning indefinitely. There is
    // no reconstruction ambiguity to corroborate when the game is valid.
    var willEscalate = this.escalate &&
        !this._escalationSuppressed[gameId] &&
        !(methodResult && methodResult.status === 'VALID');
    var next = willEscalate ? _nextMethod(method, this._enabledMethods()) : null;
    // Per-game escalation guard: only hand the game to `next` if `next` has
    // not already been attempted for THIS game. Without speculation `next` is
    // always 'idle' here (each method runs once, in order), so this is a no-op
    // for the baseline. WITH Beam speculation, Beam may already be
    // running/done on this game when Greedy completes — this guard prevents
    // double-queuing it. methodStatus is per-game, so Beam being busy on a
    // DIFFERENT game does not block escalation here.
    if (next && aggregate.methodStatus[next] !== 'idle') {
      next = null;
    }
    var escalationInput = null;  // 'requeue' | 'enqueue' | null
    if (next) {
      var override = this._overrideByGame[gameId];
      if (override) {
        escalationInput = 'requeue';
        aggregate.methodStatus[next] = 'queued';
      } else if (this._ocrByGame[gameId]) {
        escalationInput = 'enqueue';
        aggregate.methodStatus[next] = 'queued';
      }
      // else: can't escalate (no stored input); leave methodStatus[next] alone.
    }

    // Notify the UI of this method's completion + current aggregate state.
    if (this.onGameComplete) {
      try { this.onGameComplete(gameId, aggregate, method); } catch (e) {}
    }

    if (next && escalationInput) {
      // Escalation uses the SAME input greedy saw, not this method's partial
      // fixes. If there's an override from requeue() we route through the
      // next queue's .requeue() to preserve the override; otherwise start
      // from the raw OCR result.
      if (escalationInput === 'requeue') {
        var ov = this._overrideByGame[gameId];
        this._queues[next].requeue(gameId, ov.ocrMoves, ov.lockedPlies, ov.fromPly);
      } else {
        this._queues[next].enqueue(gameId, this._ocrByGame[gameId]);
      }
      if (this.onProgress) {
        try {
          var _msg = _solved(methodResult)
            ? method + ' solved — chaining to ' + next + ' for corroboration'
            : method + ' did not solve — escalating to ' + next;
          this.onProgress(gameId, 'escalating', _msg, method);
        } catch (e) {}
      }
    }
  };

  function _nextMethod(method, enabled) {
    var idx = METHOD_ORDER.indexOf(method);
    if (idx < 0) return null;
    // Walk forward to the next ENABLED method, skipping any the user disabled
    // via Auto-Run Searches (e.g. greedy -> dijkstra when beam is off).
    for (var i = idx + 1; i < METHOD_ORDER.length; i++) {
      if (!enabled || enabled.indexOf(METHOD_ORDER[i]) >= 0) return METHOD_ORDER[i];
    }
    return null;
  }

  // Live-resolved set of methods auto-escalation may use. Greedy is always
  // included (mandatory base); beam/dijkstra mirror the interactive
  // autorun_beam / autorun_dijkstra toggles, read from currentSettings so a
  // mid-session change is honored. A constructor override wins (tests).
  Orchestrator.prototype._enabledMethods = function() {
    if (Array.isArray(this._enabledOverride)) return this._enabledOverride;
    var cs = (typeof window !== 'undefined' && window.currentSettings) || null;
    var em = ['greedy'];
    if (!cs || cs.autorun_beam !== false) em.push('beam');
    if (!cs || cs.autorun_dijkstra !== false) em.push('dijkstra');
    return em;
  };

  /**
   * Beam-only speculative work-ahead. When Beam's queue is idle, hand it the
   * HARDEST game Greedy has not yet finished so Beam stops sitting idle while
   * Greedy is the bottleneck (typical near the end of a round).
   *
   * Candidate game must satisfy ALL of:
   *   - method === 'beam' (Dijkstra is never speculated — unbounded runtime)
   *   - speculation enabled and the orchestrator not cancelled
   *   - Beam's queue is genuinely idle (not processing, nothing pending)
   *   - the game's Greedy status is still 'queued' or 'running' — i.e. Greedy
   *     has NOT finished it. This single check also excludes:
   *       · needs_truncation games (greedy status is 'needs_truncation')
   *       · already-solved / VALID games (greedy 'solved' — Beam either already
   *         chained for corroboration, or VALID is intentionally suppressed
   *         because Beam lacks user_confirmed_plies and would spin)
   *       · failed/partial/error games (Greedy already escalated → Beam not idle)
   *   - Beam has not itself been attempted on the game (beam status 'idle')
   *   - we still hold an input for the game (override or raw OCR)
   *
   * Feeds ONE game per call. Because enqueuing flips the beam queue to
   * processing synchronously, repeated idle triggers drain the pool one game
   * at a time and _maybeFireQueueComplete stays correctly suppressed until the
   * pool is empty.
   */
  Orchestrator.prototype._feedSpeculative = function(method) {
    if (method !== 'beam') return;            // Dijkstra stays escalation-only
    if (this._enabledMethods().indexOf('beam') < 0) return;  // Beam disabled by setting
    if (!this.speculative || this.cancelled) return;
    var q = this._queues[method];
    if (!q) return;
    var st = q.getStatus();
    if (st.processing || st.remaining > 0) return;  // queue not actually idle

    var self = this;
    var bestId = null, bestDiff = -Infinity;
    Object.keys(this.results).forEach(function(gameId) {
      var agg = self.results[gameId];
      if (!agg || !agg.methodStatus) return;
      var gs = agg.methodStatus.greedy;
      if (gs !== 'queued' && gs !== 'running') return;   // work AHEAD of Greedy only
      if (agg.methodStatus[method] !== 'idle') return;   // Beam already attempted
      if (!(self._overrideByGame[gameId] || self._ocrByGame[gameId])) return;  // no input
      var diff = (typeof agg._difficulty === 'number') ? agg._difficulty : 0;
      if (diff > bestDiff) { bestDiff = diff; bestId = gameId; }
    });
    if (!bestId) return;

    // Mark queued up-front so a concurrent escalation (or a second idle
    // trigger) sees Beam is no longer idle for this game and skips it.
    this.results[bestId].methodStatus[method] = 'queued';

    // Use the overridden input if the user edited this game during review;
    // otherwise the raw OCR result Greedy was launched from.
    var override = this._overrideByGame[bestId];
    if (override) {
      q.requeue(bestId, override.ocrMoves, override.lockedPlies, override.fromPly);
    } else {
      q.enqueue(bestId, this._ocrByGame[bestId]);
    }

    if (this.onProgress) {
      try {
        this.onProgress(bestId, 'speculating',
          'beam working ahead while greedy is busy', method);
      } catch (e) {}
    }
  };

  Orchestrator.prototype._maybeFireQueueComplete = function() {
    // Fire only when all three per-method queues are idle with empty queues.
    var allIdle = METHOD_ORDER.every(function(m) {
      var s = this._queues[m].getStatus();
      return !s.processing && s.remaining === 0;
    }, this);
    if (allIdle && this.onQueueComplete) {
      try { this.onQueueComplete(this.results); } catch (e) {}
    }
  };

  // =========================================================================
  // Public API
  // =========================================================================

  // Sibling to _hasTrailingNoise that returns the earliest noise-start ply
  // (or null) across the same detector trio applied to the same paired
  // input. Lets callers do position-aware gating (e.g. NW alignment banner
  // suppression) instead of a binary "noisy → block all upstream work".
  // Mirrors NoiseDetection.tailNoiseStartPly's contract but accepts the
  // dual-sheet ocrResult shape this module already understands.
  function _tailNoiseStartPly(ocrResult) {
    if (!ocrResult) return null;
    if (!window.NoiseDetection ||
        typeof window.NoiseDetection.tailNoiseStartPly !== 'function') {
      return null;
    }
    var nd = window.NoiseDetection;
    function _minStart(paired) {
      if (!Array.isArray(paired) || paired.length === 0) return null;
      return nd.tailNoiseStartPly(paired);
    }
    if (ocrResult.isDualSheet) {
      var s1 = ocrResult.sheet1 || [];
      var s2 = ocrResult.sheet2 || [];
      if (s1.length === 0 && s2.length === 0) return null;
      // Same dup-detection logic as _hasTrailingNoise: if either sheet has
      // (num, color) duplicates, the merge path would collapse them, so
      // pair each sheet independently and take the minimum start ply.
      function _hasNumColorDupes(cells) {
        if (!Array.isArray(cells)) return false;
        var seen = {};
        for (var i = 0; i < cells.length; i++) {
          var c = cells[i];
          if (!c || c.num == null) continue;
          var k = c.num + '_' + c.color;
          if (seen[k]) return true;
          seen[k] = true;
        }
        return false;
      }
      if (_hasNumColorDupes(s1) || _hasNumColorDupes(s2)) {
        var p1 = _cellsToPaired(s1);
        var p2 = _cellsToPaired(s2);
        var a = _minStart(p1);
        var b = _minStart(p2);
        if (a == null) return b;
        if (b == null) return a;
        return Math.min(a, b);
      }
      if (window.MergeSheets &&
          typeof window.MergeSheets.mergeSheets === 'function') {
        var merged = window.MergeSheets.mergeSheets(s1, s2) || [];
        return _minStart(_cellsToPaired(merged));
      }
      // No merge available — fall back to per-sheet, take the minimum.
      var p1f = _cellsToPaired(s1);
      var p2f = _cellsToPaired(s2);
      var af = _minStart(p1f);
      var bf = _minStart(p2f);
      if (af == null) return bf;
      if (bf == null) return af;
      return Math.min(af, bf);
    }
    return _minStart(_cellsToPaired(ocrResult.ocrCells || []));
  }

  return {
    Orchestrator: Orchestrator,
    METHOD_ORDER: METHOD_ORDER,
    // Pure helper — exposed so batch-game-list can mark games in the UI
    // without having to re-implement the detection logic.
    hasTrailingNoise: _hasTrailingNoise,
    // Position variant — returns the earliest noise-start ply or null.
    // Used by NW alignment banner to allow upstream alignment work when
    // the noise is far downstream of the user's working position.
    tailNoiseStartPly: _tailNoiseStartPly
  };
})();

window.BatchReconstructOrchestrator = BatchReconstructOrchestrator;
