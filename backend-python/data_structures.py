"""
Score2PGN - Data Structures
===========================
Core dataclasses used throughout the reconstruction system.
"""

from dataclasses import dataclass, field
from typing import List, Tuple, Optional


def normalize_candidate(item) -> Optional[Tuple[str, float]]:
    """
    Normalize a single candidate to (str, float) tuple.
    Handles all formats from JavaScript JSON serialization:
    - [move, conf] arrays
    - {move, confidence} dicts
    - Nested [[move, conf], ...]
    - Plain strings
    Returns None if cannot be normalized.
    """
    if isinstance(item, dict):
        m = item.get('move', '')
        c = item.get('confidence', 0.1)
        return (str(m), float(c)) if m else None
    elif isinstance(item, (list, tuple)):
        if len(item) >= 2:
            m, c = item[0], item[1]
            # Handle nested case: [[move, conf], something]
            if isinstance(m, (list, tuple)) and len(m) >= 2:
                m, c = m[0], m[1]
            if isinstance(m, str) and isinstance(c, (int, float)):
                return (m, float(c))
            elif isinstance(m, str):
                return (m, 0.1)
        elif len(item) == 1:
            inner = item[0]
            if isinstance(inner, (list, tuple)) and len(inner) >= 2:
                return (str(inner[0]), float(inner[1]))
    elif isinstance(item, str):
        return (item, 0.5)
    return None


@dataclass
class OCRMove:
    """Represents a move as read by OCR with confidence scores for candidates."""
    move_number: int
    color: str  # 'w' or 'b'
    candidates: List[Tuple[str, float]]  # [(move_san, confidence), ...]
    lenient_candidates: List[Tuple[str, float]] = field(default_factory=list)  # Non-standard notation alternatives

    def __post_init__(self):
        """Normalize candidates to ensure they're always [(str, float), ...] format."""
        normalized = []
        for item in self.candidates:
            result = normalize_candidate(item)
            if result and result[0]:  # Only add if move string is non-empty
                normalized.append(result)
        self.candidates = normalized if normalized else [('', 0.0)]
        # Normalize lenient candidates too
        if self.lenient_candidates:
            norm_lenient = []
            for item in self.lenient_candidates:
                result = normalize_candidate(item)
                if result and result[0]:
                    norm_lenient.append(result)
            self.lenient_candidates = norm_lenient

    @property
    def ply(self) -> int:
        """Convert move number + color to ply (0-indexed half-move)."""
        return (self.move_number - 1) * 2 + (0 if self.color == 'w' else 1)

    @property
    def top_move(self) -> str:
        """Return the highest-confidence move candidate."""
        return self.candidates[0][0] if self.candidates else ""

    @property
    def top_confidence(self) -> float:
        """Return the confidence of the top move candidate."""
        return self.candidates[0][1] if self.candidates else 0.0

    def get_confidence(self, move: str) -> float:
        """Get the OCR confidence for a specific move (0.0 if not in candidates)."""
        move_clean = move.rstrip('+#')
        for m, conf in self.candidates:
            if m.rstrip('+#') == move_clean:
                return conf
        return 0.0


@dataclass
class ReconstructionResult:
    """Result of a game reconstruction attempt."""
    status: str  # "VALID", "SOLVED", "FAILED", "SUSPICIOUS"
    path: List[str]  # The reconstructed move list
    fixes: List[dict] = field(default_factory=list)  # Applied fixes
    elapsed: float = 0.0  # Time taken
    method: str = ""  # "greedy", "beam_search", "none"
    first_absurdity_ply: Optional[int] = None  # For SUSPICIOUS status


@dataclass
class Absurdity:
    """Represents a suspicious/absurd position detected in the game."""
    ply: int
    move_played: str
    absurdity_type: str  # 'piece_left_hanging', 'free_capture_ignored', etc.
    details: str  # Human-readable description
    severity: int  # Piece value involved (3=minor, 5=rook, 9=queen)
    hanging_piece: str = ""  # e.g., 'B', 'R', 'Q'
    hanging_square: str = ""  # e.g., 'c5', 'e4'
