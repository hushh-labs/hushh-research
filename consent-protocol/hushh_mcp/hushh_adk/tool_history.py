"""Validate original tool receipts before an SDK can prune malformed history."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


def validate_tool_result_history(
    callback_context: Any,
    llm_request: Any,
    *,
    transport_placeholder_matches: Callable[[Any, Any, str | None], bool] | None = None,
) -> None:
    """Keep exact chronological ID/name pairs; pending calls remain valid."""
    calls: dict[tuple[str | None, str | None, str | None, str | None], str | None] = {}
    for event in callback_context.session.events:
        for part in (event.content.parts or ()) if event.content else ():
            if (call := part.function_call) is not None:
                calls[
                    event.isolation_scope,
                    event.branch,
                    call.id,
                    call.name if call.id is None else None,
                ] = call.name
            if (result := part.function_response) is not None:
                identity = (
                    event.isolation_scope,
                    event.branch,
                    result.id,
                    result.name if result.id is None else None,
                )
                if identity not in calls or (
                    calls[identity] != result.name
                    and not (
                        transport_placeholder_matches
                        and transport_placeholder_matches(event, result, calls[identity])
                    )
                ):
                    raise ValueError("Tool result has no preceding matching call")
