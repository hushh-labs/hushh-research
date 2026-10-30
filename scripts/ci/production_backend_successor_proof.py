"""Join existing cold reader, installed schema and protected-reader evidence.

The resulting reference can protect a rollback backend. It never marks the
candidate healthy, activates producers, or declares request drainage complete.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import re
import sys
from pathlib import Path

import production_backend_successor as reference
import production_phone_lease_receipts as leases
import production_phone_receipt as phone
import release_artifact_receipts as receipts

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = ".github/workflows/deploy-production.yml"
UPLOAD = "Publish operational backend proof"
STEPS = (
    "Validate deployment SHA against main",
    "Deploy backend using Cloud Build",
    "Revalidate actual phone rollback after backend deployment attempt",
    "Retire initial cold health-tag lease",
    "Qualify final cold installed-schema proof",
    "Seal operational backend proof",
    UPLOAD,
)


def digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def bootstrap_owner():
    directory = str(ROOT / "deploy/phone")
    if directory not in sys.path:
        sys.path.insert(0, directory)
    return importlib.import_module("bootstrap")


def qualify(bundle: dict) -> dict:
    reference.require(
        bundle.get("schema_version") == 1
        and type(bundle["schema_version"]) is int
        and bundle.get("kind") == "phone-operational-backend-proof",
        "operational_backend_proof_invalid",
    )
    checkpoint, schema = bundle["checkpoint"], bundle["installed_schema"]
    reference.require(
        isinstance(bundle.get("primary_image"), str)
        and bool(
            reference.HEX64.fullmatch(
                bundle["primary_image"].removeprefix(
                    "gcr.io/hushh-pda/consent-protocol@sha256:"
                )
            )
        )
        and bundle["primary_image"].startswith(
            "gcr.io/hushh-pda/consent-protocol@sha256:"
        ),
        "operational_backend_primary_image_invalid",
    )
    bootstrap_owner()._identity(checkpoint)
    prepared, qualified = checkpoint["plan"], checkpoint["qualification"]
    origin = checkpoint["origin"]
    anchor = phone.qualified_reader(
        qualified, prepared, prepared["primary_sha"], {"id": int(origin["run_id"])}
    )
    reference.require(
        qualified.get("recovery") is False
        and qualified.get("sso") is False
        and qualified.get("health") == "passed"
        and prepared["source"] != prepared["primary_sha"]
        and schema.get("schema_version") == 1
        and type(schema["schema_version"]) is int
        and schema.get("kind") == "phone-installed-schema-proof"
        and schema.get("qualification") == "passed"
        and schema.get("project") == "hushh-pda"
        and schema.get("region") == "us-central1"
        and schema.get("origin") == {**origin, "workflow": WORKFLOW}
        and schema.get("runtime_checkpoint") == digest(checkpoint)
        and schema.get("dimensions")
        == {"installed_schema": "passed", "producer_closure": "passed"}
        and schema.get("advance_anchor") is False
        and schema.get("healthy_release") is False
        and schema.get("workos", {}).get("qualification") == "passed"
        and schema.get("producer_submissions", {}).get("qualification") == "passed"
        and all(
            schema.get("database", {}).get(key) is True
            for key in (
                "installed",
                "relations_empty",
                "phone_unlink_empty",
                "owned_proxy_exited",
            )
        ),
        "operational_backend_schema_not_joined",
    )
    _schema_runtime(checkpoint, schema, anchor)
    phone.qualified_documents(
        bundle["document_mode"],
        bundle.get("document_report"),
        anchor,
        prepared["primary_sha"],
    )
    original, serving = _healthy_reference(bundle, schema)
    return {
        **anchor,
        "uid": checkpoint["cold_uid"],
        "origin": origin,
        "original_healthy": original,
        "serving_reference": serving,
        "sealed_boundary": bundle,
        "runtime": {key: checkpoint[key] for key in ("service_uid", "controls", "iam")}
        | {
            "initial_traffic": schema["snapshot"]["services"]["consent-protocol"][
                "traffic"
            ]
        },
    }


def _schema_runtime(checkpoint: dict, schema: dict, anchor: dict) -> None:
    revision = schema["snapshot"]["revisions"].get(anchor["revision"], {})
    service = schema["snapshot"].get("services", {}).get("consent-protocol", {})
    reference.require(
        all(
            isinstance(checkpoint.get(key), str) and 0 < len(checkpoint[key]) <= 256
            for key in ("service_uid", "cold_uid")
        )
        and revision.get("uid") == checkpoint["cold_uid"]
        and revision.get("source") == anchor["source"]
        and revision.get("image") == anchor["image"]
        and all(
            service.get(actual) == checkpoint[expected]
            for actual, expected in (
                ("uid", "service_uid"),
                ("controls", "controls"),
                ("iam", "iam"),
            )
        )
        and checkpoint.get("serving") == [[schema["reference"]["revision"], 100]],
        "operational_backend_schema_revision_changed",
    )


def _healthy_reference(bundle: dict, schema: dict) -> tuple[dict, dict]:
    original = bundle["original_healthy"]
    reference.require(
        reference.tag_identity(original.get("tag_object")) == original,
        "operational_backend_original_tag_binding_invalid",
    )
    healthy, successor = reference.split(original["message"], original["commit"])
    # Initial admission cannot silently replace a previous operational lease.
    reference.require(
        successor is None and bool(reference.HEX40.fullmatch(original["tag_oid"])),
        "operational_backend_original_reference_invalid",
    )
    serving = schema["reference"]
    fields = reference.healthy_fields(healthy, original["commit"])
    reference.require(
        serving.get("source") == original["commit"]
        and serving.get("revision") == fields["backend_revision"]
        and fields["run"]
        == f"https://github.com/{REPOSITORY}/actions/runs/{serving.get('run_id')}"
        and bool(reference.HEX64.fullmatch(str(serving.get("digest", "")))),
        "operational_backend_healthy_reference_changed",
    )
    return original, serving


def read_original() -> dict:
    oid = reference.remote_oid()
    local = "refs/codex/phone-operational-healthy"
    reference.git(["fetch", "--no-tags", "origin", f"{reference.REF}:{local}"])
    reference.require(
        reference.git(["rev-parse", local]).strip() == oid
        and reference.remote_oid() == oid,
        "operational_backend_original_tag_changed",
    )
    reference.require(
        reference.git(["cat-file", "-t", oid]).strip() == "tag",
        "operational_backend_original_tag_not_annotated",
    )
    result = reference.tag_identity(reference.git(["cat-file", "tag", oid]))
    reference.require(
        result["tag_oid"] == oid, "operational_backend_original_tag_binding_invalid"
    )
    return result


def load(
    run_id: str, attempt: int, *, api, governed, timestamp, run_command, timeout
) -> dict:
    reference.require(
        isinstance(run_id, str)
        and bool(re.fullmatch(r"[1-9][0-9]*", run_id))
        and type(attempt) is int
        and attempt > 0,
        "operational_backend_upload_origin_invalid",
    )
    run = api(REPOSITORY, f"runs/{run_id}")
    reference.require(
        isinstance(run_id, str)
        and bool(re.fullmatch(r"[1-9][0-9]*", run_id))
        and type(attempt) is int
        and attempt > 0
        and run.get("id") == int(run_id)
        and run.get("run_attempt") == attempt
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and run.get("path") == WORKFLOW
        and governed(run, REPOSITORY, "production"),
        "operational_backend_upload_origin_invalid",
    )
    jobs = api(REPOSITORY, f"runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    selected = [
        row
        for row in jobs.get("jobs", [])
        if row.get("name") == "Deploy Production Scope"
    ]
    reference.require(
        len(selected) == 1 and selected[0].get("conclusion") == "success",
        "operational_backend_upload_job_ambiguous",
    )
    steps = selected[0].get("steps") or []
    by_name = {step.get("name"): step for step in steps}
    reference.require(
        len(by_name) == len(steps)
        and all(
            by_name.get(name, {}).get("status") == "completed"
            and by_name[name].get("conclusion") == "success"
            for name in STEPS
        ),
        "operational_backend_upload_gates_incomplete",
    )
    artifact = leases.artifact(
        REPOSITORY,
        run,
        jobs,
        api,
        timestamp,
        job="Deploy Production Scope",
        upload=UPLOAD,
        name=f"prod-phone-operational-{run_id}-{attempt}",
    )
    archive = receipts.immutable_archive(
        REPOSITORY, artifact, run_command=run_command, timeout=timeout
    )
    bundle = phone._document(archive, "operational-backend.json")
    anchor = qualify(bundle)
    refreshed = api(REPOSITORY, f"runs/{run_id}")
    reference.require(
        anchor["origin"]
        == {"run_id": run_id, "run_attempt": attempt, "workflow_sha": run["head_sha"]}
        and all(
            refreshed.get(key) == run.get(key)
            for key in ("id", "run_attempt", "head_sha", "status", "conclusion")
        ),
        "operational_backend_upload_attempt_changed",
    )
    anchor["origin"] = {
        **anchor["origin"],
        "artifact_id": artifact["id"],
        "artifact_digest": artifact["digest"],
    }
    return anchor


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("checkpoint", "installed-schema", "document-mode", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--document-report", type=Path)
    parser.add_argument("--primary-image", required=True)
    args = parser.parse_args()
    args.output.write_text('{"qualification":"refused"}\n')
    bundle = {
        "schema_version": 1,
        "kind": "phone-operational-backend-proof",
        "primary_image": args.primary_image,
        "checkpoint": json.loads(args.checkpoint.read_text()),
        "installed_schema": json.loads(args.installed_schema.read_text()),
        "document_mode": json.loads(args.document_mode.read_text()),
        "document_report": json.loads(args.document_report.read_text())
        if args.document_report
        else None,
        "original_healthy": read_original(),
    }
    qualify(bundle)
    args.output.write_text(json.dumps(bundle, indent=2) + "\n")


if __name__ == "__main__":
    main()
