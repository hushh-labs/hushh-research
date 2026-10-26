# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Qualification-only cold phone checkpoints; never release or retirement authority."""

from __future__ import annotations

import argparse
import importlib
import json
import re
import subprocess
import tempfile
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import plan
from bootstrap_ports import (
    REPOSITORY,
    WORKFLOW,
    Ports,
    Runtime,
    _api,
    _attest,
    _authorities,
    _positive,
    _tagged,
    _without_tag,
    begin,
    controls,
    iam_fingerprint,
)
from bootstrap_ports import (
    retire_initial as release_initial,
)
from revision_qualification import PROJECT, REGION, qualify_revision

ROOT = Path(__file__).resolve().parents[2]
UPLOAD = "Upload cold phone qualification checkpoint"
PENDING = ["installed_schema", "retirement", "worker", "production_release"]
READINESS = {
    "runtime_image": "qualified",
    "installed_schema": "unverified",
    "consumer_boundary": "source_only",
    "anchor_retirement": "blocked",
}
Document = dict[str, Any]


def _identity(checkpoint: Document, *, leased: bool = False) -> None:
    origin = checkpoint.get("origin") or {}
    prepared = checkpoint.get("plan") or {}
    qualified = checkpoint.get("qualification") or {}
    if (
        type(checkpoint.get("schema_version")) is not int
        or checkpoint["schema_version"] != 1
        or checkpoint.get("kind") != "phone-cold-qualification"
        or checkpoint.get("status") != "qualified"
        or checkpoint.get("health_tag") != ("leased" if leased else "retired")
        or not re.fullmatch(r"[0-9a-f]{64}", str(checkpoint.get("controls", "")))
        or not re.fullmatch(r"[0-9a-f]{64}", str(checkpoint.get("iam", "")))
        or checkpoint.get("pending") != PENDING
        or checkpoint.get("readiness") != READINESS
        or checkpoint.get("project") != PROJECT
        or checkpoint.get("region") != REGION
        or not re.fullmatch(r"[1-9][0-9]*", str(origin.get("run_id", "")))
        or type(origin.get("run_attempt")) is not int
        or origin["run_attempt"] < 1
        or not re.fullmatch(r"[0-9a-f]{40}", str(origin.get("workflow_sha", "")))
        or prepared.get("mode") != "cold"
        or prepared.get("run_id") != origin["run_id"]
        or prepared.get("recovery_enabled") is not False
        or qualified.get("qualification") != "passed"
        or any(
            qualified.get(key) != value
            for key, value in {
                "run_id": origin["run_id"],
                "source": prepared.get("source"),
                "image": prepared.get("image"),
                "project": PROJECT,
                "region": REGION,
                "health": "passed",
            }.items()
        )
        or not checkpoint.get("service_uid")
        or not checkpoint.get("cold_uid")
    ):
        raise ValueError("phone_bootstrap_checkpoint_identity_invalid")


def _verify_plan(prepared: Document) -> Document:
    with tempfile.TemporaryDirectory(prefix="phone-bootstrap-verify-") as directory:
        folder = Path(directory)
        source, output = folder / "plan.json", folder / "qualified.json"
        source.write_text(json.dumps(prepared))
        return plan.verify(
            SimpleNamespace(
                plan=source,
                run_id=prepared["run_id"],
                primary_sha=prepared["primary_sha"],
                output=output,
                github_output=folder / "outputs",
            )
        )


def checkpoint(
    prepared: Document, before: Document, *, before_iam: Document, ports: Ports
) -> Document:
    owner = ports.lock_owner()
    qualified = _verify_plan(prepared)
    current, revision = ports.service(), ports.revision(qualified["revision"])
    if before.get("metadata", {}).get("uid") != current.get("metadata", {}).get(
        "uid"
    ) or _positive(before) != _positive(current):
        raise ValueError("phone_bootstrap_staging_changed_serving_traffic")
    result = {
        "schema_version": 1,
        "controls": controls(before),
        "iam": iam_fingerprint(before_iam),
        "health_tag": "leased",
        "kind": "phone-cold-qualification",
        "status": "qualified",
        "project": PROJECT,
        "region": REGION,
        "origin": {
            "run_id": str(owner["id"]),
            "run_attempt": owner["run_attempt"],
            "workflow_sha": owner["head_sha"],
        },
        "plan": prepared,
        "qualification": qualified,
        "service_uid": current["metadata"]["uid"],
        "cold_uid": revision["metadata"]["uid"],
        "serving": _positive(before),
        "pending": list(PENDING),
        "readiness": dict(READINESS),
    }
    _attest(current, result, ports)
    if not _tagged(
        current, f"phone-rollback-{prepared['run_id']}", qualified["revision"]
    ):
        raise ValueError("phone_bootstrap_checkpoint_tag_missing")
    _identity(result, leased=True)
    return result


