"""Verify production phone rollback evidence without granting release health."""

from __future__ import annotations

import ast
import json
from pathlib import Path
import re
from runpy import run_path

import release_artifact_receipts as receipts

retention = receipts.retention
ROOT = Path(__file__).resolve().parents[2]
PHONE_STEPS = (
    "Validate deployment SHA against main",
    "Prepare qualified phone rollback and producer stage",
    "Revalidate actual phone rollback after backend deployment attempt",
)


def _constant(filename: str, name: str):
    tree = ast.parse((ROOT / "deploy/phone" / filename).read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == name
            for target in node.targets
        ):
            return ast.literal_eval(node.value)
    raise retention.UnsafeState("phone proof contract is unavailable")


def _require(condition, reason):
    if not condition:
        raise retention.UnsafeState(reason)


def _hashes(value, expected):
    return (
        isinstance(value, dict)
        and set(value) == set(expected)
        and all(
            isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest)
            for digest in value.values()
        )
    )


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate receipt field")
        result[key] = value
    return result


def _document(archive, name):
    try:
        value = json.loads(
            receipts._status_bytes(archive, name), object_pairs_hook=_unique_object
        )
    except (KeyError, ValueError, TypeError) as error:
        raise retention.UnsafeState(
            "phone qualification artifact member is invalid"
        ) from error
    _require(isinstance(value, dict), "phone qualification artifact member is invalid")
    return value


def _qualified(qualified, plan, release, run):
    source, image, revision = (
        qualified.get(key) for key in ("source", "image", "revision")
    )
    _require(
        type(qualified.get("schema_version")) is int
        and qualified["schema_version"] == 1
        and qualified.get("qualification") == "passed"
        and qualified.get("run_id") == str(run["id"])
        and qualified.get("project") == "hushh-pda"
        and qualified.get("region") == "us-central1"
        and isinstance(revision, str)
        and re.fullmatch(r"consent-protocol-[a-z0-9-]+", revision)
        and isinstance(source, str)
        and re.fullmatch(r"[0-9a-f]{40}", source)
        and isinstance(image, str)
        and re.fullmatch(
            r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}", image
        ),
        "phone rollback qualification identity is invalid",
    )
    summary = release["phone_rollback"]
    _require(
        summary.get("revision") == revision
        and summary.get("qualification") == "success",
        "phone rollback summary is not bound to its qualification",
    )
    _require(
        type(plan.get("schema_version")) is int
        and plan["schema_version"] == 1
        and plan.get("run_id") == str(run["id"])
        and plan.get("primary_sha") == release.get("sha")
        and re.fullmatch(r"[0-9a-f]{40}", str(release.get("sha", "")))
        and plan.get("source") == source
        and plan.get("image") == image
        and type(plan.get("recovery_enabled")) is bool,
        "phone rollback plan does not match its healthy release",
    )
    probe = qualified.get("probe")
    modules = _constant("reader_probe.py", "SOURCE_MODULES")
    _require(
        isinstance(probe, dict)
        and probe == plan.get("probe")
        and probe.get("source") == source
        and probe.get("image") == image
        and probe.get("phone_reader") == _constant("qualify_image.py", "EXPECTED")
        and probe.get("probe_generation_admission") is False
        and re.fullmatch(r"[0-9a-f]{64}", str(probe.get("probe_sha256", "")))
        and _hashes(
            probe.get("source_sha256"),
            (name.replace(".", "/") + ".py" for name in modules),
        ),
        "phone image reader proof is not qualified",
    )
    consumers = plan.get("consumer_compatibility") or {}
    paths = _constant("consumer_compatibility.py", "UNCHANGED") + _constant(
        "consumer_compatibility.py", "REVIEWED_EXCEPTIONS"
    )
    _require(
        isinstance(consumers, dict)
        and consumers.get("fallback") == source
        and consumers.get("primary") == release["sha"]
        and _hashes(consumers.get("source_sha256"), paths),
        "phone consumer compatibility is not qualified",
    )
    return {"revision": revision, "source": source, "image": image}


def _documents(archive, anchor, release):
    mode = _document(archive, "prod-protected-document-release.json")
    _require(
        type(mode.get("configured")) is bool and type(mode.get("enabled")) is bool,
        "document runtime mode is invalid",
    )
    if not mode["configured"]:
        return
    report = _document(archive, "prod-document-reader-compatibility.json")
    _require(
        report.get("project") == "hushh-pda"
        and report.get("configured") is True
        and report.get("targetSha") == release["sha"]
        and report.get("enabled") is mode["enabled"]
        and re.fullmatch(r"[0-9a-f]{40}", str(report.get("readerAncestor", "")))
        and isinstance(report.get("previous"), dict)
        and report.get("previous", {}).get("consent-protocol")
        == {
            "revision": anchor["revision"],
            "sha": anchor["source"],
            "image": anchor["image"],
            "readerCompatible": True,
        },
        "document rollback proof was not rebound to the phone reader",
    )


