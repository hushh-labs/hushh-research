"""Gear 1 owner Drive name index: synthetic Drive metadata only, no content, no model.

The fake sits behind the real fenced REST transport, so every listed row passes
through the same owner, grant and projection checks as production.
"""

# ruff: noqa: S311 -- seeded synthetic fixtures, never secrets or tokens

from __future__ import annotations

import asyncio
import logging
import random
import re
import subprocess
import sys
import time
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import drive_content_dates as content_dates
from hushh_mcp.services import drive_owner_metadata_index as gear1
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_owner_search_service import _in_requested_period
from hushh_mcp.services.drive_title_dates import (
    PeriodDecision,
    in_requested_period,
    parse_title_dates,
    period_decision,
)
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH, DriveReadError

OWNER = "owner-synthetic"
SEPTEMBER_IST = {"start": "2026-09-01", "end": "2026-09-30", "timezone": "Asia/Kolkata"}


def file_id(prefix: str, index: int) -> str:
    return f"{prefix}{index:07d}AbCdEfGhIjKlMnOpQr"


def rest_row(
    identity, name, *, created="2026-09-10T08:00:00.000Z", mime="application/pdf", **extra
):
    return {
        "id": identity,
        "name": name,
        "mimeType": mime,
        "createdTime": created,
        "modifiedTime": created,
        "webViewLink": f"https://drive.google.com/file/d/{identity}/view",
        "capabilities": {"canShare": True},
        **extra,
    }


class FakeDriveAdapter:
    """files.list and drives.list for one synthetic owner, newest created first."""

    def __init__(self, user_rows, drives=None, *, too_large_at=None):
        self.user = sorted(user_rows, key=lambda row: row["createdTime"], reverse=True)
        self.drives = {
            drive: sorted(rows, key=lambda row: row["createdTime"], reverse=True)
            for drive, rows in (drives or {}).items()
        }
        self.too_large_at = too_large_at
        self.calls = []
        self.changes = []

    async def list_files(
        self,
        *,
        access_token,
        query,
        page_size,
        page_token=None,
        order_by=None,
        owner_search_page=False,
        drive_id=None,
        resource_keys=None,
    ):
        self.calls.append(("files", drive_id, page_size, page_token, order_by, owner_search_page))
        # Exactly the fenced listing shape: no fullText, no caller fields.
        assert query == "(trashed = false) and trashed = false"
        assert order_by == "createdTime desc"
        corpus = self.drives[drive_id] if drive_id else self.user
        if self.too_large_at == (drive_id, page_token) and page_size == 1000:
            raise DriveReadError("file_too_large")
        # Keyset cursor: resume after the last row returned, wherever it is now.
        start = 0 if page_token is None else [row["id"] for row in corpus].index(page_token) + 1
        visible = [row for row in corpus[start:] if not row.get("trashed")]
        page = visible[:page_size]
        return {
            "files": [
                {key: value for key, value in row.items() if key != "trashed"} for row in page
            ],
            "nextPageToken": page[-1]["id"] if len(visible) > page_size else None,
            "incompleteSearch": False,
        }

    async def collection_start_token(self, *, access_token):
        self.calls.append(("start", None, None, None, None, False))
        return f"cursor-{len(self.changes)}"

    async def index_changes(self, *, access_token, page_token, page_size=200):
        self.calls.append(("changes", None, page_size, page_token, None, False))
        start = int(page_token.removeprefix("cursor-"))
        batch = self.changes[start : start + page_size]
        end = start + len(batch)
        cursor = f"cursor-{end}"
        more = end < len(self.changes)
        return {
            "changes": batch,
            **({"nextPageToken": cursor} if more else {"newStartPageToken": cursor}),
        }

    async def list_drives(self, *, access_token, page_size=25, page_token=None):
        self.calls.append(("drives", None, page_size, page_token, None, False))
        identities = list(self.drives)
        start = int(page_token or 0)
        end = start + page_size
        return {
            "drives": [{"id": drive, "name": "Synthetic"} for drive in identities[start:end]],
            "nextPageToken": str(end) if end < len(identities) else None,
        }


def transport_for(adapter, monkeypatch):
    monkeypatch.setattr(rest, "connector_feature_enabled", lambda *_: True)
    current = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 7,
    }
    oauth = SimpleNamespace(
        current_credential=AsyncMock(return_value=(current, {"accessToken": "synthetic-grant"})),
        lifecycle=SimpleNamespace(read=AsyncMock(return_value=current)),
    )
    return rest.GoogleDriveRestTransport(oauth=oauth, adapter=adapter)


