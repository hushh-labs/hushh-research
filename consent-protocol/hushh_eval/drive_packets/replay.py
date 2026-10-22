"""Replay: run the production Drive packet code at the checked-out SHA, in memory.

The owner path runs ``DrivePacketWorker.run_facts_one`` and ``run_packet_one``
unchanged against in-memory stores, so page batching, canonical-key context,
construct and verify batches, the final compact check and the Ready state rule are
the production ones. Only persistence is replaced. Every model call goes through
the existing ``interpret=`` injection point, wrapped with a concurrency cap, a
hard cost cap and a 429 pause. Inputs are pages and file metadata; labels never
reach a prompt. Nothing is written anywhere except the private workdir.
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import json
import logging
import re
import subprocess
import threading
import time
import uuid
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from hushh_eval.drive_packets.contracts import ObservationRow, PacketRow, canonical_json
from hushh_eval.drive_packets.usage import (
    Budget,
    BudgetExhausted,
    RateGuard,
    estimate_tokens,
    is_rate_limited,
    load_pricing,
    usage_row,
)

ROOT = Path(__file__).resolve().parents[2]
MAX_FACT_ATTEMPTS = 2
MAX_PACKET_ATTEMPTS = 2
OWNER = "eval-replay-owner"


class RuntimeCodes(logging.Handler):
    """Count the runtime's own validation and failure codes (codes only, no text)."""

    PATTERN = re.compile(r"^(drive_\w+) (?:mode|stage)=(\w+) code=(\w+) attempt=(\d+)")
    LOGGERS = (
        "hushh_mcp.services.drive_packet_intelligence",
        "hushh_mcp.services.drive_packet_worker",
    )

    def __init__(self):
        super().__init__(level=logging.INFO)
        self.counts: Counter = Counter()

    def emit(self, record):
        match = self.PATTERN.match(record.getMessage())
        if match:
            self.counts[":".join(match.groups())] += 1

    def __enter__(self):
        for name in self.LOGGERS:
            logging.getLogger(name).addHandler(self)
        return self

    def __exit__(self, *_exc):
        for name in self.LOGGERS:
            logging.getLogger(name).removeHandler(self)


class MixedRuntimeError(RuntimeError):
    """Observations from a different runtime cannot be resumed into one batch."""


def runtime_provenance(*, model: str) -> dict:
    from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE
    from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

    def git(*args):
        return subprocess.run(  # noqa: S603 - fixed git arguments, local repository only
            ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
        ).stdout.strip()

    manifest = ROOT / "hushh_mcp/agents/documents/agent.yaml"
    contract = ROOT / "hushh_mcp/services/drive_packet_contract.py"
    return {
        "code_sha": git("rev-parse", "HEAD") or "unknown",
        "code_dirty": bool(git("status", "--porcelain", "--", "hushh_mcp")),
        "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
        "contract_sha256": hashlib.sha256(contract.read_bytes()).hexdigest(),
        "runtime_model": model,
        "facts_policy_version": facts_policy_version(),
        "extraction_profile": EXTRACTION_PROFILE,
    }


@dataclass
class ReplayCase:
    case_id: str
    document_uuid: str
    pages: list[dict]
    unit_kind: str
    total_pages: int
    has_gaps: bool
    source_version: str
    extraction_source: str
    metadata: dict = field(default_factory=dict)


