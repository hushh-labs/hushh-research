#!/usr/bin/env python3
"""Sync canonical backend runtime secrets into GCP Secret Manager."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

REPO_ROOT = Path(__file__).resolve().parents[2]
UPSERT_SECRET_SCRIPT = REPO_ROOT / "scripts" / "ops" / "upsert_gcp_secret.py"
GMAIL_OAUTH_RETURN_PATH = "/profile/gmail/oauth/return"

LEGACY_SECRET_FALLBACKS: dict[str, tuple[str, ...]] = {
    "APP_SIGNING_KEY": ("APP_SIGNING_KEY", "SECRET_KEY"),
    "VAULT_DATA_KEY": ("VAULT_DATA_KEY", "VAULT_ENCRYPTION_KEY"),
    "APP_FRONTEND_ORIGIN": ("APP_FRONTEND_ORIGIN", "FRONTEND_URL"),
    "FIREBASE_ADMIN_CREDENTIALS_JSON": (
        "FIREBASE_ADMIN_CREDENTIALS_JSON",
        "FIREBASE_SERVICE_ACCOUNT_JSON",
    ),
    "GOOGLE_MAPS_API_KEY": ("GOOGLE_MAPS_API_KEY",),
    "PLAID_ACCESS_TOKEN_KEY": ("PLAID_ACCESS_TOKEN_KEY", "PLAID_TOKEN_ENCRYPTION_KEY"),
    "GMAIL_OAUTH_TOKEN_KEY": ("GMAIL_OAUTH_TOKEN_KEY", "GMAIL_TOKEN_ENCRYPTION_KEY"),
    "VOICE_RUNTIME_CONFIG_JSON": ("VOICE_RUNTIME_CONFIG_JSON",),
    "REVIEWER_UID": ("REVIEWER_UID", "UAT_SMOKE_USER_ID", "KAI_TEST_USER_ID"),
    "REVIEWER_VAULT_PASSPHRASE": (
        "REVIEWER_VAULT_PASSPHRASE",
        "UAT_SMOKE_PASSPHRASE",
        "KAI_TEST_PASSPHRASE",
        "HUSHH_REVIEWER_PASSPHRASE",
    ),
    # Pod durability roots. Both existed on dev ONLY because someone created them
    # by hand, and `append_optional_secret` skips a missing secret silently -- so
    # an environment rebuild would lose pod memory durability with no signal.
    # Syncing them here makes the durable-memory substrate part of the
    # reproducible environment, not tribal memory.
    "HUSSH_POD_KEY_MASTER": ("HUSSH_POD_KEY_MASTER",),
    "HUSSH_POD_DEV_SIGNING_KEY": ("HUSSH_POD_DEV_SIGNING_KEY",),
}


def _run(
    cmd: list[str], *, input_text: str | None = None, check: bool = True
) -> subprocess.CompletedProcess[str]:
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


def _gmail_oauth_redirect_uri(app_frontend_origin: str) -> str:
    parsed = urlsplit(app_frontend_origin.strip())
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError("--app-frontend-origin must be a canonical HTTP(S) origin")
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    return f"{origin}{GMAIL_OAUTH_RETURN_PATH}"


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
        "hushh_genai_auth_mode": "vertex_adc",
        "google_genai_use_vertexai": True,
        "google_cloud_project": args.project,
        "google_cloud_location": "global",
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
        "one_location_read_only_state_enabled": args.one_location_read_only_state_enabled,
        "one_location_nearby_presence_mode": args.one_location_nearby_presence_mode,
        "one_location_nearby_presence_cohort": args.one_location_nearby_presence_cohort,
        "consent_center_summary_v2_enabled": args.consent_center_summary_v2_enabled,
        "db_bulk_batching_enabled": args.db_bulk_batching_enabled,
        "hushh_trusted_device_enabled": args.hushh_trusted_device_enabled,
        "hushh_trusted_device_uat_allowlist": args.hushh_trusted_device_uat_allowlist,
        "advisors_api_base_url": args.advisors_api_base_url,
        "insurance_agents_api_base_url": args.insurance_agents_api_base_url,
        "nws_nearby_api_base_url": args.nws_nearby_api_base_url,
        "nws_nearby_v4_api_base_url": args.nws_nearby_v4_api_base_url,
        # The lane's own registered consumer identity upstream. Derived from the
        # deploy target rather than taken as a flag: a per-lane value with a
        # default is the shape that silently ships one lane's identity to
        # another, and a mismatch here is refused upstream as a project
        # mismatch — which reads like an outage, not a config error.
        "nws_nearby_v4_project_id": args.project,
        "one_places_directory_enabled": args.one_places_directory_enabled,
    }
    return _drop_empty(config)


# One NWS v4 credential per lane, because the upstream registry binds each key
# to exactly one consumer and one project. An unlisted lane resolves to blank,
# which skips the mirror and leaves the surface reporting "not set up" — the
# right answer for a lane with no registered consumer, and better than handing
# it another lane's identity.
_NWS_V4_KEY_SOURCE_BY_PROJECT: dict[str, str] = {
    "hushh-pda-uat": "nws-hushh-research-v4-api-key-uat",
    "hushh-pda": "nws-hushh-research-v4-api-key-prod",
}


def _mirror_directory_key(
    *,
    target_project: str,
    target_secret: str,
    source_project: str,
    source_secret: str,
) -> str | None:
    """Mirror a directory key from its home project into this lane.

    These keys live in one project and are consumed by several. Copying one by
    hand is exactly what broke UAT: the source rotated and disabled the old
    version, the hand-made copy did not follow, and the surface began answering
    502 with a revoked credential. Re-mirroring on every deploy bounds that
    drift to a single release instead of forever.

    A lane without read access to the source simply gets nothing, and the
    feature stays inert there rather than failing the deploy. That is a real
    state, not a theoretical one — read access is a per-secret grant in the home
    project and does not come with any lane's own project-level roles.
    """
    source_project = str(source_project or "").strip()
    source_secret = str(source_secret or "").strip()
    if not (source_project and source_secret):
        return None

    value = _read_secret(source_project, source_secret)
    if not value:
        return None

    if _read_secret(target_project, target_secret) == value:
        # The shared upsert helper adds a version unconditionally; skipping the
        # write keeps a no-op deploy from minting a secret version each time.
        return f"{target_secret} (unchanged)"

    _upsert_secret(target_project, target_secret, value)
    return f"{target_secret} (rotated)"


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
    parser.add_argument("--one-location-read-only-state-enabled", default="false")
    # Nearby check-in admission. Blank leaves the flow closed in production and
    # unchanged everywhere else; `_drop_empty` keeps an unset flag out of the
    # config entirely rather than writing an empty string the gate would have to
    # interpret. Opening production needs BOTH of these -- see the route gate.
    parser.add_argument("--one-location-nearby-presence-mode", default="")
    parser.add_argument("--one-location-nearby-presence-cohort", default="")
    parser.add_argument("--consent-center-summary-v2-enabled", default="false")
    parser.add_argument("--db-bulk-batching-enabled", default="false")
    parser.add_argument("--hushh-trusted-device-enabled", default="false")
    parser.add_argument("--hushh-trusted-device-uat-allowlist", default="")
    # Advisor directory base URL. Non-secret, so it belongs in the generated
    # runtime config rather than in the deploy step, which sits close to Cloud
    # Build's arg ceiling. Blank leaves it out entirely and the surface reports
    # unavailable; the bearer key is a real secret and is mounted separately.
    parser.add_argument("--advisors-api-base-url", default="")
    # The directory key is owned by one project and consumed by several, so it
    # is mirrored rather than copied by hand — see _sync_advisors_api_key.
    parser.add_argument("--advisors-api-key-source-project", default="hushh-tech-prod")
    parser.add_argument("--advisors-api-key-source-secret", default="brokercheck-api-key")
    # Insurance agent directory. Same split as the advisor directory directly
    # above: a non-secret base URL in the generated runtime config, and a bearer
    # key mirrored from the project that owns it.
    parser.add_argument("--insurance-agents-api-base-url", default="")
    parser.add_argument("--one-places-directory-enabled", default="")
    parser.add_argument(
        "--insurance-agents-api-key-source-project", default="hushh-tech-prod"
    )
    parser.add_argument(
        "--insurance-agents-api-key-source-secret", default="insurance-agents-api-key"
    )
    # NWS Nearby Intelligence. Same split again, with one deliberate difference:
    # the base URL carries a real default instead of "". There is exactly one
    # deployed NWS service and every lane calls it, so a blank default would
    # leave any lane whose workflow forgot the flag silently unconfigured while
    # the lane that remembered looked healthy. The two directories above are
    # per-lane and correctly default to blank; this one is not.
    parser.add_argument(
        "--nws-nearby-api-base-url",
        default="https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app",
    )
    parser.add_argument("--nws-nearby-api-key-source-project", default="hushh-tech-prod")
    parser.add_argument("--nws-nearby-api-key-source-secret", default="nws-nearby-api-key")
    # NWS v4 net-worth contract. Same single deployed service, so the base URL
    # carries a real default for the same reason as the v2 one above. The v4
    # credential is a per-consumer key rather than the shared service key, so it
    # is mirrored from its own source secret and never falls back to the v2 one:
    # presenting the v2 key to v4 is refused as invalid credentials, and sharing
    # one key across two consumers is exactly what the upstream registry exists
    # to prevent.
    parser.add_argument(
        "--nws-nearby-v4-api-base-url",
        default="https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app",
    )
    parser.add_argument("--nws-nearby-v4-api-key-source-project", default="hushh-tech-prod")
    # Blank by default and resolved from the lane below. Unlike the v2 key,
    # which is one shared service credential every lane may use, a v4 key is
    # bound in the upstream registry to a single consumer with a single
    # project. Mirroring one key into every lane would hand production UAT's
    # credential, and the upstream would refuse it as a project mismatch.
    parser.add_argument("--nws-nearby-v4-api-key-source-secret", default="")
    args = parser.parse_args()

    if not str(args.nws_nearby_v4_api_key_source_secret or "").strip():
        args.nws_nearby_v4_api_key_source_secret = _NWS_V4_KEY_SOURCE_BY_PROJECT.get(
            args.project, ""
        )

    sync_summary: list[str] = []

    for target_secret, source_project, source_secret in (
        (
            "ADVISORS_API_KEY",
            args.advisors_api_key_source_project,
            args.advisors_api_key_source_secret,
        ),
        (
            "INSURANCE_AGENTS_API_KEY",
            args.insurance_agents_api_key_source_project,
            args.insurance_agents_api_key_source_secret,
        ),
        (
            "NWS_NEARBY_API_KEY",
            args.nws_nearby_api_key_source_project,
            args.nws_nearby_api_key_source_secret,
        ),
        (
            "NWS_NEARBY_V4_API_KEY",
            args.nws_nearby_v4_api_key_source_project,
            args.nws_nearby_v4_api_key_source_secret,
        ),
    ):
        status = _mirror_directory_key(
            target_project=args.project,
            target_secret=target_secret,
            source_project=source_project,
            source_secret=source_secret,
        )
        if status:
            sync_summary.append(status)

    for canonical_name, fallback_names in LEGACY_SECRET_FALLBACKS.items():
        if canonical_name in {
            "APP_FRONTEND_ORIGIN",
            "BACKEND_RUNTIME_CONFIG_JSON",
            "VOICE_RUNTIME_CONFIG_JSON",
        }:
            continue
        value = _resolve_secret(args.project, fallback_names)
        if not value:
            continue
        _upsert_secret(args.project, canonical_name, value)
        sync_summary.append(canonical_name)

    _upsert_secret(args.project, "APP_FRONTEND_ORIGIN", args.app_frontend_origin.strip())
    sync_summary.append("APP_FRONTEND_ORIGIN")

    _upsert_secret(
        args.project,
        "GMAIL_OAUTH_REDIRECT_URI",
        _gmail_oauth_redirect_uri(args.app_frontend_origin),
    )
    sync_summary.append("GMAIL_OAUTH_REDIRECT_URI")

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
