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
    expected_effects = (
        raw.get("expected_effects") if isinstance(raw.get("expected_effects"), dict) else {}
    )
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
        "aliases": aliases,
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
        },
        "guards": guards,
        "risk": {
            "execution_policy": execution_policy or "allow_direct",
        },
        "completion_mode": completion_mode or "none",
        "expected_effects": expected_effects,
        "background_behavior": background_behavior,
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


def get_voice_manifest_action(action_id: str | None) -> dict[str, Any] | None:
    normalized_action_id = str(action_id or "").strip()
    if not normalized_action_id:
        return None
    for action in list_voice_manifest_actions():
        if action.get("action_id") == normalized_action_id:
            return action
    return None


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

    for action in list_voice_manifest_actions():
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
    return list_voice_manifest_actions()[: max(0, limit)]
