"""The owner's pod session for app routes that open no sealed conversation record.

Queue, stop, ratings, voice proposals and connector settings carry ids, closed enums
or a connector configuration the owner's app already holds. They need the same
admitted owner app session as chat (``PodChatContext``: app role, this pod's owner,
a held session authority) but not the chat key, because nothing here decrypts or
seals a conversation.
"""

from __future__ import annotations

from fastapi import Request

from api.routes.one.pod_turn import _require_enabled
from hushh_mcp.one_adk.pod_agui_context import PodChatContext


async def owner_context(request: Request) -> PodChatContext:
    _require_enabled()
    result = PodChatContext(request.headers.get("authorization"), needs_key=False)
    await result.require_access()
    return result


__all__ = ["owner_context"]
