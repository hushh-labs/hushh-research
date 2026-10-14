"""Owner payout activity and receipts: one read-only, owner-scoped read model.

Activity merges four sources into one keyset-paginated list, newest first:
- Hussh Coins ledger rows (credited earnings and adjustments);
- cash-outs (hashcoin_redemptions, each folded with its ledger debit);
- paid earnings that are not credited yet (drive_request_owner_payouts);
- bank deposits of the owner's connected account (stripe_connect_bank_payouts).

Every item keeps a stable ID ("earning:<request>", "redemption:<id>",
"reversal:<request>", "redemption_reversal:<redemption>", "deposit:po_...")
and only changes state, so clients merge pages by ID. An item's sort time only
moves forward (a pending earning or cash-out moves to its ledger time once
credited or sent), so a page never repeats a row; since= reports moved rows.

balanceAfterCoins is the ledger balance after that entry. Every post locks the
wallet row and stamps clock_timestamp(), so within a wallet (created_at,
entry_id) is commit order and the running SUM ends exactly at the wallet
balance. Reservations and holds are not ledger rows: it is not the available
balance.

Reads are DB-only and run in one REPEATABLE READ, READ ONLY transaction. No
acct_, ch_, pi_, tr_ or trr_ ID leaves this module; deposits keep their
existing po_ ID. Row review comes only from payout_review.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, TypeVar
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import payout_review
from hushh_mcp.services import stripe_connect_balances as connect_balances
from hushh_mcp.services.external_connector_lifecycle_store import (
    ConnectorLifecycleError,
    ExternalConnectorLifecycleStore,
)
from hushh_mcp.services.payout_request_labels import (
    MAX_LABELS_PER_READ,
    owner_request_labels,
)

logger = logging.getLogger(__name__)
T = TypeVar("T")

SCHEMA_VERSION = 1
COINS_PER_DOLLAR = 100
ACTIVITY_KINDS = ("all", "earning", "redemption", "deposit", "adjustment", "coins")
ACTIVITY_MODES = ("live", "test")
DEFAULT_LIMIT = 20
MAX_LIMIT = 50
MAX_SINCE_ITEMS = 100
MAX_CURSOR_CHARS = 256
# A writer stamps updated_at before it commits. Re-reading a short window
# before since= catches rows committed just after the previous snapshot;
# clients merge by ID, so a repeated row is harmless.
SINCE_OVERLAP = timedelta(seconds=30)
ITEM_ID = re.compile(
    r"^(earning|redemption|reversal|redemption_reversal|deposit):([A-Za-z0-9_-]{4,64})$"
)

_KIND_SOURCES = {
    "all": frozenset({"earning", "redemption", "adjustment", "deposit"}),
    "earning": frozenset({"earning"}),
    "redemption": frozenset({"redemption"}),
    "deposit": frozenset({"deposit"}),
    "adjustment": frozenset({"adjustment"}),
    "coins": frozenset({"earning", "redemption", "adjustment"}),
}
_ITEM_TYPES = {
    "earning": "earning",
    "redemption": "cash_out",
    "reversal": "earning_reversed",
    "redemption_reversal": "cash_out_returned",
    "deposit": "bank_deposit",
}
_DEFAULT_STATUS = {
    "earning": "pending",
    "redemption": "unknown",
    "reversal": "applied",
    "redemption_reversal": "applied",
    "deposit": "pending",
}
_REDEMPTION_STATUS = {
    "reserved": "pending",
    "dispatching": "pending",
    "succeeded": "succeeded",
    "failed": "failed",
    "unknown": "unknown",
}
_TRANSFER_STATUS = {
    "reserved": "requested",
    "dispatching": "requested",
    "succeeded": "sent",
    "failed": "failed",
    "unknown": "unknown",
}
_REVERSAL_STATUSES = frozenset({"none", "due", "unknown", "reversed", "manual_review"})
_DEPOSIT_STATUSES = frozenset({"pending", "in_transit", "paid", "canceled", "failed"})
_FUNDS_STATUSES = frozenset({"pending", "available", "paid_out"})
_CONTENTS_STATUSES = frozenset({"pending", "complete", "not_applicable"})
_CONTENT_TYPES = frozenset({"cash_out", "document_transfer", "returned_deposit", "refund", "other"})
# Stripe payout failures that name the destination bank account; the owner
# fixes them by updating the bank in Stripe. Other failures need no bank edit.
_BANK_FAILURES = frozenset(
    {
        "account_closed",
        "account_frozen",
        "bank_account_restricted",
        "bank_ownership_changed",
        "debit_not_authorized",
        "declined",
        "incorrect_account_holder_address",
        "incorrect_account_holder_name",
        "incorrect_account_holder_tax_id",
        "invalid_account_number",
        "invalid_currency",
        "no_account",
        "unsupported_card",
    }
)
_PAYOUT_ID = re.compile(r"^po_[A-Za-z0-9_]{1,61}$")
_TRANSFER_ID = re.compile(r"^tr_[A-Za-z0-9_]{1,252}$")
_LAST4 = re.compile(r"^[0-9]{4}$")

# One statement per page keeps every source in the same snapshot. Branches are
# switched by bound booleans that PostgreSQL folds to constants, so a filtered
# page never scans the other sources. The windowed ledger is read once (no
# self-join). A credit or debit is posted in the same transaction as its status
# change, so only uncredited earnings and unsent cash-outs reach the NOT EXISTS
# guards; plans stay linear even before table statistics exist. Item IDs
# compare bytewise (COLLATE "C"), alike in ORDER BY and the keyset. A ledger
# row's updatedAt comes from its source row in _item, so no join is needed here.
_PAGE_SQL = """
WITH ledger AS (
  SELECT e.entry_kind,e.source_ref,e.amount_coins,e.created_at,
    SUM(e.amount_coins) OVER (ORDER BY e.created_at,e.entry_id) AS balance_after
  FROM hashcoin_ledger_entries e
  WHERE e.wallet_id=CAST(:wallet AS uuid) AND (:want_earning OR :want_adjustment OR :want_redemption)
), items AS (
  SELECT CASE WHEN l.entry_kind IN ('earning','sandbox_earning') THEN 'earning'
      WHEN l.entry_kind='redemption' THEN 'redemption'
      ELSE 'adjustment' END AS kind,
    CASE WHEN l.entry_kind IN ('earning','sandbox_earning') THEN 'earning:'
      WHEN l.entry_kind='redemption' THEN 'redemption:'
      WHEN l.entry_kind IN ('reversal','sandbox_reversal') THEN 'reversal:'
      ELSE 'redemption_reversal:' END || l.source_ref::text AS item_id,
    l.created_at AS occurred_at,l.created_at AS updated_at,
    l.amount_coins AS coins_delta,l.balance_after
  FROM ledger l
  WHERE (:want_earning AND l.entry_kind IN ('earning','sandbox_earning'))
    OR (:want_redemption AND l.entry_kind='redemption')
    OR (:want_adjustment AND l.entry_kind IN
      ('reversal','sandbox_reversal','redemption_reversal'))
  UNION ALL
  SELECT 'redemption','redemption:' || r.redemption_id::text,r.created_at,r.updated_at,
    NULL,NULL
  FROM hashcoin_redemptions r
  WHERE :want_redemption AND r.wallet_id=CAST(:wallet AS uuid) AND r.status<>'succeeded'
    AND NOT EXISTS (SELECT 1 FROM hashcoin_ledger_entries x
      WHERE x.wallet_id=r.wallet_id AND x.entry_kind='redemption'
        AND x.source_ref=r.redemption_id)
  UNION ALL
  SELECT 'earning','earning:' || p.request_id::text,
    COALESCE(o.paid_at,p.created_at),p.updated_at,NULL,NULL
  FROM drive_request_owner_payouts p
  LEFT JOIN drive_request_payment_orders o ON o.request_id=p.request_id
  WHERE :want_earning AND p.wallet_id=CAST(:wallet AS uuid)
    AND p.status NOT IN ('hashcoins_credited','hashcoins_held','hashcoins_reversed')
    AND COALESCE(o.stripe_payment_intent_id,p.stripe_payment_intent_id) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM hashcoin_ledger_entries x
      WHERE x.wallet_id=p.wallet_id AND x.entry_kind='earning' AND x.source_ref=p.request_id)
  UNION ALL
  SELECT 'deposit','deposit:' || b.stripe_payout_id,b.created_at,b.updated_at,NULL,NULL
  FROM stripe_connect_bank_payouts b
  WHERE :want_deposit AND b.stripe_account_id=CAST(:account AS text)
    AND b.livemode=:livemode AND left(b.stripe_payout_id,3)='po_'
    AND char_length(b.stripe_payout_id)<=64
)
SELECT kind,item_id COLLATE "C" AS item_id,occurred_at,updated_at,coins_delta,balance_after
FROM items
WHERE CAST(:after_at AS timestamptz) IS NULL
  OR occurred_at<CAST(:after_at AS timestamptz)
  OR (occurred_at=CAST(:after_at AS timestamptz)
    AND item_id COLLATE "C"<CAST(:after_id AS text) COLLATE "C")
