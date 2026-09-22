#!/usr/bin/env python3
"""Manual Gmail cache maintenance; report by default and bind one explicit owner."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "consent-protocol"))

from hushh_mcp.services.gmail_cache_retention import maintain_gmail_cache  # noqa: E402


def _source_context() -> dict[str, object]:
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        ).stdout.strip()
        state = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {"revision": None, "working_tree": "unverified"}
    return {"revision": revision, "working_tree": "dirty" if state else "clean"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database-url-env", required=True, help="Existing environment variable name."
    )
    parser.add_argument(
        "--owner-id-env", required=True, help="Existing environment variable name."
    )
    parser.add_argument("--batch-limit", type=int, default=200)
    parser.add_argument(
        "--apply", action="store_true", help="Delete one bounded batch per table."
    )
    args = parser.parse_args(argv)
    engine = None
    try:
        database_url = os.environ.get(args.database_url_env, "")
        owner_id = os.environ.get(args.owner_id_env, "")
        if not database_url.strip() or not owner_id.strip():
            raise ValueError(
                "Required connection or owner configuration is unavailable."
            )
        engine = create_engine(
            database_url,
            poolclass=NullPool,
            connect_args={"connect_timeout": 5},
            hide_parameters=True,
        )
        report = maintain_gmail_cache(
            engine, user_id=owner_id, apply=args.apply, batch_limit=args.batch_limit
        )
    except Exception as exc:
        # Provider/database errors can embed credentials and information. Never
        # render the exception, cause, query parameters, URL, or owner here.
        print(json.dumps({"status": "unavailable", "error_type": type(exc).__name__}))
        return 1
    finally:
        if engine is not None:
            engine.dispose()
    report["source"] = _source_context()
    print(json.dumps(report, indent=2))
    return 0 if report["scope_drained"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
