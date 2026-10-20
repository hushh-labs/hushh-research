"""Durable owner-scoped metadata search; the job never authorizes file reads/shares.

Connection -> job lock order. Provider I/O stays outside transactions. Redis may
later admit/rate-limit work; PostgreSQL leases and atomic page commits remain
authoritative. Opaque workflow metadata is plaintext; queries, cursors, file IDs
and names use the existing Drive authenticated cipher, never the owner's key.
"""

from __future__ import annotations

import base64
import hmac
import json
import math
import random
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_owner_allowed import (
    LEGACY_REQUEST_POLICY,
    automatic_recipient_current,
)
from hushh_mcp.services.drive_request_discovery import (
    discovery_delivery,
    discovery_evidence_matches,
)
from hushh_mcp.services.drive_request_review_policy import (
    autoshare_selection,
    checkpoint_requires_owner_review,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher
from hushh_mcp.services.google_drive_adapter import DriveReadError

CONSENT_VERSION = "drive-owner-search-v1"
MAX_RESULTS = 10000
ACTIVE = frozenset({"queued", "running"})
_ROW = "SELECT * FROM drive_owner_search_jobs WHERE job_id=:job AND user_id=:user AND expires_at>clock_timestamp()"


def _semantic_binding_current(checkpoint):
    """The sealed provider is immutable; configuration changes never select a fallback."""
    binding = checkpoint.get("semantic_model_binding")
    if binding is None:
        return
    from hushh_mcp.services.drive_request_package_assessment import validate_semantic_model_binding

    try:
        if checkpoint.get("semantic_plan") is None:
            raise ValueError("model binding requires semantic request")
        validate_semantic_model_binding(binding)
    except (ValueError, TypeError):
        raise DriveReadError("search_superseded") from None


def _identity(value: str) -> str:
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise DriveReadError("invalid_argument") from None


def _bounded_selection(checkpoint):
    limit = checkpoint.get("request_result_limit")
    if limit is None:
        return None
    field = checkpoint.get("request_order_field")
    if (
        type(limit) is not int
        or not 1 <= limit <= 1000
        or field not in {"createdTime", "modifiedTime"}
    ):
        raise DriveReadError("invalid_argument")
    return limit, field


def _legacy_single_query(checkpoint):
    queries = checkpoint.get("queries")
    return (
        isinstance(queries, list)
        and len(queries) == 1
        and isinstance(queries[0], dict)
        or "queries" not in checkpoint
        and isinstance(checkpoint.get("arguments"), dict)
    )


def _selection_ready(row, checkpoint):
    return _bounded_selection(checkpoint) is None or (
        row["status"] == "completed"
        and not row["incomplete_search"]
        and checkpoint.get("request_results_finalized") is True
    )


def validate_reusable_packet(manifest, binding, user_id, *, approved_terms=False):
    if (
        not isinstance(binding, dict)
        or binding.get("ownerUserId") != user_id
        or manifest.get("owner_user_id") != user_id
        or manifest.get("state") != "ready"
        or binding.get("packetId") != manifest.get("packet_id")
        or type(binding.get("version")) is not int
        or binding["version"] != manifest.get("version")
        or binding.get("manifestDigest") != manifest.get("digest")
        or not approved_terms
        and (
            binding.get("listingRevision") != manifest.get("listing_revision")
            or binding.get("priceCents") != manifest.get("price_cents")
        )
        or not 0 < len(manifest.get("sources", [])) <= 120
    ):
        raise DriveReadError("packet_unavailable")
    return manifest


def view(row: dict) -> dict:
    return {
        "jobId": str(row["job_id"]),
        "status": row["status"],
        "revision": row["revision"],
        "matched": row["matched"],
        "unshareableCount": row.get("unshareable_count", 0),
        "pagesScanned": row["pages_scanned"],
        "incompleteSearch": row["incomplete_search"],
        "canStop": row["status"] in ACTIVE,
        "createdAt": row["created_at"].isoformat(),
        "updatedAt": row["updated_at"].isoformat(),
        "expiresAt": row["expires_at"].isoformat(),
        "errorCode": row["error_code"],
    }


class DriveOwnerSearchStore(DriveLivePreferences):
    def __init__(self, db=None, *, cipher=None):
        super().__init__(db)
        self.search_cipher = cipher or DriveSharingCipher()

    def _access(self, connection, user_id, generation=None, *, read_only=False):
        if not connector_feature_enabled("google_drive_chat_reads", user_id):
            raise DriveReadError("connector_unavailable")
        # This job's explicit consent authorizes metadata collection only.
        # Never toggle or borrow the broader background-preparation preference.
        return self.live_active(
            connection, user_id=user_id, generation=generation, read_only=read_only
        )

    def _seal(self, value, user_id, resource_id, purpose):
        return json.dumps(
            self.search_cipher.seal(
                value, user_id=user_id, resource_id=resource_id, purpose=purpose
            )
        )

    def _checkpoint(self, row):
        return self.search_cipher.open(
            row["checkpoint_envelope"],
            user_id=row["user_id"],
            resource_id=str(row["job_id"]),
            purpose="owner-search-checkpoint",
        )

    def _view(self, row):
        result = view(row)
        checkpoint = self._checkpoint(row)
        if checkpoint.get("v1_live_request") is True:
            preview = checkpoint.get("v1_verified_preview", {})
            evaluated = min(row["matched"], preview.get("evaluated", 0))
            result["evaluation"] = {
                "status": row.get("evaluation_status", "pending"),
                "evaluatedCount": evaluated,
                "pendingCount": max(0, row["matched"] - evaluated),
                "verifiedCount": min(evaluated, preview.get("count", 0)),
            }
        manifest = checkpoint.get("coverage_manifest")
        if isinstance(manifest, dict):
            # Scope and aggregate exclusion evidence are owner-only. Neither
            # the subject, folder IDs, provider cursors nor resource keys leave
            # the encrypted checkpoint through this projection.
            result["coverage"] = {
                **{
                    key: manifest[key]
                    for key in (
                        "corpora",
                        "fileKind",
                        "requestedPeriod",
                        "dateBasis",
                        "timeIntent",
                        "ownerReviewRequired",
                        "contentPeriodVerified",
                        "folderDiscovery",
                        "retrievalSource",
                        "retrievalCompleteness",
                        "formatScope",
                        "fallbackReason",
                        "lastIndexedAt",
                        "periodConflict",
                    )
                    if key in manifest
                },
                **{
                    key: checkpoint.get("coverage_counts", {}).get(key, 0)
                    for key in (
                        "providerRowsScanned",
                        "providerFilePages",
                        "indexedDocumentsReused",
                        "excludedByDateCount",
                        "excludedByKindCount",
                        "excludedByFilenameCount",
                        "excludedByNoteTypeCount",
                        "excludedByTopicCount",
                        "excludedFolderTopicCount",
                        "deduplicatedCount",
                        "unavailableShortcutCount",
                        "resolvedShortcutCount",
                        "unavailableFolderCount",
                        "invalidMetadataCount",
                        "unsupportedCandidateCount",
                        "matchingFoldersDiscovered",
                        "matchingFoldersExhausted",
                        "uniqueCandidateCount",
                        "verifiedCandidateCount",
                        "contentExcludedCount",
                        "unavailableCandidateCount",
                        "unassessedCandidateCount",
                    )
                },
                "workLimitReached": checkpoint.get("coverage_counts", {}).get(
                    "workLimitReached", False
                ),
                "providerPagesExhausted": row["status"] == "completed"
                and not row["incomplete_search"]
                and checkpoint.get("semantic_coverage_incomplete") is not True
                and not checkpoint.get("request_rank_pruned", False)
                and checkpoint.get("evidence_route") not in {"index", "packet"},
            }
        if checkpoint.get("request_origin_id"):
            # This owner-only bit lets an old completed request search be
            # refreshed before review. The checkpoint and result metadata
            # remain encrypted; no provider capability or file data escapes.
            result.setdefault("coverage", {})["shareabilityVerified"] = (
                checkpoint.get("request_shareability_version") == 1
            )
            # Legacy jobs have no frozen distinction between file activity
            # and content coverage. Their results require an exact owner review.
            result["coverage"]["ownerReviewRequired"] = checkpoint_requires_owner_review(
                checkpoint,
                request_id=checkpoint["request_origin_id"],
                revision=checkpoint.get("request_revision"),
            )
        selection = _bounded_selection(checkpoint)
        if selection is not None:
            ready = _selection_ready(row, checkpoint)
            result.setdefault("coverage", {}).update(
                requestedResultLimit=selection[0],
                resultOrder=f"{selection[1]} desc",
                selectionFinalized=ready,
                candidateCount=checkpoint.get("request_candidate_count", row["matched"]),
                candidateCountScope="retained_pool"
                if checkpoint.get("request_candidate_pool_pruned")
                else "all_unique_matches",
                candidatePoolPruned=bool(checkpoint.get("request_candidate_pool_pruned")),
            )
            if not ready:
                # Candidate positions may change when all corpora are ranked.
                # They must not look reviewable or payable before finalization.
                result["matched"] = 0
                result["unshareableCount"] = 0
        return result

    def _owned(self, connection, user_id, identity, *, locked=False):
        row = self._row(
            connection, _ROW + (" FOR UPDATE" if locked else ""), {"job": identity, "user": user_id}
        )
        if row is None:
            raise DriveReadError("search_not_found")
        return row

    async def purge(self):
        def operation(connection):
            connection.execute(
                text("""
                WITH expired AS (SELECT job_id FROM drive_owner_search_jobs
                  WHERE expires_at<=clock_timestamp() ORDER BY expires_at
                  LIMIT 100 FOR UPDATE SKIP LOCKED)
                DELETE FROM drive_owner_search_jobs j USING expired e WHERE j.job_id=e.job_id
            """)
            )

        await self._transaction(operation)

    async def create(
        self,
        *,
        user_id,
        client_request_id,
        request,
        checkpoint,
        confirmed,
        v1_statement_search=False,
        replace_terminal_request=False,
        replace_legacy_completed_request=False,
    ):
        if confirmed is not True:
            raise DriveReadError("confirmation_required")
        if any(
            type(value) is not bool
            for value in (
                v1_statement_search,
                replace_terminal_request,
                replace_legacy_completed_request,
            )
        ):
            raise DriveReadError("invalid_argument")
        _bounded_selection(checkpoint)
        _semantic_binding_current(checkpoint)
        client = _identity(client_request_id)
        digest = self.search_cipher.digest("owner-search-request", [user_id, request])
        identity = str(uuid4())

        def operation(connection):
            current = self._access(connection, user_id)
            connection.execute(
                text(
                    "DELETE FROM drive_owner_search_jobs WHERE user_id=:user AND expires_at<=clock_timestamp()"
                ),
                {"user": user_id},
            )
            existing = self._row(
                connection,
                "SELECT * FROM drive_owner_search_jobs WHERE user_id=:user AND client_request_id=:client FOR UPDATE",
                {"user": user_id, "client": client},
            )
            replace = False
            if existing:
                if replace_terminal_request and existing["status"] in {
                    "failed",
                    "limited",
                    "stopped",
                }:
                    if self._row(
                        connection,
                        "SELECT share_id FROM drive_bulk_shares WHERE search_job_id=:job",
                        {"job": existing["job_id"]},
                    ):
                        raise DriveReadError("search_in_progress")
                    replace = True
                elif replace_legacy_completed_request and existing["status"] == "completed":
                    replace = self._legacy_completed_replaceable(
                        connection, row=existing, current=current, user_id=user_id, client=client
                    )
                    if not replace:
                        return self._view(existing), False
                if not replace:
                    if existing["request_digest"] != digest:
                        raise DriveReadError("invalid_argument")
                    if existing["connection_generation"] != current["connection_generation"]:
                        raise DriveReadError("connection_changed")
                    return self._view(existing), False
            # A newly connected account never resumes the old account's job.
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET status='failed',
                error_code='connection_changed',lease_id=NULL,lease_expires_at=NULL,
                revision=revision+1,updated_at=clock_timestamp()
                WHERE user_id=:user AND status IN ('queued','running')
                  AND connection_generation<>:generation"""),
                {"user": user_id, "generation": current["connection_generation"]},
            )
            if self._row(
                connection,
                "SELECT job_id FROM drive_owner_search_jobs WHERE user_id=:user AND status IN ('queued','running')",
                {"user": user_id},
            ):
                raise DriveReadError("search_in_progress")
            if replace:
                # Delete and insert share one transaction. A competing active
                # job, sealing failure, or INSERT failure rolls this back.
                connection.execute(
                    text("DELETE FROM drive_owner_search_jobs WHERE job_id=:job"),
                    {"job": existing["job_id"]},
                )
            row = self._row(
                connection,
                """
                INSERT INTO drive_owner_search_jobs(job_id,user_id,client_request_id,request_digest,
                  connection_generation,consent_version,checkpoint_envelope,v1_statement_search)
                VALUES(:job,:user,:client,:digest,:generation,:consent,CAST(:envelope AS jsonb),:v1_statement_search) RETURNING *
            """,
                {
                    "job": identity,
                    "user": user_id,
                    "client": client,
                    "digest": digest,
                    "generation": current["connection_generation"],
                    "consent": CONSENT_VERSION,
                    "v1_statement_search": v1_statement_search,
                    "envelope": self._seal(
                        checkpoint, user_id, identity, "owner-search-checkpoint"
                    ),
                },
            )
            return self._view(row), True

        return await self._transaction(operation)

    async def existing(self, *, user_id, client_request_id, request):
        client = _identity(client_request_id)
        digest = self.search_cipher.digest("owner-search-request", [user_id, request])
        await self.purge()

        def operation(connection):
            current = self._access(connection, user_id)
            row = self._row(
                connection,
                "SELECT * FROM drive_owner_search_jobs WHERE user_id=:user AND client_request_id=:client AND expires_at>clock_timestamp()",
                {"user": user_id, "client": client},
            )
            if row is None:
                return None
            if row["request_digest"] != digest:
                raise DriveReadError("invalid_argument")
            if row["connection_generation"] != current["connection_generation"]:
                raise DriveReadError("connection_changed")
            return self._view(row)

        return await self._transaction(operation)

    # status() and list() back GET routes and must never write. They used to
    # take the connection lock, and _lock() upserts a placeholder connection
    # row: in an environment without a google_drive catalog row (production)
    # that insert violated user_external_connector_connections_connector_id_fkey
    # and every GET returned 500. A single-statement read needs no row lock,
    # and expired rows are already excluded by the query, so neither the lock
    # nor the opportunistic purge belongs on this path. Retention stays on the
    # worker (due) and the write paths (create, existing, stop). results()
    # is a GET too and reads the connection row FOR SHARE instead of _lock().
    async def status(self, *, user_id, job_id):
        identity = _identity(job_id)

        def operation(connection):
            return self._view(self._owned(connection, user_id, identity))

        return await self._transaction(operation)

    async def by_client(self, *, user_id, client_request_id):
        client = _identity(client_request_id)

        def operation(connection):
            row = self._row(
                connection,
                "SELECT * FROM drive_owner_search_jobs WHERE user_id=:user AND client_request_id=:client AND expires_at>clock_timestamp()",
                {"user": user_id, "client": client},
            )
            if row is None:
                return None
            current = self._access(connection, user_id, read_only=True)
            if row["connection_generation"] != current["connection_generation"]:
                raise DriveReadError("connection_changed")
            return self._view(row)

        return await self._transaction(operation)

    async def replan_legacy_statement_request(
        self,
        *,
        user_id,
        request_id,
        request_revision,
        purpose,
        queries,
        period,
        terms,
        expected_lease=None,
    ):
        """Retry an unfrozen one-query statement job without changing result positions.

        The connector lock serializes this with a concurrent page commit or
        progressive batch freeze. Revoking the lease fences any provider read
        already in flight; preserving rows keeps issued result cursors bound to
        the same file at every position.
        """
        client = _identity(request_id)
        if len(queries) != 2 or not period:
            raise DriveReadError("invalid_argument")

        def outcome(row, changed):
            return (
                self._view(row),
                changed,
                "v1" if row.get("v1_statement_search") is True else "suggestions",
            )

        def operation(connection):
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            current = self._access(connection, user_id)
            request = self._row(
                connection,
                """SELECT * FROM drive_share_requests WHERE request_id=:request
                  AND user_id=:user FOR UPDATE""",
                {"request": client, "user": user_id},
            )
            row = self._row(
                connection,
                """SELECT * FROM drive_owner_search_jobs
                  WHERE user_id=:user AND client_request_id=:request
                    AND expires_at>clock_timestamp() FOR UPDATE""",
                {"user": user_id, "request": client},
            )
            if row is None:
                return None, False, None
            if row["connection_generation"] != current["connection_generation"]:
                raise DriveReadError("connection_changed")
            checkpoint = self._checkpoint(row)
            if (
                request is None
                or request["status"] != "pending"
                or request["revision"] != request_revision
                or request["bulk_search_started_at"] is None
                or request["access_stop_requested_at"] is not None
                or request["expires_at"]
                <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
                or checkpoint.get("request_origin_id") != client
                or checkpoint.get("request_revision") != request_revision
                or checkpoint.get("evidence_route", "provider") != "provider"
                or checkpoint.get("agent_package_required") is True
                or row["status"] not in {"queued", "running", "completed"}
                or expected_lease is not None
                and str(row["lease_id"]) != expected_lease
            ):
                return outcome(row, False)
            private = self.search_cipher.open(
                request["request_envelope"],
                user_id=user_id,
                resource_id=client,
                purpose="request",
            )
            if private.get("purpose") != purpose or private.get("agent_package_required") is True:
                return outcome(row, False)
            if private.get("legacy_request_policy") == LEGACY_REQUEST_POLICY:
                # A new restored request keeps its Gemini-authored search. Only
                # older one-query jobs need the post-demo statement repair.
                return outcome(row, False)
            if self._row(
                connection,
                """SELECT share_id FROM drive_bulk_shares
                  WHERE origin_request_id=:request OR search_job_id=:job LIMIT 1""",
                {"request": client, "job": row["job_id"]},
            ):
                # Frozen selections, approvals and paid receipts are immutable.
                return outcome(row, False)
            if checkpoint.get("request_coverage_query_version") == 1:
                # Its completed coverage plan is already frozen. Keep the
                # original worker lane, including an older marked V1 job.
                return outcome(row, False)
            if not _legacy_single_query(checkpoint):
                return outcome(row, False)
            if self._row(
                connection,
                """SELECT job_id FROM drive_owner_search_jobs WHERE user_id=:user
                  AND job_id<>:job AND status IN ('queued','running') LIMIT 1""",
                {"user": user_id, "job": row["job_id"]},
            ):
                raise DriveReadError("search_in_progress")
            checkpoint.update(
                arguments=queries[0]["arguments"],
                queries=queries,
                query_index=0,
                request_coverage_query_version=1,
                request_shareability_version=1,
                request_selection_version=2,
                request_time_intent="document_coverage",
                request_owner_review_required=True,
                request_file_kind="document",
                request_subject_terms=terms,
                request_exact_title=None,
                request_result_limit=None,
                request_order_field="modifiedTime",
                request_direct_originals=False,
                requested_period=period,
                coverage_manifest={
                    "corpora": ["user", "member_shared_drives"],
                    "retrievalSource": "google_drive",
                    "retrievalCompleteness": "provider_candidates",
                    "fileKind": "document",
                    "requestedPeriod": period,
                    "timeIntent": "document_coverage",
                    "ownerReviewRequired": True,
                    "dateBasis": "content_period_unverified",
                    "contentPeriodVerified": False,
                    "folderDiscovery": "matching_topic_folders_and_descendants",
                    "shortcutDiscovery": "resolve_targets",
                    "resultLimit": None,
                    "orderBy": "modifiedTime desc",
                },
                coverage_counts={},
                folder_queue=[],
                folder_digests=[],
                phase="user",
                page_token=None,
                drive_page_token=None,
                drives=[],
                drive_index=0,
                seen_tokens=[],
                drive_tokens=[],
            )
            for stale in (
                "request_rank_pruned",
                "request_results_finalized",
                "request_candidate_count",
                "request_candidate_pool_pruned",
            ):
                checkpoint.pop(stale, None)
            updated = self._row(
                connection,
                """UPDATE drive_owner_search_jobs SET
                  checkpoint_envelope=CAST(:checkpoint AS jsonb),status='queued',
                  incomplete_search=FALSE,lease_id=NULL,lease_expires_at=NULL,
                  error_code=NULL,retry_count=0,next_at=clock_timestamp(),
                  revision=revision+1,updated_at=clock_timestamp()
                  WHERE job_id=:job RETURNING *""",
                {
                    "job": row["job_id"],
                    "checkpoint": self._seal(
                        checkpoint, user_id, str(row["job_id"]), "owner-search-checkpoint"
                    ),
                },
            )
            return outcome(updated, True)

        return await self._transaction(operation)

    async def takeover_request(self, *, user_id, request_id):
        """Persist an authenticated owner's manual takeover of an auto search.

        The caller must have checked the current owner session. Reuse the same
        encrypted checkpoint and committed results so previously shared files
        retain their receipts; changing mode and lease fences the old worker.
        """
        request_id = _identity(request_id)

        def operation(connection):
            current = self._access(connection, user_id)
            request = self._row(
                connection,
                """SELECT * FROM drive_share_requests WHERE request_id=:request
                  AND user_id=:user FOR UPDATE""",
                {"request": request_id, "user": user_id},
            )
            if request is None or request["status"] != "pending":
                return None
            private = self.search_cipher.open(
                request["request_envelope"],
                user_id=user_id,
                resource_id=request_id,
                purpose="request",
            )
            if private.get("agent_package_required") is True:
                raise DriveReadError("package_review_required")
            if private.get("trusted_auto") is not True:
                return None
            connection.execute(
                text("""UPDATE drive_share_requests
                  SET preparation_error_code='manual_search_active',
                    preparation_next_at=clock_timestamp(),updated_at=clock_timestamp()
                  WHERE request_id=:request"""),
                {"request": request_id},
            )
            row = self._row(
                connection,
                """SELECT * FROM drive_owner_search_jobs
                  WHERE user_id=:user AND client_request_id=:request
                    AND expires_at>clock_timestamp() FOR UPDATE""",
                {"request": request_id, "user": user_id},
            )
            if row is None:
                return None
            if row["connection_generation"] != current["connection_generation"]:
                raise DriveReadError("connection_changed")
            checkpoint = self._checkpoint(row)
            if (
                checkpoint.get("request_origin_id") != request_id
                or checkpoint.get("request_revision") != request["revision"]
            ):
                raise DriveReadError("search_superseded")
            if row["status"] != "completed" and self._row(
                connection,
                """SELECT job_id FROM drive_owner_search_jobs
                  WHERE user_id=:user AND job_id<>:job
                    AND status IN ('queued','running') LIMIT 1""",
                {"user": user_id, "job": row["job_id"]},
            ):
                raise DriveReadError("search_in_progress")
            checkpoint["authority_mode"] = "owner"
            updated = self._row(
                connection,
                """UPDATE drive_owner_search_jobs
                  SET checkpoint_envelope=CAST(:checkpoint AS jsonb),
                    status=CASE WHEN status='completed' THEN status ELSE 'queued' END,
                    lease_id=NULL,lease_expires_at=NULL,error_code=NULL,retry_count=0,
                    next_at=clock_timestamp(),revision=revision+1,
                    updated_at=clock_timestamp()
                  WHERE job_id=:job RETURNING *""",
                {
                    "job": row["job_id"],
                    "checkpoint": self._seal(
                        checkpoint, user_id, str(row["job_id"]), "owner-search-checkpoint"
                    ),
                },
            )
            return self._view(updated)

        return await self._transaction(operation)

    async def migrate_request_processor(
        self, *, user_id, request_id=None, job_id=None, authority_mode="trusted_auto"
    ):
        """One recorded admin-policy transition per live request; no external effects.

        Existing observations retain their original provenance. Source versions
        remain checked by content reads and the paid delivery worker. The
        connector lock fences old workers; no live lease may be replaced.
        """
        from hushh_mcp.runtime_providers.managed_text import (
            managed_text_binding,
            managed_text_policy,
        )
        from hushh_mcp.services.drive_owner_allowed import semantic_search_request
        from hushh_mcp.services.drive_request_package_service import assessment_policy_version

        if managed_text_policy() is None:
            return False
        target = managed_text_binding()
        if authority_mode not in {"owner", "trusted_auto"}:
            raise DriveReadError("invalid_argument")
        if request_id is None and job_id is None:
            raise DriveReadError("invalid_argument")
        request_id = _identity(request_id) if request_id else None
        job_id = _identity(job_id) if job_id else None

        def operation(connection):
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            current = self._access(connection, user_id)
            row = self._row(
                connection,
                """SELECT * FROM drive_owner_search_jobs WHERE user_id=:user
                   AND ((:job IS NOT NULL AND job_id=CAST(:job AS uuid))
                     OR (:job IS NULL AND client_request_id=CAST(:request AS uuid)))""",
                {"user": user_id, "job": job_id, "request": request_id},
            )
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if row is not None and (
                row["status"] not in {"queued", "failed", "running"}
                or row["status"] == "running"
                and row["lease_expires_at"] is not None
                and row["lease_expires_at"] > now
            ):
                # A live lease is not stolen. Completed outputs remain readable.
                return False
            origin = str(row["client_request_id"]) if row else request_id
            if origin is None:
                return False
            request = self._row(
                connection,
                "SELECT * FROM drive_share_requests WHERE user_id=:user AND request_id=:request FOR UPDATE",
                {"user": user_id, "request": origin},
            )
            if request is None:
                return False
            private = self.search_cipher.open(
                request["request_envelope"], user_id=user_id, resource_id=origin, purpose="request"
            )
            if (
                not semantic_search_request(private)
                or private.get("semantic_model_binding") == target
            ):
                return False
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                request["status"] != "pending"
                or request["expires_at"] <= now
                or request["access_stop_requested_at"] is not None
                or authority_mode != "owner"
                and private.get("trusted_auto") is not True
                or authority_mode != "owner"
                and not automatic_recipient_current(
                    connection, user_id, request["recipient_user_id"], private, request_id=origin
                )
            ):
                raise DriveReadError("search_superseded")
            if authority_mode != "owner":
                self.background_current(
                    connection, user_id=user_id, generation=current["connection_generation"]
                )
            old_binding = private.get("semantic_model_binding")
            if old_binding is not None and old_binding.get("provider") not in {
                "gemini",
                "azure_openai",
            }:
                raise DriveReadError("search_superseded")
            checkpoint = None
            if row is not None:
                row = self._owned(connection, user_id, str(row["job_id"]), locked=True)
                checkpoint = self._checkpoint(row)
                if (
                    row["status"] not in {"queued", "failed", "running"}
                    or row["expires_at"] <= now
                    or row["lease_expires_at"] is not None
                    and row["lease_expires_at"] > now
                    or row["connection_generation"] != current["connection_generation"]
                    or checkpoint.get("request_origin_id") != origin
                    or checkpoint.get("request_revision") != request["revision"]
                    or checkpoint.get("authority_mode")
                    not in (
                        {"owner", "trusted_auto"} if authority_mode == "owner" else {"trusted_auto"}
                    )
                    or checkpoint.get("semantic_plan") is None
                    or checkpoint.get("semantic_model_binding") != old_binding
                    or checkpoint.get("semantic_purpose") != private.get("purpose")
                ):
                    raise DriveReadError("search_superseded")
                from hushh_mcp.services.drive_request_semantic_plan import (
                    SemanticDrivePlan,
                    semantic_plan_digest,
                )

                try:
                    parsed = SemanticDrivePlan.model_validate(checkpoint["semantic_plan"])
                    if parsed.status != "ready" or semantic_plan_digest(parsed) != checkpoint.get(
                        "semantic_plan_digest"
                    ):
                        raise ValueError("changed plan")
                except ValueError:
                    raise DriveReadError("search_superseded") from None
                if self._row(
                    connection,
                    """SELECT job_id FROM drive_owner_search_jobs WHERE user_id=:user
                       AND job_id<>:job AND status IN ('queued','running') LIMIT 1""",
                    {"user": user_id, "job": row["job_id"]},
                ):
                    raise DriveReadError("search_in_progress")
            # A bounded one-way migration; policy changes require a new reviewed recovery.
            if private.get("processor_migration"):
                raise DriveReadError("search_superseded")
            record = {
                "version": 1,
                "basis": "administrator_rollout",
                "operation_id": target["approval_generation"] + ":" + origin,
                "from_binding": old_binding,
                "to_binding": target,
                "at": now.isoformat(),
                "previous_assessment_policy": checkpoint.get("semantic_assessment_policy")
                if checkpoint
                else None,
                "preserved_plan_digest": checkpoint.get("semantic_plan_digest")
                if checkpoint
                else None,
            }
            private["semantic_model_binding"] = target
            private["processor_migration"] = record
            connection.execute(
                text("""UPDATE drive_share_requests
                SET request_envelope=CAST(:envelope AS jsonb),updated_at=clock_timestamp()
                WHERE request_id=:request AND user_id=:user"""),
                {
                    "request": origin,
                    "user": user_id,
                    "envelope": self._seal(private, user_id, origin, "request"),
                },
            )
            if checkpoint is not None:
                checkpoint["semantic_model_binding"] = target
                checkpoint["semantic_assessment_policy"] = assessment_policy_version(target)
                checkpoint["processor_migration"] = record
                connection.execute(
                    text("""UPDATE drive_owner_search_jobs
                    SET checkpoint_envelope=CAST(:envelope AS jsonb),status='queued',
                    error_code=NULL,retry_count=0,lease_id=NULL,lease_expires_at=NULL,
                    next_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
                    WHERE job_id=:job AND user_id=:user"""),
                    {
                        "job": row["job_id"],
                        "user": user_id,
                        "envelope": self._seal(
                            checkpoint, user_id, str(row["job_id"]), "owner-search-checkpoint"
                        ),
                    },
                )
            return True

        return await self._transaction(operation)

    async def retry_failed_request(self, *, user_id, request_id, request_revision, authority_mode):
        """Resume a failed request at its committed cursor and stable result positions.

        This is an explicit request action, not a scheduler loop. Retaining the
        job ID and result rows also retains any progressive batch bindings.
        """
        client = _identity(request_id)
        if authority_mode not in {"owner", "trusted_auto", "agent_package"}:
            raise DriveReadError("invalid_argument")

        def operation(connection):
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            current = self._access(connection, user_id)
            request = self._row(
                connection,
                """SELECT * FROM drive_share_requests WHERE user_id=:user
                   AND request_id=:request FOR UPDATE""",
                {"user": user_id, "request": client},
            )
            row = self._row(
                connection,
                """SELECT * FROM drive_owner_search_jobs WHERE user_id=:user
                   AND client_request_id=:request AND expires_at>clock_timestamp()
                   FOR UPDATE""",
                {"user": user_id, "request": client},
            )
            if row is None:
                return None, False
            if row["status"] != "failed":
                return self._view(row), False
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            checkpoint = self._checkpoint(row)
            if (
                request is None
                or request["status"] != "pending"
                or request["access_stop_requested_at"] is not None
                or request["expires_at"] <= now
                or request["bulk_search_started_at"] is None
                or request["revision"] != request_revision
                or row["connection_generation"] != current["connection_generation"]
                or checkpoint.get("request_origin_id") != client
                or checkpoint.get("request_revision") != request_revision
                or checkpoint.get("authority_mode") != authority_mode
                or (request["agent_package_required"] is True)
                != (authority_mode == "agent_package")
                or authority_mode == "agent_package"
                and row["evaluation_status"] != "pending"
            ):
                raise DriveReadError("search_superseded")
            if authority_mode == "trusted_auto":
                private = self.search_cipher.open(
                    request["request_envelope"],
                    user_id=user_id,
                    resource_id=client,
                    purpose="request",
                )
                if private.get("trusted_auto") is not True or not automatic_recipient_current(
                    connection, user_id, request["recipient_user_id"], private, request_id=client
                ):
                    raise DriveReadError("search_superseded")
            if authority_mode != "owner":
                self.background_current(
                    connection,
                    user_id=user_id,
                    generation=current["connection_generation"],
                )
            if self._row(
                connection,
                """SELECT job_id FROM drive_owner_search_jobs WHERE user_id=:user
                   AND job_id<>:job AND status IN ('queued','running') LIMIT 1""",
                {"user": user_id, "job": row["job_id"]},
            ):
                raise DriveReadError("search_in_progress")
            if authority_mode == "agent_package" and (
                self._row(
                    connection,
                    """SELECT share_id FROM drive_bulk_shares WHERE user_id=:user
                       AND (origin_request_id=:request OR search_job_id=:job) LIMIT 1""",
                    {"user": user_id, "request": client, "job": row["job_id"]},
                )
                or self._row(
                    connection,
                    "SELECT request_id FROM drive_request_payment_orders WHERE request_id=:request LIMIT 1",
                    {"request": client},
                )
            ):
                raise DriveReadError("search_superseded")
            checkpoint["last_recovered_error_code"] = row["error_code"]
            updated = self._row(
                connection,
                """UPDATE drive_owner_search_jobs SET status='queued',error_code=NULL,
                   retry_count=0,lease_id=NULL,lease_expires_at=NULL,
                   next_at=clock_timestamp(),revision=revision+1,
                   checkpoint_envelope=CAST(:checkpoint AS jsonb),updated_at=clock_timestamp()
                   WHERE job_id=:job RETURNING *""",
                {
                    "job": row["job_id"],
                    "checkpoint": self._seal(
                        checkpoint, user_id, str(row["job_id"]), "owner-search-checkpoint"
                    ),
                },
            )
            return self._view(updated), True

        return await self._transaction(operation)

    def _legacy_completed_replaceable(self, connection, *, row, current, user_id, client):
        """A legacy completed job can be refreshed only before review freezes it."""
        if row["connection_generation"] != current["connection_generation"]:
            raise DriveReadError("connection_changed")
        checkpoint = self._checkpoint(row)
        current_selection = checkpoint.get("request_selection_version") == 2 and (
            autoshare_selection(checkpoint)
            or checkpoint.get("request_time_intent") in {"file_activity", "document_coverage"}
            and checkpoint.get("request_owner_review_required")
            is (checkpoint.get("request_time_intent") == "document_coverage")
        )
        if (
            checkpoint.get("request_origin_id") != client
            or checkpoint.get("request_shareability_version") == 1
            and current_selection
        ):
            return False
        request = self._row(
            connection,
            """SELECT status,revision,expires_at,bulk_search_started_at
            FROM drive_share_requests WHERE request_id=:request AND user_id=:user""",
            {"request": client, "user": user_id},
        )
        if (
            request is None
            or request["status"] != "pending"
            or request["revision"] != checkpoint.get("request_revision")
            or request["bulk_search_started_at"] is None
            or request["expires_at"]
            <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        ):
            return False
        return not self._row(
            connection,
            """SELECT share_id FROM drive_bulk_shares
            WHERE origin_request_id=:request OR search_job_id=:job LIMIT 1""",
            {"request": client, "job": row["job_id"]},
        )

    async def clear_legacy_completed_request(self, *, user_id, request_id):
        """Discard an unfrozen legacy result (prefer atomic create for replacement)."""
        client = _identity(request_id)

        def operation(connection):
            current = self._access(connection, user_id)
            row = self._row(
                connection,
                """SELECT * FROM drive_owner_search_jobs
                WHERE user_id=:user AND client_request_id=:client
                  AND expires_at>clock_timestamp() FOR UPDATE""",
                {"user": user_id, "client": client},
            )
            if row is None or row["status"] != "completed":
                return False
            if not self._legacy_completed_replaceable(
                connection, row=row, current=current, user_id=user_id, client=client
            ):
                return False
            connection.execute(
                text("DELETE FROM drive_owner_search_jobs WHERE job_id=:job"),
                {"job": row["job_id"]},
            )
            return True

        return await self._transaction(operation)

    async def align_request_expiry(self, *, user_id, request_id):
        client = _identity(request_id)

        def operation(connection):
            connection.execute(
                text("""UPDATE drive_owner_search_jobs j
                SET expires_at=r.expires_at
                FROM drive_share_requests r
                WHERE j.user_id=:user AND j.client_request_id=:client
                  AND r.request_id=:client AND r.user_id=:user
                  AND r.bulk_search_started_at IS NOT NULL
                  AND j.expires_at<r.expires_at"""),
                {"user": user_id, "client": client},
            )

        await self._transaction(operation)

    async def list(self, *, user_id):
        def operation(connection):
            rows = connection.execute(
                text(
                    "SELECT * FROM drive_owner_search_jobs WHERE user_id=:user AND expires_at>clock_timestamp() ORDER BY created_at DESC,job_id DESC LIMIT 20"
                ),
                {"user": user_id},
            ).mappings()
            return {"jobs": [self._view(dict(row)) for row in rows]}

        return await self._transaction(operation)

    def _cursor(self, user, identity, after):
        signature = self.search_cipher.digest("owner-search-result-cursor", [user, identity, after])
        return base64.urlsafe_b64encode(f"{after}:{signature}".encode()).decode()

    def _after(self, user, identity, cursor):
        if cursor is None:
            return 0
        try:
            if not isinstance(cursor, str) or len(cursor) > 1024:
                raise ValueError()
            value, signature = (
                base64.b64decode(cursor, altchars=b"-_", validate=True).decode().split(":")
            )
            after = int(value)
            if not 0 <= after <= MAX_RESULTS or not hmac.compare_digest(
                signature,
                self.search_cipher.digest("owner-search-result-cursor", [user, identity, after]),
            ):
                raise ValueError()
            return after
        except (ValueError, UnicodeError):
            raise DriveReadError("invalid_argument") from None

    async def results(self, *, user_id, job_id, cursor=None, limit=25, request_id=None):
        identity = _identity(job_id)
        request_identity = _identity(request_id) if request_id is not None else None
        if type(limit) is not int or not 1 <= limit <= 25:
            raise DriveReadError("invalid_argument")
        after = self._after(user_id, identity, cursor)

        def operation(connection):
            current = self._access(connection, user_id, read_only=True)
            row = self._owned(connection, user_id, identity)
            if row["connection_generation"] != current["connection_generation"]:
                raise DriveReadError("connection_changed")
            manual = None
            if request_identity is not None:
                request = self._row(
                    connection,
                    "SELECT * FROM drive_share_requests WHERE request_id=:request AND user_id=:user",
                    {"request": request_identity, "user": user_id},
                )
                if request is None or str(row["client_request_id"]) != request_identity:
                    raise DriveReadError("search_not_found")
                from hushh_mcp.services.drive_v1_manual_review import require_manual_selection

                manual = require_manual_selection(
                    connection,
                    request=request,
                    search=row,
                    cipher=self.search_cipher,
                )
            if not _selection_ready(row, self._checkpoint(row)):
                return {
                    "jobId": identity,
                    "revision": row["revision"],
                    "files": [],
                    "matched": 0,
                    "nextCursor": None,
                }
            rows = list(
                connection.execute(
                    text(
                        "SELECT * FROM drive_owner_search_results WHERE job_id=:job AND user_id=:user "
                        "AND position>:after AND (:all_positions OR position=ANY(CAST(:positions AS integer[]))) "
                        "ORDER BY position LIMIT :limit"
                    ),
                    {
                        "job": identity,
                        "user": user_id,
                        "after": after,
                        "limit": limit + 1,
                        "all_positions": manual is None,
                        "positions": (
                            manual.get("approved_positions") or manual["selected_positions"]
                        )
                        if manual
                        else [],
                    },
                ).mappings()
            )
            files = []
            for item in rows[:limit]:
                metadata = self.search_cipher.open(
                    item["metadata_envelope"],
                    user_id=user_id,
                    resource_id=f"{identity}:{item['position']}",
                    purpose="owner-search-result",
                )
                file = {
                    **{key: value for key, value in metadata.items() if key != "resourceKey"},
                    "position": item["position"],
                }
                if manual is not None:
                    if item["evaluation_envelope"] is None:
                        raise DriveReadError("search_not_found")
                    evidence = self.search_cipher.open(
                        item["evaluation_envelope"],
                        user_id=user_id,
                        resource_id=f"{identity}:{item['position']}",
                        purpose="request-package-evidence",
                    )
                    assessment = evidence.get("assessment") if isinstance(evidence, dict) else None
                    confidence = (
                        assessment.get("confidence") if isinstance(assessment, dict) else None
                    )
                    weightage = (
                        assessment.get("weightage_out_of_10")
                        if isinstance(assessment, dict)
                        else None
                    )
                    if (
                        not isinstance(assessment, dict)
                        or assessment.get("decision") != "include"
                        or type(confidence) is not int
                        or confidence < 80
                        or confidence > 100
                        or type(weightage) not in {float, int}
                        or not math.isfinite(weightage)
                        or not 1 <= weightage <= 10
                    ):
                        raise DriveReadError("search_not_found")
                    file["confidenceScore"] = confidence
                    file["weightageOutOf10"] = weightage
                files.append(file)
            return {
                "jobId": identity,
                "revision": row["revision"],
                "files": files,
                "matched": row["matched"],
                "nextCursor": self._cursor(user_id, identity, rows[limit - 1]["position"])
                if len(rows) > limit
                else None,
            }

        return await self._transaction(operation)

    async def reference(self, *, user_id, job_id, position):
        """Resolve one owner-selected positive result, never a cached absence.

        The caller must verify this file against live Drive before using it as
        current evidence. The opaque job and position do not grant file access.
        """
        identity = _identity(job_id)
        if type(position) is not int or not 1 <= position <= MAX_RESULTS:
            raise DriveReadError("invalid_argument")
        await self.purge()

        def operation(connection):
            current = self._access(connection, user_id)
            row = self._owned(connection, user_id, identity)
            # The SQL lookup also filters expiry. Keep the selected-result
            # fence explicit even when bounded cleanup has not reached this row.
            if row["expires_at"] <= datetime.now(UTC):
                raise DriveReadError("search_not_found")
            if row["connection_generation"] != current["connection_generation"]:
                raise DriveReadError("connection_changed")
            if not _selection_ready(row, self._checkpoint(row)):
                raise DriveReadError("search_not_found")
            result = self._row(
                connection,
                "SELECT metadata_envelope FROM drive_owner_search_results "
                "WHERE job_id=:job AND user_id=:user AND position=:position",
                {"job": identity, "user": user_id, "position": position},
            )
            if result is None:
                raise DriveReadError("search_not_found")
            return self.search_cipher.open(
                result["metadata_envelope"],
                user_id=user_id,
                resource_id=f"{identity}:{position}",
                purpose="owner-search-result",
            )

        return await self._transaction(operation)

    async def stop(self, *, user_id, job_id):
        identity = _identity(job_id)

        def operation(connection):
            # Cancelling work needs the current owner session, not a working
            # provider connection. The service fences the authenticated owner.
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            row = self._owned(connection, user_id, identity, locked=True)
            if row["status"] in ACTIVE:
                row = self._row(
                    connection,
                    """UPDATE drive_owner_search_jobs SET status='stopped',
                    lease_id=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp()
                    WHERE job_id=:job RETURNING *""",
                    {"job": identity},
                )
            return self._view(row)

        return await self._transaction(operation)

    async def due(self, limit=1, *, v1_only=False):
        if type(v1_only) is not bool:
            raise ValueError("invalid search worker mode")
        await self.purge()

        def operation(connection):
            return [
                dict(row)
                for row in connection.execute(
                    text("""
                WITH due AS (SELECT job_id FROM drive_owner_search_jobs
                  WHERE status IN ('queued','running') AND expires_at>clock_timestamp()
                    AND next_at<=clock_timestamp()
                    AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())
                    AND (:v1_only = FALSE OR v1_statement_search=TRUE)
                  ORDER BY inspected_at,created_at,job_id LIMIT :limit FOR UPDATE SKIP LOCKED)
                UPDATE drive_owner_search_jobs j SET inspected_at=clock_timestamp()
                  FROM due WHERE j.job_id=due.job_id RETURNING j.job_id,j.user_id
            """),
                    {"limit": min(max(limit, 1), 20), "v1_only": v1_only},
                ).mappings()
            ]

        return await self._transaction(operation)

    async def claim(self, *, user_id, job_id):
        identity = _identity(job_id)
        try:
            await self.migrate_request_processor(user_id=user_id, job_id=identity)
        except DriveReadError:
            # Existing claim/current-authority cleanup owns revoked jobs.
            # An unmigrated Gemini job cannot dispatch under the UAT policy.
            pass

        def operation(connection):
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            try:
                current = self._access(connection, user_id)
            except DriveReadError as error:
                connection.execute(
                    text("""UPDATE drive_owner_search_jobs SET status='failed',
                    error_code=:code,lease_id=NULL,lease_expires_at=NULL,revision=revision+1,
                    updated_at=clock_timestamp() WHERE job_id=:job AND user_id=:user
                    AND status IN ('queued','running')"""),
                    {
                        "job": identity,
                        "user": user_id,
                        "code": "connector_unavailable"
                        if str(error) == "connector_unavailable"
                        else "connection_changed",
                    },
                )
                return None
            row = self._owned(connection, user_id, identity, locked=True)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row["status"] not in ACTIVE
                or row["expires_at"] <= now
                or row["next_at"] > now
                or row["lease_expires_at"]
                and row["lease_expires_at"] > now
            ):
                return None
            if (
                row["connection_generation"] != current["connection_generation"]
                or row["consent_version"] != CONSENT_VERSION
            ):
                connection.execute(
                    text(
                        "UPDATE drive_owner_search_jobs SET status='failed',error_code='connection_changed',lease_id=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE job_id=:job"
                    ),
                    {"job": identity},
                )
                return None
            lease = str(uuid4())
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET status='running',lease_id=:lease,lease_expires_at=clock_timestamp()+INTERVAL '120 seconds',revision=revision+1,updated_at=clock_timestamp() WHERE job_id=:job"
                ),
                {"job": identity, "lease": lease},
            )
            return {
                "job_id": identity,
                "user_id": user_id,
                "generation": row["connection_generation"],
                "lease_id": lease,
                "checkpoint": self._checkpoint(row),
                "v1_statement_search": row["v1_statement_search"],
            }

        return await self._transaction(operation)

    def _evidence_current(self, connection, checkpoint, user_id, *, approved_terms=False):
        route = checkpoint.get("evidence_route")
        if route == "packet":
            if checkpoint.get("matched_packet"):
                from hushh_mcp.services.drive_document_facts_store import DriveDocumentFactsStore
                from hushh_mcp.services.drive_packet_contract import PacketVerification

                checked = PacketVerification.model_validate(
                    checkpoint.get("request_packet_verification")
                )
                if checked.state != "ready":
                    raise DriveReadError("packet_unavailable")

                current = DriveDocumentFactsStore(db=self.db)._current_index_status(
                    connection, owner_user_id=user_id
                )
                if not current["complete"] or current["signature"] != checkpoint.get(
                    "index_snapshot", {}
                ).get("signature"):
                    raise DriveReadError("source_changed")
            from hushh_mcp.services.drive_packet_store import DrivePacketStore

            binding = checkpoint.get("reusable_packet") or checkpoint["matched_packet"]
            manifest = DrivePacketStore(db=self.db)._current_packet_manifest(
                connection,
                owner_user_id=user_id,
                packet_id=binding["packetId"],
                version=binding["version"],
            )
            return validate_reusable_packet(
                manifest, binding, user_id, approved_terms=approved_terms
            )
        if route in {"index", "hybrid"}:
            from hushh_mcp.services.drive_document_facts_store import DriveDocumentFactsStore

            current = DriveDocumentFactsStore(db=self.db)._current_index_status(
                connection, owner_user_id=user_id
            )
            if (
                route == "index"
                and not current["complete"]
                or current["signature"] != checkpoint.get("index_snapshot", {}).get("signature")
            ):
                raise DriveReadError("source_changed")
        return None

    def _current(self, connection, job):
        self._access(connection, job["user_id"], job["generation"])
        self._evidence_current(connection, job["checkpoint"], job["user_id"])
        row = self._owned(connection, job["user_id"], job["job_id"], locked=True)
        current_mode = self._checkpoint(row).get("authority_mode", "owner")
        claimed_mode = job["checkpoint"].get("authority_mode", "owner")
        if current_mode != claimed_mode:
            raise DriveReadError("search_superseded")
        origin = job["checkpoint"].get("request_origin_id")
        if origin is not None:
            request = self._row(
                connection,
                """SELECT status,revision,expires_at,bulk_search_started_at,access_stop_requested_at,
                  preparation_error_code,recipient_user_id,request_envelope
                FROM drive_share_requests WHERE request_id=:request AND user_id=:user""",
                {"request": origin, "user": job["user_id"]},
            )
            if (
                request is None
                or request["status"] != "pending"
                or request.get("access_stop_requested_at") is not None
                or request["revision"] != job["checkpoint"].get("request_revision")
                or request["bulk_search_started_at"] is None
                or current_mode == "trusted_auto"
                and request["preparation_error_code"]
                in {"trusted_relationship_changed", "manual_search_active"}
                or request["expires_at"]
                <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            ):
                raise DriveReadError("search_superseded")
            if current_mode in {"trusted_auto", "agent_package"}:
                private = self.search_cipher.open(
                    request["request_envelope"],
                    user_id=job["user_id"],
                    resource_id=str(origin),
                    purpose="request",
                )
                from hushh_mcp.services.drive_owner_allowed import semantic_search_request
                from hushh_mcp.services.drive_request_semantic_plan import (
                    SemanticDrivePlan,
                    semantic_plan_digest,
                )

                claimed = job["checkpoint"]
                frozen = self._checkpoint(row)
                semantic = claimed.get("semantic_plan")
                _semantic_binding_current(claimed)
                if (private.get("semantic_search_policy_version") == 2) != discovery_delivery(
                    claimed
                ):
                    raise DriveReadError("search_superseded")
                if semantic_search_request(private) != (semantic is not None):
                    raise DriveReadError("search_superseded")
                if semantic is not None:
                    try:
                        parsed = SemanticDrivePlan.model_validate(semantic)
                        valid = (
                            parsed.status == "ready"
                            and semantic_plan_digest(parsed) == claimed.get("semantic_plan_digest")
                            and claimed.get("semantic_purpose") == private.get("purpose")
                            and claimed.get("semantic_model_binding")
                            == private.get("semantic_model_binding")
                            and all(
                                claimed.get(key) == frozen.get(key)
                                for key in (
                                    "semantic_plan",
                                    "semantic_plan_digest",
                                    "semantic_purpose",
                                    "semantic_assessment_policy",
                                    "semantic_model_binding",
                                    "discovery_delivery_policy",
                                    "queries",
                                    "requested_period",
                                )
                            )
                        )
                    except ValueError:
                        valid = False
                    if not valid:
                        raise DriveReadError("search_superseded")
                if (
                    private.get("agent_package_required") is not True
                    if current_mode == "agent_package"
                    else private.get("trusted_auto") is not True
                ):
                    raise DriveReadError("search_superseded")
                # A queued automatic request is not an enduring read grant.
                # Recheck on every page and in the commit transaction, even
                # if the worker omitted its callback after a future refactor.
                try:
                    self.background_current(
                        connection, user_id=job["user_id"], generation=job["generation"]
                    )
                except DriveReadError as error:
                    if str(error) == "background_preparation_required":
                        raise
                    raise DriveReadError("search_superseded") from error
                # Current Trusted membership, or this request's sealed owner
                # Allow while the pair is still connected.
                if current_mode == "agent_package":
                    from hushh_mcp.services.drive_sharing_store import DriveSharingStore

                    DriveSharingStore(db=self.db)._relationship(
                        connection, job["user_id"], request["recipient_user_id"]
                    )
                elif not automatic_recipient_current(
                    connection,
                    job["user_id"],
                    request["recipient_user_id"],
                    private,
                    request_id=origin,
                ):
                    raise DriveReadError("search_superseded")
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        if (
            row["status"] != "running"
            or str(row["lease_id"]) != job["lease_id"]
            or row["lease_expires_at"] is None
            or row["lease_expires_at"] <= now
            or row["expires_at"] <= now
            or row["consent_version"] != CONSENT_VERSION
        ):
            raise DriveReadError("search_superseded")
        return row

    async def require_current(self, job):
        await self._transaction(lambda connection: self._current(connection, job))

    def _retain_latest_candidates(self, connection, job, selection):
        """Keep the latest N encrypted candidates under the current job lock.

        Trimming at the storage ceiling is safe: a discarded candidate cannot
        enter the global top N when more candidates arrive. These positions
        remain private until the separate completed-selection marker commits.
        """
        limit, field = selection
        candidates = []
        for row in connection.execute(
            text("SELECT * FROM drive_owner_search_results WHERE job_id=:job AND user_id=:user"),
            {"job": job["job_id"], "user": job["user_id"]},
        ).mappings():
            item = self.search_cipher.open(
                row["metadata_envelope"],
                user_id=job["user_id"],
                resource_id=f"{job['job_id']}:{row['position']}",
                purpose="owner-search-result",
            )
            value = item.get(field)
            try:
                if not isinstance(value, str):
                    return None
                timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if timestamp.tzinfo is None or timestamp.utcoffset() is None:
                    return None
                timestamp = timestamp.astimezone(UTC)
            except (ValueError, OverflowError):
                return None
            candidates.append((timestamp, item["id"], row["file_digest"], item))
        # Stable secondary ordering prevents a provider's tie/page order from
        # changing the exact files the owner reviews and the requester buys.
        candidates.sort(key=lambda candidate: candidate[1])
        candidates.sort(key=lambda candidate: candidate[0], reverse=True)
        selected = candidates[:limit]
        sealed = [
            {
                "job": job["job_id"],
                "user": job["user_id"],
                "position": position,
                "digest": digest,
                "envelope": self._seal(
                    item, job["user_id"], f"{job['job_id']}:{position}", "owner-search-result"
                ),
            }
            for position, (_, _, digest, item) in enumerate(selected, start=1)
        ]
        connection.execute(
            text("DELETE FROM drive_owner_search_results WHERE job_id=:job AND user_id=:user"),
            {"job": job["job_id"], "user": job["user_id"]},
        )
        if sealed:
            connection.execute(
                text("""INSERT INTO drive_owner_search_results
                (job_id,user_id,position,file_digest,metadata_envelope)
                VALUES(:job,:user,:position,:digest,CAST(:envelope AS jsonb))"""),
                sealed,
            )
        return len(selected), sum(item.get("shareable") is False for _, _, _, item in selected)

    async def commit_page(self, job, *, checkpoint, files, incomplete=False, done=False):
        # Only a marked V1 request may commit a 1000-row provider page. The
        # person-facing result cursor remains a separate 25-file boundary.
        v1_large_page = checkpoint.get("v1_live_request") is True
        if not isinstance(files, list) or len(files) > (1000 if v1_large_page else 100):
            raise DriveReadError("invalid_argument")

        def operation(connection):
            row = self._current(connection, job)
            saved_checkpoint = self._checkpoint(row)
            _semantic_binding_current(saved_checkpoint)
            if saved_checkpoint.get("semantic_model_binding") != checkpoint.get(
                "semantic_model_binding"
            ):
                raise DriveReadError("search_superseded")
            if (saved_checkpoint.get("semantic_plan") is not None) != (
                checkpoint.get("semantic_plan") is not None
            ):
                raise DriveReadError("search_superseded")
            if saved_checkpoint.get("discovery_delivery_policy") != checkpoint.get(
                "discovery_delivery_policy"
            ):
                raise DriveReadError("search_superseded")
            if saved_checkpoint.get("semantic_plan") is not None:
                from hushh_mcp.services.drive_request_candidate_assessment import (
                    verified_evidence_matches,
                )

                if (
                    any(
                        checkpoint.get(key) != saved_checkpoint.get(key)
                        for key in (
                            "semantic_plan",
                            "semantic_plan_digest",
                            "semantic_assessment_policy",
                            "semantic_model_binding",
                            "semantic_purpose",
                            "request_origin_id",
                            "request_revision",
                            "queries",
                            "requested_period",
                        )
                    )
                    or done
                    and not discovery_delivery(saved_checkpoint)
                    and (
                        checkpoint.get("semantic_pending")
                        or checkpoint.get("semantic_discovery_done") is not True
                    )
                ):
                    raise DriveReadError("search_superseded")
                for item in files:
                    if discovery_delivery(saved_checkpoint):
                        if not discovery_evidence_matches(
                            item,
                            user_id=job["user_id"],
                            generation=job["generation"],
                            checkpoint=saved_checkpoint,
                        ):
                            raise DriveReadError("provider_response_invalid")
                        continue
                    if item.get("contentVerified") is not True or not verified_evidence_matches(
                        item.get("requestEvidence"),
                        user_id=job["user_id"],
                        request_id=saved_checkpoint["request_origin_id"],
                        request_revision=saved_checkpoint["request_revision"],
                        connection_generation=job["generation"],
                        plan_digest=saved_checkpoint["semantic_plan_digest"],
                        metadata=item,
                        policy_version=saved_checkpoint["semantic_assessment_policy"],
                    ):
                        raise DriveReadError("provider_response_invalid")
            if v1_large_page and saved_checkpoint.get("v1_live_request") is not True:
                raise DriveReadError("search_superseded")
            selection = _bounded_selection(saved_checkpoint)
            if _bounded_selection(checkpoint) != selection:
                raise DriveReadError("search_superseded")
            count = row["matched"]
            unshareable = row.get("unshareable_count", 0)
            limited = False
            invalid_ranking = False
            if len(files) > 100 and count + len(files) <= MAX_RESULTS:
                # One membership query and one batch insert replace up to 2000
                # SQL round trips on a 1000-row V1 page. Keep the existing
                # per-row boundary path when reaching the storage ceiling,
                # where latest-N compaction can change membership mid-page.
                digested = [
                    (
                        item,
                        self.search_cipher.digest("owner-search-file", [job["job_id"], item["id"]]),
                    )
                    for item in files
                ]
                existing = set(
                    connection.execute(
                        text("""SELECT file_digest FROM drive_owner_search_results
                        WHERE job_id=:job AND file_digest = ANY(CAST(:digests AS text[]))"""),
                        {"job": job["job_id"], "digests": list({d for _, d in digested})},
                    ).scalars()
                )
                pending = []
                for item, digest in digested:
                    if digest in existing:
                        if checkpoint.get("coverage_manifest"):
                            counts = checkpoint.setdefault("coverage_counts", {})
                            counts["deduplicatedCount"] = counts.get("deduplicatedCount", 0) + 1
                        continue
                    existing.add(digest)
                    count += 1
                    unshareable += int(item.get("shareable") is False)
                    pending.append(
                        {
                            "job": job["job_id"],
                            "user": job["user_id"],
                            "position": count,
                            "digest": digest,
                            "envelope": self._seal(
                                item,
                                job["user_id"],
                                f"{job['job_id']}:{count}",
                                "owner-search-result",
                            ),
                        }
                    )
                if pending:
                    connection.execute(
                        text("""INSERT INTO drive_owner_search_results
                        (job_id,user_id,position,file_digest,metadata_envelope)
                        VALUES(:job,:user,:position,:digest,CAST(:envelope AS jsonb))"""),
                        pending,
                    )
            else:
                for item in files:
                    digest = self.search_cipher.digest(
                        "owner-search-file", [job["job_id"], item["id"]]
                    )
                    if self._row(
                        connection,
                        "SELECT position FROM drive_owner_search_results WHERE job_id=:job AND file_digest=:digest",
                        {"job": job["job_id"], "digest": digest},
                    ):
                        if checkpoint.get("coverage_manifest"):
                            counts = checkpoint.setdefault("coverage_counts", {})
                            counts["deduplicatedCount"] = counts.get("deduplicatedCount", 0) + 1
                        continue
                    if count == MAX_RESULTS:
                        if selection is None or selection[0] >= MAX_RESULTS:
                            limited = True
                            break
                        retained = self._retain_latest_candidates(connection, job, selection)
                        if retained is None:
                            limited = invalid_ranking = True
                            break
                        count, unshareable = retained
                        checkpoint["request_candidate_pool_pruned"] = True
                    count += 1
                    unshareable += int(item.get("shareable") is False)
                    connection.execute(
                        text(
                            "INSERT INTO drive_owner_search_results(job_id,user_id,position,file_digest,metadata_envelope) VALUES(:job,:user,:position,:digest,CAST(:envelope AS jsonb))"
                        ),
                        {
                            "job": job["job_id"],
                            "user": job["user_id"],
                            "position": count,
                            "digest": digest,
                            "envelope": self._seal(
                                item,
                                job["user_id"],
                                f"{job['job_id']}:{count}",
                                "owner-search-result",
                            ),
                        },
                    )
            if discovery_delivery(saved_checkpoint):
                checkpoint.setdefault("coverage_counts", {})["uniqueCandidateCount"] = count
            limited = limited or selection is None and count == MAX_RESULTS and not done
            is_incomplete = incomplete or row["incomplete_search"] or limited
            if selection is not None:
                checkpoint["request_results_finalized"] = False
                checkpoint["request_candidate_count"] = count
                if done and not is_incomplete:
                    selected = self._retain_latest_candidates(connection, job, selection)
                    if selected is None:
                        is_incomplete = invalid_ranking = True
                    else:
                        count, unshareable = selected
                        checkpoint["request_results_finalized"] = True
            state = (
                "limited"
                if limited or done and is_incomplete
                else "completed"
                if done
                else "running"
            )
            updated = self._row(
                connection,
                """UPDATE drive_owner_search_jobs SET matched=:count,
                pages_scanned=pages_scanned+1,unshareable_count=:unshareable,
                incomplete_search=:incomplete,status=:state,
                checkpoint_envelope=CAST(:envelope AS jsonb),retry_count=0,error_code=:code,
                lease_id=CASE WHEN :terminal THEN NULL ELSE lease_id END,
                lease_expires_at=CASE WHEN :terminal THEN NULL ELSE lease_expires_at END,
                revision=revision+1,updated_at=clock_timestamp() WHERE job_id=:job RETURNING *""",
                {
                    "job": job["job_id"],
                    "count": count,
                    "unshareable": unshareable,
                    "incomplete": is_incomplete,
                    "state": state,
                    "terminal": state != "running",
                    "code": "provider_response_invalid"
                    if invalid_ranking
                    else "search_limit"
                    if limited
                    else None,
                    "envelope": self._seal(
                        checkpoint, job["user_id"], job["job_id"], "owner-search-checkpoint"
                    ),
                },
            )
            return self._view(updated)

        result = await self._transaction(operation)
        if result["status"] == "completed" and checkpoint.get("request_origin_id"):
            # The final page may arrive after the last approved batch settled.
            # Reconcile the request in a separate transaction so the search job
            # lock and request lock never form a cycle with batch approval.
            from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore

            await DriveBulkShareStore(db=self.db, cipher=self.search_cipher).refresh_request(
                user_id=job["user_id"], request_id=checkpoint["request_origin_id"]
            )
        return result

    async def release(self, job, *, error=None, retryable=False):
        # Error/Stop cleanup must remain possible after OAuth revocation. It
        # cannot publish files or advance the checkpoint and only owns this lease.
        def operation(connection):
            self._lock(connection, {"user_id": job["user_id"], "connector_id": "google_drive"})
            row = self._owned(connection, job["user_id"], job["job_id"], locked=True)
            if row["status"] != "running" or str(row["lease_id"]) != job["lease_id"]:
                return row["status"]
            retries = row["retry_count"] + int(error is not None)
            retry = retryable and retries < 3
            state = "queued" if error is None or retry else "failed"
            # The table's public error-code constraint predates this local
            # adapter failure. Keep its precise cause only in the encrypted
            # checkpoint, while persisting a schema-compatible public code.
            checkpoint = None
            if error == "operation_not_allowed":
                detail = self._checkpoint(row)
                detail["last_search_failure_cause"] = error
                checkpoint = self._seal(
                    detail, job["user_id"], str(row["job_id"]), "owner-search-checkpoint"
                )
            code = (
                error
                if error
                in {
                    "provider_unavailable",
                    "connection_changed",
                    "connector_unavailable",
                    "provider_response_invalid",
                }
                else "provider_unavailable"
                if error
                else None
            )
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET status=:state,error_code=:code,
                retry_count=:retries,lease_id=NULL,lease_expires_at=NULL,
                checkpoint_envelope=COALESCE(CAST(:checkpoint AS jsonb),checkpoint_envelope),
                next_at=clock_timestamp()+(:delay * INTERVAL '1 second'),revision=revision+1,
                updated_at=clock_timestamp() WHERE job_id=:job"""),
                {
                    "job": job["job_id"],
                    "state": state,
                    "code": code,
                    "checkpoint": checkpoint,
                    "retries": min(retries, 3),
                    # Equal jitter: owners rate limited together (429 or a
                    # userRateLimitExceeded 403) do not all retry in lockstep.
                    "delay": 5 * 2 ** (retries - 1) * (0.5 + random.random() / 2)  # noqa: S311
                    if retry
                    else 0,
                },
            )
            return state

        return await self._transaction(operation)

    async def pause_for_background(self, job):
        """Keep a trusted search checkpoint dormant until owner setup resumes it."""

        def operation(connection):
            self._lock(connection, {"user_id": job["user_id"], "connector_id": "google_drive"})
            row = self._owned(connection, job["user_id"], job["job_id"], locked=True)
            if row["status"] != "running" or str(row["lease_id"]) != job["lease_id"]:
                return row["status"]
            # Enabling background access may have raced with the failed
            # authority check. The preference row lock makes the decision
            # atomic with set_background's update in either order.
            try:
                self.background_current(
                    connection, user_id=job["user_id"], generation=job["generation"]
                )
                ready = True
            except DriveReadError:
                ready = False
            connection.execute(
                text("""UPDATE drive_owner_search_jobs
                  SET status='queued',error_code=NULL,lease_id=NULL,lease_expires_at=NULL,
                    next_at=CASE WHEN :ready THEN clock_timestamp() ELSE expires_at END,
                    updated_at=clock_timestamp()
                  WHERE job_id=:job"""),
                {"job": job["job_id"], "ready": ready},
            )
            return "queued"

        return await self._transaction(operation)
