"""Narrow owner-only file listing never asks a model or assumes content coverage."""

from datetime import UTC, date, datetime

import pytest

from hushh_mcp.services.drive_long_range_listing import (
    LongRangeListing,
    filter_long_range_matches,
    parse_long_range_listing,
)

NOW = datetime(2026, 9, 26, 2, 0, tzinfo=UTC)


def match(name, *, created="2026-09-20T10:00:00Z", modified="2026-09-20T10:00:00Z"):
    return {
        "file_id": name,
        "name": name,
        "mime_type": "application/vnd.google-apps.document",
        "created_time": created,
        "modified_time": modified,
        "open_url": "https://drive.google.com/drive/u/0/my-drive",
    }


def test_exact_uat_and_generic_named_file_requests_are_bounded():
    standup = parse_long_range_listing(
        "share me all my last 30 days standup sync notes i need all 30"
    )
    assert standup == LongRangeListing(
        relative_days=30,
        anchor="standup",
        title_terms=("standup", "sync"),
        requested_count=30,
    )
    assert standup.window(now_utc=NOW, timezone="Asia/Kolkata") == (
        date(2026, 8, 27),
        date(2026, 9, 25),
    )
    assert "2026-08-27 through 2026-09-25" in standup.window_description(
        now_utc=NOW, timezone="Asia/Kolkata"
    )
    assert "Completed local calendar days" in standup.window_description(
        now_utc=NOW, timezone="Asia/Kolkata"
    )

    generic = parse_long_range_listing("show me all my last 25 days tax receipts")
    assert generic == LongRangeListing(
        relative_days=25,
        anchor="tax",
        title_terms=("tax", "receipts"),
    )
    assert (
        parse_long_range_listing(
            "share me all my last 30 days standup sync notes i need all 30 / check my drive"
        )
        == standup
    )
    assert parse_long_range_listing(
        "show me all standup sync notes from the last 25 days"
    ) == LongRangeListing(relative_days=25, anchor="standup", title_terms=("standup", "sync"))
    assert parse_long_range_listing(
        "find all my standup notes for the past 30 days"
    ) == LongRangeListing(relative_days=30, anchor="standup", title_terms=("standup",))
    assert parse_long_range_listing("show my last 25 days standup notes") == LongRangeListing(
        relative_days=25, anchor="standup", title_terms=("standup",)
    )


@pytest.mark.parametrize(
    "message",
    [
        "share me all my last 30 days files",
        "share me all my last 30 days notes",
        "share me last 30 days standup sync notes",
        "share me all my last 30 days standup sync notes and summarize them",
        "share me all my last 30 days standup sync notes i need all 25",
        "share me all my last 32 days tax receipts",
        "share me all my last 30 days what is in tax receipts",
        "share me all my latest tax receipts",
    ],
)
def test_ambiguous_or_content_requests_do_not_use_listing(message):
    assert parse_long_range_listing(message) is None


def test_prior_window_accepts_clear_phrase_and_exact_uat_wording():
    canonical = parse_long_range_listing(
        "share me all my standup sync notes from the 30 days before the last 30 days"
    )
    uat = parse_long_range_listing(
        "share me all my last to last 30 days standup sync notes not recent last 30 "
        "its like 30 before then 30 i need all 30 check my drive"
    )
    assert canonical is not None
    assert uat is not None
    assert canonical.offset_days == uat.offset_days == 30
    assert canonical.window(now_utc=NOW, timezone="Asia/Kolkata") == (
        date(2026, 7, 28),
        date(2026, 8, 26),
    )
    assert (
        parse_long_range_listing(
            "share me all my last to last 30 days standup sync notes not recent last 25 "
            "its like 30 before then 30 i need all 30 check my drive"
        )
        is None
    )


def test_filter_prefers_title_day_and_preserves_stable_order_for_ties():
    spec = parse_long_range_listing("share me all my last 30 days standup sync notes")
    assert spec is not None
    matches = [
        match("Standup Sync Notes - 2026/09/01", created="2026-01-01T00:00:00Z"),
        match("Standup Notes - 2026-08-01"),  # fresh edit cannot override title
        match("Standup Sync - 2026/09/20", created="2026-01-01T00:00:00Z"),
        match("Stand-up Sync - 2026/09/20", created="2026-01-01T00:00:00Z"),
        match("Standup Notes", created="2026-08-27T20:00:00Z"),  # missing sync
        match("Standup Sync Notes", created="2026-08-26T20:00:00Z"),
        match("Standup Syncing Notes - 2026/09/20"),  # sync is not a whole word
        match("Tax Receipts - 2026/09/20"),
        match("Standup Sync - 2026/02/30"),
        match("Standup Sync - 2026/09/19 - 2026/09/20"),
        {
            **match("Standup Sync folder - 2026/09/20"),
            "mime_type": "application/vnd.google-apps.folder",
        },
    ]
    found = filter_long_range_matches(spec, matches, now_utc=NOW, timezone="Asia/Kolkata")
    assert [(row["name"], row["listing_day"]) for row in found] == [
        ("Standup Sync - 2026/09/20", "2026-09-20"),
        ("Stand-up Sync - 2026/09/20", "2026-09-20"),
        ("Standup Sync Notes - 2026/09/01", "2026-09-01"),
        ("Standup Sync Notes", "2026-08-27"),
    ]
    assert "listing_day" not in matches[0]


def test_prior_window_uses_title_date_before_metadata_date():
    spec = parse_long_range_listing(
        "list all my tax receipts from the 30 days before the latest 30 days"
    )
    assert spec is not None
    found = filter_long_range_matches(
        spec,
        [
            match("Tax receipt - 2026/08/26"),
            match("Tax receipt - 2026/08/27", created="2026-08-26T00:00:00Z"),
            match("Tax receipt - 2026/07/28", created="2026-09-20T00:00:00Z"),
            match("Tax return - 2026/08/20"),  # receipt term is required
            match("Taxation receipts - 2026/08/20"),  # tax is a whole word
        ],
        now_utc=NOW,
        timezone="Asia/Kolkata",
    )
    assert [row["listing_day"] for row in found] == ["2026-08-26", "2026-07-28"]


def test_one_distinctive_term_still_matches_stand_up_spelling():
    spec = parse_long_range_listing("show my last 25 days standup notes")
    assert spec is not None
    assert parse_long_range_listing("show my last 25 days stand-up notes") == spec
    found = filter_long_range_matches(
        spec,
        [match("Stand-up Notes - 2026/09/18"), match("Standup Notes - 2026/09/19")],
        now_utc=NOW,
        timezone="Asia/Kolkata",
    )
    assert [row["listing_day"] for row in found] == ["2026-09-19", "2026-09-18"]


def test_singular_subject_accepts_plural_title_with_word_boundaries():
    spec = parse_long_range_listing("show me all my last 25 days tax receipt")
    assert spec is not None
    found = filter_long_range_matches(
        spec,
        [
            match("Tax Receipts - 2026/09/18"),
            match("Taxation Receipts - 2026/09/18"),
            match("Tax Receiptbook - 2026/09/18"),
        ],
        now_utc=NOW,
        timezone="Asia/Kolkata",
    )
    assert [row["name"] for row in found] == ["Tax Receipts - 2026/09/18"]
