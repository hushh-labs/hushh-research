"""Actual inspection failure/cancellation must release its owned HTTP pool."""

from __future__ import annotations

import asyncio
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import azure_owner_cleanup as cleanup
from hushh_mcp.services import azure_teardown_observation as observation
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (
            AzureTeardownRefused("AZURE_CLEANUP_UNRELATED_RESOURCES"),
            "AZURE_CLEANUP_UNRELATED_RESOURCES",
        ),
        (AzureTeardownRefused("AZURE_UNREVIEWED_PROVIDER_BODY"), "RETRY_REQUIRED"),
        (RuntimeError("private provider body"), "RETRY_REQUIRED"),
    ],
)
async def test_cleanup_preserves_reviewed_recovery_reason_without_retaining_provider_body(
    monkeypatch, failure, code, caplog
):
    authorize, complete, mark = (
        AsyncMock(return_value={}),
        AsyncMock(side_effect=failure),
        AsyncMock(),
    )
    monkeypatch.setattr(cleanup, "bound_authorization", authorize)
    monkeypatch.setattr(cleanup, "complete", complete)
    store, selection, token = SimpleNamespace(mark_authorization=mark), object(), object()
    await cleanup.run_cleanup(store, "owner", selection, token)
    mark.assert_awaited_once_with("owner", selection, "execute", "attention_required", code)
    assert "private provider body" not in caplog.text
    assert "AZURE_UNREVIEWED_PROVIDER_BODY" not in caplog.text


@pytest.mark.parametrize("cancel", [False, True])
async def test_cleanup_inspection_joins_and_closes_before_return(monkeypatch, cancel):
    entered, release = Event(), Event()
    session = SimpleNamespace(closed=False)
    session.request = lambda *_args, **_kwargs: SimpleNamespace(
        status_code=200, headers={}, content=b"{}", json=lambda: {}
    )
    session.close = lambda: setattr(session, "closed", True)
    retained = []

    async def authorization(*_args):
        return {"purpose": "inspect", "context": {"tenantId": "synthetic-tenant"}}

    async def reservation(_owner):
        return {}

    async def retain(*args):
        retained.append(args)

    def inspect(arm, **_kwargs):
        arm.get("/subscriptions/synthetic", api_version="2021-04-01")
        entered.set()
        assert release.wait(3)
        raise TimeoutError("synthetic inspection failure")

    monkeypatch.setattr(cleanup, "bound_authorization", authorization)
    monkeypatch.setattr(cleanup.federation, "app_token", lambda _: SimpleNamespace(object_id="hub"))
    monkeypatch.setattr(observation, "inspect_plan", inspect)
    monkeypatch.setattr("requests.Session", lambda: session)
    token = SimpleNamespace(tenant_id="synthetic-tenant", access_token="synthetic-token")  # noqa: S106 - synthetic transport fixture
    store = SimpleNamespace(reservation=reservation, retain_plan=retain)
    task = asyncio.create_task(cleanup.complete(store, "owner", None, token))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        if cancel:
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done() and not session.closed
        release.set()
        with pytest.raises(asyncio.CancelledError if cancel else TimeoutError):
            await asyncio.wait_for(task, 3)
        assert session.closed and retained == []
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_cancelled_cleanup_keeps_pool_until_actual_aca_checkpoint_reader_exits(monkeypatch):
    from hushh_mcp.services import personal_agent_owner_access_erasure as erasure
    from hushh_mcp.services.azure_setup_plan import PlanInputs
    from tests.test_compute_backend import _AZURE_COORDINATES

    entered, release = Event(), Event()
    session = SimpleNamespace(closed=False)

    def request(_method, url, **_kwargs):
        if "/Microsoft.App/" in url:
            entered.set()
            assert release.wait(3)
            raise TimeoutError("synthetic checkpoint read failure")
        return SimpleNamespace(status_code=200, headers={}, content=b"{}", json=lambda: {})

    session.request, session.close = request, lambda: setattr(session, "closed", True)
    snapshot = {
        "hushh_id": "ha1_abc",
        "deployment_target": "user_azure",
        "backend_metadata": {},
        **_AZURE_COORDINATES,
    }
    reserved = {"registrySnapshot": snapshot, "azureTeardown": {"plan": {"context": {}}}}
    inputs = PlanInputs(
        "ha1_abc",
        _AZURE_COORDINATES["user_cloud_tenant_id"],
        _AZURE_COORDINATES["user_cloud_subscription_id"],
        "eastus2",
        _AZURE_COORDINATES["user_cloud_resource_group"],
        "0123456789abcdef",
    )

    def prepare(arm, *_args, **_kwargs):
        arm.get("/subscriptions/synthetic", api_version="2021-04-01")
        return inputs, (), {}

    async def authorize(*_args):
        return {}

    async def never_deployed(*_args):
        return False

    async def checkpoint(_service, *, backend, **_kwargs):
        await backend.observe_erasure_target(erasure.owner_access_spec(snapshot))

    monkeypatch.setattr(cleanup, "_prepare", prepare)
    monkeypatch.setattr(cleanup, "bound_authorization", authorize)
    monkeypatch.setattr(erasure, "checkpoint_reserved_owner_access", checkpoint)
    monkeypatch.setattr("requests.Session", lambda: session)
    store = SimpleNamespace(registry=object(), never_deployed=never_deployed)
    token = SimpleNamespace(access_token="synthetic-token")  # noqa: S106 - synthetic transport fixture
    task = asyncio.create_task(cleanup._execute(store, "owner", reserved, token, "hub", None))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and not session.closed
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 3)
        assert session.closed
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
