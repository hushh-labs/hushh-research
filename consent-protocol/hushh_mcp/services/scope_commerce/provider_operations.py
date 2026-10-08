"""Durable provider operations: commit intent, recover before retry, bind once."""

from __future__ import annotations

import json
from collections.abc import Awaitable
from datetime import timedelta
from typing import Any, Callable

from .provider_contracts import ProviderContext, _opaque, _operation_id, _projection
from .stripe_adapter import CommerceProviderError

_RECOVERY_WINDOW = timedelta(hours=23)


class DurableOperationRunner(ProviderContext):
    async def _run_operation(
        self,
        *,
        user_id: str | None,
        operation_id: str,
        kind: str,
        request: dict[str, Any],
        validate: Callable[[dict[str, Any]], None],
        before_create: Callable[[], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        operation_id = _operation_id(operation_id)
        encoded = json.dumps(request, sort_keys=True, separators=(",", ":"))
        digest = _opaque(encoded)
        if before_create is not None:
            existing = await self._existing_operation(operation_id)
            if existing is None or existing["status"] == "prepared":
                # A proven no-I/O rejection creates no provider retry window.
                await before_create()

        async def claim(connection: Any) -> dict[str, Any]:
            return await self._claim_durable_operation(
                connection,
                operation_id=operation_id,
                user_id=user_id,
                kind=kind,
                digest=digest,
                encoded=encoded,
            )

        operation = await self.store._transaction(claim)
        if operation["status"] == "succeeded":
            response = operation["provider_response"]
            response = json.loads(response) if isinstance(response, str) else dict(response)
            validate(response)
            return response
        response = None
        try:
            if operation["status"] != "prepared":
                response = await self.adapter.recover(
                    kind, operation_id, request, created=int(operation["created_at"].timestamp())
                )
            if response is None:
                if operation["server_now"] - operation["created_at"] >= _RECOVERY_WINDOW:
                    raise CommerceProviderError("provider_reconciliation_required")
                if before_create is not None and operation["status"] != "prepared":
                    await before_create()
                response = await self.adapter.create(
                    kind, request, idempotency_key=f"scope-commerce-{kind}-{operation_id}"
                )
            validate(response)
        except Exception:

            async def uncertain(connection: Any) -> None:
                await connection.execute(
                    """UPDATE scope_commerce_provider_operations SET status='reconciliation_required',
                    lease_until=NULL,updated_at=clock_timestamp()
                    WHERE operation_id=$1::uuid AND status<>'succeeded'""",
                    operation_id,
                )

            await self.store._transaction(uncertain)
            raise CommerceProviderError("provider_reconciliation_required") from None

        persisted = _projection(kind, response)

        async def complete(connection: Any) -> None:
            await connection.execute(
                """UPDATE scope_commerce_provider_operations SET status='succeeded',provider_id=$2,
                provider_response=$3::jsonb,lease_until=NULL,updated_at=clock_timestamp()
                WHERE operation_id=$1::uuid AND request_hash=$4""",
                operation_id,
                response.get("id"),
                json.dumps(persisted),
                digest,
            )

        await self.store._transaction(complete)
        return persisted

    async def _claim_durable_operation(
        self,
        connection: Any,
        *,
        operation_id: str,
        user_id: str | None,
        kind: str,
        digest: str,
        encoded: str,
    ) -> dict[str, Any]:
        await connection.execute(
            """INSERT INTO scope_commerce_provider_operations
            (operation_id,user_id,kind,request_hash,request_json,status)
            VALUES($1::uuid,$2,$3,$4,$5::jsonb,'prepared') ON CONFLICT DO NOTHING""",
            operation_id,
            user_id,
            kind,
            digest,
            encoded,
        )
        row = dict(
            await connection.fetchrow(
                """SELECT *,clock_timestamp() AS server_now FROM scope_commerce_provider_operations
            WHERE operation_id=$1::uuid FOR UPDATE""",
                operation_id,
            )
        )
        if row["user_id"] != user_id or row["kind"] != kind or row["request_hash"] != digest:
            raise CommerceProviderError("provider_operation_conflict")
        if row["status"] == "succeeded":
            return row
        if row["lease_until"] is not None and row["lease_until"] > row["server_now"]:
            raise CommerceProviderError("provider_operation_pending")
        await connection.execute(
            """UPDATE scope_commerce_provider_operations SET status='submitted',
            lease_until=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
            WHERE operation_id=$1::uuid""",
            operation_id,
        )
        if kind == "refund":
            await self.store.mark_obligation_dispatch_started(
                obligation_id=operation_id, conn=connection
            )
        return row
