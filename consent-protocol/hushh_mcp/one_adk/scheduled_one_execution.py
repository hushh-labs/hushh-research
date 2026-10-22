"""One native ADK execution segment with claim-owned private dependencies."""

from __future__ import annotations

from contextlib import AsyncExitStack, aclosing
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from google.adk.agents.run_config import RunConfig
from google.adk.apps import App, ResumabilityConfig
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.runners import Runner
from google.genai import types
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.hushh_adk.telemetry import private_telemetry
from hushh_mcp.one_adk.mcp_call_approval import (
    STATE_MCP_APPROVAL,
    admit_resume_receipt,
    bind_mcp_approval_port,
)
from hushh_mcp.one_adk.mcp_pending_call import pending_resume_scope, private_pending_call_scope
from hushh_mcp.one_adk.mcp_turn_scope import McpTurnResources, bind_mcp_turn
from hushh_mcp.one_adk.request_secrets import consume_request_secret, resolve_request_secret
from hushh_mcp.one_adk.scheduled_one_agent import build_scheduled_one_agent
from hushh_mcp.one_adk.scheduled_one_result import native_task_outputs
from hushh_mcp.one_adk.scheduled_session_service import ScheduledSessionService
from hushh_mcp.runtime_providers.lifecycle import finish_owned_cleanup
from hushh_mcp.services.pod_mcp_pending import PodMcpPendingStore
from hushh_mcp.services.pod_scheduled_authority import scheduled_tool_owner
from hushh_mcp.services.pod_scheduled_continuation import ScheduledTaskCheckpointStorage
from hushh_mcp.services.pod_scheduled_contracts import ScheduledContinuation, ScheduleRefused
from hushh_mcp.services.pod_scheduled_lease import ScheduledExecutionLease
from hushh_mcp.services.pod_scheduled_mcp import ScheduledMcpApprovalPort

if TYPE_CHECKING:
    from hushh_mcp.services.pod_scheduled_one import ScheduledOneTask


class _AccessPlugin(BasePlugin):
    def __init__(self, check):
        super().__init__(name="scheduled_owner_access")
        self.check = check

    async def before_model_callback(self, *, callback_context, llm_request):
        await self.check()

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
        await self.check()


@dataclass(frozen=True)
class _Owner:
    owner: str
    hushh_id: str
    authority: Any
    require_access: Any


