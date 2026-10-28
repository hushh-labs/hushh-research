"""Closed, bounded Google provider error classification for read transports."""

from __future__ import annotations

import json

import httpx

ERROR_RESPONSE_LIMIT = 16 * 1024
RETRYABLE_403_REASONS = frozenset({"rateLimitExceeded", "userRateLimitExceeded"})


async def classify_google_forbidden_response(response: httpx.Response) -> str:
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
    reasons = set()
    for key in ("errors", "details"):
        values = error.get(key)
        if isinstance(values, list):
            for item in values[:16]:
                if isinstance(item, dict) and isinstance(item.get("reason"), str):
                    reasons.add(item["reason"].replace("_", "").replace("-", "").upper())
    if reasons and reasons <= {
        reason.replace("_", "").replace("-", "").upper() for reason in RETRYABLE_403_REASONS
    }:
        return "rate_limited"
    if reasons & {"SERVICEDISABLED", "APIDISABLED", "ACCESSNOTCONFIGURED"}:
        return "provider_configuration"
    if reasons & {"ORGRESTRICTION", "DOMAINPOLICY", "ADMINPOLICYENFORCED"}:
        return "provider_policy"
    return "resource_denied"
