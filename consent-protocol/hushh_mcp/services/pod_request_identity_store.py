"""Hub-side state for signed pod requests: replay nonces, the latch, key pulls.

Every statement here reads or writes only what dev-only migration 947
(``db/migrations/parked/947_pod_request_signing.sql``) adds, and is reached only on
the signed path, which runs only where ``pod_hub_identity_auth_enabled`` is on.
UAT and production never execute any of it.

Four writes, each conditional, each idempotent:

* **Nonce** -- ``INSERT .. ON CONFLICT DO NOTHING``. Zero rows inserted means the
  (kid, nonce) pair was already consumed: a replay, refused by the caller.
* **Latch** -- ``identity_mode='signed'`` once a row has presented a valid
  signature. It is never cleared here; afterwards a Google-only request from that
  row is refused, so a stolen or replayed ID token cannot downgrade the row.
* **Pull claim** -- a per-row stamp under ``backend_metadata.signingKeyPull``, set
  only when the previous stamp is older than the interval. Whoever wins the stamp
  may trigger ONE hub-initiated key pull; everyone else waits. A request never
  carries key material, so the stamp is the only thing a forged request can buy.
* **Signing-key binding** -- records the pod's signing public key against the
  X25519 key already on the row, compared in the same statement, so a signing key
  can never be attached to a different pod key than the one it was published with.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: How often a process sweeps expired nonces. A missed sweep costs nothing but
#: rows that the timestamp window already refuses.
_PRUNE_INTERVAL_SECONDS = 60.0
_PRUNE_LOCK = threading.Lock()
_LAST_PRUNE = [0.0]

_CONSUME_NONCE_SQL = """
INSERT INTO pod_request_nonces (kid, nonce, expires_at)
VALUES (:kid, :nonce, to_timestamp(CAST(:expires_at_ms AS double precision) / 1000.0))
ON CONFLICT (kid, nonce) DO NOTHING
RETURNING kid
"""

_PRUNE_NONCES_SQL = "DELETE FROM pod_request_nonces WHERE expires_at < now()"

_LATCH_SQL = """
UPDATE personal_agent_registry
SET identity_mode = 'signed'
WHERE hushh_id = :hushh_id
  AND pod_signing_key_id = :kid
  AND identity_mode IS DISTINCT FROM 'signed'
RETURNING hushh_id
"""

# Only a row the hub could actually pull from: a live status, an HTTPS address the
# hub recorded itself, and no erasure in progress. Stamping any other row would
# leave metadata on a record that has nothing to pull.
_CLAIM_PULL_SQL = """
UPDATE personal_agent_registry
SET backend_metadata = jsonb_set(
        coalesce(backend_metadata, '{}'::jsonb),
        '{signingKeyPull}',
        to_jsonb(CAST(:now_ms AS bigint)),
        true
    )
WHERE hushh_id = :hushh_id
  AND status IN ('connecting', 'provisioned')
  AND left(backend_metadata->>'url', 8) = 'https://'
  AND NOT (backend_metadata ? 'erasure')
  AND (CASE WHEN jsonb_typeof(backend_metadata->'signingKeyPull') = 'number'
            THEN CAST(backend_metadata->>'signingKeyPull' AS bigint)
            ELSE 0 END) <= CAST(:cutoff_ms AS bigint)
RETURNING hushh_id
"""

_BIND_SIGNING_KEY_SQL = """
UPDATE personal_agent_registry
SET pod_signing_pubkey = :signing_pubkey,
    pod_signing_key_id = :signing_key_id
WHERE user_id = :user_id
  AND hushh_id = :hushh_id
  AND pod_pubkey = :pod_pubkey
  AND (pod_signing_key_id IS NULL
       OR pod_signing_key_id = :signing_key_id
       OR CAST(:allow_rotation AS boolean))
