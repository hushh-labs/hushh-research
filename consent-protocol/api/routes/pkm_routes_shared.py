# consent-protocol/api/routes/pkm_routes_shared.py
"""
Shared PKM request/response models and route handlers.

Implements the current PKM architecture:
- pkm_blobs: encrypted per-domain payloads
- pkm_manifests: explicit structure contracts for scopes
- pkm_index: minimal discovery metadata for UI/bootstrap
"""

import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.domain_contracts import canonical_top_level_domain, domain_registry_payload
from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service
from hushh_mcp.services.pkm_upgrade_service import get_pkm_upgrade_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pkm", tags=["pkm"])


def _isoformat_or_none(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


# ============================================================================
# STOCK CONTEXT ENDPOINT (KAI Analysis)
# ============================================================================


class StockContextRequest(BaseModel):
    ticker: str  # user_id is extracted from VAULT_OWNER token, not request body


class DecisionRecord(BaseModel):
    """Represents a Kai investment decision."""

    id: int
    ticker: str
    decision_type: str
    confidence: float
    created_at: str
    metadata: dict | None


class StockContextResponse(BaseModel):
    ticker: str
    user_risk_profile: str
    holdings: list[dict]
    recent_decisions: list[dict]
    portfolio_allocation: dict[str, int]


def _summary_attribute_count(summary: dict | None) -> int:
    if not isinstance(summary, dict):
        return 0
    for key in ("attribute_count", "holdings_count", "item_count"):
        value = summary.get(key)
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, int):
            return max(0, value)
        if isinstance(value, float):
            if value != value:
                continue
            return max(0, int(value))
        if isinstance(value, str):
            text = value.strip()
            if not text:
                continue
            try:
                return max(0, int(float(text)))
            except Exception:
                continue
    return 0


def _summary_text(summary: dict | None, key: str) -> Optional[str]:
    if not isinstance(summary, dict):
        return None
    value = summary.get(key)
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _summary_string_list(summary: dict | None, key: str) -> list[str]:
    if not isinstance(summary, dict):
        return []
    value = summary.get(key)
    if not isinstance(value, list):
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        normalized = item.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        cleaned.append(normalized)
    return cleaned[:5]


async def get_risk_profile_from_index(user_id: str) -> tuple[str, list[dict], dict[str, int]]:
    """
    Get user context from PKM index domain summaries.

    Returns cached data stored in the financial summary contract:
    - risk_profile: user preference risk from onboarding/profile settings
    - holdings: List of portfolio holdings
    - portfolio_allocation: Allocation percentages

    Falls back to defaults if no cache exists.
    """
    try:
        pkm_service = get_pkm_service()

        # Read cached summary metadata from PKM index.
        index = await pkm_service.get_index_v2(user_id)

        if index and "financial" in (index.domain_summaries or {}):
            financial_summary = index.domain_summaries["financial"]

            risk_profile = (
                financial_summary.get("risk_profile")
                or financial_summary.get("profile_risk_profile")
                or "balanced"
            )

            # Holdings are intentionally stripped from domain_summaries.
            # Canonical summary counters must be used for server-side context.
            cached_holdings: list[dict] = []

            # Build allocation from cached data
            portfolio_allocation = {
                "equities_pct": financial_summary.get("equities_pct", 70),
                "bonds_pct": financial_summary.get("bonds_pct", 20),
                "cash_pct": financial_summary.get("cash_pct", 10),
            }

            return risk_profile, cached_holdings, portfolio_allocation
    except Exception as e:
        logger.warning(f"[PKM Context] Failed to get context from index: {e}")

    # Fallback defaults if no cache exists
    return "balanced", [], {"equities_pct": 70, "bonds_pct": 20, "cash_pct": 10}


async def fetch_decisions(user_id: str, limit: int = 50) -> list[DecisionRecord]:
    """
    Fetch recent decisions for a user from mutation events first.

    Canonical source: PKM mutation event decision projections.
    Returns a list of DecisionRecord objects sorted by creation date (newest first).
    """
    try:
        pkm_service = get_pkm_service()
        records: list[DecisionRecord] = []
        items = await pkm_service.get_recent_decision_records(user_id, limit=limit)
        if not items:
            index = await pkm_service.get_index_v2(user_id)
            domain_summaries = index.domain_summaries if index and index.domain_summaries else {}
            financial_summary = (
                domain_summaries.get("financial")
                if isinstance(domain_summaries.get("financial"), dict)
                else {}
            )
            items = pkm_service._extract_decision_records(financial_summary)

        for d in items:
            try:
                confidence_value = float(d.get("confidence", 0) or 0)
            except Exception:
                confidence_value = 0.0
            records.append(
                DecisionRecord(
                    id=d.get("id", 0),
                    ticker=(d.get("ticker") or "").upper(),
                    decision_type=d.get("decision_type") or d.get("decisionType") or "HOLD",
                    confidence=confidence_value,
                    created_at=d.get("created_at") or d.get("createdAt") or "",
                    metadata=d.get("metadata"),
                )
            )

        # Sort by created_at, newest first
        records.sort(key=lambda x: x.created_at if x.created_at else "", reverse=True)
        return records[:limit]
    except Exception as e:
        logger.warning(f"[PKM Context] Failed to fetch decisions: {e}")
        return []


