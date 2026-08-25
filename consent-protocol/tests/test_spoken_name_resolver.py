"""Parity tests for spoken_name_resolver.py against the TypeScript original.

Every case here mirrors one in
hushh-webapp/__tests__/lib/one-location/resolve-spoken-names.test.ts by
name, so a future change to either side that breaks parity fails on both.
"""

from __future__ import annotations

from hushh_mcp.services.spoken_name_resolver import (
    join_names_for_speech,
    match_by_name,
    match_circle_by_name,
    normalize_spoken_name,
    resolve_by_spoken_name,
    resolve_spoken_names,
    split_spoken_names,
)


def _person(id_: str, name: str) -> dict:
    return {"id": id_, "name": name}


def _by_name(item: dict) -> str:
    return item["name"]


class TestResolveSpokenNames:
    def test_resolves_a_clean_substring_match(self):
        candidates = [_person("1", "Sarah Chen"), _person("2", "Priya Singh")]
        result = resolve_spoken_names(candidates, "Sarah", _by_name)
        assert [r["id"] for r in result.resolved] == ["1"]
        assert result.unresolved == []

    def test_prefers_exact_substring_over_fuzzy(self):
        # "Ankit" is an exact substring hit on candidate 1; fuzzy must never
        # run once substring already found something, so candidate 2
        # ("Ankeet") is never even considered here.
        candidates = [_person("1", "Ankit Kumar"), _person("2", "Ankeet Rao")]
        result = resolve_spoken_names(candidates, "Ankit", _by_name)
        assert [r["id"] for r in result.resolved] == ["1"]

    def test_fuzzy_matches_one_letter_off_mishearing(self):
        candidates = [_person("1", "Neelesh Hushh - 1")]
        result = resolve_spoken_names(candidates, "Nilesh", _by_name)
        assert [r["id"] for r in result.resolved] == ["1"]
        assert result.unresolved == []

    def test_fuzzy_matches_insertion_style_mishearing(self):
        candidates = [_person("1", "Ankit Kumar")]
        result = resolve_spoken_names(candidates, "Ankeet", _by_name)
        assert [r["id"] for r in result.resolved] == ["1"]

    def test_reports_ambiguous_not_a_guess(self):
        candidates = [_person("1", "Ankit Kumar"), _person("2", "Ankeet Rao")]
        result = resolve_spoken_names(candidates, "Anket", _by_name)
        assert result.resolved == []
        assert len(result.unresolved) == 1
        assert result.unresolved[0].kind == "ambiguous"
        assert result.unresolved[0].spoken_text == "Anket"
        matched_ids = {m["id"] for m in result.unresolved[0].matches}
        assert matched_ids == {"1", "2"}

    def test_never_fuzzy_matches_short_names(self):
        candidates = [_person("1", "Amy Chen"), _person("2", "Ivy Park")]
        result = resolve_spoken_names(candidates, "Amy", _by_name)
        assert [r["id"] for r in result.resolved] == ["1"]

        no_match = resolve_spoken_names(candidates, "Emy", _by_name)
        assert no_match.resolved == []
        assert len(no_match.unresolved) == 1
        assert no_match.unresolved[0].kind == "not_found"
        assert no_match.unresolved[0].spoken_text == "Emy"

    def test_stays_not_found_when_nothing_close(self):
        candidates = [_person("1", "Sarah Chen"), _person("2", "Priya Singh")]
        result = resolve_spoken_names(candidates, "Zachary", _by_name)
        assert result.resolved == []
        assert len(result.unresolved) == 1
        assert result.unresolved[0].kind == "not_found"

    def test_applies_fuzzy_independently_per_name_in_multi_person_turn(self):
        candidates = [_person("1", "Neelesh Hushh - 1"), _person("2", "Priya Singh")]
        result = resolve_spoken_names(candidates, "Nilesh and Priya", _by_name)
        assert sorted(r["id"] for r in result.resolved) == ["1", "2"]
        assert result.unresolved == []


class TestSplitSpokenNames:
    def test_single_element_with_no_delimiter(self):
        assert split_spoken_names("Sarah") == ["Sarah"]

    def test_splits_on_comma_ampersand_semicolon_and_word_and(self):
        assert split_spoken_names("Alice, Bob & Carol; Dana and Erin") == [
            "Alice",
            "Bob",
            "Carol",
            "Dana",
            "Erin",
        ]


class TestNormalizeSpokenName:
    def test_strips_case_accents_and_punctuation(self):
        assert normalize_spoken_name("Renée O'Brien") == "renee o brien"


class TestJoinNamesForSpeech:
    def test_joins_without_oxford_comma(self):
        assert join_names_for_speech(["Alice", "Bob", "Sarah"]) == "Alice, Bob and Sarah"
        assert join_names_for_speech(["Alice", "Bob"]) == "Alice and Bob"
        assert join_names_for_speech(["Alice"]) == "Alice"


