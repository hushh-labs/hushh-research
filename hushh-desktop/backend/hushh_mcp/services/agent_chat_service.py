"""Gemini-backed Agent chat service with encrypted durable history."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncGenerator, Literal
from uuid import uuid4

import yaml
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types

from db.db_client import get_db
from hushh_mcp.hushh_adk.manifest import AgentModelConfig, ManifestLoader
from hushh_mcp.runtime_settings import get_core_security_settings
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
DEFAULT_AGENT_CHAT_MODEL = "gemini-2.5-pro"
KAI_AGENT_MANIFEST_PATH = Path(__file__).resolve().parents[1] / "agents" / "kai" / "agent.yaml"
AGENT_SYSTEM_PROMPT = """You are Agent, the Kai-focused financial assistant inside Hussh.

Current capability boundary:
- Focus on markets, portfolio context, stock analysis, Kai workflows, consent/privacy surfaces, and how the Hussh app works.
- Use the provided PKM context when it is relevant, especially when the user asks what Kai knows about them or shares preferences.
- The PKM context may contain decrypted session-only details supplied by the frontend after vault unlock. Treat it as user-authorized memory for this turn, not as exhaustive truth. Do not invent personal facts outside that context and the current conversation.
- If PKM context is present and the user asks to show, summarize, or reason over PKM, answer from that context. Do not claim Agent cannot access PKM.
- When the user explicitly asks to save, remember, or add durable personal context to PKM, use the frontend PKM tool. Do not say Agent cannot save to PKM.
- Normal finance and app questions should be answered as streaming text. Use concise GitHub-flavored Markdown with headings, lists, links, code, or tables when structure makes the answer easier to scan.
- When the stream includes a planned frontend app action, keep the reply to a short receipt. The frontend owns the actual navigation/action state.
- For Connected Systems / Salesforce CRM, read/create/update requests are frontend tool proposals. Create and update execution requires explicit user approval in Profile > Connected Systems. Delete is blocked in v1.
- Destructive, account-changing, trading, approval, revocation, and manual-only actions must be blocked and explained safely.
- Keep answers concise, practical, and clear. Financial answers are educational, not personalized investment advice.
"""

AGENT_ACTION_PLANNER_PROMPT = """You are Agent's action router inside Hussh.

Decide whether the latest user message needs a frontend app function.

Call exactly one function only when the user clearly asks Agent to do one of these:
- start stock analysis for a ticker or public company
- open a Hussh/Kai app surface
- save, remember, or add NEW durable personal context to the user's PKM
- update, change, correct, or fix an EXISTING value already stored in the user's PKM
- read a Salesforce CRM record or propose a Salesforce CRM create/update through Connected Systems
- perform a destructive, account-changing, consent approval/revocation, trading, or manual-only action that must be blocked

Choosing add_to_pkm vs update_pkm:
- Use update_pkm when the user references an existing record/attribute or asks to change/correct/fix it (e.g. "update my address", "change my name", "my email is now ...").
- Use add_to_pkm only when introducing brand-new information not already tracked.
- For update_pkm, set `domain` to one of the user's existing PKM domain keys listed in the PKM context provided for routing. Canonical domain keys include: identity, financial, subscriptions, health, travel, food, professional, ria, entertainment, shopping, social, location, general (plus financial subintents like financial.portfolio, financial.profile). Legal name, email, postal/home address, date of birth, and phone number route to the "identity" domain; money/portfolio facts belong in "financial"; location/mobility patterns (where the user travels or checks in) belong in "location". Prefer a domain key that already appears in the PKM context. Set `field_path` to the attribute being changed (dot notation if nested, e.g. "home_address" or "address.line1") and `proposed_value` to the new value. Include `current_value` only if the existing value is visible in the PKM context.

