"""Erase a private agent that was never built: the hub releases its own access, nothing else.

A person can finish cloud setup (their project, their bootstrap service account,
the hub's impersonation grant on it) and delete their account before any agent is
built. Every hosted erasure step then has nothing to act on: there is no pod to
fence, no memory, no compute, no substrate. The generic chain refuses such a
reservation at its first step, on every sweep, forever.

For that shape only, erasure is one thing: the hub revokes the grant it was given
(the existing bootstrap-grant release), and records a receipt naming what stays
with the person (their project and their bootstrap service account) and that the
hub deletes neither. Nothing of the person's is deleted.

The decision here is ROUTING, not authority. The database derives the receipt
itself from the live rows (``retain_erasure_never_hosted``, migration 954): a
pre-host snapshot with no provision attempt, no backend and no agent id, no host
or substrate lifecycle event, a recorded setup job. It re-derives that evidence
again for the bootstrap release and at completion, so a mistake in this module can
leave an account refused but can never claim an erasure the database cannot prove.

Provider-neutral by construction: the owner-cloud target and the backend's
bootstrap-release capability select this path, never a provider id.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from hushh_mcp.services.compute_backend import is_owner_cloud_target
from hushh_mcp.services.personal_agent_owner_access_erasure import erase_reserved_owner_access

logger = logging.getLogger(__name__)

RECEIPT_FIELD = "neverHosted"
# Registry states that precede any provision claim; 917 claims before any substrate.
_PRE_HOST_STATUSES = frozenset({"pending", "unprovisioned"})
_RETAIN_SQL = (
    "SELECT public.retain_erasure_never_hosted(:owner, :attempt, "
    "CAST(:expected AS jsonb)) AS retained"
)


def never_hosted_snapshot(snapshot: object) -> bool:
    """True when a reserved snapshot shows nothing was ever built for the person.

    Advisory: the database re-derives this, plus the lifecycle log and the setup
    history, before it retains anything.
    """
    return (
        isinstance(snapshot, dict)
        and snapshot.get("status") in _PRE_HOST_STATUSES
        and is_owner_cloud_target(snapshot.get("deployment_target"))
        and not snapshot.get("backend")
        and not snapshot.get("external_agent_id")
        and snapshot.get("backend_metadata") in (None, {})
    )


def cleanup_backend_matches(
    snapshot: dict[str, Any], backend: Any, grant_release: bool = False
) -> bool:
    """Whether a reserved cleanup may use ``backend``: it must be the recorded one.

    A never-hosted snapshot recorded none, because nothing was built. There, and only
    there, and only for Hussh releasing its own bootstrap grant (``grant_release``),
    the backend resolved from its deployment target is accepted. Every destructive
    helper (bucket, KMS, runtime account, files) keeps the strict match.
    """
    resolved = getattr(backend, "backend_id", None)
    if grant_release and snapshot.get("backend") is None and never_hosted_snapshot(snapshot):
        return bool(resolved)
    return resolved == snapshot.get("backend")


async def _retain_receipt(service: Any, *, user_id: str, reservation: dict[str, Any]) -> None:
    """Ask the database to derive and retain the receipt once; read it back."""
    response = await asyncio.to_thread(
        service._registry._db().execute_raw,
        _RETAIN_SQL,
        {
            "owner": user_id,
            "attempt": reservation["attemptId"],
            "expected": json.dumps(reservation),
        },
    )
    if not (response.data and response.data[0].get("retained") is True):
        raise RuntimeError("never-hosted erasure evidence unproven")
    observed = await service._registry.get(user_id)
    saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
    if (
        saved.get("attemptId") != reservation["attemptId"]
        or saved.get("registrySnapshot") != reservation.get("registrySnapshot")
        or not isinstance(saved.get(RECEIPT_FIELD), dict)
    ):
        raise RuntimeError("never-hosted erasure readback unconfirmed")


async def erase_reserved_never_hosted(
    service: Any, *, user_id: str, reservation: dict[str, Any]
) -> bool:
    """False when the reservation is not this shape; True once the account guard passes.

    Idempotent per attempt: a retained receipt is never re-requested, and the
    bootstrap release resumes from its own retained receipts. Any refusal raises and
    the caller keeps the account fail-closed.
    """
    snapshot = reservation.get("registrySnapshot") if isinstance(reservation, dict) else None
    if not isinstance(snapshot, dict) or not never_hosted_snapshot(snapshot):
        return False
    try:
        backend = service._reserved_cleanup_backend(snapshot, grant_release=True)
    except Exception:  # noqa: BLE001 - an unresolvable backend is the existing chain's to refuse
        return False
    if not callable(getattr(backend, "erase_bootstrap_grant", None)):
        return False
    if (
        reservation.get("ownerId") != user_id
        or snapshot.get("user_id") != user_id
        or reservation.get("phase") != "reserved"
        or not reservation.get("attemptId")
    ):
        raise RuntimeError("never-hosted erasure reservation unavailable")
    if reservation.get(RECEIPT_FIELD) is None:
        await _retain_receipt(service, user_id=user_id, reservation=reservation)
    await service._erase_reserved_bootstrap_grants(user_id=user_id)
    logger.info("personal_agent.never_hosted_erased hub_access_released=true deleted=0")
    from hushh_mcp.services.account_service import AccountService  # noqa: PLC0415

    await asyncio.to_thread(
        AccountService().assert_personal_agent_external_resources_absent, user_id
    )
    return True


async def erase_reserved_outside_chain(
    service: Any, *, user_id: str, reservation: dict[str, Any]
) -> bool:
    """The reservations the generic erasure chain cannot finish; False hands it back.

    Owner-access erasure first (its behaviour unchanged), then never-hosted erasure.
    """
    if await erase_reserved_owner_access(service, user_id=user_id, reservation=reservation):
        return True
    return await erase_reserved_never_hosted(service, user_id=user_id, reservation=reservation)


__all__ = [
    "RECEIPT_FIELD",
    "cleanup_backend_matches",
    "erase_reserved_never_hosted",
    "erase_reserved_outside_chain",
    "never_hosted_snapshot",
]
