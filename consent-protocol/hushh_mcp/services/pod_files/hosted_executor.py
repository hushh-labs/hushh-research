"""Dedicated PostgreSQL session for one managed Files upgrade executor.

The session is reserved and claims the existing upgrade lease before provider
work starts. It remains open until provider workers and their callbacks have
joined. A lost session leaves the durable start unresolved.
"""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from uuid import uuid4

from sqlalchemy import text

from . import hosted_executor_journal as _journal


class HostedFilesExecutorError(RuntimeError):
    """The hosted Files executor could not retain durable session evidence."""


class HostedFilesExecutor:
    def __init__(
        self, *, engine: Any, owner_id: str, execution_id: str, deployed_image: str
    ) -> None:
        self._engine = engine
        self.owner_id = owner_id
        self.execution_id = execution_id
        self.deployed_image = deployed_image
        self.lease: str | None = None
        self._connection = None
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="hosted-files-db")
        self._closed = False
        self._finished = False
        self._claim_sql: str | None = None
        self._claim_params: dict[str, Any] | None = None

    @classmethod
    async def claim(
        cls,
        *,
        database: Any,
        owner_id: str,
        observed: dict,
        target_image: str,
        operation_id: str,
        plan: dict,
        incarnation: str,
        deployed_image: str,
    ) -> HostedFilesExecutor:
        return await _claim_hosted_files_executor(
            cls,
            database=database,
            owner_id=owner_id,
            observed=observed,
            target_image=target_image,
            operation_id=operation_id,
            plan=plan,
            incarnation=incarnation,
            deployed_image=deployed_image,
        )

    @property
    def closed(self) -> bool:
        return self._closed

    async def confirm_claim(self) -> None:
        """Re-read the same claim on the same session without taking another lease."""
        lease = self._require_lease()
        if self._connection is None or self._claim_sql is None or self._claim_params is None:
            raise HostedFilesExecutorError("managed Files executor claim cannot be confirmed")

        def confirm() -> str | None:
            return _journal.confirm_claim(
                self._connection,
                sql=self._claim_sql,
                params=self._claim_params,
                sql_text=text,
            )

        try:
            if await self._call(confirm) != lease:
                raise HostedFilesExecutorError("managed Files executor claim changed during retry")
        except BaseException:
            # A failed confirmation makes session ownership uncertain. Discard the
            # dedicated backend and leave its durable witness unresolved.
            await self.close()
            raise

    async def session_identity(self) -> dict[str, Any]:
        """Read the SQL identity held by this executor session."""
        self._require_lease()
        if self._connection is None:
            raise HostedFilesExecutorError("managed Files executor session is unavailable")

        def read_identity() -> dict[str, Any]:
            return _journal.session_identity(self._connection, sql_text=text)

        return await self._call(read_identity)

    async def session_lock_held(self, witness: dict[str, Any]) -> bool:
        """Verify this original PostgreSQL session still owns its lock."""
        self._require_lease()
        if self._connection is None:
            raise HostedFilesExecutorError("managed Files executor session is unavailable")

        def check() -> bool:
            return _journal.session_lock_held(
                self._connection,
                owner_id=self.owner_id,
                witness=witness,
                sql_text=text,
                json_dumps=json.dumps,
            )

        return await self._call(check)

    @classmethod
    async def resume_claim(
        cls,
        *,
        database: Any,
        owner_id: str,
        observed: dict,
        lease: str,
        retry_checkpoint: dict,
        plan: dict,
        incarnation: str,
        deployed_image: str,
    ) -> tuple[HostedFilesExecutor, dict]:
        """Claim one previously denied queue retry with its session and row CAS."""
        return await _resume_hosted_files_executor(
            cls,
            database=database,
            owner_id=owner_id,
            observed=observed,
            lease=lease,
            retry_checkpoint=retry_checkpoint,
            plan=plan,
            incarnation=incarnation,
            deployed_image=deployed_image,
        )

    async def record_replacement_intent(
        self, *, operation_id: str, predecessor: dict[str, Any]
    ) -> None:
        lease = self._require_lease()

        def persist() -> bool:
            return _journal.record_replacement_intent(
                self._connection,
                owner_id=self.owner_id,
                execution_id=self.execution_id,
                lease=lease,
                operation_id=operation_id,
                predecessor=predecessor,
                sql_text=text,
                json_dumps=json.dumps,
            )

        if not await self._call(persist):
            raise HostedFilesExecutorError("managed Files replacement intent was not retained")

    async def record_provider_settlement(self, receipt: dict[str, Any]) -> None:
        """Bind a terminal Ready readback to this original executor session."""
        lease = self._require_lease()

        def persist() -> bool:
            return _journal.record_provider_settlement(
                self._connection,
                owner_id=self.owner_id,
                execution_id=self.execution_id,
                lease=lease,
                receipt=receipt,
                sql_text=text,
                json_dumps=json.dumps,
            )

        if not await self._call(persist):
            raise HostedFilesExecutorError("managed Files provider settlement was not retained")

    async def finish(self) -> None:
        if self._finished:
            return
        lease = self._require_lease()

        def persist_exit() -> bool:
            return _journal.finish_executor(
                self._connection,
                owner_id=self.owner_id,
                execution_id=self.execution_id,
                lease=lease,
                sql_text=text,
            )

        try:
            if not await self._call(persist_exit):
                raise HostedFilesExecutorError("managed Files executor exit was not retained")
            self._finished = True
        finally:
            await self.close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        connection = self._connection
        cancelled = False
        try:
            if connection is not None:

                def release_session() -> None:
                    if not self._finished:
                        # Advisory lock 206 is session-scoped. Returning a healthy
                        # connection to QueuePool would preserve it on a reusable
                        # backend and could strand unrelated work. An unresolved
                        # executor must physically discard its PostgreSQL session.
                        try:
                            connection.invalidate()
                        finally:
                            connection.close()
                    else:
                        connection.close()

                pending = asyncio.create_task(self._call(release_session))
                try:
                    await asyncio.shield(pending)
                except asyncio.CancelledError:
                    cancelled = True
                    try:
                        await asyncio.shield(pending)
                    except (asyncio.CancelledError, Exception):
                        pass
                except Exception:
                    # A lost session leaves its durable running witness unresolved.
                    pass
        finally:
            self._connection = None
            self._worker.shutdown(wait=True, cancel_futures=True)
        if cancelled:
            raise asyncio.CancelledError

    def _require_lease(self) -> str:
        if not isinstance(self.lease, str) or not self.lease or self._closed:
            raise HostedFilesExecutorError("managed Files executor session is unavailable")
        return self.lease

    async def _call(self, operation):
        loop = asyncio.get_running_loop()
        pending = loop.run_in_executor(self._worker, operation)
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            # Cancellation cannot abandon a SQL callback using the reserved
            # connection. Join it before propagating cancellation to the caller.
            try:
                await asyncio.shield(pending)
            except (asyncio.CancelledError, Exception):
                pass
            raise


