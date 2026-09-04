"""Request-bounded secret references for ADK session state.

AG-UI may project session state to the client. Credentials and private context
therefore live in a process-local, expiring map and session state carries only
an opaque reference. A resumed HTTP request always refreshes the reference from
its newly validated VAULT_OWNER token.
"""

from __future__ import annotations

import secrets
import threading
import time

_PREFIX = "one_secret_ref:"
_TTL_SECONDS = 20 * 60
_lock = threading.Lock()
_values: dict[str, tuple[float, str]] = {}


def store_request_secret(value: str) -> str:
    clean = str(value or "").strip()
    if not clean:
        return ""
    reference = f"{_PREFIX}{secrets.token_urlsafe(24)}"
    now = time.monotonic()
    with _lock:
        expired = [key for key, (deadline, _) in _values.items() if deadline <= now]
        for key in expired:
            _values.pop(key, None)
        _values[reference] = (now + _TTL_SECONDS, clean)
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


__all__ = ["resolve_request_secret", "store_request_secret"]