Do not call a function for normal finance questions, explanations, brainstorming, or general chat.
When unsure, do not call a function.
"""

_APP_SURFACE_ACTIONS: dict[str, tuple[str, str]] = {
    "consent_center": ("route.consents", "Open Consent Center"),
    "pkm": ("route.profile_pkm_agent_lab", "Open PKM"),
    "profile": ("route.profile", "Open Profile"),
    "portfolio_import": ("route.kai_import", "Open Portfolio Import"),
    "portfolio_dashboard": ("route.kai_dashboard", "Open Portfolio Dashboard"),
    "analysis_history": ("route.analysis_history", "Open Analysis History"),
    "optimize": ("route.kai_optimize", "Open Optimize Surface"),
    "market_home": ("route.kai_home", "Open Market Home"),
    "connected_systems": ("route.profile_connected_systems", "Open Connected Systems"),
}

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
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:market|kai home|home)\b",
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
        r"\b(?:revoke|approve|deny|grant)\b.*\b(?:consent|permission|request)\b", re.IGNORECASE
    ),
    re.compile(
        r"\b(?:disconnect|unlink)\b.*\b(?:account|bank|brokerage|gmail|google)\b", re.IGNORECASE
    ),
    re.compile(r"\b(?:sign out|log out|logout)\b", re.IGNORECASE),
    re.compile(r"\b(?:cancel|stop)\b.*\b(?:active\s+)?analysis\b", re.IGNORECASE),
    re.compile(
        r"\b(?:buy|sell|trade)\b.*\b(?:now|for me|on my behalf|in my account)\b", re.IGNORECASE
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

    def to_event_payload(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "action_id": self.action_id,
            "label": self.label,
            "execution": self.execution,
            "slots": self.slots,
            "message": self.message,
            "reason": self.reason,
        }


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
    provider = runtime_provider.strip().lower()
    key = user_key.strip()

    if not key:
        raise ValueError("User BYOK runtime key is required")

    if provider == "gemini":
        return genai.Client(vertexai=False, api_key=key)

    raise ValueError(f"Unsupported runtime provider: {provider}")


def create_managed_runtime_client(
    runtime_provider: str,
    *,
    project: str | None = None,
    location: str | None = None,
):
    provider = runtime_provider.strip().lower()

    resolved_project = (
        project
        or os.getenv("GOOGLE_CLOUD_PROJECT")
        or os.getenv("GCP_PROJECT")
    )
    
    if resolved_project:
        resolved_project = resolved_project.strip()

    resolved_location = (
        location
        or os.getenv("GOOGLE_CLOUD_LOCATION")
        or os.getenv("GCP_LOCATION")
        or os.getenv("GOOGLE_CLOUD_REGION")
        or "us-central1"
    )
    resolved_location = resolved_location.strip()

    if provider == "gemini":
        return genai.Client(
            vertexai=True,
            project=resolved_project,
            location=resolved_location,
        )

    raise ValueError(f"Unsupported runtime provider: {provider}")


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
    if normalized_reason in {"API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_SERVICE_BLOCKED"}:
        detail["likely_issue"] = "invalid_or_unauthorized_api_key"
        detail["operator_hint"] = "Check the Gemini API key saved in encrypted PKM."
    elif normalized_reason in {"CREDENTIALS_MISSING", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}:
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


def _runtime_provider_error_from_exception(error: Exception) -> AgentRuntimeProviderError:
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
        r"\b(?:inc|corp|corporation|company|plc|ltd|limited|class\s+[ab])\b", " ", normalized
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
                            enum=list(_APP_SURFACE_ACTIONS.keys()),
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
                            "Short safe reason explaining why Agent cannot perform the action."
                        )
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="read_crm_record",
                description=(
                    "Open the Connected Systems Salesforce CRM read workflow. Use when the "
                    "user asks to read, fetch, search, or look up a CRM Contact record."
                ),
                parameters=_schema_object(
                    {
                        "email": _schema_string("Contact email if the user supplied it."),
                        "phone": _schema_string("Contact phone if the user supplied it."),
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="propose_crm_create",
                description=(
                    "Open the Connected Systems Salesforce CRM create proposal workflow. "
                    "Execution will still require explicit user approval."
                ),
                parameters=_schema_object(
                    {
                        "email": _schema_string("Contact email if the user supplied it."),
                        "phone": _schema_string("Contact phone if the user supplied it."),
                        "first_name": _schema_string("Contact first name if supplied."),
                        "last_name": _schema_string("Contact last name if supplied."),
                        "additional_fields_json": _schema_string(
                            "Optional JSON object string for supported Salesforce fields."
                        ),
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="propose_crm_update",
                description=(
                    "Open the Connected Systems Salesforce CRM update proposal workflow. "
                    "Execution will still require explicit user approval."
                ),
                parameters=_schema_object(
                    {
                        "record_id": _schema_string(
                            "Salesforce record Id if the user supplied it."
                        ),
                        "additional_fields_json": _schema_string(
                            "Optional JSON object string for supported Salesforce fields to update."
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
            genai_types.FunctionDeclaration(
                name="update_pkm",
                description=(
                    "Update or correct an existing value already stored in the user's encrypted "
                    "PKM through the frontend PKM writer. Use when the user asks to update, change, "
                    "correct, or fix an existing personal record or attribute (for example "
                    "'update my address', 'change my name', 'my email is now ...'). Prefer this over "
                    "add_to_pkm whenever the user references something already tracked. The frontend "
                    "shows the user a confirmation panel before any write happens."
                ),
                parameters=_schema_object(
                    {
                        "domain": _schema_string(
                            "Target PKM domain key to update, chosen from the user's existing "
                            "domains in the PKM routing context. Canonical keys: identity, "
                            "financial, subscriptions, health, travel, food, professional, ria, "
                            "entertainment, shopping, social, location, general. Name, email, "
                            "postal/home address, date of birth, and phone number belong in the "
                            "'identity' domain."
                        ),
                        "field_path": _schema_string(
                            "Attribute being changed, dot notation if nested "
                            "(for example 'address' or 'address.line1')."
                        ),
                        "proposed_value": _schema_string(
                            "The new value the user wants stored for that attribute."
                        ),
                        "current_value": _schema_string(
                            "The existing value, only if visible in the PKM context. "
                            "Display-only; the write uses the authoritative stored value."
                        ),
                    },
                    required=["domain", "field_path", "proposed_value"],
                ),
            ),
        ]
    )


def _openai_tools_from_agent_action_tool() -> list[dict[str, Any]]:
    """Translate `_agent_action_tool()`'s Gemini-SDK declarations into the
    standard OpenAI `tools` array the local bridge expects. Reuses the same
    declarations rather than maintaining a second copy, so local and cloud
    action routing stay in sync automatically as the tool set evolves.
    """

    def _lower_types(node: Any) -> Any:
        if isinstance(node, dict):
            return {
                k: (v.lower() if k == "type" and isinstance(v, str) else _lower_types(v))
                for k, v in node.items()
            }
        if isinstance(node, list):
            return [_lower_types(v) for v in node]
        return node

    dumped = _agent_action_tool().model_dump(exclude_none=True)
    tools: list[dict[str, Any]] = []
    for decl in dumped.get("function_declarations", []):
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": decl["name"],
                    "description": decl.get("description", ""),
                    "parameters": _lower_types(
                        decl.get("parameters", {"type": "OBJECT", "properties": {}})
                    ),
                },
            }
        )
    return tools


class _OpenAIFunctionCallShim:
    """Adapts a bridge/OpenAI-shaped tool call into the Gemini FunctionCall
    duck type `_action_plan_from_function_call` already expects (`.name`,
    `.args`, `.id`), so local mode reuses that exact mapping instead of a
    parallel implementation.
    """

    def __init__(self, name: str, args: dict[str, Any], call_id: str):
        self.name = name
        self.args = args
        self.id = call_id


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
            self._client = create_managed_runtime_client(
                runtime_provider=self.runtime_manifest.model.provider,
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
        if runtime_credential_mode == "local":
            return PreparedAgentRuntime(
                mode="local",
                provider="local",
                model="Llama-3.2-3B-Instruct",
                credential_ref=None,
                client=None,
                evidence={"framework": "local"},
            )

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

        logger.info("agent_chat_runtime_evidence=%s", _redacted_runtime_evidence(bundle.evidence))
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
    ) -> AgentChatMessage:
        message_id = str(uuid4())
        encrypted = self._encrypt_text(content)
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

    def _build_local_bridge_messages(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        action_plan: AgentChatActionPlan | None,
        pkm_context: str | None,
    ) -> list[dict[str, str]]:
        """Message-building for the local bridge's actual reply generation
        (stream_response below). _plan_action_via_bridge builds its own,
        separate, more minimal context -- see that method for why.

        On-device NPU inference is far more compute-constrained than the
        cloud path, and prompt-processing time scales with total context
        size -- keep history/PKM context small so each turn's prefill stays
        fast instead of growing every turn as the conversation gets longer.
        """
        messages = [{"role": "system", "content": AGENT_SYSTEM_PROMPT}]
        local_history_limit = 3
        local_message_char_limit = 320
        local_pkm_char_limit = 1000
        for msg in history[-local_history_limit:]:
            if msg.role not in {"user", "assistant"}:
                continue
            messages.append({"role": "user" if msg.role == "user" else "assistant", "content": msg.content[:local_message_char_limit]})
        local_pkm_context = (pkm_context or "")[:local_pkm_char_limit]
        turn_context = self._build_turn_context(action_plan=action_plan, pkm_context=local_pkm_context)
        # The smaller on-device model follows the base system prompt's
        # "use PKM context when relevant" nuance far less reliably than
        # Gemini does, and tends to cite the PKM note on every turn even
        # for plain greetings/chit-chat. Gemini doesn't need this extra
        # nudge, so it's scoped to the local path only.
        local_relevance_reminder = (
            "Only mention or reference the PKM context above if the user's "
            "latest message is actually asking about their personal data, "
            "preferences, portfolio, or memory. For greetings, small talk, "
            "or general questions unrelated to their PKM data, respond "
            "naturally and do not bring up the PKM note."
        )
        # Added after direct testing this session across four candidate
        # models (1B, 3B, Phi-4-mini, and Qwen3.5-2B -- the one actually
        # shipped, see stream_response's payload comment): all four get
        # multi-step financial/compounding math wrong in some way. 1B's
        # shown work contradicted its own final number; 3B fabricated a
        # figure ~70% too high; Qwen3.5-2B got the lump-sum piece exactly
        # right but substituted the wrong period count into the annuity
        # formula, landing ~53% too low; only Phi-4-mini got a real
        # compounding test fully correct, but was 0-for-3 on trivial
        # single-step addition in the same session. No candidate is safe to
        # trust blind on arithmetic, so this guardrail stays regardless of
        # which model ships. Scoped to local mode only -- Gemini doesn't have
        # this failure mode and doesn't need the extra instruction.
        local_math_guardrail = (
            "This on-device model is unreliable at arithmetic beyond small "
            "single-step calculations, and especially unreliable at "
            "multi-step financial math (compounding, multi-year growth "
            "projections, portfolio/investment calculations with more than "
            "one step). For any question requiring that kind of "
            "calculation: do not present a precise final number as fact, "
            "and do not show fabricated step-by-step arithmetic that looks "
            "precise but may not be correct. Instead, give a rough, "
            "clearly-labeled approximation at most, and explicitly tell the "
            "user to verify the exact figure with a calculator or Kai's "
            "Portfolio/Analysis tools. Simple single-step arithmetic with "
            "small numbers is fine to answer directly."
        )
        # Defines this model's actual job, based on what it's demonstrated it
        # can and can't do reliably this session: fast and accurate at the
        # mechanical tool-calling tasks (navigation, PKM capture), unreliable
        # at open-ended reasoning/financial analysis/multi-step math. Rather
        # than keep trying to make the small on-device model good at
        # everything Gemini is good at, scope its job to what it's actually
        # good at and have it defer, briefly and confidently, on the rest.
        #
        # This scoping isn't just a quality workaround -- it's the correct
        # architectural role for this model. GenieX's 4096-token context
        # can't carry a full generalist agent loop (confirmed directly: real
        # Hermes Agent refuses to run at all below a 64K-token context), so
        # this on-device model was never meant to replace that loop. It's
        # meant to be a narrow, fast, local delegate for specific classifier-
        # style steps -- intent routing and PKM capture here -- the same
        # pattern the on-device-inference direction describes elsewhere (Kai
        # intent classification, Nav's privacy rules engine): small, local,
        # single-purpose, with the general-reasoning loop staying on a
        # large-context model. Keep this scope even if a larger/better local
        # model becomes available -- the point is the role, not the size.
        local_role_scope = (
            "Your most valuable and reliable job in this on-device mode is "
            "helping the user navigate to the right place in the app "
            "(open_app_surface) and capture or update their PKM data "
            "(add_to_pkm, update_pkm). Prioritize recognizing those requests "
            "confidently and precisely. For open-ended financial analysis, "
            "investment advice, or anything needing real calculation, keep "
            "your answer brief, do not attempt precise multi-step reasoning, "
            "and point the user to Kai's cloud-connected mode or Kai's "
            "Portfolio/Analysis tools for anything that needs real depth or "
            "precision."
        )
        messages.append({
            "role": "user",
            "content": (
                f"{turn_context}\n\n{local_relevance_reminder}\n\n"
                f"{local_math_guardrail}\n\n{local_role_scope}\n\n"
                f"Latest user message:\n{user_message}"
            ),
        })
        return messages

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
        # Route to on-device GenieX only when this is genuinely the local model.
        # A missing runtime_client in cloud mode is a real config/credential
        # error and must surface as such, not silently fall through to local.
        if runtime_model == "Llama-3.2-3B-Instruct":
            import aiohttp
            # Through the local bridge (local_bridge/), not GenieX directly --
            # the bridge guarantees a spec-correct finish_reason/[DONE] on the
            # stream, which GenieX itself doesn't reliably provide. No tools
            # needed here: action_plan was already resolved separately (see
            # _plan_action_via_bridge) and is woven into turn_context below.
            url = "http://localhost:18182/v1/chat/completions"
            messages = self._build_local_bridge_messages(
                user_message=user_message,
                history=history,
                action_plan=action_plan,
                pkm_context=pkm_context,
            )

            payload = {
                # Hybrid split: this reply-generation call uses Qwen3.5-2B
                # (most internally-coherent reasoner of four candidates
                # tested this session), while the separate action-plan
                # classifier call below (_plan_action_via_bridge) stays on
                # the 1B. Qwen3.5-2B's always-on <think> reasoning trace (no
                # way to disable it -- a "think" JSON field errors,
                # "/no_think" isn't honored and can trigger runaway
                # repetition) breaks GenieX whenever `tools` are attached to
                # a request -- confirmed down to a single minimal tool with
                # a 5-token completion ask still hitting
                # `context_length_exceeded` at ~345 prompt tokens, nowhere
                # near the assumed 4096 window. This call never attaches
                # `tools` (the classifier already resolved action_plan
                # separately -- see below), so it never hits that failure
                # mode, and gets the benefit of this model's better
                # reasoning for plain conversational replies. See
                # registry.js's GENIEX_MODEL_ID for the full history.
                "model": "unsloth/Qwen3.5-2B-GGUF",
                "messages": messages,
                "stream": True,
                "temperature": 0.7,
                # `max_tokens` (the field the GenieX docs themselves show) is
                # silently IGNORED by this installed GenieX version's HTTP
                # API -- confirmed via direct testing against this exact
                # endpoint: a request capped at 256 came back with 1,258
                # completion tokens. `max_completion_tokens` is the field
                # that's actually honored. Sized at 6000, not 1200: live
                # testing with the real production message (full
                # AGENT_SYSTEM_PROMPT plus the turn context, relevance
                # reminder, math guardrail, and role-scope text all stacked
                # into the user turn -- see _build_local_bridge_messages)
                # showed the thinking block alone routinely exceeding both
                # 1200 and 3000 tokens before ever closing, which meant the
                # model's raw internal reasoning was shown as the reply
                # verbatim, cut off mid-thought, with no real answer ever
                # produced. Verified directly against this exact endpoint,
                # with this exact message construction, that 6000 is enough
                # for the model to close its `</think>` block and produce a
                # complete, coherent answer (used well under budget in that
                # run). This raises worst-case latency substantially --
                # accepted tradeoff for a reply that's actually visible at
                # all; see the </think>-stripping logic below, which is the
                # other half of this fix.
                "max_completion_tokens": 6000,
            }

            # aiohttp.ClientSession defaults to a 300s total timeout if none
            # is given -- disable it so a genuinely slow (but progressing)
            # on-device generation is never cut off mid-stream.
            no_timeout = aiohttp.ClientTimeout(total=None)
            # Qwen3.5-2B always reasons before answering and closes that
            # block with a literal `</think>` marker (no opening tag is
            # emitted -- confirmed via direct probing of this exact
            # endpoint). Neither GenieX nor the bridge strips this, so
            # buffer deltas until the marker appears and only start
            # yielding text after it; otherwise the model's raw internal
            # reasoning is shown to the user as the reply, which is exactly
            # what live testing surfaced before this fix.
            think_close_marker = "</think>"
            think_buffer = ""
            seen_think_close = False
            async with aiohttp.ClientSession(timeout=no_timeout) as session:
                async with session.post(url, json=payload) as response:
                    if response.status != 200:
                        yield "Local engine connection failure"
                        return
                    async for line in response.content:
                        line = line.decode("utf-8").strip()
                        if not line.startswith("data:"):
                            continue
                        # GenieX emits "data:{...}" with no space after the colon,
                        # unlike the space-delimited "data: {...}" SSE convention.
                        payload_str = line[len("data:"):].strip()
                        if payload_str == "[DONE]":
                            continue
                        try:
                            data = json.loads(payload_str)
                            choice = data.get("choices", [{}])[0]
                            # GenieX normally streams token deltas, but for some
                            # (slow/heavy) completions it emits a single final
                            # frame in the non-streaming "message" shape instead.
                            delta = choice.get("delta", {}).get("content", "") or choice.get("message", {}).get("content", "")
                        except Exception as exc:
                            logger.warning(f"[LocalChat] Failed to parse GenieX SSE line: {exc!r} line={payload_str[:200]!r}")
                            continue
                        if not delta:
                            continue
                        if seen_think_close:
                            yield delta
                            continue
                        think_buffer += delta
                        marker_idx = think_buffer.find(think_close_marker)
                        if marker_idx != -1:
                            seen_think_close = True
                            remainder = think_buffer[marker_idx + len(think_close_marker):].lstrip("\n")
                            if remainder:
                                yield remainder
                            think_buffer = ""
            if not seen_think_close:
                # Ran out of budget while still inside the reasoning block --
                # nothing real was ever produced. Surface a clear message
                # instead of either silence or the raw partial reasoning.
                logger.warning(
                    "[LocalChat] Qwen3.5-2B never closed its </think> block "
                    "within max_completion_tokens -- no visible reply produced"
                )
                yield "Sorry, that took too long to think through -- please try again."
            return

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

    async def _plan_action_via_bridge(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        pkm_context: str | None = None,
    ) -> AgentChatActionPlan | None:
        """Local-mode action-plan classification via the local bridge's
        tool-calling translation (see local_bridge/), mirroring the cloud
        path's Gemini function-calling but through GenieX/llama.cpp instead.

        Kept intentionally tight on context -- GenieX's compiled window is a
        fixed 4096 tokens, and the tool schemas themselves already consume a
        meaningful chunk of that budget.

        A same-session experiment merged this with the final-reply call
        (single call, full context, temperature 0.7, max_tokens 640) to cut
        per-turn latency. Reverted: live testing showed no reliable win --
        short turns got faster (~39s), but longer/reasoning-heavy turns got
        WORSE (a timed-out merged call still paid for a full separate
        stream_response() fallback afterward, nearly 2 minutes total). Kept
        as two separate, purpose-built calls instead.
        """
        import aiohttp

        messages: list[dict[str, str]] = [
            {"role": "system", "content": AGENT_ACTION_PLANNER_PROMPT}
        ]
        for msg in history[-2:]:
            if msg.role not in {"user", "assistant"}:
                continue
            messages.append(
                {
                    "role": "user" if msg.role == "user" else "assistant",
                    "content": msg.content[:200],
                }
            )
        clean_pkm = str(pkm_context or "").strip()[:500]
        planning_context = clean_pkm or "No PKM context was provided for this turn."
        messages.append(
            {
                "role": "user",
                "content": (
                    f"PKM context for routing only:\n{planning_context}\n\n"
                    f"Latest user message:\n{user_message}"
                ),
            }
        )

        payload = {
            "model": "unsloth/Llama-3.2-1B-Instruct-GGUF",
            "messages": messages,
            "stream": False,
            "temperature": 0.0,
            # `max_tokens` is silently ignored by this GenieX version's HTTP
            # API (see stream_response's payload comment for the confirmed
            # repro) -- `max_completion_tokens` is the field that's actually
            # honored. 200 is fine for the 1B: unlike the reverted
            # Qwen3.5-2B attempt, it has no always-on reasoning trace eating
            # into this budget before the tool call itself.
            "max_completion_tokens": 200,
            "tools": _openai_tools_from_agent_action_tool(),
        }

        try:
            # 45s, not 20s: the 20s figure matched the bridge's old 15s
            # budget, both sized for the prior QAIRT/Qwen3-4B model's failure
            # mode (a slow call meant a multi-minute hang past a crash, so
            # failing fast was correct). The llama.cpp/Llama-3.2-1B runtime
            # doesn't hang like that -- live testing this session showed this
            # call normally resolving in 5-25s. (Briefly bumped to 70s during
            # the same-session Qwen3.5-2B attempt, reverted along with it --
            # see registry.js's GENIEX_MODEL_ID for why.)
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=45)) as session:
                async with session.post(
                    "http://localhost:18182/v1/chat/completions", json=payload
                ) as resp:
                    if resp.status != 200:
                        logger.warning(
                            f"[LocalChat] Action-plan bridge call returned {resp.status}"
                        )
                        return None
                    data = await resp.json()
        except Exception as exc:
            logger.warning(f"[LocalChat] Action-plan bridge call failed: {exc!r}")
            return None

        choice = (data.get("choices") or [{}])[0]
        tool_calls = choice.get("message", {}).get("tool_calls") or []
        for call in tool_calls:
            function = call.get("function", {})
            try:
                args = json.loads(function.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            shim = _OpenAIFunctionCallShim(
                name=function.get("name", ""),
                args=args,
                call_id=call.get("id") or _tool_call_id(),
            )
            action_plan = self._action_plan_from_function_call(shim)
            if action_plan is not None:
                return action_plan
        return None

    async def plan_action_with_gemini(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        runtime_client: Any,
        runtime_model: str,
        pkm_context: str | None = None,
    ) -> AgentChatActionPlan | None:
        # Key off the local model only (see stream_response): a missing cloud
        # runtime_client should not silently route into the local fallback.
        if runtime_model == "Llama-3.2-3B-Instruct":
            # Real tool-calling through the local bridge first (same mechanism
            # cloud mode uses, translated for GenieX -- see local_bridge/).
            # Falls back to the deterministic regex router if the model's
            # tool call doesn't resolve to a known action, or the bridge/
            # GenieX isn't reachable, rather than surfacing a hard failure.
            action_plan = await self._plan_action_via_bridge(
                user_message=user_message, history=history, pkm_context=pkm_context
            )
            if action_plan is not None:
                return action_plan
            return self.plan_action(user_message)
        crm_action = self._plan_crm_action(user_message)
        if crm_action is not None:
            return crm_action

        deterministic_block = self._plan_blocked_action(user_message)
        if deterministic_block is not None:
            return deterministic_block

        try:
            response = await runtime_client.aio.models.generate_content(
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
            )
            for function_call in self._function_calls_from_response(response):
                action_plan = self._action_plan_from_function_call(function_call)
                if action_plan is not None:
                    return action_plan
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

        return self.plan_action(user_message)

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

    def _plan_crm_action(self, user_message: str) -> AgentChatActionPlan | None:
        message = " ".join(str(user_message or "").split())
        if not message:
            return None

        if any(pattern.search(message) for pattern in _CRM_DELETE_PATTERNS):
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="connected_system.crm.delete",
                label="Blocked Salesforce CRM Delete",
                execution="blocked",
                slots={"systemId": "salesforce-fsc-customer0", "objectType": "Contact"},
                message=(
                    "Salesforce CRM delete is blocked in Agent v1. Open Connected Systems "
                    "and use a maintainer-only test path if this is intentional."
                ),
                reason="crm_delete_manual_only",
            )

        if any(pattern.search(message) for pattern in _CRM_UPDATE_PATTERNS):
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="connected_system.crm.update.propose",
                label="Propose Salesforce CRM Update",
                execution="frontend",
                slots={"systemId": "salesforce-fsc-customer0", "objectType": "Contact"},
                message="Opening Connected Systems so you can review and approve the CRM update.",
            )

        if any(pattern.search(message) for pattern in _CRM_CREATE_PATTERNS):
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="connected_system.crm.create.propose",
                label="Propose Salesforce CRM Create",
                execution="frontend",
                slots={"systemId": "salesforce-fsc-customer0", "objectType": "Contact"},
                message="Opening Connected Systems so you can review and approve the CRM create.",
            )

        if any(pattern.search(message) for pattern in _CRM_READ_PATTERNS):
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="connected_system.crm.read",
                label="Read Salesforce CRM Record",
                execution="frontend",
                slots={"systemId": "salesforce-fsc-customer0", "objectType": "Contact"},
                message="Opening Connected Systems for the Salesforce CRM read.",
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
            action = _APP_SURFACE_ACTIONS.get(surface)
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
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="connected_system.crm.read",
                label="Read Salesforce CRM Record",
                execution="frontend",
                slots={
                    "systemId": "salesforce-fsc-customer0",
                    "objectType": "Contact",
                    "email": str(args.get("email") or "").strip(),
                    "phone": str(args.get("phone") or "").strip(),
                },
                message="Opening Connected Systems for the Salesforce CRM read.",
            )

        if name == "propose_crm_create":
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="connected_system.crm.create.propose",
                label="Propose Salesforce CRM Create",
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
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="connected_system.crm.update.propose",
                label="Propose Salesforce CRM Update",
                execution="frontend",
                slots={
                    "systemId": "salesforce-fsc-customer0",
                    "objectType": "Contact",
                    "id": str(args.get("record_id") or "").strip(),
                    "additionalFieldsJson": str(args.get("additional_fields_json") or "").strip(),
                },
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

        if name == "update_pkm":
            domain = str(args.get("domain") or "").strip()
            field_path = str(args.get("field_path") or "").strip()
            proposed_value = str(args.get("proposed_value") or "").strip()
            current_value = str(args.get("current_value") or "").strip()
            # Without a domain, field, and new value the frontend cannot target an
            # update; do not emit a broken pkm.update (it would fall through to a
            # no-op review). The LLM receives PKM domain context to fill these.
            if not domain or not field_path or not proposed_value:
                return None
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="pkm.update",
                label="Update PKM",
                execution="frontend",
                slots={
                    "domain": domain,
                    "field_path": field_path,
                    "proposed_value": proposed_value,
                    "current_value": current_value,
                },
                message="Reviewing your PKM update for your confirmation.",
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
        )


_agent_chat_service: AgentChatService | None = None


def get_agent_chat_service() -> AgentChatService:
    global _agent_chat_service
    if _agent_chat_service is None:
        _agent_chat_service = AgentChatService()
    return _agent_chat_service
