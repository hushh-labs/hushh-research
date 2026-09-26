"""Files setup cannot move runtime identity or silently resize an existing pod."""

# ruff: noqa: S106 -- inert fake credentials only.
from copy import deepcopy

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.pod_files.provisioning import (
    bucket_matches,
    preserve_existing_configuration,
    queue_matches,
)
from hushh_mcp.services.user_gcp_backend import UserGcpBackend
from hushh_mcp.services.user_gcp_bootstrap import UserGcpBootstrap


def test_files_queue_is_scoped_and_does_not_replace_runtime_identity(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_FILES_ENABLED", "true")
    spec = PodSpec(
        hushh_id="owner-123",
        phone_e164_hash="opaque",
        pod_pubkey="public",
        resource_tier="economy",
        files_library_enabled=True,
    )
    backend = UserGcpBackend(user_project="owner-project", user_region="us-central1", live=False)
    plan = backend.render_bootstrap_plan(spec)
    calls = UserGcpBootstrap(
        project="owner-project", region="us-central1", token="test"
    ).plan_calls(plan)  # noqa: S106 - inert fake credential
    steps = {call["step"]: call for call in calls}
    runtime = next(item for item in plan["resources"] if item["type"] == "cloud_run_service")[
        "service_account"
    ]
    worker = plan["filesLibrary"]["worker"]
    assert worker != runtime
    assert steps["pod_service_account"]["body"]["accountId"] == runtime.split("@")[0]
    assert steps["iam_files_enqueuer"]["bindings"] == [
        {"role": "roles/cloudtasks.enqueuer", "members": [f"serviceAccount:{runtime}"]}
    ]
    assert steps["iam_files_worker_actas"]["write_url"].endswith(f"/{worker}:setIamPolicy")
    assert not any(worker in str(call.get("bindings")) for call in calls)
    queue = steps["files_queue"]["body"]
    assert queue_matches({**queue, "state": "RUNNING"}, queue)
    assert not queue_matches(
        {**queue, "state": "RUNNING", "httpTarget": {"uriOverride": {"host": "elsewhere"}}}, queue
    )
    cfg = backend.render_deploy_config(spec)
    template = cfg["spec"]["template"]
    assert template["spec"]["containerConcurrency"] == 8
    assert template["spec"]["containers"][0]["resources"]["limits"] == {"cpu": "1", "memory": "1Gi"}
    assert template["metadata"]["annotations"]["autoscaling.knative.dev/minScale"] == "0"


def test_existing_owner_does_not_gain_files_or_new_sizing(monkeypatch):
    spec = PodSpec(hushh_id="owner", phone_e164_hash="opaque", pod_pubkey="public")
    backend = UserGcpBackend(user_project="owner-project", live=False)
    monkeypatch.delenv("HUSSH_POD_FILES_ENABLED", raising=False)
    previous = backend.render_deploy_config(spec)
    old = previous["spec"]["template"]["spec"]
    old["containers"][0]["resources"]["limits"] = {"cpu": "2", "memory": "2Gi"}
    old["containerConcurrency"] = 3
    monkeypatch.setenv("HUSSH_POD_FILES_ENABLED", "true")
    desired = backend.render_deploy_config(spec)
    preserve_existing_configuration(previous, desired)
    new = desired["spec"]["template"]["spec"]
    assert new["containerConcurrency"] == 3
    assert new["containers"][0]["resources"] == old["containers"][0]["resources"]
    assert not any(item["name"].startswith("POD_FILES_") for item in new["containers"][0]["env"])


def test_bucket_custody_refuses_weak_public_access_or_foreign_key():
    bucket = {
        "name": "private",
        "encryption": {"defaultKmsKeyName": "owner-key"},
        "iamConfiguration": {
            "publicAccessPrevention": "enforced",
            "uniformBucketLevelAccess": {"enabled": True},
        },
    }
    assert bucket_matches(bucket, bucket="private", kms_key="owner-key")
    assert not bucket_matches(bucket, bucket="private", kms_key="foreign-key")
    changed = deepcopy(bucket)
    changed["iamConfiguration"]["publicAccessPrevention"] = "inherited"
    assert not bucket_matches(changed, bucket="private", kms_key="owner-key")


def test_rollout_flag_alone_never_enables_an_owners_library(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_FILES_ENABLED", "true")
    backend = UserGcpBackend(user_project="owner-project", live=False)
    spec = PodSpec(hushh_id="owner", phone_e164_hash="opaque", pod_pubkey="public")
    assert "filesLibrary" not in backend.render_bootstrap_plan(spec)
    env = backend.render_deploy_config(spec)["spec"]["template"]["spec"]["containers"][0]["env"]
    assert not any(item["name"].startswith("POD_FILES_") for item in env)


def test_files_selection_cannot_follow_a_project_or_identity_switch():
    from hushh_mcp.services.pod_files.selection import selected_for_row

    row = {
        "user_cloud_project": "owner-project",
        "user_cloud_bootstrap_sa": "bootstrap",
        "user_cloud_authorized_at": "proven",
        "backend_metadata": {
            "filesSetup": {
                "version": 1,
                "enabled": True,
                "project": "owner-project",
                "bootstrapAccount": "bootstrap",
            }
        },
    }
    assert selected_for_row(row)
    assert not selected_for_row({**row, "user_cloud_project": "other-project"})
    assert not selected_for_row({**row, "user_cloud_bootstrap_sa": "other-identity"})
    assert not selected_for_row({**row, "user_cloud_authorized_at": None})


def test_queue_receipt_keeps_only_verified_planned_configuration():
    from hushh_mcp.services.byoc_substrate import SubstrateReceipt
    from hushh_mcp.services.pod_files.provisioning import queue_creation_observation

    name = "projects/owner-project/locations/us-central1/queues/one-files-" + "a" * 20
    observed = {
        "name": name,
        "state": "RUNNING",
        "rateLimits": {
            "maxDispatchesPerSecond": 1,
            "maxConcurrentDispatches": 1,
            "maxBurstSize": 10,
        },
        "retryConfig": {
            "maxAttempts": 3,
            "minBackoff": "10s",
            "maxBackoff": "60s",
            "maxDoublings": 2,
        },
    }
    identity = queue_creation_observation(observed, name)
    assert identity is not None
    assert "state" not in identity and "maxBurstSize" not in identity["rateLimits"]
    resource = {"type": "cloud_tasks_queue", "id": name.rsplit("/", 1)[-1]}
    receipt = SubstrateReceipt(
        applied=True,
        tenant_ref="owner-project/us-central1",
        planned_resources=[resource],
        resource_observations=[{**resource, "disposition": "created", "identity": identity}],
    )
    assert receipt.as_record()["resourceObservations"][0]["identity"] == identity
    from dataclasses import replace

    receipt = replace(receipt, tenant_ref="foreign-project/us-central1")
    assert "resourceObservations" not in receipt.as_record()
    assert (
        queue_creation_observation(
            {**observed, "httpTarget": {"uriOverride": {"host": "other"}}}, name
        )
        is None
    )


def test_files_teardown_requires_acknowledgement_and_never_replays_uncertain_delete():
    from unittest.mock import Mock

    import pytest

    from hushh_mcp.services.byoc_substrate_teardown import SubstrateDeleteError
    from hushh_mcp.services.pod_files.provisioning import coordinates, queue_creation_observation
    from hushh_mcp.services.pod_files.teardown import reconcile_resource

    names = coordinates("owner", "owner-project", "us-central1")
    identity = queue_creation_observation(
        {
            "name": names["queue"],
            "rateLimits": {"maxDispatchesPerSecond": 1, "maxConcurrentDispatches": 1},
            "retryConfig": {
                "maxAttempts": 3,
                "maxRetryDuration": "0s",
                "minBackoff": "10s",
                "maxBackoff": "60s",
                "maxDoublings": 2,
            },
        },
        names["queue"],
    )
    observation = {
        "type": "cloud_tasks_queue",
        "id": names["queueId"],
        "disposition": "created",
        "identity": identity,
    }

    def response(status, body):
        return Mock(status_code=status, json=Mock(return_value=body))

    for acknowledged in (False, True):
        state, events = {}, []
        session = Mock()
        session.get.side_effect = [
            response(200, {**identity, "state": "RUNNING"}),
            response(200, {**identity, "state": "PAUSED"}),
            response(404, {}),
        ]
        session.post.return_value = response(200, {})

        def delete(*args, state=state, events=events, acknowledged=acknowledged, **kwargs):
            assert "admission" in state and "quiescence" in state
            events.append("delete")
            return response(200 if acknowledged else 503, {})

        session.delete.side_effect = delete

        def retain(stage, receipt, *, state=state, events=events):
            state[stage] = receipt
            events.append(stage)
            return True

        kwargs = dict(
            token="inert",
            project="owner-project",
            region="us-central1",
            observation=observation,
            state=state,
            retain_receipt=retain,
            session=session,
        )
        if not acknowledged:
            with pytest.raises(SubstrateDeleteError, match="acknowledgement"):
                reconcile_resource(**kwargs)
            with pytest.raises(SubstrateDeleteError, match="acknowledgement unresolved"):
                reconcile_resource(**kwargs)
        else:
            reconcile_resource(**kwargs)
            assert events == ["admission", "quiescence", "delete", "acknowledgement", "deletion"]
            session.get.side_effect = [response(404, {})]
            reconcile_resource(**kwargs)
        assert session.delete.call_count == 1


def test_files_worker_teardown_targets_captured_unique_identity():
    from unittest.mock import Mock

    import pytest

    from hushh_mcp.services.byoc_substrate_teardown import SubstrateDeleteError
    from hushh_mcp.services.pod_files.teardown import reconcile_resource

    email = "one-files-" + "a" * 20 + "@owner-project.iam.gserviceaccount.com"
    identity = {
        "name": "projects/owner-project/serviceAccounts/" + email,
        "email": email,
        "projectId": "owner-project",
        "uniqueId": "123456789",
    }
    observation = {
        "type": "service_account",
        "id": email,
        "disposition": "created",
        "identity": identity,
    }

    def response(status, body):
        return Mock(status_code=status, json=Mock(return_value=body))

    session = Mock()
    session.get.side_effect = [response(200, {**identity, "uniqueId": "987654321"})]
    args = dict(
        token="inert",
        project="owner-project",
        region="us-central1",
        observation=observation,
        state={},
        retain_receipt=lambda *_: True,
        session=session,
    )
    with pytest.raises(SubstrateDeleteError, match="relationship"):
        reconcile_resource(**args)
    session.post.assert_not_called()
    session.delete.assert_not_called()
    assert session.get.call_args.args[0].endswith("/serviceAccounts/123456789")
