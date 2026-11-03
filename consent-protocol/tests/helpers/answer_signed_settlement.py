"""Real signed-webhook transport and database readback for answer settlement tests."""

import hashlib
import hmac
import json
import time
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

from api.routes import drive_request_payments as routes
from hushh_mcp.services.pkm_answer_payment_service import AnswerPaymentError

SECRET = b"whsec_payment_test_secret_value"


def signed(body):
    timestamp = int(time.time())
    signature = hmac.new(SECRET, f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return {"Stripe-Signature": f"t={timestamp},v1={signature}"}


def status(engine, request):
    with engine.connect() as c:
        return (
            c.execute(
                text("""SELECT r.status, o.status AS payment_status,
            (SELECT count(*) FROM feed_events WHERE source_row_id='answer_request:'||r.request_id::text
              AND event_type='answer_delivered') AS milestones,
            (SELECT count(*) FROM pkm_answer_payment_webhook_events WHERE request_id=r.request_id) AS events
            FROM pkm_answer_requests r JOIN pkm_answer_payment_orders o USING(request_id)
            WHERE r.request_id=:r"""),
                {"r": request},
            )
            .mappings()
            .one()
        )


def dispatch_signed_purchase(monkeypatch, payments, event, answer_engine, request):
    monkeypatch.setattr(routes, "PkmAnswerPaymentService", lambda: payments)
    drive = Mock()
    monkeypatch.setattr(routes, "_service", lambda: drive)
    app = FastAPI()
    app.include_router(routes.webhook_router)
    client = TestClient(app)
    body = json.dumps(event).encode()
    tampered = body.replace(b'"amount_total": 1000', b'"amount_total": 100')
    assert (
        client.post(
            "/api/payments/stripe/webhook", content=tampered, headers=signed(body)
        ).status_code
        == 400
    )
    assert status(answer_engine, request)["payment_status"] == "checkout_open"
    for current in [event, event, {**event, "id": "evt_distinct_same_purchase"}]:
        body = json.dumps(current).encode()
        assert (
            client.post(
                "/api/payments/stripe/webhook", content=body, headers=signed(body)
            ).status_code
            == 200
        )
    return client, drive


async def revoke_staged_key_and_check_checkout(answer_engine, payments, request, requester):
    with answer_engine.begin() as c:
        c.execute(
            text("UPDATE marketplace_recipient_keys SET status='revoked' WHERE user_id=:u"),
            {"u": requester},
        )
        c.execute(
            text("""INSERT INTO marketplace_recipient_keys(user_id,key_id,public_key_jwk,algorithm)
          SELECT user_id,'replacement-key',public_key_jwk,algorithm
          FROM marketplace_recipient_keys WHERE user_id=:u AND key_id='key-1'"""),
            {"u": requester},
        )
    with pytest.raises(AnswerPaymentError, match="answer_not_ready"):
        await payments.checkout(requester_user_id=requester, request_id=request)
    assert (await payments.get_payment(requester_user_id=requester, request_id=request))[
        "preparationStatus"
    ] != "ready"


async def assert_key_recovery_refund(
    requests, engine, request, recovery, envelope, owner, requester
):
    from hushh_mcp.services.pkm_answer_request_service import AnswerRequestError

    if recovery == "timeout":
        with engine.begin() as connection:
            connection.execute(
                text("""UPDATE pkm_answer_requests
                        SET answer_deadline_at=clock_timestamp()-interval '1 hour'
                        WHERE request_id=:r"""),
                {"r": request},
            )
        assert await requests.expire_overdue() == {"expired": 1, "refunds_filed": 1}
        expected_status, reason = "expired", "answer_timeout"
    else:
        # Revocation still rejects delivery to the old key, even for an empty answer.
        with pytest.raises(AnswerRequestError, match="invalid_envelope"):
            await requests.deliver(
                owner_user_id=owner, request_id=request, envelope=envelope, has_content=False
            )
        assert await requests.deliver(
            owner_user_id=owner,
            request_id=request,
            envelope={**envelope, "recipientKeyId": "replacement-key"},
            has_content=False,
        ) == {"delivered": True, "hasContent": False}
        expected_status, reason = "answered", "empty_answer"
    assert await requests.expire_overdue() == {"expired": 0, "refunds_filed": 0}
    with engine.connect() as connection:
        row = (
            connection.execute(
                text("""SELECT r.status, o.owner_earning_status, f.reason,
                           d.recipient_key_id, d.has_content
                    FROM pkm_answer_requests r
                    JOIN pkm_answer_payment_orders o USING(request_id)
                    JOIN pkm_answer_payment_refunds f USING(request_id)
                    JOIN pkm_answer_deliveries d USING(request_id)
                    WHERE r.request_id=:r"""),
                {"r": request},
            )
            .mappings()
            .one()
        )
    assert row["status"] == expected_status
    assert row["owner_earning_status"] == "none"
    assert row["reason"] == reason
    if recovery == "empty":
        assert row["recipient_key_id"] == "replacement-key" and row["has_content"] is False
        fetched = await requests.fetch_answer(requester_user_id=requester, request_id=request)
        assert fetched["hasContent"] is False and fetched["recipientKeyId"] == "replacement-key"
    else:
        with pytest.raises(AnswerRequestError, match="answer_unavailable"):
            await requests.fetch_answer(requester_user_id=requester, request_id=request)
