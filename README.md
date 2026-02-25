# Zugwise

**Turn handwritten chess scoresheets into PGN — right in your browser.**

Free · Private · Offline · Forever

---

## What is Zugwise?

Zugwise reads photos of handwritten chess scoresheets and reconstructs the game in PGN format. It uses a neural network for handwriting recognition combined with chess logic to detect and correct errors — so you don't have to type in every move by hand.

Your images never leave your device. Everything runs locally in your browser.

## Getting Started

1. **Open Zugwise** at [gerhardtrippen.github.io/zugwise](https://gerhardtrippen.github.io/zugwise)
2. Wait for the one-time setup to finish (this loads the handwriting model and chess engine — about 30 seconds on first visit)
3. You're ready to go

After the first visit, Zugwise works offline too.

## Processing a Scoresheet

### Step 1: Upload Your Image

Take a clear photo of the scoresheet. Tips for best results:

- Lay the sheet flat on a contrasting surface
- Avoid shadows across the grid
- Make sure all rows are visible, including move numbers
- Slight angles are fine — Zugwise corrects for perspective

You can process a single player's scoresheet, or upload both players' sheets for improved accuracy (see "Two-Player Mode" below).

### Step 2: Choose a Sheet Profile

Select the scoresheet format that matches your sheet:

- **2-column** (White | Black) — standard 40-move sheets
- **3-column** — 60-move sheets with an extra column pair

If your club or tournament uses a specific format regularly, you can save it as a profile for quick reuse.

### Step 3: Set the Grid

Zugwise will try to detect the grid automatically. If it doesn't get it right, you can adjust the four corner points manually by dragging them to match the edges of the scoresheet grid.

### Step 4: Review the OCR

Once the grid is detected, Zugwise reads each cell and shows you what it found. Moves are displayed on the board so you can follow along.

Moves appear in one of three states:

- **Green** — the move is legal and looks correct
- **Yellow** — Zugwise auto-corrected a small OCR error (e.g., a misread letter)
- **Red** — the move couldn't be resolved automatically and needs your input

### Step 5: Fix Any Errors

Click on a red move to see what Zugwise suggests:

- **Quick Fixes** appear instantly — these are all legal moves that are close to what the OCR read. Often the right answer is right there.
- **Deeper Fixes** run a backtracking search to find where things went wrong. Sometimes a move several plies earlier was misread, causing a cascade of problems. Zugwise traces back to the root cause and offers corrections.

Each suggestion shows how similar it is to the original OCR reading and whether it makes chess sense. Pick the one that matches the handwriting.

### Step 6: Export

Once all moves are confirmed (or you're satisfied with the result), export the game as PGN. You can paste it into Lichess, Chess.com, ChessBase, or any PGN-compatible tool.

## Two-Player Mode

If you have scoresheets from both players, Zugwise can process them together. Upload both sheets and assign which one is White and which is Black. The system merges the OCR readings from both sheets — when one sheet is hard to read, the other often fills in the gap. Moves where both sheets agree get a confidence boost; moves where they disagree are flagged for your review, with cell images from both sheets shown side by side.

## Background Search (Experimental)

While you fix moves interactively, Zugwise can run automatic search algorithms in the background:

- **Greedy search** picks the most promising fix at each stuck point and moves forward. Fast, and often surprisingly effective.
- **Beam search** explores multiple correction paths simultaneously, keeping the best candidates at each step.

These are experimental features. They can solve many games fully automatically — but they can also produce plausible-looking games that differ from what was actually played. Always compare the results against the scoresheet before accepting them. Your interactive fixes take priority and are never overwritten by the search.

## What Zugwise Handles Well

- Common handwriting confusions (like `g` vs `a`, `R` vs `K`, `2` vs `7`)
- Perspective-distorted photos taken at an angle
- Scoresheets with minor smudges or crossed-out moves
- Games where a few moves are hard to read — the chess logic fills in the gaps
- Non-standard notation quirks (like `Pe4` instead of `e4`) through lenient grammar matching

## Current Limitations

- **Very messy handwriting** may still need several manual corrections. Zugwise reduces the work dramatically but isn't fully automatic for every sheet.
- **Descriptive notation** (e.g., `P-K4`) and **figurine notation** are not supported — only standard algebraic notation (SAN) and common shorthand variants.
- **Background search results should be reviewed carefully.** The algorithms find *a* legal game consistent with the OCR, but it may not be *the* game that was played.

## Privacy

Zugwise runs entirely in your browser. Your scoresheet images are never uploaded to any server. The handwriting model and chess engine are downloaded once and cached locally. No account is needed, no data is collected.

## Reporting Bugs

Found something that doesn't work? Please [open an issue](https://github.com/gerhardtrippen/zugwise/issues/new/choose) on GitHub.

The most helpful bug reports include:

- What move number things went wrong at
- A screenshot or photo of the scoresheet (if you're comfortable sharing it)
- What Zugwise suggested vs. what the move actually was

## Support

If Zugwise saved you hours of manual data entry, consider buying me a coffee:

☕ [Buy Me a Coffee](https://buymeacoffee.com/zugwise)

## Acknowledgments

The OCR model architecture is informed by work from Eicher, Farmer, Li, and Majid on handwritten chess scoresheet recognition. Chess move validation is powered by [python-chess](https://python-chess.readthedocs.io/) running client-side via [Pyodide](https://pyodide.org/).

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You are free to use and share Zugwise for any non-commercial purpose, including chess clubs and tournaments (even those with entry fees).

For commercial inquiries, please contact the author.

---

*Zugwise — helping you put the pieces where they belong.*
