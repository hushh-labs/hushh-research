"""Authenticate finite F hosted identity, bounded run history and artifact bytes.

This reader grants no provider mutation or environment release authority.
"""

from __future__ import annotations
import hashlib
import json
import re
import time
import zlib
from datetime import datetime, timedelta
from io import BytesIO
from zipfile import BadZipFile, ZipFile
import frontend_release as release
import frontend_validation as validation

require = validation.require
Refused = validation.Refused
WORKFLOWS = release.WORKFLOWS
REPOSITORY_ID = 1111490616
MAX_RUNS = 1000
MAX_ATTEMPTS = 10
PAGE_SIZE = 100
AUTHORITY = tuple(
    dict.fromkeys((*release.AUTHORITY_PATHS, *validation.AUTHORITY_PATHS))
)


def _fresh(client, path, **kwargs):
    if isinstance(getattr(client, "cache", None), dict):
        client.cache.pop(path, None)
    return client.read(path, **kwargs)


def _stamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.tzinfo is not None, "frontend_hosted_timestamp_invalid")
        return parsed
    except (ValueError, TypeError, AttributeError):
        raise Refused("frontend_hosted_timestamp_invalid") from None


def _reviewed_authority(sha, workflow_path):
    """Bind execution and governance files to the current reviewed Main checkout."""
    git = validation.source.backend._git
    git("merge-base", "--is-ancestor", sha, "origin/main")
    for path in (workflow_path, *AUTHORITY):
        original = git("show", sha + ":" + path)
        require(
            original
            == git("show", "origin/main:" + path)
            == git("show", "HEAD:" + path)
            and (validation.ROOT / path).read_bytes().replace(b"\r\n", b"\n")
            == original,
            "frontend_hosted_authority_changed",
        )


def _run(client, run_id, attempt, name, required, environment, *, success):
    require(
        validation._positive(run_id) and validation._positive(attempt),
        "frontend_hosted_run_invalid",
    )
    run = _fresh(client, f"runs/{run_id}/attempts/{attempt}")
    require(
        isinstance(environment, str) and environment in WORKFLOWS,
        "frontend_hosted_environment_invalid",
    )
    allowed = json.loads((validation.ROOT / "config/ci-governance.json").read_bytes())[
        environment
    ]["manual_dispatch_users"]
    require(
        isinstance(run, dict)
        and run.get("id") == run_id
        and run.get("run_attempt") == attempt
        and run.get("path") == WORKFLOWS[environment]
        and run.get("head_branch") == "main"
        and run.get("event") == "workflow_dispatch"
        and run.get("status") == "completed"
        and (not success or run.get("conclusion") == "success")
        and all(
            isinstance(run.get(k), dict)
            and run[k].get("full_name") == validation.transport.REPOSITORY
            and type(run[k].get("id")) is int
            and run[k]["id"] == REPOSITORY_ID
            for k in ("repository", "head_repository")
        )
        and all(
            isinstance(run.get(k), dict) and run[k].get("login") in allowed
            for k in ("actor", "triggering_actor")
        ),
        "frontend_hosted_run_unverified",
    )
    sha = run.get("head_sha")
    require(
        isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha),
        "frontend_hosted_sha_invalid",
    )
    workflow_path = WORKFLOWS[environment]
    workflow = _fresh(client, f"workflows/{workflow_path.rsplit('/', 1)[-1]}")
    require(
        isinstance(workflow, dict)
        and validation._positive(workflow.get("id"))
        and run.get("workflow_id") == workflow["id"]
        and workflow.get("path") == workflow_path,
        "frontend_hosted_workflow_invalid",
    )
    _reviewed_authority(sha, workflow_path)
    return run, _job(client, run, run_id, attempt, name, required, success)


