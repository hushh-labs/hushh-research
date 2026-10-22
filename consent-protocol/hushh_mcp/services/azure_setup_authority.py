"""Owner-scoped ARM receipts in the existing setup job, on a dedicated session.

The session lease identifies the real local worker. Its exit is deliberately
separate from provider settlement: a lost response remains unresolved. No
credential, private request body or provider response body crosses this port.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any

from db.connection import dedicated_connection
from hushh_mcp.services.azure_arm_mutations import (
    ArmMutationAcknowledgement,
    ArmMutationOutcome,
    ArmMutationRequest,
)
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused


class AzureSetupAuthority:
    def __init__(self, connection: Any, *, owner: str, job: str, execution: str) -> None:
        self._connection = connection
        self._owner = owner
        self._job = job
        self._execution = execution
        self._loop = asyncio.get_running_loop()
        self._serial = asyncio.Lock()

    async def retain(self, stage: str, **fields: Any) -> bool:
        event = {"stage": stage, "jobId": self._job, "executionId": self._execution, **fields}
        async with self._serial:
            return (
                await self._connection.fetchval(
                    "SELECT public.retain_byoc_azure_worker_event($1,$2,$3::jsonb)",
                    self._owner,
                    self._job,
                    json.dumps(event),
                )
                is True
            )

    def _from_thread(self, stage: str, **fields: Any) -> bool:
        return asyncio.run_coroutine_threadsafe(self.retain(stage, **fields), self._loop).result(30)

    async def _admitted(self) -> bool:
        async with self._serial:
            return (
                await self._connection.fetchval(
                    "SELECT public.byoc_azure_worker_admitted($1,$2)", self._owner, self._job
                )
                is True
            )

    def assert_admitted(self) -> None:
        if not asyncio.run_coroutine_threadsafe(self._admitted(), self._loop).result(30):
            raise AzureSetupRefused("Cloud operation stopped.", code="SETUP_FENCED")

    def admit(self, request_id: str, request: ArmMutationRequest) -> bool:
        return self._from_thread(
            "azure_provider_request",
            requestId=request_id,
            method=request.method,
            path=request.path,
            apiVersion=request.api_version,
            purpose=request.purpose,
            **({"bodySha256": request.body_sha256} if request.body_sha256 is not None else {}),
        )

    def acknowledge(self, request_id: str, receipt: ArmMutationAcknowledgement) -> bool:
        return self._from_thread(
            "azure_provider_ack",
            requestId=request_id,
            status=receipt.status,
            operationUrl=receipt.operation_url,
            operationUrlSha256=receipt.operation_url_sha256,
            **({"operationKind": receipt.operation_kind} if receipt.operation_kind else {}),
        )

    def terminal(self, request_id: str, outcome: ArmMutationOutcome) -> bool:
        return self._from_thread("azure_provider_terminal", requestId=request_id, outcome=outcome)


@asynccontextmanager
async def azure_setup_authority(
    *,
    owner: str,
    job: str,
    hosted_intent: dict | None = None,
    connection_factory: Callable[[], AbstractAsyncContextManager[Any]] = dedicated_connection,
) -> AsyncIterator[AzureSetupAuthority]:
    async with connection_factory() as connection:
        execution = str(uuid.uuid4())
        arguments: tuple[str, ...] = (owner, job, execution)
        query = "SELECT public.begin_byoc_azure_worker($1,$2,$3)"
        if hosted_intent is not None:
            arguments += (json.dumps(hosted_intent),)
            query = "SELECT public.begin_byoc_azure_worker($1,$2,$3,$4::jsonb)"
        admitted = await connection.fetchval(query, *arguments)
        if admitted is not True:
            raise AzureSetupRefused("Cloud setup needs reconciliation.", code="SETUP_FENCED")
        authority = AzureSetupAuthority(connection, owner=owner, job=job, execution=execution)
        try:
            # The caller must join run_setup_thread before leaving this context.
            yield authority
        finally:
            if not await authority.retain("azure_worker_exited"):
                raise AzureSetupRefused(
                    "Cloud setup stopped; its worker receipt needs reconciliation.",
                    code="SETUP_FENCED",
                )
