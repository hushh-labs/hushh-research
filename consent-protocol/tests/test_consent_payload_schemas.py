"""
Unit tests for consent payload schema validation (schemas.py).

Verifies that malformed or incomplete payloads are rejected before
reaching business logic, in alignment with Zero-Knowledge and Data
Transparency principles.
"""

from __future__ import annotations

import time

import pytest
from pydantic import ValidationError

from schemas import ConsentApprovalPayload

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_NOW_MS = int(time.time() * 1000)


def _valid_base() -> dict:
    """Minimal valid payload (camelCase, matching the API wire format)."""
    return {"userId": "user_abc123", "requestId": "req_xyz456"}


# ---------------------------------------------------------------------------
# user_id validation
# ---------------------------------------------------------------------------


def test_valid_minimal_payload_accepted():
    payload = ConsentApprovalPayload.model_validate(_valid_base())
    assert payload.user_id == "user_abc123"
    assert payload.request_id == "req_xyz456"
    assert payload.permission_levels == []
    assert payload.timestamp is None


def test_missing_user_id_rejected():
    with pytest.raises(ValidationError) as exc_info:
        ConsentApprovalPayload.model_validate({"requestId": "req_1"})
    errors = exc_info.value.errors()
    fields = {e["loc"][0] for e in errors}
    assert "userId" in fields


def test_empty_user_id_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate({"userId": "", "requestId": "req_1"})


def test_whitespace_only_user_id_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate({"userId": "   ", "requestId": "req_1"})


# ---------------------------------------------------------------------------
# request_id validation
# ---------------------------------------------------------------------------


def test_missing_request_id_rejected():
    with pytest.raises(ValidationError) as exc_info:
        ConsentApprovalPayload.model_validate({"userId": "user_1"})
    errors = exc_info.value.errors()
    fields = {e["loc"][0] for e in errors}
    assert "requestId" in fields


def test_empty_request_id_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate({"userId": "user_1", "requestId": ""})


def test_whitespace_only_request_id_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate({"userId": "user_1", "requestId": "  "})


# ---------------------------------------------------------------------------
# timestamp validation
# ---------------------------------------------------------------------------


def test_valid_timestamp_accepted():
    payload = ConsentApprovalPayload.model_validate({**_valid_base(), "timestamp": _NOW_MS})
    assert payload.timestamp == _NOW_MS


def test_omitted_timestamp_defaults_to_none():
    payload = ConsentApprovalPayload.model_validate(_valid_base())
    assert payload.timestamp is None


def test_timestamp_before_year_2000_rejected():
    pre_2000_ms = 946_684_799_999  # one millisecond before 2000-01-01
    with pytest.raises(ValidationError) as exc_info:
        ConsentApprovalPayload.model_validate({**_valid_base(), "timestamp": pre_2000_ms})
    assert any("2000-01-01" in str(e) for e in exc_info.value.errors())


def test_timestamp_far_future_rejected():
    far_future_ms = _NOW_MS + 10 * 60 * 1000  # 10 minutes ahead
    with pytest.raises(ValidationError) as exc_info:
        ConsentApprovalPayload.model_validate({**_valid_base(), "timestamp": far_future_ms})
    assert any("future" in str(e) for e in exc_info.value.errors())


def test_timestamp_slightly_future_accepted():
    # Up to 5 minutes of clock skew is allowed
    slightly_future_ms = _NOW_MS + 2 * 60 * 1000
    payload = ConsentApprovalPayload.model_validate(
        {**_valid_base(), "timestamp": slightly_future_ms}
    )
    assert payload.timestamp == slightly_future_ms


# ---------------------------------------------------------------------------
# permission_levels validation
# ---------------------------------------------------------------------------


def test_valid_static_permission_levels_accepted():
    payload = ConsentApprovalPayload.model_validate(
        {**_valid_base(), "permissionLevels": ["pkm.read", "vault.owner"]}
    )
    assert payload.permission_levels == ["pkm.read", "vault.owner"]


def test_valid_dynamic_wildcard_permission_level_accepted():
    payload = ConsentApprovalPayload.model_validate(
        {**_valid_base(), "permissionLevels": ["attr.financial.*"]}
    )
    assert payload.permission_levels == ["attr.financial.*"]


def test_valid_dynamic_specific_permission_level_accepted():
    payload = ConsentApprovalPayload.model_validate(
        {**_valid_base(), "permissionLevels": ["attr.food.preferences"]}
    )
    assert payload.permission_levels == ["attr.food.preferences"]


def test_empty_permission_levels_accepted():
    payload = ConsentApprovalPayload.model_validate({**_valid_base(), "permissionLevels": []})
    assert payload.permission_levels == []


def test_invalid_permission_level_with_spaces_rejected():
    with pytest.raises(ValidationError) as exc_info:
        ConsentApprovalPayload.model_validate(
            {**_valid_base(), "permissionLevels": ["invalid scope with spaces"]}
        )
    assert any("permission" in str(e).lower() for e in exc_info.value.errors())


def test_invalid_permission_level_with_uppercase_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate({**_valid_base(), "permissionLevels": ["PKM.READ"]})


def test_invalid_permission_level_empty_string_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate({**_valid_base(), "permissionLevels": [""]})


def test_invalid_permission_level_injection_chars_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate(
            {**_valid_base(), "permissionLevels": ["'; DROP TABLE consent_audit; --"]}
        )


# ---------------------------------------------------------------------------
# Optional encrypted export fields — type safety
# ---------------------------------------------------------------------------


def test_valid_full_payload_with_encrypted_fields_accepted():
    full = {
        **_valid_base(),
        "encryptedData": "base64ciphertext==",
        "encryptedIv": "base64iv==",
        "encryptedTag": "base64tag==",
        "wrappedExportKey": "wrappedkey==",
        "wrappedKeyIv": "wrappediv==",
        "wrappedKeyTag": "wrappedtag==",
        "senderPublicKey": "pubkey==",
        "wrappingAlg": "X25519-AES256-GCM",
        "connectorKeyId": "key-id-001",
        "durationHours": 24,
        "sourceContentRevision": 3,
        "sourceManifestRevision": 1,
    }
    payload = ConsentApprovalPayload.model_validate(full)
    assert payload.encrypted_data == "base64ciphertext=="
    assert payload.duration_hours == 24
    assert payload.source_content_revision == 3


def test_duration_hours_below_minimum_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate({**_valid_base(), "durationHours": 0})


def test_duration_hours_above_maximum_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate({**_valid_base(), "durationHours": 9000})


def test_negative_source_revision_rejected():
    with pytest.raises(ValidationError):
        ConsentApprovalPayload.model_validate({**_valid_base(), "sourceContentRevision": -1})


# ---------------------------------------------------------------------------
# populate_by_name — snake_case construction also works (for internal use)
# ---------------------------------------------------------------------------


def test_snake_case_construction_accepted():
    payload = ConsentApprovalPayload(user_id="u1", request_id="r1")
    assert payload.user_id == "u1"
    assert payload.request_id == "r1"
