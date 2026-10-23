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
from typing import Any

from ag_ui.core import BaseEvent, RunErrorEvent

from hushh_mcp.runtime_providers.vertex_failover import is_retryable_vertex_error

SERVER_RESTARTING_CODE = "SERVER_RESTARTING"
MODEL_CAPACITY_CODE = "RESOURCE_EXHAUSTED"
MODEL_UNAVAILABLE_CODE = "MODEL_UNAVAILABLE"
TEXT_AUTHORITY_ENDED_CODE = "TEXT_AUTHORITY_ENDED"
TEXT_CONTENT_FILTERED_CODE = "TEXT_CONTENT_FILTERED"
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
TEXT_AUTHORITY_ENDED_RUN_ERROR = RunErrorEvent(
    message="Chat access changed. Please check your access before trying again.",
    code=TEXT_AUTHORITY_ENDED_CODE,
    metadata={"retryable": False},
)
TEXT_CONTENT_FILTERED_RUN_ERROR = RunErrorEvent(
    message="This response was filtered. Try rephrasing your message.",
    code=TEXT_CONTENT_FILTERED_CODE,
    metadata={"retryable": False},
)
_AUTHORITY_ENDED_MESSAGES = frozenset(
    {
        "Managed Azure processing policy changed",
        "UAT managed text processing policy changed",
        "Current text invocation authority ended",
        "Current owner invocation authority ended",
    }
)
_AUTHORED = {
    event.code: event
    for event in (
        SERVER_RESTARTING_RUN_ERROR,
        MODEL_CAPACITY_RUN_ERROR,
        MODEL_UNAVAILABLE_RUN_ERROR,
        TEXT_AUTHORITY_ENDED_RUN_ERROR,
        TEXT_CONTENT_FILTERED_RUN_ERROR,
    )
}
# The installed bridge turns an exception raised by the ADK run into one of
# these, with ``message=str(exception)``.
_BRIDGE_ERROR_CODES = frozenset({"BACKGROUND_EXECUTION_ERROR", "EXECUTION_ERROR"})
# google.genai: "<code> <STATUS>. {details}". ADK prefixes its 429 with advice
# text, so the token may start any line. Only the first 1 KiB is inspected.
_PROVIDER_STATUS = re.compile(r"(?m)^(\d{3}) [A-Z_]+\.")
# The same status when something wrapped the message ("Error in node x: 429 ...").
_WRAPPED_PROVIDER_STATUS = re.compile(
    r"(?<!\d)(429|500|502|503|504) "
    r"(RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|BAD_GATEWAY|GATEWAY_TIMEOUT)\b"
)
_UNAVAILABLE_STATUS_CODES = frozenset({500, 502, 503, 504})
# The OpenAI SDK's fixed status prefix. Never inspect or retain its response body.
_OPENAI_STATUS = re.compile(r"^Error code: (429|500|502|503|504) - ")


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


def _provider_status(message: object) -> int | None:
    text = str(message or "")[:1024]
    match = (
        _PROVIDER_STATUS.search(text)
        or _WRAPPED_PROVIDER_STATUS.search(text)
        or _OPENAI_STATUS.match(text)
    )
    return int(match.group(1)) if match else None


def transient_model_run_error(event: BaseEvent) -> RunErrorEvent | None:
    """Map an error caused by a transient provider status to a retryable one.

    Regional failover moves a request only while it is being opened. A 429 or
    5xx after the first chunk, or after every location refused, reaches the
    bridge as an exception; the person can succeed by sending again.

    On UAT (2026-10-05) five of fourteen turns ended on a 429 yet reached the
    person as a generic failure: the mapping looked only at two bridge codes and
    at a status that began a line. It now accepts any non-authored run error
    whose message carries a recognisable provider status anywhere in its first
    KiB. The status is the only thing read; nothing from the message is kept.
    """
    if not isinstance(event, RunErrorEvent) or is_authored_run_error(event):
        return None
    status = _provider_status(event.message)
    return _for_status(status) if status is not None else None


def _leaf_exceptions(error: BaseException) -> list[BaseException]:
    """The exceptions inside nested exception groups (a task group wraps its failures)."""
    if isinstance(error, BaseExceptionGroup):
        return [leaf for inner in error.exceptions for leaf in _leaf_exceptions(inner)]
    return [error]


