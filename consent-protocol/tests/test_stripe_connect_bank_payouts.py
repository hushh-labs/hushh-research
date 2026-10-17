"""A Stripe Transfer is one earning; a bank Payout may contain many earnings."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime, timedelta
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
import hushh_mcp.services.stripe_connect_balances as connect_balances
import hushh_mcp.services.stripe_connect_bank_payouts as bank_payouts
from api.middleware import require_vault_owner_token
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.stripe_connect_bank_payouts import (
    ConnectBankPayoutError,
    StripeConnectBankPayouts,
)

CONNECT_WEBHOOK_SECRET = "whsec_" + "c" * 30
PAYMENT_WEBHOOK_SECRET = "whsec_" + "p" * 30
EXAMPLE_BANK = {
    "id": "ba_first",
    "object": "bank_account",
    "bank_name": "Example Bank",
    "last4": "6789",
}


def doorbell(*kinds, owner="owner"):
    payload = json.dumps(
        {"kinds": sorted(kinds), "type": "bank_payout_changed", "user_id": owner},
        separators=(",", ":"),
        sort_keys=True,
    )
    return ("one_user_state_changed", payload)


class FakeStripe:
    def __init__(self, *, livemode=False):
        self.livemode = livemode
        self.retrieve_calls = []
        self.list_calls = []
        self.list_payouts = []
        self.list_error = None
        self.on_list = None
        self.payout_status = "pending"
        self.payout_arrival = 1_800_000_000
        self.payout_details = {}  # destination, method, trace_id, reconciliation_status...
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
            def list(**kwargs):
                outer.list_calls.append(kwargs)
                if outer.list_error is not None:
                    raise outer.list_error
                if outer.on_list is not None:
                    outer.on_list()
                payouts = outer.list_payouts
                if "starting_after" in kwargs:
                    cursor = kwargs["starting_after"]
                    payouts = payouts[
                        next(
                            (
                                index + 1
                                for index, payout in enumerate(payouts)
                                if payout["id"] == cursor
                            ),
                            len(payouts),
                        ) :
                    ]
                limit = kwargs["limit"]
                return {"object": "list", "data": payouts[:limit], "has_more": len(payouts) > limit}

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
                    "created": 1_700_000_000,
                    "arrival_date": outer.payout_arrival,
                    "failure_code": "no_account" if outer.payout_status == "failed" else None,
                    **outer.payout_details,
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
    obj = {
        "id": obj_id,
        "object": "account"
        if kind == "account.updated"
        else "bank_account"
        if external
        else "payout",
    }
    if kind == "balance.available":
        # A Balance has no ID; Stripe names the connected account on the event.
        obj = {"object": "balance", "livemode": live, "available": [{"amount": 911}]}
    return json.dumps(
        {
            "id": event_id,
            "object": "event",
            "type": kind,
            "account": account,
            "livemode": live,
            "data": {"object": obj},
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
          bank_payout_scan_started_at TIMESTAMP,bank_payout_scan_cursor TEXT,
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
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          destination_id TEXT,destination_kind TEXT,destination_bank_name TEXT,
          destination_last4 TEXT,payout_method TEXT,automatic BOOLEAN,trace_status TEXT,
          trace_value TEXT,reconciliation_status TEXT,provider_observed_at TIMESTAMP,
          status_changed_at TIMESTAMP,paid_at TIMESTAMP,failed_at TIMESTAMP)""")
        )
        connection.execute(
            text("""INSERT INTO stripe_owner_payout_accounts
              (user_id,stripe_account_id,stripe_mode,details_submitted,payouts_enabled)
              VALUES ('owner','acct_owner_inactive',:inactive_mode,0,0),
                ('owner','acct_owner',:mode,0,0),('other','acct_other',:mode,0,0)"""),
            {"mode": mode, "inactive_mode": "test" if mode == "live" else "live"},
        )
        # Reconciliation cases below target the named owner; the unrelated
        # account remains present as a cross-owner binding negative control.
        connection.execute(
            text("""UPDATE stripe_owner_payout_accounts
          SET bank_payout_scan_started_at='2999-01-01' WHERE stripe_account_id='acct_other'""")
        )
    fake = FakeStripe(livemode=mode == "live")
    service = StripeConnectBankPayouts(db=SimpleNamespace(engine=engine), stripe_api=fake)

    async def transaction(operation):
        with engine.begin() as connection:
            return operation(connection)

    # The Connect balance ledger (migration 317) has its own suite; record the
    # contract calls made on this webhook transaction instead.
    ledger_calls = []
    monkeypatch.setattr(
        connect_balances,
        "mark_balance_refresh_due",
        lambda connection, **kwargs: ledger_calls.append(("refresh_due", kwargs)),
    )
    monkeypatch.setattr(
        connect_balances,
        "enqueue_payout_reconciliation",
        lambda connection, **kwargs: ledger_calls.append(("reconcile", kwargs)),
    )
    service._transaction = transaction
    service.notices = notices
    service.ledger_calls = ledger_calls
    yield service, fake, engine
    engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("world", ["test", "live"], indirect=True)
