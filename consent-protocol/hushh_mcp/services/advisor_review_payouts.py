"""Advisor-owned sandbox bank setup and provider payout readback."""

import asyncio
from typing import Literal
from uuid import UUID

from db.db_client import get_db
from hushh_mcp.services.advisor_review_billing import test_config
from hushh_mcp.services.advisor_review_store import AdvisorReviewError, load, require_accepted
from hushh_mcp.services.advisor_stripe import provider as stripe_provider
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError, _stripe_dict
from hushh_mcp.services.pkm_payout_service import PkmPayoutService


def _authorize(viewer: str, request_id: UUID) -> None:
    with get_db().engine.begin() as conn:
        row = load(conn, viewer, str(request_id))
        if row["advisor_user_id"] != viewer:
            raise AdvisorReviewError("ADVISOR_WRONG_PARTICIPANT", 403)
        require_accepted(conn, row)


class AdvisorSandboxPayouts:
    @classmethod
    async def for_request(cls, viewer: str, request_id: UUID):
        await asyncio.to_thread(_authorize, viewer, request_id)
        key, _ = await asyncio.to_thread(test_config)
        return cls(viewer, request_id, key)

    def __init__(self, viewer: str, request_id: UUID, key: str):
        self.viewer = viewer
        self.request_id = request_id
        self.key = key
        self.provider = stripe_provider()
        self.payouts = PkmPayoutService(
            stripe_api=self.provider, mode="test", api_key=key, resume_documents=False
        )

    async def status(self):
        account = await self.payouts.refresh_account(self.viewer)
        if not account:
            return {"mode": "test", "setup": "setup_required", "latest": None}
        readiness = account["readiness"]
        if not readiness["ready"]:
            setup = "restricted" if readiness["status"] == "restricted" else "setup_required"
            return {"mode": "test", "setup": setup, "latest": None}
        result = _stripe_dict(
            await asyncio.to_thread(
                self.provider.Payout.list,
                api_key=self.key,
                stripe_account=account["stripe_account_id"],
                limit=1,
            )
        )
        data = result.get("data") or []
        latest = None
        if data:
            payout = data[0]
            if (
                payout.get("livemode") is not False
                or payout.get("type") != "bank_account"
                or payout.get("currency") != "usd"
                or payout.get("status")
                not in {"pending", "in_transit", "paid", "failed", "canceled"}
                or type(payout.get("amount")) is not int
                or payout["amount"] < 0
            ):
                raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)
            latest = {
                "status": payout["status"],
                "amountCents": payout["amount"],
                "currency": "usd",
            }
        return {"mode": "test", "setup": "ready", "latest": latest}

    async def link(self, action: Literal["onboarding", "dashboard"]):
        try:
            if action == "onboarding":
                result = await self.payouts.onboarding_link(
                    user_id=self.viewer, surface="advisor", advisor_request_id=self.request_id
                )
            else:
                result = await self.payouts.management_link(user_id=self.viewer)
        except PacketOrderError as exc:
            raise AdvisorReviewError("ADVISOR_CONNECT_STRIPE", 409) from exc
        return {"mode": "test", "url": result["url"]}
