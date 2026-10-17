"""Corpus coverage and query shape for Drive request searches.

The shared-folder walk (folders shared with the owner, folder-shortcut targets,
breadth first, bounded and resumable), "shared with me" scope, codes searched
as phrases, and Devanagari words. Synthetic Drive metadata only, behind the
real fenced REST transport and its projection.
"""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import UTC, date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import drive_owner_metadata_index as gear1
from hushh_mcp.services import drive_owner_search_service as search_module
from hushh_mcp.services import drive_request_brain as brain_module
from hushh_mcp.services import drive_text_tokens as tokens
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_owner_index_port import MetadataOwnerIndex, NoOwnerIndex
from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    _brain_title_evidence,
    _brain_title_has,
    _in_requested_period,
    compile_queries,
    compile_request_queries,
)
from hushh_mcp.services.drive_request_brain import (
    full_text_phrase,
    interpret_request,
    suggested_plan,
)
from hushh_mcp.services.drive_request_review_policy import AUTOSHARE_SELECTION_POLICY
from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan
from hushh_mcp.services.drive_title_dates import parse_title_dates
from hushh_mcp.services.google_drive_adapter import (
    FACT_FIELDS,
    LIST_FIELDS,
    LIVE_POLICY_HASH,
    DriveReadError,
    GoogleDriveAdapter,
)

FOLDER = search_module.FOLDER_MIME
SHORTCUT = search_module.SHORTCUT_MIME
NOW = datetime(2026, 10, 3, tzinfo=UTC)
PICKED = (date(2026, 9, 1), date(2026, 9, 30))
PERIOD = {"start": "2026-09-01", "end": "2026-09-30", "timezone": "UTC"}
SEED_FOLDERS = "sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder'"
SEED_SHORTCUTS = "mimeType = 'application/vnd.google-apps.shortcut'"
_PARENT = re.compile(r"'([A-Za-z0-9_-]+)' in parents")
HINDI_NAME = "हिंदी बैंक स्टेटमेंट.pdf"


def row(identity, name, mime="application/pdf", **extra):
    return {
        "id": identity,
        "name": name,
        "mimeType": mime,
        "createdTime": "2026-09-10T00:00:00Z",
        "modifiedTime": "2026-09-10T00:00:00Z",
        "webViewLink": f"https://drive.google.com/file/d/{identity}/view",
        "capabilities": {"canShare": True},
        **extra,
    }


def folder(identity, name="Shared folder"):
    return row(identity, name, FOLDER)


def folder_shortcut(identity, target, *, key=None):
    return row(
        identity,
        "Shortcut to a folder",
        SHORTCUT,
        shortcutDetails={
            "targetId": target,
            "targetMimeType": FOLDER,
            **({"targetResourceKey": key} if key else {}),
        },
    )


class FakeDrive(GoogleDriveAdapter):
    """files.list for the two seed listings and one folder level; files.get."""

    def __init__(self, *, shared=(), shortcuts=(), children=None, targets=None, unavailable=()):
        super().__init__()
        self.shared = list(shared)
        self.shortcuts = list(shortcuts)
        self.children = children or {}
        self.targets = targets or {}
        self.unavailable = set(unavailable)
        self.calls = []

    async def _get(
        self, path, *, access_token, params, limit, resource_keys=None, owner_search_page=False
    ):
        assert access_token == "synthetic-token"
        self.calls.append((path, dict(params), resource_keys))
        if path.startswith("/files/"):
            assert params["fields"] == FACT_FIELDS
            return json.dumps(self.targets[path.removeprefix("/files/")]).encode()
        assert path == "/files" and params["fields"] == LIST_FIELDS
        # The walk never sends content queries or a sort Drive would refuse.
        assert "fullText" not in params["q"] and params["corpora"] == "user"
        query = params["q"]
        if SEED_FOLDERS in query:
            files = self.shared
        elif SEED_SHORTCUTS in query:
            files = self.shortcuts
        else:
            parent = _PARENT.search(query).group(1)
            assert "trashed = false" in query
            if parent in self.unavailable:
                raise DriveReadError("source_unavailable", status_code=403)
            files = self.children.get(parent, [])
        size, start = int(params["pageSize"]), int(params.get("pageToken", "0"))
        more = start + size < len(files)
        return json.dumps(
            {
                "files": files[start : start + size],
                **({"nextPageToken": str(start + size)} if more else {}),
                "incompleteSearch": False,
            }
        ).encode()

    def listed(self):
        """Listings in call order: the two seeds, then folder IDs."""
        order = []
        for path, params, _ in self.calls:
            if path != "/files":
                continue
            query = params["q"]
            order.append(
                "seed:folders"
                if SEED_FOLDERS in query
                else "seed:shortcuts"
                if SEED_SHORTCUTS in query
                else _PARENT.search(query).group(1)
            )
        return order


