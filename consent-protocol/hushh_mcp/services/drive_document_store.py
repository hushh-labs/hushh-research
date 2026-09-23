"""Owner-selected sources, not an authority to search or share document content.

Connection -> picker -> document is the lock order. Provider I/O is outside
transactions; generation and single-use selection CAS reject late results.
At scale, Redis admission may precede these durable PostgreSQL fences, never
replace them. This checkpoint queues sources; it does not claim indexing ran.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import uuid
from dataclasses import asdict

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    MAX_SELECTION,
    POLICY_HASH,
    SELECTED_POLICY,
    DriveMetadata,
    DriveReadError,
)

MAX_OWNER_DOCUMENTS = 100
PROCESSING_DISCLOSURE_VERSION = "selected-files-background-v1"


class DriveDocumentCipher:
    """Separate server-processing key, never a vault or OAuth credential key."""

    def _key(self) -> bytes:
        try:
            raw = os.environ["DRIVE_DOCUMENT_KEY_V1"]
            value = base64.b64decode(raw, altchars=b"-_", validate=True)
            if len(value) != 32:
                raise ValueError("invalid key size")
            return value
        except (KeyError, ValueError):
            raise DriveReadError("document_storage_unavailable") from None

    @staticmethod
    def _aad(user_id: str, document_id: str, generation: int) -> bytes:
        return json.dumps(["drive-document-metadata-v1", user_id, document_id, generation]).encode()

    def fingerprint(self, user_id: str, file_id: str) -> str:
        message = json.dumps(["drive-document-source-v1", user_id, file_id]).encode()
        return hmac.new(self._key(), message, hashlib.sha256).hexdigest()

    def seal(
        self, metadata: DriveMetadata, *, user_id: str, document_id: str, generation: int
    ) -> dict:
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._key()).encrypt(
            nonce,
            json.dumps(asdict(metadata), separators=(",", ":")).encode(),
            self._aad(user_id, document_id, generation),
        )
        return {
            "version": 1,
            "iv": base64.b64encode(nonce).decode(),
            "ciphertext": base64.b64encode(ciphertext).decode(),
        }

    def open(self, row: dict) -> dict:
        try:
            envelope = row["metadata_envelope"]
            if envelope["version"] != 1:
                raise ValueError("unknown envelope")
            plaintext = AESGCM(self._key()).decrypt(
                base64.b64decode(envelope["iv"], validate=True),
                base64.b64decode(envelope["ciphertext"], validate=True),
                self._aad(row["user_id"], str(row["document_id"]), row["connection_generation"]),
            )
            return json.loads(plaintext)
        except Exception:
            raise DriveReadError("document_storage_unavailable") from None


class DriveDocumentStore(ExternalConnectorLifecycleStore):
    def __init__(self, db=None, *, cipher=None):
        super().__init__(db)
        self.cipher = cipher or DriveDocumentCipher()

    def _active(
        self, connection, user_id: str, generation: int, *, management: bool = False
    ) -> dict:
        row = self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
        if row["connection_generation"] != generation or (
            not management
            and (
                row["status"] != "connected"
                or row["validation_state"] != "verified"
                or row["verified_policy_hash"] != POLICY_HASH
            )
        ):
            raise DriveReadError("connection_changed")
        return row

    def _selection_policy(
        self, connection, user_id: str, *, feature: str = "google_drive_picker"
    ) -> None:
        # Serialize against operator registry mutation, not a stale service
        # snapshot. Runtime flag/cohort admission is checked at the commit edge.
        policy = self._row(
            connection,
            "SELECT * FROM external_mcp_connectors WHERE connector_id = 'google_drive' FOR SHARE",
            {},
        )
        if (
            not policy
            or not policy["is_active"]
            or policy["transport_kind"] != "google_drive_rest"
            or policy["mcp_endpoint"] != DRIVE_BASE
            or policy["capability_policy"] != SELECTED_POLICY
        ):
            raise DriveReadError("connector_policy_changed")
        if not connector_feature_enabled(feature, user_id):
            raise DriveReadError("connector_unavailable")

    async def start_selection(self, *, user_id: str, generation: int) -> dict:
        self.cipher._key()  # Do not issue a Picker session when storage cannot seal selections.

        def operation(connection):
            self._active(connection, user_id, generation)
            # One current session per owner; bounded cleanup contains no source secrets.
            self._selection_policy(connection, user_id)
            connection.execute(
                text("DELETE FROM drive_picker_sessions WHERE user_id = :user"), {"user": user_id}
            )
            return self._row(
                connection,
                """
                INSERT INTO drive_picker_sessions (session_id, user_id, connection_generation)
                VALUES (:id, :user, :generation) RETURNING session_id, expires_at
            """,
                {"id": str(uuid.uuid4()), "user": user_id, "generation": generation},
            )

        return await self._transaction(operation)

    async def selection_is_current(self, *, user_id: str, generation: int, session_id: str) -> bool:
        def operation(connection):
            self._active(connection, user_id, generation)
            return (
                self._row(
                    connection,
                    """
                SELECT session_id FROM drive_picker_sessions
                WHERE session_id = :id AND user_id = :user AND connection_generation = :generation
                  AND consumed_at IS NULL AND expires_at > clock_timestamp()
            """,
                    {"id": session_id, "user": user_id, "generation": generation},
                )
                is not None
            )

        return await self._transaction(operation)

    async def select(
        self,
        *,
        user_id: str,
        generation: int,
        session_id: str,
        files: list[DriveMetadata],
        processing_consent: str | None = None,
    ) -> list[dict]:
        return await self._transaction(
            lambda connection: self._select_locked(
                connection,
                user_id=user_id,
                generation=generation,
                session_id=session_id,
                files=files,
                processing_consent=processing_consent,
            )
        )

    def _select_locked(
        self,
        connection,
        *,
        user_id: str,
        generation: int,
        session_id: str,
        files: list[DriveMetadata],
        processing_consent: str | None = None,
    ) -> list[dict]:
        """Consume a pre-authorized Picker session inside the caller's transaction.

        The native Picker flow receives candidates through Google's mobile
        redirect but must still use this exact catalog admission path.  Keeping
        the insertion fence here prevents a staged native result from becoming
        a second, subtly different way to add a Drive source.
        """
        if processing_consent is not None and processing_consent != PROCESSING_DISCLOSURE_VERSION:
            raise DriveReadError("processing_consent_required")
        if not 1 <= len(files) <= MAX_SELECTION or len({file.file_id for file in files}) != len(
            files
        ):
            raise DriveReadError("invalid_selection")

        self._active(connection, user_id, generation)
        claimed = self._row(
            connection,
            """
                UPDATE drive_picker_sessions SET consumed_at = clock_timestamp()
                WHERE session_id = :id AND user_id = :user AND connection_generation = :generation
                  AND consumed_at IS NULL AND expires_at > clock_timestamp()
                RETURNING session_id
            """,
            {"id": session_id, "user": user_id, "generation": generation},
        )
        if not claimed:
            raise DriveReadError("selection_expired")
        self._selection_policy(connection, user_id)
        count = connection.execute(
            text("SELECT count(*) FROM connected_documents WHERE user_id = :user"),
            {"user": user_id},
        ).scalar_one()
        result = []
        for metadata in files:
            fingerprint = self.cipher.fingerprint(user_id, metadata.file_id)
            existing = self._row(
                connection,
                """
                    SELECT * FROM connected_documents
                    WHERE user_id = :user AND source_fingerprint = :fingerprint
                """,
                {"user": user_id, "fingerprint": fingerprint},
            )
            if existing:
                # Repeat selection does not resync. Explicit renewed
                # background consent may resume a paused selection.
                if processing_consent and not existing["processing_enabled"]:
                    self._selection_policy(connection, user_id, feature="drive_document_indexing")
                    existing = self._row(
                        connection,
                        """
                            UPDATE connected_documents SET processing_enabled=true,
                              processing_disclosure_version=:disclosure,
                              processing_accepted_at=clock_timestamp(),
                              processing_revision=processing_revision+1,
                              lease_id=NULL, lease_expires_at=NULL, attempt_count=0,
                              status=CASE WHEN active_version IS NOT NULL THEN 'ready' ELSE 'queued' END,
                              next_attempt_at=clock_timestamp(), updated_at=clock_timestamp()
                            WHERE document_id=:id AND user_id=:user AND connection_generation=:generation
                            RETURNING *
                            """,
                        {
                            "id": existing["document_id"],
                            "user": user_id,
                            "generation": generation,
                            "disclosure": processing_consent,
                        },
                    )
                result.append(existing)
                continue
            count += 1
            if count > MAX_OWNER_DOCUMENTS:
                raise DriveReadError("document_limit_reached")
            document_id = str(uuid.uuid4())
            if processing_consent:
                self._selection_policy(connection, user_id, feature="drive_document_indexing")
            sealed = self.cipher.seal(
                metadata, user_id=user_id, document_id=document_id, generation=generation
            )
            result.append(
                self._row(
                    connection,
                    """
                    INSERT INTO connected_documents
                      (document_id,user_id,connection_generation,source_fingerprint,metadata_envelope,source_version,
                       processing_enabled,processing_disclosure_version,processing_accepted_at,processing_revision)
                    VALUES (:id,:user,:generation,:fingerprint,CAST(:envelope AS jsonb),:version,
                            :enabled,:disclosure,CASE WHEN :enabled THEN clock_timestamp() END,
                            CASE WHEN :enabled THEN 1 ELSE 0 END)
                    RETURNING *
                    """,
                    {
                        "id": document_id,
                        "user": user_id,
                        "generation": generation,
                        "fingerprint": fingerprint,
                        "envelope": json.dumps(sealed),
                        "version": metadata.version,
                        "enabled": processing_consent is not None,
                        "disclosure": processing_consent,
                    },
                )
            )
        return [self.public_document(row) for row in result]

    def public_document(self, row: dict) -> dict:
        metadata = self.cipher.open(row)
        return {
            "documentId": str(row["document_id"]),
            "name": metadata["name"],
            "mimeType": metadata["mime_type"],
            "status": row["status"],
            "modifiedAt": metadata["modified_time"],
            "lastErrorCode": row["last_error_code"],
            "backgroundProcessing": bool(row.get("processing_enabled", False)),
        }

    async def set_processing(
        self,
        *,
        user_id: str,
        generation: int,
        document_id: str,
        enabled: bool,
        disclosure: str | None = None,
    ) -> None:
        if type(enabled) is not bool or (enabled and disclosure != PROCESSING_DISCLOSURE_VERSION):
            raise DriveReadError("processing_consent_required")

        def operation(connection):
            self._active(connection, user_id, generation, management=not enabled)
            if enabled:
                self._selection_policy(connection, user_id, feature="drive_document_indexing")
            row = self._row(
                connection,
                """
                UPDATE connected_documents SET processing_enabled=:enabled,
                  processing_disclosure_version=CASE WHEN :enabled THEN :disclosure ELSE processing_disclosure_version END,
                  processing_accepted_at=CASE WHEN :enabled THEN clock_timestamp() ELSE processing_accepted_at END,
                  processing_revision=processing_revision+1, lease_id=NULL, lease_expires_at=NULL,
                  status=CASE WHEN active_version IS NULL THEN 'queued' ELSE 'ready' END,
                  next_attempt_at=clock_timestamp(), attempt_count=0, updated_at=clock_timestamp()
                WHERE user_id=:user AND document_id=:id AND connection_generation=:generation
                RETURNING document_id
            """,
                {
                    "enabled": enabled,
                    "disclosure": disclosure,
                    "user": user_id,
                    "id": document_id,
                    "generation": generation,
                },
            )
            if not row:
                raise DriveReadError("source_unavailable")

        await self._transaction(operation)

    async def list_documents(self, *, user_id: str, generation: int) -> list[dict]:
        def operation(connection):
            current = self._active(connection, user_id, generation, management=True)
            rows = connection.execute(
                text("""
                SELECT * FROM connected_documents WHERE user_id = :user AND connection_generation = :generation
                ORDER BY created_at, document_id LIMIT :limit
            """),
                {"user": user_id, "generation": generation, "limit": MAX_OWNER_DOCUMENTS},
            ).mappings()
            result = [self.public_document(dict(row)) for row in rows]
            if current["status"] != "connected":
                for item in result:
                    item["status"] = "needs_reauth"
            return result

        return await self._transaction(operation)

    async def remove(self, *, user_id: str, generation: int, document_id: str) -> None:
        def operation(connection):
            self._active(connection, user_id, generation, management=True)
            # A late, already-submitted Picker selection must not resurrect a
            # removed source. A fresh user selection requires a new session.
            connection.execute(
                text("DELETE FROM drive_picker_sessions WHERE user_id = :user"), {"user": user_id}
            )
            connection.execute(
                text("DELETE FROM connected_documents WHERE user_id = :user AND document_id = :id"),
                {"user": user_id, "id": document_id},
            )

        await self._transaction(operation)
