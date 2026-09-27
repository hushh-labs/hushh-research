"""Sealed recovery acceleration for the existing ADK log projection.

The commit log remains authoritative. A checkpoint binds a verified cursor and
owner; replay must still join that cursor to the current unfenced log head.
"""

from dataclasses import asdict

from hushh_mcp.services.pod_commit_log import PodLogCursor, PodLogTampered

KEY = "projections/adk-sessions-v1.bin"
INTERVAL = 128


async def load(log, *, owner: str, hushh_id: str):
    await log.require_open()
    blob, generation = await log._store.get_with_generation(KEY)
    if blob is None:
        return None, [], generation
    if len(blob) > 33 * 1024 * 1024:
        raise PodLogTampered("Pod chat checkpoint exceeds its bound.")
    record = log._unseal(blob)
    if (
        set(record) != {"kind", "owner", "hushhId", "cursor", "entries"}
        or record["kind"] != KEY
        or record["owner"] != owner
        or record["hushhId"] != hushh_id
        or log._owner_id != hushh_id
        or not isinstance(record["cursor"], dict)
        or set(record["cursor"]) != {"seq", "key", "sha"}
        or not isinstance(record["entries"], list)
    ):
        raise PodLogTampered("Pod chat checkpoint binding invalid.")
    cursor = PodLogCursor(**record["cursor"])
    # Use the log's exact anchor validation, including rollback/divergence,
    # when the caller invokes replay_since before publishing any cache state.
    await log.require_open()
    return cursor, record["entries"], generation


async def save(log, *, owner: str, hushh_id: str, cursor, entries, generation: int):
    await log.require_open()
    blob = log._seal(
        {
            "kind": KEY,
            "owner": owner,
            "hushhId": hushh_id,
            "cursor": asdict(cursor),
            "entries": [[app, session, row] for (app, session), row in entries.items()],
        }
    )
    # A stale process never replaces a newer projection. Losing this cache CAS
    # cannot discard a log record; the next fresh process reads the winner.
    result = await log._store.put_if_generation(KEY, blob, generation)
    await log.require_open()
    return result
