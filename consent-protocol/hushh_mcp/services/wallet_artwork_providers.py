"""Licensed feed interchange, not a fabricated bank or network API.

No vendor agreement is bundled. An operator must configure a reviewed source
implementing the documented Hushh feed contract before enabling its adapter.
Owner lookups use imported metadata locally and disclose no IIN to a provider.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Protocol
from urllib.parse import urlsplit

import httpx
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    field_validator,
    model_validator,
)

from hushh_mcp.runtime_settings import (
    wallet_artwork_provider_credential,
    wallet_artwork_provider_settings,
)
from hushh_mcp.services.mcp_public_http import create_public_mcp_http_client, validate_mcp_endpoint
from hushh_mcp.services.wallet_artwork_catalog import (
    ArtworkCatalog,
    ArtworkMetadataBinding,
    ProviderMatch,
)
from hushh_mcp.services.wallet_artwork_images import MAX_SOURCE_BYTES


class ProviderUnavailable(ValueError):
    def __init__(self):
        super().__init__("artwork_provider_unavailable")


class ProviderGrant(BaseModel):
    """Deployment-owned approval. Provider responses cannot create this grant."""

    model_config = ConfigDict(extra="forbid")
    provider_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    adapter: Literal["approved_feed_v1"]
    manifest_url: str = Field(max_length=2048)
    asset_base_url: str = Field(max_length=2048)
    asset_requires_auth: bool = Field(default=False, strict=True)
    agreement_reference: str = Field(min_length=1, max_length=500)
    blank_artwork_review_reference: str = Field(min_length=1, max_length=500)
    approved_by: str = Field(min_length=1, max_length=100)
    approved_at: AwareDatetime
    rights_policy: Literal["perpetual_private_display"]
    audience: Literal["all_authenticated_wallet_owners"]
    metadata_stripping_allowed: Literal[True]
    timeout_seconds: float = Field(default=5, ge=1, le=15)
    approval_max_age_seconds: int = Field(default=3600, ge=60, le=86400)
    countries: list[str] = Field(min_length=1, max_length=250)
    networks: list[str] = Field(min_length=1, max_length=32)

    @field_validator("metadata_stripping_allowed", mode="before")
    @classmethod
    def explicit_transformation_permission(cls, value):
        if value is not True:
            raise ValueError("metadata_stripping_permission_required")
        return value

    @field_validator("manifest_url", "asset_base_url")
    @classmethod
    def fixed_destination(cls, value: str) -> str:
        validate_mcp_endpoint(value)
        path = urlsplit(value).path
        if "%" in path or "//" in path or any(part in {".", ".."} for part in path.split("/")):
            raise ValueError("artwork_destination_invalid")
        return value

    @field_validator("agreement_reference", "blank_artwork_review_reference", "approved_by")
    @classmethod
    def completed_review(cls, value: str) -> str:
        if not value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("artwork_approval_invalid")
        return value.strip()

    @model_validator(mode="after")
    def permitted_policy(self):
        from hushh_mcp.services.wallet_card_validation import NETWORK_ORDER

        if (
            self.approved_at > datetime.now(timezone.utc)
            or not self.asset_base_url.endswith("/")
            or (
                self.asset_requires_auth
                and _origin(self.manifest_url) != _origin(self.asset_base_url)
            )
            or any(
                len(country) != 2 or not country.isascii() or not country.isupper()
                for country in self.countries
            )
            or any(network not in NETWORK_ORDER or network == "other" for network in self.networks)
        ):
            raise ValueError("artwork_approval_invalid")
        return self


class ProviderRegistry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["hushh.wallet.artwork.providers.v1"]
    providers: list[ProviderGrant] = Field(max_length=20)


def grant_digest(grant: ProviderGrant) -> str:
    """Policy replacement never inherits a previous source's approval."""
    import json

    return hashlib.sha256(
        json.dumps(grant.model_dump(mode="json"), sort_keys=True).encode()
    ).hexdigest()


def active_provider_grants() -> dict[str, ProviderGrant]:
    enabled, configured = wallet_artwork_provider_settings()
    if not enabled or not configured:
        return {}
    try:
        with Path(configured).open("rb") as stream:
            data = stream.read(64 * 1024 + 1)
        if len(data) > 64 * 1024:
            return {}
        registry = ProviderRegistry.model_validate_json(data)
        grants = {grant.provider_id: grant for grant in registry.providers}
        return grants if len(grants) == len(registry.providers) else {}
    except (OSError, ValueError):
        return {}


