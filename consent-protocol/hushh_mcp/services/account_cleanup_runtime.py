"""Supervised cleanup loops owned by the existing hub startup task."""

import asyncio


async def _run(interval_seconds: float) -> None:
    from hushh_mcp.services.account_deletion_lifecycle_service import _account_deletion_cleanup_loop
    from hushh_mcp.services.phone_transfer_service import recovery_loop

    async with asyncio.TaskGroup() as group:
        group.create_task(_account_deletion_cleanup_loop(max(1.0, float(interval_seconds))))
        group.create_task(recovery_loop())


def start_cleanup_workers(*, interval_seconds: float) -> asyncio.Task[None]:
    return asyncio.create_task(_run(interval_seconds), name="account-deletion-cleanup-worker")
