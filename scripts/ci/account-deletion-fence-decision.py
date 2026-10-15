#!/usr/bin/env python3
"""Decide whether a backend rollout needs the migration-201 deletion fence.

This is only the static half of the decision. The workflow also verifies the
live database in unfenced mode before it may skip installing the fence.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import subprocess
from pathlib import Path


LIFECYCLE_PREFIXES = (
    "deploy/account-deletion/",
    "consent-protocol/hushh_mcp/services/account_deletion_",
    "consent-protocol/db/migrations/",
)
LIFECYCLE_FILES = {
    "consent-protocol/api/routes/account.py",
    "consent-protocol/hushh_mcp/services/account_service.py",
    "consent-protocol/db/migrate.py",
    "consent-protocol/db/migration_authority.py",
    "consent-protocol/db/release_migration_manifest.json",
}
# This verifier reads catalog state and issues zero-row probes. Only the exact
# reviewed version that adds unfenced verification may be exempted from the
# lifecycle diff; future edits must take the fenced path.
READ_ONLY_VERIFIER = "deploy/account-deletion/verify_release_boundary.sql"
REVIEWED_VERIFIER_SHA256 = (
    "c9bfc21d6c6a93104c8dfa2f1599062bbe5e7ce7cffb640d81c50d1939a53bc1"
)
MIGRATION_MANIFEST = "consent-protocol/db/release_migration_manifest.json"
SAFE_CIRCLE_MIGRATION = "350_circle_chat_full_emoji_reactions.sql"
SAFE_CIRCLE_MIGRATION_FILES = {
    f"consent-protocol/db/migrations/{SAFE_CIRCLE_MIGRATION}": (
        "7fb0eac2a69c5713cbf996ffd8b44c73f7d878ab1dd1f2ab842ff53c0de1d5c9"
    ),
    "consent-protocol/db/migrations/rollback/350_circle_chat_full_emoji_reactions.rollback.sql": (
        "5ab99a2c47133533c765c55e914a66af718cd6213fcd983e5edb234f5adc1ef7"
    ),
}
SAFE_CIRCLE_CHANGE_SET = {*SAFE_CIRCLE_MIGRATION_FILES, MIGRATION_MANIFEST}


def revision_contracts_are_v201(revisions: object) -> bool:
    if not isinstance(revisions, list) or not revisions:
        return False
    for revision in revisions:
        if not isinstance(revision, dict):
            return False
        metadata = revision.get("metadata")
        if not isinstance(metadata, dict):
            return False
        labels = metadata.get("labels")
        if (
            not isinstance(labels, dict)
            or labels.get("account-deletion-contract") != "v201"
        ):
            return False
    return True


def changes_lifecycle_boundary(path: str) -> bool:
    return path in LIFECYCLE_FILES or path.startswith(LIFECYCLE_PREFIXES)


def git_file(sha: str, path: str) -> bytes | None:
    result = subprocess.run(
        ["git", "show", f"{sha}:{path}"], capture_output=True, check=False
    )
    return result.stdout if result.returncode == 0 else None


def is_reviewed_verifier(target_sha: str) -> bool:
    contents = git_file(target_sha, READ_ONLY_VERIFIER)
    return (
        contents is not None
        and hashlib.sha256(contents).hexdigest() == REVIEWED_VERIFIER_SHA256
    )


def is_reviewed_circle_migration_only(
    base_sha: str, target_sha: str, paths: list[str]
) -> bool:
    """Allow the audited circle-only 350 migration without opening this for new DDL."""
    changed_migrations = {path for path in paths if changes_lifecycle_boundary(path)}
    if changed_migrations != SAFE_CIRCLE_CHANGE_SET:
        return False
    for path, expected_digest in SAFE_CIRCLE_MIGRATION_FILES.items():
        contents = git_file(target_sha, path)
        if (
            git_file(base_sha, path) is not None
            or contents is None
            or hashlib.sha256(contents).hexdigest() != expected_digest
        ):
            return False
    try:
        before = json.loads(git_file(base_sha, MIGRATION_MANIFEST) or b"")
        after = json.loads(git_file(target_sha, MIGRATION_MANIFEST) or b"")
        expected = copy.deepcopy(before)
        expected["ordered_migrations"].append(SAFE_CIRCLE_MIGRATION)
        expected["rollback_migrations"][SAFE_CIRCLE_MIGRATION] = (
            "rollback/350_circle_chat_full_emoji_reactions.rollback.sql"
        )
    except (KeyError, TypeError, ValueError):
        return False
    return after == expected


def changed_paths(base_sha: str, target_sha: str) -> list[str] | None:
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (base_sha, target_sha)):
        return None
    # An intentional rollback to older code is not a routine forward release.
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", base_sha, target_sha],
        check=False,
    )
    if ancestor.returncode != 0:
        return None
    result = subprocess.run(
        ["git", "diff", "--no-renames", "--name-only", f"{base_sha}..{target_sha}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    paths = [path for path in result.stdout.splitlines() if path]
    if READ_ONLY_VERIFIER in paths and is_reviewed_verifier(target_sha):
        paths.remove(READ_ONLY_VERIFIER)
    if is_reviewed_circle_migration_only(base_sha, target_sha, paths):
        return [path for path in paths if path not in SAFE_CIRCLE_CHANGE_SET]
    return paths


def eligible_for_unfenced_release(revisions: object, paths: list[str] | None) -> bool:
    return (
        revision_contracts_are_v201(revisions)
        and paths is not None
        and not any(changes_lifecycle_boundary(path) for path in paths)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revisions-json", type=Path, required=True)
    parser.add_argument("--backend-base-sha", required=True)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    args = parser.parse_args()

    try:
        revisions = json.loads(args.revisions_json.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        revisions = None
    paths = changed_paths(args.backend_base_sha, args.target_sha)
    eligible = eligible_for_unfenced_release(revisions, paths)
    with args.github_output.open("a", encoding="utf-8") as output:
        output.write(f"eligible_for_unfenced={'true' if eligible else 'false'}\n")
    print("unfenced_candidate" if eligible else "fence_required")


if __name__ == "__main__":
    main()
