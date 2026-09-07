from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "ios_simulator_cleanup", ROOT / "hushh-webapp/scripts/native/ios-simulator-cleanup.py"
)
assert SPEC and SPEC.loader
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)
DEVICE = "12345678-1234-1234-1234-123456789abc"
HEADER = "PID\tStatus\tLabel\n"
ABSENT = HEADER + "42\t0\tcom.apple.testmanagerd\n"
RUNNING = ABSENT + "91\t0\tUIKitApplication:com.hushh.app[a1][rb-legacy]\n"


@pytest.mark.parametrize(
    "output,running",
    [
        (ABSENT, False),
        (RUNNING, True),
        (ABSENT + "-\t15\tUIKitApplication:com.hushh.app[a1][rb-legacy]\n", False),
        (ABSENT + "91\t0\tUIKitApplication:com.hushh.app.uitests.xctrunner[a1]\n", False),
        (ABSENT + "91\t0\tUIKitApplication:com.hushh.application[a1]\n", False),
    ],
)
def test_process_inventory_matches_exact_app_and_distinguishes_inactive(output, running):
    assert cleanup.app_is_running(output) is running


@pytest.mark.parametrize(
    "output",
    [
        "",
        HEADER,
        "private-diagnostic\n",
        ABSENT + "malformed\n",
        RUNNING + "-\tbad-status\tcom.apple.invalid\n",
        ABSENT + "0\t0\tunknown\n",
        ABSENT + "bad-pid\t0\tunknown\n",
        "x" * 1_048_577,
    ],
)
def test_process_inventory_refuses_incomplete_or_malformed_output(output):
    with pytest.raises(ValueError):
        cleanup.app_is_running(output)


def _host(
    monkeypatch,
    *,
    inventory=ABSENT,
    inventory_code=0,
    terminate_code=0,
    timeout_at=None,
    state="Booted",
):
    calls = []
    clock = [0.0]
    monkeypatch.setattr(cleanup.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(cleanup.time, "sleep", lambda delay: clock.__setitem__(0, clock[0] + delay))

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        operation = (
            "state" if argv[2] == "list" else "terminate" if argv[2] == "terminate" else "inventory"
        )
        assert 0 < kwargs["timeout"] <= 15
        if operation == "state":
            assert argv == ["xcrun", "simctl", "list", "devices", "--json"]
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps(
                    {
                        "devices": {
                            "runtime": [
                                {"udid": DEVICE.upper(), "state": state},
                            ]
                        }
                    }
                ),
            )
        assert argv[3] == DEVICE
        assert "booted" not in argv
        if timeout_at == operation:
            clock[0] += kwargs["timeout"]
            raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
        return SimpleNamespace(
            returncode=terminate_code if operation == "terminate" else inventory_code,
            stdout="" if operation == "terminate" else inventory,
            stderr="private-host-diagnostic-sentinel",
        )

    monkeypatch.setattr(cleanup.subprocess, "run", run)
    return calls, clock


@pytest.mark.parametrize("terminate_code,timeout_at", [(0, None), (1, None), (0, "terminate")])
def test_cleanup_requires_independent_absence_even_after_termination_error(
    monkeypatch, terminate_code, timeout_at
):
    calls, clock = _host(monkeypatch, terminate_code=terminate_code, timeout_at=timeout_at)
    result = cleanup.cleanup(DEVICE)
    assert result["status"] == "verified_app_absent"
    assert calls[0][0] == ["xcrun", "simctl", "terminate", DEVICE, "com.hushh.app"]
    assert calls[1][0] == ["xcrun", "simctl", "spawn", DEVICE, "launchctl", "list"]
    assert clock[0] <= 20
    assert "private" not in str(result)


@pytest.mark.parametrize(
    "inventory,code,timeout_at",
    [
        (RUNNING, 0, None),
        (ABSENT, 1, None),
        ("", 0, None),
        (ABSENT, 0, "inventory"),
    ],
)
def test_cleanup_failure_remains_visible_and_bounded(monkeypatch, inventory, code, timeout_at):
    calls, clock = _host(
        monkeypatch, inventory=inventory, inventory_code=code, timeout_at=timeout_at
    )
    result = cleanup.cleanup(DEVICE)
    assert result["status"] == "unverified"
    assert len(calls) > 1
    assert clock[0] <= 20.01
    assert "private" not in str(result)


@pytest.mark.parametrize("device", ["booted", "", "--help", "not-a-uuid"])
def test_cleanup_refuses_implicit_or_invalid_target_before_any_host_call(monkeypatch, device):
    calls, _ = _host(monkeypatch)
    assert cleanup.cleanup(device)["reason"] == "explicit_simulator_uuid_required"
    assert not calls


@pytest.mark.parametrize(
    "state,expected",
    [
        ("Shutdown", "verified_app_absent"),
        ("Booted", "unverified"),
        ("Shutting Down", "unverified"),
    ],
)
def test_cleanup_requires_fresh_exact_device_shutdown_before_accepting_failed_inventory(
    monkeypatch, state, expected
):
    calls, clock = _host(monkeypatch, inventory_code=1, state=state)
    result = cleanup.cleanup(DEVICE)
    assert result["status"] == expected
    assert calls[-1][0] == ["xcrun", "simctl", "list", "devices", "--json"]
    assert clock[0] <= 20
    if expected == "verified_app_absent":
        assert result["evidence"] == "simulator_shutdown"
    else:
        assert result["reason"] == "process_inventory_refused"