def service_for(monkeypatch, drive, *, owner_index=None, worker=True):
    monkeypatch.setattr(rest, "connector_feature_enabled", lambda *_: True)
    if worker:
        monkeypatch.setenv("DRIVE_WORKER_MODE", "true")
    else:
        monkeypatch.delenv("DRIVE_WORKER_MODE", raising=False)
    current = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 7,
    }
    oauth = SimpleNamespace(
        current_credential=AsyncMock(return_value=(current, {"accessToken": "synthetic-token"})),
        lifecycle=SimpleNamespace(read=AsyncMock(return_value=current)),
    )
    return DriveOwnerSearchService(
        transport=rest.GoogleDriveRestTransport(oauth=oauth, adapter=drive),
        owner_index=owner_index,
    )


def walk_checkpoint(text="bank statement", *, autoshare=False, **extra):
    brain = interpret_request(text, now=NOW, timezone="UTC", picked_period=PICKED)
    return {
        "request_origin_id": "synthetic-request",
        "request_explicit_dates": True,
        "request": {"query": text},
        "request_brain": brain.as_checkpoint(),
        "request_file_kind": brain.file_kind,
        "request_subject_terms": [],
        "request_owner_review_required": not autoshare,
        "requested_period": PERIOD,
        "authority_mode": "trusted_auto" if autoshare else "owner",
        **({"request_selection_policy": AUTOSHARE_SELECTION_POLICY} if autoshare else {}),
        "queries": [{"arguments": {"query": "name contains 'bank'"}}],
        "query_index": 0,
        "arguments": {"query": "name contains 'bank'"},
        "phase": "shared_walk",
        "page_token": None,
        "drive_page_token": None,
        "drives": [],
        "drive_index": 0,
        "seen_tokens": [],
        "drive_tokens": [],
        "folder_queue": [],
        "folder_digests": [],
        "coverage_manifest": {"sharedFolderWalk": "planned"},
        "coverage_counts": {},
        "shared_walk": {
            "stage": "seed_folders",
            "queue": [],
            "visited": [],
            "token": None,
            "tokens": [],
        },
        **extra,
    }


async def walk_all(service_factory, checkpoint, *, durable=False, limit=200):
    """Run walk pages until done; durable: a fresh service and JSON per page."""
    files, service = [], service_factory()
    for _ in range(limit):
        checkpoint, page, incomplete, done = await service._page(
            {"user_id": "owner", "generation": 7, "checkpoint": checkpoint}
        )
        # A walk never makes the search incomplete; coverage says partial.
        assert incomplete is False
        files.extend(page)
        if durable:
            checkpoint = json.loads(json.dumps(checkpoint))
            service = service_factory()
        if done:
            return checkpoint, files
    raise AssertionError("walk did not finish")


def nested_tree():
    return FakeDrive(
        shared=[folder("F1", "From Rahul")],
        children={
            "F1": [
                row("jan", "Bank Statement Jan.pdf"),
                row("photo", "Holiday photo.jpg", "image/jpeg"),
                folder("F2", "2026"),
            ],
            "F2": [row("feb", "bank_statement_feb.pdf"), folder("F3", "Old")],
            "F3": [row("mar", "BankStatement Mar.pdf")],
        },
    )


# --- Shared-folder walk -----------------------------------------------------


async def test_walk_lists_nested_shared_folders_breadth_first_into_candidates(monkeypatch):
    drive = nested_tree()
    checkpoint, files = await walk_all(lambda: service_for(monkeypatch, drive), walk_checkpoint())
    assert drive.listed() == ["seed:folders", "seed:shortcuts", "F1", "F2", "F3"]
    # Google's user corpus never returned these: they sit in a shared tree.
    assert {item["id"] for item in files} == {"jan", "feb", "mar"}
    assert all(item["requestEvidence"]["basis"] == "provider_search" for item in files)
    counts = checkpoint["coverage_counts"]
    assert counts["sharedFoldersWalked"] == 3 and counts["sharedFolderWalkCalls"] == 5
    assert counts["sharedFolderWalkFiles"] == 4 and counts["sharedFolderWalkCandidates"] == 3
    assert counts.get("coveragePartial") is not True
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "complete"
    assert checkpoint["shared_walk"]["stage"] == "done"
    assert checkpoint["shared_walk"]["queue"] == checkpoint["shared_walk"]["visited"] == []
    for path, params, _ in drive.calls:
        if path == "/files":
            assert params["orderBy"] == "modifiedTime desc" and params["pageSize"] == "1000"


async def test_walk_cycle_guard_lists_each_folder_once(monkeypatch):
    drive = FakeDrive(
        shared=[folder("F1"), folder("F2")],
        children={
            # Shortcut cycle F1 -> F2 -> F1, and F2 reached again as a child.
            "F1": [folder_shortcut("S1", "F2"), row("one", "Bank statement one.pdf")],
            "F2": [folder_shortcut("S2", "F1"), folder("F1"), row("two", "Bank statement two.pdf")],
        },
    )
    checkpoint, files = await walk_all(lambda: service_for(monkeypatch, drive), walk_checkpoint())
    assert drive.listed() == ["seed:folders", "seed:shortcuts", "F1", "F2"]
    assert {item["id"] for item in files} == {"one", "two"}
    assert checkpoint["coverage_counts"]["sharedFolderWalkRepeats"] == 3
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "complete"


