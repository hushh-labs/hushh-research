"""python -m hushh_eval.drive_packets plan-batch | run-batch | judge | label | score | report | gate

Sources: ``fixture`` (synthetic, CI) or ``uat`` (one owner's Drive, read-only,
requires DRIVE_PACKET_EVAL_LIVE=1). Exit codes: 0 ok/pass, 1 fail, 2 insufficient
evidence or usage error. There is no command or flag that creates jobs, dispatches
workflows or writes to any database or Drive.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from hushh_eval.drive_packets import batch as ops
from hushh_eval.drive_packets.contracts import (
    CaseRow,
    JudgmentRow,
    LabelRow,
    ObservationRow,
    PacketRow,
    QueueRow,
    append_rows,
    read_rows,
    replace_rows,
)
from hushh_eval.drive_packets.privacy import PrivacyError, PrivateWorkdir, keyed
from hushh_mcp.managed_ai_config import load_profile

COMMANDS = ("plan-batch", "run-batch", "judge", "label", "score", "report", "gate")
VERDICT_ERRORS = {
    "judge_schema_invalid",
    "judge_citation_invalid",
    "judge_fail_without_reason",
    "judge_pass_with_failures",
    "judge_fail_without_citation",
}
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / "tests/fixtures/drive_pipeline_eval/manifest-v2.json"
RUNTIME_MODEL = "gemini-3.6-flash"
J1_MODEL = "gemini-3.1-pro-preview"
J2_MODEL = "gemini-3.8-flash"


class UsageError(Exception):
    pass


def _emit(payload: dict) -> None:
    print(json.dumps(payload, sort_keys=True), flush=True)


def _workdir(args) -> PrivateWorkdir:
    return PrivateWorkdir(Path(args.workdir).resolve())


def _live_required(args) -> None:
    if os.environ.get("DRIVE_PACKET_EVAL_LIVE") != "1":
        raise UsageError(
            "set DRIVE_PACKET_EVAL_LIVE=1 for live sources, the runtime model or Vertex judges"
        )


def _owner_listing(args, source) -> tuple[dict | None, str]:
    """The owner's name for the runtime's wrong-person fence, and where it came
    from: --owner-name, else the owner's identity on file in a live source.

    The name stays in memory as authored-assessment comparison context. It
    never enters a batch file or report, and only its origin is printed.
    """
    name = (getattr(args, "owner_name", None) or "").strip()
    if name:
        return {"names": [name]}, "explicit_name"
    read = getattr(source, "owner_identity", None)
    if callable(read):
        return read(), "name_on_file"
    return None, "none"


def _source(args, workdir, plan_source: dict):
    from hushh_eval.drive_packets.sources import FixtureSource, UatReadOnlySource

    if plan_source["kind"] == "fixture":
        return FixtureSource(ROOT / plan_source["manifest"], salt=workdir.salt())
    _live_required(args)
    owner = os.environ.get("DRIVE_PACKET_EVAL_OWNER")
    if not owner:
        raise UsageError("set DRIVE_PACKET_EVAL_OWNER to the consenting owner's user id")
    return UatReadOnlySource(owner_user_id=owner, db_port=plan_source["db_port"])


# --- plan-batch -------------------------------------------------------------------
async def _uat_frame(args, workdir):
    from hushh_eval.drive_packets.frame import build_frame
    from hushh_eval.drive_packets.sources import UatReadOnlySource
    from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE
    from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

    owner = os.environ.get("DRIVE_PACKET_EVAL_OWNER")
    if not owner:
        raise UsageError("set DRIVE_PACKET_EVAL_OWNER to the consenting owner's user id")
    source = UatReadOnlySource(owner_user_id=owner, db_port=args.db_port)
    try:
        snapshot = await asyncio.to_thread(
            source.snapshot, policy=facts_policy_version(), profile=EXTRACTION_PROFILE
        )
        drive = source.drive(concurrency=args.drive_concurrency)
        try:
            files = await drive.list_all(
                query="trashed = false",
                fields="id,mimeType,size,modifiedTime,createdTime,parents,version,md5Checksum",
            )
        finally:
            await drive.aclose()
        frame_id = "uat-" + datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        rows, crosswalk = build_frame(
            salt=workdir.salt(), frame_id=frame_id, documents=snapshot["documents"], listing=files
        )
        in_listing = {row.file_key for row in rows if row.in_independent_listing}
        in_system = {row.file_key for row in rows if row.in_system}
        indexed = {row.file_key for row in rows if row.system_stage == "indexed"}
        summary = {
            "discovery_coverage": {
                "successes": len(in_listing & in_system),
                "trials": len(in_listing),
                "unit": "file_in_independent_listing",
            },
            "indexed_coverage": {
                "successes": len(in_listing & indexed),
                "trials": len(in_listing),
                "unit": "file_in_independent_listing",
            },
            "phantom_rate": {
                "successes": len(in_system - in_listing),
                "trials": len(in_system),
                "unit": "system_document_row",
            },
        }
        ops.save_frame(workdir, frame_id, rows, crosswalk)
        workdir.write_json(ops.frame_dir(workdir, frame_id) / "summary.json", summary)
        workdir.write_json(
            ops.frame_dir(workdir, frame_id) / "provenance.json",
            {
                "uat": source.provenance,
                "drive_requests": drive.requests,
                "generation": snapshot["generation"],
            },
        )
        return frame_id
    finally:
        source.close()


def cmd_plan(args) -> int:
    workdir = _workdir(args)
    batch = ops.Batch(workdir, args.batch_id)
    from hushh_eval.drive_packets.replay import runtime_provenance

    eligible_keys = None
    if args.source == "fixture":
        from hushh_eval.drive_packets.sources import FixtureSource

        manifest = Path(args.fixture_manifest).resolve()
        source = FixtureSource(manifest, salt=workdir.salt())
        frame_id = "fixture-" + source.dataset["dataset_sha256"][:12]
        rows = source.frame(frame_id)
        ops.save_frame(workdir, frame_id, rows, {})
        plan_source = {"kind": "fixture", "manifest": str(manifest.relative_to(ROOT))}
        runtime = {"interpret": "fixture", **runtime_provenance(model="fixture-interpret")}
        judge = ops.plan_judge_config(
            runtime_model="fixture-interpret", j1="fake-j1", j2="fake-j2", fake=True
        )
    else:
        _live_required(args)
        frame_id = args.frame_id or asyncio.run(_uat_frame(args, workdir))
        rows, crosswalk = ops.load_frame(workdir, frame_id)
        if args.eligibility == "supported":
            from hushh_mcp.services.google_drive_adapter import LIVE_EXPORTS, SUPPORTED_TYPES

            supported = set(SUPPORTED_TYPES) | set(LIVE_EXPORTS)
            eligible_keys = {
                key for key, entry in crosswalk.items() if entry.get("mime_type") in supported
            }
        plan_source = {"kind": "uat", "db_port": args.db_port}
        runtime = {"interpret": "runtime", **runtime_provenance(model=args.runtime_model)}
        judge = ops.plan_judge_config(
            runtime_model=args.runtime_model, j1=args.j1_model, j2=args.j2_model, fake=False
        )
    anchors = []
    if args.anchors:
        from hushh_eval.drive_packets.anchors import load_anchors

        anchors = [
            keyed(workdir.salt(), "file", item["file_id"])
            for item in load_anchors(Path(args.anchors))
        ]
        workdir.write_json(batch.file("anchors.json"), json.loads(Path(args.anchors).read_text()))
    plan = ops.make_plan(
        batch,
        rows,
        seed=args.seed,
        n_clusters=args.n_clusters,
        n_loose=args.n_loose,
        per_cluster=args.per_cluster,
        folder_cap=args.folder_cap,
        anchor_keys=anchors,
        runtime=runtime,
        judge=judge,
        budget_usd=args.budget_usd,
        source=plan_source,
        eligible_keys=eligible_keys,
    )
    result = ops.write_plan(batch, plan)
    summary = workdir.path / "frames" / frame_id / "summary.json"
    if summary.exists():
        workdir.write_bytes(batch.file("frame_summary.json"), summary.read_bytes())
    _emit(
        {
            "command": "plan-batch",
            "batch_id": args.batch_id,
            "frame_rows": len(rows),
            "sampled": sum(item.stage != "anchor" for item in plan.sample),
            "anchors": len(anchors),
            "design_strata_sampled": len(plan.allocation),
            **result,
        }
    )
    return 0


# --- run-batch ------------------------------------------------------------------
async def _run(args) -> int:
    from hushh_eval.drive_packets.replay import (
        FakeInterpret,
        ReplayRunner,
        check_resumable,
        runtime_provenance,
    )
    from hushh_eval.drive_packets.usage import Budget

    workdir = _workdir(args)
    batch = ops.Batch(workdir, args.batch_id)
    plan = batch.plan()
    source_conf = plan.design["source"]
    fixture = source_conf["kind"] == "fixture"
    if not fixture:
        _live_required(args)
    model = "fixture-interpret" if fixture else plan.runtime["runtime_model"]
    runtime = {"interpret": "fixture" if fixture else "runtime", **runtime_provenance(model=model)}
    if runtime["code_sha"] != plan.runtime.get("code_sha") or runtime[
        "facts_policy_version"
    ] != plan.runtime.get("facts_policy_version"):
        raise UsageError("runtime_changed_since_plan")
    existing = read_rows(batch.file("observations.jsonl"), ObservationRow)
    done = check_resumable(existing, runtime)
    frame_rows, crosswalk = ops.load_frame(workdir, plan.frame_id)
    frame = {row.file_key: row for row in frame_rows}
    cases = ops.build_cases(batch, plan, frame)
    pending = [case for case in cases if case.case_id not in done]
    source = _source(args, workdir, source_conf)
    try:
        owner, owner_check = _owner_listing(args, source)
        replay_cases, extraction_rows, details = await ops.materialize(
            batch, pending, source, kind=source_conf["kind"], crosswalk=crosswalk
        )
    finally:
        if hasattr(source, "close"):
            source.close()
    append_rows(batch.file("cases.jsonl"), cases)
    previous = batch.private_json("details.json", {})
    workdir.write_json(batch.file("details.json"), previous | details)
    if fixture:
        interpret = FakeInterpret()
    else:
        from hushh_mcp.services.drive_request_package_assessment import _interpret

        interpret = _interpret
    budget = Budget(max_usd=min(plan.budget_usd, args.max_cost_usd or plan.budget_usd))
    runner = ReplayRunner(
        interpret=interpret, model=model, budget=budget, concurrency=args.concurrency
    )
    sampled = [case for case in replay_cases if not frame_is_anchor(plan, case.case_id)]
    anchored = [case for case in replay_cases if frame_is_anchor(plan, case.case_id)]
    result = await runner.run_owner_path(
        batch_id=batch.batch_id, cases=sampled, runtime=runtime, owner=owner
    )
    rows = extraction_rows + result.observations
    packets = result.packets
    anchor_report = None
    if anchored:
        anchor_runner = ReplayRunner(
            interpret=interpret, model=model, budget=budget, concurrency=args.concurrency
        )
        anchor_result = await anchor_runner.run_owner_path(
            batch_id=batch.batch_id, cases=anchored, runtime=runtime, owner=owner
        )
        rows += anchor_result.observations
        for packet in anchor_result.packets:
            packet.packet_key = "anchor" + packet.packet_key[6:]
        packets += anchor_result.packets
        anchor_report = grade_anchors(batch, anchored, anchor_result, details)
        result.usage.extend(anchor_result.usage)
    append_rows(batch.file("observations.jsonl"), rows)
    append_rows(batch.file("packets.jsonl"), packets)
    workdir.write_json(
        batch.file("facts_private.json"),
        {
            observation.case_id: observation.output.get("facts")
            for observation in read_rows(batch.file("observations.jsonl"), ObservationRow)
            if observation.stage == "facts"
        },
    )
    runtime_codes = dict(result.runtime_codes)
    if anchored:
        for key, value in anchor_result.runtime_codes.items():
            runtime_codes[f"anchor:{key}"] = value
    usage = {
        "runtime_codes": runtime_codes,
        "calls": len(result.usage),
        "estimated_cost_usd": round(budget.spent_usd, 4),
        "estimated": True,
        "budget_usd": budget.max_usd,
    }
    workdir.write_json(batch.file("usage_summary.json"), usage)
    statuses = Counter(f"{row.stage}:{row.status}" for row in rows)
    _emit(
        {
            "command": "run-batch",
            "batch_id": args.batch_id,
            "cases": len(cases),
            "statuses": dict(sorted(statuses.items())),
            "packets": dict(Counter(packet.state for packet in packets)),
            "anchors": anchor_report,
            "budget_exhausted": result.budget_exhausted,
            "owner_check": owner_check,
            "usage": usage,
        }
    )
    return 1 if result.budget_exhausted else 0


def frame_is_anchor(plan, case_id: str) -> bool:
    return any(
        item.stage == "anchor" and ops.case_id_for(item.file_key) == case_id for item in plan.sample
    )


def grade_anchors(batch, anchored, result, details) -> dict:
    from hushh_eval.drive_packets import anchors as panel

    expectations = panel.load_anchors(batch.file("anchors.json"))
    salt = batch.workdir.salt()
    by_case = {ops.case_id_for(keyed(salt, "file", item["file_id"])): item for item in expectations}
    uuid_by_case = {case.case_id: case.document_uuid for case in anchored}
    labeled = {
        uuid_by_case[case_id]: {
            "group": item["expect"]["group"],
            "periods": item["expect"]["periods"],
        }
        for case_id, item in by_case.items()
        if case_id in uuid_by_case
    }
    heads = result.heads
    graded = []
    for case_id, item in sorted(by_case.items()):
        document_uuid = uuid_by_case.get(case_id)
        document = result.documents.get(document_uuid) if document_uuid else None
        extraction = (details.get(case_id) or {}).get("extraction")
        member_heads = [head for head in heads if document_uuid in head["members"]]
        graded.append(
            {
                "anchor_id": item["anchor_id"],
                "extraction": panel.grade_extraction(item["expect"], extraction),
                "facts": panel.grade_facts(item["expect"], (document or {}).get("facts")),
                "packet": panel.grade_packet(item["expect"], document_uuid, member_heads, labeled),
            }
        )
    batch.workdir.write_json(batch.file("anchor_results.json"), graded)
    batch.workdir.write_json(batch.file("anchor_severity.json"), panel.severities(graded))
    return panel.counts(graded)


def cmd_run(args) -> int:
    return asyncio.run(_run(args))


# --- judge ------------------------------------------------------------------------
def _judges(args, plan):
    from hushh_eval.drive_packets.judge import FakeJudge, VertexJudge, require_independent

    if plan.design["source"]["kind"] == "fixture" or args.judge == "fake":
        return FakeJudge("fake-j1"), FakeJudge("fake-j2")
    _live_required(args)
    require_independent(
        runtime_model=plan.runtime["runtime_model"], j1=plan.judge["j1"], j2=plan.judge["j2"]
    )
    project = args.vertex_project or load_profile("uat")["project"]
    return (
        VertexJudge(model=plan.judge["j1"], project=project),
        VertexJudge(model=plan.judge["j2"], project=project),
    )


async def _judge(args) -> int:
    from hushh_eval.drive_packets.deterministic import check_packet
    from hushh_eval.drive_packets.judge import judge_packet

    batch = ops.Batch(_workdir(args), args.batch_id)
    plan = batch.plan()
    j1, j2 = _judges(args, plan)
    cases = {row.case_id: row for row in read_rows(batch.file("cases.jsonl"), CaseRow)}
    details = batch.private_json("details.json", {})
    facts = batch.private_json("facts_private.json", {})
    packets = read_rows(batch.file("packets.jsonl"), PacketRow)
    judgments = read_rows(batch.file("judgments.jsonl"), JudgmentRow)
    if args.retry_provider_errors:
        # A provider failure (rate limit, outage) is not a verdict: judge again.
        failed = {
            row.packet_key
            for row in judgments
            if row.judge_id in {"J1", "J2"}
            and row.error_code
            and row.error_code not in VERDICT_ERRORS
        }
        # A person's verdict is not a provider result: it survives the re-judging.
        judgments = [
            row for row in judgments if row.packet_key not in failed or row.judge_id == "human"
        ]
        replace_rows(batch.file("judgments.jsonl"), judgments)
        queue_rows = read_rows(batch.file("queue.jsonl"), QueueRow)
        replace_rows(
            batch.file("queue.jsonl"),
            [row for row in queue_rows if row.subject.removeprefix("packet:") not in failed],
        )
    done = {
        row.packet_key
        for row in judgments
        if row.variant == "consensus" or row.judge_id == "deterministic"
    }
    semaphore = asyncio.Semaphore(args.concurrency)
    rows, queue = [], []

    async def one(packet):
        assessment = (packet.visible or {}).get("assessment") or {}
        if packet.state == "failed" or not assessment:
            return
        members = ops.packet_members(packet, details, cases, facts)
        findings = check_packet(assessment, members, verification=packet.verification)
        async with semaphore:
            outcome = await judge_packet(
                batch_id=batch.batch_id,
                packet_key=packet.packet_key,
                packet=assessment,
                members=members,
                findings=findings,
                j1=j1,
                j2=j2,
            )
        rows.extend(outcome.rows)
        queue.extend(outcome.queue)

    await asyncio.gather(*(one(packet) for packet in packets if packet.packet_key not in done))
    append_rows(batch.file("judgments.jsonl"), rows)
    if queue:
        append_rows(batch.file("queue.jsonl"), queue)
    verdicts = Counter(
        row.verdict for row in rows if row.variant == "consensus" or row.judge_id == "deterministic"
    )
    _emit(
        {
            "command": "judge",
            "batch_id": args.batch_id,
            "judged": sum(verdicts.values()),
            "verdicts": dict(verdicts),
            "human_queue": len(queue),
        }
    )
    return 0


def cmd_judge(args) -> int:
    return asyncio.run(_judge(args))


# --- label ------------------------------------------------------------------------
async def _label(args) -> int:
    from hushh_eval.drive_packets.labels import (
        PreLabel,
        deterministic_labels,
        disagreements,
        human_slice,
        prelabel_payload,
        prelabel_rows,
        silver,
        terminal_label,
    )
    from hushh_eval.drive_packets.partition import BurnList, family_key, partition_for

    workdir = _workdir(args)
    batch = ops.Batch(workdir, args.batch_id)
    plan = batch.plan()
    cases = read_rows(batch.file("cases.jsonl"), CaseRow)
    details = batch.private_json("details.json", {})
    originals = batch.path / "originals"
    rows: list[LabelRow] = []
    j1, _ = _judges(args, plan)
    semaphore = asyncio.Semaphore(args.concurrency)

    # Resume: a case that already has a pre-label under this label version is
    # not sent to the model again.
    prelabeled = {
        row.subject
        for row in read_rows(batch.file("labels.jsonl"), LabelRow)
        if row.source == "prelabel" and row.label_version == plan.label_version
    }

    async def one(case):
        detail = details.get(case.case_id) or {}
        content_path = originals / case.case_id
        content = content_path.read_bytes() if content_path.exists() else None
        pages = {int(k): v for k, v in (detail.get("pages") or {}).items()}
        rows.extend(
            deterministic_labels(
                case_id=case.case_id,
                content=content,
                mime_type=detail.get("mime_type") or "",
                pages=pages or None,
            )
        )
        if not pages or case.case_id in prelabeled:
            return
        payload = prelabel_payload(
            pages=pages,
            metadata={**(detail.get("metadata") or {}), "mime_type": detail.get("mime_type")},
        )
        async with semaphore:
            try:
                answer, _ = await j1(
                    prompt=json.dumps(payload, ensure_ascii=False), schema=PreLabel
                )
                rows.extend(prelabel_rows(case.case_id, answer, labeler=getattr(j1, "model", "j1")))
            except Exception:  # noqa: BLE001 - a missing pre-label stays unknown
                return

    await asyncio.gather(*(one(case) for case in cases))
    if plan.design["source"]["kind"] == "fixture":
        from hushh_eval.drive_packets.sources import FixtureSource

        source = FixtureSource(ROOT / plan.design["source"]["manifest"], salt=workdir.salt())
        for case in cases:
            gold = source.labels(case.file_key) if case.file_key in source.documents else {}
            if gold.get("period_start") and gold.get("period_end"):
                rows.append(
                    LabelRow(
                        subject=case.case_id,
                        field="periods",
                        value=[[gold["period_start"], gold["period_end"]]],
                        source="legacy",
                        labeler="fixture-gold",
                        label_version=plan.label_version,
                    )
                )
            if gold.get("issuer"):
                rows.append(
                    LabelRow(
                        subject=case.case_id,
                        field="issuer",
                        value=gold["issuer"],
                        source="legacy",
                        labeler="fixture-gold",
                        label_version=plan.label_version,
                    )
                )
    rows += silver(rows)
    append_rows(batch.file("labels.jsonl"), rows)
    all_labels = read_rows(batch.file("labels.jsonl"), LabelRow)
    best = {}
    for row in all_labels:
        best.setdefault(row.subject, {})[(row.field, row.source)] = row.value
    salt = workdir.salt()
    burn = BurnList(workdir.path / "burned.jsonl")
    updated = []
    for case in cases:
        values = best.get(case.case_id, {})

        def pick(field, values=values):
            for source_name in ("human", "silver", "legacy", "prelabel"):
                if (field, source_name) in values:
                    return values[(field, source_name)]
            return None

        family = family_key(
            salt,
            issuer=pick("issuer"),
            account=pick("account"),
            subject=pick("subject"),
            document_type=pick("type_family") or pick("document_type"),
            fallback=case.cluster_key or case.file_key,
        )
        if case.anchor:
            burn.burn(case.file_key, "seven_source")
        partition, _ = partition_for(
            salt,
            burn,
            family=family,
            file_key=case.file_key,
            content_sha256=case.content_sha256,
            frozen_sha256=None,
        )
        updated.append(case.model_copy(update={"family_key": family, "partition": partition}))
    replace_rows(batch.file("cases.jsonl"), updated)
    judgments = read_rows(batch.file("judgments.jsonl"), JudgmentRow)
    packets = {row.packet_key: row for row in read_rows(batch.file("packets.jsonl"), PacketRow)}
    high_risk = {
        f"packet:{row.packet_key}"
        for row in judgments
        if row.variant == "consensus"
        and packets.get(row.packet_key)
        and packets[row.packet_key].state == "ready"
    }
    chosen = human_slice(
        [case.case_id for case in updated if not case.anchor],
        disagreed=disagreements(all_labels),
        high_risk_ready=high_risk,
        seed=plan.seed,
    )
    queue = [
        QueueRow(batch_id=batch.batch_id, subject=subject, reason=reason)
        for subject, reason in chosen.items()
    ]
    append_rows(batch.file("queue.jsonl"), queue)
    if args.interactive:
        review_packets(batch, queue, packets, judgments, labeler=args.labeler)
        for item in queue:
            if not item.subject.startswith("c"):
                continue
            proposal = {
                field: value
                for (field, source_name), value in best.get(item.subject, {}).items()
                if source_name in {"prelabel", "deterministic"}
            }
            append_rows(
                batch.file("labels.jsonl"),
                terminal_label(item.subject, proposal, labeler=args.labeler),
            )
    _emit(
        {
            "command": "label",
            "batch_id": args.batch_id,
            "labels": dict(Counter(row.source for row in rows)),
            "partitions": dict(Counter(case.partition for case in updated)),
            "families": len({case.family_key for case in updated}),
            "human_queue": dict(Counter(item.reason for item in queue)),
        }
    )
    return 0


def cmd_label(args) -> int:
    return asyncio.run(_label(args))


REVIEW_ORDER = {"fail": 0, "unknown": 1, "pass": 2}


def packet_review_lines(batch, packet: PacketRow, judgments: list[JudgmentRow]) -> list[str]:
    """What a person needs to decide one packet: its visible claims, the judges'
    verdicts and where the members' originals are. Operator terminal only."""
    assessment = (packet.visible or {}).get("assessment") or {}
    lines = [
        f"packet {packet.packet_key}: state {packet.state}",
        f"  title: {assessment.get('title')!r}",
        f"  description: {assessment.get('description')!r}",
        f"  coverage: {assessment.get('coverage_summary')!r}",
        f"  scope: {packet.temporal_scope}; periods: {packet.periods}; gaps: {packet.gaps_count}",
    ]
    for row in judgments:
        if row.packet_key == packet.packet_key and row.judge_id != "human":
            lines.append(
                f"  {row.judge_id}/{row.variant}: {row.verdict} {row.severity or ''} "
                f"{','.join(row.failed_checks)}".rstrip()
            )
    for case_id in packet.selected_case_ids:
        lines.append(f"  member {case_id}: {batch.path / 'originals' / case_id}")
    return lines


