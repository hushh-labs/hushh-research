"""Local stdio vs. remote MCP transport marker.

``mcp_server.py`` and ``mcp_remote.py`` share the exact same ``Server``
instance and tool handler registry (``mcp_remote.py`` imports
``mcp_server.server`` directly). Some behavior, notably automatic local
decrypt-and-narrow of scoped exports and auto-managed connector keypairs,
must only ever run on the local stdio transport (the developer's own trusted
machine, reachable at 127.0.0.1), never on the remote transport mounted
in-process on Hussh's own Cloud Run backend and used by third-party
connectors.

This is a plain module-level flag, not a ``ContextVar``: the stdio server is
a single-process, single-connection subprocess with no concurrent-request
isolation concerns, so a simple global is sufficient and avoids the
complexity of threading a context through every call site. The remote
transport (``mcp_remote.py``) never imports or calls
``mark_local_stdio_transport``, so it can never observe this flag as
``True``.
"""

from __future__ import annotations

_is_local_stdio_transport = False


def mark_local_stdio_transport() -> None:
    """Mark the current process as the local stdio MCP transport.

    Call this exactly once, from ``mcp_server.py``'s ``__main__`` entry
    point, before the stdio server starts serving requests.
    """
    global _is_local_stdio_transport
    _is_local_stdio_transport = True


def is_local_stdio_transport() -> bool:
    """Whether this process is the local stdio MCP transport.

    Always ``False`` inside the remote/hosted MCP process (mounted at
    ``/mcp`` on the FastAPI backend), since that process never calls
    ``mark_local_stdio_transport``.
    """
    return _is_local_stdio_transport
