"""Log-backed PKM for the pod: SQLite is the index, the sealed commit log is the truth.

Composition, not invention: this wraps the oracle-conformant
:class:`SqlitePkmWriteEngine` and appends every SUCCESSFUL mutating operation to
the :class:`PodCommitLog` -- after the engine committed, so the log never
records an operation the store refused (a conflict, a binding mismatch), and
idempotent replays are never logged twice.

``rebuild`` is the durability story on an ephemeral-disk platform: kill the
SQLite file, replay the log through a fresh engine, and the store is back --
same ciphertext, same revisions, same commit ids. The engine's own idempotency
ledger makes replay safe even against a partially-surviving database.

This class satisfies the ``PkmWriteEngine`` Protocol, so everything that speaks
to the seam (the service, the oracle) can run against it unchanged.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.pkm_sqlite_engine import SqlitePkmWriteEngine
from hushh_mcp.services.pod_commit_log import PodCommitLog

_KIND_BY_OP = {
    "commit_domain_mutation": "pkm_commit",
    "merge_domain_summary": "pkm_merge_summary",
    "delete_domain": "pkm_delete",
    "delete_domain_legacy": "pkm_delete_legacy",
}


def _plain_params(params: dict[str, Any]) -> dict[str, Any]:
    """JSON-ready copy of the stored-procedure params (JsonParam wrappers unwrapped)."""
    return {key: getattr(value, "value", value) for key, value in params.items()}


def _applied(op: str, result: Any) -> bool:
    """Did this operation change state? Only then does it belong in the log.

    Dict results carry the stored-procedure shape (conflict / idempotent_replay /
    success / deleted). Non-dict results (merge returns True, legacy delete
    returns a boolean) are applied exactly when truthy -- the first cut got this
    wrong and silently dropped every summary merge from the log, which the
    rebuild test caught as a summary that did not survive.
    """
    if isinstance(result, dict):
        if result.get("conflict"):
            return False
        if op == "commit_domain_mutation" and result.get("idempotent_replay"):
            return False
        return bool(result.get("success") or result.get("deleted"))
    return bool(result)


class PodPkmStore:
    """The pod's PKM data plane: oracle-conformant engine + durable log."""

    engine_id = "sqlite+log"

    def __init__(self, engine: SqlitePkmWriteEngine, log: PodCommitLog) -> None:
        self._engine = engine
        self._log = log

    # -- mutations: engine first, then the log ---------------------------------------

    async def _mutate(self, op: str, params: dict[str, Any]) -> Any:
        result = await getattr(self._engine, op)(params)
        if _applied(op, result):
            # Engine first, log second: the log records what HAPPENED. The
            # opposite order would let a crashed process replay an operation the
            # store never accepted. If the append itself fails the caller sees
            # the error with the engine already committed -- the same "row stays
            # visibly ahead for reconcile" posture the hub takes, and the next
            # rebuild reconverges via the engine's idempotency ledger.
            await self._log.append(_KIND_BY_OP[op], _plain_params(params))
        return result

    async def commit_domain_mutation(self, params: dict[str, Any]) -> Any:
        return await self._mutate("commit_domain_mutation", params)

    async def merge_domain_summary(self, params: dict[str, Any]) -> Any:
        return await self._mutate("merge_domain_summary", params)

    async def delete_domain(self, params: dict[str, Any]) -> Any:
        return await self._mutate("delete_domain", params)

    async def delete_domain_legacy(self, params: dict[str, Any]) -> Any:
        return await self._mutate("delete_domain_legacy", params)

    # -- reads: straight through ------------------------------------------------------

    async def get_domain_snapshot(self, params: dict[str, Any]) -> Any:
        return await self._engine.get_domain_snapshot(params)

    # -- durability -------------------------------------------------------------------

    @classmethod
    async def rebuild(cls, log: PodCommitLog, sqlite_path: str) -> "PodPkmStore":
        """Reconstruct the SQLite index from the log. The log IS the record.

        Chain verification happens inside ``replay`` -- a tampered log refuses to
        rebuild rather than materializing altered history.
        """
        engine = SqlitePkmWriteEngine(sqlite_path)
        op_by_kind = {kind: op for op, kind in _KIND_BY_OP.items()}
        for record in await log.replay():
            op = op_by_kind.get(record["kind"])
            if op is None:
                continue  # other subsystems' records (memory, storage pointers)
            await getattr(engine, op)(record["payload"])
        return cls(engine, log)
