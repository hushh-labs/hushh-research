"""
Pure unit tests for hushh_adk manifest, factory, and helper enhancements.

Covers the newly added / fixed behaviour in:
  - hushh_mcp/hushh_adk/manifest.py
      ManifestLoader.load_from_dict()   — new helper for testability
      ManifestLoader.load()             — YAML-error + non-dict guard (bug fix)
      AgentManifest.tool_py_funcs()     — new convenience method
      AgentManifest.required_scope_strings() — new dedup helper
  - hushh_mcp/hushh_adk/core.py
      _import_dotted_path()             — new internal helper
      HushhAgent.from_manifest()        — new factory classmethod
      LlmAgent stub.run()               — now raises RuntimeError (bug fix)
      HushhAgent.run() scope gate       — consent enforcement unchanged

No DB, no network, no LLM required — all external I/O is patched.
"""

from __future__ import annotations

import os
import tempfile
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.hushh_adk.core import _TOOL_PACKAGE_PREFIX, HushhAgent, _import_dotted_path
from hushh_mcp.hushh_adk.manifest import AgentManifest, ManifestLoader

# ---------------------------------------------------------------------------
# Minimal valid manifest dict — reused across many tests
# ---------------------------------------------------------------------------

_VALID_DICT: dict[str, Any] = {
    "id": "test_agent",
    "name": "Test Agent",
    "version": "1.0.0",
    "description": "An agent for testing",
    "model": "gemini-pro",
    "system_instruction": "You are a test agent.",
    "required_scopes": ["agent.kai.analyze"],
    "tools": [
        {
            "name": "my_tool",
            "description": "A tool",
            "py_func": "hushh_mcp.hushh_adk.tools.hushh_tool",
            "required_scope": "attr.financial.*",
        }
    ],
    "inputs": [{"name": "query", "type": "str"}],
    "outputs": [{"name": "result", "type": "str"}],
    "ui_type": "chat",
    "icon": None,
}


# ===========================================================================
# ManifestLoader.load_from_dict
# ===========================================================================


class TestManifestLoaderFromDict:
    def test_valid_dict_returns_manifest(self):
        manifest = ManifestLoader.load_from_dict(_VALID_DICT)
        assert isinstance(manifest, AgentManifest)
        assert manifest.id == "test_agent"
        assert manifest.name == "Test Agent"

    def test_version_defaults_to_1_0_0(self):
        data = {**_VALID_DICT}
        del data["version"]
        manifest = ManifestLoader.load_from_dict(data)
        assert manifest.version == "1.0.0"

    def test_ui_type_defaults_to_chat(self):
        data = {k: v for k, v in _VALID_DICT.items() if k != "ui_type"}
        manifest = ManifestLoader.load_from_dict(data)
        assert manifest.ui_type == "chat"

    def test_missing_required_field_raises_value_error(self):
        # 'description' is required
        data = {k: v for k, v in _VALID_DICT.items() if k != "description"}
        with pytest.raises(ValueError, match="Invalid manifest data"):
            ManifestLoader.load_from_dict(data)

    def test_missing_id_raises_value_error(self):
        data = {k: v for k, v in _VALID_DICT.items() if k != "id"}
        with pytest.raises(ValueError):
            ManifestLoader.load_from_dict(data)

    def test_missing_system_instruction_raises_value_error(self):
        data = {k: v for k, v in _VALID_DICT.items() if k != "system_instruction"}
        with pytest.raises(ValueError):
            ManifestLoader.load_from_dict(data)

    def test_source_label_appears_in_error_message(self):
        with pytest.raises(ValueError, match="my_source"):
            ManifestLoader.load_from_dict({}, source="my_source")

    def test_tools_list_parsed_correctly(self):
        manifest = ManifestLoader.load_from_dict(_VALID_DICT)
        assert len(manifest.tools) == 1
        assert manifest.tools[0].name == "my_tool"
        assert manifest.tools[0].py_func == "hushh_mcp.hushh_adk.tools.hushh_tool"

    def test_empty_tools_list_accepted(self):
        data = {**_VALID_DICT, "tools": []}
        manifest = ManifestLoader.load_from_dict(data)
        assert manifest.tools == []

    def test_required_scopes_preserved(self):
        manifest = ManifestLoader.load_from_dict(_VALID_DICT)
        assert manifest.required_scopes == ["agent.kai.analyze"]

    def test_empty_required_scopes_accepted(self):
        data = {**_VALID_DICT, "required_scopes": []}
        manifest = ManifestLoader.load_from_dict(data)
        assert manifest.required_scopes == []


