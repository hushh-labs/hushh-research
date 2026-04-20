#!/usr/bin/env python3
"""Create or update a GCP Secret Manager secret from file or stdin."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def _run(cmd: list[str], *, input_text: str | None = None) -> None:
    result = subprocess.run(
        cmd,
        input=input_text,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr or result.stdout)
        raise SystemExit(result.returncode)


def _secret_exists(project: str, secret: str) -> bool:
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "describe",
            secret,
            "--project",
            project,
            "--format=value(name)",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--secret", required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--value-file", type=Path)
    group.add_argument("--stdin", action="store_true")
    args = parser.parse_args()

    if args.stdin:
        payload = sys.stdin.read()
    else:
        payload = args.value_file.read_text(encoding="utf-8")

    if not _secret_exists(args.project, args.secret):
        _run(
            [
                "gcloud",
                "secrets",
                "create",
                args.secret,
                "--project",
                args.project,
                "--replication-policy=automatic",
            ]
        )

    _run(
        [
            "gcloud",
            "secrets",
            "versions",
            "add",
            args.secret,
            "--project",
            args.project,
            "--data-file=-",
        ],
        input_text=payload,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
