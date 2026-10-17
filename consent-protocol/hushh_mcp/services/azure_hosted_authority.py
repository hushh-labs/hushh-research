"""Join approved hosted operations to the existing owner setup journal.

Only identifiers cross the task context. Delegated credentials remain in the
existing JIT token port; provider bodies and credentials never enter receipts.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar

from hushh_mcp.services.azure_hosted_intent import hosted_intent
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.azure_setup_authority import AzureSetupAuthority, azure_setup_authority
from hushh_mcp.services.compute_backend import PodSpec

_JOB: ContextVar[tuple[str, str] | None] = ContextVar("azure_hosted_job", default=None)


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
async def upgrade_authority(spec: PodSpec) -> AsyncIterator[AzureSetupAuthority]:
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    context = _JOB.get()
    if context is None:
        raise AzureSetupRefused("Update needs its approved owner job.", code="SETUP_FENCED")
    owner, job = context
    row = await PersonalAgentRegistryRepo().get(owner)
    intent = hosted_intent(
        row or {}, job=job, spec=spec, source=str(spec.upgrade_target_image or ""), kind="upgrade"
    )
    async with azure_setup_authority(owner=owner, job=job, hosted_intent=intent) as authority:
        yield authority
