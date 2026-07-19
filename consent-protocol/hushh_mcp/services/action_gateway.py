"""Read the generated One action gateway.

The checked-in ``kai-action-gateway.vnext.json`` is the sole action artifact.
This module is deliberately a loader and validator, never a semantic router:
One's ADK model selects an action and these helpers only prove that its id is
generated, wired, and allowed by the browser-published inventory.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_GATEWAY_PATH = (
    Path(__file__).resolve().parents[3] / "contracts" / "kai" / "kai-action-gateway.vnext.json"
)


def _strings(value: Any) -> list[str]:
    return [str(item).strip() for item in value or [] if str(item or "").strip()]


def _normalize(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    action_id = str(raw.get("action_id") or "").strip()
    label = str(raw.get("label") or "").strip()
    meaning = str(raw.get("meaning") or "").strip()
    if not action_id or not label or not meaning:
        return None
    reachability = raw.get("reachability") if isinstance(raw.get("reachability"), dict) else {}
    target = raw.get("execution_target") if isinstance(raw.get("execution_target"), dict) else {}
    status = str(target.get("status") or "unwired").strip()
    if status not in {"wired", "unwired", "dead"}:
        status = "unwired"
    return {
        **raw,
        "action_id": action_id,
        "label": label,
        "meaning": meaning,
        "aliases": _strings(raw.get("aliases")),
        "search_keywords": _strings(raw.get("search_keywords")),
        "scope": {
            "routes": _strings(reachability.get("routes")),
            "screens": _strings(reachability.get("screens")),
            "hidden_navigable": reachability.get("hidden_navigable") is True,
        },
        "guards": [{"id": guard_id} for guard_id in _strings(raw.get("guard_ids"))],
        "risk": {
            "execution_policy": str(raw.get("execution_policy") or "allow_direct").strip(),
        },
        "execution_target": {
            **target,
            "status": status,
            **(
                {"reason": str(target.get("reason") or "Not available in this runtime.")}
                if status != "wired"
                else {}
            ),
        },
    }


@lru_cache(maxsize=1)
def load_action_gateway() -> dict[str, Any]:
    if not _GATEWAY_PATH.exists():
        return {"schema_version": "kai.action_gateway.vnext", "actions": [], "source": "missing"}
    raw = json.loads(_GATEWAY_PATH.read_text(encoding="utf-8"))
    raw_actions = raw.get("actions") if isinstance(raw, dict) else []
    actions = [entry for entry in (_normalize(item) for item in raw_actions or []) if entry]
    return {
        "schema_version": str(raw.get("schema_version") or "kai.action_gateway.vnext")
        if isinstance(raw, dict)
        else "kai.action_gateway.vnext",
        "actions": actions,
        "source": "file",
        "path": str(_GATEWAY_PATH),
    }


def list_action_gateway_actions() -> list[dict[str, Any]]:
    return list(load_action_gateway().get("actions") or [])


@lru_cache(maxsize=1)
def _action_index() -> dict[str, dict[str, Any]]:
    return {entry["action_id"]: entry for entry in list_action_gateway_actions()}


def get_action_gateway_action(action_id: str | None) -> dict[str, Any] | None:
    return _action_index().get(str(action_id or "").strip())


def is_navigation_action(entry: dict[str, Any] | None) -> bool:
    if not entry or not str(entry.get("action_id") or "").startswith("route."):
        return False
    return (entry.get("execution_target") or {}).get("status") == "wired" and str(
        (entry.get("risk") or {}).get("execution_policy") or "allow_direct"
    ) == "allow_direct"
