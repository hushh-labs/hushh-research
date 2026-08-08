"""RIA onboarding, request, and workspace routes with bounded path parameters (CWE-400)."""

from __future__ import annotations

import asyncio
import logging
import secrets
from typing import Annotated, Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import limiter
from api.routes.account import _verify_phone_claim_id_token
from db.connection import get_pool
from hushh_mcp.services.actor_identity_service import (
    ActorIdentityAliasError,
    ActorIdentityService,
)
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.ria_claim_email_service import queue_claim_verification_email
from hushh_mcp.services.ria_claim_service import (
    RIAClaimEmailError,
    RIAClaimService,
    claim_test_code,
    is_claim_test_email,
    mask_email,
    normalize_nanp_phone,
    validate_claim_ticket,
    verify_test_possession,
)
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ria", tags=["RIA"])

_InvestorUserId = Annotated[str, Path(min_length=1, max_length=128)]


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
    display_name: str = Field(..., min_length=1, max_length=256)
    requested_capabilities: list[str] = Field(default_factory=lambda: ["advisory"], max_length=20)
    individual_legal_name: str | None = Field(None, max_length=256)
    individual_crd: str | None = Field(None, max_length=50)
    advisory_firm_legal_name: str | None = Field(None, max_length=256)
    advisory_firm_iapd_number: str | None = Field(None, max_length=50)
    broker_firm_legal_name: str | None = Field(None, max_length=256)
    broker_firm_crd: str | None = Field(None, max_length=50)
    legal_name: str | None = Field(None, max_length=256)
    finra_crd: str | None = Field(None, max_length=50)
    sec_iard: str | None = Field(None, max_length=50)
    bio: str | None = Field(None, max_length=5000)
    strategy: str | None = Field(None, max_length=5000)
    disclosures_url: str | None = Field(None, max_length=2048)
    primary_firm_name: str | None = Field(None, max_length=256)

    @field_validator("disclosures_url")
    @classmethod
    def _validate_disclosures_url_scheme(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not v.startswith(("http://", "https://")):
            raise ValueError("disclosures_url must use http or https scheme")
        return v

    primary_firm_role: str | None = Field(None, max_length=128)
    force_live_verification: bool = False
    # Onboarding v2: license-first fields
    license_number: str | None = Field(None, max_length=128)
    regulator: str | None = Field(None, max_length=128)
    onboarding_type: str = Field("individual", max_length=64)
    services_offered: list[str] = Field(default_factory=list, max_length=50)
    fee_structure: list[str] = Field(default_factory=list, max_length=50)
    min_engagement_amount: float | None = None
    min_engagement_currency: str = Field("USD", max_length=10)
    certifications: list[str] = Field(default_factory=list, max_length=50)
    contact_email: str | None = Field(None, max_length=320)
    contact_phone: str | None = Field(None, max_length=30)
    business_city: str | None = Field(None, max_length=128)
    business_area: str | None = Field(None, max_length=128)
    business_address: str | None = Field(None, max_length=512)
    business_pin_zip: str | None = Field(None, max_length=20)
    business_latitude: float | None = None
    business_longitude: float | None = None


class RIAProfileUpdateRequest(BaseModel):
    """Self-service profile edit. All fields optional; only fields explicitly
    present in the request body are updated (a sent "", [] or null clears the
    column). Regulatory/identity fields are intentionally NOT editable here."""

    display_name: str | None = Field(None, max_length=256)
    bio: str | None = Field(None, max_length=5000)
    strategy: str | None = Field(None, max_length=5000)
    services_offered: list[str] | None = Field(None, max_length=50)
    fee_structure: list[str] | None = Field(None, max_length=50)
    min_engagement_amount: float | None = None
    min_engagement_currency: str | None = Field(None, max_length=10)
    certifications: list[str] | None = Field(None, max_length=50)
    contact_email: str | None = Field(None, max_length=320)
    contact_phone: str | None = Field(None, max_length=30)
    business_city: str | None = Field(None, max_length=128)
    business_area: str | None = Field(None, max_length=128)
    business_address: str | None = Field(None, max_length=512)
    business_pin_zip: str | None = Field(None, max_length=20)
    business_latitude: float | None = None
    business_longitude: float | None = None


class RIAOnboardingVerifyNameRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=256)
    crd_number: str | None = Field(None, max_length=50)
    force_live_verification: bool = False


