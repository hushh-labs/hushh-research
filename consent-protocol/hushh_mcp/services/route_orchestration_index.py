"""Generated route discovery and One delegation-admission index.

The index is descriptive policy only. It never carries a TrustLink, consent
token, user state, or route-bound signature; TrustLink verification remains
the delegated-authority boundary.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_INDEX_PATH = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "kai"
    / "one-route-orchestration-index.v1.json"
)


@lru_cache(maxsize=1)
def load_route_orchestration_index() -> dict[str, dict[str, Any]]:
    if not _INDEX_PATH.exists():
        return {}
    try:
        payload = json.loads(_INDEX_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    routes = payload.get("routes") if isinstance(payload, dict) else []
    return {
        str(entry.get("route_pattern")): entry
        for entry in routes
        if isinstance(entry, dict) and isinstance(entry.get("route_pattern"), str)
    }


def is_one_delegate_admitted(route_family: str | None, agent_id: str) -> bool | None:
    """Return route admission; None preserves non-live compatibility.

    A route with an index entry fails closed for a specialist it did not
    declare. This gate is before A2A dispatch, not an alternative authority.
    """
    route = str(route_family or "").strip()
    if not route:
        return None
    entry = load_route_orchestration_index().get(route)
    if entry is None:
        return False
    policy = entry.get("delegation_policy")
    if not isinstance(policy, dict) or policy.get("mode") != "one_action_gate":
        return False
    allowed = policy.get("allowed_delegate_agent_ids")
    return isinstance(allowed, list) and agent_id in allowed
