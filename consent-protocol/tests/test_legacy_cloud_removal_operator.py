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
from hushh_mcp.services.legacy_cloud_removal import (
    recovery_view,
    resource_key,
    resource_state,
    sha256,
)
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


def test_retention_view_exposes_only_qualified_native_recheck_time_without_completing(worker):
    bucket = worker._resource("gcs_bucket")
    observation = {
        "status": "waiting_for_provider",
        "identitySha256": worker.journal.identity_sha256(bucket),
        "coverage": {
            "providerRetention": True,
            "inventoryComplete": True,
            "nextEligibleAt": "2099-11-13T07:03:50.404Z",
        },
    }
    worker.journal.append(resource_key(bucket), "observation", observation)
    recovery = {**worker.journal.read(), "planSha256": "a" * 64}
    hashes = {resource_key(bucket): observation["identitySha256"]}
    view = recovery_view(recovery, identity_hashes=hashes)
    assert view["nextEligibleAt"] == "2099-11-13T07:03:50.404Z"
    assert view["canFinalize"] is False and view["approvalRequired"] is True
    for field, value in (
        ("inventoryComplete", False),
        ("nextEligibleAt", "unknown"),
        ("nextEligibleAt", "2099-11-13T07:03:50"),
    ):
        original = observation["coverage"][field]
        observation["coverage"][field] = value
        assert recovery_view(recovery, identity_hashes=hashes)["nextEligibleAt"] is None
        observation["coverage"][field] = original
    observation["identitySha256"] = "b" * 64
    assert recovery_view(recovery, identity_hashes=hashes)["nextEligibleAt"] is None
    assert recovery_view(recovery)["nextEligibleAt"] is None


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


@pytest.mark.parametrize("qualified_storage", [False, True])
def test_only_verified_storage_retention_allows_parallel_kms_wait(
    worker, monkeypatch, qualified_storage
):
    from hushh_mcp.services import byoc_substrate_teardown as substrate
    from hushh_mcp.services import legacy_cloud_removal_teardown as teardown

    bucket = worker._resource("gcs_bucket")
    kms = {
        "type": "kms_key",
        "id": "old-key",
        "authority": "owner_reviewed",
        "identity": {
            "name": "projects/owner-project/locations/us-central1/keyRings/hushh-one/cryptoKeys/old-key",
            "purpose": "ENCRYPT_DECRYPT",
            "createTime": "2026-09-03T00:00:00Z",
        },
    }
    worker.plan["resources"].extend(
        [
            kms,
            {
                "type": "secret",
                "id": "cleanup-secret",
                "identity": {},
                "authority": "owner_reviewed",
            },
        ]
    )
    worker.session.get.side_effect = lambda url, **_: response(
        200, kms["identity"] if "cryptoKeys" in url else bucket["identity"]
    )
    attempted = []

    async def retained(resource):
        attempted.append(resource["type"])
        raise substrate.SubstrateDeleteError("provider retention")

    monkeypatch.setattr(substrate, "build_gcp_deleter", lambda **_: retained)
    monkeypatch.setattr(
        teardown,
        "observe_retention",
        lambda _, resource: {
            "providerRetention": qualified_storage if resource["type"] == "gcs_bucket" else True,
            "inventoryComplete": True,
            "nextEligibleAt": "2099-01-01T00:00:00Z",
        },
    )
    proof = [{**r, "disposition": "created"} for r in (bucket, kms)]
    reservation = {
        "registrySnapshot": {
            "backend_metadata": {"substrateReceipt": {"resourceObservations": proof}}
        }
    }
    pending = delete_remaining(worker, token=uuid4().hex, reservation=reservation)
    assert attempted == (["gcs_bucket", "kms_key"] if qualified_storage else ["gcs_bucket"])
    assert pending == [resource_key(r) for r in ((bucket, kms) if qualified_storage else (bucket,))]
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


