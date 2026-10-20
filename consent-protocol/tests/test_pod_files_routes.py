"""Direct Files scopes remain separate; devices cannot enter the library."""

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import pod_files
from hushh_mcp.services.pod_files import jobs, runtime
from hushh_mcp.services.pod_files.library import FilesLibrary, FilesRefused
from hushh_mcp.services.pod_files.storage import FilesLocalStore
from tests.test_pod_files_jobs import queued_library as queued_library
from tests.test_pod_session_authority import Subject, World, _binding
from tests.test_pod_session_authority import hub_key as hub_key


async def test_scheduled_owner_control_refuses_device_and_read_only_app(
    tmp_path, hub_key, monkeypatch
):
    from api.routes.one import pod_scheduled_tasks as routes
    from hushh_mcp.services.pod_scheduled_authority import ScheduledGrantAuthority
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleAccess, ScheduledTasks
    from tests.test_pod_scheduled_tasks import schedule_request
    from tests.test_pod_session_authority import OWNER, USER

    world = World(tmp_path / "pod")
    authority = await world.boot()
    monkeypatch.setattr("api.routes.one.pod_session.authority_or_503", lambda: authority)
    reader, writer, device = (
        Subject("reader", "web"),
        Subject("writer", "web"),
        Subject("device", "macos"),
    )
    tokens = [
        await world.admit(subject, _binding(subject, scopes=scopes))
        for subject, scopes in [
            (reader, ["pod.status"]),
            (writer, ["pod.status", "pod.act", "files.manage"]),
            (device, ["puppy.inference"]),
        ]
    ]
    capability = SimpleNamespace(
        required_scopes=("pod.act", "files.manage"),
        prepare=AsyncMock(return_value={"file_revision": 1}),
        run=AsyncMock(),
    )
    runtime = ScheduledTasks(
        access=ScheduleAccess(USER, OWNER, "epoch", AsyncMock()),
        log=world.log,
        capabilities={"agent_files.organize_file.v1": capability},
        delivery=SimpleNamespace(require_ready=lambda: None, offer=AsyncMock()),
        admission=SimpleNamespace(acquire_turn=AsyncMock()),
        check_grant=ScheduledGrantAuthority(authority, USER, authority.require_held).check_grant,
        clock=lambda: 1000,
    )
    monkeypatch.setattr(routes, "active_scheduled_tasks", lambda: runtime)
    app = FastAPI()
    app.include_router(routes.router)
    body = schedule_request().model_dump()
    with TestClient(app) as client:
        for token, _ in (tokens[0], tokens[2]):
            assert (
                client.post(
                    "/api/one/pod/tasks", headers={"Authorization": "Bearer " + token}, json=body
                ).status_code
                == 403
            )
        capability.prepare.assert_not_awaited()
        created = client.post(
            "/api/one/pod/tasks", headers={"Authorization": "Bearer " + tokens[1][0]}, json=body
        )
        assert created.status_code == 200 and created.json()["state"] == "scheduled"
        assert created.headers["cache-control"] == "no-store, private"
        assert "grant" not in created.json() and "terms" not in created.json()
        listing = client.get(
            "/api/one/pod/tasks", headers={"Authorization": "Bearer " + tokens[0][0]}
        )
        assert [row["id"] for row in listing.json()["tasks"]] == [created.json()["id"]]
        invalid = client.post(
            "/api/one/pod/tasks",
            headers={"Authorization": "Bearer " + tokens[1][0]},
            json={**body, "unsupported": "private-marker"},
        )
        assert invalid.status_code == 422
        assert "private-marker" not in invalid.text
        assert invalid.json()["detail"]["code"] == "SCHEDULE_REQUEST_INVALID"


