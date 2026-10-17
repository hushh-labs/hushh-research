"""Bounded hash-chain verification for the pod's existing recovery log.

Storage, encryption and erasure admission remain with PodCommitLog. This reader
has explicit ports and never publishes a partial batch or changes durable state.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


class PodLogTampered(RuntimeError):
    """The chain does not verify: altered, truncated, or reordered history."""


class PodLogConflict(RuntimeError):
    """A conditional write or bounded recovery could not complete."""


@dataclass(frozen=True)
class PodLogCursor:
    """Anchor returned by verified replay; retain all three fields together."""

    seq: int
    key: str
    sha: str


async def replay_chain(
    head: dict[str, Any] | None,
    *,
    read_record: Callable[[str], Awaitable[bytes | None]],
    unseal: Callable[[bytes], dict[str, Any]],
    record_sha: Callable[..., str],
    cursor: PodLogCursor | None = None,
    max_records: int | None = None,
    max_bytes: int | None = None,
    visit_reverse: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    if head is None:
        if cursor is not None:
            raise PodLogTampered("the log head moved behind the verified anchor")
        return []
    anchor_seq = cursor.seq if cursor else 0
    if head["seq"] < anchor_seq:
        raise PodLogTampered("the log head moved behind the verified anchor")
    if max_records is not None and head["seq"] - anchor_seq > max_records:
        raise PodLogConflict("the verified replay work limit was exceeded")

    records: list[dict[str, Any]] = []
    replay_bytes = 0
    key: str | None = head["key"]
    expected_sha: str | None = head["sha"]
    expected_seq = head["seq"]
    while key is not None and expected_seq > anchor_seq:
        blob = await read_record(key)
        if blob is None:
            raise PodLogTampered(f"the chain references a missing record: {key}")
        replay_bytes += len(blob)
        if max_bytes is not None and replay_bytes > max_bytes:
            raise PodLogConflict("the verified replay byte limit was exceeded")
        record = unseal(blob)
        if (
            not isinstance(record, dict)
            or type(record.get("seq")) is not int
            or record["seq"] != expected_seq
        ):
            raise PodLogTampered("the log head and record sequence disagree")
        expected_seq -= 1
        recomputed = record_sha(
            record["seq"], record["kind"], record["payload"], record.get("prev_sha")
        )
        if recomputed != record.get("sha") or recomputed != expected_sha:
            raise PodLogTampered(f"hash chain broke at seq {record.get('seq')}")
        if visit_reverse is None:
            records.append(record)
        else:
            visit_reverse(record)
        key = record.get("prev_key")
        expected_sha = record.get("prev_sha")
    records.reverse()
    # Each record was checked against the descending expected sequence above.
    if expected_seq != anchor_seq:
        raise PodLogTampered("the chain's sequence numbers are not contiguous")
    if cursor is not None:
        if key != cursor.key or expected_sha != cursor.sha:
            raise PodLogTampered("the chain does not meet the verified anchor")
    elif key is not None or expected_sha is not None:
        raise PodLogTampered("the chain has an invalid origin")
    return records
