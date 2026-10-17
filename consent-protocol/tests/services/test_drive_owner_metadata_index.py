"""Gear 1 owner Drive name index: synthetic Drive metadata only, no content, no model.

The fake sits behind the real fenced REST transport, so every listed row passes
through the same owner, grant and projection checks as production.
"""

# ruff: noqa: S311 -- seeded synthetic fixtures, never secrets or tokens

from __future__ import annotations

import logging
import random
import string
import subprocess
import sys
import time
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import drive_owner_metadata_index as gear1
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_owner_search_service import _in_requested_period
from hushh_mcp.services.drive_title_dates import (
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
        visible = [row for row in corpus if not row.get("trashed")]
        start = int(page_token or 0)
        if self.too_large_at == (drive_id, start) and page_size == 1000:
            raise DriveReadError("file_too_large")
        end = start + page_size
        return {
            "files": [
                {key: value for key, value in row.items() if key != "trashed"}
                for row in visible[start:end]
            ],
            "nextPageToken": str(end) if end < len(visible) else None,
            "incompleteSearch": False,
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
    adapter = FakeDriveAdapter(rows, too_large_at=(None, 0))
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
        if len(checks) == 4:
            raise DriveReadError("connection_changed")

    indexer = gear1.OwnerMetadataIndexer(transport_for(FakeDriveAdapter(rows), monkeypatch))
    with pytest.raises(DriveReadError, match="connection_changed"):
        await indexer.refresh(OWNER, connection_generation=7, require_current=require_current)
    # Before and after the first page, then before and after the second: the
    # second page is refused after the provider answered and is not applied.
    status = await indexer.refresh(OWNER, connection_generation=7, max_pages=0)
    assert (status.indexed, status.pages, status.ready) == (1000, 1, False)


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
    stamps = [None, "2026-08-31T20:00:00Z", "2026-09-30T23:30:00Z", "2026-10-01T03:00:00+05:30"]
    zones = ["UTC", "Asia/Kolkata", "America/Los_Angeles"]
    checked = 0
    for _ in range(600):
        start = date(2026, 8, rng.randint(25, 31))
        end = date(2026, rng.choice([9, 10]), rng.randint(1, 30))
        period = {"start": start.isoformat(), "end": end.isoformat(), "timezone": rng.choice(zones)}
        match = {
            "name": rng.choice(names),
            "created_time": rng.choice(stamps),
            "modified_time": rng.choice(stamps),
        }
        for precedence in (True, False):
            assert in_requested_period(match, period, precedence=precedence) == (
                _in_requested_period(match, period, precedence=precedence)
            ), (match, period, precedence)
            checked += 1
    assert checked == 1200
    assert parse_title_dates("Top 10 Marketing ideas") == ()


def realistic_names(count):
    rng = random.Random(5)
    vocabulary = [
        "".join(rng.choice(string.ascii_lowercase) for _ in range(rng.randint(4, 10)))
        for _ in range(30_000)
    ]
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
    for concepts in (
        ["statment"],
        ["bank", ["statement", "stmt"]],
        ["meeting notes"],
        [["notes", "minutes"], "sync"],
        ["schw"],
    ):
        best = min(
            _timed(lambda concepts=concepts: index.match(concepts, SEPTEMBER_IST)) for _ in range(5)
        )
        assert best < 0.05, (concepts, best)
    assert index.match(["statment"], SEPTEMBER_IST)[0][0].file["title"] == (
        "Schwab Bank Statement September 2026.pdf"
    )


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
    # Importing Gear 1 and its transport loads no model SDK at all.
    probe = (
        "import sys, hushh_mcp.services.drive_owner_metadata_index, "
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
