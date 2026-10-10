"""A Stripe Transfer is one earning; a bank Payout may contain many earnings."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy import event as sa_event
from sqlalchemy.pool import StaticPool

import api.routes.one.payouts as payout_routes
import hushh_mcp.services.stripe_connect_bank_payouts as bank_module
from api.middleware import require_vault_owner_token
from hushh_mcp.services.stripe_connect_bank_payouts import (
    ConnectBankPayoutError,
    StripeConnectBankPayouts,
)


class FakeStripe:
    def __init__(self):
        self.retrieve_calls = []
        self.payout_status = "pending"
        self.account_payouts_enabled = True
        outer = self

        class Webhook:
            @staticmethod
            def construct_event(payload, signature, secret):
                if signature != "valid" or not secret.startswith("whsec_"):
                    raise ValueError("signature invalid")
                return json.loads(payload)

        class Payout:
            @staticmethod
            def retrieve(payout_id, **kwargs):
                outer.retrieve_calls.append((payout_id, kwargs))
                return {
                    "id": payout_id,
                    "object": "payout",
                    "livemode": False,
                    "status": outer.payout_status,
                    "amount": 911,
                    "currency": "usd",
                    "arrival_date": 1_800_000_000,
                    "failure_code": "no_account" if outer.payout_status == "failed" else None,
                }

        class Account:
            @staticmethod
            def retrieve(account_id, **kwargs):
                outer.retrieve_calls.append((account_id, kwargs))
                return {
                    "id": account_id,
                    "object": "account",
                    "country": "US",
                    "livemode": False,
                    "details_submitted": True,
                    "payouts_enabled": outer.account_payouts_enabled,
                }

        self.Webhook, self.Payout, self.Account = Webhook, Payout, Account


def event(*, event_id="evt_one", account="acct_owner", kind="payout.created", live=False):
    obj_id = account if kind == "account.updated" else "po_one"
    return json.dumps(
        {
            "id": event_id,
            "type": kind,
            "account": account,
            "livemode": live,
            "data": {
                "object": {
                    "id": obj_id,
                    "object": "account" if kind == "account.updated" else "payout",
                }
            },
        }
    ).encode()


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setattr(
        bank_module,
        "payment_config",
        lambda: ("sk_test_" + "x" * 30, "whsec_payment_only", "https://uat.one.hushh.ai"),
    )
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_" + "c" * 30)
    engine = create_engine(
        "sqlite+pysqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    notices = []

    @sa_event.listens_for(engine, "connect")
    def register_notify(dbapi_connection, _connection_record):
        dbapi_connection.create_function(
            "pg_notify", 2, lambda channel, payload: notices.append((channel, payload)) or 1
        )

    with engine.begin() as connection:
        connection.execute(
            text("""CREATE TABLE pkm_owner_payout_accounts (
          user_id TEXT PRIMARY KEY,stripe_account_id TEXT UNIQUE NOT NULL,
          details_submitted BOOLEAN NOT NULL,payouts_enabled BOOLEAN NOT NULL,
          updated_at TIMESTAMP)""")
        )
        connection.execute(
            text("""CREATE TABLE stripe_connect_bank_payout_events (
          stripe_event_id TEXT PRIMARY KEY,stripe_account_id TEXT NOT NULL,
          event_type TEXT NOT NULL,stripe_object_id TEXT NOT NULL,
          livemode BOOLEAN NOT NULL)""")
        )
        connection.execute(
            text("""CREATE TABLE stripe_connect_bank_payouts (
          stripe_payout_id TEXT PRIMARY KEY,stripe_account_id TEXT NOT NULL,
          livemode BOOLEAN NOT NULL,amount_cents BIGINT NOT NULL,currency TEXT NOT NULL,
          status TEXT NOT NULL,status_rank SMALLINT NOT NULL,
          expected_arrival_at TIMESTAMP,failure_code TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
        )
        connection.execute(
            text("""INSERT INTO pkm_owner_payout_accounts
              (user_id,stripe_account_id,details_submitted,payouts_enabled)
              VALUES ('owner','acct_owner',0,0),('other','acct_other',0,0)""")
        )
    fake = FakeStripe()
    service = StripeConnectBankPayouts(db=SimpleNamespace(engine=engine), stripe_api=fake)

    async def transaction(operation):
        with engine.begin() as connection:
            return operation(connection)

    service._transaction = transaction
    service.notices = notices
    return service, fake, engine


