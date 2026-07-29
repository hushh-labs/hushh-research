"""
HTTP proof tests for G004 logger fixes in kai/losers.py.

Five logger calls used f-string interpolation (ruff G004).  They are now
converted to %-style lazy formatting so ruff passes clean.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.kai.losers as losers_mod
from api.middleware import require_vault_owner_token
from api.routes.kai import router as kai_router

VALID_UID = "test-uid"


@pytest.fixture(scope="module")
def client() -> TestClient:
    # kai_router is the exact object server.py mounts via
    # app.include_router(kai_router); it carries the /api/kai prefix that
    # losers_mod.router alone does not, so hitting it here proves the route
    # is reachable on the canonical production path.
    app = FastAPI()
    app.include_router(kai_router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": VALID_UID,
        "token": "fake-token",
        "scope": "vault.owner",
    }
    return TestClient(app, raise_server_exceptions=False)


def test_analyze_losers_endpoint_reachable(client: TestClient) -> None:
    """POST /api/kai/portfolio/analyze-losers must reach the handler (not 404/405)."""
    payload = {
        "user_id": VALID_UID,
        "holdings": [],
    }
    resp = client.post("/api/kai/portfolio/analyze-losers", json=payload)
    # Handler may fail due to missing LLM/DB; we only assert the route resolves.
    assert resp.status_code in {200, 400, 422, 500, 503}


def test_no_f_string_loggers_in_module() -> None:
    """Static check: none of the fixed logger calls use f-strings."""
    import ast
    import pathlib

    src = pathlib.Path(losers_mod.__file__).read_text()
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
