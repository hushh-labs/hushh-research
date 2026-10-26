# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Immutable rollback evidence for the single recorded production recovery.

The existing workflow owns admission, artifacts and traffic changes. This module
only reads provider state and verifies the original pair, including on retries.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import runpy
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUTHORITY = runpy.run_path(
    str(Path(__file__).with_name("compatibility_restoration.py"))
)
TRANSPORT = runpy.run_path(str(ROOT / "scripts/ci/verify-predecessor-acceptance.py"))
DOCUMENTS = runpy.run_path(
    str(ROOT / "deploy/drive/resolve_protected_document_release.py")
)
require = AUTHORITY["require"]
SERVICES = ("consent-protocol", "hushh-webapp")
WORKFLOW = ".github/workflows/deploy-production.yml"


def command(arguments: list[str], *, timeout: int = 90) -> str:
    result = subprocess.run(  # noqa: S603 -- fixed executables and validated resource names.
        arguments, capture_output=True, text=True, timeout=timeout
    )
    require(result.returncode == 0, "Recovery evidence command failed")
    require(len(result.stdout) <= 1024 * 1024, "Recovery evidence exceeds its bound")
    return result.stdout


def cloud(kind: str, name: str) -> dict:
    require(kind in {"services", "revisions"}, "Unsupported resource")
    require(bool(re.fullmatch(r"[a-z][a-z0-9-]{0,62}", name)), "Invalid resource name")
    return json.loads(
        command(
            [
                "gcloud",
                "run",
                kind,
                "describe",
                name,
                "--project=hushh-pda",
                "--region=us-central1",
                "--format=json",
            ]
        )
    )


def qualify_revision(
    revision: dict, service: str, expected: dict, *, require_ready: bool = True
) -> dict:
    require(service in SERVICES, "Unexpected recovery service")
    metadata, spec, status = (
        revision.get(key) or {} for key in ("metadata", "spec", "status")
    )
    labels, containers = metadata.get("labels") or {}, spec.get("containers") or []
    require(len(containers) == 1, "Unexpected recovery container topology")
    container = containers[0]
    entries = container.get("env") or []
    env = {entry.get("name"): entry.get("value") for entry in entries}
    require(len(entries) == len(env), "Ambiguous recovery environment")
    expected_env = {
        "HUSHH_DEPLOY_ENV": "production",
        "HUSHH_DEPLOY_SOURCE": "deploy-production",
        "HUSHH_DEPLOY_SHA": expected["sha"],
        "HUSHH_DEPLOY_RUN_ID": expected["deployRunId"],
    }
    require(
        metadata.get("name") == expected["revision"]
        and labels.get("serving.knative.dev/service") == service
        and labels.get("deploy-env") == "production"
        and labels.get("deploy-source") == "deploy-production"
        and labels.get("deploy-sha") == expected["sha"]
        and labels.get("github-run-id") == expected["deployRunId"]
        and labels.get("account-deletion-contract") == "v201"
        and spec.get("serviceAccountName") == expected["runtimePrincipal"]
        and container.get("command") in (None, [])
        and container.get("args") in (None, [])
        and container.get("image") == expected["image"]
        and status.get("imageDigest") == expected["image"]
        and all(env.get(key) == value for key, value in expected_env.items())
        and (
            not require_ready
            or any(
                row.get("type") == "Ready" and str(row.get("status")).lower() == "true"
                for row in status.get("conditions", [])
            )
        ),
        "The recorded rollback revision is not qualified",
    )
    if service == "consent-protocol":
        generation = [
            row
            for row in entries
            if row.get("name") == "ACCOUNT_GENERATION_ADMISSION_ENABLED"
        ]
        require(
            not generation
            or (
                len(generation) == 1
                and generation[0].get("value") == "false"
                and "valueFrom" not in generation[0]
            ),
            "Rollback generation admission is incompatible",
        )
    return expected


def qualify_plan(plan: dict, *, sha: str, run_id: str, workflow_sha: str) -> dict:
    record = AUTHORITY["qualify_source"](sha)
    require(
        plan.get("schemaVersion") == 1
        and plan.get("runId") == run_id
        and plan.get("sourceSha") == sha
        and plan.get("workflowSha") == workflow_sha
        and plan.get("recordSha256")
        == hashlib.sha256(AUTHORITY["RECORD"].read_bytes()).hexdigest()
        and plan.get("previous") == record.get("previousServices"),
        "Recovery operation does not match its immutable baseline",
    )
    for service in SERVICES:
        qualify_revision(
            cloud("revisions", plan["previous"][service]["revision"]),
            service,
            plan["previous"][service],
        )
    qualify_current_phase(plan)
    return record


