"""Scope access-token revocation helper preserving owner vault custody."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)


def is_owner_session_token(token: dict[str, Any]) -> bool:
    """Return True for owner or trusted-device custody tokens excluded from scope revocations."""
    granted_scope = str(token.get("scope") or "").strip()
    agent_id = str(token.get("agent_id") or "").strip()
    return granted_scope == "vault.owner" or agent_id == "self" or agent_id.startswith("device:")


async def revoke_scope_access_tokens(
    *,
    user_id: str,
    disabled_scopes: list[str],
    scope_matches_fn: Callable[[str, str], bool],
) -> list[str]:
    """Revoke external and non-owner internal grants overlapping disabled PKM scopes."""
    if not disabled_scopes:
        return []

    try:
        from hushh_mcp.consent.token import revoke_token
        from hushh_mcp.services.consent_db import ConsentDBService

        consent_service = ConsentDBService()
        external_tokens = await consent_service.get_active_tokens(user_id)
        internal_tokens = await consent_service.get_active_internal_tokens(user_id)
        revoked_ids: list[str] = []
        seen_token_ids: set[str] = set()

        tagged_tokens = [
            *((token, False) for token in external_tokens),
            *((token, True) for token in internal_tokens),
        ]
        for token, is_internal in tagged_tokens:
            if is_owner_session_token(token):
                continue
            granted_scope = str(token.get("scope") or "").strip()
            token_id = str(token.get("token_id") or "").strip()
            if not granted_scope or not token_id or token_id in seen_token_ids:
                continue
            overlaps = any(
                scope_matches_fn(granted_scope, disabled_scope)
                or scope_matches_fn(disabled_scope, granted_scope)
                for disabled_scope in disabled_scopes
            )
            if not overlaps:
                continue

            seen_token_ids.add(token_id)
            if not token_id.startswith("REVOKED_"):
                revoke_token(token_id)
            await consent_service.delete_consent_export(token_id)

            event_token_id = f"REVOKED_SCOPE_{int(time.time() * 1000)}_{len(revoked_ids)}"
            agent_id = token.get("agent_id") or token.get("developer") or "Unknown"
            request_id = token.get("request_id")
            record_event = (
                consent_service.insert_internal_event
                if is_internal
                else consent_service.insert_event
            )
            await record_event(
                user_id=user_id,
                agent_id=agent_id,
                scope=granted_scope,
                action="REVOKED",
                token_id=event_token_id,
                request_id=request_id,
                metadata={
                    "revoked_by": "pkm_scope_exposure",
                    "disabled_scopes": disabled_scopes,
                },
            )
            revoked_ids.append(token_id)

        return revoked_ids
    except Exception as exc:
        logger.warning(
            "Failed to revoke overlapping scope grants for user=%s scopes=%s: %s",
            user_id,
            disabled_scopes,
            exc,
        )
        return []
