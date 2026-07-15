from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_MANIFEST_PATH = (
    Path(__file__).resolve().parents[3] / "contracts" / "kai" / "kai-action-gateway.vnext.json"
)


def _normalize_action_entry(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    action_id = str(raw.get("action_id") or raw.get("id") or "").strip()
    label = str(raw.get("label") or "").strip()
    meaning = str(raw.get("meaning") or "").strip()
    if not action_id or not label or not meaning:
        return None

    aliases_raw = raw.get("aliases")
    aliases = [str(item).strip() for item in aliases_raw or [] if str(item or "").strip()]
    search_keywords_raw = raw.get("search_keywords")
    search_keywords = [
        str(item).strip() for item in search_keywords_raw or [] if str(item or "").strip()
    ]
    speaker_persona = str(raw.get("speaker_persona") or "one").strip().lower()
    if speaker_persona not in {"one", "kai", "nav", "kyc"}:
        speaker_persona = "one"
    delegate_agent_id = str(raw.get("delegate_agent_id") or "").strip().lower() or None
    if delegate_agent_id not in {
        None,
        "one",
        "kai",
        "nav",
        "agent_kyc",
        "agent_nav",
        "agent_connected_systems",
        "agent_connections",
        "agent_email",
        "agent_gmail",
        "agent_location",
        "agent_personal_information",
    }:
        delegate_agent_id = None
    scope = (
        raw.get("reachability")
        if isinstance(raw.get("reachability"), dict)
        else raw.get("scope")
        if isinstance(raw.get("scope"), dict)
        else {}
    )
    guards_raw = raw.get("guards")
    if isinstance(guards_raw, list):
        guards = [guard for guard in guards_raw if isinstance(guard, dict)]
    else:
        guard_ids = raw.get("guard_ids") if isinstance(raw.get("guard_ids"), list) else []
        guards = [
            {
                "id": str(guard_id).strip(),
            }
            for guard_id in guard_ids
            if str(guard_id or "").strip()
        ]
    risk = raw.get("risk") if isinstance(raw.get("risk"), dict) else {}
    execution_policy = str(
        risk.get("execution_policy") or raw.get("execution_policy") or "allow_direct"
    ).strip()
    activation_policy = str(raw.get("activation_policy") or "none").strip()
    if activation_policy not in {"none", "trusted_activation_required"}:
        activation_policy = "none"
    expected_effects = (
        raw.get("expected_effects") if isinstance(raw.get("expected_effects"), dict) else {}
    )
    execution_target_raw = (
        raw.get("execution_target") if isinstance(raw.get("execution_target"), dict) else {}
    )
    execution_target_status = str(execution_target_raw.get("status") or "unwired").strip()
    if execution_target_status not in {"wired", "unwired", "dead"}:
        execution_target_status = "unwired"
    execution_target: dict[str, Any] = {"status": execution_target_status}
    if execution_target_status == "wired":
        execution_target.update(
            {
                "path": str(execution_target_raw.get("path") or "").strip(),
                "target": str(execution_target_raw.get("target") or "").strip(),
            }
        )
        if isinstance(execution_target_raw.get("params"), dict):
            execution_target["params"] = execution_target_raw["params"]
    else:
        execution_target["reason"] = str(
            execution_target_raw.get("reason")
            or "This action is not available in the current runtime."
        ).strip()
    background_behavior = (
        raw.get("background_behavior") if isinstance(raw.get("background_behavior"), dict) else {}
    )
    completion_mode = str(
        raw.get("completion_mode")
        or raw.get("completion")
        or background_behavior.get("completion")
        or "none"
    ).strip()

    return {
        "action_id": action_id,
        "label": label,
        "meaning": meaning,
        "speaker_persona": speaker_persona,
        "delegate_agent_id": delegate_agent_id,
        "aliases": aliases,
        "search_keywords": search_keywords,
        "scope": {
            "screens": [
                str(screen).strip()
                for screen in (scope.get("screens") or [])
                if str(screen or "").strip()
            ],
            "routes": [
                str(route).strip()
                for route in (scope.get("routes") or [])
                if str(route or "").strip()
            ],
            "hidden_navigable": scope.get("hidden_navigable") is True,
        },
        "guards": guards,
        "risk": {
            "execution_policy": execution_policy or "allow_direct",
        },
        "execution_target": execution_target,
        "activation_policy": activation_policy,
        "completion_mode": completion_mode or "none",
        "expected_effects": expected_effects,
        "background_behavior": background_behavior,
        "external_callback": (
            raw.get("external_callback") if isinstance(raw.get("external_callback"), dict) else None
        ),
        "goal": raw.get("goal") if isinstance(raw.get("goal"), dict) else {},
    }


@lru_cache(maxsize=1)
def load_voice_action_manifest() -> dict[str, Any]:
    if not _MANIFEST_PATH.exists():
        return {
            "schema_version": "kai.action_gateway.vnext",
            "actions": [],
            "source": "missing",
            "path": str(_MANIFEST_PATH),
        }

    raw_payload = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
    if isinstance(raw_payload, list):
        raw_actions = raw_payload
        schema_version = "kai_voice_action_manifest.v1"
    elif isinstance(raw_payload, dict):
        raw_actions = (
            raw_payload.get("actions") if isinstance(raw_payload.get("actions"), list) else []
        )
        schema_version = str(raw_payload.get("schema_version") or "kai.action_gateway.vnext")
    else:
        raw_actions = []
        schema_version = "kai.action_gateway.vnext"

    actions = [
        normalized
        for normalized in (_normalize_action_entry(item) for item in raw_actions)
        if normalized is not None
    ]
    return {
        "schema_version": schema_version,
        "actions": actions,
        "source": "file",
        "path": str(_MANIFEST_PATH),
    }


def list_voice_manifest_actions() -> list[dict[str, Any]]:
    payload = load_voice_action_manifest()
    return list(payload.get("actions") or [])


@lru_cache(maxsize=1)
def _voice_manifest_action_index() -> dict[str, dict[str, Any]]:
    """O(1) id lookup index; built once per process alongside the manifest.

    Keeps the realtime relay/persona hot path free of repeated linear scans
    when enriching each available action id with labels and guard hints.
    """
    return {
        str(action.get("action_id") or ""): action
        for action in list_voice_manifest_actions()
        if str(action.get("action_id") or "")
    }


def get_voice_manifest_action(action_id: str | None) -> dict[str, Any] | None:
    normalized_action_id = str(action_id or "").strip()
    if not normalized_action_id:
        return None
    return _voice_manifest_action_index().get(normalized_action_id)


def is_navigation_action(entry: dict[str, Any] | None) -> bool:
    """True for generated cross-screen navigation actions (``route.*``).

    Navigation actions declare their DESTINATION screens in ``scope.screens``
    (where the route lands), not the screens they can be invoked from. A
    person can ask to "go to profile" from any screen, so these low-risk
    direct-execution actions are screen-agnostic for invocation purposes.

    This is the server-side authority for the frontend's reserved
    global-navigation segment (``GLOBAL_NAV_ACTION_IDS`` in
    ``hushh-webapp/lib/voice/screen-context-builder.ts``): the browser may
    publish a navigation id from anywhere, but only ids that resolve to a
    generated manifest entry with allow_direct execution ever pass. The
    browser can never mint authority this way.
    """
    if not entry:
        return False
    action_id = str(entry.get("action_id") or "")
    if not action_id.startswith("route."):
        return False
    execution_target = entry.get("execution_target") or {}
    if execution_target.get("status") != "wired":
        return False
    execution_policy = str(
        (entry.get("risk") or {}).get("execution_policy") or "allow_direct"
    ).strip()
    return execution_policy == "allow_direct"


def select_voice_manifest_actions_for_prompt(
    *,
    screen: str | None = None,
    available_action_ids: list[str] | None = None,
    transcript: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    normalized_screen = str(screen or "").strip()
    normalized_available = {
        str(action_id).strip()
        for action_id in (available_action_ids or [])
        if str(action_id or "").strip()
    }
    normalized_transcript = str(transcript or "").strip().lower()
    ranked: list[tuple[int, dict[str, Any]]] = []

    def _reachable_on_screen(action: dict[str, Any]) -> bool:
        """Exclude actions whose declared screens do not include the current one.

        An action with an EMPTY ``scope.screens`` is screen-agnostic (e.g.
        global navigation) and stays eligible everywhere. But an action that
        DOES declare screens (e.g. ``phone_mandate.submit_number`` scoped to
        ``phone_mandate``/``register_phone``) must NOT surface on an unrelated
        screen like ``one_setup``. Without a known current screen we cannot
        exclude, so everything stays eligible.
        """
        if not normalized_screen:
            return True
        raw_scope = action.get("scope")
        scope: dict[str, Any] = raw_scope if isinstance(raw_scope, dict) else {}
        raw_screens = scope.get("screens") or []
        screens = {str(s).strip() for s in raw_screens if str(s).strip()}
        if not screens:
            return True
        return normalized_screen in screens

    for action in list_voice_manifest_actions():
        if (action.get("execution_target") or {}).get("status") != "wired":
            continue
        # The browser's published visible-action inventory is authoritative.
        # A non-empty inventory is an exact allowlist, never merely a ranking
        # hint; otherwise sibling setup actions leak into the live prompt.
        if normalized_available and action.get("action_id") not in normalized_available:
            continue
        if not _reachable_on_screen(action):
            continue
        score = 0
        if action.get("action_id") in normalized_available:
            score += 6
        scope = action.get("scope") if isinstance(action.get("scope"), dict) else {}
        if normalized_screen and normalized_screen in set(scope.get("screens") or []):
            score += 4
        if normalized_transcript:
            haystacks = [
                str(action.get("label") or "").lower(),
                str(action.get("meaning") or "").lower(),
                *[str(alias).lower() for alias in (action.get("aliases") or [])],
            ]
            if any(text and text in normalized_transcript for text in haystacks):
                score += 3
        if score <= 0:
            continue
        ranked.append((score, action))

    ranked.sort(key=lambda item: (-item[0], str(item[1].get("action_id") or "")))
    selected = [action for _, action in ranked[:limit]]
    if selected:
        return selected
    # Fallback keeps the same screen-reachability guard so off-screen actions
    # (e.g. phone verification while on the setup hub) never leak in.
    return [
        action
        for action in list_voice_manifest_actions()
        if (action.get("execution_target") or {}).get("status") == "wired"
        and _reachable_on_screen(action)
        and (not normalized_available or action.get("action_id") in normalized_available)
    ][: max(0, limit)]
