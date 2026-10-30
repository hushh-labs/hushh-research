"""One owner-scoped doorbell for payout state changes.

PostgreSQL delivers NOTIFY only after the enclosing transaction commits, so a
doorbell can never announce state that later rolls back. The payload names an
owner, the closed set of payout kinds that changed and, optionally, one opaque
request. It never carries amounts, bank details or provider IDs: readers
refetch the authenticated snapshot for the named kinds.

Identical payloads inside one transaction collapse into one notification, so
the payload is deterministic (sorted kinds, no random event ID). Missing or
unknown kinds mean "all kinds", which keeps older listeners correct.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import text

# wallet: coin balances, reservations, holds and redemptions.
# earnings: per-request owner earnings (credited, held, reversed).
# bank_payouts: Stripe bank deposits from the connected account.
# account: connected-account readiness and verification.
# balance: the connected account's Stripe balance ("In Stripe").
PAYOUT_KINDS = ("wallet", "earnings", "bank_payouts", "account", "balance")
PAYOUT_DOORBELL_TYPE = "bank_payout_changed"
_MAX_PAYLOAD_BYTES = 7_500


class PayoutDoorbellError(ValueError):
    """A doorbell that would be ambiguous or oversized is refused."""


def payout_doorbell_payload(
    user_id: str, kinds: Iterable[str], request_id: str | UUID | None = None
) -> str:
    if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
        raise PayoutDoorbellError("invalid_owner")
    closed = sorted({kind for kind in kinds if kind in PAYOUT_KINDS})
    if not closed:
        raise PayoutDoorbellError("invalid_kinds")
    body: dict[str, Any] = {"type": PAYOUT_DOORBELL_TYPE, "user_id": user_id, "kinds": closed}
    if request_id is not None:
        body["request_id"] = str(UUID(str(request_id)))
    payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    if len(payload.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
        raise PayoutDoorbellError("invalid_owner")
    return payload


def notify_payout_changed(
    connection: Any,
    user_id: str,
    kinds: Iterable[str],
    request_id: str | UUID | None = None,
) -> None:
    """Queue the owner's doorbell on the caller's open transaction."""
    connection.execute(
        text("SELECT pg_notify('one_user_state_changed', :payload)"),
        {"payload": payout_doorbell_payload(user_id, kinds, request_id)},
    )
