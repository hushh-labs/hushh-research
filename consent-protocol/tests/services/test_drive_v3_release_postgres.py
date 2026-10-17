"""Search v3 end to end on real PostgreSQL: one automatic request, every gear.

A Trusted autoshare request is planned by the real request flow
(create_for_request), searched by Drive's pass (Gear 2), Gear 1, the
shared-folder walk (O2) and the request-time content check (O3, the real
parser child; only ClamAV and the Drive download are faked), sealed by the
real store and then claimed, paid and shared through O4's classifier:

* Title matches are the only files that share themselves.
* Discovery (Drive content, a loose synonym, walked or freshly uploaded files
  read locally) waits in the owner's possible-matches list.
* Files Drive will not let us download, or that the owner cannot share, are
  never read. No text, marker or name reaches the checkpoint or logs.
* The requester reads "Files sent" only when coverage was partial (D12).
"""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

import json
import logging
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services import drive_owner_search_service as search_module
from hushh_mcp.services import drive_request_bulk_service as bulk_service_module
from hushh_mcp.services.drive_document_processor import LocalDocumentProcessor
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_match_evidence import CONTENT, SYNONYM, awaiting_owner
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_possible_matches import DrivePossibleMatchesStore
from hushh_mcp.services.drive_request_brain import interpret_request, suggested_plan
from hushh_mcp.services.drive_request_content_check import RequestContentCheck
from hushh_mcp.services.drive_sharing_contract import VerifiedGoogleRecipient
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from tests.services import drive_pdf_fixtures as fx
from tests.services.test_drive_request_bulk_postgres import _settle, request_bulk
from tests.services.test_drive_sharing_store import (
    MIGRATIONS,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)
from tests.services.test_drive_trusted_auto import _membership, _request

PURPOSE = "Standup notes from last 3 months"
PDF = "application/pdf"
FOLDER = "application/vnd.google-apps.folder"
MARKER = "ZETA-PRIVATE-MARKER"


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _row(identity, title, mime=PDF, *, days_ago=5, **changes):
    moment = _iso(datetime.now(UTC) - timedelta(days=days_ago))
    return {
        "id": identity,
        "title": title,
        "mimeType": mime,
        "createdTime": moment,
        "modifiedTime": moment,
        "capabilities": {"canShare": True},
        **changes,
    }


# Drive's own pass (Gear 2): the title, name and fullText queries.
OWN = _row("own", "Standup notes - team A.pdf")
CONTENT_ONLY = _row("content_only", "Team update.pdf")
SYNONYM_ONLY = _row("synonym_only", "Scrum recap.pdf")
# Files reachable only through a folder shared with the owner.
WALK_TITLE = _row("walk_title", "Standup notes walked.pdf")
WALK_SCAN = _row("walk_scan", "Scan_0042.pdf")
WALK_RESTRICTED = _row(
    "walk_restricted", "Scan_0043.pdf", capabilities={"canShare": True, "canDownload": False}
)
WALK_LOCKED = _row("walk_locked", "Scan_0044.pdf", capabilities={"canShare": False})


def _gear_one_rows():
    """Gear 1 REST rows: one fresh upload (Drive-blind) and one indexed memo."""
    fresh = _iso(datetime.now(UTC) - timedelta(minutes=5))
    stale = _iso(datetime.now(UTC) - timedelta(days=20))
    return [
        {
            "id": "fresh",
            "name": "Untitled document.pdf",
            "mimeType": PDF,
            "createdTime": fresh,
            "modifiedTime": fresh,
            "size": "40960",
            "capabilities": {"canShare": True, "canDownload": True},
        },
        {
            "id": "stale",
            "name": "Old memo.pdf",
            "mimeType": PDF,
            "createdTime": stale,
            "modifiedTime": stale,
            "size": "2048",
            "capabilities": {"canShare": True, "canDownload": True},
        },
    ]


class RecentIndex:
    """Gear 1 as the worker holds it: no names match, two recent files."""

    enabled = True

    async def match_owner_files(self, **_):
        return []

    async def owner_vocabulary(self, **_):
        return None

    async def remember_files(self, **_):
        return 0

    async def recent_files(self, **_):
        return _gear_one_rows()


