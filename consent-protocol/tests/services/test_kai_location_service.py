from __future__ import annotations

import json
from datetime import timedelta

import pytest

from hushh_mcp.services.kai_location_service import (
    FRESH_FIX_WINDOW,
    MAX_FAMILY_CONTACTS,
    MAX_FRIEND_CONTACTS,
    MAX_SHARE_HOURS,
    PUBLIC_LIVE_POLL_INTERVAL_MS,
    KaiLocationError,
    KaiLocationService,
    _json_param,
    _new_token,
    _public_live_payload,
    _redact_coordinate_metadata,
    _token_hash,
    _utcnow,
    _validate_point,
)


def test_location_limits_match_contract() -> None:
    assert MAX_FAMILY_CONTACTS == 3
    assert MAX_FRIEND_CONTACTS == 7
    assert MAX_SHARE_HOURS == 24


def test_share_tokens_are_random_and_hash_only() -> None:
    token = _new_token()
    hashed = _token_hash(token)

    assert token != hashed
    assert len(hashed) == 64
    assert _token_hash(token) == hashed


def test_validate_point_rejects_stale_or_out_of_range_coordinates() -> None:
    stale_point = {
        "latitude": 37.7749,
        "longitude": -122.4194,
        "capturedAt": (_utcnow() - FRESH_FIX_WINDOW - timedelta(seconds=1)).isoformat(),
    }
    with pytest.raises(KaiLocationError, match="fresh GPS fix"):
        _validate_point(stale_point, require_fresh=True)

    with pytest.raises(KaiLocationError, match="valid GPS range"):
        _validate_point(
            {"latitude": 91, "longitude": -122.4194, "capturedAt": _utcnow().isoformat()},
            require_fresh=True,
        )


def test_event_metadata_redacts_coordinates_recursively() -> None:
    metadata = {
        "requester": "family",
        "latitude": 37.7749,
        "nested": {
            "safe": "kept",
            "lng": -122.4194,
            "items": [{"location": "hidden"}, {"note": "ok"}],
        },
    }

    redacted = _redact_coordinate_metadata(metadata)
    encoded = json.loads(_json_param(metadata))

    assert redacted == {
        "requester": "family",
        "nested": {"safe": "kept", "items": [{}, {"note": "ok"}]},
    }
    assert encoded == redacted


def test_public_live_payload_uses_gcp_polling_contract() -> None:
    payload = _public_live_payload(
        row={"status": "active", "live_mode": True},
        latest={"capturedAt": _utcnow().isoformat()},
    )

    assert payload["transport"] == "gcp_polling"
    assert payload["pollIntervalMs"] == PUBLIC_LIVE_POLL_INTERVAL_MS
    assert payload["isLive"] is True
    assert isinstance(payload["freshnessSeconds"], int)
    assert "latitude" not in payload
    assert "longitude" not in payload


class _RequestAccessGuardService(KaiLocationService):
    def __init__(self, share_row: dict) -> None:
        self.share_row = share_row

    def _execute_one(self, sql: str, params: dict) -> dict | None:
        if "FROM kai_location_shares s" in sql and "WHERE s.token_hash" in sql:
            return self.share_row
        raise AssertionError("request_access should stop before additional database writes")


def test_request_access_rejects_revoked_share_links() -> None:
    share_link = "share-link"
    service = _RequestAccessGuardService(
        {
            "id": "share-1",
            "owner_user_id": "owner-1",
            "contact_id": "contact-1",
            "status": "revoked",
            "expires_at": _utcnow() - timedelta(hours=1),
            "contact_tier": "family",
            "contact_status": "active",
            "contact_auto_approve": True,
        }
    )

    with pytest.raises(KaiLocationError) as exc_info:
        service.request_access(token=share_link)

    assert exc_info.value.code == "SHARE_REVOKED"
    assert exc_info.value.status_code == 410


def test_request_access_rejects_still_active_share_links() -> None:
    share_link = "share-link"
    service = _RequestAccessGuardService(
        {
            "id": "share-1",
            "owner_user_id": "owner-1",
            "contact_id": "contact-1",
            "status": "active",
            "expires_at": _utcnow() + timedelta(hours=1),
            "contact_tier": "friend",
            "contact_status": "active",
            "contact_auto_approve": False,
        }
    )

    with pytest.raises(KaiLocationError) as exc_info:
        service.request_access(token=share_link)

    assert exc_info.value.code == "SHARE_STILL_ACTIVE"
    assert exc_info.value.status_code == 409
