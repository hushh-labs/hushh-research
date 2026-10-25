"""Public summary consent is separate from private packet and purchase authority."""

# ruff: noqa: F401,F811 -- disposable PostgreSQL fixture dependencies
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.consent.audit_logger import audit_context
from hushh_mcp.services.drive_packet_public_summary import (
    DISCLOSURE,
    DrivePacketPublicSummaryService,
)
from hushh_mcp.services.drive_telemetry import correlation_tag
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
from tests.services.test_drive_request_bulk_postgres import request_bulk

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]
FIELDS = {
    "packetId",
    "version",
    "category",
    "title",
    "periodStart",
    "periodEnd",
    "timezone",
    "documentCount",
    "countBasis",
    "complete",
    "updatedAt",
    "priceCents",
    "currency",
    "availability",
    "viewerAction",
}


async def prepared(reusable, monkeypatch, *, historical=False):
    runtime, head, _, _ = await preview_runtime(reusable, monkeypatch, historical=historical)
    person = str(uuid4())
    with runtime.store.db.engine.begin() as c:
        c.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS actor_profiles(user_id TEXT PRIMARY KEY,public_person_ref UUID,public_profile_status TEXT)"
        )
        c.execute(
            text("INSERT INTO actor_profiles VALUES ('owner',:ref,'active')"), {"ref": person}
        )
        c.exec_driver_sql(
            "ALTER TABLE connections ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()"
        )
        c.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS connection_requests(id UUID DEFAULT gen_random_uuid(),requester_user_id TEXT,addressee_user_id TEXT,status TEXT,created_at TIMESTAMPTZ DEFAULT now())"
        )
    service = DrivePacketPublicSummaryService(store=runtime.store, require_owner=AsyncMock())
    return runtime, head, person, service


async def publish(service, head, *, enabled=True, revision=0, version=0):
    return await service.set_public_summary(
        user_id="owner",
        packet_id=str(head["packet_id"]),
        enabled=enabled,
        version=version,
        expected_revision=revision,
        disclosure=DISCLOSURE,
    )


async def test_explicit_publication_exposes_only_scalar_summary_and_saved_preview(
    reusable, monkeypatch, caplog
):
    runtime, head, person, service = await prepared(reusable, monkeypatch)

    async def read():
        return await service.list_public_summaries(viewer_user_id="stranger", person_ref=person)

    assert (await read())["packets"] == []
    assert (await publish(service, head))["enabled"]
    with monkeypatch.context() as scoped:
        scoped.setattr(
            runtime.store,
            "_build",
            lambda row: (_ for _ in ()).throw(AssertionError("public read decrypted build")),
        )
        caplog.set_level("INFO", logger="drive_packet_public_summary")
        with audit_context("packet-summary-trace"):
            item = (await read())["packets"][0]
    assert set(item) == FIELDS and item["documentCount"] is None
    assert item["viewerAction"] == "connect" and item["availability"] == "preparing"
    events = [
        record.getMessage()
        for record in caplog.records
        if record.name == "drive_packet_public_summary"
    ]
    assert len(events) == 1
    assert "viewer_state=none version=0 action=connect" in events[0]
    assert f"request_tag={correlation_tag('packet-summary-trace')}" in events[0]
    assert "drive_op=none" not in events[0] and "stranger" not in events[0]
    await completed_preview(runtime, str(head["packet_id"]))
    item = (await read())["packets"][0]
    assert item["documentCount"] == 26 and item["complete"]
    assert item["countBasis"] == "discovery_matches" and item["priceCents"] == 500
    assert "preview-file" not in str(item) and "Example statement" not in str(item)
    with pytest.raises(DriveReadError):
        await runtime.preview(user_id="stranger", packet_id=str(head["packet_id"]))
    with pytest.raises(DriveReadError):
        await publish(service, head, revision=0)


async def test_publication_does_not_follow_freeze_and_frozen_count_is_sale_count(
    reusable, monkeypatch
):
    runtime, head, person, service = await prepared(reusable, monkeypatch, historical=True)
    await publish(service, head)
    await completed_preview(runtime, str(head["packet_id"]))
    assert (await service.list_public_summaries(viewer_user_id="stranger", person_ref=person))[
        "packets"
    ] == []
    await publish(service, head, revision=1, version=1)
    item = (await service.list_public_summaries(viewer_user_id="stranger", person_ref=person))[
        "packets"
    ][0]
    assert (
        item["version"] == 1 and item["countBasis"] == "sale_files" and item["documentCount"] == 25
    )
    assert item["complete"] and set(item) == FIELDS


