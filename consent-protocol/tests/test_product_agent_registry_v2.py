from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from hushh_mcp.hushh_adk.manifest import ManifestLoader

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent


def test_all_authored_product_agent_manifests_are_strict_v2() -> None:
    paths = sorted((ROOT / "hushh_mcp" / "agents").glob("*/agent.yaml"))
    assert paths
    manifests = [ManifestLoader.load(str(path)) for path in paths]
    assert all(manifest.manifest_version == 2 for manifest in manifests)
    assert len({manifest.id for manifest in manifests}) == len(manifests)


def test_unknown_manifest_field_is_rejected() -> None:
    with pytest.raises(ValueError, match="extra_forbidden"):
        ManifestLoader.load_from_dict(
            {
                "id": "agent_test",
                "name": "Test",
                "description": "Test",
                "system_instruction": "Test",
                "unknown_field": True,
            }
        )


def test_generated_product_agent_registry_is_current() -> None:
    result = subprocess.run(  # noqa: S603 - executes a repository-owned verifier.
        [sys.executable, str(ROOT / "scripts" / "generate_product_agent_registry.py"), "--check"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    registry = json.loads(
        (REPO_ROOT / "contracts" / "agents" / "product-agent-registry.v2.json").read_text()
    )
    assert registry["schema_version"] == "2.0.0"
    assert registry["agents"]
    assert all("system_instruction" not in agent for agent in registry["agents"])
    assert all(len(agent["system_instruction_sha256"]) == 64 for agent in registry["agents"])


def test_registry_writer_uses_platform_independent_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "registry_writer", ROOT / "scripts" / "generate_product_agent_registry.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    registry = module.build_registry()
    monkeypatch.setattr(module, "build_registry", lambda: registry)
    output = tmp_path / "registry.json"
    monkeypatch.setattr(module, "OUTPUTS", (output,))
    monkeypatch.setattr(module, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(sys, "argv", ["generate_product_agent_registry.py"])
    assert module.main() == 0
    assert output.read_bytes() == module.render(module.build_registry()).encode("utf-8")
    assert b"\r\n" not in output.read_bytes()


def test_agent_hierarchy_and_action_contracts_are_current() -> None:
    result = subprocess.run(  # noqa: S603 - executes a repository-owned verifier.
        [sys.executable, str(ROOT / "scripts" / "verify_agent_hierarchy_contract.py")],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
