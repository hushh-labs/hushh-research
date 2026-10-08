"""Notification generation CAS and late cleanup receipts use one owner operation."""

from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_notification_checkpoint import bind_notification_checkpoint
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import _Client, _server

OWNER = "notification-owner"
HID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
PROJECT = "owner-project"
REGION = "us-central1"
ATTEMPT = "a" * 32
STEM = "one-mail-ha1-abcdefghijklmnopqrstuvwxyz234567"
SERVICE = "one-pod-ha1-abcdefghijklmnopqrstuvwxyz234567"
RUNTIME = "one-pod-test@owner-project.iam.gserviceaccount.com"
BOOTSTRAP = "one-bootstrap@owner-project.iam.gserviceaccount.com"


def _plan():
    return {
        "oauthProject": "oauth-project",
        "runtimeAccount": RUNTIME,
        "bootstrapAccount": BOOTSTRAP,
        "service": SERVICE,
        "plannedResources": [
            {"type": kind, "id": STEM + suffix}
            for kind, suffix in [
                ("pubsub_topic", "-dead-letter"),
                ("pubsub_subscription", "-direct-sub"),
                ("pubsub_subscription", "-dead-letter-sub"),
                ("cloud_scheduler_job", "-watch-renew"),
            ]
        ],
    }


def _checkpoint(generation=1, phase="intent", step="mail_dead_letter_topic", completed=None):
    return {
        "version": 1,
        "ownerId": OWNER,
        "hushhId": HID,
        "kind": "provision",
        "attemptId": ATTEMPT,
        "operationId": ATTEMPT,
        "project": PROJECT,
        "region": REGION,
        "plan": _plan(),
        "serviceUid": None,
        "generation": generation,
        "phase": phase,
        "step": step,
        "completed": completed or [],
    }


def _result():
    return {
        "step": "mail_dead_letter_topic",
        "status": 200,
        "ok": True,
        "capability": "gmail_notifications",
        "resourceObservation": {
            "type": "pubsub_topic",
            "id": STEM + "-dead-letter",
            "disposition": "created",
            "identity": {"name": f"projects/{PROJECT}/topics/{STEM}-dead-letter"},
        },
    }


@pytest.fixture
def pg(monkeypatch):
    if find_pg_bin() is None:
        pytest.skip("local PostgreSQL unavailable")
    server = _notification_server(monkeypatch)
    try:
        _seed(server)
        yield server
    finally:
        server.stop()


def _notification_server(monkeypatch, notification=True):
    server = _server(monkeypatch, last=954)
    # The narrow registry fixture omits the ordinary setup-state migration (029).
    try:
        server.execute("ALTER TABLE vault_keys ADD COLUMN setup_capability_ids TEXT")
        root = Path(__file__).resolve().parents[1] / "db/migrations/parked"
        server.apply_file(root / "955_one_hosting_choice.sql")
        if notification:
            server.apply_file(root / "956_personal_agent_notification_checkpoint.sql")
        return server
    except Exception:
        server.stop()
        raise


def _seed(pg, phase="reserved", ack=None):
    meta = {
        "provisionAttempt": {
            "version": 1,
            "ownerId": OWNER,
            "attemptId": ATTEMPT,
            "phase": phase,
            "intent": {"user_id": OWNER, "hushh_id": HID},
        }
    }
    if ack:
        meta["provisionAttempt"]["evidence"] = {"host_requested": {"creationAcknowledgement": ack}}
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,deployment_target,user_cloud_project,user_cloud_region,user_cloud_bootstrap_sa,backend_metadata) VALUES (%s,%s,'provisioning','user_gcp',%s,%s,%s,%s::jsonb)",
        (OWNER, HID, PROJECT, REGION, BOOTSTRAP, json.dumps(meta)),
    )


def _publish(pg, cp, expected=0):
    return asyncio.run(
        PersonalAgentRegistryRepo(client=_Client(pg)).publish_notification_checkpoint(
            user_id=OWNER,
            kind="provision",
            attempt_id=ATTEMPT,
            operation_id=ATTEMPT,
            expected_generation=expected,
            checkpoint=cp,
        )
    )


def _row(pg):
    return pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=%s", (OWNER,)
    )[0][0]


