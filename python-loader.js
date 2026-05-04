// =============================================================================
// python-loader.js - Shared Python module loading for all Pyodide workers
// =============================================================================
// Used by:
//   - zugwise-worker.js (main OCR + reconstruction worker)
//   - search-worker.js  (lightweight background search workers)
//
// Fetches Python modules from /backend-python/, strips local imports (since
// Pyodide loads everything into a flat global namespace), and executes them.
// =============================================================================

async function loadPythonModules(pyodide) {
    const modules = [
        'data_structures.py',
        'helpers.py',
        'similarity.py',
        'chess_quiescence.py',
        'absurdity.py',
        'play.py',
        'constraints.py',
        'missing_moves.py',
        'lenient_normalize.py',
        'fix_finding.py',
        'full_game_search.py',
        'dijkstra_search.py',
        'validation.py'
    ];

    // List of local module names to strip from imports
    const localModules = [
        'data_structures', 'helpers', 'similarity', 'absurdity',
        'constraints', 'missing_moves', 'lenient_normalize', 'fix_finding', 'play',
        'chess_quiescence', 'full_game_search', 'dijkstra_search', 'validation'
    ];
    const singleLinePattern = new RegExp(
        `^from\\s+(${localModules.join('|')})\\s+import\\s+[^(].*$`, 'gm'
    );
    // Multi-line: match from `from X import (` to the closing `)`, honoring
    // both PEP 8 styles (`)` on its own line OR at the end of the last
    // import member line) AND parens that appear inside member comments.
    //
    // History:
    //   Original: [^)]* — stopped at ANY `)`, including those inside
    //     comments like `# stricter check (no cross-board offset)`. Left
    //     an orphan `)` on a line and broke the module's SyntaxError.
    //   First fix: [\s\S]*?^\s*\) — required `)` at line-start. Handled
    //     comments but missed the `find_free_captures_with_check)` style
    //     where the closing paren follows the last member name on the
    //     same line. fix_finding.py uses that style → failed to load →
    //     BacktrackSearchState undefined.
    //   Current: match any char that is NOT `#` or `)`, OR a full
    //     line-comment `#...\n`, greedily, then `\)`. Stops at the first
    //     `)` that is NOT inside a line comment. Handles both styles
    //     and paren-in-comment cases.
    const multiLinePattern = new RegExp(
        `^from\\s+(${localModules.join('|')})\\s+import\\s+\\((?:[^#)]|#[^\\n]*)*\\)`, 'gm'
    );

    for (const moduleName of modules) {
        try {
            const response = await fetch(`backend-python/${moduleName}`);
            if (!response.ok) {
                console.warn(`Module not found: backend-python/${moduleName}, skipping...`);
                continue;
            }
            let code = await response.text();

            // Strip local imports
            code = code.replace(multiLinePattern, '# [Pyodide] multi-line import stripped');
            code = code.replace(singleLinePattern, '# [Pyodide] $&');

            // Strip self-test blocks
            code = code.replace(/if\s+__name__\s*==\s*["']__main__["']:\s*[\s\S]*$/gm, '');

            await pyodide.runPythonAsync(code);
            console.log(`Loaded: ${moduleName} (from backend/)`);
        } catch (e) {
            console.warn(`Failed to load ${moduleName}: ${e.message}`);
        }
    }
}
