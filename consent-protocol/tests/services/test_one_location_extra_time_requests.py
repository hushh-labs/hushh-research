"""Extra-time location requests: the amount asked for survives the round trip.

The bug these cover: an access request had nowhere to put a duration. The Ask
screen collected one and dropped it at the API boundary; the "ask for more time"
path sent the literal string "Requesting more time." and nothing else. So the
owner was asked an unquantified question, approved from their own unrelated
control, and the person who asked found out how long they had only when it ran
out.

Every test here is about one fact staying intact from the ask to the grant --
including the ones that must NOT change: an owner can always grant less than was
asked, an unquantified ask still works, and a refused extension leaves the access
already held alone.
"""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from tests.services.test_one_location_agent_service import FourUserMemoryService


def _service_with_keys(*user_ids: str) -> FourUserMemoryService:
    service = FourUserMemoryService()
    for user_id in user_ids:
        service.register_recipient_key(
            user_id=user_id,
            key_id=f"key-{user_id}",
            public_key_jwk={"kty": "EC", "crv": "P-256", "x": user_id, "y": user_id},
        )
    return service


def _notifications(service: FourUserMemoryService, notification_type: str) -> list[dict]:
    return [
        item for item in service.notifications if item["notification_type"] == notification_type
    ]


def _event_metadata(event: dict) -> dict:
    metadata = event["metadata"]
    return json.loads(metadata) if isinstance(metadata, str) else metadata


def test_access_request_carries_the_duration_the_requester_asked_for() -> None:
    service = _service_with_keys("user_a", "user_b")

    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        message="Meeting you at the station",
        requested_duration_hours=3,
        requested_duration_mode="timed",
    )

    assert request["requestedDurationHours"] == 3
    assert request["requestedDurationMode"] == "timed"
    assert request["isExtension"] is False

    notification = _notifications(service, "location_access_request")[-1]
    assert notification["title"] == "Location access request"
    # The number is IN the body, not only in a payload field a surface might
    # forget to read. This is the line that reaches a lock screen.
    assert notification["body"] == "User B is asking to view your location for 3 hours."
    assert notification["data"]["requested_duration_hours"] == 3


def test_request_from_a_live_recipient_is_an_extension_ask() -> None:
    service = _service_with_keys("user_a", "user_b")
    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
    )

    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=4,
        requested_duration_mode="timed",
    )

    # Detected from the live grant, not asserted by the caller, so an older
    # client that only sends a duration still produces an extension ask.
    assert request["isExtension"] is True
    assert request["extendsGrantId"] == grant["id"]
    assert request["requestedDurationHours"] == 4

    notification = _notifications(service, "location_access_request")[-1]
    assert notification["title"] == "More location time requested"
    assert "4 hours more" in notification["body"]
    # How much they already hold, so "4 more" is a decision with a baseline.
    assert "left." in notification["body"]
    assert notification["data"]["is_extension"] == "true"
    assert notification["data"]["extends_grant_id"] == grant["id"]


def test_extension_ask_verifies_a_supplied_grant_id_against_the_real_share() -> None:
    service = _service_with_keys("user_a", "user_b", "user_c")
    other_grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_c",
        recipient_key_id="key-user_c",
        duration_hours=1,
    )

    # user_b holds no share from user_a and points at somebody else's grant.
    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=2,
        requested_duration_mode="timed",
        extends_grant_id=other_grant["id"],
    )

    assert request["extendsGrantId"] is None
    assert request["isExtension"] is False


def test_re_asking_for_more_time_updates_the_row_and_bumps_the_revision() -> None:
    service = _service_with_keys("user_a", "user_b")

    first = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=1,
        requested_duration_mode="timed",
    )
    second = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=4,
        requested_duration_mode="timed",
    )

    # One pending ask per pair stays the invariant; the ask itself moved.
    assert second["id"] == first["id"]
    assert second["requestedDurationHours"] == 4
    # The revision is what stops the owner's client de-duplicating the raised
    # number against the one it already showed.
    assert second["requestRevision"] == first["requestRevision"] + 1
    latest = _notifications(service, "location_access_request")[-1]
    assert latest["data"]["notification_revision"] == "2"
    assert "4 hours" in latest["body"]


def test_re_asking_with_an_unchanged_amount_does_not_bump_the_revision() -> None:
    service = _service_with_keys("user_a", "user_b")

    first = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=2,
        requested_duration_mode="timed",
    )
    again = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=2,
        requested_duration_mode="timed",
    )

    assert again["requestRevision"] == first["requestRevision"] == 1


def test_re_asking_without_a_note_keeps_the_note_already_on_the_row() -> None:
    service = _service_with_keys("user_a", "user_b")

    service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        message="Meeting you at the station",
        requested_duration_hours=1,
        requested_duration_mode="timed",
    )
    raised = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=4,
        requested_duration_mode="timed",
    )

    # Raising the amount is not a reason to erase why they asked.
    assert raised["message"] == "Meeting you at the station"


def test_approval_defaults_to_the_duration_that_was_asked_for() -> None:
    service = _service_with_keys("user_a", "user_b")
    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=4,
        requested_duration_mode="timed",
    )

    resolved = service.approve_request(
        owner_user_id="user_a",
        request_id=request["id"],
        duration_hours=None,
    )

    assert resolved["grant"]["durationHours"] == 4
    approved = _notifications(service, "location_access_approved")[-1]
    assert approved["body"] == "User A shared their live location with you 4 hours."


