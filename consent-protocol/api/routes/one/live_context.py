"""Browser-frame trust boundary for the One ADK live relay.

Every field the browser publishes over the live WebSocket crosses this module
before it can influence session state, the system instruction, or tool
authority. Pure functions only: no WebSocket, no session access, and no side
effects beyond bounded INFO logs. The relay lifecycle (endpoints, pumps,
greeting gate) lives in ``adk_live.py``; ticket auth lives in
``relay_auth.py``.

Design rules enforced here:

- The generated route orchestration index is the server-side source of route
  policy; a client may describe its UI but cannot invent policy.
- Action ids survive only when the route index declares them for the current
  route OR the generated manifest classifies them as cross-screen navigation
  (``route.*`` + allow_direct). Unknown or off-contract ids never pass.
- Every string and list is bounded; unknown enum values fall to safe
  defaults; credentials and raw page text never survive.
"""

from __future__ import annotations

import logging
import os
from typing import Any, cast

from hushh_mcp.services.action_gateway import (
    get_action_gateway_action,
    is_navigation_action,
)
from hushh_mcp.services.route_orchestration_index import resolve_route_orchestration_entry

logger = logging.getLogger(__name__)

LIVE_CONTEXT_STRING_CAP = 64
# Mirrors the frontend AVAILABLE_ACTION_IDS_CAP in
# hushh-webapp/lib/voice/screen-context-builder.ts; keep in sync.
LIVE_CONTEXT_ARRAY_CAP = 18
LIVE_MODULE_CAP = 10
LIVE_CAPABILITY_CAP = 10
ONBOARDING_PHASES = frozenset(
    {
        "anonymous_auth",
        "phone_required",
        "setup_hub",
        "capability_setup",
        "external_connector",
        "root_completion",
    }
)
ONBOARDING_CALLBACK_STATES = frozenset({"none", "pending", "succeeded", "cancelled", "failed"})
ONBOARDING_CAPABILITIES = frozenset(
    {"gmail", "location", "email", "finance", "ria", "connected-systems"}
)
ACTION_SETTLEMENT_STATUSES = frozenset(
    {"succeeded", "started", "blocked", "invalid", "failed", "noop"}
)
ROUTE_PLAYBOOK_TEXT_CAP = 480


