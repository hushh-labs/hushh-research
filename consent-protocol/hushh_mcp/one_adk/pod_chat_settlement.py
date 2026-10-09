"""Seal a finished admitted turn before publishing an opaque completion receipt."""

import os
from typing import Any


async def notify_detached_reply(self, input: Any) -> None:
    from hushh_mcp.one_adk.agent_tree import ONE_APP_NAME
    from hushh_mcp.one_adk.turn_completion import newest_turn_answered
    from hushh_mcp.services.pod_reply_notifications import reply_outbox

    await self.require_access()
    session = await self.sessions.get_session(
        app_name=ONE_APP_NAME, user_id=self.owner, session_id=input.thread_id
    )
    if session is None or not newest_turn_answered(session.events):
        return
    await self.require_access()
    outbox = reply_outbox(self.log)
    await outbox.enqueue(conversation_id=input.thread_id, run_id=input.run_id)
    await outbox.drain(limit=1)


async def finish_turn(self, memory: Any, input: Any) -> None:
    if memory is not None:
        await memory.commit(input)
    await self.require_access()
    await self.projection.snapshot(force_save=True)
    projection = getattr(self.authority, "recovery_projection", None)
    if projection is not None:
        await projection.recover(self.log, force_save=True)
    await self.require_access()


def turn_request_lifetime(owner):
    from hushh_mcp.one_adk.pod_chat_hold import retain_turn_request

    # Exact renderer capacity; older/fractional deployments stay attached.
    if os.getenv("HUSSH_POD_REQUEST_CONCURRENCY") != "8":
        return None
    return lambda: retain_turn_request(owner)