class RIAOnboardingVerifyLicenseRequest(BaseModel):
    license_number: str = Field(..., min_length=1, max_length=128)
    regulator: str | None = Field(None, max_length=128)
    force_live_verification: bool = False


class RIAProfileRefreshLicenseRequest(BaseModel):
    license_number: str = Field(..., min_length=1, max_length=128)
    regulator: str | None = Field(None, max_length=128)
    force_live_verification: bool = False


class RIAConsentRequestCreate(BaseModel):
    subject_user_id: str = Field(..., min_length=1, max_length=128)
    requester_actor_type: Literal["investor", "ria"] = "ria"
    subject_actor_type: Literal["investor", "ria"] = "investor"
    scope_template_id: str = Field(..., min_length=1, max_length=128)
    selected_scope: str | None = Field(None, max_length=128)
    duration_mode: str = Field("preset", max_length=50)
    duration_hours: int | None = None
    firm_id: str | None = Field(None, max_length=128)
    reason: str | None = Field(None, max_length=1000)


class RIAConsentBundleCreate(BaseModel):
    subject_user_id: str = Field(..., min_length=1, max_length=128)
    scope_template_id: str = Field(..., min_length=1, max_length=128)
    selected_scopes: list[str] = Field(default_factory=list, max_length=50)
    selected_account_ids: list[str] = Field(default_factory=list, max_length=100)
    firm_id: str | None = Field(None, max_length=128)
    reason: str | None = Field(None, max_length=1000)


class RIAPicksParseRequest(BaseModel):
    csv_content: str = Field(..., min_length=1, max_length=5_242_880)  # 5 MiB
    source_filename: str | None = Field(None, max_length=256)
    package_note: str | None = Field(None, max_length=1000)
    avoid_rows: list[dict] = Field(default_factory=list, max_length=5000)
    screening_sections: list[dict] = Field(default_factory=list, max_length=100)


class RIAPicksSyncRequest(BaseModel):
    label: str | None = Field(None, max_length=256)
    package_note: str | None = Field(None, max_length=1000)
    top_picks: list[dict] = Field(default_factory=list, max_length=5000)
    avoid_rows: list[dict] = Field(default_factory=list, max_length=5000)
    screening_sections: list[dict] = Field(default_factory=list, max_length=100)
    source_data_version: int | None = None
    source_manifest_revision: int | None = None


class RIAInviteTarget(BaseModel):
    display_name: str | None = Field(None, max_length=256)
    email: str | None = Field(None, max_length=320)
    phone: str | None = Field(None, max_length=20)
    investor_user_id: str | None = Field(None, max_length=128)
    source: str | None = Field(None, max_length=100)
    delivery_channel: str | None = Field(None, max_length=50)


class RIAInviteCreateRequest(BaseModel):
    scope_template_id: str = Field(..., min_length=1, max_length=128)
    duration_mode: str = Field("preset", max_length=50)
    duration_hours: int | None = None
    firm_id: str | None = Field(None, max_length=128)
    reason: str | None = Field(None, max_length=1000)
    targets: list[RIAInviteTarget] = Field(default_factory=list, max_length=500)


class RIAMarketplaceDiscoverabilityRequest(BaseModel):
    enabled: bool
    headline: str | None = Field(None, max_length=512)
    strategy_summary: str | None = Field(None, max_length=5000)


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


