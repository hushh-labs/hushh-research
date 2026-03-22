# hushh_mcp/services/consent_db.py
"""
Consent Database Service
========================

Service layer for consent-related database operations.

CONSENT-FIRST ARCHITECTURE:
    All consent operations go through this service.
    Provides methods for pending requests, active tokens, and audit logs.

Usage:
    from hushh_mcp.services.consent_db import ConsentDBService

    service = ConsentDBService()

    # Get pending requests
    pending = await service.get_pending_requests(user_id)

    # Get active tokens
    active = await service.get_active_tokens(user_id)

    # Insert consent event
    event_id = await service.insert_event(
        user_id=user_id,
        agent_id=agent_id,
        scope=scope,
        action="CONSENT_GRANTED",
        consent_token=token
    )
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from db.db_client import DatabaseExecutionError, get_db

logger = logging.getLogger(__name__)


class ConsentDBService:
    """
    Service layer for consent database operations.

    All consent-related database queries go through this service.
    """

    def __init__(self):
        self._supabase = None

    def _get_supabase(self):
        """Get database client (private - ONLY for internal service use)."""
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

    @staticmethod
    def _normalize_agent_id(agent_id: Optional[str]) -> str:
        return str(agent_id or "").strip().lower()

    @classmethod
    def _is_internal_event(
        cls,
        *,
        agent_id: Optional[str],
        action: Optional[str],
        scope: Optional[str],
    ) -> bool:
        normalized_agent = cls._normalize_agent_id(agent_id)
        normalized_action = str(action or "").strip().upper()
        normalized_scope = str(scope or "").strip().lower()

        if normalized_action == "OPERATION_PERFORMED":
            return True
        if normalized_agent in {"self", "agent_kai", "kai"}:
            return True
        if normalized_scope == "vault.owner" and normalized_agent in {"", "system"}:
            return True
        return False

    @classmethod
    def _is_external_audit_row(cls, row: Dict[str, Any]) -> bool:
        return not cls._is_internal_event(
            agent_id=row.get("agent_id"),
            action=row.get("action"),
            scope=row.get("scope"),
        )

    @staticmethod
    def _parse_metadata(metadata: Any) -> Dict[str, Any]:
        if isinstance(metadata, dict):
            return metadata
        if isinstance(metadata, str):
            try:
                parsed = json.loads(metadata)
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                return {}
        return {}

    @staticmethod
    def _is_missing_internal_access_events_error(exc: Exception) -> bool:
        message = str(exc)
        return "internal_access_events" in message and (
            "does not exist" in message or "UndefinedTable" in message
        )

    async def _get_legacy_internal_rows(
        self,
        user_id: str,
        *,
        agent_id: Optional[str] = None,
        scope: Optional[str] = None,
        actions: Optional[List[str]] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Fallback for older databases that still store self activity in consent_audit."""
        supabase = self._get_supabase()
        query = supabase.table("consent_audit").select("*").eq("user_id", user_id)
        if actions:
            query = query.in_("action", actions)
        query = query.order("issued_at", desc=True)
        if limit:
            query = query.limit(limit)

        response = query.execute()
        rows: List[Dict[str, Any]] = []
        for row in response.data or []:
            row_scope = row.get("scope")
            row_agent_id = row.get("agent_id") or ""
            if not self._is_internal_event(
                agent_id=row_agent_id,
                action=row.get("action"),
                scope=row_scope,
            ):
                continue
            if agent_id and row_agent_id != agent_id:
                continue
            if scope and row_scope != scope:
                continue
            rows.append(row)
        return rows

    # =========================================================================
    # Pending Requests
    # =========================================================================

    async def get_pending_requests(self, user_id: str) -> List[Dict]:
        """
        Get pending consent requests for a user.
        A request is pending if it has REQUESTED action with no resolution.

        Note: This uses Python post-processing to handle DISTINCT ON logic
        since Supabase REST API doesn't support complex SQL.
        """
        supabase = self._get_supabase()
        now_ms = int(datetime.now().timestamp() * 1000)

        # Fetch all relevant rows (we'll filter in Python)
        # Note: Cannot use .neq("request_id", None) - SQL "!= NULL" is always NULL (not true)
        # Instead, fetch all rows and filter request_id IS NOT NULL in Python
        response = (
            supabase.table("consent_audit")
            .select("*")
            .eq("user_id", user_id)
            .order("issued_at", desc=True)
            .execute()
        )

        # Post-process to get latest per request_id (DISTINCT ON equivalent)
        latest_per_request = {}
        for row in response.data:
            if not self._is_external_audit_row(row):
                continue
            request_id = row.get("request_id")
            if not request_id:
                continue

            # Keep only the latest entry per request_id
            if request_id not in latest_per_request:
                latest_per_request[request_id] = row
            else:
                # Compare issued_at timestamps
                current_issued = latest_per_request[request_id].get("issued_at", 0)
                new_issued = row.get("issued_at", 0)
                if new_issued > current_issued:
                    latest_per_request[request_id] = row

        # Filter to only REQUESTED actions that haven't timed out
        results = []
        for row in latest_per_request.values():
            if row.get("action") == "REQUESTED":
                poll_timeout_at = row.get("poll_timeout_at")
                if poll_timeout_at is None or poll_timeout_at > now_ms:
                    # Extract expiryHours from metadata JSON
                    metadata = row.get("metadata") or {}
                    if isinstance(metadata, str):
                        try:
                            metadata = json.loads(metadata) if metadata else {}
                        except json.JSONDecodeError:
                            metadata = {}
                    expiry_hours = metadata.get("expiry_hours", 24)

                    results.append(
                        {
                            "id": row.get("request_id"),
                            "developer": row.get("agent_id"),
                            "agent_id": row.get("agent_id"),
                            "scope": row.get("scope"),
                            "scopeDescription": row.get("scope_description"),
                            "requestedAt": row.get("issued_at"),
                            "pollTimeoutAt": poll_timeout_at,
                            "expiryHours": expiry_hours,
                            "metadata": metadata,
                            "bundleId": metadata.get("bundle_id"),
                            "bundleLabel": metadata.get("bundle_label"),
                            "bundleScopeCount": metadata.get("bundle_scope_count"),
                        }
                    )

        # Sort by issued_at descending
        results.sort(key=lambda x: x.get("requestedAt", 0), reverse=True)

        return results

    async def get_pending_by_request_id(self, user_id: str, request_id: str) -> Optional[Dict]:
        """Get a specific pending request by request_id."""
        supabase = self._get_supabase()

        response = (
            supabase.table("consent_audit")
            .select("*")
            .eq("user_id", user_id)
            .eq("request_id", request_id)
            .order("issued_at", desc=True)
            .limit(1)
            .execute()
        )

        if response.data and len(response.data) > 0:
            row = response.data[0]
            if not self._is_external_audit_row(row):
                return None
            if row.get("action") == "REQUESTED":
                metadata = self._parse_metadata(row.get("metadata"))
                return {
                    "request_id": row.get("request_id"),
                    "developer": row.get("agent_id"),
                    "agent_id": row.get("agent_id"),
                    "scope": row.get("scope"),
                    "scope_description": row.get("scope_description"),
                    "poll_timeout_at": row.get("poll_timeout_at"),
                    "issued_at": row.get("issued_at"),
                    "metadata": metadata,
                    "bundle_id": metadata.get("bundle_id"),
                    "bundle_label": metadata.get("bundle_label"),
                    "bundle_scope_count": metadata.get("bundle_scope_count"),
                }
        return None

    # =========================================================================
    # Active Tokens
    # =========================================================================

    async def get_active_tokens(
        self,
        user_id: str,
        agent_id: Optional[str] = None,
        scope: Optional[str] = None,
    ) -> List[Dict]:
        """
        Get active consent tokens for a user.
        Active = CONSENT_GRANTED with no subsequent REVOKED and not expired.

        Note: Uses Python post-processing to handle DISTINCT ON logic.
        Uniqueness is keyed by (agent_id, scope), not just scope.
        """
        supabase = self._get_supabase()
        now_ms = int(datetime.now().timestamp() * 1000)

        # Fetch all CONSENT_GRANTED and REVOKED actions
        response = (
            supabase.table("consent_audit")
            .select("*")
            .eq("user_id", user_id)
            .in_("action", ["CONSENT_GRANTED", "REVOKED"])
            .order("issued_at", desc=True)
            .execute()
        )

        # Post-process to get latest per (agent_id, scope) (DISTINCT ON equivalent)
        latest_per_agent_scope = {}
        for row in response.data:
            if not self._is_external_audit_row(row):
                continue
            row_scope = row.get("scope")
            row_agent_id = row.get("agent_id") or ""
            if not row_scope:
                continue

            if agent_id and row_agent_id != agent_id:
                continue
            if scope and row_scope != scope:
                continue

            key = (row_agent_id, row_scope)
            if key not in latest_per_agent_scope:
                latest_per_agent_scope[key] = row
                continue

            current_issued = latest_per_agent_scope[key].get("issued_at", 0)
            new_issued = row.get("issued_at", 0)
            if new_issued > current_issued:
                latest_per_agent_scope[key] = row

        # Filter to only active (CONSENT_GRANTED and not expired)
        results = []
        for row in latest_per_agent_scope.values():
            if row.get("action") == "CONSENT_GRANTED":
                expires_at = row.get("expires_at")
                if expires_at is None or expires_at > now_ms:
                    token_id = row.get("token_id")
                    results.append(
                        {
                            "id": token_id[:20] + "..."
                            if token_id and len(token_id) > 20
                            else str(row.get("id")),
                            "scope": row.get("scope"),
                            "developer": row.get("agent_id"),
                            "agent_id": row.get("agent_id"),
                            "issued_at": row.get("issued_at"),
                            "expires_at": expires_at,
                            "time_remaining_ms": (expires_at - now_ms) if expires_at else 0,
                            "request_id": row.get("request_id"),
                            "token_id": token_id,
                            "metadata": self._parse_metadata(row.get("metadata")) or None,
                        }
                    )

        return results

    async def get_active_internal_tokens(
        self,
        user_id: str,
        agent_id: Optional[str] = None,
        scope: Optional[str] = None,
    ) -> List[Dict]:
        """Get active internal/self tokens without exposing them to the external consent ledger."""
        now_ms = int(datetime.now().timestamp() * 1000)
        try:
            supabase = self._get_supabase()
            response_data = (
                supabase.table("internal_access_events")
                .select("*")
                .eq("user_id", user_id)
                .in_("action", ["CONSENT_GRANTED", "REVOKED"])
                .order("issued_at", desc=True)
                .execute()
            ).data or []
        except DatabaseExecutionError as exc:
            if not self._is_missing_internal_access_events_error(exc):
                raise
            logger.warning(
                "internal_access_events_missing fallback=consent_audit action=get_active_internal_tokens"
            )
            response_data = await self._get_legacy_internal_rows(
                user_id,
                agent_id=agent_id,
                scope=scope,
                actions=["CONSENT_GRANTED", "REVOKED"],
            )

        latest_per_agent_scope = {}
        for row in response_data:
            row_scope = row.get("scope")
            row_agent_id = row.get("agent_id") or ""
            if not row_scope:
                continue
            if agent_id and row_agent_id != agent_id:
                continue
            if scope and row_scope != scope:
                continue

            key = (row_agent_id, row_scope)
            current = latest_per_agent_scope.get(key)
            if current is None or (row.get("issued_at") or 0) > (current.get("issued_at") or 0):
                latest_per_agent_scope[key] = row

        results = []
        for row in latest_per_agent_scope.values():
            if row.get("action") != "CONSENT_GRANTED":
                continue
            expires_at = row.get("expires_at")
            if expires_at is not None and expires_at <= now_ms:
                continue
            token_id = row.get("token_id")
            results.append(
                {
                    "id": token_id[:20] + "..."
                    if token_id and len(token_id) > 20
                    else str(row.get("id")),
                    "scope": row.get("scope"),
                    "developer": row.get("agent_id"),
                    "agent_id": row.get("agent_id"),
                    "issued_at": row.get("issued_at"),
                    "expires_at": expires_at,
                    "time_remaining_ms": (expires_at - now_ms) if expires_at else 0,
                    "request_id": row.get("request_id"),
                    "token_id": token_id,
                    "scope_description": row.get("scope_description"),
                }
            )

        return results

    async def is_token_active(
        self, user_id: str, scope: str, agent_id: Optional[str] = None
    ) -> bool:
        """Check if there's an active token for user+scope (+agent_id when provided)."""
        now_ms = int(datetime.now().timestamp() * 1000)
        normalized_scope = str(scope or "").strip()
        normalized_agent_id = agent_id or None
        is_internal_lookup = self._is_internal_event(
            agent_id=normalized_agent_id,
            action="CONSENT_GRANTED",
            scope=normalized_scope,
        )

        rows: List[Dict[str, Any]]

        if is_internal_lookup:
            try:
                supabase = self._get_supabase()
                query = (
                    supabase.table("internal_access_events")
                    .select("action,expires_at,issued_at")
                    .eq("user_id", user_id)
                    .eq("scope", normalized_scope)
                    .in_("action", ["CONSENT_GRANTED", "REVOKED"])
                )
                if normalized_agent_id:
                    query = query.eq("agent_id", normalized_agent_id)
                rows = query.order("issued_at", desc=True).limit(1).execute().data or []
            except DatabaseExecutionError as exc:
                if not self._is_missing_internal_access_events_error(exc):
                    raise
                logger.warning(
                    "internal_access_events_missing fallback=consent_audit action=is_token_active"
                )
                rows = await self._get_legacy_internal_rows(
                    user_id,
                    agent_id=normalized_agent_id,
                    scope=normalized_scope,
                    actions=["CONSENT_GRANTED", "REVOKED"],
                    limit=1,
                )
        else:
            supabase = self._get_supabase()
            query = (
                supabase.table("consent_audit")
                .select("action,expires_at,issued_at")
                .eq("user_id", user_id)
                .eq("scope", normalized_scope)
                .in_("action", ["CONSENT_GRANTED", "REVOKED"])
            )
            if normalized_agent_id:
                query = query.eq("agent_id", normalized_agent_id)
            rows = query.order("issued_at", desc=True).limit(1).execute().data or []

        if not rows:
            return False

        row = rows[0]
        if row.get("action") != "CONSENT_GRANTED":
            return False

        expires_at = row.get("expires_at")
        return expires_at is None or expires_at > now_ms

    async def was_recently_denied(
        self,
        user_id: str,
        scope: str,
        cooldown_seconds: int = 60,
        agent_id: Optional[str] = None,
    ) -> bool:
        """
        Check if consent was recently denied for user+scope.

        This prevents MCP from immediately re-requesting after a denial,
        which would cause duplicate toast notifications.
        """
        supabase = self._get_supabase()
        now_ms = int(datetime.now().timestamp() * 1000)
        cooldown_ms = cooldown_seconds * 1000
        cutoff_ms = now_ms - cooldown_ms

        response = (
            supabase.table("consent_audit")
            .select("action,issued_at")
            .eq("user_id", user_id)
            .eq("scope", scope)
            .eq("action", "CONSENT_DENIED")
            .gt("issued_at", cutoff_ms)
        )
        if agent_id:
            response = response.eq("agent_id", agent_id)

        response = response.order("issued_at", desc=True).limit(1).execute()

        return len(response.data) > 0 if response.data else False

    # =========================================================================
    # Audit Log
    # =========================================================================

    async def get_audit_log(self, user_id: str, page: int = 1, limit: int = 50) -> Dict:
        """Get paginated audit log for a user."""
        supabase = self._get_supabase()
        offset = (page - 1) * limit
        now_ms = int(datetime.now().timestamp() * 1000)

        # Get paginated results (TableQuery uses .limit/.offset, not .range)
        response = (
            supabase.table("consent_audit")
            .select("*")
            .eq("user_id", user_id)
            .order("issued_at", desc=True)
            .limit(limit)
            .offset(offset)
            .execute()
        )

        # Get total count via separate query (capped at 5000 for display)
        count_response = (
            supabase.table("consent_audit")
            .select("id")
            .eq("user_id", user_id)
            .limit(5000)
            .execute()
        )
        filtered_rows = [row for row in (response.data or []) if self._is_external_audit_row(row)]
        total = len(
            [row for row in (count_response.data or []) if self._is_external_audit_row(row)]
        )

        items = []
        for row in filtered_rows:
            # Parse metadata JSON if present
            metadata = self._parse_metadata(row.get("metadata")) or None

            token_id = row.get("token_id")
            items.append(
                {
                    "id": str(row.get("id")),
                    "token_id": token_id[:20] + "..."
                    if token_id and len(token_id) > 20
                    else token_id or "N/A",
                    "agent_id": row.get("agent_id"),
                    "scope": row.get("scope"),
                    "action": row.get("action"),
                    "issued_at": row.get("issued_at"),
                    "expires_at": row.get("expires_at"),
                    "request_id": row.get("request_id"),
                    "scope_description": row.get("scope_description"),
                    "metadata": metadata,
                    # Detect timed out: REQUESTED with poll_timeout_at in the past
                    "is_timed_out": row.get("action") == "REQUESTED"
                    and row.get("poll_timeout_at")
                    and row.get("poll_timeout_at") < now_ms,
                }
            )

        return {
            "items": items,
            "total": total,
            "page": page,
            "limit": limit,
        }

    async def get_internal_activity_summary(self, user_id: str, limit: int = 8) -> Dict[str, Any]:
        """Return a small self/internal activity summary for a separate investor-facing surface."""
        now_ms = int(datetime.now().timestamp() * 1000)
        day_cutoff_ms = now_ms - (24 * 60 * 60 * 1000)
        try:
            supabase = self._get_supabase()
            recent_rows = (
                supabase.table("internal_access_events")
                .select("*")
                .eq("user_id", user_id)
                .order("issued_at", desc=True)
                .limit(limit)
                .execute()
            ).data or []
            daily_rows = (
                supabase.table("internal_access_events")
                .select("id")
                .eq("user_id", user_id)
                .gt("issued_at", day_cutoff_ms)
                .limit(5000)
                .execute()
            ).data or []
        except DatabaseExecutionError as exc:
            if not self._is_missing_internal_access_events_error(exc):
                raise
            logger.warning(
                "internal_access_events_missing fallback=consent_audit action=get_internal_activity_summary"
            )
            legacy_rows = await self._get_legacy_internal_rows(user_id, limit=5000)
            recent_rows = legacy_rows[:limit]
            daily_rows = [row for row in legacy_rows if (row.get("issued_at") or 0) > day_cutoff_ms]
        active_sessions = await self.get_active_internal_tokens(
            user_id,
            agent_id="self",
            scope="vault.owner",
        )

        recent_items = []
        for row in recent_rows:
            metadata = self._parse_metadata(row.get("metadata")) or None
            recent_items.append(
                {
                    "id": str(row.get("id") or row.get("token_id") or ""),
                    "agent_id": row.get("agent_id"),
                    "scope": row.get("scope"),
                    "action": row.get("action"),
                    "scope_description": row.get("scope_description"),
                    "issued_at": row.get("issued_at"),
                    "expires_at": row.get("expires_at"),
                    "metadata": metadata,
                }
            )

        return {
            "active_sessions": len(active_sessions),
            "recent_operations_24h": len(daily_rows),
            "last_activity_at": recent_items[0].get("issued_at") if recent_items else None,
            "recent": recent_items,
        }

    async def delete_audit_log(
        self,
        user_id: str,
        *,
        agent_id: Optional[str] = None,
        request_id: Optional[str] = None,
        clear_all: bool = False,
    ) -> Dict:
        """
        Delete audit log rows for a user.

        Safety guards:
        - Disallow broad deletes unless clear_all=True.
        - Block delete when active consents would be impacted.
        """
        supabase = self._get_supabase()

        if not clear_all and not agent_id and not request_id:
            raise ValueError("At least one filter (agent_id or request_id) is required")

        # Deleting audit rows that are still driving active consents would create
        # inconsistent session state in the UI; require revoke-first behavior.
        active_tokens = await self.get_active_tokens(user_id)
        if clear_all and active_tokens:
            return {
                "deleted": 0,
                "blocked": True,
                "reason": "active_consents_present",
                "active_count": len(active_tokens),
            }

        if agent_id:
            active_for_agent = [
                token for token in active_tokens if token.get("agent_id") == agent_id
            ]
            if active_for_agent:
                return {
                    "deleted": 0,
                    "blocked": True,
                    "reason": "active_consents_present",
                    "active_count": len(active_for_agent),
                }

        if request_id:
            active_for_request = [
                token for token in active_tokens if token.get("request_id") == request_id
            ]
            if active_for_request:
                return {
                    "deleted": 0,
                    "blocked": True,
                    "reason": "active_consents_present",
                    "active_count": len(active_for_request),
                }

        delete_query = supabase.table("consent_audit").delete().eq("user_id", user_id)
        if agent_id:
            delete_query = delete_query.eq("agent_id", agent_id)
        if request_id:
            delete_query = delete_query.eq("request_id", request_id)

        response = delete_query.execute()
        deleted = len(response.data or [])

        return {
            "deleted": deleted,
            "blocked": False,
            "reason": None,
            "active_count": 0,
        }

    # =========================================================================
    # Event Insertion
    # =========================================================================

    async def insert_event(
        self,
        user_id: str,
        agent_id: str,
        scope: str,
        action: str,
        token_id: Optional[str] = None,
        request_id: Optional[str] = None,
        scope_description: Optional[str] = None,
        expires_at: Optional[int] = None,
        poll_timeout_at: Optional[int] = None,
        metadata: Optional[Dict] = None,
    ) -> int:
        """
        Insert a consent event into consent_audit table.

        Uses event-sourcing pattern - all actions (REQUESTED, GRANTED, DENIED, REVOKED)
        are separate events. The latest event per scope determines current state.

        Returns the event ID.
        """
        if self._is_internal_event(agent_id=agent_id, action=action, scope=scope):
            return await self.insert_internal_event(
                user_id=user_id,
                agent_id=agent_id,
                scope=scope,
                action=action,
                token_id=token_id,
                request_id=request_id,
                scope_description=scope_description,
                expires_at=expires_at,
                metadata=metadata,
            )

        supabase = self._get_supabase()

        issued_at = int(datetime.now().timestamp() * 1000)
        token_id = token_id or f"evt_{issued_at}"

        # Prepare metadata as JSON string
        metadata_json = json.dumps(metadata) if metadata else None

        data = {
            "token_id": token_id,
            "user_id": user_id,
            "agent_id": agent_id,
            "scope": scope,
            "action": action,
            "request_id": request_id,
            "scope_description": scope_description,
            "issued_at": issued_at,
            "expires_at": expires_at,
            "poll_timeout_at": poll_timeout_at,
            "metadata": metadata_json,
        }

        # Remove None values
        data = {k: v for k, v in data.items() if v is not None}

        response = supabase.table("consent_audit").insert(data).execute()

        # Extract event ID from response
        if response.data and len(response.data) > 0:
            event_id = response.data[0].get("id")
            logger.info(f"Inserted {action} event: {event_id}")
            return event_id
        else:
            # Fallback: return issued_at as ID if response doesn't have id
            logger.warning(
                f"Inserted {action} event but no ID returned, using issued_at: {issued_at}"
            )
            return issued_at

    async def insert_internal_event(
        self,
        user_id: str,
        agent_id: str,
        scope: str,
        action: str,
        token_id: Optional[str] = None,
        request_id: Optional[str] = None,
        scope_description: Optional[str] = None,
        expires_at: Optional[int] = None,
        metadata: Optional[Dict] = None,
    ) -> int:
        """Insert an internal/self activity event into the internal ledger."""
        supabase = self._get_supabase()
        issued_at = int(datetime.now().timestamp() * 1000)
        token_id = token_id or f"evt_{issued_at}"
        metadata_json = json.dumps(metadata) if metadata else None

        data = {
            "token_id": token_id,
            "user_id": user_id,
            "agent_id": agent_id,
            "scope": scope,
            "action": action,
            "request_id": request_id,
            "scope_description": scope_description,
            "issued_at": issued_at,
            "expires_at": expires_at,
            "metadata": metadata_json,
        }
        data = {k: v for k, v in data.items() if v is not None}

        try:
            response = supabase.table("internal_access_events").insert(data).execute()
        except DatabaseExecutionError as exc:
            if not self._is_missing_internal_access_events_error(exc):
                raise
            logger.warning(
                "internal_access_events_missing fallback=consent_audit action=insert_internal_event"
            )
            response = supabase.table("consent_audit").insert(data).execute()
        if response.data and len(response.data) > 0:
            event_id = response.data[0].get("id")
            logger.info("Inserted internal %s event: %s", action, event_id)
            return event_id

        logger.warning(
            "Inserted internal %s event but no ID returned, using issued_at: %s",
            action,
            issued_at,
        )
        return issued_at

    async def get_timed_out_requests(self) -> List[Dict]:
        """
        Return REQUESTED rows that have passed poll_timeout_at and do not yet have a TIMEOUT event.
        Used by the optional timeout job to emit TIMEOUT events over SSE.
        """
        supabase = self._get_supabase()
        now_ms = int(datetime.now().timestamp() * 1000)
        # poll_timeout_at < now_ms excludes null (SQL: null < x is false)
        response = (
            supabase.table("consent_audit")
            .select("request_id, user_id, scope, agent_id, scope_description, issued_at")
            .eq("action", "REQUESTED")
            .lt("poll_timeout_at", now_ms)
            .execute()
        )
        if not response.data:
            return []
        # Dedupe by request_id (keep latest by issued_at)
        by_req: Dict[str, Dict] = {}
        for row in response.data:
            rid = row.get("request_id")
            if not rid:
                continue
            if rid not in by_req or (row.get("issued_at") or 0) > (
                by_req[rid].get("issued_at") or 0
            ):
                by_req[rid] = row
        request_ids = list(by_req.keys())
        if not request_ids:
            return []
        # Which of these already have a TIMEOUT?
        timeout_resp = (
            supabase.table("consent_audit")
            .select("request_id")
            .eq("action", "TIMEOUT")
            .in_("request_id", request_ids)
            .execute()
        )
        already = {r.get("request_id") for r in (timeout_resp.data or []) if r.get("request_id")}
        return [by_req[rid] for rid in request_ids if rid not in already]

    async def emit_timeout_events(self) -> int:
        """
        Find REQUESTED rows that have timed out, insert TIMEOUT events (triggers NOTIFY → SSE).
        Returns the number of TIMEOUT events inserted.
        """
        from hushh_mcp.services.ria_iam_service import RIAIAMService

        rows = await self.get_timed_out_requests()
        count = 0
        for row in rows:
            try:
                await self.insert_event(
                    user_id=row["user_id"],
                    agent_id=row.get("agent_id") or "system",
                    scope=row.get("scope") or "",
                    action="TIMEOUT",
                    request_id=row.get("request_id"),
                    scope_description=row.get("scope_description"),
                )
                try:
                    await RIAIAMService().sync_relationship_from_consent_action(
                        user_id=row["user_id"],
                        request_id=row.get("request_id"),
                        action="TIMEOUT",
                        agent_id=row.get("agent_id"),
                        scope=row.get("scope"),
                    )
                except Exception as sync_error:
                    logger.warning(
                        "Emit TIMEOUT relationship sync failed for request_id=%s: %s",
                        row.get("request_id"),
                        sync_error,
                    )
                count += 1
            except Exception as e:
                logger.warning(
                    "Emit TIMEOUT event failed for request_id=%s: %s", row.get("request_id"), e
                )
        return count

    async def log_operation(
        self,
        user_id: str,
        operation: str,
        target: Optional[str] = None,
        metadata: Optional[Dict] = None,
    ) -> int:
        """
        Log an operation performed using vault.owner token.

        This provides granular audit logging for vault owner operations,
        showing WHAT operation was performed (e.g., kai.analyze) and
        on WHAT target (e.g., AAPL ticker).

        Args:
            user_id: The user performing the operation
            operation: The operation type (e.g., "kai.analyze", "kai.preferences.read")
            target: Optional target of the operation (e.g., "AAPL" for ticker analysis)
            metadata: Additional context to store

        Returns:
            The event ID
        """
        operation_metadata = {
            "operation": operation,
            **({"target": target} if target else {}),
            **(metadata or {}),
        }

        return await self.insert_internal_event(
            user_id=user_id,
            agent_id="self",
            scope="vault.owner",
            action="OPERATION_PERFORMED",
            scope_description=operation,
            metadata=operation_metadata,
        )

    # =========================================================================
    # SSE Event Helpers
    # =========================================================================

    async def get_recent_consent_events(
        self, user_id: str, after_timestamp_ms: int, limit: int = 10
    ) -> List[Dict]:
        """
        Get recent consent events after a timestamp for SSE streaming.

        Args:
            user_id: The user ID
            after_timestamp_ms: Only get events after this timestamp (ms)
            limit: Maximum events to return

        Returns:
            List of consent events
        """
        supabase = self._get_supabase()

        response = (
            supabase.table("consent_audit")
            .select(
                "token_id,request_id,action,scope,agent_id,issued_at,scope_description,metadata,expires_at"
            )
            .eq("user_id", user_id)
            .in_(
                "action",
                [
                    "REQUESTED",
                    "CONSENT_GRANTED",
                    "CONSENT_DENIED",
                    "REVOKED",
                    "CANCELLED",
                    "TIMEOUT",
                ],
            )
            .gt("issued_at", after_timestamp_ms)
            .order("issued_at", desc=True)
            .limit(limit)
            .execute()
        )
        events = []
        for row in response.data or []:
            if not self._is_external_audit_row(row):
                continue
            metadata = self._parse_metadata(row.get("metadata"))
            events.append(
                {
                    **row,
                    "metadata": metadata,
                    "bundle_id": metadata.get("bundle_id"),
                    "bundle_label": metadata.get("bundle_label"),
                    "bundle_scope_count": metadata.get("bundle_scope_count"),
                }
            )
        return events

    async def get_resolved_request(self, user_id: str, request_id: str) -> Optional[Dict]:
        """
        Check if a specific consent request has been resolved.

        Args:
            user_id: The user ID
            request_id: The request ID to check

        Returns:
            Resolution event if found, None otherwise
        """
        supabase = self._get_supabase()

        response = (
            supabase.table("consent_audit")
            .select("action,scope,agent_id,issued_at")
            .eq("user_id", user_id)
            .eq("request_id", request_id)
            .in_("action", ["CONSENT_GRANTED", "CONSENT_DENIED"])
            .order("issued_at", desc=True)
            .limit(1)
            .execute()
        )

        if response.data and len(response.data) > 0:
            row = response.data[0]
            if not self._is_external_audit_row(row):
                return None
            return row
        return None

    async def get_request_status(self, user_id: str, request_id: str) -> Optional[Dict]:
        """Return the latest external consent event for one request_id."""
        supabase = self._get_supabase()

        response = (
            supabase.table("consent_audit")
            .select(
                "id,token_id,request_id,action,scope,agent_id,issued_at,scope_description,metadata,expires_at,poll_timeout_at"
            )
            .eq("user_id", user_id)
            .eq("request_id", request_id)
            .order("issued_at", desc=True)
            .limit(1)
            .execute()
        )

        if response.data and len(response.data) > 0:
            row = response.data[0]
            if not self._is_external_audit_row(row):
                return None
            metadata = self._parse_metadata(row.get("metadata"))
            return {
                **row,
                "metadata": metadata,
                "bundle_id": metadata.get("bundle_id"),
                "bundle_label": metadata.get("bundle_label"),
                "bundle_scope_count": metadata.get("bundle_scope_count"),
            }
        return None

    # =========================================================================
    # Consent Exports (MCP Zero-Knowledge Flow)
    # =========================================================================

    async def store_consent_export(
        self,
        consent_token: str,
        user_id: str,
        encrypted_data: str,
        iv: str,
        tag: str,
        export_key: str | None,
        wrapped_key_bundle: Dict | None,
        scope: str,
        expires_at_ms: int,
    ) -> bool:
        """
        Store encrypted export data for MCP zero-knowledge flow.

        This persists the encrypted data to the database so it survives
        server restarts and is available across all instances.

        Args:
            consent_token: The consent token this export is for
            user_id: The user ID
            encrypted_data: Base64-encoded ciphertext
            iv: Base64-encoded initialization vector
            tag: Base64-encoded authentication tag
            export_key: Legacy plaintext export key for backwards compatibility only
            wrapped_key_bundle: Wrapped export-key metadata for strict zero-knowledge flow
            scope: The scope this export is for
            expires_at_ms: Expiry timestamp in milliseconds

        Returns:
            True if stored successfully, False otherwise
        """
        supabase = self._get_supabase()

        # Convert ms timestamp to ISO format for Supabase
        from datetime import datetime, timezone

        expires_at = datetime.fromtimestamp(expires_at_ms / 1000, tz=timezone.utc).isoformat()

        try:
            stored_export_key = (
                json.dumps(wrapped_key_bundle)
                if isinstance(wrapped_key_bundle, dict) and wrapped_key_bundle
                else export_key
            )
            # Upsert to handle re-approvals
            supabase.table("consent_exports").upsert(
                {
                    "consent_token": consent_token,
                    "user_id": user_id,
                    "encrypted_data": encrypted_data,
                    "iv": iv,
                    "tag": tag,
                    "export_key": stored_export_key,
                    "scope": scope,
                    "expires_at": expires_at,
                },
                on_conflict="consent_token",
            ).execute()

            logger.info(f"Stored consent export for token: {consent_token[:30]}...")
            return True
        except Exception as e:
            logger.error(f"Failed to store consent export: {e}")
            return False

    async def get_consent_export(self, consent_token: str) -> Optional[Dict]:
        """
        Retrieve encrypted export data for a consent token.

        Args:
            consent_token: The consent token to look up

        Returns:
            Export data dict if found and not expired, None otherwise
        """
        supabase = self._get_supabase()

        try:
            response = (
                supabase.table("consent_exports")
                .select("*")
                .eq("consent_token", consent_token)
                .gt("expires_at", datetime.now(timezone.utc).isoformat())
                .limit(1)
                .execute()
            )

            if response.data and len(response.data) > 0:
                row = response.data[0]
                return {
                    "encrypted_data": row.get("encrypted_data"),
                    "iv": row.get("iv"),
                    "tag": row.get("tag"),
                    "export_key": row.get("export_key"),
                    "wrapped_key_bundle": self._parse_metadata(row.get("export_key")) or None,
                    "scope": row.get("scope"),
                    "created_at": row.get("created_at"),
                }
            return None
        except Exception as e:
            logger.error(f"Failed to get consent export: {e}")
            return None

    async def delete_consent_export(self, consent_token: str) -> bool:
        """
        Delete a consent export (e.g., when consent is revoked).

        Args:
            consent_token: The consent token to delete export for

        Returns:
            True if deleted, False otherwise
        """
        supabase = self._get_supabase()

        try:
            supabase.table("consent_exports").delete().eq("consent_token", consent_token).execute()

            logger.info(f"Deleted consent export for token: {consent_token[:30]}...")
            return True
        except Exception as e:
            logger.error(f"Failed to delete consent export: {e}")
            return False

    async def cleanup_expired_exports(self) -> int:
        """
        Clean up expired consent exports.

        Returns:
            Number of exports deleted
        """
        supabase = self._get_supabase()

        try:
            # Call the cleanup function
            response = supabase.rpc("cleanup_expired_consent_exports").execute()

            if response.data is not None:
                deleted_count = response.data
                logger.info(f"Cleaned up {deleted_count} expired consent exports")
                return deleted_count
            return 0
        except Exception as e:
            logger.error(f"Failed to cleanup expired exports: {e}")
            return 0
