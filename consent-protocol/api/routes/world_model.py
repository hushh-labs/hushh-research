"""
Legacy World Model compatibility routes.

These routes preserve older `/api/world-model/*` callers by delegating to the
canonical PKM implementation under `/api/pkm/*`.
"""

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from api.middleware import require_vault_owner_token
from api.routes.pkm_routes_shared import (
    DomainDataResponse,
    PersonalKnowledgeModelMetadataResponse,
    StockContextRequest,
    StockContextResponse,
    StoreDomainRequest,
    StoreDomainResponse,
    UserScopesResponse,
)
from api.routes.pkm_routes_shared import (
    get_domain_data as _get_domain_data,
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
    get_user_scopes as _get_user_scopes,
)
from api.routes.pkm_routes_shared import (
    store_domain as _store_domain,
)
from hushh_mcp.services.domain_contracts import domain_registry_payload

router = APIRouter(prefix="/api/world-model", tags=["world-model-compat"])


class WorldModelDomainsResponse(BaseModel):
    domains: list[dict[str, Any]]
    count: int


class UserWorldModelDomainsResponse(BaseModel):
    user_id: str
    domains: list[dict[str, Any]]
    total_attributes: int = 0
    last_updated: str | None = None


@router.get("/domains", response_model=WorldModelDomainsResponse)
async def get_world_model_domains(
    include_empty: bool = Query(default=False),
):
    _ = include_empty
    domains = [
        {
            "key": row["domain_key"],
            "display_name": row["display_name"],
            "icon": row["icon_name"],
            "color": row["color_hex"],
            "description": row["description"],
            "status": row["status"],
            "parent_domain": row.get("parent_domain"),
        }
        for row in domain_registry_payload()
        if not row.get("is_legacy_alias")
    ]
    return WorldModelDomainsResponse(domains=domains, count=len(domains))


@router.get("/domains/{user_id}", response_model=UserWorldModelDomainsResponse)
async def get_user_world_model_domains(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    metadata = await _get_metadata(user_id, token_data)
    domains = [
        domain.model_dump() if hasattr(domain, "model_dump") else dict(domain)
        for domain in metadata.domains
    ]
    return UserWorldModelDomainsResponse(
        user_id=user_id,
        domains=domains,
        total_attributes=metadata.total_attributes,
        last_updated=metadata.last_updated,
    )


@router.get("/metadata/{user_id}", response_model=PersonalKnowledgeModelMetadataResponse)
async def get_world_model_metadata(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_metadata(user_id, token_data)


@router.get("/scopes/{user_id}", response_model=UserScopesResponse)
async def get_world_model_scopes(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_user_scopes(user_id, token_data)


@router.post("/store-domain", response_model=StoreDomainResponse)
async def store_world_model_domain(
    request: StoreDomainRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _store_domain(request, token_data)


@router.get("/data/{user_id}", response_model=dict)
async def get_world_model_data(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_encrypted_data(user_id, token_data)


@router.get("/domain-data/{user_id}/{domain}", response_model=DomainDataResponse)
async def get_world_model_domain_data(
    user_id: str,
    domain: str,
    segment_ids: list[str] | None = Query(default=None),
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_domain_data(user_id, domain, segment_ids, token_data)


@router.post("/get-context", response_model=StockContextResponse)
async def get_world_model_context(
    request: StockContextRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    return await _get_stock_context(request, token_data)