def large_drive():
    """40,000 files: 36,000 user rows (trashed, folders, shortcuts) + 2 shared drives."""
    rng = random.Random(11)
    words = ["budget", "roadmap", "design", "contract", "summary", "agenda", "review", "draft"]
    user = []
    for index in range(36_000):
        created = f"2026-0{1 + index % 9}-{1 + index % 28:02d}T{index % 24:02d}:00:00.000Z"
        name = "_".join(rng.choice(words).capitalize() for _ in range(3))
        user.append(rest_row(file_id("u", index), name, created=created))
    user[5] = rest_row(file_id("u", 5), "Schwab_BankStatement_20260914.pdf")
    user[6] = rest_row(file_id("u", 6), "Zebra invoice.pdf", trashed=True)
    user[7] = rest_row(file_id("u", 7), "Board Packets", mime="application/vnd.google-apps.folder")
    user[8] = rest_row(
        file_id("u", 8),
        "Shortcut to quarterly forecast",
        mime="application/vnd.google-apps.shortcut",
        shortcutDetails={"targetId": file_id("d", 1), "targetMimeType": "application/pdf"},
    )
    for index in range(9, 309):
        user[index] = rest_row(file_id("u", index), f"Trashed draft {index}", trashed=True)
    shared = {
        file_id("D", drive): [
            rest_row(file_id(f"s{drive}", index), f"Team roadmap {index}") for index in range(2_000)
        ]
        for drive in range(2)
    }
    shared[file_id("D", 0)][0] = rest_row(file_id("d", 1), "Quarterly Forecast FY26.xlsx")
    # A shared-drive file the user corpus also returns is one file.
    shared[file_id("D", 1)][0] = user[10] = rest_row(file_id("u", 10), "Vendor Contract Final")
    return user, shared


async def test_index_lists_every_corpus_in_bounded_resumable_slices(monkeypatch):
    user, shared = large_drive()
    adapter = FakeDriveAdapter(user, shared)
    indexer = gear1.OwnerMetadataIndexer(transport_for(adapter, monkeypatch))

    first = await indexer.refresh(OWNER, connection_generation=7, max_pages=10)
    assert (first.ready, first.indexed, first.pages) == (False, 10_000, 10)
    # Early pages already answer requests while the rest of Drive lists.
    early = await indexer.match(
        OWNER, ["bank statement"], None, connection_generation=7, max_pages=0
    )
    assert [c.file["title"] for c in early.candidates] == ["Schwab_BankStatement_20260914.pdf"]
    assert early.ready is False and early.complete is False

    for _ in range(10):
        status = await indexer.refresh(OWNER, connection_generation=7, max_pages=10)
        if status.ready:
            break
    trashed = sum(1 for row in user if row.get("trashed"))
    assert status.ready and status.complete
    assert status.indexed == 36_000 - trashed + 2 * 2_000 - 1
    file_calls = [call for call in adapter.calls if call[0] == "files"]
    assert len(file_calls) == 36 + 2 * 2  # 1,000-row pages; nothing listed twice
    assert {call[2] for call in file_calls} == {1000}
    assert {call[1] for call in file_calls} == {None, file_id("D", 0), file_id("D", 1)}
    assert all(call[5] is True for call in file_calls)

    found = await indexer.match(OWNER, ["forecast"], None, connection_generation=7, max_pages=0)
    by_title = {c.file["title"]: c.file for c in found.candidates}
    assert set(by_title) == {"Shortcut to quarterly forecast", "Quarterly Forecast FY26.xlsx"}
    assert by_title["Shortcut to quarterly forecast"]["shortcutDetails"]["targetId"] == file_id(
        "d", 1
    )
    assert by_title["Quarterly Forecast FY26.xlsx"]["capabilities"] == {"canShare": True}
    # Negative control: trashed names are never indexed.
    assert (await indexer.match(OWNER, ["zebra"], None, connection_generation=7)).candidates == ()
    assert "trashed" not in await indexer.vocabulary(OWNER, connection_generation=7)


async def test_candidates_are_the_exact_owner_search_rows(monkeypatch):
    rows = [rest_row(file_id("u", index), f"Lease agreement {index}") for index in range(30)]
    rows.append(
        rest_row(
            file_id("u", 99),
            "Lease shortcut",
            mime="application/vnd.google-apps.shortcut",
            driveId=file_id("D", 3),
            resourceKey="key-1",
            shortcutDetails={"targetId": file_id("u", 1), "targetMimeType": "application/pdf"},
        )
    )
    transport = transport_for(FakeDriveAdapter(rows), monkeypatch)
    direct = await transport.read_owner_search_page(
        user_id=OWNER,
        tool_name="search_files",
        arguments={"query": gear1.LISTING_QUERY, "orderBy": gear1.LISTING_ORDER, "pageSize": 1000},
    )
    result = await gear1.match_owner_files(
        OWNER,
        ["lease"],
        None,
        connection_generation=7,
        indexer=gear1.OwnerMetadataIndexer(transport),
    )
    assert result.complete
    assert sorted((c.file for c in result.candidates), key=lambda f: f["id"]) == sorted(
        direct.payload["files"], key=lambda f: f["id"]
    )


