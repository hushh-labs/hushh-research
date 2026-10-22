"""Synthetic ordering checks for V1 request content evaluation."""

import pytest

from hushh_mcp.services.drive_request_package_store import _metadata_priority

MEETING_PLAN = {
    "terms": ["meeting", "notes"],
    "term_groups": [["meeting", "standup", "sync", "huddle"], ["notes", "minutes"]],
    "semantic_intent": "other",
    "expected_document_anatomy": "Dated meeting notes with attendees, discussion or decisions.",
}
MEETING_PURPOSE = {
    "purpose": "3 months of meeting notes",
    "periodStart": "2026-07-16",
    "periodEnd": "2026-10-16",
}


@pytest.mark.parametrize(
    "title",
    ["Team Sync and Standup", "Weekly huddle", "Stand-up decisions"],
)
def test_meeting_title_alias_ranks_ahead_of_generic_year_note(title):
    alias = _metadata_priority({"name": title}, plan=MEETING_PLAN, purpose=MEETING_PURPOSE)
    generic = _metadata_priority({"name": "Notes 2026"}, plan=MEETING_PLAN, purpose=MEETING_PURPOSE)
    assert alias > generic


def test_meeting_priority_only_reorders_candidates():
    candidates = ["Notes 2026", "Untitled", "Team Sync and Standup"]
    ranked = sorted(
        enumerate(candidates),
        key=lambda item: (
            -_metadata_priority({"name": item[1]}, plan=MEETING_PLAN, purpose=MEETING_PURPOSE),
            item[0],
        ),
    )
    assert [name for _, name in ranked] == ["Team Sync and Standup", "Notes 2026", "Untitled"]
    assert sorted(name for _, name in ranked) == sorted(candidates)


def test_meeting_title_hint_does_not_change_financial_priority():
    financial_plan = {
        "terms": ["statement"],
        "required_entities": ["Schwab"],
        "semantic_intent": "institutional_statement",
    }
    financial_purpose = {**MEETING_PURPOSE, "purpose": "Schwab meeting notes"}
    title = {"name": "Team Sync and Standup"}
    assert _metadata_priority(title, plan=financial_plan, purpose=financial_purpose) == 0
