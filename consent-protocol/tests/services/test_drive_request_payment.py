"""Payment settlement survives request erasure without account information."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

import asyncio
import hashlib
import hmac
import inspect
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
import stripe
from sqlalchemy import text

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_permission_store import DrivePermissionStore
from hushh_mcp.services.drive_request_payment_refunds import (
    _REFUND_CANDIDATES_SQL,
    _claim_refunds,
    _finish_refund,
    _provider_refund,
)
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService, _config
from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
from tests.services.test_drive_sharing_store import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    request,
    sharing,
)


@pytest.fixture(autouse=True)
def fresh_payment_runtime_settings():
    clear_runtime_settings_caches()
    yield
    clear_runtime_settings_caches()


def _signed_event(
    request_id: str,
    *,
    amount: int = 1000,
    session_id: str = "cs_test_bound",
    attempt_id: str | None = None,
):
    payer_ref = hashlib.sha256(f"{request_id}:recipient".encode()).hexdigest()
    metadata = {"payment_kind": "drive_request", "request_id": request_id, "payer_ref": payer_ref}
    if attempt_id is not None:
        metadata["checkout_attempt_id"] = attempt_id
    body = json.dumps(
        {
            "id": "evt_test_" + uuid4().hex,
            "object": "event",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": session_id,
                    "object": "checkout.session",
                    "client_reference_id": request_id,
                    "metadata": metadata,
                    "mode": "payment",
                    "payment_status": "paid",
                    "amount_total": amount,
                    "currency": "usd",
                    "livemode": False,
                    "payment_intent": "pi_test_bound",
                }
            },
        }
    ).encode()
    timestamp = int(time.time())
    signature = hmac.new(
        b"whsec_payment_test_secret", f"{timestamp}.".encode() + body, hashlib.sha256
    ).hexdigest()
    return body, f"t={timestamp},v1={signature}"


def test_live_stripe_key_is_rejected_outside_production(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_should_not_be_used")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    with pytest.raises(DriveSharingError, match="payment_unavailable"):
        _config()


def _checkout_fixture(monkeypatch, provider_create):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    request_id, attempt_id = str(uuid4()), str(uuid4())
    order = {
        "status": "awaiting_payment",
        "request_status": "pending",
        "request_expires_at": datetime.now(UTC) + timedelta(hours=1),
        "checkout_attempt_id": attempt_id,
        "stripe_checkout_url": None,
        "stripe_checkout_session_id": None,
    }
    service = DriveRequestPaymentService(
        db=object(),
        stripe_api=SimpleNamespace(
            checkout=SimpleNamespace(Session=SimpleNamespace(create=provider_create))
        ),
    )
    service.payment_state = AsyncMock(return_value={"status": "awaiting_payment"})
    service._current_checkout_authority = Mock()
    service._row = Mock(side_effect=lambda *args, **kwargs: order.copy())
    connection = SimpleNamespace(execute=Mock())

    async def transact(operation):
        return operation(connection)

    service._transaction = transact
    return service, request_id, attempt_id, connection


def _checkout_sdk_response(params, session_id="cs_test_checkout_regression"):
    return stripe.checkout.Session.construct_from(
        {
            "id": session_id,
            "object": "checkout.session",
            "mode": params["mode"],
            "client_reference_id": params["client_reference_id"],
            "amount_total": 1000,
            "currency": "usd",
            "livemode": False,
            "metadata": params["metadata"],
            "url": f"https://checkout.stripe.com/c/pay/{session_id}",
            "expires_at": int(time.time()) + 1800,
        },
        params["api_key"],
    )


@pytest.mark.asyncio
async def test_checkout_uses_supported_stripe_parameters_and_binds_sdk_session(monkeypatch):
    def create_session(**params):
        # UAT Stripe rejected this legacy argument before opening Checkout.
        if "payment_method_types" in params:
            raise stripe.InvalidRequestError(
                "payment_method_types is no longer supported",
                "payment_method_types",
                http_status=400,
            )
        assert params["mode"] == "payment"
        assert params["line_items"] == [
            {
                "price_data": {
                    "currency": "usd",
                    "unit_amount": 1000,
                    "product_data": {"name": "Document request"},
                },
                "quantity": 1,
            }
        ]
        assert params["idempotency_key"] == f"drive-request-{request_id}-{attempt_id}"
        assert params["payment_intent_data"]["metadata"] == params["metadata"]
        return _checkout_sdk_response(params)

    create = Mock(side_effect=create_session)
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    result = await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert result == {
        "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_checkout_regression"
    }
    create.assert_called_once()
    assert service._current_checkout_authority.call_count == 2
    binding = connection.execute.call_args.args[1]
    assert binding["request"] == request_id
    assert binding["session"] == "cs_test_checkout_regression"
    assert binding["url"] == result["checkoutUrl"]


@pytest.mark.asyncio
async def test_checkout_recovers_rejected_legacy_attempt_with_stable_retry_key(monkeypatch):
    def create_session(**params):
        if params["idempotency_key"] == original_key:
            if params.get("payment_method_types") == ["card"]:
                raise stripe.InvalidRequestError(
                    "payment_method_types is no longer supported",
                    "payment_method_types",
                    http_status=400,
                )
            raise stripe.IdempotencyError("Different parameters", http_status=400)
        assert params["idempotency_key"] == original_key + "-dynamic-methods-v1"
        assert "payment_method_types" not in params
        return _checkout_sdk_response(params)

    create = Mock(side_effect=create_session)
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    original_key = f"drive-request-{request_id}-{attempt_id}"
    # The provider succeeds, but the database bind is interrupted. Retrying the
    # same order must replay the same fallback key instead of opening a new order.
    connection.execute.side_effect = [None, RuntimeError("bind interrupted"), None, None]
    with pytest.raises(RuntimeError, match="bind interrupted"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    result = await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert result["checkoutUrl"].endswith("cs_test_checkout_regression")
    calls = [call.kwargs for call in create.call_args_list]
    assert [call["idempotency_key"] for call in calls] == [
        original_key,
        original_key,
        original_key + "-dynamic-methods-v1",
        original_key,
        original_key,
        original_key + "-dynamic-methods-v1",
    ]
    assert calls[1] == {**calls[0], "payment_method_types": ["card"]}
    assert calls[2] == {**calls[0], "idempotency_key": original_key + "-dynamic-methods-v1"}
    assert calls[:3] == calls[3:]
    assert connection.execute.call_args.args[1]["session"] == "cs_test_checkout_regression"


@pytest.mark.asyncio
async def test_checkout_binds_cached_legacy_success_without_creating_another_session(monkeypatch):
    def create_session(**params):
        if "payment_method_types" not in params:
            raise stripe.IdempotencyError("Different parameters", http_status=400)
        assert params["payment_method_types"] == ["card"]
        return _checkout_sdk_response(params, "cs_test_existing_legacy")

    create = Mock(side_effect=create_session)
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    result = await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert result["checkoutUrl"].endswith("cs_test_existing_legacy")
    assert create.call_count == 2
    assert {call.kwargs["idempotency_key"] for call in create.call_args_list} == {
        f"drive-request-{request_id}-{attempt_id}"
    }
    assert connection.execute.call_args.args[1]["session"] == "cs_test_existing_legacy"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "legacy_error",
    [
        stripe.APIConnectionError("Provider outcome is unknown"),
        stripe.InvalidRequestError("Different parameter rejected", "currency", http_status=400),
        stripe.InvalidRequestError("Provider failed", "payment_method_types", http_status=500),
        stripe.IdempotencyError("Legacy payload mismatch", http_status=400),
    ],
    ids=["network", "other-parameter", "server-error", "legacy-idempotency-conflict"],
)
async def test_checkout_does_not_change_retry_key_for_uncertain_legacy_outcome(
    monkeypatch, legacy_error
):
    create = Mock(
        side_effect=[stripe.IdempotencyError("Different parameters", http_status=400), legacy_error]
    )
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    with pytest.raises(DriveSharingError, match="payment_unavailable"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert create.call_count == 2
    assert {call.kwargs["idempotency_key"] for call in create.call_args_list} == {
        f"drive-request-{request_id}-{attempt_id}"
    }
    # Only reserve happened; no checkout session was bound and no alternate
    # provider key was tried for an outcome that could already have succeeded.
    assert connection.execute.call_count == 1


@pytest.mark.asyncio
async def test_checkout_does_not_replay_or_rotate_an_in_progress_idempotency_key(monkeypatch):
    create = Mock(
        side_effect=stripe.IdempotencyError(
            "Another request is in progress", http_status=409, code="idempotency_key_in_use"
        )
    )
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    with pytest.raises(DriveSharingError, match="payment_unavailable"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    create.assert_called_once()
    assert create.call_args.kwargs["idempotency_key"] == f"drive-request-{request_id}-{attempt_id}"
    assert "payment_method_types" not in create.call_args.kwargs
    assert connection.execute.call_count == 1


def test_paid_grant_guard_blocks_reconciliation_hold():
    connection = SimpleNamespace(execute=Mock())
    connection.execute.return_value.mappings.return_value.first.return_value = {
        "status": "paid",
        "paid_at": object(),
        "reconciliation_required": True,
    }
    request_row = {"payment_required": True, "request_id": str(uuid4())}
    with pytest.raises(DriveSharingError, match="payment_required"):
        DriveRequestPaymentStore.require_paid_if_required(connection, request_row)
    connection.execute.return_value.mappings.return_value.first.return_value[
        "reconciliation_required"
    ] = False
    DriveRequestPaymentStore.require_paid_if_required(connection, request_row)


def test_erasure_locks_connector_share_request_then_order():
    retention = inspect.getsource(erase_drive_account_in_transaction)
    connector = retention.index("FROM user_external_connector_connections")
    share = retention.index("ORDER BY share_id FOR UPDATE")
    request = retention.index(
        "FROM drive_share_requests\n                  WHERE request_id=:request FOR UPDATE"
    )
    order = retention.index(
        "FROM drive_request_payment_orders\n                  WHERE request_id=:request FOR UPDATE"
    )
    assert connector < share < request < order


def test_legacy_grant_and_bulk_claim_follow_erasure_lock_order():
    grant = inspect.getsource(DrivePermissionStore._grant_authority)
    assert grant.index("self._participant_gate") < grant.index("self._management_context")
    assert grant.index("self._management_context") < grant.index("self._related_request")
    assert grant.index("self._related_request") < grant.index("require_paid_if_required")

    claim = inspect.getsource(DriveBulkShareStore.claim)
    assert claim.index("self._owned(") < claim.index(
        "FROM drive_share_requests WHERE request_id=:request FOR UPDATE"
    )
    assert (
        claim.index("FROM drive_share_requests WHERE request_id=:request FOR UPDATE")
        < claim.index("FROM drive_request_payment_orders ")
        < claim.index("FROM drive_bulk_share_effects WHERE share_id=:share")
    )
    assert claim.index("FROM drive_bulk_share_effects WHERE share_id=:share") < claim.index(
        "self._require_paid_for_origin"
    )

    dispatch = inspect.getsource(DriveBulkShareStore.mark_dispatching)
    assert dispatch.index("self._lock(") < dispatch.index("self._owned(")
    assert (
        dispatch.index("self._owned(")
        < dispatch.index("FROM drive_share_requests WHERE request_id=:request FOR UPDATE")
        < dispatch.index("self._effect_current")
    )


def test_payment_identity_writes_lock_graph_before_request_and_order():
    ensure = inspect.getsource(DriveRequestPaymentStore._ensure_ready)
    assert (
        ensure.index("lock_connection_graph_users(")
        < ensure.index("AND user_id=:user FOR UPDATE")
        < ensure.index("INSERT INTO drive_request_payment_orders")
    )

    finish = inspect.getsource(_finish_refund)
    assert (
        finish.index("lock_connection_graph_users(")
        < finish.index("WHERE request_id=:request FOR UPDATE")
        < finish.index("document_share_payment_refunded")
    )

    webhook = inspect.getsource(DriveRequestPaymentService.process_webhook)
    assert (
        webhook.index("lock_connection_graph_users(")
        < webhook.index("SELECT * FROM drive_share_requests WHERE request_id=:request")
        < webhook.index("document_share_payment_confirmed")
    )


def test_bulk_identity_writes_gate_participant_graph_before_row_locks(monkeypatch):
    gate = Mock()
    monkeypatch.setattr(
        "hushh_mcp.services.connection_graph_service.lock_connection_graph_users", gate
    )
    connection = SimpleNamespace(execute=Mock())
    connection.execute.return_value.mappings.return_value.all.return_value = [
        {"user_id": "owner", "recipient_user_id": "recipient"}
    ]
    DriveBulkShareStore._gate_graph_for_share(connection, user_id="owner", share_id=str(uuid4()))
    gate.assert_called_once_with(connection, user_ids=["owner", "recipient"])

    create = inspect.getsource(DriveBulkShareStore.create_review)
    assert (
        create.index("lock_connection_graph_users(")
        < create.index("self._lock(connection")
        < create.index("INSERT INTO drive_bulk_shares")
    )
    for method in (
        DriveBulkShareStore.approve,
        DriveBulkShareStore.retry,
        DriveBulkShareStore.claim,
    ):
        source = inspect.getsource(method)
        assert source.index("self._gate_graph_for_share(") < source.index("self._lock(")
    for method in (
        DriveBulkShareStore.stop,
        DriveBulkShareStore.settle,
        DriveBulkShareStore.release,
    ):
        source = inspect.getsource(method)
        assert source.index("self._gate_graph_for_share(") < source.index("self._owned(")
    refresh = inspect.getsource(DriveBulkShareStore.refresh_request)
    assert refresh.index("self._gate_graph_for_request(") < refresh.index(
        "self._finalize_progressive_request("
    )


@pytest.mark.parametrize(
    "status,expired", [("cancelled", False), ("declined", False), ("pending", True)]
)
def test_closed_request_does_not_requeue_payment_ready(status, expired):
    request_id = str(uuid4())
    participant = {"user_id": "owner", "recipient_user_id": "recipient"}
    request = {
        "request_id": request_id,
        **participant,
        "payment_required": True,
        "status": status,
        "expires_at": datetime.now(UTC) + timedelta(hours=-1 if expired else 1),
    }
    order = {"status": "awaiting_payment"}
    store = DriveRequestPaymentStore(db=object())
    store._row = Mock(side_effect=[participant, request, order])
    store._event = Mock()
    _, found, notified = store._ensure_ready(
        SimpleNamespace(execute=Mock()), user_id="owner", request_id=request_id, share_id=None
    )
    assert found is order and notified is False
    store._event.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "order", [None, {"status": "awaiting_payment", "reconciliation_required": False}]
)
async def test_no_match_request_closes_unpaid_payment_state(order):
    request = {
        "request_id": str(uuid4()),
        "user_id": "owner",
        "recipient_user_id": "recipient",
        "payment_required": True,
        "status": "no_match",
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
    }
    store = DriveRequestPaymentStore(db=object())
    store._row = Mock(return_value=request)
    store._ensure_ready = Mock(return_value=(request, order, False))

    async def transaction(operation):
        return operation(SimpleNamespace())

    store._transaction = transaction
    state = await store.payment_state(
        requester_user_id="recipient", request_id=request["request_id"]
    )
    assert state["status"] == "expired"
    store._ensure_ready.assert_called_once()


def _make_legacy_undated_paid_request(sharing, connection, request_id):
    row = (
        connection.execute(
            text("SELECT * FROM drive_share_requests WHERE request_id=:request"),
            {"request": request_id},
        )
        .mappings()
        .one()
    )
    private = sharing._open_request(row)
    private["purpose"]["periodStart"] = None
    private["purpose"]["periodEnd"] = None
    envelope = sharing.sharing_cipher.seal(
        private, user_id="owner", resource_id=request_id, purpose="request"
    )
    connection.execute(
        text("""UPDATE drive_share_requests
      SET payment_required=TRUE,request_envelope=CAST(:envelope AS jsonb)
      WHERE request_id=:request"""),
        {"request": request_id, "envelope": json.dumps(envelope)},
    )


@pytest.mark.asyncio
async def test_legacy_undated_request_cannot_prepare_a_payment_order(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        _make_legacy_undated_paid_request(sharing, connection, request_id)
        with pytest.raises(DriveSharingError, match="date_range_required"):
            DriveRequestPaymentStore(db=sharing.db)._ensure_ready(
                connection, user_id="owner", request_id=request_id, share_id=None
            )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )


@pytest.mark.asyncio
async def test_legacy_undated_order_cannot_start_checkout(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        _make_legacy_undated_paid_request(sharing, connection, request_id)
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,requester_user_id,status)
          VALUES (:request,'owner','recipient','awaiting_payment')"""),
            {"request": request_id},
        )
    stripe_api = Mock()
    service = DriveRequestPaymentService(db=sharing.db, stripe_api=stripe_api)
    with pytest.raises(DriveSharingError, match="date_range_required"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    stripe_api.checkout.Session.create.assert_not_called()


@pytest.mark.asyncio
async def test_paid_undated_request_stays_visible_and_enters_refund_reconciliation(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        _make_legacy_undated_paid_request(sharing, connection, request_id)
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,requester_user_id,status,stripe_payment_intent_id,paid_at)
          VALUES (:request,'owner','recipient','paid','pi_test_undated',clock_timestamp())"""),
            {"request": request_id},
        )
    service = DriveRequestPaymentService(db=sharing.db)
    state = await service.payment_state(requester_user_id="recipient", request_id=request_id)
    assert state["status"] == "paid"
    assert state["reconciliationRequired"] is True
    with sharing.db.engine.begin() as connection:
        claims = _claim_refunds(service, connection, limit=1)
    assert len(claims) == 1
    assert claims[0]["payment_intent"] == "pi_test_undated"


def test_queued_unposted_grants_do_not_block_terminal_refund_candidate():
    assert "'queued'" not in _REFUND_CANDIDATES_SQL.split("AND NOT EXISTS", 1)[1]
    claim = inspect.getsource(_claim_refunds)
    effects_check = claim[
        claim.index("# Queued grants have not reached") : claim.index(
            "UPDATE drive_request_payment_obligations"
        )
    ]
    assert "'queued'" not in effects_check
    assert "'dispatching'" in effects_check and "'unknown'" in effects_check


def test_payment_migration_replay_guards_existing_triggers_and_event_constraint():
    migration = (
        Path(__file__).resolve().parents[2] / "db/migrations/262_drive_request_payments.sql"
    ).read_text()
    for trigger, table in (
        ("drive_request_payment_obligation_mirror", "drive_request_payment_orders"),
        ("drive_request_payment_erasure", "drive_share_requests"),
    ):
        guard = f"tgname='{trigger}'\n      AND tgrelid='{table}'::regclass"
        assert guard in migration
        assert migration.index(guard) < migration.index(f"CREATE TRIGGER {trigger}")
    assert "SELECT ARRAY(SELECT DISTINCT hit[1] FROM regexp_matches(" in migration
    assert "IF installed IS DISTINCT FROM ARRAY[" in migration
    assert migration.index("IF installed IS DISTINCT FROM ARRAY[") < migration.index(
        "ALTER TABLE drive_share_events DROP CONSTRAINT"
    )


@pytest.mark.asyncio
async def test_webhook_rejects_invalid_raw_body_signature_before_database(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    payload, signature = _signed_event(str(uuid4()))
    with pytest.raises(DriveSharingError, match="payment_invalid_signature"):
        await DriveRequestPaymentService(db=object()).process_webhook(
            payload=payload + b" ", signature=signature
        )


@pytest.mark.asyncio
async def test_unrelated_signed_checkout_event_is_acknowledged_without_database(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    payload, _ = _signed_event(str(uuid4()))
    document = json.loads(payload)
    document["data"]["object"]["metadata"] = {"payment_kind": "other_product"}
    payload = json.dumps(document).encode()
    timestamp = int(time.time())
    signature = hmac.new(
        b"whsec_payment_test_secret", f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    await DriveRequestPaymentService(db=object()).process_webhook(
        payload=payload, signature=f"t={timestamp},v1={signature}"
    )


@pytest.mark.asyncio
async def test_erased_webhook_requires_reserved_attempt_and_queues_refund(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    request_id, attempt_id = str(uuid4()), str(uuid4())
    payer_ref = hashlib.sha256(f"{request_id}:recipient".encode()).hexdigest()
    obligation = {
        "erased_at": datetime.now(UTC),
        "checkout_attempt_id": attempt_id,
        "stripe_checkout_session_id": None,
        "stripe_payment_intent_id": None,
        "payer_ref": payer_ref,
        "amount_cents": 1000,
        "currency": "usd",
        "status": "checkout_open",
    }
    stripe_api = SimpleNamespace(
        Webhook=SimpleNamespace(
            construct_event=lambda payload, signature, secret: json.loads(payload)
        )
    )
    service = DriveRequestPaymentService(db=object(), stripe_api=stripe_api)
    connection = SimpleNamespace(execute=Mock())

    async def transact(operation):
        return operation(connection)

    service._transaction = transact
    wake = Mock()

    async def wake_sharing(stage):
        wake(stage)

    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_payment_service.wake_drive_work", wake_sharing
    )
    service._row = Mock(side_effect=[None, None, None, obligation])
    wrong, signature = _signed_event(request_id, attempt_id=str(uuid4()))
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await service.process_webhook(payload=wrong, signature=signature)
    connection.execute.assert_not_called()

    service._row.side_effect = [None, None, None, obligation]
    payload, signature = _signed_event(request_id, attempt_id=attempt_id)
    await service.process_webhook(payload=payload, signature=signature)
    sql = [str(call.args[0]) for call in connection.execute.call_args_list]
    assert any(
        "UPDATE drive_request_payment_obligations" in statement
        and "reconciliation_required=TRUE" in statement
        for statement in sql
    )
    assert any("INSERT INTO drive_request_payment_webhook_events" in statement for statement in sql)
    wake.assert_called_once_with("sharing")


def test_refund_list_outage_then_same_key_retry_sends_first_create():
    refunds = SimpleNamespace(
        list=Mock(side_effect=[RuntimeError("list unavailable"), {"data": [], "has_more": False}]),
        create=Mock(
            return_value={
                "id": "re_test_once",
                "status": "succeeded",
                "payment_intent": "pi_test_bound",
                "amount": 1000,
                "currency": "usd",
            }
        ),
    )
    service = SimpleNamespace(stripe_api=SimpleNamespace(Refund=refunds))
    claim = {
        "request_id": str(uuid4()),
        "payment_intent": "pi_test_bound",
        "attempt_id": str(uuid4()),
        "refund_id": None,
        "first_dispatch_at": datetime.now(UTC),
        "create_allowed": True,
    }
    with pytest.raises(RuntimeError, match="list unavailable"):
        _provider_refund(service, claim, "sk_test_local_only_synthetic")
    refunds.create.assert_not_called()

    refund, error = _provider_refund(service, claim, "sk_test_local_only_synthetic")
    assert error is None and refund["id"] == "re_test_once"
    kwargs = refunds.create.call_args.kwargs
    assert kwargs["amount"] == 1000 and kwargs["payment_intent"] == "pi_test_bound"
    assert kwargs["metadata"] == {
        "payment_kind": "drive_request",
        "request_id": claim["request_id"],
    }


def test_uncertain_refund_create_retries_same_key_then_stops_after_window():
    created = {
        "id": "re_test_once",
        "status": "succeeded",
        "payment_intent": "pi_test_bound",
        "amount": 1000,
        "currency": "usd",
    }
    refunds = SimpleNamespace(
        list=Mock(return_value={"data": [], "has_more": False}),
        create=Mock(side_effect=[RuntimeError("response lost"), created]),
    )
    service = SimpleNamespace(stripe_api=SimpleNamespace(Refund=refunds))
    claim = {
        "request_id": str(uuid4()),
        "payment_intent": "pi_test_bound",
        "attempt_id": str(uuid4()),
        "refund_id": None,
        "first_dispatch_at": datetime.now(UTC),
        "create_allowed": True,
    }
    with pytest.raises(RuntimeError, match="response lost"):
        _provider_refund(service, claim, "sk_test_local_only_synthetic")
    refund, error = _provider_refund(service, claim, "sk_test_local_only_synthetic")
    assert error is None and refund == created
    assert refunds.create.call_count == 2
    assert (
        refunds.create.call_args_list[0].kwargs["idempotency_key"]
        == refunds.create.call_args_list[1].kwargs["idempotency_key"]
    )

    claim["first_dispatch_at"] = datetime.now(UTC) - timedelta(hours=21)
    refund, error = _provider_refund(service, claim, "sk_test_local_only_synthetic")
    assert refund is None and error == "idempotency_window_elapsed"
    assert refunds.create.call_count == 2

    request = {"request_id": claim["request_id"]}
    order = {"status": "paid"}
    refund_row = {"attempt_id": claim["attempt_id"], "status": "dispatching"}
    participant = {"user_id": "owner", "recipient_user_id": "recipient"}
    finish_service = SimpleNamespace(
        _row=Mock(
            side_effect=[
                participant,
                request,
                {"request_id": claim["request_id"]},
                order,
                refund_row,
            ]
        )
    )
    connection = SimpleNamespace(execute=Mock())
    assert _finish_refund(finish_service, connection, claim, None, error) == "manual_review"
    assert connection.execute.call_args.args[1]["status"] == "manual_review"

    claim["create_allowed"] = False
    refunds.list.return_value = {"data": [created], "has_more": False}
    refund, error = _provider_refund(service, claim, "sk_test_local_only_synthetic")
    assert error is None and refund == created
    assert refunds.create.call_count == 2


@pytest.mark.asyncio
async def test_refund_first_dispatch_timestamp_survives_uncertain_retry(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests
          SET payment_required=TRUE,status='expired'
          WHERE request_id=:request"""),
            {"request": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,requester_user_id,status,stripe_payment_intent_id,paid_at)
          VALUES (:request,'owner','recipient','paid','pi_test_refund',clock_timestamp())"""),
            {"request": request_id},
        )
        first = _claim_refunds(DriveRequestPaymentService(db=sharing.db), connection, limit=1)
    assert len(first) == 1 and first[0]["create_allowed"] is True
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_refunds
          SET status='unknown',lease_expires_at=NULL,
              next_check_at=clock_timestamp()-interval '1 second'
          WHERE request_id=:request"""),
            {"request": request_id},
        )
        second = _claim_refunds(DriveRequestPaymentService(db=sharing.db), connection, limit=1)
    assert len(second) == 1
    assert second[0]["first_dispatch_at"] == first[0]["first_dispatch_at"]
    assert second[0]["attempt_id"] == first[0]["attempt_id"]


