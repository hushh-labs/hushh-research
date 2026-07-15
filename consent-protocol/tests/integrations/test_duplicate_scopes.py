# SPDX-License-Identifier: Apache-2.0
"""Characterization tests for duplicate handling in consent scope parsing.

Truth-first note (verified against source before writing):

The prompt framing of a comma-delimited "scope ingestion chain" such as
``"read.user,write.device,read.user"`` does NOT match the real repo contract.
``DynamicScopeGenerator.parse_scope`` (consent-protocol/hushh_mcp/consent/
scope_generator.py) is a *single-scope, dot-notation* parser:

  * It requires the ``attr.`` prefix; anything else returns ``(None, None, False)``.
  * It splits ONLY on ``"."`` -- commas are never treated as delimiters. A comma
    inside a path segment is coerced to ``"_"`` by ``_normalize_scope_path`` (each
    non ``[a-z0-9_]`` char becomes ``_``, then edges are stripped).
  * There is NO de-duplication inside a single scope: repeated identical path
    segments are retained in sequence and in order.

The only order-preserving *list-level* de-duplication that exists on an
importable, dependency-free surface is
``AgentManifest.required_scope_strings`` (consent-protocol/hushh_mcp/hushh_adk/
manifest.py), which drops later duplicate scope strings while preserving the
first occurrence order.

These tests pin the ACTUAL behavior so future refactors that silently introduce
comma-splitting, reordering, or de-duplication are caught.
"""

from hushh_mcp.consent.scope_generator import DynamicScopeGenerator
from hushh_mcp.hushh_adk.manifest import AgentManifest, AgentToolConfig

GEN = DynamicScopeGenerator()


class TestParseScopeDuplicateSegments:
    """parse_scope retains duplicate dot segments in order (no de-dup)."""

    def test_repeated_leaf_segment_is_retained_not_deduped(self):
        # attr.<domain>.<path...> -> duplicate 'profile' segments both survive.
        domain, path, is_wildcard = GEN.parse_scope("attr.financial.profile.profile")
        assert domain == "financial"
        assert path == "profile.profile"  # both duplicates retained, in order
        assert is_wildcard is False

    def test_duplicate_domain_and_key_repeat_preserves_sequence(self):
        domain, path, is_wildcard = GEN.parse_scope("attr.user.read.write.read")
        assert domain == "user"
        # Order preserved exactly; the trailing 'read' is NOT collapsed into the first.
        assert path == "read.write.read"
        assert is_wildcard is False

    def test_wildcard_with_duplicate_intermediate_segments(self):
        domain, path, is_wildcard = GEN.parse_scope("attr.device.telemetry.telemetry.*")
        assert domain == "device"
        assert path == "telemetry.telemetry"  # duplicates retained before the wildcard
        assert is_wildcard is True


class TestParseScopeCommaIsNotADelimiter:
    """Commas are folded into path tokens; they never split scopes."""

    def test_comma_payload_without_prefix_is_rejected(self):
        # The prompt-style "read.user,write.device,read.user" lacks the attr. prefix.
        assert GEN.parse_scope("read.user,write.device,read.user") == (None, None, False)

    def test_comma_inside_attr_scope_is_coerced_to_underscore(self):
        # With the required prefix, commas become '_' inside a single path segment.
        domain, path, is_wildcard = GEN.parse_scope("attr.user.read,write,read")
        assert domain == "user"
        # One segment, commas normalized to underscores -> proves no comma-splitting.
        assert path == "read_write_read"
        assert is_wildcard is False


class TestRequiredScopeStringsListDedup:
    """AgentManifest.required_scope_strings de-dups a list, preserving first order."""

    def test_duplicate_scopes_collapse_but_keep_first_occurrence_order(self):
        manifest = AgentManifest(
            id="dup-agent",
            name="Dup Agent",
            description="Characterization fixture agent.",
            system_instruction="Test agent.",
            required_scopes=["attr.user.read", "attr.device.write", "attr.user.read"],
            tools=[
                AgentToolConfig(
                    name="tool_fn",
                    description="Duplicate-scope tool.",
                    py_func="pkg.mod.tool_fn",
                    required_scope="attr.device.write",  # duplicate of an agent scope
                )
            ],
        )
        # Later duplicates (agent list + tool) are dropped; first-seen order preserved.
        assert manifest.required_scope_strings() == [
            "attr.user.read",
            "attr.device.write",
        ]

    def test_unique_tool_scope_appended_after_agent_scopes(self):
        manifest = AgentManifest(
            id="mixed-agent",
            name="Mixed Agent",
            description="Characterization fixture agent.",
            system_instruction="Test agent.",
            required_scopes=["attr.user.read", "attr.user.read"],
            tools=[
                AgentToolConfig(
                    name="a",
                    description="Tool A.",
                    py_func="pkg.mod.a",
                    required_scope="attr.location.read",
                ),
                AgentToolConfig(
                    name="b",
                    description="Tool B.",
                    py_func="pkg.mod.b",
                    required_scope="attr.location.read",
                ),
            ],
        )
        assert manifest.required_scope_strings() == [
            "attr.user.read",
            "attr.location.read",
        ]
