"""RIA onboarding, request, and workspace routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

router = APIRouter(prefix="/api/ria", tags=["RIA"])


async def _require_ria_verified(
    firebase_uid: str = Depends(require_firebase_auth),
) -> str:
    """Fail-closed dependency: 403 if the caller is not a verified RIA."""
    service = RIAIAMService()
    try:
        await service.require_ria_verified(firebase_uid)
    except IAMSchemaNotReadyError as exc:
        raise HTTPException(status_code=503, detail="Verification service unavailable") from exc
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return firebase_uid


class RIAOnboardingSubmitRequest(BaseModel):
    display_name: str = Field(..., min_length=1)
    requested_capabilities: list[str] = Field(default_factory=lambda: ["advisory"])
    individual_legal_name: str | None = None
    individual_crd: str | None = None
    advisory_firm_legal_name: str | None = None
    advisory_firm_iapd_number: str | None = None
    broker_firm_legal_name: str | None = None
    broker_firm_crd: str | None = None
    legal_name: str | None = None
    finra_crd: str | None = None
    sec_iard: str | None = None
    bio: str | None = None
    strategy: str | None = None
    disclosures_url: str | None = None
    primary_firm_name: str | None = None
    primary_firm_role: str | None = None
    force_live_verification: bool = False


class RIAOnboardingVerifyNameRequest(BaseModel):
    query: str = Field(..., min_length=1)
    crd_number: str | None = None


class RIAConsentRequestCreate(BaseModel):
    subject_user_id: str = Field(..., min_length=1)
    requester_actor_type: str = Field(default="ria")
    subject_actor_type: str = Field(default="investor")
    scope_template_id: str = Field(..., min_length=1)
    selected_scope: str | None = None
    duration_mode: str = Field(default="preset")
    duration_hours: int | None = None
    firm_id: str | None = None
    reason: str | None = None


class RIAConsentBundleCreate(BaseModel):
    subject_user_id: str = Field(..., min_length=1)
    scope_template_id: str = Field(..., min_length=1)
    selected_scopes: list[str] = Field(default_factory=list)
    selected_account_ids: list[str] = Field(default_factory=list)
    firm_id: str | None = None
    reason: str | None = None


class RIAPicksParseRequest(BaseModel):
    csv_content: str = Field(..., min_length=1)
    source_filename: str | None = None
    package_note: str | None = None
    avoid_rows: list[dict] = Field(default_factory=list)
    screening_sections: list[dict] = Field(default_factory=list)


class RIAPicksSyncRequest(BaseModel):
    label: str | None = None
    package_note: str | None = None
    top_picks: list[dict] = Field(default_factory=list)
    avoid_rows: list[dict] = Field(default_factory=list)
    screening_sections: list[dict] = Field(default_factory=list)
    source_data_version: int | None = None
    source_manifest_revision: int | None = None
    retire_legacy: bool = True


class RIAInviteTarget(BaseModel):
    display_name: str | None = None
    email: str | None = None
    phone: str | None = None
    investor_user_id: str | None = None
    source: str | None = None
    delivery_channel: str | None = None


class RIAInviteCreateRequest(BaseModel):
    scope_template_id: str = Field(..., min_length=1)
    duration_mode: str = Field(default="preset")
    duration_hours: int | None = None
    firm_id: str | None = None
    reason: str | None = None
    targets: list[RIAInviteTarget] = Field(default_factory=list)


class RIAMarketplaceDiscoverabilityRequest(BaseModel):
    enabled: bool
    headline: str | None = None
    strategy_summary: str | None = None


class RIAPicksShareStateRequest(BaseModel):
    enabled: bool


class RIAClientDetailResponse(BaseModel):
    investor_user_id: str
    investor_display_name: str | None = None
    investor_email: str | None = None
    investor_secondary_label: str | None = None
    investor_headline: str | None = None
    relationship_status: str
    granted_scope: str | None = None
    last_request_id: str | None = None
    consent_granted_at: str | None = None
    consent_expires_at: int | str | None = None
    revoked_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    disconnect_allowed: bool = True
    is_self_relationship: bool = False
    next_action: str | None = None
    relationship_shares: list[dict] = Field(default_factory=list)
    picks_feed_status: str | None = None
    picks_feed_granted_at: str | None = None
    has_active_pick_upload: bool = False
    granted_scopes: list[dict] = Field(default_factory=list)
    request_history: list[dict] = Field(default_factory=list)
    invite_history: list[dict] = Field(default_factory=list)
    requestable_scope_templates: list[dict] = Field(default_factory=list)
    available_scope_metadata: list[dict] = Field(default_factory=list)
    kai_specialized_bundle: dict = Field(default_factory=dict)
    account_branches: list[dict] = Field(default_factory=list)
    available_domains: list[str] = Field(default_factory=list)
    domain_summaries: dict = Field(default_factory=dict)
    total_attributes: int = 0
    workspace_ready: bool = False
    pkm_updated_at: str | None = None


def _iam_schema_not_ready_response(message: str | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": message or "IAM schema is not ready",
            "code": "IAM_SCHEMA_NOT_READY",
            "hint": "Run `python db/migrate.py --iam` and `python db/verify/verify_iam_schema.py`.",
        },
    )


@router.post("/onboarding/submit")
async def submit_onboarding(
    payload: RIAOnboardingSubmitRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.submit_ria_onboarding(
            firebase_uid,
            display_name=payload.display_name,
            requested_capabilities=payload.requested_capabilities,
            individual_legal_name=payload.individual_legal_name or payload.legal_name,
            individual_crd=payload.individual_crd or payload.finra_crd,
            advisory_firm_legal_name=payload.advisory_firm_legal_name or payload.primary_firm_name,
            advisory_firm_iapd_number=payload.advisory_firm_iapd_number or payload.sec_iard,
            broker_firm_legal_name=payload.broker_firm_legal_name,
            broker_firm_crd=payload.broker_firm_crd,
            bio=payload.bio,
            strategy=payload.strategy,
            disclosures_url=payload.disclosures_url,
            primary_firm_role=payload.primary_firm_role,
            force_live_verification=payload.force_live_verification,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/onboarding/verify-name")
async def verify_onboarding_name(
    payload: RIAOnboardingVerifyNameRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        _ = firebase_uid
        return await service.verify_ria_name(payload.query, crd_number=payload.crd_number)
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/onboarding/dev-activate")
async def dev_activate_onboarding(
    payload: RIAOnboardingSubmitRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.activate_ria_dev_onboarding(
            firebase_uid,
            display_name=payload.display_name,
            requested_capabilities=payload.requested_capabilities,
            individual_legal_name=payload.individual_legal_name or payload.legal_name,
            individual_crd=payload.individual_crd or payload.finra_crd,
            advisory_firm_legal_name=payload.advisory_firm_legal_name or payload.primary_firm_name,
            advisory_firm_iapd_number=payload.advisory_firm_iapd_number or payload.sec_iard,
            broker_firm_legal_name=payload.broker_firm_legal_name,
            broker_firm_crd=payload.broker_firm_crd,
            bio=payload.bio,
            strategy=payload.strategy,
            disclosures_url=payload.disclosures_url,
            primary_firm_role=payload.primary_firm_role,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/onboarding/status")
async def onboarding_status(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return await service.get_ria_onboarding_status(firebase_uid)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


@router.get("/home")
async def ria_home(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return await service.get_ria_home(firebase_uid)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


@router.get("/firms")
async def ria_firms(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return {"items": await service.list_ria_firms(firebase_uid)}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


@router.get("/clients")
async def ria_clients(
    q: str | None = Query(default=None),
    status: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=100),
    firebase_uid: str = Depends(_require_ria_verified),
):
    service = RIAIAMService()
    try:
        params: dict[str, str | int] = {}
        if q:
            params["query"] = q
        if status:
            params["status"] = status
        if page != 1:
            params["page"] = page
        if limit != 50:
            params["limit"] = limit
        return await service.list_ria_clients(firebase_uid, **params)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


@router.get("/clients/{investor_user_id}", response_model=RIAClientDetailResponse)
async def ria_client_detail(
    investor_user_id: str,
    firebase_uid: str = Depends(_require_ria_verified),
):
    service = RIAIAMService()
    try:
        return await service.get_ria_client_detail(firebase_uid, investor_user_id)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/requests")
async def ria_requests(firebase_uid: str = Depends(require_firebase_auth)):
    service = ConsentCenterService()
    try:
        return {"items": await service.list_outgoing_requests(firebase_uid)}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


@router.get("/request-bundles")
async def ria_request_bundles(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return {"items": await service.list_ria_request_bundles(firebase_uid)}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


@router.get("/request-scopes")
async def ria_request_scopes(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return {"items": await service.list_requestable_scope_templates(firebase_uid)}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/invites")
async def ria_invites(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return {"items": await service.list_ria_invites(firebase_uid)}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))


@router.post("/invites")
async def create_ria_invites(
    payload: RIAInviteCreateRequest,
    firebase_uid: str = Depends(_require_ria_verified),
):
    service = RIAIAMService()
    try:
        return await service.create_ria_invites(
            firebase_uid,
            scope_template_id=payload.scope_template_id,
            duration_mode=payload.duration_mode,
            duration_hours=payload.duration_hours,
            firm_id=payload.firm_id,
            reason=payload.reason,
            targets=[target.model_dump() for target in payload.targets],
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/marketplace/discoverability")
async def update_ria_marketplace_discoverability(
    payload: RIAMarketplaceDiscoverabilityRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.set_ria_marketplace_discoverability(
            firebase_uid,
            enabled=payload.enabled,
            headline=payload.headline,
            strategy_summary=payload.strategy_summary,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/requests")
async def create_ria_request(
    payload: RIAConsentRequestCreate,
    firebase_uid: str = Depends(_require_ria_verified),
):
    service = RIAIAMService()
    try:
        return await service.create_ria_consent_request(
            firebase_uid,
            subject_user_id=payload.subject_user_id,
            requester_actor_type=payload.requester_actor_type,
            subject_actor_type=payload.subject_actor_type,
            scope_template_id=payload.scope_template_id,
            selected_scope=payload.selected_scope,
            duration_mode=payload.duration_mode,
            duration_hours=payload.duration_hours,
            firm_id=payload.firm_id,
            reason=payload.reason,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/request-bundles")
async def create_ria_request_bundle(
    payload: RIAConsentBundleCreate,
    firebase_uid: str = Depends(_require_ria_verified),
):
    service = RIAIAMService()
    try:
        return await service.create_ria_consent_bundle(
            firebase_uid,
            subject_user_id=payload.subject_user_id,
            scope_template_id=payload.scope_template_id,
            selected_scopes=payload.selected_scopes,
            selected_account_ids=payload.selected_account_ids,
            firm_id=payload.firm_id,
            reason=payload.reason,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/universe")
async def renaissance_universe(
    tier: str | None = Query(None),
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Return the Renaissance investable universe (default Kai stock list)."""
    from hushh_mcp.services.renaissance_service import get_renaissance_service
    from hushh_mcp.services.symbol_master_service import get_symbol_master_service

    service = get_renaissance_service()
    symbol_master = get_symbol_master_service()
    if tier:
        stocks = await service.get_by_tier(tier.upper())
    else:
        stocks = await service.get_all_investable()
    filtered_stocks = [stock for stock in stocks if symbol_master.classify(stock.ticker).tradable]
    return {
        "items": [
            {
                "ticker": s.ticker,
                "company_name": s.company_name,
                "sector": s.sector,
                "tier": s.tier,
                "tier_rank": s.tier_rank,
                "fcf_billions": s.fcf_billions,
                "investment_thesis": s.investment_thesis,
            }
            for s in filtered_stocks
        ],
        "total": len(filtered_stocks),
    }


