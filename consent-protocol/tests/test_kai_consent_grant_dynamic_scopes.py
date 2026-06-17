"""Regression tests for the Kai /consent/grant endpoint with dynamic scopes.

Before the fix, grant_consent called ConsentScope(scope_str) which rejected
any dynamic scope like "attr.financial.*" with a ValueError that was caught
and turned into a 400 response. The default scopes in GrantConsentRequest
included "attr.financial.*", so calling the endpoint with defaults always
returned 400.

The fix passes scope_str directly to issue_token and validates against the
Kai consent contract: only attr.financial.* subpaths and agent.kai.* scopes
are accepted. Broader PKM domains such as attr.health.* are rejected.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import consent as consent_mod
from api.routes.kai.consent import _validate_scope

# ---------------------------------------------------------------------------
# unit-level: _validate_scope
# ---------------------------------------------------------------------------


def test_validate_scope_accepts_static_consent_scope() -> None:
    """Static ConsentScope values must be accepted."""
    _validate_scope("vault.owner")
    _validate_scope("pkm.read")
    _validate_scope("agent.kai.analyze")


def test_validate_scope_accepts_kai_financial_scopes() -> None:
    """attr.financial.* dynamic scopes are within the Kai contract."""
    _validate_scope("attr.financial.*")
    _validate_scope("attr.financial.portfolio.*")
    _validate_scope("attr.financial.holdings")
    _validate_scope("attr.financial.profile.*")


def test_validate_scope_accepts_agent_kai_scopes() -> None:
    """agent.kai.* scopes are within the Kai contract."""
    _validate_scope("agent.kai.analyze")
    _validate_scope("agent.kai.read")


def test_validate_scope_rejects_non_kai_attr_domains() -> None:
    """attr.* scopes outside the Kai financial/agent contract must be rejected."""
    with pytest.raises(ValueError):
        _validate_scope("attr.health.*")
    with pytest.raises(ValueError):
        _validate_scope("attr.food.*")
    with pytest.raises(ValueError):
        _validate_scope("attr.travel.*")
    with pytest.raises(ValueError):
        _validate_scope("attr.shopping.*")


def test_validate_scope_rejects_unknown_string() -> None:
    """Arbitrary strings that match neither enum nor the Kai contract must be rejected."""
    with pytest.raises(ValueError):
        _validate_scope("totally_invalid_scope")


def test_validate_scope_rejects_empty_string() -> None:
    with pytest.raises(ValueError):
        _validate_scope("")


# ---------------------------------------------------------------------------
# integration-level: POST /consent/grant
# ---------------------------------------------------------------------------


def _make_client(firebase_uid: str = "uid-123") -> TestClient:
    app = FastAPI()
    app.include_router(consent_mod.router)
    app.dependency_overrides[consent_mod.require_firebase_auth] = lambda: firebase_uid
    return TestClient(app)


@pytest.fixture()
def _mock_consent_db():
    """Patch ConsentDBService to avoid real DB calls."""
    with patch.object(
        consent_mod.ConsentDBService,
        "insert_internal_event",
        new=AsyncMock(return_value=None),
    ):
        yield


def test_grant_consent_default_scopes_returns_200(_mock_consent_db) -> None:
    """The default scopes (attr.financial.* + agent.kai.analyze) must succeed."""
    client = _make_client()

    response = client.post(
        "/consent/grant",
        json={"user_id": "uid-123"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert "attr.financial.*" in body["tokens"]
    assert "agent.kai.analyze" in body["tokens"]
    assert body["consent_id"].startswith("kai_consent_")


def test_grant_consent_financial_subpath_scope_returns_200(_mock_consent_db) -> None:
    """A deeper attr.financial.* subpath must be accepted."""
    client = _make_client()

    response = client.post(
        "/consent/grant",
        json={"user_id": "uid-123", "scopes": ["attr.financial.portfolio.*"]},
    )

    assert response.status_code == 200, response.text
    assert "attr.financial.portfolio.*" in response.json()["tokens"]


def test_grant_consent_static_scope_returns_200(_mock_consent_db) -> None:
    """Static ConsentScope values must still work."""
    client = _make_client()

    response = client.post(
        "/consent/grant",
        json={"user_id": "uid-123", "scopes": ["agent.kai.analyze"]},
    )

    assert response.status_code == 200, response.text


def test_grant_consent_out_of_contract_scope_returns_400(_mock_consent_db) -> None:
    """attr.health.* is outside the Kai consent contract and must return 400."""
    client = _make_client()

    response = client.post(
        "/consent/grant",
        json={"user_id": "uid-123", "scopes": ["attr.health.*"]},
    )

    assert response.status_code == 400, response.text
    body = response.json()
    # The rejected scope value must not be echoed back (CWE-209)
    assert "attr.health" not in body.get("detail", "")


def test_grant_consent_invalid_scope_returns_opaque_400(_mock_consent_db) -> None:
    """Garbage scope strings must return 400 without echoing the input."""
    client = _make_client()

    response = client.post(
        "/consent/grant",
        json={"user_id": "uid-123", "scopes": ["totally_invalid_scope"]},
    )

    assert response.status_code == 400
    body = response.json()
    assert "totally_invalid_scope" not in body.get("detail", "")


def test_grant_consent_rejects_user_mismatch() -> None:
    """Requesting consent for a different user_id must return 403."""
    client = _make_client(firebase_uid="uid-other")

    response = client.post(
        "/consent/grant",
        json={"user_id": "uid-123"},
    )

    assert response.status_code == 403
