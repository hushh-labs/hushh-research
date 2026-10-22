"""The PKM write engine seam: WHAT the data plane does, apart from WHERE it runs.

WHY THIS EXISTS. The PKM write path's business logic already lives in Python --
``personal_knowledge_model_service`` builds every row set (segments, manifest,
paths, scopes, events) before any database sees them. What the stored procedures
own is *atomicity and validation*: ``commit_pkm_domain_mutation_v4`` and its
siblings are transactional writers behind ``pg_advisory_xact_lock`` and an
optimistic-concurrency check. That coupling is what welds a user's PKM to the
hub's Postgres -- and the target architecture puts PKM **inside the user's pod**,
where there is no Postgres, no shared tenancy, and no reason for either.

This module names the operations so an implementation can change underneath
them:

* ``PostgresPkmWriteEngine`` -- delegates to today's stored procedures through
  the exact ``run_rpc`` callable the service already uses. Byte-identical
  behaviour; the hub keeps running on it unchanged.
* A pod-local engine (SQLite + object-store log) implements the same Protocol
  against a single-user store, where SQLite's one-writer WAL is strictly
  stronger than a per-``(user, domain)`` advisory lock.

SCOPE -- deliberately the five LIVE data-plane operations and nothing else:

  commit_domain_mutation   commit_pkm_domain_mutation_v4
  merge_domain_summary     merge_pkm_domain_summary
  get_domain_snapshot      get_pkm_domain_snapshot_v1
  delete_domain            delete_pkm_domain_v3
  delete_domain_legacy     delete_pkm_domain_v2 (pre-plan fallback)

NOT in the engine, on purpose:
* the **upgrade state machine** (``start_or_resume_pkm_upgrade_v1`` etc.) --
  fleet-side schema-evolution orchestration, a hub maintenance lane, never a pod
  runtime path;
* ``match_user_profiles`` -- a cross-user directory query; single-user engines
  cannot answer it by construction, and it belongs to the control plane;
* the legacy blob path (``upsert_pkm_data_blob``) and
  ``auto_register_domain`` -- pre-cutover lanes with their own probe/fallback
  machinery, retired with the data they serve.

The params contract is the stored procedures' parameter dicts, verbatim. That is
a deliberate S1 choice: the seam must be provably zero-behaviour-change, so it
does not invent a new vocabulary -- it names the existing calls. The conformance
oracle (S2) is written against THIS surface, which is what makes a second
implementation (S3) safe to trust.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from typing import Any, Optional, Protocol, runtime_checkable

# The service's ``_run_rpc`` shape: (function_name, params) -> raw rpc result.
RunRpc = Callable[[str, Optional[dict]], Awaitable[Any]]

PKM_WRITE_ENGINE_ENV = "PKM_WRITE_ENGINE"

ENGINE_POSTGRES = "postgres"
ENGINE_SQLITE = "sqlite"


@runtime_checkable
class PkmWriteEngine(Protocol):
    """The five live PKM data-plane operations, backend-agnostic."""

    engine_id: str

    async def commit_domain_mutation(self, params: dict[str, Any]) -> Any: ...

    async def merge_domain_summary(self, params: dict[str, Any]) -> Any: ...

    async def get_domain_snapshot(self, params: dict[str, Any]) -> Any: ...

    async def delete_domain(self, params: dict[str, Any]) -> Any: ...

    async def delete_domain_legacy(self, params: dict[str, Any]) -> Any: ...


class PostgresPkmWriteEngine:
    """Today's engine: the stored procedures, reached exactly as before.

    Constructed WITH the service's own ``_run_rpc`` so the transport (thread
    offload, client resolution, result envelopes) stays in one place and this
    class cannot drift from it.
    """

    engine_id = ENGINE_POSTGRES

    def __init__(self, run_rpc: RunRpc) -> None:
        self._run_rpc = run_rpc

    async def commit_domain_mutation(self, params: dict[str, Any]) -> Any:
        return await self._run_rpc("commit_pkm_domain_mutation_v4", params)

    async def merge_domain_summary(self, params: dict[str, Any]) -> Any:
        return await self._run_rpc("merge_pkm_domain_summary", params)

    async def get_domain_snapshot(self, params: dict[str, Any]) -> Any:
        return await self._run_rpc("get_pkm_domain_snapshot_v1", params)

    async def delete_domain(self, params: dict[str, Any]) -> Any:
        return await self._run_rpc("delete_pkm_domain_v3", params)

    async def delete_domain_legacy(self, params: dict[str, Any]) -> Any:
        return await self._run_rpc("delete_pkm_domain_v2", params)


def resolve_pkm_write_engine(run_rpc: RunRpc) -> PkmWriteEngine:
    """Select the engine. Unset/empty/postgres -> Postgres; unknown fails LOUD.

    The sqlite engine arrives with the pod-local store; naming it before then is
    an explicit error rather than a silent fallback, because "which engine holds
    the user's PKM" is never a question to answer by accident.
    """
    selected = (os.getenv(PKM_WRITE_ENGINE_ENV) or "").strip().lower()
    if selected in ("", ENGINE_POSTGRES):
        return PostgresPkmWriteEngine(run_rpc)
    if selected == ENGINE_SQLITE:
        from hushh_mcp.services.pkm_sqlite_engine import SqlitePkmWriteEngine

        return SqlitePkmWriteEngine.from_environment()
    raise NotImplementedError(f"PKM write engine {selected!r} is not wired")
