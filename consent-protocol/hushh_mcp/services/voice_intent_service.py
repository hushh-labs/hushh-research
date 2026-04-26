import json
import logging
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from difflib import get_close_matches
from typing import Any

import httpx

from hushh_mcp.runtime_settings import get_voice_runtime_settings
from hushh_mcp.services.symbol_master_service import get_symbol_master_service
from hushh_mcp.services.ticker_cache import ticker_cache
from hushh_mcp.services.voice_action_manifest import get_voice_manifest_action
from hushh_mcp.services.voice_app_knowledge import (
    get_kai_voice_identity_context,
    looks_like_voice_knowledge_request,
    resolve_global_concept,
    resolve_surface_explanation,
    resolve_voice_explain_knowledge,
)
from hushh_mcp.services.voice_prompt_builder import (
    build_voice_planner_context,
    build_voice_planner_system_prompt,
    build_voice_response_composer_context,
    build_voice_response_composer_system_prompt,
)

logger = logging.getLogger(__name__)

_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
_OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions"
_OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"
_OPENAI_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
_OPENAI_HTTP_TIMEOUT_SECONDS = 45.0
_OPENAI_TTS_TIMEOUT_SECONDS = 20.0
_VOICE_LANGUAGE = "en"
_VOICE_STT_PROMPT = (
    "Transcribe spoken English only. Do not translate or transliterate. "
    "If the speech is unclear, keep the transcript short and in English."
)
_REALTIME_TRANSCRIPTION_LANGUAGE = _VOICE_LANGUAGE
_REALTIME_TRANSCRIPTION_PROMPT = _VOICE_STT_PROMPT
_REALTIME_NOISE_REDUCTION_TYPE = "near_field"
_REALTIME_SERVER_VAD_THRESHOLD = 0.72
_REALTIME_SERVER_VAD_PREFIX_PADDING_MS = 450
_VOICE_ENGLISH_ONLY_INPUT_MESSAGE = (
    "Kai voice currently supports English only. Please repeat your request in English."
)
_VOICE_TTS_INSTRUCTIONS = (
    "Speak in natural English only. Read the provided English text as written. "
    "Do not translate it, add non-English words, or switch languages."
)

_ALLOWED_TOOL_NAMES = {
    "execute_kai_command",
    "navigate_back",
    "resume_active_analysis",
    "cancel_active_analysis",
    "clarify",
}
_ALLOWED_COMMANDS = {
    "analyze",
    "optimize",
    "import",
    "consent",
    "profile",
    "history",
    "dashboard",
    "home",
}
_ALLOWED_HISTORY_TABS = {"history", "debate", "summary", "transcript"}
_PLANNER_NORMALIZATION_VERSION = "2026-04-21-canonical-plan-a"
_COMMAND_ALIASES = {
    "market": "home",
    "market_section": "home",
    "kai": "home",
    "kai_section": "home",
    "kai_home": "home",
    "consents": "consent",
    "consesns": "consent",
    "consense": "consent",
    "concent": "consent",
    "consets": "consent",
    "consent_section": "consent",
    "portfolio": "dashboard",
    "portfolio_section": "dashboard",
    "imports": "import",
    "import_section": "import",
    "profiel": "profile",
    "profle": "profile",
    "dash_board": "dashboard",
    "dashbord": "dashboard",
    "analysis": "history",
    "analysis_section": "history",
    "analysis_screen": "history",
    "analysis_page": "history",
    "analysis_tab": "history",
    "analysis_workspace": "history",
}
_ALLOWED_CONTEXT_KEYS = {
    "route",
    "stock_analysis_active",
    "last_tool_name",
    "last_ticker",
    "current_ticker",
    "has_portfolio_data",
    "structured_screen_context",
    "memory_short",
    "memory_retrieved",
    "planner_v2_enabled",
    "planner_turn_id",
}
_UNCLEAR_STT_MESSAGE = "I couldn\u2019t understand what you said, please repeat."
_MIN_ACTIONABLE_CHARS = 2
_TICKER_PATTERN_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,5}$")
_ANALYZE_TARGET_RE = re.compile(
    r"^\s*(?:analyze|analyse)\s+(?:stock|ticker|company|for|on|about)?\s*(?P<target>.+?)\s*$",
    re.IGNORECASE,
)
_ANALYZE_NOUN_TARGET_RE = re.compile(
    r"^\s*(?:start|run|begin|do|open)?\s*(?:the\s+)?analysis(?:\s+(?:for|of|on|about))?\s+(?P<target>.+?)\s*$",
    re.IGNORECASE,
)
_ANALYSIS_NAVIGATION_RE = re.compile(
    r"\b(?:(?:go|open|show|take|bring|navigate|move|head|get)(?:\s+me)?(?:\s+to)?|visit)\b.*\banalysis(?:\s+(?:section|screen|page|tab|history|workspace|area))?\b",
    re.IGNORECASE,
)
_FILLER_WORDS = {
    "uh",
    "um",
    "hmm",
    "huh",
    "ah",
    "eh",
    "noise",
    "static",
    "hello",
    "hey",
}
_COMPANY_ALIAS_TO_TICKER = {
    "google": "GOOGL",
    "alphabet": "GOOGL",
    "facebook": "META",
    "meta": "META",
    "apple": "AAPL",
    "microsoft": "MSFT",
    "amazon": "AMZN",
    "nvidia": "NVDA",
    "tesla": "TSLA",
    "netflix": "NFLX",
    "amd": "AMD",
    "advanced micro devices": "AMD",
}
_STATUS_QUERY_KEYWORDS = (
    "what is happening",
    "what's happening",
    "status",
    "running right now",
    "what is running",
    "active tasks",
)
_SCREEN_EXPLAIN_KEYWORDS = (
    "what is on my screen",
    "what's on my screen",
    "what is this screen",
    "what's this screen",
    "what is this page",
    "what's this page",
    "what is going on on my screen",
    "what is going on my screen",
    "what is going on on the screen",
    "what is going on the screen",
    "what is happening here",
    "what's happening here",
    "explain this screen",
    "explain this page",
    "explain this section",
)
_DETAIL_REQUEST_KEYWORDS = (
    "explain more",
    "go deeper",
    "break it down",
    "give me details",
    "more detail",
    "more details",
    "in detail",
)
_IMPORT_INTENT_KEYWORDS = (
    "import",
    "upload statement",
    "upload a statement",
    "scan statement",
    "portfolio import",
)
_RESUME_INTENT_KEYWORDS = (
    "resume",
    "continue analysis",
    "open active analysis",
)
_CANCEL_INTENT_KEYWORDS = (
    "cancel analysis",
    "stop analysis",
    "stop the analysis",
)
_NAV_COMMAND_KEYWORDS = (
    ("dashboard", "dashboard"),
    ("portfolio", "dashboard"),
    ("import", "import"),
    ("upload statement", "import"),
    ("portfolio import", "import"),
    ("analysis history", "history"),
    ("open history", "history"),
    ("history tab", "history"),
    ("history", "history"),
    ("home", "home"),
    ("market", "home"),
    ("profile", "profile"),
    ("consent", "consent"),
    ("consents", "consent"),
    ("optimize", "optimize"),
)
_SCREEN_ACTION_HINTS = {
    "home": "You can ask me to open dashboard, profile, consents, or start analysis for a ticker.",
    "dashboard": "You can ask me to explain positions, open profile, or start analysis for a ticker.",
    "analysis": "You can ask me to start analysis for a ticker, resume active analysis, or cancel analysis.",
    "import": "You can ask me to open import, check import status, or resume analysis.",
    "profile": "You can ask me to open dashboard, consents, or explain profile signals.",
    "consent": "You can ask me to review consent signals or navigate back to dashboard.",
    "history": "You can ask me to open a different history tab, resume analysis, or go back.",
}
_DESTRUCTIVE_INTENT_KEYWORDS = (
    "delete account",
    "delete my account",
    "remove account",
    "erase account",
    "delete imported data",
    "erase imported data",
    "wipe my data",
    "clear all data",
)


def _parse_model_candidates(raw: str | None, *, default_models: list[str]) -> list[str]:
    source = raw.strip() if isinstance(raw, str) else ""
    candidates = source.split(",") if source else default_models
    normalized: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        model = str(item or "").strip()
        if not model or model in seen:
            continue
        seen.add(model)
        normalized.append(model)
    return normalized or ["gpt-4o-mini"]


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _prioritize_tts_models(
    parsed_models: list[str],
    *,
    configured_model: str,
    prefer_quality: bool,
) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()

    def _add(model_name: str) -> None:
        normalized = str(model_name or "").strip()
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        ordered.append(normalized)

    # Keep the known-working model first for stable latency in live runtime.
    _add("gpt-4o-mini-tts")
    _add(configured_model)
    for model in parsed_models:
        _add(model)
    if prefer_quality:
        _add("gpt-4o-tts")
    return ordered or ["gpt-4o-mini-tts"]


def _is_retryable_model_error(status_code: int, payload: Any) -> bool:
    if status_code not in {400, 403, 404}:
        return False
    detail = (_extract_openai_error(payload) or "").lower()
    if not detail:
        return False
    keywords = (
        "model",
        "not found",
        "does not exist",
        "not available",
        "not permitted",
        "access",
    )
    return any(key in detail for key in keywords)


def _is_model_unavailable_error(status_code: int, payload: Any) -> bool:
    if status_code not in {400, 403, 404}:
        return False
    detail = (_extract_openai_error(payload) or "").lower()
    if not detail:
        return False
    unavailable_keywords = (
        "does not exist",
        "not found",
        "model",
        "not available",
        "do not have access",
        "you do not have access",
    )
    return any(keyword in detail for keyword in unavailable_keywords)


async def _post_with_model_fallback(
    *,
    url: str,
    headers: dict[str, str],
    candidate_models: list[str],
    body_builder: Callable[[str], dict[str, Any]],
    timeout_seconds: float = _OPENAI_HTTP_TIMEOUT_SECONDS,
    attempt_hook: Callable[[dict[str, Any]], None] | None = None,
    allow_model_fallback: bool = True,
) -> tuple[httpx.Response, dict[str, Any], int, str]:
    last_response: httpx.Response | None = None
    last_payload: dict[str, Any] = {}
    last_elapsed_ms = 0
    models_to_try = (
        list(candidate_models[:1]) if not allow_model_fallback else list(candidate_models)
    )
    if not models_to_try:
        raise VoiceServiceError(500, "Voice model selection failed before request")
    last_model = models_to_try[0]

    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        for index, model_name in enumerate(models_to_try):
            request_kwargs = body_builder(model_name)
            if attempt_hook:
                attempt_hook(
                    {
                        "event": "upstream_started",
                        "model_candidate_order": list(models_to_try),
                        "model_attempted": model_name,
                        "attempt_index": index + 1,
                        "attempt_count": len(models_to_try),
                        "timeout_seconds": timeout_seconds,
                        "fallback_enabled": allow_model_fallback,
                    }
                )
            started_at = time.perf_counter()
            try:
                response = await client.post(
                    url,
                    headers=headers,
                    **request_kwargs,
                )
            except Exception as error:
                elapsed_ms = int((time.perf_counter() - started_at) * 1000)
                if attempt_hook:
                    attempt_hook(
                        {
                            "event": "upstream_failed",
                            "model_used": model_name,
                            "elapsed_ms": elapsed_ms,
                            "exception_type": type(error).__name__,
                            "upstream_error_message": str(error),
                            "upstream_error_payload": None,
                            "will_retry": False,
                            "next_model": None,
                        }
                    )
                raise
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            payload = response.json() if response.content else {}

            if response.status_code < 400:
                if attempt_hook:
                    attempt_hook(
                        {
                            "event": "upstream_finished",
                            "model_used": model_name,
                            "elapsed_ms": elapsed_ms,
                            "status_code": response.status_code,
                            "payload": payload,
                        }
                    )
                return response, payload, elapsed_ms, model_name

            last_response = response
            last_payload = payload
            last_elapsed_ms = elapsed_ms
            last_model = model_name

            should_retry = (
                allow_model_fallback
                and index < len(models_to_try) - 1
                and _is_retryable_model_error(response.status_code, payload)
            )
            if attempt_hook:
                attempt_hook(
                    {
                        "event": "upstream_failed",
                        "model_used": model_name,
                        "elapsed_ms": elapsed_ms,
                        "status_code": response.status_code,
                        "exception_type": None,
                        "upstream_error_message": _extract_openai_error(payload),
                        "upstream_error_payload": payload.get("error")
                        if isinstance(payload, dict)
                        else payload,
                        "will_retry": should_retry,
                        "next_model": models_to_try[index + 1]
                        if should_retry and index + 1 < len(models_to_try)
                        else None,
                        "fallback_enabled": allow_model_fallback,
                    }
                )
            if should_retry:
                logger.warning(
                    "[VOICE_MODEL_FALLBACK] model=%s status=%s error=%s next_model=%s",
                    model_name,
                    response.status_code,
                    _extract_openai_error(payload),
                    models_to_try[index + 1],
                )
                continue

            return response, payload, elapsed_ms, model_name

    if last_response is None:
        raise VoiceServiceError(500, "Voice model selection failed before request")
    return last_response, last_payload, last_elapsed_ms, last_model


