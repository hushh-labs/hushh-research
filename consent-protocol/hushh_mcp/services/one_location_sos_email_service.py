"""Email fallback for a Save my Soul alert.

Why this exists
---------------
An SOS alert reaches its recipients through exactly one channel: a push
notification. If the recipient has notifications off, has uninstalled, or is
simply not looking at their phone, the alert lands nowhere and the sender is
told so after the fact. Email is the second channel — it survives a closed app
and an unread notification tray.

The coordinates problem
-----------------------
``one_location_envelopes`` carries this invariant, stated in migration 061:

    "Latest live-location ciphertext envelopes.
     Coordinates must be present only inside ciphertext."

The server therefore cannot read where the sender is; only the recipient's
device can decrypt that. An email that names a location has to receive those
coordinates from the sender's client, in the request, for the length of one
send.

That is a deliberate, product-owner decision to weaken the envelope model for
the emergency case: in an emergency, a contact who cannot open the app still
needs to know where to go. The rules that keep it bounded:

1. Coordinates arrive as request input and are **never persisted**. Nothing in
   this module writes them to a table, and the caller does not either.
2. Coordinates are **never logged**. Every log line here carries ids and
   outcomes only. `_log_safe` is the single formatting path, so a future edit
   cannot casually interpolate a latitude.
3. The sender may only mail a recipient they already hold a **live SOS grant**
   for, created by their own account. The grant is the authorization: without
   it this endpoint would email arbitrary text and a location to any user id.
4. Delivery follows the support-email delivery mode, so a non-production
   environment routes every message to the test inbox instead of a real
   contact's real inbox.
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from email.message import EmailMessage
from html import escape
from typing import Any, Iterable, Sequence

from hushh_mcp.services.support_email_service import (
    SupportEmailConfig,
    SupportEmailNotConfiguredError,
)

logger = logging.getLogger(__name__)

_GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"

#: A grant older than this is not the alert that is being sent right now.
#: Without it, a stale 8-hour SOS grant would keep this endpoint usable as a
#: mailer for the rest of the day.
_GRANT_FRESHNESS_SECONDS = 15 * 60

#: Bound on how many contacts one alert may mail. An SOS list is a handful of
#: people; anything larger is a bug or an abuse attempt, not an emergency.
MAX_SOS_EMAIL_RECIPIENTS = 20


@dataclass(frozen=True)
class SosEmailOutcome:
    """Per-recipient result. ``emailed`` is never ``True`` on a silent failure."""

    recipient_user_id: str
    emailed: bool
    #: Machine-readable reason when ``emailed`` is False. Never a coordinate.
    reason: str | None = None

    def as_payload(self) -> dict[str, Any]:
        return {
            "recipientUserId": self.recipient_user_id,
            "emailed": self.emailed,
            **({"reason": self.reason} if self.reason else {}),
        }


def _log_safe(value: object) -> str:
    """The only way a value reaches a log line from this module.

    Coordinates must never be logged, so nothing here formats a float. Anything
    that is not a short identifier-ish string becomes a type name.
    """
    if isinstance(value, str) and len(value) <= 80:
        return value
    return f"<{type(value).__name__}>"


def _maps_link(latitude: float, longitude: float) -> str:
    return f"https://www.google.com/maps/search/?api=1&query={latitude:.6f},{longitude:.6f}"


def _accuracy_phrase(accuracy_m: float | None) -> str:
    if accuracy_m is None or accuracy_m <= 0:
        return ""
    return f" (accurate to about {round(accuracy_m)} m)"


class OneLocationSosEmailService:
    """Sends the Save my Soul email through the Workspace Gmail identity.

    Reuses ``SupportEmailConfig`` rather than introducing a second credential:
    the delegated service account is already bound in every environment, so
    this channel ships without a new secret, a new IAM grant, or a new deploy
    variable to keep in parity across lanes.
    """

    def __init__(self) -> None:
        self._config: SupportEmailConfig | None = None

    @property
    def config(self) -> SupportEmailConfig:
        if self._config is None:
            self._config = SupportEmailConfig.from_env()
        return self._config

    @property
    def configured(self) -> bool:
        return bool(self.config.configured)

    def _resolve_destination(self, recipient_email: str) -> str:
        """Where the message actually goes.

        In a non-production environment this is the support test inbox, not the
        contact's real address: verifying an emergency mail must never mean
        mailing a real person's real inbox from UAT.
        """
        cfg = self.config
        if cfg.delivery_mode == "test" and cfg.test_to_email:
            return cfg.test_to_email
        return recipient_email

    def _build_message(
        self,
        *,
        recipient_email: str,
        recipient_display_name: str | None,
        owner_display_name: str,
        note: str | None,
        latitude: float,
        longitude: float,
        accuracy_m: float | None,
        sent_at_label: str,
        expires_at_label: str | None,
        open_in_one_url: str,
        emergency_number: str | None,
    ) -> EmailMessage:
        cfg = self.config
        destination = self._resolve_destination(recipient_email)
        greeting_name = (recipient_display_name or "").strip().split(" ")[0]
        greeting = f"{greeting_name}, " if greeting_name else ""

        subject = f"{owner_display_name} needs help — Save my Soul"
        if cfg.delivery_mode == "test":
            subject = f"[TEST → {recipient_email}] {subject}"

        maps_url = _maps_link(latitude, longitude)
        coords = f"{latitude:.6f}, {longitude:.6f}"
        accuracy = _accuracy_phrase(accuracy_m)
        quoted_note = f'\n\n  "{note.strip()}"\n' if note and note.strip() else "\n"
        expiry_line = (
            f"Their live location stays shared until {expires_at_label}."
            if expires_at_label
            else "Their live location is shared with you now."
        )
        emergency_line = (
            f"If this is an emergency where you are, call {emergency_number}."
            if emergency_number
            else "If this is an emergency, call your local emergency number."
        )

        text = (
            f"{greeting}{owner_display_name} triggered a Save my Soul alert at "
            f"{sent_at_label}."
            f"{quoted_note}\n"
            f"Location: {coords}{accuracy}\n"
            f"Map: {maps_url}\n\n"
            f"{expiry_line}\n"
            f"Open in One for their live position: {open_in_one_url}\n\n"
            f"{emergency_line}\n"
        )

        note_html = (
            f'<p style="margin:0 0 20px;padding:12px 16px;border-left:3px solid #ff3b30;'
            f'background:#faf7f7;font-size:16px;line-height:1.5;color:#1d1d1f;">'
            f"“{escape(note.strip())}”</p>"
            if note and note.strip()
            else ""
        )
        html = (
            "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
            "Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;"
            'color:#1d1d1f;">'
            f'<p style="margin:0 0 4px;font-size:13px;font-weight:600;letter-spacing:.08em;'
            f'text-transform:uppercase;color:#ff3b30;">Save my Soul</p>'
            f'<h1 style="margin:0 0 16px;font-size:24px;line-height:1.2;">'
            f"{escape(owner_display_name)} needs help</h1>"
            f'<p style="margin:0 0 20px;font-size:16px;line-height:1.5;">'
            f"{escape(greeting.strip())} They triggered an alert at "
            f"{escape(sent_at_label)} and shared their live location with you.</p>"
            f"{note_html}"
            f'<p style="margin:0 0 8px;font-size:16px;line-height:1.5;">'
            f"<strong>Location:</strong> {escape(coords)}{escape(accuracy)}</p>"
            f'<p style="margin:0 0 24px;">'
            f'<a href="{escape(maps_url)}" style="display:inline-block;padding:12px 20px;'
            f"border-radius:9999px;background:#ff3b30;color:#ffffff;text-decoration:none;"
            f'font-weight:600;font-size:16px;">Open in Google Maps</a></p>'
            f'<p style="margin:0 0 8px;font-size:15px;line-height:1.5;color:#3c3c43;">'
            f"{escape(expiry_line)}</p>"
            f'<p style="margin:0 0 24px;font-size:15px;">'
            f'<a href="{escape(open_in_one_url)}" style="color:#007aff;">'
            f"See their live position in One</a></p>"
            f'<p style="margin:0;font-size:15px;line-height:1.5;color:#3c3c43;">'
            f"{escape(emergency_line)}</p>"
            "</div>"
        )

        message = EmailMessage()
        message["To"] = destination
        message["From"] = f"Hussh One <{cfg.from_email}>"
        message["Subject"] = subject
        message["X-Hushh-Alert"] = "save-my-soul"
        # An emergency mail belongs at the top of the inbox, not batched.
        message["X-Priority"] = "1"
        message["Importance"] = "high"
        message.set_content(text)
        message.add_alternative(html, subtype="html")
        return message

    def send_one(
        self,
        *,
        session: Any,
        recipient_user_id: str,
        recipient_email: str,
        recipient_display_name: str | None,
        owner_display_name: str,
        note: str | None,
        latitude: float,
        longitude: float,
        accuracy_m: float | None,
        sent_at_label: str,
        expires_at_label: str | None,
        open_in_one_url: str,
        emergency_number: str | None,
    ) -> SosEmailOutcome:
        """Send to one recipient. Never raises — an email that fails to send
        must not take down the alert that already reached someone else."""
        try:
            message = self._build_message(
                recipient_email=recipient_email,
                recipient_display_name=recipient_display_name,
                owner_display_name=owner_display_name,
                note=note,
                latitude=latitude,
                longitude=longitude,
                accuracy_m=accuracy_m,
                sent_at_label=sent_at_label,
                expires_at_label=expires_at_label,
                open_in_one_url=open_in_one_url,
                emergency_number=emergency_number,
            )
            encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
            response = session.post(_GMAIL_SEND_ENDPOINT, json={"raw": encoded}, timeout=20)
        except Exception as exc:  # noqa: BLE001 - reported, never raised onward
            logger.warning(
                "one.location.sos_email.transport_failed recipient=%s error=%s",
                _log_safe(recipient_user_id),
                _log_safe(type(exc).__name__),
            )
            return SosEmailOutcome(recipient_user_id, False, "transport_failed")

        if getattr(response, "status_code", 500) >= 400:
            logger.warning(
                "one.location.sos_email.send_failed recipient=%s status=%s",
                _log_safe(recipient_user_id),
                getattr(response, "status_code", "unknown"),
            )
            return SosEmailOutcome(recipient_user_id, False, "send_failed")

        logger.info(
            "one.location.sos_email.sent recipient=%s mode=%s",
            _log_safe(recipient_user_id),
            self.config.delivery_mode,
        )
        return SosEmailOutcome(recipient_user_id, True)


_service: OneLocationSosEmailService | None = None


def get_sos_email_service() -> OneLocationSosEmailService:
    global _service
    if _service is None:
        _service = OneLocationSosEmailService()
    return _service


def select_emailable_recipients(
    grants: Iterable[dict[str, Any]],
    *,
    owner_user_id: str,
    now_epoch_seconds: float,
) -> list[dict[str, Any]]:
    """Filter grant rows down to the ones this alert may mail.

    A row survives only when it is the caller's own, is an SOS share, is still
    active, was created moments ago, and names a recipient with an address.
    Every rejection is silent by design — the caller reports a count, not which
    of someone's emergency contacts happens to lack an email on file.
    """
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in grants:
        if str(row.get("owner_user_id") or "") != owner_user_id:
            continue
        if str(row.get("share_kind") or "") != "sos":
            continue
        if str(row.get("status") or "") != "active":
            continue
        created_at_epoch = row.get("created_at_epoch")
        if not isinstance(created_at_epoch, (int, float)):
            continue
        if now_epoch_seconds - float(created_at_epoch) > _GRANT_FRESHNESS_SECONDS:
            continue
        recipient_user_id = str(row.get("recipient_user_id") or "").strip()
        email = str(row.get("recipient_email") or "").strip()
        if not recipient_user_id or "@" not in email:
            continue
        if recipient_user_id in seen:
            continue
        seen.add(recipient_user_id)
        selected.append(row)
        if len(selected) >= MAX_SOS_EMAIL_RECIPIENTS:
            break
    return selected


def summarize(outcomes: Sequence[SosEmailOutcome]) -> dict[str, Any]:
    return {
        "emailed": sum(1 for outcome in outcomes if outcome.emailed),
        "attempted": len(outcomes),
        "results": [outcome.as_payload() for outcome in outcomes],
    }


__all__ = [
    "MAX_SOS_EMAIL_RECIPIENTS",
    "OneLocationSosEmailService",
    "SosEmailOutcome",
    "SupportEmailNotConfiguredError",
    "get_sos_email_service",
    "select_emailable_recipients",
    "summarize",
]