async def test_an_oversized_page_retries_the_same_cursor_smaller(monkeypatch):
    rows = [rest_row(file_id("u", index), f"Receipt {index}") for index in range(2_500)]
    adapter = FakeDriveAdapter(rows, too_large_at=(None, None))
    indexer = gear1.OwnerMetadataIndexer(transport_for(adapter, monkeypatch))
    status = await indexer.refresh(OWNER, connection_generation=7, max_pages=100)
    assert status.ready and status.indexed == 2_500
    sizes = [(call[2], call[3]) for call in adapter.calls if call[0] == "files"]
    assert sizes[:2] == [(1000, None), (100, None)]
    assert {size for size, _ in sizes[1:]} == {100}


async def test_a_new_connection_or_an_old_snapshot_starts_over(monkeypatch):
    rows = [rest_row(file_id("u", 1), "Payroll register")]
    now = [1000.0]
    adapter = FakeDriveAdapter(rows)
    indexer = gear1.OwnerMetadataIndexer(
        transport_for(adapter, monkeypatch), ttl_seconds=60, clock=lambda: now[0]
    )
    assert (await indexer.refresh(OWNER, connection_generation=7)).ready
    calls = len(adapter.calls)
    # Same generation, fresh snapshot: nothing is listed again.
    assert (await indexer.refresh(OWNER, connection_generation=7)).ready
    assert len(adapter.calls) == calls
    # Another connection generation never sees names listed under the old one.
    stale = await indexer.match(OWNER, ["payroll"], None, connection_generation=8, max_pages=0)
    assert stale.candidates == () and stale.ready is False
    assert (await indexer.refresh(OWNER, connection_generation=8)).ready
    now[0] += 61
    expired = await indexer.match(OWNER, ["payroll"], None, connection_generation=8, max_pages=0)
    assert expired.candidates == () and expired.ready is False
    indexer.forget(OWNER)
    assert OWNER not in indexer._owners


async def test_a_failed_fence_check_keeps_the_last_good_page(monkeypatch):
    rows = [rest_row(file_id("u", index), f"Invoice {index}") for index in range(2_500)]
    checks = []

    async def require_current():
        checks.append(len(checks))
        if len(checks) == 6:
            raise DriveReadError("connection_changed")

    indexer = gear1.OwnerMetadataIndexer(transport_for(FakeDriveAdapter(rows), monkeypatch))
    with pytest.raises(DriveReadError, match="connection_changed"):
        await indexer.refresh(OWNER, connection_generation=7, require_current=require_current)
    # Around the change cursor, around the first page, then around the second:
    # the second page is refused after the provider answered and is not applied.
    status = await indexer.refresh(OWNER, connection_generation=7, max_pages=0)
    assert (status.indexed, status.pages, status.ready) == (1000, 1, False)


async def test_provider_trouble_serves_what_is_indexed_and_resumes(monkeypatch):
    rows = [rest_row(file_id("u", index), f"Receipt {index}") for index in range(2_500)]
    adapter = FakeDriveAdapter(rows)
    listing, failures = adapter.list_files, [1]

    async def flaky(**arguments):
        if arguments.get("page_token") is not None and failures[0]:
            failures[0] -= 1
            raise DriveReadError("provider_unavailable")
        return await listing(**arguments)

    adapter.list_files = flaky
    now = [0.0]
    indexer = gear1.OwnerMetadataIndexer(transport_for(adapter, monkeypatch), clock=lambda: now[0])
    partial = await indexer.match(OWNER, ["receipt"], None, connection_generation=7)
    assert (partial.ready, partial.error, partial.total_matches) == (
        False,
        "provider_unavailable",
        1000,
    )
    done = await indexer.match(OWNER, ["receipt"], None, connection_generation=7)
    assert done.ready and done.error is None and done.total_matches == 2_500

    # A change page that keeps failing is answered from the ready index, then
    # the next call lists Drive afresh instead of staying stale.
    async def broken(**_arguments):
        raise DriveReadError("provider_response_invalid")

    changes, adapter.index_changes = adapter.index_changes, broken
    for _ in range(gear1.MAX_DELTA_FAILURES):
        now[0] += gear1.DELTA_INTERVAL_SECONDS + 1
        served = await indexer.match(OWNER, ["receipt"], None, connection_generation=7)
        assert (served.total_matches, served.error) == (2_500, "provider_response_invalid")
    adapter.index_changes = changes
    assert (await indexer.refresh(OWNER, connection_generation=7, max_pages=0)).indexed == 0

    # A revoked grant is never treated as transient.
    async def revoked(**_arguments):
        raise DriveReadError("reconnect_required")

    adapter.list_files = revoked
    with pytest.raises(DriveReadError, match="reconnect_required"):
        await indexer.match(OWNER, ["receipt"], None, connection_generation=7)