async def test_walk_follows_folder_shortcut_targets_with_their_resource_keys(monkeypatch):
    drive = FakeDrive(
        shortcuts=[
            folder_shortcut("S1", "T1", key="target-key"),
            # A file shortcut in the owner's own Drive is Drive's pass, not the walk's.
            row("own", "Bank statement own", SHORTCUT, shortcutDetails={"targetId": "X0"}),
        ],
        children={
            "T1": [
                row(
                    "S2",
                    "Bank statement alias",
                    SHORTCUT,
                    shortcutDetails={"targetId": "X1", "targetMimeType": "application/pdf"},
                ),
                row("plain", "Bank Statement Sep.pdf"),
            ]
        },
        targets={"X1": row("X1", "Bank Statement Aug.pdf", driveId="team-drive", trashed=False)},
    )
    checkpoint, files = await walk_all(lambda: service_for(monkeypatch, drive), walk_checkpoint())
    assert drive.listed() == ["seed:folders", "seed:shortcuts", "T1"]
    listing = next(call for call in drive.calls if "'T1' in parents" in call[1].get("q", ""))
    assert listing[2] == {"T1": "target-key"}
    assert {item["id"] for item in files} == {"X1", "plain"}
    alias = next(item for item in files if item["id"] == "X1")
    assert alias["shortcutName"] == "Bank statement alias"
    assert [call[0] for call in drive.calls].count("/files/X1") == 1
    assert "/files/X0" not in [call[0] for call in drive.calls]


def _wide_tree():
    return FakeDrive(
        shared=[folder("F1"), folder("F2")],
        children={
            "F1": [folder("F3"), folder("F4"), row("a", "Bank statement A.pdf")],
            "F2": [row("b", "Bank statement B.pdf")],
            "F3": [row("c", "Bank statement C.pdf")],
            "F4": [row("d", "Bank statement D.pdf")],
        },
    )


async def test_walk_budget_exhaustion_is_partial_coverage_and_resumes_durably(monkeypatch):
    monkeypatch.setattr(search_module, "MAX_WALK_CALLS", 4)
    drive = _wide_tree()
    checkpoint, files = await walk_all(
        lambda: service_for(monkeypatch, drive), walk_checkpoint(), durable=True
    )
    # Every page resumed from the JSON checkpoint with a new service: no
    # folder was listed twice and the walk stopped at its call budget.
    assert drive.listed() == ["seed:folders", "seed:shortcuts", "F1", "F2"]
    assert {item["id"] for item in files} == {"a", "b"}
    counts = checkpoint["coverage_counts"]
    assert counts["sharedFolderWalkCalls"] == 4
    assert counts["coveragePartial"] is True and counts["sharedFolderWalkLimitReached"] is True
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "partial"


async def test_same_tree_within_budget_is_complete(monkeypatch):
    drive = _wide_tree()
    checkpoint, files = await walk_all(
        lambda: service_for(monkeypatch, drive), walk_checkpoint(), durable=True
    )
    assert drive.listed() == ["seed:folders", "seed:shortcuts", "F1", "F2", "F3", "F4"]
    assert {item["id"] for item in files} == {"a", "b", "c", "d"}
    assert checkpoint["coverage_counts"].get("coveragePartial") is not True
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "complete"


async def test_walk_folder_budget_skips_and_reports_the_rest(monkeypatch):
    monkeypatch.setattr(search_module, "MAX_WALK_FOLDERS", 2)
    drive = _wide_tree()
    checkpoint, files = await walk_all(lambda: service_for(monkeypatch, drive), walk_checkpoint())
    assert drive.listed() == ["seed:folders", "seed:shortcuts", "F1", "F2"]
    assert checkpoint["coverage_counts"]["sharedFolderWalkSkipped"] == 2
    assert checkpoint["coverage_counts"]["coveragePartial"] is True
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "partial"


async def test_walk_resumes_mid_folder_from_its_saved_page_token(monkeypatch):
    rows = [row(f"r{index}", f"Bank statement {index}.pdf") for index in range(30)]
    drive = FakeDrive(shared=[folder("F1")], children={"F1": rows})
    checkpoint = walk_checkpoint()
    # A transport without the owner-search lane pages 25 rows at a time.
    service = service_for(monkeypatch, drive)
    service.transport = SimpleNamespace(read_tool=service.transport.read_tool)
    files = []
    for _ in range(5):
        checkpoint, page, _, done = await service._page(
            {"user_id": "owner", "generation": 7, "checkpoint": checkpoint}
        )
        files.extend(page)
        checkpoint = json.loads(json.dumps(checkpoint))
        if done:
            break
    assert done and len(files) == 30
    tokens = [params.get("pageToken") for path, params, _ in drive.calls if path == "/files"]
    assert tokens == [None, None, None, "25"]
    assert checkpoint["coverage_counts"]["sharedFoldersWalked"] == 1


