"""Real route admission with synthetic identity/service boundaries."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth_read_only, require_vault_owner_token
from api.routes import drive_sharing as routes
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

BASE = "/api/connectors/google_drive/sharing/requests"
REQUEST_ID = str(uuid4())


@pytest.fixture
def setup(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    service = SimpleNamespace(
        **{
            name: AsyncMock(return_value={"status": "pending"})
            for name in (
                "create",
                "list_requests",
                "status",
                "review",
                "delivery",
                "approve",
                "decide",
                "retry_preparation",
                "prepare_revocation",
                "revoke",
            )
        }
    )
    monkeypatch.setattr(routes, "_service", lambda: service)
    current = AsyncMock(return_value={"user_id": "recipient"})
    # FastAPI retains the original dependency; this replaces only the fresh
    # post-await revalidation call, not the initial route admission.
    monkeypatch.setattr(routes, "require_vault_owner_token", current)
    return TestClient(app), app, service, current


def unlock(app, uid="recipient"):
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": uid,
        "token": "synthetic-owner",
    }


@pytest.mark.parametrize(
    "method,suffix,body",
    [
        ("get", "", None),
        ("get", f"/{REQUEST_ID}", None),
        ("get", f"/{REQUEST_ID}/review", None),
        ("get", f"/{REQUEST_ID}/delivery", None),
        ("post", f"/{REQUEST_ID}/prepare", {}),
        ("post", f"/{REQUEST_ID}/prepare/stream", {}),
        (
            "post",
            "",
            {
                "ownerUserId": "owner",
                "clientRequestId": str(uuid4()),
                "purpose": {"purpose": "Statements"},
            },
        ),
        (
            "post",
            f"/{REQUEST_ID}/approve",
            {
                "revision": 1,
                "reviewDigest": "a" * 64,
                "documentIds": [str(uuid4())],
                "confirmed": True,
            },
        ),
        ("post", f"/{REQUEST_ID}/decline", {"revision": 0}),
        ("post", f"/{REQUEST_ID}/cancel", {"revision": 0}),
        ("post", f"/{REQUEST_ID}/review/refresh", {"revision": 0}),
        ("post", f"/{REQUEST_ID}/revocation/prepare", None),
        (
            "post",
            f"/{REQUEST_ID}/revocation/confirm",
            {
                "revision": 1,
                "directiveId": "synthetic-directive",
                "reviewDigest": "a" * 64,
                "grantIds": [str(uuid4())],
                "confirmed": True,
            },
        ),
    ],
)
def test_every_route_requires_owner(setup, method, suffix, body):
    client, _, service, _ = setup
    response = client.request(method, BASE + suffix, json=body)
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    assert all(not value.called for value in vars(service).values())


def test_review_is_owner_derived_no_store_and_authority_rechecked(setup):
    client, app, service, current = setup
    unlock(app)
    service.review.return_value = {"files": [{"name": "private-name"}]}
    response = client.get(BASE + f"/{REQUEST_ID}/review")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    service.review.assert_awaited_once_with(user_id="recipient", request_id=REQUEST_ID)
    assert current.await_count == 2
    assert all(
        call.kwargs == {"authorization": "Bearer synthetic-owner", "hushh_consent": None}
        for call in current.await_args_list
    )


def test_late_owner_revocation_releases_no_private_result(setup):
    client, app, service, current = setup
    unlock(app)
    service.review.return_value = {"files": [{"name": "private-name"}]}
    current.side_effect = [{"user_id": "recipient"}, HTTPException(401, "Owner revoked")]
    response = client.get(BASE + f"/{REQUEST_ID}/review")
    assert response.status_code == 401 and "private-name" not in response.text
    assert "no-store" in response.headers["Cache-Control"]


@pytest.mark.parametrize(
    "change",
    [
        {"email": "injected@example.invalid"},
        {"role": "owner"},
        {"generation": 9},
        {"user_id": "other"},
        {"confirmed": 1},
        {"confirmed": "true"},
    ],
)
def test_approval_does_not_accept_client_authority(setup, change):
    client, app, service, _ = setup
    unlock(app)
    body = {
        "revision": 1,
        "reviewDigest": "a" * 64,
        "documentIds": [str(uuid4())],
        "confirmed": True,
    }
    response = client.post(BASE + f"/{REQUEST_ID}/approve", json={**body, **change})
    assert response.status_code == 422
    assert "no-store" in response.headers["Cache-Control"]
    service.approve.assert_not_called()


def test_validation_never_echoes_private_payload(setup):
    client, app, _, _ = setup
    unlock(app)
    response = client.post(
        BASE + f"/{REQUEST_ID}/approve",
        json={
            "revision": "private-value-accidentally-pasted",
            "reviewDigest": "a" * 64,
            "documentIds": [str(uuid4())],
            "confirmed": True,
        },
    )
    assert response.status_code == 422
    assert "private-value-accidentally-pasted" not in response.text


def test_approval_only_acknowledges_pending_work(setup):
    client, app, service, _ = setup
    unlock(app)
    service.approve.return_value = {"status": "approved", "sharingStatus": "pending"}
    response = client.post(
        BASE + f"/{REQUEST_ID}/approve",
        json={
            "revision": 1,
            "reviewDigest": "a" * 64,
            "documentIds": [str(uuid4())],
            "confirmed": True,
        },
    )
    assert response.status_code == 202
    assert response.json() == {"status": "approved", "sharingStatus": "pending"}


@pytest.mark.parametrize(
    "error", [RuntimeError("secret-provider-body"), DriveSharingError("secret-provider-body")]
)
def test_unknown_errors_are_redacted(setup, error):
    client, app, service, _ = setup
    unlock(app)
    service.review.side_effect = error
    response = client.get(BASE + f"/{REQUEST_ID}/review")
    assert response.status_code == 503 and "secret-provider-body" not in response.text
    assert "no-store" in response.headers["Cache-Control"]


def google_identity(monkeypatch, app, *, firebase_uid="recipient", changes=None):
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: firebase_uid
    claims = {
        "uid": "recipient",
        "email": "recipient@example.invalid",
        "email_verified": True,
        "auth_time": datetime.now(UTC).timestamp(),
        "firebase": {"sign_in_provider": "google.com", "identities": {"google.com": ["12345"]}},
        **(changes or {}),
    }
    app_marker = object()
    monkeypatch.setattr(routes, "get_firebase_auth_app", lambda: app_marker)
    verifier = Mock(return_value=claims)
    monkeypatch.setattr(routes.firebase_auth, "verify_id_token", verifier)
    monkeypatch.setattr(
        routes.firebase_auth,
        "get_user",
        Mock(
            return_value=SimpleNamespace(
                disabled=False,
                provider_data=[
                    SimpleNamespace(
                        provider_id="google.com", uid="12345", email="recipient@example.invalid"
                    )
                ],
            )
        ),
    )
    return verifier, app_marker


def create_body():
    return {
        "ownerUserId": "owner",
        "clientRequestId": str(uuid4()),
        "purpose": {"purpose": "Statements"},
    }


def test_request_uses_fresh_verified_google_identity_not_drive_connection(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    verifier, marker = google_identity(monkeypatch, app)
    response = client.post(
        BASE, json=create_body(), headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 202
    recipient = service.create.await_args.kwargs["recipient"]
    assert recipient.user_id == "recipient" and recipient.subject == "12345"
    verifier.assert_called_once_with("synthetic-firebase", app=marker, check_revoked=False)


def test_request_resolves_public_reference_without_accepting_identity_from_client(
    setup, monkeypatch
):
    client, app, service, current = setup
    unlock(app)
    google_identity(monkeypatch, app)
    target = str(uuid4())
    resolve = Mock(return_value=("resolved-owner", {"status": "connected"}))
    monkeypatch.setattr(
        routes, "PersonProfileService", lambda: SimpleNamespace(get_relationship_target=resolve)
    )
    body = {**create_body(), "ownerPersonRef": target}
    del body["ownerUserId"]
    response = client.post(BASE, json=body, headers={"Authorization": "Bearer synthetic-firebase"})
    assert response.status_code == 202
    resolve.assert_called_once_with(viewer_user_id="recipient", public_person_ref=target)
    assert service.create.await_args.kwargs["owner_user_id"] == "resolved-owner"
    assert "resolved-owner" not in response.text
    assert current.await_count >= 3


@pytest.mark.parametrize(
    "targets",
    [
        {},
        {"ownerUserId": "owner", "ownerPersonRef": str(uuid4())},
        {"ownerPersonRef": "private-invalid-value"},
    ],
)
def test_request_requires_exactly_one_valid_owner_target(setup, monkeypatch, targets):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app)
    body = create_body()
    del body["ownerUserId"]
    response = client.post(
        BASE, json={**body, **targets}, headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 422
    assert "private-invalid-value" not in response.text
    service.create.assert_not_called()


@pytest.mark.parametrize(
    "failure",
    [routes.PersonProfileNotFoundError("missing"), TimeoutError("private-provider-error")],
)
def test_owner_reference_failure_is_redacted_and_does_not_mutate(setup, monkeypatch, failure):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app)
    monkeypatch.setattr(
        routes,
        "PersonProfileService",
        lambda: SimpleNamespace(get_relationship_target=Mock(side_effect=failure)),
    )
    body = create_body()
    del body["ownerUserId"]
    response = client.post(
        BASE,
        json={**body, "ownerPersonRef": str(uuid4())},
        headers={"Authorization": "Bearer synthetic-firebase"},
    )
    assert response.status_code in (404, 503)
    assert "private-provider-error" not in response.text
    service.create.assert_not_called()


def test_owner_lock_during_reference_lookup_prevents_create(setup, monkeypatch):
    client, app, service, current = setup
    unlock(app)
    google_identity(monkeypatch, app)

    def resolve(**kwargs):
        current.side_effect = HTTPException(401, "Owner locked")
        return "resolved-owner", {"status": "connected"}

    monkeypatch.setattr(
        routes, "PersonProfileService", lambda: SimpleNamespace(get_relationship_target=resolve)
    )
    body = create_body()
    del body["ownerUserId"]
    response = client.post(
        BASE,
        json={**body, "ownerPersonRef": str(uuid4())},
        headers={"Authorization": "Bearer synthetic-firebase"},
    )
    assert response.status_code == 401
    service.create.assert_not_called()


def test_crossed_firebase_and_vault_owners_fail_before_provider_lookup(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    verifier, _ = google_identity(monkeypatch, app, firebase_uid="attacker")
    response = client.post(
        BASE, json=create_body(), headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 403
    verifier.assert_not_called()
    service.create.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [
        {"firebase": {"identities": {"google.com": ["attacker"]}}},
        {"firebase": {"sign_in_provider": "password"}},
    ],
)
def test_missing_or_substituted_linked_identity_cannot_request(setup, monkeypatch, changes):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app, changes=changes)
    response = client.post(
        BASE, json=create_body(), headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 409
    service.create.assert_not_called()


def test_prepare_rejects_client_claimed_foreground_authority(setup):
    client, app, _, _ = setup
    unlock(app)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare", json={"foreground": True})
    assert response.status_code == 422


def test_prepare_rechecks_owner_and_sanitizes_failure(setup, monkeypatch):
    from hushh_mcp.services import drive_suggestion_service

    client, app, _, current = setup
    unlock(app)
    worker = SimpleNamespace(
        run_one=AsyncMock(side_effect=RuntimeError("private provider response"))
    )
    factory = Mock(return_value=worker)
    monkeypatch.setattr(drive_suggestion_service, "DriveSuggestionService", factory)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare", json={})
    assert response.status_code == 503
    assert "private provider" not in response.text
    assert "no-store" in response.headers["Cache-Control"]
    assert current.await_count >= 1
    assert callable(factory.call_args.kwargs["require_owner"])


def sse_frames(text):
    """Parse the stream body into (event, payload) pairs."""
    import json

    frames = []
    for block in text.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            frames.append((lines["event"], json.loads(lines["data"])))
    return frames


@pytest.fixture(autouse=True)
def no_stream_tasks():
    routes._PREPARE_STREAM_TASKS.clear()
    yield
    routes._PREPARE_STREAM_TASKS.clear()


def stream_worker(monkeypatch, run_one):
    from hushh_mcp.services import drive_suggestion_service

    worker = SimpleNamespace(run_one=run_one)
    factory = Mock(return_value=worker)
    monkeypatch.setattr(drive_suggestion_service, "DriveSuggestionService", factory)
    return factory


def test_prepare_stream_rejects_client_claimed_foreground_authority(setup):
    client, app, _, _ = setup
    unlock(app)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={"foreground": True})
    assert response.status_code == 422


def test_prepare_stream_emits_public_stages_then_status(setup, monkeypatch):
    client, app, _, current = setup
    unlock(app)

    async def run_one(*, user_id, request_id, on_stage, on_progress):
        assert (user_id, request_id) == ("recipient", REQUEST_ID)
        for stage in ("searching", "choosing", "checking", "checking"):
            on_stage(stage)
        on_progress(1, 2)
        on_progress(2, 2)
        on_progress(0, 2)  # invalid counts cannot reach the owner
        return "review_ready"

    factory = stream_worker(monkeypatch, run_one)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["Cache-Control"] == "private, no-store, no-cache, no-transform"
    assert sse_frames(response.text) == [
        ("stage", {"event": "stage", "stage": "starting"}),
        ("stage", {"event": "stage", "stage": "searching"}),
        ("stage", {"event": "stage", "stage": "choosing"}),
        ("stage", {"event": "stage", "stage": "checking"}),
        ("file", {"event": "file", "completed": 1, "total": 2}),
        ("file", {"event": "file", "completed": 2, "total": 2}),
        ("complete", {"event": "complete", "status": "review_ready"}),
    ]
    # Before the 200 and again after the run, like POST /prepare.
    assert current.await_count == 2
    assert callable(factory.call_args.kwargs["require_owner"])


def test_prepare_stream_reports_a_worker_held_lease(setup, monkeypatch):
    client, app, _, _ = setup
    unlock(app)
    stream_worker(monkeypatch, AsyncMock(return_value="not_claimed"))
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert sse_frames(response.text) == [
        ("stage", {"event": "stage", "stage": "starting"}),
        ("complete", {"event": "complete", "status": "not_claimed"}),
    ]


@pytest.mark.parametrize(
    "error", [RuntimeError("secret-provider-body"), DriveSharingError("secret-provider-body")]
)
def test_prepare_stream_failures_are_redacted(setup, monkeypatch, caplog, error):
    client, app, _, _ = setup
    unlock(app)
    stream_worker(monkeypatch, AsyncMock(side_effect=error))
    with caplog.at_level("DEBUG"):
        response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert response.status_code == 200
    assert sse_frames(response.text)[-1] == (
        "error",
        {
            "event": "error",
            "code": "sharing_unavailable",
            "message": "Document sharing is not available yet.",
        },
    )
    assert "secret-provider-body" not in response.text
    assert "secret-provider-body" not in caplog.text


def test_prepare_stream_stale_owner_is_a_real_http_error(setup, monkeypatch):
    client, app, _, current = setup
    unlock(app)
    current.side_effect = HTTPException(401, "Owner revoked")
    factory = stream_worker(monkeypatch, AsyncMock(return_value="review_ready"))
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    factory.assert_not_called()


def test_prepare_stream_late_owner_revocation_ends_without_a_result(setup, monkeypatch):
    client, app, _, current = setup
    unlock(app)
    current.side_effect = [{"user_id": "recipient"}, HTTPException(401, "Owner revoked")]
    stream_worker(monkeypatch, AsyncMock(return_value="review_ready"))
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    # No terminal frame: the client's next status read surfaces the real 401.
    assert sse_frames(response.text) == [("stage", {"event": "stage", "stage": "starting"})]
    assert "review_ready" not in response.text


def test_prepare_stream_refuses_work_past_the_pending_cap(setup, monkeypatch):
    client, app, _, _ = setup
    unlock(app)
    monkeypatch.setattr(routes, "PREPARE_STREAM_MAX_PENDING", 0)
    factory = stream_worker(monkeypatch, AsyncMock(return_value="review_ready"))
    response = client.post(BASE + f"/{REQUEST_ID}/prepare/stream", json={})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "sharing_unavailable"
    assert "no-store" in response.headers["Cache-Control"]
    factory.assert_not_called()


class _Disconnecting:
    def __init__(self, after):
        self.checks = 0
        self.after = after

    async def is_disconnected(self):
        self.checks += 1
        return self.checks > self.after


async def test_prepare_stream_disconnect_never_cancels_the_preparation(monkeypatch):
    import asyncio

    release = asyncio.Event()
    finished = []

    async def run_one(*, user_id, request_id, on_stage, on_progress):
        await release.wait()
        finished.append(request_id)
        return "review_ready"

    stream_worker(monkeypatch, run_one)
    owner = routes.Owner("recipient", "synthetic-owner")
    monkeypatch.setattr(owner.__class__, "require_current", AsyncMock())
    stream = routes._prepare_stream(
        request=_Disconnecting(after=0), owner=owner, request_id=REQUEST_ID
    )
    assert b"starting" in await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    await stream.aclose()
    pending = list(routes._PREPARE_STREAM_TASKS)
    assert len(pending) == 1 and not pending[0].done()
    release.set()
    await asyncio.gather(*pending)
    assert finished == [REQUEST_ID]
    assert not routes._PREPARE_STREAM_TASKS


async def test_prepare_stream_deadline_closes_without_a_terminal_frame(monkeypatch):
    import asyncio

    release = asyncio.Event()

    async def run_one(*, user_id, request_id, on_stage, on_progress):
        await release.wait()
        return "review_ready"

    stream_worker(monkeypatch, run_one)
    monkeypatch.setattr(routes, "PREPARE_STREAM_DEADLINE_SECONDS", 0.05)
    monkeypatch.setattr(routes, "PREPARE_STREAM_HEARTBEAT_SECONDS", 0.01)
    owner = routes.Owner("recipient", "synthetic-owner")
    monkeypatch.setattr(owner.__class__, "require_current", AsyncMock())
    chunks = [
        chunk
        async for chunk in routes._prepare_stream(
            request=_Disconnecting(after=10_000), owner=owner, request_id=REQUEST_ID
        )
    ]
    events = [frame[0] for frame in sse_frames(b"".join(chunks).decode())]
    assert events[0] == "stage" and "heartbeat" in events
    assert "complete" not in events and "error" not in events
    pending = list(routes._PREPARE_STREAM_TASKS)
    assert len(pending) == 1 and not pending[0].done()
    release.set()
    await asyncio.gather(*pending)
