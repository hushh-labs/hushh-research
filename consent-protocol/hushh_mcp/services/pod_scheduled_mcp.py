"""Retain task dispatch intent before the existing MCP ledger consumes approval."""

from hushh_mcp.one_adk.mcp_pending_call import current_pending_handle
from hushh_mcp.services.pod_mcp_approval import PodMcpApprovalPort
from hushh_mcp.services.pod_scheduled_continuation import ScheduledTaskCheckpointStorage


class ScheduledMcpApprovalPort(PodMcpApprovalPort):
    def __init__(self, owner, storage: ScheduledTaskCheckpointStorage, *, client=None):
        super().__init__(owner, client=client)
        self.storage = storage

    async def consume(self, approval, *, directive_id: str, receipt: str):
        recorded = await self._pending_review(approval)
        # An unconfirmed/changed call still fails in the existing ledger. Any
        # lost response after this point remains a non-replayable task intent.
        await self.storage.begin_dispatch(current_pending_handle())
        await self._consume_review(recorded, directive_id=directive_id, receipt=receipt)
