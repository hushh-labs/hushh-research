"""One scoped owner ciphertext envelope with exact transactional readback.

This service has no worker checkpoint or key release path. It never stores a
DEK, vault key or owner token.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from db.db_client import get_db
from hushh_mcp.services.hosted_memory_envelope_contract import (
    ENVELOPE_VERSION,
    MAX_CIPHERTEXT_BYTES,
    MAX_REVISION,
    SCOPE_CODE,
    SOURCE_KIND,
    aad_sha256_hex,
    active_catalog_source,
    admitted_source_id,
    encode_base64url,
    owner_source_aad,
)


class HostedMemoryEnvelopeConflict(RuntimeError):
    """Owner grant, source, or CAS revision changed."""


class HostedMemoryEnvelopeUnavailable(RuntimeError):
    """The encrypted envelope transaction could not complete."""


def _uuid(value: str) -> str:
    parsed = UUID(value)
    if str(parsed) != value:
        raise ValueError("noncanonical UUID")
    return value


def _key_uuid(value: str) -> str:
    _uuid(value)
    if UUID(value).version != 4:
        raise ValueError("key identifier must be random UUID v4")
    return value


def _ciphertext(value: bytes, nonce: bytes) -> None:
    if len(nonce) != 12 or not 17 <= len(value) <= MAX_CIPHERTEXT_BYTES:
        raise ValueError("invalid encrypted envelope size")


def _generation(value: int) -> None:
    if not 0 < value <= MAX_REVISION:
        raise ValueError("invalid generation")


def _revision(value: int, *, allow_zero: bool = False) -> None:
    if not (0 if allow_zero else 1) <= value <= MAX_REVISION:
        raise ValueError("invalid revision")


def _grant_locked(connection: Any, user_id: str) -> Any:
    return (
        connection.execute(
            text("""SELECT grant_id, generation, source_kind, source_id, status,
                          expires_at, clock_timestamp() AS observed_at
                   FROM public.live_memory_hosted_pilot_grants
                   WHERE user_id=:user_id FOR UPDATE"""),
            {"user_id": user_id},
        )
        .mappings()
        .first()
    )


def _assert_grant(row: Any, *, grant_id: str, generation: int, source_id: str) -> None:
    if (
        row is None
        or str(row["grant_id"]) != grant_id
        or int(row["generation"]) != generation
        or row["source_kind"] != SOURCE_KIND
        or row["source_id"] != source_id
        or row["status"] != "pending"
        or row["expires_at"] <= row["observed_at"]
    ):
        raise HostedMemoryEnvelopeConflict("review changed or expired")


def _owner_readback(row: Any) -> dict[str, Any]:
    return {
        "grantId": str(row["grant_id"]),
        "generation": str(row["grant_generation"]),
        "sourceKind": SOURCE_KIND,
        "sourceId": row["source_id"],
        "scope": row["scope_code"],
        "envelopeVersion": row["envelope_version"],
        "keyId": str(row["key_id"]),
        "revision": str(row["owner_revision"]),
        "nonceBase64Url": encode_base64url(bytes(row["owner_nonce"])),
        "ciphertextBase64Url": encode_base64url(bytes(row["owner_ciphertext"])),
        "ciphertextSha256": bytes(row["owner_ciphertext_sha256"]).hex(),
        "aadSha256": bytes(row["owner_aad_sha256"]).hex(),
        "captureEnabled": False,
        "workerPaired": False,
    }


class HostedMemoryEnvelopeService:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    @staticmethod
    def _configure(connection: Any) -> None:
        connection.execute(text("SET LOCAL statement_timeout = '5s'"))
        connection.execute(text("SET LOCAL lock_timeout = '2s'"))

    async def stage_owner_envelope(
        self,
        *,
        user_id: str,
        grant_id: str,
        generation: int,
        source_id: str,
        expected_revision: int,
        key_id: str,
        nonce: bytes,
        ciphertext: bytes,
        aad_sha256: str,
    ) -> dict[str, Any]:
        """CAS stage and read back exact owner ciphertext under one grant lock."""
        if not user_id or not admitted_source_id(source_id):
            raise ValueError("invalid admitted source")
        _uuid(grant_id)
        _key_uuid(key_id)
        _generation(generation)
        _revision(expected_revision, allow_zero=True)
        if expected_revision == MAX_REVISION:
            raise ValueError("revision exhausted")
        _ciphertext(ciphertext, nonce)
        expected_aad = owner_source_aad(
            user_id=user_id,
            grant_id=grant_id,
            generation=generation,
            source_id=source_id,
            revision=expected_revision + 1,
        )
        if aad_sha256 != aad_sha256_hex(expected_aad):
            raise ValueError("AAD does not match reviewed source and new revision")
        cipher_hash = hashlib.sha256(ciphertext).digest()

        def write() -> dict[str, Any]:
            with self.db.engine.begin() as connection:
                self._configure(connection)
                if not active_catalog_source(connection, source_id):
                    raise HostedMemoryEnvelopeConflict("source left the curated catalog")
                _assert_grant(
                    _grant_locked(connection, user_id),
                    grant_id=grant_id,
                    generation=generation,
                    source_id=source_id,
                )
                old = (
                    connection.execute(
                        text("""SELECT grant_id, grant_generation, source_id, owner_revision,
                                      key_id, owner_nonce
                               FROM public.live_memory_hosted_source_envelopes
                               WHERE user_id=:user_id FOR UPDATE"""),
                        {"user_id": user_id},
                    )
                    .mappings()
                    .first()
                )
                if old is None:
                    if expected_revision != 0:
                        raise HostedMemoryEnvelopeConflict("envelope revision changed")
                    connection.execute(
                        text("""INSERT INTO public.live_memory_hosted_source_envelopes
                              (user_id, grant_id, grant_generation, source_id, scope_code,
                               envelope_version, key_id, owner_revision, owner_nonce,
                               owner_ciphertext, owner_ciphertext_sha256, owner_aad_sha256)
                              VALUES (:user_id, :grant_id, :generation, :source_id, :scope,
                                      :version, :key_id, 1, :nonce, :ciphertext,
                                      :cipher_hash, :aad_hash)"""),
                        {
                            "user_id": user_id,
                            "grant_id": grant_id,
                            "generation": generation,
                            "source_id": source_id,
                            "scope": SCOPE_CODE,
                            "version": ENVELOPE_VERSION,
                            "key_id": key_id,
                            "nonce": nonce,
                            "ciphertext": ciphertext,
                            "cipher_hash": cipher_hash,
                            "aad_hash": bytes.fromhex(aad_sha256),
                        },
                    )
                else:
                    if (
                        str(old["grant_id"]) != grant_id
                        or int(old["grant_generation"]) != generation
                        or old["source_id"] != source_id
                        or int(old["owner_revision"]) != expected_revision
                    ):
                        raise HostedMemoryEnvelopeConflict("envelope revision changed")
                    if str(old["key_id"]) == key_id and bytes(old["owner_nonce"]) == nonce:
                        raise ValueError("AES-GCM key and nonce pair was already used")
                    connection.execute(
                        text("""UPDATE public.live_memory_hosted_source_envelopes
                               SET key_id=:key_id, owner_revision=owner_revision+1,
                                   owner_nonce=:nonce, owner_ciphertext=:ciphertext,
                                   owner_ciphertext_sha256=:cipher_hash,
                                   owner_aad_sha256=:aad_hash,
                                   updated_at=clock_timestamp()
                               WHERE user_id=:user_id"""),
                        {
                            "user_id": user_id,
                            "key_id": key_id,
                            "nonce": nonce,
                            "ciphertext": ciphertext,
                            "cipher_hash": cipher_hash,
                            "aad_hash": bytes.fromhex(aad_sha256),
                        },
                    )
                row = (
                    connection.execute(
                        text("""SELECT grant_id, grant_generation, source_id, scope_code,
                                      envelope_version, key_id, owner_revision, owner_nonce,
                                      owner_ciphertext, owner_ciphertext_sha256,
                                      owner_aad_sha256
                               FROM public.live_memory_hosted_source_envelopes
                               WHERE user_id=:user_id"""),
                        {"user_id": user_id},
                    )
                    .mappings()
                    .one()
                )
                if (
                    int(row["owner_revision"]) != expected_revision + 1
                    or bytes(row["owner_ciphertext_sha256"]) != cipher_hash
                    or bytes(row["owner_ciphertext"]) != ciphertext
                ):
                    raise HostedMemoryEnvelopeUnavailable("encrypted readback differed")
                return _owner_readback(row)

        try:
            return await asyncio.to_thread(write)
        except SQLAlchemyError:
            raise HostedMemoryEnvelopeUnavailable("encrypted envelope unavailable") from None

    async def owner_readback(self, *, user_id: str) -> dict[str, Any] | None:
        if not user_id:
            raise ValueError("owner identity required")

        def read() -> dict[str, Any] | None:
            with self.db.engine.begin() as connection:
                connection.execute(
                    text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                )
                self._configure(connection)
                row = (
                    connection.execute(
                        text("""SELECT e.grant_id, e.grant_generation, e.source_id,
                                      e.scope_code, e.envelope_version, e.key_id,
                                      e.owner_revision, e.owner_nonce, e.owner_ciphertext,
                                      e.owner_ciphertext_sha256, e.owner_aad_sha256
                               FROM public.live_memory_hosted_source_envelopes e
                               JOIN public.live_memory_hosted_pilot_grants g
                                 ON g.user_id=e.user_id AND g.grant_id=e.grant_id
                                AND g.generation=e.grant_generation
                                AND g.source_id=e.source_id
                               WHERE e.user_id=:user_id AND g.status='pending'
                                 AND g.expires_at>clock_timestamp()"""),
                        {"user_id": user_id},
                    )
                    .mappings()
                    .first()
                )
                return _owner_readback(row) if row else None

        try:
            return await asyncio.to_thread(read)
        except SQLAlchemyError:
            raise HostedMemoryEnvelopeUnavailable("encrypted envelope unavailable") from None
