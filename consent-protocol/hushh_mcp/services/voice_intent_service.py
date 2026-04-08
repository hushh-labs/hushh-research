import json
import logging
import os
import re
import time
from collections.abc import Callable
from difflib import get_close_matches
from typing import Any

import httpx

from hushh_mcp.services.symbol_master_service import get_symbol_master_service
from hushh_mcp.services.ticker_cache import ticker_cache
from hushh_mcp.services.voice_app_knowledge import (
    looks_like_voice_knowledge_request,
    resolve_global_concept,
    resolve_surface_explanation,
    resolve_voice_explain_knowledge,
)

logger = logging.getLogger(__name__)

_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
_OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions"
_OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"
_OPENAI_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
_OPENAI_HTTP_TIMEOUT_SECONDS = 45.0
_OPENAI_TTS_TIMEOUT_SECONDS = 20.0
_REALTIME_TRANSCRIPTION_LANGUAGE = "en"
_REALTIME_TRANSCRIPTION_PROMPT = (
    "Transcribe spoken English only. Do not translate or transliterate. "
    "If the speech is unclear, keep the transcript short and in English."
)
_REALTIME_NOISE_REDUCTION_TYPE = "near_field"
_REALTIME_SERVER_VAD_THRESHOLD = 0.72
_REALTIME_SERVER_VAD_PREFIX_PADDING_MS = 450

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
_PLANNER_NORMALIZATION_VERSION = "2026-03-13-stabilize-a"
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
    r"^\s*(?:start|run|begin|do|open)?\s*(?:the\s+)?analysis(?:\s+(?:for|of|on|about))\s+(?P<target>.+?)\s*$",
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
    return bool(
        re.search(
            r"\bwhat(?:'s| is)\s+(?:going on|happening)\s+(?:on\s+)?(?:my|the)\s+screen\b",
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
    visible_modules_line = (
        f"Visible modules include {', '.join(visible_modules[:4])}." if visible_modules else None
    )
    portfolio_line = (
        "Portfolio data is connected."
        if has_portfolio_data
        else "Portfolio data is limited right now."
    )

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


def _is_transcript_unusable(transcript: str) -> bool:
    clean = _coerce_str(transcript)
    if not clean:
        return True
    if len(re.sub(r"[^a-zA-Z0-9]+", "", clean)) < _MIN_ACTIONABLE_CHARS:
        return True
    if not _is_likely_english(clean):
        return True
    tokens = [token for token in re.split(r"[\s,.;:!?]+", clean.lower()) if token]
    if not tokens:
        return True
    if len(tokens) <= 2 and all(token in _FILLER_WORDS for token in tokens):
        return True
    return False


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


def _resolve_ticker_target(target: str) -> dict[str, Any]:
    query = _coerce_str(target)
    if not query:
        return {"kind": "unknown", "candidate": None, "matches": []}

    normalized_query = re.sub(r"\s+", " ", query).strip()
    uppercase_query = normalized_query.upper()
    symbol_master = get_symbol_master_service()

    if _TICKER_PATTERN_RE.match(uppercase_query):
        classification = symbol_master.classify(uppercase_query)
        metadata = symbol_master.get_ticker_metadata(uppercase_query)
        if classification.tradable and metadata is not None:
            return {"kind": "exact", "ticker": classification.symbol}

    alias_key = normalized_query.lower()
    alias_ticker = _COMPANY_ALIAS_TO_TICKER.get(alias_key)
    if alias_ticker:
        return {"kind": "exact", "ticker": alias_ticker}

    if not ticker_cache.loaded:
        try:
            ticker_cache.load_from_db()
        except Exception:
            logger.warning("[VOICE_RESOLVE] ticker cache load failed", exc_info=True)

    rows = ticker_cache.search(normalized_query, limit=5)
    tickers = [str(row.get("ticker") or "").upper() for row in rows if row.get("ticker")]
    tickers = [ticker for ticker in tickers if ticker]

    if len(tickers) == 1:
        return {"kind": "candidate", "candidate": tickers[0], "matches": tickers}
    if len(tickers) > 1:
        titles = [str(row.get("title") or "").strip().lower() for row in rows]
        close = get_close_matches(alias_key, titles, n=1, cutoff=0.92)
        if close:
            idx = titles.index(close[0])
            return {
                "kind": "candidate",
                "candidate": str(rows[idx].get("ticker") or "").upper(),
                "matches": tickers,
            }
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


class VoiceIntentService:
    def __init__(self) -> None:
        self.api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
        self.force_realtime_voice = _env_bool("FORCE_REALTIME_VOICE", default=False)
        self.fail_fast_voice = _env_bool("FAIL_FAST_VOICE", default=False)
        self.disable_voice_fallbacks = (
            _env_bool("DISABLE_VOICE_FALLBACKS", default=False)
            or self.fail_fast_voice
            or self.force_realtime_voice
        )
        self.realtime_enabled = _env_bool(
            "KAI_VOICE_REALTIME_ENABLED", default=self.force_realtime_voice
        )
        self.realtime_model = (
            os.getenv("OPENAI_VOICE_REALTIME_MODEL") or "gpt-realtime"
        ).strip() or "gpt-realtime"
        self.stt_models = _parse_model_candidates(
            os.getenv("OPENAI_VOICE_STT_MODELS"),
            default_models=[
                os.getenv("OPENAI_VOICE_STT_MODEL") or "gpt-4o-mini-transcribe",
                "whisper-1",
            ],
        )
        self.intent_models = _parse_model_candidates(
            os.getenv("OPENAI_VOICE_INTENT_MODELS"),
            default_models=[
                os.getenv("OPENAI_VOICE_INTENT_MODEL") or "gpt-4.1-nano",
                "gpt-4o-mini",
                "gpt-4.1-mini",
            ],
        )
        configured_tts_model = (os.getenv("OPENAI_VOICE_TTS_MODEL") or "").strip()
        parsed_tts_models = _parse_model_candidates(
            os.getenv("OPENAI_VOICE_TTS_MODELS"),
            default_models=[
                configured_tts_model or "gpt-4o-mini-tts",
                "gpt-4o-mini-tts",
            ],
        )
        self.tts_prefer_quality = _env_bool("OPENAI_VOICE_TTS_PREFER_QUALITY", default=False)
        self.tts_models = _prioritize_tts_models(
            parsed_tts_models,
            configured_model=configured_tts_model,
            prefer_quality=self.tts_prefer_quality,
        )
        self.tts_model = self.tts_models[0]
        self.tts_models = [self.tts_model]
        self.tts_default_voice = (
            os.getenv("OPENAI_VOICE_TTS_DEFAULT_VOICE") or "alloy"
        ).strip() or "alloy"
        self.tts_format = (os.getenv("OPENAI_VOICE_TTS_FORMAT") or "mp3").strip() or "mp3"
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
                "[VOICE_FAIL_FAST] model fallback chains are disabled (DISABLE_VOICE_FALLBACKS/FAIL_FAST_VOICE)."
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
                "data": {"model": model_name},
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

        tools = _build_tools_schema()
        context_payload = _compact_context(context)

        system_prompt = (
            "You are Kai voice intent planner. Output exactly one tool call from provided tools. "
            "Never output plain text. "
            "Do not produce conversational filler. Spoken response styling is handled separately. "
            "Important: speech-to-text may contain misspellings/homophones. Infer the intended destination "
            "for navigation requests like go to / take me to / open / navigate to, even if text is imperfect. "
            "Navigation target mapping: "
            "dashboard|portfolio => execute_kai_command(command='dashboard'); "
            "import|upload statement|portfolio import => execute_kai_command(command='import'); "
            "history|analysis history|analysis tab => execute_kai_command(command='history'); "
            "market|kai|home => execute_kai_command(command='home'); "
            "consent|consents|similar sounding consent words => execute_kai_command(command='consent'); "
            "profile => execute_kai_command(command='profile'). "
            "For 'analyze <company_or_symbol>' always use execute_kai_command(command='analyze', params.symbol='<SYMBOL>'). "
            "If likely ticker is uncertain, return clarify."
        )

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
        return {"allow_durable_write": allow}

    @staticmethod
    def _legacy_tool_call_for_response(response: dict[str, Any]) -> dict[str, Any]:
        tool_call = response.get("tool_call")
        if isinstance(tool_call, dict):
            return tool_call
        message = _coerce_str(response.get("message")) or _UNCLEAR_STT_MESSAGE
        return {"tool_name": "clarify", "args": {"question": message}}

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
        system_prompt = (
            "You are Kai voice intent planner. "
            "Use English-only behavior for V1. "
            "Return exactly one tool call from provided tools and never output plain text. "
            "Do not add conversational filler or explanation."
        )

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

        if _is_transcript_unusable(clean_transcript):
            response = self._build_response(
                kind="clarify",
                reason="stt_unusable",
                message=_UNCLEAR_STT_MESSAGE,
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if not gate_state.get("signed_in"):
            response = self._build_response(
                kind="blocked",
                reason="auth_required",
                message="Sign in to use voice.",
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if (
            not gate_state.get("vault_unlocked")
            or not gate_state.get("token_available")
            or not gate_state.get("token_valid")
            or not gate_state.get("voice_available")
        ):
            response = self._build_response(
                kind="blocked",
                reason="vault_required",
                message="Unlock your vault to use voice.",
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

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
            response = self._build_response(
                kind="speak_only",
                message=compat_surface_message,
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"
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
            response = self._build_response(
                kind="speak_only",
                message=message,
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"
        compat_concept_message = (
            resolve_global_concept(clean_transcript, detailed=detailed_response)
            if (
                not _is_screen_explain_intent(lowered)
                and looks_like_voice_knowledge_request(clean_transcript)
            )
            else None
        )
        if compat_concept_message:
            response = self._build_response(
                kind="speak_only",
                message=compat_concept_message,
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"
        if knowledge is not None and knowledge.tier != "fallback":
            message = knowledge.summary
            if detailed_response and knowledge.detail and knowledge.detail != knowledge.summary:
                message = f"{message} {knowledge.detail}"
            response = self._build_response(
                kind="speak_only",
                message=message,
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if _contains_any(lowered, _DESTRUCTIVE_INTENT_KEYWORDS):
            response = self._build_response(
                kind="speak_only",
                message="That action is not available in voice.",
            )
            response["memory"] = {"allow_durable_write": False}
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if _is_screen_explain_intent(lowered):
            message = _build_screen_explain_message(
                transcript=clean_transcript,
                app_state=app_state,
                legacy_context=context_payload,
                detailed=detailed_response,
            )
            response = self._build_response(kind="speak_only", message=message)
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if _contains_any(lowered, _STATUS_QUERY_KEYWORDS):
            if has_active_analysis and active_analysis_ticker:
                message = f"Analysis for {active_analysis_ticker} is currently running."
            elif has_active_import:
                message = "A portfolio import is currently running."
            else:
                message = "No analysis or import is currently running."
            response = self._build_response(kind="speak_only", message=message)
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        surface_navigation = _match_surface_navigation_intent(lowered)
        if surface_navigation == "gmail":
            response = self._build_response(kind="speak_only", message="Opening Gmail.")
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if surface_navigation == "receipts":
            response = self._build_response(kind="speak_only", message="Opening receipts.")
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if surface_navigation == "pkm_agent_lab":
            response = self._build_response(kind="speak_only", message="Opening PKM Agent Lab.")
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if _is_receipts_memory_intent(lowered):
            message = (
                "Use Add receipts to memory here."
                if current_screen == "profile_receipts"
                else "Opening receipts. Use Add receipts to memory there."
            )
            response = self._build_response(kind="speak_only", message=message)
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        analyze_target = _extract_analyze_target(clean_transcript)
        if analyze_target is not None:
            if has_active_analysis:
                ticker_label = active_analysis_ticker or "unknown ticker"
                response = self._build_response(
                    kind="already_running",
                    task="analysis",
                    ticker=active_analysis_ticker,
                    run_id=active_analysis_run_id,
                    message=f"Analysis is already running for {ticker_label}.",
                )
                response["memory"] = self._memory_hint_from_response(response)
                response["tool_call"] = self._legacy_tool_call_for_response(response)
                return response, 0, "deterministic"

            if not runtime_state.get("complete") and gate_state.get("source") == "app_state":
                response = self._build_response(
                    kind="speak_only",
                    message="I couldn't verify app state right now. Please try again.",
                )
                response["memory"] = self._memory_hint_from_response(response)
                response["tool_call"] = self._legacy_tool_call_for_response(response)
                return response, 0, "deterministic"

            resolution = _resolve_ticker_target(analyze_target)
            if resolution.get("kind") == "exact":
                symbol = _coerce_str(resolution.get("ticker")).upper()
                tool_call = {
                    "tool_name": "execute_kai_command",
                    "args": {"command": "analyze", "params": {"symbol": symbol}},
                }
                response = self._build_response(
                    kind="execute",
                    message=_build_execute_message(tool_call),
                    tool_call=tool_call,
                )
                response["memory"] = self._memory_hint_from_response(response)
                return response, 0, "deterministic"

            if resolution.get("kind") == "candidate":
                candidate = _coerce_str(resolution.get("candidate")).upper()
                response = self._build_response(
                    kind="clarify",
                    reason="ticker_unknown",
                    candidate=candidate,
                    message=f"I don't know this company. Did you mean {candidate}?",
                )
                response["memory"] = self._memory_hint_from_response(response)
                response["tool_call"] = self._legacy_tool_call_for_response(response)
                return response, 0, "deterministic"

            if resolution.get("kind") == "ambiguous":
                response = self._build_response(
                    kind="clarify",
                    reason="ticker_ambiguous",
                    message="I found multiple matches. Please say the stock ticker.",
                )
                response["memory"] = self._memory_hint_from_response(response)
                response["tool_call"] = self._legacy_tool_call_for_response(response)
                return response, 0, "deterministic"

            response = self._build_response(
                kind="clarify",
                reason="ticker_unknown",
                message="I couldn't identify that company. Please repeat the company or stock ticker.",
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if re.search(r"\b(start|begin|run|do)\b.*\banalysis\b", lowered):
            response = self._build_response(
                kind="clarify",
                reason="ticker_unknown",
                message="Please say the stock ticker you want to analyze.",
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, 0, "deterministic"

        if _contains_any(lowered, _IMPORT_INTENT_KEYWORDS):
            if has_active_import:
                response = self._build_response(
                    kind="already_running",
                    task="import",
                    run_id=active_import_run_id,
                    message="An import is already running.",
                )
                response["memory"] = self._memory_hint_from_response(response)
                response["tool_call"] = self._legacy_tool_call_for_response(response)
                return response, 0, "deterministic"
            response = self._build_response(
                kind="execute",
                message="Opening import.",
                tool_call={"tool_name": "execute_kai_command", "args": {"command": "import"}},
            )
            response["memory"] = self._memory_hint_from_response(response)
            return response, 0, "deterministic"

        if _contains_any(lowered, _RESUME_INTENT_KEYWORDS):
            if not has_active_analysis:
                response = self._build_response(
                    kind="speak_only",
                    message="No active analysis is running right now.",
                )
                response["memory"] = self._memory_hint_from_response(response)
                response["tool_call"] = self._legacy_tool_call_for_response(response)
                return response, 0, "deterministic"
            response = self._build_response(
                kind="execute",
                message="Resuming analysis.",
                tool_call={"tool_name": "resume_active_analysis", "args": {}},
            )
            response["memory"] = self._memory_hint_from_response(response)
            return response, 0, "deterministic"

        if _contains_any(lowered, _CANCEL_INTENT_KEYWORDS):
            if not has_active_analysis:
                response = self._build_response(
                    kind="speak_only",
                    message="No active analysis is running right now.",
                )
                response["memory"] = self._memory_hint_from_response(response)
                response["tool_call"] = self._legacy_tool_call_for_response(response)
                return response, 0, "deterministic"
            response = self._build_response(
                kind="execute",
                message="Cancelling analysis.",
                tool_call={"tool_name": "cancel_active_analysis", "args": {"confirm": True}},
            )
            response["memory"] = self._memory_hint_from_response(response)
            return response, 0, "deterministic"

        if "go back" in lowered or lowered.strip() == "back":
            response = self._build_response(
                kind="execute",
                message="Going back.",
                tool_call={"tool_name": "navigate_back", "args": {}},
            )
            response["memory"] = self._memory_hint_from_response(response)
            return response, 0, "deterministic"

        for keyword, command in _NAV_COMMAND_KEYWORDS:
            if keyword in lowered:
                response = self._build_response(
                    kind="execute",
                    message=f"Opening {_spoken_command_label(command)}.",
                    tool_call={"tool_name": "execute_kai_command", "args": {"command": command}},
                )
                response["memory"] = self._memory_hint_from_response(response)
                return response, 0, "deterministic"

        tool_call, openai_http_ms, model_used = await self._plan_intent_with_llm_v1(
            transcript=clean_transcript,
            user_id=user_id,
            context_payload=context_payload,
            runtime_state=runtime_state,
            trace_hook=trace_hook,
        )

        validated = _validate_tool_call(tool_call)
        if not validated:
            response = self._build_response(
                kind="clarify",
                reason="stt_unusable",
                message=_UNCLEAR_STT_MESSAGE,
            )
            response["memory"] = self._memory_hint_from_response(response)
            response["tool_call"] = self._legacy_tool_call_for_response(response)
            return response, openai_http_ms, model_used

        if validated["tool_name"] == "execute_kai_command":
            command = _coerce_str(validated["args"].get("command"))
            params = validated["args"].get("params") if isinstance(validated["args"], dict) else {}
            if command == "analyze" and has_active_analysis:
                ticker_label = active_analysis_ticker or "unknown ticker"
                response = self._build_response(
                    kind="already_running",
                    task="analysis",
                    ticker=active_analysis_ticker,
                    run_id=active_analysis_run_id,
                    message=f"Analysis is already running for {ticker_label}.",
                )
                response["memory"] = self._memory_hint_from_response(response)
                response["tool_call"] = self._legacy_tool_call_for_response(response)
                return response, openai_http_ms, model_used
            if command == "analyze" and not _coerce_str((params or {}).get("symbol")):
                response = self._build_response(
                    kind="clarify",
                    reason="ticker_unknown",
                    message="Please say the stock ticker you want to analyze.",
                )
                response["memory"] = self._memory_hint_from_response(response)
                response["tool_call"] = self._legacy_tool_call_for_response(response)
                return response, openai_http_ms, model_used

        response = self._build_response(
            kind="execute",
            message=_build_execute_message(validated),
            tool_call=validated,
        )
        response["memory"] = self._memory_hint_from_response(response)
        return response, openai_http_ms, model_used

    async def synthesize_speech(
        self,
        *,
        text: str,
        voice: str,
        trace_hook: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> tuple[bytes, str, dict[str, Any]]:
        self._require_api_key()
        clean_text = str(text or "").strip()
        if not clean_text:
            raise VoiceServiceError(422, "Text is required for TTS")
        selected_voice = str(voice or self.tts_default_voice).strip() or self.tts_default_voice
        response: httpx.Response | None = None
        error_payload: dict[str, Any] = {}
        selected_model = self.tts_model or "gpt-4o-mini-tts"
        tts_attempts: list[dict[str, Any]] = []
        upstream_http_ms = 0

        async with httpx.AsyncClient(timeout=self.tts_timeout_seconds) as client:
            attempt_started_at = time.perf_counter()
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
            payload = {
                "model": selected_model,
                "input": clean_text,
                "voice": selected_voice,
                "format": self.tts_format,
            }
            candidate_response = await client.post(
                _OPENAI_TTS_URL,
                headers={
                    **self._headers(),
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            attempt_elapsed_ms = int((time.perf_counter() - attempt_started_at) * 1000)
            upstream_http_ms = attempt_elapsed_ms
            if candidate_response.status_code < 400:
                if trace_hook:
                    trace_hook(
                        "tts_upstream_finished",
                        {
                            "model_used": selected_model,
                            "elapsed_ms": attempt_elapsed_ms,
                            "status_code": candidate_response.status_code,
                            "audio_bytes": len(candidate_response.content or b""),
                        },
                    )
                response = candidate_response
                tts_attempts.append(
                    {
                        "model": selected_model,
                        "status_code": candidate_response.status_code,
                        "elapsed_ms": attempt_elapsed_ms,
                        "result": "success",
                    }
                )
            else:
                maybe_payload = candidate_response.json() if candidate_response.content else {}
                extracted_error = _extract_openai_error(maybe_payload)
                tts_attempts.append(
                    {
                        "model": selected_model,
                        "status_code": candidate_response.status_code,
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
                            "status_code": candidate_response.status_code,
                            "exception_type": None,
                            "upstream_error_message": extracted_error,
                            "upstream_error_payload": maybe_payload.get("error")
                            if isinstance(maybe_payload, dict)
                            else maybe_payload,
                        },
                    )
                response = candidate_response
                error_payload = maybe_payload

        if response is None:
            raise VoiceServiceError(502, "TTS request failed")

        if response.status_code >= 400:
            if not error_payload:
                error_payload = response.json() if response.content else {}
            detail = _extract_openai_error(error_payload) or "TTS request failed"
            raise VoiceServiceError(502, detail)

        audio_bytes = response.content or b""
        if not audio_bytes:
            raise VoiceServiceError(502, "TTS response was empty")
        mime_type = "audio/mpeg" if self.tts_format == "mp3" else f"audio/{self.tts_format}"
        logger.info(
            (
                "[VOICE_TTS] status=ok source=backend_openai_audio model=%s voice=%s format=%s "
                "text_chars=%s audio_bytes=%s attempts=%s"
            ),
            selected_model,
            selected_voice,
            self.tts_format,
            len(clean_text),
            len(audio_bytes),
            tts_attempts,
        )
        return (
            audio_bytes,
            mime_type,
            {
                "model": selected_model,
                "voice": selected_voice,
                "format": self.tts_format,
                "source": "backend_openai_audio",
                "attempts": tts_attempts,
                "openai_http_ms": upstream_http_ms,
            },
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
        options = args.get("options")
        if options is not None:
            if not isinstance(options, list) or not all(isinstance(item, str) for item in options):
                return None
        out = {
            "tool_name": "clarify",
            "args": {
                "question": question.strip(),
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
