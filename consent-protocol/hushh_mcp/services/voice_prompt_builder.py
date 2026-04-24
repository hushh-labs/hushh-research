from __future__ import annotations

import json
from typing import Any

from hushh_mcp.services.voice_action_manifest import (
    load_voice_action_manifest,
    select_voice_manifest_actions_for_prompt,
)
from hushh_mcp.services.voice_app_knowledge import (
    get_kai_voice_identity_context,
    list_voice_global_concept_summaries,
)

_VOICE_PLANNER_LANGUAGE_POLICY = "\n".join(
    [
        "- Input language policy: Kai voice accepts English-language transcripts only.",
        "- If the transcript is clearly non-English or asks for a non-English reply, choose clarify.",
        "- Any clarification question, tool argument text, and option text must be English only.",
        "- Never mirror the user's non-English language and never translate Kai's response into another language.",
    ]
)
_VOICE_COMPOSER_LANGUAGE_POLICY = "\n".join(
    [
        "- Output language policy: the spoken reply must be English only.",
        "- If the transcript or requested response language is not English, say Kai voice currently supports English only.",
        "- Never mirror a non-English user language, translate into another language, or include non-English filler.",
    ]
)


def _build_voice_shared_context(
    *,
    transcript: str,
    runtime_state: dict[str, Any],
    context_payload: dict[str, Any],
) -> dict[str, Any]:
    structured = (
        context_payload.get("structured_screen_context")
        if isinstance(context_payload.get("structured_screen_context"), dict)
        else {}
    )
    route = structured.get("route") if isinstance(structured.get("route"), dict) else {}
    surface = structured.get("surface") if isinstance(structured.get("surface"), dict) else {}
    current_screen = str(
        route.get("screen") or surface.get("screen_id") or surface.get("screenId") or ""
    ).strip()

    available_action_ids: list[str] = []
    for source_key in ("controls", "actions"):
        raw_items = surface.get(source_key)
        if not isinstance(raw_items, list):
            continue
        for raw_item in raw_items:
            if not isinstance(raw_item, dict):
                continue
            action_id = raw_item.get("action_id") or raw_item.get("actionId")
            normalized = str(action_id or "").strip()
            if normalized:
                available_action_ids.append(normalized)

    capabilities = select_voice_manifest_actions_for_prompt(
        screen=current_screen,
        available_action_ids=available_action_ids,
        transcript=transcript,
        limit=8,
    )

    return {
        "identity": get_kai_voice_identity_context(),
        "capability_manifest": {
            "schema_version": load_voice_action_manifest().get("schema_version"),
            "relevant_actions": capabilities,
        },
        "dynamic_context": {
            "current_screen": current_screen or None,
            "pathname": str(route.get("pathname") or "").strip() or None,
            "available_action_ids": available_action_ids,
            "runtime_state": runtime_state,
        },
        "knowledge_context": {
            "global_concepts": list_voice_global_concept_summaries(limit=6),
        },
    }


def build_voice_planner_context(
    *,
    transcript: str,
    runtime_state: dict[str, Any],
    context_payload: dict[str, Any],
) -> dict[str, Any]:
    return _build_voice_shared_context(
        transcript=transcript,
        runtime_state=runtime_state,
        context_payload=context_payload,
    )


