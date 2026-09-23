#!/usr/bin/env python3
"""Generate portable `.agents/skills` symlinks for governed Codex skills."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = REPO_ROOT / ".codex" / "skills"
TARGET = REPO_ROOT / ".agents" / "skills"


def expected() -> dict[str, Path]:
    return {path.name: path for path in SOURCE.iterdir() if (path / "SKILL.md").is_file()}


def check() -> list[str]:
    errors = []
    for name, source in expected().items():
        target = TARGET / name
        if not target.is_symlink():
            errors.append(f"missing generated adapter: {target.relative_to(REPO_ROOT)}")
        elif target.resolve() != source.resolve():
            errors.append(f"adapter points elsewhere: {target.relative_to(REPO_ROOT)}")
    return errors


def write() -> list[str]:
    TARGET.mkdir(parents=True, exist_ok=True)
    errors = []
    for name in expected():
        target = TARGET / name
        if target.exists() or target.is_symlink():
            if target.is_symlink() and target.resolve() == (SOURCE / name).resolve():
                continue
            errors.append(f"refusing to replace non-generated adapter: {target.relative_to(REPO_ROOT)}")
            continue
        os.symlink(Path("../../.codex/skills") / name, target)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    errors = write() if args.write else check()
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Codex skill adapters are current ({len(expected())} generated, source=.codex/skills).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