def test_prehost_intent_and_actual_receipt_extend_existing_inventory(pg):
    before = _row(pg)
    saved = _publish(pg, _checkpoint())
    assert saved["checkpoint"]["serviceUid"] is None
    assert saved["inventory"]["plannedResources"] == _plan()["plannedResources"]
    assert saved["inventory"]["resourceObservations"] == []
    assert (
        _row(pg)["backend_metadata"]["provisionAttempt"]
        == before["backend_metadata"]["provisionAttempt"]
    )
    cp = _checkpoint(2, "observed", completed=[_result()])
    assert _publish(pg, cp, 1)["inventory"]["resourceObservations"] == [
        _result()["resourceObservation"]
    ]
    assert _publish(pg, cp, 1) is None
    next_intent = _checkpoint(3, "intent", "oauth_mail_topic", [_result()])
    # A structurally valid next generation does not override the caller's stale CAS.
    assert _publish(pg, next_intent, 0) is None
    assert _publish(pg, next_intent, 2)


@pytest.mark.parametrize(
    "change",
    [
        {"ownerId": "other"},
        {"attemptId": "b" * 32},
        {"operationId": "other"},
        {"project": "other-project"},
        {"region": "europe-west1"},
        {"serviceUid": "fake"},
        {"phase": "observed"},
        {"generation": 2},
        {"private_token": "forbidden"},
    ],
)
def test_wrong_binding_generation_or_unbounded_payload_cannot_publish(pg, change):
    before = _row(pg)
    assert _publish(pg, {**_checkpoint(), **change}) is None
    assert _row(pg) == before


def test_runtime_requires_immutable_current_uid(pg):
    assert _publish(pg, _checkpoint(step="gmail_direct_invoker")) is None
    pg.execute("TRUNCATE personal_agent_registry CASCADE")
    _seed(pg, "host_requested")
    assert asyncio.run(
        PersonalAgentRegistryRepo(client=_Client(pg)).publish_provision(
            user_id=OWNER,
            attempt_id=ATTEMPT,
            expected_phase="host_requested",
            next_phase="host_requested",
            evidence={
                "creationAcknowledgement": {
                    "service": SERVICE,
                    "serviceUid": "uid-1",
                    "project": PROJECT,
                    "region": REGION,
                }
            },
        )
    )
    # Once creation is acknowledged, every checkpoint phase must carry that UID,
    # including a bootstrap-shaped step; a step name cannot bypass incarnation.
    assert _publish(pg, {**_checkpoint(), "serviceUid": "foreign-uid"}) is None
    saved = _publish(pg, _checkpoint(step="gmail_direct_invoker"))
    assert saved["checkpoint"]["serviceUid"] == "uid-1"
    cp = _checkpoint(
        2,
        "observed",
        "gmail_direct_invoker",
        [
            {
                "step": "gmail_direct_invoker",
                "status": 200,
                "ok": True,
                "configurationObservation": {
                    "service": SERVICE,
                    "serviceUid": "uid-2",
                    "role": "roles/run.invoker",
                    "member": "serviceAccount:" + RUNTIME,
                },
            }
        ],
    )
    assert _publish(pg, cp, 1) is None


def test_late_qualified_ack_is_cleanup_inventory_not_continuation(pg):
    _publish(pg, _checkpoint())
    snapshot = _row(pg)
    erasure = {
        "version": 1,
        "ownerId": OWNER,
        "attemptId": "erase-1",
        "hushhId": HID,
        "phase": "reserved",
        "registrySnapshot": snapshot,
    }
    pg.execute(
        "UPDATE personal_agent_registry SET status='suspended',backend_metadata=backend_metadata||jsonb_build_object('erasure',%s::jsonb) WHERE user_id=%s",
        (json.dumps(erasure), OWNER),
    )
    before = _row(pg)
    bad = _checkpoint(2, "observed", completed=[_result()])
    bad["completed"][0]["resourceObservation"]["identity"]["name"] = (
        "projects/other-project/topics/arbitrary"
    )
    assert _publish(pg, bad, 1) is None
    assert _row(pg) == before
    good = _checkpoint(2, "observed", completed=[_result()])
    assert _publish(pg, good, 1) is None
    row = _row(pg)
    assert row["status"] == "suspended"
    assert row["backend_metadata"]["erasure"]["registrySnapshot"] == snapshot
    assert row["backend_metadata"]["erasure"]["lateNotificationObservation"] == good
    inventory = asyncio.run(
        PersonalAgentRegistryRepo(client=_Client(pg)).effective_erasure_substrate_inventory(
            reservation=row["backend_metadata"]["erasure"]
        )
    )
    assert inventory["resourceObservations"] == [_result()["resourceObservation"]]
    with pytest.raises(Exception, match="personal agent erasure reserved"):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure,lateNotificationObservation,completed,0,resourceObservation,id}','\"arbitrary\"') WHERE user_id=%s",
            (OWNER,),
        )


