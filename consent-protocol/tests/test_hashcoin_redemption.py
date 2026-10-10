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
