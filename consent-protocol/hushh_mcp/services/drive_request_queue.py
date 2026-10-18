"""Truthful wait state of an automatic document request, before and after its search starts.

A request is queued once Trusted access or the owner's Allow lets the
automatic pipeline take it (``trusted_auto_queued``) and no Drive search has
started. ``preparation_next_at`` is the moment that durable row became due for
the scheduled drain. Started work (a search slice, a content check or a Drive
grant) waits the same way once no worker holds it. This module only describes
rows a read already loaded; it never dispatches work, and waiting work is
never described as running.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

# Past this wait the request is "taking longer than usual": the drain normally
# picks a due row within a minute. The request stays saved and continues.
QUEUE_DELAY_AFTER = timedelta(minutes=3)
QUEUED_PREPARATION_CODE = "trusted_auto_queued"
# The preparation codes with which the automatic queue (due_trusted_searches)
# still starts a request's first search: queued, or waiting on owner setup or
# background Drive access. Any other code, for example the terminal
# preparation_unavailable after three failed starts, never starts one.
AUTOMATIC_START_CODES = frozenset(
    {
        QUEUED_PREPARATION_CODE,
        "background_preparation_required",
        "owner_price_required",
        "owner_payout_required",
        "payout_unavailable",
    }
)
# A start in flight: request_bulk_context marked the request active and the
# search job is not committed yet. A failed start returns it to the queue (or,
# after three failures, parks it for good).
_STARTING_CODE = "trusted_auto_active"


def automatic_start_parked(preparation_error_code: str | None) -> bool:
    """A request with no search job yet will never get one automatically.

    Read only for a request whose search job does not exist. The owner's own
    takeover (manual_search_active) is parked here too: no automatic search
    starts for it, and only the owner's exact approval can authorize it.
    """
    return (
        preparation_error_code not in AUTOMATIC_START_CODES
        and preparation_error_code != _STARTING_CODE
    )


# Started work, as SQL scalars over the current drive_share_requests row. Each
# is the moment that work became due with no worker holding it: the latest of
# its next attempt, its last progress and any lease that ran out. A held lease
# reads as clock_timestamp(), so held work is never delayed. NULL: no work.
# A queued or running search slice.
SEARCH_WAITING_SINCE_SQL = """(
  SELECT CASE WHEN j.lease_expires_at>clock_timestamp() THEN clock_timestamp()
    ELSE GREATEST(j.next_at,j.updated_at,j.lease_expires_at) END
  FROM drive_owner_search_jobs j
  WHERE j.user_id=drive_share_requests.user_id
    AND j.client_request_id=drive_share_requests.request_id
    AND j.status IN ('queued','running') AND j.expires_at>clock_timestamp()
)"""
# A finished search whose content check still runs (V1 and package requests).
EVALUATION_WAITING_SINCE_SQL = """(
  SELECT CASE WHEN j.lease_expires_at>clock_timestamp() THEN clock_timestamp()
    ELSE GREATEST(j.evaluation_next_at,j.updated_at,j.lease_expires_at) END
  FROM drive_owner_search_jobs j
  WHERE j.user_id=drive_share_requests.user_id
    AND j.client_request_id=drive_share_requests.request_id
    AND j.status='completed' AND j.evaluation_status IN ('pending','running')
    AND j.expires_at>clock_timestamp()
)"""
# Drive grants still in flight for this request's automatic batches. A batch
# records progress each time one of its grants settles.
SHARING_WAITING_SINCE_SQL = """(
  SELECT CASE WHEN bool_or(effect.lease_expires_at>clock_timestamp()) THEN clock_timestamp()
    ELSE GREATEST(min(effect.next_at),max(b.updated_at)) END
  FROM drive_bulk_shares b
  JOIN drive_bulk_share_effects effect ON effect.share_id=b.share_id
  WHERE b.user_id=drive_share_requests.user_id
    AND b.origin_request_id=drive_share_requests.request_id
    AND b.progressive_batch=TRUE AND b.expires_at>clock_timestamp()
    AND effect.state IN ('queued','dispatching','unknown')
  HAVING count(*)>0
)"""
# Both started-work clocks of one request, for status and review reads. Only
# the static fragments above fill it; the request is a bound parameter.
_STARTED_WORK = """SELECT {search} AS search_waiting_since,{sharing} AS sharing_waiting_since
  FROM drive_share_requests WHERE drive_share_requests.request_id=:request"""
STARTED_WORK_SQL = _STARTED_WORK.replace("{search}", SEARCH_WAITING_SINCE_SQL).replace(
    "{sharing}", SHARING_WAITING_SINCE_SQL
)


def request_queued_since(row: Mapping[str, Any], now: datetime) -> datetime | None:
    """When an open automatic request entered the queue, or None if it is not queued."""
    due_at = row.get("preparation_next_at")
    if (
        row.get("status") != "pending"
        or row.get("preparation_error_code") != QUEUED_PREPARATION_CODE
        or row.get("bulk_search_started_at") is not None
        or row.get("access_stop_requested_at") is not None
        or not isinstance(due_at, datetime)
        or not isinstance(row.get("expires_at"), datetime)
        or row["expires_at"] <= now
    ):
        return None
    # A row scheduled for a later attempt is queued from now, not in the future.
    return min(due_at, now)


def queue_delayed(queued_since: datetime, now: datetime) -> bool:
    return now - queued_since >= QUEUE_DELAY_AFTER


def queue_view(queued_since: datetime | None, now: datetime) -> dict[str, Any]:
    """Additive status fields; empty when the request is not queued."""
    if queued_since is None:
        return {}
    return {
        "queuedAt": queued_since.isoformat(),
        "queueDelayed": queue_delayed(queued_since, now),
    }


def started_work_waiting_since(*clocks: object, now: datetime) -> datetime | None:
    """When the started work stopped moving, or None while any part still moves.

    Every present clock must have waited: one part a worker holds or recently
    advanced keeps the whole request moving. A future due time waits from now.
    """
    present = [clock for clock in clocks if isinstance(clock, datetime)]
    if not present:
        return None
    return min(max(present), now)


def started_work_view(waiting_since: datetime | None, now: datetime) -> dict[str, Any]:
    """Additive status field, present only while started work is delayed."""
    if waiting_since is None or not queue_delayed(waiting_since, now):
        return {}
    return {"workDelayedSince": waiting_since.isoformat()}
