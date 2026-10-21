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
