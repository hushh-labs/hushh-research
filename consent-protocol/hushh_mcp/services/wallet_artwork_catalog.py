"""Approved card artwork; network/IIN never proves an exact physical design.

Owner requests only consult the reviewed local snapshot. Authorized provider
synchronization is a separate, disabled-by-default operator operation.
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Protocol

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    field_validator,
    model_validator,
)

from hushh_mcp.services.wallet_artwork_images import MAX_ARTWORK_BYTES, inspect_artwork_image


class ProviderMatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    issuer_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    product_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._-]{1,100}$")
    variant_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._-]{1,100}$")
    issuer_name: str | None = Field(default=None, min_length=1, max_length=100)
    country: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    product_family: str | None = Field(default=None, min_length=1, max_length=100)
    card_type: Literal["credit", "debit", "prepaid"] | None = None
    tier: str | None = Field(default=None, min_length=1, max_length=100)
    # Proof from a licensed product registry, not inferred from the IIN/network.
    product_verified: bool = Field(default=False, strict=True)
    variant_verified: bool = Field(default=False, strict=True)
    artwork_version: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._-]{1,100}$")
    evidence_reference: str | None = Field(default=None, min_length=1, max_length=500)
    evidence_provider_ids: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("evidence_reference", "issuer_name", "product_family", "tier")
    @classmethod
    def meaningful_evidence(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("invalid_product_evidence")
        return value.strip()

    @model_validator(mode="after")
    def proof_is_independent(self):
        if self.product_verified and (not self.product_id or not self.evidence_reference):
            raise ValueError("product_evidence_required")
        if self.variant_verified and (
            not self.product_verified or not self.variant_id or not self.artwork_version
        ):
            raise ValueError("variant_evidence_required")
        return self


class MetadataProvider(Protocol):
    def identify(
        self, *, iin_prefix: str, pan_length: int, network: str
    ) -> ProviderMatch | None: ...


class ArtworkMetadataBinding(ProviderMatch):
    grant_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    provider_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    network: str = Field(min_length=1, max_length=32)
    iin_prefixes: list[str] = Field(min_length=1, max_length=1000)
    pan_lengths: list[StrictInt] = Field(min_length=1, max_length=7)
    valid_until: AwareDatetime

    @field_validator("iin_prefixes")
    @classmethod
    def permitted_prefixes(cls, values: list[str]) -> list[str]:
        if any(
            not value.isascii() or not value.isdigit() or len(value) not in (6, 8)
            for value in values
        ):
            raise ValueError("invalid_iin")
        return values

    @field_validator("pan_lengths")
    @classmethod
    def permitted_lengths(cls, values: list[int]) -> list[int]:
        if any(type(value) is not int or not 13 <= value <= 19 for value in values):
            raise ValueError("invalid_pan_length")
        return values


class ArtworkProviderState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    manifest_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    grant_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    complete: bool
    synchronized_at: AwareDatetime


class ArtworkAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    issuer_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    # Explicit cosmetic bank-design browsing, never physical-product evidence.
    bank_design: bool = False
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
    provider_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._-]{1,100}$")
    grant_digest: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    source_asset_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._-]{1,100}$")
    artwork_version: str = Field(default="1", pattern=r"^[A-Za-z0-9._-]{1,100}$")
    source_digest: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    issuer_approval_reference: str | None = Field(default=None, min_length=1, max_length=500)
    issuer_name: str | None = Field(default=None, min_length=1, max_length=100)
    product_name: str | None = Field(default=None, min_length=1, max_length=100)
    variant_name: str | None = Field(default=None, min_length=1, max_length=100)
    width: int | None = Field(default=None, ge=1, le=2048)
    height: int | None = Field(default=None, ge=1, le=2048)
    approved_until: AwareDatetime | None = None
    selectable: bool = True
    # Explicit reviewed local-art revision, never inferred from bank/network.
    replacement_asset_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._-]{1,100}$")

    @model_validator(mode="after")
    def imported_asset_requires_review(self):
        if self.provider_id and not all(
            (
                self.source_asset_id,
                self.grant_digest,
                self.source_digest,
                self.issuer_approval_reference,
                self.width,
                self.height,
                self.approved_until,
            )
        ):
            raise ValueError("provider_approval_required")
        return self

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
    metadata_bindings: list[ArtworkMetadataBinding] = Field(default_factory=list, max_length=10000)
    provider_states: dict[str, ArtworkProviderState] = Field(default_factory=dict, max_length=20)

    @model_validator(mode="after")
    def reviewed_replacements(self):
        assets = {asset.asset_id: asset for asset in self.assets}
        for source in self.assets:
            if not source.replacement_asset_id:
                continue
            target = assets.get(source.replacement_asset_id)
            if (
                not target
                or target is source
                or source.selectable
                or target.replacement_asset_id
                or source.provider_id is not None
                or target.provider_id is not None
                or not source.bank_design
                or not target.bank_design
                or source.digest == target.digest
                or any(
                    getattr(source, field) != getattr(target, field)
                    for field in ("issuer_id", "product_id", "variant_id", "network", "country")
                )
            ):
                raise ValueError("invalid_artwork_replacement")
        return self


def load_catalog(
    *, path: Path | None = None, missing_ok: bool = False
) -> tuple[ArtworkCatalog, Path | None]:
    configured = (
        str(path)
        if path is not None
        else os.getenv("HUSHH_WALLET_ARTWORK_CATALOG_PATH", "").strip()
    )
    path = (
        Path(configured)
        if configured
        else Path(__file__).parents[1] / "resources" / "wallet-artwork" / "catalog.json"
    ).resolve()
    if missing_ok and not path.exists():
        return ArtworkCatalog(version="empty-1", assets=[]), path.parent / "assets"
    if path.stat().st_size > 4_000_000:
        raise ValueError("catalog_too_large")
    with path.open("rb") as stream:
        contents = stream.read(4_000_001)
    if len(contents) > 4_000_000:
        raise ValueError("catalog_too_large")
    catalog = ArtworkCatalog.model_validate_json(contents)
    if len({asset.asset_id for asset in catalog.assets}) != len(catalog.assets):
        raise ValueError("duplicate_asset")
    return catalog, path.parent / "assets"


def approved_assets(catalog: ArtworkCatalog) -> list[ArtworkAsset]:
    from hushh_mcp.services.wallet_artwork_providers import active_provider_grants, grant_digest

    grants = active_provider_grants()
    now = datetime.now(timezone.utc)
    return [
        asset
        for asset in catalog.assets
        if asset.status == "approved"
        and asset.sanitized
        and (asset.approved_until is None or asset.approved_until > now)
        and (
            asset.provider_id is None
            or (
                asset.provider_id in grants
                and asset.grant_digest == grant_digest(grants[asset.provider_id])
                and asset.network in grants[asset.provider_id].networks
                and asset.country in grants[asset.provider_id].countries
            )
        )
        and all(prefix.isdigit() and len(prefix) in (6, 8) for prefix in asset.iin_prefixes)
    ]


def artwork_variant(asset: ArtworkAsset) -> dict:
    return {
        "assetId": asset.asset_id,
        "issuerId": asset.issuer_id,
        "productId": asset.product_id,
        "variantId": asset.variant_id,
        "label": asset.label,
        "digest": asset.digest,
        "allowOverlay": asset.allow_overlay,
        "image": f"/api/one/wallet/card-access/artwork/assets/{asset.digest}",
        "issuerName": asset.issuer_name,
        "productName": asset.product_name or asset.family,
        "variantName": asset.variant_name or asset.label,
        "country": asset.country,
        "providerId": asset.provider_id,
        "artworkVersion": asset.artwork_version,
        "width": asset.width,
        "height": asset.height,
    }


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
    if provider is None:
        from hushh_mcp.services.wallet_artwork_providers import catalog_metadata_provider

        provider = catalog_metadata_provider(catalog)
    if provider:
        try:
            raw_match = provider.identify(
                iin_prefix=iin_prefix, pan_length=pan_length, network=network
            )
            match = ProviderMatch.model_validate(raw_match) if raw_match is not None else None
            provider_state = "configured"
        except Exception:
            provider_state = "unavailable"
    candidates = [
        asset
        for asset in approved_assets(catalog)
        if asset.network == network
        and asset.selectable
        and selection_ready(catalog, asset)
        and (
            not asset.iin_prefixes
            or any(iin_prefix.startswith(prefix) for prefix in asset.iin_prefixes)
        )
        and (
            not match
            or not match.evidence_provider_ids
            or asset.provider_id in match.evidence_provider_ids
        )
        and (
            asset.issuer_id == match.issuer_id
            and (not match.country or asset.country == match.country)
            and (not match.product_verified or asset.product_id == match.product_id)
            and (
                not match.variant_verified
                or (
                    asset.variant_id == match.variant_id
                    and asset.artwork_version == match.artwork_version
                )
            )
            if match
            else any(iin_prefix.startswith(prefix) for prefix in asset.iin_prefixes)
        )
    ]
    issuer_ids = {asset.issuer_id for asset in candidates}
    exact = [
        asset
        for asset in candidates
        if not asset.bank_design
        and match
        and match.product_verified
        and match.variant_verified
        and match.product_id == asset.product_id
        and match.variant_id == asset.variant_id
        and match.artwork_version == asset.artwork_version
        and (asset.provider_id is None or asset.provider_id in match.evidence_provider_ids)
    ]
    variants = exact if len(exact) == 1 else candidates
    countries = {asset.country for asset in candidates}
    return {
        "catalogVersion": catalog.version,
        "provider": provider_state,
        "match": "exact"
        if len(exact) == 1
        else "ambiguous"
        if len(candidates) > 1 or (candidates and match and match.product_verified)
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
        "identification": "variant"
        if len(exact) == 1
        else "product"
        if match and match.product_verified
        else "product_family"
        if match and match.product_family
        else "issuer"
        if candidates or match
        else "network",
        "variants": [artwork_variant(asset) for asset in variants[:30]],
    }


def read_asset(digest: str) -> tuple[bytes, str]:
    catalog, root = load_catalog()
    asset = next((asset for asset in approved_assets(catalog) if asset.digest == digest), None)
    if not root or not asset:
        raise FileNotFoundError("asset_unavailable")
    extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[asset.mime]
    path = (root / (digest + extension)).resolve(strict=True)
    if path.parent != root.resolve() or path.stat().st_size > MAX_ARTWORK_BYTES:
        raise ValueError("invalid_asset")
    with path.open("rb") as stream:
        data = stream.read(MAX_ARTWORK_BYTES + 1)
    if len(data) > MAX_ARTWORK_BYTES:
        raise ValueError("invalid_asset")
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("invalid_asset_digest")
    inspect_artwork_image(data, asset.mime)
    return data, asset.mime


def selection_ready(catalog: ArtworkCatalog, asset: ArtworkAsset) -> bool:
    """A partially synchronized source cannot authorize a new owner choice."""
    if asset.provider_id is None:
        return True
    state = catalog.provider_states.get(asset.provider_id)
    return bool(state and state.complete)


def validate_artwork_selections(
    selections: list[dict], *, purpose: Literal["selection", "saved"] = "selection"
) -> list[dict]:
    catalog = load_catalog()[0]
    assets = {asset.asset_id: asset for asset in approved_assets(catalog)}
    results = []
    for selection in selections:
        asset = assets.get(selection["assetId"])
        approved = bool(
            asset
            and (
                purpose == "saved"
                or (
                    asset.selectable
                    and selection_ready(catalog, asset)
                    and selection["catalogVersion"] == catalog.version
                )
            )
            and selection["digest"] == asset.digest
            and selection["issuerId"] == asset.issuer_id
            and selection["productId"] == asset.product_id
            and selection["variantId"] == asset.variant_id
        )
        result = {
            "assetId": selection["assetId"],
            "approved": approved,
            "allowOverlay": asset.allow_overlay if approved else False,
        }
        if approved and purpose == "saved" and asset.replacement_asset_id:
            replacement = assets.get(asset.replacement_asset_id)
            if replacement and replacement.selectable and selection_ready(catalog, replacement):
                result["replacement"] = {
                    "catalogVersion": catalog.version,
                    "variant": artwork_variant(replacement),
                }
            else:
                result.update(approved=False, allowOverlay=False)
        results.append(result)
    return results
