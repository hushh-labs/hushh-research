from __future__ import annotations

import json

from hushh_mcp.runtime_settings import get_firebase_credential_settings
from hushh_mcp.services.support_email_service import SupportEmailConfig

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


def test_support_email_keeps_explicit_sender_overrides(monkeypatch) -> None:
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