class Reader:
    """The fenced Drive download, faked: the bytes the parser child reads."""

    def __init__(self, generation):
        self.generation = generation
        self.calls = []
        day = (datetime.now(UTC) - timedelta(days=10)).date().isoformat()
        body = fx.text_pdf(
            [
                "Daily standup notes",
                f"Date: {day}",
                f"Sprint updates and blockers {MARKER}",
            ]
        )
        self.payloads = {"walk_scan": body, "fresh": body}

    async def read(self, *, owner_id, file_id, connection_generation, max_file_bytes):
        assert owner_id == "owner" and connection_generation == self.generation
        self.calls.append(file_id)
        # Restricted, unshareable and already-indexed files are never read.
        return {"mimeType": PDF, "content": self.payloads[file_id]}


async def _drive(*, user_id, tool_name, arguments):
    assert user_id == "owner"
    if tool_name == "list_shared_drives":
        return ExternalMcpToolResult(False, {"drives": [], "nextPageToken": None}, False)
    assert tool_name == "search_files"
    query, parent = arguments.get("query", ""), arguments.get("folderId")
    if parent == "sharedroot":
        files = [WALK_TITLE, WALK_SCAN, WALK_RESTRICTED, WALK_LOCKED]
    elif query == search_module._WALK_SEEDS["seed_folders"]:
        files = [_row("sharedroot", "From a colleague", FOLDER)]
    elif query == search_module._WALK_SEEDS["seed_shortcuts"]:
        files = []
    elif "fullText" in query:
        files = [OWN, CONTENT_ONLY, SYNONYM_ONLY]
    else:
        files = [OWN, SYNONYM_ONLY]
    return ExternalMcpToolResult(
        False, {"files": files, "nextPageToken": None, "incompleteSearch": False}, False
    )


def _processor():
    """The real isolated parser child; only the ClamAV daemon is faked."""
    return LocalDocumentProcessor(
        scanner=SimpleNamespace(scan=AsyncMock()), parser=SimpleNamespace(), embedder=None
    )


def _generation(db):
    with db.engine.connect() as connection:
        return connection.execute(
            text("""SELECT connection_generation FROM user_external_connector_connections
            WHERE user_id='owner' AND connector_id='google_drive'""")
        ).scalar_one()


def _pay(db, request_id):
    with db.engine.begin() as connection:
        updated = connection.execute(
            text("""UPDATE drive_request_payment_orders SET status='paid',paid_at=clock_timestamp()
            WHERE request_id=:request"""),
            {"request": request_id},
        ).rowcount
        if not updated:
            connection.execute(
                text("""INSERT INTO drive_request_payment_orders
                  (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
                  VALUES ('test',:request,'owner','recipient','paid',clock_timestamp())"""),
                {"request": request_id},
            )


