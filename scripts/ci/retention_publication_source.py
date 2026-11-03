"""Read only the source blobs needed to qualify a maintenance transcript."""

from __future__ import annotations

import importlib
import json

import retention_preflight_evidence as evidence


def read_source(owner, repository, sha, paths=None):
    def read(path, revision):
        return json.loads(
            owner.command(
                "gh",
                "api",
                f"repos/{repository}/contents/{path}?ref={revision}",
                "--jq",
                "{sha,size}",
            )
        )

    if paths is not None:
        return {path: read(path, sha) for path in paths}
    first = read(evidence.OWNER, sha)
    profile = evidence.SOURCE_PROFILES.get(first.get("sha"))
    if profile is None:
        # UAT's current-source proof also loads only on its own path, outside
        # production's pinned historical tool closure.
        current = importlib.import_module("retention_uat_guard_evidence")
        if first.get("sha") in current.OWNER_BLOBS:
            profile = current.SOURCE_PATHS
    if profile is None:
        raise owner.retention.UnsafeState("maintenance pre-mutation source is unknown")
    return {
        path: first if path == evidence.OWNER else read(path, sha) for path in profile
    }
