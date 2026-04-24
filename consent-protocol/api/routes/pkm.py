# consent-protocol/api/routes/pkm.py
"""
Personal Knowledge Model API routes.

Canonical API surface for PKM.
"""

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.pkm_routes_shared import (
    DeleteDomainResponse,
    DomainDataResponse,
    DomainManifestResponse,
    DomainRegistryResponse,
    PersonalKnowledgeModelMetadataResponse,
    PkmUpgradeStatusResponse,
    ReconcilePkmResponse,
    StartOrResumeUpgradeRequest,
    StockContextRequest,
    StockContextResponse,
    StoreDomainRequest,
    StoreDomainResponse,
    UpdateUpgradeRunRequest,
    UpdateUpgradeStepRequest,
    UserScopesResponse,
)
from api.routes.pkm_routes_shared import (
    complete_upgrade_run as _complete_upgrade_run,
)
from api.routes.pkm_routes_shared import (
    delete_domain_data as _delete_domain_data,
)
from api.routes.pkm_routes_shared import (
    fail_upgrade_run as _fail_upgrade_run,
)
from api.routes.pkm_routes_shared import (
    get_domain_data as _get_domain_data,
)
from api.routes.pkm_routes_shared import (
    get_domain_manifest as _get_domain_manifest,
)
from api.routes.pkm_routes_shared import (
    get_domain_registry as _get_domain_registry,
)
from api.routes.pkm_routes_shared import (
    get_encrypted_data as _get_encrypted_data,
)
from api.routes.pkm_routes_shared import (
    get_metadata as _get_metadata,
)
from api.routes.pkm_routes_shared import (
    get_stock_context as _get_stock_context,
)
from api.routes.pkm_routes_shared import (
    get_upgrade_status as _get_upgrade_status,
)
from api.routes.pkm_routes_shared import (
    get_user_scopes as _get_user_scopes,
)
from api.routes.pkm_routes_shared import (
    reconcile_pkm_index as _reconcile_pkm_index,
)
from api.routes.pkm_routes_shared import (
    start_or_resume_upgrade as _start_or_resume_upgrade,
)
from api.routes.pkm_routes_shared import (
    store_domain as _store_domain,
)
from api.routes.pkm_routes_shared import (
    update_upgrade_run_status as _update_upgrade_run_status,
)
from api.routes.pkm_routes_shared import (
    update_upgrade_step as _update_upgrade_step,
)
from api.routes.pkm_routes_shared import (
    validate_store_domain as _validate_store_domain,
)
from hushh_mcp.services.pkm_agent_lab_service import get_pkm_agent_lab_service

router = APIRouter(prefix="/api/pkm", tags=["pkm"])


async def require_pkm_metadata_access(
    authorization: str | None = Header(
        None,
        description="Bearer Firebase ID token or VAULT_OWNER token for PKM metadata access",
    ),
) -> dict:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    if authorization.startswith("Bearer HCT:"):
        token_data = await require_vault_owner_token(
            authorization=authorization,
            hushh_consent=None,
        )
        return {"user_id": token_data.get("user_id"), "auth_type": "vault_owner"}

    firebase_uid = await require_firebase_auth(authorization)
    return {"user_id": firebase_uid, "auth_type": "firebase"}


class PKMAgentLabStructureRequest(BaseModel):
    user_id: str
    message: str = Field(min_length=1, max_length=12000)
    current_domains: list[str] = Field(default_factory=list)
    simulated_state: dict | None = None


class PKMAgentLabStructureResponse(BaseModel):
    agent_id: str
    agent_name: str
    model: str
    used_fallback: bool
    intent_used_fallback: bool = False
    structure_used_fallback: bool = False
    error: str | None = None
    routing_decision: str = "non_financial_or_ephemeral"
    intent_frame: dict = Field(default_factory=dict)
    merge_decision: dict = Field(default_factory=dict)
    candidate_payload: dict
    structure_decision: dict
    write_mode: str = "confirm_first"
    primary_json_path: str | None = None
    target_entity_scope: str | None = None
    validation_hints: list[str] = Field(default_factory=list)
    manifest_draft: dict | None = None
    preview_cards: list[dict] = Field(default_factory=list)
    preview_summary: dict = Field(default_factory=dict)
    performance: dict = Field(default_factory=dict)
    context_plan: dict = Field(default_factory=dict)


