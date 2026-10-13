from hushh_mcp.runtime_settings import (
    get_core_security_settings,
)

_SETTINGS = get_core_security_settings()

APP_SIGNING_KEY = _SETTINGS.app_signing_key
VAULT_DATA_KEY = _SETTINGS.vault_data_key
DEFAULT_CONSENT_TOKEN_EXPIRY_MS = _SETTINGS.default_consent_token_expiry_ms
DEFAULT_TRUST_LINK_EXPIRY_MS = _SETTINGS.default_trust_link_expiry_ms
ENVIRONMENT = _SETTINGS.environment
AGENT_ID = _SETTINGS.agent_id
HUSHH_HACKATHON = _SETTINGS.hushh_hackathon
GOOGLE_API_KEY = _SETTINGS.google_api_key or None

__all__ = [
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "DEFAULT_CONSENT_TOKEN_EXPIRY_MS",
    "DEFAULT_TRUST_LINK_EXPIRY_MS",
    "ENVIRONMENT",
    "AGENT_ID",
    "HUSHH_HACKATHON",
    "GOOGLE_API_KEY",
]
