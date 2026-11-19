"""A Check-In plan is owner-scoped intent, never an asserted delivery result."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import location_check_ins as routes


def test_check_in_api_rejects_unauthenticated_plan_and_caller_asserted_receipts(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    payload = {
        "clientOperationId": "qa-plan",
        "recipientIds": ["contact"],
        "durationHours": 1,
        "confirmedAt": "2026-11-19T10:00:00Z",
    }
    assert client.post("/api/one/location/check-ins", json=payload).status_code in {401, 403}
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "verified-owner"}
    calls = []
    monkeypatch.setattr(
        routes, "begin_check_in", lambda **kwargs: calls.append(kwargs) or {"confirmedCount": 0}
    )
    for forged in (
        {"owner": "another-owner"},
        {"confirmedCount": 3},
        {"state": "completed"},
        {"grantIds": ["ui-only"]},
    ):
        assert (
            client.post("/api/one/location/check-ins", json={**payload, **forged}).status_code
            == 422
        )
    assert calls == []
    response = client.post("/api/one/location/check-ins", json=payload)
    assert response.status_code == 200 and response.json()["operation"]["confirmedCount"] == 0
    assert calls[0]["owner"] == "verified-owner"
    assert response.headers["cache-control"] == "private, no-store"


def test_manual_location_decision_requires_the_reviewed_request_and_aware_extension():
    from pydantic import ValidationError

    from api.routes.one.location_request_models import ResolveAccessRequest

    valid = {
        "approvalMode": "manual",
        "expectedRequestRevision": 2,
        "reviewedExtension": {
            "grantId": "20000000-1000-4000-8000-000000000001",
            "expiresAt": "2026-11-19T12:00:00Z",
        },
    }
    assert ResolveAccessRequest.model_validate(valid).expected_request_revision == 2
    for invalid in (
        {"approvalMode": "manual"},
        {
            **valid,
            "reviewedExtension": {**valid["reviewedExtension"], "expiresAt": "2026-11-19T12:00:00"},
        },
    ):
        try:
            ResolveAccessRequest.model_validate(invalid)
        except ValidationError:
            continue
        raise AssertionError("An unreviewed or ambiguous approval was accepted")
