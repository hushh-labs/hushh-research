"""
Regression tests for GrantConsentRequest scope-item length enforcement.

Attach point: api/routes/kai/consent.py

Bug 1 — CWE-400 (Uncontrolled Resource Consumption):
  ``GrantConsentRequest.scopes`` was declared as ``List[str]`` with only a
  list-level ``max_length=20`` (capping the count).  Each individual scope
  string had no upper bound, so a caller could send a single megabyte-scale
  scope value that reached the ``ConsentScope(scope_str)`` call, raised a
  ValueError, and was then propagated downstream (to logs and the HTTP
  response detail).

Bug 2 — CWE-209 (Information Exposure Through Error Message):
  On scope validation failure the handler raised:
      HTTPException(status_code=400, detail=f"Invalid scope: {scope_str}")
  This reflected the caller-supplied scope string verbatim back in the
  response body.  A client submitting a large or sensitive-looking string
  would see it echoed in the API error response.

Fix:
  1. Each list element is now ``Annotated[str, Field(min_length=1, max_length=128)]``.
     Pydantic enforces the bound before the handler runs; HTTP 422 is returned
     automatically.
  2. The error detail is replaced with the static string
     ``"Invalid or unsupported scope"`` so no caller-supplied content is
     reflected.

Tests cover:
- Model-level: oversized scope item raises ValidationError
- Model-level: valid payloads still pass
- HTTP-layer: oversized scope item → 422
- HTTP-layer: empty scope string → 422
- HTTP-layer: valid payload → not 422
- Error detail does not echo caller-supplied scope value
- Constant-guard: all real ConsentScope values fit within max_length=128
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.kai.consent import GrantConsentRequest

# ---------------------------------------------------------------------------
# Model-level tests (no network required)
# ---------------------------------------------------------------------------


def test_oversized_scope_item_raises_validation_error():
    """A scope string exceeding 128 chars must be rejected at model level."""
    with pytest.raises(ValidationError) as exc_info:
        GrantConsentRequest(
            user_id="user_abc",
            scopes=["a" * 129],
        )
    errors = exc_info.value.errors()
    assert any(
        "string_too_long" in e.get("type", "") or "max_length" in str(e)
        for e in errors
    ), f"Expected max_length error, got: {errors}"


def test_empty_scope_item_raises_validation_error():
    """An empty scope string must be rejected (min_length=1)."""
    with pytest.raises(ValidationError) as exc_info:
        GrantConsentRequest(
            user_id="user_abc",
            scopes=[""],
        )
    errors = exc_info.value.errors()
    assert any(
        "string_too_short" in e.get("type", "") or "min_length" in str(e)
        for e in errors
    ), f"Expected min_length error, got: {errors}"


def test_valid_scope_item_passes():
    """A well-formed scope string within bounds must pass validation."""
    payload = GrantConsentRequest(
        user_id="user_abc",
        scopes=["attr.financial.*", "agent.kai.analyze"],
    )
    assert len(payload.scopes) == 2


def test_too_many_scope_items_raises_validation_error():
    """More than 20 scope items must be rejected (max_length=20 on the list)."""
    with pytest.raises(ValidationError):
        GrantConsentRequest(
            user_id="user_abc",
            scopes=["scope"] * 21,
        )


def test_all_consent_scope_values_fit_within_max_length():
    """
    Sanity check: every real ConsentScope value must be <= 128 chars so
    legitimate callers are never rejected by the new bound.
    """
    from hushh_mcp.constants import ConsentScope

    oversized = [s.value for s in ConsentScope if len(s.value) > 128]
    assert not oversized, (
        f"The following ConsentScope values exceed 128 chars and would be "
        f"rejected by the new bound: {oversized}"
    )


# ---------------------------------------------------------------------------
# HTTP-layer tests (TestClient)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client():
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from api.middleware import require_firebase_auth
    from server import app

    # Stub Firebase auth to return a uid matching user_id in the payload.
    def _stub_firebase(authorization: str | None = None):  # noqa: ARG001
        return "user_abc"

    with patch.dict(app.dependency_overrides, {require_firebase_auth: _stub_firebase}):
        yield TestClient(app, raise_server_exceptions=False)


def test_http_oversized_scope_item_returns_422(client):
    """POST /consent/grant with a 129-char scope must return 422."""
    resp = client.post(
        "/consent/grant",
        json={"user_id": "user_abc", "scopes": ["a" * 129]},
        headers={"Authorization": "Bearer stub"},
    )
    assert resp.status_code == 422, (
        f"Expected 422 for oversized scope item, got {resp.status_code}"
    )


def test_http_empty_scope_item_returns_422(client):
    """POST /consent/grant with an empty scope string must return 422."""
    resp = client.post(
        "/consent/grant",
        json={"user_id": "user_abc", "scopes": [""]},
        headers={"Authorization": "Bearer stub"},
    )
    assert resp.status_code == 422, (
        f"Expected 422 for empty scope string, got {resp.status_code}"
    )


def test_http_valid_payload_not_rejected_by_validation(client):
    """A well-formed payload must not be rejected with 422 by our new checks."""
    resp = client.post(
        "/consent/grant",
        json={"user_id": "user_abc", "scopes": ["attr.financial.*"]},
        headers={"Authorization": "Bearer stub"},
    )
    # Should NOT be 422 — may fail for other business reasons
    assert resp.status_code != 422, (
        f"Valid payload incorrectly rejected with 422: {resp.json()}"
    )


def test_error_detail_does_not_echo_scope_string(client):
    """
    When a scope is invalid, the 400 response must NOT echo the scope value
    back in the detail field (CWE-209 guard).
    """
    # Send a valid-length but semantically invalid scope so it passes Pydantic
    # but fails ConsentScope(scope_str).
    fake_scope = "DEFINITELY_NOT_A_REAL_SCOPE_VALUE"
    resp = client.post(
        "/consent/grant",
        json={"user_id": "user_abc", "scopes": [fake_scope]},
        headers={"Authorization": "Bearer stub"},
    )
    # The response should be 400 (invalid scope) or 500 (other error)
    if resp.status_code == 400:
        detail = resp.json().get("detail", "")
        assert fake_scope not in str(detail), (
            f"Scope string was echoed in the error response detail: {detail}"
        )
