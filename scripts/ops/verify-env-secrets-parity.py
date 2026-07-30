#!/usr/bin/env python3
"""Verify deploy-time secret/runtime env parity for backend/frontend services."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

BACKEND_REQUIRED = (
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "GOOGLE_MAPS_API_KEY",
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

BACKEND_ONE_EMAIL_SECRET_REQUIRED = (
    "ONE_EMAIL_WATCH_RENEW_TOKEN",
)

BACKEND_ONE_EMAIL_RUNTIME_REQUIRED = (
    "ONE_EMAIL_ADDRESS",
    "ONE_EMAIL_DELEGATED_USER",
    "ONE_EMAIL_PUBSUB_TOPIC",
    "ONE_EMAIL_WEBHOOK_AUDIENCE",
    "ONE_EMAIL_WEBHOOK_SERVICE_ACCOUNT_EMAIL",
    "ONE_EMAIL_WEBHOOK_AUTH_ENABLED",
    "ONE_EMAIL_WATCH_RENEW_TOKEN",
    "ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED",
    "ONE_EMAIL_KYC_DEFAULT_SCOPE",
    "ONE_EMAIL_KYC_STRICT_CLIENT_ZK_ENABLED",
)

BACKEND_VOICE_REQUIRED = (
    "OPENAI_API_KEY",
    "VOICE_RUNTIME_CONFIG_JSON",
)

BACKEND_CONNECTED_SYSTEMS_REQUIRED = (
    "OMNIGATEWAY_CLIENT_ID",
    "OMNIGATEWAY_CLIENT_SECRET",
)

BACKEND_REVIEWER_SMOKE_REQUIRED = (
    "REVIEWER_UID",
    "REVIEWER_VAULT_PASSPHRASE",
)

BACKEND_PROD_PHONE_TEST_REQUIRED = (
    "HUSHH_PROD_PHONE_TEST_NUMBERS",
    "HUSHH_PROD_PHONE_TEST_CODE",
    "HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET",
)

GMAIL_OAUTH_RETURN_PATH = "/profile/gmail/oauth/return"

FRONTEND_REQUIRED = (
    "BACKEND_URL",
    "APP_FRONTEND_ORIGIN",
    "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "APPLE_TEAM_ID",
    "NEXT_PUBLIC_IOS_BUNDLE_ID",
    "NEXT_PUBLIC_ANDROID_APP_ID",
    "ANDROID_SHA256_CERT_FINGERPRINTS",
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
    "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
    "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
    "NEXT_PUBLIC_GTM_ID",
    # Browser Maps is bundled during the frontend build. Native Maps keys stay
    # in NATIVE_RELEASE_REQUIRED because they are bundled only into archives.
    "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY",
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
    "NEXT_PUBLIC_GOOGLE_MAPS_IOS_API_KEY",
    "NEXT_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY",
)

BACKEND_RUNTIME_REQUIRED = (
    "APP_FRONTEND_ORIGIN",
    "BACKEND_RUNTIME_CONFIG_JSON",
    "CONSENT_API_PUBLIC_ORIGIN",
    "HUSHH_GENAI_AUTH_MODE",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_MAPS_API_KEY",
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "DB_USER",
    "DB_PASSWORD",
)

BACKEND_CONNECTED_SYSTEMS_RUNTIME_REQUIRED = BACKEND_CONNECTED_SYSTEMS_REQUIRED

FRONTEND_RUNTIME_REQUIRED = (
    "BACKEND_URL",
    "DEVELOPER_API_URL",
    "NEXT_PUBLIC_APP_ENV",
    "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "APPLE_TEAM_ID",
    "NEXT_PUBLIC_IOS_BUNDLE_ID",
    "NEXT_PUBLIC_ANDROID_APP_ID",
    "ANDROID_SHA256_CERT_FINGERPRINTS",
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
    "HUSHH_GENAI_AUTH_MODE",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
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


def _read_secret_value(project: str, name: str) -> str | None:
    """Read a deploy-time value only for an in-memory boolean contract check.

    This helper deliberately never renders the returned value. Reports contain
    only status and the public callback path, never a secret payload.
    """

    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            name,
            "--project",
            project,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout.rstrip("\r\n")


def _expected_gmail_redirect_uri(app_frontend_origin: str | None) -> str | None:
    parsed = urlsplit((app_frontend_origin or "").strip())
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        return None
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    return f"{origin}{GMAIL_OAUTH_RETURN_PATH}"


def _gmail_redirect_contract(project: str) -> dict[str, str]:
    configured = _read_secret_value(project, "GMAIL_OAUTH_REDIRECT_URI")
    frontend_origin = _read_secret_value(project, "APP_FRONTEND_ORIGIN")
    expected = _expected_gmail_redirect_uri(frontend_origin)
    if configured is None or frontend_origin is None:
        status = "unavailable"
    elif expected is None:
        status = "invalid_frontend_origin"
    elif configured == expected:
        status = "valid"
    else:
        status = "mismatch"
    return {
        "status": status,
        "expected_from": f"APP_FRONTEND_ORIGIN + {GMAIL_OAUTH_RETURN_PATH}",
    }


def _domain_runtime_contract(project: str) -> dict[str, str]:
    """Validate domain-derived backend config without rendering secret values.

    Presence and Cloud Run mount checks cannot prove that the JSON runtime
    config was rebuilt after an origin migration. This compares only canonical
    public URL/host relationships in-memory and returns status labels.
    """

    frontend_origin = _read_secret_value(project, "APP_FRONTEND_ORIGIN")
    runtime_raw = _read_secret_value(project, "BACKEND_RUNTIME_CONFIG_JSON")
    expected_gmail_redirect = _expected_gmail_redirect_uri(frontend_origin)
    if not frontend_origin or not runtime_raw or not expected_gmail_redirect:
        return {
            "status": "unavailable",
            "cors": "unavailable",
            "passkeys": "unavailable",
            "plaid_webhook": "unavailable",
        }

    try:
        runtime = json.loads(runtime_raw)
    except json.JSONDecodeError:
        runtime = None
    if not isinstance(runtime, dict):
        return {
            "status": "invalid_runtime_config",
            "cors": "invalid_runtime_config",
            "passkeys": "invalid_runtime_config",
            "plaid_webhook": "invalid_runtime_config",
        }

    origin = urlsplit(frontend_origin)
    host = (origin.hostname or "").lower()
    if not host:
        return {
            "status": "invalid_frontend_origin",
            "cors": "invalid_frontend_origin",
            "passkeys": "invalid_frontend_origin",
            "plaid_webhook": "invalid_frontend_origin",
        }

    cors_values = {
        item.strip().rstrip("/")
        for item in str(runtime.get("cors_allowed_origins") or "").split(",")
        if item.strip()
    }
    expected_origin = frontend_origin.rstrip("/")
    cors_status = "valid" if expected_origin in cors_values else "mismatch"

    passkey_hosts = {
        item.strip().lower()
        for item in str(runtime.get("passkey_allowed_rp_ids") or "").split(",")
        if item.strip()
    }
    passkey_status = "valid" if host in passkey_hosts else "mismatch"

    plaid_url = urlsplit(str(runtime.get("plaid_webhook_url") or "").strip())
    plaid_status = (
        "valid"
        if (
            plaid_url.scheme == origin.scheme
            and plaid_url.netloc == origin.netloc
            and plaid_url.path == "/api/kai/plaid/webhook"
            and not plaid_url.query
            and not plaid_url.fragment
        )
        else "mismatch"
    )
    statuses = (cors_status, passkey_status, plaid_status)
    return {
        "status": "valid" if all(status == "valid" for status in statuses) else "mismatch",
        "cors": cors_status,
        "passkeys": passkey_status,
        "plaid_webhook": plaid_status,
    }


def _firebase_project_contract(project: str) -> dict[str, str]:
    """Prove Firebase Admin and public client configuration target one project.

    The Admin credential itself is never rendered. This only compares its
    in-memory ``project_id`` claim with the public Firebase project setting and
    reports a stable status. It prevents custom-token issuer/audience drift
    that otherwise appears only as a native sign-in failure.
    """

    credentials_raw = _read_secret_value(project, "FIREBASE_ADMIN_CREDENTIALS_JSON")
    client_project = _read_secret_value(project, "NEXT_PUBLIC_FIREBASE_PROJECT_ID")
    if not credentials_raw or not client_project:
        return {"status": "unavailable", "credentials": "unavailable"}

    try:
        credentials = json.loads(credentials_raw)
    except json.JSONDecodeError:
        credentials = None
    if not isinstance(credentials, dict):
        return {"status": "invalid_credentials", "credentials": "invalid"}

    admin_project = str(credentials.get("project_id") or "").strip()
    if not admin_project:
        return {"status": "invalid_credentials", "credentials": "invalid"}

    return {
        "status": "valid" if admin_project == client_project.strip() else "mismatch",
        "credentials": "valid" if admin_project == client_project.strip() else "mismatch",
    }


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


def _describe_run_revision(project: str, region: str, revision: str) -> dict[str, Any] | None:
    cmd = [
        "gcloud",
        "run",
        "revisions",
        "describe",
        revision,
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


def _active_revision_names(service_json: dict[str, Any] | None) -> list[str]:
    if not isinstance(service_json, dict):
        return []
    names: list[str] = []
    for item in service_json.get("status", {}).get("traffic", []) or []:
        if not isinstance(item, dict) or int(item.get("percent") or 0) <= 0:
            continue
        revision_name = str(item.get("revisionName") or "").strip()
        if revision_name and revision_name not in names:
            names.append(revision_name)
    if names:
        return names
    latest = str(service_json.get("status", {}).get("latestReadyRevisionName") or "").strip()
    return [latest] if latest else []


def _container_env_map(service_json: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not isinstance(service_json, dict):
        return {}
    # Cloud Run Service objects contain a revision template, while the
    # Cloud Run Revision objects fetched for a no-traffic candidate put the
    # container directly at ``spec.containers``. Candidate validation must
    # inspect that second shape before traffic is promoted.
    containers = (
        service_json.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [])
    )
    if not containers:
        containers = service_json.get("spec", {}).get("containers", [])
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


def _serving_container_env_map(
    project: str, region: str, service_json: dict[str, Any] | None
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    revisions = _active_revision_names(service_json)
    env_maps = [
        _container_env_map(_describe_run_revision(project, region, revision))
        for revision in revisions
    ]
    env_maps = [env_map for env_map in env_maps if env_map]
    if not env_maps:
        return _container_env_map(service_json), revisions
    if len(env_maps) == 1:
        return env_maps[0], revisions

    # Multiple live revisions are acceptable only when every serving revision
    # exposes the same required source. Keep the common subset so missing keys
    # on any traffic-bearing revision fail the runtime contract.
    common_keys = set(env_maps[0])
    for env_map in env_maps[1:]:
        common_keys &= set(env_map)
    common: dict[str, dict[str, Any]] = {}
    for key in common_keys:
        labels = {_runtime_source_label(env_map[key]) for env_map in env_maps}
        if len(labels) == 1:
            common[key] = env_maps[0][key]
    return common, revisions


def _selected_container_env_map(
    project: str,
    region: str,
    service: str,
    service_json: dict[str, Any] | None,
    revision: str | None,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    selected_revision = str(revision or "").strip()
    if not selected_revision:
        return _serving_container_env_map(project, region, service_json)

    revision_json = _describe_run_revision(project, region, selected_revision)
    revision_service = str(
        (revision_json or {})
        .get("metadata", {})
        .get("labels", {})
        .get("serving.knative.dev/service", "")
    ).strip()
    if revision_service != service:
        return {}, [selected_revision]
    return _container_env_map(revision_json), [selected_revision]


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


def _literal_runtime_value(
    env_map: dict[str, dict[str, Any]], key: str
) -> str:
    entry = env_map.get(key)
    if not isinstance(entry, dict) or isinstance(entry.get("valueFrom"), dict):
        return ""
    return str(entry.get("value") or "").strip()


def _one_email_runtime_semantics(
    env_map: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Validate public One mailbox routing values without rendering secrets."""

    mailbox = _literal_runtime_value(env_map, "ONE_EMAIL_ADDRESS").lower()
    delegated_user = _literal_runtime_value(
        env_map, "ONE_EMAIL_DELEGATED_USER"
    ).lower()
    topic = _literal_runtime_value(env_map, "ONE_EMAIL_PUBSUB_TOPIC")
    audience = urlsplit(
        _literal_runtime_value(env_map, "ONE_EMAIL_WEBHOOK_AUDIENCE")
    )
    webhook_service_account = _literal_runtime_value(
        env_map, "ONE_EMAIL_WEBHOOK_SERVICE_ACCOUNT_EMAIL"
    ).lower()
    checks = {
        "mailbox": mailbox == "one@hushh.ai",
        "delegated_user": delegated_user == "one@hushh.ai",
        "pubsub_topic": (
            topic.startswith("projects/") and "/topics/" in topic
        ),
        "webhook_audience": (
            audience.scheme == "https"
            and bool(audience.netloc)
            and audience.path == "/api/one/email/webhook"
            and not audience.query
            and not audience.fragment
        ),
        "webhook_service_account": webhook_service_account.endswith(
            ".iam.gserviceaccount.com"
        ),
        "webhook_auth": _literal_runtime_value(
            env_map, "ONE_EMAIL_WEBHOOK_AUTH_ENABLED"
        ).lower()
        == "true",
        "watch_renew_auth": _literal_runtime_value(
            env_map, "ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED"
        ).lower()
        == "true",
        "default_scope": _literal_runtime_value(
            env_map, "ONE_EMAIL_KYC_DEFAULT_SCOPE"
        )
        == "attr.identity.*",
        "strict_client_zk": _literal_runtime_value(
            env_map, "ONE_EMAIL_KYC_STRICT_CLIENT_ZK_ENABLED"
        ).lower()
        == "true",
    }
    return {
        "status": "valid" if all(checks.values()) else "mismatch",
        "checks": {
            key: "valid" if value else "mismatch"
            for key, value in checks.items()
        },
    }


