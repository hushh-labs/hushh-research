"""
HTTP proof tests for G004 logger fixes in api/routes/db_proxy.py.

Five logger calls used f-string interpolation (ruff G004).  They are now
converted to %-style lazy formatting so ruff passes clean.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.db_proxy as db_proxy_mod
from api.middleware import require_firebase_auth

VALID_UID = "test-uid"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(db_proxy_mod.router)
    app.dependency_overrides[require_firebase_auth] = lambda: VALID_UID
    return TestClient(app, raise_server_exceptions=False)


def test_vault_check_endpoint_reachable(client: TestClient) -> None:
    """POST /db/vault/check must reach the handler (not 404/405)."""
    resp = client.post("/db/vault/check", json={"userId": VALID_UID})
    # May fail due to missing DB; we only assert the route resolves.
    assert resp.status_code in {200, 400, 422, 500, 503}


def test_vault_status_endpoint_reachable(client: TestClient) -> None:
    """POST /db/vault/status must reach the handler (not 404/405)."""
    resp = client.post(
        "/db/vault/status",
        json={"userId": VALID_UID, "consentToken": "fake-token"},
    )
    assert resp.status_code in {200, 400, 401, 403, 422, 500, 503}


def test_no_f_string_loggers_in_module() -> None:
    """Static check: none of the fixed logger calls use f-strings."""
    import ast
    import pathlib

    src = pathlib.Path(db_proxy_mod.__file__).read_text()
    tree = ast.parse(src)

    f_string_loggers: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr in {"warning", "error", "info", "debug"}):
            continue
        for arg in node.args:
            if isinstance(arg, ast.JoinedStr):
                f_string_loggers.append(node.lineno)

    assert f_string_loggers == [], (
        f"G004: f-string logger calls found at lines {f_string_loggers}"
    )
