from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.kai.plaid as plaid_routes


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(plaid_routes.router)
    app.dependency_overrides[plaid_routes.require_vault_owner_token] = lambda: {
        "user_id": "user_123"
    }
    app.dependency_overrides[plaid_routes.require_transfer_scope_token] = lambda: {
        "user_id": "user_123"
    }
    return app


class _FakePlaidPortfolioService:
    async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
        assert user_id == "user_123"
        assert resume_session_id == "resume_funding_123"
        return None

    async def handle_webhook(self, payload: dict):
        return {
            "accepted": True,
            "handled": True,
            "source": "portfolio",
            "item_id": payload.get("item_id"),
        }


class _FakeFundingService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.last_webhook_headers: dict[str, str] | None = None

    def _funding_status_payload(self, *, user_id: str) -> dict:
        return {
            "configured": True,
            "user_id": user_id,
            "items": [
                {
                    "item_id": "item_123",
                    "selected_funding_account_id": "acc_123",
                    "accounts": [
                        {
                            "account_id": "acc_123",
                            "mask": "0000",
                            "type": "depository",
                            "subtype": "checking",
                            "is_default": True,
                            "is_selected_funding_account": True,
                            "auth_summary": {
                                "has_ach_numbers": True,
                                "verification_status": "automatically_verified",
                                "is_tokenized_account_number": False,
                                "network_status": {"ach": "supported"},
                                "auth_fetched_at": "2026-04-23T10:15:00Z",
                                "auth_fingerprint": "auth_fp_123",
                            },
                        }
                    ],
                }
            ],
            "brokerage_accounts": [],
            "aggregate": {
                "item_count": 1,
                "account_count": 1,
                "institution_names": ["Test Bank"],
            },
            "readiness": {
                "plaid_item_linked": True,
                "eligible_funding_account_selected": True,
                "auth_snapshot_ready": True,
                "alpaca_account_linked": False,
                "processor_handoff_ready": False,
                "ach_relationship_ready": False,
                "blocking_reason": "ALPACA_ACCOUNT_REQUIRED",
            },
        }

    async def create_funding_link_token(self, **kwargs):
        self.calls.append(("create_funding_link_token", kwargs))
        return {
            "configured": True,
            "flow_type": "funding",
            "mode": "create",
            "link_token": "link_funding_123",
            "resume_session_id": "resume_funding_123",
        }

    async def get_oauth_resume(self, **kwargs):
        self.calls.append(("get_oauth_resume", kwargs))
        return {
            "configured": True,
            "flow_type": "funding",
            "mode": "create",
            "link_token": "link_funding_123",
            "resume_session_id": kwargs["resume_session_id"],
        }

    async def exchange_funding_public_token(self, **kwargs):
        self.calls.append(("exchange_funding_public_token", kwargs))
        return {
            **self._funding_status_payload(user_id=kwargs["user_id"]),
            "consent_record": {"consent_id": "consent_123"},
            "ach_relationship_pending_reason": {"code": "ALPACA_ACCOUNT_REQUIRED"},
        }

    async def get_funding_status(self, **kwargs):
        self.calls.append(("get_funding_status", kwargs))
        return self._funding_status_payload(user_id=kwargs["user_id"])

    async def create_alpaca_connect_link(self, **kwargs):
        self.calls.append(("create_alpaca_connect_link", kwargs))
        return {
            "configured": True,
            "authorization_url": "https://app.alpaca.markets/oauth/authorize?state=alpaca_state_123",
            "state": "alpaca_state_123",
        }

    async def complete_alpaca_connect_link(self, **kwargs):
        self.calls.append(("complete_alpaca_connect_link", kwargs))
        return {
            "configured": True,
            "user_id": kwargs["user_id"],
            "brokerage_accounts": [
                {
                    "alpaca_account_id": "bd47787e-bc27-4b8b-9653-48f14e23550a",
                    "status": "active",
                    "is_default": True,
                }
            ],
            "alpaca_connect": {
                "linked": True,
                "alpaca_account_id": "bd47787e-bc27-4b8b-9653-48f14e23550a",
            },
        }

    async def create_transfer(self, **kwargs):
        self.calls.append(("create_transfer", kwargs))
        return {
            "approved": True,
            "decision": "accepted",
            "transfer": {
                "transfer_id": "transfer_123",
                "status": "QUEUED",
                "amount": "100.00",
            },
            "relationship": {
                "relationship_id": "rel_123",
                "status": "APPROVED",
            },
        }

    async def create_funded_trade_intent(self, **kwargs):
        self.calls.append(("create_funded_trade_intent", kwargs))
        return {
            "decision": "accepted",
            "intent": {
                "intent_id": "intent_123",
                "status": "funding_pending",
                "symbol": kwargs["symbol"],
            },
            "transfer": {
                "transfer_id": "transfer_123",
                "status": "QUEUED",
            },
        }

    async def list_funded_trade_intents(self, **kwargs):
        self.calls.append(("list_funded_trade_intents", kwargs))
        return {
            "count": 1,
            "items": [{"intent_id": "intent_123", "status": "funding_pending"}],
        }

    async def get_funded_trade_intent(self, **kwargs):
        self.calls.append(("get_funded_trade_intent", kwargs))
        return {
            "intent": {
                "intent_id": kwargs["intent_id"],
                "status": "ready_to_trade",
            },
            "transfer": {
                "transfer_id": "transfer_123",
                "status": "SETTLED",
            },
        }

    async def get_transfer(self, **kwargs):
        self.calls.append(("get_transfer", kwargs))
        return {
            "transfer": {
                "transfer_id": kwargs["transfer_id"],
                "status": "SETTLED",
            },
            "reference": {
                "transfer_id": kwargs["transfer_id"],
                "relationship_id": "rel_123",
                "status": "SETTLED",
            },
        }

    async def handle_plaid_webhook(self, payload: dict, *, raw_body: bytes, headers: dict[str, str]):
        self.calls.append(
            (
                "handle_plaid_webhook",
                {
                    "payload": payload,
                    "raw_body": raw_body,
                },
            )
        )
        self.last_webhook_headers = headers
        if payload.get("item_id") == "funding_item_123":
            return {
                "accepted": True,
                "handled": True,
                "source": "funding",
                "item_id": payload["item_id"],
            }
        return {"accepted": True, "handled": False}


