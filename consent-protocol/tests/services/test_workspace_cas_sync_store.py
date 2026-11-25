# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Incremental encrypted CAS workspace sync verification (#9744)."""

from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

import pytest

from hushh_mcp.services.pod_commit_log import LocalObjectStore
from hushh_mcp.services.pod_workspace.cas_sync_store import WorkspaceCasSyncStore
from hushh_mcp.services.pod_workspace.checkpoint_store import (
    WorkspaceCheckpointLibrary,
    WorkspaceRefused,
)


async def _noop_check() -> None:
    return None


def _build_cas_store(tmp_path: Path, *, chunk_size_bytes: int = 4096) -> WorkspaceCasSyncStore:
    store = LocalObjectStore(str(tmp_path / "obj_store"))
    lib = WorkspaceCheckpointLibrary(
        owner="owner_alice",
        key=b"\x11" * 32,
        store=store,
        check=_noop_check,
    )
    return WorkspaceCasSyncStore(lib, chunk_size_bytes=chunk_size_bytes)


def test_cas_incremental_chunk_dedup_hydration_and_stale_prune(tmp_path: Path) -> None:
    cas = _build_cas_store(tmp_path, chunk_size_bytes=4096)
    src = tmp_path / "nvme_src"
    src.mkdir()
    (src / "a.bin").write_bytes(b"A" * 8192)
    (src / "b.bin").write_bytes(b"B" * 8192)
    script = src / "run.sh"
    script.write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
    os.chmod(script, 0o700)

    first = asyncio.run(cas.sync_from_directory("ws_alpha01", src, reason="initial"))
    assert first["revision"] == 1
    assert first["uploaded_chunks"] == 3
    assert first["reused_chunks"] == 2

    # Mutate only the leading bytes of b.bin while leaving a.bin and tail chunk intact.
    (src / "b.bin").write_bytes((b"C" * 4096) + (b"B" * 4096))
    second = asyncio.run(
        cas.sync_from_directory("ws_alpha01", src, expected_revision=1, reason="edit")
    )
    assert second["revision"] == 2
    assert second["uploaded_chunks"] == 1
    assert second["reused_chunks"] == 4

    dst = tmp_path / "nvme_dst"
    dst.mkdir()
    stale_file = dst / "stale_orphan.txt"
    stale_file.write_text("should be removed on hydration", encoding="utf-8")

    hydrated = asyncio.run(cas.hydrate_to_directory("ws_alpha01", dst))
    assert hydrated["hydrated"] is True
    assert hydrated["revision"] == 2
    assert hydrated["file_count"] == 3
    assert (dst / "a.bin").read_bytes() == b"A" * 8192
    assert (dst / "b.bin").read_bytes() == (b"C" * 4096) + (b"B" * 4096)
    assert (dst / "run.sh").stat().st_mode & 0o111
    assert not ((dst / "a.bin").stat().st_mode & 0o111)
    assert not stale_file.exists()


def test_cas_exceeds_32mib_monolithic_tarball_limit(tmp_path: Path) -> None:
    cas = _build_cas_store(tmp_path, chunk_size_bytes=4 * 1024 * 1024)
    src = tmp_path / "nvme_large"
    src.mkdir()
    chunk_a = b"a" * (17 * 1024 * 1024)
    chunk_b = b"b" * (17 * 1024 * 1024)
    payload = chunk_a + chunk_b
    (src / "model_weights.bin").write_bytes(payload)

    synced = asyncio.run(cas.sync_from_directory("ws_large01", src))
    assert synced["total_bytes"] == 34 * 1024 * 1024
    assert len(synced["files"][0]["chunks"]) == 9

    dst = tmp_path / "nvme_large_dst"
    hydrated = asyncio.run(cas.hydrate_to_directory("ws_large01", dst))
    assert hydrated["total_bytes"] == 34 * 1024 * 1024
    assert (
        hashlib.sha256((dst / "model_weights.bin").read_bytes()).hexdigest()
        == hashlib.sha256(payload).hexdigest()
    )


def test_cas_excludes_secrets_enforces_cas_fencing_and_crypto_erases(tmp_path: Path) -> None:
    cas = _build_cas_store(tmp_path, chunk_size_bytes=4096)
    src = tmp_path / "nvme_guard"
    src.mkdir()
    (src / "main.py").write_text("print('safe')\n", encoding="utf-8")
    (src / ".env").write_text("API_KEY=secret\n", encoding="utf-8")
    (src / ".env.production").write_text("PROD_KEY=secret\n", encoding="utf-8")
    (src / "id_rsa").write_text("PRIVATE KEY\n", encoding="utf-8")
    (src / "service-credentials.json").write_text("{}\n", encoding="utf-8")
    nm = src / "node_modules" / "pkg"
    nm.mkdir(parents=True)
    (nm / "index.js").write_text("module.exports = {}\n", encoding="utf-8")
    (src / "escape_link").symlink_to("/etc/passwd")

    first = asyncio.run(cas.sync_from_directory("ws_guard01", src))
    recorded_paths = [entry["path"] for entry in first["files"]]
    assert recorded_paths == ["main.py"]

    with pytest.raises(WorkspaceRefused) as stale:
        asyncio.run(cas.sync_from_directory("ws_guard01", src, expected_revision=99))
    assert stale.value.code == "WORKSPACE_REVISION_CONFLICT"

    erased = asyncio.run(cas.forget_workspace("ws_guard01"))
    assert erased["forgotten"] is True
    assert erased["key_epoch"] == 2
    assert erased["deleted_chunks"] == len(first["chunk_paths"])

    dst = tmp_path / "nvme_after_forget"
    hydrated = asyncio.run(cas.hydrate_to_directory("ws_guard01", dst))
    assert hydrated["hydrated"] is False

    with pytest.raises(WorkspaceRefused) as forgotten_err:
        asyncio.run(cas.sync_from_directory("ws_guard01", src, expected_revision=1))
    assert forgotten_err.value.code == "WORKSPACE_FORGOTTEN"
