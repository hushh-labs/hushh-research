"""
HTTP proof tests for G004 logger fixes in api/routes/agents.py.

Canonical attach points
-----------------------
api.routes.agents.validate_token_endpoint -> POST /api/validate-token
api.routes.agents.kai_chat                -> POST /api/agents/kai/chat

Three logger calls used f-string interpolation (ruff G004).  They are now
converted to %-style lazy formatting so ruff passes clean.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.agents as agents_mod


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(agents_mod.router)
    return TestClient(app, raise_server_exceptions=False)


def test_validate_token_endpoint_reachable(client: TestClient) -> None:
    """POST /api/validate-token must reach the handler (not 404/405)."""
    resp = client.post("/validate-token", json={"token": "invalid-token"})
    # Handler returns a JSON dict (no HTTPException), so 200 even for invalid tokens.
    assert resp.status_code == 200
    assert "valid" in resp.json()


def test_validate_token_returns_false_for_bad_token(client: TestClient) -> None:
    resp = client.post("/validate-token", json={"token": "bad"})
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("valid") is False


def test_no_f_string_loggers_in_module() -> None:
    """Static check: none of the fixed logger calls use f-strings."""
    import ast
    import pathlib

    src = pathlib.Path(agents_mod.__file__).read_text()
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
