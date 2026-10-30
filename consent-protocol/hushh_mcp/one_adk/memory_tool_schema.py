"""Compose recall tool metadata without opening custody during startup rehearsal."""


def memory_recall_tools(available: bool | None = None) -> list:
    """Normal turns resolve their service; rehearsal supplies a schema descriptor."""
    if available is None:
        from hushh_mcp.services.pod_memory_service import resolve_pod_memory_service

        available = resolve_pod_memory_service() is not None
    elif type(available) is not bool:
        raise TypeError("Memory schema availability must be a boolean")
    if not available:
        return []
    from google.adk.tools import load_memory

    return [load_memory]