class EncryptedBlob(BaseModel):
    """Encrypted data blob."""

    ciphertext: str = Field(..., description="AES-256-GCM encrypted data")
    iv: str = Field(..., description="Initialization vector")
    tag: str = Field(..., description="Authentication tag")
    algorithm: str = Field(default="aes-256-gcm", description="Encryption algorithm")
    segments: dict[str, "EncryptedBlob"] = Field(
        default_factory=dict,
        description="Optional segmented PKM ciphertext payloads keyed by segment id",
    )


class PathDescriptorPayload(BaseModel):
    json_path: str
    parent_path: Optional[str] = None
    path_type: str = "leaf"
    exposure_eligibility: bool = True
    consent_label: Optional[str] = None
    sensitivity_label: Optional[str] = None
    source_agent: Optional[str] = None


class StructureDecisionPayload(BaseModel):
    action: str = Field(default="match_existing_domain")
    target_domain: Optional[str] = None
    json_paths: List[str] = Field(default_factory=list)
    top_level_scope_paths: List[str] = Field(default_factory=list)
    externalizable_paths: List[str] = Field(default_factory=list)
    summary_projection: dict = Field(default_factory=dict)
    sensitivity_labels: dict = Field(default_factory=dict)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    source_agent: str = Field(default="pkm_structure_agent")
    contract_version: int = Field(default=1, ge=1)


class DomainManifestPayload(BaseModel):
    manifest_version: int = Field(default=1, ge=1)
    domain_contract_version: int = Field(default=1, ge=1)
    readable_summary_version: int = Field(default=0, ge=0)
    upgraded_at: Optional[str] = None
    summary_projection: dict = Field(default_factory=dict)
    top_level_scope_paths: List[str] = Field(default_factory=list)
    externalizable_paths: List[str] = Field(default_factory=list)
    paths: List[PathDescriptorPayload] = Field(default_factory=list)
    source_agent: Optional[str] = None


class UpgradeContextPayload(BaseModel):
    run_id: str = Field(..., min_length=1)
    prior_domain_contract_version: Optional[int] = Field(default=None, ge=0)
    new_domain_contract_version: Optional[int] = Field(default=None, ge=0)
    prior_readable_summary_version: Optional[int] = Field(default=None, ge=0)
    new_readable_summary_version: Optional[int] = Field(default=None, ge=0)
    retry_count: Optional[int] = Field(default=None, ge=0)


class WriteProjectionPayload(BaseModel):
    projection_type: str = Field(..., min_length=1)
    projection_version: int = Field(default=1, ge=1)
    payload: dict = Field(default_factory=dict)


class StoreDomainRequest(BaseModel):
    """Request to store domain data."""

    user_id: str = Field(..., description="User's ID")
    domain: str = Field(..., description="Domain key (e.g., 'financial')")
    encrypted_blob: EncryptedBlob = Field(..., description="Pre-encrypted data from client")
    summary: dict = Field(..., description="Non-sensitive metadata for index")
    structure_decision: Optional[StructureDecisionPayload] = Field(
        default=None,
        description="Durable structure/intention artifact for this domain write",
    )
    manifest: Optional[DomainManifestPayload] = Field(
        default=None,
        description="Explicit manifest of discovered/externalizable paths for this domain",
    )
    source_agent: Optional[str] = Field(
        default=None,
        description="Optional explicit source agent label for mutation/audit events",
    )
    expected_data_version: Optional[int] = Field(
        default=None,
        ge=0,
        description="Optional optimistic concurrency guard for the current domain blob version",
    )
    upgrade_context: Optional[UpgradeContextPayload] = Field(
        default=None,
        description="Optional non-secret upgrade provenance for generic PKM migration writes",
    )
    write_projections: List[WriteProjectionPayload] = Field(
        default_factory=list,
        description="Optional non-sensitive derived projections for read models and history surfaces",
    )


class StoreDomainResponse(BaseModel):
    """Response from store domain operation."""

    success: bool
    message: Optional[str] = None
    conflict: bool = False
    data_version: Optional[int] = None
    updated_at: Optional[str] = None


EncryptedBlob.model_rebuild()


