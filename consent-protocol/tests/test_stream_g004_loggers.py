"""
HTTP proof tests for G004 logger fixes in kai/stream.py.

Canonical attach points
-----------------------
api.routes.kai.stream.stream_analyze -> GET /kai/analyze/stream

Ten logger calls used f-string interpolation (ruff G004).  They are now
converted to %-style lazy formatting so ruff passes clean.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.kai.stream as stream_mod
from api.middleware import require_vault_owner_token

VALID_UID = "test-uid"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(stream_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": VALID_UID,
        "token": "fake-token",
        "scope": "vault.owner",
    }
    return TestClient(app, raise_server_exceptions=False)


def test_analyze_stream_endpoint_reachable(client: TestClient) -> None:
    """GET /analyze/stream must reach the handler (not 404/405)."""
    resp = client.get("/analyze/stream?ticker=AAPL&user_id=" + VALID_UID)
    # Handler may fail due to missing DB/LLM; we only assert the route resolves.
    assert resp.status_code in {200, 400, 401, 403, 422, 500, 503}


def test_no_f_string_loggers_in_module() -> None:
    """Static check: no logger calls use f-strings in stream.py."""
    import ast
    import pathlib

    src = pathlib.Path(stream_mod.__file__).read_text()
    tree = ast.parse(src)

    f_string_loggers: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (
            isinstance(func, ast.Attribute)
            and func.attr in {"warning", "error", "info", "debug", "exception"}
        ):
            continue
        for arg in node.args:
            if isinstance(arg, ast.JoinedStr):
                f_string_loggers.append(node.lineno)

    assert f_string_loggers == [], f"G004: f-string logger calls found at lines {f_string_loggers}"
