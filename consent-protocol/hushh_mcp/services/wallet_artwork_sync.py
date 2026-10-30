"""Operator-only publication to the existing private, mounted artwork catalog.

Immutable raster files are staged first; os.replace publishes a complete JSON
snapshot last. The OS lock and provider revision ledger fence concurrent/stale
writers. Production writers/readers must share a supported persistent filesystem.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from hushh_mcp.services.wallet_artwork_catalog import (
    ArtworkAsset,
    ArtworkCatalog,
    ArtworkMetadataBinding,
    ArtworkProviderState,
    load_catalog,
)
from hushh_mcp.services.wallet_artwork_images import sanitize_approved_artwork
from hushh_mcp.services.wallet_artwork_providers import ArtworkFeed, ArtworkProvider, grant_digest


def _asset_id(provider_id: str, source_id: str, version: str) -> str:
    return (
        "provider-" + hashlib.sha256(f"{provider_id}\n{source_id}\n{version}".encode()).hexdigest()
    )


@contextmanager
def _writer_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (path.parent / (path.name + ".lock")).open("a+b") as lock:
        if lock.tell() == 0:
            lock.write(b"\0")
            lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError("artwork_writer_busy") from None
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _atomic_write(path: Path, data: bytes):
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix=".artwork-", delete=False
        ) as stream:
            temporary = stream.name
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def _publish(path: Path, catalog: ArtworkCatalog):
    payload = catalog.model_dump(mode="json", exclude_none=True)
    payload.pop("version")
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    catalog.version = "catalog-" + hashlib.sha256(canonical).hexdigest()
    encoded = catalog.model_dump_json(exclude_none=True).encode()
    if len(encoded) > 4_000_000:
        raise ValueError("catalog_too_large")
    _atomic_write(path, encoded)


def _check_revision(catalog: ArtworkCatalog, feed: ArtworkFeed, digest: str, policy: str) -> bool:
    state = catalog.provider_states.get(feed.provider_id)
    if state and (
        state.revision > feed.revision
        or (state.revision == feed.revision and state.manifest_digest != digest)
    ):
        raise ValueError("stale_provider_revision")
    return bool(
        state
        and state.revision == feed.revision
        and state.complete
        and state.grant_digest == policy
    )


def _revocation_snapshot(
    catalog: ArtworkCatalog, feed: ArtworkFeed, digest: str, policy: str
) -> ArtworkCatalog:
    """Complete source snapshots revoke omitted entries; pending isn't approved."""
    declared = {
        _asset_id(feed.provider_id, row.source_asset_id, row.artwork_version): row
        for row in feed.artworks
    }
    assets = []
    for asset in catalog.assets:
        row = declared.get(asset.asset_id)
        revoked = asset.provider_id == feed.provider_id and (not row or row.status != "approved")
        assets.append(asset.model_copy(update={"status": "revoked"}) if revoked else asset)
    return catalog.model_copy(
        update={
            "assets": assets,
            "metadata_bindings": [
                row for row in catalog.metadata_bindings if row.provider_id != feed.provider_id
            ],
            "provider_states": {
                **catalog.provider_states,
                feed.provider_id: ArtworkProviderState(
                    revision=feed.revision,
                    manifest_digest=digest,
                    grant_digest=policy,
                    complete=False,
                    synchronized_at=datetime.now(timezone.utc),
                ),
            },
        }
    )


