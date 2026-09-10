"""The pod specialist capability matrix says what each agent may do in a pod, and
it cannot disagree with the runtime that decides.

The declaration table in ``pod_specialist_runtime.py`` is authored; the roster
``service_for`` accepts and the ports that read the hub are parsed from source.
The generator joins them and refuses to write when they disagree, so a manifest
can never be presented as pod-executable because someone wrote that it was.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
_GENERATOR = ROOT / "scripts" / "generate_pod_specialist_capability_matrix.py"
_spec = importlib.util.spec_from_file_location(
    "generate_pod_specialist_capability_matrix", _GENERATOR
)
generator = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(generator)  # type: ignore[union-attr]

_ARTIFACT = REPO_ROOT / "contracts" / "agents" / "pod-specialist-capability-matrix.v1.json"
_MIRROR = ROOT / "contracts" / "agents" / "pod-specialist-capability-matrix.v1.json"


@pytest.fixture(scope="module")
def matrix() -> dict:
    return generator.build_matrix()


def test_the_generated_matrix_is_current() -> None:
    result = subprocess.run(  # noqa: S603 - executes a repository-owned verifier.
        [sys.executable, str(_GENERATOR), "--check"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_both_copies_exist_and_match() -> None:
    """The backend image is built from consent-protocol/, so the mirror is what
    ships; the repo-root copy is canonical. They must be byte-identical."""
    assert _ARTIFACT.is_file() and _MIRROR.is_file()
    assert _ARTIFACT.read_bytes() == _MIRROR.read_bytes()


def test_every_manifest_is_declared_and_nothing_disagrees(matrix: dict) -> None:
    manifest_ids = {
        generator.ManifestLoader.load(str(path)).id
        for path in (ROOT / "hushh_mcp" / "agents").glob("*/agent.yaml")
    }
    assert {row["id"] for row in matrix["agents"]} == manifest_ids
    assert len(matrix["agents"]) == 20
    assert all(row["declared"] is not None for row in matrix["agents"])
    assert matrix["disagreements"] == []


def test_the_declaration_table_parsed_from_source_is_the_table_python_sees() -> None:
    """The generator reads the table without importing the runtime; that read
    must equal the object the runtime actually exposes, or the artifact describes
    a table nobody executes."""
    from hushh_mcp.services.pod_specialist_runtime import POD_SPECIALIST_EXECUTION

    assert generator.declaration_table() == POD_SPECIALIST_EXECUTION


def test_pod_execution_is_derived_from_service_for_not_from_the_manifest(matrix: dict) -> None:
    rows = {row["id"]: row for row in matrix["agents"]}
    dispatchable = set(matrix["fleet"]["pod_dispatchable"])
    assert "agent_location" in dispatchable
    for agent_id, row in rows.items():
        if agent_id == "agent_one":
            assert row["declared"]["executes_in_pod"] is True
            assert row["declared"]["information_source"] == "pkm_projection"
            continue
        assert row["declared"]["executes_in_pod"] is (agent_id in dispatchable), agent_id
        assert row["derived"]["pod_dispatchable"] is (agent_id in dispatchable)
    # Every pod-dispatchable id is a registered specialist; otherwise dispatch KeyErrors.
    assert dispatchable <= set(matrix["fleet"]["registered_specialists"])


def test_hub_backed_information_is_declared_hub_backed_never_hub_independent(matrix: dict) -> None:
    """The four pod ports all read through the hub today. The matrix must say so
    for every one of them; a row that claimed owner-local facts would be the
    exact overclaim the ledger's zero-hub-read item exists to catch."""
    rows = {row["id"]: row for row in matrix["agents"]}
    for port, facts in matrix["fleet"]["pod_ports"].items():
        assert facts["reads_hub"] is True, port
        for door in facts["doors"]:
            agent_id = matrix["fleet"]["door_agents"][door]
            assert rows[agent_id]["declared"]["information_source"] == "hub_door", agent_id
            assert door in rows[agent_id]["derived"]["hub_doors"]
    # Hub-only agents are declared hub-only, with a reason.
    for agent_id in ("agent_kai", "agent_kyc", "agent_gmail", "agent_wallet"):
        assert rows[agent_id]["declared"]["executes_in_pod"] is False
        assert rows[agent_id]["declared"]["information_source"] == "hub"
        assert rows[agent_id]["declared"]["why"].strip()