@pytest.mark.asyncio
async def test_paid_no_match_request_is_immediately_refund_eligible(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests
          SET payment_required=TRUE,status='no_match'
          WHERE request_id=:request"""),
            {"request": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,requester_user_id,status,stripe_payment_intent_id,paid_at)
          VALUES (:request,'owner','recipient','paid','pi_test_no_match',clock_timestamp())"""),
            {"request": request_id},
        )
        claims = _claim_refunds(DriveRequestPaymentService(db=sharing.db), connection, limit=1)
    assert len(claims) == 1
    assert str(claims[0]["request_id"]) == request_id
    assert claims[0]["payment_intent"] == "pi_test_no_match"


def test_confirmed_refund_queues_requester_notice_once():
    claim = {
        "request_id": str(uuid4()),
        "payment_intent": "pi_test_bound",
        "attempt_id": str(uuid4()),
    }
    request = {"request_id": claim["request_id"], "recipient_user_id": "recipient", "revision": 1}
    order = {"status": "paid"}
    refund_row = {"attempt_id": claim["attempt_id"], "status": "dispatching"}
    participant = {"user_id": "owner", "recipient_user_id": "recipient"}
    service = SimpleNamespace(
        _row=Mock(
            side_effect=[
                participant,
                request,
                {"request_id": claim["request_id"]},
                order,
                refund_row,
            ]
        ),
        _event=Mock(),
    )
    connection = SimpleNamespace(execute=Mock())
    refund = {
        "id": "re_test_once",
        "payment_intent": "pi_test_bound",
        "amount": 1000,
        "currency": "usd",
        "status": "succeeded",
    }
    assert _finish_refund(service, connection, claim, refund, None) == "succeeded"
    service._event.assert_called_once_with(connection, request, "document_share_payment_refunded")

    service._row.side_effect = [
        participant,
        request,
        {"request_id": claim["request_id"]},
        {"status": "refunded"},
        {"attempt_id": claim["attempt_id"], "status": "succeeded"},
    ]
    assert _finish_refund(service, connection, claim, refund, None) == "succeeded"
    service._event.assert_called_once()


