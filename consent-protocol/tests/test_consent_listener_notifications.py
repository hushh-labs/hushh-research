import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from api.consent_listener import (
    REQUESTER_ANSWER_BODY,
    _notify_information_requester,
    build_consent_push_content,
)
from api.utils.consent_notifications import (
    FINAL_REMINDER_LEAD_MS,
    next_pending_notification,
)


def _pending_payload(*, issued_at: int = 0, approval_timeout_at: int) -> dict:
    return {
        "request_id": "req-123",
        "issued_at": issued_at,
        "approval_timeout_at": approval_timeout_at,
    }


def test_next_pending_notification_sends_initial_request_first():
    next_delivery = next_pending_notification(
        _pending_payload(issued_at=0, approval_timeout_at=3 * 60 * 60 * 1000),
        [],
        now_ms=0,
    )

    assert next_delivery == (1, "initial_request")


def test_next_pending_notification_skips_midpoint_and_only_sends_final_reminder():
    approval_timeout_at = 3 * 60 * 60 * 1000
    next_delivery = next_pending_notification(
        _pending_payload(issued_at=0, approval_timeout_at=approval_timeout_at),
        [
            {
                "action": "NOTIFICATION_SENT",
                "metadata": {
                    "notification_sequence": 1,
                    "delivery_reason": "initial_request",
                },
            }
        ],
        now_ms=approval_timeout_at // 2,
    )
    assert next_delivery is None

    final_delivery = next_pending_notification(
        _pending_payload(issued_at=0, approval_timeout_at=approval_timeout_at),
        [
            {
                "action": "NOTIFICATION_SENT",
                "metadata": {
                    "notification_sequence": 1,
                    "delivery_reason": "initial_request",
                },
            }
        ],
        now_ms=approval_timeout_at - FINAL_REMINDER_LEAD_MS,
    )

    assert final_delivery == (2, "final_reminder")


def test_next_pending_notification_stops_after_opened():
    next_delivery = next_pending_notification(
        _pending_payload(issued_at=0, approval_timeout_at=3 * 60 * 60 * 1000),
        [
            {
                "action": "NOTIFICATION_OPENED",
                "metadata": {},
            }
        ],
        now_ms=3 * 60 * 60 * 1000,
    )

    assert next_delivery is None


def test_person_request_resolution_wakes_only_database_bound_requester():
    bundle_id = "18e15d76-c850-5b8b-83ea-8a2f57ac15d0"
    query_parameters = []
    delivered = []

    class Database:
        def execute_raw(self, _query, parameters):
            query_parameters.append(parameters)
            return SimpleNamespace(data=[{"requester_user_id": "requester-1"}])

    async def dispatch(user_id, payload):
        delivered.append((user_id, payload))

    with (
        patch("db.db_client.get_db", return_value=Database()),
        patch("api.consent_listener._dispatch_notification_for_user", side_effect=dispatch),
    ):
        asyncio.run(
            _notify_information_requester(
                {
                    "action": "CONSENT_GRANTED",
                    "user_id": "subject-1",
                    "bundle_id": bundle_id,
                    "request_id": "one_person_request-1",
                    "requester_user_id": "forged-requester",
                    "plaintext": "must-not-travel",
                }
            )
        )

    assert query_parameters == [
        {
            "bundle_id": bundle_id,
            "subject_user_id": "subject-1",
            "request_id": "one_person_request-1",
        }
    ]
    assert delivered == [
        (
            "requester-1",
            {
                "type": "information_request_updated",
                "user_id": "requester-1",
                "action": "CONSENT_GRANTED",
                "bundle_id": bundle_id,
                "request_id": "one_person_request-1",
                "message_id": f"information-request:{bundle_id}:one_person_request-1:CONSENT_GRANTED:",
                "request_url": "/",
                "deep_link": "/",
            },
        )
    ]


def test_unresolved_or_unbound_person_request_never_wakes_a_requester():
    class Database:
        def execute_raw(self, _query, _parameters):
            return SimpleNamespace(data=[])

    async def dispatch(_user_id, _payload):
        raise AssertionError("No requester may be notified")

    with (
        patch("db.db_client.get_db", return_value=Database()),
        patch("api.consent_listener._dispatch_notification_for_user", side_effect=dispatch),
    ):
        for payload in (
            {
                "action": "REQUESTED",
                "bundle_id": "18e15d76-c850-5b8b-83ea-8a2f57ac15d0",
                "request_id": "r",
                "user_id": "subject-1",
            },
            {
                "action": "CONSENT_GRANTED",
                "bundle_id": "not-a-bundle",
                "request_id": "r",
                "user_id": "subject-1",
            },
            {
                "action": "CONSENT_GRANTED",
                "bundle_id": "18e15d76-c850-5b8b-83ea-8a2f57ac15d0",
                "request_id": "r",
                "user_id": "subject-1",
            },
        ):
            asyncio.run(_notify_information_requester(payload))


# --- Bare consent push (fcm-notifications.md trust rule) ---------------------

_PRIVATE_WORDS = ("penicillin", "attr.health.allergies", "Allergies", "birthday dinner")


def test_owner_consent_push_names_the_requester_and_carries_no_request_content():
    # Negative control: every private field is present in the event, and none
    # may reach the title, body or data that the push provider and lock screen see.
    title, body, data, show_alert = build_consent_push_content(
        "owner-uid",
        {
            "request_id": "req-1",
            "action": "REQUESTED",
            "requester_label": "Kushal",
            "scope": "attr.health.allergies",
            "scope_description": "Allergies",
            "reason": "Planning a birthday dinner",
            "additional_access_summary": "Also asks about penicillin",
            "existing_granted_scopes": ["attr.health.allergies"],
            "bundle_label": "Allergies",
            "bundle_id": "b1",
        },
    )

    assert show_alert is True
    assert body == "Kushal asked to see your information"
    rendered = " ".join([title, body, *data.keys(), *data.values()])
    for word in _PRIVATE_WORDS:
        assert word not in rendered
    assert data["type"] == "consent_request"
    assert data["request_id"] == "req-1"


def test_requester_answer_push_is_bare_and_opens_the_asking_chat():
    bundle = "0f0e0d0c-0b0a-4908-8706-050403020100"
    title, body, data, show_alert = build_consent_push_content(
        "requester-uid",
        {
            "type": "information_request_updated",
            "action": "CONSENT_GRANTED",
            "bundle_id": bundle,
            "request_id": "req-1",
            "scope_description": "Allergies",
        },
    )

    assert show_alert is True
    assert (title, body) == ("Hussh One", REQUESTER_ANSWER_BODY)
    assert data["request_url"] == data["deep_link"] == f"/?informationRequest={bundle}"
    assert "Allergies" not in " ".join(data.values())

    # A revocation changes state but has no answer to open: it stays silent.
    _t, _b, _d, revoked_alert = build_consent_push_content(
        "requester-uid",
        {"type": "information_request_updated", "action": "REVOKED", "bundle_id": bundle},
    )
    assert revoked_alert is False
