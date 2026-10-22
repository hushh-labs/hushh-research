"""Synthetic owner configuration; no cloud resource or model call."""

import json
from contextlib import contextmanager
from pathlib import Path

from hushh_mcp.services.pod_browser.execution_authority import PublicResearchPolicy
from tests.helpers.pod_browser import readiness
from tests.test_pod_files_provisioning import legacy_files_fixture


def browser_capability_fixture():
    row, image, service = legacy_files_fixture()
    row.update(
        phone_e164_hash="opaque", pod_pubkey="public", pod_key_id="podk_test", placement_epoch=0
    )
    row["backend_metadata"].update(
        image=image, image_digest=image.rsplit("@", 1)[1], source_image=image
    )
    from hushh_mcp.services.pod_files.provisioning import coordinates, queue_creation_observation

    names = coordinates(row["hushh_id"], row["user_cloud_project"], row["user_cloud_region"])
    container = service["spec"]["template"]["spec"]["containers"][0]
    container["env"] += [
        {"name": name, "value": value}
        for name, value in {
            "POD_FILES_ENABLED": "true",
            "POD_FILES_TASK_QUEUE": names["queue"],
            "POD_FILES_WORKER_SERVICE_ACCOUNT": names["worker"],
        }.items()
    ]
    queue = {
        "name": names["queue"],
        "rateLimits": {"maxDispatchesPerSecond": 1, "maxConcurrentDispatches": 1},
        "retryConfig": {
            "maxAttempts": 3,
            "maxRetryDuration": "0s",
            "minBackoff": "10s",
            "maxBackoff": "60s",
            "maxDoublings": 2,
        },
    }
    observations = [
        {
            "type": "cloud_tasks_queue",
            "id": names["queueId"],
            "disposition": "created",
            "identity": queue_creation_observation(queue, names["queue"]),
        },
        {
            "type": "service_account",
            "id": names["worker"],
            "disposition": "created",
            "identity": {
                "name": f"projects/{row['user_cloud_project']}/serviceAccounts/{names['worker']}",
                "email": names["worker"],
                "projectId": row["user_cloud_project"],
                "uniqueId": "123456789",
            },
        },
    ]
    inventory = row["backend_metadata"]["substrateReceipt"]
    inventory["resourceObservations"] += observations
    inventory["plannedResources"] += [
        {"type": item["type"], "id": item["id"]} for item in observations
    ]
    service["spec"]["template"]["spec"]["containers"][0]["image"] = image
    service["status"] = {
        "url": "https://synthetic.run.app",
        "latestReadyRevisionName": service["metadata"]["name"] + "-before",
        "latestCreatedRevisionName": service["metadata"]["name"] + "-before",
        "observedGeneration": service["metadata"]["generation"],
        "conditions": [{"type": "Ready", "status": "True"}],
        "traffic": [{"revisionName": service["metadata"]["name"] + "-before", "percent": 100}],
    }
    policy = PublicResearchPolicy(page_urls=("https://example.com/research",))
    qualification = {
        "version": 1,
        "host_kind": "gcp_cloud_run",
        "source_revision": "c" * 40,
        "image_tag": "source",
        "evidence_sha256": "e" * 64,
        "public_policy_sha256": policy.digest,
        "public_policy": policy.model_dump(mode="json"),
        "readiness": readiness().model_dump(),
    }
    release = json.loads((Path(__file__).parents[1] / "fixtures/pod_release.v1.json").read_text())
    release.update(image=image, browserQualifications=[qualification])
    return row, image, service, qualification, release


@contextmanager
def browser_registry_fixture(monkeypatch, row):
    """Own the SQL engine and database even when fixture/schema setup fails."""
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from tests.test_byoc_setup_job_azure_admission_postgres import _Client
    from tests.test_personal_agent_notification_checkpoint import _notification_server

    server = _notification_server(monkeypatch)
    client = None
    try:
        client = _Client(server)
        parked = Path(__file__).resolve().parents[2] / "db/migrations/parked"
        server.apply_file(parked / "963_personal_agent_operator_mail_custody.sql")
        _insert_owner(server, row)
        yield server, PersonalAgentRegistryRepo(client=client), parked
    finally:
        try:
            if client is not None:
                client._engine.dispose()
        finally:
            server.stop()