@pytest.mark.parametrize("change", ["hidden", "generation", "background"])
async def test_current_publication_denied_after_authority_change_and_can_be_withdrawn(
    reusable, monkeypatch, change
):
    runtime, head, person, service = await prepared(reusable, monkeypatch)
    await publish(service, head)
    with runtime.store.db.engine.begin() as c:
        if change == "hidden":
            c.exec_driver_sql("UPDATE actor_profiles SET public_profile_status='hidden'")
        elif change == "generation":
            c.exec_driver_sql(
                "UPDATE user_external_connector_connections SET connection_generation=connection_generation+1 WHERE user_id='owner'"
            )
        else:
            c.exec_driver_sql(
                "INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled) VALUES ('owner',1,FALSE) ON CONFLICT(user_id) DO UPDATE SET background_enabled=FALSE"
            )
    if change == "hidden":
        with pytest.raises(DriveReadError):
            await service.list_public_summaries(viewer_user_id="stranger", person_ref=person)
    else:
        result = await service.list_public_summaries(viewer_user_id="stranger", person_ref=person)
        if change == "background":
            assert len(result["packets"]) == 1 and set(result["packets"][0]) == FIELDS
            assert result["packets"][0]["availability"] == "unavailable"
        else:
            assert result["packets"] == []
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "false")
    monkeypatch.setenv("DRIVE_PERIOD_PACKETS_ENABLED", "false")
    assert not (await publish(service, head, enabled=False, revision=1))["enabled"]


async def test_wrong_owner_cannot_publish_and_replay_does_not_forge_acceptance(
    reusable, monkeypatch
):
    runtime, head, _, service = await prepared(reusable, monkeypatch)
    with pytest.raises(DriveReadError):
        await service.set_public_summary(
            user_id="stranger",
            packet_id=str(head["packet_id"]),
            enabled=True,
            version=0,
            expected_revision=0,
            disclosure=DISCLOSURE,
        )
    with runtime.store.db.engine.begin() as c:
        from tests.drive_postgres_test_support import apply_drive_fixture_migration

        apply_drive_fixture_migration(c, "417_drive_packet_public_summary.sql")
        row = c.execute(
            text(
                "SELECT public_summary_enabled,public_summary_accepted_at FROM drive_packet_heads WHERE packet_id=:id"
            ),
            {"id": head["packet_id"]},
        ).one()
        assert row == (False, None)


async def requested_packet(reusable, sharing, monkeypatch):
    from hushh_mcp.services.drive_packet_catalog_service import DrivePacketCatalogService
    from hushh_mcp.services.drive_sharing_service import DriveSharingService
    from tests.services.test_drive_packet_catalog_postgres import recipient
    from tests.services.test_drive_reusable_packets_postgres import LISTING_DISCLOSURE

    runtime, head, person, service = await prepared(reusable, monkeypatch, historical=True)
    await completed_preview(runtime, str(head["packet_id"]))
    await publish(service, head, version=1)
    monkeypatch.setattr(
        "hushh_mcp.services.drive_packet_catalog_service.wake_drive_work_stages", AsyncMock()
    )
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    await runtime.store.set_listing(
        user_id="owner",
        packet_id=str(head["packet_id"]),
        version=1,
        decision="allow",
        price_cents=500,
        expected_revision=0,
        disclosure=LISTING_DISCLOSURE,
    )
    catalog = DrivePacketCatalogService(
        sharing=DriveSharingService(store=sharing), packets=runtime.store, require_owner=AsyncMock()
    )
    created = await catalog.request_packet(
        user_id="recipient",
        recipient=recipient(),
        packet_id=str(head["packet_id"]),
        version=1,
        client_request_id=str(uuid4()),
    )
    return runtime, head, person, service, catalog, created


async def test_document_request_actions_require_current_connection(
    reusable, sharing, request_bulk, monkeypatch
):
    runtime, head, person, service, catalog, created = await requested_packet(
        reusable, sharing, monkeypatch
    )

    async def action():
        return (await service.list_public_summaries(viewer_user_id="recipient", person_ref=person))[
            "packets"
        ][0]["viewerAction"]

    # Pending document approval is not a pending connection handshake.
    assert await action() == "view_request"
    with runtime.store.db.engine.begin() as c:
        c.execute(
            text("UPDATE drive_share_requests SET status='completed' WHERE request_id=:id"),
            {"id": created["requestId"]},
        )
    assert await action() == "view_files"
    with runtime.store.db.engine.begin() as c:
        c.exec_driver_sql("UPDATE connections SET status='removed'")
    assert await action() == "connect"


