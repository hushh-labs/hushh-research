"""Gmail-backed support messaging for profile bug reports and help requests."""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Literal, Optional

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

from hushh_mcp.runtime_settings import get_firebase_credential_settings

logger = logging.getLogger(__name__)

SupportMessageKind = Literal["bug_report", "support_request", "developer_reachout"]
SupportDeliveryMode = Literal["live", "test"]

_GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
_GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
_DEFAULT_ONE_EMAIL_ADDRESS = "one@hushh.ai"


def _clean_text(value: str | None) -> str:
    return (value or "").strip()


def _normalize_private_key(raw: str | None) -> str:
    value = _clean_text(raw)
    if not value:
        return ""
    if value.startswith('"') and value.endswith('"') and len(value) >= 2:
        value = value[1:-1]
    return value.replace("\\n", "\n")


def _load_service_account_json(raw: str | None) -> dict[str, str] | None:
    text = _clean_text(raw)
    if not text:
        return None
    try:
        data = json.loads(text)
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("type") != "service_account":
        return None
    private_key = _normalize_private_key(str(data.get("private_key") or ""))
    client_email = _clean_text(str(data.get("client_email") or ""))
    token_uri = (
        _clean_text(str(data.get("token_uri") or "")) or "https://oauth2.googleapis.com/token"
    )
    project_id = _clean_text(str(data.get("project_id") or "")) or None
    client_id = _clean_text(str(data.get("client_id") or "")) or None
    if not client_email or not private_key:
        return None
    result = {
        "type": "service_account",
        "client_email": client_email,
        "private_key": private_key,
        "token_uri": token_uri,
    }
    if project_id:
        result["project_id"] = project_id
    if client_id:
        result["client_id"] = client_id
    return result


def _derive_project_id(service_account_email: str) -> str | None:
    if "@" not in service_account_email:
        return None
    domain = service_account_email.split("@", 1)[1]
    suffix = ".iam.gserviceaccount.com"
    if not domain.endswith(suffix):
        return None
    return domain[: -len(suffix)] or None


