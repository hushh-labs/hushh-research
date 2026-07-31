"""High-level MCP helpers for external campaign/customer-experience agents."""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass
from typing import Any

from mcp.types import TextContent

from .consent_tools import handle_check_consent_status, handle_request_consent
from .data_tools import handle_get_encrypted_scoped_export
from .utility_tools import handle_discover_user_domains

DEFAULT_EXPIRY_HOURS = 24
DEFAULT_APPROVAL_TIMEOUT_MINUTES = 24 * 60
DEFAULT_POLL_SECONDS = 90
MAX_POLL_SECONDS = 90
POLL_INTERVAL_SECONDS = 5
DENIED_OR_EXPIRED_STATUSES = {
    "cancelled",
    "denied",
    "denied_recently",
    "expired",
    "revoked",
    "timeout",
}


@dataclass(frozen=True)
class ScopeCandidate:
    score: int
    scope: str
    label: str
    domain: str
    description: str
    depth: int
    reason: str


def _json_response(payload: dict[str, Any]) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(payload))]


def _parse_tool_payload(content: list[TextContent]) -> dict[str, Any]:
    if not content:
        return {"status": "error", "error": "Tool returned no content"}
    raw = getattr(content[0], "text", "")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {"status": "error", "error": "Tool returned non-JSON content"}
    return (
        payload
        if isinstance(payload, dict)
        else {"status": "error", "error": "Unexpected tool payload"}
    )


def _status_value(payload: dict[str, Any] | None) -> str:
    if not payload:
        return ""
    return str(payload.get("status") or "").strip().lower()


def _bounded_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _goal_terms(goal: str) -> set[str]:
    return {
        word.lower() for word in re.findall(r"[A-Za-z][A-Za-z0-9]+", goal or "") if len(word) > 2
    }


def _scope_value(scope_entry: Any) -> str:
    if isinstance(scope_entry, dict):
        raw = scope_entry.get("scope")
        if isinstance(raw, dict):
            return str(raw.get("scope") or raw.get("value") or "").strip()
        return str(raw or "").strip()
    return str(scope_entry or "").strip()


def _scope_label(scope_entry: Any) -> str:
    if isinstance(scope_entry, dict):
        raw = scope_entry.get("scope")
        if isinstance(raw, dict):
            return str(
                scope_entry.get("label")
                or raw.get("label")
                or raw.get("display_name")
                or _scope_value(scope_entry)
            ).strip()
        return str(scope_entry.get("label") or _scope_value(scope_entry)).strip()
    return _scope_value(scope_entry)


def _scope_description(scope_entry: Any) -> str:
    if isinstance(scope_entry, dict):
        raw = scope_entry.get("scope")
        if isinstance(raw, dict):
            return str(scope_entry.get("description") or raw.get("description") or "").strip()
        return str(scope_entry.get("description") or "").strip()
    return ""


def _scope_domain(scope: str) -> str:
    match = re.match(r"^attr\.([a-zA-Z0-9_]+)(?:\..*)?$", scope)
    return match.group(1).lower() if match else ""


def _scope_depth(scope: str) -> int:
    return len([part for part in scope.split(".") if part and part != "*"])


def _goal_mentions_finance(goal: str) -> bool:
    return bool(
        _goal_terms(goal)
        & {
            "bank",
            "banking",
            "budget",
            "credit",
            "finance",
            "financial",
            "insurance",
            "invest",
            "investment",
            "loan",
            "money",
            "mortgage",
            "portfolio",
            "wealth",
        }
    )


def _goal_mentions_travel(goal: str) -> bool:
    return bool(
        _goal_terms(goal)
        & {
            "airline",
            "booking",
            "destination",
            "flight",
            "hotel",
            "journey",
            "resort",
            "stay",
            "tour",
            "travel",
            "trip",
            "vacation",
        }
    )


def _goal_mentions_location(goal: str) -> bool:
    return bool(
        _goal_terms(goal)
        & {
            "city",
            "destination",
            "geo",
            "geographic",
            "local",
            "location",
            "nearby",
            "place",
            "region",
        }
    )


