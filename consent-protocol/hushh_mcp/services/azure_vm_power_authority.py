"""Durable VM power receipts in the existing owner registry.

This internal port is not a hosting offer. A qualified installer must first
publish an exact VM installation and scoped provider authority. A pending cycle
survives worker exit, including deallocation, until authenticated recovery and
release settle it. The separate customer VM lifecycle remains disabled.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from copy import deepcopy
from typing import Any
from uuid import uuid4

from db.connection import dedicated_connection
from hushh_mcp.services.azure_arm_mutations import (
    ArmMutationAcknowledgement,
    ArmMutationOutcome,
    ArmMutationRequest,
)
from hushh_mcp.services.azure_vm_power import AzureVmPowerRefused, AzureVmPowerTarget
from hushh_mcp.services.pod_azure_vm_identity import AzureVmInstallation


def _object(value: Any) -> dict:
    result = json.loads(value) if isinstance(value, str) else value
    if not isinstance(result, dict):
        raise AzureVmPowerRefused("VM_POWER_REGISTRY_UNAVAILABLE")
    return result


def _target(binding: dict) -> AzureVmPowerTarget:
    host = binding.get("host")
    if not isinstance(host, dict) or set(host) != {
        "installation",
        "identityResourceId",
        "principalId",
        "location",
    }:
        raise AzureVmPowerRefused("VM_POWER_INSTALLATION_UNAVAILABLE")
    installation = AzureVmInstallation.model_validate(host["installation"])
    return AzureVmPowerTarget(
        installation=installation,
        identity_resource_id=host["identityResourceId"],
        principal_id=host["principalId"],
        location=host["location"],
        binding_tags={
            "husshPod": installation.hushh_id,
            "husshPodGeneration": installation.generation,
            "husshPodImage": installation.image_digest,
        },
    )


async def _locked_row(connection: Any, owner: str) -> dict:
    await connection.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,171))", owner)
    await connection.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,198))", owner)
    row = await connection.fetchval(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=$1 FOR UPDATE", owner
    )
    return _object(row)


async def _guards_ready(connection: Any) -> bool:
    return (
        await connection.fetchval(
            """SELECT count(*)=6 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
        AND ((tgrelid='public.personal_agent_registry'::regclass
          AND tgname='zw_azure_vm_power'
          AND tgfoid='public.guard_azure_vm_power_registry()'::regprocedure AND tgtype=31)
        OR (tgrelid IN ('public.personal_agent_standby_placements'::regclass,
            'public.byoc_setup_jobs'::regclass,'public.pod_migration_jobs'::regclass)
          AND tgname IN ('zw_azure_vm_power_standby','zv_azure_vm_power')
          AND tgfoid='public.guard_azure_vm_power_standby()'::regprocedure AND tgtype=31)
        OR (tgrelid IN ('public.personal_agent_deletion_tombstones'::regclass,
            'public.account_deletion_tombstones'::regclass)
          AND tgname='zv_azure_vm_power'
          AND tgfoid='public.guard_azure_vm_power_deletion()'::regprocedure AND tgtype=31))"""
        )
        is True
    )


class AzureVmPowerAuthority:
    """One dedicated owner-worker session; all sync provider callbacks are joined."""

    def __init__(self, connection: Any, *, owner: str, state: dict) -> None:
        self._connection, self._owner = connection, owner
        operation = state.get("operationId")
        if not isinstance(operation, str):
            raise AzureVmPowerRefused("VM_POWER_OPERATION_UNAVAILABLE")
        self._operation = operation
        self._binding = state["binding"]
        self._loop, self._serial = asyncio.get_running_loop(), asyncio.Lock()
        self.target = _target(self._binding)

    @property
    def operation_id(self) -> str:
        return self._operation

    @property
    def binding(self) -> dict:
        return deepcopy(self._binding)

    async def _current(self) -> dict:
        row = await _locked_row(self._connection, self._owner)
        state = (row.get("backend_metadata") or {}).get("vmPower")
        held = await self._connection.fetchval(
            "SELECT public.byoc_azure_worker_session_held($1)", self._owner
        )
        binding = _object(
            await self._connection.fetchval(
                "SELECT public.azure_vm_power_binding($1::jsonb)", json.dumps(row)
            )
        )
        if (
            held is not True
            or not await _guards_ready(self._connection)
            or not isinstance(state, dict)
            or state.get("operationId") != self._operation
            or state.get("binding") != self._binding
            or binding != self._binding
            or await self._connection.fetchval(
                "SELECT public.azure_vm_power_eligible($1::jsonb)", json.dumps(row)
            )
            is not True
        ):
            raise AzureVmPowerRefused("VM_POWER_OPERATION_CHANGED")
        return state

    async def read(self) -> dict:
        async with self._serial, self._connection.transaction():
            return await self._current()

    def require_operation(self) -> None:
        asyncio.run_coroutine_threadsafe(self.read(), self._loop).result(30)

    def read_from_thread(self) -> dict:
        return asyncio.run_coroutine_threadsafe(self.read(), self._loop).result(30)

    def advance_from_thread(self, phase: str) -> dict:
        return asyncio.run_coroutine_threadsafe(self.advance(phase), self._loop).result(30)

    async def _replace(self, previous: dict, updated: dict) -> None:
        value = await self._connection.fetchval(
            """UPDATE personal_agent_registry SET backend_metadata=jsonb_set(
              backend_metadata,'{vmPower}',$3::jsonb),updated_at=clock_timestamp()
            WHERE user_id=$1 AND backend_metadata->'vmPower'=$2::jsonb
            RETURNING backend_metadata->'vmPower'""",
            self._owner,
            json.dumps(previous),
            json.dumps(updated),
        )
        if value is None:
            raise AzureVmPowerRefused("VM_POWER_RECEIPT_UNCONFIRMED")

    async def retain(self, event: dict) -> bool:
        async with self._serial, self._connection.transaction():
            state = await self._current()
            if event in state["events"]:
                return True  # exact acknowledgement after response loss
            await self._replace(state, {**state, "events": [*state["events"], event]})
            return True

    async def advance(self, phase: str) -> dict:
        async with self._serial, self._connection.transaction():
            state = await self._current()
            if state["phase"] != phase:
                updated = {**state, "phase": phase}
                await self._replace(state, updated)
                state = updated
            return state

    def record_from_thread(self, event: dict) -> bool:
        return asyncio.run_coroutine_threadsafe(self.retain(event), self._loop).result(30)

    def admit(self, request_id: str, request: ArmMutationRequest) -> bool:
        if request.body_sha256 is not None:
            return False  # Power actions carry no body; never discard a requested commitment.
        return self.record_from_thread(
            {
                "kind": "request",
                "requestId": request_id,
                "method": request.method,
                "path": request.path,
                "apiVersion": request.api_version,
                "purpose": request.purpose,
            }
        )

    def acknowledge(self, request_id: str, receipt: ArmMutationAcknowledgement) -> bool:
        return self.record_from_thread(
            {
                "kind": "ack",
                "requestId": request_id,
                "status": receipt.status,
                "operationUrl": receipt.operation_url,
                "operationUrlSha256": receipt.operation_url_sha256,
                **({"operationKind": receipt.operation_kind} if receipt.operation_kind else {}),
            }
        )

    def terminal(self, request_id: str, outcome: ArmMutationOutcome) -> bool:
        return self.record_from_thread(
            {
                "kind": "terminal",
                "requestId": request_id,
                "outcome": outcome,
            }
        )


@asynccontextmanager
async def azure_vm_power_authority(
    *,
    owner: str,
    expected_vm_id: str,
    create_cycle: bool = True,
    connection_factory: Callable[[], AbstractAsyncContextManager[Any]] = dedicated_connection,
) -> AsyncIterator[AzureVmPowerAuthority]:
    """Coalesce the exact cycle; never replace an unresolved provider receipt."""
    async with connection_factory() as connection:
        acquired = False
        try:
            async with connection.transaction():
                row = await _locked_row(connection, owner)
                if (
                    not await _guards_ready(connection)
                    or await connection.fetchval(
                        "SELECT public.azure_vm_power_eligible($1::jsonb)", json.dumps(row)
                    )
                    is not True
                ):
                    raise AzureVmPowerRefused("VM_POWER_INSTALLATION_UNAVAILABLE")
                binding = _object(
                    await connection.fetchval(
                        "SELECT public.azure_vm_power_binding($1::jsonb)", json.dumps(row)
                    )
                )
                if _target(binding).installation.vm_id != expected_vm_id:
                    raise AzureVmPowerRefused("VM_POWER_IDENTITY_CHANGED")
                acquired = (
                    await connection.fetchval(
                        "SELECT pg_try_advisory_lock(hashtextextended($1,206))", owner
                    )
                    is True
                )
                if not acquired:
                    raise AzureVmPowerRefused("VM_POWER_WORKER_ACTIVE")
                state = row["backend_metadata"].get("vmPower")
                if state is None and not create_cycle:
                    raise AzureVmPowerRefused("VM_POWER_RECOVERY_RECEIPT_REQUIRED")
                if create_cycle and (state is None or state["phase"] == "ready"):
                    previous = state
                    state = {
                        "version": 1,
                        "operationId": uuid4().hex,
                        "binding": binding,
                        "phase": "preparing",
                        "events": [],
                        **({"previousOperationId": previous["operationId"]} if previous else {}),
                    }
                    await connection.execute(
                        """UPDATE personal_agent_registry SET backend_metadata=jsonb_set(
                          backend_metadata,'{vmPower}',$2::jsonb),updated_at=clock_timestamp()
                        WHERE user_id=$1""",
                        owner,
                        json.dumps(state),
                    )
                authority = AzureVmPowerAuthority(connection, owner=owner, state=state)
            # Provider thread must be joined before this session/lease is released.
            yield authority
        finally:
            if acquired:
                await connection.execute(
                    "SELECT pg_advisory_unlock(hashtextextended($1,206))", owner
                )
