"""Deterministically resolve one or more spoken names against a candidate
list -- the backend twin of ``hushh-webapp/lib/one-location/resolve-spoken-names.ts``.

A backend-direct voice action (see ``action_tools.run_app_action``'s bypass
allowlist) receives a raw spoken name in its slots, not a pre-resolved id --
the model hears "remove Roopmann" and passes ``{"person": "Roopmann"}"``, the
same as the browser's local handlers always have. This module exists so that
resolution doesn't have to happen in the browser to be correct: it is a
line-for-line port of the TypeScript algorithm, not a reinterpretation, so a
name that resolves (or stays ambiguous, or goes unresolved) one way in the
browser resolves the same way here. Keep the two in sync deliberately if
either changes -- there is a test on each side asserting the shared fixture
cases match.

Names are split out of the RAW utterance ("," / "&" / ";" / the word "and")
BEFORE normalization, matched first by substring, then -- only when substring
finds nothing -- by a bounded fuzzy fallback scaled to word length. Fuzzy
never runs when substring already matched something, so it can only turn a
"not found" into a match; it never second-guesses a match that already
succeeded.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Callable, Generic, TypeVar

T = TypeVar("T")

# Matches ",", "&", ";", or the standalone word "and" (case-insensitive,
# word-bounded so it never fires inside a name like "Anderson"). Applied to
# the RAW utterance, before normalize_spoken_name would erase all of these.
_NAME_DELIMITER_PATTERN = re.compile(r"\s*(?:,|&|;|\band\b)\s*", re.IGNORECASE)

# \p{L}/\p{N}/\p{M} in the TS source (Unicode letter/number/mark) -- Python's
# `re` has no \p{} classes, so this is built from unicodedata categories at
# import time instead of hand-picking a script-limited range, so a circle
# named in Hindi or Arabic stays matchable the same way it does client-side.
_PUNCTUATION_RE = re.compile(r"[^\w\s]", re.UNICODE)


def normalize_spoken_name(value: str) -> str:
    """No case, no accents, no punctuation. Mirrors normalizeSpokenName()."""
    decomposed = unicodedata.normalize("NFD", value or "")
    without_marks = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    lowered = without_marks.lower()
    # \w already covers \p{L}/\p{N}/\p{M} plus "_", so strip "_" separately to
    # match the TS punctuation-stripping behavior exactly.
    no_punctuation = _PUNCTUATION_RE.sub(" ", lowered).replace("_", " ")
    return re.sub(r"\s+", " ", no_punctuation).strip()


def split_spoken_names(raw: str) -> list[str]:
    """One name with no delimiter returns a 1-element list."""
    return [part.strip() for part in _NAME_DELIMITER_PATTERN.split(raw or "") if part.strip()]


def levenshtein_distance(a: str, b: str) -> int:
    """Fewest single-character edits to turn ``a`` into ``b``."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous_row = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        current_row = [i]
        for j in range(1, len(b) + 1):
            substitution_cost = 0 if a[i - 1] == b[j - 1] else 1
            current_row.append(
                min(
                    current_row[j - 1] + 1,  # insertion
                    previous_row[j] + 1,  # deletion
                    previous_row[j - 1] + substitution_cost,  # substitution
                )
            )
        previous_row = current_row
    return previous_row[len(b)]


def _fuzzy_match_threshold(word_length: int) -> int:
    """Under 4 letters is never fuzzy-matched. See the TS docstring for why."""
    if word_length < 4:
        return 0
    if word_length <= 5:
        return 1
    return 2


def is_fuzzy_match(target: str, candidate_word: str) -> bool:
    """Judged by the LONGER side's length, not the shorter -- see TS docstring."""
    threshold = _fuzzy_match_threshold(max(len(target), len(candidate_word)))
    if threshold == 0:
        return False
    return levenshtein_distance(target, candidate_word) <= threshold


@dataclass
class UnresolvedPersonName(Generic[T]):
    spoken_text: str
    kind: str  # "ambiguous" | "not_found"
    matches: list[T] = field(default_factory=list)


@dataclass
class MultiNameResolution(Generic[T]):
    resolved: list[T]
    unresolved: list[UnresolvedPersonName[T]]


def resolve_spoken_names(
    candidates: list[T],
    raw: str,
    display_name: Callable[[T], str | None],
    search_text: Callable[[T], str | None] | None = None,
) -> MultiNameResolution[T]:
    """Port of resolveSpokenNames(). ``search_text`` defaults to ``display_name``."""
    search = search_text or display_name
    resolved: list[T] = []
    unresolved: list[UnresolvedPersonName[T]] = []
    for spoken_text in split_spoken_names(raw):
        target = normalize_spoken_name(spoken_text)
        if not target:
            continue
        matches = [
            item for item in candidates if target in normalize_spoken_name(str(search(item) or ""))
        ]
        if not matches:
            matches = [
                item
                for item in candidates
                if _matches_fuzzy(target, normalize_spoken_name(str(search(item) or "")))
            ]
        if not matches:
            unresolved.append(UnresolvedPersonName(spoken_text=spoken_text, kind="not_found"))
        elif len(matches) == 1:
            resolved.append(matches[0])
        else:
            unresolved.append(
                UnresolvedPersonName(spoken_text=spoken_text, kind="ambiguous", matches=matches)
            )
    return MultiNameResolution(resolved=resolved, unresolved=unresolved)


