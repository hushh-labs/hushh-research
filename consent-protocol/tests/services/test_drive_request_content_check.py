"""Request-time content check: selection, budgets, resume, fences, privacy.

Drive is faked at the fenced read; the scanner is faked; the parser child is
the real isolated leaf wherever a test says "real child". Fixtures are small
synthetic documents (tests/services/drive_pdf_fixtures.py).
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import drive_content_check_port as port
from hushh_mcp.services import drive_document_processor as processor_module
from hushh_mcp.services import drive_request_content_check as check_module
from hushh_mcp.services.drive_content_check_port import (
    ContentCheckBudget,
    NoContentCheck,
    brain_concept_groups,
    content_check_enabled,
    default_content_check,
)
from hushh_mcp.services.drive_document_processor import (
    LocalDocumentProcessor,
    content_check_result,
)
from hushh_mcp.services.drive_request_brain import interpret_request
from hushh_mcp.services.drive_request_content_check import (
    FencedContentReader,
    RequestContentCheck,
    drive_blind_reasons,
    select_drive_blind,
)
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import DriveMetadata, DriveReadError
from tests.services import drive_pdf_fixtures as fx

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
SEPTEMBER = {"start": "2026-09-01", "end": "2026-09-30", "timezone": "Asia/Kolkata"}
MB = 1000 * 1000
SECRET = "ZETA-PRIVATE-MARKER"
OWNER = "owner-synthetic-1"
PDF = "application/pdf"


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def row(file_id: str, *, name="Untitled document.pdf", mime=PDF, age=timedelta(minutes=5), **extra):
    changed = iso(NOW - age)
    return {
        "id": file_id,
        "name": name,
        "mimeType": mime,
        "createdTime": changed,
        "modifiedTime": changed,
        **extra,
    }


class FakeReader:
    def __init__(self, payloads: dict):
        self.payloads = payloads
        self.calls: list[str] = []

    async def read(self, *, owner_id, file_id, connection_generation, max_file_bytes):
        assert owner_id == OWNER and connection_generation == 7
        self.calls.append(file_id)
        value = self.payloads[file_id]
        if isinstance(value, BaseException):
            raise value
        if callable(value):
            return value(max_file_bytes)
        return value


class FakeProcessor:
    def __init__(self, results: dict | None = None):
        self.results = results or {}
        self.calls: list[bytes] = []

    async def check_content(self, *, content, mime_type, concepts, max_text_pages, max_ocr_pages):
        self.calls.append(content)
        value = self.results.get(content, {"matched": [0], "dates": []})
        if isinstance(value, BaseException):
            raise value
        return {
            "matched": tuple(value["matched"]),
            "dates": tuple(tuple(item) for item in value["dates"]),
            "pages_read": 1,
            "ocr_pages": 0,
            "gaps": 0,
            "total_pages": 1,
            "complete": True,
        }


def real_processor() -> LocalDocumentProcessor:
    """The real isolated child; only the ClamAV daemon is faked."""
    return LocalDocumentProcessor(
        scanner=SimpleNamespace(scan=AsyncMock()), parser=SimpleNamespace(), embedder=None
    )


async def run(checker, candidates, *, concepts=(("INV 2026 HDFC 9981",),), **kwargs):
    fence = kwargs.pop("require_current", AsyncMock())
    return await checker.check_files(
        owner_id=OWNER,
        candidates=candidates,
        concepts=[list(group) for group in concepts],
        period=kwargs.pop("period", SEPTEMBER),
        connection_generation=7,
        require_current=fence,
        now=NOW,
        **kwargs,
    )


def checker(reader, processor=None) -> RequestContentCheck:
    return RequestContentCheck(
        reader=reader, processor=processor or FakeProcessor(), enabled=lambda: True
    )


# --- selection: which candidates Google cannot content-search -----------------


@pytest.mark.parametrize(
    "mime,size,expected",
    [
        (PDF, 29 * MB, ("pdf_likely_long",)),
        (PDF, 31 * MB, ("over_index_size",)),
        (PDF, 7 * MB, ()),
        (PDF, 9 * MB, ("pdf_likely_long",)),
        (check_module.XLSX_MIME, 19 * MB, ()),
        (check_module.XLSX_MIME, 21 * MB, ("over_index_size",)),
        (check_module.DOCX_MIME, 9 * MB, ()),
        (check_module.DOCX_MIME, 11 * MB, ("over_index_size",)),
        # A Google editor file's size is storage bytes, never a text length.
        (check_module.DOC_MIME, 50 * MB, ()),
    ],
)
def test_size_boundaries_follow_drive_index_limits(mime, size, expected):
    candidate = row("f1", mime=mime, age=timedelta(days=3), size=str(size))
    assert drive_blind_reasons(candidate, now=NOW) == expected


def test_selection_reasons_skips_and_newest_first():
    candidates = [
        row("old", age=timedelta(days=3)),  # indexed long ago, Latin title: Google can see it
        row("fresh", age=timedelta(hours=2)),
        row("scan", name="IMG_0042.jpg", mime="image/jpeg", age=timedelta(days=9)),
        row("hindi", name="हिंदी बैंक स्टेटमेंट.pdf", age=timedelta(days=4)),
        row("walk", age=timedelta(days=5), source="walk"),
        row("folder", mime="application/vnd.google-apps.folder"),
        row("zip", mime="application/zip"),
        row("fresh", age=timedelta(hours=2)),  # duplicate from another gear
        {"id": "../bad", "mimeType": PDF},
    ]
    chosen, unsupported = select_drive_blind(candidates, now=NOW)
    assert [(item["id"], reasons) for item, reasons in chosen] == [
        ("fresh", ("fresh_upload",)),
        ("hindi", ("non_latin_title",)),
        ("walk", ("shared_folder_only",)),
        ("scan", ("image_or_scan",)),
    ]
    assert unsupported == 2  # fresh folder and zip: Drive-blind but not readable here


# --- the fresh-upload case end to end (real child) ----------------------------


async def test_fresh_upload_with_the_code_only_in_its_body_is_found_and_dated():
    body = fx.text_pdf(fx.statement_lines())
    reader = FakeReader({"fresh": {"mimeType": PDF, "content": body}})
    outcome = await run(checker(reader, real_processor()), [row("fresh")])
    [result] = outcome.results
    assert outcome.status == "complete" and reader.calls == ["fresh"]
    assert result.status == "checked" and result.requirement_met
    assert result.matched_concepts == ("INV 2026 HDFC 9981",)
    assert (result.date_found, result.date_basis, result.in_period) == (
        "2026-09-01",
        "content",
        True,
    )
    assert result.evidence_kind == "content" and result.possible_match
    assert outcome.possible_matches == (result,)
    # Negative control: the same small file, changed three days ago, is one
    # Google's own index covers. It is never downloaded.
    stale = FakeReader({"fresh": {"mimeType": PDF, "content": body}})
    skipped = await run(checker(stale, real_processor()), [row("fresh", age=timedelta(days=3))])
    assert stale.calls == [] and skipped.results == () and skipped.status == "complete"


async def test_header_date_outside_the_period_is_not_a_possible_match():
    body = fx.text_pdf(["HDFC statement", "Statement period: 01 Aug 2026 - 31 Aug 2026"])
    reader = FakeReader({"fresh": {"mimeType": PDF, "content": body}})
    outcome = await run(checker(reader, real_processor()), [row("fresh")], concepts=[["hdfc"]])
    [result] = outcome.results
    assert result.requirement_met and result.date_basis == "content"
    assert result.in_period is False and not result.possible_match


def test_content_only_match_never_passes_the_autoshare_title_gate():
    from hushh_mcp.services.drive_owner_search_service import _brain_title_evidence

    brain = interpret_request("HDFC bank statement")
    # A possible match found only by content has no title evidence: the
    # unchanged autoshare gate refuses it, so it can only be sent by A's tap.
    assert not _brain_title_evidence(brain, "Untitled document.pdf")
    # Negative control: a title that names the request still passes the gate.
    assert _brain_title_evidence(brain, "HDFC bank statement Sep 2026.pdf")


# --- big files, budgets and resume --------------------------------------------


async def test_file_over_the_download_cap_is_too_large_and_never_parsed():
    processor = FakeProcessor()
    reader = FakeReader(
        {
            "huge": {"tooLarge": 40 * 1024 * 1024},
            "fits": {"mimeType": PDF, "content": b"fits"},
        }
    )
    outcome = await run(
        checker(reader, processor),
        [row("huge", size=str(40 * 1024 * 1024)), row("fits", age=timedelta(minutes=9))],
    )
    statuses = {result.file_id: result.status for result in outcome.results}
    assert statuses == {"huge": "too_large", "fits": "checked"}
    assert processor.calls == [b"fits"]
    assert outcome.counts["byStatus"] == {"too_large": 1, "checked": 1}


async def test_byte_budget_leaves_the_file_pending_instead_of_calling_it_too_large():
    reader = FakeReader({"big": {"tooLarge": 5 * MB}})
    budget = ContentCheckBudget(max_bytes=4 * MB)
    outcome = await run(checker(reader), [row("big")], budget=budget)
    assert outcome.results == () and outcome.pending == 1
    assert outcome.status == "budget_exhausted" and outcome.counts["budgetSpent"]


async def test_slices_resume_from_the_checkpoint_and_read_each_file_once():
    ids = [f"file{number}" for number in range(5)]
    payloads = {file_id: {"mimeType": PDF, "content": file_id.encode()} for file_id in ids}
    reader = FakeReader(payloads)
    rows = [row(file_id, age=timedelta(minutes=10 + index)) for index, file_id in enumerate(ids)]
    budget = ContentCheckBudget(max_files_per_slice=2, concurrency=1)
    first = await run(checker(reader), rows, budget=budget)
    assert first.status == "partial" and first.pending == 3 and len(first.results) == 2
    second = await run(checker(reader), rows, budget=budget, checkpoint=first.checkpoint)
    third = await run(checker(reader), rows, budget=budget, checkpoint=second.checkpoint)
    assert third.status == "complete" and third.pending == 0
    assert sorted(reader.calls) == sorted(ids) and len(reader.calls) == 5
    assert [result.file_id for result in third.results] == ids  # newest first
    assert json.loads(json.dumps(third.checkpoint)) == third.checkpoint
    # Negative control: a changed request (other concepts) never reuses results.
    again = await run(
        checker(reader),
        rows,
        budget=budget,
        checkpoint=third.checkpoint,
        concepts=[["other words"]],
    )
    assert len(reader.calls) == 7 and len(again.results) == 2


async def test_request_file_budget_is_reported_as_exhausted():
    ids = [f"file{number}" for number in range(5)]
    reader = FakeReader({file_id: {"mimeType": PDF, "content": b"x"} for file_id in ids})
    budget = ContentCheckBudget(max_files=3, max_files_per_slice=10, concurrency=1)
    outcome = await run(checker(reader), [row(file_id) for file_id in ids], budget=budget)
    assert len(reader.calls) == 3 and outcome.pending == 2
    assert outcome.status == "budget_exhausted"
    later = await run(
        checker(reader),
        [row(file_id) for file_id in ids],
        budget=budget,
        checkpoint=outcome.checkpoint,
    )
    assert len(reader.calls) == 3 and later.status == "budget_exhausted"


async def test_transient_failures_retry_once_more_then_become_final():
    reader = FakeReader({"flaky": DriveReadError("provider_unavailable", retryable=True)})
    first = await run(checker(reader), [row("flaky")])
    assert first.results == () and first.pending == 1 and first.status == "partial"
    second = await run(checker(reader), [row("flaky")], checkpoint=first.checkpoint)
    [result] = second.results
    assert result.status == "unavailable" and result.error_code == "provider_unavailable"
    assert reader.calls == ["flaky", "flaky"] and second.status == "complete"


async def test_slice_deadline_counts_an_attempt_so_a_stuck_file_is_not_retried_forever():
    async def slow(_limit):
        await asyncio.sleep(5)

    class SlowReader(FakeReader):
        async def read(self, **kwargs):
            self.calls.append(kwargs["file_id"])
            await asyncio.sleep(5)

    reader = SlowReader({})
    budget = ContentCheckBudget(slice_seconds=1, max_attempts=2)
    first = await run(checker(reader), [row("stuck")], budget=budget)
    assert first.pending == 1 and first.status == "partial"
    second = await run(checker(reader), [row("stuck")], budget=budget, checkpoint=first.checkpoint)
    [result] = second.results
    assert result.status == "unavailable" and result.error_code == "processing_timeout"


class ScanProcessor:
    """Each file is a scan of ``pages`` pages that only OCR can read.

    Mirrors the real leaf: pages past the OCR allowance are gaps and the
    result is not complete; with enough OCR every page is read. Records the
    allowance each call got and the most OCR pages ever in flight at once.
    """

    def __init__(self, pages: int = 3, delay: float = 0.01):
        self.pages = pages
        self.delay = delay
        self.allowances: list[int] = []
        self.running = 0
        self.peak = 0

    async def check_content(self, *, content, mime_type, concepts, max_text_pages, max_ocr_pages):
        self.allowances.append(max_ocr_pages)
        self.running += max_ocr_pages
        self.peak = max(self.peak, self.running)
        try:
            await asyncio.sleep(self.delay)
        finally:
            self.running -= max_ocr_pages
        needed = 1 if mime_type.startswith("image/") else self.pages
        read = min(needed, max_ocr_pages)
        return {
            "matched": (),
            "dates": (),
            "pages_read": read,
            "ocr_pages": read,
            "gaps": needed - read,
            "total_pages": needed,
            "complete": read == needed,
        }


SCAN_BUDGET = ContentCheckBudget(
    max_files_per_slice=6, max_ocr_pages_per_slice=6, max_ocr_pages=3, concurrency=2
)


async def test_scans_past_the_slice_ocr_budget_wait_and_are_each_read_in_full():
    """Six 3-page scans, six OCR pages per slice: every scan is OCRed in full."""
    ids = [f"scan{number}" for number in range(6)]
    reader = FakeReader(
        {file_id: {"mimeType": PDF, "content": file_id.encode()} for file_id in ids}
    )
    rows = [row(file_id, age=timedelta(minutes=10 + index)) for index, file_id in enumerate(ids)]
    processor = ScanProcessor()
    check = checker(reader, processor)
    outcome = await run(check, rows, budget=SCAN_BUDGET)
    calls = 1
    # A slice never has more OCR pages reserved than it may spend.
    assert processor.peak <= SCAN_BUDGET.max_ocr_pages_per_slice
    # Scans the slice could not afford are not final: they stay pending.
    assert outcome.status == "partial" and outcome.pending > 0
    assert all(result.complete for result in outcome.results)
    while outcome.status != "complete" and calls < 10:
        outcome = await run(check, rows, budget=SCAN_BUDGET, checkpoint=outcome.checkpoint)
        calls += 1
        assert processor.peak <= SCAN_BUDGET.max_ocr_pages_per_slice
    assert outcome.status == "complete" and outcome.pending == 0
    assert sorted(result.file_id for result in outcome.results) == sorted(ids)
    # Each scan ends read in full: 3 OCR pages, complete, no starved final result.
    assert {(result.ocr_pages, result.complete) for result in outcome.results} == {(3, True)}
    assert outcome.counts["byStatus"] == {"checked": 6}


async def test_a_scan_longer_than_one_slice_can_ocr_is_final_and_partly_read():
    """Negative control for the retry rule: a scan is never retried forever."""
    reader = FakeReader({"scan": {"mimeType": PDF, "content": b"scan"}})
    processor = ScanProcessor(pages=3)
    # Two OCR pages per slice can never cover a 3-page scan: it is read once
    # with all a slice can give, then final.
    budget = ContentCheckBudget(max_ocr_pages_per_slice=2, max_ocr_pages=3)
    outcome = await run(checker(reader, processor), [row("scan")], budget=budget)
    [result] = outcome.results
    assert outcome.status == "complete" and processor.allowances == [2]
    # Final, checked, but not complete: the search reports it as partly read.
    assert result.status == "checked" and result.complete is False and result.ocr_pages == 2
    again = await run(
        checker(reader, processor), [row("scan")], budget=budget, checkpoint=outcome.checkpoint
    )
    assert again.status == "complete" and reader.calls == ["scan"]


async def test_a_starved_scan_is_retried_first_with_its_full_allowance():
    """Two scans, one slice's OCR: the second waits and is then read in full."""
    reader = FakeReader(
        {
            "newer": {"mimeType": PDF, "content": b"newer"},
            "older": {"mimeType": PDF, "content": b"older"},
        }
    )
    processor = ScanProcessor(pages=3, delay=0.05)
    rows = [row("newer", age=timedelta(minutes=1)), row("older", age=timedelta(minutes=2))]
    budget = ContentCheckBudget(max_ocr_pages_per_slice=3, max_ocr_pages=3, concurrency=2)
    first = await run(checker(reader, processor), rows, budget=budget)
    assert processor.peak <= 3 and first.pending == 1 and first.status == "partial"
    second = await run(checker(reader, processor), rows, budget=budget, checkpoint=first.checkpoint)
    assert second.status == "complete" and processor.allowances[-1] == 3
    assert {(result.ocr_pages, result.complete) for result in second.results} == {(3, True)}


