"""Durable private requests and atomic exact-file approval, with no provider I/O.

Lock order: participant graph gates, Drive connection, registry policy, relationship, request, ordered
selected documents, confirmation ledger. Encrypted permission work survives
disconnect and removal of the index. A queued operation is not Google success.
"""

from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from typing import cast
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import ActionDirectiveStore, DocumentReviewAuthority
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_document_store import (
    PROCESSING_DISCLOSURE_VERSION,
    DriveDocumentStore,
)
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_sharing_contract import (
    BROAD_TRUST_DISCLOSURE,
    BROAD_TRUST_SCOPE,
    LEGACY_TRUST_SCOPE,
    MAX_FILES,
    SHARING_ACTION,
    DriveSharingCipher,
    DriveSharingError,
    LiveReviewedSource,
    ReviewedSource,
    ShareRequestPurpose,
    SharingApproval,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.google_drive_adapter import FILE_ID, LIVE_POLICY_HASH, DriveReadError


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
        row = self._row(
            connection,
            """
            SELECT id FROM connections WHERE status='active'
              AND ((user_a_id=:owner AND user_b_id=:recipient)
                OR (user_a_id=:recipient AND user_b_id=:owner))
            FOR SHARE
        """,
            {"owner": owner, "recipient": recipient},
        )
        if owner == recipient or not row:
            raise DriveSharingError("connection_required")

    @staticmethod
    def _trusted_recipient_current(connection, owner: str, recipient: str) -> bool:
        """Only an accepted pair in the owner's active Trusted roster may auto share.

        A circle co-member or imported contact is not an accepted pair.
        Absence of the owner's active roster entry fails closed.
        Callers recheck this at request creation and immediately before each
        provider grant; the encrypted request marker alone is not authority.
        """
        if owner == recipient or not connector_feature_enabled("drive_document_sharing", recipient):
            return False
        return bool(
            connection.execute(
                text("""
                SELECT EXISTS(
                  SELECT 1 FROM connections conn
                  JOIN connection_origins origin ON origin.connection_id=conn.id
                    AND origin.status='active'
                    AND origin.origin_kind IN ('direct_request','legacy_invite')
                  WHERE conn.status='active'
                    AND ((conn.user_a_id=:owner AND conn.user_b_id=:recipient)
                      OR (conn.user_b_id=:owner AND conn.user_a_id=:recipient))
                    AND EXISTS(
                      SELECT 1 FROM one_location_circles circle
                      JOIN one_location_circle_memberships member
                        ON member.circle_id=circle.id
                      WHERE circle.owner_user_id=:owner
                        AND circle.system_kind='trusted' AND circle.status='active'
                        AND member.user_id=:recipient AND member.status='active'
                    )
                )
                """),
                {"owner": owner, "recipient": recipient},
            ).scalar_one()
        )

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
        # No filenames, counts or private failure details for B.
        state = row["status"]
        if state in {"pending", "preparing", "review_ready"} and row["expires_at"] <= datetime.now(
            UTC
        ):
            state = "expired"
        if recipient and state in {"preparing", "review_ready"}:
            state = "pending"
        if recipient and state == "no_match":
            state = "no_files_shared"
        return {"requestId": str(row["request_id"]), "status": state, "revision": row["revision"]}

    @staticmethod
    def _payment_metadata(connection, request_id):
        order = (
            connection.execute(
                text("""SELECT status,amount_cents,currency,reconciliation_required
                FROM drive_request_payment_orders WHERE request_id=:request"""),
                {"request": request_id},
            )
            .mappings()
            .first()
        )
        return (
            {
                "paymentStatus": order["status"],
                "paymentAmountCents": order["amount_cents"],
                "paymentCurrency": order["currency"],
                "paymentReconciliationRequired": order["reconciliation_required"] is True,
            }
            if order
            else {}
        )

    def _open_request(self, row):
        return self.sharing_cipher.open(
            row["request_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["request_id"]),
            purpose="request",
        )

    async def trusted_request_authority(self, *, user_id: str, request_id: str) -> dict:
        """Recheck a new trusted request and explicit background Drive authority.

        This is a worker-only authority check, never an owner-session bypass in
        a public route. It is repeated around planning and every batch queue.
        """
        self._sharing_admission(user_id)
        if not connector_feature_enabled("google_drive_chat_reads", user_id):
            raise DriveSharingError("trusted_request_unavailable")
        identity = str(UUID(request_id))

        def operation(connection):
            participants = self._participant_gate(connection, user_id, identity)
            preferences = DriveLivePreferences(db=self.db)
            current = preferences.live_active(connection, user_id=user_id)
            preferences.background_current(
                connection, user_id=user_id, generation=current["connection_generation"]
            )
            row = self._related_request(connection, user_id, identity)
            if (
                row["status"] != "pending"
                or row["preparation_error_code"] == "manual_search_active"
                or row["expires_at"]
                <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
                or self._open_request(row).get("trusted_auto") is not True
                or not self._trusted_recipient_current(
                    connection, user_id, participants["recipient_user_id"]
                )
            ):
                raise DriveSharingError("trusted_request_unavailable")
            if row["bulk_search_started_at"] is not None:
                search = self._row(
                    connection,
                    """SELECT job_id,checkpoint_envelope FROM drive_owner_search_jobs
                      WHERE user_id=:user AND client_request_id=:request""",
                    {"user": user_id, "request": identity},
                )
                if search is not None:
                    checkpoint = self.sharing_cipher.open(
                        search["checkpoint_envelope"],
                        user_id=user_id,
                        resource_id=str(search["job_id"]),
                        purpose="owner-search-checkpoint",
                    )
                    if checkpoint.get("authority_mode") != "trusted_auto":
                        raise DriveSharingError("trusted_request_unavailable")
            return {
                "requestId": identity,
                "recipientUserId": row["recipient_user_id"],
                "searchStarted": row["bulk_search_started_at"] is not None,
                "status": row["status"],
                "generation": current["connection_generation"],
            }

        return cast(dict, await self._transaction(operation))

    async def due_trusted_searches(self, *, limit: int = 4) -> list[dict]:
        """Rotate only new, live-Drive requests; encrypted marker is inspected here."""
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("invalid trusted search bound")

        def operation(connection):
            rows = connection.execute(
                text("""
                WITH due AS (
                  SELECT r.request_id FROM drive_share_requests r
                  JOIN user_external_connector_connections c ON c.user_id=r.user_id
                    AND c.connector_id='google_drive' AND c.status='connected'
                    AND c.validation_state='verified'
                    AND c.verified_policy_hash=:policy
                  WHERE r.status='pending' AND r.bulk_search_started_at IS NULL
                    AND r.preparation_error_code IN
                      ('trusted_auto_queued','background_preparation_required')
                    AND r.expires_at>clock_timestamp()
                    AND r.preparation_next_at<=clock_timestamp()
                  ORDER BY r.preparation_inspected_at,r.created_at,r.request_id
                  LIMIT :limit FOR UPDATE OF r SKIP LOCKED
                )
                UPDATE drive_share_requests r SET preparation_inspected_at=clock_timestamp()
                FROM due WHERE r.request_id=due.request_id RETURNING r.*
                """),
                {"policy": LIVE_POLICY_HASH, "limit": limit},
            ).mappings()
            return [
                {"user_id": row["user_id"], "request_id": str(row["request_id"])}
                for row in rows
                if self._open_request(row).get("trusted_auto") is True
            ]

        return cast(list[dict], await self._transaction(operation))

    async def due_trusted_batches(self, *, limit: int = 4) -> list[dict]:
        """Continue one 25-file batch per active request, including completed searches."""
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("invalid trusted batch bound")

        def operation(connection):
            rows = connection.execute(
                text("""
                WITH due AS (
                  SELECT r.request_id FROM drive_share_requests r
                  JOIN drive_owner_search_jobs j ON j.user_id=r.user_id
                    AND j.client_request_id=r.request_id
                  WHERE r.status='pending' AND r.bulk_search_started_at IS NOT NULL
                    AND r.preparation_error_code IN
                      ('trusted_auto_active','background_preparation_required')
                    AND r.preparation_next_at<=clock_timestamp()
                    AND r.expires_at>clock_timestamp()
                    AND j.status IN ('queued','running','completed')
                  ORDER BY r.preparation_inspected_at,r.created_at,r.request_id
                  LIMIT :limit FOR UPDATE OF r SKIP LOCKED
                )
                UPDATE drive_share_requests r SET preparation_inspected_at=clock_timestamp()
                FROM due WHERE r.request_id=due.request_id RETURNING r.*
                """),
                {"limit": limit},
            ).mappings()
            return [
                {"user_id": row["user_id"], "request_id": str(row["request_id"])}
                for row in rows
                if self._open_request(row).get("trusted_auto") is True
            ]

        return cast(list[dict], await self._transaction(operation))

    async def trusted_request_for_job(self, *, user_id: str, job_id: str) -> str | None:
        """Identify an automatic request without exposing its private query."""
        identity = str(UUID(job_id))

        def operation(connection):
            row = self._row(
                connection,
                """SELECT r.*,j.checkpoint_envelope,j.job_id FROM drive_owner_search_jobs j
                  JOIN drive_share_requests r ON r.request_id=j.client_request_id
                    AND r.user_id=j.user_id
                  WHERE j.job_id=:job AND j.user_id=:user
                    AND r.bulk_search_started_at IS NOT NULL
                    AND r.preparation_error_code<>'manual_search_active'
                    AND r.expires_at>clock_timestamp()""",
                {"job": identity, "user": user_id},
            )
            if row is None or self._open_request(row).get("trusted_auto") is not True:
                return None
            checkpoint = self.sharing_cipher.open(
                row["checkpoint_envelope"],
                user_id=user_id,
                resource_id=str(row["job_id"]),
                purpose="owner-search-checkpoint",
            )
            return (
                str(row["request_id"])
                if checkpoint.get("authority_mode") == "trusted_auto"
                else None
            )

        return cast(str | None, await self._transaction(operation))

    async def defer_trusted_search(self, *, user_id: str, request_id: str, code: str) -> None:
        """Make missing background authority visible and avoid a hot retry loop."""
        if code not in {
            "date_range_required",
            "background_preparation_required",
            "preparation_unavailable",
            "trusted_relationship_changed",
        }:
            code = "preparation_unavailable"

        def operation(connection):
            # Serialize with background preference changes so an enabled owner
            # cannot leave this request parked until the next scheduler pass.
            connector = self._row(
                connection,
                """SELECT connection_generation FROM user_external_connector_connections
                  WHERE user_id=:user AND connector_id='google_drive' FOR UPDATE""",
                {"user": user_id},
            )
            background_ready = False
            if code == "background_preparation_required" and connector is not None:
                try:
                    DriveLivePreferences(db=self.db).background_current(
                        connection,
                        user_id=user_id,
                        generation=connector["connection_generation"],
                    )
                    background_ready = True
                except DriveReadError:
                    pass
            row = self._row(
                connection,
                """SELECT * FROM drive_share_requests WHERE request_id=:request
                  AND user_id=:user FOR UPDATE""",
                {"request": str(UUID(request_id)), "user": user_id},
            )
            if (
                row is None
                or row["status"] != "pending"
                or row["preparation_error_code"] == "manual_search_active"
                or self._open_request(row).get("trusted_auto") is not True
            ):
                return
            has_job = bool(
                self._row(
                    connection,
                    """SELECT job_id FROM drive_owner_search_jobs
                   WHERE user_id=:user AND client_request_id=:request""",
                    {"user": user_id, "request": row["request_id"]},
                )
            )
            attempts = row["preparation_attempts"] + int(code == "preparation_unavailable")
            terminal = code == "preparation_unavailable" and attempts >= 3
            if code == "date_range_required":
                visible_code = "date_range_required"
            elif code == "background_preparation_required":
                visible_code = (
                    ("trusted_auto_active" if has_job else "trusted_auto_queued")
                    if background_ready
                    else "background_preparation_required"
                )
            elif code == "trusted_relationship_changed":
                visible_code = "trusted_relationship_changed"
            elif terminal:
                visible_code = "preparation_unavailable"
            else:
                visible_code = "trusted_auto_active" if has_job else "trusted_auto_queued"
            updated = self._row(
                connection,
                """UPDATE drive_share_requests
                  SET preparation_error_code=:code,
                    preparation_attempts=:attempts,
                    preparation_next_at=CASE WHEN :needs_dates THEN expires_at
                      WHEN :ready THEN clock_timestamp()
                      ELSE clock_timestamp()+INTERVAL '5 minutes' END,
                    bulk_search_started_at=CASE WHEN :has_job THEN bulk_search_started_at ELSE NULL END,
                    updated_at=clock_timestamp()
                  WHERE request_id=:request RETURNING *""",
                {
                    "request": row["request_id"],
                    "code": visible_code,
                    "attempts": attempts,
                    "has_job": has_job,
                    "ready": background_ready,
                    "needs_dates": code == "date_range_required",
                },
            )
            if visible_code in {
                "date_range_required",
                "background_preparation_required",
                "preparation_unavailable",
                "trusted_relationship_changed",
            }:
                # This is a one-time setup notice, not a file-review request.
                # The event uniqueness key includes the unchanged revision.
                self._event(connection, updated, user_id, "document_share_request")

        await self._transaction(operation)

    async def request_bulk_context(self, *, user_id: str, request_id: str, start=False) -> dict:
        """Freeze B's request as the sole audience for a durable metadata search."""
        identity = str(UUID(request_id))

        def operation(connection):
            row = self._related_request(connection, user_id, identity)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if row["expires_at"] <= now or row["status"] in {"cancelled", "declined", "expired"}:
                raise DriveSharingError("request_unavailable")
            if start and row["status"] in {"approved", "completed", "partial", "no_match"}:
                raise DriveSharingError("request_changed")
            if start and row["bulk_search_started_at"] is None:
                row = self._row(
                    connection,
                    """UPDATE drive_share_requests SET bulk_search_started_at=clock_timestamp(),
                      status='pending',preparation_lease_id=NULL,preparation_lease_expires_at=NULL,
                      preparation_error_code=CASE
                        WHEN preparation_error_code IN
                          ('trusted_auto_queued','background_preparation_required')
                        THEN 'trusted_auto_active'
                        WHEN preparation_error_code='manual_search_active'
                        THEN 'manual_search_active' ELSE NULL END,
                      updated_at=clock_timestamp()
                      WHERE request_id=:request RETURNING *""",
                    {"request": identity},
                )
            private = self._open_request(row)
            return {
                "requestId": identity,
                "revision": row["revision"],
                "status": row["status"],
                "purpose": private["purpose"],
                "requestTimeZone": private.get("request_time_zone"),
                "requestCreatedAt": row["created_at"],
                "recipient": private["recipient"],
                "recipientUserId": row["recipient_user_id"],
                "recipientBinding": row["recipient_binding"],
                "searchStarted": row["bulk_search_started_at"] is not None,
            }

        return cast(dict, await self._transaction(operation))

    async def create_request(
        self,
        *,
        recipient: VerifiedGoogleRecipient,
        owner_user_id: str,
        client_request_id: str,
        purpose: ShareRequestPurpose,
        request_time_zone: str | None = None,
        owner_initiated: bool = False,
    ) -> dict:
        """B's authenticated identity must be verified by the service before calling.

        owner_initiated: A shares files A chose from B's question. Background
        preparation never runs for it and A is not notified of A's own action.
        """
        if not owner_initiated and (purpose.periodStart is None or purpose.periodEnd is None):
            raise DriveSharingError("date_range_required")
        self._sharing_admission(recipient.user_id)
        self._sharing_admission(owner_user_id)
        age = (datetime.now(UTC) - recipient.verified_at).total_seconds()
        if not 0 <= age <= 300:
            raise DriveSharingError("verify_google_identity_required")
        if request_time_zone is not None:
            try:
                if not isinstance(request_time_zone, str) or not 1 <= len(request_time_zone) <= 64:
                    raise ValueError()
                ZoneInfo(request_time_zone)
            except (ValueError, ZoneInfoNotFoundError):
                raise DriveSharingError("invalid_argument") from None
        client_request_id = str(UUID(client_request_id))
        request_id = str(uuid4())
        payload = {
            "purpose": purpose.model_dump(),
            **({"request_time_zone": request_time_zone} if request_time_zone else {}),
            "recipient": {
                "user_id": recipient.user_id,
                "subject": recipient.subject,
                "email": recipient.email,
                "verified_at": recipient.verified_at.isoformat(),
                **({"kind": recipient.kind} if recipient.kind != "google_provider" else {}),
            },
        }
        binding = self.sharing_cipher.recipient_binding(recipient)
        digest = self.sharing_cipher.digest(
            "request", [owner_user_id, binding, purpose.model_dump()]
        )

        def operation(connection):
            lock_connection_graph_users(connection, user_ids=[owner_user_id, recipient.user_id])
            live_connection = self._row(
                connection,
                """SELECT status,validation_state,verified_policy_hash
                   FROM user_external_connector_connections
                   WHERE user_id=:user AND connector_id='google_drive' FOR SHARE""",
                {"user": owner_user_id},
            )
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
            # Only newly created requests receive this authority marker. An
            # old pending request must not turn into an automatic grant after
            # a deploy, and owner-initiated sharing keeps its own review path.
            trusted_auto = bool(
                not owner_initiated
                and connector_feature_enabled("google_drive_chat_reads", owner_user_id)
                and live_connection
                and live_connection["status"] == "connected"
                and live_connection["validation_state"] == "verified"
                and live_connection["verified_policy_hash"] == LIVE_POLICY_HASH
                and self._trusted_recipient_current(connection, owner_user_id, recipient.user_id)
            )
            payment_required = (
                trusted_auto
                and os.getenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "").strip().lower() == "true"
            )
            if payment_required:
                from hushh_mcp.services.drive_request_payment_service import (
                    require_payment_configuration,
                )

                require_payment_configuration()
            envelope = self.sharing_cipher.seal(
                {**payload, **({"trusted_auto": True} if trusted_auto else {})},
                user_id=owner_user_id,
                resource_id=request_id,
                purpose="request",
            )
            row = self._row(
                connection,
                """
                INSERT INTO drive_share_requests(request_id,user_id,recipient_user_id,client_request_id,
                  request_envelope,recipient_binding,request_digest,preparation_error_code,
                  payment_required)
                VALUES (:id,:owner,:recipient,:client,CAST(:envelope AS jsonb),:binding,:digest,
                  :preparation_code,:payment_required)
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
                    "preparation_code": "trusted_auto_queued" if trusted_auto else None,
                    "payment_required": payment_required,
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
                if owner_initiated:
                    # Only the owner's own foreground selection may prepare it.
                    row = self._row(
                        connection,
                        """
                        UPDATE drive_share_requests SET preparation_next_at=expires_at
                        WHERE request_id=:id RETURNING *
                    """,
                        {"id": request_id},
                    )
                elif not trusted_auto:
                    self._event(connection, row, owner_user_id, "document_share_request")
            return self._summary(row, recipient=True)

        return cast(dict, await self._transaction(operation))

    def _sources(self, connection, *, user_id, generation, document_ids, request_id=None):
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
            if row:
                if (
                    row["connection_generation"] != generation
                    or row["status"] != "ready"
                    or not row["active_version"]
                    or not row["processing_enabled"]
                    or row["processing_disclosure_version"] != PROCESSING_DISCLOSURE_VERSION
                ):
                    raise DriveSharingError("source_changed")
                rows.append(row)
                continue
            live = (
                self._row(
                    connection,
                    """SELECT * FROM drive_share_live_sources WHERE user_id=:user
                   AND request_id=:request AND document_id=:id FOR UPDATE""",
                    {"user": user_id, "request": request_id, "id": identifier},
                )
                if request_id
                else None
            )
            if not live or live["connection_generation"] != generation:
                raise DriveSharingError("source_changed")
            DriveLivePreferences(db=self.db).live_active(
                connection, user_id=user_id, generation=generation
            )
            rows.append({**live, "_live": True})
        return rows

    def _source_terms(self, row):
        if row.get("_live"):
            metadata = self._source_metadata(row)
            return LiveReviewedSource(
                document_id=row["document_id"],
                source_version=row["source_version"],
                provider_file_binding=self.sharing_cipher.digest("live-file", metadata["file_id"]),
                connection_generation=row["connection_generation"],
            ).model_dump(mode="json")
        return {
            "document_id": str(row["document_id"]),
            "source_version": row["source_version"],
            "source_fingerprint": row["source_fingerprint"],
            "index_version": row["active_version"],
            "processing_revision": row["processing_revision"],
        }

    def _source_metadata(self, row):
        if row.get("_live"):
            if "source_envelope" not in row:
                return {
                    "file_id": row["file_id"],
                    "name": row["name"],
                    "content_fingerprint": row["content_fingerprint"],
                    "metadata_only": row.get("metadata_only", False),
                    "time_field": row.get("time_field"),
                    "start_time": row.get("start_time"),
                    "end_time": row.get("end_time"),
                }
            return self.sharing_cipher.open(
                row["source_envelope"],
                user_id=row["user_id"],
                resource_id=f"{row['request_id']}:{row['document_id']}",
                purpose="live-source",
            )
        return self.cipher.open(row)

    def _admit_sources(self, connection, *, user_id, generation, sources):
        live = [item for item in sources if isinstance(item, LiveReviewedSource)]
        if live:
            if len(live) != len(sources):
                raise DriveSharingError("source_changed")
            DriveLivePreferences(db=self.db).live_active(
                connection, user_id=user_id, generation=generation
            )
            self._sharing_admission(user_id)
        else:
            self._active(connection, user_id, generation)
            self._selection_policy(connection, user_id, feature="drive_document_sharing")

    def _live_preparation_access(self, connection, *, user_id, generation, foreground=False):
        # foreground is an in-process route authority, never a request-body flag
        # or persisted worker capability. The service owns its live token fence.
        preferences = DriveLivePreferences(db=self.db)
        check = preferences.live_active if foreground else preferences.background_current
        return check(connection, user_id=user_id, generation=generation)

    def _store_live_observations(
        self, connection, *, user_id, generation, request_id, rows, foreground=False
    ):
        if not rows:
            return
        self._live_preparation_access(
            connection, user_id=user_id, generation=generation, foreground=foreground
        )
        if len(rows) > MAX_FILES or len({row.get("document_id") for row in rows}) != len(rows):
            raise DriveSharingError("invalid_selection")
        for row in rows:
            file_id = row.get("file_id")
            metadata_only = row.get("metadata_only") is True
            fingerprint = row.get("content_fingerprint")
            valid_fingerprint = (
                fingerprint is None
                if metadata_only
                else isinstance(fingerprint, str)
                and re.fullmatch(r"[0-9a-f]{64}", fingerprint) is not None
            )
            valid_time_window = (
                row.get("time_field") in {"modifiedTime", "createdTime"}
                and all(
                    isinstance(row.get(key), str)
                    and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", row[key])
                    for key in ("start_time", "end_time")
                )
                if metadata_only
                else True
            )
            if metadata_only and valid_time_window:
                try:
                    valid_time_window = datetime.fromisoformat(
                        row["start_time"].replace("Z", "+00:00")
                    ) < datetime.fromisoformat(row["end_time"].replace("Z", "+00:00"))
                except ValueError:
                    valid_time_window = False
            if (
                row.get("_live") is not True
                or not isinstance(file_id, str)
                or not FILE_ID.fullmatch(file_id)
                or row.get("connection_generation") != generation
                or not isinstance(row.get("name"), str)
                or not 1 <= len(row["name"]) <= 1024
                or not isinstance(row.get("source_version"), str)
                or not row["source_version"].isdigit()
                or not valid_fingerprint
                or not valid_time_window
            ):
                raise DriveSharingError("source_changed")
            document_id = str(UUID(str(row["document_id"])))
            envelope = self.sharing_cipher.seal(
                {
                    "file_id": file_id,
                    "name": row["name"],
                    "content_fingerprint": fingerprint,
                    "metadata_only": metadata_only,
                    **(
                        {
                            "time_field": row["time_field"],
                            "start_time": row["start_time"],
                            "end_time": row["end_time"],
                        }
                        if metadata_only
                        else {}
                    ),
                },
                user_id=user_id,
                resource_id=f"{request_id}:{document_id}",
                purpose="live-source",
            )
            connection.execute(
                text("""INSERT INTO drive_share_live_sources
                  (request_id,document_id,user_id,connection_generation,source_envelope,source_version)
                  VALUES (:request,:document,:user,:generation,CAST(:envelope AS jsonb),:version)
                  ON CONFLICT (request_id,document_id) DO UPDATE SET
                    source_envelope=EXCLUDED.source_envelope,
                    source_version=EXCLUDED.source_version,
                    connection_generation=EXCLUDED.connection_generation"""),
                {
                    "request": request_id,
                    "document": document_id,
                    "user": user_id,
                    "generation": generation,
                    "envelope": json.dumps(envelope),
                    "version": row["source_version"],
                },
            )

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

    def _rule_covers_boundary(self, boundary, *, request, sources):
        scope = boundary.get("scope", LEGACY_TRUST_SCOPE)
        if scope == BROAD_TRUST_SCOPE:
            return boundary.get("disclosureVersion") == BROAD_TRUST_DISCLOSURE
        if scope != LEGACY_TRUST_SCOPE:
            return False
        try:
            if any(self._source_metadata(item).get("metadata_only") for item in sources):
                return False
            return boundary.get("purpose_digest") == self.sharing_cipher.digest(
                "rule-purpose", self._open_request(request)["purpose"]
            ) and sorted(
                (item["file_id"], item["content_fingerprint"]) for item in boundary["files"]
            ) == sorted(
                (
                    self._source_metadata(item)["file_id"],
                    self._source_metadata(item)["content_fingerprint"],
                )
                for item in sources
            )
        except (KeyError, TypeError):
            return False

    def _matching_rule(self, connection, *, request, sources, coverage, generation):
        if (
            not sources
            or not all(item.get("_live") for item in sources)
            or coverage.get("coverage_status") != "complete"
            or coverage.get("gaps")
            or coverage.get("truncated")
            or coverage.get("semanticStage") != "completed"
        ):
            return None
        candidates = (
            connection.execute(
                text("""SELECT * FROM drive_document_rules WHERE user_id=:user
              AND recipient_user_id=:recipient AND recipient_binding=:binding
              AND connection_generation=:generation AND active
              ORDER BY activated_at DESC LIMIT 101 FOR SHARE"""),
                {
                    "user": request["user_id"],
                    "recipient": request["recipient_user_id"],
                    "binding": request["recipient_binding"],
                    "generation": generation,
                },
            )
            .mappings()
            .all()
        )
        if len(candidates) > 100:
            return None
        for candidate in candidates:
            boundary = self.sharing_cipher.open(
                candidate["boundary_envelope"],
                user_id=request["user_id"],
                resource_id=str(candidate["rule_id"]),
                purpose="document-rule",
            )
            if self._rule_covers_boundary(boundary, request=request, sources=sources):
                return candidate
        return None

    def _queue_grants(self, connection, *, request, approval, sources, batch, rule=None):
        from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore

        DriveRequestPaymentStore.require_paid_if_required(connection, request)
        # A plan's approval must name exactly the files queued in this batch.
        if sorted(str(source["document_id"]) for source in sources) != sorted(
            str(source.document_id) for source in approval.sources
        ):
            raise DriveSharingError("invalid_selection")
        recipient = self._open_request(request)["recipient"]
        for source in sources:
            metadata = self._source_metadata(source)
            operation_id = str(uuid4())
            plan = self.sharing_cipher.seal(
                {
                    "file_id": metadata["file_id"],
                    "file_name": metadata["name"],
                    "source_version": source["source_version"],
                    "source_kind": "live" if source.get("_live") else "indexed",
                    "metadata_only": metadata.get("metadata_only") is True,
                    **(
                        {
                            "time_field": metadata["time_field"],
                            "start_time": metadata["start_time"],
                            "end_time": metadata["end_time"],
                        }
                        if metadata.get("metadata_only") is True
                        else {}
                    ),
                    "recipient": recipient,
                    "approval": approval.authority_binding(),
                    **(
                        {"rule_id": str(rule["rule_id"]), "rule_version": rule["version"]}
                        if rule
                        else {}
                    ),
                },
                user_id=request["user_id"],
                resource_id=operation_id,
                purpose="permission-plan",
            )
            connection.execute(
                text("""INSERT INTO drive_share_permission_operations(operation_id,user_id,request_id,
                  review_revision,batch_id,document_id,connection_generation,file_lock_hmac,kind,plan_envelope)
                  VALUES (:id,:user,:request,:revision,:batch,:document,:generation,:lock,'grant',CAST(:plan AS jsonb))"""),
                {
                    "id": operation_id,
                    "user": request["user_id"],
                    "request": request["request_id"],
                    "revision": approval.revision,
                    "batch": batch,
                    "document": source["document_id"],
                    "generation": approval.connection_generation,
                    "lock": self.sharing_cipher.file_lock(metadata["file_id"]),
                    "plan": json.dumps(plan),
                },
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
        read_sources: list[ReviewedSource | LiveReviewedSource] | None = None,
        live_sources: list[dict] | None = None,
        foreground: bool = False,
        notify_owner: bool = True,
    ) -> dict:
        """Called only after a tool-less suggestion pass; never shares automatically.

        Coverage is private authored model output. The store enforces bounds and
        exact source authority, not semantic relevance or date coverage.

        notify_owner=False: the owner chose these exact files and is approving
        them now, so no "ready to review" notification is queued for them.
        """
        self._sharing_admission(user_id)
        if len(json.dumps(coverage).encode()) > 16 * 1024:
            raise DriveSharingError("sharing_payload_too_large")

        def operation(connection):
            self._participant_gate(connection, user_id, request_id)
            if live_sources:
                self._live_preparation_access(
                    connection, user_id=user_id, generation=generation, foreground=foreground
                )
            else:
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
                self._store_live_observations(
                    connection,
                    user_id=user_id,
                    generation=generation,
                    request_id=request_id,
                    rows=live_sources or [],
                    foreground=foreground,
                )
                current_reads = self._sources(
                    connection,
                    user_id=user_id,
                    generation=generation,
                    document_ids=read_ids,
                    request_id=request_id,
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
                    connection,
                    user_id=user_id,
                    generation=generation,
                    document_ids=document_ids,
                    request_id=request_id,
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
            rule = (
                self._matching_rule(
                    connection,
                    request=row,
                    sources=sources,
                    coverage=coverage,
                    generation=generation,
                )
                if terms
                else None
            )
            authority = self._authority(terms) if terms else None
            issued = (
                ActionDirectiveStore(
                    connection=connection, hmac_key=self.authority_key
                ).issue_document_review_in_transaction(authority)
                if authority and not rule
                else None
            )
            payload = {
                "approval": terms.authority_binding() if terms else None,
                "coverage": coverage,
                "files": [
                    {
                        "documentId": str(item["document_id"]),
                        "sourceVersion": item["source_version"],
                        "name": self._source_metadata(item)["name"],
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
                  review_envelope,review_digest,directive_id,decision,decided_at,expires_at)
                VALUES (:id,:revision,:user,:generation,CAST(:envelope AS jsonb),:digest,:directive,
                  :decision,CASE WHEN :decision IS NULL THEN NULL ELSE clock_timestamp() END,
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
                    "decision": "approved" if rule else None,
                },
            )
            if rule:
                self._queue_grants(
                    connection,
                    request=row,
                    approval=terms,
                    sources=sources,
                    batch=f"rule:{rule['rule_id']}:{rule['version']}",
                    rule=rule,
                )
            updated = self._row(
                connection,
                """
                UPDATE drive_share_requests SET revision=:revision,status=:status,
                  updated_at=clock_timestamp(),preparation_lease_id=NULL,preparation_lease_expires_at=NULL
                WHERE request_id=:id RETURNING *
            """,
                {
                    "id": request_id,
                    "revision": revision,
                    "status": "approved" if rule else "review_ready",
                },
            )
            if rule or notify_owner:
                self._event(
                    connection,
                    updated,
                    row["recipient_user_id"] if rule else user_id,
                    "document_share_decided" if rule else "document_share_review_ready",
                )
            if rule:
                self._event(connection, updated, user_id, "document_share_decided")
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
        trust_future_requests: bool = False,
        trust_scope: str | None = None,
        trust_disclosure_version: str | None = None,
    ) -> dict:
        self._sharing_admission(user_id)
        if confirmed is not True:
            raise DriveSharingError("explicit_approval_required")
        if (trust_scope is not None or trust_disclosure_version is not None) and (
            not trust_future_requests
            or trust_scope != BROAD_TRUST_SCOPE
            or trust_disclosure_version != BROAD_TRUST_DISCLOSURE
        ):
            raise DriveSharingError("confirmation_required")

        def operation(connection):
            self._participant_gate(connection, user_id, request_id)
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
            reviewed_ids = [str(source.document_id) for source in approval.sources]
            # A confirms the complete reviewed set and shares a non-empty subset
            # of it: a file outside the review can never be granted.
            chosen = approval.narrowed_to(document_ids)
            selected_ids = {str(source.document_id) for source in chosen.sources}
            # Trust for future requests follows a review A accepted in full.
            if trust_future_requests and len(chosen.sources) != len(approval.sources):
                raise DriveSharingError("rule_not_covered")
            self._admit_sources(
                connection, user_id=user_id, generation=generation, sources=approval.sources
            )
            sources = self._sources(
                connection,
                user_id=user_id,
                generation=generation,
                document_ids=reviewed_ids,
                request_id=request_id,
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
            if trust_future_requests:
                coverage = payload.get("coverage") or {}
                if (
                    not all(source.get("_live") for source in sources)
                    or coverage.get("coverage_status") != "complete"
                    or coverage.get("gaps")
                    or coverage.get("truncated")
                ):
                    raise DriveSharingError("rule_not_covered")
            ledger = ActionDirectiveStore(connection=connection, hmac_key=self.authority_key)
            authority = self._authority(current)
            receipt = ledger.confirm_document_review_in_transaction(
                directive_id=review["directive_id"], authority=authority, trusted_activation=True
            )
            batch = ledger.claim_document_review_in_transaction(
                directive_id=review["directive_id"], authority=authority, receipt=receipt.receipt
            )
            selected = [source for source in sources if str(source["document_id"]) in selected_ids]
            # Each plan names only what A shares, so dispatch rechecks only those
            # files and a change to an unselected file cannot withdraw them.
            granted = current.narrowed_to([str(source["document_id"]) for source in selected])
            self._queue_grants(
                connection, request=request, approval=granted, sources=selected, batch=batch
            )
            if trust_future_requests:
                rule_id = str(uuid4())
                boundary = {
                    "scope": trust_scope or LEGACY_TRUST_SCOPE,
                    "disclosureVersion": trust_disclosure_version,
                    "purpose_digest": self.sharing_cipher.digest(
                        "rule-purpose", self._open_request(request)["purpose"]
                    ),
                    "purpose": self._open_request(request)["purpose"],
                    "recipient_email": self._open_request(request)["recipient"]["email"],
                    "files": [
                        {
                            "file_id": self._source_metadata(source)["file_id"],
                            "name": self._source_metadata(source)["name"],
                            "version": source["source_version"],
                            "content_fingerprint": self._source_metadata(source)[
                                "content_fingerprint"
                            ],
                        }
                        for source in sources
                    ],
                }
                envelope = self.sharing_cipher.seal(
                    boundary, user_id=user_id, resource_id=rule_id, purpose="document-rule"
                )
                connection.execute(
                    text("""INSERT INTO drive_document_rules
                      (rule_id,origin_request_id,user_id,recipient_user_id,recipient_binding,
                       connection_generation,boundary_envelope)
                      VALUES (:id,:request,:user,:recipient,:binding,:generation,CAST(:envelope AS jsonb))"""),
                    {
                        "id": rule_id,
                        "request": request_id,
                        "user": user_id,
                        "recipient": request["recipient_user_id"],
                        "binding": request["recipient_binding"],
                        "generation": generation,
                        "envelope": json.dumps(envelope),
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
            return {
                **self._summary(updated),
                "sharingStatus": "pending",
                "fileCount": len(selected),
                "trustedForDocuments": trust_future_requests,
            }

        return cast(dict, await self._transaction(operation))

    async def rule_recipient(self, *, user_id: str, request_id: str) -> dict:
        def operation(connection):
            row = self._row(
                connection,
                "SELECT * FROM drive_share_requests WHERE request_id=:id AND user_id=:user",
                {"id": str(UUID(request_id)), "user": user_id},
            )
            if not row:
                raise DriveSharingError("request_unavailable")
            return self._open_request(row)["recipient"]

        return cast(dict, await self._transaction(operation))

    def _rule_readiness(self, connection, user_id, generation):
        preferences = DriveLivePreferences(db=self.db)
        try:
            preferences.live_active(connection, user_id=user_id, generation=generation)
            preferences.background_current(connection, user_id=user_id, generation=generation)
            return "ready"
        except DriveReadError as error:
            return (
                "background_off"
                if str(error) == "background_preparation_required"
                else "reconnect_required"
            )

    async def list_rules(self, *, user_id: str) -> dict:
        def operation(connection):
            rows = (
                connection.execute(
                    text("""SELECT * FROM drive_document_rules WHERE user_id=:user AND active
                  ORDER BY activated_at DESC LIMIT 51"""),
                    {"user": user_id},
                )
                .mappings()
                .all()
            )
            if len(rows) > 50:
                raise DriveSharingError("narrow_selection_required")
            result = []
            for row in rows:
                boundary = self.sharing_cipher.open(
                    row["boundary_envelope"],
                    user_id=user_id,
                    resource_id=str(row["rule_id"]),
                    purpose="document-rule",
                )
                result.append(
                    {
                        "ruleId": str(row["rule_id"]),
                        "version": row["version"],
                        "recipientUserId": row["recipient_user_id"],
                        "recipientEmail": boundary["recipient_email"],
                        "purpose": boundary["purpose"],
                        "fileNames": [item["name"] for item in boundary["files"]],
                        "scope": boundary.get("scope", LEGACY_TRUST_SCOPE),
                        "readiness": self._rule_readiness(
                            connection, user_id, row["connection_generation"]
                        ),
                        "status": "Trusted for documents",
                    }
                )
            return {"items": result}

        return cast(dict, await self._transaction(operation))

    async def revoke_rule(
        self, *, user_id: str, rule_id: str, version: int, confirmed: bool
    ) -> dict:
        if confirmed is not True or type(version) is not int or version < 1:
            raise DriveSharingError("confirmation_required")

        def operation(connection):
            self._owner_gate(connection, user_id)
            row = self._row(
                connection,
                """SELECT * FROM drive_document_rules WHERE user_id=:user AND rule_id=:id FOR UPDATE""",
                {"user": user_id, "id": str(UUID(rule_id))},
            )
            if not row or not row["active"] or row["version"] != version:
                raise DriveSharingError("rule_changed")
            connection.execute(
                text("""UPDATE drive_document_rules SET active=FALSE,version=version+1,
                  revoked_at=clock_timestamp(),updated_at=clock_timestamp()
                  WHERE rule_id=:id"""),
                {"id": str(UUID(rule_id))},
            )
            return {"ruleId": str(UUID(rule_id)), "status": "revoked", "version": version + 1}

        return cast(dict, await self._transaction(operation))

    async def request_status(self, *, user_id: str, request_id: str) -> dict:
        """Owner-authorized participant metadata for cold review links; no matches."""

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
                    "direction": "incoming",
                }
            recipient = row["recipient_user_id"] == user_id
            return {
                **self._summary(row, recipient=recipient),
                "direction": "outgoing" if recipient else "incoming",
                **(self._payment_metadata(connection, request_id) if recipient else {}),
            }

        return cast(dict, await self._transaction(operation))

    async def lookup_client_request(self, *, user_id: str, client_request_id: str) -> dict:
        def operation(connection):
            row = self._row(
                connection,
                """SELECT * FROM drive_share_requests
                   WHERE recipient_user_id=:user AND client_request_id=:client""",
                {"user": user_id, "client": str(UUID(client_request_id))},
            )
            return self._summary(row, recipient=True) if row else {"status": "draft"}

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
                "trustedAuto": private.get("trusted_auto") is True
                and row.get("preparation_error_code") != "manual_search_active",
                "recipientEmail": private["recipient"]["email"],
                "role": "reader",
                "duration": "until_revoked",
                "originalsRemainInDrive": True,
                "files": [],
                "coverage": None,
                "canApprove": False,
                "preparationError": None
                if row.get("preparation_error_code")
                in {"trusted_auto_queued", "trusted_auto_active", "manual_search_active"}
                else row.get("preparation_error_code"),
                "durableAvailable": bool(
                    current_connection["verified_policy_hash"] == LIVE_POLICY_HASH
                    and row["preparation_next_at"] < row["expires_at"]
                    and row["status"]
                    in {
                        "pending",
                        "preparing",
                        "review_ready",
                        "approved",
                        "completed",
                        "partial",
                        "no_match",
                    }
                ),
            }
            if review and row["bulk_search_started_at"] is None:
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
                        self._admit_sources(
                            connection,
                            user_id=user_id,
                            generation=current_connection["connection_generation"],
                            sources=approval.sources,
                        )
                        sources = self._sources(
                            connection,
                            user_id=user_id,
                            generation=current_connection["connection_generation"],
                            document_ids=[str(item.document_id) for item in approval.sources],
                            request_id=request_id,
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
                        "canTrustFutureRequests": bool(
                            payload["approval"]
                            and all(item.get("_live") for item in sources)
                            and (payload.get("coverage") or {}).get("coverage_status") == "complete"
                            and not (payload.get("coverage") or {}).get("gaps")
                            and not (payload.get("coverage") or {}).get("truncated")
                        )
                        if admitted and payload["approval"]
                        else False,
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
        self,
        *,
        user_id: str,
        request_id: str,
        revision: int,
        decision: str,
        notify_recipient: bool = True,
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
            # An owner's own share that failed was never announced to the
            # recipient, so its closing is not news to them either.
            if decision == "cancelled" or notify_recipient:
                self._event(
                    connection,
                    updated,
                    row["recipient_user_id"] if decision == "declined" else row["user_id"],
                    "document_share_decided",
                )
            return self._summary(updated, recipient=decision == "cancelled")

        return cast(dict, await self._transaction(operation))
