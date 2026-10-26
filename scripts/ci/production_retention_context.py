"""Bind operational and pending retirement contexts to existing cleanup owners."""

from __future__ import annotations

import hashlib
import importlib
import json
import math
import re
import tempfile
from pathlib import Path
from runpy import run_path
from typing import Literal, TypedDict

import production_phone_receipt
import retention_admission

ROOT = Path(__file__).resolve().parents[2]


class ProspectiveReference(TypedDict):
    kind: Literal["production-operational-prospective"]
    original_healthy: dict
    origin: dict


def optional_attempt(raw: str) -> int | None:
    return int(raw) if raw else None


def check_inputs(args, parser) -> None:
    requested, attempt = (
        args.operational_backend_proof_run_id,
        args.operational_backend_proof_attempt,
    )
    if bool(requested) != (attempt is not None) or (
        requested
        and (
            args.environment != "production"
            or not re.fullmatch(r"[1-9][0-9]*", requested)
            or attempt < 1
            or not args.release_run_id
            or args.production_capacity_bridge
        )
    ):
        parser.error(
            "operational backend proof requires its exact production release and positive origin attempt"
        )
    if args.staged_worker_run_id and (
        args.environment != "production"
        or not re.fullmatch(r"[1-9][0-9]*", args.staged_worker_run_id)
        or not re.fullmatch(r"[1-9][0-9]*", args.release_run_id)
        or args.production_capacity_bridge
    ):
        parser.error(
            "staged worker cleanup requires exact positive production release and stage runs without a capacity bridge"
        )


def load_operational(owner, args):
    requested = getattr(args, "operational_backend_proof_run_id", "")
    if not requested:
        return None
    if args.verify_source_only:
        return source_operational(owner, args)
    return active(
        owner,
        requested,
        args.operational_backend_proof_attempt,
        live=not args.verify_source_only,
    )


def source_operational(owner, args):
    control = importlib.import_module("production_backend_successor_control")
    proof = importlib.import_module("production_backend_successor_proof")
    current = proof.read_original()
    anchor = control.record_anchor(current)
    if anchor is not None:
        if (
            anchor["origin"]["run_id"] != args.operational_backend_proof_run_id
            or anchor["origin"]["run_attempt"] != args.operational_backend_proof_attempt
        ):
            raise owner.retention.UnsafeState("operational source origin changed")
        return anchor
    proposed = control.load_anchor(
        args.operational_backend_proof_run_id, args.operational_backend_proof_attempt
    )
    if proposed["original_healthy"] != current:
        raise owner.retention.UnsafeState(
            "prospective operational healthy reference changed"
        )
    prospective: ProspectiveReference = {
        "kind": "production-operational-prospective",
        "original_healthy": current,
        "origin": proposed["origin"],
    }
    args.prospective_operational = prospective
    return None


def services(owner, args) -> dict:
    if args.pending_context:
        return {
            "consent-protocol": owner.LANES["production"]["services"][
                "consent-protocol"
            ]
        }
    result = owner.LANES[args.environment]["services"].copy()
    if args.environment == "production" and args.worker_anchor is None:
        result.pop("consent-protocol-drive-worker")
    return result


def find_source(owner, args, repository):
    anchors = []
    with tempfile.TemporaryDirectory() as temporary:
        found = owner.find_release(
            repository,
            args.release_run_id,
            Path(temporary),
            require_live=not args.verify_source_only,
            environment=args.environment,
            on_phone_rollback=anchors.append,
            **(
                {"operational_anchor": args.operational_anchor}
                if args.operational_anchor
                else {}
            ),
        )
    args.phone_anchor = anchors[-1] if anchors else None
    return found


