from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parents[1]
_DOTENV_PATH = _REPO_ROOT / ".env"
load_dotenv(_DOTENV_PATH, override=False)

APP_SIGNING_KEY_ENV = "APP_SIGNING_KEY"
VAULT_DATA_KEY_ENV = "VAULT_DATA_KEY"
APP_FRONTEND_ORIGIN_ENV = "APP_FRONTEND_ORIGIN"
FIREBASE_ADMIN_CREDENTIALS_JSON_ENV = "FIREBASE_ADMIN_CREDENTIALS_JSON"
FIREBASE_SERVICE_ACCOUNT_JSON_ENV = "FIREBASE_SERVICE_ACCOUNT_JSON"
GMAIL_OAUTH_TOKEN_KEY_ENV = "GMAIL_OAUTH_TOKEN_KEY"  # noqa: S105
PLAID_ACCESS_TOKEN_KEY_ENV = "PLAID_ACCESS_TOKEN_KEY"  # noqa: S105
BACKEND_RUNTIME_CONFIG_JSON_ENV = "BACKEND_RUNTIME_CONFIG_JSON"
VOICE_RUNTIME_CONFIG_JSON_ENV = "VOICE_RUNTIME_CONFIG_JSON"

_BACKEND_RUNTIME_ENV_MAP: dict[str, str] = {
    "environment": "ENVIRONMENT",
    "google_genai_use_vertexai": "GOOGLE_GENAI_USE_VERTEXAI",
    "db_host": "DB_HOST",
    "db_port": "DB_PORT",
    "db_name": "DB_NAME",
    "db_unix_socket": "DB_UNIX_SOCKET",
    "cloudsql_instance_connection_name": "CLOUDSQL_INSTANCE_CONNECTION_NAME",
    "cloudsql_proxy_port": "CLOUDSQL_PROXY_PORT",
    "consent_sse_enabled": "CONSENT_SSE_ENABLED",
    "sync_remote_enabled": "SYNC_REMOTE_ENABLED",
    "developer_api_enabled": "DEVELOPER_API_ENABLED",
    "remote_mcp_enabled": "REMOTE_MCP_ENABLED",
    "cors_allowed_origins": "CORS_ALLOWED_ORIGINS",
    "obs_data_stale_ratio_threshold": "OBS_DATA_STALE_RATIO_THRESHOLD",
    "passkey_allowed_rp_ids": "PASSKEY_ALLOWED_RP_IDS",
    "plaid_env": "PLAID_ENV",
    "plaid_client_name": "PLAID_CLIENT_NAME",
    "plaid_country_codes": "PLAID_COUNTRY_CODES",
    "plaid_webhook_url": "PLAID_WEBHOOK_URL",
    "plaid_redirect_path": "PLAID_REDIRECT_PATH",
    "plaid_redirect_uri": "PLAID_REDIRECT_URI",
    "plaid_tx_history_days": "PLAID_TX_HISTORY_DAYS",
}


def _clean_env(name: str, default: str = "") -> str:
    return str(os.getenv(name, default) or "").strip()


def _bool_from_value(raw: Any, default: bool = False) -> bool:
    if raw is None:
        return default
    normalized = str(raw).strip().lower()
    if normalized in {"1", "true", "yes", "on", "enabled"}:
        return True
    if normalized in {"0", "false", "no", "off", "disabled"}:
        return False
    return default


def _int_from_value(raw: Any, default: int) -> int:
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return default


def _csv_list(raw: Any) -> tuple[str, ...]:
    if raw is None:
        return tuple()
    if isinstance(raw, list):
        return tuple(str(item).strip() for item in raw if str(item).strip())
    return tuple(item.strip() for item in str(raw).split(",") if item.strip())


def _json_object_from_env(name: str) -> dict[str, Any]:
    raw = _clean_env(name)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{name} must contain valid JSON") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{name} must contain a JSON object")
    return parsed


def _render_env_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return ",".join(str(item).strip() for item in value if str(item).strip())
    return str(value).strip()


def _normalize_origin(raw: str) -> str:
    value = str(raw or "").strip().rstrip("/")
    if not value:
        return ""
    parsed = urlparse(value)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return value


def hydrate_runtime_environment() -> None:
    config = _json_object_from_env(BACKEND_RUNTIME_CONFIG_JSON_ENV)
    for key, env_name in _BACKEND_RUNTIME_ENV_MAP.items():
        value = config.get(key)
        if value is None:
            continue
        rendered = _render_env_value(value)
        if rendered:
            os.environ.setdefault(env_name, rendered)


@dataclass(frozen=True)
class CoreSecuritySettings:
    app_signing_key: str
    vault_data_key: str
    google_api_key: str
    environment: str
    agent_id: str
    hushh_hackathon: bool
    default_consent_token_expiry_ms: int
    default_trust_link_expiry_ms: int


@dataclass(frozen=True)
class FirebaseCredentialSettings:
    admin_credentials_json: str


@dataclass(frozen=True)
class AppRuntimeSettings:
    environment: str
    app_frontend_origin: str


