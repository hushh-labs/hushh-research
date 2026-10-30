"""Financial packet policy recovery, pinned originals and sealed query provenance."""

# ruff: noqa: F401,F811 -- shared disposable PostgreSQL fixture dependencies
from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_period_packet_previews_postgres import (
    collection,
    collection_pages,
    completed_preview,
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
from tests.services.test_drive_period_packets import (
    advance_scheduled_calendar,
    scheduled_drive,
    scheduled_snapshot,
    seed_scheduled_owners,
)

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


def assert_predefined_preview_saved(service, packet_id, *, matched):
    """The owner response follows a complete persisted preset search, before tags."""
    with service.store.db.engine.connect() as connection:
        row = dict(
            connection.execute(
                text("""SELECT * FROM drive_packet_heads
          WHERE packet_id=:id"""),
                {"id": packet_id},
            )
            .mappings()
            .one()
        )
        assert row["tagging_pending"] and row["current_version"] == 0
        build = service.store._build(row)
        assert "migration" not in build
        search = dict(
            connection.execute(
                text("""SELECT * FROM drive_owner_search_jobs
          WHERE user_id='owner' AND job_id=:id"""),
                {"id": build["search_job_id"]},
            )
            .mappings()
            .one()
        )
        checkpoint = service.search.store._checkpoint(search)
        assert search["status"] == "completed" and search["matched"] == matched
        assert checkpoint["query_source"]["kind"] == "predefined"
        assert checkpoint["query_source"]["planner_executed"] is False
        assert checkpoint["semantic_model_binding"] is None
        assert checkpoint["semantic_plan"]["date_basis"] == "title_created_modified"
        assert build["query_source"] == checkpoint["query_source"]
    return build["search_job_id"]


async def assert_retained_preview_after_expiry(
    client, service, path, headers, search_id, *, matched
):
    """TTL cleanup preserves the packet's live pageable originals, beyond its cached prefix."""
    # The packet owns its saved originals beyond temporary search TTL.
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_owner_search_jobs
          SET expires_at=clock_timestamp()-INTERVAL '1 second'
          WHERE job_id=:id"""),
            {"id": search_id},
        )
    await service.search.store.purge()
    retained = await client.get(path, headers=headers)
    assert retained.status_code == 200 and retained.json()["matched"] == matched
    assert retained.json()["nextCursor"] and not retained.json()["limited"]


async def legacy_pending_preview(service, head, planner, *, active_lease):
    """Create a committed legacy preview, then expire its synthetic job/lease."""
    from hushh_mcp.services.drive_period_packet_preview import snapshot_search
    from hushh_mcp.services.drive_request_discovery import discovery_evidence

    identity = str(head["packet_id"])
    job = await service.store.claim_build(user_id="owner", packet_id=identity)
    legacy_plan = planner.return_value
    legacy_binding = {
        "provider": "azure_openai",
        "deployment": "synthetic",
        "config_fingerprint": "synthetic",
        "approval_generation": None,
    }
    # Author a genuine old model checkpoint through the retained model path,
    # against this same head/revision. No current preset marker is fabricated.
    state = await service._search_job({**job, "category": "bank"}, legacy_plan, legacy_binding)
    claimed = await service.search.store.claim(user_id="owner", job_id=state["jobId"])
    checkpoint = claimed["checkpoint"]
    assert "query_source" not in checkpoint
    source = {
        "id": "legacy-cached-original",
        "name": "Synthetic retained statement",
        "mimeType": "application/pdf",
        "sourceVersion": "1",
        "shareable": True,
        "createdTime": f"{head['period_start']}T00:00:00Z",
    }
    source["discoveryEvidence"] = discovery_evidence(
        checkpoint, user_id="owner", generation=1, metadata=source
    )
    await service.search.store.commit_page(
        claimed, checkpoint=checkpoint, files=[source], done=False
    )
    build = await snapshot_search(
        service.store, job, {"plan": legacy_plan, "model_binding": legacy_binding}, state["jobId"]
    )
    await service.store.save_build(job, build)
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='running',
          expires_at=clock_timestamp()-INTERVAL '1 second', lease_id=gen_random_uuid(),
          lease_expires_at=clock_timestamp()+make_interval(secs=>:seconds)
          WHERE job_id=:id"""),
            {"id": state["jobId"], "seconds": 60 if active_lease else -1},
        )
        connection.execute(
            text("UPDATE drive_packet_heads SET next_at=clock_timestamp() WHERE packet_id=:id"),
            {"id": identity},
        )
        before = connection.execute(
            text("""SELECT metadata_envelope FROM drive_owner_search_results
          WHERE job_id=:id"""),
            {"id": state["jobId"]},
        ).scalar_one()
    return identity, job, state, source, before


