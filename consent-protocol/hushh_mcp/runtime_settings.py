from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parents[1]
_DOTENV_PATH = _REPO_ROOT / ".env"
load_dotenv(_DOTENV_PATH, override=False)
# Local-only maintainer overlay. Developers keep the reviewer fixture
# (REVIEWER_UID / REVIEWER_VAULT_PASSPHRASE, hydrated from Secret Manager by
# bootstrap) and local toggles like APP_REVIEW_MODE in .env.local so agents can
# review app changes on localhost. This file is absent in deployed environments,
# so this is a no-op there; override=False keeps the canonical .env authoritative
# for any shared key.
load_dotenv(_REPO_ROOT / ".env.local", override=False)

APP_SIGNING_KEY_ENV = "APP_SIGNING_KEY"
VAULT_DATA_KEY_ENV = "VAULT_DATA_KEY"
# KMS envelope resolution (SC-12/SC-28): the DEKs above may instead be supplied as
# KMS-wrapped ciphertext + a KEK resource, unwrapped once at startup. Off by default.
APP_SIGNING_KEY_CIPHERTEXT_ENV = "APP_SIGNING_KEY_CIPHERTEXT"
VAULT_DATA_KEY_CIPHERTEXT_ENV = "VAULT_DATA_KEY_CIPHERTEXT"
KMS_KEK_RESOURCE_ENV = "KMS_KEK_RESOURCE"
# Connector-credential encryption password (PBKDF2 input) for the MuleSoft
# PBKDF2-AES256-CBC scheme. Separate trust domain from VAULT_DATA_KEY (user
# data). Falls back to VAULT_DATA_KEY until a dedicated key is provisioned.
CONNECTOR_SECRETS_KEY_ENV = "CONNECTOR_SECRETS_KEY"  # noqa: S105
# Constant KDF parameters for the MuleSoft PBKDF2-AES256-CBC connector scheme.
# These are identical across every MuleSoft-published CRM, so they live in config
# rather than being repeated on each registry row. A row MAY still override them
# (kdf_salt / kdf_iterations columns); config is the default when the row omits.
# The salt is not a secret; the derived key never leaves connector-key custody.
CONNECTOR_KDF_SALT_ENV = "CONNECTOR_KDF_SALT"
CONNECTOR_KDF_ITERATIONS_ENV = "CONNECTOR_KDF_ITERATIONS"
# Native FIPS default for MuleSoft JCE PBKDF2withHmacSHA256; overridable via env.
_CONNECTOR_KDF_ITERATIONS_DEFAULT = 65536
OMNIGATEWAY_CLIENT_ID_ENV = "OMNIGATEWAY_CLIENT_ID"
OMNIGATEWAY_CLIENT_SECRET_ENV = "OMNIGATEWAY_CLIENT_SECRET"  # noqa: S105
APP_FRONTEND_ORIGIN_ENV = "APP_FRONTEND_ORIGIN"
FIREBASE_ADMIN_CREDENTIALS_JSON_ENV = "FIREBASE_ADMIN_CREDENTIALS_JSON"
FIREBASE_SERVICE_ACCOUNT_JSON_ENV = "FIREBASE_SERVICE_ACCOUNT_JSON"
GMAIL_OAUTH_TOKEN_KEY_ENV = "GMAIL_OAUTH_TOKEN_KEY"  # noqa: S105
PLAID_ACCESS_TOKEN_KEY_ENV = "PLAID_ACCESS_TOKEN_KEY"  # noqa: S105
# Apple Wallet pass signing material. The three PEMs arrive as their own Cloud
# Run secret refs (never inside BACKEND_RUNTIME_CONFIG_JSON) and are read here so
# that no service reads them from the environment directly.
WALLET_PASS_CERT_PEM_ENV = "WALLET_PASS_CERT_PEM"  # noqa: S105
WALLET_PASS_KEY_PEM_ENV = "WALLET_PASS_KEY_PEM"  # noqa: S105
WALLET_PASS_WWDR_PEM_ENV = "WALLET_PASS_WWDR_PEM"  # noqa: S105
WALLET_PASS_TEAM_IDENTIFIER_ENV = "WALLET_PASS_TEAM_IDENTIFIER"  # noqa: S105
WALLET_PASS_TYPE_IDENTIFIER_ENV = "WALLET_PASS_TYPE_IDENTIFIER"  # noqa: S105
_WALLET_PASS_TYPE_IDENTIFIER_DEFAULT = "pass.com.hushh.app.one"  # noqa: S105

BACKEND_RUNTIME_CONFIG_JSON_ENV = "BACKEND_RUNTIME_CONFIG_JSON"
VOICE_RUNTIME_CONFIG_JSON_ENV = "VOICE_RUNTIME_CONFIG_JSON"

