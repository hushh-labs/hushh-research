#!/usr/bin/env python3
"""Read one owner's existing Hussh Drive connection into a local index export.

No scheduler, migration, PKM write or server index opt-in is changed. The normal
live grant/policy/generation checks remain in the transport. Private text and
vectors stay in memory. The output contains file metadata and placements only.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True, help="Exact authorized Hussh and Drive email.")
    parser.add_argument(
        "--env-file", type=Path, required=True, help="Existing backend configuration."
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--format", choices=("csv", "json"), default="csv")
    parser.add_argument("--time-zone", default="Asia/Kolkata")
    parser.add_argument("--deadline-seconds", type=int, default=1800)
    parser.add_argument(
        "--oauth-project",
        help="Read fixed Drive OAuth secrets from this project, or 'backend' for the active DB project.",
    )
    return parser.parse_args()


def _load_oauth(project: str):
    """Use the current operator's gcloud access; never echo credential material."""
    import shutil

    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", project):
        raise RuntimeError("oauth_project_mismatch")

    executable = shutil.which("gcloud.cmd" if os.name == "nt" else "gcloud")
    if not executable:
        raise RuntimeError("oauth_configuration_unavailable")
    for name in ("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"):
        result = subprocess.run(  # noqa: S603 - fixed subcommand/secrets and validated project
            [
                executable,
                "secrets",
                "versions",
                "access",
                "latest",
                f"--secret={name}",
                f"--project={project}",
                "--quiet",
            ],
            capture_output=True,
            timeout=30,
            check=False,
        )
        if result.returncode or not result.stdout.strip():
            raise RuntimeError("oauth_configuration_unavailable")
        os.environ[name] = result.stdout.decode().strip()


def _write(path: Path, value: str):
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise RuntimeError("output_exists")
    # Publish only a finished export; do not leave a partially written CSV.
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".drive-export-")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8-sig", newline="") as output:
            output.write(value)
        os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


async def export(args):
    from firebase_admin import auth

    from api.utils.firebase_admin import get_firebase_auth_app
    from hushh_mcp.services.drive_document_processor import IsolatedDocumentParser
    from hushh_mcp.services.drive_group_index_job import DriveGroupIndexJob
    from hushh_mcp.services.drive_groups.adapters import TransportHeadSource
    from hushh_mcp.services.drive_groups.export import csv_text, placement_rows
    from hushh_mcp.services.drive_groups.indexer import index_files
    from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
    from hushh_mcp.services.external_connector_oauth_service import (
        get_external_connector_oauth_service,
    )
    from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH, DriveReadError
    from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport
    from scripts.drive_group_local_adapters import LocalHeadEmbedder, windows_parser_process

    zone = ZoneInfo(args.time_zone)
    if os.getenv("ENVIRONMENT", "").lower() not in {"uat", "test", "local", "development"}:
        raise RuntimeError("local_environment_required")
    user = await asyncio.to_thread(auth.get_user_by_email, args.email, app=get_firebase_auth_app())
    if user.disabled or (user.email or "").casefold() != args.email.casefold():
        raise RuntimeError("owner_identity_mismatch")
    oauth = get_external_connector_oauth_service().drive()
    database = oauth.lifecycle.db
    try:
        # Read paths must not opportunistically purge unrelated owners' rows.
        lifecycle_read = oauth.lifecycle.read

        async def read_current(**kwargs):
            return await lifecycle_read(**{**kwargs, "purge": False})

        oauth.lifecycle.read = read_current
        row, credential = await oauth.current_credential(
            user_id=user.uid, required_profile="live", refresh=False
        )
        if (
            str(credential.get("accountLabel", "")).casefold() != args.email.casefold()
            or row["validation_state"] != "verified"
            or row["verified_policy_hash"] != LIVE_POLICY_HASH
        ):
            raise RuntimeError("drive_identity_mismatch")
        generation = row["connection_generation"]
        del credential
        # Flags/cohort are scoped to this disposable CLI process and exact UID.
        os.environ.update(
            GOOGLE_DRIVE_LIVE="true",
            DRIVE_FOUR_GROUP_INDEX_ENABLED="true",
            CONNECTOR_INTERNAL_OWNER_COHORT=user.uid,
            CONNECTOR_UAT_ALL_USERS="false",
        )

        preferences = DriveLivePreferences(db=database)

        def background_revision():
            with database.engine.begin() as connection:
                return preferences.background_current(
                    connection, user_id=user.uid, generation=generation, read_only=True
                )["revision"]

        expected_revision = await asyncio.to_thread(background_revision)

        def background_allowed():
            return background_revision() == expected_revision

        parser = IsolatedDocumentParser(process=windows_parser_process) if os.name == "nt" else None
        transport = GoogleDriveRestTransport(oauth=oauth, parser=parser)

        class Reads:
            async def read_tool(self, *, user_id, tool_name, arguments):
                if user_id != user.uid:
                    raise DriveReadError("connection_changed")
                if not await asyncio.to_thread(background_allowed):
                    raise DriveReadError("background_preparation_required")
                result = await transport.read_group_index_tool(
                    user_id=user_id,
                    tool_name=tool_name,
                    arguments=arguments,
                    expected_generation=generation,
                )
                if not await asyncio.to_thread(background_allowed):
                    raise DriveReadError("background_preparation_required")
                return result

        reads = Reads()
        rows, complete, limited = await DriveGroupIndexJob.list_files(reads, user.uid)
        print(
            json.dumps(
                {"stage": "listed", "files": len(rows), "complete": complete, "limited": limited}
            ),
            flush=True,
        )
        embedder = LocalHeadEmbedder()
        await embedder.embed(["Local index readiness check."])
        print(json.dumps({"stage": "model_ready"}), flush=True)
        indexed = await index_files(
            rows,
            heads=ProgressHeads(TransportHeadSource(reads, user.uid), len(rows)),
            embedder=embedder,
            owner_email=args.email,
        )
        projected = placement_rows(rows, indexed.files, zone=zone)
        value = (
            csv_text(projected)
            if args.format == "csv"
            else json.dumps(projected, ensure_ascii=False)
        )
        # Canonical live policy/validation and preference revision are rechecked
        # after embedding and serialization, immediately before publication.
        if not await asyncio.to_thread(background_allowed):
            raise DriveReadError("background_preparation_required")
        _write(args.output, value)
        return {
            "status": "exported",
            "files": len(projected),
            "skipped": indexed.skipped,
            "listingComplete": complete,
            "limited": limited,
            "groups": dict(Counter(file.placement.shelf for file in indexed.files)),
        }
    finally:
        database.engine.dispose()


