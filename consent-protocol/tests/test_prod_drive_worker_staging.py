"""Cold worker staging preserves production controls and exact activation authority."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from tests.helpers.deployment_cli import executable_manifest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "staged_worker", ROOT / "deploy/drive/staged_worker.py"
)
assert SPEC and SPEC.loader
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)
OLD, NEW = WORKER.SERVICE + "-00001-old", WORKER.SERVICE + "-s-12345-1"
IMAGE = "gcr.io/hushh-pda/consent-protocol@sha256:" + "a" * 64
SNAPSHOT = {"schema": "drive.scheduler.prod.snapshot.v1", "jobs": {"sharing": "unchanged"}}


def _revision():
    return {
        "metadata": {
            "name": OLD,
            "uid": "old-uid",
            "creationTimestamp": "2026-10-27T00:00:00Z",
            "labels": {"deploy-sha": "b" * 40},
            "annotations": {
                "autoscaling.knative.dev/maxScale": "2",
                "run.googleapis.com/cloudsql-instances": "hushh-pda:us-central1:hushh-vault-db",
            },
        },
        "spec": {
            "containerConcurrency": 1,
            "timeoutSeconds": 240,
            "serviceAccountName": WORKER.RUNTIME,
            "containers": [
                {
                    "name": "drive-worker",
                    "image": IMAGE,
                    "command": ["gunicorn"],
                    "args": [
                        "server_drive_worker:app",
                        "-w",
                        "1",
                        "-k",
                        "uvicorn.workers.UvicornWorker",
                        "--timeout",
                        "220",
                        "--worker-tmp-dir",
                        "/tmp",  # noqa: S108 - exact reviewed worker launcher contract
                        "-b",
                        "0.0.0.0:8080",
                    ],
                    "startupProbe": {"httpGet": {"path": "/ready", "port": 8080}},
                    "resources": {"limits": {"cpu": "2", "memory": "4Gi"}},
                    "env": [
                        {"name": key, "value": value}
                        for key, value in {
                            "DRIVE_WORK_DRAIN_ENABLED": "true",
                            "DRIVE_WORKER_MODE": "true",
                            "DB_POOL_MIN_SIZE": "0",
                            "DB_POOL_MAX_SIZE": "2",
                            "DB_SQLALCHEMY_POOL_SIZE": "1",
                            "DB_SQLALCHEMY_MAX_OVERFLOW": "0",
                            "PROTECTED_DOCUMENT_DELIVERY_ENABLED": "false",
                        }.items()
                    ],
                },
                {
                    "name": "clamav",
                    "image": "clamav/clamav@" + WORKER.SCANNER_INDEX,
                    "resources": {"limits": {"cpu": "2", "memory": "4Gi"}},
                },
            ],
        },
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }


class Ports:
    def __init__(self):
        old = _revision()
        self.revisions = {OLD: old}
        self.value = {
            "metadata": {
                "name": WORKER.SERVICE,
                "uid": "service-uid",
                "resourceVersion": "1",
                "generation": 1,
                "labels": {"deploy-sha": "b" * 40},
                "annotations": {
                    "run.googleapis.com/ingress": "internal",
                    "run.googleapis.com/custom-audiences": '["https://api.hushh.ai"]',
                    "run.googleapis.com/maxScale": "2",
                },
            },
            "spec": {
                "template": {
                    "metadata": copy.deepcopy(old["metadata"]),
                    "spec": copy.deepcopy(old["spec"]),
                },
                "traffic": [{"revisionName": OLD, "percent": 100}],
            },
            "status": {
                "observedGeneration": 1,
                "traffic": [{"revisionName": OLD, "percent": 100}],
                "url": "https://consent-protocol-drive-worker-abc.a.run.app",
            },
        }
        self.policy = {
            "etag": "policy-1",
            "bindings": [{"role": "roles/run.invoker", "members": ["serviceAccount:scheduler"]}],
        }
        self.jobs = copy.deepcopy(SNAPSHOT)
        self.calls, self.mutations = [], []
        self.scanner = True
        self.config_state = "ENABLED"

    def run(self, command, **_kwargs):
        self.calls.append(command)
        if command[0] == "python3":
            path = Path(command[command.index("--snapshot") + 1])
            if command[2] == "capture":
                path.write_text(json.dumps(self.jobs))
            else:
                assert command[2] == "verify"
                if json.loads(path.read_bytes()) != self.jobs:
                    raise ValueError("scheduler_changed")
            return b""
        args = [item for item in command[1:] if item != "--quiet"]
        if args[:3] == ["run", "services", "replace"]:
            self.replace(Path(args[3]))
            return b"{}"
        result = self.read(args)
        return json.dumps(result).encode()

    def read(self, args):
        if args[:3] == ["run", "services", "describe"]:
            return self.value
        if args[:3] == ["run", "services", "get-iam-policy"]:
            return self.policy
        if args[:3] == ["run", "revisions", "describe"]:
            return self.revisions[args[3]]
        if args[:3] == ["run", "revisions", "list"]:
            return list(self.revisions.values())
        if args[:3] == ["secrets", "versions", "describe"]:
            return {"name": "projects/p/secrets/runtime/versions/7", "state": self.config_state}
        if args[:2] == ["logging", "read"]:
            return (
                [
                    {
                        "resource": {"labels": {"revision_name": NEW}},
                        "textPayload": "drive_worker_startup stage=scanner outcome=ready duration_ms=1",
                    }
                ]
                if self.scanner
                else []
            )
        raise AssertionError(f"Unexpected SDK command: {args[:3]}")

    def replace(self, path):
        resource = json.loads(path.read_bytes())
        assert resource["metadata"]["resourceVersion"] == self.value["metadata"]["resourceVersion"]
        self.mutations.append(resource)
        self.value["spec"] = resource["spec"]
        self.value["metadata"]["generation"] += 1
        self.value["metadata"]["resourceVersion"] = "2"
        self.value["status"]["observedGeneration"] += 1
        template = resource["spec"]["template"]
        metadata = {
            **template["metadata"],
            "uid": "candidate-uid",
            "creationTimestamp": "2026-10-27T00:01:00Z",
        }
        self.revisions[metadata["name"]] = {
            "metadata": metadata,
            "spec": copy.deepcopy(template["spec"]),
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        }


@pytest.fixture
def stage_ports(monkeypatch):
    for key, value in {
        "DEPLOY_SHA": "c" * 40,
        "IMAGE_REFERENCE": IMAGE,
        "RELEASE_RUN_ID": "12345",
        "RELEASE_RUN_ATTEMPT": "1",
        "DRIVE_RUNTIME_CONFIG_SECRET": "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_12345_1",
        "PROTECTED_DOCUMENT_DELIVERY_ENABLED": "true",
    }.items():
        monkeypatch.setenv(key, value)
    ports = Ports()
    monkeypatch.setattr(WORKER, "run", ports.run)
    monkeypatch.setattr(WORKER.time, "sleep", lambda _seconds: None)
    return ports


def _stage(path, monkeypatch):
    WORKER.prepare(path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    monkeypatch.setenv("DRIVE_WORKER_STAGE_INTENT_SHA256", digest)
    WORKER.stage(path)
    return digest


@pytest.mark.parametrize("scheduler_drift", [False, True])
def test_readonly_validation_does_not_create_activation_intent(
    stage_ports, tmp_path, monkeypatch, scheduler_drift
):
    path = tmp_path / "intent.json"
    _stage(path, monkeypatch)
    receipt = json.loads(Path(str(path) + ".staged.json").read_bytes())
    if scheduler_drift:
        stage_ports.jobs["jobs"]["sharing"] = "changed"
        with pytest.raises(ValueError, match="scheduler_changed"):
            WORKER.validate(receipt, Path(str(path) + ".scheduler.json"), allow_retirement=True)
    else:
        WORKER.validate(receipt, Path(str(path) + ".scheduler.json"), allow_retirement=True)
    assert not Path(str(path) + ".activation.json").exists()
    assert len(stage_ports.mutations) == 1


def test_cold_staging_preserves_controls_and_activates_exact_candidate(
    stage_ports, tmp_path, monkeypatch
):
    path = tmp_path / "intent.json"
    before = copy.deepcopy(stage_ports.value)
    digest = _stage(path, monkeypatch)
    staged = json.loads(Path(str(path) + ".staged.json").read_bytes())
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    assert staged["candidate"] == NEW and staged["candidate_uid"] == "candidate-uid"
    assert stage_ports.value["metadata"]["labels"] == before["metadata"]["labels"]
    assert WORKER.controls(stage_ports.value) == WORKER.controls(before)
    assert stage_ports.value["spec"]["traffic"] == before["spec"]["traffic"]
    assert stage_ports.value["status"]["traffic"] == before["status"]["traffic"]
    assert stage_ports.jobs == SNAPSHOT and len(stage_ports.mutations) == 1
    snapshot = tmp_path / "activation-scheduler.json"
    snapshot.write_text(json.dumps(stage_ports.jobs))
    assert WORKER.admission(path, snapshot, prepare_only=True) == NEW
    activation = Path(str(path) + ".activation.json")
    monkeypatch.setenv(
        "DRIVE_WORKER_ACTIVATION_INTENT_SHA256", hashlib.sha256(activation.read_bytes()).hexdigest()
    )
    assert WORKER.admission(path, snapshot, prepare_only=False) == NEW
    assert len(stage_ports.mutations) == 1  # Admission never redeploys or promotes.


@pytest.mark.parametrize(
    "drift", ["ack", "controls", "iam", "scheduler", "latest", "existing", "expiry", "context"]
)
def test_staging_refuses_missing_or_changed_admission_before_mutation(
    stage_ports, tmp_path, monkeypatch, drift
):
    path = tmp_path / "intent.json"
    WORKER.prepare(path)
    monkeypatch.setenv(
        "DRIVE_WORKER_STAGE_INTENT_SHA256", hashlib.sha256(path.read_bytes()).hexdigest()
    )
    if drift == "ack":
        monkeypatch.delenv("DRIVE_WORKER_STAGE_INTENT_SHA256")
    elif drift == "controls":
        stage_ports.value["metadata"]["annotations"]["run.googleapis.com/maxScale"] = "1"
    elif drift == "iam":
        stage_ports.policy["etag"] = "changed"
    elif drift == "scheduler":
        stage_ports.jobs["jobs"]["sharing"] = "changed"
    elif drift == "latest":
        stage_ports.value["spec"]["traffic"][0]["latestRevision"] = True
    elif drift == "existing":
        stage_ports.revisions[NEW] = {"metadata": {"name": NEW}}
    elif drift == "expiry":
        monkeypatch.setattr(WORKER.time, "time", lambda: 10**12)
    else:
        monkeypatch.setenv("RELEASE_RUN_ATTEMPT", "2")
    with pytest.raises(ValueError):
        WORKER.stage(path)
    assert stage_ports.mutations == []


@pytest.mark.parametrize(
    "drift", ["uid", "spec", "config", "scanner", "traffic", "service_uid", "ack"]
)
def test_activation_refuses_stale_or_unhealthy_candidate(stage_ports, tmp_path, monkeypatch, drift):
    path = tmp_path / "intent.json"
    _stage(path, monkeypatch)
    snapshot = tmp_path / "activation-scheduler.json"
    snapshot.write_text(json.dumps(stage_ports.jobs))
    WORKER.admission(path, snapshot, prepare_only=True)
    activation = Path(str(path) + ".activation.json")
    monkeypatch.setenv(
        "DRIVE_WORKER_ACTIVATION_INTENT_SHA256", hashlib.sha256(activation.read_bytes()).hexdigest()
    )
    if drift == "uid":
        stage_ports.revisions[NEW]["metadata"]["uid"] = "different"
    elif drift == "spec":
        stage_ports.revisions[NEW]["spec"]["containers"][0]["env"][0]["value"] = "false"
    elif drift == "config":
        stage_ports.config_state = "DISABLED"
    elif drift == "scanner":
        stage_ports.scanner = False
    elif drift == "traffic":
        stage_ports.value["spec"]["traffic"].append(
            {"revisionName": NEW, "percent": 0, "tag": "new"}
        )
    elif drift == "service_uid":
        stage_ports.value["metadata"]["uid"] = "different"
    else:
        monkeypatch.delenv("DRIVE_WORKER_ACTIVATION_INTENT_SHA256")
    with pytest.raises(ValueError):
        WORKER.admission(path, snapshot, prepare_only=False)
    assert len(stage_ports.mutations) == 1


@pytest.mark.parametrize("bad", ["latest", "pool", "launcher", "public", "missing_policy"])
def test_preparation_rejects_unqualified_existing_service(stage_ports, tmp_path, bad):
    if bad == "latest":
        stage_ports.value["spec"]["traffic"][0]["latestRevision"] = True
    elif bad in {"pool", "launcher"}:
        worker = stage_ports.revisions[OLD]["spec"]["containers"][0]
        if bad == "pool":
            worker["env"][2]["value"] = "1"
        else:
            worker["args"][2] = "2"
        stage_ports.value["spec"]["template"]["spec"] = copy.deepcopy(
            stage_ports.revisions[OLD]["spec"]
        )
    elif bad == "public":
        stage_ports.policy["bindings"][0]["members"] = ["allUsers"]
    else:
        stage_ports.policy = {}
    with pytest.raises(ValueError):
        WORKER.prepare(tmp_path / "intent.json")
    assert stage_ports.mutations == []


FAKE_TOOL = r"""
import fcntl, json, os, sys
from pathlib import Path
args = sys.argv[1:]
tool = Path(sys.argv[0]).name
state_path = Path(os.environ["MOCK_STATE"])
lock = open(str(state_path) + ".lock", "w")
fcntl.flock(lock, fcntl.LOCK_EX)
state = json.loads(state_path.read_text())
state["calls"].append([tool, *args])
def save():
    state_path.write_text(json.dumps(state))
