from __future__ import annotations

import importlib.util
from pathlib import Path


def _module():
    path = Path(__file__).parents[1] / "ops" / "verify-env-secrets-parity.py"
    spec = importlib.util.spec_from_file_location("verify_env_secrets_parity", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _valid_one_email_env() -> dict[str, dict[str, str]]:
    return {
        "ONE_EMAIL_ADDRESS": {"value": "one@hushh.ai"},
        "ONE_EMAIL_DELEGATED_USER": {"value": "one@hushh.ai"},
        "ONE_EMAIL_PUBSUB_TOPIC": {
            "value": "projects/hushh-pda/topics/one-email-kyc-uat"
        },
        "ONE_EMAIL_WEBHOOK_AUDIENCE": {
            "value": "https://backend.example/api/one/email/webhook"
        },
        "ONE_EMAIL_WEBHOOK_SERVICE_ACCOUNT_EMAIL": {
            "value": "one-email-push@example.iam.gserviceaccount.com"
        },
        "ONE_EMAIL_WEBHOOK_AUTH_ENABLED": {"value": "true"},
        "ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED": {"value": "true"},
        "ONE_EMAIL_KYC_DEFAULT_SCOPE": {"value": "attr.identity.*"},
        "ONE_EMAIL_KYC_STRICT_CLIENT_ZK_ENABLED": {"value": "true"},
    }


def test_one_email_runtime_semantics_accepts_canonical_hosted_configuration():
    result = _module()._one_email_runtime_semantics(_valid_one_email_env())

    assert result["status"] == "valid"
    assert set(result["checks"].values()) == {"valid"}


def test_one_email_runtime_semantics_rejects_noncanonical_mailbox():
    env = _valid_one_email_env()
    env["ONE_EMAIL_ADDRESS"] = {"value": "other@hushh.ai"}

    result = _module()._one_email_runtime_semantics(env)

    assert result["status"] == "mismatch"
    assert result["checks"]["mailbox"] == "mismatch"
