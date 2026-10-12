"""Connected-account Stripe balance ("In Stripe") and bank-payout contents.

Read helpers (funds_for_transfers, payout_contents) are the contract the payout
activity read-model calls. They only SELECT and never call Stripe.

Writers keep three rules:
- Provider I/O never runs inside a database transaction. A refresh claims the
  snapshot's refresh_started_at lease, reads Stripe, then stores the result
  fenced by that lease. Payout itemisation does the same with scan_started_at
  and a durable cursor.
- Every provider read uses the Connect key and mode, max_network_retries=0, a
  bounded wait and a livemode check. A mismatch stores nothing.
- Attribution follows Stripe's own reconciliation, never timing:
  payment -> the destination payment's source_transfer (tr_) -> the owner's
  cash-out or document transfer on the same connected account;
  payment_refund -> the refunded destination payment, then as above;
  payout_failure / payout_cancel -> a returned deposit re-sent in this payout.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import re
import time
from collections import Counter
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any

import stripe
from sqlalchemy import text

from hushh_mcp.services.external_connector_lifecycle_store import (
    ConnectorLifecycleError,
    ExternalConnectorLifecycleStore,
)
from hushh_mcp.services.payout_doorbell import notify_payout_changed
from hushh_mcp.services.stripe_mode import configured_connect_mode, connect_config

logger = logging.getLogger(__name__)

_ACCOUNT_ID = re.compile(r"^acct_[A-Za-z0-9_]{1,250}$")
_TXN_ID = re.compile(r"^txn_[A-Za-z0-9_]{1,250}$")
_PAYOUT_ID = re.compile(r"^po_[A-Za-z0-9_]{1,252}$")
_TRANSFER_ID = re.compile(r"^tr_[A-Za-z0-9_]{1,252}$")
_SOURCE_ID = re.compile(r"^[a-z]{1,8}_[A-Za-z0-9_]{1,250}$")
_TXN_TYPE = re.compile(r"^[a-z][a-z_]{0,63}$")

PAGE_SIZE = 100
MAX_PAGES_PER_RUN = 3
HISTORY_WINDOW = timedelta(days=35)
SNAPSHOT_MAX_AGE = timedelta(minutes=10)
INLINE_REFRESH_SECONDS = 2.5
# Inline provider reads end first, so a timeout is a clean failure, not a cancel.
_INLINE_PROVIDER_SECONDS = 2.2
PROVIDER_TIMEOUT_SECONDS = 8.0
_MIN_PROVIDER_SECONDS = 0.25
_MIN_RUN_SECONDS = 3.0
_POLL_SECONDS = 0.25
_MAX_CONTENT_ITEMS = 100
_MAX_TRANSFER_LOOKUPS = 100
_MAX_RETURN_HOPS = 3
_RETURNED_DEPOSIT_TYPES = ("payout_failure", "payout_cancel")
# Aggregate counts a worker tick reports; drive_work_drain allowlists each one.
WORKER_OUTCOMES = frozenset(
    {
        "balance_accounts_checked",
        "balance_snapshots_changed",
        "balance_refresh_deferred",
        "payout_reconciliations_queued",
        "payout_reconciliations_checked",
        "payout_reconciliations_completed",
        "payout_reconciliation_deferred",
    }
)

# A hung provider socket must never occupy the default executor that every
# database call shares. Provider reads get a small pool of their own; a queued
# read that times out is cancelled before it starts.
_PROVIDER_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="connect-balance")


class ConnectBalanceError(RuntimeError):
    """Closed-set failure codes; never provider text."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    to_dict = getattr(value, "to_dict", None)
    converted = to_dict() if callable(to_dict) else None
    if not isinstance(converted, dict):
        raise ConnectBalanceError("provider_mismatch")
    return converted


def _object_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return value if isinstance(value, str) and _SOURCE_ID.fullmatch(value) else None


def _iso(value: datetime | None) -> str | None:
    """UTC ISO-8601, whatever the database session's time zone."""
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC).isoformat()


def _timestamp(value: Any) -> datetime:
    if type(value) is not int or value < 0:
        raise ConnectBalanceError("provider_mismatch")
    try:
        return datetime.fromtimestamp(value, UTC)
    except (OverflowError, OSError, ValueError):
        raise ConnectBalanceError("provider_mismatch") from None


def _balance_fields(remote: dict[str, Any], *, livemode: bool) -> dict[str, int]:
    """USD available and pending cents from a connected-account Balance."""
    if remote.get("object") != "balance" or remote.get("livemode") is not livemode:
        raise ConnectBalanceError("provider_mismatch")
    totals = {}
    for key in ("available", "pending"):
        entries = remote.get(key)
        if not isinstance(entries, list):
            raise ConnectBalanceError("provider_mismatch")
        cents = 0
        for entry in entries:
            if (
                not isinstance(entry, dict)
                or type(entry.get("amount")) is not int
                or not isinstance(entry.get("currency"), str)
            ):
                raise ConnectBalanceError("provider_mismatch")
            if entry["currency"] == "usd":
                cents += entry["amount"]
        totals[key] = cents
    return totals


