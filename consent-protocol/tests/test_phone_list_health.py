# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Protected phone-list health and opt-in serving-process observations."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

pytestmark = pytest.mark.feature_auth_reliability


def load_ops_module(filename):
    path = Path(__file__).resolve().parents[2] / "scripts/ops" / filename
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_phone_health_checker(monkeypatch, tmp_path):
    module = load_ops_module("verify_secret_list_invariants.py")
    config = tmp_path / "protected.json"
    config.write_text(
        json.dumps(
            {
                "secrets": [
                    {
                        "name": "HUSHH_UAT_PHONE_TEST_NUMBERS",
                        "project": "hushh-pda-uat",
                        "min_entries": 2,
                        "max_shrink": 0,
                    }
                ]
            }
        )
    )
    monkeypatch.setattr(module, "CONFIG", config)
    monkeypatch.setattr(sys, "argv", ["verify", "--project", "hushh-pda-uat", "--publish-health"])
    monkeypatch.setattr(module, "versions", lambda *args: ["2", "1"])
    writes = []
    monkeypatch.setattr(module, "gcloud", lambda args: writes.append(args) or (0, ""))
    return module, writes


def phone_service(origin="https://consent-protocol-fixture-uc.a.run.app"):
    return {
        "metadata": {"name": "consent-protocol"},
        "status": {
            "url": origin,
            "traffic": [{"revisionName": "consent-protocol-00001-abc", "percent": 100}],
        },
    }


def install_phone_ports(monkeypatch, module, writes, response):
    def cloud(args):
        if args[:3] == ["run", "services", "describe"]:
            assert "consent-protocol" in args and "--project=hushh-pda-uat" in args
            assert "--region=us-central1" in args
            return 0, json.dumps(phone_service())
        writes.append(args)
        return 0, ""

    def http(command, **kwargs):
        assert command[0:2] == ["curl", "--disable"]
        assert "--location" not in command and "--user" not in command
        assert command[-1] == "https://consent-protocol-fixture-uc.a.run.app/health/ready"
        assert command[command.index("--max-time") + 1] == "10"
        assert command[command.index("--max-filesize") + 1] == "16384"
        assert command[command.index("--max-redirs") + 1] == "0"
        assert kwargs["timeout"] == 15
        return SimpleNamespace(returncode=0, stdout=response)

    monkeypatch.setattr(module, "gcloud", cloud)
    monkeypatch.setattr(module.subprocess, "run", http)


RUNTIME_HTTP_RESPONSES = [
    b'{"status":"ready","checks":{"phone_test_transport":"healthy"}}\n200',
    b'{"status":"ready","checks":{"phone_test_transport":"unavailable"}}\n200',
    b'{"checks":{}}\n200',
    b'{"status":"not_ready","checks":{"phone_test_transport":"healthy"}}\n200',
    b'{"checks":{"phone_test_transport":"healthy"}}\n200',
    b'{"status":"ready","checks":{"phone_test_transport":"healthy"}}\n503',
    b'{"status":"ready","checks":{"phone_test_transport":"healthy"}}\n302',
    b"not-json-private-marker\n200",
    b"x" * 16389,
]


RUNTIME_ORIGINS = [
    ("https://consent-protocol-fixture-uc.a.run.app", True),
    ("https://consent-protocol-123456.us-central1.run.app", True),
    ("https://consent-protocol-fixture-uc.a.run.app@evil.invalid", False),
    ("https://consent-protocol-fixture-uc.a.run.app:8443", False),
    ("https://consent-protocol-fixture-uc.a.run.app?redirect=true", False),
    ("https://unrelated-service.a.run.app", False),
]


@pytest.fixture
def phone_health_checker(monkeypatch, tmp_path):
    return build_phone_health_checker(monkeypatch, tmp_path)


