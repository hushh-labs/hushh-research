"""Core fixture service, credential, recovery and hosted-history boundaries.

All cloud/GitHub ports below are synthetic; these are not provider acceptance.
"""

import base64
import copy
import json
import sys
import time
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "deploy/plg"), str(ROOT / "consent-protocol/tests")]
import frontend_fixture_acceptance as accepted  # noqa: E402
import frontend_fixture_candidate as candidate  # noqa: E402
import frontend_fixture_history as history  # noqa: E402
import frontend_fixture_iam as iam  # noqa: E402
import frontend_fixture_producer as producer  # noqa: E402
import frontend_fixture_runtime as runtime  # noqa: E402
import frontend_release as release  # noqa: E402
import test_plg_frontend_secret_pins as secrets  # noqa: E402


def document(environment="dev", run_id="123"):
    attempt = release.Attempt(environment, "a" * 40, run_id, "1")
    config = {
        "kind": "plg-frontend-fixture-runtime-input-v1",
        "configuration": {
            "frontendRevision": runtime.names(attempt)["revision"],
            "project": attempt.project,
        },
    }
    return runtime.service_document(
        attempt,
        f"gcr.io/{attempt.project}/hushh-webapp@sha256:" + "b" * 64,
        secrets.inventory(environment, fixture_backend=True),
        config,
    )


class Native:
    def __init__(self):
        self.project = "hushh-pda-dev"
        self.value = None
        self.revisions = {}
        self.calls = []
        self.number = 0

    def service(self, *, missing=False):
        assert missing or self.value is not None
        return copy.deepcopy(self.value)

    def revision(self, name, *, missing=False):
        assert missing or name in self.revisions
        return copy.deepcopy(self.revisions.get(name))

    def policy(self):
        return {"bindings": []}

    def request(self, method, path, value):
        self.calls.append((method, path))
        if self.value is not None:
            assert method == "PUT"
            if (
                value["metadata"].get("resourceVersion")
                != self.value["metadata"]["resourceVersion"]
            ):
                raise release.Refused("synthetic native stale RV conflict")
        else:
            assert method == "POST"
        self.number += 1
        self.value = copy.deepcopy(value)
        self.value["metadata"].update(
            uid="physical-service-uid", resourceVersion=str(self.number), generation=self.number
        )
        template = self.value["spec"]["template"]
        name = template["metadata"]["name"]
        if name not in self.revisions:
            revision = {
                "metadata": copy.deepcopy(template["metadata"]),
                "spec": copy.deepcopy(template["spec"]),
            }
            revision["metadata"].update(uid="physical-revision-" + str(self.number))
            revision["metadata"]["labels"]["serving.knative.dev/service"] = runtime.SERVICE
            revision["spec"]["containers"][0]["resources"]["limits"]["cpu"] = "1000m"
            revision["spec"]["containers"][0]["ports"][0]["name"] = "http1"
            revision["status"] = {
                "conditions": [{"type": "Ready", "status": "True"}],
                "imageDigest": template["spec"]["containers"][0]["image"],
            }
            self.revisions[name] = revision
        routes = []
        for row in self.value["spec"]["traffic"]:
            actual = {key: value for key, value in row.items() if key != "latestRevision"}
            actual["revisionName"] = row.get("revisionName", name)
            if row.get("tag"):
                actual["url"] = (
                    "https://" + row["tag"] + "---" + runtime.SERVICE + "-fixed-uc.a.run.app"
                )
            routes.append(actual)
        self.value["status"] = {
            "observedGeneration": self.number,
            "conditions": [{"type": "Ready", "status": "True"}],
            "traffic": routes,
            "url": "https://" + runtime.SERVICE + "-fixed-uc.a.run.app",
        }
        return self.service()


def test_fixed_private_service_has_two_guarded_writes_and_exact_runtime_readback():
    cloud, desired = Native(), document()
    checkpoints = []
    observed = candidate.stage(cloud, desired, checkpoint=checkpoints.append, previous=None)
    assert [method for method, _path in cloud.calls] == ["POST", "PUT"]
    assert observed["serviceUid"] == "physical-service-uid"
    assert len(checkpoints) == 2
    assert candidate.observe(cloud, desired) == observed
    tampered = copy.deepcopy(desired)
    tampered["spec"]["template"]["spec"]["containers"][0]["env"].append(
        {"name": "UNREVIEWED", "value": "true"}
    )
    with pytest.raises(release.Refused):
        candidate.observe(cloud, tampered)
    cloud.revisions[observed["revision"]]["metadata"]["annotations"][
        "run.googleapis.com/secrets"
    ] = "unexpected-cross-project-alias"
    with pytest.raises(release.Refused, match="alias"):
        candidate.observe(cloud, desired)


