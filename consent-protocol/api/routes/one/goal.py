"""One Goal API contracts.

These routes expose the product-level goal planning/composition contract. They
intentionally do not execute generated actions; execution stays with the One
Goal runner and generated gateway where app state, vault readiness, and route
settlement are evaluated.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.voice_action_manifest import (
    get_voice_manifest_action,
    list_voice_manifest_actions,
)
from hushh_mcp.services.voice_intent_service import (
    _extract_analyze_target as extract_analyze_target,
)
from hushh_mcp.services.voice_intent_service import (
    _resolve_ticker_target as resolve_ticker_target,
)

router = APIRouter(prefix="/api/one/goal", tags=["One Goal"])

GoalEntrypoint = Literal["voice", "chat", "typed_search", "command_bar", "ui"]
GoalPlanStatus = Literal["ready", "input_needed", "blocked"]
GoalEventState = Literal[
    "input_needed",
    "preview",
    "started",
    "progress",
    "waiting",
    "cancel_available",
    "completed",
    "failed",
    "blocked",
]


class OneGoalPlannerRequest(BaseModel):
    transcript: str | None = Field(default=None, max_length=4096)
    action_id: str | None = Field(default=None, max_length=128)
    candidate_action_id: str | None = Field(default=None, max_length=128)
    slots: dict[str, Any] = Field(default_factory=dict)
    app_state: dict[str, Any] = Field(default_factory=dict)
    entrypoint: GoalEntrypoint = "chat"


class OneGoalInputPromptResponse(BaseModel):
    input_name: str = Field(max_length=128)
    slot: str = Field(max_length=128)
    prompt: str = Field(max_length=512)
    options: list[str] = Field(default_factory=list, max_length=32)


class OneGoalPlanResponse(BaseModel):
    status: GoalPlanStatus
    goal_id: str | None = Field(default=None, max_length=128)
    action_id: str | None = Field(default=None, max_length=128)
    slots: dict[str, Any] = Field(default_factory=dict)
    prompt: OneGoalInputPromptResponse | None = None
    reason: str | None = Field(default=None, max_length=512)
    execution_authority: Literal["generated_gateway"] = "generated_gateway"
    planner_authority: Literal["frontend_contract_runner"] = "frontend_contract_runner"


class OneGoalComposeRequest(BaseModel):
    goal_id: str = Field(max_length=128)
    action_id: str = Field(max_length=128)
    state: GoalEventState
    events: list[dict[str, Any]] = Field(default_factory=list, max_length=80)
    result: dict[str, Any] | None = None


class OneGoalComposeResponse(BaseModel):
    speech: str = Field(max_length=1024)
    card_title: str = Field(max_length=128)
    state: GoalEventState


_TICKER_RE = re.compile(r"\b([A-Z]{1,5})(?:\b|$)")
_TOKEN_RE = re.compile(r"[a-z0-9._-]+", re.IGNORECASE)
_STOP_WORDS = {
    "A",
    "AN",
    "AND",
    "ASK",
    "CAN",
    "DO",
    "FOR",
    "I",
    "IN",
    "IT",
    "KAI",
    "ME",
    "MY",
    "OF",
    "ON",
    "ONE",
    "OR",
    "PLEASE",
    "START",
    "THE",
    "TO",
    "USE",
    "USING",
    "DEFAULT",
    "WITH",
    "YOU",
}
_GOAL_ANALYZE_TARGET_RE = re.compile(
    r"\b(?:analyze|analyse|research|evaluate|analyzing)\s+"
    r"(?P<target>[A-Za-z0-9 .&()/-]{1,90})",
    re.IGNORECASE,
)


def _tokens(value: str) -> list[str]:
    return [match.group(0).lower() for match in _TOKEN_RE.finditer(value or "")]


def _goal(action: dict[str, Any]) -> dict[str, Any]:
    return action.get("goal") if isinstance(action.get("goal"), dict) else {}


def _required_inputs(action: dict[str, Any]) -> list[dict[str, Any]]:
    raw = _goal(action).get("required_inputs")
    return [entry for entry in raw if isinstance(entry, dict)] if isinstance(raw, list) else []


def _action_dictionary(action: dict[str, Any]) -> str:
    parts: list[str] = [
        str(action.get("action_id") or ""),
        str(action.get("label") or ""),
        str(action.get("meaning") or ""),
        *[str(item) for item in action.get("aliases") or []],
        *[str(item) for item in action.get("search_keywords") or []],
    ]
    goal = _goal(action)
    parts.extend(str(item) for item in goal.get("input_resolvers") or [])
    for required in _required_inputs(action):
        parts.append(str(required.get("name") or ""))
        parts.append(str(required.get("slot") or ""))
    return " ".join(parts).lower()


def _extract_ticker(transcript: str, action: dict[str, Any]) -> str | None:
    dictionary_tokens = {token.upper() for token in _tokens(_action_dictionary(action))}
    for match in _TICKER_RE.finditer((transcript or "").upper()):
        candidate = match.group(1)
        if candidate in _STOP_WORDS or candidate in dictionary_tokens:
            continue
        return candidate
    return None


def _extract_goal_stock_target(transcript: str) -> str:
    target = extract_analyze_target(transcript)
    if not target:
        match = _GOAL_ANALYZE_TARGET_RE.search(transcript or "")
        target = match.group("target") if match else transcript
    target = re.split(
        r"\b(?:using|with|for me|please|right now|now|today|thanks|thank you)\b",
        target or "",
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    target = re.sub(
        r"\b(?:stock|stocks|ticker|symbol|company|share|shares|analysis|debate|report|deep dive)\b",
        " ",
        target,
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", target).strip(" .,!?:;")


def _resolve_stock_target(transcript: str, action: dict[str, Any]) -> str | None:
    target = _extract_goal_stock_target(transcript)
    direct_ticker = _extract_ticker(target, action)
    if direct_ticker:
        return direct_ticker

    resolution = resolve_ticker_target(target)
    if resolution.get("kind") == "exact" and resolution.get("ticker"):
        return str(resolution["ticker"]).upper()
    return None


def _score_action(action: dict[str, Any], transcript: str) -> int:
    normalized = (transcript or "").strip().lower()
    if not normalized:
        return 0
    score = 0
    phrases = [
        str(action.get("label") or ""),
        str(action.get("meaning") or ""),
        *[str(item) for item in action.get("aliases") or []],
        *[str(item) for item in action.get("search_keywords") or []],
    ]
    for phrase in [item.strip().lower() for item in phrases if item.strip()]:
        if phrase == normalized:
            score += 12
        elif len(phrase) >= 4 and phrase in normalized:
            score += 6
    action_tokens = set(_tokens(_action_dictionary(action)))
    for token in _tokens(normalized):
        if token in action_tokens:
            score += 2
    goal = _goal(action)
    if "ticker_symbol" in set(goal.get("input_resolvers") or []) and _resolve_stock_target(
        transcript, action
    ):
        score += 8
    return score


def _rank_actions(transcript: str) -> list[tuple[int, dict[str, Any]]]:
    return sorted(
        [
            (score, action)
            for action in list_voice_manifest_actions()
            if (score := _score_action(action, transcript or "")) > 0
        ],
        key=lambda item: (-item[0], str(item[1].get("action_id") or "")),
    )


def _should_override_candidate(
    *,
    candidate: dict[str, Any],
    top: tuple[int, dict[str, Any]] | None,
    candidate_score: int,
    transcript: str,
) -> bool:
    if not top:
        return False
    top_score, top_action = top
    if top_action.get("action_id") == candidate.get("action_id"):
        return False
    candidate_goal = _goal(candidate)
    top_goal = _goal(top_action)
    candidate_is_route_only = (
        str(candidate.get("action_id") or "").startswith("route.")
        and len(candidate_goal.get("required_inputs") or []) == 0
    )
    top_resolves_ticker = "ticker_symbol" in set(top_goal.get("input_resolvers") or []) and bool(
        _resolve_stock_target(transcript, top_action)
    )
    if candidate_is_route_only and top_resolves_ticker and top_score >= candidate_score + 2:
        return True
    top_collects_more_inputs = len(top_goal.get("required_inputs") or []) > len(
        candidate_goal.get("required_inputs") or []
    )
    return top_collects_more_inputs and top_score >= candidate_score + 6


def _resolve_action(body: OneGoalPlannerRequest) -> dict[str, Any] | None:
    if body.action_id:
        return get_voice_manifest_action(body.action_id)
    ranked = _rank_actions(body.transcript or "")
    if body.candidate_action_id:
        candidate = get_voice_manifest_action(body.candidate_action_id)
        if candidate:
            candidate_score = _score_action(candidate, body.transcript or "")
            if _should_override_candidate(
                candidate=candidate,
                top=ranked[0] if ranked else None,
                candidate_score=candidate_score,
                transcript=body.transcript or "",
            ):
                return ranked[0][1]
            return candidate
    return ranked[0][1] if ranked else None


def _resolve_ticker_symbol(
    *,
    transcript: str,
    action: dict[str, Any],
    slots: dict[str, Any],
    slot: str,
) -> None:
    existing = slots.get(slot) or slots.get("symbol") or slots.get("ticker")
    if isinstance(existing, str) and existing.strip():
        symbol = existing.strip().upper()
    else:
        symbol = _resolve_stock_target(transcript, action)
    if symbol:
        slots[slot] = symbol
        slots["symbol"] = symbol


def _resolve_kai_pick_source(
    *,
    transcript: str,
    slots: dict[str, Any],
    slot: str,
) -> None:
    if slots.get(slot):
        return
    if re.search(r"\b(default|default list|kai default)\b", transcript or "", re.IGNORECASE):
        slots[slot] = "default"
        slots["pickSource"] = "default"
        slots["pickSourceLabel"] = "Default list"


def _resolve_slots(
    *,
    action: dict[str, Any],
    body: OneGoalPlannerRequest,
) -> dict[str, Any]:
    slots = dict(body.slots)
    transcript = body.transcript or ""
    for required in _required_inputs(action):
        slot = str(required.get("slot") or required.get("name") or "").strip()
        if not slot:
            continue
        resolver = str(required.get("resolver") or "").strip()
        if resolver == "ticker_symbol":
            _resolve_ticker_symbol(transcript=transcript, action=action, slots=slots, slot=slot)
        elif resolver == "kai_pick_source":
            _resolve_kai_pick_source(transcript=transcript, slots=slots, slot=slot)
    return slots


def _is_input_satisfied(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    return value is not None


def _plan_from_manifest(body: OneGoalPlannerRequest) -> OneGoalPlanResponse:
    action = _resolve_action(body)
    if not action:
        return OneGoalPlanResponse(
            status="blocked",
            slots=body.slots,
            reason=(
                "One could not map that request to a generated goal contract. "
                "Gemini Live, Agent Chat, or ADK/A2A agents should propose a "
                "generated action_id when natural-language mapping is ambiguous."
            ),
        )

    slots = _resolve_slots(action=action, body=body)
    goal = _goal(action)
    goal_id = str(goal.get("goal_id") or f"goal.{action.get('action_id')}")
    action_id = str(action.get("action_id") or "")
    for required in _required_inputs(action):
        if required.get("required") is False:
            continue
        slot = str(required.get("slot") or required.get("name") or "").strip()
        if slot and _is_input_satisfied(slots.get(slot)):
            continue
        return OneGoalPlanResponse(
            status="input_needed",
            goal_id=goal_id,
            action_id=action_id,
            slots=slots,
            prompt=OneGoalInputPromptResponse(
                input_name=str(required.get("name") or slot or "input"),
                slot=slot or str(required.get("name") or "input"),
                prompt=str(required.get("prompt") or "What should One use for this step?"),
                options=[
                    str(item) for item in required.get("options") or [] if str(item or "").strip()
                ],
            ),
        )
    return OneGoalPlanResponse(
        status="ready",
        goal_id=goal_id,
        action_id=action_id,
        slots=slots,
    )


@router.post("/plan", response_model=OneGoalPlanResponse)
async def one_goal_plan(
    body: OneGoalPlannerRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> OneGoalPlanResponse:
    _ = token_data
    return _plan_from_manifest(body)


@router.post("/compose", response_model=OneGoalComposeResponse)
async def one_goal_compose(
    body: OneGoalComposeRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> OneGoalComposeResponse:
    _ = token_data
    if body.result and isinstance(body.result.get("text"), str):
        speech = str(body.result["text"]).strip()[:1024]
    else:
        speech = {
            "input_needed": "I need one more detail before I can run that.",
            "started": "I started that goal.",
            "progress": "I am still working on that goal.",
            "waiting": "That goal is running. I will summarize the result when it is ready.",
            "cancel_available": "That goal can be canceled from the active workspace.",
            "completed": "That goal is complete.",
            "failed": "That goal failed.",
            "blocked": "That goal is blocked.",
            "preview": "Review this before I continue.",
        }.get(body.state, "Goal update.")
    return OneGoalComposeResponse(
        speech=speech or "Goal update.",
        card_title="One Goal",
        state=body.state,
    )
