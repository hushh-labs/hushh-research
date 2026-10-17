"""Search v3 release wiring: possible matches, the content phase and their gates.

The four v3 packages meet in the request search. These tests pin how they fit:

* A candidate without title evidence is kept only as a tagged possible match
  (D3), labelled by its evidence, and O4's claim-time classifier never lets an
  automatic step claim it. Title matches stay exactly what autoshare sends.
* The walk's unmatched rows and Gear 1's recent Drive-blind rows feed the
  request-time content check (O3) through O1's routing facts (size,
  canDownload); content hits become possible matches, never grants.
* Production keeps the old flow (#8180): no possible matches, no content
  phase and no walk for automatic searches there.

Every core claim has a negative control. No model, no Drive, no database.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import drive_owner_search_service as search_module
from hushh_mcp.services.drive_content_check_port import (
    ContentCheckOutcome,
    ContentFileResult,
    NoContentCheck,
)
from hushh_mcp.services.drive_match_evidence import (
    CONTENT,
    CORRECTED,
    EVIDENCE_KIND_FIELD,
    POSSIBLE_KINDS,
    SYNONYM,
    WALK,
    awaiting_owner,
    is_possible_match,
)
from hushh_mcp.services.drive_owner_index_port import MetadataOwnerIndex, NoOwnerIndex
from hushh_mcp.services.drive_owner_metadata_index import (
    OwnerMetadataIndex,
    OwnerMetadataIndexer,
    build_index,
)
from hushh_mcp.services.drive_owner_search_service import (
    CONTENT_CHECK_PHASE,
    DriveOwnerSearchService,
    _content_candidate,
    _remember_content_candidates,
)
from hushh_mcp.services.drive_request_brain import interpret_request, suggested_plan

REQUEST_ID = "12345678-1234-1234-1234-123456789012"
NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
START, END = date(2026, 9, 1), date(2026, 9, 30)
TEXT = "Standup notes from September"
PDF = "application/pdf"
GDOC = "application/vnd.google-apps.document"
MB = 1000 * 1000


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


IN_PERIOD = "2026-09-15T10:00:00.000Z"


def _row(identity, title, mime=PDF, *, when=IN_PERIOD, **changes):
    """A projected owner-search row, as the transport returns it."""
    return {
        "id": identity,
        "title": title,
        "mimeType": mime,
        "createdTime": when,
        "modifiedTime": when,
        "capabilities": {"canShare": True},
        **changes,
    }


async def _planned(
    *, text=TEXT, autoshare=True, authority_mode="trusted_auto", vocabulary=None, store=None
):
    """create_for_request's frozen checkpoint, exactly as the request flow plans it."""
    from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan

    store = store or SimpleNamespace(
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": "synthetic-job"}, False)),
    )
    brain = interpret_request(
        text, now=NOW, timezone="UTC", picked_period=(START, END), vocabulary=vocabulary
    )
    plan = LiveSearchPlan.model_validate(suggested_plan(brain, text)).model_dump(mode="json")
    service = DriveOwnerSearchService(
        store=store, transport=SimpleNamespace(), owner_index=NoOwnerIndex()
    )
    await service.create_for_request(
        user_id="owner",
        request_id=REQUEST_ID,
        request_revision=1,
        purpose={"purpose": text, "periodStart": START.isoformat(), "periodEnd": END.isoformat()},
        plan=plan,
        require_current=AsyncMock(),
        authority_mode=authority_mode,
        requested_at=NOW,
        autoshare=autoshare,
        brain=brain.as_checkpoint(),
        plan_source="deterministic_brain",
    )
    return service, store.create.await_args.kwargs["checkpoint"]


def _claimable(checkpoint, files):
    return {file["id"] for file in files if not awaiting_owner(checkpoint, file)}


def _kinds(files):
    return {file["id"]: file.get(EVIDENCE_KIND_FIELD) for file in files}


# --- planning and the production gate -----------------------------------------