def file_change(row=None, *, file_id_=None, removed=False):
    change = {"changeType": "file", "fileId": row["id"] if row else file_id_, "removed": removed}
    return {**change, "file": row} if row is not None else change


async def test_edits_during_and_after_listing_replay_from_the_cursor(monkeypatch):
    rows = [rest_row(file_id("u", index), f"Contract {index}") for index in range(1_500)]
    adapter = FakeDriveAdapter(rows)
    now = [0.0]
    indexer = gear1.OwnerMetadataIndexer(transport_for(adapter, monkeypatch), clock=lambda: now[0])
    assert not (await indexer.refresh(OWNER, connection_generation=7, max_pages=1)).ready
    # The cursor is captured before the first listing page.
    assert [call[0] for call in adapter.calls] == ["start", "files"]

    # While the listing is half done: one listed file is renamed, one trashed.
    renamed, trashed = adapter.user[0], adapter.user[1]
    adapter.user[0] = {**renamed, "name": "Lease renewal"}
    adapter.user[1] = {**trashed, "trashed": True}
    adapter.changes += [file_change(adapter.user[0]), file_change(adapter.user[1])]
    status = await indexer.refresh(OWNER, connection_generation=7)
    assert status.ready and status.indexed == 1_499

    async def titles(concept):
        result = await indexer.match(OWNER, [concept], None, connection_generation=7, max_pages=0)
        return {candidate.file["title"] for candidate in result.candidates}

    async def count(concept):
        result = await indexer.match(OWNER, [concept], None, connection_generation=7, max_pages=0)
        return result.total_matches

    assert await titles("lease") == {"Lease renewal"}
    assert await count("contract") == 1_498

    # Later: a new file, a removed file and a new shared drive membership.
    now[0] += gear1.DELTA_INTERVAL_SECONDS + 1
    adapter.drives[file_id("D", 9)] = [rest_row(file_id("s", 9), "Lease schedule")]
    adapter.changes += [
        file_change(rest_row(file_id("u", 5_000), "Lease addendum")),
        file_change(file_id_=adapter.user[2]["id"], removed=True),
        {"changeType": "drive", "removed": False},
    ]
    status = await indexer.refresh(OWNER, connection_generation=7)
    assert status.ready and status.complete
    assert await titles("lease") == {"Lease renewal", "Lease addendum", "Lease schedule"}
    assert await count("contract") == 1_497
    # A fresh delta is not requested again within the interval.
    calls = len(adapter.calls)
    await indexer.refresh(OWNER, connection_generation=7)
    assert len(adapter.calls) == calls


NAMES = [
    "Schwab_BankStatement_20260914.pdf",
    "MeetingNotes.pdf",
    "Meeting started 2026/09/02 23:42 IST - Notes by Gemini",
    "tax-return-2025-final.PDF",
    "Résumé Ankit.docx",
    "Q3Report.xlsx",
    "Quarterly roadmap",
    "Invoices September",
    "Statement 2025-09-14.pdf",
    "Weekly Standup Sept 14",
]


@pytest.mark.parametrize(
    ("concepts", "expected"),
    [
        (["statment"], {"Schwab_BankStatement_20260914.pdf", "Statement 2025-09-14.pdf"}),
        (["state"], {"Schwab_BankStatement_20260914.pdf", "Statement 2025-09-14.pdf"}),
        (["meeting notes"], {"MeetingNotes.pdf", NAMES[2]}),
        ([["minutes", "notes"], "gemini"], {NAMES[2]}),
        (["tax return"], {"tax-return-2025-final.PDF"}),
        (["resume"], {"Résumé Ankit.docx"}),
        (["q3", "report"], {"Q3Report.xlsx"}),
        (["invoice"], {"Invoices September"}),
        (["roadmp"], {"Quarterly roadmap"}),
        (["standups"], {"Weekly Standup Sept 14"}),
        (["schwab", "statement"], {"Schwab_BankStatement_20260914.pdf"}),
    ],
)
def test_name_matching_sees_through_spelling_and_compound_names(concepts, expected):
    index = gear1.build_index(rest_like(NAMES))
    candidates, total = index.match(concepts)
    assert {c.file["title"] for c in candidates} == expected
    assert total == len(expected)


