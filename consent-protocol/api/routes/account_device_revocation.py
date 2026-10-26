"""Existing trusted-device revocation effects behind explicit route-owned ports."""

from typing import Any

from fastapi import HTTPException


async def revoke(device_id: str, owner: str, *, devices: Any, run: Any, logger: Any):
    revoked = await run(devices.revoke_device, user_id=owner, device_id=device_id)
    existing = (
        None if revoked else await run(devices.device_status, user_id=owner, device_id=device_id)
    )
    if not revoked and (not existing or existing.get("status") != "revoked"):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "TRUSTED_DEVICE_NOT_FOUND",
                "message": "The trusted device was not found or was already revoked.",
            },
        )
    return await _settle_revoked(device_id, owner, logger=logger)


async def settle(device_id: str, owner: str, *, devices: Any, run: Any, logger: Any):
    """Retry ledger settlement only after a definite revoked-device readback."""
    status = await run(devices.device_status, user_id=owner, device_id=device_id)
    if not status or status.get("status") != "revoked":
        return None
    return await _settle_revoked(device_id, owner, logger=logger)


async def _settle_revoked(device_id: str, owner: str, *, logger: Any):
    from hushh_mcp.services.consent_db import ConsentDBService

    consent = ConsentDBService()
    agent = f"device:{device_id}"
    tokens = await consent.get_active_internal_tokens(owner, agent_id=agent, scope="vault.owner")
    for row in tokens:
        await _revoke_token(consent, owner, agent, row, internal=True)
    await _revoke_puppy(consent, owner, agent, logger)
    # Fresh statement after the active-row commit fences an issuer that waited
    # for the same device lock. The pod still needs its signed delivery receipt.
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    pod = await PersonalAgentRegistryRepo().get(owner)
    metadata = (pod or {}).get("backend_metadata") or {}
    binding = (metadata.get("bindings") or {}).get(device_id) or {}
    return {
        "success": True,
        "device_id": device_id,
        "podBindingVersion": int(binding.get("version") or 0),
    }


async def _revoke_token(consent: Any, owner: str, agent: str, row: dict, *, internal: bool):
    from hushh_mcp.consent.token import revoke_token

    token = str(row.get("token_id") or "")
    if not token:
        return
    revoke_token(token)
    kwargs = {
        "user_id": owner,
        "agent_id": agent,
        "scope": "vault.owner" if internal else str(row["scope"]),
        "action": "REVOKED",
        "token_id": token,
        "metadata": {"reason": "trusted_device_revoked"},
    }
    if internal:
        await consent.insert_internal_event(**kwargs)
    else:
        await consent.insert_event(
            **kwargs, scope_description="Puppy inference through the owner's BYOC pod"
        )


async def _revoke_puppy(consent: Any, owner: str, agent: str, logger: Any):
    try:
        from hushh_mcp.constants import ConsentScope

        scope = ConsentScope.CAP_PUPPY_INFERENCE.value
        for row in await consent.get_active_tokens(owner, agent_id=agent):
            if str(row.get("scope") or "") == scope:
                await _revoke_token(consent, owner, agent, row, internal=False)
    except Exception:
        # Active-device checks remain authoritative if this optional ledger
        # cleanup fails, matching the pre-existing revoke behavior.
        logger.warning("trusted_device.puppy_grant_revoke_failed")
