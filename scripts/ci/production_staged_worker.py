"""Read attempt-bound worker staging evidence; grant no deployment authority."""

from __future__ import annotations

import hashlib
import json
import re
import time
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from runpy import run_path
from urllib.parse import urlsplit
from zipfile import BadZipFile, ZipFile

import production_phone_lease_receipts as leases
import production_phone_receipt as phone
import production_worker_basis as basis_owner
import release_artifact_receipts as receipts

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = ".github/workflows/deploy-production.yml"
JOB = "Stage qualified production Drive worker"
UPLOAD = "Publish staged worker qualification"
PREPARE = "Prepare private production Drive worker"
INTENT = "Publish prepared worker intent"
STAGE = "Stage private production Drive worker"
STEPS = (
    "Validate deployment SHA against main",
    "Require exact-SHA UAT acceptance",
    "Require qualified production worker release",
    "Enforce production worker staging capacity",
    PREPARE,
    INTENT,
    STAGE,
    UPLOAD,
)
FILES = (
    "worker-stage.json",
    "worker-stage.json.staged.json",
    "worker-stage.json.scheduler.json",
)
PROJECT, REGION, SERVICE = "hushh-pda", "us-central1", "consent-protocol-drive-worker"
PREPARED_FIELDS = {
    "schema",
    "status",
    "project",
    "service",
    "context",
    "expires",
    "baseline",
    "baseline_template",
    "candidate",
    "config_version",
    "template",
}


def _require(condition, reason):
    if not condition:
        raise receipts.retention.UnsafeState("Worker staging proof: " + reason)


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def _sha(value, size=64):
    return isinstance(value, str) and bool(re.fullmatch(r"[0-9a-f]{%d}" % size, value))


def _uid(value):
    return isinstance(value, str) and 0 < len(value) <= 256


def _revision(value):
    return (
        isinstance(value, str)
        and len(value) <= 63
        and bool(re.fullmatch(SERVICE + r"-[a-z0-9-]+", value))
    )


def _origin(run_id, run, governed):
    _require(
        type(run.get("id")) is int
        and run["id"] == int(run_id)
        and type(run.get("run_attempt")) is int
        and run["run_attempt"] > 0
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and run.get("path") == WORKFLOW
        and _sha(run.get("head_sha"), 40)
        and governed(run, REPOSITORY, "production"),
        "run origin is unqualified",
    )


def _gates(jobs, timestamp):
    rows = jobs.get("jobs")
    _require(
        isinstance(rows, list)
        and jobs.get("total_count") == len(rows)
        and len(rows) <= 100
        and all(isinstance(row, dict) for row in rows),
        "job inventory is incomplete",
    )
    selected = [row for row in rows if row.get("name") == JOB]
    _require(len(selected) == 1, "stage job is ambiguous")
    steps = selected[0].get("steps")
    _require(
        isinstance(steps, list)
        and len(steps) <= 500
        and all(
            isinstance(row, dict) and isinstance(row.get("name"), str) for row in steps
        ),
        "stage steps are invalid",
    )
    indexed = {row["name"]: row for row in steps}
    _require(
        selected[0].get("conclusion") == "success"
        and len(indexed) == len(steps)
        and all(
            indexed.get(name, {}).get("status") == "completed"
            and indexed[name].get("conclusion") == "success"
            for name in STEPS
        ),
        "stage gates are incomplete",
    )
    prepare_start = timestamp(indexed[PREPARE].get("started_at"))
    prepare_end = timestamp(indexed[PREPARE].get("completed_at"))
    intent_end = timestamp(indexed[INTENT].get("completed_at"))
    stage_start = timestamp(indexed[STAGE].get("started_at"))
    stage_end = timestamp(indexed[STAGE].get("completed_at"))
    upload_start = timestamp(indexed[UPLOAD].get("started_at"))
    _require(
        all(
            (
                prepare_start,
                prepare_end,
                intent_end,
                stage_start,
                stage_end,
                upload_start,
            )
        )
        and prepare_start
        <= prepare_end
        <= intent_end
        <= stage_start
        <= stage_end
        <= upload_start,
        "durable preparation did not precede staging",
    )
    return prepare_start, prepare_end


