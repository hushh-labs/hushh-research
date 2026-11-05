"""Failure taxonomy and honest coverage status for follow-up scans.

A gene: pure and value-free. It decides what a failure means (retry, skip a
message nobody can read, or ask the owner) and how much of the mailbox has been
verified. It never sees message content, only machine-readable codes.

Coverage is a claim about what was verified, so an unknown state is never
reported as "nothing pending".
"""

from __future__ import annotations

import random
from typing import Any, Literal

MAX_SOURCE_ATTEMPTS = 6
SOURCE_BACKOFF_BASE_SECONDS = 60
SOURCE_BACKOFF_CAP_SECONDS = 3600
MAX_MESSAGE_FAILURES = 3
ATTENTION_AFTER_FAILURES = 8
COMPLETE_RESCAN_SECONDS = 300

# Nobody can read these messages, now or on retry: an image-only mail, a
# 600 KB text body, or an unsupported MIME shape. Retrying only burns calls, and
# calling them "incomplete" would be a permanent, unfixable warning. They are
# recorded as unreadable and counted, never silently dropped.
PERMANENT_UNREADABLE = frozenset(
    {
        "no_readable_body",
        "body_too_large",
        "unsupported_readable_part",
        "invalid_body_tree",
        "external_parts_limit",
        "invalid_body",
        "provider_response_too_large",
        # A section that yields 20+ obligations is not a trustworthy extraction,
        # and asking again returns the same answer. It is counted, not retried.
        "assessment_overflow",
    }
)
# A 404 for one message: it was deleted, so there is nothing left to check.
SOURCE_GONE = frozenset({"source_unavailable"})
# Plausibly transient for this one source: retry with bounded backoff.
RECOVERABLE_SOURCE = frozenset(
    {
        "incomplete_body",
        "incomplete_thread",
        "incomplete_thread_context",
        "calendar_unavailable",
        # The model failed or returned an answer that did not validate.
        "assessment_failed",
    }
)
# Provider-wide conditions: stop the whole pass and wait.
PROVIDER_TRANSIENT = frozenset({"mail_temporarily_unavailable", "mail_rate_limited"})
# Only the owner can fix these.
GRANT_PROBLEM = frozenset(
    {
        "mail_permission_required",
        "mail_grant_changed",
        "selected_mail_permission_required",
        "calendar_account_unavailable",
    }
)

Disposition = Literal["unreadable", "gone", "retry", "raise"]


def source_disposition(code: str) -> Disposition:
    if code in PERMANENT_UNREADABLE:
        return "unreadable"
    if code in SOURCE_GONE:
        return "gone"
    if code in RECOVERABLE_SOURCE:
        return "retry"
    return "raise"


def source_backoff_seconds(attempts: int, *, retry_after: int | None = None) -> int:
    """Bounded exponential delay for one source, honouring a provider hint."""
    exponent = max(0, min(attempts - 1, 10))
    delay = min(SOURCE_BACKOFF_BASE_SECONDS * 2**exponent, SOURCE_BACKOFF_CAP_SECONDS)
    if retry_after:
        delay = max(delay, min(retry_after, SOURCE_BACKOFF_CAP_SECONDS))
    return int(delay * (1 + random.random() * 0.2))  # noqa: S311 - jitter, not security


def source_exhausted(entry: dict[str, Any]) -> bool:
    return int(entry.get("attempts", 0)) >= MAX_SOURCE_ATTEMPTS


def coverage(
    *,
    scan_state: str,
    error_code: str | None,
    consecutive_failures: int,
    checkpoint: dict[str, Any] | None,
) -> dict[str, Any]:
    """What the owner may be told about verification, and whether they must act.

    ``complete``        every message in the approved period was checked.
    ``catching_up``     work remains or a recoverable retry is scheduled; no warning.
    ``needs_attention`` only the owner can fix it: a lost grant, a source that
                        exhausted its retries, or a provider outage.
    """
    sources = (checkpoint or {}).get("incomplete_sources", {})
    exhausted = sum(1 for entry in sources.values() if source_exhausted(entry))
    unreadable = int((checkpoint or {}).get("unreadable", 0))
    attention: str | None = None
    if error_code in GRANT_PROBLEM:
        attention = "reconnect_mail"
    elif exhausted:
        attention = "retry_needed"
    elif consecutive_failures >= ATTENTION_AFTER_FAILURES:
        attention = "provider_unavailable"
    if attention:
        state = "needs_attention"
    elif scan_state == "complete" and not sources:
        state = "complete"
    else:
        state = "catching_up"
    return {
        "coverage": state,
        "attention": attention,
        "waiting_source_count": len(sources) - exhausted,
        "exhausted_source_count": exhausted,
        "unreadable_count": unreadable,
    }
