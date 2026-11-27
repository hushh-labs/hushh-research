from __future__ import annotations

import pytest
from fastapi import BackgroundTasks

from api.routes import pkm


@pytest.mark.asyncio
async def test_pkm_metadata_access_passes_vault_token_without_header_sentinel(monkeypatch):
    captured: dict[str, str | None] = {}

    async def _fake_require_vault_owner_token(
        *,
        authorization: str | None = None,
        hushh_consent: str | None = None,
    ) -> dict:
        captured["authorization"] = authorization
        captured["hushh_consent"] = hushh_consent
        return {"user_id": "user-123"}

    monkeypatch.setattr(pkm, "require_vault_owner_token", _fake_require_vault_owner_token)

    token_data = await pkm.require_pkm_metadata_access(
        BackgroundTasks(),
        "Bearer HCT:test-token",
    )

    assert captured == {
        "authorization": "Bearer HCT:test-token",
        "hushh_consent": None,
    }
    assert token_data == {"user_id": "user-123", "auth_type": "vault_owner"}


@pytest.mark.asyncio
async def test_pkm_metadata_access_passes_firebase_token_with_background_tasks(monkeypatch):
    captured: dict[str, object] = {}

    async def _fake_require_firebase_auth(
        *,
        background_tasks: BackgroundTasks,
        authorization: str | None = None,
    ) -> str:
        captured["background_tasks"] = background_tasks
        captured["authorization"] = authorization
        return "firebase-user-123"

    monkeypatch.setattr(pkm, "require_firebase_auth", _fake_require_firebase_auth)

    background_tasks = BackgroundTasks()
    token_data = await pkm.require_pkm_metadata_access(
        background_tasks,
        "Bearer firebase-token",
    )

    assert captured == {
        "background_tasks": background_tasks,
        "authorization": "Bearer firebase-token",
    }
    assert token_data == {"user_id": "firebase-user-123", "auth_type": "firebase"}


@pytest.mark.asyncio
async def test_missing_index_preserves_manifest_visibility_without_copying_card_summary(
    monkeypatch,
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    from api.routes import pkm_routes_shared

    service = Mock()
    service.resolve_metadata_index = AsyncMock(return_value=None)
    service.get_domain_manifests = AsyncMock(return_value={})
    service.get_user_metadata = AsyncMock(return_value=None)
    service.get_encrypted_data = AsyncMock(return_value=None)
    query = service.db.table.return_value.select.return_value.eq.return_value
    query.execute.return_value.data = [{"domain": "wallet"}, {"domain": "travel"}]
    service.get_domain_manifest = AsyncMock(
        side_effect=[
            {
                "path_count": 3,
                "summary_projection": {
                    "consumer_visible": False,
                    "internal_only": False,
                    "cards": ["private fixture"],
                },
            },
            {"path_count": 1},
        ]
    )
    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: service)
    upgrade = SimpleNamespace(build_status=AsyncMock(return_value={}))
    monkeypatch.setattr(pkm_routes_shared, "get_pkm_upgrade_service", lambda: upgrade)

    result = await pkm.get_metadata("test-owner", {"user_id": "test-owner"})
    wallet, travel = result.domains
    assert wallet.summary["consumer_visible"] is False
    assert wallet.summary["internal_only"] is False
    assert "cards" not in wallet.summary
    assert "consumer_visible" not in travel.summary
    assert wallet.attribute_count == 3