async def test_owner_ledger_read_does_not_require_provider_credentials(world, monkeypatch):
    service, fake, _ = world
    for name in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_CONNECT_WEBHOOK_SECRET"):
        monkeypatch.delenv(name, raising=False)
    summary = await service.owner_summary(user_id="owner")
    assert summary == {
        "currency": "USD",
        "stripeMode": service.mode,
        "payouts": [],
        "nextCursor": None,
    }
    assert fake.retrieve_calls == fake.list_calls == []
    # Reading the ledger must not weaken webhook authentication.
    with pytest.raises(ConnectBankPayoutError):
        await service.process_webhook(**signed_event())


@pytest.mark.asyncio
async def test_account_update_refreshes_owner_readiness_and_rejects_replayed_id_binding(
    world, monkeypatch
):
    service, fake, engine = world
    invalidated = []
    monkeypatch.setattr(
        bank_payouts,
        "invalidate_payout_account_status",
        lambda **kwargs: invalidated.append(kwargs),
        raising=False,
    )
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
    # The doorbell names only the changed payout kind, never the account.
    assert service.notices == [
        (
            "one_user_state_changed",
            '{"kinds":["account"],"type":"bank_payout_changed","user_id":"owner"}',
        )
    ]
    with pytest.raises(ConnectBankPayoutError, match="provider_mismatch"):
        await service.process_webhook(**signed_event(event_id="evt_account", kind="payout.updated"))
    assert len(fake.retrieve_calls) == 1
    assert invalidated == [{"user_id": "owner", "mode": service.mode}]


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
    assert service.notices == [doorbell("account")]
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