class MeteredInterpret:
    """Concurrency cap, budget, 429 guard and estimated usage around ``interpret``."""

    def __init__(self, interpret, *, model: str, budget: Budget, concurrency: int = 8, guard=None):
        if not 1 <= concurrency <= 8:
            raise ValueError("vertex_concurrency_must_be_1_to_8")
        self.interpret, self.model, self.budget = interpret, model, budget
        self.semaphore = asyncio.Semaphore(concurrency)
        self.guard = guard or RateGuard()
        self.pricing = load_pricing()
        self.usage: list[dict] = []
        self.exhausted = False

    async def __call__(self, *, prompt, user_id, output_schema):
        if self.exhausted:
            raise BudgetExhausted("budget_exhausted")
        async with self.semaphore:
            await self.guard.maybe_pause()
            prompt_tokens = estimate_tokens(len(prompt.encode()))
            expected = usage_row(
                model=self.model,
                input_tokens=prompt_tokens,
                output_tokens=prompt_tokens // 4 + 1024,
                estimated=True,
                pricing=self.pricing,
            )["cost_usd"]
            try:
                self.budget.reserve(expected)
            except BudgetExhausted:
                self.exhausted = True
                raise
            started = time.monotonic()
            try:
                answer = await self.interpret(
                    prompt=prompt, user_id=user_id, output_schema=output_schema
                )
            except Exception as error:
                self.guard.record(rate_limited=is_rate_limited(error))
                raise
            self.guard.record(rate_limited=False)
            output_tokens = 2 * estimate_tokens(len(json.dumps(answer, default=str).encode()))
            row = usage_row(
                model=self.model,
                input_tokens=prompt_tokens,
                output_tokens=output_tokens,
                estimated=True,
                pricing=self.pricing,
            )
            row["latency_ms"] = round((time.monotonic() - started) * 1000)
            self.budget.record(row)
            self.usage.append(row)
            return answer


