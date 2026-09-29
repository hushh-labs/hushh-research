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
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher
from hushh_mcp.services.google_drive_adapter import DriveReadError

CONSENT_VERSION = "drive-owner-search-v1"
MAX_RESULTS = 10000
ACTIVE = frozenset({"queued", "running"})
_ROW = "SELECT * FROM drive_owner_search_jobs WHERE job_id=:job AND user_id=:user AND expires_at>clock_timestamp()"


def _identity(value: str) -> str:
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise DriveReadError("invalid_argument") from None


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
                        "contentPeriodVerified",
                        "folderDiscovery",
                    )
                    if key in manifest
                },
                **{
                    key: checkpoint.get("coverage_counts", {}).get(key, 0)
                    for key in (
                        "providerRowsScanned",
                        "providerFilePages",
                        "excludedByDateCount",
                        "excludedByKindCount",
                        "excludedByNoteTypeCount",
                        "excludedByTopicCount",
                        "excludedFolderTopicCount",
                        "deduplicatedCount",
                        "unavailableShortcutCount",
                        "resolvedShortcutCount",
                        "unavailableFolderCount",
                        "invalidMetadataCount",
                        "matchingFoldersDiscovered",
                        "matchingFoldersExhausted",
                    )
                },
                "workLimitReached": checkpoint.get("coverage_counts", {}).get(
                    "workLimitReached", False
                ),
                "providerPagesExhausted": row["status"] == "completed"
                and not row["incomplete_search"],
            }
        if checkpoint.get("request_origin_id"):
            # This owner-only bit lets an old completed request search be
            # refreshed before review. The checkpoint and result metadata
            # remain encrypted; no provider capability or file data escapes.
            result.setdefault("coverage", {})["shareabilityVerified"] = (
                checkpoint.get("request_shareability_version") == 1
            )
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

    async def create(self, *, user_id, client_request_id, request, checkpoint, confirmed):
        if confirmed is not True:
            raise DriveReadError("confirmation_required")
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
                "SELECT * FROM drive_owner_search_jobs WHERE user_id=:user AND client_request_id=:client",
                {"user": user_id, "client": client},
            )
            if existing:
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
            row = self._row(
                connection,
                """
                INSERT INTO drive_owner_search_jobs(job_id,user_id,client_request_id,request_digest,
                  connection_generation,consent_version,checkpoint_envelope)
                VALUES(:job,:user,:client,:digest,:generation,:consent,CAST(:envelope AS jsonb)) RETURNING *
            """,
                {
                    "job": identity,
                    "user": user_id,
                    "client": client,
                    "digest": digest,
                    "generation": current["connection_generation"],
                    "consent": CONSENT_VERSION,
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

    async def clear_terminal_request(self, *, user_id, request_id):
        client = _identity(request_id)

        def operation(connection):
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            row = self._row(
                connection,
                """SELECT * FROM drive_owner_search_jobs
                WHERE user_id=:user AND client_request_id=:client FOR UPDATE""",
                {"user": user_id, "client": client},
            )
            if row is None:
                return
            if row["status"] not in {"failed", "limited", "stopped"}:
                raise DriveReadError("search_in_progress")
            if self._row(
                connection,
                "SELECT share_id FROM drive_bulk_shares WHERE search_job_id=:job",
                {"job": row["job_id"]},
            ):
                raise DriveReadError("search_in_progress")
            connection.execute(
                text("DELETE FROM drive_owner_search_jobs WHERE job_id=:job"),
                {"job": row["job_id"]},
            )

        await self._transaction(operation)

    async def clear_legacy_completed_request(self, *, user_id, request_id):
        """Replace an old request search lacking Drive shareability evidence.

        A completed search may be discarded only while its origin request is
        pending and no review has frozen its results. The job row lock orders
        this operation before a concurrent review's source FOR SHARE lock.
        """
        client = _identity(request_id)

        def operation(connection):
            self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
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
            if row["connection_generation"] != current["connection_generation"]:
                raise DriveReadError("connection_changed")
            checkpoint = self._checkpoint(row)
            if (
                checkpoint.get("request_origin_id") != client
                or checkpoint.get("request_shareability_version") == 1
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
            if self._row(
                connection,
                """SELECT share_id FROM drive_bulk_shares
                WHERE origin_request_id=:request OR search_job_id=:job LIMIT 1""",
                {"request": client, "job": row["job_id"]},
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

    async def results(self, *, user_id, job_id, cursor=None, limit=25):
        identity = _identity(job_id)
        if type(limit) is not int or not 1 <= limit <= 25:
            raise DriveReadError("invalid_argument")
        after = self._after(user_id, identity, cursor)

        def operation(connection):
            current = self._access(connection, user_id, read_only=True)
            row = self._owned(connection, user_id, identity)
            if row["connection_generation"] != current["connection_generation"]:
                raise DriveReadError("connection_changed")
            rows = list(
                connection.execute(
                    text(
                        "SELECT * FROM drive_owner_search_results WHERE job_id=:job AND user_id=:user AND position>:after ORDER BY position LIMIT :limit"
                    ),
                    {"job": identity, "user": user_id, "after": after, "limit": limit + 1},
                ).mappings()
            )
            files = [
                {
                    **{
                        key: value
                        for key, value in self.search_cipher.open(
                            item["metadata_envelope"],
                            user_id=user_id,
                            resource_id=f"{identity}:{item['position']}",
                            purpose="owner-search-result",
                        ).items()
                        if key != "resourceKey"
                    },
                    "position": item["position"],
                }
                for item in rows[:limit]
            ]
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

    async def due(self, limit=1):
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
                  ORDER BY inspected_at,created_at,job_id LIMIT :limit FOR UPDATE SKIP LOCKED)
                UPDATE drive_owner_search_jobs j SET inspected_at=clock_timestamp()
                  FROM due WHERE j.job_id=due.job_id RETURNING j.job_id,j.user_id
            """),
                    {"limit": min(max(limit, 1), 20)},
                ).mappings()
            ]

        return await self._transaction(operation)

    async def claim(self, *, user_id, job_id):
        identity = _identity(job_id)

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
            }

        return await self._transaction(operation)

    def _current(self, connection, job):
        self._access(connection, job["user_id"], job["generation"])
        row = self._owned(connection, job["user_id"], job["job_id"], locked=True)
        current_mode = self._checkpoint(row).get("authority_mode", "owner")
        claimed_mode = job["checkpoint"].get("authority_mode", "owner")
        if current_mode != claimed_mode:
            raise DriveReadError("search_superseded")
        origin = job["checkpoint"].get("request_origin_id")
        if origin is not None:
            request = self._row(
                connection,
                """SELECT status,revision,expires_at,bulk_search_started_at,
                  preparation_error_code,recipient_user_id,request_envelope
                FROM drive_share_requests WHERE request_id=:request AND user_id=:user""",
                {"request": origin, "user": job["user_id"]},
            )
            if (
                request is None
                or request["status"] != "pending"
                or request["revision"] != job["checkpoint"].get("request_revision")
                or request["bulk_search_started_at"] is None
                or current_mode == "trusted_auto"
                and request["preparation_error_code"]
                in {"trusted_relationship_changed", "manual_search_active"}
                or request["expires_at"]
                <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            ):
                raise DriveReadError("search_superseded")
            if current_mode == "trusted_auto":
                private = self.search_cipher.open(
                    request["request_envelope"],
                    user_id=job["user_id"],
                    resource_id=str(origin),
                    purpose="request",
                )
                if private.get("trusted_auto") is not True:
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
                from hushh_mcp.services.drive_sharing_store import DriveSharingStore

                if not DriveSharingStore._trusted_recipient_current(
                    connection, job["user_id"], request["recipient_user_id"]
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

    async def commit_page(self, job, *, checkpoint, files, incomplete=False, done=False):
        # Provider collection pages may contain 100 metadata rows. The
        # person-facing result cursor remains a separate 25-file boundary.
        if not isinstance(files, list) or len(files) > 100:
            raise DriveReadError("invalid_argument")

        def operation(connection):
            row = self._current(connection, job)
            count = row["matched"]
            unshareable = row.get("unshareable_count", 0)
            limited = False
            for item in files:
                digest = self.search_cipher.digest("owner-search-file", [job["job_id"], item["id"]])
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
                    limited = True
                    break
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
                            item, job["user_id"], f"{job['job_id']}:{count}", "owner-search-result"
                        ),
                    },
                )
            limited = limited or count == MAX_RESULTS and not done
            is_incomplete = incomplete or row["incomplete_search"] or limited
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
                    "code": "search_limit" if limited else None,
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
                next_at=clock_timestamp()+(:delay * INTERVAL '1 second'),revision=revision+1,
                updated_at=clock_timestamp() WHERE job_id=:job"""),
                {
                    "job": job["job_id"],
                    "state": state,
                    "code": code,
                    "retries": min(retries, 3),
                    "delay": 5 * 2 ** (retries - 1) if retry else 0,
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
