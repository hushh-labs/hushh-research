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
                return view(existing), False
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
            return view(row), True

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
            return view(row)

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
            return view(self._owned(connection, user_id, identity))

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
            return view(row)

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
            return {"jobs": [view(dict(row)) for row in rows]}

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
                    **self.search_cipher.open(
                        item["metadata_envelope"],
                        user_id=user_id,
                        resource_id=f"{identity}:{item['position']}",
                        purpose="owner-search-result",
                    ),
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
            return view(row)

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
        origin = job["checkpoint"].get("request_origin_id")
        if origin is not None:
            request = self._row(
                connection,
                """SELECT status,revision,expires_at,bulk_search_started_at
                FROM drive_share_requests WHERE request_id=:request AND user_id=:user""",
                {"request": origin, "user": job["user_id"]},
            )
            if (
                request is None
                or request["status"] != "pending"
                or request["revision"] != job["checkpoint"].get("request_revision")
                or request["bulk_search_started_at"] is None
                or request["expires_at"]
                <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
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
        if not isinstance(files, list) or len(files) > 25:
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
            return view(updated)

        return await self._transaction(operation)

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
