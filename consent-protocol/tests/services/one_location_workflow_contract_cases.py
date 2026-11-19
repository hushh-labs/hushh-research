from __future__ import annotations

import json
from collections.abc import Callable

import pytest

from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
)

EnvelopeFactory = Callable[[str, str], dict]


def run_four_user_location_workflow_contract(
    service: OneLocationAgentService,
    envelope_factory: EnvelopeFactory,
) -> None:
    user_a, user_b, user_c, user_d = _register_users(service)
    grant_b = _assert_account_keyed_share(service, user_a, user_b, user_c, envelope_factory)
    request_c = _assert_duration_and_retry_contract(service, user_a, user_c)
    _assert_manual_approval_for_c(service, user_a, user_c, request_c, envelope_factory)
    referral = _assert_referral_retry_contract(service, user_b, user_d, grant_b)
    _assert_manual_approval_for_d(service, user_a, user_d, referral, envelope_factory)
    _assert_revocation_and_private_state(service, user_a, user_b, grant_b)


def _register_users(
    service: OneLocationAgentService,
) -> tuple[str, str, str, str]:
    users = ("user_a", "user_b", "user_c", "user_d")
    for user_id in users:
        service.register_recipient_key(
            user_id=user_id,
            key_id=f"key-{user_id}",
            public_key_jwk={"kty": "EC", "crv": "P-256", "x": user_id, "y": user_id},
        )
    service.identities[users[2]]["phone_verified"] = False
    return users


def _assert_account_keyed_share(
    service: OneLocationAgentService,
    user_a: str,
    user_b: str,
    user_c: str,
    envelope_factory: EnvelopeFactory,
) -> dict:
    grant_b = service.create_grant(
        owner_user_id=user_a,
        recipient_user_id=user_b,
        recipient_key_id=f"key-{user_b}",
        duration_hours=1,
    )
    share_notification = next(
        item
        for item in service.notifications
        if item["notification_type"] == "location_share_created"
        and (item.get("data") or {}).get("grant_id") == grant_b["id"]
    )
    assert share_notification["body"] == "User A shared location access with you."
    assert "phone" not in json.dumps(share_notification).lower()
    assert "0001" not in json.dumps(share_notification)

    service.store_encrypted_envelope(
        owner_user_id=user_a,
        grant_id=grant_b["id"],
        envelope=envelope_factory(f"key-{user_b}", "ciphertext-for-b"),
    )
    viewed_b = service.view_latest_envelope(recipient_user_id=user_b, grant_id=grant_b["id"])
    assert viewed_b["envelope"]["ciphertext"] == "ciphertext-for-b"

    with pytest.raises(OneLocationAgentError) as denied_c:
        service.view_latest_envelope(recipient_user_id=user_c, grant_id=grant_b["id"])
    assert denied_c.value.code == "LOCATION_GRANT_NOT_FOUND"

    # A missing phone claim is unrelated to private, account-keyed receiving.
    grant_c = service.create_grant(
        owner_user_id=user_a,
        recipient_user_id=user_c,
        recipient_key_id=f"key-{user_c}",
        duration_hours=1,
    )
    assert grant_c["recipientUserId"] == user_c
    assert service.identities[user_c]["phone_verified"] is False
    return grant_b


def _assert_duration_and_retry_contract(
    service: OneLocationAgentService,
    user_a: str,
    user_c: str,
) -> dict:
    request_event_count = sum(
        event["event_type"] == "location_access_request" for event in service.events.values()
    )
    request_notification_count = sum(
        item["notification_type"] == "location_access_request" for item in service.notifications
    )
    direct_request_c = service.request_access(
        requester_user_id=user_c,
        owner_user_id=user_a,
        message="Can you share where you are?",
        requested_duration_hours=4,
    )
    assert direct_request_c["requestedDurationHours"] == 4

    duplicate_request_c = service.request_access(
        requester_user_id=user_c,
        owner_user_id=user_a,
        message="Can you share where you are now?",
        requested_duration_hours=24,
    )
    assert duplicate_request_c["id"] == direct_request_c["id"]
    assert duplicate_request_c["message"] == "Can you share where you are now?"
    assert duplicate_request_c["requestedDurationHours"] == 24

    exact_retry_c = service.request_access(
        requester_user_id=user_c,
        owner_user_id=user_a,
        message="Can you share where you are now?",
        requested_duration_hours=24,
    )
    assert exact_retry_c["id"] == direct_request_c["id"]
    assert exact_retry_c["requestedDurationHours"] == 24
    assert (
        sum(event["event_type"] == "location_access_request" for event in service.events.values())
        == request_event_count + 2
    )
    assert (
        sum(
            item["notification_type"] == "location_access_request" for item in service.notifications
        )
        == request_notification_count + 2
    )
    return direct_request_c


