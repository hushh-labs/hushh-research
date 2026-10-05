"""The owner's "Bring your own AI" doors in the private pod: set, read, clear.

``PUT /api/one/pod/ai-selection`` takes the sealed envelope (contract C1,
``pod_ai_selection_seal``), opens it with this pod's own key, runs one tiny live call
on the chosen provider and model, and only then records the selection in the pod's
sealed log (``pod_ai_selection``). From then on every turn runs on exactly that
selection, with no fallback (``pod_turn_target.owner_selected_turn``).
``DELETE`` clears it; ``GET`` reports it. No response, log line or error ever
carries the key.

Only the owner's own door opens these: this pod's app-role session, never a
hub-relayed consent token. Anyone holding the pod's public key can seal an envelope,
so a hub-admitted write could swap in a key the owner never chose and quietly send
their prompts to someone else's account; a hub token is refused with 403 here even
when it is valid for the owner. Changing or clearing the selection is configuration,
so it asks for the binding's ``pod.config`` scope and a held incarnation, exactly as
``POST /api/one/pod/config`` does; reading it asks for ``pod.status``. A disabled pod
answers 404 before any door opens. Admission is settled before the body is even read,
so a refusal of the envelope is never an answer to a caller the pod has not admitted.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from api.routes.one import pod_memory as _memory
from hushh_mcp.services.pod_commit_log import PodLogConflict, PodLogFenced

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])

#: A sealed envelope is a few hundred bytes; anything far larger is not one.
_MAX_BODY_BYTES = 16 * 1024


def _refused(code: str) -> JSONResponse:
    """The typed 422 the app explains. Nothing about the envelope rides along."""
    return JSONResponse(status_code=422, content={"code": code})


def _log() -> Any:
    from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

    return _resolve_log()


def _no_store() -> HTTPException:
    return HTTPException(status_code=503, detail={"code": "AI_SELECTION_STORE_UNAVAILABLE"})


def _gemini_default() -> str:
    """The manifest's model, which a Gemini selection with no model of its own runs on."""
    from api.routes.one.pod_turn import _resolve_model  # noqa: PLC0415

    return _resolve_model()[1]


async def _admit_owner_local(
    consent_token: str, *, verifier: Any, session: Optional[dict], scope: str
) -> dict:
    """The memory doors' admission, minus the hub door (see the module docstring)."""
    if not (consent_token or "").strip():
        raise HTTPException(status_code=401, detail="consent token required")
    if session is None:
        raise HTTPException(status_code=403, detail={"code": "OWNER_SESSION_REQUIRED"})
    return await _memory._admit_owner(
        consent_token, verifier=verifier, session=session, scope=scope
    )


