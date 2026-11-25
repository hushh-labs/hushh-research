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
    assert all(row["declared"] is not None for row in matrix["agents"])
    assert matrix["disagreements"] == []


def test_hub_reader_follows_only_ports_reexported_by_runtime(monkeypatch, tmp_path) -> None:
    port = generator.pod_port_hub_reads()["PodMarketplaceReadPort"]
    assert port == {"reads_hub": True, "doors": ["marketplace"]}

    # An unwired class in the adapter file must not establish runtime capability.
    runtime = tmp_path / "runtime.py"
    monkeypatch.setattr(generator, "RUNTIME_PATH", runtime)
    for source in (
        "# No read port is wired into this runtime.\n",
        "from .hushh_mcp.services.pod_marketplace_ports import PodMarketplaceReadPort\n",
    ):
        runtime.write_text(source, encoding="utf-8")
        assert generator.pod_port_hub_reads() == {}


def test_unavailable_declaration_cannot_hide_registered_execution(matrix: dict) -> None:
    row = next(row for row in matrix["agents"] if row["id"] == "agent_computer_use")
    assert row["declared"]["information_source"] == "unavailable"
    assert generator._check_row(row["id"], row["declared"], row["derived"]) == []
    for field in ("registered_specialist", "pod_dispatchable", "pod_agent_tool"):
        changed = {**row["derived"], field: True}
        assert generator._check_row(row["id"], row["declared"], changed)


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
        if row["derived"]["pod_agent_tool"]:
            assert agent_id in generator.local_agent_tools()
            assert row["declared"]["executes_in_pod"] is True
            assert row["declared"]["information_source"] == "owner_bucket"
            assert row["derived"]["pod_dispatchable"] is False
            continue
        if row["derived"]["pod_memory_helper"]:
            assert agent_id in generator.local_memory_helpers()
            assert row["declared"]["executes_in_pod"] is True
            assert row["declared"]["information_source"] == "pkm_projection"
            assert row["declared"]["write_scope"] == "proposal_only"
            assert row["declared"]["confirmation_owner"] == "owner_browser"
            assert agent_id not in dispatchable
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
    for agent_id in ("agent_kai", "agent_kyc", "agent_wallet", "agent_career"):
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


@pytest.mark.parametrize("surface", ["route", "service"])
def test_memory_helper_requires_the_actual_route_and_manifest(monkeypatch, tmp_path, surface):
    assert generator.local_memory_helpers() == {"agent_chat_memory_manager"}
    attribute = "MEMORY_ROUTE_PATH" if surface == "route" else "MEMORY_SERVICE_PATH"
    original = getattr(generator, attribute)
    source = original.read_text()
    source = (
        source.replace(
            "await rewrite_chat_memory(body, model=model)", "await unrelated(body, model=model)"
        )
        if surface == "route"
        else source.replace("agents/chat_memory_manager/agent.yaml", "agents/unrelated/agent.yaml")
    )
    assert source != original.read_text()
    changed = tmp_path / original.name
    changed.write_text(source)
    monkeypatch.setattr(generator, attribute, changed)
    assert generator.local_memory_helpers() == set()
    matrix = generator.build_matrix()
    assert any(
        line.startswith("agent_chat_memory_manager:") and "refuses" in line
        for line in matrix["disagreements"]
    )


def test_memory_helper_requires_bound_execution_and_manifest(monkeypatch, tmp_path):
    route = tmp_path / "route.py"
    service = tmp_path / "service.py"
    monkeypatch.setattr(generator, "MEMORY_ROUTE_PATH", route)
    monkeypatch.setattr(generator, "MEMORY_SERVICE_PATH", service)
    route.write_text("# Preparation is unavailable on this runtime.\n")
    assert generator.local_memory_helpers() == set()

    bound_route = (
        "from hushh_mcp.services.chat_memory_manager import rewrite_chat_memory\n"
        "async def rewrite_memory(body, model):\n"
        "    return await rewrite_chat_memory(body, model=model)\n"
    )
    route.write_text(bound_route)
    with pytest.raises(FileNotFoundError):
        generator.local_memory_helpers()
    service.write_text(
        "def rewrite_chat_memory():\n"
        "    return ManifestLoader.load('agents/chat_memory_manager/agent.yaml')\n"
    )
    assert generator.local_memory_helpers() == {"agent_chat_memory_manager"}
    route.write_text(bound_route.replace("await rewrite_chat_memory(", "await unrelated("))
    assert generator.local_memory_helpers() == set()
    route.write_text(bound_route)
    service.write_text(service.read_text().replace("chat_memory_manager/", "unrelated/"))
    assert generator.local_memory_helpers() == set()


def test_memory_helper_cannot_gain_write_or_dispatch_authority():
    declared = {
        "executes_in_pod": True,
        "information_source": "pkm_projection",
        "write_scope": "proposal_only",
        "confirmation_owner": "owner_browser",
        "why": "Preparation proposes information; the owner commits it in the browser.",
    }
    derived = {"pod_memory_helper": True, "pod_dispatchable": False}
    assert generator._check_row("agent_chat_memory_manager", declared, derived) == []
    for field, value in (
        ("executes_in_pod", False),
        ("information_source", "owner_bucket"),
        ("write_scope", "none"),
        ("confirmation_owner", "none"),
    ):
        assert generator._check_row(
            "agent_chat_memory_manager", {**declared, field: value}, derived
        )
    assert generator._check_row(
        "agent_chat_memory_manager", declared, {**derived, "pod_dispatchable": True}
    )


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
        (REPO_ROOT / ".agents/workflows/product-agent-development/workflow.json").read_text()
    )
    command = (
        "cd consent-protocol && uv run python "
        "scripts/generate_pod_specialist_capability_matrix.py --check"
    )
    assert command in workflow["required_commands"]
    assert command in workflow["verification_bundle"]["commands"]
    index = (REPO_ROOT / "contracts" / "README.md").read_text(encoding="utf-8")
    assert "agents/pod-specialist-capability-matrix.v1.json" in index
