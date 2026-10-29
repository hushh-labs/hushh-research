#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Prepare the protected health timer; apply only reviewed Main-owned source."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
PROJECTS = {"hushh-pda-uat", "hushh-pda"}
REGION = "us-central1"
JOB = "protected-configuration-health"
FILES = ["config/protected-lists.json", "scripts/ops/verify_secret_list_invariants.py",
         "scripts/ci/process_group.py", "deploy/observability/auth_health_job.py"]


def _transport(project: str):
    import google.auth
    from google.auth.transport.requests import Request, AuthorizedSession
    import requests

    credentials, _ = google.auth.default()
    credentials.refresh(Request())
    with requests.post("https://oauth2.googleapis.com/tokeninfo",
                       data={"access_token": credentials.token}, timeout=20) as observed:
        if observed.status_code != 200 or observed.json().get("email") != "kushal@hushh.ai":
            raise RuntimeError("Expected admin ADC identity unavailable")
    cli = shutil.which("gcloud") or str(Path.home() / "google-cloud-sdk/bin/gcloud")
    env = {**os.environ, "CLOUDSDK_AUTH_ACCESS_TOKEN": credentials.token}

    def run(args, *, optional=False):
        result = subprocess.run([cli, *args, f"--project={project}", "--quiet", "--format=json"],
                                env=env, capture_output=True, text=True, timeout=90)
        if result.returncode:
            if optional and "NOT_FOUND" in result.stderr:
                return None
            raise RuntimeError(f"Cloud operation refused: {' '.join(args[:3])}")
        return json.loads(result.stdout) if result.stdout.strip() else {}

    return run, AuthorizedSession(credentials)


def _reviewed_source() -> str:
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()

    source = git("rev-parse", "HEAD")
    if subprocess.run(["git", "merge-base", "--is-ancestor", source, "origin/main"], cwd=ROOT).returncode:
        raise RuntimeError("Health timer source must first land on Main")
    owned = [*FILES, "deploy/observability/auth-health.Dockerfile", "deploy/observability/setup_auth_health.py"]
    if git("status", "--porcelain", "--", *owned) or git("diff", source, "origin/main", "--", *owned):
        raise RuntimeError("Health timer source differs from reviewed Main")
    return source


def _journal(project: str, source: str, journal_path: Path):
    journal = json.loads(journal_path.read_text()) if journal_path.exists() else {
        "project": project, "operation": uuid.uuid4().hex, "phase": "prepared", "source": source,
    }
    operation = journal.get("operation", "")
    if journal.get("project") != project or len(operation) != 32 or any(c not in "0123456789abcdef" for c in operation):
        raise RuntimeError("Health resource journal does not match this project")
    def save(**values):
        journal.update(values)
        journal_path.write_text(json.dumps(journal, indent=2) + "\n")
        journal_path.chmod(0o600)
    save()
    return journal, save


def _bucket(api, run, project: str, operation: str) -> str:
    project_number = str(run(["projects", "describe", project])["projectNumber"])
    bucket = f"{project}-auth-health-ops"
    response = api.get(f"https://storage.googleapis.com/storage/v1/b/{bucket}", timeout=30)
    if response.status_code == 404:
        response = api.post("https://storage.googleapis.com/storage/v1/b", params={"project": project}, json={
            "name": bucket, "location": REGION, "storageClass": "STANDARD",
            "labels": {"managed_by": "repo_observability", "purpose": "auth_health", "operation": operation},
            "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}, "publicAccessPrevention": "enforced"},
            "softDeletePolicy": {"retentionDurationSeconds": "0"},
            "lifecycle": {"rule": [{"action": {"type": "Delete"}, "condition": {
                "age": 14, "matchesPrefix": ["sources/", "build-logs/"]}}]},
        }, timeout=30)
    if response.status_code not in {200, 201}:
        raise RuntimeError("Health bucket ownership unavailable")
    existing = response.json()
    if (str(existing.get("projectNumber")) != project_number
            or existing.get("labels", {}).get("operation") != operation):
        raise RuntimeError("Existing health bucket has unverified ownership")
    return bucket



def _identities(run, project: str, operation: str, bucket: str, runtime: bool, journal: dict, save):
    checker = f"auth-health-check@{project}.iam.gserviceaccount.com"
    scheduler = f"auth-health-clock@{project}.iam.gserviceaccount.com"
    for account in [checker, scheduler]:
        description = f"Hussh auth-health operation {operation}"
        observed = run(["iam", "service-accounts", "describe", account], optional=True)
        if observed is None:
            observed = run(["iam", "service-accounts", "create", account.split("@", 1)[0],
                            "--display-name=Hussh protected configuration health", f"--description={description}"])
        if (observed.get("email") != account or observed.get("projectId") != project
                or observed.get("description") != description or not observed.get("uniqueId")
                or observed.get("disabled") is True):
            raise RuntimeError("Existing health service account has unverified ownership")
        identities = {**journal.get("identities", {}), account: observed["uniqueId"]}
        save(identities=identities)

    role = "husshAuthHealthSecretReader"
    permissions = {"secretmanager.versions.list", "secretmanager.versions.access"}
    existing = run(["iam", "roles", "describe", role], optional=True)
    if existing is None:
        run(["iam", "roles", "create", role, "--title=Protected health list reader",
             "--permissions=" + ",".join(sorted(permissions)), "--stage=GA"])
    elif set(existing.get("includedPermissions", [])) != permissions:
        raise RuntimeError("Health reader role differs from its reviewed permissions")
    config = json.loads((ROOT / FILES[0]).read_text())
    for secret in config["secrets"]:
        if secret["project"] == project:
            run(["secrets", "add-iam-policy-binding", secret["name"],
                 f"--member=serviceAccount:{checker}", f"--role=projects/{project}/roles/{role}"])
    run(["projects", "add-iam-policy-binding", project, f"--member=serviceAccount:{checker}",
         "--role=roles/logging.logWriter", "--condition=None"])
    run(["storage", "buckets", "add-iam-policy-binding", f"gs://{bucket}",
         f"--member=serviceAccount:{checker}", "--role=roles/storage.objectUser"])
    if runtime:
        run(["run", "services", "add-iam-policy-binding", "consent-protocol", f"--region={REGION}",
             f"--member=serviceAccount:{checker}", "--role=roles/run.viewer"])

    return checker, scheduler


