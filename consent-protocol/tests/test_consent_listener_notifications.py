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
