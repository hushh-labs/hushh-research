"""Email agent service for askkai@hushh.ai — KYC agent over email.

Parses inbound email webhooks (SendGrid Inbound Parse format), extracts user
intent from the email body, routes to Kai for response generation, and sends
the reply back via the existing Gmail delivery infrastructure.

Consent boundary: the sender email address is treated as the identity anchor.
No vault keys are exposed; the agent operates in a public-access / KYC-only
scope until the user completes full onboarding through the app.
"""

from __future__ import annotations

import base64
import html as html_mod
import logging
import re
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any

from hushh_mcp.services.support_email_service import (
    SupportEmailConfig,
    SupportEmailNotConfiguredError,
    SupportEmailSendError,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Inbound email parsing
# ---------------------------------------------------------------------------

# SendGrid Inbound Parse webhook fields:
#   from, to, subject, text, html, envelope, headers, sender_ip, ...
# We also support a generic JSON shape for testing / alternative providers.

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def _extract_email_address(raw: str | None) -> str | None:
    """Pull the first email address out of a 'Name <addr>' or bare string."""
    if not raw:
        return None
    match = _EMAIL_RE.search(raw)
    return match.group(0).lower() if match else None


def _extract_display_name(raw: str | None) -> str | None:
    """Best-effort display name from 'Display Name <addr@example.com>'."""
    if not raw:
        return None
    raw = raw.strip()
    if "<" in raw:
        name = raw[: raw.index("<")].strip().strip('"').strip("'")
        return name or None
    return None


def _strip_quoted_reply(text: str) -> str:
    """Remove quoted reply lines (lines starting with '>') and signature blocks."""
    lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        # Stop at common signature / reply markers
        if stripped.startswith(">"):
            continue
        if stripped.startswith("On ") and stripped.endswith("wrote:"):
            break
        if stripped == "--":
            break
        if stripped.startswith("---------- Forwarded message"):
            break
        lines.append(line)
    return "\n".join(lines).strip()


@dataclass(frozen=True)
class ParsedInboundEmail:
    """Structured representation of an inbound email."""

    sender_email: str
    sender_name: str | None
    recipient_email: str | None
    subject: str
    body_text: str
    raw_body: str

    @property
    def user_message(self) -> str:
        """The cleaned user message to send to the agent."""
        cleaned = _strip_quoted_reply(self.body_text)
        return cleaned or self.body_text


def parse_sendgrid_inbound(payload: dict[str, Any]) -> ParsedInboundEmail:
    """Parse a SendGrid Inbound Parse webhook payload.

    Also works as a generic parser when callers provide ``from``, ``subject``,
    and ``text`` fields.
    """
    sender_raw = str(payload.get("from", ""))
    sender_email = _extract_email_address(sender_raw)
    if not sender_email:
        raise ValueError("Inbound email is missing a valid sender address.")

    recipient_raw = str(payload.get("to", ""))
    recipient_email = _extract_email_address(recipient_raw)

    subject = str(payload.get("subject", "")).strip() or "(no subject)"

    # Prefer plain-text body; fall back to HTML-stripped version.
    body_text = str(payload.get("text", "")).strip()
    if not body_text:
        html_body = str(payload.get("html", "")).strip()
        # Rough HTML-to-text: strip tags, decode entities.
        body_text = re.sub(r"<[^>]+>", " ", html_body)
        body_text = html_mod.unescape(body_text).strip()

    if not body_text:
        raise ValueError("Inbound email has no readable body content.")

    return ParsedInboundEmail(
        sender_email=sender_email,
        sender_name=_extract_display_name(sender_raw),
        recipient_email=recipient_email,
        subject=subject,
        body_text=body_text,
        raw_body=str(payload.get("text", payload.get("html", ""))),
    )


# ---------------------------------------------------------------------------
# Agent interaction
# ---------------------------------------------------------------------------


def _build_agent_prompt(email: ParsedInboundEmail) -> str:
    """Convert the parsed email into a prompt for the Kai agent.

    Provides the subject as context and wraps the body so the agent knows this
    came through the email channel (helpful for tone and response formatting).
    """
    parts = [
        f"[Email from {email.sender_email}]",
        f"Subject: {email.subject}",
        "",
        email.user_message,
    ]
    return "\n".join(parts)


def generate_agent_response(email: ParsedInboundEmail) -> str:
    """Route the email body through the Kai agent and return the text reply.

    Uses the Kai singleton in a consent-light mode (no vault keys, public scope)
    since the email sender has not yet gone through full in-app consent.
    """
    from hushh_mcp.agents.kai.agent import get_kai_agent

    prompt = _build_agent_prompt(email)
    # Use sender email as user_id for tracking; no consent token required
    # for this public KYC channel.
    try:
        result = get_kai_agent().handle_message(
            message=prompt,
            user_id=email.sender_email,
            consent_token="",  # public KYC scope — no privileged access
        )
        return str(result.get("response", "")).strip() or _fallback_response()
    except Exception:
        logger.exception(
            "email_agent.kai_agent_failed sender=%s subject=%s",
            email.sender_email,
            email.subject,
        )
        return _fallback_response()


def _fallback_response() -> str:
    return (
        "Thank you for reaching out to Kai. I was not able to process your "
        "request right now. Please try again shortly or visit https://www.hushh.ai "
        "to continue through the app."
    )


# ---------------------------------------------------------------------------
# Outbound reply (via existing Gmail infrastructure)
# ---------------------------------------------------------------------------


_ASKKAI_FROM_DISPLAY = "Kai by Hushh"


def _build_reply_email(
    *,
    to_email: str,
    subject: str,
    body_text: str,
    from_email: str,
) -> EmailMessage:
    msg = EmailMessage()
    msg["To"] = to_email
    msg["From"] = f"{_ASKKAI_FROM_DISPLAY} <{from_email}>"
    # Prefix Re: only if not already present
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    msg["Subject"] = subject
    msg.set_content(body_text)
    return msg


def send_reply(
    *,
    to_email: str,
    subject: str,
    body_text: str,
) -> dict[str, Any]:
    """Send the agent reply back to the original sender via Gmail API.

    Reuses the SupportEmailConfig / Gmail delegation path that the rest of
    the platform already uses for outbound mail.
    """
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account

    _GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
    _GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"

    cfg = SupportEmailConfig.from_env()
    if not cfg.configured:
        raise SupportEmailNotConfiguredError(
            "Email agent reply delivery is not configured. "
            "Provide SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON or equivalent credentials."
        )

    from_email = cfg.from_email
    email_message = _build_reply_email(
        to_email=to_email,
        subject=subject,
        body_text=body_text,
        from_email=from_email,
    )
    encoded = base64.urlsafe_b64encode(email_message.as_bytes()).decode("utf-8")

    credentials = service_account.Credentials.from_service_account_info(
        cfg.service_account_info,
        scopes=[_GMAIL_SEND_SCOPE],
        subject=cfg.delegated_user,
    )
    session = AuthorizedSession(credentials)

    try:
        response = session.post(_GMAIL_SEND_ENDPOINT, json={"raw": encoded}, timeout=20)
    except Exception as exc:
        logger.exception("email_agent.reply_transport_failed to=%s", to_email)
        raise SupportEmailSendError(
            "Email agent reply delivery failed. Check Gmail delegation."
        ) from exc

    try:
        payload = response.json()
    except Exception:
        payload = {}

    if response.status_code >= 400:
        logger.error(
            "email_agent.reply_send_failed status=%s to=%s payload=%s",
            response.status_code,
            to_email,
            payload,
        )
        detail = (
            payload.get("error", {}).get("message")
            if isinstance(payload, dict)
            and isinstance(payload.get("error"), dict)
            and isinstance(payload.get("error", {}).get("message"), str)
            else None
        )
        raise SupportEmailSendError(
            detail or f"Email agent reply failed with status {response.status_code}"
        )

    message_id = payload.get("id") if isinstance(payload, dict) else None
    return {
        "accepted": True,
        "message_id": message_id if isinstance(message_id, str) else None,
        "to": to_email,
        "from_email": from_email,
    }
