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
    firm_id: str | None = None
    reason: str | None = None


class RIAPicksUploadRequest(BaseModel):
    csv_content: str = Field(..., min_length=1)
    source_filename: str | None = None
    label: str | None = None


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
            "hint": "Run `python db/migrate.py --iam` and `python scripts/verify_iam_schema.py`.",
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
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
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
    firebase_uid: str = Depends(require_firebase_auth),
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
    firebase_uid: str = Depends(require_firebase_auth),
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
    firebase_uid: str = Depends(require_firebase_auth),
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
    firebase_uid: str = Depends(require_firebase_auth),
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
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.create_ria_consent_bundle(
            firebase_uid,
            subject_user_id=payload.subject_user_id,
            scope_template_id=payload.scope_template_id,
            selected_scopes=payload.selected_scopes,
            firm_id=payload.firm_id,
            reason=payload.reason,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/picks")
async def ria_pick_uploads(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        uploads = await service.list_ria_pick_uploads(firebase_uid)
        active_rows = await service.get_active_ria_pick_rows(firebase_uid)
        return {"items": uploads, "active_rows": active_rows}
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/picks")
async def upload_ria_picks(
    payload: RIAPicksUploadRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.upload_ria_pick_list(
            firebase_uid,
            csv_content=payload.csv_content,
            source_filename=payload.source_filename,
            label=payload.label,
        )
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/workspace/{investor_user_id}")
async def ria_workspace(
    investor_user_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.get_ria_workspace(firebase_uid, investor_user_id)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
