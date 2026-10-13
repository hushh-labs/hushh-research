"""Request-scoped, encrypted content assessments on durable search candidates.

The search's existing lease is reused only after metadata discovery completes.
No transaction holds a lock during provider/model I/O. This store grants no
sharing authority: Allow separately binds the exact final digest and price.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore, _identity
from hushh_mcp.services.drive_request_package_assessment import (
    BoundDocumentAssessment,
    PackageAssessment,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

PACKAGE_KEY = "agent_package"
PACKAGE_VERSION = 1
MAX_BATCH = 6
MAX_OBSERVATION_BYTES = 16 * 1024
MAX_PACKAGE_BYTES = 24 * 1024
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_SAFE_ERRORS = frozenset(
    {
        "preparation_unavailable",
        "provider_unavailable",
        "source_changed",
        "source_unavailable",
        "unsupported_format",
        "no_extractable_text",
        "password_protected",
        "encrypted_pdf",
        "content_too_large",
        "encrypted_document",
        "file_too_large",
        "invalid_document",
        "background_preparation_required",
        "connection_changed",
        "package_budget_exceeded",
    }
)


def document_ref(position: int) -> str:
    return f"p{position}"


def _public_package(package=None, *, status="preparing", counts=None):
    package = package or {}
    answer = package.get("assessment", {})
    counts = counts or package.get("counts", {})
    return {
        "status": status,
        "revision": package.get("revision", 0),
        "digest": package.get("digest"),
        "selectedCount": len(package.get("selected_positions", [])),
        "evaluatedCount": counts.get("evaluated", 0),
        "candidateCount": counts.get("candidates", 0),
        "unreadableCount": counts.get("unreadable", 0),
        "confidenceScore": answer.get("confidence"),
        "confidenceBasis": "model_assessment",
        "importanceScore": answer.get("importance"),
        "suggestedPriceCents": answer.get("suggested_price_cents"),
        "priceReason": answer.get("rationale", ""),
        "summary": answer.get("coverage_summary", ""),
        "coverageStatus": answer.get("coverage_status", "unknown"),
        "gaps": answer.get("gaps", []),
        "canAllow": status == "ready" and bool(package.get("selected_positions")),
    }


class DriveRequestPackageStore(DriveOwnerSearchStore):
    def __init__(self, db=None, *, cipher=None, sharing=None):
        super().__init__(db=db, cipher=cipher)
        if sharing is None:
            from hushh_mcp.services.drive_sharing_store import DriveSharingStore

            sharing = DriveSharingStore(db=self.db)
            sharing.sharing_cipher = self.search_cipher
        self.sharing = sharing

    def _gate(self, connection, *, user_id, request_id, generation=None):
        """Preparation authority: current pair + owner background consent only."""
        self.sharing._sharing_admission(user_id)
        participants = self.sharing._participant_gate(connection, user_id, request_id)
        self.sharing._sharing_admission(participants["recipient_user_id"])
        current = self.live_active(connection, user_id=user_id, generation=generation)
        self.background_current(
            connection, user_id=user_id, generation=current["connection_generation"]
        )
        self.sharing._relationship(connection, user_id, participants["recipient_user_id"])
        return current

    def _unfrozen(self, connection, *, user_id, request_id):
        if connection.execute(
            text("""SELECT EXISTS(SELECT 1 FROM drive_bulk_shares
                WHERE user_id=:user AND origin_request_id=:request)
                OR EXISTS(SELECT 1 FROM drive_request_payment_orders
                WHERE request_id=:request)"""),
            {"user": user_id, "request": request_id},
        ).scalar_one():
            raise DriveSharingError("package_frozen")

    def _request_current(self, connection, row, *, unfrozen=True):
        checkpoint = self._checkpoint(row)
        request_id = str(row["client_request_id"])
        request = self.sharing._request(connection, row["user_id"], request_id)
        private = self.sharing._open_request(request)
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        if (
            private.get("agent_package_required") is not True
            or request["status"] != "pending"
            or request["access_stop_requested_at"] is not None
            or request["expires_at"] <= now
            or request["bulk_search_started_at"] is None
            or checkpoint.get("request_origin_id") != request_id
            or checkpoint.get("request_revision") != request["revision"]
            or row["status"] != "completed"
            or row["incomplete_search"]
            or row["expires_at"] <= now
            or (
                checkpoint.get("request_result_limit") is not None
                and checkpoint.get("request_results_finalized") is not True
            )
        ):
            raise DriveSharingError("package_changed")
        if unfrozen:
            self._unfrozen(connection, user_id=row["user_id"], request_id=request_id)
        return request, checkpoint

    def _evaluation_current(self, connection, job):
        self._gate(
            connection,
            user_id=job["user_id"],
            request_id=job["request_id"],
            generation=job["generation"],
        )
        row = self._owned(connection, job["user_id"], job["job_id"], locked=True)
        request, checkpoint = self._request_current(connection, row)
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        if (
            row["evaluation_status"] != "running"
            or str(row["lease_id"]) != job["lease_id"]
            or row["lease_expires_at"] is None
            or row["lease_expires_at"] <= now
            or request["revision"] != job["request_revision"]
            or row["connection_generation"] != job["generation"]
        ):
            raise DriveSharingError("package_changed")
        return row, request, checkpoint

    async def due_evaluations(self, limit=2):
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("invalid evaluation limit")

        def operation(connection):
            rows = [
                dict(row)
                for row in connection.execute(
                    text("""WITH due AS (
                      SELECT j.job_id FROM drive_owner_search_jobs j
                      JOIN drive_share_requests r ON r.request_id=j.client_request_id
                        AND r.user_id=j.user_id
                      WHERE j.status='completed' AND j.incomplete_search=FALSE
                        AND r.agent_package_required=TRUE
                        AND j.evaluation_status IN ('pending','running')
                        AND j.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp()
                        AND r.status='pending' AND r.access_stop_requested_at IS NULL
                        AND j.evaluation_next_at<=clock_timestamp()
                        AND (j.lease_id IS NULL OR j.lease_expires_at<=clock_timestamp())
                        AND NOT EXISTS(SELECT 1 FROM drive_bulk_shares b
                          WHERE b.user_id=j.user_id AND b.origin_request_id=r.request_id)
                        AND NOT EXISTS(SELECT 1 FROM drive_request_payment_orders o
                          WHERE o.request_id=r.request_id)
                      ORDER BY j.inspected_at,j.created_at,j.job_id
                      LIMIT :limit FOR UPDATE OF j SKIP LOCKED)
                    UPDATE drive_owner_search_jobs j SET inspected_at=clock_timestamp()
                    FROM due WHERE j.job_id=due.job_id RETURNING j.user_id,j.job_id"""),
                    {"limit": limit},
                ).mappings()
            ]
            result = []
            for item in rows:
                request = self._row(
                    connection,
                    """SELECT r.* FROM drive_share_requests r JOIN drive_owner_search_jobs j
                      ON j.client_request_id=r.request_id AND j.user_id=r.user_id
                      WHERE j.job_id=:job AND j.user_id=:user""",
                    {"job": item["job_id"], "user": item["user_id"]},
                )
                if (
                    request
                    and self.sharing._open_request(request).get("agent_package_required") is True
                ):
                    result.append(item)
            return result

        return await self._transaction(operation)

    async def claim_evaluation(self, *, user_id, job_id, batch_size=MAX_BATCH):
        if type(batch_size) is not int or not 1 <= batch_size <= MAX_BATCH:
            raise ValueError("invalid evaluation batch size")
        identity = _identity(job_id)

        def operation(connection):
            initial = self._owned(connection, user_id, identity)
            request_id = str(initial["client_request_id"])
            self._gate(
                connection,
                user_id=user_id,
                request_id=request_id,
                generation=initial["connection_generation"],
            )
            row = self._owned(connection, user_id, identity, locked=True)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row["evaluation_status"] not in {"pending", "running"}
                or row["evaluation_next_at"] > now
                or row["lease_expires_at"] is not None
                and row["lease_expires_at"] > now
            ):
                return None
            request, checkpoint = self._request_current(connection, row)
            candidates = []
            for candidate in connection.execute(
                text("""SELECT position,file_digest,metadata_envelope
                    FROM drive_owner_search_results WHERE user_id=:user AND job_id=:job
                    AND evaluated_at IS NULL ORDER BY position LIMIT :limit"""),
                {"user": user_id, "job": identity, "limit": batch_size},
            ).mappings():
                position = candidate["position"]
                candidates.append(
                    {
                        "position": position,
                        "document_ref": document_ref(position),
                        "file_digest": candidate["file_digest"],
                        "metadata": self.search_cipher.open(
                            candidate["metadata_envelope"],
                            user_id=user_id,
                            resource_id=f"{identity}:{position}",
                            purpose="owner-search-result",
                        ),
                    }
                )
            remaining = connection.execute(
                text("""SELECT count(*) FROM drive_owner_search_results
                    WHERE job_id=:job AND evaluated_at IS NULL"""),
                {"job": identity},
            ).scalar_one()
            lease = str(uuid4())
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET evaluation_status='running',
                    lease_id=:lease,lease_expires_at=clock_timestamp()+INTERVAL '120 seconds',
                    evaluation_error_code=NULL,updated_at=clock_timestamp() WHERE job_id=:job"""),
                {"job": identity, "lease": lease},
            )
            return {
                "user_id": user_id,
                "job_id": identity,
                "request_id": request_id,
                "request_revision": request["revision"],
                "generation": row["connection_generation"],
                "lease_id": lease,
                "purpose": self.sharing._open_request(request)["purpose"],
                "checkpoint": checkpoint,
                "candidates": candidates,
                "remaining": remaining - len(candidates),
                "candidate_count": row["matched"],
            }

        return await self._transaction(operation)

    async def require_evaluation_current(self, job):
        await self._transaction(lambda connection: self._evaluation_current(connection, job))

    def _observation(self, value, expected):
        if not isinstance(value, dict) or value.get("position") != expected["position"]:
            raise ValueError("invalid candidate position")
        policy = value.get("assessment_policy_version")
        if not isinstance(policy, str) or not 1 <= len(policy) <= 128:
            raise ValueError("assessment evidence requires its policy version")
        reason = value.get("unreadable_reason")
        version, fingerprint = value.get("source_version"), value.get("content_fingerprint")
        if type(value.get("truncated", False)) is not bool:
            raise ValueError("invalid truncation flag")
        if reason is not None:
            if reason not in _SAFE_ERRORS or value.get("assessment") is not None:
                raise ValueError("unreadable document cannot be assessed")
            assessment = None
        else:
            if (
                not isinstance(version, str)
                or not 1 <= len(version) <= 256
                or not isinstance(fingerprint, str)
                or not _HASH.fullmatch(fingerprint)
            ):
                raise ValueError("read evidence requires version and content fingerprint")
            assessment = BoundDocumentAssessment.model_validate(value.get("assessment"))
            if (
                assessment.document_ref != expected["document_ref"]
                or assessment.source_version != version
            ):
                raise ValueError("assessment source identity changed")
            if (
                assessment.decision == "include"
                and expected["metadata"].get("shareable") is not True
            ):
                raise ValueError("included file has no sharing capability")
            assessment = assessment.model_dump(mode="json")
        result = {
            "position": expected["position"],
            "document_ref": expected["document_ref"],
            "file_digest": expected["file_digest"],
            "source_version": version,
            "content_fingerprint": fingerprint,
            "assessment_policy_version": policy,
            "assessment": assessment,
            "truncated": value.get("truncated", False),
            "unreadable_reason": reason,
        }
        if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_OBSERVATION_BYTES:
            raise ValueError("assessment exceeds evidence budget")
        return result

    async def commit_evaluations(self, job, *, observations):
        expected = {item["position"]: item for item in job["candidates"]}
        if (
            not isinstance(observations, list)
            or len(observations) != len(expected)
            or not expected
            or {item.get("position") for item in observations if isinstance(item, dict)}
            != set(expected)
        ):
            raise ValueError("evaluation must account for the entire claimed batch")
        values = [self._observation(item, expected[item["position"]]) for item in observations]

        def operation(connection):
            self._evaluation_current(connection, job)
            for value in values:
                position = value["position"]
                current = self._row(
                    connection,
                    """SELECT file_digest,evaluated_at FROM drive_owner_search_results
                      WHERE job_id=:job AND user_id=:user AND position=:position FOR UPDATE""",
                    {"job": job["job_id"], "user": job["user_id"], "position": position},
                )
                if (
                    current is None
                    or current["file_digest"] != value["file_digest"]
                    or current["evaluated_at"] is not None
                ):
                    raise DriveSharingError("package_changed")
                connection.execute(
                    text("""UPDATE drive_owner_search_results SET evaluation_envelope=CAST(:envelope AS jsonb),
                      evaluated_at=clock_timestamp() WHERE job_id=:job AND position=:position"""),
                    {
                        "job": job["job_id"],
                        "position": position,
                        "envelope": self._seal(
                            value,
                            job["user_id"],
                            f"{job['job_id']}:{position}",
                            "request-package-evidence",
                        ),
                    },
                )
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET evaluation_attempts=0,updated_at=clock_timestamp() WHERE job_id=:job"
                ),
                {"job": job["job_id"]},
            )
            return {"committed": len(values)}

        return await self._transaction(operation)

    async def release_evaluation(self, job, *, retryable=False, error=None):
        code = error if error in _SAFE_ERRORS else "preparation_unavailable" if error else None

        def operation(connection):
            row = self._owned(connection, job["user_id"], job["job_id"], locked=True)
            if str(row["lease_id"]) != job["lease_id"] or row["evaluation_status"] != "running":
                return "superseded"
            consent_paused = code == "background_preparation_required"
            attempts = min(
                3, row["evaluation_attempts"] + int(code is not None and not consent_paused)
            )
            status = (
                "pending"
                if code is None or consent_paused or retryable and attempts < 3
                else "failed"
            )
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET evaluation_status=:status,
                    evaluation_attempts=:attempts,evaluation_error_code=:code,
                    evaluation_next_at=clock_timestamp()+CASE WHEN :code IS NULL THEN INTERVAL '0 seconds'
                      ELSE INTERVAL '30 seconds' END,lease_id=NULL,lease_expires_at=NULL,
                    updated_at=clock_timestamp() WHERE job_id=:job"""),
                {"job": job["job_id"], "status": status, "attempts": attempts, "code": code},
            )
            return status

        return await self._transaction(operation)

    def _evidence(self, connection, row, *, after_position=0, limit=100):
        values = []
        for item in connection.execute(
            text("""SELECT position,file_digest,evaluation_envelope FROM drive_owner_search_results
                WHERE job_id=:job AND position>:after AND evaluated_at IS NOT NULL
                ORDER BY position LIMIT :limit"""),
            {"job": row["job_id"], "after": after_position, "limit": limit},
        ).mappings():
            value = self.search_cipher.open(
                item["evaluation_envelope"],
                user_id=row["user_id"],
                resource_id=f"{row['job_id']}:{item['position']}",
                purpose="request-package-evidence",
            )
            if (
                value.get("position") != item["position"]
                or value.get("file_digest") != item["file_digest"]
                or value.get("document_ref") != document_ref(item["position"])
            ):
                raise DriveSharingError("package_changed")
            values.append(value)
        return values

    def _counts(self, connection, row):
        result = (
            connection.execute(
                text("""SELECT count(*) AS candidates,count(evaluated_at) AS evaluated
                FROM drive_owner_search_results WHERE job_id=:job"""),
                {"job": row["job_id"]},
            )
            .mappings()
            .one()
        )
        return dict(result)

    async def package_evidence_page(self, job, *, after_position=0, limit=100):
        if (
            type(after_position) is not int
            or not 0 <= after_position <= 10000
            or type(limit) is not int
            or not 1 <= limit <= 100
        ):
            raise ValueError("invalid package evidence page")

        def operation(connection):
            row, _, _ = self._evaluation_current(connection, job)
            items = self._evidence(connection, row, after_position=after_position, limit=limit + 1)
            more = len(items) > limit
            return {
                "items": items[:limit],
                "next_position": items[limit - 1]["position"] if more else None,
                "counts": self._counts(connection, row),
            }

        return await self._transaction(operation)

    def _manifest(self, connection, row, selected_positions):
        selected = set(selected_positions)
        if len(selected) != len(selected_positions):
            raise DriveSharingError("package_changed")
        counts = {**self._counts(connection, row), "unreadable": 0, "truncated": 0, "uncertain": 0}
        sources, after = [], 0
        while True:
            items = self._evidence(connection, row, after_position=after)
            if not items:
                break
            for item in items:
                counts["unreadable"] += int(item["unreadable_reason"] is not None)
                counts["truncated"] += int(item["truncated"])
                assessment = item.get("assessment")
                counts["uncertain"] += int(
                    bool(assessment and assessment.get("decision") == "uncertain")
                )
                if item["position"] in selected:
                    if (
                        not assessment
                        or assessment.get("decision") != "include"
                        or item["unreadable_reason"]
                    ):
                        raise DriveSharingError("package_changed")
                    sources.append(
                        {
                            key: item[key]
                            for key in (
                                "position",
                                "file_digest",
                                "source_version",
                                "content_fingerprint",
                            )
                        }
                        | {
                            "evidence_digest": hashlib.sha256(
                                json.dumps(
                                    item, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                                ).encode()
                            ).hexdigest()
                        }
                    )
            after = items[-1]["position"]
        if (
            len(sources) != len(selected)
            or counts["candidates"] != row["matched"]
            or counts["evaluated"] != counts["candidates"]
        ):
            raise DriveSharingError("package_incomplete")
        return sources, counts

    def _digest(self, row, request, package, sources):
        return self.search_cipher.digest(
            "request-agent-package-v1",
            [
                row["user_id"],
                request["recipient_user_id"],
                str(request["request_id"]),
                request["revision"],
                row["connection_generation"],
                package["revision"],
                package["policy_version"],
                package["assessment"],
                sources,
            ],
        )

    async def finalize_package(self, job, *, assessment, policy_version):
        answer = PackageAssessment.model_validate(assessment).model_dump(mode="json")
        if not isinstance(policy_version, str) or not 1 <= len(policy_version) <= 128:
            raise ValueError("invalid package policy version")
        positions = []
        for ref in answer["selected_document_refs"]:
            if not re.fullmatch(r"p[1-9][0-9]{0,4}", ref) or int(ref[1:]) > 10000:
                raise ValueError("invalid selected document reference")
            positions.append(int(ref[1:]))

        def operation(connection):
            row, request, checkpoint = self._evaluation_current(connection, job)
            sources, counts = self._manifest(connection, row, positions)
            if answer["decision"] == "ready" and any(
                counts[key] for key in ("unreadable", "truncated", "uncertain")
            ):
                raise DriveSharingError("package_incomplete")
            previous = checkpoint.get(PACKAGE_KEY, {})
            package = {
                "schema_version": PACKAGE_VERSION,
                "revision": previous.get("revision", 0) + 1,
                "policy_version": policy_version,
                "assessment": answer,
                "selected_positions": sorted(positions),
                "counts": counts,
                "request_revision": request["revision"],
                "connection_generation": row["connection_generation"],
            }
            package["digest"] = self._digest(row, request, package, sources)
            if len(json.dumps(package, ensure_ascii=False).encode()) > MAX_PACKAGE_BYTES:
                raise ValueError("package summary exceeds budget")
            checkpoint[PACKAGE_KEY] = package
            status = (
                "ready"
                if positions
                else "no_match"
                if answer["decision"] == "no_match"
                else "failed"
            )
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb),
                    evaluation_status=:status,evaluation_error_code=NULL,lease_id=NULL,
                    lease_expires_at=NULL,updated_at=clock_timestamp() WHERE job_id=:job"""),
                {
                    "job": job["job_id"],
                    "status": status,
                    "envelope": self._seal(
                        checkpoint, job["user_id"], job["job_id"], "owner-search-checkpoint"
                    ),
                },
            )
            return _public_package(package, status="unavailable" if status == "failed" else status)

        return await self._transaction(operation)

    def validate_ready_package(self, connection, row, private, package_revision, package_digest):
        """Called under the owner's request transaction; does not approve anything."""
        if (
            type(package_revision) is not int
            or not isinstance(package_digest, str)
            or not _HASH.fullmatch(package_digest)
        ):
            raise DriveSharingError("package_changed")
        connection_state = self._gate(
            connection, user_id=row["user_id"], request_id=str(row["request_id"])
        )
        search = self._row(
            connection,
            "SELECT * FROM drive_owner_search_jobs WHERE user_id=:user AND client_request_id=:request FOR UPDATE",
            {"user": row["user_id"], "request": row["request_id"]},
        )
        if search is None:
            raise DriveSharingError("package_not_ready")
        current, checkpoint = self._request_current(connection, search)
        package = checkpoint.get(PACKAGE_KEY, {})
        if (
            search["evaluation_status"] != "ready"
            or search["connection_generation"] != connection_state["connection_generation"]
            or package.get("schema_version") != PACKAGE_VERSION
            or package.get("revision") != package_revision
            or package.get("request_revision") != row["revision"]
            or package.get("connection_generation") != search["connection_generation"]
            or not package.get("selected_positions")
            or not hmac.compare_digest(str(package.get("digest", "")), package_digest)
        ):
            raise DriveSharingError("package_changed")
        sources, _ = self._manifest(connection, search, package["selected_positions"])
        if not hmac.compare_digest(self._digest(search, current, package, sources), package_digest):
            raise DriveSharingError("package_changed")
        return {
            "summary": _public_package(package, status="ready"),
            "selected_positions": package["selected_positions"],
            "selected_sources": sources,
            "search_job_id": str(search["job_id"]),
        }

    async def package_review(self, *, user_id, request_id):
        identity = _identity(request_id)

        def operation(connection):
            self.sharing._participant_gate(connection, user_id, identity)
            current = self.live_active(connection, user_id=user_id)
            request = self.sharing._request(connection, user_id, identity)
            private = self.sharing._open_request(request)
            if private.get("agent_package_required") is not True:
                return None
            row = self._row(
                connection,
                "SELECT * FROM drive_owner_search_jobs WHERE user_id=:user AND client_request_id=:request",
                {"user": user_id, "request": identity},
            )
            if row is None:
                return _public_package()
            checkpoint = self._checkpoint(row)
            package = checkpoint.get(PACKAGE_KEY)
            status = {
                "pending": "preparing",
                "running": "preparing",
                "ready": "ready",
                "no_match": "no_match",
                "failed": "unavailable",
                "obsolete": "stale",
            }[row["evaluation_status"]]
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            if (
                row["connection_generation"] != current["connection_generation"]
                or checkpoint.get("request_revision") != request["revision"]
                or row["expires_at"] <= now
            ):
                status = "stale"
            marker = private.get("owner_allowed", {})
            if (
                package
                and request.get("owner_allowed_at") is not None
                and marker.get("package_digest") == package.get("digest")
            ):
                status = "allowed"
            if request["status"] != "pending" or request["access_stop_requested_at"] is not None:
                status = "allowed" if status == "allowed" else "stale"
            return _public_package(
                package,
                status=status,
                counts=package.get("counts") if package else self._counts(connection, row),
            )

        return await self._transaction(operation)