@pytest.mark.parametrize(
    "inventory,code,timeout_at,reason",
    [
        ("", 0, None, "process_inventory_invalid"),
        (ABSENT, 1, None, "process_inventory_refused"),
        (ABSENT, 0, "inventory", "process_inventory_timed_out"),
    ],
)
def test_cleanup_distinguishes_safe_inventory_failure_classes(
    monkeypatch, inventory, code, timeout_at, reason
):
    _host(monkeypatch, inventory=inventory, inventory_code=code, timeout_at=timeout_at)
    result = cleanup.cleanup(DEVICE)
    assert result["status"] == "unverified"
    assert result["reason"] == reason
    assert result["simulator_state"] == "Booted"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"devices": []},
        {"devices": {"runtime": []}},
        {"devices": {"runtime": [None]}},
        {"devices": {"runtime": [{"udid": "foreign", "state": "Shutdown"}]}},
        {"devices": {"runtime": [{"udid": DEVICE, "state": "Shutdown"}] * 2}},
    ],
)
def test_shutdown_proof_rejects_missing_foreign_duplicate_or_malformed_inventory(
    monkeypatch, payload
):
    monkeypatch.setattr(cleanup.time, "monotonic", lambda: 0)
    monkeypatch.setattr(
        cleanup.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout=json.dumps(payload)),
    )
    result = cleanup.inventory_unavailable(
        DEVICE, 20, {"status": "unverified"}, "process_inventory_refused"
    )
    assert result["status"] == "unverified"
    assert result["simulator_state"] == "unavailable"


@pytest.mark.parametrize("host", ["ci", "cold-audit"])
@pytest.mark.parametrize(
    "test_result,cleanup_result,expected", [(0, 0, 0), (0, 1, 1), (42, 0, 42), (42, 1, 42)]
)
def test_actual_host_exit_trap_preserves_test_failure_and_requires_cleanup(
    tmp_path, host, test_result, cleanup_result, expected
):
    if host == "ci":
        workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
        step = next(
            s
            for s in workflow["jobs"]["ios-native-check"]["steps"]
            if s.get("name") == "Compile app and run native iOS unit tests"
        )
        source = step["run"]
        fragment = source[
            source.index("cleanup_native_test_app() {") : source.index("xcodebuild test")
        ]
    else:
        source = (ROOT / "hushh-webapp/scripts/native/ios-test.sh").read_text()
        fragment = source[
            source.index("cleanup_native_test_app() {") : source.index(
                'echo "==> native unit tests"'
            )
        ]
    stub = tmp_path / "python3"
    stub.write_text('#!/bin/sh\nexit "$AUDIT_CLEANUP_OUTCOME"\n')
    stub.chmod(0o700)
    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail"],
        input=fragment + '\nexit "$AUDIT_TEST_OUTCOME"\n',
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "SIMULATOR_ID": DEVICE,
            "DESTINATION": f"platform=iOS Simulator,id={DEVICE}",
            "AUDIT_TEST_OUTCOME": str(test_result),
            "AUDIT_CLEANUP_OUTCOME": str(cleanup_result),
        },
    )
    assert result.returncode == expected, result.stderr


@pytest.mark.parametrize(
    "destination,expected",
    [
        ("", 0),
        ("platform=iOS Simulator,name=iPhone 14 Plus", 0),
        (f"platform=iOS Simulator,id={DEVICE}", 0),
        ("platform=iOS Simulator,name=iPhone 14 Plus,OS=26.3", 0),
        ("platform=iOS Simulator,name=iPhone 14 Plus,OS=19.0", 2),
        ("platform=iOS,id=physical-device", 2),
        ("platform=iOS Simulator,name=missing", 2),
    ],
)
def test_cold_audit_resolves_named_destinations_before_tests(tmp_path, destination, expected):
    source = (ROOT / "hushh-webapp/scripts/native/ios-test.sh").read_text()
    resolver = source.split("node <<'NODE'\n", 1)[1].split("\nNODE", 1)[0]
    stub = tmp_path / "xcrun"
    stub.write_text('#!/bin/sh\nprintf "%s" "$AUDIT_SIMULATOR_INVENTORY"\n')
    stub.chmod(0o700)
    result = subprocess.run(
        ["node"],
        input=resolver,
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "IOS_TEST_DEVICE_NAME": "iPhone 14 Plus",
            "IOS_TEST_DESTINATION": destination,
            "AUDIT_SIMULATOR_INVENTORY": json.dumps(
                {
                    "devices": {
                        "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
                            {"name": "iPhone 14 Plus", "udid": DEVICE, "isAvailable": True},
                        ],
                    }
                }
            ),
        },
    )
    assert result.returncode == expected, result.stderr
    if expected == 0:
        assert result.stdout.strip() == f"platform=iOS Simulator,id={DEVICE}"
    else:
        assert not result.stdout
