"""One definition of the standby-sync proof audience, imported by pod and hub alike.

WHY THE AUDIENCE BINDS THE BODY (E6)
------------------------------------
A hub proof for the migration routes binds *which agent* (the HusshID). Sync needs
more than that: an export proof bound only to the agent could be captured and
replayed with a different ``standby_public_key``, redirecting the person's sealed
history to a recipient the hub never chose. Binding a digest of the exact request
body into the audience makes every proof good for exactly one request shape.

The digest is over canonical JSON (sorted keys, compact separators, UTF-8), the
same canonical form the bundle code already uses. Both ends call this function, so
they agree by construction rather than by coincidence.

This module is imported by the hub. It carries no key material and no decryption
path, and ``tests/test_pod_sync_proof.py`` asserts that structurally.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

PURPOSE_SYNC_HEAD = "sync-head"
PURPOSE_SYNC_EXPORT = "sync-export"
PURPOSE_SYNC_IMPORT = "sync-import"
PURPOSE_SET_ROLE = "set-role"

SYNC_PURPOSES: frozenset[str] = frozenset(
    {PURPOSE_SYNC_HEAD, PURPOSE_SYNC_EXPORT, PURPOSE_SYNC_IMPORT, PURPOSE_SET_ROLE}
)


def canonical_body(body: Mapping[str, Any]) -> bytes:
    """The exact bytes a body digest is computed over."""
    return json.dumps(dict(body), sort_keys=True, separators=(",", ":")).encode("utf-8")


def body_digest(body: Mapping[str, Any]) -> str:
    """Hex SHA-256 of :func:`canonical_body`."""
    return hashlib.sha256(canonical_body(body)).hexdigest()


def sync_proof_audience(hushh_id: str, purpose: str, body: Mapping[str, Any]) -> str:
    """``{hub_proof_audience(hushh_id)}:{purpose}:{sha256(canonical body)}``.

    Raises ``ValueError`` for an unknown purpose or an empty HusshID: an audience
    that binds nothing must never be minted or accepted.
    """
    if purpose not in SYNC_PURPOSES:
        raise ValueError(f"unknown sync proof purpose: {purpose!r}")
    if not str(hushh_id or "").strip():
        raise ValueError("a sync proof is bound to a HusshID")
    if not isinstance(body, Mapping):
        raise ValueError("a sync proof binds a JSON object body")
    from api.routes.one.pod_migration import hub_proof_audience  # noqa: PLC0415

    return f"{hub_proof_audience(hushh_id)}:{purpose}:{body_digest(body)}"


__all__ = [
    "PURPOSE_SET_ROLE",
    "PURPOSE_SYNC_EXPORT",
    "PURPOSE_SYNC_HEAD",
    "PURPOSE_SYNC_IMPORT",
    "SYNC_PURPOSES",
    "body_digest",
    "canonical_body",
    "sync_proof_audience",
]
