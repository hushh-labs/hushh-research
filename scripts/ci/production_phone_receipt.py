"""Verify production phone rollback evidence without granting release health."""

from __future__ import annotations

import ast
import json
from pathlib import Path
import re
from runpy import run_path

import release_artifact_receipts as receipts
import production_backend_successor as backend_reference

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


def qualified_reader(qualified, plan, primary_sha, run):
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
    _require(
        type(plan.get("schema_version")) is int
        and plan["schema_version"] == 1
        and plan.get("run_id") == str(run["id"])
        and plan.get("primary_sha") == primary_sha
        and re.fullmatch(r"[0-9a-f]{40}", str(primary_sha))
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
        and consumers.get("primary") == primary_sha
        and _hashes(consumers.get("source_sha256"), paths),
        "phone consumer compatibility is not qualified",
    )
    return {"revision": revision, "source": source, "image": image}


def _qualified(qualified, plan, release, run):
    anchor = qualified_reader(qualified, plan, release.get("sha"), run)
    summary = release["phone_rollback"]
    _require(
        summary.get("revision") == anchor["revision"]
        and summary.get("qualification") == "success",
        "phone rollback summary is not bound to its qualification",
    )
    return anchor


def operational_runtime(qualified, plan):
    """Read an operational binding re-attested by this exact release's gates."""
    binding = plan.get("operational_reference") or {}
    tag = binding.get("tag") or {}
    try:
        _require(
            backend_reference.tag_identity(tag.get("tag_object")) == tag,
            "operational phone runtime tag changed",
        )
        _, record = backend_reference.split(tag["message"], tag["commit"])
        _require(isinstance(record, dict), "operational phone runtime reference absent")
        _require(
            qualified.get("mode") == plan.get("mode") == "operational"
            and qualified.get("operational_reference") == binding
            and qualified.get("uid") == binding.get("uid") == record["uid"]
            and record["origin"] == binding.get("origin")
            and qualified.get("recovery") is False
            and qualified.get("sso") is False
            and all(
                qualified.get(key) == record[key]
                for key in ("revision", "source", "image")
            ),
            "operational phone runtime is not bound to its release",
        )
    except (ValueError, TypeError, KeyError) as error:
        raise retention.UnsafeState("operational phone runtime is invalid") from error
    return {"runtime_run_id": record["origin"]["run_id"], "uid": record["uid"]}


def qualified_documents(mode, report, anchor, primary_sha):
    _require(
        type(mode.get("configured")) is bool
        and type(mode.get("enabled")) is bool
        and (not mode["enabled"] or mode["configured"]),
        "document runtime mode is invalid",
    )
    if not mode["configured"]:
        return
    _require(
        isinstance(report, dict)
        and report.get("project") == "hushh-pda"
        and report.get("configured") is True
        and report.get("targetSha") == primary_sha
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


def _documents(archive, anchor, release):
    mode = _document(archive, "prod-protected-document-release.json")
    report = (
        _document(archive, "prod-document-reader-compatibility.json")
        if mode.get("configured") is True
        else None
    )
    qualified_documents(mode, report, anchor, release["sha"])


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
    if "phone_rollback" not in release:
        return None
    summary = release["phone_rollback"]
    _require(
        isinstance(summary, dict) and bool(summary.get("revision")),
        "phone rollback summary is present but invalid",
    )
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
    runtime_identity = {}
    if plan.get("mode") == "cold":
        _require(
            qualified.get("health") == "passed"
            and qualified.get("recovery") is False
            and qualified.get("sso") is False,
            "cold rollback runtime is not qualified",
        )
        runtime_run = str(run["id"])
    elif plan.get("mode") == "operational":
        runtime_identity = operational_runtime(qualified, plan)
        runtime_run = runtime_identity["runtime_run_id"]
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
        **runtime_identity,
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
    if anchor.get("mode") == "operational":
        _require(
            matches[0].get("metadata", {}).get("uid") == anchor.get("uid"),
            "operational phone rollback UID changed",
        )
    contract = run_path(str(ROOT / "deploy/phone/revision_qualification.py"))
    try:
        contract["_qualify_revision"](
            matches[0],
            sha=anchor["source"],
            image=anchor["image"],
            run_id=anchor["runtime_run_id"],
            source="deploy-production-phone-rollback"
            if anchor["mode"] in {"cold", "operational"}
            else "deploy-production",
            cold=anchor["mode"] in {"cold", "operational"},
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
