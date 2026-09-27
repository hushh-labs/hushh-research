"""Retryable, content-free terminal errors for the private agent's AG-UI stream.

A turn that dies for a reason the person can fix only by sending again (the
server restarting under them, the model provider out of capacity mid-answer)
must still end with a terminal ``RUN_ERROR``. Each event here is authored: a
fixed message, a stable code and ``metadata.retryable``. None carries provider
text, request content or an identifier, so they may cross the public-output
projection unchanged. Classification reads only the leading HTTP status token
that ``google.genai`` puts on its errors, never the message after it.
"""

from __future__ import annotations

import re

from ag_ui.core import BaseEvent, RunErrorEvent

from hushh_mcp.runtime_providers.vertex_failover import is_retryable_vertex_error

SERVER_RESTARTING_CODE = "SERVER_RESTARTING"
MODEL_CAPACITY_CODE = "RESOURCE_EXHAUSTED"
MODEL_UNAVAILABLE_CODE = "MODEL_UNAVAILABLE"
RETRYABLE_METADATA = {"retryable": True}

SERVER_RESTARTING_RUN_ERROR = RunErrorEvent(
    message="One was interrupted because the service restarted. Please send that again.",
    code=SERVER_RESTARTING_CODE,
    metadata=RETRYABLE_METADATA,
)
MODEL_CAPACITY_RUN_ERROR = RunErrorEvent(
    message="One is temporarily at capacity. Please try again in a moment.",
    code=MODEL_CAPACITY_CODE,
    metadata=RETRYABLE_METADATA,
)
MODEL_UNAVAILABLE_RUN_ERROR = RunErrorEvent(
    message="One's model service was briefly unavailable. Please try again.",
    code=MODEL_UNAVAILABLE_CODE,
    metadata=RETRYABLE_METADATA,
)
_AUTHORED = {
    event.code: event
    for event in (
        SERVER_RESTARTING_RUN_ERROR,
        MODEL_CAPACITY_RUN_ERROR,
        MODEL_UNAVAILABLE_RUN_ERROR,
    )
}
# The installed bridge turns an exception raised by the ADK run into one of
# these, with ``message=str(exception)``.
_BRIDGE_ERROR_CODES = frozenset({"BACKGROUND_EXECUTION_ERROR", "EXECUTION_ERROR"})
# google.genai: "<code> <STATUS>. {details}". ADK prefixes its 429 with advice
# text, so the token may start any line. Only the first 1 KiB is inspected.
_PROVIDER_STATUS = re.compile(r"(?m)^(\d{3}) [A-Z_]+\.")
_UNAVAILABLE_STATUS_CODES = frozenset({500, 502, 503, 504})


def is_authored_run_error(event: BaseEvent) -> bool:
    """True only for an exact event from this module, never a lookalike code."""
    if not isinstance(event, RunErrorEvent):
        return False
    authored = _AUTHORED.get(event.code or "")
    return authored is not None and event.message == authored.message


def _for_status(code: int | None) -> RunErrorEvent | None:
    if code == 429:
        return MODEL_CAPACITY_RUN_ERROR
    if code in _UNAVAILABLE_STATUS_CODES:
        return MODEL_UNAVAILABLE_RUN_ERROR
    return None


def transient_model_run_error(event: BaseEvent) -> RunErrorEvent | None:
    """Map a bridge error caused by a transient provider status to a retryable one.

    Regional failover moves a request only while it is being opened. A 429 or
    5xx after the first chunk, or after every location refused, reaches the
    bridge as an exception; the person can succeed by sending again.
    """
    if not isinstance(event, RunErrorEvent) or event.code not in _BRIDGE_ERROR_CODES:
        return None
    match = _PROVIDER_STATUS.search(str(event.message or "")[:1024])
    return _for_status(int(match.group(1))) if match else None


def transient_model_error_for_exception(error: BaseException) -> RunErrorEvent | None:
    """The same mapping for an exception that escaped the bridge."""
    if not isinstance(error, Exception) or not is_retryable_vertex_error(error):
        return None
    code = getattr(error, "code", None)
    return _for_status(code if isinstance(code, int) else None) or MODEL_UNAVAILABLE_RUN_ERROR


def server_is_draining() -> bool:
    """True once the ASGI server began shutting down (Cloud Run SIGTERM).

    sse-starlette sets this from uvicorn's exit handler before it cancels open
    event streams, so it is already true when a cancelled stream unwinds.
    """
    from sse_starlette.sse import AppStatus

    return bool(AppStatus.should_exit)