def review_packets(
    batch,
    queue: list[QueueRow],
    packets: dict,
    judgments: list[JudgmentRow],
    *,
    labeler: str,
    ask=input,
    show=print,
) -> int:
    """Ask a person for a pass / fail on each queued Ready packet: wrong first, then
    undecided, then passed. A packet a person already decided is not asked again."""
    from hushh_eval.drive_packets.labels import terminal_verdict

    decided = {row.packet_key for row in judgments if row.judge_id == "human"}
    consensus = {
        row.packet_key: row.verdict
        for row in judgments
        if row.judge_id in {"consensus", "deterministic"}
    }
    keys = [
        item.subject.removeprefix("packet:") for item in queue if item.subject.startswith("packet:")
    ]
    pending = sorted(
        (key for key in keys if key in packets and key not in decided),
        key=lambda key: (REVIEW_ORDER.get(consensus.get(key, "unknown"), 1), key),
    )
    written = 0
    for key in pending:
        row = terminal_verdict(
            key,
            packet_review_lines(batch, packets[key], judgments),
            batch_id=batch.batch_id,
            labeler=labeler,
            ask=ask,
            show=show,
        )
        if row is not None:
            written += append_rows(batch.file("judgments.jsonl"), [row])
    return written


# --- score / report / gate ------------------------------------------------------------
def cmd_score(args) -> int:
    batch = ops.Batch(_workdir(args), args.batch_id)
    card = ops.scorecard(batch)
    batch.workdir.write_json(batch.file("scores.json"), card)
    _emit(
        {
            "command": "score",
            "batch_id": args.batch_id,
            "metrics": len(card["scores"]),
            "packets": card["packets"],
        }
    )
    return 0


