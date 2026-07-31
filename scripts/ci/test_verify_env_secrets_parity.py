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


def _valid_one_location_event_pilot_env() -> dict[str, dict[str, object]]:
    return {
        "ONE_LOCATION_NEARBY_PRESENCE_MODE": {"value": "event_pilot"},
        "ONE_LOCATION_RETENTION_TOKEN": {
            "valueFrom": {
                "secretKeyRef": {
                    "name": "ONE_LOCATION_RETENTION_TOKEN",
                    "key": "latest",
                }
            }
        },
    }


def test_one_location_event_pilot_runtime_requires_exact_mode_and_secret_mount():
    result = _module()._one_location_event_pilot_runtime_semantics(
        _valid_one_location_event_pilot_env()
    )

    assert result == {
        "status": "valid",
        "checks": {
            "mode": "valid",
            "retention_secret": "valid",
        },
    }


def test_one_location_event_pilot_runtime_rejects_noncanonical_configurations():
    module = _module()
    invalid_envs = [
        {
            "ONE_LOCATION_RETENTION_TOKEN": _valid_one_location_event_pilot_env()[
                "ONE_LOCATION_RETENTION_TOKEN"
            ],
        },
        {
            **_valid_one_location_event_pilot_env(),
            "ONE_LOCATION_NEARBY_PRESENCE_MODE": {"value": "disabled"},
        },
        {
            **_valid_one_location_event_pilot_env(),
            "ONE_LOCATION_NEARBY_PRESENCE_MODE": {"value": "EVENT_PILOT"},
        },
        {
            **_valid_one_location_event_pilot_env(),
            "ONE_LOCATION_NEARBY_PRESENCE_MODE": {
                "valueFrom": {
                    "secretKeyRef": {
                        "name": "ONE_LOCATION_NEARBY_PRESENCE_MODE",
                        "key": "latest",
                    }
                }
            },
        },
        {
            "ONE_LOCATION_NEARBY_PRESENCE_MODE": {"value": "event_pilot"},
            "ONE_LOCATION_RETENTION_TOKEN": {"value": "literal-token"},
        },
    ]

    assert all(
        module._one_location_event_pilot_runtime_semantics(env)["status"]
        == "mismatch"
        for env in invalid_envs
    )
