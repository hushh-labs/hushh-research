"""Private, paginated contact/attempt projection. Never enrolls or sends.

Firebase supplies the live registered-account traversal; the canonical identity
shadow owns saved contact details. Only explicit allowlisted getters are read
from Firebase records, which may also contain password export fields.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from api.utils.firebase_admin import get_firebase_auth_app
from db.connection import get_pool
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.actor_identity_service import ActorIdentityService, resolve_firebase_email
from hushh_mcp.services.email_auth.identity import enterprise_account_deprovisioned
from hushh_mcp.services.plg_catalog import activity_catalog, public_activity_catalog
from hushh_mcp.services.plg_outcomes import value_summaries
from hushh_mcp.services.product_activity import enabled_for

PAGE_SIZE = 25


class AudienceCursorError(ValueError):
    """An invalid caller cursor, distinct from an unavailable source."""


Segment = Literal[
    "all",
    "possible_incomplete",
    "failed",
    "blocked",
    "cancelled",
    "returned",
    "verified",
    "unknown",
    "in_progress",
]


class AudienceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    agentId: str = "agent_one"
    segment: Segment = "all"
    query: str = Field(default="", max_length=100)
    graceMinutes: int = Field(default=60, ge=15, le=1440)
    cursor: str | None = Field(default=None, max_length=6000)

    @field_validator("agentId")
    @classmethod
    def known_agent(cls, value: str) -> str:
        if value not in {a["id"] for a in activity_catalog()["agents"]}:
            raise ValueError("unknown agent")
        return value


def _iso(value) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if isinstance(value, datetime) else None


def _binding(request: AudienceRequest) -> str:
    return hashlib.sha256(
        json.dumps(
            request.model_dump(exclude={"cursor"}), sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()


def _cursor(request: AudienceRequest, secret: str, now: datetime) -> tuple[str | None, datetime]:
    if request.cursor is None:
        return None, now
    try:
        raw, signature = request.cursor.split(".")
        expected = hmac.new(
            secret.encode(), f"audience-cursor\n{raw}".encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        payload = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        at = datetime.fromisoformat(payload["asOf"])
        if (
            payload["v"] != 1
            or payload["project"] != "hushh-pda"
            or payload["binding"] != _binding(request)
            or payload["size"] != PAGE_SIZE
            or not isinstance(payload["page"], str)
            or len(payload["page"]) > 3000
            or at.tzinfo is None
            or at > now
            or now - at > timedelta(minutes=15)
        ):
            raise ValueError
        return payload["page"], at
    except Exception:
        raise AudienceCursorError("invalid audience cursor") from None


def _next_cursor(
    page: str | None, request: AudienceRequest, secret: str, at: datetime
) -> str | None:
    if not page:
        return None
    if len(page) > 3000:
        raise ValueError("source cursor exceeds bound")
    raw = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "v": 1,
                    "project": "hushh-pda",
                    "page": page,
                    "size": PAGE_SIZE,
                    "binding": _binding(request),
                    "asOf": _iso(at),
                },
                separators=(",", ":"),
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    signature = hmac.new(
        secret.encode(), f"audience-cursor\n{raw}".encode(), hashlib.sha256
    ).hexdigest()
    return f"{raw}.{signature}"


def _firebase_page(page: str | None):
    from firebase_admin import auth

    app = get_firebase_auth_app()
    if app is None or app.project_id != "hushh-pda":
        raise RuntimeError("audience identity source unavailable")
    return auth.list_users(page_token=page, max_results=PAGE_SIZE, app=app)


def _registered(record) -> bool:
    return bool(
        not record.disabled
        and not enterprise_account_deprovisioned(record.custom_claims or {})
        and (record.provider_data or record.email or record.phone_number)
        and isinstance(record.uid, str)
        and 1 <= len(record.uid) <= 128
    )


def _contact_text(value, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = re.sub(r"[\x00-\x1f\x7f]", "", value).strip()
    # The TypeScript boundary counts UTF-16 code units. Do not let a long
    # supplementary-character display name invalidate an otherwise safe page.
    return (
        value.encode("utf-16-le", errors="ignore")[: limit * 2].decode("utf-16-le", errors="ignore")
        or None
    )


def _contact_email(value) -> str | None:
    value = _contact_text(value, 255)
    return (
        value
        if value and len(value) <= 254 and re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", value)
        else None
    )


def _identity(record, canonical: dict | None, fallback_phone: str | None) -> dict:
    if canonical is not None:
        phone = canonical.get("phone_number")
        verified = canonical.get("phone_verified") is True
        phone = (
            phone
            if verified and isinstance(phone, str) and re.fullmatch(r"\+[1-9][0-9]{6,14}", phone)
            else None
        )
        email = _contact_email(canonical.get("email"))
        return {
            "name": _contact_text(canonical.get("display_name"), 160),
            "email": email,
            "emailVerified": bool(email and canonical.get("email_verified") is True),
            "phoneNumber": phone,
            "phoneVerified": phone is not None,
            "source": "canonical",
            "updatedAt": _iso(canonical.get("updated_at")),
        }
    email = _contact_email(resolve_firebase_email(record))
    return {
        "name": _contact_text(record.display_name, 160),
        "email": email,
        "emailVerified": bool(email and email == record.email and record.email_verified),
        "phoneNumber": fallback_phone,
        "phoneVerified": fallback_phone is not None,
        "source": "firebase",
        "updatedAt": None,
    }


ATTEMPTS_SQL = """
SELECT o.user_id,o.action_id,o.agent_id,o.source,o.operation_key,
  MIN(o.observed_at) FILTER(WHERE o.phase='started') AS started_at,
  MAX(o.observed_at) AS last_at,
  MAX(o.observed_at) FILTER(WHERE o.phase<>'started') AS terminal_at,
  (ARRAY_AGG(o.phase ORDER BY o.observed_at DESC,o.phase)
    FILTER(WHERE o.phase<>'started'))[1] AS terminal,
  COUNT(*)::int AS observations