async def _owner_local_door(
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
        raise HTTPException(status_code=403, detail={"code": "OWNER_SESSION_REQUIRED"})
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


async def _envelope(request: Request) -> Any:
    body = await request.body()
    if not body or len(body) > _MAX_BODY_BYTES:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


async def run_ai_selection_put(
    *,
    envelope: Any = None,
    read_envelope: Optional[Callable[[], Awaitable[Any]]] = None,
    consent_token: str,
    verifier: Any = None,
    session: Optional[dict] = None,
    log: Any = None,
    check: Any = None,
    now_ms: Optional[int] = None,
) -> Any:
    """Admit, open, check live, then record. Nothing is stored unless every step passed.

    ``read_envelope`` is how the route hands over the body: it is read only after
    admission, so an unadmitted caller never learns anything about an envelope.
    """
    from hushh_mcp.services import pod_ai_selection as store  # noqa: PLC0415
    from hushh_mcp.services.pod_ai_selection_check import live_check  # noqa: PLC0415
    from hushh_mcp.services.pod_ai_selection_seal import (  # noqa: PLC0415
        AiSelectionRefused,
        open_ai_selection,
    )
    from hushh_mcp.services.pod_self_registration import pod_keypair  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG  # noqa: PLC0415

    await _admit_owner_local(
        consent_token, verifier=verifier, session=session, scope=SCOPE_POD_CONFIG
    )
    if read_envelope is not None:
        envelope = await read_envelope()
    hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
    log = log if log is not None else _log()
    if log is None:
        raise _no_store()
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    keypair = pod_keypair()
    try:
        # Lenient: a damaged newest record must never stop the owner replacing it.
        _current, floor = store.selection_from_records(await log.replay(), hushh_id=hushh_id)
        opened = open_ai_selection(
            envelope,
            pod_private_key=keypair.private_key,
            hushh_id=hushh_id,
            pod_key_id=keypair.key_id,
            now_ms=now,
            floor_issued_at_ms=floor,
        )
        code = await (check or live_check)(opened, gemini_default=_gemini_default())
        if code:
            store.note_ai_selection_failure(code)
            return _refused(code)
        selection = await store.record_ai_selection(
            log, hushh_id=hushh_id, opened=opened, checked_at_ms=now
        )
    except AiSelectionRefused as exc:
        logger.info("pod_ai_selection.refused code=%s", exc.code)
        store.note_ai_selection_failure(exc.code)
        return _refused(exc.code)
    except (PodLogConflict, PodLogFenced):
        raise HTTPException(status_code=409, detail={"code": "AI_SELECTION_NOT_RECORDED"}) from None
    store.note_ai_selection_failure(None)
    logger.info("pod_ai_selection.active provider=%s", selection.provider)
    public = store.public_selection(selection)
    return {
        "status": "active",
        "provider": public["provider"],
        "model": public["model"],
        "checkedAtMs": public["checkedAtMs"],
    }


async def run_ai_selection_delete(
    *,
    consent_token: str,
    verifier: Any = None,
    session: Optional[dict] = None,
    log: Any = None,
) -> dict:
    """Clear the selection; the agent returns to its default model path."""
    from hushh_mcp.services import pod_ai_selection as store  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG  # noqa: PLC0415

    await _admit_owner_local(
        consent_token, verifier=verifier, session=session, scope=SCOPE_POD_CONFIG
    )
    log = log if log is not None else _log()
    if log is None:
        raise _no_store()
    await store.clear_ai_selection(log, hushh_id=(os.environ.get("HUSSH_ID") or "").strip())
    store.note_ai_selection_failure(None)
    logger.info("pod_ai_selection.cleared")
    return {"status": "cleared"}


async def run_ai_selection_get(
    *,
    consent_token: str,
    verifier: Any = None,
    session: Optional[dict] = None,
    log: Any = None,
) -> dict:
    """What the owner chose, when it was checked, and the newest refusal. Never the key."""
    from hushh_mcp.services import pod_ai_selection as store  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_STATUS  # noqa: PLC0415

    await _admit_owner_local(
        consent_token, verifier=verifier, session=session, scope=SCOPE_POD_STATUS
    )
    if store.ai_selection_load_failed():
        # Heal on read: the startup load failed, so ask the log again before answering.
        await store.load_active_ai_selection(log)
    if store.ai_selection_load_failed():
        raise HTTPException(status_code=503, detail={"code": "OWNER_AI_SELECTION_UNAVAILABLE"})
    return {
        **store.public_selection(store.current_ai_selection()),
        "lastFailure": store.last_ai_selection_failure(),
    }


@router.put("/ai-selection")
async def pod_ai_selection_put_route(
    request: Request,
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> Any:
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG  # noqa: PLC0415

    return await run_ai_selection_put(
        read_envelope=lambda: _envelope(request),
        **await _owner_local_door(
            x_consent_token, authorization, scope=SCOPE_POD_CONFIG, held=True
        ),
    )


@router.delete("/ai-selection")
async def pod_ai_selection_delete_route(
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG  # noqa: PLC0415

    return await run_ai_selection_delete(
        **await _owner_local_door(x_consent_token, authorization, scope=SCOPE_POD_CONFIG, held=True)
    )


@router.get("/ai-selection")
async def pod_ai_selection_get_route(
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_STATUS  # noqa: PLC0415

    return await run_ai_selection_get(
        **await _owner_local_door(
            x_consent_token, authorization, scope=SCOPE_POD_STATUS, held=False
        )
    )
