"""Scheduled financial preset rollout and immutable frozen-sale preservation."""

# ruff: noqa: F401,F811 -- canonical disposable PostgreSQL fixture graph
from datetime import datetime
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_financial_packet_recovery_postgres import legacy_pending_preview
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
    preview_read,
    preview_runtime,
    reusable,
    sharing,
)
from tests.services.test_drive_period_packets import scheduled_snapshot

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


def assert_queue_admission(metrics):
    assert datetime.fromisoformat(metrics["queued_at"]) <= datetime.fromisoformat(
        metrics["first_claimed_at"]
    )


async def resume_accepted_rollout(service, head, identity):
    """Advance only retry clocks, then let the next normal scheduled tick resume."""
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_packet_heads SET next_at=clock_timestamp() WHERE packet_id=:id"),
            {"id": identity},
        )
        connection.execute(
            text(
                "UPDATE drive_owner_search_jobs SET next_at=clock_timestamp() WHERE period_packet_id=:id AND status='queued'"
            ),
            {"id": identity},
        )
    service.search.transport.read_tool.side_effect = preview_read(
        head, empty=False, interrupt=False
    )
    result = await service.run(max_jobs=1, deadline_seconds=10)
    assert result["outcomes"]["completed"] == 1
    assert (await service.preview(user_id="owner", packet_id=identity))["complete"]


