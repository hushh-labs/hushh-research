# tests/test_chat_analyze_loser_cwe209.py
"""
PR attach point: POST /chat/analyze-loser  (api/routes/kai/chat.py)

CWE-209: verify that 500 responses return opaque error messages instead
of raw exception text (f"Analysis failed: {str(e)}").
Also verifies the G004 logger fix in the same handler.
"""

import ast
import pathlib
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token

_UID = "test-uid"
_TOKEN = {"user_id": _UID, "token": "fake-token", "scope": "vault.owner"}

_INTERNAL_MSG = "SSL connection refused: postgresql://secret-host/hushh_prod"


@pytest.fixture()
def client():
    from api.main import app

    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def test_analyze_loser_500_opaque(client: TestClient) -> None:
    """Internal exception text must not appear in the 500 response detail."""
    mock_service = MagicMock()
    mock_service.analyze_portfolio_loser = AsyncMock(
        side_effect=RuntimeError(_INTERNAL_MSG)
    )

    with patch("api.routes.kai.chat.get_kai_chat_service", return_value=mock_service):
        resp = client.post(
            "/api/kai/chat/analyze-loser",
            json={"user_id": _UID, "symbol": "AAPL"},
        )

    assert resp.status_code == 500
    body = resp.json()
    assert _INTERNAL_MSG not in body.get("detail", ""), (
        "CWE-209: internal error leaked from POST /chat/analyze-loser"
    )
    assert body["detail"] == "Analysis failed"


def test_no_f_string_loggers_in_analyze_loser() -> None:
    """The analyze-loser handler must have no G004 f-string logger calls."""
    import api.routes.kai.chat as module

    src = pathlib.Path(module.__file__).read_text()
    tree = ast.parse(src)
    bad_lines: list[int] = []
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
                bad_lines.append(node.lineno)
    assert bad_lines == [], f"G004: f-string logger calls at lines {bad_lines}"