@pytest.mark.parametrize(
    "failure", [None, "compute_pending", "bootstrap_disabled", "identity_changed"]
)
def test_lost_probe_uses_compute_first_native_port_without_mint_or_reenable(worker, failure):
    from urllib.parse import unquote

    from hushh_mcp.services.byoc_substrate_teardown import SubstrateDeleteError
    from hushh_mcp.services.legacy_cloud_removal_writer import (
        admit_disabled_writer_compute,
        qualify_writer_after_compute,
    )

    runtime = worker._resource("service_account")
    token = uuid4().hex
    runtime["identity"]["name"] = f"projects/owner-project/serviceAccounts/{runtime['id']}"
    principal = runtime["identity"]
    bootstrap = {
        "name": "projects/owner-project/serviceAccounts/bootstrap@owner-project.iam.gserviceaccount.com",
        "email": "bootstrap@owner-project.iam.gserviceaccount.com",
        "projectId": "owner-project",
        "uniqueId": "123456789012346",
    }
    worker.plan["resources"].append(
        {
            "type": "bootstrap_access",
            "id": bootstrap["email"],
            "identity": {"account": bootstrap},
            "authority": "owner_reviewed",
        }
    )
    worker.journal.append(resource_key(runtime), "writer_acknowledgement", {"httpStatus": 200})
    worker.session.get.side_effect = lambda url, **kwargs: (
        response(404)
        if "/services/" in url
        else response(200, {**bootstrap, "disabled": failure == "bootstrap_disabled"})
        if bootstrap["email"] in unquote(url)
        else response(
            200,
            {
                **principal,
                "disabled": True,
                **({"uniqueId": "foreign"} if failure == "identity_changed" else {}),
            },
        )
    )
    if failure == "identity_changed":
        with pytest.raises(AzureTeardownRefused):
            admit_disabled_writer_compute(worker)
    else:
        admit_disabled_writer_compute(worker)
        terminal(worker, "cloud_run_service")
        if failure == "compute_pending":
            event = worker.journal.read()["events"][-1]
            event["receipt"]["operationDone"] = False
        if failure:
            with pytest.raises((AzureTeardownRefused, SubstrateDeleteError)):
                qualify_writer_after_compute(worker, token=token)
        else:
            qualify_writer_after_compute(worker, token=token)
            state = resource_state(worker.journal.read(), resource_key(runtime))
            assert state["native_writer_disabled_after_compute"]["runtimeIdentity"] == principal
            assert "credentialDenied" not in state["native_writer_disabled_after_compute"]
            assert "writer_disabled" not in state
    worker.session.post.assert_not_called()
    worker.session.delete.assert_not_called()


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


def test_retired_native_readback_accepts_destroyed_key_shell_and_removed_bootstrap_grant(
    worker, monkeypatch
):
    from hushh_mcp.services import legacy_cloud_removal as journal_contract
    from hushh_mcp.services.legacy_cloud_removal_native import resource_url, verify_retired_plan

    # Plan validation has its PostgreSQL/forgery cases; this exercises native
    # incarnation and terminal-resource semantics, independently of the renderer.
    validate = Mock()
    monkeypatch.setattr(journal_contract, "validate_plan", validate)
    worker.plan["project"]["createTime"] = "2026-09-03T00:00:00Z"
    key = {
        "type": "kms_key",
        "id": "old-key",
        "authority": "owner_reviewed",
        "identity": {
            "name": "projects/owner-project/locations/us-central1/keyRings/hushh-one/cryptoKeys/old-key",
            "purpose": "ENCRYPT_DECRYPT",
            "createTime": "2026-09-03T00:00:00Z",
        },
    }
    bootstrap = {
        "type": "bootstrap_access",
        "id": "bootstrap@owner-project.iam.gserviceaccount.com",
        "authority": "owner_reviewed",
        "identity": {
            "account": {
                "name": "projects/owner-project/serviceAccounts/bootstrap@owner-project.iam.gserviceaccount.com",
                "email": "bootstrap@owner-project.iam.gserviceaccount.com",
                "uniqueId": "987654321012345",
                "projectId": "owner-project",
            },
            "bindings": [
                {
                    "role": "roles/iam.serviceAccountTokenCreator",
                    "member": "serviceAccount:consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com",
                }
            ],
        },
    }
    worker.plan["resources"].extend([key, bootstrap])
    for item in worker.plan["resources"]:
        worker.journal.append(resource_key(item), "observation", {"status": "deleted"})
    key_body = dict(key["identity"])
    states = [{"state": "DESTROYED"}]
    account = dict(bootstrap["identity"]["account"])

    def get(url, **kwargs):
        if url.endswith("v3/projects/owner-project"):
            return response(
                200,
                {
                    "projectId": "owner-project",
                    "name": "projects/123456789012",
                    "state": "ACTIVE",
                    "createTime": worker.plan["project"]["createTime"],
                },
            )
        if url.endswith("/cryptoKeyVersions"):
            return response(200, {"cryptoKeyVersions": states})
        if url == resource_url(worker.project, worker.region, key):
            return response(200, key_body)
        if url == resource_url(
            worker.project, worker.region, {"type": "bootstrap_access", "id": bootstrap["id"]}
        ):
            return response(200, account)
        return response(404)

    worker.session.get.side_effect = get
    worker.session.post.return_value = response(200, {"bindings": []})
    verify_retired_plan(
        worker.session, reservation={"original": True}, recovery=worker.journal.read()
    )
    validate.assert_called_once_with({"original": True}, worker.plan)
    states[0]["state"] = "ENABLED"
    with pytest.raises(AzureTeardownRefused):
        verify_retired_plan(worker.session, reservation={}, recovery=worker.journal.read())
    states[0]["state"] = "DESTROYED"
    key_body["createTime"] = "2026-10-01T00:00:00Z"
    with pytest.raises(AzureTeardownRefused):
        verify_retired_plan(worker.session, reservation={}, recovery=worker.journal.read())


