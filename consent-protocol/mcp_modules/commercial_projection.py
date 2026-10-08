"""Model-safe public commercial metadata projections; no payment or consent authority.

Tool, campaign and flat adapters share these bounded projections of server state.
Malformed-value handling remains an explicit caller-owned conversion seam.
"""

from __future__ import annotations

from typing import Any, Callable


def _positive_integer(value: Any) -> int:
    return max(0, int(value or 0))


def commercial_fields(
    data: dict[str, Any], *, number: Callable[[object], int] = _positive_integer
) -> dict[str, Any]:
    """Project server-owned purchase metadata, never funding or spend authority."""
    tariff = (
        {
            "tariff_price_cents": min(number(data.get("tariff_price_cents")), 100_000),
            "tariff_base_duration_seconds": number(data.get("tariff_base_duration_seconds")),
            "tariff_revision": number(data.get("tariff_revision")),
            "paid_required": True,
        }
        if data.get("paid_required")
        else {}
    )
    if not data.get("quote_ref"):
        return tariff
    return {
        **tariff,
        "quote_ref": str(data.get("quote_ref") or "")[:64],
        "price_cents": min(number(data.get("price_cents")), 100_000),
        "currency": "usd",
        "consent_state": str(data.get("consent_state") or "")[:32],
        "payment_state": str(data.get("payment_state") or "")[:32],
        "access_state": str(data.get("access_state") or "")[:32],
        "human_action_url": str(data.get("human_action_url") or "")[:2048],
        "activates_at": number(data.get("activates_at")),
    }


def negotiation_fields(data: dict[str, Any]) -> dict[str, Any]:
    offer = data.get("offer")
    if not isinstance(offer, dict):
        return {}
    return {
        "offer": {
            "bid_amount": offer.get("bid_amount"),
            "currency": str(offer.get("currency") or "")[:3],
            "offer_summary": str(offer.get("offer_summary") or "")[:500],
            "settlement_ref": str(offer.get("settlement_ref") or "")[:128],
            "settlement_status": str(offer.get("settlement_status") or "")[:64],
        }
    }


def export_receipt_fields(
    data: dict[str, Any], *, user_id: str, granted_scope: str, expected_scope: str | None
) -> dict[str, Any]:
    """Serialize authorized legacy export metadata with an opaque paid receipt."""
    return {
        "status": "success",
        **({"user_id": user_id} if data.get("commercial_required") is not True else {}),
        "scope": granted_scope,
        **({"expected_scope": expected_scope} if expected_scope else {}),
        "consent_verified": True,
        "granted_scope": data.get("granted_scope", granted_scope),
        "coverage_kind": data.get("coverage_kind"),
        "expires_at": data.get("expires_at"),
        "export_revision": data.get("export_revision"),
        "export_generated_at": data.get("export_generated_at"),
        "export_refresh_status": data.get("export_refresh_status"),
        "message": data.get("message"),
    }


def discovery_result(
    payload: dict[str, Any], *, text: Callable[[object], str], number: Callable[[object], int]
) -> dict[str, Any]:
    scopes = payload.get("scopes")
    if not isinstance(scopes, list):
        raise ValueError("scope result is missing a scope list")
    return {
        "status": text(payload.get("status")),
        "scope_values": [
            text(item.get("scope"))
            for item in scopes
            if isinstance(item, dict) and text(item.get("scope"))
        ],
        "next_cursor": text(payload.get("next_cursor")),
        "has_more": bool(payload.get("has_more")),
        "scope_price_cents": [
            str(min(100_000, number((item.get("tariff") or {}).get("price_cents"))))
            for item in scopes
            if isinstance(item, dict) and text(item.get("scope"))
        ],
        "scope_base_duration_seconds": [
            str(number((item.get("tariff") or {}).get("base_duration_seconds")))
            for item in scopes
            if isinstance(item, dict) and text(item.get("scope"))
        ],
        "scope_tariff_revisions": [
            str(number((item.get("tariff") or {}).get("revision")))
            for item in scopes
            if isinstance(item, dict) and text(item.get("scope"))
        ],
    }