def test_phone_allowlist_health_never_logs_secret_values(monkeypatch, phone_health_checker, capsys):
    module, writes = phone_health_checker
    monkeypatch.setattr(
        module,
        "read",
        lambda name, project, version: (
            "+15550000001" if version == "2" else "+15550000001,+15550000002"
        ),
    )
    assert module.main() == 1
    payload = json.loads(writes[0][3])
    assert payload == {
        "message": "auth.test_allowlist.health",
        "status": "failed",
        "checked_lists": 1,
    }
    output = capsys.readouterr()
    assert "+15550000001" not in output.out + output.err + str(writes)
    assert "+15550000002" not in output.out + output.err + str(writes)
    # A failed previous-version read must not report a healthy heartbeat.
    monkeypatch.setattr(
        module,
        "read",
        lambda name, project, version: "+15550000001,+15550000002" if version == "2" else None,
    )
    assert module.main() == 2
    assert json.loads(writes[-1][3])["status"] == "unavailable"
    # Explicit opt-in is required; ordinary deploy verification publishes nothing.
    writes.clear()
    monkeypatch.setattr(sys, "argv", ["verify", "--project", "hushh-pda-uat"])
    assert module.main() == 2
    assert writes == []


@pytest.mark.parametrize("response", RUNTIME_HTTP_RESPONSES)
def test_runtime_observation_controls_same_health_publication(
    monkeypatch, phone_health_checker, capsys, response
):
    module, writes = phone_health_checker
    monkeypatch.setattr(module, "read", lambda *_: "+15550000001,+15550000002")
    monkeypatch.setattr(
        sys,
        "argv",
        ["verify", "--project", "hushh-pda-uat", "--emit-health-log", "--check-phone-runtime"],
    )

    install_phone_ports(monkeypatch, module, writes, response)
    healthy = response == b'{"status":"ready","checks":{"phone_test_transport":"healthy"}}\n200'
    assert module.main() == (0 if healthy else 2)
    payload = json.loads(writes[-1][3])
    assert (
        payload["status"] == payload["runtime_status"] == ("healthy" if healthy else "unavailable")
    )
    assert payload["checked_lists"] == 1
    output = capsys.readouterr()
    assert "private-marker" not in output.out + output.err + str(writes)
    assert "+15550000001" not in output.out + output.err + str(writes)


@pytest.mark.parametrize("origin,accepted", RUNTIME_ORIGINS)
def test_runtime_observation_binds_the_governed_service_origin(
    monkeypatch, phone_health_checker, origin, accepted
):
    module, _ = phone_health_checker
    monkeypatch.setattr(module, "gcloud", lambda args: (0, json.dumps(phone_service(origin))))
    result = module.phone_runtime_authority("hushh-pda-uat")
    assert (result is not None) is accepted
    assert module.phone_runtime_authority("unrelated-project") is None


@pytest.mark.parametrize("changed", [False, True])
def test_runtime_observation_refuses_ambiguous_or_changed_serving_authority(
    monkeypatch, phone_health_checker, changed
):
    module, _ = phone_health_checker
    before, after = phone_service(), phone_service()
    if changed:
        after["status"]["traffic"][0]["revisionName"] = "consent-protocol-00002-def"
    else:
        before["status"]["traffic"] = [
            {"revisionName": "consent-protocol-00001-abc", "percent": 50},
            {"revisionName": "consent-protocol-00002-def", "percent": 50},
        ]
    observations = iter([before, after])
    monkeypatch.setattr(module, "gcloud", lambda _: (0, json.dumps(next(observations))))
    monkeypatch.setattr(module, "read_phone_runtime", lambda _: "healthy")
    assert module.check_phone_runtime("hushh-pda-uat") == "unavailable"


