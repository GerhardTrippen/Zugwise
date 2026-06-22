// =============================================================================
// SHEET-PROFILES.JS - Sheet Profile Configuration System
// =============================================================================
// Manages scoresheet layout profiles (format, rowCount, headerRows, footerRows,
// startingMove) with preset templates, localStorage persistence, and export/import.
//
// Dependencies: grid-detection.js (getGridConfig)
// =============================================================================

// =============================================================================
// DEFAULT PRESET PROFILES
// =============================================================================

var DEFAULT_PROFILES = [
    // --- Generic defaults (cols-first matches the scoresheet's visual unit:
    //     you fill move-by-move down a column before moving to the next) ---
    {
        name: "2 cols x 20 rows Default (2 pages)",
        builtin: true,
        pages: [
            { format: '2col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 41 }
        ]
    },
    {
        name: "2 cols x 25 rows Default (2 pages)",
        builtin: true,
        pages: [
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 51 }
        ]
    },
    {
        name: "2 cols x 30 rows Default (2 pages)",
        builtin: true,
        pages: [
            { format: '2col', rowCount: 30, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 30, headerRows: 0, footerRows: 0, startingMove: 61 }
        ]
    },
    {
        name: "2 cols x 35 rows Default (2 pages)",
        builtin: true,
        pages: [
            { format: '2col', rowCount: 35, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 35, headerRows: 0, footerRows: 0, startingMove: 71 }
        ]
    },
    {
        name: "3 cols x 20 rows Default (2 pages)",
        builtin: true,
        pages: [
            { format: '3col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '3col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 61 }
        ]
    },
    {
        name: "3 cols x 25 rows Default (2 pages)",
        builtin: true,
        pages: [
            { format: '3col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '3col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 76 }
        ]
    },
    // --- Club-specific profiles (alphabetical) ---
    {
        name: "Annex Chess Club Carbon Copy (2 cols x 25 rows, 1 page)",
        builtin: true,
        city: "Toronto", country: "CAN",
        pages: [
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Aurora Chess Club Carbon Copy (2 cols x 25 rows, 1 page)",
        builtin: true,
        city: "Aurora", country: "CAN",
        pages: [
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Bob & Gord's Milton Rapid (2 cols x 20 rows x 2 pages)",
        builtin: true,
        city: "Milton", country: "CAN",
        pages: [
            { format: '2col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 41 }
        ]
    },
    {
        name: "Carbon Copy (2 cols x 25 rows x 2 pages)",
        builtin: true,
        pages: [
            { format: '2col', rowCount: 25, headerRows: 1, footerRows: 1, startingMove: 1 },
            { format: '2col', rowCount: 25, headerRows: 1, footerRows: 1, startingMove: 51 }
        ]
    },
    {
        name: "Chess Federation of Canada (2 cols x 25 rows + 2 cols x 15 rows, 2 pages)",
        builtin: true,
        country: "CAN",
        pages: [
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 15, headerRows: 0, footerRows: 0, startingMove: 51 }
        ]
    },
    {
        name: "Chess'n Math Association Carbon Copy (3 cols x 25 rows, 1 page)",
        builtin: true,
        country: "CAN",
        pages: [
            { format: '3col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '3col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Collingwood-Somborac Chess Festival Carbon Copy (2 cols x 25 rows, 1 page)",
        builtin: true,
        city: "Collingwood", country: "CAN",
        pages: [
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Excelsior Chess Club Carbon Copy (2 cols x 24 rows, 1 page)",
        builtin: true,
        country: "CAN",
        pages: [
            { format: '2col', rowCount: 24, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 24, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Federation Quebecoise Des Echecs Carbon Copy (3 cols x 25 rows, 1 page)",
        builtin: true,
        country: "CAN",
        pages: [
            { format: '3col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '3col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Forcing Moves First (2 cols x 25 rows x 2 pages)",
        builtin: true,
        pages: [
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 51 }
        ]
    },
    {
        name: "Hart House Chess Club Carbon Copy (3 cols x 25 rows, 1 page)",
        builtin: true,
        city: "Toronto", country: "CAN",
        pages: [
            { format: '3col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '3col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Kitchener Waterloo Chess Club (2 cols x 30 rows x 2 pages)",
        builtin: true,
        city: "Kitchener", country: "CAN",
        pages: [
            { format: '2col', rowCount: 30, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 30, headerRows: 0, footerRows: 0, startingMove: 61 }
        ]
    },
    {
        name: "Mississauga Chess Club (2 cols x 20 rows + 2 cols x 25 rows, 2 pages)",
        builtin: true,
        city: "Mississauga", country: "CAN",
        pages: [
            { format: '2col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 41 }
        ]
    },
    {
        name: "Mississauga Chess Club Carbon Copy Old (2 cols x 20 rows, 1 page)",
        builtin: true,
        city: "Mississauga", country: "CAN",
        pages: [
            { format: '2col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Mississauga Chess Club Carbon Copy (3 cols x 20 rows, 1 page)",
        builtin: true,
        city: "Mississauga", country: "CAN",
        pages: [
            { format: '3col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '3col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Niagara Chess Carbon Copy (2 cols x 25 rows, 1 page)",
        builtin: true,
        country: "CAN",
        pages: [
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 25, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Scarborough Chess Club Carbon Copy (3 cols x 26 rows, 1 page)",
        builtin: true,
        city: "Scarborough", country: "CAN",
        pages: [
            { format: '3col', rowCount: 26, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '3col', rowCount: 26, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Silent Storm Chess Academy Brampton Carbon Copy (2 cols x 35 rows, 1 page)",
        builtin: true,
        city: "Brampton", country: "CAN",
        pages: [
            { format: '2col', rowCount: 35, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 35, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    },
    {
        name: "Vancity Chess Carbon Copy (2 cols x 30 rows, 1 page)",
        builtin: true,
        city: "Vancouver", country: "CAN",
        pages: [
            { format: '2col', rowCount: 30, headerRows: 0, footerRows: 0, startingMove: 1 },
            { format: '2col', rowCount: 30, headerRows: 0, footerRows: 0, startingMove: 1 }
        ]
    }
];

var STORAGE_KEY_PROFILES = 'zugwise_sheet_profiles';
var STORAGE_KEY_ACTIVE = 'zugwise_active_profile';

// Old-name → new-name map for every renaming wave so far. Lets a user's
// saved active-profile selection survive each rename so they don't get
// silently bumped back to the first entry on next load.
//
// Three waves so far:
//   1) Generic defaults: rows-first → cols-first
//   2) Club templates: pre-existing names → "<Club> [Carbon Copy] N-Move (<P> page[s])"
//   3) Club templates: move count → explicit "<C> cols x <R> rows" per page.
//      Move count was ambiguous (60 = 3x20 or 2x30); this is exact.
//
// Both wave-1 (original) and wave-2 (move-count) club entries are mapped
// directly to their wave-3 names so a user on either generation lands
// on the current canonical name.
var LEGACY_PROFILE_NAME_MAP = {
    // Wave 1 — generic defaults rename
    '20 rows x 2 cols Default (2 pages)': '2 cols x 20 rows Default (2 pages)',
    '20 rows x 3 cols Default (2 pages)': '3 cols x 20 rows Default (2 pages)',
    '25 rows x 2 cols Default (2 pages)': '2 cols x 25 rows Default (2 pages)',
    '25 rows x 3 cols Default (2 pages)': '3 cols x 25 rows Default (2 pages)',
    '30 rows x 2 cols Default (2 pages)': '2 cols x 30 rows Default (2 pages)',
    '35 rows x 2 cols Default (2 pages)': '2 cols x 35 rows Default (2 pages)',

    // Wave 1 club names (pre-rename) → wave 3 (current cols x rows)
    'Annex Chess Club 50-Move Carbon Copy (1 page)':
        'Annex Chess Club Carbon Copy (2 cols x 25 rows, 1 page)',
    'Aurora Chess Club 50-Move (1 page)':
        'Aurora Chess Club Carbon Copy (2 cols x 25 rows, 1 page)',
    "Bob & Gord's Milton Rapid (2 pages)":
        "Bob & Gord's Milton Rapid (2 cols x 20 rows x 2 pages)",
    'Carbon Copy 50-Move (2 pages)':
        'Carbon Copy (2 cols x 25 rows x 2 pages)',
    'Chess Federation of Canada (2 pages)':
        'Chess Federation of Canada (2 cols x 25 rows + 2 cols x 15 rows, 2 pages)',
    "Chess'n Math Association 75-Move Carbon Copy (1 page)":
        "Chess'n Math Association Carbon Copy (3 cols x 25 rows, 1 page)",
    'Collingwood-Somborac Chess Festival 50-Move Carbon Copy (1 page)':
        'Collingwood-Somborac Chess Festival Carbon Copy (2 cols x 25 rows, 1 page)',
    'Excelsior Chess Club (1 page)':
        'Excelsior Chess Club Carbon Copy (2 cols x 24 rows, 1 page)',
    'Federation Quebecoise Des Echecs 75-Move Carbon Copy (1 page)':
        'Federation Quebecoise Des Echecs Carbon Copy (3 cols x 25 rows, 1 page)',
    'Forcing Moves First (2 pages)':
        'Forcing Moves First (2 cols x 25 rows x 2 pages)',
    'Hart House Chess Club 75-Move Carbon Copy (1 page)':
        'Hart House Chess Club Carbon Copy (3 cols x 25 rows, 1 page)',
    'Kitchener Waterloo Chess Club (2 pages)':
        'Kitchener Waterloo Chess Club (2 cols x 30 rows x 2 pages)',
    'Mississauga Chess Club (2 pages)':
        'Mississauga Chess Club (2 cols x 20 rows + 2 cols x 25 rows, 2 pages)',
    'Mississauga Chess Club 40-Move Carbon Copy Old (1 page)':
        'Mississauga Chess Club Carbon Copy Old (2 cols x 20 rows, 1 page)',
    'Mississauga Chess Club 60-Move Carbon Copy (1 page)':
        'Mississauga Chess Club Carbon Copy (3 cols x 20 rows, 1 page)',
    'Niagara Chess (1 page)':
        'Niagara Chess Carbon Copy (2 cols x 25 rows, 1 page)',
    'Scarborough Chess Club (1 page)':
        'Scarborough Chess Club Carbon Copy (3 cols x 26 rows, 1 page)',
    'Silent Storm Chess Academy Brampton Carbon Copy (1 page)':
        'Silent Storm Chess Academy Brampton Carbon Copy (2 cols x 35 rows, 1 page)',
    'Vancity Chess Carbon Copy (1 page)':
        'Vancity Chess Carbon Copy (2 cols x 30 rows, 1 page)',

    // Wave 2 club names (move-count generation) → wave 3 (current cols x rows)
    'Annex Chess Club Carbon Copy 50-Move (1 page)':
        'Annex Chess Club Carbon Copy (2 cols x 25 rows, 1 page)',
    'Aurora Chess Club Carbon Copy 50-Move (1 page)':
        'Aurora Chess Club Carbon Copy (2 cols x 25 rows, 1 page)',
    "Bob & Gord's Milton Rapid 80-Move (2 pages)":
        "Bob & Gord's Milton Rapid (2 cols x 20 rows x 2 pages)",
    'Carbon Copy 100-Move (2 pages)':
        'Carbon Copy (2 cols x 25 rows x 2 pages)',
    'Chess Federation of Canada 80-Move (2 pages)':
        'Chess Federation of Canada (2 cols x 25 rows + 2 cols x 15 rows, 2 pages)',
    "Chess'n Math Association Carbon Copy 75-Move (1 page)":
        "Chess'n Math Association Carbon Copy (3 cols x 25 rows, 1 page)",
    'Collingwood-Somborac Chess Festival Carbon Copy 50-Move (1 page)':
        'Collingwood-Somborac Chess Festival Carbon Copy (2 cols x 25 rows, 1 page)',
    'Excelsior Chess Club Carbon Copy 48-Move (1 page)':
        'Excelsior Chess Club Carbon Copy (2 cols x 24 rows, 1 page)',
    'Federation Quebecoise Des Echecs Carbon Copy 75-Move (1 page)':
        'Federation Quebecoise Des Echecs Carbon Copy (3 cols x 25 rows, 1 page)',
    'Forcing Moves First 100-Move (2 pages)':
        'Forcing Moves First (2 cols x 25 rows x 2 pages)',
    'Hart House Chess Club Carbon Copy 75-Move (1 page)':
        'Hart House Chess Club Carbon Copy (3 cols x 25 rows, 1 page)',
    'Kitchener Waterloo Chess Club 120-Move (2 pages)':
        'Kitchener Waterloo Chess Club (2 cols x 30 rows x 2 pages)',
    'Mississauga Chess Club 90-Move (2 pages)':
        'Mississauga Chess Club (2 cols x 20 rows + 2 cols x 25 rows, 2 pages)',
    'Mississauga Chess Club Carbon Copy 40-Move Old (1 page)':
        'Mississauga Chess Club Carbon Copy Old (2 cols x 20 rows, 1 page)',
    'Mississauga Chess Club Carbon Copy 60-Move (1 page)':
        'Mississauga Chess Club Carbon Copy (3 cols x 20 rows, 1 page)',
    'Niagara Chess Carbon Copy 50-Move (1 page)':
        'Niagara Chess Carbon Copy (2 cols x 25 rows, 1 page)',
    'Scarborough Chess Club Carbon Copy 78-Move (1 page)':
        'Scarborough Chess Club Carbon Copy (3 cols x 26 rows, 1 page)',
    'Silent Storm Chess Academy Brampton Carbon Copy 70-Move (1 page)':
        'Silent Storm Chess Academy Brampton Carbon Copy (2 cols x 35 rows, 1 page)',
    'Vancity Chess Carbon Copy 60-Move (1 page)':
        'Vancity Chess Carbon Copy (2 cols x 30 rows, 1 page)'
};

// In-memory state
var _profiles = [];
var _activeProfileName = '';
var _editorOriginalName = null; // tracks which profile is being edited

// =============================================================================
// STORAGE
// =============================================================================

function loadProfiles() {
    // Start with defaults
    _profiles = DEFAULT_PROFILES.map(function(p) {
        return JSON.parse(JSON.stringify(p));
    });

    // Merge saved custom profiles
    try {
        var saved = localStorage.getItem(STORAGE_KEY_PROFILES);
        if (saved) {
            var customProfiles = JSON.parse(saved);
            if (Array.isArray(customProfiles)) {
                customProfiles.forEach(function(cp) {
                    // Skip if it has the same name as a builtin
                    var existingIdx = _profiles.findIndex(function(p) { return p.name === cp.name; });
                    if (existingIdx >= 0 && _profiles[existingIdx].builtin) {
                        // User saved over a builtin — replace it
                        _profiles[existingIdx] = cp;
                    } else if (existingIdx < 0) {
                        _profiles.push(cp);
                    }
                });
            }
        }
    } catch (e) {
        console.warn('[Profiles] Error loading saved profiles:', e);
    }

    // Load active profile name
    _activeProfileName = localStorage.getItem(STORAGE_KEY_ACTIVE) || DEFAULT_PROFILES[0].name;

    // Migrate legacy "rows x cols" default names to the new "cols x rows" names.
    if (LEGACY_PROFILE_NAME_MAP[_activeProfileName]) {
        _activeProfileName = LEGACY_PROFILE_NAME_MAP[_activeProfileName];
        try { localStorage.setItem(STORAGE_KEY_ACTIVE, _activeProfileName); } catch (e) {}
    }

    // Ensure active profile exists
    if (!_profiles.find(function(p) { return p.name === _activeProfileName; })) {
        _activeProfileName = _profiles[0].name;
    }

    return _profiles;
}

function saveProfiles() {
    // Only save non-builtin profiles (or builtin ones that were modified)
    var toSave = _profiles.filter(function(p) { return !p.builtin; });
    try {
        localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(toSave));
        localStorage.setItem(STORAGE_KEY_ACTIVE, _activeProfileName);
    } catch (e) {
        console.warn('[Profiles] Error saving profiles:', e);
    }
}

function getActiveProfile() {
    var profile = _profiles.find(function(p) { return p.name === _activeProfileName; });
    if (!profile && _profiles.length > 0) {
        profile = _profiles[0];
        _activeProfileName = profile.name;
    }
    return profile || DEFAULT_PROFILES[0];
}

function setActiveProfile(name) {
    _activeProfileName = name;
    try {
        localStorage.setItem(STORAGE_KEY_ACTIVE, name);
    } catch (e) {
        console.warn('[Profiles] Error saving active profile:', e);
    }
}

/**
 * Location (city/country) associated with the active scoresheet template.
 * Used to populate the PGN [Site] tag and [EventCountry] when the tournament
 * file doesn't carry them (chess-results.com per-round XLS never does).
 * `site` follows the PGN convention "City COUNTRY" (e.g. "Mississauga CAN").
 * Returns empty strings (not '?') when the profile has no location set, so
 * callers keep their own '?' fallback.
 */
function getActiveProfileLocation() {
    var p = getActiveProfile() || {};
    var city = String(p.city || '').trim();
    var country = String(p.country || '').trim();
    // Site needs a city ("City COUNTRY"); a country alone is not a valid Site,
    // so country-only templates leave Site to its '?' fallback while still
    // supplying EventCountry.
    var site = city ? (country ? city + ' ' + country : city) : '';
    return { city: city, country: country, site: site };
}

// =============================================================================
// CONFIG ACCESSOR (central integration point)
// =============================================================================

/**
 * Get grid config from the active profile for a specific page.
 *
 * **CYCLIC recycling** when pageNumber > profile.pages.length: the template
 * is treated as one "sheet cycle" and repeated. For an asymmetric template
 * (e.g., page 1 has a signature header, page 2 doesn't, different rowCount),
 * page 3 mirrors page 1, page 4 mirrors page 2, page 5 mirrors page 1 again,
 * and so on — exactly how a tournament player flips to a second double-sided
 * scoresheet when the first runs out. R-style vector recycling.
 *
 * Literal fields (format, rowCount, headerRows, footerRows, gridType) recycle
 * directly from the corresponding template page in the cycle.
 *
 * `startingMove` is the exception: it EXTRAPOLATES rather than literal-recycles.
 * Each completed cycle adds `cycleSize` moves (sum of movesPerPage across all
 * template pages). Without this, page 3 of a 2-page-profile game would inherit
 * page 1's startingMove and its cell.num values would collide with page 1's —
 * collapsing the tail in any code path that indexes cells by (num, color)
 * (mergeSheets, _cellsToPaired in the orchestrator's noise gate, etc.).
 *
 * Per-page movesPerPage:
 *   - '2col' → 2 moves per row × rowCount rows
 *   - '3col' → 3 moves per row × rowCount rows
 *
 * Historical context: the longest official tournament game on record is
 * Nikolić–Arsović, Belgrade 1989 — 269 moves (a draw). At ~40 moves per
 * physical sheet that's roughly 7 pages, so the cyclic recycling handles
 * even pathological game lengths without configuration.
 *
 * @param {number} pageNumber - 1-based page number
 * @param {Object} overrides - Optional {format, rowCount} from per-sheet dropdowns
 * @returns {Object} - Extended grid config with headerRows, footerRows, startingMove
 */
function getProfileGridConfig(pageNumber, overrides) {
    var profile = getActiveProfile();
    var nPages = profile.pages.length;
    var zeroBased = pageNumber - 1;
    var pageIdx = nPages > 0 ? (zeroBased % nPages) : 0;
    var completedCycles = nPages > 0 ? Math.floor(zeroBased / nPages) : 0;
    var page = profile.pages[pageIdx];

    var format = (overrides && overrides.format) || page.format;
    var rowCount = (overrides && overrides.rowCount) || page.rowCount;

    // Grid config (cell dimensions, column expectations).
    var config = (typeof getGridConfig === 'function')
        ? getGridConfig(rowCount, format)
        : { rowCount: rowCount, format: format, expectedCols: format === '2col' ? 7 : 10, internalDividers: format === '2col' ? 5 : 8 };

    // Literal-recycled fields from the corresponding template page.
    config.headerRows = page.headerRows || 0;
    config.footerRows = page.footerRows || 0;
    config.gridType = page.gridType || 'full';

    // startingMove: template's value + (completedCycles × cycleSize).
    // cycleSize is the total moves represented by one full sweep of the
    // template, computed by summing movesPerPage across every template page.
    var templateStart = page.startingMove || 1;
    if (completedCycles === 0) {
        config.startingMove = templateStart;
    } else {
        var cycleSize = 0;
        for (var ti = 0; ti < nPages; ti++) {
            var tp = profile.pages[ti];
            var tFmt = tp.format;
            var tRows = tp.rowCount || 0;
            var cols = (tFmt === '3col') ? 3 : 2;
            cycleSize += tRows * cols;
        }
        config.startingMove = templateStart + completedCycles * cycleSize;
        if (typeof console !== 'undefined') {
            console.log('[ProfileConfig] page ' + pageNumber + ' wraps template (' +
                        nPages + ' pages) — cycle #' + completedCycles +
                        ' position #' + pageIdx +
                        '; startingMove = ' + templateStart +
                        ' + ' + completedCycles + ' × ' + cycleSize +
                        ' = ' + config.startingMove);
        }
    }

    return config;
}

// =============================================================================
// CRUD
// =============================================================================

function createProfile(profile) {
    // Ensure unique name
    var baseName = profile.name || 'Custom Profile';
    var name = baseName;
    var counter = 2;
    while (_profiles.find(function(p) { return p.name === name; })) {
        name = baseName + ' (' + counter + ')';
        counter++;
    }
    profile.name = name;
    profile.builtin = false;
    _profiles.push(profile);
    saveProfiles();
    return profile;
}

function updateProfile(originalName, updatedProfile) {
    var idx = _profiles.findIndex(function(p) { return p.name === originalName; });
    if (idx < 0) return null;
    updatedProfile.builtin = false;
    _profiles[idx] = updatedProfile;
    // Update active name if it changed
    if (_activeProfileName === originalName && updatedProfile.name !== originalName) {
        _activeProfileName = updatedProfile.name;
    }
    saveProfiles();
    return updatedProfile;
}

function deleteProfile(name) {
    var idx = _profiles.findIndex(function(p) { return p.name === name; });
    if (idx < 0) return false;
    _profiles.splice(idx, 1);
    if (_activeProfileName === name && _profiles.length > 0) {
        _activeProfileName = _profiles[0].name;
    }
    saveProfiles();
    return true;
}

// =============================================================================
// EXPORT / IMPORT
// =============================================================================

function exportProfile(name) {
    var profile = _profiles.find(function(p) { return p.name === name; });
    if (!profile) return;

    var data = JSON.parse(JSON.stringify(profile));
    delete data.builtin;

    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (name.replace(/[^a-zA-Z0-9]/g, '_')) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function importProfile(file) {
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var data = JSON.parse(e.target.result);
            if (!data.name || !Array.isArray(data.pages) || data.pages.length === 0) {
                alert('Invalid profile file: must have name and pages array.');
                return;
            }
            // Validate each page
            for (var i = 0; i < data.pages.length; i++) {
                var pg = data.pages[i];
                if (!pg.format || !pg.rowCount) {
                    alert('Invalid profile: page ' + (i + 1) + ' missing format or rowCount.');
                    return;
                }
            }
            data.builtin = false;
            createProfile(data);
            renderProfileDropdown();
            renderProfileSummary();
            console.log('[Profiles] Imported profile: ' + data.name);
        } catch (err) {
            alert('Error reading profile file: ' + err.message);
        }
    };
    reader.readAsText(file);
}

// =============================================================================
// UI RENDERING
// =============================================================================

function renderProfileDropdown() {
    var select = document.getElementById('profile-select');
    if (!select) return;

    select.innerHTML = '';
    _profiles.forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        if (p.name === _activeProfileName) opt.selected = true;
        select.appendChild(opt);
    });
}

function renderProfileSummary() {
    var span = document.getElementById('profile-summary');
    if (!span) return;

    var profile = getActiveProfile();
    var parts = [];
    profile.pages.forEach(function(pg, i) {
        var desc = pg.format + ' ' + pg.rowCount + 'r';
        if (pg.headerRows > 0) desc += ' +' + pg.headerRows + 'h';
        if (pg.footerRows > 0) desc += ' +' + pg.footerRows + 'f';
        if (pg.startingMove > 1) desc += ' @' + pg.startingMove;
        parts.push('P' + (i + 1) + ':' + desc);
    });
    span.textContent = parts.join(' | ');
}

// =============================================================================
// PROFILE EDITOR MODAL
// =============================================================================

function openProfileEditor(name) {
    var modal = document.getElementById('profile-modal');
    if (!modal) return;

    var profile;
    if (name) {
        profile = _profiles.find(function(p) { return p.name === name; });
    }
    if (!profile) {
        // New profile
        profile = {
            name: 'Custom Profile',
            pages: [
                { format: '2col', rowCount: 20, headerRows: 0, footerRows: 0, startingMove: 1 }
            ]
        };
        _editorOriginalName = null;
    } else {
        profile = JSON.parse(JSON.stringify(profile)); // deep clone
        _editorOriginalName = name;
    }

    document.getElementById('profile-name').value = profile.name;
    var cityEl = document.getElementById('profile-city');
    var countryEl = document.getElementById('profile-country');
    if (cityEl) cityEl.value = profile.city || '';
    if (countryEl) countryEl.value = profile.country || '';

    // Show/hide delete button (can't delete if it's the only profile or if creating new)
    var btnDelete = document.getElementById('btn-delete-profile');
    if (btnDelete) {
        btnDelete.classList.toggle('hidden', !_editorOriginalName || _profiles.length <= 1);
    }

    renderProfilePageRows(profile.pages);
    modal.classList.remove('hidden');
}

function closeProfileEditor() {
    var modal = document.getElementById('profile-modal');
    if (modal) modal.classList.add('hidden');
    _editorOriginalName = null;
}

function renderProfilePageRows(pages) {
    var container = document.getElementById('profile-pages');
    if (!container) return;

    container.innerHTML = '';
    pages.forEach(function(pg, i) {
        var row = document.createElement('div');
        row.className = 'bg-gray-700/50 rounded p-3 profile-page-row';
        row.dataset.pageIndex = i;
        row.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <span class="text-gray-300 text-sm font-medium">Page ${i + 1}</span>
                ${pages.length > 1 ? '<button class="btn-remove-page text-red-400 hover:text-red-300 text-xs">Remove</button>' : ''}
            </div>
            <div class="grid grid-cols-2 gap-2 text-xs">
                <label class="text-gray-400">
                    Grid type
                    <select class="profile-pg-gridtype w-full bg-gray-600 text-white rounded px-2 py-1 mt-0.5">
                        <option value="full" ${(pg.gridType || 'full') === 'full' ? 'selected' : ''}>Full grid</option>
                        <option value="horizontal-lines" ${pg.gridType === 'horizontal-lines' ? 'selected' : ''}>Horizontal lines only</option>
                    </select>
                </label>
                <label class="text-gray-400">
                    Format
                    <select class="profile-pg-format w-full bg-gray-600 text-white rounded px-2 py-1 mt-0.5">
                        <option value="2col" ${pg.format === '2col' ? 'selected' : ''}>2-column</option>
                        <option value="3col" ${pg.format === '3col' ? 'selected' : ''}>3-column</option>
                    </select>
                </label>
                <label class="text-gray-400">
                    Rows per column
                    <input type="number" min="5" max="60" step="1" list="rowcount-suggestions"
                           value="${pg.rowCount || 20}"
                           class="profile-pg-rows w-full bg-gray-600 text-white rounded px-2 py-1 mt-0.5"
                           title="Any value (suggestions: 15/20/24/25/26/30/35)">
                </label>
                <label class="text-gray-400">
                    Header rows to skip
                    <input type="number" min="0" max="5" value="${pg.headerRows || 0}"
                           class="profile-pg-header w-full bg-gray-600 text-white rounded px-2 py-1 mt-0.5">
                </label>
                <label class="text-gray-400">
                    Footer rows to skip
                    <input type="number" min="0" max="5" value="${pg.footerRows || 0}"
                           class="profile-pg-footer w-full bg-gray-600 text-white rounded px-2 py-1 mt-0.5">
                </label>
                <label class="text-gray-400 col-span-2">
                    Starting move number
                    <input type="number" min="1" max="200" value="${pg.startingMove || 1}"
                           class="profile-pg-start w-full bg-gray-600 text-white rounded px-2 py-1 mt-0.5">
                </label>
            </div>
        `;
        container.appendChild(row);
    });

    // Wire remove buttons
    container.querySelectorAll('.btn-remove-page').forEach(function(btn) {
        btn.onclick = function() {
            var pageRow = btn.closest('.profile-page-row');
            if (pageRow && container.querySelectorAll('.profile-page-row').length > 1) {
                pageRow.remove();
                // Re-number pages
                container.querySelectorAll('.profile-page-row').forEach(function(row, idx) {
                    row.dataset.pageIndex = idx;
                    row.querySelector('.text-gray-300').textContent = 'Page ' + (idx + 1);
                });
            }
        };
    });
}

function addPageToEditor() {
    var container = document.getElementById('profile-pages');
    if (!container) return;

    var pageCount = container.querySelectorAll('.profile-page-row').length;

    // Auto-calculate startingMove based on previous page
    var prevStartingMove = 1;
    var prevRowCount = 20;
    var prevFormat = '2col';
    if (pageCount > 0) {
        var lastRow = container.querySelectorAll('.profile-page-row')[pageCount - 1];
        prevStartingMove = parseInt(lastRow.querySelector('.profile-pg-start').value) || 1;
        prevRowCount = parseInt(lastRow.querySelector('.profile-pg-rows').value) || 20;
        prevFormat = lastRow.querySelector('.profile-pg-format').value;
        var colMultiplier = prevFormat === '3col' ? 3 : 2;
        prevStartingMove += prevRowCount * colMultiplier;
    }

    var newPage = {
        gridType: 'full',
        format: prevFormat,
        rowCount: prevRowCount,
        headerRows: 0,
        footerRows: 0,
        startingMove: prevStartingMove
    };

    // Read current pages and re-render with the new page added
    var pages = readPagesFromEditor();
    pages.push(newPage);
    renderProfilePageRows(pages);
}

function readPagesFromEditor() {
    var container = document.getElementById('profile-pages');
    if (!container) return [];

    var pages = [];
    container.querySelectorAll('.profile-page-row').forEach(function(row) {
        var gridTypeEl = row.querySelector('.profile-pg-gridtype');
        pages.push({
            gridType: gridTypeEl ? gridTypeEl.value : 'full',
            format: row.querySelector('.profile-pg-format').value,
            rowCount: parseInt(row.querySelector('.profile-pg-rows').value) || 20,
            headerRows: parseInt(row.querySelector('.profile-pg-header').value) || 0,
            footerRows: parseInt(row.querySelector('.profile-pg-footer').value) || 0,
            startingMove: parseInt(row.querySelector('.profile-pg-start').value) || 1
        });
    });
    return pages;
}

function saveProfileFromEditor() {
    var nameInput = document.getElementById('profile-name');
    if (!nameInput) return;

    var name = nameInput.value.trim();
    if (!name) {
        alert('Profile name is required.');
        return;
    }

    var pages = readPagesFromEditor();
    if (pages.length === 0) {
        alert('Profile must have at least one page.');
        return;
    }

    var cityEl = document.getElementById('profile-city');
    var countryEl = document.getElementById('profile-country');
    var profile = { name: name, builtin: false, pages: pages };
    var city = cityEl ? cityEl.value.trim() : '';
    var country = countryEl ? countryEl.value.trim() : '';
    if (city) profile.city = city;
    if (country) profile.country = country;

    if (_editorOriginalName) {
        // Check for name conflict with a different profile
        var conflict = _profiles.find(function(p) {
            return p.name === name && p.name !== _editorOriginalName;
        });
        if (conflict) {
            alert('A profile with this name already exists.');
            return;
        }
        updateProfile(_editorOriginalName, profile);
    } else {
        createProfile(profile);
    }

    _activeProfileName = profile.name;
    saveProfiles();
    renderProfileDropdown();
    renderProfileSummary();
    closeProfileEditor();
}

function deleteProfileFromEditor() {
    if (!_editorOriginalName) return;
    if (_profiles.length <= 1) {
        alert('Cannot delete the only profile.');
        return;
    }
    if (!confirm('Delete profile "' + _editorOriginalName + '"?')) return;

    deleteProfile(_editorOriginalName);
    renderProfileDropdown();
    renderProfileSummary();
    closeProfileEditor();
}

function exportProfileFromEditor() {
    var name = _editorOriginalName || document.getElementById('profile-name').value.trim();
    if (name) {
        exportProfile(name);
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

if (typeof window !== 'undefined') {
    window.SheetProfiles = {
        loadProfiles: loadProfiles,
        getActiveProfile: getActiveProfile,
        setActiveProfile: setActiveProfile,
        getActiveProfileLocation: getActiveProfileLocation,
        getProfileGridConfig: getProfileGridConfig,
        renderProfileDropdown: renderProfileDropdown,
        renderProfileSummary: renderProfileSummary,
        openProfileEditor: openProfileEditor,
        closeProfileEditor: closeProfileEditor,
        saveProfileFromEditor: saveProfileFromEditor,
        deleteProfileFromEditor: deleteProfileFromEditor,
        exportProfileFromEditor: exportProfileFromEditor,
        exportProfile: exportProfile,
        importProfile: importProfile,
        addPageToEditor: addPageToEditor
    };
}
