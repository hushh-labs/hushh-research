"""Scheduled repair of lost owner pagination, without touching frozen sales."""

# ruff: noqa: F401,F811 -- canonical disposable PostgreSQL fixture graph
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_period_packet_contract import PacketPeriod
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from tests.services.test_drive_financial_packet_rollout_postgres import (
    buyer_membership,
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    frozen_sale_snapshot,
    ingestion,
    legacy_frozen_runtime,
    lifecycle,
    reusable,
    sharing,
)

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


async def missing_runtime(reusable, monkeypatch, case):
    service, head, packet = await legacy_frozen_runtime(
        reusable, monkeypatch, legacy_empty=case != "nonempty_sale"
    )
    size = 51 if case == "full_cache" else 130

    async def provider(*, user_id, tool_name, arguments):
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(False, {"drives": []}, False)
        offset = 100 if arguments.get("pageToken") else 0
        files = [
            {
                "id": f"original-{i}",
                "title": f"Statement {i}",
                "mimeType": "application/pdf",
                "createdTime": f"{head['period_start']}T12:00:00Z",
                "version": "1",
            }
            for i in range(offset, min(size, offset + 100))
        ]
        return ExternalMcpToolResult(
            False, {"files": files, "nextPageToken": "tail" if size > offset + 100 else None}, False
        )

    service.search.transport.read_tool.side_effect = provider
    completed = await service.run_one(user_id="owner", packet_id=packet, deadline_seconds=20)
    assert completed == "completed"
    period = PacketPeriod(start=head["period_start"], end=head["period_end"], timezone="UTC")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_period_packet_contract.current_year_periods",
        lambda *_: [period],
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one",
        AsyncMock(return_value="idle"),
    )
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_packet_heads WHERE packet_id<>:id"), {"id": packet}
        )
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": packet}
        )
        source = service.store._build(row)["search_job_id"]
        if case == "expired_present":
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET expires_at=clock_timestamp()-INTERVAL '1 day' WHERE job_id=:id"
                ),
                {"id": source},
            )
        else:
            connection.execute(
                text("DELETE FROM drive_owner_search_jobs WHERE job_id=:id"), {"id": source}
            )
        if case == "lease":
            connection.execute(
                text(
                    "UPDATE drive_packet_heads SET lease_id=gen_random_uuid(),lease_expires_at=clock_timestamp()+INTERVAL '1 minute' WHERE packet_id=:id"
                ),
                {"id": packet},
            )
        elif case == "background_off":
            connection.exec_driver_sql(
                "UPDATE drive_live_preferences SET background_enabled=FALSE WHERE user_id='owner'"
            )
        elif case == "revoked":
            connection.exec_driver_sql(
                "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='owner'"
            )
    if case == "foreground":
        await service.search.store.create(
            user_id="owner",
            client_request_id=str(uuid4()),
            request={"query": "ordinary"},
            checkpoint={},
            confirmed=True,
        )
    service.search.transport.read_tool.reset_mock()
    return service, packet, source, size


@pytest.mark.parametrize(
    "case",
    [
        "missing",
        "nonempty_sale",
        "expired_present",
        "full_cache",
        "lease",
        "background_off",
        "revoked",
        "foreground",
    ],
)
async def test_missing_truncated_originals_recover_without_owner_click(reusable, monkeypatch, case):
    service, packet, source, size = await missing_runtime(reusable, monkeypatch, case)
    before = frozen_sale_snapshot(service.store, packet)
    preparation = preparation_snapshot(service.store, packet)
    member = buyer_membership(service.store, packet, False) if case == "nonempty_sale" else None
    expected = case in {"missing", "nonempty_sale"}
    assert await service.store.due_owners(limit=1) == (["owner"] if expected else [])
    if expected:
        retained = await service.preview(user_id="owner", packet_id=packet)
        assert retained["stale"] and retained["matched"] == size and retained["limited"]
        assert len(retained["documents"]) == 25
    result = await service.run(max_jobs=1, deadline_seconds=20)
    assert frozen_sale_snapshot(service.store, packet) == before
    service.planner.assert_not_awaited()
    if not expected:
        service.search.transport.read_tool.assert_not_awaited()
        assert preparation_snapshot(service.store, packet) == preparation
        return
    assert result["outcomes"]["completed"] == 1
    if member is not None:
        assert buyer_membership(service.store, packet, False) == member
    with service.store.db.engine.connect() as connection:
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": packet}
        )
        build = service.store._build(row)
        assert build["recovery"]["reason"] == "missing_search_source"
        assert build["recovery"]["previous_job_id"] == source
        assert build["search_job_id"] != source and row["current_version"] == before[0]
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_results WHERE job_id=:id"),
                {"id": build["search_job_id"]},
            ).scalar_one()
            == size
        )
    preview = await service.preview(user_id="owner", packet_id=packet)
    total = len(preview["documents"])
    while preview["nextCursor"]:
        preview = await service.preview(
            user_id="owner", packet_id=packet, cursor=preview["nextCursor"]
        )
        total += len(preview["documents"])
    assert total == size and preview["complete"] and not preview["limited"]
    calls = service.search.transport.read_tool.await_count
    await service.run(max_jobs=1, deadline_seconds=20)
    assert service.search.transport.read_tool.await_count == calls