def healthy_phone(owner, repository, run, release, lane, callback):
    if (
        lane["project"] != "hushh-pda"
        or "phone_rollback" not in release
        or release.get("status") != "healthy"
    ):
        return
    original = {
        key: value
        for key, value in release.items()
        if not key.startswith("_maintenance_")
    }
    continuation = importlib.import_module(
        "production_activation_continuation"
    ).archive_context(
        repository,
        run,
        original,
        lane,
        api=owner.api,
        governed=owner.governed_dispatch,
        timestamp=owner._github_timestamp,
        run_command=owner.retention.run_command,
        timeout=min(
            owner.retention.remaining_seconds(owner.GITHUB_LOOKUP_SECONDS),
            (owner._LOOKUP_DEADLINE.get() or math.inf) - owner.time.monotonic(),
        ),
    )
    if continuation is not None:
        backend = continuation["backend"]
        release["_maintenance_lane_provenance"] = {
            "backend": {
                "run_id": backend["run_id"],
                "sha": backend["sha"],
                "source": "deploy-production",
            }
        }
        if "frontend" in continuation:
            frontend = continuation["frontend"]
            release["_maintenance_lane_provenance"]["frontend"] = {
                "run_id": frontend["run_id"],
                "sha": frontend["sha"],
                "source": "deploy-production",
            }
        release["_maintenance_backend_identity"] = backend
        if callback is not None:
            callback(continuation["cold_rollback"])
        return
    anchor = production_phone_receipt.healthy_anchor(
        repository,
        run,
        original,
        lane,
        api=owner.api,
        governed=owner.governed_dispatch,
        timestamp=owner._github_timestamp,
        run_command=owner.retention.run_command,
        timeout=min(
            owner.retention.remaining_seconds(owner.GITHUB_LOOKUP_SECONDS),
            (owner._LOOKUP_DEADLINE.get() or math.inf) - owner.time.monotonic(),
        ),
    )
    if callback is not None:
        callback(anchor)


def worker(owner, args, repository):
    if not getattr(args, "staged_worker_run_id", ""):
        return None
    if args.verify_source_only and getattr(args, "prospective_operational", None):
        return None
    reader = importlib.import_module("production_staged_worker")
    if args.operational_anchor is None:
        loaded = reader.load_worker(
            args.staged_worker_run_id,
            None,
            healthy_release_run_id=args.release_run_id,
            source_only=args.verify_source_only,
            api=owner.api,
            governed=owner.governed_dispatch,
            timestamp=owner._github_timestamp,
            run_command=owner.retention.run_command,
            timeout=owner.retention.remaining_seconds(owner.GITHUB_LOOKUP_SECONDS),
        )
        return None if args.verify_source_only else loaded
    return reader.load_worker(
        args.staged_worker_run_id,
        args.operational_anchor,
        api=owner.api,
        governed=owner.governed_dispatch,
        timestamp=owner._github_timestamp,
        run_command=owner.retention.run_command,
        timeout=owner.retention.remaining_seconds(owner.GITHUB_LOOKUP_SECONDS),
    )


def worker_flags(owner, loaded) -> list[str]:
    context, files = loaded["context"], loaded["files"]
    staged = run_path(str(ROOT / "deploy/drive/staged_worker.py"))
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "worker-stage.json.scheduler.json"
        path.write_bytes(files[path.name])
        receipt = json.loads(files["worker-stage.json.staged.json"])
        identities = {
            "revision": receipt["candidate"],
            "uid": receipt["candidate_uid"],
            "source": receipt["context"]["source"],
            "image": receipt["context"]["image"],
            "serving_revision": receipt["baseline"]["serving"],
            "service_uid": receipt["baseline"]["uid"],
        }
        if any(context.get(key) != value for key, value in identities.items()):
            raise owner.retention.UnsafeState(
                "staged worker context and immutable files differ"
            )
        staged["validate"](receipt, path, allow_retirement=True)
    return [
        context["serving_revision"],
        "--rollback-revision",
        context["revision"],
        "--last-known-good-revision",
        context["serving_revision"],
    ]


