# consent-protocol/api/routes/pkm.py
"""
Personal Knowledge Model API routes.

Canonical API surface for PKM during cutover. The legacy world-model router
remains available only as a bounded compatibility adapter.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from api.routes import world_model as legacy
from hushh_mcp.services.pkm_agent_lab_service import get_pkm_agent_lab_service

router = APIRouter(prefix="/api/pkm", tags=["pkm"])


class PKMAgentLabStructureRequest(BaseModel):
    user_id: str
    message: str = Field(min_length=1, max_length=12000)
    current_domains: list[str] = Field(default_factory=list)


class PKMAgentLabStructureResponse(BaseModel):
    agent_id: str
    agent_name: str
    model: str
    used_fallback: bool
    error: str | None = None
    candidate_payload: dict
    structure_decision: dict
    manifest_draft: dict | None = None


@router.post("/store-domain", response_model=legacy.StoreDomainResponse)
async def store_domain(
    request: legacy.StoreDomainRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.store_domain(request, token_data)


@router.get("/data/{user_id}", response_model=dict)
async def get_encrypted_data(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.get_encrypted_data(user_id, token_data)


@router.get("/domain-data/{user_id}/{domain}", response_model=legacy.DomainDataResponse)
async def get_domain_data(
    user_id: str,
    domain: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.get_domain_data(user_id, domain, token_data)


@router.get("/manifest/{user_id}/{domain}", response_model=legacy.DomainManifestResponse)
async def get_domain_manifest(
    user_id: str,
    domain: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.get_domain_manifest(user_id, domain, token_data)


@router.delete("/domain-data/{user_id}/{domain}", response_model=legacy.DeleteDomainResponse)
async def delete_domain_data(
    user_id: str,
    domain: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.delete_domain_data(user_id, domain, token_data)


@router.post("/reconcile/{user_id}", response_model=legacy.ReconcileWorldModelResponse)
async def reconcile_pkm_index(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.reconcile_world_model_index(user_id, token_data)


@router.get("/metadata/{user_id}", response_model=legacy.WorldModelMetadataResponse)
async def get_metadata(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.get_metadata(user_id, token_data)


@router.get("/domain-registry", response_model=legacy.DomainRegistryResponse)
async def get_domain_registry(
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.get_domain_registry(token_data)


@router.get("/scopes/{user_id}", response_model=legacy.UserScopesResponse)
async def get_user_scopes(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.get_user_scopes(user_id, token_data)


@router.post("/get-context", response_model=legacy.StockContextResponse)
async def get_stock_context(
    request: legacy.StockContextRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await legacy.get_stock_context(request, token_data)


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
    )
    return PKMAgentLabStructureResponse(**payload)