def _parity_targets(
    backend_revision: str | None, frontend_revision: str | None
) -> tuple[bool, bool]:
    """Select only the candidate surface(s) for a scoped release.

    Legacy callers do not provide candidate revisions and intentionally retain
    full-stack parity. A scoped release does provide the no-traffic revision it
    is about to promote, so validating an untouched service would turn stale,
    unrelated configuration into a false pre-traffic blocker.
    """

    checks_backend = bool(str(backend_revision or "").strip())
    checks_frontend = bool(str(frontend_revision or "").strip())
    if checks_backend or checks_frontend:
        return checks_backend, checks_frontend
    return True, True


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
        "--backend-revision",
        help="Optional exact no-traffic backend candidate revision to inspect.",
    )
    parser.add_argument(
        "--frontend-revision",
        help="Optional exact no-traffic frontend candidate revision to inspect.",
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
        "--require-one-email",
        action="store_true",
        help="Also require One mailbox/KYC runtime env and secrets.",
    )
    parser.add_argument(
        "--require-voice",
        action="store_true",
        help="Also require backend voice runtime secrets for voice parity.",
    )
    parser.add_argument(
        "--require-connected-systems",
        action="store_true",
        help=(
            "Also require Omni Gateway credentials for the database-backed "
            "Connected Systems CRM registry."
        ),
    )
    parser.add_argument(
        "--require-reviewer-smoke",
        action="store_true",
        help="Also require non-production reviewer smoke secrets on the backend runtime.",
    )
    parser.add_argument(
        "--require-prod-phone-test",
        action="store_true",
        help="Also require production fixed-code phone-test secrets on the backend runtime.",
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

    checks_backend, checks_frontend = _parity_targets(
        args.backend_revision, args.frontend_revision
    )

    required = list(BACKEND_REQUIRED if checks_backend else ())
    if checks_frontend:
        required.extend(FRONTEND_REQUIRED)
    if checks_backend and args.require_plaid:
        required.extend(BACKEND_PLAID_REQUIRED)
    if checks_backend and args.require_market_data:
        required.extend(BACKEND_MARKET_REQUIRED)
    if checks_backend and args.require_gmail:
        required.extend(BACKEND_GMAIL_REQUIRED)
    if checks_backend and args.require_one_email:
        required.extend(BACKEND_ONE_EMAIL_SECRET_REQUIRED)
    if checks_backend and args.require_voice:
        required.extend(BACKEND_VOICE_REQUIRED)
    if checks_backend and args.require_connected_systems:
        required.extend(BACKEND_CONNECTED_SYSTEMS_REQUIRED)
    if checks_backend and args.require_reviewer_smoke:
        required.extend(BACKEND_REVIEWER_SMOKE_REQUIRED)
    if checks_backend and args.require_prod_phone_test:
        required.extend(BACKEND_PROD_PHONE_TEST_REQUIRED)
    if args.require_native_artifacts:
        required.extend(NATIVE_RELEASE_REQUIRED)
    required = tuple(dict.fromkeys(required))
    missing = [name for name in required if not _has_secret(args.project, name)]

    report: dict[str, Any] = {
        "project": args.project,
        "region": args.region,
        "backend_service": args.backend_service,
        "frontend_service": args.frontend_service,
        "backend_revision": args.backend_revision,
        "frontend_revision": args.frontend_revision,
        "targets": {"backend": checks_backend, "frontend": checks_frontend},
        "required": {
            "backend": list(BACKEND_REQUIRED) if checks_backend else [],
            "frontend": list(FRONTEND_REQUIRED) if checks_frontend else [],
            "gmail": list(BACKEND_GMAIL_REQUIRED)
            if checks_backend and args.require_gmail
            else [],
            "one_email": list(BACKEND_ONE_EMAIL_SECRET_REQUIRED)
            if checks_backend and args.require_one_email
            else [],
            "voice": list(BACKEND_VOICE_REQUIRED)
            if checks_backend and args.require_voice
            else [],
            "connected_systems": list(BACKEND_CONNECTED_SYSTEMS_REQUIRED)
            if checks_backend and args.require_connected_systems
            else [],
            "reviewer_smoke": list(BACKEND_REVIEWER_SMOKE_REQUIRED)
            if checks_backend and args.require_reviewer_smoke
            else [],
            "prod_phone_test": list(BACKEND_PROD_PHONE_TEST_REQUIRED)
            if checks_backend and args.require_prod_phone_test
            else [],
            "plaid": list(BACKEND_PLAID_REQUIRED)
            if checks_backend and args.require_plaid
            else [],
            "market": list(BACKEND_MARKET_REQUIRED)
            if checks_backend and args.require_market_data
            else [],
            "native_release": list(NATIVE_RELEASE_REQUIRED) if args.require_native_artifacts else [],
        },
        "missing_secrets": sorted(missing),
        "classifications": [],
        "runtime_contract": {
            "frontend": [],
            "backend": [],
            "backend_gmail": [],
            "backend_one_email": [],
            "backend_voice": [],
            "backend_reviewer_smoke": [],
        },
        "gmail_redirect_contract": {"status": "not_checked"},
        "domain_runtime_contract": {"status": "not_checked"},
        "firebase_project_contract": {"status": "not_checked"},
        "one_email_runtime_semantics": {"status": "not_checked"},
    }

    print(f"Project: {args.project}")
    print(f"Parity targets: backend={checks_backend}, frontend={checks_frontend}")
    if checks_backend:
        print(
            f"Required backend secrets ({len(BACKEND_REQUIRED)}): "
            f"{_format_names(BACKEND_REQUIRED)}"
        )
    if checks_backend and args.require_plaid:
        print(
            "Required Plaid backend secrets "
            f"({len(BACKEND_PLAID_REQUIRED)}): {_format_names(BACKEND_PLAID_REQUIRED)}"
        )
    if checks_backend and args.require_market_data:
        print(
            "Required market backend secrets "
            f"({len(BACKEND_MARKET_REQUIRED)}): {_format_names(BACKEND_MARKET_REQUIRED)}"
        )
    if checks_backend and args.require_gmail:
        print(
            "Required Gmail backend secrets "
            f"({len(BACKEND_GMAIL_REQUIRED)}): {_format_names(BACKEND_GMAIL_REQUIRED)}"
        )
    if checks_backend and args.require_one_email:
        print(
            "Required One email backend keys "
            f"({len(BACKEND_ONE_EMAIL_SECRET_REQUIRED)}): {_format_names(BACKEND_ONE_EMAIL_SECRET_REQUIRED)}"
        )
    if checks_backend and args.require_voice:
        print(
            "Required voice backend secrets "
            f"({len(BACKEND_VOICE_REQUIRED)}): {_format_names(BACKEND_VOICE_REQUIRED)}"
        )
    if checks_backend and args.require_connected_systems:
        print(
            "Required Connected Systems backend secrets "
            f"({len(BACKEND_CONNECTED_SYSTEMS_REQUIRED)}): "
            f"{_format_names(BACKEND_CONNECTED_SYSTEMS_REQUIRED)}"
        )
    if checks_backend and args.require_reviewer_smoke:
        print(
            "Required reviewer smoke backend secrets "
            f"({len(BACKEND_REVIEWER_SMOKE_REQUIRED)}): {_format_names(BACKEND_REVIEWER_SMOKE_REQUIRED)}"
        )
    if checks_backend and args.require_prod_phone_test:
        print(
            "Required production phone-test backend secrets "
            f"({len(BACKEND_PROD_PHONE_TEST_REQUIRED)}): {_format_names(BACKEND_PROD_PHONE_TEST_REQUIRED)}"
        )
    if checks_frontend:
        print(
            f"Required frontend secrets ({len(FRONTEND_REQUIRED)}): "
            f"{_format_names(FRONTEND_REQUIRED)}"
        )
    if args.require_native_artifacts:
        print(
            "Required native release secrets "
            f"({len(NATIVE_RELEASE_REQUIRED)}): {_format_names(NATIVE_RELEASE_REQUIRED)}"
        )

    if missing:
        report["classifications"].append("secret_missing")
        print(f"Missing secrets ({len(missing)}): {_format_names(missing)}")

    if checks_backend and args.require_gmail:
        gmail_redirect_contract = _gmail_redirect_contract(args.project)
        report["gmail_redirect_contract"] = gmail_redirect_contract
        print(f"Gmail OAuth redirect contract: {gmail_redirect_contract['status']}")
        if gmail_redirect_contract["status"] != "valid":
            report["classifications"].append("gmail_oauth_redirect_contract_failed")

    if checks_backend:
        domain_runtime_contract = _domain_runtime_contract(args.project)
        report["domain_runtime_contract"] = domain_runtime_contract
        print(f"Domain runtime contract: {domain_runtime_contract['status']}")
        if domain_runtime_contract["status"] != "valid":
            report["classifications"].append("domain_runtime_contract_failed")

    if checks_frontend:
        firebase_project_contract = _firebase_project_contract(args.project)
        report["firebase_project_contract"] = firebase_project_contract
        print(f"Firebase project contract: {firebase_project_contract['status']}")
        if firebase_project_contract["status"] != "valid":
            report["classifications"].append("firebase_project_contract_failed")

    if args.assert_runtime_env_contract:
        frontend_json = (
            _describe_run_service(args.project, args.region, args.frontend_service)
            if checks_frontend
            else None
        )
        backend_json = (
            _describe_run_service(args.project, args.region, args.backend_service)
            if checks_backend
            else None
        )
        frontend_env, frontend_revisions = ({}, [])
        if checks_frontend:
            frontend_env, frontend_revisions = _selected_container_env_map(
                args.project,
                args.region,
                args.frontend_service,
                frontend_json,
                args.frontend_revision,
            )
        backend_env, backend_revisions = ({}, [])
        if checks_backend:
            backend_env, backend_revisions = _selected_container_env_map(
                args.project,
                args.region,
                args.backend_service,
                backend_json,
                args.backend_revision,
            )

        frontend_entries = []
        if checks_frontend:
            frontend_entries = [
                _classify_runtime_key(
                    frontend_env,
                    key,
                    legacy_keys=LEGACY_FRONTEND_RUNTIME_MAP.get(key, tuple()),
                )
                for key in FRONTEND_RUNTIME_REQUIRED
            ]
        backend_entries = []
        if checks_backend:
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
        if checks_backend and args.require_gmail:
            backend_gmail_entries = [
                _classify_runtime_key(
                    backend_env,
                    key,
                    legacy_keys=LEGACY_BACKEND_RUNTIME_MAP.get(key, tuple()),
                )
                for key in BACKEND_GMAIL_REQUIRED
            ]
        backend_one_email_entries = []
        if checks_backend and args.require_one_email:
            backend_one_email_entries = [
                _classify_runtime_key(backend_env, key)
                for key in BACKEND_ONE_EMAIL_RUNTIME_REQUIRED
            ]
        backend_voice_entries = []
        if checks_backend and args.require_voice:
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
        backend_connected_systems_entries = []
        if checks_backend and args.require_connected_systems:
            backend_connected_systems_entries = [
                _classify_runtime_key(backend_env, key)
                for key in BACKEND_CONNECTED_SYSTEMS_RUNTIME_REQUIRED
            ]
        backend_reviewer_smoke_entries = []
        if checks_backend and args.require_reviewer_smoke:
            backend_reviewer_smoke_entries = [
                _classify_runtime_key(backend_env, key)
                for key in BACKEND_REVIEWER_SMOKE_REQUIRED
            ]

        report["runtime_contract"]["frontend"] = frontend_entries
        report["runtime_contract"]["backend"] = backend_entries
        report["runtime_contract"]["backend_gmail"] = backend_gmail_entries
        report["runtime_contract"]["backend_one_email"] = backend_one_email_entries
        report["runtime_contract"]["backend_voice"] = backend_voice_entries
        report["runtime_contract"]["backend_connected_systems"] = (
            backend_connected_systems_entries
        )
        report["runtime_contract"]["backend_reviewer_smoke"] = backend_reviewer_smoke_entries
        report["runtime_contract"]["frontend_serving_revisions"] = frontend_revisions
        report["runtime_contract"]["backend_serving_revisions"] = backend_revisions

        if checks_backend and args.require_one_email:
            one_email_runtime_semantics = _one_email_runtime_semantics(backend_env)
            report["one_email_runtime_semantics"] = one_email_runtime_semantics
            print(
                "One email runtime semantics: "
                f"{one_email_runtime_semantics['status']}"
            )
            if one_email_runtime_semantics["status"] != "valid":
                report["classifications"].append(
                    "one_email_runtime_semantics_failed"
                )

        runtime_classifications = []
        runtime_classifications.extend(_classifications_from_runtime_entries(frontend_entries))
        runtime_classifications.extend(_classifications_from_runtime_entries(backend_entries))
        runtime_classifications.extend(_classifications_from_runtime_entries(backend_gmail_entries))
        runtime_classifications.extend(
            _classifications_from_runtime_entries(backend_one_email_entries)
        )
        runtime_classifications.extend(_classifications_from_runtime_entries(backend_voice_entries))
        runtime_classifications.extend(
            _classifications_from_runtime_entries(backend_connected_systems_entries)
        )
        runtime_classifications.extend(
            _classifications_from_runtime_entries(backend_reviewer_smoke_entries)
        )
        report["classifications"].extend(runtime_classifications)

        if checks_frontend:
            print(_render_runtime_summary("Frontend runtime env contract", frontend_entries))
        if checks_backend:
            print(_render_runtime_summary("Backend runtime env contract", backend_entries))
        if checks_backend and args.require_gmail:
            print(_render_runtime_summary("Backend Gmail runtime env contract", backend_gmail_entries))
        if checks_backend and args.require_one_email:
            print(
                _render_runtime_summary(
                    "Backend One email runtime env contract",
                    backend_one_email_entries,
                )
            )
        if checks_backend and args.require_voice:
            print(_render_runtime_summary("Backend voice runtime env contract", backend_voice_entries))
        if checks_backend and args.require_connected_systems:
            print(
                _render_runtime_summary(
                    "Backend Connected Systems runtime env contract",
                    backend_connected_systems_entries,
                )
            )
        if checks_backend and args.require_reviewer_smoke:
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
                + backend_one_email_entries
                + backend_voice_entries
                + backend_connected_systems_entries
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