@pytest.mark.asyncio
async def test_signed_payout_cancellation_updates_bank_status_immediately(world):
    service, fake, _ = world
    fake.payout_status = "canceled"
    assert (
        await service.process_webhook(**signed_event(event_id="evt_cancel", kind="payout.canceled"))
        == "updated"
    )
    assert (await service.owner_summary(user_id="owner"))["payouts"][0]["status"] == "canceled"


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
        assert "no-store" in rejected.headers["Cache-Control"]

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
    assert service.notices == [doorbell("bank_payouts")]

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
    # Stale reads change no row, so they ring no doorbell: create, in transit,
    # paid and failed only.
    assert service.notices == [doorbell("bank_payouts")] * 4

    expected_key = ("sk_live_" if fake.livemode else "sk_test_") + "x" * 30
    assert all(
        payout_id == "po_one"
        and options
        == {"stripe_account": "acct_owner", "api_key": expected_key, "expand": ["destination"]}
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
    assert "no-store" in failed.headers["Cache-Control"]
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
    assert service.notices == [doorbell("bank_payouts")]
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
        summary = await service.owner_summary(user_id=owner)
        assert (summary["stripeMode"], summary["nextCursor"]) == (expected, None)


def listed_payout(
    payout_id,
    *,
    live=False,
    status="pending",
    amount=911,
    created=1_700_000_000,
    arrival=1_800_000_000,
    **details,
):
    return {
        "id": payout_id,
        "object": "payout",
        "livemode": live,
        "status": status,
        "amount": amount,
        "currency": "usd",
        "created": created,
        "arrival_date": arrival,
        "failure_code": "no_account" if status == "failed" else None,
        **details,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("world", ["test", "live"], indirect=True)
async def test_scan_recovers_missed_creation_and_paginates_without_crossing_modes(world):
    service, fake, engine = world
    fake.list_payouts = [
        listed_payout("po_new", live=fake.livemode, created=1_700_000_002),
        listed_payout("po_older", live=fake.livemode, status="paid", created=1_700_000_001),
    ]
    first = await service.reconcile_due(max_payouts_per_account=1)
    assert first == {
        "bank_accounts_checked": 1,
        "bank_payouts_changed": 1,
        "bank_provider_deferred": 0,
    }
    with engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT bank_payout_scan_cursor FROM stripe_owner_payout_accounts WHERE stripe_account_id='acct_owner'"
                )
            ).scalar_one()
            == "po_new"
        )
        connection.execute(
            text("""UPDATE stripe_owner_payout_accounts
          SET bank_payout_scan_started_at='2000-01-01' WHERE stripe_account_id='acct_owner'""")
        )
    second = await service.reconcile_due(max_payouts_per_account=1)
    assert second["bank_payouts_changed"] == 1
    assert [row["id"] for row in (await service.owner_summary(user_id="owner"))["payouts"]] == [
        "po_new",
        "po_older",
    ]
    with engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT bank_payout_scan_cursor FROM stripe_owner_payout_accounts WHERE stripe_account_id='acct_owner'"
                )
            ).scalar_one_or_none()
            is None
        )
        rows = connection.execute(
            text("""SELECT stripe_payout_id,status FROM stripe_connect_bank_payouts
          ORDER BY stripe_payout_id""")
        ).all()
        assert rows == [("po_new", "pending"), ("po_older", "paid")]
        connection.execute(
            text("""UPDATE stripe_owner_payout_accounts
          SET bank_payout_scan_started_at='2000-01-01' WHERE stripe_account_id='acct_owner'""")
        )
    assert (await service.reconcile_due(max_payouts_per_account=1))["bank_payouts_changed"] == 0
    assert [call.get("starting_after") for call in fake.list_calls] == [None, "po_new", None]
    expected_key = ("sk_live_" if fake.livemode else "sk_test_") + "x" * 30
    assert all(
        call["stripe_account"] == "acct_owner"
        and call["api_key"] == expected_key
        and call["max_network_retries"] == 0
        and call["expand"] == ["data.destination"]
        for call in fake.list_calls
    )
    assert len(service.notices) == 2  # repeat scan is idempotent


@pytest.mark.asyncio
async def test_scan_cannot_regress_paid_or_failed_webhook_snapshot(world):
    service, fake, engine = world
    fake.payout_status = "paid"
    assert (
        await service.process_webhook(**signed_event(event_id="evt_paid", kind="payout.paid"))
        == "updated"
    )
    fake.list_payouts = [listed_payout("po_one", status="pending")]
    assert (await service.reconcile_due())["bank_payouts_changed"] == 0
    assert len(service.notices) == 1
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE stripe_owner_payout_accounts
          SET bank_payout_scan_started_at='2000-01-01' WHERE stripe_account_id='acct_owner'""")
        )
    fake.list_payouts = [listed_payout("po_one", status="failed")]
    assert (await service.reconcile_due())["bank_payouts_changed"] == 1
    fake.payout_status = "paid"
    assert (
        await service.process_webhook(**signed_event(event_id="evt_stale", kind="payout.paid"))
        == "updated"
    )
    payout = (await service.owner_summary(user_id="owner"))["payouts"][0]
    assert payout["status"] == "failed"
    assert payout["failureCode"] == "no_account"


@pytest.mark.asyncio
@pytest.mark.parametrize("world", ["test", "live"], indirect=True)
async def test_scan_rejects_wrong_provider_mode_without_advancing_cursor(world):
    service, fake, engine = world
    fake.list_payouts = [listed_payout("po_wrong", live=not fake.livemode)]
    with pytest.raises(ConnectBankPayoutError, match="provider_mismatch"):
        await service.reconcile_due()
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payouts")
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text(
                    "SELECT bank_payout_scan_cursor FROM stripe_owner_payout_accounts WHERE stripe_account_id='acct_owner'"
                )
            ).scalar_one_or_none()
            is None
        )
    assert service.notices == []


@pytest.mark.asyncio
async def test_scan_provider_outage_retries_same_cursor_and_owner_rebind_is_fenced(world):
    service, fake, engine = world
    fake.list_error = TimeoutError("private_provider_timeout")
    assert (await service.reconcile_due())["bank_provider_deferred"] == 1
    assert service.notices == []
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payouts")
            ).scalar_one()
            == 0
        )
        connection.execute(
            text("""UPDATE stripe_owner_payout_accounts
          SET bank_payout_scan_started_at='2000-01-01' WHERE stripe_account_id='acct_owner'""")
        )
    fake.list_error = None
    fake.list_payouts = [listed_payout("po_recovered")]
    assert (await service.reconcile_due())["bank_payouts_changed"] == 1

    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE stripe_owner_payout_accounts
          SET bank_payout_scan_started_at='2000-01-01' WHERE stripe_account_id='acct_owner'""")
        )
    fake.list_payouts = [listed_payout("po_after_rebind")]

    def rebind():
        with engine.begin() as connection:
            connection.execute(
                text("""UPDATE stripe_owner_payout_accounts SET user_id='replacement'
              WHERE stripe_account_id='acct_owner'""")
            )

    fake.on_list = rebind
    assert (await service.reconcile_due())["bank_payouts_changed"] == 0
    with engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT COUNT(*) FROM stripe_connect_bank_payouts WHERE stripe_payout_id='po_after_rebind'"
                )
            ).scalar_one()
            == 0
        )
    assert len(service.notices) == 1


