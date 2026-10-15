"""Dedicated-session adapter for the existing owner erasure operation.

Callers must join their actual cloud worker before leaving this context. Tokens
stay in that worker's memory. This adapter retains only the approved resource
identities and bounded provider receipts, never credential or resource bodies.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from copy import deepcopy
from typing import Any

from db.connection import dedicated_connection
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused, TeardownResource
from hushh_mcp.services.azure_teardown_receipts import prepare_stage


class AzureTeardownAuthority:
    def __init__(self, connection: Any, *, owner: str, attempt: str, execution: str) -> None:
        self._connection, self._owner = connection, owner
        self._attempt, self._execution = attempt, execution
        self._loop = asyncio.get_running_loop()
        self._serial = asyncio.Lock()
        self._state: dict = {}

    async def load(self) -> dict:
        raw = await self._connection.fetchval(
            "SELECT backend_metadata->'erasure' FROM public.personal_agent_registry "
            "WHERE user_id=$1 AND status='suspended'",
            self._owner,
        )
        current = json.loads(raw) if isinstance(raw, str) else raw
        state = current.get("azureTeardown") if isinstance(current, dict) else None
        if (
            not isinstance(state, dict)
            or current.get("attemptId") != self._attempt
            or state.get("worker", {}).get("executionId") != self._execution
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_WORKER_UNCONFIRMED")
        self._state = state
        return current

    def state(self, resource: TeardownResource) -> dict | None:
        return deepcopy(self._state.get("resources", {}).get(resource.path))

    def _wait(self, operation):
        return asyncio.run_coroutine_threadsafe(operation, self._loop).result(30)

    async def _assert_admitted(self) -> None:
        admitted = await self._connection.fetchval(
            "SELECT public.assert_azure_erasure_worker($1,$2,$3)",
            self._owner,
            self._attempt,
            self._execution,
        )
        if admitted is not True:
            raise AzureTeardownRefused("AZURE_CLEANUP_AUTHORIZATION_EXPIRED")

    def assert_admitted(self) -> None:
        self._wait(self._assert_admitted())

    def assert_parent_approved(self, resource: TeardownResource) -> None:
        """Require explicit whole-parent approval, not a claim about every child's origin."""
        self.assert_admitted()
        selected = self._state.get("plan", {}).get("resources", {}).get(resource.path, {})
        if (
            selected.get("deletionScope") not in {"all_contents", "whole_group"}
            or selected.get("kind") != resource.kind
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_CONTENTS_NOT_APPROVED")

    def assert_group_approved(self) -> None:
        # The executor also requires an EMPTY complete group listing immediately
        # before removal. Ordinary parent approval never authorizes unknown peers.
        self.assert_admitted()
        group = self._state.get("plan", {}).get("context", {})
        path = f"/subscriptions/{group.get('subscriptionId')}/resourceGroups/{group.get('resourceGroup')}"
        if (
            self._state.get("plan", {}).get("resources", {}).get(path, {}).get("deletionScope")
            != "whole_group"
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_GROUP_NOT_APPROVED")

    async def _retain(self, resource: TeardownResource, stage: str, receipt: dict) -> bool:
        async with self._serial:
            current = await self.load()
            candidate = deepcopy(self._state)
            candidate["resources"][resource.path] = prepare_stage(
                candidate["resources"].get(resource.path, {}), stage, receipt
            )
            if candidate == self._state:
                return True
            retained = await self._connection.fetchval(
                "SELECT public.retain_azure_erasure_state($1,$2,$3::jsonb,$4::jsonb)",
                self._owner,
                self._attempt,
                json.dumps(current),
                json.dumps(candidate),
            )
            if retained is not True:
                return False
            await self.load()
            return self._state == candidate

    def retain(self, resource: TeardownResource, stage: str, receipt: dict) -> bool:
        return self._wait(self._retain(resource, stage, receipt))


@asynccontextmanager
async def azure_teardown_authority(
    *,
    owner: str,
    attempt: str,
    connection_factory: Callable[[], AbstractAsyncContextManager[Any]] = dedicated_connection,
) -> AsyncIterator[AzureTeardownAuthority]:
    async with connection_factory() as connection:
        execution = str(uuid.uuid4())
        admitted = await connection.fetchval(
            "SELECT public.begin_azure_erasure_worker($1,$2,$3)", owner, attempt, execution
        )
        if admitted is not True:
            raise AzureTeardownRefused("AZURE_CLEANUP_WORKER_UNAVAILABLE")
        authority = AzureTeardownAuthority(
            connection, owner=owner, attempt=attempt, execution=execution
        )
        await authority.load()
        yield authority