def active(owner, requested: str, attempt: int, *, live=True) -> dict:
    control = importlib.import_module("production_backend_successor_control")
    proof = importlib.import_module("production_backend_successor_proof")
    anchor = control.record_anchor(proof.read_original())
    if (
        anchor is None
        or anchor["origin"]["run_id"] != requested
        or anchor["origin"]["run_attempt"] != attempt
    ):
        raise owner.retention.UnsafeState(
            "operational backend reference is absent or belongs to another origin"
        )
    if live:
        control.live(anchor)
    return anchor


def pending(owner, repository, run, release, anchor):
    if anchor is None:
        raise owner.retention.UnsafeState(
            "pending activation requires the active operational backend reference"
        )
    reader = importlib.import_module("production_pending_activation")
    timeout = min(
        owner.retention.remaining_seconds(owner.GITHUB_LOOKUP_SECONDS),
        (owner._LOOKUP_DEADLINE.get() or math.inf) - owner.time.monotonic(),
    )
    return reader.pending_context(
        repository,
        run,
        release,
        owner.LANES["production"],
        operational_anchor=anchor,
        api=owner.api,
        governed=owner.governed_dispatch,
        timestamp=owner._github_timestamp,
        run_command=owner.retention.run_command,
        timeout=timeout,
    )


def pending_live(owner, release, context) -> None:
    candidate = context["candidate"]
    service = owner.retention.service_state(
        "consent-protocol", "hushh-pda", owner.REGION
    )
    revisions = owner.retention.revision_state(
        "consent-protocol", "hushh-pda", owner.REGION
    )
    plan = owner.retention.plan_cleanup(
        service,
        revisions,
        2,
        {candidate["revision"], context["cold_rollback"]["revision"]},
    )
    retention_admission.pending_plan(owner.retention, context, service, revisions, plan)
    if (
        release.get("status") != "pending_activation"
        or release["final"]["backend_revision"] != candidate["revision"]
    ):
        raise owner.retention.UnsafeState("pending activation serving context changed")


def backend_identity(owner, identity) -> None:
    service = owner.retention.service_state(
        "consent-protocol", "hushh-pda", owner.REGION
    )
    matches = [
        row
        for row in owner.retention.revision_state(
            "consent-protocol", "hushh-pda", owner.REGION
        )
        if row.get("metadata", {}).get("name") == identity["revision"]
    ]
    if (
        service.get("metadata", {}).get("uid") != identity["service_uid"]
        or len(matches) != 1
        or matches[0].get("metadata", {}).get("uid") != identity["uid"]
    ):
        raise owner.retention.UnsafeState(
            "activation continuation backend identity changed"
        )


def serving(owner, state) -> set[str] | None:
    if not any(
        row.get("type") == "Ready" and row.get("status") == "True"
        for row in state.get("status", {}).get("conditions", [])
    ):
        return None
    return {
        name for name, percent, _ in owner.retention.traffic_state(state) if percent
    }


def protection(
    owner,
    service,
    lane,
    release,
    *,
    environment="uat",
    phone_anchor=None,
    operational_anchor=None,
):
    if operational_anchor is None or lane != "backend":
        return retention_admission.legacy_protection(
            owner,
            service,
            lane,
            release,
            environment=environment,
            phone_anchor=phone_anchor,
        )
    if environment != "production" or service != "consent-protocol":
        raise owner.retention.UnsafeState(
            "operational backend context is outside production"
        )
    checked = active(
        owner,
        operational_anchor["origin"]["run_id"],
        operational_anchor["origin"]["run_attempt"],
    )
    if checked != operational_anchor:
        raise owner.retention.UnsafeState(
            "operational backend reference changed during cleanup"
        )
    return [
        release["final"]["backend_revision"],
        "--rollback-revision",
        checked["revision"],
        "--last-known-good-revision",
        checked["revision"],
    ]


def pending_flags(context: dict, directory: Path) -> list[str]:
    path = directory / "pending-retirement.json"
    raw = (json.dumps(context, sort_keys=True, indent=2) + "\n").encode()
    path.write_bytes(raw)
    return [
        "--qualified-pending-retirement",
        str(path),
        "--qualified-pending-retirement-sha256",
        hashlib.sha256(raw).hexdigest(),
    ]
