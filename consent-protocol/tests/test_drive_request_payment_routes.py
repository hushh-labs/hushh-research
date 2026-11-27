"""Requester identity is taken from Firebase auth, never a caller-supplied user ID."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth_read_only
from api.routes import drive_request_payments as routes

REQUEST_ID = "5d0c7a4e-2f61-4c3b-9a8e-0d51a7e3b001"


def test_payment_routes_use_authenticated_requester(monkeypatch):
    service = SimpleNamespace(
        get_payment=AsyncMock(
            return_value={"status": "awaiting_payment", "amountCents": 1000, "currency": "usd"}
        ),
        checkout=AsyncMock(return_value={"checkoutUrl": "https://checkout.stripe.com/test"}),
    )
    monkeypatch.setattr(routes, "_service", lambda: service)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "requester-B"
    client = TestClient(app)

    state = client.get(f"/api/connectors/google_drive/sharing/requests/{REQUEST_ID}/payment")
    checkout = client.post(
        f"/api/connectors/google_drive/sharing/requests/{REQUEST_ID}/payment/checkout"
    )

    assert state.status_code == 200 and state.json()["status"] == "awaiting_payment"
    assert checkout.status_code == 200 and "checkoutUrl" in checkout.json()
    assert state.headers["cache-control"] == "private, no-store"
    service.get_payment.assert_awaited_once_with(
        requester_user_id="requester-B", request_id=REQUEST_ID
    )
    service.checkout.assert_awaited_once_with(
        requester_user_id="requester-B", request_id=REQUEST_ID
    )

    app.dependency_overrides.clear()
    denied = client.post(
        f"/api/connectors/google_drive/sharing/requests/{REQUEST_ID}/payment/checkout"
    )
    assert denied.status_code == 401
    service.checkout.assert_awaited_once()


def test_preexisting_access_errors_are_actionable_and_uncached():
    from hushh_mcp.services.drive_sharing_contract import DriveSharingError

    for code in ("request_already_accessible", "package_existing_access_requires_review"):
        error = routes._http(DriveSharingError(code))
        assert error.status_code == 409
        assert error.detail == {"code": code}
        assert error.headers["Cache-Control"] == "no-store"


def test_scope_commerce_broadcast_on_stripe_webhook_verifies_signature_and_ignores(monkeypatch):
    from hushh_mcp.services.pkm_answer_payment_service import AnswerPaymentError

    payload = (
        b'{"id":"evt_1","type":"checkout.session.completed",'
        b'"data":{"object":{"metadata":{"payment_kind":"scope_commerce"}}}}'
    )
    app = FastAPI()
    app.include_router(routes.webhook_router)
    client = TestClient(app)

    # Validly signed broadcast is verified and ignored with 200 (never 503 via Drive payments).
    ok_service = SimpleNamespace(process_webhook=AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "PkmAnswerPaymentService", lambda: ok_service)
    resp = client.post(
        "/api/payments/stripe/webhook",
        content=payload,
        headers={"Stripe-Signature": "t=1,v1=valid"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"received": True, "ignored": True}
    ok_service.process_webhook.assert_awaited_once_with(payload=payload, signature="t=1,v1=valid")

    # Invalid signature fails closed with 400.
    bad_service = SimpleNamespace(
        process_webhook=AsyncMock(side_effect=AnswerPaymentError("payment_invalid_signature"))
    )
    monkeypatch.setattr(routes, "PkmAnswerPaymentService", lambda: bad_service)
    denied = client.post(
        "/api/payments/stripe/webhook",
        content=payload,
        headers={"Stripe-Signature": "t=1,v1=forged"},
    )
    assert denied.status_code == 400
