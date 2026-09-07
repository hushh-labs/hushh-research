"""The pod's OWN personal knowledge model: local SQLite, rebuilt from its own log.

WHAT THIS CLOSES
----------------
``PodPkmStore`` has existed, been oracle-conformant, and been covered by tests
since it was written. It was also constructed **nowhere outside tests and one
simulation script**, so no running pod has ever used it. Meanwhile
``pod_turn`` grounds each turn from ``pkmContext``: a string, capped at 20,000
characters, computed by the hub from Postgres and pushed into the pod on every
single turn.

That is the thin-client shape the north star names as an acceptable transitional
step and never the destination: a pod that forwards to a central database is a
thin client with a local model. This module is the seam that lets a pod be
grounded by its own holdings instead.

THE ARCHITECTURE, RESTATED SO THE CODE MATCHES IT
-------------------------------------------------
    the sealed commit log   = the system of record (the pod's own bucket)
    local SQLite            = an INDEX, rebuilt from that log, disposable
    hushh                   = the control plane that connects the two, and the
                              authority for consent issuance and audit

Nothing here weakens the last line. The pod still holds no database credential,
still cannot issue consent, and still asks the hub to verify a token. What moves
is only where the pod's own PKM lives: in the pod, from the pod's own log.

WHY REBUILD-ON-BOOT IS THE RIGHT SHAPE HERE
-------------------------------------------
Cloud Run's filesystem is an in-memory tmpfs, so the SQLite file does not
survive a restart and its bytes count against the container's memory limit.
That sounds like a problem and is actually the design: the log is the truth, the
index is derived, and ``PodPkmStore.rebuild`` reconstructs it with the same
ciphertext, revisions and commit ids. An economy-tier pod scaled to zero
therefore rebuilds on its next cold start, which is exactly the durability story
the commit log was written to provide.

The honest cost: rebuild replays the whole log, so cold-start time grows with
history. That is measured rather than assumed (see ``rebuild_stats``), and when
it stops being acceptable the answer is a snapshot record in the log, not a
warm instance nobody is paying for.

ONE POD, ONE OWNER, ENFORCED
----------------------------
``PodPkmStore.rebuild`` already requires ``owner_user_id`` and filters records on
it, because a shared bucket plus a shared key would otherwise let one pod rebuild
another person's PKM into its own index. This resolver keeps that guarantee at
the layer above: it caches exactly one store, for exactly one owner, and a
request for a different owner is a loud refusal rather than a second rebuild.
A pod serves one person; being asked for a second is a fault, not a cache miss.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: Where the derived index lives. A tmpfs path on Cloud Run, which is correct:
#: the index is disposable and the log is the record.
_SQLITE_PATH_ENV = "POD_PKM_SQLITE_PATH"
# Both linters flag a hardcoded /tmp path, and here it is the correct one.
# Cloud Run's /tmp is a per-instance in-memory tmpfs, not a shared
# multi-tenant directory, so the symlink and predictable-name attacks
# CWE-377 describes have no second party to come from. The index is derived,
# disposable, and rebuilt from the sealed log; putting it on a durable disk
# would be the actual defect, since it would outlive the process that sealed it.
_DEFAULT_SQLITE_PATH = "/tmp/pod-pkm.sqlite3"  # noqa: S108  # nosec B108

#: Ships dark, like every other pod capability. Off means the hub keeps pushing
#: `pkmContext` exactly as it does today, so enabling this is a decision rather
#: than a side effect of deploying.
_ENABLED_ENV = "POD_LOCAL_PKM_ENABLED"


class PodPkmOwnerMismatch(RuntimeError):
    """This pod was asked for a different person's PKM than the one it serves."""


@dataclass(frozen=True)
class RebuildStats:
    """What the last rebuild actually cost. Reported, not estimated.

    Cold-start time grows with log length, and the only honest way to know when
    that stops being acceptable is to measure it every time rather than to
    reason about it once.
    """

    owner_user_id: str
    records_replayed: int
    duration_ms: int
    sqlite_path: str


_STORE: Optional[Any] = None
_OWNER: Optional[str] = None
_STATS: Optional[RebuildStats] = None


def local_pkm_enabled() -> bool:
    return str(os.getenv(_ENABLED_ENV) or "").strip().lower() in {"1", "true", "yes", "on"}


def sqlite_path() -> str:
    return str(os.getenv(_SQLITE_PATH_ENV) or "").strip() or _DEFAULT_SQLITE_PATH


def rebuild_stats() -> Optional[RebuildStats]:
    """What the last rebuild cost, or None if no rebuild has happened."""
    return _STATS


def reset_for_tests() -> None:
    """Drop the cached store. Test-only; a running pod never needs this."""
    global _STORE, _OWNER, _STATS
    _STORE = None
    _OWNER = None
    _STATS = None