def bounded_text(value: Any, limit: int = LIVE_CONTEXT_STRING_CAP) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def bounded_text_list(value: Any, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        clean = bounded_text(item)
        if not clean or clean in seen:
            continue
        result.append(clean)
        seen.add(clean)
        if len(result) >= limit:
            break
    return result


def sanitize_route_playbook(route_entry: Any) -> dict[str, Any] | None:
    """Read only checked-in generated guidance; never trust browser prose."""
    if (os.getenv("HUSHH_ROUTE_PLAYBOOKS_DISABLED") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }:
        return None
    if not isinstance(route_entry, dict):
        return None
    value = route_entry.get("voice_playbook")
    if not isinstance(value, dict):
        return None
    proactivity = bounded_text(value.get("proactivity"), 16)
    return {
        "playbook_id": bounded_text(value.get("playbook_id"), 96),
        "purpose": bounded_text(value.get("purpose"), ROUTE_PLAYBOOK_TEXT_CAP),
        "screen": bounded_text(value.get("screen"), 64),
        "entry_cue": bounded_text(value.get("entry_cue"), 240),
        "proactivity": proactivity if proactivity in {"on_entry", "ambient"} else "ambient",
        "primary_action_id": bounded_text(value.get("primary_action_id"), 128) or None,
        "completion_boundary": bounded_text(
            value.get("completion_boundary"), ROUTE_PLAYBOOK_TEXT_CAP
        ),
        "next_route": bounded_text(value.get("next_route"), 128) or None,
        "return_policy": bounded_text(value.get("return_policy"), 32),
        "out_of_scope_behavior": bounded_text(
            value.get("out_of_scope_behavior"), ROUTE_PLAYBOOK_TEXT_CAP
        ),
    }


def compose_route_context_note(
    context: dict[str, Any], *, is_route_entry: bool = True
) -> str | None:
    """Build one bounded model note from server-resolved route intelligence.

    ``is_route_entry`` separates arriving on a screen from the content
    changing on the screen the person is already standing on. Both refresh
    the action inventory; only an arrival may spend the playbook's on-entry
    cue, or One narrates a navigation that never happened.
    """
    playbook = context.get("route_playbook")
    if not isinstance(playbook, dict):
        return None
    if context.get("route_context_policy") == "suppress":
        return None
    purpose = str(playbook.get("purpose") or "Use the verified current screen.")
    cue = str(playbook.get("entry_cue") or "")
    primary = str(playbook.get("primary_action_id") or "")
    active_actions = context.get("available_action_ids")
    action_inventory = ", ".join(active_actions) if isinstance(active_actions, list) else ""
    visible_modules = context.get("visible_modules")
    module_inventory = ", ".join(visible_modules) if isinstance(visible_modules, list) else ""
    interaction_layer = context.get("interaction_layer")
    layer_id = (
        str(interaction_layer.get("layer_id") or "") if isinstance(interaction_layer, dict) else ""
    )
    proactive = playbook.get("proactivity") == "on_entry" and is_route_entry
    dead_end = context.get("dead_end")
    # A screen that cannot proceed on its own. The capability-honesty sentence
    # below already stops One inventing a capability; this is the other half of
    # the same problem -- the person is not asking for something impossible,
    # they are one screen away from what they need, and only the screen knows
    # which screen that is.
    dead_end_note = (
        "The person is currently stuck on this screen: "
        f"{dead_end.get('reason')} "
        "If what they ask for runs into that, do not just say you cannot do it: "
        "explain the situation in one sentence, then offer to run the action id "
        f"'{dead_end.get('remedy_action_id')}', which is where it gets resolved. "
        "Offer it once and wait for an answer; never run it unasked. "
        if isinstance(dead_end, dict)
        else ""
    )
    return (
        "[App route context - not user speech] This note SUPERSEDES any action "
        "inventory from earlier notes or your initial instructions. The verified "
        "current route is "
        f"'{context.get('route_pattern') or context.get('route_family') or '/'}' "
        f"and its purpose is: {purpose} "
        "Generated actions and their guards remain the only execution authority. "
        "For an explicit request matching a visible action, call list_app_actions "
        "and run the exact returned id before any identity or greeting response. "
        f"The currently visible generated action ids are: "
        f"{action_inventory or 'none on this screen (cross-screen navigation actions remain available)'}. "
        # Capability honesty. Without a sanctioned way to say "I cannot do that
        # yet", the model reissued the same directive until the person gave up,
        # or narrated an outcome that nothing had actually performed.
        "If no listed action covers what the person asks for, say plainly that "
        "you cannot do that here yet and name what you can do instead. Do not "
        "reissue a directive that has not settled, and never imply an "
        "unavailable capability succeeded. "
        + dead_end_note
        + f"The content currently visible to the person is: {module_inventory or 'not reported'}. "
        + (
            f"The person is looking at: {context.get('spoken_subject')}. "
            if context.get("spoken_subject")
            else ""
        )
        + f"The current top interaction layer is: {layer_id or 'none'}. "
        + f"The preferred action reference is '{primary or 'none'}'. "
        + (
            f"After route settlement, orient once with this intent: {cue} "
            if proactive and cue
            else "Use this context silently until the person speaks. "
        )
        + "Never claim completion before correlated browser settlement."
    )


def sanitize_live_context(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep only bounded, redacted UI state for tool availability decisions."""
    # Typed Agent Chat sends the shared structured screen context, whose
    # canonical action snapshot is nested under ``one_voice_context``. Live
    # sockets already flatten that snapshot before transport. Normalize both
    # shapes here so chat cannot fall into a compatibility-permissive context
    # merely because it used the shared builder directly.
    snapshot = payload.get("one_voice_context")
    if isinstance(snapshot, dict):
        snapshot_map = cast(dict[str, Any], snapshot)

        def nested_map(key: str) -> dict[str, Any]:
            value = snapshot_map.get(key)
            return cast(dict[str, Any], value) if isinstance(value, dict) else {}

        route = nested_map("route")
        ui = nested_map("ui")
        cache = nested_map("cache")
        persona = nested_map("persona")
        voice = nested_map("voice")
        auth = nested_map("auth")
        revisions = nested_map("revisions")
        payload = {
            **payload,
            "context_id": payload.get("context_id") or snapshot_map.get("snapshot_id"),
            "screen": payload.get("screen") or route.get("screen"),
            "spoken_subject": payload.get("spoken_subject") or ui.get("spoken_subject"),
            "dead_end": payload.get("dead_end") or ui.get("dead_end"),
            "route_family": payload.get("route_family") or route.get("route_family"),
            "route_query": payload.get("route_query") or route.get("route_query"),
            "context_revision": payload.get("context_revision")
            or f"{revisions.get('route', '')}:{revisions.get('ui', '')}",
            "signed_in": payload.get("signed_in") is True or auth.get("signed_in") is True,
            "persona": payload.get("persona") or persona.get("active"),
            "voice_state": payload.get("voice_state") or voice.get("state"),
            "available_action_ids": payload.get("available_action_ids")
            or snapshot_map.get("available_action_ids"),
            "visible_modules": payload.get("visible_modules") or ui.get("visible_modules"),
            "visible_control_ids": payload.get("visible_control_ids")
            or ui.get("visible_control_ids"),
            "interaction_layer": payload.get("interaction_layer") or ui.get("interaction_layer"),
            "pending_settlement": payload.get("pending_settlement") is True
            or snapshot_map.get("pending_settlement") is True,
            "cache_freshness": payload.get("cache_freshness") or cache.get("freshness"),
            "vault_ready": payload.get("vault_ready") is True or cache.get("vault_ready") is True,
            "portfolio_ready": payload.get("portfolio_ready") is True
            or cache.get("portfolio_ready") is True,
            "busy_operations": payload.get("busy_operations") or cache.get("busy_operations"),
            "onboarding": payload.get("onboarding") or snapshot_map.get("onboarding"),
        }
    cache_freshness = bounded_text(payload.get("cache_freshness"), 32)
    route_family = bounded_text(payload.get("route_family"))
    # Structural query only (tab/view/focus/...), allowlisted and bounded by the
    # browser before it is sent. It selects between screens that share a single
    # path, so it must not ride inside route_family: that value is
    # redaction-sensitive and also feeds layout resolution.
    route_query = bounded_text(payload.get("route_query"), 128)
    route_entry = resolve_route_orchestration_entry(route_family, route_query)
    route_action_ids = {
        action_id
        for action_id in (
            route_entry.get("action_ids", []) if isinstance(route_entry, dict) else []
        )
        if isinstance(action_id, str) and get_action_gateway_action(action_id) is not None
    }
    canonical_screen = (
        bounded_text(route_entry.get("canonical_screen"), 64)
        if isinstance(route_entry, dict)
        else ""
    )
    # Acceptance rule: an id survives when the route index declares it for
    # this route OR the generated manifest classifies it as a cross-screen
    # navigation action (route.* + allow_direct). The browser reserves a
    # global-navigation segment so "go to profile" stays proposable from any
    # screen; without the navigation branch this filter silently stripped
    # those ids and navigation requests were refused as action_unavailable.
    # Authority is unchanged: unknown or off-contract ids never pass, and
    # run_app_action re-validates screens/guards before parking a directive.
    submitted_raw = bounded_text_list(payload.get("available_action_ids"), LIVE_CONTEXT_ARRAY_CAP)
    submitted_action_ids = [
        action_id
        for action_id in submitted_raw
        if action_id in route_action_ids
        or is_navigation_action(get_action_gateway_action(action_id))
    ]
    if submitted_raw and not route_action_ids:
        # Route not in the generated index (or declares no actions): only
        # navigation ids survive. Make the fail-closed posture observable so
        # a missing index entry is diagnosable instead of a silent dead mic.
        logger.info(
            "one_adk_live_context_route_without_actions route=%s submitted=%d accepted=%d",
            route_family or "unknown",
            len(submitted_raw),
            len(submitted_action_ids),
        )
    interaction_layer = sanitize_interaction_layer(
        payload.get("interaction_layer"), submitted_action_ids
    )
    if interaction_layer and interaction_layer["modality"] in {"modal", "blocking"}:
        layer_action_ids = set(interaction_layer["visible_action_ids"])
        submitted_action_ids = [
            action_id for action_id in submitted_action_ids if action_id in layer_action_ids
        ]
    return {
        # The generated index is the server-side source of route policy.  A
        # client may describe its current UI, but cannot invent a route
        # instruction or route policy. Action execution remains independently
        # guarded by the generated action gateway and surface metadata.
        "route_family": route_family,
        "route_pattern": route_entry.get("route_pattern")
        if isinstance(route_entry, dict)
        else None,
        "route_instruction_id": route_entry.get("instruction_id")
        if isinstance(route_entry, dict)
        else None,
        "route_context_policy": route_entry.get("context_policy")
        if isinstance(route_entry, dict)
        else "suppress",
        "route_playbook": sanitize_route_playbook(route_entry),
        # A browser may describe a screen for presentation, but execution
        # authority derives it from the generated route index. This prevents a
        # stale render or forged frame from lending another route's actions to
        # the active page.
        "screen": canonical_screen or None,
        # Opt-in and bounded. selected_entity / primary_entity stay redacted:
        # several surfaces fill those with an investor name or email address.
        # A surface sets this only when naming its subject is harmless.
        "spoken_subject": bounded_text(payload.get("spoken_subject"), 64) or None,
        # Where the person is stuck, and the one action that unsticks them.
        # Admitted under the same rule as the action inventory, so a screen can
        # describe its own dead end but cannot mint a destination out of it.
        "dead_end": sanitize_dead_end(payload.get("dead_end"), submitted_action_ids),
        "context_revision": bounded_text(payload.get("context_revision"), 128) or None,
        "signed_in": payload.get("signed_in") is True,
        "persona": bounded_text(payload.get("persona")),
        "voice_state": bounded_text(payload.get("voice_state"), 32),
        "available_action_ids": submitted_action_ids,
        "visible_modules": bounded_text_list(payload.get("visible_modules"), LIVE_MODULE_CAP),
        "visible_control_ids": bounded_text_list(
            payload.get("visible_control_ids"), LIVE_MODULE_CAP
        ),
        "interaction_layer": interaction_layer,
        "pending_settlement": payload.get("pending_settlement") is True,
        "cache_freshness": cache_freshness
        if cache_freshness in {"fresh_or_stale_safe", "locked", "missing"}
        else "missing",
        "vault_ready": payload.get("vault_ready") is True,
        "portfolio_ready": payload.get("portfolio_ready") is True,
        "busy_operations": bounded_text_list(payload.get("busy_operations"), LIVE_MODULE_CAP),
        "onboarding": sanitize_onboarding_context(payload.get("onboarding")),
    }


def sanitize_dead_end(value: Any, submitted_action_ids: list[str]) -> dict[str, Any] | None:
    """Keep a screen's own report that it is stuck, and where to go instead.

    A dead end is not a guard failure and not a missing capability: the screen
    works, it simply has nothing to work on until something is done elsewhere.
    The emergency-contacts screen saying "no connections" is the case -- the
    remedy lives in Connect, and nothing the screen already published could
    point there.

    Two things keep this from becoming an authority hole. The reason is bounded
    text that only ever reaches the model as narration, and the remedy must be
    an id this route was already allowed to run: either declared for the route
    by the generated index or a cross-screen navigation action. A screen that
    names anything else loses the whole dead end rather than half of it, since
    a reason with an unreachable remedy would strand the person mid-sentence.
    """
    if not isinstance(value, dict):
        return None
    reason = bounded_text(value.get("reason"), 160)
    remedy_action_id = bounded_text(value.get("remedy_action_id"), 128)
    if not reason or not remedy_action_id:
        return None
    if remedy_action_id not in submitted_action_ids and not is_navigation_action(
        get_action_gateway_action(remedy_action_id)
    ):
        logger.info(
            "one_adk_live_context_dead_end_remedy_rejected remedy=%s",
            remedy_action_id,
        )
        return None
    return {"reason": reason, "remedy_action_id": remedy_action_id}


def sanitize_interaction_layer(
    value: Any, submitted_action_ids: list[str]
) -> dict[str, Any] | None:
    """Keep one bounded authored layer; never let it mint app authority."""
    if not isinstance(value, dict):
        return None
    layer_id = bounded_text(value.get("layer_id"), 128)
    kind = bounded_text(value.get("kind"), 64)
    modality = bounded_text(value.get("modality"), 16)
    lifecycle = bounded_text(value.get("lifecycle_state"), 16)
    continuity = bounded_text(value.get("agent_continuity"), 16)
    if (
        not layer_id
        or not kind
        or modality not in {"nonmodal", "modal", "blocking"}
        or lifecycle not in {"opening", "open", "closing"}
        or continuity not in {"interactive", "ambient", "suppressed"}
    ):
        return None
    submitted = set(submitted_action_ids)
    visible_action_ids = [
        action_id
        for action_id in bounded_text_list(value.get("visible_action_ids"), LIVE_CONTEXT_ARRAY_CAP)
        if action_id in submitted and get_action_gateway_action(action_id) is not None
    ]
    dismissible = value.get("dismissible") is True
    dismiss_action_id: str | None = bounded_text(value.get("dismiss_action_id"), 128) or None
    if (
        not dismissible
        or not dismiss_action_id
        or dismiss_action_id not in visible_action_ids
        or get_action_gateway_action(dismiss_action_id) is None
    ):
        dismiss_action_id = None
    options: list[dict[str, Any]] = []
    raw_options = value.get("options")
    if isinstance(raw_options, list):
        for option in raw_options[:10]:
            if not isinstance(option, dict):
                continue
            option_id = bounded_text(option.get("id"), 64)
            label = bounded_text(option.get("label"), 96)
            action_id: str | None = bounded_text(option.get("action_id"), 128) or None
            if not option_id or not label:
                continue
            if action_id and action_id not in visible_action_ids:
                action_id = None
            options.append(
                {
                    "id": option_id,
                    "label": label,
                    "action_id": action_id,
                    "description": bounded_text(option.get("description"), 160) or None,
                }
            )
    return {
        "layer_id": layer_id,
        "kind": kind,
        "modality": modality,
        "lifecycle_state": lifecycle,
        "dismissible": dismissible and dismiss_action_id is not None,
        "dismiss_action_id": dismiss_action_id,
        "visible_action_ids": visible_action_ids,
        "visible_control_ids": bounded_text_list(value.get("visible_control_ids"), LIVE_MODULE_CAP),
        "options": options,
        "underlying_actions_available": (
            value.get("underlying_actions_available") is True and modality == "nonmodal"
        ),
        "agent_continuity": continuity,
    }


def sanitize_onboarding_context(value: Any) -> dict[str, Any]:
    """Bound anonymous/new-user guidance to non-sensitive journey metadata."""
    payload = value if isinstance(value, dict) else {}
    phase = bounded_text(payload.get("phase"), 32)
    callback_state = bounded_text(payload.get("callback_state"), 16)
    active_capability = bounded_text(payload.get("active_capability"), 32)
    return {
        "phase": phase if phase in ONBOARDING_PHASES else "anonymous_auth",
        "active_capability": active_capability
        if active_capability in ONBOARDING_CAPABILITIES
        else None,
        "root_resolved": payload.get("root_resolved") is True,
        "return_route": "/one/setup",
        "callback_state": callback_state
        if callback_state in ONBOARDING_CALLBACK_STATES
        else "none",
        "phone_verified": payload.get("phone_verified")
        if isinstance(payload.get("phone_verified"), bool)
        else None,
        "setup_capability_ids": [
            capability
            for capability in bounded_text_list(
                payload.get("setup_capability_ids"), LIVE_CAPABILITY_CAP
            )
            if capability in ONBOARDING_CAPABILITIES
        ],
    }


def sanitize_action_settlement(
    payload: Any, issued_directives: dict[str, str]
) -> dict[str, str] | None:
    """Validate a browser report against an action directive from this socket."""
    if not isinstance(payload, dict):
        return None
    directive_id = bounded_text(payload.get("directiveId"), 128)
    action_id = bounded_text(payload.get("actionId"), 128)
    if not directive_id or issued_directives.get(directive_id) != action_id:
        return None
    status_value = bounded_text(payload.get("status"), 16)
    if status_value not in ACTION_SETTLEMENT_STATUSES:
        return None
    context_revision = bounded_text(payload.get("contextRevision"), 256)
    if not context_revision:
        return None
    issued_directives.pop(directive_id, None)
    return {
        "directive_id": directive_id,
        "action_id": action_id,
        "context_revision": context_revision,
        "status": status_value,
        "summary": bounded_text(payload.get("summary"), 320) or "The app returned no detail.",
        "reason": bounded_text(payload.get("reason"), 96),
        "route_after": bounded_text(payload.get("routeAfter"), 128),
        "screen_after": bounded_text(payload.get("screenAfter"), 64),
        "destination_context_id": bounded_text(payload.get("destinationContextId"), 128),
    }