def qualify_current_phase(plan: dict) -> None:
    """A retry may observe only the original pair or this run's own candidate."""
    states = runpy.run_path(str(ROOT / "scripts/ci/resolve-cloud-run-serving-state.py"))
    for service, original in plan["previous"].items():
        current = states["resolve_serving_state"](cloud("services", service)).revision
        if current == original["revision"]:
            continue
        revision = cloud("revisions", current)
        source = DOCUMENTS["_revision_source"](revision)
        require(
            source["sha"] == plan["sourceSha"],
            "A different production release now serves",
        )
        expected = {
            **original,
            "revision": current,
            "sha": plan["sourceSha"],
            "image": source["image"],
            "deployRunId": plan["runId"],
        }
        qualify_revision(revision, service, expected, require_ready=False)


def initial_plan(*, sha: str, run_id: str, workflow_sha: str) -> dict:
    record = AUTHORITY["qualify_source"](sha)
    state = runpy.run_path(str(ROOT / "scripts/ci/resolve-cloud-run-serving-state.py"))
    for service in SERVICES:
        expected = record["previousServices"][service]
        actual = cloud("services", service)
        serving = state["resolve_serving_state"](actual)
        require(
            serving.revision == expected["revision"], "Production baseline has changed"
        )
        qualify_revision(cloud("revisions", serving.revision), service, expected)
        url = str(actual.get("status", {}).get("url") or "")
        require(
            re.fullmatch(r"https://[a-z0-9-]+\.a\.run\.app", url) is not None,
            "Invalid production service origin",
        )
        command(
            [
                "bash",
                str(ROOT / "scripts/ci/cloudrun-http-health.sh"),
                url,
                "/health" if service == "consent-protocol" else "/",
                "1",
                "15",
                "1",
                "200",
            ]
        )
    return {
        "schemaVersion": 1,
        "runId": run_id,
        "workflowSha": workflow_sha,
        "sourceSha": sha,
        "recordSha256": hashlib.sha256(AUTHORITY["RECORD"].read_bytes()).hexdigest(),
        "previous": record["previousServices"],
    }


def previous_plan(
    client, *, run_id: str, attempt: int, workflow_sha: str
) -> dict | None:
    run = client.read(f"runs/{run_id}")
    require(
        run.get("id") == int(run_id)
        and run.get("run_attempt") == attempt
        and run.get("head_sha") == workflow_sha
        and run.get("head_branch") == "main"
        and run.get("path") == WORKFLOW
        and run.get("event") == "workflow_dispatch"
        and run.get("repository", {}).get("full_name") == TRANSPORT["REPOSITORY"],
        "Recovery run identity changed",
    )
    inventory = client.read(f"runs/{run_id}/artifacts?per_page=100")
    artifacts = inventory.get("artifacts")
    require(
        isinstance(artifacts, list)
        and inventory.get("total_count") == len(artifacts)
        and len(artifacts) <= 100,
        "Incomplete recovery artifact inventory",
    )
    prefix = f"production-restoration-operation-{run_id}-"
    matches = []
    for artifact in artifacts:
        name = artifact.get("name", "")
        if name.startswith(prefix):
            suffix = name.removeprefix(prefix)
            require(suffix.isdigit(), "Malformed recovery artifact identity")
            if int(suffix) < attempt:
                matches.append((int(suffix), artifact))
    if not matches:
        return None
    prior, artifact = max(matches, key=lambda item: item[0])
    require(
        sum(number == prior for number, _ in matches) == 1
        and artifact.get("expired") is False
        and artifact.get("workflow_run", {}).get("id") == int(run_id)
        and artifact.get("workflow_run", {}).get("head_sha") == workflow_sha
        and 0 < artifact.get("size_in_bytes", 0) <= TRANSPORT["MAX_BYTES"],
        "Recovery baseline artifact is unavailable or ambiguous",
    )
    jobs = client.read(f"runs/{run_id}/attempts/{prior}/jobs?per_page=100")
    require(
        jobs.get("total_count") == len(jobs.get("jobs", [])),
        "Incomplete operation jobs",
    )
    published = [
        step
        for job in jobs["jobs"]
        for step in job.get("steps", [])
        if step.get("name") == "Upload immutable recovery baseline"
        and step.get("status") == "completed"
        and step.get("conclusion") == "success"
    ]
    require(len(published) == 1, "Recovery baseline publication was not confirmed")
    return TRANSPORT["unpack"](
        client.read(f"artifacts/{artifact['id']}/zip", binary=True),
        artifact.get("digest", ""),
    )


def document_report(plan: dict, mode: dict, ancestor: str) -> dict:
    previous = {}
    for service, value in plan["previous"].items():
        require(
            DOCUMENTS["reader_supported"](value["sha"], ancestor),
            "Recovery rollback must retain document readers",
        )
        previous[service] = {key: value[key] for key in ("revision", "sha", "image")}
        previous[service]["readerCompatible"] = True
    return {
        **mode,
        "project": "hushh-pda",
        "targetSha": plan["sourceSha"],
        "readerAncestor": ancestor,
        "previous": previous,
        "bootstrapEmpty": False,
    }