async def test_unavailable_folder_is_skipped_without_failing_the_search(monkeypatch):
    drive = FakeDrive(
        shared=[folder("F1"), folder("F2")],
        children={"F2": [row("kept", "Bank statement kept.pdf")]},
        unavailable={"F1"},
    )
    checkpoint, files = await walk_all(lambda: service_for(monkeypatch, drive), walk_checkpoint())
    assert [item["id"] for item in files] == ["kept"]
    assert checkpoint["coverage_counts"]["sharedFolderWalkUnavailable"] == 1
    # Lost access is not a coverage gap: nothing in it could be shared.
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "complete"


@pytest.mark.parametrize("switch", ["flag_off", "api_process"])
async def test_kill_switch_and_api_process_never_list_a_folder(monkeypatch, switch):
    drive = nested_tree()
    if switch == "flag_off":
        monkeypatch.setenv(search_module.SHARED_WALK_FLAG, "false")
    service = service_for(monkeypatch, drive, worker=switch != "api_process")
    checkpoint, files, incomplete, done = await service._page(
        {"user_id": "owner", "generation": 7, "checkpoint": walk_checkpoint()}
    )
    assert drive.calls == [] and files == [] and incomplete is False and done is True
    assert checkpoint["coverage_counts"]["coveragePartial"] is True
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "stopped"


async def test_six_level_tree_with_a_cycle_and_a_forbidden_branch(monkeypatch):
    children = {
        f"L{level}": [
            row(f"f{level}", f"Bank statement level {level}.pdf"),
            folder(f"L{level + 1}"),
        ]
        for level in range(1, 6)
    }
    # The deepest folder links back to the root, and a branch at level 2 is forbidden.
    children["L6"] = [row("f6", "Bank statement level 6.pdf"), folder_shortcut("S", "L1")]
    children["L2"].append(folder("NOPE"))
    drive = FakeDrive(shared=[folder("L1")], children=children, unavailable={"NOPE"})
    checkpoint, files = await walk_all(lambda: service_for(monkeypatch, drive), walk_checkpoint())
    assert drive.listed() == [
        "seed:folders",
        "seed:shortcuts",
        "L1",
        "L2",
        "L3",
        "NOPE",
        "L4",
        "L5",
        "L6",
    ]
    assert {item["id"] for item in files} == {f"f{level}" for level in range(1, 7)}
    counts = checkpoint["coverage_counts"]
    assert counts["sharedFoldersWalked"] == 6 and counts["sharedFolderWalkUnavailable"] == 1
    assert counts["sharedFolderWalkRepeats"] == 1
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "complete"


async def test_walk_page_over_the_response_budget_retries_the_same_cursor_smaller(monkeypatch):
    class Oversized(FakeDrive):
        async def _get(self, path, *, params, **kwargs):
            if "'F1' in parents" in params.get("q", "") and params["pageSize"] == "1000":
                self.calls.append((path, dict(params), None))
                raise DriveReadError("file_too_large")
            return await super()._get(path, params=params, **kwargs)

    drive = Oversized(shared=[folder("F1")], children={"F1": [row("a", "Bank statement A.pdf")]})
    checkpoint, files = await walk_all(lambda: service_for(monkeypatch, drive), walk_checkpoint())
    sizes = [params["pageSize"] for path, params, _ in drive.calls if "'F1'" in params.get("q", "")]
    assert sizes == ["1000", "100"]
    assert [item["id"] for item in files] == ["a"]
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "complete"


async def test_walk_reads_at_most_its_shortcut_budget_per_page(monkeypatch):
    monkeypatch.setattr(search_module, "MAX_WALK_SHORTCUTS", 1)
    alias = {"targetMimeType": "application/pdf"}
    drive = FakeDrive(
        shared=[folder("F1")],
        children={
            "F1": [
                row(
                    "s1",
                    "Bank statement one",
                    SHORTCUT,
                    shortcutDetails={**alias, "targetId": "t1"},
                ),
                row(
                    "s2",
                    "Bank statement two",
                    SHORTCUT,
                    shortcutDetails={**alias, "targetId": "t2"},
                ),
            ]
        },
        targets={
            "t1": row("t1", "Bank statement one.pdf", trashed=False),
            "t2": row("t2", "Bank statement two.pdf", trashed=False),
        },
    )
    checkpoint, files = await walk_all(lambda: service_for(monkeypatch, drive), walk_checkpoint())
    assert len(files) == 1
    assert [call[0] for call in drive.calls if call[0].startswith("/files/")] in (
        ["/files/t1"],
        ["/files/t2"],
    )
    assert checkpoint["coverage_counts"]["sharedFolderWalkShortcutsDeferred"] == 1
    assert checkpoint["coverage_counts"]["coveragePartial"] is True


