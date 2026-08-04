"""
Regression tests: DatabaseExecutionError.details must not reach HTTP clients.

CWE-209 - Information Exposure Through Error Messages.

database_error_detail() in hushh_mcp/services/one_location_agent_service.py
previously forwarded the raw exception detail into the HTTP response body:

    return {
        "code": exc.code,
        "message": exc.details,      # <-- str(<the DBAPI error>)
        "hint": exc.hint or "",
    }

db/db_client.py builds that `details` from `str(e)` on the SQLAlchemy error
(raise sites for select/insert/update/delete). For a DBAPIError, SQLAlchemy
appends the failing SQL statement AND every bound value to str(e) -- no engine
in this service sets hide_parameters -- so the detail looks like:

    (psycopg2.errors...) ...
    [SQL: INSERT INTO one_location_recipients (...) VALUES (...)]
    [parameters: {'phone': '+919812345678', 'email': '...', 'lat': 12.97, ...}]

The Location plane binds phone numbers, display labels, invite tokens and
coordinates, so those bound values are user PII.

format_database_unavailable_details() does not sanitise -- it only appends a
local-dev hint -- and local_database_unavailable_hint() returns None in
production, so nothing upstream neutralises the leak.

Fix: return a static message chosen by status code (503 vs 500); keep the
stable `code` and the static `hint`; log the code/table/operation server-side.
Same shape as the Wallet Profile routes, which duck-type the exception for the
identical reason (routes may not import db.*).

Attach point: database_error_detail() is called by _handle_error() in
api/routes/one/location.py, which every /api/one/location/* handler raises
through.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

SENTINEL = "XK9_ONE_LOCATION_DB_PARAMS_SENTINEL_XK9"

_FAKE_FIREBASE_UID = "test-one-location-cwe209"
_FAKE_TOKEN_DATA = {
    "user_id": _FAKE_FIREBASE_UID,
    "token_type": "VAULT_OWNER",
    "scope": "vault.owner",
}


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from api.middleware import require_vault_owner_token
    from server import app

    app.dependency_overrides[require_vault_owner_token] = lambda: _FAKE_TOKEN_DATA
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c
    finally:
        app.dependency_overrides.pop(require_vault_owner_token, None)


def _make_db_error(sentinel: str, *, status_code: int = 500):
    """A DatabaseExecutionError shaped exactly like the ones db_client raises."""
    from db.db_client import DatabaseExecutionError

    return DatabaseExecutionError(
        table_name="one_location_recipients",
        operation="insert",
        details=(
            "(psycopg2.errors.UniqueViolation) duplicate key value violates unique constraint\n"
            "[SQL: INSERT INTO one_location_recipients (owner_user_id, phone) VALUES (%s, %s)]\n"
            f"[parameters: {{'owner_user_id': 'user_a', 'phone': '{sentinel}'}}]"
        ),
        status_code=status_code,
        code="DATABASE_UNAVAILABLE" if status_code == 503 else "DATABASE_EXECUTION_ERROR",
        hint=None,
    )


# ---------------------------------------------------------------------------
# Unit tests: database_error_detail directly
# ---------------------------------------------------------------------------


def test_bound_parameters_not_in_error_detail() -> None:
    """The raw str(DBAPIError) must not appear in the client-facing detail."""
    from hushh_mcp.services.one_location_agent_service import database_error_detail

    detail = database_error_detail(_make_db_error(SENTINEL))

    detail_str = str(detail)
    assert SENTINEL not in detail_str, f"bound parameter leaked into detail: {detail_str}"
    assert "[parameters:" not in detail_str
    assert "[SQL:" not in detail_str
    assert "psycopg2" not in detail_str


def test_error_code_is_preserved() -> None:
    """Error code must still be returned for client routing."""
    from hushh_mcp.services.one_location_agent_service import database_error_detail

    detail = database_error_detail(_make_db_error(SENTINEL))

    assert detail["code"] == "DATABASE_EXECUTION_ERROR"
    assert detail["message"] == "Location request failed."


def test_unavailable_status_gets_its_own_static_message() -> None:
    """A 503 must stay distinguishable from a 500 without echoing the detail."""
    from hushh_mcp.services.one_location_agent_service import database_error_detail

    detail = database_error_detail(_make_db_error(SENTINEL, status_code=503))

    assert detail["code"] == "DATABASE_UNAVAILABLE"
    assert detail["message"] == "Location storage is temporarily unavailable. Try again shortly."
    assert SENTINEL not in str(detail)


def test_static_local_hint_is_still_forwarded() -> None:
    """The hint is static operator text (local dev only) and stays useful."""
    from hushh_mcp.services.one_location_agent_service import database_error_detail

    exc = _make_db_error(SENTINEL, status_code=503)
    exc.hint = "Local backend database tunnel is unavailable."

    detail = database_error_detail(exc)

    assert detail["hint"] == "Local backend database tunnel is unavailable."
    assert SENTINEL not in str(detail)


def test_raw_detail_is_logged_server_side(caplog) -> None:
    """The operator still gets the code/table/operation in the server log."""
    import logging

    from hushh_mcp.services.one_location_agent_service import database_error_detail

    with caplog.at_level(logging.ERROR, logger="hushh_mcp.services.one_location_agent_service"):
        database_error_detail(_make_db_error(SENTINEL))

    assert "one_location.database_error" in caplog.text
    assert "one_location_recipients" in caplog.text


# ---------------------------------------------------------------------------
# Route-level: _handle_error
# ---------------------------------------------------------------------------


def test_handle_error_does_not_leak_bound_parameters() -> None:
    """_handle_error is the single funnel for every /api/one/location/* handler."""
    from api.routes.one.location import _handle_error

    http_exc = _handle_error(_make_db_error(SENTINEL))

    assert http_exc.status_code == 500
    assert SENTINEL not in str(http_exc.detail)
    assert http_exc.detail.get("code") == "DATABASE_EXECUTION_ERROR"


def test_handle_error_preserves_unavailable_status() -> None:
    from api.routes.one.location import _handle_error

    http_exc = _handle_error(_make_db_error(SENTINEL, status_code=503))

    assert http_exc.status_code == 503
    assert SENTINEL not in str(http_exc.detail)


# ---------------------------------------------------------------------------
# HTTP proof: TestClient sentinel-injection
# ---------------------------------------------------------------------------


def test_http_location_state_db_error_does_not_leak_parameters(client) -> None:
    """
    GET /api/one/location/state with a failing DB layer must not return the
    SQL statement or its bound values in the HTTP response body.

    Attach point: get_location_state -> _service().list_state ->
    DatabaseExecutionError -> _handle_error -> database_error_detail.
    """
    mock_svc = MagicMock()
    mock_svc.list_state.side_effect = _make_db_error(SENTINEL, status_code=503)

    with patch("api.routes.one.location._service", return_value=mock_svc):
        resp = client.get("/api/one/location/state")

    assert resp.status_code == 503
    body = resp.text
    assert SENTINEL not in body, f"bound parameter leaked into HTTP response: {body}"
    assert "[parameters:" not in body
    assert "[SQL:" not in body
    assert resp.json().get("detail", {}).get("code") == "DATABASE_UNAVAILABLE"
