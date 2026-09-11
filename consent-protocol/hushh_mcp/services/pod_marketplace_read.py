"""Bounded marketplace metadata projections for the existing pod read broker.

The shared Information agent still owns reasoning and tools. This adapter only
reads owner publication metadata; mutations and raw PKM values are not exposed.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class MarketplaceReadOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["published", "publishable", "earnings"] = "published"
    topic: str | None = Field(default=None, max_length=160)
    power: str = Field(default="affluent", max_length=40)
    mood: str = Field(default="affinity", max_length=40)


class _Metadata(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True, allow_inf_nan=False)


class _Slice(_Metadata):
    domain: str = Field(max_length=160)
    domainTitle: str = Field(max_length=500)
    label: str = Field(max_length=500)
    scopeHandle: str | None = Field(default=None, max_length=500)
    attributeCount: int = Field(ge=0)


class _Published(_Slice):
    sensitivityTier: str | None = Field(default=None, max_length=80)
    scopeKind: str | None = Field(default=None, max_length=80)
    publicProfileHandle: str = Field(max_length=500)


class _Publishable(_Slice):
    topLevelScopePath: str | None = Field(default=None, max_length=500)
    suggestedPriceCents: int = Field(ge=0)
    currency: str = Field(max_length=8)


class _Math(_Metadata):
    floorDollars: float
    dataValueDollars: float
    buyerFit: float
    freshness: float
    exclusivity: float
    geo: float
    finalDollars: float


class _PricedSlice(_Metadata):
    label: str = Field(max_length=500)
    domainTitle: str = Field(max_length=500)
    suggestedPriceCents: int = Field(ge=0)
    currency: str = Field(max_length=8)
    math: _Math


class _Band(_Metadata):
    power: str = Field(max_length=40)
    mood: str = Field(max_length=40)


class _Earnings(_Metadata):
    sliceCount: int = Field(ge=0)
    pricedSliceCount: int = Field(ge=0)
    totalPotentialMonthlyCents: int = Field(ge=0)
    accruedCents: int = Field(ge=0)
    currency: str = Field(max_length=8)
    perSlice: list[_PricedSlice] = Field(max_length=100)
    formula: str = Field(max_length=2000)
    note: str = Field(max_length=2000)
    band: _Band
    pendingRequestCount: int = Field(ge=0)
    approvedBuyerCount: int = Field(ge=0)
    interestedBuyerCount: int = Field(ge=0)
    hasBuyers: bool
    hasPaymentRail: bool
    payoutsEnabled: bool


def project_marketplace_read(raw: Any, options: MarketplaceReadOptions) -> dict[str, Any]:
    if options.operation == "earnings":
        return {"result": _Earnings.model_validate(raw).model_dump()}
    if not isinstance(raw, list) or len(raw) > 100:
        raise ValueError("Marketplace metadata exceeds bounded read")
    model = _Published if options.operation == "published" else _Publishable
    return {"items": [model.model_validate(item).model_dump() for item in raw]}


async def read_marketplace_metadata(
    owner_id: str, options: MarketplaceReadOptions, *, service: Any = None
) -> dict[str, Any]:
    if service is None:
        from hushh_mcp.services.marketplace_information_service import MarketplaceInformationService

        service = MarketplaceInformationService(strict_reads=True)
    if options.operation == "published":
        call = service.list_published_slices(user_id=owner_id)
    elif options.operation == "publishable":
        call = service.list_publishable_slices(user_id=owner_id, topic=options.topic)
    else:
        call = service.earnings_summary(user_id=owner_id, power=options.power, mood=options.mood)
    raw = await asyncio.wait_for(call, timeout=15)
    return project_marketplace_read(raw, options)
