#!/usr/bin/env python3
"""Sync canonical backend runtime secrets into GCP Secret Manager."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
UPSERT_SECRET_SCRIPT = REPO_ROOT / "scripts" / "ops" / "upsert_gcp_secret.py"

LEGACY_SECRET_FALLBACKS: dict[str, tuple[str, ...]] = {
    "APP_SIGNING_KEY": ("APP_SIGNING_KEY", "SECRET_KEY"),
    "VAULT_DATA_KEY": ("VAULT_DATA_KEY", "VAULT_ENCRYPTION_KEY"),
    "APP_FRONTEND_ORIGIN": ("APP_FRONTEND_ORIGIN", "FRONTEND_URL"),
    "FIREBASE_ADMIN_CREDENTIALS_JSON": (
        "FIREBASE_ADMIN_CREDENTIALS_JSON",
        "FIREBASE_SERVICE_ACCOUNT_JSON",
    ),
    "PLAID_ACCESS_TOKEN_KEY": ("PLAID_ACCESS_TOKEN_KEY", "PLAID_TOKEN_ENCRYPTION_KEY"),
    "GMAIL_OAUTH_TOKEN_KEY": ("GMAIL_OAUTH_TOKEN_KEY", "GMAIL_TOKEN_ENCRYPTION_KEY"),
    "VOICE_RUNTIME_CONFIG_JSON": ("VOICE_RUNTIME_CONFIG_JSON",),
}


def _run(cmd: list[str], *, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        input=input_text,
        text=True,
        capture_output=True,
    )
    if check and result.returncode != 0:
        sys.stderr.write(result.stderr or result.stdout)
        raise SystemExit(result.returncode)
    return result


def _secret_exists(project: str, secret: str) -> bool:
    result = _run(
        [
            "gcloud",
            "secrets",
            "describe",
            secret,
            "--project",
            project,
            "--format=value(name)",
        ],
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def _read_secret(project: str, secret: str) -> str:
    result = _run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            secret,
            "--project",
            project,
        ],
        check=False,
    )
    if result.returncode != 0:
        return ""
    return (result.stdout or "").strip()


def _resolve_secret(project: str, names: tuple[str, ...]) -> str:
    for name in names:
        value = _read_secret(project, name)
        if value:
            return value
    return ""


def _bool_or_none(value: str) -> bool | None:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    if raw in {"1", "true", "yes", "on", "enabled"}:
        return True
    if raw in {"0", "false", "no", "off", "disabled"}:
        return False
    return None


def _int_or_none(value: str) -> int | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _csv_or_none(value: str) -> list[str] | None:
    raw = [item.strip() for item in str(value or "").split(",") if item.strip()]
    return raw or None


def _drop_empty(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item not in ("", None, [], {})}


def _read_voice_config(project: str) -> dict[str, Any]:
    existing_raw = _resolve_secret(project, LEGACY_SECRET_FALLBACKS["VOICE_RUNTIME_CONFIG_JSON"])
    if not existing_raw:
        return {}
    try:
        parsed = json.loads(existing_raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return _drop_empty(dict(parsed))


def _build_backend_runtime_config(args: argparse.Namespace) -> dict[str, Any]:
    config: dict[str, Any] = {
        "environment": args.environment,
        "google_genai_use_vertexai": True,
        "db_host": args.db_host,
        "db_port": args.db_port,
        "db_name": args.db_name,
        "db_unix_socket": args.db_unix_socket,
        "cloudsql_instance_connection_name": args.cloudsql_instance_connection_name,
        "consent_sse_enabled": args.consent_sse_enabled,
        "sync_remote_enabled": args.sync_remote_enabled,
        "developer_api_enabled": args.developer_api_enabled,
        "remote_mcp_enabled": args.remote_mcp_enabled,
        "cors_allowed_origins": args.cors_allowed_origins,
        "obs_data_stale_ratio_threshold": args.obs_data_stale_ratio_threshold,
        "passkey_allowed_rp_ids": args.passkey_allowed_rp_ids,
        "plaid_env": args.plaid_env,
        "plaid_client_name": args.plaid_client_name,
        "plaid_country_codes": args.plaid_country_codes,
        "plaid_webhook_url": args.plaid_webhook_url,
        "plaid_redirect_path": args.plaid_redirect_path,
        "plaid_redirect_uri": args.plaid_redirect_uri,
        "plaid_tx_history_days": args.plaid_tx_history_days,
    }
    return _drop_empty(config)


def _upsert_secret(project: str, secret: str, value: str) -> None:
    _run(
        [
            sys.executable,
            str(UPSERT_SECRET_SCRIPT),
            "--project",
            project,
            "--secret",
            secret,
            "--stdin",
        ],
        input_text=value,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--environment", required=True)
    parser.add_argument("--app-frontend-origin", required=True)
    parser.add_argument("--db-host", required=True)
    parser.add_argument("--db-port", required=True)
    parser.add_argument("--db-name", required=True)
    parser.add_argument("--db-unix-socket", default="")
    parser.add_argument("--cloudsql-instance-connection-name", default="")
    parser.add_argument("--consent-sse-enabled", required=True)
    parser.add_argument("--sync-remote-enabled", required=True)
    parser.add_argument("--developer-api-enabled", required=True)
    parser.add_argument("--remote-mcp-enabled", required=True)
    parser.add_argument("--cors-allowed-origins", required=True)
    parser.add_argument("--obs-data-stale-ratio-threshold", required=True)
    parser.add_argument("--passkey-allowed-rp-ids", default="")
    parser.add_argument("--plaid-env", default="")
    parser.add_argument("--plaid-client-name", default="")
    parser.add_argument("--plaid-country-codes", default="")
    parser.add_argument("--plaid-webhook-url", default="")
    parser.add_argument("--plaid-redirect-path", default="")
    parser.add_argument("--plaid-redirect-uri", default="")
    parser.add_argument("--plaid-tx-history-days", default="")
    args = parser.parse_args()

    sync_summary: list[str] = []

    for canonical_name, fallback_names in LEGACY_SECRET_FALLBACKS.items():
        if canonical_name in {"APP_FRONTEND_ORIGIN", "BACKEND_RUNTIME_CONFIG_JSON", "VOICE_RUNTIME_CONFIG_JSON"}:
            continue
        value = _resolve_secret(args.project, fallback_names)
        if not value:
            continue
        _upsert_secret(args.project, canonical_name, value)
        sync_summary.append(canonical_name)

    _upsert_secret(args.project, "APP_FRONTEND_ORIGIN", args.app_frontend_origin.strip())
    sync_summary.append("APP_FRONTEND_ORIGIN")

    backend_runtime_config = _build_backend_runtime_config(args)
    _upsert_secret(
        args.project,
        "BACKEND_RUNTIME_CONFIG_JSON",
        json.dumps(backend_runtime_config, separators=(",", ":"), sort_keys=True),
    )
    sync_summary.append("BACKEND_RUNTIME_CONFIG_JSON")

    voice_runtime_config = _read_voice_config(args.project)
    if voice_runtime_config:
        _upsert_secret(
            args.project,
            "VOICE_RUNTIME_CONFIG_JSON",
            json.dumps(voice_runtime_config, separators=(",", ":"), sort_keys=True),
        )
        sync_summary.append("VOICE_RUNTIME_CONFIG_JSON")

    print(
        json.dumps(
            {
                "project": args.project,
                "synced_secrets": sorted(set(sync_summary)),
                "backend_runtime_config_keys": sorted(backend_runtime_config.keys()),
                "voice_runtime_config_keys": sorted(voice_runtime_config.keys()),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
