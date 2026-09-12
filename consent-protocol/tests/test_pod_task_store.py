from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.one.pod_task import PodTaskCreateRequest, _validate_runtime_credential
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_task_store import (
    PodTaskConflict,
    PodTaskStore,
    validate_task_input,
)

OWNER = "owner-user"
HUSSH_ID = "ha1-task-owner"
AGENT = "consumer-client"
KEY = b"t" * 32


def _store(tmp_path, name: str = "tasks") -> PodTaskStore:
    log = PodCommitLog(LocalObjectStore(str(tmp_path / name)), KEY, owner_id=HUSSH_ID)
    return PodTaskStore(log, owner_user_id=OWNER, hushh_id=HUSSH_ID, agent_id=AGENT)


@pytest.mark.asyncio
async def test_task_lifecycle_is_durable_and_idempotent(tmp_path):
    store = _store(tmp_path)
    arguments = {"message": "summarize my private notes", "idempotency_key": "req-1"}
    created = await store.create(arguments=arguments)
    duplicate = await store.create(arguments=arguments)
    assert duplicate.task_id == created.task_id
    assert created.safe_projection()["result"] is None

    running = await store.transition(created.task_id, expected={"queued"}, state="running")
    completed = await store.transition(
        created.task_id,
        expected={"running"},
        state="completed",
        result="private summary",
    )
    assert running.state == "running"
    assert completed.safe_projection()["result"] == "private summary"

    restarted = _store(tmp_path)
    observed = await restarted.get(created.task_id)
    assert observed.state == "completed"
    assert observed.result == "private summary"


@pytest.mark.asyncio
async def test_running_task_is_marked_interrupted_after_replacement(tmp_path):
    store = _store(tmp_path)
    task = await store.create(arguments={"message": "long private task"})
    await store.transition(task.task_id, expected={"queued"}, state="running")
    restarted = _store(tmp_path)
    interrupted = await restarted.mark_interrupted(task.task_id)
    assert interrupted.state == "interrupted"
    assert interrupted.error_code == "POD_REPLACED_OR_RESTARTED"
    assert (await restarted.get(task.task_id)).state == "interrupted"


@pytest.mark.asyncio
async def test_cancel_discards_late_result_and_conflicting_idempotency_fails(tmp_path):
    store = _store(tmp_path)
    task = await store.create(arguments={"message": "cancel this", "idempotency_key": "req-2"})
    await store.transition(task.task_id, expected={"queued"}, state="running")
    requested = await store.request_cancel(task.task_id)
    assert requested.state == "cancel_requested"
    cancelled = await store.transition(
        task.task_id,
        expected={"cancel_requested"},
        state="cancelled",
        error_code="TASK_CANCELLED",
    )
    assert cancelled.safe_projection()["result"] is None
    with pytest.raises(PodTaskConflict):
        await store.create(arguments={"message": "different", "idempotency_key": "req-2"})


def test_task_input_rejects_provider_and_unexpected_fields():
    with pytest.raises(ValueError):
        validate_task_input({"message": "x", "runtime_provider": "vertex"})
    with pytest.raises(ValueError):
        validate_task_input({"message": "x", "puppy_device_id": "device"})
    with pytest.raises(ValueError):
        validate_task_input({"message": "x", "unexpected": True})


def test_task_route_requires_a_hub_minted_puppy_grant():
    with pytest.raises(HTTPException, match="Puppy inference grant required"):
        _validate_runtime_credential(
            PodTaskCreateRequest(
                ownerId=OWNER,
                agentId=AGENT,
                message="hello",
                runtimeProvider="puppy",
                puppyDeviceId="device-one",
            )
        )
    with pytest.raises(HTTPException, match="only valid for Puppy"):
        _validate_runtime_credential(
            PodTaskCreateRequest(
                ownerId=OWNER,
                agentId=AGENT,
                message="hello",
                runtimeCredential="caller-supplied-secret",
            )
        )
