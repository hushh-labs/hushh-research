"""Bind frontend-only releases to one ordinary, activated backend owner."""

from __future__ import annotations

import copy
import importlib
import math
import re
import tempfile
from io import BytesIO
from pathlib import Path
from typing import NotRequired, TypedDict
from zipfile import ZipFile

import production_activation_continuation as activation
import production_backend_successor as tag_reference
import production_phone_receipt as phone
import release_artifact_receipts as receipts
import retention_admission


class BackendIdentity(TypedDict):
    revision: str
    uid: str
    service_uid: str
    source: str
    sha: str
    run_id: int


class InheritedBackend(TypedDict):
    backend: BackendIdentity
    backend_release: dict
    phone_anchor: NotRequired[dict | None]
    restoration_runtime: NotRequired[dict]


def _require(condition, reason):
    if not condition:
        raise receipts.retention.UnsafeState("Backend inheritance: " + reason)


def _clean(release):
    return {key: value for key, value in release.items() if not key.startswith("_maintenance_")}


_RUN_FIELDS = ("id", "run_attempt", "head_sha", "status", "conclusion", "path", "event", "head_branch")


def _same_run(fresh, expected):
    return all(fresh.get(key) == expected.get(key) for key in _RUN_FIELDS)


def _selector(release, run):
    pointer = release.get("backend_origin")
    _require(
        release.get("scope") == "frontend"
        and release.get("status") == "healthy"
        and "phone_rollback" not in release
        and isinstance(pointer, dict)
        and set(pointer) == {"run_id", "source", "revision", "uid", "service_uid"},
        "frontend receipt has no exact backend selector",
    )
    _require(
        isinstance(pointer["run_id"], str)
        and bool(re.fullmatch(r"[1-9][0-9]*", pointer["run_id"]))
        and int(pointer["run_id"]) != run["id"]
        and isinstance(pointer["source"], str)
        and bool(re.fullmatch(r"[0-9a-f]{40}", pointer["source"]))
        and isinstance(pointer["revision"], str)
        and bool(re.fullmatch(r"consent-protocol-[a-z0-9-]+", pointer["revision"]))
        and all(
            isinstance(pointer[key], str) and 0 < len(pointer[key]) <= 256
            for key in ("uid", "service_uid")
        )
        and release.get("final", {}).get("backend_revision") == pointer["revision"],
        "backend selector is invalid or names another final revision",
    )
    return pointer


def _archive(repository, run, lane, *, api, timestamp, run_command, timeout):
    artifact, _job = receipts.current_attempt_artifact(
        repository, run, lane, api=api, timestamp=timestamp
    )
    return receipts.immutable_archive(
        repository, artifact, run_command=run_command, timeout=timeout
    )


def _identity(pointer, release, archive):
    report = phone._document(archive, activation.pending.ACTIVATION)
    _require(
        release.get("sha") == pointer["source"]
        and release.get("candidate", {}).get("backend_revision") == pointer["revision"]
        and release.get("final", {}).get("backend_revision") == pointer["revision"]
        and report.get("candidate_revision") == pointer["revision"]
        and report.get("candidate_uid") == pointer["uid"]
        and report.get("service_uid") == pointer["service_uid"],
        "backend source, candidate or activation identity differs",
    )
    candidate = {
        "revision": pointer["revision"],
        "uid": report["candidate_uid"],
        "service_uid": report["service_uid"],
        "source": release["sha"],
        "run_id": pointer["run_id"],
    }
    activation.validate_activated(
        {
            "schema_version": 1,
            "kind": "production-activation-continuation-origin",
            "sha": release["sha"],
            "original": {"run_id": int(pointer["run_id"])},
            "candidate": candidate,
        },
        report,
        release["sha"],
    )
    return {**candidate, "run_id": int(pointer["run_id"]), "sha": release["sha"]}


