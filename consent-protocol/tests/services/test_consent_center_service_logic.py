# tests/services/test_consent_center_service_logic.py
"""
Consent Center Service Logic Tests
===================================

Tests for the pure static/class methods in ConsentCenterService.

These methods handle consent status mapping, counterpart resolution,
UI label generation, and entry filtering -- all without database access.
These are critical for the consent UI to render correct state.
"""

import pytest

from hushh_mcp.services.consent_center_service import ConsentCenterService


# ============================================================================
# _metadata
# ============================================================================


class TestMetadata:
    """Tests for metadata normalization."""

    def test_returns_dict_unchanged(self):
        data = {"key": "value"}
        assert ConsentCenterService._metadata(data) == data

    def test_returns_empty_dict_for_none(self):
        assert ConsentCenterService._metadata(None) == {}

    def test_returns_empty_dict_for_string(self):
        assert ConsentCenterService._metadata("not a dict") == {}

    def test_returns_empty_dict_for_list(self):
        assert ConsentCenterService._metadata([1, 2, 3]) == {}

    def test_returns_empty_dict_for_int(self):
        assert ConsentCenterService._metadata(42) == {}


# ============================================================================
# _counterpart
# ============================================================================


class TestCounterpart:
    """Tests for counterpart type and ID resolution."""

    def test_ria_from_metadata_actor_type(self):
        ctype, cid = ConsentCenterService._counterpart(
            "some_agent", {"requester_actor_type": "ria", "requester_entity_id": "ria_123"}
        )
        assert ctype == "ria"
        assert cid == "ria_123"

    def test_ria_from_agent_id_prefix(self):
        ctype, cid = ConsentCenterService._counterpart("ria:advisor_001", {})
        assert ctype == "ria"
        assert cid == "advisor_001"

    def test_investor_from_metadata_actor_type(self):
        ctype, cid = ConsentCenterService._counterpart(
            "some_agent", {"requester_actor_type": "investor", "requester_entity_id": "inv_456"}
        )
        assert ctype == "investor"
        assert cid == "inv_456"

    def test_investor_from_agent_id_prefix(self):
        ctype, cid = ConsentCenterService._counterpart("investor:user_789", {})
        assert ctype == "investor"
        assert cid == "user_789"

    def test_self_agent(self):
        ctype, cid = ConsentCenterService._counterpart("self", {})
        assert ctype == "self"
        assert cid is None

    def test_empty_agent_id_is_self(self):
        ctype, cid = ConsentCenterService._counterpart("", {})
        assert ctype == "self"
        assert cid is None

    def test_none_agent_id_is_self(self):
        ctype, cid = ConsentCenterService._counterpart(None, {})
        assert ctype == "self"
        assert cid is None

    def test_developer_agent(self):
        ctype, cid = ConsentCenterService._counterpart("my_dev_app", {})
        assert ctype == "developer"
        assert cid == "my_dev_app"

    def test_ria_prefix_with_empty_id(self):
        ctype, cid = ConsentCenterService._counterpart("ria:", {})
        assert ctype == "ria"
        # Empty after prefix should return None
        assert cid is None


# ============================================================================
# _developer_label
# ============================================================================


class TestDeveloperLabel:
    """Tests for developer display label resolution."""

    def test_prefers_app_display_name(self):
        label = ConsentCenterService._developer_label(
            "agent_id", {"developer_app_display_name": "My Cool App"}
        )
        assert label == "My Cool App"

    def test_falls_back_to_ria_requester_label(self):
        label = ConsentCenterService._developer_label(
            "agent_id",
            {"requester_actor_type": "ria", "requester_label": "Advisor Smith"},
        )
        assert label == "Advisor Smith"

    def test_falls_back_to_investor_requester_label(self):
        label = ConsentCenterService._developer_label(
            "agent_id",
            {"requester_actor_type": "investor", "requester_label": "John Doe"},
        )
        assert label == "John Doe"

    def test_falls_back_to_agent_id(self):
        label = ConsentCenterService._developer_label("my_agent", {})
        assert label == "my_agent"

    def test_returns_empty_for_no_info(self):
        label = ConsentCenterService._developer_label(None, {})
        assert label == ""

    def test_strips_whitespace_from_display_name(self):
        label = ConsentCenterService._developer_label(
            "agent", {"developer_app_display_name": "  Spaced App  "}
        )
        assert label == "Spaced App"


