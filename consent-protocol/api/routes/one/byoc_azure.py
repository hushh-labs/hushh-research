"""Connect Azure: the person's own subscription as their private agent's home.

Three routes, Firebase-authenticated like the GCP one-click routes they sit beside:

* ``POST /api/one/runtime/byoc/azure/authorize/begin`` -> ``{authorizationUrl}``
* ``POST /api/one/runtime/byoc/azure/authorize/complete`` -> ``setup_started`` |
  ``needs_subscription`` | ``upgrade_started``
* ``POST /api/one/runtime/byoc/azure/upgrade/begin`` -> ``{authorizationUrl}``

Progress is the existing ``GET /api/one/runtime/byoc/setup/status``. Microsoft
returns the browser to ``/one/setup/cloud/azure/return``, which posts ``{code,
state}`` to ``complete``.

The single-use code is burned synchronously and the person's token goes straight to
a background job that holds it in memory only. When the subscription is ambiguous the
token is discarded and the person picks one; ``begin`` is then run again with it.

Setup needs the agent record first: the agent is created during setup with its
HusshID in its environment, so a person without a verified phone is refused with
``AGENT_RECORD_REQUIRED`` before any Microsoft sign-in.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.services import azure_entra_authorizer as entra

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/runtime", tags=["One runtime configuration"])

#: Where a new agent is placed: Azure OpenAI's default chat deployment was measured
#: available there on a free-trial subscription (2026-10-02).
DEFAULT_LOCATION = "eastus2"
_SUBSCRIPTIONS_API = "2022-12-01"

#: Strong references to in-flight jobs: asyncio keeps only weak refs to tasks.
_AZURE_TASKS: set = set()


class AzureAuthorizeBeginRequest(BaseModel):
    subscriptionId: Optional[str] = Field(default=None, max_length=64)


class AzureAuthorizeBeginResponse(BaseModel):
    authorizationUrl: str


class AzureAuthorizeCompleteRequest(BaseModel):
    code: str = Field(min_length=1, max_length=8192)
    state: str = Field(min_length=1, max_length=4096)


class AzureSubscription(BaseModel):
    subscriptionId: str
    displayName: str
    state: str


class AzureAuthorizeCompleteResponse(BaseModel):
    status: Literal["setup_started", "needs_subscription", "upgrade_started"]
    jobId: Optional[str] = None
    subscriptions: Optional[list[AzureSubscription]] = None
    #: Only with needs_subscription: choose_subscription | no_enabled_subscription |
    #: personal_account (a personal Microsoft account must name its subscription id).
    reason: Optional[str] = None


def _refuse(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _pass_through(exc: Any) -> HTTPException:
    return _refuse(int(getattr(exc, "status_code", 400)), str(exc.code), str(exc))


async def _registry_row(user_id: str) -> Optional[dict]:
    """The registry row, or a typed 503 when the registry cannot answer (never a 500)."""
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    try:
        row = await PersonalAgentRegistryRepo().get(user_id)
    except Exception as exc:  # noqa: BLE001 - an unreadable registry is not "no agent"
        raise _refuse(
            503, "POD_ASSIGNMENT_UNVERIFIED", "Cloud setup could not verify your agent record."
        ) from exc
    return dict(row) if row else None


async def _agent_record(user_id: str) -> dict:
    """The registry row with a HusshID, reserving it when the phone is verified."""
    from api.routes.one.runtime import _reserve_pending_agent_record

    row = await _registry_row(user_id)
    if not row and await _reserve_pending_agent_record(user_id):
        row = await _registry_row(user_id)
    if not row or not row.get("hushh_id") or not row.get("phone_e164_hash"):
        raise _refuse(
            409, "AGENT_RECORD_REQUIRED", "Verify your phone number first, then connect Azure."
        )
    return dict(row)


async def _require_setup_admission(user_id: str) -> dict:
    from api.routes.one.runtime import _require_unassigned_byoc

    await _require_unassigned_byoc(user_id)
    return await _agent_record(user_id)


async def _source_image() -> str:
    """The approved pod image, pinned by digest (resolved in Google Cloud if tagged)."""
    from hushh_mcp.services.pod_release import is_immutable_image_reference

    source = (os.getenv("HUSSH_ONE_POD_IMAGE") or "").strip()
    if not source:
        raise _refuse(
            503, "NOT_CONFIGURED", "The agent image is not configured on this deployment."
        )
    if is_immutable_image_reference(source):
        return source
    from hushh_mcp.services import pod_image_copy

    try:
        token, _email = await asyncio.to_thread(pod_image_copy.attached_identity)
        digest = await asyncio.to_thread(pod_image_copy.resolve_source_digest, source, token)
    except Exception as exc:  # noqa: BLE001 - an unresolvable image is a typed refusal
        raise _refuse(503, "IMAGE_UNAVAILABLE", "The agent image could not be resolved.") from exc
    return f"{source.rsplit(':', 1)[0]}@{digest}"


async def _authorization_url(
    user_id: str,
    *,
    kind: entra.AuthorizationKind,
    subscription_id: str = "",
    tenant_id: str = "",
) -> str:
    """``entra.begin`` off the loop, every configuration refusal typed."""
    from hushh_mcp.services.azure_federation import AzureFederationError

    try:
        return await asyncio.to_thread(
            entra.begin,
            user_id,
            kind=kind,
            subscription_id=subscription_id,
            tenant_id=tenant_id,
        )
    except entra.AzureAuthorizeError as exc:
        raise _pass_through(exc) from exc
    except AzureFederationError as exc:
        raise _refuse(503, exc.code, str(exc)) from exc


def _spawn(coroutine: Any) -> None:
    task = asyncio.create_task(coroutine)
    _AZURE_TASKS.add(task)
    task.add_done_callback(_AZURE_TASKS.discard)


@router.post("/byoc/azure/authorize/begin", response_model=AzureAuthorizeBeginResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def begin_azure_authorize(
    request: Request,
    body: AzureAuthorizeBeginRequest,
    firebase_uid: str = Depends(require_firebase_auth),
) -> AzureAuthorizeBeginResponse:
    """The Microsoft consent URL: online-only, PKCE, bound to this caller."""
    subscription = str(body.subscriptionId or "").strip().lower()
    if subscription and not entra.is_guid(subscription):
        raise _refuse(422, "BAD_SUBSCRIPTION", "That is not an Azure subscription id.")
    await _require_setup_admission(firebase_uid)
    url = await _authorization_url(firebase_uid, kind="setup", subscription_id=subscription)
    return AzureAuthorizeBeginResponse(authorizationUrl=url)


def _subscriptions(token: entra.DelegatedToken) -> list[AzureSubscription]:
    from hushh_mcp.services.azure_arm_client import ArmClient

    listed = ArmClient(token.access_token).get("/subscriptions", api_version=_SUBSCRIPTIONS_API)
    return [
        AzureSubscription(
            subscriptionId=str(item.get("subscriptionId") or "").lower(),
            displayName=str(item.get("displayName") or ""),
            state=str(item.get("state") or ""),
        )
        for item in listed.get("value") or []
        if entra.is_guid(item.get("subscriptionId"))
    ]


async def _choose_subscription(
    token: entra.DelegatedToken, requested: str
) -> tuple[Optional[str], Optional[AzureAuthorizeCompleteResponse]]:
    """(subscription, None) when one is settled, else (None, needs_subscription)."""
    if entra.is_personal_account(token):
        return None, AzureAuthorizeCompleteResponse(
            status="needs_subscription", subscriptions=[], reason="personal_account"
        )
    from hushh_mcp.services.azure_arm_client import ArmError

    try:
        listed = await asyncio.to_thread(_subscriptions, token)
    except ArmError as exc:
        raise _refuse(
            502, "AZURE_SUBSCRIPTIONS_UNAVAILABLE", "Azure did not list your subscriptions."
        ) from exc
    enabled = [s for s in listed if s.state == "Enabled"]
    if requested:
        if any(s.subscriptionId == requested for s in enabled):
            return requested, None
        raise _refuse(409, "SUBSCRIPTION_UNAVAILABLE", "That subscription is not enabled for you.")
    if len(enabled) == 1:
        return enabled[0].subscriptionId, None
    reason = "choose_subscription" if enabled else "no_enabled_subscription"
    return None, AzureAuthorizeCompleteResponse(
        status="needs_subscription", subscriptions=listed, reason=reason
    )


async def _claim_job(user_id: str, group_ref: str) -> tuple[str, bool]:
    """(job id, started). An identical running job is returned, never doubled."""
    from hushh_mcp.services import byoc_setup_job_service as jobs

    job_id = jobs.new_job_id()
    repo = jobs.ByocSetupJobRepo()
    if await repo.start(user_id=user_id, job_id=job_id, project_id=group_ref):
        return job_id, True
    current = await repo.get(user_id)
    if current and current.get("status") == "running" and current.get("project_id") == group_ref:
        return str(current["job_id"]), False
    raise _refuse(409, "SETUP_IN_PROGRESS", "A cloud setup is already running.")


async def _start_setup(
    user_id: str, token: entra.DelegatedToken, subscription: str, row: dict
) -> AzureAuthorizeCompleteResponse:
    from api.routes.one.runtime import _write_cloud_setup_marker
    from hushh_mcp.services.azure_setup_job import run_azure_setup_job
    from hushh_mcp.services.azure_setup_plan import group_id, resource_group_name
    from hushh_mcp.services.compute_backend import BACKEND_USER_AZURE, PodSpec

    source = await _source_image()
    group = resource_group_name(str(row["hushh_id"]))
    job_id, started = await _claim_job(user_id, group_id(subscription, group))
    if started:
        spec = PodSpec(
            hushh_id=str(row["hushh_id"]),
            phone_e164_hash=str(row["phone_e164_hash"]),
            pod_pubkey="",
            billing_space_id=row.get("billing_space_id"),
            deployment_target=BACKEND_USER_AZURE,
            model_credential_mode="user_azure_mi",
            user_cloud_tenant_id=token.tenant_id,
            user_cloud_subscription_id=subscription,
            user_cloud_resource_group=group,
            user_cloud_region=DEFAULT_LOCATION,
        )
        _spawn(
            run_azure_setup_job(
                user_id=user_id,
                job_id=job_id,
                access_token=token.access_token,
                tenant_id=token.tenant_id,
                subscription_id=subscription,
                location=DEFAULT_LOCATION,
                spec=spec,
                source_image=source,
                on_recorded=lambda: _write_cloud_setup_marker(user_id),
            )
        )
        logger.info("azure_setup_job.accepted user=%s job=%s", user_id, job_id)
    return AzureAuthorizeCompleteResponse(status="setup_started", jobId=job_id)


@router.post(
    "/byoc/azure/authorize/complete",
    response_model=AzureAuthorizeCompleteResponse,
    response_model_exclude_none=True,
)
@limiter.limit(RateLimits.AGENT_CHAT)
async def complete_azure_authorize(
    request: Request,
    body: AzureAuthorizeCompleteRequest,
    firebase_uid: str = Depends(require_firebase_auth),
) -> AzureAuthorizeCompleteResponse:
    """Burn the code, then start the job (or ask which subscription)."""
    row: dict = {}
    try:
        selection = entra.verify_state(body.state, firebase_uid)
        if selection.kind == "setup":
            row = await _require_setup_admission(firebase_uid)
        token = await asyncio.to_thread(entra.redeem, body.state, selection, body.code)
    except entra.AzureAuthorizeError as exc:
        raise _pass_through(exc) from exc
    if selection.kind == "upgrade":
        return await _start_upgrade(firebase_uid, token)
    subscription, ask = await _choose_subscription(token, selection.subscription_id)
    if ask is not None or subscription is None:
        return ask or AzureAuthorizeCompleteResponse(status="needs_subscription", subscriptions=[])
    return await _start_setup(firebase_uid, token, subscription, row)


async def _upgrade_row(user_id: str) -> tuple[dict, str]:
    """The person's provisioned Azure agent and the digest they approved."""
    from hushh_mcp.services.compute_backend import BACKEND_USER_AZURE
    from hushh_mcp.services.pod_release import is_immutable_image_reference

    row = await _registry_row(user_id) or {}
    if row.get("deployment_target") != BACKEND_USER_AZURE or row.get("status") != "provisioned":
        raise _refuse(
            409, "NO_AZURE_AGENT", "There is no agent in your Azure subscription to update."
        )
    approval = (row.get("backend_metadata") or {}).get("upgradeApproval") or {}
    target = str(approval.get("targetImage") or "").strip()
    if not is_immutable_image_reference(target):
        raise _refuse(409, "UPGRADE_NOT_APPROVED", "Approve the update first, then sign in.")
    return dict(row), target


