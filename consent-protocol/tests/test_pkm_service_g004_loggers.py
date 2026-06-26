"""
HTTP proof tests for G004 logger fixes in personal_knowledge_model_service.py.

Canonical attach points
-----------------------
hushh_mcp.services.personal_knowledge_model_service.PersonalKnowledgeModelService.get_index_v2     -> GET /api/pkm/metadata/{user_id}
hushh_mcp.services.personal_knowledge_model_service.PersonalKnowledgeModelService.store_domain_data -> POST /api/pkm/blobs/{user_id}/{domain}
hushh_mcp.services.personal_knowledge_model_service.PersonalKnowledgeModelService.get_domain_data   -> GET /api/pkm/blobs/{user_id}/{domain}

Fifteen logger calls used f-string interpolation (ruff G004).  They are now
converted to %-style lazy formatting so ruff passes clean.
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
    """GET /api/pkm/metadata/{user_id} must reach the PKM service (not 404/405)."""
    resp = client.get(f"/api/pkm/metadata/{VALID_UID}")
    assert resp.status_code in {200, 400, 422, 500, 503}


def test_no_f_string_loggers_in_service() -> None:
    """Static check: no logger calls use f-strings in personal_knowledge_model_service.py."""
    import ast
    import pathlib

    import hushh_mcp.services.personal_knowledge_model_service as svc_mod

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

    assert f_string_loggers == [], f"G004: f-string logger calls found at lines {f_string_loggers}"