class TestMatchCircleByName:
    def _circle(self, name: str) -> dict:
        return {"name": name}

    def test_exact_match_wins_over_substring(self):
        circles = [self._circle("Family"), self._circle("Family Trip")]
        result = match_circle_by_name(circles, "family", lambda c: c["name"])
        assert result.match == {"name": "Family"}
        assert result.ambiguous == []

    def test_ambiguous_when_multiple_tie_at_the_same_tier(self):
        circles = [self._circle("Family Trip"), self._circle("Family Reunion")]
        result = match_circle_by_name(circles, "family", lambda c: c["name"])
        assert result.match is None
        assert len(result.ambiguous) == 2

    def test_no_match_returns_none(self):
        circles = [self._circle("Family")]
        result = match_circle_by_name(circles, "friends", lambda c: c["name"])
        assert result.match is None
        assert result.ambiguous == []


class TestResolveBySpokenName:
    """Mirrors resolve-by-spoken-name.test.ts case for case."""

    SARAH_CHEN = _person("1", "Sarah Chen")
    SARAH_LEE = _person("2", "Sarah Lee")
    ABDUL = _person("3", "Abdul Gaffar")
    PEOPLE = [SARAH_CHEN, SARAH_LEE, ABDUL]

    def test_matches_a_single_person_by_a_substring_of_their_name(self):
        result = resolve_by_spoken_name([self.SARAH_CHEN, self.ABDUL], "sarah", _by_name)
        assert result.kind == "one"
        assert result.match == self.SARAH_CHEN

    def test_is_case_insensitive(self):
        result = resolve_by_spoken_name([self.SARAH_CHEN], "SARAH CHEN", _by_name)
        assert result.kind == "one"
        assert result.match == self.SARAH_CHEN

    def test_never_guesses_between_two_or_more_matches(self):
        result = resolve_by_spoken_name(self.PEOPLE, "sarah", _by_name)
        assert result.kind == "many"
        assert result.matches == [self.SARAH_CHEN, self.SARAH_LEE]

    def test_returns_none_when_nobody_matches(self):
        assert resolve_by_spoken_name(self.PEOPLE, "nobody", _by_name).kind == "none"

    def test_returns_none_for_an_empty_or_whitespace_only_spoken_name(self):
        assert resolve_by_spoken_name(self.PEOPLE, "", _by_name).kind == "none"
        assert resolve_by_spoken_name(self.PEOPLE, "   ", _by_name).kind == "none"

    def test_treats_a_missing_display_name_as_unmatchable_rather_than_raising(self):
        nameless = _person("4", "")
        result = resolve_by_spoken_name([nameless], "anything", lambda _p: None)
        assert result.kind == "none"

    def test_matches_against_a_separate_search_text_but_still_returns_the_real_item(self):
        sarah = {"id": "1", "name": "Sarah Chen", "phone": "***1234"}
        result = resolve_by_spoken_name(
            [sarah],
            "1234",
            lambda c: c["name"],
            lambda c: f"{c['name']} {c['phone']}",
        )
        assert result.kind == "one"
        assert result.match == sarah

    def test_defaults_search_text_to_display_name_when_none_is_given(self):
        result = resolve_by_spoken_name([self.SARAH_CHEN], "chen", _by_name)
        assert result.kind == "one"
        assert result.match == self.SARAH_CHEN


class TestMatchByName:
    """Mirrors the local matchByName() in app/connect/page-client.tsx."""

    def test_exact_match_wins_over_substring(self):
        rows = [_person("1", "Sarah"), _person("2", "Sarah Chen")]
        result = match_by_name(rows, "sarah", _by_name)
        assert result == [rows[0]]

    def test_word_boundary_tier_matches_a_leading_word(self):
        rows = [_person("1", "Abdul Rashid")]
        result = match_by_name(rows, "abdul", _by_name)
        assert result == rows

    def test_word_boundary_tier_does_not_match_a_trailing_word(self):
        # Unlike match_circle_by_name, matchByName's word-boundary tier has no
        # endswith check -- so a trailing-only word falls through to the final
        # word-alignment tier instead (which still finds it via prefix match).
        rows = [_person("1", "Kumar Rashid")]
        result = match_by_name(rows, "rashid", _by_name)
        assert result == rows

    def test_word_alignment_tier_matches_an_initial_against_a_full_name(self):
        rows = [_person("1", "Abdul Kumar Rashid")]
        result = match_by_name(rows, "r", _by_name)
        assert result == rows

    def test_word_alignment_tier_matches_a_short_name_against_an_abbreviation(self):
        rows = [_person("1", "Abdul R.")]
        result = match_by_name(rows, "Abdul Rashid", _by_name)
        assert result == rows

    def test_ambiguous_when_multiple_tie_at_the_same_tier(self):
        rows = [_person("1", "Sarah Chen"), _person("2", "Sarah Lee")]
        result = match_by_name(rows, "sarah", _by_name)
        assert result == rows

    def test_no_match_returns_empty(self):
        rows = [_person("1", "Sarah Chen")]
        assert match_by_name(rows, "nobody", _by_name) == []

    def test_empty_spoken_name_returns_empty(self):
        rows = [_person("1", "Sarah Chen")]
        assert match_by_name(rows, "", _by_name) == []