@pytest.mark.asyncio
async def test_possible_matches_and_content_phase_plan_only_where_autoshare_runs(monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    _, checkpoint = await _planned()
    assert checkpoint["request_owner_review_required"] is False
    assert checkpoint["request_possible_matches"] is True
    assert checkpoint["content_phase"] == {"stage": "planned", "candidates": []}
    assert checkpoint["coverage_manifest"]["contentCheck"] == "planned"
    assert checkpoint["shared_walk"]["stage"] == "seed_folders"

    # Production keeps the owner-review flow until autoshare is approved
    # there (#8180): an automatic search keeps no possible matches, reads no
    # content and does not walk.
    monkeypatch.setenv("ENVIRONMENT", "production")
    _, production = await _planned()
    assert "request_possible_matches" not in production
    assert "content_phase" not in production
    assert "contentCheck" not in production["coverage_manifest"]
    assert "shared_walk" not in production
    assert production["coverage_manifest"]["sharedFolderWalk"] == "not_applicable"
    # A walk the gate skipped is not partial coverage the requester would see.
    assert production["coverage_counts"] == {}

    # An owner-reviewed search may still walk in production: the owner picks
    # each file, so no sharing authority widens.
    _, reviewed = await _planned(autoshare=False)
    assert reviewed["request_owner_review_required"] is True
    assert reviewed["shared_walk"]["stage"] == "seed_folders"
    assert "request_possible_matches" not in reviewed

    # Negative control: the same owner-reviewed search outside production
    # never keeps possible matches either (the owner already reviews all).
    monkeypatch.setenv("ENVIRONMENT", "uat")
    _, uat_reviewed = await _planned(autoshare=False)
    assert "request_possible_matches" not in uat_reviewed


@pytest.mark.asyncio
async def test_bounded_and_exact_title_requests_keep_no_possible_matches():
    _, newest = await _planned(text="latest 3 standup notes")
    assert newest["request_result_limit"] == 3
    assert "request_possible_matches" not in newest
    _, exact = await _planned(text="Standup notes Sep.pdf")
    assert exact["request_exact_title"]
    assert "request_possible_matches" not in exact


# --- possible matches from the search gears ---------------------------------


@pytest.mark.asyncio
async def test_candidates_without_title_evidence_are_tagged_possible_matches_never_claimed():
    service, checkpoint = await _planned()
    rows = [
        _row("title", "Standup notes - team A.pdf"),
        # Drive's fullText found the words inside it: content evidence only.
        _row("content", "Team update.pdf"),
        # A loose synonym names it ("scrum", "recap"), never the typed words.
        _row("synonym", "Scrum recap.pdf"),
        # Out of the period, unshareable, or an agenda for a notes request:
        # still excluded entirely, as before.
        _row("old", "Team update.pdf", when="2026-06-15T10:00:00.000Z"),
        _row("locked", "Team update.pdf", capabilities={"canShare": False}),
        _row("agenda", "Standup agenda.pdf"),
    ]
    files, _ = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, rows, folder_scoped=False, drive_id=None
    )
    assert _kinds(files) == {"title": None, "content": CONTENT, "synonym": SYNONYM}
    # O4's claim-time classifier agrees: only the title match is claimable.
    assert _claimable(checkpoint, files) == {"title"}
    assert all(is_possible_match(checkpoint, file) for file in files if file["id"] != "title")
    counts = checkpoint["coverage_counts"]
    # Counted before the store's dedupe; the store counts the committed rows.
    assert counts["possibleMatchCandidates"] == 2
    assert counts["excludedByDateCount"] == 1

    # The evidence, not the gear, labels a match: a walked file without title
    # evidence reads "In a shared folder"; a walked title match stays a title
    # match and shares itself.
    walked, _ = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [_row("walk_title", "Standup notes walked.pdf"), _row("walk_other", "Team update.pdf")],
        folder_scoped=False,
        drive_id=None,
        found_by="walk",
    )
    assert _kinds(walked) == {"walk_title": None, "walk_other": WALK}
    # Gear 1 found a name with typo tolerance: "Similar spelling".
    indexed, _ = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [_row("typo", "Stnadup notse.pdf")],
        folder_scoped=False,
        drive_id=None,
        found_by="index",
    )
    assert _kinds(indexed) == {"typo": CORRECTED}
    # A topical folder's generic children are never possible matches.
    children, _ = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [_row("child", "Team update.pdf")],
        folder_scoped=True,
        drive_id=None,
    )
    assert children == []


