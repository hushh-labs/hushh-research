"""An explicit bank refresh stays authenticated and never accepts an owner selector."""

# ruff: noqa: F811 -- imported shared provider fixtures

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import answer_requests as answers
from api.routes.one import payouts
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError
from tests.test_pkm_payouts import stripe_env, world  # noqa: F401 -- shared provider fixtures


def test_answer_onboarding_binds_authenticated_owner_and_rejects_overrides(monkeypatch):
    from uuid import uuid4

    attempt = str(uuid4())
    onboarding = AsyncMock(return_value={"url": "https://connect.stripe.com/setup/synthetic"})
    monkeypatch.setattr(answers, "_payout_mode_allowed", lambda: True)
    monkeypatch.setattr(answers, "_payouts", lambda: SimpleNamespace(onboarding_link=onboarding))
    app = FastAPI()
    app.include_router(answers.router)
    client = TestClient(app)
    path = "/api/one/answer-requests/payout-account/onboarding"
    assert client.post(path, json={"attempt_id": attempt}).status_code == 401
    onboarding.assert_not_awaited()
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    for body in (
        {"attempt_id": "invalid"},
        {"attempt_id": attempt, "owner": "another"},
        {"attempt_id": attempt, "account": "acct_other"},
        {"attempt_id": attempt, "mode": "live"},
    ):
        assert client.post(path, json=body).status_code == 422
    onboarding.assert_not_awaited()
    response = client.post(path, json={"attempt_id": attempt})
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    onboarding.assert_awaited_once_with(
        user_id="owner", surface="answers", purpose="onboarding", attempt_id=attempt
    )
    assert client.post(path).status_code == 200
    onboarding.assert_awaited_with(user_id="owner", surface="answers", purpose="onboarding")


def test_refresh_is_authenticated_owner_scoped_and_private(monkeypatch):
    account_status = AsyncMock(return_value={"account": None, "stripeMode": "live"})
    monkeypatch.setattr(
        payouts, "_document_service", lambda: SimpleNamespace(account_status=account_status)
    )
    app = FastAPI()
    app.include_router(payouts.router)
    client = TestClient(app)
    assert client.get("/api/one/payouts/account?fresh=true").status_code == 401
    account_status.assert_not_called()

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = client.get("/api/one/payouts/account?fresh=true&user_id=other")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    account_status.assert_awaited_once_with(user_id="owner", force_refresh=True)
    assert client.get("/api/one/payouts/account").status_code == 200
    account_status.assert_awaited_with(user_id="owner", force_refresh=False)
    assert client.get("/api/one/payouts/account?fresh=not-a-boolean").status_code == 422


@pytest.mark.parametrize("surface", ["documents", "answers"])
async def test_correlated_onboarding_preserves_settlement_source_and_refuses_expired_receipts(
    world, stripe_env, monkeypatch, surface
):
    from urllib.parse import parse_qs, urlsplit
    from uuid import uuid4

    svc, _db, fake = world
    attempt = str(uuid4())
    session = await svc.onboarding_link(user_id="owner", surface=surface, attempt_id=attempt)
    callback = urlsplit(session["return_url"])
    assert callback.path == "/one/profile/payouts"
    assert parse_qs(callback.query) == {
        "commerceAttemptId": [attempt],
        "commerceReturn": ["1"],
        "commerceSource": [surface],
    }
    await svc.onboarding_link(user_id="owner", surface=surface, attempt_id=attempt)
    assert len(fake.accounts) == 1
    assert fake.links[-1]["idempotency_key"] == fake.links[-2]["idempotency_key"]
    original = fake.AccountLink.create
    for receipt in (
        {"object": "account_link", "url": session["url"], "expires_at": int(time.time()) - 1},
        {
            "object": "account_link",
            "url": "https://evil.invalid/",
            "expires_at": int(time.time()) + 300,
        },
    ):
        monkeypatch.setattr(fake.AccountLink, "create", lambda receipt=receipt, **_kw: receipt)
        with pytest.raises(PacketOrderError, match="Get a new payout setup link"):
            await svc.onboarding_link(user_id="owner", surface=surface, attempt_id=attempt)
    monkeypatch.setattr(fake.AccountLink, "create", original)
    fresh = str(uuid4())
    assert (await svc.onboarding_link(user_id="owner", surface=surface, attempt_id=fresh))[
        "attempt_id"
    ] == fresh
    assert len(fake.accounts) == 1
