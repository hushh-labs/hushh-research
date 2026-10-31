"""Owner-scoped MVCC equality fence for complete consent source collection.

This is a bounded-read change detector, not a durable owner revision. It contains
only row-version identities and effective expiry states, never tokens or values.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlalchemy import String, select, text, union_all

# Fixed, typed predicates keep owner indexes usable and never materialize envelopes.
# Each tuple is (table, participant predicate, effective temporal projection).
_SOURCES = (
    (
        "consent_audit",
        "r.user_id=ANY(:identifiers)",
        "COALESCE(r.expires_at <= extract(epoch FROM now())*1000,false)::text||':'||COALESCE(r.poll_timeout_at <= extract(epoch FROM now())*1000,false)::text",
    ),
    (
        "one_information_request_bundles",
        "r.subject_user_id=:owner OR r.requester_user_id=:owner",
        "false",
    ),
    (
        "one_information_request_items",
        "EXISTS(SELECT 1 FROM one_information_request_bundles b WHERE (b.subject_user_id=:owner OR b.requester_user_id=:owner) AND b.bundle_id=r.bundle_id)",
        "false",
    ),
    (
        "drive_share_requests",
        "r.user_id=:owner OR r.recipient_user_id=:owner",
        "r.expires_at <= now()",
    ),
    ("drive_share_management_contexts", "r.user_id=:owner", "false"),
    (
        "drive_share_permission_operations",
        "r.user_id=:owner OR EXISTS(SELECT 1 FROM drive_share_requests q WHERE q.recipient_user_id=:owner AND q.request_id=r.request_id)",
        "false",
    ),
    (
        "drive_live_query_requests",
        "r.user_id=:owner OR r.requester_user_id=:owner",
        "COALESCE(r.expires_at <= now(),false)::text||':'||COALESCE(r.status='running' AND r.decided_at < now()-make_interval(secs=>:drive_stale_seconds),false)::text",
    ),
    (
        "one_location_share_grants",
        "r.owner_user_id=:owner OR r.recipient_user_id=:owner",
        "r.expires_at <= now()",
    ),
    (
        "one_location_access_requests",
        "r.owner_user_id=:owner OR r.requester_user_id=:owner",
        "COALESCE(r.expires_at <= now(),false)::text||':'||(r.expires_at IS NULL AND r.referred_by_user_id IS NULL AND NOT EXISTS(SELECT 1 FROM one_location_referrals f WHERE f.request_id=r.id) AND NOT EXISTS(SELECT 1 FROM one_location_public_invite_submissions s WHERE s.request_id=r.id) AND r.requested_at+make_interval(hours=>:location_expiry_hours) <= now())::text",
    ),
    (
        "one_location_referrals",
        "r.owner_user_id=:owner OR r.referring_user_id=:owner OR r.referred_user_id=:owner OR EXISTS(SELECT 1 FROM one_location_access_requests q WHERE (q.owner_user_id=:owner OR q.requester_user_id=:owner) AND q.id=r.request_id)",
        "false",
    ),
    (
        "one_location_public_invite_submissions",
        "r.owner_user_id=:owner OR r.matched_user_id=:owner OR EXISTS(SELECT 1 FROM one_location_access_requests q WHERE (q.owner_user_id=:owner OR q.requester_user_id=:owner) AND q.id=r.request_id)",
        "false",
    ),
    ("one_location_public_invites", "r.owner_user_id=:owner", "r.expires_at <= now()"),
    (
        "one_location_circle_invites",
        "r.owner_user_id=:owner OR r.claimed_by_user_id=:owner",
        "r.expires_at <= now()",
    ),
    (
        "one_location_circle_member_invites",
        "r.inviter_user_id=:owner OR r.invitee_user_id=:owner OR EXISTS(SELECT 1 FROM one_location_circles c WHERE c.owner_user_id=:owner AND c.id=r.circle_id)",
        "r.expires_at <= now()",
    ),
    (
        "one_location_circles",
        "r.owner_user_id=:owner OR EXISTS(SELECT 1 FROM one_location_circle_member_invites i WHERE i.invitee_user_id=:owner AND i.circle_id=r.id)",
        "false",
    ),
    ("marketplace_access_requests", "r.owner_user_id=:owner OR r.buyer_user_id=:owner", "false"),
    (
        "pkm_answer_requests",
        "r.owner_user_id=:owner OR r.requester_user_id=:owner",
        "COALESCE(r.expires_at <= now(),false)::text||':'||COALESCE(r.answer_deadline_at <= now(),false)::text",
    ),
    ("pkm_answer_payment_orders", "r.owner_user_id=:owner OR r.requester_user_id=:owner", "false"),
    ("connections", "r.user_a_id=:owner OR r.user_b_id=:owner", "false"),
    ("connection_requests", "r.requester_user_id=:owner OR r.addressee_user_id=:owner", "false"),
    ("actor_verified_email_aliases", "r.user_id=:owner", "false"),
    ("actor_identity_cache", "r.user_id=:owner", "false"),
)


def capture_consent_source_fence(
    connection: Any, *, owner: str, identifiers: list[str], configuration: dict[str, Any]
) -> str:
    from hushh_mcp.services.drive_live_query_store import STALE_CLAIM_SECONDS
    from hushh_mcp.services.one_location_agent_service import LOCATION_REQUEST_EXPIRY_HOURS

    connection.execute(text("SET LOCAL statement_timeout='6s'"))
    connection.execute(text("SET LOCAL lock_timeout='2s'"))
    queries = []
    for table, predicate, temporal in _SOURCES:
        query = f"SELECT '{table}' AS source,r.tableoid::text||':'||r.ctid::text||':'||r.xmin::text||':'||COALESCE(({temporal})::text,'false') AS version FROM {table} r WHERE {predicate}"  # nosec B608 # fixed authored identifiers/predicates, owner values are bound.
        queries.append(text(query).columns(source=String, version=String))
    versions = union_all(*queries).subquery()
    rows = connection.execute(
        select(versions.c.source, versions.c.version).order_by(
            versions.c.source, versions.c.version
        ),
        {
            "owner": owner,
            "identifiers": identifiers,
            "drive_stale_seconds": STALE_CLAIM_SECONDS,
            "location_expiry_hours": LOCATION_REQUEST_EXPIRY_HOURS,
        },
    ).all()
    payload = {
        "projection_version": 2,
        "identifiers": sorted(identifiers),
        "configuration": configuration,
        "versions": [list(row) for row in rows],
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