def _request_status(db, request_id):
    with db.engine.connect() as connection:
        return connection.execute(
            text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one()


def _results(bulk, job_id):
    """Every frozen result, opened: {file id: metadata}."""
    with bulk.db.engine.connect() as connection:
        rows = connection.execute(
            text("""SELECT position,metadata_envelope FROM drive_owner_search_results
            WHERE job_id=:job ORDER BY position"""),
            {"job": job_id},
        ).all()
    opened = {}
    for position, envelope in rows:
        metadata = bulk._open(
            envelope,
            user_id="owner",
            resource_id=f"{job_id}:{position}",
            purpose="owner-search-result",
        )
        opened[metadata["id"]] = {**metadata, "position": position}
    return opened


def _projections(sharing):
    """The participant projections the delivery route reads."""
    return DriveSuggestionStore(db=sharing.db, authority_key="synthetic-ledger-key")


def _checkpoint(bulk, job_id):
    with bulk.db.engine.connect() as connection:
        envelope = connection.execute(
            text("SELECT checkpoint_envelope FROM drive_owner_search_jobs WHERE job_id=:job"),
            {"job": job_id},
        ).scalar_one()
    return bulk._open(
        envelope, user_id="owner", resource_id=job_id, purpose="owner-search-checkpoint"
    )


async def _settle_request(bulk, request_id):
    with bulk.db.engine.connect() as connection:
        shares = connection.execute(
            text("""SELECT share_id,file_count FROM drive_bulk_shares
            WHERE origin_request_id=:request AND approved_at IS NOT NULL"""),
            {"request": request_id},
        ).all()
    for share, count in shares:
        _settle(bulk, str(share), list(range(1, count + 1)))


async def _searched_request(request_bulk, sharing, monkeypatch):
    """A Trusted autoshare request, searched to completion by every v3 gear."""

    async def recipient_identity(user_id):
        assert user_id == "recipient"
        return VerifiedGoogleRecipient(
            "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
        )

    monkeypatch.setattr(bulk_service_module, "recipient_identity_for_user", recipient_identity)
    # The automatic slice reads search state from this isolated database.
    monkeypatch.setattr(
        bulk_service_module,
        "DriveOwnerSearchService",
        lambda: DriveOwnerSearchService(
            store=DriveOwnerSearchStore(db=sharing.db), transport=SimpleNamespace()
        ),
    )
    monkeypatch.setattr(search_module, "wake_drive_work", AsyncMock())
    monkeypatch.setenv("DRIVE_WORKER_MODE", "true")
    _membership(sharing, "active")
    await DriveLivePreferences(db=sharing.db).set_background(
        user_id="owner", enabled=True, confirmed=True
    )
    request_id = (await _request(sharing))["requestId"]
    context = await sharing.request_bulk_context(user_id="owner", request_id=request_id, start=True)
    assert context["searchStarted"] is True
    purpose = context["purpose"]
    period = (date.fromisoformat(purpose["periodStart"]), date.fromisoformat(purpose["periodEnd"]))
    brain = interpret_request(PURPOSE, now=datetime.now(UTC), timezone="UTC", picked_period=period)
    from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan

    plan = LiveSearchPlan.model_validate(suggested_plan(brain, PURPOSE)).model_dump(mode="json")
    reader = Reader(_generation(sharing.db))
    service = DriveOwnerSearchService(
        store=DriveOwnerSearchStore(db=sharing.db),
        transport=SimpleNamespace(read_tool=_drive),
        owner_index=RecentIndex(),
        content_check=RequestContentCheck(
            reader=reader, processor=_processor(), enabled=lambda: True
        ),
    )
    state = await service.create_for_request(
        user_id="owner",
        request_id=request_id,
        request_revision=context["revision"],
        purpose=purpose,
        plan=plan,
        require_current=AsyncMock(),
        authority_mode="trusted_auto",
        autoshare=True,
        brain=brain.as_checkpoint(),
        plan_source="deterministic_brain",
    )
    job_id = state["jobId"]
    for _ in range(25):
        if not (await service.store.status(user_id="owner", job_id=job_id))["canStop"]:
            break
        await service.run_one(user_id="owner", job_id=job_id)
    final = await service.store.status(user_id="owner", job_id=job_id)
    return request_id, job_id, final, reader


@pytest.mark.asyncio
async def test_v3_search_keeps_discovery_owner_only_and_shares_title_matches(
    request_bulk, sharing, monkeypatch, caplog
):
    caplog.set_level(logging.INFO)
    request_id, job_id, final, reader = await _searched_request(request_bulk, sharing, monkeypatch)
    assert final["status"] == "completed" and final["incompleteSearch"] is False

    results = _results(request_bulk, job_id)
    assert {identity: item.get("evidenceKind") for identity, item in results.items()} == {
        "own": None,
        "walk_title": None,
        "content_only": CONTENT,
        "synonym_only": SYNONYM,
        # Read by the content check in the parser child: content evidence.
        "walk_scan": CONTENT,
        "fresh": CONTENT,
    }
    # Only the two Drive-blind candidates were downloaded, each once (two
    # reads run concurrently, so their order is not fixed); never the
    # restricted, unshareable or already indexed files.
    assert sorted(reader.calls) == ["fresh", "walk_scan"]

    # O4: only title matches are claimable; everything else is owner-only.
    unclaimed = await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id)
    assert sorted(unclaimed) == sorted(
        results[identity]["position"] for identity in ("own", "walk_title")
    )
    listed = await DrivePossibleMatchesStore(
        db=sharing.db, cipher=request_bulk.cipher
    ).possible_matches(user_id="owner", request_id=request_id)
    assert listed["canSend"] is True and listed["count"] == 4
    assert {(item["name"], item["kind"]) for item in listed["matches"]} == {
        ("Team update.pdf", CONTENT),
        ("Scrum recap.pdf", SYNONYM),
        ("Scan_0042.pdf", CONTENT),
        ("Untitled document.pdf", CONTENT),
    }

    coverage = final["coverage"]
    assert coverage["contentCheck"] == "complete"
    assert coverage["sharedFolderWalk"] == "complete"
    assert (coverage["contentFilesRead"], coverage["contentPossibleMatches"]) == (2, 2)
    assert coverage["possibleMatchCount"] == 4
    assert coverage["coveragePartial"] is False

    # Nothing readable is kept: no text marker, no candidate pool.
    checkpoint = _checkpoint(request_bulk, job_id)
    assert checkpoint["content_phase"]["stage"] == "done"
    assert "candidates" not in checkpoint["content_phase"]
    assert MARKER not in json.dumps(checkpoint) and MARKER not in json.dumps(results)
    logged = caplog.text
    assert MARKER not in logged
    assert "Scan_0042" not in logged and "Untitled document" not in logged

    # Paid and settled: exactly the title matches are shared; the request
    # completes without waiting on unsent possible matches, and the requester
    # reads "All files sent" (no partial coverage flag).
    _pay(sharing.db, request_id)
    auto = DriveTrustedAutoService(sharing=sharing, bulk=request_bulk, wake=AsyncMock())
    assert await auto.share_available(user_id="owner", request_id=request_id) == 1
    await _settle_request(request_bulk, request_id)
    assert _request_status(sharing.db, request_id) == "completed"
    with sharing.db.engine.connect() as connection:
        frozen = sorted(
            connection.execute(
                text("""SELECT source_position FROM drive_bulk_share_files
                WHERE origin_request_id=:request"""),
                {"request": request_id},
            ).scalars()
        )
    assert frozen == sorted(results[identity]["position"] for identity in ("own", "walk_title"))
    assert all(
        awaiting_owner(checkpoint, item)
        for identity, item in results.items()
        if identity not in {"own", "walk_title"}
    )
    requester = await _projections(sharing).delivery_snapshot(
        user_id="recipient", request_id=request_id, views=True
    )
    assert "coveragePartial" not in requester["result"]


