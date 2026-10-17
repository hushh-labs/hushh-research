"""How the hub reaches a pod's standby-sync routes, and what it may see on the way.

Design: ``docs/future/personal-agent/STANDBY-SYNC.md`` (E6, E7, E8). The two-token,
two-audience call is ``pod_migration_transport``'s, reused rather than restated:
``Authorization`` carries a Google ID token for the pod's own address, and
``X-Hussh-Hub-Proof`` carries one whose audience binds THIS request's exact body
(``pod_sync_proof.sync_proof_audience``). Redirects are refused and refused bodies
are never read, exactly as for the move.

The payload dict passed to the transport is the one whose canonical digest the
audience binds; ``requests`` serialises that same dict, and the pod hashes what it
parsed. A field added on one side only is a 403, never a silently different request.

WHAT THIS MODULE MAY NOT DO
---------------------------
It carries a range bundle it cannot open. There is no decryption path here and
there must never be one (asserted structurally in
``tests/test_pod_migration_transport.py``). The hub reads a range's plain
coordinates at most; the ciphertext is sealed to the standby.
"""

from __future__ import annotations

from typing import Any, Optional

from hushh_mcp.services.pod_migration_transport import (
    PodMigrationTransportError,
    _post,
)
from hushh_mcp.services.pod_sync_proof import (
    PURPOSE_SET_ROLE,
    PURPOSE_SYNC_EXPORT,
    PURPOSE_SYNC_HEAD,
    PURPOSE_SYNC_IMPORT,
    sync_proof_audience,
)

HEAD_TIMEOUT_SECONDS = 60.0
#: The primary replays its whole verified log to cut the range (one read per record).
EXPORT_TIMEOUT_SECONDS = 180.0
#: The standby appends one compare-and-swap per record; the slowest step.
IMPORT_TIMEOUT_SECONDS = 300.0
SET_ROLE_TIMEOUT_SECONDS = 60.0


def _call(
    pod_url: str,
    path: str,
    hushh_id: str,
    purpose: str,
    payload: dict[str, Any],
    *,
    timeout: float,
    session: Any,
    token_minter: Any,
) -> dict[str, Any]:
    return _post(
        pod_url,
        path,
        hushh_id,
        payload,
        timeout=timeout,
        session=session,
        minter=token_minter,
        proof_audience=sync_proof_audience(hushh_id, purpose, payload),
    )


def read_head(
    *, pod_url: str, hushh_id: str, session: Any = None, token_minter: Any = None
) -> dict[str, Any]:
    """``POST /pod/sync/head``: the pod's own head, keys, role and epoch (E7)."""
    return _call(
        pod_url,
        "/pod/sync/head",
        hushh_id,
        PURPOSE_SYNC_HEAD,
        {},
        timeout=HEAD_TIMEOUT_SECONDS,
        session=session,
        token_minter=token_minter,
    )


def export_range(
    *,
    pod_url: str,
    hushh_id: str,
    base_seq: int,
    base_head_sha: str,
    standby_public_key: str,
    standby_key_id: str,
    session: Any = None,
    token_minter: Any = None,
) -> dict[str, Any]:
    """``POST /pod/sync/export`` on the PRIMARY: the records after the standby's head,
    sealed to the standby and signed by the primary. ``bundle`` is None when the base
    already is the primary's head."""
    return _call(
        pod_url,
        "/pod/sync/export",
        hushh_id,
        PURPOSE_SYNC_EXPORT,
        {
            "base_seq": base_seq,
            "base_head_sha": base_head_sha,
            "standby_public_key": standby_public_key,
            "standby_key_id": standby_key_id,
        },
        timeout=EXPORT_TIMEOUT_SECONDS,
        session=session,
        token_minter=token_minter,
    )


def import_range(
    *,
    pod_url: str,
    hushh_id: str,
    bundle: dict[str, Any],
    base_seq: int,
    base_head_sha: str,
    session: Any = None,
    token_minter: Any = None,
) -> dict[str, Any]:
    """``POST /pod/sync/import`` on the STANDBY: verify origin and continuity against its
    own head, then append with compare-and-swap (E8). The bundle passes through unread."""
    return _call(
        pod_url,
        "/pod/sync/import",
        hushh_id,
        PURPOSE_SYNC_IMPORT,
        {"bundle": bundle, "base_seq": base_seq, "base_head_sha": base_head_sha},
        timeout=IMPORT_TIMEOUT_SECONDS,
        session=session,
        token_minter=token_minter,
    )


def set_role(
    *,
    pod_url: str,
    hushh_id: str,
    role: str,
    epoch: int,
    primary_signing_key_id: Optional[str],
    target_pod_signing_key_id: str,
    expires_at: int,
    session: Any = None,
    token_minter: Any = None,
) -> dict[str, Any]:
    """``POST /pod/sync/set-role``: a forward-only role write bound to the target pod's
    signing key id (E2). A lost response is confirmed by :func:`read_head`, because an
    identical retry is refused as a stale epoch."""
    return _call(
        pod_url,
        "/pod/sync/set-role",
        hushh_id,
        PURPOSE_SET_ROLE,
        {
            "role": role,
            "epoch": epoch,
            "primary_signing_key_id": primary_signing_key_id,
            "target_pod_signing_key_id": target_pod_signing_key_id,
            "expires_at": expires_at,
        },
        timeout=SET_ROLE_TIMEOUT_SECONDS,
        session=session,
        token_minter=token_minter,
    )


__all__ = [
    "EXPORT_TIMEOUT_SECONDS",
    "HEAD_TIMEOUT_SECONDS",
    "IMPORT_TIMEOUT_SECONDS",
    "PodMigrationTransportError",
    "export_range",
    "import_range",
    "read_head",
    "set_role",
]
