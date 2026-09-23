"""Typed-chat-only, exact-authority selected-document specialist."""

from pathlib import Path

from hushh_mcp.adk_bridge.contract import (
    A2ATask,
    SpecialistReadResult,
    SpecialistTurnResult,
    require_attenuated_authority,
)
from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_chat_service import DriveChatService


class DocumentsAgentA2A:
    def __init__(self, service=None):
        self.service = service or DriveChatService()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        manifest = ManifestLoader.load(
            str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
        )

        async def require_access():
            if (
                task.execution_surface != "typed_chat"
                or task.delegate_result is not None
                or task.planned_action is not None
                or not task.conversation_id
                or not manifest.authorities.invocation
            ):
                raise PermissionError("Document read authority is unavailable")
            for capability in manifest.authorities.invocation:
                require_attenuated_authority(
                    task,
                    required_invocation=capability,
                    expected_tenant_id=task.expected_tenant_id,
                    expected_task_id=task.expected_task_id,
                )
            if not connector_feature_enabled("google_drive_chat_reads", task.user_id):
                raise PermissionError("Document reads are unavailable")
            if await validate_first_party_owner_token(task.user_id, task.consent_token) is None:
                raise PermissionError("Document owner authority is unavailable")

        await require_access()
        output = await self.service.handle_delegated_turn(
            user_id=task.user_id,
            consent_token=task.consent_token,
            conversation_id=task.conversation_id,
            message=task.message or "",
            require_access=require_access,
        )
        await require_access()
        return SpecialistTurnResult(
            conversation_id=task.conversation_id,
            text=output["response"],
            directive=None,
            is_complete=True,
            state_changed=False,
            model="one+documents",
            structured=SpecialistReadResult.model_validate(output["structured"]),
        )
