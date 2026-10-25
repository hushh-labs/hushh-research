"""An exact undated catalog packet still requires Allow and one frozen payment."""

# ruff: noqa: F401,F811 -- real PostgreSQL fixture graph, mocked external boundaries
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services.drive_request_package_service import DriveRequestPackageService
from hushh_mcp.services.drive_request_package_store import DriveRequestPackageStore
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from tests.services.drive_packet_purchase_test_support import (
    _assert_packet_purchase_fenced,
    _withdraw_before_dispatch,
)
from tests.services.test_drive_request_bulk_postgres import request_bulk
from tests.services.test_drive_request_index_reuse_postgres import (
    catalog,
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    flow,
    ingestion,
    lifecycle,
    recipient,
    reusable,
    sharing,
)
from tests.services.test_drive_request_payment import _checkout_sdk_response
from tests.services.test_drive_sharing_store import request

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


@pytest.mark.parametrize(
    "listing_change",
    [
        None,
        "price",
        "disable",
        "retire",
        "disable_open",
        "disable_paid",
        "disable_unknown",
        "supersede",
    ],
)
async def test_undated_catalog_allow_freeze_and_checkout_is_idempotent(
    catalog, request_bulk, reusable, sharing, monkeypatch, listing_change
):
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    clear_runtime_settings_caches()
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_payment_service.wake_drive_work", AsyncMock()
    )
    # External source validation has dedicated provider tests; no Google writes here.
    monkeypatch.setattr(DriveTrustedAutoService, "preflight_package", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "hushh_mcp.services.drive_package_access_preflight.DrivePackageAccessPreflight.inspect",
        AsyncMock(return_value=SimpleNamespace(status="none")),
    )
    created, found, _, _, _ = await flow(catalog, reusable, sharing)
    request_id = created["requestId"]
    store = DriveRequestPackageStore(db=sharing.db, sharing=sharing)
    service = DriveRequestPackageService(
        store=store, facts=reusable.facts, packets=reusable.packets, wake=AsyncMock()
    )
    assert await service.run_one(user_id="owner", job_id=found["jobId"]) == "queued"
    assert await service.run_one(user_id="owner", job_id=found["jobId"]) == "ready"
    package = await store.package_review(user_id="owner", request_id=request_id)
    with sharing.db.engine.connect() as connection:
        row = (
            connection.execute(
                text("SELECT * FROM drive_share_requests WHERE request_id=:id"), {"id": request_id}
            )
            .mappings()
            .one()
        )
        private = sharing._open_request(row)
        assert not private["purpose"].get("periodStart") and not private["purpose"].get("periodEnd")
        assert private["reusable_packet"]["manifestDigest"]
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
    assert "packageDisclosure" not in await sharing.requester_context(
        user_id="recipient", request_id=request_id
    )
    await sharing.allow_request(
        user_id="owner",
        request_id=request_id,
        revision=row["revision"],
        amount_cents=125,
        package_revision=package["revision"],
        package_digest=package["digest"],
    )
    buyer_context = await sharing.requester_context(user_id="recipient", request_id=request_id)
    disclosure = buyer_context["packageDisclosure"]
    assert buyer_context["requestRevision"] == row["revision"]
    assert disclosure["packageDigest"] == package["digest"]
    assert disclosure["selectedCount"] == 1 and disclosure["periods"] == []
    for viewer in ["owner", "other"]:
        with pytest.raises(DriveSharingError, match="request_unavailable"):
            await sharing.requester_context(user_id=viewer, request_id=request_id)
    if listing_change in {"price", "disable"}:
        from hushh_mcp.services.drive_packet_store import LISTING_DISCLOSURE

        packet = catalog[1]
        await reusable.packets.set_listing(
            user_id="owner",
            packet_id=packet["packetId"],
            version=1,
            decision="allow" if listing_change == "price" else "deny",
            price_cents=250,
            expected_revision=1,
            disclosure=LISTING_DISCLOSURE,
        )
    context = await sharing.request_bulk_context(user_id="owner", request_id=request_id)
    await DriveTrustedAutoService(sharing=sharing)._undated_packet_current(
        user_id="owner", context=context
    )
    if listing_change == "disable":
        _assert_packet_purchase_fenced(sharing, request_id)
        return
    frozen = await request_bulk.create_review(
        user_id="owner",
        search_job_id=found["jobId"],
        client_request_id=str(uuid4()),
        origin_request_id=request_id,
        recipients=[
            {
                "userId": "recipient",
                "email": "b@example.invalid",
                "subject": "1234567",
                "kind": "google_provider",
            }
        ],
        excluded=[],
        selected_positions=[1],
    )
    create = Mock(side_effect=lambda **kw: _checkout_sdk_response(kw, "cs_test_undated_packet"))
    payment = DriveRequestPaymentService(
        db=sharing.db,
        stripe_api=SimpleNamespace(
            checkout=SimpleNamespace(Session=SimpleNamespace(create=create))
        ),
    )
    for _ in range(2):
        result = await payment.ensure_payment_for_frozen_batch(
            "owner", request_id, frozen["shareId"]
        )
        assert result["status"] == "awaiting_payment"
    state = await payment.get_payment(requester_user_id="recipient", request_id=request_id)
    assert state["packageDisclosureRequired"] is True and state["packageDisclosure"] == disclosure
    # A removed/malformed sealed disclosure cannot create or reveal checkout.
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", request_id)
        original = sharing._open_request(row)
        changed = {
            **original,
            "owner_allowed": {**original["owner_allowed"], "buyer_disclosure": None},
        }
        envelope = sharing.sharing_cipher.seal(
            changed, user_id="owner", resource_id=request_id, purpose="request"
        )
        connection.execute(
            text(
                "UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb) WHERE request_id=:id"
            ),
            {"id": request_id, "envelope": json.dumps(envelope)},
        )
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await payment.checkout(requester_user_id="recipient", request_id=request_id)
    create.assert_not_called()
    with sharing.db.engine.begin() as connection:
        envelope = sharing.sharing_cipher.seal(
            original, user_id="owner", resource_id=request_id, purpose="request"
        )
        connection.execute(
            text(
                "UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb) WHERE request_id=:id"
            ),
            {"id": request_id, "envelope": json.dumps(envelope)},
        )
    first = await payment.checkout(requester_user_id="recipient", request_id=request_id)
    assert await payment.checkout(requester_user_id="recipient", request_id=request_id) == first
    create.assert_called_once()
    assert create.call_args.kwargs["line_items"][0]["price_data"]["unit_amount"] == 125
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 1
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_files")).scalar_one()
            == 1
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
    if listing_change == "retire":
        from hushh_mcp.services.drive_packet_contract import DocumentFacts

        with sharing.db.engine.begin() as connection:
            purchase_before = (
                connection.execute(text("SELECT * FROM drive_request_payment_orders"))
                .mappings()
                .one()
            )
            request_before = connection.execute(
                text(
                    "SELECT request_envelope,reusable_packet_id,reusable_packet_version FROM drive_share_requests"
                )
            ).one()
            version_before = connection.execute(
                text("SELECT manifest_envelope,digest FROM drive_packet_versions")
            ).one()
            facts_row = (
                connection.execute(text("SELECT * FROM drive_document_facts")).mappings().one()
            )
            reusable.packets._authority(connection, user_id="owner")
            facts = DocumentFacts.model_validate(reusable.facts.facts(dict(facts_row)))
            facts.canonical_packets = []
            reusable.packets.update_membership_locked(connection, facts_row, facts)
            assert (
                connection.execute(text("SELECT * FROM drive_request_payment_orders"))
                .mappings()
                .one()
                == purchase_before
            )
            assert (
                connection.execute(
                    text(
                        "SELECT request_envelope,reusable_packet_id,reusable_packet_version FROM drive_share_requests"
                    )
                ).one()
                == request_before
            )
            assert (
                request_before.reusable_packet_id is not None
                and request_before.reusable_packet_version == 1
            )
            assert (
                connection.execute(
                    text("SELECT manifest_envelope,digest FROM drive_packet_versions")
                ).one()
                == version_before
            )
            assert (
                connection.execute(
                    text("SELECT count(*) FROM drive_packet_version_sources")
                ).scalar_one()
                == 1
            )
        assert (await reusable.packets.list_packets(user_id="owner"))["packets"] == []
        assert (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
            "packets"
        ] == []
        assert await reusable.worker.run_packet_one(user_id="owner") == "idle"
    if listing_change in {"disable_open", "disable_paid", "disable_unknown", "supersede"}:
        await _withdraw_before_dispatch(
            sharing, reusable, catalog[1], payment, frozen, request_id, listing_change
        )


