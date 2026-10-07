"""The owner's connector doors in the private pod: connect, read, disconnect.

``PUT /api/one/pod/connectors/{connector_id}`` takes a sealed connector login
(``pod_connector_credential_seal``), opens it with this pod's own key, redeems a
Google code with Google itself (PKCE, no secret for Hussh's native clients), checks
who signed in and what they granted, and records the login in the pod's sealed log
(``pod_connector_connect``). ``DELETE`` revokes it at Google (see below), then clears
it. ``GET`` answers one status word: ``connected``, ``needs_reauth`` or ``absent``.

Only the owner's own door opens these (``pod_owner_door``): this pod's app-role
session, never a hub-relayed consent token, because anyone holding the pod's public
key can seal a login, and a hub-admitted write could file someone else's account as
the owner's Gmail. Admission is settled before the body is read, so an unadmitted
caller learns nothing about an envelope. A disabled pod answers 404 first.

Fenced crypto-erasure inventories grants before destroying the log key and records
provider confirmation separately from local erasure. Unavailable revocation does
not prevent local erasure and is never reported as provider completion.

``DELETE`` answers ``providerRevoked: null`` when another connector still signs in
through the same Google grant: Google revokes whole grants, so that login is only
cleared here and the grant stays for the connectors still using it.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from api.routes.one.pod_owner_door import admit_owner_local, owner_local_door
from hushh_mcp.services.pod_commit_log import PodLogConflict, PodLogFenced

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])

#: A sealed login is a few kilobytes at most; anything far larger is not one.
_MAX_BODY_BYTES = 32 * 1024


def _refused(code: str, *, provider_revoked: Optional[bool] = None) -> JSONResponse:
    """The typed 422 the app explains. Nothing about the envelope rides along."""
    content: dict[str, Any] = {"code": code}
    if provider_revoked is False:
        content["providerRevoked"] = False
    return JSONResponse(status_code=422, content=content)


def _log() -> Any:
    from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

    return _resolve_log()


def _hushh_id() -> str:
    return (os.environ.get("HUSSH_ID") or "").strip()


def _no_store() -> HTTPException:
    return HTTPException(status_code=503, detail={"code": "CONNECTOR_STORE_UNAVAILABLE"})


async def _envelope(request: Request) -> Any:
    body = await request.body()
    if not body or len(body) > _MAX_BODY_BYTES:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


async def _admit(consent_token: str, verifier: Any, session: Optional[dict], scope: str) -> None:
    await admit_owner_local(consent_token, verifier=verifier, session=session, scope=scope)


async def _complete_native(
    transition: Any, opened: Any, recorded: Any, *, key_id: str, authority: dict
) -> bool:
    from hushh_mcp.services import pod_connector_credentials as store  # noqa: PLC0415
    from hushh_mcp.services.google_connector_transition import (  # noqa: PLC0415
        TransitionRefused,
        pod_transition,
    )

    await _admit(**authority)
    current = store.active_connector_credential(recorded.connector_id)
    if current is None or (current.credential_id, current.generation, current.status) != (
        recorded.credential_id,
        recorded.generation,
        store.STATUS_CONNECTED,
    ):
        raise TransitionRefused("GOOGLE_TRANSITION_CONNECTION_CHANGED")
    try:
        await pod_transition("complete", transition, opened, pod_key_id=key_id)
    except TransitionRefused:
        return False  # Repeating this exact sealed request retries cleanup only.
    await _admit(**authority)
    current = store.active_connector_credential(recorded.connector_id)
    if current is None or (current.credential_id, current.generation, current.status) != (
        recorded.credential_id,
        recorded.generation,
        store.STATUS_CONNECTED,
    ):
        raise TransitionRefused("GOOGLE_TRANSITION_CONNECTION_CHANGED")
    return True


async def _native_admission(
    transition: Any, opened: Any, *, key_id: str, log: Any, hushh_id: str, authority: dict
) -> None:
    from hushh_mcp.services.google_connector_transition import (  # noqa: PLC0415
        invalidate_pod_grants,
        pod_transition,
    )

    admission = await pod_transition("admit", transition, opened, pod_key_id=key_id)
    await _admit(**authority)
    await invalidate_pod_grants(log, hushh_id=hushh_id, admission=admission)
    await _admit(**authority)


async def run_connector_put(
    connector_id: str,
    *,
    envelope: Any = None,
    read_envelope: Optional[Callable[[], Awaitable[Any]]] = None,
    consent_token: str,
    verifier: Any = None,
    session: Optional[dict] = None,
    log: Any = None,
    post: Any = None,
    now_ms: Optional[int] = None,
) -> Any:
    """Admit, open, redeem, check, record. Nothing is kept unless every step passed."""
    from hushh_mcp.services import pod_connector_connect as connect  # noqa: PLC0415
    from hushh_mcp.services import pod_connector_credentials as store  # noqa: PLC0415
    from hushh_mcp.services.google_connector_transition import (  # noqa: PLC0415
        TransitionRefused,
    )
    from hushh_mcp.services.pod_connector_credential_seal import (  # noqa: PLC0415
        STALE_CREDENTIAL,
        ConnectorCredentialRefused,
        open_connector_credential,
    )
    from hushh_mcp.services.pod_self_registration import pod_keypair  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG  # noqa: PLC0415

    await _admit(consent_token, verifier, session, SCOPE_POD_CONFIG)
    if read_envelope is not None:
        envelope = await read_envelope()
    transition = None
    if isinstance(envelope, dict) and set(envelope) == {"envelope", "transition"}:
        transition, envelope = envelope["transition"], envelope["envelope"]
    log = log if log is not None else _log()
    if log is None:
        raise _no_store()
    hushh_id = _hushh_id()
    keypair = pod_keypair()
    try:
        held, floors = await store.read_connector_credentials(log, hushh_id=hushh_id)
        opened = open_connector_credential(
            envelope,
            pod_private_key=keypair.private_key,
            hushh_id=hushh_id,
            pod_key_id=keypair.key_id,
            connector_id=connector_id,
            now_ms=now_ms if now_ms is not None else int(time.time() * 1000),
            floor_issued_at_ms=0,
        )
        native = opened.kind == "authorization_code" and opened.client_profile in {
            "hussh_ios",
            "hussh_android",
        }
        authority = dict(
            consent_token=consent_token, verifier=verifier, session=session, scope=SCOPE_POD_CONFIG
        )
        current = held.get(connector_id)
        cleanup_only = (
            native
            and current is not None
            and current.status == store.STATUS_CONNECTED
            and current.credential_id == opened.credential_id
            and current.issued_at_ms == opened.issued_at_ms
            and current.client_profile == opened.client_profile
            and current.client_id == opened.client_id
        )
        if opened.issued_at_ms <= floors.get(connector_id, 0) and not cleanup_only:
            raise ConnectorCredentialRefused(STALE_CREDENTIAL)
        if cleanup_only and current is not None:
            recorded = current
        else:
            if native:
                await _native_admission(
                    transition,
                    opened,
                    key_id=keypair.key_id,
                    log=log,
                    hushh_id=hushh_id,
                    authority=authority,
                )
            recorded = await connect.connect(log, hushh_id=hushh_id, opened=opened, post=post)
        cleanup_confirmed = True
        if native:
            cleanup_confirmed = await _complete_native(
                transition, opened, recorded, key_id=keypair.key_id, authority=authority
            )
    except TransitionRefused as exc:
        return JSONResponse(status_code=exc.status, content={"code": exc.code})
    except (ConnectorCredentialRefused, connect.ConnectRefused) as exc:
        logger.info("pod_connectors.refused code=%s", exc.code)
        return _refused(exc.code, provider_revoked=getattr(exc, "provider_revoked", None))
    except (PodLogConflict, PodLogFenced) as exc:
        detail: dict[str, Any] = {"code": "CONNECTOR_NOT_RECORDED"}
        if getattr(exc, "provider_revoked", None) is False:
            detail["providerRevoked"] = False
        raise HTTPException(status_code=409, detail=detail) from None
    logger.info("pod_connectors.connected connector=%s", recorded.connector_id)
    result = {"connectorId": recorded.connector_id, "status": recorded.status}
    if not cleanup_confirmed:
        result["legacyCleanup"] = "unconfirmed"
    return result


async def run_connector_delete(
    connector_id: str,
    *,
    consent_token: str,
    verifier: Any = None,
    session: Optional[dict] = None,
    log: Any = None,
    post: Any = None,
) -> dict:
    """Revoke at Google unless the grant is shared, then clear. Says what Google confirmed."""
    from hushh_mcp.services import pod_connector_connect as connect  # noqa: PLC0415
    from hushh_mcp.services import pod_connector_credentials as store  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG  # noqa: PLC0415

    await _admit(consent_token, verifier, session, SCOPE_POD_CONFIG)
    log = log if log is not None else _log()
    if log is None:
        raise _no_store()
    try:
        revoked = await connect.disconnect(
            log, hushh_id=_hushh_id(), connector_id=connector_id, post=post
        )
    except (PodLogConflict, PodLogFenced):
        raise HTTPException(status_code=409, detail={"code": "CONNECTOR_NOT_RECORDED"}) from None
    logger.info("pod_connectors.cleared connector=%s provider_revoked=%s", connector_id, revoked)
    # Provider revocation yielded: a concurrently approved new login must remain
    # visible rather than reporting the old disconnected credential as current.
    held = store.active_connector_credential(connector_id)
    return {
        "connectorId": connector_id,
        "status": held.status if held else store.STATUS_ABSENT,
        "providerRevoked": revoked,
    }


async def run_connector_get(
    connector_id: str,
    *,
    consent_token: str,
    verifier: Any = None,
    session: Optional[dict] = None,
    log: Any = None,
) -> dict:
    """One status word. Never a token, a subject or a scope."""
    from hushh_mcp.services import pod_connector_credentials as store  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_STATUS  # noqa: PLC0415

    await _admit(consent_token, verifier, session, SCOPE_POD_STATUS)
    try:
        held = store.active_connector_credential(connector_id)
    except store.ConnectorCredentialsUnavailable:
        await store.load_connector_credentials(log)  # heal on read
        try:
            held = store.active_connector_credential(connector_id)
        except store.ConnectorCredentialsUnavailable:
            raise HTTPException(
                status_code=503, detail={"code": "CONNECTOR_CREDENTIALS_UNAVAILABLE"}
            ) from None
    return {
        "connectorId": connector_id,
        "status": held.status if held else store.STATUS_ABSENT,
        **store.connector_permissions(held),
    }


_CONNECTOR_PATH = "/connectors/{connector_id}"
_CONNECTOR_ID = r"^[a-z][a-z0-9_-]{0,63}$"


def _checked(connector_id: str) -> str:
    import re  # noqa: PLC0415

    if not re.fullmatch(_CONNECTOR_ID, connector_id or ""):
        raise HTTPException(status_code=404, detail="not found")
    return connector_id


@router.put(_CONNECTOR_PATH)
async def pod_connector_put_route(
    connector_id: str,
    request: Request,
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> Any:
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG  # noqa: PLC0415

    door = await owner_local_door(x_consent_token, authorization, scope=SCOPE_POD_CONFIG, held=True)
    return await run_connector_put(
        _checked(connector_id), read_envelope=lambda: _envelope(request), **door
    )


@router.delete(_CONNECTOR_PATH)
async def pod_connector_delete_route(
    connector_id: str,
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG  # noqa: PLC0415

    door = await owner_local_door(x_consent_token, authorization, scope=SCOPE_POD_CONFIG, held=True)
    return await run_connector_delete(_checked(connector_id), **door)


@router.get(_CONNECTOR_PATH)
async def pod_connector_get_route(
    connector_id: str,
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_STATUS  # noqa: PLC0415

    door = await owner_local_door(
        x_consent_token, authorization, scope=SCOPE_POD_STATUS, held=False
    )
    return await run_connector_get(_checked(connector_id), **door)


__all__ = [
    "router",
    "run_connector_delete",
    "run_connector_get",
    "run_connector_put",
]
