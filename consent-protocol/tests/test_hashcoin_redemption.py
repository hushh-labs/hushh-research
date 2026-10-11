"""Sandbox transfers never discharge live earned-money liabilities."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest

from hushh_mcp.services.hashcoin_redemption_service import (
    HashcoinRedemptionError,
    HashcoinRedemptionService,
)
from hushh_mcp.services.stripe_mode import configured_stripe_mode, connect_config


class Wallet:
    def __init__(self):
        self.live, self.test, self.row, self.debits = 911, 911, None, 0

    async def summary(self, **_):
        return {"live": {"balanceCoins": self.live}, "sandbox": {"balanceCoins": self.test}}

    async def list_pending_redemptions(self, **_):
        return [self.row] if self.row and self.row["status"] not in {"succeeded", "failed"} else []

    async def list_redemptions(self, **_):
        return [self.row] if self.row else []

    async def get_redemption(self, **_):
        return self.row

    async def reserve_redemption(self, **kw):
        assert kw["stripe_mode"] == "test"
        self.row = dict(
            id=str(uuid4()),
            clientRequestId=kw["request_key"],
            status="reserved",
            amountCoins=kw["amount_coins"],
            stripeMode="test",
            accountId=kw["destination_account_id"],
            firstDispatchAt=None,
            stripeTransferId=None,
        )
        return self.row.copy()

    async def claim_redemption(self, **_):
        if self.row["status"] in {"succeeded", "failed"}:
            return None
        previous = self.row["status"]
        self.row.update(status="dispatching", attemptId=str(uuid4()))
        self.row["firstDispatchAt"] = self.row["firstDispatchAt"] or datetime.now(UTC).isoformat()
        return {**self.row, "previousStatus": previous, "createAllowed": True}

    async def finish_redemption(self, **kw):
        assert kw["attempt_id"] == self.row["attemptId"]
        self.row.update(status=kw["outcome"], stripeTransferId=kw["stripe_transfer_id"])
        if kw["outcome"] == "succeeded":
            self.test -= self.row["amountCoins"]
            self.debits += 1
        return self.row.copy()


class Provider:
    def __init__(self):
        self.created, self.remote, self.timeout, self.funds, self.wrong_mode = (
            [],
            [],
            False,
            10000,
            False,
        )
        owner = self

        class Transfer:
            @staticmethod
            def list(**kw):
                assert kw["api_key"].startswith("sk_test_")
                return {"data": owner.remote, "has_more": False}

            @staticmethod
            def create(**kw):
                assert kw["api_key"].startswith("sk_test_") and "source_transaction" not in kw
                owner.created.append(kw)
                remote = {
                    "id": "tr_test_redemption",
                    "livemode": owner.wrong_mode,
                    "reversed": False,
                    **kw,
                }
                owner.remote.append(remote)
                if owner.timeout:
                    raise TimeoutError("accepted response lost")
                return remote

        class Balance:
            @staticmethod
            def retrieve(**kw):
                assert kw["api_key"].startswith("sk_test_")
                return {
                    "livemode": False,
                    "available": [{"currency": "usd", "amount": owner.funds}],
                }

        class Account:
            @staticmethod
            def retrieve(account_id, **kw):
                return {
                    "id": account_id,
                    "country": "US",
                    "details_submitted": True,
                    "payouts_enabled": True,
                    "capabilities": {"transfers": "active"},
                    "external_accounts": {
                        "has_more": False,
                        "data": [
                            {
                                "object": "bank_account",
                                "country": "US",
                                "currency": "usd",
                                "default_for_currency": True,
                                "status": "new",
                            }
                        ],
                    },
                }

        self.Transfer, self.Balance, self.Account = Transfer, Balance, Account


@pytest.fixture
def world(monkeypatch):
    for name in ("ENVIRONMENT", "HUSHH_DEPLOY_ENV", "HUSSH_DEPLOY_ENV"):
        monkeypatch.setenv(name, "uat")
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "l" * 30)
    monkeypatch.setenv("STRIPE_CONNECT_MODE", "test")
    monkeypatch.setenv("STRIPE_CONNECT_SECRET_KEY", "sk_test_" + "t" * 30)
    wallet, provider = Wallet(), Provider()

    async def account(_):
        return {"stripe_account_id": "acct_test_owner", "readiness": {"ready": True}}

    return (
        HashcoinRedemptionService(
            wallet=wallet, stripe_api=provider, accounts=SimpleNamespace(refresh_account=account)
        ),
        wallet,
        provider,
    )


def request(amount=911):
    return dict(user_id="owner", amount_coins=amount, client_request_id=str(uuid4()), mode="test")


async def test_live_earnings_survive_idempotent_sandbox_redemption(world):
    svc, wallet, provider = world
    args = request()
    first = await svc.redeem(**args)
    assert await svc.redeem(**args) == first and first["status"] == "succeeded"
    assert "reversalStatus" not in first
    assert (
        wallet.live == 911
        and wallet.test == 0
        and wallet.debits == 1
        and len(provider.created) == 1
    )
    assert configured_stripe_mode() == "live" and connect_config()[1] == "test"


async def test_lost_response_reconciles_exact_transfer_without_recreating(world):
    svc, wallet, provider = world
    provider.timeout = True
    args = request()
    assert (await svc.redeem(**args))["status"] == "unknown"
    assert wallet.test == 911 and wallet.live == 911
    assert (await svc.summary(user_id="owner"))["latestRedemption"]["clientRequestId"] == args[
        "client_request_id"
    ]
    assert (await svc.redeem(**args))["status"] == "succeeded"
    assert len(provider.created) == 1 and wallet.debits == 1 and wallet.live == 911


async def test_old_unknown_never_recreates_outside_idempotency_window(world):
    svc, wallet, provider = world
    args = request()
    await wallet.reserve_redemption(
        request_key=args["client_request_id"],
        amount_coins=911,
        stripe_mode="test",
        destination_account_id="acct_test_owner",
    )
    wallet.row.update(
        status="unknown", firstDispatchAt=(datetime.now(UTC) - timedelta(hours=25)).isoformat()
    )
    assert (await svc.redeem(**args))["status"] == "unknown"
    assert provider.created == [] and wallet.debits == 0


async def test_live_redemption_and_wrong_keys_rejected_before_reservation(world, monkeypatch):
    svc, wallet, provider = world
    args = request()
    args["mode"] = "live"
    with pytest.raises(HashcoinRedemptionError, match="Real bank"):
        await svc.redeem(**args)
    monkeypatch.setenv("STRIPE_CONNECT_SECRET_KEY", "sk_live_" + "l" * 30)
    with pytest.raises(HashcoinRedemptionError, match="unavailable"):
        await svc.redeem(**request())
    assert wallet.row is None and provider.created == []


async def test_insufficient_provider_test_funds_never_reserves(world):
    svc, wallet, provider = world
    provider.funds = 100
    with pytest.raises(HashcoinRedemptionError) as failed:
        await svc.redeem(**request())
    assert failed.value.code == "SANDBOX_FUNDS_UNAVAILABLE" and wallet.row is None


async def test_provider_wrong_mode_preserves_reservation(world):
    svc, wallet, provider = world
    provider.wrong_mode = True
    assert (await svc.redeem(**request()))["status"] == "unknown"
    assert wallet.debits == 0 and wallet.live == 911


async def test_replay_changed_amount_cannot_double_spend(world):
    svc, wallet, provider = world
    args = request()
    await svc.redeem(**args)
    args["amount_coins"] = 910
    with pytest.raises(HashcoinRedemptionError) as failed:
        await svc.redeem(**args)
    assert failed.value.code == "REDEMPTION_CONFLICT" and len(provider.created) == 1


async def test_removed_bank_blocks_new_dispatch_but_retains_uncertain_coins(world):
    svc, wallet, provider = world
    provider.Account.retrieve = lambda account_id, **_: {
        "id": account_id,
        "country": "US",
        "payouts_enabled": False,
    }
    result = await svc.redeem(**request())
    assert result["status"] == "unknown"
    assert provider.created == [] and wallet.debits == 0 and wallet.live == 911


async def test_worker_recovers_without_requester_returning(world):
    svc, wallet, provider = world
    provider.timeout = True
    await svc.redeem(**request())

    async def due(**_):
        return [{**wallet.row, "userId": "owner"}]

    wallet.list_reconcilable_redemptions = due
    assert await svc.reconcile_due(max_items=1) == {"succeeded": 1}
    assert wallet.live == 911 and wallet.test == 0 and len(provider.created) == 1
    assert (await svc.summary(user_id="owner"))["redemptionHistory"][0]["status"] == "succeeded"


@pytest.fixture
def live_world(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_CONNECT_MODE", "live")
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED", "true")
    key = "sk_live_" + "l" * 30
    monkeypatch.setenv("STRIPE_SECRET_KEY", key)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_" + "p" * 25)
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect_" + "c" * 25)
    monkeypatch.delenv("STRIPE_CONNECT_SECRET_KEY", raising=False)

    class LiveWallet:
        row = None
        debits = 0
        held = False

        async def get_redemption(self, **kw):
            if self.row and self.row["clientRequestId"] == kw["request_key"]:
                return self.row
            return None

        async def reserve_redemption(self, **kw):
            assert kw["stripe_mode"] == "live" and kw["amount_coins"] == 911
            self.row = {
                "id": str(uuid4()),
                "clientRequestId": kw["request_key"],
                "status": "reserved",
                "amountCoins": 911,
                "stripeMode": "live",
                "accountId": "acct_live_owner",
                "sourceRequestId": "00000000-0000-0000-0000-000000000001",
                "sourceChargeId": "ch_earned",
                "sourcePaymentIntentId": "pi_earned",
                "sourceGrossCents": 1000,
                "sourceRefundCents": 0,
                "firstDispatchAt": None,
                "stripeTransferId": None,
                "reversalStatus": "none",
                "createdAt": datetime.now(UTC).isoformat(),
            }
            return self.row.copy()

        async def claim_redemption(self, **_):
            if self.row["status"] in {"succeeded", "failed"}:
                return None
            previous = self.row["status"]
            self.row["status"] = "dispatching"
            self.row["attemptId"] = str(uuid4())
            self.row["firstDispatchAt"] = (
                self.row["firstDispatchAt"] or datetime.now(UTC).isoformat()
            )
            return {**self.row, "previousStatus": previous, "createAllowed": True}

        async def finish_redemption(self, **kw):
            assert kw["attempt_id"] == self.row["attemptId"]
            if kw["outcome"] == "succeeded":
                self.debits += 1
            self.row.update(status=kw["outcome"], stripeTransferId=kw["stripe_transfer_id"])
            return self.row.copy()

        async def create_live_transfer_fenced(self, *, redemption, create):
            assert redemption["id"] == self.row["id"]
            return create()

        async def list_live_completed_for_review(self, **_):
            return [self.row.copy()] if self.row and self.row["status"] == "succeeded" else []

        async def record_live_transfer_check(self, **kw):
            assert kw["stripe_transfer_id"] == self.row["stripeTransferId"]
            self.held = kw["review_reason"] is not None

        async def list_due_live_reversals(self, **_):
            return (
                [self.row.copy()]
                if self.row and self.row["reversalStatus"] in {"due", "unknown"}
                else []
            )

        async def claim_live_reversal(self, **kw):
            if self.row["id"] != kw["redemption_id"]:
                return None
            self.row["reversalStatus"] = "unknown"
            self.row.setdefault("reversalAttemptId", str(uuid4()))
            self.row.setdefault("reversalFirstDispatchAt", datetime.now(UTC).isoformat())
            self.held = True
            return self.row.copy()

        async def finish_live_reversal(self, **kw):
            assert kw["attempt_id"] == self.row["reversalAttemptId"]
            self.row["reversalStatus"] = kw["outcome"]
            self.row["stripeReversalId"] = kw["stripe_reversal_id"]
            return self.row.copy()

    class LiveProvider:
        def __init__(self):
            self.remote = []
            self.created = []
            self.timeout = False
            self.decline = False
            self.reversals = []
            self.reversal_timeout = False
            owner = self

            class Transfer:
                @staticmethod
                def list(**kw):
                    assert kw["api_key"] == key
                    assert kw["limit"] == 100 and "destination" not in kw
                    return {"data": owner.remote, "has_more": False}

                @staticmethod
                def create(**kw):
                    assert kw["api_key"] == key
                    owner.created.append(kw)
                    if owner.decline:
                        import stripe

                        raise stripe.InvalidRequestError(
                            "Insufficient funds", param=None, code="balance_insufficient"
                        )
                    remote = {
                        "id": "tr_live_earned",
                        "livemode": True,
                        "reversed": False,
                        "amount_reversed": 0,
                        **kw,
                    }
                    owner.remote.append(remote)
                    if owner.timeout:
                        raise TimeoutError("accepted response lost")
                    return remote

                @staticmethod
                def retrieve(transfer_id, **kw):
                    assert transfer_id == "tr_live_earned" and kw["api_key"] == key
                    return owner.remote[0]

                @staticmethod
                def list_reversals(transfer_id, **kw):
                    assert transfer_id == "tr_live_earned" and kw["api_key"] == key
                    return {"data": owner.reversals, "has_more": False}

                @staticmethod
                def create_reversal(transfer_id, **kw):
                    assert transfer_id == "tr_live_earned" and kw["api_key"] == key
                    reversal = {
                        "id": "trr_live_earned",
                        "transfer": transfer_id,
                        "amount": kw["amount"],
                        "currency": "usd",
                    }
                    owner.reversals.append(reversal)
                    owner.remote[0]["amount_reversed"] = kw["amount"]
                    owner.remote[0]["reversed"] = True
                    if owner.reversal_timeout:
                        raise TimeoutError("accepted reversal response lost")
                    return reversal

            class Account:
                @staticmethod
                def retrieve(account_id, **kw):
                    assert kw["api_key"] == key
                    return {
                        "id": account_id,
                        "country": "US",
                        "details_submitted": True,
                        "payouts_enabled": True,
                        "capabilities": {"transfers": "active"},
                        "external_accounts": {
                            "has_more": False,
                            "data": [
                                {
                                    "object": "bank_account",
                                    "country": "US",
                                    "currency": "usd",
                                    "default_for_currency": True,
                                    "status": "new",
                                }
                            ],
                        },
                    }

            class Charge:
                @staticmethod
                def retrieve(charge_id, **kw):
                    assert charge_id == "ch_earned" and kw["api_key"] == key
                    return {
                        "id": charge_id,
                        "payment_intent": "pi_earned",
                        "amount": 1000,
                        "amount_refunded": 0,
                        "currency": "usd",
                        "livemode": True,
                        "paid": True,
                        "captured": True,
                        "disputed": False,
                    }

            class PaymentIntent:
                @staticmethod
                def retrieve(intent_id, **kw):
                    assert intent_id == "pi_earned" and kw["api_key"] == key
                    return {
                        "id": intent_id,
                        "latest_charge": "ch_earned",
                        "status": "succeeded",
                        "livemode": True,
                    }

            self.Transfer = Transfer
            self.Account = Account
            self.Charge = Charge
            self.PaymentIntent = PaymentIntent

    wallet, provider = LiveWallet(), LiveProvider()

    async def account(_):
        return {"stripe_account_id": "acct_live_owner", "readiness": {"ready": True}}

    service = HashcoinRedemptionService(
        wallet=wallet, stripe_api=provider, accounts=SimpleNamespace(refresh_account=account)
    )
    return service, wallet, provider


async def test_live_transfer_uses_exact_earning_charge_and_debits_once(live_world):
    service, wallet, provider = live_world
    args = {**request(), "mode": "live"}
    first = await service.redeem(**args)
    assert first["status"] == "succeeded"
    assert first["reversalStatus"] == "none"
    assert await service.redeem(**args) == first
    assert wallet.debits == 1 and len(provider.created) == 1
    transfer = provider.created[0]
    assert transfer["source_transaction"] == "ch_earned"
    assert transfer["amount"] == 911
    assert transfer["transfer_group"] == "drive-request-00000000-0000-0000-0000-000000000001"
    assert transfer["idempotency_key"].startswith("hashcoin-redeem:uat:live:")


async def test_live_lost_response_recovers_and_definite_funds_decline_releases(live_world):
    service, wallet, provider = live_world
    args = {**request(), "mode": "live"}
    provider.timeout = True
    assert (await service.redeem(**args))["status"] == "unknown"
    assert wallet.debits == 0
    assert (await service.redeem(**args))["status"] == "succeeded"
    assert len(provider.created) == 1 and wallet.debits == 1
    wallet.row = None
    provider.remote = []
    provider.decline = True
    assert (await service.redeem(**{**request(), "mode": "live"}))["status"] == "failed"
    assert wallet.debits == 1


async def test_live_kill_switch_reconciles_accepted_transfer_without_new_create(
    live_world, monkeypatch
):
    service, wallet, provider = live_world
    args = {**request(), "mode": "live"}
    provider.timeout = True
    assert (await service.redeem(**args))["status"] == "unknown"
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED", "false")
    assert (await service.redeem(**args))["status"] == "succeeded"
    assert wallet.debits == 1 and len(provider.created) == 1
    with pytest.raises(HashcoinRedemptionError, match="Real bank"):
        await service.redeem(**{**request(), "mode": "live"})


async def test_completed_live_transfer_reversal_holds_wallet_without_remint(live_world):
    service, wallet, provider = live_world
    assert (await service.redeem(**{**request(), "mode": "live"}))["status"] == "succeeded"
    provider.remote[0]["reversed"] = True
    provider.remote[0]["amount_reversed"] = 911
    assert await service._review_completed_live(max_items=1) == 1
    assert wallet.held and wallet.debits == 1
    wallet.row["providerReviewReason"] = "transfer_reversed"
    assert (
        await service.redeem(
            user_id="owner",
            amount_coins=911,
            client_request_id=wallet.row["clientRequestId"],
            mode="live",
        )
    )["reversalStatus"] == "manual_review"


async def test_live_flag_wrong_key_and_wrong_source_fail_closed(live_world, monkeypatch):
    service, wallet, provider = live_world
    monkeypatch.setenv("STRIPE_CONNECT_SECRET_KEY", "sk_test_" + "t" * 30)
    with pytest.raises(HashcoinRedemptionError, match="Real bank"):
        await service.redeem(**{**request(), "mode": "live"})
    assert wallet.row is None and provider.created == []
    monkeypatch.delenv("STRIPE_CONNECT_SECRET_KEY")
    provider.Charge.retrieve = lambda *_args, **_kwargs: {
        "id": "ch_wrong",
        "livemode": True,
    }
    assert (await service.redeem(**{**request(), "mode": "live"}))["status"] == "failed"
    assert provider.created == [] and wallet.debits == 0


async def test_live_redemption_requires_base_hashcoin_flag(live_world, monkeypatch):
    service, wallet, provider = live_world
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_ENABLED", "false")
    with pytest.raises(HashcoinRedemptionError, match="Real bank"):
        await service.redeem(**{**request(), "mode": "live"})
    assert wallet.row is None and provider.created == []


async def test_live_redemption_requires_distinct_webhook_secrets(live_world, monkeypatch):
    service, wallet, provider = live_world
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_payment_" + "p" * 25)
    with pytest.raises(HashcoinRedemptionError, match="Real bank"):
        await service.redeem(**{**request(), "mode": "live"})
    monkeypatch.delenv("STRIPE_CONNECT_WEBHOOK_SECRET")
    with pytest.raises(HashcoinRedemptionError, match="Real bank"):
        await service.redeem(**{**request(), "mode": "live"})
    assert wallet.row is None and provider.created == []


async def test_live_wrong_destination_account_cannot_transfer(live_world):
    service, wallet, provider = live_world
    provider.Account.retrieve = lambda *_args, **_kwargs: {"id": "acct_other", "country": "US"}
    assert (await service.redeem(**{**request(), "mode": "live"}))["status"] == "failed"
    assert provider.created == [] and wallet.debits == 0


async def test_live_source_group_rejects_prior_transfer_to_other_destination(live_world):
    service, wallet, provider = live_world
    provider.remote.append(
        {
            "id": "tr_other_destination",
            "livemode": True,
            "currency": "usd",
            "amount": 911,
            "destination": "acct_other_owner",
            "source_transaction": "ch_earned",
            "transfer_group": "drive-request-00000000-0000-0000-0000-000000000001",
            "metadata": {
                "payment_kind": "hashcoin_live_redemption",
                "hashcoin_redemption_id": "old",
            },
            "reversed": False,
            "amount_reversed": 0,
        }
    )
    assert (await service.redeem(**{**request(), "mode": "live"}))["status"] == "unknown"
    assert provider.created == [] and wallet.debits == 0


async def test_refunded_live_transfer_reversal_succeeds_without_remint(live_world):
    service, wallet, provider = live_world
    result = await service.redeem(**{**request(), "mode": "live"})
    assert result["status"] == "succeeded" and result["reversalStatus"] == "none"
    wallet.row["reversalStatus"] = "due"
    assert await service._reverse_refunded_live(max_items=1) == {"reversed": 1}
    assert wallet.row["reversalStatus"] == "reversed"
    assert wallet.held and wallet.debits == 1 and len(provider.reversals) == 1
    assert await service._reverse_refunded_live(max_items=1) == {}


async def test_lost_live_reversal_response_recovers_without_second_create(live_world):
    service, wallet, provider = live_world
    await service.redeem(**{**request(), "mode": "live"})
    wallet.row["reversalStatus"] = "due"
    provider.reversal_timeout = True
    assert await service._reverse_refunded_live(max_items=1) == {"unknown": 1}
    assert wallet.debits == 1 and len(provider.reversals) == 1
    assert await service._reverse_refunded_live(max_items=1) == {"reversed": 1}
    assert wallet.row["reversalStatus"] == "reversed" and len(provider.reversals) == 1


async def test_mismatched_live_reversal_is_manual_review_without_new_create(live_world):
    service, wallet, provider = live_world
    await service.redeem(**{**request(), "mode": "live"})
    wallet.row["reversalStatus"] = "due"
    provider.reversals.append(
        {"id": "trr_other", "transfer": "tr_live_earned", "amount": 1, "currency": "usd"}
    )
    assert await service._reverse_refunded_live(max_items=1) == {"manual_review": 1}
    assert wallet.row["reversalStatus"] == "manual_review"
    assert wallet.held and wallet.debits == 1 and len(provider.reversals) == 1


async def test_erased_owner_reconciles_existing_transfer_only(live_world):
    service, wallet, provider = live_world
    args = {**request(), "mode": "live"}
    provider.timeout = True
    assert (await service.redeem(**args))["status"] == "unknown"

    async def due(**_):
        return [{**wallet.row, "userId": None}]

    original_claim = wallet.claim_redemption

    async def ownerless_claim(**kw):
        assert kw["allow_erased"] and kw["user_id"] is None
        row = await original_claim(**kw)
        row["createAllowed"] = False
        return row

    wallet.list_reconcilable_redemptions = due
    wallet.claim_redemption = ownerless_claim
    assert (await service.reconcile_due(max_items=1))["succeeded"] == 1
    assert wallet.debits == 1 and len(provider.created) == 1


async def test_worker_reconciles_with_same_platform_connect_key_fallback(live_world, monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.drive_request_owner_payout_worker import DriveRequestOwnerPayoutWorker
    from hushh_mcp.services.stripe_connect_bank_payouts import StripeConnectBankPayouts

    monkeypatch.delenv("STRIPE_CONNECT_SECRET_KEY", raising=False)
    monkeypatch.setattr(
        HashcoinRedemptionService,
        "reconcile_due",
        AsyncMock(return_value={"refund_reversed": 1}),
    )
    bank_reconcile = AsyncMock(return_value={"bank_accounts_checked": 1, "bank_payouts_changed": 2})
    monkeypatch.setattr(StripeConnectBankPayouts, "reconcile_due", bank_reconcile)
    base = SimpleNamespace(
        reconcile_due=AsyncMock(return_value={}),
        transfer_due=AsyncMock(return_value={}),
        reconcile_external_debits=AsyncMock(return_value={}),
        reconcile_reversals=AsyncMock(return_value={}),
    )
    result = await DriveRequestOwnerPayoutWorker(service=base).run(max_jobs=1, deadline_seconds=20)
    assert result["outcomes"]["refund_reversed"] == 1
    assert result["outcomes"]["bank_accounts_checked"] == 1
    assert result["outcomes"]["bank_payouts_changed"] == 2
    bank_reconcile.assert_awaited_once_with(max_accounts=1, max_payouts_per_account=20)

    bank_reconcile.side_effect = RuntimeError("provider unavailable")
    result = await DriveRequestOwnerPayoutWorker(service=base).run(max_jobs=1, deadline_seconds=20)
    assert result["outcomes"]["refund_reversed"] == 1
    assert result["outcomes"]["bank_provider_deferred"] == 1


async def test_worker_scans_connect_test_bank_when_payment_is_live(world, monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.drive_request_owner_payout_worker import DriveRequestOwnerPayoutWorker
    from hushh_mcp.services.stripe_connect_bank_payouts import StripeConnectBankPayouts

    monkeypatch.setattr(
        HashcoinRedemptionService, "reconcile_due", AsyncMock(return_value={"succeeded": 1})
    )
    seen = []

    async def bank_reconcile(self, **bounds):
        seen.append((self.mode, self.connect_mode, bounds))
        return {"bank_accounts_checked": 1}

    monkeypatch.setattr(StripeConnectBankPayouts, "reconcile_due", bank_reconcile)
    base = SimpleNamespace(
        reconcile_due=AsyncMock(return_value={}),
        transfer_due=AsyncMock(return_value={}),
        reconcile_external_debits=AsyncMock(return_value={}),
        reconcile_reversals=AsyncMock(return_value={}),
    )
    result = await DriveRequestOwnerPayoutWorker(service=base).run(max_jobs=1, deadline_seconds=20)
    assert result["outcomes"]["succeeded"] == 1
    assert result["outcomes"]["bank_accounts_checked"] == 1
    assert seen == [("test", True, {"max_accounts": 1, "max_payouts_per_account": 20})]


def test_redemption_route_auth_identity_strict_amount_and_error_redaction(world, monkeypatch):
    from unittest.mock import AsyncMock

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import api.routes.one.payouts as routes
    import hushh_mcp.services.hashcoin_redemption_service as module
    from api.middleware import require_vault_owner_token

    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    body = {"amountCoins": 911, "clientRequestId": str(uuid4()), "mode": "test"}
    assert client.post("/api/one/payouts/hashcoins/redeem", json=body).status_code in {401, 403}
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "authenticated_owner"}
    fake = SimpleNamespace(redeem=AsyncMock(return_value={"status": "pending"}))
    monkeypatch.setattr(module, "HashcoinRedemptionService", lambda: fake)
    for amount in (True, "911", 0, -1, 50001):
        assert (
            client.post(
                "/api/one/payouts/hashcoins/redeem", json={**body, "amountCoins": amount}
            ).status_code
            == 422
        )
    assert (
        client.post(
            "/api/one/payouts/hashcoins/redeem", json={**body, "user_id": "victim"}
        ).status_code
        == 422
    )
    result = client.post("/api/one/payouts/hashcoins/redeem", json=body)
    assert result.status_code == 200 and result.headers["Cache-Control"] == "private, no-store"
    assert fake.redeem.await_args.kwargs["user_id"] == "authenticated_owner"
    fake.redeem.side_effect = RuntimeError("sk_test_secret bank private information")
    failed = client.post("/api/one/payouts/hashcoins/redeem", json=body)
    assert (
        failed.status_code == 503
        and "sk_test" not in failed.text
        and "private information" not in failed.text
    )
