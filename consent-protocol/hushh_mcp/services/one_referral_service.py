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
    ATTRIBUTED,
    ENGAGING,
    EXPIRED,
    ONBOARDED,
    PHONE_VERIFIED,
    QUALIFIED,
    REJECTED,
    SIGNED_UP,
    TERMINAL_STATES,
    UNDER_REVIEW,
    QualificationInput,
    ReferralPolicy,
    evaluate,
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


# ---------------------------------------------------------------------------
# Qualification: driven by onboarding completion, nothing else
# ---------------------------------------------------------------------------
# The funnel a relationship walks through on its way to a decision. Each entry
# past the current status is a legal single-step transition under the database
# trigger, so advancing several steps at once means issuing one UPDATE per
# step rather than jumping straight to the end. `engaging` stays a stop on
# this path for exactly one reason: it is already a legal hop out of
# `onboarded` and into `qualified`/`under_review`, so reusing it here needs no
# schema or trigger change. Nothing about reaching it requires engagement any
# more -- a relationship passes through it the instant onboarding completes.
_FUNNEL_ORDER = (ATTRIBUTED, SIGNED_UP, PHONE_VERIFIED, ONBOARDED, ENGAGING)

_STEP_SQL = {
    SIGNED_UP: text(
        "UPDATE one_referral_relationships"
        "   SET status = 'signed_up', signed_up_at = COALESCE(signed_up_at, :ts)"
        " WHERE id = :rid"
    ),
    PHONE_VERIFIED: text(
        "UPDATE one_referral_relationships"
        "   SET status = 'phone_verified', phone_verified_at = COALESCE(phone_verified_at, :ts)"
        " WHERE id = :rid"
    ),
    ONBOARDED: text(
        "UPDATE one_referral_relationships"
        "   SET status = 'onboarded', onboarded_at = COALESCE(onboarded_at, :ts)"
        " WHERE id = :rid"
    ),
    ENGAGING: text(
        "UPDATE one_referral_relationships"
        "   SET status = 'engaging', engagement_started_at = COALESCE(engagement_started_at, :ts)"
        " WHERE id = :rid"
    ),
}

_TARGET_SQL = {
    QUALIFIED: text(
        "UPDATE one_referral_relationships"
        "   SET status = 'qualified', qualified_at = :ts"
        " WHERE id = :rid"
    ),
    UNDER_REVIEW: text(
        "UPDATE one_referral_relationships SET status = 'under_review' WHERE id = :rid"
    ),
    REJECTED: text(
        "UPDATE one_referral_relationships"
        "   SET status = 'rejected', rejected_at = :ts"
        " WHERE id = :rid"
    ),
    EXPIRED: text(
        "UPDATE one_referral_relationships"
        "   SET status = 'expired', expired_at = :ts"
        " WHERE id = :rid"
    ),
}


def sync_referral_qualification_from_onboarding(referred_user_id: str) -> dict:
    """Advance this person's referral relationship after they finish onboarding.

    This is the only place a relationship moves past `signed_up`. It is called
    from the same authenticated write that marks a user's own setup complete,
    so it carries no attack surface beyond what that write already has: nobody
    can qualify a referral by acting on someone else's account.

    Reads two backend-persisted facts, never anything the caller asserts:

      * ``vault_keys.setup_completed`` -- the One product's own record of
        whether this person finished the required onboarding flow.
      * ``actor_identity_cache.phone_verified`` -- set from a live Firebase
        Admin lookup, not from a client-supplied flag.

    Safe to call for someone who was never referred (a no-op), for a
    relationship that already settled (a no-op), and to call twice for the
    same onboarding-completed event (the second call finds nothing left to
    change and writes nothing).
    """
    try:
        policy = get_active_policy()
    except ReferralProgramDisabled:
        return {"status": "program_disabled"}

    with get_db_connection() as connection:
        relationship = connection.execute(
            text(
                """
                SELECT id, status
                  FROM one_referral_relationships
                 WHERE referred_user_id = :uid
                 LIMIT 1
                 FOR UPDATE
                """
            ),
            {"uid": referred_user_id},
        ).fetchone()
        if relationship is None:
            return {"status": "not_referred"}
        if relationship.status in TERMINAL_STATES or relationship.status == QUALIFIED:
            return {"status": "no_change", "relationship_status": relationship.status}

        vault_row = connection.execute(
            text("SELECT setup_completed, setup_completed_at FROM vault_keys WHERE user_id = :uid"),
            {"uid": referred_user_id},
        ).fetchone()
        identity_row = connection.execute(
            text("SELECT phone_verified FROM actor_identity_cache WHERE user_id = :uid"),
            {"uid": referred_user_id},
        ).fetchone()

        onboarding_complete = bool(vault_row and vault_row.setup_completed)
        onboarded_at = (
            datetime.fromtimestamp(vault_row.setup_completed_at / 1000, tz=timezone.utc)
            if vault_row and vault_row.setup_completed_at
            else None
        )
        phone_verified = bool(identity_row and identity_row.phone_verified)

        decision = evaluate(
            QualificationInput(
                status=relationship.status,
                phone_verified=phone_verified,
                onboarding_complete=onboarding_complete,
                risk_level="low",
            ),
            policy,
        )
        if not decision.changed:
            return {"status": "no_change", "relationship_status": relationship.status}

        now = _now()
        if relationship.status in _FUNNEL_ORDER:
            start = _FUNNEL_ORDER.index(relationship.status)
            for step in _FUNNEL_ORDER[start + 1 :]:
                step_ts = onboarded_at if step == ONBOARDED and onboarded_at else now
                connection.execute(_STEP_SQL[step], {"ts": step_ts, "rid": relationship.id})
        connection.execute(_TARGET_SQL[decision.target_status], {"ts": now, "rid": relationship.id})

    return {"status": "updated", "relationship_status": decision.target_status}
