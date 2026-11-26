"""Present a one-file schedule review in Chat. Grant no execution authority."""

from datetime import datetime, timezone
from typing import Literal


def propose_file_schedule(
    run_at: str = "",
    repeat: Literal["once", "daily", "weekdays", "weekly", "monthly"] = "once",
) -> dict[str, str | None]:
    """Offer a review for organizing one private Files library upload later.

    Use only for an explicit request to organize a private Files upload later.
    Resolve relative times with get_current_time. Supply the first run in ISO
    8601 with an explicit offset or leave it empty when unknown. Supply the
    requested recurrence. Use weekdays for Monday through Friday, or weekly
    for another weekly pattern and let the owner choose days in review.
    The owner picks the file and confirms the timing and end in Chat. Say the draft is
    ready for review. This tool reads and schedules nothing. Never substitute
    immediate organization or Google Drive. If unavailable, explain that the
    current runtime cannot prepare the schedule.
    """
    instant = None
    if isinstance(run_at, str) and len(run_at) <= 40:
        try:
            parsed = datetime.fromisoformat(run_at)
            if parsed.utcoffset() is not None:
                instant = parsed.astimezone(timezone.utc).isoformat(timespec="seconds")
        except (ValueError, OverflowError):
            pass
    result = {"status": "proposal_ready", "type": "files.schedule_organization", "run_at": instant}
    if repeat in {"daily", "weekdays", "weekly", "monthly"}:
        result["repeat"] = repeat
    return result
