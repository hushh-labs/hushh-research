"""A begun own-cloud setup, recorded before the person leaves for the cloud's sign-in.

Until 2026-10-06 nothing was written when a person pressed "Connect Google Cloud" or
"Connect Azure": the setup job only started after the sign-in came back, so for the
whole consent screen (and forever, if they closed it) the hub read them as having
no placement. With Shared a default, that meant the hub runtime. Now the begin route
records a ``consent_pending`` row in ``byoc_setup_jobs``, so placement reads
``pending`` and the person keeps the chooser, never the hub runtime.

What the row holds: a job id, the stage, and in its single stage entry the cloud
and the project the person named. ``project_id`` stays empty on purpose: nothing has
proven the person can reach that project, and the indexed column is what the
project fence and the orphan index trust, so an unproven name must not appear
there. The completion route's ``start`` replaces this row with the real job.

Never raises: a begin whose intent could not be written still sends the person to
the sign-in, and the completion route records the job as before.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from hushh_mcp.services.personal_agent_hosting import CONSENT_PENDING_STAGE

logger = logging.getLogger(__name__)

Provider = Literal["gcp", "azure"]

#: Status of an intent row: neither running (no worker owns it) nor a verdict.
INTENT_STATUS = "pending"

_RECORD = """
INSERT INTO byoc_setup_jobs
  (user_id, job_id, project_id, status, stage, stages, error_code, error_message,
   created_at, updated_at)
VALUES (:owner, :job, '', 'pending', 'consent_pending', CAST(:stages AS jsonb),
        NULL, NULL, now(), now())
ON CONFLICT (user_id) DO UPDATE SET
  job_id = EXCLUDED.job_id, stages = EXCLUDED.stages, created_at = now(), updated_at = now()
WHERE byoc_setup_jobs.stage = 'consent_pending' AND byoc_setup_jobs.status = 'pending'
RETURNING job_id
"""

# Only an untouched intent is cleared: a row that ever held a job, a project or an
# authorization attempt is setup history and stays.
_CLEAR = """
DELETE FROM byoc_setup_jobs
WHERE user_id = :owner AND stage = 'consent_pending' AND status = 'pending'
  AND project_id = '' AND authorization_attempts = '{}'::jsonb
RETURNING user_id
"""


def _db(client: Any) -> Any:
    if client is not None:
        return client
    from db.db_client import get_db

    return get_db()


async def record_intent(
    user_id: str, *, provider: Provider, project: str = "", client: Any = None
) -> bool:
    """Record that this person began an own-cloud setup. True when written.

    An existing row that is not an intent (a running, failed or recorded job) is
    left untouched: that person is already pending or holds setup history.
    """
    entry = {
        "stage": CONSENT_PENDING_STAGE,
        "provider": provider,
        "project": str(project or "").strip(),
        "at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        response = await asyncio.to_thread(
            _db(client).execute_raw,
            _RECORD,
            {"owner": user_id, "job": uuid.uuid4().hex, "stages": json.dumps([entry])},
        )
    except Exception as exc:  # noqa: BLE001 - a begin must still reach the sign-in
        logger.warning("byoc_setup_intent.record_failed err=%s", type(exc).__name__)
        return False
    written = bool(response.data)
    logger.info("byoc_setup_intent.recorded provider=%s written=%s", provider, written)
    return written


async def clear_intent(user_id: str, *, client: Any = None) -> bool:
    """Forget an untouched intent (the person chose another tier). True when removed."""
    response = await asyncio.to_thread(_db(client).execute_raw, _CLEAR, {"owner": user_id})
    return bool(response.data)


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


def intent_entry(job: Optional[dict]) -> Optional[dict]:
    """The consent_pending stage entry of an intent row, or None for any other row."""
    if not job or str(job.get("stage") or "") != CONSENT_PENDING_STAGE:
        return None
    if str(job.get("status") or "") != INTENT_STATUS:
        return None
    for entry in job.get("stages") or []:
        if isinstance(entry, dict) and entry.get("stage") == CONSENT_PENDING_STAGE:
            return entry
    return {"stage": CONSENT_PENDING_STAGE}


__all__ = [
    "INTENT_STATUS",
    "clear_intent",
    "intent_entry",
    "is_untouched_intent",
    "record_intent",
]
