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
        'validation.py'
    ];

    // List of local module names to strip from imports
    const localModules = [
        'data_structures', 'helpers', 'similarity', 'absurdity',
        'constraints', 'missing_moves', 'lenient_normalize', 'fix_finding', 'play',
        'chess_quiescence', 'full_game_search', 'validation'
    ];
    const singleLinePattern = new RegExp(
        `^from\\s+(${localModules.join('|')})\\s+import\\s+[^(].*$`, 'gm'
    );
    const multiLinePattern = new RegExp(
        `^from\\s+(${localModules.join('|')})\\s+import\\s+\\([^)]*\\)`, 'gms'
    );

    for (const moduleName of modules) {
        try {
            const response = await fetch(`/backend-python/${moduleName}`);
            if (!response.ok) {
                console.warn(`Module not found: /backend-python/${moduleName}, skipping...`);
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
