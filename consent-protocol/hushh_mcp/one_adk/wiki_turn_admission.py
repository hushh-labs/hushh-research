"""Personal Wiki client-tool admission and hot-digest admission for Shared chat routes.

The caller supplies its existing owner-bound session store and execution head.
No wiki content, credential, or session is retained by this adapter beyond the
ephemeral request secret consumed within the turn.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from ag_ui.core import Tool

from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.one_adk.wiki_recall_tools import (
    WIKI_TOOL_NAMES,
    admit_wiki_result,
    read_wiki_continuation_session,
    wiki_tool_declaration,
    wrap_wiki_hot_digest_text,
)
from hushh_mcp.services.wiki_memory.contracts import WIKI_HOT_MAX_CHARS

logger = logging.getLogger(__name__)


def admit_wiki_tool(tool: Tool) -> bool:
    if tool.name not in WIKI_TOOL_NAMES:
        return False
    declaration = wiki_tool_declaration(tool.name)
    if tool.parameters != declaration["parameters"]:
        raise ValueError("Wiki tool contract is invalid.")
    tool.description = declaration["description"]
    return True


def admit_wiki_hot_digest(
    forwarded: dict[str, Any],
    *,
    owner_admitted: bool,
) -> tuple[str, bool]:
    """Pop and sanitize ``wikiHotDigest`` + ``wikiClientReady`` for an unlocked owner turn."""
    raw_digest = forwarded.pop("wikiHotDigest", None)
    raw_ready = forwarded.pop("wikiClientReady", None)
    if not owner_admitted:
        return "", False
    client_ready = raw_ready is True
    if raw_digest is None or raw_digest == "":
        return "", client_ready
    if not isinstance(raw_digest, str) or len(raw_digest) > WIKI_HOT_MAX_CHARS + 512:
        raise ValueError("Personal wiki hot digest exceeds the request budget.")
    wrapped = wrap_wiki_hot_digest_text(raw_digest, max_chars=WIKI_HOT_MAX_CHARS)
    if not wrapped:
        return "", client_ready
    return store_request_secret(wrapped, preserve_whitespace=True), client_ready


async def admit_wiki_continuation(
    forwarded: dict[str, Any],
    *,
    owner_id: str,
    conversation_id: str,
    messages: list[Any],
    execution_head: Callable[[], Any],
    load_session: Callable[[], Any],
) -> str:
    session = None
    results = forwarded.get("wikiToolResults")
    if results is not None and owner_id:
        session = await read_wiki_continuation_session(
            execution_head(),
            load_session,
            owner_id=owner_id,
            conversation_id=conversation_id,
            results=results,
        )
    reference = admit_wiki_result(
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
        logger.info("one.wiki_resume results=%d dropped=%d", len(admitted), sent - len(messages))
    return reference
