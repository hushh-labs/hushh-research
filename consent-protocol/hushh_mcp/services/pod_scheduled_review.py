"""Authenticated owner review of a parked occurrence, before execution reclaim.

This reads the existing sealed checkpoint and reuses the action ledger. It does
not approve an effect, renew the original grant, or start another occurrence.
"""

from __future__ import annotations

from dataclasses import dataclass
from secrets import compare_digest

from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused


@dataclass(frozen=True)
class _ReviewRequest:
    conversationId: str
    pendingHandle: str
    toolName: str
    connectorConfiguration: dict
    directiveId: str
    arguments: None = None


class _ReviewOwner:
    def __init__(self, runtime, row, authority, claims, caller_check):
        from hushh_mcp.one_adk.scheduled_session_service import ScheduledSessionService
        from hushh_mcp.services.pod_mcp_approval import PodMcpApprovalPort
        from hushh_mcp.services.pod_mcp_pending import PodMcpPendingStore
        from hushh_mcp.services.pod_scheduled_continuation import ScheduledTaskCheckpointStorage

        self.runtime, self.row = runtime, row
        self.authority, self.claims, self.caller_check = authority, claims, caller_check
        self.owner, self.hushh_id = row["owner_id"], row["pod_id"]
        self.storage = ScheduledTaskCheckpointStorage(
            runtime.journal, row, self.require_access, allow_parked_review=True
        )
        self.sessions = ScheduledSessionService(self.storage)
        self.mcp_pending = PodMcpPendingStore(self.storage)
        self.mcp_approval = PodMcpApprovalPort(self)

    async def require_access(self):
        from hushh_mcp.services.pod_scheduled_one import ScheduledOneTask

        await self.caller_check()
        await self.runtime.check()
        if (
            self.owner != self.claims.get("user_id")
            or self.hushh_id != self.claims.get("hushh_id")
            or self.hushh_id != self.authority.hushh_id
        ):
            raise ScheduleRefused("SCHEDULE_OWNER_REFUSED")
        await self.runtime.journal.check_horizon(self.row)
        await self.runtime.check_grant(
            {
                "subject_id": self.claims["subject_id"],
                "version": self.claims["version"],
                "scopes": self.row["grant"]["scopes"],
            }
        )
        capability = self.runtime.capabilities.get(self.row["capability"])
        if not isinstance(capability, ScheduledOneTask):
            raise ScheduleRefused("SCHEDULE_CONTINUATION_UNAVAILABLE")
        await capability.model_for(self.row["terms"], self.runtime.check)
        await self.caller_check()

    async def _mcp_owner_admission(self, context):
        from hushh_mcp.one_adk.request_secrets import resolve_request_secret

        await self.require_access()
        return (
            context.user_id == self.owner
            and context.state.get("hussh:conversation_id") == self.storage.session_id
            and compare_digest(
                resolve_request_secret(context.state.get("hussh:consent_token")),
                self.authority.local_token(self.claims),
            )
        )

    async def prepare(self, pending_handle: str) -> dict:
        from hushh_mcp.one_adk.pod_custody_mcp import (
            custody_configuration_admissions,
            custody_configurations,
        )
        from hushh_mcp.one_adk.pod_mcp_review import _prepare_private_review
        from hushh_mcp.one_adk.scheduled_session_projection import pending_confirmations

        checkpoint, _ = await self.storage.checkpoint()
        markers = pending_confirmations(
            checkpoint.session, checkpoint.pending, self.storage.invocation_id
        )
        pending = checkpoint.pending.get(pending_handle)
        if pending is None or pending_handle not in markers:
            raise ScheduleRefused("SCHEDULE_NATIVE_CONFIRMATION_CHANGED")
        review = pending["review"]
        records = await custody_configurations()
        records = [r for r in records if r["connectorId"] == review["connectorId"]]
        if len(records) != 1:
            raise ScheduleRefused("SCHEDULE_CONNECTOR_UNAVAILABLE")
        request = _ReviewRequest(
            self.storage.session_id,
            pending_handle,
            pending["tool_name"],
            records[0],
            review["directiveId"],
        )
        result = await _prepare_private_review(
            self,
            review["connectorId"],
            request,
            configuration_admissions=custody_configuration_admissions(records),
        )
        _, revision = await self.storage.checkpoint()
        return {"review": result, "revision": revision, "confirmation_id": markers[pending_handle]}


async def review_scheduled_call(
    runtime,
    *,
    authority,
    claims,
    caller_check,
    schedule_id: str,
    revision: int,
    occurrence_id: str,
    pending_handle: str,
) -> dict:
    from opentelemetry.instrumentation.utils import suppress_instrumentation

    from hushh_mcp.hushh_adk.telemetry import private_telemetry
    from hushh_mcp.one_adk.mcp_pending_call import private_pending_call_scope

    private_telemetry()
    await caller_check()
    rows, _ = await runtime.journal.snapshot()
    row = rows.get(schedule_id)
    if (
        row is None
        or row["revision"] != revision
        or row["state"] != "needs_review"
        or (row.get("last_run") or {}).get("state") != "needs_review"
        or row["last_run"]["id"] != occurrence_id
    ):
        raise ScheduleRefused("SCHEDULE_CONTINUATION_CHANGED")
    owner = _ReviewOwner(runtime, row, authority, claims, caller_check)
    with suppress_instrumentation():
        await owner.require_access()
        permit = await runtime.admission.acquire_turn(incarnation=runtime.access.incarnation)
        try:
            with private_pending_call_scope(owner.mcp_pending):
                return await owner.prepare(pending_handle)
        finally:
            # Reuse owned cleanup; there is no execution lease to settle here.
            await runtime.runner._finish_permit(None, permit)
