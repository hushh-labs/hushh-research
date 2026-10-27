"""Governed operational-backend reference admission and resolution.

Preparation is read-only. Apply requires the canonical production lock and the
exact intent uploaded by this maintenance attempt's completed selection job.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
from pathlib import Path

import production_backend_successor as reference
import production_backend_successor_proof as proof
import production_phone_lease_receipts as leases
import production_phone_receipt as phone
import production_activation_continuation as continuation
import release_artifact_receipts as receipts

MAINTENANCE_WORKFLOW = ".github/workflows/capacity-maintenance.yml"
INTENT_UPLOAD = "Publish operational reference intent"


def authority():
    return importlib.import_module("uat-retention-maintenance")


def load_anchor(run_id: str, attempt: int) -> dict:
    owner = authority()
    return proof.load(
        run_id,
        attempt,
        api=owner.api,
        governed=owner.governed_dispatch,
        timestamp=owner._github_timestamp,
        run_command=owner.retention.run_command,
        timeout=60,
    )


def live(anchor: dict, *, initial: bool = False) -> None:
    owner = proof.bootstrap_owner()
    ports = owner.Runtime()
    service, revision = ports.service(), ports.revision(anchor["revision"])
    qualified = owner.qualify_revision(
        revision,
        sha=anchor["source"],
        image=anchor["image"],
        run_id=anchor["origin"]["run_id"],
    )
    runtime = anchor["runtime"]
    reference.require(
        qualified["revision"] == anchor["revision"]
        and revision.get("metadata", {}).get("uid") == anchor["uid"]
        and service.get("metadata", {}).get("uid") == runtime["service_uid"]
        and str(service.get("status", {}).get("observedGeneration"))
        == str(service["metadata"].get("generation"))
        and any(
            row.get("type") == "Ready" and row.get("status") == "True"
            for row in service.get("status", {}).get("conditions", [])
        )
        and owner.controls(service) == runtime["controls"]
        and owner.iam_fingerprint(ports.iam()) == runtime["iam"],
        "operational_backend_live_identity_changed",
    )
    if initial:
        revalidate_initial(anchor)
        reference.require(
            owner._positive(service) == [[anchor["serving_reference"]["revision"], 100]]
            and proof.digest(
                [
                    service.get("spec", {}).get("traffic"),
                    service.get("status", {}).get("traffic"),
                ]
            )
            == runtime["initial_traffic"],
            "operational_backend_initial_traffic_changed",
        )


def revalidate_initial(anchor: dict) -> None:
    """Reuse existing read owners; this phase executes no DDL or producer."""
    bootstrap = proof.bootstrap_owner()
    schemas = importlib.import_module("schema_qualification")
    producers = importlib.import_module("schema_producers")
    bundle = anchor["sealed_boundary"]
    checkpoint, archived = bundle["checkpoint"], bundle["installed_schema"]
    ports = producers.Runtime(checkpoint["plan"], bundle["primary_image"])
    before = ports.snapshot()
    schemas._submissions(ports, before)
    database = ports.database(True)
    workos = ports.workos()
    raw = bootstrap.plan.qualify_image.run(
        [
            "python3",
            str(proof.ROOT / "deploy/drive/resolve_protected_document_release.py"),
            "--project=hushh-pda",
            "--environment=production",
        ],
        timeout=120,
    )
    mode = json.loads(raw)
    after = ports.snapshot()
    reference.require(
        database == archived["database"]
        and schemas._stable(before)
        == schemas._stable(after)
        == schemas._stable(archived["snapshot"])
        and workos.get("qualification") == "passed"
        and mode == bundle["document_mode"],
        "operational_backend_initial_boundary_changed",
    )


def record_anchor(current: dict) -> dict | None:
    healthy, record = reference.split(current["message"], current["commit"])
    if record is None:
        return None
    anchor = load_anchor(record["origin"]["run_id"], record["origin"]["run_attempt"])
    original = anchor["original_healthy"]
    reference.require(
        current["commit"] == original["commit"]
        and healthy == original["message"]
        and record["previous_tag_oid"] == original["tag_oid"]
        and record["origin"] == anchor["origin"]
        and all(
            record[key] == anchor[key] for key in ("revision", "source", "image", "uid")
        ),
        "operational_backend_reference_not_bound",
    )
    return anchor


def resolve() -> str:
    current = proof.read_original()
    anchor = record_anchor(current)
    if anchor is not None:
        live(anchor)
        return anchor["revision"]
    healthy, _ = reference.split(current["message"], current["commit"])
    return reference.healthy_fields(healthy, current["commit"])["backend_revision"]


def _continuation_source(current: dict) -> str | None:
    """Keep the exact activation basis until a standard backend release owns it."""
    healthy, _ = reference.split(current["message"], current["commit"])
    fields = reference.healthy_fields(healthy, current["commit"])
    match = re.fullmatch(
        rf"https://github\.com/{re.escape(proof.REPOSITORY)}/actions/runs/([1-9][0-9]*)",
        fields["run"],
    )
    reference.require(match is not None, "activation_basis_healthy_origin_invalid")
    owner = authority()
    run = owner.api(proof.REPOSITORY, f"runs/{match[1]}?exclude_pull_requests=true")
    lane = owner.LANES["production"]
    arguments = {
        "api": owner.api,
        "governed": owner.governed_dispatch,
        "timestamp": owner._github_timestamp,
        "run_command": owner.retention.run_command,
        "timeout": 60,
    }
    artifact, _job = receipts.current_attempt_artifact(
        proof.REPOSITORY, run, lane, api=owner.api, timestamp=owner._github_timestamp
    )
    archive = receipts.immutable_archive(
        proof.REPOSITORY, artifact, run_command=arguments["run_command"], timeout=60
    )
    release = phone._document(archive, "prod-release-status.json")
    reference.require(
        run.get("id") == int(match[1])
        and run.get("status") == "completed"
        and owner.governed_dispatch(run, proof.REPOSITORY, "production")
        and release.get("status") == "healthy"
        and release.get("sha") == current["commit"]
        and all(
            release.get("final", {}).get(f"{name}_revision")
            == fields[f"{name}_revision"]
            for name in ("backend", "frontend")
        ),
        "activation_basis_healthy_reference_changed",
    )
    context = continuation.archive_context(
        proof.REPOSITORY, run, release, lane, **arguments
    )
    reference.require(proof.read_original() == current, "activation_basis_tag_changed")
    if context is None:
        if run.get("conclusion") == "failure":
            owner.verify_post_release_failure(proof.REPOSITORY, run, release)
        else:
            reference.require(
                run.get("conclusion") == "success", "activation_basis_release_failed"
            )
        return None
    plan = phone._document(archive, "phone-rollback/plan.json")
    reference.require(
        plan.get("recovery_enabled") is False
        and context["backend"]["source"] == current["commit"],
        "activation_basis_producer_state_invalid",
    )
    return context["backend"]["source"]


def admit(sha: str, scope: str) -> None:
    current = proof.read_original()
    anchor = record_anchor(current)
    source = (
        anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"]
        if anchor is not None
        else _continuation_source(current)
    )
    if source is not None:
        reference.require(
            scope in {"backend", "all"} and sha == source,
            "operational_backend_transition_requires_original_source",
        )


def _confirmed_activation(
    anchor: dict, sha: str, revision: str, activation: Path
) -> None:
    evidence = json.loads(activation.read_text())
    reference.require(
        sha == anchor["sealed_boundary"]["checkpoint"]["plan"]["primary_sha"]
        and evidence.get("candidate_revision") == revision,
        "operational_backend_healthy_activation_unconfirmed",
    )
    origin_path = activation.with_name(continuation.ORIGIN)
    if origin_path.exists():
        origin = json.loads(origin_path.read_text())
        owner = authority()
        original = continuation.load_original(
            origin["original"]["run_id"],
            sha,
            repository=proof.REPOSITORY,
            operational_anchor=anchor,
            api=owner.api,
            governed=owner.governed_dispatch,
            timestamp=owner._github_timestamp,
            run_command=owner.retention.run_command,
            timeout=60,
        )
        reference.require(
            origin == original, "operational_backend_activation_origin_changed"
        )
        continuation.validate_activated(origin, evidence, sha)
        return
    retirement = evidence.get("retirement") or {}
    key = continuation._floor_key()
    reference.require(
        evidence.get("status") == "activated"
        and evidence.get("project") == "hushh-pda"
        and evidence.get("sha") == sha
        and evidence.get("run_id") == os.environ["GITHUB_RUN_ID"]
        and retirement.get("status") == "retired"
        and retirement.get("phone_admission_floor_required") is True
        and type(retirement.get(key)) is int
        and retirement[key] == 0,
        "operational_backend_healthy_activation_unconfirmed",
    )


def healthy(sha: str, revision: str, activation: Path) -> str:
    current = proof.read_original()
    anchor = record_anchor(current)
    if anchor is not None:
        _confirmed_activation(anchor, sha, revision, activation)
    return current["tag_oid"]


def prepare(run_id: str, attempt: int, output: Path) -> dict:
    anchor, current = load_anchor(run_id, attempt), proof.read_original()
    if current == anchor["original_healthy"]:
        message = reference.annotate(
            current["message"], current["commit"], current["tag_oid"], anchor
        )
        new_oid = reference.tag_object(current["commit"], message)
    else:
        reference.require(
            record_anchor(current) == anchor,
            "operational_backend_original_reference_changed",
        )
        # Already published: preserve that exact object; no renewed lease or tag.
        new_oid = current["tag_oid"]
    intent = {
        "schema_version": 1,
        "kind": "phone-operational-reference-intent",
        "old_oid": anchor["original_healthy"]["tag_oid"],
        "new_oid": new_oid,
        "new_object": reference.git(["cat-file", "tag", new_oid]),
        "origin": anchor["origin"],
        "publisher": {
            "run_id": os.environ["GITHUB_RUN_ID"],
            "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
            "workflow_sha": os.environ["GITHUB_SHA"],
        },
    }
    with output.open("x") as stream:
        stream.write(json.dumps(intent, sort_keys=True, indent=2) + "\n")
    return intent


def published_intent(owner: dict) -> dict:
    runtime = authority()
    reference.require(
        owner.get("path") == MAINTENANCE_WORKFLOW,
        "operational_backend_publication_workflow_invalid",
    )
    jobs = runtime.api(
        proof.REPOSITORY,
        f"runs/{owner['id']}/attempts/{owner['run_attempt']}/jobs?per_page=100",
    )
    selection = [
        job
        for job in jobs.get("jobs", [])
        if job.get("name") == "Verify due cleanup without cloud credentials"
    ]
    reference.require(
        len(selection) == 1 and selection[0].get("conclusion") == "success",
        "operational_backend_selection_not_successful",
    )
    selected = leases.artifact(
        proof.REPOSITORY,
        owner,
        jobs,
        runtime.api,
        runtime._github_timestamp,
        job="Verify due cleanup without cloud credentials",
        upload=INTENT_UPLOAD,
        name=f"prod-operational-reference-intent-{owner['id']}-{owner['run_attempt']}",
    )
    archive = receipts.immutable_archive(
        proof.REPOSITORY,
        selected,
        run_command=runtime.retention.run_command,
        timeout=60,
    )
    intent = phone._document(archive, "operational-reference-intent.json")
    reference.require(
        intent.get("schema_version") == 1
        and type(intent["schema_version"]) is int
        and intent.get("kind") == "phone-operational-reference-intent"
        and intent.get("publisher")
        == {
            "run_id": str(owner["id"]),
            "run_attempt": owner["run_attempt"],
            "workflow_sha": owner["head_sha"],
        },
        "operational_backend_publication_origin_invalid",
    )
    return intent


def apply() -> dict:
    ports = proof.bootstrap_owner().Runtime()
    owner = ports.lock_owner()
    intent = published_intent(owner)
    identity = reference.tag_identity(intent["new_object"])
    anchor = record_anchor(identity)
    reference.require(
        anchor is not None
        and identity["tag_oid"] == intent["new_oid"]
        and anchor["origin"] == intent["origin"]
        and anchor["original_healthy"]["tag_oid"] == intent["old_oid"],
        "operational_backend_intent_changed",
    )
    current = proof.read_original()
    if current == identity:
        live(anchor)
        return {
            "status": "confirmed",
            "revision": anchor["revision"],
            "replayed": False,
        }
    reference.require(
        current == anchor["original_healthy"], "operational_backend_reference_changed"
    )
    live(anchor, initial=True)
    actual = reference.git(["mktag"], content=intent["new_object"]).strip()
    reference.require(
        actual == intent["new_oid"] and ports.lock_owner() == owner,
        "operational_backend_admission_changed",
    )
    outcome = reference.compare_and_swap(intent["old_oid"], intent["new_oid"])
    return {"status": outcome, "revision": anchor["revision"], "replayed": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "phase", choices=("prepare", "apply", "resolve", "admit", "healthy")
    )
    parser.add_argument("--run-id")
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sha")
    parser.add_argument("--scope")
    parser.add_argument("--revision")
    parser.add_argument("--activation", type=Path)
    args = parser.parse_args()
    if args.phase == "resolve":
        print(resolve())
    elif args.phase == "admit":
        admit(args.sha, args.scope)
    elif args.phase == "healthy":
        print(healthy(args.sha, args.revision, args.activation))
    elif args.phase == "prepare":
        reference.require(
            args.output is not None, "operational_backend_intent_output_required"
        )
        prepare(args.run_id, args.attempt, args.output)
    else:
        result = apply()
        if args.output is not None:
            args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