def _assert_manual_approval_for_c(
    service: OneLocationAgentService,
    user_a: str,
    user_c: str,
    request_c: dict,
    envelope_factory: EnvelopeFactory,
) -> None:
    approved_c = service.approve_request(
        owner_user_id=user_a,
        request_id=request_c["id"],
        approval_mode="manual",
        duration_hours=1,
    )
    grant_c = approved_c["grant"]
    assert grant_c["recipientUserId"] == user_c
    grant_c_notifications = [
        item
        for item in service.notifications
        if str((item.get("data") or {}).get("grant_id") or "") == grant_c["id"]
    ]
    assert [item["notification_type"] for item in grant_c_notifications] == [
        "location_access_approved"
    ]
    service.store_encrypted_envelope(
        owner_user_id=user_a,
        grant_id=grant_c["id"],
        envelope=envelope_factory(f"key-{user_c}", "ciphertext-for-c"),
    )
    viewed_c = service.view_latest_envelope(recipient_user_id=user_c, grant_id=grant_c["id"])
    assert viewed_c["envelope"]["ciphertext"] == "ciphertext-for-c"


def _assert_referral_retry_contract(
    service: OneLocationAgentService,
    user_b: str,
    user_d: str,
    grant_b: dict,
) -> dict:
    referral_response = service.refer_recipient(
        referring_user_id=user_b,
        grant_id=grant_b["id"],
        referred_user_id=user_d,
    )
    assert referral_response["referral"]["status"] == "pending_owner_approval"
    assert referral_response["request"]["status"] == "pending"

    referral_event_count = sum(
        event["event_type"] == "location_referral_invite" for event in service.events.values()
    )
    referral_notification_count = sum(
        item["notification_type"] == "location_referral_invite" for item in service.notifications
    )
    retried_referral = service.refer_recipient(
        referring_user_id=user_b,
        grant_id=grant_b["id"],
        referred_user_id=user_d,
    )
    assert retried_referral["referral"]["id"] == referral_response["referral"]["id"]
    assert retried_referral["request"]["id"] == referral_response["request"]["id"]
    assert (
        sum(event["event_type"] == "location_referral_invite" for event in service.events.values())
        == referral_event_count
    )
    assert (
        sum(
            item["notification_type"] == "location_referral_invite"
            for item in service.notifications
        )
        == referral_notification_count
    )

    with pytest.raises(OneLocationAgentError):
        service.view_latest_envelope(recipient_user_id=user_d, grant_id=grant_b["id"])
    return referral_response


def _assert_manual_approval_for_d(
    service: OneLocationAgentService,
    user_a: str,
    user_d: str,
    referral: dict,
    envelope_factory: EnvelopeFactory,
) -> None:
    approved_d = service.approve_request(
        owner_user_id=user_a,
        request_id=referral["request"]["id"],
        approval_mode="manual",
        duration_hours=1,
    )
    grant_d = approved_d["grant"]
    service.store_encrypted_envelope(
        owner_user_id=user_a,
        grant_id=grant_d["id"],
        envelope=envelope_factory(f"key-{user_d}", "ciphertext-for-d"),
    )
    viewed_d = service.view_latest_envelope(recipient_user_id=user_d, grant_id=grant_d["id"])
    assert viewed_d["envelope"]["ciphertext"] == "ciphertext-for-d"


def _assert_revocation_and_private_state(
    service: OneLocationAgentService,
    user_a: str,
    user_b: str,
    grant_b: dict,
) -> None:
    service.revoke_grant(owner_user_id=user_a, grant_id=grant_b["id"])
    with pytest.raises(OneLocationAgentError) as revoked_b:
        service.view_latest_envelope(recipient_user_id=user_b, grant_id=grant_b["id"])
    assert revoked_b.value.code == "LOCATION_GRANT_NOT_ACTIVE"
    assert {item["notification_type"] for item in service.notifications} >= {
        "location_share_created",
        "location_access_request",
        "location_access_approved",
        "location_referral_invite",
        "location_share_revoked",
    }
    assert "latitude" not in json.dumps(service.notifications, default=str)
    assert "longitude" not in json.dumps(service.notifications, default=str)

    serialized_state = json.dumps(
        {
            "grants": service.grants,
            "envelopes": service.envelopes,
            "requests": service.requests,
            "referrals": service.referrals,
        },
        default=str,
    )
    assert "latitude" not in serialized_state
    assert "longitude" not in serialized_state
