"""
Pure unit tests for normalize_tool_groups() and visible_tool_names_for_groups()
in hushh_mcp/services/developer_registry_service.py.

These two functions are the critical developer-API authorization gate: they
determine which MCP tools a given developer key is allowed to call.  Despite
being pure (no DB, no network, no side effects), they had zero dedicated test
coverage before this file.

Functions under test
--------------------
normalize_tool_groups(raw_groups)
    - Accepts str (comma-sep or JSON array), list/tuple/set, or anything else
    - Returns a tuple of known group keys, deduplicated, in input order
    - Falls back to DEFAULT_PUBLIC_TOOL_GROUPS for None / empty / all-unknown

visible_tool_names_for_groups(tool_groups)
    - Delegates to normalize_tool_groups, then maps groups → tool names via TOOL_CATALOG
    - Returns a deduplicated tuple of tool name strings

Constants exercised
-------------------
KNOWN_TOOL_GROUPS = ("core_consent", "ria_read", "kai_voice", "internal_only")
DEFAULT_PUBLIC_TOOL_GROUPS = ("core_consent",)
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.developer_registry_service import (
    DEFAULT_PUBLIC_TOOL_GROUPS,
    KNOWN_TOOL_GROUPS,
    TOOL_CATALOG,
    TOOL_GROUP_CORE_CONSENT,
    TOOL_GROUP_INTERNAL_ONLY,
    TOOL_GROUP_KAI_VOICE,
    TOOL_GROUP_RIA_READ,
    normalize_tool_groups,
    visible_tool_names_for_groups,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ALL_GROUPS = list(KNOWN_TOOL_GROUPS)


# ===========================================================================
# normalize_tool_groups — None / falsy inputs
# ===========================================================================


class TestNormalizeToolGroupsNullFalsy:
    def test_none_returns_default(self):
        assert normalize_tool_groups(None) == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_empty_string_returns_default(self):
        assert normalize_tool_groups("") == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_whitespace_only_string_returns_default(self):
        assert normalize_tool_groups("   ") == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_empty_list_returns_default(self):
        assert normalize_tool_groups([]) == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_empty_tuple_returns_default(self):
        assert normalize_tool_groups(()) == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_empty_set_returns_default(self):
        assert normalize_tool_groups(set()) == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_integer_returns_default(self):
        assert normalize_tool_groups(42) == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_bool_returns_default(self):
        assert normalize_tool_groups(True) == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_dict_returns_default(self):
        assert normalize_tool_groups({"group": "kai_voice"}) == DEFAULT_PUBLIC_TOOL_GROUPS


# ===========================================================================
# normalize_tool_groups — single valid group, various representations
# ===========================================================================


class TestNormalizeToolGroupsSingleGroup:
    @pytest.mark.parametrize("group", ALL_GROUPS)
    def test_string_single_known_group(self, group: str):
        result = normalize_tool_groups(group)
        assert result == (group,)

    @pytest.mark.parametrize("group", ALL_GROUPS)
    def test_list_single_known_group(self, group: str):
        result = normalize_tool_groups([group])
        assert result == (group,)

    @pytest.mark.parametrize("group", ALL_GROUPS)
    def test_tuple_single_known_group(self, group: str):
        result = normalize_tool_groups((group,))
        assert result == (group,)

    @pytest.mark.parametrize("group", ALL_GROUPS)
    def test_set_single_known_group(self, group: str):
        result = normalize_tool_groups({group})
        assert result == (group,)

    def test_string_with_leading_trailing_whitespace(self):
        result = normalize_tool_groups("  kai_voice  ")
        assert result == (TOOL_GROUP_KAI_VOICE,)

    def test_list_item_with_whitespace(self):
        result = normalize_tool_groups([" ria_read "])
        assert result == (TOOL_GROUP_RIA_READ,)


# ===========================================================================
# normalize_tool_groups — comma-separated strings
# ===========================================================================


class TestNormalizeToolGroupsCommaSep:
    def test_two_valid_groups_comma_sep(self):
        result = normalize_tool_groups("kai_voice,ria_read")
        assert set(result) == {TOOL_GROUP_KAI_VOICE, TOOL_GROUP_RIA_READ}
        assert len(result) == 2

    def test_comma_sep_with_spaces(self):
        result = normalize_tool_groups("kai_voice , ria_read")
        assert set(result) == {TOOL_GROUP_KAI_VOICE, TOOL_GROUP_RIA_READ}

    def test_comma_sep_order_preserved(self):
        result = normalize_tool_groups("ria_read,kai_voice")
        assert result[0] == TOOL_GROUP_RIA_READ
        assert result[1] == TOOL_GROUP_KAI_VOICE

    def test_comma_sep_deduplication(self):
        result = normalize_tool_groups("kai_voice,kai_voice")
        assert result == (TOOL_GROUP_KAI_VOICE,)

    def test_comma_sep_unknown_group_filtered_out(self):
        result = normalize_tool_groups("kai_voice,unknown_group")
        assert result == (TOOL_GROUP_KAI_VOICE,)

    def test_comma_sep_all_unknown_returns_default(self):
        result = normalize_tool_groups("bad_group,another_bad")
        assert result == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_comma_sep_empty_segments_skipped(self):
        result = normalize_tool_groups("kai_voice,,ria_read")
        assert set(result) == {TOOL_GROUP_KAI_VOICE, TOOL_GROUP_RIA_READ}

    def test_all_four_groups_comma_sep(self):
        raw = ",".join(KNOWN_TOOL_GROUPS)
        result = normalize_tool_groups(raw)
        assert set(result) == set(KNOWN_TOOL_GROUPS)
        assert len(result) == 4


# ===========================================================================
# normalize_tool_groups — JSON array strings
# ===========================================================================


class TestNormalizeToolGroupsJsonArray:
    def test_json_array_single_group(self):
        result = normalize_tool_groups('["kai_voice"]')
        assert result == (TOOL_GROUP_KAI_VOICE,)

    def test_json_array_multiple_groups(self):
        result = normalize_tool_groups('["kai_voice", "ria_read"]')
        assert set(result) == {TOOL_GROUP_KAI_VOICE, TOOL_GROUP_RIA_READ}

    def test_json_array_deduplication(self):
        result = normalize_tool_groups('["kai_voice", "kai_voice"]')
        assert result == (TOOL_GROUP_KAI_VOICE,)

    def test_json_array_with_unknown_group_filtered(self):
        result = normalize_tool_groups('["kai_voice", "nonexistent"]')
        assert result == (TOOL_GROUP_KAI_VOICE,)

    def test_json_array_all_unknown_returns_default(self):
        result = normalize_tool_groups('["bad1", "bad2"]')
        assert result == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_json_array_empty_returns_default(self):
        result = normalize_tool_groups("[]")
        assert result == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_malformed_json_array_falls_back_to_comma_sep(self):
        # "[kai_voice" is not valid JSON → falls back to comma-sep splitting
        # The whole string is one candidate which is not a known group → default
        result = normalize_tool_groups("[kai_voice")
        assert result == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_json_array_with_whitespace_around_bracket(self):
        # starts with '[' after strip — parses as JSON
        result = normalize_tool_groups('  ["core_consent"]  ')
        # strip → '["core_consent"]' → JSON parse succeeds
        assert result == (TOOL_GROUP_CORE_CONSENT,)


# ===========================================================================
# normalize_tool_groups — list / tuple / set inputs
# ===========================================================================


class TestNormalizeToolGroupsCollections:
    def test_list_two_groups(self):
        result = normalize_tool_groups([TOOL_GROUP_KAI_VOICE, TOOL_GROUP_RIA_READ])
        assert set(result) == {TOOL_GROUP_KAI_VOICE, TOOL_GROUP_RIA_READ}

    def test_tuple_two_groups(self):
        result = normalize_tool_groups((TOOL_GROUP_KAI_VOICE, TOOL_GROUP_RIA_READ))
        assert set(result) == {TOOL_GROUP_KAI_VOICE, TOOL_GROUP_RIA_READ}

    def test_list_deduplication(self):
        result = normalize_tool_groups([TOOL_GROUP_KAI_VOICE, TOOL_GROUP_KAI_VOICE])
        assert result == (TOOL_GROUP_KAI_VOICE,)

    def test_list_order_preserved(self):
        result = normalize_tool_groups(
            [TOOL_GROUP_INTERNAL_ONLY, TOOL_GROUP_CORE_CONSENT, TOOL_GROUP_RIA_READ]
        )
        assert result[0] == TOOL_GROUP_INTERNAL_ONLY
        assert result[1] == TOOL_GROUP_CORE_CONSENT
        assert result[2] == TOOL_GROUP_RIA_READ

    def test_list_unknown_items_filtered(self):
        result = normalize_tool_groups(["unknown_group", TOOL_GROUP_KAI_VOICE])
        assert result == (TOOL_GROUP_KAI_VOICE,)

    def test_list_all_unknown_returns_default(self):
        result = normalize_tool_groups(["bad_a", "bad_b"])
        assert result == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_list_non_string_items_coerced(self):
        # list items are str(item).strip() — non-string items become their str repr
        # which won't match any known group → falls back to default
        result = normalize_tool_groups([123, None])
        assert result == DEFAULT_PUBLIC_TOOL_GROUPS

    def test_list_mixed_valid_and_unknown(self):
        result = normalize_tool_groups([TOOL_GROUP_CORE_CONSENT, "unknown"])
        assert result == (TOOL_GROUP_CORE_CONSENT,)


# ===========================================================================
# normalize_tool_groups — return type contract
# ===========================================================================


class TestNormalizeToolGroupsReturnType:
    def test_always_returns_tuple(self):
        assert isinstance(normalize_tool_groups(None), tuple)
        assert isinstance(normalize_tool_groups("kai_voice"), tuple)
        assert isinstance(normalize_tool_groups([TOOL_GROUP_RIA_READ]), tuple)
        assert isinstance(normalize_tool_groups(""), tuple)

    def test_result_contains_only_known_groups(self):
        for raw in [
            "kai_voice,unknown",
            ["bad", TOOL_GROUP_RIA_READ],
            '["core_consent", "evil"]',
        ]:
            result = normalize_tool_groups(raw)
            for g in result:
                assert g in KNOWN_TOOL_GROUPS, f"Unexpected group {g!r} in result for {raw!r}"

    def test_default_is_core_consent_only(self):
        assert DEFAULT_PUBLIC_TOOL_GROUPS == (TOOL_GROUP_CORE_CONSENT,)


# ===========================================================================
# visible_tool_names_for_groups
# ===========================================================================


class TestVisibleToolNamesForGroups:
    def test_none_returns_core_consent_tools(self):
        result = visible_tool_names_for_groups(None)
        # Should contain all core_consent tools
        core_tools = [e["name"] for e in TOOL_CATALOG if e["group"] == TOOL_GROUP_CORE_CONSENT]
        for name in core_tools:
            assert name in result

    def test_core_consent_group_returns_its_tools(self):
        result = visible_tool_names_for_groups([TOOL_GROUP_CORE_CONSENT])
        assert "discover_user_domains" in result
        assert "request_consent" in result
        assert "check_consent_status" in result
        assert "validate_token" in result

    def test_ria_read_group_returns_its_tools(self):
        result = visible_tool_names_for_groups([TOOL_GROUP_RIA_READ])
        assert "list_ria_profiles" in result
        assert "get_ria_profile" in result
        # Core consent tools must NOT appear
        assert "request_consent" not in result

    def test_kai_voice_group_returns_its_tools(self):
        result = visible_tool_names_for_groups([TOOL_GROUP_KAI_VOICE])
        assert "kai_analyze_stock" in result
        assert "kai_open_dashboard" in result
        assert "kai_navigate_back" in result
        assert "request_consent" not in result

    def test_internal_only_group_returns_delegate_tool(self):
        result = visible_tool_names_for_groups([TOOL_GROUP_INTERNAL_ONLY])
        assert "delegate_to_agent" in result

    def test_two_groups_returns_union_of_tools(self):
        result = visible_tool_names_for_groups([TOOL_GROUP_CORE_CONSENT, TOOL_GROUP_RIA_READ])
        # Core consent tools present
        assert "request_consent" in result
        # RIA tools present
        assert "list_ria_profiles" in result

    def test_all_groups_returns_all_catalog_tools(self):
        result = visible_tool_names_for_groups(list(KNOWN_TOOL_GROUPS))
        all_catalog_names = {e["name"] for e in TOOL_CATALOG}
        assert set(result) == all_catalog_names

    def test_no_duplicates_in_result(self):
        result = visible_tool_names_for_groups(list(KNOWN_TOOL_GROUPS))
        assert len(result) == len(set(result))

    def test_returns_tuple(self):
        result = visible_tool_names_for_groups([TOOL_GROUP_CORE_CONSENT])
        assert isinstance(result, tuple)

    def test_unknown_group_yields_default_tools(self):
        # unknown groups normalize to DEFAULT_PUBLIC_TOOL_GROUPS = core_consent
        result = visible_tool_names_for_groups(["totally_unknown"])
        assert "request_consent" in result

    def test_string_input_accepted(self):
        result = visible_tool_names_for_groups("kai_voice")
        assert "kai_analyze_stock" in result

    def test_catalog_integrity_every_tool_in_a_known_group(self):
        """Every entry in TOOL_CATALOG must belong to a KNOWN_TOOL_GROUPS group."""
        for entry in TOOL_CATALOG:
            assert entry["group"] in KNOWN_TOOL_GROUPS, (
                f"Tool '{entry['name']}' belongs to unknown group '{entry['group']}'"
            )