class InMemoryPacketStore:
    """The DrivePacketStore methods DrivePacketWorker uses, without persistence."""

    def __init__(self, *, facts_store: InMemoryFactsStore | None = None, owner=None):
        self.heads: dict[str, dict] = {}
        self.facts_store = facts_store
        # The owner's name on file for the runtime's wrong-person fence, as
        # {"names": [...]}, held in memory only. A replay without one is not
        # checked by that fence; the other Ready gates still run. run-batch
        # supplies it from --owner-name or the owner's identity on file.
        self.owner = owner
        self._clock = 0

    def update_membership(self, document_id: str, folded) -> None:
        keys = {item.key: item.model_dump() for item in folded.canonical_packets}
        for key, value in keys.items():
            head = self.heads.setdefault(
                key,
                {
                    "packet_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"dpe-packet:{key}")),
                    "key": value,
                    "members": set(),
                    "build": {},
                    "build_phase": "construct",
                    "after_document_id": None,
                    "leased": False,
                    "attempts": 0,
                    "status": "dirty",
                    "final": None,
                    "error_code": None,
                },
            )
            head["members"].add(document_id)
            self._clock += 1
            head["updated"] = self._clock
            if head["status"] == "final":
                head.update(
                    status="dirty", build={}, build_phase="construct", after_document_id=None
                )
        for key, head in self.heads.items():
            if key not in keys:
                head["members"].discard(document_id)

    async def canonical_key_context(self, *, user_id, policy_version):
        del user_id, policy_version
        heads = sorted(self.heads.values(), key=lambda head: -head.get("updated", 0))
        context = {
            "packets": [],
            "truncated": len(heads) > 64,
            "representative_only": True,
            "collection_complete": False,
        }
        for head in heads[:64]:
            document = self.facts_store.latest_member(head["members"]) if self.facts_store else None
            if document is None:
                continue
            facts = document["facts"]
            representative = {
                key: facts[key]["value"] if facts.get(key) else None
                for key in ("document_type", "issuer", "subject", "account")
            }
            representative.update(
                periods=[{"start": p["start"], "end": p["end"]} for p in facts["periods"]],
                date_evidence=[
                    {key: item[key] for key in ("role", "start", "end", "meaning")}
                    for item in facts.get("date_evidence", [])
                ],
                record_status={
                    key: value
                    for key, value in (facts.get("record_status") or {}).items()
                    if key != "citations"
                },
                topics=[item["value"] for item in facts["topics"]],
                facts=[item["value"] for item in facts["facts"]],
                missing_information=facts["missing_information"],
                ambiguous=facts["ambiguous"],
                has_gaps=document["has_gaps"],
            )
            context["packets"].append({**head["key"], "representative_document": representative})
            if len(json.dumps(context, ensure_ascii=False).encode()) > 48 * 1024:
                context["packets"].pop()
                context["truncated"] = True
                break
        return context

    async def claim_packet(self, *, user_id, policy_version):
        for key in sorted(self.heads, key=lambda item: self.heads[item]["packet_id"]):
            head = self.heads[key]
            if head["status"] == "dirty" and not head["leased"] and head["members"]:
                head["leased"] = True
                return {
                    "packet_id": head["packet_id"],
                    "key": key,
                    "user_id": user_id,
                    "policy_version": policy_version,
                    "build": dict(head["build"]),
                    "build_phase": head["build_phase"],
                    "after_document_id": head["after_document_id"],
                    "member_count": len(head["members"]),
                    "attempts": head["attempts"],
                }
        return None

    async def evidence_page(self, job, *, after_document_id=None, limit=6):
        head = self.heads[job["key"]]
        members = sorted(head["members"])
        if after_document_id:
            members = [item for item in members if item > str(after_document_id)]
        documents = [
            self.facts_store.member_evidence(item, job["policy_version"])
            for item in members[: limit + 1]
        ]
        kept = documents[:limit]
        return {
            "documents": kept,
            "next_cursor": kept[-1]["document_id"] if len(documents) > limit else None,
        }

    async def require_packet_current(self, job):
        return None

    async def owner_identity(self, *, user_id):
        return self.owner

    async def commit_build(self, job, *, build, after_document_id, phase):
        head = self.heads[job["key"]]
        head.update(build=build, after_document_id=after_document_id, build_phase=phase)
        head.update(leased=False, attempts=0)

    async def finalize_packet(self, job, *, assessment, verification):
        from hushh_mcp.services.drive_packet_contract import (
            PacketProposal,
            PacketVerificationProposal,
        )
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        head = self.heads[job["key"]]
        packet = PacketProposal.model_validate(assessment)
        checked = PacketVerificationProposal.model_validate(verification)
        build = head["build"]
        if head["build_phase"] != "finalize" or (
            build.get("checked_count") != job["member_count"]
            or build.get("constructed_count") != job["member_count"]
        ):
            raise DriveReadError("packet_incomplete")
        if set(head["members"]) != set(packet.selected_document_ids) | {
            item.document_id for item in packet.excluded_documents
        }:
            raise DriveReadError("packet_incomplete")
        ready = (
            packet.state == checked.state == "ready" and build.get("batch_checks_passed") is True
        )
        state = (
            "ready"
            if ready
            else "incomplete"
            if packet.state != "unable_to_verify" and checked.state != "unable_to_verify"
            else "unable_to_verify"
        )
        head.update(
            status="final",
            leased=False,
            final={
                "state": state,
                "assessment": packet.model_dump(mode="json"),
                "verification": checked.model_dump(mode="json"),
                "batch_checks_passed": build.get("batch_checks_passed"),
            },
        )
        return {"state": state}

    async def release_packet(self, job, *, code="packet_unavailable", retryable=True):
        head = self.heads[job["key"]]
        head["attempts"] += 1
        head.update(leased=False, error_code=code)
        if not retryable or head["attempts"] >= MAX_PACKET_ATTEMPTS:
            head["status"] = "failed"


