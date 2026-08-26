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
        def __init__(self, aps=None, custom_data=None, **kwargs):
            self.aps = aps
            self.custom_data = {**(custom_data or {}), **kwargs}

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


def test_connection_request_identity_reaches_every_platform() -> None:
    """The requester's name and the review-sheet link must survive on all three.

    Regression guard for issue #5422. The resolved name used to reach only the
    banner body, never the FCM ``data`` map -- and the in-app toast reads the data
    map exclusively, so it rendered "Someone" while the OS banner named the
    requester correctly. Both halves are asserted per platform, because each one
    carries the banner differently: web via WebpushNotification, Android via the
    top-level Notification (no AndroidConfig is built for this type), iOS via
    aps.alert plus custom_data.
    """
    from hushh_mcp.services.push_notifications import (
        _connection_request_body,
        _connection_request_link,
    )

    request_id = "8f14e45f-ceea-467a-9c1d-5b8f0f9a1234"
    body = _connection_request_body("Rohan Mehta")
    deep_link = _connection_request_link(request_id)
    data = {
        "type": "connection_request",
        "requester_user_id": "requester-uid",
        "requester_label": "Rohan Mehta",
        "request_id": request_id,
        "request_url": deep_link,
        "deep_link": deep_link,
        "notification_tag": f"connection-request:{request_id}",
    }

    messages = {
        platform: build_push_message(
            _MessagingStub,
            token=f"{platform}-device-id",
            platform=platform,
            data=dict(data),
            title="New connection request",
            body=body,
            request_url=deep_link,
            notification_tag=f"connection-request:{request_id}",
            show_alert=True,
        )
        for platform in ("web", "ios", "android")
    }

    assert body == "Rohan Mehta wants to connect with you on Hussh."
    assert deep_link == f"/one/consent?tab=pending&requestId={request_id}"

    for platform, message in messages.items():
        # The field the in-app toast reads, on every platform.
        assert message.data["requester_label"] == "Rohan Mehta", platform
        assert message.data["request_id"] == request_id, platform
        # The banner a person sees on the lock screen.
        assert message.notification.body == body, platform
        assert "hushh" not in message.notification.body.lower(), platform
        assert "Someone" not in message.notification.body, platform

    assert messages["web"].webpush.notification.body == body
    assert messages["android"].android.notification.tag == (f"connection-request:{request_id}")
    assert messages["web"].webpush.notification.data == {"url": deep_link}
    assert messages["ios"].apns.payload.aps.alert.body == body
    # iOS receives the data map as APNS custom_data, which is what feeds the
    # Capacitor notificationReceived listener.
    assert messages["ios"].apns.payload.custom_data["requester_label"] == "Rohan Mehta"


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
        "title": "Save my Soul",
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


def test_relative_web_link_resolves_against_https_frontend_origin(monkeypatch):
    """A relative deep link must become an absolute HTTPS fcm_options link.

    FCM rejects a non-HTTPS WebpushFCMOptions.link and fails the whole send,
    so every caller that passes an app-relative path (circle invites,
    connection requests) lost its notification entirely.
    """

    import hushh_mcp.services.consent_request_links as links

    delivery_target = "web-device-id"
    monkeypatch.setattr(links, "frontend_origin", lambda: "https://uat.one.hushh.ai")
    message = build_push_message(
        _MessagingStub,
        token=delivery_target,
        platform="web",
        data={"type": "location_circle_member_invite"},
        title="Circle invitation",
        body="You have a new Circle invitation.",
        request_url="/one/location?tab=people&circleInviteId=invite-1",
        notification_tag="location-circle-member-invite:invite-1",
        show_alert=True,
    )

    assert message.webpush.fcm_options.link == (
        "https://uat.one.hushh.ai/one/location?tab=people&circleInviteId=invite-1"
    )
    # The service worker's click target is carried independently of fcm_options.
    assert message.webpush.notification.data == {
        "url": "/one/location?tab=people&circleInviteId=invite-1"
    }


def test_relative_web_link_drops_fcm_options_when_origin_is_not_https(monkeypatch):
    """Local http dev must still deliver the push, just without a click link."""

    import hushh_mcp.services.consent_request_links as links

    delivery_target = "web-device-id"
    monkeypatch.setattr(links, "frontend_origin", lambda: "http://localhost:3000")
    message = build_push_message(
        _MessagingStub,
        token=delivery_target,
        platform="web",
        data={"type": "location_circle_member_invite"},
        title="Circle invitation",
        body="You have a new Circle invitation.",
        request_url="/one/location?tab=people&circleInviteId=invite-1",
        notification_tag="location-circle-member-invite:invite-1",
        show_alert=True,
    )

    assert message.webpush is not None
    assert message.webpush.fcm_options is None
    assert message.webpush.notification.body == "You have a new Circle invitation."


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
    assert message.data == {
        "type": "consent_resolved",
        "notification_presentation": "silent",
    }
    assert message.apns.headers == {
        "apns-push-type": "background",
        "apns-priority": "5",
    }
    assert message.apns.payload.aps.content_available is True
    assert message.apns.payload.aps.thread_id == "consent-request:test"


def test_real_firebase_encoder_keeps_presentation_and_apns_data_top_level():
    """Guard the wire shape, not only the intentionally tiny local stub."""
    from firebase_admin import messaging
    from firebase_admin.messaging import _MessagingService

    for platform in ("web", "ios", "android"):
        message = build_push_message(
            messaging,
            token=f"{platform}-device-id",
            platform=platform,
            data={
                "type": "consent_resolved",
                "request_id": "request-1",
            },
            title="Consent updated",
            body="Request resolved.",
            request_url="/one/consent",
            notification_tag="consent-request:request-1",
            show_alert=False,
        )
        encoded = _MessagingService.encode_message(message)
        assert encoded["data"]["notification_presentation"] == "silent"
        assert "notification" not in encoded
        if platform == "ios":
            payload = encoded["apns"]["payload"]
            assert payload["aps"]["content-available"] == 1
            assert payload["type"] == "consent_resolved"
            assert "custom_data" not in payload
        else:
            assert platform not in encoded
