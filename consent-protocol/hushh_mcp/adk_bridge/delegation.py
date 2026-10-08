"""Shared A2A delegation consent helpers."""

from __future__ import annotations

from dataclasses import dataclass

from hushh_mcp.consent.token import validate_token, validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.types import HushhConsentToken


async def validate_first_party_owner_token(
    user_id: str, consent_token: str
) -> HushhConsentToken | None:
    """Validate exact self-owner authority, without the generic DB outage grace.

    This is an ingress prerequisite for scoped first-party invocation, not an
    information export or action confirmation. Never emit credential diagnostics.
    """
    if not isinstance(user_id, str) or not user_id.strip():
        return None
    if not isinstance(consent_token, str) or not consent_token:
        return None
    try:
        valid, _reason, payload = validate_token(
            consent_token, ConsentScope.VAULT_OWNER, require_commercial=False
        )
        if (
            not valid
            or payload is None
            or payload.user_id != user_id
            or payload.agent_id != "self"
            or payload.scope != ConsentScope.VAULT_OWNER
            or payload.scope_str != ConsentScope.VAULT_OWNER.value
            or payload.commercial is not False
        ):
            return None
        from hushh_mcp.services.consent_db import ConsentDBService

        active = await ConsentDBService().is_token_active(
            user_id, ConsentScope.VAULT_OWNER.value, "self", token_id=consent_token
        )
        return payload if active is True else None
    except Exception:
        # Missing grants, backend failures and malformed validation results must
        # never authorize a new delegation. Cancellation still propagates.
        return None


SPECIALIST_A2A_SCOPE_MAP: dict[str, ConsentScope] = {
    "agent_one": ConsentScope.CAP_ONE_INVOKE,
    "agent_kai": ConsentScope.AGENT_KAI_ANALYZE,
    "agent_nav": ConsentScope.AGENT_NAV_REVIEW,
    "agent_kyc": ConsentScope.AGENT_KYC_PROCESS,
    "agent_personal_information": ConsentScope.CAP_PKM_MARKETPLACE_VIEW,
}


@dataclass(frozen=True)
class A2AConsentValidation:
    ok: bool
    reason: str
    user_id: str | None
    required_scope: ConsentScope


def get_a2a_required_scope(agent_id: str) -> ConsentScope:
    """Return the least-privilege consent scope required by an A2A specialist."""
    try:
        return SPECIALIST_A2A_SCOPE_MAP[agent_id]
    except KeyError as exc:
        raise ValueError(f"Unknown A2A specialist: {agent_id!r}") from exc


def validate_a2a_consent_token(agent_id: str, consent_token: str) -> A2AConsentValidation:
    """Validate an A2A consent token against the specialist-specific scope.

    In-memory validation only (signature, expiry, scope, local revocation
    cache). Prefer ``validate_a2a_consent_token_with_db`` at specialist entry
    boundaries so revocations issued on other instances are honored.
    """
    required_scope = get_a2a_required_scope(agent_id)
    valid, reason, payload = validate_token(consent_token, required_scope)
    return A2AConsentValidation(
        ok=bool(valid and payload),
        reason=reason,
        user_id=payload.user_id if payload else None,
        required_scope=required_scope,
    )


async def validate_a2a_consent_token_with_db(
    agent_id: str, consent_token: str
) -> A2AConsentValidation:
    """Validate an A2A consent token with a DB-backed revocation check.

    Catches tokens revoked on other Cloud Run instances (the in-memory
    revocation cache is per-process). Fail policy follows
    ``validate_token_with_db``: scoped tokens fail closed when revocation
    status cannot be confirmed.
    """
    required_scope = get_a2a_required_scope(agent_id)
    from hushh_mcp.runtime_settings import pod_mode

    if pod_mode():
        from hushh_mcp.services.pod_consent_client import require_owner_scope

        try:
            verdict = await require_owner_scope(consent_token, expected_scope=required_scope.value)
        except PermissionError:
            return A2AConsentValidation(False, "consent denied", None, required_scope)
        return A2AConsentValidation(True, "verified by hub", verdict.user_id, required_scope)
    valid, reason, payload = await validate_token_with_db(consent_token, required_scope)
    return A2AConsentValidation(
        ok=bool(valid and payload),
        reason=reason,
        user_id=payload.user_id if payload else None,
        required_scope=required_scope,
    )