class _Segment:
    def __init__(self, capability: ScheduledOneTask, lease: ScheduledExecutionLease):
        self.capability, self.lease = capability, lease
        self.invocation = capability.grants.invocation(lease)
        self.storage = ScheduledTaskCheckpointStorage(lease.journal, lease.claimed, self.check)
        self.sessions = ScheduledSessionService(self.storage)
        self.pending = PodMcpPendingStore(self.storage)
        self.owner = _Owner(
            self.invocation.owner_id,
            self.invocation.pod_id,
            capability.grants.authority,
            self.check,
        )
        self.credential = ""

    async def check(self):
        await self.lease.check()
        await self.invocation.owner_read_admission(self.owner.owner, self.credential)
        await self.capability.model_for(self.lease.claimed["terms"], self.lease.check)

    async def mcp_admission(self, context):
        await self.check()
        return await scheduled_tool_owner(context) == self.owner.owner

    async def build(self, stack: AsyncExitStack):
        from hushh_mcp.one_adk.pod_chat_memory import PodChatMemory
        from hushh_mcp.one_adk.pod_custody_mcp import (
            custody_configuration_admissions,
            custody_configurations,
        )
        from hushh_mcp.runtime_providers.lifecycle import close_owned_adk_model
        from hushh_mcp.services.pod_consent_read import PodConsentReadPort
        from hushh_mcp.services.pod_memory_service import resolve_pod_memory_service

        resolved = await self.capability.model_for(self.lease.claimed["terms"], self.lease.check)
        model = resolved.build()
        stack.push_async_callback(close_owned_adk_model, model)
        self.specialists = resolved.specialist_runtime(
            self.invocation, self.credential, check=self.check
        )
        if self.specialists.aclose is not None:
            stack.push_async_callback(self.specialists.aclose)
        custody = await custody_configurations()
        await self.check()
        self.scope = McpTurnResources(
            self.storage.session_id,
            owner_id=self.owner.owner,
            configurations=custody,
            configuration_admissions=custody_configuration_admissions(custody),
            owner_admission=self.mcp_admission,
            vault_only=True,
        )
        stack.push_async_callback(self.scope.close)
        head = build_scheduled_one_agent(
            model=model, consent_bundle_lookup=PodConsentReadPort(self.owner).lookup
        )
        memory = resolve_pod_memory_service()
        return await stack.enter_async_context(
            Runner(
                app=App(
                    name="hussh_one",
                    root_agent=head,
                    resumability_config=ResumabilityConfig(is_resumable=True),
                    plugins=[_AccessPlugin(self.check)],
                ),
                session_service=self.sessions,
                memory_service=PodChatMemory(self.owner, memory) if memory is not None else None,
            )
        )

    async def _message(self, continuation: ScheduledContinuation | None):
        if continuation is not None:
            await self.sessions.restore_pending(continuation.pending_handle)
            return await self.sessions.confirmation_message(
                continuation.pending_handle, continuation.confirmation_id, confirmed=True
            )
        await self.sessions.create_session(
            app_name="hussh_one",
            user_id=self.owner.owner,
            session_id=self.storage.session_id,
            state={
                "hussh:user_id": self.owner.owner,
                "hussh:conversation_id": self.storage.session_id,
                "hussh:timezone": self.lease.claimed["timezone"],
            },
        )
        return types.Content(
            role="user", parts=[types.Part(text=self.lease.claimed["terms"]["goal"])]
        )

    async def run(self, runner, reference: str, continuation: ScheduledContinuation | None) -> str:
        message = await self._message(continuation)
        receipt = admit_resume_receipt(
            {"mcpApproval": continuation.approval} if continuation else {},
            owner_id=self.owner.owner,
            conversation_id=self.storage.session_id,
        )
        try:
            async with pending_resume_scope(receipt):
                async with aclosing(
                    runner.run_async(
                        user_id=self.owner.owner,
                        session_id=self.storage.session_id,
                        invocation_id=self.storage.invocation_id,
                        new_message=message,
                        state_delta={
                            "hussh:consent_token": reference,
                            "temp:one_execution_surface": "scheduled_task",
                            STATE_MCP_APPROVAL: receipt,
                        },
                        run_config=RunConfig(max_llm_calls=60, telemetry=private_telemetry()),
                    )
                ) as events:
                    async for _ in events:
                        pass
            await self.check()
            return await self.outcome()
        finally:
            consume_request_secret(receipt)

    async def outcome(self) -> str:
        checkpoint, _ = await self.storage.checkpoint()
        session = await self.sessions.get_session(
            app_name="hussh_one", user_id=self.owner.owner, session_id=self.storage.session_id
        )
        if session is None or checkpoint.phase != "running":
            raise ScheduleRefused("SCHEDULE_DISPATCH_OUTCOME_UNCERTAIN")
        outputs = native_task_outputs(session)
        if outputs:
            result = next(iter(outputs.values()))["output"]
            return "completed" if result["outcome"] == "completed" else "failed"
        if checkpoint.pending:
            await self.storage.park()
            return "needs_review"
        raise ScheduleRefused("SCHEDULE_TASK_TERMINAL_MISSING")


async def execute_scheduled_one(
    capability: ScheduledOneTask,
    lease: ScheduledExecutionLease,
    continuation: ScheduledContinuation | None = None,
) -> str:
    from hushh_mcp.adk_bridge.dispatch import bind_specialist_runtime

    segment = _Segment(capability, lease)
    stack = AsyncExitStack()
    private_telemetry()  # Refuse content capture before custody/login hydration.
    with suppress_instrumentation(), segment.invocation.bind() as reference:
        segment.credential = resolve_request_secret(reference)
        try:
            await segment.check()
            runner = await segment.build(stack)
            with (
                bind_specialist_runtime(segment.specialists),
                bind_mcp_turn(segment.scope),
                bind_mcp_approval_port(ScheduledMcpApprovalPort(segment.owner, segment.storage)),
                private_pending_call_scope(segment.pending),
            ):
                return await segment.run(runner, reference, continuation)
        finally:
            try:
                await finish_owned_cleanup(stack.aclose())
            finally:
                segment.credential = ""