def test_without956_is_a_real_negative_control(monkeypatch):
    if find_pg_bin() is None:
        pytest.skip("local PostgreSQL unavailable")
    server = _notification_server(monkeypatch, notification=False)
    try:
        assert (
            asyncio.run(
                PersonalAgentRegistryRepo(
                    client=_Client(server)
                ).notification_checkpoint_admission_ready()
            )
            is False
        )
        with pytest.raises(Exception, match="publish_personal_agent_notification_checkpoint"):
            _publish(server, _checkpoint())
    finally:
        server.stop()


@pytest.mark.asyncio
async def test_binder_merges_disjoint_prefix_and_refused_cas_stops_execution():
    calls = []

    class Registry:
        async def publish_notification_checkpoint(self, **kw):
            calls.append(deepcopy(kw))
            return None if len(calls) == 5 else {"checkpoint": kw["checkpoint"], "inventory": {}}

    spec = SimpleNamespace(
        user_cloud_project=PROJECT,
        user_cloud_region=REGION,
        user_cloud_bootstrap_sa=BOOTSTRAP,
        hushh_id=HID,
        expected_service_uid="uid-1",
    )
    terms = {
        "oauthProject": "oauth-project",
        "pushServiceAccount": RUNTIME,
        **{
            key: "x/" + STEM + suffix
            for key, suffix in [
                ("ownerSubscription", "-direct-sub"),
                ("deadLetterTopic", "-dead-letter"),
                ("deadLetterSubscription", "-dead-letter-sub"),
                ("watchJob", "-watch-renew"),
            ]
        },
    }
    plan = {
        "target": {"project": PROJECT, "region": REGION},
        "gmailNotifications": terms,
        "resources": _plan()["plannedResources"],
    }
    callback = bind_notification_checkpoint(
        registry=Registry(),
        owner_loop=asyncio.get_running_loop(),
        user_id=OWNER,
        spec=spec,
        renderer=lambda _: plan,
        service=SERVICE,
        kind="upgrade",
        attempt_id="b" * 64,
        operation_id="operation-1",
    )
    iam = {"step": "gmail_direct_invoker", "ok": True, "status": 200}
    sub = {"step": "mail_subscription_configuration", "ok": True, "status": 200}
    await asyncio.to_thread(callback, "intent", "gmail_direct_invoker", [])
    await asyncio.to_thread(callback, "observed", "gmail_direct_invoker", [iam])
    await asyncio.to_thread(callback, "intent", "mail_subscription_configuration", [])
    await asyncio.to_thread(callback, "observed", "mail_subscription_configuration", [sub])
    assert calls[-1]["checkpoint"]["completed"] == [iam, sub]
    with pytest.raises(RuntimeError, match="lost owner operation"):
        await asyncio.to_thread(callback, "intent", "watch_renew_job", [sub])
    assert [c["expected_generation"] for c in calls] == list(range(5))