def _artifact(client, run, job, prefix, upload, filename):
    listing = _fresh(client, f"runs/{run['id']}/artifacts?per_page=100")
    rows = listing.get("artifacts", []) if isinstance(listing, dict) else []
    require(
        isinstance(rows, list)
        and all(isinstance(row, dict) for row in rows)
        and listing.get("total_count") == len(rows) <= 100,
        "frontend_hosted_artifacts_invalid",
    )
    wanted = f"{prefix}-{run['id']}-{run['run_attempt']}"
    matches = [row for row in rows if row.get("name") == wanted]
    steps = [step for step in job["steps"] if step.get("name") == upload]
    require(len(matches) == len(steps) == 1, "frontend_hosted_artifacts_invalid")
    item, step = matches[0], steps[0]
    require(
        item.get("expired") is False
        and isinstance(item.get("workflow_run"), dict)
        and item["workflow_run"].get("id") == run["id"]
        and item["workflow_run"].get("head_sha") == run["head_sha"]
        and validation._positive(item.get("id"))
        and type(item.get("size_in_bytes")) is int
        and 0 < item["size_in_bytes"] <= validation.transport.MAX_BYTES
        and _stamp(step.get("started_at")) - timedelta(seconds=5)
        <= _stamp(item.get("created_at"))
        <= _stamp(step.get("completed_at")) + timedelta(seconds=30),
        "frontend_hosted_artifact_identity_invalid",
    )
    raw = _fresh(client, f"artifacts/{item['id']}/zip", binary=True)
    require(
        isinstance(raw, bytes)
        and len(raw) == item["size_in_bytes"]
        and item.get("digest") == "sha256:" + hashlib.sha256(raw).hexdigest(),
        "frontend_hosted_artifact_digest_invalid",
    )
    try:
        with ZipFile(BytesIO(raw)) as archive:
            entries = archive.infolist()
            require(
                len(entries) == 1
                and entries[0].filename == filename
                and not entries[0].is_dir()
                and entries[0].file_size <= validation.transport.MAX_BYTES
                and ((entries[0].external_attr >> 16) & 0o170000) != 0o120000,
                "frontend_hosted_archive_invalid",
            )
            document = json.loads(
                archive.read(entries[0]),
                object_pairs_hook=validation.source.backend._json_pairs,
            )
    except (
        BadZipFile,
        ValueError,
        UnicodeError,
        RuntimeError,
        OSError,
        EOFError,
        zlib.error,
    ):
        raise Refused("frontend_hosted_archive_invalid") from None
    return item, document


def _require(condition, reason):
    if not condition:
        raise Refused("fixture_history_" + reason)


def _read(api, repository, path, deadline):
    _require(deadline is None or time.monotonic() < deadline, "deadline_exceeded")
    try:
        value = api(repository, path)
    except Exception:
        raise Refused("fixture_history_lookup_failed") from None
    _require(isinstance(value, dict), "response_invalid")
    return value


def _history(
    repository, api, timestamp, deadline, *, workflow_name="plg-frontend-dev.yml"
):
    _require(
        workflow_name in {value.rsplit("/", 1)[1] for value in WORKFLOWS.values()},
        "workflow_invalid",
    )
    rows, seen, total, previous = [], set(), None, None
    for page in range(1, MAX_RUNS // PAGE_SIZE + 1):
        value = _read(
            api,
            repository,
            f"workflows/{workflow_name}/runs?per_page={PAGE_SIZE}&page={page}",
            deadline,
        )
        batch, count = value.get("workflow_runs"), value.get("total_count")
        _require(
            type(count) is int
            and 0 <= count <= MAX_RUNS
            and isinstance(batch, list)
            and len(batch) == min(PAGE_SIZE, max(count - len(rows), 0))
            and (total is None or total == count),
            "history_incomplete",
        )
        total = count
        for row in batch:
            _require(
                isinstance(row, dict)
                and validation._positive(row.get("id"))
                and row["id"] not in seen,
                "history_identity_invalid",
            )
            try:
                created = timestamp(row.get("created_at"))
            except Exception:
                raise Refused("fixture_history_history_time_invalid") from None
            _require(
                created is not None
                and (
                    previous is None
                    or (row["id"] < previous[0] and created <= previous[1])
                ),
                "history_order_invalid",
            )
            previous = row["id"], created
            seen.add(row["id"])
            rows.append(row)
        if len(rows) == total:
            return rows
    raise Refused("fixture_history_history_incomplete")


def _identity(row):
    return tuple(
        row.get(key)
        for key in (
            "id",
            "head_sha",
            "run_attempt",
            "created_at",
            "status",
            "conclusion",
            "updated_at",
        )
    )


def _job(client, run, run_id, attempt, name, required, success):
    sha = run["head_sha"]
    inventory = _fresh(client, f"runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    rows = inventory.get("jobs", []) if isinstance(inventory, dict) else []
    require(
        isinstance(rows, list)
        and all(isinstance(row, dict) for row in rows)
        and inventory.get("total_count") == len(rows) <= 100,
        "frontend_hosted_jobs_invalid",
    )
    matches = [row for row in rows if row.get("name") == name]
    require(len(matches) == 1, "frontend_hosted_jobs_invalid")
    job = matches[0]
    require(
        job.get("head_sha") == sha
        and job.get("run_id") == run_id
        and job.get("run_attempt") == attempt
        and job.get("status") == "completed"
        and (not success or job.get("conclusion") == "success"),
        "frontend_hosted_job_unverified",
    )
    steps = job.get("steps", [])
    require(
        isinstance(steps, list) and all(isinstance(row, dict) for row in steps),
        "frontend_hosted_steps_invalid",
    )
    for step_name in required:
        matched = [step for step in steps if step.get("name") == step_name]
        require(
            len(matched) == 1
            and matched[0].get("status") == "completed"
            and matched[0].get("conclusion") == "success",
            "frontend_hosted_step_unverified",
        )
    return job
