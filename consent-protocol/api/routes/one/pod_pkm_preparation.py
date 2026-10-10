"""Owner-only Memory preparation. Encryption, consent and commits stay in the app."""

from __future__ import annotations

import hashlib
import inspect
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Request

from api.routes.one.pod_commands import _admitted
from api.routes.one.pod_session import verified_session
from api.routes.one.pod_turn import (
    PodTurnRequest,
    _require_enabled,
    _resolve_model,
    _resolve_owner_target,
)
from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
from hushh_mcp.services.pkm_preparation_contracts import (
    PKMAgentLabStructureRequest,
    PKMAgentLabStructureResponse,
)
from hushh_mcp.services.pod_ai_selection import (
    AiSelectionUnavailable,
    active_ai_selection,
    ai_selection_revision,
)
from hushh_mcp.services.pod_pkm_preparation import OwnerPkmPreparation
from hushh_mcp.services.pod_session_authority import ROLE_APP, SCOPE_PKM_READ

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])


def _selection():
    try:
        return active_ai_selection()
    except AiSelectionUnavailable:
        raise HTTPException(503, detail={"code": "OWNER_AI_SELECTION_UNAVAILABLE"}) from None


def _continuation_binding(authorization, selected, model, revision) -> str:
    # No credential enters continuation identity. Selection revision, model,
    # session and this adapter's source invalidate process-memory cache reuse.
    return hashlib.sha256(
        repr(
            (
                authorization,
                selected.selection_id if selected else None,
                selected.issued_at_ms if selected else None,
                model.provider,
                model.model,
                model.runtime_mode,
                revision,
            )
        ).encode()
        + Path(__file__).read_bytes()
        + Path(inspect.getfile(OwnerPkmPreparation)).read_bytes()
    ).hexdigest()


def _owner_model():
    turn = PodTurnRequest(message="memory-preparation")
    turn, (provider, model, mode) = _resolve_owner_target(turn, *_resolve_model(turn))
    if (provider, mode) not in {
        ("gemini", "byok"),
        ("gemini", "user_adc"),
        ("gemini", "hushh_managed_vertex"),
        ("openai", "byok"),
        ("azure_openai", "user_azure_mi"),
    }:
        raise HTTPException(503, detail={"code": "POD_MEMORY_MODEL_UNAVAILABLE"})
    return ProviderAdkModel(
        model=model,
        provider=provider,
        credential=turn.runtime_credential or "",
        runtime_mode=mode,
        gemini_byok_transport=turn.runtime_credential_transport,
        vertex_project=turn.vertex_project,
        vertex_location=turn.vertex_location,
    )


@router.post("/memory/proposals", response_model=PKMAgentLabStructureResponse)
async def prepare_memory(
    body: PKMAgentLabStructureRequest,
    request: Request,
    authorization: str | None = Header(default=None),
):
    _require_enabled()
    async with _admitted(authorization, request) as claims:
        if body.user_id != claims["user_id"]:
            raise HTTPException(403, detail={"code": "POD_MEMORY_OWNER_MISMATCH"})
        selected = _selection()
        revision = ai_selection_revision()
        model = _owner_model()
        if _selection() != selected or ai_selection_revision() != revision:
            raise HTTPException(409, detail={"code": "OWNER_AI_SELECTION_CHANGED"})
        authority, _ = verified_session(authorization, role=ROLE_APP, scope=SCOPE_PKM_READ)

        async def require_access():
            current, current_claims = verified_session(
                authorization, role=ROLE_APP, scope=SCOPE_PKM_READ
            )
            if current is not authority or current_claims != claims:
                raise HTTPException(403, detail={"code": "POD_MEMORY_OWNER_MISMATCH"})
            await authority.require_held()
            if _selection() != selected or ai_selection_revision() != revision:
                raise HTTPException(409, detail={"code": "OWNER_AI_SELECTION_CHANGED"})

        service = OwnerPkmPreparation(
            model=model, user_id=claims["user_id"], require_access=require_access
        )
        await require_access()
        payload = await service.generate_structure_preview(
            user_id=claims["user_id"],
            message=body.message,
            current_domains=body.current_domains,
            current_manifests=body.current_manifests,
            simulated_state=body.simulated_state,
            memory_profile=body.memory_profile,
            model_override=model.model,
            continuation_scope=_continuation_binding(authorization, selected, model, revision),
        )
        await require_access()
        if any(
            payload.get(key)
            for key in ("used_fallback", "intent_used_fallback", "structure_used_fallback")
        ):
            raise HTTPException(503, detail={"code": "PKM_PROPOSAL_UNAVAILABLE"})
        # Sharing impact is fetched by the owner browser through the existing
        # metadata API. This pod has no hub database or commit authority.
        return PKMAgentLabStructureResponse(**payload)