def _iam_schema_not_ready_response() -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": "RIA verification service is temporarily unavailable",
            "code": "IAM_SCHEMA_NOT_READY",
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
            license_number=payload.license_number,
            regulator=payload.regulator,
            onboarding_type=payload.onboarding_type,
            services_offered=payload.services_offered,
            fee_structure=payload.fee_structure,
            min_engagement_amount=payload.min_engagement_amount,
            min_engagement_currency=payload.min_engagement_currency,
            certifications=payload.certifications,
            contact_email=payload.contact_email,
            contact_phone=payload.contact_phone,
            business_city=payload.business_city,
            business_area=payload.business_area,
            business_address=payload.business_address,
            business_pin_zip=payload.business_pin_zip,
            business_latitude=payload.business_latitude,
            business_longitude=payload.business_longitude,
        )
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
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
        return await service.verify_ria_name(
            payload.query,
            crd_number=payload.crd_number,
            use_cache=not payload.force_live_verification,
        )
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/onboarding/verify-license")
@limiter.limit("10/minute")
async def verify_onboarding_license(
    payload: RIAOnboardingVerifyLicenseRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.verify_ria_license(
            firebase_uid,
            license_number=payload.license_number,
            regulator=payload.regulator,
            force_live_verification=payload.force_live_verification,
        )
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/onboarding/status")
async def onboarding_status(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return await service.get_ria_onboarding_status(firebase_uid)
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()


@router.post("/profile/refresh-license")
@limiter.limit("6/minute")
async def refresh_profile_license(
    payload: RIAProfileRefreshLicenseRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        _ = request
        return await service.refresh_ria_profile_from_license(
            firebase_uid,
            license_number=payload.license_number,
            regulator=payload.regulator,
            force_live_verification=payload.force_live_verification,
        )
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        if exc.status_code == 409:
            return JSONResponse(
                status_code=409,
                content={
                    "error": str(exc),
                    "code": "RIA_ONBOARDING_REQUIRED",
                    "route": "/ria/onboarding",
                },
            )
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/profile/update")
async def update_profile(
    payload: RIAProfileUpdateRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Self-service edit of an established advisor's own profile fields. Does not
    re-run licence verification; returns the refreshed onboarding status."""
    service = RIAIAMService()
    try:
        return await service.update_ria_self_profile(
            firebase_uid,
            payload.model_dump(exclude_unset=True),
        )
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/profile/delete")
async def delete_profile(firebase_uid: str = Depends(require_firebase_auth)):
    """Self-service deletion of the caller's RIA sub-agent profile.

    Auto-disconnects active clients (revokes consent), deletes the RIA profile and
    its data, and drops the 'ria' persona (the investor/One account survives).
    POST (not DELETE) to match the client authFetch GET/POST contract."""
    service = RIAIAMService()
    try:
        return await service.delete_ria_self_profile(firebase_uid)
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/home")
async def ria_home(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return await service.get_ria_home(firebase_uid)
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()


@router.get("/firms")
async def ria_firms(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return {"items": await service.list_ria_firms(firebase_uid)}
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()


@router.get("/clients")
async def ria_clients(
    q: str | None = Query(default=None, max_length=200),
    status: str | None = Query(default=None, max_length=50),
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
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()


@router.get("/clients/{investor_user_id}", response_model=RIAClientDetailResponse)
async def ria_client_detail(
    investor_user_id: _InvestorUserId,
    firebase_uid: str = Depends(_require_ria_verified),
):
    service = RIAIAMService()
    try:
        return await service.get_ria_client_detail(firebase_uid, investor_user_id)
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/requests")
async def ria_requests(firebase_uid: str = Depends(require_firebase_auth)):
    service = ConsentCenterService()
    try:
        return {"items": await service.list_outgoing_requests(firebase_uid)}
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()


@router.get("/request-bundles")
async def ria_request_bundles(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return {"items": await service.list_ria_request_bundles(firebase_uid)}
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()


@router.get("/request-scopes")
async def ria_request_scopes(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return {"items": await service.list_requestable_scope_templates(firebase_uid)}
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/invites")
async def ria_invites(firebase_uid: str = Depends(require_firebase_auth)):
    service = RIAIAMService()
    try:
        return {"items": await service.list_ria_invites(firebase_uid)}
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()


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
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
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
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
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
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
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
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
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
async def get_active_ria_pick_package(firebase_uid: str = Depends(require_firebase_auth)):
    """Return the authenticated RIA's encrypted active Picks package."""
    service = RIAIAMService()
    try:
        return await service.get_active_ria_pick_package(firebase_uid)
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
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
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
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
        )
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/workspace/{investor_user_id}")
async def ria_workspace(
    investor_user_id: _InvestorUserId,
    firebase_uid: str = Depends(_require_ria_verified),
):
    service = RIAIAMService()
    try:
        return await service.get_ria_workspace(firebase_uid, investor_user_id)
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Claim-by-phone: resolve an office number to SEC claim targets and claim one.
# Possession of the filed number is proven by this backend (test passcode on
# allowlisted numbers outside production, or a Firebase phone-auth token) and
# only then asserted upstream as `phone_otp` evidence.
# ---------------------------------------------------------------------------


class RIAClaimLookupRequest(BaseModel):
    phone: str = Field(min_length=3, max_length=32)


class RIAClaimOtpStartRequest(BaseModel):
    phone: str = Field(min_length=3, max_length=32)


class RIAClaimVerifyRequest(BaseModel):
    phone: str = Field(min_length=3, max_length=32)
    claim_type: Literal["individual", "firm"]
    firm_crd: int = Field(ge=1, le=99_999_999)
    individual_crd: int | None = Field(None, ge=1, le=999_999_999)
    verification_id: str | None = Field(None, max_length=256)
    verification_code: str | None = Field(None, max_length=16)
    phone_id_token: str | None = Field(None, max_length=20_000)


class RIAClaimCompleteRequest(BaseModel):
    phone: str = Field(min_length=3, max_length=32)
    claim_ticket: str = Field(min_length=1, max_length=512)
    claim_type: Literal["individual", "firm"]
    firm_crd: int = Field(ge=1, le=99_999_999)
    individual_crd: int | None = Field(None, ge=1, le=999_999_999)


@router.post("/claim/lookup")
@limiter.limit("20/minute")
async def ria_claim_lookup(
    payload: RIAClaimLookupRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    _ = firebase_uid
    service = RIAClaimService()
    try:
        return await service.lookup(payload.phone)
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/claim/otp/start")
@limiter.limit("20/minute")
async def ria_claim_otp_start(
    payload: RIAClaimOtpStartRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAClaimService()
    try:
        return service.start_otp(firebase_uid, payload.phone)
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


async def _account_phone_matches(firebase_uid: str, phone_digits: str) -> bool:
    """True when this account's already-verified phone IS the number being claimed.

    The phone mandate verifies possession of the account's number and records it
    server-side. When an adviser then claims the same number, asking for a second
    passcode proves nothing the backend does not already hold. This reads our own
    record — never anything the browser asserts — so the possession model is
    unchanged.
    """
    try:
        identity = (await ActorIdentityService().get_many([firebase_uid])).get(firebase_uid) or {}
    except Exception:  # noqa: BLE001 - identity cache is advisory here; fail closed
        return False
    if identity.get("phone_verified") is not True:
        return False
    stored: str = normalize_nanp_phone(str(identity.get("phone_number") or ""))
    return bool(stored) and stored == phone_digits


async def _prove_claim_possession(
    payload: RIAClaimVerifyRequest, phone_digits: str, firebase_uid: str
) -> str:
    """Return the proof channel after verifying possession, or raise 401."""
    if payload.phone_id_token:
        token_phone, _session_uid = await _verify_phone_claim_id_token(payload.phone_id_token)
        if normalize_nanp_phone(token_phone) != phone_digits:
            raise HTTPException(
                status_code=401,
                detail={
                    "code": "CLAIM_PHONE_MISMATCH",
                    "message": "The verified number does not match this claim.",
                },
            )
        return "firebase_phone_auth"
    if payload.verification_id and payload.verification_code:
        if verify_test_possession(phone_digits, payload.verification_id, payload.verification_code):
            return "test_code"
        raise HTTPException(
            status_code=401,
            detail={
                "code": "CLAIM_INVALID_CODE",
                "message": "That code didn't work. Check it and try again.",
            },
        )
    # No passcode supplied: accept the account's own verified phone when it is
    # the number being claimed. This is what removes the second passcode from
    # the journey for an adviser who just verified that exact line.
    if await _account_phone_matches(firebase_uid, phone_digits):
        return "verified_account_phone"
    raise HTTPException(
        status_code=422,
        detail={
            "code": "CLAIM_PROOF_REQUIRED",
            "message": "A verification code or phone token is required.",
        },
    )


@router.post("/claim/verify")
@limiter.limit("20/minute")
async def ria_claim_verify(
    payload: RIAClaimVerifyRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    phone_digits = normalize_nanp_phone(payload.phone)
    if not phone_digits:
        raise HTTPException(status_code=400, detail="Enter a valid US phone number.")
    proof_channel = await _prove_claim_possession(payload, phone_digits, firebase_uid)
    service = RIAClaimService()
    try:
        result = await service.evaluate_with_possession(
            user_id=firebase_uid,
            phone_digits=phone_digits,
            claim_type=payload.claim_type,
            firm_crd=payload.firm_crd,
            individual_crd=payload.individual_crd,
        )
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    result["proof_channel"] = proof_channel
    return result


@router.post("/claim/complete")
@limiter.limit("20/minute")
async def ria_claim_complete(
    payload: RIAClaimCompleteRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    phone_digits = normalize_nanp_phone(payload.phone)
    if not phone_digits:
        raise HTTPException(status_code=400, detail="Enter a valid US phone number.")
    if not validate_claim_ticket(payload.claim_ticket, firebase_uid, phone_digits):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "CLAIM_TICKET_INVALID",
                "message": "This claim session expired. Verify the number again.",
            },
        )
    service = RIAClaimService()
    try:
        return await service.complete(
            user_id=firebase_uid,
            phone_digits=phone_digits,
            claim_type=payload.claim_type,
            firm_crd=payload.firm_crd,
            individual_crd=payload.individual_crd,
        )
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Claim email upgrade: verify a work-email alias on the claimed firm's own
# domain, then re-run the upstream evaluation with the extra evidence. The
# plaintext code travels only from the identity service to the mail queue —
# it never appears in any HTTP response.
# ---------------------------------------------------------------------------


class RIAClaimEmailStartRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class RIAClaimEmailConfirmRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    code: str = Field(min_length=1, max_length=16)


@router.post("/claim/email/start")
@limiter.limit("20/minute")
async def ria_claim_email_start(
    payload: RIAClaimEmailStartRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAClaimService()
    try:
        prepared = await service.prepare_email_verification(firebase_uid, payload.email)
    except RIAClaimEmailError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    try:
        alias_result = await ActorIdentityService().request_email_alias_verification(
            user_id=firebase_uid,
            email=prepared["email"],
            verification_source="user_verified",
            source_ref="ria_claim_email",
            include_plaintext_code=True,
        )
    except ActorIdentityAliasError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc

    # Route-internal handoff: pop the plaintext so it cannot leak into the
    # response, and give it only to the mail sender.
    code_plaintext = alias_result.pop("verification_code_plaintext", None)
    if alias_result.get("already_verified"):
        return {"status": "already_verified", "email_masked": prepared["email_masked"]}

    delivery = await queue_claim_verification_email(
        target_email=prepared["email"],
        verification_code=str(code_plaintext or ""),
        firm_name=prepared.get("firm_name"),
    )
    if delivery.get("delivery_status") != "queued":
        # Best-effort mail: the alias ceremony stands, the client may retry.
        return JSONResponse(
            status_code=502,
            content={"status": "send_failed", "email_masked": prepared["email_masked"]},
        )
    return {"status": "sent", "email_masked": prepared["email_masked"]}


@router.post("/claim/email/confirm")
@limiter.limit("20/minute")
async def ria_claim_email_confirm(
    payload: RIAClaimEmailConfirmRequest,
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    # Demo fallback (never production): an allowlisted address may also confirm
    # with the fixed claim test code, so the badge journey stays walkable when
    # mail delivery is unavailable. The real emailed code always works too.
    test_code = claim_test_code()
    test_code_accepted = bool(
        test_code
        and is_claim_test_email(payload.email)
        and secrets.compare_digest(str(payload.code or "").strip(), test_code)
    )
    try:
        await ActorIdentityService().confirm_email_alias_verification(
            user_id=firebase_uid,
            email=payload.email,
            verification_code=payload.code,
            accept_without_code=test_code_accepted,
        )
    except ActorIdentityAliasError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc

    service = RIAClaimService()
    try:
        result = await service.upgrade_with_email_evidence(firebase_uid, email=payload.email)
    except RIAClaimEmailError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except IAMSchemaNotReadyError:
        return _iam_schema_not_ready_response()
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return {
        "verified": bool(result.get("verified")),
        "verification_status": str(result.get("verification_status") or ""),
        "verification_level": result.get("verification_level"),
    }


# ---------------------------------------------------------------------------
# Claim dossier: the background scan row a verified claim dispatched. Own row
# only; a failed scan or send is visible and retryable, never silent.
# ---------------------------------------------------------------------------


_DOSSIER_RETRYABLE_STATUSES = ("scan_failed", "send_failed", "send_blocked_test_unset")
_DOSSIER_MAIL_STATUSES = {
    "sent": "sent",
    "send_failed": "failed",
    "send_blocked_test_unset": "blocked",
    "blocked_no_email": "blocked",
}


async def _fetch_own_dossier_row(conn: Any, user_id: str, *, for_update: bool = False) -> Any:
    """Latest dossier row belonging to the caller — never anyone else's."""
    query = """
        SELECT id, status, scan_id, result_summary, result_markdown, requested_at,
               completed_at, mail_recipient, mail_intended_recipient
        FROM ria_claim_dossiers
        WHERE user_id = $1
        ORDER BY requested_at DESC, id DESC
        LIMIT 1
    """
    if for_update:
        query += " FOR UPDATE"
    return await conn.fetchrow(query, user_id)


def _shape_dossier_row(row: Any) -> dict[str, Any]:
    """Own-row projection: status, result, and the mail outcome — no internals."""
    status = str(row["status"] or "")
    recipient = str(row["mail_intended_recipient"] or row["mail_recipient"] or "")
    requested_at = row["requested_at"]
    completed_at = row["completed_at"]
    return {
        "status": status,
        "summary": row["result_summary"],
        "markdown": row["result_markdown"],
        "requested_at": requested_at.isoformat() if requested_at else None,
        "completed_at": completed_at.isoformat() if completed_at else None,
        "mail": {
            "status": _DOSSIER_MAIL_STATUSES.get(status, "pending"),
            "recipient_masked": mask_email(recipient) if recipient else None,
        },
    }


async def _load_dossier_claim_context(user_id: str) -> dict[str, Any] | None:
    """Latest persisted claim snapshot — the worker's re-dispatch input."""
    try:
        # Route-internal reuse of the claim service's own snapshot loader.
        context = await RIAClaimService()._load_claim_context(user_id)
    except Exception:  # noqa: BLE001 - a missing snapshot is a 409, never a 500
        return None
    return context if isinstance(context, dict) else None


def _redispatch_dossier(*, dossier_id: int, user_id: str, context: dict[str, Any]) -> None:
    """Spawn the dossier worker again for an already-claimed row."""
    from hushh_mcp.services import ria_dossier_service

    metadata_raw = context.get("metadata")
    metadata = metadata_raw if isinstance(metadata_raw, dict) else {}
    service = ria_dossier_service.RIADossierService()
    task = asyncio.create_task(
        service._run_worker(
            dossier_id=dossier_id,
            user_id=user_id,
            ria_profile_id=str(context.get("ria_profile_id") or ""),
            claim_type=str(metadata.get("claim_type") or ""),
            reference_metadata=metadata,
        )
    )
    ria_dossier_service._track_background_task(task)


# Dossier rows whose poll this instance is already resuming, so a page that
# reloads twice does not stack workers on one row.
_DOSSIER_RESUMING: set[int] = set()


async def _resume_stalled_dossier(row: Any, user_id: str) -> None:
    """Re-enter the poll for a row left mid-scan, if one is stalled.

    The worker is an in-process background task on a CPU-throttled Cloud Run
    service: once an instance stops receiving requests its CPU is withdrawn,
    the poll freezes mid-flight, and the row is stranded in `scanning` forever
    with the scan itself finishing perfectly well upstream. The read that
    renders the card is a request, so it is also the thing that can revive the
    poll — the scan id is already durable on the row, so resuming costs one
    poll rather than a new scan.
    """
    if str(row["status"] or "") != "scanning" or row["completed_at"] is not None:
        return
    scan_id = str(row["scan_id"] or "").strip()
    dossier_id = int(row["id"])
    if not scan_id or dossier_id in _DOSSIER_RESUMING:
        return
    context = await _load_dossier_claim_context(user_id)
    if context is None:
        return

    from hushh_mcp.services import ria_dossier_service

    metadata_raw = context.get("metadata")
    metadata = metadata_raw if isinstance(metadata_raw, dict) else {}
    service = ria_dossier_service.RIADossierService()
    _DOSSIER_RESUMING.add(dossier_id)

    async def _run() -> None:
        try:
            await service._run_worker(
                dossier_id=dossier_id,
                user_id=user_id,
                ria_profile_id=str(context.get("ria_profile_id") or ""),
                claim_type=str(metadata.get("claim_type") or ""),
                reference_metadata=metadata,
                resume_scan_id=scan_id,
            )
        finally:
            _DOSSIER_RESUMING.discard(dossier_id)

    ria_dossier_service._track_background_task(asyncio.create_task(_run()))


@router.get("/dossier")
@limiter.limit("20/minute")
async def ria_dossier_status(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """The caller's own dossier row; 404 until a verified claim creates one."""
    _ = request
    pool = await get_pool()
    try:
        async with pool.acquire() as conn:
            row = await _fetch_own_dossier_row(conn, firebase_uid)
    except asyncpg.UndefinedTableError:
        row = None
    if row is None:
        raise HTTPException(status_code=404, detail="No dossier yet.")
    try:
        await _resume_stalled_dossier(row, firebase_uid)
    except Exception:  # noqa: BLE001 - reviving the poll never fails the read
        logger.warning("ria.dossier_resume_failed", exc_info=True)
    return _shape_dossier_row(row)


@router.post("/dossier/retry")
@limiter.limit("20/minute")
async def ria_dossier_retry(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Flip a failed dossier back to queued and re-run the worker.

    Allowed only from the visible failure states; the flip happens under
    FOR UPDATE so a double-tap re-dispatches exactly once.
    """
    _ = request
    context = await _load_dossier_claim_context(firebase_uid)
    pool = await get_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await _fetch_own_dossier_row(conn, firebase_uid, for_update=True)
                if row is None:
                    raise HTTPException(status_code=404, detail="No dossier yet.")
                status = str(row["status"] or "")
                if status not in _DOSSIER_RETRYABLE_STATUSES:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "DOSSIER_NOT_RETRYABLE",
                            "message": "Only a failed dossier can be retried.",
                        },
                    )
                if context is None:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "CLAIM_CONTEXT_MISSING",
                            "message": "Claim your profile before retrying the dossier.",
                        },
                    )
                await conn.execute(
                    """
                    UPDATE ria_claim_dossiers
                    SET status = 'queued', error = NULL, completed_at = NULL
                    WHERE id = $1
                    """,
                    row["id"],
                )
    except asyncpg.UndefinedTableError:
        raise HTTPException(status_code=404, detail="No dossier yet.") from None
    _redispatch_dossier(dossier_id=int(row["id"]), user_id=firebase_uid, context=context)
    shaped = _shape_dossier_row(row)
    shaped["status"] = "queued"
    shaped["completed_at"] = None
    shaped["mail"]["status"] = "pending"
    return shaped
