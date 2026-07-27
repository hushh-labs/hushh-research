"""Pod-access audit — prove a privileged pod read is truly the owner, and receipt it.

The per-user pod holds exactly one standing authority: an HCT bound to
``(owner user_id, agent_id="personal_agent", scope=pkm.read)``. Whenever the pod
exercises that authority to read the owner's PKM (the "shared compute + storage"
read path), this guard asserts the caller is genuinely the registered owner of
**this** pod and writes a **visible** audit receipt into ``consent_audit`` — the
same ledger Nav narrates and the owner can inspect/revoke against.

Fail-closed by construction: any mismatch (wrong agent id, wrong scope, no
provisioned registry row, or a HusshID that does not belong to the caller)
**denies** and still records a ``POD_ACCESS_DENIED`` receipt, so an attempted
cross-user read is both blocked and auditable.

This composes primitives that already exist (the personal-agent registry lookup
and the consent-audit ledger); it introduces no new storage. It stays inert
behind ``PERSONAL_AGENT_ENABLED`` and does no DB work until called on a live pod
read path.
"""

from __future__ import annotations

import logging
from typing import Any, Optional, Protocol

from hushh_mcp.constants import ConsentScope
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.personal_agent_grant_service import (
    PERSONAL_AGENT_ID,
    PersonalAgentDisabledError,
)

logger = logging.getLogger(__name__)

# Visible ledger actions (NOT internal — see ConsentDBService._is_internal_event:
# agent_id="personal_agent" + these actions stay owner-visible/Nav-narratable).
ACTION_ALLOWED = "POD_ACCESS_ALLOWED"
ACTION_DENIED = "POD_ACCESS_DENIED"

# Registry status that means a real, live pod exists for this owner.
STATUS_PROVISIONED = "provisioned"


def _is_read_scope(scope: str) -> bool:
    """The pod's standing authority is a READ authority: pkm.read or any attr.*."""
    s = (scope or "").strip().lower()
    return s == ConsentScope.PKM_READ.value or s.startswith("attr.")


class PodAccessDenied(PermissionError):
    """The caller is not the verified owner of this pod (fail-closed)."""


class _Registry(Protocol):
    async def get(self, user_id: str) -> Optional[dict]: ...


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


class PodAccessAuditService:
    """Owner-verified, receipted gate in front of the pod's standing read path."""

    def __init__(self, *, registry: _Registry, ledger: Optional[_Ledger] = None) -> None:
        self._registry = registry
        self._ledger = ledger

    async def authorize_owner_read(
        self,
        *,
        user_id: str,
        agent_id: str,
        scope: str,
        hushh_id: Optional[str] = None,
        request_id: Optional[str] = None,
        ledger: Optional[_Ledger] = None,
    ) -> dict[str, Any]:
        """Verify the caller is THIS pod's owner, write a receipt, allow or deny.

        ``user_id``/``agent_id``/``scope`` come from an already-validated HCT (the
        caller validates the token's signature + revocation first; this guard adds
        the *ownership* check on top). ``hushh_id``, when provided, is checked
        against the registry row so a valid token for user A can never be used to
        read pod B.

        Returns ``{"authorized": True, "hushhId", "scope"}`` on success. Raises
        ``PodAccessDenied`` (fail-closed) on any mismatch — after recording a
        ``POD_ACCESS_DENIED`` receipt. Raises ``PersonalAgentDisabledError`` when
        the feature is off, and ``ValueError`` on missing ``user_id``.
        """
        if not personal_agent_enabled():
            raise PersonalAgentDisabledError(
                "pod access requested while PERSONAL_AGENT_ENABLED is off"
            )
        if not user_id:
            raise ValueError("user_id is required")

        # Normalize inputs so incidental whitespace can't accidentally deny a
        # legitimate owner (it never *grants* — the exact-match checks below still
        # hold); scope is normalized inside _is_read_scope.
        agent_id = (agent_id or "").strip()

        # A registry-read failure (DB blip) must fail CLOSED *and* be audited — a
        # denied access with no receipt would be a silent hole. Treat it as a deny
        # with an explicit reason rather than letting the exception escape unlogged.
        try:
            row = await self._registry.get(user_id)
        except Exception as exc:
            logger.warning("pod_access.registry_read_failed err=%s", type(exc).__name__)
            await self._receipt(
                user_id=user_id,
                scope=scope,
                allowed=False,
                reasons=["registry_unavailable"],
                hushh_id=hushh_id,
                request_id=request_id,
                ledger=ledger,
            )
            raise PodAccessDenied("registry_unavailable") from exc

        reasons: list[str] = []
        if agent_id != PERSONAL_AGENT_ID:
            # Only the pod's own agent identity holds the standing read authority.
            reasons.append("agent_id_not_pod")
        if not _is_read_scope(scope):
            reasons.append("scope_not_read")
        if row is None:
            reasons.append("no_registry_row")
        else:
            if str(row.get("status")) != STATUS_PROVISIONED:
                reasons.append("pod_not_provisioned")
            row_hushh = row.get("hushh_id")
            # A supplied HusshID must match the owner's row: a token minted for one
            # owner can never be redirected to read another owner's pod.
            if hushh_id is not None and row_hushh is not None and hushh_id != row_hushh:
                reasons.append("hushh_id_mismatch")

        allowed = not reasons
        resolved_hushh = (row or {}).get("hushh_id")
        await self._receipt(
            user_id=user_id,
            scope=scope,
            allowed=allowed,
            reasons=reasons,
            hushh_id=hushh_id or resolved_hushh,
            request_id=request_id,
            ledger=ledger,
        )
        if not allowed:
            logger.warning("pod_access.denied reasons=%s", ",".join(reasons))
            raise PodAccessDenied(",".join(reasons) or "denied")
        logger.info("pod_access.allowed agent_id=%s scope=%s", agent_id, scope)
        return {"authorized": True, "hushhId": resolved_hushh, "scope": scope}

    async def _receipt(
        self,
        *,
        user_id: str,
        scope: str,
        allowed: bool,
        reasons: list[str],
        hushh_id: Optional[str],
        request_id: Optional[str],
        ledger: Optional[_Ledger],
    ) -> None:
        """Write the visible pod-access receipt. Best-effort: a ledger failure is
        logged but never converts an allow into a deny (the decision already
        stands) — the receipt is an audit record, not the gate itself."""
        sink = ledger or self._ledger
        if sink is None:
            from hushh_mcp.services.consent_db import ConsentDBService

            sink = ConsentDBService()
        try:
            await sink.insert_event(
                user_id=user_id,
                # Always attribute to the pod agent so the row is owner-visible.
                agent_id=PERSONAL_AGENT_ID,
                scope=scope or ConsentScope.PKM_READ.value,
                action=ACTION_ALLOWED if allowed else ACTION_DENIED,
                request_id=request_id,
                scope_description=(
                    "Personal agent pod access (owner-verified)"
                    if allowed
                    else "Personal agent pod access denied (fail-closed)"
                ),
                metadata={
                    "audit_kind": "personal_agent_pod_access",
                    "decision": "allow" if allowed else "deny",
                    "reasons": reasons,
                    "hushh_id": hushh_id,
                },
            )
        except Exception as exc:  # best-effort receipt
            logger.warning("pod_access.receipt_failed err=%s", type(exc).__name__)
