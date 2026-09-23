"""Opt-in, local-only diagnostics for the Gmail KYC intake pipeline.

This deliberately bypasses the application logger: detailed diagnostic events
must never appear in shared terminal output, request telemetry, or API
responses. Events contain only correlation IDs, counts, status codes, and
hashes of Gmail message IDs--never message text, headers, addresses, OAuth
tokens, or other credentials.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import os
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_RUN_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "kyc_debug_run_id", default=None
)
_WRITE_LOCK = threading.Lock()
_HOSTED_ENVIRONMENTS = frozenset({"production", "prod", "uat", "staging"})
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_ALLOWED_FIELD_NAMES = frozenset(
    {
        "accepted",
        "attempt",
        "backfill_pending",
        "candidate_count",
        "candidate_scope_count",
        "classifier_policy_refresh",
        "classifier_policy_version",
        "classified_count",
        "confidence",
        "created",
        "eligible_count",
        "error_code",
        "error_type",
        "excluded_system_labels",
        "failed_count",
        "failure_count",
        "filtered_count",
        "has_history_checkpoint",
        "has_inbox_label",
        "has_next_message_offset",
        "has_next_page",
        "has_page_cursor",
        "include_recent_inbox",
        "initial_inbox_scan_completed",
        "is_information_request",
        "listed_count",
        "matched_count",
        "message_count",
        "message_offset",
        "message_ref",
        "missing_count",
        "monitor_generation",
        "monitoring_enabled",
        "pending_count",
        "provider_status_code",
        "reason",
        "requested_count",
        "requested_domain_count",
        "requested_field_count",
        "requested_max_results",
        "returned_count",
        "retry_pending",
        "retryable",
        "scanned_count",
        "total_count",
        "unchanged_count",
        "view",
        "workflow_count",
        "workflow_created",
    }
)


def is_enabled() -> bool:
    """Return whether safe local KYC diagnostics were explicitly enabled."""

    requested = os.getenv("KYC_DEBUG_LOGGING", "").strip().lower() in _TRUE_VALUES
    environment = os.getenv("ENVIRONMENT", "development").strip().lower()
    return requested and environment not in _HOSTED_ENVIRONMENTS


def new_run_id() -> str:
    return uuid.uuid4().hex[:16]


def bind_run(run_id: str) -> contextvars.Token[str | None]:
    return _RUN_ID.set(run_id)


def unbind_run(token: contextvars.Token[str | None]) -> None:
    _RUN_ID.reset(token)


def message_ref(gmail_message_id: str) -> str:
    """Create a non-reversible local correlation reference for one message."""

    return hashlib.sha256(gmail_message_id.encode("utf-8")).hexdigest()[:16]


def trace(stage: str, **fields: Any) -> None:
    """Append one sanitized JSON event without ever affecting the KYC flow."""

    if not is_enabled():
        return
    try:
        event = {
            "timestamp": datetime.now(UTC).isoformat(),
            "run_id": _RUN_ID.get(),
            "stage": _safe_text(stage),
            **{
                key: _safe_value(value)
                for key, value in fields.items()
                if key in _ALLOWED_FIELD_NAMES
            },
        }
        path = _debug_log_path()
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        encoded = (json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        with _WRITE_LOCK:
            descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
            try:
                os.fchmod(descriptor, 0o600)
                os.write(descriptor, encoded)
            finally:
                os.close(descriptor)
    except Exception:
        # Diagnostics are optional and must never affect mailbox processing.
        return


def _debug_log_path() -> Path:
    return Path(__file__).resolve().parents[3] / "logs" / "kyc-debug.log"


def _safe_text(value: Any) -> str:
    return "".join(
        character for character in str(value)[:120] if character.isalnum() or character in "._:-"
    )


def _safe_value(value: Any) -> bool | int | float | str | list[Any] | None:
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, (tuple, list, set, frozenset)):
        return [_safe_value(item) for item in list(value)[:12]]
    return _safe_text(value)