async def test_malformed_walked_rows_mark_coverage_partial(monkeypatch):
    drive = FakeDrive(
        shared=[folder("F1")],
        children={"F1": [row("a", "Bank statement A.pdf"), {**row("bad", "x"), "name": ""}]},
    )
    checkpoint, files = await walk_all(lambda: service_for(monkeypatch, drive), walk_checkpoint())
    assert [item["id"] for item in files] == ["a"]
    assert checkpoint["coverage_counts"]["sharedFolderWalkIncomplete"] is True
    assert checkpoint["coverage_manifest"]["sharedFolderWalk"] == "partial"


async def test_walked_files_never_widen_autoshare_authority(monkeypatch):
    drive = FakeDrive(
        shared=[folder("F1")],
        children={
            "F1": [
                row("evidence", "Bank Statement Sep 2026.pdf"),
                row("unshareable", "Bank Statement Sep.pdf", capabilities={"canShare": False}),
                row("other-period", "Bank Statement 2026-01-10.pdf"),
                row("no-bank", "Statement notes.pdf"),
            ]
        },
    )
    checkpoint, files = await walk_all(
        lambda: service_for(monkeypatch, drive), walk_checkpoint(autoshare=True)
    )
    by_id = {item["id"]: item for item in files}
    assert set(by_id) == {"evidence", "unshareable"}
    assert by_id["evidence"]["shareable"] is True
    assert by_id["unshareable"]["shareable"] is False
    assert by_id["unshareable"]["unavailableReason"] == "source_not_shareable"


@pytest.mark.parametrize(("autoshare", "found"), [(False, {"typo"}), (True, set())])
async def test_a_misspelled_walked_title_is_discovery_only(monkeypatch, autoshare, found):
    # Gear 1's matcher finds "Bank Statment" for "bank statement" (a typo is
    # discovery); only the owner's review may take it, never autoshare.
    drive = FakeDrive(shared=[folder("F1")], children={"F1": [row("typo", "Bank Statment.pdf")]})
    _, files = await walk_all(
        lambda: service_for(monkeypatch, drive), walk_checkpoint(autoshare=autoshare)
    )
    assert {item["id"] for item in files} == found


async def test_walked_names_feed_gear_one_under_the_listing_generation(monkeypatch):
    indexer = gear1.OwnerMetadataIndexer(transport=SimpleNamespace())
    owner_index = MetadataOwnerIndex(indexer=indexer)
    drive = nested_tree()
    await walk_all(
        lambda: service_for(monkeypatch, drive, owner_index=owner_index), walk_checkpoint()
    )
    state = indexer._owners["owner"]
    assert state.generation == 7
    matches, _ = state.index.match([["bank"], ["statement"]], precedence=False)
    assert {candidate.file["id"] for candidate in matches} == {"jan", "feb", "mar"}
    # No generation, no names; the no-op index accepts rows and keeps none.
    assert await owner_index.remember_files(owner_id="other", rows=[{}]) == 0
    assert "other" not in indexer._owners
    assert await NoOwnerIndex().remember_files(owner_id="owner", rows=[{}]) == 0


async def test_walk_starts_after_drive_passes_and_folder_children(monkeypatch):
    checkpoint = walk_checkpoint(phase="user")
    assert search_module._advance_query(checkpoint) is False
    assert checkpoint["phase"] == "shared_walk"
    # Topical folders queued by Drive's pass are listed first.
    checkpoint = walk_checkpoint(phase="user", folder_queue=[{"id": "topical"}])
    assert search_module._advance_query(checkpoint) is False
    assert checkpoint["phase"] == "folder_files"
    # A search without a planned walk ends where it always did.
    checkpoint = walk_checkpoint(phase="user")
    checkpoint.pop("shared_walk")
    assert search_module._advance_query(checkpoint) is True


async def _created_checkpoint(text, *, plan=None, brain=True, owner_index=None, purpose=None):
    store = SimpleNamespace(
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": "synthetic-job"}, False)),
    )
    planned = {}
    if brain:
        parsed = interpret_request(text, now=NOW, timezone="UTC", picked_period=PICKED)
        plan = LiveSearchPlan.model_validate(suggested_plan(parsed, text)).model_dump(mode="json")
        planned = {"brain": parsed.as_checkpoint(), "plan_source": "deterministic_brain"}
    service = DriveOwnerSearchService(
        store=store, transport=SimpleNamespace(), owner_index=owner_index
    )
    await service.create_for_request(
        user_id="owner",
        request_id="12345678-1234-1234-1234-123456789012",
        request_revision=1,
        purpose=purpose
        or {"purpose": text, "periodStart": "2026-09-01", "periodEnd": "2026-09-30"},
        plan=plan,
        require_current=AsyncMock(),
        authority_mode="trusted_auto",
        requested_at=NOW,
        autoshare=True,
        **planned,
    )
    return store.create.await_args.kwargs["checkpoint"]


