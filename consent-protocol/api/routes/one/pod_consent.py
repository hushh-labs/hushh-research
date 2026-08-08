"""The hub answers "is this consent still good?" for a pod. Closes SECURITY-REVIEW I1.

The problem this solves, stated exactly
---------------------------------------
A pod cannot verify a consent token. Its ``APP_SIGNING_KEY`` is deliberately a
DIFFERENT key from the hub's, because with HMAC the ability to verify is the
ability to forge -- mounting the hub's key in every pod would mean any compromised
pod could mint consent for anyone. So a pod holds a key that cannot check the hub's
signatures, by design.

And even with a signature it could check, it would still be wrong. ``validate_token``
consults an IN-PROCESS revoked set (``token.py:103,224``) that a remote pod never
populates, and ``validate_token_with_db`` needs Postgres, which a pod holds no
credential for. A revoked token would read as live inside a pod indefinitely. That
is SECURITY-REVIEW **I1**, and it is the finding that gates any real user's holdings
reaching a pod.

Why asking beats verifying
--------------------------
The obvious fix is asymmetric signing: issue Ed25519, ship public keys to pods, let
each verify locally. That is the right END state and the module for it already
exists -- but it is a migration of every token in the system, and on its own it
still does not close revocation, which is the half that actually gates users.

So the pod asks the authority instead. The hub issued the token, holds the audit
ledger, and owns the revoked set; it is the only component that can answer
truthfully. One authenticated round trip per turn buys a check that is correct by
construction rather than eventually consistent.

The costs, stated rather than hidden:

* **Availability coupling.** A pod cannot serve a turn while the hub is
  unreachable. That is the correct failure direction -- an agent that keeps acting
  on holdings when the consent authority cannot be reached is precisely what
  consent-first forbids -- but it is a real dependency and it is why the pod
  surfaces a 503 rather than pretending.
* **The hub sees the token each turn.** It issued it, so this reveals nothing new.
* **Latency.** One intra-project call against a turn that already takes seconds.

Ed25519 remains the end state for offline verification and for BYO-GCP pods where a
hub round trip is undesirable. It is not on the critical path for the first release,
because this closes the same gap sooner and closes revocation too.

Authentication is pod-identity ONLY. There is no legitimate non-pod caller: a
browser has no reason to ask whether someone else's token is live, and answering
that question for anonymous callers would turn this into a token oracle.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from api.routes.one.pod_identity_auth import verify_pod_identity
from hushh_mcp.runtime_settings import personal_agent_enabled

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod/consent", tags=["personal-agent"])


class PodConsentVerifyRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=4096)
    expected_scope: str = Field(default="", alias="expectedScope", max_length=128)

    model_config = ConfigDict(populate_by_name=True)


async def verify_consent_for_pod(
    request: Request,
    authorization: Optional[str],
    payload: PodConsentVerifyRequest,
    *,
    validator: Any = None,
    registry: Any = None,
) -> dict:
    """Testable core: authenticate the pod, then answer as the consent authority."""
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")

    asserted = await verify_pod_identity(request, authorization)
    if not asserted:
        # One shape for every rejection so this is not an oracle for which pods,
        # tokens, or configurations exist.
        raise HTTPException(status_code=401, detail="pod identity required")

    check = validator
    if check is None:
        from hushh_mcp.consent.token import validate_token_with_db  # noqa: PLC0415

        check = validate_token_with_db

    scope = str(payload.expected_scope or "").strip() or None
    try:
        valid, reason, parsed = await _run(check, payload.token, scope)
    except Exception as exc:  # noqa: BLE001
        # The DB is the authority. If it cannot be reached, the honest answer is
        # "I do not know", NOT "valid" -- so this is a 503 the pod surfaces rather
        # than a False the pod would read as a clean denial.
        logger.warning("pod_consent.authority_unavailable %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="consent authority is unavailable") from exc

    if not valid or parsed is None:
        logger.info("pod_consent.denied pod=%s reason=%s", asserted, str(reason or "")[:120])
        return {"valid": False, "reason": "consent is not valid"}

    user_id = getattr(parsed, "user_id", "") or ""
    # The HusshID this user's agent actually is. The pod compares it against its
    # OWN HUSSH_ID and refuses a mismatch -- see pod_turn._validate_consent.
    #
    # Without this the pod had no way to tell whose turn it was serving: it took
    # the user_id the hub reported and only checked it was non-empty, so a valid
    # token belonging to person A, presented to person B's pod, would have driven
    # B's pod on A's behalf. The hub is the only party that can resolve user ->
    # HusshID, so it is the only party that can supply the binding.
    return {
        "valid": True,
        "userId": user_id,
        "hushhId": await _hushh_id_for(user_id, registry=registry),
        "scope": str(getattr(parsed, "scope", "") or ""),
        "agentId": getattr(parsed, "agent_id", "") or "",
    }


async def _hushh_id_for(user_id: str, *, registry: Any = None) -> str:
    """The HusshID registered to this user, or empty when it cannot be resolved.

    Empty is NOT treated as "any pod may serve them" by the caller -- the pod
    refuses on a mismatch AND on an unresolvable binding, because an unknown owner
    is exactly the case where serving anyway would be the bug.
    """
    if not user_id:
        return ""
    repo = registry
    if repo is None:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        repo = PersonalAgentRegistryRepo()
    try:
        row = await repo.get(user_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pod_consent.hushh_id_lookup_failed %s", type(exc).__name__)
        return ""
    return str((row or {}).get("hushh_id") or "")


async def _run(check: Any, token: str, scope: Optional[str]):
    """Call the validator whether it is sync or async, without guessing at a wrapper."""
    import inspect  # noqa: PLC0415

    result = check(token, expected_scope=scope) if scope else check(token)
    if inspect.isawaitable(result):
        return await result
    return result


@router.post("/verify")
async def pod_consent_verify_route(
    request: Request,
    payload: PodConsentVerifyRequest = Body(...),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    """A pod asks the hub whether a consent token is still good."""
    return await verify_consent_for_pod(request, authorization, payload)
