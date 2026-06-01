"""
HTTP proof tests for G004 logger fix in kai/portfolio.py.

Canonical attach point
----------------------
api.routes.kai.portfolio.import_portfolio -> POST /kai/portfolio/import

One logger call used f-string interpolation (ruff G004).  It is now
converted to %-style lazy formatting so ruff passes clean.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.kai.portfolio as portfolio_mod
from api.middleware import require_vault_owner_token

VALID_UID = "test-uid"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(portfolio_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": VALID_UID,
        "token": "fake-token",
        "scope": "vault.owner",
    }
    return TestClient(app, raise_server_exceptions=False)


def test_import_portfolio_endpoint_reachable(client: TestClient) -> None:
    """POST /portfolio/import must reach the handler (not 404/405)."""
    import io

    resp = client.post(
        "/portfolio/import",
        data={"user_id": VALID_UID},
        files={"file": ("test.csv", io.BytesIO(b"ticker,shares\nAAPL,10"), "text/csv")},
    )
    # Handler may fail due to missing services; we only assert the route resolves.
    assert resp.status_code in {200, 400, 422, 500, 503}


def test_import_portfolio_user_id_mismatch_returns_403(client: TestClient) -> None:
    """Token/user_id mismatch in import_portfolio must return 403."""
    import io

    resp = client.post(
        "/portfolio/import",
        data={"user_id": "other-uid"},
        files={"file": ("test.csv", io.BytesIO(b"ticker,shares\nAAPL,10"), "text/csv")},
    )
    assert resp.status_code == 403


def test_no_f_string_loggers_in_module() -> None:
    """Static check: no logger calls use f-strings in portfolio.py."""
    import ast
    import pathlib

    src = pathlib.Path(portfolio_mod.__file__).read_text()
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