@pytest.mark.parametrize(
    "concepts",
    [["2024"], ["zq"], ["payslip"], ["schwab", "invoice"], ["meeting", "resume"], ["of", "the"]],
)
def test_unrelated_words_years_and_unmatched_concepts_find_nothing(concepts):
    index = gear1.build_index(rest_like(NAMES))
    assert index.match(concepts) == ([], 0)


def test_exact_words_outrank_prefixes_and_typos():
    index = gear1.build_index(rest_like(["Statements 2026", "Statement", "Statementary notes"]))
    candidates, _ = index.match(["statement"])
    assert [c.file["title"] for c in candidates] == [
        "Statement",
        "Statements 2026",
        "Statementary notes",
    ]
    assert [c.matched for c in candidates] == [("exact",), ("plural",), ("prefix",)]


def rest_like(names, created="2026-09-15T12:00:00.000Z"):
    return [
        {
            "id": file_id("n", index),
            "title": name,
            "mimeType": "application/pdf",
            "modifiedTime": created,
            "createdTime": created,
            "viewUrl": None,
        }
        for index, name in enumerate(names)
    ]


@pytest.mark.parametrize(
    ("name", "created", "period", "expected"),
    [
        # Gemini meeting notes: 03:30 IST on 2 Sep is 22:00 UTC on 1 Sep.
        ("Meeting started 2026/09/02 03:30 IST - Notes by Gemini", None, "2026-09-01/UTC", True),
        ("Meeting started 2026/09/02 03:30 IST - Notes by Gemini", None, "2026-09-02/UTC", False),
        ("Weekly Standup Sept 14", "2026-09-15T00:00:00Z", "2026-09-14/UTC", True),
        ("Weekly Standup Sept 14", "2027-09-15T00:00:00Z", "2026-09-14/UTC", False),
        ("Notes 14-09-2026", "2026-12-01T00:00:00Z", "2026-09-14/UTC", True),
        ("Notes 09-14-2026", "2026-12-01T00:00:00Z", "2026-09-14/UTC", True),
        ("IMG_20260914_101500.jpg", "2026-12-01T00:00:00Z", "2026-09-14/UTC", True),
        # 03-04-2026 may be 3 April or 4 March: only a period holding both matches.
        ("Plan 03-04-2026", "2026-03-04T00:00:00Z", "2026-03-04/UTC", False),
        ("Plan 03-04-2026", None, "2026-03-01..2026-04-30/UTC", True),
        ("Statement September 2026", "2026-11-02T00:00:00Z", "2026-09-20..2026-10-09/UTC", True),
        ("Statement June 2026", "2026-09-25T00:00:00Z", "2026-09-20..2026-10-09/UTC", False),
        # Autoshare needs every title date inside: one outside keeps it out.
        (
            "Notes 2026-09-10 and 2026-06-16",
            "2026-09-10T00:00:00Z",
            "2026-09-01..2026-09-30/UTC",
            False,
        ),
        (
            "Notes 2026-09-10 and 2026-09-16",
            "2026-08-10T00:00:00Z",
            "2026-09-01..2026-09-30/UTC",
            True,
        ),
        # No title date: created time decides; a later edit never rescues it.
        ("Board deck", "2026-08-30T00:00:00Z", "2026-09-01..2026-09-30/UTC", False),
    ],
)
def test_title_dates_decide_the_period_before_file_times(name, created, period, expected):
    days, zone = period.split("/")
    start, _, end = days.partition("..")
    match = {"name": name, "created_time": created, "modified_time": "2026-09-15T00:00:00Z"}
    requested = {"start": start, "end": end or start, "timezone": zone}
    decision = period_decision(match, requested, precedence=True)
    assert decision.in_period is expected
    assert decision.basis == ("created" if name == "Board deck" else "title")


