"""Synthetic approval/identity/encryption contracts; no live sharing."""

import base64
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import ValidationError

from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingCipher,
    DriveSharingError,
    ShareRequestPurpose,
    SharingApproval,
    recipient_from_verified_firebase_claims,
)

NOW = datetime(2026, 9, 23, tzinfo=UTC)


def claims():
    return {
        "uid": "recipient",
        "email": "recipient@example.invalid",
        "email_verified": True,
        "iat": NOW.timestamp(),
        "auth_time": NOW.timestamp(),
        "firebase": {
            "sign_in_provider": "google.com",
            "identities": {"google.com": ["123456789"]},
        },
    }


@pytest.fixture
def cipher(monkeypatch):
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"s" * 32).decode())
    return DriveSharingCipher()


def test_google_identity_does_not_require_a_drive_connection(cipher):
    recipient = recipient_from_verified_firebase_claims(
        claims(), owner_user_id="recipient", google_provider=provider(), now=NOW
    )
    assert recipient.email == "recipient@example.invalid"
    assert len(cipher.recipient_binding(recipient)) == 64
    assert "recipient" not in repr(recipient)


@pytest.mark.parametrize(
    "change",
    [
        {"uid": "different-owner"},
        {"email_verified": False},
        {"email_verified": "true"},
        {"auth_time": NOW.timestamp() - 301},
        {"auth_time": NOW.timestamp() + 1},
        {"auth_time": float("nan")},
        {"email": "recipient@example.invalid\n"},
        {
            "firebase": {
                "sign_in_provider": "apple.com",
                "identities": {"google.com": ["123456789"]},
            }
        },
        {"firebase": {"sign_in_provider": "google.com", "identities": {"google.com": ["1", "2"]}}},
        {"firebase": None},
    ],
)
def test_recipient_requires_fresh_google_specific_verified_claims(change):
    with pytest.raises(DriveSharingError, match="verify_google_identity_required"):
        recipient_from_verified_firebase_claims(
            {**claims(), **change}, owner_user_id="recipient", google_provider=provider(), now=NOW
        )


def provider(**changes):
    return SimpleNamespace(
        **{
            "provider_id": "google.com",
            "uid": "123456789",
            "email": "recipient@example.invalid",
            **changes,
        }
    )


@pytest.mark.parametrize(
    "change",
    [
        {"email": "changed@example.invalid"},
        {"provider_id": "apple.com"},
        {"uid": "987654321"},
    ],
)
def test_top_level_email_and_provider_hint_are_not_google_recipient_proof(change):
    with pytest.raises(DriveSharingError, match="verify_google_identity_required"):
        recipient_from_verified_firebase_claims(
            claims(), owner_user_id="recipient", google_provider=provider(**change), now=NOW
        )


def test_sharing_receipts_are_owner_resource_purpose_bound_and_independent(cipher, monkeypatch):
    payload = {
        "email": "recipient@example.invalid",
        "file_id": "private-source",
        "permission_id": "private-grantee",
    }
    envelope = cipher.seal(
        payload, user_id="owner", resource_id="receipt", purpose="provider-receipt"
    )
    serialized = json.dumps(envelope)
    assert all(secret not in serialized for secret in payload.values())
    monkeypatch.delenv("DRIVE_DOCUMENT_KEY_V1", raising=False)
    monkeypatch.delenv("EXTERNAL_CONNECTOR_CREDENTIAL_KEY", raising=False)
    assert (
        cipher.open(envelope, user_id="owner", resource_id="receipt", purpose="provider-receipt")
        == payload
    )
    for bindings in [
        {"user_id": "other", "resource_id": "receipt", "purpose": "provider-receipt"},
        {"user_id": "owner", "resource_id": "other", "purpose": "provider-receipt"},
        {"user_id": "owner", "resource_id": "receipt", "purpose": "approval"},
    ]:
        with pytest.raises(DriveSharingError, match="sharing_storage_unavailable"):
            cipher.open(envelope, **bindings)


def test_cipher_fails_closed_without_sharing_key(monkeypatch):
    monkeypatch.delenv("DRIVE_SHARING_KEY_V1", raising=False)
    with pytest.raises(DriveSharingError, match="sharing_storage_unavailable"):
        DriveSharingCipher().seal({}, user_id="owner", resource_id="request", purpose="request")


def approval():
    return {
        "request_id": uuid4(),
        "revision": 1,
        "owner_user_id": "owner",
        "recipient_user_id": "recipient",
        "recipient_binding": "b" * 64,
        "connection_generation": 1,
        "sources": [
            {
                "document_id": uuid4(),
                "source_version": "7",
                "source_fingerprint": "f" * 64,
                "index_version": "a" * 64,
                "processing_revision": 2,
            }
        ],
    }


@pytest.mark.parametrize(
    "change",
    [
        {"role": "writer"},
        {"recipient_type": "anyone"},
        {"recipient_type": "domain"},
        {"connection_generation": 0},
        {"recipient_user_id": "owner"},
        {"sources": []},
        {"disclosure": "old-policy"},
        {"endpoint": "https://attacker.invalid"},
    ],
)
def test_approval_is_only_exact_individual_reader(change):
    with pytest.raises(ValidationError):
        SharingApproval.model_validate({**approval(), **change})


def test_substituted_file_or_recipient_changes_bound_authority(cipher):
    original = approval()
    binding = SharingApproval.model_validate(original).authority_binding()
    digest = cipher.digest("approval", binding)
    for changed in [
        {**original, "recipient_binding": "c" * 64},
        {**original, "connection_generation": 2},
        {**original, "sources": [{**original["sources"][0], "source_version": "8"}]},
    ]:
        assert (
            cipher.digest("approval", SharingApproval.model_validate(changed).authority_binding())
            != digest
        )
    with pytest.raises(ValidationError):
        SharingApproval.model_validate({**original, "sources": original["sources"] * 2})


@pytest.mark.parametrize(
    "data",
    [
        {"purpose": " "},
        {"purpose": "statements", "periodStart": "2026-01-01"},
        {"purpose": "statements", "periodStart": "2026-02-30", "periodEnd": "2026-03-01"},
        {"purpose": "statements", "periodStart": "2026-06-01", "periodEnd": "2026-01-01"},
    ],
)
def test_request_period_is_explicit_and_valid(data):
    with pytest.raises(ValidationError):
        ShareRequestPurpose.model_validate(data)
