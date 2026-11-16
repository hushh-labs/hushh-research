# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Encrypted `<prefix>/workspaces/v1/` archive checkpoint store over `ObjectStore` (#9511).

Implements Option A durable retained workspaces without persistent VMs or disks:
- Derives domain-separated HKDF-SHA256 keys from the pod's 32-byte `dek` with per-workspace
  `key_epoch` rotation so workspace **Forget** cryptographically destroys prior layers and
  pod `dek` destruction (`pod_crypto_erase`) erases all workspaces automatically.
- Writes immutable AES-256-GCM encrypted `tar.gz` layers (`ABSENT` create-only) and advances
  head pointers with compare-and-swap (`put_if_generation`), fencing stale workers with
  `WORKSPACE_REVISION_CONFLICT`.
- Excludes credential/secret files (`.env*`, `id_rsa`, `id_ed25519`, `.npmrc`, `.pypirc`,
  `.git-credentials`, `*credentials*.json`) and disposable caches before checkpointing, and
  enforces symlink/traversal/device refusal + byte/file ceilings during hydration.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import posixpath
import re
import tarfile
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.operons.pod_workspace.resource_guard import DISPOSABLE_CACHE_DIRS
from hushh_mcp.services.pod_bounded_object import ObjectReadTooLarge
from hushh_mcp.services.pod_object_version import ABSENT

WORKSPACE_ID_RE = re.compile(r"^ws_[a-z0-9][a-z0-9_-]{5,60}$")
MAX_WORKSPACE_ARCHIVE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024  # 32 MiB checkpoint layer bound
MAX_WORKSPACE_ARCHIVE_ENCRYPTED_BYTES = 33 * 1024 * 1024  # Matches pod_bounded_object 33 MiB cap
MAX_WORKSPACE_FILES = 5_000

_EXCLUDED_CREDENTIAL_FILENAMES = frozenset(
    {
        ".env",
        ".npmrc",
        ".pypirc",
        ".netrc",
        ".git-credentials",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
    }
)


class WorkspaceRefused(Exception):
    """Typed closed refusal raised across encrypted pod workspace operations."""

    def __init__(self, code: str, status: int = 409) -> None:
        self.code = code
        self.status = status
        super().__init__(code)


def validate_workspace_id(workspace_id: str) -> str:
    cleaned = str(workspace_id or "").strip()
    if not WORKSPACE_ID_RE.fullmatch(cleaned):
        raise WorkspaceRefused("WORKSPACE_INVALID_ID", 400)
    return cleaned


def _is_excluded_workspace_member(rel_posix: str) -> bool:
    parts = [seg for seg in rel_posix.split("/") if seg]
    if not parts:
        return True
    if any(seg in DISPOSABLE_CACHE_DIRS for seg in parts[:-1]):
        return True
    leaf = parts[-1].lower()
    if leaf in _EXCLUDED_CREDENTIAL_FILENAMES or leaf.startswith(".env."):
        return True
    if leaf.endswith((".pem", ".key", ".p12", ".pfx")) or (
        "credential" in leaf and leaf.endswith(".json")
    ):
        return True
    return False


def _validate_tar_member_path(name: str) -> str:
    if not name or "\x00" in name or "\\" in name or name.startswith("/"):
        raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
    parts = [seg for seg in name.split("/") if seg]
    if not parts or any(seg in {".", ".."} for seg in parts):
        raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
    normalized = posixpath.normpath("/".join(parts))
    if normalized.startswith("..") or normalized.startswith("/"):
        raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
    return normalized


def pack_workspace_directory(
    workspace_dir: Path,
    *,
    max_uncompressed_bytes: int = MAX_WORKSPACE_ARCHIVE_UNCOMPRESSED_BYTES,
    max_files: int = MAX_WORKSPACE_FILES,
) -> tuple[bytes, int, int]:
    """Deterministically pack `workspace_dir` into `tar.gz`, omitting secrets and symlinks."""
    buf = io.BytesIO()
    total_bytes = 0
    file_count = 0

    entries: list[tuple[str, Path]] = []
    if workspace_dir.exists():
        for dirpath, dirnames, filenames in os.walk(workspace_dir, followlinks=False):
            dirnames[:] = sorted(
                d
                for d in dirnames
                if d not in DISPOSABLE_CACHE_DIRS and not os.path.islink(os.path.join(dirpath, d))
            )
            for fname in sorted(filenames):
                full = Path(dirpath) / fname
                if full.is_symlink() or not full.is_file():
                    continue
                rel = full.relative_to(workspace_dir).as_posix()
                clean_rel = _validate_tar_member_path(rel)
                if _is_excluded_workspace_member(clean_rel):
                    continue
                entries.append((clean_rel, full))

    if len(entries) > max_files:
        raise WorkspaceRefused("WORKSPACE_TOO_MANY_FILES", 413)

    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=6) as tf:
        for clean_rel, full in entries:
            data = full.read_bytes()
            total_bytes += len(data)
            if total_bytes > max_uncompressed_bytes:
                raise WorkspaceRefused("WORKSPACE_ARCHIVE_TOO_LARGE", 413)
            info = tarfile.TarInfo(name=clean_rel)
            info.size = len(data)
            st_mode = full.stat().st_mode
            info.mode = 0o755 if (st_mode & 0o111) else 0o644
            info.mtime = 0
            tf.addfile(info, io.BytesIO(data))
            file_count += 1

    return buf.getvalue(), total_bytes, file_count


