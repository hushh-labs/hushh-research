#!/usr/bin/env python3
"""Verify deploy-time secret/runtime env parity for backend/frontend services."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Iterable

BACKEND_REQUIRED = (
    "SECRET_KEY",
    "VAULT_ENCRYPTION_KEY",
    "GOOGLE_API_KEY",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON",
    "FRONTEND_URL",
    "DB_USER",
    "DB_PASSWORD",
    "APP_REVIEW_MODE",
    "REVIEWER_UID",
)

BACKEND_PLAID_REQUIRED = (
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "PLAID_TOKEN_ENCRYPTION_KEY",
)

BACKEND_MARKET_REQUIRED = (
    "FINNHUB_API_KEY",
    "PMP_API_KEY",
)

FRONTEND_REQUIRED = (
    "BACKEND_URL",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON",
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
    "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
    "NEXT_PUBLIC_AUTH_FIREBASE_API_KEY",
    "NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_AUTH_FIREBASE_APP_ID",
    "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_STAGING",
    "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID_PRODUCTION",
    "NEXT_PUBLIC_GTM_ID_STAGING",
    "NEXT_PUBLIC_GTM_ID_PRODUCTION",
)

NATIVE_RELEASE_REQUIRED = (
    "IOS_GOOGLESERVICE_INFO_PLIST_B64",
    "ANDROID_GOOGLE_SERVICES_JSON_B64",
    "APPLE_TEAM_ID",
    "IOS_DEV_CERT_P12_B64",
    "IOS_DEV_CERT_PASSWORD",
    "IOS_DEV_PROFILE_B64",
    "IOS_DIST_CERT_P12_B64",
    "IOS_DIST_CERT_PASSWORD",
    "IOS_APPSTORE_PROFILE_B64",
    "APPSTORE_CONNECT_API_KEY_P8_B64",
    "APPSTORE_CONNECT_KEY_ID",
    "APPSTORE_CONNECT_ISSUER_ID",
    "ANDROID_RELEASE_KEYSTORE_B64",
    "ANDROID_RELEASE_KEYSTORE_PASSWORD",
    "ANDROID_RELEASE_KEY_ALIAS",
    "ANDROID_RELEASE_KEY_PASSWORD",
)


def _has_secret(project: str, name: str) -> bool:
    cmd = [
        "gcloud",
        "secrets",
        "describe",
        name,
        "--project",
        project,
        "--format=value(name)",
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    return result.returncode == 0 and bool(result.stdout.strip())


def _format_names(names: Iterable[str]) -> str:
    return ", ".join(sorted(names))


def _describe_run_service(project: str, region: str, service: str) -> dict | None:
    cmd = [
        "gcloud",
        "run",
        "services",
        "describe",
        service,
        "--project",
        project,
        "--region",
        region,
        "--format=json",
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
      return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def _container_env_map(service_json: dict | None) -> dict[str, dict]:
    if not isinstance(service_json, dict):
        return {}
    containers = (
        service_json.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [])
    )
    if not containers or not isinstance(containers[0], dict):
        return {}
    env_entries = containers[0].get("env", [])
    if not isinstance(env_entries, list):
        return {}
    out: dict[str, dict] = {}
    for entry in env_entries:
        if isinstance(entry, dict) and entry.get("name"):
            out[str(entry["name"])] = entry
    return out


def _runtime_source_label(entry: dict) -> str:
    value_from = entry.get("valueFrom")
    if isinstance(value_from, dict):
        secret_ref = value_from.get("secretKeyRef")
        if isinstance(secret_ref, dict):
            name = str(secret_ref.get("name") or "").strip()
            key = str(secret_ref.get("key") or "").strip()
            if name:
                return f"secret:{name}:{key or 'latest'}"
    value = str(entry.get("value") or "").strip()
    return f"value:{value}" if value else "missing"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify required GCP Secret Manager keys for deploy parity."
    )
    parser.add_argument("--project", required=True, help="GCP project id")
    parser.add_argument("--region", default="us-central1", help="Reserved for parity interface")
    parser.add_argument(
        "--backend-service",
        default="consent-protocol",
        help="Reserved for parity interface",
    )
    parser.add_argument(
        "--frontend-service",
        default="hushh-webapp",
        help="Reserved for parity interface",
    )
    parser.add_argument(
        "--require-native-artifacts",
        action="store_true",
        help="Also require native Firebase artifact secrets for native release checks.",
    )
    parser.add_argument(
        "--require-plaid",
        action="store_true",
        help="Also require Plaid backend secrets for brokerage-enabled environments.",
    )
    parser.add_argument(
        "--require-market-data",
        action="store_true",
        help="Also require backend market provider secrets for market-home parity.",
    )
    parser.add_argument(
        "--assert-runtime-env-contract",
        action="store_true",
        help="Also verify Cloud Run runtime env injection for hosted frontend/backend parity.",
    )
    args = parser.parse_args()

    required = list(BACKEND_REQUIRED + FRONTEND_REQUIRED)
    if args.require_plaid:
        required.extend(BACKEND_PLAID_REQUIRED)
    if args.require_market_data:
        required.extend(BACKEND_MARKET_REQUIRED)
    if args.require_native_artifacts:
        required.extend(NATIVE_RELEASE_REQUIRED)
    required = tuple(dict.fromkeys(required))
    missing = [name for name in required if not _has_secret(args.project, name)]

    print(f"Project: {args.project}")
    print(f"Required backend secrets ({len(BACKEND_REQUIRED)}): {_format_names(BACKEND_REQUIRED)}")
    if args.require_plaid:
        print(
            "Required Plaid backend secrets "
            f"({len(BACKEND_PLAID_REQUIRED)}): {_format_names(BACKEND_PLAID_REQUIRED)}"
        )
    if args.require_market_data:
        print(
            "Required market backend secrets "
            f"({len(BACKEND_MARKET_REQUIRED)}): {_format_names(BACKEND_MARKET_REQUIRED)}"
        )
    print(f"Required frontend secrets ({len(FRONTEND_REQUIRED)}): {_format_names(FRONTEND_REQUIRED)}")
    if args.require_native_artifacts:
        print(
            "Required native release secrets "
            f"({len(NATIVE_RELEASE_REQUIRED)}): {_format_names(NATIVE_RELEASE_REQUIRED)}"
        )

    if missing:
        print(f"Missing secrets ({len(missing)}): {_format_names(missing)}")
        return 1

    if args.assert_runtime_env_contract:
        frontend_json = _describe_run_service(args.project, args.region, args.frontend_service)
        backend_json = _describe_run_service(args.project, args.region, args.backend_service)
        frontend_env = _container_env_map(frontend_json)
        backend_env = _container_env_map(backend_json)

        runtime_failures: list[str] = []

        required_frontend_runtime = ("BACKEND_URL", "DEVELOPER_API_URL", "NEXT_PUBLIC_APP_ENV")
        for key in required_frontend_runtime:
            if key not in frontend_env:
                runtime_failures.append(f"frontend runtime env missing {key}")

        if "BACKEND_URL" in frontend_env and "DEVELOPER_API_URL" in frontend_env:
            backend_source = _runtime_source_label(frontend_env["BACKEND_URL"])
            developer_source = _runtime_source_label(frontend_env["DEVELOPER_API_URL"])
            if backend_source != developer_source:
                runtime_failures.append(
                    "frontend BACKEND_URL and DEVELOPER_API_URL must resolve from the same source"
                )
            if backend_source.startswith("value:") and "localhost" in backend_source:
                runtime_failures.append("frontend BACKEND_URL must not resolve to localhost in Cloud Run")

        if "FRONTEND_URL" not in backend_env:
            runtime_failures.append("backend runtime env missing FRONTEND_URL")

        print(
            "Frontend runtime env contract:"
            f" BACKEND_URL={_runtime_source_label(frontend_env.get('BACKEND_URL', {}))},"
            f" DEVELOPER_API_URL={_runtime_source_label(frontend_env.get('DEVELOPER_API_URL', {}))},"
            f" NEXT_PUBLIC_APP_ENV={_runtime_source_label(frontend_env.get('NEXT_PUBLIC_APP_ENV', {}))}"
        )
        print(
            "Backend runtime env contract:"
            f" FRONTEND_URL={_runtime_source_label(backend_env.get('FRONTEND_URL', {}))}"
        )

        if runtime_failures:
            print(f"Runtime env contract failures ({len(runtime_failures)}): {_format_names(runtime_failures)}")
            return 1

    print(f"All required secrets present ({len(required)}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