class InMemoryFactsStore:
    """The DriveDocumentFactsStore methods DrivePacketWorker uses, without persistence."""

    def __init__(self, cases: list[ReplayCase], *, policy: str, profile: str, owner=None):
        self.policy, self.profile = policy, profile
        self.documents = {
            case.document_uuid: {
                "case": case,
                "after_page": 0,
                "facts": None,
                "status": "pending",
                "leased": False,
                "attempts": 0,
                "error_code": None,
                "facts_version": str(
                    uuid.uuid5(uuid.NAMESPACE_URL, f"dpe-facts:{case.document_uuid}")
                ),
                "has_gaps": case.has_gaps,
                "completed_order": None,
            }
            for case in cases
        }
        self.packets = InMemoryPacketStore(facts_store=self, owner=owner)
        self._order = 0

    async def enqueue(self, *, user_id, policy_version, document_ids=None):
        return None

    async def claim(self, *, user_id, policy_version, document_ids=None):
        for document_id in document_ids or sorted(self.documents):
            document = self.documents[document_id]
            if document["status"] != "pending" or document["leased"]:
                continue
            case = document["case"]
            if not case.pages:
                document.update(status="failed", error_code="no_extracted_pages")
                return None
            document["leased"] = True
            after = document["after_page"]
            return {
                "document_id": document_id,
                "user_id": user_id,
                "after_page": after,
                "facts_version": document["facts_version"],
                "pages": [page for page in case.pages if page["page_number"] > after][:4],
                "unit_kind": case.unit_kind,
                "total_pages": case.total_pages,
                "has_gaps": case.has_gaps,
                "previous": document["facts"],
                "attempts": document["attempts"],
            }
        return None

    async def require_current(self, job):
        return None

    async def commit_batch(self, job, *, page_facts, document_facts):
        from hushh_mcp.services.drive_packet_contract import (
            DocumentFacts,
            DocumentPageFacts,
            validate_page_citations,
        )
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        observed = DocumentPageFacts.model_validate(page_facts)
        folded = DocumentFacts.model_validate(document_facts)
        numbers = observed.pages
        if numbers != list(range(job["after_page"] + 1, job["after_page"] + 1 + len(numbers))):
            raise DriveReadError("unaccounted_facts_pages")
        pages = {
            page["page_number"]: page["text"]
            for page in job["pages"]
            if page["page_number"] in numbers
        }
        validate_page_citations(observed, pages, dict.fromkeys(pages, job["unit_kind"]))
        complete = numbers[-1] == job["total_pages"]
        if not complete and folded.canonical_packets:
            raise DriveReadError("incomplete_document_facts")
        document = self.documents[job["document_id"]]
        document.update(
            after_page=numbers[-1],
            facts=folded.model_dump(mode="json"),
            status="complete" if complete else "pending",
            leased=False,
            attempts=0,
            error_code=None,
        )
        if complete:
            self._order += 1
            document["completed_order"] = self._order
            self.packets.update_membership(job["document_id"], folded)
        return {
            "complete": complete,
            "after_page": numbers[-1],
            "facts_version": document["facts_version"],
        }

    async def release(self, job, *, retryable=True, code="facts_unavailable"):
        document = self.documents[job["document_id"]]
        document["attempts"] += 1
        document.update(leased=False, error_code=code)
        if not retryable or document["attempts"] >= MAX_FACT_ATTEMPTS:
            document["status"] = "failed"

    def latest_member(self, members):
        complete = [
            self.documents[item] for item in members if self.documents[item]["status"] == "complete"
        ]
        if not complete:
            return None
        return max(complete, key=lambda item: item["completed_order"] or 0)

    def member_evidence(self, document_id, policy_version):
        document = self.documents[document_id]
        created = document["case"].metadata.get("createdTime")
        return {
            "document_id": document_id,
            "source_version": document["case"].source_version,
            "facts_version": document["facts_version"],
            "facts_profile": policy_version,
            "extraction_profile": self.profile,
            "extraction_version": "replay",
            "complete": not document["has_gaps"],
            "facts": document["facts"],
            # As DrivePacketStore supplies it: the Ready gates read the file's
            # creation time for undated duplicates; the model is never shown it.
            **({"created_time": created} if created else {}),
        }


async def _noop_wake(*_args, **_kwargs):
    return None


@dataclass
class ReplayResult:
    observations: list[ObservationRow]
    packets: list[PacketRow]
    documents: dict[str, dict]
    usage: list[dict]
    budget_exhausted: bool
    heads: list[dict] = field(default_factory=list)
    runtime_codes: dict = field(default_factory=dict)