def _insert_owner(server, row):
    server.execute(
        """INSERT INTO personal_agent_registry(user_id,hushh_id,status,deployment_target,
        external_agent_id,user_cloud_project,user_cloud_region,user_cloud_bootstrap_sa,
        user_cloud_authorized_at,pod_pubkey,pod_key_id,placement_epoch,phone_e164_hash,backend_metadata)
        VALUES (%s,%s,'provisioned','user_gcp',%s,%s,%s,%s,now(),%s,%s,0,'opaque',%s::jsonb)""",
        (
            row["user_id"],
            row["hushh_id"],
            row["external_agent_id"],
            row["user_cloud_project"],
            row["user_cloud_region"],
            row["user_cloud_bootstrap_sa"],
            row["pod_pubkey"],
            row["pod_key_id"],
            json.dumps(row["backend_metadata"]),
        ),
    )


def azure_browser_capability_fixture():
    from hushh_mcp.services import azure_agent_setup as setup
    from hushh_mcp.services.pod_browser.azure_capability import plan_from_observation
    from tests.azure_arm_fake import FakeArm
    from tests.helpers.pod_browser import shared_readiness
    from tests.test_user_azure_backend import (
        _HUSHH_ID,
        _OLD,
        _PERSON_TOKEN,
        _SOURCE,
        _SUB,
        _TENANT,
        _backend,
        _Http,
        _spec,
    )

    arm = FakeArm()
    target = f"{_SOURCE}@{_OLD}"
    setup.run_agent_setup(
        access_token=_PERSON_TOKEN,
        tenant_id=_TENANT,
        subscription_id=_SUB,
        location="eastus2",
        spec=_spec(files_library_enabled=True),
        source_image=target,
        advance=lambda _: None,
        arm=arm,
        hussh_principal_id="88888888-8888-8888-8888-888888888888",
        http=_Http(),
        sleep=lambda _: None,
    )
    backend = _backend(arm)
    metadata = backend.verified_handle(_HUSHH_ID, backend.observe_sync()).backend_metadata
    row = {
        "user_id": "azure-browser-owner",
        "hushh_id": _HUSHH_ID,
        "status": "provisioned",
        "backend": "user_azure",
        "deployment_target": "user_azure",
        "external_agent_id": backend.app_id,
        "user_cloud_tenant_id": _TENANT,
        "user_cloud_subscription_id": _SUB,
        "user_cloud_resource_group": backend._group,
        "user_cloud_region": "eastus2",
        "user_cloud_authorized_at": "2026-10-21T00:00:00Z",
        "pod_pubkey": "synthetic-public",
        "pod_key_id": "pod-key",
        "placement_epoch": 0,
        "model_credential_mode": "user_azure_mi",
        "backend_metadata": metadata,
    }
    policy = PublicResearchPolicy(page_urls=("https://example.com/research",))
    qualification = {
        "version": 2,
        "host_kind": "azure_container_apps",
        "source_revision": "c" * 40,
        "image_tag": "source",
        "evidence_sha256": "e" * 64,
        "public_policy_sha256": policy.digest,
        "public_policy": policy.model_dump(mode="json"),
        "readiness": shared_readiness(
            cloud="azure",
            component_digest=_OLD,
            model_name="gpt-6-luna",
            model_transport="hushh_mcp.runtime_providers.azure_browser_adk.AzureBrowserAdkModel",
        ).model_dump(),
    }
    app = arm.resources[backend.app_id]
    plan = plan_from_observation(row, target, app, qualification)
    arm.calls.clear()
    return row, target, app, qualification, plan, backend, arm