@pytest.mark.parametrize("fence", [None, "head_lease", "foreground"])
async def test_scheduled_rollout_replaces_future_due_stale_preview_only_when_unleased(
    reusable, monkeypatch, fence
):
    from hushh_mcp.services import drive_period_packet_enrollment as enrollment
    from hushh_mcp.services.drive_period_packet_contract import PacketPeriod
    from hushh_mcp.services.drive_period_packet_preview import write_build

    service, head, planner, transport = await preview_runtime(reusable, monkeypatch)
    identity, _, state, source, before = await legacy_pending_preview(
        service, head, planner, active_lease=False
    )
    period = PacketPeriod(start=head["period_start"], end=head["period_end"], timezone="UTC")
    monkeypatch.setattr(enrollment, "current_year_periods", lambda *_: [period])
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_packet_heads WHERE packet_id<>:id"), {"id": identity}
        )
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='completed',
          expires_at=clock_timestamp()+INTERVAL '1 day',lease_id=NULL,lease_expires_at=NULL WHERE job_id=:id"""),
            {"id": state["jobId"]},
        )
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": identity}
        )
        build = service.store._build(row)
        build["preview"]["complete"] = True
        write_build(service.store, connection, row, build)
        connection.execute(
            text("""UPDATE drive_packet_heads SET dirty=FALSE,attempts=8,
          predefined_query_version='financial-records-v0',next_at=clock_timestamp()+INTERVAL '1 day'
          WHERE packet_id=:id"""),
            {"id": identity},
        )
        if fence == "head_lease":
            connection.execute(
                text("""UPDATE drive_packet_heads SET lease_id=gen_random_uuid(),
              lease_expires_at=clock_timestamp()+INTERVAL '1 minute' WHERE packet_id=:id"""),
                {"id": identity},
            )
    if fence == "foreground":
        await service.search.store.create(
            user_id="owner",
            client_request_id=str(uuid4()),
            request={"query": "foreground", "timezone": "UTC"},
            checkpoint={},
            confirmed=True,
        )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one",
        AsyncMock(return_value="idle"),
    )
    transport.read_tool.side_effect = DriveReadError("provider_unavailable", retryable=False)
    result = await service.run(max_jobs=1, deadline_seconds=10)
    with service.store.db.engine.connect() as connection:
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": identity}
        )
        build = service.store._build(row)
        assert (
            connection.execute(
                text("SELECT metadata_envelope FROM drive_owner_search_results WHERE job_id=:id"),
                {"id": state["jobId"]},
            ).scalar_one()
            == before
        )
    if fence:
        assert row["revision"] == head["revision"] and "migration" not in build
        transport.read_tool.assert_not_awaited()
    else:
        assert row["revision"] == head["revision"] + 1
        assert row["dirty"] and build["migration"]["from"] == {"kind": "model"}
        assert build["query_source"]["planner_executed"] is False
        assert_queue_admission(build["metrics"])
        preview = await service.preview(user_id="owner", packet_id=identity)
        assert preview["stale"] and preview["documents"][0]["name"] == source["name"]
        assert transport.read_tool.await_count > 0 and result["outcomes"]["queued"] == 1
        await resume_accepted_rollout(service, head, identity)
    planner.assert_not_awaited()
    scheduled_snapshot(service.store)


async def legacy_frozen_runtime(
    reusable, monkeypatch, *, legacy_empty=False, current_year=True, cached_preview=True
):
    from hushh_mcp.services import drive_period_packet_enrollment as enrollment
    from hushh_mcp.services.drive_period_packet_contract import PacketPeriod
    from hushh_mcp.services.drive_period_packet_preview import write_build
    from tests.services.test_drive_packet_public_summary_postgres import prepared, publish

    service, head, _, publication = await prepared(reusable, monkeypatch, historical=True)
    identity = str(head["packet_id"])
    service.search.transport.read_tool.side_effect = preview_read(
        head, empty=legacy_empty, interrupt=False
    )
    assert (await completed_preview(service, identity))["complete"]
    await publish(publication, head, version=1)
    period = PacketPeriod(start=head["period_start"], end=head["period_end"], timezone="UTC")
    monkeypatch.setattr(enrollment, "current_year_periods", lambda *_: [period])
    if current_year:
        monkeypatch.setattr(
            "hushh_mcp.services.drive_period_packet_store.current_year_periods", lambda *_: [period]
        )
        monkeypatch.setattr(
            "hushh_mcp.services.drive_period_packet_preview.current_year_periods",
            lambda *_: [period],
        )
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_packet_heads WHERE packet_id<>:id"), {"id": identity}
        )
        connection.execute(
            text("""UPDATE drive_packet_heads SET tagging_pending=FALSE,
          tagging_next_at=NULL,predefined_query_version=NULL,
          next_at=clock_timestamp()+INTERVAL '1 day' WHERE packet_id=:id"""),
            {"id": identity},
        )
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": identity}
        )
        build = service.store._build(row)
        build.pop("query_source", None)
        if not cached_preview:
            build.pop("preview", None)
        write_build(service.store, connection, row, build)
        connection.execute(
            text("""INSERT INTO drive_packet_listings
          (packet_id,version,user_id,audience,enabled,price_cents,disclosure)
          VALUES(:id,1,'owner','connections',TRUE,500,'drive-packet-listing-connections-v1')"""),
            {"id": identity},
        )
        with pytest.raises(DriveReadError, match="packet_superseded"):
            service.store.current_period_head(connection, user_id="owner", packet_id=identity)
    return service, head, identity


@pytest.mark.parametrize("legacy_empty", [False, True])
@pytest.mark.parametrize("cached_preview", [False, True])
async def test_scheduled_frozen_owner_preview_preserves_sale_and_buyer_membership(
    reusable, monkeypatch, legacy_empty, cached_preview
):
    service, head, identity = await legacy_frozen_runtime(
        reusable, monkeypatch, legacy_empty=legacy_empty, cached_preview=cached_preview
    )
    before = frozen_sale_snapshot(service.store, identity)
    member = buyer_membership(service.store, identity, legacy_empty)
    await assert_legacy_preview_truth(service, identity, expected=0 if legacy_empty else 26)
    service.planner.side_effect = AssertionError("financial preset called Azure")
    service.search.transport.read_tool.reset_mock()
    service.search.transport.read_tool.side_effect = DriveReadError(
        "provider_unavailable", retryable=False
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one",
        AsyncMock(return_value="idle"),
    )
    await service.run(max_jobs=1, deadline_seconds=10)
    assert frozen_sale_snapshot(service.store, identity) == before
    retained = await service.preview(user_id="owner", packet_id=identity)
    assert retained["stale"] and retained["matched"] == (0 if legacy_empty else 26)
    assert len(retained["documents"]) == (0 if legacy_empty else 25)
    if not legacy_empty:
        tail = await service.preview(
            user_id="owner", packet_id=identity, cursor=retained["nextCursor"]
        )
        assert len(tail["documents"]) == 1
    assert frozen_sale_snapshot(service.store, identity) == before
    await resume_accepted_rollout(service, head, identity)
    assert await service.store.due_owners(limit=1) == []
    with service.store.db.engine.connect() as connection:
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": identity}
        )
        build = service.store._build(row)
        assert row["current_version"] == build["owner_preview_version"] == 1 and not row["dirty"]
        assert build["query_source"] == {
            "kind": "predefined",
            "version": "financial-records-v1",
            "planner_executed": False,
        }
        assert build["migration"]["from"] == {"kind": "legacy_unrecorded"}
        assert build["preview"]["complete"] and build["preview"]["matched"] == 26
    assert frozen_sale_snapshot(service.store, identity) == before
    assert buyer_membership(service.store, identity, legacy_empty) == member
    saved = scheduled_snapshot(service.store)
    reads = service.search.transport.read_tool.await_count
    await service.run(max_jobs=1, deadline_seconds=10)
    assert (
        scheduled_snapshot(service.store) == saved
        and service.search.transport.read_tool.await_count == reads
    )
    service.planner.assert_not_awaited()


async def assert_legacy_preview_truth(service, identity, *, expected):
    """Reading retained originals neither runs nor invents current provider discovery."""

    def head():
        with service.store.db.engine.connect() as connection:
            return connection.execute(
                text("SELECT to_jsonb(h) FROM drive_packet_heads h WHERE packet_id=:id"),
                {"id": identity},
            ).scalar_one()

    before = head()
    calls = service.search.transport.read_tool.await_count
    preview = await service.preview(user_id="owner", packet_id=identity)
    assert preview["status"] == "not_started" and preview["matched"] is None
    assert not preview["complete"] and preview["stale"]
    documents = list(preview["documents"])
    if preview["nextCursor"]:
        tail = await service.preview(
            user_id="owner", packet_id=identity, cursor=preview["nextCursor"]
        )
        assert tail["matched"] is None and not tail["complete"] and tail["stale"]
        documents.extend(tail["documents"])
    assert len(documents) == expected and all(item["viewUrl"] for item in documents)
    assert head() == before and service.search.transport.read_tool.await_count == calls


@pytest.mark.parametrize("legacy_empty", [False, True])
async def test_uncached_legacy_manifest_links_do_not_claim_completed_preset(
    reusable, monkeypatch, legacy_empty
):
    service, _, identity = await legacy_frozen_runtime(
        reusable, monkeypatch, legacy_empty=legacy_empty, cached_preview=False
    )
    before = frozen_sale_snapshot(service.store, identity)
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_owner_search_jobs WHERE period_packet_id=:id"), {"id": identity}
        )
    await assert_legacy_preview_truth(service, identity, expected=0 if legacy_empty else 25)
    assert frozen_sale_snapshot(service.store, identity) == before


def frozen_sale_snapshot(store, identity):
    with store.db.engine.connect() as connection:
        return connection.execute(
            text("""SELECT h.current_version,h.public_summary_enabled,
          h.public_summary_revision,h.public_summary_version,h.public_summary_generation,
          to_jsonb(v),to_jsonb(l) FROM drive_packet_heads h JOIN drive_packet_versions v
          ON v.packet_id=h.packet_id AND v.version=h.current_version
          LEFT JOIN drive_packet_listings l ON l.packet_id=h.packet_id AND l.version=v.version
          WHERE h.packet_id=:id"""),
            {"id": identity},
        ).one()


def buyer_membership(store, identity, empty):
    with store.db.engine.begin() as connection:
        if empty:
            with pytest.raises(DriveReadError, match="packet_unavailable"):
                store.period_manifest_locked(
                    connection,
                    owner_user_id="owner",
                    packet_id=identity,
                    version=1,
                    viewer_user_id="recipient",
                )
            return None
        manifest = store.period_manifest_locked(
            connection,
            owner_user_id="owner",
            packet_id=identity,
            version=1,
            viewer_user_id="recipient",
        )
        return manifest["digest"], manifest["selected_document_ids"], manifest["sources"]


@pytest.mark.parametrize("current_year", [False, True])
async def test_frozen_preview_claim_is_current_year_only_and_cannot_freeze_again(
    reusable, monkeypatch, current_year
):
    service, _, identity = await legacy_frozen_runtime(
        reusable, monkeypatch, current_year=current_year
    )
    service.search.transport.read_tool.reset_mock()
    before = frozen_sale_snapshot(service.store, identity)
    await service.store.ensure_owner(user_id="owner")
    job = await service.store.claim_build(user_id="owner", packet_id=identity)
    if not current_year:
        assert job is None
        assert not await service.store.request_preview(
            user_id="owner", packet_id=identity, refresh=True
        )
    else:
        assert job["build"]["owner_preview_version"] == 1
        with pytest.raises(DriveReadError, match="packet_superseded"):
            await service.store.freeze(job, search_job_id=str(uuid4()))
        with service.store.db.engine.begin() as connection:
            service.store.current_period_head(
                connection,
                user_id="owner",
                packet_id=identity,
                revision=job["revision"],
                lease_id=job["lease_id"],
            )
            with pytest.raises(DriveReadError, match="packet_superseded"):
                service.store.current_period_head(
                    connection,
                    user_id="owner",
                    packet_id=identity,
                    revision=job["revision"] - 1,
                    lease_id=job["lease_id"],
                )
            with pytest.raises(DriveReadError, match="packet_superseded"):
                service.store.current_period_head(
                    connection,
                    user_id="owner",
                    packet_id=identity,
                    revision=job["revision"],
                    lease_id=str(uuid4()),
                )
    assert frozen_sale_snapshot(service.store, identity) == before
    service.search.transport.read_tool.assert_not_awaited()


async def test_enrollment_fills_missing_history_when_current_preview_is_already_complete(
    reusable, monkeypatch
):
    from datetime import date

    from hushh_mcp.services.drive_period_packet_contract import PacketPeriod

    periods = [
        PacketPeriod(start=date(2020, 1, 1), end=date(2020, 2, 29), timezone="UTC"),
        PacketPeriod(start=date(2020, 3, 1), end=date(2020, 4, 30), timezone="UTC"),
    ]
    monkeypatch.setattr(
        "hushh_mcp.services.drive_period_packet_enrollment.current_year_periods",
        lambda *_: periods,
    )
    service, head, _, transport = await preview_runtime(reusable, monkeypatch)
    identity = str(head["packet_id"])
    await completed_preview(service, identity)
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_packet_heads WHERE packet_id<>:id"), {"id": identity}
        )
    assert await service.store.due_owners(limit=1) == ["owner"]
    transport.read_tool.reset_mock()
    await service.store.ensure_owner(user_id="owner")
    job = await service.store.claim_build(user_id="owner")
    assert job is not None and job["period_start"] < head["period_start"]
    assert await service.store.claim_build(user_id="owner", packet_id=str(job["packet_id"])) is None
    transport.read_tool.assert_not_awaited()


async def test_current_preset_completed_open_preview_waits_for_daily_schedule(
    reusable, monkeypatch
):
    from hushh_mcp.services import drive_period_packet_enrollment as enrollment
    from hushh_mcp.services.drive_financial_packet_query import QUERY_VERSION
    from hushh_mcp.services.drive_period_packet_contract import PacketPeriod

    service, head, planner, transport = await preview_runtime(reusable, monkeypatch)
    identity = str(head["packet_id"])
    assert (await completed_preview(service, identity))["complete"]
    period = PacketPeriod(start=head["period_start"], end=head["period_end"], timezone="UTC")
    monkeypatch.setattr(enrollment, "current_year_periods", lambda *_: [period])
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_packet_heads WHERE packet_id<>:id"), {"id": identity}
        )
        row = connection.execute(
            text("""SELECT current_version,predefined_query_version,
          next_at>clock_timestamp() AS future FROM drive_packet_heads WHERE packet_id=:id"""),
            {"id": identity},
        ).one()
    assert row == (0, QUERY_VERSION, True)
    before = scheduled_snapshot(service.store)
    transport.read_tool.reset_mock()
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one",
        AsyncMock(return_value="idle"),
    )
    assert await service.store.due_owners(limit=1) == []
    assert await service.store.claim_build(user_id="owner", packet_id=identity) is None
    await service.run(max_jobs=1, deadline_seconds=10)
    assert scheduled_snapshot(service.store) == before
    planner.assert_not_awaited()
    transport.read_tool.assert_not_awaited()
