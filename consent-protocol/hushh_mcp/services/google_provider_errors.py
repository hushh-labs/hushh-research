"""Closed, bounded Google provider error classification for read transports."""

from __future__ import annotations

import json

import httpx

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


async def classify_google_forbidden_response(
    response: httpx.Response, *, strict_drive_retry: bool = False
) -> str:
    """Return a closed reason from a bounded 403 body; never expose its message."""
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
    if reasons & {"SERVICEDISABLED", "APIDISABLED", "ACCESSNOTCONFIGURED"}:
        return "provider_configuration"
    if reasons & {"ORGRESTRICTION", "DOMAINPOLICY", "ADMINPOLICYENFORCED"}:
        return "provider_policy"
    return "resource_denied"
