# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Emergency receipt and published production tag admission for phone/WorkOS gates."""

from __future__ import annotations

import json
import os
import re
import subprocess
import zlib
from pathlib import Path

SHA = re.compile(r"[0-9a-f]{40}")
BRANCH = re.compile(r"(?:hotfix|fix)/[A-Za-z0-9][A-Za-z0-9._/-]*")


def _common_git_dir(root: Path) -> Path | None:
    dot_git = root / ".git"
    if dot_git.is_dir():
        git_dir = dot_git
    elif dot_git.is_file():
        first = dot_git.read_text(encoding="utf-8").splitlines()
        if not first or not first[0].startswith("gitdir:"):
            return None
        raw = Path(first[0].split(":", 1)[1].strip())
        git_dir = raw if raw.is_absolute() else (root / raw).resolve()
    else:
        return None
    commondir = git_dir / "commondir"
    if commondir.is_file():
        rel = Path(commondir.read_text(encoding="utf-8").strip())
        return rel if rel.is_absolute() else (git_dir / rel).resolve()
    return git_dir


def _peel_loose_object(common: Path, oid: str) -> str | None:
    if not SHA.fullmatch(oid):
        return None
    obj_path = common / "objects" / oid[:2] / oid[2:]
    if not obj_path.is_file():
        return oid
    try:
        raw = zlib.decompress(obj_path.read_bytes())
    except (OSError, zlib.error):
        return None
    header, _, body = raw.partition(b"\x00")
    if header.startswith(b"commit "):
        return oid
    if not header.startswith(b"tag "):
        return None
    lines = body.decode("utf-8", errors="replace").splitlines()
    if len(lines) >= 2 and lines[0].startswith("object ") and lines[1] == "type commit":
        target = lines[0].split(" ", 1)[1].strip()
        return target if SHA.fullmatch(target) else None
    return None


def published_production_tag_shas(root: Path) -> frozenset[str]:
    """Read peeled commit SHAs of refs/tags/deployed/production* without subprocesses."""
    common = _common_git_dir(root)
    if common is None:
        return frozenset()
    found: set[str] = set()
    packed = common / "packed-refs"
    if packed.is_file():
        pending_ref: tuple[str, str] | None = None
        for raw_line in packed.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("^"):
                if pending_ref is not None:
                    peeled = line[1:].strip()
                    if SHA.fullmatch(peeled):
                        found.add(peeled)
                    pending_ref = None
                continue
            if pending_ref is not None:
                peeled = _peel_loose_object(common, pending_ref[0])
                if peeled is not None:
                    found.add(peeled)
                pending_ref = None
            parts = line.split(" ", 1)
            if len(parts) == 2 and (
                parts[1] == "refs/tags/deployed/production-latest"
                or parts[1].startswith("refs/tags/deployed/production/")
            ):
                pending_ref = (parts[0].strip(), parts[1].strip())
        if pending_ref is not None:
            peeled = _peel_loose_object(common, pending_ref[0])
            if peeled is not None:
                found.add(peeled)
    tags_root = common / "refs" / "tags" / "deployed"
    candidates = [tags_root / "production-latest"]
    prod_dir = tags_root / "production"
    if prod_dir.is_dir():
        candidates.extend(path for path in prod_dir.rglob("*") if path.is_file())
    for ref_file in candidates:
        if ref_file.is_file():
            oid = ref_file.read_text(encoding="utf-8", errors="replace").strip()
            peeled = _peel_loose_object(common, oid)
            if peeled is not None:
                found.add(peeled)
    return frozenset(found)


def validate_emergency_receipt(receipt_path: Path | None, *, root: Path) -> str | None:
    """Validate an immutable manual-emergency receipt and return its application SHA."""
    if receipt_path is None:
        return None
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    authority = receipt.get("authority") if isinstance(receipt, dict) else None
    baseline = receipt.get("baseline") if isinstance(receipt, dict) else None
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema_version") != 1
        or receipt.get("kind") != "manual-production-predecessor-exception"
        or receipt.get("ordinary_promotion_evidence") is not False
        or receipt.get("scope") not in {"backend", "all"}
        or not isinstance(authority, dict)
        or authority.get("mode") != "manual-emergency"
        or authority.get("frontend_auth_domain_refresh") is True
        or not isinstance(baseline, dict)
        or set(baseline) != {"backend", "frontend"}
    ):
        raise ValueError("emergency_receipt_invalid")
    application_sha = str(authority.get("application_sha") or "")
    source_ref = str(authority.get("source_ref") or "")
    run_id = str(authority.get("run_id") or "")
    run_attempt = str(authority.get("run_attempt") or "")
    env_run = os.environ.get("GITHUB_RUN_ID")
    env_attempt = os.environ.get("GITHUB_RUN_ATTEMPT")
    if (
        not SHA.fullmatch(application_sha)
        or not BRANCH.fullmatch(source_ref)
        or ".." in source_ref
        or source_ref.endswith(("/", ".", ".lock"))
        or not re.fullmatch(r"[1-9][0-9]*", run_id)
        or not re.fullmatch(r"[1-9][0-9]*", run_attempt)
        or (env_run is not None and env_run != run_id)
        or (env_attempt is not None and env_attempt != run_attempt)
    ):
        raise ValueError("emergency_receipt_authority_mismatch")
    for kind in ("backend", "frontend"):
        base_sha = str((baseline.get(kind) or {}).get("source") or "")
        if not SHA.fullmatch(base_sha):
            raise ValueError("emergency_receipt_baseline_invalid")
        ancestry = subprocess.run(  # noqa: S603
            ["git", "merge-base", "--is-ancestor", base_sha, application_sha],
            cwd=root,
            capture_output=True,
            timeout=30,
            check=False,
        )
        if ancestry.returncode != 0:
            raise ValueError("emergency_receipt_baseline_not_preserved")
    return application_sha