@pytest.mark.parametrize("failure", ["revoked", "missing_scope"])
async def test_unadmitted_caller_cannot_resume_another_valid_apps_schedule(
    tmp_path, hub_key, monkeypatch, failure
):
    from api.routes.one import pod_scheduled_tasks as routes
    from hushh_mcp.services.pod_scheduled_authority import ScheduledGrantAuthority
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleAccess, ScheduledTasks
    from tests.test_pod_scheduled_tasks import schedule_request
    from tests.test_pod_session_authority import OWNER, USER

    world = World(tmp_path / "pod")
    authority = await world.boot()
    monkeypatch.setattr("api.routes.one.pod_session.authority_or_503", lambda: authority)
    original, caller = Subject("original", "web"), Subject("caller", "web")
    original_token, _ = await world.admit(original, _binding(original))
    caller_token, _ = await world.admit(
        caller, _binding(caller, **({"scopes": ["pod.act"]} if failure == "missing_scope" else {}))
    )
    runtime = ScheduledTasks(
        access=ScheduleAccess(USER, OWNER, "epoch", AsyncMock()),
        log=world.log,
        capabilities={
            "agent_files.organize_file.v1": SimpleNamespace(
                required_scopes=("pod.act", "files.manage"),
                prepare=AsyncMock(return_value={}),
                run=AsyncMock(),
            )
        },
        delivery=SimpleNamespace(require_ready=lambda: None, offer=AsyncMock()),
        admission=SimpleNamespace(acquire_turn=AsyncMock()),
        check_grant=ScheduledGrantAuthority(authority, USER, authority.require_held).check_grant,
        clock=lambda: 1000,
    )
    monkeypatch.setattr(routes, "active_scheduled_tasks", lambda: runtime)
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        created = client.post(
            "/api/one/pod/tasks",
            headers={"Authorization": "Bearer " + original_token},
            json=schedule_request().model_dump(),
        ).json()
        paused = await runtime.control(created["id"], created["revision"], "pause")
        before = len(runtime.delivery.offer.mock_calls)
        snapshot = runtime.journal.snapshot
        revoked = False

        async def interleaved_snapshot():
            nonlocal revoked
            rows = await snapshot()
            if not revoked and failure == "revoked":
                revoked = True
                await authority.revoke_subject(caller.subject_id)
            return rows

        monkeypatch.setattr(runtime.journal, "snapshot", interleaved_snapshot)
        result = client.post(
            "/api/one/pod/tasks/control",
            headers={"Authorization": "Bearer " + caller_token},
            json={
                "schedule_id": paused["id"],
                "revision": paused["revision"],
                "operation": "resume",
                "confirmed": True,
            },
        )
        assert result.status_code == 403
        authority.verify_session(original_token)  # The schedule's original grant remains valid.
        assert len(runtime.delivery.offer.mock_calls) == before
        assert (await snapshot())[0][paused["id"]]["state"] == "paused"


def test_schedule_worker_requires_exact_machine_identity_not_owner_session(monkeypatch):
    from api.routes.one import pod_scheduled_tasks as routes
    from hushh_mcp.services.scheduler_identity import SchedulerIdentityError

    monkeypatch.setenv(
        "POD_FILES_WORKER_SERVICE_ACCOUNT", "worker@owner-project.iam.gserviceaccount.com"
    )
    monkeypatch.setattr(
        "hushh_mcp.services.pod_files.jobs.worker_origin", lambda: "https://owner.example"
    )
    run = AsyncMock(return_value={"state": "completed"})
    monkeypatch.setattr(routes, "active_scheduled_tasks", lambda: SimpleNamespace(run=run))

    def verify(**kwargs):
        assert kwargs["audience"] == "https://owner.example"
        assert kwargs["allowed_emails"] == ("worker@owner-project.iam.gserviceaccount.com",)
        if kwargs["authorization_header"] != "Bearer synthetic-machine-identity":
            raise SchedulerIdentityError("refused")

    monkeypatch.setattr("hushh_mcp.services.scheduler_identity.verify_scheduler_request", verify)
    app = FastAPI()
    app.include_router(routes.router)
    payload = {"schedule_id": "schedule_" + "a" * 32, "revision": 2, "occurrence_id": "b" * 32}
    with TestClient(app) as client:
        refused = client.post(
            "/api/one/pod/tasks/worker",
            headers={"Authorization": "Bearer owner-session"},
            json=payload,
        )
        assert refused.status_code == 403
        run.assert_not_awaited()
        accepted = client.post(
            "/api/one/pod/tasks/worker",
            headers={"Authorization": "Bearer synthetic-machine-identity"},
            json=payload,
        )
        assert accepted.status_code == 200
        run.assert_awaited_once_with(payload["schedule_id"], 2, payload["occurrence_id"])