def test_inflight_refund_finishes_after_request_erasure_without_feed_event():
    claim = {
        "request_id": str(uuid4()),
        "payment_intent": "pi_test_bound",
        "attempt_id": str(uuid4()),
    }
    obligation = {"status": "paid", "erased_at": datetime.now(UTC)}
    refund_row = {"attempt_id": claim["attempt_id"], "status": "dispatching"}
    service = SimpleNamespace(
        _row=Mock(side_effect=[None, None, obligation, refund_row]), _event=Mock()
    )
    connection = SimpleNamespace(execute=Mock())
    refund = {
        "id": "re_test_erased",
        "payment_intent": "pi_test_bound",
        "amount": 1000,
        "currency": "usd",
        "status": "succeeded",
    }

    assert _finish_refund(service, connection, claim, refund, None) == "succeeded"
    service._event.assert_not_called()
    statements = [str(call.args[0]) for call in connection.execute.call_args_list]
    assert any(
        "UPDATE drive_request_payment_obligations" in sql and "status='refunded'" in sql
        for sql in statements
    )


@pytest.mark.asyncio
async def test_signed_webhook_requires_exact_order_binding_and_replays_once(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,requester_user_id,status,stripe_checkout_session_id,
           stripe_checkout_url,stripe_checkout_expires_at)
          VALUES (:id,'owner','recipient','checkout_open','cs_test_bound',
                  'https://checkout.stripe.com/test',clock_timestamp()+interval '1 hour')"""),
            {"id": request_id},
        )
    service = DriveRequestPaymentService(db=sharing.db)

    wrong_amount, signature = _signed_event(request_id, amount=900)
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await service.process_webhook(payload=wrong_amount, signature=signature)
    wrong_session, signature = _signed_event(request_id, session_id="cs_test_other")
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await service.process_webhook(payload=wrong_session, signature=signature)

    payload, signature = _signed_event(request_id)
    await service.process_webhook(payload=payload, signature=signature)
    await service.process_webhook(payload=payload, signature=signature)
    with sharing.db.engine.begin() as connection:
        order = (
            connection.execute(
                text("""SELECT status,paid_at,stripe_checkout_url
          FROM drive_request_payment_orders WHERE request_id=:id"""),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
        events = connection.execute(
            text("""SELECT count(*) FROM drive_request_payment_webhook_events
          WHERE request_id=:id"""),
            {"id": request_id},
        ).scalar_one()
    assert order["status"] == "paid" and order["paid_at"] is not None
    assert order["stripe_checkout_url"] is None
    assert events == 1


@pytest.mark.asyncio
async def test_deleting_request_keeps_opaque_payment_obligation(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,requester_user_id) VALUES (:id,'owner','recipient')"""),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_webhook_events
          (stripe_event_id,stripe_checkout_session_id,request_id)
          VALUES ('evt_test_erasure','cs_test_erasure',:id)"""),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_refunds
          (request_id,attempt_id,status) VALUES (:id,:attempt,'queued')"""),
            {"id": request_id, "attempt": str(uuid4())},
        )
        # The existing request-erasure path removes its generic outbox first.
        connection.execute(
            text("DELETE FROM drive_share_events WHERE request_id=:id"), {"id": request_id}
        )
        connection.execute(
            text("DELETE FROM drive_share_requests WHERE request_id=:id"), {"id": request_id}
        )
        order_count = connection.execute(
            text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:id"),
            {"id": request_id},
        ).scalar_one()
        obligation = (
            connection.execute(
                text("""SELECT status,erased_at,payer_ref,
          reconciliation_required FROM drive_request_payment_obligations
          WHERE request_id=:id"""),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
        event_count = connection.execute(
            text("SELECT count(*) FROM drive_request_payment_webhook_events WHERE request_id=:id"),
            {"id": request_id},
        ).scalar_one()
        refund_count = connection.execute(
            text("SELECT count(*) FROM drive_request_payment_refunds WHERE request_id=:id"),
            {"id": request_id},
        ).scalar_one()
    assert (order_count, event_count, refund_count) == (0, 1, 1)
    assert obligation["erased_at"] is not None
    assert obligation["reconciliation_required"] is True
    assert obligation["payer_ref"] == hashlib.sha256(f"{request_id}:recipient".encode()).hexdigest()


@pytest.mark.asyncio
async def test_late_paid_webhook_after_erasure_uses_reserved_attempt(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    created = await request(sharing)
    request_id = created["requestId"]
    attempt_id = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET payment_required=TRUE
          WHERE request_id=:id"""),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,requester_user_id,checkout_attempt_id)
          VALUES (:id,'owner','recipient',:attempt)"""),
            {"id": request_id, "attempt": attempt_id},
        )
        connection.execute(
            text("DELETE FROM drive_share_events WHERE request_id=:id"), {"id": request_id}
        )
        connection.execute(
            text("DELETE FROM drive_share_requests WHERE request_id=:id"), {"id": request_id}
        )

    service = DriveRequestPaymentService(db=sharing.db)
    wrong, signature = _signed_event(request_id, attempt_id=str(uuid4()))
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await service.process_webhook(payload=wrong, signature=signature)

    payload, signature = _signed_event(request_id, attempt_id=attempt_id)
    await service.process_webhook(payload=payload, signature=signature)
    await service.process_webhook(payload=payload, signature=signature)
    with sharing.db.engine.begin() as connection:
        obligation = (
            connection.execute(
                text("""SELECT status,paid_at,
          stripe_checkout_session_id,stripe_payment_intent_id,
          reconciliation_required FROM drive_request_payment_obligations
          WHERE request_id=:id"""),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
        events = connection.execute(
            text("""SELECT count(*)
          FROM drive_request_payment_webhook_events WHERE request_id=:id"""),
            {"id": request_id},
        ).scalar_one()
        claims = _claim_refunds(service, connection, limit=1)
    assert obligation["status"] == "paid" and obligation["paid_at"] is not None
    assert obligation["stripe_checkout_session_id"] == "cs_test_bound"
    assert obligation["stripe_payment_intent_id"] == "pi_test_bound"
    assert obligation["reconciliation_required"] is True and events == 1
    assert len(claims) == 1 and claims[0]["payment_intent"] == "pi_test_bound"


@pytest.mark.asyncio
async def test_webhook_waits_for_account_erasure_and_reconciles_late_payment(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    created = await request(sharing)
    request_id, attempt_id = created["requestId"], str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:request"),
            {"request": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,status,checkout_attempt_id,
               stripe_checkout_session_id)
              VALUES (:request,'owner','recipient','checkout_open',:attempt,'cs_test_bound')"""),
            {"request": request_id, "attempt": attempt_id},
        )

    service = DriveRequestPaymentService(db=sharing.db)
    erasure_held = threading.Event()
    release_erasure = threading.Event()
    webhook_entered = threading.Event()
    erasure_pid: list[int] = []
    webhook_pid: list[int] = []

    def erase(connection):
        # Hold account erasure's graph gate while the webhook has already read
        # the still-present request; it must wait before writing payment state.
        lock_connection_graph_users(connection, user_ids=["recipient"])
        erasure_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        erasure_held.set()
        assert release_erasure.wait(20), "erasure barrier was not released"
        erase_drive_account_in_transaction(connection, user_id="recipient", permanent=False)

    original_gate = lock_connection_graph_users

    def observe_webhook_gate(connection, *, user_ids):
        webhook_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        webhook_entered.set()
        original_gate(connection, user_ids=user_ids)

    erase_task = asyncio.create_task(service._transaction(erase))
    webhook_task = None
    try:
        assert await asyncio.to_thread(erasure_held.wait, 10)
        monkeypatch.setattr(
            "hushh_mcp.services.connection_graph_service.lock_connection_graph_users",
            observe_webhook_gate,
        )
        payload, signature = _signed_event(request_id, attempt_id=attempt_id)
        webhook_task = asyncio.create_task(
            service.process_webhook(payload=payload, signature=signature)
        )
        assert await asyncio.to_thread(webhook_entered.wait, 10)
        deadline = asyncio.get_running_loop().time() + 5
        while True:
            with sharing.db.engine.connect() as connection:
                blocked = connection.execute(
                    text("SELECT :holder = ANY(pg_blocking_pids(:waiter))"),
                    {"holder": erasure_pid[0], "waiter": webhook_pid[0]},
                ).scalar_one()
            if blocked:
                break
            assert asyncio.get_running_loop().time() < deadline, "webhook did not wait on erasure"
            await asyncio.sleep(0.01)
    finally:
        release_erasure.set()
        outcomes = await asyncio.wait_for(
            asyncio.gather(
                *([erase_task, webhook_task] if webhook_task else [erase_task]),
                return_exceptions=True,
            ),
            30,
        )
    assert outcomes == [None, None]
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_share_requests WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        obligation = (
            connection.execute(
                text("""SELECT status,paid_at,erased_at,reconciliation_required,payer_ref
              FROM drive_request_payment_obligations WHERE request_id=:request"""),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
        events = connection.execute(
            text(
                "SELECT count(*) FROM drive_request_payment_webhook_events WHERE request_id=:request"
            ),
            {"request": request_id},
        ).scalar_one()
        feed_events = connection.execute(
            text("SELECT count(*) FROM drive_share_events WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one()
    assert obligation["status"] == "paid"
    assert obligation["paid_at"] is not None and obligation["erased_at"] is not None
    assert obligation["reconciliation_required"] is True
    assert obligation["payer_ref"] == hashlib.sha256(f"{request_id}:recipient".encode()).hexdigest()
    assert events == 1 and feed_events == 0
