"""Consent lifecycle DTO projections; authority remains in the calling routes.

These helpers serialize already authenticated status and approved scope metadata.
They never validate tokens, create grants, or query the commercial ledger.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping

from fastapi import HTTPException

from hushh_mcp.services.developer_registry_service import DeveloperPrincipal


def request_fields(
    raw: dict[str, Any],
    *,
    scope: str,
    granted: bool,
    request_ref: str,
    number: Callable[[Any], int | None],
) -> dict[str, Any]:
    response = {
        "status": "granted" if granted else "pending",
        "scope": str(raw.get("requested_scope") or raw.get("scope") or scope),
        "coverage_kind": raw.get("coverage_kind") if granted else None,
        "expires_at": number(raw.get("expires_at")),
        "poll_after_seconds": None if granted else 5,
        "approval_timeout_at": number(raw.get("approval_timeout_at") or raw.get("poll_timeout_at")),
    }
    response["grant_ref" if granted else "request_ref"] = request_ref
    response.update(
        {
            key: raw[key]
            for key in (
                "quote_ref",
                "price_cents",
                "currency",
                "consent_state",
                "payment_state",
                "access_state",
                "human_action_url",
                "activates_at",
                "tariff_price_cents",
                "tariff_base_duration_seconds",
                "tariff_revision",
                "paid_required",
            )
            if key in raw
        }
    )
    if isinstance(raw.get("offer"), dict):
        response["offer"] = raw["offer"]
    return response


def active_status_fields(
    active: dict[str, Any],
    active_metadata: dict[str, Any],
    *,
    user_id: str,
    normalized_scope: str,
    coverage: Mapping[str, Any],
    export_fields: Mapping[str, Any],
    principal: DeveloperPrincipal,
    request_url: str | None,
    number: Callable[[Any], int | None],
    text: Callable[[Any], str | None],
) -> dict[str, Any]:
    return dict(
        status="granted",
        user_id=user_id,
        scope=normalized_scope,
        requested_scope=coverage["requested_scope"],
        granted_scope=coverage["granted_scope"],
        coverage_kind=coverage["coverage_kind"],
        covered_by_existing_grant=coverage["covered_by_existing_grant"],
        request_id=active.get("request_id"),
        consent_token=active.get("token_id"),
        expires_at=active.get("expires_at"),
        export_revision=export_fields["export_revision"],
        export_generated_at=export_fields["export_generated_at"],
        export_refresh_status=export_fields["export_refresh_status"],
        expiry_hours=number(active_metadata.get("expiry_hours")),
        request_url=request_url,
        requester_label=text(active_metadata.get("requester_label")),
        requester_image_url=text(active_metadata.get("requester_image_url")),
        reason=text(active_metadata.get("reason")),
        app_id=principal.app_id,
        app_display_name=principal.display_name,
        message=(
            "Consent is active for this app and scope."
            if str(active.get("scope") or "") == normalized_scope
            else "Consent is active for this app; an existing broader grant covers the requested scope."
        ),
    )


def timed_status(
    lifecycle: str,
    *,
    action: str,
    approval_timeout_at: int | None,
    expires_at: int | None,
    now_ms: int,
) -> str:
    if (
        lifecycle == "pending"
        and action == "REQUESTED"
        and approval_timeout_at is not None
        and approval_timeout_at <= now_ms
    ):
        return "expired"
    if lifecycle == "granted" and expires_at is not None and expires_at <= now_ms:
        return "expired"
    return lifecycle


def mcp_status_fields(
    *,
    tariff: dict[str, Any],
    commercial: dict[str, Any],
    lifecycle: str,
    expires_at: int | None,
    approval_timeout_at: int | None,
    request_ref: str,
) -> dict[str, Any]:
    return {
        **tariff,
        **commercial,
        "status": lifecycle,
        "expires_at": expires_at,
        "poll_after_seconds": 5 if lifecycle == "pending" else None,
        "approval_timeout_at": approval_timeout_at,
        "grant_ref": request_ref if lifecycle == "granted" else None,
    }


def invalid_token_status(reason: str | None) -> str:
    """Project failed validation without treating temporary outages as revocation."""
    normalized_reason = str(reason or "").lower()
    if "db unavailable" in normalized_reason:
        raise HTTPException(
            status_code=503,
            detail={
                "error_code": "CONSENT_STATUS_UNAVAILABLE",
                "message": "Consent status is temporarily unavailable. Retry the request.",
            },
        )
    return "expired" if "expired" in normalized_reason else "revoked"
