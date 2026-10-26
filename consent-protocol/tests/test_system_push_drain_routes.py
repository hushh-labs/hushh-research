from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import system_push_drain as route


@pytest.mark.parametrize(
    "defect", [None, "issuer", "audience", "account", "unverified", "missing", "oversized"]
)
def test_system_push_scheduler_requires_exact_identity(monkeypatch, defect):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    audience, account = route.scheduler_identity()
    claims = {
        "iss": "https://accounts.google.com",
        "aud": audience,
        "email": account,
        "email_verified": True,
    }
    if defect == "issuer":
        claims["iss"] = "https://other.example"
    if defect == "audience":
        claims["aud"] = "https://other.example"
    if defect == "account":
        claims["email"] = "another@hushh-pda-uat.iam.gserviceaccount.com"
    if defect == "unverified":
        claims["email_verified"] = "true"
    monkeypatch.setattr(route, "verify_scheduler_token", Mock(return_value=claims))
    dispatch = Mock(return_value=3)
    monkeypatch.setattr(route, "dispatch_system_pushes", dispatch)
    app = FastAPI()
    app.include_router(route.router)
    headers = (
        {}
        if defect == "missing"
        else {"Authorization": "Bearer " + ("x" * 8193 if defect == "oversized" else "fixture")}
    )
    with TestClient(app) as client:
        response = client.post("/api/internal/system-push/drain", headers=headers)
    assert response.status_code == (200 if defect is None else 401)
    assert "no-store" in response.headers["cache-control"]
    if defect is None:
        assert response.json() == {"processed": 3}
        dispatch.assert_called_once()
    else:
        dispatch.assert_not_called()


def test_system_push_scheduler_refuses_unconfigured_environment(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "unknown")
    app = FastAPI()
    app.include_router(route.router)
    with TestClient(app) as client:
        assert client.post("/api/internal/system-push/drain").status_code == 404
