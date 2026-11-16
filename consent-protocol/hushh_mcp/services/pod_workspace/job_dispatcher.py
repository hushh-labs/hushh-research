# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Declarative Option A ephemeral CLI worker job dispatchers (#9511).

Maps `CliWorkerJobMode` (`cloud_run_jobs_v2`, `azure_container_apps_jobs`) onto
their typed cloud execution adapters without leaking `if cloud == ...` branches
into `WorkspaceCliRuntime`.
"""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from hushh_mcp.operons.pod_workspace import (
    NormalizedWorkerJobRunResult,
    WorkerExecutionOverrideInput,
    WorkerJobSpecInput,
    WorkspaceResourceGuard,
    build_worker_override_env_map,
    normalize_azure_job_execution,
    normalize_gcp_job_execution,
    render_azure_container_app_job_spec,
    render_azure_container_app_job_start_body,
    render_gcp_cloud_run_job_overrides,
    render_gcp_cloud_run_job_spec,
)
from hushh_mcp.services.azure_arm_client import ArmClient
from hushh_mcp.services.azure_container_app_jobs import (
    run_workspace_job_execution,
    upsert_workspace_job,
)
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.pod_workspace.worker_runner import (
    build_worker_subprefix_store,
    execute_staged_worker_run,
    verify_worker_container_env_scrubbed,
)
from hushh_mcp.services.provider_capability_registry import (
    CliWorkerJobMode,
    cli_worker_job_mode_for_host,
)


class WorkerJobDispatcherPort(Protocol):
    """Uniform dispatch interface for ephemeral CLI worker job substrates."""

    @property
    def job_mode(self) -> CliWorkerJobMode: ...

    async def dispatch_execution(
        self, override: WorkerExecutionOverrideInput
    ) -> NormalizedWorkerJobRunResult: ...


class GcpCloudRunJobDispatcher:
    """Upserts and executes a Cloud Run Admin v2 `Job` for an Option A CLI run."""

    job_mode: CliWorkerJobMode = "cloud_run_jobs_v2"

    def __init__(
        self,
        *,
        run_client: GcpRunClient,
        job_id: str,
        spec_input: WorkerJobSpecInput,
        session: Any = None,
        ensure_job_on_first_run: bool = True,
    ) -> None:
        self._client = run_client
        self._job_id = job_id
        self._spec = spec_input
        self._session = session
        self._ensure_job = ensure_job_on_first_run
        self._ensured = False

    async def dispatch_execution(
        self, override: WorkerExecutionOverrideInput
    ) -> NormalizedWorkerJobRunResult:
        if self._ensure_job and not self._ensured:
            job_body = render_gcp_cloud_run_job_spec(self._spec)
            await asyncio.to_thread(
                self._client.upsert_job,
                self._job_id,
                job_body,
                session=self._session,
            )
            self._ensured = True

        overrides_body = render_gcp_cloud_run_job_overrides(override)
        settled = await asyncio.to_thread(
            self._client.run_job_execution,
            self._job_id,
            overrides_body,
            timeout_s=float(override.timeout_seconds) + 60.0,
            session=self._session,
        )
        return normalize_gcp_job_execution(settled)


class AzureContainerAppsJobDispatcher:
    """Upserts and starts an Azure `Microsoft.App/jobs` execution for an Option A CLI run."""

    job_mode: CliWorkerJobMode = "azure_container_apps_jobs"

    def __init__(
        self,
        *,
        arm_client: ArmClient,
        job_resource_id: str,
        spec_input: WorkerJobSpecInput,
        ensure_job_on_first_run: bool = True,
    ) -> None:
        self._arm = arm_client
        self._job_path = job_resource_id
        self._spec = spec_input
        self._ensure_job = ensure_job_on_first_run
        self._ensured = False

    async def dispatch_execution(
        self, override: WorkerExecutionOverrideInput
    ) -> NormalizedWorkerJobRunResult:
        if self._ensure_job and not self._ensured:
            job_body = render_azure_container_app_job_spec(self._spec)
            await asyncio.to_thread(upsert_workspace_job, self._arm, self._job_path, job_body)
            self._ensured = True

        start_body = render_azure_container_app_job_start_body(self._spec, override)
        settled = await asyncio.to_thread(
            run_workspace_job_execution,
            self._arm,
            self._job_path,
            start_body,
            timeout_s=float(override.timeout_seconds) + 60.0,
        )
        return normalize_azure_job_execution(settled)


class LocalSubprefixWorkerDispatcher:
    """Executes `execute_staged_worker_run` against a real subprefix store for Floci/conformance tests."""

    def __init__(
        self,
        *,
        simulated_job_mode: CliWorkerJobMode = "cloud_run_jobs_v2",
        guard: WorkspaceResourceGuard | None = None,
        scratch_parent: Path | None = None,
        subprefix_store_factory: Callable[[dict[str, str]], Any] | None = None,
    ) -> None:
        self.job_mode: CliWorkerJobMode = simulated_job_mode
        self._guard = guard
        self._scratch_parent = scratch_parent
        self._store_factory = subprefix_store_factory

    async def dispatch_execution(
        self, override: WorkerExecutionOverrideInput
    ) -> NormalizedWorkerJobRunResult:
        env_map = build_worker_override_env_map(override)
        verify_worker_container_env_scrubbed(env_map)
        store = (
            self._store_factory(env_map)
            if self._store_factory is not None
            else build_worker_subprefix_store(env_map)
        )
        await execute_staged_worker_run(
            subprefix_store=store,
            run_id=override.run_id,
            workspace_id=override.workspace_id,
            owner=override.owner,
            account_generation=override.account_generation,
            run_key=base64.b64decode(override.run_key_b64),
            guard=self._guard,
            scratch_parent=self._scratch_parent,
            apply_landlock=False,
        )
        return NormalizedWorkerJobRunResult(
            provider_job_mode=(
                "azure_container_apps_jobs"
                if self.job_mode == "azure_container_apps_jobs"
                else "cloud_run_jobs_v2"
            ),
            execution_name=f"exec-{override.run_id[:12]}",
            succeeded=True,
            failed_count=0,
            succeeded_count=1,
            raw_state="Succeeded",
        )


DISPATCHER_TYPES_BY_JOB_MODE: dict[CliWorkerJobMode, type[Any]] = {
    "cloud_run_jobs_v2": GcpCloudRunJobDispatcher,
    "azure_container_apps_jobs": AzureContainerAppsJobDispatcher,
}


def resolve_dispatcher_type_for_host(host_kind: str) -> type[Any] | None:
    mode = cli_worker_job_mode_for_host(host_kind)
    return DISPATCHER_TYPES_BY_JOB_MODE.get(mode)