RETURNING user_id
"""


def _now_ms() -> int:
    return int(time.time() * 1000)


class PodRequestIdentityStore:
    """The four conditional writes above. The client is injectable for tests."""

    def __init__(self, client: Any = None) -> None:
        self._client = client

    def _db(self) -> Any:
        if self._client is not None:
            return self._client
        from db.db_client import get_db  # noqa: PLC0415

        return get_db()

    async def _rows(self, sql: str, params: dict[str, Any]) -> list[dict]:
        result = await asyncio.to_thread(self._db().execute_raw, sql, params)
        return list(getattr(result, "data", None) or [])

    async def consume_nonce(self, *, kid: str, nonce: str, expires_at_ms: int) -> bool:
        """True when this (kid, nonce) was unused and is now consumed."""
        rows = await self._rows(
            _CONSUME_NONCE_SQL, {"kid": kid, "nonce": nonce, "expires_at_ms": int(expires_at_ms)}
        )
        await self._maybe_prune()
        return bool(rows)

    async def _maybe_prune(self) -> None:
        now = time.monotonic()
        with _PRUNE_LOCK:
            if now - _LAST_PRUNE[0] < _PRUNE_INTERVAL_SECONDS:
                return
            _LAST_PRUNE[0] = now
        try:
            await asyncio.to_thread(self._db().execute_raw, _PRUNE_NONCES_SQL, {})
        except Exception as exc:  # noqa: BLE001 - expired rows are already refused by the window
            logger.info("pod_request_identity.prune_failed %s", type(exc).__name__)

    async def latch_signed(self, *, hushh_id: str, kid: str) -> bool:
        """Latch the row to signed. True when this call set it."""
        return bool(await self._rows(_LATCH_SQL, {"hushh_id": hushh_id, "kid": kid}))

    async def claim_key_pull(
        self, *, hushh_id: str, interval_ms: int, now_ms: Optional[int] = None
    ) -> bool:
        """True when this caller won the row's pull slot for the next interval."""
        now = _now_ms() if now_ms is None else int(now_ms)
        rows = await self._rows(
            _CLAIM_PULL_SQL,
            {"hushh_id": hushh_id, "now_ms": now, "cutoff_ms": now - int(interval_ms)},
        )
        return bool(rows)

    async def bind_signing_key(
        self,
        *,
        user_id: str,
        hushh_id: str,
        pod_pubkey: str,
        signing_pubkey: str,
        signing_key_id: str,
        allow_rotation: bool,
    ) -> bool:
        """Record the signing key against the row's CURRENT pod key. True when bound."""
        rows = await self._rows(
            _BIND_SIGNING_KEY_SQL,
            {
                "user_id": user_id,
                "hushh_id": hushh_id,
                "pod_pubkey": pod_pubkey,
                "signing_pubkey": signing_pubkey,
                "signing_key_id": signing_key_id,
                "allow_rotation": bool(allow_rotation),
            },
        )
        return bool(rows)


def default_store() -> PodRequestIdentityStore:
    return PodRequestIdentityStore()


# -- recording a pulled signing key (used by attach_pod_public_key) --------------------


def signing_key_columns(public_key_b64: Optional[str], key_id: Optional[str]) -> dict[str, str]:
    """Registry columns for a pulled signing key, or {} when the pull carried none.

    Raises ``ValueError`` for a key that is not a raw Ed25519 public key or a kid the
    key does not derive, before anything is written.
    """
    if not public_key_b64 and not key_id:
        return {}
    from hushh_mcp.services.pod_request_signing import (  # noqa: PLC0415
        is_signing_public_key,
        signing_key_id,
    )

    key = str(public_key_b64 or "")
    if not is_signing_public_key(key) or signing_key_id(key) != key_id:
        raise ValueError("invalid pod signing key")
    return {"pod_signing_pubkey": key, "pod_signing_key_id": str(key_id)}


async def bind_pod_signing_key(
    row: dict, *, user_id: str, pod_pubkey: str, signing: dict[str, str], rotate: bool
) -> None:
    """Bind ``signing`` to the pod key it was published with; refuse a silent swap.

    A no-op when nothing was pulled or the row already records this key. Raises
    ``ValueError`` when the row's pod key moved underneath, or when it records a
    different signing key and ``rotate`` (the hub's own pull) is not set.
    """
    if not signing or row.get("pod_signing_key_id") == signing["pod_signing_key_id"]:
        return
    bound = await default_store().bind_signing_key(
        user_id=user_id,
        hushh_id=str(row.get("hushh_id") or ""),
        pod_pubkey=pod_pubkey,
        signing_pubkey=signing["pod_signing_pubkey"],
        signing_key_id=signing["pod_signing_key_id"],
        allow_rotation=rotate,
    )
    if not bound:
        raise ValueError("a different pod signing key is already registered")


async def bind_published_signing_key(
    row: dict, *, user_id: str, pod_pubkey: str, signing: dict[str, str]
) -> None:
    """After exact-attempt publication recorded ``pod_pubkey``: bind, never raise.

    Publication owns its own column list, so the signing key follows it here. The
    pod key was just authorized, so its signing key may replace an older one; a
    failure leaves the row unsigned until the next hub-initiated pull binds it.
    """
    try:
        await bind_pod_signing_key(
            row, user_id=user_id, pod_pubkey=pod_pubkey, signing=signing, rotate=True
        )
    except Exception as exc:  # noqa: BLE001 - provisioning already succeeded
        logger.warning("pod_request_identity.signing_key_unbound %s", type(exc).__name__)
