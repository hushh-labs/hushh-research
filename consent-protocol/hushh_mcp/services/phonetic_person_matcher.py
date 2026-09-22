"""Rank people against a spoken name. Pure functions, no I/O.

Voice hears "Aysha" for a contact spelled "Ayesha" and "Pria" for "Priya".
The existing spoken-name helpers (``spoken_name_resolver``) settle exact and
edit-distance matches; this module adds two coarser signals -- a compact
phonetic key and Jaro-Winkler similarity -- and orders every candidate into
tiers so a caller can *offer* the likely people and never pick one itself:

* tier 0: the normalized name is exactly the spoken text;
* tier 1: the spoken text is a prefix or substring of a name token;
* tier 2: within the bounded edit distance ``is_fuzzy_match`` allows;
* tier 3: same phonetic key, or Jaro-Winkler at or above the threshold.

Tier 3 is a guess, so ``rank_candidates`` reports it as such (``tier``) and a
caller must word it as low confidence. Nothing here auto-resolves: the
canonical-identity rule (a spoken name is never an id) is enforced by the
tool layer, which only ever offers what this returns.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.spoken_name_resolver import is_fuzzy_match, normalize_spoken_name

JARO_WINKLER_THRESHOLD = 0.88
MAX_CANDIDATES = 5

TIER_EXACT = 0
TIER_PREFIX = 1
TIER_FUZZY = 2
TIER_PHONETIC = 3

# "Y" is treated as a vowel on purpose: transliterated names spell the same
# sound as Y, I, or E ("Ayesha" / "Aisha" / "Aysha"), and dropping all of them
# is what makes those collapse onto one key.
_VOWELS = frozenset("AEIOUY")
# An H after one of these is an aspiration marker in transliterated names
# ("Khan" / "Kahn", "Bhavna" / "Bavna", "Dhruv" / "Druv"); it changes nothing.
_ASPIRATED = frozenset("BDGJKRT")


def phonetic_key(word: str) -> str:
    """A compact Metaphone-flavored key: consonant skeleton, initial vowel kept.

    Deliberately coarse. Two names with the same key *sound* alike to a rough
    ear; the caller treats that as a guess to offer, never as a match.
    """
    text = "".join(ch for ch in normalize_spoken_name(word).upper() if "A" <= ch <= "Z")
    if not text:
        return ""
    if text[:2] in {"KN", "GN", "PN", "WR", "AE"}:
        text = text[1:]
    elif text[0] == "X":
        text = "S" + text[1:]
    elif text[:2] == "WH":
        text = "W" + text[2:]

    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        prev = text[i - 1] if i else ""
        nxt = text[i + 1] if i + 1 < n else ""
        after = text[i + 2] if i + 2 < n else ""
        if c == prev and c != "C":
            i += 1
            continue
        if c in _VOWELS:
            if i == 0:
                out.append("Y" if c == "Y" else "A")
        elif c == "B":
            if not (prev == "M" and not nxt):
                out.append("B")
        elif c == "C":
            if nxt == "H":
                out.append("K" if prev == "S" else "X")
                i += 1
            elif nxt in {"I", "E", "Y"}:
                if prev != "S":
                    out.append("S")
            else:
                out.append("K")
        elif c == "D":
            if nxt == "G" and after in {"E", "I", "Y"}:
                out.append("J")
                i += 1
            else:
                out.append("T")
        elif c == "G":
            if nxt == "H":
                if after and after in _VOWELS:
                    out.append("K")
                i += 1
            elif nxt == "N" and not after:
                pass
            elif nxt in {"I", "E", "Y"}:
                out.append("J")
            else:
                out.append("K")
        elif c == "H":
            if prev in _ASPIRATED:
                pass
            elif (i == 0 or prev in _VOWELS) and nxt in _VOWELS:
                out.append("H")
        elif c == "K":
            if prev != "C":
                out.append("K")
        elif c == "P":
            if nxt == "H":
                out.append("F")
                i += 1
            else:
                out.append("P")
        elif c == "Q":
            out.append("K")
        elif c == "S":
            if nxt == "H":
                out.append("X")
                i += 1
            elif nxt == "I" and after in {"O", "A"}:
                out.append("X")
            else:
                out.append("S")
        elif c == "T":
            if nxt == "I" and after in {"O", "A"}:
                out.append("X")
            elif nxt == "H":
                out.append("T")
                i += 1
            elif not (nxt == "C" and after == "H"):
                out.append("T")
        elif c == "V":
            out.append("F")
        elif c == "W":
            if nxt in _VOWELS:
                out.append("W")
        elif c == "X":
            out.append("KS")
        elif c == "Z":
            out.append("S")
        else:  # F J L M N R
            out.append(c)
        i += 1
    return "".join(out)


def jaro_winkler(a: str, b: str, *, prefix_scale: float = 0.1, max_prefix: int = 4) -> float:
    """Jaro-Winkler similarity in [0, 1]; 1.0 means identical."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    window = max(0, max(len(a), len(b)) // 2 - 1)
    a_hit = [False] * len(a)
    b_hit = [False] * len(b)
    matches = 0
    for i, ch in enumerate(a):
        lo = max(0, i - window)
        hi = min(len(b), i + window + 1)
        for j in range(lo, hi):
            if not b_hit[j] and b[j] == ch:
                a_hit[i] = b_hit[j] = True
                matches += 1
                break
    if matches == 0:
        return 0.0
    transpositions = 0
    k = 0
    for i, ch in enumerate(a):
        if not a_hit[i]:
            continue
        while not b_hit[k]:
            k += 1
        if ch != b[k]:
            transpositions += 1
        k += 1
    transpositions //= 2
    jaro = (matches / len(a) + matches / len(b) + (matches - transpositions) / matches) / 3.0
    prefix = 0
    for ca, cb in zip(a, b, strict=False):
        if ca != cb or prefix == max_prefix:
            break
        prefix += 1
    return jaro + prefix * prefix_scale * (1.0 - jaro)


