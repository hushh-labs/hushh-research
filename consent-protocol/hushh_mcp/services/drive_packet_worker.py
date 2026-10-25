"""Bounded durable original facts, packet construction and evidence checking.

All model calls happen outside transactions. A lease and current processing
authority are rechecked before/after each call. No share, listing or payment I/O.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import Counter, deque

from hushh_mcp.services.drive_document_facts_store import DriveDocumentFactsStore
from hushh_mcp.services.drive_document_targets import document_targets
from hushh_mcp.services.drive_packet_contract import PacketVerificationProposal, evidence_digest
from hushh_mcp.services.drive_packet_intelligence import (
    EvidenceValidationError,
    consolidate_facts,
    construct_packet,
    extract_page_facts,
    facts_policy_version,
    verify_packet,
)
from hushh_mcp.services.drive_packet_store import DrivePacketStore, safe_packet_failure_code
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.drive_worker_limits import facts_owner_leases, packet_slots
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.owner_placement_guard import (
    AccountLifecycleCheck,
    ModeResolver,
    admit_hub_content,
)

logger = logging.getLogger(__name__)

CHECKS = (
    "correct_subject_and_account",
    "correct_issuer_and_type",
    "correct_record_status",
    "correct_standalone_value",
    "correct_coverage",
    "no_unrelated_inclusions",
    "no_unexplained_omissions",
)


def _payload(value):
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else value


def _log_packet_failure(error, *, stage, attempt, started):
    if isinstance(error, EvidenceValidationError):
        code = error.code
    elif isinstance(error, DriveReadError):
        code = str(error)
    elif isinstance(error, ConnectorLifecycleError):
        code = "connector_storage_unavailable"
    elif isinstance(error, TimeoutError):
        code = (
            "model_timeout"
            if stage in {"construct_packet", "verify_members", "verify_packet"}
            else "packet_timeout"
        )
    elif isinstance(error, ValueError):
        code = (
            "evidence_budget_exceeded"
            if str(error) == "evidence_batch_budget_exceeded"
            else "packet_integrity_invalid"
        )
    else:
        code = "packet_unavailable"
    code = safe_packet_failure_code(code)
    logger.warning(
        "drive_packet_failed stage=%s code=%s attempt=%d elapsed_ms=%d",
        stage,
        code,
        attempt,
        round((time.monotonic() - started) * 1000),
    )
    return code


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
        # Date role is substantive evidence: losing it can turn an event window
        # into apparent reporting coverage in the final global checker.
        "date_evidence": [
            {key: item[key] for key in ("role", "start", "end", "meaning")}
            for item in facts.get("date_evidence", [])
        ],
        # Keep the qualification and its exact source context in the final
        # check; a typed signature must not become proof of execution.
        "record_status": facts.get("record_status"),
        # Preserve substantive differences for cross-batch duplicate review.
        # The caller rejects summaries over its budget instead of truncating.
        "topics": [item["value"] for item in facts["topics"]],
        "facts": [item["value"] for item in facts["facts"]],
        "ambiguous": facts["ambiguous"],
        "missing_information": facts["missing_information"],
        # A digest of the full facts lets the final checker tell one original
        # selected twice from two sparse extractions that compact alike.
        "facts_digest": evidence_digest(facts),
        # The provider's content digest refuses one original selected twice
        # even when its two extractions differ.
        **(
            {"content_digest": document["content_digest"]} if document.get("content_digest") else {}
        ),
        # Preserve host evidence metadata through bounded batching. File time
        # is withheld from the model and cannot establish reporting coverage
        # or duplicate-record meaning.
        **({"created_time": document["created_time"]} if document.get("created_time") else {}),
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
        placement_resolver: ModeResolver | None = None,
        assert_account_active: AccountLifecycleCheck | None = None,
    ):
        self.facts_store = facts_store or DriveDocumentFactsStore()
        self.packet_store = packet_store or DrivePacketStore(
            db=self.facts_store.db, cipher=self.facts_store.cipher
        )
        self.page_assessor, self.consolidator = page_assessor, consolidator
        self.constructor, self.checker, self.policy, self.wake = constructor, checker, policy, wake
        self._key_folds: dict[str, list] = {}
        self._placement_resolver = placement_resolver
        self._assert_account_active = assert_account_active

    def _policy_current(self, expected):
        if self.policy() != expected:
            raise DriveReadError("packet_policy_changed")

    async def _facts_current(self, job):
        await self.facts_store.require_current(job)
        await admit_hub_content(
            job["user_id"],
            "drive_packet_facts",
            resolve_mode=self._placement_resolver,
            assert_account_active=self._assert_account_active,
        )

    async def _packet_current(self, job):
        await self.packet_store.require_packet_current(job)
        await admit_hub_content(
            job["user_id"],
            "drive_packet_build",
            resolve_mode=self._placement_resolver,
            assert_account_active=self._assert_account_active,
        )

    @contextlib.asynccontextmanager
    async def _key_fold(self, user_id):
        """One canonical-key fold at a time per owner in this process.

        A final fold reads the owner's existing keys and commits its own in one
        critical section, so parallel facts jobs reuse each other's new keys
        instead of inventing spelling variants. Page facts stay parallel.
        """
        entry = self._key_folds.setdefault(user_id, [asyncio.Lock(), 0])
        entry[1] += 1
        try:
            async with entry[0]:
                yield
        finally:
            entry[1] -= 1
            if not entry[1]:
                self._key_folds.pop(user_id, None)

    async def run_facts_one(self, *, user_id, document_ids=None, enqueue=True):
        await admit_hub_content(
            user_id,
            "drive_packet_facts_claim",
            resolve_mode=self._placement_resolver,
            assert_account_active=self._assert_account_active,
        )
        targets = document_targets(document_ids)
        targeted = {"document_ids": targets} if targets is not None else {}
        policy = self.policy()
        if enqueue:
            await self.facts_store.enqueue(user_id=user_id, policy_version=policy, **targeted)
        job = await self.facts_store.claim(user_id=user_id, policy_version=policy, **targeted)
        if not job:
            return "idle"
        stage, started = "page_facts", time.monotonic()
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
                stage = "document_facts"
                async with self._key_fold(user_id) if complete else contextlib.nullcontext():
                    await self._facts_current(job)
                    canonical_context = (
                        await self.packet_store.canonical_key_context(
                            user_id=user_id, policy_version=policy
                        )
                        if complete
                        else None
                    )
                    await self._facts_current(job)
                    self._policy_current(policy)
                    folded = await self.consolidator(
                        user_id=user_id,
                        previous=job["previous"],
                        page_facts=[_payload(observed)],
                        complete=complete,
                        canonical_context=canonical_context,
                    )
                    await self._facts_current(job)
                    self._policy_current(policy)
                    stage = "persist_facts"
                    result = await self.facts_store.commit_batch(
                        job, page_facts=_payload(observed), document_facts=_payload(folded)
                    )
                await self.wake("documents")
                return "facts_complete" if result["complete"] else "facts_queued"
        except asyncio.CancelledError:
            await self.facts_store.release(job)
            raise
        except Exception as error:
            if isinstance(error, EvidenceValidationError):
                code = error.code
            elif isinstance(error, DriveReadError):
                code = str(error)
            elif isinstance(error, TimeoutError):
                code = "model_timeout"
            elif isinstance(error, ValueError):
                code = "facts_integrity_invalid"
            else:
                code = "facts_unavailable"
            logger.warning(
                "drive_document_facts_failed stage=%s code=%s attempt=%d elapsed_ms=%d",
                stage,
                code,
                job.get("attempts", 0) + 1,
                round((time.monotonic() - started) * 1000),
            )
            # A rejected model answer can differ on the next call, so it is
            # retried; the store bounds those retries. Host integrity and
            # input-budget errors are deterministic and stay terminal.
            await self.facts_store.release(
                job,
                code=code,
                retryable=isinstance(error, EvidenceValidationError)
                or not isinstance(error, ValueError),
            )
            return "facts_unavailable"

    async def _check(self, job, *, packet, documents, complete, scope, owner):
        await self._packet_current(job)
        self._policy_current(job["policy_version"])
        result = await self.checker(
            user_id=job["user_id"],
            packet=packet,
            documents=documents,
            complete=complete,
            batch_scope={**scope, "canonical_key": job["key"]},
            owner=owner,
        )
        await self._packet_current(job)
        self._policy_current(job["policy_version"])
        return _payload(result)

    async def run_packet_one(self, *, user_id):
        await admit_hub_content(
            user_id,
            "drive_packet_build_claim",
            resolve_mode=self._placement_resolver,
            assert_account_active=self._assert_account_active,
        )
        stage, started = "claim_packet", time.monotonic()
        try:
            job = await self.packet_store.claim_packet(
                user_id=user_id, policy_version=self.policy()
            )
        except Exception as error:
            _log_packet_failure(error, stage=stage, attempt=0, started=started)
            raise
        if not job:
            return "idle"
        try:
            async with asyncio.timeout(165):
                stage = "load_packet_build"
                build = dict(job["build"])
                if build and build.get("policy_version") != job["policy_version"]:
                    raise DriveReadError("packet_policy_changed")
                build["policy_version"] = job["policy_version"]
                # Read server-owned comparison context once per job. Unreadable
                # context retries; the authored builder/checker assess names.
                # Recheck placement and consent after the awaited read.
                stage = "load_owner_identity"
                owner = await self.packet_store.owner_identity(user_id=job["user_id"])
                await self._packet_current(job)
                if job["build_phase"] in {"construct", "verify"}:
                    stage = "load_member_evidence"
                    await self._packet_current(job)
                    page = await self.packet_store.evidence_page(
                        job, after_document_id=job["after_document_id"], limit=4
                    )
                    documents = page["documents"]
                    last = page["next_cursor"] is None
                    if job["build_phase"] == "construct":
                        stage = "check_packet_current"
                        await self._packet_current(job)
                        stage = "construct_packet"
                        answer = await self.constructor(
                            user_id=user_id,
                            key=job["key"],
                            documents=documents,
                            complete=bool(last and all(item["complete"] for item in documents)),
                            previous=build.get("assessment"),
                            owner=owner,
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
                        stage = "verify_members"
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
                            owner=owner,
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
                    stage = "persist_packet_build"
                    await self.packet_store.commit_build(
                        job,
                        build=build,
                        after_document_id=None if last else page["next_cursor"],
                        phase=phase,
                    )
                    stage = "wake_documents"
                    await self.wake("documents")
                    return "packet_queued"
                # A final checker sees every member's compact issuer/account/type/
                # period evidence. Passing narrow batches alone cannot establish readiness.
                stage = "load_final_evidence"
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
                stage = "verify_packet"
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
                    owner=owner,
                )
                if not build.get("batch_checks_passed") and checked["state"] == "ready":
                    checked["state"] = "incomplete"
                    checked["issues"] = (
                        checked["issues"]
                        + build.get("batch_issues", [])
                        + ["Member evidence checks remain unresolved."]
                    )[:64]
                stage = "persist_packet"
                result = await self.packet_store.finalize_packet(
                    job,
                    assessment=build["assessment"],
                    verification=PacketVerificationProposal.model_validate(checked).model_dump(),
                )
                return result["state"]
        except asyncio.CancelledError:
            await self.packet_store.release_packet(job)
            raise
        except Exception as error:
            code = _log_packet_failure(
                error, stage=stage, attempt=job.get("attempts", 0) + 1, started=started
            )
            await self.packet_store.release_packet(
                job,
                code=code,
                retryable=not isinstance(error, ValueError),
            )
            return "packet_unavailable"

    async def run(self, *, max_jobs=2, deadline_seconds=165):
        counts = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                # Least recently served first. Each of max_jobs slots runs one
                # job; a candidate with nothing due costs a claim, not the slot.
                owners = await self.facts_store.due_owners(limit=max_jobs)
                # Packet builds stay one per owner and use at most packet_slots()
                # slots. A packet slot that finds no build due runs facts.
                packets = deque(owners)
                # Facts go round-robin: every owner's first job before any
                # owner's second, up to the durable per-owner cap. The claim
                # keeps running jobs on distinct documents across instances.
                facts = deque(user_id for _ in range(facts_owner_leases()) for user_id in owners)
                drained, enqueued, locks = set(), set(), {}

                async def one(job, **kwargs):
                    try:
                        outcome = await job(**kwargs)
                    except Exception:  # noqa: BLE001 - one owner cannot cancel other durable lanes
                        outcome = "unavailable"
                    counts[outcome] += 1
                    return outcome

                async def slot(packet):
                    while packet and packets:
                        if await one(self.run_packet_one, user_id=packets.popleft()) != "idle":
                            return
                    while facts:
                        user_id = facts.popleft()
                        if user_id in drained:
                            continue
                        # One enqueue per owner per sweep; the parallel jobs only claim.
                        async with locks.setdefault(user_id, asyncio.Lock()):
                            if user_id not in enqueued:
                                enqueued.add(user_id)
                                try:
                                    await admit_hub_content(
                                        user_id,
                                        "drive_packet_facts_enqueue",
                                        resolve_mode=self._placement_resolver,
                                        assert_account_active=self._assert_account_active,
                                    )
                                    await self.facts_store.enqueue(
                                        user_id=user_id, policy_version=self.policy()
                                    )
                                except Exception:  # noqa: BLE001 - reported like a failed facts job
                                    drained.add(user_id)
                                    counts["unavailable"] += 1
                                    return
                        if user_id in drained:
                            continue
                        outcome = await one(self.run_facts_one, user_id=user_id, enqueue=False)
                        if outcome in {"idle", "unavailable"}:
                            # Nothing claimable now, or the store failed: skip
                            # this owner's remaining candidates in this sweep.
                            drained.add(user_id)
                        if outcome != "idle":
                            return

                builds = min(packet_slots(), max_jobs // 2)
                async with asyncio.TaskGroup() as group:
                    for index in range(max_jobs):
                        group.create_task(slot(index < builds))
        except TimeoutError:
            counts["deadline"] += 1
        return dict(counts)