def _scores(batch) -> dict:
    from hushh_eval.drive_packets.labels import LABEL_VERSION

    card = batch.private_json("scores.json")
    if card is None:
        raise UsageError("run score first")
    if card.get("label_version") != LABEL_VERSION:
        raise UsageError("stale_label_version: rescore under the current labels")
    return card


def cmd_report(args) -> int:
    from hushh_eval.drive_packets.gates import listing_gate, load_thresholds
    from hushh_eval.drive_packets.report import engineer_report, founder_report

    batch = ops.Batch(_workdir(args), args.batch_id)
    card = _scores(batch)
    thresholds = load_thresholds()
    listing = listing_gate(card, thresholds).model_dump()
    founder = founder_report(card, listing)
    anchors = batch.private_json("anchor_results.json")
    extra = {
        "judge_reliability": card.get("judge_reliability", {}),
        "packets": {"total": card["packets"]["total"]},
    }
    if anchors:
        from hushh_eval.drive_packets.anchors import counts

        extra["anchor_panel"] = counts(anchors)
    engineer = engineer_report(card, [listing], extra)
    canaries = [value for value in os.environ.get("DPE_CANARIES", "").split(",") if value]
    ops.write_public(batch, founder=founder, engineer=engineer, canaries=canaries)
    sys.stdout.write(founder)
    return 0