@pytest.mark.asyncio
async def test_signed_events_track_aggregate_bank_payout_without_order_attribution(world):
    service, fake, engine = world
    assert await service.process_webhook(payload=event(), signature="valid") == "updated"
    assert await service.process_webhook(payload=event(), signature="valid") == "duplicate"
    assert service.notices == [
        ("one_user_state_changed", '{"type":"bank_payout_changed","user_id":"owner"}')
    ]
    assert len(fake.retrieve_calls) == 1
    summary = await service.owner_summary(user_id="owner")
    assert summary["payouts"][0]["status"] == "pending"
    assert summary["payouts"][0]["amountCents"] == 911
    assert "requestId" not in json.dumps(summary)
    assert (await service.owner_summary(user_id="other"))["payouts"] == []

    fake.payout_status = "paid"
    assert (
        await service.process_webhook(
            payload=event(event_id="evt_paid", kind="payout.paid"), signature="valid"
        )
        == "updated"
    )
    fake.payout_status = "pending"  # stale provider snapshot finishes later
    assert (
        await service.process_webhook(
            payload=event(event_id="evt_late", kind="payout.updated"), signature="valid"
        )
        == "updated"
    )
    assert (await service.owner_summary(user_id="owner"))["payouts"][0]["status"] == "paid"

    fake.payout_status = "failed"  # a later bank failure can follow payout.paid
    await service.process_webhook(
        payload=event(event_id="evt_failed", kind="payout.failed"), signature="valid"
    )
    assert (await service.owner_summary(user_id="owner"))["payouts"][0]["status"] == "failed"
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payouts")
            ).scalar_one()
            == 1
        )


@pytest.mark.asyncio
async def test_rejects_invalid_signature_and_wrong_account_without_provider_read(world):
    service, fake, engine = world
    with pytest.raises(ConnectBankPayoutError, match="invalid_signature"):
        await service.process_webhook(payload=event(), signature="bad")
    assert (
        await service.process_webhook(
            payload=event(event_id="evt_live", live=True), signature="valid"
        )
        == "ignored_mode"
    )
    assert (
        await service.process_webhook(
            payload=event(event_id="evt_unmapped", account="acct_unknown"), signature="valid"
        )
        == "ignored_account"
    )
    assert fake.retrieve_calls == []
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payout_events")
            ).scalar_one()
            == 0
        )


@pytest.mark.asyncio
async def test_account_update_refreshes_owner_readiness_and_rejects_replayed_id_binding(world):
    service, fake, engine = world
    assert (
        await service.process_webhook(
            payload=event(event_id="evt_account", kind="account.updated"), signature="valid"
        )
        == "updated"
    )
    with engine.begin() as connection:
        account = connection.execute(
            text(
                "SELECT details_submitted,payouts_enabled FROM pkm_owner_payout_accounts WHERE user_id='owner'"
            )
        ).first()
        assert tuple(account) == (1, 1)
    assert service.notices == [
        ("one_user_state_changed", '{"type":"bank_payout_changed","user_id":"owner"}')
    ]
    with pytest.raises(ConnectBankPayoutError, match="provider_mismatch"):
        await service.process_webhook(
            payload=event(event_id="evt_account", kind="payout.updated"), signature="valid"
        )
    assert len(fake.retrieve_calls) == 1


def test_routes_keep_bank_summary_owner_scoped_and_webhook_public(world, monkeypatch):
    service, _fake, _engine = world
    monkeypatch.setattr(payout_routes, "StripeConnectBankPayouts", lambda: service)
    app = FastAPI()
    app.include_router(payout_routes.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    client = TestClient(app)

    assert (
        client.post(
            "/api/one/payouts/connect/webhook", data=event(), headers={"Stripe-Signature": "bad"}
        ).status_code
        == 400
    )
    assert client.post(
        "/api/one/payouts/connect/webhook", data=event(), headers={"Stripe-Signature": "valid"}
    ).json() == {"status": "updated"}
    response = client.get("/api/one/payouts/account/bank-payouts")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json()["payouts"][0]["status"] == "pending"
    assert "acct_owner" not in response.text

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "other"}
    assert client.get("/api/one/payouts/account/bank-payouts").json()["payouts"] == []