async def test_an_image_is_not_downloaded_once_the_slice_ocr_is_spent():
    """OCR is an image's only reader: with none left it waits, unread, for the next slice."""
    reader = FakeReader(
        {
            "scan": {"mimeType": PDF, "content": b"scan"},
            "photo": {"mimeType": "image/jpeg", "content": b"photo"},
        }
    )
    processor = ScanProcessor(pages=3)
    rows = [
        row("scan", age=timedelta(minutes=1)),
        row("photo", mime="image/jpeg", age=timedelta(minutes=2)),
    ]
    budget = ContentCheckBudget(max_ocr_pages_per_slice=3, max_ocr_pages=3, concurrency=1)
    first = await run(checker(reader, processor), rows, budget=budget)
    assert reader.calls == ["scan"] and first.pending == 1 and first.status == "partial"
    second = await run(checker(reader, processor), rows, budget=budget, checkpoint=first.checkpoint)
    assert reader.calls == ["scan", "photo"] and second.status == "complete"
    photo = next(result for result in second.results if result.file_id == "photo")
    assert photo.complete is True and photo.ocr_pages == 1


@pytest.mark.parametrize(
    "error,status",
    [
        (DriveReadError("unsafe_document"), "unsafe"),
        (DriveReadError("encrypted_document"), "unreadable"),
        (DriveReadError("file_too_large"), "too_large"),
    ],
)
async def test_parser_outcomes_are_final_statuses(error, status):
    reader = FakeReader({"f": {"mimeType": PDF, "content": b"bytes"}})
    outcome = await run(checker(reader, FakeProcessor({b"bytes": error})), [row("f")])
    assert [result.status for result in outcome.results] == [status]
    assert not outcome.results[0].possible_match


