"""Gene: feature counts for the text-start and metadata scorers.

Pure and shared by training and inference, so the two can never disagree about
what a feature is. Digits fold to ``0`` so an account number or a date leaves no
trace in a feature name. Features are sparse counts keyed by short strings.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter

_WORD = re.compile(r"[^\W_]+")
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_DIGIT = re.compile(r"\d")
_EXTENSION = re.compile(r"\.([A-Za-z0-9]{1,8})\Z")
MAX_NAME_CHARS = 300


def fold(text: str) -> str:
    """Lowercase, compatibility-fold and replace every digit with ``0``."""
    return _DIGIT.sub("0", unicodedata.normalize("NFKC", text).lower())


def _words(text: str) -> list[str]:
    return _WORD.findall(fold(text))


def _char_grams(words: list[str], sizes: tuple[int, ...]) -> list[str]:
    grams: list[str] = []
    for word in words:
        padded = f" {word} "
        for size in sizes:
            grams.extend(padded[index : index + size] for index in range(len(padded) - size + 1))
    return grams


def text_features(head: str) -> Counter[str]:
    """Word 1-2 grams and word-bounded character 3-5 grams of the text start."""
    words = _words(head)
    counts: Counter[str] = Counter(f"w:{word}" for word in words)
    counts.update(f"b:{first} {second}" for first, second in zip(words, words[1:], strict=False))
    counts.update(f"c:{gram}" for gram in _char_grams(words, (3, 4, 5)))
    return counts


def _split_name(name: str) -> tuple[str, str]:
    extension = _EXTENSION.search(name)
    stem = name[: extension.start()] if extension else name
    return stem, extension.group(1).lower() if extension else ""


def metadata_features(
    name: str,
    mime_type: str,
    *,
    owned_by_me: bool | None = None,
    shared_with_me: bool | None = None,
) -> Counter[str]:
    """Name words and grams, extension, MIME type and ownership of a Drive row."""
    stem, extension = _split_name(name[:MAX_NAME_CHARS])
    words = _words(_CAMEL.sub(" ", stem))
    counts: Counter[str] = Counter(f"w:{word}" for word in words)
    counts.update(f"b:{first} {second}" for first, second in zip(words, words[1:], strict=False))
    counts.update(f"c:{gram}" for gram in _char_grams(words, (3, 4)))
    if extension:
        counts[f"ext:{extension}"] += 1
    counts[f"mime:{mime_type.lower()[:80]}"] += 1
    counts[f"own:{'me' if owned_by_me else 'other' if owned_by_me is False else 'unknown'}"] += 1
    counts[f"shr:{'1' if shared_with_me else '0' if shared_with_me is False else 'unknown'}"] += 1
    return counts