def test_interruption_after_template_can_finish_only_the_known_route_without_recreating_revision():
    cloud, desired = Native(), document()

    def interrupted(value):
        if value["status"] == "fixture-route-needs-reconciliation":
            raise RuntimeError("synthetic runner cancellation")

    with pytest.raises(RuntimeError):
        candidate.stage(cloud, desired, checkpoint=interrupted, previous=None)
    assert len(cloud.calls) == 1
    intent = {"serviceDocument": desired, "beforeTraffic": None}
    candidate.partial_owned(cloud.service(), intent)
    changed = cloud.service()
    changed["status"]["traffic"][0]["tag"] = "foreign"
    with pytest.raises(release.Refused):
        candidate.partial_owned(changed, intent)
    candidate.finish_route(cloud, desired, cloud.service(), checkpoint=lambda _value: None)
    assert len(cloud.revisions) == 1 and len(cloud.calls) == 2
    candidate.observe(cloud, desired)


def test_recovery_preserves_original_provider_resource_version_and_refuses_service_replacement():
    cloud, desired = Native(), document()
    candidate.stage(cloud, desired, checkpoint=lambda _value: None, previous=None)
    before = cloud.service()
    cloud.value["metadata"]["resourceVersion"] = "unexpected-new-version"
    calls = len(cloud.calls)
    with pytest.raises(release.Refused, match="state changed"):
        candidate.finish_route(cloud, desired, before, checkpoint=lambda _value: None)
    assert len(cloud.calls) == calls
    with pytest.raises(release.Refused, match="UID changed"):
        candidate.continuity(cloud.service(), {"previous": {"uid": "replaced-service"}})


def test_private_policy_drift_before_route_cas_prevents_the_write():
    cloud, desired = Native(), document()
    candidate.stage(cloud, desired, checkpoint=lambda _value: None, previous=None)
    count, reads = len(cloud.calls), []

    def policy():
        reads.append(1)
        return (
            {"bindings": []}
            if len(reads) == 1
            else {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]}
        )

    cloud.policy = policy
    with pytest.raises(release.Refused, match="IAM changed"):
        candidate.finish_route(cloud, desired, cloud.service(), checkpoint=lambda _value: None)
    assert len(cloud.calls) == count


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_actual_workflow_decoded_commands_use_correct_environment_and_single_uat_predecessor_command(
    environment,
):
    value = yaml.safe_load((ROOT / release.WORKFLOWS[environment]).read_bytes())
    assert value["concurrency"]["group"] == "deploy-" + environment
    assert not value["concurrency"]["cancel-in-progress"]
    steps = value["jobs"]["fixture"]["steps"]
    for step in steps:
        if "frontend_fixture_producer.py" not in step.get("run", ""):
            continue
        assert "--environment " + environment in step["run"].replace("\\\n", " ")
        if environment == "uat" and " prepare " in step["run"]:
            assert '--dev-run "$DEV_FIXTURE_RUN"' in step["run"]
            assert not any(
                line.strip().startswith("--dev-run") for line in step["run"].splitlines()
            )
    assert [row["name"] for row in steps].index(accepted.STAGE_UPLOAD) < [
        row["name"] for row in steps
    ].index(accepted.STAGE_STEP)


def test_queued_rerun_does_not_hide_earlier_interrupted_stage(monkeypatch):
    run = {
        "id": 21,
        "run_attempt": 2,
        "head_sha": "a" * 40,
        "head_branch": "main",
        "path": release.WORKFLOWS["dev"],
        "event": "workflow_dispatch",
        "status": "queued",
        "repository": {"id": accepted.hosted.REPOSITORY_ID},
        "head_repository": {"id": accepted.hosted.REPOSITORY_ID},
        "actor": {"login": "DamriaNeelesh"},
        "triggering_actor": {"login": "DamriaNeelesh"},
    }
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    monkeypatch.setenv("GITHUB_RUN_ID", "99")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    monkeypatch.setattr(history, "_list", lambda *_args: [run])
    monkeypatch.setattr(accepted.hosted, "_reviewed_authority", lambda *_args: None)
    inspected = []

    def read(_client, path):
        if path == "runs/21":
            return run
        if path.endswith("attempts/1"):
            return {
                "id": 21,
                "head_sha": "a" * 40,
                "status": "completed",
                "conclusion": "cancelled",
                "run_attempt": 1,
            }
        pytest.fail("Must inspect prior stage before skipping queued rerun")

    def jobs(*_args):
        inspected.append(1)
        raise release.Refused("Earlier stage requires reconciliation")

    monkeypatch.setattr(accepted, "fresh", read)
    monkeypatch.setattr(history, "_jobs", jobs)
    with pytest.raises(release.Refused, match="Earlier stage"):
        history.check("dev", github=object(), native=Native())
    assert inspected == [1]


