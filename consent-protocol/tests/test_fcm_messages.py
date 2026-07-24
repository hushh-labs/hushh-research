from api.utils.fcm_messages import build_push_message


class _MessagingStub:
    class Notification:
        def __init__(self, title=None, body=None):
            self.title = title
            self.body = body

    class WebpushNotification:
        def __init__(
            self,
            title=None,
            body=None,
            tag=None,
            require_interaction=None,
            data=None,
            renotify=None,
            silent=None,
            vibrate=None,
        ):
            self.title = title
            self.body = body
            self.tag = tag
            self.require_interaction = require_interaction
            self.data = data
            self.renotify = renotify
            self.silent = silent
            self.vibrate = vibrate

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

    class AndroidNotification:
        def __init__(
            self,
            title=None,
            body=None,
            channel_id=None,
            tag=None,
            ticker=None,
            priority=None,
            visibility=None,
            vibrate_timings_millis=None,
        ):
            self.title = title
            self.body = body
            self.channel_id = channel_id
            self.tag = tag
            self.ticker = ticker
            self.priority = priority
            self.visibility = visibility
            self.vibrate_timings_millis = vibrate_timings_millis

    class AndroidConfig:
        def __init__(self, priority=None, notification=None):
            self.priority = priority
            self.notification = notification

    class Message:
        def __init__(
            self,
            token=None,
            data=None,
            notification=None,
            webpush=None,
            apns=None,
            android=None,
        ):
            self.token = token
            self.data = data
            self.notification = notification
            self.webpush = webpush
            self.apns = apns
            self.android = android


def test_build_push_message_for_ios_uses_explicit_apns_alert():
    delivery_target = "ios-device-id"
    message = build_push_message(
        _MessagingStub,
        token=delivery_target,
        platform="ios",
        data={
            "type": "consent_request",
            "request_url": "https://uat.one.hushh.ai/consents?tab=pending",
            "deep_link": "https://uat.one.hushh.ai/consents?tab=pending",
            "notification_tag": "consent-request:test",
        },
        title="Consent request",
        body="Advisor access needs review.",
        request_url="https://uat.one.hushh.ai/consents?tab=pending",
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
        == "https://uat.one.hushh.ai/consents?tab=pending"
    )


def test_build_push_message_for_web_keeps_webpush_notification():
    delivery_target = "web-device-id"
    message = build_push_message(
        _MessagingStub,
        token=delivery_target,
        platform="web",
        data={
            "type": "consent_request",
            "request_url": "https://uat.one.hushh.ai/consents?tab=pending",
            "deep_link": "https://uat.one.hushh.ai/consents?tab=pending",
            "notification_tag": "consent-request:test",
        },
        title="Consent request",
        body="Advisor access needs review.",
        request_url="https://uat.one.hushh.ai/consents?tab=pending",
        notification_tag="consent-request:test",
        show_alert=True,
    )

    assert message.notification.title == "Consent request"
    assert message.apns is None
    assert message.webpush is not None
    assert message.webpush.headers == {"Urgency": "high"}
    assert message.webpush.notification.tag == "consent-request:test"
    assert message.webpush.notification.require_interaction is True
    assert message.webpush.fcm_options.link == "https://uat.one.hushh.ai/consents?tab=pending"


def test_location_notification_name_only_body_reaches_every_platform() -> None:
    body = "hushh Social shared location access with you."
    android_target = "android-device-id"
    web_target = "web-device-id"
    ios_target = "ios-device-id"

    android = build_push_message(
        _MessagingStub,
        token=android_target,
        platform="android",
        data={"type": "location_share_created"},
        title="Location shared",
        body=body,
        request_url="/one/location",
        notification_tag="one-location-share:test",
        show_alert=True,
    )
    web = build_push_message(
        _MessagingStub,
        token=web_target,
        platform="web",
        data={"type": "location_share_created"},
        title="Location shared",
        body=body,
        request_url="/one/location",
        notification_tag="one-location-share:test",
        show_alert=True,
    )
    ios = build_push_message(
        _MessagingStub,
        token=ios_target,
        platform="ios",
        data={"type": "location_share_created"},
        title="Location shared",
        body=body,
        request_url="/one/location",
        notification_tag="one-location-share:test",
        show_alert=True,
    )

    assert android.notification.body == body
    assert web.notification.body == body
    assert web.webpush.notification.body == body
    assert ios.notification.body == body
    assert ios.apns.payload.aps.alert.body == body


def test_sms_emergency_uses_distinct_cross_platform_alert_profile() -> None:
    android_delivery_target = "android-device-id"
    ios_delivery_target = "ios-device-id"
    web_delivery_target = "web-device-id"
    data = {
        "type": "location_share_created",
        "share_kind": "sos",
        "notification_profile": "one_location_sms_emergency",
        "notification_category": "ONE_LOCATION_SMS_EMERGENCY",
    }
    common = {
        "data": data,
        "title": "SMS · Save my soul",
        "body": "Alex: Come get me",
        "request_url": "/one/location?section=shared",
        "notification_tag": "one-location-share:sms-1",
        "show_alert": True,
    }

    android = build_push_message(
        _MessagingStub,
        token=android_delivery_target,
        platform="android",
        **common,
    )
    ios = build_push_message(
        _MessagingStub,
        token=ios_delivery_target,
        platform="ios",
        **common,
    )
    web = build_push_message(
        _MessagingStub,
        token=web_delivery_target,
        platform="web",
        **common,
    )

    assert android.android.priority == "high"
    assert android.android.notification.channel_id == "one_location_sms_emergency_v1"
    assert android.android.notification.priority == "max"
    assert android.android.notification.vibrate_timings_millis == [
        0,
        240,
        120,
        240,
        120,
        520,
    ]
    assert ios.apns.payload.aps.category == "ONE_LOCATION_SMS_EMERGENCY"
    assert ios.apns.payload.aps.sound == "one_location_sms_alarm.wav"
    assert web.webpush.notification.renotify is True
    assert web.webpush.notification.silent is False
    assert web.webpush.notification.vibrate == [240, 120, 240, 120, 520]


def test_build_push_message_without_alert_is_data_only():
    delivery_target = "web-device-id"
    message = build_push_message(
        _MessagingStub,
        token=delivery_target,
        platform="ios",
        data={"type": "consent_resolved"},
        title="Consent updated",
        body="Request resolved.",
        request_url="https://uat.one.hushh.ai/consents?tab=pending",
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