def build_voice_planner_system_prompt(*, planner_context: dict[str, Any]) -> str:
    identity = planner_context.get("identity") if isinstance(planner_context, dict) else {}
    capability_manifest = (
        planner_context.get("capability_manifest") if isinstance(planner_context, dict) else {}
    )
    dynamic_context = (
        planner_context.get("dynamic_context") if isinstance(planner_context, dict) else {}
    )
    knowledge_context = (
        planner_context.get("knowledge_context") if isinstance(planner_context, dict) else {}
    )

    role_summary = str(identity.get("role_summary") or "").strip()
    core_capabilities = [
        f"- {capability}"
        for capability in (identity.get("core_capabilities") or [])
        if str(capability or "").strip()
    ]
    guardrails = [
        f"- {rule}" for rule in (identity.get("guardrails") or []) if str(rule or "").strip()
    ]
    operating_rules = [
        "You are the planner for the voice assistant inside the Kai app.",
        role_summary or "Kai is the investor app. The assistant is Kai's in-app voice interface.",
        "Your job is to choose exactly one tool call from the provided tools and never return plain text.",
        "Do not speak conversational filler. Spoken phrasing is handled separately.",
        "Treat the capability manifest as the semantic source of truth for what the Kai app can do.",
        "Prefer actions that match the current screen, visible controls, and approved in-app capabilities.",
        "Never invent screens, tools, permissions, or powers that are not grounded in the provided context.",
        "Speech-to-text may contain misspellings or homophones, especially for navigation destinations and tickers.",
    ]

    action_summaries = []
    for action in capability_manifest.get("relevant_actions") or []:
        if not isinstance(action, dict):
            continue
        label = str(action.get("label") or "").strip()
        action_id = str(action.get("action_id") or "").strip()
        meaning = str(action.get("meaning") or "").strip()
        execution_policy = str(
            ((action.get("risk") or {}) if isinstance(action.get("risk"), dict) else {}).get(
                "execution_policy"
            )
            or "allow_direct"
        ).strip()
        completion_mode = str(action.get("completion_mode") or "none").strip()
        if not label or not action_id or not meaning:
            continue
        action_summaries.append(
            f"- {action_id}: {label}. {meaning} "
            f"(policy={execution_policy}, completion={completion_mode})"
        )

    concept_summaries = [
        f"- {entry}"
        for entry in (knowledge_context.get("global_concepts") or [])
        if str(entry or "").strip()
    ]

    prompt_sections = [
        "Role",
        "\n".join(operating_rules),
        "Core Capabilities",
        "\n".join(core_capabilities)
        if core_capabilities
        else "- Explain Kai screens, navigate inside Kai, and start approved investor actions.",
        "Guardrails",
        "\n".join(guardrails)
        if guardrails
        else "- Never invent screens, powers, or permissions that are not grounded in context.",
        "Language Policy",
        _VOICE_PLANNER_LANGUAGE_POLICY,
        "Current App Context",
        json.dumps(dynamic_context, ensure_ascii=True),
        "Relevant Manifest Actions",
        "\n".join(action_summaries)
        if action_summaries
        else "- No manifest actions were available in context; rely on provided tools and runtime state.",
        "Global Concepts",
        "\n".join(concept_summaries)
        if concept_summaries
        else "- No additional global concept summaries were available.",
        "Planning Rules",
        "\n".join(
            [
                "- For pure navigation requests, choose the matching navigation tool call.",
                "- For 'analyze <company_or_symbol>', use execute_kai_command(command='analyze', params.symbol='<SYMBOL>').",
                "- If the likely ticker is uncertain, return clarify.",
                "- If a relevant manifest action is manual_only or confirm_required, do not act like it already completed.",
                "- If the user asks about current screen concepts or PKM/Gmail/receipt features and tool execution is not needed, return clarify only when the transcript is unsafe to map; otherwise defer to deterministic explain flows when available.",
            ]
        ),
    ]
    return "\n\n".join(prompt_sections).strip()


def build_voice_response_composer_context(
    *,
    transcript: str,
    runtime_state: dict[str, Any],
    context_payload: dict[str, Any],
    plan_payload: dict[str, Any],
    response_payload: dict[str, Any],
    action_result: dict[str, Any] | None,
) -> dict[str, Any]:
    shared = _build_voice_shared_context(
        transcript=transcript,
        runtime_state=runtime_state,
        context_payload=context_payload,
    )

    return {
        **shared,
        "turn_context": {
            "transcript": str(transcript or "").strip(),
            "plan": {
                "mode": plan_payload.get("mode"),
                "action_id": plan_payload.get("action_id"),
                "slots": dict(plan_payload.get("slots") or {}),
                "guards": list(plan_payload.get("guards") or []),
                "reply_strategy": plan_payload.get("reply_strategy"),
                "action_completion": plan_payload.get("action_completion"),
                "clarification": plan_payload.get("clarification"),
            },
            "response": {
                "kind": response_payload.get("kind"),
                "message": response_payload.get("message"),
                "reason": response_payload.get("reason"),
                "task": response_payload.get("task"),
                "ticker": response_payload.get("ticker"),
                "execution_allowed": response_payload.get("execution_allowed"),
            },
            "action_result": dict(action_result or {}) if isinstance(action_result, dict) else None,
        },
    }


