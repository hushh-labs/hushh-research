"""
HTTP proof tests for G004 logger fixes in hushh_mcp/services/kai_chat_service.py.

Canonical attach points
-----------------------
hushh_mcp.services.kai_chat_service.KaiChatService.process_message        -> POST /kai/chat
hushh_mcp.services.kai_chat_service.KaiChatService.get_initial_chat_state -> GET /kai/chat/initial-state/{user_id}
hushh_mcp.services.kai_chat_service.KaiChatService.analyze_portfolio_loser -> POST /kai/chat/analyze-loser

Six logger calls used f-string interpolation (ruff G004).  They are now
converted to %-style lazy formatting so ruff passes clean.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.kai.chat as chat_mod
from api.middleware import require_vault_owner_token

VALID_UID = "test-uid"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(chat_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": VALID_UID,
        "token": "fake-token",
        "scope": "vault.owner",
    }
    return TestClient(app, raise_server_exceptions=False)


def test_chat_endpoint_reachable(client: TestClient) -> None:
    """POST /chat must reach the handler (not 404/405)."""
    resp = client.post(
        "/chat",
        json={"user_id": VALID_UID, "message": "Hello Kai"},
    )
    assert resp.status_code in {200, 400, 422, 500, 503}


def test_initial_state_endpoint_reachable(client: TestClient) -> None:
    """GET /chat/initial-state/{user_id} must reach the handler."""
    resp = client.get(f"/chat/initial-state/{VALID_UID}")
    assert resp.status_code in {200, 400, 422, 500, 503}


def test_no_f_string_loggers_in_service() -> None:
    """Static check: no logger calls use f-strings in kai_chat_service.py."""
    import ast
    import pathlib

    import hushh_mcp.services.kai_chat_service as svc_mod

    src = pathlib.Path(svc_mod.__file__).read_text()
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

    assert f_string_loggers == [], (
        f"G004: f-string logger calls found at lines {f_string_loggers}"
    )
