"""Per-capability dependency health, observed from real traffic.

Two separate readers, two separate shapes:

* ``public_snapshot()`` is safe to serve to a browser. It says only whether a
  capability is usable. It never carries a provider name, a status code, a
  project number, or an error string -- a person must never be shown "Vertex",
  "403", or "dunning".
* ``diagnostic_snapshot()`` keeps the structured cause for operators and logs.

Recovery is automatic and requires no redeploy. A failure marks the capability
unavailable for ``_COOLDOWN_SECONDS`` only; once that lapses the capability is
treated as usable again so the next real request re-probes the provider. A
success clears the mark immediately. That is deliberately a cooldown rather
than a latch: nothing here has to be told the provider came back.

The cooldown also stops a known-down provider being hammered once per render --
callers can ask ``is_available()`` and fail fast with a friendly message
instead of waiting out another 25-second timeout.
"""

from __future__ import annotations

import threading
import time
from typing import Any

AVAILABLE = "available"
UNAVAILABLE = "unavailable"

#: How long one observed failure suppresses a capability. Short on purpose: the
#: cost of being wrong is one extra failed request, while the cost of a long
#: latch is a feature that stays dark after the provider has recovered.
_COOLDOWN_SECONDS = 60.0

_lock = threading.Lock()
_state: dict[str, dict[str, Any]] = {}


def _now() -> float:
    return time.monotonic()


def record_capability_failure(
    capability: str,
    classification: str,
    error: BaseException | None = None,
    *,
    provider: str = "vertex",
) -> None:
    """Note that a capability just failed, and why.

    Only the classification is kept for the public view. The error text is kept
    for diagnostics, truncated, and never leaves this process except through
    ``diagnostic_snapshot``.
    """
    with _lock:
        _state[capability] = {
            "capability": capability,
            "provider": provider,
            "status": UNAVAILABLE,
            "reason_code": classification,
            "observed_at": _now(),
            "detail": str(error)[:200] if error is not None else "",
        }


def record_capability_success(capability: str) -> None:
    """Clear a capability the moment it works again."""
    with _lock:
        _state.pop(capability, None)


def is_available(capability: str) -> bool:
    """Whether a capability is currently believed usable.

    Unknown capabilities are available: this registry only ever records
    negatives, so silence means nothing has gone wrong.
    """
    with _lock:
        entry = _state.get(capability)
        if entry is None:
            return True
        if _now() - float(entry["observed_at"]) >= _COOLDOWN_SECONDS:
            # Cooldown lapsed. Drop the mark so the next call re-probes for
            # real -- this is the automatic-recovery path.
            _state.pop(capability, None)
            return True
        return False


def public_snapshot(capabilities: tuple[str, ...]) -> dict[str, str]:
    """Capability -> available|unavailable. Safe to serve to a browser."""
    return {name: (AVAILABLE if is_available(name) else UNAVAILABLE) for name in capabilities}


def diagnostic_snapshot() -> list[dict[str, Any]]:
    """Structured causes for operators. Never serve this to an end user."""
    with _lock:
        entries = list(_state.values())
    return [
        {
            "capability": entry["capability"],
            "provider": entry["provider"],
            "status": entry["status"],
            "reason_code": entry["reason_code"],
            "age_seconds": round(_now() - float(entry["observed_at"]), 1),
        }
        for entry in entries
    ]


def reset_for_tests() -> None:
    with _lock:
        _state.clear()