@pytest.mark.asyncio
async def test_scan_timeout_does_not_advance_cursor_after_provider_thread_finishes(
    world, monkeypatch
):
    service, fake, engine = world
    monkeypatch.setattr(bank_payouts, "_PROVIDER_READ_TIMEOUT_SECONDS", 0.001)
    fake.list_payouts = [listed_payout("po_late")]
    fake.on_list = lambda: time.sleep(0.02)
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE stripe_owner_payout_accounts
          SET bank_payout_scan_cursor='po_previous' WHERE stripe_account_id='acct_owner'""")
        )
    assert (await service.reconcile_due())["bank_provider_deferred"] == 1
    await asyncio.sleep(0.03)  # the timed-out thread returns; it owns no database write path
    with engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT bank_payout_scan_cursor FROM stripe_owner_payout_accounts
              WHERE stripe_account_id='acct_owner'""")
            ).scalar_one()
            == "po_previous"
        )
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM stripe_connect_bank_payouts")
            ).scalar_one()
            == 0
        )


def stored_payout(engine, payout_id="po_one"):
    with engine.begin() as connection:
        row = (
            connection.execute(
                text("""SELECT status,expected_arrival_at,status_changed_at,paid_at,failed_at,
                  provider_observed_at,destination_id,destination_kind,payout_method,automatic,
                  trace_status FROM stripe_connect_bank_payouts WHERE stripe_payout_id=:id"""),
                {"id": payout_id},
            )
            .mappings()
            .one()
        )
    return dict(row)


@pytest.mark.asyncio
async def test_same_status_read_keeps_newer_detail_and_ignores_older_reads(world):
    # Regression: an equal-rank Stripe read was dropped, so a moved arrival
    # date never reached the owner while the event was consumed as handled.
    service, fake, engine = world
    fake.payout_status = "in_transit"
    sent = signed_event(event_id="evt_sent", kind="payout.updated")
    assert await service.process_webhook(**sent) == "updated"
    moved = 1_800_000_000 + 2 * 86_400
    fake.payout_arrival = moved
    later = signed_event(event_id="evt_moved", kind="payout.updated")
    assert await service.process_webhook(**later) == "updated"
    arrival = datetime.fromtimestamp(moved, UTC).isoformat()
    summary = await service.owner_summary(user_id="owner")
    assert summary["payouts"][0]["expectedArrivalAt"] == arrival
    assert service.notices == [doorbell("bank_payouts")] * 2

    # A replayed event is consumed once: no provider read, no write, no doorbell.
    reads = len(fake.retrieve_calls)
    assert await service.process_webhook(**later) == "duplicate"
    assert len(fake.retrieve_calls) == reads
    # A newer read that adds nothing changes no row and rings no doorbell.
    same = signed_event(event_id="evt_same", kind="payout.updated")
    assert await service.process_webhook(**same) == "updated"
    assert len(service.notices) == 2

    # A read taken earlier but stored last cannot restore the old arrival date.
    observed = bank_payouts._as_utc(stored_payout(engine)["provider_observed_at"])
    stale = bank_payouts._payout_fields(
        listed_payout("po_one", live=fake.livemode, status="in_transit"),
        payout_id="po_one",
        livemode=fake.livemode,
        observed_at=observed - timedelta(seconds=1),
    )
    with engine.begin() as connection:
        assert not StripeConnectBankPayouts._store_payout(
            connection, account_id="acct_owner", livemode=fake.livemode, snapshot=stale
        )
    summary = await service.owner_summary(user_id="owner")
    assert summary["payouts"][0]["expectedArrivalAt"] == arrival
    assert service.ledger_calls == []


