"""The hub's record of a person's synced standby agent (dev-only migration 950).

Design: ``docs/future/personal-agent/STANDBY-SYNC.md`` (E4, E8, E9, E10). The
registry row stays the PRIMARY's view; this store owns the one standby row a person
may have, its sync progress, and the switch that swaps the two.

Every write is ONE statement, fenced on what the caller observed:

- ``placement_epoch`` (the registry's, bumped by one on every promotion) fences every
  sync and the switch, so work planned against one placement can never land on the
  other after a switch;
- the standby's ``pod_key_id`` names WHICH standby a sync is for;
- the sync lease is single-flight, but advisory: it may be reclaimed after
  :data:`SYNC_LEASE_TTL_SECONDS` because the pod-side compare-and-swap on the log
  head is the real fence (E8).

What this module never holds: a private key, a token, a bundle or a record. The hub
ferries ciphertext it cannot open; nothing here imports or calls a decryption path
(asserted structurally in ``tests/test_personal_agent_standby_store_postgres.py``).
It names no provider: placement vocabulary comes from ``compute_backend``.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Mapping
from typing import Any, Optional

from db.db_client import get_db
from hushh_mcp.services import personal_agent_standby_sql as sql
from hushh_mcp.services.compute_backend import (
    BACKEND_GCP,
    OWNER_CLOUD_TARGETS,
    is_known_pod_target,
    is_owner_cloud_target,
    owner_cloud_coordinates_complete,
)
from hushh_mcp.services.pod_request_signing import is_signing_public_key, signing_key_id

#: A held lease is honoured this long; after it, another sweep may reclaim it.
SYNC_LEASE_TTL_SECONDS = 900
#: Upper bound on a caller's cooldown and on one sweep page.
MAX_COOLDOWN_SECONDS = 7 * 86_400
MAX_DUE_PAGE = 200
REMOVE_REASON_MAX = 200
SYNC_STATUSES = frozenset({"synced", "failed", "diverged"})

#: Placement fields a standby is created with. Everything else is refused.
PLACEMENT_FIELDS = (
    "deployment_target", "backend", "external_agent_id", "region", "model_credential_mode",
    "user_cloud_project", "user_cloud_region", "user_cloud_bootstrap_sa",
    "user_cloud_authorized_at", "user_cloud_tenant_id", "user_cloud_subscription_id",
    "user_cloud_resource_group", "url", "pod_pubkey", "pod_key_id", "pod_key_wrapping_alg",
    "pod_signing_pubkey", "pod_signing_key_id", "runtime_version", "prompt_version",
    "backend_metadata",
)  # fmt: skip
#: What a removed standby leaves behind under ``detachedPlacements`` (E10): where it
#: ran, never a key, key id or token.
DETACHED_COORDINATES = [
    "deployment_target", "backend", "external_agent_id", "region", "model_credential_mode",
    "user_cloud_project", "user_cloud_region", "user_cloud_bootstrap_sa",
    "user_cloud_authorized_at", "user_cloud_tenant_id", "user_cloud_subscription_id",
    "user_cloud_resource_group", "url", "provisioned_at",
]  # fmt: skip
#: Placement metadata may not carry person-level, lifecycle or address keys.
_FORBIDDEN_METADATA = frozenset(
    {"erasure", "upgradeLease", "detachedPlacements", "url", "provisionAttempt"}
)
_LEASE_RE = re.compile(r"^[0-9a-f]{32}$")
_HEAD_RE = re.compile(r"^[0-9a-f]{64}$")


class StandbyRefused(ValueError):
    """The request is malformed or names a placement this store must not record."""


def _known_targets() -> list[str]:
    return [BACKEND_GCP, *OWNER_CLOUD_TARGETS]


def _text(value: object) -> Optional[str]:
    cleaned = str(value).strip() if value is not None else ""
    return cleaned or None


def _epoch(value: object) -> int:
    if type(value) is not int or value < 0:
        raise StandbyRefused("a placement epoch is a non-negative integer")
    return value


def _observed(observed: Mapping[str, Any]) -> dict[str, Any]:
    """The fence a sync carries: the registry epoch and the standby's pod key id."""
    if not isinstance(observed, Mapping):
        raise StandbyRefused("a sync needs the observed standby")
    key_id = _text(observed.get("pod_key_id"))
    if not key_id:
        raise StandbyRefused("the observed standby names no pod key")
    return {"epoch": _epoch(observed.get("placement_epoch")), "pod_key_id": key_id}