@router.post("/byoc/azure/upgrade/begin", response_model=AzureAuthorizeBeginResponse)
@limiter.limit(RateLimits.AGENT_CHAT)
async def begin_azure_upgrade(
    request: Request,
    firebase_uid: str = Depends(require_firebase_auth),
) -> AzureAuthorizeBeginResponse:
    """The Microsoft sign-in that authorizes ONE approved update, in the agent's directory."""
    row, _target = await _upgrade_row(firebase_uid)
    url = await _authorization_url(
        firebase_uid,
        kind="upgrade",
        subscription_id=str(row.get("user_cloud_subscription_id") or ""),
        tenant_id=str(row.get("user_cloud_tenant_id") or ""),
    )
    return AzureAuthorizeBeginResponse(authorizationUrl=url)


async def _start_upgrade(
    user_id: str, token: entra.DelegatedToken
) -> AzureAuthorizeCompleteResponse:
    from hushh_mcp.services.azure_setup_job import run_azure_upgrade_job
    from hushh_mcp.services.azure_setup_plan import group_id
    from hushh_mcp.services.compute_backend import resolve_compute_backend
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    row, target = await _upgrade_row(user_id)
    if token.tenant_id != str(row.get("user_cloud_tenant_id") or "").lower():
        raise _refuse(409, "BAD_TENANT", "Sign in with the directory that holds your agent.")
    group = group_id(str(row["user_cloud_subscription_id"]), str(row["user_cloud_resource_group"]))
    job_id, started = await _claim_job(user_id, group)
    if started:
        service = PersonalAgentProvisioningService(
            registry=PersonalAgentRegistryRepo(), backend=resolve_compute_backend()
        )
        _spawn(
            run_azure_upgrade_job(
                user_id=user_id,
                job_id=job_id,
                access_token=token.access_token,
                target_image=target,
                upgrade=service.upgrade_pod,
            )
        )
    return AzureAuthorizeCompleteResponse(status="upgrade_started", jobId=job_id)


__all__ = ["router"]