@dataclass(frozen=True)
class VoiceRuntimeSettings:
    realtime_enabled: bool
    hosted_voice_enabled: bool
    canary_percent: int
    tool_execution_disabled: bool
    allowed_users: tuple[str, ...]
    force_realtime: bool
    fail_fast: bool
    disable_fallbacks: bool
    realtime_model: str
    stt_models: tuple[str, ...]
    intent_models: tuple[str, ...]
    tts_models: tuple[str, ...]
    tts_default_voice: str
    tts_format: str
    tts_prefer_quality: bool


def get_optional_gmail_oauth_token_key() -> str:
    return _clean_env(GMAIL_OAUTH_TOKEN_KEY_ENV)


def get_optional_plaid_access_token_key() -> str:
    return _clean_env(PLAID_ACCESS_TOKEN_KEY_ENV)


@lru_cache(maxsize=1)
def get_core_security_settings() -> CoreSecuritySettings:
    app_signing_key = _clean_env(APP_SIGNING_KEY_ENV)
    if not app_signing_key or len(app_signing_key) < 32:
        raise ValueError(
            f"❌ {APP_SIGNING_KEY_ENV} must be set in .env and at least 32 characters long"
        )

    vault_data_key = _clean_env(VAULT_DATA_KEY_ENV)
    if not vault_data_key or len(vault_data_key) != 64:
        raise ValueError(
            f"❌ {VAULT_DATA_KEY_ENV} must be a 64-character hex string (256-bit AES key)"
        )

    return CoreSecuritySettings(
        app_signing_key=app_signing_key,
        vault_data_key=vault_data_key,
        google_api_key=_clean_env("GOOGLE_API_KEY"),
        environment=_clean_env("ENVIRONMENT", "development").lower() or "development",
        agent_id=_clean_env("AGENT_ID", "agent_hushh_default") or "agent_hushh_default",
        hushh_hackathon=_bool_from_value(_clean_env("HUSHH_HACKATHON"), default=False),
        default_consent_token_expiry_ms=_int_from_value(
            _clean_env("DEFAULT_CONSENT_TOKEN_EXPIRY_MS"), 1000 * 60 * 60 * 24 * 7
        ),
        default_trust_link_expiry_ms=_int_from_value(
            _clean_env("DEFAULT_TRUST_LINK_EXPIRY_MS"), 1000 * 60 * 60 * 24 * 30
        ),
    )


@lru_cache(maxsize=1)
def get_firebase_credential_settings() -> FirebaseCredentialSettings:
    admin_credentials_json = _clean_env(FIREBASE_ADMIN_CREDENTIALS_JSON_ENV) or _clean_env(
        FIREBASE_SERVICE_ACCOUNT_JSON_ENV
    )
    return FirebaseCredentialSettings(
        admin_credentials_json=admin_credentials_json,
    )


@lru_cache(maxsize=1)
def get_app_runtime_settings() -> AppRuntimeSettings:
    return AppRuntimeSettings(
        environment=_clean_env("ENVIRONMENT", "development").lower() or "development",
        app_frontend_origin=_normalize_origin(_clean_env(APP_FRONTEND_ORIGIN_ENV)),
    )


def get_voice_runtime_settings() -> VoiceRuntimeSettings:
    config = _json_object_from_env(VOICE_RUNTIME_CONFIG_JSON_ENV)

    force_realtime = _bool_from_value(config.get("force_realtime"), default=False)
    fail_fast = _bool_from_value(config.get("fail_fast"), default=False)
    disable_fallbacks = (
        _bool_from_value(config.get("disable_fallbacks"), default=False)
        or fail_fast
        or force_realtime
    )

    configured_tts_models = _csv_list(config.get("tts_models")) or ("gpt-4o-mini-tts",)
    tts_models: list[str] = []
    for candidate in ("gpt-4o-mini-tts", *configured_tts_models):
        normalized = str(candidate).strip()
        if normalized and normalized not in tts_models:
            tts_models.append(normalized)

    return VoiceRuntimeSettings(
        realtime_enabled=_bool_from_value(config.get("realtime_enabled"), default=True),
        hosted_voice_enabled=_bool_from_value(config.get("hosted_voice_enabled"), default=True),
        canary_percent=max(
            0,
            min(100, _int_from_value(config.get("canary_percent"), 100)),
        ),
        tool_execution_disabled=_bool_from_value(
            config.get("tool_execution_disabled"), default=False
        ),
        allowed_users=_csv_list(config.get("allowed_users")),
        force_realtime=force_realtime,
        fail_fast=fail_fast,
        disable_fallbacks=disable_fallbacks,
        realtime_model=str(config.get("realtime_model") or "gpt-realtime").strip()
        or "gpt-realtime",
        stt_models=_csv_list(config.get("stt_models")) or ("gpt-4o-mini-transcribe",),
        intent_models=_csv_list(config.get("intent_models"))
        or ("gpt-4.1-nano", "gpt-4o-mini", "gpt-4.1-mini"),
        tts_models=tuple(tts_models) or ("gpt-4o-mini-tts",),
        tts_default_voice=str(config.get("tts_default_voice") or "alloy").strip() or "alloy",
        tts_format=str(config.get("tts_format") or "mp3").strip() or "mp3",
        tts_prefer_quality=_bool_from_value(config.get("tts_prefer_quality"), default=False),
    )


def clear_runtime_settings_caches() -> None:
    get_core_security_settings.cache_clear()
    get_firebase_credential_settings.cache_clear()
    get_app_runtime_settings.cache_clear()


hydrate_runtime_environment()
