"""Restart boundaries retain native identity and historical absence evidence."""

import hashlib
import importlib.util
import io
import json
import subprocess
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
import requests

from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused
from hushh_mcp.services.legacy_cloud_removal import resource_key, resource_state, sha256
from hushh_mcp.services.legacy_cloud_removal_executor import LegacyGcpRemoval
from hushh_mcp.services.legacy_cloud_removal_teardown import (
    delete_remaining,
    recover_bucket_acknowledgement,
)
from hushh_mcp.services.legacy_cloud_removal_writer import verify_disabled_writer


def response(status, body=None):
    value = requests.Response()
    value.status_code = status
    value._content = json.dumps(body or {}).encode()
    return value


@pytest.fixture
def worker():
    resources = [
        {
            "type": "service_account",
            "id": "runtime@owner-project.iam.gserviceaccount.com",
            "identity": {
                "name": "runtime",
                "email": "runtime@owner-project.iam.gserviceaccount.com",
                "projectId": "owner-project",
                "uniqueId": "123456789012345",
            },
        },
        {
            "type": "cloud_run_service",
            "id": "owner-service",
            "identity": {"name": "owner-service", "uid": "native-uid"},
        },
        {
            "type": "reasoning_engine",
            "id": "projects/owner-project/locations/us-central1/reasoningEngines/91",
            "identity": {
                "name": "projects/owner-project/locations/us-central1/reasoningEngines/91",
                "createTime": "2026-09-03T00:00:00Z",
            },
        },
        {
            "type": "gcs_bucket",
            "id": "owner-bucket",
            "identity": {
                "name": "owner-bucket",
                "generation": "1",
                "projectNumber": "123456789012",
                "timeCreated": "2026-09-03T00:00:00Z",
            },
        },
    ]
    for item in resources:
        item["authority"] = "owner_reviewed"
    events = []
    body = {"erasure": {"attemptId": "a" * 32}}
    plan = {
        "project": {"projectId": "owner-project", "projectNumber": "123456789012"},
        "runtime": {
            "serviceName": "projects/owner-project/locations/us-central1/services/owner-service",
            "principal": resources[0]["identity"],
        },
        "resources": resources,
        "attemptId": "a" * 32,
        "memory": {
            "bucket": "owner-bucket",
            "object": "log/memory_bank.json",
            "generation": "9",
            "sha256": hashlib.sha256(json.dumps(body).encode()).hexdigest(),
            "engineName": resources[2]["id"],
            "engineCreateTime": resources[2]["identity"]["createTime"],
        },
    }

    def append(key, stage, receipt):
        events.append({"resource": key, "stage": stage, "receipt": receipt})

    journal = SimpleNamespace(
        read=lambda: {"plan": plan, "events": events},
        append=append,
        identity_sha256=lambda item: sha256(item["identity"]),
    )
    return LegacyGcpRemoval(
        session=SimpleNamespace(get=Mock(), post=Mock(), delete=Mock()), journal=journal
    )


def terminal(worker, kind):
    item = worker._resource(kind)
    worker.journal.append(
        resource_key(item),
        "observation",
        {
            "identitySha256": worker.journal.identity_sha256(item),
            "status": "deleted",
            "operationDone": kind in {"cloud_run_service", "reasoning_engine"},
        },
    )


@pytest.mark.parametrize(
    "missing", [None, "service_account", "cloud_run_service", "reasoning_engine"]
)
def test_deleted_writer_resumes_only_after_exact_retained_drain_and_fresh_absence(worker, missing):
    account = worker._resource("service_account")
    worker.journal.append(resource_key(account), "writer_disabled", {"credentialDenied": True})
    for kind in ("service_account", "cloud_run_service", "reasoning_engine"):
        if kind != missing:
            terminal(worker, kind)
    worker.session.get.return_value = response(404)
    if missing:
        with pytest.raises(AzureTeardownRefused):
            verify_disabled_writer(worker)
    else:
        verify_disabled_writer(worker)
    worker.session.post.assert_not_called()
    worker.session.delete.assert_not_called()


