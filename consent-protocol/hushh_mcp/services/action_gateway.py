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

from hushh_mcp.contracts_root import contracts_path, require_contracts_root


def _gateway_path() -> Path | None:
    # Resolved per call rather than at import: the tree lives in a different place in
    # a repo checkout than in the image, and a module-level constant froze the wrong
    # one into the build. See hushh_mcp/contracts_root.py.
    return contracts_path("kai", "kai-action-gateway.vnext.json")


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
    gateway_path = _gateway_path()
    if gateway_path is None or not gateway_path.exists():
        require_contracts_root("action_gateway")
        return {"schema_version": "kai.action_gateway.vnext", "actions": [], "source": "missing"}
    raw = json.loads(gateway_path.read_text(encoding="utf-8"))
    raw_actions = raw.get("actions") if isinstance(raw, dict) else []
    actions = [entry for entry in (_normalize(item) for item in raw_actions or []) if entry]
    return {
        "schema_version": str(raw.get("schema_version") or "kai.action_gateway.vnext")
        if isinstance(raw, dict)
        else "kai.action_gateway.vnext",
        "actions": actions,
        "source": "file",
        "path": str(gateway_path),
    }


def list_action_gateway_actions() -> list[dict[str, Any]]:
    return list(load_action_gateway().get("actions") or [])


@lru_cache(maxsize=1)
def _action_index() -> dict[str, dict[str, Any]]:
    return {entry["action_id"]: entry for entry in list_action_gateway_actions()}


def get_action_gateway_action(action_id: str | None) -> dict[str, Any] | None:
    return _action_index().get(str(action_id or "").strip())


def is_navigation_action(entry: dict[str, Any] | None) -> bool:
    """True when running ``entry`` only moves the person to another screen.

    Navigation is admissible from any screen: it is how "go to profile" stays
    proposable from a tab that has never heard of the profile. Everything else
    has to be offered by the screen it belongs to.

    Membership is a UNION of two tests, and both are load-bearing:

    * ``execution_target.path == "route"`` -- the action navigates, whatever it
      is called. Forty-one contracts navigate under a surface-scoped name
      (``location.open_join_circle``, ``setup.open_finance``, the RIA workspace
      tabs). Judging those by name alone made them ordinary screen inventory,
      so they competed for the capped ``available_action_ids`` slots and were
      simply refused once a surface declared more actions than the cap. That is
      what broke "join a circle" on Location.
    * the ``route.`` name prefix -- because seven navigation contracts do NOT
      have a route path. ``route.profile``, ``route.consents`` and
      ``route.analysis_history`` run through ``kai_command`` and ``route.back``
      through ``voice_tool``. Dropping the prefix test in favour of the path
      would have un-navigated exactly the cross-screen actions the reserved
      global-navigation segment exists to protect.

    Authority is unchanged either way: this decides what may be PROPOSED, and
    ``run_app_action`` still re-validates screens and guards before anything
    is parked as a directive.
    """
    if not entry:
        return False
    execution_target = entry.get("execution_target") or {}
    if execution_target.get("status") != "wired":
        return False
    navigates = (
        str(entry.get("action_id") or "").startswith("route.")
        or execution_target.get("path") == "route"
    )
    if not navigates:
        return False
    return (
        str((entry.get("risk") or {}).get("execution_policy") or "allow_direct") == "allow_direct"
    )