_BACKEND_RUNTIME_ENV_MAP: dict[str, str] = {
    "environment": "ENVIRONMENT",
    "hushh_genai_auth_mode": "HUSHH_GENAI_AUTH_MODE",
    "google_genai_use_vertexai": "GOOGLE_GENAI_USE_VERTEXAI",
    "google_cloud_project": "GOOGLE_CLOUD_PROJECT",
    "google_cloud_location": "GOOGLE_CLOUD_LOCATION",
    "hushh_vertex_locations": "HUSHH_VERTEX_LOCATIONS",
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
    "one_location_read_only_state_enabled": "ONE_LOCATION_READ_ONLY_STATE_ENABLED",
    "consent_center_summary_v2_enabled": "CONSENT_CENTER_SUMMARY_V2_ENABLED",
    "db_bulk_batching_enabled": "DB_BULK_BATCHING_ENABLED",
    "hushh_trusted_device_enabled": "HUSSH_TRUSTED_DEVICE_ENABLED",
    "hushh_trusted_device_uat_allowlist": "HUSSH_TRUSTED_DEVICE_UAT_ALLOWLIST",
    "one_wallet_card_enabled": "ONE_WALLET_CARD_ENABLED",
    "wallet_pass_team_identifier": "WALLET_PASS_TEAM_IDENTIFIER",
    "wallet_pass_type_identifier": "WALLET_PASS_TYPE_IDENTIFIER",
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
    google_maps_api_key: str
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
class WalletPassSettings:
    """Apple Wallet pass signing material and pass identifiers.

    Every PEM is ``repr=False`` so private key material can never surface in a
    log line, an exception repr or a traceback frame dump.
    """

    team_identifier: str
    pass_type_identifier: str
    cert_pem: str = field(repr=False, default="")
    key_pem: str = field(repr=False, default="")
    wwdr_pem: str = field(repr=False, default="")

    @property
    def is_complete(self) -> bool:
        """True only when every value needed to sign a pass is present."""
        return bool(
            self.team_identifier
            and self.pass_type_identifier
            and self.cert_pem
            and self.key_pem
            and self.wwdr_pem
        )


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


def get_connector_secrets_key() -> str:
    """Password for connector-credential PBKDF2-AES256-CBC encryption.

    Separate trust domain from user-data encryption. Falls back to
    VAULT_DATA_KEY during transition so existing deployments keep working
    (rows encrypted under the fallback key must remain decryptable);
    provision a dedicated CONNECTOR_SECRETS_KEY before production self-serve.
    The fallback is logged once per process so operators can see the merged
    trust domain and schedule the key split + re-encryption.
    """
    dedicated = _clean_env(CONNECTOR_SECRETS_KEY_ENV)
    if dedicated:
        return dedicated
    _warn_key_fallback_once(
        "connector_secrets_key",
        "CONNECTOR_SECRETS_KEY not set; falling back to VAULT_DATA_KEY. "
        "Connector credentials and user-data encryption currently share one "
        "key domain. Provision CONNECTOR_SECRETS_KEY and re-encrypt registry "
        "rows to separate the trust domains.",
    )
    return _clean_env(VAULT_DATA_KEY_ENV)


_KEY_FALLBACK_WARNED: set[str] = set()


def _warn_key_fallback_once(key: str, message: str) -> None:
    """Log a key-domain fallback warning once per process per key."""
    if key in _KEY_FALLBACK_WARNED:
        return
    _KEY_FALLBACK_WARNED.add(key)
    import logging

    logging.getLogger(__name__).warning(message)


def get_connector_kdf_salt() -> str:
    """Constant PBKDF2 salt for MuleSoft connector creds, from config.

    Identical across every MuleSoft-published CRM, so it is config rather than a
    per-row column. Returns "" if unset (a row-level kdf_salt then takes over).
    The salt is not a secret.
    """
    return _clean_env(CONNECTOR_KDF_SALT_ENV)


def get_connector_kdf_iterations() -> int:
    """Constant PBKDF2 iteration count for MuleSoft connector creds, from config.

    Falls back to the MuleSoft JCE-native default when unset/invalid.
    """
    raw = _clean_env(CONNECTOR_KDF_ITERATIONS_ENV)
    try:
        value = int(raw)
        return value if value > 0 else _CONNECTOR_KDF_ITERATIONS_DEFAULT
    except (TypeError, ValueError):
        return _CONNECTOR_KDF_ITERATIONS_DEFAULT


def get_omnigateway_transport_headers() -> tuple[tuple[str, str], ...]:
    """Client-ID-Enforcement headers for the MuleSoft OmniGateway transport.

    These authenticate Hushh to the gateway. They are separate from the
    encrypted CRM credentials stored in enterprise_crm_registry and forwarded to
    MuleSoft for CRM-side auth.
    """
    client_id = _clean_env(OMNIGATEWAY_CLIENT_ID_ENV)
    client_secret = _clean_env(OMNIGATEWAY_CLIENT_SECRET_ENV)
    headers: list[tuple[str, str]] = []
    if client_id:
        headers.append(("client_id", client_id))
    if client_secret:
        headers.append(("client_secret", client_secret))
    return tuple(headers)


def personal_agent_enabled() -> bool:
    """Kill-switch feature flag for the per-user personal-information agent.

    Master off-switch for the entire Phase 0 personal-agent surface (registry,
    HusshID minting, standing pkm.read issuance, pod keypair, prompt sync).
    Defaults OFF: nothing in that surface activates until this is explicitly
    turned on, and flipping it back to off disables the surface with no
    redeploy."""
    return _bool_from_value(_clean_env("PERSONAL_AGENT_ENABLED"), default=False)


def personal_agent_autoprovision_enabled() -> bool:
    """Fire a user's pod automatically once their phone is verified.

    OFF, the phone-verify seam stops where it always has: a ``pending`` registry
    row reserving the user's HusshID, and a pod only when the owner-authorized
    ``POST /api/one/personal-agent/provision`` is called. ON, that same seam
    continues straight through to :meth:`provision`, so every verified signup
    gets a host with no further interaction.

    Separate from ``PERSONAL_AGENT_ENABLED`` on purpose, and defaults OFF. The
    master flag opens the surface; this one decides whether verifying a phone
    *spends money*. A pod is a real billable host, and "every signup provisions"
    is exactly the shape that turns a load test into a bill -- so it must be a
    deliberate, separately-revocable act. ``PERSONAL_AGENT_MAX_PODS`` remains the
    ceiling underneath it, and is what actually bounds the spend.

    Intended for the dev environment while the flow is being proven end to end."""
    return _bool_from_value(_clean_env("PERSONAL_AGENT_AUTOPROVISION_ENABLED"), default=False)


def personal_agent_backend() -> str:
    """Selected compute backend for the per-user agent (see ``compute_backend``).

    The provider abstraction's selector: which host stands a user's agent up.
    Empty/unset (the default) resolves to the inert ``NullBackend`` -- so even with
    the kill-switch on, nothing calls out to a real host until a backend is both
    implemented and explicitly named here. Reserved values ('gcp', 'anypoint')
    land with their milestones (docs/future/personal-agent/ROADMAP.md M4/M7)."""
    return (_clean_env("PERSONAL_AGENT_BACKEND") or "").strip().lower()


# Dev-team-sized fleet ceiling. Deliberately small: every signed-in user gets a
# pod (founder decision), so the ceiling -- not an eligibility allowlist -- is the
# cost containment. See docs/future/personal-agent/DEV-LIVE-EXECUTION-PLAN.md B3.
_PERSONAL_AGENT_MAX_PODS_DEFAULT = 50


def personal_agent_max_pods() -> int:
    """Hard ceiling on how many personal-agent pods may exist at once.

    A pod is a real, billable host once ``PERSONAL_AGENT_BACKEND`` names a live
    backend, and every signed-in user gets one, so a runaway test loop is a
    runaway bill. Provisioning checks this BEFORE asking a backend to stand a host
    up; at the ceiling the registry row is left untouched (``pending``) and a
    ``personal_agent_provisioning_capped`` feed row is written instead of raising,
    because provisioning is fire-and-forget and an exception there would be an
    invisible, unretried break.

    Defaults to 50. Unset, blank, non-numeric, and non-positive all FAIL SAFE back
    to that default rather than to "unlimited": a typo in the environment must
    never silently remove the ceiling. There is deliberately no unlimited value --
    to raise the ceiling, raise the number."""
    value = _int_from_value(_clean_env("PERSONAL_AGENT_MAX_PODS"), _PERSONAL_AGENT_MAX_PODS_DEFAULT)
    return value if value > 0 else _PERSONAL_AGENT_MAX_PODS_DEFAULT


# 7 days. Long enough that a developer who steps away for a week keeps a warm pod,
# short enough that an abandoned pod is not billed indefinitely.
_POD_IDLE_REAP_HOURS_DEFAULT = 168


def pod_idle_reap_hours() -> int:
    """Hours of inactivity after which a provisioned pod's HOST is torn down.

    Fleet hygiene for the reconcile sweep
    (``personal_agent_reconcile_worker``). Reaping removes only the compute --
    the registry row, the HusshID, and the A2A address all survive, so the agent
    re-provisions on the owner's next activity. Nothing is lost; a cold start is
    paid instead of an idle warm floor.

    Defaults to 168 (7 days). Unset, blank, non-numeric, and non-positive all FAIL
    SAFE back to that default: a bad value must never collapse the threshold to
    zero and reap a live fleet."""
    value = _int_from_value(_clean_env("HUSSH_POD_IDLE_REAP_HOURS"), _POD_IDLE_REAP_HOURS_DEFAULT)
    return value if value > 0 else _POD_IDLE_REAP_HOURS_DEFAULT


# A warm pod is a PAID always-on instance, so its silence is a fault and should be
# noticed in minutes, not hours. 300s tolerates several missed 60s heartbeats plus a
# revision roll, which is the difference between "we are deploying" and "it is down".
_POD_HEARTBEAT_INTERVAL_SECONDS_DEFAULT = 60
_POD_WARM_STALE_SECONDS_DEFAULT = 300


def pod_heartbeat_interval_seconds() -> int:
    """How often a pod reports in to the hub.

    Read by the POD, not the hub. The hub's staleness threshold
    (:func:`pod_warm_stale_seconds`) must stay comfortably above this or every
    normal gap between beats reads as a fault; the default pair leaves room for
    four consecutive misses.

    Fails safe to 60 on unset/blank/non-numeric/non-positive. A zero here would be a
    tight loop hammering the hub from every pod in the fleet at once."""
    value = _int_from_value(
        _clean_env("HUSSH_POD_HEARTBEAT_INTERVAL_SECONDS"),
        _POD_HEARTBEAT_INTERVAL_SECONDS_DEFAULT,
    )
    return value if value > 0 else _POD_HEARTBEAT_INTERVAL_SECONDS_DEFAULT


def pod_warm_stale_seconds() -> int:
    """Silence after which a WARM pod is considered stale and worth probing.

    Applies to ``liveness_mode='warm'`` rows only. An economy (scale-to-zero) pod is
    SUPPOSED to be silent when idle, so this threshold is meaningless for it and the
    evaluator never applies it there -- see ``pod_liveness_service``.

    Fails safe to 300 on unset/blank/non-numeric/non-positive. A zero would mark the
    entire warm fleet stale on the first pass and trigger a fleet-wide probe."""
    value = _int_from_value(
        _clean_env("HUSSH_POD_WARM_STALE_SECONDS"), _POD_WARM_STALE_SECONDS_DEFAULT
    )
    return value if value > 0 else _POD_WARM_STALE_SECONDS_DEFAULT


def pod_native_grounding_enabled() -> bool:
    """Let a pod ground its agent from its OWN records instead of a client blob.

    Default **OFF**. Grounding is client-mediated today: the browser holds the vault
    key, decrypts holdings locally and posts them back per turn, so the hub never
    holds the key. That is a real zero-knowledge property, and switching sources
    changes what the agent is told -- which is not a change to make implicitly.

    The reason to turn it on is that the current path requires a browser with an
    unlocked vault, so a pod-hosted agent, the iOS shell, an A2A call and any
    proactive turn all reach the model knowing nothing about the person they serve.
    See ``pkm_grounding_service`` for the ephemeral-key refusal this switch implies."""
    return _bool_from_value(_clean_env("HUSSH_POD_NATIVE_GROUNDING_ENABLED"), default=False)


def provision_on_ai_connection() -> bool:
    """Provision a user's agent when their AI connection verifies, not when they log in.

    Default **ON**, because it is the correct trigger and the old one was actively
    wasteful: firing off phone-verify put a billable, warm, heartbeating Cloud Run
    service behind an event that says nothing about whether the agent could ever
    think. A user who verified a phone and never connected a model got a pod that
    answered nothing, forever, at full price.

    It is still inert until ``PERSONAL_AGENT_ENABLED`` is on, so flipping this alone
    provisions nothing. Set it to false only to fall back to the legacy phone-verify
    trigger -- the two are mutually exclusive by construction (see
    ``actor_identity_service.schedule_provision_personal_agent``), because running
    both would race two provisions for one user."""
    return _bool_from_value(_clean_env("PERSONAL_AGENT_PROVISION_ON_AI_CONNECTION"), default=True)


def pod_managed_model_enabled() -> bool:
    """Allow a pod to serve a turn on the FLEET's model identity instead of the owner's.

    Default **OFF**, and the default is the product position rather than caution.
    "Own your AI. Own your data. Own your compute." is not marketing here -- an agent
    that quietly bills its thinking to a shared account owns none of the three, and
    one heavy user would spend a pool everyone depends on.

    It also costs the isolation story. The pod service account holds ZERO project
    roles, which is precisely what makes a compromised pod uninteresting. Serving
    turns from a fleet Vertex identity means granting ``aiplatform.user`` to every
    pod in the fleet, spending that property permanently.

    So a pod uses the OWNER'S key, supplied per turn and never stored. Turning this
    on is a deliberate choice for a cohort that has no key of their own, not a
    fallback a pod reaches for on its own."""
    return _bool_from_value(_clean_env("HUSSH_POD_MANAGED_MODEL_ENABLED"), default=False)


def pod_turn_enabled() -> bool:
    """Let a POD serve an Agent One turn from its own process.

    Default **OFF**, and this is the switch that first makes a pod run the agent at
    all -- until it, no module mounted in a pod imported ``hushh_mcp.one_adk``, so a
    pod was a well-isolated shell with no agent in it.

    Checked together with ``pod_mode()``: on the hub the route must be absent, not
    merely disabled, because the hub already has a turn route and a second
    implementation of the same contract is free to drift from it."""
    return _bool_from_value(_clean_env("HUSSH_POD_TURN_ENABLED"), default=False)


def pod_autoheal_enabled() -> bool:
    """Kill-switch for auto-healing an unreachable pod by replacing its service.

    Default **OFF**, and independently of ``PERSONAL_AGENT_RECONCILE_ENABLED``,
    because healing MUTATES a live host: it rolls a new revision under someone's
    running agent. Detection and reporting are safe to run long before anyone is
    willing to let the fleet restart itself, so the two are separate switches and
    liveness evaluation stays useful with this off."""
    return _bool_from_value(_clean_env("HUSSH_POD_AUTOHEAL_ENABLED"), default=False)


def personal_agent_reconcile_enabled() -> bool:
    """Kill-switch for the personal-agent reconcile sweep (retry stalls, reap idle).

    Default **OFF**: the worker is never scheduled, and even an already-running
    loop goes inert on the next pass, so flipping this back to off stops the sweep
    with no redeploy. It is a second, independent switch on top of
    ``PERSONAL_AGENT_ENABLED`` because the sweep DELETES compute (idle reaping) --
    a destructive-to-hosts action that must be turned on deliberately, separately
    from turning the personal-agent surface on."""
    return _bool_from_value(_clean_env("PERSONAL_AGENT_RECONCILE_ENABLED"), default=False)


# Failed-pod count /health/ready tolerates before it calls the fleet degraded.
# Small on purpose: at dev fleet sizes (see _PERSONAL_AGENT_MAX_PODS_DEFAULT) a
# handful of wedged pods is already a signal, and the check is reported-only, so a
# false positive costs one string in a health body and never a rotation change.
_POD_FLEET_FAILED_THRESHOLD_DEFAULT = 5


def pod_fleet_health_signal_enabled() -> bool:
    """Kill-switch for the pod-fleet signal inside ``GET /health/ready``.

    Default **OFF**: the readiness body stays exactly what it is today --
    ``database`` and ``firebase_admin``, nothing else -- and the probe never reads
    the personal-agent registry. When **ON**, readiness ALSO reports a ``pod_fleet``
    check counting the per-user pods the fleet failed to stand up, so a broken fleet
    shows up in the check operators already watch instead of needing its own
    dashboard.

    The signal is observability only: reported, **never gating**. A fleet-wide pod
    failure must not simultaneously pull every control-plane instance out of
    rotation -- that turns a partial failure into a total one. ``api/routes/health.py``
    holds the fail-safe contract.

    Deliberately independent of ``PERSONAL_AGENT_ENABLED``: freezing new provisioning
    does not make the pods that are already broken stop mattering."""
    return _bool_from_value(_clean_env("POD_FLEET_HEALTH_SIGNAL_ENABLED"), default=False)


def pod_fleet_failed_threshold() -> int:
    """Failed-pod count ``/health/ready`` tolerates before it reports ``degraded``.

    Read only when ``pod_fleet_health_signal_enabled`` is on. A count at or below
    this reports ``ok``; strictly above it reports ``degraded``. ``0`` is a valid
    setting (report on the very first failure), which is why this fails safe on
    negative rather than on non-positive. Unset, blank, non-numeric, and negative
    all fall back to the default, so a typo cannot make the signal fire on every
    probe."""
    value = _int_from_value(
        _clean_env("POD_FLEET_FAILED_THRESHOLD"), _POD_FLEET_FAILED_THRESHOLD_DEFAULT
    )
    return value if value >= 0 else _POD_FLEET_FAILED_THRESHOLD_DEFAULT


def one_db_sessions_enabled() -> bool:
    """Feature flag: durable ADK ``DatabaseSessionService`` for One's runners.

    Default **OFF** -> ``InMemorySessionService`` (today's behavior: One's voice
    and text sessions are process-local, so a mid-conversation reconnect that
    lands on another worker starts with zero context). When **ON**, One's managed
    voice and text runners resolve a durable ``DatabaseSessionService`` on the
    existing Postgres so sessions survive worker changes -- the documented
    ``get_one_runner`` scale seam. Fail-safe: if the DB session service cannot be
    built the runner falls back to in-memory, so the live runtime degrades to
    today's behavior rather than failing to start. Gate the rollout on the
    voice-session write-load measurement the runner docstring calls for."""
    return _bool_from_value(_clean_env("ONE_DB_SESSIONS_ENABLED"), default=False)


def webauthn_enabled() -> bool:
    """Kill-switch for the server-side WebAuthn/FIDO2 ceremony (M14).

    Default **OFF**: the register/authenticate endpoints return 404 and no
    credential is verified or stored. When on, hussh performs real, server-verified
    passkey + hardware-key (Titan/YubiKey) ceremonies. Independent of the existing
    client-side vault-unlock PRF flow, which is unaffected either way."""
    return _bool_from_value(_clean_env("WEBAUTHN_ENABLED"), default=False)


def webauthn_mds_enabled() -> bool:
    """Kill-switch for FIDO Metadata Service (MDS) attestation verification (IA-2).

    Default **OFF**: a hardware key + user verification stays the honest
    ``AAL3-candidate``. When **ON**, an authenticator whose AAGUID is MDS-verified
    (FIDO-certified + uncompromised) elevates to real **AAL3**. Requires a
    provisioned, verified MDS extract at ``WEBAUTHN_MDS_BLOB_PATH``. See
    docs/reference/webauthn-aal3-mds.md."""
    return _bool_from_value(_clean_env("WEBAUTHN_MDS_ENABLED"), default=False)


def a2a_agent_card_enabled() -> bool:
    """Feature flag: serve the conformant A2A discovery card at
    ``/.well-known/agent-card.json``.

    Default **OFF** -> the standard well-known path returns 404 (today's contract).
    When **ON**, Agent One publishes a conformant A2A v1 AgentCard for external
    discovery / marketplace listing. Honest: the card declares the current HTTP+JSON
    invocation-preview transport via a capability extension, not full A2A v1 Tasks.
    See docs/reference/a2a-agent-card.md."""
    return _bool_from_value(_clean_env("A2A_AGENT_CARD_ENABLED"), default=False)


def pod_hub_identity_auth_enabled() -> bool:
    """Feature flag: let the hub accept a POD's Google ID token on the internal
    prompt-sync route, instead of a ``cap.agent.prompt.sync`` consent token.

    Default **OFF**, and the default is the security position rather than caution.
    Every pod runs as the SAME service account -- that is what lets that account hold
    no project roles -- so an ID token proves "a hussh pod is calling", never WHICH
    user's pod. Acceptance therefore rests on the pod's own asserted ``HUSSH_ID``,
    which is trustworthy exactly as far as the pod is. That matches the ``logical``
    tier's stated trust level and does NOT meet the bar for real users: turning this on
    where pods hold real holdings would let one compromised pod read another user's
    prompt. Cryptographic per-pod identity is the attested ``dedicated`` tier (M5).

    See ``docs/future/personal-agent/POD-HUB-DATA-PATH.md``.
    """
    return _bool_from_value(_clean_env("POD_HUB_IDENTITY_AUTH_ENABLED"), default=False)


def pod_hub_allowed_service_account() -> str:
    """The one service-account email whose ID tokens the hub will accept from a pod."""
    return _clean_env("POD_HUB_ALLOWED_SERVICE_ACCOUNT")


def pod_hub_expected_audience() -> str:
    """The audience a pod's ID token MUST carry for the hub to accept it.

    A pod mints its token audience-bound to the hub's base URL
    (``pod_hub_client._identity_token``), which is what stops that token being
    replayed against any other service. The hub has to check the other half: an
    unverified ``aud`` means a token the pod SA minted for a completely different
    audience is accepted here, and the whole decision collapses onto the email
    claim alone.

    Falls back to ``APP_FRONTEND_ORIGIN``-style hub self-knowledge only if
    explicitly configured; unset means REFUSE, because guessing an audience is the
    same as not checking one."""
    return _clean_env("POD_HUB_EXPECTED_AUDIENCE")


def pod_mode() -> bool:
    """Whether this process is a per-user personal-agent **pod** (not the fleet hub).

    Default **OFF** -> today's behavior: the process runs every fleet-wide
    background worker (the consent NOTIFY->FCM listener, the Gmail catch-up/watch
    renewal loop, and the consent-revocation sweep). Those workers are singletons
    of the shared control plane; a per-user pod must NOT run them, or a fleet of
    pods would each duplicate pushes, watch renewals, and revocation sweeps against
    shared state.

    When **ON** (``HUSSH_POD_MODE=1``, set by the pod deploy config), the process
    still serves the full agent runtime + HTTP surface (Agent One orchestrating its
    specialists, the A2A endpoint, health) and keeps its own DB pool + in-memory
    warmups, but SKIPS the fleet-wide workers. This is the runtime half of the pod
    architecture (the deploy half is ``GcpBackend.render_deploy_config``)."""
    return _bool_from_value(_clean_env("HUSSH_POD_MODE"), default=False)


def pod_agent_memory_enabled() -> bool:
    """Kill-switch for per-pod agent memory (AGENTS.md, Agent Architecture Doctrine 1).

    Default **OFF**: every ADK ``Runner`` is built with ``memory_service=None``, exactly as
    today, and the agent remembers nothing between turns beyond session state.

    When **ON** *and* the process is a pod (``HUSSH_POD_MODE``), Private Agent One gets its
    own ``PodMemoryService`` — conversation, learned preference, and working context sealed
    under the pod's own key and scoped to the single owner that pod serves. It is never
    enabled in the shared multi-tenant hub: memory there would be cross-tenant leakage,
    which is why the doctrine keeps the hub dumb by default and why
    ``resolve_pod_memory_service`` checks ``pod_mode()`` before this flag.

    Memory is the agent-experience layer, not an information authority: PKM remains the
    zero-knowledge system of record. See docs/future/personal-agent/ARCHITECTURE.md §7a."""
    return _bool_from_value(_clean_env("POD_AGENT_MEMORY_ENABLED"), default=False)


def crm_registry_db_enabled() -> bool:
    """Feature flag: resolve Connected Systems from the DB-backed enterprise CRM
    registry (decrypting credentials with VAULT_DATA_KEY) instead of the
    hardcoded in-code definition. Defaults off until cutover."""
    return _bool_from_value(_clean_env("CRM_REGISTRY_DB_ENABLED"), default=False)


def consent_audit_chain_enabled() -> bool:
    """Kill-switch for the tamper-evident consent-audit receipt chain (AU-9/AU-10).

    Default **OFF**: consent events are written to ``consent_audit`` exactly as
    today; no receipt chain is computed or stored, and the write path is
    byte-for-byte unchanged. When **ON**, every consent event (grant/deny/revoke/
    request) is ALSO mirrored, fail-safe, into an append-only per-subject
    hash-chained + HMAC-signed ledger (``consent_audit_receipts``, migration 904)
    that ``verify_chain`` can replay to detect any dropped, reordered, or tampered
    event -- the FedRAMP-High / NIST 800-53 AU-9 (audit protection) + AU-10
    (non-repudiation) posture. The mirror never blocks the operational consent
    write: a chain-append failure is logged for reconcile and shows up as a gap
    ``verify_chain`` flags, rather than failing the consent event."""
    return _bool_from_value(_clean_env("CONSENT_AUDIT_CHAIN_ENABLED"), default=False)


def kms_key_resolution_enabled() -> bool:
    """Feature flag: resolve APP_SIGNING_KEY / VAULT_DATA_KEY by KMS envelope-
    decryption (SC-12/SC-28) instead of a plaintext env var.

    Default **OFF** -> the plaintext env var, byte-for-byte as today. When **ON**,
    each DEK is stored only as KMS-wrapped ciphertext (`*_CIPHERTEXT`) and unwrapped
    once at startup via the KEK named in `KMS_KEK_RESOURCE`; the hot path
    (HMAC/AES on the in-memory DEK) is unchanged. Enabling also requires the
    `google-cloud-kms` dependency (lazy-imported). See
    docs/reference/kms-key-custody.md."""
    return _bool_from_value(_clean_env("KMS_KEY_RESOLUTION_ENABLED"), default=False)


def kms_key_resolution_strict() -> bool:
    """Fail-closed toggle for KMS key resolution.

    Default **OFF** (fail-safe, dev): on a KMS misconfiguration or unwrap failure
    the resolver falls back to the plaintext env var with a warning, so enabling
    the flag cannot brick startup. When **ON** (production): startup fails closed
    rather than run on a fallback key."""
    return _bool_from_value(_clean_env("KMS_KEY_RESOLUTION_STRICT"), default=False)


def kai_analyze_durable_run_store_enabled() -> bool:
    """Feature flag: persist a coarse terminal checkpoint for resumable Kai
    analyze ("debate") runs to Postgres so a /stream request that lands on a
    different Cloud Run instance can replay the final DecisionCard instead of
    404ing (the multi-instance prod-parity bug). Defaults off; when off the
    run manager behaves exactly as before with zero durable-store I/O."""
    return _bool_from_value(_clean_env("KAI_ANALYZE_DURABLE_RUN_STORE"), default=False)


def one_wallet_card_enabled() -> bool:
    """Feature flag: expose the Wallet Profile plane — the ``one_wallet_cards``
    table, the ``/api/one/wallet-card`` owner routes and the two unauthenticated
    public surfaces (card resolve and the signed ``.pkpass`` download). Defaults
    off; while off every wallet-card route answers as if the feature did not
    exist and no card is ever resolved."""
    return _bool_from_value(_clean_env("ONE_WALLET_CARD_ENABLED"), default=False)


def get_wallet_pass_settings() -> WalletPassSettings:
    """Signing material for Apple Wallet ``.pkpass`` generation.

    Deliberately uncached: the PEMs are Cloud Run secret refs, so reading them
    per pass download keeps a rotated certificate live without a redeploy.
    Missing material yields empty strings, which makes ``is_complete`` False and
    lets the route degrade to the friendly 503 copy instead of raising.
    """
    return WalletPassSettings(
        team_identifier=_clean_env(WALLET_PASS_TEAM_IDENTIFIER_ENV) or "",
        pass_type_identifier=(
            _clean_env(WALLET_PASS_TYPE_IDENTIFIER_ENV) or _WALLET_PASS_TYPE_IDENTIFIER_DEFAULT
        ),
        cert_pem=_clean_env(WALLET_PASS_CERT_PEM_ENV) or "",
        key_pem=_clean_env(WALLET_PASS_KEY_PEM_ENV) or "",
        wwdr_pem=_clean_env(WALLET_PASS_WWDR_PEM_ENV) or "",
    )


@lru_cache(maxsize=1)
def get_core_security_settings() -> CoreSecuritySettings:
    # KMS envelope resolution (SC-12 / SC-28): unwrap each DEK from KMS-wrapped
    # ciphertext when enabled; otherwise the plaintext env var, unchanged.
    from hushh_mcp.kms_key_resolver import resolve_key

    _kms_enabled = kms_key_resolution_enabled()
    _kms_strict = kms_key_resolution_strict()
    _kek = _clean_env(KMS_KEK_RESOURCE_ENV)

    app_signing_key = resolve_key(
        label=APP_SIGNING_KEY_ENV,
        plaintext=_clean_env(APP_SIGNING_KEY_ENV),
        wrapped_b64=_clean_env(APP_SIGNING_KEY_CIPHERTEXT_ENV),
        kek_resource=_kek,
        enabled=_kms_enabled,
        strict=_kms_strict,
    )
    if not app_signing_key or len(app_signing_key) < 32:
        raise ValueError(
            f"❌ {APP_SIGNING_KEY_ENV} must be set in .env and at least 32 characters long"
        )

    vault_data_key = resolve_key(
        label=VAULT_DATA_KEY_ENV,
        plaintext=_clean_env(VAULT_DATA_KEY_ENV),
        wrapped_b64=_clean_env(VAULT_DATA_KEY_CIPHERTEXT_ENV),
        kek_resource=_kek,
        enabled=_kms_enabled,
        strict=_kms_strict,
    )
    if not vault_data_key or len(vault_data_key) != 64:
        if pod_mode():
            # A pod mounts a bounded router allowlist and performs NO vault crypto:
            # every consumer of this key (agent chat, CRM connector secrets, the
            # nearby-presence HKDF) is hub-only. Requiring the key here anyway forced
            # every pod to be handed a vault key it never uses -- one more secret per
            # pod whose only function was satisfying an eager validator. In pod mode
            # the key is therefore allowed to be absent. It resolves to "" so any
            # accidental use fails LOUDLY at the call site (bytes.fromhex("") yields
            # an empty key every AEAD/HKDF constructor rejects), never silently with
            # a weak key. The hub path below is unchanged and still refuses to boot.
            logging.getLogger(__name__).info(
                "core_security.vault_data_key_absent pod_mode=1 -- vault crypto is "
                "unavailable in this process by design"
            )
            vault_data_key = ""
        else:
            raise ValueError(
                f"❌ {VAULT_DATA_KEY_ENV} must be a 64-character hex string (256-bit AES key)"
            )

    return CoreSecuritySettings(
        app_signing_key=app_signing_key,
        vault_data_key=vault_data_key,
        google_api_key=_clean_env("GOOGLE_API_KEY"),
        google_maps_api_key=_clean_env("GOOGLE_MAPS_API_KEY"),
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