def set_purchase_stage(sharing, request_id, stage):
    identity = {"request": request_id}
    with sharing.db.engine.begin() as c:
        if stage == "paid":
            c.execute(
                text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,amount_cents,status,paid_at)
              VALUES('test',:request,'owner','recipient',500,'paid',clock_timestamp())"""),
                identity,
            )
        elif stage == "completed":
            c.execute(
                text(
                    "UPDATE drive_share_requests SET status='completed' WHERE request_id=:request"
                ),
                identity,
            )
        elif stage == "stopped":
            c.execute(
                text(
                    "UPDATE drive_share_requests SET access_stop_requested_at=clock_timestamp() WHERE request_id=:request"
                ),
                identity,
            )
        elif stage == "expired":
            c.execute(
                text(
                    "UPDATE drive_share_requests SET created_at=clock_timestamp()-INTERVAL '2 days',expires_at=clock_timestamp()-INTERVAL '1 second' WHERE request_id=:request"
                ),
                identity,
            )


@pytest.mark.parametrize("stage", ["pending", "paid", "completed", "stopped", "expired"])
async def test_withdrawn_private_listing_retains_only_buyers_existing_request(
    reusable, sharing, request_bulk, monkeypatch, stage
):
    from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
    from tests.services.test_drive_packet_catalog_postgres import recipient

    runtime, head, person, service, catalog, created = await requested_packet(
        reusable, sharing, monkeypatch
    )
    set_purchase_stage(sharing, created["requestId"], stage)
    await runtime.store.set_listing(
        user_id="owner",
        packet_id=str(head["packet_id"]),
        version=1,
        decision="deny",
        price_cents=500,
        expected_revision=1,
        disclosure=None,
    )
    page = await catalog.list_packets(user_id="recipient", owner_user_id="owner")
    if stage in {"stopped", "expired"}:
        assert page["packets"] == []
        return
    packet = page["packets"][0]
    assert packet["requestId"] == created["requestId"]
    assert (
        packet["purchaseState"]
        == {"pending": "pending", "paid": "paid", "completed": "delivered"}[stage]
    )
    assert packet["listingEnabled"] is False and packet["canRequest"] is False
    assert "contents" not in packet
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await catalog.request_packet(
            user_id="recipient",
            recipient=recipient(),
            packet_id=packet["packetId"],
            version=1,
            client_request_id=str(uuid4()),
        )
    if stage != "completed":
        with sharing.db.engine.begin() as c:
            with pytest.raises(DriveReadError, match="packet_unavailable"):
                DriveRequestPaymentService(db=sharing.db)._current_checkout_authority(
                    c, request_id=created["requestId"], requester_user_id="recipient"
                )
    await publish(service, head, enabled=False, revision=1, version=1)
    assert (await service.list_public_summaries(viewer_user_id="recipient", person_ref=person))[
        "packets"
    ] == []
    assert (await catalog.list_packets(user_id="recipient", owner_user_id="owner"))["packets"][0][
        "requestId"
    ] == created["requestId"]
    with pytest.raises(DriveReadError, match="connection_required"):
        await catalog.list_packets(user_id="stranger", owner_user_id="owner")
    with sharing.db.engine.begin() as c:
        assert c.execute(text("SELECT count(*) FROM drive_share_requests")).scalar_one() == 1
        assert c.execute(
            text("SELECT count(*) FROM drive_request_payment_orders")
        ).scalar_one() == (1 if stage == "paid" else 0)
        c.exec_driver_sql("UPDATE connections SET status='removed'")
    with pytest.raises(DriveReadError, match="connection_required"):
        await catalog.list_packets(user_id="recipient", owner_user_id="owner")


@pytest.mark.parametrize("outgoing,expected", [(True, "pending"), (False, "unavailable")])
async def test_connection_handshake_has_separate_action(reusable, monkeypatch, outgoing, expected):
    runtime, head, person, service = await prepared(reusable, monkeypatch)
    await publish(service, head)
    with runtime.store.db.engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO connection_requests(requester_user_id,addressee_user_id,status) VALUES(:requester,:addressee,'pending')"
            ),
            {
                "requester": "stranger" if outgoing else "owner",
                "addressee": "owner" if outgoing else "stranger",
            },
        )
    result = await service.list_public_summaries(viewer_user_id="stranger", person_ref=person)
    assert result["packets"][0]["viewerAction"] == expected


async def test_publication_locks_connection_before_head_but_withdrawal_does_not(
    reusable, monkeypatch
):
    runtime, head, _, service = await prepared(reusable, monkeypatch)
    order = []
    access, row = runtime.store.live_active, runtime.store._row

    def live_active(connection, **kwargs):
        order.append("connection")
        return access(connection, **kwargs)

    def read_row(connection, sql, params):
        if "drive_packet_heads" in sql and "FOR UPDATE" in sql:
            order.append("head")
        return row(connection, sql, params)

    monkeypatch.setattr(runtime.store, "live_active", live_active)
    monkeypatch.setattr(runtime.store, "_row", read_row)
    await publish(service, head)
    assert order == ["connection", "head"]
    order.clear()
    await publish(service, head, enabled=False, revision=1)
    assert order == ["head"]


async def test_paused_background_allows_explicit_saved_summary_but_not_processing(
    reusable, monkeypatch
):
    runtime, head, person, service = await prepared(reusable, monkeypatch)
    with runtime.store.db.engine.begin() as c:
        c.exec_driver_sql(
            "INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled) VALUES ('owner',1,FALSE)"
        )
    await publish(service, head)
    result = await service.list_public_summaries(viewer_user_id="stranger", person_ref=person)
    assert len(result["packets"]) == 1 and result["packets"][0]["availability"] == "unavailable"
    with pytest.raises(DriveReadError, match="background_preparation_required"):
        await runtime.preview(user_id="owner", packet_id=str(head["packet_id"]))
    runtime.planner.assert_not_awaited()
    runtime.search.transport.read_tool.assert_not_awaited()
    with runtime.store.db.engine.connect() as c:
        assert (
            c.exec_driver_sql(
                "SELECT background_enabled FROM drive_live_preferences WHERE user_id='owner'"
            ).scalar_one()
            is False
        )


@pytest.mark.parametrize("state", ["paused", "revoked", "version", "generation"])
async def test_owner_withdrawal_receipts_survive_cold_access_loss(reusable, monkeypatch, state):
    runtime, head, _, service = await prepared(reusable, monkeypatch, historical=True)
    await publish(service, head)
    if state == "version":
        await completed_preview(runtime, str(head["packet_id"]))
    with runtime.store.db.engine.begin() as c:
        if state == "paused":
            c.exec_driver_sql(
                "INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled) VALUES ('owner',1,FALSE)"
            )
        elif state == "revoked":
            c.exec_driver_sql("UPDATE user_external_connector_connections SET status='revoked'")
        elif state == "generation":
            c.exec_driver_sql(
                "UPDATE user_external_connector_connections SET connection_generation=connection_generation+1"
            )
        before = c.exec_driver_sql(
            "SELECT packet_id,revision,updated_at,tagging_pending,tagging_next_at FROM drive_packet_heads ORDER BY packet_id"
        ).all()
    provider_calls = runtime.search.transport.read_tool.await_count
    monkeypatch.setattr(
        runtime.store,
        "live_active",
        lambda *_a, **_k: pytest.fail("management read required OAuth"),
    )
    monkeypatch.setattr(
        runtime.store, "_build", lambda *_a: pytest.fail("management read decrypted build")
    )
    result = await service.list_publications(user_id="owner")
    item = result["packets"][0]
    assert set(item) == {
        "packetId",
        "currentVersion",
        "title",
        "periodStart",
        "periodEnd",
        "timezone",
        "publicSummary",
    }
    assert item["publicSummary"] == {
        "enabled": True,
        "version": 0,
        "revision": 1,
        "disclosure": DISCLOSURE,
    }
    assert item["currentVersion"] == (1 if state == "version" else 0)
    assert (await service.list_publications(user_id="stranger"))["packets"] == []
    with runtime.store.db.engine.connect() as c:
        assert (
            c.exec_driver_sql(
                "SELECT packet_id,revision,updated_at,tagging_pending,tagging_next_at FROM drive_packet_heads ORDER BY packet_id"
            ).all()
            == before
        )
    assert runtime.search.transport.read_tool.await_count == provider_calls
    await publish(service, head, enabled=False, revision=1)
    assert (await service.list_publications(user_id="owner"))["packets"] == []
