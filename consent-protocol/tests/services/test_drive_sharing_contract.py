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
    recipient_from_verified_firebase_email,
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


def test_verified_one_email_can_bind_an_owner_share_without_google_sign_in(cipher):
    user = SimpleNamespace(
        uid="recipient", disabled=False, email="personal@example.invalid", email_verified=True
    )
    recipient = recipient_from_verified_firebase_email("recipient", user, now=NOW)
    assert recipient.kind == "verified_email"
    assert recipient.email == "personal@example.invalid"
    assert len(cipher.recipient_binding(recipient)) == 64
    assert "personal@example.invalid" not in repr(recipient)


@pytest.mark.parametrize(
    "change",
    [
        {"uid": "another-user"},
        {"disabled": True},
        {"email_verified": False},
        {"email": "invalid\n@example.invalid"},
    ],
)
def test_unverified_or_changed_one_email_cannot_receive_a_grant(change):
    user = SimpleNamespace(
        **{
            "uid": "recipient",
            "disabled": False,
            "email": "personal@example.invalid",
            "email_verified": True,
            **change,
        }
    )
    with pytest.raises(DriveSharingError, match="recipient_verified_email_required"):
        recipient_from_verified_firebase_email("recipient", user, now=NOW)


@pytest.mark.parametrize(
    "change",
    [
        {"uid": "different-owner"},
        {"firebase": {"identities": {"google.com": ["1", "2"]}}},
        {"firebase": {"identities": {"google.com": ["999"]}}},
        {"firebase": None},
    ],
)
def test_recipient_requires_matching_linked_google_identity(change):
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
        {"email": "invalid\n@example.invalid"},
        {"provider_id": "apple.com"},
        {"uid": "987654321"},
    ],
)
def test_top_level_email_and_provider_hint_are_not_google_recipient_proof(change):
    with pytest.raises(DriveSharingError, match="verify_google_identity_required"):
        recipient_from_verified_firebase_claims(
            claims(), owner_user_id="recipient", google_provider=provider(**change), now=NOW
        )


@pytest.mark.parametrize("sign_in_provider", ["google.com", "apple.com", "password"])
def test_existing_session_uses_current_linked_google_without_reauthentication(sign_in_provider):
    value = claims()
    value.update(auth_time=1, email="different-primary@example.invalid", email_verified=False)
    value["firebase"]["sign_in_provider"] = sign_in_provider
    recipient = recipient_from_verified_firebase_claims(
        value, owner_user_id="recipient", google_provider=provider(), now=NOW
    )
    assert recipient.email == "recipient@example.invalid"
    assert recipient.verified_at == NOW


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


def _approval_with(*document_ids):
    from hushh_mcp.services.drive_sharing_contract import SharingApproval

    return SharingApproval.model_validate(
        {
            "request_id": "11111111-1111-4111-8111-111111111111",
            "revision": 1,
            "owner_user_id": "owner",
            "recipient_user_id": "recipient",
            "recipient_binding": "a" * 64,
            "connection_generation": 1,
            "sources": [
                {
                    "document_id": document_id,
                    "source_fingerprint": str(index) * 64,
                    "source_version": "1",
                    "index_version": "b" * 64,
                    "processing_revision": 0,
                }
                for index, document_id in enumerate(document_ids)
            ],
        }
    )


def test_narrowing_keeps_every_term_except_the_unselected_files():
    one, two = "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
    approval = _approval_with(one, two)
    narrowed = approval.narrowed_to([two])
    assert [str(source.document_id) for source in narrowed.sources] == [two]
    assert {**narrowed.model_dump(), "sources": None} == {**approval.model_dump(), "sources": None}


@pytest.mark.parametrize(
    "selection", [[], ["not-a-uuid"], ["44444444-4444-4444-8444-444444444444"]]
)
def test_narrowing_refuses_empty_invalid_or_outside_selections(selection):
    from hushh_mcp.services.drive_sharing_contract import DriveSharingError

    approval = _approval_with("22222222-2222-4222-8222-222222222222")
    with pytest.raises(DriveSharingError, match="review_changed"):
        approval.narrowed_to(selection)


def test_narrowing_refuses_a_repeated_file():
    from hushh_mcp.services.drive_sharing_contract import DriveSharingError

    one = "22222222-2222-4222-8222-222222222222"
    with pytest.raises(DriveSharingError, match="review_changed"):
        _approval_with(one, "33333333-3333-4333-8333-333333333333").narrowed_to([one, one])
