"""Pure ranking: tiers, phonetic key, Jaro-Winkler. No services involved."""

from __future__ import annotations

import pytest

from hushh_mcp.services.phonetic_person_matcher import (
    JARO_WINKLER_THRESHOLD,
    MAX_CANDIDATES,
    TIER_EXACT,
    TIER_FUZZY,
    TIER_PHONETIC,
    TIER_PREFIX,
    jaro_winkler,
    match_tier,
    phonetic_key,
    rank_candidates,
)

PEOPLE = [
    {"user_id": "u-ayesha", "display_name": "Ayesha Sharma"},
    {"user_id": "u-aisha", "display_name": "Aisha Khan"},
    {"user_id": "u-priya", "display_name": "Priya Nair"},
    {"user_id": "u-rahul", "display_name": "Rahul Verma"},
]


def _names(spoken: str, candidates=PEOPLE) -> list[str]:
    return [item.display_name for item in rank_candidates(spoken, candidates)]


def test_aysha_offers_both_ayesha_and_aisha():
    ranked = rank_candidates("Aysha", PEOPLE)
    assert [item.display_name for item in ranked] == ["Ayesha Sharma", "Aisha Khan"]
    assert {item.tier for item in ranked} == {TIER_FUZZY}
    assert {item.user_id for item in ranked} == {"u-ayesha", "u-aisha"}


def test_aisha_offers_exact_token_first_then_fuzzy_neighbor():
    ranked = rank_candidates("Aisha", PEOPLE)
    assert [item.display_name for item in ranked] == ["Aisha Khan", "Ayesha Sharma"]
    assert [item.tier for item in ranked] == [TIER_PREFIX, TIER_FUZZY]


def test_pria_finds_priya_nair_only():
    ranked = rank_candidates("Pria", PEOPLE)
    assert [item.display_name for item in ranked] == ["Priya Nair"]
    assert ranked[0].tier == TIER_FUZZY
    assert ranked[0].matched_token == "priya"


def test_zed_matches_nobody():
    assert rank_candidates("Zed", PEOPLE) == []


def test_exact_full_name_is_tier_zero_and_drops_phonetic_guesses():
    ranked = rank_candidates("Ayesha Sharma", PEOPLE)
    assert [item.display_name for item in ranked] == ["Ayesha Sharma"]
    assert ranked[0].tier == TIER_EXACT
    assert ranked[0].similarity == 1.0


def test_surname_alone_is_a_prefix_match():
    ranked = rank_candidates("sharma", PEOPLE)
    assert [(item.display_name, item.tier) for item in ranked] == [("Ayesha Sharma", TIER_PREFIX)]


def test_longer_spoken_name_falls_to_phonetic_tier():
    ranked = rank_candidates("Priyanka", PEOPLE)
    assert [(item.display_name, item.tier) for item in ranked] == [("Priya Nair", TIER_PHONETIC)]


def test_two_word_spoken_name_aligns_tokens_independently():
    assert _names("Ayesha Khan")[0] == "Aisha Khan"
    assert match_tier("a sharma", "Ayesha Sharma")[0] == TIER_PREFIX
    assert match_tier("sharma ayesha", "Ayesha Sharma") == (TIER_PREFIX, "sharma")
    assert match_tier("ayesha sharma", "Aisha Khan") is None


def test_accents_and_punctuation_do_not_matter():
    assert match_tier("aysé", "Ayse D'Souza") == (TIER_PREFIX, "ayse")
    assert match_tier("D'Souza", "Ayse D'Souza")[0] == TIER_PREFIX


def test_empty_or_blank_spoken_name_returns_nothing():
    assert rank_candidates("", PEOPLE) == []
    assert rank_candidates("   ", PEOPLE) == []
    assert match_tier("ayesha", "") is None


def test_candidates_without_a_name_are_skipped():
    assert rank_candidates("ayesha", [{"user_id": "x", "display_name": ""}, {"user_id": "y"}]) == []


def test_camel_case_service_rows_are_accepted():
    ranked = rank_candidates("aisha", [{"userId": "u2", "displayName": "Aisha Khan"}])
    assert ranked[0].user_id == "u2"
    assert ranked[0].display_name == "Aisha Khan"


def test_at_most_five_candidates_sorted_by_tier_then_similarity_then_name():
    sams = [{"user_id": f"u{i}", "display_name": f"Sam {chr(65 + i)}"} for i in range(8)]
    ranked = rank_candidates("sam", sams)
    assert len(ranked) == MAX_CANDIDATES
    assert [item.display_name for item in ranked] == ["Sam A", "Sam B", "Sam C", "Sam D", "Sam E"]


def test_only_best_tier_and_the_next_are_kept():
    people = [
        {"user_id": "a", "display_name": "Sam Patel"},  # prefix (1)
        {"user_id": "b", "display_name": "Sami Roy"},  # fuzzy (2) -- kept
        {"user_id": "c", "display_name": "Zam Xu"},  # phonetic (3) -- dropped
    ]
    ranked = rank_candidates("sam", people)
    assert [item.display_name for item in ranked] == ["Sam Patel", "Sami Roy"]
    assert match_tier("sam", "Zam Xu") == (TIER_PHONETIC, "zam")


@pytest.mark.parametrize(
    ("first", "second"),
    [
        ("Ayesha", "Aisha"),
        ("Aysha", "Ayesha"),
        ("Priya", "Pria"),
        ("Khan", "Kahn"),
        ("Bhavna", "Bavna"),
        ("Philip", "Filip"),
        ("Xavier", "Savier"),
        ("Rahul", "Rahool"),
    ],
)
def test_phonetic_key_collapses_common_transliterations(first: str, second: str):
    assert phonetic_key(first) == phonetic_key(second) != ""


@pytest.mark.parametrize(
    ("first", "second"),
    [("Priya", "Preeti"), ("Ayesha", "Rahul"), ("Sharma", "Verma"), ("Nick", "Nina")],
)
def test_phonetic_key_separates_different_names(first: str, second: str):
    assert phonetic_key(first) != phonetic_key(second)


def test_phonetic_key_edge_cases():
    assert phonetic_key("") == ""
    assert phonetic_key("!!") == ""
    assert phonetic_key("Knight") == phonetic_key("Night")
    assert phonetic_key("Nick") == "NK"
    assert phonetic_key("Ghosh") == phonetic_key("Gosh")


def test_jaro_winkler_reference_values():
    assert jaro_winkler("martha", "marhta") == pytest.approx(0.9611, abs=1e-4)
    assert jaro_winkler("dixon", "dicksonx") == pytest.approx(0.8133, abs=1e-4)
    assert jaro_winkler("same", "same") == 1.0
    assert jaro_winkler("", "x") == 0.0
    assert jaro_winkler("abc", "xyz") == 0.0
    assert jaro_winkler("aysha", "ayesha") >= JARO_WINKLER_THRESHOLD
