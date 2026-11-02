"""Small composition helpers for the existing owner-bound Email runtime."""

from __future__ import annotations

import re


def approved_azure_binding():
    from hushh_mcp.runtime_providers.managed_azure import ManagedAzureBinding

    binding = ManagedAzureBinding.from_environment()
    if binding is None:
        raise RuntimeError("The centralized Azure runtime is unavailable")
    binding.require_current()
    descriptor = binding.capabilities.get("one_text_root")
    if not isinstance(descriptor, dict) or not all(
        isinstance(descriptor.get(key), str) and descriptor[key]
        for key in ("deployment", "reasoning_effort", "text_verbosity")
    ):
        raise RuntimeError("The approved One text deployment is unavailable")
    return binding, descriptor


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
        return {
            key: result.get(key)
            for key in (
                "connected",
                "connection_state",
                "compose_permission_granted",
                "send_permission_granted",
                "modify_permission_granted",
            )
        }

    return status


def build_email_model(binding, descriptor, sync_http, async_http):
    from langchain_openai import ChatOpenAI

    from .prompts import get_agent_manifest

    # The central account/deployment stays authoritative; the canonical agent
    # manifest owns this specialist's existing bounded thinking preference.
    preference = getattr(get_agent_manifest().model, "thinking_level", None)
    return ChatOpenAI(
        model=descriptor["deployment"],
        base_url=binding.endpoint,
        api_key=binding.token_supplier,
        use_responses_api=True,
        reasoning={"effort": preference or descriptor["reasoning_effort"]},
        verbosity=descriptor["text_verbosity"],
        max_tokens=4096,
        max_retries=0,
        timeout=30,
        http_client=sync_http,
        http_async_client=async_http,
    )
