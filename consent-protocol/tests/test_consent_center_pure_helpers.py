"""Hermetic unit tests for ConsentCenterService pure static helpers.

All methods under test are @staticmethod or @classmethod with no I/O.
No DB, no network, no LLM.

Covered:
    _metadata
    _counterpart
    _developer_label
    _map_action_to_status
    _map_next_action
    _developer_email
    _relationship_state
    _match_text
    _status
    _sort_entries
    _entries_for_surface
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.consent_center_service import ConsentCenterService

SVC = ConsentCenterService


# ===========================================================================
# _metadata
# ===========================================================================


class TestMetadata:
    def test_dict_returned_unchanged(self):
        d = {"key": "value"}
        assert SVC._metadata(d) == d

    def test_none_returns_empty_dict(self):
        assert SVC._metadata(None) == {}

    def test_string_returns_empty_dict(self):
        assert SVC._metadata("not a dict") == {}

    def test_list_returns_empty_dict(self):
        assert SVC._metadata([1, 2]) == {}

    def test_empty_dict_returned(self):
        assert SVC._metadata({}) == {}


# ===========================================================================
# _status
# ===========================================================================


class TestStatus:
    def test_lowercases(self):
        assert SVC._status("PENDING") == "pending"

    def test_strips_whitespace(self):
        assert SVC._status("  active  ") == "active"

    def test_none_returns_empty(self):
        assert SVC._status(None) == ""

    def test_empty_returns_empty(self):
        assert SVC._status("") == ""


# ===========================================================================
# _counterpart
# ===========================================================================


class TestCounterpart:
    def test_ria_actor_type_in_metadata(self):
        ctype, cid = SVC._counterpart("agent_id", {"requester_actor_type": "ria"})
        assert ctype == "ria"

    def test_ria_prefixed_agent_id(self):
        ctype, cid = SVC._counterpart("ria:abc123", {})
        assert ctype == "ria"
        assert cid == "abc123"

    def test_investor_actor_type_in_metadata(self):
        ctype, cid = SVC._counterpart("agent_id", {"requester_actor_type": "investor"})
        assert ctype == "investor"

    def test_investor_prefixed_agent_id(self):
        ctype, cid = SVC._counterpart("investor:xyz", {})
        assert ctype == "investor"
        assert cid == "xyz"

    def test_self_agent_returns_self(self):
        ctype, cid = SVC._counterpart("self", {})
        assert ctype == "self"
        assert cid is None

    def test_empty_agent_returns_self(self):
        ctype, cid = SVC._counterpart("", {})
        assert ctype == "self"
        assert cid is None

    def test_none_agent_returns_self(self):
        ctype, cid = SVC._counterpart(None, {})
        assert ctype == "self"
        assert cid is None

    def test_unknown_agent_returns_developer(self):
        ctype, cid = SVC._counterpart("some_app_agent", {})
        assert ctype == "developer"
        assert cid == "some_app_agent"

    def test_ria_entity_id_from_metadata(self):
        meta = {"requester_actor_type": "ria", "requester_entity_id": "firm_uid_1"}
        ctype, cid = SVC._counterpart("ria:other", meta)
        assert ctype == "ria"
        assert cid == "firm_uid_1"

    def test_investor_entity_id_from_metadata(self):
        meta = {"requester_actor_type": "investor", "requester_entity_id": "inv_uid"}
        ctype, cid = SVC._counterpart("agent", meta)
        assert ctype == "investor"
        assert cid == "inv_uid"


# ===========================================================================
# _developer_label
# ===========================================================================


class TestDeveloperLabel:
    def test_app_display_name_wins(self):
        meta = {"developer_app_display_name": "My App", "requester_actor_type": "ria"}
        assert SVC._developer_label("agent", meta) == "My App"

    def test_ria_requester_label_fallback(self):
        meta = {"requester_actor_type": "ria", "requester_label": "Acme Advisory"}
        assert SVC._developer_label("agent", meta) == "Acme Advisory"

    def test_ria_entity_id_fallback(self):
        meta = {"requester_actor_type": "ria", "requester_entity_id": "ria_uid_1"}
        assert SVC._developer_label("agent", meta) == "ria_uid_1"

    def test_investor_requester_label_fallback(self):
        meta = {"requester_actor_type": "investor", "requester_label": "John Doe"}
        assert SVC._developer_label("agent", meta) == "John Doe"

    def test_agent_id_last_resort(self):
        assert SVC._developer_label("my_agent_id", {}) == "my_agent_id"

    def test_none_agent_empty_meta_returns_empty(self):
        assert SVC._developer_label(None, {}) == ""


# ===========================================================================
# _map_action_to_status
# ===========================================================================


class TestMapActionToStatus:
    @pytest.mark.parametrize(
        "action, expected",
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
        assert SVC._map_action_to_status(action) == expected

    def test_case_insensitive(self):
        assert SVC._map_action_to_status("requested") == "request_pending"

    def test_unknown_action_lowercased(self):
        assert SVC._map_action_to_status("CUSTOM") == "custom"

    def test_none_returns_unknown(self):
        assert SVC._map_action_to_status(None) == "unknown"

    def test_empty_returns_unknown(self):
        assert SVC._map_action_to_status("") == "unknown"

    def test_whitespace_stripped(self):
        assert SVC._map_action_to_status("  REQUESTED  ") == "request_pending"


# ===========================================================================
# _map_next_action
# ===========================================================================


class TestMapNextAction:
    # --- consent kind ---

    def test_pending_consent_awaits_decision(self):
        assert SVC._map_next_action("pending", "consent") == "review_request"

    def test_request_pending_consent_awaits(self):
        assert SVC._map_next_action("request_pending", "consent") == "await_decision"

    def test_approved_consent_opens_workspace(self):
        assert SVC._map_next_action("approved", "consent") == "open_workspace"

    def test_revoked_consent_re_request(self):
        assert SVC._map_next_action("revoked", "consent") == "re_request"

    def test_expired_consent_re_request(self):
        assert SVC._map_next_action("expired", "consent") == "re_request"

    def test_denied_consent_re_request(self):
        assert SVC._map_next_action("denied", "consent") == "re_request"

    def test_cancelled_consent_re_request(self):
        assert SVC._map_next_action("cancelled", "consent") == "re_request"

    def test_active_consent_revoke(self):
        assert SVC._map_next_action("active", "consent") == "revoke"

    def test_unknown_consent_none(self):
        assert SVC._map_next_action("something_else", "consent") == "none"

    # --- invite kind ---

    def test_invite_sent_awaits_acceptance(self):
        assert SVC._map_next_action("sent", "invite") == "await_acceptance"

    def test_invite_accepted_review_request(self):
        assert SVC._map_next_action("accepted", "invite") == "review_request"

    def test_invite_expired_reinvite(self):
        assert SVC._map_next_action("expired", "invite") == "reinvite"

    def test_invite_unknown_none(self):
        assert SVC._map_next_action("other", "invite") == "none"

    def test_case_insensitive(self):
        assert SVC._map_next_action("APPROVED", "consent") == "open_workspace"


# ===========================================================================
# _developer_email
# ===========================================================================


class TestDeveloperEmail:
    def test_developer_contact_email_first(self):
        meta = {
            "developer_contact_email": "dev@example.com",
            "contact_email": "other@example.com",
        }
        assert SVC._developer_email(meta) == "dev@example.com"

    def test_contact_email_fallback(self):
        assert SVC._developer_email({"contact_email": "c@example.com"}) == "c@example.com"

    def test_owner_email_fallback(self):
        assert SVC._developer_email({"owner_email": "o@example.com"}) == "o@example.com"

    def test_requester_email_last(self):
        assert SVC._developer_email({"requester_email": "r@example.com"}) == "r@example.com"

    def test_empty_meta_returns_none(self):
        assert SVC._developer_email({}) is None

    def test_all_empty_values_returns_none(self):
        meta = {"developer_contact_email": "", "contact_email": "  "}
        assert SVC._developer_email(meta) is None

    def test_whitespace_value_skipped(self):
        meta = {"developer_contact_email": "  ", "owner_email": "o@example.com"}
        assert SVC._developer_email(meta) == "o@example.com"


# ===========================================================================
# _relationship_state
# ===========================================================================


class TestRelationshipState:
    def test_ria_counterpart_returns_state(self):
        meta = {"relationship_state": "active"}
        assert SVC._relationship_state(meta, counterpart_type="ria") == "active"

    def test_non_ria_counterpart_returns_none(self):
        meta = {"relationship_state": "active"}
        assert SVC._relationship_state(meta, counterpart_type="developer") is None

    def test_investor_counterpart_returns_none(self):
        meta = {"relationship_state": "active"}
        assert SVC._relationship_state(meta, counterpart_type="investor") is None

    def test_fallback_to_ria_relationship_state(self):
        meta = {"ria_relationship_state": "pending"}
        assert SVC._relationship_state(meta, counterpart_type="ria") == "pending"

    def test_fallback_to_invite_status(self):
        meta = {"invite_status": "sent"}
        assert SVC._relationship_state(meta, counterpart_type="ria") == "sent"

    def test_empty_metadata_returns_none(self):
        assert SVC._relationship_state({}, counterpart_type="ria") is None


# ===========================================================================
# _match_text
# ===========================================================================


class TestMatchText:
    def test_empty_query_always_matches(self):
        assert SVC._match_text({"counterpart_label": "Alice"}, "") is True

    def test_whitespace_query_always_matches(self):
        assert SVC._match_text({}, "   ") is True

    def test_matches_counterpart_label(self):
        assert SVC._match_text({"counterpart_label": "Alice Smith"}, "alice") is True

    def test_matches_scope(self):
        assert SVC._match_text({"scope": "attr.financial.*"}, "financial") is True

    def test_matches_status(self):
        assert SVC._match_text({"status": "approved"}, "approve") is True

    def test_case_insensitive(self):
        assert SVC._match_text({"counterpart_label": "ALICE"}, "alice") is True

    def test_no_match(self):
        assert SVC._match_text({"counterpart_label": "Alice"}, "bob") is False

    def test_matches_reason(self):
        assert SVC._match_text({"reason": "Portfolio review"}, "portfolio") is True

    def test_none_values_handled(self):
        entry = {
            "counterpart_label": None,
            "scope": None,
            "status": None,
        }
        assert SVC._match_text(entry, "anything") is False

    def test_partial_match(self):
        assert SVC._match_text({"counterpart_label": "Financial Advisor Ltd"}, "advisor") is True


# ===========================================================================
# _sort_entries
# ===========================================================================


class TestSortEntries:
    def test_sorted_descending_by_issued_at(self):
        entries = [
            {"issued_at": 100},
            {"issued_at": 300},
            {"issued_at": 200},
        ]
        result = SVC._sort_entries(entries)
        assert [e["issued_at"] for e in result] == [300, 200, 100]

    def test_falls_back_to_expires_at(self):
        entries = [
            {"expires_at": 100},
            {"expires_at": 50},
        ]
        result = SVC._sort_entries(entries)
        assert result[0]["expires_at"] == 100

    def test_missing_timestamps_sort_to_end(self):
        entries = [
            {"issued_at": 500},
            {},  # no timestamp -> 0
        ]
        result = SVC._sort_entries(entries)
        assert result[0]["issued_at"] == 500

    def test_empty_list(self):
        assert SVC._sort_entries([]) == []

    def test_string_timestamp_converted(self):
        entries = [{"issued_at": "200"}, {"issued_at": "100"}]
        result = SVC._sort_entries(entries)
        assert result[0]["issued_at"] == "200"


# ===========================================================================
# _entries_for_surface
# ===========================================================================


def _make_center(*, active=None, outgoing=None, incoming=None, invites=None, history=None):
    return {
        "active_grants": active or [],
        "outgoing_requests": outgoing or [],
        "incoming_requests": incoming or [],
        "invites": invites or [],
        "history": history or [],
    }


class TestEntriesForSurface:
    def test_active_surface_returns_active_statuses(self):
        center = _make_center(
            active=[
                {"status": "active"},
                {"status": "pending"},
            ]
        )
        result = SVC._entries_for_surface(center, actor="investor", surface="active")
        assert len(result) == 1
        assert result[0]["status"] == "active"

    def test_pending_investor_returns_incoming(self):
        center = _make_center(
            incoming=[{"status": "pending"}, {"status": "request_pending"}],
        )
        result = SVC._entries_for_surface(center, actor="investor", surface="pending")
        assert len(result) == 2

    def test_pending_ria_returns_outgoing_and_invites(self):
        center = _make_center(
            outgoing=[{"status": "request_pending"}],
            invites=[{"status": "sent"}],
        )
        result = SVC._entries_for_surface(center, actor="ria", surface="pending")
        assert len(result) == 2

    def test_history_surface_excludes_pending_and_active(self):
        center = _make_center(
            history=[
                {"status": "approved"},
                {"status": "pending"},
                {"status": "active"},
                {"status": "revoked"},
            ]
        )
        result = SVC._entries_for_surface(center, actor="investor", surface="history")
        statuses = {e["status"] for e in result}
        assert "approved" in statuses
        assert "revoked" in statuses
        assert "pending" not in statuses
        assert "active" not in statuses

    def test_empty_center_returns_empty(self):
        result = SVC._entries_for_surface(_make_center(), actor="investor", surface="active")
        assert result == []