def test_the_location_proposal_path_is_declared_as_a_proposal(matrix: dict) -> None:
    location = next(row for row in matrix["agents"] if row["id"] == "agent_location")
    assert location["declared"]["write_scope"] == "proposal_only"
    assert location["declared"]["confirmation_owner"] == "owner_browser"
    assert "cap.location.live.share" in location["required_scopes"]


def test_live_evidence_is_null_until_a_receipt_is_recorded(matrix: dict) -> None:
    """No receipt, no evidence. The matrix may not imply a live run happened."""
    evidence = matrix["live_evidence"]
    assert evidence is None or (
        evidence["ledger_item"] == "specialists-run-in-pod"
        and (REPO_ROOT / evidence["artifact"]).is_file()
    )


# -- negative controls: the generator must be able to say no -----------------------


def test_a_declaration_that_contradicts_service_for_is_a_disagreement() -> None:
    declarations = dict(generator.declaration_table())
    declarations["agent_kai"] = {**declarations["agent_kai"], "executes_in_pod": True}
    matrix = generator.build_matrix(declarations)
    assert any(
        line.startswith("agent_kai:") and "refuses" in line for line in matrix["disagreements"]
    )


def test_a_hub_door_reader_declared_owner_local_is_a_disagreement() -> None:
    declarations = dict(generator.declaration_table())
    declarations["agent_location"] = {
        **declarations["agent_location"],
        "information_source": "none",
    }
    matrix = generator.build_matrix(declarations)
    assert any(
        line.startswith("agent_location:") and "hub door" in line
        for line in matrix["disagreements"]
    )


def test_a_missing_declaration_is_a_disagreement() -> None:
    declarations = dict(generator.declaration_table())
    declarations.pop("agent_email")
    matrix = generator.build_matrix(declarations)
    assert "agent_email: manifest exists but nothing is declared" in matrix["disagreements"]


def test_a_declaration_for_an_unauthored_agent_is_a_disagreement() -> None:
    declarations = dict(generator.declaration_table())
    declarations["agent_ghost"] = dict(declarations["agent_kai"])
    matrix = generator.build_matrix(declarations)
    assert "agent_ghost: declared but no manifest authors it" in matrix["disagreements"]


def test_the_generator_refuses_to_write_a_disagreeing_matrix(monkeypatch, tmp_path) -> None:
    declarations = dict(generator.declaration_table())
    declarations["agent_wallet"] = {**declarations["agent_wallet"], "executes_in_pod": True}
    monkeypatch.setattr(generator, "declaration_table", lambda: declarations)
    monkeypatch.setattr(generator, "OUTPUTS", (tmp_path / "matrix.json",))
    monkeypatch.setattr(sys, "argv", ["generate"])
    assert generator.main() == 1
    assert not (tmp_path / "matrix.json").exists()


def test_the_workflow_and_contract_index_carry_the_check() -> None:
    workflow = json.loads(
        (REPO_ROOT / ".codex/workflows/product-agent-development/workflow.json").read_text()
    )
    command = (
        "cd consent-protocol && uv run python "
        "scripts/generate_pod_specialist_capability_matrix.py --check"
    )
    assert command in workflow["required_commands"]
    assert command in workflow["verification_bundle"]["commands"]
    index = (REPO_ROOT / "contracts" / "README.md").read_text(encoding="utf-8")
    assert "agents/pod-specialist-capability-matrix.v1.json" in index
