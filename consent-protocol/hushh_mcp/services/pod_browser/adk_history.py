"""Bounded native Browser continuation; private media stays in pod memory."""

from __future__ import annotations

from .contracts import BrowserRefused


def require_completed_calls(events) -> None:
    """Never let native task resumption replay an unanswered computer call.

    Preserve all events and provider signatures. An unmatched complete call
    requires owner reconciliation; deleting it would hide an uncertain effect.
    """
    pending: dict[str, str] = {}
    size = 0
    for event in events:
        size += len(event.model_dump_json().encode())
        if size > 64 * 1024 * 1024:
            raise BrowserRefused("BROWSER_CONTINUATION_LIMIT")
        if event.partial:
            continue  # streaming fragments are not executable call records
        for part in event.content.parts or [] if event.content else []:
            call, response = part.function_call, part.function_response
            if call is not None and call.name != "finish_task":
                if not call.id or call.id in pending:
                    raise BrowserRefused("BROWSER_CONTINUATION_UNCERTAIN")
                pending[call.id] = call.name
            if response is not None and response.name != "finish_task":
                if not response.id or pending.pop(response.id, None) != response.name:
                    raise BrowserRefused("BROWSER_CONTINUATION_UNCERTAIN")
    if pending:
        raise BrowserRefused("BROWSER_CONTINUATION_UNCERTAIN")
