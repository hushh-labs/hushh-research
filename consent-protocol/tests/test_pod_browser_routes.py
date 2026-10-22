"""Browser HTTP admission and private response boundaries."""

import asyncio

import pytest

from tests.helpers.pod_browser import task_runtime_fixture


async def test_browser_hub_approval_separates_owner_and_signed_machine_authority(monkeypatch):
    import time
    from unittest.mock import AsyncMock

    from fastapi import FastAPI, Header, HTTPException
    from httpx import ASGITransport, AsyncClient

    from api.routes.one import pod_browser_approval as route
    from hushh_mcp.services.pod_request_signing import VerifiedPod

    async def owner(authorization: str | None = Header(None)):
        if authorization != "Bearer synthetic-owner":
            raise HTTPException(401)
        return {"user_id": "owner"}

    async def machine(request, authorization, *, owner_bound):
        assert owner_bound
        return (
            VerifiedPod("pod", key_id="signed-key")
            if authorization == "Bearer synthetic-pod"
            else None
        )

    mutate = AsyncMock(return_value={"status": "confirmed"})
    monkeypatch.setattr(route, "verify_pod_request", machine)
    monkeypatch.setattr(route, "mutate_browser_review", mutate)
    monkeypatch.setattr(route, "personal_agent_enabled", lambda: True)
    app = FastAPI()
    app.include_router(route.router)
    app.dependency_overrides[route.require_vault_owner_token] = owner
    review = {
        "binding": {
            "owner_id": "owner",
            "pod_id": "pod",
            "incarnation": "epoch",
            "task_id": "task",
            "environment": "development",
            "expires_at": int(time.time()) + 600,
        },
        "purpose": "model_process",
        "commitment": "a" * 64,
        "pod_key_id": "key",
        "environment": "dev",
        "epoch": 1,
        "service_uid": "uid",
    }
    body = {"review": review, "directive_id": "dir_" + "a" * 32, "confirmed": True}
    root = "/api/one/pod/browser-approval"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://hub") as client:
        for credential, suffix, payload, expected in (
            ("synthetic-pod", "/confirm", body, 401),
            ("synthetic-owner", "/issue", {"review": review}, 401),
            ("synthetic-owner", "/confirm", {**body, "confirmed": False}, 403),
            (
                "synthetic-owner",
                "/confirm",
                {
                    **body,
                    "review": {**review, "binding": {**review["binding"], "owner_id": "another"}},
                },
                403,
            ),
        ):
            response = await client.post(
                root + suffix, headers={"Authorization": "Bearer " + credential}, json=payload
            )
            assert response.status_code == expected
        invalid = await client.post(
            root + "/confirm",
            headers={"Authorization": "Bearer synthetic-owner"},
            json={**body, "private_secret": "synthetic-private-value"},
        )
        assert invalid.status_code == 422 and "synthetic-private-value" not in invalid.text
        large = await client.post(root + "/confirm", content=b"x" * 16385)
        assert large.status_code == 413
        mutate.assert_not_awaited()
        confirmed = await client.post(
            root + "/confirm", headers={"Authorization": "Bearer synthetic-owner"}, json=body
        )
        assert confirmed.status_code == 200
        assert confirmed.headers["Cache-Control"] == "no-store, private"
        assert mutate.await_args.args[0] == "confirm"
        assert mutate.await_args.kwargs["principal"] is None