async def test_a_subject_request_plans_the_walk_and_a_listing_does_not(monkeypatch):
    monkeypatch.delenv(search_module.SHARED_WALK_FLAG, raising=False)
    planned = await _created_checkpoint("bank statements")
    assert planned["shared_walk"]["stage"] == "seed_folders"
    assert planned["coverage_manifest"]["sharedFolderWalk"] == "planned"
    assert planned["coverage_counts"] == {}
    listing = await _created_checkpoint("all files")
    assert "shared_walk" not in listing
    assert listing["coverage_manifest"]["sharedFolderWalk"] == "not_applicable"
    monkeypatch.setenv(search_module.SHARED_WALK_FLAG, "false")
    disabled = await _created_checkpoint("bank statements")
    assert "shared_walk" not in disabled
    assert disabled["coverage_manifest"]["sharedFolderWalk"] == "disabled"
    assert disabled["coverage_counts"] == {"coveragePartial": True}


# --- "Shared with me" -------------------------------------------------------


def _shared_plan(**changes):
    return {
        "mode": "find",
        "terms": ["invoice"],
        "file_kind": "document",
        "time_intent": "document_coverage",
        "shared_with_me": True,
        **changes,
    }


def test_shared_with_me_lists_not_owned_files_in_the_user_corpus_only():
    purpose = {"purpose": "invoices", "periodStart": "2026-09-01", "periodEnd": "2026-09-30"}
    queries, _ = compile_request_queries(_shared_plan(), purpose, "UTC", requested_at=NOW)
    assert queries
    for query in queries:
        assert "not 'me' in owners" in query["arguments"]["query"]
        assert "sharedWithMe" not in query["arguments"]["query"]
        assert query["corpora"] == "user"
    owner_started = compile_queries(_shared_plan(), "UTC")
    assert all("not 'me' in owners" in query["arguments"]["query"] for query in owner_started)
    assert all("sharedWithMe" not in query["arguments"]["query"] for query in owner_started)
    assert all(query["corpora"] == "user" for query in owner_started)
    # Negative control: an ordinary request keeps every corpus and no owner clause.
    plain, _ = compile_request_queries(
        _shared_plan(shared_with_me=False), purpose, "UTC", requested_at=NOW
    )
    assert all("owners" not in query["arguments"]["query"] for query in plain)
    assert all("corpora" not in query for query in plain)


@pytest.mark.parametrize(("corpora", "phase"), [("user", "user"), (None, "drives")])
async def test_shared_with_me_query_skips_the_shared_drive_pass(corpora, phase):
    queries = [
        {"arguments": {"query": "name contains 'a'"}, **({"corpora": corpora} if corpora else {})},
        {"arguments": {"query": "name contains 'b'"}, **({"corpora": corpora} if corpora else {})},
    ]
    checkpoint = walk_checkpoint(phase="user", queries=queries, arguments=queries[0]["arguments"])
    checkpoint.pop("shared_walk")
    reader = AsyncMock(
        return_value=SimpleNamespace(
            is_error=False,
            truncated=False,
            payload={"files": [], "nextPageToken": None, "incompleteSearch": False},
        )
    )
    service = DriveOwnerSearchService(transport=SimpleNamespace(read_tool=reader))
    checkpoint, _, _, done = await service._page({"user_id": "owner", "checkpoint": checkpoint})
    assert done is False and checkpoint["phase"] == phase
    assert checkpoint["query_index"] == (1 if corpora else 0)


async def test_shared_with_me_request_records_scope_and_skips_ownerless_gear_one(monkeypatch):
    monkeypatch.delenv(search_module.SHARED_WALK_FLAG, raising=False)
    owner_index = SimpleNamespace(enabled=True)
    checkpoint = await _created_checkpoint(
        "invoices", plan=_shared_plan(), brain=False, owner_index=owner_index
    )
    assert checkpoint["request_shared_with_me"] is True
    assert "local_offset" not in checkpoint
    assert checkpoint["coverage_manifest"]["sharedWithMeScope"] == "not_owned_user_corpus_and_walk"
    assert checkpoint["shared_walk"]["stage"] == "seed_folders"
    assert all(query["corpora"] == "user" for query in checkpoint["queries"])


async def test_shared_with_me_walk_lists_only_files_others_own(monkeypatch):
    drive = FakeDrive(shared=[folder("F1")], children={"F1": [row("x", "Invoice Sep.pdf")]})
    checkpoint = walk_checkpoint("invoice", request_shared_with_me=True)
    await walk_all(lambda: service_for(monkeypatch, drive), checkpoint)
    listing = next(call for call in drive.calls if "'F1' in parents" in call[1].get("q", ""))
    assert "not 'me' in owners" in listing[1]["q"]


# --- Codes ------------------------------------------------------------------