def test_probe_scope_uses_invalid_owner_only_and_rejects_cloud_ingress_denial_as_backend_proof():
    def token(audience):
        return (
            "x."
            + base64.urlsafe_b64encode(
                json.dumps(
                    {
                        "aud": audience,
                        "exp": int(time.time()) + 600,
                        "iss": "https://accounts.google.com",
                    }
                ).encode()
            )
            .decode()
            .rstrip("=")
            + ".x"
        )

    observation = {
        "serviceUrl": "https://fixture.run.app",
        "candidateUrl": "https://tag---fixture.run.app",
    }
    pair = {
        "serviceUrl": "https://backend.run.app",
        "candidateUrl": "https://tag---backend.run.app",
    }

    class Http:
        wrong = False

        def request(self, _url, *, token=None, method="GET", owner=False):
            if not token:
                return 403, {}, b""
            assert owner and method in {"GET", "PUT"}
            return (
                (403 if self.wrong else 401),
                {"Cache-Control": "private, no-store", "Pragma": "no-cache"},
                b'{"detail":"invalid owner"}',
            )

    http = Http()
    proof = candidate.probes(
        observation, pair, token(observation["serviceUrl"]), token(pair["serviceUrl"]), http=http
    )
    assert (
        proof["privateIngress"]
        and not proof["positiveOwnerPreferenceVerified"]
        and not proof["customerSendingVerified"]
    )
    http.wrong = True
    with pytest.raises(release.Refused):
        candidate.probes(
            observation,
            pair,
            token(observation["serviceUrl"]),
            token(pair["serviceUrl"]),
            http=http,
        )


def test_frontend_runtime_allow_policy_is_minimal_and_extra_project_authority_refuses():
    attempt = release.Attempt("dev", "a" * 40, "123", "1")
    principal = runtime.iam_plan(attempt)["principal"]
    member = "serviceAccount:" + principal

    class Cloud:
        extra = False

        def _read(self, *_args):
            return {"email": principal, "disabled": False}

        def ancestry(self):
            return ["projects/123"]

        def hierarchy_policy(self, _resource):
            return {
                "bindings": [{"role": "roles/viewer", "members": [member]}] if self.extra else []
            }

        def service_policy(self):
            return {
                "bindings": [
                    {"role": role, "members": [member]}
                    for role in ("roles/run.invoker", "projects/hushh-pda-dev/roles/fixtureRead")
                ]
            }

        def role(self, name):
            return {
                "name": name,
                "includedPermissions": ["run.routes.invoke", "run.jobs.run"]
                if name == "roles/run.invoker"
                else ["run.services.get", "run.revisions.get"],
            }

        def secrets(self):
            return [
                {
                    "name": "projects/123/secrets/PLG_QUALIFICATION_FRONTEND_BACKEND_URL",
                    "labels": iam.Target("dev").labels,
                }
            ]

        def secret_policy(self, _name):
            return {
                "bindings": [{"role": "roles/secretmanager.secretAccessor", "members": [member]}]
            }

    cloud = Cloud()
    proof = iam.verify(attempt, cloud=cloud)
    assert not proof["effectiveAccessClaimed"]
    assert proof["backendPermissions"] == [
        "run.revisions.get",
        "run.routes.invoke",
        "run.services.get",
    ]
    cloud.extra = True
    with pytest.raises(ValueError):
        iam.verify(attempt, cloud=cloud)


