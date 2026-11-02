"""Registry operations for the retained-session hosted Files executor."""

from __future__ import annotations

import asyncio
import json


class HostedFilesRegistryMixin:
    """Expose hosted Files SQL operations without enlarging the general registry facade."""

    async def hosted_files_queue_erasure_settled(self, *, reservation: dict) -> bool:
        """Ask the installed SQL authority whether hosted Files work has settled."""
        response = await asyncio.to_thread(
            self._db().execute_raw,
            "SELECT public.hosted_files_queue_erasure_settled(CAST(:reservation AS jsonb)) AS settled",
            {"reservation": json.dumps(reservation, separators=(",", ":"))},
        )
        return bool(response.data and response.data[0].get("settled") is True)

    async def begin_hosted_files_executor(
        self,
        *,
        user_id: str,
        observed: dict,
        target_image: str,
        operation_id: str,
        plan: dict,
        incarnation: str,
        deployed_image: str,
    ):
        """Reserve the original SQL session and claim one hosted Files lease."""
        from hushh_mcp.services.pod_files.hosted_executor import HostedFilesExecutor

        return await HostedFilesExecutor.claim(
            database=self._db(),
            owner_id=user_id,
            observed=observed,
            target_image=target_image,
            operation_id=operation_id,
            plan=plan,
            incarnation=incarnation,
            deployed_image=deployed_image,
        )

    async def resume_hosted_files_executor(
        self,
        *,
        user_id: str,
        observed: dict,
        lease: str,
        retry_checkpoint: dict,
        plan: dict,
        incarnation: str,
        deployed_image: str,
    ):
        """Claim an exact denied queue retry with its new dedicated SQL session."""
        from hushh_mcp.services.pod_files.hosted_executor import HostedFilesExecutor

        return await HostedFilesExecutor.resume_claim(
            database=self._db(),
            owner_id=user_id,
            observed=observed,
            lease=lease,
            retry_checkpoint=retry_checkpoint,
            plan=plan,
            incarnation=incarnation,
            deployed_image=deployed_image,
        )