@pytest.mark.asyncio
async def test_a_spelling_fix_labels_its_matches_similar_spelling():
    service, checkpoint = await _planned(text="metting notes from September")
    files, _ = await service._request_candidates(
        {"user_id": "owner"},
        checkpoint,
        [_row("fixed", "Meeting notes Sep.pdf"), _row("typed", "Metting notes Sep.pdf")],
        folder_scoped=False,
        drive_id=None,
    )
    # Only the typed spelling is title evidence; the fix only discovers.
    assert _kinds(files) == {"fixed": CORRECTED, "typed": None}
    assert _claimable(checkpoint, files) == {"typed"}


@pytest.mark.asyncio
async def test_owner_reviewed_and_production_searches_keep_the_previous_exclusion(monkeypatch):
    rows = [_row("title", "Standup notes - team A.pdf"), _row("content", "Team update.pdf")]
    monkeypatch.setenv("ENVIRONMENT", "production")
    service, production = await _planned()
    files, _ = await service._request_candidates(
        {"user_id": "owner"}, production, rows, folder_scoped=False, drive_id=None
    )
    assert _kinds(files) == {"title": None}
    assert production["coverage_counts"]["excludedByFilenameCount"] == 1


@pytest.mark.asyncio
async def test_possible_matches_are_capped_so_title_matches_keep_their_room(monkeypatch):
    monkeypatch.setattr(search_module, "MAX_POSSIBLE_MATCHES", 2)
    service, checkpoint = await _planned()
    rows = [_row(f"content{n}", f"Team update {n}.pdf") for n in range(3)]
    rows.append(_row("title", "Standup notes - team A.pdf"))
    files, _ = await service._request_candidates(
        {"user_id": "owner"}, checkpoint, rows, folder_scoped=False, drive_id=None
    )
    assert sum(file.get(EVIDENCE_KIND_FIELD) == CONTENT for file in files) == 2
    assert "title" in _claimable(checkpoint, files)
    assert checkpoint["coverage_counts"]["possibleMatchesDropped"] == 1


# --- content-phase candidates (O1 routing facts, O2 walk, Gear 1) -------------


@pytest.mark.asyncio
async def test_content_candidates_are_drive_blind_readable_shareable_files_only(monkeypatch):
    _, checkpoint = await _planned()
    monkeypatch.setattr(search_module, "datetime", _FrozenDatetime)
    fresh = _iso(NOW - timedelta(minutes=5))
    stale = "2026-09-10T10:00:00.000Z"

    def pick(row, source="index"):
        return _content_candidate(checkpoint, row, source=source)

    # A walked file is outside Google's user corpus: always a candidate.
    walked = pick(_row("walked", "Scan_0042.pdf", when=stale), source="walk")
    assert walked["source"] == "walk" and walked["title"] == "Scan_0042.pdf"
    # Gear 1 rows must be Drive-blind: fresh, too big, likely long, non-Latin.
    assert pick(_row("fresh", "Untitled document.pdf", when=fresh))["id"] == "fresh"
    assert pick(_row("big", "Big scan.pdf", when=stale, size=31 * MB))["size"] == 31 * MB
    assert pick(_row("long", "Long scan.pdf", when=stale, size=9 * MB)) is not None
    assert pick(_row("hindi", "हिंदी बैंक स्टेटमेंट.pdf", when=stale)) is not None
    # Negative controls: Google's index already covers a small, older file.
    assert pick(_row("small", "Old memo.pdf", when=stale, size=1 * MB)) is None
    assert pick(_row("edge", "Edge scan.pdf", when=stale, size=7 * MB)) is None
    # Routing facts (O1): never read what Drive will not let us download.
    restricted = _row("restricted", "Scan.pdf", when=fresh)
    restricted["capabilities"] = {"canShare": True, "canDownload": False}
    assert pick(restricted) is None
    assert (
        pick(
            _row(
                "cse",
                "Scan.pdf",
                when=fresh,
                clientEncryptionDetails={"encryptionState": "encrypted"},
            )
        )
        is None
    )
    # Only files this request could share.
    assert pick(_row("unshared", "Scan.pdf", when=fresh, capabilities={"canShare": False})) is None
    assert pick(_row("trashed", "Scan.pdf", when=fresh, trashed=True)) is None
    assert pick(_row("zip", "Scan.zip", "application/zip", when=fresh)) is None
    assert pick(_row("folder", "Scans", "application/vnd.google-apps.folder", when=fresh)) is None
    # Before the period began (with a day of slack): not read.
    assert pick(_row("before", "Scan.pdf", when="2026-08-20T10:00:00.000Z"), "walk") is None
    # A name the request's discovery spellings already match is Gears 1/2's.
    assert pick(_row("named", "Scrum recap.pdf", when=fresh)) is None


