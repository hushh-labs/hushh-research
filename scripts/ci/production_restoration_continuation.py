"""Hosted completion of one recorded restoration; never a new deployment."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
from runpy import run_path
import subprocess

import production_restoration_receipt as owner
import release_acceptance_provenance as provenance

ORIGIN = "prod-restoration-activation-origin.json"
REPOSITORY = "hushh-labs/hushh-research"
ACTIVATION = "Activate tombstone-aware account deletion"
TERMINAL = "Fail workflow when production release did not end healthy"
FRESH_STEPS = (
    "Require exact recorded restoration continuation",
    "Verify unchanged restoration serving pair",
    "Verify restoration schema and original document barrier",
    "Verify restoration WorkOS remains closed",
    "Resolve retained document restoration mode",
    "Verify production candidate runtime env parity",
    "Verify production Connected Systems Omni Gateway",
    "Verify production backend deployment provenance",
    "Verify production frontend deployment provenance",
    "Post-deploy backend runtime health gate",
    "Post-deploy frontend runtime health gate",
    "Verify production account-session contract",
    "Verify production native passkey domain associations",
    ACTIVATION,
    "Verify restoration completion and unchanged serving pair",
    "Write production release status artifact",
    "Tag this release as last known good",
)
FORBIDDEN = (
    "Deploy backend using Cloud Build", "Deploy frontend using Cloud Build",
    "Promote deployed revisions to production traffic",
    "Install fail-closed account deletion release fence",
    "Apply production DB migrations behind account deletion fence",
    "Deploy and attest private production Drive worker",
)


def require(value, reason):
    owner._require(value, "continuation: " + reason)


def ports():
    maintenance = importlib.import_module("uat-retention-maintenance")
    return {
        "api": maintenance.api, "governed": maintenance.governed_dispatch,
        "timestamp": maintenance._github_timestamp,
        "run_command": maintenance.retention.run_command, "timeout": 60,
    }


def manual(run):
    policy = json.loads((owner.ROOT / "config/ci-governance.json").read_text())
    allowed = policy["production"]["manual_dispatch_users"]
    require(
        run.get("path") == ".github/workflows/deploy-production.yml"
        and run.get("head_branch") == "main" and run.get("event") == "workflow_dispatch"
        and all((run.get(key) or {}).get("full_name") == REPOSITORY
                for key in ("repository", "head_repository"))
        and re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", "")))
        and all((run.get(key) or {}).get("login") in allowed
                for key in ("actor", "triggering_actor")),
        "both dispatch actors must be governed humans",
    )
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", run["head_sha"], "origin/main"],
        capture_output=True, timeout=30, check=False,
    )
    require(result.returncode == 0, "workflow head is not on Main")


def fresh_run(arguments, run_id):
    maintenance = importlib.import_module("uat-retention-maintenance")
    token = maintenance._API_CACHE.set(None)
    try:
        return arguments["api"](REPOSITORY, f"runs/{run_id}")
    finally:
        maintenance._API_CACHE.reset(token)


def active_run(maintenance):
    arguments = ports()
    current = fresh_run(arguments, os.environ["GITHUB_RUN_ID"])
    require(current.get("id") == int(os.environ["GITHUB_RUN_ID"])
            and current.get("status") == "in_progress"
            and current.get("head_sha") == os.environ["GITHUB_SHA"]
            and current.get("run_attempt") == int(os.environ["GITHUB_RUN_ATTEMPT"])
            and os.environ.get("GITHUB_JOB") == "complete-restoration-activation",
            "verifier identity or job changed")
    jobs = maintenance.api(REPOSITORY, f"runs/{current['id']}/attempts/{current['run_attempt']}/jobs?per_page=100")
    matches = [job for job in jobs.get("jobs", []) if job.get("status") == "in_progress"
               and job.get("name") == "Deploy Production Scope"
               and job.get("run_id") == current["id"] and job.get("run_attempt") == current["run_attempt"]
               and job.get("head_sha") == current["head_sha"] and job.get("head_branch") == "main"]
    require(jobs.get("total_count") == len(jobs.get("jobs", [])) and len(matches) == 1,
            "canonical active verification job is unproved")
    manual(current)
    return current


def archive(run, arguments):
    lane = importlib.import_module("uat-retention-maintenance").LANES["production"]
    artifact, job = owner.receipts.current_attempt_artifact(
        REPOSITORY, run, lane, api=arguments["api"], timestamp=arguments["timestamp"]
    )
    content = owner.receipts.immutable_archive(
        REPOSITORY, artifact, run_command=arguments["run_command"],
        timeout=arguments["timeout"],
    )
    return artifact, job, content, lane


def original_gates(run, job):
    steps = job.get("steps") or []
    indexed = {step.get("name"): step for step in steps}
    require(
        job.get("conclusion") == "failure" and len(indexed) == len(steps)
        and {step.get("name") for step in steps if step.get("conclusion") == "failure"}
        == {ACTIVATION, TERMINAL}
        and all(indexed.get(name, {}).get("conclusion") == "success"
                and indexed[name].get("status") == "completed"
                for name in set(owner.STEPS) - {ACTIVATION})
        # The original pinned workflow used an always-run status guard, so its
        # unhealthy no-op can be successful. Prepare independently requires the
        # unchanged pre-restoration healthy tag before granting continuation.
        and indexed.get("Tag this release as last known good", {}).get("status") == "completed"
        and indexed["Tag this release as last known good"].get("conclusion") in {"skipped", "success"}
        and run.get("conclusion") == "failure",
        "original failure is not isolated to activation",
    )


def original_images(content, sha):
    images = {}
    for lane, service in (("backend", "consent-protocol"), ("frontend", "hushh-webapp")):
        report = owner.phone._document(content, f"prod-{lane}-image.json")
        image = report.get("image_reference", "")
        require(report.get("sha") == sha and re.fullmatch(
            rf"gcr\.io/hushh-pda/{service}@sha256:[0-9a-f]{{64}}", image
        ), "original immutable image is not bound to source")
        images[lane] = image
    return images


def validation_receipt(run_id, sha):
    validation = run_path(str(owner.ROOT / "deploy/account-deletion/restoration_validation.py"))
    return validation["verify"](run_id, sha)


def load_original(run_id, attempt, sha, **arguments):
    require(re.fullmatch(r"[1-9][0-9]*", str(run_id)) and type(attempt) is int
            and attempt > 0, "exact original run and attempt required")
    run = fresh_run(arguments, run_id)
    require(run.get("id") == int(run_id) and run.get("run_attempt") == attempt
            and run.get("status") == "completed", "original attempt changed")
    require(arguments["governed"](run, REPOSITORY, "production"), "original completed dispatch is not governed")
    manual(run)
    artifact, job, content, lane = archive(run, arguments)
    release = owner.phone._document(content, "prod-release-status.json")
    record, digest = owner.source_record(sha)
    require(release.get("status") == "blocked" and release.get("scope") == "all"
            and release.get("sha") == sha, "original blocked restoration differs")
    original_gates(run, job)
    operation = owner._operation(REPOSITORY, run, job, lane,
                                 api=arguments["api"], timestamp=arguments["timestamp"])
    operation_content = owner.receipts.immutable_archive(
        REPOSITORY, operation, run_command=arguments["run_command"], timeout=arguments["timeout"]
    )
    owner._plan(owner.phone._document(operation_content, "acceptance.json"), record, digest, run)
    owner._runtime(content, release, record, run)
    admission = release["production_restoration"]
    require(validation_receipt(admission["runId"], sha) == admission,
            "original hosted source validation changed")
    require(fresh_run(arguments, run_id) == run,
            "original changed during qualification")
    return {
        "run_id": int(run_id), "run_attempt": attempt, "workflow_sha": run["head_sha"],
        "artifact_id": artifact["id"], "artifact_digest": artifact["digest"],
        "operation_artifact_id": operation["id"], "operation_artifact_digest": operation["digest"],
        "source": sha, "record_sha256": digest, "validation": admission,
        "pair": {lane: release["final"][f"{lane}_revision"] for lane in ("backend", "frontend")},
        "images": original_images(content, sha),
        "previous": record["previousServices"],
    }


def runtime_pair(original, maintenance):
    result = {}
    for lane, service in (("backend", "consent-protocol"), ("frontend", "hushh-webapp")):
        state = maintenance.retention.service_state(service, "hushh-pda", "us-central1")
        rows = maintenance.retention.revision_state(service, "hushh-pda", "us-central1")
        desired, resolved = (traffic_view(state.get(view, {}).get("traffic"), service)
                             for view in ("spec", "status"))
        require(desired == resolved and desired[0] == {original["pair"][lane]: 100},
                "desired and resolved traffic or tags differ from original pair")
        selected = [r for r in rows if r.get("metadata", {}).get("name") == original["pair"][lane]]
        require(len(selected) == 1, "original revision is ambiguous")
        if lane == "backend":
            require_retirement_clear(state, rows, original["pair"][lane])
        result[lane] = runtime_identity(state, selected[0], service, original, lane)
    return result


def traffic_view(rows, service):
    """Cloud Run may coalesce tagged zero-percent aliases into the serving row."""
    require(isinstance(rows, list) and bool(rows), "explicit traffic inventory required")
    percentages, tags = {}, {}
    for row in rows:
        require(isinstance(row, dict), "invalid traffic target")
        revision, percent, tag = row.get("revisionName", ""), row.get("percent", 0), row.get("tag")
        require(re.fullmatch(rf"{service}-[a-z0-9-]+", revision)
                and type(percent) is int and 0 <= percent <= 100 and not row.get("latestRevision"),
                "traffic must name an explicit revision")
        if percent:
            percentages[revision] = percentages.get(revision, 0) + percent
        if tag is not None:
            require(isinstance(tag, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", tag)
                    and tag not in tags, "traffic tag is invalid or ambiguous")
            tags[tag] = revision
    return percentages, tags


def require_retirement_clear(state, revisions, candidate):
    """Refuse work; the existing lifecycle owner alone classifies compatibility."""
    lifecycle = run_path(str(owner.ROOT / "deploy/account-deletion/activate_release.py"))
    legacy, tags = lifecycle["legacy_inventory"](
        state, revisions, candidate, phone_floor=False, restoration=True
    )
    require(not legacy and not tags, "retained consumers still require canonical retirement")


def runtime_identity(state, revision, service, original, lane):
    metadata, spec, status = (revision.get(k, {}) for k in ("metadata", "spec", "status"))
    labels, containers = metadata.get("labels", {}), spec.get("containers", [])
    require(len(containers) == 1, "application container is ambiguous")
    container = containers[0]
    expected = {
        "HUSHH_DEPLOY_ENV": "production", "HUSHH_DEPLOY_SOURCE": "deploy-production",
        "HUSHH_DEPLOY_SHA": original["source"], "HUSHH_DEPLOY_RUN_ID": str(original["run_id"]),
    }
    if lane == "backend":
        expected.update({key: "false" for key in (
            "AUTH_PHONE_RECOVERY_ENABLED", "WORKOS_SSO_ENABLED", "ACCOUNT_GENERATION_ADMISSION_ENABLED",
            "PROTECTED_DOCUMENT_DELIVERY_ENABLED", "DRIVE_WORK_DRAIN_ENABLED",
        )})
    require(
        all(isinstance(value, str) and 0 < len(value) <= 256
            for value in (metadata.get("uid"), state.get("metadata", {}).get("uid")))
        and labels.get("serving.knative.dev/service") == service
        and labels.get("deploy-env") == "production" and labels.get("deploy-source") == "deploy-production"
        and labels.get("deploy-sha") == original["source"]
        and labels.get("github-run-id") == str(original["run_id"])
        and spec.get("serviceAccountName") == original["previous"][service]["runtimePrincipal"]
        and container.get("command") in (None, []) and container.get("args") in (None, [])
        and container.get("image") == status.get("imageDigest") == original["images"][lane]
        and all([e.get("value") for e in container.get("env", []) if e.get("name") == key] == [value]
                for key, value in expected.items())
        and not any("valueFrom" in e for e in container.get("env", []) if e.get("name") in expected)
        and state.get("metadata", {}).get("generation") is not None
        and str(state.get("metadata", {}).get("generation")) == str(state.get("status", {}).get("observedGeneration"))
        and all(any(c.get("type") == "Ready" and c.get("status") == "True"
                    for c in item.get("status", {}).get("conditions", [])) for item in (state, revision)),
        "runtime UID, source, image, flags or readiness differs",
    )
    return {"revision": metadata["name"], "uid": metadata["uid"],
            "service_uid": state["metadata"]["uid"], "source": original["source"],
            "sha": original["source"], "run_id": original["run_id"], "image": original["images"][lane],
            "traffic_sha256": hashlib.sha256(json.dumps([
                state.get("spec", {}).get("traffic"), state.get("status", {}).get("traffic")
            ], sort_keys=True).encode()).hexdigest()}


def validate_activation(origin, activation):
    original, backend = origin["original"], origin["runtime"]["backend"]
    expected = {
        "schema_version": 1, "kind": "account-lifecycle-activation", "status": "activated",
        "project": "hushh-pda", "region": "us-central1", "service": "consent-protocol",
        "sha": original["source"], "run_id": str(original["run_id"]),
        "candidate_revision": backend["revision"], "candidate_uid": backend["uid"],
        "service_uid": backend["service_uid"], "required_provider_contract": 2,
        "database_preflight": "qualified", "fence_removal": "confirmed_absent",
    }
    require(all(activation.get(k) == v for k, v in expected.items()),
            "fresh activation is not bound to original runtime")
    retirement, scheduler = activation.get("retirement", {}), activation.get("scheduler", {})
    require(retirement.get("status") == "retired"
            and retirement.get("remaining_pre_v201_count") == 0
            and retirement.get("remaining_pre_provider_v2_count") == 0
            and retirement.get("phone_admission_floor_required") is False
            and scheduler.get("status") == "healthy"
            and scheduler.get("checks", {}).get("fresh_attempt_finished") is True
            and scheduler.get("checks", {}).get("http_2xx") is True
            and activation.get("production_restoration", {}).get("documentFence") == "verified"
            and activation["production_restoration"].get("sourceSha") == original["source"]
            and activation["production_restoration"].get("providerContractVersion") == 2
            and activation["production_restoration"].get("documentsChecked") is True
            and activation["production_restoration"].get("runId") == str(original["run_id"]),
            "fresh schema, original barrier, Scheduler or retirement is unconfirmed")


def validate_runtime_context(origin):
    original, runtime = origin["original"], origin["runtime"]
    require(set(runtime) == {"backend", "frontend"}, "paired runtime identities required")
    for lane, identity in runtime.items():
        require(identity.get("revision") == original["pair"][lane]
                and identity.get("source") == identity.get("sha") == original["source"]
                and identity.get("image") == original["images"][lane]
                and identity.get("run_id") == original["run_id"]
                and re.fullmatch(r"[0-9a-f]{64}", identity.get("traffic_sha256", ""))
                and all(isinstance(identity.get(k), str) and 0 < len(identity[k]) <= 256
                        for k in ("uid", "service_uid")), "runtime provenance differs from original")


def fresh_provenance(read, original):
    for lane, service in (("backend", "consent-protocol"), ("frontend", "hushh-webapp")):
        report = read(f"prod-{lane}-provenance.json")
        provenance.validate_serving_provenance(
            {"run_id": original["run_id"], "provenance": {lane: report}},
            environment="production", sha=original["source"], service=lane,
            revision=original["pair"][lane], project="hushh-pda", service_name=service,
        )
        image = provenance.validated_backend_image(report["checked_revisions"][0], "hushh-pda", service)
        require(image == original["images"][lane], "fresh immutable image differs")


def serving_context(run, release, job, content, **arguments):
    require(arguments["governed"](run, REPOSITORY, "production"), "verifier completed dispatch is not governed")
    manual(run)
    require(run.get("conclusion") == "success", "verifier did not succeed")
    origin = owner.phone._document(content, ORIGIN)
    original = origin["original"]
    require(original == load_original(original["run_id"], original["run_attempt"],
                                      release["sha"], **arguments), "original archive binding changed")
    require(run["id"] != original["run_id"] and origin.get("kind") == "production-restoration-activation-origin"
            and origin.get("schema_version") == 1, "verifier and runtime identity are not distinct")
    require(origin.get("verifier") == verifier_identity(run), "verifier attempt or actors changed")
    validate_runtime_context(origin)
    steps = job.get("steps") or []
    indexed = {s.get("name"): s for s in steps}
    require(len(indexed) == len(steps) and job.get("conclusion") == "success"
            and all(indexed.get(n, {}).get("conclusion") == "success"
                    and indexed[n].get("status") == "completed" for n in FRESH_STEPS)
            and all(indexed.get(n, {}).get("conclusion", "skipped") == "skipped" for n in FORBIDDEN),
            "fresh hosted checks missing or deployment executed")
    require(release.get("final") == release.get("candidate") == {
        f"{lane}_revision": original["pair"][lane] for lane in ("backend", "frontend")
    } and release.get("production_restoration") == original["validation"], "verifier replaced original pair")
    require(release.get("restoration_activation") == {
        "original_run_id": original["run_id"], "original_attempt": original["run_attempt"]
    }, "receipt selector differs from original operation")
    validate_activation(origin, owner.phone._document(content, "prod-account-deletion-activation.json"))
    fresh_provenance(lambda name: owner.phone._document(content, name), original)
    require(fresh_run(arguments, run["id"]) == run, "verifier changed during receipt qualification")
    return origin["runtime"]


def verifier_identity(run):
    return {"run_id": run["id"], "run_attempt": run["run_attempt"], "workflow_sha": run["head_sha"],
            **{key: run[key]["login"] for key in ("actor", "triggering_actor")}}


def prepare(args, maintenance):
    original = load_original(args.run_id, args.attempt, args.sha, **ports())
    proof = importlib.import_module("production_backend_successor_proof")
    tag = proof.read_original()
    current = active_run(maintenance)
    healthy, operational = proof.reference.split(tag["message"], tag["commit"])
    fields = dict(line.split(": ", 1) for line in healthy.splitlines()[1:])
    previous = original["previous"]
    require(operational is None and tag["commit"] == previous["consent-protocol"]["sha"]
            and fields["backend_revision"] == previous["consent-protocol"]["revision"]
            and fields["frontend_revision"] == previous["hushh-webapp"]["revision"],
            "healthy reference is outside original restoration baseline")
    return {"schema_version": 1, "kind": "production-restoration-activation-origin",
            "original": original, "verifier": verifier_identity(current),
            "runtime": runtime_pair(original, maintenance), "healthy_tag": tag}


def verify_origin(origin, maintenance):
    original = origin["original"]
    require(original == load_original(original["run_id"], original["run_attempt"], original["source"], **ports()),
            "original attempt changed before completion")
    require(runtime_pair(original, maintenance) == origin["runtime"], "serving pair changed during verification")
    proof = importlib.import_module("production_backend_successor_proof")
    require(proof.read_original() == origin["healthy_tag"], "healthy reference changed during continuation")
    current = active_run(maintenance)
    require(verifier_identity(current) == origin["verifier"],
            "verifier changed during continuation")


def finish(origin, directory):
    activation = json.loads((directory / "prod-account-deletion-activation.json").read_text())
    validate_activation(origin, activation)
    original = origin["original"]
    fresh_provenance(lambda name: json.loads((directory / name).read_text()), original)
    pair = {f"{lane}_revision": name for lane, name in original["pair"].items()}
    return {"status": "healthy", "sha": original["source"], "scope": "all",
            "candidate": pair, "final": pair,
            "predeploy": {f"{lane}_revision": original["previous"][service]["revision"]
                          for lane, service in (("backend", "consent-protocol"), ("frontend", "hushh-webapp"))},
            "production_restoration": original["validation"],
            "restoration_activation": {"original_run_id": original["run_id"], "original_attempt": original["run_attempt"]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "verify", "finish"))
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt", type=int, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    maintenance = importlib.import_module("uat-retention-maintenance")
    path = args.directory / ORIGIN
    if args.phase == "prepare":
        origin = prepare(args, maintenance)
        args.directory.mkdir(parents=True, exist_ok=True)
        with path.open("x") as output:
            json.dump(origin, output, indent=2, sort_keys=True)
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            for lane, runtime in origin["runtime"].items():
                output.write(f"{lane}_revision={runtime['revision']}\n")
                output.write(f"{lane}_image={runtime['image']}\n")
        return
    origin = json.loads(path.read_text())
    require(origin["original"]["run_id"] == int(args.run_id)
            and origin["original"]["run_attempt"] == args.attempt
            and origin["original"]["source"] == args.sha, "continuation selector changed")
    verify_origin(origin, maintenance)
    if args.phase == "finish":
        report = finish(origin, args.directory)
        (args.directory / "prod-release-status.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
