"""Closed, bounded Google provider error classification for read transports."""

from __future__ import annotations

import json
import logging
import re
import time

import httpx

logger = logging.getLogger(__name__)

ERROR_RESPONSE_LIMIT = 16 * 1024
RETRYABLE_403_REASONS = frozenset({"rateLimitExceeded", "userRateLimitExceeded"})
NON_REASON_DETAILS = frozenset(
    {
        "type.googleapis.com/google.rpc.Help",
        "type.googleapis.com/google.rpc.LocalizedMessage",
        "type.googleapis.com/google.rpc.RetryInfo",
        "type.googleapis.com/google.rpc.RequestInfo",
    }
)


_CONFIGURATION_REASONS = frozenset({"SERVICEDISABLED", "APIDISABLED", "ACCESSNOTCONFIGURED"})
_SERVICE_NAME = re.compile(r"[a-z][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63}){0,3}\.googleapis\.com")
_CONSUMER_PROJECT = re.compile(r"projects/[0-9]{1,20}")
_LEGACY_PROJECT_NUMBER = re.compile(r"\bprojects?[ /]+([0-9]{6,20})\b")
_OPERATION_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_.]{0,79}")
_LOG_INTERVAL_SECONDS = 300.0
_MAX_LOG_KEYS = 64
_logged_at: dict[tuple[str, str, str], float] = {}


def _configuration_facts(error: dict, service_hint: str | None) -> tuple[str | None, str | None]:
    """Only pattern-validated API and consumer identifiers; never message text."""
    service = service_hint if service_hint and _SERVICE_NAME.fullmatch(service_hint) else None
    consumer = None
    details = error.get("details")
    if isinstance(details, list):
        for item in details[:16]:
            if not isinstance(item, dict) or not str(item.get("@type") or "").endswith(
                "google.rpc.ErrorInfo"
            ):
                continue
            metadata = item.get("metadata")
            if not isinstance(metadata, dict):
                continue
            candidate = metadata.get("service")
            if isinstance(candidate, str) and _SERVICE_NAME.fullmatch(candidate):
                service = candidate
            candidate = metadata.get("consumer")
            if isinstance(candidate, str) and _CONSUMER_PROJECT.fullmatch(candidate):
                consumer = candidate
    if consumer is None:
        # Drive's legacy error shape names the consumer only inside its message.
        # Extract the number alone; the message itself is never kept or logged.
        message = error.get("message")
        match = _LEGACY_PROJECT_NUMBER.search(message[:1024]) if isinstance(message, str) else None
        if match:
            consumer = "projects/" + match.group(1)
    return service, consumer


def _record_configuration_block(operation: str, service: str | None, consumer: str | None) -> None:
    """One bounded operator log per distinct blocked API; the user sees a closed state."""
    safe_operation = operation if _OPERATION_NAME.fullmatch(operation) else "unknown"
    key = (safe_operation, service or "unknown", consumer or "unknown")
    now = time.monotonic()
    last = _logged_at.get(key)
    if last is not None and now - last < _LOG_INTERVAL_SECONDS:
        return
    if len(_logged_at) >= _MAX_LOG_KEYS:
        _logged_at.clear()
    _logged_at[key] = now
    logger.warning(
        "google_provider_configuration_blocked operation=%s service=%s consumer=%s",
        *key,
    )


async def classify_google_forbidden_response(
    response: httpx.Response,
    *,
    strict_drive_retry: bool = False,
    operation: str = "unknown",
    service_hint: str | None = None,
) -> str:
    """Return a closed reason from a bounded 403 body; never expose its message.

    A provider-configuration refusal also records the blocked API and consumer
    project for operators (see ``_configuration_facts``). ``operation`` and
    ``service_hint`` come from the caller's fixed vocabulary, never from input.
    """
    if response.headers.get("Content-Encoding", "identity").lower() != "identity":
        return "resource_denied"
    data = bytearray()
    async for chunk in response.aiter_raw():
        if len(data) + len(chunk) > ERROR_RESPONSE_LIMIT:
            return "resource_denied"
        data.extend(chunk)
    try:
        result = json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        return "resource_denied"
    error = result.get("error") if isinstance(result, dict) else None
    if not isinstance(error, dict) or type(error.get("code")) is not int or error["code"] != 403:
        return "resource_denied"
    errors = error.get("errors")
    # This is the existing Drive retry predicate, including its exact spelling
    # and whole-list validation. Details have never changed that decision.
    if strict_drive_retry and (
        isinstance(errors, list)
        and 1 <= len(errors) <= 16
        and all(
            isinstance(item, dict)
            and isinstance(item.get("reason"), str)
            and item["reason"] in RETRYABLE_403_REASONS
            for item in errors
        )
    ):
        return "rate_limited"
    reasons = set()
    for key in ("errors", "details"):
        values = error.get(key)
        if values is None:
            continue
        if not isinstance(values, list) or len(values) > 16:
            return "resource_denied"
        for item in values:
            if not isinstance(item, dict):
                return "resource_denied"
            reason = item.get("reason")
            if isinstance(reason, str):
                reasons.add(reason.replace("_", "").replace("-", "").upper())
            elif (
                key != "details"
                or reason is not None
                or item.get("@type") not in NON_REASON_DETAILS
            ):
                return "resource_denied"
    if (
        not strict_drive_retry
        and reasons
        and reasons
        <= {reason.replace("_", "").replace("-", "").upper() for reason in RETRYABLE_403_REASONS}
    ):
        return "rate_limited"
    if reasons & _CONFIGURATION_REASONS:
        service, consumer = _configuration_facts(error, service_hint)
        _record_configuration_block(operation, service, consumer)
        return "provider_configuration"
    if reasons & {"ORGRESTRICTION", "DOMAINPOLICY", "ADMINPOLICYENFORCED"}:
        return "provider_policy"
    return "resource_denied"


async def classify_drive_forbidden_response(response: httpx.Response) -> str:
    """The Drive file read's 403, with the fixed operation and service for operators."""
    return await classify_google_forbidden_response(
        response,
        strict_drive_retry=True,
        operation="drive.read",
        service_hint="drive.googleapis.com",
    )