def write_outputs(path: Path, plan: dict) -> None:
    baseline = plan["previous"]["consent-protocol"]
    with path.open("a") as output:
        for key, value in {
            "revision": baseline["revision"],
            "fallback_sha": "",
            "fallback_image": "",
            "recovery_enabled": "false",
            "frontend_revision": plan["previous"]["hushh-webapp"]["revision"],
        }.items():
            require("\n" not in value and "\r" not in value, "Invalid recovery output")
            output.write(f"{key}={value}\n")


def restore_cleanup(plan: dict, *, sha: str, run_id: str, workflow_sha: str) -> None:
    # Reopening cleanup is allowed only after BOTH original readers serve again.
    current = initial_plan(sha=sha, run_id=run_id, workflow_sha=workflow_sha)
    require(current == plan, "The original serving pair has not been restored")
    baseline = plan["previous"]["consent-protocol"]
    command(
        [
            "python3",
            str(ROOT / "deploy/account-deletion/activate_release.py"),
            "--project",
            "hushh-pda",
            "--region",
            "us-central1",
            "--backend-service",
            "consent-protocol",
            "--backend-url",
            "https://api.hushh.ai",
            "--oidc-audience",
            "https://api.hushh.ai",
            "--scheduler-job",
            "account-deletion-cleanup-production",
            "--scheduler-service-account",
            "account-deletion-cleanup",
            "--expected-sha",
            baseline["sha"],
            "--expected-run-id",
            baseline["deployRunId"],
            "--cloudsql-instance",
            "hushh-pda:us-central1:hushh-vault-db",
            "--db-name",
            "hushh_vault",
            "--db-port",
            "6544",
            "--fence-required",
            "true",
            "--evidence-prefix",
            "/tmp/prod-restoration-rollback-cleanup",
        ],
        timeout=720,
    )


def dispatch_result(args, plan: dict) -> None:
    if args.action == "document-report":
        require(
            args.document_mode is not None and args.output is not None,
            "Document report paths required",
        )
        report = document_report(
            plan, json.loads(args.document_mode.read_text()), args.reader_ancestor
        )
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    if args.action == "verify" and args.output:
        baseline = plan["previous"]["consent-protocol"]
        args.output.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "qualification": "passed",
                    "project": "hushh-pda",
                    "region": "us-central1",
                    "revision": baseline["revision"],
                    "source": baseline["sha"],
                    "image": baseline["image"],
                    "mode": "production-restoration",
                    "run_id": args.run_id,
                },
                indent=2,
            )
            + "\n"
        )
    if args.action == "rollback":
        require(
            args.service in SERVICES
            and args.revision == plan["previous"][args.service]["revision"],
            "Rollback is outside the original recovery pair",
        )
    if args.action == "restore-cleanup":
        restore_cleanup(
            plan, sha=args.sha, run_id=args.run_id, workflow_sha=args.workflow_sha
        )
    if args.github_output:
        write_outputs(args.github_output, plan)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=("prepare", "verify", "document-report", "rollback", "restore-cleanup"),
    )
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--workflow-sha", default=os.environ.get("GITHUB_SHA", ""))
    parser.add_argument(
        "--attempt", type=int, default=int(os.environ.get("GITHUB_RUN_ATTEMPT", "1"))
    )
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--reader-ancestor", default="")
    parser.add_argument("--document-mode", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--service", choices=SERVICES)
    parser.add_argument("--revision", default="")
    args = parser.parse_args()
    try:
        require(
            re.fullmatch(r"[1-9][0-9]*", args.run_id) is not None
            and re.fullmatch(r"[0-9a-f]{40}", args.workflow_sha) is not None
            and args.attempt > 0,
            "Invalid recovery operation identity",
        )
        if args.action == "prepare":
            plan = previous_plan(
                TRANSPORT["GitHub"](),
                run_id=args.run_id,
                attempt=args.attempt,
                workflow_sha=args.workflow_sha,
            )
            plan = plan or initial_plan(
                sha=args.sha, run_id=args.run_id, workflow_sha=args.workflow_sha
            )
        else:
            require(
                args.plan.stat().st_size <= TRANSPORT["MAX_BYTES"],
                "Operation exceeds bound",
            )
            plan = json.loads(args.plan.read_text())
        qualify_plan(
            plan, sha=args.sha, run_id=args.run_id, workflow_sha=args.workflow_sha
        )
        if args.action == "prepare":
            args.plan.parent.mkdir(parents=True, exist_ok=True)
            args.plan.write_text(json.dumps(plan, indent=2) + "\n")
        dispatch_result(args, plan)
    except Exception as exc:
        reason = (
            str(exc)
            if isinstance(exc, AUTHORITY["Refused"])
            else "operation_evidence_unconfirmed"
        )
        parser.exit(1, "Recorded production recovery refused: " + reason + "\n")
    print("Recorded recovery baseline verified; no traffic changed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