@pytest.mark.parametrize("active_lease", [False, True])
async def test_financial_policy_migrates_only_expired_unleased_pending_work(
    reusable, monkeypatch, active_lease
):
    service, head, planner, transport = await preview_runtime(reusable, monkeypatch)
    identity, job, state, source, before = await legacy_pending_preview(
        service, head, planner, active_lease=active_lease
    )
    migrated = await service.store.claim_build(user_id="owner", packet_id=identity)
    if active_lease:
        assert migrated is None
    else:
        assert migrated["revision"] == job["revision"] + 1
        assert migrated["build"]["migration"]["from"] == {"kind": "model"}
        assert migrated["build"]["migration"]["to"]["planner_executed"] is False
        cached = await service.preview(user_id="owner", packet_id=identity)
        assert cached["matched"] == 1 and cached["stale"]
        assert cached["documents"][0]["name"] == source["name"]
        plan, binding = await service._plan(migrated, AsyncMock())
        assert binding is None
        fresh = await service._search_job(migrated, plan, binding)
        assert fresh["jobId"] != state["jobId"]
    await service.search.store.purge()
    with service.store.db.engine.connect() as connection:
        old = connection.execute(
            text("SELECT status FROM drive_owner_search_jobs WHERE job_id=:id"),
            {"id": state["jobId"]},
        ).scalar_one()
        assert old == ("running" if active_lease else "stopped")
        assert (
            connection.execute(
                text("SELECT metadata_envelope FROM drive_owner_search_results WHERE job_id=:id"),
                {"id": state["jobId"]},
            ).scalar_one()
            == before
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
    planner.assert_not_awaited()
    transport.read_tool.assert_not_awaited()


@pytest.mark.parametrize("tamper", ["query", "source"])
async def test_financial_provenance_cannot_authorize_an_arbitrary_checkpoint(
    reusable, monkeypatch, tamper
):
    from copy import deepcopy

    service, head, planner, _ = await preview_runtime(reusable, monkeypatch)
    job = await service.store.claim_build(user_id="owner", packet_id=str(head["packet_id"]))
    plan, binding = await service._plan(job, AsyncMock())
    state = await service._search_job(job, plan, binding)
    claimed = await service.search.store.claim(user_id="owner", job_id=state["jobId"])
    checkpoint = deepcopy(claimed["checkpoint"])
    if tamper == "query":
        checkpoint["queries"][0]["arguments"]["query"] = "trashed = false"
    else:
        checkpoint["query_source"]["planner_executed"] = True
    with pytest.raises(DriveReadError, match="search_superseded"):
        await service.search.store.commit_page(claimed, checkpoint=checkpoint, files=[], done=True)
    with service.store.db.engine.connect() as connection:
        current = dict(
            connection.execute(
                text("SELECT * FROM drive_owner_search_jobs WHERE job_id=:id"),
                {"id": state["jobId"]},
            )
            .mappings()
            .one()
        )
        assert current["status"] == "running" and current["matched"] == 0
        assert service.search.store._checkpoint(current) == claimed["checkpoint"]
    planner.assert_not_awaited()


@pytest.mark.parametrize("mismatch", ["owner", "generation", "ordinary"])
async def test_expired_recovery_cannot_retire_an_unrelated_search(reusable, monkeypatch, mismatch):
    import json

    from hushh_mcp.services.drive_period_packet_migration import recover_expired_search

    service, head, _, _ = await preview_runtime(reusable, monkeypatch)
    job = await service.store.claim_build(user_id="owner", packet_id=str(head["packet_id"]))
    plan, binding = await service._plan(job, AsyncMock())
    state = await service._search_job(job, plan, binding)
    target = str(uuid4())
    changes = {"job_id": target, "client_request_id": str(uuid4()), "status": "queued"}
    changes.update(
        {"user_id": "unrelated-owner"}
        if mismatch == "owner"
        else {"connection_generation": job["connection_generation"] + 1}
        if mismatch == "generation"
        else {"period_packet_id": None}
    )
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET status='completed' WHERE job_id=:id"),
            {"id": state["jobId"]},
        )
        connection.execute(
            text("""INSERT INTO drive_owner_search_jobs
            SELECT (jsonb_populate_record(NULL::drive_owner_search_jobs,
              to_jsonb(j) || CAST(:changes AS jsonb))).* FROM drive_owner_search_jobs j WHERE job_id=:id"""),
            {"id": state["jobId"], "changes": json.dumps(changes)},
        )
        connection.execute(
            text(
                "UPDATE drive_owner_search_jobs SET expires_at=clock_timestamp()-INTERVAL '1 day' WHERE job_id=:id"
            ),
            {"id": target},
        )
        build = {"search_job_id": target}
        recovered_row, recovered_build = recover_expired_search(
            service.store, connection, job, build
        )
        assert recovered_row["revision"] == job["revision"] and recovered_build == build
        unrelated = connection.execute(
            text("SELECT status,revision FROM drive_owner_search_jobs WHERE job_id=:id"),
            {"id": target},
        ).one()
        assert unrelated == ("queued", 1)


