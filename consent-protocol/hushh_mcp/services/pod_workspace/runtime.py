# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Option A / Option B CLI workspace runtime with takeover fencing, job dispatch, and resource guard (#9511)."""

from __future__ import annotations

import base64
import os
import secrets
import shutil
import tempfile
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Literal

from browser_runtime.qualification import (
    resolve_cli_execution_boundary,
    resolve_cli_worker_job_mode,
)
from hushh_mcp.operons.pod_workspace import (
    CliBoundaryMode,
    WorkerExecutionOverrideInput,
    WorkspaceResourceGuard,
    classify_cli_command,
    evaluate_resource_pressure,
)
from hushh_mcp.services.pod_commit_log import ABSENT
from hushh_mcp.services.pod_resource_snapshot import ResourceSnapshot
from hushh_mcp.services.pod_workspace.checkpoint_store import (
    MAX_WORKSPACE_ARCHIVE_ENCRYPTED_BYTES,
    WorkspaceCheckpointLibrary,
    WorkspaceRefused,
    validate_workspace_id,
)
from hushh_mcp.services.pod_workspace.job_dispatcher import WorkerJobDispatcherPort
from hushh_mcp.services.pod_workspace.worker_runner import (
    open_worker_run_envelope,
    seal_worker_run_envelope,
    worker_envelope_aad,
)

CLI_OWNER_TAKEOVER_ACTIVE = "CLI_OWNER_TAKEOVER_ACTIVE"


def current_pod_host_kind() -> str:
    explicit = (os.getenv("POD_BROWSER_HOST_KIND") or os.getenv("POD_HOST_KIND") or "").strip()
    if explicit:
        return explicit
    if os.getenv("CONTAINER_APP_NAME"):
        return "azure_container_apps"
    return "gcp_cloud_run"