def test_content_candidate_pool_keeps_the_newest_within_its_bounds(monkeypatch):
    monkeypatch.setattr(search_module, "MAX_CONTENT_CANDIDATES", 3)
    checkpoint = {
        "request_file_kind": "any",
        "requested_period": {"start": "2026-09-01", "end": "2026-09-30", "timezone": "UTC"},
        "request_brain": interpret_request(
            "invoices", now=NOW, timezone="UTC", picked_period=(START, END)
        ).as_checkpoint(),
        "content_phase": {"stage": "planned", "candidates": []},
    }
    rows = [
        _row(f"scan{day:02d}", f"Scan {day}.pdf", when=f"2026-09-{day:02d}T10:00:00.000Z")
        for day in (3, 9, 27, 14, 21)
    ]
    assert _remember_content_candidates(checkpoint, rows, source="walk") == 5
    pool = checkpoint["content_phase"]["candidates"]
    assert [item["id"] for item in pool] == ["scan27", "scan21", "scan14"]
    assert checkpoint["coverage_counts"]["contentCandidatesDropped"] == 2
    # A repeat is not added twice; a finished phase takes no more candidates.
    assert _remember_content_candidates(checkpoint, rows[2:3], source="walk") == 0
    checkpoint["content_phase"]["stage"] = "done"
    assert _remember_content_candidates(checkpoint, [_row("late", "Late.pdf")], source="walk") == 0


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz is None else NOW.astimezone(tz)


class FakeContentCheck:
    """Records each call; answers with the given outcome builder."""

    def __init__(self, answer, *, enabled=True):
        self.answer = answer
        self.enabled = enabled
        self.calls = []

    async def check_files(self, **kwargs):
        self.calls.append(kwargs)
        return self.answer(kwargs)


def _phase_checkpoint(checkpoint, candidates):
    checkpoint = json.loads(json.dumps(checkpoint))
    checkpoint["phase"] = CONTENT_CHECK_PHASE
    checkpoint["request_explicit_dates"] = True
    checkpoint["content_phase"] = {"stage": "planned", "candidates": candidates, "seeded": True}
    return checkpoint


def _compact(identity, title, *, source="walk"):
    return {
        "id": identity,
        "title": title,
        "mimeType": PDF,
        "createdTime": IN_PERIOD,
        "modifiedTime": IN_PERIOD,
        "capabilities": {"canShare": True},
        "source": source,
    }


def _result(identity, *, met=True, in_period=True, status="checked"):
    return ContentFileResult(
        file_id=identity,
        status=status,
        reasons=("shared_folder_only",),
        matched=(0, 1) if met else (0,),
        requirement_met=met,
        in_period=in_period,
        date_found="2026-09-14" if in_period else None,
        date_basis="content",
    )


async def _content_page(checkpoint, check, *, owner_index=None):
    store = SimpleNamespace(require_current=AsyncMock())
    service = DriveOwnerSearchService(
        store=store,
        transport=SimpleNamespace(),
        owner_index=owner_index or NoOwnerIndex(),
        content_check=check,
    )
    job = {"user_id": "owner", "job_id": "job", "generation": 7, "checkpoint": checkpoint}
    return await service._page(job), store