def _auth_acceptance(current, pointer, run):
    exception = current.get("predecessor_exception")
    if not isinstance(exception, dict):
        return None
    authority = exception.get("authority")
    if not isinstance(authority, dict):
        _require("backend_acceptance_origin" not in exception, "unbound acceptance origin")
        return None
    acceptance = exception.get("backend_acceptance_origin")
    if authority.get("frontend_auth_domain_refresh") is not True:
        _require(acceptance is None, "acceptance origin lacks auth repair authority")
        return None
    refresh = importlib.import_module("production_auth_domain_refresh")
    baseline = exception.get("baseline", {})
    backend = baseline.get("backend", {})
    frontend = baseline.get("frontend", {})
    _require(
        exception.get("schema_version") == 1
        and exception.get("kind") == "manual-production-predecessor-exception"
        and exception.get("scope") == "frontend"
        and exception.get("ordinary_promotion_evidence") is False
        and current.get("scope") == "frontend"
        and current.get("sha") == refresh.CANDIDATE
        and authority.get("mode") == "manual-emergency"
        and authority.get("application_sha") == refresh.CANDIDATE
        and authority.get("run_id") == str(run.get("id"))
        and authority.get("run_attempt") == str(run.get("run_attempt"))
        and authority.get("workflow_sha") == run.get("head_sha")
        and backend.get("source") == refresh.SOURCE
        and backend.get("image") == refresh.IMAGES["backend"]
        and backend.get("revision") == pointer["revision"]
        and backend.get("revision_uid") == pointer["uid"]
        and backend.get("service_uid") == pointer["service_uid"]
        and frontend.get("source") == refresh.SOURCE
        and frontend.get("image") == refresh.IMAGES["frontend"],
        "auth repair exception is not bound to this exact frontend release",
    )
    expected = {
        "schema_version", "kind", "run_id", "run_attempt", "workflow_sha",
        "source", "backend", "backend_image",
    }
    _require(
        isinstance(acceptance, dict)
        and frozenset(acceptance)
        in {frozenset(expected), frozenset(expected | {"operational_reference"})}
        and type(acceptance.get("schema_version")) is int
        and acceptance["schema_version"] == 1
        and acceptance.get("kind") == "production-auth-domain-backend-acceptance"
        and type(acceptance.get("run_id")) is int
        and acceptance["run_id"] > 0
        and acceptance["run_id"] not in {run.get("id"), int(pointer["run_id"])}
        and type(acceptance.get("run_attempt")) is int
        and acceptance["run_attempt"] > 0
        and bool(re.fullmatch(r"[0-9a-f]{40}", str(acceptance.get("workflow_sha", ""))))
        and acceptance.get("source") == refresh.SOURCE == pointer["source"]
        and acceptance.get("backend") == pointer,
        "auth repair acceptance origin is malformed or differs from backend_origin",
    )
    if "operational_reference" in acceptance:
        operational = acceptance["operational_reference"]
        _require(
            isinstance(operational, dict)
            and set(operational)
            == {"ref", "tag_oid", "commit", "healthy_message", "anchor_record", "tag_object"}
            and operational.get("ref") == tag_reference.REF
            and operational.get("commit") == refresh.SOURCE
            and isinstance(operational.get("tag_object"), str)
            and len(operational["tag_object"].encode()) <= 131072,
            "auth repair operational reference is malformed",
        )
        tag = tag_reference.tag_identity(operational["tag_object"])
        healthy, anchor_record = tag_reference.split(tag["message"], tag["commit"])
        _require(
            tag["tag_oid"] == operational.get("tag_oid")
            and tag["commit"] == operational.get("commit")
            and healthy == operational.get("healthy_message")
            and anchor_record == operational.get("anchor_record")
            and (
                anchor_record is None
                or (
                    anchor_record.get("source") == refresh.ACTIVE_ANCHOR_SOURCE
                    and anchor_record.get("healthy_commit") == refresh.SOURCE
                )
            ),
            "auth repair operational reference tag binding is invalid",
        )
    _require(
        acceptance["backend_image"] == refresh.IMAGES["backend"]
        and backend.get("image") == acceptance["backend_image"],
        "auth repair backend image differs from its accepted restoration",
    )
    return acceptance


