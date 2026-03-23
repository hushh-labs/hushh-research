from __future__ import annotations

from email.message import EmailMessage

import pytest

from hushh_mcp.services.support_email_service import (
    SupportEmailConfig,
    SupportEmailSendError,
    SupportEmailService,
)


def _configured_service() -> SupportEmailService:
    service = SupportEmailService()
    service._config = SupportEmailConfig(
        service_account_info={
            "type": "service_account",
            "client_email": "support-bot@hushh.iam.gserviceaccount.com",
            "private_key": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
            "token_uri": "https://oauth2.googleapis.com/token",
        },
        service_account_email="support-bot@hushh.iam.gserviceaccount.com",
        private_key="-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        project_id=None,
        client_id="client-123",
        delegated_user="support@hushh.ai",
        from_email="support@hushh.ai",
        support_to_email="support@hushh.ai",
        test_to_email=None,
        delivery_mode="live",
        configured=True,
    )
    return service


def test_build_email_ignores_invalid_reply_to_header_value():
    service = _configured_service()

    message = service._build_email(
        kind="support_request",
        subject="Need help",
        message="Please help me with my account.",
        user_id="user_123",
        user_email="bad\nReply-To: attacker@example.com",
        user_display_name="Ada Lovelace",
        persona="member",
        page_url="https://app.hushh.ai/support",
        user_agent="pytest",
    )

    assert isinstance(message, EmailMessage)
    assert message["Reply-To"] is None


def test_send_message_reports_generic_transport_failure_without_auth_label(monkeypatch):
    service = _configured_service()

    class _FakeSession:
        def post(self, *args, **kwargs):
            raise RuntimeError("socket closed")

    monkeypatch.setattr(service, "_build_authorized_session", lambda: _FakeSession())

    with pytest.raises(SupportEmailSendError) as exc_info:
        service.send_message(
            kind="support_request",
            subject="Need help",
            message="Please help me with my account.",
            user_id="user_123",
            user_email="ada@example.com",
            user_display_name="Ada Lovelace",
            persona="member",
            page_url="https://app.hushh.ai/support",
            user_agent="pytest",
        )

    assert "authorization failed" not in str(exc_info.value).lower()
    assert "transport" in str(exc_info.value).lower()
