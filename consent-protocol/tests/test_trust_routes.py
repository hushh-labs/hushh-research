"""Tests for the TrustLink HTTP surface (/api/trust/*).

These routes back the Capacitor consent plugin's createTrustLink /
verifyTrustLink methods. The backend is the single signing authority.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.trust import router

_USER = "user_trust_routes"


def _build_client(authenticated_user: str | None = _USER) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    if authenticated_user is not None:

        def _stub_vault_owner():
            return {"user_id": authenticated_user, "scope": "vault.owner"}

        app.dependency_overrides[require_vault_owner_token] = _stub_vault_owner
    return TestClient(app)


@pytest.fixture()
def client() -> TestClient:
    return _build_client()


def _create_link(client: TestClient, **overrides) -> dict:
    payload = {
        "from_agent": "agent_one",
        "to_agent": "agent_kai",
        "scope": "agent.kai.analyze",
        "signed_by_user": _USER,
        "session_id": "sess_a",
    }
    payload.update(overrides)
    response = client.post("/api/trust/create-link", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_create_link_returns_signed_link(client: TestClient) -> None:
    data = _create_link(client)
    assert data["from_agent"] == "agent_one"
    assert data["to_agent"] == "agent_kai"
    assert data["scope"] == "agent.kai.analyze"
    assert data["signed_by_user"] == _USER
    assert data["session_id"] == "sess_a"
    assert data["signature"]
    assert data["expires_at"] > data["created_at"]


def test_create_link_rejects_user_mismatch(client: TestClient) -> None:
    response = client.post(
        "/api/trust/create-link",
        json={
            "from_agent": "agent_one",
            "to_agent": "agent_kai",
            "scope": "agent.kai.analyze",
            "signed_by_user": "someone_else",
        },
    )
    assert response.status_code == 403


def test_create_link_rejects_unknown_scope(client: TestClient) -> None:
    response = client.post(
        "/api/trust/create-link",
        json={
            "from_agent": "agent_one",
            "to_agent": "agent_kai",
            "scope": "definitely.not.a.scope",
            "signed_by_user": _USER,
        },
    )
    assert response.status_code == 422


def test_verify_round_trip(client: TestClient) -> None:
    link = _create_link(client)
    response = client.post(
        "/api/trust/verify-link",
        json={"link": link, "required_scope": "agent.kai.analyze"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True


def test_verify_rejects_tampered_signature(client: TestClient) -> None:
    link = _create_link(client)
    link["signature"] = "0" * len(link["signature"])
    response = client.post("/api/trust/verify-link", json={"link": link})
    assert response.json()["valid"] is False


def test_verify_rejects_scope_mismatch(client: TestClient) -> None:
    link = _create_link(client)
    response = client.post(
        "/api/trust/verify-link",
        json={"link": link, "required_scope": "agent.nav.review"},
    )
    assert response.json()["valid"] is False


def test_verify_enforces_session_binding(client: TestClient) -> None:
    link = _create_link(client, session_id="sess_a")
    ok = client.post(
        "/api/trust/verify-link",
        json={"link": link, "expected_session_id": "sess_a"},
    )
    assert ok.json()["valid"] is True

    replayed = client.post(
        "/api/trust/verify-link",
        json={"link": link, "expected_session_id": "sess_b"},
    )
    assert replayed.json()["valid"] is False


# --- verbatim dynamic scope over HTTP -----------------------------------------


def test_create_link_reports_the_delegated_scope_not_the_enum(client: TestClient):
    """A dynamic scope must come back as itself, not as `pkm.read`."""
    link = _create_link(client, scope="attr.food.recipes.*")
    assert link["scope"] == "attr.food.recipes.*"
    assert link["scope_str"] == "attr.food.recipes.*"


def test_narrow_link_does_not_verify_against_a_sibling_domain(client: TestClient):
    """The original defect, end to end.

    Both scopes resolve to `ConsentScope.PKM_READ`, so comparing the enum
    answered `valid: true` here and a recipes delegation reached holdings.
    """
    link = _create_link(client, scope="attr.food.recipes.*")

    same = client.post(
        "/api/trust/verify-link",
        json={
            "link": link,
            "required_scope": "attr.food.recipes.*",
            "expected_session_id": "sess_a",
        },
    )
    assert same.status_code == 200
    assert same.json()["valid"] is True

    sibling = client.post(
        "/api/trust/verify-link",
        json={
            "link": link,
            "required_scope": "attr.financial.holdings.*",
            "expected_session_id": "sess_a",
        },
    )
    assert sibling.status_code == 200
    body = sibling.json()
    assert body["valid"] is False
    assert body["reason"] == "Scope mismatch"


def test_a_link_cannot_be_retargeted_after_signing(client: TestClient):
    """The verbatim scope is signed, so editing it invalidates the link."""
    link = _create_link(client, scope="attr.food.recipes.*")
    widened = {**link, "scope_str": "attr.financial.holdings.*"}

    response = client.post(
        "/api/trust/verify-link",
        json={"link": widened, "expected_session_id": "sess_a"},
    )
    assert response.status_code == 200
    assert response.json()["valid"] is False


def test_static_scopes_are_unaffected(client: TestClient):
    """A non-dynamic scope keeps its existing behaviour exactly."""
    link = _create_link(client, scope="agent.kai.analyze")
    assert link["scope"] == "agent.kai.analyze"

    ok = client.post(
        "/api/trust/verify-link",
        json={
            "link": link,
            "required_scope": "agent.kai.analyze",
            "expected_session_id": "sess_a",
        },
    )
    assert ok.json()["valid"] is True

    wrong = client.post(
        "/api/trust/verify-link",
        json={
            "link": link,
            "required_scope": "agent.nav.review",
            "expected_session_id": "sess_a",
        },
    )
    assert wrong.json()["valid"] is False
