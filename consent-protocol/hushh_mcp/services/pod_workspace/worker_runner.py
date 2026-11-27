# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Isolated Option A ephemeral CLI worker entrypoint and encrypted run envelope (#9511).

Executes inside an ephemeral, credential-scrubbed Cloud Run Job or Azure Container
Apps Job container:
1. Verifies zero `FORBIDDEN_WORKER_JOB_ENV` / pod custody secrets are present.
2. Opens the pre-staged `runs/{run_id}_in.bin` envelope using the one-shot `run_key`
   and transient `workspaces/v1/<ws_id>` subprefix storage token.
3. Applies best-effort Linux Landlock filesystem confinement where supported.
4. Runs the admitted command under `WorkspaceResourceGuard` (4-stage cgroup-v2 +
   scratch budget monitoring and `build_scrubbed_worker_env()` for child processes).
5. Writes encrypted `_ckpt.bin` and `_out.bin` envelopes back to `runs/{run_id}_*`
   and scrubs local scratch before exit.
"""

from __future__ import annotations

import asyncio
import base64
import ctypes
import errno
import json
import os
import platform
import shutil
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.operons.pod_workspace import (
    FORBIDDEN_WORKER_JOB_ENV,
    WorkspaceResourceGuard,
)
from hushh_mcp.services.pod_commit_log import ABSENT
from hushh_mcp.services.pod_workspace.checkpoint_store import (
    MAX_WORKSPACE_ARCHIVE_ENCRYPTED_BYTES,
    WorkspaceRefused,
    pack_workspace_directory,
    unpack_workspace_archive,
    validate_workspace_id,
)

_LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
_LANDLOCK_RULE_PATH_BENEATH = 1
_SYS_LANDLOCK_CREATE_RULESET = 444
_SYS_LANDLOCK_ADD_RULE = 445
_SYS_LANDLOCK_RESTRICT_SELF = 446
_PR_SET_NO_NEW_PRIVS = 38
_LANDLOCK_READ_EXEC_FS = (1 << 0) | (1 << 2) | (1 << 3)
_LANDLOCK_ALL_V1 = (1 << 13) - 1
_LANDLOCK_READ_ONLY_SYSTEM_PATHS = (
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/proc",
    "/sys",
    "/opt/venv",
)


class _LandlockRulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class _LandlockPathBeneathAttr(ctypes.Structure):
    _packed_ = True
    _fields_ = [
        ("allowed_access", ctypes.c_uint64),
        ("parent_fd", ctypes.c_int32),
    ]


def worker_envelope_aad(
    *,
    owner: str,
    account_generation: int,
    workspace_id: str,
    run_id: str,
    stage: str,
) -> bytes:
    return (
        f"hussh/ws-run/v1:{owner}:{int(account_generation)}:{workspace_id}:{run_id}:{stage}"
    ).encode("utf-8")


def seal_worker_run_envelope(run_key: bytes, payload: dict[str, Any], *, aad: bytes) -> bytes:
    if len(run_key) != 32:
        raise ValueError("worker run_key must be 32 bytes")
    nonce = os.urandom(12)
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return nonce + AESGCM(run_key).encrypt(nonce, raw, aad)


def open_worker_run_envelope(run_key: bytes, ciphertext: bytes, *, aad: bytes) -> dict[str, Any]:
    if len(run_key) != 32 or len(ciphertext) < 28:
        raise WorkspaceRefused("WORKSPACE_CIPHERTEXT_CORRUPT", 500)
    try:
        raw = AESGCM(run_key).decrypt(ciphertext[:12], ciphertext[12:], aad)
        parsed = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise WorkspaceRefused("WORKSPACE_DECRYPT_FAILED", 403) from exc
    if not isinstance(parsed, dict):
        raise WorkspaceRefused("WORKSPACE_CIPHERTEXT_CORRUPT", 500)
    return parsed


def verify_worker_container_env_scrubbed(environ: Mapping[str, str]) -> None:
    """Fail closed if any pod custody, KMS, vault, or signing secret leaked into the worker."""
    for raw_key in environ:
        upper = str(raw_key).strip().upper()
        if (
            upper in FORBIDDEN_WORKER_JOB_ENV
            or upper.startswith(("HUSSH_POD_", "VAULT_"))
            or ("SECRET" in upper and not upper.startswith("PYTEST_"))
        ):
            raise WorkspaceRefused("WORKER_ENV_UNSCRUBBED", 500)


def apply_landlock_workspace_confinement(run_root: Path, *, native_lib: Any = None) -> str:
    """Apply Linux Landlock ABI v1 confining RW access to `run_root` and `/dev` (excluding `/app`)."""
    if sys.platform != "linux" or platform.machine().lower() not in {
        "x86_64",
        "amd64",
        "aarch64",
        "arm64",
    }:
        return "unsupported"
    native = native_lib if native_lib is not None else ctypes.CDLL(None, use_errno=True)
    ctypes.set_errno(0)
    abi = int(
        native.syscall(
            _SYS_LANDLOCK_CREATE_RULESET,
            ctypes.c_void_p(0),
            ctypes.c_size_t(0),
            ctypes.c_uint32(_LANDLOCK_CREATE_RULESET_VERSION),
        )
    )
    if abi < 0:
        err = ctypes.get_errno()
        if err in {errno.ENOSYS, errno.EOPNOTSUPP}:
            return "unsupported"
        raise WorkspaceRefused("WORKER_SANDBOX_FAILED", 500)
    handled = _LANDLOCK_ALL_V1
    attr = _LandlockRulesetAttr(handled_access_fs=handled)
    ctypes.set_errno(0)
    ruleset_fd = int(
        native.syscall(
            _SYS_LANDLOCK_CREATE_RULESET,
            ctypes.byref(attr),
            ctypes.c_size_t(ctypes.sizeof(attr)),
            ctypes.c_uint32(0),
        )
    )
    if ruleset_fd < 0:
        err = ctypes.get_errno()
        if err in {errno.ENOSYS, errno.EOPNOTSUPP}:
            return "unsupported"
        raise WorkspaceRefused("WORKER_SANDBOX_FAILED", 500)

    o_path = getattr(os, "O_PATH", 0o10000000)
    open_flags = o_path | os.O_CLOEXEC
    rw_paths = ["/dev", str(run_root.resolve())]
    try:
        for candidate, rights in (
            *((p, _LANDLOCK_READ_EXEC_FS & handled) for p in _LANDLOCK_READ_ONLY_SYSTEM_PATHS),
            *((p, handled) for p in rw_paths),
        ):
            if not candidate or not os.path.exists(candidate):
                continue
            pfd = os.open(candidate, open_flags)
            try:
                rule = _LandlockPathBeneathAttr(allowed_access=rights, parent_fd=pfd)
                if (
                    int(
                        native.syscall(
                            _SYS_LANDLOCK_ADD_RULE,
                            ctypes.c_int(ruleset_fd),
                            ctypes.c_int(_LANDLOCK_RULE_PATH_BENEATH),
                            ctypes.byref(rule),
                            ctypes.c_uint32(0),
                        )
                    )
                    < 0
                ):
                    raise WorkspaceRefused("WORKER_SANDBOX_FAILED", 500)
            finally:
                os.close(pfd)
        if int(native.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) < 0:
            raise WorkspaceRefused("WORKER_SANDBOX_FAILED", 500)
        if int(native.syscall(_SYS_LANDLOCK_RESTRICT_SELF, ctypes.c_int(ruleset_fd), 0)) < 0:
            raise WorkspaceRefused("WORKER_SANDBOX_FAILED", 500)
    finally:
        os.close(ruleset_fd)
    return "enforced"


def build_worker_subprefix_store(environ: Mapping[str, str]) -> Any:
    """Instantiate an ObjectStore rooted strictly at `<pod_prefix>/workspaces/v1/<ws_id>`."""
    provider = str(environ.get("HUSSH_WS_STORAGE_PROVIDER") or "").strip()
    token = str(environ.get("HUSSH_WS_BEARER_TOKEN") or "").strip()
    storage_url = str(environ.get("HUSSH_WS_STORAGE_URL") or "").strip()
    if not token:
        raise WorkspaceRefused("WORKER_TOKEN_MISSING", 403)

    if provider == "ace_prefix_bearer":
        from hushh_mcp.services.pod_s3_object_store import PrefixTokenObjectStore

        return PrefixTokenObjectStore(storage_url, bearer_token=token)
    if provider == "gcs_cab":
        from hushh_mcp.services.pod_commit_log import GcsObjectStore

        bucket = str(environ.get("HUSSH_WS_STORAGE_BUCKET") or "").strip()
        prefix = str(environ.get("HUSSH_WS_STORAGE_PREFIX") or "").strip("/")
        if not bucket or not prefix:
            raise WorkspaceRefused("WORKER_STORAGE_CONFIG_INVALID", 400)
        return GcsObjectStore(bucket, prefix, token_provider=lambda: (token, 300))
    if provider == "azure_blob_delegation_sas":
        from hushh_mcp.services.pod_azure_blob_store import AzureBlobObjectStore

        return AzureBlobObjectStore(storage_url, sas_token=token)
    raise WorkspaceRefused("WORKER_STORAGE_PROVIDER_UNSUPPORTED", 400)


async def _put_overwrite_or_create(store: Any, key: str, data: bytes) -> None:
    if hasattr(store, "get_with_generation"):
        _, gen = await store.get_with_generation(key)
    else:
        gen = ABSENT
    ver = await store.put_if_generation(key, data, gen)
    if ver is None:
        _, retry_gen = await store.get_with_generation(key)
        await store.put_if_generation(key, data, retry_gen)


async def execute_staged_worker_run(
    *,
    subprefix_store: Any,
    run_id: str,
    workspace_id: str,
    owner: str,
    account_generation: int,
    run_key: bytes,
    guard: WorkspaceResourceGuard | None = None,
    scratch_parent: Path | None = None,
    apply_landlock: bool = False,
) -> dict[str, Any]:
    """Hydrate `runs/{run_id}_in.bin`, run guarded command, and stage `_ckpt.bin` + `_out.bin`."""
    clean_ws = validate_workspace_id(workspace_id)
    in_key = f"runs/{run_id}_in.bin"
    ckpt_key = f"runs/{run_id}_ckpt.bin"
    out_key = f"runs/{run_id}_out.bin"

    if hasattr(subprefix_store, "get_bounded_with_generation"):
        raw_in, _ = await subprefix_store.get_bounded_with_generation(
            in_key, max_bytes=MAX_WORKSPACE_ARCHIVE_ENCRYPTED_BYTES
        )
    else:
        raw_in, _ = await subprefix_store.get_with_generation(in_key)
    if raw_in is None:
        raise WorkspaceRefused("WORKER_INPUT_MISSING", 404)

    in_payload = open_worker_run_envelope(
        run_key,
        raw_in,
        aad=worker_envelope_aad(
            owner=owner,
            account_generation=account_generation,
            workspace_id=clean_ws,
            run_id=run_id,
            stage="input",
        ),
    )

    if scratch_parent is not None:
        scratch_parent.mkdir(parents=True, exist_ok=True)
    run_root = Path(
        tempfile.mkdtemp(
            prefix=f"hussh-job-{clean_ws}-",
            dir=str(scratch_parent) if scratch_parent else None,
        )
    )
    ws_dir = run_root / "work"
    tmp_dir = run_root / "tmp"
    ws_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    try:
        landlock_state = (
            apply_landlock_workspace_confinement(run_root) if apply_landlock else "skipped"
        )
        archive_b64 = str(in_payload.get("archive_b64") or "")
        if archive_b64:
            unpack_workspace_archive(base64.b64decode(archive_b64), ws_dir)

        seed_files = in_payload.get("seed_files") or {}
        if isinstance(seed_files, dict):
            for rel_path, text_content in seed_files.items():
                clean_rel = str(rel_path or "").strip().lstrip("/")
                if not clean_rel or ".." in clean_rel.split("/") or "\\" in clean_rel:
                    raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
                target = (ws_dir / clean_rel).resolve()
                if not target.is_relative_to(ws_dir.resolve()):
                    raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(str(text_content), encoding="utf-8")

        base_rev = int(in_payload.get("base_revision") or 0)
        staged_checkpoint_seq = 0
        last_reason = ""

        async def _stage_checkpoint(reason: str) -> int | None:
            nonlocal staged_checkpoint_seq, last_reason
            packed, uncompressed_bytes, file_count = pack_workspace_directory(ws_dir)
            staged_checkpoint_seq += 1
            last_reason = reason
            sealed_ckpt = seal_worker_run_envelope(
                run_key,
                {
                    "archive_b64": base64.b64encode(packed).decode("ascii"),
                    "uncompressed_bytes": uncompressed_bytes,
                    "file_count": file_count,
                    "reason": reason,
                    "seq": staged_checkpoint_seq,
                },
                aad=worker_envelope_aad(
                    owner=owner,
                    account_generation=account_generation,
                    workspace_id=clean_ws,
                    run_id=run_id,
                    stage="ckpt",
                ),
            )
            await _put_overwrite_or_create(subprefix_store, ckpt_key, sealed_ckpt)
            return base_rev + 1

        active_guard = guard or WorkspaceResourceGuard()
        argv = [str(part) for part in (in_payload.get("argv") or [])]
        receipt = await active_guard.execute_command(
            argv,
            workspace_dir=ws_dir,
            scratch_tmp_dir=tmp_dir,
            boundary_mode="ephemeral_task_worker",
            credential_approval_verified=bool(in_payload.get("credential_approval_verified")),
            timeout_seconds=float(in_payload.get("timeout_seconds") or 60.0),
            checkpoint_fn=_stage_checkpoint
            if bool(in_payload.get("allow_checkpoint", True))
            else None,
        )

        out_doc: dict[str, Any] = {
            "receipt": receipt.to_dict(),
            "staged_checkpoint_seq": staged_checkpoint_seq,
            "checkpoint_reason": last_reason,
            "landlock_state": landlock_state,
        }
        sealed_out = seal_worker_run_envelope(
            run_key,
            out_doc,
            aad=worker_envelope_aad(
                owner=owner,
                account_generation=account_generation,
                workspace_id=clean_ws,
                run_id=run_id,
                stage="output",
            ),
        )
        await _put_overwrite_or_create(subprefix_store, out_key, sealed_out)
        return out_doc
    finally:
        shutil.rmtree(run_root, ignore_errors=True)


async def run_worker_once_from_env(environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    env = environ if environ is not None else os.environ
    verify_worker_container_env_scrubbed(env)
    os.umask(0o077)
    run_id = str(env.get("HUSSH_WS_RUN_ID") or "").strip()
    workspace_id = str(env.get("HUSSH_WS_ID") or "").strip()
    owner = str(env.get("HUSSH_WS_OWNER") or "").strip()
    generation = int(env.get("HUSSH_WS_ACCOUNT_GENERATION") or "0")
    run_key = base64.b64decode(str(env.get("HUSSH_WS_RUN_KEY_B64") or "").strip())
    store = build_worker_subprefix_store(env)
    return await execute_staged_worker_run(
        subprefix_store=store,
        run_id=run_id,
        workspace_id=workspace_id,
        owner=owner,
        account_generation=generation,
        run_key=run_key,
        apply_landlock=True,
    )


def main() -> int:
    asyncio.run(run_worker_once_from_env())
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