def _files(archive, names=FILES):
    try:
        with ZipFile(BytesIO(archive)) as bundle:
            _require(
                set(bundle.namelist()) == set(names), "artifact members are unexpected"
            )
        files = {name: receipts._status_bytes(archive, name) for name in names}
        decoded = {}
        for name, raw in files.items():
            value = json.loads(raw, object_pairs_hook=phone._unique_object)
            _require(isinstance(value, dict), "receipt member is invalid")
            decoded[name] = value
        return files, decoded
    except (BadZipFile, ValueError, TypeError) as error:
        raise receipts.retention.UnsafeState(
            "Worker staging proof: receipt member is invalid"
        ) from error


@lru_cache(maxsize=1)
def _scheduler_owner():
    return run_path(str(ROOT / "deploy/drive/work_drain_scheduler_snapshot_prod.py"))


def _scheduler(snapshot):
    owner = _scheduler_owner()
    jobs = snapshot.get("jobs")
    _require(
        snapshot.get("schema") == "drive.scheduler.prod.snapshot.v1"
        and isinstance(jobs, dict)
        and set(jobs) == set(owner["JOB_STAGES"]),
        "scheduler inventory is incomplete",
    )
    origins = set()
    for job in jobs.values():
        if isinstance(job, dict) and isinstance(job.get("uri"), str):
            uri = urlsplit(job["uri"])
            origin = f"{uri.scheme}://{uri.netloc}"
            if owner["WORKER_ORIGIN"].fullmatch(origin):
                origins.add(origin)
    _require(len(origins) <= 1, "scheduler worker origin is ambiguous")
    try:
        owner["_validate_snapshot"](jobs, worker_origin=next(iter(origins), None))
    except owner["SchedulerStateError"] as error:
        raise receipts.retention.UnsafeState(
            "Worker staging proof: scheduler baseline is invalid"
        ) from error


def _baseline(value, scheduler, candidate):
    _require(isinstance(value, dict), "worker baseline is missing")
    traffic = value.get("traffic")
    _require(
        _uid(value.get("uid"))
        and all(_sha(value.get(key)) for key in ("controls", "iam", "scheduler"))
        and value["scheduler"] == _hash(scheduler)
        and _revision(value.get("serving"))
        and value["serving"] != candidate
        and isinstance(traffic, list)
        and 0 < len(traffic) <= 100
        and all(
            isinstance(row, dict)
            and _revision(row.get("revisionName"))
            and not row.get("latestRevision")
            and type(row.get("percent", 0)) is int
            and 0 <= row.get("percent", 0) <= 100
            for row in traffic
        ),
        "worker baseline is invalid",
    )
    positive = [row for row in traffic if row.get("percent", 0)]
    _require(
        len(positive) == 1
        and positive[0]["percent"] == 100
        and positive[0]["revisionName"] == value["serving"]
        and all(row["revisionName"] != candidate for row in traffic),
        "worker baseline traffic is unqualified",
    )


def _clock(expiry, window):
    _require(
        type(expiry) is int
        and expiry > time.time()
        and window[0].timestamp() - 5 <= expiry - 21600 <= window[1].timestamp() + 5,
        "preparation is expired or its six-hour clock changed",
    )


def bind_release_basis(
    value, context, baseline, *, healthy_release_run_id=None, source_only=False
) -> basis_owner.HealthyWorkerBasis:
    """The basis owner qualifies current health; this owner binds worker intent."""
    _require(isinstance(value, dict), "healthy release basis is missing")
    basis = (basis_owner.qualify_source if source_only else basis_owner.revalidate)(
        value
    )
    healthy, candidate, worker, mode = (
        basis["healthy"],
        basis["candidate"],
        basis["worker"],
        basis["protected_documents"],
    )
    _require(
        (healthy_release_run_id is None or healthy["run_id"] == healthy_release_run_id)
        and context.get("source") == candidate["source"]
        and context.get("image") == candidate["image"]
        and type(mode.get("enabled")) is bool
        and context.get("protected") == ("true" if mode["enabled"] else "false")
        and baseline.get("uid") == worker["service_uid"]
        and baseline.get("serving") == worker["revision"],
        "healthy basis, candidate context or worker baseline changed",
    )
    return basis