def _image(run, project: str, operation: str, source: str, bucket: str, save):
    tag = f"gcr.io/{project}/auth-health-job:{source}"
    matches = run(["builds", "list", f"--filter=tags:auth-health-{operation}", "--limit=2"])
    if len(matches) > 1:
        raise RuntimeError("Multiple health builds require reconciliation")
    if matches and tag not in matches[0].get("images", []):
        raise RuntimeError("Existing health build belongs to another source; review before rebuilding")
    with tempfile.TemporaryDirectory(prefix="auth-health-source-") as directory:
        stage = Path(directory)
        for name in FILES:
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        shutil.copyfile(ROOT / "deploy/observability/auth-health.Dockerfile", stage / "Dockerfile")
        build = matches[0] if matches else run(["builds", "submit", str(stage), f"--tag={tag}", f"--tags=auth-health-{operation}", "--async", "--timeout=600s",
                     f"--gcs-source-staging-dir=gs://{bucket}/sources",
                     f"--gcs-log-dir=gs://{bucket}/build-logs"])
    save(phase="building", build_id=build["id"])
    deadline = time.monotonic() + 660
    while build.get("status") in {"QUEUED", "WORKING", "STATUS_UNKNOWN", "PENDING"}:
        if time.monotonic() > deadline:
            raise RuntimeError("Build remains unresolved; inspect it before retrying")
        time.sleep(10)
        build = run(["builds", "describe", build["id"]])
    if build.get("status") != "SUCCESS":
        raise RuntimeError("Health image build did not succeed")
    image = f"gcr.io/{project}/auth-health-job@{build['results']['images'][0]['digest']}"
    return image, build["id"]


def _timer(run, project: str, operation: str, image: str, checker: str, scheduler: str, runtime: bool, schedule: str):
    existing = run(["run", "jobs", "describe", JOB, f"--region={REGION}"], optional=True)
    if existing and existing.get("metadata", {}).get("labels", {}).get("operation") != operation:
        raise RuntimeError("Existing health job has unverified ownership")
    run(["run", "jobs", "deploy", JOB, f"--region={REGION}", f"--image={image}",
         f"--service-account={checker}", "--tasks=1", "--parallelism=1", "--max-retries=0",
         "--task-timeout=600s", "--cpu=1", "--memory=512Mi",
         f"--set-env-vars=AUTH_HEALTH_PROJECT={project},AUTH_PHONE_RUNTIME_HEALTH_ENABLED={str(runtime).lower()}",
         f"--labels=managed_by=repo_observability,purpose=auth_health,operation={operation}"])
    run(["run", "jobs", "add-iam-policy-binding", JOB, f"--region={REGION}",
         f"--member=serviceAccount:{scheduler}", "--role=roles/run.invoker"])
    target = f"https://run.googleapis.com/v2/projects/{project}/locations/{REGION}/jobs/{JOB}:run"
    existing = run(["scheduler", "jobs", "describe", JOB, f"--location={REGION}"], optional=True)
    if existing and existing.get("description") != f"Hussh auth-health operation {operation}":
        raise RuntimeError("Existing health schedule has unverified ownership")
    run(["scheduler", "jobs", "update" if existing else "create", "http", JOB,
         f"--location={REGION}", f"--schedule={schedule}", "--time-zone=Etc/UTC",
         f"--uri={target}", "--http-method=POST", "--message-body={}",
         "--headers=Content-Type=application/json", f"--oauth-service-account-email={scheduler}",
         "--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform", "--attempt-deadline=30s",
         "--max-retry-attempts=0", f"--description=Hussh auth-health operation {operation}"])



def apply(project: str, *, runtime: bool, schedule: str, journal_path: Path) -> dict:
    if project not in PROJECTS:
        raise ValueError("Ungoverned health project")
    source = _reviewed_source()
    journal, save = _journal(project, source, journal_path)
    operation = journal["operation"]
    run, api = _transport(project)
    try:
        bucket = _bucket(api, run, project, operation)
        save(bucket=bucket)
        checker, scheduler = _identities(run, project, operation, bucket, runtime, journal, save)
        image, build_id = _image(run, project, operation, source, bucket, save)
        _timer(run, project, operation, image, checker, scheduler, runtime, schedule)
        save(phase="configured", image=image, build_id=build_id)
        return {**journal, "source": source, "job": JOB, "schedule": schedule,
                "runtime_observation": runtime, "task_timeout_seconds": 600,
                "checker_timeout_seconds": 450, "lease_seconds": 900}
    finally:
        api.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", choices=sorted(PROJECTS), required=True)
    parser.add_argument("--check-phone-runtime", action="store_true")
    parser.add_argument("--schedule", choices=["17 * * * *", "*/2 * * * *"], default="17 * * * *")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps({"project": args.project, "job": JOB, "schedule": args.schedule,
                          "mode": "plan", "runtime_observation": args.check_phone_runtime}))
        return 0
    if not args.receipt:
        parser.error("--apply requires --receipt for durable resource ownership and retry")
    receipt = apply(args.project, runtime=args.check_phone_runtime, schedule=args.schedule, journal_path=args.receipt)
    if args.receipt:
        args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
