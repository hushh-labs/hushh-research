"""The settlement authority remains reachable during rollback, only via OIDC."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from api.routes import scope_commerce_work
from hushh_mcp.services import scheduler_identity
from hushh_mcp.services.scope_commerce import monitoring_publisher


@pytest.fixture
def worker(monkeypatch):
    monkeypatch.setenv("SCOPE_COMMERCE_MONITORING_ENABLED", "false")
    monkeypatch.setenv("SCOPE_COMMERCE_ENABLED", "false")
    monkeypatch.setenv("SCOPE_COMMERCE_PROVIDER_ENABLED", "false")
    monkeypatch.setenv("SCOPE_COMMERCE_DRAIN_AUDIENCE", "https://backend.invalid/settlement")
    monkeypatch.setenv(
        "SCOPE_COMMERCE_DRAIN_SCHEDULER_SERVICE_ACCOUNTS",
        "settlement@project.iam.gserviceaccount.com",
    )
    settle = AsyncMock(return_value={"settled": 1, "expired": 1})
    reconcile_mock = AsyncMock(return_value={"examined": 1, "completed": 1})
    receipt_mock = AsyncMock(
        return_value={"enabled": True, "scanned": 1, "appended": 1, "failed": 0}
    )

    class Store:
        settle_expired_earnings = settle

        async def treasury_position(self):
            return {"backingShortfallMicroUsd": 0}

        async def _transaction(self, callback):
            class Connection:
                async def fetchrow(self, sql):
                    return {"obligations": 0, "uncertain_operations": 0, "unbalanced_journals": 0}

            return await callback(Connection())

    class Provider:
        def __init__(self, store):
            pass

        reconcile = reconcile_mock

    monkeypatch.setattr(scope_commerce_work, "ScopeCommerceService", Store)
    monkeypatch.setattr(scope_commerce_work, "ScopeCommerceProviderService", Provider)

    class ReceiptChain:
        reconcile_committed_paid_events = receipt_mock

    monkeypatch.setattr(scope_commerce_work, "get_consent_audit_chain_service", ReceiptChain)

    def verify(token, audience):
        if token != "scheduler-fixture" or audience != "https://backend.invalid/settlement":
            raise ValueError("invalid fixture")
        return {
            "email": "settlement@project.iam.gserviceaccount.com",
            "email_verified": True,
            "aud": audience,
            "sub": "scheduler",
        }

    monkeypatch.setattr(scheduler_identity, "_verify_google_id_token", verify)
    app = FastAPI()
    app.include_router(scope_commerce_work.router)
    return app, settle, reconcile_mock, receipt_mock


@pytest.mark.asyncio
@pytest.mark.parametrize("authorization", [None, "Bearer caller-fixture", "copied-shared-secret"])
async def test_settlement_refuses_unverified_authority_before_touching_money(worker, authorization):
    app, settle, reconcile, receipts = worker
    headers = {"Authorization": authorization} if authorization else {}
    headers["X-Hushh-Maintenance-Token"] = "copied-shared-secret"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://backend.invalid"
    ) as client:
        response = await client.post("/api/internal/scope-commerce-work/drain", headers=headers)
    assert response.status_code == 401
    settle.assert_not_awaited()
    reconcile.assert_not_awaited()
    receipts.assert_not_awaited()


@pytest.mark.asyncio
async def test_settlement_survives_rollback_and_bounds_work(worker):
    app, settle, reconcile, receipts = worker
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://backend.invalid"
    ) as client:
        response = await client.post(
            "/api/internal/scope-commerce-work/drain?limit=3",
            headers={"Authorization": "Bearer scheduler-fixture"},
        )
        oversized = await client.post(
            "/api/internal/scope-commerce-work/drain?limit=51",
            headers={"Authorization": "Bearer scheduler-fixture"},
        )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["alerts"]["unbalanced_journals"] == 0
    assert oversized.status_code == 422
    settle.assert_awaited_once_with(limit=3)
    reconcile.assert_awaited_once_with(max_operations=3)
    receipts.assert_awaited_once_with(limit=3)


@pytest.mark.asyncio
async def test_settlement_unconfigured_allowlist_denies_even_valid_signature(worker, monkeypatch):
    app, settle, reconcile, receipts = worker
    monkeypatch.delenv("SCOPE_COMMERCE_DRAIN_SCHEDULER_SERVICE_ACCOUNTS")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://backend.invalid"
    ) as client:
        response = await client.post(
            "/api/internal/scope-commerce-work/drain",
            headers={"Authorization": "Bearer scheduler-fixture"},
        )
    assert response.status_code == 401
    settle.assert_not_awaited()
    reconcile.assert_not_awaited()
    receipts.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_reports_backing_deficit_without_financial_amounts(worker, monkeypatch):
    app, _, _, _ = worker

    async def deficit(self):
        return {"backingShortfallMicroUsd": 320000}

    monkeypatch.setattr(scope_commerce_work.ScopeCommerceService, "treasury_position", deficit)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://backend.invalid"
    ) as client:
        response = await client.post(
            "/api/internal/scope-commerce-work/drain",
            headers={"Authorization": "Bearer scheduler-fixture"},
        )
    assert response.status_code == 200
    assert response.json()["alerts"]["backing_shortfalls"] == 1
    assert "backingShortfallMicroUsd" not in response.text and "320000" not in response.text


@pytest.mark.asyncio
async def test_monitoring_failure_cannot_change_committed_settlement_or_expose_amounts(
    worker, monkeypatch, caplog
):
    app, settle, reconcile, _ = worker
    monkeypatch.setenv("SCOPE_COMMERCE_MONITORING_ENABLED", "true")
    monkeypatch.setenv("SCOPE_COMMERCE_MONITORING_PROJECT_ID", "hushh-pda-dev")
    monkeypatch.setenv("SCOPE_COMMERCE_MONITORING_BACKEND_SERVICE", "commerce-preview")
    monkeypatch.setattr(
        monitoring_publisher,
        "financial_snapshot",
        AsyncMock(
            return_value={
                "liabilities_micro_usd": 320000,
                "worker_completed_timestamp": 1000,
            }
        ),
    )
    monkeypatch.setattr(
        monitoring_publisher, "provider_observation", AsyncMock(side_effect=ValueError)
    )
    published = []

    def unavailable(project, payload):
        published.append(payload)
        raise RuntimeError("provider error including 320000 must not be logged")

    monkeypatch.setattr(monitoring_publisher, "_publish", unavailable)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://backend.invalid"
    ) as client:
        response = await client.post(
            "/api/internal/scope-commerce-work/drain",
            headers={"Authorization": "Bearer scheduler-fixture"},
        )
    assert response.status_code == 200
    assert settle.await_count == reconcile.await_count == 1
    assert published[0]["timeSeries"][0]["resource"]["type"] == "global"
    assert "320000" not in response.text + caplog.text
    names = {row["metric"]["type"].rsplit("/", 1)[-1] for row in published[0]["timeSeries"]}
    assert "provider_available_micro_usd" not in names
    assert "provider_observation_verified" in names


def test_financial_monitoring_rejects_identity_labels_and_unknown_metrics():
    with pytest.raises(ValueError):
        monitoring_publisher.metric_payload(
            "hushh-pda-dev", "commerce-preview", {"owner_user_id": 1}
        )
    with pytest.raises(ValueError):
        monitoring_publisher.metric_payload(
            "hushh-pda-dev", 'preview" OR owner', {"receipt_failures": 1}
        )
    payload = monitoring_publisher.metric_payload(
        "hushh-pda-dev", "commerce-preview", {"receipt_failures": 1}
    )
    assert payload["timeSeries"][0]["metric"]["labels"] == {"service_name": "commerce-preview"}


@pytest.mark.asyncio
async def test_provider_observation_requires_current_environment_receipt():
    from hushh_mcp.services.scope_commerce.monitoring import provider_observation

    provider = SimpleNamespace(
        _admit=AsyncMock(),
        config=SimpleNamespace(livemode=False),
        adapter=SimpleNamespace(
            balance=AsyncMock(
                return_value={
                    "livemode": True,
                    "available": [{"currency": "usd", "amount": 50}],
                }
            )
        ),
    )
    with pytest.raises(ValueError):
        await provider_observation(provider)
    provider.adapter.balance.return_value["livemode"] = False
    observed = await provider_observation(provider)
    assert observed["provider_available_micro_usd"] == 500000
    assert observed["provider_observed_timestamp"] > 0
    assert observed["provider_observation_verified"] == 1