@router.post("/store-domain", response_model=StoreDomainResponse)
async def store_domain(
    request: StoreDomainRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Store encrypted domain data and update index.

    This endpoint:
    1. Receives PRE-ENCRYPTED data from client
    2. Stores ciphertext in `pkm_blobs`
    3. Updates metadata in `pkm_index`
    4. Backend CANNOT decrypt the data (BYOK principle)
    """
    # Verify token matches user_id
    if token_data.get("user_id") != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    pkm_service = get_pkm_service()

    # Store encrypted blob + metadata
    canonical_domain = canonical_top_level_domain(request.domain)
    store_result = await pkm_service.store_domain_data(
        user_id=request.user_id,
        domain=canonical_domain,
        encrypted_blob={
            "ciphertext": request.encrypted_blob.ciphertext,
            "iv": request.encrypted_blob.iv,
            "tag": request.encrypted_blob.tag,
            "algorithm": request.encrypted_blob.algorithm,
            "segments": {
                segment_id: {
                    "ciphertext": segment_blob.ciphertext,
                    "iv": segment_blob.iv,
                    "tag": segment_blob.tag,
                    "algorithm": segment_blob.algorithm,
                }
                for segment_id, segment_blob in (request.encrypted_blob.segments or {}).items()
            },
        },
        summary=request.summary,
        structure_decision=request.structure_decision.model_dump()
        if request.structure_decision
        else None,
        manifest=request.manifest.model_dump() if request.manifest else None,
        source_agent=request.source_agent,
        expected_data_version=request.expected_data_version,
        upgrade_context=request.upgrade_context.model_dump() if request.upgrade_context else None,
        write_projections=[projection.model_dump() for projection in request.write_projections],
        return_result=True,
    )

    if not store_result.get("success"):
        if store_result.get("conflict"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "PKM_VERSION_CONFLICT",
                    "message": ("PKM changed on another device. Refresh latest data and retry."),
                    "current_data_version": store_result.get("data_version"),
                    "updated_at": _isoformat_or_none(store_result.get("updated_at")),
                },
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to store domain data"
        )

    return StoreDomainResponse(
        success=True,
        message=f"Successfully stored {canonical_domain} domain data",
        conflict=False,
        data_version=store_result.get("data_version"),
        updated_at=_isoformat_or_none(store_result.get("updated_at")),
    )


@router.get("/data/{user_id}", response_model=dict)
async def get_encrypted_data(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Get user's encrypted data blob.

    Returns encrypted blob that can only be decrypted client-side.
    """
    # Verify token matches user_id
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    pkm_service = get_pkm_service()
    data = await pkm_service.get_encrypted_data(user_id)

    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No data found for user")

    return data


class DomainDataResponse(BaseModel):
    encrypted_blob: EncryptedBlob
    storage_mode: str = "domain"
    data_version: Optional[int] = None
    updated_at: Optional[str] = None
    manifest_revision: Optional[int] = None
    segment_ids: List[str] = Field(default_factory=list)


@router.get("/domain-data/{user_id}/{domain}", response_model=DomainDataResponse)
async def get_domain_data(
    user_id: str,
    domain: str,
    segment_ids: Optional[List[str]] = Query(default=None),
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Get user's encrypted data blob for a specific domain.

    Returns encrypted blob that can only be decrypted client-side.
    """
    # Verify token matches user_id
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    pkm_service = get_pkm_service()
    data = await pkm_service.get_domain_data(user_id, domain, segment_ids=segment_ids)

    if data is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No {domain} data found for user"
        )

    return DomainDataResponse(
        encrypted_blob=EncryptedBlob(
            ciphertext=data["ciphertext"],
            iv=data["iv"],
            tag=data["tag"],
            algorithm=data.get("algorithm", "aes-256-gcm"),
            segments={
                segment_id: EncryptedBlob(
                    ciphertext=segment_blob["ciphertext"],
                    iv=segment_blob["iv"],
                    tag=segment_blob["tag"],
                    algorithm=segment_blob.get("algorithm", "aes-256-gcm"),
                )
                for segment_id, segment_blob in (data.get("segments") or {}).items()
            },
        ),
        storage_mode=str(data.get("storage_mode") or "domain"),
        data_version=data.get("data_version"),
        updated_at=_isoformat_or_none(data.get("updated_at")),
        manifest_revision=data.get("manifest_revision"),
        segment_ids=data.get("segment_ids") or [],
    )


class DomainManifestResponse(BaseModel):
    user_id: str
    domain: str
    manifest_version: int = 1
    domain_contract_version: int = 1
    readable_summary_version: int = 0
    upgraded_at: Optional[str] = None
    structure_decision: dict = Field(default_factory=dict)
    summary_projection: dict = Field(default_factory=dict)
    top_level_scope_paths: List[str] = Field(default_factory=list)
    externalizable_paths: List[str] = Field(default_factory=list)
    path_count: int = 0
    externalizable_path_count: int = 0
    segment_ids: List[str] = Field(default_factory=list)
    last_structured_at: Optional[str] = None
    last_content_at: Optional[str] = None
    paths: List[dict] = Field(default_factory=list)
    scope_registry: List[dict] = Field(default_factory=list)


@router.get("/manifest/{user_id}/{domain}", response_model=DomainManifestResponse)
async def get_domain_manifest(
    user_id: str,
    domain: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Get the manifest-backed structure contract for a specific user/domain."""
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    pkm_service = get_pkm_service()
    manifest = await pkm_service.get_domain_manifest(user_id, domain)
    if manifest is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No manifest found for {domain}",
        )
    response_payload = dict(manifest)
    response_payload["last_structured_at"] = _isoformat_or_none(
        response_payload.get("last_structured_at")
    )
    response_payload["last_content_at"] = _isoformat_or_none(
        response_payload.get("last_content_at")
    )
    return DomainManifestResponse(**response_payload)


class ScopeExposureChangePayload(BaseModel):
    scope_handle: Optional[str] = Field(default=None)
    top_level_scope_path: Optional[str] = Field(default=None)
    exposure_enabled: bool


class ScopeExposureRequest(BaseModel):
    user_id: str = Field(..., description="User's ID")
    expected_manifest_version: Optional[int] = Field(default=None, ge=1)
    revoke_matching_active_grants: bool = Field(default=True)
    changes: List[ScopeExposureChangePayload] = Field(default_factory=list)


class ScopeExposureResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    manifest_version: Optional[int] = None
    revoked_grant_count: int = 0
    revoked_grant_ids: List[str] = Field(default_factory=list)
    manifest: dict = Field(default_factory=dict)


@router.post("/domains/{domain}/scope-exposure", response_model=ScopeExposureResponse)
async def update_scope_exposure(
    domain: str,
    request: ScopeExposureRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data.get("user_id") != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    if not request.changes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one scope exposure change is required.",
        )

    pkm_service = get_pkm_service()
    canonical_domain = canonical_top_level_domain(domain)
    result = await pkm_service.update_scope_exposure(
        user_id=request.user_id,
        domain=canonical_domain,
        expected_manifest_version=request.expected_manifest_version,
        changes=[change.model_dump() for change in request.changes],
        revoke_matching_active_grants=request.revoke_matching_active_grants,
    )

    if not result.get("success"):
        code = str(result.get("code") or "")
        if code == "manifest_not_found":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=result.get("message") or f"No manifest found for {canonical_domain}.",
            )
        if code == "manifest_conflict":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "PKM_MANIFEST_CONFLICT",
                    "message": result.get("message") or "PKM manifest changed. Refresh and retry.",
                    "current_manifest_version": result.get("manifest_version"),
                },
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=result.get("message") or "Failed to update PKM scope exposure.",
        )

    return ScopeExposureResponse(
        success=True,
        message=result.get("message") or "Updated PKM scope exposure.",
        manifest_version=result.get("manifest_version"),
        revoked_grant_count=int(result.get("revoked_grant_count") or 0),
        revoked_grant_ids=list(result.get("revoked_grant_ids") or []),
        manifest=dict(result.get("manifest") or {}),
    )


