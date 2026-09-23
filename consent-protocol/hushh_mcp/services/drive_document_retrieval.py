"""Bounded owner-private retrieval, with live provider and local release fences.

No model may choose a namespace or credentials. Encrypted vectors are ranked
in memory, never in a shared cache. An oversized corpus requires narrowing;
the first page is never presented as a search of the entire library.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import uuid
from dataclasses import asdict

from sqlalchemy import text

from hushh_mcp.services.document_index_service import DocumentChunkCipher
from hushh_mcp.services.drive_document_processor import IsolatedDocumentEmbedding
from hushh_mcp.services.drive_document_store import (
    PROCESSING_DISCLOSURE_VERSION,
    DriveDocumentStore,
)
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveReadError, GoogleDriveAdapter

MAX_CANDIDATES = 256
MAX_CIPHER_BYTES = 4 * 1024 * 1024
MAX_DOCUMENTS = 8
MAX_CONTEXT_BYTES = 16 * 1024
READABLE = ("ready", "stale", "failed_retryable", "fetching", "parsing", "indexing")


class DriveRetrievalStore(DriveDocumentStore):
    feature = "google_drive_chat_reads"
    background = False

    async def snapshot(
        self, *, user_id: str, generation: int, document_id: str | None = None
    ) -> list[dict]:
        if document_id is not None:
            try:
                document_id = str(uuid.UUID(document_id))
            except (ValueError, TypeError, AttributeError):
                raise DriveReadError("invalid_argument") from None

        def operation(connection):
            self._active(connection, user_id, generation)
            self._selection_policy(connection, user_id, feature=self.feature)
            params = {
                "user": user_id,
                "generation": generation,
                "document": document_id,
                "limit": MAX_CANDIDATES + 1,
                "background": self.background,
                "disclosure": PROCESSING_DISCLOSURE_VERSION,
            }
            eligible = """
                FROM connected_documents d JOIN document_chunks c
                  ON c.user_id=d.user_id AND c.document_id=d.document_id AND c.index_version=d.active_version
                WHERE d.user_id=:user AND d.connection_generation=:generation
                  AND d.status IN ('ready','stale','failed_retryable','fetching','parsing','indexing')
                  AND (CAST(:document AS uuid) IS NULL OR d.document_id=CAST(:document AS uuid))
                  AND (:background=FALSE OR (d.status='ready' AND d.processing_enabled
                    AND d.processing_disclosure_version=:disclosure))
                ORDER BY d.document_id,c.ordinal LIMIT :limit
            """
            # Check ciphertext lengths BEFORE fetching/decrypting their bytes.
            sizes = (
                connection.execute(
                    text(
                        """
                SELECT d.document_id, octet_length(c.content_envelope::text)
                  +octet_length(d.metadata_envelope::text) AS bytes
            """
                        + eligible
                    ),
                    params,
                )
                .mappings()
                .all()
            )
            if (
                len(sizes) > MAX_CANDIDATES
                or sum(row["bytes"] for row in sizes) > MAX_CIPHER_BYTES
                or len({row["document_id"] for row in sizes}) > MAX_DOCUMENTS
            ):
                raise DriveReadError("narrow_selection_required")
            unready = connection.execute(
                text("""
                SELECT EXISTS (SELECT 1 FROM connected_documents
                 WHERE user_id=:user AND connection_generation=:generation
                   AND (CAST(:document AS uuid) IS NULL OR document_id=CAST(:document AS uuid))
                   AND (:background=FALSE OR (processing_enabled AND processing_disclosure_version=:disclosure))
                   AND (active_version IS NULL OR (:background=TRUE AND status<>'ready')
                     OR status NOT IN ('ready','stale','failed_retryable','fetching','parsing','indexing')))
            """),
                params,
            ).scalar_one()
            return [
                {**dict(row), "unready_selected": unready}
                for row in connection.execute(
                    text(
                        """
                SELECT d.*, c.ordinal,c.content_envelope
            """
                        + eligible
                    ),
                    params,
                ).mappings()
            ]

        return await self._transaction(operation)

    async def require_current(self, *, user_id: str, generation: int, rows: list[dict]) -> None:
        def operation(connection):
            self._active(connection, user_id, generation)
            self._selection_policy(connection, user_id, feature=self.feature)
            checked = set()
            for old in rows:
                if old["document_id"] in checked:
                    continue
                checked.add(old["document_id"])
                row = self._row(
                    connection,
                    """
                    SELECT * FROM connected_documents WHERE user_id=:user AND document_id=:id
                """,
                    {"user": user_id, "id": old["document_id"]},
                )
                if (
                    not row
                    or row["status"] not in READABLE
                    or self.background
                    and (
                        row["status"] != "ready"
                        or not row["processing_enabled"]
                        or row["processing_disclosure_version"] != PROCESSING_DISCLOSURE_VERSION
                    )
                    or any(
                        row[key] != old[key]
                        for key in (
                            "connection_generation",
                            "active_version",
                            "source_version",
                            "processing_revision",
                        )
                    )
                ):
                    raise DriveReadError("source_changed")

        await self._transaction(operation)


class DriveSuggestionRetrievalStore(DriveRetrievalStore):
    feature = "drive_document_sharing"
    background = True


class DriveDocumentReader:
    def __init__(
        self, *, user_id: str, require_access, oauth=None, store=None, adapter=None, embedder=None
    ):
        self.user_id = user_id
        self.require_access = require_access
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DriveRetrievalStore(db=self.oauth.lifecycle.db)
        self.adapter = adapter or GoogleDriveAdapter()
        self.embedder = embedder or IsolatedDocumentEmbedding()
        self._rows: list[dict] = []
        self._generation: int | None = None

    async def require_current(self) -> None:
        await self.require_access()
        if self._generation is None:
            raise DriveReadError("connection_changed")
        row, credential = await self.oauth.current_credential(user_id=self.user_id)
        if row["connection_generation"] != self._generation:
            raise DriveReadError("connection_changed")
        await self.store.require_current(
            user_id=self.user_id, generation=self._generation, rows=self._rows
        )
        unique = {str(row["document_id"]): row for row in self._rows}
        semaphore = asyncio.Semaphore(4)

        async def verify(document):
            async with semaphore:
                await self.require_access()
                await self.store.require_current(
                    user_id=self.user_id, generation=self._generation, rows=[document]
                )
                metadata = self.store.cipher.open(document)
                fresh = await self.adapter.get_metadata(
                    file_id=metadata["file_id"], access_token=credential["accessToken"]
                )
                if asdict(fresh) != metadata:
                    raise DriveReadError("source_changed")

        try:
            async with asyncio.timeout(20), asyncio.TaskGroup() as group:
                for document in unique.values():
                    group.create_task(verify(document))
        except ExceptionGroup as group:
            failures = list(group.exceptions)
            while any(isinstance(item, ExceptionGroup) for item in failures):
                failures = [
                    child
                    for item in failures
                    for child in (item.exceptions if isinstance(item, ExceptionGroup) else [item])
                ]
            if any(isinstance(error, PermissionError) for error in failures):
                raise PermissionError("Document owner authority is unavailable") from None
            for error in failures:
                if isinstance(error, DriveReadError):
                    raise DriveReadError(str(error), retryable=error.retryable) from None
            raise DriveReadError("provider_unavailable", retryable=True) from None
        await self.require_access()
        await self.store.require_current(
            user_id=self.user_id, generation=self._generation, rows=self._rows
        )

    async def search(self, *, query: str, document_ref: str | None = None, limit: int = 8) -> dict:
        if (
            not isinstance(query, str)
            or not query.strip()
            or len(query.encode()) > 2048
            or type(limit) is not int
            or not 1 <= limit <= 8
        ):
            raise DriveReadError("invalid_argument")
        await self.require_access()
        connection = await self.oauth.lifecycle.read(
            user_id=self.user_id, connector_id="google_drive"
        )
        if not connection or connection["status"] == "revoked":
            raise DriveReadError("connect_required")
        row, _ = await self.oauth.current_credential(user_id=self.user_id)
        self._generation = row["connection_generation"]
        self._rows = await self.store.snapshot(
            user_id=self.user_id, generation=self._generation, document_id=document_ref
        )
        await self.require_local()
        if not self._rows:
            return {"untrusted_external_content": [], "truncated": False}
        vector = await self.embedder.query(query)
        if len(vector) != 384 or any(not math.isfinite(value) for value in vector):
            raise DriveReadError("processor_unavailable")
        await self.require_local()
        cipher = DocumentChunkCipher(self.store.cipher)
        ranked = []
        for item in self._rows:
            chunk = cipher.open(
                item,
                version=item["active_version"],
                ordinal=item["ordinal"],
                envelope=item["content_envelope"],
            )
            if chunk["profile"] != self.embedder.profile:
                raise DriveReadError("index_profile_changed")
            score = sum(a * b for a, b in zip(vector, chunk["embedding"], strict=True))
            ranked.append((score, item, chunk))
        ranked.sort(
            key=lambda value: (-value[0], str(value[1]["document_id"]), value[1]["ordinal"])
        )
        content = []
        truncated = len(ranked) > limit or any(row["unready_selected"] for row in self._rows)
        for _, item, chunk in ranked[:limit]:
            metadata = self.store.cipher.open(item)
            ref = hashlib.sha256(
                f"{item['document_id']}:{item['active_version']}:{item['ordinal']}".encode()
            ).hexdigest()[:32]
            entry = {
                "source_ref": "document:" + ref,
                "document_ref": str(item["document_id"]),
                "name": metadata["name"],
                "page": chunk["page"],
                "text": chunk["text"],
                "source_version": item["source_version"],
            }
            if len(json.dumps(content + [entry], ensure_ascii=False).encode()) > MAX_CONTEXT_BYTES:
                truncated = True
                break
            content.append(entry)
            truncated = truncated or chunk["truncated"]
        await self.require_current()
        return {"untrusted_external_content": content, "truncated": truncated}

    async def require_local(self) -> None:
        await self.require_access()
        if self._generation is None:
            raise DriveReadError("connection_changed")
        await self.store.require_current(
            user_id=self.user_id, generation=self._generation, rows=self._rows
        )