def _selection(prepared, anchor, release_basis, healthy_run, source_only):
    if anchor is not None:
        boundary = anchor.get("sealed_boundary", {})
        return (
            boundary.get("checkpoint", {}).get("plan", {}).get("primary_sha"),
            boundary.get("primary_image"),
            boundary.get("document_mode", {}),
            None,
        )
    value = prepared.get("release_basis") if release_basis is None else release_basis
    basis = bind_release_basis(
        value,
        prepared.get("context", {}),
        prepared.get("baseline", {}),
        healthy_release_run_id=healthy_run,
        source_only=source_only,
    )
    _require(prepared.get("release_basis") == basis, "immutable healthy basis changed")
    candidate = basis["candidate"]
    return candidate["source"], candidate["image"], basis["protected_documents"], basis


def _qualified(prepared, staged, scheduler, files, run, selected, window):
    source, image, mode, basis = selected
    context = {
        "source": source,
        "image": image,
        "run_id": str(run["id"]),
        "attempt": str(run["run_attempt"]),
        "config_secret": f"BACKEND_RUNTIME_CONFIG_JSON_DRIVE_{run['id']}_{run['run_attempt']}",
        "protected": "true" if mode.get("enabled") is True else "false",
    }
    candidate = f"{SERVICE}-s-{run['id']}-{run['run_attempt']}"
    fields = PREPARED_FIELDS | ({"release_basis"} if basis is not None else set())
    _require(
        set(prepared) == fields
        and set(staged)
        == fields | {"prepared_sha256", "candidate_uid", "candidate_spec"}
        and _sha(source, 40)
        and type(mode.get("enabled")) is bool
        and isinstance(context["image"], str)
        and bool(
            re.fullmatch(
                r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}",
                context["image"],
            )
        )
        and prepared.get("schema") == "drive.worker.stage.v1"
        and prepared.get("status") == "prepared"
        and staged.get("status") == "staged"
        and prepared.get("project") == PROJECT
        and prepared.get("service") == SERVICE
        and prepared.get("context") == context
        and prepared.get("candidate") == candidate
        and _revision(candidate)
        and _uid(staged.get("candidate_uid"))
        and isinstance(prepared.get("config_version"), str)
        and bool(re.fullmatch(r"[1-9][0-9]*", prepared["config_version"]))
        and all(_sha(prepared.get(key)) for key in ("baseline_template", "template"))
        and _sha(staged.get("candidate_spec"))
        and staged.get("prepared_sha256") == hashlib.sha256(files[FILES[0]]).hexdigest()
        and all(
            staged.get(key) == value
            for key, value in prepared.items()
            if key != "status"
        ),
        "prepared and staged identities differ",
    )
    expiry = prepared.get("expires")
    _clock(expiry, window)
    _scheduler(scheduler)
    _baseline(prepared.get("baseline"), scheduler, candidate)
    result = {
        "schema_version": 1,
        "kind": "production-staged-worker",
        "status": "worker_staged",
        "project": PROJECT,
        "region": REGION,
        "service": SERVICE,
        "revision": candidate,
        "uid": staged["candidate_uid"],
        "source": source,
        "image": context["image"],
        "runtime_run_id": str(run["id"]),
        "service_uid": prepared["baseline"]["uid"],
        "serving_revision": prepared["baseline"]["serving"],
        "controls": prepared["baseline"]["controls"],
        "iam": prepared["baseline"]["iam"],
        "scheduler": prepared["baseline"]["scheduler"],
        "scheduler_snapshot": scheduler,
        "context": context,
        "config_version": prepared["config_version"],
        "candidate_spec": staged["candidate_spec"],
        "expires": expiry,
        "baseline": prepared["baseline"],
        "baseline_template": prepared["baseline_template"],
        "template": prepared["template"],
    }
    if basis is not None:
        result["basis"] = basis
    return result


