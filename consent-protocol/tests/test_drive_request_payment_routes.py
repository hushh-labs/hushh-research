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
