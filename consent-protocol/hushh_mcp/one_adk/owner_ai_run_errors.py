"""Typed chat errors when the provider refuses the key the owner sealed to their agent.

The owner's "Bring your own AI" selection (``pod_ai_selection``) runs every turn with
no fallback, so a refused key must reach the app as something it can explain, not as
"One couldn't finish that request". The pod's AG-UI chat meets a refusal in two
shapes: an exception that escaped the run, or the bridge's ``RUN_ERROR`` built from
``str(exception)``. Both become one authored event: ``OWNER_AI_KEY_REFUSED`` or
``OWNER_AI_QUOTA_EXCEEDED``, a fixed message, and the provider's name in metadata.

Only the leading status token is read from a bridge message, in the two formats the
provider SDKs write (``Error code: 401 - ...`` and ``401 UNAUTHENTICATED. ...``), plus
Gemini's own marker for an invalid key. The rest of that text quotes the request and
sometimes part of the key, and it never leaves this module. With no sealed selection
nothing here applies, which is every hub turn and every pod turn on today's paths.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ag_ui.core import BaseEvent, RunErrorEvent

OWNER_AI_KEY_REFUSED = "OWNER_AI_KEY_REFUSED"
OWNER_AI_QUOTA_EXCEEDED = "OWNER_AI_QUOTA_EXCEEDED"
_MESSAGES = {
    OWNER_AI_KEY_REFUSED: "Your AI provider refused your key. Check it in your AI settings.",
    OWNER_AI_QUOTA_EXCEEDED: "Your AI provider says this key is out of quota for now.",
}
_BRIDGE_ERROR_CODES = frozenset({"BACKGROUND_EXECUTION_ERROR", "EXECUTION_ERROR"})
_OPENAI_STATUS = re.compile(r"^Error code: (\d{3})\b")
_GENAI_STATUS = re.compile(r"(?m)^(\d{3}) [A-Z_]+\.")
_INVALID_KEY_MARKERS = ("api_key_invalid", "api key not valid")


def _selection_provider() -> Optional[str]:
    from hushh_mcp.services.pod_ai_selection import current_ai_selection  # noqa: PLC0415

    selection = current_ai_selection()
    return selection.provider if selection is not None else None


def _event(code: Optional[str], provider: str) -> Optional[RunErrorEvent]:
    """The authored event for a refusal code, noted for the owner's status read."""
    if code is None:
        return None
    from hushh_mcp.services.pod_ai_selection import note_ai_selection_failure  # noqa: PLC0415

    note_ai_selection_failure(code)
    typed = f"OWNER_AI_{code}"
    return RunErrorEvent(
        message=_MESSAGES[typed], code=typed, metadata={"provider": provider, "retryable": False}
    )


def owner_ai_error_for_exception(exc: BaseException) -> Optional[RunErrorEvent]:
    """An escaped exception that is the provider refusing the sealed key."""
    provider = _selection_provider()
    if provider is None:
        return None
    from hushh_mcp.services.pod_ai_selection_check import provider_refusal  # noqa: PLC0415

    return _event(provider_refusal(exc), provider)


def _bridge_refusal(message: str) -> Optional[str]:
    head = message[:1024]
    match = _OPENAI_STATUS.search(head) or _GENAI_STATUS.search(head)
    status = int(match.group(1)) if match else None
    invalid_key = any(marker in head.lower() for marker in _INVALID_KEY_MARKERS)
    if status in {401, 403} or (status == 400 and invalid_key):
        return "KEY_REFUSED"
    return "QUOTA_EXCEEDED" if status == 429 else None


def owner_ai_bridge_error(event: BaseEvent) -> Optional[RunErrorEvent]:
    """The bridge's stringified provider refusal of the sealed key, typed."""
    if not isinstance(event, RunErrorEvent) or event.code not in _BRIDGE_ERROR_CODES:
        return None
    provider = _selection_provider()
    if provider is None:
        return None
    return _event(_bridge_refusal(str(event.message or "")), provider)


def is_owner_ai_run_error(event: Any) -> bool:
    """True only for an event this module authored, never a lookalike code."""
    return (
        isinstance(event, RunErrorEvent)
        and event.code in _MESSAGES
        and event.message == _MESSAGES[event.code]
    )


__all__ = [
    "OWNER_AI_KEY_REFUSED",
    "OWNER_AI_QUOTA_EXCEEDED",
    "is_owner_ai_run_error",
    "owner_ai_bridge_error",
    "owner_ai_error_for_exception",
]
