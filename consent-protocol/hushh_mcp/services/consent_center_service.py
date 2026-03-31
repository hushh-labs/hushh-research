from __future__ import annotations

from typing import Any

from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)


class ConsentCenterService:
    """Compose investor + RIA consent surfaces into one UI/MCP read model."""

    _PENDING_STATUSES = {"pending", "request_pending", "sent"}
    _ACTIVE_STATUSES = {"active"}

    def __init__(self) -> None:
        self._consent_db = ConsentDBService()
        self._identity = ActorIdentityService()
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
        if metadata.get("requester_actor_type") == "investor" or normalized_agent.startswith(
            "investor:"
        ):
            counterpart_id = metadata.get("requester_entity_id")
            if not counterpart_id and normalized_agent.startswith("investor:"):
                counterpart_id = normalized_agent.split(":", 1)[1] or None
            return "investor", counterpart_id
        if normalized_agent in {"self", ""}:
            return "self", None
        return "developer", normalized_agent or None

    @staticmethod
    def _developer_label(agent_id: str | None, metadata: dict[str, Any]) -> str:
        app_label = str(metadata.get("developer_app_display_name") or "").strip()
        if app_label:
            return app_label
        if metadata.get("requester_actor_type") == "ria":
            ria_label = str(
                metadata.get("requester_label") or metadata.get("requester_entity_id") or ""
            ).strip()
            if ria_label:
                return ria_label
        if metadata.get("requester_actor_type") == "investor":
            investor_label = str(
                metadata.get("requester_label") or metadata.get("requester_entity_id") or ""
            ).strip()
            if investor_label:
                return investor_label
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

    @staticmethod
    def _developer_email(metadata: dict[str, Any]) -> str | None:
        for key in (
            "developer_contact_email",
            "contact_email",
            "owner_email",
            "requester_email",
        ):
            value = str(metadata.get(key) or "").strip()
            if value:
                return value
        return None

    @staticmethod
    def _relationship_state(metadata: dict[str, Any], *, counterpart_type: str) -> str | None:
        if counterpart_type != "ria":
            return None
        for key in ("relationship_state", "ria_relationship_state", "invite_status"):
            value = str(metadata.get(key) or "").strip()
            if value:
                return value
        return None

    @staticmethod
    def _match_text(entry: dict[str, Any], query: str) -> bool:
        needle = query.strip().lower()
        if not needle:
            return True
        haystacks = [
            entry.get("counterpart_label"),
            entry.get("counterpart_email"),
            entry.get("counterpart_secondary_label"),
            entry.get("scope"),
            entry.get("scope_description"),
            entry.get("reason"),
            entry.get("status"),
        ]
        return any(needle in str(value or "").lower() for value in haystacks)

    async def _hydrate_entry_identities(
        self, entries: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        identity_ids = [
            str(entry.get("counterpart_id") or "").strip()
            for entry in entries
            if str(entry.get("counterpart_type") or "").strip() in {"investor", "ria", "self"}
            and str(entry.get("counterpart_id") or "").strip()
        ]
        identities = await self._identity.ensure_many(identity_ids)

        hydrated: list[dict[str, Any]] = []
        for entry in entries:
            item = dict(entry)
            counterpart_id = str(item.get("counterpart_id") or "").strip() or None
            counterpart_type = str(item.get("counterpart_type") or "").strip() or "developer"
            metadata = self._metadata(item.get("metadata"))
            identity = identities.get(counterpart_id or "")

            counterpart_label = str(item.get("counterpart_label") or "").strip() or None
            counterpart_secondary_label = (
                str(item.get("counterpart_secondary_label") or "").strip() or None
            )
            counterpart_email = str(item.get("counterpart_email") or "").strip().lower() or None

            if counterpart_type in {"investor", "ria", "self"} and identity:
                identity_label = str(identity.get("display_name") or "").strip() or None
                identity_email = str(identity.get("email") or "").strip().lower() or None
                if identity_label and (
                    not counterpart_label or counterpart_label == counterpart_id
                ):
                    counterpart_label = identity_label
                if identity_email and not counterpart_email:
                    counterpart_email = identity_email
                if identity_email and not counterpart_secondary_label:
                    counterpart_secondary_label = identity_email

            if counterpart_type == "developer":
                counterpart_email = counterpart_email or self._developer_email(metadata)
                counterpart_secondary_label = counterpart_secondary_label or counterpart_email
            elif counterpart_type == "ria":
                counterpart_secondary_label = (
                    counterpart_secondary_label
                    or counterpart_email
                    or str(metadata.get("requester_role_label") or "").strip()
                    or "Registered investment advisor"
                )
            elif counterpart_type == "investor":
                counterpart_secondary_label = (
                    counterpart_secondary_label
                    or counterpart_email
                    or str(metadata.get("subject_headline") or "").strip()
                    or None
                )
            elif counterpart_type == "self":
                counterpart_secondary_label = counterpart_secondary_label or counterpart_email

            item["counterpart_label"] = counterpart_label or counterpart_id or "Requester"
            item["counterpart_email"] = counterpart_email
            item["counterpart_secondary_label"] = counterpart_secondary_label
            item["technical_identity"] = {"user_id": counterpart_id} if counterpart_id else None
            item["relationship_state"] = item.get("relationship_state") or self._relationship_state(
                metadata,
                counterpart_type=counterpart_type,
            )
            hydrated.append(item)
        return hydrated

    @staticmethod
    def _entries_for_surface(
        center: dict[str, Any],
        *,
        actor: str,
        surface: str,
    ) -> list[dict[str, Any]]:
        if surface == "active":
            return [
                entry
                for entry in list(center.get("active_grants") or [])
                if ConsentCenterService._status(entry.get("status"))
                in ConsentCenterService._ACTIVE_STATUSES
            ]

        if surface == "pending":
            sources = (
                [
                    *(center.get("outgoing_requests") or []),
                    *(center.get("invites") or []),
                ]
                if actor == "ria"
                else list(center.get("incoming_requests") or [])
            )
            return [
                entry
                for entry in sources
                if ConsentCenterService._status(entry.get("status"))
                in ConsentCenterService._PENDING_STATUSES
            ]

        sources = list(center.get("history") or [])
        if actor == "ria":
            sources.extend(center.get("outgoing_requests") or [])
            sources.extend(center.get("invites") or [])
        return [
            entry
            for entry in sources
            if ConsentCenterService._status(entry.get("status"))
            not in (ConsentCenterService._PENDING_STATUSES | ConsentCenterService._ACTIVE_STATUSES)
        ]

    @staticmethod
    def _status(value: Any) -> str:
        return str(value or "").strip().lower()

    @staticmethod
    def _sort_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        def _timestamp(entry: dict[str, Any]) -> int:
            value = entry.get("issued_at") or entry.get("expires_at")
            if isinstance(value, (int, float)):
                return int(value)
            try:
                return int(value)
            except (TypeError, ValueError):
                return 0

        return sorted(entries, key=_timestamp, reverse=True)

    @staticmethod
    def _is_connection_entry(entry: dict[str, Any], *, actor: str) -> bool:
        counterpart_type = str(entry.get("counterpart_type") or "").strip().lower()
        if actor == "ria":
            return counterpart_type == "investor"
        return counterpart_type == "ria"

    @classmethod
    def _filter_mode_entries(
        cls,
        entries: list[dict[str, Any]],
        *,
        actor: str,
        mode: str,
    ) -> list[dict[str, Any]]:
        if mode != "connections":
            return entries
        return [entry for entry in entries if cls._is_connection_entry(entry, actor=actor)]

    @staticmethod
    def _paginate_entries(
        entries: list[dict[str, Any]],
        *,
        page: int,
        limit: int,
        query: str | None = None,
    ) -> dict[str, Any]:
        safe_limit = max(1, min(limit, 100))
        safe_page = max(1, page)
        filtered = [
            entry
            for entry in ConsentCenterService._sort_entries(entries)
            if ConsentCenterService._match_text(entry, query or "")
        ]
        start = (safe_page - 1) * safe_limit
        end = start + safe_limit
        return {
            "page": safe_page,
            "limit": safe_limit,
            "total": len(filtered),
            "has_more": end < len(filtered),
            "items": filtered[start:end],
        }

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
            "relationship_state": self._relationship_state(
                metadata,
                counterpart_type=counterpart_type,
            ),
            "allowed_next_action": self._map_next_action(status, "incoming_request"),
            "issued_at": item.get("requestedAt"),
            "expires_at": item.get("pollTimeoutAt"),
            "approval_timeout_at": item.get("approvalTimeoutAt") or item.get("pollTimeoutAt"),
            "request_url": item.get("requestUrl"),
            "reason": item.get("reason") or metadata.get("reason"),
            "counterpart_email": self._developer_email(metadata)
            if counterpart_type == "developer"
            else None,
            "counterpart_secondary_label": None,
            "technical_identity": {"user_id": counterpart_id} if counterpart_id else None,
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
            "relationship_state": self._relationship_state(
                metadata,
                counterpart_type=counterpart_type,
            ),
            "allowed_next_action": self._map_next_action(status, "active_grant"),
            "issued_at": item.get("issued_at"),
            "expires_at": item.get("expires_at"),
            "request_url": metadata.get("request_url"),
            "reason": metadata.get("reason"),
            "counterpart_email": self._developer_email(metadata)
            if counterpart_type == "developer"
            else None,
            "counterpart_secondary_label": None,
            "technical_identity": {"user_id": counterpart_id} if counterpart_id else None,
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
        return {
            "id": str(item.get("id") or item.get("request_id") or ""),
            "kind": "history",
            "status": status,
            "action": item.get("action"),
            "scope": item.get("scope"),
            "scope_description": item.get("scope_description"),
            "counterpart_type": counterpart_type,
            "counterpart_id": counterpart_id,
            "counterpart_label": self._developer_label(agent_id, metadata),
            "counterpart_image_url": metadata.get("requester_image_url"),
            "counterpart_website_url": metadata.get("requester_website_url"),
            "request_id": item.get("request_id"),
            "invite_id": metadata.get("invite_id"),
            "relationship_state": self._relationship_state(
                metadata,
                counterpart_type=counterpart_type,
            ),
            "allowed_next_action": self._map_next_action(status, "history"),
            "issued_at": item.get("issued_at"),
            "expires_at": item.get("expires_at"),
            "request_url": metadata.get("request_url"),
            "reason": metadata.get("reason"),
            "counterpart_email": self._developer_email(metadata)
            if counterpart_type == "developer"
            else None,
            "counterpart_secondary_label": None,
            "technical_identity": {"user_id": counterpart_id} if counterpart_id else None,
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
            "relationship_state": self._relationship_state(
                metadata,
                counterpart_type="investor",
            ),
            "allowed_next_action": self._map_next_action(status, "outgoing_request"),
            "issued_at": item.get("issued_at"),
            "expires_at": item.get("expires_at"),
            "request_url": metadata.get("request_url"),
            "reason": metadata.get("reason"),
            "counterpart_email": str(item.get("subject_email") or "").strip().lower() or None,
            "counterpart_secondary_label": item.get("subject_headline") or None,
            "technical_identity": {"user_id": item.get("user_id")} if item.get("user_id") else None,
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
            "relationship_state": status,
            "allowed_next_action": self._map_next_action(status, "invite"),
            "issued_at": item.get("created_at"),
            "expires_at": item.get("expires_at"),
            "request_url": None,
            "reason": item.get("reason"),
            "counterpart_email": str(item.get("target_email") or "").strip().lower() or None,
            "counterpart_secondary_label": str(item.get("delivery_channel") or "").strip() or None,
            "technical_identity": {
                "user_id": item.get("target_investor_user_id"),
            }
            if item.get("target_investor_user_id")
            else None,
            "metadata": {
                "delivery_channel": item.get("delivery_channel"),
                "duration_hours": item.get("duration_hours"),
                "duration_mode": item.get("duration_mode"),
                "source": item.get("source"),
            },
        }

    def _normalize_ria_relationship(self, item: dict[str, Any]) -> dict[str, Any]:
        relationship_status = str(
            item.get("relationship_status") or item.get("status") or "approved"
        )
        picks_feed_status = str(item.get("picks_feed_status") or "").strip()
        picks_feed_summary = {
            "ready": "Advisor picks feed is active for this relationship.",
            "pending": "Relationship is active and the advisor picks feed is waiting on the latest upload.",
            "included_on_approval": "Advisor picks feed becomes available when the relationship is approved.",
            "unavailable": "Advisor picks feed is not currently available on this relationship.",
        }.get(picks_feed_status)
        metadata = {
            "relationship_status": relationship_status,
            "next_action": item.get("next_action"),
            "picks_feed_status": picks_feed_status or None,
            "picks_feed_granted_at": item.get("picks_feed_granted_at"),
            "relationship_shares": item.get("relationship_shares") or [],
        }
        return {
            "id": str(item.get("id") or item.get("investor_user_id") or ""),
            "kind": "active_grant",
            "status": "active",
            "action": "CONSENT_GRANTED",
            "scope": item.get("granted_scope"),
            "scope_description": "Active advisor relationship",
            "counterpart_type": "investor",
            "counterpart_id": item.get("investor_user_id"),
            "counterpart_label": item.get("investor_display_name")
            or item.get("investor_secondary_label")
            or item.get("investor_user_id")
            or "Investor",
            "counterpart_image_url": None,
            "counterpart_website_url": None,
            "request_id": item.get("last_request_id"),
            "invite_id": item.get("invite_id"),
            "relationship_state": relationship_status,
            "allowed_next_action": self._map_next_action("active", "active_grant"),
            "issued_at": item.get("consent_granted_at"),
            "expires_at": item.get("consent_expires_at"),
            "request_url": None,
            "reason": None,
            "counterpart_email": str(item.get("investor_email") or "").strip().lower() or None,
            "counterpart_secondary_label": item.get("investor_headline")
            or item.get("investor_secondary_label")
            or None,
            "technical_identity": {"user_id": item.get("investor_user_id")}
            if item.get("investor_user_id")
            else None,
            "additional_access_summary": picks_feed_summary,
            "metadata": metadata,
        }

    async def _load_investor_pending_entries(self, user_id: str) -> list[dict[str, Any]]:
        pending = await self._consent_db.get_pending_requests(user_id)
        return await self._hydrate_entry_identities(
            [self._normalize_pending(item) for item in pending]
        )

    async def _load_investor_active_entries(self, user_id: str) -> list[dict[str, Any]]:
        active = await self._consent_db.get_active_tokens(user_id)
        return await self._hydrate_entry_identities(
            [self._normalize_active(item) for item in active]
        )

    async def _load_investor_previous_entries(self, user_id: str) -> list[dict[str, Any]]:
        history_result = await self._consent_db.get_audit_log(user_id, page=1, limit=5000)
        return await self._hydrate_entry_identities(
            [self._normalize_history(item) for item in history_result.get("items", [])]
        )

    async def _load_ria_outgoing_entries(self, user_id: str) -> list[dict[str, Any]]:
        return await self.list_outgoing_requests(user_id)

    async def _load_ria_invite_entries(self, user_id: str) -> list[dict[str, Any]]:
        try:
            invites = await self._ria.list_ria_invites(user_id)
        except (IAMSchemaNotReadyError, RIAIAMPolicyError):
            invites = []
        return [self._normalize_invite(item) for item in invites]

    async def _load_ria_active_entries(
        self,
        user_id: str,
        *,
        query: str | None = None,
        page: int = 1,
        limit: int = 20,
    ) -> dict[str, Any]:
        try:
            payload = await self._ria.list_ria_clients(
                user_id,
                query=query,
                status="approved",
                page=page,
                limit=limit,
            )
        except (IAMSchemaNotReadyError, RIAIAMPolicyError):
            payload = {"items": [], "total": 0, "page": page, "limit": limit, "has_more": False}

        return {
            "page": int(payload.get("page") or page),
            "limit": int(payload.get("limit") or limit),
            "total": int(payload.get("total") or 0),
            "has_more": bool(payload.get("has_more")),
            "items": [
                self._normalize_ria_relationship(item) for item in list(payload.get("items") or [])
            ],
        }

    async def _get_surface_count(
        self,
        user_id: str,
        *,
        actor: str,
        surface: str,
        mode: str = "consents",
    ) -> int:
        normalized_actor = "ria" if actor == "ria" else "investor"
        if normalized_actor == "investor":
            if surface == "pending":
                return len(
                    self._filter_mode_entries(
                        await self._load_investor_pending_entries(user_id),
                        actor=normalized_actor,
                        mode=mode,
                    )
                )
            if surface == "active":
                return len(
                    self._filter_mode_entries(
                        await self._load_investor_active_entries(user_id),
                        actor=normalized_actor,
                        mode=mode,
                    )
                )
            return len(
                self._filter_mode_entries(
                    await self._load_investor_previous_entries(user_id),
                    actor=normalized_actor,
                    mode=mode,
                )
            )

        if surface == "active":
            payload = await self._load_ria_active_entries(user_id, page=1, limit=1)
            return len(
                self._filter_mode_entries(
                    list(payload.get("items") or []),
                    actor=normalized_actor,
                    mode=mode,
                )
            )

        outgoing_entries = await self._load_ria_outgoing_entries(user_id)
        invite_entries = await self._load_ria_invite_entries(user_id)
        items = self._entries_for_surface(
            {
                "outgoing_requests": outgoing_entries,
                "invites": invite_entries,
            },
            actor="ria",
            surface=surface,
        )
        return len(self._filter_mode_entries(items, actor=normalized_actor, mode=mode))

    async def list_outgoing_requests(self, user_id: str) -> list[dict[str, Any]]:
        try:
            items = await self._ria.list_ria_requests(user_id)
        except (IAMSchemaNotReadyError, RIAIAMPolicyError):
            return []
        return [self._normalize_outgoing(item) for item in items]

    async def get_center(
        self,
        user_id: str,
        *,
        actor: str | None = None,
        surface: str | None = None,
    ) -> dict[str, Any]:
        normalized_actor = "ria" if actor == "ria" else "investor"
        normalized_surface = surface if surface in {"pending", "active", "previous"} else None
        if actor is None or normalized_actor == "ria":
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
        else:
            persona_state = {
                "user_id": user_id,
                "personas": ["investor"],
                "last_active_persona": "investor",
                "active_persona": "investor",
                "primary_nav_persona": "investor",
                "ria_setup_available": False,
                "ria_switch_available": False,
                "dev_ria_bypass_allowed": False,
                "investor_marketplace_opt_in": False,
                "iam_schema_ready": False,
                "mode": "compat_investor",
            }

        include_all = actor is None and normalized_surface is None
        need_incoming = include_all or (
            normalized_actor != "ria" and normalized_surface in {None, "pending"}
        )
        need_active = include_all or normalized_surface in {None, "active"}
        need_history = include_all or normalized_surface in {None, "previous"}

        pending = await self._consent_db.get_pending_requests(user_id) if need_incoming else []
        active = await self._consent_db.get_active_tokens(user_id) if need_active else []
        history_result = (
            await self._consent_db.get_audit_log(user_id, page=1, limit=100)
            if need_history
            else {"items": []}
        )
        self_activity_summary = await self._consent_db.get_internal_activity_summary(user_id)
        incoming = (
            await self._hydrate_entry_identities(
                [self._normalize_pending(item) for item in pending]
            )
            if need_incoming
            else []
        )
        active_entries = (
            await self._hydrate_entry_identities([self._normalize_active(item) for item in active])
            if need_active
            else []
        )
        history_entries = (
            await self._hydrate_entry_identities(
                [self._normalize_history(item) for item in history_result.get("items", [])]
            )
            if need_history
            else []
        )
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

        need_ria_extras = bool(persona_state.get("iam_schema_ready")) and (
            include_all or normalized_actor == "ria"
        )

        if need_ria_extras:
            try:
                ria_onboarding = await self._ria.get_ria_onboarding_status(user_id)
            except (IAMSchemaNotReadyError, RIAIAMPolicyError):
                ria_onboarding = None
            outgoing_entries = await self.list_outgoing_requests(user_id)
            try:
                invite_entries = await self._hydrate_entry_identities(
                    [
                        self._normalize_invite(item)
                        for item in await self._ria.list_ria_invites(user_id)
                    ]
                )
            except (IAMSchemaNotReadyError, RIAIAMPolicyError):
                invite_entries = []
            try:
                roster_payload = await self._ria.list_ria_clients(user_id)
                roster = list(roster_payload.get("items") or [])
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

    async def get_center_summary(
        self, user_id: str, *, actor: str, mode: str = "consents"
    ) -> dict[str, Any]:
        normalized_actor = "ria" if actor == "ria" else "investor"
        normalized_mode = "connections" if mode == "connections" else "consents"
        return {
            "user_id": user_id,
            "actor": normalized_actor,
            "mode": normalized_mode,
            "counts": {
                "pending": await self._get_surface_count(
                    user_id,
                    actor=normalized_actor,
                    surface="pending",
                    mode=normalized_mode,
                ),
                "active": await self._get_surface_count(
                    user_id,
                    actor=normalized_actor,
                    surface="active",
                    mode=normalized_mode,
                ),
                "previous": await self._get_surface_count(
                    user_id,
                    actor=normalized_actor,
                    surface="previous",
                    mode=normalized_mode,
                ),
            },
        }

    async def list_center(
        self,
        user_id: str,
        *,
        actor: str,
        surface: str,
        mode: str = "consents",
        query: str | None = None,
        top: int | None = None,
        page: int = 1,
        limit: int = 20,
    ) -> dict[str, Any]:
        normalized_actor = "ria" if actor == "ria" else "investor"
        normalized_surface = surface if surface in {"pending", "active", "previous"} else "pending"
        normalized_mode = "connections" if mode == "connections" else "consents"
        safe_top = max(1, min(int(top), 10)) if top is not None else None
        safe_limit = safe_top or max(1, min(limit, 100))
        safe_page = 1 if safe_top is not None else max(1, page)

        if normalized_actor == "investor":
            if normalized_surface == "pending":
                entries = await self._load_investor_pending_entries(user_id)
            elif normalized_surface == "active":
                entries = await self._load_investor_active_entries(user_id)
            else:
                entries = await self._load_investor_previous_entries(user_id)
            entries = self._filter_mode_entries(
                entries,
                actor=normalized_actor,
                mode=normalized_mode,
            )
            paged = self._paginate_entries(
                entries,
                page=safe_page,
                limit=safe_limit,
                query=query,
            )
        elif normalized_surface == "active":
            paged = await self._load_ria_active_entries(
                user_id,
                query=query,
                page=safe_page,
                limit=safe_limit,
            )
            items = self._filter_mode_entries(
                list(paged.get("items") or []),
                actor=normalized_actor,
                mode=normalized_mode,
            )
            paged = {
                "page": paged["page"],
                "limit": paged["limit"],
                "total": len(items),
                "has_more": False,
                "items": items,
            }
        else:
            outgoing_entries = await self._load_ria_outgoing_entries(user_id)
            invite_entries = await self._load_ria_invite_entries(user_id)
            entries = self._entries_for_surface(
                {
                    "outgoing_requests": outgoing_entries,
                    "invites": invite_entries,
                },
                actor="ria",
                surface=normalized_surface,
            )
            entries = self._filter_mode_entries(
                entries,
                actor=normalized_actor,
                mode=normalized_mode,
            )
            paged = self._paginate_entries(
                entries,
                page=safe_page,
                limit=safe_limit,
                query=query,
            )

        return {
            "user_id": user_id,
            "actor": normalized_actor,
            "surface": normalized_surface,
            "mode": normalized_mode,
            "query": query or "",
            "page": paged["page"],
            "limit": paged["limit"],
            "total": paged["total"],
            "has_more": paged["has_more"],
            "items": paged["items"],
        }
