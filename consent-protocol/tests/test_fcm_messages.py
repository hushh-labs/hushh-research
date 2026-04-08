from api.utils.fcm_messages import build_push_message


class _MessagingStub:
    class Notification:
        def __init__(self, title=None, body=None):
            self.title = title
            self.body = body

    class WebpushNotification:
        def __init__(self, title=None, body=None, tag=None, require_interaction=None, data=None):
            self.title = title
            self.body = body
            self.tag = tag
            self.require_interaction = require_interaction
            self.data = data

    class WebpushFCMOptions:
        def __init__(self, link=None):
            self.link = link

    class WebpushConfig:
        def __init__(self, headers=None, notification=None, fcm_options=None):
            self.headers = headers
            self.notification = notification
            self.fcm_options = fcm_options

    class ApsAlert:
        def __init__(self, title=None, body=None):
            self.title = title
            self.body = body

    class Aps:
        def __init__(
            self,
            alert=None,
            sound=None,
            badge=None,
            content_available=None,
            category=None,
            thread_id=None,
        ):
            self.alert = alert
            self.sound = sound
            self.badge = badge
            self.content_available = content_available
            self.category = category
            self.thread_id = thread_id

    class APNSPayload:
        def __init__(self, aps=None, custom_data=None):
            self.aps = aps
            self.custom_data = custom_data

    class APNSConfig:
        def __init__(self, headers=None, payload=None):
            self.headers = headers
            self.payload = payload

    class Message:
        def __init__(self, token=None, data=None, notification=None, webpush=None, apns=None):
            self.token = token
            self.data = data
            self.notification = notification
            self.webpush = webpush
            self.apns = apns


def test_build_push_message_for_ios_uses_explicit_apns_alert():
    delivery_target = "ios-device-id"
    message = build_push_message(
        _MessagingStub,
        token=delivery_target,
        platform="ios",
        data={
            "type": "consent_request",
            "request_url": "https://uat.kai.hushh.ai/consents?tab=pending",
            "deep_link": "https://uat.kai.hushh.ai/consents?tab=pending",
            "notification_tag": "consent-request:test",
        },
        title="Consent request",
        body="Advisor access needs review.",
        request_url="https://uat.kai.hushh.ai/consents?tab=pending",
        notification_tag="consent-request:test",
        show_alert=True,
    )

    assert message.notification.title == "Consent request"
    assert message.notification.body == "Advisor access needs review."
    assert message.webpush is None
    assert message.apns is not None
    assert message.apns.headers == {
        "apns-push-type": "alert",
        "apns-priority": "10",
    }
    assert message.apns.payload.aps.alert.title == "Consent request"
    assert message.apns.payload.aps.alert.body == "Advisor access needs review."
    assert message.apns.payload.aps.sound == "default"
    assert message.apns.payload.aps.badge == 1
    assert message.apns.payload.aps.category == "CONSENT_REQUEST"
    assert message.apns.payload.aps.thread_id == "consent-request:test"
    assert (
        message.apns.payload.custom_data["request_url"]
        == "https://uat.kai.hushh.ai/consents?tab=pending"
    )


def test_build_push_message_for_web_keeps_webpush_notification():
    delivery_target = "web-device-id"
    message = build_push_message(
        _MessagingStub,
        token=delivery_target,
        platform="web",
        data={
            "type": "consent_request",
            "request_url": "https://uat.kai.hushh.ai/consents?tab=pending",
            "deep_link": "https://uat.kai.hushh.ai/consents?tab=pending",
            "notification_tag": "consent-request:test",
        },
        title="Consent request",
        body="Advisor access needs review.",
        request_url="https://uat.kai.hushh.ai/consents?tab=pending",
        notification_tag="consent-request:test",
        show_alert=True,
    )

    assert message.notification.title == "Consent request"
    assert message.apns is None
    assert message.webpush is not None
    assert message.webpush.headers == {"Urgency": "high"}
    assert message.webpush.notification.tag == "consent-request:test"
    assert message.webpush.notification.require_interaction is True
    assert message.webpush.fcm_options.link == "https://uat.kai.hushh.ai/consents?tab=pending"


def test_build_push_message_without_alert_is_data_only():
    delivery_target = "web-device-id"
    message = build_push_message(
        _MessagingStub,
        token=delivery_target,
        platform="ios",
        data={"type": "consent_resolved"},
        title="Consent updated",
        body="Request resolved.",
        request_url="https://uat.kai.hushh.ai/consents?tab=pending",
        notification_tag="consent-request:test",
        show_alert=False,
    )

    assert message.notification is None
    assert message.apns is not None
    assert message.webpush is None
    assert message.data == {"type": "consent_resolved"}
    assert message.apns.headers == {
        "apns-push-type": "background",
        "apns-priority": "5",
    }
    assert message.apns.payload.aps.content_available is True
    assert message.apns.payload.aps.thread_id == "consent-request:test"
