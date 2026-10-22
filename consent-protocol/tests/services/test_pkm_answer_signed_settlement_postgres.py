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
    _deliver_composed,
    _successful_composition,
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
    "stripe_mode,switch_live", [("test", False), ("test", True), ("live", False)]
)
@pytest.mark.parametrize(
    "event_type", ["checkout.session.completed", "checkout.session.async_payment_succeeded"]
)
@pytest.mark.parametrize("legacy_without_receipt", [False, True])
async def test_signed_dispatch_releases_exact_staged_answer_once(
    answer_engine,  # noqa: F811 - pytest injects the imported fixture
    monkeypatch,
    event_type,
    stripe_mode,
    switch_live,
    legacy_without_receipt,
):
    if stripe_mode == "live":
        monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
        monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", "sk_live_synthetic_only_key")
        monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", SECRET.decode())
        monkeypatch.setenv("PKM_ANSWER_LIVE_PROVIDER_REVIEWED", "true")
    requests, request, _ = await _approved(answer_engine)
    api = Mock()
    api.Webhook = stripe.Webhook
    payments = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
    with pytest.raises(AnswerPaymentError, match="answer_not_ready"):
        await payments.checkout(requester_user_id=REQUESTER, request_id=request)
    api.checkout.Session.create.assert_not_called()
    await _deliver_composed(
        requests, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
    )
    # Duplicate staging hits migration179's real unique index, without rollback.
    await _deliver_composed(
        requests, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
    )
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
    assert args["api_key"].startswith(f"sk_{stripe_mode}_")
    if legacy_without_receipt:
        with answer_engine.begin() as c:
            c.execute(
                text(
                    "UPDATE pkm_answer_deliveries SET source_revisions='{}'::jsonb WHERE request_id=:r"
                ),
                {"r": request},
            )
        assert (await payments.get_payment(requester_user_id=REQUESTER, request_id=request))[
            "preparationStatus"
        ] == "preparing"
        # An old payable session must not be re-advertised before a real
        # Gemini stage exists. External settlement still preserves its order.
        with pytest.raises(AnswerPaymentError, match="answer_not_ready"):
            await payments.checkout(requester_user_id=REQUESTER, request_id=request)
        assert api.checkout.Session.create.call_count == 1
    if switch_live:
        # The shared UAT webhook/Drive mode is now live. Retained test purchases
        # must still verify/recover against the separately retained test keys.
        monkeypatch.setenv("PKM_ANSWER_STRIPE_TEST_SECRET_KEY", "sk_test_local_only_synthetic")
        monkeypatch.setenv("PKM_ANSWER_STRIPE_TEST_WEBHOOK_SECRET", SECRET.decode())
        monkeypatch.setenv("STRIPE_MODE", "live")
        monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_shared_synthetic_only_key")
        monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_shared_synthetic_only_live_secret")
        monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
        monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", "sk_live_synthetic_only_key")
        monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", "whsec_synthetic_only_live_secret")
    assert "answerPaymentRequestId=" in args["success_url"]
    assert args["success_url"].endswith("checkout=success")
    assert args["cancel_url"].endswith("checkout=cancel")
    event = {
        "id": "evt_real_signature",
        "object": "event",
        "type": event_type,
        "livemode": stripe_mode == "live",
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
                "livemode": stripe_mode == "live",
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
    if legacy_without_receipt:
        assert (row["status"], row["payment_status"], row["milestones"]) == ("answering", "paid", 0)
        with pytest.raises(AnswerRequestError, match="answer_unavailable"):
            await requests.fetch_answer(requester_user_id=REQUESTER, request_id=request)
        assert len(await requests.claim_answerable(owner_user_id=OWNER)) == 1
        # The old paid order can be repaired under exactly the old terms. A
        # successful Gemini receipt is still mandatory; no new checkout occurs.
        if switch_live:
            monkeypatch.setenv("PKM_ANSWER_LIVE_PROVIDER_REVIEWED", "true")
        await _deliver_composed(
            requests, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
        )
        assert api.checkout.Session.create.call_count == 1
        body = json.dumps(event).encode()
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
    assert api.Event.retrieve.call_args.kwargs["api_key"].startswith(f"sk_{stripe_mode}_")
    # NULL historical mode can only be bound after checking the authenticated
    # Session against all existing bindings, even on a duplicate event.
    with answer_engine.begin() as c:
        c.execute(
            text(
                "UPDATE pkm_answer_payment_orders SET stripe_mode=NULL, stripe_payment_intent_id='pi_wrong' WHERE request_id=:r"
            ),
            {"r": request},
        )
    with pytest.raises(AnswerPaymentError, match="payment_invalid_event"):
        await payments.recover_checkout_event(
            request_id=request, stripe_event_id=event["id"], stripe_mode=stripe_mode
        )
    with answer_engine.connect() as c:
        assert (
            c.execute(
                text("SELECT stripe_mode FROM pkm_answer_payment_orders WHERE request_id=:r"),
                {"r": request},
            ).scalar_one()
            is None
        )
        assert (
            c.execute(
                text("SELECT stripe_mode FROM pkm_answer_payment_obligations WHERE request_id=:r"),
                {"r": request},
            ).scalar_one()
            is None
        )
    with answer_engine.begin() as c:
        c.execute(
            text(
                "UPDATE pkm_answer_payment_orders SET stripe_payment_intent_id=:pi WHERE request_id=:r"
            ),
            {"r": request, "pi": event["data"]["object"]["payment_intent"]},
        )
    await payments.recover_checkout_event(
        request_id=request, stripe_event_id=event["id"], stripe_mode=stripe_mode
    )
    assert status(answer_engine, request) == row
    with answer_engine.connect() as c:
        assert (
            c.execute(
                text("SELECT stripe_mode FROM pkm_answer_payment_obligations WHERE request_id=:r"),
                {"r": request},
            ).scalar_one()
            == stripe_mode
        )
    api.Event.retrieve.return_value = {**event, "id": "evt_wrong"}
    with pytest.raises(AnswerPaymentError, match="payment_invalid_event"):
        await payments.recover_checkout_event(request_id=request, stripe_event_id=event["id"])


@pytest.mark.parametrize("stripe_mode", ["test", "live"])
async def test_async_pending_then_success_and_expiry_are_signed_lane_events(
    answer_engine,  # noqa: F811 - pytest injects the imported fixture
    monkeypatch,
    stripe_mode,
):
    if stripe_mode == "live":
        monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
        monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", "sk_live_synthetic_only_key")
        monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", SECRET.decode())
        monkeypatch.setenv("PKM_ANSWER_LIVE_PROVIDER_REVIEWED", "true")
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
        "livemode": stripe_mode == "live",
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
    answer_engine,  # noqa: F811 - pytest injects the imported fixture
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


async def test_owner_cannot_make_arbitrary_ciphertext_payable_without_gemini(answer_engine):  # noqa: F811
    requests, request, _ = await _approved(answer_engine)
    with pytest.raises(AnswerRequestError, match="composition_receipt_required"):
        await requests.deliver(owner_user_id=OWNER, request_id=request, envelope=ENVELOPE)
    api = Mock()
    with pytest.raises(AnswerPaymentError, match="answer_not_ready"):
        await PkmAnswerPaymentService(_db(answer_engine), stripe_api=api).checkout(
            requester_user_id=REQUESTER, request_id=request
        )
    api.checkout.Session.create.assert_not_called()


@pytest.mark.parametrize(
    "attack", ["tamper", "another_request", "metadata_injection", "expired", "consent_changed"]
)
async def test_composition_receipt_binds_exact_approved_work(answer_engine, monkeypatch, attack):  # noqa: F811
    from hushh_mcp.services import answer_composition_receipt as receipt_api

    requests, request, _ = await _approved(answer_engine)
    if attack == "expired":
        with monkeypatch.context() as clock:
            clock.setattr(receipt_api.time, "time", lambda: 1_700_000_000)
            written = await _successful_composition(requests, request)
    else:
        written = await _successful_composition(requests, request)
    receipt = written["compositionReceipt"]
    kwargs = {}
    if attack == "tamper":
        receipt = receipt[:-1] + ("A" if receipt[-1] != "A" else "B")
    elif attack == "another_request":
        requests, request, _ = await _approved(answer_engine)
    elif attack == "metadata_injection":
        kwargs["source_revisions"] = {receipt_api.COMPOSITION_RECEIPT_KEY: receipt}
    elif attack == "consent_changed":
        with answer_engine.begin() as c:
            c.execute(
                text(
                    "UPDATE pkm_answer_requests SET composer_consent_digest=NULL WHERE request_id=:r"
                ),
                {"r": request},
            )
    expected = (
        "invalid_envelope"
        if attack == "metadata_injection"
        else "model_processing_consent_required"
        if attack == "consent_changed"
        else "composition_receipt_required"
    )
    with pytest.raises(AnswerRequestError, match=expected):
        await requests.deliver(
            owner_user_id=OWNER,
            request_id=request,
            envelope=ENVELOPE,
            composition_receipt=receipt,
            **kwargs,
        )
    with answer_engine.connect() as c:
        assert (
            c.execute(
                text("SELECT count(*) FROM pkm_answer_deliveries WHERE request_id=:r"),
                {"r": request},
            ).scalar_one()
            == 0
        )


async def test_verified_staging_survives_receipt_expiry_without_storing_answer(
    answer_engine,  # noqa: F811
    monkeypatch,
):
    from hushh_mcp.services import answer_composition_receipt as receipt_api

    requests, request, _ = await _approved(answer_engine)
    with monkeypatch.context() as clock:
        clock.setattr(receipt_api.time, "time", lambda: 1_700_000_000)
        written = await _successful_composition(requests, request)
        await requests.deliver(
            owner_user_id=OWNER,
            request_id=request,
            envelope=ENVELOPE,
            composition_receipt=written["compositionReceipt"],
            source_revisions={"travel": 7},
        )
    payments = PkmAnswerPaymentService(_db(answer_engine), stripe_api=Mock())
    assert (await payments.get_payment(requester_user_id=REQUESTER, request_id=request))[
        "preparationStatus"
    ] == "ready"
    payments.stripe_api.checkout.Session.create.side_effect = lambda **kw: {
        "id": "cs_receipt_expired",
        "url": "https://checkout.stripe.com/c/pay/cs_receipt_expired",
        "expires_at": kw["expires_at"],
    }
    await payments.checkout(requester_user_id=REQUESTER, request_id=request)
    with answer_engine.connect() as c:
        revisions = c.execute(
            text("SELECT source_revisions FROM pkm_answer_deliveries WHERE request_id=:r"),
            {"r": request},
        ).scalar_one()
    assert set(revisions) == {
        "travel",
        receipt_api.COMPOSITION_RECEIPT_KEY,
        receipt_api.COMPOSITION_TERMS_KEY,
    }
    claims = receipt_api.verify_composition_receipt(
        revisions[receipt_api.COMPOSITION_RECEIPT_KEY],
        request_id=request,
        owner_user_id=OWNER,
        terms_digest=revisions[receipt_api.COMPOSITION_TERMS_KEY],
        require_fresh=False,
    )
    assert "Tokyo" not in json.dumps(claims)
    assert "answer" not in claims and "projection" not in claims


async def test_gemini_failure_issues_no_receipt_and_cannot_stage_success(answer_engine):  # noqa: F811
    from unittest.mock import patch
    from uuid import UUID

    from fastapi import Response

    from api.routes.one import answer_requests as answer_routes
    from hushh_mcp.services.answer_composer import AnswerComposer

    requests, request, _ = await _approved(answer_engine)

    async def failed_provider(_prompt):
        raise TimeoutError("synthetic unavailable provider")

    writer = AnswerComposer(runner=failed_provider)
    with (
        patch.object(answer_routes, "_requests", return_value=requests),
        patch.object(answer_routes, "AnswerComposer", return_value=writer),
    ):
        written = await answer_routes.compose_answer(
            UUID(request),
            Response(),
            {
                "projection": {
                    "memory": "Approved trip",
                    "values": {"attr.travel.trips": {"trips": [{"city": "Tokyo"}]}},
                }
            },
            OWNER,
        )
    assert written == {"answerMode": "projection", "answer": None}
    with pytest.raises(AnswerRequestError, match="composition_receipt_required"):
        await requests.deliver(owner_user_id=OWNER, request_id=request, envelope=ENVELOPE)
    assert len(await requests.claim_answerable(owner_user_id=OWNER)) == 1


async def test_unreceipted_legacy_stage_requires_gemini_refresh_before_new_checkout(answer_engine):  # noqa: F811
    requests, request, _ = await _approved(answer_engine, prepared=True)
    with answer_engine.begin() as c:
        c.execute(
            text(
                "UPDATE pkm_answer_deliveries SET source_revisions='{}'::jsonb WHERE request_id=:r"
            ),
            {"r": request},
        )
    payments = PkmAnswerPaymentService(_db(answer_engine), stripe_api=Mock())
    assert (await payments.get_payment(requester_user_id=REQUESTER, request_id=request))[
        "preparationStatus"
    ] == "preparing"
    with pytest.raises(AnswerPaymentError, match="answer_not_ready"):
        await payments.checkout(requester_user_id=REQUESTER, request_id=request)
    assert len(await requests.claim_answerable(owner_user_id=OWNER)) == 1
    await _deliver_composed(
        requests, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
    )
    assert (await payments.get_payment(requester_user_id=REQUESTER, request_id=request))[
        "preparationStatus"
    ] == "ready"