def _compact_context(value: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    compact: dict[str, Any] = {}
    for key in _ALLOWED_CONTEXT_KEYS:
        if key not in value:
            continue
        raw = value.get(key)
        if key == "structured_screen_context":
            if isinstance(raw, dict):
                compact[key] = raw
            continue
        if key in {"memory_short", "memory_retrieved"}:
            if isinstance(raw, list):
                compact[key] = raw[:8]
            continue
        if isinstance(raw, bool):
            compact[key] = raw
            continue
        if raw is None:
            compact[key] = None
            continue
        if isinstance(raw, (int, float)):
            compact[key] = raw
            continue
        text = str(raw).strip()
        if not text:
            continue
        compact[key] = text[:64]
    return compact


def _coerce_bool(value: Any, *, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    return default


def _coerce_str(value: Any, *, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _coerce_str_or_none(value: Any) -> str | None:
    text = _coerce_str(value)
    return text or None


def _coerce_int(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def _coerce_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = _coerce_str(item)
        if text:
            out.append(text)
    return out


def _contains_any(lowered_text: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword in lowered_text for keyword in keywords)


def _is_screen_explain_intent(lowered_text: str) -> bool:
    if _contains_any(lowered_text, _SCREEN_EXPLAIN_KEYWORDS):
        return True
    if _is_screen_capability_intent(lowered_text):
        return True
    return bool(
        re.search(
            r"\bwhat(?:'s| is)\s+(?:going on|happening)\s+(?:on\s+)?(?:my|the)\s+screen\b",
            lowered_text,
        )
    )


def _is_screen_capability_intent(lowered_text: str) -> bool:
    return bool(
        re.search(
            r"\bwhat can (?:you|i) do(?: here| on (?:this screen|this page))\b",
            lowered_text,
        )
    )


def _wants_detailed_response(lowered_text: str) -> bool:
    if _contains_any(lowered_text, _DETAIL_REQUEST_KEYWORDS):
        return True
    return bool(re.search(r"\bwhy\b", lowered_text))


def _match_surface_navigation_intent(lowered_text: str) -> str | None:
    if re.search(r"\b(open|show|go to|take me to)\b.*\bgmail\b", lowered_text):
        return "gmail"
    if re.search(r"\b(open|show|go to|take me to)\b.*\b(receipts?)\b", lowered_text):
        return "receipts"
    if re.search(
        r"\b(open|show|go to|take me to)\b.*\b(pkm|pkm agent lab|personal knowledge model)\b",
        lowered_text,
    ):
        return "pkm_agent_lab"
    return None


def _is_receipts_memory_intent(lowered_text: str) -> bool:
    return bool(
        re.search(r"\b(add|build|refresh|save)\b.*\b(receipts?)\b.*\bpkm\b", lowered_text)
        or re.search(r"\b(receipts?)\b.*\b(memory|preview)\b", lowered_text)
    )


def _spoken_command_label(command: str) -> str:
    normalized = _COMMAND_ALIASES.get(_coerce_str(command).lower(), _coerce_str(command).lower())
    labels = {
        "home": "market",
        "dashboard": "dashboard",
        "import": "import",
        "history": "history",
        "profile": "profile",
        "consent": "consents",
        "optimize": "optimize",
    }
    return labels.get(normalized, normalized or "that")


def _is_generic_execute_message(message: str) -> bool:
    normalized = _coerce_str(message).lower().rstrip(".!?")
    return normalized in {
        "working on that now",
        "done",
        "okay",
        "ok",
        "sure",
    }


def _build_execute_message(tool_call: dict[str, Any] | None) -> str:
    if not isinstance(tool_call, dict):
        return "Working on that now."
    tool_name = _coerce_str(tool_call.get("tool_name"))
    args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else {}
    if tool_name == "navigate_back":
        return "Going back."
    if tool_name == "resume_active_analysis":
        return "Resuming analysis."
    if tool_name == "cancel_active_analysis":
        return "Cancelling analysis."
    if tool_name == "execute_kai_command":
        command = _coerce_str(args.get("command"))
        params = args.get("params") if isinstance(args.get("params"), dict) else {}
        if command == "analyze":
            symbol = _coerce_str(params.get("symbol")).upper()
            return f"Starting analysis for {symbol}." if symbol else "Starting analysis."
        return f"Opening {_spoken_command_label(command)}."
    return "Working on that now."


_COMMAND_TO_CANONICAL_ACTION_ID = {
    "home": "route.kai_home",
    "dashboard": "route.kai_dashboard",
    "history": "route.analysis_history",
    "import": "route.kai_import",
    "consent": "route.consents",
    "profile": "route.profile",
    "optimize": "route.kai_optimize",
    "analyze": "analysis.start",
}
_VOICE_TOOL_TO_CANONICAL_ACTION_ID = {
    "resume_active_analysis": "analysis.resume_active",
    "cancel_active_analysis": "analysis.cancel_active",
}
_CANONICAL_ACTION_ID_TO_COMMAND = {
    action_id: command for command, action_id in _COMMAND_TO_CANONICAL_ACTION_ID.items()
}
_CANONICAL_ACTION_ID_TO_VOICE_TOOL = {
    action_id: tool_name for tool_name, action_id in _VOICE_TOOL_TO_CANONICAL_ACTION_ID.items()
}


def _coerce_slot_value(value: Any) -> str | int | float | bool | None:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return _coerce_str(value) or None


def _canonical_action_id_from_tool_call(tool_call: dict[str, Any] | None) -> str | None:
    if not isinstance(tool_call, dict):
        return None
    tool_name = _coerce_str(tool_call.get("tool_name"))
    args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else {}
    if tool_name == "execute_kai_command":
        command = _COMMAND_ALIASES.get(_coerce_str(args.get("command")).lower())
        normalized_command = command or _coerce_str(args.get("command")).lower()
        return _COMMAND_TO_CANONICAL_ACTION_ID.get(normalized_command)
    return _VOICE_TOOL_TO_CANONICAL_ACTION_ID.get(tool_name)


def _canonical_slots_from_tool_call(tool_call: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(tool_call, dict):
        return {}
    tool_name = _coerce_str(tool_call.get("tool_name"))
    args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else {}
    if tool_name == "execute_kai_command":
        slots: dict[str, Any] = {}
        command = _coerce_str(args.get("command"))
        if command:
            slots["command"] = command
        params = args.get("params") if isinstance(args.get("params"), dict) else {}
        for key, value in params.items():
            normalized = _coerce_slot_value(value)
            if normalized is not None:
                slots[key] = normalized
        return slots
    return {
        key: normalized
        for key, value in args.items()
        if (normalized := _coerce_slot_value(value)) is not None
    }


def _is_executable_tool_call(tool_call: dict[str, Any] | None) -> bool:
    if not isinstance(tool_call, dict):
        return False
    return _coerce_str(tool_call.get("tool_name")) in {
        "execute_kai_command",
        "navigate_back",
        "resume_active_analysis",
        "cancel_active_analysis",
    }


def _is_executable_mode(mode: str | None) -> bool:
    return _coerce_str(mode) in {"execute_and_wait", "start_background_and_ack"}


def _legacy_tool_call_from_action(
    action_id: str | None,
    *,
    slots: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    normalized_action_id = _coerce_str(action_id)
    normalized_slots = dict(slots or {})
    if not normalized_action_id:
        return None
    if normalized_action_id == "route.back":
        return {"tool_name": "navigate_back", "args": {}}

    voice_tool_name = _CANONICAL_ACTION_ID_TO_VOICE_TOOL.get(normalized_action_id)
    if voice_tool_name:
        args = {
            key: value
            for key, value in normalized_slots.items()
            if key != "command" and value is not None
        }
        return {"tool_name": voice_tool_name, "args": args}

    command = _CANONICAL_ACTION_ID_TO_COMMAND.get(normalized_action_id)
    if not command:
        return None

    args: dict[str, Any] = {"command": command}
    params = {
        key: value
        for key, value in normalized_slots.items()
        if key != "command" and value is not None
    }
    if params:
        args["params"] = params
    return {"tool_name": "execute_kai_command", "args": args}


def _response_has_executable_plan(response: dict[str, Any] | None) -> bool:
    if not isinstance(response, dict):
        return False
    tool_call = response.get("tool_call")
    if _coerce_bool(response.get("execution_allowed")):
        return True
    mode = _coerce_str(response.get("mode"))
    if _is_executable_mode(mode):
        return bool(_coerce_str(response.get("action_id")) or _is_executable_tool_call(tool_call))
    return _coerce_str(response.get("kind")) == "execute" and _is_executable_tool_call(tool_call)


def _heuristic_completion_mode(action_id: str | None, *, mode: str) -> str:
    if mode not in {"execute_and_wait", "start_background_and_ack"}:
        return "none"
    action = get_voice_manifest_action(action_id)
    if isinstance(action, dict):
        completion_mode = _coerce_str(action.get("completion_mode"))
        if completion_mode and completion_mode != "none":
            return completion_mode
    normalized_action_id = _coerce_str(action_id)
    if not normalized_action_id:
        return "none"
    if normalized_action_id == "analysis.start":
        return "background_start"
    if (
        normalized_action_id.startswith("route.")
        or normalized_action_id == "analysis.resume_active"
    ):
        return "route_settle"
    return "none"


def _manifest_execution_policy(action_id: str | None) -> str:
    action = get_voice_manifest_action(action_id)
    risk = (
        action.get("risk")
        if isinstance(action, dict) and isinstance(action.get("risk"), dict)
        else {}
    )
    return _coerce_str(risk.get("execution_policy")) or "allow_direct"


def _guard_status(
    guard_id: str,
    *,
    gate_state: dict[str, Any],
    has_active_analysis: bool,
    has_portfolio_data: bool,
    response: dict[str, Any],
) -> tuple[str, str | None]:
    if guard_id == "auth_signed_in":
        satisfied = bool(gate_state.get("signed_in"))
        return (
            "satisfied" if satisfied else "blocked",
            None if satisfied else "User is not signed in.",
        )
    if guard_id == "vault_unlocked":
        satisfied = bool(
            gate_state.get("vault_unlocked")
            and gate_state.get("token_available")
            and gate_state.get("token_valid")
        )
        return (
            "satisfied" if satisfied else "blocked",
            None if satisfied else "Vault access is not currently available.",
        )
    if guard_id == "portfolio_required":
        satisfied = bool(has_portfolio_data)
        return (
            "satisfied" if satisfied else "blocked",
            None if satisfied else "Portfolio data is required for this action.",
        )
    if guard_id == "analysis_idle_required":
        satisfied = not has_active_analysis
        return (
            "satisfied" if satisfied else "blocked",
            None if satisfied else "Another analysis run is already active.",
        )
    if guard_id == "active_analysis_required":
        satisfied = bool(has_active_analysis)
        return (
            "satisfied" if satisfied else "blocked",
            None if satisfied else "No active analysis run is available.",
        )
    if guard_id == "explicit_user_confirmation":
        args = (
            response.get("tool_call", {}).get("args")
            if isinstance(response.get("tool_call"), dict)
            else {}
        )
        confirmed = bool(isinstance(args, dict) and args.get("confirm") is True)
        return (
            "satisfied" if confirmed else "unknown",
            None
            if confirmed
            else "Explicit confirmation is modeled separately in the legacy payload.",
        )
    if guard_id == "manual_user_execution":
        return ("unknown", "This action still requires the on-screen control.")
    if guard_id == "gmail_connected":
        return ("unknown", "Gmail connection state is not modeled in the backend voice planner.")
    if guard_id == "gmail_configured":
        return ("unknown", "Gmail configuration state is not modeled in the backend voice planner.")
    return ("unknown", None)


def _canonical_guards_for_action(
    action_id: str | None,
    *,
    gate_state: dict[str, Any],
    has_active_analysis: bool,
    has_portfolio_data: bool,
    response: dict[str, Any],
) -> list[str]:
    del gate_state
    del has_active_analysis
    del has_portfolio_data
    del response
    action = get_voice_manifest_action(action_id)
    guard_entries = action.get("guards") if isinstance(action, dict) else []
    return [
        guard_id
        for raw_guard in guard_entries or []
        if (guard_id := _coerce_str(raw_guard.get("id")))
    ]


def _canonical_mode_for_response(response: dict[str, Any], *, action_id: str | None) -> str:
    return _canonical_mode_for_response_with_policy(
        response,
        action_id=action_id,
        execution_policy=_manifest_execution_policy(action_id),
        blocked_guards=[],
        unknown_guards=[],
    )


def _canonical_mode_for_response_with_policy(
    response: dict[str, Any],
    *,
    action_id: str | None,
    execution_policy: str,
    blocked_guards: list[str],
    unknown_guards: list[str],
) -> str:
    kind = _coerce_str(response.get("kind"))
    if kind == "clarify":
        return "clarify"
    if blocked_guards:
        return "answer_now"
    if execution_policy in {"manual_only", "confirm_required"} and action_id:
        return "answer_now"
    if "manual_user_execution" in unknown_guards or "explicit_user_confirmation" in unknown_guards:
        return "answer_now"
    if kind == "background_started":
        return "start_background_and_ack"
    if kind == "execute":
        if action_id == "analysis.start":
            return "start_background_and_ack"
        return "execute_and_wait"
    if kind == "speak_only" and action_id:
        if action_id == "analysis.start":
            return "start_background_and_ack"
        return "execute_and_wait"
    return "answer_now"


def _canonical_reply_strategy_for_response(mode: str) -> str:
    del mode
    return "llm"


def _blocked_reason_for_guard(guard_id: str) -> str:
    return {
        "auth_signed_in": "auth_required",
        "vault_unlocked": "vault_required",
        "portfolio_required": "portfolio_required",
        "analysis_idle_required": "analysis_active",
        "active_analysis_required": "active_analysis_required",
        "gmail_connected": "gmail_connected_required",
        "gmail_configured": "gmail_config_required",
    }.get(guard_id, "action_blocked")


def _guard_blocked_message(action_id: str | None, guard_id: str) -> str:
    if guard_id == "portfolio_required":
        if action_id == "analysis.start":
            return "I can start that analysis in Kai once your portfolio data is available."
        return "I can do that in Kai once portfolio data is available."
    if guard_id == "analysis_idle_required":
        return "Another analysis is already running in Kai right now."
    if guard_id == "active_analysis_required":
        if action_id == "analysis.resume_active":
            return "I can resume the analysis once an active run exists in Kai."
        if action_id == "analysis.cancel_active":
            return "I can cancel the analysis once an active run exists in Kai."
        return "I can do that once an active analysis run exists in Kai."
    if guard_id == "gmail_connected":
        return "I can do that after Gmail is connected in Kai."
    if guard_id == "gmail_configured":
        return "I can do that after the Gmail receipts workflow is configured in Kai."
    return "That action is not available right now."


def _manual_only_message(action_id: str | None, execution_policy: str) -> str:
    if action_id == "analysis.cancel_active":
        return "Kai can cancel the active analysis, but this step still needs the on-screen confirmation."
    if execution_policy == "confirm_required":
        return (
            "Kai supports that action, but it needs confirmation in the app before I can continue."
        )
    return "Kai supports that action, but it still needs the on-screen control to finish."


def _apply_action_contract_to_response(
    response: dict[str, Any],
    *,
    action_id: str | None,
    execution_policy: str,
    blocked_guards: list[str],
    unknown_guards: list[str],
) -> dict[str, Any]:
    finalized = dict(response)
    if blocked_guards:
        primary_guard = blocked_guards[0]
        finalized["kind"] = "blocked"
        finalized["reason"] = _blocked_reason_for_guard(primary_guard)
        finalized["message"] = _guard_blocked_message(action_id, primary_guard)
        finalized["execution_allowed"] = False
        return finalized
    if action_id and (
        execution_policy in {"manual_only", "confirm_required"}
        or "manual_user_execution" in unknown_guards
        or "explicit_user_confirmation" in unknown_guards
    ):
        finalized["kind"] = "speak_only"
        finalized["reason"] = (
            "confirmation_required"
            if execution_policy == "confirm_required"
            or "explicit_user_confirmation" in unknown_guards
            else "manual_user_execution_required"
        )
        finalized["message"] = _manual_only_message(action_id, execution_policy)
        finalized["execution_allowed"] = False
        return finalized
    return finalized


def _canonical_clarification_for_response(response: dict[str, Any]) -> dict[str, Any] | None:
    if _coerce_str(response.get("kind")) != "clarify":
        return None
    message = _coerce_str(response.get("message")) or _UNCLEAR_STT_MESSAGE
    reason = _coerce_str(response.get("reason")) or "intent_ambiguous"
    clarification: dict[str, Any] = {
        "reason": reason,
        "question": message,
    }
    candidate = _coerce_str_or_none(response.get("candidate"))
    if candidate:
        clarification["candidate"] = candidate
    return clarification


def _normalize_banker_message(
    message: str,
    *,
    kind: str,
    tool_call: dict[str, Any] | None,
) -> str:
    text = re.sub(r"\s+", " ", _coerce_str(message)).strip()
    if not text:
        if kind == "execute":
            text = _build_execute_message(tool_call)
        return text
    text = re.sub(
        r"^(?:absolutely|great question|happy to help)\b[,\-: ]*",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()
    text = re.sub(
        r"^(?:let me|here(?:'| i)?s what i found)\b[,\-: ]*",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()
    if kind == "execute" and _is_generic_execute_message(text):
        text = _build_execute_message(tool_call)
    if text and text[-1] not in ".!?":
        text = f"{text}."
    return text


def _titleize_label(value: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[_\-]+", " ", _coerce_str(value))).strip().title()


def _read_structured_screen_context(
    legacy_context: dict[str, Any],
) -> tuple[
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
]:
    structured = (
        legacy_context.get("structured_screen_context")
        if isinstance(legacy_context.get("structured_screen_context"), dict)
        else {}
    )
    route = structured.get("route") if isinstance(structured.get("route"), dict) else {}
    ui = structured.get("ui") if isinstance(structured.get("ui"), dict) else {}
    runtime = structured.get("runtime") if isinstance(structured.get("runtime"), dict) else {}
    surface = structured.get("surface") if isinstance(structured.get("surface"), dict) else {}
    screen_metadata = (
        structured.get("screen_metadata")
        if isinstance(structured.get("screen_metadata"), dict)
        else {}
    )
    return structured, route, ui, runtime, surface, screen_metadata


def _format_action_hint(actions: list[str]) -> str | None:
    normalized = [_coerce_str(action) for action in actions if _coerce_str(action)]
    if not normalized:
        return None
    lowered = [action[:1].lower() + action[1:] if action else action for action in normalized[:3]]
    if len(lowered) == 1:
        return f"You can {lowered[0]}."
    if len(lowered) == 2:
        return f"You can {lowered[0]} or {lowered[1]}."
    return f"You can {lowered[0]}, {lowered[1]}, or {lowered[2]}."


def _screen_label(screen: str, pathname: str) -> str:
    labels = {
        "home": "market home",
        "kai_market": "market home",
        "dashboard": "portfolio dashboard",
        "kai_portfolio_dashboard": "portfolio dashboard",
        "kai_portfolio_bootstrap": "portfolio",
        "kai_portfolio_import": "portfolio import",
        "kai_portfolio_import_progress": "portfolio import",
        "kai_portfolio_import_complete": "portfolio import",
        "kai_portfolio_review": "portfolio review",
        "kai_portfolio_analysis": "portfolio analysis",
        "analysis": "analysis",
        "kai_analysis": "analysis",
        "kai_analysis_workspace": "analysis workspace",
        "kai_analysis_history": "analysis history",
        "import": "import",
        "kai_import": "import",
        "optimize": "optimize",
        "kai_optimize": "optimize",
        "profile": "profile",
        "profile_account": "profile",
        "profile_preferences": "profile preferences",
        "profile_privacy": "profile privacy",
        "profile_gmail_panel": "Gmail connector",
        "profile_support_panel": "support panel",
        "profile_security_panel": "vault security",
        "profile_receipts": "receipts",
        "profile_pkm_agent_lab": "PKM Agent Lab",
        "consent": "consent center",
        "consents": "consent center",
        "history": "analysis history",
    }
    if screen in labels:
        return labels[screen]
    if pathname.startswith("/profile"):
        return "profile"
    if pathname.startswith("/kai"):
        return "Kai"
    return "Kai"


def _screen_action_hint(screen: str, pathname: str) -> str | None:
    if screen in _SCREEN_ACTION_HINTS:
        return _SCREEN_ACTION_HINTS[screen]
    if screen.startswith("profile"):
        return _SCREEN_ACTION_HINTS.get("profile")
    if screen in {
        "analysis",
        "kai_analysis",
        "kai_analysis_workspace",
        "kai_analysis_history",
    } or pathname.startswith("/kai/analysis"):
        return _SCREEN_ACTION_HINTS.get("analysis")
    if screen in {
        "kai_portfolio_bootstrap",
        "kai_portfolio_import",
        "kai_portfolio_import_progress",
        "kai_portfolio_import_complete",
        "kai_portfolio_review",
        "kai_portfolio_dashboard",
        "kai_portfolio_analysis",
        "dashboard",
    } or pathname.startswith("/kai/portfolio"):
        return _SCREEN_ACTION_HINTS.get("dashboard")
    if screen in {"home", "kai_market"} or pathname in {"/kai", "/kai/home"}:
        return _SCREEN_ACTION_HINTS.get("home")
    if screen in {"import", "kai_import"} or pathname.startswith("/kai/import"):
        return _SCREEN_ACTION_HINTS.get("import")
    if screen in {"consent", "consents"} or pathname.startswith("/consents"):
        return _SCREEN_ACTION_HINTS.get("consent")
    return None


def _preferred_screen_key(
    structured_route: dict[str, Any],
    structured_surface: dict[str, Any],
    route_state: dict[str, Any],
) -> str:
    surface_screen = _coerce_str(
        structured_surface.get("screen_id") or structured_surface.get("screenId")
    )
    if surface_screen:
        return surface_screen
    route_screen = _coerce_str(structured_route.get("screen"))
    if route_screen:
        return route_screen
    return _coerce_str(route_state.get("screen"))


def _screen_specific_summary(
    *,
    screen: str,
    screen_metadata: dict[str, Any],
    available_actions: list[str],
) -> str | None:
    if screen == "profile_receipts":
        connector = _coerce_str_or_none(
            screen_metadata.get("connector_badge_label") or screen_metadata.get("connector_state")
        )
        receipt_count = screen_metadata.get("receipt_count")
        preview_available = _coerce_bool(screen_metadata.get("preview_available"), default=False)
        preview_stale = _coerce_bool(screen_metadata.get("preview_stale"), default=False)
        if connector and isinstance(receipt_count, int):
            summary = f"Gmail is {connector.lower()} with {receipt_count} stored receipts."
            if preview_available:
                preview_state = "stale" if preview_stale else "ready"
                summary = f"{summary} A receipt memory preview is {preview_state}."
            return summary
    if screen == "profile_gmail_panel":
        connected = _coerce_bool(screen_metadata.get("gmail_connected"), default=False)
        inbox = _coerce_str_or_none(screen_metadata.get("google_email"))
        if connected and inbox:
            return f"Gmail is connected to {inbox}."
        if connected:
            return "Gmail is connected."
        return "Gmail is not connected yet."
    if screen == "profile_pkm_agent_lab":
        domain_count = screen_metadata.get("domain_count")
        selected_domain = _coerce_str_or_none(screen_metadata.get("selected_domain_key"))
        preview_card_count = screen_metadata.get("preview_card_count")
        if selected_domain:
            return f"The current PKM domain focus is {_titleize_label(selected_domain)}."
        if isinstance(domain_count, int) and isinstance(preview_card_count, int):
            return (
                f"{domain_count} PKM domains are loaded and {preview_card_count} preview"
                f" capture{'s' if preview_card_count != 1 else ''} are visible."
            )
    if screen == "profile_account":
        if _coerce_bool(screen_metadata.get("gmail_connected"), default=False):
            return "Gmail receipts are connected from account settings."
    if screen == "profile_privacy":
        pending_consents = screen_metadata.get("pending_consents")
        if isinstance(pending_consents, int) and pending_consents > 0:
            return (
                f"{pending_consents} consent request"
                f"{'' if pending_consents == 1 else 's'} are waiting for review."
            )
    if screen == "kai_market":
        market_mode = _coerce_str_or_none(screen_metadata.get("market_mode")) or "baseline"
        pick_source = _coerce_str_or_none(screen_metadata.get("active_pick_source"))
        signal_count = _coerce_int(screen_metadata.get("signal_count"))
        news_count = _coerce_int(screen_metadata.get("news_count"))
        spotlight_count = _coerce_int(screen_metadata.get("spotlight_count"))
        connect_portfolio_visible = _coerce_bool(
            screen_metadata.get("connect_portfolio_visible"), default=False
        )
        parts = [
            "This market home screen summarizes the live tape, advisor signals, and discovery modules."
        ]
        if market_mode == "personalized" and pick_source:
            parts.append(f"The active advisor source is {pick_source}.")
        elif market_mode == "baseline":
            parts.append("It is showing the baseline market mode.")
        if isinstance(signal_count, int) and isinstance(spotlight_count, int):
            parts.append(
                f"{signal_count} signal{'s' if signal_count != 1 else ''} and "
                f"{spotlight_count} spotlight name{'s' if spotlight_count != 1 else ''} are visible."
            )
        elif isinstance(news_count, int) and news_count > 0:
            parts.append(f"{news_count} news item{'s' if news_count != 1 else ''} are available.")
        if connect_portfolio_visible:
            parts.append("You can connect a portfolio to personalize this surface further.")
        return " ".join(parts[:3])
    if screen in {
        "kai_portfolio_bootstrap",
        "kai_portfolio_import",
        "kai_portfolio_import_progress",
        "kai_portfolio_import_complete",
        "kai_portfolio_review",
        "kai_portfolio_dashboard",
        "kai_portfolio_analysis",
    }:
        flow_state = _coerce_str_or_none(screen_metadata.get("flow_state"))
        parsed_holdings_count = _coerce_int(screen_metadata.get("parsed_holdings_count"))
        saved_holdings_count = _coerce_int(screen_metadata.get("saved_holdings_count"))
        import_stage = _coerce_str_or_none(screen_metadata.get("import_stage"))
        progress_pct = _coerce_int(screen_metadata.get("import_progress_pct"))
        active_source = _coerce_str_or_none(screen_metadata.get("active_source"))
        if flow_state == "import_required":
            return "This portfolio screen is waiting for a statement import or a Plaid connection."
        if flow_state == "importing":
            progress = f" at {progress_pct} percent" if isinstance(progress_pct, int) else ""
            stage = f" during {import_stage}" if import_stage else ""
            return f"Portfolio import is running{stage}{progress}."
        if flow_state == "import_complete":
            if isinstance(parsed_holdings_count, int):
                return (
                    f"The import is ready for review with {parsed_holdings_count} parsed holding"
                    f"{'' if parsed_holdings_count == 1 else 's'}."
                )
            return "The portfolio import is complete and ready for review."
        if flow_state == "reviewing":
            if isinstance(parsed_holdings_count, int):
                return (
                    f"You are reviewing {parsed_holdings_count} parsed holding"
                    f"{'' if parsed_holdings_count == 1 else 's'} before save."
                )
            return "You are reviewing the parsed portfolio before save."
        if flow_state == "dashboard":
            if active_source and isinstance(saved_holdings_count, int):
                return (
                    f"The portfolio dashboard is showing the {active_source} source with "
                    f"{saved_holdings_count} holding{'' if saved_holdings_count == 1 else 's'}."
                )
            return "The portfolio dashboard is showing the active portfolio source."
    if screen in {"analysis", "kai_analysis", "kai_analysis_workspace", "kai_analysis_history"}:
        surface_mode = _coerce_str_or_none(screen_metadata.get("surface_mode"))
        active_ticker = _coerce_str_or_none(screen_metadata.get("active_ticker"))
        workspace_tab = _coerce_str_or_none(screen_metadata.get("workspace_tab"))
        has_active_run = _coerce_bool(screen_metadata.get("has_active_run"), default=False)
        if surface_mode == "workspace":
            tab_text = f" in the {_titleize_label(workspace_tab)} tab" if workspace_tab else ""
            ticker_text = f" for {active_ticker}" if active_ticker else ""
            run_text = " A live analysis run is active." if has_active_run else ""
            return f"You are in the analysis workspace{ticker_text}{tab_text}.{run_text}".strip()
        if surface_mode == "history":
            ticker_text = f" for {active_ticker}" if active_ticker else ""
            return f"You are in analysis history{ticker_text}."
    if screen == "consents":
        pending_count = _coerce_int(screen_metadata.get("pending_count"))
        active_count = _coerce_int(screen_metadata.get("active_count"))
        selected_status = _coerce_str_or_none(screen_metadata.get("selected_status"))
        tab = _coerce_str_or_none(screen_metadata.get("tab"))
        if isinstance(pending_count, int) and isinstance(active_count, int):
            summary = (
                f"Consent manager is on the {_titleize_label(tab or 'pending')} tab with "
                f"{pending_count} pending and {active_count} active grant"
                f"{'' if active_count == 1 else 's'}."
            )
            if selected_status:
                summary = f"{summary} The selected entry is {selected_status.replace('_', ' ')}."
            return summary
    action_hint = _format_action_hint(available_actions)
    return action_hint


def _build_screen_explain_message(
    *,
    transcript: str,
    app_state: dict[str, Any] | None,
    legacy_context: dict[str, Any],
    detailed: bool = False,
) -> str:
    runtime_state = app_state.get("runtime") if isinstance(app_state, dict) else {}
    portfolio_state = app_state.get("portfolio") if isinstance(app_state, dict) else {}
    route_state = app_state.get("route") if isinstance(app_state, dict) else {}
    _, structured_route, structured_ui, structured_runtime, structured_surface, screen_metadata = (
        _read_structured_screen_context(legacy_context)
    )

    screen = _preferred_screen_key(structured_route, structured_surface, route_state)
    pathname = _coerce_str(structured_route.get("pathname")) or _coerce_str(
        route_state.get("pathname")
    )
    subview = _coerce_str_or_none(structured_route.get("subview")) or _coerce_str_or_none(
        route_state.get("subview")
    )
    active_tab = _coerce_str_or_none(structured_ui.get("active_tab"))
    active_section = _coerce_str_or_none(structured_ui.get("active_section"))
    visible_modules = _coerce_str_list(structured_ui.get("visible_modules"))
    available_actions = _coerce_str_list(structured_ui.get("available_actions"))
    analysis_active = _coerce_bool(
        structured_runtime.get("analysis_active")
        if isinstance(structured_runtime, dict)
        else runtime_state.get("analysis_active")
        if isinstance(runtime_state, dict)
        else legacy_context.get("stock_analysis_active"),
        default=False,
    )
    analysis_ticker = _coerce_str_or_none(
        structured_runtime.get("analysis_ticker")
        if isinstance(structured_runtime, dict)
        else runtime_state.get("analysis_ticker")
        if isinstance(runtime_state, dict)
        else legacy_context.get("current_ticker")
    )
    import_active = _coerce_bool(
        structured_runtime.get("import_active")
        if isinstance(structured_runtime, dict)
        else runtime_state.get("import_active")
        if isinstance(runtime_state, dict)
        else False,
        default=False,
    )
    busy_ops = _coerce_str_list(
        structured_runtime.get("busy_operations")
        if isinstance(structured_runtime, dict)
        else runtime_state.get("busy_operations")
        if isinstance(runtime_state, dict)
        else []
    )
    has_portfolio_data = _coerce_bool(
        portfolio_state.get("has_portfolio_data")
        if isinstance(portfolio_state, dict)
        else legacy_context.get("has_portfolio_data"),
        default=False,
    )

    screen_key = screen.lower() if screen else ""
    compat_surface_message = resolve_surface_explanation(
        transcript,
        screen=screen_key,
        surface_payload=structured_surface,
        active_section=active_section,
        active_tab=active_tab,
        focused_widget=_coerce_str_or_none(structured_ui.get("focused_widget")),
        detailed=detailed,
    )
    knowledge = resolve_voice_explain_knowledge(
        transcript=transcript,
        screen=screen_key,
        pathname=pathname,
        active_section=active_section,
        active_tab=active_tab,
        focused_widget=_coerce_str_or_none(structured_ui.get("focused_widget")),
        available_actions=available_actions,
        visible_modules=visible_modules,
        screen_metadata=screen_metadata,
        allow_surface_overview=True,
    )

    label = _screen_label(screen_key, pathname)
    location_parts: list[str] = []
    if active_section:
        location_parts.append(f"the {_titleize_label(active_section)} section")
    elif active_tab:
        location_parts.append(f"the {_titleize_label(active_tab)} tab")
    elif subview:
        location_parts.append(f"the {_titleize_label(subview)} view")

    if label == "PKM Agent Lab":
        location_line = "You are in PKM Agent Lab."
    elif label == "Kai":
        location_line = "You are in Kai."
    elif location_parts:
        location_line = f"You are on the {label} screen, in {location_parts[0]}."
    else:
        location_line = f"You are on the {label} screen."

    runtime_line: str | None = None
    if analysis_active:
        ticker_label = analysis_ticker or "an active ticker"
        runtime_line = f"An analysis is running for {ticker_label}."
    elif import_active:
        runtime_line = "A portfolio import is currently running."
    elif busy_ops:
        runtime_line = f"Busy operations include {', '.join(busy_ops[:3])}."

    transcript_lowered = transcript.lower()
    capability_request = _is_screen_capability_intent(transcript_lowered)
    prefer_surface_specific_message = bool(
        compat_surface_message
        and any(
            token in transcript_lowered
            for token in (
                "this button",
                "this control",
                "this action",
                "this card",
                "section",
                "tab",
                "panel",
            )
        )
    )
    knowledge_summary = _coerce_str(knowledge.summary)
    knowledge_detail = _coerce_str(knowledge.detail)
    fallback_screen_specific_line = _screen_specific_summary(
        screen=screen_key,
        screen_metadata=screen_metadata,
        available_actions=available_actions,
    )
    screen_specific_line = (
        _coerce_str(compat_surface_message)
        if prefer_surface_specific_message
        else knowledge_summary
    )
    surface_purpose = _coerce_str_or_none(structured_surface.get("purpose"))
    if (
        not prefer_surface_specific_message
        and surface_purpose
        and screen_key.startswith("profile_")
        and not screen_metadata
    ):
        screen_specific_line = (
            surface_purpose if surface_purpose.endswith(".") else f"{surface_purpose}."
        )
    if (
        not prefer_surface_specific_message
        and fallback_screen_specific_line
        and screen_key
        in {
            "kai_market",
            "kai_portfolio_bootstrap",
            "kai_portfolio_import",
            "kai_portfolio_import_progress",
            "kai_portfolio_import_complete",
            "kai_portfolio_review",
            "kai_portfolio_dashboard",
            "kai_portfolio_analysis",
            "analysis",
            "kai_analysis",
            "kai_analysis_workspace",
            "kai_analysis_history",
            "consents",
        }
    ):
        screen_specific_line = fallback_screen_specific_line
    if knowledge.tier == "fallback" and fallback_screen_specific_line:
        screen_specific_line = fallback_screen_specific_line
    elif not screen_specific_line:
        screen_specific_line = fallback_screen_specific_line
    actions_line = _format_action_hint(available_actions)
    screen_actions_line = _screen_action_hint(screen_key, pathname)
    visible_modules_line = (
        f"Visible modules include {', '.join(visible_modules[:4])}." if visible_modules else None
    )
    portfolio_line = (
        "Portfolio data is connected."
        if has_portfolio_data
        else "Portfolio data is limited right now."
    )
    if capability_request:
        identity = get_kai_voice_identity_context()
        core_capabilities = [
            str(capability).strip()
            for capability in (identity.get("core_capabilities") or [])
            if str(capability or "").strip()
        ]
        capability_lines = [
            actions_line,
            screen_actions_line,
            (
                "I can " + ", ".join(core_capabilities[:3]) + "."
                if core_capabilities
                else "I can explain this screen, navigate inside Kai, and start approved actions when the app state allows it."
            ),
        ]
        if detailed:
            capability_lines.append(
                "I can also use PKM context and connected Gmail receipt workflows when they are available."
            )
        return " ".join([location_line, next(line for line in capability_lines if line)])

    if not detailed:
        concise_parts = [part for part in [screen_specific_line, runtime_line] if part]
        if not concise_parts and not has_portfolio_data:
            concise_parts.append(portfolio_line)
        if not concise_parts and actions_line:
            concise_parts.append(actions_line)
        if not concise_parts:
            concise_parts.append("This screen handles the current Kai workflow.")
        return " ".join([location_line, concise_parts[0]])

    detailed_actions_line = (
        f"Next actions: {actions_line}"
        if actions_line
        else "Next actions: ask me to open another section or explain this area in more detail."
    )

    detailed_parts = [
        location_line,
        screen_specific_line,
        knowledge_detail if knowledge_detail and knowledge_detail != knowledge_summary else None,
        runtime_line,
        visible_modules_line,
        portfolio_line,
        detailed_actions_line,
    ]
    return " ".join([part for part in detailed_parts if part])


def _is_likely_english(text: str) -> bool:
    alpha_total = sum(1 for ch in text if ch.isalpha())
    if alpha_total == 0:
        return True
    ascii_alpha = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    return (ascii_alpha / alpha_total) >= 0.65


def _transcript_unusable_reason(transcript: str) -> str | None:
    clean = _coerce_str(transcript)
    if not clean:
        return "empty_or_noise"
    if not _is_likely_english(clean):
        return "non_english"
    if len(re.sub(r"[^a-zA-Z0-9]+", "", clean)) < _MIN_ACTIONABLE_CHARS:
        return "empty_or_noise"
    tokens = [token for token in re.split(r"[\s,.;:!?]+", clean.lower()) if token]
    if not tokens:
        return "empty_or_noise"
    if len(tokens) <= 2 and all(token in _FILLER_WORDS for token in tokens):
        return "empty_or_noise"
    return None


def _is_transcript_unusable(transcript: str) -> bool:
    return _transcript_unusable_reason(transcript) is not None


def _unusable_transcript_message(transcript: str) -> str:
    if _transcript_unusable_reason(transcript) == "non_english":
        return _VOICE_ENGLISH_ONLY_INPUT_MESSAGE
    return _UNCLEAR_STT_MESSAGE


def _enforce_english_voice_output(text: str) -> str:
    clean = _coerce_str(text)
    if clean and _is_likely_english(clean):
        return clean
    return _VOICE_ENGLISH_ONLY_INPUT_MESSAGE


def _extract_analyze_target(transcript: str) -> str | None:
    clean_transcript = _coerce_str(transcript)
    if not clean_transcript:
        return None
    normalized_transcript = re.sub(
        r"^\s*(?:(?:can|could|would)\s+you(?:\s+please)?|please|hey|hi|hello|bro|kai)\b[\s,!?-]*",
        "",
        clean_transcript,
        flags=re.IGNORECASE,
    )
    normalized_transcript = re.sub(
        r"^\s*please\b[\s,!?-]*",
        "",
        normalized_transcript,
        flags=re.IGNORECASE,
    )
    match = _ANALYZE_TARGET_RE.match(normalized_transcript)
    if not match:
        match = _ANALYZE_NOUN_TARGET_RE.match(normalized_transcript)
    if not match:
        return None
    target = _coerce_str(match.group("target"))
    target = re.sub(r"[’']s\b", "", target, flags=re.IGNORECASE)
    target = re.sub(
        r"\b(stock|stocks|ticker|company|share|shares)\b", "", target, flags=re.IGNORECASE
    )
    target = re.sub(
        r"(?:\b(?:for me|please|right now|now|today|thanks|thank you)\b[\s,.;:!?]*)+$",
        "",
        target,
        flags=re.IGNORECASE,
    )
    target = re.sub(r"\s+", " ", target).strip(" .,!?:;")
    return target


def _normalize_company_lookup_key(value: str) -> str:
    text = _coerce_str(value).lower()
    if not text:
        return ""
    text = re.sub(r"[&/,+()]", " ", text)
    text = re.sub(r"[^a-z0-9.\- ]+", " ", text)
    text = re.sub(
        r"\b(?:incorporated|inc|corp|corporation|co|company|holdings|holding|limited|ltd|plc|class a|class b|common stock)\b",
        " ",
        text,
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", text).strip()


def _resolve_single_fuzzy_alias(query_key: str) -> dict[str, Any] | None:
    if not query_key:
        return None
    alias_keys = sorted(_COMPANY_ALIAS_TO_TICKER.keys())
    close_aliases = get_close_matches(query_key, alias_keys, n=2, cutoff=0.84)
    if not close_aliases:
        return None
    resolved_tickers = {
        _COMPANY_ALIAS_TO_TICKER.get(alias)
        for alias in close_aliases
        if _COMPANY_ALIAS_TO_TICKER.get(alias)
    }
    if len(resolved_tickers) == 1:
        ticker = next(iter(resolved_tickers))
        return {"kind": "exact", "ticker": ticker}
    return {"kind": "ambiguous", "candidate": None, "matches": sorted(resolved_tickers)}


def _best_title_match_from_rows(
    query_key: str, rows: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if not query_key or not rows:
        return None

    normalized_titles = [_normalize_company_lookup_key(str(row.get("title") or "")) for row in rows]

    exact_indexes = [index for index, title in enumerate(normalized_titles) if title == query_key]
    if exact_indexes:
        tickers = {
            str(rows[index].get("ticker") or "").upper()
            for index in exact_indexes
            if rows[index].get("ticker")
        }
        if len(tickers) == 1:
            return {"kind": "exact", "ticker": next(iter(tickers))}
        if tickers:
            return {"kind": "ambiguous", "candidate": None, "matches": sorted(tickers)}

    close_titles = get_close_matches(
        query_key,
        [title for title in normalized_titles if title],
        n=2,
        cutoff=0.92,
    )
    if not close_titles:
        return None

    top_match = close_titles[0]
    tickers = {
        str(rows[index].get("ticker") or "").upper()
        for index, title in enumerate(normalized_titles)
        if title == top_match and rows[index].get("ticker")
    }
    if len(tickers) != 1:
        return {"kind": "ambiguous", "candidate": None, "matches": sorted(tickers)}

    if len(close_titles) == 1:
        return {"kind": "exact", "ticker": next(iter(tickers))}

    second_match = close_titles[1]
    second_tickers = {
        str(rows[index].get("ticker") or "").upper()
        for index, title in enumerate(normalized_titles)
        if title == second_match and rows[index].get("ticker")
    }
    if not second_tickers or second_tickers == tickers:
        return {"kind": "exact", "ticker": next(iter(tickers))}
    return {"kind": "ambiguous", "candidate": None, "matches": sorted(tickers | second_tickers)}


def _is_analysis_navigation_request(transcript: str) -> bool:
    normalized = _coerce_str(transcript).strip().lower()
    if not normalized:
        return False
    if normalized in {
        "analysis",
        "analysis section",
        "analysis screen",
        "analysis page",
        "analysis tab",
        "analysis workspace",
        "analysis area",
    }:
        return True
    return bool(_ANALYSIS_NAVIGATION_RE.search(normalized))


def _resolve_ticker_target(target: str) -> dict[str, Any]:
    query = _coerce_str(target)
    if not query:
        return {"kind": "unknown", "candidate": None, "matches": []}

    normalized_query = re.sub(r"\s+", " ", query).strip()
    uppercase_query = normalized_query.upper()
    query_key = _normalize_company_lookup_key(normalized_query)
    symbol_master = get_symbol_master_service()

    if _TICKER_PATTERN_RE.match(uppercase_query):
        classification = symbol_master.classify(uppercase_query)
        metadata = symbol_master.get_ticker_metadata(uppercase_query)
        if classification.tradable and metadata is not None:
            return {"kind": "exact", "ticker": classification.symbol}

    alias_key = normalized_query.lower()
    alias_ticker = _COMPANY_ALIAS_TO_TICKER.get(query_key) or _COMPANY_ALIAS_TO_TICKER.get(
        alias_key
    )
    if alias_ticker:
        return {"kind": "exact", "ticker": alias_ticker}

    fuzzy_alias_match = _resolve_single_fuzzy_alias(query_key or alias_key)
    if fuzzy_alias_match is not None:
        return fuzzy_alias_match

    if not ticker_cache.loaded:
        try:
            ticker_cache.load_from_db()
        except Exception:
            logger.warning("[VOICE_RESOLVE] ticker cache load failed", exc_info=True)

    rows = ticker_cache.search(normalized_query, limit=5)
    if not rows and query_key and query_key != normalized_query.lower():
        rows = ticker_cache.search(query_key, limit=5)
    tickers = [str(row.get("ticker") or "").upper() for row in rows if row.get("ticker")]
    tickers = [ticker for ticker in tickers if ticker]

    if len(tickers) == 1:
        return {"kind": "exact", "ticker": tickers[0]}
    if len(tickers) > 1:
        title_match = _best_title_match_from_rows(query_key or alias_key, rows)
        if title_match is not None:
            return title_match
        return {"kind": "ambiguous", "candidate": None, "matches": tickers}

    return {"kind": "unknown", "candidate": None, "matches": []}


def _normalize_runtime_state(
    app_state: dict[str, Any] | None, *, legacy_context: dict[str, Any]
) -> dict[str, Any]:
    if not isinstance(app_state, dict):
        return {
            "analysis_active": _coerce_bool(
                legacy_context.get("stock_analysis_active"), default=False
            ),
            "analysis_ticker": _coerce_str_or_none(legacy_context.get("current_ticker")),
            "analysis_run_id": None,
            "import_active": False,
            "import_run_id": None,
            "busy_operations": [],
            "complete": False,
        }
    runtime = app_state.get("runtime")
    if not isinstance(runtime, dict):
        return {
            "analysis_active": False,
            "analysis_ticker": None,
            "analysis_run_id": None,
            "import_active": False,
            "import_run_id": None,
            "busy_operations": [],
            "complete": False,
        }
    complete = (
        isinstance(runtime.get("analysis_active"), bool)
        and isinstance(runtime.get("import_active"), bool)
        and isinstance(runtime.get("busy_operations"), list)
    )
    return {
        "analysis_active": _coerce_bool(runtime.get("analysis_active"), default=False),
        "analysis_ticker": _coerce_str_or_none(runtime.get("analysis_ticker")),
        "analysis_run_id": _coerce_str_or_none(runtime.get("analysis_run_id")),
        "import_active": _coerce_bool(runtime.get("import_active"), default=False),
        "import_run_id": _coerce_str_or_none(runtime.get("import_run_id")),
        "busy_operations": _coerce_str_list(runtime.get("busy_operations")),
        "complete": complete,
    }


def _normalize_voice_gate(
    app_state: dict[str, Any] | None,
    *,
    user_id: str,
    legacy_context: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(app_state, dict):
        return {
            "signed_in": True,
            "user_id": user_id,
            "vault_unlocked": True,
            "token_available": True,
            "token_valid": True,
            "voice_available": True,
            "source": "legacy",
        }

    auth = app_state.get("auth") if isinstance(app_state.get("auth"), dict) else {}
    vault = app_state.get("vault") if isinstance(app_state.get("vault"), dict) else {}
    voice = app_state.get("voice") if isinstance(app_state.get("voice"), dict) else {}

    if not auth and not vault:
        return {
            "signed_in": True,
            "user_id": user_id,
            "vault_unlocked": True,
            "token_available": True,
            "token_valid": True,
            "voice_available": True,
            "source": "legacy",
        }

    return {
        "signed_in": _coerce_bool(auth.get("signed_in"), default=False),
        "user_id": _coerce_str_or_none(auth.get("user_id")),
        "vault_unlocked": _coerce_bool(vault.get("unlocked"), default=False),
        "token_available": _coerce_bool(vault.get("token_available"), default=False),
        "token_valid": _coerce_bool(vault.get("token_valid"), default=False),
        "voice_available": _coerce_bool(voice.get("available"), default=False),
        "source": "app_state",
    }


class VoiceServiceError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)


@dataclass(slots=True)
class VoiceTTSStreamHandle:
    response: httpx.Response
    response_cm: Any
    client: httpx.AsyncClient
    meta: dict[str, Any]
    trace_hook: Callable[[str, dict[str, Any]], None] | None = None
    started_at: float = 0.0
    _chunk_iter: Any = None
    _closed: bool = False

    async def read_next_chunk(self) -> bytes | None:
        if self._closed:
            return None
        if self._chunk_iter is None:
            self._chunk_iter = self.response.aiter_bytes().__aiter__()
        try:
            chunk = await self._chunk_iter.__anext__()
        except StopAsyncIteration:
            self.meta["completed"] = True
            if self.trace_hook:
                self.trace_hook(
                    "tts_upstream_finished",
                    {
                        "model_used": self.meta.get("model"),
                        "elapsed_ms": int((time.perf_counter() - self.started_at) * 1000),
                        "status_code": self.response.status_code,
                        "audio_bytes": int(self.meta.get("audio_bytes") or 0),
                        "content_length": self.meta.get("content_length"),
                    },
                )
            return None
        if chunk:
            self.meta["audio_bytes"] = int(self.meta.get("audio_bytes") or 0) + len(chunk)
        return chunk

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self.response.aclose()
        finally:
            await self.response_cm.__aexit__(None, None, None)
            await self.client.aclose()


class VoiceIntentService:
    def __init__(self) -> None:
        voice_settings = get_voice_runtime_settings()
        self.api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
        self.force_realtime_voice = voice_settings.force_realtime
        self.fail_fast_voice = voice_settings.fail_fast
        self.disable_voice_fallbacks = voice_settings.disable_fallbacks
        self.realtime_enabled = voice_settings.realtime_enabled
        self.realtime_model = voice_settings.realtime_model
        self.stt_models = list(voice_settings.stt_models)
        self.intent_models = list(voice_settings.intent_models)
        configured_tts_model = str(
            voice_settings.tts_models[0] if voice_settings.tts_models else ""
        )
        parsed_tts_models = list(voice_settings.tts_models)
        self.tts_prefer_quality = voice_settings.tts_prefer_quality
        self.tts_models = _prioritize_tts_models(
            parsed_tts_models,
            configured_model=configured_tts_model,
            prefer_quality=self.tts_prefer_quality,
        )
        self.tts_model = self.tts_models[0]
        self.tts_models = [self.tts_model]
        self.tts_default_voice = voice_settings.tts_default_voice
        self.tts_format = voice_settings.tts_format
        self.upstream_http_timeout_seconds = _OPENAI_HTTP_TIMEOUT_SECONDS
        self.tts_timeout_seconds = _OPENAI_TTS_TIMEOUT_SECONDS
        logger.info(
            (
                "[VOICE_MODEL_CONFIG] stt_models=%s planner_models=%s "
                "tts_models=%s tts_prefer_quality=%s tts_voice=%s tts_format=%s "
                "upstream_timeout_seconds=%s tts_timeout_seconds=%s realtime_enabled=%s realtime_model=%s "
                "disable_voice_fallbacks=%s fail_fast_voice=%s force_realtime_voice=%s"
            ),
            self.stt_models,
            self.intent_models,
            self.tts_models,
            self.tts_prefer_quality,
            self.tts_default_voice,
            self.tts_format,
            self.upstream_http_timeout_seconds,
            self.tts_timeout_seconds,
            self.realtime_enabled,
            self.realtime_model,
            self.disable_voice_fallbacks,
            self.fail_fast_voice,
            self.force_realtime_voice,
        )
        if self.disable_voice_fallbacks:
            logger.warning(
                "[VOICE_FAIL_FAST] model fallback chains are disabled by VOICE_RUNTIME_CONFIG_JSON."
            )

    def _ordered_tts_model_candidates(self) -> list[str]:
        return [self.tts_model or "gpt-4o-mini-tts"]

    def _require_api_key(self) -> None:
        if not self.api_key:
            raise VoiceServiceError(503, "OPENAI_API_KEY is not configured")

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
        }

    async def create_realtime_session(
        self,
        *,
        voice: str | None = None,
        include_input_transcription: bool = True,
        server_vad_silence_ms: int = 800,
        disable_auto_response: bool = True,
        enable_barge_in: bool = True,
    ) -> dict[str, Any]:
        self._require_api_key()
        if not self.realtime_enabled:
            raise VoiceServiceError(503, "Realtime voice is not enabled.")

        selected_voice = str(voice or self.tts_default_voice).strip() or self.tts_default_voice
        session_payload: dict[str, Any] = {
            "type": "realtime",
            "model": self.realtime_model,
            "audio": {
                "input": {},
                "output": {
                    "voice": selected_voice,
                },
            },
        }
        turn_detection = {
            "type": "server_vad",
            "threshold": _REALTIME_SERVER_VAD_THRESHOLD,
            "prefix_padding_ms": _REALTIME_SERVER_VAD_PREFIX_PADDING_MS,
            "silence_duration_ms": max(300, int(server_vad_silence_ms)),
            "create_response": False if disable_auto_response else True,
            "interrupt_response": True if enable_barge_in else False,
        }
        if include_input_transcription:
            input_audio = (
                session_payload.get("audio")
                if isinstance(session_payload.get("audio"), dict)
                else {}
            )
            input_section = (
                input_audio.get("input") if isinstance(input_audio.get("input"), dict) else {}
            )
            input_section["noise_reduction"] = {"type": _REALTIME_NOISE_REDUCTION_TYPE}
            input_section["transcription"] = {
                "model": self.stt_models[0] if self.stt_models else "gpt-4o-mini-transcribe",
                "language": _REALTIME_TRANSCRIPTION_LANGUAGE,
                "prompt": _REALTIME_TRANSCRIPTION_PROMPT,
            }
            input_section["turn_detection"] = turn_detection
            input_audio["input"] = input_section
            session_payload["audio"] = input_audio
        else:
            input_audio = (
                session_payload.get("audio")
                if isinstance(session_payload.get("audio"), dict)
                else {}
            )
            input_section = (
                input_audio.get("input") if isinstance(input_audio.get("input"), dict) else {}
            )
            input_section["noise_reduction"] = {"type": _REALTIME_NOISE_REDUCTION_TYPE}
            input_section["turn_detection"] = turn_detection
            input_audio["input"] = input_section
            session_payload["audio"] = input_audio
        payload: dict[str, Any] = {
            "session": session_payload,
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                _OPENAI_REALTIME_CLIENT_SECRETS_URL,
                headers={
                    **self._headers(),
                    "Content-Type": "application/json",
                },
                json=payload,
            )

        result = response.json() if response.content else {}
        if response.status_code >= 400:
            detail = _extract_openai_error(result) or "Realtime client secret creation failed"
            raise VoiceServiceError(502, detail)

        client_secret = ""
        client_secret_expires_at: Any = None
        if isinstance(result, dict):
            top_level_value = result.get("value")
            if isinstance(top_level_value, str) and top_level_value.strip():
                client_secret = top_level_value.strip()
                client_secret_expires_at = result.get("expires_at")

            if not client_secret:
                secret_obj = result.get("client_secret")
                if isinstance(secret_obj, dict):
                    secret_value = secret_obj.get("value")
                    if isinstance(secret_value, str) and secret_value.strip():
                        client_secret = secret_value.strip()
                        client_secret_expires_at = (
                            secret_obj.get("expires_at")
                            if secret_obj.get("expires_at") is not None
                            else result.get("expires_at")
                        )
                elif isinstance(secret_obj, str) and secret_obj.strip():
                    client_secret = secret_obj.strip()
                    client_secret_expires_at = result.get("expires_at")
        if not client_secret:
            if isinstance(result, dict):
                logger.error(
                    "[VOICE_REALTIME_CLIENT_SECRET_MISSING] response_keys=%s has_value=%s has_client_secret=%s",
                    sorted(list(result.keys())),
                    isinstance(result.get("value"), str),
                    isinstance(result.get("client_secret"), (str, dict)),
                )
            else:
                logger.error(
                    "[VOICE_REALTIME_CLIENT_SECRET_MISSING] response_type=%s",
                    type(result).__name__,
                )
            raise VoiceServiceError(502, "Realtime session did not return a client secret")

        session_meta = result.get("session") if isinstance(result, dict) else None
        if not isinstance(session_meta, dict):
            session_meta = {}
        session_audio = (
            session_meta.get("audio") if isinstance(session_meta.get("audio"), dict) else {}
        )
        top_level_audio = result.get("audio") if isinstance(result.get("audio"), dict) else {}
        merged_audio = top_level_audio.copy()
        merged_audio.update(session_audio)
        session_audio = merged_audio
        session_audio_output = (
            session_audio.get("output") if isinstance(session_audio.get("output"), dict) else {}
        )
        response_voice = (
            str(session_audio_output.get("voice") or "").strip()
            or str(session_meta.get("voice") or "").strip()
            or selected_voice
        )
        response_model = (
            str(session_meta.get("model") or "").strip()
            or str(result.get("model") or "").strip()
            or self.realtime_model
        )

        return {
            "session_id": (
                str(session_meta.get("id") or "").strip()
                or str(result.get("id") or "").strip()
                or None
            ),
            "client_secret": client_secret,
            "client_secret_expires_at": (
                client_secret_expires_at
                if client_secret_expires_at is not None
                else result.get("expires_at") or session_meta.get("expires_at")
            ),
            "model": response_model,
            "voice": response_voice,
            "transcription_model": str(
                (
                    input_section.get("transcription")
                    if isinstance(input_section.get("transcription"), dict)
                    else {}
                ).get("model")
                or "gpt-4o-mini-transcribe"
            ),
            "transcription_language": _REALTIME_TRANSCRIPTION_LANGUAGE,
            "transcription_prompt": _REALTIME_TRANSCRIPTION_PROMPT,
            "server_vad_enabled": True,
            "silence_duration_ms": int(turn_detection["silence_duration_ms"]),
            "auto_response_enabled": bool(turn_detection["create_response"]),
            "barge_in_enabled": bool(turn_detection["interrupt_response"]),
            "raw": result if isinstance(result, dict) else {},
        }

    async def transcribe_audio(
        self,
        *,
        audio_bytes: bytes,
        filename: str,
        content_type: str,
        trace_hook: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> tuple[str, int, str]:
        started_at = time.perf_counter()
        self._require_api_key()
        if not audio_bytes:
            raise VoiceServiceError(400, "Audio payload is empty")

        files = {
            "file": (filename, audio_bytes, content_type or "application/octet-stream"),
        }

        def _emit_trace(stage: str, payload: dict[str, Any]) -> None:
            if not trace_hook:
                return
            try:
                trace_hook(stage, payload)
            except Exception:
                logger.exception("[VOICE_STT_TRACE_HOOK] stage=%s payload=%s", stage, payload)

        def _on_attempt(event_payload: dict[str, Any]) -> None:
            event = str(event_payload.get("event") or "")
            if event == "upstream_started":
                _emit_trace(
                    "stt_upstream_started",
                    {
                        "model_candidate_order": event_payload.get("model_candidate_order") or [],
                        "model_attempted": event_payload.get("model_attempted"),
                        "timeout_seconds": event_payload.get("timeout_seconds"),
                        "audio_bytes": len(audio_bytes),
                        "normalized_mime": content_type or "application/octet-stream",
                        "filename": filename,
                    },
                )
                return
            if event == "upstream_finished":
                payload = (
                    event_payload.get("payload")
                    if isinstance(event_payload.get("payload"), dict)
                    else {}
                )
                transcript = (
                    str(payload.get("text") or "").strip() if isinstance(payload, dict) else ""
                )
                _emit_trace(
                    "stt_upstream_finished",
                    {
                        "model_used": event_payload.get("model_used"),
                        "elapsed_ms": event_payload.get("elapsed_ms"),
                        "status_code": event_payload.get("status_code"),
                        "transcript_chars": len(transcript),
                    },
                )
                return
            if event == "upstream_failed":
                _emit_trace(
                    "stt_upstream_failed",
                    {
                        "model_used": event_payload.get("model_used"),
                        "elapsed_ms": event_payload.get("elapsed_ms"),
                        "status_code": event_payload.get("status_code"),
                        "exception_type": event_payload.get("exception_type"),
                        "upstream_error_message": event_payload.get("upstream_error_message"),
                        "upstream_error_payload": event_payload.get("upstream_error_payload"),
                        "will_retry": event_payload.get("will_retry"),
                        "next_model": event_payload.get("next_model"),
                    },
                )

        response, payload, openai_http_ms, model_used = await _post_with_model_fallback(
            url=_OPENAI_TRANSCRIBE_URL,
            headers=self._headers(),
            candidate_models=self.stt_models,
            body_builder=lambda model_name: {
                "data": {
                    "model": model_name,
                    "language": _VOICE_LANGUAGE,
                    "prompt": _VOICE_STT_PROMPT,
                },
                "files": files,
            },
            timeout_seconds=self.upstream_http_timeout_seconds,
            attempt_hook=_on_attempt,
            allow_model_fallback=not self.disable_voice_fallbacks,
        )
        if response.status_code >= 400:
            detail = _extract_openai_error(payload) or "STT request failed"
            _emit_trace(
                "stt_service_failed",
                {
                    "status_code": response.status_code,
                    "model_used": model_used,
                    "upstream_http_ms": openai_http_ms,
                    "service_elapsed_ms": int((time.perf_counter() - started_at) * 1000),
                    "error": detail,
                },
            )
            logger.warning(
                (
                    "[VOICE_STT] status=error model=%s status_code=%s openai_http_ms=%s "
                    "audio_bytes=%s filename=%s content_type=%s error=%s openai_error_payload=%s"
                ),
                model_used,
                response.status_code,
                openai_http_ms,
                len(audio_bytes),
                filename,
                content_type or "application/octet-stream",
                detail,
                payload.get("error") if isinstance(payload, dict) else payload,
            )
            raise VoiceServiceError(502, detail)

        transcript = str(payload.get("text") or "").strip()
        if not transcript:
            _emit_trace(
                "stt_service_failed",
                {
                    "status_code": 422,
                    "model_used": model_used,
                    "upstream_http_ms": openai_http_ms,
                    "service_elapsed_ms": int((time.perf_counter() - started_at) * 1000),
                    "error": "No transcript returned from STT",
                },
            )
            raise VoiceServiceError(422, "No transcript returned from STT")
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        _emit_trace(
            "stt_service_finished",
            {
                "status_code": response.status_code,
                "model_used": model_used,
                "upstream_http_ms": openai_http_ms,
                "service_elapsed_ms": elapsed_ms,
                "transcript_chars": len(transcript),
            },
        )
        logger.info(
            (
                "[VOICE_STT] status=ok model=%s elapsed_ms=%s openai_http_ms=%s "
                "audio_bytes=%s transcript_chars=%s"
            ),
            model_used,
            elapsed_ms,
            openai_http_ms,
            len(audio_bytes),
            len(transcript),
        )
        return transcript, openai_http_ms, model_used

    async def plan_intent(
        self,
        *,
        transcript: str,
        user_id: str,
        context: dict[str, Any] | None,
    ) -> tuple[dict[str, Any], int, str]:
        started_at = time.perf_counter()
        self._require_api_key()
        clean_transcript = str(transcript or "").strip()
        if not clean_transcript:
            raise VoiceServiceError(422, "Transcript is empty")
        if _is_transcript_unusable(clean_transcript):
            return (
                {
                    "tool_name": "clarify",
                    "args": {
                        "question": _unusable_transcript_message(clean_transcript),
                    },
                },
                0,
                "deterministic",
            )

        tools = _build_tools_schema()
        context_payload = _compact_context(context)
        planner_context = build_voice_planner_context(
            transcript=clean_transcript,
            runtime_state={},
            context_payload=context_payload,
        )
        system_prompt = build_voice_planner_system_prompt(planner_context=planner_context)

        response, result, openai_http_ms, model_used = await _post_with_model_fallback(
            url=_OPENAI_CHAT_URL,
            headers={
                **self._headers(),
                "Content-Type": "application/json",
            },
            candidate_models=self.intent_models,
            body_builder=lambda model_name: {
                "json": {
                    "model": model_name,
                    "temperature": 0,
                    "max_tokens": 80,
                    "tool_choice": "required",
                    "messages": [
                        {
                            "role": "system",
                            "content": system_prompt,
                        },
                        {
                            "role": "user",
                            "content": json.dumps(
                                {
                                    "user_id": user_id,
                                    "transcript": clean_transcript,
                                    "planner_context": planner_context,
                                    "context": context_payload,
                                }
                            ),
                        },
                    ],
                    "tools": tools,
                }
            },
            allow_model_fallback=not self.disable_voice_fallbacks,
        )
        if response.status_code >= 400:
            detail = _extract_openai_error(result) or "Intent planning request failed"
            raise VoiceServiceError(502, detail)

        tool_call = _extract_first_tool_call(result)
        validated = _validate_tool_call(tool_call)
        if not validated:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            logger.warning(
                (
                    "[VOICE_PLAN] status=clarify model=%s elapsed_ms=%s openai_http_ms=%s "
                    "transcript_chars=%s raw_tool_call=%s"
                ),
                model_used,
                elapsed_ms,
                openai_http_ms,
                len(clean_transcript),
                tool_call,
            )
            return (
                {
                    "tool_name": "clarify",
                    "args": {
                        "question": "I could not map that safely. Please repeat your request.",
                        "options": ["Analyze a stock", "Open dashboard", "Open profile"],
                    },
                },
                openai_http_ms,
                model_used,
            )
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        logger.info(
            (
                "[VOICE_PLAN] status=ok model=%s elapsed_ms=%s openai_http_ms=%s "
                "transcript_chars=%s tool_call=%s"
            ),
            model_used,
            elapsed_ms,
            openai_http_ms,
            len(clean_transcript),
            validated,
        )
        return validated, openai_http_ms, model_used

    @staticmethod
    def _build_response(
        *,
        kind: str,
        message: str,
        reason: str | None = None,
        task: str | None = None,
        ticker: str | None = None,
        run_id: str | None = None,
        candidate: str | None = None,
        tool_call: dict[str, Any] | None = None,
        execution_allowed: bool | None = None,
    ) -> dict[str, Any]:
        normalized_message = _normalize_banker_message(
            message,
            kind=kind,
            tool_call=tool_call,
        )
        response: dict[str, Any] = {
            "kind": kind,
            "message": normalized_message,
            "speak": True,
            "execution_allowed": (
                kind == "execute" if execution_allowed is None else bool(execution_allowed)
            ),
        }
        if reason:
            response["reason"] = reason
        if task:
            response["task"] = task
        if ticker:
            response["ticker"] = ticker
        if run_id:
            response["run_id"] = run_id
        if candidate:
            response["candidate"] = candidate
        if tool_call:
            response["tool_call"] = tool_call
        return response

    @staticmethod
    def _memory_hint_from_response(response: dict[str, Any]) -> dict[str, Any]:
        kind = _coerce_str(response.get("kind"))
        reason = _coerce_str_or_none(response.get("reason"))
        allow = True
        if kind == "blocked":
            allow = False
        if kind == "clarify" and reason in {"stt_unusable", "ticker_ambiguous", "ticker_unknown"}:
            allow = False
        if reason in {"manual_user_execution_required", "confirmation_required"}:
            allow = False
        return {"allow_durable_write": allow}

    @staticmethod
    def _legacy_tool_call_for_response(response: dict[str, Any]) -> dict[str, Any]:
        tool_call = response.get("tool_call")
        if _response_has_executable_plan(response):
            if _is_executable_tool_call(tool_call):
                return tool_call
            synthesized = _legacy_tool_call_from_action(
                _coerce_str_or_none(response.get("action_id")),
                slots=dict(response.get("slots") or {}),
            )
            if synthesized is not None:
                return synthesized
        if isinstance(tool_call, dict) and _coerce_str(tool_call.get("tool_name")) == "clarify":
            return tool_call
        message = _coerce_str(response.get("message")) or _UNCLEAR_STT_MESSAGE
        return {"tool_name": "clarify", "args": {"question": message}}

    @staticmethod
    def _finalize_response(
        response: dict[str, Any],
        *,
        gate_state: dict[str, Any],
        has_active_analysis: bool,
        has_portfolio_data: bool,
        action_id_override: str | None = None,
        slots_override: dict[str, Any] | None = None,
        memory_override: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        finalized = dict(response)
        canonical_tool_call = (
            finalized.get("tool_call") if isinstance(finalized.get("tool_call"), dict) else None
        )
        action_id = action_id_override or _canonical_action_id_from_tool_call(canonical_tool_call)
        slots = dict(slots_override or _canonical_slots_from_tool_call(canonical_tool_call))
        guard_ids = _canonical_guards_for_action(
            action_id,
            gate_state=gate_state,
            has_active_analysis=has_active_analysis,
            has_portfolio_data=has_portfolio_data,
            response=finalized,
        )
        guard_states = {
            guard_id: _guard_status(
                guard_id,
                gate_state=gate_state,
                has_active_analysis=has_active_analysis,
                has_portfolio_data=has_portfolio_data,
                response=finalized,
            )
            for guard_id in guard_ids
        }
        blocked_guards = [
            guard_id for guard_id, (status, _) in guard_states.items() if status == "blocked"
        ]
        unknown_guards = [
            guard_id for guard_id, (status, _) in guard_states.items() if status == "unknown"
        ]
        execution_policy = _manifest_execution_policy(action_id)
        finalized = _apply_action_contract_to_response(
            finalized,
            action_id=action_id,
            execution_policy=execution_policy,
            blocked_guards=blocked_guards,
            unknown_guards=unknown_guards,
        )
        mode = _canonical_mode_for_response_with_policy(
            finalized,
            action_id=action_id,
            execution_policy=execution_policy,
            blocked_guards=blocked_guards,
            unknown_guards=unknown_guards,
        )
        executable_plan = _is_executable_mode(mode) and bool(
            action_id or _is_executable_tool_call(finalized.get("tool_call"))
        )
        if executable_plan:
            finalized["execution_allowed"] = True
            if not _is_executable_tool_call(finalized.get("tool_call")):
                synthesized_tool_call = _legacy_tool_call_from_action(
                    action_id,
                    slots=slots,
                )
                if synthesized_tool_call is not None:
                    finalized["tool_call"] = synthesized_tool_call
                else:
                    finalized.pop("tool_call", None)
        else:
            finalized["execution_allowed"] = False
            if _is_executable_tool_call(finalized.get("tool_call")):
                finalized.pop("tool_call", None)
        if not isinstance(finalized.get("memory"), dict):
            finalized["memory"] = VoiceIntentService._memory_hint_from_response(finalized)
        if isinstance(memory_override, dict):
            finalized["memory"] = dict(memory_override)
        finalized["schema_version"] = "kai_voice_plan.v1"
        finalized["mode"] = mode
        finalized["action_id"] = action_id
        finalized["slots"] = slots
        finalized["guards"] = guard_ids
        finalized["reply_strategy"] = _canonical_reply_strategy_for_response(mode)
        finalized["action_completion"] = _heuristic_completion_mode(action_id, mode=mode)
        clarification = _canonical_clarification_for_response(finalized)
        if clarification is not None:
            finalized["clarification"] = clarification
        return finalized

    async def _plan_intent_with_llm_v1(
        self,
        *,
        transcript: str,
        user_id: str,
        context_payload: dict[str, Any],
        runtime_state: dict[str, Any],
        trace_hook: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> tuple[dict[str, Any] | None, int, str]:
        self._require_api_key()
        tools = _build_tools_schema()
        planner_context = build_voice_planner_context(
            transcript=transcript,
            runtime_state=runtime_state,
            context_payload=context_payload,
        )
        system_prompt = build_voice_planner_system_prompt(planner_context=planner_context)

        def _emit_trace(stage: str, payload: dict[str, Any]) -> None:
            if not trace_hook:
                return
            try:
                trace_hook(stage, payload)
            except Exception:
                logger.exception("[VOICE_PLANNER_TRACE_HOOK] stage=%s payload=%s", stage, payload)

        def _on_attempt(event_payload: dict[str, Any]) -> None:
            event = str(event_payload.get("event") or "")
            if event == "upstream_started":
                _emit_trace(
                    "planner_upstream_started",
                    {
                        "model_candidate_order": event_payload.get("model_candidate_order") or [],
                        "model_attempted": event_payload.get("model_attempted"),
                        "timeout_seconds": event_payload.get("timeout_seconds"),
                    },
                )
                return
            if event == "upstream_finished":
                _emit_trace(
                    "planner_upstream_finished",
                    {
                        "model_used": event_payload.get("model_used"),
                        "elapsed_ms": event_payload.get("elapsed_ms"),
                        "status_code": event_payload.get("status_code"),
                    },
                )
                return
            if event == "upstream_failed":
                _emit_trace(
                    "planner_upstream_failed",
                    {
                        "model_used": event_payload.get("model_used"),
                        "elapsed_ms": event_payload.get("elapsed_ms"),
                        "status_code": event_payload.get("status_code"),
                        "exception_type": event_payload.get("exception_type"),
                        "upstream_error_message": event_payload.get("upstream_error_message"),
                        "upstream_error_payload": event_payload.get("upstream_error_payload"),
                        "will_retry": event_payload.get("will_retry"),
                        "next_model": event_payload.get("next_model"),
                    },
                )

        response, result, openai_http_ms, model_used = await _post_with_model_fallback(
            url=_OPENAI_CHAT_URL,
            headers={**self._headers(), "Content-Type": "application/json"},
            candidate_models=self.intent_models,
            body_builder=lambda model_name: {
                "json": {
                    "model": model_name,
                    "temperature": 0,
                    "max_tokens": 80,
                    "tool_choice": "required",
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {
                            "role": "user",
                            "content": json.dumps(
                                {
                                    "user_id": user_id,
                                    "transcript": transcript,
                                    "planner_context": planner_context,
                                    "context": context_payload,
                                    "runtime": runtime_state,
                                }
                            ),
                        },
                    ],
                    "tools": tools,
                }
            },
            timeout_seconds=self.upstream_http_timeout_seconds,
            attempt_hook=_on_attempt,
            allow_model_fallback=not self.disable_voice_fallbacks,
        )
        if response.status_code >= 400:
            detail = _extract_openai_error(result) or "Intent planning request failed"
            raise VoiceServiceError(502, detail)
        raw_tool_call = _extract_first_tool_call(result)
        validated = _validate_tool_call(raw_tool_call)
        return validated, openai_http_ms, model_used

    async def plan_voice_response(
        self,
        *,
        transcript: str,
        user_id: str,
        app_state: dict[str, Any] | None,
        context: dict[str, Any] | None,
        active_analysis: dict[str, Any] | None = None,
        active_import: dict[str, Any] | None = None,
        trace_hook: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> tuple[dict[str, Any], int, str]:
        clean_transcript = _coerce_str(transcript)
        context_payload = _compact_context(context)
        runtime_state = _normalize_runtime_state(app_state, legacy_context=context_payload)
        app_route = app_state.get("route") if isinstance(app_state, dict) else {}
        gate_state = _normalize_voice_gate(
            app_state, user_id=user_id, legacy_context=context_payload
        )
        portfolio_state = app_state.get("portfolio") if isinstance(app_state, dict) else {}
        has_portfolio_data = bool(
            isinstance(portfolio_state, dict) and portfolio_state.get("has_portfolio_data")
        )

        if _is_transcript_unusable(clean_transcript):
            return (
                self._finalize_response(
                    self._build_response(
                        kind="clarify",
                        reason="stt_unusable",
                        message=_unusable_transcript_message(clean_transcript),
                    ),
                    gate_state=gate_state,
                    has_active_analysis=False,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        if not gate_state.get("signed_in"):
            return (
                self._finalize_response(
                    self._build_response(
                        kind="blocked",
                        reason="auth_required",
                        message="Sign in to use voice.",
                    ),
                    gate_state=gate_state,
                    has_active_analysis=False,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        if (
            not gate_state.get("vault_unlocked")
            or not gate_state.get("token_available")
            or not gate_state.get("token_valid")
            or not gate_state.get("voice_available")
        ):
            return (
                self._finalize_response(
                    self._build_response(
                        kind="blocked",
                        reason="vault_required",
                        message="Unlock your vault to use voice.",
                    ),
                    gate_state=gate_state,
                    has_active_analysis=False,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        active_analysis_payload = active_analysis if isinstance(active_analysis, dict) else {}
        authoritative_analysis_active = active_analysis_payload.get("active")
        active_analysis_ticker = _coerce_str_or_none(
            active_analysis_payload.get("ticker")
            or runtime_state.get("analysis_ticker")
            or context_payload.get("current_ticker")
        )
        active_analysis_run_id = _coerce_str_or_none(
            active_analysis_payload.get("run_id") or runtime_state.get("analysis_run_id")
        )
        if isinstance(authoritative_analysis_active, bool):
            has_active_analysis = authoritative_analysis_active
        else:
            has_active_analysis = bool(
                active_analysis_payload or runtime_state.get("analysis_active")
            )

        active_import_payload = active_import if isinstance(active_import, dict) else {}
        authoritative_import_active = active_import_payload.get("active")
        active_import_run_id = _coerce_str_or_none(
            active_import_payload.get("run_id") or runtime_state.get("import_run_id")
        )
        if isinstance(authoritative_import_active, bool):
            has_active_import = authoritative_import_active
        else:
            has_active_import = bool(active_import_payload or runtime_state.get("import_active"))

        lowered = clean_transcript.lower()
        detailed_response = _wants_detailed_response(lowered)

        _, structured_route, structured_ui, _, structured_surface, screen_metadata = (
            _read_structured_screen_context(context_payload)
        )
        current_screen = _preferred_screen_key(
            structured_route,
            structured_surface,
            app_route if isinstance(app_route, dict) else {},
        )
        current_pathname = _coerce_str(structured_route.get("pathname")) or _coerce_str(
            app_route.get("pathname") if isinstance(app_route, dict) else ""
        )
        local_surface_request = bool(
            looks_like_voice_knowledge_request(clean_transcript)
            and (
                any(
                    token in lowered
                    for token in (
                        "this button",
                        "this control",
                        "this action",
                        "this card",
                        "this section",
                        "this tab",
                        "this panel",
                    )
                )
                or bool(re.search(r"\b(?:my|this)\s+profile\b", lowered))
            )
        )

        if local_surface_request:
            compat_surface_message = resolve_surface_explanation(
                clean_transcript,
                screen=current_screen,
                surface_payload=structured_surface,
                active_section=_coerce_str_or_none(structured_ui.get("active_section")),
                active_tab=_coerce_str_or_none(structured_ui.get("active_tab")),
                focused_widget=_coerce_str_or_none(structured_ui.get("focused_widget")),
                detailed=detailed_response,
            )
        else:
            compat_surface_message = None
        if compat_surface_message:
            return (
                self._finalize_response(
                    self._build_response(
                        kind="speak_only",
                        message=compat_surface_message,
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )
        if not _is_screen_explain_intent(lowered) and looks_like_voice_knowledge_request(
            clean_transcript
        ):
            knowledge = resolve_voice_explain_knowledge(
                transcript=clean_transcript,
                screen=current_screen,
                pathname=current_pathname,
                active_section=_coerce_str_or_none(structured_ui.get("active_section")),
                active_tab=_coerce_str_or_none(structured_ui.get("active_tab")),
                focused_widget=_coerce_str_or_none(structured_ui.get("focused_widget")),
                available_actions=_coerce_str_list(structured_ui.get("available_actions")),
                visible_modules=_coerce_str_list(structured_ui.get("visible_modules")),
                screen_metadata=screen_metadata,
                allow_surface_overview=False,
            )
        else:
            knowledge = None
        if knowledge is not None and knowledge.tier in {"control", "section", "local_concept"}:
            message = knowledge.summary
            if detailed_response and knowledge.detail and knowledge.detail != knowledge.summary:
                message = f"{message} {knowledge.detail}"
            return (
                self._finalize_response(
                    self._build_response(
                        kind="speak_only",
                        message=message,
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )
        compat_concept_message = (
            resolve_global_concept(clean_transcript, detailed=detailed_response)
            if (
                not _is_screen_explain_intent(lowered)
                and looks_like_voice_knowledge_request(clean_transcript)
            )
            else None
        )
        if compat_concept_message:
            return (
                self._finalize_response(
                    self._build_response(
                        kind="speak_only",
                        message=compat_concept_message,
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )
        if knowledge is not None and knowledge.tier != "fallback":
            message = knowledge.summary
            if detailed_response and knowledge.detail and knowledge.detail != knowledge.summary:
                message = f"{message} {knowledge.detail}"
            return (
                self._finalize_response(
                    self._build_response(
                        kind="speak_only",
                        message=message,
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        if _contains_any(lowered, _DESTRUCTIVE_INTENT_KEYWORDS):
            return (
                self._finalize_response(
                    self._build_response(
                        kind="speak_only",
                        message="That action is not available in voice.",
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                    memory_override={"allow_durable_write": False},
                ),
                0,
                "deterministic",
            )

        if _is_screen_explain_intent(lowered):
            message = _build_screen_explain_message(
                transcript=clean_transcript,
                app_state=app_state,
                legacy_context=context_payload,
                detailed=detailed_response,
            )
            return (
                self._finalize_response(
                    self._build_response(kind="speak_only", message=message),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        if _contains_any(lowered, _STATUS_QUERY_KEYWORDS):
            if has_active_analysis and active_analysis_ticker:
                message = f"Analysis for {active_analysis_ticker} is currently running."
            elif has_active_import:
                message = "A portfolio import is currently running."
            else:
                message = "No analysis or import is currently running."
            return (
                self._finalize_response(
                    self._build_response(kind="speak_only", message=message),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        surface_navigation = _match_surface_navigation_intent(lowered)
        if surface_navigation == "gmail":
            return (
                self._finalize_response(
                    self._build_response(kind="speak_only", message="Opening Gmail."),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                    action_id_override="route.profile_gmail_panel",
                ),
                0,
                "deterministic",
            )

        if surface_navigation == "receipts":
            return (
                self._finalize_response(
                    self._build_response(kind="speak_only", message="Opening receipts."),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                    action_id_override="route.profile_receipts",
                ),
                0,
                "deterministic",
            )

        if surface_navigation == "pkm_agent_lab":
            return (
                self._finalize_response(
                    self._build_response(kind="speak_only", message="Opening PKM Agent Lab."),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                    action_id_override="route.profile_pkm_agent_lab",
                ),
                0,
                "deterministic",
            )

        if _is_receipts_memory_intent(lowered):
            message = (
                "Use Add receipts to memory here."
                if current_screen == "profile_receipts"
                else "Opening receipts. Use Add receipts to memory there."
            )
            action_id_override = (
                None if current_screen == "profile_receipts" else "route.profile_receipts"
            )
            return (
                self._finalize_response(
                    self._build_response(kind="speak_only", message=message),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                    action_id_override=action_id_override,
                ),
                0,
                "deterministic",
            )

        analyze_target = _extract_analyze_target(clean_transcript)
        if analyze_target is not None:
            if has_active_analysis:
                ticker_label = active_analysis_ticker or "unknown ticker"
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="already_running",
                            task="analysis",
                            ticker=active_analysis_ticker,
                            run_id=active_analysis_run_id,
                            message=f"Analysis is already running for {ticker_label}.",
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                    ),
                    0,
                    "deterministic",
                )

            if not runtime_state.get("complete") and gate_state.get("source") == "app_state":
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="speak_only",
                            message="I couldn't verify app state right now. Please try again.",
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                    ),
                    0,
                    "deterministic",
                )

            resolution = _resolve_ticker_target(analyze_target)
            if resolution.get("kind") == "exact":
                symbol = _coerce_str(resolution.get("ticker")).upper()
                tool_call = {
                    "tool_name": "execute_kai_command",
                    "args": {"command": "analyze", "params": {"symbol": symbol}},
                }
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="execute",
                            message=_build_execute_message(tool_call),
                            tool_call=tool_call,
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                    ),
                    0,
                    "deterministic",
                )

            if resolution.get("kind") == "candidate":
                candidate = _coerce_str(resolution.get("candidate")).upper()
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="clarify",
                            reason="ticker_unknown",
                            candidate=candidate,
                            message=f"I don't know this company. Did you mean {candidate}?",
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                    ),
                    0,
                    "deterministic",
                )

            if resolution.get("kind") == "ambiguous":
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="clarify",
                            reason="ticker_ambiguous",
                            message="I found multiple matches. Please say the stock ticker.",
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                    ),
                    0,
                    "deterministic",
                )

            return (
                self._finalize_response(
                    self._build_response(
                        kind="clarify",
                        reason="ticker_unknown",
                        message="I couldn't identify that company. Please repeat the company or stock ticker.",
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        if re.search(r"\b(start|begin|run|do)\b.*\banalysis\b", lowered):
            return (
                self._finalize_response(
                    self._build_response(
                        kind="clarify",
                        reason="ticker_unknown",
                        message="Please say the stock ticker you want to analyze.",
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        if _contains_any(lowered, _IMPORT_INTENT_KEYWORDS):
            if has_active_import:
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="already_running",
                            task="import",
                            run_id=active_import_run_id,
                            message="An import is already running.",
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                    ),
                    0,
                    "deterministic",
                )
            return (
                self._finalize_response(
                    self._build_response(
                        kind="execute",
                        message="Opening import.",
                        tool_call={
                            "tool_name": "execute_kai_command",
                            "args": {"command": "import"},
                        },
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        if _contains_any(lowered, _RESUME_INTENT_KEYWORDS):
            if not has_active_analysis:
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="speak_only",
                            message="No active analysis is running right now.",
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                        action_id_override="analysis.resume_active",
                    ),
                    0,
                    "deterministic",
                )
            return (
                self._finalize_response(
                    self._build_response(
                        kind="execute",
                        message="Resuming analysis.",
                        tool_call={"tool_name": "resume_active_analysis", "args": {}},
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        if _contains_any(lowered, _CANCEL_INTENT_KEYWORDS):
            if not has_active_analysis:
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="speak_only",
                            message="No active analysis is running right now.",
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                        action_id_override="analysis.cancel_active",
                    ),
                    0,
                    "deterministic",
                )
            return (
                self._finalize_response(
                    self._build_response(
                        kind="execute",
                        message="Cancelling analysis.",
                        tool_call={
                            "tool_name": "cancel_active_analysis",
                            "args": {"confirm": True},
                        },
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        if "go back" in lowered or lowered.strip() == "back":
            return (
                self._finalize_response(
                    self._build_response(
                        kind="execute",
                        message="Going back.",
                        tool_call={"tool_name": "navigate_back", "args": {}},
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                    action_id_override="route.back",
                ),
                0,
                "deterministic",
            )

        if _is_analysis_navigation_request(lowered):
            return (
                self._finalize_response(
                    self._build_response(
                        kind="execute",
                        message="Opening analysis history.",
                        tool_call={
                            "tool_name": "execute_kai_command",
                            "args": {"command": "history"},
                        },
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                0,
                "deterministic",
            )

        for keyword, command in _NAV_COMMAND_KEYWORDS:
            if keyword in lowered:
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="execute",
                            message=f"Opening {_spoken_command_label(command)}.",
                            tool_call={
                                "tool_name": "execute_kai_command",
                                "args": {"command": command},
                            },
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                    ),
                    0,
                    "deterministic",
                )

        tool_call, openai_http_ms, model_used = await self._plan_intent_with_llm_v1(
            transcript=clean_transcript,
            user_id=user_id,
            context_payload=context_payload,
            runtime_state=runtime_state,
            trace_hook=trace_hook,
        )

        validated = _validate_tool_call(tool_call)
        if not validated:
            return (
                self._finalize_response(
                    self._build_response(
                        kind="clarify",
                        reason="stt_unusable",
                        message=_UNCLEAR_STT_MESSAGE,
                    ),
                    gate_state=gate_state,
                    has_active_analysis=has_active_analysis,
                    has_portfolio_data=has_portfolio_data,
                ),
                openai_http_ms,
                model_used,
            )

        if validated["tool_name"] == "execute_kai_command":
            command = _coerce_str(validated["args"].get("command"))
            params = validated["args"].get("params") if isinstance(validated["args"], dict) else {}
            if command == "analyze" and has_active_analysis:
                ticker_label = active_analysis_ticker or "unknown ticker"
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="already_running",
                            task="analysis",
                            ticker=active_analysis_ticker,
                            run_id=active_analysis_run_id,
                            message=f"Analysis is already running for {ticker_label}.",
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                    ),
                    openai_http_ms,
                    model_used,
                )
            if command == "analyze" and not _coerce_str((params or {}).get("symbol")):
                return (
                    self._finalize_response(
                        self._build_response(
                            kind="clarify",
                            reason="ticker_unknown",
                            message="Please say the stock ticker you want to analyze.",
                        ),
                        gate_state=gate_state,
                        has_active_analysis=has_active_analysis,
                        has_portfolio_data=has_portfolio_data,
                    ),
                    openai_http_ms,
                    model_used,
                )

        return (
            self._finalize_response(
                self._build_response(
                    kind="execute",
                    message=_build_execute_message(validated),
                    tool_call=validated,
                ),
                gate_state=gate_state,
                has_active_analysis=has_active_analysis,
                has_portfolio_data=has_portfolio_data,
                action_id_override="route.back"
                if _coerce_str(validated.get("tool_name")) == "navigate_back"
                else None,
            ),
            openai_http_ms,
            model_used,
        )

    async def compose_voice_reply(
        self,
        *,
        transcript: str,
        user_id: str,
        app_state: dict[str, Any] | None,
        context: dict[str, Any] | None,
        plan_payload: dict[str, Any],
        response_payload: dict[str, Any],
        action_result: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], int, str]:
        self._require_api_key()
        clean_transcript = _coerce_str(transcript)
        if not clean_transcript:
            raise VoiceServiceError(422, "Transcript is empty")

        context_payload = _compact_context(context)
        runtime_state = _normalize_runtime_state(app_state, legacy_context=context_payload)
        composer_context = build_voice_response_composer_context(
            transcript=clean_transcript,
            runtime_state=runtime_state,
            context_payload=context_payload,
            plan_payload=plan_payload,
            response_payload=response_payload,
            action_result=action_result,
        )
        system_prompt = build_voice_response_composer_system_prompt(
            composer_context=composer_context
        )

        response, result, openai_http_ms, model_used = await _post_with_model_fallback(
            url=_OPENAI_CHAT_URL,
            headers={**self._headers(), "Content-Type": "application/json"},
            candidate_models=self.intent_models,
            body_builder=lambda model_name: {
                "json": {
                    "model": model_name,
                    "temperature": 0.2,
                    "max_tokens": 140,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {
                            "role": "user",
                            "content": json.dumps(
                                {
                                    "user_id": user_id,
                                    "transcript": clean_transcript,
                                    "plan": {
                                        "mode": plan_payload.get("mode"),
                                        "action_id": plan_payload.get("action_id"),
                                        "slots": dict(plan_payload.get("slots") or {}),
                                        "guards": list(plan_payload.get("guards") or []),
                                        "reply_strategy": plan_payload.get("reply_strategy"),
                                        "action_completion": plan_payload.get("action_completion"),
                                    },
                                    "response": {
                                        "kind": response_payload.get("kind"),
                                        "message": response_payload.get("message"),
                                        "reason": response_payload.get("reason"),
                                        "task": response_payload.get("task"),
                                        "ticker": response_payload.get("ticker"),
                                        "execution_allowed": response_payload.get(
                                            "execution_allowed"
                                        ),
                                    },
                                    "action_result": dict(action_result or {})
                                    if isinstance(action_result, dict)
                                    else None,
                                    "composer_context": composer_context,
                                }
                            ),
                        },
                    ],
                }
            },
            timeout_seconds=self.upstream_http_timeout_seconds,
            allow_model_fallback=not self.disable_voice_fallbacks,
        )
        if response.status_code >= 400:
            detail = _extract_openai_error(result) or "Voice response composition failed"
            raise VoiceServiceError(502, detail)

        parsed = _extract_first_json_message(result) or {}
        fallback_mode = str(plan_payload.get("mode") or "").strip()
        fallback_segment_type = (
            "ack"
            if fallback_mode == "start_background_and_ack"
            or (
                isinstance(action_result, dict)
                and str(action_result.get("status") or "").strip() == "started"
            )
            else "final"
        )
        fallback_text = (
            _coerce_str((action_result or {}).get("result_summary"))
            if isinstance(action_result, dict)
            else ""
        ) or _coerce_str(response_payload.get("message"))
        composed_text = _enforce_english_voice_output(
            _coerce_str(parsed.get("text")) or fallback_text
        )
        if not composed_text:
            raise VoiceServiceError(502, "Voice response composition returned empty text")

        segment_type = _coerce_str(parsed.get("segment_type")).lower() or fallback_segment_type
        if segment_type not in {"ack", "final"}:
            segment_type = fallback_segment_type
        return (
            {
                "text": composed_text,
                "segment_type": segment_type,
            },
            openai_http_ms,
            model_used,
        )

    async def synthesize_speech(
        self,
        *,
        text: str,
        voice: str,
        trace_hook: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> tuple[bytes, str, dict[str, Any]]:
        tts_stream, mime_type, tts_meta = await self.open_tts_stream(
            text=text,
            voice=voice,
            trace_hook=trace_hook,
        )
        audio_chunks: list[bytes] = []
        try:
            while True:
                chunk = await tts_stream.read_next_chunk()
                if chunk is None:
                    break
                audio_chunks.append(chunk)
        finally:
            await tts_stream.aclose()
        return b"".join(audio_chunks), mime_type, tts_meta

    async def open_tts_stream(
        self,
        *,
        text: str,
        voice: str,
        trace_hook: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> tuple[VoiceTTSStreamHandle, str, dict[str, Any]]:
        self._require_api_key()
        clean_text = str(text or "").strip()
        if not clean_text:
            raise VoiceServiceError(422, "Text is required for TTS")
        selected_voice = str(voice or self.tts_default_voice).strip() or self.tts_default_voice
        selected_model = self.tts_model or "gpt-4o-mini-tts"
        tts_attempts: list[dict[str, Any]] = []
        started_at = time.perf_counter()
        if trace_hook:
            trace_hook(
                "tts_upstream_started",
                {
                    "model_attempted": selected_model,
                    "attempt_index": 1,
                    "attempt_count": 1,
                    "timeout_seconds": self.tts_timeout_seconds,
                    "text_chars": len(clean_text),
                },
            )

        client = httpx.AsyncClient(timeout=self.tts_timeout_seconds)
        response_cm = client.stream(
            "POST",
            _OPENAI_TTS_URL,
            headers={
                **self._headers(),
                "Content-Type": "application/json",
            },
            json={
                "model": selected_model,
                "input": clean_text,
                "voice": selected_voice,
                "format": self.tts_format,
                "instructions": _VOICE_TTS_INSTRUCTIONS,
            },
        )

        try:
            response = await response_cm.__aenter__()
        except Exception:
            await client.aclose()
            raise

        attempt_elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        content_length_raw = str(response.headers.get("content-length") or "").strip()
        content_length: int | None = None
        if content_length_raw.isdigit():
            content_length = int(content_length_raw)

        if response.status_code >= 400:
            error_payload: dict[str, Any] = {}
            if response.content:
                try:
                    error_payload = response.json()
                except Exception:
                    error_payload = {}
            extracted_error = _extract_openai_error(error_payload)
            tts_attempts.append(
                {
                    "model": selected_model,
                    "status_code": response.status_code,
                    "elapsed_ms": attempt_elapsed_ms,
                    "result": "failed",
                    "error": extracted_error or "",
                }
            )
            if trace_hook:
                trace_hook(
                    "tts_upstream_failed",
                    {
                        "model_used": selected_model,
                        "elapsed_ms": attempt_elapsed_ms,
                        "status_code": response.status_code,
                        "exception_type": None,
                        "upstream_error_message": extracted_error,
                        "upstream_error_payload": error_payload.get("error")
                        if isinstance(error_payload, dict)
                        else error_payload,
                    },
                )
            detail = extracted_error or "TTS request failed"
            await response.aclose()
            await response_cm.__aexit__(None, None, None)
            await client.aclose()
            raise VoiceServiceError(502, detail)

        tts_attempts.append(
            {
                "model": selected_model,
                "status_code": response.status_code,
                "elapsed_ms": attempt_elapsed_ms,
                "result": "success",
            }
        )
        if trace_hook:
            trace_hook(
                "tts_upstream_ready",
                {
                    "model_used": selected_model,
                    "elapsed_ms": attempt_elapsed_ms,
                    "status_code": response.status_code,
                    "content_length": content_length,
                },
            )
        mime_type = "audio/mpeg" if self.tts_format == "mp3" else f"audio/{self.tts_format}"
        meta = {
            "model": selected_model,
            "voice": selected_voice,
            "format": self.tts_format,
            "source": "backend_openai_audio",
            "attempts": tts_attempts,
            "openai_http_ms": attempt_elapsed_ms,
            "audio_bytes": 0,
            "content_length": content_length,
            "completed": False,
            "aborted": False,
        }
        logger.info(
            "[VOICE_TTS] status=ready source=backend_openai_audio model=%s voice=%s format=%s "
            "text_chars=%s content_length=%s attempts=%s",
            selected_model,
            selected_voice,
            self.tts_format,
            len(clean_text),
            content_length,
            tts_attempts,
        )
        return (
            VoiceTTSStreamHandle(
                response=response,
                response_cm=response_cm,
                client=client,
                meta=meta,
                trace_hook=trace_hook,
                started_at=started_at,
            ),
            mime_type,
            meta,
        )


def _extract_openai_error(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
    return None


def _extract_first_message_content(payload: dict[str, Any]) -> str | None:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str):
        text = content.strip()
        return text or None
    if isinstance(content, list):
        text_parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                part = item["text"].strip()
                if part:
                    text_parts.append(part)
        joined = "\n".join(text_parts).strip()
        return joined or None
    return None


def _extract_first_json_message(payload: dict[str, Any]) -> dict[str, Any] | None:
    raw_content = _extract_first_message_content(payload)
    if not raw_content:
        return None
    try:
        parsed = json.loads(raw_content)
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _extract_first_tool_call(payload: dict[str, Any]) -> dict[str, Any] | None:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return None
    call = tool_calls[0]
    if not isinstance(call, dict):
        return None
    fn = call.get("function")
    if not isinstance(fn, dict):
        return None
    name = fn.get("name")
    raw_args = fn.get("arguments")
    if not isinstance(name, str) or not isinstance(raw_args, str):
        return None
    try:
        args = json.loads(raw_args)
    except Exception:
        return None
    return {
        "tool_name": name,
        "args": args,
    }


def _build_tools_schema() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "execute_kai_command",
                "description": "Execute an existing Kai command action.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "command": {
                            "type": "string",
                            "enum": sorted(_ALLOWED_COMMANDS),
                        },
                        "params": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "symbol": {"type": "string"},
                                "focus": {"type": "string", "enum": ["active"]},
                                "tab": {"type": "string", "enum": sorted(_ALLOWED_HISTORY_TABS)},
                            },
                        },
                    },
                    "required": ["command"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "navigate_back",
                "description": "Navigate back using existing app back handler.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {},
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "resume_active_analysis",
                "description": "Resume active analysis run for current user/session.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {},
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "cancel_active_analysis",
                "description": "Cancel active analysis run, requires confirmation.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "confirm": {"type": "boolean"},
                    },
                    "required": ["confirm"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "clarify",
                "description": "Ask user a clarification question before any action.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "question": {"type": "string"},
                        "options": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["question"],
                },
            },
        },
    ]


def _validate_tool_call(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    tool_name = value.get("tool_name")
    args = value.get("args")
    if not isinstance(tool_name, str) or tool_name not in _ALLOWED_TOOL_NAMES:
        return None
    if not isinstance(args, dict):
        return None

    if tool_name in {"navigate_back", "resume_active_analysis"}:
        if args:
            return None
        return {"tool_name": tool_name, "args": {}}

    if tool_name == "cancel_active_analysis":
        if set(args.keys()) != {"confirm"}:
            return None
        if not isinstance(args.get("confirm"), bool):
            return None
        return {"tool_name": tool_name, "args": {"confirm": args["confirm"]}}

    if tool_name == "clarify":
        allowed = {"question", "options"}
        if any(key not in allowed for key in args.keys()):
            return None
        question = args.get("question")
        if not isinstance(question, str) or not question.strip():
            return None
        question_text = _enforce_english_voice_output(question)
        options = args.get("options")
        if options is not None:
            if not isinstance(options, list) or not all(isinstance(item, str) for item in options):
                return None
        out = {
            "tool_name": "clarify",
            "args": {
                "question": question_text,
            },
        }
        if options is not None:
            out["args"]["options"] = options
        return out

    if tool_name == "execute_kai_command":
        allowed = {"command", "params"}
        if any(key not in allowed for key in args.keys()):
            return None

        command = args.get("command")
        if not isinstance(command, str):
            return None
        normalized_command = command.strip().lower().replace(" ", "_")
        command = _COMMAND_ALIASES.get(normalized_command, normalized_command)

        out_params: dict[str, Any] = {}
        raw_params = args.get("params")
        if raw_params is not None:
            if not isinstance(raw_params, dict):
                return None
            if any(key not in {"symbol", "focus", "tab"} for key in raw_params.keys()):
                return None

            symbol = raw_params.get("symbol")
            if symbol is not None:
                if not isinstance(symbol, str) or not symbol.strip():
                    return None
                out_params["symbol"] = symbol.strip().upper()

            focus = raw_params.get("focus")
            if focus is not None:
                if focus != "active":
                    return None
                out_params["focus"] = "active"

            tab = raw_params.get("tab")
            if tab is not None:
                if tab not in _ALLOWED_HISTORY_TABS:
                    return None
                out_params["tab"] = tab

        if command not in _ALLOWED_COMMANDS:
            return None

        if command == "analyze" and "symbol" not in out_params:
            return None

        tool_call = {
            "tool_name": "execute_kai_command",
            "args": {
                "command": command,
            },
        }
        if out_params:
            tool_call["args"]["params"] = out_params
        return tool_call

    return None
