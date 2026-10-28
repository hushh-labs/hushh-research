"""Picks is an advisor-only surface: the routes serve verified RIAs and refuse everyone else."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import ria
from hushh_mcp.services.ria_iam_service import RIAIAMPolicyError, RIAIAMService


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(ria.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user_test_123"
    return app


def test_ria_picks_returns_only_active_package(monkeypatch):
    async def _allow_verified(self, user_id: str):
        assert user_id == "user_test_123"

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _allow_verified)
    async def _mock_get(self, user_id: str):
        assert user_id == "user_test_123"
        return {
            "package": {
                "top_picks": [{"ticker": "NVDA", "tier": "ACE"}],
                "avoid_rows": [],
                "screening_sections": [
                    {"section": "investable_requirements", "rows": []},
                    {"section": "automatic_avoid_triggers", "rows": []},
                    {"section": "the_math", "rows": []},
                ],
                "package_note": None,
            },
            "metadata": {
                "has_package": True,
                "storage_source": "pkm",
                "package_revision": 0,
                "top_pick_count": 1,
                "avoid_count": 0,
                "screening_row_count": 0,
                "active_share_count": 1,
            },
        }

    monkeypatch.setattr(RIAIAMService, "get_active_ria_pick_package", _mock_get)

    client = TestClient(_build_app())
    response = client.get("/api/ria/picks")

    assert response.status_code == 200
    payload = response.json()
    assert list(payload.keys()) == ["package", "metadata"]
    assert payload["package"]["top_picks"][0]["ticker"] == "NVDA"
    assert payload["metadata"]["storage_source"] == "pkm"


def test_ria_picks_post_syncs_share_artifacts(monkeypatch):
    async def _allow_verified(self, user_id: str):
        assert user_id == "user_test_123"

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _allow_verified)
    async def _mock_sync(self, user_id: str, **kwargs):  # noqa: ANN003
        assert user_id == "user_test_123"
        assert kwargs["source_data_version"] == 7
        assert kwargs["investor_debate_thesis"] == "Pressure-test concentration risk."
        return {
            "status": "synced",
            "share_artifacts_updated": 2,
            "package": {
                "top_picks": [{"ticker": "NVDA", "tier": "ACE"}],
                "avoid_rows": [],
                "screening_sections": [],
                "package_note": None,
            },
        }

    monkeypatch.setattr(RIAIAMService, "sync_ria_pick_share_artifacts", _mock_sync)

    client = TestClient(_build_app())
    response = client.post(
        "/api/ria/picks",
        json={
            "top_picks": [{"ticker": "NVDA", "tier": "ACE"}],
            "avoid_rows": [],
            "screening_sections": [],
            "source_data_version": 7,
            "investor_debate_thesis": "Pressure-test concentration risk.",
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "synced"


def test_ria_picks_parse_requires_csv(monkeypatch):
    async def _allow_verified(self, user_id: str):
        assert user_id == "user_test_123"

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _allow_verified)
    async def _mock_parse(self, **kwargs):  # noqa: ANN003
        raise AssertionError("parse_ria_pick_csv should not be called when csv_content is missing")

    monkeypatch.setattr(RIAIAMService, "parse_ria_pick_csv", _mock_parse)

    client = TestClient(_build_app())
    response = client.post("/api/ria/picks/parse", json={})

    assert response.status_code == 422

@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/api/ria/picks", None),
        ("POST", "/api/ria/picks", {"top_picks": []}),
        ("POST", "/api/ria/picks/parse", {"csv_content": "ticker\nNVDA"}),
    ],
)
def test_ria_picks_refuses_people_who_are_not_verified_rias(monkeypatch, method, path, body):
    async def _refuse(self, user_id: str):
        raise RIAIAMPolicyError("RIA verification incomplete", status_code=403)

    async def _never(self, *args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("Picks service must not run for an unverified caller")

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _refuse)
    monkeypatch.setattr(RIAIAMService, "get_active_ria_pick_package", _never)
    monkeypatch.setattr(RIAIAMService, "sync_ria_pick_share_artifacts", _never)
    monkeypatch.setattr(RIAIAMService, "parse_ria_pick_csv", _never)

    client = TestClient(_build_app())
    response = client.request(method, path, json=body)

    assert response.status_code == 403