@dataclass(frozen=True)
class ScoredCandidate:
    candidate: dict[str, Any]
    tier: int
    similarity: float
    matched_token: str | None = None

    @property
    def user_id(self) -> str:
        return candidate_user_id(self.candidate)

    @property
    def display_name(self) -> str:
        return candidate_display_name(self.candidate)


def candidate_display_name(candidate: dict[str, Any]) -> str:
    return str(candidate.get("display_name") or candidate.get("displayName") or "").strip()


def candidate_user_id(candidate: dict[str, Any]) -> str:
    return str(candidate.get("user_id") or candidate.get("userId") or "").strip()


def _align(
    target_tokens: list[str],
    name_tokens: list[str],
    accept: Callable[[str, str], bool],
) -> str | None:
    """Greedy: each spoken token must claim a distinct name token. Returns the
    first claimed token (for reporting) or ``None`` when alignment fails."""
    remaining = list(name_tokens)
    first: str | None = None
    for spoken in target_tokens:
        hit = next((tok for tok in remaining if accept(spoken, tok)), None)
        if hit is None:
            return None
        remaining.remove(hit)
        first = first or hit
    return first


def _prefix_or_substring(spoken: str, token: str) -> bool:
    return token.startswith(spoken) or spoken in token


def _fuzzy(spoken: str, token: str) -> bool:
    return _prefix_or_substring(spoken, token) or is_fuzzy_match(spoken, token)


def _phonetic(spoken: str, token: str) -> bool:
    if _fuzzy(spoken, token):
        return True
    key = phonetic_key(spoken)
    if key and key == phonetic_key(token):
        return True
    return jaro_winkler(spoken, token) >= JARO_WINKLER_THRESHOLD


def match_tier(spoken: str, display_name: str) -> tuple[int, str | None] | None:
    """The tier one name earns against one spoken text, or ``None``."""
    target = normalize_spoken_name(spoken)
    name = normalize_spoken_name(display_name)
    if not target or not name:
        return None
    if name == target:
        return TIER_EXACT, name
    target_tokens = target.split(" ")
    name_tokens = name.split(" ")
    if target in name:
        return TIER_PREFIX, next((tok for tok in name_tokens if target in tok), name)
    hit = _align(target_tokens, name_tokens, _prefix_or_substring)
    if hit is not None:
        return TIER_PREFIX, hit
    if is_fuzzy_match(target, name):
        return TIER_FUZZY, name
    hit = _align(target_tokens, name_tokens, _fuzzy)
    if hit is not None:
        return TIER_FUZZY, hit
    compact_target = target.replace(" ", "")
    compact_name = name.replace(" ", "")
    key = phonetic_key(compact_target)
    if key and key == phonetic_key(compact_name):
        return TIER_PHONETIC, name
    if jaro_winkler(target, name) >= JARO_WINKLER_THRESHOLD:
        return TIER_PHONETIC, name
    hit = _align(target_tokens, name_tokens, _phonetic)
    if hit is not None:
        return TIER_PHONETIC, hit
    return None


def rank_candidates(
    spoken: str,
    candidates: list[dict[str, Any]],
    *,
    limit: int = MAX_CANDIDATES,
) -> list[ScoredCandidate]:
    """Every candidate that earns a tier, best tier first, at most ``limit``.

    Only the best tier and the one below it are kept: an exact match is not
    padded with phonetic guesses, but a prefix match still travels with the
    fuzzy near-miss next to it ("Aisha" offers Aisha Khan *and* Ayesha Sharma).
    Ties within a tier break on Jaro-Winkler similarity, then name.
    """
    target = normalize_spoken_name(spoken)
    if not target:
        return []
    scored: list[ScoredCandidate] = []
    for candidate in candidates:
        display_name = candidate_display_name(candidate)
        outcome = match_tier(target, display_name)
        if outcome is None:
            continue
        tier, matched = outcome
        name = normalize_spoken_name(display_name)
        similarity = max(
            [jaro_winkler(target, name)] + [jaro_winkler(target, tok) for tok in name.split(" ")]
        )
        scored.append(ScoredCandidate(candidate, tier, round(similarity, 4), matched))
    if not scored:
        return []
    best = min(item.tier for item in scored)
    kept = [item for item in scored if item.tier <= best + 1]
    kept.sort(
        key=lambda item: (
            item.tier,
            -item.similarity,
            item.display_name.lower(),
            item.user_id,
        )
    )
    return kept[:limit]


__all__ = [
    "JARO_WINKLER_THRESHOLD",
    "MAX_CANDIDATES",
    "ScoredCandidate",
    "TIER_EXACT",
    "TIER_FUZZY",
    "TIER_PHONETIC",
    "TIER_PREFIX",
    "candidate_display_name",
    "candidate_user_id",
    "jaro_winkler",
    "match_tier",
    "phonetic_key",
    "rank_candidates",
]
