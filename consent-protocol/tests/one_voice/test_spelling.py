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
    name_word_changes,
    name_word_slots,
    spell_out,
    word_keys,
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


# -- what a correction changed in a name -------------------------------------------
#
# UAT: "only make it V05" turned the waiting HUSSH GARAGE V04 into HUSH GARAGE V05
# while no word had been declared as spelled. A correction is compared word by
# word with the name it corrects, so an untouched word that changed is found
# whatever the model declared about spelling.


def test_word_keys_compare_whole_words_without_case_or_inner_joiners():
    assert word_keys("HUSSH  Garage V-04") == ["hussh", "garage", "v04"]
    assert word_keys("O'Brien St.Ives") == ["obrien", "stives"]
    # A joiner at the edge of a word is not inside it, so it still counts.
    assert word_keys("-V04") == ["-v04"]


def test_name_word_changes_names_each_changed_word_as_it_was_written():
    assert name_word_changes("HUSSH GARAGE V04", "HUSSH GARAGE V05") == (["V04"], ["V05"], True)
    assert name_word_changes("HUSSH GARAGE V04", "HUSH GARAGE V04") == (["HUSSH"], ["HUSH"], True)
    # Case, and a joiner inside a word, are not changes; a leading zero is.
    assert name_word_changes("HUSSH GARAGE V04", "hussh Garage V-04") == ([], [], True)
    assert name_word_changes("HUSSH GARAGE V04", "HUSSH GARAGE V4") == (["V04"], ["V4"], True)
    assert name_word_changes("HUSSH GARAGE", "HUSSH GARAGE V04") == ([], ["V04"], True)
    assert name_word_changes("HUSSH GARAGE V04", "HUSSH V04") == (["GARAGE"], [], True)


def test_name_word_changes_counts_repeated_words_and_checks_their_order():
    assert name_word_changes("Go Go Team", "Go Team") == (["Go"], [], True)
    assert name_word_changes("Go Team", "Go Go Team") == ([], ["Go"], True)
    # The same words in another order: nothing added or removed, order not kept.
    assert name_word_changes("HUSSH GARAGE V04", "GARAGE HUSSH V04") == ([], [], False)


def test_name_word_slots_keep_each_change_with_the_words_it_replaced():
    assert name_word_slots("HUSSH GARAGE V04", "HUSH GARAGE V05") == [
        (["HUSSH"], ["HUSH"]),
        (["V04"], ["V05"]),
    ]
    assert name_word_slots("HUSSH GARAGE V04", "HUSSH Garaz V4") == [
        (["GARAGE", "V04"], ["Garaz", "V4"])
    ]
    assert name_word_slots("HUSSH GARAGE", "HUSSH GARAGE V04") == [([], ["V04"])]
    assert name_word_slots("HUSSH GARAGE V04", "hussh garage v-04") == []
