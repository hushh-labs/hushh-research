"""Request-scoped frozen provider selections and legacy encrypted assessments.

The search's existing lease is reused only after metadata discovery completes.
No transaction holds a lock during provider/model I/O. This store grants no
sharing authority: Allow separately binds the exact final digest and price.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from datetime import date

from sqlalchemy import text

from hushh_mcp.services.drive_owner_search_service import (
    _MEETING_SUBJECT,
    _is_meeting_note_request,
)
from hushh_mcp.services.drive_owner_search_store import (
    MAX_RESULTS,
    DriveOwnerSearchStore,
    _identity,
)
from hushh_mcp.services.drive_provider_request_package import (
    _provider_package,
    finalize_provider_packet,
    provider_manifest,
    provider_package_digest,
    provider_public_package,
    validate_provider_package,
)
from hushh_mcp.services.drive_request_package_assessment import (
    BoundDocumentAssessment,
    PackageAssessment,
)
from hushh_mcp.services.drive_request_package_queue import (
    MAX_BATCH,
    claim_evaluation,
    document_ref,
    due_evaluations,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

PACKAGE_KEY = "agent_package"
PACKAGE_VERSION = 1
V1_FIRST_COHORT = 25
V1_PRIORITY_FIELD = "v1_evaluation_priority"
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


def _metadata_priority(metadata, *, plan, purpose):
    """Order reads using cheap hints; no hint excludes or verifies a document."""
    name = " ".join(str(metadata.get(key) or "") for key in ("name", "shortcutName")).casefold()
    context = " ".join(
        str(metadata.get(key) or "") for key in ("folderName", "folderPath")
    ).casefold()
    entities = [
        value.casefold() for value in plan.get("required_entities", []) if isinstance(value, str)
    ]
    clues = {
        value.casefold()
        for key in ("terms", "discovery_clues")
        for value in plan.get(key, [])
        if isinstance(value, str) and len(value) >= 3
    }
    anatomy = {
        word.casefold()
        for word in re.findall(r"\w{4,}", str(plan.get("expected_document_anatomy") or ""))
    }
    years = set()
    try:
        start = date.fromisoformat(purpose["periodStart"])
        end = date.fromisoformat(purpose["periodEnd"])
        years = {str(year) for year in range(start.year, end.year + 1)}
    except (KeyError, TypeError, ValueError):
        pass
    # The deterministic meeting plan searches these title aliases, but its
    # generic "notes" term and a year can otherwise outrank a "Team Sync"
    # title in the first evaluation cohort. This only changes read order.
    meeting_title_hint = 20 * bool(
        plan.get("semantic_intent") not in {"institutional_statement", "broad_financial_records"}
        and _is_meeting_note_request(str(purpose.get("purpose") or ""))
        and _MEETING_SUBJECT.search(name)
    )
    return (
        40 * sum(value in name for value in entities)
        + 10 * sum(value in context for value in entities)
        + 4 * sum(value in name for value in clues)
        + sum(value in context for value in clues)
        + min(8, sum(value in name for value in anatomy))
        + 12 * bool(years.intersection(re.findall(r"(?<!\d)\d{4}(?!\d)", name)))
        + meeting_title_hint
    )


def _public_package(package=None, *, status="preparing", counts=None):
    package = package or {}
    answer = package.get("assessment", {})
    counts = counts or package.get("counts", {})
    result = {
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
        "canAllow": status == "ready"
        and (
            package.get("v1_statement_search") is not True
            or (answer.get("decision") == "ready" and answer.get("coverage_status") == "complete")
        )
        and bool(package.get("selected_positions")),
    }
    return provider_public_package(package, result)


def _review_status(row):
    # A failed discovery cannot reach the content evaluator, whose status
    # therefore remains pending. Search terminality takes precedence.
    if row["status"] in {"failed", "limited", "stopped"} or (
        row["status"] == "completed" and row["incomplete_search"]
    ):
        return "unavailable"
    if row["status"] != "completed":
        return "preparing"
    return {
        "pending": "preparing",
        "running": "preparing",
        "ready": "ready",
        "no_match": "no_match",
        "failed": "unavailable",
        "obsolete": "stale",
    }[row["evaluation_status"]]


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
        if checkpoint.get("reusable_packet") != private.get("reusable_packet"):
            raise DriveSharingError("package_changed")
        from hushh_mcp.services.drive_owner_allowed import package_allow_marker

        allowed = package_allow_marker(private)
        self._evidence_current(
            connection,
            checkpoint,
            row["user_id"],
            approved_terms=bool(
                allowed
                and request["owner_allowed_at"] is not None
                and allowed["request_revision"] == request["revision"]
            ),
        )
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

    async def due_evaluations(self, limit=2, *, v1_only=False, provider_only=False):
        return await due_evaluations(self, limit, v1_only=v1_only, provider_only=provider_only)

    def _v1_priority(self, connection, row, checkpoint, purpose):
        if (
            row["v1_statement_search"] is not True
            or checkpoint.get("v1_live_request") is not True
            or checkpoint.get("evidence_route", "provider") != "provider"
        ):
            return []
        saved = checkpoint.get(V1_PRIORITY_FIELD)
        if saved is None:
            # One bounded read/decrypt pass per completed discovery, not one
            # DB round trip per file or a fresh ranking on every worker wake.
            candidates = list(
                connection.execute(
                    text("""SELECT position,metadata_envelope FROM drive_owner_search_results
                    WHERE user_id=:user AND job_id=:job ORDER BY position LIMIT :limit"""),
                    {"user": row["user_id"], "job": row["job_id"], "limit": MAX_RESULTS + 1},
                ).mappings()
            )
            if len(candidates) != row["matched"] or len(candidates) > MAX_RESULTS:
                raise DriveSharingError("package_changed")
            plan = checkpoint.get("authored_plan") or {}
            scored = []
            for candidate in candidates:
                position = candidate["position"]
                metadata = self.search_cipher.open(
                    candidate["metadata_envelope"],
                    user_id=row["user_id"],
                    resource_id=f"{row['job_id']}:{position}",
                    purpose="owner-search-result",
                )
                scored.append((_metadata_priority(metadata, plan=plan, purpose=purpose), position))
            scored.sort(key=lambda item: (-item[0], item[1]))
            saved = {
                "version": 1,
                "candidate_count": row["matched"],
                "positions": [position for _, position in scored[:V1_FIRST_COHORT]],
            }
            checkpoint[V1_PRIORITY_FIELD] = saved
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb)
                    WHERE user_id=:user AND job_id=:job"""),
                {
                    "user": row["user_id"],
                    "job": row["job_id"],
                    "envelope": self._seal(
                        checkpoint, row["user_id"], str(row["job_id"]), "owner-search-checkpoint"
                    ),
                },
            )
        positions = saved.get("positions") if isinstance(saved, dict) else None
        if (
            not isinstance(saved, dict)
            or saved.get("version") != 1
            or saved.get("candidate_count") != row["matched"]
            or not isinstance(positions, list)
            or len(positions) != min(V1_FIRST_COHORT, row["matched"])
            or any(type(value) is not int or not 1 <= value <= MAX_RESULTS for value in positions)
            or len(set(positions)) != len(positions)
        ):
            raise DriveSharingError("package_changed")
        return positions

    async def claim_evaluation(
        self, *, user_id, job_id, batch_size=MAX_BATCH, v1_only=False, provider_only=False
    ):
        return await claim_evaluation(
            self,
            user_id=user_id,
            job_id=job_id,
            batch_size=batch_size,
            v1_only=v1_only,
            provider_only=provider_only,
        )

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
        indexed = value.get("indexed_evidence")
        if indexed is not None and indexed != expected["metadata"].get("indexedEvidence"):
            raise ValueError("indexed evidence identity changed")
        result = {
            **({"indexed_evidence": indexed} if indexed is not None else {}),
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
            _, _, checkpoint = self._evaluation_current(connection, job)
            for value in values:
                if (
                    job.get("v1_statement_search") is True
                    and (value.get("assessment") or {}).get("decision") == "include"
                    and value["assessment"].get("weightage_out_of_10") is None
                ):
                    raise DriveSharingError("package_incomplete")
                if value.get("indexed_evidence"):
                    from hushh_mcp.services.drive_document_facts_store import (
                        DriveDocumentFactsStore,
                    )

                    DriveDocumentFactsStore(db=self.db)._current_document(
                        connection, owner_user_id=job["user_id"], **value["indexed_evidence"]
                    )
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
            if job.get("v1_statement_search") is True:
                preview = checkpoint.get("v1_verified_preview", {"files": [], "count": 0})
                files = list(preview["files"])
                included = 0
                for value in values:
                    assessment = value.get("assessment") or {}
                    if (
                        assessment.get("decision") != "include"
                        or value["unreadable_reason"]
                        or value["truncated"]
                    ):
                        continue
                    included += 1
                    files.append(
                        {
                            "position": value["position"],
                            "name": expected[value["position"]]["metadata"]["name"],
                            "weightageOutOf10": assessment["weightage_out_of_10"],
                            "confidenceScore": assessment["confidence"],
                        }
                    )
                files.sort(
                    key=lambda item: (
                        -item["weightageOutOf10"],
                        -item["confidenceScore"],
                        item["position"],
                    )
                )
                checkpoint["v1_verified_preview"] = {
                    "files": files[:25],
                    "count": preview["count"] + included,
                }
                connection.execute(
                    text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb),
                        evaluation_attempts=0,revision=revision+1,updated_at=clock_timestamp() WHERE job_id=:job"""),
                    {
                        "job": job["job_id"],
                        "envelope": self._seal(
                            checkpoint, job["user_id"], job["job_id"], "owner-search-checkpoint"
                        ),
                    },
                )
            else:
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
                    revision=revision+CASE WHEN v1_statement_search THEN 1 ELSE 0 END,
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

    def _provider_manifest(self, connection, row, checkpoint, *, approved_terms=False):
        return provider_manifest(self, connection, row, checkpoint, approved_terms=approved_terms)

    async def finalize_provider_packet(self, job):
        return await finalize_provider_packet(self, job)

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
                    if row["v1_statement_search"] is True and (
                        assessment.get("weightage_out_of_10") is None
                        or not assessment.get("covered_periods")
                    ):
                        raise DriveSharingError("package_incomplete")
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
                            **(
                                {"indexed_evidence": item["indexed_evidence"]}
                                if item.get("indexed_evidence")
                                else {}
                            ),
                            "evidence_digest": hashlib.sha256(
                                json.dumps(
                                    item, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                                ).encode()
                            ).hexdigest(),
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
        if _provider_package(package):
            return provider_package_digest(self, row, request, package, sources)
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
                *([package["reusable_packet"]] if package.get("reusable_packet") else []),
                *([package["matched_packet"]] if package.get("matched_packet") else []),
                *(
                    [package["request_packet_verification"]]
                    if package.get("request_packet_verification")
                    else []
                ),
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
            if (checkpoint.get("reusable_packet") or checkpoint.get("matched_packet")) and (
                answer["decision"] != "ready" or len(positions) != counts["candidates"]
            ):
                raise DriveSharingError("package_changed")
            if (
                checkpoint.get("coverage_manifest", {}).get("fallbackReason")
                and answer["decision"] == "ready"
            ):
                raise DriveSharingError("package_incomplete")
            previous = checkpoint.get(PACKAGE_KEY, {})
            package = {
                "schema_version": PACKAGE_VERSION,
                **(
                    {
                        key: checkpoint[key]
                        for key in (
                            "reusable_packet",
                            "matched_packet",
                            "request_packet_verification",
                        )
                        if key in checkpoint
                    }
                ),
                "revision": previous.get("revision", 0) + 1,
                "policy_version": policy_version,
                "assessment": answer,
                "selected_positions": sorted(positions),
                "counts": counts,
                "request_revision": request["revision"],
                "connection_generation": row["connection_generation"],
                "v1_statement_search": row["v1_statement_search"] is True,
            }
            package["digest"] = self._digest(row, request, package, sources)
            if len(json.dumps(package, ensure_ascii=False).encode()) > MAX_PACKAGE_BYTES:
                raise ValueError("package summary exceeds budget")
            checkpoint[PACKAGE_KEY] = package
            genuine_no_match = (
                answer["decision"] == "no_match"
                and not positions
                and (
                    row["v1_statement_search"] is not True
                    or (
                        not any(counts[key] for key in ("unreadable", "truncated", "uncertain"))
                        and not checkpoint.get("coverage_manifest", {}).get("fallbackReason")
                    )
                )
            )
            status = "ready" if positions else "no_match" if genuine_no_match else "failed"
            connection.execute(
                text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb),
                    evaluation_status=:status,evaluation_error_code=NULL,lease_id=NULL,
                    lease_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE job_id=:job"""),
                {
                    "job": job["job_id"],
                    "status": status,
                    "envelope": self._seal(
                        checkpoint, job["user_id"], job["job_id"], "owner-search-checkpoint"
                    ),
                },
            )
            if (
                row["v1_statement_search"] is True
                and request.get("v1_live_request") is True
                and answer["decision"] == "ready"
                and self.sharing._open_request(request).get("trusted_auto") is not True
            ):
                self.sharing._activate_v1_manual_review(
                    connection, request=request, search=row, package=package, sources=sources
                )
            # A genuinely empty, fully evaluated V1 request is a terminal
            # outcome. The owner and buyer need the same Feed result that a
            # completed zero-file share would produce, with no checkout path.
            # Extraction failures, uncertainty and provider fallback cannot
            # establish that no matching document exists.
            if row["v1_statement_search"] is True and genuine_no_match:
                updated = self._row(
                    connection,
                    """UPDATE drive_share_requests SET status='no_match',updated_at=clock_timestamp()
                    WHERE request_id=:request AND user_id=:user AND revision=:revision
                      AND status='pending' AND access_stop_requested_at IS NULL
                    RETURNING *""",
                    {
                        "request": request["request_id"],
                        "user": request["user_id"],
                        "revision": request["revision"],
                    },
                )
                if updated is None:
                    raise DriveSharingError("package_changed")
                self.sharing._event(
                    connection, updated, updated["user_id"], "document_share_outcome"
                )
                self.sharing._event(
                    connection, updated, updated["recipient_user_id"], "document_share_outcome"
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
        if _provider_package(package):
            return validate_provider_package(
                self,
                connection,
                search,
                current,
                checkpoint,
                package,
                package_revision,
                package_digest,
            )
        if (
            search["evaluation_status"] != "ready"
            or search["connection_generation"] != connection_state["connection_generation"]
            or package.get("schema_version") != PACKAGE_VERSION
            or package.get("revision") != package_revision
            or package.get("request_revision") != row["revision"]
            or package.get("connection_generation") != search["connection_generation"]
            or not package.get("selected_positions")
            or (
                search["v1_statement_search"] is True
                and (
                    package.get("assessment", {}).get("decision") != "ready"
                    or package.get("assessment", {}).get("coverage_status") != "complete"
                )
            )
            or not hmac.compare_digest(str(package.get("digest", "")), package_digest)
        ):
            raise DriveSharingError("package_changed")
        sources, _ = self._manifest(connection, search, package["selected_positions"])
        if not hmac.compare_digest(self._digest(search, current, package, sources), package_digest):
            raise DriveSharingError("package_changed")
        from hushh_mcp.services.drive_request_package_disclosure import build_package_disclosure

        observations = []
        for item in connection.execute(
            text("""SELECT position,evaluation_envelope FROM drive_owner_search_results
                WHERE job_id=:job AND position=ANY(:positions) ORDER BY position"""),
            {"job": search["job_id"], "positions": package["selected_positions"]},
        ).mappings():
            observations.append(
                self.search_cipher.open(
                    item["evaluation_envelope"],
                    user_id=search["user_id"],
                    resource_id=f"{search['job_id']}:{item['position']}",
                    purpose="request-package-evidence",
                )
            )
        disclosure = build_package_disclosure(
            package=package, purpose=private["purpose"], observations=observations
        )
        return {
            "buyer_disclosure": disclosure,
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
            status = _review_status(row)
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
            if (
                request["status"] != "pending"
                and not (status == "no_match" and request["status"] == "no_match")
            ) or request["access_stop_requested_at"] is not None:
                status = "allowed" if status == "allowed" else "stale"
            public = _public_package(
                package,
                status=status,
                counts=package.get("counts") if package else self._counts(connection, row),
            )
            if status == "unavailable" and (
                row["status"] in {"failed", "limited", "stopped"} or row["incomplete_search"]
            ):
                public["searchErrorCode"] = row["error_code"] or (
                    "search_incomplete" if row["incomplete_search"] else "search_unavailable"
                )
            elif status == "unavailable" and row["evaluation_status"] == "failed":
                public["evaluationErrorCode"] = (
                    row["evaluation_error_code"] or "evaluation_unavailable"
                )
            if row["v1_statement_search"] is True and status in {"preparing", "ready", "allowed"}:
                preview = checkpoint.get("v1_verified_preview", {"files": [], "count": 0})
                public["provisionalFiles"] = preview["files"]
                public["verifiedCount"] = preview["count"]
                public["pendingCount"] = max(0, public["candidateCount"] - public["evaluatedCount"])
            if row["v1_statement_search"] is True and package and package.get("selected_positions"):
                selected = package["selected_positions"]
                files = []
                for item in connection.execute(
                    text("""SELECT position,metadata_envelope,evaluation_envelope
                        FROM drive_owner_search_results
                        WHERE user_id=:user AND job_id=:job AND position=ANY(:positions)
                        ORDER BY position"""),
                    {"user": user_id, "job": row["job_id"], "positions": selected},
                ).mappings():
                    metadata = self.search_cipher.open(
                        item["metadata_envelope"],
                        user_id=user_id,
                        resource_id=f"{row['job_id']}:{item['position']}",
                        purpose="owner-search-result",
                    )
                    evidence = self.search_cipher.open(
                        item["evaluation_envelope"],
                        user_id=user_id,
                        resource_id=f"{row['job_id']}:{item['position']}",
                        purpose="request-package-evidence",
                    )
                    assessment = evidence.get("assessment") or {}
                    if (
                        assessment.get("decision") != "include"
                        or type(assessment.get("confidence")) is not int
                        or assessment.get("weightage_out_of_10") is None
                    ):
                        raise DriveSharingError("package_changed")
                    files.append(
                        {
                            "position": item["position"],
                            "name": metadata["name"],
                            "weightageOutOf10": assessment["weightage_out_of_10"],
                            "confidenceScore": assessment["confidence"],
                        }
                    )
                if len(files) != len(selected):
                    raise DriveSharingError("package_changed")
                files.sort(
                    key=lambda item: (
                        -item["weightageOutOf10"],
                        -item["confidenceScore"],
                        item["position"],
                    )
                )
                public["selectedFiles"] = files[:25]
                public["selectedFileCount"] = len(package["selected_positions"])
            return public

        return await self._transaction(operation)