async def _claim_hosted_files_executor(
    cls: type[HostedFilesExecutor],
    *,
    database: Any,
    owner_id: str,
    observed: dict,
    target_image: str,
    operation_id: str,
    plan: dict,
    incarnation: str,
    deployed_image: str,
) -> HostedFilesExecutor:
    from hushh_mcp.services.personal_agent_registry_repo import (
        _upgrade_snapshot_params,
        upgrade_host_snapshot,
    )

    snapshot = upgrade_host_snapshot(observed)
    if snapshot is None or snapshot.get("user_id") != owner_id:
        raise HostedFilesExecutorError("managed Files host snapshot is unavailable")
    params = _upgrade_snapshot_params(snapshot)
    engine = getattr(database, "engine", getattr(database, "_engine", None))
    if engine is None:
        raise HostedFilesExecutorError("dedicated database session is unavailable")
    execution = cls(
        engine=engine, owner_id=owner_id, execution_id=uuid4().hex, deployed_image=deployed_image
    )
    sql, call_params = _journal.claim_statement(
        snapshot_params=params,
        owner_id=owner_id,
        target_image=target_image,
        deployed_image=deployed_image,
        operation_id=operation_id,
        plan=plan,
        incarnation=incarnation,
        execution_id=execution.execution_id,
        json_dumps=json.dumps,
    )
    execution._claim_sql = sql
    execution._claim_params = call_params

    def reserve_and_claim() -> str | None:
        connection = execution._engine.connect()
        execution._connection = connection
        try:
            lease = _journal.claim_lease(connection, sql=sql, params=call_params, sql_text=text)
            if not isinstance(lease, str) or not lease:
                raise HostedFilesExecutorError("managed Files executor claim was refused")
            return lease
        except BaseException:
            try:
                # The statement may have committed and then lost its response.
                # Never return a possibly lock-owning backend to QueuePool.
                connection.invalidate()
            finally:
                connection.close()
            execution._connection = None
            raise

    try:
        execution.lease = await execution._call(reserve_and_claim)
        return execution
    except BaseException:
        await execution.close()
        raise


async def _resume_hosted_files_executor(
    cls: type[HostedFilesExecutor],
    *,
    database: Any,
    owner_id: str,
    observed: dict,
    lease: str,
    retry_checkpoint: dict,
    plan: dict,
    incarnation: str,
    deployed_image: str,
) -> tuple[HostedFilesExecutor, dict]:
    from hushh_mcp.services.personal_agent_registry_repo import (
        _upgrade_snapshot_params,
        upgrade_host_snapshot,
    )

    snapshot = upgrade_host_snapshot(observed)
    if snapshot is None or snapshot.get("user_id") != owner_id:
        raise HostedFilesExecutorError("managed Files retry host snapshot is unavailable")
    params = _upgrade_snapshot_params(snapshot)
    engine = getattr(database, "engine", getattr(database, "_engine", None))
    if engine is None:
        raise HostedFilesExecutorError("dedicated database session is unavailable")
    execution = cls(
        engine=engine, owner_id=owner_id, execution_id=uuid4().hex, deployed_image=deployed_image
    )
    sql, call_params = _journal.resume_statement(
        snapshot_params=params,
        owner_id=owner_id,
        lease=lease,
        retry_checkpoint=retry_checkpoint,
        plan=plan,
        incarnation=incarnation,
        deployed_image=deployed_image,
        execution_id=execution.execution_id,
        json_dumps=json.dumps,
    )

    def reserve_and_claim() -> dict | None:
        connection = execution._engine.connect()
        execution._connection = connection
        try:
            registry_row = _journal.resume_claim(
                connection, sql=sql, params=call_params, sql_text=text
            )
            if not isinstance(registry_row, dict):
                raise HostedFilesExecutorError("managed Files retry claim was refused")
            return registry_row
        except BaseException:
            try:
                # The statement may have committed and then lost its response.
                # Never return a possibly lock-owning backend to QueuePool.
                connection.invalidate()
            finally:
                connection.close()
            execution._connection = None
            raise

    execution._claim_sql = sql
    execution._claim_params = call_params
    try:
        registry_row = await execution._call(reserve_and_claim)
        execution.lease = lease
        return execution, registry_row
    except BaseException:
        await execution.close()
        raise
