"""Private ciphertext object port; no public URLs, content keys or plaintext.

The shared-runtime inventory owns this namespace. The GCS transport is reused
without activating the separate Files/pod schema or its authority.
"""

from __future__ import annotations

import asyncio
from typing import Protocol
from urllib.parse import quote

from hushh_mcp.services.document_delivery.contracts import DeliveryError, digest
from hushh_mcp.services.shared_files.bucket_admission import admission, observe
from hushh_mcp.services.shared_files.uploads import SharedCipherStore


class CipherObjects(Protocol):
    identity: str

    async def qualify(self) -> None: ...
    async def put(self, key: str, ciphertext: bytes) -> str: ...
    async def read(self, key: str, *, limit: int) -> tuple[bytes | None, str | None]: ...
    async def remove(self, key: str, generation: str | None) -> bool: ...
    async def initiate(self, key: str, size: int) -> str: ...
    async def send(self, session: str, key: str, ciphertext: bytes) -> str: ...
    async def session_terminal(self, session: str, key: str, size: int, observed_at) -> bool: ...


class PrivateGcsCipherObjects:
    def __init__(self, *, bucket: str, identity: str, store=None):
        self.bucket, self.identity = bucket, identity
        self.store = store or SharedCipherStore(bucket, prefix="document-delivery/v1")

    async def qualify(self) -> None:
        try:
            value = await observe(self.store, self.bucket)
            observed = admission(value, self.bucket)
            # This delivery release requires permanent-delete capability. A
            # retention/hold/versioning/soft-delete setup is not silently
            # accepted as immediate erasure support.
            soft = value.get("softDeletePolicy")
            if (
                digest(observed["identity"]) != self.identity
                or observed["noSoftDeleteHistory"] is not True
                or value.get("retentionPolicy") is not None
                or value.get("defaultEventBasedHold") is True
                or (value.get("versioning") or {}).get("enabled") is True
                or (soft is not None and soft.get("retentionDurationSeconds") != "0")
            ):
                raise ValueError
        except Exception:
            raise DeliveryError("delivery_storage_unqualified", 503) from None

    async def initiate(self, key: str, size: int) -> str:
        await self.qualify()
        uri = await self.store.initiate(key, size, "")
        if uri is None:
            raise DeliveryError("artifact_write_conflict")
        await self.qualify()
        return uri

    async def send(self, session: str, key: str, ciphertext: bytes) -> str:
        await self.qualify()
        generation = await self.store.send(session, key, ciphertext)
        if generation is None:
            raise DeliveryError("artifact_write_conflict")
        return generation

    async def session_terminal(self, session: str, key: str, size: int, observed_at) -> bool:
        from datetime import UTC, datetime, timedelta

        await self.qualify()
        status = await self.store.status(session, key, size)
        if status in {"complete", "invalidated"}:
            return True
        if (
            status == "missing"
            and observed_at is not None
            and datetime.now(UTC) >= observed_at + timedelta(days=8)
        ):
            return True
        return await self.store.cancel(session, key)

    async def read(self, key: str, *, limit: int) -> tuple[bytes | None, str | None]:
        await self.qualify()
        value, generation = await self.store.get_bounded_with_generation(key, max_bytes=limit)
        return value, str(generation) if value is not None else None

    async def remove(self, key: str, generation: str | None) -> bool:
        await self.qualify()
        # An ambiguous write is reconciled by an exact bounded read first. A
        # delete never acts on an unrecorded later object generation.
        if generation is None:
            _, generation = await self.read(key, limit=4_325_376)
            if generation is None:
                return True
        if not generation.isdecimal() or int(generation) <= 0:
            raise DeliveryError("artifact_generation_unverified", 503)
        object_name = quote(self.store._key(key), safe="")
        url = (
            f"https://storage.googleapis.com/storage/v1/b/{quote(self.bucket, safe='')}/o/"
            f"{object_name}?ifGenerationMatch={generation}"
        )
        response = await asyncio.to_thread(
            self.store._authorized,
            lambda headers: self.store._session.delete(
                url, headers=headers, timeout=20, allow_redirects=False
            ),
        )
        if response.status_code not in (204, 404):
            raise DeliveryError("artifact_delete_unconfirmed", 503)
        # Verify the recorded immutable generation, not just current head.
        check = await asyncio.to_thread(
            self.store._object_get,
            f"https://storage.googleapis.com/storage/v1/b/{quote(self.bucket, safe='')}/o/"
            f"{object_name}?generation={generation}",
            {},
            20,
        )
        if check.status_code != 404:
            raise DeliveryError("artifact_delete_unconfirmed", 503)
        await self.qualify()
        return True


def configured_objects() -> CipherObjects:
    from hushh_mcp.runtime_settings import get_app_runtime_settings

    settings = get_app_runtime_settings()
    bucket = settings.document_delivery_bucket.strip()
    identity = settings.document_delivery_bucket_identity.strip()
    if not bucket or len(identity) != 64 or any(c not in "0123456789abcdef" for c in identity):
        raise DeliveryError("delivery_storage_unconfigured", 503)
    return PrivateGcsCipherObjects(bucket=bucket, identity=identity)
