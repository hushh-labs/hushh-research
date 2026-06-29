"""Unit tests for OneLocationCenterContributor.

These are hermetic: they inject a fake location service exposing ``list_state``
so no DB is required. They lock in (1) the category -> bucket mapping the
/consents tabs depend on, and (2) the coordinate-free contract.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.one_location_center_contributor import (
    LOCATION_VIEW_SCOPE,
    OneLocationCenterContributor,
    _coerce_metadata,
)


class _FakeLocationService:
    def __init__(self, state: dict):
        self._state = state

    def list_state(self, *, user_id: str) -> dict:  # noqa: ARG002
        return self._state


def _contributor(state: dict) -> OneLocationCenterContributor:
    return OneLocationCenterContributor(location_service=_FakeLocationService(state))


def test_active_owner_grant_maps_to_active_access():
    state = {
        "ownerGrants": [
            {
                "id": "grant_1",
                "status": "active",
                "recipientUserId": "user_b",
                "recipientDisplayName": "Bob",
                "durationHours": 1,
                "expiresAt": "2030-01-01T00:00:00Z",
            }
        ],
    }
    buckets = _contributor(state).collect("user_a")
    assert len(buckets["active_grants"]) == 1
    entry = buckets["active_grants"][0]
    assert entry["kind"] == "active_grant"
    assert entry["scope"] == LOCATION_VIEW_SCOPE
    assert entry["counterpart_type"] == "investor"
    assert entry["metadata"]["request_source"] == "one_location_share_grant"
    assert entry["metadata"]["section"] == "people"


def test_pending_owner_request_maps_to_requests():
    state = {
        "requests": [
            {
                "id": "req_1",
                "status": "pending",
                "ownerUserId": "user_a",
                "requesterUserId": "user_c",
                "requesterDisplayName": "Carol",
                "message": "please",
            }
        ],
    }
    buckets = _contributor(state).collect("user_a")
    assert len(buckets["incoming_requests"]) == 1
    entry = buckets["incoming_requests"][0]
    assert entry["kind"] == "incoming_request"
    assert entry["status"] == "pending"
    assert entry["reason"] == "please"
    assert entry["metadata"]["section"] == "approvals"


def test_revoked_grant_maps_to_history():
    state = {
        "receivedGrants": [
            {
                "id": "grant_x",
                "status": "revoked",
                "ownerUserId": "user_d",
                "ownerDisplayName": "Dan",
            }
        ],
    }
    buckets = _contributor(state).collect("user_a")
    assert len(buckets["history"]) == 1
    assert buckets["history"][0]["kind"] == "history"
    assert buckets["active_grants"] == []


def test_public_invite_active_and_revoked_split_between_buckets():
    state = {
        "publicInvites": [
            {"id": "pi_active", "status": "active"},
            {"id": "pi_revoked", "status": "revoked"},
        ],
    }
    buckets = _contributor(state).collect("user_a")
    assert [e["id"] for e in buckets["active_grants"]] == ["one_location_public:pi_active"]
    assert [e["id"] for e in buckets["history"]] == ["one_location_public:pi_revoked"]


def test_counts_reflect_buckets():
    state = {
        "ownerGrants": [{"id": "g1", "status": "active", "recipientUserId": "b"}],
        "requests": [
            {"id": "r1", "status": "pending", "ownerUserId": "user_a", "requesterUserId": "c"}
        ],
        "receivedGrants": [{"id": "g2", "status": "expired", "ownerUserId": "d"}],
    }
    counts = _contributor(state).counts("user_a")
    assert counts["pending"] == 1
    assert counts["active"] == 1
    assert counts["previous"] == 1


def test_coordinate_free_guard_rejects_latitude():
    with pytest.raises(ValueError):
        _coerce_metadata({"request_source": "one_location_share_grant", "lat": "12.97"})


def test_collect_is_safe_when_list_state_raises():
    class _Boom:
        def list_state(self, *, user_id: str):  # noqa: ARG002
            raise RuntimeError("db down")

    contributor = OneLocationCenterContributor(location_service=_Boom())
    buckets = contributor.collect("user_a")
    assert buckets == {
        "incoming_requests": [],
        "outgoing_requests": [],
        "active_grants": [],
        "history": [],
        "invites": [],
    }
