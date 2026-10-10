"""A Stripe Transfer is one earning; a bank Payout may contain many earnings."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import stripe
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy import event as sa_event
from sqlalchemy.pool import StaticPool

import api.routes.one.payouts as payout_routes
from api.middleware import require_vault_owner_token
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.stripe_connect_bank_payouts import (
    ConnectBankPayoutError,
    StripeConnectBankPayouts,
)

CONNECT_WEBHOOK_SECRET = "whsec_" + "c" * 30
PAYMENT_WEBHOOK_SECRET = "whsec_" + "p" * 30


class FakeStripe:
    def __init__(self, *, livemode=False):
        self.livemode = livemode
        self.retrieve_calls = []
        self.payout_status = "pending"
        self.account_payouts_enabled = True
        self.external_accounts = {
            "data": [
                {
                    "object": "bank_account",
                    "country": "US",
                    "currency": "usd",
                    "default_for_currency": True,
                    "bank_name": "Example Bank",
                    "last4": "6789",
                    "status": "new",
                }
            ],
            "has_more": False,
        }
        outer = self

        class Payout:
            @staticmethod
            def retrieve(payout_id, **kwargs):
                outer.retrieve_calls.append((payout_id, kwargs))
                return {
                    "id": payout_id,
                    "object": "payout",
                    "livemode": outer.livemode,
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
                    "details_submitted": True,
                    "payouts_enabled": outer.account_payouts_enabled,
                    "capabilities": {"transfers": "active"},
                    "requirements": {},
                    **(
                        {"external_accounts": outer.external_accounts}
                        if outer.external_accounts is not None
                        else {}
                    ),
                }

        self.Webhook, self.Payout, self.Account = stripe.Webhook, Payout, Account


def event(*, event_id="evt_one", account="acct_owner", kind="payout.created", live=False):
    external = kind.startswith("account.external_account.")
    obj_id = account if kind == "account.updated" else "ba_one" if external else "po_one"
    return json.dumps(
        {
            "id": event_id,
            "object": "event",
            "type": kind,
            "account": account,
            "livemode": live,
            "data": {
                "object": {
                    "id": obj_id,
                    "object": "account"
                    if kind == "account.updated"
                    else "bank_account"
                    if external
                    else "payout",
                }
            },
        }
    ).encode()


def signature(payload, *, secret=CONNECT_WEBHOOK_SECRET, timestamp=None):
    timestamp = int(time.time()) if timestamp is None else timestamp
    digest = hmac.new(
        secret.encode(), str(timestamp).encode() + b"." + payload, hashlib.sha256
    ).hexdigest()
    return f"t={timestamp},v1={digest}"


def signed_event(**kwargs):
    payload = event(**kwargs)
    return {"payload": payload, "signature": signature(payload)}


@pytest.fixture
def world(monkeypatch, request):
    mode = getattr(request, "param", "test")
    for name in ("ENVIRONMENT", "HUSHH_DEPLOY_ENV", "HUSSH_DEPLOY_ENV"):
        monkeypatch.setenv(name, "uat")
    monkeypatch.setenv("STRIPE_MODE", mode)
    monkeypatch.setenv("STRIPE_SECRET_KEY", f"sk_{mode}_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", PAYMENT_WEBHOOK_SECRET)
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", CONNECT_WEBHOOK_SECRET)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://uat.one.hushh.ai")
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
            text("""CREATE TABLE stripe_owner_payout_accounts (
          user_id TEXT NOT NULL,stripe_account_id TEXT UNIQUE NOT NULL,
          stripe_mode TEXT NOT NULL,
          details_submitted BOOLEAN NOT NULL,payouts_enabled BOOLEAN NOT NULL,
          account_ready BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMP,PRIMARY KEY(user_id,stripe_mode))""")
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
            text("""INSERT INTO stripe_owner_payout_accounts
              (user_id,stripe_account_id,stripe_mode,details_submitted,payouts_enabled)
              VALUES ('owner','acct_owner_inactive',:inactive_mode,0,0),
                ('owner','acct_owner',:mode,0,0),('other','acct_other',:mode,0,0)"""),
            {"mode": mode, "inactive_mode": "test" if mode == "live" else "live"},
        )
    fake = FakeStripe(livemode=mode == "live")
    service = StripeConnectBankPayouts(db=SimpleNamespace(engine=engine), stripe_api=fake)

    async def transaction(operation):
        with engine.begin() as connection:
            return operation(connection)

    service._transaction = transaction
    service.notices = notices
    yield service, fake, engine
    engine.dispose()


@pytest.mark.asyncio
async def test_account_update_refreshes_owner_readiness_and_rejects_replayed_id_binding(world):
    service, fake, engine = world
    assert (
        await service.process_webhook(
            **signed_event(event_id="evt_account", kind="account.updated")
        )
        == "updated"
    )
    with engine.begin() as connection:
        account = connection.execute(
            text(
                "SELECT details_submitted,payouts_enabled,account_ready FROM stripe_owner_payout_accounts WHERE stripe_account_id='acct_owner'"
            )
        ).first()
        assert tuple(account) == (1, 1, 1)
    assert service.notices == [
        ("one_user_state_changed", '{"type":"bank_payout_changed","user_id":"owner"}')
    ]
    with pytest.raises(ConnectBankPayoutError, match="provider_mismatch"):
        await service.process_webhook(**signed_event(event_id="evt_account", kind="payout.updated"))
    assert len(fake.retrieve_calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [
        "account.external_account.created",
        "account.external_account.updated",
        "account.external_account.deleted",
    ],
)
async def test_bank_change_reconciles_current_account_and_notifies_owner(world, kind):
    service, fake, engine = world
    # Stripe still reports payouts_enabled while its removed/failed default bank
    # is already visible. Never keep accepting new paid orders on that cache.
    fake.external_accounts = {"data": [], "has_more": False}
    assert await service.process_webhook(**signed_event(kind=kind)) == "updated"
    assert fake.retrieve_calls[0][0] == "acct_owner"  # deleted bank cannot be retrieved
    assert service.notices == [
        ("one_user_state_changed", '{"type":"bank_payout_changed","user_id":"owner"}')
    ]
    with engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT account_ready FROM stripe_owner_payout_accounts WHERE stripe_account_id='acct_owner'"
                )
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payouts")
            ).scalar_one()
            == 0
        )
    assert await service.process_webhook(**signed_event(kind=kind)) == "duplicate"
    assert len(fake.retrieve_calls) == 1


@pytest.mark.asyncio
async def test_bank_change_rejects_external_object_bound_to_another_owner(world):
    service, fake, _engine = world
    payload = json.loads(event(kind="account.external_account.updated"))
    payload["data"]["object"]["account"] = "acct_other"
    raw = json.dumps(payload).encode()
    with pytest.raises(ConnectBankPayoutError, match="invalid_event"):
        await service.process_webhook(payload=raw, signature=signature(raw))
    assert fake.retrieve_calls == []


@pytest.mark.parametrize("world", ["test", "live"], indirect=True)
def test_signed_bank_flow_keeps_terminal_state_and_owner_mode_boundaries(world, monkeypatch):
    service, fake, engine = world
    monkeypatch.setattr(payout_routes, "StripeConnectBankPayouts", lambda: service)
    app = FastAPI()
    app.include_router(payout_routes.router)
    client = TestClient(app)
    webhook = "/api/one/payouts/connect/webhook"
    history = "/api/one/payouts/account/bank-payouts"

    def post(**event_kwargs):
        payload = event(live=fake.livemode, **event_kwargs)
        return client.post(
            webhook, content=payload, headers={"Stripe-Signature": signature(payload)}
        )

    assert client.get(history).status_code == 401
    payload = event(live=fake.livemode)
    for body, header in (
        (payload + b"\n", signature(payload)),
        (payload, signature(payload, timestamp=int(time.time()) - 600)),
        (payload, signature(payload, secret=PAYMENT_WEBHOOK_SECRET)),
    ):
        rejected = client.post(webhook, content=body, headers={"Stripe-Signature": header})
        assert rejected.status_code == 400
        assert rejected.json() == {"detail": "Connect event could not be processed."}
        assert rejected.headers["Cache-Control"] == "no-store"

    wrong_mode = event(event_id="evt_wrong_mode", live=not fake.livemode)
    assert client.post(
        webhook, content=wrong_mode, headers={"Stripe-Signature": signature(wrong_mode)}
    ).json() == {"status": "ignored_mode"}
    for account in ("acct_unknown", "acct_owner_inactive"):
        assert post(event_id=f"evt_{account}", account=account).json() == {
            "status": "ignored_account"
        }
    assert fake.retrieve_calls == []
    assert service.notices == []
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payout_events")
            ).scalar_one()
            == 0
        )
        # The same owner has another mode's account and historical payout.
        # An old wrong-mode row on the active account must also remain hidden.
        connection.execute(
            text("""INSERT INTO stripe_connect_bank_payouts
              (stripe_payout_id,stripe_account_id,livemode,amount_cents,currency,status,status_rank)
              VALUES ('po_inactive','acct_owner_inactive',:inactive,500,'usd','paid',2),
                ('po_wrong_mode','acct_owner',:inactive,600,'usd','paid',2)"""),
            {"inactive": not fake.livemode},
        )

    # Stripe needs no vault-owner token; its raw-byte signature is the authority.
    accepted = post()
    assert accepted.status_code == 200
    assert accepted.json() == {"status": "updated"}
    assert post().json() == {"status": "duplicate"}
    assert len(fake.retrieve_calls) == 1
    assert service.notices == [
        ("one_user_state_changed", '{"type":"bank_payout_changed","user_id":"owner"}')
    ]

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = client.get(f"{history}?user_id=other")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    payout = response.json()["payouts"]
    assert len(payout) == 1
    assert payout[0]["id"] == "po_one"
    assert payout[0]["status"] == "pending"
    assert payout[0]["amountCents"] == 911
    assert payout[0]["failureCode"] is None
    assert "acct_owner" not in response.text
    assert "requestId" not in response.text

    for index, (provider_status, kind, expected) in enumerate(
        [
            ("in_transit", "payout.updated", "in_transit"),
            ("paid", "payout.paid", "paid"),
            ("pending", "payout.created", "paid"),  # stale provider read finishes late
            ("failed", "payout.failed", "failed"),  # bank rejects a paid deposit
            ("paid", "payout.paid", "failed"),  # late paid read cannot erase the failure
        ]
    ):
        fake.payout_status = provider_status
        assert post(event_id=f"evt_transition_{index}", kind=kind).json() == {"status": "updated"}
        payout = client.get(history).json()["payouts"]
        assert len(payout) == 1
        assert payout[0]["status"] == expected
        assert payout[0]["failureCode"] == ("no_account" if expected == "failed" else None)

    expected_key = ("sk_live_" if fake.livemode else "sk_test_") + "x" * 30
    assert all(
        payout_id == "po_one"
        and options == {"stripe_account": "acct_owner", "api_key": expected_key}
        for payout_id, options in fake.retrieve_calls
    )
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payout_events")
            ).scalar_one()
            == 6
        )
        assert (
            connection.execute(
                text(
                    "SELECT COUNT(*) FROM stripe_connect_bank_payouts WHERE stripe_payout_id='po_one'"
                )
            ).scalar_one()
            == 1
        )

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "other"}
    assert client.get(f"{history}?user_id=owner").json()["payouts"] == []


def test_signed_provider_timeout_retries_same_event_without_duplicate_payout(world, monkeypatch):
    service, fake, engine = world
    provider_reads = []
    original_retrieve = fake.Payout.retrieve

    def retrieve(payout_id, **kwargs):
        provider_reads.append((payout_id, kwargs))
        if len(provider_reads) == 1:
            raise TimeoutError("private_provider_timeout")
        return original_retrieve(payout_id, **kwargs)

    monkeypatch.setattr(fake.Payout, "retrieve", retrieve)
    monkeypatch.setattr(payout_routes, "StripeConnectBankPayouts", lambda: service)
    app = FastAPI()
    app.include_router(payout_routes.router)
    client = TestClient(app)
    payload = event(event_id="evt_retry")
    headers = {"Stripe-Signature": signature(payload)}

    failed = client.post("/api/one/payouts/connect/webhook", content=payload, headers=headers)
    assert failed.status_code == 503
    assert failed.json() == {"detail": "Connect event could not be processed."}
    assert failed.headers["Cache-Control"] == "no-store"
    assert len(provider_reads) == 1
    assert service.notices == []
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payout_events")
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payouts")
            ).scalar_one()
            == 0
        )

    retried = client.post("/api/one/payouts/connect/webhook", content=payload, headers=headers)
    assert retried.status_code == 200
    assert retried.json() == {"status": "updated"}
    duplicate = client.post("/api/one/payouts/connect/webhook", content=payload, headers=headers)
    assert duplicate.status_code == 200
    assert duplicate.json() == {"status": "duplicate"}
    assert len(provider_reads) == 2
    assert service.notices == [
        ("one_user_state_changed", '{"type":"bank_payout_changed","user_id":"owner"}')
    ]
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT stripe_event_id FROM stripe_connect_bank_payout_events")
            ).scalar_one()
            == "evt_retry"
        )
        assert (
            connection.execute(
                text("SELECT stripe_payout_id FROM stripe_connect_bank_payouts")
            ).scalar_one()
            == "po_one"
        )


@pytest.mark.parametrize(
    ("method", "path", "detail"),
    [
        ("GET", "/account/bank-payouts", "Bank payout status is unavailable."),
        ("POST", "/connect/webhook", "Connect event could not be processed."),
    ],
)
def test_bank_routes_sanitize_storage_failure(monkeypatch, method, path, detail):
    failure = ConnectorLifecycleError("private_storage_diagnostic")
    service = SimpleNamespace(
        owner_summary=AsyncMock(side_effect=failure),
        process_webhook=AsyncMock(side_effect=failure),
    )
    monkeypatch.setattr(payout_routes, "StripeConnectBankPayouts", lambda: service)
    app = FastAPI()
    app.include_router(payout_routes.router)
    if method == "GET":
        app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    client = TestClient(app, raise_server_exceptions=False)

    response = client.request(method, f"/api/one/payouts{path}")

    assert response.status_code == 503
    assert response.json() == {"detail": detail}
    assert "no-store" in response.headers.get("Cache-Control", "")


@pytest.mark.parametrize("world", ["live"], indirect=True)
async def test_sandbox_webhook_uses_separate_signature_key_and_account_mode(world, monkeypatch):
    live, fake, engine = world
    test_secret = "whsec_" + "s" * 30
    monkeypatch.setenv("STRIPE_CONNECT_MODE", "test")
    monkeypatch.setenv("STRIPE_CONNECT_SECRET_KEY", "sk_test_" + "t" * 30)
    monkeypatch.setenv("STRIPE_CONNECT_TEST_WEBHOOK_SECRET", test_secret)
    sandbox = StripeConnectBankPayouts(db=live.db, stripe_api=fake, connect_mode=True)
    sandbox._transaction = live._transaction
    fake.livemode = False
    payload = event(account="acct_owner_inactive", kind="account.updated")
    with pytest.raises(ConnectBankPayoutError, match="invalid_signature"):
        await sandbox.process_webhook(payload=payload, signature=signature(payload))
    assert (
        await sandbox.process_webhook(
            payload=payload, signature=signature(payload, secret=test_secret)
        )
        == "updated"
    )
    assert fake.retrieve_calls[-1][1]["api_key"].startswith("sk_test_")
    with engine.begin() as connection:
        accounts = dict(
            connection.execute(
                text(
                    "SELECT stripe_mode,account_ready FROM stripe_owner_payout_accounts WHERE user_id='owner'"
                )
            ).all()
        )
    assert accounts == {"live": 0, "test": 1}
    # Correctly signed but wrong-mode events still cannot mutate either ledger.
    wrong = event(
        event_id="evt_wrong_mode", account="acct_owner", kind="account.updated", live=True
    )
    assert (
        await sandbox.process_webhook(payload=wrong, signature=signature(wrong, secret=test_secret))
        == "ignored_mode"
    )


@pytest.mark.parametrize("world", ["test", "live"], indirect=True)
async def test_bank_summary_exposes_mode_for_both_empty_and_existing_accounts(world):
    service, fake, _ = world
    expected = "live" if fake.livemode else "test"
    for owner in ("owner", "absent"):
        assert (await service.owner_summary(user_id=owner))["stripeMode"] == expected
