"""Zero-knowledge Plaid passthrough routes (/api/kai/plaid/vault/*).

Founder decision 2026-09-23: the access token lives in the owner's vault, the
server stores nothing and logs no bodies. UAT's Plaid is PRODUCTION, so Plaid
is never called here: the HTTP client is replaced by a scripted fake.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai import plaid_vault
from api.routes.kai import router as kai_router
from hushh_mcp.integrations.plaid import PlaidApiError, PlaidRuntimeConfig

_BASE = "/api/kai/plaid/vault"
_ACCESS_TOKEN = "access-sandbox-11111111-2222-3333-4444-555555555555"  # noqa: S105
_PUBLIC_TOKEN = "public-sandbox-66666666-7777-8888-9999-000000000000"  # noqa: S105
_REDIRECT_URI = "https://one.hushh.ai/one/kai/plaid/oauth/return"


def _config() -> PlaidRuntimeConfig:
    return PlaidRuntimeConfig(
        environment="sandbox",
        base_url="https://sandbox.plaid.com",
        client_id="plaid_client",
        secret="plaid_secret",  # noqa: S106 - test fixture value only
        country_codes=["US"],
        language="en",
        client_name="Hussh Kai",
        # Configured on purpose: the vault flow must still never send it.
        webhook_url="https://api.hushh.ai/api/kai/plaid/webhook",
        frontend_url="https://one.hushh.ai",
        redirect_path="/one/kai/plaid/oauth/return",
        redirect_uri=_REDIRECT_URI,
        tx_history_days=730,
        manual_entry_enabled=False,
        crypto_wallet_enabled=False,
    )


def _plaid_error(code: str, error_type: str, status_code: int = 400) -> PlaidApiError:
    return PlaidApiError(
        message=f"plaid said {code} for {_ACCESS_TOKEN}",
        status_code=status_code,
        error_code=code,
        error_type=error_type,
        payload={"echo": _ACCESS_TOKEN},
    )


class _FakePlaid:
    """Scripted stand-in for PlaidHttpClient. Each path maps to a list of
    responses consumed in order (an exception instance is raised)."""

    def __init__(self, script: dict[str, list[Any]]) -> None:
        self.script = {path: list(responses) for path, responses in script.items()}
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((path, payload))
        responses = self.script.get(path)
        if not responses:
            raise AssertionError(f"unexpected Plaid call {path}")
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def paths(self) -> list[str]:
        return [path for path, _payload in self.calls]


def _item(products: list[str], *, error: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "item": {
            "item_id": "item-1",
            "institution_id": "ins_1",
            "products": products,
            "consented_products": [*products, "identity"],
            "error": error,
        }
    }


_ACCOUNT = {
    "account_id": "acc-1",
    "persistent_account_id": "persist-1",
    "name": "Brokerage",
    "mask": "0000",
    "type": "investment",
    "subtype": "brokerage",
    "balances": {"current": 1000.5, "available": None, "iso_currency_code": "USD"},
}
_HOLDING = {
    "account_id": "acc-1",
    "security_id": "sec-1",
    "quantity": 3.0,
    "institution_value": 600.0,
    "cost_basis": 450.0,
}
_SECURITY = {
    "security_id": "sec-1",
    "ticker_symbol": "AAPL",
    "name": "Apple Inc.",
    "type": "equity",
    "cusip": "037833100",
}


def _txn(transaction_id: str) -> dict[str, Any]:
    return {
        "transaction_id": transaction_id,
        "account_id": "acc-1",
        "amount": 12.34,
        "date": "2026-09-20",
        "authorized_date": "2026-09-19",
        "merchant_name": "Coffee",
        "name": "COFFEE 123",
        "personal_finance_category": {"primary": "FOOD_AND_DRINK"},
        "pending": False,
    }


@pytest.fixture
def app() -> FastAPI:
    application = FastAPI()
    application.include_router(kai_router)
    return application


@pytest.fixture
def authed_client(app: FastAPI, monkeypatch: pytest.MonkeyPatch):
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner-123"}
    monkeypatch.setattr(plaid_vault, "_plaid_config", _config)
    return TestClient(app)


def _use(monkeypatch: pytest.MonkeyPatch, fake: _FakePlaid) -> _FakePlaid:
    monkeypatch.setattr(plaid_vault, "_plaid_client", lambda: fake)
    return fake


# ---------------------------------------------------------------------------
# /link-token
# ---------------------------------------------------------------------------


def test_link_token_web_happy_path_has_no_webhook_and_opaque_user(authed_client, monkeypatch):
    fake = _use(
        monkeypatch,
        _FakePlaid({"/link/token/create": [{"link_token": "link-1", "expiration": "2026-09-24"}]}),
    )

    response = authed_client.post(
        f"{_BASE}/link-token", json={"platform": "web", "redirect_uri": _REDIRECT_URI}
    )

    assert response.status_code == 200
    assert response.json() == {"link_token": "link-1", "expiration": "2026-09-24"}
    assert response.headers["cache-control"] == "no-store"
    (path, payload) = fake.calls[0]
    assert path == "/link/token/create"
    assert "webhook" not in payload
    assert payload["redirect_uri"] == _REDIRECT_URI
    assert "android_package_name" not in payload
    assert "sandbox_proof" not in payload
    assert payload["products"]
    client_user_id = payload["user"]["client_user_id"]
    assert "owner-123" not in client_user_id
    assert client_user_id.startswith("hv1_")
    # Stable per owner so Plaid can recognise a returning person.
    assert client_user_id == plaid_vault._client_user_id("owner-123")
    assert client_user_id != plaid_vault._client_user_id("owner-456")


def test_link_token_sandbox_proof_allows_local_sandbox_before_issuing_token(
    authed_client, monkeypatch
):
    for name in (
        "ENVIRONMENT",
        "HUSHH_DEPLOY_ENV",
        "APP_RUNTIME_PROFILE",
        "HUSHH_LOCAL_PLAID_SANDBOX_PROOF",
        "K_SERVICE",
        "K_REVISION",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("HUSHH_LOCAL_PLAID_SANDBOX_PROOF", "true")
    fake = _use(
        monkeypatch,
        _FakePlaid(
            {"/link/token/create": [{"link_token": "link-sandbox-proof", "expiration": "x"}]}
        ),
    )

    response = authed_client.post(
        f"{_BASE}/link-token",
        json={"platform": "web", "sandbox_proof": True},
    )

    assert response.status_code == 200
    assert response.json()["link_token"] == "link-sandbox-proof"
    assert "sandbox_proof" not in fake.calls[0][1]


@pytest.mark.parametrize(
    ("provider_environment", "deployment_values"),
    [
        ("development", {"ENVIRONMENT": "local", "HUSHH_LOCAL_PLAID_SANDBOX_PROOF": "true"}),
        ("production", {"ENVIRONMENT": "local", "HUSHH_LOCAL_PLAID_SANDBOX_PROOF": "true"}),
        ("sandbox", {"ENVIRONMENT": "uat"}),
        ("sandbox", {"ENVIRONMENT": "production"}),
        ("sandbox", {}),
        (
            "sandbox",
            {
                "ENVIRONMENT": "development",
                "HUSHH_DEPLOY_ENV": "uat",
                "HUSHH_LOCAL_PLAID_SANDBOX_PROOF": "true",
            },
        ),
        ("sandbox", {"ENVIRONMENT": "dev", "HUSHH_LOCAL_PLAID_SANDBOX_PROOF": "true"}),
        ("sandbox", {"ENVIRONMENT": "local"}),
        (
            "sandbox",
            {
                "ENVIRONMENT": "local",
                "HUSHH_LOCAL_PLAID_SANDBOX_PROOF": "true",
                "K_SERVICE": "hosted-service",
            },
        ),
    ],
)
def test_link_token_sandbox_proof_rejects_nonlocal_or_non_sandbox_before_plaid_call(
    authed_client,
    monkeypatch,
    provider_environment: str,
    deployment_values: dict[str, str],
):
    for name in (
        "ENVIRONMENT",
        "HUSHH_DEPLOY_ENV",
        "APP_RUNTIME_PROFILE",
        "HUSHH_LOCAL_PLAID_SANDBOX_PROOF",
        "K_SERVICE",
        "K_REVISION",
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in deployment_values.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(
        plaid_vault, "_plaid_config", lambda: replace(_config(), environment=provider_environment)
    )
    fake = _use(monkeypatch, _FakePlaid({}))

    response = authed_client.post(
        f"{_BASE}/link-token",
        json={"platform": "web", "sandbox_proof": True},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "PLAID_SANDBOX_PROOF_FORBIDDEN"
    assert response.headers["cache-control"] == "no-store"
    assert fake.calls == []


def test_link_token_android_carries_package_name_and_no_redirect(authed_client, monkeypatch):
    fake = _use(
        monkeypatch,
        _FakePlaid({"/link/token/create": [{"link_token": "link-a", "expiration": "x"}]}),
    )

    response = authed_client.post(
        f"{_BASE}/link-token", json={"platform": "android", "redirect_uri": _REDIRECT_URI}
    )

    assert response.status_code == 200
    payload = fake.calls[0][1]
    assert payload["android_package_name"]
    assert "redirect_uri" not in payload
    assert "webhook" not in payload


def test_link_token_rejects_foreign_redirect_uri(authed_client, monkeypatch):
    fake = _use(monkeypatch, _FakePlaid({}))

    response = authed_client.post(
        f"{_BASE}/link-token",
        json={"platform": "web", "redirect_uri": "https://evil.example/one/kai/plaid/oauth/return"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "PLAID_REDIRECT_URI_INVALID"
    assert response.headers["cache-control"] == "no-store"
    assert fake.calls == []


def test_request_models_forbid_extra_fields(authed_client, monkeypatch):
    _use(monkeypatch, _FakePlaid({}))

    response = authed_client.post(
        f"{_BASE}/link-token", json={"platform": "web", "user_id": "someone-else"}
    )

    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


def test_validation_error_never_echoes_the_token(authed_client, monkeypatch):
    _use(monkeypatch, _FakePlaid({}))
    bad_token = "access-production-" + "x" * 300

    response = authed_client.post(f"{_BASE}/snapshot", json={"access_token": bad_token})

    assert response.status_code == 422
    assert bad_token not in response.text
    assert "x" * 300 not in response.text
    assert response.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# /exchange
# ---------------------------------------------------------------------------


def test_exchange_returns_token_item_and_institution(authed_client, monkeypatch):
    fake = _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/public_token/exchange": [
                    {"access_token": _ACCESS_TOKEN, "item_id": "item-1"}
                ],
                "/item/get": [_item(["transactions", "investments"])],
                "/institutions/get_by_id": [{"institution": {"name": "Big Broker"}}],
            }
        ),
    )

    response = authed_client.post(f"{_BASE}/exchange", json={"public_token": _PUBLIC_TOKEN})

    assert response.status_code == 200
    assert response.json() == {
        "access_token": _ACCESS_TOKEN,
        "item_id": "item-1",
        "institution": {"id": "ins_1", "name": "Big Broker"},
        "products": ["transactions", "investments"],
        "consented_products": ["transactions", "investments", "identity"],
    }
    assert response.headers["cache-control"] == "no-store"
    assert fake.paths() == [
        "/item/public_token/exchange",
        "/item/get",
        "/institutions/get_by_id",
    ]
    assert fake.calls[2][1]["institution_id"] == "ins_1"


def test_exchange_keeps_token_when_enrichment_fails(authed_client, monkeypatch):
    _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/public_token/exchange": [
                    {"access_token": _ACCESS_TOKEN, "item_id": "item-1"}
                ],
                "/item/get": [_plaid_error("INTERNAL_SERVER_ERROR", "API_ERROR", 500)],
            }
        ),
    )

    response = authed_client.post(f"{_BASE}/exchange", json={"public_token": _PUBLIC_TOKEN})

    assert response.status_code == 200
    body = response.json()
    assert body["access_token"] == _ACCESS_TOKEN
    assert body["institution"] is None
    assert body["products"] == []


def test_exchange_invalid_public_token_is_a_safe_400(authed_client, monkeypatch):
    _use(
        monkeypatch,
        _FakePlaid(
            {"/item/public_token/exchange": [_plaid_error("INVALID_PUBLIC_TOKEN", "INVALID_INPUT")]}
        ),
    )

    response = authed_client.post(f"{_BASE}/exchange", json={"public_token": _PUBLIC_TOKEN})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "INVALID_PUBLIC_TOKEN"
    assert _ACCESS_TOKEN not in response.text
    assert "payload" not in response.json()["detail"]
    assert response.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# /snapshot
# ---------------------------------------------------------------------------


def test_snapshot_happy_path_passes_plaid_fields_through(authed_client, monkeypatch):
    fake = _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [_item(["transactions", "investments"])],
                "/accounts/get": [{"accounts": [_ACCOUNT]}],
                "/investments/holdings/get": [
                    {"accounts": [_ACCOUNT], "holdings": [_HOLDING], "securities": [_SECURITY]}
                ],
                "/transactions/sync": [
                    {
                        "added": [_txn("t1")],
                        "modified": [],
                        "removed": [{"transaction_id": "t0"}],
                        "next_cursor": "cursor-1",
                        "has_more": False,
                    }
                ],
            }
        ),
    )

    response = authed_client.post(f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["item"] == {
        "item_id": "item-1",
        "institution_id": "ins_1",
        "products": ["transactions", "investments"],
        "consented_products": ["transactions", "investments", "identity"],
        "error": None,
    }
    assert body["accounts"] == [_ACCOUNT]
    assert body["investments"] == {"holdings": [_HOLDING], "securities": [_SECURITY]}
    assert body["transactions"]["added"] == [_txn("t1")]
    assert body["transactions"]["removed"] == [{"transaction_id": "t0"}]
    assert body["transactions"]["next_cursor"] == "cursor-1"
    assert body["transactions"]["pages"] == 1
    assert "cursor" not in fake.calls[-1][1]


def test_snapshot_item_login_required_is_200_with_item_error(authed_client, monkeypatch):
    fake = _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [
                    _item(
                        ["transactions"],
                        error={
                            "error_code": "ITEM_LOGIN_REQUIRED",
                            "error_type": "ITEM_ERROR",
                            "display_message": "Sign in to your bank again.",
                        },
                    )
                ]
            }
        ),
    )

    response = authed_client.post(f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN})

    assert response.status_code == 200
    body = response.json()
    assert body["item"]["error"]["code"] == "ITEM_LOGIN_REQUIRED"
    assert body["accounts"] == []
    assert body["transactions"] == {"unavailable": "ITEM_LOGIN_REQUIRED"}
    assert body["investments"] == {"unavailable": "ITEM_LOGIN_REQUIRED"}
    assert fake.paths() == ["/item/get"]


def test_snapshot_item_login_required_raised_by_accounts_is_200(authed_client, monkeypatch):
    _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [_item(["transactions"])],
                "/accounts/get": [_plaid_error("ITEM_LOGIN_REQUIRED", "ITEM_ERROR")],
            }
        ),
    )

    response = authed_client.post(f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN})

    assert response.status_code == 200
    body = response.json()
    assert body["item"]["error"]["code"] == "ITEM_LOGIN_REQUIRED"
    assert _ACCESS_TOKEN not in response.text


@pytest.mark.parametrize(
    "code", ["PRODUCTS_NOT_SUPPORTED", "NO_INVESTMENT_ACCOUNTS", "PRODUCT_NOT_READY"]
)
def test_snapshot_investments_unsupported_is_unavailable(authed_client, monkeypatch, code):
    _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [_item(["transactions", "investments"])],
                "/accounts/get": [{"accounts": [_ACCOUNT]}],
                "/investments/holdings/get": [_plaid_error(code, "ITEM_ERROR")],
                "/transactions/sync": [
                    {"added": [], "modified": [], "removed": [], "next_cursor": "c"}
                ],
            }
        ),
    )

    response = authed_client.post(f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN})

    assert response.status_code == 200
    body = response.json()
    assert body["investments"] == {"unavailable": code}
    assert body["item"]["error"] is None


def test_snapshot_skips_products_the_item_does_not_have(authed_client, monkeypatch):
    fake = _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [_item(["transactions"])],
                "/accounts/get": [{"accounts": [_ACCOUNT]}],
                "/transactions/sync": [
                    {"added": [], "modified": [], "removed": [], "next_cursor": "c"}
                ],
            }
        ),
    )

    response = authed_client.post(f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN})

    assert response.status_code == 200
    assert response.json()["investments"] == {"unavailable": "PRODUCTS_NOT_SUPPORTED"}
    # Calling holdings on an Item without investments would add (and bill) it.
    assert "/investments/holdings/get" not in fake.paths()


def test_snapshot_transactions_pages_from_cursor_and_returns_final_cursor(
    authed_client, monkeypatch
):
    fake = _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [_item(["transactions"])],
                "/accounts/get": [{"accounts": [_ACCOUNT]}],
                "/transactions/sync": [
                    {
                        "added": [_txn("t1")],
                        "modified": [],
                        "removed": [],
                        "next_cursor": "c2",
                        "has_more": True,
                    },
                    {
                        "added": [_txn("t2")],
                        "modified": [_txn("t1")],
                        "removed": [],
                        "next_cursor": "c3",
                        "has_more": False,
                    },
                ],
            }
        ),
    )

    response = authed_client.post(
        f"{_BASE}/snapshot",
        json={"access_token": _ACCESS_TOKEN, "transactions_cursor": "c1"},
    )

    assert response.status_code == 200
    transactions = response.json()["transactions"]
    assert [t["transaction_id"] for t in transactions["added"]] == ["t1", "t2"]
    assert [t["transaction_id"] for t in transactions["modified"]] == ["t1"]
    assert transactions["next_cursor"] == "c3"
    assert transactions["pages"] == 2
    assert transactions["has_more"] is False
    sync_cursors = [
        payload.get("cursor") for path, payload in fake.calls if path == "/transactions/sync"
    ]
    assert sync_cursors == ["c1", "c2"]


def test_snapshot_transactions_paging_is_capped(authed_client, monkeypatch):
    pages = [
        {"added": [], "modified": [], "removed": [], "next_cursor": f"c{n}", "has_more": True}
        for n in range(plaid_vault.TRANSACTIONS_SYNC_MAX_PAGES + 5)
    ]
    _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [_item(["transactions"])],
                "/accounts/get": [{"accounts": []}],
                "/transactions/sync": pages,
            }
        ),
    )

    response = authed_client.post(f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN})

    transactions = response.json()["transactions"]
    assert transactions["pages"] == plaid_vault.TRANSACTIONS_SYNC_MAX_PAGES
    assert transactions["has_more"] is True
    assert transactions["next_cursor"] == f"c{plaid_vault.TRANSACTIONS_SYNC_MAX_PAGES - 1}"


def test_snapshot_transactions_restart_once_on_mutation_during_pagination(
    authed_client, monkeypatch
):
    fake = _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [_item(["transactions"])],
                "/accounts/get": [{"accounts": []}],
                "/transactions/sync": [
                    {"added": [_txn("t1")], "next_cursor": "c2", "has_more": True},
                    _plaid_error(
                        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "TRANSACTIONS_ERROR"
                    ),
                    {"added": [_txn("t1b")], "next_cursor": "c9", "has_more": False},
                ],
            }
        ),
    )

    response = authed_client.post(
        f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN, "transactions_cursor": "c1"}
    )

    transactions = response.json()["transactions"]
    assert [t["transaction_id"] for t in transactions["added"]] == ["t1b"]
    assert transactions["next_cursor"] == "c9"
    sync_cursors = [
        payload.get("cursor") for path, payload in fake.calls if path == "/transactions/sync"
    ]
    assert sync_cursors == ["c1", "c2", "c1"]


def test_snapshot_invalid_access_token_is_a_safe_400(authed_client, monkeypatch):
    _use(
        monkeypatch,
        _FakePlaid({"/item/get": [_plaid_error("INVALID_ACCESS_TOKEN", "INVALID_INPUT")]}),
    )

    response = authed_client.post(f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "INVALID_ACCESS_TOKEN"
    assert _ACCESS_TOKEN not in response.text
    assert response.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# /remove
# ---------------------------------------------------------------------------


def test_remove_revokes_item(authed_client, monkeypatch):
    fake = _use(monkeypatch, _FakePlaid({"/item/remove": [{"request_id": "r"}]}))

    response = authed_client.post(f"{_BASE}/remove", json={"access_token": _ACCESS_TOKEN})

    assert response.status_code == 200
    assert response.json() == {"removed": True}
    assert response.headers["cache-control"] == "no-store"
    assert fake.calls == [("/item/remove", {"access_token": _ACCESS_TOKEN})]


def test_remove_is_idempotent_for_an_already_removed_item(authed_client, monkeypatch):
    _use(
        monkeypatch,
        _FakePlaid({"/item/remove": [_plaid_error("ITEM_NOT_FOUND", "ITEM_ERROR")]}),
    )

    response = authed_client.post(f"{_BASE}/remove", json={"access_token": _ACCESS_TOKEN})

    assert response.status_code == 200
    assert response.json() == {"removed": True}


# ---------------------------------------------------------------------------
# Auth, storage and logging guarantees
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("link-token", {"platform": "web"}),
        ("exchange", {"public_token": _PUBLIC_TOKEN}),
        ("snapshot", {"access_token": _ACCESS_TOKEN}),
        ("remove", {"access_token": _ACCESS_TOKEN}),
    ],
)
def test_every_endpoint_requires_a_vault_owner_token(app, monkeypatch, path, body):
    fake = _use(monkeypatch, _FakePlaid({}))
    monkeypatch.setattr(plaid_vault, "_plaid_config", _config)
    client = TestClient(app)

    missing = client.post(f"{_BASE}/{path}", json=body)
    invalid = client.post(
        f"{_BASE}/{path}", json=body, headers={"Authorization": "Bearer HCT:not-a-token"}
    )

    assert missing.status_code == 401
    assert invalid.status_code in {401, 403}
    assert missing.headers["cache-control"] == "no-store"
    assert fake.calls == []


def test_wrong_scope_consent_token_is_refused(app, monkeypatch):
    from api import middleware
    from hushh_mcp.consent.token import issue_token, validate_token
    from hushh_mcp.constants import ConsentScope

    async def _offline_validation(token, required_scope):  # noqa: ANN001
        return validate_token(token, required_scope)

    monkeypatch.setattr(middleware, "validate_token_with_db", _offline_validation)
    fake = _use(monkeypatch, _FakePlaid({}))
    monkeypatch.setattr(plaid_vault, "_plaid_config", _config)
    token = issue_token(
        user_id="owner-123",
        agent_id="agent",
        scope=ConsentScope.PKM_READ,
    ).token

    response = TestClient(app).post(
        f"{_BASE}/snapshot",
        json={"access_token": _ACCESS_TOKEN},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code in {401, 403}
    assert fake.calls == []


def test_endpoints_never_touch_the_database(authed_client, monkeypatch):
    import db.db_client as db_client
    from hushh_mcp.services import plaid_portfolio_service

    def _forbidden(*_args, **_kwargs):
        raise AssertionError("plaid vault routes must never touch the database")

    monkeypatch.setattr(db_client, "get_db", _forbidden)
    monkeypatch.setattr(plaid_portfolio_service, "get_db", _forbidden)
    _use(
        monkeypatch,
        _FakePlaid(
            {
                "/link/token/create": [{"link_token": "l", "expiration": "e"}],
                "/item/public_token/exchange": [
                    {"access_token": _ACCESS_TOKEN, "item_id": "item-1"}
                ],
                "/item/get": [_item(["transactions"]), _item(["transactions"])],
                "/institutions/get_by_id": [{"institution": {"name": "Bank"}}],
                "/accounts/get": [{"accounts": [_ACCOUNT]}],
                "/transactions/sync": [{"added": [], "next_cursor": "c"}],
                "/item/remove": [{}],
            }
        ),
    )

    assert authed_client.post(f"{_BASE}/link-token", json={}).status_code == 200
    assert (
        authed_client.post(f"{_BASE}/exchange", json={"public_token": _PUBLIC_TOKEN}).status_code
        == 200
    )
    assert (
        authed_client.post(f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN}).status_code
        == 200
    )
    assert (
        authed_client.post(f"{_BASE}/remove", json={"access_token": _ACCESS_TOKEN}).status_code
        == 200
    )


def test_module_has_no_storage_imports():
    source = Path(plaid_vault.__file__).read_text(encoding="utf-8")
    for forbidden in ("db.db_client", "get_db", "get_plaid_portfolio_service", "webhook_url"):
        assert forbidden not in source, forbidden


def test_failures_never_log_tokens(authed_client, monkeypatch, caplog):
    _use(
        monkeypatch,
        _FakePlaid(
            {
                "/item/get": [_plaid_error("INVALID_ACCESS_TOKEN", "INVALID_INPUT")],
                "/item/remove": [RuntimeError(f"boom {_ACCESS_TOKEN}")],
            }
        ),
    )

    with caplog.at_level(logging.DEBUG):
        authed_client.post(f"{_BASE}/snapshot", json={"access_token": _ACCESS_TOKEN})
        authed_client.post(f"{_BASE}/remove", json={"access_token": _ACCESS_TOKEN})

    assert caplog.records, "failures should still be observable by code"
    for record in caplog.records:
        assert _ACCESS_TOKEN not in record.getMessage()
        assert not record.exc_info or _ACCESS_TOKEN not in str(record.exc_info[1])
