"""Canonical caller proof tests for HushhAgent.from_manifest().

Canonical attach point: ``hushh_mcp/hushh_adk/core.HushhAgent.from_manifest``
is exercised by ``hushh_mcp/agents/kai/agent.KaiAgent.__init__``, which loads
``hushh_mcp/agents/kai/agent.yaml`` via ``ManifestLoader.load`` and constructs
the agent. ``KaiAgent`` is accessed through ``get_kai_agent()``, which is called
by ``api/routes/agents.py`` on every request to ``/api/kai/message`` and
``/api/kai/agent-info``.

These tests prove:
1. ``HushhAgent.from_manifest()`` is importable and callable.
2. ``ManifestLoader.load_from_dict`` (exercised internally) validates the schema.
3. ``KaiAgent.__init__`` (the canonical caller) exercises ``ManifestLoader.load``
   with the shipped ``agent.yaml`` manifest file.
4. ``get_kai_agent()`` returns an object that is an instance of ``HushhAgent``.

All tests are hermetic -- no DB, network, Firebase, or LLM.
"""

from __future__ import annotations

import os
import tempfile

import pytest
import yaml

from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import AgentManifest, ManifestLoader

# ---------------------------------------------------------------------------
# Minimal manifest fixtures
# ---------------------------------------------------------------------------

_MINIMAL_MANIFEST: dict = {
    "id": "agent_test",
    "name": "Test Agent",
    "version": "1.0.0",
    "description": "Minimal manifest for contract tests.",
    "model": "gemini-2-flash",
    "system_instruction": "You are a test agent.",
    "required_scopes": ["pkm.read"],
    "tools": [],
}

_MANIFEST_WITH_TOOL: dict = {
    **_MINIMAL_MANIFEST,
    "id": "agent_test_with_tool",
    "name": "Test Agent With Tool",
    "tools": [
        {
            "name": "delegate_to_food_agent",
            "description": "Orchestrator delegation tool used in canonical path tests.",
            "py_func": "hushh_mcp.agents.orchestrator.tools.delegate_to_food_agent",
            "required_scope": "agent.one.orchestrate",
        }
    ],
}