@router.post("/store-domain", response_model=StoreDomainResponse)
async def store_domain(
    request: StoreDomainRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _store_domain(request, token_data)


@router.post("/store-domain/validate", response_model=StoreDomainResponse)
async def validate_store_domain(
    payload: dict = Body(...),
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _validate_store_domain(payload, token_data)


@router.get("/data/{user_id}", response_model=dict)
async def get_encrypted_data(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_encrypted_data(user_id, token_data)


@router.get("/domain-data/{user_id}/{domain}", response_model=DomainDataResponse)
async def get_domain_data(
    user_id: str,
    domain: str,
    segment_ids: list[str] | None = Query(default=None),
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_domain_data(user_id, domain, segment_ids, token_data)


@router.get("/manifest/{user_id}/{domain}", response_model=DomainManifestResponse)
async def get_domain_manifest(
    user_id: str,
    domain: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_domain_manifest(user_id, domain, token_data)


@router.delete("/domain-data/{user_id}/{domain}", response_model=DeleteDomainResponse)
async def delete_domain_data(
    user_id: str,
    domain: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _delete_domain_data(user_id, domain, token_data)


@router.post("/reconcile/{user_id}", response_model=ReconcilePkmResponse)
async def reconcile_pkm_index(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _reconcile_pkm_index(user_id, token_data)


@router.get("/metadata/{user_id}", response_model=PersonalKnowledgeModelMetadataResponse)
async def get_metadata(
    user_id: str,
    token_data: dict = Depends(require_pkm_metadata_access),
):
    return await _get_metadata(user_id, token_data)


@router.get("/upgrade/status/{user_id}", response_model=PkmUpgradeStatusResponse)
async def get_upgrade_status(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_upgrade_status(user_id, token_data)


@router.post("/upgrade/start-or-resume", response_model=PkmUpgradeStatusResponse)
async def start_or_resume_upgrade(
    request: StartOrResumeUpgradeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _start_or_resume_upgrade(request, token_data)


@router.post("/upgrade/runs/{run_id}/status", response_model=PkmUpgradeStatusResponse)
async def update_upgrade_run_status(
    run_id: str,
    request: UpdateUpgradeRunRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _update_upgrade_run_status(run_id, request, token_data)


@router.post("/upgrade/runs/{run_id}/steps/{domain}", response_model=PkmUpgradeStatusResponse)
async def update_upgrade_step(
    run_id: str,
    domain: str,
    request: UpdateUpgradeStepRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _update_upgrade_step(run_id, domain, request, token_data)


@router.post("/upgrade/runs/{run_id}/complete", response_model=PkmUpgradeStatusResponse)
async def complete_upgrade_run(
    run_id: str,
    request: StartOrResumeUpgradeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _complete_upgrade_run(run_id, request, token_data)


@router.post("/upgrade/runs/{run_id}/fail", response_model=PkmUpgradeStatusResponse)
async def fail_upgrade_run(
    run_id: str,
    request: UpdateUpgradeRunRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _fail_upgrade_run(run_id, request, token_data)


@router.get("/domain-registry", response_model=DomainRegistryResponse)
async def get_domain_registry(
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_domain_registry(token_data)


@router.get("/scopes/{user_id}", response_model=UserScopesResponse)
async def get_user_scopes(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_user_scopes(user_id, token_data)


@router.post("/get-context", response_model=StockContextResponse)
async def get_stock_context(
    request: StockContextRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_stock_context(request, token_data)


@router.post("/agent-lab/structure", response_model=PKMAgentLabStructureResponse)
async def preview_pkm_structure(
    request: PKMAgentLabStructureRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data.get("user_id") != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )
    service = get_pkm_agent_lab_service()
    payload = await service.generate_structure_preview(
        user_id=request.user_id,
        message=request.message,
        current_domains=request.current_domains,
        simulated_state=request.simulated_state,
    )
    return PKMAgentLabStructureResponse(**payload)
