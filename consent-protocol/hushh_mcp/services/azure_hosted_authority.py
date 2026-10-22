"""Join approved hosted operations to the existing owner setup journal.

Only identifiers cross the task context. Delegated credentials remain in the
existing JIT token port; provider bodies and credentials never enter receipts.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING

from hushh_mcp.services.azure_hosted_intent import hosted_intent
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.azure_setup_authority import AzureSetupAuthority, azure_setup_authority
from hushh_mcp.services.compute_backend import PodSpec

_JOB: ContextVar[tuple[str, str] | None] = ContextVar("azure_hosted_job", default=None)

if TYPE_CHECKING:
    from hushh_mcp.services.azure_vm_upgrade_plan import VmImageUpdatePlan
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo


def current_hosted_job() -> tuple[str, str]:
    context = _JOB.get()
    if context is None:
        raise AzureSetupRefused("Update needs its approved owner job.", code="SETUP_FENCED")
    return context


async def vm_upgrade_source(
    spec: PodSpec,
) -> tuple[PersonalAgentRegistryRepo, dict, Callable[[], None]]:
    """Freeze the existing owner job before any handoff or provider action."""
    from hushh_mcp.services.azure_vm_upgrade_plan import approved_vm_update, vm_registry_binding
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    owner, _ = current_hosted_job()
    registry, loop = PersonalAgentRegistryRepo(), asyncio.get_running_loop()
    row = await registry.get(owner)
    approved_vm_update(row or {}, spec)
    frozen = vm_registry_binding(row or {})

    async def still_current() -> None:
        current = await registry.get(owner)
        approved_vm_update(current or {}, spec)
        if vm_registry_binding(current or {}) != frozen:
            raise RuntimeError("VM_UPDATE_AUTHORITY_CHANGED")

    def guard() -> None:
        asyncio.run_coroutine_threadsafe(still_current(), loop).result(30)

    return registry, frozen, guard


@contextmanager
def hosted_job(*, owner: str, job: str) -> Iterator[None]:
    if not owner or not job:
        raise AzureSetupRefused("Cloud operation needs its owner job.", code="SETUP_FENCED")
    marker = _JOB.set((owner, job))
    try:
        yield
    finally:
        _JOB.reset(marker)


@asynccontextmanager
async def upgrade_authority(
    spec: PodSpec, *, vm_plan: VmImageUpdatePlan | None = None
) -> AsyncIterator[AzureSetupAuthority]:
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    owner, job = current_hosted_job()
    row = await PersonalAgentRegistryRepo().get(owner)
    intent = (
        vm_plan.intent(job=job)
        if vm_plan is not None
        else hosted_intent(
            row or {},
            job=job,
            spec=spec,
            source=str(spec.upgrade_target_image or ""),
            kind="upgrade",
        )
    )
    async with azure_setup_authority(owner=owner, job=job, hosted_intent=intent) as authority:
        yield authority