def test_new_title_rule_agrees_with_the_owner_search_rule_on_its_formats():
    rng = random.Random(3)
    names = [
        "Report 2026-09-14",
        "Meeting started 2026/09/02 23:42 IST - Notes by Gemini",
        "Sync 2026/09/30 22:15 UTC+05:30",
        "Sync 2026/09/30 23:59 GMT-0800",
        "Scan_2026_08_31",
        "Export 20260901",
        "Range 2026-08-28 to 2026-10-02",
        "Bad 2026-02-30",
        "Plain title",
        "Huddle 2026.09.15 08:00 IST",
    ]
    # The owner search rule reads these only for autoshare (precedence), where
    # every title date must be inside the period.
    autoshare_names = [
        "Notes 14-09-2026",
        "Notes 10-09-2026",
        "Notes 30/08/2026",
        "Meeting notes - Sep 15, 2026",
        "16 June 2026 meeting notes",
        "Notes 2026-09-10 and 2026-06-16",
        "Range 28-08-2026 to Oct 2, 2026",
    ]
    stamps = [None, "2026-08-31T20:00:00Z", "2026-09-30T23:30:00Z", "2026-10-01T03:00:00+05:30"]
    zones = ["UTC", "Asia/Kolkata", "America/Los_Angeles"]
    checked = 0
    outcomes = set()
    for _ in range(600):
        start = date(2026, 8, rng.randint(25, 31))
        end = date(2026, rng.choice([9, 10]), rng.randint(1, 30))
        period = {"start": start.isoformat(), "end": end.isoformat(), "timezone": rng.choice(zones)}
        stamps_for = {"created_time": rng.choice(stamps), "modified_time": rng.choice(stamps)}
        match = {"name": rng.choice(names), **stamps_for}
        for precedence in (True, False):
            assert in_requested_period(match, period, precedence=precedence) == (
                _in_requested_period(match, period, precedence=precedence)
            ), (match, period, precedence)
            checked += 1
        autoshare_match = {"name": rng.choice(autoshare_names), **stamps_for}
        decided = in_requested_period(autoshare_match, period, precedence=True)
        assert decided == _in_requested_period(autoshare_match, period, precedence=True), (
            autoshare_match,
            period,
        )
        outcomes.add((autoshare_match["name"], decided))
        checked += 1
    assert checked == 1800
    # A two-date title passes only when both dates are inside some period;
    # one date outside every period never passes.
    assert ("Range 28-08-2026 to Oct 2, 2026", True) in outcomes
    assert ("Range 28-08-2026 to Oct 2, 2026", False) in outcomes
    assert ("Notes 2026-09-10 and 2026-06-16", True) not in outcomes
    assert parse_title_dates("Top 10 Marketing ideas") == ()


def realistic_names(count):
    """English-shaped words: shared prefixes and suffixes, frequent letters.

    Uniform random words make every trigram rare; real file names share
    "ent", "ion" and "re-", which is what stresses the fuzzy lookup.
    """
    rng = random.Random(5)
    letters = "etaoinshrdlcumwfgypbvk"
    weights = [12, 9, 8, 8, 7, 7, 6, 6, 6, 4, 4, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1]
    prefixes = ["", "", "re", "con", "pre", "dis", "un", "in", "pro", "sub", "trans", "de", "ex"]
    suffixes = ["", "ment", "tion", "ing", "er", "ly", "ness", "able", "al", "ive", "ent", "ance"]
    vocabulary = sorted(
        {
            rng.choice(prefixes)
            + "".join(rng.choices(letters, weights, k=rng.randint(3, 5)))
            + rng.choice(suffixes)
            for _ in range(36_000)
        }
    )[:30_000]
    names = []
    for index in range(count):
        words = [rng.choice(vocabulary) for _ in range(rng.randint(2, 6))]
        separator = rng.choice(["_", "-", " ", ""])
        name = separator.join(word.capitalize() for word in words)
        names.append(name + rng.choice([".pdf", ".docx", "", f" 2026-09-{1 + index % 28:02d}"]))
    names[123] = "Schwab Bank Statement September 2026.pdf"
    names[456] = "MeetingNotes_Weekly_Sync.docx"
    return names


def test_matching_forty_thousand_names_stays_under_fifty_milliseconds():
    index = gear1.build_index(rest_like(realistic_names(40_000)))
    assert len(index) == 40_000 and len(index.vocabulary()) > 25_000

    def best_of_five(concepts):
        return min(_timed(lambda: index.match(concepts, SEPTEMBER_IST)) for _ in range(5))

    for concepts in (
        ["statment"],
        ["bank", ["statement", "stmt"]],
        ["meeting notes"],
        [["notes", "minutes"], "sync"],
        ["schw"],
    ):
        assert best_of_five(concepts) < 0.05, concepts
    # A bare suffix matches about a third of all names; it must stay bounded.
    for concepts in (["tion"], ["con", "ment"]):
        assert best_of_five(concepts) < 0.15, concepts
    assert index.match(["statment"], SEPTEMBER_IST)[0][0].file["title"] == (
        "Schwab Bank Statement September 2026.pdf"
    )


