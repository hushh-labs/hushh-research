"""Real PostgreSQL snapshot, owner isolation, overflow and erasure evidence."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixture

import asyncio
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, text

from hushh_mcp.services import requester_document_payment_source as source_module
from hushh_mcp.services.requester_document_payment_source import (
    RequesterDocumentPaymentSourceCapacity,
    RequesterDocumentPaymentSourceService,
    RequesterDocumentPaymentSourceUnavailable,
)
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)


@pytest.fixture
def payment_db(connector_postgres_url):
    schema = "requester_payment_" + uuid4().hex
    admin = create_engine(connector_postgres_url)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(
        connector_postgres_url,
        # Exact timestamp assertions use UTC, not the workstation's initdb zone.
        connect_args={"options": f"-csearch_path={schema},public -ctimezone=UTC"},
    )
    with engine.begin() as connection:
        connection.exec_driver_sql("""CREATE TABLE drive_request_payment_orders (
          request_id UUID PRIMARY KEY, user_id TEXT NOT NULL, requester_user_id TEXT NOT NULL,
          stripe_mode TEXT NOT NULL, status TEXT NOT NULL, amount_cents INTEGER NOT NULL,
          currency TEXT NOT NULL, paid_at TIMESTAMPTZ,
          reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
          stripe_checkout_session_id TEXT, stripe_checkout_url TEXT,
          stripe_payment_intent_id TEXT)""")
        connection.exec_driver_sql("""CREATE TABLE drive_request_payment_refunds (
          request_id UUID PRIMARY KEY, status TEXT NOT NULL, amount_cents INTEGER,
          stripe_refund_id TEXT)""")
        connection.exec_driver_sql("""CREATE TABLE drive_request_payment_obligations (
          request_id UUID PRIMARY KEY, status TEXT NOT NULL,
          stripe_payment_intent_id TEXT)""")
    try:
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()


def _insert_order(
    engine,
    *,
    requester="buyer-A",
    counterpart="owner-B",
    status="paid",
    mode="test",
    amount=300,
    at=None,
):
    request_id = uuid4()
    at = at or datetime(2026, 10, 15, 9, tzinfo=UTC)
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders (
                  request_id,user_id,requester_user_id,stripe_mode,status,
                  amount_cents,currency,paid_at,reconciliation_required,
                  created_at,updated_at,stripe_checkout_session_id,
                  stripe_checkout_url,stripe_payment_intent_id)
                VALUES (:request,:counterpart,:requester,:mode,:status,
                  :amount,'usd',:paid_at,FALSE,:at,:at,
                  'cs_test_PRIVATE','https://stripe.example/private','pi_PRIVATE')"""),
            {
                "request": request_id,
                "counterpart": counterpart,
                "requester": requester,
                "mode": mode,
                "status": status,
                "amount": amount,
                "paid_at": at if status in {"paid", "refunded"} else None,
                "at": at,
            },
        )
    return request_id


def _snapshot(engine, owner):
    return asyncio.run(
        RequesterDocumentPaymentSourceService(SimpleNamespace(engine=engine)).snapshot(
            user_id=owner
        )
    )


def test_owner_read_is_complete_bounded_and_contains_no_provider_material(payment_db):
    first = _insert_order(payment_db)
    second = _insert_order(
        payment_db,
        status="refunded",
        amount=500,
        at=datetime(2026, 10, 15, 10, tzinfo=UTC),
    )
    _insert_order(payment_db, requester="buyer-C", counterpart="owner-B")
    with payment_db.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_refunds
                  (request_id,status,amount_cents,stripe_refund_id)
                  VALUES (:request,'succeeded',200,'re_PRIVATE')"""),
            {"request": second},
        )
    snapshot = _snapshot(payment_db, "buyer-A")
    assert snapshot["schemaVersion"] == 1
    assert snapshot["ownerUserId"] == "buyer-A"
    assert snapshot["sourceReadVerified"] is True
    assert [row["requestId"] for row in snapshot["items"]] == [str(second), str(first)]
    from hushh_mcp.services.fabric_grant_service import subject_ref

    assert snapshot["items"][0] == {
        "requestId": str(second),
        "counterpartRef": subject_ref(subscriber_id="buyer-A", user_id="owner-B"),
        "mode": "test",
        "status": "refunded",
        "amountCents": 500,
        "currency": "USD",
        "paidAt": "2026-10-15T10:00:00+00:00",
        "refundStatus": "succeeded",
        "refundAmountCents": 200,
        "reconciliationRequired": False,
        "createdAt": "2026-10-15T10:00:00+00:00",
        "updatedAt": "2026-10-15T10:00:00+00:00",
    }
    assert len(_snapshot(payment_db, "buyer-C")["items"]) == 1
    serialized = json.dumps(snapshot)
    for secret in ("cs_test_PRIVATE", "pi_PRIVATE", "re_PRIVATE", "stripe.example", "owner-B"):
        assert secret not in serialized


def test_overflow_and_malformed_rows_fail_without_partial_snapshot(payment_db, monkeypatch):
    _insert_order(payment_db)
    _insert_order(payment_db, at=datetime(2026, 10, 15, 10, tzinfo=UTC))
    monkeypatch.setattr(source_module, "MAX_SOURCE_PAYMENTS", 1)
    with pytest.raises(RequesterDocumentPaymentSourceCapacity):
        _snapshot(payment_db, "buyer-A")
    monkeypatch.setattr(source_module, "MAX_SOURCE_PAYMENTS", 5_000)
    with payment_db.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET stripe_mode='unknown'
                    WHERE requester_user_id='buyer-A'""")
        )
    with pytest.raises(RequesterDocumentPaymentSourceUnavailable):
        _snapshot(payment_db, "buyer-A")


def test_repeatable_read_does_not_mix_a_late_refund_into_an_older_page(payment_db):
    request_id = _insert_order(payment_db)
    changed = False

    def commit_refund(_connection, _cursor, statement, _params, _context, _many):
        nonlocal changed
        if changed or "FROM drive_request_payment_orders o" not in statement:
            return
        changed = True
        with payment_db.begin() as other:
            other.execute(
                text("""UPDATE drive_request_payment_orders
                         SET status='refunded',updated_at=:later
                         WHERE request_id=:request"""),
                {
                    "request": request_id,
                    "later": datetime(2026, 10, 15, 10, tzinfo=UTC),
                },
            )

    event.listen(payment_db, "before_cursor_execute", commit_refund)
    try:
        first = _snapshot(payment_db, "buyer-A")
    finally:
        event.remove(payment_db, "before_cursor_execute", commit_refund)
    assert changed is True
    assert first["items"][0]["status"] == "paid"
    assert _snapshot(payment_db, "buyer-A")["items"][0]["status"] == "refunded"


def test_account_erasure_does_not_read_anonymous_obligations(payment_db):
    request_id = _insert_order(payment_db)
    with payment_db.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_request_payment_obligations
                    (request_id,status,stripe_payment_intent_id)
                    VALUES (:request,'paid','pi_RETAINED')"""),
            {"request": request_id},
        )
        connection.execute(
            text("DELETE FROM drive_request_payment_orders WHERE request_id=:request"),
            {"request": request_id},
        )
    assert _snapshot(payment_db, "buyer-A")["items"] == []
