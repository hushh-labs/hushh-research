"""Exact checks for a word the person spelled letter by letter.

A pure gene: typed, import-safe, no I/O. The model decides which words the
person spelled and declares them; this module only checks that a name the
model proposes still contains each declared word, and reads a word back
letter by letter. It never decides what the person meant.

Matching is deliberately exact. A spelled word passes only when it equals one
whole token of the name after NFC normalization and case folding: no accent
stripping, no prefix or substring, no edit distance. HUSH is not HUSSH and
HUSSHX is not HUSSH; that difference is the reason the person spelled it.

The cleaner and the matcher share one idea of a word: letters, digits and
combining marks (a dot above, a Devanagari vowel sign), so a word always
matches itself. Apostrophes, hyphens and periods inside a word are structure,
not letters: O'Brien is the word OBRIEN on both sides.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable, Sequence

MAX_SPELLED_WORD_LENGTH = 40

# Marks that join the parts of one word (O'Brien, Jean-Luc, St.Ives). Removed
# from a declared word and from a name token before comparing; never a letter.
_JOINERS = frozenset("'\u2019-\u2010\u2011.")
# What may separate the letters of a word given one by one: "h u s s h",
# "H-U-S-S-H", "H.U.S.S.H".
_LETTER_SEPARATORS = frozenset("-\u2010\u2011.")


def _is_word_char(char: str) -> bool:
    """A letter, a digit, or a combining mark that belongs to the one before."""
    return char.isalnum() or unicodedata.category(char).startswith("M")


def _word_runs(text: str) -> list[str]:
    """The maximal runs of word characters in ``text``, in order."""
    runs: list[str] = []
    current: list[str] = []
    for char in text:
        if _is_word_char(char):
            current.append(char)
        elif current:
            runs.append("".join(current))
            current = []
    if current:
        runs.append("".join(current))
    return runs


def _is_one_character(piece: str) -> bool:
    """One letter or digit, with any combining marks it carries."""
    return (
        bool(piece)
        and piece[0].isalnum()
        and all(unicodedata.category(char).startswith("M") for char in piece[1:])
    )


def _letters_spelled_out(text: str) -> str | None:
    """The joined word when ``text`` is single characters separated by spaces,
    hyphens or periods ("h u s s h", "H. U. S. S. H." -> the letters joined);
    otherwise None."""
    pieces: list[str] = []
    current: list[str] = []
    for char in text:
        if char.isspace() or char in _LETTER_SEPARATORS:
            pieces.append("".join(current))
            current = []
        else:
            current.append(char)
    pieces.append("".join(current))
    pieces = [piece for piece in pieces if piece]
    if len(pieces) < 2 or not all(_is_one_character(piece) for piece in pieces):
        return None
    return "".join(pieces)


def _without_inner_joiners(text: str) -> str | None:
    """``text`` with each joiner between two word characters removed, or None
    when a joiner stands anywhere else ("-HUSSH", "HUS--SH")."""
    kept: list[str] = []
    for index, char in enumerate(text):
        if char not in _JOINERS:
            kept.append(char)
            continue
        inside = 0 < index < len(text) - 1
        if not (inside and _is_word_char(text[index - 1]) and _is_word_char(text[index + 1])):
            return None
    return "".join(kept)


def spelling_key(word: str) -> str:
    """The comparison form of a word: NFC, case folded, NFC again.

    Case folding can decompose a character, so the result is normalized again
    and both sides of every comparison are the same canonical string.
    """
    return unicodedata.normalize("NFC", unicodedata.normalize("NFC", word).casefold())


def clean_spelled_word(raw: str) -> str | None:
    """The word, or None when it is not one word of letters and digits.

    Surrounding whitespace is dropped and the text is NFC normalized (the same
    characters, canonically composed). Letters given one by one ("h u s s h",
    "H-U-S-S-H") are joined into the word; an apostrophe, hyphen or period
    inside a word is dropped (O'Brien -> OBrien). Any other space or mark makes
    it not a word. Case is never changed.
    """
    text = unicodedata.normalize("NFC", raw.strip())
    word = _letters_spelled_out(text)
    if word is None:
        if any(char.isspace() for char in text):
            return None
        word = _without_inner_joiners(text)
        if word is None:
            return None
    word = unicodedata.normalize("NFC", word)
    if not 1 <= len(word) <= MAX_SPELLED_WORD_LENGTH:
        return None
    if not word[0].isalnum() or not all(_is_word_char(char) for char in word):
        return None
    return word


def name_tokens(name: str) -> list[str]:
    """The name's runs of letters, digits and marks, in comparison form."""
    return _word_runs(spelling_key(name))


def _name_keys(name: str) -> set[str]:
    """Every whole word of the name a spelled word may equal: each run of word
    characters, and each space-separated part with its joiners removed
    (O'Brien -> obrien, Jean-Luc -> jeanluc)."""
    key = spelling_key(name)
    keys = set(_word_runs(key))
    for part in key.split():
        keys.update(_word_runs("".join(char for char in part if char not in _JOINERS)))
    return keys


def unique_spelled_words(words: Iterable[str]) -> list[str]:
    """Each word once, compared without case, keeping the first spelling seen."""
    seen: set[str] = set()
    unique: list[str] = []
    for word in words:
        key = spelling_key(word)
        if key in seen:
            continue
        seen.add(key)
        unique.append(word)
    return unique


def missing_spelled_words(name: str, words: Sequence[str]) -> list[str]:
    """The spelled words the name does not contain as a whole word, in input order."""
    keys = _name_keys(name)
    return [word for word in unique_spelled_words(words) if spelling_key(word) not in keys]


def spell_out(word: str) -> str:
    """The word read back letter by letter: HUSSH -> H-U-S-S-H, V04 -> V-0-4."""
    return "-".join(word.upper())


__all__ = [
    "MAX_SPELLED_WORD_LENGTH",
    "clean_spelled_word",
    "missing_spelled_words",
    "name_tokens",
    "spell_out",
    "spelling_key",
    "unique_spelled_words",
]