@pytest.mark.asyncio
async def test_content_hits_become_possible_matches_and_the_phase_leaves_no_text_behind():
    _, planned = await _planned()
    checkpoint = _phase_checkpoint(
        planned,
        [_compact("scan", "Scan_0042.pdf"), _compact("memo", "Memo.pdf", source="index")],
    )

    def answer(kwargs):
        results = (_result("scan"), _result("memo", met=False))
        return ContentCheckOutcome(
            "complete",
            results=results,
            checkpoint={"version": 1, "results": [r.as_checkpoint() for r in results]},
            counts={"selected": 2},
        )

    check = FakeContentCheck(answer)
    (checkpoint, files, incomplete, done), store = await _content_page(checkpoint, check)
    [call] = check.calls
    # The check reads the REST shape: a walked row says so, names stay names.
    assert [row["id"] for row in call["candidates"]] == ["scan", "memo"]
    assert call["candidates"][0]["source"] == "walk" and "source" not in call["candidates"][1]
    assert call["candidates"][0]["name"] == "Scan_0042.pdf"
    assert call["connection_generation"] == 7 and call["precedence"] is True
    assert call["period"] == planned["requested_period"]
    await call["require_current"]()
    store.require_current.assert_awaited()
    # Only the requirement-met, in-period hit is kept: a content possible match.
    assert [file["id"] for file in files] == ["scan"]
    [scan] = files
    assert scan[EVIDENCE_KIND_FIELD] == CONTENT and scan["shareable"] is True
    assert scan["openUrl"] == "https://drive.google.com/open?id=scan"
    assert awaiting_owner(checkpoint, scan) is True
    assert (incomplete, done) == (False, True)
    # Nothing readable stays: candidates and per-file results are dropped.
    assert checkpoint["content_phase"] == {"stage": "done", "seeded": True, "pages": 1}
    assert checkpoint["coverage_manifest"]["contentCheck"] == "complete"
    counts = checkpoint["coverage_counts"]
    assert counts["contentPossibleMatches"] == 1 and counts["contentFilesRead"] == 2
    assert not counts.get("coveragePartial")


@pytest.mark.asyncio
async def test_disabled_or_api_process_content_check_reads_nothing_and_stays_full_coverage(
    monkeypatch,
):
    _, planned = await _planned()
    candidates = [_compact("scan", "Scan_0042.pdf")]
    check = FakeContentCheck(
        lambda kwargs: pytest.fail("a disabled check never runs"), enabled=False
    )
    (checkpoint, files, _, done), _ = await _content_page(
        _phase_checkpoint(planned, candidates), check
    )
    assert (files, done, check.calls) == ([], True, [])
    assert checkpoint["coverage_manifest"]["contentCheck"] == "disabled"
    assert not checkpoint["coverage_counts"].get("coveragePartial")
    # The default in a process that is not the drained worker is the no-op.
    monkeypatch.delenv("DRIVE_WORKER_MODE", raising=False)
    (checkpoint, files, _, done), _ = await _content_page(
        _phase_checkpoint(planned, candidates), None
    )
    assert (files, done) == ([], True)
    assert checkpoint["coverage_manifest"]["contentCheck"] == "disabled"
    assert isinstance(search_module.default_content_check(), NoContentCheck)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["partial", "budget_exhausted"])
async def test_files_left_unread_make_coverage_partial(monkeypatch, status):
    monkeypatch.setattr(search_module, "MAX_CONTENT_CHECK_PAGES", 2)
    _, planned = await _planned()
    checkpoint = _phase_checkpoint(
        planned, [_compact("scan", "Scan_0042.pdf"), _compact("more", "More.pdf")]
    )
    check = FakeContentCheck(
        lambda kwargs: ContentCheckOutcome(
            status,
            results=(_result("scan"),),
            checkpoint={"version": 1, "page": len(check.calls)},
            pending=1,
        )
    )
    (checkpoint, files, _, done), _ = await _content_page(checkpoint, check)
    if status == "partial":
        # Below the page cap a partial check resumes from its own state.
        assert done is False and [file["id"] for file in files] == ["scan"]
        assert checkpoint["content_phase"]["check"] == {"version": 1, "page": 1}
        (checkpoint, files, _, done), _ = await _content_page(checkpoint, check)
        assert check.calls[1]["checkpoint"] == {"version": 1, "page": 1}
        # The same hit is committed once only.
        assert files == []
    assert done is True
    counts = checkpoint["coverage_counts"]
    assert counts["coveragePartial"] is True and counts["contentCheckIncomplete"] is True
    assert checkpoint["coverage_manifest"]["contentCheck"] == status


