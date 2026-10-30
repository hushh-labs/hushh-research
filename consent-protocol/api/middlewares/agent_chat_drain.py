"""End an in-flight agent-chat stream with a terminal event when the server stops.

On Cloud Run SIGTERM (a deploy or scale-down) uvicorn's exit handler marks the
process as exiting and sse-starlette cancels every open event stream at once.
The AG-UI turn never reaches its own ``RUN_FINISHED`` or ``RUN_ERROR``, so the
client sees the stream just stop. This guard watches only the private agent's
stream route and, when that stream ends during shutdown without a terminal
event, sends one fixed, retryable ``RUN_ERROR`` before closing it.

Pure ASGI, so it sees the real ``send`` and adds no buffering. It never reads
or forwards the request or response content: it checks each outgoing chunk only
for the bare terminal-event type key, which an event's escaped string payload
cannot contain. It adds no wait to shutdown; gunicorn's graceful timeout still
bounds it.
"""

from __future__ import annotations

import logging

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from hushh_mcp.one_adk.run_errors import SERVER_RESTARTING_RUN_ERROR, server_is_draining

logger = logging.getLogger(__name__)

AGENT_CHAT_STREAM_PATHS = frozenset({"/api/one/agent-chat"})
_TERMINAL_MARKERS = (b'"type":"RUN_FINISHED"', b'"type":"RUN_ERROR"')
# Same framing as the installed bridge endpoint: ``data: {json}\n\n``.
SERVER_RESTARTING_FRAME = (
    b"data: "
    + SERVER_RESTARTING_RUN_ERROR.model_dump_json(by_alias=True, exclude_none=True).encode()
    + b"\n\n"
)


def _is_event_stream(message: Message) -> bool:
    for name, value in message.get("headers") or ():
        if name.lower() == b"content-type":
            media_type: bytes = value.split(b";", 1)[0].strip().lower()
            return media_type == b"text/event-stream"
    return False


class AgentChatDrainMiddleware:
    def __init__(self, app: ASGIApp, *, paths: frozenset[str] = AGENT_CHAT_STREAM_PATHS) -> None:
        self.app = app
        self.paths = paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") not in self.paths
        ):
            await self.app(scope, receive, send)
            return

        streaming = False
        terminal = False
        completed = False

        async def end_with_restart_notice() -> None:
            nonlocal terminal
            terminal = True
            logger.warning("one.agent_chat_stream_drained code=SERVER_RESTARTING")
            await send(
                {"type": "http.response.body", "body": SERVER_RESTARTING_FRAME, "more_body": True}
            )

        async def guarded_send(message: Message) -> None:
            nonlocal streaming, terminal, completed
            if message["type"] == "http.response.start":
                streaming = _is_event_stream(message)
            elif message["type"] == "http.response.body" and streaming:
                body = message.get("body") or b""
                if not terminal and any(marker in body for marker in _TERMINAL_MARKERS):
                    terminal = True
                if not message.get("more_body", False):
                    # An intermediate middleware can close the cancelled stream
                    # cleanly; the notice must precede that close.
                    if not terminal and server_is_draining():
                        await end_with_restart_notice()
                    completed = True
            await send(message)

        await self.app(scope, receive, guarded_send)
        if streaming and not completed and not terminal and server_is_draining():
            # sse-starlette cancelled the stream and returned without closing it.
            await end_with_restart_notice()
            await send({"type": "http.response.body", "body": b"", "more_body": False})