def _env_truthy(name: str) -> bool:
    return _clean_text(os.getenv(name)).lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class SupportEmailConfig:
    service_account_info: dict[str, str]
    service_account_email: str
    private_key: str
    project_id: str | None
    client_id: str | None
    delegated_user: str
    from_email: str
    support_to_email: str
    test_to_email: str | None
    delivery_mode: SupportDeliveryMode
    configured: bool

    @classmethod
    def from_env(cls) -> "SupportEmailConfig":
        firebase_credentials = get_firebase_credential_settings()
        service_account_info = _load_service_account_json(
            os.getenv("SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON")
        ) or _load_service_account_json(firebase_credentials.admin_credentials_json)
        service_account_email = (
            _clean_text(service_account_info.get("client_email"))
            if service_account_info
            else _clean_text(os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL"))
        )
        private_key = (
            _normalize_private_key(service_account_info.get("private_key"))
            if service_account_info
            else _normalize_private_key(os.getenv("GOOGLE_PRIVATE_KEY"))
        )
        one_email_address = (
            _clean_text(os.getenv("ONE_EMAIL_ADDRESS")) or _DEFAULT_ONE_EMAIL_ADDRESS
        )
        delegated_user = _clean_text(os.getenv("SUPPORT_EMAIL_DELEGATED_USER")) or one_email_address
        from_email = _clean_text(os.getenv("SUPPORT_EMAIL_FROM")) or delegated_user
        support_to_email = _clean_text(os.getenv("SUPPORT_EMAIL_TO")) or one_email_address
        test_to_email = _clean_text(os.getenv("SUPPORT_EMAIL_TEST_TO")) or None

        delivery_mode_raw = _clean_text(os.getenv("SUPPORT_EMAIL_MODE")).lower()
        if delivery_mode_raw in {"live", "test"}:
            delivery_mode: SupportDeliveryMode = delivery_mode_raw  # type: ignore[assignment]
        else:
            environment = _clean_text(os.getenv("ENVIRONMENT")).lower()
            delivery_mode = "test" if environment != "production" and test_to_email else "live"

        project_id = (
            _clean_text(service_account_info.get("project_id"))
            if service_account_info
            else _clean_text(os.getenv("GOOGLE_SERVICE_ACCOUNT_PROJECT_ID"))
        ) or _derive_project_id(service_account_email)
        client_id = (
            _clean_text(service_account_info.get("client_id")) if service_account_info else None
        ) or None

        if service_account_info is None and service_account_email and private_key:
            service_account_info = {
                "type": "service_account",
                "client_email": service_account_email,
                "private_key": private_key,
                "token_uri": "https://oauth2.googleapis.com/token",
            }
            if project_id:
                service_account_info["project_id"] = project_id
            if client_id:
                service_account_info["client_id"] = client_id

        configured = bool(
            service_account_email and private_key and delegated_user and support_to_email
        )
        return cls(
            service_account_info=service_account_info or {},
            service_account_email=service_account_email,
            private_key=private_key,
            project_id=project_id or None,
            client_id=client_id,
            delegated_user=delegated_user,
            from_email=from_email,
            support_to_email=support_to_email,
            test_to_email=test_to_email,
            delivery_mode=delivery_mode,
            configured=configured,
        )

    @property
    def effective_recipient(self) -> str:
        if self.delivery_mode == "test" and self.test_to_email:
            return self.test_to_email
        return self.support_to_email


class SupportEmailNotConfiguredError(RuntimeError):
    """Raised when support email env vars are missing."""


class SupportEmailSendError(RuntimeError):
    """Raised when Gmail delivery fails."""


class SupportEmailService:
    """Send profile-originated support messages through Gmail API."""

    def __init__(self) -> None:
        self._config: SupportEmailConfig | None = None
        self._session: AuthorizedSession | None = None

    @property
    def config(self) -> SupportEmailConfig:
        if self._config is None:
            self._config = SupportEmailConfig.from_env()
        return self._config

    def _build_authorized_session(self) -> AuthorizedSession:
        cfg = self.config
        if not cfg.configured:
            raise SupportEmailNotConfiguredError(
                "Support email is not configured. Provide SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON "
                "or FIREBASE_ADMIN_CREDENTIALS_JSON / FIREBASE_SERVICE_ACCOUNT_JSON, plus "
                "SUPPORT_EMAIL_* variables."
            )
        if self._session is None:
            credentials = service_account.Credentials.from_service_account_info(
                cfg.service_account_info,
                scopes=[_GMAIL_SEND_SCOPE],
                subject=cfg.delegated_user,
            )
            self._session = AuthorizedSession(credentials)
        return self._session

    def _kind_label(self, kind: SupportMessageKind) -> str:
        if kind == "bug_report":
            return "Bug report"
        if kind == "developer_reachout":
            return "Developer reachout"
        return "Support request"

    def _build_subject(
        self, *, kind: SupportMessageKind, subject: str, delivery_mode: SupportDeliveryMode
    ) -> str:
        prefix = self._kind_label(kind)
        if delivery_mode == "test":
            return f"[TEST] {prefix}: {subject}"
        return f"{prefix}: {subject}"

    def _build_email(
        self,
        *,
        kind: SupportMessageKind,
        subject: str,
        message: str,
        user_id: str,
        user_email: str | None,
        user_display_name: str | None,
        persona: str | None,
        page_url: str | None,
        user_agent: str | None,
    ) -> EmailMessage:
        cfg = self.config
        msg = EmailMessage()
        msg["To"] = cfg.effective_recipient
        msg["From"] = f"Hussh Support <{cfg.from_email}>"
        msg["Subject"] = self._build_subject(
            kind=kind,
            subject=subject,
            delivery_mode=cfg.delivery_mode,
        )
        if user_email:
            msg["Reply-To"] = user_email

        sections = [
            f"Kind: {self._kind_label(kind)}",
            f"Submitted by: {user_display_name or 'Unknown'}",
            f"User ID: {user_id}",
            f"User email: {user_email or 'Unknown'}",
            f"Persona: {persona or 'Unknown'}",
            f"Page: {page_url or 'Unknown'}",
            f"Delivery mode: {cfg.delivery_mode}",
            f"Live inbox: {cfg.support_to_email}",
            f"Actual recipient: {cfg.effective_recipient}",
            f"User agent: {user_agent or 'Unknown'}",
            "",
            "Message",
            "-------",
            message.strip(),
        ]
        msg.set_content("\n".join(sections))
        return msg

    def send_message(
        self,
        *,
        kind: SupportMessageKind,
        subject: str,
        message: str,
        user_id: str,
        user_email: str | None,
        user_display_name: str | None,
        persona: str | None,
        page_url: str | None,
        user_agent: str | None,
    ) -> dict[str, Optional[str] | bool]:
        email_message = self._build_email(
            kind=kind,
            subject=subject,
            message=message,
            user_id=user_id,
            user_email=user_email,
            user_display_name=user_display_name,
            persona=persona,
            page_url=page_url,
            user_agent=user_agent,
        )
        encoded = base64.urlsafe_b64encode(email_message.as_bytes()).decode("utf-8")
        try:
            session = self._build_authorized_session()
            response = session.post(_GMAIL_SEND_ENDPOINT, json={"raw": encoded}, timeout=20)
        except SupportEmailNotConfiguredError:
            raise
        except Exception as exc:
            logger.exception(
                "support_email.transport_failed delegated_user=%s recipient=%s",
                self.config.delegated_user,
                self.config.effective_recipient,
            )
            raise SupportEmailSendError(
                "Gmail API authorization failed. Verify Workspace domain-wide delegation "
                f"for client ID `{self.config.client_id or 'unknown'}` and that "
                f"`{self.config.delegated_user}` is a valid mailbox user."
            ) from exc
        try:
            payload = response.json()
        except Exception:
            payload = {}

        if response.status_code >= 400:
            logger.error(
                "support_email.send_failed status=%s recipient=%s payload=%s",
                response.status_code,
                self.config.effective_recipient,
                payload,
            )
            detail_message = (
                payload.get("error", {}).get("message")
                if isinstance(payload, dict)
                and isinstance(payload.get("error"), dict)
                and isinstance(payload.get("error", {}).get("message"), str)
                else None
            )
            raise SupportEmailSendError(
                detail_message or f"Gmail send failed with status {response.status_code}"
            )

        message_id = payload.get("id") if isinstance(payload, dict) else None
        return {
            "accepted": True,
            "delivery_mode": self.config.delivery_mode,
            "recipient": self.config.effective_recipient,
            "intended_recipient": self.config.support_to_email,
            "from_email": self.config.from_email,
            "message_id": message_id if isinstance(message_id, str) else None,
        }


_support_email_service: SupportEmailService | None = None


def get_support_email_service() -> SupportEmailService:
    global _support_email_service
    if _support_email_service is None:
        _support_email_service = SupportEmailService()
    return _support_email_service
