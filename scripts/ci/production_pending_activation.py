"""Read a pending retirement receipt without granting healthy-release authority."""

from __future__ import annotations

import copy
import importlib
import re
from collections.abc import Callable
from typing import Any, Literal, TypedDict

import production_phone_receipt as phone
import release_artifact_receipts as receipts

Document = dict[str, Any]
Api = Callable[[str, str], Document]
Governed = Callable[[Document, str, str], bool]
WORKFLOW = ".github/workflows/deploy-production.yml"
ACTIVATION = "prod-account-deletion-activation.json"
HEALTHY_TAG = "Tag this release as last known good"
FRONTEND_STEPS = frozenset(
    {
        "Verify production frontend deployment provenance",
        "Post-deploy frontend runtime health gate",
        "Verify production native passkey domain associations",
    }
)


class PendingRevision(TypedDict):
    revision: str
    uid: str
    source: str
    traffic_percent: Literal[0]
    tags: list[str]


class PendingRetirementContext(TypedDict):
    schema_version: Literal[1]
    kind: Literal["production-pending-retirement"]
    status: Literal["pending_activation"]
    healthy_release: Literal[False]
    release_run_id: int
    run_attempt: int
    workflow_sha: str
    release_sha: str
    artifact_id: int
    artifact_digest: str
    candidate: Document
    cold_rollback: Document
    pending_revisions: list[PendingRevision]


def _require(condition: object, reason: str) -> None:
    if not condition:
        raise receipts.retention.UnsafeState(reason)


def required_steps(scope: str) -> set[str]:
    """Compose the existing production owner, excluding its healthy-tag write."""
    owner = importlib.import_module("uat-retention-maintenance")
    required = set(owner.REQUIRED_PRODUCTION_STEPS) - {HEALTHY_TAG}
    required.update(phone.PHONE_STEPS)
    required.update(
        {
            "Deploy backend using Cloud Build",
            "Verify backend candidate readiness and exact-SHA provenance",
            "Promote deployed revisions to production traffic",
        }
    )
    return required - FRONTEND_STEPS if scope == "backend" else required


