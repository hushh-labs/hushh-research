from __future__ import annotations

from typing import Any

from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)


class ConsentCenterService:
    """Compose investor + RIA consent surfaces into one UI/MCP read model."""

    def __init__(self) -> None:
        self._consent_db = ConsentDBService()
        self._ria = RIAIAMService()

    @staticmethod
    def _metadata(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        return {}

    @staticmethod
    def _counterpart(agent_id: str | None, metadata: dict[str, Any]) -> tuple[str, str | None]:
        normalized_agent = str(agent_id or "").strip()
        if metadata.get("requester_actor_type") == "ria" or normalized_agent.startswith("ria:"):
            counterpart_id = metadata.get("requester_entity_id")
            if not counterpart_id and normalized_agent.startswith("ria:"):
                counterpart_id = normalized_agent.split(":", 1)[1] or None
            return "ria", counterpart_id
        if normalized_agent in {"self", ""}:
            return "self", None
        return "developer", normalized_agent or None

    @staticmethod
    def _developer_label(agent_id: str | None, metadata: dict[str, Any]) -> str:
        app_label = str(metadata.get("developer_app_display_name") or "").strip()
        if app_label:
            return app_label
        if metadata.get("requester_actor_type") == "ria":
            ria_label = str(metadata.get("requester_entity_id") or "").strip()
            if ria_label:
                return ria_label
        return str(agent_id or "").strip()

    @staticmethod
    def _map_action_to_status(action: str | None) -> str:
        normalized = str(action or "").strip().upper()
        mapping = {
            "REQUESTED": "request_pending",
            "CONSENT_GRANTED": "approved",
            "CONSENT_DENIED": "denied",
            "CANCELLED": "cancelled",
            "REVOKED": "revoked",
            "TIMEOUT": "expired",
        }
        return mapping.get(normalized, normalized.lower() or "unknown")

    @staticmethod
    def _map_next_action(status: str, kind: str) -> str:
        normalized = (status or "").strip().lower()
        if kind == "invite":
            if normalized == "sent":
                return "await_acceptance"
            if normalized == "accepted":
                return "review_request"
            if normalized == "expired":
                return "reinvite"
            return "none"
        if normalized == "pending":
            return "review_request"
        if normalized == "request_pending":
            return "await_decision"
        if normalized == "approved":
            return "open_workspace"
        if normalized in {"revoked", "expired", "denied", "cancelled"}:
            return "re_request"
        if normalized == "active":
            return "revoke"
        return "none"

    def _normalize_pending(self, item: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(item.get("developer") or "")
        metadata = self._metadata(item.get("metadata"))
        counterpart_type, counterpart_id = self._counterpart(agent_id, metadata)
        status = "pending"
        existing_granted_scopes = item.get("existingGrantedScopes")
        if not isinstance(existing_granted_scopes, list):
            existing_granted_scopes = metadata.get("existing_granted_scopes")
        if not isinstance(existing_granted_scopes, list):
            existing_granted_scopes = []
        return {
            "id": str(item.get("id") or ""),
            "kind": "incoming_request",
            "status": status,
            "action": "REQUESTED",
            "scope": item.get("scope"),
            "scope_description": item.get("scopeDescription"),
            "counterpart_type": counterpart_type,
            "counterpart_id": counterpart_id,
            "counterpart_label": self._developer_label(agent_id, metadata),
            "counterpart_image_url": item.get("requesterImageUrl")
            or metadata.get("requester_image_url"),
            "counterpart_website_url": item.get("requesterWebsiteUrl")
            or metadata.get("requester_website_url"),
            "request_id": item.get("id"),
            "invite_id": None,
            "relationship_status": None,
            "allowed_next_action": self._map_next_action(status, "incoming_request"),
            "issued_at": item.get("requestedAt"),
            "expires_at": item.get("pollTimeoutAt"),
            "approval_timeout_at": item.get("approvalTimeoutAt") or item.get("pollTimeoutAt"),
            "request_url": item.get("requestUrl"),
            "reason": item.get("reason") or metadata.get("reason"),
            "is_scope_upgrade": bool(
                item.get("isScopeUpgrade") or metadata.get("is_scope_upgrade")
            ),
            "existing_granted_scopes": existing_granted_scopes,
            "additional_access_summary": item.get("additionalAccessSummary")
            or metadata.get("additional_access_summary"),
            "metadata": {
                **metadata,
                "expiry_hours": item.get("expiryHours"),
                "approval_timeout_minutes": item.get("approvalTimeoutMinutes"),
            },
        }

    def _normalize_active(self, item: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(item.get("developer") or item.get("agent_id") or "")
        metadata = self._metadata(item.get("metadata"))
        counterpart_type, counterpart_id = self._counterpart(agent_id, metadata)
        status = "active"
        return {
            "id": str(item.get("token_id") or item.get("id") or ""),
            "kind": "active_grant",
            "status": status,
            "action": "CONSENT_GRANTED",
            "scope": item.get("scope"),
            "scope_description": None,
            "counterpart_type": counterpart_type,
            "counterpart_id": counterpart_id,
            "counterpart_label": self._developer_label(agent_id, metadata),
            "counterpart_image_url": metadata.get("requester_image_url"),
            "counterpart_website_url": metadata.get("requester_website_url"),
            "request_id": item.get("request_id"),
            "invite_id": None,
            "relationship_status": self._map_action_to_status(item.get("action")),
            "allowed_next_action": self._map_next_action(status, "active_grant"),
            "issued_at": item.get("issued_at"),
            "expires_at": item.get("expires_at"),
            "request_url": metadata.get("request_url"),
            "reason": metadata.get("reason"),
            "is_scope_upgrade": bool(metadata.get("is_scope_upgrade")),
            "existing_granted_scopes": metadata.get("existing_granted_scopes"),
            "additional_access_summary": metadata.get("additional_access_summary"),
            "metadata": metadata or None,
        }

    def _normalize_history(self, item: dict[str, Any]) -> dict[str, Any]:
        metadata = self._metadata(item.get("metadata"))
        agent_id = str(item.get("agent_id") or "")
        counterpart_type, counterpart_id = self._counterpart(agent_id, metadata)
        status = self._map_action_to_status(item.get("action"))
        counterpart_label = self._developer_label(agent_id, metadata)
        if metadata.get("requester_actor_type") == "ria":
            counterpart_label = str(metadata.get("requester_entity_id") or agent_id)
        return {
            "id": str(item.get("id") or item.get("request_id") or ""),
            "kind": "history",
            "status": status,
            "action": item.get("action"),
            "scope": item.get("scope"),
            "scope_description": item.get("scope_description"),
            "counterpart_type": counterpart_type,
            "counterpart_id": counterpart_id,
            "counterpart_label": counterpart_label,
            "counterpart_image_url": metadata.get("requester_image_url"),
            "counterpart_website_url": metadata.get("requester_website_url"),
            "request_id": item.get("request_id"),
            "invite_id": metadata.get("invite_id"),
            "relationship_status": status,
            "allowed_next_action": self._map_next_action(status, "history"),
            "issued_at": item.get("issued_at"),
            "expires_at": item.get("expires_at"),
            "request_url": metadata.get("request_url"),
            "reason": metadata.get("reason"),
            "is_scope_upgrade": bool(metadata.get("is_scope_upgrade")),
            "existing_granted_scopes": metadata.get("existing_granted_scopes"),
            "additional_access_summary": metadata.get("additional_access_summary"),
            "metadata": metadata or None,
        }

    @staticmethod
    def _issued_at_ms(value: Any) -> int:
        if isinstance(value, (int, float)):
            return int(value)
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    def _group_by_requestor(self, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        groups: dict[str, dict[str, Any]] = {}

        for entry in entries:
            counterpart_type = str(entry.get("counterpart_type") or "developer")
            counterpart_id = entry.get("counterpart_id")
            counterpart_label = str(entry.get("counterpart_label") or counterpart_id or "Requester")
            key = f"{counterpart_type}:{counterpart_id or counterpart_label}"
            group = groups.setdefault(
                key,
                {
                    "id": key,
                    "counterpart_type": counterpart_type,
                    "counterpart_id": counterpart_id,
                    "counterpart_label": counterpart_label,
                    "latest_request_at": entry.get("issued_at"),
                    "status": entry.get("status"),
                    "request_count": 0,
                    "scopes": [],
                    "entries": [],
                },
            )
            group["request_count"] += 1
            group["entries"].append(entry)
            if self._issued_at_ms(entry.get("issued_at")) >= self._issued_at_ms(
                group.get("latest_request_at")
            ):
                group["latest_request_at"] = entry.get("issued_at")
                group["status"] = entry.get("status")
            scope_label = entry.get("scope_description") or entry.get("scope")
            if scope_label and scope_label not in group["scopes"]:
                group["scopes"].append(scope_label)

        grouped = list(groups.values())
        grouped.sort(
            key=lambda item: self._issued_at_ms(item.get("latest_request_at")),
            reverse=True,
        )
        return grouped

    def _normalize_outgoing(self, item: dict[str, Any]) -> dict[str, Any]:
        metadata = self._metadata(item.get("metadata"))
        status = self._map_action_to_status(item.get("action"))
        return {
            "id": str(item.get("request_id") or item.get("user_id") or ""),
            "kind": "outgoing_request",
            "status": status,
            "action": item.get("action"),
            "scope": item.get("scope"),
            "scope_description": None,
            "counterpart_type": "investor",
            "counterpart_id": item.get("user_id"),
            "counterpart_label": item.get("subject_display_name")
            or item.get("subject_headline")
            or item.get("user_id"),
            "counterpart_image_url": None,
            "counterpart_website_url": None,
            "request_id": item.get("request_id"),
            "invite_id": metadata.get("invite_id"),
            "relationship_status": status,
            "allowed_next_action": self._map_next_action(status, "outgoing_request"),
            "issued_at": item.get("issued_at"),
            "expires_at": item.get("expires_at"),
            "request_url": metadata.get("request_url"),
            "reason": metadata.get("reason"),
            "additional_access_summary": metadata.get("additional_access_summary"),
            "metadata": metadata or None,
        }

    def _normalize_invite(self, item: dict[str, Any]) -> dict[str, Any]:
        status = str(item.get("status") or "sent")
        counterpart_label = (
            item.get("target_display_name")
            or item.get("target_email")
            or item.get("target_phone")
            or item.get("target_investor_user_id")
            or "Invited investor"
        )
        return {
            "id": str(item.get("invite_id") or item.get("invite_token") or ""),
            "kind": "invite",
            "status": status,
            "action": status.upper(),
            "scope": item.get("scope_template_id"),
            "scope_description": None,
            "counterpart_type": "investor",
            "counterpart_id": item.get("target_investor_user_id"),
            "counterpart_label": counterpart_label,
            "counterpart_image_url": None,
            "counterpart_website_url": None,
            "request_id": item.get("accepted_request_id"),
            "invite_id": item.get("invite_id"),
            "relationship_status": status,
            "allowed_next_action": self._map_next_action(status, "invite"),
            "issued_at": item.get("created_at"),
            "expires_at": item.get("expires_at"),
            "request_url": None,
            "reason": item.get("reason"),
            "metadata": {
                "delivery_channel": item.get("delivery_channel"),
                "duration_hours": item.get("duration_hours"),
                "duration_mode": item.get("duration_mode"),
                "source": item.get("source"),
            },
        }

    async def list_outgoing_requests(self, user_id: str) -> list[dict[str, Any]]:
        try:
            items = await self._ria.list_ria_requests(user_id)
        except (IAMSchemaNotReadyError, RIAIAMPolicyError):
            return []
        return [self._normalize_outgoing(item) for item in items]

    async def get_center(self, user_id: str) -> dict[str, Any]:
        try:
            persona_state = await self._ria.get_persona_state(user_id)
        except IAMSchemaNotReadyError:
            persona_state = {
                "user_id": user_id,
                "personas": ["investor"],
                "last_active_persona": "investor",
                "investor_marketplace_opt_in": False,
                "iam_schema_ready": False,
                "mode": "compat_investor",
            }

        pending = await self._consent_db.get_pending_requests(user_id)
        active = await self._consent_db.get_active_tokens(user_id)
        history_result = await self._consent_db.get_audit_log(user_id, page=1, limit=100)
        self_activity_summary = await self._consent_db.get_internal_activity_summary(user_id)
        incoming = [self._normalize_pending(item) for item in pending]
        active_entries = [self._normalize_active(item) for item in active]
        history_entries = [
            self._normalize_history(item) for item in history_result.get("items", [])
        ]
        developer_requests = [item for item in incoming if item["counterpart_type"] == "developer"]
        investor_pending_groups = self._group_by_requestor(
            [item for item in incoming if item["counterpart_type"] in {"ria", "developer"}]
        )
        investor_active_groups = self._group_by_requestor(active_entries)
        investor_history_groups = self._group_by_requestor(history_entries)

        ria_onboarding: dict[str, Any] | None = None
        outgoing_entries: list[dict[str, Any]] = []
        invite_entries: list[dict[str, Any]] = []
        roster_summary = {
            "total": 0,
            "approved": 0,
            "pending": 0,
            "invited": 0,
        }

        if bool(persona_state.get("iam_schema_ready")):
            try:
                ria_onboarding = await self._ria.get_ria_onboarding_status(user_id)
            except (IAMSchemaNotReadyError, RIAIAMPolicyError):
                ria_onboarding = None
            outgoing_entries = await self.list_outgoing_requests(user_id)
            try:
                invite_entries = [
                    self._normalize_invite(item)
                    for item in await self._ria.list_ria_invites(user_id)
                ]
            except (IAMSchemaNotReadyError, RIAIAMPolicyError):
                invite_entries = []
            try:
                roster = await self._ria.list_ria_clients(user_id)
            except (IAMSchemaNotReadyError, RIAIAMPolicyError):
                roster = []
            roster_summary = {
                "total": len(roster),
                "approved": len([item for item in roster if item.get("status") == "approved"]),
                "pending": len(
                    [item for item in roster if item.get("status") == "request_pending"]
                ),
                "invited": len([item for item in roster if item.get("status") == "invited"]),
            }

        return {
            "user_id": user_id,
            "persona_state": persona_state,
            "ria_onboarding": ria_onboarding,
            "summary": {
                "incoming_requests": len(incoming),
                "outgoing_requests": len(outgoing_entries),
                "active_grants": len(active_entries),
                "invites": len(invite_entries),
                "history": len(history_entries),
                "developer_requests": len(developer_requests),
                "ria_roster": roster_summary,
            },
            "incoming_requests": incoming,
            "outgoing_requests": outgoing_entries,
            "active_grants": active_entries,
            "history": history_entries,
            "invites": invite_entries,
            "developer_requests": developer_requests,
            "requestor_groups": {
                "pending": investor_pending_groups,
                "active": investor_active_groups,
                "previous": investor_history_groups,
            },
            "self_activity_summary": self_activity_summary,
        }