class ReplayRunner:
    def __init__(self, *, interpret, model: str, budget: Budget, concurrency: int = 8, guard=None):
        self.metered = MeteredInterpret(
            interpret, model=model, budget=budget, concurrency=concurrency, guard=guard
        )
        self.concurrency = concurrency
        self.model = model

    def _worker(self, facts_store, policy):
        from hushh_mcp.services.drive_packet_intelligence import (
            consolidate_facts,
            construct_packet,
            extract_page_facts,
            verify_packet,
        )
        from hushh_mcp.services.drive_packet_worker import DrivePacketWorker

        metered = self.metered
        return DrivePacketWorker(
            facts_store=facts_store,
            packet_store=facts_store.packets,
            page_assessor=functools.partial(extract_page_facts, interpret=metered),
            consolidator=functools.partial(consolidate_facts, interpret=metered),
            constructor=functools.partial(construct_packet, interpret=metered),
            checker=functools.partial(verify_packet, interpret=metered),
            policy=lambda: policy,
            wake=_noop_wake,
        )

    async def run_owner_path(
        self, *, batch_id: str, cases: list[ReplayCase], runtime: dict, owner: dict | None = None
    ) -> ReplayResult:
        from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE

        policy = runtime["facts_policy_version"]
        facts_store = InMemoryFactsStore(
            cases, policy=policy, profile=EXTRACTION_PROFILE, owner=owner
        )
        worker = self._worker(facts_store, policy)
        lanes = asyncio.Semaphore(self.concurrency)
        timings: dict[str, int] = {}

        async def facts_for(case: ReplayCase):
            async with lanes:
                started = time.monotonic()
                document = facts_store.documents[case.document_uuid]
                while document["status"] == "pending" and not self.metered.exhausted:
                    await worker.run_facts_one(user_id=OWNER, document_ids=[case.document_uuid])
                timings[case.case_id] = round((time.monotonic() - started) * 1000)

        codes = RuntimeCodes()
        with codes:
            await self._phases(worker, facts_store, cases, facts_for)

        observations = []
        for case in cases:
            document = facts_store.documents[case.document_uuid]
            status = (
                "completed"
                if document["status"] == "complete"
                else "budget_exhausted"
                if self.metered.exhausted and document["status"] == "pending"
                else "error"
            )
            observations.append(
                ObservationRow(
                    batch_id=batch_id,
                    case_id=case.case_id,
                    mode="replay",
                    stage="facts",
                    status=status,
                    error_code=document["error_code"] if status == "error" else None,
                    output={
                        "facts": document["facts"],
                        "canonical_keys": [
                            item["key"]
                            for item in (document["facts"] or {}).get("canonical_packets", [])
                        ],
                        "extraction_source": case.extraction_source,
                        "has_gaps": case.has_gaps,
                    },
                    runtime=runtime,
                    latency_ms=timings.get(case.case_id),
                )
            )
        case_by_uuid = {case.document_uuid: case.case_id for case in cases}
        statuses = {
            uuid_: ((document["facts"] or {}).get("record_status") or {}).get("status")
            for uuid_, document in facts_store.documents.items()
        }
        packets = [
            packet_row(batch_id, key, head, case_by_uuid, mode="replay", statuses=statuses)
            for key, head in sorted(facts_store.packets.heads.items())
            if head["members"]
        ]
        return ReplayResult(
            observations=observations,
            packets=packets,
            documents=facts_store.documents,
            usage=self.metered.usage,
            budget_exhausted=self.metered.exhausted,
            heads=list(facts_store.packets.heads.values()),
            runtime_codes=dict(codes.counts),
        )

    async def _phases(self, worker, facts_store, cases, facts_for):
        await asyncio.gather(*(facts_for(case) for case in cases))
        heads = facts_store.packets.heads

        async def packet_lane():
            while not self.metered.exhausted and any(
                head["status"] == "dirty" and head["members"] for head in heads.values()
            ):
                if await worker.run_packet_one(user_id=OWNER) == "idle":
                    await asyncio.sleep(0.02)

        await asyncio.gather(*(packet_lane() for _ in range(self.concurrency)))


