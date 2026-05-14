#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
BLOCKED_SUFFIXES = (
    ".db",
    ".sqlite",
    ".sqlite3",
)
BLOCKED_PATH_PARTS = (
    "vector-store",
    "vector_store",
    "vectorstores",
    "vector-stores",
    "chroma",
    "chromadb",
    "faiss",
)
ALLOWLIST = {
    "scripts/ci/verify-no-runtime-artifacts.py",
}


def _tracked_files() -> list[str]:
    output = subprocess.check_output(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        text=False,
    )
    return [
        item.decode("utf-8")
        for item in output.split(b"\0")
        if item
    ]


def _is_blocked(path: str) -> bool:
    normalized = path.replace("\\", "/")
    lowered = normalized.lower()
    if normalized in ALLOWLIST:
        return False
    if lowered.endswith(BLOCKED_SUFFIXES):
        return True
    return any(part in lowered for part in BLOCKED_PATH_PARTS)


def main() -> int:
    offenders = sorted(path for path in _tracked_files() if _is_blocked(path))
    if offenders:
        print("ERROR: generated vector-store or SQLite runtime artifacts are tracked:")
        for path in offenders:
            print(f"- {path}")
        print("Move generated runtime state to tmp/, local data storage, or another ignored path.")
        return 1

    print("OK: no generated vector-store or SQLite runtime artifacts are tracked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