@pytest.mark.parametrize("drift", ["generation", "hash"])
def test_late_memory_binding_drift_refuses_before_engine_delete(worker, monkeypatch, drift):
    engine = worker._resource("reasoning_engine")

    def get(url, **kwargs):
        if "reasoningEngines" in url:
            return response(200, engine["identity"])
        if kwargs.get("params", {}).get("alt") == "media":
            return response(200, {"erasure": {"attemptId": "b" * 32}})
        return response(200, {"generation": "10" if drift == "generation" else "9"})

    worker.session.get.side_effect = get
    monkeypatch.setattr(
        worker, "_operations", lambda **kwargs: {"complete": True, "pendingOperations": 0}
    )
    with pytest.raises(AzureTeardownRefused, match="MEMORY_BINDING_CHANGED"):
        worker.delete_memory()
    worker.session.delete.assert_not_called()
    assert "memoryBinding" not in worker._checkpoints(engine)


def test_active_bucket_absence_with_retained_generation_stays_pending_across_resume(worker):
    bucket = worker._resource("gcs_bucket")
    admission = {"bucketIdentity": bucket["identity"], "metageneration": "2", "status": "admitted"}
    worker._intent(bucket)
    worker.journal.append(
        resource_key(bucket),
        "acknowledgement",
        {
            "identitySha256": worker.journal.identity_sha256(bucket),
            "requestId": resource_state(worker.journal.read(), resource_key(bucket))["intent"][
                "requestId"
            ],
            "httpStatus": 204,
            "operationName": None,
        },
    )
    worker._checkpoint(bucket, "bucketAdmission", admission)
    worker._checkpoint(bucket, "bucketAcknowledgement", {**admission, "status": "acknowledged"})

    def get(url, **kwargs):
        if "cloudresourcemanager" in url:
            return response(
                200,
                {
                    "projectId": worker.project,
                    "projectNumber": worker.plan["project"]["projectNumber"],
                },
            )
        if kwargs.get("params", {}).get("softDeleted"):
            return response(200, {**bucket["identity"], "hardDeleteTime": "2026-11-13T00:00:00Z"})
        return response(404)

    worker.session.get.side_effect = get
    proof = {
        "type": "gcs_bucket",
        "id": bucket["id"],
        "identity": bucket["identity"],
        "disposition": "created",
    }
    reservation = {
        "registrySnapshot": {
            "backend_metadata": {"substrateReceipt": {"resourceObservations": [proof]}}
        }
    }
    for _ in range(2):
        assert delete_remaining(worker, token=uuid4().hex, reservation=reservation) == [
            resource_key(bucket)
        ]
        state = resource_state(worker.journal.read(), resource_key(bucket))
        assert state["observation"]["status"] == "waiting_for_provider"
        assert "bucketDeletion" not in worker._checkpoints(bucket)
    worker.session.delete.assert_not_called()


@pytest.mark.parametrize("ack_retained", [False, True])
def test_bucket_ack_recovery_uses_original_response_not_later_absence(worker, ack_retained):
    from hushh_mcp.services.legacy_cloud_removal_native import resource_url

    bucket = worker._resource("gcs_bucket")
    worker._intent(bucket)
    admission = {"bucketIdentity": bucket["identity"], "metageneration": "2", "status": "admitted"}
    worker._checkpoint(bucket, "bucketAdmission", admission)
    target = sha256(
        {
            "method": "DELETE",
            "url": resource_url(worker.project, worker.region, bucket),
            "params": {"ifMetagenerationMatch": "2"},
            "json": None,
        }
    )
    receipt = {"requestId": uuid4().hex, "targetSha256": target}
    worker.journal.append(resource_key(bucket), "provider_dispatch", receipt)
    if ack_retained:
        worker.journal.append(resource_key(bucket), "provider_ack", {**receipt, "httpStatus": 204})
        recover_bucket_acknowledgement(worker, bucket)
        assert (
            resource_state(worker.journal.read(), resource_key(bucket))["acknowledgement"][
                "httpStatus"
            ]
            == 204
        )
        assert worker._checkpoints(bucket)["bucketAcknowledgement"] == {
            **admission,
            "status": "acknowledged",
        }
    else:
        with pytest.raises(AzureTeardownRefused, match="OUTCOME_UNKNOWN"):
            recover_bucket_acknowledgement(worker, bucket)
        assert "bucketAcknowledgement" not in worker._checkpoints(bucket)
    worker.session.get.assert_not_called()
    worker.session.delete.assert_not_called()


