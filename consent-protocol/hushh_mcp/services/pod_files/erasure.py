"""Files erasure orchestration behind the existing provisioning service authority."""

import asyncio


async def erase_reserved_files(service, *, user_id: str) -> None:
    from hushh_mcp.runtime_settings import personal_agent_substrate_teardown_enabled

    if not personal_agent_substrate_teardown_enabled():
        raise RuntimeError("Files erasure guarded")
    current = await service._registry.get(user_id)
    reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
    snapshot = reservation.get("registrySnapshot") or {}
    inventory = reservation.get("substrateInventory") or {}
    if not any(
        item.get("type") == "cloud_tasks_queue"
        for item in inventory.get("plannedResources", [])
        if isinstance(item, dict)
    ):
        return
    retain = getattr(service._registry, "retain_erasure_files_receipt", None)
    preflight = getattr(service._registry, "verify_erasure_files_preflight", None)
    if (
        not current
        or current.get("status") != "suspended"
        or reservation.get("ownerId") != user_id
        or snapshot.get("user_id") != user_id
        or not reservation.get("writerDisabled")
        or retain is None
        or preflight is None
    ):
        raise RuntimeError("Files erasure reservation unavailable")
    if not await preflight(user_id=user_id, reservation=reservation):
        raise RuntimeError("Files erasure database contract unavailable")
    erase = getattr(service._reserved_cleanup_backend(snapshot), "erase_files_resource", None)
    if erase is None:
        raise RuntimeError("Files erasure unsupported")
    attempt = reservation["attemptId"]
    loop = asyncio.get_running_loop()
    # Validate all intended Files resources before removing the first one.
    observations = []
    for kind, resource_type in (("queue", "cloud_tasks_queue"), ("worker", "service_account")):
        planned = [
            item
            for item in inventory.get("plannedResources", [])
            if isinstance(item, dict)
            and item.get("type") == resource_type
            and (
                kind == "queue"
                or item.get("id")
                != (reservation.get("writerDisabled") or {}).get("runtimeIdentity", {}).get("email")
            )
        ]
        if len(planned) != 1:
            raise RuntimeError("Files erasure inventory unresolved")
        captured = [
            item
            for item in inventory.get("resourceObservations", [])
            if isinstance(item, dict)
            and item.get("type") == resource_type
            and item.get("id") == planned[0].get("id")
            and item.get("disposition") == "created"
        ]
        if len(captured) != 1:
            raise RuntimeError("Files erasure creation evidence unavailable")
        observations.append((kind, captured[0]))

    for kind, observation in observations:

        async def append(stage: str, raw: dict, *, kind: str = kind) -> bool:
            nonlocal reservation
            if stage == "admission":
                await service._revoke_reserved_runtime_writer(user_id=user_id)
            observed = await service._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or saved.get("ownerId") != user_id
                or saved.get("attemptId") != attempt
                or saved.get("registrySnapshot") != snapshot
                or saved.get("substrateInventory") != inventory
            ):
                return False
            receipt = {**raw, "ownerId": user_id, "attemptId": attempt}
            if not await retain(
                user_id=user_id, reservation=saved, kind=kind, stage=stage, receipt=receipt
            ):
                return False
            observed = await service._registry.get(user_id)
            saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
            if (
                not observed
                or observed.get("status") != "suspended"
                or saved.get("ownerId") != user_id
                or saved.get("attemptId") != attempt
                or saved.get("filesErasure", {}).get(kind, {}).get(stage) != receipt
            ):
                return False
            reservation = saved
            return True

        def checkpoint(stage: str, raw: dict, *, append_receipt=append) -> bool:
            return asyncio.run_coroutine_threadsafe(append_receipt(stage, raw), loop).result(
                timeout=30
            )

        states = {}
        for stage, receipt in reservation.get("filesErasure", {}).get(kind, {}).items():
            if (
                not isinstance(receipt, dict)
                or receipt.get("ownerId") != user_id
                or receipt.get("attemptId") != attempt
            ):
                raise RuntimeError("Files recovery owner unverified")
            states[stage] = {
                key: value for key, value in receipt.items() if key not in {"ownerId", "attemptId"}
            }
        await erase(observation=observation, state=states, retain_receipt=checkpoint)
