"""Finish an owner-cloud setup by attaching the agent it just created.

An Azure setup builds the person's agent in their own subscription under their own
Microsoft sign-in, then records the cloud. Until 2026-10-05 nothing attached it:
the row sat at ``reserved`` until someone pressed Build my agent on another
screen, and the founder's first live run stopped there. The setup was the owner's
act; attaching creates no compute (the backend's ``provision`` only adopts what
setup built), so the hub completes it the moment the cloud is recorded, the same
way phone verification already continues into ``provision`` server-side.

From there the rest is the pod's own beats: the hub pulls its key, the attach
finishes, and public-by-construction ingress is verified for owner-direct chat
(``pod_external_ingress_admission``). Never raises: a refusal leaves the recorded
cloud as it was, and Build my agent remains the owner's manual path.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def _verified_phone(user_id: str, identities: Any) -> str:
    if identities is None:
        from hushh_mcp.services.actor_identity_service import (  # noqa: PLC0415
            ActorIdentityService,
        )

        identities = ActorIdentityService()
    identity = (await identities.get_many([user_id])).get(user_id) or {}
    if identity.get("phone_verified") is not True:
        return ""
    return str(identity.get("phone_number") or "").strip()


def _default_service() -> Any:
    from hushh_mcp.services.compute_backend import resolve_compute_backend  # noqa: PLC0415
    from hushh_mcp.services.personal_agent_provisioning_service import (  # noqa: PLC0415
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        PersonalAgentRegistryRepo,
    )

    # The same backend resolution as the owner's provision route, so both paths
    # attach through the same adapter (a bare service would be an inert backend).
    return PersonalAgentProvisioningService(
        registry=PersonalAgentRegistryRepo(), backend=resolve_compute_backend()
    )


async def attach_after_setup(
    user_id: str, *, identities: Any = None, service: Any = None
) -> Optional[str]:
    """Attach the person's freshly set-up agent. The new status, or None when not attached."""
    try:
        phone = await _verified_phone(user_id, identities)
        if not phone:
            logger.info("owner_cloud_attach.skipped reason=phone_not_verified")
            return None
        result = await (service or _default_service()).provision(user_id=user_id, phone_e164=phone)
    except Exception as exc:  # noqa: BLE001 - setup stays recorded; the owner can retry
        logger.warning("owner_cloud_attach.failed err=%s", type(exc).__name__)
        return None
    status = str((result or {}).get("status") or "") or None
    logger.info("owner_cloud_attach.attached status=%s", status)
    return status


__all__ = ["attach_after_setup"]
