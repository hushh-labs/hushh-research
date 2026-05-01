"""Contract tests for Kai and orchestrator agent manifests.

Validates that the manifest metadata consumed by the agent registry,
MCP server, and consent UI is structurally sound: required scope
references resolve to real ConsentScope enum members, specialist ids
are unique, color hex values are valid, and compliance flags are
all booleans.
"""

from __future__ import annotations

import re

import pytest

from hushh_mcp.agents.kai.manifest import MANIFEST as KAI_MANIFEST
from hushh_mcp.agents.kai.manifest import get_manifest as get_kai_manifest
from hushh_mcp.agents.kyc.manifest import KYC_WORKFLOW_STATES
from hushh_mcp.agents.kyc.manifest import MANIFEST as KYC_MANIFEST
from hushh_mcp.agents.nav.manifest import MANIFEST as NAV_MANIFEST
from hushh_mcp.agents.one.manifest import MANIFEST as ONE_MANIFEST
from hushh_mcp.agents.orchestrator.manifest import manifest as ORCHESTRATOR_MANIFEST
from hushh_mcp.constants import ConsentScope

HEX_COLOR_PATTERN = re.compile(r"^#[0-9A-Fa-f]{6}$")
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


# ---------------------------------------------------------------------------
# Kai manifest: top-level shape
# ---------------------------------------------------------------------------


class TestKaiManifestShape:
    def test_required_top_level_keys_present(self) -> None:
        for key in (
            "agent_id",
            "name",
            "version",
            "description",
            "required_scopes",
            "optional_scopes",
            "specialists",
            "capabilities",
            "compliance",
        ):
            assert key in KAI_MANIFEST, f"missing key: {key}"

    def test_agent_id_non_empty(self) -> None:
        assert KAI_MANIFEST["agent_id"].strip()

    def test_name_non_empty(self) -> None:
        assert KAI_MANIFEST["name"].strip()

    def test_description_non_empty(self) -> None:
        assert KAI_MANIFEST["description"].strip()

    def test_version_is_semver(self) -> None:
        assert SEMVER_PATTERN.match(KAI_MANIFEST["version"]), (
            f"version {KAI_MANIFEST['version']} is not semver"
        )

    def test_get_manifest_returns_same_dict(self) -> None:
        assert get_kai_manifest() is KAI_MANIFEST


# ---------------------------------------------------------------------------
# Kai manifest: scope references resolve to ConsentScope enum
# ---------------------------------------------------------------------------


class TestKaiManifestScopes:
    @pytest.mark.parametrize("scope", list(KAI_MANIFEST["required_scopes"]))
    def test_required_scope_is_consent_scope(self, scope) -> None:  # noqa: ANN001
        assert isinstance(scope, ConsentScope), (
            f"required scope {scope!r} is not a ConsentScope enum member"
        )

    @pytest.mark.parametrize("scope", list(KAI_MANIFEST["optional_scopes"]))
    def test_optional_scope_is_consent_scope(self, scope) -> None:  # noqa: ANN001
        assert isinstance(scope, ConsentScope), (
            f"optional scope {scope!r} is not a ConsentScope enum member"
        )

    def test_required_scopes_no_duplicates(self) -> None:
        scopes = list(KAI_MANIFEST["required_scopes"])
        assert len(scopes) == len(set(scopes))

    def test_optional_scopes_no_duplicates(self) -> None:
        scopes = list(KAI_MANIFEST["optional_scopes"])
        assert len(scopes) == len(set(scopes))

    def test_no_overlap_between_required_and_optional(self) -> None:
        required = set(KAI_MANIFEST["required_scopes"])
        optional = set(KAI_MANIFEST["optional_scopes"])
        assert not (required & optional), (
            "a scope should be declared in required or optional, not both"
        )


# ---------------------------------------------------------------------------
# Kai manifest: specialists
# ---------------------------------------------------------------------------


class TestKaiSpecialists:
    def test_specialists_non_empty(self) -> None:
        assert len(KAI_MANIFEST["specialists"]) > 0

    @pytest.mark.parametrize("specialist", list(KAI_MANIFEST["specialists"]))
    def test_specialist_required_keys(self, specialist: dict) -> None:
        for key in ("id", "name", "description", "color", "icon"):
            assert key in specialist, f"specialist missing key: {key}"
            assert str(specialist[key]).strip(), f"specialist {key} is empty"

    @pytest.mark.parametrize("specialist", list(KAI_MANIFEST["specialists"]))
    def test_specialist_color_is_valid_hex(self, specialist: dict) -> None:
        assert HEX_COLOR_PATTERN.match(specialist["color"]), (
            f"specialist {specialist['id']} has invalid color {specialist['color']}"
        )

    def test_specialist_ids_unique(self) -> None:
        ids = [s["id"] for s in KAI_MANIFEST["specialists"]]
        assert len(ids) == len(set(ids))

    def test_specialist_ids_lowercase(self) -> None:
        for specialist in KAI_MANIFEST["specialists"]:
            assert specialist["id"] == specialist["id"].lower()


