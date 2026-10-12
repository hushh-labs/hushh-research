"""Typed-chat-only Email hop with exact invocation and live owner authority.

Uses the nonpersisting metadata lane; legacy direct Mail/receipts and reviewed
sending remain separate. Invocation grants no mailbox access by itself.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hushh_mcp.adk_bridge.contract import (
    A2ADirective,
    A2ATask,
    SpecialistReadResult,
    SpecialistTurnResult,
    require_attenuated_authority,
)
from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.email_delegated_read import make_mail_read_offer

# The label surfaced to the client for delegated turns (SSE start/complete "model").
DELEGATED_MODEL = "one+email"


class EmailAgentA2A:
    def __init__(self, service: Any = None) -> None:
        if service is not None:
            self._service = service
        else:
            from hushh_mcp.services.email_chat_service import EmailChatService

            self._service = EmailChatService()

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        manifest = ManifestLoader.load(
            str(Path(__file__).resolve().parents[1] / "agents" / "email" / "agent.yaml")
        )

        async def require_access() -> None:
            if (
                task.execution_surface != "typed_chat"
                or task.delegate_result is not None
                or task.planned_action is not None
                or not task.conversation_id
                or not manifest.authorities.invocation
            ):
                raise PermissionError("Mail read authority is unavailable")
            for capability in manifest.authorities.invocation:
                require_attenuated_authority(
                    task,
                    required_invocation=capability,
                    expected_tenant_id=task.expected_tenant_id,
                    expected_task_id=task.expected_task_id,
                )
            if not connector_feature_enabled("gmail_chat_reads", task.user_id):
                raise PermissionError("Mail reads are unavailable")
            if await validate_first_party_owner_token(task.user_id, task.consent_token) is None:
                raise PermissionError("Mail owner authority is unavailable")

        await require_access()
        out: dict = await self._service.handle_delegated_turn(
            user_id=task.user_id,
            message=task.message or "",
            consent_token=task.consent_token,
            conversation_id=task.conversation_id or "",
            require_access=require_access,
            timezone=task.timezone or "UTC",
            receipt_memory=task.receipt_memory,
            receipt_cursor=task.receipt_cursor,
            read_offer=task.mail_read_offer,
            require_explicit_latest=True,
        )
        await require_access()
        # A receipts answer that is not ready proposes the generated Open
        # Receipts action. One validates that suggestion through the gateway.
        proposal = out.get("directive")
        cursor = out.get("receipt_cursor")
        structured = SpecialistReadResult.model_validate(out["structured"])
        return SpecialistTurnResult(
            conversation_id=task.conversation_id or "",
            text=str(out.get("response") or ""),
            directive=(
                A2ADirective(kind="action", payload=proposal)
                if isinstance(proposal, dict)
                else None
            ),
            is_complete=bool(out.get("isComplete", True)),
            state_changed=False,
            model=DELEGATED_MODEL,
            structured=structured,
            continuation=cursor if isinstance(cursor, dict) else None,
            mail_read_offer=(
                make_mail_read_offer(
                    out.get("offer"),
                    owner_id=task.user_id,
                    conversation_id=task.conversation_id or "",
                )
                if structured.status == "ok"
                else None
            ),
        )


_singleton: EmailAgentA2A | None = None


def get_email_a2a() -> EmailAgentA2A:
    global _singleton
    if _singleton is None:
        _singleton = EmailAgentA2A()
    return _singleton
