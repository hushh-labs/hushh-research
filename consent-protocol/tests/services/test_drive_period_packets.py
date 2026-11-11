"""Metadata packet calendar, exact source provenance and no-reader boundaries."""

# ruff: noqa: F811 -- canonical disposable PostgreSQL fixture dependencies

from copy import deepcopy
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from hushh_mcp.services.drive_period_packet_contract import PacketPeriod, current_year_periods
from hushh_mcp.services.drive_period_packet_page import frozen_provider_page
from hushh_mcp.services.drive_period_packet_service import DrivePeriodPacketService
from hushh_mcp.services.drive_request_discovery import (
    DISCOVERY_DELIVERY_POLICY,
    compile_discovery_queries,
    discovery_evidence_matches,
)
from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest
from hushh_mcp.services.google_drive_adapter import DriveReadError

# Disposable PostgreSQL fixture graph for the owner isolation regression.
from tests.services.test_drive_period_packet_previews_postgres import (  # noqa: F401
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    preview_runtime,
    reusable,
    sharing,
)

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


def semantic():
    return {
        "version": 1,
        "status": "ready",
        "metadata_listing": False,
        "date_basis": "title_created_modified",
        "clarification": None,
        "clauses": [
            {
                "predicates": [
                    {
                        "id": "statement",
                        "kind": "semantic",
                        "value": "statement",
                        "match": "token",
                        "negated": False,
                        "discovery_terms": [],
                    }
                ]
            }
        ],
    }


def test_current_year_pairs_close_only_after_local_period_end():
    periods = current_year_periods(datetime(2026, 10, 24, tzinfo=UTC), "Asia/Kolkata")
    assert [(p.start.month, p.end.month) for p in periods] == [
        (1, 2),
        (3, 4),
        (5, 6),
        (7, 8),
        (9, 10),
    ]
    assert periods[-1].closed(datetime(2026, 10, 31, 18, 29, 59, tzinfo=UTC)) is False
    assert periods[-1].closed(datetime(2026, 10, 31, 18, 30, tzinfo=UTC)) is True
    leap = current_year_periods(datetime(2024, 2, 5, tzinfo=UTC), "UTC")
    assert leap[0].end == date(2024, 2, 29)
    with pytest.raises(ValueError):
        PacketPeriod(start=date(2026, 2, 1), end=date(2026, 3, 31), timezone="UTC")


def test_owner_tagging_projection_is_an_allowlist_of_what_the_queue_does_next():
    from hushh_mcp.services.drive_period_packet_preview import tagging_summary

    now = datetime(2026, 10, 28, tzinfo=UTC)
    counts = {"financial": 0, "review": 8, "other": 0, "pending": 18}
    stored = {"policyVersion": "v1", "counts": counts, "lease_owner": "internal"}

    def owner_view(status, pending, lease=None, **extra):
        build = {"tagging": {**stored, "status": status, **extra}, "lease_kind": "tagging"}
        row = {"tagging_pending": pending, "lease_expires_at": lease}
        return tagging_summary(row, build, now)

    assert owner_view("running", True, now + timedelta(minutes=1)) == {
        "status": "running",
        "policyVersion": "v1",
        "counts": counts,
    }
    # A worker that left "running" behind: report what the queue will act on next.
    assert owner_view("running", True, now - timedelta(seconds=1))["status"] == "queued"
    assert owner_view("running", False)["status"] == "failed"
    # An older "failed" whose retry is still scheduled.
    assert owner_view("failed", True)["status"] == "queued"
    waiting = owner_view(
        "queued", True, failureCode="refresh_in_progress", retryAt="2026-10-28T06:00:00+00:00"
    )
    assert waiting["failureCode"] == "refresh_in_progress" and waiting["retryAt"]
    stopped = owner_view("failed", False, failureCode="reconnect_required", retryAt="stale")
    assert stopped == {
        "status": "failed",
        "policyVersion": "v1",
        "counts": counts,
        "failureCode": "reconnect_required",
    }
    assert tagging_summary({}, {}, now) is None


async def test_disabled_worker_does_not_touch_store(monkeypatch):
    monkeypatch.delenv("DRIVE_PERIOD_PACKETS_ENABLED", raising=False)
    store = SimpleNamespace(due_owners=AsyncMock(side_effect=AssertionError("DB accessed")))
    service = DrivePeriodPacketService(store=store, search=SimpleNamespace())
    assert (await service.run())["outcomes"] == {}
    store.due_owners.assert_not_awaited()


