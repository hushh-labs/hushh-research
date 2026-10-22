"""Typed developer consent and encrypted-export wire contracts.

The developer route module re-exports these existing contracts; authentication,
consent decisions and commercial lifecycle transitions stay in their owners.
"""

from __future__ import annotations

from typing import Literal, TypedDict

from pydantic import BaseModel, ConfigDict, Field


class DeveloperConsentStatusResponse(BaseModel):
    status: str = Field(..., min_length=1, max_length=64)
    user_id: str = Field(..., min_length=1, max_length=128)
    scope: str | None = Field(default=None, max_length=200)
    requested_scope: str | None = Field(default=None, max_length=200)
    granted_scope: str | None = Field(default=None, max_length=200)
    coverage_kind: str | None = Field(default=None, max_length=64)
    covered_by_existing_grant: bool = False
    request_id: str | None = Field(default=None, max_length=128)
    consent_token: str | None = Field(default=None, max_length=2048)
    expires_at: int | None = None
    export_revision: int | None = None
    export_generated_at: str | None = Field(default=None, max_length=64)
    export_refresh_status: str | None = Field(default=None, max_length=64)
    poll_timeout_at: int | None = None
    approval_timeout_at: int | None = None
    approval_timeout_minutes: int | None = None
    expiry_hours: int | None = None
    is_scope_upgrade: bool | None = None
    existing_granted_scopes: list[str] | None = None
    additional_access_summary: str | None = Field(default=None, max_length=500)
    request_url: str | None = Field(default=None, max_length=2048)
    requester_label: str | None = Field(default=None, max_length=200)
    requester_image_url: str | None = Field(default=None, max_length=2048)
    reason: str | None = Field(default=None, max_length=1000)
    app_id: str | None = Field(default=None, max_length=128)
    app_display_name: str | None = Field(default=None, max_length=200)
    message: str = Field(..., min_length=1, max_length=2000)
    quote_ref: str | None = Field(default=None, max_length=64)
    price_cents: int | None = Field(default=None, ge=0, le=100_000)
    currency: Literal["usd"] | None = None
    consent_state: str | None = Field(default=None, max_length=32)
    payment_state: str | None = Field(default=None, max_length=32)
    access_state: str | None = Field(default=None, max_length=32)
    human_action_url: str | None = Field(default=None, max_length=2048)
    activates_at: int | None = None
    tariff_price_cents: int | None = Field(default=None, ge=0, le=100_000)
    tariff_base_duration_seconds: int | None = Field(default=None, ge=0)
    tariff_revision: int | None = Field(default=None, ge=0)
    paid_required: bool | None = None


class CoverageFields(TypedDict):
    requested_scope: str
    granted_scope: str | None
    coverage_kind: str | None
    covered_by_existing_grant: bool


class ExportFields(TypedDict):
    export_revision: int | None
    export_generated_at: str | None
    export_refresh_status: str | None


class DeveloperConsentOffer(BaseModel):
    """Optional negotiation metadata carried with the consent request.

    The bid is recorded and surfaced to the owner. Commercial tariffs and the
    owner-approved immutable quote determine the payable amount; the requester
    must confirm that exact quote through the authenticated human action flow.
    These caller-supplied fields never prove payment or authorize spending.
    """

    model_config = ConfigDict(extra="forbid")

    bid_amount: float = Field(..., gt=0, le=1_000_000)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    offer_summary: str | None = Field(default=None, max_length=500)
    # Compatibility correlation only; provider receipts settle commercial funding.
    settlement_ref: str | None = Field(default=None, max_length=128)


class DeveloperConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str = Field(..., min_length=1, max_length=128)
    scope: str = Field(..., min_length=1, max_length=200)
    reason: str | None = Field(default=None, max_length=1000)
    expiry_hours: int = 24
    approval_timeout_minutes: int = 24 * 60
    connector_public_key: str | None = Field(default=None, min_length=16)
    connector_key_id: str | None = Field(default=None, min_length=1, max_length=128)
    connector_wrapping_alg: str | None = Field(default=None, min_length=1, max_length=128)
    refresh_policy: Literal["snapshot", "continuous_until_expiry"] = "snapshot"
    offer: DeveloperConsentOffer | None = None


class DeveloperScopedExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str = Field(..., min_length=1, max_length=128)
    consent_token: str = Field(min_length=16, max_length=2048)
    expected_scope: str | None = Field(default=None, max_length=200)


class MCPScopedExportRequest(BaseModel):
    """App-bound export lookup used by the MCP projection layer only."""

    model_config = ConfigDict(extra="forbid")

    grant_ref: str = Field(..., pattern=r"^req_[a-f0-9]{28}$", max_length=32)
    expected_scope: str = Field(..., min_length=3, max_length=200)


class MCPConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_identifier: str = Field(..., min_length=1, max_length=320)
    scope: str = Field(..., min_length=3, max_length=200)
    purpose: str = Field(..., min_length=8, max_length=280)
    expiry_hours: int = Field(default=24, ge=24, le=2160)
    approval_timeout_minutes: int = Field(default=1440, ge=5, le=1440)
    refresh_policy: Literal["snapshot", "continuous_until_expiry"] = "snapshot"
    connector_public_key: str | None = Field(default=None, min_length=40, max_length=128)
    connector_key_id: str | None = Field(default=None, min_length=1, max_length=128)
    connector_wrapping_alg: str | None = Field(default=None, min_length=1, max_length=128)
    country_iso2: str | None = Field(default=None, min_length=2, max_length=2)
    country: str | None = Field(default=None, min_length=2, max_length=64)
    offer: DeveloperConsentOffer | None = None
