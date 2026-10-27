# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Complete bounded phone issuer inventories using the existing closed-history port."""

from __future__ import annotations

import hashlib
import importlib
import json
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from runpy import run_path

import workos_rollout as closed
from bootstrap_ports import (
    REPOSITORY,
    Runtime as LockRuntime,
    _authorities,
    controls,
    iam_fingerprint,
)
from consumer_compatibility import qualify_consumers
from qualify_image import run
from revision_qualification import PROJECT, REGION

ROOT = Path(__file__).resolve().parents[2]
SOURCE_ANCHOR = "c8b2095da57daccf2e1fe54bb302369ed13bc863"
HISTORY_START = "2026-10-26T01:10:00Z"
FLAG = "AUTH_PHONE_RECOVERY_ENABLED"
CLOSED_KEY = "direct_recovery_false"


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


@lru_cache(maxsize=512)
def source_capable(sha: str) -> bool:
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("phone_schema_source_unknown")
    run(["git", "merge-base", "--is-ancestor", sha, "origin/main"])
    run(["git", "cat-file", "-e", SOURCE_ANCHOR])
    try:
        run(["git", "merge-base", "--is-ancestor", sha, SOURCE_ANCHOR + "^"])
    except subprocess.CalledProcessError as error:
        if error.returncode != 1:
            raise
        return True
    return False


def _launcher(container: dict, service: str) -> str:
    command, args = container.get("command") or [], container.get("args") or []
    if service == "consent-protocol" and not command and not args:
        return "backend_image_default"
    if service == "consent-protocol":
        contract = importlib.import_module("production_capacity_bridge_contract")
        reviewed = {}
        contract.configure_clone_launcher(
            {"status": {"imageDigest": contract.FROZEN_IMAGE}},
            reviewed,
            [],
            contract.PROFILE,
        )
        expected = reviewed["args"]
    else:
        source = (ROOT / "deploy/drive/deploy_worker_service_prod.sh").read_text()
        matches = re.findall(r"^  --args=([^\s]+) \\$", source, re.M)
        if len(matches) != 1:
            raise ValueError("phone_schema_worker_launcher_contract_unknown")
        expected = matches[0].split(",")
    if command != ["gunicorn"] or args != expected:
        raise ValueError("phone_schema_launcher_unknown")
    _authorities().capacity_bridge.budget.revision_workers(
        container, {"workers_per_instance": 1}, service
    )
    return expected[0]


def _scanner(container: dict) -> bool:
    source = (ROOT / "deploy/drive/deploy_worker_service_prod.sh").read_text()
    values = dict(
        re.findall(
            r'^readonly (CLAMAV_IMAGE|CLAMAV_AMD64_DIGEST)="([^"]+)"$', source, re.M
        )
    )
    verifier = run_path(str(ROOT / "deploy/drive/verify_worker_revision.py"))
    return verifier["_digest"](container.get("image")) in {
        values["CLAMAV_IMAGE"].rsplit("@", 1)[1],
        values["CLAMAV_AMD64_DIGEST"],
    }


def _revision(row: dict, service: str, primary: str) -> dict:
    metadata, spec = row["metadata"], row["spec"]
    name, uid = metadata["name"], metadata.get("uid")
    name_hint = (
        "drive-worker" if service.endswith("-drive-worker") else "consent-protocol"
    )
    container = _authorities().capacity_bridge.budget.named_container(
        spec, name_hint, name
    )
    for extra in spec["containers"]:
        if extra is not container and (
            extra.get("name") != "clamav"
            or not _scanner(extra)
            or extra.get("command")
            or extra.get("args")
            or any(
                row.get("name") not in {"CLAMD_STARTUP_TIMEOUT", "FRESHCLAM_CHECKS"}
                or "valueFrom" in row
                for row in extra.get("env", [])
            )
        ):
            raise ValueError("phone_schema_sidecar_issuer_unknown")
    image = row.get("status", {}).get("imageDigest") or container.get("image", "")
    sha = metadata["labels"]["deploy-sha"]
    if not uid or not re.fullmatch(
        r"gcr\.io/hushh-pda/[^@]+@sha256:[0-9a-f]{64}", image
    ):
        raise ValueError("phone_schema_revision_identity_unknown")
    if source_capable(sha):
        qualify_consumers(sha, primary)
    return {
        "revision": name,
        "uid": uid,
        "source": sha,
        "run_id": metadata["labels"].get("github-run-id"),
        "image": image,
        "spec": fingerprint(spec),
        "launcher": _launcher(container, service),
        "capable": source_capable(sha),
    }