@pytest.mark.asyncio
async def test_gear_one_recent_rows_seed_the_phase(monkeypatch):
    _, planned = await _planned()
    monkeypatch.setattr(search_module, "datetime", _FrozenDatetime)
    checkpoint = _phase_checkpoint(planned, [])
    checkpoint["content_phase"].pop("seeded")
    fresh = _iso(NOW - timedelta(hours=2))

    class RecentIndex:
        enabled = True

        def __init__(self):
            self.calls = []

        async def recent_files(self, **kwargs):
            self.calls.append(kwargs)
            rest = {
                "id": "fresh",
                "name": "Untitled document.pdf",
                "mimeType": PDF,
                "createdTime": fresh,
                "modifiedTime": fresh,
                "size": "4096",
                "capabilities": {"canShare": True, "canDownload": True},
            }
            stale = {**rest, "id": "stale", "createdTime": IN_PERIOD, "modifiedTime": IN_PERIOD}
            return [rest, stale]

    index = RecentIndex()
    check = FakeContentCheck(
        lambda kwargs: ContentCheckOutcome("complete", results=(), checkpoint={"version": 1})
    )
    (checkpoint, _, _, done), _ = await _content_page(checkpoint, check, owner_index=index)
    [call] = index.calls
    assert call["since"] == "2026-08-31" and call["connection_generation"] == 7
    # The fresh upload is Drive-blind; the stale small file is not read.
    assert [row["id"] for row in check.calls[0]["candidates"]] == ["fresh"]
    assert check.calls[0]["candidates"][0]["size"] == 4096
    assert done is True and checkpoint["content_phase"]["seeded"] is True


@pytest.mark.asyncio
async def test_a_content_page_never_starts_without_its_budget():
    _, planned = await _planned()
    checkpoint = _phase_checkpoint(planned, [_compact("scan", "Scan_0042.pdf")])
    check = FakeContentCheck(lambda kwargs: pytest.fail("no time left for a content page"))
    token = search_module._SLICE_DEADLINE.set(search_module._clock() + 3)
    try:
        (checkpoint, files, _, done), _ = await _content_page(checkpoint, check)
    finally:
        search_module._SLICE_DEADLINE.reset(token)
    assert (files, done, check.calls) == ([], False, [])
    assert checkpoint["content_phase"]["stage"] == "planned"


@pytest.mark.asyncio
async def test_the_walk_hands_its_unmatched_rows_to_the_content_phase(monkeypatch):
    monkeypatch.setenv("DRIVE_WORKER_MODE", "true")
    service, planned = await _planned()
    checkpoint = json.loads(json.dumps(planned))
    checkpoint.update(phase="shared_walk", request_explicit_dates=True)
    checkpoint["shared_walk"].update(stage="folders", queue=[["sharedroot", None, None]])

    async def read(*, user_id, tool_name, arguments):
        from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult

        assert arguments["folderId"] == "sharedroot"
        files = [
            _row("walk_title", "Standup notes walked.pdf"),
            _row("walk_scan", "Scan_0042.pdf"),
        ]
        return ExternalMcpToolResult(
            False, {"files": files, "nextPageToken": None, "incompleteSearch": False}, False
        )

    service.transport = SimpleNamespace(read_tool=read)
    service.store = SimpleNamespace(require_current=AsyncMock())
    job = {"user_id": "owner", "job_id": "job", "generation": 7, "checkpoint": checkpoint}
    checkpoint, files, _, done = await service._page(job)
    # The walked title match is a result; the scan waits for the content phase.
    assert [file["id"] for file in files] == ["walk_title"]
    assert done is False and checkpoint["phase"] == CONTENT_CHECK_PHASE
    assert [item["id"] for item in checkpoint["content_phase"]["candidates"]] == ["walk_scan"]
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "complete"
    # Negative control: without a planned content phase the walk ends the search.
    checkpoint = json.loads(json.dumps(planned))
    checkpoint.update(phase="shared_walk", request_explicit_dates=True)
    checkpoint["shared_walk"].update(stage="folders", queue=[["sharedroot", None, None]])
    checkpoint.pop("content_phase")
    job["checkpoint"] = checkpoint
    checkpoint, _, _, done = await service._page(job)
    assert done is True and checkpoint["phase"] == "shared_walk"