@pytest.mark.parametrize("changed", [False, True])
async def test_frozen_packet_pages_exact_metadata_and_rebinds_to_buyer_request(changed):
    plan = semantic()
    request = str(uuid4())
    checkpoint = {
        "queries": compile_discovery_queries(plan),
        "query_index": 0,
        "semantic_plan": plan,
        "semantic_plan_digest": semantic_plan_digest(plan),
        "requested_period": {
            "start": "2026-01-01",
            "end": "2026-02-28",
            "timezone": "Asia/Kolkata",
        },
        "request_origin_id": request,
        "request_revision": 0,
        "packet_offset": 0,
        "discovery_delivery_policy": DISCOVERY_DELIVERY_POLICY,
    }
    raw = {
        "id": "file-synthetic",
        "title": "Statement",
        "mimeType": "application/pdf",
        "modifiedTime": "2026-01-10T00:00:00Z",
        "version": "2" if changed else "1",
        "capabilities": {"canShare": True},
    }
    metadata = {"id": raw["id"], "name": raw["title"], "mimeType": raw["mimeType"]}
    identity = str(uuid4())
    manifest = {
        "packet_id": str(uuid4()),
        "version": 1,
        "sources": [{"document_id": identity, "source_version": "1"}],
        "source_metadata": {identity: metadata},
    }
    transport = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=SimpleNamespace(is_error=False, truncated=False, payload={"file": raw})
        )
    )
    service = SimpleNamespace(transport=transport)
    job = {"user_id": "owner", "generation": 7}
    original = deepcopy(checkpoint)
    if changed:
        with pytest.raises(DriveReadError, match="source_changed"):
            await frozen_provider_page(service, job, manifest, checkpoint)
        assert checkpoint == original
    else:
        result, files, incomplete, done = await frozen_provider_page(
            service, job, manifest, checkpoint
        )
        assert done and not incomplete and result["packet_offset"] == 1
        assert files[0]["providerPacketDocumentId"] == identity
        assert files[0]["sourceVersion"] == "1"
        assert discovery_evidence_matches(
            files[0], user_id="owner", generation=7, checkpoint=original
        )
        assert files[0]["discoveryEvidence"]["request_id"] == request
        assert (
            not {"facts", "indexedEvidence", "requestEvidence", "contentVerified"} & files[0].keys()
        )
    transport.read_tool.assert_awaited_once_with(
        user_id="owner", tool_name="get_file_metadata", arguments={"fileId": "file-synthetic"}
    )


@pytest.mark.parametrize("tamper", [None, "queries", "binding", "origin"])
def test_catalog_checkpoint_cannot_substitute_request_or_provider_plan(tamper):
    from hushh_mcp.services.drive_period_packet_page import validate_buyer_checkpoint

    plan = semantic()
    queries = compile_discovery_queries(plan)
    binding = {"packetId": "packet", "version": 1}
    purpose = {
        "purpose": "Synthetic packet",
        "periodStart": "2026-01-01",
        "periodEnd": "2026-02-28",
    }
    manifest = {
        "kind": "provider_discovery",
        "search": {"plan": plan, "queries": queries, "model_binding": None},
        "periodStart": "2026-01-01",
        "periodEnd": "2026-02-28",
        "timezone": "UTC",
    }
    private = {"purpose": purpose, "reusable_packet": binding, "agent_package_required": True}
    checkpoint = {
        "semantic_plan": plan,
        "semantic_plan_digest": semantic_plan_digest(plan),
        "semantic_model_binding": None,
        "queries": queries,
        "requested_period": {"start": "2026-01-01", "end": "2026-02-28", "timezone": "UTC"},
        "semantic_purpose": purpose,
        "reusable_packet": binding,
        "provider_packet": True,
        "authority_mode": "agent_package",
        "evidence_route": "packet",
        "discovery_delivery_policy": DISCOVERY_DELIVERY_POLICY,
    }
    changed = deepcopy(checkpoint)
    if tamper == "queries":
        changed["queries"] = []
    elif tamper == "binding":
        changed["semantic_model_binding"] = {"provider": "other"}
    elif tamper == "origin":
        changed["reusable_packet"] = {"packetId": "other", "version": 1}
    if tamper:
        with pytest.raises(DriveReadError, match="search_superseded"):
            validate_buyer_checkpoint(manifest, private, changed, checkpoint)
    else:
        validate_buyer_checkpoint(manifest, private, changed, checkpoint)