@pytest.mark.asyncio
async def test_status_times_move_only_when_the_status_rises(world):
    service, fake, engine = world

    def times():
        row = stored_payout(engine)
        return row["status"], row["status_changed_at"], row["paid_at"], row["failed_at"]

    fake.payout_status = "in_transit"
    assert (
        await service.process_webhook(**signed_event(event_id="evt_sent", kind="payout.updated"))
        == "updated"
    )
    status, sent_at, paid_at, failed_at = times()
    assert (status, paid_at, failed_at) == ("in_transit", None, None) and sent_at is not None
    fake.payout_arrival += 86_400  # same status, new detail
    assert (
        await service.process_webhook(**signed_event(event_id="evt_moved", kind="payout.updated"))
        == "updated"
    )
    assert times() == ("in_transit", sent_at, None, None)

    fake.payout_status = "paid"
    assert (
        await service.process_webhook(**signed_event(event_id="evt_paid", kind="payout.paid"))
        == "updated"
    )
    status, paid_changed_at, paid_at, failed_at = times()
    assert (status, failed_at) == ("paid", None)
    assert paid_at == paid_changed_at != sent_at
    fake.payout_status = "failed"  # the bank returns a paid deposit
    assert (
        await service.process_webhook(**signed_event(event_id="evt_failed", kind="payout.failed"))
        == "updated"
    )
    final = times()
    assert final[0] == "failed" and final[2] == paid_at
    assert final[3] == final[1] != paid_changed_at
    fake.payout_status = "paid"  # a late paid read cannot reopen it
    assert (
        await service.process_webhook(**signed_event(event_id="evt_late", kind="payout.paid"))
        == "updated"
    )
    assert times() == final

    # A deposit first read already paid has no observed paid time to show.
    first_read_paid = bank_payouts._payout_fields(
        listed_payout("po_history", live=fake.livemode, status="paid"),
        payout_id="po_history",
        livemode=fake.livemode,
        observed_at=datetime.now(UTC),
    )
    with engine.begin() as connection:
        assert StripeConnectBankPayouts._store_payout(
            connection, account_id="acct_owner", livemode=fake.livemode, snapshot=first_read_paid
        )
    history = stored_payout(engine, "po_history")
    assert (history["status"], history["paid_at"]) == ("paid", None)


@pytest.mark.asyncio
async def test_bank_snapshot_is_write_once_and_survives_ids_and_deleted_bank_stubs(world):
    # A deposit keeps showing the bank it went to after the owner removes or
    # replaces that bank at Stripe.
    service, fake, engine = world
    fake.payout_status = "paid"
    fake.payout_details = {
        "destination": "ba_first",  # not expanded
        "method": "standard",
        "automatic": True,
        "trace_id": {"status": "pending", "value": None},
    }
    assert (
        await service.process_webhook(**signed_event(event_id="evt_paid", kind="payout.paid"))
        == "updated"
    )
    payout = (await service.owner_summary(user_id="owner"))["payouts"][0]
    assert (payout["bank"], payout["bankReference"]) == (None, None)

    fake.payout_details = {
        "destination": EXAMPLE_BANK,
        "trace_id": {"status": "supported", "value": "TRACE 0042"},
    }
    assert (
        await service.process_webhook(
            **signed_event(event_id="evt_expanded", kind="payout.updated")
        )
        == "updated"
    )
    for index, destination in enumerate(
        [
            {"id": "ba_first", "object": "bank_account", "deleted": True},
            {"id": "ba_other", "object": "bank_account", "bank_name": "Other", "last4": "1111"},
            {"id": "acct_owner", "object": "bank_account", "bank_name": "Odd", "last4": "0000"},
            None,
        ]
    ):
        # Each later read also moves the arrival date, so it is applied.
        fake.payout_arrival += 86_400
        fake.payout_details = {"destination": destination}
        assert (
            await service.process_webhook(
                **signed_event(event_id=f"evt_later_{index}", kind="payout.updated")
            )
            == "updated"
        )

    response = await service.owner_summary(user_id="owner")
    payout = response["payouts"][0]
    assert (
        payout["expectedArrivalAt"] == datetime.fromtimestamp(fake.payout_arrival, UTC).isoformat()
    )
    assert payout["bank"] == {"name": "Example Bank", "last4": "6789"}
    assert payout["bankReference"] == "TRACE 0042"
    assert "ba_" not in json.dumps(response) and "acct_" not in json.dumps(response)
    row = stored_payout(engine)
    assert (
        row["destination_id"],
        row["destination_kind"],
        row["payout_method"],
        bool(row["automatic"]),
        row["trace_status"],
    ) == ("ba_first", "bank_account", "standard", True, "supported")
    assert service.notices == [doorbell("bank_payouts")] * 6