async def test_read_only_app_cannot_write_and_device_cannot_read(tmp_path, hub_key, monkeypatch):
    world = World(tmp_path / "pod")
    authority = await world.boot()
    monkeypatch.setattr("api.routes.one.pod_session.authority_or_503", lambda: authority)
    store = FilesLocalStore(str(tmp_path / "files"))
    azure_key = "https://owner.vault.azure.net/keys/pod/version"
    monkeypatch.setenv("HUSSH_POD_KEY_VAULT_KEY", azure_key)
    monkeypatch.delenv("HUSSH_POD_KMS_KEY", raising=False)

    async def verify_bucket(key):
        from hushh_mcp.services.pod_files.contracts import FilesRefused

        if key != azure_key:
            raise FilesRefused("FILES_BUCKET_CUSTODY_UNVERIFIED", 503)
        return {"softDeleteSeconds": 0}

    store.verify_bucket = AsyncMock(side_effect=verify_bucket)
    library = FilesLibrary(
        owner=authority.hushh_id, key=b"K" * 32, store=store, check=runtime.require_files_access
    )
    monkeypatch.setattr(runtime, "active_library", lambda: library)
    permit = SimpleNamespace(release=AsyncMock())
    monkeypatch.setattr(
        "hushh_mcp.services.pod_upgrade_admission.ADMISSION",
        SimpleNamespace(acquire_turn=AsyncMock(return_value=permit)),
    )
    reader, writer, device = (
        Subject("reader", "web"),
        Subject("writer", "web"),
        Subject("device", "macos"),
    )
    read_token, _ = await world.admit(reader, _binding(reader, scopes=["files.read"]))
    write_token, _ = await world.admit(
        writer, _binding(writer, scopes=["files.read", "files.manage"])
    )
    device_token, _ = await world.admit(device, _binding(device))
    app = FastAPI()
    app.include_router(pod_files.router)
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer " + read_token}
        assert client.get("/api/one/pod/files/list", headers=headers).status_code == 200
        settings = client.get("/api/one/pod/files/settings", headers=headers)
        assert settings.status_code == 200
        assert settings.json()["retention"]["softDeleteSeconds"] == 0
        body = {"name": "Folder", "folder": True, "request_id": "folder-request"}
        denied = client.post("/api/one/pod/files/create", headers=headers, json=body)
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == "scope_not_granted"
        assert (
            client.get(
                "/api/one/pod/files/list", headers={"Authorization": "Bearer " + device_token}
            ).status_code
            == 403
        )
        created = client.post(
            "/api/one/pod/files/create",
            headers={"Authorization": "Bearer " + write_token},
            json=body,
        )
        assert created.status_code == 200
        entries = client.get("/api/one/pod/files/list", headers=headers).json()["entries"]
        assert [entry["name"] for entry in entries] == ["Folder"]


@pytest.mark.parametrize("authorization", [None, "Bearer wrong-identity"])
def test_worker_refuses_unverified_queue_identity(monkeypatch, authorization):
    from hushh_mcp.services.scheduler_identity import SchedulerIdentityError

    monkeypatch.setenv("POD_FILES_WORKER_SERVICE_ACCOUNT", "queue@example.invalid")
    monkeypatch.setattr(
        "hushh_mcp.services.pod_files.jobs.worker_origin",
        lambda: "https://pod.example.invalid/api/one/pod/files/worker",
    )
    run = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.pod_files.jobs.run_job", run)

    def refuse(**kwargs):
        assert kwargs["allowed_emails"] == ("queue@example.invalid",)
        assert kwargs["audience"].endswith("/api/one/pod/files/worker")
        raise SchedulerIdentityError("unverified")

    monkeypatch.setattr("hushh_mcp.services.scheduler_identity.verify_scheduler_request", refuse)
    app = FastAPI()
    app.include_router(pod_files.router)
    headers = {"Authorization": authorization} if authorization else {}
    with TestClient(app) as client:
        response = client.post(
            "/api/one/pod/files/worker",
            headers=headers,
            json={"job_id": "a" * 32, "delivery": "b" * 32},
        )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "FILES_WORKER_REFUSED"
    run.assert_not_awaited()


