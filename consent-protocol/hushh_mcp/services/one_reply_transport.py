"""Bounded FCM HTTP v1 send. The durable ledger, rather than HTTP, owns retries."""

from __future__ import annotations

import hashlib
import threading
import time

_REFRESH_LOCK = threading.Lock()


def send_reply(*, token, platform, data, title, body, tag, expires_at, deadline, before_send):
    import firebase_admin
    import requests
    from firebase_admin import messaging
    from google.auth.transport.requests import Request

    def remaining():
        budget = deadline - time.monotonic()
        if budget <= 0:
            raise TimeoutError("Reply delivery budget elapsed.")
        return budget

    app = firebase_admin.get_app()
    credential = app.credential.get_credential()
    with requests.Session() as session:
        # Each auth HTTP hop is bounded by the same original deadline. A
        # refresh cannot restart the delivery budget or retry a provider send.
        request = Request(session=session)

        def bounded_request(*args, **kwargs):
            kwargs["timeout"] = min(5, remaining())
            return request(*args, **kwargs)

        if not _REFRESH_LOCK.acquire(timeout=remaining()):
            raise TimeoutError("Reply credential budget elapsed.")
        try:
            if not credential.valid:
                credential.refresh(bounded_request)
        finally:
            _REFRESH_LOCK.release()
        if not before_send():
            raise RuntimeError("Reply delivery claim changed.")
        remaining()  # The claim check itself can block.
        message = _native_message(token, platform, data, title, body, tag, expires_at)
        # requests' default adapter has no automatic retries. Unknown outcomes
        # retain the event ID and may be retried; provider exactly-once is absent.
        response = session.post(
            f"https://fcm.googleapis.com/v1/projects/{app.project_id}/messages:send",
            headers={"Authorization": f"Bearer {credential.token}"},
            json={"message": message},
            timeout=(min(5, remaining()), min(10, remaining())),
        )
        if response.status_code == 200:
            return
        try:
            details = response.json().get("error", {}).get("details", [])
            codes = {item.get("errorCode") for item in details if isinstance(item, dict)}
        except (ValueError, AttributeError, TypeError):
            codes = set()
        if "UNREGISTERED" in codes:
            raise messaging.UnregisteredError("Reply device unavailable.")
        if "SENDER_ID_MISMATCH" in codes:
            raise messaging.SenderIdMismatchError("Reply device unavailable.")
        raise RuntimeError("Reply provider did not accept delivery.")


def _native_message(token, platform, data, title, body, tag, expires_at):
    message = {
        "token": token,
        "data": {**data, "notification_presentation": "alert"},
        "notification": {"title": title, "body": body},
    }
    if platform == "android":
        message["android"] = {
            "priority": "HIGH",
            "ttl": f"{max(0, expires_at - int(time.time()))}s",
            "notification": {"tag": tag},
        }
    elif platform == "ios":
        message["apns"] = {
            "headers": {
                "apns-push-type": "alert",
                "apns-priority": "10",
                "apns-expiration": str(expires_at),
                "apns-collapse-id": hashlib.sha256(tag.encode()).hexdigest(),
            },
            "payload": {
                "aps": {
                    "alert": {"title": title, "body": body},
                    "sound": "default",
                    "badge": 1,
                    "thread-id": tag,
                }
            },
        }
    else:
        raise ValueError("Reply delivery requires a native device.")
    return message