async def test_worker_threads_exact_head_lease_to_pre_send_guard(monkeypatch):
    from hushh_mcp.services.drive_period_packet_contract import PERIOD_PACKET_POLICY

    monkeypatch.setattr(
        "hushh_mcp.services.drive_period_packet_service.admit_hub_content", AsyncMock()
    )
    identity = str(uuid4())
    work = {
        "packet_id": identity,
        "category": "bank",
        "next_at": datetime.now(UTC),
        "revision": 3,
        "lease_id": "lease-current",
        "build": {},
    }
    store = SimpleNamespace(
        ensure_owner=AsyncMock(),
        claim_build=AsyncMock(return_value=work),
        require_build_current=AsyncMock(side_effect=DriveReadError("packet_superseded")),
        save_build=AsyncMock(),
    )
    service = DrivePeriodPacketService(store=store, search=SimpleNamespace())

    async def model_pre_send(_job, current):
        await current()
        raise AssertionError(PERIOD_PACKET_POLICY)

    service._plan = model_pre_send
    assert await service.run_one(user_id="owner") == "unavailable"
    store.require_build_current.assert_awaited_once_with(
        user_id="owner", packet_id=identity, revision=3, lease_id="lease-current"
    )


@pytest.mark.parametrize("cached", [False, True])
@pytest.mark.parametrize("provider", ["azure_openai", "gemini"])
async def test_planning_reuses_only_this_exact_period_checkpoint(monkeypatch, cached, provider):
    import json

    module = "hushh_mcp.services.drive_period_packet_service"
    binding = {"provider": provider, "deployment": "central", "authorization_basis": "uat_policy"}
    authored = {"semantic_query": semantic()}
    monkeypatch.setattr(f"{module}.semantic_request_model_binding", lambda: binding)
    plan = AsyncMock(return_value=SimpleNamespace(model_dump=lambda **_: authored))
    monkeypatch.setattr(f"{module}.plan_semantic_live_search", plan)
    store = SimpleNamespace(_transaction=AsyncMock(side_effect=AssertionError("other periods")))
    service = DrivePeriodPacketService(store=store, search=SimpleNamespace())
    current = AsyncMock()
    job = {
        "user_id": "owner",
        "category": "bank",
        "period_timezone": "UTC",
        "period_start": date(2026, 3, 1),
        "period_end": date(2026, 4, 30),
        "build": {"model_binding": binding, "plan": authored} if cached else {},
    }
    assert await service._plan(job, current) == (authored, binding)
    store._transaction.assert_not_awaited()
    if cached:
        current.assert_awaited_once()
        plan.assert_not_awaited()
    else:
        request = json.loads(plan.await_args.kwargs["prompt"])["document_request"]
        assert request["periodStart"] == "2026-03-01" and request["periodEnd"] == "2026-04-30"


def wire_packet_provider(service, lifecycle):
    """Retain the production OAuth lifecycle port, REST transport and HTTP adapter."""
    from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
    from hushh_mcp.services.google_drive_adapter import GoogleDriveAdapter
    from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport

    adapter = GoogleDriveAdapter()

    async def credential(**kwargs):
        return await lifecycle.read(user_id=kwargs["user_id"], connector_id="google_drive"), {
            "accessToken": "synthetic"
        }

    oauth = SimpleNamespace(current_credential=credential, lifecycle=lifecycle)
    service.search = DriveOwnerSearchService(
        store=service.search.store, transport=GoogleDriveRestTransport(oauth=oauth, adapter=adapter)
    )
    return adapter


def seed_scheduled_owners(store, users, *, clear_heads=True):
    """Clone only synthetic connected-account state, never OAuth or background grants."""
    from sqlalchemy import text

    with store.db.engine.begin() as connection:
        if clear_heads:
            connection.execute(text("DELETE FROM drive_packet_heads WHERE user_id='owner'"))
        for user in users:
            connection.execute(
                text("""INSERT INTO user_external_connector_connections
              SELECT (jsonb_populate_record(NULL::user_external_connector_connections,
                to_jsonb(c)||jsonb_build_object('user_id',:user,'updated_at','2000-01-01T00:00:00Z',
                  'drive_packet_inspected_at',NULL,'credential_ciphertext',NULL,
                  'credential_iv',NULL,'credential_tag',NULL))).*
              FROM user_external_connector_connections c
              WHERE c.user_id='owner' AND c.connector_id='google_drive'"""),
                {"user": user},
            )


def scheduled_drive(eligible, periods, calls):
    from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult

    async def read(*, user_id, tool_name, arguments):
        assert user_id in eligible
        calls.append((user_id, tool_name))
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(False, {"drives": []}, False)
        assert tool_name in {"list_files", "search_files"}
        page = bool(arguments.get("pageToken"))
        files = [
            {
                "id": f"{user_id}-{period.start}-{i}",
                "title": "Synthetic record",
                "mimeType": "video/mp4" if i == 0 else "application/pdf",
                "version": "1",
                "createdTime": f"{period.start}T12:00:00Z",
                "modifiedTime": f"{period.start}T12:00:00Z",
                "capabilities": {"canShare": i != 0},
            }
            for period in periods
            for i in ([1, 2] if page else [0, 1])
        ]
        return ExternalMcpToolResult(
            False,
            {
                "files": files,
                "nextPageToken": None if page else "second",
                "incompleteSearch": False,
            },
            False,
        )

    return SimpleNamespace(read_tool=AsyncMock(side_effect=read))


