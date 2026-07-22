#!/usr/bin/env python3
"""Create a Supabase logical backup and upload it to GCS.

The script is designed for Cloud Run Jobs but can also run locally.
It emits a single JSON summary line:
  - message=backup.summary
  - status=ok|error
  - backup object/manifest paths
  - size/checksum/duration metrics
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from google.cloud import storage
except Exception:  # pragma: no cover - exercised in runtime checks
    storage = None  # type: ignore[assignment]


def _require_storage_lib() -> None:
    if storage is None:
        raise RuntimeError(
            "google-cloud-storage is not installed. Install dependencies and retry."
        )


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _required(value: str, env_name: str) -> str:
    clean = value.strip()
    if clean:
        return clean
    raise ValueError(f"missing required value: {env_name}")


def _normalize_prefix(prefix: str) -> str:
    normalized = prefix.strip().strip("/")
    return normalized or "prod/supabase-logical"


def _build_object_paths(prefix: str, now: datetime) -> tuple[str, str, str]:
    date_partition = now.strftime("date=%Y-%m-%d")
    timestamp = now.strftime("%Y%m%dT%H%M%SZ")
    base = f"{prefix}/{date_partition}/supabase-logical-{timestamp}"
    backup_object = f"{base}.dump.gz"
    manifest_object = f"{base}.manifest.json"
    latest_object = f"{prefix}/latest.json"
    return backup_object, manifest_object, latest_object


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _pg_dump_version(pg_dump_bin: str) -> str:
    try:
        proc = subprocess.run(
            [pg_dump_bin, "--version"],
            check=True,
            capture_output=True,
            text=True,
        )  # noqa: S603
        return proc.stdout.strip() or proc.stderr.strip() or "unknown"
    except Exception:
        return "unknown"


def _run_pg_dump(
    *,
    db_host: str,
    db_port: int,
    db_name: str,
    db_user: str,
    db_password: str,
    output_path: Path,
    timeout_seconds: int,
    pg_dump_bin: str,
) -> None:
    env = os.environ.copy()
    env["PGPASSWORD"] = db_password
    env["PGSSLMODE"] = "require"

    cmd = [
        pg_dump_bin,
        "--host",
        db_host,
        "--port",
        str(db_port),
        "--username",
        db_user,
        "--dbname",
        db_name,
        "--format=custom",
        "--no-owner",
        "--file",
        str(output_path),
    ]

    subprocess.run(  # noqa: S603
        cmd,
        check=True,
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout_seconds,
    )


def _gzip_file(source: Path, target: Path, compresslevel: int) -> None:
    with source.open("rb") as src, gzip.open(target, "wb", compresslevel=compresslevel) as dst:
        shutil.copyfileobj(src, dst)


def _upload_backup(
    *,
    project_id: str,
    bucket_name: str,
    backup_path: Path,
    backup_object: str,
    checksum_sha256: str,
    payload_metadata: dict[str, str],
) -> str:
    _require_storage_lib()
    client = storage.Client(project=project_id or None)
    bucket = client.bucket(bucket_name)
    backup_blob = bucket.blob(backup_object)
    backup_blob.metadata = {
        **payload_metadata,
        "checksum_sha256": checksum_sha256,
    }
    backup_blob.upload_from_filename(
        str(backup_path),
        content_type="application/gzip",
        if_generation_match=0,
    )
    return f"gs://{bucket_name}/{backup_object}"


def _verify_uploaded_backup(
    *, project_id: str, bucket_name: str, object_name: str, expected_checksum: str
) -> None:
    _require_storage_lib()
    blob = storage.Client(project=project_id or None).bucket(bucket_name).blob(object_name)
    with tempfile.TemporaryDirectory(prefix="backup-verify-") as tmp_dir:
        downloaded = Path(tmp_dir) / "backup.dump.gz"
        blob.download_to_filename(str(downloaded))
        actual = _sha256_file(downloaded)
    if actual != expected_checksum:
        raise RuntimeError("uploaded backup checksum verification failed")


def _upload_json(
    *, project_id: str, bucket_name: str, object_name: str,
    payload: dict[str, Any], immutable: bool
) -> None:
    _require_storage_lib()
    client = storage.Client(project=project_id or None)
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(object_name)
    blob.cache_control = "no-store"
    blob.upload_from_string(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=True),
        content_type="application/json",
        if_generation_match=0 if immutable else None,
    )


def _write_report(report_path: str, payload: dict[str, Any]) -> None:
    if not report_path:
        return
    path = Path(report_path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def run(args: argparse.Namespace) -> int:
    started_at = _utc_now()
    started_perf = time.perf_counter()

    payload: dict[str, Any]

    try:
        db_host = _required(args.db_host, "DB_HOST")
        db_user = _required(args.db_user, "DB_USER")
        db_password = _required(args.db_password, "DB_PASSWORD")
        db_name = args.db_name.strip() or "postgres"
        bucket_name = _required(args.bucket, "BACKUP_BUCKET")
        prefix = _normalize_prefix(args.prefix)
        project_id = args.project_id.strip()
        environment = (args.environment or "production").strip().lower()
        retention_days = int(args.retention_days)
        db_port = int(args.db_port)
        dump_timeout_seconds = int(args.dump_timeout_seconds)
        gzip_level = int(args.gzip_level)
        pg_dump_bin = str(args.pg_dump_bin or "pg_dump").strip()

        backup_object, manifest_object, latest_object = _build_object_paths(prefix, started_at)

        with tempfile.TemporaryDirectory(prefix="supabase-logical-backup-") as tmp_dir:
            tmp_path = Path(tmp_dir)
            raw_dump_path = tmp_path / "backup.dump"
            gzip_path = tmp_path / "backup.dump.gz"

            _run_pg_dump(
                db_host=db_host,
                db_port=db_port,
                db_name=db_name,
                db_user=db_user,
                db_password=db_password,
                output_path=raw_dump_path,
                timeout_seconds=dump_timeout_seconds,
                pg_dump_bin=pg_dump_bin,
            )

            _gzip_file(raw_dump_path, gzip_path, compresslevel=gzip_level)
            backup_size_bytes = gzip_path.stat().st_size
            checksum_sha256 = _sha256_file(gzip_path)

            metadata = {
                "env": environment,
                "db_name": db_name,
                "retention_days": str(retention_days),
                "created_at": _iso_utc(_utc_now()),
            }
            backup_object_uri = _upload_backup(
                project_id=project_id,
                bucket_name=bucket_name,
                backup_path=gzip_path,
                backup_object=backup_object,
                checksum_sha256=checksum_sha256,
                payload_metadata=metadata,
            )
            _verify_uploaded_backup(
                project_id=project_id,
                bucket_name=bucket_name,
                object_name=backup_object,
                expected_checksum=checksum_sha256,
            )

            completed_at = _utc_now()
            duration_ms = round((time.perf_counter() - started_perf) * 1000, 2)
            payload = {
                "message": "backup.summary",
                "status": "ok",
                "env": environment,
                "checked_at": _iso_utc(completed_at),
                "backup_started_at": _iso_utc(started_at),
                "backup_completed_at": _iso_utc(completed_at),
                "duration_ms": duration_ms,
                "project_id": project_id or "",
                "bucket": bucket_name,
                "prefix": prefix,
                "backup_object": backup_object,
                "backup_object_uri": backup_object_uri,
                "manifest_object": manifest_object,
                "manifest_object_uri": f"gs://{bucket_name}/{manifest_object}",
                "latest_object": latest_object,
                "latest_object_uri": f"gs://{bucket_name}/{latest_object}",
                "backup_size_bytes": backup_size_bytes,
                "checksum_sha256": checksum_sha256,
                "db_name": db_name,
                "retention_days": retention_days,
                "pg_dump_version": _pg_dump_version(pg_dump_bin),
            }

            _upload_json(
                project_id=project_id,
                bucket_name=bucket_name,
                object_name=manifest_object,
                payload=payload,
                immutable=True,
            )
            _upload_json(
                project_id=project_id,
                bucket_name=bucket_name,
                object_name=latest_object,
                payload=payload,
                immutable=False,
            )

        _write_report(args.report_path, payload)
        print(json.dumps(payload, separators=(",", ":"), ensure_ascii=True))
        return 0

    except Exception as exc:
        completed_at = _utc_now()
        duration_ms = round((time.perf_counter() - started_perf) * 1000, 2)
        payload = {
            "message": "backup.summary",
            "status": "error",
            "env": (args.environment or "production").strip().lower(),
            "checked_at": _iso_utc(completed_at),
            "backup_started_at": _iso_utc(started_at),
            "backup_completed_at": _iso_utc(completed_at),
            "duration_ms": duration_ms,
            "bucket": (args.bucket or "").strip(),
            "prefix": _normalize_prefix(args.prefix or ""),
            "error": str(exc),
        }
        _write_report(args.report_path, payload)
        print(json.dumps(payload, separators=(",", ":"), ensure_ascii=True))
        return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create and upload Supabase logical backups to GCS.")
    parser.add_argument("--project-id", default=os.getenv("PROJECT_ID", ""), help="GCP project ID.")
    parser.add_argument("--db-host", default=os.getenv("DB_HOST", ""), help="Database host.")
    parser.add_argument("--db-port", default=os.getenv("DB_PORT", "5432"), help="Database port.")
    parser.add_argument("--db-name", default=os.getenv("DB_NAME", "postgres"), help="Database name.")
    parser.add_argument("--db-user", default=os.getenv("DB_USER", ""), help="Database user.")
    parser.add_argument("--db-password", default=os.getenv("DB_PASSWORD", ""), help="Database password.")
    parser.add_argument("--bucket", default=os.getenv("BACKUP_BUCKET", ""), help="GCS bucket for backups.")
    parser.add_argument(
        "--prefix",
        default=os.getenv("BACKUP_PREFIX", "prod/supabase-logical"),
        help="Object prefix inside the backup bucket.",
    )
    parser.add_argument(
        "--retention-days",
        default=os.getenv("BACKUP_RETENTION_DAYS", "14"),
        help="Retention metadata value for emitted payload.",
    )
    parser.add_argument(
        "--dump-timeout-seconds",
        default=os.getenv("BACKUP_DUMP_TIMEOUT_SECONDS", "1800"),
        help="Timeout for pg_dump command.",
    )
    parser.add_argument(
        "--gzip-level",
        default=os.getenv("BACKUP_GZIP_LEVEL", "6"),
        help="gzip compresslevel (1-9).",
    )
    parser.add_argument(
        "--environment",
        default=os.getenv("ENVIRONMENT", "production"),
        help="Environment label for structured logs.",
    )
    parser.add_argument(
        "--report-path",
        default="",
        help="Optional local report output path.",
    )
    parser.add_argument(
        "--pg-dump-bin",
        default=os.getenv("PG_DUMP_BIN", "pg_dump"),
        help="Version-matched pg_dump executable; use the same major as the source server.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(run(parse_args()))