async def test_browser_routes_default_closed_and_input_validation_never_echoes_secrets(monkeypatch):
    from types import SimpleNamespace

    from fastapi import FastAPI, HTTPException
    from httpx import ASGITransport, AsyncClient

    from api.routes.one import pod_browser

    async def held():
        return None

    authority = SimpleNamespace(environment="development", require_held=held)
    scopes = {"browser.invoke", "browser.observe", "browser.control"}

    def verified(authorization, *, role, scope):
        if authorization != "Bearer owner-session" or scope not in scopes:
            raise HTTPException(403, detail={"code": "role_mismatch"})
        return authority, {"user_id": "owner", "hushh_id": "pod", "exp": 1900}

    monkeypatch.setattr(pod_browser, "verified_session", verified)
    monkeypatch.setattr(pod_browser, "pod_incarnation", lambda: "epoch")
    app = FastAPI()
    app.include_router(pod_browser.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://pod") as client:
        path = "/api/one/pod/browser"
        headers = {"Authorization": "Bearer owner-session"}
        denied = await client.get(
            path + "/capability", headers={"Authorization": "Bearer device-session"}
        )
        assert denied.status_code == 403
        capability = await client.get(path + "/capability", headers=headers)
        assert capability.json() == {
            "available": False,
            "public_research_only": False,
            "code": "BROWSER_CLOUD_GATE_UNAVAILABLE",
            "remembered_sessions_available": False,
            "owner_id": "owner",
            "pod_id": "pod",
            "incarnation": "epoch",
            "environment": "development",
        }
        refused = await client.post(
            path + "/tasks",
            headers=headers,
            json={
                "request_id": "request_1",
                "goal": "private goal",
                "allowed_origins": ["https://example.com"],
            },
        )
        assert refused.status_code == 503
        invalid = await client.post(
            path + "/tasks/task/input",
            headers={**headers, "X-Browser-Pod-Incarnation": "epoch"},
            json={
                "operation": "type",
                "sequence": 1,
                "control_epoch": 1,
                "x": "owner-password",
                "y": 1,
                "text": "owner-secret",
            },
        )
        assert invalid.status_code == 422
        assert "owner-password" not in invalid.text and "owner-secret" not in invalid.text
        fixture = task_runtime_fixture(monkeypatch)
        app.state.browser_task_runtime = fixture.runtime
        accepted = await client.post(
            path + "/tasks",
            headers=headers,
            json={
                "request_id": "request_1",
                "goal": "Review a public page.",
                "allowed_origins": ["https://example.com"],
                "fields": [],
            },
        )
        assert accepted.status_code == 202
        task_id = accepted.json()["binding"]["task_id"]
        await fixture.runtime._tasks[task_id].worker
        discovered = await client.get(path + "/tasks", headers=headers)
        assert discovered.status_code == 200
        assert discovered.json()[0]["binding"]["task_id"] == task_id
        assert not {"goal", "review", "summary", "frame"} & set(discovered.json()[0])
        pinned = {**headers, "X-Browser-Pod-Incarnation": "epoch"}
        status = await client.get(path + "/tasks/" + task_id, headers=pinned)
        approved = await client.post(
            path + "/tasks/" + task_id + "/review",
            headers=pinned,
            json={
                "review_id": status.json()["review"]["review_id"],
                "receipt": "synthetic-owner-receipt-" + "x" * 32,
            },
        )
        assert approved.status_code == 200
        await asyncio.wait_for(fixture.model.entered.wait(), 2)
        preview = await client.get(path + "/tasks/" + task_id + "/frame", headers=pinned)
        assert preview.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert preview.headers["x-browser-task-id"] == task_id
        assert preview.headers["x-browser-pod-incarnation"] == "epoch"
        assert preview.headers["cache-control"] == "no-store, private"
        switched = await client.get(
            path + "/tasks/" + task_id + "/frame",
            headers={**headers, "X-Browser-Pod-Incarnation": "other"},
        )
        assert switched.status_code == 409
        snapshot = await client.get(path + "/tasks/" + task_id, headers=pinned)
        taken = await client.post(
            path + "/tasks/" + task_id + "/control",
            headers=pinned,
            json={"operation": "takeover", "control_epoch": snapshot.json()["control_epoch"]},
        )
        manual = await client.post(
            path + "/tasks/" + task_id + "/input",
            headers=pinned,
            json={
                "operation": "keys",
                "sequence": taken.json()["next_sequence"],
                "control_epoch": taken.json()["control_epoch"],
                "keys": ["Tab"],
            },
        )
        assert manual.status_code == 202  # JSON arrays become the strict tuple execution contract
        await fixture.runtime.drain()


async def _lose_closed_write(monkeypatch, log, failure):
    from hushh_mcp.services.pod_browser.task_recovery import CLOSED_KIND

    lost_readback = failure == "lost_readback"
    append = log.append
    replay = log.replay
    lost = [False]
    readback_pending = [False]

    async def lose_closed_ack(kind, payload, **kwargs):
        if kind == CLOSED_KIND and not lost[0]:
            lost[0] = True
            if failure != "before_write":
                await append(kind, payload, **kwargs)
            readback_pending[0] = lost_readback
            if failure == "stale_read":
                readback_pending[0] = True
            raise RuntimeError("synthetic lost acknowledgement after durable append")
        return await append(kind, payload, **kwargs)

    async def lose_first_readback():
        if readback_pending[0]:
            readback_pending[0] = False
            if failure == "stale_read":
                return (await replay())[:-1]
            raise OSError("synthetic transient read failure")
        return await replay()

    monkeypatch.setattr(log, "append", lose_closed_ack)
    monkeypatch.setattr(log, "replay", lose_first_readback)
    return lost


@pytest.mark.parametrize("failure", ["lost_reply", "lost_readback", "before_write", "stale_read"])
async def test_closed_browser_result_recovers_privately_without_executing_again(
    monkeypatch, tmp_path, failure
):
    from dataclasses import replace

    from hushh_mcp.services.pod_browser.contracts import BrowserRefused
    from hushh_mcp.services.pod_browser.task_recovery import CLOSED_KIND
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog, PodLogFenced
    from tests.helpers.pod_browser import approved_task

    log = PodCommitLog(LocalObjectStore(str(tmp_path)), b"L" * 32, owner_id="owner")
    fixture = task_runtime_fixture(monkeypatch, log=log)
    original = await approved_task(fixture)
    assert (
        next(iter(fixture.reviews.previews.values())).terms["result_storage"]
        == "owner_encrypted_log"
    )
    lost_readback = failure == "lost_readback"
    lost = await _lose_closed_write(monkeypatch, log, failure)
    fixture.model.release.set()
    worker = fixture.runtime._tasks[original.binding.task_id].worker
    if lost_readback:
        with pytest.raises(BrowserRefused, match="CLOSE_UNCONFIRMED"):
            await worker
        assert fixture.admission._states["epoch"].active == 1
        task = fixture.runtime._tasks[original.binding.task_id]
        assert task.request is task.access is task.processing is task.control is None
        assert (await fixture.runtime.list_tasks(fixture.owner))[0].phase == "running"
    else:
        await worker
    terminal = await fixture.runtime.read(fixture.owner, original.binding.task_id)
    assert terminal.phase == "completed" and terminal.control_owner == "stopped"
    assert terminal.summary == "Finished the requested task."
    records = await log.replay()
    assert records[-1]["kind"] == CLOSED_KIND
    assert sum(record["kind"] == CLOSED_KIND for record in records) == 1 and lost[0]
    assert fixture.driver.calls.count("close") == 1
    assert fixture.admission._states["epoch"].active == 0
    assert all(
        terminal.summary.encode() not in path.read_bytes()
        for path in tmp_path.rglob("*")
        if path.is_file()
    )  # real storage receives ciphertext, never the owner result
    restarted = task_runtime_fixture(monkeypatch, log=log)
    restored = await restarted.runtime.read(restarted.owner, original.binding.task_id)
    assert (restored.phase, restored.code, restored.summary) == (
        terminal.phase,
        terminal.code,
        terminal.summary,
    )
    assert "summary" not in (await restarted.runtime.list_tasks(restarted.owner))[0].model_dump()
    with pytest.raises(BrowserRefused, match="RECOVERY_REQUIRES_OWNER"):
        await restarted.runtime.start(restarted.owner, restarted.request)
    with pytest.raises(BrowserRefused, match="OWNER_REFUSED"):
        await restarted.runtime.read(
            replace(restarted.owner, owner_id="other"), original.binding.task_id
        )
    restarted.runtime._incarnation = "replacement"
    restarted.runtime._hydrated = False
    replacement = replace(restarted.owner, incarnation="replacement")
    assert (await restarted.runtime.read(replacement, original.binding.task_id)).summary is None
    assert restarted.launcher.calls == 0
    await log.fence_for_erasure(owner_id="owner", attempt_id="erase-browser-result")
    with pytest.raises(PodLogFenced):
        await restarted.runtime.read(replacement, original.binding.task_id)


@pytest.mark.parametrize("fault", ["legacy", "nonterminal", "owner_control", "summary", "orphan"])
async def test_browser_recovery_never_promotes_unclosed_or_malformed_completion(monkeypatch, fault):
    from hushh_mcp.services.pod_browser.contracts import BrowserRefused
    from hushh_mcp.services.pod_browser.task_recovery import (
        CLOSED_KIND,
        KIND,
        recover_browser_tasks,
    )

    fixture = task_runtime_fixture(monkeypatch)
    initial = await fixture.runtime.start(fixture.owner, fixture.request)
    await fixture.runtime._tasks[initial.binding.task_id].worker
    await fixture.runtime.drain()
    fixture.log.records = [
        record for record in fixture.log.records if record["kind"] != CLOSED_KIND
    ]
    # Historical checkpoints never carried a private pending review.
    source = initial.model_copy(
        update={"revision": initial.revision + 10, "phase": "completed", "review": None}
    )
    record = {
        "kind": KIND,
        "payload": {"request_id": "request_1", "snapshot": source.model_dump(mode="json")},
    }
    if fault == "legacy":
        fixture.log.records.append(record)
        restored, _ = await recover_browser_tasks(fixture.log, "owner", "pod", incarnation="epoch")
        assert restored[initial.binding.task_id].phase == "outcome_uncertain"
        assert restored[initial.binding.task_id].summary is None
        return
    record["kind"] = CLOSED_KIND
    record["payload"]["snapshot"].update(control_owner="stopped", summary="Private result")
    if fault == "nonterminal":
        record["payload"]["snapshot"]["phase"] = "running"
    elif fault == "owner_control":
        record["payload"]["snapshot"]["control_owner"] = "owner"
    elif fault == "summary":
        record["kind"] = KIND
    else:
        fixture.log.records.clear()
    fixture.log.records.append(record)
    with pytest.raises(BrowserRefused, match="TASK_LOG_INVALID"):
        await recover_browser_tasks(fixture.log, "owner", "pod", incarnation="epoch")
