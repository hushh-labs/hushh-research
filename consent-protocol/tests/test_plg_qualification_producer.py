"""Interrupted privileged stages must recover before another admission."""

import copy
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_pre_runtime_admission_cli_imports_without_site_packages(tmp_path):
    import os
    import subprocess
    import sys

    environment = {"PATH": os.environ.get("PATH", "")}
    if "SYSTEMROOT" in os.environ:
        environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    command = [sys.executable, "-S", str(ROOT / "deploy/plg/qualification_producer.py")]
    help_result = subprocess.run(  # noqa: S603 -- Real fixed CLI in an isolated, credential-free environment.
        [*command, "--help"], env=environment, capture_output=True, text=True, timeout=15
    )
    assert help_result.returncode == 0, help_result.stderr
    assert "--source-validation-run" in help_result.stdout
    admission = subprocess.run(  # noqa: S603 -- Invalid hosted context must refuse before any operation.
        [
            *command,
            "--phase",
            "require",
            "--environment",
            "dev",
            "--folder",
            str(tmp_path / "absent"),
        ],
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert admission.returncode == 1
    assert "qualification_stage_unverified" in admission.stderr
    assert "ModuleNotFoundError" not in admission.stderr
    assert not (tmp_path / "absent").exists()


@pytest.fixture
def modules(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/plg"))
    return SimpleNamespace(
        producer=importlib.import_module("qualification_producer"),
        owner=importlib.import_module("qualification_membership"),
        executor=importlib.import_module("qualification_schema_executor"),
        target=importlib.import_module("qualification_target").Target("dev"),
    )


class Cursor:
    def __init__(self, roles, events):
        self.roles, self.events = roles, events

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement):
        text = str(statement)
        if text.startswith("SELECT pg_"):
            self.events.append("unlock" if "unlock" in text else "lock")
            return
        verb = "GRANT" if "SQL('GRANT " in text else "REVOKE"
        role = next(role for role in self.roles if f"Identifier('{role}')" in text)
        self.events.append((verb, role))
        self.roles[role] = [(False, True)] if verb == "GRANT" else []

    def fetchone(self):
        return (True,)


class Connection:
    def __init__(self, roles, events):
        self.roles, self.events = roles, events

    def cursor(self):
        return Cursor(self.roles, self.events)


class Journal:
    def __init__(self, record, events):
        self.record, self.events = record, events
        self.changed = False

    def read(self):
        self.events.append("journal-read")
        return copy.deepcopy(self.record)

    def create(self, body):
        assert self.record is None
        self.events.append("journal-create")
        self.record = ("12", copy.deepcopy(body))
        return copy.deepcopy(self.record)

    def delete(self, record):
        assert record == self.record
        self.events.append("journal-delete")
        self.record = None


def body(modules):
    return modules.owner.subject(modules.target, "postgres") | {
        "runId": "15",
        "runAttempt": "1",
        "workflowSha": "a" * 40,
    }


def enter(modules, roles, events, journal, *, needed=False):
    return modules.owner.temporary_owners(
        Connection(roles, events),
        modules.target,
        "postgres",
        needed=needed,
        boundary=lambda *_args: events.append("boundary"),
        membership=lambda _cursor, role: copy.deepcopy(roles[role]),
        journal=journal,
    )


@pytest.mark.parametrize("granted", [0, 1, 2])
def test_runner_loss_journal_restores_each_partial_grant_before_preflight(modules, granted):
    events = []
    roles = {
        role: [(False, True)] if index < granted else []
        for index, role in enumerate(modules.owner.ROLES)
    }
    journal = Journal(("11", body(modules)), events)
    with enter(modules, roles, events, journal):
        assert all(value == [] for value in roles.values())
        assert journal.record is None
        assert events.index("lock") < events.index("journal-read")
    assert events[-1] == "unlock"
    assert events.index("journal-delete") > max(
        [events.index(event) for event in events if isinstance(event, tuple)] or [0]
    )


def test_normal_exception_restores_roles_then_deletes_durable_intent(modules, monkeypatch):
    for name, value in (
        ("GITHUB_RUN_ID", "16"),
        ("GITHUB_RUN_ATTEMPT", "2"),
        ("GITHUB_SHA", "b" * 40),
    ):
        monkeypatch.setenv(name, value)
    events, roles = [], dict.fromkeys(modules.owner.ROLES, [])
    journal = Journal(None, events)
    with pytest.raises(RuntimeError, match="synthetic-stage-failure"):
        with enter(modules, roles, events, journal, needed=True):
            assert all(value == [(False, True)] for value in roles.values())
            raise RuntimeError("synthetic-stage-failure")
    assert all(value == [] for value in roles.values())
    assert journal.record is None
    assert events.index("journal-create") < next(
        i for i, event in enumerate(events) if isinstance(event, tuple)
    )
    assert events[-2:] == ["journal-delete", "unlock"]


@pytest.mark.parametrize("field", ["administrator", "sourceSha", "systemIdentifier"])
def test_wrong_subject_intent_cannot_revoke_another_membership(modules, field):
    events, roles = [], dict.fromkeys(modules.owner.ROLES, [(False, True)])
    record = body(modules)
    record[field] = "wrong-subject"
    journal = Journal(("11", record), events)
    with pytest.raises(ValueError, match="wrong_subject"):
        with enter(modules, roles, events, journal):
            pytest.fail("Wrong subject was admitted")
    assert not any(isinstance(event, tuple) for event in events)
    assert journal.record is not None


def test_membership_without_owned_intent_is_never_adopted(modules):
    events, roles = [], dict.fromkeys(modules.owner.ROLES, [(False, True)])
    with pytest.raises(ValueError, match="without_owned_intent"):
        with enter(modules, roles, events, Journal(None, events)):
            pytest.fail("Orphan without intent was admitted")
    assert not any(isinstance(event, tuple) for event in events)


def test_generation_drift_refuses_recovery_before_mutation(modules):
    events, roles = [], dict.fromkeys(modules.owner.ROLES, [(False, True)])
    journal = Journal(("11", body(modules)), events)
    original = journal.read
    count = 0

    def changed():
        nonlocal count
        count += 1
        value = original()
        return ("12", value[1]) if count == 2 else value

    journal.read = changed
    with pytest.raises(ValueError, match="journal_changed"):
        with enter(modules, roles, events, journal):
            pytest.fail("Changed journal was admitted")
    assert not any(isinstance(event, tuple) for event in events)


def test_checkpoint_collision_refuses_blind_stage_replay(modules, tmp_path):
    modules.producer.write(tmp_path, "deploy-intent", {"status": "requested"})
    with pytest.raises(FileExistsError):
        modules.producer.write(tmp_path, "deploy-intent", {"status": "requested"})
    assert json.loads((tmp_path / "deploy-intent.json").read_bytes()) == {"status": "requested"}


def test_capacity_failure_reports_only_allowlisted_reason(modules, monkeypatch, tmp_path):
    producer = modules.producer
    result = SimpleNamespace(
        returncode=2,
        stdout=b"",
        stderr=b"capacity budget blocked: unresolved non-target volume routing\n",
    )
    monkeypatch.setattr(producer.subprocess, "run", lambda *_a, **_kw: result)
    with pytest.raises(ValueError, match="qualification_capacity_volume_unresolved"):
        producer.capacity(tmp_path, {"environment": "dev"}, early=True)
    result.stderr = b"secret-value-must-never-appear"
    with pytest.raises(ValueError, match="qualification_actual_capacity_not_admitted") as exc:
        producer.capacity(tmp_path, {"environment": "dev"}, early=True)
    assert "secret-value" not in str(exc.value)


def test_secret_alias_change_never_returns_payload(modules):
    class Cloud:
        target, project_number = modules.target, "12345"
        metadata = 0

        def request(self, _api, path):
            resource = "projects/hushh-pda-dev/secrets/DB_PASSWORD/versions/1"
            if path.endswith(":access"):
                return {"name": resource, "payload": {"data": "c3ludGhldGljLW9ubHk="}}
            self.metadata += 1
            return {
                "state": "ENABLED",
                "name": resource if self.metadata == 1 else resource[:-1] + "2",
            }

    with pytest.raises(ValueError, match="alias_changed"):
        modules.executor.read_secret(Cloud(), "DB_PASSWORD")


def test_administrator_material_restores_prior_environment_on_failure(modules, monkeypatch):
    monkeypatch.setenv("PLG_QUALIFICATION_ADMIN_USER", "prior-user")
    monkeypatch.delenv("PLG_QUALIFICATION_ADMIN_PASSWORD", raising=False)
    with pytest.raises(RuntimeError):
        with modules.executor.administrator_environment("synthetic-admin", "synthetic-password"):
            raise RuntimeError("synthetic-stage-failure")
    import os

    assert os.environ["PLG_QUALIFICATION_ADMIN_USER"] == "prior-user"
    assert "PLG_QUALIFICATION_ADMIN_PASSWORD" not in os.environ


def test_acceptance_emits_post_health_schema_not_initial_proof(modules, monkeypatch, tmp_path):
    from tests.helpers.plg_qualification import HostedAcceptance

    hosted = HostedAcceptance(monkeypatch)
    monkeypatch.setattr(modules.producer.validation, "verify", lambda *_args: hosted.source)
    initial = hosted.receipts["dev"]
    final = initial["schema"] | {"observedAt": "2026-10-28T01:45:00Z"}
    for key in ("source", "predecessor"):
        modules.producer.write(tmp_path, key, hosted.source if key == "source" else {"pin": None})
    for key in ("image", "schema", "iam", "capacity", "candidate", "health"):
        modules.producer.write(tmp_path, key, initial[key])
    modules.producer.write(tmp_path, "schema-final", final)
    modules.producer.record(
        tmp_path,
        {
            "environment": "dev",
            "sourceValidationRun": 31,
            "devRun": 0,
            "runId": 17,
            "runAttempt": 1,
            "workflowSha": "c" * 40,
        },
    )
    receipt = modules.producer.load(tmp_path, "acceptance")
    assert receipt["schema"] == final
    assert receipt["schema"] != initial["schema"]


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_retired_isolated_lane_leaves_standard_release_gates_intact(environment):
    import yaml

    document = yaml.safe_load((ROOT / f".github/workflows/deploy-{environment}.yml").read_text())
    assert "plg-isolated" not in document["jobs"]
    trigger = document.get("on", document.get(True))["workflow_dispatch"]["inputs"]
    assert "plg-isolated-qualification" not in trigger["target"]["options"]
    assert not {"plg_source_validation_run", "plg_schema_action", "plg_dev_run"} & trigger.keys()
    entry = document["jobs"]["deploy" if environment == "dev" else "select-target"]
    if environment == "dev":
        assert entry["if"] == "inputs.target != 'pod-publication'"
        assert "pod-publication" in trigger["target"]["options"]
    else:
        assert "inputs.target" not in entry.get("if", "")
    steps = document["jobs"]["deploy"]["steps"]
    names = {step.get("name") for step in steps}
    assert {
        "Validate deployment SHA in protected Dev history"
        if environment == "dev"
        else "Validate deployment SHA in selected protected history",
        f"Produce exact-SHA {environment.upper() if environment == 'uat' else 'dev'} acceptance",
        "Post-deploy dev schema contract gate"
        if environment == "dev"
        else "Post-deploy UAT schema contract gate",
    } <= names
    assert not any(
        "qualification_producer.py" in step.get("run", "")
        for job in document["jobs"].values()
        for step in job.get("steps", [])
    )


@pytest.mark.parametrize("target,expected", [("shared-uat", 0), ("plg-isolated-qualification", 1)])
def test_retired_uat_target_cannot_fall_through_to_a_shared_release(target, expected):
    import os
    import shutil
    import subprocess

    import yaml

    document = yaml.safe_load((ROOT / ".github/workflows/deploy-uat.yml").read_text())
    guard = document["jobs"]["select-target"]["steps"][0]
    assert guard["name"] == "Assert manual dispatch originates from main"
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "GITHUB_REF_NAME": "main",
        "REQUESTED_TARGET": target,
    }
    if "SYSTEMROOT" in os.environ:
        environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    result = subprocess.run(  # noqa: S603 - actual pre-credential guard with fixed synthetic targets.
        [shutil.which("bash"), "--noprofile", "--norc", "-c", guard["run"]],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == expected, result.stderr
    assert guard.get("env", {}).get("REQUESTED_TARGET") == "${{ inputs.target || 'shared-uat' }}"
