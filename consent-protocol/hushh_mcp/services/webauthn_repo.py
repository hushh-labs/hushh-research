"""DB-backed WebAuthn credential repo + one-time challenge store (migration 903).

Thin async CRUD mirroring the Supabase access pattern of the other repos. The
credential store holds verified public keys + sign_count + AAGUID; the challenge
store is one-time (a consumed challenge is deleted, preventing replay) with a
short TTL. Gated by ``WEBAUTHN_ENABLED`` at the route; nothing here runs otherwise.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Optional

from db.db_client import get_db

_CREDENTIALS = "webauthn_credentials"
_CHALLENGES = "webauthn_challenges"


class WebAuthnCredentialRepo:
    """Verified WebAuthn credential public keys."""

    def __init__(self, client: Any = None) -> None:
        self._client = client

    def _db(self) -> Any:
        return self._client if self._client is not None else get_db()

    async def add(self, cred: dict[str, Any]) -> None:
        data = {k: v for k, v in cred.items() if v is not None}
        self._db().table(_CREDENTIALS).insert(data).execute()

    async def get_by_credential_id(self, credential_id: str) -> Optional[dict]:
        resp = (
            self._db()
            .table(_CREDENTIALS)
            .select("*")
            .eq("credential_id", credential_id)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        return rows[0] if rows else None

    async def list_by_user(self, user_id: str) -> list[dict]:
        resp = (
            self._db()
            .table(_CREDENTIALS)
            .select("credential_id,aaguid,sign_count,rp_id,device_label")
            .eq("user_id", user_id)
            .execute()
        )
        return list(resp.data or [])

    async def update_sign_count(
        self, credential_id: str, *, sign_count: int, last_used_at: str
    ) -> None:
        self._db().table(_CREDENTIALS).update(
            {"sign_count": sign_count, "last_used_at": last_used_at}
        ).eq("credential_id", credential_id).execute()


class WebAuthnChallengeStore:
    """One-time, short-TTL WebAuthn challenges (consumed by value)."""

    def __init__(self, client: Any = None) -> None:
        self._client = client

    def _db(self) -> Any:
        return self._client if self._client is not None else get_db()

    async def save(
        self, *, user_id: Optional[str], challenge: str, ceremony: str, rp_id: str, ttl_s: int
    ) -> None:
        expires_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + ttl_s))
        data: dict[str, Any] = {
            "challenge": challenge,
            "ceremony": ceremony,
            "rp_id": rp_id,
            "expires_at": expires_at,
        }
        if user_id is not None:
            data["user_id"] = user_id
        self._db().table(_CHALLENGES).insert(data).execute()

    async def consume(self, challenge: str) -> Optional[dict]:
        resp = (
            self._db().table(_CHALLENGES).select("*").eq("challenge", challenge).limit(1).execute()
        )
        rows = resp.data or []
        # One-time: delete regardless of validity so a challenge can never be replayed.
        self._db().table(_CHALLENGES).delete().eq("challenge", challenge).execute()
        if not rows:
            return None
        row = rows[0]
        if _is_expired(str(row.get("expires_at") or "")):
            return None
        return dict(row)


def _is_expired(expires_at: str) -> bool:
    if not expires_at:
        return False  # unparseable -> rely on the one-time delete
    try:
        dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() < time.time()
    except ValueError:
        return False