def ephemeral_cli_worker_configured() -> bool:
    return (os.getenv("POD_CLI_EPHEMERAL_WORKER_ENABLED") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


StorageTokenMinter = Callable[[str, int], Awaitable[dict[str, Any]]]


class WorkspaceCliRuntime:
    """Coordinates encrypted workspace hydration, resource-guarded CLI runs, and takeover fences."""

    def __init__(
        self,
        checkpoints: WorkspaceCheckpointLibrary,
        *,
        guard: WorkspaceResourceGuard | None = None,
        host_kind: str | None = None,
        worker_configured: bool | None = None,
        scratch_parent: Path | None = None,
        job_dispatcher: WorkerJobDispatcherPort | None = None,
        storage_token_minter: StorageTokenMinter | None = None,
    ) -> None:
        self.checkpoints = checkpoints
        self.guard = guard or WorkspaceResourceGuard()
        self._host_kind = host_kind
        self._worker_configured = worker_configured
        self.scratch_parent = scratch_parent
        self.job_dispatcher = job_dispatcher
        self.storage_token_minter = storage_token_minter
        self._control_modes: dict[str, Literal["agent", "owner"]] = {}
        self._control_epochs: dict[str, int] = {}

    @property
    def host_kind(self) -> str:
        return self._host_kind or current_pod_host_kind()

    @property
    def worker_configured(self) -> bool:
        if self._worker_configured is not None:
            return self._worker_configured
        if self.job_dispatcher is not None:
            return True
        return ephemeral_cli_worker_configured()

    def job_mode(self) -> str:
        if self.job_dispatcher is not None:
            return str(self.job_dispatcher.job_mode)
        return resolve_cli_worker_job_mode(self.host_kind)

    def boundary_mode(self) -> CliBoundaryMode:
        resolved = resolve_cli_execution_boundary(
            self.host_kind, worker_configured=self.worker_configured
        )
        return (
            "ephemeral_task_worker"
            if resolved == "ephemeral_task_worker"
            else "restricted_builtin_only"
        )

    def status(self, workspace_id: str | None = None) -> dict[str, Any]:
        snap: ResourceSnapshot = self.guard.snapshot_fn()
        verdict = evaluate_resource_pressure(snap, workspace_used_bytes=0, policy=self.guard.policy)
        mode = "agent"
        epoch = 0
        if workspace_id:
            clean_ws = validate_workspace_id(workspace_id)
            mode = self._control_modes.get(clean_ws, "agent")
            epoch = self._control_epochs.get(clean_ws, 0)
        return {
            "host_kind": self.host_kind,
            "boundary_mode": self.boundary_mode(),
            "cli_worker_job_mode": self.job_mode(),
            "worker_configured": self.worker_configured,
            "job_dispatcher_ready": self.job_dispatcher is not None,
            "control_mode": mode,
            "control_epoch": epoch,
            "resources": snap,
            "pressure": {
                "level": verdict.level,
                "peak_ratio": verdict.peak_ratio,
                "effective_workspace_cap_bytes": verdict.effective_workspace_cap_bytes,
                "code": verdict.code,
                "retry_guidance": verdict.retry_guidance,
            },
        }

    def set_control_mode(
        self, workspace_id: str, action: Literal["take_control", "resume_agent"]
    ) -> dict[str, Any]:
        """Fence autonomous commands & model observations during private owner terminal entry."""
        clean_ws = validate_workspace_id(workspace_id)
        next_epoch = self._control_epochs.get(clean_ws, 0) + 1
        self._control_epochs[clean_ws] = next_epoch
        next_mode: Literal["agent", "owner"] = "owner" if action == "take_control" else "agent"
        self._control_modes[clean_ws] = next_mode
        return {
            "workspace_id": clean_ws,
            "control_mode": next_mode,
            "control_epoch": next_epoch,
            "model_observation_suppressed": next_mode == "owner",
        }

    async def _delete_run_artifact(self, path: str) -> None:
        store = self.checkpoints.store
        if hasattr(store, "delete"):
            try:
                await store.delete(path)
            except Exception:  # noqa: BLE001
                return

    async def _execute_via_ephemeral_job(
        self,
        *,
        clean_ws: str,
        argv: list[str],
        actor: Literal["agent", "owner"],
        current_mode: Literal["agent", "owner"],
        seed_files: dict[str, str] | None,
        credential_approval_verified: bool,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        if self.job_dispatcher is None or self.storage_token_minter is None:
            raise WorkspaceRefused("CLI_WORKER_BOUNDARY_REQUIRED", 403)

        admission = classify_cli_command(
            argv,
            boundary_mode="ephemeral_task_worker",
            credential_approval_verified=credential_approval_verified,
        )
        suppress_capture = current_mode == "owner" and actor == "owner"
        if not admission.admitted:
            event = await self.checkpoints.append_execution_event(
                clean_ws,
                {
                    "timestamp_ms": int(time.time() * 1000),
                    "actor": actor,
                    "boundary_mode": "ephemeral_task_worker",
                    "cli_worker_job_mode": self.job_mode(),
                    "command_summary": "[owner private entry]"
                    if suppress_capture
                    else (argv[0] if argv else ""),
                    "status": "refused",
                    "code": admission.code,
                    "exit_code": None,
                    "pressure_level": "normal",
                    "peak_ratio": 0.0,
                    "checkpoint_revision": None,
                },
            )
            return {
                "status": "refused",
                "code": admission.code,
                "exit_code": None,
                "stdout_tail": "",
                "stderr_tail": admission.reason or "",
                "stdout_truncated": False,
                "stderr_truncated": False,
                "duration_ms": 0,
                "pressure_level": "normal",
                "peak_ratio": 0.0,
                "evicted_cache_bytes": 0,
                "checkpoint_revision": None,
                "retry_guidance": admission.reason or "",
                "classification": admission.category,
                "workspace_id": clean_ws,
                "boundary_mode": "ephemeral_task_worker",
                "cli_worker_job_mode": self.job_mode(),
                "event_seq": event["seq"],
            }

        for rel_path in seed_files or {}:
            clean_rel = str(rel_path or "").strip().lstrip("/")
            if not clean_rel or ".." in clean_rel.split("/") or "\\" in clean_rel:
                raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)

        archive_bytes, last_rev = await self.checkpoints.export_workspace_archive(clean_ws)
        run_id = secrets.token_hex(16)
        run_key = os.urandom(32)
        subprefix = f"workspaces/v1/{clean_ws}"
        in_path = f"{subprefix}/runs/{run_id}_in.bin"
        ckpt_path = f"{subprefix}/runs/{run_id}_ckpt.bin"
        out_path = f"{subprefix}/runs/{run_id}_out.bin"

        sealed_in = seal_worker_run_envelope(
            run_key,
            {
                "argv": list(argv),
                "seed_files": dict(seed_files or {}),
                "credential_approval_verified": bool(credential_approval_verified),
                "timeout_seconds": float(timeout_seconds),
                "base_revision": last_rev,
                "allow_checkpoint": bool(actor == "agent" or current_mode != "owner"),
                "archive_b64": (
                    base64.b64encode(archive_bytes).decode("ascii")
                    if archive_bytes is not None
                    else ""
                ),
            },
            aad=worker_envelope_aad(
                owner=self.checkpoints.owner,
                account_generation=self.checkpoints.account_generation,
                workspace_id=clean_ws,
                run_id=run_id,
                stage="input",
            ),
        )

        try:
            await self.checkpoints.check()
            put_ver = await self.checkpoints.store.put_if_generation(in_path, sealed_in, ABSENT)
            if put_ver is None:
                raise WorkspaceRefused("WORKSPACE_REVISION_CONFLICT", 409)

            ttl = min(600, max(120, int(timeout_seconds) + 120))
            minted = await self.storage_token_minter(subprefix, ttl)
            provider_raw = str(minted.get("provider") or "ace_prefix_bearer")
            if provider_raw not in {
                "ace_prefix_bearer",
                "gcs_cab",
                "azure_blob_delegation_sas",
            }:
                raise WorkspaceRefused("WORKER_STORAGE_PROVIDER_UNSUPPORTED", 400)

            override = WorkerExecutionOverrideInput(
                run_id=run_id,
                workspace_id=clean_ws,
                owner=self.checkpoints.owner,
                account_generation=self.checkpoints.account_generation,
                host_kind=self.host_kind,
                storage_provider=provider_raw,  # type: ignore[arg-type]
                storage_url=str(minted.get("prefixUrl") or minted.get("containerUrl") or ""),
                storage_bucket=str(minted.get("bucket") or ""),
                storage_prefix=str(minted.get("prefix") or ""),
                bearer_token=str(
                    minted.get("bearerToken")
                    or minted.get("accessToken")
                    or minted.get("sasToken")
                    or ""
                ),
                run_key_b64=base64.b64encode(run_key).decode("ascii"),
                timeout_seconds=min(600, max(10, int(timeout_seconds) + 30)),
            )

            job_run = await self.job_dispatcher.dispatch_execution(override)

            # Reconcile checkpoint first (recovers pre-OOM `_ckpt.bin` even if worker crashed before `_out.bin`)
            committed_rev: int = last_rev
            raw_ckpt, _ = await self.checkpoints._get_bounded(
                ckpt_path,
                max_bytes=MAX_WORKSPACE_ARCHIVE_ENCRYPTED_BYTES,
            )
            if raw_ckpt is not None:
                ckpt_doc = open_worker_run_envelope(
                    run_key,
                    raw_ckpt,
                    aad=worker_envelope_aad(
                        owner=self.checkpoints.owner,
                        account_generation=self.checkpoints.account_generation,
                        workspace_id=clean_ws,
                        run_id=run_id,
                        stage="ckpt",
                    ),
                )
                returned_archive = base64.b64decode(str(ckpt_doc.get("archive_b64") or ""))
                saved_head = await self.checkpoints.save_checkpoint_archive(
                    clean_ws,
                    returned_archive,
                    expected_revision=last_rev,
                    reason=str(ckpt_doc.get("reason") or "worker_commit"),
                )
                committed_rev = int(saved_head["revision"])

            raw_out, _ = await self.checkpoints._get_bounded(out_path, max_bytes=512 * 1024)
            if raw_out is not None:
                out_doc = open_worker_run_envelope(
                    run_key,
                    raw_out,
                    aad=worker_envelope_aad(
                        owner=self.checkpoints.owner,
                        account_generation=self.checkpoints.account_generation,
                        workspace_id=clean_ws,
                        run_id=run_id,
                        stage="output",
                    ),
                )
                receipt_dict: dict[str, Any] = dict(out_doc.get("receipt") or {})
            else:
                receipt_dict = {
                    "status": "budget_exceeded",
                    "code": "RESOURCE_BUDGET_EXCEEDED",
                    "exit_code": 137,
                    "stdout_tail": "",
                    "stderr_tail": "",
                    "stdout_truncated": False,
                    "stderr_truncated": False,
                    "duration_ms": 0,
                    "pressure_level": "exceeded",
                    "peak_ratio": 1.0,
                    "evicted_cache_bytes": 0,
                    "checkpoint_revision": committed_rev,
                    "retry_guidance": (
                        "Ephemeral worker exited before receipt flush; retained workspace "
                        "recovered from latest encrypted checkpoint. Narrow command batch size."
                    ),
                    "classification": admission.category,
                }

            receipt_dict["checkpoint_revision"] = committed_rev
            if suppress_capture:
                receipt_dict["stdout_tail"] = ""
                receipt_dict["stderr_tail"] = ""

            event = await self.checkpoints.append_execution_event(
                clean_ws,
                {
                    "timestamp_ms": int(time.time() * 1000),
                    "actor": actor,
                    "boundary_mode": "ephemeral_task_worker",
                    "cli_worker_job_mode": job_run.provider_job_mode,
                    "job_execution_name": job_run.execution_name,
                    "command_summary": "[owner private entry]" if suppress_capture else argv[0],
                    "status": receipt_dict.get("status"),
                    "code": receipt_dict.get("code"),
                    "exit_code": receipt_dict.get("exit_code"),
                    "pressure_level": receipt_dict.get("pressure_level"),
                    "peak_ratio": receipt_dict.get("peak_ratio"),
                    "checkpoint_revision": committed_rev,
                },
            )
            receipt_dict["workspace_id"] = clean_ws
            receipt_dict["boundary_mode"] = "ephemeral_task_worker"
            receipt_dict["cli_worker_job_mode"] = job_run.provider_job_mode
            receipt_dict["job_execution_name"] = job_run.execution_name
            receipt_dict["event_seq"] = event["seq"]
            return receipt_dict
        finally:
            await self._delete_run_artifact(in_path)
            await self._delete_run_artifact(ckpt_path)
            await self._delete_run_artifact(out_path)

    async def execute(
        self,
        *,
        workspace_id: str,
        argv: list[str],
        actor: Literal["agent", "owner"] = "agent",
        seed_files: dict[str, str] | None = None,
        credential_approval_verified: bool = False,
        timeout_seconds: float = 60.0,
    ) -> dict[str, Any]:
        clean_ws = validate_workspace_id(workspace_id)
        current_mode = self._control_modes.get(clean_ws, "agent")
        if actor == "agent" and current_mode == "owner":
            raise WorkspaceRefused(CLI_OWNER_TAKEOVER_ACTIVE, 409)

        if (
            self.job_dispatcher is not None
            and self.storage_token_minter is not None
            and self.boundary_mode() == "ephemeral_task_worker"
        ):
            return await self._execute_via_ephemeral_job(
                clean_ws=clean_ws,
                argv=argv,
                actor=actor,
                current_mode=current_mode,
                seed_files=seed_files,
                credential_approval_verified=credential_approval_verified,
                timeout_seconds=timeout_seconds,
            )

        parent_dir = self.scratch_parent
        if parent_dir is not None:
            parent_dir.mkdir(parents=True, exist_ok=True)
        run_root = Path(
            tempfile.mkdtemp(
                prefix=f"hussh-ws-{clean_ws}-", dir=str(parent_dir) if parent_dir else None
            )
        )
        ws_dir = run_root / "work"
        tmp_dir = run_root / "tmp"
        ws_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir.mkdir(parents=True, exist_ok=True)

        try:
            hydrated = await self.checkpoints.hydrate_workspace(clean_ws, ws_dir)
            last_rev: int = int(hydrated["revision"])

            for rel_path, text_content in (seed_files or {}).items():
                clean_rel = str(rel_path or "").strip().lstrip("/")
                if not clean_rel or ".." in clean_rel.split("/") or "\\" in clean_rel:
                    raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
                target = (ws_dir / clean_rel).resolve()
                if not target.is_relative_to(ws_dir.resolve()):
                    raise WorkspaceRefused("WORKSPACE_ARCHIVE_UNSAFE", 400)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text_content, encoding="utf-8")

            async def _checkpoint(reason: str) -> int | None:
                nonlocal last_rev
                saved = await self.checkpoints.save_checkpoint(
                    clean_ws,
                    ws_dir,
                    expected_revision=last_rev,
                    reason=reason,
                )
                last_rev = int(saved["revision"])
                return last_rev

            receipt = await self.guard.execute_command(
                argv,
                workspace_dir=ws_dir,
                scratch_tmp_dir=tmp_dir,
                boundary_mode=self.boundary_mode(),
                credential_approval_verified=credential_approval_verified,
                timeout_seconds=timeout_seconds,
                checkpoint_fn=_checkpoint if actor == "agent" or current_mode != "owner" else None,
            )

            # Suppress output capture into durable history during private owner takeover entry
            suppress_capture = current_mode == "owner" and actor == "owner"
            event = await self.checkpoints.append_execution_event(
                clean_ws,
                {
                    "timestamp_ms": int(time.time() * 1000),
                    "actor": actor,
                    "boundary_mode": self.boundary_mode(),
                    "cli_worker_job_mode": self.job_mode(),
                    "command_summary": "[owner private entry]" if suppress_capture else argv[0],
                    "status": receipt.status,
                    "code": receipt.code,
                    "exit_code": receipt.exit_code,
                    "pressure_level": receipt.pressure_level,
                    "peak_ratio": receipt.peak_ratio,
                    "checkpoint_revision": receipt.checkpoint_revision or last_rev,
                },
            )
            result: dict[str, Any] = dict(receipt.to_dict())
            if suppress_capture:
                result["stdout_tail"] = ""
                result["stderr_tail"] = ""
            result["workspace_id"] = clean_ws
            result["boundary_mode"] = self.boundary_mode()
            result["cli_worker_job_mode"] = self.job_mode()
            result["event_seq"] = event["seq"]
            result["checkpoint_revision"] = receipt.checkpoint_revision or last_rev
            return dict(result)
        finally:
            shutil.rmtree(run_root, ignore_errors=True)