def test_undated_names_follow_period_decision_across_daylight_saving():
    rng = random.Random(9)

    def stamp():
        month = rng.choice(["03", "10", "11"])
        clock = f"{rng.randint(0, 23):02d}:{rng.choice(['00', '30', '59'])}:00"
        return rng.choice(
            [None, f"2026-{month}-{rng.randint(1, 28):02d}T{clock}Z", "2026-03-08T09:59:59-01:00"]
        )

    rows = [
        {
            "id": file_id("t", number),
            "title": f"Ledger {number}",
            "mimeType": "application/pdf",
            "createdTime": stamp(),
            "modifiedTime": stamp(),
            "viewUrl": None,
        }
        for number in range(400)
    ]
    index = gear1.build_index(rows)
    for zone in ("America/Los_Angeles", "Europe/London", "Asia/Kolkata"):
        for _ in range(12):
            month = rng.choice(["03", "10", "11"])
            period = {
                "start": f"2026-{month}-{rng.randint(1, 14):02d}",
                "end": f"2026-{month}-{rng.randint(15, 28):02d}",
                "timezone": zone,
            }
            for precedence in (True, False):
                found, _ = index.match(["ledger"], period, precedence=precedence)
                expected = {}
                for row in rows:
                    decision = period_decision(
                        {
                            "name": row["title"],
                            "created_time": row["createdTime"],
                            "modified_time": row["modifiedTime"],
                        },
                        period,
                        precedence=precedence,
                    )
                    if decision.in_period:
                        expected[row["id"]] = (decision.listing_day, decision.basis)
                assert {c.file["id"]: (c.listing_day, c.date_basis) for c in found} == expected


def _timed(operation):
    started = time.perf_counter()
    operation()
    return time.perf_counter() - started


async def test_gear_one_never_constructs_or_calls_a_model(monkeypatch):
    import google.genai

    from hushh_mcp.services import drive_suggestion_service

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Gear 1 must not use a model")

    monkeypatch.setattr(google.genai, "Client", forbidden)
    monkeypatch.setattr(drive_suggestion_service, "plan_live_search", forbidden)
    rows = [rest_row(file_id("u", index), name) for index, name in enumerate(NAMES)]
    indexer = gear1.OwnerMetadataIndexer(transport_for(FakeDriveAdapter(rows), monkeypatch))
    result = await gear1.match_owner_files(
        OWNER, ["statment"], SEPTEMBER_IST, connection_generation=7, indexer=indexer
    )
    assert [c.file["title"] for c in result.candidates] == ["Schwab_BankStatement_20260914.pdf"]
    assert "gemini" in await gear1.owner_vocabulary(OWNER, connection_generation=7, indexer=indexer)
    # Importing Gear 1, its content date check and transport loads no model SDK.
    probe = (
        "import sys, hushh_mcp.services.drive_owner_metadata_index, "
        "hushh_mcp.services.drive_content_dates, "
        "hushh_mcp.services.google_drive_rest_transport; "
        "print(sorted(m for m in sys.modules if m.startswith(('google.genai', 'vertexai'))))"
    )
    loaded = subprocess.run(  # noqa: S603 - fixed interpreter and in-repo import probe
        [sys.executable, "-c", probe], capture_output=True, text=True, check=True, timeout=120
    )
    assert loaded.stdout.strip() == "[]"


async def test_logs_carry_no_names_ids_or_request_words(monkeypatch, caplog):
    secret_names = ["Kavya Diagnosis Report.pdf", "Ravi_Salary_Slip_20260914.pdf"]
    rows = [rest_row(file_id("p", index), name) for index, name in enumerate(secret_names)]
    caplog.set_level(logging.DEBUG)
    indexer = gear1.OwnerMetadataIndexer(transport_for(FakeDriveAdapter(rows), monkeypatch))
    result = await gear1.match_owner_files(
        OWNER, ["diagnosis", ["kavya", "kavia"]], None, connection_generation=7, indexer=indexer
    )
    assert len(result.candidates) == 1
    with pytest.raises(DriveReadError):
        await gear1.match_owner_files(
            OWNER, "salary slip", None, connection_generation=7, indexer=indexer
        )
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "drive_metadata_index.refresh" in logged and "drive_metadata_index.match" in logged
    for private in ("kavya", "kavia", "diagnosis", "ravi", "salary", file_id("p", 0), OWNER):
        assert private not in logged.lower()
    # The same redacted lines carry the measurement: the REST channel, the
    # fixed tool name and the row count of each listing page (-1 where a tool
    # lists nothing), then the refresh totals.
    calls = re.findall(
        r"drive_rest\.call channel=google_drive_rest_v3 profile=live tool=(\w+) rows=(-?\d+) "
        r"more=-?\d+ credential_ms=\d+\.\d\d provider_ms=\d+\.\d\d recheck_ms=\d+\.\d\d "
        r"total_ms=\d+\.\d\d",
        logged,
    )
    assert calls == [
        ("changes_start_token", "-1"),
        ("search_files", "2"),
        ("list_shared_drives", "0"),
        ("list_changes", "0"),
    ]
    assert re.search(r"drive_metadata_index\.refresh outcome=ok pages=3 rows=2 entries=2 ", logged)


