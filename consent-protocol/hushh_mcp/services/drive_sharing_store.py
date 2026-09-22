"""Durable private requests and atomic exact-file approval, with no provider I/O.

Lock order: participant graph gates, Drive connection, registry policy, relationship, request, ordered
selected documents, confirmation ledger. Encrypted permission work survives
disconnect and removal of the index. A queued operation is not Google success.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore, DocumentReviewAuthority
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_document_store import (
    PROCESSING_DISCLOSURE_VERSION,
    DriveDocumentStore,
)
from hushh_mcp.services.drive_sharing_contract import (
    MAX_FILES,
    SHARING_ACTION,
    DriveSharingCipher,
    DriveSharingError,
    ReviewedSource,
    ShareRequestPurpose,
    SharingApproval,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError


class DriveSharingStore(DriveDocumentStore):
    def __init__(self, db=None, *, cipher=None, sharing_cipher=None, authority_key=None):
        super().__init__(db, cipher=cipher)
        self.sharing_cipher = sharing_cipher or DriveSharingCipher()
        self.authority_key = authority_key

    @staticmethod
    def _sharing_admission(user_id):
        if not connector_feature_enabled("drive_document_sharing", user_id):
            raise DriveSharingError("sharing_unavailable")

    def _relationship(self, connection, owner, recipient):
        pair = sorted((owner, recipient))
        row = self._row(
            connection,
            """
            SELECT id FROM connections WHERE user_a_id=:a AND user_b_id=:b AND status='active'
            FOR SHARE
        """,
            {"a": pair[0], "b": pair[1]},
        )
        if owner == recipient or not row:
            raise DriveSharingError("connection_required")

    def _participant_gate(self, connection, user_id, request_id, *, recipient=False):
        initial = self._row(
            connection,
            """
            SELECT user_id,recipient_user_id FROM drive_share_requests WHERE request_id=:id
              AND ((:recipient=FALSE AND user_id=:user) OR (:recipient=TRUE AND recipient_user_id=:user))
        """,
            {"id": str(UUID(request_id)), "user": user_id, "recipient": recipient},
        )
        if not initial:
            raise DriveSharingError("request_unavailable")
        lock_connection_graph_users(
            connection, user_ids=[initial["user_id"], initial["recipient_user_id"]]
        )
        # Callers subsequently re-read the request under its row lock.
        return initial

    def _request(self, connection, user_id, request_id, *, recipient=False):
        row = self._row(
            connection,
            """
            SELECT * FROM drive_share_requests WHERE request_id=:id
              AND ((:recipient=FALSE AND user_id=:user) OR (:recipient=TRUE AND recipient_user_id=:user))
            FOR UPDATE
        """,
            {"id": str(UUID(request_id)), "user": user_id, "recipient": recipient},
        )
        if not row:
            raise DriveSharingError("request_unavailable")
        return row

    def _related_request(self, connection, user_id, request_id):
        # Resolve the immutable participant before acquiring the request lock.
        initial = self._row(
            connection,
            """
            SELECT recipient_user_id FROM drive_share_requests WHERE request_id=:id AND user_id=:user
        """,
            {"id": str(UUID(request_id)), "user": user_id},
        )
        if not initial:
            raise DriveSharingError("request_unavailable")
        self._relationship(connection, user_id, initial["recipient_user_id"])
        return self._request(connection, user_id, request_id)

    @staticmethod
    def _owner_gate(connection, user_id):
        lock_connection_graph_users(connection, user_ids=[user_id])

    def _management_context(self, connection, user_id, request_id):
        row = self._row(
            connection,
            """
            SELECT * FROM drive_share_management_contexts
            WHERE request_id=:id AND user_id=:user FOR UPDATE
        """,
            {"id": str(UUID(str(request_id))), "user": user_id},
        )
        if not row:
            raise DriveSharingError("request_unavailable")
        return row

    @staticmethod
    def _event(connection, request, user_id, event_type):
        connection.execute(
            text("""
            INSERT INTO drive_share_events(event_id,request_id,user_id,revision,event_type)
            VALUES (:id,:request,:user,:revision,:type)
            ON CONFLICT (request_id,user_id,revision,event_type) DO NOTHING
        """),
            {
                "id": str(uuid4()),
                "request": request["request_id"],
                "user": user_id,
                "revision": request["revision"],
                "type": event_type,
            },
        )

    @staticmethod
    def _summary(row, *, recipient=False):
        # No matches, counts, filenames or private failure details for B.
        state = row["status"]
        if state in {"pending", "preparing", "review_ready"} and row["expires_at"] <= datetime.now(
            UTC
        ):
            state = "expired"
        if recipient and state in {"preparing", "review_ready"}:
            state = "pending"
        return {"requestId": str(row["request_id"]), "status": state, "revision": row["revision"]}

    def _open_request(self, row):
        return self.sharing_cipher.open(
            row["request_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["request_id"]),
            purpose="request",
        )

    async def create_request(
        self,
        *,
        recipient: VerifiedGoogleRecipient,
        owner_user_id: str,
        client_request_id: str,
        purpose: ShareRequestPurpose,
    ) -> dict:
        """B's authenticated identity must be verified by the service before calling."""
        self._sharing_admission(recipient.user_id)
        self._sharing_admission(owner_user_id)
        age = (datetime.now(UTC) - recipient.verified_at).total_seconds()
        if not 0 <= age <= 300:
            raise DriveSharingError("verify_google_identity_required")
        client_request_id = str(UUID(client_request_id))
        request_id = str(uuid4())
        payload = {
            "purpose": purpose.model_dump(),
            "recipient": {
                "user_id": recipient.user_id,
                "subject": recipient.subject,
                "email": recipient.email,
                "verified_at": recipient.verified_at.isoformat(),
            },
        }
        binding = self.sharing_cipher.recipient_binding(recipient)
        digest = self.sharing_cipher.digest(
            "request", [owner_user_id, binding, purpose.model_dump()]
        )
        envelope = self.sharing_cipher.seal(
            payload, user_id=owner_user_id, resource_id=request_id, purpose="request"
        )

        def operation(connection):
            lock_connection_graph_users(connection, user_ids=[owner_user_id, recipient.user_id])
            self._relationship(connection, owner_user_id, recipient.user_id)
            old = self._row(
                connection,
                """
                SELECT * FROM drive_share_requests WHERE recipient_user_id=:recipient AND client_request_id=:client
                FOR UPDATE
            """,
                {"recipient": recipient.user_id, "client": client_request_id},
            )
            if old:
                if old["request_digest"] != digest or old["user_id"] != owner_user_id:
                    raise DriveSharingError("request_changed")
                return self._summary(old, recipient=True)
            row = self._row(
                connection,
                """
                INSERT INTO drive_share_requests(request_id,user_id,recipient_user_id,client_request_id,
                  request_envelope,recipient_binding,request_digest)
                VALUES (:id,:owner,:recipient,:client,CAST(:envelope AS jsonb),:binding,:digest)
                ON CONFLICT (recipient_user_id,client_request_id) DO NOTHING
                RETURNING *
            """,
                {
                    "id": request_id,
                    "owner": owner_user_id,
                    "recipient": recipient.user_id,
                    "client": client_request_id,
                    "envelope": json.dumps(envelope),
                    "binding": binding,
                    "digest": digest,
                },
            )
            if not row:
                row = self._row(
                    connection,
                    """
                    SELECT * FROM drive_share_requests WHERE recipient_user_id=:recipient AND client_request_id=:client
                    FOR UPDATE
                """,
                    {"recipient": recipient.user_id, "client": client_request_id},
                )
                if not row or row["request_digest"] != digest or row["user_id"] != owner_user_id:
                    raise DriveSharingError("request_changed")
            else:
                connection.execute(
                    text("""
                    INSERT INTO drive_share_management_contexts(request_id,user_id)
                    VALUES (:id,:user) ON CONFLICT (request_id) DO NOTHING
                """),
                    {"id": request_id, "user": owner_user_id},
                )
                self._event(connection, row, owner_user_id, "document_share_request")
            return self._summary(row, recipient=True)

        return cast(dict, await self._transaction(operation))

    def _sources(self, connection, *, user_id, generation, document_ids):
        if not 1 <= len(document_ids) <= MAX_FILES or len(set(document_ids)) != len(document_ids):
            raise DriveSharingError("invalid_selection")
        rows = []
        for identifier in sorted(str(UUID(item)) for item in document_ids):
            row = self._row(
                connection,
                """
                SELECT * FROM connected_documents WHERE user_id=:user AND document_id=:id FOR UPDATE
            """,
                {"user": user_id, "id": identifier},
            )
            if (
                not row
                or row["connection_generation"] != generation
                or row["status"] != "ready"
                or not row["active_version"]
                or not row["processing_enabled"]
                or row["processing_disclosure_version"] != PROCESSING_DISCLOSURE_VERSION
            ):
                raise DriveSharingError("source_changed")
            rows.append(row)
        return rows

    @staticmethod
    def _source_terms(row):
        return {
            "document_id": str(row["document_id"]),
            "source_version": row["source_version"],
            "source_fingerprint": row["source_fingerprint"],
            "index_version": row["active_version"],
            "processing_revision": row["processing_revision"],
        }

    @staticmethod
    def _authority(approval):
        terms = approval.authority_binding()
        return DocumentReviewAuthority(
            user_id=approval.owner_user_id,
            request_id=str(approval.request_id),
            revision=approval.revision,
            action_contract=SHARING_ACTION,
            slots={"approval": terms},
            resource_binding=terms,
        )

    async def prepare_review(
        self,
        *,
        user_id: str,
        generation: int,
        request_id: str,
        expected_revision: int,
        document_ids: list[str],
        observed_sources: list[ReviewedSource],
        coverage: dict,
        preparation_lease_id: str | None = None,
        read_sources: list[ReviewedSource] | None = None,
    ) -> dict:
        """Called only after a tool-less suggestion pass; never shares automatically.

        Coverage is private authored model output. The store enforces bounds and
        exact source authority, not semantic relevance or date coverage.
        """
        self._sharing_admission(user_id)
        if len(json.dumps(coverage).encode()) > 16 * 1024:
            raise DriveSharingError("sharing_payload_too_large")

        def operation(connection):
            self._participant_gate(connection, user_id, request_id)
            self._active(connection, user_id, generation)
            self._selection_policy(connection, user_id, feature="drive_document_sharing")
            row = self._related_request(connection, user_id, request_id)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row["status"] not in {"pending", "preparing", "review_ready"}
                or row["revision"] != expected_revision
                or row["expires_at"] <= now
            ):
                raise DriveSharingError("request_changed")
            if row["status"] == "preparing" or preparation_lease_id is not None:
                if (
                    row["status"] != "preparing"
                    or str(row["preparation_lease_id"]) != preparation_lease_id
                    or row["preparation_lease_expires_at"] is None
                    or row["preparation_lease_expires_at"] <= now
                ):
                    raise DriveSharingError("preparation_superseded")
                # Coverage/gaps derive from every model input, including
                # documents the model did not suggest. Fence the entire read
                # set in this same publication transaction, even for no matches.
                if not read_sources or len({item.document_id for item in read_sources}) != len(
                    read_sources
                ):
                    raise DriveSharingError("source_changed")
                read_ids = [str(item.document_id) for item in read_sources]
                if set(document_ids) - set(read_ids):
                    raise DriveSharingError("source_changed")
                current_reads = self._sources(
                    connection, user_id=user_id, generation=generation, document_ids=read_ids
                )
                if sorted(
                    [item.model_dump(mode="json") for item in read_sources],
                    key=lambda item: item["document_id"],
                ) != sorted(
                    [self._source_terms(item) for item in current_reads],
                    key=lambda item: item["document_id"],
                ):
                    raise DriveSharingError("source_changed")
            sources = (
                self._sources(
                    connection, user_id=user_id, generation=generation, document_ids=document_ids
                )
                if document_ids
                else []
            )
            observed = sorted(
                [item.model_dump(mode="json") for item in observed_sources],
                key=lambda item: item["document_id"],
            )
            actual = sorted(
                [self._source_terms(item) for item in sources], key=lambda item: item["document_id"]
            )
            if observed != actual:
                raise DriveSharingError("source_changed")
            # Row locks can wait beyond the caller's asyncio deadline. The
            # synchronous transaction must fence expiry after those waits.
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if row["expires_at"] <= now:
                raise DriveSharingError("request_changed")
            if preparation_lease_id is not None and row["preparation_lease_expires_at"] <= now:
                raise DriveSharingError("preparation_superseded")
            revision = row["revision"] + 1
            terms = (
                SharingApproval.model_validate(
                    {
                        "request_id": request_id,
                        "revision": revision,
                        "owner_user_id": user_id,
                        "recipient_user_id": row["recipient_user_id"],
                        "recipient_binding": row["recipient_binding"],
                        "connection_generation": generation,
                        "sources": [self._source_terms(item) for item in sources],
                    }
                )
                if sources
                else None
            )
            authority = self._authority(terms) if terms else None
            issued = (
                ActionDirectiveStore(
                    connection=connection, hmac_key=self.authority_key
                ).issue_document_review_in_transaction(authority)
                if authority
                else None
            )
            payload = {
                "approval": terms.authority_binding() if terms else None,
                "coverage": coverage,
                "files": [
                    {
                        "documentId": str(item["document_id"]),
                        "sourceVersion": item["source_version"],
                        "name": self.cipher.open(item)["name"],
                    }
                    for item in sources
                ],
            }
            digest = self.sharing_cipher.digest("review", payload)
            envelope = self.sharing_cipher.seal(
                payload, user_id=user_id, resource_id=f"{request_id}:{revision}", purpose="review"
            )
            connection.execute(
                text("""
                INSERT INTO drive_share_reviews(request_id,revision,user_id,connection_generation,
                  review_envelope,review_digest,directive_id,expires_at)
                VALUES (:id,:revision,:user,:generation,CAST(:envelope AS jsonb),:digest,:directive,
                  clock_timestamp()+INTERVAL '5 minutes')
            """),
                {
                    "id": request_id,
                    "revision": revision,
                    "user": user_id,
                    "generation": generation,
                    "envelope": json.dumps(envelope),
                    "digest": digest,
                    "directive": issued.directive_id if issued else None,
                },
            )
            updated = self._row(
                connection,
                """
                UPDATE drive_share_requests SET revision=:revision,status='review_ready',
                  updated_at=clock_timestamp(),preparation_lease_id=NULL,preparation_lease_expires_at=NULL
                WHERE request_id=:id RETURNING *
            """,
                {"id": request_id, "revision": revision},
            )
            self._event(connection, updated, user_id, "document_share_review_ready")
            return {**self._summary(updated), "reviewDigest": digest}

        return cast(dict, await self._transaction(operation))

    async def approve_review(
        self,
        *,
        user_id: str,
        generation: int,
        request_id: str,
        revision: int,
        review_digest: str,
        document_ids: list[str],
        confirmed: bool,
    ) -> dict:
        self._sharing_admission(user_id)
        if confirmed is not True:
            raise DriveSharingError("explicit_approval_required")

        def operation(connection):
            self._participant_gate(connection, user_id, request_id)
            self._active(connection, user_id, generation)
            self._selection_policy(connection, user_id, feature="drive_document_sharing")
            request = self._related_request(connection, user_id, request_id)
            review = self._row(
                connection,
                """
                SELECT * FROM drive_share_reviews WHERE request_id=:id AND user_id=:user AND revision=:revision FOR UPDATE
            """,
                {"id": request_id, "user": user_id, "revision": revision},
            )
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                not review
                or request["revision"] != revision
                or review["review_digest"] != review_digest
                or request["status"] != "review_ready"
                or review["decision"] is not None
                or review["expires_at"] <= now
                or request["expires_at"] <= now
                or review["connection_generation"] != generation
                or not review["directive_id"]
            ):
                raise DriveSharingError("review_changed")
            payload = self.sharing_cipher.open(
                review["review_envelope"],
                user_id=user_id,
                resource_id=f"{request_id}:{revision}",
                purpose="review",
            )
            approval = SharingApproval.model_validate(payload["approval"])
            sources = self._sources(
                connection, user_id=user_id, generation=generation, document_ids=document_ids
            )
            current = SharingApproval.model_validate(
                {
                    **approval.model_dump(),
                    "recipient_binding": request["recipient_binding"],
                    "recipient_user_id": request["recipient_user_id"],
                    "sources": [self._source_terms(item) for item in sources],
                }
            )
            if current.authority_binding() != approval.authority_binding():
                raise DriveSharingError("review_changed")
            ledger = ActionDirectiveStore(connection=connection, hmac_key=self.authority_key)
            authority = self._authority(current)
            receipt = ledger.confirm_document_review_in_transaction(
                directive_id=review["directive_id"], authority=authority, trusted_activation=True
            )
            batch = ledger.claim_document_review_in_transaction(
                directive_id=review["directive_id"], authority=authority, receipt=receipt.receipt
            )
            recipient = self._open_request(request)["recipient"]
            for source in sources:
                metadata = self.cipher.open(source)
                operation_id = str(uuid4())
                plan = self.sharing_cipher.seal(
                    {
                        "file_id": metadata["file_id"],
                        "file_name": metadata["name"],
                        "source_version": source["source_version"],
                        "recipient": recipient,
                        "approval": current.authority_binding(),
                    },
                    user_id=user_id,
                    resource_id=operation_id,
                    purpose="permission-plan",
                )
                connection.execute(
                    text("""
                    INSERT INTO drive_share_permission_operations(operation_id,user_id,request_id,
                      review_revision,batch_id,document_id,connection_generation,file_lock_hmac,kind,plan_envelope)
                    VALUES (:id,:user,:request,:revision,:batch,:document,:generation,:lock,'grant',CAST(:plan AS jsonb))
                """),
                    {
                        "id": operation_id,
                        "user": user_id,
                        "request": request_id,
                        "revision": revision,
                        "batch": batch,
                        "document": source["document_id"],
                        "generation": generation,
                        "lock": self.sharing_cipher.file_lock(metadata["file_id"]),
                        "plan": json.dumps(plan),
                    },
                )
            connection.execute(
                text("""
                UPDATE drive_share_reviews SET decision='approved',decided_at=clock_timestamp()
                WHERE request_id=:id AND revision=:revision
            """),
                {"id": request_id, "revision": revision},
            )
            updated = self._row(
                connection,
                """
                UPDATE drive_share_requests SET status='approved',updated_at=clock_timestamp()
                WHERE request_id=:id RETURNING *
            """,
                {"id": request_id},
            )
            self._event(connection, updated, request["recipient_user_id"], "document_share_decided")
            return {**self._summary(updated), "sharingStatus": "pending", "fileCount": len(sources)}

        return cast(dict, await self._transaction(operation))

    async def request_status(self, *, user_id: str, request_id: str) -> dict:
        """Participant-only, safe to refresh while locked; no private matches."""

        def operation(connection):
            row = self._row(
                connection,
                """
                SELECT * FROM drive_share_requests WHERE request_id=:id
                  AND (user_id=:user OR recipient_user_id=:user)
            """,
                {"id": str(UUID(request_id)), "user": user_id},
            )
            if not row:
                context = self._row(
                    connection,
                    """
                    SELECT request_id,revocation_revision FROM drive_share_management_contexts
                    WHERE request_id=:id AND user_id=:user AND private_request_erased_at IS NOT NULL
                """,
                    {"id": str(UUID(request_id)), "user": user_id},
                )
                if not context:
                    raise DriveSharingError("request_unavailable")
                return {
                    "requestId": request_id,
                    "status": "management_only",
                    "revision": context["revocation_revision"],
                }
            return self._summary(row, recipient=row["recipient_user_id"] == user_id)

        return cast(dict, await self._transaction(operation))

    async def owner_review(self, *, user_id: str, request_id: str) -> dict:
        """Service must require current Vault Owner authority; never cache this result."""

        def operation(connection):
            participants = self._participant_gate(connection, user_id, request_id)
            current_connection = self._lock(
                connection, {"user_id": user_id, "connector_id": "google_drive"}
            )
            admitted = True
            try:
                self._active(connection, user_id, current_connection["connection_generation"])
                self._selection_policy(connection, user_id, feature="drive_document_sharing")
                self._relationship(connection, user_id, participants["recipient_user_id"])
            except DriveReadError:
                admitted = False
            row = self._request(connection, user_id, request_id)
            private = self._open_request(row)
            review = self._row(
                connection,
                """
                SELECT * FROM drive_share_reviews WHERE request_id=:id AND revision=:revision
            """,
                {"id": request_id, "revision": row["revision"]},
            )
            result = {
                **self._summary(row),
                "purpose": private["purpose"],
                "recipientEmail": private["recipient"]["email"],
                "role": "reader",
                "duration": "until_revoked",
                "originalsRemainInDrive": True,
                "files": [],
                "coverage": None,
                "canApprove": False,
                "preparationError": row.get("preparation_error_code"),
            }
            if review:
                payload = self.sharing_cipher.open(
                    review["review_envelope"],
                    user_id=user_id,
                    resource_id=f"{request_id}:{row['revision']}",
                    purpose="review",
                )
                now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
                if admitted and payload["approval"]:
                    approval = SharingApproval.model_validate(payload["approval"])
                    try:
                        sources = self._sources(
                            connection,
                            user_id=user_id,
                            generation=current_connection["connection_generation"],
                            document_ids=[str(item.document_id) for item in approval.sources],
                        )
                        actual = SharingApproval.model_validate(
                            {
                                **approval.model_dump(),
                                "sources": [self._source_terms(item) for item in sources],
                            }
                        )
                        admitted = actual.authority_binding() == approval.authority_binding()
                    except DriveReadError:
                        admitted = False
                result.update(
                    {
                        "files": payload["files"],
                        "coverage": payload["coverage"],
                        "reviewDigest": review["review_digest"],
                        "expiresAt": review["expires_at"].isoformat(),
                        "canApprove": row["status"] == "review_ready"
                        and admitted
                        and review["connection_generation"]
                        == current_connection["connection_generation"]
                        and review["directive_id"] is not None
                        and review["decision"] is None
                        and review["expires_at"] > now
                        and row["expires_at"] > now,
                    }
                )
            return result

        return cast(dict, await self._transaction(operation))

    async def decline_or_cancel(
        self, *, user_id: str, request_id: str, revision: int, decision: str
    ) -> dict:
        if decision not in {"declined", "cancelled"}:
            raise DriveSharingError("decision_not_allowed")

        def operation(connection):
            self._participant_gate(
                connection, user_id, request_id, recipient=decision == "cancelled"
            )
            row = self._request(connection, user_id, request_id, recipient=decision == "cancelled")
            if row["revision"] != revision:
                raise DriveSharingError("review_changed")
            if row["status"] == decision:
                return self._summary(row, recipient=decision == "cancelled")
            if row["status"] not in {"pending", "preparing", "review_ready"}:
                # An approved Google effect requires a separately reviewed revoke.
                raise DriveSharingError("request_already_decided")
            connection.execute(
                text("""
                UPDATE one_action_directive_ledger SET state='cancelled',settled_at=clock_timestamp(),
                  settlement_status='cancelled',settlement_reason_code='document_request_cancelled'
                WHERE channel='document_review' AND document_request_id=:id AND user_id=:owner
                  AND state IN ('issued','confirmed')
            """),
                {"id": request_id, "owner": row["user_id"]},
            )
            if decision == "declined":
                connection.execute(
                    text("""
                    UPDATE drive_share_reviews SET decision='declined',decided_at=clock_timestamp()
                    WHERE request_id=:id AND revision=:revision AND decision IS NULL
                """),
                    {"id": request_id, "revision": revision},
                )
            updated = self._row(
                connection,
                """
                UPDATE drive_share_requests SET status=:status,updated_at=clock_timestamp(),
                  preparation_lease_id=NULL,preparation_lease_expires_at=NULL
                WHERE request_id=:id RETURNING *
            """,
                {"id": request_id, "status": decision},
            )
            self._event(
                connection,
                updated,
                row["recipient_user_id"] if decision == "declined" else row["user_id"],
                "document_share_decided",
            )
            return self._summary(updated, recipient=decision == "cancelled")

        return cast(dict, await self._transaction(operation))