def load_checkpoint(run_id: str, attempt: int) -> Document:
    """Accept only an exact governed upload, decoded by the existing archive owner."""
    if not re.fullmatch(r"[1-9][0-9]*", run_id) or attempt < 1:
        raise ValueError("phone_bootstrap_origin_invalid")
    authority = _authorities()
    run = _api(f"runs/{run_id}")
    if (
        run.get("run_attempt") != attempt
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("path") != WORKFLOW
        or not authority.governed_dispatch(run, REPOSITORY, "production")
    ):
        raise ValueError("phone_bootstrap_origin_unqualified")
    jobs = _api(f"runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    receipts = importlib.import_module("release_artifact_receipts")
    started, ended = receipts._upload_window(
        jobs,
        run,
        attempt,
        {"deploy_job": "Deploy Production Scope", "upload_step": UPLOAD},
        authority._github_timestamp,
    )
    inventory = _api(f"runs/{run_id}/artifacts?per_page=100")
    rows = inventory.get("artifacts", [])
    matches = [
        row
        for row in rows
        if row.get("name") == f"prod-phone-bootstrap-{run_id}-{attempt}"
    ]
    if (
        inventory.get("total_count") != len(rows)
        or len(matches) != 1
        or matches[0].get("expired") is not False
    ):
        raise ValueError("phone_bootstrap_artifact_ambiguous")
    created = receipts._artifact_created(matches[0], run, authority._github_timestamp)
    if not started - timedelta(seconds=5) <= created <= ended + timedelta(seconds=30):
        raise ValueError("phone_bootstrap_artifact_attempt_mismatch")
    with tempfile.TemporaryDirectory(prefix="phone-bootstrap-origin-") as directory:
        folder = Path(directory)
        receipts.download_replayed_artifact(
            REPOSITORY,
            matches[0],
            folder,
            "bootstrap.json",
            run_command=authority.retention.run_command,
            timeout=90,
        )
        result = json.loads((folder / "bootstrap.json").read_text())
    _identity(result)
    if (
        result["origin"]
        != {"run_id": run_id, "run_attempt": attempt, "workflow_sha": run["head_sha"]}
        or _api(f"runs/{run_id}") != run
    ):
        raise ValueError("phone_bootstrap_origin_changed")
    return result


def _settled_service(service: Document, checkpoint: Document) -> None:
    metadata, status = service.get("metadata") or {}, service.get("status") or {}
    if (
        metadata.get("uid") != checkpoint["service_uid"]
        or _positive(service) != checkpoint["serving"]
        or str(status.get("observedGeneration")) != str(metadata.get("generation"))
        or not any(
            row.get("type") == "Ready" and row.get("status") == "True"
            for row in status.get("conditions", [])
        )
    ):
        raise ValueError("phone_bootstrap_service_changed_or_unsettled")


def requalify(checkpoint: Document, *, lease_state: Path, ports: Ports) -> Document:
    """Temporary health routing under the canonical lock; no primary or retirement."""
    _identity(checkpoint)
    owner = ports.lock_owner()
    if lease_state.exists() or lease_state.is_symlink():
        raise ValueError("phone_bootstrap_prior_lease_requires_reconciliation")
    prepared, expected = checkpoint["plan"], checkpoint["qualification"]
    revision = ports.revision(expected["revision"])
    qualified = qualify_revision(
        revision,
        sha=prepared["source"],
        image=prepared["image"],
        run_id=prepared["run_id"],
    )
    if (
        qualified["revision"] != expected["revision"]
        or revision.get("metadata", {}).get("uid") != checkpoint["cold_uid"]
    ):
        raise ValueError("phone_bootstrap_retained_revision_changed")
    before = ports.service()
    _settled_service(before, checkpoint)
    _attest(before, checkpoint, ports)
    tag = f"phone-rollback-{prepared['run_id']}"
    created = not _tagged(before, tag, expected["revision"])
    if not created:
        raise ValueError("phone_bootstrap_prior_health_route_requires_reconciliation")
    retention = _authorities().retention
    if created:
        retention.atomic_state(
            lease_state,
            {
                "origin": checkpoint["origin"],
                "revision": expected["revision"],
                "service_uid": checkpoint["service_uid"],
                "tag": tag,
                "before": retention.traffic_fingerprint(before),
                "lease_owner": {
                    "run_id": str(owner["id"]),
                    "run_attempt": owner["run_attempt"],
                },
                "pending_mutation": "add_tag",
            },
        )
    uncertain = False
    try:
        if created:
            try:
                ports.mutation(f"--update-tags={tag}={expected['revision']}")
            except Exception as exc:
                uncertain = True
                raise retention.MutationUncertain(
                    "Phone health-tag creation requires reconciliation"
                ) from exc
        current = ports.service()
        _settled_service(current, checkpoint)
        _attest(current, checkpoint, ports)
        if not _tagged(current, tag, expected["revision"]) or _without_tag(
            current, tag
        ) != _without_tag(before, tag):
            raise ValueError("phone_bootstrap_health_lease_changed_traffic")
        checked = _verify_plan(prepared)
        if any(
            checked.get(key) != expected.get(key)
            for key in ("revision", "source", "image", "run_id")
        ):
            raise ValueError("phone_bootstrap_altered_successor_refused")
        return checked
    finally:
        if created:
            _release_lease(checkpoint, before, tag, lease_state, ports, uncertain)


def _release_lease(
    checkpoint: Document,
    before: Document,
    tag: str,
    state: Path,
    ports: Ports,
    uncertain: bool,
) -> None:
    retention = _authorities().retention
    current = ports.service()
    _settled_service(current, checkpoint)
    if _tagged(current, tag, checkpoint["qualification"]["revision"]):
        intent = json.loads(state.read_text())
        intent["pending_mutation"] = "remove_tag"
        retention.atomic_state(state, intent)
        try:
            ports.mutation(f"--remove-tags={tag}")
        except Exception as exc:
            raise retention.MutationUncertain(
                "Phone health-tag removal requires reconciliation"
            ) from exc
    after = ports.service()
    _settled_service(after, checkpoint)
    _attest(after, checkpoint, ports)
    if (
        uncertain
        or _tagged(after, tag, checkpoint["qualification"]["revision"])
        or _without_tag(after, tag) != _without_tag(before, tag)
    ):
        raise retention.MutationUncertain(
            "Phone health-tag outcome requires reconciliation"
        )
    state.unlink()


def retire_initial(
    *, state: Path, checkpoint_path: Path, completed: bool, ports: Ports
) -> Document:
    intent = release_initial(state=state, completed=completed, ports=ports)
    if checkpoint_path.exists():
        result = json.loads(checkpoint_path.read_text())
        _identity(result, leased=True)
        if (
            any(
                result[key] != intent[key]
                for key in ("service_uid", "serving", "controls", "iam")
            )
            or any(
                result["origin"][key] != intent["origin"][key]
                for key in ("run_id", "run_attempt")
            )
            or result["plan"]["source"] != intent["source"]
            or result["plan"]["image"] != intent["image"]
            or result["qualification"]["revision"] != intent["revision"]
        ):
            raise ValueError("phone_bootstrap_checkpoint_controls_mismatch")
        result["health_tag"] = "retired"
        _identity(result)
        _authorities().retention.atomic_state(checkpoint_path, result)
    return intent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("begin", "checkpoint", "cleanup", "resume"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--before", type=Path)
    parser.add_argument("--before-iam", type=Path)
    parser.add_argument("--completed", choices=("true", "false"), default="false")
    parser.add_argument("--origin-run-id")
    parser.add_argument("--origin-attempt", type=int)
    parser.add_argument("--lease-state", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "begin":
            result = begin(
                json.loads(args.plan.read_text()),
                json.loads(args.before.read_text()),
                json.loads(args.before_iam.read_text()),
                state=args.lease_state,
                ports=Runtime(),
            )
        elif args.command == "cleanup":
            result = retire_initial(
                state=args.lease_state,
                checkpoint_path=args.output,
                completed=args.completed == "true",
                ports=Runtime(),
            )
            return 0
        elif args.command == "checkpoint":
            result = checkpoint(
                json.loads(args.plan.read_text()),
                json.loads(args.before.read_text()),
                before_iam=json.loads(args.before_iam.read_text()),
                ports=Runtime(),
            )
        else:
            if (
                not args.origin_run_id
                or not args.origin_attempt
                or not args.lease_state
            ):
                raise ValueError("phone_bootstrap_resume_inputs_missing")
            checked = load_checkpoint(args.origin_run_id, args.origin_attempt)
            result = {
                "kind": "phone-cold-requalification",
                "qualification": requalify(
                    checked, lease_state=args.lease_state, ports=Runtime()
                ),
                "origin": checked["origin"],
                "pending": PENDING,
            }
        _authorities().retention.atomic_state(args.output, result)
    except (
        ValueError,
        TypeError,
        KeyError,
        AttributeError,
        OSError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as exc:
        print(f"Phone cold qualification refused: {type(exc).__name__}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
