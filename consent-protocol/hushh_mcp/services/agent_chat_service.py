"""Gemini-backed Agent chat service with encrypted durable history."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, replace
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, AsyncGenerator, Awaitable, Callable, Literal
from uuid import uuid4

import yaml
from google.genai import errors as genai_errors
from google.genai import types as genai_types

from db.db_client import get_db
from hushh_mcp.hushh_adk.manifest import AgentModelConfig, ManifestLoader
from hushh_mcp.runtime_providers import (
    build_managed_runtime_client,
    build_runtime_client,
)
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.voice_action_manifest import get_voice_manifest_action
from hushh_mcp.types import EncryptedPayload
from hushh_mcp.vault.encrypt import decrypt_data, encrypt_data
from hussh_sdk import (
    ModelConfig,
    PKMCredentialResolver,
    prepare_runtime_credentials,
    runtime_config,
)

logger = logging.getLogger(__name__)

AGENT_CHAT_MODEL_ENV = "AGENT_GEMINI_MODEL"
DEFAULT_AGENT_CHAT_MODEL = "gemini-3.5-flash"
KAI_AGENT_MANIFEST_PATH = Path(__file__).resolve().parents[1] / "agents" / "kai" / "agent.yaml"
AGENT_SYSTEM_PROMPT = """You are One, the top personal agent inside Hussh.

You hold the relationship layer with the user, clarify intent, and delegate specialist work (finance to Kai, privacy to Nav, identity/KYC to KYC). Until a specialist surface is engaged, answer directly within the capability boundary below.