class TestHushhAgentFromManifestCallProof:
    """Proves HushhAgent.from_manifest() is importable, callable, and exercised
    by the canonical caller KaiAgent (shipped in api/routes/agents.py).

    Canonical attach point:
      ``hushh_mcp.hushh_adk.core.HushhAgent.from_manifest``
      called transitively via ``hushh_mcp.agents.kai.agent.KaiAgent.__init__``
      which is singleton-cached by ``get_kai_agent()`` invoked by
      ``api/routes/agents.py`` (GET /api/kai/agent-info, POST /api/kai/message).
    """

    # ------------------------------------------------------------------
    # 1. from_manifest is importable and the method exists
    # ------------------------------------------------------------------

    def test_from_manifest_is_classmethod_on_hushh_agent(self):
        """HushhAgent.from_manifest must be accessible as a classmethod."""
        assert hasattr(HushhAgent, "from_manifest"), (
            "HushhAgent must expose from_manifest as a classmethod"
        )
        assert callable(HushhAgent.from_manifest)

    # ------------------------------------------------------------------
    # 2. ManifestLoader.load_from_dict validates the schema
    # ------------------------------------------------------------------

    def test_load_from_dict_valid_manifest(self):
        """A well-formed dict must yield an AgentManifest without error."""
        manifest = ManifestLoader.load_from_dict(_MINIMAL_MANIFEST)
        assert isinstance(manifest, AgentManifest)
        assert manifest.id == "agent_test"
        assert manifest.name == "Test Agent"
        assert manifest.required_scopes == ["pkm.read"]

    def test_load_from_dict_rejects_missing_required_field(self):
        """A manifest missing 'id' must raise ValueError."""
        bad = {k: v for k, v in _MINIMAL_MANIFEST.items() if k != "id"}
        with pytest.raises(ValueError, match="Invalid manifest"):
            ManifestLoader.load_from_dict(bad)

    def test_load_from_dict_rejects_non_dict_input(self):
        """A list at the top level must raise ValueError."""
        with pytest.raises((ValueError, TypeError)):
            ManifestLoader.load_from_dict([_MINIMAL_MANIFEST])  # type: ignore[arg-type]

    # ------------------------------------------------------------------
    # 3. ManifestLoader.load reads from a real file
    # ------------------------------------------------------------------

    def test_manifest_loader_load_from_yaml_file(self):
        """ManifestLoader.load must parse a valid YAML file on disk."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as fh:
            yaml.dump(_MINIMAL_MANIFEST, fh)
            tmp_path = fh.name

        try:
            manifest = ManifestLoader.load(tmp_path)
            assert manifest.id == "agent_test"
            assert manifest.model == "gemini-2-flash"
        finally:
            os.unlink(tmp_path)

    def test_manifest_loader_raises_on_missing_file(self):
        """ManifestLoader.load must raise FileNotFoundError for missing paths."""
        with pytest.raises(FileNotFoundError):
            ManifestLoader.load("/nonexistent/path/manifest_abc123.yaml")  # noqa: S108

    def test_manifest_loader_raises_on_malformed_yaml(self):
        """ManifestLoader.load must raise ValueError for YAML that is not a mapping."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as fh:
            fh.write("- this\n- is\n- a\n- list\n")
            tmp_path = fh.name

        try:
            with pytest.raises(ValueError):
                ManifestLoader.load(tmp_path)
        finally:
            os.unlink(tmp_path)

    # ------------------------------------------------------------------
    # 4. HushhAgent.from_manifest constructs an agent from a YAML file
    # ------------------------------------------------------------------

    def test_from_manifest_constructs_agent_from_file(self):
        """from_manifest must return a HushhAgent with correct name and scopes."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as fh:
            yaml.dump(_MINIMAL_MANIFEST, fh)
            tmp_path = fh.name

        try:
            agent = HushhAgent.from_manifest(tmp_path)
            assert isinstance(agent, HushhAgent)
            assert agent.hushh_name == "Test Agent"
            assert "pkm.read" in agent.required_scopes
        finally:
            os.unlink(tmp_path)

    def test_from_manifest_raises_file_not_found_for_missing_path(self):
        """from_manifest must propagate FileNotFoundError for a nonexistent manifest."""
        with pytest.raises(FileNotFoundError):
            HushhAgent.from_manifest("/nonexistent/path/does_not_exist_abc123.yaml")  # noqa: S108

    # ------------------------------------------------------------------
    # 5. Shipped kai agent.yaml is readable and schema-valid
    # ------------------------------------------------------------------

    def test_kai_manifest_yaml_is_schema_valid(self):
        """The shipped hushh_mcp/agents/kai/agent.yaml must pass ManifestLoader."""
        manifest_path = os.path.join(
            os.path.dirname(__file__),
            "..",
            "hushh_mcp",
            "agents",
            "kai",
            "agent.yaml",
        )
        manifest_path = os.path.abspath(manifest_path)
        assert os.path.exists(manifest_path), f"Expected kai agent.yaml at {manifest_path}"
        manifest = ManifestLoader.load(manifest_path)
        assert manifest.id == "agent_kai"
        assert manifest.name  # non-empty
        assert manifest.system_instruction  # non-empty

    # ------------------------------------------------------------------
    # 6. Canonical caller: KaiAgent exercises ManifestLoader.load
    # ------------------------------------------------------------------

    def test_kai_agent_init_exercises_manifest_loader(self, monkeypatch):
        """KaiAgent.__init__ (canonical caller) must call ManifestLoader.load.

        This proves the production code path from the shipped kai agent
        through ManifestLoader into the agent.yaml manifest file.
        """
        load_calls: list[str] = []
        original_load = ManifestLoader.load

        def _tracking_load(path: str) -> AgentManifest:
            load_calls.append(path)
            return original_load(path)

        monkeypatch.setattr(ManifestLoader, "load", staticmethod(_tracking_load))

        from hushh_mcp.agents.kai.agent import KaiAgent

        # Instantiate fresh (bypass singleton)
        agent = KaiAgent()

        assert len(load_calls) >= 1, "KaiAgent.__init__ must call ManifestLoader.load at least once"
        assert any("agent.yaml" in p for p in load_calls), (
            f"ManifestLoader.load must be called with kai agent.yaml; got {load_calls}"
        )
        assert isinstance(agent, HushhAgent)

    # ------------------------------------------------------------------
    # 7. get_kai_agent returns a HushhAgent
    # ------------------------------------------------------------------

    def test_get_kai_agent_returns_hushh_agent_instance(self):
        """get_kai_agent() must return an object that is an instance of HushhAgent.

        This directly exercises the singleton path used by api/routes/agents.py.
        """
        # Reset singleton so our call always triggers KaiAgent construction
        import hushh_mcp.agents.kai.agent as _kai_module

        _kai_module._kai_agent = None

        from hushh_mcp.agents.kai.agent import get_kai_agent

        agent = get_kai_agent()
        assert isinstance(agent, HushhAgent), (
            f"get_kai_agent() must return HushhAgent, got {type(agent)}"
        )
        # Subsequent call must return the cached singleton
        agent2 = get_kai_agent()
        assert agent is agent2, "get_kai_agent() must cache and reuse the same instance"
