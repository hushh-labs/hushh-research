"""Private MCP review transport over the existing hub action ledger.

Private call terms never leave the pod/browser. A pod-keyed commitment binds
those terms; the hub adds current owner/deployment identity under its registry
lock. Only the authenticated browser route can confirm, never this machine port.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from dataclasses import asdict
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.action_directive_ledger import (
    MCP_ACTION_ID,
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    BoundActionTerms,
    IssuedActionDirective,
)
from hushh_mcp.services.pod_hub_client import VerifiedOwnerPod


class PodMcpTerms(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["pod_mcp_review_v1"] = "pod_mcp_review_v1"
    ownerId: str = Field(min_length=1, max_length=128)
    hushhId: str = Field(min_length=1, max_length=128)
    podKeyId: str = Field(min_length=1, max_length=128)
    environment: str = Field(min_length=1, max_length=32)
    epoch: int = Field(ge=1)
    conversationId: str = Field(min_length=1, max_length=256)
    connectorId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    toolName: str = Field(pattern=r"^mcp_[0-9a-f]{40}$")
    callId: str = Field(min_length=1, max_length=256)
    catalogRevision: str = Field(min_length=1, max_length=256)
    commitment: str = Field(pattern=r"^[a-f0-9]{64}$")
    serviceUid: str | None = Field(default=None, min_length=1, max_length=128)

    @property
    def identity(self) -> dict:
        return dict(
            user_id=self.ownerId,
            session_id=self.conversationId,
            action_id=MCP_ACTION_ID,
            context_revision=f"pod-mcp:{self.catalogRevision}",
        )

    @property
    def terms(self) -> BoundActionTerms:
        return BoundActionTerms(
            action_contract={
                "action_id": MCP_ACTION_ID,
                "tool": self.toolName,
                "catalog_revision": self.catalogRevision,
            },
            slots={"commitment": self.commitment},
            resource_binding=self.model_dump(exclude={"commitment"}),
        )


class PodMcpMutation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    review: PodMcpTerms
    directiveId: str | None = Field(default=None, pattern=r"^dir_[a-f0-9]{32}$")
    receipt: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{32,128}$", repr=False)


async def mutate_review(
    operation: Literal["issue", "confirm", "consume"],
    payload: PodMcpMutation,
    *,
    principal: VerifiedOwnerPod | None = None,
    db=None,
) -> dict:
    """Registry fence and ledger compare-and-set share one committed transaction.

    Caller authentication is route-owned. No caller can choose a ledger method,
    action, channel, TTL or SQL parameters beyond these exact review terms.
    """
    from sqlalchemy import text

    from db.db_client import get_db
    from hushh_mcp.services.personal_agent_direct_admission import direct_owner_matches
    from hushh_mcp.services.pod_binding_service import hub_environment

    database = db if db is not None else get_db()

    def commit():
        with database.engine.begin() as conn:
            conn.execute(text("SET LOCAL statement_timeout = '5s'"))
            conn.execute(text("SET LOCAL lock_timeout = '2s'"))
            row = (
                conn.execute(
                    text(
                        "SELECT hushh_id,status,deployment_target,pod_key_id,pod_pubkey,backend_metadata "
                        "FROM personal_agent_registry WHERE user_id=:owner FOR UPDATE"
                    ),
                    {"owner": payload.review.ownerId},
                )
                .mappings()
                .one_or_none()
            )
            review = payload.review
            metadata = (row or {}).get("backend_metadata") or {}
            if operation != "confirm" and (
                not isinstance(principal, VerifiedOwnerPod)
                or principal.hushh_id != review.hushhId
                or not principal.service_account
                or principal.service_account != metadata.get("runtime_service_account")
            ):
                raise ActionDirectiveAuthorityError("Private connector runtime identity changed.")
            uid = metadata.get("serviceUid")
            url = str(metadata.get("url") or "").strip().rstrip("/")
            if (
                not uid
                or review.environment != hub_environment()
                or not direct_owner_matches(
                    row,
                    hushh_id=review.hushhId,
                    pod_key_id=review.podKeyId,
                    pod_public_key=(row or {}).get("pod_pubkey"),
                    service_uid=uid,
                    url=url,
                )
                or (operation != "issue" and review.serviceUid != uid)
                or (review.serviceUid is not None and review.serviceUid != uid)
            ):
                raise ActionDirectiveAuthorityError("Private connector assignment changed.")
            review = review.model_copy(update={"serviceUid": uid})
            store = ActionDirectiveStore(connection=conn)

            async def change():
                if operation == "issue":
                    if payload.directiveId or payload.receipt:
                        raise ActionDirectiveAuthorityError("Invalid private review issue.")
                    terms = review.terms
                    issued = await store.issue(
                        **review.identity,
                        channel="pod_chat",
                        action_contract=terms.action_contract,
                        slots=terms.slots,
                        resource_binding=terms.resource_binding,
                        trusted_activation_required=True,
                    )
                    return {
                        "directiveId": issued.directive_id,
                        "expiresAt": issued.expires_at.isoformat(),
                        "podReview": review.model_dump(),
                    }
                if not payload.directiveId:
                    raise ActionDirectiveAuthorityError("Private review is required.")
                if operation == "confirm":
                    if payload.receipt:
                        raise ActionDirectiveAuthorityError("Unexpected confirmation receipt.")
                    receipt = await store.confirm(
                        **review.identity,
                        directive_id=payload.directiveId,
                        trusted_activation=True,
                        terms=review.terms,
                        expected_channel="pod_chat",
                    )
                    return {
                        "status": "confirmed",
                        "directiveId": receipt.directive_id,
                        "expiresAt": receipt.expires_at.isoformat(),
                        "receipt": receipt.receipt,
                    }
                if operation != "consume" or not payload.receipt:
                    raise ActionDirectiveAuthorityError("Private review receipt is required.")
                await store.consume(
                    **review.identity,
                    directive_id=payload.directiveId,
                    receipt=payload.receipt,
                    terms=review.terms,
                    expected_channel="pod_chat",
                )
                return {"status": "consumed"}

            return asyncio.run(change())

    return await asyncio.to_thread(commit)


class PodMcpApprovalPort:
    def __init__(self, owner, *, client=None):
        from hushh_mcp.services.pod_hub_client import PodHubClient

        self.owner = owner
        self.client = client or PodHubClient()

    def terms(self, approval) -> PodMcpTerms:
        from hushh_mcp.one_adk.governed_mcp_toolset import mcp_tool_name
        from hushh_mcp.runtime_settings import get_core_security_settings

        key = get_core_security_settings().app_signing_key
        if not key or approval.owner_id != self.owner.owner:
            raise ActionDirectiveAuthorityError("Private review owner unavailable.")
        key_bytes = hmac.new(key.encode(), b"hussh/pod-mcp-review/v1", hashlib.sha256).digest()
        encoded = json.dumps(
            asdict(approval.terms),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode()
        return PodMcpTerms(
            ownerId=self.owner.owner,
            hushhId=self.owner.hushh_id,
            podKeyId=self.owner.authority.pod_key_id,
            environment=self.owner.authority.environment,
            epoch=self.owner.authority.epoch,
            conversationId=approval.conversation_id,
            connectorId=approval.binding.connector_id,
            toolName=mcp_tool_name(approval.binding.connector_id, approval.tool_name),
            catalogRevision=approval.catalog_revision,
            callId=approval.call_id,
            commitment=hmac.new(key_bytes, encoded, hashlib.sha256).hexdigest(),
        )

    async def _call(self, operation: str, payload: PodMcpMutation):
        from hushh_mcp.services.pod_hub_client import PodHubUnavailable

        await self.owner.require_access()
        if await self.owner.authority.lease.state(force=True) != "held":
            raise ActionDirectiveAuthorityError("Private review incarnation changed.")
        try:
            response = await asyncio.to_thread(
                self.client.post,
                f"/api/one/pod/mcp-approval/{operation}",
                json=payload.model_dump(exclude_none=True),
            )
            if response.status_code != 200:
                raise ActionDirectiveAuthorityError("Private connector authority unavailable.")
            value = response.json()
        except (PodHubUnavailable, ValueError):
            raise ActionDirectiveAuthorityError(
                "Private connector authority unavailable."
            ) from None
        await self.owner.require_access()
        if await self.owner.authority.lease.state(force=True) != "held":
            raise ActionDirectiveAuthorityError("Private review incarnation changed.")
        return value

    async def issue(self, approval) -> IssuedActionDirective:
        terms = self.terms(approval)
        value = await self._call("issue", PodMcpMutation(review=terms))
        recorded = PodMcpTerms.model_validate(value["podReview"])
        if not recorded.serviceUid or recorded.model_copy(update={"serviceUid": None}) != terms:
            raise ActionDirectiveAuthorityError("Private review binding changed.")
        return IssuedActionDirective(
            value["directiveId"],
            MCP_ACTION_ID,
            recorded.identity["context_revision"],
            datetime.fromisoformat(value["expiresAt"]),
            recorded.model_dump(),
        )

    async def consume(self, approval, *, directive_id: str, receipt: str):
        from google.adk.sessions import Session

        from hushh_mcp.one_adk.mcp_pending_call import current_pending_handle, pending_call_details

        pending = pending_call_details(
            Session(id=approval.conversation_id, user_id=approval.owner_id, app_name="hussh_one"),
            current_pending_handle(),
        )
        recorded = PodMcpTerms.model_validate((pending.get("review") or {}).get("podReview"))
        if recorded.model_copy(update={"serviceUid": None}) != self.terms(approval):
            raise ActionDirectiveAuthorityError("Private connector terms changed.")
        result = await self._call(
            "consume", PodMcpMutation(review=recorded, directiveId=directive_id, receipt=receipt)
        )
        if result != {"status": "consumed"}:
            raise ActionDirectiveAuthorityError("Private confirmation consumption unverified.")
