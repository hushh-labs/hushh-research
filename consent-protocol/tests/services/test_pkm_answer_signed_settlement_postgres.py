"""Real shared webhook -> order -> sealed answer, with production Feed constraints."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from unittest.mock import Mock

import pytest
import stripe
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

from api.routes import drive_request_payments as routes
from hushh_mcp.services.pkm_answer_payment_service import (
    AnswerPaymentError,
    PkmAnswerPaymentService,
)
from hushh_mcp.services.pkm_answer_request_service import AnswerRequestError
from tests.services.test_pkm_answer_races_postgres import _approved, payments_enabled  # noqa: F401
from tests.services.test_pkm_answer_requests_postgres import (  # noqa: F401
    ENVELOPE,
    OWNER,
    REQUESTER,
    _db,
    answer_engine,
    clean,
    connector_postgres_url,
)

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


@pytest.mark.parametrize(
    "event_type", ["checkout.session.completed", "checkout.session.async_payment_succeeded"]
)
async def test_signed_dispatch_releases_exact_staged_answer_once(
    answer_engine,  # noqa: F811
    monkeypatch,
    event_type,
):
    requests, request, _ = await _approved(answer_engine)
    api = Mock()
    api.Webhook = stripe.Webhook
    payments = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
    with pytest.raises(AnswerPaymentError, match="answer_not_ready"):
        await payments.checkout(requester_user_id=REQUESTER, request_id=request)
    api.checkout.Session.create.assert_not_called()
    await requests.deliver(owner_user_id=OWNER, request_id=request, envelope=ENVELOPE)
    # Duplicate staging hits migration179's real unique index, without rollback.
    await requests.deliver(owner_user_id=OWNER, request_id=request, envelope=ENVELOPE)
    with pytest.raises(AnswerRequestError, match="answer_unavailable"):
        await requests.fetch_answer(requester_user_id=REQUESTER, request_id=request)
    api.checkout.Session.create.side_effect = lambda **kw: {
        "id": "cs_test_signed",
        "url": "https://checkout.stripe.com/c/pay/cs_test_signed",
        "expires_at": kw["expires_at"],
        "metadata": kw["metadata"],
    }
    await payments.checkout(requester_user_id=REQUESTER, request_id=request)
    args = api.checkout.Session.create.call_args.kwargs
    assert "answerPaymentRequestId=" in args["success_url"]
    assert args["success_url"].endswith("checkout=success")
    assert args["cancel_url"].endswith("checkout=cancel")
    event = {
        "id": "evt_real_signature",
        "object": "event",
        "type": event_type,
        "livemode": False,
        "data": {
            "object": {
                "id": "cs_test_signed",
                "object": "checkout.session",
                "mode": "payment",
                "client_reference_id": request,
                "metadata": args["metadata"],
                "payment_status": "paid",
                "amount_total": 1000,
                "currency": "usd",
                "livemode": False,
                "payment_intent": "pi_test_signed",
            }
        },
    }
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
    row = status(answer_engine, request)
    assert (row["status"], row["payment_status"], row["milestones"], row["events"]) == (
        "answered",
        "paid",
        1,
        2,
    )
    fetched = await requests.fetch_answer(requester_user_id=REQUESTER, request_id=request)
    assert fetched["ciphertext"] == ENVELOPE["ciphertext"]
    with pytest.raises(AnswerRequestError, match="answer_unavailable"):
        await requests.fetch_answer(requester_user_id="unrelated-requester", request_id=request)
    drive.process_webhook.assert_not_called()
    # Authenticated provider recovery shares the exact transaction/replay guard.
    api.Event.retrieve.return_value = event
    api.checkout.Session.retrieve.return_value = event["data"]["object"]
    await payments.recover_checkout_event(request_id=request, stripe_event_id=event["id"])
    assert status(answer_engine, request) == row
    api.Event.retrieve.return_value = {**event, "id": "evt_wrong"}
    with pytest.raises(AnswerPaymentError, match="payment_invalid_event"):
        await payments.recover_checkout_event(request_id=request, stripe_event_id=event["id"])


async def test_async_pending_then_success_and_expiry_are_signed_lane_events(
    answer_engine,  # noqa: F811
    monkeypatch,
):
    requests, request, _ = await _approved(answer_engine, prepared=True)
    api = Mock()
    api.Webhook = stripe.Webhook
    api.checkout.Session.create.side_effect = lambda **kw: {
        "id": "cs_test_delayed",
        "url": "https://checkout.stripe.com/c/pay/cs_test_delayed",
        "expires_at": kw["expires_at"],
    }
    payments = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
    await payments.checkout(requester_user_id=REQUESTER, request_id=request)
    args = api.checkout.Session.create.call_args.kwargs
    session = {
        "id": "cs_test_delayed",
        "object": "checkout.session",
        "mode": "payment",
        "client_reference_id": request,
        "metadata": args["metadata"],
        "amount_total": 1000,
        "currency": "usd",
        "livemode": False,
        "payment_intent": "pi_test_delayed",
        "payment_status": "unpaid",
    }
    monkeypatch.setattr(routes, "PkmAnswerPaymentService", lambda: payments)
    app = FastAPI()
    app.include_router(routes.webhook_router)
    client = TestClient(app)

    def post(kind, value):
        body = json.dumps({"id": f"evt_{kind}", "type": kind, "data": {"object": value}}).encode()
        return client.post("/api/payments/stripe/webhook", content=body, headers=signed(body))

    assert post("checkout.session.completed", session).status_code == 409
    assert status(answer_engine, request)["status"] == "approved"
    assert post("checkout.session.expired", session).status_code == 200
    assert status(answer_engine, request)["payment_status"] == "expired"
    assert (
        post(
            "checkout.session.async_payment_succeeded", {**session, "payment_status": "paid"}
        ).status_code
        == 200
    )
    assert status(answer_engine, request)["status"] == "answered"


@pytest.mark.parametrize("cancel_first", [False, True])
async def test_disconnect_before_delayed_payment_withholds_stage_and_refunds(
    answer_engine,  # noqa: F811
    monkeypatch,
    cancel_first,
):
    requests, request, _ = await _approved(answer_engine, prepared=True)
    api = Mock()
    api.Webhook = stripe.Webhook
    api.checkout.Session.create.side_effect = lambda **kw: {
        "id": "cs_test_disconnect",
        "url": "https://checkout.stripe.com/c/pay/cs_test_disconnect",
        "expires_at": kw["expires_at"],
    }
    payments = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
    await payments.checkout(requester_user_id=REQUESTER, request_id=request)
    args = api.checkout.Session.create.call_args.kwargs
    if cancel_first:
        # An unreleased staged answer must remain cancellable.
        await requests.cancel(requester_user_id=REQUESTER, request_id=request)
    with answer_engine.begin() as c:
        c.execute(text("UPDATE connections SET status='revoked'"))
    event = {
        "id": "evt_disconnect_paid",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test_disconnect",
                "object": "checkout.session",
                "mode": "payment",
                "client_reference_id": request,
                "metadata": args["metadata"],
                "amount_total": 1000,
                "currency": "usd",
                "livemode": False,
                "payment_intent": "pi_test_disconnect",
                "payment_status": "paid",
            }
        },
    }
    body = json.dumps(event).encode()
    await payments.process_webhook(payload=body, signature=signed(body)["Stripe-Signature"])
    await payments.process_webhook(payload=body, signature=signed(body)["Stripe-Signature"])
    row = status(answer_engine, request)
    assert row["payment_status"] == "paid" and row["milestones"] == 0 and row["events"] == 1
    assert row["status"] == ("cancelled" if cancel_first else "declined")
    with answer_engine.connect() as c:
        reason = c.execute(
            text("SELECT reason FROM pkm_answer_payment_refunds WHERE request_id=:r"),
            {"r": request},
        ).scalar_one()
    assert reason == ("requester_cancelled" if cancel_first else "owner_declined")
    with pytest.raises(AnswerRequestError, match="answer_unavailable"):
        await requests.fetch_answer(requester_user_id=REQUESTER, request_id=request)
