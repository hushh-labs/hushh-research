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


def _path_segments(path: str) -> list[str]:
    return path.strip("/").split("/") if path != "/" else []


def _segments_match(pattern_segments: list[str], route_segments: list[str]) -> bool:
    if len(pattern_segments) != len(route_segments):
        return False
    return all(
        (pattern_segment.startswith("[") and pattern_segment.endswith("]"))
        or pattern_segment == route_segment
        for pattern_segment, route_segment in zip(
            pattern_segments, route_segments, strict=False
        )
    )


def _query_pairs(query: str) -> set[str]:
    """Order-insensitive ``key=value`` pairs; authored and live order differ."""
    return {pair for pair in str(query or "").split("&") if pair and "=" in pair}


def resolve_route_orchestration_entry(
    route_family: str | None, route_query: str | None = None
) -> dict[str, Any] | None:
    """Resolve a canonical browser route against the generated route index.

    Route patterns are authored by Next.js and may contain ``[param]``
    segments.  Live browser context always contains a concrete path, so an
    exact dictionary lookup silently dropped policy for dynamic routes such as
    ``/one/setup/finance``.  Match only whole path segments and prefer an
    exact entry; this is descriptive route policy, never a route executor.

    ``route_query`` selects between screens that share one path.  Tab surfaces
    such as ``/one/kai?tab=analysis`` and ``?tab=market`` are the same physical
    route, so a path-only lookup reported one canonical_screen for both -- and
    because the relay derives the authoritative screen here rather than
    trusting the browser, the losing tab was unobservable to a journey waiting
    on it.  A query-qualified entry wins only when every parameter it declares
    is present, so an unrelated extra parameter cannot demote the match, and
    the path-only entry stays the fallback for every route without variants.
    """
    raw = str(route_family or "").strip()
    inline_path, _, inline_query = raw.partition("?")
    if not inline_path.startswith("/"):
        return None
    route = inline_path.rstrip("/") or "/"
    query = _query_pairs(route_query if route_query is not None else inline_query)
    index = load_route_orchestration_index()
    route_segments = _path_segments(route)

    best: dict[str, Any] | None = None
    best_specificity = -1
    fallback: dict[str, Any] | None = None
    for pattern, entry in index.items():
        pattern_path, _, pattern_query = pattern.partition("?")
        pattern_path = pattern_path.rstrip("/") or "/"
        if pattern_path != route and not _segments_match(
            _path_segments(pattern_path), route_segments
        ):
            continue
        declared = _query_pairs(pattern_query)
        if not declared:
            # Exact path beats a dynamic-segment match for the same fallback slot.
            if fallback is None or pattern_path == route:
                fallback = entry
            continue
        if not query or not declared.issubset(query):
            continue
        if len(declared) > best_specificity:
            best = entry
            best_specificity = len(declared)
    return best if best is not None else fallback


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
