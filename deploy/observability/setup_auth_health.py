#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Prepare the protected health timer; apply only reviewed Main-owned source."""

import argparse
import fcntl
import gzip
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
PROJECTS = {"hushh-pda-uat", "hushh-pda"}
REGION = "us-central1"
JOB = "protected-configuration-health"
FILES = ["config/protected-lists.json", "scripts/ops/verify_secret_list_invariants.py",
         "scripts/ci/process_group.py", "deploy/observability/auth_health_job.py"]


def _transport(project: str, *, build_only: bool = False):
    import google.auth
    import requests
    from google.auth.transport.requests import AuthorizedSession, Request

    credentials, _ = google.auth.default()
    credentials.refresh(Request())
    expected = ("github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com"
                if build_only and project == "hushh-pda-uat" else "kushal@hushh.ai")
    with requests.post("https://oauth2.googleapis.com/tokeninfo",
                       data={"access_token": credentials.token}, timeout=20) as observed:
        if observed.status_code != 200 or observed.json().get("email") != expected:
            raise RuntimeError("Expected health operator identity unavailable")
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


def _journal(project: str, source: str, journal_path: Path, upgrade_from: str | None = None):
    journal = json.loads(journal_path.read_text()) if journal_path.exists() else {
        "project": project, "operation": uuid.uuid4().hex, "phase": "prepared", "source": source,
    }
    operation = journal.get("operation", "")
    if journal.get("project") != project or len(operation) != 32 or any(c not in "0123456789abcdef" for c in operation):
        raise RuntimeError("Health resource journal does not match this project")
    def save(**values):
        updated = {**journal, **values}
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=journal_path.parent,
                                             prefix=".auth-health-", delete=False) as output:
                temporary = Path(output.name)
                json.dump(updated, output, indent=2)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, journal_path)
            directory = os.open(journal_path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            journal.update(updated)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    if journal.get("source") != source:
        if upgrade_from is None or upgrade_from != journal.get("source"):
            raise RuntimeError("Health source changed; review and supply --upgrade-from with the journal source")
        save(source=source, previous_source=upgrade_from, previous_image=journal.get("image"), phase="upgrading")
    else:
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
        recorded = journal.get("identities", {}).get(account)
        if recorded is not None and recorded != observed["uniqueId"]:
            raise RuntimeError("Health service account identity changed; review required")
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


def _verify_image_source(api, build: dict, project: str, bucket: str, tag: str, expected: dict):
    """Tags identify a retry; immutable provider inputs establish its provenance."""
    steps = build.get("steps", [])
    if (build.get("projectId") != project or build.get("images") != [tag]
            or len(steps) != 1 or steps[0].get("name") != "gcr.io/cloud-builders/docker"
            or steps[0].get("args") != ["build", "--tag", tag, "."]
            or set(steps[0]) - {"name", "args", "timing", "pullTiming", "status"}
            or build.get("secrets") or build.get("availableSecrets") or build.get("substitutions")
            or build.get("artifacts", {"images": [tag]}) != {"images": [tag]}
            or build.get("options", {}).get("pool")):
        raise RuntimeError("Health build execution differs from its reviewed recipe")
    resolved = build.get("sourceProvenance", {}).get("resolvedStorageSource", {})
    if (resolved.get("bucket") != bucket or not resolved.get("object", "").startswith("sources/")
            or not str(resolved.get("generation", "")).isdecimal()):
        raise RuntimeError("Health build source is not immutable in its owned bucket")
    url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{quote(resolved['object'], safe='')}"
    with api.get(url, params={"alt": "media", "generation": resolved["generation"]},
                 timeout=30, stream=True, allow_redirects=False) as response:
        if response.status_code != 200:
            raise RuntimeError("Health build source unavailable")
        archive_bytes = response.raw.read(262145)
    if len(archive_bytes) > 262144:
        raise RuntimeError("Health build source exceeds its bound")
    with gzip.GzipFile(fileobj=io.BytesIO(archive_bytes)) as compressed:
        unpacked = compressed.read(2097153)
    if len(unpacked) > 2097152:
        raise RuntimeError("Health expanded source exceeds its bound")
    observed = {}
    directories = {str(parent) for path in expected for parent in Path(path).parents if str(parent) != "."}
    with tarfile.open(fileobj=io.BytesIO(unpacked), mode="r:") as archive:
        for index, member in enumerate(archive):
            if index >= 32:
                raise RuntimeError("Health source inventory exceeds its bound")
            if member.isdir() and member.name in directories and member.size == 0:
                continue
            if (not member.isfile() or member.name not in expected or member.name in observed
                    or member.size != len(expected[member.name])):
                raise RuntimeError("Health source inventory differs from reviewed Main")
            with archive.extractfile(member) as entry:
                observed[member.name] = entry.read(member.size + 1)
    if observed != expected:
        raise RuntimeError("Health source contents differ from reviewed Main")


def _image(run, api, project: str, operation: str, source: str, bucket: str, save):
    tag = f"gcr.io/{project}/auth-health-job:{source}"
    revision_tag = f"auth-health-source-{source}"
    matches = run(["builds", "list", f"--filter=tags:auth-health-{operation} AND tags:{revision_tag}", "--limit=2"])
    if len(matches) > 1:
        raise RuntimeError("Multiple health builds require reconciliation")
    if matches and tag not in matches[0].get("images", []):
        raise RuntimeError("Existing health build belongs to another source; review before rebuilding")
    with tempfile.TemporaryDirectory(prefix="auth-health-source-") as directory:
        stage = Path(directory)
        for name in FILES:
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(_source_blob(source, name))
        (stage / "Dockerfile").write_bytes(_source_blob(source, "deploy/observability/auth-health.Dockerfile"))
        config = stage / "cloudbuild.json"
        config.write_text(json.dumps({
            "steps": [{"name": "gcr.io/cloud-builders/docker", "args": ["build", "--tag", tag, "."]}],
            "images": [tag], "tags": [f"auth-health-{operation}", revision_tag], "timeout": "600s",
            "options": {"logging": "GCS_ONLY"},
        }))
        expected = {str(path.relative_to(stage)): path.read_bytes() for path in stage.rglob("*") if path.is_file()}
        build = matches[0] if matches else run(["builds", "submit", str(stage), f"--config={config}", "--async",
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
    _verify_image_source(api, build, project, bucket, tag, expected)
    outputs = build.get("results", {}).get("images", [])
    if (len(outputs) != 1 or outputs[0].get("name") != tag
            or len(outputs[0].get("digest", "")) != 71
            or not outputs[0]["digest"].startswith("sha256:")
            or any(c not in "0123456789abcdef" for c in outputs[0]["digest"][7:])):
        raise RuntimeError("Health image output is unverified")
    image = f"gcr.io/{project}/auth-health-job@{build['results']['images'][0]['digest']}"
    return image, build["id"]


def _source_blob(source: str, name: str) -> bytes:
    # Stage immutable reviewed blobs, never files that another session can edit
    # after the clean-tree check while this operation waits on the provider.
    if len(source) != 40 or any(c not in "0123456789abcdef" for c in source):
        raise ValueError("Health build requires an immutable source commit")
    reference = f"{source}:{name}"
    size = int(subprocess.check_output(["git", "cat-file", "-s", reference], cwd=ROOT, timeout=15))
    if size > 131072:
        raise RuntimeError("Health source file exceeds its bound")
    return subprocess.check_output(["git", "show", reference], cwd=ROOT, timeout=15)


def _existing_resource(api, url: str, name: str):
    # Native status is authoritative: SDK describe commands use inconsistent
    # missing-resource errors, which must never turn a denied read into absence.
    with api.get(url, timeout=30, allow_redirects=False) as response:
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise RuntimeError("Health resource observation refused")
        try:
            observed = response.json()
        except ValueError as error:
            raise RuntimeError("Health resource observation malformed") from error
    if not isinstance(observed, dict) or observed.get("name") != name:
        raise RuntimeError("Health resource observation does not match its target")
    return observed


def build_image(project: str, operation: str, receipt: Path):
    """Build through UAT's governed WIF authority without changing deployed jobs."""
    if project != "hushh-pda-uat" or len(operation) != 32 or any(c not in "0123456789abcdef" for c in operation):
        raise ValueError("Only an existing UAT health operation may request this build")
    source = _reviewed_source()
    run, api = _transport(project, build_only=True)
    try:
        bucket = f"{project}-auth-health-ops"
        existing = _existing_resource(api, f"https://storage.googleapis.com/storage/v1/b/{bucket}", bucket)
        number = str(run(["projects", "describe", project])["projectNumber"])
        if (existing is None or str(existing.get("projectNumber")) != number
                or existing.get("labels", {}).get("operation") != operation):
            raise RuntimeError("Health build bucket has unverified ownership")
        image, build_id = _image(run, api, project, operation, source, bucket, lambda **_: None)
        result = {"project": project, "operation": operation, "source": source,
                  "image": image, "build_id": build_id, "run_id": os.environ.get("GITHUB_RUN_ID"),
                  "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "mode": "image-only"}
        receipt.write_text(json.dumps(result, indent=2) + "\n")
        return result
    finally:
        api.close()


def _timer(run, api, project: str, operation: str, image: str, checker: str, scheduler: str, runtime: bool, schedule: str):
    name = f"projects/{project}/locations/{REGION}/jobs/{JOB}"
    existing = _existing_resource(api, f"https://run.googleapis.com/v2/{name}", name)
    if existing and (not isinstance(existing.get("labels"), dict)
                     or existing["labels"].get("operation") != operation):
        raise RuntimeError("Existing health job has unverified ownership")
    existing_schedule = _existing_resource(api, f"https://cloudscheduler.googleapis.com/v1/{name}", name)
    if existing_schedule and existing_schedule.get("description") != f"Hussh auth-health operation {operation}":
        raise RuntimeError("Existing health schedule has unverified ownership")
    run(["run", "jobs", "deploy", JOB, f"--region={REGION}", f"--image={image}",
         f"--service-account={checker}", "--tasks=1", "--parallelism=1", "--max-retries=0",
         "--task-timeout=600s", "--cpu=1", "--memory=512Mi",
         f"--set-env-vars=AUTH_HEALTH_PROJECT={project},AUTH_PHONE_RUNTIME_HEALTH_ENABLED={str(runtime).lower()}",
         f"--labels=managed_by=repo_observability,purpose=auth_health,operation={operation}"])
    run(["run", "jobs", "add-iam-policy-binding", JOB, f"--region={REGION}",
         f"--member=serviceAccount:{scheduler}", "--role=roles/run.invoker"])
    target = f"https://run.googleapis.com/v2/projects/{project}/locations/{REGION}/jobs/{JOB}:run"
    run(["scheduler", "jobs", "update" if existing_schedule else "create", "http", JOB,
         f"--location={REGION}", f"--schedule={schedule}", "--time-zone=Etc/UTC",
         f"--uri={target}", "--http-method=POST", "--message-body={}",
         ("--update-headers=" if existing_schedule else "--headers=") + "Content-Type=application/json",
         f"--oauth-service-account-email={scheduler}",
         "--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform", "--attempt-deadline=30s",
         "--max-retry-attempts=0", f"--description=Hussh auth-health operation {operation}"])



@contextmanager
def _operation_lock(path: Path):
    if path.is_symlink() or path.resolve().is_relative_to(ROOT):
        raise RuntimeError("Health journal must be a private file outside committed source")
    descriptor = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Health setup is already running for this journal") from error
        yield
    finally:
        os.close(descriptor)


def apply(project: str, *, runtime: bool, schedule: str, journal_path: Path, upgrade_from: str | None = None) -> dict:
    with _operation_lock(journal_path):
        return _apply_locked(project, runtime=runtime, schedule=schedule, journal_path=journal_path, upgrade_from=upgrade_from)


def _apply_locked(project: str, *, runtime: bool, schedule: str, journal_path: Path, upgrade_from: str | None = None) -> dict:
    if project not in PROJECTS:
        raise ValueError("Ungoverned health project")
    source = _reviewed_source()
    journal, save = _journal(project, source, journal_path, upgrade_from)
    operation = journal["operation"]
    run, api = _transport(project)
    try:
        bucket = _bucket(api, run, project, operation)
        save(bucket=bucket)
        checker, scheduler = _identities(run, project, operation, bucket, runtime, journal, save)
        image, build_id = _image(run, api, project, operation, source, bucket, save)
        _timer(run, api, project, operation, image, checker, scheduler, runtime, schedule)
        save(phase="configured", image=image, build_id=build_id, job=JOB, schedule=schedule,
             runtime_observation=runtime, task_timeout_seconds=600, checker_timeout_seconds=450,
             lease_seconds=900)
        return journal
    finally:
        api.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", choices=sorted(PROJECTS), required=True)
    parser.add_argument("--check-phone-runtime", action="store_true")
    parser.add_argument("--schedule", choices=["17 * * * *", "*/2 * * * *"], default="17 * * * *")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--build-image", action="store_true", help="Governed UAT WIF build only; no job, timer or IAM mutation")
    parser.add_argument("--operation", help="Existing health ownership operation, for image-only builds")
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--upgrade-from", help="Explicitly reviewed prior source SHA in this same operation journal")
    args = parser.parse_args()
    if args.build_image:
        if args.apply or not args.operation or not args.receipt:
            parser.error("--build-image requires --operation and --receipt, without --apply")
        print(json.dumps(build_image(args.project, args.operation, args.receipt)))
        return 0
    if args.operation:
        parser.error("--operation is only valid with --build-image")
    if not args.apply:
        print(json.dumps({"project": args.project, "job": JOB, "schedule": args.schedule,
                          "mode": "plan", "runtime_observation": args.check_phone_runtime}))
        return 0
    if not args.receipt:
        parser.error("--apply requires --receipt for durable resource ownership and retry")
    receipt = apply(args.project, runtime=args.check_phone_runtime, schedule=args.schedule, journal_path=args.receipt, upgrade_from=args.upgrade_from)
    print(json.dumps(receipt))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
