"""Retained setup-intent absence predicate for production account cleanup."""

from typing import Optional

CONSENT_PENDING_STAGE = "consent_pending"
INTENT_STATUS = "pending"


def is_untouched_intent(job: Optional[dict]) -> bool:
    """True for an intent row nothing has acted on: no project, no authorization attempt.

    The same rows ``clear_intent`` may remove. Account deletion reads such a row as
    absent: it holds only a cloud word and a typed project name, never a resource.
    ``authorization_attempts`` is read from the row's JSON, so a database without that
    column (before migration 928) reads as no attempt rather than failing.
    """
    if not job:
        return False
    return (
        str(job.get("stage") or "") == CONSENT_PENDING_STAGE
        and str(job.get("status") or "") == INTENT_STATUS
        and not str(job.get("project_id") or "")
        and job.get("authorization_attempts") in (None, {})
    )
