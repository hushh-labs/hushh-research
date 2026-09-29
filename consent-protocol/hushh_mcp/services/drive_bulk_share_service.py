"""Owner-reviewed bulk sharing of one completed Drive search's frozen file set.

The saved search grants metadata collection only. A separate review and explicit
approval are required before the durable worker may create any permissions.
"""

from __future__ import annotations

import asyncio
import time

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_owner_share_store import DriveOwnerShareStore
from hushh_mcp.services.drive_permission_executor import recipient_identity_for_user
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_telemetry import drive_logger, drive_operation
from hushh_mcp.services.drive_work_wake import wake_drive_work

logger = drive_logger(__name__)


class DriveBulkShareService:
    def __init__(
        self,
        *,
        store=None,
        owner_shares=None,
        recipient_identity=None,
        require_owner=None,
        wake=None,
    ):
        if store is None:
            from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore

            store = DriveBulkShareStore()
        self.store = store
        self.owner_shares = owner_shares or DriveOwnerShareStore()
        self.recipient_identity = recipient_identity or recipient_identity_for_user
        self.require_owner = require_owner
        self.wake = wake or wake_drive_work

    async def _owner(self):
        if self.require_owner is None:
            raise DriveSharingError("owner_authority_required")
        await self.require_owner()

    @staticmethod
    def _admit(user_id: str):
        if not all(
            connector_feature_enabled(feature, user_id)
            for feature in ("drive_document_sharing", "google_drive_chat_reads")
        ):
            raise DriveSharingError("sharing_unavailable")

    @drive_operation(job_key="search_job_id")
    async def prepare(self, *, user_id: str, search_job_id: str, client_request_id: str) -> dict:
        """Prepare a review of the complete saved result set, without sharing."""
        started = time.perf_counter()
        await self._owner()
        self._admit(user_id)
        circle = await self.owner_shares.trusted_recipients(user_id=user_id)
        excluded = [
            {"name": item.get("name"), "reason": item["reason"]} for item in circle["excluded"]
        ]

        async def resolve(member):
            try:
                identity = await self.recipient_identity(member["userId"])
            except DriveSharingError as error:
                reason = {
                    "recipient_google_identity_required": "no_google_account",
                    "recipient_verified_email_required": "no_verified_email",
                }.get(str(error), "unavailable")
                return None, {"name": member.get("name"), "reason": reason}
            if identity.user_id != member["userId"]:
                return None, {"name": member.get("name"), "reason": "unavailable"}
            return (
                {
                    "userId": identity.user_id,
                    "name": member.get("name"),
                    "email": identity.email,
                    "subject": identity.subject,
                    "kind": identity.kind,
                },
                None,
            )

        # Trusted-circle membership is bounded by the existing roster contract.
        resolved = await asyncio.gather(*(resolve(member) for member in circle["eligible"]))
        recipients = [recipient for recipient, _ in resolved if recipient is not None]
        excluded.extend(reason for _, reason in resolved if reason is not None)
        await self._owner()
        review = await self.store.create_review(
            user_id=user_id,
            search_job_id=search_job_id,
            client_request_id=client_request_id,
            recipients=recipients,
            excluded=excluded,
        )
        await self._owner()
        logger.info(
            "drive_bulk_share.prepare outcome=review_ready duration_ms=%d recipients=%d excluded=%d",
            int((time.perf_counter() - started) * 1000),
            len(recipients),
            len(excluded),
        )
        return review

    async def list(self, *, user_id: str, search_job_id: str | None = None) -> dict:
        await self._owner()
        result = await self.store.list(user_id=user_id, search_job_id=search_job_id)
        await self._owner()
        return result

    async def review(self, *, user_id: str, share_id: str) -> dict:
        await self._owner()
        result = await self.store.review(user_id=user_id, share_id=share_id)
        await self._owner()
        return result

    async def files(self, *, user_id: str, share_id: str, cursor: str | None = None) -> dict:
        await self._owner()
        result = await self.store.files(user_id=user_id, share_id=share_id, cursor=cursor, limit=25)
        await self._owner()
        return result

    @drive_operation(job_key="share_id")
    async def approve(
        self,
        *,
        user_id: str,
        share_id: str,
        revision: int,
        review_digest: str,
        approval_source: str = "owner",
    ) -> dict:
        started = time.perf_counter()
        await self._owner()
        self._admit(user_id)
        result = await self.store.approve(
            user_id=user_id,
            share_id=share_id,
            revision=revision,
            review_digest=review_digest,
            approval_source=approval_source,
        )
        # PostgreSQL is authoritative; a lost wake still resumes on schedule.
        await self.wake("sharing")
        await self._owner()
        logger.info(
            "drive_bulk_share.approve outcome=accepted duration_ms=%d",
            int((time.perf_counter() - started) * 1000),
        )
        return result

    @drive_operation(job_key="share_id")
    async def retry(
        self, *, user_id: str, share_id: str, revision: int, review_digest: str
    ) -> dict:
        await self._owner()
        self._admit(user_id)
        result = await self.store.retry(
            user_id=user_id, share_id=share_id, revision=revision, review_digest=review_digest
        )
        await self.wake("sharing")
        await self._owner()
        return result

    @drive_operation(job_key="share_id")
    async def stop(self, *, user_id: str, share_id: str) -> dict:
        started = time.perf_counter()
        await self._owner()
        result = await self.store.stop(user_id=user_id, share_id=share_id)
        await self._owner()
        logger.info(
            "drive_bulk_share.stop outcome=accepted duration_ms=%d",
            int((time.perf_counter() - started) * 1000),
        )
        return result

    async def received(self, *, user_id: str) -> dict:
        """Recipient inbox for confirmed grants; no recipient Drive OAuth needed."""
        await self._owner()
        identity = await self.recipient_identity(user_id)
        if identity.user_id != user_id:
            raise DriveSharingError("recipient_changed")
        await self._owner()
        result = await self.store.inbox(
            recipient_user_id=user_id,
            recipient_subject=identity.subject,
            recipient_email=identity.email,
        )
        await self._owner()
        return result

    async def received_files(
        self, *, user_id: str, share_id: str, cursor: str | None = None
    ) -> dict:
        """Only successfully granted links for the current verified recipient."""
        await self._owner()
        identity = await self.recipient_identity(user_id)
        if identity.user_id != user_id:
            raise DriveSharingError("recipient_changed")
        await self._owner()
        result = await self.store.recipient_files(
            recipient_user_id=user_id,
            recipient_subject=identity.subject,
            recipient_email=identity.email,
            share_id=share_id,
            cursor=cursor,
            limit=25,
        )
        await self._owner()
        return result
