import pytest

from api.utils.fcm_messages import build_push_message


@pytest.mark.parametrize("version", [0, 1])
def test_sms_renderer_is_negotiated_by_compiled_installation_capability(version):
    from firebase_admin import messaging
    from firebase_admin.messaging import _MessagingService

    delivery_target = "sms-device"
    message = build_push_message(
        messaging,
        token=delivery_target,
        platform="android",
        sms_alarm_version=version,
        data={
            "type": "location_share_created",
            "share_kind": "sos",
            "user_id": "recipient",
            "grant_id": "grant",
        },
        title="SMS",
        body="Emergency alert",
        request_url="/one/location",
        notification_tag="sms:grant",
        show_alert=True,
    )
    wire = _MessagingService.encode_message(message)
    if version:
        assert message.notification is None
        assert "notification" not in wire["android"]
        assert wire["data"]["sms_alarm_version"] == "1"
        assert wire["data"]["notification_title"] == "SMS"
        assert wire["android"]["priority"] == "high"
    else:
        assert message.notification is not None
        assert wire["android"]["notification"]["channel_id"] == "one_location_sms_emergency_v1"
        assert "sms_alarm_version" not in wire["data"]


@pytest.mark.parametrize("platform", ["web", "android", "ios"])
def test_one_location_sos_revoke_is_silent_on_every_platform(platform: str) -> None:
    from firebase_admin import messaging
    from firebase_admin.messaging import _MessagingService

    delivery_target = "recipient-device-id"
    message = build_push_message(
        messaging,
        token=delivery_target,
        platform=platform,
        data={
            "type": "location_share_revoked",
            "share_kind": "sos",
            "grant_id": "sos-grant",
            "notification_profile": "one_location_sms_emergency",
            "title": "SMS location sharing stopped",
            "body": "Alex stopped sharing location with you over SMS.",
        },
        title="SMS location sharing stopped",
        body="Alex stopped sharing location with you over SMS.",
        request_url="/one/location",
        notification_tag="one-location-revoked:sos-grant",
        show_alert=True,
    )
    encoded = _MessagingService.encode_message(message)

    assert message.notification is None
    assert "notification" not in encoded
    assert encoded["data"]["notification_presentation"] == "silent"
    assert encoded["data"]["grant_id"] == "sos-grant"
    assert "title" not in encoded["data"]
    assert "body" not in encoded["data"]
    assert "webpush" not in encoded
    assert "android" not in encoded
    if platform == "ios":
        aps = encoded["apns"]["payload"]["aps"]
        assert aps["content-available"] == 1
        assert "alert" not in aps
        assert "sound" not in aps


@pytest.mark.parametrize("deadline,ttl", [("2030-01-01T00:01:00Z", 60), ("", 0)])
def test_sms_transport_lifetime_and_legacy_android_sound(monkeypatch, deadline, ttl):
    from firebase_admin import messaging
    from firebase_admin.messaging import _MessagingService

    now = 1893456000
    monkeypatch.setattr("api.utils.fcm_messages.time.time", lambda: now)
    for platform in ("web", "android", "ios"):
        message = build_push_message(
            messaging,
            token=f"{platform}-device-id",
            platform=platform,
            data={"type": "location_share_created", "share_kind": "sos", "expires_at": deadline},
            title="UAT TEST",
            body="No emergency",
            request_url="/one/feed",
            notification_tag="sms-test",
            show_alert=True,
        )
        wire = _MessagingService.encode_message(message)
        if platform == "android":
            assert wire["android"]["ttl"] == f"{ttl}s"
            assert wire["android"]["notification"]["sound"] == "default"
            assert wire["android"]["notification"]["channel_id"] == "one_location_sms_emergency_v1"
        elif platform == "web":
            assert wire["webpush"]["headers"]["TTL"] == str(ttl)
        else:
            assert wire["apns"]["headers"]["apns-expiration"] == str(now + ttl if ttl else 0)
            assert wire["apns"]["payload"]["aps"]["sound"] == "one_location_sms_alarm.wav"
            # iOS 26+ schedules the persistent system alarm in the existing
            # notification extension; older apps retain their normal APNs alert.
            assert wire["apns"]["payload"]["aps"]["mutable-content"] == 1


@pytest.mark.parametrize("deadline", ["2000-01-01T00:00:00Z", "invalid"])
def test_expired_sms_is_silent_on_every_transport(deadline):
    from firebase_admin import messaging
    from firebase_admin.messaging import _MessagingService

    for platform in ("web", "android", "ios"):
        wire = _MessagingService.encode_message(
            build_push_message(
                messaging,
                token=f"{platform}-device-id",
                platform=platform,
                data={
                    "type": "location_share_created",
                    "share_kind": "sos",
                    "expires_at": deadline,
                },
                title="UAT TEST",
                body="No emergency",
                request_url="/one/feed",
                notification_tag="sms-test",
                show_alert=True,
            )
        )
        assert wire["data"]["notification_presentation"] == "silent"
        assert "notification" not in wire
        if platform == "ios":
            assert "sound" not in wire["apns"]["payload"]["aps"]
            assert "alert" not in wire["apns"]["payload"]["aps"]
            assert int(wire["apns"]["headers"]["apns-expiration"]) <= 946684800
        elif platform == "android":
            assert wire["android"]["ttl"] == "0s"
            assert "notification" not in wire["android"]
        else:
            assert wire["webpush"]["headers"]["TTL"] == "0"
            assert "notification" not in wire["webpush"]
