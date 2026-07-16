"""Hardened compatibility orchestration for campaign/CX consent callers."""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

from mcp.types import TextContent

from .public_tools_v3 import (
    ToolResult,
    _error,
    handle_check_consent_status,
    handle_get_encrypted_scoped_export,
    handle_request_consent,
    handle_search_user_scopes,
)

_TERMINAL_STATES = {"denied", "expired", "revoked", "cancelled"}
_DOMAIN_HINTS = {
    "financial": {"bank", "budget", "finance", "financial", "invest", "money", "portfolio"},
    "food": {"dining", "eat", "food", "meal", "restaurant"},
    "location": {"city", "local", "location", "nearby", "place"},
    "shopping": {"buy", "commerce", "purchase", "receipt", "shop", "shopping"},
    "travel": {"airline", "flight", "hotel", "resort", "travel", "trip", "vacation"},
}


def _success(payload: dict[str, Any]) -> ToolResult:
    return [TextContent(type="text", text=json.dumps(payload))], payload


def _terms(value: str) -> set[str]:
    return {term.lower() for term in re.findall(r"[A-Za-z][A-Za-z0-9_]+", value) if len(term) > 2}


def _select_scope(
    scopes: list[dict[str, Any]],
    *,
    campaign_goal: str,
    surface: str,
    preferred_context: str,
) -> dict[str, Any] | None:
    intent_terms = _terms(f"{campaign_goal} {surface}")
    preferred = preferred_context.strip().lower()
    inferred_domains = {
        domain for domain, hints in _DOMAIN_HINTS.items() if intent_terms.intersection(hints)
    }
    scored: list[tuple[int, int, str, dict[str, Any]]] = []
    for entry in scopes:
        scope = str(entry.get("scope") or "")
        domain = str(entry.get("domain") or "")
        label = str(entry.get("label") or "")
        description = str(entry.get("description") or "")
        haystack = f"{scope} {domain} {label} {description}".lower()
        overlap = len(intent_terms.intersection(_terms(haystack)))
        score = overlap * 20
        if preferred and preferred != "auto" and preferred in haystack:
            score += 200
        if domain in inferred_domains:
            score += 100
        # A trip without a dedicated travel scope is better served by shopping
        # receipts/preferences than by unrelated financial aggregates.
        if "travel" in inferred_domains and domain == "shopping":
            score += 45
        if "travel" in inferred_domains and domain == "location":
            score += 30
        if "travel" in inferred_domains and domain == "financial":
            score -= 20
        depth = len([part for part in scope.split(".") if part and part != "*"])
        scored.append((score, depth, scope, entry))
    if not scored:
        return None
    scored.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    # With no semantic signal, preserve deterministic least-privilege behavior
    # by choosing the deepest available returned scope.
    return scored[0][3]