def _transaction_fields(remote: dict[str, Any], *, livemode: bool) -> dict[str, Any] | None:
    """One balance transaction, or None when it is not in USD.

    BalanceTransaction has no livemode of its own; an expanded source that
    reports one must match, so a sandbox object never enters a live ledger.
    """
    txn_id = remote.get("id")
    txn_type = remote.get("type")
    status = remote.get("status")
    amounts = (remote.get("amount"), remote.get("fee"), remote.get("net"))
    available_on = remote.get("available_on")
    balance_type = remote.get("balance_type")
    if (
        remote.get("object") != "balance_transaction"
        or not isinstance(txn_id, str)
        or not _TXN_ID.fullmatch(txn_id)
        or not isinstance(txn_type, str)
        or not _TXN_TYPE.fullmatch(txn_type)
        or status not in {"pending", "available"}
        or any(type(amount) is not int for amount in amounts)
        or (balance_type is not None and not isinstance(balance_type, str))
    ):
        raise ConnectBalanceError("provider_mismatch")
    source = remote.get("source")
    if isinstance(source, dict) and "livemode" in source and source["livemode"] is not livemode:
        raise ConnectBalanceError("provider_mismatch")
    if remote.get("currency") != "usd":
        return None
    transfer_id = charge_id = None
    if isinstance(source, dict):
        if txn_type == "payment" and source.get("object") == "charge":
            candidate = _object_id(source.get("source_transfer"))
            transfer_id = candidate if candidate and _TRANSFER_ID.fullmatch(candidate) else None
        if source.get("object") == "refund":
            charge_id = _object_id(source.get("charge"))
    return {
        "id": txn_id,
        "type": txn_type,
        "status": status,
        "amount": amounts[0],
        "fee": amounts[1],
        "net": amounts[2],
        "balance_type": balance_type,
        "available_on": _timestamp(available_on) if available_on is not None else None,
        "created": _timestamp(remote.get("created")),
        "source": _object_id(source),
        "transfer": transfer_id,
        "charge": charge_id,
    }


