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

import logging
from typing import Any

from hushh_mcp.services.pkm_sqlite_engine import SqlitePkmWriteEngine
from hushh_mcp.services.pod_commit_log import PodCommitLog

logger = logging.getLogger(__name__)

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
    async def rebuild(
        cls, log: PodCommitLog, sqlite_path: str, *, owner_user_id: str
    ) -> "PodPkmStore":
        """Reconstruct the SQLite index from the log, for ONE owner. The log IS the record.

        Chain verification happens inside ``replay`` -- a tampered log refuses to
        rebuild rather than materializing altered history.

        ``owner_user_id`` is REQUIRED, and required is the point. This replayed every
        record and dispatched on ``kind`` alone, with no check that the payload
        belonged to this pod's owner -- while ``CommitLogPodStorage.restore``, reading
        the SAME log, does filter on ``hushh_id``. Two consumers of one log, one
        filtering and one not, is the shape a leak hides in.

        It was dormant because pod-unique keys and prefixes meant a log only ever held
        one owner's records, so configuration was standing in for a guard. That is
        exactly the positional-rather-than-cryptographic defence the north star moves
        away from, and it gets weaker rather than stronger as pods become persistent
        and deployable into projects hussh does not own -- where the bucket layout is
        somebody else's decision. A shared bucket plus a shared log key would have let
        one pod rebuild another person's entire PKM into its own index.

        Making the parameter required rather than optional is deliberate: a rebuild
        that does not know whose index it is building is not a rebuild anyone should
        be able to ask for by accident.
        """
        engine = SqlitePkmWriteEngine(sqlite_path)
        op_by_kind = {kind: op for op, kind in _KIND_BY_OP.items()}
        skipped_foreign = 0
        for record in await log.replay():
            op = op_by_kind.get(record["kind"])
            if op is None:
                continue  # other subsystems' records (memory, storage pointers)
            payload = record["payload"]
            if str(payload.get("p_user_id") or "") != owner_user_id:
                # Counted, not silently dropped: a foreign record in this log means
                # either a shared store or a recycled pod, and both are worth seeing.
                skipped_foreign += 1
                continue
            await getattr(engine, op)(payload)
        if skipped_foreign:
            logger.warning(
                "pod_pkm_store.rebuild_skipped_foreign_records count=%d", skipped_foreign
            )
        return cls(engine, log)