def packet_row(
    batch_id: str,
    key: str,
    head: dict,
    case_by_uuid: dict,
    *,
    mode: str,
    statuses: dict | None = None,
) -> PacketRow:
    final = head.get("final") or {}
    assessment = final.get("assessment") or {}
    pricing = assessment.get("pricing") or {}
    to_case = lambda value: case_by_uuid.get(value, value)  # noqa: E731
    state = final.get("state") or "failed"
    return PacketRow(
        batch_id=batch_id,
        packet_key=hashlib.sha256(f"{mode}\0{key}".encode()).hexdigest()[:32],
        mode=mode,
        state=state,
        member_case_ids=sorted(to_case(item) for item in head["members"]),
        selected_case_ids=sorted(
            to_case(item) for item in assessment.get("selected_document_ids", [])
        ),
        excluded=[
            {**item, "document_id": to_case(item["document_id"])}
            for item in assessment.get("excluded_documents", [])
        ],
        periods=[[item["start"], item["end"]] for item in assessment.get("periods", [])],
        temporal_scope=assessment.get("temporal_scope"),
        gaps_count=len(assessment.get("gaps", [])),
        pricing={key: pricing.get(key) for key in ("useful_scope", "coverage", "quality")},
        price_cents=pricing.get("suggested_price_cents"),
        assessment_score=assessment.get("assessment_score"),
        importance=assessment.get("importance"),
        standalone_value=assessment.get("standalone_value"),
        visible={
            "key": key,
            "assessment": assessment,
        },
        record_statuses=[
            (statuses or {}).get(item) for item in assessment.get("selected_document_ids", [])
        ],
        verification=final.get("verification"),
        digest=hashlib.sha256(canonical_json(final).encode()).hexdigest() if final else "",
        error_code=head.get("error_code") if state == "failed" else None,
    )


def check_resumable(existing: list[ObservationRow], runtime: dict) -> set[str]:
    """Return completed case ids; refuse to mix runtime SHAs or policies in one batch."""
    for row in existing:
        if (
            row.mode == "replay"
            and row.runtime
            and (
                row.runtime.get("code_sha") != runtime.get("code_sha")
                or row.runtime.get("facts_policy_version") != runtime.get("facts_policy_version")
            )
        ):
            raise MixedRuntimeError("mixed_runtime_sha")
    return {row.case_id for row in existing if row.stage == "facts" and row.status == "completed"}


