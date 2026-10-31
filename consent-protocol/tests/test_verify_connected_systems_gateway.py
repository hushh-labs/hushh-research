from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from runpy import run_path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts/ops/verify_connected_systems_gateway.py"
SPEC = importlib.util.spec_from_file_location("verify_connected_systems_gateway", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


def test_gateway_readiness_uses_only_the_no_record_handshake(monkeypatch) -> None:
    secret_values = {
        "OMNIGATEWAY_CLIENT_ID": "client-id-value",
        "OMNIGATEWAY_CLIENT_SECRET": "client-secret-value",
    }
    monkeypatch.setattr(
        gateway,
        "_read_secret_value",
        lambda _project, name: secret_values.get(name),
    )
    monkeypatch.setattr(
        gateway,
        "_gateway_contract",
        lambda: ("https://gateway.example/mcp", frozenset({"object-schema", "read-crm-record"})),
    )

    seen: dict[str, object] = {}

    async def list_tools(endpoint: str, **kwargs: object) -> frozenset[str]:
        seen["endpoint"] = endpoint
        seen.update(kwargs)
        return frozenset({"object-schema", "read-crm-record", "create-crm-record"})

    monkeypatch.setattr(gateway, "_list_tools", list_tools)

    report = gateway.run("project", timeout_seconds=7)

    assert report == {
        "status": "healthy",
        "probe": "mcp_initialize_and_tools_list",
        "expectedToolCount": 2,
    }
    assert seen == {
        "endpoint": "https://gateway.example/mcp",
        "client_id": "client-id-value",
        "client_secret": "client-secret-value",
        "timeout_seconds": 7,
    }
    assert "client-id-value" not in str(report)
    assert "client-secret-value" not in str(report)


def test_gateway_readiness_fails_closed_when_a_secret_is_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(
        gateway,
        "_read_secret_value",
        lambda _project, name: "client-id-value" if name == "OMNIGATEWAY_CLIENT_ID" else None,
    )

    report = gateway.run("project")

    assert report == {
        "status": "blocked",
        "classification": "omni_gateway_secret_unavailable",
        "missingSecrets": ["OMNIGATEWAY_CLIENT_SECRET"],
    }


def test_gateway_readiness_fails_closed_when_the_tool_contract_drifts(monkeypatch) -> None:
    monkeypatch.setattr(gateway, "_read_secret_value", lambda *_args: "credential")
    monkeypatch.setattr(
        gateway,
        "_gateway_contract",
        lambda: ("https://gateway.example/mcp", frozenset({"object-schema", "read-crm-record"})),
    )

    async def list_tools(*_args: object, **_kwargs: object) -> frozenset[str]:
        return frozenset({"object-schema"})

    monkeypatch.setattr(gateway, "_list_tools", list_tools)

    assert gateway.run("project") == {
        "status": "blocked",
        "classification": "omni_gateway_tool_contract_mismatch",
        "missingTools": ["read-crm-record"],
    }


def test_production_crm_qualification_respects_paused_product_and_keeps_admitted_gates(tmp_path):
    workflow = yaml.safe_load((REPO_ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = {step.get("id"): step for step in workflow["jobs"]["deploy"]["steps"]}
    expected = run_path(
        str(REPO_ROOT / "consent-protocol/hushh_mcp/services/crm_product_availability.py")
    )["crm_product_available"](environment="production")
    output = tmp_path / "availability-output"
    report = tmp_path / "availability.json"
    authority = steps["crm-availability"]["run"].replace(
        "/tmp/prod-connected-systems-availability.json",  # noqa: S108 -- match authored path; actual output uses tmp_path.
        report.as_posix(),
    )
    actual = subprocess.run(  # noqa: S603 -- authored availability step, no cloud calls
        ["bash", "-c", f'python3() {{ "{Path(sys.executable).as_posix()}" "$@"; }}\n' + authority],
        cwd=REPO_ROOT,
        env={**os.environ, "GITHUB_OUTPUT": str(output), "TARGET_SHA": "b" * 40},
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    )
    assert (
        actual.returncode == 0 and output.read_text().strip() == f"required={str(expected).lower()}"
    )
    assert json.loads(report.read_text())["status"] == "not_applicable_product_paused"
    for required, exit_code in (("false", 0), ("true", 0), ("", 0), ("true", 1)):
        commands = tmp_path / "commands"
        outputs = tmp_path / "probe-output"
        commands.write_text("")
        outputs.write_text("")
        for step_id in ("verify-parity", "verify-connected-systems"):
            block = steps[step_id]["run"].replace("${{ env.PROTOCOL_PYTHON }}", "python3")
            block = re.sub(r"\$\{\{.*?\}\}", "synthetic", block)
            mocked = 'python3() { printf "%s\\n" "$*" >> "$COMMANDS"; return "$CLI_STATUS"; }\n'
            # Keep logs inside this isolated fixture; the production flag remains intact.
            block = block.replace(
                "/tmp/prod-connected-systems.log",  # noqa: S108 -- match authored path; actual output uses tmp_path.
                (tmp_path / "gateway.log").as_posix(),
            )
            result = subprocess.run(  # noqa: S603 -- actual authored steps with inert command ports
                ["bash", "-c", mocked + block],
                cwd=REPO_ROOT,
                env={
                    **os.environ,
                    "CRM_REQUIRED": required,
                    "COMMANDS": str(commands),
                    "GITHUB_OUTPUT": str(outputs),
                    "CLI_STATUS": str(exit_code),
                },
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
            assert (result.returncode == 0) == (bool(required) and exit_code == 0)
        calls = commands.read_text()
        if not required:
            assert not calls and not outputs.read_text()
        else:
            assert "--assert-runtime-env-contract" in calls
            assert ("--require-connected-systems" in calls) == (required == "true")
            assert ("verify_connected_systems_gateway.py" in calls) == (required == "true")
            if exit_code:
                assert not outputs.read_text()
            else:
                expected_probe = (
                    "verified" if required == "true" else "not_applicable_product_paused"
                )
                assert outputs.read_text().strip() == f"qualification={expected_probe}"
