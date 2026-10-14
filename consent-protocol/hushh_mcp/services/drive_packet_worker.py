"""Bounded durable original facts, packet construction and evidence checking.

All model calls happen outside transactions. A lease and current processing
authority are rechecked before/after each call. No share, listing or payment I/O.
"""

from __future__ import annotations

import asyncio
import json
from collections import Counter

from hushh_mcp.services.drive_document_facts_store import DriveDocumentFactsStore
from hushh_mcp.services.drive_packet_contract import PacketVerification
from hushh_mcp.services.drive_packet_intelligence import (
    consolidate_facts,
    construct_packet,
    extract_page_facts,
    facts_policy_version,
    verify_packet,
)
from hushh_mcp.services.drive_packet_store import DrivePacketStore
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.owner_placement_guard import admit_hub_content

CHECKS = (
    "correct_subject_and_account",
    "correct_issuer_and_type",
    "correct_coverage",
    "no_unrelated_inclusions",
    "no_unexplained_omissions",
)


def _payload(value):
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else value


def compact_evidence(document):
    facts = document["facts"]
    return {
        "document_id": document["document_id"],
        "source_version": document["source_version"],
        "complete": document["complete"],
        **{
            key: facts[key]["value"] if facts.get(key) else None
            for key in ("document_type", "issuer", "subject", "account")
        },
        "periods": [{"start": item["start"], "end": item["end"]} for item in facts["periods"]],
        "ambiguous": facts["ambiguous"],
        "missing_information": facts["missing_information"],
    }


