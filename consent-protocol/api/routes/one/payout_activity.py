"""Owner payout activity and receipts (read-only).

GET /api/one/payouts/activity        cursor-paginated owner activity
GET /api/one/payouts/activity/{id}   one receipt

Every route is owner-scoped by the vault owner token, returns
Cache-Control: private, no-store, and never exposes Stripe object IDs.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/one/payouts", tags=["One Packet Payouts"])
