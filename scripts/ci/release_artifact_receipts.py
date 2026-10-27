"""Strict receipt selection and decoding for governed deployment reruns.

The maintenance owner supplies origin policy, bounded API/command transports and
lane metadata. This module never grants cleanup or deployment authority.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
import hashlib
import importlib
import json
from io import BytesIO
from pathlib import Path
import os
import re
import stat
from typing import Any
from zipfile import BadZipFile, ZipFile

retention = importlib.import_module("cloudrun-retention")
Document = dict[str, Any]
Timestamp = Callable[[object], datetime | None]


def artifact_exists(repository, run_id, name, *, api):
    result = api(repository, f"runs/{run_id}/artifacts?per_page=100")
    artifacts = result["artifacts"]
    if result.get("total_count", len(artifacts)) != len(artifacts):
        raise retention.UnsafeState("release artifact inventory is incomplete")
    matches = [item for item in artifacts if item.get("name") == name]
    if not matches:
        return False
    if len(matches) != 1 or matches[0].get("expired") is not False:
        raise retention.UnsafeState("release artifact is expired or ambiguous")
    return True


def validate_revision_names(release):
    for lane, service in (
        ("backend", "consent-protocol"),
        ("frontend", "hushh-webapp"),
    ):
        revision = release.get("final", {}).get(f"{lane}_revision", "")
        pattern = rf"{service}-[a-z0-9-]+"
        if not isinstance(revision, str) or not re.fullmatch(pattern, revision):
            raise retention.UnsafeState(f"source release lacks a valid {lane} revision")
        rollback = release.get("predeploy", {}).get(f"{lane}_revision") or ""
        if rollback and (
            not isinstance(rollback, str) or not re.fullmatch(pattern, rollback)
        ):
            raise retention.UnsafeState(f"source release has invalid {lane} rollback")


def download(repository, run_id, name, directory, *, command):
    command(
        "gh",
        "run",
        "download",
        str(run_id),
        "--repo",
        repository,
        "--name",
        name,
        "--dir",
        str(directory),
    )


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


def current_attempt_artifact(repository, run, lane, *, api, timestamp):
    """Resolve first and later uploads by origin and window, never by greatest ID."""
    attempt = run.get("run_attempt")
    if type(attempt) is not int or attempt < 1:
        raise retention.UnsafeState("release attempt is invalid")
    result = api(repository, f"runs/{run['id']}/artifacts?per_page=100")
    artifacts = result.get("artifacts")
    if (
        not isinstance(artifacts, list)
        or result.get("total_count") != len(artifacts)
        or len(artifacts) > 100
        or any(not isinstance(row, dict) for row in artifacts)
    ):
        raise retention.UnsafeState("release artifact inventory is incomplete")
    jobs = api(repository, f"runs/{run['id']}/attempts/{attempt}/jobs?per_page=100")
    started, ended = _upload_window(jobs, run, attempt, lane, timestamp)
    selected = []
    for artifact in artifacts:
        if artifact.get("name") != f"{lane['prefix']}-release-{run['id']}":
            continue
        created = _artifact_created(artifact, run, timestamp)
        if started - timedelta(seconds=5) <= created <= ended + timedelta(seconds=30):
            selected.append(artifact)
    if len(selected) != 1 or selected[0].get("expired") is not False:
        raise retention.UnsafeState("release attempt artifact is expired or ambiguous")
    return selected[0], next(
        j for j in jobs["jobs"] if j.get("name") == lane["deploy_job"]
    )


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


def immutable_archive(
    repository: str,
    artifact: Document,
    *,
    run_command: Callable[..., Any],
    timeout: float,
) -> bytes:
    """Download only the bounded immutable artifact identified by its digest."""
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
    return archive


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
    archive = immutable_archive(
        repository, artifact, run_command=run_command, timeout=timeout
    )
    status = _status_bytes(archive, status_name)
    if directory.is_symlink():
        raise retention.UnsafeState("release artifact directory is a symlink")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / status_name
    with target.open("xb") as output:
        output.write(status)
    target.chmod(0o600)


_CHECKPOINT_LIMIT = 1024 * 1024


def _checkpoint_names(services) -> set[str]:
    if isinstance(services, (str, bytes)):
        raise retention.UnsafeState("checkpoint services are invalid")
    names = tuple(services)
    if (
        not 1 <= len(names) <= 100
        or len(names) != len(set(names))
        or any(
            not isinstance(name, str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,127}", name) is None
            for name in names
        )
    ):
        raise retention.UnsafeState("checkpoint services are invalid")
    return {"completed.json", *(f"{name}.json" for name in names)}


def _checkpoint_shape(members, services, allow_missing_readme=False):
    allowed = _checkpoint_names(services) | {"README.txt"}
    required = (
        {"completed.json"} if allow_missing_readme else {"completed.json", "README.txt"}
    )
    if (
        not isinstance(members, dict)
        or not required.issubset(members)
        or not set(members).issubset(allowed)
        or any(
            not isinstance(value, bytes) or len(value) > _CHECKPOINT_LIMIT
            for value in members.values()
        )
    ):
        raise retention.UnsafeState("checkpoint file set is invalid")
    return members


def checkpoint_archive(
    archive: bytes, services, *, allow_missing_readme: bool = False
) -> dict[str, bytes]:
    """Decode a closed in-memory ZIP; the explicit missing marker grants no authority."""
    if type(allow_missing_readme) is not bool:
        raise retention.UnsafeState("checkpoint compatibility flag must be boolean")
    allowed = _checkpoint_names(services) | {"README.txt"}
    try:
        with ZipFile(BytesIO(archive)) as bundle:
            entries = bundle.infolist()
            if (
                len(entries) > len(allowed)
                or len({entry.filename for entry in entries}) != len(entries)
                or any(
                    entry.filename not in allowed
                    or entry.is_dir()
                    or bool(entry.external_attr & 0x10)
                    or stat.S_IFMT(entry.external_attr >> 16) not in {0, stat.S_IFREG}
                    or entry.file_size > _CHECKPOINT_LIMIT
                    for entry in entries
                )
            ):
                raise retention.UnsafeState("checkpoint ZIP has unsafe files")
            members = {}
            for entry in entries:
                with bundle.open(entry) as stream:
                    value = stream.read(_CHECKPOINT_LIMIT + 1)
                if len(value) != entry.file_size or len(value) > _CHECKPOINT_LIMIT:
                    raise retention.UnsafeState("checkpoint ZIP member changed")
                members[entry.filename] = value
    except (
        BadZipFile,
        OSError,
        ValueError,
        RuntimeError,
        NotImplementedError,
    ) as error:
        raise retention.UnsafeState("checkpoint ZIP is invalid") from error
    return _checkpoint_shape(members, services, allow_missing_readme)


def checkpoint_directory(directory: Path, services) -> dict[str, bytes]:
    """Read only a complete regular bounded checkpoint; never synthesize its marker."""
    if directory.is_symlink() or not directory.is_dir():
        raise retention.UnsafeState("checkpoint directory is invalid")
    allowed = _checkpoint_names(services) | {"README.txt"}
    members = {}
    try:
        for path in directory.iterdir():
            if path.name not in allowed:
                raise retention.UnsafeState("checkpoint directory has unsafe files")
            with os.fdopen(
                os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
            ) as stream:
                metadata = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(metadata.st_mode)
                    or metadata.st_size > _CHECKPOINT_LIMIT
                ):
                    raise retention.UnsafeState(
                        "checkpoint member is not regular or bounded"
                    )
                value = stream.read(_CHECKPOINT_LIMIT + 1)
                if len(value) != metadata.st_size or len(value) > _CHECKPOINT_LIMIT:
                    raise retention.UnsafeState("checkpoint member changed")
                members[path.name] = value
    except OSError as error:
        raise retention.UnsafeState(
            "checkpoint directory cannot be verified"
        ) from error
    return _checkpoint_shape(members, services)


def _checkpoint_json(value):
    def unique(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("duplicate checkpoint JSON key")
            result[key] = item
        return result

    try:
        result = json.loads(value, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise retention.UnsafeState("checkpoint JSON is invalid") from error
    if not isinstance(result, dict):
        raise retention.UnsafeState("checkpoint JSON is not an object")
    return result


def verify_checkpoint_copy(
    missing: dict[str, bytes], previous: dict[str, bytes], services
) -> None:
    """Prove an unchanged settled JSON copy; the caller independently proves both origins."""
    _checkpoint_shape(missing, services, True)
    _checkpoint_shape(previous, services)
    expected = _checkpoint_names(services)
    if set(missing) != expected or set(previous) != expected | {"README.txt"}:
        raise retention.UnsafeState(
            "checkpoint copy lacks the complete independent file set"
        )
    if any(missing[name] != previous[name] for name in expected):
        raise retention.UnsafeState("checkpoint copy bytes changed")
    completed = _checkpoint_json(missing["completed.json"])
    run_id, observed = (
        completed.get(key) for key in ("release_run_id", "observed_run_id")
    )
    if (
        type(completed.get("schema_version")) is not int
        or completed["schema_version"] != 1
        or completed.get("pass_status") != "complete"
        or completed.get("pending_services") != []
        or (
            type(run_id) is not int
            or run_id < 1
            or type(observed) is not int
            or observed != run_id
        )
    ):
        raise retention.UnsafeState("checkpoint copy is not settled")
    for name in expected - {"completed.json"}:
        if _checkpoint_json(missing[name]).get("pending_mutation") is not None:
            raise retention.UnsafeState("checkpoint copy has pending provider mutation")
