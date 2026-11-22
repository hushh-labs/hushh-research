"""Owner-local pod routes for Stage 2b Dual-Lock Circle Auto-Approve rules.

Every route opens strictly through ``owner_local_door`` (this pod's app-role
session, never a hub-relayed consent token) so only the owner's unlocked app
may view, author, pause, delete, or preview offline Circle Auto-Approve rules.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from api.routes.one.pod_owner_door import admit_owner_local, owner_local_door
from hushh_mcp.operons.circle_auto_approve import (
    MIN_CONFIDENCE_FLOOR,
    CircleAutoApproveRule,
    CircleRuleValidationError,
)
from hushh_mcp.services import pod_circle_rules as store
from hushh_mcp.services.pod_commit_log import PodLogConflict, PodLogFenced
from hushh_mcp.services.pod_config import resolve_pod_config
from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG, SCOPE_POD_STATUS

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])


def _log() -> Any:
    from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

    return _resolve_log()


def _hushh_id() -> str:
    return (os.environ.get("HUSSH_ID") or "").strip()


def _rule_wire(rule: CircleAutoApproveRule) -> dict[str, Any]:
    return {
        "ruleId": rule.rule_id,
        "circleId": rule.circle_id,
        "label": rule.label,
        "scopePatterns": list(rule.scope_patterns),
        "nlPolicyFilter": rule.nl_policy_filter,
        "delegationSubkeyRef": rule.delegation_subkey_ref,
        "enabled": rule.enabled,
        "dailyCap": rule.daily_cap,
        "requireConfidence": rule.require_confidence,
        "createdAtMs": rule.created_at_ms,
        "updatedAtMs": rule.updated_at_ms,
    }


def _refused(exc: CircleRuleValidationError) -> JSONResponse:
    status = (
        404
        if exc.code == "RULE_NOT_FOUND"
        else 503
        if exc.code == "CIRCLE_RULES_STORE_UNAVAILABLE"
        else 422
    )
    return JSONResponse(status_code=status, content={"code": exc.code, "message": exc.message})


class UpsertCircleRuleRequest(BaseModel):
    rule_id: Optional[str] = Field(default=None, alias="ruleId", max_length=72)
    circle_id: str = Field(..., alias="circleId", min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=80)
    scope_patterns: list[str] = Field(..., alias="scopePatterns", min_length=1, max_length=12)
    nl_policy_filter: str = Field(default="", alias="nlPolicyFilter", max_length=500)
    delegation_subkey_ref: str = Field(default="", alias="delegationSubkeyRef", max_length=128)
    enabled: bool = True
    daily_cap: int = Field(default=10, alias="dailyCap", ge=1, le=50)
    require_confidence: float = Field(
        default=MIN_CONFIDENCE_FLOOR, alias="requireConfidence", ge=MIN_CONFIDENCE_FLOOR, le=1.0
    )
    model_config = ConfigDict(populate_by_name=True)


class ToggleCircleRuleRequest(BaseModel):
    enabled: bool


class PreviewCircleRuleRequest(BaseModel):
    circle_id: str = Field(..., alias="circleId", min_length=1, max_length=64)
    requested_scope: str = Field(..., alias="requestedScope", min_length=1, max_length=128)
    candidate_summary: str = Field(default="", alias="candidateSummary", max_length=500)
    candidate_tags: list[str] = Field(default_factory=list, alias="candidateTags", max_length=24)
    requester_in_circle: bool = Field(default=True, alias="requesterInCircle")
    model_config = ConfigDict(populate_by_name=True)


@router.get("/circle-rules")
async def get_circle_rules(
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    door = await owner_local_door(
        x_consent_token, authorization, scope=SCOPE_POD_STATUS, held=False
    )
    await admit_owner_local(
        door.get("consent_token", ""),
        verifier=door.get("verifier"),
        session=door.get("session"),
        scope=SCOPE_POD_STATUS,
    )
    log = _log()
    hushh_id = _hushh_id()
    rules, receipts = await store.list_circle_rules(log, hushh_id=hushh_id)
    pod_cfg = await resolve_pod_config(log, hushh_id=hushh_id)
    return {
        "rules": [_rule_wire(r) for r in rules],
        "recentReceipts": receipts,
        "sessionOnlyLockdown": pod_cfg.session_only_lockdown,
        "masterVaultKeyLeavesDevice": False,
    }


@router.put("/circle-rules")
async def put_circle_rule(
    payload: UpsertCircleRuleRequest = Body(...),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> Any:
    door = await owner_local_door(x_consent_token, authorization, scope=SCOPE_POD_CONFIG, held=True)
    await admit_owner_local(
        door.get("consent_token", ""),
        verifier=door.get("verifier"),
        session=door.get("session"),
        scope=SCOPE_POD_CONFIG,
    )
    try:
        saved = await store.upsert_circle_rule(
            _log(),
            hushh_id=_hushh_id(),
            rule_payload=payload.model_dump(by_alias=False),
        )
    except CircleRuleValidationError as exc:
        return _refused(exc)
    except PodLogFenced as exc:
        raise HTTPException(status_code=410, detail={"code": "POD_LOG_FENCED"}) from exc
    except PodLogConflict as exc:
        raise HTTPException(status_code=409, detail={"code": "POD_LOG_CONFLICT"}) from exc
    return {"rule": _rule_wire(saved)}


@router.post("/circle-rules/{rule_id}/toggle")
async def post_toggle_circle_rule(
    rule_id: str,
    payload: ToggleCircleRuleRequest = Body(...),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> Any:
    door = await owner_local_door(x_consent_token, authorization, scope=SCOPE_POD_CONFIG, held=True)
    await admit_owner_local(
        door.get("consent_token", ""),
        verifier=door.get("verifier"),
        session=door.get("session"),
        scope=SCOPE_POD_CONFIG,
    )
    try:
        saved = await store.toggle_circle_rule(
            _log(),
            hushh_id=_hushh_id(),
            rule_id=rule_id,
            enabled=payload.enabled,
        )
    except CircleRuleValidationError as exc:
        return _refused(exc)
    except PodLogFenced as exc:
        raise HTTPException(status_code=410, detail={"code": "POD_LOG_FENCED"}) from exc
    except PodLogConflict as exc:
        raise HTTPException(status_code=409, detail={"code": "POD_LOG_CONFLICT"}) from exc
    return {"rule": _rule_wire(saved)}


@router.delete("/circle-rules/{rule_id}")
async def delete_circle_rule_route(
    rule_id: str,
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> Any:
    door = await owner_local_door(x_consent_token, authorization, scope=SCOPE_POD_CONFIG, held=True)
    await admit_owner_local(
        door.get("consent_token", ""),
        verifier=door.get("verifier"),
        session=door.get("session"),
        scope=SCOPE_POD_CONFIG,
    )
    try:
        removed = await store.delete_circle_rule(
            _log(),
            hushh_id=_hushh_id(),
            rule_id=rule_id,
        )
    except CircleRuleValidationError as exc:
        return _refused(exc)
    except PodLogFenced as exc:
        raise HTTPException(status_code=410, detail={"code": "POD_LOG_FENCED"}) from exc
    except PodLogConflict as exc:
        raise HTTPException(status_code=409, detail={"code": "POD_LOG_CONFLICT"}) from exc
    if not removed:
        return JSONResponse(
            status_code=404,
            content={
                "code": "RULE_NOT_FOUND",
                "message": f"Circle rule '{rule_id}' was not found.",
            },
        )
    return {"deleted": True, "ruleId": rule_id}


@router.post("/circle-rules/preview")
async def preview_circle_rule_route(
    payload: PreviewCircleRuleRequest = Body(...),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    """Dry-run Dual-Lock preview against the owner's saved rules (writes no receipt)."""
    door = await owner_local_door(
        x_consent_token, authorization, scope=SCOPE_POD_STATUS, held=False
    )
    await admit_owner_local(
        door.get("consent_token", ""),
        verifier=door.get("verifier"),
        session=door.get("session"),
        scope=SCOPE_POD_STATUS,
    )
    decision = await store.evaluate_incoming_circle_request(
        _log(),
        hushh_id=_hushh_id(),
        circle_id=payload.circle_id,
        requester_in_circle=payload.requester_in_circle,
        requested_scope=payload.requested_scope,
        candidate_summary=payload.candidate_summary,
        candidate_tags=payload.candidate_tags,
        record_receipt=False,
    )
    result: dict[str, Any] = dict(decision.as_dict())
    return result
