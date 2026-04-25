#!/usr/bin/env python3
"""Verify deploy-time secret/runtime env parity for backend/frontend services."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

BACKEND_REQUIRED = (
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "GOOGLE_API_KEY",
    "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "APP_FRONTEND_ORIGIN",
    "BACKEND_RUNTIME_CONFIG_JSON",
    "DB_USER",
    "DB_PASSWORD",
)

BACKEND_PLAID_REQUIRED = (
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "PLAID_ACCESS_TOKEN_KEY",
)

BACKEND_MARKET_REQUIRED = (
    "FINNHUB_API_KEY",
    "PMP_API_KEY",
)

BACKEND_GMAIL_REQUIRED = (
    "GMAIL_OAUTH_CLIENT_ID",
    "GMAIL_OAUTH_CLIENT_SECRET",
    "GMAIL_OAUTH_REDIRECT_URI",
    "GMAIL_OAUTH_TOKEN_KEY",
)

BACKEND_VOICE_REQUIRED = (
    "OPENAI_API_KEY",
    "VOICE_RUNTIME_CONFIG_JSON",
)

BACKEND_REVIEWER_SMOKE_REQUIRED = (
    "REVIEWER_UID",
    "REVIEWER_VAULT_PASSPHRASE",
)

FRONTEND_REQUIRED = (
    "BACKEND_URL",
    "APP_FRONTEND_ORIGIN",
    "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
    "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
    "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
    "NEXT_PUBLIC_GTM_ID",
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

BACKEND_RUNTIME_REQUIRED = (
    "APP_FRONTEND_ORIGIN",
    "BACKEND_RUNTIME_CONFIG_JSON",
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "DB_USER",
    "DB_PASSWORD",
)

FRONTEND_RUNTIME_REQUIRED = (
    "BACKEND_URL",
    "DEVELOPER_API_URL",
    "NEXT_PUBLIC_APP_ENV",
    "FIREBASE_ADMIN_CREDENTIALS_JSON",
)

LEGACY_BACKEND_RUNTIME_MAP: dict[str, tuple[str, ...]] = {
    "APP_SIGNING_KEY": ("SECRET_KEY",),
    "VAULT_DATA_KEY": ("VAULT_ENCRYPTION_KEY",),
    "APP_FRONTEND_ORIGIN": ("FRONTEND_URL",),
    "FIREBASE_ADMIN_CREDENTIALS_JSON": ("FIREBASE_SERVICE_ACCOUNT_JSON",),
    "GMAIL_OAUTH_TOKEN_KEY": ("GMAIL_TOKEN_ENCRYPTION_KEY",),
    "PLAID_ACCESS_TOKEN_KEY": ("PLAID_TOKEN_ENCRYPTION_KEY",),
}

LEGACY_FRONTEND_RUNTIME_MAP: dict[str, tuple[str, ...]] = {
    "FIREBASE_ADMIN_CREDENTIALS_JSON": ("FIREBASE_SERVICE_ACCOUNT_JSON",),
}

LEGACY_BACKEND_RUNTIME_COMPONENTS = (
    "ENVIRONMENT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_UNIX_SOCKET",
    "CONSENT_SSE_ENABLED",
    "SYNC_REMOTE_ENABLED",
    "DEVELOPER_API_ENABLED",
    "REMOTE_MCP_ENABLED",
    "CORS_ALLOWED_ORIGINS",
    "OBS_DATA_STALE_RATIO_THRESHOLD",
    "PASSKEY_ALLOWED_RP_IDS",
)

LEGACY_VOICE_RUNTIME_COMPONENTS = (
    "KAI_VOICE_REALTIME_ENABLED",
    "KAI_VOICE_V1_ENABLED",
    "KAI_VOICE_V1_CANARY_PERCENT",
    "KAI_VOICE_V1_DISABLE_TOOL_EXECUTION",
    "FORCE_REALTIME_VOICE",
    "FAIL_FAST_VOICE",
    "DISABLE_VOICE_FALLBACKS",
    "OPENAI_VOICE_REALTIME_MODEL",
    "OPENAI_VOICE_STT_MODELS",
    "OPENAI_VOICE_INTENT_MODELS",
    "OPENAI_VOICE_TTS_MODELS",
    "OPENAI_VOICE_TTS_DEFAULT_VOICE",
    "OPENAI_VOICE_TTS_FORMAT",
    "OPENAI_VOICE_TTS_PREFER_QUALITY",
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


def _describe_run_service(project: str, region: str, service: str) -> dict[str, Any] | None:
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


def _container_env_map(service_json: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
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
    out: dict[str, dict[str, Any]] = {}
    for entry in env_entries:
        if isinstance(entry, dict) and entry.get("name"):
            out[str(entry["name"])] = entry
    return out


def _runtime_source_label(entry: dict[str, Any]) -> str:
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


def _secret_name_from_source(source: str) -> str:
    if not source.startswith("secret:"):
        return ""
    parts = source.split(":", 2)
    if len(parts) < 2:
        return ""
    return parts[1].strip()


def _load_json_report(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    candidate = Path(path)
    if not candidate.exists():
        return None
    try:
        parsed = json.loads(candidate.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _classify_runtime_key(
    env_map: dict[str, dict[str, Any]],
    key: str,
    *,
    legacy_keys: tuple[str, ...] = (),
    legacy_component_keys: tuple[str, ...] = (),
) -> dict[str, Any]:
    if key not in env_map:
        matched_legacy_keys = [candidate for candidate in legacy_keys if candidate in env_map]
        matched_components = [candidate for candidate in legacy_component_keys if candidate in env_map]
        if matched_legacy_keys or matched_components:
            return {
                "key": key,
                "status": "legacy",
                "source": "missing",
                "legacy_keys": sorted(matched_legacy_keys + matched_components),
                "legacy_secret_name": "",
            }
        return {
            "key": key,
            "status": "missing",
            "source": "missing",
            "legacy_keys": [],
            "legacy_secret_name": "",
        }

    source = _runtime_source_label(env_map[key])
    legacy_secret_name = ""
    if source.startswith("secret:"):
        secret_name = _secret_name_from_source(source)
        if secret_name and secret_name != key and secret_name in set(legacy_keys):
            legacy_secret_name = secret_name

    status = "legacy" if legacy_secret_name else "present"
    return {
        "key": key,
        "status": status,
        "source": source,
        "legacy_keys": [],
        "legacy_secret_name": legacy_secret_name,
    }


def _render_runtime_summary(label: str, entries: list[dict[str, Any]]) -> str:
    rendered = ", ".join(f"{entry['key']}={entry['source']}" for entry in entries)
    return f"{label}: {rendered}"


def _classifications_from_runtime_entries(entries: list[dict[str, Any]]) -> list[str]:
    statuses = {entry["status"] for entry in entries}
    classifications: list[str] = []
    if "legacy" in statuses:
        classifications.append("runtime_mount_legacy")
    if "missing" in statuses:
        classifications.append("runtime_mount_missing")
    return classifications


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
        "--require-gmail",
        action="store_true",
        help="Also require backend Gmail sync secrets for Gmail parity.",
    )
    parser.add_argument(
        "--require-voice",
        action="store_true",
        help="Also require backend voice runtime secrets for voice parity.",
    )
    parser.add_argument(
        "--require-reviewer-smoke",
        action="store_true",
        help="Also require non-production reviewer smoke secrets on the backend runtime.",
    )
    parser.add_argument(
        "--assert-runtime-env-contract",
        action="store_true",
        help="Also verify Cloud Run runtime env injection for hosted frontend/backend parity.",
    )
    parser.add_argument(
        "--semantic-report-path",
        help="Optional semantic UAT verification report used to classify runtime behavior failures.",
    )
    parser.add_argument(
        "--report-path",
        help="Optional JSON report path for machine-readable RCA artifacts.",
    )
    args = parser.parse_args()

    required = list(BACKEND_REQUIRED + FRONTEND_REQUIRED)
    if args.require_plaid:
        required.extend(BACKEND_PLAID_REQUIRED)
    if args.require_market_data:
        required.extend(BACKEND_MARKET_REQUIRED)
    if args.require_gmail:
        required.extend(BACKEND_GMAIL_REQUIRED)
    if args.require_voice:
        required.extend(BACKEND_VOICE_REQUIRED)
    if args.require_reviewer_smoke:
        required.extend(BACKEND_REVIEWER_SMOKE_REQUIRED)
    if args.require_native_artifacts:
        required.extend(NATIVE_RELEASE_REQUIRED)
    required = tuple(dict.fromkeys(required))
    missing = [name for name in required if not _has_secret(args.project, name)]

    report: dict[str, Any] = {
        "project": args.project,
        "region": args.region,
        "backend_service": args.backend_service,
        "frontend_service": args.frontend_service,
        "required": {
            "backend": list(BACKEND_REQUIRED),
            "frontend": list(FRONTEND_REQUIRED),
            "gmail": list(BACKEND_GMAIL_REQUIRED) if args.require_gmail else [],
            "voice": list(BACKEND_VOICE_REQUIRED) if args.require_voice else [],
            "reviewer_smoke": list(BACKEND_REVIEWER_SMOKE_REQUIRED)
            if args.require_reviewer_smoke
            else [],
            "plaid": list(BACKEND_PLAID_REQUIRED) if args.require_plaid else [],
            "market": list(BACKEND_MARKET_REQUIRED) if args.require_market_data else [],
            "native_release": list(NATIVE_RELEASE_REQUIRED) if args.require_native_artifacts else [],
        },
        "missing_secrets": sorted(missing),
        "classifications": [],
        "runtime_contract": {
            "frontend": [],
            "backend": [],
            "backend_gmail": [],
            "backend_voice": [],
            "backend_reviewer_smoke": [],
        },
    }

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
    if args.require_gmail:
        print(
            "Required Gmail backend secrets "
            f"({len(BACKEND_GMAIL_REQUIRED)}): {_format_names(BACKEND_GMAIL_REQUIRED)}"
        )
    if args.require_voice:
        print(
            "Required voice backend secrets "
            f"({len(BACKEND_VOICE_REQUIRED)}): {_format_names(BACKEND_VOICE_REQUIRED)}"
        )
    if args.require_reviewer_smoke:
        print(
            "Required reviewer smoke backend secrets "
            f"({len(BACKEND_REVIEWER_SMOKE_REQUIRED)}): {_format_names(BACKEND_REVIEWER_SMOKE_REQUIRED)}"
        )
    print(f"Required frontend secrets ({len(FRONTEND_REQUIRED)}): {_format_names(FRONTEND_REQUIRED)}")
    if args.require_native_artifacts:
        print(
            "Required native release secrets "
            f"({len(NATIVE_RELEASE_REQUIRED)}): {_format_names(NATIVE_RELEASE_REQUIRED)}"
        )

    if missing:
        report["classifications"].append("secret_missing")
        print(f"Missing secrets ({len(missing)}): {_format_names(missing)}")

    if args.assert_runtime_env_contract:
        frontend_json = _describe_run_service(args.project, args.region, args.frontend_service)
        backend_json = _describe_run_service(args.project, args.region, args.backend_service)
        frontend_env = _container_env_map(frontend_json)
        backend_env = _container_env_map(backend_json)

        frontend_entries = [
            _classify_runtime_key(
                frontend_env,
                key,
                legacy_keys=LEGACY_FRONTEND_RUNTIME_MAP.get(key, tuple()),
            )
            for key in FRONTEND_RUNTIME_REQUIRED
        ]
        backend_entries = [
            _classify_runtime_key(
                backend_env,
                key,
                legacy_keys=LEGACY_BACKEND_RUNTIME_MAP.get(key, tuple()),
                legacy_component_keys=LEGACY_BACKEND_RUNTIME_COMPONENTS
                if key == "BACKEND_RUNTIME_CONFIG_JSON"
                else tuple(),
            )
            for key in BACKEND_RUNTIME_REQUIRED
        ]
        backend_gmail_entries = []
        if args.require_gmail:
            backend_gmail_entries = [
                _classify_runtime_key(
                    backend_env,
                    key,
                    legacy_keys=LEGACY_BACKEND_RUNTIME_MAP.get(key, tuple()),
                )
                for key in BACKEND_GMAIL_REQUIRED
            ]
        backend_voice_entries = []
        if args.require_voice:
            backend_voice_entries = [
                _classify_runtime_key(
                    backend_env,
                    key,
                    legacy_component_keys=LEGACY_VOICE_RUNTIME_COMPONENTS
                    if key == "VOICE_RUNTIME_CONFIG_JSON"
                    else tuple(),
                )
                for key in BACKEND_VOICE_REQUIRED
            ]
        backend_reviewer_smoke_entries = []
        if args.require_reviewer_smoke:
            backend_reviewer_smoke_entries = [
                _classify_runtime_key(backend_env, key)
                for key in BACKEND_REVIEWER_SMOKE_REQUIRED
            ]

        report["runtime_contract"]["frontend"] = frontend_entries
        report["runtime_contract"]["backend"] = backend_entries
        report["runtime_contract"]["backend_gmail"] = backend_gmail_entries
        report["runtime_contract"]["backend_voice"] = backend_voice_entries
        report["runtime_contract"]["backend_reviewer_smoke"] = backend_reviewer_smoke_entries

        runtime_classifications = []
        runtime_classifications.extend(_classifications_from_runtime_entries(frontend_entries))
        runtime_classifications.extend(_classifications_from_runtime_entries(backend_entries))
        runtime_classifications.extend(_classifications_from_runtime_entries(backend_gmail_entries))
        runtime_classifications.extend(_classifications_from_runtime_entries(backend_voice_entries))
        runtime_classifications.extend(
            _classifications_from_runtime_entries(backend_reviewer_smoke_entries)
        )
        report["classifications"].extend(runtime_classifications)

        print(_render_runtime_summary("Frontend runtime env contract", frontend_entries))
        print(_render_runtime_summary("Backend runtime env contract", backend_entries))
        if args.require_gmail:
            print(_render_runtime_summary("Backend Gmail runtime env contract", backend_gmail_entries))
        if args.require_voice:
            print(_render_runtime_summary("Backend voice runtime env contract", backend_voice_entries))
        if args.require_reviewer_smoke:
            print(
                _render_runtime_summary(
                    "Backend reviewer smoke runtime env contract",
                    backend_reviewer_smoke_entries,
                )
            )

        runtime_failures = [
            entry["key"]
            for entry in (
                frontend_entries
                + backend_entries
                + backend_gmail_entries
                + backend_voice_entries
                + backend_reviewer_smoke_entries
            )
            if entry["status"] in {"legacy", "missing"}
        ]
        if runtime_failures:
            print(
                "Runtime env contract failures "
                f"({len(runtime_failures)}): {_format_names(runtime_failures)}"
            )

    semantic_report = _load_json_report(args.semantic_report_path)
    if semantic_report is not None:
        report["semantic_report"] = semantic_report
        if semantic_report.get("status") != "healthy":
            report["classifications"].append("runtime_behavior_failed")

    report["classifications"] = list(dict.fromkeys(report["classifications"]))
    report["status"] = "healthy" if not report["classifications"] else "blocked"

    if report["classifications"]:
        print(f"Failure classifications: {_format_names(report['classifications'])}")
    else:
        print(f"All required secrets present ({len(required)}).")

    if args.report_path:
        report_path = Path(args.report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    return 0 if report["status"] == "healthy" else 1


if __name__ == "__main__":
    raise SystemExit(main())
