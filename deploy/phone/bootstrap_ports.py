# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bounded production cold-qualification ports; existing lock/control authorities."""

from __future__ import annotations

import copy
import hashlib
import importlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Protocol

import plan
from revision_qualification import PROJECT, REGION, SERVICE, cloud_document

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = ".github/workflows/deploy-production.yml"
Document = dict[str, Any]


class Ports(Protocol):
    def service(self) -> Document: ...
    def revision(self, name: str) -> Document: ...
    def iam(self) -> Document: ...
    def mutation(self, flag: str) -> None: ...
    def lock_owner(self) -> Document: ...


def _authorities():
    # Runtime-only discovery keeps the leaf import-safe and reuses authority owners.
    directory = str(ROOT / "scripts/ci")
    if directory not in sys.path:
        sys.path.insert(0, directory)
    return importlib.import_module("uat-retention-maintenance")


def _api(endpoint: str) -> Document:
    result = json.loads(
        plan.qualify_image.run(["gh", "api", f"repos/{REPOSITORY}/actions/{endpoint}"])
    )
    if not isinstance(result, dict):
        raise ValueError("phone_bootstrap_api_invalid")
    return result


def controls(service: Document) -> str:
    """Protect operational settings; revision provenance is expected to change."""
    value = copy.deepcopy(service)
    labels = value.setdefault("metadata", {}).setdefault("labels", {})
    for key in ("deploy-sha", "deploy-source", "github-run-id"):
        labels.pop(key, None)
    _authorities()
    return importlib.import_module("production-capacity-bridge").service_controls(value)


def iam_fingerprint(policy: Document) -> str:
    return hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest()


class Runtime:
    def service(self) -> Document:
        return cloud_document("services", SERVICE)

    def revision(self, name: str) -> Document:
        return cloud_document("revisions", name)

    def iam(self) -> Document:
        policy = json.loads(
            plan.qualify_image.run(
                [
                    "gcloud",
                    "run",
                    "services",
                    "get-iam-policy",
                    SERVICE,
                    f"--project={PROJECT}",
                    f"--region={REGION}",
                    "--format=json",
                ]
            )
        )
        if not isinstance(policy, dict) or not isinstance(policy.get("bindings"), list):
            raise ValueError("phone_bootstrap_iam_invalid")
        return policy

    def mutation(self, flag: str) -> None:
        _authorities().retention.run_command(
            [
                "gcloud",
                "run",
                "services",
                "update-traffic",
                SERVICE,
                f"--project={PROJECT}",
                f"--region={REGION}",
                flag,
                "--quiet",
            ],
            timeout=90,
        )

    def lock_owner(self) -> Document:
        owner = _api(f"runs/{os.environ['GITHUB_RUN_ID']}")
        authority = _authorities()
        expected = {
            WORKFLOW: ("deploy", "Deploy Production Scope"),
            ".github/workflows/capacity-maintenance.yml": (
                "production",
                "Production bounded revision cleanup",
            ),
        }.get(owner.get("path"))
        if (
            not expected
            or os.environ.get("GITHUB_JOB") != expected[0]
            or str(owner.get("id")) != os.environ["GITHUB_RUN_ID"]
            or owner.get("status") != "in_progress"
            or owner.get("run_attempt") != int(os.environ["GITHUB_RUN_ATTEMPT"])
        ):
            raise ValueError("phone_bootstrap_production_lock_unproved")
        jobs = _api(
            f"runs/{owner['id']}/attempts/{owner['run_attempt']}/jobs?per_page=100"
        )
        matching = [
            row
            for row in jobs.get("jobs", [])
            if row.get("name") == expected[1]
            and row.get("status") == "in_progress"
            and row.get("run_id") == owner["id"]
            and row.get("run_attempt") == owner["run_attempt"]
            and row.get("head_sha") == owner["head_sha"]
            and row.get("head_branch") == owner["head_branch"]
        ]
        if jobs.get("total_count") != len(jobs.get("jobs", [])) or len(matching) != 1:
            raise ValueError("phone_bootstrap_production_job_unproved")
        # The existing policy checks completed origins. Only adapt that status
        # after independently proving this exact live job; this grants no health.
        origin = {**owner, "status": "completed"}
        if not authority.governed_dispatch(
            origin, REPOSITORY, "production", workflow=Path(owner["path"]).name
        ):
            raise ValueError("phone_bootstrap_production_lock_unproved")
        return owner


def cleanup_identity(revision: Document, intent: Document) -> None:
    """Cleanup needs immutable origin ownership, not a successful health check."""
    metadata = revision.get("metadata", {})
    labels = metadata.get("labels", {})
    containers = revision.get("spec", {}).get("containers", [])
    if (
        not metadata.get("uid")
        or len(containers) != 1
        or containers[0].get("image") != intent["image"]
        or any(
            labels.get(key) != value
            for key, value in {
                "serving.knative.dev/service": SERVICE,
                "deploy-env": "production",
                "deploy-sha": intent["source"],
                "deploy-source": "deploy-production-phone-rollback",
                "github-run-id": intent["origin"]["run_id"],
            }.items()
        )
    ):
        raise ValueError("phone_bootstrap_initial_revision_not_owned")