Current capability boundary:
- Focus on markets, portfolio context, stock analysis, Kai workflows, consent/privacy surfaces, and how the Hussh app works.
- Use the provided PKM context when it is relevant, especially when the user asks what Kai knows about them or shares preferences.
- The PKM context may contain decrypted session-only details supplied by the frontend after vault unlock. Treat it as user-authorized memory for this turn, not as exhaustive truth. Do not invent personal facts outside that context and the current conversation.
- If PKM context is present and the user asks to show, summarize, or reason over PKM, answer from that context. Do not claim One cannot access PKM.
- When the user explicitly asks to save, remember, or add durable personal context to PKM, use the frontend PKM tool. Do not say One cannot save to PKM.
- Normal finance and app questions should be answered as streaming text. Use concise GitHub-flavored Markdown with headings, lists, links, code, or tables when structure makes the answer easier to scan.
- When the stream includes a planned frontend app action, keep the reply to a short receipt. The frontend owns the actual navigation/action state.
- For Connected Systems CRM, read/create/update requests require explicit user approval. Delete is blocked in v1.
- Destructive, account-changing, trading, approval, revocation, and manual-only actions must be blocked and explained safely.
- "Marketplace" is ambiguous: there are TWO. The Information Marketplace is where the user publishes and prices their own personal-data slices (what they've published, potential earnings). Kai's Market Home is the markets/investing surface. If the user says just "marketplace" without qualifying which, ask a short clarifying question — "Do you mean your Information Marketplace (your personal data slices) or Kai's Market Home (markets)?" — before answering or navigating. Once qualified (e.g. "information marketplace", "data marketplace", or "market home"), proceed to the right one.
- Keep answers concise, practical, and clear. Financial answers are educational, not personalized investment advice.
"""

AGENT_ACTION_PLANNER_PROMPT = """You are One's action router inside Hussh.

Decide whether the latest user message needs a frontend app function.

Call exactly one function only when the user clearly asks One to do one of these:
- start stock analysis for a ticker or public company
- open a Hussh/Kai app surface
- save, remember, or add durable personal context to the user's PKM
- read a CRM record or propose a CRM create/update through Connected Systems
- perform a destructive, account-changing, consent approval/revocation, trading, or manual-only action that must be blocked

For CRM read/update planning, extract the requested target scope from the user's wording.
Use target_scope="all_connected_crm_systems" when the user is asking to list, read, or update every connected brand,
all brand registries, brand CRMs, or all connected CRM systems. Otherwise use target_scope="single_connected_crm_system".
Map natural contact fields to CRM field API names in additional_fields_json, for example:
city/current city/new city -> {"MailingCity":"Las Vegas"}.

Do not call a function for normal finance questions, explanations, brainstorming, or general chat.
When unsure, do not call a function.
"""

# Curated allowlist of surfaces the chat action planner may open. The KEYS
# are a deliberate product decision (the Information Marketplace is
# intentionally absent: the planner opens surfaces too eagerly, so
# marketplace navigation stays deterministic in _plan_marketplace_navigation
# and marketplace questions go to the delegated specialist). The VALUES
# (action id validity, label, policy) are governed by the generated action
# gateway manifest: _resolved_app_surface_actions() drops any entry whose
# contract disappeared or stopped being allow_direct, so this map can never
# silently drift from the contract the rest of the app executes.
_APP_SURFACE_ACTION_IDS: dict[str, str] = {
    "consent_center": "route.consents",
    "pkm": "route.profile_pkm_agent_lab",
    "profile": "route.profile",
    "portfolio_import": "route.kai_import",
    "portfolio_dashboard": "route.kai_dashboard",
    "analysis_history": "route.analysis_history",
    "optimize": "route.kai_optimize",
    "market_home": "route.kai_home",
    "connected_systems": "route.profile_connected_systems",
}


@lru_cache(maxsize=1)
def _resolved_app_surface_actions() -> dict[str, tuple[str, str]]:
    """Surface -> (action_id, label), validated against the generated manifest.

    Fail-closed: an entry whose action id is missing from the manifest or is
    no longer allow_direct is dropped (and logged) instead of letting the
    planner open a surface the contract no longer permits.
    """
    from hushh_mcp.services.voice_action_manifest import get_voice_manifest_action

    resolved: dict[str, tuple[str, str]] = {}
    for surface, action_id in _APP_SURFACE_ACTION_IDS.items():
        entry = get_voice_manifest_action(action_id)
        if entry is None:
            logger.error(
                "agent_chat.surface_action_missing_from_manifest surface=%s action_id=%s",
                surface,
                action_id,
            )
            continue
        policy = str((entry.get("risk") or {}).get("execution_policy") or "")
        if policy != "allow_direct":
            logger.error(
                "agent_chat.surface_action_not_direct surface=%s action_id=%s policy=%s",
                surface,
                action_id,
                policy,
            )
            continue
        label = str(entry.get("label") or "").strip() or action_id
        resolved[surface] = (action_id, label)
    return resolved


MessageRole = Literal["user", "assistant", "system", "tool"]
MessageStatus = Literal["complete", "interrupted", "error"]
AgentActionExecution = Literal["frontend", "blocked"]
AgentRuntimeCredentialMode = Literal["byok", "hushh_managed_vertex"]
DEFAULT_AGENT_RUNTIME_CREDENTIAL_MODE: AgentRuntimeCredentialMode = "hushh_managed_vertex"

_STOCK_ALIAS_TO_TICKER = {
    "alphabet": "GOOGL",
    "amazon": "AMZN",
    "amd": "AMD",
    "apple": "AAPL",
    "berkshire": "BRK.B",
    "berkshire hathaway": "BRK.B",
    "facebook": "META",
    "google": "GOOGL",
    "meta": "META",
    "microsoft": "MSFT",
    "netflix": "NFLX",
    "nvidia": "NVDA",
    "tesla": "TSLA",
    "uber": "UBER",
    "visa": "V",
}

_ANALYSIS_PATTERNS = [
    re.compile(
        r"\b(?:start|run|begin|launch|open|kick\s+off|do)\s+"
        r"(?:a\s+|an\s+|the\s+)?(?:stock\s+)?analysis\s+"
        r"(?:of|for|on|about)?\s*(?P<target>[A-Za-z0-9 .&()/-]{1,90})",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:analyze|analyse|research|evaluate)\s+"
        r"(?P<target>[A-Za-z0-9 .&()/-]{1,90})",
        re.IGNORECASE,
    ),
]

_NAVIGATION_ACTION_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:consent|consents|permissions)\b",
            re.IGNORECASE,
        ),
        "route.consents",
        "Open Consent Center",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:pkm|personal knowledge|memory lab|saved memory|saved memories)\b",
            re.IGNORECASE,
        ),
        "route.profile_pkm_agent_lab",
        "Open PKM",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:profile|account)\b",
            re.IGNORECASE,
        ),
        "route.profile",
        "Open Profile",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to|upload|import)\b.*\b(?:import|statement|portfolio upload)\b",
            re.IGNORECASE,
        ),
        "route.kai_import",
        "Open Portfolio Import",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:portfolio|holdings|dashboard)\b",
            re.IGNORECASE,
        ),
        "route.kai_dashboard",
        "Open Portfolio Dashboard",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:analysis history|past analyses|past analysis|history)\b",
            re.IGNORECASE,
        ),
        "route.analysis_history",
        "Open Analysis History",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to|start|run)\b.*\b(?:optimize|optimise|rebalance)\b",
            re.IGNORECASE,
        ),
        "route.kai_optimize",
        "Open Optimize Surface",
    ),
    (
        # Must precede the "market"/kai-home pattern: "marketplace" contains
        # "market". Cues are QUALIFIED (information/data marketplace, data slices)
        # so a bare "open marketplace" is left for One to disambiguate rather than
        # silently opening the wrong surface.
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*"
            r"\b(?:information marketplace|data marketplace|data slices?|my slices)\b",
            re.IGNORECASE,
        ),
        "route.one_marketplace",
        "Open Information Marketplace",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:market home|kai market|kai home|home)\b",
            re.IGNORECASE,
        ),
        "route.kai_home",
        "Open Market Home",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:connected systems?|external crms?|salesforce crm|mulesoft)\b",
            re.IGNORECASE,
        ),
        "route.profile_connected_systems",
        "Open Connected Systems",
    ),
]

# Deterministic Information Marketplace navigation: only a QUALIFIED open-intent
# ("open/take me to the information/data marketplace", "open my slices"). A bare
# "marketplace" deliberately does NOT match so One can disambiguate.
_INFO_MARKETPLACE_NAV_RE = re.compile(
    r"\b(?:open|go to|show|take me to|navigate to|bring up|launch)\b.*"
    r"\b(?:information marketplace|data marketplace|data slices?|my slices)\b",
    re.IGNORECASE,
)

_CRM_READ_PATTERNS = [
    re.compile(
        r"\b(?:read|fetch|find|lookup|look up|search)\b.*\b(?:crm|salesforce|contact)\b",
        re.IGNORECASE,
    ),
]

_CRM_CREATE_PATTERNS = [
    re.compile(
        r"\b(?:create|add|new)\b.*\b(?:crm|salesforce|contact)\b",
        re.IGNORECASE,
    ),
]

_CRM_UPDATE_PATTERNS = [
    re.compile(
        r"\b(?:update|change|patch|modify)\b.*\b(?:crm|salesforce|contact|record)\b",
        re.IGNORECASE,
    ),
]

_CRM_DELETE_PATTERNS = [
    re.compile(
        r"\b(?:delete|remove|destroy)\b.*\b(?:crm|salesforce|contact|record)\b",
        re.IGNORECASE,
    ),
]

_BLOCKED_ACTION_PATTERNS = [
    re.compile(r"\b(?:delete|erase|wipe)\b.*\b(?:account|vault|profile|data)\b", re.IGNORECASE),
    re.compile(
        r"\b(?:revoke|approve|deny|grant)\b.*\b(?:consent|permission|request)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:disconnect|unlink)\b.*\b(?:account|bank|brokerage|gmail|google)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:sign out|log out|logout)\b", re.IGNORECASE),
    re.compile(r"\b(?:cancel|stop)\b.*\b(?:active\s+)?analysis\b", re.IGNORECASE),
    re.compile(
        r"\b(?:buy|sell|trade)\b.*\b(?:now|for me|on my behalf|in my account)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:place|execute)\b.*\b(?:order|trade)\b", re.IGNORECASE),
]

_PKM_ADD_PATTERNS = [
    re.compile(
        r"\b(?:add|save|store|remember)\b.*\b(?:pkm|personal knowledge|memory|memories)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:add|save|store|remember)\s+(?:this|that)\b",
        re.IGNORECASE,
    ),
]


@dataclass
class AgentChatConversation:
    id: str
    user_id: str
    title: str
    status: str
    model: str | None
    message_count: int
    created_at: str | None
    updated_at: str | None
    last_message_at: str | None


@dataclass
class AgentChatMessage:
    id: str
    conversation_id: str
    user_id: str
    role: str
    status: str
    content: str
    model: str | None
    created_at: str | None
    completed_at: str | None
    metadata: dict | None = None


@dataclass
class PreparedAgentChatTurn:
    conversation_id: str
    user_message_id: str
    history: list[AgentChatMessage]
    model: str


@dataclass(frozen=True)
class AgentChatActionPlan:
    call_id: str
    action_id: str | None
    label: str
    execution: AgentActionExecution
    slots: dict[str, Any]
    message: str
    reason: str | None = None
    execution_policy: str | None = None
    requires_confirmation: bool = False
    reachable: bool | None = None

    def to_event_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "call_id": self.call_id,
            "action_id": self.action_id,
            "label": self.label,
            "execution": self.execution,
            "slots": self.slots,
            "message": self.message,
            "reason": self.reason,
        }
        if self.execution_policy is not None:
            payload["execution_policy"] = self.execution_policy
        if self.requires_confirmation:
            payload["requires_confirmation"] = True
        if self.reachable is not None:
            payload["reachable"] = self.reachable
        return payload


@dataclass(frozen=True)
class AgentRuntimeContract:
    mode: AgentRuntimeCredentialMode
    credential_supplied: bool


@dataclass(frozen=True)
class PreparedAgentRuntime:
    mode: AgentRuntimeCredentialMode
    provider: str
    model: str
    credential_ref: str | None
    client: Any
    evidence: dict[str, Any]


@dataclass(frozen=True)
class KaiAgentCredentialPolicy:
    default: AgentRuntimeCredentialMode = DEFAULT_AGENT_RUNTIME_CREDENTIAL_MODE
    allowed: tuple[AgentRuntimeCredentialMode, ...] = ("hushh_managed_vertex", "byok")


@dataclass(frozen=True)
class KaiAgentRuntimeManifest:
    model: AgentModelConfig
    credential_policy: KaiAgentCredentialPolicy


class AgentRuntimeContractError(ValueError):
    def __init__(self, *, error_code: str, message: str):
        super().__init__(message)
        self.error_code = error_code
        self.message = message


class AgentRuntimeProviderError(RuntimeError):
    def __init__(
        self,
        *,
        error_code: str,
        message: str,
        detail: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.detail = detail or {}


class RuntimeSecretSession:
    def __init__(self, credential_ref: str, secret: str | None):
        self.credential_ref = credential_ref
        self.secret = secret

    async def read_secret(self, credential_ref: str) -> str | None:
        if credential_ref != self.credential_ref:
            return None
        return self.secret


def _parse_credential_mode(value: str | None) -> AgentRuntimeCredentialMode:
    mode = (value or DEFAULT_AGENT_RUNTIME_CREDENTIAL_MODE).strip()
    if mode == "byok":
        return "byok"
    if mode == "hushh_managed_vertex":
        return "hushh_managed_vertex"
    raise AgentRuntimeContractError(
        error_code="AGENT_RUNTIME_MODE_INVALID",
        message="Agent runtime credential mode is invalid.",
    )


def _load_kai_agent_manifest_data() -> dict[str, Any]:
    with KAI_AGENT_MANIFEST_PATH.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    return data if isinstance(data, dict) else {}


def _credential_policy_from_manifest(data: dict[str, Any]) -> KaiAgentCredentialPolicy:
    raw_policy = data.get("credential_policy")
    policy = raw_policy if isinstance(raw_policy, dict) else {}
    default = _parse_credential_mode(
        str(policy.get("default") or DEFAULT_AGENT_RUNTIME_CREDENTIAL_MODE)
    )
    raw_allowed = policy.get("allowed")
    allowed_values = (
        raw_allowed if isinstance(raw_allowed, list) else ["hushh_managed_vertex", "byok"]
    )
    allowed: list[AgentRuntimeCredentialMode] = []
    for value in allowed_values:
        mode = _parse_credential_mode(str(value))
        if mode not in allowed:
            allowed.append(mode)
    if default not in allowed:
        allowed.insert(0, default)
    return KaiAgentCredentialPolicy(default=default, allowed=tuple(allowed))


def load_kai_agent_runtime_manifest() -> KaiAgentRuntimeManifest:
    data = _load_kai_agent_manifest_data()
    manifest = ManifestLoader.load_from_dict(data, source=str(KAI_AGENT_MANIFEST_PATH))
    return KaiAgentRuntimeManifest(
        model=manifest.model_config_for_runtime(),
        credential_policy=_credential_policy_from_manifest(data),
    )


def create_runtime_client(runtime_provider: str, user_key: str):
    """BYOK runtime client for the chosen provider (Gemini, Anthropic, OpenAI, Grok)."""

    return build_runtime_client(runtime_provider, user_key)


def create_managed_runtime_client(runtime_provider: str, user_key: str):
    """Hushh-managed runtime client for the chosen provider."""

    return build_managed_runtime_client(runtime_provider, user_key)


def _redacted_runtime_evidence(evidence: dict[str, Any]) -> dict[str, Any]:
    def redact(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: (
                    "[REDACTED]"
                    if key
                    in {
                        "credential_ref",
                        "credential_resolved",
                        "credential_packaged",
                    }
                    else redact(nested)
                )
                for key, nested in value.items()
            }
        if isinstance(value, list):
            return [redact(item) for item in value]
        return value

    return redact(evidence)


def _google_error_payload(error: Exception) -> dict[str, Any]:
    response_json = getattr(error, "response_json", None)
    if isinstance(response_json, dict):
        return response_json
    details = getattr(error, "details", None)
    if isinstance(details, dict):
        return details
    try:
        return dict(error.args[0]) if error.args and isinstance(error.args[0], dict) else {}
    except Exception:
        return {}


def _google_error_info(payload: dict[str, Any]) -> dict[str, Any]:
    error_payload = payload.get("error") if isinstance(payload.get("error"), dict) else payload
    details = error_payload.get("details")
    if not isinstance(details, list):
        return {}
    for detail in details:
        if isinstance(detail, dict) and str(detail.get("@type") or "").endswith(
            "google.rpc.ErrorInfo"
        ):
            return detail
    return {}


def _classify_gemini_error(error: Exception) -> dict[str, Any]:
    detail: dict[str, Any] = {
        "error_type": error.__class__.__name__,
    }
    if error.__class__.__name__ == "DefaultCredentialsError":
        detail["likely_issue"] = "managed_google_credentials_unavailable"
        detail["operator_hint"] = "Check Hushh managed Gemini credentials for this runtime."
        return detail
    status_code = getattr(error, "code", None) or getattr(error, "status_code", None)
    if status_code is not None:
        detail["status_code"] = status_code
    status_value = getattr(error, "status", None)
    if status_value:
        detail["status"] = str(status_value)

    payload = _google_error_payload(error)
    info = _google_error_info(payload)
    reason = str(info.get("reason") or "").strip()
    metadata = info.get("metadata") if isinstance(info.get("metadata"), dict) else {}
    if reason:
        detail["provider_reason"] = reason
    service = metadata.get("service")
    if service:
        detail["provider_service"] = str(service)

    normalized_reason = reason.upper()
    if normalized_reason in {
        "API_KEY_INVALID",
        "API_KEY_EXPIRED",
        "API_KEY_SERVICE_BLOCKED",
    }:
        detail["likely_issue"] = "invalid_or_unauthorized_api_key"
        detail["operator_hint"] = "Check the Gemini API key saved in encrypted PKM."
    elif normalized_reason in {
        "CREDENTIALS_MISSING",
        "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
    }:
        detail["likely_issue"] = "managed_google_credentials_unavailable"
        detail["operator_hint"] = "Check Hushh managed Gemini credentials for this runtime."
    elif status_code in {401, 403}:
        detail["likely_issue"] = "credential_not_authorized"
        detail["operator_hint"] = "Check the runtime credential and model access."
    elif status_code == 404:
        detail["likely_issue"] = "model_not_available"
        detail["operator_hint"] = "Check the model in agent.yaml."
    return detail


def _is_google_provider_runtime_error(error: Exception) -> bool:
    module_name = getattr(error.__class__, "__module__", "")
    return module_name.startswith(("google.", "google_")) or error.__class__.__name__ in {
        "DefaultCredentialsError",
    }


# Transient Gemini status codes worth a short, jittered retry: rate limit (429),
# and the overloaded/unavailable family (500/503). Auth/quota-config errors
# (401/403/404) are deliberately excluded - retrying those is pointless.
_RETRYABLE_GEMINI_STATUS = {429, 500, 503}


def _is_retryable_gemini_error(error: Exception) -> bool:
    status_code = getattr(error, "code", None) or getattr(error, "status_code", None)
    if isinstance(status_code, int) and status_code in _RETRYABLE_GEMINI_STATUS:
        return True
    status_value = str(getattr(error, "status", "") or "").upper()
    return status_value in {"RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL"}


def _jittered_backoff_seconds(
    attempt: int, *, base_delay: float = 0.5, max_delay: float = 8.0
) -> float:
    """Decorrelated jittered exponential backoff to avoid retry thundering-herd."""
    import random

    exponent = max(0, attempt - 1)
    ceiling = min(base_delay * (2**exponent), max_delay)
    # Jitter here is for retry timing only, not security; pseudo-random is fine.
    return (
        random.uniform(base_delay, ceiling)  # noqa: S311
        if ceiling > base_delay
        else base_delay
    )


async def _retry_transient_gemini(
    operation: "Callable[[], Awaitable[Any]]",
    *,
    max_attempts: int = 3,
    phase: str,
) -> Any:
    """Run an idempotent Gemini call with jittered backoff on transient errors.

    Only safe for non-streaming, idempotent operations (e.g. action planning).
    Never use for the token stream, where a retry would duplicate output.
    """
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await operation()
        except genai_errors.APIError as error:
            last_error = error
            if attempt >= max_attempts or not _is_retryable_gemini_error(error):
                raise
        except Exception as error:  # noqa: BLE001 - bounded to provider errors below
            last_error = error
            if (
                attempt >= max_attempts
                or not _is_google_provider_runtime_error(error)
                or not _is_retryable_gemini_error(error)
            ):
                raise
        delay = _jittered_backoff_seconds(attempt)
        logger.info(
            "agent_chat_transient_retry phase=%s attempt=%d/%d delay=%.2fs error=%s",
            phase,
            attempt,
            max_attempts,
            delay,
            last_error.__class__.__name__ if last_error else "unknown",
        )
        await asyncio.sleep(delay)
    if last_error is not None:
        raise last_error
    raise RuntimeError("retry loop exited without result")


def _runtime_provider_error_code(detail: dict[str, Any]) -> str:
    likely_issue = str(detail.get("likely_issue") or "")
    if likely_issue == "invalid_or_unauthorized_api_key":
        return "AGENT_RUNTIME_CREDENTIAL_INVALID"
    if likely_issue == "managed_google_credentials_unavailable":
        return "AGENT_RUNTIME_MANAGED_CREDENTIALS_UNAVAILABLE"
    if likely_issue == "model_not_available":
        return "AGENT_RUNTIME_MODEL_UNAVAILABLE"
    return "AGENT_RUNTIME_PROVIDER_ERROR"


def _runtime_provider_user_message(error_code: str) -> str:
    if error_code == "AGENT_RUNTIME_CREDENTIAL_INVALID":
        return (
            "Your saved Gemini key could not be used. Update it in Profile > Runtime keys "
            "or switch Kai to Hushh managed Gemini."
        )
    if error_code == "AGENT_RUNTIME_MANAGED_CREDENTIALS_UNAVAILABLE":
        return "Hushh managed Gemini is not available in this environment."
    if error_code == "AGENT_RUNTIME_MODEL_UNAVAILABLE":
        return "Kai's configured Gemini model is not available for this runtime."
    return "Kai could not reach the configured Gemini runtime."


def _runtime_provider_error_from_exception(
    error: Exception,
) -> AgentRuntimeProviderError:
    detail = _classify_gemini_error(error)
    error_code = _runtime_provider_error_code(detail)
    return AgentRuntimeProviderError(
        error_code=error_code,
        message=_runtime_provider_user_message(error_code),
        detail=detail,
    )


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _trim_title(text: str) -> str:
    normalized = " ".join(str(text or "").split())
    if not normalized:
        return "New Agent chat"
    return normalized[:80]


def _tool_call_id() -> str:
    return f"tool_{uuid4().hex[:12]}"


def _current_screen_from_context(screen_context: dict[str, Any] | None) -> str | None:
    """Extract the current screen id from a structured screen context.

    Mirrors the shape the voice path already produces (route.screen /
    surface.screen_id). Returns None when no screen is provided so callers can
    treat reachability as unknown rather than failing closed on missing data.
    """
    if not isinstance(screen_context, dict):
        return None
    route = screen_context.get("route") if isinstance(screen_context.get("route"), dict) else {}
    surface = (
        screen_context.get("surface") if isinstance(screen_context.get("surface"), dict) else {}
    )
    candidate = route.get("screen") or surface.get("screen_id") or screen_context.get("screen")
    screen = str(candidate or "").strip()
    return screen or None


def _enrich_plan_with_manifest(
    plan: AgentChatActionPlan,
    *,
    current_screen: str | None,
) -> AgentChatActionPlan:
    """Make a frontend action plan screen-aware using the voice action manifest.

    Attaches the manifest execution_policy, flags manual_only/confirm_required
    actions as requiring confirmation, and computes reachability for the current
    screen. Degrades gracefully: unknown actions or missing screen context leave
    the plan unchanged (the frontend stays the source of truth for execution).
    """
    if plan.execution != "frontend" or not plan.action_id:
        return plan
    manifest_action = get_voice_manifest_action(plan.action_id)
    if manifest_action is None:
        return plan

    risk = manifest_action.get("risk") if isinstance(manifest_action.get("risk"), dict) else {}
    execution_policy = str(risk.get("execution_policy") or "allow_direct").strip() or "allow_direct"
    requires_confirmation = execution_policy in {"manual_only", "confirm_required"}

    scope = manifest_action.get("scope") if isinstance(manifest_action.get("scope"), dict) else {}
    scoped_screens = {str(screen).strip() for screen in (scope.get("screens") or []) if screen}
    if current_screen is None or not scoped_screens:
        reachable: bool | None = None
    else:
        reachable = current_screen in scoped_screens

    return replace(
        plan,
        execution_policy=execution_policy,
        requires_confirmation=requires_confirmation,
        reachable=reachable,
    )


def _sanitize_analysis_target(raw: str) -> str:
    target = re.sub(r"[^A-Za-z0-9 .&()/-]", " ", str(raw or ""))
    target = re.split(
        r"\b(?:and|then|with|using|please|for me|right now|now|today)\b",
        target,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    target = re.sub(r"\(([^)]+)\)", r" \1 ", target)
    target = re.sub(
        r"\b(?:stock|stocks|share|shares|company|ticker|symbol|analysis|report|deep dive)\b",
        " ",
        target,
        flags=re.IGNORECASE,
    )
    return " ".join(target.split()).strip(" .,-/")


def _resolve_ticker(raw: str) -> str | None:
    target = _sanitize_analysis_target(raw)
    if not target:
        return None
    upper_symbol_match = re.search(r"\b[A-Z]{1,5}(?:\.[A-Z])?\b", target)
    if upper_symbol_match:
        return upper_symbol_match.group(0).upper()
    normalized = target.lower().strip()
    if normalized in _STOCK_ALIAS_TO_TICKER:
        return _STOCK_ALIAS_TO_TICKER[normalized]
    normalized = re.sub(
        r"\b(?:inc|corp|corporation|company|plc|ltd|limited|class\s+[ab])\b",
        " ",
        normalized,
    )
    normalized = " ".join(normalized.split())
    if normalized in _STOCK_ALIAS_TO_TICKER:
        return _STOCK_ALIAS_TO_TICKER[normalized]
    if re.fullmatch(r"[A-Za-z]{1,5}(?:\.[A-Za-z])?", target):
        return target.upper()
    return None


def _schema_string(description: str, *, enum: list[str] | None = None) -> genai_types.Schema:
    return genai_types.Schema(
        type=genai_types.Type.STRING,
        description=description,
        enum=enum,
    )


def _schema_object(
    properties: dict[str, genai_types.Schema],
    *,
    required: list[str] | None = None,
) -> genai_types.Schema:
    return genai_types.Schema(
        type=genai_types.Type.OBJECT,
        properties=properties,
        required=required or [],
    )


def _agent_action_tool() -> genai_types.Tool:
    return genai_types.Tool(
        function_declarations=[
            genai_types.FunctionDeclaration(
                name="start_stock_analysis",
                description=(
                    "Start Kai's frontend stock analysis workflow for a requested ticker "
                    "or public company."
                ),
                parameters=_schema_object(
                    {
                        "symbol": _schema_string(
                            "Ticker symbol if known, for example NVDA or AAPL."
                        ),
                        "company": _schema_string(
                            "Company or asset name if the user gave a name instead of a ticker."
                        ),
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="open_app_surface",
                description="Open a safe Hussh or Kai frontend surface.",
                parameters=_schema_object(
                    {
                        "surface": _schema_string(
                            "Frontend surface to open.",
                            enum=list(_resolved_app_surface_actions().keys()),
                        )
                    },
                    required=["surface"],
                ),
            ),
            genai_types.FunctionDeclaration(
                name="block_manual_action",
                description=(
                    "Use when the user asks Agent to perform a destructive, account-changing, "
                    "consent approval/revocation, trading, or manual-only action."
                ),
                parameters=_schema_object(
                    {
                        "reason": _schema_string(
                            "Short safe reason explaining why One cannot perform the action."
                        )
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="read_crm_record",
                description=(
                    "Open the Connected Systems CRM read workflow. Use when the "
                    "user asks to read, fetch, search, or look up a CRM Contact record."
                ),
                parameters=_schema_object(
                    {
                        "email": _schema_string("Contact email if the user supplied it."),
                        "phone": _schema_string("Contact phone if the user supplied it."),
                        "target_scope": _schema_string(
                            "single_connected_crm_system or all_connected_crm_systems."
                        ),
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="propose_crm_create",
                description=(
                    "Open the Connected Systems CRM create proposal workflow. "
                    "Execution will still require explicit user approval."
                ),
                parameters=_schema_object(
                    {
                        "email": _schema_string("Contact email if the user supplied it."),
                        "phone": _schema_string("Contact phone if the user supplied it."),
                        "first_name": _schema_string("Contact first name if supplied."),
                        "last_name": _schema_string("Contact last name if supplied."),
                        "additional_fields_json": _schema_string(
                            "Optional JSON object string for supported CRM fields."
                        ),
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="propose_crm_update",
                description=(
                    "Open the Connected Systems CRM update proposal workflow. "
                    "Execution will still require explicit user approval."
                ),
                parameters=_schema_object(
                    {
                        "record_id": _schema_string("CRM record Id if the user supplied it."),
                        "email": _schema_string("Contact email if the user supplied it."),
                        "phone": _schema_string("Contact phone if the user supplied it."),
                        "target_scope": _schema_string(
                            "single_connected_crm_system or all_connected_crm_systems."
                        ),
                        "additional_fields_json": _schema_string(
                            "Optional JSON object string for supported CRM fields to update. "
                            'Use CRM field API names, for example {"MailingCity":"Las Vegas"}.'
                        ),
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="add_to_pkm",
                description=(
                    "Save or queue durable personal context to the user's encrypted PKM through "
                    "the frontend PKM writer. Use only when the user explicitly asks to save, "
                    "remember, store, or add information to PKM or memory."
                ),
                parameters=_schema_object(
                    {
                        "memory_text": _schema_string(
                            "The exact user-provided information that should be considered for PKM."
                        ),
                        "reason": _schema_string(
                            "Short reason this looks like long-term personal context."
                        ),
                    },
                    required=["memory_text"],
                ),
            ),
        ]
    )


class AgentChatService:
    """Owns Agent chat LLM streaming and backend-decryptable encrypted history."""

    def __init__(
        self,
        *,
        db: Any | None = None,
        model: str | None = None,
        vault_key_hex: str | None = None,
    ):
        self._db = db
        self._client = None
        self._settings = None
        self.runtime_manifest = load_kai_agent_runtime_manifest()
        self.model = (model or self.runtime_manifest.model.name or DEFAULT_AGENT_CHAT_MODEL).strip()
        self._vault_key_hex = vault_key_hex

    @property
    def settings(self):
        if self._settings is None:
            self._settings = get_core_security_settings()
        return self._settings

    @property
    def vault_key_hex(self) -> str:
        return self._vault_key_hex or self.settings.vault_data_key

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    @property
    def client(self):
        if self._client is None:
            api_key = self.settings.google_api_key or os.getenv("GOOGLE_API_KEY", "").strip()
            if not api_key:
                raise RuntimeError("Gemini API key is not configured")
            self._client = create_managed_runtime_client(
                runtime_provider=self.runtime_manifest.model.provider,
                user_key=api_key,
            )
        return self._client

    def prepare_runtime_contract(
        self,
        *,
        runtime_credential: str | None = None,
        runtime_credential_mode: str | None = None,
    ) -> AgentRuntimeContract:
        mode = _parse_credential_mode(
            runtime_credential_mode or self.runtime_manifest.credential_policy.default
        )
        if mode not in self.runtime_manifest.credential_policy.allowed:
            raise AgentRuntimeContractError(
                error_code="AGENT_RUNTIME_MODE_INVALID",
                message="Agent runtime credential mode is invalid.",
            )

        secret = (runtime_credential or "").strip()
        if mode == "byok" and not secret:
            raise AgentRuntimeContractError(
                error_code="AGENT_RUNTIME_CREDENTIAL_MISSING",
                message=(
                    "Kai needs your Gemini key to continue. Add or update it in "
                    "Profile > Runtime keys, or switch Kai to Hushh managed Gemini."
                ),
            )

        return AgentRuntimeContract(
            mode=mode,
            credential_supplied=bool(secret),
        )

    async def prepare_agent_runtime(
        self,
        *,
        runtime_credential: str | None = None,
        runtime_credential_mode: str | None = None,
    ) -> PreparedAgentRuntime:
        contract = self.prepare_runtime_contract(
            runtime_credential=runtime_credential,
            runtime_credential_mode=runtime_credential_mode,
        )
        model_config = self.runtime_manifest.model
        provider = model_config.provider.strip().lower()
        model_name = (model_config.name or self.model or DEFAULT_AGENT_CHAT_MODEL).strip()
        credential_ref = model_config.credential_ref

        if contract.mode == "hushh_managed_vertex":
            evidence = {
                "framework": "google_adk",
                "deployment_target": "personal_sandbox",
                "model": {
                    "mode": "hushh_managed_vertex",
                    "provider": provider,
                    "model": model_name,
                    "credential_ref": credential_ref,
                    "resolution_source": "hushh_managed_vertex",
                },
            }
            logger.info("agent_chat_runtime_evidence=%s", _redacted_runtime_evidence(evidence))
            return PreparedAgentRuntime(
                mode=contract.mode,
                provider=provider,
                model=model_name,
                credential_ref=credential_ref,
                client=self.client,
                evidence=evidence,
            )

        if not credential_ref:
            raise AgentRuntimeContractError(
                error_code="AGENT_RUNTIME_CREDENTIAL_REF_MISSING",
                message="Kai BYOK runtime is missing a PKM credential reference.",
            )

        runtime = runtime_config(
            "google_adk",
            model=ModelConfig(
                provider=provider,
                model=model_name,
                mode="byok",
                credential_ref=credential_ref,
            ),
        )
        bundle = await prepare_runtime_credentials(
            runtime,
            resolver=PKMCredentialResolver(
                RuntimeSecretSession(
                    credential_ref=runtime.model.credential_ref or credential_ref,
                    secret=runtime_credential,
                )
            ),
        )
        if bundle.credential is None or not bundle.credential.secret.strip():
            raise AgentRuntimeContractError(
                error_code="AGENT_RUNTIME_CREDENTIAL_MISSING",
                message=(
                    "Kai needs your Gemini key to continue. Add or update it in "
                    "Profile > Runtime keys, or switch Kai to Hushh managed Gemini."
                ),
            )

        logger.info(
            "agent_chat_runtime_evidence=%s",
            _redacted_runtime_evidence(bundle.evidence),
        )
        return PreparedAgentRuntime(
            mode=contract.mode,
            provider=provider,
            model=model_name,
            credential_ref=credential_ref,
            client=create_runtime_client(
                runtime_provider=runtime.model.provider,
                user_key=bundle.credential.secret,
            ),
            evidence=bundle.evidence,
        )

    async def _execute_raw(self, sql: str, params: dict[str, Any] | None = None):
        return await asyncio.to_thread(self.db.execute_raw, sql, params or {})

    def _encrypt_text(self, text: str) -> EncryptedPayload:
        return encrypt_data(str(text or ""), self.vault_key_hex)

    def _decrypt_text(self, row: dict[str, Any], prefix: str) -> str:
        ciphertext = str(row.get(f"{prefix}_ciphertext") or "")
        iv = str(row.get(f"{prefix}_iv") or "")
        tag = str(row.get(f"{prefix}_tag") or "")
        if not ciphertext or not iv or not tag:
            return ""
        payload = EncryptedPayload(
            ciphertext=ciphertext,
            iv=iv,
            tag=tag,
            encoding="base64",
            algorithm="aes-256-gcm",
        )
        return decrypt_data(payload, self.vault_key_hex)

    async def get_conversation(
        self,
        conversation_id: str,
        *,
        user_id: str | None = None,
    ) -> AgentChatConversation | None:
        params: dict[str, Any] = {"conversation_id": conversation_id}
        if user_id is not None:
            params["user_id"] = user_id
            sql = """
            SELECT *
            FROM agent_chat_conversations
            WHERE id = :conversation_id AND user_id = :user_id
            LIMIT 1
            """
        else:
            sql = """
            SELECT *
            FROM agent_chat_conversations
            WHERE id = :conversation_id
            LIMIT 1
            """
        result = await self._execute_raw(
            sql,
            params,
        )
        rows = result.data or []
        if not rows:
            return None
        return self._conversation_from_row(rows[0])

    async def create_conversation(self, user_id: str, first_message: str) -> AgentChatConversation:
        conversation_id = str(uuid4())
        encrypted_title = self._encrypt_text(_trim_title(first_message))
        result = await self._execute_raw(
            """
            INSERT INTO agent_chat_conversations (
              id,
              user_id,
              title_ciphertext,
              title_iv,
              title_tag,
              title_algorithm,
              model
            )
            VALUES (
              :id,
              :user_id,
              :title_ciphertext,
              :title_iv,
              :title_tag,
              :title_algorithm,
              :model
            )
            RETURNING *
            """,
            {
                "id": conversation_id,
                "user_id": user_id,
                "title_ciphertext": encrypted_title.ciphertext,
                "title_iv": encrypted_title.iv,
                "title_tag": encrypted_title.tag,
                "title_algorithm": encrypted_title.algorithm,
                "model": self.model,
            },
        )
        return self._conversation_from_row((result.data or [])[0])

    async def rename_conversation(
        self,
        conversation_id: str,
        *,
        user_id: str,
        title: str,
    ) -> AgentChatConversation | None:
        encrypted_title = self._encrypt_text(_trim_title(title))
        result = await self._execute_raw(
            """
            UPDATE agent_chat_conversations
            SET
              title_ciphertext = :title_ciphertext,
              title_iv = :title_iv,
              title_tag = :title_tag,
              title_algorithm = :title_algorithm,
              updated_at = now()
            WHERE id = :conversation_id AND user_id = :user_id
            RETURNING *
            """,
            {
                "conversation_id": conversation_id,
                "user_id": user_id,
                "title_ciphertext": encrypted_title.ciphertext,
                "title_iv": encrypted_title.iv,
                "title_tag": encrypted_title.tag,
                "title_algorithm": encrypted_title.algorithm,
            },
        )
        rows = result.data or []
        if not rows:
            return None
        return self._conversation_from_row(rows[0])

    async def delete_conversation(self, conversation_id: str, *, user_id: str) -> bool:
        result = await self._execute_raw(
            """
            DELETE FROM agent_chat_conversations
            WHERE id = :conversation_id AND user_id = :user_id
            RETURNING id
            """,
            {
                "conversation_id": conversation_id,
                "user_id": user_id,
            },
        )
        return bool(result.data or [])

    async def get_or_create_conversation(
        self,
        *,
        user_id: str,
        conversation_id: str | None,
        first_message: str,
    ) -> AgentChatConversation:
        if conversation_id:
            conversation = await self.get_conversation(conversation_id, user_id=user_id)
            if conversation is not None:
                return conversation
        return await self.create_conversation(user_id, first_message)

    async def prepare_turn(
        self,
        *,
        user_id: str,
        message: str,
        conversation_id: str | None = None,
    ) -> PreparedAgentChatTurn:
        conversation = await self.get_or_create_conversation(
            user_id=user_id,
            conversation_id=conversation_id,
            first_message=message,
        )
        history = await self.get_recent_messages(conversation.id, user_id=user_id, limit=20)
        user_message = await self.add_message(
            conversation_id=conversation.id,
            user_id=user_id,
            role="user",
            content=message,
            status="complete",
            model=None,
        )
        return PreparedAgentChatTurn(
            conversation_id=conversation.id,
            user_message_id=user_message.id,
            history=history,
            model=self.model,
        )

    async def add_message(
        self,
        *,
        conversation_id: str,
        user_id: str,
        role: MessageRole,
        content: str,
        status: MessageStatus,
        model: str | None = None,
        error_code: str | None = None,
        metadata: dict | None = None,
    ) -> AgentChatMessage:
        message_id = str(uuid4())
        encrypted = self._encrypt_text(content)
        encrypted_metadata = (
            self._encrypt_text(json.dumps(metadata)) if metadata is not None else None
        )
        result = await self._execute_raw(
            """
            INSERT INTO agent_chat_messages (
              id,
              conversation_id,
              user_id,
              role,
              status,
              content_ciphertext,
              content_iv,
              content_tag,
              content_algorithm,
              model,
              error_code,
              metadata_ciphertext,
              metadata_iv,
              metadata_tag,
              metadata_algorithm,
              completed_at
            )
            VALUES (
              :id,
              :conversation_id,
              :user_id,
              :role,
              :status,
              :content_ciphertext,
              :content_iv,
              :content_tag,
              :content_algorithm,
              :model,
              :error_code,
              :metadata_ciphertext,
              :metadata_iv,
              :metadata_tag,
              :metadata_algorithm,
              now()
            )
            RETURNING *
            """,
            {
                "id": message_id,
                "conversation_id": conversation_id,
                "user_id": user_id,
                "role": role,
                "status": status,
                "content_ciphertext": encrypted.ciphertext,
                "content_iv": encrypted.iv,
                "content_tag": encrypted.tag,
                "content_algorithm": encrypted.algorithm,
                "model": model,
                "error_code": error_code,
                "metadata_ciphertext": encrypted_metadata.ciphertext
                if encrypted_metadata
                else None,
                "metadata_iv": encrypted_metadata.iv if encrypted_metadata else None,
                "metadata_tag": encrypted_metadata.tag if encrypted_metadata else None,
                "metadata_algorithm": encrypted_metadata.algorithm if encrypted_metadata else None,
            },
        )
        await self._execute_raw(
            """
            UPDATE agent_chat_conversations
            SET
              updated_at = now(),
              last_message_at = now(),
              message_count = message_count + 1,
              model = COALESCE(:model, model)
            WHERE id = :conversation_id AND user_id = :user_id
            """,
            {
                "conversation_id": conversation_id,
                "user_id": user_id,
                "model": model,
            },
        )
        return self._message_from_row((result.data or [])[0])

    async def get_recent_messages(
        self,
        conversation_id: str,
        *,
        user_id: str,
        limit: int = 20,
    ) -> list[AgentChatMessage]:
        safe_limit = max(1, min(int(limit), 100))
        result = await self._execute_raw(
            """
            SELECT *
            FROM (
              SELECT *
              FROM agent_chat_messages
              WHERE conversation_id = :conversation_id AND user_id = :user_id
              ORDER BY created_at DESC
              LIMIT :limit
            ) recent
            ORDER BY created_at ASC
            """,
            {
                "conversation_id": conversation_id,
                "user_id": user_id,
                "limit": safe_limit,
            },
        )
        return [self._message_from_row(row) for row in result.data or []]

    async def list_conversations(
        self,
        user_id: str,
        *,
        limit: int = 5,
    ) -> list[AgentChatConversation]:
        safe_limit = max(1, min(int(limit), 20))
        result = await self._execute_raw(
            """
            SELECT *
            FROM agent_chat_conversations
            WHERE user_id = :user_id
            ORDER BY updated_at DESC
            LIMIT :limit
            """,
            {
                "user_id": user_id,
                "limit": safe_limit,
            },
        )
        return [self._conversation_from_row(row) for row in result.data or []]

    async def stream_response(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        runtime_client: Any,
        runtime_model: str,
        action_plan: AgentChatActionPlan | None = None,
        pkm_context: str | None = None,
    ) -> AsyncGenerator[str, None]:
        contents = self._build_contents(
            user_message=user_message,
            history=history,
            action_plan=action_plan,
            pkm_context=pkm_context,
        )
        config = genai_types.GenerateContentConfig(
            system_instruction=AGENT_SYSTEM_PROMPT,
            temperature=0.7,
            max_output_tokens=4096,
        )
        try:
            stream = await runtime_client.aio.models.generate_content_stream(
                model=runtime_model,
                contents=contents,
                config=config,
            )
            async for chunk in stream:
                text = self._chunk_text(chunk)
                if text:
                    yield text
        except genai_errors.APIError as error:
            provider_error = _runtime_provider_error_from_exception(error)
            logger.warning(
                "agent_chat_runtime_provider_error phase=stream provider=%s model=%s credential_ref=%s detail=%s",
                self.runtime_manifest.model.provider,
                runtime_model,
                self.runtime_manifest.model.credential_ref,
                provider_error.detail,
            )
            raise provider_error from error
        except Exception as error:
            if _is_google_provider_runtime_error(error):
                provider_error = _runtime_provider_error_from_exception(error)
                logger.warning(
                    "agent_chat_runtime_provider_error phase=stream provider=%s model=%s credential_ref=%s detail=%s",
                    self.runtime_manifest.model.provider,
                    runtime_model,
                    self.runtime_manifest.model.credential_ref,
                    provider_error.detail,
                )
                raise provider_error from error
            raise

    async def plan_action_with_gemini(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        runtime_client: Any,
        runtime_model: str,
        pkm_context: str | None = None,
        screen_context: dict[str, Any] | None = None,
        deterministic_crm_first: bool = True,
    ) -> AgentChatActionPlan | None:
        current_screen = _current_screen_from_context(screen_context)

        if deterministic_crm_first:
            crm_action = self._plan_crm_action(user_message)
            if crm_action is not None:
                return _enrich_plan_with_manifest(crm_action, current_screen=current_screen)

        deterministic_block = self._plan_blocked_action(user_message)
        if deterministic_block is not None:
            return deterministic_block

        # Deterministic Information Marketplace navigation (qualified open-intent
        # only), decided BEFORE the LLM planner so questions and a bare
        # "marketplace" are never auto-navigated by the model.
        marketplace_nav = self._plan_marketplace_navigation(user_message)
        if marketplace_nav is not None:
            return _enrich_plan_with_manifest(marketplace_nav, current_screen=current_screen)

        try:
            # Action planning is a non-streaming, idempotent call, so a short
            # jittered retry on transient 429/503 is safe (unlike the token
            # stream, where a retry would duplicate output).
            response = await _retry_transient_gemini(
                lambda: runtime_client.aio.models.generate_content(
                    model=runtime_model,
                    contents=self._build_action_planning_contents(
                        user_message=user_message,
                        history=history,
                        pkm_context=pkm_context,
                    ),
                    config=genai_types.GenerateContentConfig(
                        system_instruction=AGENT_ACTION_PLANNER_PROMPT,
                        temperature=0.0,
                        max_output_tokens=256,
                        tools=[_agent_action_tool()],
                        automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(
                            disable=True
                        ),
                        tool_config=genai_types.ToolConfig(
                            function_calling_config=genai_types.FunctionCallingConfig(mode="AUTO")
                        ),
                    ),
                ),
                phase="planner",
            )
            for function_call in self._function_calls_from_response(response):
                action_plan = self._action_plan_from_function_call(function_call)
                if action_plan is not None:
                    return _enrich_plan_with_manifest(action_plan, current_screen=current_screen)
        except genai_errors.APIError as error:
            provider_error = _runtime_provider_error_from_exception(error)
            logger.warning(
                "agent_chat_runtime_provider_error phase=planner provider=%s model=%s credential_ref=%s detail=%s",
                self.runtime_manifest.model.provider,
                runtime_model,
                self.runtime_manifest.model.credential_ref,
                provider_error.detail,
            )
            raise provider_error from error
        except Exception as error:
            if _is_google_provider_runtime_error(error):
                provider_error = _runtime_provider_error_from_exception(error)
                logger.warning(
                    "agent_chat_runtime_provider_error phase=planner provider=%s model=%s credential_ref=%s detail=%s",
                    self.runtime_manifest.model.provider,
                    runtime_model,
                    self.runtime_manifest.model.credential_ref,
                    provider_error.detail,
                )
                raise provider_error from error
            logger.exception("agent_chat.function_planning_failed")

        fallback_plan = self.plan_action(user_message)
        if fallback_plan is None:
            return None
        return _enrich_plan_with_manifest(fallback_plan, current_screen=current_screen)

    def plan_action(self, user_message: str) -> AgentChatActionPlan | None:
        message = " ".join(str(user_message or "").split())
        if not message:
            return None

        crm_action = self._plan_crm_action(message)
        if crm_action is not None:
            return crm_action

        blocked_action = self._plan_blocked_action(message)
        if blocked_action is not None:
            return blocked_action

        for pattern in _PKM_ADD_PATTERNS:
            if pattern.search(message):
                return AgentChatActionPlan(
                    call_id=_tool_call_id(),
                    action_id="pkm.add",
                    label="Add to PKM",
                    execution="frontend",
                    slots={},
                    message="Checking PKM and saving what fits.",
                )

        for pattern in _ANALYSIS_PATTERNS:
            match = pattern.search(message)
            if not match:
                continue
            ticker = _resolve_ticker(match.group("target"))
            if not ticker:
                continue
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="analysis.start",
                label=f"Start analysis for {ticker}",
                execution="frontend",
                slots={"symbol": ticker},
                message=f"Starting Kai analysis for {ticker}.",
            )

        for pattern, action_id, label in _NAVIGATION_ACTION_PATTERNS:
            if pattern.search(message):
                return AgentChatActionPlan(
                    call_id=_tool_call_id(),
                    action_id=action_id,
                    label=label,
                    execution="frontend",
                    slots={},
                    message=f"{label} in the app.",
                )
        return None

    def _plan_marketplace_navigation(self, user_message: str) -> AgentChatActionPlan | None:
        """Deterministic navigation to the Information Marketplace on a QUALIFIED
        open-intent. Bare "marketplace" and questions return None (One handles them:
        disambiguation for bare, delegated answer for questions)."""
        message = " ".join(str(user_message or "").split())
        if not message or not _INFO_MARKETPLACE_NAV_RE.search(message):
            return None
        return AgentChatActionPlan(
            call_id=_tool_call_id(),
            action_id="route.one_marketplace",
            label="Open Information Marketplace",
            execution="frontend",
            slots={},
            message="Open Information Marketplace in the app.",
        )

    def _plan_crm_action(self, user_message: str) -> AgentChatActionPlan | None:
        message = " ".join(str(user_message or "").split())
        if not message:
            return None

        if any(pattern.search(message) for pattern in _CRM_DELETE_PATTERNS):
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="connected_system.crm.delete",
                label="Blocked CRM Delete",
                execution="blocked",
                slots={"systemId": "salesforce-fsc-customer0", "objectType": "Contact"},
                message=(
                    "CRM delete is blocked in Agent v1. Open Connected Systems "
                    "and use a maintainer-only test path if this is intentional."
                ),
                reason="crm_delete_manual_only",
            )

        if any(pattern.search(message) for pattern in _CRM_UPDATE_PATTERNS):
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="connected_system.crm.update.propose",
                label="Propose CRM Update",
                execution="frontend",
                slots={"systemId": "salesforce-fsc-customer0", "objectType": "Contact"},
                message="Opening Connected Systems so you can review and approve the CRM update.",
            )

        if any(pattern.search(message) for pattern in _CRM_CREATE_PATTERNS):
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="connected_system.crm.create.propose",
                label="Propose CRM Create",
                execution="frontend",
                slots={"systemId": "salesforce-fsc-customer0", "objectType": "Contact"},
                message="Opening Connected Systems so you can review and approve the CRM create.",
            )

        if any(pattern.search(message) for pattern in _CRM_READ_PATTERNS):
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="connected_system.crm.read",
                label="Read CRM Record",
                execution="frontend",
                slots={"systemId": "salesforce-fsc-customer0", "objectType": "Contact"},
                message="Opening Connected Systems for the CRM read.",
            )

        return None

    def _plan_blocked_action(self, user_message: str) -> AgentChatActionPlan | None:
        message = " ".join(str(user_message or "").split())
        for pattern in _BLOCKED_ACTION_PATTERNS:
            if pattern.search(message):
                return AgentChatActionPlan(
                    call_id=_tool_call_id(),
                    action_id=None,
                    label="Blocked Manual Action",
                    execution="blocked",
                    slots={},
                    message=(
                        "I can't perform destructive, account-changing, consent approval, "
                        "revocation, or trading actions from Agent. Please do that manually."
                    ),
                    reason="manual_or_destructive_action",
                )
        return None

    def _build_contents(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        action_plan: AgentChatActionPlan | None = None,
        pkm_context: str | None = None,
    ) -> list[genai_types.Content]:
        contents: list[genai_types.Content] = []
        for message in history[-20:]:
            if message.role not in {"user", "assistant"}:
                continue
            role = "user" if message.role == "user" else "model"
            contents.append(
                genai_types.Content(
                    role=role,
                    parts=[genai_types.Part(text=message.content[:4000])],
                )
            )
        contents.append(
            genai_types.Content(
                role="user",
                parts=[
                    genai_types.Part(
                        text=(
                            f"{self._build_turn_context(action_plan=action_plan, pkm_context=pkm_context)}\n\n"
                            f"Latest user message:\n{user_message}"
                        )
                    )
                ],
            )
        )
        return contents

    def _build_action_planning_contents(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        pkm_context: str | None = None,
    ) -> list[genai_types.Content]:
        contents: list[genai_types.Content] = []
        for message in history[-8:]:
            if message.role not in {"user", "assistant"}:
                continue
            role = "user" if message.role == "user" else "model"
            contents.append(
                genai_types.Content(
                    role=role,
                    parts=[genai_types.Part(text=message.content[:1500])],
                )
            )
        clean_pkm_context = str(pkm_context or "").strip()
        planning_context = (
            clean_pkm_context[:4000]
            if clean_pkm_context
            else "No PKM context was provided for this turn."
        )
        contents.append(
            genai_types.Content(
                role="user",
                parts=[
                    genai_types.Part(
                        text=(
                            "PKM context for routing only:\n"
                            f"{planning_context}\n\n"
                            f"Latest user message:\n{user_message}"
                        )
                    )
                ],
            )
        )
        return contents

    def _build_turn_context(
        self,
        *,
        action_plan: AgentChatActionPlan | None = None,
        pkm_context: str | None = None,
    ) -> str:
        action_context = "No frontend app action is planned for this turn."
        if action_plan and action_plan.execution == "frontend":
            action_context = (
                "Frontend app action planned for this turn:\n"
                f"- action_id: {action_plan.action_id}\n"
                f"- label: {action_plan.label}\n"
                f"- slots: {action_plan.slots}\n"
                "Instruction: briefly acknowledge that this action is being started or opened in Kai. "
                "Do not ask for confirmation."
            )
        elif action_plan and action_plan.execution == "blocked":
            action_context = (
                "A requested action was blocked before execution:\n"
                f"- reason: {action_plan.reason}\n"
                f"- message: {action_plan.message}\n"
                "Instruction: explain the block clearly and suggest the safe manual path."
            )
        clean_pkm_context = str(pkm_context or "").strip()
        pkm_context_text = (
            clean_pkm_context[:20000]
            if clean_pkm_context
            else "No PKM context was provided for this turn."
        )
        return f"PKM context:\n{pkm_context_text}\n\nAction context:\n{action_context}"

    def _function_calls_from_response(self, response: Any) -> list[Any]:
        response_calls = getattr(response, "function_calls", None)
        if response_calls:
            return list(response_calls)

        calls: list[Any] = []
        candidates = getattr(response, "candidates", None) or []
        for candidate in candidates:
            content = getattr(candidate, "content", None)
            for part in getattr(content, "parts", None) or []:
                function_call = getattr(part, "function_call", None)
                if function_call is not None:
                    calls.append(function_call)
        return calls

    def _action_plan_from_function_call(self, function_call: Any) -> AgentChatActionPlan | None:
        name = str(getattr(function_call, "name", "") or "").strip()
        args = dict(getattr(function_call, "args", None) or {})
        call_id = str(getattr(function_call, "id", "") or "").strip() or _tool_call_id()

        if name == "start_stock_analysis":
            ticker = _resolve_ticker(
                str(args.get("symbol") or args.get("company") or args.get("target") or "")
            )
            if not ticker:
                return None
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="analysis.start",
                label=f"Start analysis for {ticker}",
                execution="frontend",
                slots={"symbol": ticker},
                message=f"Starting Kai analysis for {ticker}.",
            )

        if name == "open_app_surface":
            surface = str(args.get("surface") or "").strip()
            action = _resolved_app_surface_actions().get(surface)
            if action is None:
                return None
            action_id, label = action
            return AgentChatActionPlan(
                call_id=call_id,
                action_id=action_id,
                label=label,
                execution="frontend",
                slots={},
                message=f"{label} in the app.",
            )

        if name == "block_manual_action":
            reason = str(args.get("reason") or "").strip() or "manual_or_destructive_action"
            return AgentChatActionPlan(
                call_id=call_id,
                action_id=None,
                label="Blocked Manual Action",
                execution="blocked",
                slots={},
                message=(
                    "I can't perform destructive, account-changing, consent approval, "
                    "revocation, or trading actions from Agent. Please do that manually."
                ),
                reason=reason[:160],
            )

        if name == "read_crm_record":
            scope = str(args.get("target_scope") or args.get("scope") or "").strip()
            slots: dict[str, Any] = {
                "systemId": "salesforce-fsc-customer0",
                "objectType": "Contact",
                "email": str(args.get("email") or "").strip(),
                "phone": str(args.get("phone") or "").strip(),
            }
            if scope == "all_connected_crm_systems":
                slots["scope"] = scope
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="connected_system.crm.read",
                label="Read CRM Record",
                execution="frontend",
                slots=slots,
                message="Opening Connected Systems for the CRM read.",
            )

        if name == "propose_crm_create":
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="connected_system.crm.create.propose",
                label="Propose CRM Create",
                execution="frontend",
                slots={
                    "systemId": "salesforce-fsc-customer0",
                    "objectType": "Contact",
                    "email": str(args.get("email") or "").strip(),
                    "phone": str(args.get("phone") or "").strip(),
                    "firstName": str(args.get("first_name") or "").strip(),
                    "lastName": str(args.get("last_name") or "").strip(),
                    "additionalFieldsJson": str(args.get("additional_fields_json") or "").strip(),
                },
                message="Opening Connected Systems so you can review and approve the CRM create.",
            )

        if name == "propose_crm_update":
            scope = str(args.get("target_scope") or args.get("scope") or "").strip()
            slots: dict[str, Any] = {
                "systemId": "salesforce-fsc-customer0",
                "objectType": "Contact",
                "id": str(args.get("record_id") or "").strip(),
                "email": str(args.get("email") or "").strip(),
                "phone": str(args.get("phone") or "").strip(),
                "additionalFieldsJson": str(args.get("additional_fields_json") or "").strip(),
            }
            if scope == "all_connected_crm_systems":
                slots["scope"] = scope
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="connected_system.crm.update.propose",
                label="Propose CRM Update",
                execution="frontend",
                slots=slots,
                message="Opening Connected Systems so you can review and approve the CRM update.",
            )

        if name == "add_to_pkm":
            memory_text = str(args.get("memory_text") or "").strip()
            if not memory_text:
                return None
            reason = str(args.get("reason") or "").strip()
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="pkm.add",
                label="Add to PKM",
                execution="frontend",
                slots={},
                message="Checking PKM and saving what fits.",
                reason=reason[:160] if reason else None,
            )

        return None

    def _chunk_text(self, chunk: Any) -> str:
        text_value = getattr(chunk, "text", None)
        if isinstance(text_value, str) and text_value:
            return text_value
        parts: list[str] = []
        candidates = getattr(chunk, "candidates", None) or []
        for candidate in candidates:
            content = getattr(candidate, "content", None)
            for part in getattr(content, "parts", None) or []:
                part_text = getattr(part, "text", None)
                if isinstance(part_text, str) and part_text:
                    parts.append(part_text)
        return "".join(parts)

    def _conversation_from_row(self, row: dict[str, Any]) -> AgentChatConversation:
        try:
            title = self._decrypt_text(row, "title")
        except Exception:
            logger.warning("agent_chat.title_decrypt_failed conversation_id=%s", row.get("id"))
            title = "Agent conversation"
        return AgentChatConversation(
            id=str(row.get("id") or ""),
            user_id=str(row.get("user_id") or ""),
            title=title or "Agent conversation",
            status=str(row.get("status") or "active"),
            model=str(row.get("model")) if row.get("model") else None,
            message_count=int(row.get("message_count") or 0),
            created_at=_iso(row.get("created_at")),
            updated_at=_iso(row.get("updated_at")),
            last_message_at=_iso(row.get("last_message_at")),
        )

    def _message_from_row(self, row: dict[str, Any]) -> AgentChatMessage:
        try:
            content = self._decrypt_text(row, "content")
        except Exception:
            logger.warning("agent_chat.message_decrypt_failed message_id=%s", row.get("id"))
            content = ""
        metadata: dict | None = None
        if row.get("metadata_ciphertext"):
            try:
                raw = self._decrypt_text(row, "metadata")
                parsed = json.loads(raw) if raw else None
                metadata = parsed if isinstance(parsed, dict) else None
            except Exception:
                logger.warning("agent_chat.metadata_decrypt_failed message_id=%s", row.get("id"))
                metadata = None
        return AgentChatMessage(
            id=str(row.get("id") or ""),
            conversation_id=str(row.get("conversation_id") or ""),
            user_id=str(row.get("user_id") or ""),
            role=str(row.get("role") or ""),
            status=str(row.get("status") or "complete"),
            content=content,
            model=str(row.get("model")) if row.get("model") else None,
            created_at=_iso(row.get("created_at")),
            completed_at=_iso(row.get("completed_at")),
            metadata=metadata,
        )


_agent_chat_service: AgentChatService | None = None


def get_agent_chat_service() -> AgentChatService:
    global _agent_chat_service
    if _agent_chat_service is None:
        _agent_chat_service = AgentChatService()
    return _agent_chat_service