def advance_scheduled_calendar(periods):
    """Advance only the injected product calendar; database lease clocks stay real."""
    start = periods[-1].end + timedelta(days=1)
    periods.append(
        current_year_periods(datetime.combine(start, datetime.min.time(), UTC), "UTC")[-1]
    )


def scheduled_snapshot(store):
    from sqlalchemy import text

    with store.db.engine.connect() as connection:
        rows = list(
            connection.execute(
                text("SELECT * FROM drive_packet_heads ORDER BY user_id,period_start")
            ).mappings()
        )
        effects = [
            connection.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()
            for table in ("drive_request_payment_orders", "drive_bulk_share_effects")
        ]
    assert effects == [0, 0]
    return {
        (row["user_id"], row["period_start"]): (
            row["current_version"],
            row["revision"],
            store._build(row).get("preview", {}),
        )
        for row in rows
    }


@pytest.mark.parametrize("failure", ["inspection", "discovery", "deleted"])
async def test_refused_owner_cannot_cancel_other_owner_discovery(reusable, monkeypatch, failure):
    from sqlalchemy import text

    service, _, planner, _ = await preview_runtime(reusable, monkeypatch)
    seed_scheduled_owners(service.store, ["blocked", "healthy"])
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "blocked,healthy")
    monkeypatch.setattr(
        "hushh_mcp.services.owner_placement_guard.get_owner_hosting_mode",
        AsyncMock(return_value="shared"),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one",
        AsyncMock(return_value="idle"),
    )
    periods = current_year_periods(datetime.now(UTC), "UTC")
    calls = []
    service.search.transport = scheduled_drive(["healthy"], periods, calls)
    with service.store.db.engine.begin() as connection:
        if failure == "deleted":
            connection.execute(
                text(
                    "INSERT INTO account_deletion_tombstones VALUES ('sha256:'||encode(sha256(convert_to('blocked','UTF8')),'hex'))"
                )
            )
        else:
            table, event = (
                ("user_external_connector_connections", "UPDATE")
                if failure == "inspection"
                else ("drive_packet_heads", "INSERT")
            )
            connection.exec_driver_sql("""CREATE FUNCTION refuse_blocked_owner() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN IF NEW.user_id='blocked' THEN RAISE EXCEPTION 'synthetic storage refusal' USING ERRCODE='23514'; END IF; RETURN NEW; END $$""")
            connection.exec_driver_sql(
                f"CREATE TRIGGER refuse_blocked BEFORE {event} ON {table} FOR EACH ROW EXECUTE FUNCTION refuse_blocked_owner()"
            )
    if failure == "deleted":
        with pytest.raises(DriveReadError, match="account_deleted"):
            await service.ensure_owner(user_id="blocked")
    result = await service.run(max_jobs=2, deadline_seconds=10)
    assert result["outcomes"]["completed"] == 1
    assert {owner for owner, _ in calls} == {"healthy"}
    planner.assert_not_awaited()
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_packet_heads WHERE user_id='blocked'")
            ).scalar_one()
            == 0
        )


async def test_owner_catalog_poll_only_reads_saved_heads(reusable, monkeypatch):
    from sqlalchemy import text

    from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore

    service, _, _, transport = await preview_runtime(reusable, monkeypatch)
    ensure = AsyncMock(side_effect=AssertionError("catalog poll enrolled owner"))
    monkeypatch.setattr(DrivePeriodPacketStore, "ensure_owner", ensure)

    def saved():
        with service.store.db.engine.connect() as connection:
            return connection.execute(
                text(
                    "SELECT packet_id,revision,updated_at,tagging_pending,tagging_next_at FROM drive_packet_heads ORDER BY packet_id"
                )
            ).all()

    before = saved()
    assert before
    result = await service.store.list_packets(user_id="owner", owner_contents=True)
    assert len(result["packets"]) == len(before) and saved() == before
    with service.store.db.engine.begin() as connection:
        connection.exec_driver_sql("DELETE FROM drive_packet_heads")
    assert (await service.store.list_packets(user_id="owner", owner_contents=True))["packets"] == []
    assert saved() == []
    ensure.assert_not_awaited()
    transport.read_tool.assert_not_awaited()
