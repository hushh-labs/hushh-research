"""Phone proof reserves identity; only an already authorized BYOC home auto-starts.

New managed owners choose and provision through the admitted owner flow. A phone
proof cannot allocate a legacy attempt before that choice, even with automation on.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from hushh_mcp.runtime_settings import personal_agent_autoprovision_enabled
from hushh_mcp.services.user_cloud_service import resolve_user_cloud

if TYPE_CHECKING:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

logger = logging.getLogger("hushh_mcp.services.actor_identity_service")


async def continue_verified_phone(
    *,
    service: PersonalAgentProvisioningService,
    registry: PersonalAgentRegistryRepo,
    user_id: str,
    phone_number: str,
) -> None:
    if not personal_agent_autoprovision_enabled():
        return
    cloud = await resolve_user_cloud(user_id, repo=registry)
    if cloud is None or not cloud.is_ready_to_provision:
        return
    try:
        await service.provision(user_id=user_id, phone_e164=phone_number)
    except Exception:
        # The HusshID is derived, not carried, so it is re-derived here purely to
        # label the failure. Without it this traceback is unattributable: it is the
        # first thing that runs for a new person, it runs fire-and-forget where
        # nobody is reading a response, and on a shared dev lane several signups
        # produce identical, unjoinable stack traces.
        try:
            from hushh_mcp.services.personal_agent_identity_service import mint_hushh_id

            failed_hushh_id = mint_hushh_id(phone_number)
        except Exception:  # labelling must never mask the real failure
            failed_hushh_id = "<underivable>"
        logger.exception(
            "personal_agent.autoprovision_failed hushh_id=%s service=one-pod-%s",
            failed_hushh_id,
            failed_hushh_id.lower().replace("_", "-"),
        )