def _brain_queries(text):
    brain = interpret_request(text, now=NOW, timezone="UTC", picked_period=PICKED)
    plan = LiveSearchPlan.model_validate(suggested_plan(brain, text)).model_dump(mode="json")
    purpose = {"purpose": text, "periodStart": "2026-09-01", "periodEnd": "2026-09-30"}
    queries, _ = compile_request_queries(plan, purpose, "UTC", requested_at=NOW, brain=brain)
    return brain, queries


def test_a_code_compiles_as_one_spaced_fulltext_phrase_without_order_by():
    brain, queries = _brain_queries("INV_2026_HDFC_9981 invoice")
    assert [concept.canonical for concept in brain.topics] == ["inv_2026_hdfc_9981"]
    assert brain.topics[0].title_evidence == ("inv_2026_hdfc_9981",)
    # The frozen checkpoint carries the code concept unchanged.
    assert brain_module.brain_from_checkpoint(brain.as_checkpoint()) == brain
    title, content = (query["arguments"] for query in queries)
    assert "name contains 'inv_2026_hdfc_9981'" in title["query"]
    assert "name contains 'inv2026hdfc9981'" in title["query"]
    assert "fullText" not in title["query"] and title["orderBy"] == "modifiedTime desc"
    assert "fullText contains '\"inv 2026 hdfc 9981\"'" in content["query"]
    assert "orderBy" not in content and rest.has_full_text_term(content["query"])
    # Negative control: the code is never split into separately required words.
    assert "fullText contains 'hdfc'" not in content["query"]
    assert "name contains '2026'" not in content["query"]


@pytest.mark.parametrize(
    ("text", "topics", "part", "period"),
    [
        ("send me INV-2026-001", ["inv-2026-001"], None, None),
        ("INV/2026/77 receipts", ["inv/2026/77"], "invoice", None),
        ("bank statements Sep-2026", [], "bank_statement", {"start": "2026-01-01"}),
        ("form-16 for 2025", [], "tax", {"start": "2025-01-01"}),
        ("invoice 9981", ["9981"], "invoice", None),
    ],
)
def test_codes_survive_date_parsing_and_numbers_stay_required(text, topics, part, period):
    brain = interpret_request(text, now=NOW, timezone="UTC")
    assert [concept.canonical for concept in brain.topics] == topics
    assert [item.key for item in brain.parts] == ([part] if part else [])
    if period:
        assert brain.suggested_period["start"] == period["start"]


def test_codes_rank_with_numbers_when_topics_are_bounded():
    brain = interpret_request("acme globex initech umbrella INV_2026_X", now=NOW)
    assert len(brain.topics) == brain_module.MAX_TOPICS
    assert "inv_2026_x" in [concept.canonical for concept in brain.topics]


@pytest.mark.parametrize(
    ("title", "named"),
    [
        ("INV_2026_HDFC_9981.pdf", True),
        ("INV-2026-HDFC-9981.pdf", True),
        ("Statement INV 2026 HDFC 9981.pdf", True),
        ("INV2026HDFC9981.pdf", True),
        ("INV_2026_HDFC_9981_v2.pdf", True),
        ("INV_2026_HDFC_99812.pdf", False),
        ("INV_2026_HDFC.pdf", False),
        ("XINV_2026_HDFC_9981.pdf", False),
    ],
)
def test_a_code_is_title_evidence_through_any_separator_but_never_a_longer_code(title, named):
    assert _brain_title_has("inv_2026_hdfc_9981", title) is named


def test_gear_one_still_splits_code_names():
    index = gear1.build_index(
        [
            {"id": "c1", "title": "INV-2026-HDFC-9981.pdf", "mimeType": "application/pdf"},
            {"id": "c2", "title": "INV2026HDFC9981.pdf", "mimeType": "application/pdf"},
            {"id": "c3", "title": "INV-2026-HDFC-1111.pdf", "mimeType": "application/pdf"},
        ]
    )
    matches, _ = index.match([["inv_2026_hdfc_9981", "inv2026hdfc9981"]], precedence=False)
    assert {candidate.file["id"] for candidate in matches} == {"c1", "c2"}


@pytest.mark.parametrize(
    ("value", "phrase"),
    [
        ("inv_2026_hdfc_9981", "inv 2026 hdfc 9981"),
        ("inv-2026-001", "inv 2026 001"),
        ("gstin/27aaacr", "gstin 27aaacr"),
        ("form-16", "form 16"),
        ("e-statement", "e-statement"),
        ("pay slip", "pay slip"),
        ("स्टेटमेंट", "स्टेटमेंट"),
        ("1:1", None),
    ],
)
def test_full_text_phrase_turns_code_separators_into_spaces(value, phrase):
    assert full_text_phrase(value) == phrase


# --- Unicode words ----------------------------------------------------------


