"""Standing pkm.read grant for a user's own personal-information agent.

When a user has their own always-on agent (their Private Cloud Compute
instance), that agent may hold a STANDING, renewable read over its OWN user's
PKM, so the user's own agent can serve them without a fresh per-turn consent
prompt for every read. This is the user's own agent reading the user's own data.

Two governance invariants make this safe, and this module preserves both:

  1. The grant is bound to ONE agent id (``PERSONAL_AGENT_ID``) and ONE user.
     Because HCT tokens bind ``(user_id, agent_id, scope)`` and every call site
     re-checks the agent id, a specialist (Kai, Nav, Location, ...) with a
     different agent id can never use this token. Specialists still receive
     only attenuated, per-hop authority (see ``adk_bridge.contract``), so this
     standing read never crosses the delegation boundary.

  2. It is Nav-governed and revocable. Unlike the vault-owner ``self`` token
     (which is logged to the internal ledger to keep session churn out of the
     consent feed), this grant is written to the VISIBLE consent ledger via
     ``insert_event``, so Nav narrates it in the Consent Center and the owner
     can revoke it through the normal revoke path.

``pkm.read`` grants read across the user's PKM domains but never writes and
never the vault master authority. The user's agent still reaches decrypted data
only through the consent/export path, wrapped to the agent's own key
(zero-knowledge); this module only mints the read authority, never plaintext.

SECURITY: this mint must only ever be reached from an owner-authorized
provisioning path (a vault-owner gate), and the whole surface is gated behind
the ``PERSONAL_AGENT_ENABLED`` kill-switch. The provisioning path is wired
(via ``api/routes/one/personal_agent.py``) but flag-gated: it is inert and the
route returns 404 until that flag is on.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional, Protocol

from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.runtime_settings import personal_agent_enabled

logger = logging.getLogger(__name__)

# Dedicated agent identity for a user's own personal agent's standing read.
# Distinct from "self" (vault-owner master), from "agent_one" (the external
# invocation identity), and from every specialist id, so the standing pkm.read
# is exclusive to the personal agent and can never be presented by a specialist.
PERSONAL_AGENT_ID = "personal_agent"

# Renewable, never infinite: mirrors the 24h vault-owner cadence. Provisioning
# re-mints before expiry.
DEFAULT_STANDING_READ_EXPIRY_MS = 24 * 60 * 60 * 1000


class PersonalAgentDisabledError(RuntimeError):
    """Raised when a standing read is requested while the feature is off."""


class _Ledger(Protocol):
    async def insert_event(
        self,
        *,
        user_id: str,
        agent_id: str,
        scope: str,
        action: str,
        token_id: Optional[str] = ...,
        request_id: Optional[str] = ...,
        scope_description: Optional[str] = ...,
        expires_at: Optional[int] = ...,
        poll_timeout_at: Optional[int] = ...,
        metadata: Optional[dict] = ...,
    ) -> int: ...


class PersonalAgentGrantService:
    """Mints (and logs) the standing pkm.read grant for a user's own agent."""

    async def issue_standing_pkm_read(
        self,
        user_id: str,
        *,
        pod_agent_id: str = PERSONAL_AGENT_ID,
        expires_in_ms: int = DEFAULT_STANDING_READ_EXPIRY_MS,
        ledger: Optional[_Ledger] = None,
    ) -> dict[str, Any]:
        """Issue the standing pkm.read grant and log it to the visible ledger.

        The caller MUST have already established owner authorization (vault-owner
        gate). Returns the token, its expiry, the bound agent id, and scope.
        Raises ``PersonalAgentDisabledError`` when the kill-switch is off.
        """
        if not personal_agent_enabled():
            raise PersonalAgentDisabledError(
                "personal-agent standing read requested while PERSONAL_AGENT_ENABLED is off"
            )
        if not user_id:
            raise ValueError("user_id is required")

        token_obj = issue_token(
            user_id=user_id,
            agent_id=pod_agent_id,
            scope=ConsentScope.PKM_READ,
            expires_in_ms=expires_in_ms,
        )

        if ledger is None:
            # Deferred import + instantiation so the module has no DB side effect
            # at import time and stays trivially testable with an injected ledger.
            from hushh_mcp.services.consent_db import ConsentDBService

            ledger = ConsentDBService()

        # Visible ledger (consent_audit), NOT the internal ledger: Nav must be
        # able to narrate this grant and the owner must be able to revoke it.
        await ledger.insert_event(
            user_id=user_id,
            agent_id=pod_agent_id,
            scope=ConsentScope.PKM_READ.value,
            action="CONSENT_GRANTED",
            token_id=token_obj.token,
            expires_at=token_obj.expires_at,
            scope_description="Personal agent standing read (Nav-governed)",
            metadata={"grant_kind": "personal_agent_standing_read"},
        )

        logger.info("personal_agent.standing_read_issued agent_id=%s", pod_agent_id)
        return {
            "token": token_obj.token,
            "expiresAt": token_obj.expires_at,
            "scope": ConsentScope.PKM_READ.value,
            "agentId": pod_agent_id,
        }

    async def revoke_standing_pkm_read(
        self,
        user_id: str,
        *,
        pod_agent_id: str = PERSONAL_AGENT_ID,
        ledger: Optional[_Ledger] = None,
    ) -> dict[str, Any]:
        """Revoke the standing pkm.read for a user's own agent (teardown/safety).

        Writes a ``REVOKED`` event to the VISIBLE consent ledger for
        ``(user, pkm.read, personal_agent)``. Because ``is_token_active`` keys off
        the LATEST grant/revoke event for that triple, this immediately
        fail-closes every standing read for the agent on the DB-backed validation
        path -- without needing to hold the original token string (which the
        registry deliberately never stores). Mirrors the ``/revoke`` route's
        REVOKED-event shape.

        Deliberately NOT gated on ``personal_agent_enabled``: revocation is always
        safe and must never be blocked (e.g. if the feature was turned off after a
        grant was live). Idempotent -- re-revoking just appends another marker.
        """
        if not user_id:
            raise ValueError("user_id is required")

        if ledger is None:
            from hushh_mcp.services.consent_db import ConsentDBService

            ledger = ConsentDBService()

        revoke_token_id = f"REVOKED_PERSONAL_AGENT_{int(time.time() * 1000)}"
        await ledger.insert_event(
            user_id=user_id,
            agent_id=pod_agent_id,
            scope=ConsentScope.PKM_READ.value,
            action="REVOKED",
            token_id=revoke_token_id,
            scope_description="Personal agent standing read revoked (teardown)",
            metadata={
                "grant_kind": "personal_agent_standing_read",
                "revoke_reason": "deprovision",
            },
        )
        logger.info("personal_agent.standing_read_revoked agent_id=%s", pod_agent_id)
        return {"revoked": True, "scope": ConsentScope.PKM_READ.value, "agentId": pod_agent_id}
