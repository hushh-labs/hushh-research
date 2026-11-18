"""Present a one-file schedule review in Chat. Grant no execution authority."""

from datetime import datetime, timezone


def propose_file_schedule(run_at: str = "") -> dict[str, str | None]:
    """Offer a review for organizing one private Files library upload later.

    Supply run_at as a resolved ISO 8601 date and time with an explicit offset.
    Leave it empty when the exact time is unknown. The owner selects the file
    and confirms its schedule in the app. This tool reads and schedules nothing.
    """
    instant = None
    if isinstance(run_at, str) and len(run_at) <= 40:
        try:
            parsed = datetime.fromisoformat(run_at)
            if parsed.utcoffset() is not None:
                instant = parsed.astimezone(timezone.utc).isoformat(timespec="seconds")
        except (ValueError, OverflowError):
            pass
    return {"status": "proposal_ready", "type": "files.schedule_organization", "run_at": instant}
