"""Resumable private content evaluation; neither approval nor provider mutation.

Each lease reads at most six candidates. Provider text lives only in memory;
only encrypted cited observations reach the store. Final assembly gets its own
lease so a slow model never silently consumes the next worker's authority.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections import Counter
from pathlib import Path

from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from hushh_mcp.services.drive_live_reader import UNREADABLE, DriveLiveReader
from hushh_mcp.services.drive_request_package_assessment import (
    MAX_PACKAGE_DOCUMENTS,
    BoundDocumentAssessment,
    PackageAssessment,
    assess_document_batch,
    assess_package,
)
from hushh_mcp.services.drive_request_package_store import DriveRequestPackageStore
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError

MAX_DOCUMENT_BYTES = 20 * 1024
BATCH_SECONDS = 110  # durable lease is 120 seconds
READ_SECONDS = 20


def assessment_policy_version():
    manifest = Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml"
    configured_model = resolve_fleet_model_name("gemini-default")
    digest = hashlib.sha256(manifest.read_bytes() + b"\0" + configured_model.encode()).hexdigest()
    return "package-v1:" + digest


def _excerpt(text):
    raw = text.encode("utf-8")
    return raw[:MAX_DOCUMENT_BYTES].decode("utf-8", errors="ignore"), len(raw) > MAX_DOCUMENT_BYTES


def indexed_evidence_source(*, document_ref, document):
    """Adapt complete, request-independent cited facts without cutting content.

    This pure boundary is shared with original-byte evaluation. Facts remain
    untrusted observations; the existing semantic assessor decides relevance.
    The caller must validate current source/permission versions before use.
    """
    from hushh_mcp.services.drive_packet_contract import DocumentFacts

    facts = DocumentFacts.model_validate(document["facts"])
    records = [
        facts.document_type,
        facts.issuer,
        facts.subject,
        facts.account,
        *facts.periods,
        *facts.topics,
        *facts.facts,
    ]
    quotations = [
        f"{citation.unit_kind} {citation.page}:\n{citation.quote}"
        for record in records
        if record is not None
        for citation in record.citations
    ]
    body = json.dumps(facts.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)
    body += "\nExact document quotations:\n" + "\n".join(dict.fromkeys(quotations))
    if len(body.encode()) > 128 * 1024:
        raise DriveReadError("evidence_budget_exceeded")
    metadata = document["metadata"]
    return {
        "document_ref": document_ref,
        "source_ref": document_ref + ":facts",
        "source_version": document["source_version"],
        "text": body,
        "name": metadata["name"],
        "truncated": document.get("complete") is not True,
        "evidence_kind": "versioned_document_facts",
        "facts_version": document["facts_version"],
    }


class DriveRequestPackageService:
    def __init__(
        self,
        *,
        store=None,
        reader_factory=None,
        document_assessor=assess_document_batch,
        package_assessor=assess_package,
        wake=None,
        facts=None,
        packets=None,
    ):
        self.store = store or DriveRequestPackageStore()
        self.reader_factory = reader_factory or DriveLiveReader
        self.document_assessor = document_assessor
        self.package_assessor = package_assessor
        self.wake = wake or wake_drive_work
        self.facts = facts
        self.packets = packets

    def _facts_store(self):
        if self.facts is None:
            from hushh_mcp.services.drive_document_facts_store import DriveDocumentFactsStore

            self.facts = DriveDocumentFactsStore(db=self.store.db)
        return self.facts

    async def _reusable_manifest(self, job):
        binding = job.get("checkpoint", {}).get("reusable_packet") or job.get("checkpoint", {}).get(
            "matched_packet"
        )
        if binding is None:
            return None
        if self.packets is None:
            from hushh_mcp.services.drive_packet_store import DrivePacketStore

            self.packets = DrivePacketStore(db=self.store.db)
        from hushh_mcp.services.drive_owner_search_store import validate_reusable_packet

        manifest = await self.packets.current_packet_manifest(
            owner_user_id=job["user_id"], packet_id=binding["packetId"], version=binding["version"]
        )
        return validate_reusable_packet(manifest, binding, job["user_id"])

    async def _read_batch(self, job):
        async def current():
            await self.store.require_evaluation_current(job)

        semaphore = asyncio.Semaphore(3)
        policy_version = assessment_policy_version()
        reusable = await self._reusable_manifest(job)

        async def read(candidate):
            async with semaphore:
                await current()
                result = {
                    "position": candidate["position"],
                    "assessment_policy_version": policy_version,
                    "assessment": None,
                    "source_version": None,
                    "content_fingerprint": None,
                    "truncated": False,
                    "unreadable_reason": None,
                }
                metadata = candidate["metadata"]
                if metadata.get("shareable") is not True:
                    return result | {"unreadable_reason": "source_unavailable"}, None
                indexed = metadata.get("indexedEvidence")
                if indexed is not None:
                    document = await self._facts_store().current_document(
                        owner_user_id=job["user_id"], **indexed
                    )
                    source = indexed_evidence_source(
                        document_ref=candidate["document_ref"], document=document
                    )
                    await current()
                    result.update(
                        source_version=source["source_version"],
                        content_fingerprint=hashlib.sha256(source["text"].encode()).hexdigest(),
                        truncated=source["truncated"],
                        indexed_evidence=indexed,
                    )
                    if reusable is not None:
                        if not document["complete"] or indexed["document_id"] not in {
                            item["document_id"] for item in reusable["sources"]
                        }:
                            raise DriveReadError("source_changed")
                        facts = document["facts"]
                        records = [
                            facts.get("document_type"),
                            facts.get("issuer"),
                            facts.get("subject"),
                            facts.get("account"),
                            *facts.get("periods", []),
                            *facts.get("topics", []),
                            *facts.get("facts", []),
                        ]
                        quotes = [
                            citation["quote"]
                            for record in records
                            if record
                            for citation in record.get("citations", [])
                        ]
                        if not quotes:
                            raise DriveReadError("package_incomplete")
                        result["assessment"] = BoundDocumentAssessment(
                            document_ref=candidate["document_ref"],
                            source_version=source["source_version"],
                            decision="include",
                            confidence=reusable["assessment"]["assessment_score"],
                            reason="Included in the exact verified packet matched to this request.",
                            citations=[
                                {"source_ref": source["source_ref"], "quote": quotes[0][:500]}
                            ],
                            covered_periods=[],
                        ).model_dump(mode="json")
                        return result, None
                    return result, source
                reader = self.reader_factory(user_id=job["user_id"], require_access=current)
                try:
                    async with asyncio.timeout(READ_SECONDS):
                        source, body, truncated = await reader.read_compilation_match(
                            match={
                                "file_id": metadata["id"],
                                "name": metadata["name"],
                                "mime_type": metadata["mimeType"],
                            }
                        )
                    await current()
                    if not body.strip():
                        return result | {"unreadable_reason": "no_extractable_text"}, None
                    text, cut = _excerpt(body)
                    version = str(source.version)
                    result.update(
                        source_version=version,
                        content_fingerprint=hashlib.sha256(body.encode("utf-8")).hexdigest(),
                        truncated=bool(truncated or cut),
                    )
                    return result, {
                        "document_ref": candidate["document_ref"],
                        "source_ref": candidate["document_ref"] + ":content",
                        "source_version": version,
                        "text": text,
                        "name": metadata["name"],
                        "truncated": result["truncated"],
                    }
                except DriveReadError as error:
                    if str(error) not in UNREADABLE:
                        raise
                    return result | {"unreadable_reason": str(error)}, None

        reads = [asyncio.create_task(read(candidate)) for candidate in job["candidates"]]
        try:
            pairs = await asyncio.gather(*reads)
        except BaseException:
            # gather alone leaves sibling provider reads alive after one fails.
            # Drain cancellation before releasing this batch's authority lease.
            for task in reads:
                task.cancel()
            await asyncio.gather(*reads, return_exceptions=True)
            raise
        observations = [pair[0] for pair in pairs]
        content = [pair[1] for pair in pairs if pair[1] is not None]
        if content:
            await current()
            assessed = await self.document_assessor(
                request=job["purpose"],
                user_id=job["user_id"],
                retrieved={
                    "untrusted_external_content": content,
                    "truncated": any(item["truncated"] for item in observations),
                    "unreadable": [
                        {
                            "document_ref": f"p{item['position']}",
                            "reason": item["unreadable_reason"],
                        }
                        for item in observations
                        if item["unreadable_reason"]
                    ],
                },
            )
            by_ref = {
                item.document_ref: item.model_dump(mode="json") for item in assessed.documents
            }
            for item in observations:
                if item["unreadable_reason"] is None and item["assessment"] is None:
                    item["assessment"] = by_ref[f"p{item['position']}"]
        await current()
        await self.store.commit_evaluations(job, observations=observations)

    async def _assemble(self, job):
        assessments, unreadable = [], []
        policy_version = assessment_policy_version()
        after, truncated, excluded = 0, False, 0
        counts = {}
        while True:
            page = await self.store.package_evidence_page(job, after_position=after)
            counts = page["counts"]
            for item in page["items"]:
                if item.get("assessment_policy_version") != policy_version:
                    raise DriveReadError("assessment_policy_changed")
                truncated = truncated or item["truncated"]
                if item["unreadable_reason"]:
                    # Counts summarize every failure without growing the prompt
                    # with thousands of repeated operational errors.
                    unreadable.append(item["unreadable_reason"])
                elif item["assessment"]["decision"] == "exclude":
                    excluded += 1
                else:
                    assessments.append(BoundDocumentAssessment.model_validate(item["assessment"]))
                    if len(assessments) > MAX_PACKAGE_DOCUMENTS:
                        raise DriveReadError("package_budget_exceeded")
            after = page["next_position"]
            if after is None:
                break
        if counts.get("candidates") != counts.get("evaluated"):
            raise DriveReadError("package_incomplete")
        await self.store.require_evaluation_current(job)
        reusable = await self._reusable_manifest(job)
        if reusable is not None:
            if (
                unreadable
                or truncated
                or len(assessments) != len(reusable["sources"])
                or any(item.decision != "include" for item in assessments)
            ):
                raise DriveReadError("package_incomplete")
            canonical = reusable["assessment"]
            answer = PackageAssessment(
                decision="ready",
                coverage_status="complete",
                selected_document_refs=[item.document_ref for item in assessments],
                confidence=canonical["assessment_score"],
                importance=canonical["importance"],
                suggested_price_cents=reusable["price_cents"],
                rationale=canonical["pricing"]["rationale"],
                coverage_summary=canonical["coverage_summary"],
                gaps=[],
            )
        else:
            answer = await self.package_assessor(
                request=job["purpose"],
                user_id=job["user_id"],
                assessments=assessments,
                truncated=truncated,
                unreadable=[
                    {"reason": reason, "count": count}
                    for reason, count in Counter(unreadable).items()
                ],
                retrieval_counts={
                    **counts,
                    "excluded": excluded,
                    "unreadable": len(unreadable),
                    **(
                        {
                            "retrieval_source": job["checkpoint"]["evidence_route"],
                            "retrieval_complete": job["checkpoint"]["evidence_route"] == "index",
                        }
                        if job.get("checkpoint", {}).get("evidence_route")
                        else {}
                    ),
                },
            )
            # A provider fallback cannot prove complete collection recall. Keep
            # useful partial selections visible, but never label them ready.
            if (
                job.get("checkpoint", {}).get("coverage_manifest", {}).get("fallbackReason")
                and answer.decision == "ready"
            ):
                answer = answer.model_copy(
                    update={
                        "decision": "partial",
                        "coverage_status": "partial",
                        "gaps": [
                            "The collection index is incomplete; additional relevant documents may exist."
                        ],
                    }
                )
        await self.store.require_evaluation_current(job)
        return await self.store.finalize_package(
            job, assessment=answer.model_dump(mode="json"), policy_version=policy_version
        )

    async def run_one(self, *, user_id, job_id):
        try:
            job = await self.store.claim_evaluation(user_id=user_id, job_id=job_id)
        except DriveReadError:
            # Admission can change after due_evaluations. No lease was granted;
            # this request must not cancel unrelated or legacy preparations.
            return "unavailable"
        if job is None:
            return "not_claimed"
        try:
            async with asyncio.timeout(BATCH_SECONDS):
                if job["candidates"]:
                    await self._read_batch(job)
                    await self.store.release_evaluation(job)
                    await self.wake("suggestions")
                    return "queued"
                result = await self._assemble(job)
                return result["status"]
        except asyncio.CancelledError:
            await self.store.release_evaluation(job, retryable=True, error="provider_unavailable")
            raise
        except Exception as error:
            code = str(error) if isinstance(error, DriveReadError) else "preparation_unavailable"
            retryable = (
                isinstance(error, TimeoutError)
                or (isinstance(error, DriveReadError) and error.retryable)
                or code
                in {
                    "provider_unavailable",
                    "preparation_unavailable",
                    "rate_limited",
                }
            )
            await self.store.release_evaluation(job, retryable=retryable, error=code)
            return "unavailable"

    async def run(self, *, max_jobs=1, deadline_seconds=120):
        counts = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                for job in await self.store.due_evaluations(limit=max_jobs):
                    result = await self.run_one(user_id=job["user_id"], job_id=str(job["job_id"]))
                    counts[result] += 1
        except TimeoutError:
            counts["deadline"] += 1
        return dict(counts)