save()
if tool == "python3":
    if args[0].endswith("staged_worker.py"):
        if os.getenv("MOCK_REJECT_ACTIVATION") == "1":
            sys.exit(9)
        print(os.environ["MOCK_CANDIDATE"])
    elif args[0].endswith("work_drain_scheduler_snapshot_prod.py"):
        if args[1] == "capture":
            Path(args[args.index("--snapshot") + 1]).write_text("{}")
    else:
        os.execv(sys.executable, [sys.executable, *args])
elif tool == "bash":
    if args[0].endswith("cloudrun-rollback.sh"):
        state["traffic"] = args[3]
        save()
    elif not args[0].endswith("setup_work_drain_scheduler_prod.sh"):
        sys.exit(80)
elif tool == "gcloud":
    args = [arg for arg in args if arg != "--quiet"]
    if args[:3] == ["run", "services", "list"]:
        print(json.dumps([{"metadata": {"name": "consent-protocol-drive-worker"}}]))
    elif args[:3] == ["run", "services", "describe"]:
        if "--format=value(status.url)" in args:
            print("https://consent-protocol-drive-worker-abc.a.run.app")
        else:
            print(json.dumps({"status": {"traffic": [{"revisionName": state["traffic"], "percent": 100}]}}))
    elif args[:3] == ["run", "services", "add-iam-policy-binding"]:
        pass
    elif args[:3] == ["run", "services", "update-traffic"]:
        state["traffic"] = next(arg.split("=", 1)[1].rsplit("=", 1)[0] for arg in args if arg.startswith("--to-revisions="))
        save()
    elif args[:3] == ["scheduler", "jobs", "run"]:
        if os.getenv("MOCK_FAIL_SCHEDULER") == "1":
            sys.exit(8)
    elif args[:2] == ["logging", "read"]:
        print(json.dumps([{"jsonPayload": {
            "@type": "type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished",
            "jobName": "projects/hushh-pda/locations/us-central1/jobs/drive-work-sharing-prod",
            "url": "https://consent-protocol-drive-worker-abc.a.run.app/api/internal/drive-work/drain",
            "debugInfo": "URL_CRAWLED. Original HTTP response code number = 200"}}]))
    else:
        sys.exit(81)
