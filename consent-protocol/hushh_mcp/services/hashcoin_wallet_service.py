"""Integer earnings ledger with isolated, non-cash sandbox redemption.

One Hashcoin is one USD cent. Live credits are financial liabilities; test
credits merely demonstrate payout UX and can never consume a live balance.
All mutations serialize on a wallet row, with immutable source references.
"""

from __future__ import annotations

import json
import os
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore


class HashcoinError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def hashcoins_enabled() -> bool:
    return (os.getenv("DRIVE_REQUEST_HASHCOINS_ENABLED") or "").strip().lower() == "true"


def _mode(mode: str) -> str:
    if mode not in {"live", "test"}:
        raise HashcoinError("invalid_mode")
    return mode


def _amount(value: int) -> int:
    if type(value) is not int or not 1 <= value <= 50000:
        raise HashcoinError("invalid_amount")
    return value


def _uuid(value: str) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise HashcoinError("invalid_request") from None


class HashcoinWalletService(ExternalConnectorLifecycleStore):
    @staticmethod
    def ensure_wallet(connection, *, user_id: str, stripe_mode: str) -> str:
        if not user_id:
            raise HashcoinError("invalid_owner")
        mode = _mode(stripe_mode)
        connection.execute(
            text("""INSERT INTO hashcoin_wallets(wallet_id,user_id,stripe_mode)
              VALUES (:wallet,:owner,:mode) ON CONFLICT (user_id,stripe_mode) DO NOTHING"""),
            {"wallet": str(uuid4()), "owner": user_id, "mode": mode},
        )
        return str(
            connection.execute(
                text(
                    "SELECT wallet_id FROM hashcoin_wallets WHERE user_id=:owner AND stripe_mode=:mode"
                ),
                {"owner": user_id, "mode": mode},
            ).scalar_one()
        )

    @staticmethod
    def _notify(connection, wallet: dict) -> None:
        if wallet.get("user_id"):
            connection.execute(
                text("SELECT pg_notify('one_user_state_changed',:payload)"),
                {
                    "payload": json.dumps(
                        {
                            "type": "document_share_feed_changed",
                            "event_id": str(uuid4()),
                            "user_id": wallet["user_id"],
                        }
                    ),
                },
            )

    @classmethod
    def _post(cls, connection, *, wallet_id: str, kind: str, source: str, amount: int) -> bool:
        wallet = cls._row(
            connection,
            "SELECT * FROM hashcoin_wallets WHERE wallet_id=:wallet FOR UPDATE",
            {"wallet": wallet_id},
        )
        if wallet is None:
            raise HashcoinError("wallet_unavailable")
        inserted = (
            connection.execute(
                text("""INSERT INTO hashcoin_ledger_entries
          (entry_id,wallet_id,entry_kind,source_ref,amount_coins)
          VALUES (:entry,:wallet,:kind,:source,:amount)
          ON CONFLICT (wallet_id,entry_kind,source_ref) DO NOTHING"""),
                {
                    "entry": str(uuid4()),
                    "wallet": wallet_id,
                    "kind": kind,
                    "source": source,
                    "amount": amount,
                },
            ).rowcount
            == 1
        )
        saved = connection.execute(
            text("""SELECT amount_coins FROM hashcoin_ledger_entries
          WHERE wallet_id=:wallet AND entry_kind=:kind AND source_ref=:source"""),
            {"wallet": wallet_id, "kind": kind, "source": source},
        ).scalar_one()
        if saved != amount:
            raise HashcoinError("ledger_source_mismatch")
        if inserted:
            cls._notify(connection, wallet)
        return inserted

    @classmethod
    def credit_earning(cls, connection, *, request_id: str) -> bool:
        """Called after actual-fee settlement, in that exact DB transaction."""
        payout = cls._row(
            connection,
            """SELECT * FROM drive_request_owner_payouts
          WHERE request_id=:request FOR UPDATE""",
            {"request": _uuid(request_id)},
        )
        if (
            payout is None
            or payout["settlement_method"] != "hashcoins"
            or payout["status"] != "hashcoins_credited"
            or payout["wallet_id"] is None
            or payout["owner_earning_cents"] is None
            or payout["owner_earning_cents"] <= 0
            or payout["actual_processing_fee_cents"] is None
            or payout["finalized_at"] is None
            or payout["stripe_transfer_id"] is not None
        ):
            raise HashcoinError("earning_not_settled")
        amount = _amount(payout["owner_earning_cents"])
        inserted = cls._post(
            connection,
            wallet_id=str(payout["wallet_id"]),
            kind="earning",
            source=request_id,
            amount=amount,
        )
        if payout["stripe_mode"] == "live" and payout["sandbox_wallet_id"] is not None:
            cls._post(
                connection,
                wallet_id=str(payout["sandbox_wallet_id"]),
                kind="sandbox_earning",
                source=request_id,
                amount=amount,
            )
        return inserted

    @classmethod
    def reverse_earning(cls, connection, *, request_id: str) -> bool:
        payout = cls._row(
            connection,
            """SELECT * FROM drive_request_owner_payouts
          WHERE request_id=:request FOR UPDATE""",
            {"request": _uuid(request_id)},
        )
        if (
            payout is None
            or payout["settlement_method"] != "hashcoins"
            or payout["status"]
            not in {"hashcoins_credited", "hashcoins_held", "hashcoins_reversed"}
            or payout["wallet_id"] is None
            or not payout["owner_earning_cents"]
        ):
            return False
        inserted = cls._post(
            connection,
            wallet_id=str(payout["wallet_id"]),
            kind="reversal",
            source=request_id,
            amount=-payout["owner_earning_cents"],
        )
        if payout["stripe_mode"] == "live" and payout["sandbox_wallet_id"] is not None:
            cls._post(
                connection,
                wallet_id=str(payout["sandbox_wallet_id"]),
                kind="sandbox_reversal",
                source=request_id,
                amount=-payout["owner_earning_cents"],
            )
        connection.execute(
            text("""UPDATE drive_request_owner_payouts SET
          status='hashcoins_reversed',reversal_amount_cents=owner_earning_cents,
          safe_error_code='external_debit',updated_at=clock_timestamp()
          WHERE request_id=:request"""),
            {"request": request_id},
        )
        if payout["status"] == "hashcoins_held":
            connection.execute(
                text("""UPDATE hashcoin_wallets w SET held=FALSE
              WHERE w.wallet_id IN (:wallet,:sandbox) AND w.erased_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM drive_request_owner_payouts p
                WHERE p.status='hashcoins_held' AND
                  (p.wallet_id=w.wallet_id OR p.sandbox_wallet_id=w.wallet_id))"""),
                {"wallet": payout["wallet_id"], "sandbox": payout["sandbox_wallet_id"]},
            )
        return inserted

    @staticmethod
    def _balance(connection, wallet: dict | None) -> dict:
        if wallet is None:
            return {
                "balanceCoins": 0,
                "reservedCoins": 0,
                "availableCoins": 0,
                "amountCents": 0,
                "held": False,
            }
        params = {"wallet": wallet["wallet_id"]}
        balance = int(
            connection.execute(
                text("""SELECT COALESCE(sum(amount_coins),0)
          FROM hashcoin_ledger_entries WHERE wallet_id=:wallet"""),
                params,
            ).scalar_one()
        )
        reserved = int(
            connection.execute(
                text("""SELECT COALESCE(sum(amount_coins),0)
          FROM hashcoin_redemptions WHERE wallet_id=:wallet
          AND status IN ('reserved','dispatching','unknown')"""),
                params,
            ).scalar_one()
        )
        return {
            "balanceCoins": balance,
            "reservedCoins": reserved,
            "availableCoins": 0 if wallet["held"] else max(0, balance - reserved),
            "amountCents": balance,
            "held": bool(wallet["held"] or balance < 0),
        }

    async def summary(self, *, user_id: str) -> dict[str, Any]:
        if not user_id:
            raise HashcoinError("invalid_owner")

        def operation(connection):
            rows = (
                connection.execute(
                    text("""SELECT * FROM hashcoin_wallets
              WHERE user_id=:owner ORDER BY stripe_mode FOR SHARE"""),
                    {"owner": user_id},
                )
                .mappings()
                .all()
            )
            wallets = {row["stripe_mode"]: dict(row) for row in rows}
            return {
                "coinName": "Hussh Coins",
                "coinsPerDollar": 100,
                "currency": "USD",
                "live": self._balance(connection, wallets.get("live")),
                "sandbox": self._balance(connection, wallets.get("test")),
                "liveRedemptionEnabled": False,
                "maxRedeemCoins": 50000,
            }

        return await self._transaction(operation)

    @staticmethod
    def _redemption(row: dict | None) -> dict | None:
        if row is None:
            return None
        return {
            "id": str(row["redemption_id"]),
            "status": row["status"],
            "clientRequestId": str(row["request_key"]),
            "amountCoins": row["amount_coins"],
            "stripeMode": row["stripe_mode"],
            "accountId": row["destination_account_id"],
            "stripeTransferId": row["stripe_transfer_id"],
            "firstDispatchAt": row["first_dispatch_at"].isoformat()
            if row["first_dispatch_at"]
            else None,
            "createdAt": row["created_at"].isoformat(),
            "attemptId": str(row["attempt_id"]) if row.get("attempt_id") else None,
        }

    async def get_redemption(self, *, user_id: str, request_key: str) -> dict | None:
        return await self._transaction(
            lambda c: self._redemption(
                self._row(
                    c,
                    """SELECT r.* FROM hashcoin_redemptions r JOIN hashcoin_wallets w USING(wallet_id)
            WHERE w.user_id=:owner AND w.stripe_mode='test' AND r.request_key=:key""",
                    {"owner": user_id, "key": _uuid(request_key)},
                )
            )
        )

    async def list_redemptions(self, *, user_id: str, max_items: int = 10) -> list[dict]:
        if type(max_items) is not int or not 1 <= max_items <= 20:
            raise HashcoinError("invalid_limit")
        return await self._transaction(
            lambda c: [
                self._redemption(dict(row))
                for row in c.execute(
                    text("""SELECT r.* FROM hashcoin_redemptions r
              JOIN hashcoin_wallets w USING(wallet_id) WHERE w.user_id=:owner
              AND w.stripe_mode='test' ORDER BY r.created_at DESC,r.redemption_id DESC LIMIT :limit"""),
                    {"owner": user_id, "limit": max_items},
                )
                .mappings()
                .all()
            ]
        )

    async def list_pending_redemptions(self, *, user_id: str, max_items: int = 10) -> list[dict]:
        if type(max_items) is not int or not 1 <= max_items <= 20:
            raise HashcoinError("invalid_limit")
        return await self._transaction(
            lambda c: [
                self._redemption(dict(row))
                for row in c.execute(
                    text("""SELECT r.* FROM hashcoin_redemptions r
              JOIN hashcoin_wallets w USING(wallet_id) WHERE w.user_id=:owner
              AND w.stripe_mode='test' AND r.status IN ('reserved','dispatching','unknown')
              ORDER BY r.created_at,r.redemption_id LIMIT :limit"""),
                    {"owner": user_id, "limit": max_items},
                )
                .mappings()
                .all()
            ]
        )

    async def list_reconcilable_redemptions(self, *, max_items: int = 10) -> list[dict]:
        if type(max_items) is not int or not 1 <= max_items <= 20:
            raise HashcoinError("invalid_limit")

        def operation(connection):
            rows = (
                connection.execute(
                    text("""SELECT r.*,w.user_id FROM hashcoin_redemptions r
              JOIN hashcoin_wallets w USING(wallet_id) WHERE w.user_id IS NOT NULL
              AND w.stripe_mode='test'
              AND r.status IN ('reserved','dispatching','unknown')
              AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=clock_timestamp())
              AND r.updated_at<clock_timestamp()-interval '1 minute'
              ORDER BY r.updated_at,r.redemption_id LIMIT :limit"""),
                    {"limit": max_items},
                )
                .mappings()
                .all()
            )
            return [{**self._redemption(dict(row)), "userId": row["user_id"]} for row in rows]

        return await self._transaction(operation)

    async def reserve_redemption(
        self,
        *,
        user_id: str,
        amount_coins: int,
        request_key: str,
        destination_account_id: str,
        stripe_mode: str = "test",
    ) -> dict:
        if stripe_mode != "test":
            raise HashcoinError("live_redemption_unavailable")
        if (
            not user_id
            or not isinstance(destination_account_id, str)
            or not destination_account_id.startswith("acct_")
        ):
            raise HashcoinError("invalid_account")
        amount, key = _amount(amount_coins), _uuid(request_key)

        def operation(connection):
            wallet = self._row(
                connection,
                """SELECT * FROM hashcoin_wallets
              WHERE user_id=:owner AND stripe_mode='test' FOR UPDATE""",
                {"owner": user_id},
            )
            if wallet is None:
                raise HashcoinError("insufficient_balance")
            prior = self._row(
                connection,
                """SELECT * FROM hashcoin_redemptions
              WHERE wallet_id=:wallet AND request_key=:key""",
                {"wallet": wallet["wallet_id"], "key": key},
            )
            if prior:
                if (
                    prior["amount_coins"] != amount
                    or prior["destination_account_id"] != destination_account_id
                ):
                    raise HashcoinError("redemption_mismatch")
                return self._redemption(prior)
            if wallet["held"]:
                raise HashcoinError("wallet_held")
            if self._balance(connection, wallet)["availableCoins"] < amount:
                raise HashcoinError("insufficient_balance")
            row = self._row(
                connection,
                """INSERT INTO hashcoin_redemptions
              (redemption_id,wallet_id,request_key,amount_coins,stripe_mode,destination_account_id)
              VALUES (:id,:wallet,:key,:amount,'test',:account) RETURNING *""",
                {
                    "id": str(uuid4()),
                    "wallet": wallet["wallet_id"],
                    "key": key,
                    "amount": amount,
                    "account": destination_account_id,
                },
            )
            self._notify(connection, wallet)
            return self._redemption(row)

        return await self._transaction(operation)

    async def claim_redemption(self, *, user_id: str, redemption_id: str) -> dict | None:
        def operation(connection):
            row = self._row(
                connection,
                """SELECT r.*,w.held,w.user_id FROM hashcoin_redemptions r
              JOIN hashcoin_wallets w USING(wallet_id) WHERE r.redemption_id=:id
              AND w.user_id=:owner AND w.stripe_mode='test'
              FOR UPDATE OF w,r""",
                {"id": _uuid(redemption_id), "owner": user_id},
            )
            if row is None or row["status"] in {"succeeded", "failed"}:
                return None
            balance = self._balance(connection, row)
            create_allowed = (
                not balance["held"] and balance["balanceCoins"] >= balance["reservedCoins"]
            )
            if row["first_dispatch_at"] is None and not create_allowed:
                connection.execute(
                    text("""UPDATE hashcoin_redemptions SET status='failed',
                  updated_at=clock_timestamp() WHERE redemption_id=:id AND first_dispatch_at IS NULL"""),
                    {"id": redemption_id},
                )
                self._notify(connection, row)
                return None
            previous_status = row["status"]
            row = self._row(
                connection,
                """UPDATE hashcoin_redemptions SET status='dispatching',
              first_dispatch_at=COALESCE(first_dispatch_at,clock_timestamp()),
              lease_expires_at=clock_timestamp()+interval '2 minutes',attempt_id=:attempt,
              updated_at=clock_timestamp() WHERE redemption_id=:id
              AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *""",
                {"id": redemption_id, "attempt": str(uuid4())},
            )
            result = self._redemption(row)
            if result is not None:
                result["previousStatus"] = previous_status
                result["createAllowed"] = create_allowed
            return result

        return await self._transaction(operation)

    async def finish_redemption(
        self,
        *,
        redemption_id: str,
        outcome: str,
        stripe_transfer_id: str | None = None,
        attempt_id: str | None = None,
    ) -> dict:
        if outcome not in {"succeeded", "failed", "unknown"}:
            raise HashcoinError("invalid_outcome")
        if outcome == "succeeded" and (
            not isinstance(stripe_transfer_id, str) or not stripe_transfer_id.startswith("tr_")
        ):
            raise HashcoinError("invalid_transfer")

        def operation(connection):
            row = self._row(
                connection,
                """SELECT r.*,w.user_id,w.held
              FROM hashcoin_redemptions r JOIN hashcoin_wallets w USING(wallet_id)
              WHERE r.redemption_id=:id FOR UPDATE OF w,r""",
                {"id": _uuid(redemption_id)},
            )
            if row is None:
                raise HashcoinError("redemption_unavailable")
            if row["status"] == "succeeded":
                if outcome != "succeeded" or stripe_transfer_id != row["stripe_transfer_id"]:
                    raise HashcoinError("redemption_mismatch")
                return self._redemption(row)
            if row["status"] == "failed":
                if outcome != "failed":
                    raise HashcoinError("redemption_mismatch")
                return self._redemption(row)
            if row["status"] != "reserved" and attempt_id is None:
                raise HashcoinError("redemption_lease_lost")
            if attempt_id is not None and str(row["attempt_id"]) != _uuid(attempt_id):
                raise HashcoinError("redemption_lease_lost")
            if outcome == "succeeded" and row["status"] == "reserved":
                raise HashcoinError("redemption_not_dispatched")
            if outcome == "succeeded":
                self._post(
                    connection,
                    wallet_id=str(row["wallet_id"]),
                    kind="redemption",
                    source=redemption_id,
                    amount=-row["amount_coins"],
                )
            saved = self._row(
                connection,
                """UPDATE hashcoin_redemptions SET status=:outcome,
              stripe_transfer_id=:transfer,lease_expires_at=NULL,updated_at=clock_timestamp()
              WHERE redemption_id=:id RETURNING *""",
                {
                    "id": redemption_id,
                    "outcome": outcome,
                    "transfer": stripe_transfer_id if outcome == "succeeded" else None,
                },
            )
            self._notify(connection, row)
            return self._redemption(saved)

        return await self._transaction(operation)
