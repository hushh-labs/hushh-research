"""Regression guard: PKM scope-exposure updates must never revoke VAULT_OWNER tokens."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hushh_mcp.services.personal_knowledge_model_service import PersonalKnowledgeModelService


@pytest.mark.asyncio
async def test_revoke_scope_access_tokens_preserves_vault_owner_and_device_tokens() -> None:
    """Turning a PKM scope private revokes external grants while preserving owner custody."""
    user_id = "uid_owner_scope_guard"
    owner_token = "HCT:owner_session_token"
    device_token = "HCT:trusted_device_token"
    external_token = "HCT:external_agent_token"

    fake_consent_db = MagicMock()
    fake_consent_db.get_active_tokens = AsyncMock(
        return_value=[
            {
                "token_id": external_token,
                "agent_id": "agent_advisor",
                "scope": "attr.professional.profile.*",
                "request_id": "req_1",
            },
            {
                "token_id": "HCT:unrelated_finance",
                "agent_id": "agent_kai",
                "scope": "attr.financial.holdings.*",
                "request_id": "req_2",
            },
        ]
    )
    fake_consent_db.get_active_internal_tokens = AsyncMock(
        return_value=[
            {
                "token_id": owner_token,
                "agent_id": "self",
                "scope": "vault.owner",
                "request_id": None,
            },
            {
                "token_id": device_token,
                "agent_id": "device:dev_abc123",
                "scope": "vault.owner",
                "request_id": None,
            },
        ]
    )
    fake_consent_db.delete_consent_export = AsyncMock()
    fake_consent_db.insert_event = AsyncMock()
    fake_consent_db.insert_internal_event = AsyncMock()

    revoked_calls: list[str] = []
    service = PersonalKnowledgeModelService.__new__(PersonalKnowledgeModelService)

    with (
        patch(
            "hushh_mcp.services.consent_db.ConsentDBService",
            return_value=fake_consent_db,
        ),
        patch(
            "hushh_mcp.consent.token.revoke_token",
            side_effect=lambda token_id: revoked_calls.append(token_id),
        ),
    ):
        revoked = await service._revoke_scope_access_tokens(
            user_id=user_id,
            disabled_scopes=["attr.professional.profile.*"],
        )

    assert revoked == [external_token]
    assert revoked_calls == [external_token]
    assert owner_token not in revoked
    assert device_token not in revoked
    fake_consent_db.delete_consent_export.assert_awaited_once_with(external_token)
    fake_consent_db.insert_event.assert_awaited_once()
