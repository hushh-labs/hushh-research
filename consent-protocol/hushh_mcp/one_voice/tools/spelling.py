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

It also compares two proposals of one name word by word (``name_word_changes``,
``name_word_slots``), so a correction can be held to the words it declares.
A word there is a whitespace-separated part of the name, compared the same
way: case folded, joiners inside it ignored, nothing else forgiven. V4 is not
V04. Which words changed is all it reports; whether the person asked for that
change is the model's declaration, never decided here.
"""

from __future__ import annotations

import unicodedata
from collections import Counter
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


def word_key(word: str) -> str:
    """One whitespace-free word in comparison form: :func:`spelling_key`, with
    each joiner that stands between two word characters removed (V-04 -> v04,
    O'Brien -> obrien). A joiner anywhere else still counts."""
    key = spelling_key(word)
    kept = [
        char
        for index, char in enumerate(key)
        if not (
            char in _JOINERS
            and 0 < index < len(key) - 1
            and _is_word_char(key[index - 1])
            and _is_word_char(key[index + 1])
        )
    ]
    return unicodedata.normalize("NFC", "".join(kept))


def word_keys(name: str) -> list[str]:
    """The comparison form of each whitespace-separated word of the name, in order."""
    return [word_key(word) for word in name.split()]


def _kept_pairs(old: Sequence[str], new: Sequence[str]) -> list[tuple[int, int]]:
    """Index pairs of a longest run of words both lists keep in the same order.

    The classic longest-common-subsequence table, walked from the front. Equal
    words are always paired when met, which is optimal, and ties skip the old
    word first, so the pairing is deterministic.
    """
    rows, cols = len(old), len(new)
    longest = [[0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(rows - 1, -1, -1):
        for j in range(cols - 1, -1, -1):
            longest[i][j] = (
                longest[i + 1][j + 1] + 1
                if old[i] == new[j]
                else max(longest[i + 1][j], longest[i][j + 1])
            )
    pairs: list[tuple[int, int]] = []
    i = j = 0
    while i < rows and j < cols:
        if old[i] == new[j]:
            pairs.append((i, j))
            i += 1
            j += 1
        elif longest[i + 1][j] >= longest[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def _surplus_words(
    words: Sequence[str], keys: Sequence[str], kept: set[int], surplus: Counter[str]
) -> list[str]:
    """For each key, its first ``surplus[key]`` words left unpaired, in name order."""
    left = Counter(surplus)
    found: list[str] = []
    for index, (word, key) in enumerate(zip(words, keys, strict=True)):
        if index not in kept and left[key] > 0:
            found.append(word)
            left[key] -= 1
    return found


def name_word_changes(old_name: str, new_name: str) -> tuple[list[str], list[str], bool]:
    """The words ``new_name`` removes from and adds to ``old_name``, and whether
    the words they share keep their relative order.

    Removed and added are the multiset difference of the word keys, so a
    repeated word counts each time ("Go Go Team" -> "Go Team" removes one Go).
    Each is reported as written in its own name, in name order. Order is kept
    when a longest in-order run of shared words covers every shared word.
    """
    old_words, new_words = old_name.split(), new_name.split()
    old_keys, new_keys = word_keys(old_name), word_keys(new_name)
    pairs = _kept_pairs(old_keys, new_keys)
    old_count, new_count = Counter(old_keys), Counter(new_keys)
    order_ok = len(pairs) == sum((old_count & new_count).values())
    removed = _surplus_words(old_words, old_keys, {i for i, _ in pairs}, old_count - new_count)
    added = _surplus_words(new_words, new_keys, {j for _, j in pairs}, new_count - old_count)
    return removed, added, order_ok


def name_word_slots(old_name: str, new_name: str) -> list[tuple[list[str], list[str]]]:
    """Where the names differ, in name order: for each stretch between two kept
    words, the old words it drops and the new words it puts there.

    Kept words are a longest in-order run of shared words. When the order is
    kept (see :func:`name_word_changes`) the slots hold exactly the removed and
    added words; a word that moved shows as dropped in one slot and put in
    another. Empty when nothing changed.
    """
    old_words, new_words = old_name.split(), new_name.split()
    pairs = _kept_pairs(word_keys(old_name), word_keys(new_name))
    slots: list[tuple[list[str], list[str]]] = []
    i = j = 0
    for kept_i, kept_j in [*pairs, (len(old_words), len(new_words))]:
        dropped, put = old_words[i:kept_i], new_words[j:kept_j]
        if dropped or put:
            slots.append((dropped, put))
        i, j = kept_i + 1, kept_j + 1
    return slots


__all__ = [
    "MAX_SPELLED_WORD_LENGTH",
    "clean_spelled_word",
    "missing_spelled_words",
    "name_tokens",
    "name_word_changes",
    "name_word_slots",
    "spell_out",
    "spelling_key",
    "unique_spelled_words",
    "word_key",
    "word_keys",
]
