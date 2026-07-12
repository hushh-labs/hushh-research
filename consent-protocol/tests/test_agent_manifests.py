"""Strict product-agent manifest invariants."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from hushh_mcp.hushh_adk.manifest import AgentManifestV2, ManifestLoader

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_ROOT = ROOT / "hushh_mcp" / "agents"
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


def load(name: str) -> AgentManifestV2:
    return ManifestLoader.load(str(MANIFEST_ROOT / name / "agent.yaml"))


@pytest.mark.parametrize("path", sorted(MANIFEST_ROOT.glob("*/agent.yaml")))
def test_authored_manifest_is_strict_v2(path: Path) -> None:
    manifest = ManifestLoader.load(str(path))
    assert manifest.manifest_version == 2
    assert SEMVER_PATTERN.fullmatch(manifest.version)
    assert manifest.id.startswith("agent_") or manifest.id in {
        "memory_intent",
        "memory_merge",
        "memory_segmentation",
        "pkm_structure",
        "summary_reducer",
    }
    assert manifest.name.strip()
    assert manifest.description.strip()
    assert not (set(manifest.required_scopes) & set(manifest.optional_scopes))
    assert manifest.privacy.plaintext_telemetry is False


def test_one_is_the_only_product_head_and_invocation_is_narrow() -> None:
    one = load("one")
    assert one.id == "agent_one"
    assert one.parent is None or one.parent == "agent_one"
    assert one.required_scopes == ["cap.one.invoke"]
    assert "agent_orchestrator" in one.legacy_ids
    assert not (MANIFEST_ROOT / "orchestrator" / "agent.yaml").exists()


def test_core_specialists_have_distinct_ids_and_reserved_authority() -> None:
    manifests = [load(name) for name in ("kai", "nav", "kyc", "location")]
    assert len({manifest.id for manifest in manifests}) == 4
    assert load("kai").required_scopes == ["agent.kai.analyze"]
    assert load("nav").required_scopes == ["agent.nav.review"]
    assert load("kyc").required_scopes == ["agent.kyc.process"]
    assert load("location").required_scopes == ["cap.location.live.share"]


def test_kyc_owns_strict_zero_knowledge_formatter_contract() -> None:
    capabilities = load("kyc").capabilities
    formatter = capabilities["approved_disclosure_formatter"]
    assert capabilities["drafting_contract_owned_by_adk"] is True
    assert capabilities["strict_client_zk_draft_rendering"] is True
    assert formatter["contract_id"] == "agent_kyc.approved_disclosure_formatter.v1"
    assert formatter["strict_client_zk"] is True
    assert formatter["backend_plaintext_allowed"] is False
