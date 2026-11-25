# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Content-addressed incremental encrypted workspace sync over ObjectStore (#9744).

Replaces whole-archive 32 MiB tarball re-packing with deduplicated <= 4 MiB
content-addressed AES-256-GCM chunks and atomic compare-and-swap manifest heads
for NIST SC-13, SC-28(1), and SP 800-88 cryptographic erasure across clouds.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from hushh_mcp.operons.pod_workspace.resource_guard import DISPOSABLE_CACHE_DIRS
from hushh_mcp.services.pod_object_version import ABSENT
from hushh_mcp.services.pod_workspace.checkpoint_store import (
    WorkspaceCheckpointLibrary,
    WorkspaceRefused,
    _is_excluded_workspace_member,
    _validate_tar_member_path,
    validate_workspace_id,
)

DEFAULT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024
MAX_CAS_CHUNK_ENCRYPTED_BYTES = DEFAULT_CHUNK_SIZE_BYTES + 4096
DEFAULT_MAX_CAS_WORKSPACE_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_CAS_FILES = 25_000
MAX_CAS_MANIFEST_BYTES = 8 * 1024 * 1024
_CAS_SKIP_DIRS = frozenset(DISPOSABLE_CACHE_DIRS) | {"node_modules", ".venv"}


class WorkspaceCasSyncStore:
    """Incremental chunk-deduplicated encrypted workspace sync reusing ObjectStore."""

    def __init__(
        self,
        checkpoints: WorkspaceCheckpointLibrary,
        *,
        chunk_size_bytes: int = DEFAULT_CHUNK_SIZE_BYTES,
        max_workspace_bytes: int = DEFAULT_MAX_CAS_WORKSPACE_BYTES,
        max_files: int = DEFAULT_MAX_CAS_FILES,
    ) -> None:
        self.checkpoints = checkpoints
        self.chunk_size_bytes = max(4096, min(DEFAULT_CHUNK_SIZE_BYTES, int(chunk_size_bytes)))
        self.max_workspace_bytes = max(65536, int(max_workspace_bytes))
        self.max_files = max(1, int(max_files))

    async def read_head(self, workspace_id: str) -> tuple[dict[str, Any] | None, Any]:
        clean_ws = validate_workspace_id(workspace_id)
        head_path = self.checkpoints._opaque_path(clean_ws, "cas_heads", "current")
        raw, gen = await self.checkpoints._get_bounded(head_path, max_bytes=MAX_CAS_MANIFEST_BYTES)
        if raw is None:
            return None, ABSENT
        doc = json.loads(
            self.checkpoints._open(
                self.checkpoints._meta_key,
                raw,
                self.checkpoints._aad(clean_ws, head_path),
            ).decode("utf-8")
        )
        return dict(doc), gen

    @staticmethod
    def _collect_files(
        workspace_dir: Path,
        *,
        max_workspace_bytes: int,
        max_files: int,
    ) -> list[tuple[str, Path, int]]:
        collected: list[tuple[str, Path, int]] = []
        total_bytes = 0
        if not workspace_dir.exists():
            return collected
        for dirpath, dirnames, filenames in os.walk(workspace_dir, followlinks=False):
            dirnames[:] = sorted(
                d
                for d in dirnames
                if d not in _CAS_SKIP_DIRS and not os.path.islink(os.path.join(dirpath, d))
            )
            for fname in sorted(filenames):
                full = Path(dirpath) / fname
                if full.is_symlink() or not full.is_file():
                    continue
                rel = full.relative_to(workspace_dir).as_posix()
                clean_rel = _validate_tar_member_path(rel)
                if _is_excluded_workspace_member(clean_rel):
                    continue
                if len(collected) + 1 > max_files:
                    raise WorkspaceRefused("WORKSPACE_TOO_MANY_FILES", 413)
                size = full.stat().st_size
                total_bytes += size
                if total_bytes > max_workspace_bytes:
                    raise WorkspaceRefused("WORKSPACE_ARCHIVE_TOO_LARGE", 413)
                mode = 0o755 if (full.stat().st_mode & 0o111) else 0o644
                collected.append((clean_rel, full, mode))
        return collected

    async def sync_from_directory(
        self,
        workspace_id: str,
        workspace_dir: Path,
        *,
        expected_revision: int | None = None,
        reason: str = "checkpoint",
    ) -> dict[str, Any]:
        """Diff local NVMe directory against CAS head and upload only new/changed chunks."""
        clean_ws = validate_workspace_id(workspace_id)
        current_head, current_gen = await self.read_head(clean_ws)
        if current_head is not None and current_head.get("forgotten") is True:
            if expected_revision not in {None, 0}:
                raise WorkspaceRefused("WORKSPACE_FORGOTTEN", 410)
            epoch = int(current_head.get("key_epoch", 1)) + 1
            prior_rev = int(current_head.get("revision", 0))
            known_chunks: set[str] = set()
        elif current_head is not None:
            prior_rev = int(current_head["revision"])
            if expected_revision is not None and expected_revision != prior_rev:
                raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
            epoch = int(current_head.get("key_epoch", 1))
            known_chunks = {
                str(chunk["sha256"])
                for file_entry in (current_head.get("files") or ())
                for chunk in (file_entry.get("chunks") or ())
            }
        else:
            if expected_revision not in {None, 0}:
                raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
            prior_rev = 0
            epoch = 1
            known_chunks = set()

        entries = self._collect_files(
            workspace_dir,
            max_workspace_bytes=self.max_workspace_bytes,
            max_files=self.max_files,
        )
        layer_key = self.checkpoints._layer_key(clean_ws, epoch)
        file_manifests: list[dict[str, Any]] = []
        uploaded_chunks = 0
        reused_chunks = 0
        total_bytes = 0
        chunk_paths_seen: set[str] = set()

        for clean_rel, full, mode in entries:
            file_hasher = hashlib.sha256()
            file_chunks: list[dict[str, Any]] = []
            file_size = 0
            with full.open("rb") as handle:
                while True:
                    plain_chunk = handle.read(self.chunk_size_bytes)
                    if not plain_chunk:
                        break
                    file_size += len(plain_chunk)
                    total_bytes += len(plain_chunk)
                    file_hasher.update(plain_chunk)
                    chunk_sha256 = hashlib.sha256(plain_chunk).hexdigest()
                    chunk_path = self.checkpoints._opaque_path(
                        clean_ws, "cas_chunks", f"e{epoch}_{chunk_sha256}"
                    )
                    chunk_paths_seen.add(chunk_path)
                    if chunk_sha256 in known_chunks:
                        reused_chunks += 1
                    else:
                        await self.checkpoints.check()
                        sealed_chunk = self.checkpoints._seal(
                            layer_key,
                            plain_chunk,
                            self.checkpoints._aad(clean_ws, chunk_path),
                        )
                        put_ver = await self.checkpoints.store.put_if_generation(
                            chunk_path, sealed_chunk, ABSENT
                        )
                        if put_ver is None:
                            # Already staged earlier inside the same epoch: verify decrypt integrity.
                            existing_raw, _ = await self.checkpoints._get_bounded(
                                chunk_path, max_bytes=MAX_CAS_CHUNK_ENCRYPTED_BYTES
                            )
                            if existing_raw is None:
                                raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
                            existing_plain = self.checkpoints._open(
                                layer_key,
                                existing_raw,
                                self.checkpoints._aad(clean_ws, chunk_path),
                            )
                            if hashlib.sha256(existing_plain).hexdigest() != chunk_sha256:
                                raise WorkspaceRefused("WORKSPACE_DIGEST_MISMATCH", 500)
                            reused_chunks += 1
                        else:
                            uploaded_chunks += 1
                        known_chunks.add(chunk_sha256)
                    file_chunks.append(
                        {
                            "sha256": chunk_sha256,
                            "bytes": len(plain_chunk),
                            "path": chunk_path,
                        }
                    )

            file_manifests.append(
                {
                    "path": clean_rel,
                    "mode": mode,
                    "bytes": file_size,
                    "sha256": file_hasher.hexdigest(),
                    "chunks": file_chunks,
                }
            )

        next_rev = prior_rev + 1
        head_doc: dict[str, Any] = {
            "schema_version": 1,
            "workspace_id": clean_ws,
            "revision": next_rev,
            "key_epoch": epoch,
            "forgotten": False,
            "file_count": len(file_manifests),
            "total_bytes": total_bytes,
            "files": file_manifests,
            "chunk_paths": sorted(chunk_paths_seen),
            "reason": str(reason)[:64],
            "updated_at": int(time.time() * 1000),
        }
        head_path = self.checkpoints._opaque_path(clean_ws, "cas_heads", "current")
        sealed_head = self.checkpoints._seal(
            self.checkpoints._meta_key,
            json.dumps(head_doc, separators=(",", ":"), sort_keys=True).encode("utf-8"),
            self.checkpoints._aad(clean_ws, head_path),
        )
        await self.checkpoints.check()
        head_ver = await self.checkpoints.store.put_if_generation(
            head_path, sealed_head, current_gen
        )
        if head_ver is None:
            raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
        return {
            **head_doc,
            "uploaded_chunks": uploaded_chunks,
            "reused_chunks": reused_chunks,
        }

    async def hydrate_to_directory(self, workspace_id: str, workspace_dir: Path) -> dict[str, Any]:
        """Restore files from CAS manifest onto Local NVMe scratch, pruning stale files."""
        clean_ws = validate_workspace_id(workspace_id)
        head, _ = await self.read_head(clean_ws)
        workspace_dir.mkdir(parents=True, exist_ok=True)
        root_resolved = workspace_dir.resolve()
        if head is None or head.get("forgotten") is True:
            return {
                "workspace_id": clean_ws,
                "revision": 0,
                "hydrated": False,
                "file_count": 0,
                "total_bytes": 0,
            }

        epoch = int(head.get("key_epoch", 1))
        layer_key = self.checkpoints._layer_key(clean_ws, epoch)
        expected_rel_paths: set[str] = set()
        chunk_cache: dict[str, bytes] = {}
        total_bytes = 0

        for entry in head.get("files") or ():
            clean_rel = _validate_tar_member_path(str(entry["path"]))
            dest = (workspace_dir / clean_rel).resolve()
            if not dest.is_relative_to(root_resolved):
                raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
            dest.parent.mkdir(parents=True, exist_ok=True)
            expected_rel_paths.add(clean_rel)

            hasher = hashlib.sha256()
            with dest.open("wb") as out:
                for chunk_ref in entry.get("chunks") or ():
                    c_path = str(chunk_ref["path"])
                    c_sha = str(chunk_ref["sha256"])
                    plain = chunk_cache.get(c_path)
                    if plain is None:
                        raw, _ = await self.checkpoints._get_bounded(
                            c_path, max_bytes=MAX_CAS_CHUNK_ENCRYPTED_BYTES
                        )
                        if raw is None:
                            raise WorkspaceRefused("WORKSPACE_LAYER_MISSING", 404)
                        plain = self.checkpoints._open(
                            layer_key, raw, self.checkpoints._aad(clean_ws, c_path)
                        )
                        if hashlib.sha256(plain).hexdigest() != c_sha:
                            raise WorkspaceRefused("WORKSPACE_DIGEST_MISMATCH", 500)
                        if len(chunk_cache) < 8:
                            chunk_cache[c_path] = plain
                    hasher.update(plain)
                    out.write(plain)
                    total_bytes += len(plain)

            if hasher.hexdigest() != str(entry["sha256"]):
                raise WorkspaceRefused("WORKSPACE_DIGEST_MISMATCH", 500)
            os.chmod(dest, 0o755 if int(entry.get("mode", 0o644)) & 0o111 else 0o644)

        # Prune files on local workspace not present in the authoritative manifest.
        for dirpath, dirnames, filenames in os.walk(workspace_dir, followlinks=False):
            dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
            for fname in filenames:
                full = Path(dirpath) / fname
                rel = full.relative_to(workspace_dir).as_posix()
                if rel not in expected_rel_paths and full.is_file():
                    full.unlink(missing_ok=True)

        return {
            "workspace_id": clean_ws,
            "revision": int(head["revision"]),
            "hydrated": True,
            "file_count": len(expected_rel_paths),
            "total_bytes": total_bytes,
        }

    async def forget_workspace(self, workspace_id: str) -> dict[str, Any]:
        """Rotate CAS key_epoch, tombstone head, and delete referenced chunks (SP 800-88)."""
        clean_ws = validate_workspace_id(workspace_id)
        head, current_gen = await self.read_head(clean_ws)
        if head is None:
            return {
                "workspace_id": clean_ws,
                "forgotten": True,
                "deleted_chunks": 0,
                "key_epoch": 1,
            }
        deleted = 0
        for c_path in head.get("chunk_paths") or ():
            if await self.checkpoints.store.delete(str(c_path)):
                deleted += 1
        next_epoch = int(head.get("key_epoch", 1)) + 1
        next_rev = int(head.get("revision", 0)) + 1
        tombstone = {
            "schema_version": 1,
            "workspace_id": clean_ws,
            "revision": next_rev,
            "key_epoch": next_epoch,
            "forgotten": True,
            "file_count": 0,
            "total_bytes": 0,
            "files": [],
            "chunk_paths": [],
            "reason": "owner_forget",
            "updated_at": int(time.time() * 1000),
        }
        head_path = self.checkpoints._opaque_path(clean_ws, "cas_heads", "current")
        sealed = self.checkpoints._seal(
            self.checkpoints._meta_key,
            json.dumps(tombstone, separators=(",", ":"), sort_keys=True).encode("utf-8"),
            self.checkpoints._aad(clean_ws, head_path),
        )
        ver = await self.checkpoints.store.put_if_generation(head_path, sealed, current_gen)
        if ver is None:
            raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
        return {
            "workspace_id": clean_ws,
            "forgotten": True,
            "revision": next_rev,
            "deleted_chunks": deleted,
            "key_epoch": next_epoch,
        }