def _preferred_domain(preferred_context: str) -> str | None:
    normalized = str(preferred_context or "").strip().lower().replace("-", "_")
    if normalized in {"", "auto", "best", "campaign"}:
        return None
    aliases = {
        "destination": "location",
        "geo": "location",
        "geography": "location",
        "local": "location",
        "purchase": "shopping",
        "purchases": "shopping",
        "receipt": "shopping",
        "receipts": "shopping",
        "retail": "shopping",
        "dining": "food",
        "restaurant": "food",
        "restaurants": "food",
        "finance": "financial",
        "money": "financial",
        "trip": "travel",
        "vacation": "travel",
    }
    return aliases.get(normalized, normalized)


def _score_scope(
    scope_entry: Any,
    *,
    campaign_goal: str,
    surface: str,
    preferred_context: str,
) -> ScopeCandidate | None:
    scope = _scope_value(scope_entry)
    if not scope.startswith("attr."):
        return None

    domain = _scope_domain(scope)
    label = _scope_label(scope_entry) or scope
    description = _scope_description(scope_entry)
    combined = f"{campaign_goal} {surface} {scope} {label} {description}".lower()
    preferred = _preferred_domain(preferred_context)
    travel_goal = _goal_mentions_travel(campaign_goal)
    location_goal = _goal_mentions_location(campaign_goal)
    finance_goal = _goal_mentions_finance(campaign_goal)
    score = 0
    reasons: list[str] = []

    if preferred:
        if domain == preferred or preferred in combined:
            score += 120
            reasons.append(f"matches requested {preferred} context")
        else:
            score -= 25

    if travel_goal:
        if domain == "travel":
            score += 100
            reasons.append("direct travel match")
        elif domain == "shopping":
            shopping_bonus = (
                90 if any(term in combined for term in ("receipt", "purchase", "booking")) else 45
            )
            score += shopping_bonus
            reasons.append("shopping context can reveal travel intent")
        elif domain == "location":
            score += 80
            reasons.append("location context helps trip relevance")
        elif domain == "food":
            score += 35
            reasons.append("food/lifestyle context can support trip experience")
        elif domain == "entertainment":
            score += 25
            reasons.append("entertainment context can support trip experience")
        elif domain == "financial" and not finance_goal:
            score -= 70
            reasons.append("financial context is avoided unless explicitly requested")

    if location_goal and domain == "location":
        score += 90
        reasons.append("location was explicitly requested")

    if finance_goal and domain == "financial":
        score += 90
        reasons.append("financial context was explicitly requested")
    elif domain == "financial":
        score -= 45

    general_experience_terms = {
        "ad",
        "ads",
        "audience",
        "campaign",
        "creative",
        "customer",
        "experience",
        "landing",
        "offer",
        "personalization",
        "relevant",
    }
    if _goal_terms(campaign_goal) & general_experience_terms:
        if domain in {"travel", "shopping", "location", "food"}:
            score += 20
        elif domain == "financial" and not finance_goal:
            score -= 20

    domain_keyword_hits = {
        "travel": ("travel", "trip", "flight", "hotel", "vacation", "destination", "booking"),
        "shopping": ("shopping", "purchase", "receipt", "retail", "commerce", "brand", "offer"),
        "location": ("location", "local", "nearby", "city", "region", "destination"),
        "food": ("food", "dining", "restaurant", "grocery", "cuisine"),
        "financial": ("financial", "finance", "budget", "investment", "portfolio", "wealth"),
    }
    score += sum(5 for keyword in domain_keyword_hits.get(domain, ()) if keyword in combined)

    depth = _scope_depth(scope)
    score += min(depth, 5)
    if scope.endswith(".*"):
        score -= 1

    if score <= 0:
        return None

    if not reasons:
        reasons.append("best available discovered category for the stated purpose")
    return ScopeCandidate(
        score=score,
        scope=scope,
        label=label,
        domain=domain,
        description=description,
        depth=depth,
        reason=", ".join(reasons),
    )