def _page_items(page: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    data = page.get("data")
    has_more = page.get("has_more")
    if (
        page.get("object") != "list"
        or not isinstance(data, list)
        or type(has_more) is not bool
        or len(data) > PAGE_SIZE
        or (has_more and not data)
    ):
        raise ConnectBalanceError("provider_mismatch")
    return [_as_dict(item) for item in data], has_more


def _next_available(transactions: Sequence[dict[str, Any]]) -> tuple[datetime | None, int | None]:
    """Earliest date on which pending payments-balance funds net positive."""
    totals: dict[datetime, int] = {}
    for txn in transactions:
        if (
            txn["status"] == "pending"
            and txn["available_on"] is not None
            and txn["balance_type"] in {None, "payments"}
        ):
            totals[txn["available_on"]] = totals.get(txn["available_on"], 0) + txn["net"]
    for day in sorted(totals):
        if totals[day] > 0:
            return day, totals[day]
    return None, None


def _needs_refresh(state: dict[str, Any]) -> bool:
    """Missing, older than ten minutes, older than a change, or marked due."""
    fetched = state.get("fetched_at")
    if fetched is None or state.get("available_cents") is None:
        return True
    latest_change = state.get("latest_change")
    return bool(
        state["db_now"] - fetched > SNAPSHOT_MAX_AGE
        or (latest_change is not None and latest_change > fetched)
        or state.get("refresh_due_at") is not None
    )


# --- SQL (fixed templates; values are always bound parameters) --------------

_MARK_DUE = """INSERT INTO stripe_connect_balance_snapshots AS s
  (stripe_account_id,livemode,refresh_due_at,updated_at)
  VALUES (:account,:livemode,clock_timestamp(),clock_timestamp())
  ON CONFLICT (stripe_account_id) DO UPDATE SET
    refresh_due_at=GREATEST(s.refresh_due_at,excluded.refresh_due_at),
    updated_at=excluded.updated_at
  WHERE s.livemode=excluded.livemode"""

_ENQUEUE = """INSERT INTO stripe_connect_payout_reconciliations
  (stripe_payout_id,stripe_account_id)
  SELECT b.stripe_payout_id,b.stripe_account_id FROM stripe_connect_bank_payouts b
  WHERE b.stripe_payout_id=:payout AND b.stripe_account_id=:account
  ON CONFLICT (stripe_payout_id) DO NOTHING
  RETURNING stripe_payout_id"""

# The latest change is when money last moved for this owner: an immutable
# cash-out or cash-out reversal ledger entry, or a stored deposit update.
# (Redemption rows themselves are re-checked hourly, so their updated_at is not
# a balance signal.)
_OWNER_STATE = """SELECT a.stripe_account_id,clock_timestamp() AS db_now,
  s.available_cents,s.pending_cents,s.next_available_on,s.next_available_cents,
  s.fetched_at,s.refresh_started_at,s.refresh_due_at,
  GREATEST(
    (SELECT MAX(e.created_at) FROM hashcoin_ledger_entries e
      JOIN hashcoin_wallets w ON w.wallet_id=e.wallet_id
      WHERE w.user_id=:owner AND w.stripe_mode=:mode
        AND e.entry_kind IN ('redemption','redemption_reversal')),
    (SELECT MAX(b.updated_at) FROM stripe_connect_bank_payouts b
      WHERE b.stripe_account_id=a.stripe_account_id AND b.livemode=:livemode)
  ) AS latest_change
  FROM stripe_owner_payout_accounts a
  LEFT JOIN stripe_connect_balance_snapshots s
    ON s.stripe_account_id=a.stripe_account_id AND s.livemode=:livemode
  WHERE a.user_id=:owner AND a.stripe_mode=:mode
  LIMIT 1"""

_CLAIM_REFRESH = """INSERT INTO stripe_connect_balance_snapshots AS s
  (stripe_account_id,livemode,refresh_started_at)
  SELECT :account,:livemode,clock_timestamp()
  WHERE EXISTS (SELECT 1 FROM stripe_owner_payout_accounts
    WHERE stripe_account_id=:account AND stripe_mode=:mode)
  ON CONFLICT (stripe_account_id) DO UPDATE SET refresh_started_at=excluded.refresh_started_at
  WHERE s.livemode=excluded.livemode
    AND (s.refresh_started_at IS NULL
      OR s.refresh_started_at<clock_timestamp()-interval '60 seconds')
  RETURNING s.refresh_started_at,s.fetched_at"""

_RELEASE_REFRESH = """UPDATE stripe_connect_balance_snapshots SET refresh_started_at=NULL
  WHERE stripe_account_id=:account AND refresh_started_at=:started"""

_CLAIM_DUE_REFRESH = """UPDATE stripe_connect_balance_snapshots AS s
  SET refresh_started_at=clock_timestamp()
  FROM (
    SELECT d.stripe_account_id FROM stripe_connect_balance_snapshots d
    JOIN stripe_owner_payout_accounts a
      ON a.stripe_account_id=d.stripe_account_id AND a.stripe_mode=:mode
    WHERE d.livemode=:livemode
      AND (d.refresh_started_at IS NULL
        OR d.refresh_started_at<clock_timestamp()-interval '60 seconds')
      AND (d.refresh_due_at<=clock_timestamp() OR d.fetched_at IS NULL
        OR (d.next_available_on<=clock_timestamp()
          AND d.fetched_at<clock_timestamp()-interval '30 minutes'))
    ORDER BY d.refresh_started_at ASC NULLS FIRST,
      COALESCE(d.refresh_due_at,d.next_available_on,d.updated_at),d.stripe_account_id
    LIMIT 1 FOR UPDATE OF d SKIP LOCKED
  ) due
  WHERE s.stripe_account_id=due.stripe_account_id
  RETURNING s.stripe_account_id,s.refresh_started_at"""

_LOCK_SNAPSHOT = """SELECT available_cents,pending_cents,next_available_on,next_available_cents,
  fetched_at,refresh_started_at FROM stripe_connect_balance_snapshots
  WHERE stripe_account_id=:account AND livemode=:livemode FOR UPDATE"""

_STORE_SNAPSHOT = """UPDATE stripe_connect_balance_snapshots SET
  currency='usd',available_cents=:available,pending_cents=:pending,
  next_available_on=:next_on,next_available_cents=:next_cents,fetched_at=:started,
  refresh_started_at=NULL,
  refresh_due_at=CASE WHEN refresh_due_at<=:started THEN NULL ELSE refresh_due_at END,
  updated_at=clock_timestamp()
  WHERE stripe_account_id=:account AND livemode=:livemode AND refresh_started_at=:started"""

_UPSERT_TRANSACTION = """INSERT INTO stripe_connect_balance_transactions AS t
  (stripe_balance_transaction_id,stripe_account_id,livemode,txn_type,amount_cents,fee_cents,
   net_cents,status,available_on,provider_created_at,source_id,source_transfer_id,
   source_charge_id,stripe_payout_id,observed_at,updated_at)
  VALUES (:id,:account,:livemode,:type,:amount,:fee,:net,:status,:available_on,:created,
   :source,:transfer,:charge,:payout,clock_timestamp(),clock_timestamp())
  ON CONFLICT (stripe_balance_transaction_id) DO UPDATE SET
    amount_cents=excluded.amount_cents,fee_cents=excluded.fee_cents,
    net_cents=excluded.net_cents,status=excluded.status,available_on=excluded.available_on,
    provider_created_at=COALESCE(t.provider_created_at,excluded.provider_created_at),
    source_id=COALESCE(t.source_id,excluded.source_id),
    source_transfer_id=COALESCE(t.source_transfer_id,excluded.source_transfer_id),
    source_charge_id=COALESCE(t.source_charge_id,excluded.source_charge_id),
    stripe_payout_id=COALESCE(t.stripe_payout_id,excluded.stripe_payout_id),
    observed_at=excluded.observed_at,updated_at=excluded.updated_at
  WHERE t.stripe_account_id=excluded.stripe_account_id AND t.livemode=excluded.livemode
    AND t.txn_type=excluded.txn_type
  RETURNING t.stripe_balance_transaction_id"""

_ACCOUNT_OWNER = """SELECT user_id FROM stripe_owner_payout_accounts
  WHERE stripe_account_id=:account AND stripe_mode=:mode LIMIT 1"""

# Backstop for deposits the webhook did not queue. Every write that makes a
# deposit ready (automatic=false, or reconciliation completed/not_applicable)
# moves its updated_at, so only the last 7 days are read, on the partial index
# stripe_connect_bank_payouts_reconcile_recent (317). The cost follows recent
# deposit changes, not every deposit ever. now() (stable) keeps the index bound.
_DISCOVER_RECONCILIATIONS = """INSERT INTO stripe_connect_payout_reconciliations
  (stripe_payout_id,stripe_account_id,status,completed_at)
  SELECT b.stripe_payout_id,b.stripe_account_id,
    CASE WHEN b.automatic IS FALSE OR b.reconciliation_status='not_applicable'
      THEN 'not_applicable' ELSE 'pending' END,
    CASE WHEN b.automatic IS FALSE OR b.reconciliation_status='not_applicable'
      THEN clock_timestamp() END
  FROM stripe_connect_bank_payouts b
  JOIN stripe_owner_payout_accounts a
    ON a.stripe_account_id=b.stripe_account_id AND a.stripe_mode=:mode
  WHERE b.livemode=:livemode
    AND b.updated_at>=now()-interval '7 days'
    AND (b.automatic IS FALSE OR b.reconciliation_status IN ('completed','not_applicable'))
    AND NOT EXISTS (SELECT 1 FROM stripe_connect_payout_reconciliations r
      WHERE r.stripe_payout_id=b.stripe_payout_id)
  ORDER BY b.created_at DESC,b.stripe_payout_id DESC
  LIMIT 5
  ON CONFLICT (stripe_payout_id) DO NOTHING
  RETURNING stripe_account_id,status"""

_CLAIM_RECONCILIATION = """UPDATE stripe_connect_payout_reconciliations AS r
  SET status='in_progress',scan_started_at=clock_timestamp(),updated_at=clock_timestamp()
  FROM (
    SELECT q.stripe_payout_id,b.automatic,b.reconciliation_status
    FROM stripe_connect_payout_reconciliations q
    JOIN stripe_connect_bank_payouts b
      ON b.stripe_payout_id=q.stripe_payout_id AND b.stripe_account_id=q.stripe_account_id
    JOIN stripe_owner_payout_accounts a
      ON a.stripe_account_id=q.stripe_account_id AND a.stripe_mode=:mode
    WHERE q.status IN ('pending','in_progress') AND b.livemode=:livemode
      AND (q.scan_started_at IS NULL
        OR q.scan_started_at<clock_timestamp()-interval '5 minutes')
    ORDER BY q.scan_started_at ASC NULLS FIRST,q.stripe_payout_id
    LIMIT 1 FOR UPDATE OF q SKIP LOCKED
  ) due
  WHERE r.stripe_payout_id=due.stripe_payout_id
  RETURNING r.stripe_payout_id,r.stripe_account_id,r.cursor,r.scan_started_at,
    due.automatic,due.reconciliation_status"""

_LOCK_RECONCILIATION = """SELECT status,scan_started_at FROM stripe_connect_payout_reconciliations
  WHERE stripe_payout_id=:payout AND stripe_account_id=:account FOR UPDATE"""

_ADVANCE_RECONCILIATION = """UPDATE stripe_connect_payout_reconciliations SET
  cursor=:cursor,updated_at=clock_timestamp()
  WHERE stripe_payout_id=:payout AND scan_started_at=:started"""

_FINISH_RECONCILIATION = """UPDATE stripe_connect_payout_reconciliations SET
  status=:status,cursor=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE stripe_payout_id=:payout AND stripe_account_id=:account
    AND scan_started_at=:started AND status='in_progress'"""

# More pages remain: resume on the next tick instead of waiting out the lease.
_RELEASE_RECONCILIATION = """UPDATE stripe_connect_payout_reconciliations SET scan_started_at=NULL
  WHERE stripe_payout_id=:payout AND scan_started_at=:started AND status='in_progress'"""

_TRANSFER_FUNDS = """SELECT DISTINCT ON (source_transfer_id) source_transfer_id,status,
  available_on,stripe_payout_id FROM stripe_connect_balance_transactions
  WHERE stripe_account_id=:account AND txn_type='payment'
    AND source_transfer_id=ANY(CAST(:transfers AS text[]))
  ORDER BY source_transfer_id,provider_created_at,stripe_balance_transaction_id"""

_RETURNED_DEPOSIT = """SELECT status,available_on,stripe_payout_id
  FROM stripe_connect_balance_transactions
  WHERE stripe_account_id=:account AND source_id=:payout
    AND txn_type IN ('payout_failure','payout_cancel')
  ORDER BY provider_created_at DESC,stripe_balance_transaction_id DESC LIMIT 1"""

_PAYOUT_STATE = """SELECT b.livemode,r.status FROM stripe_connect_bank_payouts b
  LEFT JOIN stripe_connect_payout_reconciliations r
    ON r.stripe_payout_id=b.stripe_payout_id AND r.stripe_account_id=b.stripe_account_id
  WHERE b.stripe_payout_id=:payout AND b.stripe_account_id=:account"""

# Only links Stripe itself reported count: a payment's source_transfer, or the
# payment a refund reversed. Both owner rows are fenced to this account.
_PAYOUT_ITEMS = """SELECT t.txn_type,t.net_cents,t.source_id,
  COALESCE(t.source_transfer_id,refunded.source_transfer_id) AS transfer_id,
  r.redemption_id,r.source_request_id,p.request_id AS document_request_id
  FROM stripe_connect_balance_transactions t
  LEFT JOIN LATERAL (
    SELECT pay.source_transfer_id FROM stripe_connect_balance_transactions pay
    WHERE t.txn_type='payment_refund' AND pay.stripe_account_id=t.stripe_account_id
      AND pay.livemode=t.livemode AND pay.txn_type='payment'
      AND pay.source_id=t.source_charge_id
    ORDER BY pay.provider_created_at LIMIT 1
  ) refunded ON TRUE
  LEFT JOIN hashcoin_redemptions r
    ON r.stripe_transfer_id=COALESCE(t.source_transfer_id,refunded.source_transfer_id)
    AND r.destination_account_id=t.stripe_account_id
  LEFT JOIN drive_request_owner_payouts p
    ON p.stripe_transfer_id=COALESCE(t.source_transfer_id,refunded.source_transfer_id)
    AND p.destination_account_id=t.stripe_account_id
  WHERE t.stripe_payout_id=:payout AND t.stripe_account_id=:account AND t.livemode=:livemode
    AND ((t.txn_type IN ('payment','payment_refund')
        AND (r.redemption_id IS NOT NULL OR p.request_id IS NOT NULL))
      OR t.txn_type IN ('payout_failure','payout_cancel'))
  ORDER BY t.provider_created_at,t.stripe_balance_transaction_id
  LIMIT :limit"""

_PAYOUT_TOTAL = """SELECT COALESCE(SUM(net_cents),0) FROM stripe_connect_balance_transactions
  WHERE stripe_payout_id=:payout AND stripe_account_id=:account AND livemode=:livemode
    AND NOT (txn_type='payout' AND source_id=:payout)"""


# --- Contract read helpers (SELECT only, never Stripe) ------------------------


def funds_for_transfers(
    connection: Any, *, stripe_account_id: str, transfer_ids: Sequence[str]
) -> dict[str, dict[str, Any]]:
    """Map each owner transfer to its funds stage once Stripe reports it.

    Returns {transfer_id: {"status": "pending"|"available"|"paid_out",
    "availableOn": iso|None, "stripePayoutId": po_|None,
    "returnedPayoutId": po_|None}}. A deposit that failed or was canceled is
    followed to the deposit that re-sent its funds; until then the funds are
    back in the balance. Unknown transfers are absent; callers show the stage
    as unknown, never inferred.
    """
    if not isinstance(stripe_account_id, str) or not _ACCOUNT_ID.fullmatch(stripe_account_id):
        return {}
    wanted = sorted(
        {item for item in transfer_ids if isinstance(item, str) and _TRANSFER_ID.fullmatch(item)}
    )[:_MAX_TRANSFER_LOOKUPS]
    if not wanted:
        return {}
    rows = (
        connection.execute(
            text(_TRANSFER_FUNDS), {"account": stripe_account_id, "transfers": wanted}
        )
        .mappings()
        .all()
    )
    carriers: dict[str, dict[str, Any]] = {}
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        payout = row["stripe_payout_id"]
        if payout is None:
            stage = {"status": row["status"], "stripePayoutId": None, "returnedPayoutId": None}
            available_on = row["available_on"]
        else:
            if payout not in carriers:
                carriers[payout] = _carrier(connection, stripe_account_id, payout)
            stage = dict(carriers[payout])
            available_on = stage.pop("available_on", None) or row["available_on"]
        result[row["source_transfer_id"]] = {**stage, "availableOn": _iso(available_on)}
    return result


def _carrier(connection: Any, account_id: str, payout_id: str) -> dict[str, Any]:
    """The deposit that carries funds now, following returned deposits."""
    current, returned = payout_id, None
    for _ in range(_MAX_RETURN_HOPS):
        back = (
            connection.execute(text(_RETURNED_DEPOSIT), {"account": account_id, "payout": current})
            .mappings()
            .first()
        )
        if back is None:
            break
        returned = current
        if back["stripe_payout_id"] is None:
            return {
                "status": back["status"],
                "stripePayoutId": None,
                "returnedPayoutId": returned,
                "available_on": back["available_on"],
            }
        current = back["stripe_payout_id"]
    return {"status": "paid_out", "stripePayoutId": current, "returnedPayoutId": returned}


def payout_contents(
    connection: Any, *, stripe_account_id: str, stripe_payout_id: str
) -> dict[str, Any]:
    """Itemise one automatic bank payout from reconciled balance transactions.

    Returns {"status": "pending"|"complete"|"not_applicable",
    "items": [{"transferId": tr_|None, "kind": "cash_out"|"document_transfer"|
    "returned_deposit"|"refund", "amountCents": int, "redemptionId": uuid|None,
    "requestId": uuid|None, "returnedPayoutId": po_|None}], "otherCents": int}.
    Items appear only once Stripe finished reconciling the payout. Anything not
    linked by Stripe to this owner's Hussh activity (fees, adjustments, other
    transfers) is summed in otherCents, so items + otherCents = the deposit.
    Attribution follows Stripe reconciliation only, never timing.
    """
    empty = {"status": "pending", "items": [], "otherCents": 0}
    if (
        not isinstance(stripe_account_id, str)
        or not _ACCOUNT_ID.fullmatch(stripe_account_id)
        or not isinstance(stripe_payout_id, str)
        or not _PAYOUT_ID.fullmatch(stripe_payout_id)
    ):
        return empty
    params = {"account": stripe_account_id, "payout": stripe_payout_id}
    state = connection.execute(text(_PAYOUT_STATE), params).mappings().first()
    if state is None or state["status"] not in {"complete", "not_applicable"}:
        return empty
    if state["status"] == "not_applicable":
        return {"status": "not_applicable", "items": [], "otherCents": 0}
    params["livemode"] = bool(state["livemode"])
    rows = (
        connection.execute(text(_PAYOUT_ITEMS), {**params, "limit": _MAX_CONTENT_ITEMS})
        .mappings()
        .all()
    )
    items = []
    for row in rows:
        returned = row["txn_type"] in _RETURNED_DEPOSIT_TYPES
        if returned:
            kind = "returned_deposit"
        elif row["txn_type"] == "payment_refund":
            kind = "refund"
        else:
            kind = "cash_out" if row["redemption_id"] is not None else "document_transfer"
        request_id = row["source_request_id"] or row["document_request_id"]
        source = row["source_id"]
        items.append(
            {
                "transferId": None if returned else row["transfer_id"],
                "kind": kind,
                "amountCents": int(row["net_cents"]),
                "redemptionId": str(row["redemption_id"]) if row["redemption_id"] else None,
                "requestId": str(request_id) if request_id and not returned else None,
                "returnedPayoutId": source
                if returned and isinstance(source, str) and _PAYOUT_ID.fullmatch(source)
                else None,
            }
        )
    total = int(connection.execute(text(_PAYOUT_TOTAL), params).scalar_one())
    return {
        "status": "complete",
        "items": items,
        "otherCents": total - sum(item["amountCents"] for item in items),
    }


# --- Webhook-side queue helpers (caller's transaction, no provider I/O) ------


def mark_balance_refresh_due(connection: Any, *, stripe_account_id: str, livemode: bool) -> None:
    """Ask the worker to refresh this account's balance snapshot soon.

    Called on the webhook transaction (balance.available, payout.*). Writes only
    refresh_due_at (creating the cache row if needed); never calls Stripe. The
    latest event time wins, so a refresh already in flight cannot clear an
    event that arrived after its provider read began.
    """
    if not isinstance(stripe_account_id, str) or not _ACCOUNT_ID.fullmatch(stripe_account_id):
        raise ValueError("invalid connected account")
    if type(livemode) is not bool:
        raise ValueError("invalid livemode")
    connection.execute(text(_MARK_DUE), {"account": stripe_account_id, "livemode": livemode})


def enqueue_payout_reconciliation(
    connection: Any, *, stripe_payout_id: str, stripe_account_id: str
) -> bool:
    """Queue one automatic payout for itemisation once Stripe reconciled it.

    Called on the webhook transaction for payout.reconciliation_completed (and
    payout.paid when the stored reconciliation_status is 'completed'), after the
    payout snapshot is stored. Idempotent: a payout is queued at most once, and
    only for the connected account that owns it. Returns True when queued now.
    """
    if not isinstance(stripe_payout_id, str) or not _PAYOUT_ID.fullmatch(stripe_payout_id):
        raise ValueError("invalid payout")
    if not isinstance(stripe_account_id, str) or not _ACCOUNT_ID.fullmatch(stripe_account_id):
        raise ValueError("invalid connected account")
    queued = connection.execute(
        text(_ENQUEUE), {"payout": stripe_payout_id, "account": stripe_account_id}
    ).first()
    return queued is not None


# --- Provider-backed refresh and itemisation ---------------------------------


def _notify_owner(connection: Any, *, account_id: str, mode: str, kinds: Sequence[str]) -> None:
    owner = connection.execute(
        text(_ACCOUNT_OWNER), {"account": account_id, "mode": mode}
    ).scalar_one_or_none()
    if isinstance(owner, str) and owner:
        notify_payout_changed(connection, owner, kinds)


def _upsert_transactions(
    connection: Any,
    transactions: Sequence[dict[str, Any]],
    *,
    account_id: str,
    livemode: bool,
    payout_id: str | None,
) -> None:
    for txn in transactions:
        stored = connection.execute(
            text(_UPSERT_TRANSACTION),
            {
                "id": txn["id"],
                "account": account_id,
                "livemode": livemode,
                "type": txn["type"],
                "amount": txn["amount"],
                "fee": txn["fee"],
                "net": txn["net"],
                "status": txn["status"],
                "available_on": txn["available_on"],
                "created": txn["created"],
                "source": txn["source"],
                "transfer": txn["transfer"],
                "charge": txn["charge"],
                "payout": payout_id,
            },
        ).first()
        if stored is None:
            # A transaction ID never moves between accounts, modes or types.
            raise ConnectBalanceError("provider_mismatch")


class StripeConnectBalances(ExternalConnectorLifecycleStore):
    """Snapshot refresh and payout itemisation for document-owner accounts."""

    def __init__(self, db: Any | None = None, *, stripe_api: Any = None) -> None:
        super().__init__(db)
        self.stripe_api = stripe_api or stripe
        self.mode = configured_connect_mode()
        self.livemode = self.mode == "live"

    def _key(self) -> str:
        try:
            key, mode = connect_config()
        except ValueError:
            raise ConnectBalanceError("balance_unavailable") from None
        if mode != self.mode:
            raise ConnectBalanceError("balance_unavailable")
        return key

    async def _provider(
        self, deadline: float, method: Callable[..., Any], /, **kwargs: Any
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        remaining = deadline - loop.time()
        if remaining < _MIN_PROVIDER_SECONDS:
            raise ConnectBalanceError("provider_unavailable")
        try:
            raw = await asyncio.wait_for(
                loop.run_in_executor(_PROVIDER_POOL, functools.partial(method, **kwargs)),
                timeout=min(PROVIDER_TIMEOUT_SECONDS, remaining),
            )
        except Exception:
            raise ConnectBalanceError("provider_unavailable") from None
        return _as_dict(raw)

    def _options(self, *, account_id: str, key: str) -> dict[str, Any]:
        return {"stripe_account": account_id, "api_key": key, "max_network_retries": 0}

    async def _read_balance(
        self, *, account_id: str, key: str, deadline: float
    ) -> tuple[dict[str, int], list[dict[str, Any]]]:
        options = self._options(account_id=account_id, key=key)
        listing = {
            "limit": PAGE_SIZE,
            "created": {"gte": int(time.time() - HISTORY_WINDOW.total_seconds())},
            "expand": ["data.source"],
            **options,
        }
        try:
            async with asyncio.TaskGroup() as group:
                balance_read = group.create_task(
                    self._provider(deadline, self.stripe_api.Balance.retrieve, **options)
                )
                first_page = group.create_task(
                    self._provider(deadline, self.stripe_api.BalanceTransaction.list, **listing)
                )
        except ExceptionGroup as failure:
            codes = [exc.code for exc in failure.exceptions if isinstance(exc, ConnectBalanceError)]
            raise ConnectBalanceError(codes[0] if codes else "provider_unavailable") from None
        balance = _balance_fields(balance_read.result(), livemode=self.livemode)
        transactions: list[dict[str, Any]] = []
        seen: set[str] = set()
        page = first_page.result()
        cursor: str | None = None
        for number in range(MAX_PAGES_PER_RUN):
            if number:
                page = await self._provider(
                    deadline,
                    self.stripe_api.BalanceTransaction.list,
                    starting_after=cursor,
                    **listing,
                )
            items, has_more = _page_items(page)
            for item in items:
                txn = _transaction_fields(item, livemode=self.livemode)
                item_id = item.get("id")
                if item_id in seen:
                    raise ConnectBalanceError("provider_mismatch")
                seen.add(item_id)
                if txn is not None:
                    transactions.append(txn)
            if not has_more:
                break
            cursor = items[-1]["id"]
        return balance, transactions

    def _store_refresh(
        self,
        connection: Any,
        *,
        account_id: str,
        started: datetime,
        balance: dict[str, int],
        transactions: list[dict[str, Any]],
    ) -> str:
        params = {"account": account_id, "livemode": self.livemode}
        current = connection.execute(text(_LOCK_SNAPSHOT), params).mappings().first()
        if current is None or current["refresh_started_at"] != started:
            return "superseded"
        _upsert_transactions(
            connection, transactions, account_id=account_id, livemode=self.livemode, payout_id=None
        )
        next_on, next_cents = _next_available(transactions)
        connection.execute(
            text(_STORE_SNAPSHOT),
            {
                **params,
                "available": balance["available"],
                "pending": balance["pending"],
                "next_on": next_on,
                "next_cents": next_cents,
                "started": started,
            },
        )
        before = (
            current["available_cents"],
            current["pending_cents"],
            current["next_available_on"],
            current["next_available_cents"],
        )
        changed = current["fetched_at"] is None or before != (
            balance["available"],
            balance["pending"],
            next_on,
            next_cents,
        )
        if changed:
            _notify_owner(connection, account_id=account_id, mode=self.mode, kinds=("balance",))
        return "changed" if changed else "unchanged"

    async def _refresh_claimed(
        self,
        *,
        account_id: str,
        started: datetime,
        key: str,
        deadline: float,
        release_on_failure: bool = False,
    ) -> str:
        try:
            balance, transactions = await self._read_balance(
                account_id=account_id, key=key, deadline=deadline
            )
        except ConnectBalanceError:
            # With a snapshot to serve, the held lease backs retries off for a
            # minute. Without one, the next request may try again at once.
            if release_on_failure:
                await self._transaction(
                    lambda c: c.execute(
                        text(_RELEASE_REFRESH), {"account": account_id, "started": started}
                    )
                )
            raise
        return await self._transaction(
            lambda c: self._store_refresh(
                c,
                account_id=account_id,
                started=started,
                balance=balance,
                transactions=transactions,
            )
        )

    async def refresh_account(
        self, *, account_id: str, budget_seconds: float = _INLINE_PROVIDER_SECONDS
    ) -> str:
        """Refresh one mapped account under the single-flight lease.

        Returns "changed", "unchanged", "busy" (another refresh holds the lease)
        or "superseded". A provider failure raises and keeps the old snapshot.
        """
        if not isinstance(account_id, str) or not _ACCOUNT_ID.fullmatch(account_id):
            raise ConnectBalanceError("invalid_account")
        deadline = asyncio.get_running_loop().time() + budget_seconds
        key = self._key()
        claim = await self._transaction(
            lambda c: (
                c.execute(
                    text(_CLAIM_REFRESH),
                    {"account": account_id, "livemode": self.livemode, "mode": self.mode},
                )
                .mappings()
                .first()
            )
        )
        if claim is None:
            return "busy"
        return await self._refresh_claimed(
            account_id=account_id,
            started=claim["refresh_started_at"],
            key=key,
            deadline=deadline,
            release_on_failure=claim["fetched_at"] is None,
        )

    # --- Owner read (GET /account/balance) -----------------------------------

    def _owner_state(self, connection: Any, *, user_id: str) -> dict[str, Any] | None:
        row = (
            connection.execute(
                text(_OWNER_STATE),
                {"owner": user_id, "mode": self.mode, "livemode": self.livemode},
            )
            .mappings()
            .first()
        )
        return dict(row) if row is not None else None

    def _unlinked(self) -> dict[str, Any]:
        return {
            "stripeMode": self.mode,
            "currency": "USD",
            "accountLinked": False,
            "inStripeCents": 0,
            "availableCents": 0,
            "pendingCents": 0,
            "nextAvailableOn": None,
            "nextAvailableCents": None,
            "asOf": datetime.now(UTC).isoformat(),
            "stale": False,
        }

    def _projection(self, state: dict[str, Any]) -> dict[str, Any]:
        available = int(state["available_cents"])
        pending = int(state["pending_cents"] or 0)
        next_cents = state["next_available_cents"]
        return {
            "stripeMode": self.mode,
            "currency": "USD",
            "accountLinked": True,
            "inStripeCents": available + pending,
            "availableCents": available,
            "pendingCents": pending,
            "nextAvailableOn": _iso(state["next_available_on"]),
            "nextAvailableCents": int(next_cents) if next_cents is not None else None,
            "asOf": _iso(state["fetched_at"]),
            "stale": _needs_refresh(state),
        }

    async def _inline_refresh(self, account_id: str) -> str:
        try:
            async with asyncio.timeout(INLINE_REFRESH_SECONDS):
                return await self.refresh_account(
                    account_id=account_id, budget_seconds=_INLINE_PROVIDER_SECONDS
                )
        except (TimeoutError, ConnectBalanceError, ConnectorLifecycleError) as exc:
            logger.info(
                "connect_balance.inline_deferred code=%s",
                getattr(exc, "code", type(exc).__name__),
            )
            return "failed"

    async def owner_balance(self, *, user_id: str) -> dict[str, Any]:
        """The owner's "In Stripe" figure from the snapshot, refreshed if needed."""
        if not isinstance(user_id, str) or not user_id or len(user_id) > 128:
            raise ConnectBalanceError("invalid_owner")

        def read(connection: Any) -> dict[str, Any] | None:
            return self._owner_state(connection, user_id=user_id)

        state = await self._transaction(read)
        if state is None:
            return self._unlinked()
        if _needs_refresh(state):
            loop = asyncio.get_running_loop()
            deadline = loop.time() + INLINE_REFRESH_SECONDS
            outcome = await self._inline_refresh(state["stripe_account_id"])
            state = await self._transaction(read)
            # Single flight: wait briefly for another request's first snapshot.
            while (
                outcome == "busy"
                and state is not None
                and state["fetched_at"] is None
                and loop.time() + _POLL_SECONDS < deadline
            ):
                await asyncio.sleep(_POLL_SECONDS)
                state = await self._transaction(read)
            if state is None:
                return self._unlinked()
        if state["fetched_at"] is None or state["available_cents"] is None:
            raise ConnectBalanceError("balance_unavailable")
        return self._projection(state)

    # --- Worker ----------------------------------------------------------------

    def _discover(self, connection: Any) -> int:
        rows = (
            connection.execute(
                text(_DISCOVER_RECONCILIATIONS), {"mode": self.mode, "livemode": self.livemode}
            )
            .mappings()
            .all()
        )
        for row in rows:
            if row["status"] == "not_applicable":
                _notify_owner(
                    connection,
                    account_id=row["stripe_account_id"],
                    mode=self.mode,
                    kinds=("bank_payouts",),
                )
        return len(rows)

    def _store_reconciliation_page(
        self,
        connection: Any,
        *,
        payout_id: str,
        account_id: str,
        started: datetime,
        transactions: list[dict[str, Any]],
        next_cursor: str | None,
    ) -> str:
        current = (
            connection.execute(
                text(_LOCK_RECONCILIATION), {"payout": payout_id, "account": account_id}
            )
            .mappings()
            .first()
        )
        if (
            current is None
            or current["status"] != "in_progress"
            or current["scan_started_at"] != started
        ):
            return "superseded"
        _upsert_transactions(
            connection,
            transactions,
            account_id=account_id,
            livemode=self.livemode,
            payout_id=payout_id,
        )
        if next_cursor is not None:
            connection.execute(
                text(_ADVANCE_RECONCILIATION),
                {"cursor": next_cursor, "payout": payout_id, "started": started},
            )
            return "partial"
        self._finish(
            connection,
            payout_id=payout_id,
            account_id=account_id,
            started=started,
            status="complete",
        )
        return "complete"

    def _finish(
        self, connection: Any, *, payout_id: str, account_id: str, started: datetime, status: str
    ) -> None:
        finished = connection.execute(
            text(_FINISH_RECONCILIATION),
            {"status": status, "payout": payout_id, "account": account_id, "started": started},
        )
        if finished.rowcount == 1:
            _notify_owner(
                connection, account_id=account_id, mode=self.mode, kinds=("bank_payouts",)
            )

    async def _reconcile_claimed(self, claim: dict[str, Any], *, key: str, deadline: float) -> str:
        payout_id = claim["stripe_payout_id"]
        account_id = claim["stripe_account_id"]
        cursor = claim["cursor"]
        started = claim["scan_started_at"]
        if (
            not _PAYOUT_ID.fullmatch(payout_id)
            or not _ACCOUNT_ID.fullmatch(account_id)
            or (cursor is not None and not _TXN_ID.fullmatch(cursor))
        ):
            raise ConnectBalanceError("provider_mismatch")
        if claim["automatic"] is False or claim["reconciliation_status"] == "not_applicable":
            await self._transaction(
                lambda c: self._finish(
                    c,
                    payout_id=payout_id,
                    account_id=account_id,
                    started=started,
                    status="not_applicable",
                )
            )
            return "payout_reconciliations_checked"
        if claim["reconciliation_status"] == "in_progress":
            # Stripe has not finished; the lease backs this payout off.
            return "payout_reconciliation_deferred"
        options = {
            "payout": payout_id,
            "limit": PAGE_SIZE,
            "expand": ["data.source"],
            **self._options(account_id=account_id, key=key),
        }
        seen: set[str] = set()
        result = "superseded"
        for _ in range(MAX_PAGES_PER_RUN):
            try:
                page = await self._provider(
                    deadline,
                    self.stripe_api.BalanceTransaction.list,
                    **({**options, "starting_after": cursor} if cursor else options),
                )
                items, has_more = _page_items(page)
                transactions = []
                for item in items:
                    txn = _transaction_fields(item, livemode=self.livemode)
                    if item.get("id") in seen:
                        raise ConnectBalanceError("provider_mismatch")
                    seen.add(item.get("id"))
                    if txn is not None:
                        transactions.append(txn)
            except ConnectBalanceError as exc:
                logger.warning("connect_balance.reconcile_deferred code=%s", exc.code)
                return "payout_reconciliation_deferred"
            next_cursor = items[-1]["id"] if has_more else None
            result = await self._transaction(
                lambda c, transactions=transactions, next_cursor=next_cursor: (
                    self._store_reconciliation_page(
                        c,
                        payout_id=payout_id,
                        account_id=account_id,
                        started=started,
                        transactions=transactions,
                        next_cursor=next_cursor,
                    )
                )
            )
            if result != "partial":
                break
            cursor = next_cursor
        if result == "partial":
            await self._transaction(
                lambda c: c.execute(
                    text(_RELEASE_RECONCILIATION), {"payout": payout_id, "started": started}
                )
            )
        return {
            "complete": "payout_reconciliations_completed",
            "partial": "payout_reconciliations_checked",
        }.get(result, "payout_reconciliation_deferred")

    async def run_due(
        self,
        *,
        max_refreshes: int = 2,
        max_reconciliations: int = 1,
        budget_seconds: float = 30.0,
    ) -> dict[str, int]:
        """One bounded worker tick: due balance refreshes, then one itemisation."""
        if (
            type(max_refreshes) is not int
            or not 0 <= max_refreshes <= 2
            or type(max_reconciliations) is not int
            or not 0 <= max_reconciliations <= 1
            or isinstance(budget_seconds, bool)
            or not isinstance(budget_seconds, int | float)
        ):
            raise ValueError("invalid connect balance bounds")
        key = self._key()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.0, float(budget_seconds))
        outcomes: Counter[str] = Counter()
        try:
            await self._refresh_due(outcomes, count=max_refreshes, key=key, deadline=deadline)
        except (ConnectBalanceError, ConnectorLifecycleError) as exc:
            logger.warning(
                "connect_balance.refresh_deferred code=%s", getattr(exc, "code", "storage")
            )
            outcomes["balance_refresh_deferred"] += 1
        try:
            await self._reconcile_due(
                outcomes, count=max_reconciliations, key=key, deadline=deadline
            )
        except (ConnectBalanceError, ConnectorLifecycleError) as exc:
            logger.warning(
                "connect_balance.reconcile_deferred code=%s", getattr(exc, "code", "storage")
            )
            outcomes["payout_reconciliation_deferred"] += 1
        return dict(outcomes)

    async def _refresh_due(
        self, outcomes: Counter[str], *, count: int, key: str, deadline: float
    ) -> None:
        loop = asyncio.get_running_loop()
        params = {"mode": self.mode, "livemode": self.livemode}
        for _ in range(count):
            if deadline - loop.time() < _MIN_RUN_SECONDS:
                return
            claim = await self._transaction(
                lambda c: c.execute(text(_CLAIM_DUE_REFRESH), params).mappings().first()
            )
            if claim is None:
                return
            result = await self._refresh_claimed(
                account_id=claim["stripe_account_id"],
                started=claim["refresh_started_at"],
                key=key,
                deadline=deadline,
            )
            outcomes["balance_accounts_checked"] += 1
            if result == "changed":
                outcomes["balance_snapshots_changed"] += 1

    async def _reconcile_due(
        self, outcomes: Counter[str], *, count: int, key: str, deadline: float
    ) -> None:
        loop = asyncio.get_running_loop()
        if not count or deadline - loop.time() < _MIN_RUN_SECONDS:
            return
        queued = await self._transaction(self._discover)
        if queued:
            outcomes["payout_reconciliations_queued"] += queued
        params = {"mode": self.mode, "livemode": self.livemode}
        for _ in range(count):
            if deadline - loop.time() < _MIN_RUN_SECONDS:
                return
            claim = await self._transaction(
                lambda c: c.execute(text(_CLAIM_RECONCILIATION), params).mappings().first()
            )
            if claim is None:
                return
            outcomes[await self._reconcile_claimed(dict(claim), key=key, deadline=deadline)] += 1