def _prepared_intent(run, jobs, files, *, api, timestamp, run_command, timeout):
    artifact = leases.artifact(
        REPOSITORY,
        run,
        jobs,
        api,
        timestamp,
        job=JOB,
        upload=INTENT,
        name=f"prod-drive-worker-intent-{run['id']}-{run['run_attempt']}",
    )
    archive = receipts.immutable_archive(
        REPOSITORY, artifact, run_command=run_command, timeout=timeout
    )
    original, _decoded = _files(archive, (FILES[0], FILES[2]))
    _require(
        all(original[name] == files[name] for name in original),
        "final stage differs from its immutable preparation",
    )
    return {"artifact_id": artifact["id"], "artifact_digest": artifact["digest"]}


def _requested(anchor, basis, healthy_run, source_only):
    healthy = basis is not None or healthy_run is not None
    _require(type(source_only) is bool, "source mode is invalid")
    if anchor is not None:
        _require(
            isinstance(anchor, dict) and not healthy and not source_only,
            "operational and healthy bases cannot mix",
        )
    else:
        _require(healthy, "a qualified release basis is required")
    if healthy_run is not None:
        _require(
            isinstance(healthy_run, str)
            and bool(re.fullmatch(r"[1-9][0-9]*", healthy_run)),
            "requested healthy release is invalid",
        )


def load_worker(
    run_id,
    operational_anchor=None,
    *,
    release_basis: basis_owner.HealthyWorkerBasis | None = None,
    healthy_release_run_id=None,
    source_only=False,
    api,
    governed,
    timestamp,
    run_command,
    timeout,
):
    """Return JSON-safe context plus only the three verified original file bytes."""
    _requested(operational_anchor, release_basis, healthy_release_run_id, source_only)
    _require(
        isinstance(run_id, str)
        and bool(re.fullmatch(r"[1-9][0-9]*", run_id))
        and timeout > 0,
        "requested origin is invalid",
    )
    run = api(REPOSITORY, f"runs/{run_id}")
    _origin(run_id, run, governed)
    jobs = api(
        REPOSITORY, f"runs/{run_id}/attempts/{run['run_attempt']}/jobs?per_page=100"
    )
    window = _gates(jobs, timestamp)
    artifact = leases.artifact(
        REPOSITORY,
        run,
        jobs,
        api,
        timestamp,
        job=JOB,
        upload=UPLOAD,
        name=f"prod-drive-worker-stage-{run_id}-{run['run_attempt']}",
    )
    archive = receipts.immutable_archive(
        REPOSITORY, artifact, run_command=run_command, timeout=timeout
    )
    files, decoded = _files(archive)
    ports = dict(api=api, timestamp=timestamp, run_command=run_command, timeout=timeout)
    original = _prepared_intent(run, jobs, files, **ports)
    selected = _selection(
        decoded[FILES[0]],
        operational_anchor,
        release_basis,
        healthy_release_run_id,
        source_only,
    )
    context = _qualified(
        *(decoded[name] for name in FILES), files, run, selected, window
    )
    refreshed = api(REPOSITORY, f"runs/{run_id}")
    _require(
        all(
            refreshed.get(key) == run.get(key)
            for key in ("id", "run_attempt", "head_sha", "status", "conclusion")
        ),
        "producer attempt changed during lookup",
    )
    context["origin"] = {
        "run_id": run_id,
        "run_attempt": run["run_attempt"],
        "workflow_sha": run["head_sha"],
        "artifact_id": artifact["id"],
        "artifact_digest": artifact["digest"],
    }
    context["prepared_intent"] = original
    if source_only:
        return {
            "kind": "production-staged-worker-prospective",
            "basis": context["basis"],
            "origin": context["origin"],
        }
    return {"context": context, "files": files}