def test_owner_can_still_grant_less_than_was_asked_for() -> None:
    service = _service_with_keys("user_a", "user_b")
    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=24,
        requested_duration_mode="timed",
    )

    resolved = service.approve_request(
        owner_user_id="user_a",
        request_id=request["id"],
        duration_hours=0.5,
    )

    # An explicit duration always wins. Consent is the owner's to size.
    assert resolved["grant"]["durationHours"] == 0.5


def test_approval_with_no_duration_anywhere_falls_back_to_one_hour() -> None:
    service = _service_with_keys("user_a", "user_b")
    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
    )

    resolved = service.approve_request(
        owner_user_id="user_a",
        request_id=request["id"],
        duration_hours=None,
    )

    assert resolved["grant"]["durationHours"] == 1


def test_approving_extra_time_replaces_the_live_grant_rather_than_stacking() -> None:
    service = _service_with_keys("user_a", "user_b")
    original = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
    )
    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=4,
        requested_duration_mode="timed",
    )

    resolved = service.approve_request(
        owner_user_id="user_a",
        request_id=request["id"],
        duration_hours=None,
    )

    # Two live grants between the same pair would show as two "Live" rows, and
    # every countdown would pick one of them arbitrarily.
    assert service.grants[original["id"]]["status"] == "revoked"
    live = [
        grant
        for grant in service.grants.values()
        if grant["owner_user_id"] == "user_a"
        and grant["recipient_user_id"] == "user_b"
        and grant["status"] == "active"
    ]
    assert len(live) == 1
    assert live[0]["id"] == resolved["grant"]["id"]
    # The replacement grant is not just the 4 that was asked for -- it is the
    # original hour still running PLUS the 4 more, so the recipient never
    # loses time they already had by asking for more of it. (Some slack for
    # however long this test itself took to run.)
    assert resolved["grant"]["durationHours"] == pytest.approx(5.0, abs=0.01)

    approved = _notifications(service, "location_access_approved")[-1]
    assert approved["title"] == "More location time approved"
    # The notification names the 4 hours that were ADDED, not the ~5-hour
    # total the share now runs to -- that total is not new information to
    # the person who already knew what they had a second ago.
    assert approved["body"] == "User A gave you 4 hours more of their live location."


def test_declining_extra_time_says_existing_access_is_untouched() -> None:
    service = _service_with_keys("user_a", "user_b")
    service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
    )
    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=4,
        requested_duration_mode="timed",
    )

    service.deny_request(owner_user_id="user_a", request_id=request["id"])

    denied = _notifications(service, "location_access_denied")[-1]
    assert denied["title"] == "Extra time declined"
    # A bare "denied" reads as if everything stopped, which is the opposite of
    # what happened: the hour they already hold is still running.
    assert "already have is unchanged" in denied["body"]


def test_requested_duration_outside_policy_bounds_is_rejected() -> None:
    service = _service_with_keys("user_a", "user_b")

    with pytest.raises(OneLocationAgentError) as too_long:
        service.request_access(
            requester_user_id="user_b",
            owner_user_id="user_a",
            requested_duration_hours=48,
            requested_duration_mode="timed",
        )
    assert too_long.value.code == "LOCATION_DURATION_INVALID"

    with pytest.raises(OneLocationAgentError) as bad_mode:
        service.request_access(
            requester_user_id="user_b",
            owner_user_id="user_a",
            requested_duration_hours=1,
            requested_duration_mode="forever",
        )
    assert bad_mode.value.code == "LOCATION_DURATION_MODE_INVALID"


def test_an_unquantified_ask_still_works_and_leaves_the_amount_to_the_owner() -> None:
    """Older clients send no duration. That must stay a supported ask."""
    service = _service_with_keys("user_a", "user_b")

    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        message="Can I see your location?",
    )

    assert request["requestedDurationHours"] is None
    assert request["requestedDurationMode"] is None
    notification = _notifications(service, "location_access_request")[-1]
    assert notification["body"] == "User B is asking to view your location."


def test_request_events_name_both_parties_for_the_two_sided_feed() -> None:
    service = _service_with_keys("user_a", "user_b")
    request = service.request_access(
        requester_user_id="user_b",
        owner_user_id="user_a",
        requested_duration_hours=3,
        requested_duration_mode="timed",
    )
    service.approve_request(owner_user_id="user_a", request_id=request["id"], duration_hours=None)

    request_events = [
        event
        for event in service.events.values()
        if event["event_type"] in {"location_access_request", "location_access_approved"}
    ]
    assert request_events
    for event in request_events:
        metadata = _event_metadata(event)
        # The feed fan-out writes each of these rows to BOTH people and swaps
        # counterpart_label for the requester's copy, so the owner's own name
        # has to be on the row for the swap to have anything to use.
        assert metadata["owner_label"] == "User A"
        assert metadata["counterpart_label"] == "User B"
        # And the amount, so the feed line can name it.
        assert metadata.get("requested_duration_hours") == 3 or metadata.get("duration_hours") == 3
