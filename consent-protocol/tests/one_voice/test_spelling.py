"""A word the person spelled letter by letter is matched exactly, never fuzzily.

UAT: the person spelled "h u s s h" for the circle HUSSH GARAGE V04 and the
proposal that followed said HUSH. A spelled word therefore passes only as one
whole token of the name, compared without case: no accent folding, no prefix
or substring, no edit distance.
"""

from __future__ import annotations

import unicodedata

from hushh_mcp.one_voice.tools.spelling import (
    clean_spelled_word,
    missing_spelled_words,
    name_tokens,
    spell_out,
)


def test_a_spelled_word_passes_only_as_one_whole_token_of_the_name():
    assert name_tokens("HUSSH Garage-V04") == ["hussh", "garage", "v04"]
    assert missing_spelled_words("HUSSH GARAGE V04", ["hussh", "V04"]) == []
    # One letter short, or one letter long, is a different word.
    assert missing_spelled_words("HUSH GARAGE V04", ["HUSSH"]) == ["HUSSH"]
    assert missing_spelled_words("HUSSHX GARAGE", ["HUSSH"]) == ["HUSSH"]
    assert missing_spelled_words("HUSSHGARAGE", ["HUSSH"]) == ["HUSSH"]
    # Digits are part of the word: V4 is not V04.
    assert missing_spelled_words("HUSSH GARAGE V4", ["V04"]) == ["V04"]
    # Missing words come back in input order, once each.
    assert missing_spelled_words("GARAGE", ["HUSSH", "V04", "hussh"]) == ["HUSSH", "V04"]


def test_composed_and_decomposed_accents_are_the_same_word_but_accents_still_count():
    decomposed = unicodedata.normalize("NFD", "Café")
    assert missing_spelled_words("CAFÉ Club", [decomposed]) == []
    assert missing_spelled_words("CAFE Club", ["CAFÉ"]) == ["CAFÉ"]


def test_combining_marks_are_part_of_the_word_in_the_cleaner_and_the_matcher():
    # İ case folds to i plus a combining dot, and a Devanagari vowel sign is a
    # mark: each word must still match itself.
    assert clean_spelled_word("İSTANBUL") == "İSTANBUL"
    assert missing_spelled_words("İstanbul Friends", ["İSTANBUL"]) == []
    assert clean_spelled_word("किताब") == "किताब"
    assert name_tokens("किताब Club") == ["किताब", "club"]
    assert missing_spelled_words("किताब Club", ["किताब"]) == []
    # The marks still count: without the vowel sign it is a different word.
    assert missing_spelled_words("कताब Club", ["किताब"]) == ["किताब"]


def test_apostrophes_hyphens_and_periods_inside_a_name_word_do_not_split_it():
    assert missing_spelled_words("O'Brien Family", ["OBRIEN"]) == []
    assert missing_spelled_words("Jean-Luc Club", ["jeanluc"]) == []
    # Still exact: dropping the marks never lets a near miss through.
    assert missing_spelled_words("O'Bryan Family", ["OBRIEN"]) == ["OBRIEN"]
    assert missing_spelled_words("Jean-Lucas Club", ["jeanluc"]) == ["jeanluc"]


def test_spell_out_reads_each_character_back():
    assert spell_out("HUSSH") == "H-U-S-S-H"
    assert spell_out("v04") == "V-0-4"


def test_clean_spelled_word_accepts_one_word_or_its_letters_spelled_out():
    assert clean_spelled_word("  HUSSH ") == "HUSSH"
    assert clean_spelled_word("hussh") == "hussh"
    assert clean_spelled_word("V04") == "V04"
    # Letters given one by one are joined into the word; case is never changed.
    assert clean_spelled_word("H-U-S-S-H") == "HUSSH"
    assert clean_spelled_word("h u s s h") == "hussh"
    assert clean_spelled_word("v 0 4") == "v04"
    # Marks inside a word are dropped; any other space or mark is not a word.
    assert clean_spelled_word("O'Brien") == "OBrien"
    assert clean_spelled_word("Jean-Luc") == "JeanLuc"
    assert clean_spelled_word("HUSSH GARAGE") is None
    assert clean_spelled_word("h u ss h") is None
    assert clean_spelled_word("HUSSH!") is None
    assert clean_spelled_word("-HUSSH") is None
    assert clean_spelled_word("") is None
    assert clean_spelled_word("A" * 40) == "A" * 40
    assert clean_spelled_word("A" * 41) is None