@pytest.mark.parametrize("environment", ["uat", "production"])
@pytest.mark.parametrize("rollout", ["false", "true", "invalid"])
def test_hourly_runtime_observation_is_staged_by_environment_rollout(environment, rollout):
    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/verify-protected-lists.yml").read_text())
    step = next(row for row in workflow["jobs"][environment]["steps"] if "run" in row)
    script = step["run"].replace("${{ env.GCP_PROJECT_ID }}", "synthetic-project")
    result = subprocess.run(  # noqa: S603 - real workflow shell; Python/cloud are intercepted
        ["bash", "-euo", "pipefail", "-c", 'python3() { printf "%s\\n" "$@"; };\n' + script],
        env={"AUTH_PHONE_RUNTIME_HEALTH_ENABLED": rollout},
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == (1 if rollout == "invalid" else 0)
    assert ("--check-phone-runtime" in result.stdout) is (rollout == "true")
    assert ("--emit-health-log" in result.stdout) is (rollout != "invalid")


@pytest.mark.parametrize("case", ["normal", "lost-write", "expired", "replaced", "denied"])
def test_cloud_health_lease_fences_duplicates_and_preserves_successors(case):
    root = Path(__file__).resolve().parents[2]
    path = root / "deploy/observability/auth_health_job.py"
    spec = importlib.util.spec_from_file_location("auth_health_job", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    state = {
        "generation": 0,
        "body": None,
        "reads": 0,
        "writes": 0,
        "expected_generations": [],
    }
    if case == "expired":
        state.update(generation=4, body={"holder": "b" * 32, "expires": 1})

    class FakeStorage:
        def write(self, payload, expected_generation):
            state["writes"] += 1
            state["expected_generations"].append(expected_generation)
            if case == "denied":
                raise module.HealthCommandFailure(
                    module.HealthCommandStage.LEASE_CLAIM,
                    module.BoundedFailureReason.UNCLASSIFIED,
                )
            if int(expected_generation) != state["generation"]:
                raise module.LeasePreconditionFailed(module.HealthCommandStage.LEASE_CLAIM)
            state["body"] = json.loads(payload)
            state["generation"] += 1
            if case == "lost-write" and state["generation"] == 1:
                raise module.LeaseWriteUncertain(
                    module.HealthCommandStage.LEASE_CLAIM,
                    module.BoundedFailureReason.UNCLASSIFIED,
                )
            if case == "replaced":
                state["generation"] += 1
                state["body"] = {"holder": "c" * 32, "expires": 2000}

        def generation(self):
            state["reads"] += 1
            return str(state["generation"])

        def read(self, generation):
            assert generation == str(state["generation"])
            return json.dumps(state["body"]).encode()

        def delete(self, generation):
            assert generation == str(state["generation"])
            state["body"] = None
            state["generation"] = 0

    storage = FakeStorage()

    if case == "replaced":
        with (
            pytest.raises(module.HealthCommandFailure) as error,
            module.lease("hushh-pda-uat", storage=storage, clock=lambda: 1000),
        ):
            pytest.fail("A successor's lease authorized this worker")
        assert error.value.stage is module.HealthCommandStage.LEASE_READ
        assert state["body"]["holder"] == "c" * 32
    elif case == "denied":
        with pytest.raises(module.HealthCommandFailure) as error:
            with module.lease("hushh-pda-uat", storage=storage, clock=lambda: 1000):
                pytest.fail("A refused generation-0 write authorized this worker")
        assert error.value.stage is module.HealthCommandStage.LEASE_CLAIM
        assert state["reads"] == 0
    else:
        with module.lease("hushh-pda-uat", storage=storage, clock=lambda: 1000) as acquired:
            assert acquired
            assert state["body"]["expires"] == 1900
            assert len(state["body"]["holder"]) == 32
            with module.lease("hushh-pda-uat", storage=storage, clock=lambda: 1000) as duplicate:
                assert not duplicate
            assert state["body"] is not None
        assert state["body"] is None
        if case == "expired":
            assert state["expected_generations"] == ["0", "4", "0"]


@pytest.mark.parametrize(
    ("failure", "expected_reason", "exitcode"),
    [
        ("exit", "exit", 2),
        ("timeout", "timeout", None),
        ("private-value-marker", "unclassified", None),
    ],
)
def test_auth_health_job_logs_only_bounded_failure_stage_and_reason(
    monkeypatch, capsys, failure, expected_reason, exitcode
):
    root = Path(__file__).resolve().parents[2]
    path = root / "deploy/observability/auth_health_job.py"
    spec = importlib.util.spec_from_file_location("auth_health_job", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    private_marker = "private-value-marker"

    def fail(*_args, **_kwargs):
        raise module.BoundedReadError(failure, exitcode=exitcode)

    monkeypatch.setattr(module, "bounded_stdout", fail)

    class FailingLease:
        def __enter__(self):
            module.command(
                ["gcloud", "storage", "cat", f"gs://private-bucket/{private_marker}"],
                stage=module.HealthCommandStage.LEASE_READ,
            )

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(module, "lease", lambda _project: FailingLease())
    monkeypatch.setenv("AUTH_HEALTH_PROJECT", "hushh-pda")
    monkeypatch.setenv("AUTH_PHONE_RUNTIME_HEALTH_ENABLED", "false")

    assert module.main() == 2
    output = capsys.readouterr()
    expected = f"Auth health check unavailable; stage=lease_read; reason={expected_reason}"
    if exitcode is not None:
        expected += f"; exitcode={exitcode}"
    assert output.out == expected + "\n"
    assert private_marker not in output.out + output.err
    assert "Bounded command read:" not in output.out + output.err
    if failure not in {"exit", "timeout"}:
        assert failure not in output.out + output.err


def test_auth_health_job_refuses_unclassified_stage_without_running_command(monkeypatch):
    root = Path(__file__).resolve().parents[2]
    path = root / "deploy/observability/auth_health_job.py"
    spec = importlib.util.spec_from_file_location("auth_health_job", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    calls = []
    monkeypatch.setattr(module, "bounded_stdout", lambda *args, **kwargs: calls.append(args))

    with pytest.raises(ValueError, match="Unclassified health command stage") as error:
        module.command(
            ["gcloud", "storage", "cat", "gs://private-bucket/private-object"],
            stage="private-marker",
        )

    assert calls == []
    assert "private-marker" not in str(error.value)


def test_auth_health_job_preserves_stage_for_redacted_oserror(monkeypatch, capsys):
    root = Path(__file__).resolve().parents[2]
    path = root / "deploy/observability/auth_health_job.py"
    spec = importlib.util.spec_from_file_location("auth_health_job", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    private_marker = "private-value-marker"

    def fail(*_args, **_kwargs):
        raise OSError(private_marker)

    monkeypatch.setattr(module, "bounded_stdout", fail)

    class FailingLease:
        def __enter__(self):
            module.command(
                ["gcloud", "storage", "cat", f"gs://private-bucket/{private_marker}"],
                stage=module.HealthCommandStage.LEASE_READ,
            )

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(module, "lease", lambda _project: FailingLease())
    monkeypatch.setenv("AUTH_HEALTH_PROJECT", "hushh-pda")
    monkeypatch.setenv("AUTH_PHONE_RUNTIME_HEALTH_ENABLED", "false")

    assert module.main() == 2
    output = capsys.readouterr()
    assert output.out == ("Auth health check unavailable; stage=lease_read; reason=unclassified\n")
    assert private_marker not in output.out + output.err


@pytest.mark.parametrize(
    ("reason", "exitcode", "expected_reason", "expected_exitcode"),
    [
        ("exit", 2, "exit", 2),
        ("exit", 0, "exit", None),
        ("exit", 256, "exit", None),
        ("private-marker", 2, "unclassified", None),
        ("timeout", 2, "timeout", None),
    ],
)
def test_bounded_read_error_exposes_only_validated_classification(
    reason, exitcode, expected_reason, expected_exitcode
):
    root = Path(__file__).resolve().parents[2]
    path = root / "deploy/observability/auth_health_job.py"
    spec = importlib.util.spec_from_file_location("auth_health_job", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    error = module.BoundedReadError(reason, exitcode=exitcode)

    assert error.reason == expected_reason
    assert error.exitcode == expected_exitcode
    assert "private-marker" not in str(error)


def test_bounded_stdout_preserves_only_nonzero_numeric_exitcode():
    root = Path(__file__).resolve().parents[2]
    path = root / "deploy/observability/auth_health_job.py"
    spec = importlib.util.spec_from_file_location("auth_health_job", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    with pytest.raises(module.BoundedReadError) as error:
        module.bounded_stdout(
            [sys.executable, "-c", "raise SystemExit(7)"],
            max_bytes=64,
            timeout=2,
        )

    assert error.value.reason == "exit"
    assert error.value.exitcode == 7
    assert "SystemExit" not in str(error.value)
