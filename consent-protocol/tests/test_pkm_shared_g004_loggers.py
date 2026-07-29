"""
HTTP proof tests for G004 logger fixes in pkm_routes_shared.

Three logger calls used f-string interpolation (ruff G004).  They are now
converted to %-style lazy formatting so ruff passes clean and the logger
short-circuits the string build when the level is suppressed.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.pkm_routes_shared as pkm_mod
from api.middleware import require_vault_owner_token

VALID_UID = "test-uid"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(pkm_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": VALID_UID,
        "token": "fake-token",
        "scope": "vault.owner",
    }
    return TestClient(app, raise_server_exceptions=False)


def test_metadata_endpoint_reachable(client: TestClient) -> None:
    """GET /api/pkm/metadata/{user_id} must reach the handler (not 404/405)."""
    resp = client.get(f"/api/pkm/metadata/{VALID_UID}")
    # Handler may fail due to missing DB; we only assert the route resolves.
    assert resp.status_code in {200, 500, 503}


def test_metadata_endpoint_wrong_user_is_403(client: TestClient) -> None:
    """Token user_id mismatch must produce 403."""
    resp = client.get("/api/pkm/metadata/other-uid")
    assert resp.status_code == 403


def test_no_f_string_loggers_in_module() -> None:
    """Static check: none of the three fixed logger calls use f-strings."""
    import ast
    import pathlib

    src = pathlib.Path(pkm_mod.__file__).read_text()
    tree = ast.parse(src)

    f_string_loggers: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr in {"warning", "error", "info"}):
            continue
        # Check if any argument is a JoinedStr (f-string)
        for arg in node.args:
            if isinstance(arg, ast.JoinedStr):
                f_string_loggers.append(node.lineno)

    assert f_string_loggers == [], (
        f"G004: f-string logger calls found at lines {f_string_loggers}"
    )
