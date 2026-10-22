"""Machine-observed VM admission; recovered memory alone is not owner readiness."""

from __future__ import annotations


async def vm_session_readiness() -> dict | None:
    from hushh_mcp.services.pod_azure_vm_identity import active_vm_installation
    from hushh_mcp.services.pod_session_authority import active_session_authority

    installation = active_vm_installation()
    if installation is None:
        return None
    authority = active_session_authority()
    if authority is None:
        return {"state": "unavailable"}
    try:
        await authority.require_held()
        if authority.hushh_id != installation.hushh_id or not authority.pod_key_id:
            return {"state": "unavailable"}
        return {
            "state": "held",
            "hushhId": authority.hushh_id,
            "podKeyId": authority.pod_key_id,
            "incarnation": installation.generation,
            "epoch": authority.epoch,
        }
    except Exception:
        return {"state": "unavailable"}
