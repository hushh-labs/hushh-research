# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Plaid client-tool and headline-posture admission shared by Pod and Hub chat routes.

No Plaid snapshot, credential, or session is retained beyond the ephemeral request
secret consumed within the active turn.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from ag_ui.core import Tool

from hushh_mcp.one_adk.plaid_connector_tools import (
    PLAID_POSTURE_MAX_CHARS,
    PLAID_TOOL_NAMES,
    admit_plaid_result,
    plaid_tool_declaration,
    read_plaid_continuation_session,
    wrap_plaid_posture_text,
)
from hushh_mcp.one_adk.request_secrets import store_request_secret

logger = logging.getLogger(__name__)


def admit_plaid_tool(tool: Tool) -> bool:
    if tool.name not in PLAID_TOOL_NAMES:
        return False
    declaration = plaid_tool_declaration(tool.name)
    if tool.parameters != declaration["parameters"]:
        raise ValueError("Plaid tool contract is invalid.")
    tool.description = declaration["description"]
    return True


def admit_plaid_posture(
    forwarded: dict[str, Any],
    *,
    owner_admitted: bool,
) -> tuple[str, bool]:
    """Pop and sanitize ``plaidPosture`` + ``plaidClientReady`` for an unlocked owner turn."""
    raw_posture = forwarded.pop("plaidPosture", None)
    raw_ready = forwarded.pop("plaidClientReady", None)
    if not owner_admitted:
        return "", False
    client_ready = raw_ready is True
    if raw_posture is None or raw_posture == "":
        return "", client_ready
    if not isinstance(raw_posture, str) or len(raw_posture) > PLAID_POSTURE_MAX_CHARS + 512:
        raise ValueError("Plaid posture exceeds the request budget.")
    wrapped = wrap_plaid_posture_text(raw_posture, max_chars=PLAID_POSTURE_MAX_CHARS)
    if not wrapped:
        return "", client_ready
    return store_request_secret(wrapped, preserve_whitespace=True), client_ready


async def admit_plaid_continuation(
    forwarded: dict[str, Any],
    *,
    owner_id: str,
    conversation_id: str,
    messages: list[Any],
    execution_head: Callable[[], Any],
    load_session: Callable[[], Any],
) -> str:
    session = None
    results = forwarded.get("plaidToolResults")
    if results is not None and owner_id:
        session = await read_plaid_continuation_session(
            execution_head(),
            load_session,
            owner_id=owner_id,
            conversation_id=conversation_id,
            results=results,
        )
    reference = admit_plaid_result(
        forwarded,
        owner_id=owner_id,
        conversation_id=conversation_id,
        session=session,
        messages=messages,
    )
    if reference:
        admitted = {item["toolCallId"] for item in results or []}
        sent = len(messages)
        messages[:] = [
            message
            for message in messages
            if getattr(message, "role", None) == "tool"
            and getattr(message, "tool_call_id", None) in admitted
        ]
        logger.info("one.plaid_resume results=%d dropped=%d", len(admitted), sent - len(messages))
    return reference
