"""Read same-source activation receipts without deploying or granting authority."""

from __future__ import annotations

import ast
import copy
import importlib
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Literal, NotRequired, TypedDict
from zipfile import ZipFile

import production_backend_successor_proof as proof
import production_pending_activation as pending
import production_phone_receipt as phone
import release_artifact_receipts as receipts

Document = dict[str, Any]
ORIGIN = "prod-activation-origin.json"
MUTATION_STEPS = frozenset(
    {
        "Build and pin backend image before lifecycle migration",
        "Install fail-closed account deletion release fence",
        "Apply production DB migrations behind account deletion fence",
        "Deploy backend using Cloud Build",
        "Verify backend candidate readiness and exact-SHA provenance",
        "Deploy frontend using Cloud Build",
        "Deploy and attest private production Drive worker",
        "Promote deployed revisions to production traffic",
        "Roll back backend revision",
        "Roll back frontend revision",
        "Restore production Drive worker after paired release failure",
    }
)


class ActivationOrigin(TypedDict):
    schema_version: Literal[1]
    kind: Literal["production-activation-continuation-origin"]
    sha: str
    scope: str
    original: Document
    candidate: Document
    cold_rollback: Document
    protected_documents: Document
    frontend: NotRequired[Document]


class ContinuationContext(TypedDict):
    schema_version: Literal[1]
    kind: Literal["production-activation-continuation"]
    status: Literal["activated"]
    original: Document
    backend: Document
    cold_rollback: Document
    frontend: NotRequired[Document]
    publication_reconciliation: NotRequired[Document]


@dataclass(frozen=True)
class _Ports:
    repository: str
    api: pending.Api
    governed: pending.Governed
    timestamp: receipts.Timestamp
    run_command: Callable[..., Any]
    timeout: float

    def archive(
        self, run: Document, lane: Document
    ) -> tuple[Document, Document, bytes]:
        artifact, job = receipts.current_attempt_artifact(
            self.repository, run, lane, api=self.api, timestamp=self.timestamp
        )
        archive = receipts.immutable_archive(
            self.repository,
            artifact,
            run_command=self.run_command,
            timeout=self.timeout,
        )
        return artifact, job, archive

    def arguments(self) -> Document:
        return {
            "api": self.api,
            "governed": self.governed,
            "timestamp": self.timestamp,
            "run_command": self.run_command,
            "timeout": self.timeout,
        }


def _require(condition: object, reason: str) -> None:
    if not condition:
        raise receipts.retention.UnsafeState(reason)


def _lane() -> Document:
    return importlib.import_module("uat-retention-maintenance").LANES["production"]


def _load_original(
    run_id: int | str, sha: str, anchor: Document, ports: _Ports
) -> ActivationOrigin:
    _require(
        type(run_id) in {int, str} and bool(re.fullmatch(r"[1-9][0-9]*", str(run_id))),
        "activation continuation original run is invalid",
    )
    run = ports.api(ports.repository, f"runs/{run_id}?exclude_pull_requests=true")
    _require(run.get("id") == int(run_id), "activation original lookup changed run")
    artifact, _job, archive = ports.archive(run, _lane())
    release = phone._document(archive, "prod-release-status.json")
    _require(release.get("sha") == sha, "activation continuation source changed")
    context = pending.pending_context(
        ports.repository,
        run,
        release,
        _lane(),
        operational_anchor=anchor,
        **ports.arguments(),
    )
    _require(
        context["artifact_id"] == artifact["id"]
        and context["artifact_digest"] == artifact["digest"],
        "activation continuation original archive changed",
    )
    mode = phone._document(archive, "prod-protected-document-release.json")
    report = (
        phone._document(archive, "prod-document-reader-compatibility.json")
        if mode["configured"]
        else None
    )
    origin: ActivationOrigin = {
        "schema_version": 1,
        "kind": "production-activation-continuation-origin",
        "sha": sha,
        "scope": release["scope"],
        "original": {
            key: context[key]
            for key in (
                "run_attempt",
                "workflow_sha",
                "artifact_id",
                "artifact_digest",
            )
        }
        | {"run_id": run["id"]},
        "candidate": context["candidate"],
        "cold_rollback": context["cold_rollback"],
        "protected_documents": {"mode": mode, "report": report},
    }
    if release["scope"] == "all":
        origin["frontend"] = {
            "revision": release["final"]["frontend_revision"],
            "sha": sha,
            "run_id": run["id"],
        }
    return origin