def main():
    args = _arguments()
    from dotenv import load_dotenv

    logging.disable(logging.CRITICAL)
    # Documents and credentials are never written to stdout, including failures.
    if not args.env_file.is_file():
        print(json.dumps({"status": "error", "code": "configuration_unavailable"}), file=sys.stderr)
        return 1
    load_dotenv(args.env_file, override=False)
    os.environ.update(
        HF_HUB_OFFLINE="1",
        TRANSFORMERS_OFFLINE="1",
        HF_HUB_DISABLE_TELEMETRY="1",
        TOKENIZERS_PARALLELISM="false",
        OMP_NUM_THREADS="1",
        MKL_NUM_THREADS="1",
        OPENBLAS_NUM_THREADS="1",
    )
    try:
        if args.output.exists():
            raise RuntimeError("output_exists")
        if args.oauth_project:
            project = os.environ.get("CLOUDSQL_INSTANCE_CONNECTION_NAME", "").split(":", 1)[0]
            if not project or args.oauth_project not in {"backend", project}:
                raise RuntimeError("oauth_project_mismatch")
            _load_oauth(project)
        if not 1 <= args.deadline_seconds <= 7200:
            raise RuntimeError("invalid_deadline")

        async def bounded_export():
            async with asyncio.timeout(args.deadline_seconds):
                return await export(args)

        result = asyncio.run(bounded_export())
    except KeyboardInterrupt:
        print(json.dumps({"status": "cancelled"}), file=sys.stderr)
        return 1
    except Exception as error:
        allowed = {
            "reconnect_required",
            "connection_changed",
            "connector_unavailable",
            "processor_unavailable",
            "processing_timeout",
            "background_preparation_required",
            "owner_identity_mismatch",
            "drive_identity_mismatch",
            "output_exists",
            "local_environment_required",
            "oauth_configuration_unavailable",
            "oauth_project_mismatch",
            "invalid_deadline",
        }
        code = str(error) if str(error) in allowed else "export_unavailable"
        print(
            json.dumps({"status": "error", "code": code, "errorType": type(error).__name__}),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


class ProgressHeads:
    """Counts only; never emits names, IDs or document text."""

    def __init__(self, source, total):
        self.source, self.total = source, total
        self.done, self.readable = 0, 0

    async def head(self, row):
        head = await self.source.head(row)
        self.done += 1
        self.readable += bool(head)
        if self.done % 25 == 0 or self.done == self.total:
            print(
                json.dumps({"stage": "read", "files": self.done, "textHeads": self.readable}),
                flush=True,
            )
        return head


if __name__ == "__main__":
    raise SystemExit(main())