def test_exact_memory_control_record_retains_qualification(worker):
    worker.session.get.side_effect = [
        response(200, {"generation": "9"}),
        response(200, {"erasure": {"attemptId": worker.plan["attemptId"]}}),
    ]
    engine = worker._resource("reasoning_engine")
    worker.qualify_memory_binding(engine)
    assert worker._checkpoints(engine)["memoryBinding"] == worker.plan["memory"]
    worker.session.delete.assert_not_called()


@pytest.fixture
def operator():
    path = Path(__file__).resolve().parents[2] / "scripts/ops/recover_dev_cloud_removal.py"
    spec = importlib.util.spec_from_file_location("legacy_recovery_operator", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("retained_status", [200, 404])
def test_deleted_bucket_authority_requires_fresh_historical_absence(
    worker, operator, retained_status
):
    bucket = worker._resource("gcs_bucket")
    worker._checkpoint(
        bucket, "bucketDeletion", {"bucketIdentity": bucket["identity"], "status": "deleted"}
    )
    terminal(worker, "gcs_bucket")
    worker.session.post.side_effect = lambda url, **kw: response(200, kw["json"])
    worker.session.get.side_effect = lambda url, **kw: response(
        retained_status if kw.get("params", {}).get("softDeleted") else 404
    )
    if retained_status == 200:
        with pytest.raises(AzureTeardownRefused, match="RESOURCE_REPLACED"):
            operator.require_cleanup_authority(worker)
    else:
        operator.require_cleanup_authority(worker)
    assert all(
        not call.args[0].endswith("testPermissions") for call in worker.session.get.call_args_list
    )


def test_resume_source_is_pinned_to_operator_and_refuses_dirty_source(
    operator, tmp_path, monkeypatch
):
    monkeypatch.setattr(operator, "ROOT", tmp_path)

    def git(*args):
        # Every argument below is an authored fixture literal; no shell or user input.
        return subprocess.check_output(["git", *args], cwd=tmp_path, text=True).strip()  # noqa: S603

    git("init", "-q")
    owned = tmp_path / "consent-protocol/service.py"
    owned.parent.mkdir()
    owned.write_text("approved operator\n")
    git("add", ".")
    git(
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.test",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "fixture",
    )
    pinned = git("rev-parse", "HEAD")
    assert operator.require_operator_source(pinned) == pinned
    with pytest.raises(AzureTeardownRefused, match="SOURCE_CHANGED"):
        operator.require_operator_source("b" * 40)
    owned.write_text("unreviewed operator\n")
    with pytest.raises(AzureTeardownRefused, match="SOURCE_CHANGED"):
        operator.require_operator_source(pinned)


def test_execute_resumes_retention_then_deleted_writer_and_interrupted_bootstrap(
    worker, operator, monkeypatch
):
    from hushh_mcp.services import legacy_cloud_removal as journal_module
    from hushh_mcp.services import legacy_cloud_removal_executor as executor_module
    from hushh_mcp.services import legacy_cloud_removal_native as native_module

    bucket, account = worker._resource("gcs_bucket"), worker._resource("service_account")
    member = "serviceAccount:consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com"
    worker.plan["resources"].append(
        {
            "type": "bootstrap_access",
            "id": "bootstrap@owner-project.iam.gserviceaccount.com",
            "authority": "owner_reviewed",
            "identity": {
                "account": {"uniqueId": "123456789012346"},
                "bindings": [{"role": "roles/iam.serviceAccountTokenCreator", "member": member}],
            },
        }
    )
    worker.journal.append(resource_key(account), "writer_disabled", {"credentialDenied": True})
    for kind in ("cloud_run_service", "reasoning_engine"):
        terminal(worker, kind)
    worker._intent(bucket)
    worker.journal.append(
        resource_key(bucket),
        "acknowledgement",
        {"identitySha256": worker.journal.identity_sha256(bucket), "httpStatus": 204},
    )
    admission = {"bucketIdentity": bucket["identity"], "metageneration": "2", "status": "admitted"}
    worker._checkpoint(bucket, "bucketAdmission", admission)
    worker._checkpoint(bucket, "bucketAcknowledgement", {**admission, "status": "acknowledged"})
    state = {"retained": True, "writerGone": False, "bootstrapGone": False, "interrupt": True}

    def get(url, **kwargs):
        if "cloudresourcemanager" in url:
            return response(
                200,
                {
                    "projectId": worker.project,
                    "projectNumber": worker.plan["project"]["projectNumber"],
                },
            )
        if kwargs.get("params", {}).get("softDeleted"):
            return (
                response(200, {**bucket["identity"], "hardDeleteTime": "2026-11-13T00:00:00Z"})
                if state["retained"]
                else response(404)
            )
        if "serviceAccounts/123456789012345" in url and not state["writerGone"]:
            return response(200, {**account["identity"], "disabled": True})
        return response(404)

    def post(url, **kwargs):
        if url.endswith(":testIamPermissions"):
            return response(200, kwargs["json"])
        if url.endswith(":getIamPolicy"):
            return response(
                200,
                {
                    "etag": "original-etag",
                    "bindings": []
                    if state["bootstrapGone"]
                    else [{"role": "roles/iam.serviceAccountTokenCreator", "members": [member]}],
                },
            )
        assert url.endswith("/serviceAccounts/123456789012346:setIamPolicy")
        if state["interrupt"]:
            state["interrupt"] = False
            return response(412)
        state["bootstrapGone"] = True
        return response(200)

    def delete(url, **kwargs):
        assert url.endswith("/serviceAccounts/123456789012345")
        state["writerGone"] = True
        return response(204)

    (
        worker.session.get.side_effect,
        worker.session.post.side_effect,
        worker.session.delete.side_effect,
    ) = get, post, delete
    original_read = worker.journal.read
    worker.journal.read = lambda: {**original_read(), "planSha256": "d" * 64}
    worker.journal.start = lambda execution, source: {"executionId": execution}
    monkeypatch.setattr(journal_module, "LegacyRemovalJournal", lambda *args: worker.journal)
    monkeypatch.setattr(executor_module, "LegacyGcpRemoval", lambda **kwargs: worker)
    monkeypatch.setattr(
        native_module, "RecoverySession", lambda **kwargs: nullcontext(worker.session)
    )
    raw = SimpleNamespace(driver_connection=SimpleNamespace(), close=Mock())
    engine = SimpleNamespace(raw_connection=lambda: raw)
    args = SimpleNamespace(
        owner="owner",
        attempt=worker.plan["attemptId"],
        project=worker.project,
        account="operator@example.test",
        execution_id=uuid4().hex,
        manifest_sha256="d" * 64,
    )
    proof = {
        "type": "gcs_bucket",
        "id": bucket["id"],
        "identity": bucket["identity"],
        "disposition": "created",
    }
    reservation = {
        "registrySnapshot": {
            "backend_metadata": {"substrateReceipt": {"resourceObservations": [proof]}}
        }
    }
    credentials = SimpleNamespace(token=uuid4().hex)

    def run():
        return operator.execute(args, engine, "e" * 40, reservation, credentials, io.StringIO())

    assert run() == 0  # Retention waits without another bucket/object DELETE.
    assert not state["writerGone"]
    state["retained"] = False
    assert run() == 1  # Bucket/SA complete; the exact bootstrap update is interrupted.
    assert state["writerGone"] and not state["bootstrapGone"]
    assert run() == 0
    assert state["bootstrapGone"]
    assert worker.session.delete.call_count == 1