@pytest.mark.parametrize("apply", [False, True])
def test_owner_authority_template_uses_own_login_exact_native_identity_and_etag(
    monkeypatch, tmp_path, apply
):
    import copy
    import sys
    import urllib.request

    path = Path(__file__).resolve().parents[2] / "scripts/ops/cloud_removal_owner_authority.py"
    spec = importlib.util.spec_from_file_location("owner_cleanup_authority", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    account = {
        "name": "projects/owner-project/serviceAccounts/bootstrap@owner-project.iam.gserviceaccount.com",
        "email": "bootstrap@owner-project.iam.gserviceaccount.com",
        "uniqueId": "123456789012345",
        "projectId": "owner-project",
    }
    binding = {
        "role": "roles/iam.serviceAccountTokenCreator",
        "member": "serviceAccount:consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com",
    }
    project = {
        "projectId": "owner-project",
        "projectNumber": "123456789012",
        "createTime": "2026-09-03T00:00:00Z",
    }
    recovery = {
        "planSha256": "a" * 64,
        "plan": {
            "controlProject": "hushh-pda-dev",
            "project": project,
            "actor": "fixture@example.test",
            "attemptId": "old-cleanup",
            "resources": [
                {
                    "type": "bootstrap_access",
                    "id": account["email"],
                    "authority": "owner_reviewed",
                    "identity": {"account": account, "bindings": [binding]},
                }
            ],
        },
    }
    source = module.render_owner_authority_template(recovery)
    template = tmp_path / "owner_cleanup.py"
    template.write_text(source)
    policy = {
        "etag": "native-etag",
        "version": 3,
        "bindings": [
            {
                "role": "roles/viewer",
                "members": ["user:other@example.test"],
                "condition": {"title": "preserve", "expression": "true"},
            }
        ],
    }
    original = copy.deepcopy(policy)
    writes = []

    def urlopen(req, **kwargs):
        url = req.full_url
        if "userinfo" in url:
            body = {"email": "fixture@example.test", "email_verified": True}
        elif "cloudresourcemanager" in url:
            body = {
                "projectId": project["projectId"],
                "name": "projects/" + project["projectNumber"],
                "createTime": project["createTime"],
                "state": "ACTIVE",
            }
        elif url.endswith(":getIamPolicy"):
            body = policy
        elif url.endswith(":setIamPolicy"):
            changed = json.loads(req.data)["policy"]
            assert changed["etag"] == original["etag"]
            assert changed["bindings"][0] == original["bindings"][0]
            writes.append(changed)
            policy.update(changed)
            body = policy
        else:
            body = account
        return nullcontext(io.StringIO(json.dumps(body)))

    def build_opener(handler):
        assert (
            handler.redirect_request(None, None, 302, "redirect", {}, "https://foreign.invalid/")
            is None
        )
        return SimpleNamespace(open=urlopen)

    monkeypatch.setattr(urllib.request, "build_opener", build_opener)
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout="memory-only-test-token"))
    monkeypatch.setattr(subprocess, "run", run)
    argv = [str(template)]
    if apply:
        argv += [
            "--apply",
            "--operation-digest",
            recovery["planSha256"],
            "--template-sha256",
            hashlib.sha256(template.read_bytes()).hexdigest(),
        ]
    monkeypatch.setattr(sys, "argv", argv)
    try:
        import runpy

        runpy.run_path(str(template), run_name="__main__")
    except SystemExit as outcome:
        assert outcome.code == 0
    assert len(writes) == int(apply)
    assert "--account=fixture@example.test" in run.call_args.args[0]
    assert "--project=owner-project" in run.call_args.args[0]