@router.get("/universe/avoid")
async def renaissance_avoid_list(firebase_uid: str = Depends(require_firebase_auth)):
    """Return the Renaissance avoid list."""
    from hushh_mcp.services.renaissance_service import get_renaissance_service

    service = get_renaissance_service()
    members = await service.list_members("renaissance_avoid")
    return {
        "items": [
            {
                "ticker": m.ticker,
                "company_name": m.company_name,
                "sector": m.sector,
                "category": m.metadata.get("category") if m.metadata else None,
                "why_avoid": m.metadata.get("why_avoid") if m.metadata else None,
            }
            for m in members
        ],
    }


@router.get("/universe/screening")
async def renaissance_screening(firebase_uid: str = Depends(require_firebase_auth)):
    """Return the Renaissance screening criteria rubric."""
    from hushh_mcp.services.renaissance_service import get_renaissance_service

    service = get_renaissance_service()
    criteria = await service.get_screening_criteria()
    return {"items": criteria}


@router.get("/picks")
async def ria_pick_uploads(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return await service.get_active_ria_pick_package(firebase_uid)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/picks/parse")
async def parse_ria_picks_csv(
    payload: RIAPicksParseRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    _ = firebase_uid
    service = RIAIAMService()
    try:
        if not payload.csv_content.strip():
            raise HTTPException(status_code=400, detail="csv_content is required")
        return {
            "package": await service.parse_ria_pick_csv(
                csv_content=payload.csv_content,
                package_note=payload.package_note,
                avoid_rows=payload.avoid_rows,
                screening_sections=payload.screening_sections,
            )
        }
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/picks")
async def upload_ria_picks(
    payload: RIAPicksSyncRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.sync_ria_pick_share_artifacts(
            firebase_uid,
            label=payload.label,
            package_note=payload.package_note,
            top_picks=payload.top_picks,
            avoid_rows=payload.avoid_rows,
            screening_sections=payload.screening_sections,
            source_data_version=payload.source_data_version,
            source_manifest_revision=payload.source_manifest_revision,
            retire_legacy=payload.retire_legacy,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/workspace/{investor_user_id}")
async def ria_workspace(
    investor_user_id: str,
    firebase_uid: str = Depends(_require_ria_verified),
):
    service = RIAIAMService()
    try:
        return await service.get_ria_workspace(firebase_uid, investor_user_id)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/clients/{investor_user_id}/picks-share")
async def set_ria_client_picks_share(
    investor_user_id: str,
    payload: RIAPicksShareStateRequest,
    firebase_uid: str = Depends(_require_ria_verified),
):
    service = RIAIAMService()
    try:
        return await service.set_ria_pick_share_state(
            firebase_uid,
            investor_user_id=investor_user_id,
            enabled=payload.enabled,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