def cmd_gate(args) -> int:
    from hushh_eval.drive_packets.gates import (
        deploy_gate,
        listing_gate,
        load_thresholds,
        ready_gate,
    )

    thresholds = load_thresholds()
    batch = ops.Batch(_workdir(args), args.batch_id)
    if args.gate == "deploy":
        from hushh_eval.drive_packets.guards import run_suite, suite_status

        status = suite_status(asyncio.run(run_suite()))
        anchor = batch.private_json("anchor_severity.json") if args.anchor else None
        previous = (
            json.loads(Path(args.previous_anchor).read_text()) if args.previous_anchor else None
        )
        row = deploy_gate(
            guard_status=status, anchor=anchor, previous_anchor=previous, thresholds=thresholds
        )
        extra = {"guard_cases": status["cases"], "known_gaps_open": len(status["known_gaps_open"])}
    else:
        card = _scores(batch)
        row = (listing_gate if args.gate == "listing" else ready_gate)(card, thresholds)
        extra = {}
    batch.workdir.write_json(batch.file(f"gate-{args.gate}.json"), row.model_dump())
    _emit({"command": "gate", **row.model_dump(), **extra})
    return row.exit_code


# --- parser ---------------------------------------------------------------------------
def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="python -m hushh_eval.drive_packets", description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)

    def base(name, help_text):
        command = sub.add_parser(name, help=help_text)
        command.add_argument("--workdir", required=True, help="Private 0700 directory outside git")
        command.add_argument("--batch-id", required=True)
        return command

    plan = base("plan-batch", "Build or reuse a frame and preregister a seeded sample")
    plan.add_argument("--source", choices=("fixture", "uat"), default="fixture")
    plan.add_argument("--fixture-manifest", default=str(DEFAULT_MANIFEST))
    plan.add_argument("--frame-id", help="Reuse an existing frame instead of listing again")
    plan.add_argument(
        "--db-port", type=int, default=6655, help="Local Cloud SQL proxy port (read-only use)"
    )
    plan.add_argument("--drive-concurrency", type=int, default=4, choices=range(1, 5))
    plan.add_argument("--seed", type=int, required=True)
    plan.add_argument("--n-clusters", type=int, default=24)
    plan.add_argument("--per-cluster", type=int, default=15)
    plan.add_argument("--n-loose", type=int, default=60)
    plan.add_argument("--folder-cap", type=float, default=0.10)
    plan.add_argument(
        "--eligibility",
        choices=("all", "supported"),
        default="all",
        help="all files, or only formats the product can read (uat source)",
    )
    plan.add_argument("--anchors", help="Private anchor expectations (dpe.anchor.v1)")
    plan.add_argument("--budget-usd", type=float, default=100.0)
    plan.add_argument("--runtime-model", default=RUNTIME_MODEL)
    plan.add_argument("--j1-model", default=J1_MODEL)
    plan.add_argument("--j2-model", default=J2_MODEL)
    plan.set_defaults(func=cmd_plan)

    run = base("run-batch", "Replay production code on the preregistered sample")
    run.add_argument("--concurrency", type=int, default=8, choices=range(1, 9))
    run.add_argument("--max-cost-usd", type=float)
    run.add_argument(
        "--owner-name",
        help="The consenting owner's name for the wrong-person fence (default: the owner's "
        "identity on file for live sources). Held in memory as model context; never written or printed.",
    )
    run.set_defaults(func=cmd_run)

    judge = base("judge", "Deterministic checks, then the pinned J1/J2 judges")
    judge.add_argument("--judge", choices=("vertex", "fake"), default="vertex")
    judge.add_argument("--vertex-project", default=None)
    judge.add_argument("--concurrency", type=int, default=8, choices=range(1, 9))
    judge.add_argument(
        "--retry-provider-errors",
        action="store_true",
        help="Judge again packets whose judge call failed at the provider (not a verdict)",
    )
    judge.set_defaults(func=cmd_judge)

    label = base("label", "Deterministic labels, blind pre-labels, silver and the human queue")
    label.add_argument("--judge", choices=("vertex", "fake"), default="vertex")
    label.add_argument("--vertex-project", default=None)
    label.add_argument("--concurrency", type=int, default=8, choices=range(1, 9))
    label.add_argument("--interactive", action="store_true", help="Terminal y/n/edit labeler")
    label.add_argument("--labeler", default="operator")
    label.set_defaults(func=cmd_label)

    score = base("score", "Compute every stage metric")
    score.set_defaults(func=cmd_score)
    report = base("report", "Founder report (12 lines) and the public engineer JSON")
    report.set_defaults(func=cmd_report)
    gate = base("gate", "Exit 0 pass, 1 fail, 2 insufficient evidence")
    gate.add_argument("--gate", choices=("deploy", "listing", "ready"), required=True)
    gate.add_argument(
        "--anchor", action="store_true", help="Include the anchor panel (deploy gate)"
    )
    gate.add_argument("--previous-anchor", help="Previous anchor_severity.json to compare against")
    gate.set_defaults(func=cmd_gate)
    return root


def main(argv: list[str] | None = None) -> int:
    from hushh_eval.drive_packets.sampling import PlanError
    from hushh_eval.drive_packets.sources import LiveOptInRequired

    args = parser().parse_args(argv)
    try:
        return args.func(args)
    except (UsageError, PrivacyError, PlanError, LiveOptInRequired, FileNotFoundError) as error:
        system_error = isinstance(error, FileNotFoundError) and error.errno is not None
        code = "file_missing" if system_error else str(error).split(":")[0][:120]
        _emit({"command": args.command, "error": code})
        return 2