async def resolve_pod_pkm_store(owner_user_id: str, *, log: Any = None) -> Optional[Any]:
    """This pod's local PKM store for its owner, or None when unavailable.

    Returns None (never raises) for every ordinary reason a pod cannot serve its
    own PKM: the flag is off, the pod has no durable log configured, or the log
    could not be read. The caller falls back to the hub's pushed context, which
    is the behaviour every pod has today, so a pod that cannot do this is exactly
    as capable as it was before rather than broken.

    It DOES raise on an owner mismatch, because that is not an ordinary reason.
    A pod serves one person; being asked for a second means either a recycled pod
    or a routing fault, and quietly rebuilding a different person's index is the
    one outcome that must never be reachable by accident.
    """
    global _STORE, _OWNER, _STATS

    owner = str(owner_user_id or "").strip()
    if not owner:
        return None
    if not local_pkm_enabled():
        return None

    if _STORE is not None:
        if _OWNER != owner:
            raise PodPkmOwnerMismatch(
                f"this pod serves {_OWNER!r} and was asked for {owner!r}'s PKM"
            )
        return _STORE

    commit_log = log
    if commit_log is None:
        try:
            from hushh_mcp.services.pod_storage import (  # noqa: PLC0415
                BACKEND_COMMIT_LOG,
                resolve_pod_storage,
            )

            storage = resolve_pod_storage()
            if getattr(storage, "backend_id", "") != BACKEND_COMMIT_LOG:
                # No durable log means there is nothing to rebuild an index FROM.
                # Not an error: a pod without durable storage has always been
                # grounded by the hub, and still is.
                logger.info("pod_pkm.no_durable_log -- local PKM unavailable, hub grounding stands")
                return None
            commit_log = getattr(storage, "_log", None)
        except Exception:  # noqa: BLE001 - an unreadable log must not break a turn
            logger.warning("pod_pkm.storage_unavailable", exc_info=True)
            return None
    if commit_log is None:
        return None

    started = time.monotonic()
    try:
        from hushh_mcp.services.pod_pkm_store import PodPkmStore  # noqa: PLC0415

        path = sqlite_path()
        store = await PodPkmStore.rebuild(commit_log, path, owner_user_id=owner)
    except Exception:  # noqa: BLE001 - a failed rebuild degrades to hub grounding
        # Deliberately loud in the log and quiet to the caller. A tampered log
        # raises here (chain verification lives inside `replay`), and refusing to
        # materialise altered history is the correct outcome -- but it must not
        # also take the person's turn down with it.
        logger.warning("pod_pkm.rebuild_failed owner=%s", owner, exc_info=True)
        return None

    duration_ms = int((time.monotonic() - started) * 1000)
    try:
        replayed = len(await commit_log.replay())
    except Exception:  # noqa: BLE001 - stats must never break the path they measure
        replayed = -1

    _STORE = store
    _OWNER = owner
    _STATS = RebuildStats(
        owner_user_id=owner,
        records_replayed=replayed,
        duration_ms=duration_ms,
        sqlite_path=path,
    )
    logger.info(
        "pod_pkm.rebuilt owner=%s records=%d duration_ms=%d path=%s",
        owner,
        replayed,
        duration_ms,
        path,
    )
    return store


#: The same ceiling the relay puts on `pkmContext`. Matched deliberately: the
#: pod's own grounding and the browser's pushed grounding land in the same
#: parameter, and a longer one from this path would be silently truncated
#: somewhere less obvious.
_GROUNDING_MAX_CHARS = 20000


async def local_grounding(owner_user_id: str, *, log: Any = None) -> Optional[str]:
    """Grounding built from THIS pod's own index, or None if it cannot be.

    Why this exists: `pkmContext` originates in the BROWSER and the hub only
    forwards it, so a turn with no browser attached arrives with no grounding at
    all. That is every background tick. A pod that can only be grounded by a
    person actively looking at it cannot do the between-conversation work the
    architecture promises.

    Reads the derived index read-only, by path, rather than reaching into the
    engine's internals or adding a method to an oracle-conformant class. The
    resolver already owns that path, so this is it reading its own file.

    Returns None on anything unexpected. Grounding is an enhancement to a turn,
    never a precondition for one.
    """
    store = await resolve_pod_pkm_store(owner_user_id, log=log)
    if store is None:
        return None

    import json  # noqa: PLC0415
    import sqlite3  # noqa: PLC0415

    path = sqlite_path()
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except Exception:  # noqa: BLE001 - no index file yet is not a fault
        return None
    try:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT available_domains, domain_summaries FROM pkm_index WHERE user_id=?",
            (owner_user_id,),
        ).fetchone()
    except Exception:  # noqa: BLE001
        logger.warning("pod_pkm.index_unreadable", exc_info=True)
        return None
    finally:
        conn.close()

    if row is None:
        return None
    try:
        domains = json.loads(row["available_domains"] or "[]")
        summaries = json.loads(row["domain_summaries"] or "{}")
    except Exception:  # noqa: BLE001
        return None

    lines: list[str] = []
    for domain in domains:
        summary = (summaries.get(domain) or {}).get("readable_summary")
        if summary:
            lines.append(f"{domain}: {summary}")
    if not lines:
        return None

    text = "\n".join(lines)
    if len(text) > _GROUNDING_MAX_CHARS:
        # Truncate at a line boundary and SAY so, rather than handing the model a
        # sentence that stops mid-word and reads as corrupted context.
        clipped: list[str] = []
        used = 0
        for line in lines:
            if used + len(line) + 1 > _GROUNDING_MAX_CHARS - 40:
                break
            clipped.append(line)
            used += len(line) + 1
        clipped.append("(earlier domains omitted for length)")
        text = "\n".join(clipped)
    return text


__all__ = [
    "PodPkmOwnerMismatch",
    "RebuildStats",
    "local_grounding",
    "local_pkm_enabled",
    "rebuild_stats",
    "reset_for_tests",
    "resolve_pod_pkm_store",
    "sqlite_path",
]