def preparation_snapshot(store, packet):
    with store.db.engine.connect() as connection:
        return connection.execute(
            text(
                "SELECT revision,build_envelope,current_version FROM drive_packet_heads WHERE packet_id=:id"
            ),
            {"id": packet},
        ).one()


async def test_present_source_hint_cannot_consume_another_owners_due_slot(reusable, monkeypatch):
    from tests.services.test_drive_period_packets import seed_scheduled_owners

    service, packet, source, _ = await missing_runtime(reusable, monkeypatch, "expired_present")
    before = preparation_snapshot(service.store, packet)
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient,ready")
    seed_scheduled_owners(service.store, ["ready"], clear_heads=False)
    await service.store.ensure_owner(user_id="ready")
    assert await service.store.due_owners(limit=1) == ["ready"]
    outcome = await service.run(max_jobs=1, deadline_seconds=20)
    assert outcome["outcomes"]["completed"] == 1
    assert preparation_snapshot(service.store, packet) == before
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM drive_owner_search_jobs WHERE user_id='owner' AND job_id=:source"
                ),
                {"source": source},
            ).scalar_one()
            == 1
        )
        assert (
            connection.execute(
                text("SELECT status FROM drive_owner_search_jobs WHERE user_id='ready'")
            ).scalar_one()
            == "completed"
        )