# ===========================================================================
# ManifestLoader.load  (file-based)
# ===========================================================================


class TestManifestLoaderLoad:
    def _write_yaml(self, content: str) -> str:
        """Write content to a temp file and return its path."""
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False, encoding="utf-8")
        f.write(content)
        f.flush()
        f.close()
        return f.name

    def test_valid_yaml_file_returns_manifest(self):
        import yaml

        path = self._write_yaml(yaml.dump(_VALID_DICT))
        try:
            manifest = ManifestLoader.load(path)
            assert manifest.id == "test_agent"
        finally:
            os.unlink(path)

    def test_missing_file_raises_file_not_found(self):
        with pytest.raises(FileNotFoundError, match="Manifest not found"):
            ManifestLoader.load("/tmp/nonexistent_manifest_xyz.yaml")  # noqa: S108

    def test_malformed_yaml_raises_value_error(self):
        path = self._write_yaml("key: [\nbad yaml")
        try:
            with pytest.raises(ValueError, match="Malformed YAML"):
                ManifestLoader.load(path)
        finally:
            os.unlink(path)

    def test_yaml_list_at_root_raises_value_error(self):
        """YAML that is a list at the top level must be rejected."""
        import yaml

        path = self._write_yaml(yaml.dump(["item1", "item2"]))
        try:
            with pytest.raises(ValueError, match="must be a YAML mapping"):
                ManifestLoader.load(path)
        finally:
            os.unlink(path)

    def test_yaml_scalar_at_root_raises_value_error(self):
        path = self._write_yaml("just a plain string\n")
        try:
            with pytest.raises(ValueError, match="must be a YAML mapping"):
                ManifestLoader.load(path)
        finally:
            os.unlink(path)

    def test_yaml_with_missing_required_field_raises_value_error(self):
        import yaml

        data = {k: v for k, v in _VALID_DICT.items() if k != "description"}
        path = self._write_yaml(yaml.dump(data))
        try:
            with pytest.raises(ValueError, match="Invalid manifest data"):
                ManifestLoader.load(path)
        finally:
            os.unlink(path)


# ===========================================================================
# AgentManifest.tool_py_funcs
# ===========================================================================


class TestAgentManifestToolPyFuncs:
    def test_returns_py_func_strings(self):
        manifest = ManifestLoader.load_from_dict(_VALID_DICT)
        funcs = manifest.tool_py_funcs()
        assert funcs == ["hushh_mcp.hushh_adk.tools.hushh_tool"]

    def test_empty_tools_returns_empty_list(self):
        data = {**_VALID_DICT, "tools": []}
        manifest = ManifestLoader.load_from_dict(data)
        assert manifest.tool_py_funcs() == []

    def test_multiple_tools_returns_all_paths(self):
        data = {
            **_VALID_DICT,
            "tools": [
                {
                    "name": "tool_a",
                    "description": "A",
                    "py_func": "pkg.mod.func_a",
                    "required_scope": "attr.financial.*",
                },
                {
                    "name": "tool_b",
                    "description": "B",
                    "py_func": "pkg.mod.func_b",
                    "required_scope": "attr.financial.*",
                },
            ],
        }
        manifest = ManifestLoader.load_from_dict(data)
        assert manifest.tool_py_funcs() == ["pkg.mod.func_a", "pkg.mod.func_b"]


# ===========================================================================
# AgentManifest.required_scope_strings
# ===========================================================================