FROM one_product_activity_observations o
JOIN one_product_activity_epochs e ON e.user_id=o.user_id AND e.generation=o.generation
WHERE o.user_id=ANY($1::text[]) AND o.agent_id=$2
  AND o.observed_at >= $3 AND o.observed_at <= $4 AND o.expires_at > $4
GROUP BY o.user_id,o.action_id,o.agent_id,o.source,o.operation_key
ORDER BY o.user_id,o.action_id,o.source,o.operation_key LIMIT 100001
"""


def summarize_attempts(
    rows, *, agent_id: str, now: datetime, grace: int, epoch, limited: bool, enabled: bool
) -> dict:
    if not enabled:
        epoch, limited = None, False
    counts = dict.fromkeys(
        (
            "started",
            "returned",
            "failed",
            "cancelled",
            "blocked",
            "possibleIncomplete",
            "inProgress",
            "uncorrelated",
            "otherObservations",
        ),
        0,
    )
    first = last = last_return = last_failure = None
    last_action = None
    descriptors = {a["id"]: a for a in activity_catalog()["actions"]}
    # Preserve the existing export switch: retained execution observations are
    # hidden while collection is disabled or this UID is outside its cohort.
    for row in rows if enabled else ():
        descriptor = descriptors.get(row["action_id"])
        if (
            not descriptor
            or descriptor["agentId"] != agent_id
            or descriptor["proof"] != row["source"]
        ):
            limited = True
            continue
        observed = row["last_at"]
        if last is None or observed > last:
            last, last_action = observed, row["action_id"]
        if descriptor["kind"] == "tool":
            counts["otherObservations"] += row["observations"]
            continue
        if not row["operation_key"]:
            counts["uncorrelated"] += row["observations"]
            continue
        started, terminal = row["started_at"], row["terminal"]
        if started:
            counts["started"] += 1
            first = min(first, started) if first else started
        if terminal in {"returned", "failed", "cancelled", "blocked"}:
            counts[terminal] += 1
            # Asynchronous reports can reach the server out of order. Keep
            # the chosen terminal's receipt time separate from a later start.
            terminal_at = row["terminal_at"]
            if terminal == "returned":
                last_return = max(last_return, terminal_at) if last_return else terminal_at
            elif terminal in {"failed", "blocked", "cancelled"}:
                last_failure = max(last_failure, terminal_at) if last_failure else terminal_at
        elif started:
            key = (
                "possibleIncomplete" if now - started >= timedelta(minutes=grace) else "inProgress"
            )
            counts[key] += 1
    coverage = "observed" if enabled and epoch else "not_started" if enabled else "unavailable"
    if epoch and epoch["started_at"] > now:
        coverage = "reset_during_traversal"
    if limited:
        coverage = "limited"
    return {
        "coverage": coverage,
        "mode": "best_effort",
        "counts": counts,
        "collectionStartedAt": _iso(epoch["started_at"]) if epoch else None,
        "firstAttemptAt": _iso(first),
        "lastObservedAt": _iso(last),
        "lastReturnedAt": _iso(last_return),
        "lastFailureAt": _iso(last_failure),
        "lastActionId": last_action,
    }


def _matches(row: dict, request: AudienceRequest) -> bool:
    identity, activity = row["identity"], row["activity"]
    query = request.query.strip().casefold()
    if query and not any(
        query in str(identity.get(k) or "").casefold() for k in ("name", "email", "phoneNumber")
    ):
        return False
    if request.segment == "all":
        return True
    if request.segment == "verified":
        return bool(row["verified"]["count"] > 0)
    if request.segment == "unknown":
        return (
            activity["coverage"] != "observed"
            or activity["counts"]["uncorrelated"] > 0
            or not any(
                activity["counts"][k]
                for k in ("started", "returned", "failed", "cancelled", "blocked")
            )
        )
    key = {"possible_incomplete": "possibleIncomplete", "in_progress": "inProgress"}.get(
        request.segment, request.segment
    )
    return bool(activity["counts"].get(key, 0) > 0)


async def audience_page(request: AudienceRequest, secret: str, now: datetime) -> dict:
    page, at = _cursor(request, secret, now)
    source = await asyncio.wait_for(asyncio.to_thread(_firebase_page, page), timeout=6)
    records = list(source.users)
    if len(records) > PAGE_SIZE or len({r.uid for r in records}) != len(records):
        raise ValueError("invalid audience source page")
    eligible = {r.uid: r for r in records if _registered(r)}
    excluded = len(records) - len(eligible)
    result = []
    since = at - timedelta(days=7)
    if eligible:
        pool = await get_pool()
        async with pool.acquire(timeout=3) as conn, conn.transaction(isolation="read_committed"):
            await conn.execute("SET LOCAL statement_timeout='5s'")
            await conn.execute("SET LOCAL lock_timeout='1s'")
            active = await AccountDeletionLifecycleService.active_projection_user_ids(
                conn, user_ids=eligible
            )
            excluded += len(eligible) - len(active)
            identity_service = ActorIdentityService()
            phones = await identity_service.read_provider_phone_fallbacks(
                conn, candidates={uid: str(eligible[uid].phone_number or "") for uid in active}
            )
            identities = await identity_service.get_many(active, conn=conn)
            ids = sorted(active)
            epochs = {
                r["user_id"]: r
                for r in await conn.fetch(
                    "SELECT user_id,generation,started_at FROM one_product_activity_epochs "
                    "WHERE user_id=ANY($1::text[]) ORDER BY user_id FOR SHARE",
                    ids,
                    timeout=5,
                )
            }
            observations = await conn.fetch(
                ATTEMPTS_SQL, ids, request.agentId, since, at, timeout=5
            )
            if len(observations) > 100000:
                raise ValueError("audience attempt page exceeds bound")
            capped = {
                r["user_id"]
                for r in await conn.fetch(
                    "SELECT user_id FROM one_product_activity_observations "
                    "WHERE user_id=ANY($1::text[]) AND observed_at >= $2 AND observed_at <= $3 "
                    "GROUP BY user_id,(observed_at AT TIME ZONE 'UTC')::date HAVING COUNT(*)>=500",
                    ids,
                    since,
                    at,
                    timeout=5,
                )
            }
            verified = await value_summaries(conn, ids, request.agentId, since, at)
            for uid in eligible:
                if uid not in active:
                    continue
                row = {
                    "accountId": uid,
                    "agentId": request.agentId,
                    "identity": _identity(eligible[uid], identities.get(uid), phones.get(uid)),
                    "activity": summarize_attempts(
                        [r for r in observations if r["user_id"] == uid],
                        agent_id=request.agentId,
                        now=at,
                        grace=request.graceMinutes,
                        epoch=epochs.get(uid),
                        limited=uid in capped,
                        enabled=enabled_for(uid),
                    ),
                    "verified": verified[uid],
                }
                if _matches(row, request):
                    result.append(row)
    return {
        "version": 1,
        "environment": "production",
        "catalog": public_activity_catalog(),
        "asOf": _iso(at),
        "windowStart": _iso(since),
        "graceMinutes": request.graceMinutes,
        "source": "firebase_registered_accounts",
        "traversal": "live",
        "scanned": len(records),
        "excluded": excluded,
        "rows": result,
        "nextCursor": _next_cursor(source.next_page_token, request, secret, at),
        "campaignEnrollmentChanged": False,
    }
