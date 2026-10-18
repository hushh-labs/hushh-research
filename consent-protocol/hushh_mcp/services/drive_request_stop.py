"""The owner's request-wide Stop for an autoshare request.

An autoshare request (the sealed ``oct17_autoshare`` flow) asks the requester
to pay the moment the owner allows it, before the search has found anything.
Until the first file was shared the owner had no way to end such a request:
Decline refuses a paid request (``request_paid``) and the removal review found
nothing to remove. The existing Stop now covers that window too.

The confirmed Stop (``access_stop_requested_at``) stays the only authority.
For an autoshare request the Stop's own transaction also ends everything that
could still share a file: every queued grant is released (one a worker holds
too), frozen and running batches stop, and the search stops for good. Each
side gets one ``document_share_outcome`` event. Money settles through the
existing lanes: the refund worker returns what was not delivered (all of it
when nothing was) and the owner payout settles once on the Stop.

Lock order matches the bulk worker, settlement and withdrawal writers:
participant graph gates, management context, bulk shares (ORDER BY share_id),
request, then effects, the search job and the events. The caller takes the
locks up to the request; ``end_stopped_autoshare`` takes the rest.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_owner_allowed import autoshare_request
from hushh_mcp.services.drive_request_withdrawal_store import DISPATCHED_SQL

logger = logging.getLogger(__name__)

_PAID_OPEN_SQL = """SELECT EXISTS (
  SELECT 1 FROM drive_share_requests r
  JOIN drive_request_payment_orders o ON o.request_id=r.request_id
  WHERE r.request_id=:request AND r.user_id=:owner
    AND r.status='pending' AND r.payment_required=TRUE
    AND r.access_stop_requested_at IS NULL
    AND r.expires_at>clock_timestamp()
    AND o.status='paid' AND o.paid_at IS NOT NULL
    AND o.reconciliation_required=FALSE
)"""

# The withdrawal store and the bulk worker lock a request's shares the same way.
_LOCK_BATCHES_SQL = """SELECT share_id,status FROM drive_bulk_shares
  WHERE origin_request_id=:request ORDER BY share_id FOR UPDATE"""

# Every queued grant ends here, a leased one too, and loses its lease. Its
# batch stops below and due() offers a queued grant only while its batch runs,
# so nothing would claim or release a leased one again: a worker cancelled at
# its deadline never returns, and that grant would hold the settlement for
# good. A worker that does return takes the share lock after this Stop and
# fails mark_dispatching's lease check, so it never reaches Google; its late
# settle or release finds no lease and changes nothing. A grant past "queued"
# may already be at Google and keeps its own state.
_RELEASE_QUEUED_SQL = """UPDATE drive_bulk_share_effects SET state='skipped',
  safe_error_code='stopped',lease_id=NULL,lease_expires_at=NULL,
  updated_at=clock_timestamp()
  WHERE share_id=:share AND state='queued'"""

# An in-flight grant may still settle; its effect keeps its own state.
_STOP_BATCH_SQL = """UPDATE drive_bulk_shares SET status='stopped',
  stopped_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
  WHERE share_id=:share AND status IN ('review_ready','queued','running')"""

# A running slice loses its lease here: its next page check and commit fail.
_STOP_SEARCH_SQL = """UPDATE drive_owner_search_jobs SET status='stopped',
  lease_id=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp()
  WHERE user_id=:owner AND client_request_id=:request AND status IN ('queued','running')"""

# Outcome revisions deduplicate notifications, as in the progressive finalizer.
_OUTCOME_REVISION_SQL = """SELECT GREATEST(:revision,COALESCE(MAX(revision)+1,:revision))
  FROM drive_share_events
  WHERE request_id=:request AND event_type='document_share_outcome'"""

_OUTCOME_EVENT_SQL = """INSERT INTO drive_share_events(event_id,request_id,user_id,revision,event_type)
  VALUES(:id,:request,:user,:revision,'document_share_outcome')
  ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING"""


def paid_open_autoshare(connection: Any, request: dict | None, private: dict | None) -> bool:
    """A paid autoshare request that is still open: the owner may Stop it now."""
    if request is None or private is None or not autoshare_request(private):
        return False
    return bool(
        connection.execute(
            text(_PAID_OPEN_SQL),
            {"request": str(request["request_id"]), "owner": request["user_id"]},
        ).scalar_one()
    )


def shared_anything(connection: Any, request_id: Any) -> bool:
    """A share reached Google, or may have; an unconfirmed outcome counts."""
    return bool(connection.execute(text(DISPATCHED_SQL), {"request": str(request_id)}).scalar_one())


def owner_stop_view(connection: Any, request: dict, private: dict) -> dict[str, str]:
    """Owner only, autoshare only: whether Stop refunds in full, or what it did.

    ``available``: paid and nothing shared yet, so Stop refunds in full.
    ``before_sharing`` and ``after_sharing``: what a confirmed Stop did.
    Presentation only; the revocation store rechecks every Stop.
    """
    if not autoshare_request(private):
        return {}
    if request.get("access_stop_requested_at") is not None:
        shared = shared_anything(connection, request["request_id"])
        return {"requestStop": "after_sharing" if shared else "before_sharing"}
    if paid_open_autoshare(connection, request, private) and not shared_anything(
        connection, request["request_id"]
    ):
        return {"requestStop": "available"}
    return {}


def lock_request_batches(connection: Any, *, request_id: str) -> list[dict]:
    """Lock the request's batches before its row, as every batch writer does."""
    return [
        dict(row)
        for row in connection.execute(text(_LOCK_BATCHES_SQL), {"request": request_id}).mappings()
    ]


def end_stopped_autoshare(connection: Any, *, request: dict, batches: list[dict]) -> None:
    """In the Stop's transaction: nothing more is shared, searched or sent.

    ``request`` is the row the Stop just updated and ``batches`` the rows
    ``lock_request_batches`` locked. Called once: when a new Stop reaches a
    request that is still open (pending and unexpired).
    """
    released = stopped = 0
    for batch in batches:
        released += connection.execute(
            text(_RELEASE_QUEUED_SQL), {"share": batch["share_id"]}
        ).rowcount
        stopped += connection.execute(text(_STOP_BATCH_SQL), {"share": batch["share_id"]}).rowcount
    identity = {"owner": request["user_id"], "request": str(request["request_id"])}
    searches = connection.execute(text(_STOP_SEARCH_SQL), identity).rowcount
    revision = connection.execute(
        text(_OUTCOME_REVISION_SQL),
        {"request": identity["request"], "revision": request["revision"]},
    ).scalar_one()
    for audience in (request["user_id"], request["recipient_user_id"]):
        connection.execute(
            text(_OUTCOME_EVENT_SQL),
            {
                "id": str(uuid4()),
                "request": identity["request"],
                "user": audience,
                "revision": revision,
            },
        )
    logger.info(
        "drive_request.stop_ended released=%d batches=%d searches=%d",
        released,
        stopped,
        searches,
    )