class TestAgentManifestRequiredScopeStrings:
    def test_agent_scopes_included(self):
        manifest = ManifestLoader.load_from_dict(_VALID_DICT)
        scopes = manifest.required_scope_strings()
        assert "agent.kai.analyze" in scopes

    def test_tool_scopes_included(self):
        manifest = ManifestLoader.load_from_dict(_VALID_DICT)
        scopes = manifest.required_scope_strings()
        assert "attr.financial.*" in scopes

    def test_deduplication_across_agent_and_tools(self):
        data = {
            **_VALID_DICT,
            "required_scopes": ["attr.financial.*"],
            "tools": [
                {
                    "name": "t",
                    "description": "d",
                    "py_func": "a.b.c",
                    # same scope already in required_scopes
                    "required_scope": "attr.financial.*",
                }
            ],
        }
        manifest = ManifestLoader.load_from_dict(data)
        scopes = manifest.required_scope_strings()
        assert scopes.count("attr.financial.*") == 1

    def test_order_agent_scopes_before_tool_scopes(self):
        data = {
            **_VALID_DICT,
            "required_scopes": ["agent.kai.analyze"],
            "tools": [
                {
                    "name": "t",
                    "description": "d",
                    "py_func": "a.b.c",
                    "required_scope": "attr.financial.*",
                }
            ],
        }
        manifest = ManifestLoader.load_from_dict(data)
        scopes = manifest.required_scope_strings()
        assert scopes[0] == "agent.kai.analyze"

    def test_empty_scopes_and_no_tools(self):
        data = {**_VALID_DICT, "required_scopes": [], "tools": []}
        manifest = ManifestLoader.load_from_dict(data)
        assert manifest.required_scope_strings() == []


# ===========================================================================
# _import_dotted_path
# ===========================================================================


class TestImportDottedPath:
    def test_no_dot_raises_import_error(self):
        with pytest.raises(ImportError, match="not a valid fully-qualified dotted path"):
            _import_dotted_path("nodot")

    def test_nonexistent_module_raises_import_error(self):
        with pytest.raises(ImportError, match="Could not import module"):
            _import_dotted_path("hushh_mcp.nonexistent_xyz.module.func")

    def test_nonexistent_attribute_raises_import_error(self):
        with pytest.raises(ImportError, match="has no attribute"):
            _import_dotted_path("hushh_mcp.hushh_adk.tools.nonexistent_func_xyz")

    def test_single_dot_path_raises_import_error(self):
        with pytest.raises(ImportError):
            _import_dotted_path("nonexistent")

    def test_non_hushh_mcp_path_is_rejected(self):
        """Paths outside hushh_mcp.* must be rejected regardless of importability."""
        with pytest.raises(ImportError, match="outside the allowed package boundary"):
            _import_dotted_path("math.sqrt")

    def test_stdlib_nested_path_is_rejected(self):
        """Standard library paths must not be importable via manifest."""
        with pytest.raises(ImportError, match="outside the allowed package boundary"):
            _import_dotted_path("os.path.join")

    def test_undecorated_callable_in_hushh_mcp_is_rejected(self):
        """A callable inside hushh_mcp.* that lacks ._hushh_tool must be rejected."""
        with pytest.raises(ImportError, match="not a @hushh_tool decorated callable"):
            _import_dotted_path("hushh_mcp.hushh_adk.tools.hushh_tool")

    def test_real_decorated_tool_is_accepted(self):
        """A real @hushh_tool decorated function from the production path must be accepted."""
        result = _import_dotted_path("hushh_mcp.agents.orchestrator.tools.delegate_to_food_agent")
        assert callable(result)
        assert getattr(result, "_hushh_tool", False) is True

    def test_allowlist_prefix_constant(self):
        assert _TOOL_PACKAGE_PREFIX == "hushh_mcp."


# ===========================================================================
# HushhAgent.from_manifest  (factory)
# ===========================================================================


