"""Content-free Azure call observation and bounded workload authentication."""

from __future__ import annotations

import asyncio
import contextvars
import logging
import time
from contextlib import aclosing
from typing import Any
from uuid import uuid4

logger = logging.getLogger("hushh_mcp.runtime_providers.azure_adk")
_CALL: contextvars.ContextVar[str] = contextvars.ContextVar("azure_call_span", default="none")
_PROVIDER_CODES = {
    "content_filter": "content.filter",
    "invalid_encrypted_content": "invalid.encrypted.content",
    "invalid_prompt": "invalid.prompt",
    "invalid_request_error": "invalid.request",
    "rate_limit_exceeded": "rate.limit",
    "server_error": "server.error",
}


class AzureAuthenticationError(RuntimeError):
    """Workload authentication failed before model I/O; not a model outage."""


class AzureTokenServiceUnavailableError(AzureAuthenticationError):
    """A classified token-service transport failure, without a credential denial."""


def _token_service_unavailable(error: Exception) -> bool:
    from azure.core.exceptions import ServiceRequestError, ServiceResponseError
    from httpx import HTTPStatusError, NetworkError, TimeoutException

    def status(cause):
        return (
            cause.response.status_code
            if isinstance(cause, HTTPStatusError)
            else getattr(cause, "status_code", None)
        )

    seen, causes = set(), []
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        causes.append(current)
        current = current.__cause__ or current.__context__
    # A preserved identity/configuration denial always outranks an inner outage.
    if any(
        isinstance(cause, (PermissionError, ValueError)) or status(cause) in {400, 401, 403, 404}
        for cause in causes
    ):
        return False
    return any(
        isinstance(
            cause,
            (
                TimeoutError,
                NetworkError,
                TimeoutException,
                ServiceRequestError,
                ServiceResponseError,
            ),
        )
        or status(cause) in {408, 429, 500, 502, 503, 504}
        for cause in causes
    )


class AzureProtocolError(ValueError):
    """Closed diagnostic code; never provider prose or a reason to relax admission."""

    def __init__(self, code: str) -> None:
        self.protocol_code = (
            code
            if code
            in {
                "search.no_retrieval",
                "search.invalid_citation",
                "search.no_sources",
                "search.overlap",
                "search.billing",
            }
            else "unlisted"
        )
        super().__init__(
            "Completed Azure web retrieval has no valid billable request count"
            if self.protocol_code == "search.billing"
            else AZURE_PROTOCOL_MESSAGE
        )


def record_response_metadata(response: Any, counters: dict[str, Any]) -> None:
    """Retain bounded usage even when unary response validation rejects output."""

    def value(obj: Any, key: str) -> Any:
        return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)

    status = value(response, "status")
    counters["response_status"] = (
        status
        if isinstance(status, str)
        and status in {"completed", "incomplete", "failed", "cancelled", "queued", "in_progress"}
        else "unlisted"
    )
    reason = value(value(response, "incomplete_details"), "reason")
    counters["incomplete_reason"] = (
        reason
        if isinstance(reason, str) and reason in {"max_output_tokens", "content_filter"}
        else "none"
        if reason is None
        else "unlisted"
    )
    usage = value(response, "usage")
    for source, target in (
        ("input_tokens", "prompt_token_count"),
        ("output_tokens", "candidates_token_count"),
        ("total_tokens", "total_token_count"),
    ):
        count = value(usage, source)
        if type(count) is int and 0 <= count <= 1_000_000_000:
            counters[target] = count


AZURE_CONTENT_FILTERED_MESSAGE = "Azure response stopped by content filtering"
AZURE_RATE_LIMITED_MESSAGE = "Azure model capacity is temporarily unavailable"
AZURE_PROTOCOL_MESSAGE = "Azure search returned no verified citations"
AZURE_PROTOCOL_MESSAGES = frozenset(
    {AZURE_PROTOCOL_MESSAGE, "Completed Azure web retrieval has no valid billable request count"}
)
_PROTOCOL_CODES = {
    "Azure model response did not complete": "response.not_complete",
    "Unsupported or refused Azure output": "response.invalid_output",
    "Unsupported Azure native output tool": "response.invalid_output",
    "Azure model returned no usable output": "response.empty",
    "Azure streaming response ended before completion": "stream.no_completion",
    "Azure streaming response did not complete": "stream.not_complete",
}


class AzureContentFilteredError(RuntimeError):
    """The provider explicitly filtered output; never retry or switch processors."""

    def __init__(self) -> None:
        super().__init__(AZURE_CONTENT_FILTERED_MESSAGE)


class AzureRateLimitedError(RuntimeError):
    """An explicit rate limit inside an HTTP-success stream has no HTTP status."""

    def __init__(self) -> None:
        super().__init__(AZURE_RATE_LIMITED_MESSAGE)


