"""Native readback and real-SQL CAS recover a failed create without erasing evidence."""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.services.hosted_bootstrap_reconciliation import reconcile_failed_bucket_absence
from hushh_mcp.services.hosted_operator_identity import VerifiedOperator
from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired
from tests.hosted_pod_support import prepared_project_journal
from tests.test_hosted_pilot_admission_postgres import _claim, _Client, _policy
from tests.test_hosted_pilot_admission_postgres import pg as pg
from tests.test_hosted_pod_bootstrap_postgres import _approved_bootstrap


@pytest.fixture
def failed_bucket(pg, monkeypatch, request):
    from tests.test_byoc_setup_job_azure_admission_postgres import ROOT

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://dev.one.hussh.si")
    pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
    pg.apply_file(ROOT / "db/migrations/parked/975_hosted_bucket_reconciliation.sql")
    _policy(
        pg, bootstrap=_approved_bootstrap, preparation=True, ttl=getattr(request, "param", "1 day")
    )
    reservation = asyncio.run(prepared_project_journal(pg, _claim(pg), _Client(pg)))
    journal = HostedPodJournal(_Client(pg))
    admission = reservation["hostedAdmission"]
    completed = []
    generation = 0
    for step in admission["assignment"]["bootstrapContract"]["steps"]:
        checkpoint = {
            "version": 1,
            "ownerId": "owner-a",
            "attemptId": "a" * 32,
            "expectedGeneration": generation,
            "generation": generation + 1,
            "planDigest": admission["bootstrapContractHash"],
            "phase": "intent",
            "step": step,
            "completed": deepcopy(completed),
        }
        assert asyncio.run(
            journal.publish(
                kind="bootstrap", owner_id="owner-a", attempt_id="a" * 32, checkpoint=checkpoint
            )
        )
        completed.append(
            {
                "step": step,
                "status": 503 if step == "cmek_bucket" else 200,
                "ok": step != "cmek_bucket",
            }
        )
        generation += 1
        checkpoint.update(
            expectedGeneration=generation,
            generation=generation + 1,
            phase="observed",
            completed=deepcopy(completed),
        )
        assert asyncio.run(
            journal.publish(
                kind="bootstrap", owner_id="owner-a", attempt_id="a" * 32, checkpoint=checkpoint
            )
        )
        generation += 1
        if step == "cmek_bucket":
            break
    reservation = pg.execute(
        "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    return reservation, checkpoint


def _observation(reservation):
    admission = reservation["hostedAdmission"]
    bucket = next(
        r["id"]
        for r in admission["assignment"]["bootstrapContract"]["plan"]["resources"]
        if r["type"] == "gcs_bucket"
    )
    return {
        "version": 1,
        "actor": "user:operator@example.test",
        "sourceRevision": admission["sourceRevision"],
        "imageDigest": admission["imageDigest"],
        "projectIdentity": reservation["evidence"]["reserved"]["projectObservation"],
        "bucketName": bucket,
        "method": "GET",
        "httpStatus": 404,
        "status": "observed_absent",
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }


def test_failed_create_reconciliation_has_one_winner_and_preserves_failure(pg, failed_bucket):
    reservation, checkpoint = failed_bucket
    observation = _observation(reservation)
    assert not pg.execute(
        "SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a "
        "WHERE p.oid='public.reconcile_hosted_bucket_absence(text,text,jsonb,jsonb)'::regprocedure "
        "AND a.grantee=0 AND a.privilege_type='EXECUTE')"
    )[0][0]

    def recover(value):
        return pg.execute(
            "SELECT reconcile_hosted_bucket_absence(%s,%s,%s::jsonb,%s::jsonb)",
            ("owner-a", "a" * 32, json.dumps(checkpoint), json.dumps(value)),
        )[0][0]

    for changed in (
        {"sourceRevision": "c" * 40},
        {"imageDigest": "sha256:" + "c" * 64},
        {"actor": "user:other@example.test"},
        {"bucketName": "foreign-bucket"},
        {"projectIdentity": {**observation["projectIdentity"], "projectNumber": "999"}},
        {"httpStatus": 200},
        {"httpStatus": 403},
        {"method": "POST"},
        {"observedAt": (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()},
        {"observedAt": "malformed"},
        {"unexpected": True},
    ):
        assert not recover({**observation, **changed})
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(recover, [observation, observation])) == [False, True]
    assert not recover(observation)
    saved = pg.execute(
        "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    reserved = saved["evidence"]["reserved"]
    assert saved["attemptId"] == reservation["attemptId"]
    assert saved["hostedAdmission"] == reservation["hostedAdmission"]
    assert reserved["hostedCheckpointReconciliations"][0]["failedCheckpoint"] == checkpoint
    resumed = reserved["hostedCheckpoint"]
    assert resumed["generation"] == checkpoint["generation"] + 1
    assert resumed["completed"] == checkpoint["completed"][:-1]
    assert resumed["step"] == resumed["completed"][-1]["step"]
    from hushh_mcp.services.hosted_gcp_checkpoint import bind_bootstrap_checkpoint
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    async def retained_prefix():
        _, prefix = bind_bootstrap_checkpoint(
            registry=PersonalAgentRegistryRepo(_Client(pg)),
            reservation=saved,
            plan=saved["hostedAdmission"]["assignment"]["bootstrapContract"]["plan"],
        )
        return prefix

    assert asyncio.run(retained_prefix()) == resumed["completed"]
    # Reopen only the same next frozen step; preceding effects are not repeated.
    next_intent = {
        **resumed,
        "expectedGeneration": resumed["generation"],
        "generation": resumed["generation"] + 1,
        "phase": "intent",
        "step": "cmek_bucket",
    }
    assert pg.execute(
        "SELECT publish_hosted_pod_bootstrap_checkpoint(%s,%s,%s::jsonb)",
        ("owner-a", "a" * 32, json.dumps(next_intent)),
    )[0][0]


@pytest.mark.parametrize(
    "bucket_status,wrong_project", [(200, False), (403, False), (503, False), (404, True)]
)
def test_native_absence_is_required_before_journal_recovery(
    failed_bucket, bucket_status, wrong_project
):
    reservation, _ = failed_bucket
    calls = []
    project = deepcopy(reservation["evidence"]["reserved"]["projectObservation"])
    if wrong_project:
        project["projectNumber"] = "999"

    class Journal:
        async def current(self, **_):
            return True

        async def reconcile_bucket_absence(self, **_):
            calls.append("mutation")
            return True

    class Session:
        def get(self, url, **_):
            return SimpleNamespace(
                status_code=200 if "cloudresourcemanager" in url else bucket_status,
                json=lambda: project,
            )

    with pytest.raises(ProvisionReconciliationRequired):
        asyncio.run(
            reconcile_failed_bucket_absence(
                Journal(),
                reservation,
                operator=VerifiedOperator("user:operator@example.test", "synthetic"),
                session=Session(),
            )
        )
    assert calls == []


@pytest.mark.parametrize("failed_bucket", ["5 seconds"], indirect=True)
def test_expired_admission_cannot_reopen_a_failed_create(pg, failed_bucket):
    reservation, checkpoint = failed_bucket
    observation = _observation(reservation)
    # Let the real immutable policy expire; never disable its allocation guard.
    pg.execute(
        "SELECT pg_sleep(greatest(0,extract(epoch from expires_at-clock_timestamp()))+0.02) FROM hosted_pod_pilot_policy"
    )
    assert not pg.execute(
        "SELECT reconcile_hosted_bucket_absence(%s,%s,%s::jsonb,%s::jsonb)",
        ("owner-a", "a" * 32, json.dumps(checkpoint), json.dumps(observation)),
    )[0][0]
    saved = pg.execute(
        "SELECT backend_metadata->'provisionAttempt' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    assert saved["evidence"]["reserved"]["hostedCheckpoint"] == checkpoint
    assert "hostedCheckpointReconciliations" not in saved["evidence"]["reserved"]