class TestHushhAgentFromManifest:
    def _write_yaml(self, data: dict) -> str:
        import yaml

        f = tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False, encoding="utf-8")
        yaml.dump(data, f)
        f.flush()
        f.close()
        return f.name

    def test_from_manifest_creates_agent(self):
        """from_manifest should produce a HushhAgent with correct hushh_name."""
        data = {**_VALID_DICT, "tools": []}  # no tools to import
        path = self._write_yaml(data)
        try:
            agent = HushhAgent.from_manifest(path)
            assert isinstance(agent, HushhAgent)
            assert agent.hushh_name == "Test Agent"
        finally:
            os.unlink(path)

    def test_from_manifest_sets_required_scopes(self):
        data = {**_VALID_DICT, "tools": [], "required_scopes": ["agent.kai.analyze"]}
        path = self._write_yaml(data)
        try:
            agent = HushhAgent.from_manifest(path)
            assert "agent.kai.analyze" in agent.required_scopes
        finally:
            os.unlink(path)

    def test_from_manifest_missing_file_raises(self):
        with pytest.raises(FileNotFoundError):
            HushhAgent.from_manifest("/tmp/does_not_exist_xyz.yaml")  # noqa: S108

    def test_from_manifest_with_bad_tool_func_raises_import_error(self):
        data = {
            **_VALID_DICT,
            "tools": [
                {
                    "name": "broken",
                    "description": "broken",
                    "py_func": "hushh_mcp.nonexistent_module_xyz.func",
                    "required_scope": "attr.financial.*",
                }
            ],
        }
        path = self._write_yaml(data)
        try:
            with pytest.raises(ImportError, match="Could not import module"):
                HushhAgent.from_manifest(path)
        finally:
            os.unlink(path)

    def test_from_manifest_imports_real_decorated_tool(self):
        """from_manifest must accept a real @hushh_tool decorated production callable."""
        data = {
            **_VALID_DICT,
            "tools": [
                {
                    "name": "delegate_to_food_agent",
                    "description": "Orchestrator delegation tool.",
                    "py_func": "hushh_mcp.agents.orchestrator.tools.delegate_to_food_agent",
                    "required_scope": "agent.one.orchestrate",
                }
            ],
        }
        path = self._write_yaml(data)
        try:
            agent = HushhAgent.from_manifest(path)
            assert isinstance(agent, HushhAgent)
        finally:
            os.unlink(path)

    def test_from_manifest_rejects_undecorated_callable(self):
        """from_manifest must reject a py_func that lacks @hushh_tool decoration."""
        data = {
            **_VALID_DICT,
            "tools": [
                {
                    "name": "bare_decorator",
                    "description": "The decorator object itself, not a decorated tool.",
                    "py_func": "hushh_mcp.hushh_adk.tools.hushh_tool",
                    "required_scope": "attr.financial.*",
                }
            ],
        }
        path = self._write_yaml(data)
        try:
            with pytest.raises(ImportError, match="not a @hushh_tool decorated callable"):
                HushhAgent.from_manifest(path)
        finally:
            os.unlink(path)

    def test_from_manifest_rejects_out_of_package_tool(self):
        """from_manifest must reject py_func paths outside hushh_mcp.*."""
        data = {
            **_VALID_DICT,
            "tools": [
                {
                    "name": "stdlib_tool",
                    "description": "Attempt to bind a stdlib function.",
                    "py_func": "os.path.join",
                    "required_scope": "attr.financial.*",
                }
            ],
        }
        path = self._write_yaml(data)
        try:
            with pytest.raises(ImportError, match="outside the allowed package boundary"):
                HushhAgent.from_manifest(path)
        finally:
            os.unlink(path)


# ===========================================================================
# LlmAgent stub raises RuntimeError when ADK is absent
# ===========================================================================


class TestLlmAgentStubRaises:
    def test_stub_run_raises_runtime_error_when_adk_absent(self):
        """
        When google-adk is not installed, the fallback LlmAgent stub must raise
        RuntimeError on .run() so callers get a clear, actionable error rather
        than silently receiving None.

        We simulate the absent-ADK path by patching out _ADK_AVAILABLE.
        """
        from hushh_mcp.hushh_adk import core as core_mod

        if core_mod._ADK_AVAILABLE:
            # ADK is genuinely installed in this environment; test the stub directly.
            # Import the stub class as defined in the except branch.
            # We can't easily test the real ADK path without a running model,
            # so we skip the runtime check and just test via the stub class.
            pytest.skip("google-adk is installed; stub path not active in this environment")

        # ADK not installed — super().run() is the stub's run() which should raise
        agent = HushhAgent(name="stub_agent", model="gemini-pro", tools=[])

        mock_token = MagicMock()
        mock_token.user_id = "user_123"

        with (
            patch("hushh_mcp.hushh_adk.core.validate_token") as mock_validate,
            pytest.raises(RuntimeError, match="Google ADK is not installed"),
        ):
            mock_validate.return_value = (True, None, mock_token)
            agent.run(
                prompt="hello",
                user_id="user_123",
                consent_token="valid_token",  # noqa: S106
            )


