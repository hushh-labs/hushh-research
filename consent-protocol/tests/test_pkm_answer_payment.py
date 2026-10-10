"""Payment binding, replay safety and the delivery gate for paid answers.

Signatures here are real HMACs over the exact body, as Stripe computes them, so
a tampered-body test fails for the reason it would fail in production.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hushh_mcp.services.pkm_answer_payment_service import (
    PAYMENT_KIND,
    AnswerPaymentError,
    PkmAnswerPaymentService,
    valid_answer_price_cents,
)

WEBHOOK_SECRET = b"whsec_payment_test_secret"
REQUEST_ID = "11111111-2222-3333-4444-555555555555"
DIGEST = "a" * 64
ATTEMPT = "99999999-8888-7777-6666-555555555555"


@pytest.fixture(autouse=True)
def stripe_env(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET.decode())
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    from hushh_mcp.runtime_settings import clear_runtime_settings_caches

    clear_runtime_settings_caches()
    yield
    clear_runtime_settings_caches()


def _event(
    *,
    event_id="evt_1",
    event_type="checkout.session.completed",
    payment_kind=PAYMENT_KIND,
    amount=1000,
    livemode=False,
    digest=DIGEST,
    session_id="cs_test_1",
    currency="usd",
) -> bytes:
    return json.dumps(
        {
            "id": event_id,
            "object": "event",
            "type": event_type,
            "data": {
                "object": {
                    "id": session_id,
                    "object": "checkout.session",
                    "client_reference_id": REQUEST_ID,
                    "metadata": {
                        "payment_kind": payment_kind,
                        "request_id": REQUEST_ID,
                        "checkout_attempt_id": ATTEMPT,
                        "terms_digest": digest,
                    },
                    "mode": "payment",
                    "payment_status": "paid",
                    "amount_total": amount,
                    "currency": currency,
                    "livemode": livemode,
                    "payment_intent": "pi_test_1",
                }
            },
        }
    ).encode()


def _signature(body: bytes, *, secret: bytes = WEBHOOK_SECRET) -> str:
    timestamp = int(time.time())
    mac = hmac.new(secret, f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={mac}"


class FakeConnection:
    """Records statements and simulates the ON CONFLICT replay guard."""

    def __init__(self, order: dict | None):
        self.order = order
        self.statements: list[str] = []
        self.seen_events: set[str] = set()

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        self.statements.append(sql)
        params = params or {}
        if sql.startswith("SELECT * FROM pkm_answer_payment_orders"):
            return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: self.order))
        if "INSERT INTO pkm_answer_payment_webhook_events" in sql:
            event_id = params.get("event")
            if event_id in self.seen_events:
                return SimpleNamespace(first=lambda: None)  # replay: already settled
            self.seen_events.add(event_id)
            return SimpleNamespace(first=lambda: (event_id,))
        if sql.startswith("UPDATE pkm_answer_payment_orders SET status = 'paid'"):
            self.order = {**(self.order or {}), "status": "paid"}
        return SimpleNamespace(
            mappings=lambda: SimpleNamespace(first=lambda: None), first=lambda: None
        )

    @property
    def settlements(self) -> int:
        return sum(
            1
            for s in self.statements
            if s.startswith("UPDATE pkm_answer_payment_orders SET status = 'paid'")
        )


def _service(connection: FakeConnection) -> PkmAnswerPaymentService:
    @contextmanager
    def begin():
        yield connection

    db = SimpleNamespace(engine=SimpleNamespace(begin=begin))
    return PkmAnswerPaymentService(db=db)


def _open_order(**overrides) -> dict:
    return {
        "request_id": REQUEST_ID,
        "status": "checkout_open",
        "stripe_checkout_session_id": "cs_test_1",
        "checkout_attempt_id": ATTEMPT,
        "amount_cents": 1000,
        "currency": "usd",
        "terms_digest": DIGEST,
        **overrides,
    }


# ----------------------------------------------------------------- signature


class TestSignature:
    async def test_tampered_body_is_rejected(self):
        body = _event()
        signature = _signature(body)
        tampered = body.replace(b'"amount_total": 1000', b'"amount_total": 100')
        with pytest.raises(AnswerPaymentError, match="payment_invalid_signature"):
            await PkmAnswerPaymentService(db=object()).process_webhook(
                payload=tampered, signature=signature
            )

    async def test_missing_signature_header_is_rejected(self):
        with pytest.raises(AnswerPaymentError, match="payment_invalid_signature"):
            await PkmAnswerPaymentService(db=object()).process_webhook(
                payload=_event(), signature=None
            )

    async def test_signature_from_another_secret_is_rejected(self):
        body = _event()
        with pytest.raises(AnswerPaymentError, match="payment_invalid_signature"):
            await PkmAnswerPaymentService(db=object()).process_webhook(
                payload=body, signature=_signature(body, secret=b"whsec_wrong")
            )


# ------------------------------------------------------------------- binding


class TestBinding:
    async def test_another_lanes_payment_kind_is_ignored_not_settled(self):
        # The dispatcher routes by kind; if one still arrives here it must be a
        # no-op rather than settling an answer order.
        body = _event(payment_kind="drive_request")
        connection = FakeConnection(_open_order())
        await _service(connection).process_webhook(payload=body, signature=_signature(body))
        assert connection.settlements == 0

    async def test_live_mode_event_cannot_settle_a_test_mode_order(self):
        body = _event(livemode=True)
        with pytest.raises(AnswerPaymentError, match="payment_invalid_event"):
            await PkmAnswerPaymentService(db=object()).process_webhook(
                payload=body, signature=_signature(body)
            )

    async def test_amount_must_match_the_locked_order(self):
        body = _event(amount=2000)
        connection = FakeConnection(_open_order(amount_cents=1000))
        with pytest.raises(AnswerPaymentError, match="payment_invalid_event"):
            await _service(connection).process_webhook(payload=body, signature=_signature(body))
        assert connection.settlements == 0

    async def test_terms_digest_must_match_the_approved_terms(self):
        # The owner re-priced or re-scoped after this checkout opened. The old
        # payment must not settle the new terms.
        body = _event(digest="b" * 64)
        connection = FakeConnection(_open_order(terms_digest=DIGEST))
        with pytest.raises(AnswerPaymentError, match="payment_invalid_event"):
            await _service(connection).process_webhook(payload=body, signature=_signature(body))
        assert connection.settlements == 0

    async def test_session_id_must_match_the_locked_order(self):
        body = _event(session_id="cs_test_other")
        connection = FakeConnection(_open_order(stripe_checkout_session_id="cs_test_1"))
        with pytest.raises(AnswerPaymentError, match="payment_invalid_event"):
            await _service(connection).process_webhook(payload=body, signature=_signature(body))
        assert connection.settlements == 0

    async def test_matching_event_settles_once(self):
        body = _event()
        connection = FakeConnection(_open_order())
        await _service(connection).process_webhook(payload=body, signature=_signature(body))
        assert connection.settlements == 1
        # The request only becomes answerable after a verified payment.
        assert any(
            "UPDATE pkm_answer_requests SET status = 'answering'" in s
            for s in connection.statements
        )


# -------------------------------------------------------------------- replay


class TestReplay:
    async def test_duplicate_delivery_of_one_event_settles_once(self):
        body = _event(event_id="evt_replay")
        signature = _signature(body)
        connection = FakeConnection(_open_order())
        service = _service(connection)
        await service.process_webhook(payload=body, signature=signature)
        await service.process_webhook(payload=body, signature=signature)
        assert connection.settlements == 1


# ---------------------------------------------------------------------- gate


class TestDeliveryGate:
    """Nothing is delivered without a verified, current, unreconciled payment."""

    @staticmethod
    def _connection(row):
        connection = SimpleNamespace(execute=Mock())
        connection.execute.return_value.mappings.return_value.first.return_value = row
        return connection

    def test_unpaid_order_blocks_delivery(self):
        connection = self._connection(
            {
                "status": "awaiting_payment",
                "paid_at": None,
                "reconciliation_required": False,
                "terms_digest": DIGEST,
            }
        )
        with pytest.raises(AnswerPaymentError, match="payment_required"):
            PkmAnswerPaymentService.require_paid_answer(
                connection, {"request_id": REQUEST_ID, "terms_digest": DIGEST}
            )

    def test_missing_order_blocks_delivery(self):
        with pytest.raises(AnswerPaymentError, match="payment_required"):
            PkmAnswerPaymentService.require_paid_answer(
                self._connection(None), {"request_id": REQUEST_ID, "terms_digest": DIGEST}
            )

    def test_reconciliation_hold_blocks_delivery_even_when_paid(self):
        connection = self._connection(
            {
                "status": "paid",
                "paid_at": object(),
                "reconciliation_required": True,
                "terms_digest": DIGEST,
            }
        )
        with pytest.raises(AnswerPaymentError, match="payment_required"):
            PkmAnswerPaymentService.require_paid_answer(
                connection, {"request_id": REQUEST_ID, "terms_digest": DIGEST}
            )

    def test_terms_changed_after_payment_blocks_delivery(self):
        # Scope isolation: an answer may only be produced under the exact terms
        # that were paid for.
        connection = self._connection(
            {
                "status": "paid",
                "paid_at": object(),
                "reconciliation_required": False,
                "terms_digest": DIGEST,
            }
        )
        with pytest.raises(AnswerPaymentError, match="terms_changed"):
            PkmAnswerPaymentService.require_paid_answer(
                connection, {"request_id": REQUEST_ID, "terms_digest": "b" * 64}
            )

    def test_paid_current_order_permits_delivery(self):
        # Negative control for the three tests above: with everything correct
        # the gate must NOT raise, so they are proving the gate and not a typo.
        connection = self._connection(
            {
                "status": "paid",
                "paid_at": object(),
                "reconciliation_required": False,
                "terms_digest": DIGEST,
            }
        )
        PkmAnswerPaymentService.require_paid_answer(
            connection, {"request_id": REQUEST_ID, "terms_digest": DIGEST}
        )


# --------------------------------------------------------------------- price


@pytest.mark.parametrize(
    "value,expected",
    [
        (1000, True),
        (100, True),
        (50_000, True),
        (99, False),
        (50_100, False),
        (1050, False),
        (0, False),
        (-100, False),
        (1000.0, False),
        (True, False),
    ],
)
def test_price_bounds_match_the_drive_lane(value, expected):
    assert valid_answer_price_cents(value) is expected