def load_original(
    run_id: int | str,
    sha: str,
    *,
    repository: str,
    operational_anchor: Document,
    api: pending.Api,
    governed: pending.Governed,
    timestamp: receipts.Timestamp,
    run_command: Callable[..., Any],
    timeout: float,
) -> ActivationOrigin:
    """Use a freshly qualified current record_anchor; no summary grants authority."""
    try:
        return _load_original(
            run_id,
            sha,
            operational_anchor,
            _Ports(repository, api, governed, timestamp, run_command, timeout),
        )
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise receipts.retention.UnsafeState(
            "activation origin schema is invalid"
        ) from error


def _floor_key() -> str:
    """The lifecycle source contract owns the required migration floor."""
    source = proof.ROOT / "deploy/account-deletion/release_source.py"
    for node in ast.parse(source.read_text()).body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "PHONE_ACTION_MIGRATION"
            for target in node.targets
        ):
            migration = ast.literal_eval(node.value)
            _require(
                isinstance(migration, str)
                and bool(re.fullmatch(r"[0-9]{3}_[a-z0-9_]+\.sql", migration)),
                "activation phone floor is invalid",
            )
            return f"remaining_pre_phone{int(migration[:3])}_count"
    raise receipts.retention.UnsafeState("activation phone floor is unavailable")


def validate_activated(
    origin: ActivationOrigin, activation: Document, current_sha: str
) -> None:
    """Check actual completion for the original backend, never a new deployment."""
    try:
        candidate, retirement = origin["candidate"], activation.get("retirement", {})
        scheduler = activation.get("scheduler", {})
        zero = (
            "remaining_pre_v201_count",
            "remaining_pre_provider_v2_count",
            "remaining_pre_phone425_count",
            _floor_key(),
        )
        _require(
            type(origin.get("schema_version")) is int
            and origin["schema_version"] == 1
            and origin.get("kind") == "production-activation-continuation-origin"
            and type(origin["original"].get("run_id")) is int
            and origin["original"]["run_id"] > 0
            and bool(re.fullmatch(r"[0-9a-f]{40}", str(current_sha)))
            and current_sha == origin["sha"] == candidate["source"]
            and candidate.get("run_id") == str(origin["original"]["run_id"])
            and all(pending._uid(candidate.get(key)) for key in ("uid", "service_uid"))
            and type(activation.get("schema_version")) is int
            and activation["schema_version"] == 1
            and activation.get("kind") == "account-lifecycle-activation"
            and activation.get("status") == "activated"
            and activation.get("sha") == current_sha
            and activation.get("run_id") == str(origin["original"]["run_id"])
            and activation.get("project") == "hushh-pda"
            and activation.get("region") == "us-central1"
            and activation.get("service") == "consent-protocol"
            and activation.get("candidate_revision") == candidate["revision"]
            and activation.get("candidate_uid") == candidate["uid"]
            and activation.get("service_uid") == candidate["service_uid"]
            and type(activation.get("required_provider_contract")) is int
            and activation["required_provider_contract"] == 2
            and activation.get("database_preflight") == "qualified"
            and retirement.get("status") == "retired"
            and retirement.get("phone_admission_floor_required") is True
            and all(
                type(retirement.get(key)) is int and retirement[key] == 0
                for key in zero
            )
            and type(retirement.get("retired_count")) is int
            and retirement["retired_count"] >= 0
            and scheduler.get("status") == "healthy"
            and scheduler.get("checks", {}).get("fresh_attempt_finished") is True
            and scheduler.get("checks", {}).get("http_2xx") is True
            and activation.get("fence_removal") == "confirmed_absent",
            "activation continuation completion is not bound to its original backend",
        )
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise receipts.retention.UnsafeState(
            "activation completion schema is invalid"
        ) from error


def publication_ref(tag: Document) -> str:
    healthy, operational = proof.reference.split(tag["message"], tag["commit"])
    fields = proof.reference.healthy_fields(healthy, tag["commit"])
    stamp = fields["tagged_at"]
    _require(
        operational is None and re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", stamp),
        "activation publication annotation is invalid",
    )
    ref = f"refs/tags/deployed/production/{tag['commit'][:8]}-{stamp}"
    _require(
        tag["tag_object"].splitlines().count("tag " + ref.removeprefix("refs/tags/"))
        == 1,
        "activation publication tag name differs from annotation",
    )
    return ref