# --- fences, grants and kill switches -----------------------------------------


async def test_a_failed_fence_stops_every_read():
    reader = FakeReader({f"f{n}": {"mimeType": PDF, "content": b"x"} for n in range(3)})
    fence = AsyncMock(side_effect=[None, DriveReadError("connection_changed")])
    with pytest.raises(DriveReadError, match="^connection_changed$"):
        await run(
            checker(reader),
            [row(f"f{n}") for n in range(3)],
            require_current=fence,
            budget=ContentCheckBudget(concurrency=1),
        )
    assert reader.calls == ["f0"]  # read, then the fence failed: nothing else is read


async def test_a_revoked_grant_during_a_read_stops_the_check():
    reader = FakeReader(
        {
            "f0": DriveOAuthError("connection_changed", status_code=409),
            "f1": {"mimeType": PDF, "content": b"x"},
        }
    )
    with pytest.raises(DriveOAuthError):
        await run(
            checker(reader),
            [row("f0"), row("f1", age=timedelta(hours=1))],
            budget=ContentCheckBudget(concurrency=1),
        )
    assert reader.calls == ["f0"]


async def test_kill_switch_off_means_no_drive_call_and_no_child():
    reader = FakeReader({"f": {"mimeType": PDF, "content": b"x"}})
    processor = FakeProcessor()
    off = RequestContentCheck(reader=reader, processor=processor, enabled=lambda: False)
    previous = {"version": 1, "signature": "kept"}
    outcome = await run(off, [row("f")], checkpoint=previous)
    assert outcome.status == "disabled" and outcome.checkpoint is previous
    assert reader.calls == [] and processor.calls == []
    assert (await NoContentCheck().check_files(checkpoint=previous)).status == "disabled"


