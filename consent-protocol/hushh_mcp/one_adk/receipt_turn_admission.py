"""Receipt tool admission shared by hub and owner-pod routes.

The caller supplies its existing owner-bound session store and execution head.
No receipt result, credential or session is retained by this adapter.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from ag_ui.core import Tool

from hushh_mcp.one_adk.receipt_client_tools import (
    RECEIPT_TOOL_NAMES,
    admit_receipt_result,
    read_receipt_continuation_session,
    receipt_tool_declaration,
)
from hushh_mcp.one_adk.receipt_result_contract import admitted_receipt_parameters

logger = logging.getLogger(__name__)


def admit_receipt_tool(tool: Tool) -> bool:
    if tool.name not in RECEIPT_TOOL_NAMES:
        return False
    declaration = receipt_tool_declaration(tool.name)
    # Installed older apps keep the list schema without attention; both stay exact.
    if tool.parameters not in admitted_receipt_parameters(tool.name):
        raise ValueError("Receipt tool contract is invalid.")
    tool.description = declaration["description"]
    return True


async def admit_receipt_continuation(
    forwarded: dict,
    *,
    owner_id: str,
    conversation_id: str,
    messages: list,
    execution_head: Callable[[], Any],
    load_session: Callable[[], Any],
) -> str:
    session = None
    results = forwarded.get("receiptToolResults")
    if results is not None and owner_id:
        session = await read_receipt_continuation_session(
            execution_head(),
            load_session,
            owner_id=owner_id,
            conversation_id=conversation_id,
            results=results,
        )
    reference = admit_receipt_result(
        forwarded,
        owner_id=owner_id,
        conversation_id=conversation_id,
        session=session,
        messages=messages,
    )
    if reference:
        # Only the admitted results continue the paused turn. The browser also
        # resent the turn's earlier messages, and the bridge ran the question again
        # beside the pending call, which failed every continuation (UAT, 2026-10-29).
        admitted = {item["toolCallId"] for item in results or []}
        sent = len(messages)
        messages[:] = [
            message
            for message in messages
            if getattr(message, "role", None) == "tool"
            and getattr(message, "tool_call_id", None) in admitted
        ]
        logger.info("one.receipt_resume results=%d dropped=%d", len(admitted), sent - len(messages))
    return reference
