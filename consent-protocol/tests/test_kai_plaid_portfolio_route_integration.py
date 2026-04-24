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
    return app


class _FakePlaidPortfolioService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def get_status(self, *, user_id: str):
        self.calls.append(("get_status", {"user_id": user_id}))
        return {
            "configured": True,
            "user_id": user_id,
            "source_preference": "statement",
            "items": [],
            "aggregate": {
                "item_count": 0,
                "account_count": 0,
                "institution_names": [],
            },
        }

    async def create_link_token(self, **kwargs):
        self.calls.append(("create_link_token", kwargs))
        return {
            "configured": True,
            "flow_type": "portfolio",
            "mode": "update" if kwargs.get("item_id") else "create",
            "link_token": "link_portfolio_123",
            "resume_session_id": "resume_portfolio_123",
            "redirect_uri": kwargs.get("redirect_uri"),
        }

    async def exchange_public_token(self, **kwargs):
        self.calls.append(("exchange_public_token", kwargs))
        return {
            "configured": True,
            "user_id": kwargs["user_id"],
            "source_preference": "plaid",
            "items": [
                {
                    "item_id": "item_123",
                    "institution_name": "Test Broker",
                }
            ],
            "aggregate": {
                "item_count": 1,
                "account_count": 1,
                "institution_names": ["Test Broker"],
            },
        }

    async def get_oauth_resume(self, **kwargs):
        self.calls.append(("get_oauth_resume", kwargs))
        return {
            "configured": True,
            "flow_type": "portfolio",
            "mode": "create",
            "link_token": "link_portfolio_resume_123",
            "resume_session_id": kwargs["resume_session_id"],
        }

    async def refresh_items(self, **kwargs):
        self.calls.append(("refresh_items", kwargs))
        return {
            "accepted": True,
            "runs": [{"run_id": "run_123", "status": "queued"}],
        }

    async def get_refresh_run_status(self, **kwargs):
        self.calls.append(("get_refresh_run_status", kwargs))
        return {"run_id": kwargs["run_id"], "status": "running"}

    async def cancel_refresh_run(self, **kwargs):
        self.calls.append(("cancel_refresh_run", kwargs))
        return {"run_id": kwargs["run_id"], "status": "canceled"}

    def set_active_source(self, *, user_id: str, active_source: str):
        self.calls.append(
            ("set_active_source", {"user_id": user_id, "active_source": active_source})
        )
        return active_source


class _FakeFundingService:
    async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
        assert user_id == "user_123"
        assert resume_session_id == "resume_portfolio_123"
        return None


def test_route_level_read_only_plaid_sequence(monkeypatch):
    plaid = _FakePlaidPortfolioService()
    monkeypatch.setattr(plaid_routes, "get_plaid_portfolio_service", lambda: plaid)
    monkeypatch.setattr(plaid_routes, "get_broker_funding_service", lambda: _FakeFundingService())

    client = TestClient(_build_app())

    status_response = client.get("/plaid/status/user_123")
    assert status_response.status_code == 200
    assert status_response.json()["aggregate"]["item_count"] == 0

    link_response = client.post(
        "/plaid/link-token",
        json={
            "user_id": "user_123",
            "redirect_uri": "https://kai.hushh.ai/kai/plaid/oauth/return",
        },
    )
    assert link_response.status_code == 200
    assert link_response.json()["flow_type"] == "portfolio"

    missing_update_response = client.post(
        "/plaid/link-token/update",
        json={"user_id": "user_123"},
    )
    assert missing_update_response.status_code == 400
    assert missing_update_response.json()["detail"]["code"] == "PLAID_ITEM_ID_REQUIRED"

    update_response = client.post(
        "/plaid/link-token/update",
        json={
            "user_id": "user_123",
            "item_id": "item_123",
            "redirect_uri": "https://kai.hushh.ai/kai/plaid/oauth/return",
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["mode"] == "update"

    resume_response = client.post(
        "/plaid/oauth/resume",
        json={"user_id": "user_123", "resume_session_id": "resume_portfolio_123"},
    )
    assert resume_response.status_code == 200
    assert resume_response.json()["flow_type"] == "portfolio"

    exchange_response = client.post(
        "/plaid/exchange-public-token",
        json={
            "user_id": "user_123",
            "public_token": "public_123",
            "resume_session_id": "resume_portfolio_123",
            "metadata": {"institution": {"name": "Test Broker"}},
        },
    )
    assert exchange_response.status_code == 200
    assert exchange_response.json()["source_preference"] == "plaid"

    source_response = client.post(
        "/plaid/source",
        json={"user_id": "user_123", "active_source": "statement"},
    )
    assert source_response.status_code == 200
    assert source_response.json()["active_source"] == "statement"

    refresh_response = client.post(
        "/plaid/refresh",
        json={"user_id": "user_123"},
    )
    assert refresh_response.status_code == 200
    assert refresh_response.json()["accepted"] is True

    refresh_run_response = client.get(
        "/plaid/refresh/run_123",
        params={"user_id": "user_123"},
    )
    assert refresh_run_response.status_code == 200
    assert refresh_run_response.json()["run"]["status"] == "running"

    cancel_response = client.post(
        "/plaid/refresh/run_123/cancel",
        json={"user_id": "user_123"},
    )
    assert cancel_response.status_code == 200
    assert cancel_response.json()["run"]["status"] == "canceled"

    assert [name for name, _ in plaid.calls] == [
        "get_status",
        "create_link_token",
        "create_link_token",
        "get_oauth_resume",
        "exchange_public_token",
        "set_active_source",
        "refresh_items",
        "get_refresh_run_status",
        "cancel_refresh_run",
    ]


def test_resume_route_returns_404_when_no_active_session(monkeypatch):
    class _NoResumePlaidPortfolioService:
        async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
            assert user_id == "user_123"
            assert resume_session_id == "resume_missing"
            return None

    class _NoResumeFundingService:
        async def get_oauth_resume(self, *, user_id: str, resume_session_id: str):
            assert user_id == "user_123"
            assert resume_session_id == "resume_missing"
            return None

    monkeypatch.setattr(
        plaid_routes,
        "get_plaid_portfolio_service",
        lambda: _NoResumePlaidPortfolioService(),
    )
    monkeypatch.setattr(
        plaid_routes,
        "get_broker_funding_service",
        lambda: _NoResumeFundingService(),
    )

    client = TestClient(_build_app())

    response = client.post(
        "/plaid/oauth/resume",
        json={"user_id": "user_123", "resume_session_id": "resume_missing"},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "PLAID_OAUTH_RESUME_NOT_FOUND"
