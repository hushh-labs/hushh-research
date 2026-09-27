from __future__ import annotations

import json
from email.message import EmailMessage

import pytest
from requests.exceptions import ConnectionError, Timeout

from hushh_mcp.runtime_settings import get_firebase_credential_settings
from hushh_mcp.services.support_email_service import (
    SupportEmailConfig,
    SupportEmailDeliveryUncertainError,
    SupportEmailSendError,
    SupportEmailService,
)

_FIREBASE_ADMIN_SA = {
    "type": "service_account",
    "project_id": "hushh-pda",
    "client_id": "109021324828349644970",
    "client_email": "firebase-adminsdk-fbsvc@hushh-pda.iam.gserviceaccount.com",
    "private_key": "-----BEGIN PRIVATE KEY-----\\nfixture\\n-----END PRIVATE KEY-----\\n",
    "token_uri": "https://oauth2.googleapis.com/token",
}


def _clear_workspace_email_env(monkeypatch) -> None:
    for name in (
        "FIREBASE_ADMIN_CREDENTIALS_JSON",
        "FIREBASE_SERVICE_ACCOUNT_JSON",
        "SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON",
        "SUPPORT_EMAIL_DELEGATED_USER",
        "SUPPORT_EMAIL_FROM",
        "SUPPORT_EMAIL_TO",
        "SUPPORT_EMAIL_TEST_TO",
        "SUPPORT_EMAIL_MODE",
        "ONE_EMAIL_ADDRESS",
        "GOOGLE_SERVICE_ACCOUNT_EMAIL",
        "GOOGLE_PRIVATE_KEY",
        "GOOGLE_SERVICE_ACCOUNT_PROJECT_ID",
        "ENVIRONMENT",
    ):
        monkeypatch.delenv(name, raising=False)
    get_firebase_credential_settings.cache_clear()


def test_firebase_service_account_json_is_supported_runtime_alias(monkeypatch) -> None:
    _clear_workspace_email_env(monkeypatch)
    encoded = json.dumps(_FIREBASE_ADMIN_SA)
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", encoded)

    settings = get_firebase_credential_settings()

    assert settings.admin_credentials_json == encoded


def test_support_email_defaults_to_one_mailbox_with_firebase_alias(monkeypatch) -> None:
    _clear_workspace_email_env(monkeypatch)
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", json.dumps(_FIREBASE_ADMIN_SA))

    cfg = SupportEmailConfig.from_env()

    assert cfg.configured is True
    assert cfg.client_id == "109021324828349644970"
    assert cfg.service_account_email == _FIREBASE_ADMIN_SA["client_email"]
    assert cfg.delegated_user == "one@hushh.ai"
    assert cfg.from_email == "one@hushh.ai"
    assert cfg.support_to_email == "one@hushh.ai"


def test_support_email_rejects_non_one_sender_overrides(monkeypatch) -> None:
    _clear_workspace_email_env(monkeypatch)
    monkeypatch.setenv("FIREBASE_ADMIN_CREDENTIALS_JSON", json.dumps(_FIREBASE_ADMIN_SA))
    monkeypatch.setenv("ONE_EMAIL_ADDRESS", "one@hushh.ai")
    monkeypatch.setenv("SUPPORT_EMAIL_DELEGATED_USER", "support-user@hushh.ai")
    monkeypatch.setenv("SUPPORT_EMAIL_FROM", "support@hushh.ai")
    monkeypatch.setenv("SUPPORT_EMAIL_TO", "support@hushh.ai")

    cfg = SupportEmailConfig.from_env()

    assert cfg.delegated_user == "support-user@hushh.ai"
    assert cfg.from_email == "support@hushh.ai"
    assert cfg.support_to_email == "support@hushh.ai"
    assert cfg.configured is False


def test_support_mail_bcc_is_internal_and_account_notices_have_no_bcc(monkeypatch) -> None:
    service = SupportEmailService()
    service._config = SupportEmailConfig(
        service_account_info={},
        service_account_email="fixture@example.com",
        private_key="fixture",
        project_id=None,
        client_id=None,
        delegated_user="one@hushh.ai",
        from_email="one@hushh.ai",
        support_to_email="one@hushh.ai",
        test_to_email=None,
        delivery_mode="live",
        configured=True,
    )
    support = service._build_email(
        kind="bug_report",
        subject="Synthetic",
        message="Synthetic report content",
        user_id="test-owner",
        user_email="verified@example.com",
        user_display_name=None,
        persona=None,
        page_url="/profile",
        user_agent=None,
    )
    assert support["To"] == "one@hushh.ai"
    assert support["Bcc"] == "kushal@hushh.ai"
    assert support["Reply-To"] == "verified@example.com"

    captured = []
    monkeypatch.setattr(service, "_send_email", lambda mail: captured.append(mail))
    service.send_account_notice(kind="passkey_added", to_email="verified@example.com")
    assert captured[0]["To"] == "verified@example.com"
    assert captured[0].get("Bcc") is None
    assert "test-owner" not in captured[0].get_content()


def test_gmail_acceptance_failure_and_uncertain_timeout_are_distinct(monkeypatch) -> None:
    service = SupportEmailService()
    message = EmailMessage()
    message["To"] = "one@hushh.ai"
    message.set_content("Synthetic")

    class Session:
        def __init__(self, result):
            self.result = result

        def post(self, *_args, **_kwargs):
            if isinstance(self.result, Exception):
                raise self.result
            return self.result

    class Response:
        def __init__(self, status_code):
            self.status_code = status_code

        def json(self):
            return {"id": "accepted-id"}

    monkeypatch.setattr(service, "_build_authorized_session", lambda: Session(Response(200)))
    assert service._send_email(message) == "accepted-id"
    monkeypatch.setattr(service, "_build_authorized_session", lambda: Session(Response(403)))
    with pytest.raises(SupportEmailSendError):
        service._send_email(message)
    monkeypatch.setattr(service, "_build_authorized_session", lambda: Session(Response(503)))
    with pytest.raises(SupportEmailDeliveryUncertainError):
        service._send_email(message)
    monkeypatch.setattr(
        service, "_build_authorized_session", lambda: Session(Timeout("private provider body"))
    )
    with pytest.raises(SupportEmailDeliveryUncertainError):
        service._send_email(message)
    monkeypatch.setattr(
        service,
        "_build_authorized_session",
        lambda: Session(ConnectionError("private provider body")),
    )
    with pytest.raises(SupportEmailDeliveryUncertainError):
        service._send_email(message)


def test_account_notice_test_mode_never_sends_to_real_user(monkeypatch) -> None:
    service = SupportEmailService()
    service._config = SupportEmailConfig(
        service_account_info={},
        service_account_email="fixture@example.com",
        private_key="fixture",
        project_id=None,
        client_id=None,
        delegated_user="one@hushh.ai",
        from_email="one@hushh.ai",
        support_to_email="one@hushh.ai",
        test_to_email="kushal@hushh.ai",
        delivery_mode="test",
        configured=True,
    )
    captured = []
    monkeypatch.setattr(service, "_send_email", lambda mail: captured.append(mail))
    service.send_account_notice(kind="welcome", to_email="new-user@example.com")
    assert captured[0]["To"] == "kushal@hushh.ai"
    assert captured[0]["Subject"] == "[TEST] Welcome to One"