def test_hindi_file_name_tokens_are_whole_words():
    assert unicodedata.is_normalized("NFC", HINDI_NAME)
    assert gear1.name_tokens(HINDI_NAME)[0] == ("हिंदी", "बैंक", "स्टेटमेंट")
    # Negative control: the old rule ([\W_]+) broke the words at every mark.
    assert "बैंक" not in re.split(r"[\W_]+", HINDI_NAME)
    # Latin accents still fold and compound names keep their tokens.
    assert gear1.name_tokens("Résumé Ankit.docx")[0] == ("resume", "ankit")
    assert gear1.name_tokens("Q3_BankStatement-final.PDF")[0] == (
        "q3",
        "bank",
        "statement",
        "final",
        "q",
        "3",
        "bankstatement",
    )


def test_decomposed_and_precomposed_devanagari_are_one_word():
    precomposed = "क़र्ज"  # क़र्ज (nukta letter U+0958)
    decomposed = "क़र्ज"
    assert tokens.fold(precomposed) == tokens.fold(decomposed)
    assert gear1.name_tokens(precomposed)[0] == gear1.name_tokens(decomposed)[0]
    assert _brain_title_has(decomposed, f"{precomposed} कागज़.pdf")


def test_every_combining_mark_is_a_word_character():
    import sys

    marks = [
        code
        for code in range(sys.maxunicode + 1)
        if unicodedata.category(chr(code))[0] == "M"
        and not (0x300 <= code < 0x20000 or 0xE0100 <= code < 0xE01F0)
    ]
    assert marks == []
    assert tokens.words("कि॑ ab") == ["कि॑", "ab"]


def test_hindi_request_words_are_whole_and_filler_is_dropped():
    brain = interpret_request("मुझे बैंक स्टेटमेंट भेजो", now=NOW)
    assert brain.topics == ()
    (part,) = brain.parts
    assert part.key == "bank_statement"
    assert [concept.title_evidence for concept in part.concepts] == [("बैंक",), ("स्टेटमेंट",)]
    assert {"bank", "बैंक"} <= set(part.concepts[0].variants)


def _evidence(text, title):
    return _brain_title_evidence(interpret_request(text, now=NOW), title)


@pytest.mark.parametrize(
    ("text", "title", "evidence"),
    [
        ("बैंक स्टेटमेंट", "बैंक स्टेटमेंट सितंबर.pdf", True),
        # Cross-script lexicon entries are discovery only, both ways.
        ("बैंक स्टेटमेंट", "Bank Statement Sep.pdf", False),
        ("bank statement", "बैंक स्टेटमेंट.pdf", False),
        ("bank statement", "Bank Statement Sep.pdf", True),
        ("रसीद", "Receipt Sep.pdf", False),
        ("रसीद", "किराया रसीद.pdf", True),
    ],
)
def test_hindi_lexicon_never_widens_title_evidence(text, title, evidence):
    assert _evidence(text, title) is evidence


def test_a_misspelled_hindi_word_is_never_corrected_into_evidence():
    brain = interpret_request("सैलरी स्लीप", now=NOW)
    assert brain.corrected is False
    assert not _brain_title_evidence(brain, "सैलरी स्लिप सितंबर.pdf")


def test_combining_marks_are_word_characters_in_title_checks():
    assert _brain_title_has("बैंक", "मेरा बैंक खाता.pdf")
    assert _brain_title_has("बैंक", "बैंक_स्टेटमेंट.pdf")
    # Negative control: "बैंक" is not a word inside "बैंकिंग" (banking); the
    # old (?!\w) boundary matched there because a vowel sign is not \w.
    assert not _brain_title_has("बैंक", "बैंकिंग गाइड.pdf")
    assert re.search(r"(?<!\w)बैंक(?!\w)", "बैंकिंग गाइड.pdf")


def test_indic_digit_title_dates_decide_the_autoshare_period():
    title = "बैंक स्टेटमेंट २०२४०११०.pdf"
    match = {
        "name": title,
        "created_time": "2026-09-10T00:00:00Z",
        "modified_time": "2026-09-10T00:00:00Z",
    }
    # The title says 2024-01-10: outside September 2026 whatever the file
    # times say. Unread, the created time would have shared it.
    assert _in_requested_period(match, PERIOD, precedence=True) is False
    assert _in_requested_period({**match, "name": "बैंक स्टेटमेंट.pdf"}, PERIOD, precedence=True)
    assert parse_title_dates(title) == parse_title_dates("x 20240110.pdf")
    assert parse_title_dates("१०-०१-२०२४") == parse_title_dates("10-01-2024")
    brain = interpret_request("सैलरी स्लिप २०२६", now=NOW)
    assert brain.suggested_period == {"start": "2026-01-01", "end": "2026-12-31"}
    assert brain.topics == ()


def test_lexicon_spellings_are_nfc():
    for entry in brain_module._ENTRIES:
        for value in (entry.canonical, *entry.triggers, *entry.variants, *entry.strict):
            assert unicodedata.is_normalized("NFC", value), value