@pytest.mark.parametrize(
    "env,enabled",
    [
        # Unset means off in UAT too: third-party files in shared folders
        # reach native parsers, and the sandbox hardening (P1-11) has not
        # landed. Only an explicit opt-in turns the check on.
        (
            {"DRIVE_WORKER_MODE": "true", "DRIVE_WORK_DRAIN_ENABLED": "true", "ENVIRONMENT": "uat"},
            False,
        ),
        (
            {
                "DRIVE_WORKER_MODE": "true",
                "DRIVE_WORK_DRAIN_ENABLED": "true",
                "ENVIRONMENT": "uat",
                port.CONTENT_CHECK_FLAG: "true",
            },
            True,
        ),
        (
            {
                "DRIVE_WORKER_MODE": "true",
                "DRIVE_WORK_DRAIN_ENABLED": "true",
                "ENVIRONMENT": "uat",
                port.CONTENT_CHECK_FLAG: "yes",
            },
            False,
        ),
        (
            {
                "DRIVE_WORKER_MODE": "true",
                "DRIVE_WORK_DRAIN_ENABLED": "true",
                "ENVIRONMENT": "production",
            },
            False,
        ),
        (
            {
                "DRIVE_WORKER_MODE": "true",
                "DRIVE_WORK_DRAIN_ENABLED": "true",
                "ENVIRONMENT": "production",
                port.CONTENT_CHECK_FLAG: "true",
            },
            True,
        ),
        (
            {
                "DRIVE_WORKER_MODE": "true",
                "DRIVE_WORK_DRAIN_ENABLED": "true",
                "ENVIRONMENT": "uat",
                port.CONTENT_CHECK_FLAG: "false",
            },
            False,
        ),
        # The API process and a drained-off worker never read content.
        (
            {
                "DRIVE_WORK_DRAIN_ENABLED": "true",
                "ENVIRONMENT": "uat",
                port.CONTENT_CHECK_FLAG: "true",
            },
            False,
        ),
        (
            {"DRIVE_WORKER_MODE": "true", "ENVIRONMENT": "uat", port.CONTENT_CHECK_FLAG: "true"},
            False,
        ),
        (
            {
                "DRIVE_WORKER_MODE": "true",
                "DRIVE_WORK_DRAIN_ENABLED": "false",
                "ENVIRONMENT": "uat",
                port.CONTENT_CHECK_FLAG: "true",
            },
            False,
        ),
    ],
)
def test_feature_flag_is_off_unless_set_true_and_obeys_kill_switches(monkeypatch, env, enabled):
    for name in (
        "DRIVE_WORKER_MODE",
        "DRIVE_WORK_DRAIN_ENABLED",
        "ENVIRONMENT",
        port.CONTENT_CHECK_FLAG,
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert content_check_enabled() is enabled
    assert isinstance(default_content_check(), RequestContentCheck if enabled else NoContentCheck)


# --- privacy: no text, names, IDs or queries in logs or results ---------------


async def test_text_names_ids_and_queries_never_reach_logs_or_results(caplog):
    body = fx.text_pdf(fx.statement_lines() + [f"Holder note {SECRET} 4242"])
    file_id = "SyntheticFileIdQ9"
    reader = FakeReader({file_id: {"mimeType": PDF, "content": body}})
    caplog.set_level(logging.DEBUG)
    outcome = await run(
        checker(reader, real_processor()),
        [row(file_id, name="Sneha salary private.pdf")],
        concepts=[["hdfc"], ["INV 2026 HDFC 9981"]],
    )
    assert outcome.results[0].requirement_met
    logged = caplog.text
    assert "drive_content_check.slice" in logged
    for private in (SECRET, "Holder", file_id, "Sneha", "hdfc", "HDFC", "INV 2026"):
        assert private not in logged
    stored = json.dumps(outcome.checkpoint)
    assert SECRET not in stored and "Holder" not in stored and "Sneha" not in stored
    assert "hdfc" not in stored.lower()  # indices, never the query words
    assert file_id not in repr(outcome) and "hdfc" not in repr(outcome.results[0]).lower()


async def test_child_command_line_carries_no_query_words(monkeypatch):
    seen = {}

    async def child(leaf, argument, payload, *, timeout, limit):
        seen.update(leaf=leaf, argument=argument, payload=payload)
        return {
            "matched": [0],
            "dates": [],
            "pages_read": 1,
            "total_pages": 1,
            "ocr_pages": 0,
            "gaps": 0,
            "complete": True,
        }

    monkeypatch.setattr(processor_module, "_private_process", child)
    result = await real_processor().check_content(
        content=b"%PDF-1.4 synthetic",
        mime_type=PDF,
        concepts=[["sneha salary"]],
        max_text_pages=5,
        max_ocr_pages=1,
    )
    assert result["matched"] == (0,)
    assert seen["leaf"] == "content_check" and "sneha" not in seen["argument"]
    assert json.loads(seen["argument"]) == {
        "mime_type": PDF,
        "max_text_pages": 5,
        "max_ocr_pages": 1,
    }
    assert b"sneha salary" in seen["payload"][:200]


def test_untrusted_child_answers_are_validated():
    good = {
        "matched": [1],
        "dates": [["day", 2026, 9, 1, -1, -1, ""], ["day", 2026, 13, 1, -1, -1, ""]],
        "pages_read": 1,
        "total_pages": 1,
        "ocr_pages": 0,
        "gaps": 0,
        "complete": True,
    }
    parsed = content_check_result(good, groups=2)
    assert parsed["dates"] == (("day", 2026, 9, 1, -1, -1, ""),)  # impossible month dropped
    assert content_check_result({**good, "dates": ["junk", []]}, groups=2)["dates"] == ()
    for broken in (
        {**good, "matched": [2]},
        {**good, "matched": [0, 0]},
        {**good, "complete": 1},
        {**good, "dates": [["month", 2026, 9]] * 3},
        {**good, "pages_read": -1},
    ):
        with pytest.raises(DriveReadError, match="^processor_unavailable$"):
            content_check_result(broken, groups=2)


async def test_no_model_or_vertex_is_imported_or_called(monkeypatch):
    from hushh_mcp.runtime_providers import gemini_config

    def refuse(*_args, **_kwargs):
        raise AssertionError("the content check must not resolve a model")

    monkeypatch.setattr(gemini_config, "resolve_fleet_model_name", refuse)
    for name in ("google.genai", "vertexai", "google.cloud.aiplatform"):
        monkeypatch.setitem(sys.modules, name, None)  # any new import now raises
    body = fx.text_pdf(fx.statement_lines())
    reader = FakeReader({"f": {"mimeType": PDF, "content": body}})
    outcome = await run(checker(reader, real_processor()), [row("f")])
    assert outcome.results[0].requirement_met
    services = Path(check_module.__file__).resolve().parent
    for module in (
        "drive_request_content_check.py",
        "drive_content_check_port.py",
        "drive_content_check_leaf.py",
        "drive_pdf_engine.py",
    ):
        imports = [
            line.strip().lower()
            for line in (services / module).read_text().splitlines()
            if line.strip().startswith(("import ", "from "))
        ]
        assert imports and not any(
            marker in line
            for line in imports
            for marker in ("genai", "vertex", "gemini", "aiplatform", "embedding")
        )


# --- the fenced read: size before bytes, version after, generation fence -------


class FakeOAuth:
    def __init__(self, generation=7, after_generation=7):
        row_value = {
            "status": "connected",
            "validation_state": "verified",
            "verified_policy_hash": check_module_live_hash(),
            "connection_generation": generation,
        }
        self.row = row_value
        self.after = {**row_value, "connection_generation": after_generation}
        self.lifecycle = SimpleNamespace(read=AsyncMock(return_value=self.after))

    async def current_credential(self, *, user_id, required_profile):
        assert required_profile == "live"
        return self.row, {"accessToken": "synthetic-token"}


def check_module_live_hash():
    from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH

    return LIVE_POLICY_HASH


def metadata(size=1024, version="5"):
    return DriveMetadata("f1", "Untitled.pdf", PDF, version, "2026-10-18T11:55:00Z", size, None)


class FakeAdapter:
    def __init__(self, before, after=None, content=b"%PDF-1.4 bytes"):
        self.get_metadata = AsyncMock(side_effect=[before, after or before])
        self.read_live_bytes = AsyncMock(return_value=(PDF, content))


@pytest.fixture
def live_feature(monkeypatch):
    from hushh_mcp.services import google_drive_rest_transport as transport

    monkeypatch.setattr(transport, "connector_feature_enabled", lambda *_: True)


async def test_fenced_reader_checks_size_before_any_download(live_feature):
    adapter = FakeAdapter(metadata(size=40 * 1024 * 1024))
    reader = FencedContentReader(oauth=FakeOAuth(), adapter=adapter, writer=object())
    payload = await reader.read(
        owner_id=OWNER, file_id="f1", connection_generation=7, max_file_bytes=32 * 1024 * 1024
    )
    assert payload == {"tooLarge": 40 * 1024 * 1024}
    adapter.read_live_bytes.assert_not_awaited()
    # Gen-AI-restricted files stay out by default (decision D5).
    assert adapter.get_metadata.await_args.kwargs["require_genai_eligibility"] is True


async def test_fenced_reader_requires_the_same_version_after_the_bytes(live_feature):
    adapter = FakeAdapter(metadata(version="5"), metadata(version="6"))
    reader = FencedContentReader(oauth=FakeOAuth(), adapter=adapter, writer=object())
    with pytest.raises(DriveReadError, match="^source_changed$"):
        await reader.read(owner_id=OWNER, file_id="f1", connection_generation=7, max_file_bytes=MB)
    ok = FakeAdapter(metadata())
    reader = FencedContentReader(oauth=FakeOAuth(), adapter=ok, writer=object())
    payload = await reader.read(
        owner_id=OWNER, file_id="f1", connection_generation=7, max_file_bytes=MB
    )
    assert payload == {"mimeType": PDF, "content": b"%PDF-1.4 bytes"}


@pytest.mark.parametrize("generation,after", [(8, 8), (7, 8)])
async def test_fenced_reader_refuses_another_connection_generation(live_feature, generation, after):
    adapter = FakeAdapter(metadata())
    reader = FencedContentReader(
        oauth=FakeOAuth(generation=generation, after_generation=after),
        adapter=adapter,
        writer=object(),
    )
    with pytest.raises(DriveOAuthError):
        await reader.read(owner_id=OWNER, file_id="f1", connection_generation=7, max_file_bytes=MB)
    if generation != 7:
        adapter.get_metadata.assert_not_awaited()  # refused before any Drive call


# --- the request brain becomes concept groups and requirements ----------------


def test_brain_concept_groups_and_listing_requests():
    groups, requirements = brain_concept_groups(interpret_request("HDFC bank statement"))
    assert [group[0] for group in groups] == ["hdfc", "bank", "statement"]
    assert "statements" in groups[2] and requirements == [[0, 1, 2]]
    # A title-only joined form never becomes a prose requirement.
    assert all("bankstatement" not in group for group in groups)
    assert brain_concept_groups(interpret_request("all files from last week")) == ([], [])


@pytest.mark.parametrize(
    "bad",
    [
        {"concepts": [[]]},
        {"concepts": [["x" * 201]]},
        {"requirements": [[5]]},
        {"period": {"start": "not-a-date", "end": "2026-09-30"}},
    ],
)
async def test_bad_arguments_fail_before_any_download(bad):
    reader = FakeReader({"f": {"mimeType": PDF, "content": b"x"}})
    kwargs = {"concepts": bad.pop("concepts", [["hdfc"]]), **bad}
    with pytest.raises(DriveReadError, match="^invalid_argument$"):
        await run(checker(reader), [row("f")], **kwargs)
    assert reader.calls == []
