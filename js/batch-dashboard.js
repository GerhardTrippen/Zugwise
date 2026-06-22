// =============================================================================
// batch-dashboard.js — Compact color-grid dashboard for large tournaments
// =============================================================================
// Phase 5 of Batch Mode. When a round has many games (e.g. 60+ boards), the
// linear game-list sidebar becomes hard to scan. This module presents the
// same state as a dense grid — one square per game, coloured by status and
// tier — so the user can see progress at a glance and jump directly to any
// game.
//
// Module API:
//   BatchDashboard.toggle()
//   BatchDashboard.show()
//   BatchDashboard.hide()
//   BatchDashboard.render()           // re-render if currently visible
//   BatchDashboard.refreshIfOpen()    // called by batch-game-list after state updates
//
// Dependencies:
//   - BatchGameList.batchState, selectGame, GAME_STATUS
//   - BatchTriage.TIER_DISPLAY (optional, for tier colour accent)
// =============================================================================

var BatchDashboard = (function() {
  'use strict';

  var MODAL_ID = 'batch-dashboard-modal';
  var visible = false;

  // Status → short label / colour class mapping. Independent of the sidebar's
  // STATUS_DISPLAY so the grid cells stay compact (icon-free text fallback).
  var STATUS_COLOR = {
    'queued':             { bg: 'bg-gray-700',    ring: '', icon: '\u2B1C' },
    'ocr_running':        { bg: 'bg-blue-600',    ring: 'animate-pulse', icon: '\uD83D\uDD35' },
    'ocr_complete':       { bg: 'bg-gray-500',    ring: '', icon: '\u2B1C' },
    'ocr_error':          { bg: 'bg-red-700',     ring: '', icon: '\uD83D\uDD34' },
    'grid_warning':       { bg: 'bg-yellow-600',  ring: '', icon: '\u26A0\uFE0F' },
    'grid_failed':        { bg: 'bg-red-700',     ring: '', icon: '\uD83D\uDD34' },
    'reconstructing':     { bg: 'bg-blue-500',    ring: 'animate-pulse', icon: '\u2699\uFE0F' },
    'reconstruct_error':  { bg: 'bg-red-700',     ring: '', icon: '\uD83D\uDD34' },
    'needs_review':       { bg: 'bg-yellow-500',  ring: '', icon: '\uD83D\uDFE1' },
    'in_review':          { bg: 'bg-blue-400',    ring: '', icon: '\uD83D\uDD0D' },
    'verified':           { bg: 'bg-green-600',   ring: '', icon: '\u2705' },
    'exported':           { bg: 'bg-green-700',   ring: '', icon: '\u2705' }
  };

  function _bgl() { return window.BatchGameList; }
  function _state() {
    var bgl = _bgl();
    return (bgl && bgl.batchState) || null;
  }

  function toggle() { return visible ? hide() : show(); }

  function show() {
    var state = _state();
    if (!state || !state.active || state.games.size === 0) {
      if (typeof log === 'function') log('Dashboard unavailable — no active batch round');
      return;
    }
    visible = true;
    render();
  }

  function hide() {
    visible = false;
    var modal = document.getElementById(MODAL_ID);
    if (modal) modal.remove();
  }

  function refreshIfOpen() {
    if (visible) render();
  }

  function render() {
    if (!visible) return;
    var state = _state();
    if (!state || !state.active) { hide(); return; }

    var modal = document.getElementById(MODAL_ID);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = MODAL_ID;
      modal.className = 'fixed inset-0 z-40 flex items-center justify-center bg-black/70';
      modal.addEventListener('click', function(e) {
        if (e.target === modal) hide();
      });
      document.body.appendChild(modal);
    }

    modal.innerHTML = _renderHtml(state);

    // Close button
    var closeBtn = modal.querySelector('[data-action="close"]');
    if (closeBtn) closeBtn.onclick = hide;

    // Cell click handlers
    var cells = modal.querySelectorAll('[data-game-id]');
    cells.forEach(function(el) {
      el.addEventListener('click', function() {
        var gid = el.getAttribute('data-game-id');
        var bgl = _bgl();
        if (bgl && typeof bgl.selectGame === 'function') {
          bgl.selectGame(gid);
        }
        hide();
      });
    });
  }

  function _renderHtml(state) {
    var isPlayer = state.batchMode === 'player';

    // Player mode groups by round (a player's games span rounds; board numbers
    // repeat, so round is the distinguishing axis). Round mode groups by
    // section. Either way: one labelled group per key, games sorted within.
    var groups = {};
    state.games.forEach(function(g) {
      var key = isPlayer
        ? 'Round ' + (g.round != null ? g.round : '?')
        : (g.section || '(no section)');
      if (!groups[key]) groups[key] = [];
      groups[key].push(g);
    });
    Object.keys(groups).forEach(function(k) {
      groups[k].sort(function(a, b) {
        if (isPlayer && (a.round || 0) !== (b.round || 0)) {
          return (a.round || 0) - (b.round || 0);
        }
        return (a.board || 0) - (b.board || 0);
      });
    });

    // Order group headers: round mode alphabetically by section; player mode
    // numerically by round.
    var groupKeys = Object.keys(groups).sort(function(a, b) {
      if (isPlayer) {
        var ra = parseInt(a.replace(/\D+/g, ''), 10);
        var rb = parseInt(b.replace(/\D+/g, ''), 10);
        if (!isNaN(ra) && !isNaN(rb)) return ra - rb;
      }
      return a.localeCompare(b);
    });
    var multiGroup = groupKeys.length > 1;
    var totals = _totals(state);

    var h = '';
    h += '<div class="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl max-w-5xl w-[90vw] max-h-[85vh] overflow-hidden flex flex-col">';

    // Header
    h += '<div class="flex items-center justify-between px-4 py-3 border-b border-gray-700">';
    h += '<div>';
    h += '<h2 class="text-lg font-semibold text-gray-100">Tournament Dashboard</h2>';
    var scopeLabel = isPlayer
      ? 'Player ' + _escape(state.selectedPlayerName || '?')
      : 'Round ' + (state.selectedRound != null ? state.selectedRound : '?');
    h += '<p class="text-xs text-gray-400">' + scopeLabel +
         ' \u2014 ' + totals.verified + '/' + totals.total + ' verified, ' +
         totals.ocrDone + '/' + totals.total + ' OCR done</p>';
    h += '</div>';
    h += '<button data-action="close" class="text-gray-400 hover:text-white text-2xl leading-none px-2">&times;</button>';
    h += '</div>';

    // Body
    h += '<div class="flex-1 overflow-y-auto px-4 py-3 space-y-4">';
    groupKeys.forEach(function(key) {
      h += _renderSection(key, groups[key], state, multiGroup, isPlayer);
    });
    h += '</div>';

    // Legend footer
    h += '<div class="px-4 py-2 border-t border-gray-700 text-[11px] text-gray-400 flex flex-wrap gap-3">';
    h += _legendChip('bg-green-600', 'Verified');
    h += _legendChip('bg-yellow-500', 'Needs review');
    h += _legendChip('bg-blue-400', 'Reviewing');
    h += _legendChip('bg-blue-500', 'Reconstructing');
    h += _legendChip('bg-gray-500', 'OCR done');
    h += _legendChip('bg-gray-700', 'Queued');
    h += _legendChip('bg-red-700', 'Error');
    h += '</div>';

    h += '</div>';
    return h;
  }

  function _renderSection(groupLabel, games, state, multiGroup, isPlayer) {
    var h = '';
    if (multiGroup) {
      h += '<div class="text-sm font-medium text-gray-300 mb-1">' + _escape(groupLabel) + '</div>';
    }
    h += '<div class="grid gap-1" style="grid-template-columns: repeat(auto-fill, minmax(44px, 1fr))">';
    games.forEach(function(g) {
      h += _renderCell(g, state, isPlayer);
    });
    h += '</div>';
    return h;
  }

  function _renderCell(game, state, isPlayer) {
    var color = STATUS_COLOR[game.status] || STATUS_COLOR.queued;
    var isActive = game.gameId === state.currentGameId;
    var tier = game.tier || '';
    var tierClass = '';
    if (window.BatchTriage && window.BatchTriage.TIER_DISPLAY && window.BatchTriage.TIER_DISPLAY[tier]) {
      tierClass = ' ring-1 ring-offset-0';
    }

    var classes = 'relative flex flex-col items-center justify-center rounded h-11 ' +
                  'text-white text-xs font-medium cursor-pointer hover:brightness-125 transition ' +
                  color.bg + ' ' + (color.ring || '') + tierClass;
    if (isActive) classes += ' outline outline-2 outline-blue-300';

    var pairing = game.pairing || null;
    var tip = _tooltip(game, pairing);

    var label = 'B' + (game.board != null ? game.board : '?');
    var h = '<div class="' + classes + '" data-game-id="' + _escape(game.gameId) + '" title="' + _escape(tip) + '">';
    h += '<span class="text-[10px] leading-tight">' + label + '</span>';
    if (tier) {
      h += '<span class="text-[9px] opacity-80 leading-tight">' + tier + '</span>';
    } else if (color.icon && !tier) {
      // Small icon when no tier — keeps cell readable at a glance.
      h += '<span class="text-[10px] leading-tight">' + color.icon + '</span>';
    }
    h += '</div>';
    return h;
  }

  function _tooltip(game, pairing) {
    var parts = [];
    var loc = (game.round != null ? 'Round ' + game.round + ', ' : '') +
              'Board ' + (game.board != null ? game.board : '?');
    parts.push(loc);
    if (pairing && (pairing.whiteName || pairing.blackName)) {
      parts.push((pairing.whiteName || '?') + ' vs ' + (pairing.blackName || '?'));
    }
    parts.push('Status: ' + game.status);
    if (game.tier) parts.push('Tier ' + game.tier);
    return parts.join('\n');
  }

  function _legendChip(bgClass, label) {
    return '<span class="inline-flex items-center gap-1">' +
           '<span class="inline-block w-3 h-3 rounded ' + bgClass + '"></span>' +
           _escape(label) + '</span>';
  }

  function _totals(state) {
    var total = state.games.size;
    var verified = 0, ocrDone = 0;
    state.games.forEach(function(g) {
      if (g.status === 'verified' || g.status === 'exported') verified++;
      if (g.status !== 'queued' && g.status !== 'ocr_running') ocrDone++;
    });
    return { total: total, verified: verified, ocrDone: ocrDone };
  }

  function _escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ESC key closes the modal.
  document.addEventListener('keydown', function(e) {
    if (visible && e.key === 'Escape') hide();
  });

  return {
    toggle: toggle,
    show: show,
    hide: hide,
    render: render,
    refreshIfOpen: refreshIfOpen
  };
})();

window.BatchDashboard = BatchDashboard;
