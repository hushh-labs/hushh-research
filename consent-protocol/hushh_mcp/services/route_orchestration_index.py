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

from hushh_mcp.contracts_root import contracts_path, require_contracts_root


def _index_path() -> Path | None:
    # Per call, not a module constant: see hushh_mcp/contracts_root.py for why a
    # repo-root-anchored constant resolved to the wrong place inside the image.
    return contracts_path("kai", "one-route-orchestration-index.v1.json")


@lru_cache(maxsize=1)
def load_route_orchestration_index() -> dict[str, dict[str, Any]]:
    index_path = _index_path()
    if index_path is None or not index_path.exists():
        # An empty index silently admits nothing, so delegate-admission decisions
        # would be made against no data at all. Say so.
        require_contracts_root("route_orchestration_index")
        return {}
    try:
        payload = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    routes = payload.get("routes") if isinstance(payload, dict) else []
    return {
        str(entry.get("route_pattern")): entry
        for entry in routes
        if isinstance(entry, dict) and isinstance(entry.get("route_pattern"), str)
    }


def resolve_route_orchestration_entry(route_family: str | None) -> dict[str, Any] | None:
    """Resolve a canonical browser route against the generated route index.

    Route patterns are authored by Next.js and may contain ``[param]``
    segments.  Live browser context always contains a concrete path, so an
    exact dictionary lookup silently dropped policy for dynamic routes such as
    ``/one/setup/finance``.  Match only whole path segments and prefer an
    exact entry; this is descriptive route policy, never a route executor.
    """
    route = str(route_family or "").strip().split("?", 1)[0]
    if not route.startswith("/"):
        return None
    route = route.rstrip("/") or "/"
    index = load_route_orchestration_index()
    exact = index.get(route)
    if exact is not None:
        return exact

    route_segments = route.strip("/").split("/") if route != "/" else []
    for pattern, entry in index.items():
        pattern_segments = pattern.strip("/").split("/") if pattern != "/" else []
        if len(pattern_segments) != len(route_segments):
            continue
        if all(
            pattern_segment.startswith("[")
            and pattern_segment.endswith("]")
            or pattern_segment == route_segment
            for pattern_segment, route_segment in zip(
                pattern_segments, route_segments, strict=False
            )
        ):
            return entry
    return None


def is_one_delegate_admitted(route_family: str | None, agent_id: str) -> bool | None:
    """Return route admission; None preserves non-live compatibility.

    One is the single routing authority. Admission is descriptive scoping, not
    a trust boundary: the specialist's own consent + TrustLink checks remain the
    real gate, so One may reach a wired, authenticated, consent-bearing
    specialist by intent from any screen. Absence of an explicit block admits.

    A route suppresses delegation only when it explicitly opts out:
    ``delegation_policy.mode == "block_delegation"`` (redirect, OAuth-return, and
    callback surfaces where mid-flow delegation is incoherent) or the agent
    appears in ``blocked_delegate_agent_ids``. ``allowed_delegate_agent_ids`` is
    advisory (the screen's primary specialists surfaced via the playbook), never
    a veto.
    """
    route = str(route_family or "").strip()
    if not route:
        return None
    entry = resolve_route_orchestration_entry(route)
    if entry is None:
        return True
    policy = entry.get("delegation_policy")
    if not isinstance(policy, dict):
        return True
    if policy.get("mode") == "block_delegation":
        return False
    blocked = policy.get("blocked_delegate_agent_ids")
    if isinstance(blocked, list) and agent_id in blocked:
        return False
    return True