def _events(project: str, service: str, until: str) -> list:
    query = (
        f'logName="projects/{project}/logs/cloudaudit.googleapis.com%2Factivity" '
        'protoPayload.serviceName="run.googleapis.com" '
        f'resource.labels.service_name="{service}" '
        'protoPayload.methodName=~"(CreateService|ReplaceService|UpdateService)$" '
        f'timestamp>="{HISTORY_START}" timestamp<="{until}"'
    )
    return closed._document(
        [
            "gcloud",
            "logging",
            "read",
            query,
            f"--project={project}",
            f"--limit={closed.LIMIT}",
            "--order=asc",
            "--format=json",
        ]
    )


def _service_history(services: set[str], non_database: set[str], until: str) -> int:
    """A deleted or unprofiled producer cannot vanish from the present inventory."""
    query = (
        f'logName="projects/{PROJECT}/logs/cloudaudit.googleapis.com%2Factivity" '
        'protoPayload.serviceName="run.googleapis.com" '
        'protoPayload.methodName=~"(CreateService|ReplaceService|UpdateService|DeleteService)$" '
        f'timestamp>="{HISTORY_START}" timestamp<="{until}"'
    )
    events = closed._document(
        [
            "gcloud",
            "logging",
            "read",
            query,
            f"--project={PROJECT}",
            f"--limit={closed.LIMIT}",
            "--order=asc",
            "--format=json",
        ]
    )
    if not isinstance(events, list) or len(events) >= closed.LIMIT:
        raise ValueError("phone_schema_service_history_incomplete")
    for event in events:
        payload = event.get("protoPayload", {})
        name = event.get("resource", {}).get("labels", {}).get("service_name")
        if (
            event.get("logName")
            != f"projects/{PROJECT}/logs/cloudaudit.googleapis.com%2Factivity"
            or payload.get("serviceName") != "run.googleapis.com"
            or not closed._instant(HISTORY_START)
            <= closed._instant(event["timestamp"])
            <= closed._instant(until)
            or name not in services | non_database
            or payload.get("methodName", "").endswith("DeleteService")
        ):
            raise ValueError("phone_schema_service_history_unknown_issuer")
    return len(events)


def _job(job: dict, images: dict) -> dict:
    metadata = job.get("metadata", {})
    name = metadata.get("name", "")
    template = job.get("spec", {}).get("template", {})
    task = template.get("spec", {}).get("template", {}).get("spec", {})
    containers = task.get("containers", [])
    if (
        not re.fullmatch(
            r"(?:consent-protocol-genai-readiness|genai-ready-[a-z0-9-]+)", name
        )
        or len(containers) != 1
        or not metadata.get("uid")
    ):
        raise ValueError("phone_schema_job_launcher_unknown")
    container = containers[0]
    if (
        container.get("command") != ["python3"]
        or container.get("args") != ["scripts/verify_managed_vertex_runtime.py"]
        or container.get("image") not in images
    ):
        raise ValueError("phone_schema_job_source_unknown")
    sha = images[container["image"]]
    # A capable image is admitted only with the same reviewed probe body.
    if (
        source_capable(sha)
        and run(
            [
                "git",
                "show",
                f"{sha}:consent-protocol/scripts/verify_managed_vertex_runtime.py",
            ]
        )
        != (
            ROOT / "consent-protocol/scripts/verify_managed_vertex_runtime.py"
        ).read_bytes()
    ):
        raise ValueError("phone_schema_job_probe_changed")
    return {
        "job": name,
        "uid": metadata["uid"],
        "source": sha,
        "spec": fingerprint(job["spec"]),
        "launcher": "managed_vertex_probe",
    }


def _job_history(jobs: dict, images: dict, until: str) -> int:
    query = (
        f'logName="projects/{PROJECT}/logs/cloudaudit.googleapis.com%2Factivity" '
        'protoPayload.serviceName="run.googleapis.com" '
        'protoPayload.methodName=~"(CreateJob|ReplaceJob|UpdateJob|RunJob|DeleteJob)$" '
        f'timestamp>="{HISTORY_START}" timestamp<="{until}"'
    )
    events = closed._document(
        [
            "gcloud",
            "logging",
            "read",
            query,
            f"--project={PROJECT}",
            f"--limit={closed.LIMIT}",
            "--order=asc",
            "--format=json",
        ]
    )
    if not isinstance(events, list) or len(events) >= closed.LIMIT:
        raise ValueError("phone_schema_job_history_incomplete")
    known = dict(jobs)
    for event in events:
        payload = event.get("protoPayload", {})
        if (
            event.get("logName")
            != f"projects/{PROJECT}/logs/cloudaudit.googleapis.com%2Factivity"
            or payload.get("serviceName") != "run.googleapis.com"
            or not closed._instant(HISTORY_START)
            <= closed._instant(event["timestamp"])
            <= closed._instant(until)
        ):
            raise ValueError("phone_schema_job_audit_scope_unknown")
        method = payload.get("methodName", "")
        if method.endswith(("RunJob", "DeleteJob")):
            request = payload.get("request", {})
            if (
                set(request) - {"@type", "name"}
                or request.get("name", "").rsplit("/", 1)[-1] not in known
            ):
                raise ValueError("phone_schema_job_execution_unknown")
            continue
        templates = closed._audit_templates(event, kind="Job")
        response = payload.get("response", {})
        if templates and response.get("kind") != "Job":
            raise ValueError("phone_schema_job_birth_unavailable")
        if templates:
            classified = _job(response, images)
            known[classified["job"]] = classified
    return len(events)


