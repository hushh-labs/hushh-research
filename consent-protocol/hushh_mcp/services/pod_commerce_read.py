"""Bounded commercial metadata through the existing owner marketplace read door."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class CommerceMetadataUnavailable(RuntimeError):
    """Canonical financial records cannot currently be proved by this read port."""


class Metadata(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


class FreeReadiness(Metadata):
    requires_payment_provider: Literal[False]
    requires_owner_approval: Literal[True]
    tariff_controls_available: bool


class PlatformReadiness(Metadata):
    status: Literal["disabled", "unconfigured", "unverified", "ready"]
    reason_code: str | None = Field(max_length=100)
    verification_scope: Literal["configured_and_persisted"]


class SellerReadiness(Metadata):
    status: Literal["not_onboarded", "not_eligible", "eligible"]
    reason_code: str | None = Field(max_length=100)


class Capabilities(Metadata):
    set_free_tariff: bool
    set_paid_tariff: bool
    approve_paid_request: bool
    reserve_paid_purchase: bool
    start_funding: bool
    start_onboarding: bool


class Readiness(Metadata):
    schema_version: Literal[1]
    enabled: bool
    free: FreeReadiness
    platform: PlatformReadiness
    seller: SellerReadiness
    capabilities: Capabilities


class Earnings(Metadata):
    pendingCents: int
    withdrawableCents: int = Field(ge=0)
    debtCents: int = Field(ge=0)
    withdrawingCents: int = 0
    currency: Literal["usd"]


class CommerceSummary(Metadata):
    earnings: Earnings
    readiness: Readiness
    review_href: Literal["/one/profile/account"]


class Counterpart(Metadata):
    label: str = Field(max_length=160)


class Action(Metadata):
    label: str = Field(max_length=100)
    href: str = Field(max_length=512, pattern=r"^/one/(?:profile/account|consent\?)")


class ActivityItem(Metadata):
    id: str = Field(max_length=200)
    kind: Literal["sale", "purchase", "funding", "refund", "withdrawal"]
    status: str = Field(max_length=50)
    created_at: str = Field(max_length=50)
    request_id: str | None = Field(default=None, max_length=200)
    purchase_id: str | None = Field(default=None, max_length=200)
    counterpart: Counterpart | None = None
    scope_label: str | None = Field(default=None, max_length=512)
    machine_scope: str | None = Field(default=None, max_length=512)
    scope_handle: str | None = Field(default=None, max_length=256)
    gross_cents: int = Field(ge=0)
    amount_cents: int = Field(ge=0)
    direction: Literal["incoming", "outgoing"]
    processing_fee_micro_usd: int | None = None
    net_earnings_micro_usd: int | None = None
    refunded_cents: int | None = Field(default=None, ge=0)
    currency: Literal["USD"]
    activation_at: str | None = Field(default=None, max_length=50)
    expires_at: str | None = Field(default=None, max_length=50)
    matures_at: str | None = Field(default=None, max_length=50)
    fulfillment_deadline: str | None = Field(default=None, max_length=50)
    next_action: Action | None = None


class ActivityPage(Metadata):
    items: list[ActivityItem] = Field(max_length=25)
    next_cursor: str | None = Field(max_length=2048)


def project_commerce_metadata(raw: Any, operation: str) -> dict[str, Any]:
    if operation not in {"commerce_summary", "commerce_activity"}:
        raise ValueError("Unknown commercial read operation")
    model = CommerceSummary if operation == "commerce_summary" else ActivityPage
    return {"operation": operation, "result": model.model_validate(raw).model_dump()}


async def read_commerce_metadata(owner_id, options, *, service=None):
    try:
        if service is None:
            from hushh_mcp.services.scope_commerce import ScopeCommerceService

            service = ScopeCommerceService()
        if options.operation == "commerce_summary":
            raw = {
                "earnings": await service.earnings(owner_user_id=owner_id),
                "readiness": await service.readiness(viewer_user_id=owner_id),
                "review_href": "/one/profile/account",
            }
        else:
            raw = await service.activity(
                viewer_user_id=owner_id, view=options.view, cursor=options.cursor, limit=25
            )
        return project_commerce_metadata(raw, options.operation)
    except PermissionError:
        raise
    except Exception:
        # Tool wrappers log messages. Preserve unavailable rather than inventing
        # a zero balance or exposing storage/validation diagnostics to the model.
        raise CommerceMetadataUnavailable("Canonical commerce metadata is unavailable") from None


class CommercialMetadataReads:
    """Shared runtime facade; pods replace this same read port at ingress."""

    async def scope_commerce_summary(self, *, user_id: str) -> dict:
        from hushh_mcp.services.pod_marketplace_read import MarketplaceReadOptions

        options = MarketplaceReadOptions(operation="commerce_summary")
        return (await read_commerce_metadata(user_id, options))["result"]

    async def scope_commerce_activity(self, *, user_id: str, view: str, cursor: str | None) -> dict:
        from hushh_mcp.services.pod_marketplace_read import MarketplaceReadOptions

        options = MarketplaceReadOptions(operation="commerce_activity", view=view, cursor=cursor)
        return (await read_commerce_metadata(user_id, options))["result"]