async def acquire_token(token_supplier, counters: dict[str, Any]) -> str:
    auth_started = time.perf_counter()
    try:
        async with asyncio.timeout(5):
            token = await asyncio.to_thread(token_supplier)
    except Exception as error:
        if _token_service_unavailable(error):
            raise AzureTokenServiceUnavailableError("Azure token service is unavailable") from None
        raise AzureAuthenticationError("Azure workload authentication failed") from None
    finally:
        counters["auth_ms"] = round((time.perf_counter() - auth_started) * 1000)
    if not isinstance(token, str) or not token:
        raise AzureAuthenticationError("Azure managed model token is unavailable")
    return token


def _failure_details(error: Exception) -> tuple[str, int, str]:
    from openai import APIConnectionError, APIError, APITimeoutError

    candidate = getattr(error, "status_code", None)
    status = candidate if type(candidate) is int and 100 <= candidate <= 599 else 0
    code = error.code if isinstance(error, APIError) and isinstance(error.code, str) else None
    filtered = isinstance(error, AzureContentFilteredError) or (
        isinstance(error, APIError) and code == "content_filter" and status in {0, 400}
    )
    limited = isinstance(error, AzureRateLimitedError) or (
        isinstance(error, APIError) and code == "rate_limit_exceeded" and status == 0
    )
    kind = (
        "filtered"
        if filtered
        else "auth"
        if isinstance(error, AzureAuthenticationError) or status in {401, 403}
        else "timeout"
        if isinstance(error, (TimeoutError, APITimeoutError))
        else "connection"
        if isinstance(error, APIConnectionError)
        else "quota"
        if limited or status == 429
        else "server"
        if status >= 500
        else "protocol"
        if isinstance(error, ValueError)
        else "authority"
        if isinstance(error, PermissionError)
        else "other"
    )
    return kind, status, _PROVIDER_CODES.get(code, "unlisted") if code else "none"


async def observe_call(source, model: str, counters: dict[str, Any]):
    started = time.perf_counter()
    parent = _CALL.get()
    call_id = uuid4().hex[:16]
    token = _CALL.set(call_id)
    from hushh_mcp.one_adk.queued_input import current_run

    active = current_run()
    run = active.run_id[:8] if active is not None else "unbound"
    outcome, error_kind, status = "cancelled", "none", 0
    try:
        async with aclosing(source) as results:
            async for result in results:
                if counters["first_output_ms"] is None:
                    counters["first_output_ms"] = round((time.perf_counter() - started) * 1000)
                if not result.partial and result.usage_metadata is not None:
                    usage = result.usage_metadata
                    for name in (
                        "prompt_token_count",
                        "candidates_token_count",
                        "total_token_count",
                        "cached_content_token_count",
                        "thoughts_token_count",
                    ):
                        counters[name] = getattr(usage, name, None)
                yield result
        outcome = "completed"
    except Exception as error:
        outcome = "failed"
        error_kind, status, counters["provider_code"] = _failure_details(error)
        counters["protocol_code"] = (
            error.protocol_code
            if isinstance(error, AzureProtocolError)
            else _PROTOCOL_CODES.get(str(error), "unlisted")
            if error_kind == "protocol"
            else "none"
        )
        if error_kind == "filtered" and not isinstance(error, AzureContentFilteredError):
            raise AzureContentFilteredError() from None
        if error_kind == "quota" and status == 0 and counters["provider_code"] == "rate.limit":
            raise AzureRateLimitedError() from None
        raise
    finally:
        logger.info(
            "azure_model_call_complete provider=azure_openai model=%s outcome=%s "
            "error_kind=%s status=%s auth_ms=%s first_output_ms=%s elapsed_ms=%s "
            "reasoning_effort=%s input_tokens=%s output_tokens=%s cached_tokens=%s "
            "reasoning_tokens=%s total_tokens=%s provider_code=%s "
            "protocol_code=%s response_status=%s incomplete_reason=%s "
            "run=%s call_id=%s parent_call_id=%s role=%s stream=%s dispatches=%s "
            "headers_ms=%s wire_first_event_ms=%s wire_first_text_ms=%s wire_completed_ms=%s",
            model,
            outcome,
            error_kind,
            status,
            counters["auth_ms"],
            counters["first_output_ms"],
            round((time.perf_counter() - started) * 1000),
            counters.get("reasoning_effort", "provider_default"),
            counters.get("prompt_token_count"),
            counters.get("candidates_token_count"),
            counters.get("cached_content_token_count"),
            counters.get("thoughts_token_count"),
            counters.get("total_token_count"),
            counters.get("provider_code", "none"),
            counters.get("protocol_code", "none"),
            counters.get("response_status", "unknown"),
            counters.get("incomplete_reason", "unknown"),
            run,
            call_id,
            parent,
            counters.get("role", "unbound"),
            counters.get("stream", False),
            counters.get("dispatches", 0),
            counters.get("headers_ms"),
            counters.get("wire_first_event_ms"),
            counters.get("wire_first_text_ms"),
            counters.get("wire_completed_ms"),
        )
        _CALL.reset(token)
