#!/usr/bin/env python3
"""Restore a checksummed logical backup into a verified-empty isolated clone.

This tool refuses broad or production-like targets, never uses ``--clean``, and
never prints connection details. Run the preservation manifest comparison after
this command; a successful restore alone is not baseline evidence.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse

import asyncpg


_ALLOWED_ENVIRONMENTS = {"local", "development", "dev", "test", "uat"}
_SAFE_DATABASE_MARKERS = ("clone", "restore", "test", "rehearsal")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _target_env(database_url: str) -> tuple[dict[str, str], str]:
    parsed = urlparse(database_url)
    database = unquote(parsed.path.lstrip("/"))
    if not database or not any(marker in database.lower() for marker in _SAFE_DATABASE_MARKERS):
        raise ValueError("target database name must identify an isolated clone/test/rehearsal")
    env = os.environ.copy()
    env.update(
        {
            "PGHOST": parsed.hostname or "",
            "PGPORT": str(parsed.port or 5432),
            "PGUSER": unquote(parsed.username or ""),
            "PGPASSWORD": unquote(parsed.password or ""),
            "PGDATABASE": database,
            "PGSSLMODE": os.getenv("DB_SSLMODE", "require"),
        }
    )
    if not env["PGHOST"] or not env["PGUSER"] or not env["PGPASSWORD"]:
        raise ValueError("target database URL is incomplete")
    return env, database


async def _assert_empty(database_url: str) -> None:
    conn = await asyncpg.connect(database_url, command_timeout=30)
    try:
        count = await conn.fetchval(
            """
            SELECT COUNT(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            """
        )
        if int(count or 0) != 0:
            raise RuntimeError("isolated restore target is not empty")
    finally:
        await conn.close()


def run(args: argparse.Namespace) -> int:
    environment = str(args.environment or "").strip().lower()
    if environment not in _ALLOWED_ENVIRONMENTS:
        raise ValueError("isolated restore is prohibited for this environment")
    backup = Path(args.backup).expanduser().resolve()
    if not backup.is_file():
        raise FileNotFoundError("backup artifact is missing")
    checksum = str(args.checksum_sha256 or "").strip().lower()
    if len(checksum) != 64 or _sha256(backup) != checksum:
        raise RuntimeError("backup checksum verification failed")
    target_url = str(args.target_database_url or "").strip()
    pg_env, database = _target_env(target_url)
    asyncio.run(_assert_empty(target_url))

    with tempfile.TemporaryDirectory(prefix="uat-clone-restore-") as tmp_dir:
        dump_path = Path(tmp_dir) / "backup.dump"
        if backup.suffix == ".gz":
            with gzip.open(backup, "rb") as source, dump_path.open("wb") as target:
                shutil.copyfileobj(source, target)
        else:
            shutil.copyfile(backup, dump_path)
        subprocess.run(
            [
                str(args.pg_restore_bin or "pg_restore"),
                "--exit-on-error",
                "--no-owner",
                "--dbname",
                database,
                str(dump_path),
            ],
            check=True,
            capture_output=True,
            text=True,
            env=pg_env,
            timeout=int(args.timeout_seconds),
        )
    print(json.dumps({"status": "ok", "checksum_sha256": checksum}))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", required=True)
    parser.add_argument("--checksum-sha256", required=True)
    parser.add_argument(
        "--target-database-url",
        default=os.getenv("RESTORE_TARGET_DATABASE_URL", ""),
    )
    parser.add_argument("--environment", default=os.getenv("ENVIRONMENT", ""))
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument(
        "--pg-restore-bin",
        default=os.getenv("PG_RESTORE_BIN", "pg_restore"),
        help="Version-matched pg_restore executable for the backup archive.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    try:
        raise SystemExit(run(parse_args()))
    except Exception as exc:
        print(json.dumps({"status": "error", "failure_class": type(exc).__name__}))
        raise SystemExit(1) from None