def test_owner_template_redirect_cannot_forward_authority_to_another_host(tmp_path):
    import ast
    import urllib.error
    import urllib.request
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from threading import Thread

    path = Path(__file__).resolve().parents[2] / "scripts/ops/cloud_removal_owner_authority.py"
    spec = importlib.util.spec_from_file_location("owner_authority_redirect", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tree = ast.parse(module._TEMPLATE.replace("__FROZEN_JSON__", "'{}'"))
    definition = next(
        n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "NoRedirect"
    )
    import runpy

    handler_source = tmp_path / "reviewed_redirect_handler.py"
    handler_source.write_text("import urllib.request\n" + ast.unparse(definition))
    scope = runpy.run_path(str(handler_source))
    received = []

    class Target(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_args):
            pass

    target = HTTPServer(("127.0.0.1", 0), Target)

    class Redirect(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{target.server_port}/foreign")
            self.end_headers()

        def log_message(self, *_args):
            pass

    origin = HTTPServer(("127.0.0.1", 0), Redirect)
    workers = [Thread(target=s.serve_forever, daemon=True) for s in (origin, target)]
    for worker in workers:
        worker.start()
    try:
        opener = urllib.request.build_opener(scope["NoRedirect"]())
        req = urllib.request.Request(
            f"http://127.0.0.1:{origin.server_port}/native",
            headers={"Authorization": "Bearer synthetic-owner-authority"},
        )
        with pytest.raises(urllib.error.HTTPError) as denied:
            opener.open(req, timeout=2)
        assert denied.value.code == 302
        denied.value.close()
        assert received == []
    finally:
        for server in (origin, target):
            server.shutdown()
            server.server_close()
        for worker in workers:
            worker.join(timeout=2)
            assert not worker.is_alive()


@pytest.mark.parametrize("stage", ["startup", "execution"])
def test_supervisor_deadline_joins_wedged_child_without_inventing_database_receipt(
    worker, monkeypatch, stage
):
    import sys

    from hushh_mcp.services import legacy_cloud_removal as removal

    launched = []
    real_popen = subprocess.Popen

    def launch(*args, **kwargs):
        process = real_popen(*args, **kwargs)
        launched.append(process)
        return process

    monkeypatch.setattr(removal.subprocess, "Popen", launch)
    child = "import time; time.sleep(30)"
    if stage == "execution":
        child = """import json,sys,os,time
p=json.load(sys.stdin)
with os.fdopen(p['startedFd'],'w') as ready:
 print(json.dumps({'executionId':p['args']['execution_id']}),file=ready,flush=True)
time.sleep(30)
"""
    with pytest.raises((AzureTeardownRefused, subprocess.TimeoutExpired)):
        removal.supervise_removal(
            worker.journal,
            {"args": {"execution_id": "c" * 32}},
            command=[sys.executable, "-c", child],
            startup_timeout=0.5,
            execution_timeout=0.8,
        )
    assert len(launched) == 1 and launched[0].poll() is not None
    assert not any(e["stage"] == "executor_exit" for e in worker.journal.read()["events"])


def test_lost_child_release_admission_refuses_before_native_mutation(worker, monkeypatch):
    from requests import Session

    from hushh_mcp.services.legacy_cloud_removal_native import RecoverySession, resource_url

    guard = Mock(side_effect=RuntimeError("release session lost"))
    send = Mock()
    monkeypatch.setattr(Session, "request", send)
    with RecoverySession(
        token=uuid4().hex,
        project=worker.project,
        journal=worker.journal,
        dispatch_guard=guard,
    ) as session:
        session.resource = worker._resource("gcs_bucket")
        with pytest.raises(RuntimeError, match="release session lost"):
            session.delete(resource_url(worker.project, worker.region, session.resource))
    send.assert_not_called()
    assert not worker.journal.read()["events"]