class FakeInterpret:
    """Deterministic CI model. It records every prompt for leak tests and returns
    minimal, valid answers derived only from what the prompt contains."""

    def __init__(self):
        self.prompts: list[str] = []

    async def __call__(self, *, prompt, user_id, output_schema):
        del user_id, output_schema
        self.prompts.append(prompt)
        request = json.loads(prompt)
        mode = request.get("package_mode")
        if mode == "page_facts":
            return self._page_facts(request)
        if mode == "document_facts":
            return self._document_facts(request)
        if mode == "canonical_packet":
            return self._packet(request)
        if mode == "packet_verification":
            return self._verdict(request)
        if mode == "packet_request_match":
            return {"decision": "no_match", "packet_id": None, "version": None, "reason": "fixture"}
        raise ValueError("fake_interpret_unknown_mode")

    @staticmethod
    def _status():
        return {
            "status": "unknown",
            "evidence_basis": "unknown",
            "explanation": "Not assessed by the fixture model.",
            "citation_refs": [],
        }

    def _page_facts(self, request):
        pages = request["untrusted_pages"]
        spans = [span for page in pages for span in page["text_spans"] if span["text"].strip()]
        facts = (
            [
                {
                    "value": spans[0]["text"].strip()[:200] or "page",
                    "citation_refs": [spans[0]["ref"]],
                }
            ]
            if spans
            else []
        )
        return {
            "pages": [page["page"] for page in pages],
            "document_type": None,
            "issuer": None,
            "subject": None,
            "account": None,
            "record_status": self._status(),
            "periods": [],
            "date_evidence": [],
            "topics": [],
            "facts": facts,
            "missing_information": [],
            "ambiguous": False,
        }

    def _document_facts(self, request):
        refs = [item["ref"] for item in request["citation_evidence"]]
        first = next(iter(request["citation_evidence"]), None)
        heading = (first or {}).get("quote", "").strip().splitlines()[:1]
        word = re.sub(r"[^a-z0-9]+", "-", (heading[0] if heading else "document").casefold()).strip(
            "-"
        )
        keys = (
            [
                {
                    "key": f"fixture:{word[:40] or 'document'}",
                    "title": "Fixture group",
                    "description": "Fixture group.",
                }
            ]
            if request["all_pages_observed"] and refs
            else []
        )
        return {
            "document_type": None,
            "issuer": None,
            "subject": None,
            "account": None,
            "record_status": self._status(),
            "periods": [],
            "date_evidence": [],
            "topics": [],
            "facts": [{"value": "fixture fact", "citation_refs": refs[:1]}] if refs else [],
            "missing_information": [],
            "ambiguous": False,
            "canonical_packets": keys,
        }

    def _packet(self, request):
        ids = [item["document_id"] for item in request["documents"]]
        previous = request.get("previous_packet") or {}
        ids = sorted(set(ids) | set(previous.get("selected_document_ids", [])))
        complete = request["all_members_observed"]
        return {
            "title": "Fixture packet",
            "description": "Fixture packet built from synthetic originals.",
            "state": "ready" if complete else "incomplete",
            "selected_document_ids": ids,
            "excluded_documents": [],
            "coverage_summary": "Fixture documents only.",
            "periods": [],
            "temporal_scope": "no_period_claim",
            "gaps": [],
            "assessment_score": 80,
            "importance": 10,
            "pricing": {
                "rubric_version": "drive-packet-price-v1",
                "useful_scope": "collection",
                "coverage": "complete",
                "quality": "verified",
                "rationale": "Fixture estimate.",
                "suggested_price_cents": 500,
            },
            "standalone_value": "supported",
            "utility_rationale": "Fixture documents are complete records.",
        }

    def _verdict(self, request):
        ready = request["all_evidence_current_and_complete"]
        return {
            "state": "ready" if ready else "incomplete",
            "correct_subject_and_account": True,
            "correct_issuer_and_type": True,
            "correct_coverage": True,
            "correct_record_status": True,
            "correct_standalone_value": True,
            "no_unrelated_inclusions": True,
            "no_unexplained_omissions": True,
            "issues": [] if ready else ["Fixture evidence incomplete."],
        }


# PDFium (pypdfium2) is not thread-safe: concurrent extraction crashed the
# process (SIGTRAP) on the first live batch. Downloads still overlap; page
# extraction runs one batch at a time.
_EXTRACTION_LOCK = threading.Lock()


def _extract_batch(content: bytes, mime_type: str, start_page: int):
    from hushh_mcp.services.drive_document_pages import extract_pages

    with _EXTRACTION_LOCK:
        return extract_pages(content, mime_type, start_page=start_page, page_limit=4)


async def extract_local(content: bytes, mime_type: str) -> dict:
    """Production extract_pages on original bytes, batch by batch (no persistence)."""
    from dataclasses import asdict

    from hushh_mcp.services.drive_document_pages import engine_versions

    pages, cursor, has_gaps, batch = [], 1, False, None
    while cursor is not None:
        batch = await asyncio.to_thread(_extract_batch, content, mime_type, cursor)
        pages.extend(asdict(page) for page in batch.pages)
        has_gaps = has_gaps or batch.has_gaps
        if batch.next_page is not None and (batch.next_page <= cursor or len(pages) >= 1000):
            raise ValueError("extraction_did_not_finish_within_budget")
        cursor = batch.next_page
    return {
        "pages": pages,
        "complete": bool(batch and batch.complete),
        "has_gaps": has_gaps,
        "unit_kind": batch.unit_kind if batch else "page",
        "total_pages": batch.total_pages if batch else 0,
        "profile": batch.profile if batch else None,
        "engines": engine_versions(),
    }
