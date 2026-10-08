"""Authored metadata-only pricing and lifecycle fields for the canonical MCP catalog.

The flat-contract owner supplies its field constructor and titles. These fields
never create quotes or authorize payment, consent, or information retrieval.
"""

from __future__ import annotations

from typing import Any, Callable


def commercial_output_fields(field: Callable[..., dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        "tariff_price_cents": field(
            "integer",
            "Owner's base tariff in USD cents before approval. This is an estimate, not an accepted quote.",
            minimum=0,
            maximum=100000,
        ),
        "tariff_base_duration_seconds": field(
            "integer",
            "Base duration used to prorate the owner's tariff after exact approval.",
            minimum=0,
        ),
        "tariff_revision": field(
            "integer",
            "Owner tariff revision at request intake; accepted quote freezes the approved revision.",
            minimum=0,
        ),
        "paid_required": field(
            "boolean",
            "True when this request requires owner-approved terms and subsequent human purchase confirmation.",
        ),
        "quote_ref": field(
            "string",
            "Immutable server-owned quote reference; it never authorizes spending.",
            maxLength=64,
        ),
        "price_cents": field(
            "integer",
            "Quoted gross USD purchase price in cents, from one cent through 1000 USD.",
            minimum=0,
            maximum=100000,
        ),
        "currency": field(
            "string", "Purchase currency. Paid scope access currently uses USD.", enum=["usd"]
        ),
        "consent_state": field(
            "string", "Owner approval state, distinct from payment and usable access.", maxLength=32
        ),
        "payment_state": field(
            "string",
            "Funding/reservation state. MCP credentials do not authorize purchases.",
            maxLength=32,
        ),
        "access_state": field(
            "string",
            "Usable-access state; retrieval is allowed only for an active approved grant.",
            maxLength=32,
        ),
        "human_action_url": field(
            "string",
            "Hussh app link for the authenticated app owner to review and confirm the exact quote. Opening it does not spend funds.",
            maxLength=2048,
        ),
        "activates_at": field(
            "integer",
            "Fixed activation time in Unix epoch milliseconds, or zero before preparation.",
            minimum=0,
        ),
    }


def discovery_output_fields(field: Callable[..., dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        "status": field("string", "Result status. A successful call returns success."),
        "scope_values": field(
            "array",
            "Available scope strings. Use one unchanged in request-consent.",
            items=field("string", "One least-privilege scope value.", maxLength=200),
            maxItems=50,
        ),
        "next_cursor": field(
            "string",
            "Cursor for the next page, or an empty string when no next page exists.",
            maxLength=64,
        ),
        "has_more": field("boolean", "True when another page of scopes is available."),
        "scope_price_cents": field(
            "array",
            "Exact-scope base prices aligned with scope_values; zero means free or unset pricing.",
            items=field(
                "string",
                "Base USD price in cents as a decimal integer string.",
                maxLength=6,
                pattern=r"^[0-9]+$",
            ),
            maxItems=50,
        ),
        "scope_base_duration_seconds": field(
            "array",
            "Tariff base durations aligned with scope_values; zero means no tariff.",
            items=field(
                "string",
                "Tariff base duration in seconds as a decimal integer string.",
                maxLength=12,
                pattern=r"^[0-9]+$",
            ),
            maxItems=50,
        ),
        "scope_tariff_revisions": field(
            "array",
            "Tariff revisions aligned with scope_values; zero means no tariff.",
            items=field(
                "string",
                "Persisted tariff revision as a decimal integer string.",
                maxLength=12,
                pattern=r"^[0-9]+$",
            ),
            maxItems=50,
        ),
    }
