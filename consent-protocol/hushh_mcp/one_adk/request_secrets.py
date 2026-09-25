"""Request-bounded secret references for ADK session state.

AG-UI may project session state to the client. Credentials and private context
therefore live in a process-local, expiring map and session state carries only
an opaque reference. A resumed HTTP request always refreshes the reference from
its newly validated VAULT_OWNER token.
"""

from __future__ import annotations

import asyncio
import secrets
import threading
import time

_PREFIX = "one_secret_ref:"
_TTL_SECONDS = 20 * 60
_lock = threading.Lock()
_values: dict[str, tuple[float, str]] = {}


def store_request_secret(value: str, *, ttl_seconds: int = _TTL_SECONDS) -> str:
    clean = str(value or "").strip()
    if not clean:
        return ""
    reference = f"{_PREFIX}{secrets.token_urlsafe(24)}"
    now = time.monotonic()
    with _lock:
        expired = [key for key, (deadline, _) in _values.items() if deadline <= now]
        for key in expired:
            _values.pop(key, None)
        _values[reference] = (now + min(_TTL_SECONDS, max(1, ttl_seconds)), clean)
    # Short-lived request handoffs are created on the ASGI event loop. Purge
    # abandoned credentials even when no subsequent request touches the store.
    if ttl_seconds != _TTL_SECONDS:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # Synchronous callers must not create a short-lived handoff that
            # can outlive its cleanup scheduler.
            with _lock:
                _values.pop(reference, None)
            raise RuntimeError("Short-lived handoffs require an active event loop.") from None
        loop.call_later(min(_TTL_SECONDS, max(1, ttl_seconds)), consume_request_secret, reference)
    return reference


def resolve_request_secret(value: object) -> str:
    candidate = str(value or "").strip()
    if not candidate.startswith(_PREFIX):
        return candidate
    with _lock:
        record = _values.get(candidate)
        if not record or record[0] <= time.monotonic():
            _values.pop(candidate, None)
            return ""
        return record[1]


def consume_request_secret(reference: object) -> str:
    """Strict single-use handoff; unlike the legacy resolver, never accept literals."""
    if not isinstance(reference, str) or not reference.startswith(_PREFIX):
        return ""
    with _lock:
        record = _values.pop(reference, None)
        return record[1] if record and record[0] > time.monotonic() else ""


__all__ = ["consume_request_secret", "resolve_request_secret", "store_request_secret"]
