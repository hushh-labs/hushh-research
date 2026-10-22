"""What one standby sync can end as, and the checks the hub runs on what pods tell it.

Design: ``docs/future/personal-agent/STANDBY-SYNC.md`` (E4, E7, E8). Split from
``pod_standby_sync`` so the sequencing reads on its own; nothing here performs I/O.

Every check compares coordinates the pods published about THEMSELVES (head sequence,
head hash, key ids, role, epoch) with what the hub recorded about them. None needs a
key: the hub never opens a range, so "equal heads" is the whole proof (E7).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any, Optional

STATUS_SYNCED = "synced"
STATUS_FAILED = "failed"
STATUS_DIVERGED = "diverged"
#: Nothing was attempted (no standby, another sync holds the lease, a switch moved on).
STATUS_SKIPPED = "skipped"

#: Why a sync ended as it did. The status says what was recorded; the reason says why.
REASONS: dict[str, str] = {
    "equal_heads": STATUS_SYNCED,
    "imported": STATUS_SYNCED,
    "no_standby": STATUS_SKIPPED,
    "busy": STATUS_SKIPPED,
    "store_unavailable": STATUS_SKIPPED,
    "primary_not_ready": STATUS_FAILED,
    "hub_identity_unavailable": STATUS_FAILED,
    "unreachable_primary": STATUS_FAILED,
    "unreachable_standby": STATUS_FAILED,
    "refused_primary": STATUS_FAILED,
    "refused_standby": STATUS_FAILED,
    "invalid_response_primary": STATUS_FAILED,
    "invalid_response_standby": STATUS_FAILED,
    "identity_mismatch_primary": STATUS_FAILED,
    "identity_mismatch_standby": STATUS_FAILED,
    "role_mismatch_primary": STATUS_FAILED,
    "role_mismatch_standby": STATUS_FAILED,
    "stale_epoch_primary": STATUS_FAILED,
    "stale_epoch_standby": STATUS_FAILED,
    "refused_bundle": STATUS_FAILED,
    "import_conflict": STATUS_FAILED,
    "head_mismatch": STATUS_FAILED,
    "record_refused": STATUS_FAILED,
    "internal_error": STATUS_FAILED,
    "refused_fork": STATUS_DIVERGED,
}

_CHAIN_SHA = re.compile(r"^[0-9a-f]{64}$")
_ROLES = frozenset({"primary", "standby"})
_SERVER_UNAVAILABLE = frozenset({"POD_REFUSED_502", "POD_REFUSED_503", "POD_REFUSED_504"})


@dataclass(frozen=True)
class StandbySyncOutcome:
    """The typed result of one sync attempt. Carries no key, record or URL."""

    status: str
    reason: str
    synced_seq: Optional[int] = None
    synced_head_sha: Optional[str] = None
    records_transferred: int = 0
    #: True only when the store accepted this result (and released the lease).
    recorded: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def outcome(reason: str, **fields: Any) -> StandbySyncOutcome:
    """An outcome whose status is the one its reason implies."""
    return StandbySyncOutcome(status=REASONS[reason], reason=reason, **fields)


class SyncStop(Exception):
    """Ends a sync early with a typed outcome. Internal control flow, never surfaced."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Head:
    """A pod's own statement of where its log stands."""

    seq: int
    sha: str

    @property
    def store_sha(self) -> Optional[str]:
        """The store's form: an empty log has no head hash."""
        return self.sha or None


def parse_head(seq: Any, sha: Any, side: str) -> Head:
    """A valid (sequence, hash) pair, or a stop. ``""`` exactly when the sequence is 0."""
    if type(seq) is not int or seq < 0 or not isinstance(sha, str):
        raise SyncStop(f"invalid_response_{side}")
    if (seq == 0) != (sha == "") or (seq and not _CHAIN_SHA.match(sha)):
        raise SyncStop(f"invalid_response_{side}")
    return Head(seq, sha)


def check_pod_head(
    body: Mapping[str, Any], *, side: str, expected: Mapping[str, Any], placement_epoch: int
) -> Head:
    """Validate a ``/pod/sync/head`` answer against the placement the hub recorded.

    ``side`` is ``primary`` or ``standby`` (the role the pod must report). The pod's
    key ids must be the recorded ones, so the hub never ferries to or from a pod it did
    not record; its epoch may not be below the registry's (E4: only "below" is stale).
    """
    head = parse_head(body.get("head_seq"), body.get("head_sha"), side)
    role, epoch = body.get("role"), body.get("epoch")
    if role not in _ROLES or type(epoch) is not int or epoch < 0:
        raise SyncStop(f"invalid_response_{side}")
    if (
        not expected.get("pod_key_id")
        or body.get("pod_key_id") != expected.get("pod_key_id")
        or not expected.get("pod_signing_key_id")
        or body.get("pod_signing_key_id") != expected.get("pod_signing_key_id")
    ):
        raise SyncStop(f"identity_mismatch_{side}")
    if role != side:
        raise SyncStop(f"role_mismatch_{side}")
    if epoch < placement_epoch:
        raise SyncStop(f"stale_epoch_{side}")
    return head


def heads_prove_fork(primary: Head, standby: Head) -> bool:
    """True when the heads alone prove the standby is not a prefix of the primary.

    A standby ahead of its primary, or level with it on another hash, can never be
    brought level by appending; only a range after a SHORTER standby head can.
    """
    return standby.seq > primary.seq or (standby.seq == primary.seq and standby != primary)


def transport_reason(code: str, side: str) -> str:
    """Classify a transport failure without reading any refused body."""
    if code == "HUB_IDENTITY_UNAVAILABLE":
        return "hub_identity_unavailable"
    if code == "POD_UNREACHABLE" or code in _SERVER_UNAVAILABLE:
        return f"unreachable_{side}"
    if code == "POD_RESPONSE_INVALID":
        return f"invalid_response_{side}"
    return f"refused_{side}"


def check_range_coordinates(bundle: Mapping[str, Any], base: Head, head: Head) -> None:
    """The range's PLAIN coordinates must span exactly base -> the primary's head.

    Read without a key (the ciphertext stays sealed to the standby); the standby
    re-checks all of it under the primary's signature before any append (E5, E8).
    """
    if (
        bundle.get("baseSeq") != base.seq
        or bundle.get("baseHeadSha") != base.sha
        or bundle.get("headSeq") != head.seq
        or bundle.get("headSha") != head.sha
    ):
        raise SyncStop("head_mismatch")


__all__ = [
    "REASONS",
    "STATUS_DIVERGED",
    "STATUS_FAILED",
    "STATUS_SKIPPED",
    "STATUS_SYNCED",
    "Head",
    "StandbySyncOutcome",
    "SyncStop",
    "check_pod_head",
    "check_range_coordinates",
    "heads_prove_fork",
    "outcome",
    "parse_head",
    "transport_reason",
]