def publication_tag(sha: str, revision: str, *, run_id=None, job=None) -> Document:
    """Bound immutable publication discovery; never use the moving latest tag."""
    _require(
        re.fullmatch(r"[0-9a-f]{40}", sha), "activation publication source is invalid"
    )
    prefix = f"refs/tags/deployed/production/{sha[:8]}-"
    raw = proof.reference.git(["ls-remote", "--refs", "origin", prefix + "*"])
    rows = raw.splitlines()
    _require(
        len(raw.encode()) <= 65536 and len(rows) <= 100,
        "activation publication inventory exceeds its bound",
    )
    window = None
    if job is not None:
        steps = [x for x in job["steps"] if x.get("name") == pending.HEALTHY_TAG]
        _require(len(steps) == 1, "activation publication step is ambiguous")
        window = tuple(
            datetime.fromisoformat(str(steps[0].get(k)).replace("Z", "+00:00"))
            for k in ("started_at", "completed_at")
        )
        _require(
            all(at.tzinfo is not None for at in window) and window[0] <= window[1],
            "activation publication time window is invalid",
        )
    matches = []
    for row in rows:
        parts = row.split("\t")
        _require(
            len(parts) == 2 and re.fullmatch(r"[0-9a-f]{40}", parts[0]),
            "activation publication reference is invalid",
        )
        oid, ref = parts
        stamp = ref.removeprefix(prefix)
        _require(
            ref.startswith(prefix) and re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", stamp),
            "activation publication reference name is invalid",
        )
        at = datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        if window and not (
            window[0].timestamp() <= at.timestamp() + 1 and at <= window[1]
        ):
            continue
        tag = proof.read_tag(ref)
        _require(
            tag["tag_oid"] == oid and publication_ref(tag) == ref,
            "activation publication changed during discovery",
        )
        fields = proof.reference.healthy_fields(tag["message"], tag["commit"])
        if tag["commit"] != sha or fields["backend_revision"] != revision:
            continue
        if (
            run_id is not None
            and fields["run"]
            != f"https://github.com/{proof.REPOSITORY}/actions/runs/{run_id}"
        ):
            continue
        matches.append(tag)
    _require(
        len(matches) == 1, "activation immutable publication is missing or ambiguous"
    )
    return matches[0]


def required_steps(scope: str) -> set[str]:
    return (pending.required_steps(scope) - MUTATION_STEPS) | {
        "Require exact-SHA UAT acceptance",
        "Require qualified activation continuation",
        pending.HEALTHY_TAG,
    }


def _gates(job: Document, release: Document, *, publication_failed=False) -> None:
    steps = job.get("steps")
    _require(
        isinstance(steps, list) and all(isinstance(step, dict) for step in steps),
        "activation continuation job steps are missing",
    )
    indexed = {step.get("name"): step for step in steps}
    _require(
        job.get("conclusion") == ("failure" if publication_failed else "success")
        and len(indexed) == len(steps)
        and (
            not publication_failed
            or [
                step.get("name")
                for step in steps
                if step.get("conclusion") == "failure"
            ]
            == [pending.HEALTHY_TAG]
        )
        and all(
            indexed.get(name, {}).get("status") == "completed"
            and indexed[name].get("conclusion")
            == (
                "failure"
                if publication_failed and name == pending.HEALTHY_TAG
                else "success"
            )
            for name in required_steps(release["scope"])
        )
        and all(
            indexed[name].get("status") == "completed"
            and indexed[name].get("conclusion") == "skipped"
            for name in MUTATION_STEPS.intersection(indexed)
        ),
        "activation continuation gates are incomplete or executed a deployment",
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
        and verification.get("account_deletion_activated") == "true"
        and all(classification.get(key) == "false" for key in failures),
        "activation continuation release classification is contradictory",
    )


def _original_from_archive(archive: bytes, ports: _Ports) -> ActivationOrigin:
    origin = phone._document(archive, ORIGIN)
    cold = origin["cold_rollback"]["origin"]
    anchor = proof.load(cold["run_id"], cold["run_attempt"], **ports.arguments())
    _require(anchor["origin"] == cold, "activation continuation cold archive changed")
    expected = _load_original(
        origin["original"]["run_id"], origin["sha"], anchor, ports
    )
    _require(
        origin == expected, "activation origin and original immutable archive differ"
    )
    return expected


def _current_cold(
    archive: bytes,
    run: Document,
    release: Document,
    lane: Document,
    ports: _Ports,
    origin: ActivationOrigin,
) -> Document:
    cold = phone.healthy_anchor(
        ports.repository, run, release, lane, **ports.arguments()
    )
    plan = phone._document(archive, "phone-rollback/plan.json")
    mode = phone._document(archive, "prod-protected-document-release.json")
    _require(
        isinstance(cold, dict)
        and cold.get("mode") == "operational"
        and all(
            cold.get(key) == origin["cold_rollback"][key]
            for key in ("revision", "source", "image", "uid", "runtime_run_id")
        )
        and plan["operational_reference"]["origin"] == origin["cold_rollback"]["origin"]
        and mode == origin["protected_documents"]["mode"],
        "activation continuation changed its actual cold rollback or document mode",
    )
    return cold