# ============================================================================
# _map_action_to_status
# ============================================================================


class TestMapActionToStatus:
    """Tests for consent action-to-status mapping."""

    @pytest.mark.parametrize(
        "action,expected",
        [
            ("REQUESTED", "request_pending"),
            ("CONSENT_GRANTED", "approved"),
            ("CONSENT_DENIED", "denied"),
            ("CANCELLED", "cancelled"),
            ("REVOKED", "revoked"),
            ("TIMEOUT", "expired"),
        ],
    )
    def test_known_actions(self, action, expected):
        assert ConsentCenterService._map_action_to_status(action) == expected

    def test_case_insensitive(self):
        assert ConsentCenterService._map_action_to_status("requested") == "request_pending"
        assert ConsentCenterService._map_action_to_status("Revoked") == "revoked"

    def test_unknown_action_lowercased(self):
        assert ConsentCenterService._map_action_to_status("CUSTOM_STATE") == "custom_state"

    def test_none_returns_unknown(self):
        assert ConsentCenterService._map_action_to_status(None) == "unknown"

    def test_empty_returns_unknown(self):
        assert ConsentCenterService._map_action_to_status("") == "unknown"

    def test_whitespace_stripped(self):
        assert ConsentCenterService._map_action_to_status("  REVOKED  ") == "revoked"


# ============================================================================
# _map_next_action
# ============================================================================


class TestMapNextAction:
    """Tests for next action resolution based on status and kind."""

    def test_invite_sent_awaits_acceptance(self):
        assert ConsentCenterService._map_next_action("sent", "invite") == "await_acceptance"

    def test_invite_accepted_triggers_review(self):
        assert ConsentCenterService._map_next_action("accepted", "invite") == "review_request"

    def test_invite_expired_can_reinvite(self):
        assert ConsentCenterService._map_next_action("expired", "invite") == "reinvite"

    def test_invite_unknown_status_returns_none(self):
        assert ConsentCenterService._map_next_action("random", "invite") == "none"

    def test_non_invite_pending_triggers_review(self):
        assert ConsentCenterService._map_next_action("pending", "consent") == "review_request"

    def test_non_invite_request_pending_awaits_decision(self):
        assert ConsentCenterService._map_next_action("request_pending", "consent") == "await_decision"

    def test_non_invite_approved_opens_workspace(self):
        assert ConsentCenterService._map_next_action("approved", "consent") == "open_workspace"

    @pytest.mark.parametrize("status", ["revoked", "expired", "denied", "cancelled"])
    def test_terminal_statuses_allow_re_request(self, status):
        assert ConsentCenterService._map_next_action(status, "consent") == "re_request"

    def test_active_allows_revoke(self):
        assert ConsentCenterService._map_next_action("active", "consent") == "revoke"


# ============================================================================
# _match_text
# ============================================================================


class TestMatchText:
    """Tests for consent entry text search."""

    def test_matches_counterpart_label(self):
        entry = {"counterpart_label": "Advisor Smith", "status": "active"}
        assert ConsentCenterService._match_text(entry, "smith") is True

    def test_matches_scope(self):
        entry = {"scope": "attr.financial.portfolio", "status": "active"}
        assert ConsentCenterService._match_text(entry, "financial") is True

    def test_matches_status(self):
        entry = {"status": "approved"}
        assert ConsentCenterService._match_text(entry, "approved") is True

    def test_no_match(self):
        entry = {"counterpart_label": "Alice", "status": "active"}
        assert ConsentCenterService._match_text(entry, "nonexistent") is False

    def test_empty_query_matches_all(self):
        entry = {"counterpart_label": "Anyone"}
        assert ConsentCenterService._match_text(entry, "") is True

    def test_whitespace_query_matches_all(self):
        entry = {"counterpart_label": "Anyone"}
        assert ConsentCenterService._match_text(entry, "   ") is True

    def test_case_insensitive_search(self):
        entry = {"counterpart_label": "ADVISOR SMITH"}
        assert ConsentCenterService._match_text(entry, "advisor") is True

    def test_handles_none_values_in_entry(self):
        entry = {"counterpart_label": None, "scope": None, "status": None}
        assert ConsentCenterService._match_text(entry, "test") is False


