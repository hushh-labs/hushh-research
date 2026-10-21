"""Actual native ADK resume against the existing PostgreSQL private action ledger."""

import json
from contextlib import aclosing
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.runners import Runner
from sqlalchemy import text

from hushh_mcp.one_adk.mcp_call_approval import (
    STATE_MCP_APPROVAL,
    admit_resume_receipt,
    bind_mcp_approval_port,
)
from hushh_mcp.one_adk.mcp_pending_call import pending_resume_scope, private_pending_call_scope
from hushh_mcp.one_adk.request_secrets import consume_request_secret
from hushh_mcp.one_adk.scheduled_session_service import (
    ScheduledSessionService,
    pending_confirmations,
)
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.pod_scheduled_mcp import ScheduledMcpApprovalPort
from tests.test_pod_binding_transactions import db as db
from tests.test_pod_binding_transactions import pg as pg
from tests.test_pod_scheduled_authority import admitted_task as admitted_task
from tests.test_pod_scheduled_authority import hub_key as hub_key
from tests.test_pod_scheduled_continuation import (
    checkpoint_task as checkpoint_task,
)
from tests.test_pod_scheduled_continuation import (
    first_native_review,
    native_review,
)
from tests.test_pod_session_authority import POD_PUBLIC_KEY


@pytest.fixture
def task_hub(checkpoint_task, db, monkeypatch):
    from api.middleware import require_vault_owner_token
    from api.routes import external_connectors
    from api.routes.one import pod_mcp_approval as routes
    from db import db_client
    from hushh_mcp.services import pod_binding_service
    from hushh_mcp.services.pod_request_signing import VerifiedPod

    world = checkpoint_task
    authority = world.task.authority
    uid, url, account = "uid-1", "https://pod.example", "pod@synthetic.iam.gserviceaccount.com"
    metadata = {
        "url": url,
        "serviceUid": uid,
        "runtime_service_account": account,
        "ingress": "direct",
        "directReadiness": {
            "verified": True,
            "serviceUid": uid,
            "podKeyId": authority.pod_key_id,
            "url": url,
        },
    }
    with db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE personal_agent_registry SET user_id=:owner, hushh_id=:pod, "
                "pod_key_id=:key, pod_pubkey=:public, backend_metadata=CAST(:metadata AS JSONB)"
            ),
            {
                "owner": world.storage.owner,
                "pod": authority.hushh_id,
                "key": authority.pod_key_id,
                "public": POD_PUBLIC_KEY,
                "metadata": json.dumps(metadata),
            },
        )
    monkeypatch.setattr(db_client, "get_db", lambda: db)
    monkeypatch.setattr(pod_binding_service, "hub_environment", lambda: "dev")
    monkeypatch.setattr(routes, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(
        routes,
        "verify_pod_request",
        AsyncMock(return_value=VerifiedPod(authority.hushh_id, service_account=account)),
    )
    app = FastAPI()
    app.include_router(routes.router)
    app.include_router(external_connectors.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": world.storage.owner}
    owner = SimpleNamespace(
        owner=world.storage.owner,
        hushh_id=authority.hushh_id,
        authority=authority,
        require_access=world.task.lease.check,
    )
    with TestClient(app) as client:
        calls = []

        def post(path, *, json):
            calls.append((path, json))
            return client.post(path, json=json)

        port = ScheduledMcpApprovalPort(owner, world.storage, client=SimpleNamespace(post=post))
        yield SimpleNamespace(port=port, client=client, db=db, calls=calls)


async def resume_native(world, native, approval, handle, confirmation_id):
    sessions = ScheduledSessionService(world.storage)
    runner = Runner(
        app=App(
            name="hussh_one",
            root_agent=LlmAgent(
                name="one",
                model=native.model,
                instruction="Use the requested connector.",
                tools=[native.tool],
            ),
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        session_service=sessions,
    )
    receipt_ref = admit_resume_receipt(
        {"mcpApproval": approval},
        owner_id=world.storage.owner,
        conversation_id=world.storage.session_id,
    )
    try:
        async with runner:
            return await _resume_native(
                world, native, sessions, runner, receipt_ref, handle, confirmation_id
            )
    finally:
        consume_request_secret(receipt_ref)


async def _resume_native(world, native, sessions, runner, receipt_ref, handle, confirmation_id):
    with (
        world.task.invocation.bind() as reference,
        bind_mcp_approval_port(native.port),
        private_pending_call_scope(world.pending),
    ):
        async with pending_resume_scope(receipt_ref):
            return await _run_native(
                world, sessions, runner, reference, receipt_ref, handle, confirmation_id
            )


async def _run_native(world, sessions, runner, reference, receipt_ref, handle, confirmation_id):
    await sessions.restore_pending(handle)
    message = await sessions.confirmation_message(handle, confirmation_id, confirmed=True)
    async with aclosing(
        runner.run_async(
            user_id=world.storage.owner,
            session_id=world.storage.session_id,
            invocation_id=world.storage.invocation_id,
            new_message=message,
            state_delta={
                "hussh:consent_token": reference,
                "temp:one_execution_surface": "scheduled_task",
                STATE_MCP_APPROVAL: receipt_ref,
            },
        )
    ) as events:
        return [event async for event in events]


@pytest.mark.parametrize("lost_ack", [False, True])
async def test_exact_native_task_resume_consumes_real_ledger_once(
    checkpoint_task, task_hub, lost_ack
):
    world, hub = checkpoint_task, task_hub
    native = native_review(world, port=hub.port)
    async with native.runner:
        checkpoint = await first_native_review(world, native)
    refs = pending_confirmations(
        checkpoint.session, checkpoint.pending, world.storage.invocation_id
    )
    handle, confirmation_id = next(iter(refs.items()))
    pending = checkpoint.pending[handle]
    review = pending["review"]
    confirmed = hub.client.post(
        "/api/connectors/custom_test/mcp/confirm",
        json={
            "podReview": review["podReview"],
            "directiveId": review["directiveId"],
            "confirmed": True,
        },
    )
    assert confirmed.status_code == 200
    approval = {
        "directiveId": review["directiveId"],
        "connectorId": "custom_test",
        "toolName": pending["tool_name"],
        "pendingHandle": handle,
        "receipt": confirmed.json()["receipt"],
    }
    if lost_ack:
        from hushh_mcp.services.pod_hub_client import PodHubUnavailable
        from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused

        post = hub.port.client.post

        def lose_ack(path, **kwargs):
            response = post(path, **kwargs)
            if path.endswith("/consume") and response.status_code == 200:
                raise PodHubUnavailable("Synthetic lost consume response")
            return response

        hub.port.client.post = lose_ack
        with pytest.raises(ActionDirectiveAuthorityError):
            await resume_native(world, native, approval, handle, confirmation_id)
        checkpoint, _ = await world.storage.checkpoint()
        assert checkpoint.phase == "dispatching" and checkpoint.dispatch_handle == handle
        native.provider.assert_not_awaited()
        with pytest.raises(ScheduleRefused, match="SCHEDULE_DISPATCH_OUTCOME_UNCERTAIN"):
            await resume_native(world, native, approval, handle, confirmation_id)
        native.provider.assert_not_awaited()
        with hub.db.engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT state FROM one_action_directive_ledger")
                ).scalar_one()
                == "consumed"
            )
        assert sum(path.endswith("/consume") for path, _ in hub.calls) == 1
        return
    await resume_native(world, native, approval, handle, confirmation_id)
    native.provider.assert_awaited_once_with("PRIVATE_ARGUMENT")
    checkpoint, _ = await world.storage.checkpoint()
    assert checkpoint.phase == "running" and checkpoint.pending == {}
    with hub.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT state FROM one_action_directive_ledger")).scalar_one()
            == "consumed"
        )
        assert connection.execute(text("SELECT count(*) FROM one_adk_sessions")).scalar_one() == 0
    assert "PRIVATE_ARGUMENT" not in json.dumps(hub.calls)
    with pytest.raises(ActionDirectiveAuthorityError):
        await resume_native(world, native, approval, handle, confirmation_id)
    assert native.provider.await_count == 1