def _accepted_restoration(
    repository, run, acceptance, pointer, owner, *, api, governed, timestamp,
    run_command, timeout,
):
    accepted_run = api(repository, f"runs/{acceptance['run_id']}")
    _require(
        accepted_run.get("id") == acceptance["run_id"]
        and accepted_run.get("run_attempt") == acceptance["run_attempt"]
        and accepted_run.get("head_sha") == acceptance["workflow_sha"]
        and accepted_run.get("path") == ".github/workflows/deploy-production.yml"
        and accepted_run.get("head_branch") == "main"
        and accepted_run.get("event") == "workflow_dispatch"
        and accepted_run.get("status") == "completed"
        and accepted_run.get("conclusion") == "success"
        and governed(accepted_run, repository, "production"),
        "accepted restoration run is not the exact governed Main continuation",
    )
    anchors = []
    with tempfile.TemporaryDirectory(prefix="backend-acceptance-") as directory:
        found = owner.find_release(
            repository,
            str(acceptance["run_id"]),
            Path(directory),
            require_live=False,
            environment="production",
            on_phone_rollback=anchors.append,
        )
    release = found[1] if found is not None else {}
    identity = release.get("_maintenance_backend_identity", {})
    runtime = release.get("_maintenance_restoration_runtime", {})
    actual = {
        "run_id": str(identity.get("run_id", "")),
        "source": identity.get("source"),
        "revision": identity.get("revision"),
        "uid": identity.get("uid"),
        "service_uid": identity.get("service_uid"),
    }
    _require(
        found is not None
        and found[0] == acceptance["run_id"]
        and not anchors
        and release.get("status") == "healthy"
        and release.get("scope") == "all"
        and release.get("sha") == acceptance["source"]
        and release.get("sha") == pointer["source"]
        and isinstance(release.get("production_restoration"), dict)
        and isinstance(release.get("restoration_activation"), dict)
        and "backend_origin" not in release
        and "predecessor_exception" not in release
        and isinstance(runtime, dict)
        and set(runtime) == {"backend", "frontend"}
        and runtime.get("backend") == identity
        and actual == pointer
        and identity.get("sha") == pointer["source"]
        and identity.get("image") == acceptance["backend_image"]
        and release.get("final", {}).get("backend_revision") == pointer["revision"],
        "canonical restoration acceptance does not prove the physical backend",
    )
    fresh = api(repository, f"runs/{accepted_run['id']}")
    fresh_frontend = api(repository, f"runs/{run['id']}")
    _require(
        _same_run(fresh, accepted_run) and _same_run(fresh_frontend, run),
        "accepted restoration attempt changed during inheritance",
    )
    return {
        "backend": identity,
        "backend_release": _clean(release),
        "restoration_runtime": identity,
    }


def _verify_frontend_archive(repository, run, current, lane, *, api, timestamp, run_command, timeout):
    archive = _archive(
        repository, run, lane, api=api, timestamp=timestamp,
        run_command=run_command, timeout=timeout,
    )
    _require(
        phone._document(archive, "prod-release-status.json") == current,
        "frontend archive changed",
    )


def _inherit_auth_frontend(
    repository, run, current, lane, acceptance, owner, *, api, governed,
    timestamp, run_command, timeout,
):
    _require(
        run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and governed(run, repository, "production"),
        "auth frontend run is not completed and governed",
    )
    _verify_frontend_archive(
        repository, run, current, lane, api=api, timestamp=timestamp,
        run_command=run_command, timeout=timeout,
    )
    pointer = current["backend_origin"]
    return _accepted_restoration(
        repository, run, acceptance, pointer, owner, api=api,
        governed=governed, timestamp=timestamp, run_command=run_command,
        timeout=timeout,
    )