async def handle_prepare_campaign_context(args: dict[str, Any]) -> ToolResult:
    """Preserve the ADK one-shot dependency on top of the v0.3 reference flow."""

    identifier = str(args.get("user_identifier") or args.get("user_id") or "").strip()
    campaign_goal = str(
        args.get("campaign_goal")
        or args.get("purpose")
        or "Improve the next customer experience using least-privilege approved information."
    ).strip()
    country_fields = {
        key: str(args[key]).strip() for key in ("country_iso2", "country") if args.get(key)
    }
    discovery = (
        await handle_search_user_scopes(
            {
                "user_identifier": identifier,
                "query": "",
                "limit": 50,
                **country_fields,
            }
        )
    )[1]
    if "error_code" in discovery:
        return _success(discovery)

    available = list(discovery.get("scopes") or [])[:50]
    selected = _select_scope(
        available,
        campaign_goal=campaign_goal,
        surface=str(args.get("surface") or "customer_experience")[:80],
        preferred_context=str(args.get("preferred_context") or "auto")[:256],
    )
    if selected is None:
        return _error(
            "NO_MATCHING_SCOPE",
            "No available scope matches the campaign purpose.",
            recoverable=True,
            next_action="Refine the purpose or let the user add the relevant information first.",
        )

    selected_scope = str(selected["scope"])
    request_args: dict[str, Any] = {
        "user_identifier": identifier,
        "scope": selected_scope,
        "purpose": (
            campaign_goal[:280]
            if len(campaign_goal) >= 8
            else f"{campaign_goal} campaign purpose"[:280]
        ),
        "expiry_hours": int(args.get("expiry_hours") or 24),
        "approval_timeout_minutes": int(args.get("approval_timeout_minutes") or 1440),
        "refresh_policy": str(args.get("refresh_policy") or "snapshot"),
        **country_fields,
    }
    for key in ("connector_public_key", "connector_key_id", "connector_wrapping_alg"):
        if args.get(key):
            request_args[key] = str(args[key]).strip()

    requested = (await handle_request_consent(request_args))[1]
    if "error_code" in requested:
        return _success(requested)

    grant_reused = requested.get("status") == "granted"
    lifecycle = requested
    request_ref = str(requested.get("request_ref") or "") or None
    grant_ref = str(requested.get("grant_ref") or "") or None
    poll_attempts = 0
    requested_poll_seconds = args.get("poll_seconds")
    poll_seconds = max(
        0,
        min(90 if requested_poll_seconds is None else int(requested_poll_seconds), 90),
    )
    deadline = time.monotonic() + poll_seconds
    while lifecycle.get("status") == "pending" and request_ref and time.monotonic() < deadline:
        interval = max(1, min(int(lifecycle.get("poll_after_seconds") or 5), 30))
        await asyncio.sleep(min(interval, max(0.0, deadline - time.monotonic())))
        poll_attempts += 1
        lifecycle = (await handle_check_consent_status({"request_ref": request_ref}))[1]
        if "error_code" in lifecycle:
            return _success(lifecycle)
        if lifecycle.get("grant_ref"):
            grant_ref = str(lifecycle["grant_ref"])

    status = str(lifecycle.get("status") or requested.get("status") or "pending")
    # The legacy ADK parser classifies expired/revoked/denied as unusable but
    # does not recognize cancelled. Preserve that terminal meaning without
    # exposing a new state to the compatibility caller.
    if status == "cancelled":
        status = "expired"
    if status not in {"pending", "granted", *_TERMINAL_STATES}:
        return _error(
            "INVALID_BACKEND_RESPONSE",
            "Hussh returned an invalid campaign consent lifecycle response.",
            recoverable=True,
            next_action="Retry once; if it repeats, report the correlation reference.",
        )

    export_ready = False
    export_revision: int | None = None
    if status == "granted" and grant_ref and bool(args.get("fetch_export_metadata", True)):
        export = (
            await handle_get_encrypted_scoped_export(
                {"grant_ref": grant_ref, "expected_scope": selected_scope}
            )
        )[1]
        if "error_code" not in export:
            export_ready = export.get("status") == "success"
            if export.get("export_revision") is not None:
                export_revision = int(export["export_revision"])

    state = {
        "pending": "pending_approval",
        "granted": "approved_ready",
        "denied": "denied",
        "expired": "expired",
        "revoked": "revoked",
        "cancelled": "cancelled",
    }[status]
    payload = {
        "status": status,
        "state": state,
        "selected_scope": selected_scope,
        "selected_scope_label": str(selected.get("label") or "Scope")[:120],
        "available_scopes": [str(item.get("scope") or "")[:200] for item in available],
        # request_id is retained only as an opaque alias for the current ADK
        # wrapper; new callers should use request_ref.
        "request_id": request_ref or grant_ref,
        "request_ref": request_ref,
        "grant_ref": grant_ref,
        "grant_reused": grant_reused,
        "export_metadata_ready": export_ready,
        "export_revision": export_revision,
        "expires_at": lifecycle.get("expires_at"),
        "approval_timeout_at": lifecycle.get("approval_timeout_at"),
        "poll_attempts": poll_attempts,
    }
    return _success(payload)