def _archive_context(
    run: Document,
    release: Document,
    lane: Document,
    ports: _Ports,
    job: Document,
    archive: bytes,
) -> ContinuationContext:
    publication_failed = run.get("conclusion") == "failure"
    _require(
        run.get("status") == "completed"
        and run.get("conclusion") in {"success", "failure"}
        and ports.governed(run, ports.repository, "production")
        and (run.get("actor") or {}).get("login") != "github-actions[bot]"
        and release.get("status") == "healthy"
        and release.get("scope") in {"backend", "all"}
        and lane == _lane(),
        "activation continuation current origin is unqualified",
    )
    _gates(job, release, publication_failed=publication_failed)
    _require(
        phone._document(archive, "prod-release-status.json") == release,
        "activation continuation status and immutable archive differ",
    )
    origin = _original_from_archive(archive, ports)
    _require(
        run["id"] != origin["original"]["run_id"]
        and release["scope"] == origin["scope"]
        and release["final"]["backend_revision"] == origin["candidate"]["revision"]
        and release["candidate"]["backend_revision"] == origin["candidate"]["revision"],
        "activation continuation replaced the original backend or release scope",
    )
    if origin["scope"] == "all":
        _require(
            release["final"]["frontend_revision"] == origin["frontend"]["revision"]
            and release["candidate"]["frontend_revision"]
            == origin["frontend"]["revision"],
            "activation continuation replaced the original frontend",
        )
    validate_activated(
        origin, phone._document(archive, pending.ACTIVATION), release["sha"]
    )
    cold = _current_cold(archive, run, release, lane, ports, origin)
    context: ContinuationContext = {
        "schema_version": 1,
        "kind": "production-activation-continuation",
        "status": "activated",
        "original": copy.deepcopy(origin["original"]),
        "backend": {
            **copy.deepcopy(origin["candidate"]),
            "sha": origin["sha"],
            "run_id": origin["original"]["run_id"],
        },
        "cold_rollback": cold,
    }
    if origin["scope"] == "all":
        context["frontend"] = copy.deepcopy(origin["frontend"])
    if publication_failed:
        inventory = ports.api(
            ports.repository,
            f"runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100",
        )
        jobs = inventory.get("jobs")
        _require(
            isinstance(jobs, list)
            and 1 <= len(jobs) <= 100
            and inventory.get("total_count") == len(jobs)
            and all(isinstance(item, dict) for item in jobs),
            "activation publication job inventory is incomplete",
        )
        _require(
            sum(item == job for item in jobs) == 1
            and all(
                item.get("status") == "completed"
                and item.get("conclusion") in {"success", "skipped"}
                for item in jobs
                if item != job
            ),
            "activation publication includes another job failure",
        )
        for name in (
            "Validate Production dispatch mode",
            "Deployment security / Verify repository secret clearance",
        ):
            matches = [item for item in jobs if item.get("name") == name]
            _require(
                len(matches) == 1 and matches[0].get("conclusion") == "success",
                "activation publication mandatory preflight did not succeed",
            )
        tag = publication_tag(
            release["sha"],
            release["final"]["backend_revision"],
            run_id=run["id"],
            job=job,
        )
        fields = proof.reference.healthy_fields(tag["message"], tag["commit"])
        _require(
            fields["frontend_revision"] == release["final"]["frontend_revision"],
            "activation publication frontend differs from its receipt",
        )
        fresh = ports.api(
            ports.repository, f"runs/{run['id']}?exclude_pull_requests=true"
        )
        _require(
            all(
                fresh.get(k) == run.get(k)
                for k in ("id", "run_attempt", "head_sha", "status", "conclusion")
            ),
            "activation publication attempt changed",
        )
        context["publication_reconciliation"] = {
            "run_id": run["id"],
            "attempt": run["run_attempt"],
            "ref": publication_ref(tag),
            "tag_oid": tag["tag_oid"],
            "classification": "activated_with_verified_publication",
        }
    return context


def archive_context(
    repository: str,
    run: Document,
    release: Document,
    lane: Document,
    *,
    api: pending.Api,
    governed: pending.Governed,
    timestamp: receipts.Timestamp,
    run_command: Callable[..., Any],
    timeout: float,
) -> ContinuationContext | None:
    """Only this full join permits consumers to use original backend provenance."""
    try:
        ports = _Ports(repository, api, governed, timestamp, run_command, timeout)
        _artifact, job, archive = ports.archive(run, lane)
        _require(
            phone._document(archive, "prod-release-status.json") == release,
            "activation continuation status and immutable archive differ",
        )
        with ZipFile(BytesIO(archive)) as bundle:
            if not receipts._member_names(
                ORIGIN, allow_legacy_production=True
            ).intersection(bundle.namelist()):
                return None
        return _archive_context(
            copy.deepcopy(run),
            copy.deepcopy(release),
            lane,
            ports,
            job,
            archive,
        )
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise receipts.retention.UnsafeState(
            "activation continuation schema is invalid"
        ) from error
