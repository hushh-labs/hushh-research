"""One Unicode word rule for Drive file names and request text.

A word is a run of letters, combining marks and digits (Unicode categories L, M
and N, plus the zero-width joiners Indic spellings use). Python's ``\\w`` and
``[^\\W_]`` leave combining marks out, so a Devanagari name such as
'हिंदी बैंक स्टेटमेंट.pdf' fell apart at every vowel sign, virama and anusvara
(ह, द, ब, क, ...). Here it is three words: हिंदी, बैंक and स्टेटमेंट.

Underscores and punctuation separate words, as Drive's own index treats them.
Folding lowercases, turns every Unicode decimal digit into its ASCII digit
(२०२६ is 2026) and drops optional marks: Latin, Greek and Cyrillic accents
('Résumé' is 'resume'), Hebrew points and Arabic harakat. Indic vowel signs,
virama and nukta are part of the spelling and are never dropped. Text is NFC-normalised first, so precomposed and
decomposed spellings compare equal.

Pure functions: no I/O, no logging, no model.
"""

from __future__ import annotations

import itertools
import re
import unicodedata


def _mark_class() -> str:
    """A regex class body for every combining mark this Python's Unicode knows.

    Every mark lies below U+20000 or in the variation selectors supplement
    (checked by the tests), so the scan stays a few milliseconds at import.
    """
    ranges: list[tuple[int, int]] = []
    for code in itertools.chain(range(0x300, 0x20000), range(0xE0100, 0xE01F0)):
        if unicodedata.category(chr(code))[0] != "M":
            continue
        if ranges and ranges[-1][1] == code - 1:
            ranges[-1] = (ranges[-1][0], code)
        else:
            ranges.append((code, code))
    # Zero-width non-joiner and joiner sit inside Indic words.
    ranges.append((0x200C, 0x200D))
    return "".join(
        f"\\U{start:08x}" if start == end else f"\\U{start:08x}-\\U{end:08x}"
        for start, end in ranges
    )


_MARKS = _mark_class()
# One word character: a letter or digit (Python's [^\W_]) or a combining mark.
WORD_CHAR = rf"(?:[^\W_]|[{_MARKS}])"
# Lookarounds: not inside a word on that side.
NOT_AFTER_WORD = rf"(?<![^\W_])(?<![{_MARKS}])"
NOT_BEFORE_WORD = rf"(?![^\W_]|[{_MARKS}])"
WORD_RUN = re.compile(rf"{WORD_CHAR}+")
# Letters and marks only, or digits only: the letter/digit runs inside a code.
LETTER_RUN = re.compile(rf"(?:[^\W\d_]|[{_MARKS}])+|\d+")
# A code: word runs joined by single _ - . / separators ("INV_2026_HDFC_9981").
_SEPARATED = re.compile(rf"{WORD_CHAR}+(?:[_\-./]{WORD_CHAR}+)+")
# Scripts whose marks are optional accents or vowel points: dropped when
# folding, as before. The marks of Indic and other scripts are mandatory
# vowels and signs, so they stay.
_FOLDED_MARK_SCRIPTS = (
    (0x0000, 0x024F),  # Basic Latin to Latin Extended-B
    (0x0370, 0x052F),  # Greek, Cyrillic and Cyrillic Supplement
    (0x0590, 0x074F),  # Hebrew points, Arabic harakat, Syriac vowels
    (0x0750, 0x077F),  # Arabic Supplement
    (0x08A0, 0x08FF),  # Arabic Extended-A
    (0x1C80, 0x1C8F),  # Cyrillic Extended-C
    (0x1E00, 0x1FFF),  # Latin Extended Additional, Greek Extended
    (0x2C60, 0x2C7F),  # Latin Extended-C
    (0x2DE0, 0x2DFF),  # Cyrillic Extended-A
    (0xA640, 0xA69F),  # Cyrillic Extended-B
    (0xA720, 0xA7FF),  # Latin Extended-D
    (0xAB30, 0xAB6F),  # Latin Extended-E
    (0xFB1D, 0xFDFF),  # Hebrew and Arabic presentation forms
    (0xFE70, 0xFEFF),  # Arabic presentation forms-B
    (0xFF00, 0xFFEF),  # Halfwidth and Fullwidth Forms
)


def _folds_marks(character: str) -> bool:
    code = ord(character)
    return any(start <= code <= end for start, end in _FOLDED_MARK_SCRIPTS)


def ascii_digits(text: str) -> str:
    """Every Unicode decimal digit as its ASCII digit; one character for one."""
    if text.isascii():
        return text
    return "".join(
        str(unicodedata.decimal(character))
        if not character.isascii() and unicodedata.category(character) == "Nd"
        else character
        for character in text
    )


def normalize(text: str) -> str:
    """NFC with ASCII digits; case and accents are kept."""
    if text.isascii():
        return text
    return ascii_digits(unicodedata.normalize("NFC", text))


def fold(text: str) -> str:
    """Casefolded, ASCII digits; optional accents and vowel points dropped.

    Latin, Greek and Cyrillic accents, Hebrew points and Arabic harakat go;
    Devanagari and other Indic vowel signs are spelling and stay.
    """
    if text.isascii():
        return text.lower()
    kept: list[str] = []
    strip = False
    for character in unicodedata.normalize("NFKD", text):
        if unicodedata.category(character)[0] == "M":
            if not strip:
                kept.append(character)
            continue
        strip = _folds_marks(character)
        kept.append(character)
    return ascii_digits(unicodedata.normalize("NFC", "".join(kept))).casefold()


_ASCII_WORD = re.compile(r"[A-Za-z0-9]+")
_ASCII_LETTER_RUN = re.compile(r"[A-Za-z]+|[0-9]+")


def words(text: str) -> list[str]:
    """The word runs of ``text`` as written (no folding).

    ASCII text has no combining marks, so it takes the plain (fast) class.
    """
    return (_ASCII_WORD if text.isascii() else WORD_RUN).findall(text)


def letter_runs(word: str) -> list[str]:
    """Letter runs (with their marks) and digit runs: "inv2026" is inv, 2026."""
    return (_ASCII_LETTER_RUN if word.isascii() else LETTER_RUN).findall(word)


def is_word(text: str) -> bool:
    """One whole word: letters, marks and digits only."""
    return bool(WORD_RUN.fullmatch(text))


def code_like(text: str) -> bool:
    """A code: word runs joined by _ - . /, with at least one letter and one digit."""
    return bool(
        _SEPARATED.fullmatch(text)
        and any(character.isdigit() for character in text)
        and any(character.isalpha() for character in text)
    )


def separated_words(text: str) -> bool:
    """Word runs joined by spaces or _ - . / and nothing else."""
    return bool(re.fullmatch(rf"{WORD_CHAR}+(?:[\s_\-./]+{WORD_CHAR}+)+", text))


__all__ = [
    "LETTER_RUN",
    "NOT_AFTER_WORD",
    "NOT_BEFORE_WORD",
    "WORD_CHAR",
    "WORD_RUN",
    "ascii_digits",
    "code_like",
    "fold",
    "is_word",
    "letter_runs",
    "normalize",
    "separated_words",
    "words",
]
