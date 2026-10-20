"""Attach to a recorded VM without applying Container Apps lifecycle operations.

Reads do not wake or mutate the VM. Customer hosting offers, updates and erasure
retain their existing owner-operation authorities and remain unavailable until
their VM-specific composition is qualified.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import replace
from typing import TYPE_CHECKING

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_vm_host_binding import AzureVmHostBinding
from hushh_mcp.services.compute_backend import (
    BACKEND_USER_AZURE,
    BackendHandle,
    BackendStatus,
    PodSpec,
)

if TYPE_CHECKING:
    from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient


class UserAzureVmBackend:
    backend_id = BACKEND_USER_AZURE
    live = False  # No mutation can claim an upgrade lease through this read-only adapter.

    def __init__(self, spec: PodSpec, *, observer: Callable[[], ArmClient] | None = None) -> None:
        host = spec.azure_vm_host
        if not isinstance(host, AzureVmHostBinding):
            raise ValueError("Azure VM backend requires its recorded host")
        host.require_spec(spec)
        self._host: AzureVmHostBinding = host
        self._spec, self._observer_factory = spec, observer

    @property
    def app_id(self) -> str:
        return str(self._host.installation.resource_id)

    def _observer(self) -> ArmClient:
        if self._observer_factory is not None:
            return self._observer_factory()
        from hushh_mcp.services import azure_federation

        return ArmClient(
            lambda: azure_federation.app_token(str(self._spec.user_cloud_tenant_id)).access_token,
            throttle_retries=0,
            transient_retries=0,
        )

    def _observe(self, *, guard: Callable[[], None]) -> str:
        # Cooperative ARM dispatch budget. Federation token acquisition retains
        # its own bounded HTTP/retry contract; this is not a total latency claim.
        deadline = time.monotonic() + 45

        def remaining() -> float:
            guard()
            value = deadline - time.monotonic()
            if value <= 0:
                raise TimeoutError("Azure VM ARM read budget exceeded")
            return min(30.0, value)

        guard()
        source = self._observer()
        arm = source.with_request_budget(remaining)
        try:
            api = API_VERSIONS["virtual_machines"]
            resource = arm.get_or_none(self.app_id, api_version=api, op="vm_observe")
            if resource is None:
                return "gone"  # Only exact-resource GET404 establishes absence.
            target = self._host.target()
            target.require_current(resource)
            body = arm.get(self.app_id + "/instanceView", api_version=api, op="vm_observe")
            statuses = body.get("statuses")
            if not isinstance(statuses, list):
                raise ValueError("Azure VM power observation is unavailable")
            states: list[str] = [
                entry["code"].removeprefix("PowerState/")
                for entry in statuses
                if isinstance(entry, dict)
                and isinstance(entry.get("code"), str)
                and entry["code"].startswith("PowerState/")
            ]
            if len(states) != 1 or states[0] not in {
                "starting",
                "running",
                "stopping",
                "stopped",
                "deallocating",
                "deallocated",
                "unknown",
            }:
                raise ValueError("Azure VM power observation is unavailable")
            # Fence a provider replacement between the separate reads.
            target.require_current(arm.get(self.app_id, api_version=api, op="vm_observe"))
            return states[0]
        finally:
            arm.close()
            source.close()

    async def get(self, external_agent_id: str) -> BackendStatus:
        if external_agent_id.casefold() != self.app_id.casefold():
            raise ValueError("Azure VM differs from the recorded pod")
        from hushh_mcp.services.azure_setup_worker import run_setup_thread

        state = await run_setup_thread(
            lambda *, guard, advance: self._observe(guard=guard), advance=lambda _: None
        )
        # Running is a billing/power fact, never authenticated application health.
        status = "sleeping" if state in {"stopped", "deallocated"} else state
        return BackendStatus(self.app_id, status, healthy=False)

    async def provision(self, spec: PodSpec) -> BackendHandle:
        self._host.require_spec(spec)
        # Generic orphan adoption permits key rotation and replaces retained
        # metadata. VM recovery must preserve exact custody and lifecycle receipts.
        raise RuntimeError("Azure VM attachment requires exact owner-approved recovery")

    async def upgrade(self, spec: PodSpec) -> BackendHandle:
        """Compose the approved owner job; customer availability stays gated."""
        from hushh_mcp.services.azure_hosted_authority import current_hosted_job, vm_upgrade_source
        from hushh_mcp.services.azure_setup_worker import run_setup_thread
        from hushh_mcp.services.azure_vm_image_upgrade import (
            apply_vm_image_update,
            release_unattempted_vm_update,
        )
        from hushh_mcp.services.azure_vm_upgrade_plan import prepare_vm_image_update
        from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient
        from hushh_mcp.services.user_azure_backend import current_jit_token

        self._host.require_spec(spec)
        token = current_jit_token()  # Never replace owner authority with the observer's identity.
        owner, job = current_hosted_job()
        registry, frozen, guard = await vm_upgrade_source(spec)

        handoff = PodUpgradeHandoffClient(url=self._host.url, hushh_id=spec.hushh_id)
        receipts: list[dict] = []
        try:
            receipt = await run_setup_thread(
                self._drain_upgrade,
                spec=spec,
                handoff=handoff,
                receipts=receipts,
                advance=lambda _: None,
                guard=guard,
            )
            current = await registry.get(owner)
            plan = await run_setup_thread(
                prepare_vm_image_update,
                row=current or {},
                spec=spec,
                receipt=receipt,
                advance=lambda _: None,
                guard=guard,
            )
            return await apply_vm_image_update(
                row=current or {},
                spec=spec,
                plan=plan,
                receipt=receipt,
                handoff=handoff,
                token=token,
            )
        except (Exception, asyncio.CancelledError):
            if receipts:
                cleanup = asyncio.create_task(
                    release_unattempted_vm_update(
                        registry=registry,
                        owner=owner,
                        job=job,
                        spec=spec,
                        binding=frozen,
                        handoff=handoff,
                        receipt=receipts[0],
                    )
                )
                while not cleanup.done():
                    try:
                        await asyncio.shield(cleanup)
                    except asyncio.CancelledError:
                        continue
                if not cleanup.cancelled():
                    cleanup.result()
            raise

    def _drain_upgrade(
        self,
        *,
        spec: PodSpec,
        handoff: PodUpgradeHandoffClient,
        receipts: list[dict],
        guard: Callable[[], None],
        advance: Callable[[str], None],
    ) -> dict:
        if spec.on_upgrade_idle is None:
            raise RuntimeError("VM_UPDATE_DURABLE_IDLE_REQUIRED")
        receipt = handoff.prepare_and_wait(
            operation_id=str(spec.upgrade_operation_id or ""),
            incarnation=self._host.installation.generation,
            timeout_seconds=480,
            guard=guard,
        )
        receipts.append(receipt)
        guard()
        spec.on_upgrade_idle(receipt)
        guard()
        return receipt

    async def observe_upgrade(self, spec: PodSpec, receipt: dict) -> BackendHandle | None:
        from hushh_mcp.services.azure_setup_worker import run_setup_thread
        from hushh_mcp.services.azure_vm_image_upgrade import observe_vm_image_update
        from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
        from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient

        self._host.require_spec(spec)
        registry, loop = PersonalAgentRegistryRepo(), asyncio.get_running_loop()
        evidence = await registry.vm_image_upgrade_recovery(hushh_id=spec.hushh_id, receipt=receipt)
        if evidence is None:
            return None
        bound = replace(
            spec,
            upgrade_operation_id=receipt.get("operationId"),
            upgrade_target_image=receipt.get("targetImage"),
        )

        def guard() -> None:
            current = asyncio.run_coroutine_threadsafe(
                registry.vm_image_upgrade_recovery(hushh_id=spec.hushh_id, receipt=receipt), loop
            ).result(30)
            if current is None or current["intent"] != evidence["intent"]:
                raise RuntimeError("VM_UPDATE_RECOVERY_AUTHORITY_CHANGED")

        def run(*, guard: Callable[[], None], advance: Callable[[str], None]):
            source = self._observer()

            def budget() -> float:
                guard()
                return 20.0

            try:
                return observe_vm_image_update(
                    row=evidence["registry"],
                    spec=bound,
                    intent=evidence["intent"],
                    receipt=receipt,
                    source=source,
                    handoff=PodUpgradeHandoffClient(
                        url=self._host.url, hushh_id=spec.hushh_id, request_budget=budget
                    ),
                    guard=guard,
                    advance=advance,
                )
            finally:
                source.close()

        return await run_setup_thread(run, advance=lambda _: None, guard=guard)

    def render_deploy_config(self, spec: PodSpec) -> dict:
        self._host.require_spec(spec)
        raise RuntimeError("Azure VM hosting requires its exact owner-approved host offer")

    async def deprovision(self, external_agent_id: str) -> None:
        raise RuntimeError("Azure VM cleanup requires the retained owner erasure operation")

    async def health(self) -> bool:
        return True
