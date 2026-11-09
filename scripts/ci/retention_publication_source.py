"""Read only the source blobs needed to qualify a maintenance transcript."""

from __future__ import annotations

import contextvars
import importlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import retention_preflight_evidence as evidence

_IMMUTABLE_SHA = re.compile(r"[0-9a-f]{40}\Z")
_SOURCE_READERS = 3


def _read_blob(owner, repository, path, revision):
    if _IMMUTABLE_SHA.fullmatch(revision):
        sha, size = _read_pinned_blob(owner, repository, path, revision)
    else:
        sha, size = _query_blob(owner, repository, path, revision)
    return {"sha": sha, "size": size}


@lru_cache(maxsize=512)
def _read_pinned_blob(owner, repository, path, revision):
    """Cache only immutable Git blob metadata, never a live ref's resolution."""
    return _query_blob(owner, repository, path, revision)


def _query_blob(owner, repository, path, revision):
    try:
        blob = json.loads(
            owner.command(
                "gh",
                "api",
                f"repos/{repository}/contents/{path}?ref={revision}",
                "--jq",
                "{sha,size}",
            )
        )
    except (TypeError, ValueError):
        raise owner.retention.UnsafeState(
            "maintenance source metadata is invalid"
        ) from None
    if (
        not isinstance(blob, dict)
        or not isinstance(blob.get("sha"), str)
        or _IMMUTABLE_SHA.fullmatch(blob["sha"]) is None
        or type(blob.get("size")) is not int
        or blob["size"] < 0
    ):
        raise owner.retention.UnsafeState("maintenance source metadata is incomplete")
    return blob["sha"], blob["size"]


def _read_paths(owner, repository, revision, paths):
    if not paths:
        return {}
    if len(paths) == 1:
        path = paths[0]
        return {path: _read_blob(owner, repository, path, revision)}

    with ThreadPoolExecutor(max_workers=min(_SOURCE_READERS, len(paths))) as executor:
        reads = [
            executor.submit(
                contextvars.copy_context().run,
                _read_blob,
                owner,
                repository,
                path,
                revision,
            )
            for path in paths
        ]
        return {path: future.result() for path, future in zip(paths, reads, strict=True)}


def read_source(owner, repository, sha, paths=None):
    if paths is not None:
        return _read_paths(owner, repository, sha, tuple(paths))
    first = _read_blob(owner, repository, evidence.OWNER, sha)
    profile = evidence.SOURCE_PROFILES.get(first.get("sha"))
    if profile is None:
        # UAT's current-source proof also loads only on its own path, outside
        # production's pinned historical tool closure.
        current = importlib.import_module("retention_uat_guard_evidence")
        if first.get("sha") in current.OWNER_BLOBS:
            profile = next(tuple(profile) for profile in current.SOURCE_PROFILES
                           if profile[evidence.OWNER][0] == first["sha"])
    if profile is None:
        raise owner.retention.UnsafeState("maintenance pre-mutation source is unknown")
    remaining = tuple(path for path in profile if path != evidence.OWNER)
    return {evidence.OWNER: first, **_read_paths(owner, repository, sha, remaining)}