ORDER BY occurred_at DESC,item_id COLLATE "C" DESC
LIMIT :limit
"""
# since= costs what changed, not the owner's whole history. Candidates are
# ledger rows posted after it plus credited earnings and sent cash-outs whose
# own row changed after it, each found through a (wallet, updated_at) index
# (migration 315). Pending earnings and cash-outs use the same indexes; deposits
# stay per account. Only the rows returned get a balance: the sum before the
# oldest of them, then one ordered pass from it on. (created_at, entry_id) is
# commit order, as above.
_SINCE_SQL = """
WITH changed AS (
  SELECT e.entry_id FROM hashcoin_ledger_entries e
  WHERE (:want_earning OR :want_adjustment OR :want_redemption)
    AND e.wallet_id=CAST(:wallet AS uuid) AND e.created_at>CAST(:since AS timestamptz)
  UNION
  SELECT e.entry_id FROM drive_request_owner_payouts p
  JOIN hashcoin_ledger_entries e ON e.wallet_id=CAST(:wallet AS uuid)
    AND e.entry_kind IN ('earning','sandbox_earning') AND e.source_ref=p.request_id
  WHERE :want_earning AND p.updated_at>CAST(:since AS timestamptz)
    AND (p.wallet_id=CAST(:wallet AS uuid) OR p.sandbox_wallet_id=CAST(:wallet AS uuid))
  UNION
  SELECT e.entry_id FROM hashcoin_redemptions r
  JOIN hashcoin_ledger_entries e ON e.wallet_id=r.wallet_id
    AND e.entry_kind='redemption' AND e.source_ref=r.redemption_id
  WHERE :want_redemption AND r.wallet_id=CAST(:wallet AS uuid)
    AND r.updated_at>CAST(:since AS timestamptz)
), items AS (
  SELECT CASE WHEN l.entry_kind IN ('earning','sandbox_earning') THEN 'earning'
      WHEN l.entry_kind='redemption' THEN 'redemption'
      ELSE 'adjustment' END AS kind,
    CASE WHEN l.entry_kind IN ('earning','sandbox_earning') THEN 'earning:'
      WHEN l.entry_kind='redemption' THEN 'redemption:'
      WHEN l.entry_kind IN ('reversal','sandbox_reversal') THEN 'reversal:'
      ELSE 'redemption_reversal:' END || l.source_ref::text AS item_id,
    l.created_at AS occurred_at,
    GREATEST(l.created_at,p.updated_at,r.updated_at) AS updated_at,
    l.amount_coins AS coins_delta,l.entry_id
  FROM changed c
  JOIN hashcoin_ledger_entries l ON l.entry_id=c.entry_id
  LEFT JOIN drive_request_owner_payouts p
    ON l.entry_kind IN ('earning','sandbox_earning') AND p.request_id=l.source_ref
  LEFT JOIN hashcoin_redemptions r
    ON l.entry_kind='redemption' AND r.redemption_id=l.source_ref
  WHERE (:want_earning AND l.entry_kind IN ('earning','sandbox_earning'))
    OR (:want_redemption AND l.entry_kind='redemption')
    OR (:want_adjustment AND l.entry_kind IN
      ('reversal','sandbox_reversal','redemption_reversal'))
  UNION ALL
  SELECT 'redemption','redemption:' || r.redemption_id::text,r.created_at,r.updated_at,
    NULL,NULL
  FROM hashcoin_redemptions r
  WHERE :want_redemption AND r.wallet_id=CAST(:wallet AS uuid)
    AND r.updated_at>CAST(:since AS timestamptz) AND r.status<>'succeeded'
    AND NOT EXISTS (SELECT 1 FROM hashcoin_ledger_entries x
      WHERE x.wallet_id=r.wallet_id AND x.entry_kind='redemption'
        AND x.source_ref=r.redemption_id)
  UNION ALL
  SELECT 'earning','earning:' || p.request_id::text,
    COALESCE(o.paid_at,p.created_at),p.updated_at,NULL,NULL
  FROM drive_request_owner_payouts p
  LEFT JOIN drive_request_payment_orders o ON o.request_id=p.request_id
  WHERE :want_earning AND p.wallet_id=CAST(:wallet AS uuid)
    AND p.updated_at>CAST(:since AS timestamptz)
    AND p.status NOT IN ('hashcoins_credited','hashcoins_held','hashcoins_reversed')
    AND COALESCE(o.stripe_payment_intent_id,p.stripe_payment_intent_id) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM hashcoin_ledger_entries x
      WHERE x.wallet_id=p.wallet_id AND x.entry_kind='earning' AND x.source_ref=p.request_id)
  UNION ALL
  SELECT 'deposit','deposit:' || b.stripe_payout_id,b.created_at,b.updated_at,NULL,NULL
  FROM stripe_connect_bank_payouts b
  WHERE :want_deposit AND b.stripe_account_id=CAST(:account AS text)
    AND b.livemode=:livemode AND b.updated_at>CAST(:since AS timestamptz)
    AND left(b.stripe_payout_id,3)='po_' AND char_length(b.stripe_payout_id)<=64
), page AS (
  SELECT kind,item_id COLLATE "C" AS item_id,occurred_at,updated_at,coins_delta,entry_id
  FROM items
  WHERE updated_at>CAST(:since AS timestamptz)
  ORDER BY occurred_at DESC,item_id COLLATE "C" DESC
  LIMIT :limit
), oldest AS (
  SELECT occurred_at,entry_id FROM page WHERE entry_id IS NOT NULL
  ORDER BY occurred_at,entry_id
  LIMIT 1
), base AS (
  SELECT COALESCE(SUM(x.amount_coins),0) AS coins
  FROM oldest o JOIN hashcoin_ledger_entries x ON x.wallet_id=CAST(:wallet AS uuid)
    AND (x.created_at,x.entry_id)<(o.occurred_at,o.entry_id)
), running AS (
  SELECT x.entry_id,
    b.coins+SUM(x.amount_coins) OVER (ORDER BY x.created_at,x.entry_id) AS balance_after
  FROM oldest o CROSS JOIN base b
  JOIN hashcoin_ledger_entries x ON x.wallet_id=CAST(:wallet AS uuid)
    AND (x.created_at,x.entry_id)>=(o.occurred_at,o.entry_id)
)
SELECT g.kind,g.item_id,g.occurred_at,g.updated_at,g.coins_delta,r.balance_after
FROM page g LEFT JOIN running r ON r.entry_id=g.entry_id
ORDER BY g.occurred_at DESC,g.item_id COLLATE "C" DESC
"""
_SCOPE_SQL = """SELECT now() AS as_of,
  (SELECT wallet_id FROM hashcoin_wallets
    WHERE user_id=:owner AND stripe_mode=:mode) AS wallet_id,
  (SELECT stripe_account_id FROM stripe_owner_payout_accounts
    WHERE user_id=:owner AND stripe_mode=:mode) AS account_id"""
_BALANCE_SQL = """SELECT COALESCE(SUM(amount_coins),0) FROM hashcoin_ledger_entries
  WHERE wallet_id=CAST(:wallet AS uuid)"""
_PAGE_PAYOUTS_SQL = """SELECT p.* FROM drive_request_owner_payouts p
  WHERE p.request_id=ANY(CAST(:ids AS uuid[]))
    AND (p.wallet_id=CAST(:wallet AS uuid) OR p.sandbox_wallet_id=CAST(:wallet AS uuid))"""
_PAGE_REDEMPTIONS_SQL = """SELECT r.* FROM hashcoin_redemptions r
  WHERE r.redemption_id=ANY(CAST(:ids AS uuid[])) AND r.wallet_id=CAST(:wallet AS uuid)"""
_PAGE_DEPOSITS_SQL = """SELECT b.* FROM stripe_connect_bank_payouts b
  WHERE b.stripe_payout_id=ANY(CAST(:ids AS text[]))
    AND b.stripe_account_id=CAST(:account AS text) AND b.livemode=:livemode"""
_RECEIPT_REDEMPTION_SQL = """SELECT r.* FROM hashcoin_redemptions r
  JOIN hashcoin_wallets w ON w.wallet_id=r.wallet_id
  WHERE r.redemption_id=:id AND w.user_id=:owner AND w.stripe_mode=r.stripe_mode"""
_RECEIPT_EARNING_SQL = """SELECT p.* FROM drive_request_owner_payouts p
  JOIN hashcoin_wallets w ON w.wallet_id=p.wallet_id
  WHERE p.request_id=:id AND w.user_id=:owner"""
_RECEIPT_ORDER_SQL = """SELECT paid_at,stripe_payment_intent_id IS NOT NULL AS has_intent
  FROM drive_request_payment_orders WHERE request_id=:id AND user_id=:owner"""
_RECEIPT_LEDGER_SQL = """SELECT entry_kind,amount_coins,created_at FROM hashcoin_ledger_entries
  WHERE wallet_id=CAST(:wallet AS uuid) AND source_ref=:ref
    AND entry_kind=ANY(CAST(:kinds AS text[]))"""
_RECEIPT_ADJUSTMENT_SQL = """SELECT e.entry_kind,e.wallet_id,e.amount_coins,e.created_at
  FROM hashcoin_ledger_entries e JOIN hashcoin_wallets w ON w.wallet_id=e.wallet_id
  WHERE w.user_id=:owner AND e.source_ref=:ref AND e.entry_kind=ANY(CAST(:kinds AS text[]))
  ORDER BY (e.entry_kind IN ('reversal','redemption_reversal')) DESC,e.created_at,e.entry_id
  LIMIT 1"""
_RECEIPT_PAYOUT_SQL = """SELECT p.* FROM drive_request_owner_payouts p
  WHERE p.request_id=:id
    AND (p.wallet_id=CAST(:wallet AS uuid) OR p.sandbox_wallet_id=CAST(:wallet AS uuid))"""
_RECEIPT_WALLET_REDEMPTION_SQL = """SELECT r.* FROM hashcoin_redemptions r
  WHERE r.redemption_id=:id AND r.wallet_id=CAST(:wallet AS uuid)"""
_RECEIPT_CASH_OUT_SQL = """SELECT r.redemption_id,r.status FROM hashcoin_redemptions r
  WHERE r.source_request_id=:id AND r.wallet_id=CAST(:wallet AS uuid)
  ORDER BY (r.status IN ('reserved','dispatching','unknown','succeeded')) DESC,
    r.created_at DESC,r.redemption_id DESC
  LIMIT 1"""
_RECEIPT_DEPOSIT_SQL = """SELECT b.* FROM stripe_connect_bank_payouts b
  JOIN stripe_owner_payout_accounts a ON a.stripe_account_id=b.stripe_account_id
  WHERE b.stripe_payout_id=:id AND a.user_id=:owner
    AND b.livemode=(a.stripe_mode='live')"""
_ACCOUNT_DEPOSIT_SQL = """SELECT b.* FROM stripe_connect_bank_payouts b
  WHERE b.stripe_payout_id=:id AND b.stripe_account_id=:account"""
_CONTENT_REDEMPTIONS_SQL = """SELECT r.redemption_id,r.stripe_transfer_id,r.source_request_id,
    p.erased_at
  FROM hashcoin_redemptions r JOIN hashcoin_wallets w ON w.wallet_id=r.wallet_id
  LEFT JOIN drive_request_owner_payouts p ON p.request_id=r.source_request_id
  WHERE r.stripe_transfer_id=ANY(CAST(:transfers AS text[])) AND w.user_id=:owner
    AND r.destination_account_id=:account"""
_CONTENT_RETURNED_SQL = """SELECT b.stripe_payout_id FROM stripe_connect_bank_payouts b
  WHERE b.stripe_payout_id=ANY(CAST(:ids AS text[]))
    AND b.stripe_account_id=:account AND b.livemode=:livemode"""
_CONTENT_TRANSFERS_SQL = """SELECT p.stripe_transfer_id,p.request_id,p.erased_at
  FROM drive_request_owner_payouts p
  JOIN drive_share_requests q ON q.request_id=p.request_id
  WHERE p.stripe_transfer_id=ANY(CAST(:transfers AS text[])) AND q.user_id=:owner
    AND p.destination_account_id=:account"""


class PayoutActivityError(ValueError):
    """A malformed activity query, cursor or item ID (HTTP 422)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return _utc(value).isoformat()
    if isinstance(value, str) and value:
        try:
            return _utc(datetime.fromisoformat(value)).isoformat()
        except ValueError:
            return None
    return None