def test_typed_hosted_acceptance_refuses_scope_inflation_or_reused_service_uid_change(monkeypatch):
    native, desired = Native(), document()
    observed = candidate.stage(native, desired, checkpoint=lambda _value: None, previous=None)
    run = {"id": 123, "run_attempt": 1, "head_sha": "a" * 40, "updated_at": "fixed"}
    source = {"runId": 42}
    backend_pin = {"runId": 55}
    intent = {
        "serviceDocument": desired,
        "previous": None,
        "buildEvidence": {"imageReference": observed["imageReference"]},
        "prepared": {"sourceValidation": source, "backendPair": {"acceptance": backend_pin}},
    }
    stage = {"artifactId": 10, "artifactDigest": "sha256:" + "a" * 64, "document": intent}
    checks = {
        "kind": "plg-fixture-negative-owner-proxy-checks-v1",
        "privateIngress": True,
        "positiveOwnerPreferenceVerified": False,
        "customerSendingVerified": False,
        "preferences": {
            method: {"status": 401, "responseMatchesPrivateBackend": True, "noStore": True}
            for method in ("GET", "PUT")
        },
    }
    receipt = {
        "kind": accepted.KIND,
        "stageIntent": {key: stage[key] for key in ("artifactId", "artifactDigest")},
        "candidate": observed,
        "checks": checks,
        "predecessor": None,
        "customerSendingVerified": False,
        "productionTrafficAuthorized": False,
    }
    monkeypatch.setattr(accepted, "completed", lambda *_args, **_kwargs: (run, {}))
    monkeypatch.setattr(accepted, "stage_intent", lambda *_args, **_kwargs: stage)
    monkeypatch.setattr(
        accepted, "artifact", lambda *_args: ({"id": 11, "digest": "sha256:" + "b" * 64}, receipt)
    )
    monkeypatch.setattr(accepted, "verify_build", lambda *_args: None)
    monkeypatch.setattr(
        accepted.release.frontend_validation, "verify", lambda *_args, **_kwargs: source
    )
    import qualification_acceptance

    class Backend:
        def pin(self):
            return backend_pin

    monkeypatch.setattr(qualification_acceptance, "verify", lambda *_args, **_kwargs: Backend())

    class GitHub:
        def read(self, _path):
            return run

    pin = accepted.verify("dev", 123, github=GitHub()).pin()
    assert pin["runId"] == 123 and not pin["positiveOwnerPreferenceVerified"]
    checks["positiveOwnerPreferenceVerified"] = True
    with pytest.raises(ValueError):
        accepted.verify("dev", 123, github=GitHub())
    checks["positiveOwnerPreferenceVerified"] = False
    intent["previous"] = {"uid": "old-physical-service"}
    with pytest.raises(ValueError, match="UID changed"):
        accepted.verify("dev", 123, github=GitHub())


@pytest.mark.parametrize("requested", [False, True])
def test_source_request_state_distinguishes_preflight_failure_from_uncertain_provider_call(
    monkeypatch, tmp_path, requested
):
    attempt = release.Attempt("dev", "a" * 40, "123", "1")
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.delenv("PLG_QUALIFICATION_ID_TOKEN", raising=False)
    monkeypatch.delenv("PLG_FIXTURE_FRONTEND_ID_TOKEN", raising=False)
    monkeypatch.setattr(sys, "argv", ["fixture", "build", "--environment", "dev"])
    monkeypatch.setattr(producer.preflight, "context", lambda _environment: attempt)
    folder = producer.folder_for(attempt)
    folder.mkdir()

    def execute(*_args):
        if requested:
            producer.requesting()
        raise release.Refused("synthetic phase failure")

    monkeypatch.setattr(producer, "execute", execute)
    with pytest.raises(release.Refused):
        producer.main()
    state = json.loads((folder / "build-request-state.json").read_bytes())
    assert state["providerRequestAttempted"] is requested
    assert state["producer"] == {"runId": 123, "attempt": 1, "workflowSha": "a" * 40}


def test_request_state_cannot_clear_missing_uncertain_or_contradictory_publication(monkeypatch):
    run = {"id": 21, "run_attempt": 1, "head_sha": "a" * 40}
    job = {
        "steps": [
            {"name": accepted.BUILD_STEP, "conclusion": "failure"},
            {
                "name": "Publish fixture build request state",
                "status": "completed",
                "conclusion": "success",
            },
        ]
    }
    name = "plg-fixture-build-request-state-dev-21-1"
    listing = {"total_count": 1, "artifacts": [{"name": name}]}
    state = {
        "kind": "plg-fixture-provider-request-state-v1",
        "environment": "dev",
        "producer": {"runId": 21, "attempt": 1, "workflowSha": "a" * 40},
        "phase": "build",
        "providerRequestAttempted": False,
        "productionTrafficAuthorized": False,
    }
    monkeypatch.setattr(accepted, "fresh", lambda *_args: listing)
    monkeypatch.setattr(accepted, "artifact", lambda *_args: ({}, state))
    assert history.never_requested(object(), run, job, "dev", "build", accepted.BUILD_STEP)
    state["providerRequestAttempted"] = True
    assert not history.never_requested(object(), run, job, "dev", "build", accepted.BUILD_STEP)
    state["providerRequestAttempted"] = False
    job["steps"][0]["conclusion"] = "success"
    with pytest.raises(release.Refused):
        history.never_requested(object(), run, job, "dev", "build", accepted.BUILD_STEP)
    listing.update(total_count=0, artifacts=[])
    assert not history.never_requested(object(), run, job, "dev", "build", accepted.BUILD_STEP)
