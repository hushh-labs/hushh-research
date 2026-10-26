"""Bind frontend-only releases to one ordinary, activated backend owner."""

from __future__ import annotations

import copy
import importlib
import math
import re
import tempfile
from io import BytesIO
from pathlib import Path
from typing import TypedDict
from zipfile import ZipFile

import production_activation_continuation as activation
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
    phone_anchor: dict
    backend_release: dict


def _require(condition, reason):
    if not condition:
        raise receipts.retention.UnsafeState("Backend inheritance: " + reason)


def _clean(release):
    return {key: value for key, value in release.items() if not key.startswith("_maintenance_")}


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


def _inherit(repository, run, current, lane, *, api, governed, timestamp, run_command, timeout):
    owner = importlib.import_module("uat-retention-maintenance")
    pointer = _selector(current, run)
    _require(lane["project"] == "hushh-pda" and timeout > 0, "invalid production boundary")
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
    if callback is not None:
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