@pytest.mark.parametrize("money", ["none", "unreserved", "attempt", "session", "paid"])
async def test_existing_access_can_void_only_unreserved_money(request_bulk, sharing, money):
    created = await request(sharing)
    identity = {"request": created["requestId"]}
    if money != "none":
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id) VALUES('test',:request,'owner','recipient')"""),
                identity,
            )
            connection.execute(
                text("""INSERT INTO drive_request_owner_payouts(request_id,gross_amount_cents)
              VALUES(:request,1000)"""),
                identity,
            )
            if money == "attempt":
                connection.execute(
                    text(
                        "UPDATE drive_request_payment_orders SET checkout_attempt_id=:attempt WHERE request_id=:request"
                    ),
                    {**identity, "attempt": str(uuid4())},
                )
            elif money == "session":
                connection.execute(
                    text(
                        "UPDATE drive_request_payment_orders SET status='checkout_open',stripe_checkout_session_id='cs_test_existing' WHERE request_id=:request"
                    ),
                    identity,
                )
            elif money == "paid":
                connection.execute(
                    text(
                        "UPDATE drive_request_payment_orders SET status='paid',paid_at=clock_timestamp() WHERE request_id=:request"
                    ),
                    identity,
                )

    def complete_money():
        with sharing.db.engine.begin() as connection:
            row = sharing._request(connection, "owner", created["requestId"])
            DriveRequestPaymentStore.settle_existing_access_nocharge_locked(connection, row)

    if money in {"attempt", "session", "paid"}:
        with pytest.raises(DriveSharingError, match="payment_not_ready"):
            complete_money()
    else:
        complete_money()
    with sharing.db.engine.connect() as connection:
        order = (
            connection.execute(
                text(
                    "SELECT status,paid_at FROM drive_request_payment_orders WHERE request_id=:request"
                ),
                identity,
            )
            .mappings()
            .first()
        )
        if money == "none":
            assert order is None
        elif money == "unreserved":
            assert order["status"] == "expired" and order["paid_at"] is None
            assert (
                connection.execute(
                    text(
                        "SELECT status FROM drive_request_owner_payouts WHERE request_id=:request"
                    ),
                    identity,
                ).scalar_one()
                == "void"
            )
        else:
            assert (
                order["status"]
                == {"attempt": "awaiting_payment", "session": "checkout_open", "paid": "paid"}[
                    money
                ]
            )


@pytest.mark.parametrize(
    "access_status,error",
    [
        ("all_existing", "request_already_accessible"),
        ("mixed", "package_existing_access_requires_review"),
        ("unknown", "payment_not_ready"),
    ],
)
async def test_access_preflight_stops_before_any_checkout_reservation(
    monkeypatch, access_status, error
):
    from hushh_mcp.services import drive_package_access_preflight as access_module
    from hushh_mcp.services import drive_package_existing_access_store as completion_module
    from hushh_mcp.services import drive_request_payment_service as payment_module
    from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore

    request_id = str(uuid4())
    verdict = SimpleNamespace(status=access_status)
    inspect_access = AsyncMock(return_value=verdict)
    complete = AsyncMock()
    monkeypatch.setattr(
        payment_module, "_config", lambda: ("synthetic", "synthetic", "https://example.invalid")
    )
    monkeypatch.setattr(
        access_module,
        "DrivePackageAccessPreflight",
        lambda **kw: SimpleNamespace(inspect=inspect_access),
    )
    monkeypatch.setattr(
        completion_module,
        "DrivePackageExistingAccessStore",
        lambda **kw: SimpleNamespace(complete=complete),
    )
    frozen_sources = AsyncMock(return_value=[{"id": "source"}])
    monkeypatch.setattr(DriveBulkShareStore, "package_sources", frozen_sources)
    payment = DriveRequestPaymentService(db=object(), stripe_api=Mock())
    payment.payment_state = AsyncMock(
        return_value={"status": "awaiting_payment", "_package_owner_user_id": "owner"}
    )
    payment._transaction = AsyncMock(
        side_effect=AssertionError("Must not reserve Stripe before access result")
    )
    with pytest.raises(DriveSharingError, match=error):
        await payment.checkout(requester_user_id="recipient", request_id=request_id)
    payment._transaction.assert_not_awaited()
    payment.stripe_api.checkout.Session.create.assert_not_called()
    frozen_sources.assert_awaited_once_with(user_id="owner", request_id=request_id)
    if access_status == "all_existing":
        complete.assert_awaited_once_with(user_id="owner", request_id=request_id, result=verdict)
    else:
        complete.assert_not_awaited()


async def test_access_appearing_during_payout_lookup_never_allocates_checkout(monkeypatch):
    from hushh_mcp.services import drive_package_access_preflight as access_module
    from hushh_mcp.services import drive_package_existing_access_store as completion_module
    from hushh_mcp.services import drive_request_payment_service as payment_module
    from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
    from hushh_mcp.services.pkm_payout_service import PkmPayoutService

    monkeypatch.setattr(
        payment_module, "_config", lambda: ("synthetic", "synthetic", "https://example.invalid")
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_owner_payout_service.payout_enabled", lambda: True
    )
    calls = []
    verdict = SimpleNamespace(status="all_existing")

    async def refresh(*, user_id):
        calls.append("payout")
        return {"stripe_account_id": "acct_synthetic", "readiness": {"ready": True}}

    async def inspect(**kwargs):
        assert calls == ["payout"]
        calls.append("access")
        return verdict

    monkeypatch.setattr(PkmPayoutService, "refresh_account", staticmethod(refresh))
    monkeypatch.setattr(
        access_module,
        "DrivePackageAccessPreflight",
        lambda **kw: SimpleNamespace(inspect=inspect),
    )
    complete = AsyncMock()
    monkeypatch.setattr(
        completion_module,
        "DrivePackageExistingAccessStore",
        lambda **kw: SimpleNamespace(complete=complete),
    )
    frozen_sources = AsyncMock(return_value=[{"id": "source"}])
    monkeypatch.setattr(DriveBulkShareStore, "package_sources", frozen_sources)
    payment = DriveRequestPaymentService(db=object(), stripe_api=Mock())
    payment.payment_state = AsyncMock(
        return_value={
            "status": "awaiting_payment",
            "_package_owner_user_id": "owner",
            "_payout_enrolled": True,
            "_payout_owner_user_id": "owner",
        }
    )
    payment._transaction = AsyncMock(
        side_effect=AssertionError("Access must settle before an attempt exists")
    )
    request_id = str(uuid4())
    with pytest.raises(DriveSharingError, match="request_already_accessible"):
        await payment.checkout(requester_user_id="recipient", request_id=request_id)
    assert calls == ["payout", "access"]
    frozen_sources.assert_awaited_once_with(user_id="owner", request_id=request_id)
    complete.assert_awaited_once_with(user_id="owner", request_id=request_id, result=verdict)
    payment._transaction.assert_not_awaited()
    payment.stripe_api.checkout.Session.create.assert_not_called()
