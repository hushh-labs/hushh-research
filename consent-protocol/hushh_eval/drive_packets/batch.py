"""Batch orchestration behind the CLI: plan, run, judge, label, score, report, gate.

All state lives in ``<workdir>/batches/<batch_id>/`` (private, 0700/0600).
Every command re-validates the preregistered plan hash before it reads results.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from hushh_eval.drive_packets import metrics
from hushh_eval.drive_packets.contracts import (
    CaseRow,
    FrameRow,
    JudgmentRow,
    LabelRow,
    ObservationRow,
    PacketRow,
    PlanRow,
    read_rows,
    replace_rows,
)
from hushh_eval.drive_packets.deterministic import load_rubric
from hushh_eval.drive_packets.judge import (
    reliability,
    require_independent,
)
from hushh_eval.drive_packets.labels import (
    LABEL_VERSION,
    resolved,
)
from hushh_eval.drive_packets.privacy import (
    PrivateWorkdir,
    assert_public_text,
    private_strings,
)
from hushh_eval.drive_packets.sampling import (
    ledger_keys,
    ledger_lines,
    plan_batch,
    verify_plan,
)
from hushh_eval.drive_packets.stats import zero_failure_sample_size
from hushh_eval.drive_packets.strata import STRATA_VERSION

REQUEST_SET_VERSION = "requests.v1"
FACT_FIELDS = ("document_type", "issuer", "account", "subject", "record_status")
MAX_ORIGINAL_BYTES = 32 * 1024 * 1024


@dataclass
class Batch:
    workdir: PrivateWorkdir
    batch_id: str

    @property
    def path(self) -> Path:
        return self.workdir.directory("batches", self.batch_id)

    def file(self, name: str) -> Path:
        return self.path / name

    def plan(self) -> PlanRow:
        path = self.file("plan.json")
        if not path.exists():
            raise FileNotFoundError("plan_missing")
        return verify_plan(PlanRow.model_validate_json(path.read_text()))

    def private_json(self, name: str, default=None):
        path = self.file(name)
        return json.loads(path.read_text()) if path.exists() else default


def case_id_for(file_key: str) -> str:
    return "c" + file_key[:12]


def document_uuid(file_key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"dpe-document:{file_key}"))


# --- plan -----------------------------------------------------------------------------
def write_plan(batch: Batch, plan: PlanRow) -> dict:
    path = batch.file("plan.json")
    if path.exists():
        existing = PlanRow.model_validate_json(path.read_text())
        if existing.plan_sha256 != plan.plan_sha256:
            raise ValueError("plan_exists_with_different_hash")
        return {"plan_sha256": plan.plan_sha256, "created": False}
    batch.workdir.write_bytes(path, plan.model_dump_json(indent=2).encode())
    ledger = batch.workdir.path / "ledger.txt"
    with ledger.open("a") as handle:
        handle.write("".join(line + "\n" for line in ledger_lines(plan)))
    ledger.chmod(0o600)
    return {"plan_sha256": plan.plan_sha256, "created": True}


def frame_dir(workdir: PrivateWorkdir, frame_id: str) -> Path:
    return workdir.directory("frames", frame_id)


def save_frame(
    workdir: PrivateWorkdir, frame_id: str, rows: list[FrameRow], crosswalk: dict
) -> None:
    directory = frame_dir(workdir, frame_id)
    replace_rows(directory / "frame.jsonl", rows)
    workdir.write_json(directory / "crosswalk.json", crosswalk)


def load_frame(workdir: PrivateWorkdir, frame_id: str) -> tuple[list[FrameRow], dict]:
    directory = frame_dir(workdir, frame_id)
    rows = read_rows(directory / "frame.jsonl", FrameRow)
    crosswalk_path = directory / "crosswalk.json"
    crosswalk = json.loads(crosswalk_path.read_text()) if crosswalk_path.exists() else {}
    if not rows:
        raise FileNotFoundError("frame_missing")
    return rows, crosswalk


def make_plan(
    batch: Batch,
    frame: list[FrameRow],
    *,
    seed: int,
    n_clusters: int,
    n_loose: int,
    per_cluster: int,
    folder_cap: float,
    anchor_keys: list[str],
    runtime: dict,
    judge: dict,
    budget_usd: float,
    source: dict,
    eligible_keys: set[str] | None = None,
) -> PlanRow:
    from hushh_eval.drive_packets.sampling import default_eligible

    def eligible(row: FrameRow) -> bool:
        return default_eligible(row) and (eligible_keys is None or row.file_key in eligible_keys)

    plan = plan_batch(
        frame,
        batch_id=batch.batch_id,
        seed=seed,
        n_clusters=n_clusters,
        n_loose=n_loose,
        per_cluster=per_cluster,
        folder_cap=folder_cap,
        prior_keys=ledger_keys(batch.workdir.path / "ledger.txt") - set(_planned_keys(batch)),
        anchor_keys=anchor_keys,
        request_set_version=REQUEST_SET_VERSION,
        label_version=LABEL_VERSION,
        judge=judge,
        runtime=runtime,
        budget_usd=budget_usd,
        eligible=eligible,
    )
    plan.design["source"] = source
    plan.design["eligibility"] = "all_files" if eligible_keys is None else "supported_formats"
    from hushh_eval.drive_packets.sampling import plan_sha256

    return plan.model_copy(update={"plan_sha256": plan_sha256(plan)})


def _planned_keys(batch: Batch) -> list[str]:
    path = batch.file("plan.json")
    if not path.exists():
        return []
    return [item.file_key for item in PlanRow.model_validate_json(path.read_text()).sample]


# --- run ------------------------------------------------------------------------------
def build_cases(batch: Batch, plan: PlanRow, frame: dict[str, FrameRow]) -> list[CaseRow]:
    from hushh_eval.drive_packets.strata import stratum

    cases = []
    for item in plan.sample:
        row = frame.get(item.file_key)
        cases.append(
            CaseRow(
                batch_id=batch.batch_id,
                case_id=case_id_for(item.file_key),
                file_key=item.file_key,
                document_uuid=document_uuid(item.file_key),
                partition="pending",
                family_key=None,
                content_sha256=None,
                source_revision=None,
                stratum=stratum(row) if row else "unknown",
                design_stratum=item.design_stratum,
                cluster_key=item.cluster_key,
                design_weight=item.design_weight,
                anchor=item.stage == "anchor",
                burned=item.stage == "anchor",
            )
        )
    return cases


async def materialize(batch: Batch, cases: list[CaseRow], source, *, kind: str, crosswalk: dict):
    """Fetch pages for each case (served extraction first, else original bytes)."""
    from hushh_eval.drive_packets.replay import ReplayCase, extract_local
    from hushh_eval.drive_packets.sources import native_text_only

    originals = batch.workdir.directory("batches", batch.batch_id, "originals")
    replay_cases, observations, details = [], [], {}
    drive = source.drive() if kind == "uat" else None
    try:

        async def one(case):
            started = datetime.now(UTC)
            record = {"status": "completed", "error_code": None}
            content, mime, metadata, pages_info = None, None, {}, None
            try:
                if kind == "fixture":
                    mime, content, metadata = source.original(case.file_key)
                    pages_info = await extract_local(content, mime)
                    pages_info["source"] = "local"
                    source_version = source.source_version(case.file_key)
                else:
                    from hushh_mcp.services.google_drive_adapter import (
                        LIVE_EXPORTS,
                        SUPPORTED_TYPES,
                    )

                    entry = crosswalk[case.file_key]
                    system = entry.get("system") or {}
                    metadata = {
                        "modifiedTime": entry.get("modified_time"),
                        "createdTime": entry.get("created_time"),
                        "mime_type": entry.get("mime_type"),
                    }
                    source_version = entry.get("source_version") or "0"
                    mime = entry.get("mime_type")
                    if system.get("extraction_current") and system.get("active_version"):
                        pages = await asyncio.to_thread(source.served_pages, system)
                        if pages:
                            pages_info = {
                                "pages": pages,
                                "complete": True,
                                "has_gaps": bool(system.get("extraction_has_gaps")),
                                "unit_kind": system.get("unit_kind") or "page",
                                "total_pages": system.get("total_pages") or len(pages),
                                "source": "served",
                            }
                    supported = mime in SUPPORTED_TYPES or mime in LIVE_EXPORTS
                    if supported and (entry.get("size") or 0) <= MAX_ORIGINAL_BYTES:
                        try:
                            mime_out, content = await drive.original(
                                entry["file_id"], mime, max_bytes=MAX_ORIGINAL_BYTES
                            )
                        except Exception as error:  # noqa: BLE001 - served pages may still exist
                            record = {"status": "error", "error_code": f"original_{error}"[:60]}
                        if content is not None and pages_info is None:
                            pages_info = await extract_local(content, mime_out)
                            pages_info["source"] = "local"
                            record = {"status": "completed", "error_code": None}
                    if pages_info is None and record["status"] == "completed":
                        record = {
                            "status": "skipped",
                            "error_code": "unsupported_format"
                            if not supported
                            else "file_too_large",
                        }
                    elif pages_info is not None:
                        record = {"status": "completed", "error_code": None}
            except Exception as error:  # noqa: BLE001 - recorded as a failed attempt, never dropped
                record = {
                    "status": "error",
                    "error_code": f"materialize_{type(error).__name__}"[:60],
                }
            if content is not None:
                batch.workdir.write_bytes(originals / case.case_id, content)
                case.content_sha256 = hashlib.sha256(content).hexdigest()
            case.source_revision = source_version if pages_info else None
            details[case.case_id] = {
                "mime_type": mime,
                "metadata": metadata,
                "pages": {
                    str(page["page_number"]): page["text"]
                    for page in (pages_info or {}).get("pages", [])
                },
                "extraction": {
                    key: (pages_info or {}).get(key)
                    for key in ("complete", "has_gaps", "unit_kind", "total_pages", "source")
                },
            }
            observations.append(
                ObservationRow(
                    batch_id=batch.batch_id,
                    case_id=case.case_id,
                    mode="replay",
                    stage="extraction",
                    status=record["status"]
                    if pages_info or record["status"] != "completed"
                    else "error",
                    error_code=record["error_code"] or (None if pages_info else "no_pages"),
                    output=details[case.case_id]["extraction"]
                    | {"pages": len((pages_info or {}).get("pages", []))},
                    latency_ms=round((datetime.now(UTC) - started).total_seconds() * 1000),
                )
            )
            if pages_info and pages_info.get("pages"):
                replay_cases.append(
                    ReplayCase(
                        case_id=case.case_id,
                        document_uuid=case.document_uuid,
                        pages=pages_info["pages"],
                        unit_kind=pages_info["unit_kind"],
                        total_pages=pages_info["total_pages"],
                        has_gaps=pages_info["has_gaps"],
                        source_version=str(source_version),
                        extraction_source=pages_info["source"],
                        metadata=metadata,
                    )
                )

        # Drive GETs and served-page reads overlap (Drive concurrency 4; the
        # single read-only DB connection serializes queries). Fixture runs stay
        # sequential so the no-OCR switch is never toggled mid-extraction.
        lanes = asyncio.Semaphore(4 if kind == "uat" else 1)

        async def bounded(case):
            async with lanes:
                await one(case)

        if kind == "fixture":
            with native_text_only():
                await asyncio.gather(*(bounded(case) for case in cases))
        else:
            await asyncio.gather(*(bounded(case) for case in cases))
        order = {case.case_id: index for index, case in enumerate(cases)}
        replay_cases.sort(key=lambda item: order[item.case_id])
        observations.sort(key=lambda item: order[item.case_id])
    finally:
        if drive is not None:
            await drive.aclose()
    return replay_cases, observations, details


def packet_members(
    packet: PacketRow, details: dict, cases: dict[str, CaseRow], facts: dict
) -> list[dict]:
    members = []
    for case_id in packet.member_case_ids:
        case = cases.get(case_id)
        detail = details.get(case_id, {})
        members.append(
            {
                "document_id": case.document_uuid if case else case_id,
                "case_id": case_id,
                "content_sha256": case.content_sha256 if case else None,
                "facts": facts.get(case_id),
                "pages": {int(k): v for k, v in detail.get("pages", {}).items()} or None,
                "metadata": detail.get("metadata") or {},
                "complete": not (detail.get("extraction") or {}).get("has_gaps", False),
            }
        )
    return members


# --- score ----------------------------------------------------------------------------
def scorecard(batch: Batch) -> dict:
    plan = batch.plan()
    cases = {row.case_id: row for row in read_rows(batch.file("cases.jsonl"), CaseRow)}
    observations = read_rows(batch.file("observations.jsonl"), ObservationRow)
    packets = read_rows(batch.file("packets.jsonl"), PacketRow)
    judgments = read_rows(batch.file("judgments.jsonl"), JudgmentRow)
    label_rows = read_rows(batch.file("labels.jsonl"), LabelRow)
    labels = resolved(label_rows)
    details = batch.private_json("details.json", {})
    sampled = [case for case in cases.values() if not case.anchor]
    by_stage = defaultdict(dict)
    for row in observations:
        by_stage[row.stage][row.case_id] = row

    def label(case_id, field):
        row = labels.get((case_id, field))
        # A labeler's "unknown" is an abstention, not a gold value.
        return None if row is None or row.value in ("unknown", "") else row.value

    extraction_rows, fact_rows, period_rows = [], [], []
    env_limited = 0
    for case in sampled:
        extraction = by_stage["extraction"].get(case.case_id)
        facts_row = by_stage["facts"].get(case.case_id)
        detail = details.get(case.case_id, {})
        extracted = (extraction.output if extraction else {}) or {}
        # Local extraction has no OCR engine: its gaps describe the eval
        # machine, not the product, so those files are not scored here.
        limited = extracted.get("source") == "local" and bool(extracted.get("has_gaps"))
        env_limited += limited
        extraction_rows.append(
            {
                "status": extraction.status if extraction else "missing",
                "true_pages": None if limited else label(case.case_id, "page_count"),
                "extracted_pages": extracted.get("total_pages"),
                "claimed_complete": bool(extracted.get("complete"))
                and not extracted.get("has_gaps"),
                "key_found": 0,
                "key_total": 0,
            }
        )
        facts = (facts_row.output.get("facts") if facts_row else None) or {}
        status = facts_row.status if facts_row else "missing"
        for field in FACT_FIELDS:
            value = facts.get(field)
            predicted = (
                (value.get("status") if field == "record_status" else value.get("value"))
                if isinstance(value, dict)
                else None
            )
            if field == "record_status" and predicted == "unknown":
                predicted = None
            fact_rows.append(
                {
                    "field": field,
                    "gold": label(case.case_id, field),
                    "predicted": predicted,
                    "status": status,
                }
            )
        gold_periods = label(case.case_id, "periods")
        period_rows.append(
            {
                "gold": gold_periods,
                "predicted": [[p["start"], p["end"]] for p in facts.get("periods", [])],
                "status": status,
                "metadata": detail.get("metadata") or {},
            }
        )

    consensus = {
        row.packet_key: row for row in judgments if row.judge_id in {"consensus", "deterministic"}
    }
    human = {row.packet_key: row for row in judgments if row.judge_id == "human"}
    packet_rows = []
    replay_packets = [
        packet
        for packet in packets
        if packet.mode == "replay" and not packet.packet_key.startswith("anchor")
    ]
    for packet in replay_packets:
        verdict = human.get(packet.packet_key) or consensus.get(packet.packet_key)
        families = Counter(
            cases[c].family_key
            for c in packet.selected_case_ids
            if c in cases and cases[c].family_key
        )
        packet_rows.append(
            {
                "packet_key": packet.packet_key,
                "state": packet.state,
                "selected": packet.selected_case_ids,
                "verdict": verdict.verdict if verdict else None,
                "severity": verdict.severity if verdict else None,
                "human": packet.packet_key in human,
                "family_key": families.most_common(1)[0][0] if families else None,
                "price_cents": packet.price_cents,
                "price_findings": [],
            }
        )
    groups: dict[str, set[str]] = defaultdict(set)
    for case in sampled:
        if case.family_key:
            groups[case.family_key].add(case.case_id)
    rubric = load_rubric()
    from hushh_eval.drive_packets.deterministic import check_price

    for row, packet in zip(packet_rows, replay_packets, strict=True):
        assessment = (packet.visible or {}).get("assessment") or {}
        if assessment:
            row["price_findings"] = [item.code for item in check_price(assessment, rubric)]
    scores = []
    frame_summary = batch.private_json("frame_summary.json")
    if frame_summary:
        scores.extend(
            metrics.score(
                name, item["successes"], item["trials"], unit=item["unit"], independence="census"
            )
            for name, item in frame_summary.items()
        )
    scores += metrics.extraction(extraction_rows)
    scores.append(
        metrics.score(
            "extraction_env_limited",
            env_limited,
            len(sampled),
            unit="file_needing_ocr_absent_on_eval_machine",
            independence="file",
        )
    )
    scores += metrics.facts(fact_rows)
    scores += metrics.periods(period_rows)
    scores += metrics.packet_quality(packet_rows, groups)
    scores += metrics.false_ready(packet_rows)
    scores += metrics.price_sanity(packet_rows, pairs=[], injected=[])
    scores += metrics.delivery([])
    requests = batch.private_json("requests_scored.json")
    if requests:
        scores += metrics.retrieval(requests, retrievable_fraction=None)
    # A person confirmed the gated unit itself: the one Ready packet per family
    # that the listing gate counts, not any other Ready packet.
    gated = next(row for row in scores if row["metric"] == "ready_correct_one_per_family")
    usage = batch.private_json("usage_summary.json", {})
    return {
        "batch_id": batch.batch_id,
        "mode": "replay",
        "code_sha": plan.runtime.get("code_sha"),
        "label_version": LABEL_VERSION,
        "strata_version": STRATA_VERSION,
        "request_set_version": plan.request_set_version,
        "judge_signature": json.dumps(plan.judge, sort_keys=True),
        "files": len(sampled),
        "bars": {"n95": zero_failure_sample_size(0.95), "n999": zero_failure_sample_size(0.999)},
        "human_confirmed_ready": gated["extra"]["human_confirmed"],
        "human_labels": len({row.subject for row in label_rows if row.source == "human"}),
        "scores": scores,
        "packets": {
            "total": len(packet_rows),
            "states": dict(Counter(row["state"] for row in packet_rows)),
        },
        "judge_reliability": reliability(judgments),
        "usage": usage,
    }


def plan_judge_config(*, runtime_model: str, j1: str, j2: str, fake: bool) -> dict:
    if not fake:
        require_independent(runtime_model=runtime_model, j1=j1, j2=j2)
    from hushh_eval.drive_packets.judge import JUDGE_SEED, RUBRIC_VERSION

    return {
        "j1": j1,
        "j2": j2,
        "runtime_model": runtime_model,
        "rubric": RUBRIC_VERSION,
        "seed": JUDGE_SEED,
    }


def write_public(batch: Batch, *, founder: str, engineer: dict, canaries: list[str]) -> None:
    labels = read_rows(batch.file("labels.jsonl"), LabelRow)
    observations = read_rows(batch.file("observations.jsonl"), ObservationRow)
    sensitive = private_strings(
        [
            row.value
            for row in labels
            if row.field in {"issuer", "subject", "account", "document_type"}
        ]
        + [
            {key: row.output.get("facts", {}).get(key) for key in ("issuer", "subject", "account")}
            for row in observations
            if row.stage == "facts" and row.output.get("facts")
        ]
    )
    text_public = json.dumps(engineer, sort_keys=True)
    assert_public_text(founder, canaries=canaries, private=sensitive)
    assert_public_text(text_public, canaries=canaries, private=sensitive)
    batch.workdir.write_bytes(batch.file("report.md"), founder.encode())
    batch.workdir.write_bytes(
        batch.file("report.public.json"),
        (json.dumps(engineer, indent=2, sort_keys=True) + "\n").encode(),
    )