class FeedArtwork(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_asset_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    artwork_version: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    issuer_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    product_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    variant_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    issuer_name: str = Field(min_length=1, max_length=100)
    product_name: str = Field(min_length=1, max_length=100)
    variant_name: str = Field(min_length=1, max_length=100)
    family: str = Field(min_length=1, max_length=100)
    country: str = Field(pattern=r"^[A-Z]{2}$")
    network: str = Field(min_length=1, max_length=32)
    iin_prefixes: list[str] = Field(max_length=1000)
    source_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    mime: Literal["image/png", "image/jpeg", "image/webp"]
    status: Literal["approved", "revoked", "pending"]
    issuer_approval_reference: str = Field(min_length=1, max_length=500)
    rights_policy: Literal["perpetual_private_display"]
    blank_artwork: Literal[True]
    allow_overlay: bool = Field(default=False, strict=True)
    selectable: bool = Field(default=True, strict=True)

    @field_validator(
        "issuer_approval_reference", "issuer_name", "product_name", "variant_name", "family"
    )
    @classmethod
    def reviewed_reference(cls, value: str) -> str:
        if not value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("artwork_approval_invalid")
        return value.strip()

    @field_validator("blank_artwork", mode="before")
    @classmethod
    def explicit_blank_attestation(cls, value):
        if value is not True:
            raise ValueError("blank_artwork_required")
        return value


class FeedMetadata(ProviderMatch):
    network: str = Field(min_length=1, max_length=32)
    iin_prefixes: list[str] = Field(min_length=1, max_length=1000)
    pan_lengths: list[StrictInt] = Field(min_length=1, max_length=7)


class ArtworkFeed(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["hushh.wallet.artwork.feed.v1"]
    provider_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    revision: int = Field(ge=1, strict=True)
    complete: Literal[True]
    published_at: AwareDatetime
    valid_until: AwareDatetime
    artworks: list[FeedArtwork] = Field(max_length=256)
    metadata: list[FeedMetadata] = Field(max_length=2000)

    @field_validator("complete", mode="before")
    @classmethod
    def explicit_complete_snapshot(cls, value):
        if value is not True:
            raise ValueError("complete_snapshot_required")
        return value

    @model_validator(mode="after")
    def unique_assets(self):
        keys = {(asset.source_asset_id, asset.artwork_version) for asset in self.artworks}
        if len(keys) != len(self.artworks):
            raise ValueError("duplicate_provider_asset")
        return self


class ArtworkProvider(Protocol):
    grant: ProviderGrant

    async def snapshot(self) -> ArtworkFeed: ...
    async def image(self, artwork: FeedArtwork) -> bytes: ...


def _origin(url: str) -> tuple[str, str | None, int]:
    parsed = urlsplit(url)
    return parsed.scheme, parsed.hostname, parsed.port or 443


class ApprovedFeedArtworkProvider:
    """Real HTTPS adapter for the Hushh licensed-feed interchange contract."""

    def __init__(self, grant: ProviderGrant):
        self.grant = grant

    async def _read(self, url: str, *, authenticated: bool, limit: int) -> bytes:
        try:
            validate_mcp_endpoint(url)
            allowed = (url == self.grant.manifest_url) or url.startswith(self.grant.asset_base_url)
            if not allowed or _origin(url) not in {
                _origin(self.grant.manifest_url),
                _origin(self.grant.asset_base_url),
            }:
                raise ProviderUnavailable()
            headers = {"Accept-Encoding": "identity", "User-Agent": "Hushh-Approved-Artwork/1"}
            if authenticated:
                if _origin(url) != _origin(self.grant.manifest_url):
                    raise ProviderUnavailable()
                headers["Authorization"] = (
                    f"Bearer {wallet_artwork_provider_credential(self.grant.provider_id)}"
                )
            async with create_public_mcp_http_client(
                headers, httpx.Timeout(self.grant.timeout_seconds), max_response_bytes=limit
            ) as client:
                response = await client.get(url)
                if response.status_code != 200 or len(response.content) > limit:
                    raise ProviderUnavailable()
                return response.content
        except Exception:
            # Includes auth/rate-limit/timeout/transport/schema errors; never echo
            # URLs, response bodies, credentials or provider exception details.
            raise ProviderUnavailable() from None

    async def snapshot(self) -> ArtworkFeed:
        data = await self._read(self.grant.manifest_url, authenticated=True, limit=4_000_000)
        try:
            feed = ArtworkFeed.model_validate_json(data)
            now = datetime.now(timezone.utc)
            if (
                feed.provider_id != self.grant.provider_id
                or not feed.published_at <= now < feed.valid_until
                or (feed.valid_until - feed.published_at).total_seconds()
                > self.grant.approval_max_age_seconds
                or any(
                    asset.network not in self.grant.networks
                    or asset.country not in self.grant.countries
                    for asset in feed.artworks
                )
                or any(
                    row.network not in self.grant.networks
                    or (row.country and row.country not in self.grant.countries)
                    for row in feed.metadata
                )
            ):
                raise ProviderUnavailable()
            # Reuse the canonical prefix/length schema before any publication.
            for row in feed.metadata:
                ArtworkMetadataBinding(
                    **row.model_dump(),
                    provider_id=feed.provider_id,
                    valid_until=feed.valid_until,
                    grant_digest=grant_digest(self.grant),
                )
            if any(
                any(
                    not prefix.isascii() or not prefix.isdigit() or len(prefix) not in (6, 8)
                    for prefix in asset.iin_prefixes
                )
                for asset in feed.artworks
            ):
                raise ProviderUnavailable()
            return feed
        except Exception:
            raise ProviderUnavailable() from None

    async def image(self, artwork: FeedArtwork) -> bytes:
        extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[artwork.mime]
        data = await self._read(
            self.grant.asset_base_url + artwork.source_digest + extension,
            authenticated=self.grant.asset_requires_auth,
            limit=MAX_SOURCE_BYTES,
        )
        if hashlib.sha256(data).hexdigest() != artwork.source_digest:
            raise ProviderUnavailable()
        return data


def configured_artwork_providers() -> dict[str, ArtworkProvider]:
    return {
        key: ApprovedFeedArtworkProvider(grant) for key, grant in active_provider_grants().items()
    }


class ImportedMetadataProvider:
    def __init__(self, bindings: list[ArtworkMetadataBinding]):
        self.bindings = bindings

    def identify(self, *, iin_prefix: str, pan_length: int, network: str) -> ProviderMatch | None:
        rows = [
            row
            for row in self.bindings
            if row.network == network
            and pan_length in row.pan_lengths
            and any(iin_prefix.startswith(prefix) for prefix in row.iin_prefixes)
        ]
        if not rows or len({row.issuer_id for row in rows}) != 1:
            return None
        # Conflicting licensed evidence is uncertainty, not majority voting.
        values = {}
        for name in ProviderMatch.model_fields:
            if name == "evidence_provider_ids":
                continue
            candidates = {getattr(row, name) for row in rows}
            values[name] = (
                next(iter(candidates))
                if len(candidates) == 1
                else False
                if name.endswith("_verified")
                else None
            )
        values["product_verified"] = all(row.product_verified for row in rows) and bool(
            values["product_id"]
        )
        values["variant_verified"] = bool(
            values["product_verified"]
            and all(row.variant_verified for row in rows)
            and values["variant_id"]
            and values["artwork_version"]
        )
        if values["product_verified"]:
            values["evidence_reference"] = (
                "approved-imported-evidence:"
                + hashlib.sha256(
                    "\n".join(sorted(row.evidence_reference or "" for row in rows)).encode()
                ).hexdigest()
            )
        values["evidence_provider_ids"] = sorted({row.provider_id for row in rows})
        return ProviderMatch.model_validate(values)


def catalog_metadata_provider(catalog: ArtworkCatalog) -> ImportedMetadataProvider | None:
    grants, now = active_provider_grants(), datetime.now(timezone.utc)
    rows = [
        row
        for row in catalog.metadata_bindings
        if row.provider_id in grants
        and row.grant_digest == grant_digest(grants[row.provider_id])
        and row.network in grants[row.provider_id].networks
        and (not row.country or row.country in grants[row.provider_id].countries)
        and row.valid_until > now
        and catalog.provider_states.get(row.provider_id)
        and catalog.provider_states[row.provider_id].complete
    ]
    return ImportedMetadataProvider(rows) if rows else None
