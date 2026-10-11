"""The owner's connected-account Stripe balance ("In Stripe").

GET /api/one/payouts/account/balance

Served from a webhook- and worker-maintained snapshot with a bounded inline
refresh. Owner-scoped by the vault owner token; Cache-Control: private, no-store.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/one/payouts", tags=["One Packet Payouts"])