async def pending_runtime(reusable, monkeypatch):
    service, head, packet = await legacy_frozen_runtime(reusable, monkeypatch)
    from hushh_mcp.services.drive_period_packet_contract import PacketPeriod

    period = PacketPeriod(start=head["period_start"], end=head["period_end"], timezone="UTC")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_period_packet_contract.current_year_periods", lambda *_: [period]
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one",
        AsyncMock(return_value="idle"),
    )

    async def provider(*, user_id, tool_name, arguments):
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(False, {"drives": []}, False)
        offset = 100 if arguments.get("pageToken") else 0
        files = [
            {
                "id": f"pending-{i}",
                "title": f"Statement {i}",
                "version": "1",
                "mimeType": "application/pdf",
                "createdTime": f"{head['period_start']}T12:00:00Z",
            }
            for i in range(offset, min(130, offset + 100))
        ]
        return ExternalMcpToolResult(
            False, {"files": files, "nextPageToken": "tail" if offset == 0 else None}, False
        )

    service.search.transport.read_tool.side_effect = provider
    before = frozen_sale_snapshot(service.store, packet)
    assert (
        await service.run_one(
            user_id="owner", packet_id=packet, deadline_seconds=20, first_results_only=True
        )
        == "queued"
    )
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_packet_heads SET dirty=FALSE,
            next_at=clock_timestamp(),tagging_next_at=clock_timestamp() WHERE packet_id=:id"""),
            {"id": packet},
        )
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": packet}
        )
        source = service.store._build(row)["search_job_id"]
        retained = connection.execute(
            text(
                "SELECT position,metadata_envelope FROM drive_owner_search_results WHERE job_id=:id ORDER BY position"
            ),
            {"id": source},
        ).all()
    assert len(retained) == 100
    service.search.transport.read_tool.reset_mock()
    return service, packet, source, before, retained


async def test_scheduled_pending_child_resumes_without_rotating_saved_originals(
    reusable, monkeypatch
):
    service, packet, source, frozen, retained = await pending_runtime(reusable, monkeypatch)
    preparation = preparation_snapshot(service.store, packet)
    assert await service.store.due_owners(limit=1) == ["owner"]
    assert preparation_snapshot(service.store, packet) == preparation
    outcome = await service.run(max_jobs=1, deadline_seconds=20)
    assert outcome["outcomes"]["completed"] == 1
    assert frozen_sale_snapshot(service.store, packet) == frozen
    service.planner.assert_not_awaited()
    with service.store.db.engine.connect() as connection:
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": packet}
        )
        assert row["revision"] == preparation[0]
        assert service.store._build(row)["search_job_id"] == source
        results = connection.execute(
            text(
                "SELECT position,metadata_envelope FROM drive_owner_search_results WHERE job_id=:id ORDER BY position"
            ),
            {"id": source},
        ).all()
        assert len(results) == 130 and results[:100] == retained
    calls = service.search.transport.read_tool.call_args_list
    assert calls[0].kwargs["arguments"]["pageToken"] == "tail"


async def test_clean_exceptional_claim_keeps_next_search_slice_runnable(reusable, monkeypatch):
    service, packet, source, frozen, _ = await pending_runtime(reusable, monkeypatch)
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_packet_heads SET predefined_query_version='financial-records-v0' WHERE packet_id=:id"
            ),
            {"id": packet},
        )
    claimed = await service.store.claim_build(user_id="owner", packet_id=packet)
    assert claimed["build"]["search_job_id"] == source
    await service.store.save_build(claimed, claimed["build"])
    with service.store.db.engine.begin() as connection:
        assert connection.execute(
            text("SELECT dirty FROM drive_packet_heads WHERE packet_id=:id"), {"id": packet}
        ).scalar_one()
        connection.execute(
            text("UPDATE drive_packet_heads SET next_at=clock_timestamp() WHERE packet_id=:id"),
            {"id": packet},
        )
    assert (await service.run(max_jobs=1, deadline_seconds=20))["outcomes"]["completed"] == 1
    assert frozen_sale_snapshot(service.store, packet) == frozen
    with service.store.db.engine.connect() as connection:
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": packet}
        )
        assert service.store._build(row)["search_job_id"] == source


@pytest.mark.parametrize(
    "fence",
    [
        "head_lease",
        "job_lease",
        "stale",
        "origin",
        "client",
        "job_future",
        "background_off",
        "revoked",
        "foreground",
    ],
)
async def test_pending_child_continuation_retains_authority_fences(reusable, monkeypatch, fence):
    from hushh_mcp.services.drive_period_packet_preview import write_build

    service, packet, source, frozen, _ = await pending_runtime(reusable, monkeypatch)
    with service.store.db.engine.begin() as connection:
        if fence in {"head_lease", "job_lease"}:
            table, key, identity = (
                ("drive_packet_heads", "packet_id", packet)
                if fence == "head_lease"
                else ("drive_owner_search_jobs", "job_id", source)
            )
            connection.execute(
                text(
                    f"UPDATE {table} SET lease_id=gen_random_uuid(),lease_expires_at=clock_timestamp()+INTERVAL '1 minute' WHERE {key}=:id"
                ),
                {"id": identity},
            )
        elif fence == "stale":
            row = service.store._row(
                connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": packet}
            )
            build = service.store._build(row)
            build["search_job_id"] = str(uuid4())
            write_build(service.store, connection, row, build)
        elif fence == "background_off":
            connection.exec_driver_sql(
                "UPDATE drive_live_preferences SET background_enabled=FALSE WHERE user_id='owner'"
            )
        elif fence == "revoked":
            connection.exec_driver_sql(
                "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='owner'"
            )
        elif fence == "client":
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET client_request_id=:client WHERE job_id=:id"
                ),
                {"client": str(uuid4()), "id": source},
            )
        elif fence == "job_future":
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET next_at=clock_timestamp()+INTERVAL '1 day' WHERE job_id=:id"
                ),
                {"id": source},
            )
        elif fence == "origin":
            child = service.store._row(
                connection, "SELECT * FROM drive_owner_search_jobs WHERE job_id=:id", {"id": source}
            )
            checkpoint = service.search.store._checkpoint(child)
            checkpoint["period_packet_origin"]["revision"] += 1
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb) WHERE job_id=:id"
                ),
                {
                    "id": source,
                    "envelope": service.search.store._seal(
                        checkpoint, "owner", source, "owner-search-checkpoint"
                    ),
                },
            )
    if fence == "foreground":
        # The real foreground admission stops the unleased preparation child.
        await service.search.store.create(
            user_id="owner",
            client_request_id=str(uuid4()),
            request={"query": "ordinary"},
            checkpoint={},
            confirmed=True,
        )
    preparation = preparation_snapshot(service.store, packet)
    assert await service.store.due_owners(limit=1) == []
    assert preparation_snapshot(service.store, packet) == preparation
    assert frozen_sale_snapshot(service.store, packet) == frozen
    service.search.transport.read_tool.assert_not_awaited()
