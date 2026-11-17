"""An occupied phone stays with its existing email account on every API path."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import account


@pytest.mark.parametrize("endpoint", ["prepare", "confirm"])
def test_transfer_cannot_move_a_number_to_another_email_even_with_sms_proof(monkeypatch, endpoint):
    from uuid import uuid4

    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "other-email-owner"
    verify = AsyncMock()
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", verify)
    payload = {
        "phone_id_token": "synthetic-real-sms-proof",
        "expected_user_id": "other-email-owner",
    }
    if endpoint == "confirm":
        payload.update(transfer_id=str(uuid4()), confirmed=True)
    response = TestClient(app).post(f"/api/account/phone/transfer/{endpoint}", json=payload)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "PHONE_ALREADY_VERIFIED"
    verify.assert_not_awaited()


@pytest.mark.asyncio
async def test_direct_transfer_services_refuse_before_database_or_provider_work(monkeypatch):
    from hushh_mcp.services import phone_transfer_service as service

    pool = AsyncMock()
    monkeypatch.setattr(service, "get_pool", pool)
    for attempt in (
        service.prepare(
            "other-email-owner", "+16505550101", "proof", "previous", object(), proof_valid_until=0
        ),
        service.confirm(
            "other-email-owner", "+16505550101", "proof", "previous", "old-operation", object()
        ),
    ):
        with pytest.raises(HTTPException) as error:
            await attempt
        assert error.value.detail["code"] == "PHONE_ALREADY_VERIFIED"
    pool.assert_not_awaited()
