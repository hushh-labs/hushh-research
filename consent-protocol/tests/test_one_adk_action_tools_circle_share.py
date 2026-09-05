"""Unit coverage for the Circle fallback in backend-direct recipient resolution.

Saying "share my location with Family" used to fail outright: the person-only
resolver (resolve_spoken_names) never tried the user's Circles, and the
Circle-only resolver (match_circle_by_name) never expanded a match into
recipients. _expand_unresolved_via_circles is the seam that lets a name still
unresolved after person-matching try Circles next, without ever offering a
Circle member the person-search pool itself would not already have offered.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.one_adk.action_tools import _expand_unresolved_via_circles
from hushh_mcp.services.spoken_name_resolver import UnresolvedPersonName


class _FakeCircleService:
    def __init__(self, circles: list[dict[str, Any]], members_by_circle: dict[str, list[dict[str, Any]]]):
        self._circles = circles
        self._members_by_circle = members_by_circle

    def list_circles(self, *, user_id: str) -> list[dict[str, Any]]:
        return self._circles

    def get_circle(self, *, user_id: str, circle_id: str) -> dict[str, Any]:
        return {"id": circle_id, "members": self._members_by_circle.get(circle_id, [])}


def _not_found(spoken: str) -> UnresolvedPersonName[Any]:
    return UnresolvedPersonName(spoken_text=spoken, kind="not_found")


def _ambiguous(spoken: str) -> UnresolvedPersonName[Any]:
    return UnresolvedPersonName(spoken_text=spoken, kind="ambiguous", matches=[{"userId": "x"}])


def test_a_circle_name_expands_to_its_members_in_the_recipient_pool():
    circles = [{"id": "circle-1", "name": "Family"}]
    members = {"circle-1": [{"userId": "alice"}, {"userId": "bob"}]}
    circle_service = _FakeCircleService(circles, members)
    candidates = [
        {"userId": "alice", "displayName": "Alice"},
        {"userId": "bob", "displayName": "Bob"},
        {"userId": "carol", "displayName": "Carol"},
    ]

    expanded, still_unresolved = _expand_unresolved_via_circles(
        [_not_found("Family")], candidates, circle_service, "owner"
    )

    assert {c["userId"] for c in expanded} == {"alice", "bob"}
    assert still_unresolved == []


def test_a_circle_match_never_offers_a_member_outside_the_recipient_pool():
    # The Circle's own roster can include someone who is not (or no longer) an
    # eligible recipient -- list_verified_recipients is the sole authority on
    # who this owner may share with; the Circle only supplies which of those
    # already-eligible people are the ones meant by the spoken name.
    circles = [{"id": "circle-1", "name": "Family"}]
    members = {"circle-1": [{"userId": "alice"}, {"userId": "not-eligible"}]}
    circle_service = _FakeCircleService(circles, members)
    candidates = [{"userId": "alice", "displayName": "Alice"}]

    expanded, still_unresolved = _expand_unresolved_via_circles(
        [_not_found("Family")], candidates, circle_service, "owner"
    )

    assert [c["userId"] for c in expanded] == ["alice"]
    assert "not-eligible" not in {c["userId"] for c in expanded}
    assert still_unresolved == []


def test_a_circle_with_no_eligible_members_stays_unresolved_not_an_error():
    circles = [{"id": "circle-1", "name": "Family"}]
    members = {"circle-1": [{"userId": "not-eligible"}]}
    circle_service = _FakeCircleService(circles, members)
    candidates = [{"userId": "alice", "displayName": "Alice"}]

    expanded, still_unresolved = _expand_unresolved_via_circles(
        [_not_found("Family")], candidates, circle_service, "owner"
    )

    assert expanded == []
    assert [entry.spoken_text for entry in still_unresolved] == ["Family"]


def test_a_name_matching_no_circle_and_no_person_stays_unresolved():
    circle_service = _FakeCircleService([{"id": "circle-1", "name": "Family"}], {})
    candidates = [{"userId": "alice", "displayName": "Alice"}]

    expanded, still_unresolved = _expand_unresolved_via_circles(
        [_not_found("Nobody")], candidates, circle_service, "owner"
    )

    assert expanded == []
    assert [entry.spoken_text for entry in still_unresolved] == ["Nobody"]


def test_an_ambiguous_person_entry_is_left_untouched():
    # Ambiguity between two people is a real name collision -- retrying it
    # against Circles would not resolve it, so it passes through unexamined.
    circle_service = _FakeCircleService([{"id": "circle-1", "name": "Family"}], {})
    candidates: list[dict[str, Any]] = []
    entry = _ambiguous("Sam")

    expanded, still_unresolved = _expand_unresolved_via_circles(
        [entry], candidates, circle_service, "owner"
    )

    assert expanded == []
    assert still_unresolved == [entry]


def test_two_spoken_names_can_mix_a_circle_and_a_still_missing_person():
    circles = [{"id": "circle-1", "name": "Family"}]
    members = {"circle-1": [{"userId": "alice"}]}
    circle_service = _FakeCircleService(circles, members)
    candidates = [{"userId": "alice", "displayName": "Alice"}]

    expanded, still_unresolved = _expand_unresolved_via_circles(
        [_not_found("Family"), _not_found("Ghost")], candidates, circle_service, "owner"
    )

    assert [c["userId"] for c in expanded] == ["alice"]
    assert [entry.spoken_text for entry in still_unresolved] == ["Ghost"]
