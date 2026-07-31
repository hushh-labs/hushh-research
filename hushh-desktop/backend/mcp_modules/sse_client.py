# mcp_modules/sse_client.py
"""
Consent SSE client (deprecated).

Consent polling/SSE wait flow is disabled in regulated cutover.
This module remains as a compatibility shim for old callers.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class ConsentResolution:
    """Result for legacy callers."""

    status: str  # "granted", "denied", "timeout", "error"
    request_id: str
    scope: Optional[str] = None
    message: Optional[str] = None


async def wait_for_consent_via_sse(
    user_id: str,
    request_id: str,
    scope: str,
    fastapi_url: str,
    timeout_seconds: int = 300,
) -> ConsentResolution:
    """Deprecated shim: always returns error with migration guidance."""
    _ = user_id
    _ = fastapi_url
    _ = timeout_seconds
    return ConsentResolution(
        status="error",
        request_id=request_id,
        scope=scope,
        message=(
            "Consent SSE wait is disabled. Use request_consent/check_consent_status "
            "or rely on in-app FCM-driven approval flow."
        ),
    )
