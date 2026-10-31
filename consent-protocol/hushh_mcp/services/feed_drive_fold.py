# hushh_mcp/services/feed_drive_fold.py
"""
Server mirror of the Feed's Drive request fold.

The web Feed keeps Drive request rows append-only but hides a row that a later
row of the same request contradicts (``hushh-webapp/lib/feed/
feed-drive-grouping.ts``):

* a settled payment, a successful outcome or an empty outcome hides Pay;
* a successful outcome hides a stale "no files" outcome;
* an empty outcome hides the availability decision, unless a success exists.

Removal is stored per row. When a person removes the row that does the hiding,
the rows it hid must leave with it, or one of them takes its place on every
device and after every sign-in. ``drive_rows_revealed_by_removal`` names those
rows. Keep this file in step with the TypeScript fold:
``tests/fixtures/feed_drive_fold_cases.json`` is read by both test suites.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

DRIVE_EVENT_DOMAIN = "connected_systems"
DRIVE_DECISION_EVENT = "document_share_decided"
DRIVE_OUTCOME_EVENT = "document_share_outcome"
DRIVE_PAYMENT_READY_EVENT = "document_share_payment_ready"
DRIVE_PAYMENT_SETTLED_EVENTS = frozenset(
    {"document_share_payment_confirmed", "document_share_payment_refunded"}
)
DRIVE_LIFECYCLE_EVENTS = frozenset(
    {
        DRIVE_DECISION_EVENT,
        DRIVE_OUTCOME_EVENT,
        DRIVE_PAYMENT_READY_EVENT,
        *DRIVE_PAYMENT_SETTLED_EVENTS,
    }
)
_SUCCESSFUL_STATUSES = frozenset({"partial", "completed"})
_EMPTY_STATUSES = frozenset({"no_match", "no_files_shared"})

FeedItem = Mapping[str, Any]


def _metadata(item: FeedItem) -> Mapping[str, Any]:
    value = item.get("metadata")
    return value if isinstance(value, Mapping) else {}


def _request_id(item: FeedItem) -> str:
    value = _metadata(item).get("request_id")
    return value.strip() if isinstance(value, str) else ""


def _status(item: FeedItem) -> str:
    value = _metadata(item).get("user_facing_status")
    return value.strip().lower() if isinstance(value, str) else ""


def _is_lifecycle_row(item: FeedItem) -> bool:
    return (
        item.get("source_domain") == DRIVE_EVENT_DOMAIN
        and item.get("event_type") in DRIVE_LIFECYCLE_EVENTS
        and bool(_request_id(item))
    )


def hidden_drive_item_ids(items: Iterable[FeedItem]) -> set[str]:
    """Ids of the rows the Feed's Drive fold hides (``collapseDriveLifecycleRows``)."""
    rows = [item for item in items if _is_lifecycle_row(item)]
    successful: set[str] = set()
    empty: set[str] = set()
    settled: set[str] = set()
    for item in rows:
        request_id = _request_id(item)
        if item.get("event_type") in DRIVE_PAYMENT_SETTLED_EVENTS:
            settled.add(request_id)
        if item.get("event_type") != DRIVE_OUTCOME_EVENT:
            continue
        if _status(item) in _SUCCESSFUL_STATUSES:
            successful.add(request_id)
        if _status(item) in _EMPTY_STATUSES:
            empty.add(request_id)

    hidden: set[str] = set()
    for item in rows:
        request_id = _request_id(item)
        event_type = item.get("event_type")
        has_success = request_id in successful
        has_empty = request_id in empty
        if event_type == DRIVE_PAYMENT_READY_EVENT:
            payment = _metadata(item).get("current_payment_status")
            # An expired, unpaid instruction stays as history; any other Pay
            # row stops being an instruction once payment or delivery settles.
            payable = (_status(item) != "expired" and payment != "expired") or payment in {
                "paid",
                "refunded",
            }
            if payable and (request_id in settled or has_success or has_empty):
                hidden.add(str(item.get("id")))
        elif event_type == DRIVE_OUTCOME_EVENT:
            if _status(item) in _EMPTY_STATUSES and has_success:
                hidden.add(str(item.get("id")))
        elif event_type == DRIVE_DECISION_EVENT and has_empty and not has_success:
            hidden.add(str(item.get("id")))
    return hidden


def drive_rows_revealed_by_removal(
    items: Iterable[FeedItem], removed_ids: Iterable[str]
) -> set[str]:
    """Rows the fold hides now that would show once ``removed_ids`` are gone.

    Repeats until nothing more surfaces: a stale outcome that surfaces can
    itself have been the last row hiding Pay. Every returned row was already
    hidden, so removing it never takes a visible row away.
    """
    rows = list(items)
    hidden_before = hidden_drive_item_ids(rows)
    gone = {str(row_id) for row_id in removed_ids}
    revealed: set[str] = set()
    while True:
        remaining = [item for item in rows if str(item.get("id")) not in gone]
        hidden_now = hidden_drive_item_ids(remaining)
        surfaced = {
            str(item.get("id"))
            for item in remaining
            if str(item.get("id")) in hidden_before and str(item.get("id")) not in hidden_now
        }
        if not surfaced:
            return revealed
        revealed |= surfaced
        gone |= surfaced