def unpack_workspace_archive(
    archive_bytes: bytes,
    workspace_dir: Path,
    *,
    max_uncompressed_bytes: int = MAX_WORKSPACE_ARCHIVE_UNCOMPRESSED_BYTES,
    max_files: int = MAX_WORKSPACE_FILES,
) -> tuple[int, int]:
    """Safely unpack `tar.gz` bytes into `workspace_dir`, refusing symlinks/devices/escapes."""
    workspace_dir.mkdir(parents=True, exist_ok=True)
    root_resolved = workspace_dir.resolve()
    total_bytes = 0
    file_count = 0

    try:
        tf = tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz")
    except (tarfile.TarError, OSError) as exc:
        raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400) from exc

    with tf:
        for member in tf:
            if member.isdir():
                if member.name.strip("/"):
                    clean_dir = _validate_tar_member_path(member.name.rstrip("/"))
                    dest_dir = (workspace_dir / clean_dir).resolve()
                    if not dest_dir.is_relative_to(root_resolved):
                        raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
                    dest_dir.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile() or member.issym() or member.islnk():
                raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
            clean_rel = _validate_tar_member_path(member.name)
            if _is_excluded_workspace_member(clean_rel):
                continue
            file_count += 1
            if file_count > max_files:
                raise WorkspaceRefused("WORKSPACE_TOO_MANY_FILES", 413)
            if member.size < 0 or total_bytes + member.size > max_uncompressed_bytes:
                raise WorkspaceRefused("WORKSPACE_ARCHIVE_TOO_LARGE", 413)

            dest = (workspace_dir / clean_rel).resolve()
            if not dest.is_relative_to(root_resolved):
                raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
            dest.parent.mkdir(parents=True, exist_ok=True)

            extracted = tf.extractfile(member)
            if extracted is None:
                continue
            out = bytearray()
            while True:
                chunk = extracted.read(65536)
                if not chunk:
                    break
                out.extend(chunk)
                total_bytes += len(chunk)
                if total_bytes > max_uncompressed_bytes:
                    raise WorkspaceRefused("WORKSPACE_ARCHIVE_TOO_LARGE", 413)
            dest.write_bytes(bytes(out))
            os.chmod(dest, 0o755 if (member.mode & 0o111) else 0o644)

    return total_bytes, file_count


