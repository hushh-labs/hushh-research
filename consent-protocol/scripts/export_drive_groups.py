#!/usr/bin/env python3
"""Read one owner's existing Hussh Drive connection into a local index export.

No scheduler, migration, PKM write or server index opt-in is changed. The normal
live grant/policy/generation checks remain in the transport. Private text and
vectors remain in memory unless --persist-content saves them in an encrypted
checkpoint. --include-content explicitly includes them in the private CSV.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from contextlib import AsyncExitStack
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
    parser.add_argument(
        "--persist-content",
        action="store_true",
        help="Retain text starts and vectors in an encrypted local checkpoint.",
    )
    parser.add_argument(
        "--include-content",
        action="store_true",
        help="Explicitly include private plaintext text starts and vectors in the export.",
    )
    parser.add_argument("--time-zone", default="Asia/Kolkata")
    parser.add_argument("--deadline-seconds", type=int, default=1800)
    parser.add_argument(
        "--raw-prefix-kib",
        type=int,
        choices=(200,),
        help="Index only the first 200 KiB of uploaded-file bytes.",
    )
    parser.add_argument(
        "--read-concurrency",
        type=int,
        choices=range(1, 33),
        default=6,
        help="Concurrent fenced reads (default: 6); parser children remain capped at two.",
    )
    parser.add_argument(
        "--resume", action="store_true", help="Resume this owner's matching local checkpoint."
    )
    parser.add_argument(
        "--oauth-project",
        help="Read fixed Drive OAuth secrets from this project, or 'backend' for the active DB project.",
    )
    return parser.parse_args()


def _load_oauth(project: str, *, processing_key: bool = False):
    names = ("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET")
    if processing_key and not os.getenv("DRIVE_DOCUMENT_KEY_V1"):
        names += ("DRIVE_DOCUMENT_KEY_V1",)
    _load_secrets(project, names)


def _load_secrets(project: str, names: tuple[str, ...]):
    """Use the current operator's gcloud access; never echo credential material."""
    import shutil

    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", project):
        raise RuntimeError("oauth_project_mismatch")
    if not set(names) <= {
        "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
        "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
        "DRIVE_DOCUMENT_KEY_V1",
    }:
        raise RuntimeError("oauth_configuration_unavailable")

    executable = shutil.which("gcloud.cmd" if os.name == "nt" else "gcloud")
    if not executable:
        raise RuntimeError("oauth_configuration_unavailable")
    for name in names:
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


def _write(path: Path, value: str, *, replace: bool = False):
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not replace:
        raise RuntimeError("output_exists")
    # Every published checkpoint is a complete file, including explicit pending rows.
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".drive-export-")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8-sig", newline="") as output:
            output.write(value)
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