def test_route_level_plaid_to_alpaca_flow_sequence(monkeypatch):
    funding = _FakeFundingService()
    plaid = _FakePlaidPortfolioService()
    monkeypatch.setattr(plaid_routes, "get_broker_funding_service", lambda: funding)
    monkeypatch.setattr(plaid_routes, "get_plaid_portfolio_service", lambda: plaid)

    client = TestClient(_build_app())

    link_token_response = client.post(
        "/plaid/funding/link-token",
        json={
            "user_id": "user_123",
            "redirect_uri": "https://kai.hushh.ai/kai/plaid/oauth/return",
        },
    )
    assert link_token_response.status_code == 200
    assert link_token_response.json()["resume_session_id"] == "resume_funding_123"

    resume_response = client.post(
        "/plaid/oauth/resume",
        json={"user_id": "user_123", "resume_session_id": "resume_funding_123"},
    )
    assert resume_response.status_code == 200
    assert resume_response.json()["flow_type"] == "funding"

    exchange_response = client.post(
        "/plaid/funding/exchange-public-token",
        json={
            "user_id": "user_123",
            "public_token": "public_123",
            "resume_session_id": "resume_funding_123",
            "metadata": {"institution": {"name": "Test Bank"}},
        },
    )
    assert exchange_response.status_code == 200
    exchange_payload = exchange_response.json()
    assert exchange_payload["ach_relationship_pending_reason"]["code"] == "ALPACA_ACCOUNT_REQUIRED"
    assert exchange_payload["readiness"] == {
        "plaid_item_linked": True,
        "eligible_funding_account_selected": True,
        "auth_snapshot_ready": True,
        "alpaca_account_linked": False,
        "processor_handoff_ready": False,
        "ach_relationship_ready": False,
        "blocking_reason": "ALPACA_ACCOUNT_REQUIRED",
    }
    assert exchange_payload["items"][0]["accounts"][0]["auth_summary"] == {
        "has_ach_numbers": True,
        "verification_status": "automatically_verified",
        "is_tokenized_account_number": False,
        "network_status": {"ach": "supported"},
        "auth_fetched_at": "2026-04-23T10:15:00Z",
        "auth_fingerprint": "auth_fp_123",
    }

    status_response = client.get("/plaid/funding/status/user_123")
    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert status_payload["readiness"]["auth_snapshot_ready"] is True
    assert status_payload["readiness"]["blocking_reason"] == "ALPACA_ACCOUNT_REQUIRED"
    assert status_payload["items"][0]["accounts"][0]["auth_summary"]["has_ach_numbers"] is True

    connect_start_response = client.post(
        "/alpaca/connect/start",
        json={
            "user_id": "user_123",
            "redirect_uri": "https://kai.hushh.ai/kai/alpaca/oauth/return",
        },
    )
    assert connect_start_response.status_code == 200
    assert "authorize" in connect_start_response.json()["authorization_url"]

    connect_complete_response = client.post(
        "/alpaca/connect/complete",
        json={
            "user_id": "user_123",
            "state": "alpaca_state_123",
            "code": "oauth_code_123",
        },
    )
    assert connect_complete_response.status_code == 200
    assert connect_complete_response.json()["alpaca_connect"]["linked"] is True

    transfer_response = client.post(
        "/plaid/transfers/create",
        json={
            "user_id": "user_123",
            "funding_item_id": "item_123",
            "funding_account_id": "acc_123",
            "amount": 100,
            "user_legal_name": "Test User",
        },
    )
    assert transfer_response.status_code == 200
    assert transfer_response.json()["transfer"]["transfer_id"] == "transfer_123"

    funded_trade_response = client.post(
        "/plaid/trades/funded/create",
        json={
            "user_id": "user_123",
            "funding_item_id": "item_123",
            "funding_account_id": "acc_123",
            "symbol": "AAPL",
            "user_legal_name": "Test User",
            "notional_usd": 100,
        },
    )
    assert funded_trade_response.status_code == 200
    assert funded_trade_response.json()["intent"]["status"] == "funding_pending"

    list_response = client.get("/plaid/trades/funded", params={"user_id": "user_123"})
    assert list_response.status_code == 200
    assert list_response.json()["count"] == 1

    transfer_get_response = client.get(
        "/plaid/transfers/transfer_123",
        params={"user_id": "user_123"},
    )
    assert transfer_get_response.status_code == 200
    assert transfer_get_response.json()["reference"]["status"] == "SETTLED"

    funded_trade_refresh_response = client.post(
        "/plaid/trades/funded/intent_123/refresh",
        json={"user_id": "user_123"},
    )
    assert funded_trade_refresh_response.status_code == 200
    assert funded_trade_refresh_response.json()["intent"]["status"] == "ready_to_trade"

    assert [name for name, _ in funding.calls] == [
        "create_funding_link_token",
        "get_oauth_resume",
        "exchange_funding_public_token",
        "get_funding_status",
        "create_alpaca_connect_link",
        "complete_alpaca_connect_link",
        "create_transfer",
        "create_funded_trade_intent",
        "list_funded_trade_intents",
        "get_transfer",
        "get_funded_trade_intent",
    ]


def test_webhook_route_prefers_funding_handler_and_falls_back_to_portfolio(monkeypatch):
    funding = _FakeFundingService()
    plaid = _FakePlaidPortfolioService()
    monkeypatch.setattr(plaid_routes, "get_broker_funding_service", lambda: funding)
    monkeypatch.setattr(plaid_routes, "get_plaid_portfolio_service", lambda: plaid)

    client = TestClient(_build_app())

    funding_webhook = client.post(
        "/plaid/webhook",
        json={"item_id": "funding_item_123", "webhook_type": "ITEM"},
        headers={"Plaid-Verification": "signed_value"},
    )
    assert funding_webhook.status_code == 200
    assert funding_webhook.json()["source"] == "funding"
    assert funding.last_webhook_headers is not None
    assert funding.last_webhook_headers["plaid-verification"] == "signed_value"

    portfolio_webhook = client.post(
        "/plaid/webhook",
        json={"item_id": "portfolio_item_123", "webhook_type": "HOLDINGS"},
        headers={"Plaid-Verification": "signed_value_2"},
    )
    assert portfolio_webhook.status_code == 200
    assert portfolio_webhook.json()["source"] == "portfolio"
    assert portfolio_webhook.json()["funding_webhook"]["handled"] is False
