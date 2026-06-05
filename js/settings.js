// =============================================================================
// SETTINGS SYSTEM
// =============================================================================

var DEFAULT_SETTINGS = {
  // Piece confusions
  piece_K_R: true,
  piece_B_R: true,
  piece_B_K: false,
  piece_N_R: false,
  piece_N_B: true,
  // Piece-file confusions (for captures only: Kxg4 vs hxg4)
  piece_K_h: true,   // King K vs h-file pawn
  piece_B_b: true,   // Bishop B vs b-file pawn
  // Quick fix pipeline settings
  enable_quick_fixes: true,      // Layer 1: Try OCR alternatives and similarity swaps
  enable_deep_search: true,      // Layer 2: Backtrack search for fixes (shown for confirmation)
  deep_search_depth: 5,          // Phase 2 depth: how many plies before frontier to search (0=none, 999=full game)
  // Auto-fix toggles (when off, fixes are shown as clickable quick fixes instead of auto-applying)
  ocr_autofix: false,            // Auto-apply OCR alternatives (one-or-nothing rule)
  similarity_autofix: false,     // Auto-apply character similarity fixes
  // Auto-run searches on entering interactive mode
  autorun_greedy: true,
  autorun_beam: true,
  autorun_dijkstra: true
};

var currentSettings = null;

function loadSettings() {
  try {
    var saved = localStorage.getItem('zugwise_settings');
    if (saved) {
      var parsed = JSON.parse(saved);
      // Merge with defaults to handle new settings
      return Object.assign({}, DEFAULT_SETTINGS, parsed);
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
  return Object.assign({}, DEFAULT_SETTINGS);
}

function saveSettings(settings) {
  try {
    localStorage.setItem('zugwise_settings', JSON.stringify(settings));
  } catch (e) {
    console.warn('Failed to save settings:', e);
  }
}

function resetSettings() {
  localStorage.removeItem('zugwise_settings');
  return Object.assign({}, DEFAULT_SETTINGS);
}

function openSettings() {
  // Populate UI from currentSettings
  if(currentSettings){
    Object.keys(currentSettings).forEach(function(key) {
      var el = document.getElementById('set-' + key);
      if (el) {
        if (el.type === 'checkbox') {
          el.checked = currentSettings[key];
        } else if (el.tagName === 'SELECT') {
          el.value = currentSettings[key];
        }
      }
    });
  }
  var modal=document.getElementById('settings-modal');
  if(modal)modal.classList.remove('hidden');
}

function closeSettings() {
  var modal=document.getElementById('settings-modal');
  if(modal)modal.classList.add('hidden');
}

function saveSettingsUI() {
  // Read UI values into currentSettings
  Object.keys(DEFAULT_SETTINGS).forEach(function(key) {
    var el = document.getElementById('set-' + key);
    if (el) {
      if (el.type === 'checkbox') {
        currentSettings[key] = el.checked;
      } else if (el.tagName === 'SELECT') {
        var parsed = parseInt(el.value);
        currentSettings[key] = isNaN(parsed) ? el.value : parsed;
      }
    }
  });
  saveSettings(currentSettings);
  closeSettings();
  log('Settings saved');
}

function resetSettingsUI() {
  if (confirm('Reset all settings to defaults?')) {
    currentSettings = resetSettings();
    openSettings(); // Refresh UI
    log('Settings reset to defaults');
  }
}

// Helper: Get enabled confusions from settings
function getEnabledPieceConfusions() {
  var pairs = [];
  if (currentSettings.piece_K_R) { pairs.push(['K','R'], ['R','K']); }
  if (currentSettings.piece_B_R) { pairs.push(['B','R'], ['R','B']); }
  if (currentSettings.piece_B_K) { pairs.push(['B','K'], ['K','B']); }
  if (currentSettings.piece_N_R) { pairs.push(['N','R'], ['R','N']); }
  if (currentSettings.piece_N_B) { pairs.push(['N','B'], ['B','N']); }
  return pairs;
}

function getEnabledPieceFileConfusions() {
  // Piece letter <-> file letter confusions (for captures: Kxg4 vs hxg4)
  var pairs = [];
  if (currentSettings.piece_K_h) { pairs.push(['K','h'], ['h','K']); }
  if (currentSettings.piece_B_b) { pairs.push(['B','b'], ['b','B']); }
  return pairs;
}

function getAutoFixSettings() {
  // PGN-validate mode: typed games carry rare-but-deep typos (e.g. Qd2 for
  // Qe3 surfacing as an absurdity 10+ plies later). The default
  // deep_search_depth=5 governs Phase 2's lookback past the user's
  // confirmed frontier — fine for OCR where errors cluster near the
  // working ply, too shallow once any plies get confirmed in PGN mode.
  // Force full-game lookback so a typo at move 10 stays in scope after
  // the user confirms moves 0-15. OCR mode keeps the user-configured value.
  var depth = currentSettings.deep_search_depth;
  if (typeof state !== 'undefined' && state && state.inputMode === 'pgn') {
    depth = 999;
  }
  return {
    piece_confusions: getEnabledPieceConfusions(),
    piece_file_confusions: getEnabledPieceFileConfusions(),
    // Quick fix pipeline settings
    enable_quick_fixes: currentSettings.enable_quick_fixes,
    enable_deep_search: currentSettings.enable_deep_search,
    deep_search_depth: depth,
    // Auto-fix toggles
    ocr_autofix: currentSettings.ocr_autofix,
    similarity_autofix: currentSettings.similarity_autofix,
    // For backward compatibility with backend
    max_changes: currentSettings.enable_quick_fixes ? 2 : 0
  };
}
