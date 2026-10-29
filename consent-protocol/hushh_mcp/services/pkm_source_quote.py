"""Map a model's quote back onto the owner's exact characters.

A quote the model returned with ordinary copy drift (Markdown cleaned, a dash,
quotation mark or apostrophe normalized, a compatibility form such as "…" or a
fullwidth letter, sentence case, or a final period added) is still the owner's
text. These fold away before matching, and the match maps back to the ORIGINAL
characters, so the stored quote and its offsets are always an exact span of
what the owner wrote. There is no fuzzy repair: a translated, paraphrased or
invented quote matches nothing and the caller fails closed.

Import-safe leaf: standard library only.
"""

from __future__ import annotations

import unicodedata

_QUOTE_EQUIVALENTS = {
    "\u2010": "-",
    "\u2011": "-",
    "\u2012": "-",
    "\u2013": "-",
    "\u2014": "-",
    "\u2212": "-",
    "\u2018": "'",
    "\u2019": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u00a0": " ",
}
_QUOTE_MARKUP = frozenset("*_`#>\\")
# Apostrophes drop on both sides, so "dont" and "don't" fold together.
_QUOTE_APOSTROPHES = frozenset("'\u02bc")
# Edge punctuation the model adds or trims around a quote ("I prefer tea.").
_QUOTE_EDGE_PUNCTUATION = ' .,;:!?"'
_MIN_QUOTE_ALNUM = 2


def fold_for_quote_match(text: str) -> tuple[str, list[int]]:
    """Fold compatibility forms, markup, dash/quote variants, case and spaces.

    Returns the folded text and, for each folded character, the index of the
    source character it came from.
    """
    folded: list[str] = []
    origin: list[int] = []
    pending_space = False
    for index, raw_char in enumerate(text):
        for normalized in unicodedata.normalize("NFKC", raw_char):
            char = _QUOTE_EQUIVALENTS.get(normalized, normalized)
            if char in _QUOTE_MARKUP:
                continue
            if char.isspace():
                pending_space = bool(folded)
                continue
            for cased in char.casefold():
                if cased in _QUOTE_APOSTROPHES:
                    continue
                if pending_space:
                    folded.append(" ")
                    origin.append(index)
                    pending_space = False
                folded.append(cased)
                origin.append(index)
    return "".join(folded), origin


def locate_source_quote(message: str, quote: str) -> tuple[int, int] | None:
    """The exact span of ``message`` a model quote refers to, or None.

    An exact substring wins. Otherwise both sides fold (``fold_for_quote_match``):
    the whole folded quote is tried first, so the owner's own end punctuation
    stays in the span, then the quote with its edge punctuation trimmed. The
    span returned is always in the original message, so the caller keeps the
    owner's own characters and offsets, never the model's rewrite. A folded
    match that is ambiguous, or that ends a clause the owner kept writing,
    matches nothing.
    """
    if not isinstance(quote, str) or not quote.strip():
        return None
    index = message.find(quote)
    if index >= 0:
        return index, index + len(quote)
    folded_quote = fold_for_quote_match(quote)[0]
    trimmed_quote = folded_quote.strip(_QUOTE_EDGE_PUNCTUATION)
    if sum(char.isalnum() for char in trimmed_quote) < _MIN_QUOTE_ALNUM:
        return None
    folded_message, origin = fold_for_quote_match(message)
    spans = _folded_spans(folded_message, origin, folded_quote)
    if not spans and trimmed_quote != folded_quote:
        # The model may add end punctuation the owner never typed. It may not end
        # a clause the owner kept writing ("I'm vegetarian." for "..., except weekends").
        claims_end = folded_quote.rstrip(_QUOTE_EDGE_PUNCTUATION) != folded_quote
        spans = [
            span
            for span in _folded_spans(folded_message, origin, trimmed_quote)
            if not claims_end or _line_ends_at(message, span[1])
        ]
    # Different original text folding to one form ("I like tea" and "i like tea") is ambiguous.
    if len({message[start:end] for start, end in spans}) != 1:
        return None
    return spans[0]


def _folded_spans(folded_message: str, origin: list[int], needle: str) -> list[tuple[int, int]]:
    """Original spans of every occurrence of ``needle`` that respects word boundaries."""
    spans: list[tuple[int, int]] = []
    at = folded_message.find(needle)
    while at >= 0:
        if _on_word_boundaries(folded_message, at, len(needle)):
            spans.append((origin[at], origin[at + len(needle) - 1] + 1))
        at = folded_message.find(needle, at + 1)
    return spans


def _line_ends_at(message: str, end: int) -> bool:
    """No letter or digit follows ``end`` on the same line."""
    return not any(char.isalnum() for char in message[end:].split("\n", 1)[0])


def _on_word_boundaries(text: str, start: int, length: int) -> bool:
    """A folded match may not begin or end inside a word ("hi" inside "this")."""
    end = start + length
    starts_clean = start == 0 or not (text[start - 1].isalnum() and text[start].isalnum())
    ends_clean = end == len(text) or not (text[end - 1].isalnum() and text[end].isalnum())
    return starts_clean and ends_clean