def _positive(service: Document) -> list[list[Any]]:
    traffic = _authorities().retention.traffic_state(service)
    rows = sorted([name, percent] for name, percent, _ in traffic if percent)
    if len(rows) != 1 or rows[0][1] != 100:
        raise ValueError("phone_bootstrap_serving_traffic_ambiguous")
    return rows


def _attest(service: Document, record: Document, ports: Ports) -> None:
    if (
        service.get("metadata", {}).get("uid") != record["service_uid"]
        or _positive(service) != record["serving"]
        or controls(service) != record["controls"]
        or iam_fingerprint(ports.iam()) != record["iam"]
    ):
        raise ValueError("phone_bootstrap_operational_controls_changed")


def _tagged(service: Document, tag: str, revision: str) -> bool:
    rows = [
        row for row in _authorities().retention.traffic_state(service) if row[2] == tag
    ]
    desired = [
        row
        for row in service.get("spec", {}).get("traffic", [])
        if row.get("tag") == tag
    ]
    desired_matches = len(desired) == 1 and (
        desired[0].get("revisionName") == revision
        and not desired[0].get("latestRevision")
        and int(desired[0].get("percent", 0)) == 0
    )
    if (
        (rows and rows != [(revision, 0, tag)])
        or bool(rows) != bool(desired)
        or (desired and not desired_matches)
    ):
        raise ValueError("phone_bootstrap_health_tag_owned_elsewhere")
    return bool(rows)


def _without_tag(service: Document, tag: str) -> tuple:
    retention = _authorities().retention
    desired = [
        row
        for row in service.get("spec", {}).get("traffic", [])
        if row.get("tag") != tag
    ]
    return tuple(
        row for row in retention.traffic_state(service) if row[2] != tag
    ), json.dumps(desired, sort_keys=True)


def begin(
    prepared: Document,
    before: Document,
    before_iam: Document,
    *,
    state: Path,
    ports: Ports,
) -> Document:
    """Record ownership before the build can create its public health route."""
    owner = ports.lock_owner()
    tag = f"phone-rollback-{prepared['run_id']}"
    if (
        prepared.get("mode") != "cold"
        or prepared.get("recovery_enabled") is not False
        or prepared["run_id"] != str(owner["id"])
        or state.exists()
        or state.is_symlink()
        or any(row[2] == tag for row in _authorities().retention.traffic_state(before))
        or any(
            row.get("tag") == tag for row in before.get("spec", {}).get("traffic", [])
        )
    ):
        raise ValueError("phone_bootstrap_initial_lease_refused")
    result = {
        "schema_version": 1,
        "kind": "phone-cold-health-lease",
        "project": PROJECT,
        "region": REGION,
        "service": SERVICE,
        "workflow_sha": owner["head_sha"],
        "status": "pending",
        "tag": tag,
        "origin": {"run_id": str(owner["id"]), "run_attempt": owner["run_attempt"]},
        "source": prepared["source"],
        "image": prepared["image"],
        "service_uid": before["metadata"]["uid"],
        "serving": _positive(before),
        "controls": controls(before),
        "iam": iam_fingerprint(before_iam),
        "traffic": _without_tag(before, tag),
        "pending_mutation": "stage_cold",
    }
    current = ports.service()
    _attest(current, result, ports)
    if _without_tag(current, tag) != _without_tag(before, tag):
        raise ValueError("phone_bootstrap_initial_traffic_changed")
    _authorities().retention.atomic_state(state, result)
    return result


def retire_initial(*, state: Path, completed: bool, ports: Ports) -> Document:
    """Remove only this build's proven route; never infer success after an unknown build."""
    owner = ports.lock_owner()
    intent = json.loads(state.read_text())
    if (
        intent["schema_version"] != 1
        or intent["project"] != PROJECT
        or intent["region"] != REGION
        or intent["service"] != SERVICE
        or intent["workflow_sha"] != owner["head_sha"]
        or intent["origin"]
        != {
            "run_id": str(owner["id"]),
            "run_attempt": owner["run_attempt"],
        }
    ):
        raise ValueError("phone_bootstrap_initial_lease_owner_changed")
    current, tag = ports.service(), intent["tag"]
    _attest(current, intent, ports)
    routes = [
        row for row in _authorities().retention.traffic_state(current) if row[2] == tag
    ]
    if routes:
        revision = ports.revision(routes[0][0])
        cleanup_identity(revision, intent)
        if not _tagged(current, tag, revision["metadata"]["name"]):
            raise ValueError("phone_bootstrap_initial_tag_unproved")
        intent["pending_mutation"] = "remove_tag"
        _authorities().retention.atomic_state(state, intent)
        ports.mutation(f"--remove-tags={tag}")
    after = ports.service()
    _attest(after, intent, ports)
    restored = json.loads(json.dumps(_without_tag(after, tag))) == intent["traffic"]
    if (
        not completed
        or not restored
        or any(row[2] == tag for row in _authorities().retention.traffic_state(after))
        or any(
            row.get("tag") == tag for row in after.get("spec", {}).get("traffic", [])
        )
    ):
        raise RuntimeError("phone_bootstrap_initial_lease_requires_reconciliation")
    intent.update(
        status="retired",
        pending_mutation=None,
        revision=routes[0][0] if routes else None,
    )
    _authorities().retention.atomic_state(state, intent)
    return intent
