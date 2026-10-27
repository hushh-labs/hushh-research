"""Existing ordered resource erasure, separate from admission and finalization."""

from __future__ import annotations

import asyncio
from typing import Any

from hushh_mcp.services import personal_agent_never_hosted_erasure as never_hosted
from hushh_mcp.services.account_service import AccountService


async def run_reserved_erasure(service: Any, *, user_id: str, reservation: dict) -> dict:
    from hushh_mcp.services.hosted_erasure_execution import managed_erasure_step

    if await managed_erasure_step(
        service, user_id=user_id, stage="preparation", reservation=reservation
    ) or await managed_erasure_step(
        service, user_id=user_id, stage="prefix_abort", reservation=reservation
    ):
        await asyncio.to_thread(
            AccountService().assert_personal_agent_external_resources_absent, user_id
        )
        return {"status": "unprovisioned", "noOp": False, "rowDeleteDeferred": True}
    if await never_hosted.erase_reserved_outside_chain(service, user_id=user_id, reservation=reservation):  # fmt: skip
        return {"status": "unprovisioned", "noOp": False, "rowDeleteDeferred": True}
    if not reservation.get("bootstrapGrantRelease"):
        if not (reservation.get("accountErasure") or {}).get("admission"):
            if not reservation.get("computeAdmission"):
                qualified = await service._fence_reserved_erasure(
                    user_id=user_id, reservation=reservation
                )
                await service._erase_reserved_memory(user_id=user_id, qualified=qualified)
            await service._erase_reserved_compute(user_id=user_id)
            await service._retain_reserved_substrate_inventory(user_id=user_id)
            await service._revoke_reserved_runtime_writer(user_id=user_id)
            from hushh_mcp.services.pod_files.erasure import erase_reserved_files

            await erase_reserved_files(service, user_id=user_id)
            await service._erase_reserved_mail_resources(user_id=user_id)
            await service._erase_reserved_bucket(user_id=user_id)
            await service._erase_reserved_kms_material(user_id=user_id)
            await service._erase_reserved_signing_secret(user_id=user_id)
        await managed_erasure_step(service, user_id=user_id, stage="model_grants")
        await service._erase_reserved_runtime_account(user_id=user_id)
        await service._erase_reserved_runtime_grant(user_id=user_id)
        await service._erase_reserved_repository_grant(user_id=user_id)
        await service._retain_reserved_repository_inventory(user_id=user_id)
    await service._erase_reserved_bootstrap_grants(user_id=user_id)
    await managed_erasure_step(service, user_id=user_id, stage="retirement")
    # Phase returns alone are not completion evidence. Keep the
    # registry until the account transaction archives the proof.
    await asyncio.to_thread(
        AccountService().assert_personal_agent_external_resources_absent, user_id
    )
    return {
        "status": "unprovisioned",
        "noOp": False,
        "rowDeleteDeferred": True,
    }
