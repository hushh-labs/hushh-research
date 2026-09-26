"""Temporary, revision-bound write hold for the first BYOK compatibility image.

Enable only in a subsequent CI-green image after this read-capable bridge serves
and old writers have drained. Never use a runtime switch or a platform-key fallback.
"""

CHAT_HISTORY_WRITES_ENABLED = False
CHAT_HISTORY_UPGRADING = "CHAT_HISTORY_UPGRADING"
CHAT_HISTORY_UPGRADING_MESSAGE = "One is updating chat history. Please try again shortly."


class ChatHistoryUpdatingError(RuntimeError):
    """The compatibility image must not create history unreadable by its predecessor."""


def require_chat_history_writes() -> None:
    if not CHAT_HISTORY_WRITES_ENABLED:
        raise ChatHistoryUpdatingError(CHAT_HISTORY_UPGRADING_MESSAGE)


def holds_chat_history_request(method: str, path: str) -> bool:
    if CHAT_HISTORY_WRITES_ENABLED or method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return False
    path = path.rstrip("/")
    if any(
        path == prefix or path.startswith(prefix + "/")
        for prefix in ("/api/one/agent-chat", "/api/one/action-proposals")
    ):
        return True
    if method != "POST":
        return False
    if path in {"/api/one/email/chat", "/api/one/location/chat", "/api/one/information/chat"}:
        return True
    parts = path.split("/")
    return (
        len(parts) == 6
        and parts[1:3] == ["api", "connectors"]
        and bool(parts[3])
        and parts[4] == "mcp"
        and parts[5] in {"review", "confirm"}
    )