def _qualified_upload(repository, run, release, lane, *, api, governed, timestamp):
    _require(
        release.get("status") == "healthy"
        and governed(run, repository, "production")
        and run.get("conclusion") in {"success", "failure"}
        and type(run.get("id")) is int
        and run["id"] > 0
        and re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", "")))
        and all(
            type((run.get(key) or {}).get("id")) is int
            for key in ("repository", "head_repository")
        ),
        "phone qualification run origin is invalid",
    )
    artifact, job = receipts.current_attempt_artifact(
        repository, run, lane, api=api, timestamp=timestamp
    )
    steps = job.get("steps") or []
    by_name = {step.get("name"): step for step in steps}
    _require(
        job.get("conclusion") == run.get("conclusion")
        and len(by_name) == len(steps)
        and all(
            by_name.get(name, {}).get("status") == "completed"
            and by_name[name].get("conclusion") == "success"
            for name in PHONE_STEPS
        ),
        "phone qualification job gates were not completed",
    )
    return artifact


def healthy_anchor(
    repository, run, release, lane, *, api, governed, timestamp, run_command, timeout
):
    """Read the exact upload independently; keep the healthy receipt immutable."""
    summary = release.get("phone_rollback")
    if not isinstance(summary, dict) or not summary.get("revision"):
        return None
    artifact = _qualified_upload(
        repository, run, release, lane, api=api, governed=governed, timestamp=timestamp
    )
    archive = receipts.immutable_archive(
        repository, artifact, run_command=run_command, timeout=timeout
    )
    _require(
        _document(archive, "prod-release-status.json") == release,
        "phone qualification and serving receipt differ",
    )
    qualified = _document(archive, "phone-rollback/qualified.json")
    plan = _document(archive, "phone-rollback/plan.json")
    anchor = _qualified(qualified, plan, release, run)
    _documents(archive, anchor, release)
    if plan.get("mode") == "cold":
        _require(
            qualified.get("health") == "passed"
            and qualified.get("recovery") is False
            and qualified.get("sso") is False,
            "cold rollback runtime is not qualified",
        )
        runtime_run = str(run["id"])
    else:
        runtime = plan.get("runtime") or {}
        _require(
            plan.get("mode") == "existing"
            and isinstance(runtime, dict)
            and runtime.get("health") == "passed"
            and runtime.get("revision") == anchor["revision"]
            and runtime.get("source") == anchor["source"]
            and runtime.get("image") == anchor["image"],
            "phone rollback runtime identity is unqualified",
        )
        runtime_run = runtime.get("run_id")
    _require(
        isinstance(runtime_run, str) and re.fullmatch(r"[1-9][0-9]*", runtime_run),
        "phone rollback runtime run is invalid",
    )
    refreshed = api(repository, f"runs/{run['id']}")
    _require(
        all(
            refreshed.get(key) == run.get(key)
            for key in ("id", "run_attempt", "head_sha", "status", "conclusion")
        ),
        "phone qualification attempt changed during lookup",
    )
    return {
        **anchor,
        "schema_version": 1,
        "release_run_id": run["id"],
        "release_sha": release["sha"],
        "serving": release["final"].copy(),
        "run_attempt": run["run_attempt"],
        "artifact_id": artifact["id"],
        "artifact_digest": artifact["digest"],
        "mode": plan["mode"],
        "runtime_run_id": runtime_run,
    }


def rollback_revision(anchor, release, revisions):
    _require(
        anchor.get("release_sha") == release.get("sha")
        and anchor.get("serving") == release.get("final"),
        "phone rollback context belongs to another healthy release",
    )
    matches = [
        row
        for row in revisions
        if row.get("metadata", {}).get("name") == anchor.get("revision")
    ]
    _require(
        len(matches) == 1, "qualified phone rollback revision is absent or ambiguous"
    )
    contract = run_path(str(ROOT / "deploy/phone/revision_qualification.py"))
    try:
        contract["_qualify_revision"](
            matches[0],
            sha=anchor["source"],
            image=anchor["image"],
            run_id=anchor["runtime_run_id"],
            source="deploy-production-phone-rollback"
            if anchor["mode"] == "cold"
            else "deploy-production",
            cold=anchor["mode"] == "cold",
        )
    except (KeyError, ValueError, TypeError) as error:
        raise retention.UnsafeState(
            "qualified phone rollback revision changed"
        ) from error
    return anchor["revision"]


def refuse_advance_checkpoint(requested):
    if requested:
        raise retention.UnsafeState(
            "cold checkpoint cannot advance rollback: installed-schema, consumer and retirement qualification are unavailable"
        )
