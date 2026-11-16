# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Option A / Option B CLI workspace runtime with takeover fencing and resource guard (#9511)."""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Literal

from browser_runtime.qualification import resolve_cli_execution_boundary
from hushh_mcp.operons.pod_workspace import (
    CliBoundaryMode,
    WorkspaceResourceGuard,
    evaluate_resource_pressure,
)
from hushh_mcp.services.pod_resource_snapshot import ResourceSnapshot
from hushh_mcp.services.pod_workspace.checkpoint_store import (
    WorkspaceCheckpointLibrary,
    WorkspaceRefused,
    validate_workspace_id,
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
    ) -> None:
        self.checkpoints = checkpoints
        self.guard = guard or WorkspaceResourceGuard()
        self._host_kind = host_kind
        self._worker_configured = worker_configured
        self.scratch_parent = scratch_parent
        self._control_modes: dict[str, Literal["agent", "owner"]] = {}
        self._control_epochs: dict[str, int] = {}

    @property
    def host_kind(self) -> str:
        return self._host_kind or current_pod_host_kind()

    @property
    def worker_configured(self) -> bool:
        if self._worker_configured is not None:
            return self._worker_configured
        return ephemeral_cli_worker_configured()

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
            "worker_configured": self.worker_configured,
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
            result["event_seq"] = event["seq"]
            result["checkpoint_revision"] = receipt.checkpoint_revision or last_rev
            return dict(result)
        finally:
            shutil.rmtree(run_root, ignore_errors=True)