# ============================================================================
# _status
# ============================================================================


class TestStatus:
    """Tests for status normalization."""

    def test_normalizes_to_lowercase(self):
        assert ConsentCenterService._status("ACTIVE") == "active"

    def test_strips_whitespace(self):
        assert ConsentCenterService._status("  pending  ") == "pending"

    def test_none_returns_empty(self):
        assert ConsentCenterService._status(None) == ""

    def test_empty_returns_empty(self):
        assert ConsentCenterService._status("") == ""


# ============================================================================
# _sort_entries
# ============================================================================


class TestSortEntries:
    """Tests for consent entry chronological sorting."""

    def test_sorts_by_issued_at_descending(self):
        entries = [
            {"id": "old", "issued_at": 1000},
            {"id": "new", "issued_at": 3000},
            {"id": "mid", "issued_at": 2000},
        ]
        sorted_entries = ConsentCenterService._sort_entries(entries)
        assert [e["id"] for e in sorted_entries] == ["new", "mid", "old"]

    def test_falls_back_to_expires_at(self):
        entries = [
            {"id": "a", "expires_at": 500},
            {"id": "b", "expires_at": 1500},
        ]
        sorted_entries = ConsentCenterService._sort_entries(entries)
        assert sorted_entries[0]["id"] == "b"

    def test_handles_missing_timestamps(self):
        entries = [
            {"id": "no_time"},
            {"id": "has_time", "issued_at": 1000},
        ]
        sorted_entries = ConsentCenterService._sort_entries(entries)
        assert sorted_entries[0]["id"] == "has_time"


# ============================================================================
# Connection Direction / Surface / Kind
# ============================================================================


class TestConnectionClassMethods:
    """Tests for connection classification helpers."""

    def test_ria_outgoing_for_financial_scope(self):
        direction = ConsentCenterService._connection_direction(
            actor="ria", scope="attr.financial.portfolio"
        )
        assert direction == "outgoing"

    def test_ria_incoming_for_ria_scope(self):
        direction = ConsentCenterService._connection_direction(
            actor="ria", scope="attr.ria.disclosure"
        )
        assert direction == "incoming"

    def test_investor_incoming_for_financial_scope(self):
        direction = ConsentCenterService._connection_direction(
            actor="investor", scope="attr.financial.portfolio"
        )
        assert direction == "incoming"

    def test_investor_outgoing_for_ria_scope(self):
        direction = ConsentCenterService._connection_direction(
            actor="investor", scope="attr.ria.disclosure"
        )
        assert direction == "outgoing"

    def test_connection_surface_pending(self):
        assert ConsentCenterService._connection_surface_for_status("request_pending") == "pending"
        assert ConsentCenterService._connection_surface_for_status("invited") == "pending"

    def test_connection_surface_active(self):
        assert ConsentCenterService._connection_surface_for_status("approved") == "active"

    def test_connection_surface_previous(self):
        assert ConsentCenterService._connection_surface_for_status("revoked") == "previous"
        assert ConsentCenterService._connection_surface_for_status("expired") == "previous"

    def test_connection_kind_active_grant(self):
        kind = ConsentCenterService._connection_kind(
            actor="ria", scope="attr.financial.portfolio", status="approved"
        )
        assert kind == "active_grant"

    def test_connection_kind_invite(self):
        kind = ConsentCenterService._connection_kind(
            actor="ria", scope="attr.financial.portfolio", status="invited"
        )
        assert kind == "invite"

    def test_connection_kind_history(self):
        kind = ConsentCenterService._connection_kind(
            actor="ria", scope="attr.financial.portfolio", status="expired"
        )
        assert kind == "history"
