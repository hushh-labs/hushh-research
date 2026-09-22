"""Owner-level sharing posture (migration 221) is enforced on every share write.

Uses the in-memory Location service double so the enforcement is proven on the
same write paths the routes and voice tools call.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from tests.services.test_one_location_agent_service import (
    FourUserMemoryService,
    encrypted_envelope,
)

OWNER = "user_a"
RECIPIENT = "user_b"


def _service(sharing_state: str = "unset", precision: str = "precise") -> FourUserMemoryService:
    service = FourUserMemoryService()
    for user_id in (OWNER, RECIPIENT):
        service.register_recipient_key(
            user_id=user_id,
            key_id=f"key-{user_id}",
            public_key_jwk={"kty": "EC", "crv": "P-256", "x": user_id, "y": user_id},
        )
    service.sms_contacts.add((OWNER, RECIPIENT))
    service.account_settings = {}
    if sharing_state != "unset" or precision != "precise":
        service.account_settings[OWNER] = {"sharing_state": sharing_state, "precision": precision}
    return service


def _grant(service: FourUserMemoryService, **overrides):
    kwargs = {
        "owner_user_id": OWNER,
        "recipient_user_id": RECIPIENT,
        "recipient_key_id": f"key-{RECIPIENT}",
        "duration_hours": 1,
    }
    kwargs.update(overrides)
    return service.create_grant(**kwargs)


def test_unset_posture_changes_nothing_for_existing_users():
    service = _service()
    grant = _grant(service)
    assert grant["status"] == "active"


def test_sharing_off_refuses_a_new_share():
    service = _service(sharing_state="off")
    with pytest.raises(OneLocationAgentError) as excinfo:
        _grant(service)
    assert excinfo.value.code == "LOCATION_SHARING_OFF"
    assert excinfo.value.status_code == 409


def test_sharing_off_never_blocks_the_sos_lane():
    service = _service(sharing_state="off")
    grant = _grant(service, share_kind="sos", reason="sos_panic", duration_hours=8)
    assert grant["status"] == "active"


def test_sharing_off_refuses_a_new_envelope_on_an_existing_share():
    service = _service()
    grant = _grant(service)
    service.account_settings[OWNER] = {"sharing_state": "off", "precision": "precise"}
    with pytest.raises(OneLocationAgentError) as excinfo:
        service.store_encrypted_envelope(
            owner_user_id=OWNER,
            grant_id=grant["id"],
            envelope=encrypted_envelope(f"key-{RECIPIENT}"),
        )
    assert excinfo.value.code == "LOCATION_SHARING_OFF"


def test_approximate_preference_rejects_an_untagged_envelope():
    service = _service(sharing_state="on", precision="approximate")
    grant = _grant(service)
    with pytest.raises(OneLocationAgentError) as excinfo:
        service.store_encrypted_envelope(
            owner_user_id=OWNER,
            grant_id=grant["id"],
            envelope=encrypted_envelope(f"key-{RECIPIENT}"),
        )
    assert excinfo.value.code == "LOCATION_PRECISION_MISMATCH"


def test_approximate_preference_accepts_a_tagged_envelope():
    service = _service(sharing_state="on", precision="approximate")
    grant = _grant(service)
    envelope = encrypted_envelope(f"key-{RECIPIENT}")
    envelope["metadata"] = {"precision": "approximate"}
    stored = service.store_encrypted_envelope(
        owner_user_id=OWNER, grant_id=grant["id"], envelope=envelope
    )
    assert stored


def test_invalid_precision_tag_is_rejected_regardless_of_preference():
    service = _service()
    grant = _grant(service)
    envelope = encrypted_envelope(f"key-{RECIPIENT}")
    envelope["metadata"] = {"precision": "fuzzy"}
    with pytest.raises(OneLocationAgentError) as excinfo:
        service.store_encrypted_envelope(
            owner_user_id=OWNER, grant_id=grant["id"], envelope=envelope
        )
    assert excinfo.value.code == "LOCATION_PRECISION_INVALID"


def test_sos_envelopes_are_always_precise_and_exempt_from_the_preference():
    service = _service(sharing_state="on", precision="approximate")
    grant = _grant(service, share_kind="sos", reason="sos_panic", duration_hours=8)
    stored = service.store_encrypted_envelope(
        owner_user_id=OWNER,
        grant_id=grant["id"],
        envelope=encrypted_envelope(f"key-{RECIPIENT}"),
    )
    assert stored