class DeleteDomainResponse(BaseModel):
    """Response from delete domain operation."""

    success: bool
    message: Optional[str] = None


class ReconcilePkmResponse(BaseModel):
    """Response from index/registry reconciliation."""

    success: bool
    message: Optional[str] = None


@router.delete("/domain-data/{user_id}/{domain}", response_model=DeleteDomainResponse)
async def delete_domain_data(
    user_id: str,
    domain: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Delete a specific domain from user's PKM.

    This removes the domain from the index (available_domains and domain_summaries).
    The client should also update their local encrypted blob to remove the domain data.

    **Authentication**: Requires valid VAULT_OWNER token.
    """
    # Verify token matches user_id
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    pkm_service = get_pkm_service()
    success = await pkm_service.delete_domain_data(user_id, domain)

    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete {domain} domain data",
        )

    return DeleteDomainResponse(success=True, message=f"Successfully deleted {domain} domain data")


@router.post("/reconcile/{user_id}", response_model=ReconcilePkmResponse)
async def reconcile_pkm_index(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Reconcile index/domain registry coherence for a user.

    Runtime helper:
    - Normalizes domain summary counters
    - Aligns available_domains with summary keys
    - Recomputes total_attributes
    - Ensures missing domains are present in domain_registry
    """
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    pkm_service = get_pkm_service()
    success = await pkm_service.reconcile_user_index_domains(user_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reconcile PKM index",
        )
    return ReconcilePkmResponse(success=True, message="PKM index reconciled")


# ==================== LEGACY ATTRIBUTE ROUTES (410 GONE) ====================
# Attribute-level delete is done client-side: get domain blob → decrypt → remove key → store domain.
# These routes return 410 so clients migrate to the blob flow.


@router.delete("/attributes/{user_id}/{domain}/{attribute_key}", status_code=410)
async def delete_attribute_legacy(
    user_id: str,
    domain: str,
    attribute_key: str,
):
    """
    Deprecated. Attribute-level delete is client-side only (BYOK).
    Use: get domain data → decrypt → remove key → re-encrypt → store domain.
    """
    raise HTTPException(
        status_code=410,
        detail="Gone. Use client-side blob update: get domain data, remove key, re-encrypt, store domain.",
    )


# ==================== METADATA ENDPOINT ====================


class DomainMetadata(BaseModel):
    """Domain metadata for UI display."""

    key: str = Field(..., description="Domain key (e.g., 'financial')")
    display_name: str = Field(..., description="Human-readable domain name")
    icon: str = Field(default="folder", description="Icon name for UI")
    color: str = Field(default="#6366F1", description="Color hex for UI")
    attribute_count: int = Field(default=0, description="Number of attributes in domain")
    summary: dict = Field(default_factory=dict, description="Domain-specific summary data")
    available_scopes: List[str] = Field(default_factory=list, description="Available MCP scopes")
    last_updated: Optional[str] = Field(default=None, description="ISO timestamp of last update")
    readable_summary: Optional[str] = Field(
        default=None, description="Optional consumer-readable summary for this domain"
    )
    readable_highlights: List[str] = Field(
        default_factory=list,
        description="Optional consumer-readable highlights for this domain",
    )
    readable_updated_at: Optional[str] = Field(
        default=None, description="ISO timestamp of the readable summary refresh"
    )
    readable_source_label: Optional[str] = Field(
        default=None, description="Short label describing where the readable summary came from"
    )
    domain_contract_version: int = Field(default=1, description="Current domain contract version")
    readable_summary_version: int = Field(
        default=0, description="Current readable summary contract version"
    )
    upgraded_at: Optional[str] = Field(
        default=None, description="ISO timestamp of the last successful PKM upgrade for this domain"
    )


class PersonalKnowledgeModelMetadataResponse(BaseModel):
    """Response for PKM metadata."""

    user_id: str
    domains: List[DomainMetadata]
    total_attributes: int
    model_completeness: int = Field(description="Percentage of recommended domains filled (0-100)")
    model_version: int = Field(default=1, description="Current PKM model version for this user")
    target_model_version: int = Field(default=1, description="Latest PKM model version supported")
    upgrade_status: str = Field(default="current")
    upgradable_domains: List[dict] = Field(default_factory=list)
    last_upgraded_at: Optional[str] = None
    suggested_domains: List[str] = Field(
        default_factory=list, description="Domains user should consider adding"
    )
    last_updated: Optional[str] = None


@router.get("/metadata/{user_id}", response_model=PersonalKnowledgeModelMetadataResponse)
async def get_metadata(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Get user's PKM metadata for UI display.

    This endpoint is used by the frontend to:
    1. Determine if user has existing data (for showing dashboard vs import prompt)
    2. Display domain summaries and completeness scores
    3. Suggest additional domains to enrich the PKM

    Returns 404 if user has no PKM data (new user).

    **Authentication**: Requires valid VAULT_OWNER token.
    Domain names, counts, and summaries are user-private metadata.
    """
    # Verify token matches user_id
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )
    pkm_service = get_pkm_service()
    upgrade_service = get_pkm_upgrade_service()

    try:
        # Read PKM index metadata.
        index = await pkm_service.get_index_v2(user_id)
        upgrade_status_payload = await upgrade_service.build_status(user_id)

        if index is None:
            encrypted_data = await pkm_service.get_encrypted_data(user_id)
            domain_rows = (
                pkm_service.supabase.table("pkm_blobs")
                .select("domain,content_revision,updated_at")
                .eq("user_id", user_id)
                .execute()
                .data
                or []
            )
            if encrypted_data is None and not domain_rows:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="No PKM data found for user",
                )
            logger.warning(
                "User %s has PKM storage but no index - returning degraded metadata",
                user_id,
            )
            degraded_domains: List[DomainMetadata] = []
            for row in domain_rows:
                domain_key = str(row.get("domain") or "")
                manifest = await pkm_service.get_domain_manifest(user_id, domain_key)
                degraded_domains.append(
                    DomainMetadata(
                        key=domain_key,
                        display_name=domain_key.replace("_", " ").title(),
                        icon="folder",
                        color="#6366F1",
                        attribute_count=int((manifest or {}).get("path_count") or 0),
                        summary={
                            "storage_mode": "per_domain_blob",
                            "manifest_version": (manifest or {}).get("manifest_version") or 1,
                            "path_count": (manifest or {}).get("path_count") or 0,
                            "externalizable_path_count": (manifest or {}).get(
                                "externalizable_path_count"
                            )
                            or 0,
                        },
                        available_scopes=[],
                        last_updated=str(row.get("updated_at") or ""),
                        readable_summary=_summary_text(
                            (manifest or {}).get("summary_projection"), "readable_summary"
                        )
                        if isinstance((manifest or {}).get("summary_projection"), dict)
                        else None,
                        readable_highlights=_summary_string_list(
                            (manifest or {}).get("summary_projection"), "readable_highlights"
                        )
                        if isinstance((manifest or {}).get("summary_projection"), dict)
                        else [],
                        readable_updated_at=_summary_text(
                            (manifest or {}).get("summary_projection"), "readable_updated_at"
                        )
                        if isinstance((manifest or {}).get("summary_projection"), dict)
                        else None,
                        readable_source_label=_summary_text(
                            (manifest or {}).get("summary_projection"), "readable_source_label"
                        )
                        if isinstance((manifest or {}).get("summary_projection"), dict)
                        else None,
                        domain_contract_version=int(
                            (manifest or {}).get("domain_contract_version") or 1
                        ),
                        readable_summary_version=int(
                            (manifest or {}).get("readable_summary_version") or 0
                        ),
                        upgraded_at=_isoformat_or_none((manifest or {}).get("upgraded_at")),
                    )
                )
            return PersonalKnowledgeModelMetadataResponse(
                user_id=user_id,
                domains=degraded_domains,
                total_attributes=sum(domain.attribute_count for domain in degraded_domains),
                model_completeness=0,
                model_version=upgrade_status_payload.get("model_version") or 1,
                target_model_version=upgrade_status_payload.get("target_model_version") or 1,
                upgrade_status=upgrade_status_payload.get("upgrade_status") or "current",
                upgradable_domains=upgrade_status_payload.get("upgradable_domains") or [],
                last_upgraded_at=_isoformat_or_none(upgrade_status_payload.get("last_upgraded_at")),
                suggested_domains=["financial", "health", "travel"],
                last_updated=(encrypted_data or {}).get("updated_at"),
            )

        # Build domain metadata from index
        domains: List[DomainMetadata] = []
        user_scopes = await pkm_service.scope_generator.get_available_scopes(user_id)

        for domain_key in index.available_domains:
            summary = index.domain_summaries.get(domain_key, {})

            # Lookup domain display info from registry
            try:
                domain_info = await pkm_service.domain_registry.get_domain(domain_key)
            except Exception as e:
                logger.warning(f"Failed to get domain info for {domain_key}: {e}")
                domain_info = None

            # Calculate attribute count from summary
            # Different domains store counts differently
            attr_count = _summary_attribute_count(summary)

            domains.append(
                DomainMetadata(
                    key=domain_key,
                    display_name=domain_info.display_name
                    if domain_info
                    else domain_key.replace("_", " ").title(),
                    icon=domain_info.icon_name if domain_info else "folder",
                    color=domain_info.color_hex if domain_info else "#6366F1",
                    attribute_count=attr_count,
                    summary=summary,
                    available_scopes=[
                        scope
                        for scope in user_scopes
                        if scope == f"attr.{domain_key}.*"
                        or scope.startswith(f"attr.{domain_key}.")
                    ],
                    last_updated=index.last_active_at.isoformat() if index.last_active_at else None,
                    readable_summary=_summary_text(summary, "readable_summary"),
                    readable_highlights=_summary_string_list(summary, "readable_highlights"),
                    readable_updated_at=_summary_text(summary, "readable_updated_at"),
                    readable_source_label=_summary_text(summary, "readable_source_label"),
                    domain_contract_version=int(summary.get("domain_contract_version") or 1),
                    readable_summary_version=int(summary.get("readable_summary_version") or 0),
                    upgraded_at=_summary_text(summary, "upgraded_at"),
                )
            )

        # Calculate total attributes
        total_attrs = index.total_attributes or sum(d.attribute_count for d in domains)

        # Calculate model completeness (based on common domains)
        common_domains = {"financial", "health", "travel", "subscriptions", "food"}
        user_domain_keys = set(index.available_domains)
        filled_common = len(user_domain_keys & common_domains)
        completeness = min(100, int((filled_common / len(common_domains)) * 100))

        # Suggest missing common domains
        suggested = list(common_domains - user_domain_keys)[:3]

        return PersonalKnowledgeModelMetadataResponse(
            user_id=user_id,
            domains=domains,
            total_attributes=total_attrs,
            model_completeness=completeness,
            model_version=upgrade_status_payload.get("model_version") or 1,
            target_model_version=upgrade_status_payload.get("target_model_version") or 1,
            upgrade_status=upgrade_status_payload.get("upgrade_status") or "current",
            upgradable_domains=upgrade_status_payload.get("upgradable_domains") or [],
            last_upgraded_at=_isoformat_or_none(upgrade_status_payload.get("last_upgraded_at")),
            suggested_domains=suggested,
            last_updated=index.last_active_at.isoformat() if index.last_active_at else None,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting metadata for user {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve PKM metadata",
        )


class PkmUpgradeDomainStateResponse(BaseModel):
    domain: str
    current_domain_contract_version: int
    target_domain_contract_version: int
    current_readable_summary_version: int
    target_readable_summary_version: int
    upgraded_at: Optional[str] = None
    needs_upgrade: bool = False


class PkmUpgradeStepResponse(BaseModel):
    run_id: str
    domain: str
    status: str
    from_domain_contract_version: int
    to_domain_contract_version: int
    from_readable_summary_version: int
    to_readable_summary_version: int
    attempt_count: int = 0
    last_completed_content_revision: Optional[int] = None
    last_completed_manifest_version: Optional[int] = None
    checkpoint_payload: dict = Field(default_factory=dict)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class PkmUpgradeRunResponse(BaseModel):
    run_id: str
    user_id: str
    status: str
    from_model_version: int
    to_model_version: int
    current_domain: Optional[str] = None
    initiated_by: str
    resume_count: int = 0
    started_at: Optional[str] = None
    last_checkpoint_at: Optional[str] = None
    completed_at: Optional[str] = None
    last_error: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    steps: List[PkmUpgradeStepResponse] = Field(default_factory=list)


class PkmUpgradeStatusResponse(BaseModel):
    user_id: str
    model_version: int
    target_model_version: int
    upgrade_status: str
    upgradable_domains: List[PkmUpgradeDomainStateResponse] = Field(default_factory=list)
    last_upgraded_at: Optional[str] = None
    run: Optional[PkmUpgradeRunResponse] = None


class StartOrResumeUpgradeRequest(BaseModel):
    user_id: str
    initiated_by: str = Field(default="unlock_warm")


class UpdateUpgradeRunRequest(BaseModel):
    user_id: str
    status: str
    current_domain: Optional[str] = None
    last_error: Optional[str] = None


class UpdateUpgradeStepRequest(BaseModel):
    user_id: str
    status: str
    checkpoint_payload: dict = Field(default_factory=dict)
    attempt_count: Optional[int] = Field(default=None, ge=0)
    last_completed_content_revision: Optional[int] = Field(default=None, ge=0)
    last_completed_manifest_version: Optional[int] = Field(default=None, ge=0)


def _build_upgrade_status_response(payload: dict) -> PkmUpgradeStatusResponse:
    run_payload = payload.get("run")
    run_response = None
    if isinstance(run_payload, dict):
        normalized_steps = []
        for step in run_payload.get("steps") or []:
            if not isinstance(step, dict):
                continue
            normalized_steps.append(
                PkmUpgradeStepResponse(
                    **{
                        **step,
                        "created_at": _isoformat_or_none(step.get("created_at")),
                        "updated_at": _isoformat_or_none(step.get("updated_at")),
                    }
                )
            )
        run_response = PkmUpgradeRunResponse(
            **{
                **run_payload,
                "started_at": _isoformat_or_none(run_payload.get("started_at")),
                "last_checkpoint_at": _isoformat_or_none(run_payload.get("last_checkpoint_at")),
                "completed_at": _isoformat_or_none(run_payload.get("completed_at")),
                "created_at": _isoformat_or_none(run_payload.get("created_at")),
                "updated_at": _isoformat_or_none(run_payload.get("updated_at")),
                "steps": normalized_steps,
            }
        )
    return PkmUpgradeStatusResponse(
        user_id=payload.get("user_id") or "",
        model_version=int(payload.get("model_version") or 1),
        target_model_version=int(payload.get("target_model_version") or 1),
        upgrade_status=str(payload.get("upgrade_status") or "current"),
        upgradable_domains=[
            PkmUpgradeDomainStateResponse(
                **{
                    **domain_payload,
                    "upgraded_at": _isoformat_or_none(domain_payload.get("upgraded_at")),
                }
            )
            for domain_payload in (payload.get("upgradable_domains") or [])
            if isinstance(domain_payload, dict)
        ],
        last_upgraded_at=_isoformat_or_none(payload.get("last_upgraded_at")),
        run=run_response,
    )


@router.get("/upgrade/status/{user_id}", response_model=PkmUpgradeStatusResponse)
async def get_upgrade_status(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    payload = await get_pkm_upgrade_service().build_status(user_id)
    return _build_upgrade_status_response(payload)


@router.post("/upgrade/start-or-resume", response_model=PkmUpgradeStatusResponse)
async def start_or_resume_upgrade(
    request: StartOrResumeUpgradeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data.get("user_id") != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    payload = await get_pkm_upgrade_service().start_or_resume_run(
        request.user_id,
        initiated_by=request.initiated_by,
    )
    return _build_upgrade_status_response(payload)


@router.post("/upgrade/runs/{run_id}/status", response_model=PkmUpgradeStatusResponse)
async def update_upgrade_run_status(
    run_id: str,
    request: UpdateUpgradeRunRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data.get("user_id") != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    service = get_pkm_upgrade_service()
    updated = await service.mark_run_status(
        run_id=run_id,
        status=request.status,
        current_domain=request.current_domain,
        last_error=request.last_error,
    )
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upgrade run not found")
    payload = await service.build_status(request.user_id)
    return _build_upgrade_status_response(payload)


@router.post("/upgrade/runs/{run_id}/steps/{domain}", response_model=PkmUpgradeStatusResponse)
async def update_upgrade_step(
    run_id: str,
    domain: str,
    request: UpdateUpgradeStepRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data.get("user_id") != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    step = await get_pkm_upgrade_service().update_step(
        run_id=run_id,
        domain=canonical_top_level_domain(domain),
        status=request.status,
        checkpoint_payload=request.checkpoint_payload,
        attempt_count=request.attempt_count,
        last_completed_content_revision=request.last_completed_content_revision,
        last_completed_manifest_version=request.last_completed_manifest_version,
    )
    if step is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upgrade step not found")
    payload = await get_pkm_upgrade_service().build_status(request.user_id)
    return _build_upgrade_status_response(payload)


@router.post("/upgrade/runs/{run_id}/complete", response_model=PkmUpgradeStatusResponse)
async def complete_upgrade_run(
    run_id: str,
    request: StartOrResumeUpgradeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data.get("user_id") != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    try:
        payload = await get_pkm_upgrade_service().complete_run(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if payload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upgrade run not found")
    return _build_upgrade_status_response(payload)


@router.post("/upgrade/runs/{run_id}/fail", response_model=PkmUpgradeStatusResponse)
async def fail_upgrade_run(
    run_id: str,
    request: UpdateUpgradeRunRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data.get("user_id") != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    payload = await get_pkm_upgrade_service().fail_run(
        run_id,
        last_error=request.last_error,
    )
    if payload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upgrade run not found")
    return _build_upgrade_status_response(payload)


class UserScopesResponse(BaseModel):
    """Lightweight response with scope strings for a user (agent discovery)."""

    user_id: str
    scopes: List[str] = Field(
        default_factory=list,
        description=(
            "Available scope strings for this user, for example pkm.read, "
            "attr.{domain}.*, attr.{domain}.{subintent}.*, or attr.{domain}.{path}."
        ),
    )
    scope_entries: List[dict] = Field(default_factory=list)


class DomainRegistryEntryResponse(BaseModel):
    domain_key: str
    display_name: str
    icon_name: str
    color_hex: str
    description: str
    status: str
    parent_domain: Optional[str] = None


class DomainRegistryResponse(BaseModel):
    domains: List[DomainRegistryEntryResponse]
    canonical_domain_count: int


@router.get("/domain-registry", response_model=DomainRegistryResponse)
async def get_domain_registry(
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Return canonical top-level PKM domain registry.

    This endpoint is additive and intended for runtime contract introspection.
    """
    # Ensure auth middleware ran.
    if not token_data.get("user_id"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )

    pkm_service = get_pkm_service()
    await pkm_service.domain_registry.ensure_canonical_domains()

    entries = [
        DomainRegistryEntryResponse(
            domain_key=row["domain_key"],
            display_name=row["display_name"],
            icon_name=row["icon_name"],
            color_hex=row["color_hex"],
            description=row["description"],
            status=row["status"],
            parent_domain=row.get("parent_domain"),
        )
        for row in domain_registry_payload()
        if not row.get("is_legacy_alias")
    ]
    canonical_count = len(entries)
    return DomainRegistryResponse(
        domains=entries,
        canonical_domain_count=canonical_count,
    )


@router.get("/scopes/{user_id}", response_model=UserScopesResponse)
async def get_user_scopes(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Get available scope strings for a user (lightweight agent discovery).

    Returns dynamic scope strings derived from user metadata and registry hints.

    **Authentication**: Requires valid VAULT_OWNER token.
    Scope strings reveal which data domains a user has populated,
    so they must be protected like other user metadata.
    """
    # Verify token matches user_id
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    pkm_service = get_pkm_service()
    scopes = await pkm_service.scope_generator.get_available_scopes(user_id)
    scope_entries_getter = getattr(pkm_service.scope_generator, "get_available_scope_entries", None)
    scope_entries = await scope_entries_getter(user_id) if callable(scope_entries_getter) else []
    return UserScopesResponse(user_id=user_id, scopes=sorted(scopes), scope_entries=scope_entries)


@router.post("/get-context", response_model=StockContextResponse)
async def get_stock_context(
    request: StockContextRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Get user's context for stock analysis.

    This endpoint provides PKM context (portfolio holdings, risk profile,
    recent decisions) for a specific stock ticker being analyzed by Kai.

    **Authentication**: Requires valid VAULT_OWNER token. The token contains the
    user_id which is validated by require_vault_owner_token middleware.

    **Request**:
        POST /api/pkm/get-context
        Authorization: Bearer {vault_owner_token}
        Body: {
            "ticker": "AAPL"
        }

    **Response**:
        {
            "ticker": "AAPL",
            "user_risk_profile": "balanced",
            "holdings": [...],
            "recent_decisions": [...],
            "portfolio_allocation": {
                "equities_pct": 70,
                "bonds_pct": 20,
                "cash_pct": 10
            }
        }
    """
    ticker = (request.ticker or "").upper().strip()

    # Extract user_id from validated token (not from request body)
    user_id = token_data.get("user_id")

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Token missing user_id claim"
        )

    # Validate ticker
    if not ticker:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Ticker symbol is required"
        )

    if not ticker.isalpha() or len(ticker) > 5:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid ticker symbol format (1-5 uppercase letters)",
        )

    # Get context from PKM index cached data
    risk_profile, holdings, portfolio_allocation = await get_risk_profile_from_index(user_id)

    # Filter to just the requested ticker if it's in the portfolio
    ticker_holdings = [h for h in holdings if h.get("symbol") == ticker]

    return StockContextResponse(
        ticker=ticker,
        user_risk_profile=risk_profile,
        holdings=[
            {
                "symbol": h.get("symbol"),
                "quantity": float(h.get("quantity", 0)),
                "market_value": float(h.get("market_value", 0)),
                "weight_pct": float(h.get("weight_pct", 0)),
            }
            for h in ticker_holdings
        ],
        recent_decisions=[],  # Can add later when decisions are cached
        portfolio_allocation=portfolio_allocation,
    )
