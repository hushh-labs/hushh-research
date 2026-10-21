"""Attach to a recorded VM without applying Container Apps lifecycle operations.

Reads do not wake or mutate the VM. Explicit image updates retain owner-JIT
authority; the key-erasure checkpoint uses the existing reserved operation.
Customer hosting and full cloud teardown remain unavailable until their complete
VM lifecycle and inventory are qualified.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import TYPE_CHECKING

from hushh_mcp.services.azure_arm_client import ArmClient
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
    live = False  # Customer activation stays gated; explicit JIT operations retain their own admission.

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
        from hushh_mcp.services.azure_vm_observation import observe_power

        return observe_power(self._host, observer=self._observer, guard=guard)

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

    async def observe_erasure_target(self, spec: PodSpec) -> dict[str, str]:
        from hushh_mcp.services.azure_vm_erasure import observe

        return await observe(self, spec)

    async def checkpoint_owner_access(
        self, spec: PodSpec, *, crypto_erase: Callable[[dict[str, str]], Awaitable[dict]]
    ) -> None:
        from hushh_mcp.services.azure_vm_erasure import checkpoint

        await checkpoint(self, spec, crypto_erase=crypto_erase)

    async def erase_owner_access(
        self, spec: PodSpec, *, crypto_erase: Callable[[dict[str, str]], Awaitable[dict]]
    ) -> dict:
        raise RuntimeError("VM erasure requires the retained owner cleanup operation")

    async def resume_owner_access_revocation(
        self, spec: PodSpec, *, agent_erased: dict, resume: dict[str, str]
    ) -> dict:
        raise RuntimeError("VM revocation requires the retained owner cleanup operation")

    async def deprovision(self, external_agent_id: str) -> None:
        raise RuntimeError("Azure VM cleanup requires the retained owner erasure operation")

    async def health(self) -> bool:
        return True