async def test_retention_advances_past_pinned_current_and_previous_previews(reusable, monkeypatch):
    from hushh_mcp.services import drive_period_packet_retention as retention
    from hushh_mcp.services.drive_period_packet_preview import snapshot_search

    service, head, _, _ = await preview_runtime(reusable, monkeypatch)
    identity = str(head["packet_id"])
    first = await completed_preview(service, identity)
    assert first["complete"]
    with service.store.db.engine.connect() as connection:
        row = dict(
            connection.execute(
                text("SELECT * FROM drive_packet_heads WHERE packet_id=:id"), {"id": identity}
            )
            .mappings()
            .one()
        )
        old_id = service.store._build(row)["search_job_id"]
    await service.store.request_preview(user_id="owner", packet_id=identity, refresh=True)
    job = await service.store.claim_build(user_id="owner", packet_id=identity)
    plan, binding = await service._plan(job, AsyncMock())
    state = await service._search_job(job, plan, binding)
    build = await snapshot_search(service.store, job, job["build"], state["jobId"])
    await service.store.save_build(job, build)
    unused = str(uuid4())
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_owner_search_jobs
          SELECT (jsonb_populate_record(NULL::drive_owner_search_jobs, to_jsonb(j) ||
            jsonb_build_object('job_id',:id,'client_request_id',:client,'status','stopped',
              'expires_at',clock_timestamp()-INTERVAL '1 day'))).* FROM drive_owner_search_jobs j WHERE job_id=:old"""),
            {"id": unused, "client": str(uuid4()), "old": old_id},
        )
        connection.execute(
            text(
                "UPDATE drive_owner_search_jobs SET expires_at=clock_timestamp()-INTERVAL '3 days' WHERE job_id=:id"
            ),
            {"id": old_id},
        )
        connection.execute(
            text(
                "UPDATE drive_owner_search_jobs SET expires_at=clock_timestamp()-INTERVAL '2 days' WHERE job_id=:id"
            ),
            {"id": state["jobId"]},
        )
    monkeypatch.setattr(retention, "BATCH", 2)
    await service.search.store.purge()
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_jobs WHERE job_id=:id"),
                {"id": unused},
            ).scalar_one()
            == 1
        )
    await service.search.store.purge()
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_jobs WHERE job_id=:id"),
                {"id": unused},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM drive_owner_search_jobs WHERE job_id IN (:first,:second)"
                ),
                {"first": old_id, "second": state["jobId"]},
            ).scalar_one()
            == 2
        )


def scheduled_population(base, monkeypatch):
    from hushh_mcp.services import drive_period_packet_enrollment as enrollment
    from hushh_mcp.services.drive_period_packet_contract import current_year_periods

    eligible, refused = (
        ["owner", "ready-1", "ready-2", "ready-3"],
        [f"refused-{i}" for i in range(4)],
    )
    seed_scheduled_owners(
        base.store, [*refused, *eligible[1:], "outside-cohort", "revoked", "paused"]
    )
    periods = current_year_periods(datetime.now(UTC), "UTC")[-2:]
    monkeypatch.setattr(enrollment, "current_year_periods", lambda *_: periods)
    monkeypatch.setattr(enrollment, "ENROLLMENT_SCAN_LIMIT", 2)
    monkeypatch.setenv(
        "CONNECTOR_INTERNAL_OWNER_COHORT", ",".join([*refused, *eligible, "revoked", "paused"])
    )

    async def placement(user):
        return "unknown" if user in refused[::2] else "byoc" if user in refused else "shared"

    monkeypatch.setattr(
        "hushh_mcp.services.owner_placement_guard.get_owner_hosting_mode", placement
    )
    with base.store.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled,disclosure_version)
          VALUES('paused',1,FALSE,'live-drive-background-v1')""")
        )
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='revoked'"
            )
        )
    return eligible, periods