async def export(args):
    from firebase_admin import auth
    from sqlalchemy import text

    from api.utils.firebase_admin import get_firebase_auth_app
    from hushh_mcp.services.drive_document_processor import IsolatedDocumentParser
    from hushh_mcp.services.drive_groups.adapters import TransportHeadSource
    from hushh_mcp.services.drive_groups.export import csv_text, pending_rows, placement_rows
    from hushh_mcp.services.drive_groups.indexer import index_files
    from hushh_mcp.services.drive_groups.models import load_bundle
    from hushh_mcp.services.drive_live_preferences import (
        LIVE_BACKGROUND_DISCLOSURE,
        DriveLivePreferences,
    )
    from hushh_mcp.services.external_connector_oauth_service import (
        get_external_connector_oauth_service,
    )
    from hushh_mcp.services.google_drive_adapter import (
        LIVE_EXPORTS,
        LIVE_EXTRACTABLE_ORIGINAL_TYPES,
        LIVE_POLICY_HASH,
        DriveReadError,
    )
    from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport
    from scripts.drive_group_local_adapters import (
        LocalCredentialReader,
        LocalHeadEmbedder,
        retry_read,
        windows_parser_process,
    )
    from scripts.drive_group_local_content import (
        CONTENT_COLUMNS,
        LocalExportContent,
        content_context,
        open_checkpoint,
    )
    from scripts.drive_group_local_inventory import load_inventory

    zone = ZoneInfo(args.time_zone)
    persist_content = getattr(args, "persist_content", False)
    include_content = getattr(args, "include_content", False)
    if include_content and not persist_content:
        raise RuntimeError("content_persistence_required")
    prefix_mode = getattr(args, "raw_prefix_kib", None) == 200
    source_types = (
        LIVE_EXTRACTABLE_ORIGINAL_TYPES - frozenset(LIVE_EXPORTS)
        if prefix_mode
        else LIVE_EXTRACTABLE_ORIGINAL_TYPES
    )
    if os.getenv("ENVIRONMENT", "").lower() not in {"uat", "test", "local", "development"}:
        raise RuntimeError("local_environment_required")
    user = await asyncio.to_thread(auth.get_user_by_email, args.email, app=get_firebase_auth_app())
    if user.disabled or (user.email or "").casefold() != args.email.casefold():
        raise RuntimeError("owner_identity_mismatch")
    oauth = get_external_connector_oauth_service().drive()
    database = oauth.lifecycle.db
    sessions = AsyncExitStack()
    try:
        # Read paths must not opportunistically purge unrelated owners' rows.
        lifecycle_read = oauth.lifecycle.read

        async def read_current(**kwargs):
            return await lifecycle_read(**{**kwargs, "purge": False})

        oauth.lifecycle.read = read_current
        # Credential refresh is single-flight within this local run. Another
        # reader must not cancel the refresh by racing the same lease.
        oauth.current_credential = LocalCredentialReader(oauth.current_credential)
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
        fresh_authority = None
        if prefix_mode:
            from scripts.drive_group_local_authority import FreshDriveReadAuthority

            fresh_authority = FreshDriveReadAuthority(
                oauth, owner=user.uid, generation=generation, revision=expected_revision
            )
            sessions.callback(fresh_authority.close)

        def background_allowed():
            return background_revision() == expected_revision

        def revision_unchanged():
            # Transport owns live grant/policy fencing for each provider call;
            # keep this hot check to one owner-scoped MVCC query. Publishing
            # still uses the full canonical policy check above.
            with database.engine.connect() as connection:
                preference = (
                    connection.execute(
                        text(
                            "SELECT background_enabled,disclosure_version,revision FROM drive_live_preferences WHERE user_id=:user"
                        ),
                        {"user": user.uid},
                    )
                    .mappings()
                    .first()
                )
                return expected_revision == (preference["revision"] if preference else 0) and (
                    preference is None
                    or preference["background_enabled"] is True
                    and preference["disclosure_version"] == LIVE_BACKGROUND_DISCLOSURE
                )

        parser = IsolatedDocumentParser(process=windows_parser_process) if os.name == "nt" else None
        transport = GoogleDriveRestTransport(
            oauth=fresh_authority.oauth if fresh_authority else oauth,
            parser=parser,
            **({"raw_prefix": True} if prefix_mode else {}),
        )
        await sessions.enter_async_context(transport.owner_search_session())

        class Reads:
            async def read_tool(self, *, user_id, tool_name, arguments):
                if user_id != user.uid:
                    raise DriveReadError("connection_changed")

                async def fenced_read():
                    if fresh_authority:
                        async with fresh_authority.operation():
                            return await transport.read_group_index_tool(
                                user_id=user_id,
                                tool_name=tool_name,
                                arguments=arguments,
                                expected_generation=generation,
                            )
                    if not await asyncio.to_thread(revision_unchanged):
                        raise DriveReadError("background_preparation_required")
                    return await transport.read_group_index_tool(
                        user_id=user_id,
                        tool_name=tool_name,
                        arguments=arguments,
                        expected_generation=generation,
                    )

                result = await retry_read(fenced_read)
                if not fresh_authority and not await asyncio.to_thread(revision_unchanged):
                    raise DriveReadError("background_preparation_required")
                return result

        reads = Reads()
        bundle = load_bundle()
        context = {
            "schema": 1,
            "owner": hashlib.sha256(user.uid.encode()).hexdigest(),
            "generation": generation,
            "revision": expected_revision,
            "model": bundle.version,
            "zone": args.time_zone,
            "format": args.format,
            **({"evidence_mode": "raw_prefix_204800"} if prefix_mode else {}),
            **(
                {**content_context(), "include_content": include_content} if persist_content else {}
            ),
        }
        content = LocalExportContent(owner=user.uid, context=context) if persist_content else None
        checkpoint = args.output.with_name(args.output.name + ".checkpoint.json")
        cached, saved = {}, {}
        if getattr(args, "resume", False) and checkpoint.exists():
            saved = json.loads(checkpoint.read_text(encoding="utf-8-sig"))
            if saved.get("context") != context:
                raise RuntimeError("checkpoint_context_changed")
            if content:
                open_checkpoint(saved)
            cached = saved["items"]
        elif checkpoint.exists():
            raise RuntimeError("output_exists")
        inventory_started = time.perf_counter()
        inventory = await load_inventory(reads, user.uid, saved=saved.get("inventory"))
        inventory_seconds = time.perf_counter() - inventory_started
        rows, complete, limited = inventory.rows, inventory.complete, inventory.limited
        print(
            json.dumps(
                {
                    "stage": "listed",
                    "files": len(rows),
                    "complete": complete,
                    "limited": limited,
                    "mode": inventory.mode,
                }
            ),
            flush=True,
        )
        cached = {
            row["id"]: cached[row["id"]]
            for row in rows
            if row["id"] in cached and cached[row["id"]]["version"] == row["version"]
        }
        pending = [row for row in rows if row["id"] not in cached]
        reused = len(cached)
        metadata_only = [row for row in pending if row["mimeType"] not in source_types]
        readable = [row for row in pending if row["mimeType"] in source_types]
        batches = ([metadata_only] if metadata_only else []) + (
            ([readable] if readable else [])
            if prefix_mode
            else [readable[start : start + 25] for start in range(0, len(readable), 25)]
        )
        placeholders = pending_rows(rows)
        published = args.output.exists()

        async def publish():
            nonlocal published
            projected = [
                content.project(row["id"], cached[row["id"]], include_content=include_content)
                if content and row["id"] in cached
                else cached[row["id"]]["item"]
                if row["id"] in cached
                else placeholder
                for row, placeholder in zip(rows, placeholders, strict=True)
            ]
            value = (
                csv_text(projected, **({"columns": CONTENT_COLUMNS} if content else {}))
                if args.format == "csv"
                else json.dumps(projected, ensure_ascii=False)
            )
            snapshot = {
                "context": context,
                "items": cached,
                "inventory": inventory.checkpoint(completed=len(cached) == len(rows)),
                **({"content_index": content.header} if content else {}),
            }
            if content:
                snapshot["content_manifest"] = content.manifest(snapshot)
            serialized = json.dumps(snapshot, ensure_ascii=False, allow_nan=False)
            # Finish encryption and serialization before the final policy/revision
            # check. Only the atomic file publications follow that fresh fence.
            if not await asyncio.to_thread(background_allowed):
                raise DriveReadError("background_preparation_required")
            _write(
                checkpoint,
                serialized,
                replace=checkpoint.exists(),
            )
            _write(args.output, value, replace=published)
            published = True

        await publish()
        print(
            json.dumps({"stage": "checkpoint", "indexed": len(cached), "pending": len(pending)}),
            flush=True,
        )
        embedder = LocalHeadEmbedder()
        heads = ProgressHeads(
            TransportHeadSource(reads, user.uid, mime_types=source_types), len(pending)
        )
        skipped = 0
        index_seconds = 0.0
        for batch in batches:
            index_started = time.perf_counter()
            indexed = await index_files(
                batch,
                heads=heads,
                embedder=embedder,
                owner_email=args.email,
                bundle=bundle,
                read_concurrency=getattr(args, "read_concurrency", 6),
                **({"require_head": True} if prefix_mode else {}),
                **({"retain_evidence": True} if content else {}),
            )
            index_seconds += time.perf_counter() - index_started
            projected = placement_rows(batch, indexed.files, zone=zone)
            if prefix_mode:
                for row, item in zip(batch, projected, strict=True):
                    item["index_status"] = (
                        "indexed_raw_prefix"
                        if row["id"] in heads.text_files
                        else "prefix_unreadable"
                        if row["mimeType"] in source_types
                        else "prefix_unavailable"
                        if row["mimeType"] in LIVE_EXPORTS
                        else "metadata_only"
                    )
                    if item["index_status"] != "indexed_raw_prefix":
                        item["reason"] = item["index_status"]
                        for key in (
                            "confidence",
                            "model_top_class",
                            "candidate_group",
                            "group_source",
                            "model_version",
                        ):
                            item[key] = ""
            versions = {row["id"]: row["version"] for row in batch}
            by_id = {row["id"]: row for row in batch}
            for item, file in zip(projected, indexed.files, strict=True):
                cached[file.file_id] = (
                    content.seal(by_id[file.file_id], file, item)
                    if content
                    else {
                        "version": versions[file.file_id],
                        "shelf": file.placement.shelf,
                        "item": item,
                    }
                )
            skipped += indexed.skipped
            await publish()
            print(
                json.dumps(
                    {
                        "stage": "checkpoint",
                        "indexed": len(cached),
                        "pending": len(rows) - len(cached),
                    }
                ),
                flush=True,
            )
        return {
            "status": "exported",
            "files": len(rows),
            "skipped": skipped,
            "listingComplete": complete,
            "limited": limited,
            "refreshMode": inventory.mode,
            "evidenceMode": "raw_prefix_204800" if prefix_mode else "full",
            "inventoryDurationSeconds": round(inventory_seconds, 3),
            "indexDurationSeconds": round(index_seconds, 3),
            "reusedFiles": reused,
            "changedFiles": len(pending),
            **(
                {
                    "contentPersisted": True,
                    "textStarts": sum(
                        bool(item["item"]["text_start_chars"]) for item in cached.values()
                    ),
                    "embeddings": sum(
                        bool(item["item"]["embedding_dimensions"]) for item in cached.values()
                    ),
                }
                if content
                else {}
            ),
            "groups": dict(Counter(item["shelf"] for item in cached.values())),
        }
    finally:
        try:
            await sessions.aclose()
        finally:
            database.engine.dispose()


