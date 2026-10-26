"""Production preflight read diagnostics must identify failures without credentials."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _module(name: str):
    path = ROOT / "deploy/drive" / name
    spec = importlib.util.spec_from_file_location(name.removesuffix(".py"), path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("arguments", "operation"),
    [
        (("services", "api-keys", "list"), "picker_list"),
        (
            ("services", "api-keys", "get-key-string", "synthetic-private-resource"),
            "picker_key_compare",
        ),
        (
            (
                "iam",
                "service-accounts",
                "describe",
                "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com",
            ),
            "runtime_account_get",
        ),
        (
            (
                "iam",
                "service-accounts",
                "describe",
                "drive-work-drain-sched@hushh-pda.iam.gserviceaccount.com",
            ),
            "scheduler_account_get",
        ),
        (("projects", "get-iam-policy"), "scheduler_policy_read"),
        (("secrets", "versions", "describe"), "secret_metadata_read"),
        (("secrets", "versions", "access"), "secret_value_read"),
    ],
)
def test_production_prerequisite_read_failure_exposes_only_fixed_operation(
    monkeypatch, capsys, arguments, operation
):
    module = _module("verify_prod_prerequisites.py")
    malicious = "synthetic-secret-token=private-value\nprovider-body-and-identity"
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            ["gcloud", malicious], 7, stdout=malicious, stderr=malicious
        ),
    )
    with pytest.raises(module.PrerequisiteError) as failure:
        module._gcloud(*arguments)
    expected = f"Production Drive prerequisite read failed: {operation}; exit_status=7"
    assert str(failure.value) == expected
    # Exercise the CLI boundary and the secret wrapper using the real _gcloud.
    monkeypatch.setattr(module, "verify", lambda **_: module._gcloud(*arguments))
    monkeypatch.setattr(sys, "argv", ["preflight", "--project", module.PROJECT])
    with pytest.raises(SystemExit) as exit_status:
        module.main()
    assert exit_status.value.code == 1
    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == f"Production Drive preflight blocked: {expected}\n"
    if operation.startswith("secret_"):

        def secret_read(command, **_kwargs):
            if operation == "secret_value_read" and command[3] == "describe":
                return subprocess.CompletedProcess(command, 0, stdout='{"state":"ENABLED"}')
            return subprocess.CompletedProcess(command, 7, stdout=malicious, stderr=malicious)

        monkeypatch.setattr(module.subprocess, "run", secret_read)
        with pytest.raises(module.PrerequisiteError) as secret_failure:
            module._secret(module.SECRETS[0])
        assert str(secret_failure.value) == expected