def _placement_metadata(value: object) -> dict[str, Any]:
    metadata = dict(value) if isinstance(value, Mapping) else {}
    if value is not None and not isinstance(value, Mapping):
        raise StandbyRefused("placement metadata must be an object")
    if any(key in _FORBIDDEN_METADATA or str(key).startswith("puppy") for key in metadata):
        raise StandbyRefused("placement metadata carries a person-level or lifecycle key")
    return metadata


def validate_placement(placement: Mapping[str, Any]) -> dict[str, Any]:
    """The standby's placement, normalised, or :class:`StandbyRefused`. Public keys only."""
    if not isinstance(placement, Mapping):
        raise StandbyRefused("a standby needs a placement")
    unknown = set(placement) - set(PLACEMENT_FIELDS)
    if unknown:
        raise StandbyRefused(f"unknown placement fields: {sorted(unknown)}")
    values = {field: _text(placement.get(field)) for field in PLACEMENT_FIELDS}
    values["backend_metadata"] = _placement_metadata(placement.get("backend_metadata"))
    target = values["deployment_target"]
    if not is_known_pod_target(target):
        raise StandbyRefused("unknown placement target")
    coordinates = {
        name: values[f"user_cloud_{name}"]
        for name in ("project", "tenant_id", "subscription_id", "resource_group", "region")
    }
    if is_owner_cloud_target(target) and not owner_cloud_coordinates_complete(target, coordinates):
        raise StandbyRefused("the placement's cloud coordinates are incomplete")
    if not (values["url"] or "").startswith("https://") or not values["external_agent_id"]:
        raise StandbyRefused("a standby needs an https address and a host id")
    if not values["pod_pubkey"] or not values["pod_key_id"]:
        raise StandbyRefused("a standby needs its pod public key")
    signing = values["pod_signing_pubkey"]
    if (
        not is_signing_public_key(signing)
        or signing_key_id(signing) != values["pod_signing_key_id"]
    ):
        raise StandbyRefused("a standby needs a valid request-signing public key")
    return values


def _validate_sync_result(
    status: str, synced_seq: Optional[int], synced_head_sha: Optional[str]
) -> tuple[str, Optional[int], Optional[str]]:
    if status not in SYNC_STATUSES:
        raise StandbyRefused("unknown sync status")
    if status != "synced":
        return status, None, None
    if type(synced_seq) is not int or synced_seq < 0:
        raise StandbyRefused("a synced result needs a non-negative sequence")
    if synced_seq == 0:
        if synced_head_sha is not None:
            raise StandbyRefused("an empty log has no head hash")
        return status, 0, None
    if not isinstance(synced_head_sha, str) or not _HEAD_RE.match(synced_head_sha):
        raise StandbyRefused("a synced result needs a 64-hex head hash")
    return status, synced_seq, synced_head_sha