def managed_authority_error(error: BaseEvent | BaseException) -> RunErrorEvent | None:
    """Expected revocation is a refusal; missing authority wiring remains a failure."""
    if isinstance(error, RunErrorEvent):
        return (
            TEXT_AUTHORITY_ENDED_RUN_ERROR
            if error.code in _BRIDGE_ERROR_CODES and error.message in _AUTHORITY_ENDED_MESSAGES
            else None
        )
    if isinstance(error, BaseException):
        from hushh_mcp.runtime_providers.managed_text import ManagedTextAuthorityError

        leaves = _leaf_exceptions(error)
        if all(
            isinstance(leaf, ManagedTextAuthorityError) and str(leaf) in _AUTHORITY_ENDED_MESSAGES
            for leaf in leaves
        ):
            return TEXT_AUTHORITY_ENDED_RUN_ERROR
    return None


def content_filtered_error(error: BaseEvent | BaseException) -> RunErrorEvent | None:
    """Only an explicit provider filter signal maps to this authored refusal."""
    from hushh_mcp.runtime_providers.azure_call_lifecycle import (
        AZURE_CONTENT_FILTERED_MESSAGE,
        AzureContentFilteredError,
    )

    if isinstance(error, RunErrorEvent):
        if error.code in _BRIDGE_ERROR_CODES and error.message == AZURE_CONTENT_FILTERED_MESSAGE:
            return TEXT_CONTENT_FILTERED_RUN_ERROR
    elif isinstance(error, BaseException) and all(
        isinstance(leaf, AzureContentFilteredError) for leaf in _leaf_exceptions(error)
    ):
        return TEXT_CONTENT_FILTERED_RUN_ERROR
    return None


def transient_model_error_for_exception(error: BaseException) -> RunErrorEvent | None:
    """The same mapping for an exception that escaped the bridge."""
    if not isinstance(error, Exception):
        return None
    for leaf in _leaf_exceptions(error):
        from openai import APIConnectionError, APIStatusError, APITimeoutError

        if isinstance(leaf, (APIConnectionError, APITimeoutError)):
            return MODEL_UNAVAILABLE_RUN_ERROR
        if isinstance(leaf, APIStatusError):
            mapped = _for_status(leaf.status_code)
            if mapped is not None:
                return mapped
        if isinstance(leaf, Exception) and is_retryable_vertex_error(leaf):
            code = getattr(leaf, "code", None)
            return (
                _for_status(code if isinstance(code, int) else None) or MODEL_UNAVAILABLE_RUN_ERROR
            )
    return None


def server_is_draining() -> bool:
    """True once the ASGI server began shutting down (Cloud Run SIGTERM).

    sse-starlette sets this from uvicorn's exit handler before it cancels open
    event streams, so it is already true when a cancelled stream unwinds.
    """
    from sse_starlette.sse import AppStatus

    return bool(AppStatus.should_exit)


def error_class(code: Any) -> str:
    """Classify a protocol error without retaining its untrusted message/code."""
    if not isinstance(code, str):
        return "untyped"
    if code.startswith("MCP_"):
        return "connector"
    if code.startswith("DATABASE_"):
        return "database"
    if code.startswith("AGENT_RUNTIME_"):
        return "runtime"
    if code in {"MODEL_ERROR", MODEL_CAPACITY_CODE, MODEL_UNAVAILABLE_CODE}:
        return "model"
    if code == SERVER_RESTARTING_CODE:
        return "shutdown"
    if code in {TEXT_AUTHORITY_ENDED_CODE, TEXT_CONTENT_FILTERED_CODE}:
        return "refusal"
    return "other"


# The codes the AG-UI bridge and this module author. Anything else is "unlisted":
# a code is logged only from this fixed set, never from a provider-controlled value.
_KNOWN_ERROR_CODES = frozenset(
    {
        "AGENT_ERROR",
        "BACKGROUND_EXECUTION_ERROR",
        "ENCODING_ERROR",
        "EXECUTION_ERROR",
        "EXECUTION_TIMEOUT",
        "NO_TOOL_RESULTS",
        "PENDING_TOOL_CALLS",
        "TOOL_RESULT_BUFFER_ERROR",
        "TOOL_RESULT_PROCESSING_ERROR",
        MODEL_CAPACITY_CODE,
        MODEL_UNAVAILABLE_CODE,
        SERVER_RESTARTING_CODE,
        TEXT_AUTHORITY_ENDED_CODE,
        TEXT_CONTENT_FILTERED_CODE,
    }
)


def error_code(code: Any) -> str:
    """A run error's code when it is one we know, else a fixed placeholder.

    Dotted and lower-case on purpose: the log redactor masks any 24-128 character
    token made of letters, digits, `_` and `-` as a possible identifier, which
    would turn `BACKGROUND_EXECUTION_ERROR` into `[REDACTED]` in the very line it
    is meant to explain.
    """
    if not isinstance(code, str):
        return "untyped"
    return code.lower().replace("_", ".") if code in _KNOWN_ERROR_CODES else "unlisted"
