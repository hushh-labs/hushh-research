"""The real GCP renderer's maximum service-account ID passes notification admission."""

from __future__ import annotations

import asyncio
import hashlib
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_notification_checkpoint import bind_notification_checkpoint
from hushh_mcp.services.user_gcp_backend import UserGcpBackend
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import _Client, _server

OWNER = "notification-owner"
HID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
PROJECT = "owner-project"
REGION = "us-central1"
BOOTSTRAP = "one-bootstrap@owner-project.iam.gserviceaccount.com"
SERVICE = "one-pod-ha1-abcdefghijklmnopqrstuvwxyz234567"


def _base_plan(service):
    stem = "one-mail-ha1-abcdefghijklmnopqrstuvwxyz234567"
    return {
        "oauthProject": "oauth-project",
        "runtimeAccount": "one-pod-test@owner-project.iam.gserviceaccount.com",
        "bootstrapAccount": BOOTSTRAP,
        "service": service,
        "plannedResources": [
            {"type": kind, "id": stem + suffix}
            for kind, suffix in [
                ("pubsub_topic", "-dead-letter"),
                ("pubsub_subscription", "-direct-sub"),
                ("pubsub_subscription", "-dead-letter-sub"),
                ("cloud_scheduler_job", "-watch-renew"),
            ]
        ],
    }


def _checkpoint(attempt_id, plan):
    return {
        "version": 1,
        "ownerId": OWNER,
        "hushhId": HID,
        "kind": "upgrade",
        "attemptId": attempt_id,
        "operationId": "op-1",
        "project": PROJECT,
        "region": REGION,
        "plan": plan,
        "serviceUid": "uid-1",
        "generation": 1,
        "phase": "intent",
        "step": "gmail_direct_invoker",
        "completed": [],
    }


@pytest.fixture
def pg(monkeypatch):
    if find_pg_bin() is None:
        pytest.skip("local PostgreSQL unavailable")
    server = _server(monkeypatch, last=954)
    try:
        server.execute("ALTER TABLE vault_keys ADD COLUMN setup_capability_ids TEXT")
        migrations = Path(__file__).resolve().parents[1] / "db/migrations"
        server.apply_file(migrations / "parked/955_one_hosting_choice.sql")
        server.apply_file(migrations / "parked/956_personal_agent_notification_checkpoint.sql")
        _seed_upgrade(server)
        server.apply_file(migrations / "parked/963_personal_agent_operator_mail_custody.sql")
        server.apply_file(migrations / "parked/969_gcp_browser_update_admission.sql")
        server.apply_file(migrations / "445_gcp_notification_account_id_limit.sql")
        server.apply_file(migrations / "parked/976_gcp_notification_account_id_limit.sql")
        yield server
    finally:
        server.stop()


def _seed_upgrade(pg):
    metadata = {
        "serviceUid": "uid-1",
        "upgradeLease": "same-owner-lease",
        "upgradeApproval": {
            "version": 1,
            "status": "updating",
            "ownerId": OWNER,
            "hushhId": HID,
            "podIncarnation": "uid-1",
            "operationId": "op-1",
            "targetImage": "repo/pod@sha256:" + "b" * 64,
        },
    }
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,backend,deployment_target,external_agent_id,user_cloud_project,user_cloud_region,user_cloud_bootstrap_sa,backend_metadata) VALUES (%s,%s,'provisioned','user_gcp','user_gcp',%s,%s,%s,%s,%s::jsonb)",
        (OWNER, HID, SERVICE, PROJECT, REGION, BOOTSTRAP, json.dumps(metadata)),
    )


def _render_gcp_upgrade(monkeypatch):
    monkeypatch.setenv("GOOGLE_CONNECTOR_OAUTH_PROJECT", "oauth-project")
    spec = SimpleNamespace(
        hushh_id=HID,
        region=REGION,
        files_library_enabled=False,
        user_cloud_project=PROJECT,
        user_cloud_region=REGION,
        user_cloud_bootstrap_sa=BOOTSTRAP,
        expected_service_uid="uid-1",
    )
    backend = UserGcpBackend(user_project=PROJECT, user_region=REGION, bootstrap_sa=BOOTSTRAP)
    rendered = backend.render_bootstrap_plan(spec)
    attempt_id = hashlib.sha256(b"same-owner-lease").hexdigest()
    return spec, backend, rendered, attempt_id


@pytest.mark.asyncio
async def test_real_gcp_renderer_accepts_max_service_account_with_exact_operator_resources(
    pg, monkeypatch
):
    spec, backend, rendered, attempt_id = _render_gcp_upgrade(monkeypatch)
    topic = rendered["gmailNotifications"]["topic"]
    runtime_account = rendered["gmailNotifications"]["pushServiceAccount"]
    localpart, domain = runtime_account.split("@", 1)
    assert len(localpart) == 30
    assert any(resource["id"] == topic for resource in rendered["resources"])

    repo = PersonalAgentRegistryRepo(client=_Client(pg))
    bad_plan = _base_plan(SERVICE)
    bad_plan["plannedResources"].append({"type": "pubsub_topic", "id": "foreign-owner-topic"})
    assert (
        await repo.publish_notification_checkpoint(
            user_id=OWNER,
            kind="upgrade",
            attempt_id=attempt_id,
            operation_id="op-1",
            expected_generation=0,
            checkpoint=_checkpoint(attempt_id, bad_plan),
        )
        is None
    )

    callback = bind_notification_checkpoint(
        registry=repo,
        owner_loop=asyncio.get_running_loop(),
        user_id=OWNER,
        spec=spec,
        renderer=backend.render_bootstrap_plan,
        service=SERVICE,
        kind="upgrade",
        attempt_id=attempt_id,
        operation_id="op-1",
    )
    assert callback is not None
    await asyncio.to_thread(callback, "intent", "gmail_direct_invoker", [])
    checkpoint = pg.execute(
        "SELECT backend_metadata->'notificationCheckpoint' FROM personal_agent_registry WHERE user_id=%s",
        (OWNER,),
    )[0][0]
    planned = checkpoint["plan"]["plannedResources"]
    assert len(planned) == 5
    assert planned[-1] == {"type": "pubsub_topic", "id": topic}

    validator = "SELECT public.valid_personal_agent_notification_checkpoint(to_jsonb(r), %s::jsonb, NULL) FROM personal_agent_registry r WHERE user_id=%s"
    assert pg.execute(validator, (json.dumps(checkpoint), OWNER))[0][0] is True
    for invalid_localpart in (localpart + "a", localpart[:-1] + "-"):
        invalid = deepcopy(checkpoint)
        invalid["plan"]["runtimeAccount"] = invalid_localpart + "@" + domain
        assert pg.execute(validator, (json.dumps(invalid), OWNER))[0][0] is False
