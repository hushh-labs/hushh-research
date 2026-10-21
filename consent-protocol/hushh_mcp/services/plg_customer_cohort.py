"""Private, bounded live traversal of production customer analytics membership.

No campaign permission, customer content or account mutation authority. A page
is read under lifecycle barriers; traversal is not a database-wide snapshot.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field

from db.connection import get_pool
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.email_auth.contracts import PayloadCipher
from hushh_mcp.services.plg_reporting import current_reporting_records, reporting_policy

PURPOSE = "one-production-customer-cohort-v1"
PAGE_SIZE = 50


class CohortCursorError(ValueError):
    """Caller must restart traversal with a new policy/window."""


class CohortRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    cursor: str | None = Field(default=None, min_length=1, max_length=2048)


def analytics_user_id(uid: str) -> str:
    # Canonical client contract: lib/observability/identity.ts. Never device IDs.
    return hashlib.sha256(f"hushh-observability-v1:{uid}".encode()).hexdigest()[:32]


def _cipher(secret: str) -> PayloadCipher:
    return PayloadCipher(hmac.new(secret.encode(), PURPOSE.encode(), hashlib.sha256).digest())


def _cursor(value: str | None, secret: str, revision: str, now: datetime):
    if value is None:
        return "", now
    try:
        row = json.loads(_cipher(secret).open(value, PURPOSE))
        at = datetime.fromisoformat(row["asOf"])
        if (
            set(row) != {"last", "asOf", "policyRevision"}
            or not isinstance(row["last"], str)
            or not 1 <= len(row["last"]) <= 128
            or row["policyRevision"] != revision
            or at.tzinfo is None
            or not timedelta(0) <= now - at < timedelta(minutes=10)
        ):
            raise ValueError("Invalid customer cohort cursor")
        return row["last"], at
    except Exception:
        raise CohortCursorError("Invalid customer cohort cursor") from None


async def customer_cohort_page(request: CohortRequest, secret: str, now: datetime) -> dict:
    policy = reporting_policy()
    last, at = _cursor(request.cursor, secret, policy.revision, now)
    pool = await get_pool()
    async with pool.acquire(timeout=3) as conn:
        page = await conn.fetch(
            "SELECT user_id FROM actor_identity_cache WHERE user_id > $1 AND created_at <= $2 "
            "ORDER BY user_id LIMIT 51",
            last,
            at,
            timeout=5,
        )
    ids = [row["user_id"] for row in page[:PAGE_SIZE]]
    # Use the same database primary-key collation for both comparison and order.
    # Python lexical order can differ, and forcing C would bypass the PK index.
    if len(page) > PAGE_SIZE + 1 or len(set(ids)) != len(ids):
        raise RuntimeError("Invalid customer cohort source page")
    current = await current_reporting_records(ids)
    rows = []
    if ids:
        async with pool.acquire(timeout=3) as conn, conn.transaction(isolation="read_committed"):
            await conn.execute("SET LOCAL statement_timeout='5s'")
            await conn.execute("SET LOCAL lock_timeout='1s'")
            active = await AccountDeletionLifecycleService.active_projection_user_ids(
                conn, user_ids=ids
            )
            service = ActorIdentityService()
            canonical = await service.get_many(active, conn=conn)
            aliases = await service.get_many_verified_email_aliases(active, conn=conn)
            for uid in ids:
                auth = current.get(uid)
                if (
                    uid in active
                    and auth
                    and policy.eligible(
                        uid, canonical.get(uid), (*auth["emails"], *aliases.get(uid, []))
                    )
                ):
                    rows.append(
                        {
                            "analyticsUserId": analytics_user_id(uid),
                            "registeredAt": auth["registeredAt"],
                        }
                    )
    continuation = (
        _cipher(secret).seal(
            json.dumps(
                {"last": ids[-1], "asOf": at.isoformat(), "policyRevision": policy.revision},
                separators=(",", ":"),
            ),
            PURPOSE,
        )
        if len(page) > PAGE_SIZE
        else None
    )
    return {
        "version": 1,
        "environment": "production",
        **policy.proof(),
        "identityScheme": "hushh-observability-v1-sha256-128",
        "traversal": "live",
        "asOf": at.isoformat(),
        "expiresAt": (at + timedelta(minutes=10)).isoformat(),
        "scanned": len(ids),
        "excluded": len(ids) - len(rows),
        "rows": rows,
        "nextCursor": continuation,
    }
