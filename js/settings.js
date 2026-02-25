// =============================================================================
// SETTINGS SYSTEM
// =============================================================================

var DEFAULT_SETTINGS = {
  // Piece confusions
  piece_K_R: true,
  piece_B_R: true,
  piece_B_K: false,
  piece_N_R: false,
  piece_Q_O: true,
  // Piece-file confusions (for captures only: Kxg4 vs hxg4)
  piece_K_h: true,   // King K vs h-file pawn
  piece_B_b: true,   // Bishop B vs b-file pawn
  // File confusions
  file_a_g: true,
  file_a_d: true,
  file_b_d: true,
  file_e_c: true,
  file_f_t: false,
  file_b_h: false,
  // Rank confusions
  rank_1_7: true,
  rank_2_7: true,
  rank_3_8: true,
  rank_4_5: true,
  rank_1_4: false,
  rank_6_8: false,
  // Other quick fixes
  fix_capture_notation: true,
  fix_combined: true,
  // Quick fix pipeline settings
  enable_quick_fixes: true,      // Layer 1: Try OCR alternatives and similarity swaps
  enable_deep_search: true,      // Layer 2: Backtrack search for fixes (shown for confirmation)
  deep_search_depth: 5,          // Phase 2 depth: how many plies before frontier to search (0=none, 999=full game)
  // Auto-fix toggles (when off, fixes are shown as clickable quick fixes instead of auto-applying)
  ocr_autofix: false,            // Auto-apply OCR alternatives (one-or-nothing rule)
  similarity_autofix: false,     // Auto-apply character similarity fixes
  // Display options
  show_debug_output: false,
  show_ocr_confidence: true,
  show_alternatives_count: 3
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
  return pairs;
}

function getEnabledPieceFileConfusions() {
  // Piece letter <-> file letter confusions (for captures: Kxg4 vs hxg4)
  var pairs = [];
  if (currentSettings.piece_K_h) { pairs.push(['K','h'], ['h','K']); }
  if (currentSettings.piece_B_b) { pairs.push(['B','b'], ['b','B']); }
  return pairs;
}

function getEnabledFileConfusions() {
  var pairs = [];
  if (currentSettings.file_a_g) { pairs.push(['a','g'], ['g','a']); }
  if (currentSettings.file_a_d) { pairs.push(['a','d'], ['d','a']); }
  if (currentSettings.file_b_d) { pairs.push(['b','d'], ['d','b']); }
  if (currentSettings.file_e_c) { pairs.push(['e','c'], ['c','e']); }
  if (currentSettings.file_b_h) { pairs.push(['b','h'], ['h','b']); }
  return pairs;
}

function getEnabledRankConfusions() {
  var pairs = [];
  if (currentSettings.rank_1_7) { pairs.push(['1','7'], ['7','1']); }
  if (currentSettings.rank_2_7) { pairs.push(['2','7'], ['7','2']); }
  if (currentSettings.rank_3_8) { pairs.push(['3','8'], ['8','3']); }
  if (currentSettings.rank_4_5) { pairs.push(['4','5'], ['5','4']); }
  if (currentSettings.rank_1_4) { pairs.push(['1','4'], ['4','1']); }
  if (currentSettings.rank_6_8) { pairs.push(['6','8'], ['8','6']); }
  return pairs;
}

function getAutoFixSettings() {
  return {
    piece_confusions: getEnabledPieceConfusions(),
    piece_file_confusions: getEnabledPieceFileConfusions(),
    file_confusions: getEnabledFileConfusions(),
    rank_confusions: getEnabledRankConfusions(),
    fix_capture: currentSettings.fix_capture_notation,
    fix_combined: currentSettings.fix_combined,
    // Quick fix pipeline settings
    enable_quick_fixes: currentSettings.enable_quick_fixes,
    enable_deep_search: currentSettings.enable_deep_search,
    deep_search_depth: currentSettings.deep_search_depth,
    // Auto-fix toggles
    ocr_autofix: currentSettings.ocr_autofix,
    similarity_autofix: currentSettings.similarity_autofix,
    // For backward compatibility with backend
    max_changes: currentSettings.enable_quick_fixes ? 2 : 0
  };
}
