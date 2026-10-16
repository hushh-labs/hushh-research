"""Owner-only search authorization and private failure responses."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import drive_searches as routes
from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan

BASE = "/api/connectors/google_drive/searches"
JOB = "fc110012-1111-4111-8111-111111111111"
BODY = {"clientRequestId": JOB, "query": "find my product documents", "backgroundConsent": True}


@pytest.fixture
def setup(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    service = SimpleNamespace(
        **{
            name: AsyncMock(return_value={"jobId": JOB, "status": "queued"})
            for name in ("create", "list", "status", "results", "stop")
        }
    )
    service.existing = AsyncMock(return_value=None)
    current = AsyncMock()
    monkeypatch.setattr(routes.Owner, "require_current", current)
    monkeypatch.setattr(routes, "_service", lambda: service)
    monkeypatch.setattr(routes, "connector_feature_enabled", lambda *_: True)
    planner = AsyncMock(return_value=LiveSearchPlan(terms=["product"], mode="find"))
    monkeypatch.setattr(routes, "plan_live_search", planner)
    return app, TestClient(app), service, current, planner


def unlock(app):
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "synthetic-owner",
        "token": "synthetic-test-owner",
    }


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("post", "", BODY),
        ("get", "", None),
        ("get", f"/{JOB}", None),
        ("get", f"/{JOB}/stream", None),
        ("get", f"/{JOB}/results", None),
        ("post", f"/{JOB}/stop", {}),
    ],
)
def test_search_endpoints_require_owner_and_never_echo_input(setup, method, path, body):
    _, client, service, _, planner = setup
    response = client.request(method, BASE + path, json=body)
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    assert BODY["query"] not in response.text
    planner.assert_not_awaited()
    assert not any(mock.called for mock in vars(service).values())


def test_create_requires_search_specific_consent_and_rechecks_after_planner(setup):
    app, client, service, current, planner = setup
    unlock(app)
    response = client.post(BASE, json={**BODY, "backgroundConsent": False})
    assert response.status_code == 400
    planner.assert_not_awaited()
    current.reset_mock()
    current.side_effect = [None, HTTPException(403, "expired")]
    response = client.post(BASE, json=BODY)
    assert response.status_code == 403
    service.create.assert_not_awaited()
    current.side_effect = None
    response = client.post(BASE, json=BODY)
    assert response.status_code == 200
    call = service.create.await_args.kwargs
    assert call["user_id"] == "synthetic-owner" and call["background_consent"] is True
    assert call["plan"]["mode"] == "find"
    assert "token" not in call and "consent_token" not in call


def test_read_plan_cannot_start_background_content_reads_and_validation_is_private(setup):
    app, client, service, _, planner = setup
    unlock(app)
    planner.return_value = LiveSearchPlan(terms=["product"], mode="read")
    response = client.post(BASE, json=BODY)
    assert response.status_code == 400
    service.create.assert_not_awaited()
    response = client.post(BASE, json={**BODY, "private_extra": "PRIVATE_SECRET"})
    assert response.status_code == 422
    assert "PRIVATE_SECRET" not in response.text
    assert BODY["query"] not in response.text


def test_retry_reuses_job_without_replanning(setup):
    app, client, service, _, planner = setup
    unlock(app)
    service.existing.return_value = {"jobId": JOB, "status": "running"}
    response = client.post(BASE, json=BODY)
    assert response.status_code == 200
    assert response.json()["jobId"] == JOB
    planner.assert_not_awaited()
    service.create.assert_not_awaited()
    assert service.existing.await_args.kwargs["query"] == BODY["query"]


def test_stop_remains_available_when_search_feature_disabled(setup, monkeypatch):
    app, client, service, _, _ = setup
    unlock(app)
    monkeypatch.setattr(routes, "connector_feature_enabled", lambda *_: False)
    assert client.post(BASE + f"/{JOB}/stop", json={}).status_code == 200
    service.stop.assert_awaited_once()
    assert client.get(BASE).status_code == 200
    assert client.get(BASE + f"/{JOB}").status_code == 200
    assert client.get(BASE + f"/{JOB}/results").status_code == 503
    assert client.post(BASE, json=BODY).status_code == 503


def test_connector_storage_failure_is_an_authored_503_not_a_raw_500(setup):
    # Production 2026-09-27: the store raised ConnectorLifecycleError (FK on a
    # missing google_drive catalog row) straight through _call as a 500.
    from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError

    app, client, service, _, _ = setup
    unlock(app)
    service.list.side_effect = ConnectorLifecycleError("connector_storage_unavailable")
    response = client.get(BASE)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "search_unavailable"
    assert "connector_storage_unavailable" not in response.text
    assert "no-store" in response.headers["Cache-Control"]


@pytest.mark.parametrize("timezone", ["UTC", "Asia/Calcutta", "Asia/Kolkata", "America/New_York"])
def test_create_supports_browser_timezones_without_os_timezone_database(setup, timezone):
    import zoneinfo

    app, client, service, _, planner = setup
    unlock(app)
    previous = zoneinfo.TZPATH
    try:
        # Slim runtime images need the packaged IANA database, including browser
        # aliases such as Asia/Calcutta. A developer OS must not hide that gap.
        zoneinfo.reset_tzpath(())
        zoneinfo.ZoneInfo.clear_cache()
        response = client.post(BASE, json={**BODY, "timezone": timezone})
        assert response.status_code == 200
        assert service.existing.await_args.kwargs["timezone"] == timezone
        assert service.create.await_args.kwargs["timezone"] == timezone
        assert f'"user_timezone": "{timezone}"' in planner.await_args.kwargs["prompt"]
    finally:
        zoneinfo.reset_tzpath(previous)
        zoneinfo.ZoneInfo.clear_cache()


def test_invalid_timezone_still_rejected_before_job_lookup_or_planning(setup, caplog):
    app, client, service, _, planner = setup
    unlock(app)
    response = client.post(BASE, json={**BODY, "timezone": "Invalid/PrivateTimezone"})
    assert response.status_code == 400
    assert "PrivateTimezone" not in response.text
    assert "drive_search.rejected reason=timezone_unavailable" in caplog.text
    assert "PrivateTimezone" not in caplog.text
    assert BODY["query"] not in caplog.text
    service.existing.assert_not_awaited()
    planner.assert_not_awaited()


def test_stream_returns_committed_terminal_status_without_starting_work(setup):
    import json

    app, client, service, current, planner = setup
    unlock(app)
    service.status.return_value = {
        "jobId": JOB,
        "status": "completed",
        "revision": 4,
        "pagesScanned": 3,
        "matched": 1007,
        "incompleteSearch": False,
    }
    response = client.get(BASE + f"/{JOB}/stream")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "no-store" in response.headers["cache-control"]
    assert response.headers["x-accel-buffering"] == "no"
    frame = json.loads(response.text.split("data: ", 1)[1])
    assert frame == {"event": "status", **service.status.return_value}
    assert current.await_count >= 3
    service.create.assert_not_awaited()
    planner.assert_not_awaited()


@pytest.mark.asyncio
async def test_stream_revocation_ends_without_reading_more_results():
    owner = SimpleNamespace(require_current=AsyncMock(side_effect=HTTPException(403, "private")))
    service = SimpleNamespace(status=AsyncMock())
    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
    frames = [
        frame
        async for frame in routes._status_stream(
            request=request,
            owner=owner,
            service=service,
            job_id=JOB,
            initial={"status": "running", "private": "MUST_NOT_BE_SENT"},
        )
    ]
    assert frames == ['event: error\ndata: {"code":"search_unavailable"}\n\n']
    service.status.assert_not_awaited()


@pytest.mark.asyncio
async def test_stream_disconnect_does_not_stop_durable_search():
    owner = SimpleNamespace(require_current=AsyncMock())
    service = SimpleNamespace(status=AsyncMock(), stop=AsyncMock())
    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=True))
    assert [
        frame
        async for frame in routes._status_stream(
            request=request,
            owner=owner,
            service=service,
            job_id=JOB,
            initial={"status": "running"},
        )
    ] == []
    service.stop.assert_not_awaited()
    service.status.assert_not_awaited()


@pytest.mark.asyncio
async def test_stream_continues_after_metadata_until_content_evaluation_completes(monkeypatch):
    owner = SimpleNamespace(user_id="owner", require_current=AsyncMock())
    done = {
        "jobId": JOB,
        "status": "completed",
        "revision": 6,
        "evaluation": {
            "status": "ready",
            "evaluatedCount": 6,
            "pendingCount": 0,
            "verifiedCount": 2,
        },
    }
    service = SimpleNamespace(status=AsyncMock(return_value=done))
    request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
    monkeypatch.setattr(routes.asyncio, "sleep", AsyncMock())
    frames = [
        frame
        async for frame in routes._status_stream(
            request=request,
            owner=owner,
            service=service,
            job_id=JOB,
            initial={
                "jobId": JOB,
                "status": "completed",
                "revision": 5,
                "evaluation": {
                    "status": "running",
                    "evaluatedCount": 3,
                    "pendingCount": 3,
                    "verifiedCount": 1,
                },
            },
        )
    ]
    assert len(frames) == 2
    assert '"status":"running"' in frames[0]
    assert '"status":"ready"' in frames[1]
    service.status.assert_awaited_once()
    assert owner.require_current.await_count >= 4
