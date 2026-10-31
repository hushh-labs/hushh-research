"""Actual registered One capability and sealed scheduler; scripted provider only."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from hushh_mcp.services.pod_scheduled_model import ScheduledModel
from hushh_mcp.services.pod_scheduled_one import ScheduledOneTask
from tests.test_adk_specialist_chat_services import _ScriptedModel
from tests.test_mcp_review_service import harness as harness
from tests.test_pod_scheduled_authority import admitted_task as admitted_task
from tests.test_pod_scheduled_authority import hub_key as hub_key
from tests.test_pod_scheduled_continuation_postgres import (
    _actual_one_catalog,
)
from tests.test_pod_scheduled_continuation_postgres import (
    checkpoint_task as checkpoint_task,
)
from tests.test_pod_scheduled_continuation_postgres import (
    db as db,
)
from tests.test_pod_scheduled_continuation_postgres import (
    pg as pg,
)
from tests.test_pod_scheduled_continuation_postgres import (
    task_hub as task_hub,
)
from tests.test_pod_scheduled_tasks import schedule_request


@pytest.fixture
def one_scheduler(admitted_task, monkeypatch):
    from hushh_mcp import runtime_settings
    from hushh_mcp.one_adk import agent_tree, pod_custody_mcp
    from hushh_mcp.services import pod_memory_service, pod_owner_cloud

    task = admitted_task
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "synthetic-owner-project")
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv(
        "HUSSH_POD_KMS_KEY",
        "projects/synthetic-owner-project/locations/global/keyRings/owner/cryptoKeys/pod",
    )
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    monkeypatch.delenv("HUSSH_POD_DEV_INFERENCE_BRIDGE_JSON", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_DEPLOYMENT", raising=False)
    monkeypatch.setattr(pod_owner_cloud, "owner_cloud_agent", lambda: True)
    monkeypatch.setattr(runtime_settings, "pod_user_adc_enabled", lambda: True)
    monkeypatch.setattr(agent_tree, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_memory_service, "resolve_pod_memory_service", lambda: None)
    monkeypatch.setattr(pod_custody_mcp, "custody_configurations", AsyncMock(return_value=[]))
    monkeypatch.setattr(pod_custody_mcp, "custody_configuration_admissions", lambda _: {})
    cap = ScheduledOneTask(task.invocation.grants, task.world.log, task.authority.require_held)
    task.runtime.capabilities["agent_one.execute_task.v1"] = cap
    permit = SimpleNamespace(release=AsyncMock())
    task.runtime.admission = SimpleNamespace(acquire_turn=AsyncMock(return_value=permit))
    task.runtime.runner.admission = task.runtime.admission
    return SimpleNamespace(task=task, cap=cap, permit=permit)


async def _create(world):
    task = world.task
    created = await task.runtime.create(
        schedule_request(
            request_id="actual-one-task",
            capability="agent_one.execute_task.v1",
            parameters={"goal": "Complete this synthetic task."},
            first_run_at=task.clock[0] + 1,
            authorization_expires_at=task.clock[0] + 500,
        ),
        grant={"subject_id": task.subject.subject_id, "version": 1},
    )
    task.clock[0] += 2
    return created, task.runtime.delivery.offer.call_args.args[:3]


@pytest.mark.parametrize("outcome,state", [("completed", "completed"), ("blocked", "needs_review")])
async def test_actual_one_task_claim_runs_to_native_terminal_once(
    one_scheduler, monkeypatch, outcome, state
):
    world = one_scheduler
    model = _ScriptedModel(
        [
            LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="finish_task",
                                args={
                                    "outcome": outcome,
                                    "summary": "Synthetic task completed.",
                                },
                            )
                        )
                    ],
                )
            )
        ]
    )
    monkeypatch.setattr(ScheduledModel, "build", lambda _self: model)
    created, delivery = await _create(world)
    result = await world.task.runtime.run(*delivery)
    assert result["last_run"]["state"] == ("completed" if outcome == "completed" else "failed")
    assert result["state"] == state
    assert model._calls == 1
    assert (await world.task.runtime.run(*delivery))["state"] == state
    assert model._calls == 1
    rows, _ = await world.task.runtime.journal.snapshot()
    checkpoint = rows[created["id"]]["checkpoint"]
    assert any(event["output"] for event in checkpoint["session"]["events"])
    assert "pod-task:" not in str(checkpoint)
    world.permit.release.assert_awaited_once()


async def _park_native_review(one_scheduler, checkpoint_task, task_hub, monkeypatch):
    from hushh_mcp.one_adk import pod_custody_mcp
    from hushh_mcp.services import pod_hub_client
    from tests.test_mcp_turn_scope import configuration

    world = one_scheduler
    native, _unused_scope, connector = _actual_one_catalog(checkpoint_task, task_hub, monkeypatch)
    await native.runner.close()
    monkeypatch.setattr(ScheduledModel, "build", lambda _self: native.model)
    record = configuration()
    monkeypatch.setattr(pod_custody_mcp, "custody_configurations", AsyncMock(return_value=[record]))
    monkeypatch.setattr(
        pod_custody_mcp,
        "custody_configuration_admissions",
        lambda _: {connector: lambda current: None},
    )
    monkeypatch.setattr(
        pod_hub_client, "PodHubClient", lambda: SimpleNamespace(post=task_hub.client.post)
    )
    created, delivery = await _create(world)
    parked = await world.task.runtime.run(*delivery)
    assert parked["state"] == parked["last_run"]["state"] == "needs_review"
    native.provider.assert_not_awaited()
    return native, connector, created, parked


async def _retained_review(world, created, parked):
    from hushh_mcp.one_adk.scheduled_session_projection import pending_confirmations

    rows, _ = await world.task.runtime.journal.snapshot()
    row = rows[created["id"]]
    checkpoint = row["checkpoint"]
    handle, marker = next(
        iter(
            pending_confirmations(
                checkpoint["session"],
                checkpoint["pending"],
                "scheduled_" + parked["last_run"]["id"],
            ).items()
        )
    )
    return handle, marker, checkpoint["pending"][handle]


def _confirmed(task_hub, connector, handle, marker, pending):
    from hushh_mcp.services.pod_scheduled_contracts import ScheduledContinuation

    review = pending["review"]
    response = task_hub.client.post(
        f"/api/connectors/{connector}/mcp/confirm",
        json={
            "podReview": review["podReview"],
            "directiveId": review["directiveId"],
            "confirmed": True,
        },
    )
    assert response.status_code == 200
    return ScheduledContinuation(
        handle,
        marker,
        {
            "directiveId": review["directiveId"],
            "connectorId": connector,
            "toolName": pending["tool_name"],
            "pendingHandle": handle,
            "receipt": response.json()["receipt"],
        },
    )


async def _continue(world, parked, continuation):
    return await world.task.runtime.runner.continue_review(
        parked["id"],
        parked["revision"],
        parked["last_run"]["id"],
        continuation,
        caller_check=world.task.authority.require_held,
        caller_grant={"subject_id": world.task.subject.subject_id, "version": 1},
    )


async def test_worker_parks_native_review_and_continues_the_same_occurrence_once(
    one_scheduler, checkpoint_task, task_hub, monkeypatch
):
    from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused

    world = one_scheduler
    native, connector, created, parked = await _park_native_review(
        world, checkpoint_task, task_hub, monkeypatch
    )
    handle, marker, pending = await _retained_review(world, created, parked)
    continuation = _confirmed(task_hub, connector, handle, marker, pending)
    result = await world.task.runtime.runner.continue_review(
        parked["id"],
        parked["revision"],
        parked["last_run"]["id"],
        continuation,
        caller_check=world.task.authority.require_held,
        caller_grant={"subject_id": world.task.subject.subject_id, "version": 1},
    )
    assert result["state"] == "completed"
    assert result["last_run"]["id"] == parked["last_run"]["id"]
    assert result["last_run"]["claim_id"] != parked["last_run"]["claim_id"]
    native.provider.assert_awaited_once()
    assert world.permit.release.await_count == 2
    with pytest.raises(ScheduleRefused):
        await _continue(world, parked, continuation)
    native.provider.assert_awaited_once()


async def _cold_restart(world):
    from hushh_mcp.services.pod_scheduled_authority import ScheduledGrantAuthority
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleAccess, ScheduledTasks

    task = world.task
    old, task.authority = task.authority, await task.world.boot()
    assert task.authority.epoch > old.epoch
    token, claims = await task.authority.renew(task.session_token)
    grants = ScheduledGrantAuthority(
        task.authority, claims["user_id"], task.authority.require_held, clock=lambda: task.clock[0]
    )
    world.cap = ScheduledOneTask(grants, task.world.log, task.authority.require_held)
    task.runtime = ScheduledTasks(
        access=ScheduleAccess(
            claims["user_id"],
            claims["hushh_id"],
            task.runtime.access.incarnation,
            task.authority.require_held,
        ),
        log=task.world.log,
        capabilities={"agent_one.execute_task.v1": world.cap},
        delivery=task.runtime.delivery,
        admission=task.runtime.admission,
        check_grant=grants.check_grant,
        clock=lambda: task.clock[0],
    )
    return token, claims


async def _owner_request(world, token, monkeypatch, operation, body):
    import httpx
    from fastapi import FastAPI

    from api.middlewares.pod_ingress import PodIngressPolicy
    from api.routes.one import pod_scheduled_tasks, pod_session

    monkeypatch.setattr(pod_session, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_session, "active_session_authority", lambda: world.task.authority)
    monkeypatch.setattr(pod_scheduled_tasks, "active_scheduled_tasks", lambda: world.task.runtime)
    app = FastAPI()
    app.add_middleware(PodIngressPolicy)
    app.include_router(pod_scheduled_tasks.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="https://pod.example"
    ) as client:
        response = await client.post(
            "/api/one/pod/tasks/" + operation,
            json=body,
            headers={"Authorization": "Bearer " + token},
        )
    assert response.headers["Cache-Control"] == "no-store, private"
    return response


async def test_cold_restart_requires_rebound_owner_confirmation_before_one_effect(
    one_scheduler, checkpoint_task, task_hub, monkeypatch
):
    from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused

    world = one_scheduler
    native, connector, created, parked = await _park_native_review(
        world, checkpoint_task, task_hub, monkeypatch
    )
    handle, marker, pending = await _retained_review(world, created, parked)
    old_confirmation = _confirmed(task_hub, connector, handle, marker, pending)
    token, claims = await _cold_restart(world)
    with pytest.raises(ScheduleRefused, match="SCHEDULE_REVIEW_REBIND_REQUIRED"):
        await _continue(world, parked, old_confirmation)
    native.provider.assert_not_awaited()

    body = {
        "schedule_id": parked["id"],
        "revision": parked["revision"],
        "occurrence_id": parked["last_run"]["id"],
        "pending_handle": handle,
    }
    refused = await _owner_request(world, "not-an-owner", monkeypatch, "review", body)
    assert refused.status_code == 401
    response = await _owner_request(world, token, monkeypatch, "review", body)
    assert response.status_code == 200, response.text
    replacement = response.json()
    assert replacement["review"]["directiveId"] != pending["review"]["directiveId"]
    assert replacement["review"]["expiresAt"] == pending["review"]["expiresAt"]
    assert replacement["review"]["podReview"]["epoch"] == world.task.authority.epoch
    refreshed = await world.task.runtime.get(parked["id"])
    assert refreshed["revision"] == replacement["revision"]
    with pytest.raises(ScheduleRefused, match="SCHEDULE_REVIEW_TERMS_CHANGED"):
        await _continue(world, refreshed, old_confirmation)
    native.provider.assert_not_awaited()
    _, _, pending = await _retained_review(world, created, refreshed)
    continuation = _confirmed(task_hub, connector, handle, marker, pending)
    body.update(
        revision=refreshed["revision"], confirmation_id=marker, approval=continuation.approval
    )
    response = await _owner_request(world, token, monkeypatch, "continue", body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["state"] == "completed"
    assert result["last_run"]["id"] == parked["last_run"]["id"]
    native.provider.assert_awaited_once()


@pytest.mark.parametrize("exit_kind", ["success", "failure", "cancellation"])
async def test_owner_review_drops_its_private_credential_on_every_exit(
    harness, monkeypatch, exit_kind
):
    import asyncio
    from contextlib import nullcontext

    from hushh_mcp.one_adk import governed_mcp_toolset, mcp_review_service
    from hushh_mcp.one_adk.request_secrets import resolve_request_secret

    monkeypatch.setattr(mcp_review_service, "pod_mode", lambda: False)
    monkeypatch.setattr(governed_mcp_toolset, "HOSTED_WORKSPACE_MCP_ENROLLED", True)
    expected = (
        nullcontext()
        if exit_kind == "success"
        else pytest.raises(RuntimeError if exit_kind == "failure" else asyncio.CancelledError)
    )
    reference = ""
    with expected:
        async with mcp_review_service.review_tool(
            **{key: value for key, value in harness.request.items() if key != "arguments"}
        ) as (context, _):
            reference = context.state["hussh:consent_token"]
            assert resolve_request_secret(reference) == harness.request["token"]["token"]
            if exit_kind == "failure":
                raise RuntimeError("Synthetic review failure")
            if exit_kind == "cancellation":
                raise asyncio.CancelledError
    assert reference and resolve_request_secret(reference) == ""
    harness.created[0].close.assert_awaited_once()


async def test_scheduled_private_work_refuses_debug_logging_before_custody(
    one_scheduler, monkeypatch, caplog
):
    import logging

    from hushh_mcp.one_adk import pod_custody_mcp

    _, delivery = await _create(one_scheduler)
    build = Mock(side_effect=AssertionError("Private processing must refuse before model creation"))
    monkeypatch.setattr(ScheduledModel, "build", build)
    caplog.set_level(logging.DEBUG, logger="openai")
    with pytest.raises(ValueError, match="content logging"):
        await one_scheduler.task.runtime.run(*delivery)
    pod_custody_mcp.custody_configurations.assert_not_awaited()
    build.assert_not_called()


async def test_fleet_alias_change_cannot_change_an_approved_scheduled_model(
    one_scheduler, monkeypatch
):
    from hushh_mcp.runtime_providers import gemini_config
    from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused

    model = ["first-model"]
    monkeypatch.setattr(gemini_config, "resolve_fleet_model_name", lambda _: model[0])
    _, delivery = await _create(one_scheduler)
    model[0] = "second-model"
    build = Mock(side_effect=AssertionError("Changed model must not be constructed"))
    monkeypatch.setattr(ScheduledModel, "build", build)
    with pytest.raises(ScheduleRefused, match="SCHEDULE_MODEL_CHANGED"):
        await one_scheduler.task.runtime.run(*delivery)
    build.assert_not_called()
