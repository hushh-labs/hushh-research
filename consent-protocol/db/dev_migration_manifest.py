"""Import-safe validation of the existing dev migration manifest and deferrals."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

# Exact equality keeps production and UAT outside the Dev lane.
DEV_GCP_PROJECT_ID = "hushh-pda-dev"


def dev_extra_active(*, explicit: bool = False, project_id: str | None = None) -> bool:
    """Validate shared Dev or a release-only preview before connecting."""
    resolved = str(
        project_id if project_id is not None else os.getenv("GCP_PROJECT_ID") or ""
    ).strip()
    target = os.getenv("DEV_TARGET", "shared-dev")
    if target == "scope-commerce-sandbox":
        if (
            explicit
            or resolved != DEV_GCP_PROJECT_ID
            or os.getenv("DB_NAME") != "scope_commerce_sandbox"
        ):
            raise ValueError(
                "Isolated preview requires its fixed project/database and release-only lane"
            )
        return False
    if target != "shared-dev":
        raise ValueError("Unknown development migration target")
    return explicit or resolved == DEV_GCP_PROJECT_ID


def load_dev_manifest(path: Path, release_filenames: tuple[str, ...]) -> tuple[str, ...]:
    """Load the dev-only parked migration order.

    Loaded lazily (never at import time) so a deployed SHA that lacks this file —
    or any non-dev environment that never reaches this lane — is entirely
    unaffected by it.
    """
    if not path.exists():
        raise FileNotFoundError(f"Dev migration manifest missing: {path}")

    payload = json.loads(path.read_text(encoding="utf-8"))
    ordered = payload.get("ordered_migrations")

    if not isinstance(ordered, list) or not ordered:
        raise RuntimeError("dev_migration_manifest.json must define ordered_migrations")

    ordered_tuple = tuple(str(item).strip() for item in ordered if str(item).strip())
    if not ordered_tuple:
        raise RuntimeError("dev_migration_manifest.json ordered_migrations is empty")

    # Fail closed: the dev lane must never smuggle a release migration, which
    # would apply release SQL outside the audited release manifest ordering.
    overlap = set(ordered_tuple) & set(release_filenames)
    if overlap:
        raise RuntimeError(
            "dev_migration_manifest.json must not repeat release migrations: "
            + ", ".join(sorted(overlap))
        )
    return ordered_tuple


def deferred_release_migrations(
    path: Path,
    migrations_dir: Path,
    base_filenames: tuple[str, ...],
    *,
    project_id: str | None,
    target: str | None,
    database: str | None,
    expected_project: str,
) -> tuple[str, ...]:
    """Read the reviewed deferral only for the exact shared-dev workflow target.

    This changes execution selection, never canonical identity, baseline hashes,
    or receipts. Missing target markers grant no exemption.
    """
    if project_id != expected_project or target != "shared-dev" or database != "postgres":
        return ()
    payload = json.loads(path.read_text(encoding="utf-8"))
    entries = payload.get("deferred_release_migrations")
    if payload.get("target_gcp_project_id") != expected_project or not isinstance(entries, list):
        raise RuntimeError("Invalid shared-dev release deferral manifest")
    deferred: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError("Invalid shared-dev release deferral entry")
        filename = entry.get("filename")
        if (
            filename != "249_one_chat_history_legacy_cutover.sql"
            or filename not in base_filenames
            or filename in deferred
            or not isinstance(entry.get("reason"), str)
            or not entry["reason"].strip()
        ):
            raise RuntimeError("Unreviewed shared-dev release deferral")
        checksum = hashlib.sha256((migrations_dir / filename).read_bytes()).hexdigest()
        if entry.get("checksum_sha256") != checksum:
            raise RuntimeError("Shared-dev deferred migration checksum changed")
        deferred.append(filename)
    return tuple(deferred)


def assert_dev_baseline_target(
    *, project_id: str | None, target: str | None, database: str | None, expected_project: str
) -> bool:
    """Require explicit shared-Dev binding before checking unresolved deferrals."""
    if project_id != expected_project:
        return False
    if target == "scope-commerce-sandbox" and database == "scope_commerce_sandbox":
        return False
    if target != "shared-dev" or database != "postgres":
        raise RuntimeError("Shared-dev baseline requires its explicit project/target/database")
    return True
