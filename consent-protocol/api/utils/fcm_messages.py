from __future__ import annotations

from typing import Any

CONSENT_NOTIFICATION_CATEGORY = "CONSENT_REQUEST"
CONSENT_NOTIFICATION_ACTION_REVIEW = "CONSENT_REVIEW"
CONSENT_NOTIFICATION_ACTION_APPROVE = "CONSENT_APPROVE"
CONSENT_NOTIFICATION_ACTION_DENY = "CONSENT_DENY"
ONE_LOCATION_SMS_EMERGENCY_PROFILE = "one_location_sms_emergency"
ONE_LOCATION_SMS_EMERGENCY_CATEGORY = "ONE_LOCATION_SMS_EMERGENCY"
ONE_LOCATION_SMS_EMERGENCY_ANDROID_CHANNEL = "one_location_sms_emergency_v1"
ONE_LOCATION_SMS_EMERGENCY_IOS_SOUND = "one_location_sms_alarm.wav"


def _is_one_location_sms_emergency(data: dict[str, str]) -> bool:
    profile = str(data.get("notification_profile") or "").strip().lower()
    if profile == ONE_LOCATION_SMS_EMERGENCY_PROFILE:
        return True
    return (
        str(data.get("type") or "").strip().lower() == "location_share_created"
        and str(data.get("share_kind") or "").strip().lower() == "sos"
    )


def build_push_message(
    messaging: Any,
    *,
    token: str,
    platform: str,
    data: dict[str, str],
    title: str,
    body: str,
    request_url: str,
    notification_tag: str,
    show_alert: bool,
):
    normalized_platform = str(platform or "").strip().lower()
    normalized_type = str(data.get("type") or "").strip().lower()
    is_sms_emergency = _is_one_location_sms_emergency(data)
    notification = messaging.Notification(title=title, body=body) if show_alert else None

    webpush = None
    if show_alert and normalized_platform == "web":
        webpush = messaging.WebpushConfig(
            headers={"Urgency": "high"},
            notification=messaging.WebpushNotification(
                title=title,
                body=body,
                tag=notification_tag,
                require_interaction=True,
                data={"url": request_url},
                renotify=is_sms_emergency,
                silent=False,
                vibrate=[240, 120, 240, 120, 520] if is_sms_emergency else None,
            ),
            fcm_options=messaging.WebpushFCMOptions(link=request_url),
        )

    android = None
    if normalized_platform == "android" and show_alert and is_sms_emergency:
        android = messaging.AndroidConfig(
            priority="high",
            notification=messaging.AndroidNotification(
                title=title,
                body=body,
                channel_id=ONE_LOCATION_SMS_EMERGENCY_ANDROID_CHANNEL,
                tag=notification_tag,
                ticker="Emergency SMS alert",
                priority="max",
                visibility="public",
                vibrate_timings_millis=[0, 240, 120, 240, 120, 520],
            ),
        )

    apns = None
    if normalized_platform == "ios" and show_alert:
        apns = messaging.APNSConfig(
            headers={
                "apns-push-type": "alert",
                "apns-priority": "10",
            },
            payload=messaging.APNSPayload(
                aps=messaging.Aps(
                    alert=messaging.ApsAlert(title=title, body=body),
                    sound=(ONE_LOCATION_SMS_EMERGENCY_IOS_SOUND if is_sms_emergency else "default"),
                    badge=1,
                    category=(
                        ONE_LOCATION_SMS_EMERGENCY_CATEGORY
                        if is_sms_emergency
                        else (
                            CONSENT_NOTIFICATION_CATEGORY
                            if normalized_type == "consent_request"
                            else None
                        )
                    ),
                    thread_id=notification_tag,
                ),
                custom_data=data,
            ),
        )
    elif normalized_platform == "ios":
        apns = messaging.APNSConfig(
            headers={
                "apns-push-type": "background",
                "apns-priority": "5",
            },
            payload=messaging.APNSPayload(
                aps=messaging.Aps(
                    content_available=True,
                    thread_id=notification_tag,
                ),
                custom_data=data,
            ),
        )

    return messaging.Message(
        token=token,
        data=data,
        notification=notification,
        webpush=webpush,
        apns=apns,
        android=android,
    )
