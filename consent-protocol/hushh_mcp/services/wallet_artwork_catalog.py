"""Approved, versioned card artwork. Network/IIN never proves a card design.

No issuer provider is configured by this release. Deployments may mount a reviewed
catalog with licensed, sanitized raster assets; requests never contact third parties.
An authorized provider adapter must implement MetadataProvider before activation.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Protocol

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator


class ProviderMatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    issuer_id: str
    product_id: str | None = None
    variant_id: str | None = None
    issuer_name: str | None = Field(default=None, min_length=1, max_length=100)
    country: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    product_family: str | None = Field(default=None, min_length=1, max_length=100)
    card_type: Literal["credit", "debit", "prepaid"] | None = None
    tier: str | None = Field(default=None, min_length=1, max_length=100)
    # Proof from a licensed product registry, not inferred from the IIN/network.
    product_verified: bool = False


class MetadataProvider(Protocol):
    def identify(
        self, *, iin_prefix: str, pan_length: int, network: str
    ) -> ProviderMatch | None: ...


class ArtworkAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    issuer_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    product_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    family: str = Field(min_length=1, max_length=100)
    variant_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    label: str = Field(min_length=1, max_length=100)
    country: str = Field(pattern=r"^[A-Z]{2}$")
    network: str = Field(max_length=32)
    iin_prefixes: list[str] = Field(max_length=1000)
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    mime: Literal["image/png", "image/jpeg", "image/webp"]
    rights_reference: str = Field(min_length=1, max_length=500)
    provenance: str = Field(min_length=1, max_length=500)
    approved_by: str = Field(min_length=1, max_length=100)
    approved_at: AwareDatetime
    # Time-limited and revocable-storage licenses are deliberately unsupported.
    # This is an explicit reviewed right to a durable, private display copy.
    rights_policy: Literal["perpetual_private_display"]
    status: Literal["approved", "revoked", "pending"]
    allow_overlay: bool = False
    sanitized: bool = False

    @field_validator("rights_reference", "provenance", "approved_by", "label", "family")
    @classmethod
    def meaningful_text(cls, value: str) -> str:
        if not value.strip() or any(ord(char) < 32 for char in value):
            raise ValueError("invalid_approval")
        return value.strip()

    @field_validator("approved_at")
    @classmethod
    def completed_approval(cls, value: datetime) -> datetime:
        if value > datetime.now(timezone.utc):
            raise ValueError("future_approval")
        return value


class ArtworkCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    assets: list[ArtworkAsset] = Field(max_length=10000)


def load_catalog() -> tuple[ArtworkCatalog, Path | None]:
    configured = os.getenv("HUSHH_WALLET_ARTWORK_CATALOG_PATH", "").strip()
    if not configured:
        return ArtworkCatalog(version="empty-1", assets=[]), None
    path = Path(configured).resolve(strict=True)
    if path.stat().st_size > 4_000_000:
        raise ValueError("catalog_too_large")
    catalog = ArtworkCatalog.model_validate(json.loads(path.read_text(encoding="utf-8")))
    if len({asset.asset_id for asset in catalog.assets}) != len(catalog.assets):
        raise ValueError("duplicate_asset")
    return catalog, path.parent / "assets"


def approved_assets(catalog: ArtworkCatalog) -> list[ArtworkAsset]:
    return [
        asset
        for asset in catalog.assets
        if asset.status == "approved"
        and asset.sanitized
        and all(prefix.isdigit() and len(prefix) in (6, 8) for prefix in asset.iin_prefixes)
    ]


def resolve_artwork(
    iin_prefix: str,
    pan_length: int,
    network: str,
    *,
    provider: MetadataProvider | None = None,
    catalog: ArtworkCatalog | None = None,
) -> dict:
    if (
        not iin_prefix.isascii()
        or not iin_prefix.isdigit()
        or len(iin_prefix) not in (6, 8)
        or not 13 <= pan_length <= 19
    ):
        raise ValueError("invalid_iin")
    catalog = catalog or load_catalog()[0]
    match = None
    provider_state = "unconfigured"
    if provider:
        try:
            match = provider.identify(iin_prefix=iin_prefix, pan_length=pan_length, network=network)
            provider_state = "configured"
        except Exception:
            provider_state = "unavailable"
    candidates = [
        asset
        for asset in approved_assets(catalog)
        if asset.network == network
        and (
            asset.issuer_id == match.issuer_id
            if match
            else any(iin_prefix.startswith(prefix) for prefix in asset.iin_prefixes)
        )
    ]
    issuer_ids = {asset.issuer_id for asset in candidates}
    exact = [
        asset
        for asset in candidates
        if match
        and match.product_verified
        and match.product_id == asset.product_id
        and match.variant_id == asset.variant_id
    ]
    variants = exact if len(exact) == 1 else candidates
    countries = {asset.country for asset in candidates}
    return {
        "catalogVersion": catalog.version,
        "provider": provider_state,
        "match": "exact"
        if len(exact) == 1
        else "ambiguous"
        if len(candidates) > 1
        else "issuer_only"
        if candidates or match
        else "unknown",
        "issuerId": match.issuer_id
        if match
        else next(iter(issuer_ids))
        if len(issuer_ids) == 1
        else None,
        "metadata": {
            "issuerName": match.issuer_name if match else None,
            "country": match.country
            if match and match.country
            else next(iter(countries))
            if len(countries) == 1
            else None,
            "productFamily": match.product_family
            if match and match.product_verified
            else exact[0].family
            if len(exact) == 1
            else None,
            "cardType": match.card_type if match else None,
            "tier": match.tier if match else None,
        },
        "variants": [
            {
                "assetId": asset.asset_id,
                "issuerId": asset.issuer_id,
                "productId": asset.product_id,
                "variantId": asset.variant_id,
                "label": asset.label,
                "digest": asset.digest,
                "allowOverlay": asset.allow_overlay,
                "image": f"/api/one/wallet/card-access/artwork/assets/{asset.digest}",
            }
            for asset in variants[:30]
        ],
    }


def read_asset(digest: str) -> tuple[bytes, str]:
    catalog, root = load_catalog()
    asset = next((asset for asset in approved_assets(catalog) if asset.digest == digest), None)
    if not root or not asset:
        raise FileNotFoundError("asset_unavailable")
    extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[asset.mime]
    path = (root / (digest + extension)).resolve(strict=True)
    if path.parent != root.resolve() or path.stat().st_size > 512 * 1024:
        raise ValueError("invalid_asset")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("invalid_asset_digest")
    return data, asset.mime


def validate_artwork_selections(selections: list[dict]) -> list[dict]:
    catalog = load_catalog()[0]
    assets = {asset.asset_id: asset for asset in approved_assets(catalog)}
    results = []
    for selection in selections:
        asset = assets.get(selection["assetId"])
        approved = bool(
            asset
            and selection["catalogVersion"] == catalog.version
            and selection["digest"] == asset.digest
            and selection["issuerId"] == asset.issuer_id
            and selection["productId"] == asset.product_id
            and selection["variantId"] == asset.variant_id
        )
        results.append(
            {
                "assetId": selection["assetId"],
                "approved": approved,
                "allowOverlay": asset.allow_overlay if approved else False,
            }
        )
    return results
