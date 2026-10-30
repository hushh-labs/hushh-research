"""Source read contract without a local PostgreSQL server."""

from __future__ import annotations

import asyncio
import json
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy.exc import SQLAlchemyError

from hushh_mcp.services import requester_document_payment_source as source

NOW = datetime(2026, 10, 15, 9, tzinfo=UTC)


def _payment_row(**changes):
    row = {
        "request_id": uuid4(),
        "counterpart_user_id": "payee-private-uid",
        "stripe_mode": "live",
        "status": "paid",
        "amount_cents": 50,
        "currency": "usd",
        "paid_at": NOW,
        "refund_status": None,
        "refund_amount_cents": None,
        "reconciliation_required": False,
        "created_at": NOW,
        "updated_at": NOW,
        "stripe_checkout_session_id": "cs_live_PRIVATE",
        "stripe_payment_intent_id": "pi_PRIVATE",
    }
    row.update(changes)
    return row


class _Result:
    def __init__(self, value):
        self.value = value

    def scalar_one(self):
        return self.value

    def mappings(self):
        return self

    def all(self):
        return self.value


class _Connection:
    def __init__(self, rows):
        self.rows = rows
        self.params = None
        self.statements = []

    def execute(self, statement, params=None):
        sql = str(statement)
        self.statements.append(sql)
        if "transaction_timestamp()" in sql:
            return _Result(NOW)
        if "FROM drive_request_payment_orders" in sql:
            self.params = params
            return _Result(self.rows)
        return _Result(None)


class _Engine:
    def __init__(self, rows):
        self.connection = _Connection(rows)

    @contextmanager
    def begin(self):
        yield self.connection


def _snapshot(rows, owner="payer-owner"):
    engine = _Engine(rows)
    service = source.RequesterDocumentPaymentSourceService(SimpleNamespace(engine=engine))
    result = asyncio.run(service.snapshot(user_id=owner))
    return result, engine.connection


@pytest.mark.parametrize("offset_minutes", [0, -420, 330])
def test_owner_scoped_bounded_consistent_read_and_allowlisted_output(offset_minutes):
    observed = NOW.astimezone(timezone(timedelta(minutes=offset_minutes)))
    row = _payment_row(paid_at=observed, created_at=observed, updated_at=observed)
    snapshot, connection = _snapshot([row])
    assert connection.params == {"owner": "payer-owner", "maximum": 5001}
    assert "REPEATABLE READ, READ ONLY" in connection.statements[0]
    assert "WHERE o.requester_user_id=:owner" in connection.statements[-1]
    assert snapshot["sourceReadVerified"] is True
    assert snapshot["asOf"] == NOW.isoformat()
    item = snapshot["items"][0]
    assert item["requestId"] == str(row["request_id"])
    assert item["amountCents"] == 50
    assert {item[key] for key in ("paidAt", "createdAt", "updatedAt")} == {NOW.isoformat()}
    assert item["counterpartRef"].startswith("sub_")
    assert "payee-private-uid" not in json.dumps(snapshot)
    assert "cs_live_PRIVATE" not in json.dumps(snapshot)
    assert "pi_PRIVATE" not in json.dumps(snapshot)
    other, _ = _snapshot([row], owner="other-owner")
    assert item["counterpartRef"] != other["items"][0]["counterpartRef"]


def test_instants_are_utc_whatever_the_database_session_time_zone():
    # A database session in another zone (a developer machine's local zone)
    # returns the same instants with its own offset. The snapshot is the same.
    india = timezone(timedelta(hours=5, minutes=30))
    local = datetime(2026, 10, 15, 14, 30, tzinfo=india)
    snapshot, _ = _snapshot([_payment_row(paid_at=local, created_at=local, updated_at=local)])
    item = snapshot["items"][0]
    assert {item[key] for key in ("paidAt", "createdAt", "updatedAt")} == {NOW.isoformat()}
    assert NOW.isoformat() == "2026-10-15T09:00:00+00:00"


@pytest.mark.parametrize(
    "invalid",
    [
        {"stripe_mode": "unknown"},
        {"status": "sent"},
        {"amount_cents": 49},
        {"amount_cents": True},
        {"currency": "eur"},
        {"paid_at": None},
        {"request_id": "not-a-uuid"},
        {"counterpart_user_id": None},
        {"created_at": None},
        {"refund_status": None, "refund_amount_cents": 50},
    ],
)
def test_malformed_row_never_becomes_a_verified_snapshot(invalid):
    with pytest.raises(source.RequesterDocumentPaymentSourceUnavailable):
        _snapshot([_payment_row(**invalid)])


def test_overflow_or_duplicate_join_rows_never_become_a_partial_snapshot(monkeypatch):
    monkeypatch.setattr(source, "MAX_SOURCE_PAYMENTS", 1)
    with pytest.raises(source.RequesterDocumentPaymentSourceCapacity):
        _snapshot([_payment_row(), _payment_row()])
    monkeypatch.setattr(source, "MAX_SOURCE_PAYMENTS", 5000)
    repeated = _payment_row()
    with pytest.raises(source.RequesterDocumentPaymentSourceUnavailable):
        _snapshot([repeated, repeated])


def test_database_failure_never_becomes_a_verified_snapshot():
    class BrokenEngine:
        @contextmanager
        def begin(self):
            raise SQLAlchemyError("provider-private")
            yield

    service = source.RequesterDocumentPaymentSourceService(SimpleNamespace(engine=BrokenEngine()))
    with pytest.raises(source.RequesterDocumentPaymentSourceUnavailable) as error:
        asyncio.run(service.snapshot(user_id="payer-owner"))
    assert "provider-private" not in str(error.value)
