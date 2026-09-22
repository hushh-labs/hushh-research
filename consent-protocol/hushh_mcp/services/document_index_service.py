"""Small provider-neutral index records; no provider I/O or tool authority.

The first store keeps text AND embeddings encrypted locally. Future vector
adapters must preserve owner/document/version filtering and verified deletion.
Never reuse the public action-catalog embedding cache for private documents.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import secrets
from dataclasses import asdict, dataclass, field

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.services.drive_document_store import DriveDocumentCipher
from hushh_mcp.services.google_drive_adapter import DriveReadError

MAX_CHUNKS = 128
CHUNK_CHARACTERS = 1600
EMBEDDING_DIMENSIONS = 384
INDEX_TEXT_BYTES = 256 * 1024


@dataclass(frozen=True)
class IndexedChunk:
    text: str = field(repr=False)
    embedding: tuple[float, ...] = field(repr=False)
    start: int
    end: int
    page: int | None = None


@dataclass(frozen=True)
class PreparedIndex:
    profile: str
    chunks: tuple[IndexedChunk, ...] = field(repr=False)
    truncated: bool = False

    def validate(self) -> None:
        if (
            not isinstance(self.profile, str)
            or not 1 <= len(self.profile) <= 160
            or not all(c.isascii() and (c.isalnum() or c in "_.:-") for c in self.profile)
            or not isinstance(self.truncated, bool)
            or not 1 <= len(self.chunks) <= MAX_CHUNKS
        ):
            raise DriveReadError("index_response_invalid")
        for chunk in self.chunks:
            if (
                not isinstance(chunk.text, str)
                or not 1 <= len(chunk.text) <= CHUNK_CHARACTERS
                or type(chunk.start) is not int
                or type(chunk.end) is not int
                or not 0 <= chunk.start < chunk.end <= 2_000_000
                or chunk.end - chunk.start != len(chunk.text)
                or (
                    chunk.page is not None
                    and (type(chunk.page) is not int or not 1 <= chunk.page <= 100)
                )
                or len(chunk.embedding) != EMBEDDING_DIMENSIONS
                or any(
                    type(value) not in {int, float} or not math.isfinite(value) or abs(value) > 1
                    for value in chunk.embedding
                )
                or not 0.9 <= sum(value * value for value in chunk.embedding) <= 1.1
            ):
                raise DriveReadError("index_response_invalid")
        if sum(len(chunk.text.encode("utf-8")) for chunk in self.chunks) > INDEX_TEXT_BYTES:
            raise DriveReadError("index_response_invalid")


def index_version(*, source_fingerprint: str, source_version: str, profile: str) -> str:
    return hashlib.sha256(
        json.dumps([source_fingerprint, source_version, profile]).encode()
    ).hexdigest()


class DocumentChunkCipher:
    def __init__(self, source_cipher: DriveDocumentCipher | None = None):
        self.source_cipher = source_cipher or DriveDocumentCipher()

    @staticmethod
    def _aad(row: dict, version: str, ordinal: int) -> bytes:
        return json.dumps(
            [
                "drive-document-chunk-v1",
                row["user_id"],
                str(row["document_id"]),
                row["connection_generation"],
                version,
                ordinal,
            ]
        ).encode()

    def seal(
        self, row: dict, *, version: str, ordinal: int, chunk: IndexedChunk, index: PreparedIndex
    ) -> dict:
        nonce = secrets.token_bytes(12)
        payload = {**asdict(chunk), "profile": index.profile, "truncated": index.truncated}
        ciphertext = AESGCM(self.source_cipher._key()).encrypt(
            nonce,
            json.dumps(payload, separators=(",", ":")).encode(),
            self._aad(row, version, ordinal),
        )
        return {
            "version": 1,
            "iv": base64.b64encode(nonce).decode(),
            "ciphertext": base64.b64encode(ciphertext).decode(),
        }

    def open(self, row: dict, *, version: str, ordinal: int, envelope: dict) -> dict:
        try:
            if envelope["version"] != 1:
                raise ValueError("unknown envelope")
            payload = json.loads(
                AESGCM(self.source_cipher._key()).decrypt(
                    base64.b64decode(envelope["iv"], validate=True),
                    base64.b64decode(envelope["ciphertext"], validate=True),
                    self._aad(row, version, ordinal),
                )
            )
            chunk = IndexedChunk(
                payload["text"],
                tuple(payload["embedding"]),
                payload["start"],
                payload["end"],
                payload["page"],
            )
            PreparedIndex(payload["profile"], (chunk,), payload["truncated"]).validate()
            return dict(payload)
        except Exception:
            raise DriveReadError("document_storage_unavailable") from None