async def test_scheduled_packets_sweep_all_owners_after_missed_wakes_without_preview(
    reusable, monkeypatch, caplog
):
    from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
    from hushh_mcp.services.drive_period_packet_service import DrivePeriodPacketService
    from tests.services.test_drive_work_drain import _drain, _worker

    caplog.set_level("INFO", logger="drive_period_packets")
    base, _, planner, _ = await preview_runtime(reusable, monkeypatch)
    eligible, periods = scheduled_population(base, monkeypatch)
    wake = AsyncMock(return_value=False)
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one",
        AsyncMock(return_value="idle"),
    )
    planner.side_effect = AssertionError("financial discovery called Azure")
    calls, expected = [], {(owner, period.start) for owner in eligible for period in periods}
    assert scheduled_snapshot(base.store) == {}
    for _ in range(16):
        # Fresh orchestrators simulate worker restart; only PostgreSQL retains progress.
        search = DriveOwnerSearchService(
            store=base.search.store, transport=scheduled_drive(eligible, periods, calls)
        )
        service = DrivePeriodPacketService(store=base.store, search=search, planner=planner)
        drain = _drain([_worker({"outcomes": {}}) for _ in range(4)], period_packet_worker=service)
        await drain.run(stage="suggestions", max_jobs_per_worker=2)
        saved = scheduled_snapshot(base.store)
        if set(saved) == expected and all(value[2].get("complete") for value in saved.values()):
            break
    assert set(saved) == expected and all(value[2].get("complete") for value in saved.values())
    assert all(value[2]["matched"] == 3 for value in saved.values())
    assert all(value[2]["documents"][0]["shareable"] is False for value in saved.values())
    assert all(
        version == int(period < periods[-1].start) for (_, period), (version, _, _) in saved.items()
    )
    # An ordinary next scheduler tick is a duplicate trigger, not an explicit refresh.
    await drain.run(stage="suggestions", max_jobs_per_worker=2)
    assert scheduled_snapshot(base.store) == saved
    with base.store.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_packet_heads SET next_at=clock_timestamp()
          WHERE user_id='owner' AND current_version=0""")
        )
    key = ("owner", periods[-1].start)
    for _ in range(4):
        await drain.run(stage="suggestions", max_jobs_per_worker=2)
        refreshed = scheduled_snapshot(base.store)
        if refreshed[key][1] > saved[key][1]:
            break
    assert refreshed[key][1] == saved[key][1] + 1 and refreshed[key][2]["complete"]
    assert {key: value for key, value in refreshed.items() if key[0] != "owner"} == {
        key: value for key, value in saved.items() if key[0] != "owner"
    }
    # Rollover is discovered by the next scheduled sweep, without an owner visit.
    advance_scheduled_calendar(periods)
    rolled_keys = expected | {(owner, periods[-1].start) for owner in eligible}
    for _ in range(12):
        await drain.run(stage="suggestions", max_jobs_per_worker=2)
        rolled = scheduled_snapshot(base.store)
        if set(rolled) == rolled_keys and all(
            value[2].get("complete") for value in rolled.values()
        ):
            break
    assert set(rolled) == rolled_keys and all(value[2].get("complete") for value in rolled.values())
    assert all(rolled[key] == value for key, value in refreshed.items())
    assert all(value[2]["matched"] == 3 for value in rolled.values())
    planner.assert_not_awaited()
    assert {owner for owner, _ in calls} == set(eligible)
    assert "period_packet.query source=predefined" in caplog.text


async def test_classifier_failure_preserves_discovery_while_provider_page_is_blocked(
    reusable, monkeypatch, caplog
):
    from hushh_mcp.services.drive_financial_packet_tagging import FinancialPacketTagger

    service, head, planner, transport = await preview_runtime(reusable, monkeypatch)
    entered, failed = asyncio.Event(), asyncio.Event()
    read = transport.read_tool.side_effect

    async def blocked_page(**kwargs):
        entered.set()
        await failed.wait()
        return await read(**kwargs)

    async def broken_classifier(*args, **kwargs):
        await entered.wait()
        failed.set()
        raise OSError("private local classifier path")

    transport.read_tool.side_effect = blocked_page
    monkeypatch.setattr(FinancialPacketTagger, "run_one", broken_classifier)
    result = await service.run(max_jobs=1, deadline_seconds=10)
    assert result["outcomes"]["completed"] == result["outcomes"]["tagging_deferred"] == 1
    saved = scheduled_snapshot(service.store)[("owner", head["period_start"])]
    assert saved[2]["complete"] and saved[2]["matched"] == 26
    assert len(saved[2]["documents"]) == 26
    planner.assert_not_awaited()
    assert "local_classifier_failure" in caplog.text and "OSError" in caplog.text
    assert "private local classifier path" not in caplog.text