async def synchronize_artwork(
    provider: ArtworkProvider, catalog_path: Path, *, apply: bool = False
) -> dict:
    """Dry-run by default. Failed additions cannot roll back verified revocations."""
    async with asyncio.timeout(60):
        feed = await provider.snapshot()
        # Adapters cannot bypass the shared schema even when provided in-process.
        feed = ArtworkFeed.model_validate(feed.model_dump())
        grant, now = provider.grant, datetime.now(timezone.utc)
        if (
            feed.provider_id != grant.provider_id
            or not feed.published_at <= now < feed.valid_until
            or (feed.valid_until - feed.published_at).total_seconds()
            > grant.approval_max_age_seconds
            or any(
                row.network not in grant.networks or row.country not in grant.countries
                for row in feed.artworks
            )
        ):
            raise ValueError("artwork_feed_unapproved")
        for row in feed.metadata:
            if row.network not in grant.networks or (
                row.country and row.country not in grant.countries
            ):
                raise ValueError("artwork_feed_unapproved")
            ArtworkMetadataBinding(
                **row.model_dump(),
                provider_id=feed.provider_id,
                valid_until=feed.valid_until,
                grant_digest=grant_digest(grant),
            )
        digest = hashlib.sha256(feed.model_dump_json().encode()).hexdigest()
        policy = grant_digest(grant)
        path = catalog_path.resolve()
        previous = load_catalog(path=path, missing_ok=True)[0]
        if _check_revision(previous, feed, digest, policy):
            return {
                "applied": False,
                "unchanged": True,
                "approvedAssets": 0,
                "revocationsApplied": False,
            }
        if apply:
            with _writer_lock(path):
                previous = load_catalog(path=path, missing_ok=True)[0]
                if _check_revision(previous, feed, digest, policy):
                    return {
                        "applied": False,
                        "unchanged": True,
                        "approvedAssets": 0,
                        "revocationsApplied": False,
                    }
                state = previous.provider_states.get(feed.provider_id)
                if not state or state.revision != feed.revision or state.grant_digest != policy:
                    previous = _revocation_snapshot(previous, feed, digest, policy)
                    _publish(path, previous)
        else:
            previous = _revocation_snapshot(previous, feed, digest, policy)
        old = {asset.asset_id: asset for asset in previous.assets}
        imports: list[ArtworkAsset] = []
        transferred = 0
        root = path.parent / "assets"
        if apply:
            if root.is_symlink():
                raise ValueError("invalid_asset_root")
            root.mkdir(mode=0o700, exist_ok=True)
        for row in feed.artworks:
            if row.status != "approved":
                continue
            asset_id = _asset_id(feed.provider_id, row.source_asset_id, row.artwork_version)
            prior = old.get(asset_id)
            if prior and (
                prior.status == "revoked"
                or prior.source_digest != row.source_digest
                or prior.product_id != row.product_id
                or prior.variant_id != row.variant_id
                or prior.issuer_id != row.issuer_id
                or prior.country != row.country
                or prior.network != row.network
            ):
                raise ValueError("immutable_artwork_revision_changed")
            data = await provider.image(row)
            transferred += len(data)
            if (
                transferred > 64 * 1024 * 1024
                or hashlib.sha256(data).hexdigest() != row.source_digest
            ):
                raise ValueError("artwork_source_integrity")
            cleaned, width, height = await asyncio.to_thread(
                sanitize_approved_artwork, data, row.mime
            )
            asset_digest = hashlib.sha256(cleaned).hexdigest()
            asset = ArtworkAsset(
                asset_id=asset_id,
                issuer_id=row.issuer_id,
                product_id=row.product_id,
                variant_id=row.variant_id,
                family=row.family,
                label=row.variant_name,
                issuer_name=row.issuer_name,
                product_name=row.product_name,
                variant_name=row.variant_name,
                country=row.country,
                network=row.network,
                iin_prefixes=row.iin_prefixes,
                digest=asset_digest,
                mime="image/png",
                artwork_version=row.artwork_version,
                provider_id=feed.provider_id,
                grant_digest=grant_digest(grant),
                source_asset_id=row.source_asset_id,
                source_digest=row.source_digest,
                issuer_approval_reference=row.issuer_approval_reference,
                rights_reference=grant.agreement_reference,
                provenance=f"approved_feed_v1:{feed.provider_id}:{feed.revision}",
                approved_by=grant.approved_by,
                approved_at=grant.approved_at,
                rights_policy=grant.rights_policy,
                status="approved",
                sanitized=True,
                allow_overlay=row.allow_overlay,
                selectable=row.selectable,
                width=width,
                height=height,
                approved_until=feed.valid_until,
            )
            imports.append(asset)
            if apply:
                target = root / (asset_digest + ".png")
                if target.is_symlink():
                    raise ValueError("invalid_asset_path")
                _atomic_write(target, cleaned)
        bindings = [
            ArtworkMetadataBinding(
                **row.model_dump(),
                provider_id=feed.provider_id,
                valid_until=feed.valid_until,
                grant_digest=grant_digest(grant),
            )
            for row in feed.metadata
        ]
        if apply:
            with _writer_lock(path):
                current = load_catalog(path=path)[0]
                if _check_revision(current, feed, digest, policy):
                    return {
                        "applied": False,
                        "unchanged": True,
                        "approvedAssets": 0,
                        "revocationsApplied": True,
                    }
                by_id = {asset.asset_id: asset for asset in current.assets}
                for asset in imports:
                    prior = by_id.get(asset.asset_id)
                    if prior and prior.status == "revoked":
                        raise ValueError("revoked_artwork_revision")
                    by_id[asset.asset_id] = asset
                final = current.model_copy(
                    update={
                        "assets": sorted(by_id.values(), key=lambda row: row.asset_id),
                        "metadata_bindings": [
                            row
                            for row in current.metadata_bindings
                            if row.provider_id != feed.provider_id
                        ]
                        + bindings,
                        "provider_states": {
                            **current.provider_states,
                            feed.provider_id: ArtworkProviderState(
                                revision=feed.revision,
                                manifest_digest=digest,
                                grant_digest=policy,
                                complete=True,
                                synchronized_at=datetime.now(timezone.utc),
                            ),
                        },
                    }
                )
                # model_copy is deliberately followed by full aggregate admission.
                final = ArtworkCatalog.model_validate(final.model_dump())
                _publish(path, final)
        return {
            "applied": apply,
            "unchanged": False,
            "approvedAssets": len(imports),
            "revocationsApplied": apply,
        }
