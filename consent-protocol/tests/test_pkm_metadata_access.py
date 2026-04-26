from __future__ import annotations

import pytest

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

    token_data = await pkm.require_pkm_metadata_access("Bearer HCT:test-token")

    assert captured == {
        "authorization": "Bearer HCT:test-token",
        "hushh_consent": None,
    }
    assert token_data == {"user_id": "user-123", "auth_type": "vault_owner"}