# ---------------------------------------------------------------------------
# Kai manifest: capabilities + compliance are all booleans
# ---------------------------------------------------------------------------


class TestKaiFlags:
    @pytest.mark.parametrize("value", list(KAI_MANIFEST["capabilities"].values()))
    def test_capabilities_are_bool(self, value) -> None:  # noqa: ANN001
        assert isinstance(value, bool)

    @pytest.mark.parametrize("value", list(KAI_MANIFEST["compliance"].values()))
    def test_compliance_flags_are_bool(self, value) -> None:  # noqa: ANN001
        assert isinstance(value, bool)

    def test_compliance_requires_educational_only(self) -> None:
        # Kai is explicitly not investment advice. This flag must stay true
        # to keep the disclaimer surfaced in the UI.
        assert KAI_MANIFEST["compliance"]["educational_only"] is True

    def test_compliance_disclaimer_required(self) -> None:
        assert KAI_MANIFEST["compliance"]["disclaimer_required"] is True


# ---------------------------------------------------------------------------
# Orchestrator manifest
# ---------------------------------------------------------------------------


class TestOrchestratorManifest:
    def test_required_keys_present(self) -> None:
        for key in ("id", "name", "description", "scopes", "version"):
            assert key in ORCHESTRATOR_MANIFEST, f"missing key: {key}"

    def test_id_non_empty(self) -> None:
        assert ORCHESTRATOR_MANIFEST["id"].strip()

    def test_name_non_empty(self) -> None:
        assert ORCHESTRATOR_MANIFEST["name"].strip()

    def test_description_non_empty(self) -> None:
        assert ORCHESTRATOR_MANIFEST["description"].strip()

    def test_version_is_semver(self) -> None:
        assert SEMVER_PATTERN.match(ORCHESTRATOR_MANIFEST["version"])

    def test_scopes_non_empty(self) -> None:
        assert len(ORCHESTRATOR_MANIFEST["scopes"]) > 0

    def test_scopes_all_strings(self) -> None:
        for scope in ORCHESTRATOR_MANIFEST["scopes"]:
            assert isinstance(scope, str)
            assert scope.strip()

    def test_scopes_no_duplicates(self) -> None:
        scopes = list(ORCHESTRATOR_MANIFEST["scopes"])
        assert len(scopes) == len(set(scopes))

    def test_orchestrator_is_agent_one_with_legacy_alias(self) -> None:
        assert ORCHESTRATOR_MANIFEST["id"] == "agent_one"
        assert "agent_orchestrator" in ORCHESTRATOR_MANIFEST["legacy_ids"]
        assert ORCHESTRATOR_MANIFEST["scopes"] == [ConsentScope.AGENT_ONE_ORCHESTRATE.value]


# ---------------------------------------------------------------------------
# One/Nav/KYC manifests
# ---------------------------------------------------------------------------


class TestOneNavKycManifests:
    @pytest.mark.parametrize(
        "manifest",
        [ONE_MANIFEST, NAV_MANIFEST, KYC_MANIFEST],
    )
    def test_required_manifest_shape(self, manifest: dict) -> None:
        for key in (
            "agent_id",
            "name",
            "version",
            "description",
            "required_scopes",
            "optional_scopes",
            "capabilities",
            "compliance",
        ):
            assert key in manifest, f"missing key: {key}"

    @pytest.mark.parametrize(
        "manifest",
        [ONE_MANIFEST, NAV_MANIFEST, KYC_MANIFEST],
    )
    def test_manifest_scope_entries_are_consent_scopes(self, manifest: dict) -> None:
        for scope in [*manifest["required_scopes"], *manifest["optional_scopes"]]:
            assert isinstance(scope, ConsentScope)

    def test_expected_agent_ids(self) -> None:
        assert ONE_MANIFEST["agent_id"] == "agent_one"
        assert NAV_MANIFEST["agent_id"] == "agent_nav"
        assert KYC_MANIFEST["agent_id"] == "agent_kyc"

    def test_one_delegates_to_kai_nav_kyc(self) -> None:
        specialist_ids = {specialist["id"] for specialist in ONE_MANIFEST["specialists"]}
        assert {"kai", "nav", "kyc"} <= specialist_ids

    def test_kyc_workflow_states_are_canonical(self) -> None:
        assert KYC_WORKFLOW_STATES == (
            "needs_scope",
            "needs_documents",
            "drafting",
            "waiting_on_user",
            "waiting_on_counterparty",
            "completed",
            "blocked",
        )


# ---------------------------------------------------------------------------
# Cross-manifest isolation: agent_ids do not collide
# ---------------------------------------------------------------------------


class TestManifestIsolation:
    def test_kai_and_orchestrator_have_distinct_ids(self) -> None:
        assert KAI_MANIFEST["agent_id"] != ORCHESTRATOR_MANIFEST["id"]
        assert KAI_MANIFEST["agent_id"] != ONE_MANIFEST["agent_id"]