class WorkspaceCheckpointLibrary:
    """Encrypted CAS checkpoint store under `workspaces/v1/` over `ObjectStore`."""

    def __init__(
        self,
        *,
        owner: str,
        key: bytes,
        store: Any,
        check: Callable[[], Awaitable[None]],
        account_generation: int = 0,
    ) -> None:
        if len(key) != 32:
            raise ValueError("WorkspaceCheckpointLibrary requires a 32-byte key")
        self.owner = owner
        self.store = store
        self.check = check
        self.account_generation = int(account_generation)
        self._meta_key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"hussh/pod-workspaces/meta-enc/v1",
        ).derive(key)
        self._name_key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"hussh/pod-workspaces/names/v1",
        ).derive(key)
        self._layer_master = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"hussh/pod-workspaces/layer-keys/v1",
        ).derive(key)

    def _layer_key(self, workspace_id: str, key_epoch: int) -> bytes:
        return HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=f"hussh/pod-workspaces/ws/{workspace_id}/epoch/{key_epoch}".encode("utf-8"),
        ).derive(self._layer_master)

    def _aad(self, workspace_id: str, path: str) -> bytes:
        return f"{self.owner}:{self.account_generation}:{workspace_id}:{path}".encode("utf-8")

    def _opaque_path(self, workspace_id: str, group: str, name: str) -> str:
        clean_ws = validate_workspace_id(workspace_id)
        digest = hmac.new(
            self._name_key,
            f"{clean_ws}:{group}:{name}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"workspaces/v1/{clean_ws}/{group}/{digest}.bin"

    @staticmethod
    def _seal(aead_key: bytes, plaintext: bytes, aad: bytes) -> bytes:
        nonce = os.urandom(12)
        return nonce + AESGCM(aead_key).encrypt(nonce, plaintext, aad)

    @staticmethod
    def _open(aead_key: bytes, payload: bytes, aad: bytes) -> bytes:
        if len(payload) < 28:
            raise WorkspaceRefused("WORKSPACE_CIPHERTEXT_CORRUPT", 500)
        try:
            return AESGCM(aead_key).decrypt(payload[:12], payload[12:], aad)
        except Exception as exc:  # noqa: BLE001
            raise WorkspaceRefused("WORKSPACE_DECRYPT_FAILED", 403) from exc

    async def _get_bounded(self, path: str, *, max_bytes: int) -> tuple[bytes | None, Any]:
        await self.check()
        try:
            if hasattr(self.store, "get_bounded_with_generation"):
                raw, gen = await self.store.get_bounded_with_generation(path, max_bytes=max_bytes)
                return raw, gen
            raw, gen = await self.store.get_with_generation(path)
            if raw is not None and len(raw) > max_bytes:
                raise WorkspaceRefused("WORKSPACE_ARCHIVE_TOO_LARGE", 413)
            return raw, gen
        except (ObjectReadTooLarge, ValueError) as exc:
            raise WorkspaceRefused("WORKSPACE_ARCHIVE_TOO_LARGE", 413) from exc

    async def read_head(self, workspace_id: str) -> tuple[dict[str, Any] | None, Any]:
        clean_ws = validate_workspace_id(workspace_id)
        head_path = self._opaque_path(clean_ws, "heads", "current")
        raw, gen = await self._get_bounded(head_path, max_bytes=65536)
        if raw is None:
            return None, ABSENT
        doc = json.loads(
            self._open(self._meta_key, raw, self._aad(clean_ws, head_path)).decode("utf-8")
        )
        return dict(doc), gen

    async def save_checkpoint(
        self,
        workspace_id: str,
        workspace_dir: Path,
        *,
        expected_revision: int | None = None,
        reason: str = "manual",
    ) -> dict[str, Any]:
        clean_ws = validate_workspace_id(workspace_id)
        current_head, current_gen = await self.read_head(clean_ws)
        if current_head is not None and current_head.get("forgotten") is True:
            if expected_revision not in {None, 0}:
                raise WorkspaceRefused("WORKSPACE_FORGOTTEN", 410)
            next_epoch = int(current_head.get("key_epoch", 1)) + 1
            prior_rev = int(current_head.get("revision", 0))
        elif current_head is not None:
            prior_rev = int(current_head["revision"])
            if expected_revision is not None and expected_revision != prior_rev:
                raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
            next_epoch = int(current_head.get("key_epoch", 1))
        else:
            if expected_revision not in {None, 0}:
                raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
            prior_rev = 0
            next_epoch = 1

        next_rev = prior_rev + 1
        archive_bytes, uncompressed_bytes, file_count = pack_workspace_directory(workspace_dir)
        layer_sha256 = hashlib.sha256(archive_bytes).hexdigest()
        layer_path = self._opaque_path(clean_ws, "layers", f"r{next_rev}_{layer_sha256[:16]}")
        layer_key = self._layer_key(clean_ws, next_epoch)
        sealed_layer = self._seal(layer_key, archive_bytes, self._aad(clean_ws, layer_path))

        await self.check()
        layer_ver = await self.store.put_if_generation(layer_path, sealed_layer, ABSENT)
        if layer_ver is None:
            raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)

        now_ms = int(time.time() * 1000)
        prior_layers = list((current_head or {}).get("layer_paths") or ())
        head_doc: dict[str, Any] = {
            "workspace_id": clean_ws,
            "revision": next_rev,
            "key_epoch": next_epoch,
            "forgotten": False,
            "layer_path": layer_path,
            "layer_paths": [*prior_layers[-15:], layer_path],
            "layer_sha256": layer_sha256,
            "uncompressed_bytes": uncompressed_bytes,
            "file_count": file_count,
            "reason": str(reason)[:64],
            "updated_at": now_ms,
        }
        head_path = self._opaque_path(clean_ws, "heads", "current")
        sealed_head = self._seal(
            self._meta_key,
            json.dumps(head_doc, separators=(",", ":"), sort_keys=True).encode("utf-8"),
            self._aad(clean_ws, head_path),
        )
        head_ver = await self.store.put_if_generation(head_path, sealed_head, current_gen)
        if head_ver is None:
            raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
        return head_doc

    async def hydrate_workspace(self, workspace_id: str, workspace_dir: Path) -> dict[str, Any]:
        clean_ws = validate_workspace_id(workspace_id)
        head, _ = await self.read_head(clean_ws)
        workspace_dir.mkdir(parents=True, exist_ok=True)
        if head is None or head.get("forgotten") is True:
            return {
                "workspace_id": clean_ws,
                "revision": 0,
                "hydrated": False,
                "uncompressed_bytes": 0,
                "file_count": 0,
            }
        layer_path = str(head["layer_path"])
        raw_layer, _ = await self._get_bounded(
            layer_path, max_bytes=MAX_WORKSPACE_ARCHIVE_ENCRYPTED_BYTES
        )
        if raw_layer is None:
            raise WorkspaceRefused("WORKSPACE_LAYER_MISSING", 404)
        layer_key = self._layer_key(clean_ws, int(head.get("key_epoch", 1)))
        archive_bytes = self._open(layer_key, raw_layer, self._aad(clean_ws, layer_path))
        if hashlib.sha256(archive_bytes).hexdigest() != head["layer_sha256"]:
            raise WorkspaceRefused("WORKSPACE_DIGEST_MISMATCH", 500)
        uncompressed_bytes, file_count = unpack_workspace_archive(archive_bytes, workspace_dir)
        return {
            "workspace_id": clean_ws,
            "revision": int(head["revision"]),
            "hydrated": True,
            "uncompressed_bytes": uncompressed_bytes,
            "file_count": file_count,
        }

    async def forget_workspace(self, workspace_id: str) -> dict[str, Any]:
        """Rotate `key_epoch`, tombstone head, and request physical deletion of prior layer blobs."""
        clean_ws = validate_workspace_id(workspace_id)
        head, current_gen = await self.read_head(clean_ws)
        if head is None:
            return {
                "workspace_id": clean_ws,
                "forgotten": True,
                "deleted_layers": 0,
                "key_epoch": 1,
            }
        deleted = 0
        for lpath in head.get("layer_paths") or ():
            if hasattr(self.store, "delete"):
                if await self.store.delete(str(lpath)):
                    deleted += 1
        next_epoch = int(head.get("key_epoch", 1)) + 1
        next_rev = int(head.get("revision", 0)) + 1
        tombstone_head: dict[str, Any] = {
            "workspace_id": clean_ws,
            "revision": next_rev,
            "key_epoch": next_epoch,
            "forgotten": True,
            "layer_path": "",
            "layer_paths": [],
            "layer_sha256": "",
            "uncompressed_bytes": 0,
            "file_count": 0,
            "reason": "owner_forget",
            "updated_at": int(time.time() * 1000),
        }
        head_path = self._opaque_path(clean_ws, "heads", "current")
        sealed_head = self._seal(
            self._meta_key,
            json.dumps(tombstone_head, separators=(",", ":"), sort_keys=True).encode("utf-8"),
            self._aad(clean_ws, head_path),
        )
        ver = await self.store.put_if_generation(head_path, sealed_head, current_gen)
        if ver is None:
            raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
        return {
            "workspace_id": clean_ws,
            "forgotten": True,
            "revision": next_rev,
            "deleted_layers": deleted,
            "key_epoch": next_epoch,
        }

    async def append_execution_event(
        self, workspace_id: str, event: dict[str, Any]
    ) -> dict[str, Any]:
        clean_ws = validate_workspace_id(workspace_id)
        events_path = self._opaque_path(clean_ws, "events", "ledger")
        raw, current_gen = await self._get_bounded(events_path, max_bytes=512 * 1024)
        prior: list[dict[str, Any]] = []
        if raw is not None:
            decoded = json.loads(
                self._open(self._meta_key, raw, self._aad(clean_ws, events_path)).decode("utf-8")
            )
            prior = list(decoded.get("events") or ())
        seq = (int(prior[-1]["seq"]) + 1) if prior else 1
        stamped = {"seq": seq, **event}
        bounded = [*prior[-99:], stamped]
        sealed = self._seal(
            self._meta_key,
            json.dumps({"events": bounded}, separators=(",", ":"), sort_keys=True).encode("utf-8"),
            self._aad(clean_ws, events_path),
        )
        ver = await self.store.put_if_generation(events_path, sealed, current_gen)
        if ver is None:
            raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)
        return stamped

    async def list_execution_events(self, workspace_id: str) -> list[dict[str, Any]]:
        clean_ws = validate_workspace_id(workspace_id)
        events_path = self._opaque_path(clean_ws, "events", "ledger")
        raw, _ = await self._get_bounded(events_path, max_bytes=512 * 1024)
        if raw is None:
            return []
        decoded = json.loads(
            self._open(self._meta_key, raw, self._aad(clean_ws, events_path)).decode("utf-8")
        )
        return list(decoded.get("events") or ())
