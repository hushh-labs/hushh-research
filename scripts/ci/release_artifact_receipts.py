"""Strict receipt selection and decoding for governed deployment reruns.

The maintenance owner supplies origin policy, bounded API/command transports and
lane metadata. This module never grants cleanup or deployment authority.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
import hashlib
import importlib
from io import BytesIO
from pathlib import Path
import re
import stat
from typing import Any
from zipfile import BadZipFile, ZipFile

retention = importlib.import_module("cloudrun-retention")
Document = dict[str, Any]
Timestamp = Callable[[object], datetime | None]


def _replayed_run(
    run: Document, run_id: int, name: str, lane: Document, governed: Callable[[], bool]
) -> int:
    attempt = run.get("run_attempt")
    if (
        name != f"{lane['prefix']}-release-{run_id}"
        or run.get("id") != run_id
        or not governed()
        or type(attempt) is not int
        or attempt < 2
        or run.get("conclusion") not in {"success", "failure"}
        or not re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", "")))
        or any(
            type((run.get(key) or {}).get("id")) is not int
            for key in ("repository", "head_repository")
        )
    ):
        raise retention.UnsafeState("replayed release origin is invalid")
    return attempt


def _upload_window(
    result: Document, run: Document, attempt: int, lane: Document, timestamp: Timestamp
) -> tuple[datetime, datetime]:
    jobs = result.get("jobs")
    if not isinstance(jobs, list) or result.get("total_count") != len(jobs):
        raise retention.UnsafeState("release attempt job inventory is incomplete")
    deploy = [
        job
        for job in jobs
        if isinstance(job, dict) and job.get("name") == lane["deploy_job"]
    ]
    if len(deploy) != 1 or any(
        deploy[0].get(key) != value
        for key, value in {
            "run_id": run["id"],
            "run_attempt": attempt,
            "head_sha": run["head_sha"],
            "head_branch": "main",
            "status": "completed",
        }.items()
    ):
        raise retention.UnsafeState("release attempt deploy job is not bound")
    uploads = [
        step
        for step in deploy[0].get("steps", [])
        if step.get("name") == lane["upload_step"]
    ]
    if (
        len(uploads) != 1
        or uploads[0].get("status") != "completed"
        or uploads[0].get("conclusion") != "success"
    ):
        raise retention.UnsafeState("release attempt upload is not proven")
    started, ended = (
        timestamp(uploads[0].get("started_at")),
        timestamp(uploads[0].get("completed_at")),
    )
    if (
        not started
        or not ended
        or not timedelta(0) <= ended - started <= timedelta(minutes=5)
    ):
        raise retention.UnsafeState("release attempt upload window is invalid")
    return started, ended


def _artifact_created(
    artifact: Document, run: Document, timestamp: Timestamp
) -> datetime:
    created = timestamp(artifact.get("created_at"))
    origin = artifact.get("workflow_run") or {}
    if (
        not created
        or type(artifact.get("id")) is not int
        or artifact["id"] < 1
        or any(
            origin.get(key) != value
            for key, value in {
                "id": run["id"],
                "head_sha": run["head_sha"],
                "head_branch": "main",
                "repository_id": run["repository"]["id"],
                "head_repository_id": run["head_repository"]["id"],
            }.items()
        )
    ):
        raise retention.UnsafeState("release artifact origin is invalid")
    return created


def resolve_replayed_artifact(
    repository: str,
    run_id: int,
    name: str,
    lane: Document,
    environment: str,
    *,
    api: Callable[[str, str], Document],
    governed_dispatch: Callable[[Document, str, str], bool],
    timestamp: Timestamp,
) -> Document:
    """Select one current-attempt upload; ordering and greatest ID grant nothing."""
    run = api(repository, f"runs/{run_id}")
    attempt = _replayed_run(
        run, run_id, name, lane, lambda: governed_dispatch(run, repository, environment)
    )
    result = api(repository, f"runs/{run_id}/artifacts?per_page=100")
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, list) or result.get("total_count") != len(artifacts):
        raise retention.UnsafeState("release artifact inventory is incomplete")
    matches = [
        item
        for item in artifacts
        if isinstance(item, dict) and item.get("name") == name
    ]
    if len(matches) < 2:
        raise retention.UnsafeState("release artifact is expired or ambiguous")
    jobs = api(repository, f"runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    started, ended = _upload_window(jobs, run, attempt, lane, timestamp)
    selected = []
    for artifact in matches:
        created = _artifact_created(artifact, run, timestamp)
        if started - timedelta(seconds=5) <= created <= ended + timedelta(seconds=30):
            selected.append(artifact)
    if len(selected) != 1 or selected[0].get("expired") is not False:
        raise retention.UnsafeState("release attempt artifact is expired or ambiguous")
    return selected[0]


def _status_bytes(archive: bytes, status_name: str) -> bytes:
    try:
        with ZipFile(BytesIO(archive)) as bundle:
            entries = bundle.infolist()
            names = [entry.filename for entry in entries]
            if (
                len(entries) > 500
                or len(names) != len(set(names))
                or names.count(status_name) != 1
                or sum(entry.file_size for entry in entries) > 20 * 1024 * 1024
                or any(
                    path.is_absolute() or ".." in path.parts
                    for path in map(Path, names)
                )
            ):
                raise retention.UnsafeState("release artifact has unsafe files")
            status = bundle.getinfo(status_name)
            if (
                status.is_dir()
                or stat.S_IFMT(status.external_attr >> 16) == stat.S_IFLNK
                or status.file_size > 2 * 1024 * 1024
            ):
                raise retention.UnsafeState("release status member is unsafe")
            return bundle.read(status)
    except BadZipFile as exc:
        raise retention.UnsafeState("release artifact is not a ZIP") from exc


def download_replayed_artifact(
    repository: str,
    artifact: Document,
    directory: Path,
    status_name: str,
    *,
    run_command: Callable[..., Any],
    timeout: float,
) -> None:
    """Download an immutable digest-verified archive and create only its status."""
    if (
        type(artifact.get("id")) is not int
        or artifact["id"] < 1
        or type(artifact.get("size_in_bytes")) is not int
        or not 0 < artifact["size_in_bytes"] <= 10 * 1024 * 1024
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(artifact.get("digest", "")))
    ):
        raise retention.UnsafeState("release artifact envelope is invalid")
    if timeout <= 0:
        raise retention.UnsafeState("release artifact lookup deadline exhausted")
    archive = run_command(
        ["gh", "api", f"repos/{repository}/actions/artifacts/{artifact['id']}/zip"],
        timeout=timeout,
        text=False,
    ).stdout
    if len(archive) != artifact["size_in_bytes"] or hashlib.sha256(
        archive
    ).hexdigest() != artifact["digest"].removeprefix("sha256:"):
        raise retention.UnsafeState("release artifact digest changed")
    status = _status_bytes(archive, status_name)
    if directory.is_symlink():
        raise retention.UnsafeState("release artifact directory is a symlink")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / status_name
    with target.open("xb") as output:
        output.write(status)
    target.chmod(0o600)