@pytest.mark.asyncio
async def test_unread_drive_blind_files_tell_only_the_requester_files_sent(
    request_bulk, sharing, monkeypatch
):
    # One content page reading one file: the walked scan stays unread.
    monkeypatch.setattr(search_module, "MAX_CONTENT_CHECK_PAGES", 1)
    monkeypatch.setattr(
        search_module,
        "CONTENT_CHECK_BUDGET",
        replace(search_module.CONTENT_CHECK_BUDGET, max_files_per_slice=1),
    )
    request_id, job_id, final, reader = await _searched_request(request_bulk, sharing, monkeypatch)
    assert reader.calls == ["fresh"]
    coverage = final["coverage"]
    assert final["status"] == "completed" and final["incompleteSearch"] is False
    assert coverage["contentCheck"] == "partial" and coverage["contentCheckIncomplete"] is True
    assert coverage["coveragePartial"] is True
    # Partial coverage never blocks sharing: pay, share and settle as usual.
    _pay(sharing.db, request_id)
    auto = DriveTrustedAutoService(sharing=sharing, bulk=request_bulk, wake=AsyncMock())
    assert await auto.share_available(user_id="owner", request_id=request_id) == 1
    await _settle_request(request_bulk, request_id)
    assert _request_status(sharing.db, request_id) == "completed"
    projections = _projections(sharing)
    requester = await projections.delivery_snapshot(
        user_id="recipient", request_id=request_id, views=True
    )
    assert requester["result"]["coveragePartial"] is True
    # Only the requester's delivery view carries the bit; the owner sees the
    # reasons in the search coverage instead.
    owner = await projections.delivery_snapshot(user_id="owner", request_id=request_id, views=True)
    assert "coveragePartial" not in owner["result"]
    # Negative control: a file-page read (views off) never computes it.
    pages = await projections.delivery_snapshot(user_id="recipient", request_id=request_id)
    assert "coveragePartial" not in pages["result"]
