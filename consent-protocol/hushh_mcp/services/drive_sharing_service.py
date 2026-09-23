"""Owner HTTP orchestration; only confirmed durable work can reach a worker.

No provider permission call runs in a request or a detached background task.
The response 'approved' means queued, not that Google has shared anything.
"""

from hushh_mcp.services.drive_permission_executor import require_recipient_identity
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service


class DriveSharingService:
    def __init__(self, *, oauth=None, store=None, verify_recipient=None, require_owner=None):
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DriveSuggestionStore(db=self.oauth.lifecycle.db)
        self.verify_recipient = verify_recipient or require_recipient_identity
        self.require_owner = require_owner

    async def _require_owner(self):
        if self.require_owner is None:
            raise DriveSharingError("owner_authority_required")
        await self.require_owner()

    async def _generation(self, user_id):
        row = await self.oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        if not row or row["status"] != "connected":
            raise DriveSharingError("reconnect_required")
        return row["connection_generation"]

    async def create(self, *, recipient, owner_user_id, client_request_id, purpose):
        return await self.store.create_request(
            recipient=recipient,
            owner_user_id=owner_user_id,
            client_request_id=client_request_id,
            purpose=purpose,
        )

    async def list_requests(self, **kwargs):
        return await self.store.list_requests(**kwargs)

    async def status(self, **kwargs):
        return await self.store.request_status(**kwargs)

    async def review(self, **kwargs):
        return await self.store.owner_review(**kwargs)

    async def delivery(self, **kwargs):
        snapshot = await self.store.delivery_snapshot(**kwargs)
        if snapshot["recipient"] is not None:
            await self.verify_recipient(snapshot["recipient"])
            # Re-read after external identity verification, so a concurrently
            # recorded revocation or request erasure suppresses stale links.
            current = await self.store.delivery_snapshot(**kwargs)
            if current["recipient"] != snapshot["recipient"]:
                raise DriveSharingError("recipient_changed")
            snapshot = current
        return snapshot["result"]

    async def approve(self, *, user_id, **kwargs):
        generation = await self._generation(user_id)
        await self._require_owner()
        return await self.store.approve_review(user_id=user_id, generation=generation, **kwargs)

    async def decide(self, **kwargs):
        return await self.store.decline_or_cancel(**kwargs)

    async def retry_preparation(self, **kwargs):
        await self._require_owner()
        return await self.store.retry_preparation(**kwargs)

    async def prepare_revocation(self, *, user_id, request_id):
        generation = await self._generation(user_id)
        await self._require_owner()
        return await self.store.prepare_revocation(
            user_id=user_id, generation=generation, request_id=request_id
        )

    async def revoke(self, *, user_id, **kwargs):
        generation = await self._generation(user_id)
        await self._require_owner()
        return await self.store.confirm_revocation(user_id=user_id, generation=generation, **kwargs)