class DrivePacketWorker:
    def __init__(
        self,
        *,
        facts_store=None,
        packet_store=None,
        page_assessor=extract_page_facts,
        consolidator=consolidate_facts,
        constructor=construct_packet,
        checker=verify_packet,
        policy=facts_policy_version,
        wake=wake_drive_work,
    ):
        self.facts_store = facts_store or DriveDocumentFactsStore()
        self.packet_store = packet_store or DrivePacketStore(
            db=self.facts_store.db, cipher=self.facts_store.cipher
        )
        self.page_assessor, self.consolidator = page_assessor, consolidator
        self.constructor, self.checker, self.policy, self.wake = constructor, checker, policy, wake

    def _policy_current(self, expected):
        if self.policy() != expected:
            raise DriveReadError("packet_policy_changed")

    async def _facts_current(self, job):
        await self.facts_store.require_current(job)
        await admit_hub_content(job["user_id"], "drive_packet_facts")

    async def _packet_current(self, job):
        await self.packet_store.require_packet_current(job)
        await admit_hub_content(job["user_id"], "drive_packet_build")

    async def run_facts_one(self, *, user_id):
        await admit_hub_content(user_id, "drive_packet_facts_claim")
        policy = self.policy()
        await self.facts_store.enqueue(user_id=user_id, policy_version=policy)
        job = await self.facts_store.claim(user_id=user_id, policy_version=policy)
        if not job:
            return "idle"
        try:
            async with asyncio.timeout(165):
                pages, size = [], 0
                for page in job["pages"]:
                    item = {
                        "page": page["page_number"],
                        "text": page["text"],
                        "unit_kind": job["unit_kind"],
                        "status": page["status"],
                        "quality": page["quality"],
                        "error_code": page["error_code"],
                    }
                    length = len(json.dumps(item, ensure_ascii=False).encode())
                    if pages and size + length > 96 * 1024:
                        break
                    pages.append(item)
                    size += length
                if not pages:
                    raise DriveReadError("facts_unavailable")
                complete = pages[-1]["page"] == job["total_pages"]
                await self._facts_current(job)
                observed = await self.page_assessor(user_id=user_id, pages=pages)
                await self._facts_current(job)
                self._policy_current(policy)
                folded = await self.consolidator(
                    user_id=user_id,
                    previous=job["previous"],
                    page_facts=[_payload(observed)],
                    complete=complete,
                )
                await self._facts_current(job)
                self._policy_current(policy)
                result = await self.facts_store.commit_batch(
                    job, page_facts=_payload(observed), document_facts=_payload(folded)
                )
                await self.wake("documents")
                return "facts_complete" if result["complete"] else "facts_queued"
        except asyncio.CancelledError:
            await self.facts_store.release(job)
            raise
        except Exception as error:
            code = str(error) if isinstance(error, DriveReadError) else "facts_unavailable"
            await self.facts_store.release(
                job, code=code, retryable=not isinstance(error, ValueError)
            )
            return "facts_unavailable"

    async def _check(self, job, *, packet, documents, complete, scope):
        await self._packet_current(job)
        self._policy_current(job["policy_version"])
        result = await self.checker(
            user_id=job["user_id"],
            packet=packet,
            documents=documents,
            complete=complete,
            batch_scope=scope,
        )
        await self._packet_current(job)
        self._policy_current(job["policy_version"])
        return _payload(result)

    async def run_packet_one(self, *, user_id):
        await admit_hub_content(user_id, "drive_packet_build_claim")
        job = await self.packet_store.claim_packet(user_id=user_id, policy_version=self.policy())
        if not job:
            return "idle"
        try:
            async with asyncio.timeout(165):
                build = dict(job["build"])
                if build and build.get("policy_version") != job["policy_version"]:
                    raise DriveReadError("packet_policy_changed")
                build["policy_version"] = job["policy_version"]
                if job["build_phase"] in {"construct", "verify"}:
                    await self._packet_current(job)
                    page = await self.packet_store.evidence_page(
                        job, after_document_id=job["after_document_id"], limit=4
                    )
                    documents = page["documents"]
                    last = page["next_cursor"] is None
                    if job["build_phase"] == "construct":
                        await self._packet_current(job)
                        answer = await self.constructor(
                            user_id=user_id,
                            key=job["key"],
                            documents=documents,
                            complete=bool(last and all(item["complete"] for item in documents)),
                            previous=build.get("assessment"),
                        )
                        self._policy_current(job["policy_version"])
                        build["assessment"] = _payload(answer)
                        build["constructed_count"] = build.get("constructed_count", 0) + len(
                            documents
                        )
                        phase = "verify" if last else "construct"
                        if last:
                            build.update(checked_count=0, batch_checks_passed=True, batch_issues=[])
                    else:
                        checked = await self._check(
                            job,
                            packet=build["assessment"],
                            documents=documents,
                            complete=bool(all(item["complete"] for item in documents)),
                            scope={
                                "mode": "member_batch",
                                "member_count": job["member_count"],
                                "batch_document_ids": [item["document_id"] for item in documents],
                                "previously_checked": build.get("checked_count", 0),
                            },
                        )
                        build["checked_count"] = build.get("checked_count", 0) + len(documents)
                        build["batch_checks_passed"] = (
                            build.get("batch_checks_passed", True)
                            and checked["state"] == "ready"
                            and all(checked[key] for key in CHECKS)
                        )
                        build["batch_issues"] = (build.get("batch_issues", []) + checked["issues"])[
                            :64
                        ]
                        phase = "finalize" if last else "verify"
                    await self.packet_store.commit_build(
                        job,
                        build=build,
                        after_document_id=None if last else page["next_cursor"],
                        phase=phase,
                    )
                    await self.wake("documents")
                    return "packet_queued"
                # A final checker sees every member's compact issuer/account/type/
                # period evidence. Passing narrow batches alone cannot establish readiness.
                documents, cursor = [], None
                while True:
                    page = await self.packet_store.evidence_page(
                        job, after_document_id=cursor, limit=25
                    )
                    documents.extend(compact_evidence(item) for item in page["documents"])
                    if len(json.dumps(documents, ensure_ascii=False).encode()) > 110 * 1024:
                        raise DriveReadError("evidence_budget_exceeded")
                    cursor = page["next_cursor"]
                    if cursor is None:
                        break
                complete = bool(
                    build.get("batch_checks_passed")
                    and len(documents) == job["member_count"]
                    and all(item["complete"] for item in documents)
                )
                checked = await self._check(
                    job,
                    packet=build["assessment"],
                    documents=documents,
                    complete=complete,
                    scope={
                        "mode": "complete_compact_summary",
                        "member_count": job["member_count"],
                        "batch_checks_passed": build.get("batch_checks_passed", False),
                        "batch_issues": build.get("batch_issues", []),
                    },
                )
                if not build.get("batch_checks_passed") and checked["state"] == "ready":
                    checked["state"] = "incomplete"
                    checked["issues"] = (
                        checked["issues"]
                        + build.get("batch_issues", [])
                        + ["Member evidence checks remain unresolved."]
                    )[:64]
                result = await self.packet_store.finalize_packet(
                    job,
                    assessment=build["assessment"],
                    verification=PacketVerification.model_validate(checked).model_dump(),
                )
                return result["state"]
        except asyncio.CancelledError:
            await self.packet_store.release_packet(job)
            raise
        except Exception as error:
            await self.packet_store.release_packet(
                job,
                code=str(error) if isinstance(error, DriveReadError) else "packet_unavailable",
                retryable=not isinstance(error, ValueError),
            )
            return "packet_unavailable"

    async def run(self, *, max_jobs=2, deadline_seconds=165):
        counts = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                owners = await self.facts_store.due_owners(limit=max(1, (max_jobs + 1) // 2))

                async def one(user_id, packet):
                    try:
                        outcome = await (
                            self.run_packet_one(user_id=user_id)
                            if packet
                            else self.run_facts_one(user_id=user_id)
                        )
                        counts[outcome] += 1
                    except Exception:  # noqa: BLE001 - one owner cannot cancel other durable lanes
                        counts["unavailable"] += 1

                async with asyncio.TaskGroup() as group:
                    dispatched = 0
                    for user_id in owners:
                        for packet in (False, True):
                            if dispatched >= max_jobs:
                                break
                            group.create_task(one(user_id, packet))
                            dispatched += 1
        except TimeoutError:
            counts["deadline"] += 1
        return dict(counts)
