"""Small composition helpers for the existing owner-bound Email runtime."""

from __future__ import annotations

import re

from hushh_mcp.managed_ai_config import load_scoped_text_policy
from hushh_mcp.runtime_providers import ManagedGeminiRuntimeBinding
from hushh_mcp.runtime_providers.factory import VERTEX_ADC_AUTH_MODE

MAIL_PROCESSING_SCOPE = "one_mail_chat"


def approved_mail_model_policy() -> dict:
    policy = load_scoped_text_policy(MAIL_PROCESSING_SCOPE)
    if policy is None:
        raise RuntimeError("The managed Mail model is unavailable")
    return policy


def build_email_model(policy: dict):
    from langchain_google_genai import ChatGoogleGenerativeAI

    binding = ManagedGeminiRuntimeBinding.from_environment()
    if binding.auth_mode != VERTEX_ADC_AUTH_MODE or binding.primary_location != "global":
        raise RuntimeError("The managed Mail model requires global Vertex ADC")
    model = binding.validate_model(policy["model"])
    return ChatGoogleGenerativeAI(
        model=model,
        vertexai=True,
        project=binding.project,
        location=binding.primary_location,
        thinking_level=policy["thinking_level"],
        include_thoughts=False,
        max_tokens=policy["max_output_tokens"],
        # Vertex retries retryable HTTP status codes before opening the stream.
        # This never restarts a consumed model stream or the agent graph.
        max_retries=2,
        timeout=20,
    )


async def restore_email_selection(gmail, user_id, execution, selected_messages):
    if not selected_messages or selected_messages.get("owner_id") != user_id:
        return
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    try:
        live_grant = await gmail.read_execution_grant_binding(user_id=user_id)
    except GmailApiError:
        live_grant = None
    if not live_grant or tuple(selected_messages.get("grant_binding") or ())[:4] != live_grant[:4]:
        return
    rows = selected_messages.get("messages", [])
    if not isinstance(rows, list) or len(rows) > 50:
        return
    for row in rows:
        if (
            isinstance(row, dict)
            and isinstance(row.get("id"), str)
            and re.fullmatch(r"[A-Za-z0-9_-]{1,256}", row["id"])
            and (
                row.get("thread_id") is None
                or (
                    isinstance(row.get("thread_id"), str)
                    and re.fullmatch(r"[A-Za-z0-9_-]{1,256}", row["thread_id"])
                )
            )
        ):
            execution.observed_messages[row["id"]] = row
    execution.grant_binding = live_grant


def connection_status_port(gmail, admitted, user_id):
    async def status(_context):
        await admitted()
        result = await gmail.get_status(user_id=user_id)
        await admitted()
        connection = {
            key: result.get(key)
            for key in (
                "connected",
                "connection_state",
                "compose_permission_granted",
                "send_permission_granted",
                "modify_permission_granted",
            )
        }
        if result.get("connected") is True:
            connection["google_email"] = result.get("google_email")
        return connection

    return status
