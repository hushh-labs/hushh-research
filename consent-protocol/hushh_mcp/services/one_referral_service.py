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

# What a referrer is told about where someone has reached. Deliberately about
# the STEP, never the person: no name, no phone, no agent, no device. Four words
# or fewer, and nothing that reads as an accusation.
FUNNEL_STEP_LABELS: dict[str, str] = {
    "attributed": "Opened your link",
    "signed_up": "Joined",
    "phone_verified": "Verified phone",
    "onboarded": "Finished setup",
    "engaging": "Using an agent",
    "under_review": "Under review",
    "qualified": "Qualified",
    "ineligible": "Expired",
    "rejected": "Expired",
    "expired": "Expired",
    "revoked": "Expired",
}


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

    Each row carries a step, a date, and how far that person has got toward the
    active-time bar. It carries no name, phone, email, user id, agent or reason.
    A referrer can see that someone is partway there; they cannot see who, what
    they used, or why anything was held.
    """
    policy = get_active_policy()
    code = get_or_create_referral_code(user_id, policy)
    required_minutes = policy.required_active_seconds // 60

    with get_db_connection() as connection:
        all_statuses = connection.execute(
            text(
                """
                SELECT r.status
                  FROM one_referral_relationships r
                 WHERE r.referrer_user_id = :uid
                """
            ),
            {"uid": user_id},
        ).fetchall()

        rows = connection.execute(
            text(
                """
                SELECT r.status,
                       r.created_at,
                       r.qualified_at,
                       COALESCE(e.credited_seconds, 0)  AS credited_seconds,
                       COALESCE(e.meaningful_events, 0) AS meaningful_events
                  FROM one_referral_relationships r
                  LEFT JOIN LATERAL (
                        SELECT SUM(s.credited_active_seconds) AS credited_seconds,
                               SUM(s.meaningful_event_count)  AS meaningful_events
                          FROM one_agent_engagement_sessions s
                         WHERE s.user_id = r.referred_user_id
                           AND s.started_at >= r.created_at
                  ) e ON TRUE
                 WHERE r.referrer_user_id = :uid
                 ORDER BY r.created_at DESC
                 LIMIT 50
                """
            ),
            {"uid": user_id},
        ).fetchall()

    # Counts must cover every referral relationship, not just the 50 shown in
    # the Recent list below — a referrer with 63 referrals still sees 63
    # counted, even though only 50 render as rows.
    qualified = sum(1 for row in all_statuses if row.status == QUALIFIED)
    in_progress = sum(1 for row in all_statuses if public_status(row.status) == "In progress")
    under_review = sum(1 for row in all_statuses if public_status(row.status) == "Under review")

    referrals = []
    for row in rows:
        credited = int(row.credited_seconds or 0)
        # Never show more than the bar itself: a person who somehow banked extra
        # seconds is still just "done", and 17 of 15 reads like a bug.
        active_minutes = min(credited // 60, required_minutes)
        referrals.append(
            {
                "status": public_status(row.status),
                "step": FUNNEL_STEP_LABELS.get(row.status, "In progress"),
                "started_on": (row.created_at or _now()).date().isoformat(),
                "active_minutes": active_minutes,
                "required_minutes": required_minutes,
                "meaningful_events": int(row.meaningful_events or 0),
                "required_events": policy.minimum_meaningful_events,
            }
        )

    return {
        "slug": code["slug"],
        "link": f"{referral_base_url()}/r/{code['slug']}",
        "qualified_count": qualified,
        "in_progress_count": in_progress,
        "under_review_count": under_review,
        "required_active_minutes": required_minutes,
        "new_users_only": policy.new_users_only,
        "referrals": referrals,
    }


# Link-preview bots and messaging crawlers open a referral URL the moment it is
# pasted into a chat. They must never consume an attribution: the first eligible
# attribution wins, so a crawler that took one would spend the invitation before
# the human ever clicked it.
_CRAWLER_MARKERS = (
    "bot",
    "crawler",
    "spider",
    "preview",
    "facebookexternalhit",
    "whatsapp",
    "telegrambot",
    "slackbot",
    "twitterbot",
    "linkedinbot",
    "discordbot",
    "embedly",
    "quora link preview",
    "pinterest",
    "redditbot",
    "applebot",
    "skypeuripreview",
    "vkshare",
    "w3c_validator",
    "curl",
    "wget",
    "python-requests",
)


def looks_like_a_crawler(user_agent: str | None) -> bool:
    text = (user_agent or "").strip().lower()
    if not text:
        # No user agent at all is not a browser either. Fail closed: refusing to
        # create an attribution costs a real person nothing (the link still
        # works, it just re-resolves), while creating one for a crawler costs
        # the referrer their invitation.
        return True
    return any(marker in text for marker in _CRAWLER_MARKERS)


def resolve_slug_for_attribution(
    slug: str,
    *,
    user_agent: str | None = None,
    source: str | None = None,
    campaign: str | None = None,
    landing_route: str | None = None,
    installation_reference_hash: str | None = None,
) -> dict:
    """Open a referral link. Creates the attribution server-side, before sign-in.

    Returns the SAME shape for an invalid slug, a disabled slug and a slug whose
    owner no longer exists: `{"status": "unavailable"}`. Distinguishing them
    would turn this endpoint into an oracle for which slugs are real, which is
    the first step of enumerating the people who hold them.
    """
    normalized = normalize_slug(slug)
    if not is_valid_slug(normalized):
        return {"status": "unavailable"}

    try:
        policy = get_active_policy()
    except ReferralProgramDisabled:
        return {"status": "unavailable"}

    if looks_like_a_crawler(user_agent):
        # Resolve nothing, record nothing, and say nothing different.
        return {"status": "unavailable"}

    with get_db_connection() as connection:
        code = connection.execute(
            text(
                """
                SELECT id, owner_user_id
                  FROM one_referral_codes
                 WHERE normalized_slug = :slug AND status = 'active'
                 LIMIT 1
                """
            ),
            {"slug": normalized},
        ).fetchone()
        if code is None:
            return {"status": "unavailable"}

        row = connection.execute(
            text(
                """
                INSERT INTO one_referral_attributions
                  (referral_code_id, referrer_user_id, source, campaign,
                   landing_route, installation_reference_hash, policy_version,
                   expires_at)
                VALUES
                  (:code_id, :owner, :source, :campaign,
                   :landing_route, :install_hash, :version,
                   NOW() + make_interval(days => :window_days))
                RETURNING id
                """
            ),
            {
                "code_id": code.id,
                "owner": code.owner_user_id,
                "source": (source or None),
                "campaign": (campaign or None),
                "landing_route": (landing_route or None),
                "install_hash": (installation_reference_hash or None),
                "version": policy.version,
                "window_days": policy.attribution_window_days,
            },
        ).fetchone()

    return {"status": "created", "attribution_id": str(row.id)}


def bind_attribution(attribution_id: str, user_id: str) -> dict:
    """Attach a pending attribution to the person who just signed in.

    Every rejection returns a reason the CALLER may see, because these are all
    things about the caller's own account rather than about the referrer.
    Nothing here says anything about who the referrer is.
    """
    with get_db_connection() as connection:
        attribution = connection.execute(
            text(
                """
                SELECT id, referrer_user_id, policy_version, status, expires_at
                  FROM one_referral_attributions
                 WHERE id = CAST(:aid AS UUID)
                 LIMIT 1
                """
            ),
            {"aid": attribution_id},
        ).fetchone()

        if attribution is None:
            return {"status": "unavailable"}
        if attribution.status != "pending":
            return {"status": "already_used"}
        if attribution.expires_at <= _now():
            return {"status": "expired"}
        if attribution.referrer_user_id == user_id:
            # Opening your own link is not fraud, it is curiosity. Say nothing
            # accusatory and simply do not create anything.
            return {"status": "self_referral"}

        existing = connection.execute(
            text(
                """
                SELECT 1 FROM one_referral_relationships
                 WHERE referred_user_id = :uid LIMIT 1
                """
            ),
            {"uid": user_id},
        ).fetchone()
        if existing:
            # First eligible attribution wins. A later link cannot replace it.
            return {"status": "already_referred"}

        policy = get_active_policy()
        if policy.new_users_only:
            predates = connection.execute(
                text(
                    """
                    SELECT 1
                      FROM actor_profiles ap
                     WHERE ap.user_id = :uid
                       AND ap.created_at < (
                             SELECT first_seen_at
                               FROM one_referral_attributions
                              WHERE id = CAST(:aid AS UUID)
                           )
                    """
                ),
                {"uid": user_id, "aid": attribution_id},
            ).fetchone()
            if predates:
                # The account existed before the link was ever opened, so this
                # is not a new member the referrer brought in.
                return {"status": "existing_user"}

        connection.execute(
            text(
                """
                UPDATE one_referral_attributions
                   SET bound_user_id = :uid, bound_at = NOW(), status = 'bound'
                 WHERE id = CAST(:aid AS UUID) AND status = 'pending'
                """
            ),
            {"uid": user_id, "aid": attribution_id},
        )
        connection.execute(
            text(
                """
                INSERT INTO one_referral_relationships
                  (attribution_id, referrer_user_id, referred_user_id,
                   policy_version, status, signed_up_at)
                VALUES
                  (CAST(:aid AS UUID), :referrer, :uid, :version,
                   'signed_up', NOW())
                ON CONFLICT DO NOTHING
                """
            ),
            {
                "aid": attribution_id,
                "referrer": attribution.referrer_user_id,
                "uid": user_id,
                "version": attribution.policy_version,
            },
        )

    return {"status": "bound"}
