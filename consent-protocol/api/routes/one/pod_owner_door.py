"""The owner's own door into their private pod: this pod's app-role session, never the hub.

Some pod routes take something only the owner may hand over: a sealed AI key, a sealed
Google login. Anyone holding the pod's public key can seal an envelope, so a write the
hub admitted could swap in a key or an account the owner never chose. These routes
therefore refuse a hub-relayed consent token with 403 ``OWNER_SESSION_REQUIRED`` even
when it is valid for the owner, and open only on this pod's app-role session with the
scope the route names. A write that changes configuration also needs a held
incarnation, exactly as ``POST /api/one/pod/config`` does. A disabled pod answers 404
before any door opens.

Two halves, so a route settles admission before it reads a body:

* ``owner_local_door`` resolves the request's headers into the session a core needs;
* ``admit_owner_local`` is the core's own admission, which refuses a hub token too, so
  a core called directly is never weaker than its route.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException

from api.routes.one import pod_memory as _memory

OWNER_SESSION_REQUIRED = "OWNER_SESSION_REQUIRED"


async def admit_owner_local(
    consent_token: str, *, verifier: Any, session: Optional[dict], scope: str
) -> dict:
    """The memory doors' admission, minus the hub door (see the module docstring)."""
    if not (consent_token or "").strip():
        raise HTTPException(status_code=401, detail="consent token required")
    if session is None:
        raise HTTPException(status_code=403, detail={"code": OWNER_SESSION_REQUIRED})
    return await _memory._admit_owner(
        consent_token, verifier=verifier, session=session, scope=scope
    )


async def owner_local_door(
    x_consent_token: Optional[str], authorization: Optional[str], *, scope: str, held: bool
) -> dict[str, Any]:
    """Resolve the owner-local session; a hub token is refused, not merely ignored."""
    from api.routes.one import pod_turn as _turn  # noqa: PLC0415
    from api.routes.one.pod_session import _refuse, bearer, verified_session  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import (  # noqa: PLC0415
        ROLE_APP,
        PodSessionRefused,
    )

    _turn._require_enabled()
    if str(x_consent_token or "").strip():
        raise HTTPException(status_code=403, detail={"code": OWNER_SESSION_REQUIRED})
    if not bearer(authorization):
        return {"consent_token": ""}
    authority, claims = verified_session(authorization, role=ROLE_APP, scope=scope)
    if held:
        try:
            await authority.require_held()
        except PodSessionRefused as exc:
            raise _refuse(exc) from exc
    return {
        "consent_token": authority.local_token(claims),
        "verifier": authority.local_verifier(claims),
        "session": claims,
    }


__all__ = ["OWNER_SESSION_REQUIRED", "admit_owner_local", "owner_local_door"]