def _inherit(repository, run, current, lane, *, api, governed, timestamp, run_command, timeout):
    owner = importlib.import_module("uat-retention-maintenance")
    pointer = _selector(current, run)
    _require(lane["project"] == "hushh-pda" and timeout > 0, "invalid production boundary")
    acceptance = _auth_acceptance(current, pointer, run)
    if acceptance is not None:
        return _inherit_auth_frontend(
            repository, run, current, lane, acceptance, owner, api=api,
            governed=governed, timestamp=timestamp, run_command=run_command,
            timeout=timeout,
        )
    original_run = api(repository, f"runs/{pointer['run_id']}")
    for envelope in (run, original_run):
        _require(
            envelope.get("status") == "completed"
            and envelope.get("conclusion") in {"success", "failure"}
            and governed(envelope, repository, "production"),
            "release origin is not completed and governed",
        )
    _require(original_run.get("id") == int(pointer["run_id"]), "original run lookup changed")
    ports = {
        "api": api,
        "timestamp": timestamp,
        "run_command": run_command,
        "timeout": timeout,
    }
    current_archive = _archive(repository, run, lane, **ports)
    _require(
        phone._document(current_archive, "prod-release-status.json") == current,
        "frontend archive changed",
    )
    archive = _archive(repository, original_run, lane, **ports)
    original = phone._document(archive, "prod-release-status.json")
    with ZipFile(BytesIO(archive)) as bundle:
        _require(
            activation.ORIGIN not in bundle.namelist(),
            "continuation is not an ordinary backend owner",
        )
    _require(
        original.get("scope") in {"backend", "all"}
        and original.get("status") == "healthy"
        and "backend_origin" not in original
        and "phone_rollback" in original,
        "original owner must be one ordinary healthy backend release",
    )
    anchors = []
    with tempfile.TemporaryDirectory(prefix="backend-inheritance-") as directory:
        found = owner.find_release(
            repository,
            pointer["run_id"],
            Path(directory),
            require_live=False,
            environment="production",
            on_phone_rollback=anchors.append,
        )
    _require(
        found is not None
        and found[0] == original_run["id"]
        and _clean(found[1]) == original
        and len(anchors) == 1
        and isinstance(anchors[0], dict),
        "canonical backend release and immutable archive differ",
    )
    identity = _identity(pointer, original, archive)
    for envelope in (run, original_run):
        fresh = api(repository, f"runs/{envelope['id']}")
        _require(
            all(
                fresh.get(key) == envelope.get(key)
                for key in ("id", "run_attempt", "head_sha", "status", "conclusion")
            ),
            "release attempt changed during inheritance",
        )
    return {
        "backend": identity,
        "phone_anchor": anchors[0],
        "backend_release": original,
    }


def inherit(
    repository, run, current, lane, *, api, governed, timestamp, run_command, timeout
) -> InheritedBackend:
    """The caller's canonical FE classification remains required; never scan history."""
    owner = importlib.import_module("uat-retention-maintenance")
    token = owner._API_CACHE.set(None)
    try:
        return _inherit(
            repository,
            run,
            current,
            lane,
            api=api,
            governed=governed,
            timestamp=timestamp,
            run_command=run_command,
            timeout=timeout,
        )
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise receipts.retention.UnsafeState("Backend inheritance schema is invalid") from error
    finally:
        owner._API_CACHE.reset(token)


def apply(owner, repository, run, release, lane, callback):
    inherited = inherit(
        repository,
        run,
        _clean(release),
        lane,
        api=owner.api,
        governed=owner.governed_dispatch,
        timestamp=owner._github_timestamp,
        run_command=owner.retention.run_command,
        timeout=min(
            owner.retention.remaining_seconds(owner.GITHUB_LOOKUP_SECONDS),
            (owner._LOOKUP_DEADLINE.get() or math.inf) - owner.time.monotonic(),
        ),
    )
    backend = inherited["backend"]
    release["_maintenance_backend_identity"] = backend
    if "restoration_runtime" in inherited:
        release["_maintenance_restoration_runtime"] = {
            "backend": copy.deepcopy(inherited["restoration_runtime"])
        }
    else:
        release["_maintenance_backend_inheritance"] = copy.deepcopy(inherited)
    release["_maintenance_lane_provenance"] = {
        "backend": {
            "run_id": backend["run_id"],
            "sha": backend["sha"],
            "source": "deploy-production",
        },
        "frontend": {
            "run_id": run["id"],
            "sha": release["sha"],
            "source": "deploy-production",
        },
    }
    if callback is not None and inherited.get("phone_anchor") is not None:
        callback(inherited["phone_anchor"])


def protection(owner, service, lane, release, *, environment, phone_anchor):
    bound = release["_maintenance_backend_inheritance"]
    original, identity = bound["backend_release"], bound["backend"]
    _require(
        environment == "production"
        and service == "consent-protocol"
        and lane == "backend"
        and phone_anchor == bound["phone_anchor"]
        and release.get("final", {}).get("backend_revision") == identity["revision"]
        and original.get("final", {}).get("backend_revision") == identity["revision"]
        and original.get("sha") == identity["source"],
        "retention anchor no longer matches its verified backend owner",
    )
    revisions = owner.retention.revision_state(service, "hushh-pda", owner.REGION)
    rollback = phone.rollback_revision(phone_anchor, original, revisions)
    current = {
        **release,
        "predeploy": {**release.get("predeploy", {}), "backend_revision": rollback},
    }
    flags = retention_admission.legacy_protection(
        owner, service, lane, current, environment=environment
    )
    _require(flags[2] == rollback, "qualified backend rollback disappeared during retention")
    return flags
