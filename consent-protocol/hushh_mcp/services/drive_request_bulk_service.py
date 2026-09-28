"""One requester, one durable Drive search, one exact frozen share review."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import UTC, datetime

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_permission_executor import recipient_identity_for_user
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.drive_suggestion_service import (
    LiveSearchPlan,
    interpret_live_search,
    plan_live_search,
)
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError


class DriveRequestBulkService:
    def __init__(
        self,
        *,
        sharing=None,
        search=None,
        bulk=None,
        planner=interpret_live_search,
        recipient_identity=None,
        require_owner=None,
        wake=None,
    ):
        self.sharing = sharing or DriveSharingStore()
        self.search = search or DriveOwnerSearchService()
        self.bulk = bulk or DriveBulkShareStore()
        self.planner = planner
        self.recipient_identity = recipient_identity or recipient_identity_for_user
        self.require_owner = require_owner
        self.wake = wake or wake_drive_work

    async def _owner(self):
        if self.require_owner is None:
            raise DriveSharingError("owner_authority_required")
        await self.require_owner()

    async def _context(self, user_id, request_id, *, start=False):
        await self._owner()
        context = await self.sharing.request_bulk_context(
            user_id=user_id, request_id=request_id, start=start
        )
        await self._owner()
        return context

    async def _plan(self, *, user_id, purpose, timezone):
        query = purpose["purpose"]
        # A direct recurring standup request is unambiguously topical. The
        # broad Drive token includes notes under variant meeting titles and
        # shortcuts; time is checked across title/created/modified metadata.
        if re.search(r"\bstand[ -]?up\b", query, re.I) and re.search(r"\bnotes?\b", query, re.I):
            return LiveSearchPlan(terms=["standup"], file_kind="document", mode="find")
        async with asyncio.timeout(65):
            plan = await plan_live_search(
                self.planner,
                prompt=json.dumps(
                    {
                        "document_request": purpose,
                        "current_time_utc": datetime.now(UTC).isoformat(timespec="seconds"),
                        "user_timezone": timezone,
                    },
                    ensure_ascii=False,
                ),
                user_id=user_id,
            )
        if plan.mode != "find":
            raise DriveReadError("invalid_argument")
        return plan

    async def start_search(self, *, user_id, request_id, timezone="UTC"):
        context = await self._context(user_id, request_id, start=True)
        existing = await self.search.store.by_client(user_id=user_id, client_request_id=request_id)
        if existing is not None and existing["status"] not in {"failed", "limited", "stopped"}:
            return existing
        plan = await self._plan(user_id=user_id, purpose=context["purpose"], timezone=timezone)
        await self._owner()
        return await self.search.create_for_request(
            user_id=user_id,
            request_id=request_id,
            request_revision=context["revision"],
            purpose=context["purpose"],
            plan=plan.model_dump(mode="json"),
            timezone=timezone,
            require_current=self.require_owner,
        )

    async def search_status(self, *, user_id, request_id):
        await self._context(user_id, request_id)
        return await self.search.store.by_client(user_id=user_id, client_request_id=request_id)

    async def search_files(self, *, user_id, request_id, cursor=None):
        state = await self.search_status(user_id=user_id, request_id=request_id)
        if state is None:
            raise DriveReadError("search_not_found")
        return await self.search.results(
            user_id=user_id,
            job_id=state["jobId"],
            cursor=cursor,
            require_current=self.require_owner,
        )

    async def review_context(self, *, user_id, request_id):
        context = await self._context(user_id, request_id)
        if not context["searchStarted"]:
            return {"search": None, "bulkShare": None}
        search = await self.search.store.by_client(user_id=user_id, client_request_id=request_id)
        bulk = await self.bulk.by_request(user_id=user_id, request_id=request_id)
        await self._owner()
        return {"search": search, "bulkShare": bulk}

    async def prepare(self, *, user_id, request_id, excluded_positions=None):
        context = await self._context(user_id, request_id)
        if context["status"] not in {"pending", "review_ready"} or not context["searchStarted"]:
            raise DriveSharingError("request_changed")
        state = await self.search.store.by_client(user_id=user_id, client_request_id=request_id)
        if state is None:
            raise DriveSharingError("search_not_found")
        if state["status"] != "completed" or state["incompleteSearch"]:
            raise DriveSharingError("search_incomplete")
        verified = await self.recipient_identity(context["recipientUserId"])
        if (
            verified.user_id != context["recipientUserId"]
            or verified.subject != context["recipient"]["subject"]
            or verified.email != context["recipient"]["email"]
            or verified.kind != context["recipient"].get("kind", "google_provider")
        ):
            raise DriveSharingError("recipient_changed")
        await self._owner()
        result = await self.bulk.create_review(
            user_id=user_id,
            search_job_id=state["jobId"],
            client_request_id=request_id,
            origin_request_id=request_id,
            recipients=[
                {
                    "userId": verified.user_id,
                    "email": verified.email,
                    "subject": verified.subject,
                    "kind": verified.kind,
                    "name": None,
                }
            ],
            excluded=[],
            excluded_positions=excluded_positions or [],
        )
        await self._owner()
        return result
