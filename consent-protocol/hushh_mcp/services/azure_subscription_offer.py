"""Whether the person's Azure subscription is a free trial, read once during setup.

A free trial is disabled after 30 days, or sooner when its credit is used, unless the
person upgrades, and the agent in it stops with it (Azure account page, fetched
2026-10-06). The app said nothing. The setup job now reads the subscription's own
policies, read-only, with the person's delegated token it already holds, and records
them on the setup record as one ``subscription_offer`` entry the frontend turns into
one plain line.

Measured 2026-10-06 on the dev trial subscription, api-version 2022-12-01:
``subscriptionPolicies`` = ``{"quotaId": "FreeTrial_2014-09-01", "spendingLimit":
"On"}``. Only the ``FreeTrial_`` quota is called a free trial: a spending limit alone
is also on for other offers (student, Visual Studio) whose terms are not 30 days.

Best effort by design: an unreadable subscription records nothing and never fails
setup. The entry joins ``stages`` without moving the job's current ``stage`` (the
publish step requires ``proving``), the way Google's ``files_selection`` entry does.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.byoc_setup_job_service import JobSuperseded

logger = logging.getLogger(__name__)

OFFER_STAGE = "subscription_offer"
_FREE_TRIAL_PREFIX = "freetrial_"
_GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_FIELD_LIMIT = 64


@dataclass(frozen=True)
class SubscriptionOffer:
    quota_id: str
    spending_limit: str

    @property
    def free_trial(self) -> bool:
        return self.quota_id.lower().startswith(_FREE_TRIAL_PREFIX)

    def stage_record(self, at: str) -> dict[str, Any]:
        """The setup-record entry: facts only; the sentence is the frontend's."""
        return {
            "stage": OFFER_STAGE,
            "at": at,
            "quotaId": self.quota_id,
            "spendingLimit": self.spending_limit,
            "freeTrial": self.free_trial,
        }


def offer_from_subscription(body: Any) -> Optional[SubscriptionOffer]:
    """The offer named by an ARM subscription body, or None when it names none."""
    policies = body.get("subscriptionPolicies") if isinstance(body, dict) else None
    if not isinstance(policies, dict):
        return None
    quota = str(policies.get("quotaId") or "").strip()[:_FIELD_LIMIT]
    if not quota:
        return None
    limit = str(policies.get("spendingLimit") or "").strip()[:_FIELD_LIMIT]
    return SubscriptionOffer(quota_id=quota, spending_limit=limit)


def read_subscription_offer(
    access_token: str, subscription_id: str, *, arm: Optional[ArmClient] = None
) -> Optional[SubscriptionOffer]:
    """One read-only ARM GET of the subscription; None when it cannot be read."""
    subscription = str(subscription_id or "").strip().lower()
    if not _GUID.match(subscription):
        return None
    client = arm or ArmClient(access_token)
    body = client.get(
        f"/subscriptions/{subscription}",
        api_version=API_VERSIONS["subscriptions"],
        op="subscription_offer",
    )
    return offer_from_subscription(body)


async def record_subscription_offer(
    jobs: Any, *, user_id: str, job_id: str, offer: SubscriptionOffer
) -> None:
    """Append the entry to THIS job's record, keeping its current stage.

    ``_guarded_update`` is the repo's ownership-checked write (the same one ``advance``
    uses); ``advance`` itself would move ``stage`` and break the publish guard.
    """
    current = await jobs.get(user_id)
    if not current or current.get("job_id") != job_id:
        raise JobSuperseded(f"job {job_id} no longer owns the row")
    kept = [s for s in current.get("stages") or [] if s.get("stage") != OFFER_STAGE]
    record = offer.stage_record(datetime.now(timezone.utc).isoformat())
    await jobs._guarded_update(user_id=user_id, job_id=job_id, data={"stages": [*kept, record]})


async def note_subscription_offer(
    jobs: Any,
    *,
    user_id: str,
    job_id: str,
    access_token: str,
    subscription_id: str,
    read: Callable[[str, str], Optional[SubscriptionOffer]] = read_subscription_offer,
) -> Optional[SubscriptionOffer]:
    """Read and record the offer. Never fails setup; a superseded job still stops."""
    try:
        offer = await asyncio.to_thread(read, access_token, subscription_id)
        if offer is None:
            return None
        await record_subscription_offer(jobs, user_id=user_id, job_id=job_id, offer=offer)
    except JobSuperseded:
        raise
    except Exception as exc:  # noqa: BLE001 - a missing notice must never stop a setup
        logger.info("azure_subscription_offer.unrecorded err=%s", type(exc).__name__)
        return None
    logger.info(
        "azure_subscription_offer.recorded job=%s quota=%s free_trial=%s",
        job_id,
        offer.quota_id,
        offer.free_trial,
    )
    return offer


__all__ = [
    "OFFER_STAGE",
    "SubscriptionOffer",
    "note_subscription_offer",
    "offer_from_subscription",
    "read_subscription_offer",
    "record_subscription_offer",
]