class PersonalAgentStandbyStore:
    """Async access to ``personal_agent_standby_placements``. Never raises on a fence miss."""

    def __init__(self, client: Any = None) -> None:
        self._client = client

    def _db(self) -> Any:
        return self._client or get_db()

    async def _rows(self, statement: str, params: dict[str, Any]) -> list[dict]:
        response = await asyncio.to_thread(self._db().execute_raw, statement, params)
        return [dict(row) for row in (getattr(response, "data", None) or [])]

    async def _one(self, statement: str, params: dict[str, Any]) -> Optional[dict]:
        rows = await self._rows(statement, params)
        return rows[0] if rows else None

    async def read_standby(self, user_id: str) -> Optional[dict]:
        """The person's standby with the registry's ``placement_epoch``, or None."""
        if not _text(user_id):
            return None
        return await self._one(sql.READ_SQL, {"user_id": str(user_id).strip()})

    async def add_standby(
        self, user_id: str, observed_epoch: int, placement: Mapping[str, Any]
    ) -> Optional[dict]:
        """Record a standby for a provisioned, signing primary. None when fenced out.

        Latches the primary to ``identity_mode='signed'`` in the same statement: from
        here on the Google-token path cannot speak for either placement (E4).
        """
        values = validate_placement(placement)
        params = {
            **values,
            "backend_metadata": json.dumps(values["backend_metadata"], sort_keys=True),
            "user_id": str(user_id or "").strip(),
            "epoch": _epoch(observed_epoch),
        }
        if not params["user_id"]:
            raise StandbyRefused("a standby needs its owner")
        return await self._one(sql.ADD_SQL, params)

    async def remove_standby(
        self, user_id: str, observed: Mapping[str, Any], reason: str
    ) -> Optional[dict]:
        """Forget the standby, keeping only where it ran under ``detachedPlacements``.

        Refused (None) while the primary is under erasure or mid-provision: the standby
        must be removed before the person's erasure is reserved, never during it.
        """
        fence = _observed(observed)
        text = str(reason or "").strip()[:REMOVE_REASON_MAX]
        if not text:
            raise StandbyRefused("removing a standby needs a stated reason")
        params = {**fence, "user_id": str(user_id or "").strip(), "reason": text}
        return await self._one(sql.REMOVE_SQL, {**params, "coordinates": DETACHED_COORDINATES})

    async def claim_sync_lease(
        self, user_id: str, observed: Mapping[str, Any], lease_id: str, cooldown_seconds: int
    ) -> Optional[dict]:
        """Take the single-flight sync lease; the claimed row, or None.

        Refused while another unexpired lease is held or the last attempt is inside
        ``cooldown_seconds``. Stamps ``last_sync_attempt_at`` either way it wins.
        """
        fence = _observed(observed)
        if not isinstance(lease_id, str) or not _LEASE_RE.match(lease_id):
            raise StandbyRefused("a sync lease id is 32 lower-case hex characters")
        if type(cooldown_seconds) is not int or not 0 <= cooldown_seconds <= MAX_COOLDOWN_SECONDS:
            raise StandbyRefused("cooldown out of range")
        params = {
            **fence,
            "user_id": str(user_id or "").strip(),
            "lease_id": lease_id,
            "cooldown": cooldown_seconds,
            "lease_ttl": SYNC_LEASE_TTL_SECONDS,
        }
        return await self._one(sql.CLAIM_SQL, params)

    async def list_standbys_due(self, synced_before: Any, limit: int) -> list[dict]:
        """Standbys not synced since ``synced_before``, least recently attempted first."""
        if type(limit) is not int or not 1 <= limit <= MAX_DUE_PAGE:
            raise StandbyRefused("page size out of range")
        params = {
            "synced_before": synced_before,
            "limit": limit,
            "lease_ttl": SYNC_LEASE_TTL_SECONDS,
        }
        return await self._rows(sql.DUE_SQL, params)

    async def record_sync_result(
        self,
        user_id: str,
        observed: Mapping[str, Any],
        lease_id: str,
        synced_seq: Optional[int],
        synced_head_sha: Optional[str],
        status: str,
    ) -> Optional[dict]:
        """Publish a sync outcome under the lease; the updated row, or None.

        Fenced on the lease and the placement epoch. Only ``synced`` moves progress,
        and only forward: an older sequence, or the same sequence with another head,
        is refused and the lease stays held so the caller can record the failure.
        """
        fence = _observed(observed)
        status, seq, head = _validate_sync_result(status, synced_seq, synced_head_sha)
        params = {
            **fence,
            "user_id": str(user_id or "").strip(),
            "lease_id": str(lease_id or ""),
            "status": status,
            "synced_seq": seq,
            "synced_head_sha": head,
        }
        return await self._one(sql.RECORD_SQL, params)

    async def swap_primary_and_standby(self, user_id: str, observed_epoch: int) -> Optional[dict]:
        """Promote the standby (E9). ``{user_id, placement_epoch}``, or None when fenced out.

        One statement, so one transaction: the whole placement (target, backend, host,
        model mode, keys, versions, placement metadata) moves in both directions, the
        epoch goes up by one and the row latches to ``signed``. Device-keyed
        ``puppy*`` keys and ``detachedPlacements`` stay with the person. Refused during
        erasure, an upgrade lease or an unfinished provision; a ``provisioned`` or
        ``needs_reinit`` primary is accepted (failover promotes past a dead primary).
        """
        params = {
            "user_id": str(user_id or "").strip(),
            "epoch": _epoch(observed_epoch),
            "known_targets": _known_targets(),
        }
        return await self._one(sql.SWAP_SQL, params)