def test_approved_upgrade_requires_same_lease_operation_and_current_uid(pg):
    import hashlib

    pg.execute("TRUNCATE personal_agent_registry CASCADE")
    lease = "same-owner-lease"
    metadata = {
        "serviceUid": "uid-1",
        "upgradeLease": lease,
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
    cp = {
        **_checkpoint(step="gmail_direct_invoker"),
        "kind": "upgrade",
        "attemptId": hashlib.sha256(lease.encode()).hexdigest(),
        "operationId": "op-1",
        "serviceUid": "uid-1",
    }
    repo = PersonalAgentRegistryRepo(client=_Client(pg))

    def publish(value, expected=0):
        return asyncio.run(
            repo.publish_notification_checkpoint(
                user_id=OWNER,
                kind="upgrade",
                attempt_id=cp["attemptId"],
                operation_id="op-1",
                expected_generation=expected,
                checkpoint=value,
            )
        )

    for changes in ({"operationId": "other"}, {"attemptId": "c" * 64}, {"serviceUid": "uid-2"}):
        assert publish({**cp, **changes}) is None
    assert publish(cp)["checkpoint"] == cp
    result = {
        "step": "gmail_direct_invoker",
        "status": 200,
        "ok": True,
        "configurationObservation": {
            "service": SERVICE,
            "serviceUid": "uid-1",
            "role": "roles/run.invoker",
            "member": "serviceAccount:" + RUNTIME,
        },
    }
    assert publish({**cp, "generation": 2, "phase": "observed", "completed": [result]}, 1)


def test_malformed_success_cannot_resolve_a_creation_intent(pg):
    assert _publish(pg, _checkpoint())
    result = {"step": "mail_dead_letter_topic", "status": 200, "ok": True}
    assert _publish(pg, _checkpoint(2, "observed", completed=[result]), 1) is None
    assert _row(pg)["backend_metadata"]["notificationCheckpoint"]["phase"] == "intent"


def test_956_guard_composition_and_empty_rollback_preserve_existing_contracts(pg):
    root = Path(__file__).resolve().parents[1] / "db/migrations"
    migration = (root / "parked/956_personal_agent_notification_checkpoint.sql").read_text()
    previous = (root / "parked/954_personal_agent_never_hosted_erasure.sql").read_text()
    rollback = (
        root / "rollback/956_personal_agent_notification_checkpoint.rollback.sql"
    ).read_text()

    def function(source, signature):
        start = source.index("CREATE OR REPLACE FUNCTION public." + signature)
        return source[start : source.index("$$;", start) + 3]

    guard = function(previous, "guard_personal_agent_erasure_registry()")
    assert function(rollback, "guard_personal_agent_erasure_registry()") == guard
    assert all(
        line in function(migration, "guard_personal_agent_erasure_registry()").splitlines()
        for line in guard.splitlines()
    )
    assert pg.execute("SELECT notification_checkpoint_admission_ready()")[0][0] is True
    pg.execute(
        "ALTER TABLE personal_agent_registry DISABLE TRIGGER zz_personal_agent_notification_retention"
    )
    assert pg.execute("SELECT notification_checkpoint_admission_ready()")[0][0] is False
    pg.execute(
        "ALTER TABLE personal_agent_registry ENABLE TRIGGER zz_personal_agent_notification_retention"
    )
    pg.execute(
        "CREATE OR REPLACE FUNCTION valid_erasure_kms_receipt(r jsonb,stage text,receipt jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'"
    )
    assert pg.execute("SELECT notification_checkpoint_admission_ready()")[0][0] is False
    pg.apply_file(root / "rollback/956_personal_agent_notification_checkpoint.rollback.sql")
    assert (
        pg.execute(
            "SELECT to_regprocedure('public.publish_personal_agent_notification_checkpoint(text,text,text,text,bigint,jsonb)')"
        )[0][0]
        is None
    )
    pg.apply_file(root / "parked/956_personal_agent_notification_checkpoint.sql")
    assert pg.execute("SELECT notification_checkpoint_admission_ready()")[0][0] is True


def test_actual_direct_runtime_subscription_and_scheduler_receipts_are_accepted(pg):
    from hushh_mcp.services.pod_gmail_push_config import gmail_notification_resources

    pg.execute("TRUNCATE personal_agent_registry CASCADE")
    _seed(
        pg,
        "host_requested",
        {
            "service": SERVICE,
            "serviceUid": "uid-1",
            "backend": "user_gcp",
            "project": PROJECT,
            "region": REGION,
        },
    )
    url = "https://private-pod.a.run.app"
    resources = gmail_notification_resources(
        owner_project=PROJECT,
        hushh_id=HID,
        oauth_project="oauth-project",
        service_url=url,
        push_service_account=RUNTIME,
    )
    runtime_env = {
        **resources["runtimeEnv"],
        "HUSSH_POD_TICK_AUDIENCE": url,
        "HUSSH_POD_TICK_ALLOWED_EMAILS": RUNTIME,
    }
    completed = []
    for generation, step, observation in [
        (
            1,
            "gmail_runtime_configuration",
            {"service": SERVICE, "serviceUid": "uid-1", "runtimeEnv": runtime_env},
        ),
        (
            3,
            "gmail_direct_invoker",
            {
                "service": SERVICE,
                "serviceUid": "uid-1",
                "role": "roles/run.invoker",
                "member": "serviceAccount:" + RUNTIME,
            },
        ),
        (
            5,
            "mail_subscription_configuration",
            {"name": resources["subscription"], **resources["subscriptionConfig"]},
        ),
        (
            7,
            "watch_renew_job",
            {
                "name": f"projects/{PROJECT}/locations/{REGION}/jobs/{STEM}-watch-renew",
                "schedule": "0 4 * * *",
                "timeZone": "Etc/UTC",
                "httpTarget": {
                    "uri": url + "/api/one/pod/maintenance/tick",
                    "httpMethod": "POST",
                    "oidcToken": {"audience": url, "serviceAccountEmail": RUNTIME},
                },
            },
        ),
    ]:
        intent = _checkpoint(generation, "intent", step, completed)
        assert _publish(pg, intent, generation - 1)
        completed = [
            *completed,
            {"step": step, "status": 200, "ok": True, "configurationObservation": observation},
        ]
        observed = _checkpoint(generation + 1, "observed", step, completed)
        assert _publish(pg, observed, generation)
    assert _row(pg)["backend_metadata"]["notificationCheckpoint"]["completed"] == completed
    repo = PersonalAgentRegistryRepo(client=_Client(pg))
    fields = {
        "external_agent_id": SERVICE,
        "backend": "user_gcp",
        "backend_metadata": {"serviceUid": "uid-1", "url": url},
    }
    with pytest.raises(Exception, match="notification checkpoint host transfer"):
        asyncio.run(
            repo.publish_provision(
                user_id=OWNER,
                attempt_id=ATTEMPT,
                expected_phase="host_requested",
                next_phase="host_acknowledged",
                evidence={"registry": {**fields, "external_agent_id": "foreign-host"}},
            )
        )
    assert asyncio.run(
        repo.publish_provision(
            user_id=OWNER,
            attempt_id=ATTEMPT,
            expected_phase="host_requested",
            next_phase="host_acknowledged",
            evidence={"registry": fields},
        )
    )
    assert _row(pg)["external_agent_id"] == SERVICE
    assert _row(pg)["backend_metadata"]["notificationCheckpoint"]["completed"] == completed


def test_two_subscriptions_need_independent_qualified_deletions_and_archive(pg):
    """Real guards cannot reuse one deletion to cover direct and DLQ subscriptions."""
    image = "repo/pod@sha256:" + "a" * 64
    memory = {
        "hushhId": HID,
        "attemptId": "erase-1",
        "service": SERVICE,
        "serviceUid": "uid-1",
        "revision": SERVICE + "-v1",
        "memoryBinding": {
            "project": PROJECT,
            "location": REGION,
            "engineId": "engine-one",
            "generationProtocol": 2,
            "engineIncarnation": {
                "name": f"projects/{PROJECT}/locations/{REGION}/reasoningEngines/engine-one",
                "createTime": "2026-10-06T00:00:00Z",
            },
            "creationProvenance": {
                "version": 1,
                "reservationGeneration": 1,
                "engineIncarnation": {
                    "name": f"projects/{PROJECT}/locations/{REGION}/reasoningEngines/engine-one",
                    "createTime": "2026-10-06T00:00:00Z",
                },
            },
        },
    }
    sa = {
        "name": f"projects/{PROJECT}/serviceAccounts/{RUNTIME}",
        "email": RUNTIME,
        "projectId": PROJECT,
        "uniqueId": "12345",
    }
    bootstrap = {
        "name": f"projects/{PROJECT}/serviceAccounts/{BOOTSTRAP}",
        "email": BOOTSTRAP,
        "projectId": PROJECT,
        "uniqueId": "67890",
    }
    observations = [
        {"type": "service_account", "id": RUNTIME, "disposition": "created", "identity": sa}
    ]
    for kind, rid, identity in [
        (
            "cloud_scheduler_job",
            "watch-job",
            {
                "name": f"projects/{PROJECT}/locations/{REGION}/jobs/watch-job",
                "schedule": "0 4 * * *",
                "timeZone": "Etc/UTC",
                "pubsubTarget": {"topicName": f"projects/{PROJECT}/topics/mail-topic"},
            },
        ),
        (
            "pubsub_subscription",
            "direct-sub",
            {
                "name": f"projects/{PROJECT}/subscriptions/direct-sub",
                "topic": f"projects/{PROJECT}/topics/mail-topic",
            },
        ),
        (
            "pubsub_subscription",
            "dead-letter-sub",
            {
                "name": f"projects/{PROJECT}/subscriptions/dead-letter-sub",
                "topic": f"projects/{PROJECT}/topics/mail-topic",
            },
        ),
        ("pubsub_topic", "mail-topic", {"name": f"projects/{PROJECT}/topics/mail-topic"}),
    ]:
        observations.append(
            {"type": kind, "id": rid, "disposition": "created", "identity": identity}
        )
    inventory = {
        "version": "byoc.substrate.receipt.v1",
        "tenantRef": PROJECT + "/" + REGION,
        "plannedResources": [{"type": x["type"], "id": x["id"]} for x in observations],
        "resourceObservations": observations,
    }
    creation = {
        "service": SERVICE,
        "serviceUid": "uid-1",
        "backend": "user_gcp",
        "project": PROJECT,
        "region": REGION,
        "initialGeneration": 1,
        "initialImage": image,
    }
    snapshot = {
        "user_id": OWNER,
        "hushh_id": HID,
        "status": "provisioned",
        "backend": "user_gcp",
        "external_agent_id": SERVICE,
        "deployment_target": "user_gcp",
        "user_cloud_project": PROJECT,
        "user_cloud_region": REGION,
        "user_cloud_bootstrap_sa": BOOTSTRAP,
        "backend_metadata": {
            "serviceUid": "uid-1",
            "runtime_service_account": RUNTIME,
            "substrateReceipt": inventory,
            "provisionAttempt": {
                "version": 1,
                "ownerId": OWNER,
                "attemptId": ATTEMPT,
                "phase": "provisioned",
                "evidence": {"host_requested": {"creationAcknowledgement": creation}},
            },
        },
    }
    compute = {
        "serviceName": f"projects/{PROJECT}/locations/{REGION}/services/{SERVICE}",
        "serviceUid": "uid-1",
        "etag": "v1",
        "generation": 1,
        "image": image,
    }
    ack = {**compute, "operationName": f"projects/{PROJECT}/locations/{REGION}/operations/delete-1"}
    writer = {
        "ownerId": OWNER,
        "attemptId": "erase-1",
        "runtimeIdentity": sa,
        "bootstrapIdentity": bootstrap,
    }
    r = {
        "version": 1,
        "ownerId": OWNER,
        "hushhId": HID,
        "attemptId": "erase-1",
        "phase": "reserved",
        "registrySnapshot": snapshot,
        "substrateInventory": inventory,
        "memoryBinding": memory,
        "memoryDeletion": {**memory, "status": "provider_deleted"},
        "computeAdmission": compute,
        "computeAcknowledgement": ack,
        "computeDeletion": {**ack, "status": "compute_deleted"},
        "writerAdmission": {**writer, "status": "admitted"},
        "writerDisabled": {**writer, "status": "disabled"},
    }
    assert (
        pg.execute(
            "SELECT valid_erasure_writer_receipt(%s::jsonb,'writerDisabled',%s::jsonb)",
            (json.dumps(r), json.dumps(r["writerDisabled"])),
        )[0][0]
        is True
    )
    pg.execute("TRUNCATE personal_agent_registry CASCADE")
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,deployment_target,user_cloud_project,user_cloud_region,user_cloud_bootstrap_sa,backend_metadata) VALUES (%s,%s,'suspended','user_gcp',%s,%s,%s,%s::jsonb)",
        (
            OWNER,
            HID,
            PROJECT,
            REGION,
            BOOTSTRAP,
            json.dumps({**snapshot["backend_metadata"], "erasure": r}),
        ),
    )
    repo = PersonalAgentRegistryRepo(client=_Client(pg))
    for index, obs in enumerate(observations[1:]):
        for stage, status in (
            ("admission", "admitted"),
            ("acknowledgement", "acknowledged"),
            ("deletion", "absent"),
        ):
            r = _row(pg)["backend_metadata"]["erasure"]
            receipt = {
                "ownerId": OWNER,
                "attemptId": "erase-1",
                "resourceObservation": obs,
                "status": status,
            }
            assert asyncio.run(
                repo.retain_erasure_mail_receipt(
                    user_id=OWNER, reservation=r, kind=obs["type"], stage=stage, receipt=receipt
                )
            )
        r = _row(pg)["backend_metadata"]["erasure"]
        if index == 1:
            assert (
                pg.execute("SELECT erasure_mail_resources_deleted(%s::jsonb)", (json.dumps(r),))[0][
                    0
                ]
                is False
            )
            mail_coverage = deepcopy(r)
            mail_coverage["substrateInventory"]["plannedResources"] = [
                item for item in inventory["plannedResources"] if item["type"] != "service_account"
            ]
            assert (
                pg.execute(
                    "SELECT erasure_planned_resources_covered(%s::jsonb)",
                    (json.dumps(mail_coverage),),
                )[0][0]
                is False
            )
            forged = deepcopy(r)
            forged["mailErasure"]["pubsub_subscription"]["resources"]["dead-letter-sub"] = deepcopy(
                forged["mailErasure"]["pubsub_subscription"]["resources"]["direct-sub"]
            )
            assert (
                pg.execute(
                    "SELECT erasure_mail_resources_deleted(%s::jsonb)", (json.dumps(forged),)
                )[0][0]
                is False
            )
    r = _row(pg)["backend_metadata"]["erasure"]
    assert (
        pg.execute("SELECT erasure_mail_resources_deleted(%s::jsonb)", (json.dumps(r),))[0][0]
        is True
    )
    mail_coverage = deepcopy(r)
    mail_coverage["substrateInventory"]["plannedResources"] = [
        item for item in inventory["plannedResources"] if item["type"] != "service_account"
    ]
    assert (
        pg.execute(
            "SELECT erasure_planned_resources_covered(%s::jsonb)", (json.dumps(mail_coverage),)
        )[0][0]
        is True
    )
    assert set(r["mailErasure"]["pubsub_subscription"]["resources"]) == {
        "direct-sub",
        "dead-letter-sub",
    }
    archived = pg.execute(
        "SELECT personal_agent_erasure_archive(%s::jsonb,'{}'::jsonb)", (json.dumps(r),)
    )[0][0]
    assert (
        archived["receipts"]["mailDeletion"]["resourcesByKind"]["pubsub_subscription"]["resources"]
        == r["mailErasure"]["pubsub_subscription"]["resources"]
    )
    root = Path(__file__).resolve().parents[1] / "db/migrations"
    with pytest.raises(Exception, match="notification checkpoint receipts require retention"):
        pg.apply_file(root / "rollback/956_personal_agent_notification_checkpoint.rollback.sql")
    pg.execute("ROLLBACK")
    assert pg.execute("SELECT notification_checkpoint_admission_ready()")[0][0] is True
    with pytest.raises(Exception, match="personal agent erasure reserved"):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure,mailErasure,pubsub_subscription,resources,dead-letter-sub,deletion}',%s::jsonb) WHERE user_id=%s",
            (
                json.dumps(
                    r["mailErasure"]["pubsub_subscription"]["resources"]["direct-sub"]["deletion"]
                ),
                OWNER,
            ),
        )