def build_voice_response_composer_system_prompt(*, composer_context: dict[str, Any]) -> str:
    identity = composer_context.get("identity") if isinstance(composer_context, dict) else {}
    capability_manifest = (
        composer_context.get("capability_manifest") if isinstance(composer_context, dict) else {}
    )
    dynamic_context = (
        composer_context.get("dynamic_context") if isinstance(composer_context, dict) else {}
    )
    knowledge_context = (
        composer_context.get("knowledge_context") if isinstance(composer_context, dict) else {}
    )
    turn_context = (
        composer_context.get("turn_context") if isinstance(composer_context, dict) else {}
    )

    role_summary = str(identity.get("role_summary") or "").strip()
    core_capabilities = [
        f"- {capability}"
        for capability in (identity.get("core_capabilities") or [])
        if str(capability or "").strip()
    ]
    guardrails = [
        f"- {rule}" for rule in (identity.get("guardrails") or []) if str(rule or "").strip()
    ]
    operating_rules = [
        "You are the voice assistant inside the Kai app.",
        role_summary or "Kai is the investor app. The assistant is Kai's in-app voice interface.",
        "Write the exact spoken reply the user should hear now.",
        "The execution result is authoritative for whether Kai acted, started work, was blocked, or failed.",
        "Never sound powerless if the execution result shows Kai already acted or started the job.",
        "Never claim a screen, permission, tool, or data source that is not present in the provided context.",
        "If navigation succeeded and the current screen context is available, mention where the user is now and what they can do there.",
        "If a long-running job started, acknowledge the confirmed start and do not pretend it already finished.",
        "If the action was blocked or failed, explain the real block succinctly and stay grounded in the actual result.",
        "Keep the reply concise and natural for spoken TTS output.",
        'Return JSON only with the shape {"text":"...","segment_type":"final|ack"}.',
    ]

    action_summaries = []
    for action in capability_manifest.get("relevant_actions") or []:
        if not isinstance(action, dict):
            continue
        label = str(action.get("label") or "").strip()
        action_id = str(action.get("action_id") or "").strip()
        meaning = str(action.get("meaning") or "").strip()
        if not label or not action_id or not meaning:
            continue
        action_summaries.append(f"- {action_id}: {label}. {meaning}")

    concept_summaries = [
        f"- {entry}"
        for entry in (knowledge_context.get("global_concepts") or [])
        if str(entry or "").strip()
    ]

    prompt_sections = [
        "Role",
        "\n".join(operating_rules),
        "Core Capabilities",
        "\n".join(core_capabilities)
        if core_capabilities
        else "- Explain Kai screens, navigate inside Kai, and start approved investor actions.",
        "Guardrails",
        "\n".join(guardrails)
        if guardrails
        else "- Never invent screens, powers, permissions, or connected data.",
        "Language Policy",
        _VOICE_COMPOSER_LANGUAGE_POLICY,
        "Current App Context",
        json.dumps(dynamic_context, ensure_ascii=True),
        "Relevant Manifest Actions",
        "\n".join(action_summaries)
        if action_summaries
        else "- No manifest actions were selected for this turn.",
        "Global Concepts",
        "\n".join(concept_summaries)
        if concept_summaries
        else "- No additional global concept summaries were available.",
        "Turn Facts",
        json.dumps(turn_context, ensure_ascii=True),
    ]
    return "\n\n".join(prompt_sections).strip()
