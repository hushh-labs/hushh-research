"""Canonical database admission for signed consent and owner-device tokens.

The existing token facade performs signature/scope/commercial verification
first. This adapter retains the exact lineage, revocation cache and outage
policies without turning temporary paid activation denial into revocation.
"""

from __future__ import annotations

import logging
from typing import Any

from hushh_mcp.constants import ConsentScope
from hushh_mcp.types import HushhConsentToken

logger = logging.getLogger("hushh_mcp.consent.token")


async def validate_database_admission(
    token_str: str,
    verdict: tuple[bool, str | None, HushhConsentToken | None],
    revocation_cache: Any,
) -> tuple[bool, str | None, HushhConsentToken | None]:
    from hushh_mcp.consent.token import _token_fingerprint

    valid, reason, token_obj = verdict
    agent_id = str(token_obj.agent_id) if token_obj is not None else ""
    is_device_bound_token = token_obj is not None and agent_id.startswith("device:")

    # Additional DB check for revocation status
    # This catches tokens revoked on other Cloud Run instances
    try:
        if token_obj:
            from hushh_mcp.services.consent_db import ConsentDBService

            service = ConsentDBService()
            # CRITICAL FIX: Use scope_str (actual scope) for DB lookup, not enum value!
            scope_for_lookup = token_obj.scope_str if token_obj.scope_str else token_obj.scope.value
            is_active = await service.is_token_active(
                str(token_obj.user_id),
                scope_for_lookup,
                str(token_obj.agent_id),
                token_id=token_str,
            )
            if not is_active:
                # Add to in-memory set for future fast checks
                # A paid staged token is temporarily inadmissible before T.
                # Do not poison its process cache permanently on an early read.
                if not scope_for_lookup.startswith("attr."):
                    revocation_cache.add(token_str)
                logger.warning(
                    "Token revoked in DB but not in memory (fingerprint=%s)",
                    _token_fingerprint(token_str),
                )
                return False, "Token has been revoked (DB check)", None
            if is_device_bound_token:
                device_id = agent_id.removeprefix("device:")
                if not device_id or not await service.is_trusted_device_active(
                    str(token_obj.user_id), device_id
                ):
                    revocation_cache.add(token_str)
                    logger.warning(
                        "Device-bound owner token rejected because device is inactive "
                        "(fingerprint=%s)",
                        _token_fingerprint(token_str),
                    )
                    return False, "TRUSTED_DEVICE_REVOKED", None
    except Exception as e:
        return _database_unavailable_verdict(token_obj, is_device_bound_token, verdict, e)

    return valid, reason, token_obj


def _database_unavailable_verdict(
    token_obj: HushhConsentToken | None,
    is_device_bound_token: bool,
    verdict: tuple[bool, str | None, HushhConsentToken | None],
    error: Exception,
) -> tuple[bool, str | None, HushhConsentToken | None]:
    valid, reason, token_obj = verdict
    # DB is unreachable — apply fail-closed policy based on token scope.
    # VAULT_OWNER tokens get a short grace period to avoid locking users
    # out of their own vault during brief DB hiccups.
    # All other scoped tokens fail closed immediately — when revocation
    # status cannot be confirmed, access to third-party data is denied.
    is_vault_owner = token_obj is not None and (
        token_obj.scope_str == "vault.owner" or token_obj.scope == ConsentScope.VAULT_OWNER
    )
    if is_device_bound_token:
        logger.error(
            "Device-bound owner revocation status could not be confirmed; failing closed: %s",
            error,
        )
        return (
            False,
            "TRUSTED_DEVICE_STATUS_UNCONFIRMED",
            None,
        )
    if is_vault_owner:
        logger.warning(
            "DB revocation check failed for VAULT_OWNER token, applying grace period fallback: %s",
            error,
        )
        return valid, reason, token_obj

    logger.error(
        "DB revocation check failed for scoped token, "
        "failing closed to protect consent integrity: %s",
        error,
    )
    return False, "Token revocation status could not be confirmed (DB unavailable)", None