def _select_scope(
    discovery: dict[str, Any],
    *,
    campaign_goal: str,
    surface: str,
    preferred_context: str,
) -> ScopeCandidate | None:
    candidates = [
        candidate
        for entry in discovery.get("scopes") or []
        if (
            candidate := _score_scope(
                entry,
                campaign_goal=campaign_goal,
                surface=surface,
                preferred_context=preferred_context,
            )
        )
    ]
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: (-item.score, -item.depth, item.scope))[0]


def _connector_bundle(args: dict[str, Any]) -> dict[str, str]:
    bundle = {
        "connector_public_key": str(args.get("connector_public_key") or "").strip(),
        "connector_key_id": str(args.get("connector_key_id") or "").strip(),
        "connector_wrapping_alg": str(args.get("connector_wrapping_alg") or "").strip(),
    }
    if not bundle["connector_wrapping_alg"] and bundle["connector_public_key"]:
        bundle["connector_wrapping_alg"] = "X25519-AES256-GCM"
    return bundle


def _has_connector_bundle(bundle: dict[str, str]) -> bool:
    return all(bundle.values())


def _safe_export_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    blocked = {"encrypted_data", "iv", "tag", "wrapped_key_bundle", "consent_token"}
    return {key: value for key, value in payload.items() if key not in blocked}


def _base_response(
    *,
    state: str,
    user_identifier: str,
    selected: ScopeCandidate,
    campaign_goal: str,
    surface: str,
    expiry_hours: int,
    approval_timeout_minutes: int,
    request_id: str | None = None,
    lifecycle_action: str | None = None,
    status_payload: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "state": state,
        "status": state,
        "user_identifier": user_identifier,
        "campaign_goal": campaign_goal,
        "campaign_surface": surface,
        "selected_scope": selected.scope,
        "selected_category_label": selected.label,
        "selected_domain": selected.domain,
        "scope_selection_reason": selected.reason,
        "request_id": request_id,
        "requested_duration_hours": expiry_hours,
        "approval_timeout_minutes": approval_timeout_minutes,
        "lifecycle_action": lifecycle_action,
        "zero_knowledge": True,
        "plaintext_returned": False,
    }
    if status_payload:
        payload.update(
            {
                "requested_scope": status_payload.get("requested_scope") or selected.scope,
                "granted_scope": status_payload.get("granted_scope"),
                "coverage_kind": status_payload.get("coverage_kind"),
                "covered_by_existing_grant": status_payload.get("covered_by_existing_grant"),
                "approval_timeout_at": status_payload.get("approval_timeout_at")
                or status_payload.get("poll_timeout_at"),
                "approval_expires_at": status_payload.get("approval_timeout_at")
                or status_payload.get("poll_timeout_at"),
                "consent_expires_at": status_payload.get("expires_at"),
                "requester_label": status_payload.get("requester_label"),
            }
        )
    if extra:
        payload.update(extra)
    return payload


async def _fetch_export_metadata(
    *,
    user_id: str,
    consent_token: str | None,
    expected_scope: str,
) -> dict[str, Any] | None:
    if not consent_token:
        return None
    export = _parse_tool_payload(
        await handle_get_encrypted_scoped_export(
            {
                "user_id": user_id,
                "consent_token": consent_token,
                "expected_scope": expected_scope,
            }
        )
    )
    if _status_value(export) != "success":
        return {
            "status": export.get("status", "error"),
            "error": export.get("error") or export.get("message") or "Encrypted export not ready",
        }
    return _safe_export_metadata(export)