def _revision_history(service: str, state: dict, until: str) -> int:
    reviewed = closed.revision_inventory(
        state["revisions"],
        service=service,
        check=source_capable,
        flag=FLAG,
        closed_key=CLOSED_KEY,
        container_name="drive-worker" if service.endswith("-drive-worker") else None,
    )
    return closed.review_history(
        _events(PROJECT, service, until),
        reviewed,
        project=PROJECT,
        until=until,
        service=service,
        start=HISTORY_START,
        check=source_capable,
        flag=FLAG,
        closed_key=CLOSED_KEY,
        require_retained=True,
        container_name="drive-worker" if service.endswith("-drive-worker") else None,
    )


class Runtime:
    def __init__(self, prepared: dict, primary_image: str):
        self.prepared, self.primary_image = prepared, primary_image

    def owner(self) -> dict:
        owner = LockRuntime().lock_owner()
        return {
            "run_id": str(owner["id"]),
            "run_attempt": owner["run_attempt"],
            "workflow_sha": owner["head_sha"],
            "workflow": owner["path"],
        }

    def submissions(self) -> dict:
        from schema_origin import closed_submissions

        return closed_submissions(
            self.owner(), start=HISTORY_START, source_anchor=SOURCE_ANCHOR
        )

    def snapshot(self) -> dict:
        _authorities()
        budget = importlib.import_module("runtime-capacity-budget")
        profile = json.loads((ROOT / "config/runtime-capacity.json").read_text())
        inventory = budget.collect(profile, "production")
        until = datetime.now(timezone.utc).isoformat()
        services, revisions = {}, {}
        audit_counts = {
            "services": _service_history(
                set(inventory["services"]),
                set(profile["environments"]["production"]["non_database_services"]),
                until,
            )
        }
        images = {self.prepared["image"]: self.prepared["source"]}
        if self.primary_image:
            images[self.primary_image] = self.prepared["primary_sha"]
        for service, state in sorted(inventory["services"].items()):
            audit_counts[service] = _revision_history(service, state, until)
            for row in state["revisions"]:
                item = _revision(row, service, self.prepared["primary_sha"])
                if item["revision"] in revisions or (
                    item["image"] in images and images[item["image"]] != item["source"]
                ):
                    raise ValueError("phone_schema_source_identity_ambiguous")
                revisions[item["revision"]] = item
                images[item["image"]] = item["source"]
            actual = state["service"]
            policy = closed._document(
                [
                    "gcloud",
                    "run",
                    "services",
                    "get-iam-policy",
                    service,
                    f"--project={PROJECT}",
                    f"--region={REGION}",
                    "--format=json",
                ]
            )
            services[service] = {
                "uid": actual["metadata"]["uid"],
                "generation": actual["metadata"]["generation"],
                "controls": controls(actual),
                "iam": iam_fingerprint(policy),
                "traffic": fingerprint(
                    [
                        actual.get("spec", {}).get("traffic"),
                        actual.get("status", {}).get("traffic"),
                    ]
                ),
            }
        jobs = {name: _job(job, images) for name, job in inventory["jobs"].items()}
        audit_counts["jobs"] = _job_history(jobs, images, until)
        return {
            "services": services,
            "revisions": revisions,
            "jobs": jobs,
            "history_start": HISTORY_START,
            "source_anchor": SOURCE_ANCHOR,
            "audit_counts": audit_counts,
            "history_until": until,
        }

    def database(self, installed: bool | None) -> dict:
        from schema_qualification import inspect_database

        return closed.database_evidence(
            PROJECT, inspect=lambda conn: inspect_database(conn, installed)
        )

    def workos(self) -> dict:
        result = closed.qualify(PROJECT)
        if (
            result.get("qualification") != "passed"
            or result.get("sso_activation_qualified") is not False
        ):
            raise ValueError("phone_schema_workos_not_closed")
        return {"qualification": "passed", "digest": fingerprint(result)}

    def reference(self) -> dict:
        with tempfile.TemporaryDirectory(prefix="phone-schema-serving-") as temporary:
            found = _authorities().find_release(
                REPOSITORY,
                "",
                Path(temporary),
                require_live=True,
                environment="production",
            )
        if found is None:
            raise ValueError("phone_schema_healthy_serving_reference_missing")
        run_id, release = found
        return {
            "run_id": str(run_id),
            "source": release["sha"],
            "revision": release["final"]["backend_revision"],
            "digest": fingerprint(release),
        }