def test_files_offer_checks_bucket_privacy_before_approval(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock, Mock

    import pytest

    from hushh_mcp.services import user_gcp_bootstrap
    from hushh_mcp.services.pod_files import update_offer
    from tests.test_pod_files_provisioning import legacy_files_fixture

    row, image, service = legacy_files_fixture()
    row.update(
        status="provisioned", user_cloud_authorized_at="2026-09-01", phone_e164_hash="opaque"
    )
    plan = update_offer.plan_from_observation(row, image, service)
    backend = Mock(live=True, inspect_files_capability=AsyncMock(return_value=service))
    repo = Mock(
        files_upgrade_admission_ready=AsyncMock(return_value=True), get=AsyncMock(return_value=row)
    )
    monkeypatch.setenv("HUSSH_POD_FILES_ENABLED", "true")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setattr(update_offer, "resolve_compute_backend_for_spec", lambda _: backend)
    monkeypatch.setattr(user_gcp_bootstrap, "mint_bootstrap_token", lambda **_: "synthetic")
    bucket = {
        "name": plan.bucket,
        "projectNumber": "123456789",
        "encryption": {"defaultKmsKeyName": plan.kmsKey},
        "iamConfiguration": {
            "uniformBucketLevelAccess": {"enabled": True},
            "publicAccessPrevention": "inherited",
        },
    }
    session = Mock()

    def get(url, **_):
        body = (
            {"projectNumber": "123456789", "projectId": plan.project}
            if "cloudresourcemanager" in url
            else bucket
        )
        return Mock(status_code=200, json=lambda: body)

    session.get.side_effect = get
    monkeypatch.setattr("requests.get", session.get)
    monkeypatch.setattr("requests.request", session.request)
    with pytest.raises(update_offer.FilesStoragePrerequisite, match="No setup has started"):
        asyncio.run(update_offer.inspect_files_offer(repo, row, image))
    bucket["iamConfiguration"]["publicAccessPrevention"] = "enforced"
    assert asyncio.run(update_offer.inspect_files_offer(repo, row, image)).digest == plan.digest
    session.request.assert_not_called()
    repo.approve_upgrade.assert_not_called()


@pytest.mark.asyncio
async def test_provider_loss_never_blocks_restrictive_analysis_changes(queued_library, monkeypatch):
    library, entry = queued_library

    @asynccontextmanager
    async def operation(**kwargs):
        yield library

    def unavailable():
        raise FilesRefused("FILES_MODEL_UNAVAILABLE", 503)

    monkeypatch.setattr(pod_files, "operation", operation)
    monkeypatch.setattr(pod_files, "organization_model_binding", unavailable)
    # Existing automatic consent can be narrowed without a working provider.
    settings = await library.settings()
    excluded = await pod_files.update_settings(
        pod_files.AnalysisSettings(
            revision=settings["revision"], analysis=True, automatic=True, excluded=[entry["id"]]
        ),
        {},
    )
    assert excluded["excluded"] == [entry["id"]]
    # Removing that exclusion would broaden access and must still be refused.
    with pytest.raises(HTTPException) as refused:
        await pod_files.update_settings(
            pod_files.AnalysisSettings(
                revision=excluded["revision"], analysis=True, automatic=True, excluded=[]
            ),
            {},
        )
    assert refused.value.detail == {"code": "FILES_MODEL_UNAVAILABLE"}
    assert (await library.settings())["excluded"] == [entry["id"]]
    paused = await pod_files.update_settings(
        pod_files.AnalysisSettings(
            revision=excluded["revision"], analysis=True, automatic=False, excluded=[entry["id"]]
        ),
        {},
    )
    assert not paused["automatic"]


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["prepare", "deliver"])
@pytest.mark.parametrize(
    "code",
    ["FILES_WORKER_DESTINATION_UNAVAILABLE", "FILES_AUTHORITY_UNAVAILABLE", "FILES_TAMPERED"],
)
async def test_upload_remains_complete_when_organization_setup_becomes_unavailable(
    queued_library, monkeypatch, code, phase
):
    library, _ = queued_library
    content = b"Synthetic accepted upload"
    entry = await library.create(
        name="original.txt", parent="root", size=len(content), request_id="setup-lost-upload"
    )
    await library.put_chunk(entry["id"], 0, content)

    @asynccontextmanager
    async def operation(**kwargs):
        yield library

    def unavailable():
        raise FilesRefused(code, 503)

    monkeypatch.setattr(pod_files, "operation", operation)
    if phase == "prepare":
        monkeypatch.setattr(jobs, "require_background_delivery", unavailable)
    else:
        monkeypatch.setattr(jobs, "deliver", AsyncMock(side_effect=FilesRefused(code, 503)))
    if code == "FILES_WORKER_DESTINATION_UNAVAILABLE":
        result = await pod_files.complete_file(pod_files.EntryRequest(file_id=entry["id"]), {})
        assert result["state"] == "ready"
        assert result["organization"] == (
            {"state": "unconfirmed", "code": code}
            if phase == "prepare"
            else {"state": "pending_delivery", "code": "FILES_JOB_DELIVERY_UNCONFIRMED"}
        )
    else:
        # Authority and integrity failures must never become a successful response.
        with pytest.raises(HTTPException) as refused:
            await pod_files.complete_file(pod_files.EntryRequest(file_id=entry["id"]), {})
        assert refused.value.detail["code"] == code
    assert await library.read_chunk(entry["id"], 0) == content
    assert (await library.stat(entry["id"]))["state"] == "ready"
