"""Terms and Privacy acceptance: route contract and migration governance.

The real-database replay lives in test_account_legal_acceptance_postgres.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_firebase_auth_read_only
from api.routes import account
from hushh_mcp.services import legal_acceptance_service

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "255_account_legal_acceptances.sql"
ROLLBACK = "255_account_legal_acceptances.rollback.sql"
TABLE = "account_legal_acceptances"

TERMS = {"document_id": "terms", "document_version": "2.0", "effective_date": "2026-09-27"}
PRIVACY = {"document_id": "privacy", "document_version": "2.0", "effective_date": "2026-09-27"}


def _client(monkeypatch, calls: list[dict[str, Any]]) -> TestClient:
    async def _record(**kwargs: Any) -> list[dict[str, Any]]:
        calls.append(kwargs)
        return [{"document_id": "terms", "surface": kwargs["surface"]}]

    async def _latest(**kwargs: Any) -> list[dict[str, Any]]:
        calls.append(kwargs)
        return []

    monkeypatch.setattr(legal_acceptance_service, "record_acceptances", _record)
    monkeypatch.setattr(legal_acceptance_service, "list_latest_acceptances", _latest)
    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "uid_from_token"
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "uid_from_token"
    return TestClient(app)


def test_legal_acceptance_requires_a_verified_firebase_session() -> None:
    app = FastAPI()
    app.include_router(account.router)
    client = TestClient(app)

    assert client.get("/api/account/legal-acceptance").status_code == 401
    response = client.post(
        "/api/account/legal-acceptance",
        json={"documents": [TERMS, PRIVACY], "surface": "web"},
    )
    assert response.status_code == 401


def test_acceptance_is_recorded_for_the_token_owner_only(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []
    client = _client(monkeypatch, calls)

    response = client.post(
        "/api/account/legal-acceptance",
        json={"documents": [TERMS, PRIVACY], "surface": "native"},
    )
    assert response.status_code == 200
    assert calls[0]["user_id"] == "uid_from_token"
    assert calls[0]["surface"] == "native"
    assert [doc.document_id for doc in calls[0]["documents"]] == ["terms", "privacy"]

    assert client.get("/api/account/legal-acceptance").json() == {"acceptances": []}
    assert calls[1] == {"user_id": "uid_from_token"}


@pytest.mark.parametrize(
    "body",
    [
        # The account comes from the token; a body can never name one.
        {"documents": [TERMS, PRIVACY], "surface": "web", "user_id": "someone_else"},
        # Both agreements are accepted together, each exactly once.
        {"documents": [TERMS], "surface": "web"},
        {"documents": [TERMS, TERMS], "surface": "web"},
        {"documents": [TERMS, {**PRIVACY, "document_id": "cookies"}], "surface": "web"},
        {"documents": [TERMS, PRIVACY], "surface": "desktop"},
        {"documents": [TERMS, {**PRIVACY, "document_version": "<script>"}], "surface": "web"},
        {"documents": [TERMS, {**PRIVACY, "effective_date": "x" * 65}], "surface": "web"},
    ],
)
def test_malformed_acceptance_is_rejected_before_storage(monkeypatch, body) -> None:
    calls: list[dict[str, Any]] = []
    client = _client(monkeypatch, calls)

    assert client.post("/api/account/legal-acceptance", json=body).status_code == 422
    assert calls == []


def test_migration_is_release_governed_replay_safe_and_self_guarded() -> None:
    migration = (ROOT / "db/migrations" / MIGRATION).read_text()
    rollback = (ROOT / "db/migrations/rollback" / ROLLBACK).read_text()
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())

    assert f"CREATE TABLE IF NOT EXISTS {TABLE}" in migration
    assert "ON DELETE" not in migration  # acceptance precedes the actor profile
    assert "install_account_deletion_write_guards" in migration
    assert f"migration_255_rollback_refused_nonempty_table:{TABLE}" in rollback
    assert MIGRATION in manifest["ordered_migrations"]
    assert MIGRATION in manifest["groups"]["iam"]
    assert manifest["rollback_migrations"][MIGRATION] == f"rollback/{ROLLBACK}"

    for name in ("prod_core_schema.json", "uat_integrated_schema.json"):
        contract = json.loads((ROOT / "db/contracts" / name).read_text())
        assert contract["expected_migration_version"] >= 255
        assert TABLE in contract["required_tables"]
