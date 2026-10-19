"""Request-local content evidence; never consent, payment or grant authority.

Readers must use the bounded live-reader seams. Source text and metadata are
untrusted model inputs. Returned private observations belong only in the existing
encrypted request checkpoint; their digests are integrity bindings, not signatures.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from time import monotonic
from typing import Any, Literal

from hushh_mcp.services.drive_request_package_assessment import (
    MAX_BATCH_DOCUMENTS,
    MAX_PROMPT_BYTES,
    BoundDocumentAssessment,
    BoundDocumentBatchAssessment,
    RequestAssessmentAuthorityError,
    assess_request_document_batch,
    validate_request_document_batch,
)
from hushh_mcp.services.drive_request_semantic_plan import SemanticDrivePlan, semantic_plan_digest
from hushh_mcp.services.google_drive_adapter import DriveReadError

ASSESSMENT_MODE = "generic_request_candidate_v1"
MAX_CONTENT_BYTES = 120 * 1024
MAX_SOURCE_BYTES = 32 * 1024
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_READ_CODES = frozenset(
    {
        "source_changed",
        "source_unavailable",
        "unsupported_format",
        "invalid_document",
        "processor_unavailable",
        "processing_timeout",
        "scanner_unavailable",
        "unsafe_document",
        "encrypted_document",
        "file_too_large",
        "no_extractable_text",
        "provider_unavailable",
    }
)
_EVIDENCE_CODES = frozenset(
    {"source_changed", "content_incomplete", "invalid_content_evidence", "content_too_large"}
)
# Only these bounded labels may enter checkpoint diagnostics or operational logs.
CANDIDATE_OBSERVATION_CODES = (
    _READ_CODES
    | _EVIDENCE_CODES
    | frozenset(
        {
            "identity_unresolved",
            "content_unavailable",
            "content_verified",
            "content_excluded",
            "content_uncertain",
            "assessment_unavailable",
            "assessment_invalid",
        }
    )
)


@dataclass(frozen=True)
class CandidateContent:
    """One source checked before/after reading by the injected live reader."""

    file_id: str
    name: str
    mime_type: str
    source_version: str
    pieces: tuple[tuple[str, str], ...]
    content_fingerprint: str
    truncated: bool = False


class CandidateAssessmentError(ValueError):
    """Closed error codes only; private input never enters an exception."""


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    ).hexdigest()


def _metadata(candidate: Mapping[str, Any]) -> dict:
    metadata = candidate.get("metadata")
    if not isinstance(metadata, Mapping) or any(
        not isinstance(metadata.get(key), str) or not 1 <= len(metadata[key]) <= limit
        for key, limit in (("id", 256), ("name", 1024), ("mimeType", 256), ("sourceVersion", 256))
    ):
        raise CandidateAssessmentError("invalid_candidate_metadata")
    result = {key: metadata[key] for key in ("id", "name", "mimeType", "sourceVersion")}
    for key in ("createdTime", "modifiedTime", "sharedWithMeTime"):
        value = metadata.get(key)
        if isinstance(value, str) and 1 <= len(value) <= 80:
            result[key] = value

    def person(value):
        if not isinstance(value, Mapping):
            return {}
        return {
            key: value[key]
            for key, limit in (("displayName", 256), ("emailAddress", 254))
            if isinstance(value.get(key), str) and 1 <= len(value[key]) <= limit
        }

    owners = metadata.get("owners")
    if isinstance(owners, list) and len(owners) <= 20:
        result["owners"] = [person(owner) for owner in owners]
    for key in ("sharingUser", "lastModifyingUser"):
        if isinstance(metadata.get(key), Mapping):
            result[key] = person(metadata[key])
    return result


def _sources(candidate: Mapping[str, Any], content: CandidateContent) -> list[dict]:
    metadata = _metadata(candidate)
    if not isinstance(content, CandidateContent) or (
        content.file_id,
        content.name,
        content.mime_type,
        content.source_version,
    ) != (metadata["id"], metadata["name"], metadata["mimeType"], metadata["sourceVersion"]):
        raise CandidateAssessmentError("source_changed")
    if type(content.truncated) is not bool or content.truncated:
        raise CandidateAssessmentError("content_incomplete")
    if not isinstance(content.content_fingerprint, str) or not _HASH.fullmatch(
        content.content_fingerprint
    ):
        raise CandidateAssessmentError("invalid_content_evidence")
    if not content.pieces or len(content.pieces) > 48:
        raise CandidateAssessmentError("content_incomplete")
    sources, total = [], 0
    for number, piece in enumerate(content.pieces, 1):
        if (
            not isinstance(piece, tuple)
            or len(piece) != 2
            or any(not isinstance(x, str) for x in piece)
        ):
            raise CandidateAssessmentError("invalid_content_evidence")
        label, body = piece
        if not label or len(label) > 80 or not body.strip():
            raise CandidateAssessmentError("content_incomplete")
        encoded = body.encode("utf-8")
        total += len(encoded)
        if total > MAX_CONTENT_BYTES:
            raise CandidateAssessmentError("content_too_large")
        remainder = body
        part = 0
        while remainder:
            part += 1
            chunk = remainder[:MAX_SOURCE_BYTES]
            while len(chunk.encode("utf-8")) > MAX_SOURCE_BYTES:
                chunk = chunk[: len(chunk) // 2]
            remainder = remainder[len(chunk) :]
            sources.append(
                {
                    "document_ref": candidate["document_ref"],
                    "source_ref": f"{candidate['document_ref']}:content:{number}:{part}",
                    "source_version": content.source_version,
                    "text": chunk,
                    "name": content.name,
                    "location": label,
                    "evidence_kind": "content",
                    "truncated": False,
                }
            )
    if len(sources) > 48:
        raise CandidateAssessmentError("content_too_large")
    return sources


async def assess_request_candidates(
    *,
    user_id: str,
    request_id: str,
    request_revision: int,
    connection_generation: int,
    plan_digest: str,
    purpose: dict,
    candidates: Sequence[Mapping[str, Any]],
    read_candidate: Callable[[Mapping[str, Any]], Awaitable[CandidateContent]],
    require_current: Callable[[], Awaitable[None]],
    assessor=assess_request_document_batch,
    policy_version: str | None = None,
    read_timeout_seconds: float = 55,
    assessment_timeout_seconds: float = 30,
    total_timeout_seconds: float | None = None,
) -> list[dict]:
    """Account for every claimed candidate without running a tool or granting access.

    ``purpose`` carries original ``purpose`` text and the frozen ``semanticPlan``;
    those fields are never reconstructed from candidate text. File-activity dates
    remain host-owned. A body match needs at least one exact content citation.
    Authority callback failures propagate, so stale work cannot be committed.
    An optional monotonic deadline caps combined reading and assessment across
    this call; each assessment can use only the time left after its read.
    """
    started = monotonic()
    # A request starts at revision zero, before its first positive review
    # revision exists. Evidence must retain that exact request revision.
    if (
        not isinstance(user_id, str)
        or not user_id
        or not isinstance(request_id, str)
        or not request_id
        or type(request_revision) is not int
        or request_revision < 0
        or type(connection_generation) is not int
        or connection_generation < 1
        or not isinstance(plan_digest, str)
        or not _HASH.fullmatch(plan_digest)
        or not isinstance(purpose, dict)
        or not isinstance(purpose.get("purpose"), str)
        or not purpose["purpose"].strip()
        or len(purpose["purpose"]) > 4000
        or not 1 <= len(candidates) <= MAX_BATCH_DOCUMENTS
        or isinstance(read_timeout_seconds, bool)
        or not 0 < read_timeout_seconds <= 55
        or isinstance(assessment_timeout_seconds, bool)
        or not 0 < assessment_timeout_seconds <= 75
        or total_timeout_seconds is not None
        and (
            isinstance(total_timeout_seconds, bool)
            or not isinstance(total_timeout_seconds, (int, float))
            or not 0 < total_timeout_seconds <= 85
        )
    ):
        raise CandidateAssessmentError("invalid_assessment_request")
    deadline = started + total_timeout_seconds if total_timeout_seconds is not None else None

    def remaining_timeout(configured: float) -> float:
        return configured if deadline is None else max(0, min(configured, deadline - monotonic()))

    if policy_version is None:
        from hushh_mcp.services.drive_request_package_service import assessment_policy_version

        policy_version = assessment_policy_version()
    if not isinstance(policy_version, str) or not 1 <= len(policy_version) <= 128:
        raise CandidateAssessmentError("invalid_assessment_policy")
    refs, positions = set(), set()
    for candidate in candidates:
        ref, position = candidate.get("document_ref"), candidate.get("position")
        if (
            not isinstance(ref, str)
            or not 1 <= len(ref) <= 64
            or type(position) is not int
            or position < 1
            or ref in refs
            or position in positions
        ):
            raise CandidateAssessmentError("invalid_candidate_identity")
        _metadata(candidate)
        refs.add(ref)
        positions.add(position)
    try:
        plan = SemanticDrivePlan.model_validate(purpose.get("semanticPlan"))
        if plan.status != "ready" or semantic_plan_digest(plan) != plan_digest:
            raise ValueError
        if plan.date_basis == "content":
            first, last = (
                date.fromisoformat(purpose["periodStart"]),
                date.fromisoformat(purpose["periodEnd"]),
            )
            if first > last:
                raise ValueError
    except (ValueError, KeyError, TypeError):
        raise CandidateAssessmentError("invalid_semantic_plan_binding") from None
    request = {**purpose, "assessmentMode": ASSESSMENT_MODE, "dateBasis": plan.date_basis}
    # Validate size/serializability without ever logging private input.
    try:
        if (
            len(json.dumps(request, ensure_ascii=False, allow_nan=False).encode())
            > MAX_PROMPT_BYTES // 2
        ):
            raise ValueError
    except (ValueError, TypeError, RecursionError):
        raise CandidateAssessmentError("invalid_assessment_request") from None
    await require_current()
    observations = []
    for candidate in candidates:
        await require_current()
        metadata = _metadata(candidate)
        base = {
            "schema_version": ASSESSMENT_MODE,
            "owner_user_id": user_id,
            "request_id": request_id,
            "request_revision": request_revision,
            "connection_generation": connection_generation,
            "plan_digest": plan_digest,
            "assessment_policy_version": policy_version,
            "position": candidate["position"],
            "document_ref": candidate["document_ref"],
            "source": metadata,
        }
        if any(
            predicate.kind in {"owner", "shared_by"}
            for clause in plan.clauses
            for predicate in clause.predicates
        ):
            observations.append({**base, "decision": "unavailable", "code": "identity_unresolved"})
            continue
        try:
            read_timeout = remaining_timeout(read_timeout_seconds)
            if read_timeout <= 0:
                raise TimeoutError
            async with asyncio.timeout(read_timeout):
                content = await read_candidate(candidate)
            sources = _sources(candidate, content)
        except (CandidateAssessmentError, DriveReadError, TimeoutError) as error:
            code = (
                str(error)
                if isinstance(error, CandidateAssessmentError) and str(error) in _EVIDENCE_CODES
                else (
                    str(error)
                    if isinstance(error, DriveReadError) and str(error) in _READ_CODES
                    else "content_unavailable"
                )
            )
            observations.append({**base, "decision": "unavailable", "code": code})
            await require_current()
            continue
        except Exception:
            observations.append({**base, "decision": "unavailable", "code": "content_unavailable"})
            await require_current()
            continue
        await require_current()
        retrieved = {
            "untrusted_external_content": sources,
            "untrusted_candidate_metadata": [
                {"document_ref": candidate["document_ref"], **metadata}
            ],
            "truncated": False,
            "unreadable": [],
        }
        try:
            assessment_timeout = remaining_timeout(assessment_timeout_seconds)
            if assessment_timeout <= 0:
                raise TimeoutError
            async with asyncio.timeout(assessment_timeout):
                assessed = await assessor(
                    request=request,
                    retrieved=retrieved,
                    user_id=user_id,
                    require_current=require_current,
                )
            if isinstance(assessed, BoundDocumentBatchAssessment):
                if any(
                    item.source_version != content.source_version for item in assessed.documents
                ):
                    raise ValueError("assessment source changed")
                raw = {
                    "documents": [
                        item.model_dump(mode="json", exclude={"source_version"})
                        for item in assessed.documents
                    ]
                }
            else:
                raw = assessed
            # Even an injected assessor must satisfy the production identity and
            # exact-quotation validator; never trust a test-local typed stand-in.
            parsed = validate_request_document_batch(raw, request=request, retrieved=retrieved)
            item = parsed.documents[0]
            if item.source_version != content.source_version:
                raise ValueError("assessment source changed")
            outcome: Literal["verified_match", "excluded", "unavailable"] = (
                "verified_match"
                if item.decision == "include"
                else "excluded"
                if item.decision == "exclude"
                else "unavailable"
            )
            observation = {
                **base,
                "decision": outcome,
                "code": "content_verified"
                if outcome == "verified_match"
                else "content_excluded"
                if outcome == "excluded"
                else "content_uncertain",
                "content_fingerprint": content.content_fingerprint,
                "extraction_digest": _digest(sources),
                "assessment": item.model_dump(mode="json"),
                "truncated": False,
            }
            observation["evidence_digest"] = _digest(observation)
        except RequestAssessmentAuthorityError as error:
            raise error.__cause__ or error
        except TimeoutError:
            observation = {**base, "decision": "unavailable", "code": "assessment_unavailable"}
        except (ValueError, TypeError, KeyError, AttributeError):
            observation = {**base, "decision": "unavailable", "code": "assessment_invalid"}
        except Exception:
            observation = {**base, "decision": "unavailable", "code": "assessment_unavailable"}
        await require_current()
        if deadline is not None and monotonic() >= deadline:
            observation = {**base, "decision": "unavailable", "code": "assessment_unavailable"}
        observations.append(observation)
    await require_current()
    return observations


def verified_evidence_matches(
    evidence: Mapping[str, Any],
    *,
    user_id: str,
    request_id: str,
    request_revision: int,
    connection_generation: int,
    plan_digest: str,
    metadata: Mapping[str, Any],
    policy_version: str,
) -> bool:
    """Check an authenticated stored observation against the current dispatch binding.

    This must only receive evidence decrypted from the server's existing sealed
    request store. An ordinary hash cannot authenticate client-supplied evidence.
    The caller still enforces current consent, recipient, payment and provider ACLs.
    """
    try:
        if not isinstance(evidence, Mapping) or any(
            evidence.get(key) != value
            for key, value in {
                "schema_version": ASSESSMENT_MODE,
                "decision": "verified_match",
                "code": "content_verified",
                "owner_user_id": user_id,
                "request_id": request_id,
                "request_revision": request_revision,
                "connection_generation": connection_generation,
                "plan_digest": plan_digest,
                "assessment_policy_version": policy_version,
                "source": _metadata({"metadata": metadata}),
                "truncated": False,
            }.items()
        ):
            return False
        digest = evidence.get("evidence_digest")
        if not isinstance(digest, str) or not _HASH.fullmatch(digest):
            return False
        if any(
            not isinstance(evidence.get(key), str) or not _HASH.fullmatch(evidence[key])
            for key in ("content_fingerprint", "extraction_digest", "plan_digest")
        ):
            return False
        assessment = BoundDocumentAssessment.model_validate(evidence["assessment"])
        return bool(
            assessment.decision == "include"
            and assessment.document_ref == evidence["document_ref"]
            and assessment.source_version == metadata["sourceVersion"]
            and hmac.compare_digest(
                digest,
                _digest(
                    {key: value for key, value in evidence.items() if key != "evidence_digest"}
                ),
            )
        )
    except (ValueError, TypeError, KeyError):
        return False