elif tool != "install":
    sys.exit(82)
"""


@pytest.mark.parametrize("failure", ["", "admission", "scheduler"])
def test_public_activation_reuses_staged_revision_and_existing_rollback(tmp_path, failure):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    for name in ("python3", "gcloud", "bash", "install"):
        executable = fake_bin / name
        executable.write_text(f"#!{sys.executable}\n" + FAKE_TOOL)
        executable.chmod(0o755)
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({"calls": [], "traffic": OLD}))
    environment = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "MOCK_STATE": str(state_path),
        "MOCK_CANDIDATE": NEW,
        "IMAGE_REFERENCE": IMAGE,
        "DEPLOY_SHA": "c" * 40,
        "RUNTIME_SERVICE_ACCOUNT": WORKER.RUNTIME,
        "CLOUDSQL_INSTANCE": "hushh-pda:us-central1:hushh-vault-db",
        "RELEASE_RUN_ID": "12345",
        "RELEASE_RUN_ATTEMPT": "1",
        "DRIVE_RUNTIME_CONFIG_SECRET": "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_12345_1",
        "GCP_PROJECT_ID": "hushh-pda",
        "PROTECTED_DOCUMENT_MAINTENANCE": "true",
        "ENABLE_PRODUCTION_DRIVE_LIVE": "false",
        "DRIVE_WORKER_RELEASE_PHASE": "activate",
        "DRIVE_WORKER_STAGE_RECEIPT": str(tmp_path / "intent.json"),
        "MOCK_REJECT_ACTIVATION": "1" if failure == "admission" else "0",
        "MOCK_FAIL_SCHEDULER": "1" if failure == "scheduler" else "0",
        "GITHUB_OUTPUT": str(tmp_path / "output"),
    }
    result = subprocess.run(
        ["/bin/bash", "deploy/drive/deploy_worker_service_prod.sh"],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert (result.returncode == 0) is (not failure), result.stdout + result.stderr
    state = json.loads(state_path.read_bytes())
    assert state["traffic"] == (OLD if failure else NEW)
    calls = state["calls"]
    assert not any(call[0] == "gcloud" and "deploy" in call for call in calls)
    assert not any(call[0] == "gcloud" and "secrets" in call for call in calls)
    promotions = [call for call in calls if "update-traffic" in call]
    assert len(promotions) == (0 if failure == "admission" else 1)
    if failure == "scheduler":
        assert any(call[0] == "python3" and "restore" in call for call in calls)
        assert any(call[0] == "bash" and call[1].endswith("cloudrun-rollback.sh") for call in calls)


@pytest.mark.parametrize("auth_failure", [False, True])
def test_recurring_worker_inspects_with_registry_auth_or_stops(tmp_path, auth_failure):
    bash = shutil.which("bash")
    assert bash is not None
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = workflow["jobs"]["stage-drive-worker"]["steps"]
    body = next(
        step["run"]
        for step in steps
        if step.get("name") == "Pin accepted image for recurring worker release"
    )
    manifest, digest = executable_manifest()
    (tmp_path / "worker-stage").mkdir()
    guards = (
        'registry_authenticated=0; gcloud() { case "$1 $2" in '
        "'container images') return 0 ;; "
        f"'auth configure-docker') {'return 7' if auth_failure else 'registry_authenticated=1'} ;; "
        "*) return 95 ;; esac; };\n"
        'docker() { [ "$registry_authenticated" = 1 ] || return 19; '
        f"printf '%s' '{manifest}'; }};\n"
        f"python3() {{ '{Path(sys.executable).as_posix()}' \"$@\"; }};\n"
    )
    environment = {
        **os.environ,
        "RUNNER_TEMP": tmp_path.as_posix(),
        "IMAGE_REFERENCE": "gcr.io/hushh-pda/consent-protocol@" + digest,
        "DEPLOY_SHA": "f" * 40,
    }
    environment.pop("BASH_ENV", None)
    result = subprocess.run(  # noqa: S603 - authored workflow with guarded registry commands
        [bash, "-c", guards + body],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == (7 if auth_failure else 0), result.stderr
    evidence = tmp_path / "worker-stage/image.json"
    assert evidence.exists() is (not auth_failure)
    if not auth_failure:
        assert json.loads(evidence.read_text())["image_reference"] == environment["IMAGE_REFERENCE"]
