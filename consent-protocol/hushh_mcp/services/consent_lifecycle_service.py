"""Consent lifecycle transitions shared by the REST routes and One's backend-direct actions.

Deny, revoke, and the pending-incoming projection used to live only inside
``api/routes/consent.py``. The One agent can now run the same transitions from
chat, and a second copy of a ledger write is how two surfaces drift apart, so
the route bodies moved here and both callers use exactly this code. Approval
deliberately has no counterpart here: the plaintext export is built under the
vault key in the owner's browser, so approval stays a tap on that device.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable, MutableMapping

from hushh_mcp.consent import token as consent_token
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.consent_db import ConsentDBService

logger = logging.getLogger(__name__)


class ConsentLifecycleError(RuntimeError):
    """A consumer-safe failure: ``message`` may be spoken or shown verbatim."""

    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


async def owned_consent_identifiers(user_id: str) -> list[str]:
    """Every account identifier the ledger may have written this owner's rows under."""
    try:
        identifiers = await ActorIdentityService().list_account_identifiers(user_id)
    except Exception as exc:  # noqa: BLE001 - identifier expansion is best effort
        logger.debug(
            "consent.identifier_expansion_skipped user_id=%s error=%s",
            user_id,
            exc,
        )
        identifiers = []
    return identifiers or [user_id]


def identifier_filter_kwargs(user_id: str, identifiers: list[str]) -> dict[str, list[str]]:
    normalized_user_id = str(user_id or "").strip()
    normalized_identifiers = [
        str(item or "").strip() for item in identifiers if str(item or "").strip()
    ]
    if set(normalized_identifiers) <= {normalized_user_id}:
        return {}
    return {"user_ids": normalized_identifiers}


def _clean(value: Any) -> str:
    return str(value or "").strip()


