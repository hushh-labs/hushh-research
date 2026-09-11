"""How a pod asks the hub whether consent is still good.

The pod side of ``api/routes/one/pod_consent.py``. See that module for why asking
beats verifying locally; in short, a pod holds a signing key that deliberately
cannot check the hub's signatures, and even a checkable signature would not close
revocation, because the revoked set lives in the hub's process and database.

Three failure modes, three different answers -- and conflating any two of them is
how a consent control quietly stops being one:

    valid       the hub says this token is live and in scope
    invalid     the hub says no. A clean denial. Refuse the turn.
    unavailable the hub could not be asked at all

The third must NEVER collapse into either of the others. Treated as ``invalid`` it
would turn a hub blip into "your agent refuses to know you", which is alarming and
wrong. Treated as ``valid`` it would let a pod act on someone's holdings with no
live consent check -- exactly the bypass this whole path exists to prevent. So it
is its own state, and the caller surfaces it as a 503: ask again shortly.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

_VERIFY_PATH = "/api/one/pod/consent/verify"
_TIMEOUT_SECONDS = 8.0


async def require_owner_scope(
    token: str,
    *,
    expected_scope: str,
    user_id: str | None = None,
    expected_agent_id: str | None = None,
    verifier: Any = None,
) -> "ConsentVerdict":
    """Revalidate one exact scope against this serving pod before a tool runs."""
    mine = (os.getenv("HUSSH_ID") or "").strip()
    if not mine or not expected_scope:
        raise PermissionError("Pod authority binding unavailable")
    check = verifier or verify_consent
    verdict = await check(token, expected_scope=expected_scope)
    if not verdict.available:
        raise RuntimeError("Pod consent authority unavailable")
    if (
        not verdict.valid
        or not verdict.user_id
        or verdict.hushh_id != mine
        or (user_id is not None and verdict.user_id != user_id)
        or (expected_agent_id is not None and verdict.agent_id != str(expected_agent_id).strip())
    ):
        raise PermissionError("Pod consent scope denied")
    return verdict


@dataclass(frozen=True)
class ConsentVerdict:
    """What the consent authority said, or that it could not be asked."""

    valid: bool
    available: bool
    user_id: str = ""
    hushh_id: str = ""
    scope: str = ""
    reason: str = ""
    agent_id: str = ""

    @property
    def should_refuse(self) -> bool:
        """A clean denial: the authority answered, and the answer was no."""
        return self.available and not self.valid

    @classmethod
    def from_local_session(
        cls, claims: "Mapping[str, Any]", *, expected_scope: str = ""
    ) -> "ConsentVerdict":
        """A verdict answered by the pod's own session authority, not the hub.

        The session claims were minted from a hub-signed binding the pod verified
        and recorded; the authority re-checks tombstones before calling this. What
        remains is the scope question, answered from the binding's scopes. The
        authority is always ``available`` here because it is this process.
        """
        scopes = {str(s) for s in (claims.get("scopes") or [])}
        wanted = str(expected_scope or "").strip()
        user_id = str(claims.get("user_id") or "").strip()
        hushh_id = str(claims.get("hushh_id") or "").strip()
        if wanted and wanted not in scopes:
            return cls(
                valid=False,
                available=True,
                user_id=user_id,
                hushh_id=hushh_id,
                scope=wanted,
                reason="scope not granted by the pod binding",
            )
        if not user_id or not hushh_id:
            return cls(valid=False, available=True, reason="session carries no owner")
        return cls(
            valid=True,
            available=True,
            user_id=user_id,
            hushh_id=hushh_id,
            scope=wanted,
            agent_id=str(claims.get("agent_id") or "").strip(),
            reason="verified by the pod's local authority",
        )


async def verify_consent(
    token: str,
    *,
    expected_scope: str = "",
    client: Any = None,
) -> ConsentVerdict:
    """Ask the hub about ``token``. Never raises; the outcome is in the verdict."""
    if not str(token or "").strip():
        return ConsentVerdict(valid=False, available=True, reason="no token")

    hub = client
    if hub is None:
        from hushh_mcp.services.pod_hub_client import PodHubClient  # noqa: PLC0415

        hub = PodHubClient(timeout_seconds=_TIMEOUT_SECONDS)

    body: dict[str, Any] = {"token": token}
    if expected_scope:
        body["expectedScope"] = expected_scope

    try:
        import asyncio  # noqa: PLC0415

        response = await asyncio.to_thread(hub.post, _VERIFY_PATH, json=body)
    except Exception as exc:  # noqa: BLE001 - unreachable is its own state, not a denial
        logger.warning("pod_consent_client.unreachable %s", type(exc).__name__)
        return ConsentVerdict(
            valid=False, available=False, reason=f"authority unreachable: {type(exc).__name__}"
        )

    status = getattr(response, "status_code", 0)
    if status == 503:
        # The hub reached its database and could not read it. Same class as an
        # unreachable hub: unknown, not denied.
        return ConsentVerdict(valid=False, available=False, reason="authority unavailable")
    if status != 200:
        # 401/404 mean this pod is not accepted or the surface is off. That is a
        # configuration fault, and refusing is correct -- but it is worth a warning,
        # because a whole fleet failing this way looks identical to every user's
        # consent being denied.
        logger.warning("pod_consent_client.rejected status=%s", status)
        return ConsentVerdict(valid=False, available=False, reason=f"authority said HTTP {status}")

    try:
        data = response.json() or {}
    except Exception:  # noqa: BLE001
        return ConsentVerdict(valid=False, available=False, reason="unreadable authority response")

    if not data.get("valid"):
        return ConsentVerdict(valid=False, available=True, reason="consent is not valid")
    return ConsentVerdict(
        valid=True,
        available=True,
        user_id=str(data.get("userId") or ""),
        hushh_id=str(data.get("hushhId") or ""),
        scope=str(data.get("scope") or ""),
        agent_id=str(data.get("agentId") or ""),
        reason="verified by the hub",
    )