@pytest.mark.parametrize(
    "phase,action", [("observed", "restore"), ("observed", "remove"), ("intent", "restore")]
)
def test_completed_checkpoint_custody_survives_real_standby_swap_and_detach(pg, phase, action):
    from hushh_mcp.services.personal_agent_placement_detach import detach_placement
    from hushh_mcp.services.personal_agent_standby_store import PersonalAgentStandbyStore
    from tests import standby_postgres_support as support

    pg.execute("TRUNCATE personal_agent_registry CASCADE")
    support.seed_primary(pg)
    original = support.registry_row(pg)
    original["external_agent_id"] = SERVICE
    cp = {
        **_checkpoint(2, phase, completed=[_result()] if phase == "observed" else []),
        "ownerId": support.OWNER,
        "serviceUid": "incarnation-1",
    }
    original["backend_metadata"]["notificationCheckpoint"] = cp
    original["backend_metadata"]["substrateReceipt"] = {
        "version": "byoc.substrate.receipt.v1",
        "plannedResources": _plan()["plannedResources"],
        "resourceObservations": [_result()["resourceObservation"]],
    }
    pg.execute("TRUNCATE personal_agent_registry CASCADE")
    pg.execute(
        "INSERT INTO personal_agent_registry SELECT (jsonb_populate_record(NULL::personal_agent_registry,%s::jsonb)).*",
        (json.dumps(original),),
    )
    support.seed_standby(pg)
    store = PersonalAgentStandbyStore(client=_Client(pg))
    if phase == "intent":
        with pytest.raises(
            Exception, match="notification checkpoint host transfer requires completed operation"
        ):
            asyncio.run(store.swap_primary_and_standby(support.OWNER, support.direct_observed()))
        with pytest.raises(
            Exception, match="notification checkpoint host transfer requires completed operation"
        ):
            asyncio.run(
                detach_placement(
                    row=support.registry_row(pg), reason="owner request", db=_Client(pg)
                )
            )
        assert support.registry_row(pg) == original
        return
    assert asyncio.run(store.swap_primary_and_standby(support.OWNER, support.direct_observed()))
    assert support.standby_row(pg)["backend_metadata"]["notificationCheckpoint"] == cp
    if action == "remove":
        from sqlalchemy import text

        from hushh_mcp.services import personal_agent_standby_sql as standby_sql
        from hushh_mcp.services import personal_agent_standby_store as standby_store

        before = support.standby_row(pg)
        with pytest.raises(Exception, match="notification checkpoint standby custody not retained"):
            pg.execute(
                "DELETE FROM personal_agent_standby_placements WHERE user_id=%s", (support.OWNER,)
            )
        assert support.standby_row(pg) == before
        with pytest.raises(Exception, match="notification checkpoint standby custody not retained"):
            pg.execute(
                "UPDATE personal_agent_standby_placements SET backend_metadata=backend_metadata-'notificationCheckpoint' WHERE user_id=%s",
                (support.OWNER,),
            )
        observed = asyncio.run(store.read_standby(support.OWNER))
        # A temporary same-transaction archive is insufficient if removed before commit.
        with pytest.raises(Exception, match="notification checkpoint standby custody not retained"):
            with store._db()._engine.begin() as conn:
                conn.execute(
                    text(standby_sql.REMOVE_SQL),
                    {
                        "user_id": support.OWNER,
                        "pod_key_id": observed["pod_key_id"],
                        "epoch": observed["placement_epoch"],
                        "reason": "owner request",
                        "coordinates": standby_store.DETACHED_COORDINATES,
                        "custody_coordinates": standby_store.NOTIFICATION_CUSTODY_COORDINATES,
                    },
                )
                conn.execute(
                    text(
                        "UPDATE personal_agent_registry SET backend_metadata=backend_metadata-'detachedPlacements' WHERE user_id=:owner"
                    ),
                    {"owner": support.OWNER},
                )
        assert support.standby_row(pg) == before
        assert asyncio.run(store.remove_standby(support.OWNER, observed, "owner request"))
        assert support.standby_row(pg) is None
        current = support.registry_row(pg)
        retained = current["backend_metadata"]["detachedPlacements"][-1]
        assert retained["backend_metadata"]["notificationCheckpoint"] == cp
        assert (
            retained["backend_metadata"]["substrateReceipt"]
            == original["backend_metadata"]["substrateReceipt"]
        )
        assert retained["user_id"] == support.OWNER
        assert retained["hushh_id"] == support.HUSHH_ID
        assert retained["external_agent_id"] == SERVICE
        assert retained["pod_signing_key_id"] == original["pod_signing_key_id"]
        for sql in (
            "UPDATE personal_agent_registry SET backend_metadata=backend_metadata-'detachedPlacements' WHERE user_id=%s",
            "DELETE FROM personal_agent_registry WHERE user_id=%s",
        ):
            with pytest.raises(
                Exception, match="notification checkpoint detached custody not retained"
            ):
                pg.execute(sql, (support.OWNER,))
        assert support.registry_row(pg) == current
        root = Path(__file__).resolve().parents[1] / "db/migrations"
        with pytest.raises(Exception, match="notification checkpoint receipts require retention"):
            pg.apply_file(root / "rollback/956_personal_agent_notification_checkpoint.rollback.sql")
        pg.execute("ROLLBACK")
        return
    assert asyncio.run(
        store.swap_primary_and_standby(
            support.OWNER, asyncio.run(store.read_standby(support.OWNER))
        )
    )
    restored = support.registry_row(pg)
    assert restored["backend_metadata"]["notificationCheckpoint"] == cp
    assert restored["pod_key_id"] == original["pod_key_id"]
    assert restored["pod_signing_key_id"] == original["pod_signing_key_id"]
    assert asyncio.run(detach_placement(row=restored, reason="owner request", db=_Client(pg)))
    retained = support.registry_row(pg)["backend_metadata"]["detachedPlacements"][-1]
    assert retained["backend_metadata"]["notificationCheckpoint"] == cp
    assert (
        retained["backend_metadata"]["substrateReceipt"]
        == original["backend_metadata"]["substrateReceipt"]
    )
    assert retained["pod_key_id"] == original["pod_key_id"]
    current = support.registry_row(pg)
    with pytest.raises(Exception, match="notification checkpoint detached custody not retained"):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=backend_metadata-'detachedPlacements' WHERE user_id=%s",
            (support.OWNER,),
        )
    with pytest.raises(Exception, match="notification checkpoint detached custody not retained"):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{detachedPlacements,0,backend_metadata,substrateReceipt}','{}'::jsonb) WHERE user_id=%s",
            (support.OWNER,),
        )
    assert support.registry_row(pg) == current
    root = Path(__file__).resolve().parents[1] / "db/migrations"
    with pytest.raises(Exception, match="notification checkpoint receipts require retention"):
        pg.apply_file(root / "rollback/956_personal_agent_notification_checkpoint.rollback.sql")
    pg.execute("ROLLBACK")
    assert pg.execute("SELECT notification_checkpoint_admission_ready()")[0][0] is True


def test_host_update_cannot_discard_completed_checkpoint_without_retention(pg):
    pg.execute("TRUNCATE personal_agent_registry CASCADE")
    meta = {
        "serviceUid": "uid-1",
        "notificationCheckpoint": _checkpoint(2, "observed", completed=[_result()]),
    }
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,deployment_target,external_agent_id,user_cloud_project,user_cloud_region,user_cloud_bootstrap_sa,backend_metadata) VALUES (%s,%s,'provisioned','user_gcp',%s,%s,%s,%s,%s::jsonb)",
        (OWNER, HID, SERVICE, PROJECT, REGION, BOOTSTRAP, json.dumps(meta)),
    )
    with pytest.raises(Exception, match="notification checkpoint prior host custody not retained"):
        pg.execute(
            "UPDATE personal_agent_registry SET external_agent_id=NULL,deployment_target=NULL,user_cloud_project=NULL,user_cloud_region=NULL,backend_metadata='{}'::jsonb WHERE user_id=%s",
            (OWNER,),
        )
    assert _row(pg)["backend_metadata"] == meta