# --- Gear 1 keeps size and lists recent rows without calling Drive ------------


def test_gear_one_keeps_size_and_lists_recent_rows_newest_first():
    rows = [
        _row("a", "A.pdf", when="2026-09-02T10:00:00.000Z", size=2048),
        _row("b", "B.pdf", when="2026-09-20T10:00:00.000Z"),
        _row("c", "Scans", "application/vnd.google-apps.folder", when="2026-09-25T10:00:00.000Z"),
        _row(
            "d",
            "D.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            when="2026-09-21T10:00:00.000Z",
            size="12",
        ),
        _row("e", "E.pdf", when="2026-07-01T10:00:00.000Z"),
    ]
    index = build_index(rows)
    since = datetime(2026, 9, 1, tzinfo=UTC).timestamp()
    recent = index.recent(since_ts=since, mime_filter=lambda mime: mime == PDF, limit=10)
    assert [row["id"] for row in recent] == ["b", "a"]
    assert recent[1]["size"] == 2048 and "size" not in recent[0]
    # A malformed size is no size; the row itself is kept.
    every = index.recent(since_ts=None, limit=10)
    assert [row["id"] for row in every] == ["d", "b", "a", "e"]
    assert "size" not in every[0]
    assert len(index.recent(since_ts=None, limit=1)) == 1
    with pytest.raises(Exception, match="invalid_argument"):
        index.recent(since_ts=None, limit=0)
    assert OwnerMetadataIndex().recent(since_ts=None) == []


@pytest.mark.asyncio
async def test_the_index_port_returns_rest_rows_and_never_lists_drive():
    indexer = OwnerMetadataIndexer(transport=SimpleNamespace())
    indexer.remember(
        "owner",
        [
            _row("doc", "Statement.pdf", when="2026-09-20T10:00:00.000Z", size=31 * MB),
            _row("img", "IMG_1.jpg", "image/jpeg", when="2026-09-21T10:00:00.000Z"),
        ],
        connection_generation=7,
    )
    port = MetadataOwnerIndex(indexer=indexer)
    rows = await port.recent_files(
        owner_id="owner", since="2026-08-31", file_kind="document", connection_generation=7
    )
    # Drive's REST shape (size as a decimal string), kind-filtered, no listing.
    assert [(row["id"], row["name"], row["size"]) for row in rows] == [
        ("doc", "Statement.pdf", str(31 * MB))
    ]
    assert await port.recent_files(owner_id="owner", since=None, file_kind="any") == []
    assert (
        await port.recent_files(
            owner_id="owner", since="not-a-day", file_kind="any", connection_generation=7
        )
        == []
    )
    assert await NoOwnerIndex().recent_files(owner_id="owner", since=None, file_kind="any") == []


# --- the parser child can load the dates module without hushh_mcp -------------


def test_title_dates_load_in_the_parser_child_without_the_package(tmp_path):
    """drive_content_check_leaf imports drive_title_dates beside itself.

    The child has no hushh_mcp on its path; a package import there crashed
    every request-time content read (processor_unavailable).
    """
    services = Path(search_module.__file__).resolve().parent
    script = (
        "import sys\n"
        f"sys.path.insert(0, {str(services)!r})\n"
        "import drive_title_dates\n"
        "raw = drive_title_dates.parse_title_dates('statement २०२६-०९-१४.pdf')\n"
        "assert raw, raw\n"
        "assert not any(name.startswith('hushh_mcp') for name in sys.modules)\n"
        "print('ok')\n"
    )
    completed = subprocess.run(  # noqa: S603 - fixed interpreter and inline test script
        [sys.executable, "-I", "-c", script],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env={"PATH": os.defpath, "LANG": "C.UTF-8"},
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr[-2000:]
    assert completed.stdout.strip() == "ok"


def test_every_possible_kind_the_search_writes_is_one_o4_lists():
    assert {CONTENT, CORRECTED, SYNONYM, WALK} == POSSIBLE_KINDS
