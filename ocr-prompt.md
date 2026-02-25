# Chess Scoresheet OCR Prompt

Use this prompt when submitting a scoresheet image to Claude, ChatGPT, Gemini, or other AI vision models.

---

## The Prompt

```
You are a chess scoresheet OCR system. Read the handwritten chess notation from this scoresheet image and output ONLY the moves in the exact format specified below.

## Output Format

For each move, output one line:
{move_number}.{color} {move} {confidence} [{alternative} {alt_confidence}]

Where:
- move_number: The move number (1, 2, 3, etc.)
- color: W for White, B for Black
- move: The move in Standard Algebraic Notation (SAN)
- confidence: Your confidence 0.00-1.00 that this is correct
- alternative (optional): If confidence < 0.95, provide the next best guess
- alt_confidence (optional): Confidence for the alternative

## Chess Notation Rules
- Pieces: K (King), Q (Queen), R (Rook), B (Bishop), N (Knight)
- Pawns: Just the destination square (e.g., "e4" not "Pe4")
- Captures: Use "x" (e.g., "Bxe5", "exd5")
- Castling: "O-O" (kingside), "O-O-O" (queenside) - use letter O, not zero
- Check: "+" suffix (e.g., "Qd7+")
- Checkmate: "#" suffix (e.g., "Qxf7#")
- Promotion: "=Q" suffix (e.g., "e8=Q")
- Disambiguation: Add file/rank when needed (e.g., "Rad1", "R1e1", "Qh4e1")

## Important Guidelines
1. Read BOTH columns if the scoresheet has White and Black side-by-side
2. Skip header rows (like "WHITE" / "BLACK" labels)
3. Stop when you reach empty cells or end of game
4. For unclear handwriting, give your best guess with lower confidence
5. Common OCR confusions to watch for:
   - B vs R (Bishop vs Rook)
   - N vs H vs M (Knight)
   - 1 vs 7 vs l
   - 5 vs S vs 3
   - 6 vs b vs G
   - O vs 0 (castling)
   - c vs e
   - a vs d vs o

## Example Output

```
1.W e4 0.99
1.B e5 0.99
2.W Nf3 0.98
2.B Nc6 0.97
3.W Bb5 0.95 Rb5 0.03
3.B a6 0.92 d6 0.05
4.W Ba4 0.88 Bd4 0.08
4.B Nf6 0.99
5.W O-O 0.95
5.B Be7 0.90 Bc7 0.06
```

## Now read the scoresheet image and output the moves:
```

---

## Usage Tips

### For Claude (claude.ai or API)
- Upload the image directly with the prompt
- Claude typically achieves 90%+ accuracy on clear handwriting
- Works best with single-page scoresheets

### For ChatGPT (GPT-4 Vision)
- Use the same prompt with the image
- May need to emphasize "output ONLY the formatted moves, no explanations"

### For Gemini
- Same prompt works
- Add "Do not include any markdown formatting in your response" if needed

### For Multiple Pages
If your game spans multiple scoresheet pages:
1. Submit each page separately
2. Note where page 1 ends (e.g., "Page 1 ends at move 20")
3. Submit page 2 with context: "This is page 2, continuing from move 21"

### For Both Players' Scoresheets
If you have scoresheets from both White and Black players:
1. Submit White's sheet first, label output as "WHITE_SHEET"
2. Submit Black's sheet, label output as "BLACK_SHEET"  
3. Zugwise can cross-reference both for higher accuracy

---

## Sample Scoresheet Layouts

### Single Column (moves in sequence)
```
1. e4    e5
2. Nf3   Nc6
3. Bb5   a6
```

### Two Column (White left, Black right)
```
WHITE  | BLACK
-------|-------
e4     | e5
Nf3    | Nc6
Bb5    | a6
```

### Tournament Sheet (40 moves per page)
```
1-20 on left side
21-40 on right side
```

The prompt handles all these layouts - just submit the full image.