def _uuid(value: Any) -> str:
    return str(UUID(str(value)))


def hussh_reference(item_uuid: Any) -> str:
    """Support reference shown to the owner: "HC-" plus 8 uppercase hex."""
    return "HC-" + UUID(str(item_uuid)).hex[:8].upper()


def _cursor_mac(user_id: str, encoded: str) -> str:
    key = get_core_security_settings().app_signing_key.encode()
    message = json.dumps(["payout-activity-cursor-v1", user_id, encoded], separators=(",", ":"))
    digest = hmac.new(key, message.encode(), hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def encode_cursor(
    *, user_id: str, mode: str, kind: str, occurred_at: datetime, item_id: str
) -> str:
    """An opaque, signed keyset position for one owner, mode and kind."""
    payload = {"i": item_id, "k": kind, "m": mode, "t": _utc(occurred_at).isoformat(), "v": 1}
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    encoded = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    token = encoded + "." + _cursor_mac(user_id, encoded)
    if len(token) > MAX_CURSOR_CHARS:
        raise PayoutActivityError("invalid_cursor")
    return token


def decode_cursor(token: Any, *, user_id: str, mode: str, kind: str) -> tuple[datetime, str]:
    """The keyset position of a cursor this server issued for this owner, mode and kind.

    The signature covers every byte, so an edited, foreign or re-used cursor is
    refused rather than silently repositioned. A cursor carries no authority:
    the query is always scoped to the token's owner.
    """
    if not isinstance(token, str) or not 1 <= len(token) <= MAX_CURSOR_CHARS:
        raise PayoutActivityError("invalid_cursor")
    encoded, separator, signature = token.rpartition(".")
    if (
        not separator
        or not encoded
        or not hmac.compare_digest(signature.encode(), _cursor_mac(user_id, encoded).encode())
    ):
        raise PayoutActivityError("invalid_cursor")
    try:
        raw = base64.b64decode(
            encoded.encode("ascii") + b"=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        )
        payload = json.loads(raw)
        if not isinstance(payload, dict) or set(payload) != {"i", "k", "m", "t", "v"}:
            raise ValueError("cursor shape")
        item_id, stamp = payload["i"], payload["t"]
        if (
            type(payload["v"]) is not int
            or payload["v"] != 1
            or payload["m"] != mode
            or payload["k"] != kind
            or not isinstance(item_id, str)
            or not ITEM_ID.fullmatch(item_id)
            or not isinstance(stamp, str)
            or len(stamp) > 40
        ):
            raise ValueError("cursor binding")
        occurred_at = datetime.fromisoformat(stamp)
        if occurred_at.tzinfo is None:
            raise ValueError("cursor time")
    except (UnicodeError, ValueError, TypeError, binascii.Error, OverflowError):
        raise PayoutActivityError("invalid_cursor") from None
    return _utc(occurred_at), item_id


def parse_item_id(item_id: Any) -> tuple[str, str]:
    """(prefix, normalized source) for a public item ID, else invalid_item."""
    match = ITEM_ID.fullmatch(item_id) if isinstance(item_id, str) else None
    if match is None:
        raise PayoutActivityError("invalid_item")
    return match.group(1), match.group(2)


def _review(value: Any) -> dict[str, str] | None:
    """Pass payout_review's verdict through, held to the closed vocabulary."""
    if value is None:
        return None
    reason = value.get("reason") if isinstance(value, Mapping) else None
    step = value.get("nextStep") if isinstance(value, Mapping) else None
    return {
        "reason": reason if reason in payout_review.HOLD_REASONS else "under_review",
        "nextStep": step if step in payout_review.HOLD_NEXT_STEPS else "none",
    }


def _earning_review(payout: Mapping[str, Any] | None) -> dict[str, str] | None:
    if payout is None:
        return None
    try:
        return _review(payout_review.review_for_earning(payout))
    except Exception as exc:  # A review defect must not hide the money row.
        logger.warning("payout_activity.review_failed kind=earning type=%s", type(exc).__name__)
        return None


def _redemption_review(
    redemption: Mapping[str, Any], source: Mapping[str, Any] | None
) -> dict[str, str] | None:
    try:
        return _review(payout_review.review_for_redemption(redemption, source))
    except Exception as exc:  # A review defect must not hide the money row.
        logger.warning("payout_activity.review_failed kind=redemption type=%s", type(exc).__name__)
        return None


def _earning_status(payout: Mapping[str, Any] | None, *, credited: bool) -> str:
    status = payout.get("status") if payout is not None else None
    if status == "hashcoins_reversed":
        return "reversed"
    if status in {"hashcoins_held", "manual_review"}:
        return "held"
    if credited or status == "hashcoins_credited":
        return "credited"
    if status == "void":
        return "no_earning"
    return "pending"


def _reversal_status(redemption: Mapping[str, Any]) -> str | None:
    if redemption.get("stripe_mode") != "live":
        return None
    status = redemption.get("reversal_status") or "none"
    if status == "none" and redemption.get("provider_review_reason"):
        return "manual_review"
    return status if status in _REVERSAL_STATUSES else "unknown"


def _bank(row: Mapping[str, Any]) -> dict[str, str | None] | None:
    """The deposit's own destination snapshot (migration 316), never today's bank."""
    name = row.get("destination_bank_name")
    last4 = row.get("destination_last4")
    name = name.strip() if isinstance(name, str) and 1 <= len(name.strip()) <= 80 else None
    last4 = last4 if isinstance(last4, str) and _LAST4.fullmatch(last4) else None
    return {"name": name, "last4": last4} if name or last4 else None


def _bank_reference(row: Mapping[str, Any]) -> str | None:
    value = row.get("trace_value")
    if row.get("trace_status") != "supported" or not isinstance(value, str):
        return None
    value = value.strip()
    return value if 1 <= len(value) <= 128 else None


def _deposit_status(row: Mapping[str, Any]) -> str:
    status = row.get("status")
    return status if status in _DEPOSIT_STATUSES else "pending"


def _request(
    request_id: Any,
    payout: Mapping[str, Any] | None,
    labels: Mapping[str, str | None],
    *,
    counts: bool = False,
) -> dict[str, Any] | None:
    """The owner's own, unerased request, else None. Labels may be None."""
    if request_id is None or payout is None or payout.get("erased_at") is not None:
        return None
    key = str(request_id)
    if key not in labels:
        return None
    result: dict[str, Any] = {"id": key, "label": labels[key]}
    if counts:
        result["confirmedFiles"] = payout.get("confirmed_files")
        result["expectedFiles"] = payout.get("expected_files")
    return result


def _later(stamp: datetime, source: Mapping[str, Any] | None) -> str | None:
    """An item changes when its own row or its source row last changed."""
    changed = source.get("updated_at") if source is not None else None
    if isinstance(changed, datetime) and _utc(changed) > _utc(stamp):
        return _iso(changed)
    return _iso(stamp)


def _rows(connection: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute(text(sql), params).mappings().all()]


def _row(connection: Any, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
    row = connection.execute(text(sql), params).mappings().first()
    return dict(row) if row is not None else None


def _optional_read(connection: Any, label: str, read: Callable[[], T], fallback: T) -> T:
    """Run a contract read from another lane inside a savepoint.

    Funds and deposit contents are optional enrichment that stays null until
    Stripe reports it; a failure there must not void the money receipt.
    """
    try:
        with connection.begin_nested():
            return read()
    except Exception as exc:
        logger.warning(
            "payout_activity.enrichment_failed read=%s type=%s", label, type(exc).__name__
        )
        return fallback


class PayoutActivityService(ExternalConnectorLifecycleStore):
    async def _read(self, operation: Callable[[Any], T]) -> T:
        def run() -> T:
            try:
                with self.db.engine.begin() as connection:
                    connection.execute(
                        text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                    )
                    connection.execute(text("SET LOCAL statement_timeout = '5s'"))
                    connection.execute(text("SET LOCAL lock_timeout = '2s'"))
                    return operation(connection)
            except SQLAlchemyError:
                raise ConnectorLifecycleError("connector_storage_unavailable") from None

        return await asyncio.to_thread(run)

    # -- activity -----------------------------------------------------------

    async def activity(
        self,
        *,
        user_id: str,
        mode: str,
        kind: str = "all",
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
        since: datetime | None = None,
    ) -> dict[str, Any]:
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("invalid owner")
        if mode not in ACTIVITY_MODES or kind not in ACTIVITY_KINDS:
            raise PayoutActivityError("invalid_query")
        if type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
            raise PayoutActivityError("invalid_query")
        if since is not None and (cursor is not None or since.tzinfo is None):
            raise PayoutActivityError("invalid_query")
        after = (
            decode_cursor(cursor, user_id=user_id, mode=mode, kind=kind)
            if cursor is not None
            else None
        )
        sources = _KIND_SOURCES[kind]

        def operation(connection: Any) -> dict[str, Any]:
            scope = _row(connection, _SCOPE_SQL, {"owner": user_id, "mode": mode}) or {}
            wallet = str(scope["wallet_id"]) if scope.get("wallet_id") else None
            account = scope.get("account_id")
            params = {
                "wallet": wallet,
                "account": account,
                "livemode": mode == "live",
                "want_earning": "earning" in sources,
                "want_redemption": "redemption" in sources,
                "want_adjustment": "adjustment" in sources,
                "want_deposit": "deposit" in sources,
            }
            if since is not None:
                params.update(since=_utc(since) - SINCE_OVERLAP, limit=MAX_SINCE_ITEMS + 1)
                page = _rows(connection, _SINCE_SQL, params)
            else:
                params.update(
                    after_at=after[0] if after else None,
                    after_id=after[1] if after else None,
                    limit=limit + 1,
                )
                page = _rows(connection, _PAGE_SQL, params)
            balance = (
                int(connection.execute(text(_BALANCE_SQL), {"wallet": wallet}).scalar_one())
                if wallet
                else 0
            )
            if since is not None:
                reset, more = len(page) > MAX_SINCE_ITEMS, False
                shown = [] if reset else page
            else:
                reset, more = False, len(page) > limit
                shown = page[:limit]
            items = self._page_items(
                connection, user_id=user_id, mode=mode, wallet=wallet, account=account, page=shown
            )
            next_cursor = (
                encode_cursor(
                    user_id=user_id,
                    mode=mode,
                    kind=kind,
                    occurred_at=shown[-1]["occurred_at"],
                    item_id=shown[-1]["item_id"],
                )
                if more and shown
                else None
            )
            return {
                "schemaVersion": SCHEMA_VERSION,
                "mode": mode,
                "kind": kind,
                "asOf": _iso(scope.get("as_of")),
                "currency": "USD",
                "coinsPerDollar": COINS_PER_DOLLAR,
                "balanceCoins": balance,
                "items": items,
                # The source-read client must detect rows rejected while
                # shaping the page before it treats a scan as complete.
                "sourceItemCount": len(shown),
                "nextCursor": next_cursor,
                "reset": reset,
            }

        return await self._read(operation)

    def _page_items(
        self,
        connection: Any,
        *,
        user_id: str,
        mode: str,
        wallet: str | None,
        account: str | None,
        page: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        refs = []
        for row in page:
            match = ITEM_ID.fullmatch(row["item_id"])
            if match is None:  # Writers validate provider IDs; never fail a page on one.
                logger.warning("payout_activity.item_skipped reason=malformed_id")
                continue
            refs.append((row, match.group(1), match.group(2)))
        redemption_ids = sorted(
            {
                source
                for _, prefix, source in refs
                if prefix in {"redemption", "redemption_reversal"}
            }
        )
        redemptions = (
            {
                str(row["redemption_id"]): row
                for row in _rows(
                    connection, _PAGE_REDEMPTIONS_SQL, {"ids": redemption_ids, "wallet": wallet}
                )
            }
            if redemption_ids and wallet
            else {}
        )
        request_ids = {source for _, prefix, source in refs if prefix in {"earning", "reversal"}}
        request_ids.update(
            str(row["source_request_id"])
            for row in redemptions.values()
            if row.get("source_request_id") is not None
        )
        payouts = (
            {
                str(row["request_id"]): row
                for row in _rows(
                    connection,
                    _PAGE_PAYOUTS_SQL,
                    {"ids": sorted(request_ids), "wallet": wallet},
                )
            }
            if request_ids and wallet
            else {}
        )
        deposit_ids = sorted({source for _, prefix, source in refs if prefix == "deposit"})
        deposits = (
            {
                row["stripe_payout_id"]: row
                for row in _rows(
                    connection,
                    _PAGE_DEPOSITS_SQL,
                    {"ids": deposit_ids, "account": account, "livemode": mode == "live"},
                )
            }
            if deposit_ids and account
            else {}
        )
        labels = owner_request_labels(
            connection,
            user_id=user_id,
            request_ids=[key for key, payout in payouts.items() if payout.get("erased_at") is None],
        )
        return [
            self._item(
                row,
                prefix,
                source,
                mode=mode,
                payouts=payouts,
                redemptions=redemptions,
                deposits=deposits,
                labels=labels,
            )
            for row, prefix, source in refs
        ]

    @staticmethod
    def _item(
        row: Mapping[str, Any],
        prefix: str,
        source: str,
        *,
        mode: str,
        payouts: Mapping[str, dict[str, Any]],
        redemptions: Mapping[str, dict[str, Any]],
        deposits: Mapping[str, dict[str, Any]],
        labels: Mapping[str, str | None],
    ) -> dict[str, Any]:
        coins_delta = row.get("coins_delta")
        item: dict[str, Any] = {
            "id": row["item_id"],
            "kind": row["kind"],
            "type": _ITEM_TYPES[prefix],
            "status": _DEFAULT_STATUS[prefix],
            "reversalStatus": None,
            "review": None,
            "occurredAt": _iso(row["occurred_at"]),
            "updatedAt": _iso(row["updated_at"]),
            "coinsDelta": int(coins_delta) if coins_delta is not None else None,
            "amountCents": abs(int(coins_delta)) if coins_delta is not None else None,
            "balanceAfterCoins": int(row["balance_after"])
            if row.get("balance_after") is not None
            else None,
            "request": None,
            "test": mode == "test",
            "expectedArrivalAt": None,
            "bank": None,
        }
        if prefix == "earning":
            payout = payouts.get(source)
            credited = coins_delta is not None
            item["status"] = _earning_status(payout, credited=credited)
            if not credited and payout is not None:
                net = payout.get("owner_earning_cents")
                item["amountCents"] = int(net) if net is not None else None
            item["updatedAt"] = _later(row["updated_at"], payout)
            item["review"] = _earning_review(payout)
            item["request"] = _request(source, payout, labels)
        elif prefix == "reversal":
            item["request"] = _request(source, payouts.get(source), labels)
        elif prefix in {"redemption", "redemption_reversal"}:
            redemption = redemptions.get(source)
            if redemption is not None:
                request_id = redemption.get("source_request_id")
                payout = payouts.get(str(request_id)) if request_id is not None else None
                item["request"] = _request(request_id, payout, labels)
                if prefix == "redemption":
                    item["updatedAt"] = _later(row["updated_at"], redemption)
                    item["status"] = _REDEMPTION_STATUS.get(redemption["status"], "unknown")
                    item["reversalStatus"] = _reversal_status(redemption)
                    item["review"] = _redemption_review(redemption, payout)
                    item["amountCents"] = int(redemption["amount_coins"])
        elif prefix == "deposit":
            deposit = deposits.get(source)
            if deposit is not None:
                item["status"] = _deposit_status(deposit)
                item["amountCents"] = int(deposit["amount_cents"])
                item["expectedArrivalAt"] = _iso(deposit.get("expected_arrival_at"))
                item["bank"] = _bank(deposit)
        return item

    # -- receipts -----------------------------------------------------------

    async def receipt(self, *, user_id: str, item_id: str) -> dict[str, Any] | None:
        """One owner-scoped receipt, or None for another owner or an unknown item."""
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("invalid owner")
        prefix, source = parse_item_id(item_id)
        if prefix == "deposit":
            if not _PAYOUT_ID.fullmatch(source):
                return None
        else:
            try:
                source = _uuid(source)
            except ValueError:
                return None
        readers = {
            "redemption": self._redemption_receipt,
            "earning": self._earning_receipt,
            "reversal": self._adjustment_receipt,
            "redemption_reversal": self._adjustment_receipt,
            "deposit": self._deposit_receipt,
        }
        read = readers[prefix]
        return await self._read(lambda connection: read(connection, user_id, prefix, source))

    def _redemption_receipt(
        self, connection: Any, user_id: str, _prefix: str, redemption_id: str
    ) -> dict[str, Any] | None:
        redemption = _row(
            connection, _RECEIPT_REDEMPTION_SQL, {"id": redemption_id, "owner": user_id}
        )
        if redemption is None:
            return None
        wallet = str(redemption["wallet_id"])
        ledger = {
            row["entry_kind"]: row
            for row in _rows(
                connection,
                _RECEIPT_LEDGER_SQL,
                {
                    "wallet": wallet,
                    "ref": redemption_id,
                    "kinds": ["redemption", "redemption_reversal"],
                },
            )
        }
        source_id = redemption.get("source_request_id")
        payout = (
            _row(connection, _RECEIPT_PAYOUT_SQL, {"id": str(source_id), "wallet": wallet})
            if source_id is not None
            else None
        )
        labels = (
            owner_request_labels(connection, user_id=user_id, request_ids=[source_id])
            if payout is not None and payout.get("erased_at") is None
            else {}
        )
        status = redemption["status"]
        debit = ledger.get("redemption")
        completed_at = (
            debit["created_at"]
            if debit is not None
            else redemption["updated_at"]
            if status == "failed"
            else None
        )
        reversal_status = _reversal_status(redemption)
        reversal = None
        if reversal_status is not None and reversal_status != "none":
            returned = ledger.get("redemption_reversal")
            reversal = {
                "status": reversal_status,
                "at": _iso(returned["created_at"]) if returned is not None else None,
            }
        funds, deposit = self._funds(connection, redemption)
        return {
            "id": "redemption:" + redemption_id,
            "kind": "redemption",
            "status": _REDEMPTION_STATUS.get(status, "unknown"),
            "mode": redemption["stripe_mode"],
            "coins": int(redemption["amount_coins"]),
            "amountCents": int(redemption["amount_coins"]),
            "reference": hussh_reference(redemption_id),
            "request": _request(source_id, payout, labels, counts=True),
            "earning": {
                "grossCents": payout.get("gross_amount_cents"),
                "refundCents": payout.get("refund_amount_cents"),
                "platformFeeCents": payout.get("platform_fee_cents"),
                "processingFeeCents": payout.get("allocated_processing_fee_cents"),
                "netCents": payout.get("owner_earning_cents"),
                "creditedAt": _iso(payout.get("credited_at")),
            }
            if payout is not None
            else None,
            "transfer": {
                "status": _TRANSFER_STATUS.get(status, "unknown"),
                "requestedAt": _iso(redemption["created_at"]),
                "sentAt": _iso(redemption.get("first_dispatch_at")),
                "completedAt": _iso(completed_at),
            },
            "reversal": reversal,
            "funds": funds,
            "bankDeposit": deposit,
            "review": _redemption_review(redemption, payout),
        }

    @staticmethod
    def _funds(
        connection: Any, redemption: Mapping[str, Any]
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """Funds stage and bank deposit from reconciled Stripe data only."""
        transfer = redemption.get("stripe_transfer_id")
        account = redemption.get("destination_account_id")
        if (
            redemption.get("status") != "succeeded"
            or not isinstance(transfer, str)
            or not _TRANSFER_ID.fullmatch(transfer)
            or not isinstance(account, str)
        ):
            return None, None
        stages = _optional_read(
            connection,
            "funds_for_transfers",
            lambda: connect_balances.funds_for_transfers(
                connection, stripe_account_id=account, transfer_ids=[transfer]
            ),
            {},
        )
        stage = stages.get(transfer) if isinstance(stages, Mapping) else None
        if not isinstance(stage, Mapping):
            return None, None
        status = stage.get("status")
        funds = {
            "status": status if status in _FUNDS_STATUSES else "unknown",
            "availableOn": _iso(stage.get("availableOn")),
        }
        payout_id = stage.get("stripePayoutId")
        if not isinstance(payout_id, str) or not _PAYOUT_ID.fullmatch(payout_id):
            return funds, None
        row = _row(connection, _ACCOUNT_DEPOSIT_SQL, {"id": payout_id, "account": account})
        if row is None:
            return funds, None
        return funds, {
            "id": "deposit:" + payout_id,
            "status": _deposit_status(row),
            "arrivalAt": _iso(row.get("expected_arrival_at")),
            "bank": _bank(row),
        }

    def _earning_receipt(
        self, connection: Any, user_id: str, _prefix: str, request_id: str
    ) -> dict[str, Any] | None:
        payout = _row(connection, _RECEIPT_EARNING_SQL, {"id": request_id, "owner": user_id})
        if payout is None:
            return None
        wallet = str(payout["wallet_id"])
        ledger = {
            row["entry_kind"]: row
            for row in _rows(
                connection,
                _RECEIPT_LEDGER_SQL,
                {"wallet": wallet, "ref": request_id, "kinds": ["earning", "reversal"]},
            )
        }
        order = _row(connection, _RECEIPT_ORDER_SQL, {"id": request_id, "owner": user_id})
        credit = ledger.get("earning")
        paid = bool(order and order.get("has_intent")) or bool(
            payout.get("stripe_payment_intent_id")
        )
        if credit is None and not paid:
            return None  # An unpaid checkout is not an earning yet.
        labels = (
            owner_request_labels(connection, user_id=user_id, request_ids=[request_id])
            if payout.get("erased_at") is None
            else {}
        )
        status = _earning_status(payout, credited=credit is not None)
        stages = [
            ("paid", order.get("paid_at") if order else None),
            ("delivered", payout.get("finalized_at")),
            ("credited", payout.get("credited_at") or (credit or {}).get("created_at")),
            ("held", payout.get("held_at") if status == "held" else None),
            ("reversed", (ledger.get("reversal") or {}).get("created_at")),
        ]
        cash_out = _row(connection, _RECEIPT_CASH_OUT_SQL, {"id": request_id, "wallet": wallet})
        coins = credit["amount_coins"] if credit is not None else payout.get("owner_earning_cents")
        return {
            "id": "earning:" + request_id,
            "kind": "earning",
            "status": status,
            "coins": int(coins) if coins is not None else None,
            "reference": hussh_reference(request_id),
            "request": _request(request_id, payout, labels, counts=True),
            "breakdown": {
                "grossCents": payout.get("gross_amount_cents"),
                "refundCents": payout.get("refund_amount_cents"),
                "platformFeeCents": payout.get("platform_fee_cents"),
                "processingFeeCents": payout.get("allocated_processing_fee_cents"),
                "netCents": payout.get("owner_earning_cents"),
            },
            "stages": [
                {"stage": stage, "at": _iso(at)}
                for stage, at in sorted(
                    ((stage, _utc(at)) for stage, at in stages if isinstance(at, datetime)),
                    key=lambda pair: pair[1],
                )
            ],
            "cashOut": {
                "itemId": "redemption:" + str(cash_out["redemption_id"]),
                "status": _REDEMPTION_STATUS.get(cash_out["status"], "unknown"),
            }
            if cash_out is not None
            else None,
            "review": _earning_review(payout),
        }

    def _adjustment_receipt(
        self, connection: Any, user_id: str, prefix: str, source: str
    ) -> dict[str, Any] | None:
        kinds = (
            ["reversal", "sandbox_reversal"] if prefix == "reversal" else ["redemption_reversal"]
        )
        entry = _row(
            connection, _RECEIPT_ADJUSTMENT_SQL, {"owner": user_id, "ref": source, "kinds": kinds}
        )
        if entry is None:
            return None
        wallet = str(entry["wallet_id"])
        if prefix == "reversal":
            request_id: Any = source
            related = "earning:" + source
        else:
            redemption = _row(
                connection, _RECEIPT_WALLET_REDEMPTION_SQL, {"id": source, "wallet": wallet}
            )
            request_id = redemption.get("source_request_id") if redemption else None
            related = "redemption:" + source
        payout = (
            _row(connection, _RECEIPT_PAYOUT_SQL, {"id": str(request_id), "wallet": wallet})
            if request_id is not None
            else None
        )
        labels = (
            owner_request_labels(connection, user_id=user_id, request_ids=[request_id])
            if payout is not None and payout.get("erased_at") is None
            else {}
        )
        return {
            "id": prefix + ":" + source,
            "kind": "adjustment",
            "type": _ITEM_TYPES[prefix],
            "coins": int(entry["amount_coins"]),
            "reference": hussh_reference(source),
            "request": _request(request_id, payout, labels, counts=True),
            "at": _iso(entry["created_at"]),
            "relatedItemId": related,
        }

    def _deposit_receipt(
        self, connection: Any, user_id: str, _prefix: str, payout_id: str
    ) -> dict[str, Any] | None:
        deposit = _row(connection, _RECEIPT_DEPOSIT_SQL, {"id": payout_id, "owner": user_id})
        if deposit is None:
            return None
        status = _deposit_status(deposit)
        method = deposit.get("payout_method")
        automatic = deposit.get("automatic")
        return {
            "id": "deposit:" + payout_id,
            "kind": "deposit",
            "status": status,
            "amountCents": int(deposit["amount_cents"]),
            "createdAt": _iso(deposit.get("created_at")),
            "expectedArrivalAt": _iso(deposit.get("expected_arrival_at")),
            "paidAt": _iso(deposit.get("paid_at")),
            "failedAt": _iso(deposit.get("failed_at")),
            "failureCode": deposit.get("failure_code"),
            "method": method if method in {"standard", "instant"} else None,
            "automatic": automatic if isinstance(automatic, bool) else None,
            "bank": _bank(deposit),
            "bankReference": _bank_reference(deposit),
            "contents": self._contents(connection, user_id, deposit),
            "actionRequired": "update_bank"
            if status == "failed" and deposit.get("failure_code") in _BANK_FAILURES
            else None,
        }

    @staticmethod
    def _contents(
        connection: Any, user_id: str, deposit: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        """What one bank deposit carried, from Stripe reconciliation only."""
        account = deposit["stripe_account_id"]
        contents = _optional_read(
            connection,
            "payout_contents",
            lambda: connect_balances.payout_contents(
                connection, stripe_account_id=account, stripe_payout_id=deposit["stripe_payout_id"]
            ),
            None,
        )
        if not isinstance(contents, Mapping) or contents.get("status") not in _CONTENTS_STATUSES:
            return None
        raw_items = contents.get("items")
        other = contents.get("otherCents")
        if not isinstance(raw_items, list) or type(other) is not int:
            return None
        entries = [entry for entry in raw_items if isinstance(entry, Mapping)]
        transfers = sorted(
            {
                entry["transferId"]
                for entry in entries
                if isinstance(entry.get("transferId"), str)
                and _TRANSFER_ID.fullmatch(entry["transferId"])
            }
        )
        cash_outs = (
            {
                row["stripe_transfer_id"]: row
                for row in _rows(
                    connection,
                    _CONTENT_REDEMPTIONS_SQL,
                    {"transfers": transfers, "owner": user_id, "account": account},
                )
            }
            if transfers
            else {}
        )
        direct = (
            {
                row["stripe_transfer_id"]: row
                for row in _rows(
                    connection,
                    _CONTENT_TRANSFERS_SQL,
                    {"transfers": transfers, "owner": user_id, "account": account},
                )
            }
            if transfers
            else {}
        )
        # A returned deposit links back only to a deposit of this same account and mode.
        returned_ids = sorted(
            {
                entry["returnedPayoutId"]
                for entry in entries
                if entry.get("kind") == "returned_deposit"
                and isinstance(entry.get("returnedPayoutId"), str)
                and _PAYOUT_ID.fullmatch(entry["returnedPayoutId"])
            }
        )
        returned = (
            {
                row["stripe_payout_id"]
                for row in _rows(
                    connection,
                    _CONTENT_RETURNED_SQL,
                    {"ids": returned_ids, "account": account, "livemode": deposit["livemode"]},
                )
            }
            if returned_ids
            else set()
        )
        # Only an unerased request of this owner is ever named.
        request_of: dict[str, Any] = {}
        for transfer, row in cash_outs.items():
            if row.get("erased_at") is None:
                request_of[transfer] = row.get("source_request_id")
        for transfer, row in direct.items():
            if row.get("erased_at") is None:
                request_of.setdefault(transfer, row.get("request_id"))
        wanted = sorted({str(r) for r in request_of.values() if r is not None})
        labels: dict[str, str | None] = {}
        for start in range(0, len(wanted), MAX_LABELS_PER_READ):
            labels.update(
                owner_request_labels(
                    connection,
                    user_id=user_id,
                    request_ids=wanted[start : start + MAX_LABELS_PER_READ],
                )
            )
        items = []
        for entry in entries:
            amount = entry.get("amountCents")
            if type(amount) is not int:
                continue
            transfer = entry.get("transferId")
            cash_out = cash_outs.get(transfer) if isinstance(transfer, str) else None
            request_id = request_of.get(transfer) if isinstance(transfer, str) else None
            kind = entry.get("kind")
            returned_id = entry.get("returnedPayoutId")
            item_id = None
            if cash_out is not None:
                item_id = "redemption:" + str(cash_out["redemption_id"])
            elif (
                kind == "returned_deposit"
                and isinstance(returned_id, str)
                and returned_id in returned
            ):
                item_id = "deposit:" + returned_id
            items.append(
                {
                    "itemId": item_id,
                    "type": kind if kind in _CONTENT_TYPES else "other",
                    "requestLabel": labels.get(str(request_id)) if request_id else None,
                    "amountCents": amount,
                }
            )
        return {"status": contents["status"], "items": items, "otherCents": other}