def main():
    started = time.perf_counter()
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
        checkpoint = args.output.with_name(args.output.name + ".checkpoint.json")
        if args.output.exists() and (not args.resume or not checkpoint.exists()):
            raise RuntimeError("output_exists")
        if args.oauth_project:
            project = os.environ.get("CLOUDSQL_INSTANCE_CONNECTION_NAME", "").split(":", 1)[0]
            if not project or args.oauth_project not in {"backend", project}:
                raise RuntimeError("oauth_project_mismatch")
            _load_oauth(project, processing_key=args.persist_content)
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
            "checkpoint_context_changed",
            "refresh_in_progress",
            "grant_rejected",
            "provider_unavailable",
            "connector_configuration_invalid",
            "invalid_argument",
            "identity_not_verified",
            "unexpected_scope",
            "insufficient_scope",
            "content_persistence_required",
            "content_invalid",
            "content_context_changed",
            "document_storage_unavailable",
        }
        code = str(error) if str(error) in allowed else "export_unavailable"
        print(
            json.dumps({"status": "error", "code": code, "errorType": type(error).__name__}),
            file=sys.stderr,
        )
        return 1
    result["durationSeconds"] = round(time.perf_counter() - started, 3)
    print(json.dumps(result, sort_keys=True))
    return 0


class ProgressHeads:
    """Counts only; never emits names, IDs or document text."""

    def __init__(self, source, total):
        self.source, self.total = source, total
        self.done, self.readable = 0, 0
        self.text_files = set()

    async def head(self, row):
        head = await self.source.head(row)
        self.done += 1
        self.readable += bool(head)
        if head:
            self.text_files.add(row["id"])
        if self.done % 25 == 0 or self.done == self.total:
            print(
                json.dumps({"stage": "read", "files": self.done, "textHeads": self.readable}),
                flush=True,
            )
        return head


if __name__ == "__main__":
    raise SystemExit(main())