def undated(identity, name, mime, *, created, basis="created"):
    return gear1.MetadataCandidate(
        file={
            "id": identity,
            "title": name,
            "mimeType": mime,
            "createdTime": created,
            "modifiedTime": created,
            "viewUrl": None,
        },
        score=1.0,
        matched=("exact",),
        listing_day=None,
        date_basis=basis,
    )


async def test_undated_documents_take_the_date_on_their_first_dated_line(caplog):
    texts = {
        file_id("c", 1): "ACME BANK\nStatement period: September 1, 2026 - September 30, 2026",
        file_id("c", 2): "Invoice\nInvoice date: 14-06-2026\nDue 20-09-2026",
        file_id("c", 3): None,
        file_id("c", 4): "Notes without any written date",
    }
    reads, active, peak = [], [0], [0]

    async def read_text(identity):
        reads.append(identity)
        active[0] += 1
        peak[0] = max(peak[0], active[0])
        await asyncio.sleep(0)
        active[0] -= 1
        if texts[identity] is None:
            raise DriveReadError("provider_unavailable")
        return texts[identity]

    fence = AsyncMock()
    pdf, doc = "application/pdf", "application/vnd.google-apps.document"
    candidates = [
        undated(file_id("c", 1), "Account statement.pdf", pdf, created="2026-10-20T10:00:00Z"),
        undated(file_id("c", 2), "Scan 17.pdf", pdf, created="2026-09-10T10:00:00Z"),
        undated(file_id("c", 3), "Board memo", doc, created="2026-09-10T10:00:00Z"),
        undated(file_id("c", 4), "Weekly notes", doc, created="2026-09-12T10:00:00Z"),
        undated(
            file_id("c", 5), "Memo 2026-09-14", pdf, created="2026-09-14T10:00:00Z", basis="title"
        ),
        undated(file_id("c", 6), "Holiday clip", "video/mp4", created="2026-09-14T10:00:00Z"),
    ]
    caplog.set_level(logging.DEBUG)
    decisions = await content_dates.check_content_dates(
        OWNER,
        candidates,
        SEPTEMBER_IST,
        require_current=fence,
        read_text=read_text,
        concurrency=2,
    )
    # Titled files and non-documents are never read; at most two reads at once.
    assert sorted(reads) == [file_id("c", number) for number in (1, 2, 3, 4)]
    assert peak[0] <= 2 and fence.await_count == 2 * 4
    # Written period wins over a late download; a later due date does not count.
    assert decisions[file_id("c", 1)] == PeriodDecision(True, "2026-09-01", "content")
    assert decisions[file_id("c", 2)] == PeriodDecision(False, None, "content")
    # Unreadable: no decision, so the caller keeps its created-time decision.
    assert file_id("c", 3) not in decisions
    assert decisions[file_id("c", 4)] == PeriodDecision(True, "2026-09-12", "created")
    logged = "\n".join(record.getMessage() for record in caplog.records).lower()
    assert "drive_content_dates.check" in logged
    for private in ("acme", "statement period", "invoice", file_id("c", 1).lower()):
        assert private not in logged


async def test_a_failed_fence_cancels_every_outstanding_content_read():
    started = []

    async def read_text(identity):
        started.append(identity)
        await asyncio.sleep(0.05)
        return "Sep 2, 2026"

    checks = []

    async def fence():
        checks.append(len(checks))
        if len(checks) == 3:
            raise DriveReadError("connection_changed")

    candidates = [
        undated(
            file_id("f", number),
            f"Memo {number}",
            "application/pdf",
            created="2026-09-10T10:00:00Z",
        )
        for number in range(6)
    ]
    with pytest.raises(DriveReadError, match="connection_changed"):
        await content_dates.check_content_dates(
            OWNER,
            candidates,
            SEPTEMBER_IST,
            require_current=fence,
            read_text=read_text,
            concurrency=2,
        )
    assert len(started) == 2
