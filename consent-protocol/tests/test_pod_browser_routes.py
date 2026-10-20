"""Browser HTTP admission and private response boundaries."""

import asyncio

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
        assert manual.status_code == 200  # JSON arrays become the strict tuple execution contract
        await fixture.runtime.drain()