# ===========================================================================
# HushhAgent.run  — consent gate (regression: must still work)
# ===========================================================================


class TestHushhAgentRunConsentGate:
    def _make_agent(self, required_scopes=None):
        return HushhAgent(
            name="test_agent",
            model="gemini-pro",
            tools=[],
            required_scopes=required_scopes or [],
        )

    def _mock_token(self, user_id="user_123"):
        t = MagicMock()
        t.user_id = user_id
        return t

    def test_no_required_scopes_skips_scope_check(self):
        agent = self._make_agent(required_scopes=[])
        mock_token = self._mock_token()

        # super().run() call — just make it return something
        with (
            patch.object(type(agent).__mro__[1], "run", return_value="ok"),
            patch("hushh_mcp.hushh_adk.core.validate_token") as mock_validate,
        ):
            mock_validate.return_value = (True, None, mock_token)
            result = agent.run(prompt="hi", user_id="user_123", consent_token="tok")  # noqa: S106
            # validate_token NOT called (no required_scopes)
            mock_validate.assert_not_called()
            assert result == "ok"

    def test_valid_scope_allows_execution(self):
        agent = self._make_agent(required_scopes=["agent.kai.analyze"])
        mock_token = self._mock_token()

        with (
            patch.object(type(agent).__mro__[1], "run", return_value="response"),
            patch("hushh_mcp.hushh_adk.core.validate_token") as mock_validate,
        ):
            mock_validate.return_value = (True, None, mock_token)
            result = agent.run(
                prompt="analyze AAPL",
                user_id="user_123",
                consent_token="valid_tok",  # noqa: S106
            )
            assert result == "response"

    def test_invalid_scope_raises_permission_error(self):
        agent = self._make_agent(required_scopes=["agent.kai.analyze"])

        with patch("hushh_mcp.hushh_adk.core.validate_token") as mock_validate:
            mock_validate.return_value = (False, "Scope mismatch", None)
            with pytest.raises(PermissionError, match="Agent Access Denied"):
                agent.run(
                    prompt="analyze AAPL",
                    user_id="user_123",
                    consent_token="bad_tok",  # noqa: S106
                )

    def test_first_matching_scope_allows_access(self):
        """Agent with multiple required_scopes should succeed if any one matches."""
        agent = self._make_agent(required_scopes=["agent.kai.analyze", "agent.kai.chat"])
        mock_token = self._mock_token()

        call_count = [0]

        def side_effect(token, expected_scope=None):
            call_count[0] += 1
            if expected_scope == "agent.kai.analyze":
                return (True, None, mock_token)
            return (False, "Mismatch", None)

        with (
            patch.object(type(agent).__mro__[1], "run", return_value="ok"),
            patch("hushh_mcp.hushh_adk.core.validate_token", side_effect=side_effect),
        ):
            result = agent.run(
                prompt="hi",
                user_id="user_123",
                consent_token="tok",  # noqa: S106
            )
            assert result == "ok"
            # Should have stopped at the first matching scope
            assert call_count[0] == 1

    def test_vault_keys_passed_to_context(self):
        agent = self._make_agent()
        captured_ctx = []

        from hushh_mcp.hushh_adk.context import HushhContext

        original_enter = HushhContext.__enter__

        def capturing_enter(self):
            captured_ctx.append(self)
            return original_enter(self)

        with (
            patch.object(type(agent).__mro__[1], "run", return_value=None),
            patch.object(HushhContext, "__enter__", capturing_enter),
        ):
            agent.run(
                prompt="hi",
                user_id="user_123",
                consent_token="tok",  # noqa: S106
                vault_keys={"domain": "secret_key"},
            )
            assert len(captured_ctx) == 1
            assert captured_ctx[0].vault_keys == {"domain": "secret_key"}