async def _poll_status(
    *,
    user_id: str,
    scope: str,
    request_id: str | None,
    initial_status: dict[str, Any],
    poll_seconds: int,
) -> tuple[dict[str, Any], int]:
    status = initial_status
    if _status_value(status) not in {"pending", "requested"} or not request_id or poll_seconds <= 0:
        return status, 0

    attempts = 0
    deadline = time.monotonic() + poll_seconds
    while time.monotonic() < deadline:
        await asyncio.sleep(min(POLL_INTERVAL_SECONDS, max(0, deadline - time.monotonic())))
        attempts += 1
        status = _parse_tool_payload(
            await handle_check_consent_status(
                {
                    "user_id": user_id,
                    "scope": scope,
                    "request_id": request_id,
                }
            )
        )
        if _status_value(status) not in {"pending", "requested"}:
            break
    return status, attempts


async def handle_prepare_campaign_context(args: dict) -> list[TextContent]:
    """Run the external-agent consent loop for ads/customer-experience context."""

    user_identifier = str(args.get("user_id") or args.get("user_identifier") or "").strip()
    if not user_identifier:
        return _json_response(
            {
                "state": "needs_user_identifier",
                "status": "needs_user_identifier",
                "message": "Provide user_id as a registered email, phone number, or Firebase UID.",
            }
        )

    campaign_goal = str(args.get("campaign_goal") or args.get("purpose") or "").strip()
    if not campaign_goal:
        campaign_goal = (
            "Improve the next customer experience with the least-privilege approved context."
        )
    surface = str(args.get("surface") or "customer_experience").strip() or "customer_experience"
    preferred_context = str(args.get("preferred_context") or "auto").strip() or "auto"
    country_iso2 = str(args.get("country_iso2") or "").strip() or None
    country = str(args.get("country") or "").strip() or None
    expiry_hours = _bounded_int(
        args.get("expiry_hours"),
        default=DEFAULT_EXPIRY_HOURS,
        minimum=24,
        maximum=2160,
    )
    approval_timeout_minutes = _bounded_int(
        args.get("approval_timeout_minutes"),
        default=DEFAULT_APPROVAL_TIMEOUT_MINUTES,
        minimum=5,
        maximum=1440,
    )
    poll_seconds = _bounded_int(
        args.get("poll_seconds"),
        default=DEFAULT_POLL_SECONDS,
        minimum=0,
        maximum=MAX_POLL_SECONDS,
    )
    fetch_export_metadata = bool(args.get("fetch_export_metadata", True))
    connector_bundle = _connector_bundle(args)

    discovery = _parse_tool_payload(
        await handle_discover_user_domains(
            {
                "user_id": user_identifier,
                **({"country_iso2": country_iso2} if country_iso2 else {}),
                **({"country": country} if country else {}),
            }
        )
    )
    if discovery.get("error") or _status_value(discovery) == "error":
        return _json_response(
            {
                "state": "error",
                "status": "error",
                "user_identifier": user_identifier,
                "message": discovery.get("message")
                or discovery.get("error")
                or "Scope discovery failed.",
                "details": discovery,
            }
        )

    selected = _select_scope(
        discovery,
        campaign_goal=campaign_goal,
        surface=surface,
        preferred_context=preferred_context,
    )
    if selected is None:
        return _json_response(
            {
                "state": "no_matching_category",
                "status": "no_matching_category",
                "user_identifier": user_identifier,
                "campaign_goal": campaign_goal,
                "campaign_surface": surface,
                "available_domains": discovery.get("domains") or [],
                "available_scope_count": len(discovery.get("scopes") or []),
                "message": "Discovery succeeded, but no useful least-privilege category matched this purpose.",
            }
        )

    resolved_user_id = str(discovery.get("user_id") or user_identifier)
    status_payload = _parse_tool_payload(
        await handle_check_consent_status(
            {
                "user_id": resolved_user_id,
                "scope": selected.scope,
                **({"country_iso2": country_iso2} if country_iso2 else {}),
                **({"country": country} if country else {}),
            }
        )
    )
    status = _status_value(status_payload)

    if status == "granted":
        export_metadata = None
        if fetch_export_metadata:
            export_metadata = await _fetch_export_metadata(
                user_id=resolved_user_id,
                consent_token=status_payload.get("consent_token"),
                expected_scope=selected.scope,
            )
        return _json_response(
            _base_response(
                state="approved_ready",
                user_identifier=user_identifier,
                selected=selected,
                campaign_goal=campaign_goal,
                surface=surface,
                expiry_hours=expiry_hours,
                approval_timeout_minutes=approval_timeout_minutes,
                request_id=status_payload.get("request_id"),
                lifecycle_action="already_granted_reused",
                status_payload=status_payload,
                extra={
                    "message": (
                        "Approved context is ready as an encrypted export. "
                        "Decrypt locally with the connector private key before summarizing user preferences."
                    ),
                    "encrypted_export_ready": bool(
                        export_metadata and export_metadata.get("status") == "success"
                    ),
                    "encrypted_export_metadata": export_metadata,
                    "next_step": "Use a local connector/private key to decrypt; do not infer plaintext from metadata.",
                },
            )
        )

    if status in DENIED_OR_EXPIRED_STATUSES:
        return _json_response(
            _base_response(
                state="denied_or_expired",
                user_identifier=user_identifier,
                selected=selected,
                campaign_goal=campaign_goal,
                surface=surface,
                expiry_hours=expiry_hours,
                approval_timeout_minutes=approval_timeout_minutes,
                request_id=status_payload.get("request_id"),
                lifecycle_action="existing_terminal_status",
                status_payload=status_payload,
                extra={
                    "message": status_payload.get("message")
                    or "The matching consent request is not active.",
                },
            )
        )

    if not _has_connector_bundle(connector_bundle):
        return _json_response(
            _base_response(
                state="needs_connector_key_bundle",
                user_identifier=user_identifier,
                selected=selected,
                campaign_goal=campaign_goal,
                surface=surface,
                expiry_hours=expiry_hours,
                approval_timeout_minutes=approval_timeout_minutes,
                request_id=status_payload.get("request_id"),
                lifecycle_action="status_checked_no_grant",
                status_payload=status_payload,
                extra={
                    "message": (
                        "I found the best available category, but a connector public-key bundle is required "
                        "before requesting consent. The hosted MCP must not generate or hold connector private keys."
                    ),
                    "required_fields": [
                        "connector_public_key",
                        "connector_key_id",
                        "connector_wrapping_alg",
                    ],
                    "connector_wrapping_alg": "X25519-AES256-GCM",
                    "next_step": "Generate the keypair in the external/local connector, keep the private key local, then call this tool again with the public bundle.",
                },
            )
        )

    request_payload = _parse_tool_payload(
        await handle_request_consent(
            {
                "user_id": resolved_user_id,
                "scope": selected.scope,
                "reason": campaign_goal,
                "expiry_hours": expiry_hours,
                "approval_timeout_minutes": approval_timeout_minutes,
                **connector_bundle,
                **({"country_iso2": country_iso2} if country_iso2 else {}),
                **({"country": country} if country else {}),
            }
        )
    )
    request_status = _status_value(request_payload)
    request_id = request_payload.get("request_id") or status_payload.get("request_id")

    if request_status == "granted":
        export_metadata = None
        if fetch_export_metadata:
            export_metadata = await _fetch_export_metadata(
                user_id=resolved_user_id,
                consent_token=request_payload.get("consent_token"),
                expected_scope=selected.scope,
            )
        return _json_response(
            _base_response(
                state="approved_ready",
                user_identifier=user_identifier,
                selected=selected,
                campaign_goal=campaign_goal,
                surface=surface,
                expiry_hours=expiry_hours,
                approval_timeout_minutes=approval_timeout_minutes,
                request_id=request_id,
                lifecycle_action="already_granted_reused",
                status_payload=request_payload,
                extra={
                    "message": (
                        "Approved context is ready as an encrypted export. "
                        "Decrypt locally with the connector private key before summarizing user preferences."
                    ),
                    "encrypted_export_ready": bool(
                        export_metadata and export_metadata.get("status") == "success"
                    ),
                    "encrypted_export_metadata": export_metadata,
                    "next_step": "Use local decryption before producing campaign recommendations.",
                },
            )
        )

    if request_status in DENIED_OR_EXPIRED_STATUSES:
        return _json_response(
            _base_response(
                state="denied_or_expired",
                user_identifier=user_identifier,
                selected=selected,
                campaign_goal=campaign_goal,
                surface=surface,
                expiry_hours=expiry_hours,
                approval_timeout_minutes=approval_timeout_minutes,
                request_id=request_id,
                lifecycle_action="request_not_allowed",
                status_payload=request_payload,
                extra={
                    "message": request_payload.get("message") or "Consent request is not active."
                },
            )
        )

    if request_status not in {"pending", "requested"}:
        return _json_response(
            _base_response(
                state="error",
                user_identifier=user_identifier,
                selected=selected,
                campaign_goal=campaign_goal,
                surface=surface,
                expiry_hours=expiry_hours,
                approval_timeout_minutes=approval_timeout_minutes,
                request_id=request_id,
                lifecycle_action="request_failed",
                status_payload=request_payload,
                extra={
                    "message": request_payload.get("error")
                    or request_payload.get("message")
                    or "Consent request failed.",
                    "details": request_payload,
                },
            )
        )

    polled_status, poll_attempts = await _poll_status(
        user_id=resolved_user_id,
        scope=selected.scope,
        request_id=request_id,
        initial_status=request_payload,
        poll_seconds=poll_seconds,
    )
    polled_value = _status_value(polled_status)
    if polled_value == "granted":
        export_metadata = None
        if fetch_export_metadata:
            export_metadata = await _fetch_export_metadata(
                user_id=resolved_user_id,
                consent_token=polled_status.get("consent_token"),
                expected_scope=selected.scope,
            )
        return _json_response(
            _base_response(
                state="approved_ready",
                user_identifier=user_identifier,
                selected=selected,
                campaign_goal=campaign_goal,
                surface=surface,
                expiry_hours=expiry_hours,
                approval_timeout_minutes=approval_timeout_minutes,
                request_id=request_id,
                lifecycle_action="approved_after_polling",
                status_payload=polled_status,
                extra={
                    "message": (
                        "Approved context is ready as an encrypted export. "
                        "Decrypt locally with the connector private key before summarizing user preferences."
                    ),
                    "encrypted_export_ready": bool(
                        export_metadata and export_metadata.get("status") == "success"
                    ),
                    "encrypted_export_metadata": export_metadata,
                    "poll_attempts": poll_attempts,
                    "next_step": "Use local decryption before producing campaign recommendations.",
                },
            )
        )

    if polled_value in DENIED_OR_EXPIRED_STATUSES:
        return _json_response(
            _base_response(
                state="denied_or_expired",
                user_identifier=user_identifier,
                selected=selected,
                campaign_goal=campaign_goal,
                surface=surface,
                expiry_hours=expiry_hours,
                approval_timeout_minutes=approval_timeout_minutes,
                request_id=request_id,
                lifecycle_action="terminal_after_polling",
                status_payload=polled_status,
                extra={
                    "poll_attempts": poll_attempts,
                    "message": polled_status.get("message")
                    or "The One user did not approve this request.",
                },
            )
        )

    return _json_response(
        _base_response(
            state="pending_approval",
            user_identifier=user_identifier,
            selected=selected,
            campaign_goal=campaign_goal,
            surface=surface,
            expiry_hours=expiry_hours,
            approval_timeout_minutes=approval_timeout_minutes,
            request_id=request_id,
            lifecycle_action="new_or_reused_pending_request",
            status_payload=polled_status,
            extra={
                "poll_attempts": poll_attempts,
                "message": "I found the best available category and sent a permission request. Waiting for One approval.",
                "next_step": "The One user must approve this exact scope in the Hussh app; then call this tool again.",
            },
        )
    )
