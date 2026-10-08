#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Fixed commerce sandbox target. No resource creation or secret fallback."""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

PREFIX = "SCOPE_COMMERCE_SANDBOX_"
PROJECT = "hushh-pda-dev"
BACKEND = "consent-protocol-commerce-sandbox"
FRONTEND = "hushh-webapp-commerce-sandbox"
RUNTIME_SA = "commerce-sandbox-runtime@hushh-pda-dev.iam.gserviceaccount.com"
SCHEDULER_SA = (
    "commerce-sandbox-scheduler@hushh-pda-dev.iam.gserviceaccount.com"
)
DATABASE = "scope_commerce_sandbox"
STRIPE_ACCOUNT = "acct_1UNyyyLsJU9ZDBZX"
PRIVATE_SECRETS = (
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "BACKEND_RUNTIME_CONFIG_JSON",
    "DB_USER",
    "DB_PASSWORD",
    "SCOPE_COMMERCE_STRIPE_SECRET_KEY",
    "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET",
    "SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET",
)
WEB_SECRETS = (
    "BACKEND_URL",
    "APP_FRONTEND_ORIGIN",
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
    "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
    "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY",
    "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
    "APPLE_TEAM_ID",
    "NEXT_PUBLIC_IOS_BUNDLE_ID",
    "NEXT_PUBLIC_ANDROID_APP_ID",
    "ANDROID_SHA256_CERT_FINGERPRINTS",
)


class PreviewError(ValueError):
    """Fixed error codes only; never include credential or identity values."""


def origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise PreviewError("preview_origin_invalid")
    return value


@dataclass(frozen=True)
class PreviewTarget:
    name: str = "scope-commerce-sandbox"
    prefix: str = PREFIX
    database: str = DATABASE
    backend: str = BACKEND
    frontend: str = FRONTEND
    runtime_sa: str = RUNTIME_SA

    def environment(self) -> dict[str, str]:
        return {
            "DEV_TARGET": self.name,
            "BACKEND_SERVICE": self.backend,
            "FRONTEND_SERVICE": self.frontend,
            "RUNTIME_SERVICE_ACCOUNT": self.runtime_sa,
            "DEV_DB_NAME": self.database,
            "DEPLOY_SECRET_PREFIX": self.prefix,
        }

    def service_origin(self, document: dict, service: str) -> str:
        if document.get("metadata", {}).get("name") != service:
            raise PreviewError("preview_service_mismatch")
        template = document.get("spec", {}).get("template", {}).get("spec", {})
        if template.get("serviceAccountName") != self.runtime_sa:
            raise PreviewError("preview_runtime_identity_mismatch")
        value = origin(document.get("status", {}).get("url", ""))
        if not urlsplit(value).hostname.endswith(".run.app"):
            raise PreviewError("preview_service_origin_unverified")
        return value

    def validate_policy(
        self, config: dict, frontend_origin: str, backend_origin: str
    ) -> tuple[str, str]:
        policy = config.get("scope_commerce_sandbox_policy_json")
        users = policy.get("reviewer_user_ids") if isinstance(policy, dict) else None
        if (
            not isinstance(users, list)
            or len(users) != 2
            or any(not isinstance(user, str) or not user.strip() for user in users)
            or len(set(users)) != 2
        ):
            raise PreviewError("preview_reviewers_unverified")
        required = {
            "environment": "uat",
            "db_name": self.database,
            "db_unix_socket": "/cloudsql/hushh-pda-dev:us-central1:hushh-dev-pg",
            "scope_commerce_stripe_livemode": False,
            "scope_commerce_sandbox_policy_required": True,
            "scope_commerce_frontend_origin": frontend_origin,
            "scope_commerce_drain_audience": backend_origin,
            "scope_commerce_drain_scheduler_service_accounts": [SCHEDULER_SA],
        }
        if any(config.get(key) != expected for key, expected in required.items()):
            raise PreviewError("preview_runtime_policy_mismatch")
        countries = config.get("scope_commerce_country_policies_json")
        if (
            not isinstance(countries, dict)
            or set(countries) != {"US"}
            or policy.get("environment") != "sandbox"
            or policy.get("reviewer_funding_cap_cents") != 2000
            or policy.get("operating_capital_cap_cents") != 2500
            or policy.get("platform_account_id") != STRIPE_ACCOUNT
            or config.get("scope_commerce_stripe_account_id")
            != policy["platform_account_id"]
        ):
            raise PreviewError("preview_commerce_policy_mismatch")
        for key in (
            "sync_remote_enabled",
            "drive_work_drain_enabled",
            "google_drive_live",
            "gmail_chat_reads",
            "google_drive_chat_reads",
            "mail_scheduled_drain_enabled",
            "one_voice_mail_reply_enabled",
            "one_voice_mail_schedule_send_enabled",
            "one_voice_mail_drafts_enabled",
        ):
            if config.get(key, False) not in (False, "false"):
                raise PreviewError("preview_unrelated_ingestion_enabled")
        for key in (
            "one_email_pubsub_topic",
            "one_email_webhook_audience",
            "one_email_delegated_user",
            "one_email_address",
            "gmail_personal_information_request_monitor_audience",
        ):
            if config.get(key):
                raise PreviewError("preview_unrelated_machine_ingestion_configured")
        return tuple(users)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target", choices=("shared-dev", "scope-commerce-sandbox"), required=True
    )
    parser.add_argument("--github-env", required=True)
    parser.add_argument("--backend-json")
    parser.add_argument("--frontend-json")
    args = parser.parse_args()
    values = {
        "DEV_TARGET": "shared-dev",
        "DEV_DB_NAME": "postgres",
        "DEPLOY_SECRET_PREFIX": "",
    }
    if args.target == "scope-commerce-sandbox":
        target = PreviewTarget()
        values = target.environment()
        if args.backend_json or args.frontend_json:
            if not (args.backend_json and args.frontend_json):
                raise PreviewError("preview_service_state_missing")
            backend = target.service_origin(
                json.loads(Path(args.backend_json).read_text()), BACKEND
            )
            frontend = target.service_origin(
                json.loads(Path(args.frontend_json).read_text()), FRONTEND
            )
            values |= {
                "APP_FRONTEND_ORIGIN": frontend,
                "PREVIEW_BACKEND_ORIGIN": backend,
            }
    with Path(args.github_env).open("a") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PreviewError, OSError, ValueError):
        raise SystemExit("preview_target_unverified") from None