def _matches_fuzzy(target: str, normalized_candidate: str) -> bool:
    if is_fuzzy_match(target, normalized_candidate):
        return True
    return any(is_fuzzy_match(target, word) for word in normalized_candidate.split(" "))


def ambiguous_match_names(
    matches: list[T],
    display_name: Callable[[T], str | None],
    limit: int = 4,
) -> str:
    """Bounded, comma-joined names for a "which one did you mean?" summary."""
    names = [str(display_name(item) or "").strip() for item in matches[:limit]]
    return ", ".join(name for name in names if name)


def join_names_for_speech(names: list[str]) -> str:
    """ "Alice", "Alice and Bob", "Alice, Bob and Sarah" -- no Oxford comma, read as speech."""
    clean = [name.strip() for name in names if name.strip()]
    if len(clean) <= 1:
        return clean[0] if clean else ""
    if len(clean) == 2:
        return f"{clean[0]} and {clean[1]}"
    return f"{', '.join(clean[:-1])} and {clean[-1]}"


@dataclass
class CircleMatch(Generic[T]):
    match: T | None
    ambiguous: list[T]


def match_circle_by_name(
    circles: list[T], spoken: str, name_of: Callable[[T], str]
) -> CircleMatch[T]:
    """Port of matchCircleByName(): exact -> word-boundary -> substring tiers."""
    target = normalize_spoken_name(spoken)
    if not target:
        return CircleMatch(match=None, ambiguous=[])
    indexed = [(circle, normalize_spoken_name(name_of(circle))) for circle in circles]

    exact = [c for c, n in indexed if n == target]
    word_boundary = [
        c
        for c, n in indexed
        if n.startswith(f"{target} ") or n.endswith(f" {target}") or target in n.split(" ")
    ]
    substring = [c for c, n in indexed if target in n]

    for tier in (exact, word_boundary, substring):
        if len(tier) == 1:
            return CircleMatch(match=tier[0], ambiguous=[])
        if len(tier) > 1:
            return CircleMatch(match=None, ambiguous=tier)
    return CircleMatch(match=None, ambiguous=[])


@dataclass
class SpokenNameMatch(Generic[T]):
    kind: str  # "none" | "one" | "many"
    match: T | None = None
    matches: list[T] = field(default_factory=list)


def resolve_by_spoken_name(
    candidates: list[T],
    spoken_name: str,
    display_name: Callable[[T], str | None],
    search_text: Callable[[T], str | None] | None = None,
) -> SpokenNameMatch[T]:
    """Port of resolveBySpokenName() (lib/one-location/resolve-by-spoken-name.ts).

    Deliberately simpler than ``resolve_spoken_names``/``match_circle_by_name``:
    one spoken name, case-insensitive substring only, no accent-stripping, no
    fuzzy fallback, no tiering. Used by the grant/request voice actions
    (stop_share, approve_request, decline_request), whose browser twins never
    asked for anything more precise than this.
    """
    search = search_text or display_name
    spoken = (spoken_name or "").strip().lower()
    if not spoken:
        return SpokenNameMatch(kind="none")
    matches = [item for item in candidates if spoken in str(search(item) or "").lower()]
    if not matches:
        return SpokenNameMatch(kind="none")
    if len(matches) == 1:
        return SpokenNameMatch(kind="one", match=matches[0])
    return SpokenNameMatch(kind="many", matches=matches)


def match_by_name(rows: list[T], spoken: str, name_of: Callable[[T], str | None]) -> list[T]:
    """Port of matchByName() (app/connect/page-client.tsx).

    A third, independent tiered matcher (exact -> word-boundary -> per-word
    alignment), local to the Connect page and used by both
    connect.remove_connection and connect.cancel_request. Its last tier
    differs from match_circle_by_name's (word alignment, not substring), and
    its word-boundary tier checks only a leading/whole-word hit, not a
    trailing one -- ported as-is rather than unified, since the point of a
    port is parity with what already shipped, not a cleaner algorithm.
    """
    target = normalize_spoken_name(spoken)
    if not target:
        return []
    indexed = [(row, normalize_spoken_name(str(name_of(row) or ""))) for row in rows]
    named = [(row, n) for row, n in indexed if n]

    exact = [row for row, n in named if n == target]
    if exact:
        return exact

    contains = [row for row, n in named if n.startswith(f"{target} ") or target in n.split(" ")]
    if contains:
        return contains

    target_words = [w for w in target.split(" ") if w]

    def word_alignment_match(name_norm: str) -> bool:
        name_words = [w for w in name_norm.split(" ") if w]
        shorter, longer = (
            (target_words, name_words)
            if len(target_words) <= len(name_words)
            else (name_words, target_words)
        )
        if not shorter:
            return False
        remaining = list(longer)
        for word in shorter:
            hit_index = next(
                (
                    i
                    for i, candidate in enumerate(remaining)
                    if candidate.startswith(word) or word.startswith(candidate)
                ),
                None,
            )
            if hit_index is None:
                return False
            remaining.pop(hit_index)
        return True

    return [row for row, n in named if word_alignment_match(n)]
