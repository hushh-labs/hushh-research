"""Bounded resumable copy and ordered complete-hash verification."""

import asyncio
import hashlib
import time

from hushh_mcp.services.document_delivery import background_objects
from hushh_mcp.services.document_delivery.background_diagnostics import CopySourceChanged
from hushh_mcp.services.document_delivery.background_source import CHUNK_BYTES
from hushh_mcp.services.document_delivery.contracts import DeliveryError


async def copy_chunks(service, row, source, credential, identity, deadline, native=None):
    chunks = await service.store.chunks(row)
    offset = sum(chunk["descriptor"]["bytes"] for chunk in chunks)
    if [chunk["ordinal"] for chunk in chunks] != list(range(len(chunks))) or offset > identity[
        "size"
    ]:
        raise DeliveryError("copy_integrity_mismatch")
    if any(chunk["object_generation"] is None for chunk in chunks):
        raise DeliveryError("upload_outcome_unknown")
    while offset < identity["size"]:
        if time.monotonic() >= deadline:
            await service.defer(row)
            return None
        await service.store.current(row)
        plaintext = (
            bytearray(native[offset : offset + CHUNK_BYTES])
            if native is not None
            else await service.reader.chunk(source, credential, offset, identity["size"])
        )
        try:
            await service.store.current(row)
            await background_objects.save(service, row, len(chunks), plaintext)
        finally:
            plaintext[:] = b"\0" * len(plaintext)
        chunks = await service.store.chunks(row)
        offset = sum(chunk["descriptor"]["bytes"] for chunk in chunks)
    return chunks


async def verify(service, row, chunks, identity, deadline):
    row["_verification_attempt"] = await service.store.begin_verification(row)
    sha, md5 = hashlib.sha256(), hashlib.md5(usedforsecurity=False)
    for offset in range(0, len(chunks), 4):
        if time.monotonic() >= deadline:
            await service.defer(row)
            return None
        await service.store.current(row)
        originals = await asyncio.gather(
            *(background_objects.read(service, row, chunk) for chunk in chunks[offset : offset + 4])
        )
        await service.store.current(row)
        for plaintext in originals:
            sha.update(plaintext)
            md5.update(plaintext)
        del originals
    mismatches = []
    if md5.hexdigest() != identity["md5Checksum"]:
        mismatches.append("md5")
    if identity.get("sha256Checksum", sha.hexdigest()) != sha.hexdigest():
        mismatches.append("sha256")
    if mismatches:
        raise CopySourceChanged("verify", mismatches)
    return {"sha256": sha.hexdigest(), "bytes": identity["size"]}
