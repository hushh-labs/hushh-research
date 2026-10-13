"""Shared A2A delegation consent helpers."""

from __future__ import annotations

from dataclasses import dataclass

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope

SPECIALIST_A2A_SCOPE_MAP: dict[str, ConsentScope] = {
    "agent_one": ConsentScope.AGENT_ONE_ORCHESTRATE,
    "agent_kai": ConsentScope.AGENT_KAI_ANALYZE,
    "agent_nav": ConsentScope.AGENT_NAV_REVIEW,
    "agent_kyc": ConsentScope.AGENT_KYC_PROCESS,
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
    """Validate an A2A consent token against the specialist-specific scope."""
    required_scope = get_a2a_required_scope(agent_id)
    valid, reason, payload = validate_token(consent_token, required_scope)
    return A2AConsentValidation(
        ok=bool(valid and payload),
        reason=reason,
        user_id=payload.user_id if payload else None,
        required_scope=required_scope,
    )