@pytest.mark.asyncio
async def test_scan_backfills_the_snapshot_of_deposits_recorded_before_it(world):
    service, fake, engine = world
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO stripe_connect_bank_payouts
              (stripe_payout_id,stripe_account_id,livemode,amount_cents,currency,status,
               status_rank,expected_arrival_at,created_at)
              VALUES ('po_before','acct_owner',:live,911,'usd','paid',2,:arrival,:created)"""),
            {
                "live": fake.livemode,
                "arrival": datetime.fromtimestamp(1_800_000_000, UTC),
                "created": datetime.fromtimestamp(1_700_000_000, UTC),
            },
        )
    fake.list_payouts = [
        listed_payout(
            "po_before",
            live=fake.livemode,
            status="paid",
            destination=EXAMPLE_BANK,
            method="standard",
            automatic=True,
        )
    ]
    assert (await service.reconcile_due())["bank_payouts_changed"] == 1
    payout = (await service.owner_summary(user_id="owner"))["payouts"][0]
    assert (payout["id"], payout["status"], payout["paidAt"]) == ("po_before", "paid", None)
    assert payout["bank"] == {"name": "Example Bank", "last4": "6789"}
    assert service.notices == [doorbell("bank_payouts")]


@pytest.mark.asyncio
@pytest.mark.parametrize("world", ["test", "live"], indirect=True)
async def test_owner_summary_pages_by_cursor_without_duplicates_or_gaps(world):
    service, fake, engine = world
    base = datetime(2026, 10, 1, tzinfo=UTC)
    created = {f"po_{index:03d}": base + timedelta(seconds=index // 2) for index in range(45)}
    insert = text("""INSERT INTO stripe_connect_bank_payouts
      (stripe_payout_id,stripe_account_id,livemode,amount_cents,currency,status,status_rank,
       created_at) VALUES (:id,:account,:live,100,'usd','paid',2,:created)""")
    with engine.begin() as connection:
        for payout_id, at in created.items():  # pairs share a creation second
            connection.execute(
                insert,
                {"id": payout_id, "account": "acct_owner", "live": fake.livemode, "created": at},
            )
        for payout_id, account, live in (
            ("po_other_owner", "acct_other", fake.livemode),
            ("po_other_mode", "acct_owner", not fake.livemode),
        ):
            connection.execute(
                insert, {"id": payout_id, "account": account, "live": live, "created": base}
            )
    expected = sorted(created, key=lambda payout_id: (created[payout_id], payout_id), reverse=True)

    seen, sizes, cursor = [], [], None
    while True:
        page = await service.owner_summary(user_id="owner", cursor=cursor)
        sizes.append(len(page["payouts"]))
        seen.extend(payout["id"] for payout in page["payouts"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
        if len(sizes) == 1:
            # A deposit created between pages joins the head, never a later page.
            with engine.begin() as connection:
                connection.execute(
                    insert,
                    {
                        "id": "po_new",
                        "account": "acct_owner",
                        "live": fake.livemode,
                        "created": base + timedelta(days=1),
                    },
                )
    assert sizes == [20, 20, 5]
    assert seen == expected
    head = (await service.owner_summary(user_id="owner"))["payouts"][0]
    assert set(head) == {
        "id",
        "amountCents",
        "status",
        "expectedArrivalAt",
        "failureCode",
        "createdAt",
        "paidAt",
        "failedAt",
        "bank",
        "bankReference",
    }
    assert (head["id"], head["createdAt"]) == ("po_new", (base + timedelta(days=1)).isoformat())

    def opaque(body):
        return base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")

    other_mode = "live" if service.mode == "test" else "test"
    for cursor in (
        "",
        "not a cursor!",
        "A" * 257,
        opaque([1]),
        opaque({"v": 1, "m": service.mode, "t": 0, "id": "acct_owner"}),
        opaque({"v": True, "m": service.mode, "t": 0, "id": "po_001"}),
        opaque({"v": 1, "m": other_mode, "t": 0, "id": "po_001"}),
        opaque({"v": 1, "m": service.mode, "t": -1, "id": "po_001"}),
        opaque({"v": 1, "m": service.mode, "t": 0, "id": "po_001", "x": 1}),
    ):
        with pytest.raises(ConnectBankPayoutError, match="invalid_cursor"):
            await service.owner_summary(user_id="owner", cursor=cursor)


@pytest.mark.asyncio
async def test_balance_and_reconciliation_events_reach_the_connect_ledger(world):
    service, fake, engine = world
    balance = signed_event(event_id="evt_balance", kind="balance.available")
    assert await service.process_webhook(**balance) == "updated"
    due = ("refresh_due", {"stripe_account_id": "acct_owner", "livemode": False})
    assert service.ledger_calls == [due]
    assert service.notices == [doorbell("balance")]
    assert fake.retrieve_calls == []  # the worker reads the balance, not the webhook
    # A redelivery is recorded once and repeats nothing; unknown accounts never reach the ledger.
    assert await service.process_webhook(**balance) == "duplicate"
    unknown = signed_event(event_id="evt_unknown", kind="balance.available", account="acct_x1")
    assert await service.process_webhook(**unknown) == "ignored_account"
    assert service.ledger_calls == [due]
    malformed = json.loads(event(event_id="evt_malformed", kind="balance.available"))
    malformed["data"]["object"]["object"] = "payout"
    raw = json.dumps(malformed).encode()
    with pytest.raises(ConnectBankPayoutError, match="invalid_event"):
        await service.process_webhook(payload=raw, signature=signature(raw))

    service.notices.clear()
    service.ledger_calls.clear()
    fake.payout_status = "paid"
    fake.payout_details = {"automatic": True, "reconciliation_status": "in_progress"}
    paid = signed_event(event_id="evt_paid", kind="payout.paid")
    assert await service.process_webhook(**paid) == "updated"
    assert service.ledger_calls == []  # Stripe has not itemised it yet
    fake.payout_details = {"automatic": True, "reconciliation_status": "completed"}
    reconciled = signed_event(event_id="evt_reconciled", kind="payout.reconciliation_completed")
    assert await service.process_webhook(**reconciled) == "updated"
    queued = ("reconcile", {"stripe_payout_id": "po_one", "stripe_account_id": "acct_owner"})
    assert service.ledger_calls == [queued]
    assert fake.retrieve_calls[-1][1]["expand"] == ["destination"]
    reads = len(fake.retrieve_calls)
    assert await service.process_webhook(**reconciled) == "duplicate"
    assert (service.ledger_calls, len(fake.retrieve_calls)) == ([queued], reads)
    paid_again = signed_event(event_id="evt_paid_again", kind="payout.paid")
    assert await service.process_webhook(**paid_again) == "updated"
    updated = signed_event(event_id="evt_updated", kind="payout.updated")
    assert await service.process_webhook(**updated) == "updated"
    assert service.ledger_calls == [queued, queued]  # idempotent queue; updates never queue
    assert service.notices == [doorbell("bank_payouts")] * 2
    with engine.begin() as connection:
        ledgered = connection.execute(
            text("SELECT event_type FROM stripe_connect_bank_payout_events")
        ).scalars()
        # Release replay of migrations 298/304 only widens the CHECK, so both new types are kept.
        assert sorted(ledgered) == [
            "balance.available",
            "payout.paid",
            "payout.paid",
            "payout.reconciliation_completed",
            "payout.updated",
        ]