class ConsentLifecycleService:
    def __init__(
        self,
        consent_db: ConsentDBService | None = None,
        center: ConsentCenterService | None = None,
        identifiers_resolver: Callable[[str], Awaitable[list[str]]] | None = None,
    ) -> None:
        # The route hands in its own service instances so its test doubles and
        # per-request patches keep applying; chat callers take the defaults.
        self._db = consent_db or ConsentDBService()
        self._center = center
        self._owned_identifiers = identifiers_resolver or owned_consent_identifiers

    def _center_service(self) -> ConsentCenterService:
        if self._center is None:
            self._center = ConsentCenterService()
        return self._center

    async def list_pending_incoming(self, user_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
        """Requests waiting on this owner, projected to labels only.

        Never carries a raw ``attr.*`` scope, an internal token id, or a
        requester user id: the model reads this and says it out loud.
        """
        center = await self._center_service().list_center(
            user_id,
            actor="investor",
            surface="pending",
            mode="consents",
            limit=max(1, min(int(limit or 20), 100)),
        )
        entries: list[dict[str, Any]] = []
        for key in ("items", "entries", "results"):
            candidate = center.get(key) if isinstance(center, dict) else None
            if isinstance(candidate, list):
                entries = [item for item in candidate if isinstance(item, dict)]
                break
        return [self._pending_projection(entry) for entry in entries]

    @staticmethod
    def _pending_projection(entry: dict[str, Any]) -> dict[str, Any]:
        metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        return {
            "requestId": _clean(entry.get("request_id") or entry.get("id")),
            "requesterLabel": _clean(entry.get("counterpart_label")) or "Someone",
            "requesterType": _clean(entry.get("counterpart_type")) or "unknown",
            "description": _clean(entry.get("scope_description") or entry.get("reason"))
            or "some of your information",
            "bundleLabel": _clean(metadata.get("bundle_label")) or None,
            "bundleScopeCount": metadata.get("bundle_scope_count"),
            "issuedAt": entry.get("issued_at"),
            "expiresAt": entry.get("poll_timeout_at") or entry.get("expires_at"),
        }

    async def deny_pending_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        """Write CONSENT_DENIED for one of this owner's pending requests."""
        request_id = _clean(request_id)
        if not request_id:
            raise ConsentLifecycleError("CONSENT_REQUEST_ID_REQUIRED", "Say which request to deny.")
        owned = await self._owned_identifiers(user_id)
        pending = await self._db.get_pending_by_request_id(
            user_id, request_id, **identifier_filter_kwargs(user_id, owned)
        )
        if not pending:
            raise ConsentLifecycleError(
                "CONSENT_REQUEST_NOT_FOUND",
                "That request is not waiting on you anymore.",
                status_code=404,
            )
        subject_user_id = _clean(pending.get("user_id")) or user_id
        metadata = pending.get("metadata") if isinstance(pending.get("metadata"), dict) else {}
        developer_label = metadata.get("developer_app_display_name") or pending["developer"]
        await self._db.insert_event(
            user_id=subject_user_id,
            agent_id=pending["developer"],
            scope=pending["scope"],
            action="CONSENT_DENIED",
            request_id=request_id,
        )
        logger.info("consent.denied_event_saved")
        return {"status": "denied", "message": f"Consent denied to {developer_label}"}

    async def revoke_active_grant(
        self,
        user_id: str,
        *,
        scope: str | None = None,
        request_id: str | None = None,
        export_cache: MutableMapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Revoke one active grant, matched by scope and/or the request it came from.

        Byte-for-byte the REST behavior: the live token joins the in-memory
        revocation set, its export is deleted, and a REVOKED event linked to
        the original request is written. ``export_cache`` is the route's
        process-local export map so a revoke from chat clears it too.
        """
        scope = _clean(scope) or None
        request_id = _clean(request_id) or None
        if not scope and not request_id:
            raise ConsentLifecycleError(
                "CONSENT_REVOKE_TARGET_REQUIRED", "Say which grant to revoke."
            )
        owned = await self._owned_identifiers(user_id)
        active_tokens = await self._db.get_active_tokens(
            user_id, **identifier_filter_kwargs(user_id, owned)
        )
        internal_tokens = await self._db.get_active_internal_tokens(user_id)
        all_active_tokens = [*internal_tokens, *active_tokens]
        logger.info("consent.revoke_active_token_count=%s", len(all_active_tokens))

        token_to_revoke = None
        for token in all_active_tokens:
            if scope and token.get("scope") != scope:
                continue
            if request_id and token.get("request_id") != request_id:
                continue
            token_to_revoke = token
            break
        if not token_to_revoke:
            raise ConsentLifecycleError(
                "CONSENT_GRANT_NOT_FOUND",
                "No active consent found for the requested grant"
                if request_id
                else "No active consent found for the requested scope",
                status_code=404,
            )
        resolved_scope = _clean(token_to_revoke.get("scope")) or scope or ""

        original_token = token_to_revoke.get("token_id")
        if original_token and not str(original_token).startswith("REVOKED_"):
            consent_token.revoke_token(original_token)
            await self._db.delete_consent_export(original_token)
            if export_cache is not None and original_token in export_cache:
                del export_cache[original_token]

        revoke_token_id = f"REVOKED_{int(time.time() * 1000)}_{resolved_scope}"
        agent_id = token_to_revoke.get("agent_id") or token_to_revoke.get("developer") or "Unknown"
        subject_user_id = _clean(token_to_revoke.get("user_id")) or user_id
        await self._db.insert_event(
            user_id=subject_user_id,
            agent_id=agent_id,
            scope=resolved_scope,
            action="REVOKED",
            token_id=revoke_token_id,
            request_id=token_to_revoke.get("request_id"),
            scope_description="Vault owner session" if agent_id == "self" else None,
        )
        logger.info("consent.revoked_event_saved scope=%s", resolved_scope)
        is_vault_owner = resolved_scope in ("vault.owner", "VAULT_OWNER")
        return {
            "status": "revoked",
            "message": f"Consent for {resolved_scope} has been revoked",
            "lockVault": is_vault_owner,
            "scope": resolved_scope,
            "agentId": agent_id,
        }