def _origin(
    repository: str,
    run: Document,
    release: Document,
    lane: Document,
    anchor: Document,
    governed: Governed,
) -> None:
    _require(
        run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and run.get("path") == WORKFLOW
        and governed(run, repository, "production")
        and type(run.get("id")) is int
        and run["id"] > 0
        and type(run.get("run_attempt")) is int
        and run["run_attempt"] > 0
        and bool(re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", ""))))
        and all(
            type((run.get(key) or {}).get("id")) is int
            for key in ("repository", "head_repository")
        )
        and lane.get("prefix") == "prod"
        and lane.get("workflow") == "deploy-production.yml"
        and lane.get("deploy_job") == "Deploy Production Scope"
        and lane.get("upload_step") == "Upload production deploy artifacts"
        and isinstance(anchor, dict)
        and bool(anchor)
        and release.get("status") == "pending_activation"
        and release.get("scope") in {"backend", "all"}
        and release.get("sha")
        == anchor.get("sealed_boundary", {})
        .get("checkpoint", {})
        .get("plan", {})
        .get("primary_sha"),
        "pending activation origin or operational source is unqualified",
    )
    receipts.validate_revision_names(release)
    _require(
        release.get("candidate", {}).get("backend_revision")
        == release["final"]["backend_revision"],
        "pending activation primary candidate is not serving",
    )


def _gates(job: Document, release: Document) -> None:
    steps = job.get("steps")
    _require(
        isinstance(steps, list) and all(isinstance(step, dict) for step in steps),
        "pending activation job steps are missing",
    )
    indexed = {step.get("name"): step for step in steps}
    _require(
        job.get("conclusion") == "success"
        and len(indexed) == len(steps)
        and all(
            indexed.get(name, {}).get("status") == "completed"
            and indexed[name].get("conclusion") == "success"
            for name in required_steps(release["scope"])
        )
        and indexed.get(HEALTHY_TAG, {}).get("status") == "completed"
        and indexed[HEALTHY_TAG].get("conclusion") == "skipped",
        "pending activation release gates are incomplete or claim a healthy tag",
    )
    verification, classification = (
        release.get("verification", {}),
        release.get("classification", {}),
    )
    checks = [
        "runtime_parity",
        "connected_systems",
        "backend_provenance",
        "backend_health",
        "account_deletion_activation",
    ]
    failures = ["release_failed", "promote_failed", "backend_provenance_failed"]
    if release["scope"] == "all":
        checks += [
            "frontend_provenance",
            "frontend_health",
            "passkey_domain_associations",
        ]
        failures += ["frontend_provenance_failed"]
    _require(
        all(verification.get(key) == "success" for key in checks)
        and verification.get("account_deletion_activated") == "false"
        and all(classification.get(key) == "false" for key in failures),
        "pending activation release classification is contradictory",
    )


def _uid(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 256


def _rows(
    retirement: Document, activation: Document, anchor: Document
) -> list[PendingRevision]:
    rows, count = retirement.get("pending_revisions"), retirement.get("pending_count")
    _require(
        retirement.get("status") == "pending"
        and retirement.get("phone_admission_floor_required") is True
        and type(count) is int
        and isinstance(rows, list)
        and 0 < count == len(rows) < 500,
        "pending activation retained inventory is incomplete",
    )
    names, uids = set(), set()
    for row in rows:
        _require(
            isinstance(row, dict), "pending activation retained identity is invalid"
        )
        name, uid, tags = row.get("revision"), row.get("uid"), row.get("tags")
        _require(
            isinstance(name, str)
            and bool(re.fullmatch(r"consent-protocol-[a-z0-9-]+", name))
            and name not in names
            and name not in {activation["candidate_revision"], anchor["revision"]}
            and _uid(uid)
            and uid not in uids
            and uid not in {activation["candidate_uid"], anchor["uid"]}
            and bool(re.fullmatch(r"[0-9a-f]{40}", str(row.get("source", ""))))
            and type(row.get("traffic_percent")) is int
            and row["traffic_percent"] == 0
            and isinstance(tags, list)
            and len(tags) <= 100
            and all(
                isinstance(tag, str)
                and bool(re.fullmatch(r"[a-z][a-z0-9-]{0,62}", tag))
                for tag in tags
            )
            and len(set(tags)) == len(tags),
            "pending activation retained identity or zero traffic is unqualified",
        )
        names.add(name)
        uids.add(uid)
    return copy.deepcopy(rows)


def _activation(
    value: Document, run: Document, release: Document, anchor: Document
) -> list[PendingRevision]:
    _require(
        type(value.get("schema_version")) is int
        and value["schema_version"] == 1
        and value.get("kind") == "account-lifecycle-activation"
        and value.get("status") == "pending_activation"
        and value.get("project") == "hushh-pda"
        and value.get("region") == "us-central1"
        and value.get("service") == "consent-protocol"
        and value.get("sha") == release["sha"]
        and value.get("run_id") == str(run["id"])
        and value.get("candidate_revision") == release["final"]["backend_revision"]
        and _uid(value.get("candidate_uid"))
        and _uid(value.get("service_uid"))
        and value["service_uid"] == anchor.get("runtime", {}).get("service_uid")
        and type(value.get("required_provider_contract")) is int
        and value["required_provider_contract"] == 2
        and value.get("database_preflight") == "qualified"
        and value.get("fence_required") is True
        and not {"scheduler", "cleanup_health", "fence_removal"}.intersection(value),
        "pending activation actual producer evidence is unqualified",
    )
    return _rows(value.get("retirement", {}), value, anchor)


def _phone(
    archive: bytes, run: Document, release: Document, operational: Document
) -> Document:
    plan = phone._document(archive, "phone-rollback/plan.json")
    qualified = phone._document(archive, "phone-rollback/qualified.json")
    cold = phone.qualified_reader(qualified, plan, release["sha"], run)
    runtime = phone.operational_runtime(qualified, plan)
    binding = plan["operational_reference"]
    _require(
        all(
            cold[key] == operational.get(key) for key in ("revision", "source", "image")
        )
        and runtime["uid"] == operational.get("uid")
        and runtime["runtime_run_id"] == operational.get("origin", {}).get("run_id")
        and binding.get("origin") == operational.get("origin")
        and binding.get("runtime") == operational.get("runtime")
        and plan.get("recovery_enabled") is False
        and release.get("phone_rollback", {}).get("revision") == cold["revision"]
        and release["phone_rollback"].get("qualification") == "success",
        "pending activation phone proof is not the supplied operational anchor",
    )
    mode = phone._document(archive, "prod-protected-document-release.json")
    report = (
        phone._document(archive, "prod-document-reader-compatibility.json")
        if mode.get("configured") is True
        else None
    )
    phone.qualified_documents(mode, report, cold, release["sha"])
    return {**cold, **runtime, "origin": copy.deepcopy(operational["origin"])}


def _read_context(
    repository: str,
    run: Document,
    release: Document,
    lane: Document,
    *,
    operational_anchor: Document,
    api: Api,
    governed: Governed,
    timestamp: receipts.Timestamp,
    run_command: Callable[..., Any],
    timeout: float,
) -> PendingRetirementContext:
    """The explicit operational anchor must already be qualified by record_anchor."""
    run, release = copy.deepcopy(run), copy.deepcopy(release)
    _origin(repository, run, release, lane, operational_anchor, governed)
    artifact, job = receipts.current_attempt_artifact(
        repository, run, lane, api=api, timestamp=timestamp
    )
    _gates(job, release)
    archive = receipts.immutable_archive(
        repository, artifact, run_command=run_command, timeout=timeout
    )
    _require(
        phone._document(archive, "prod-release-status.json") == release,
        "pending activation status and immutable archive differ",
    )
    activation = phone._document(archive, ACTIVATION)
    pending = _activation(activation, run, release, operational_anchor)
    rollback = _phone(archive, run, release, operational_anchor)
    refreshed = api(repository, f"runs/{run['id']}?exclude_pull_requests=true")
    _require(
        all(
            refreshed.get(key) == run.get(key)
            for key in (
                "id",
                "run_attempt",
                "head_sha",
                "head_branch",
                "path",
                "status",
                "conclusion",
                "actor",
            )
        )
        and governed(refreshed, repository, "production"),
        "pending activation attempt changed during lookup",
    )
    return {
        "schema_version": 1,
        "kind": "production-pending-retirement",
        "status": "pending_activation",
        "healthy_release": False,
        "release_run_id": run["id"],
        "run_attempt": run["run_attempt"],
        "workflow_sha": run["head_sha"],
        "release_sha": release["sha"],
        "artifact_id": artifact["id"],
        "artifact_digest": artifact["digest"],
        "candidate": {
            "revision": activation["candidate_revision"],
            "uid": activation["candidate_uid"],
            "service_uid": activation["service_uid"],
            "source": release["sha"],
            "run_id": str(run["id"]),
        },
        "cold_rollback": rollback,
        "pending_revisions": pending,
    }


def pending_context(
    repository: str,
    run: Document,
    release: Document,
    lane: Document,
    *,
    operational_anchor: Document,
    api: Api,
    governed: Governed,
    timestamp: receipts.Timestamp,
    run_command: Callable[..., Any],
    timeout: float,
) -> PendingRetirementContext:
    """Consume an explicit record_anchor result; malformed evidence never falls back."""
    try:
        return _read_context(
            repository,
            run,
            release,
            lane,
            operational_anchor=operational_anchor,
            api=api,
            governed=governed,
            timestamp=timestamp,
            run_command=run_command,
            timeout=timeout,
        )
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise receipts.retention.UnsafeState(
            "pending activation receipt schema is invalid"
        ) from error
