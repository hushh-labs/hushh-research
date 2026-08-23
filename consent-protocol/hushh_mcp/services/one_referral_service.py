"""Referral program service.

Owns every database read and write for the referral program. The rules
themselves live in ``hushh_mcp.operons.referral`` and are pure; this file is
the part that talks to Postgres, and it deliberately holds no judgement of its
own beyond what the policy module decides.

Two things this service will never do:

  * trust a number the client sent about how long someone was present;
  * return anything about a referred person beyond a status word.

A referrer sees how many people they brought in and roughly where each one is.
They do not see who, when precisely, which agent, or why something was held.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.operons.referral.policy import (
    QUALIFIED,
    ReferralPolicy,
    public_status,
)
from hushh_mcp.operons.referral.slug import (
    generate_slug,
    is_valid_slug,
    normalize_slug,
)

logger = logging.getLogger(__name__)

# How many times to retry a slug collision before giving up. With 27^4 suffixes
# per stem, needing more than a handful means something is wrong that another
# retry will not fix.
_SLUG_ATTEMPTS = 8


class ReferralProgramDisabled(RuntimeError):
    """The program is switched off by policy."""


class ReferralServiceError(RuntimeError):
    """A referral operation could not be completed."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def referral_base_url() -> str:
    """Where a referral link points.

    Read from runtime env, never from the browser's own origin: a link built
    from `window.location.origin` inside the native app is `App://localhost`,
    which is dead the moment it is shared.
    """
    configured = (
        os.getenv("HUSHH_ONE_PUBLIC_APP_URL") or os.getenv("NEXT_PUBLIC_APP_URL") or ""
    ).strip()
    return configured.rstrip("/") or "https://uat.one.hushh.ai"


def _row_to_policy(row) -> ReferralPolicy:
    return ReferralPolicy(
        version=row.version,
        program_enabled=bool(row.program_enabled),
        new_users_only=bool(row.new_users_only),
        attribution_window_days=row.attribution_window_days,
        qualification_window_days=row.qualification_window_days,
        required_active_seconds=row.required_active_seconds,
        minimum_meaningful_events=row.minimum_meaningful_events,
        eligible_agent_keys=tuple(row.eligible_agent_keys or ()),
        heartbeat_interval_seconds=row.heartbeat_interval_seconds,
        max_credit_per_heartbeat_secs=row.max_credit_per_heartbeat_secs,
        recent_interaction_window_secs=row.recent_interaction_window_secs,
        max_reporting_gap_seconds=row.max_reporting_gap_seconds,
    )


def get_active_policy() -> ReferralPolicy:
    """The one live policy version. Raises if the program is switched off."""
    with get_db_connection() as connection:
        row = connection.execute(
            text(
                """
                SELECT *
                  FROM one_referral_policies
                 WHERE activated_at IS NOT NULL AND retired_at IS NULL
                 LIMIT 1
                """
            )
        ).fetchone()
    if row is None:
        raise ReferralProgramDisabled("no active referral policy")
    policy = _row_to_policy(row)
    if not policy.program_enabled:
        raise ReferralProgramDisabled("referral program disabled by policy")
    return policy


def _display_name_for(connection, user_id: str) -> str | None:
    row = connection.execute(
        text("SELECT display_name FROM actor_identity_cache WHERE user_id = :uid"),
        {"uid": user_id},
    ).fetchone()
    return row.display_name if row else None


def get_or_create_referral_code(user_id: str, policy: ReferralPolicy) -> dict:
    """This person's one active slug, minting it on first ask.

    Creation is idempotent under concurrency: two simultaneous first loads of
    the Referrals tab both try to insert, the partial unique index lets exactly
    one win, and the loser re-reads the winner's row instead of erroring.
    """
    with get_db_connection() as connection:
        existing = connection.execute(
            text(
                """
                SELECT slug, normalized_slug, created_at
                  FROM one_referral_codes
                 WHERE owner_user_id = :uid AND status = 'active'
                 LIMIT 1
                """
            ),
            {"uid": user_id},
        ).fetchone()
        if existing:
            return {"slug": existing.slug, "normalized_slug": existing.normalized_slug}

        display_name = _display_name_for(connection, user_id)

    for _ in range(_SLUG_ATTEMPTS):
        candidate = generate_slug(display_name)
        normalized = normalize_slug(candidate)
        if not is_valid_slug(normalized):
            continue
        try:
            with get_db_connection() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO one_referral_codes
                          (owner_user_id, slug, normalized_slug, policy_version)
                        VALUES (:uid, :slug, :normalized, :version)
                        """
                    ),
                    {
                        "uid": user_id,
                        "slug": normalized,
                        "normalized": normalized,
                        "version": policy.version,
                    },
                )
            return {"slug": normalized, "normalized_slug": normalized}
        except Exception:  # noqa: BLE001 -- unique violation on either index
            # Either this slug was taken, or this user won a race with
            # themselves. Re-read before deciding which.
            with get_db_connection() as connection:
                row = connection.execute(
                    text(
                        """
                        SELECT slug, normalized_slug
                          FROM one_referral_codes
                         WHERE owner_user_id = :uid AND status = 'active'
                         LIMIT 1
                        """
                    ),
                    {"uid": user_id},
                ).fetchone()
            if row:
                return {"slug": row.slug, "normalized_slug": row.normalized_slug}
            continue

    raise ReferralServiceError("could not allocate a referral slug")


def get_referral_summary(user_id: str) -> dict:
    """Everything the Referrals tab renders, and nothing more.

    The rows returned carry a status word and a date. No name, no phone, no
    email, no user id, no agent, and no reason -- a referrer learning that
    their friend was held for review would also learn what our checks look at.
    """
    policy = get_active_policy()
    code = get_or_create_referral_code(user_id, policy)

    with get_db_connection() as connection:
        rows = connection.execute(
            text(
                """
                SELECT status, created_at, qualified_at
                  FROM one_referral_relationships
                 WHERE referrer_user_id = :uid
                 ORDER BY created_at DESC
                 LIMIT 50
                """
            ),
            {"uid": user_id},
        ).fetchall()

    qualified = sum(1 for row in rows if row.status == QUALIFIED)
    in_progress = sum(1 for row in rows if public_status(row.status) == "In progress")
    under_review = sum(1 for row in rows if public_status(row.status) == "Under review")

    return {
        "slug": code["slug"],
        "link": f"{referral_base_url()}/r/{code['slug']}",
        "qualified_count": qualified,
        "in_progress_count": in_progress,
        "under_review_count": under_review,
        "required_active_minutes": policy.required_active_seconds // 60,
        "new_users_only": policy.new_users_only,
        "referrals": [
            {
                "status": public_status(row.status),
                "started_on": (row.created_at or _now()).date().isoformat(),
            }
            for row in rows
        ],
    }
