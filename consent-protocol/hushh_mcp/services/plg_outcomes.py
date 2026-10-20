"""Metadata-only projections of domain-owned effects, never execution authority.

Each adapter names the narrow value its source proves. A saved analysis is not
a trade, an information-request reply is not identity approval, and a provider
return alone is never an outcome. Shared effects are deduplicated before One's
aggregate. Missing retained records never establish inactivity.
"""

from __future__ import annotations

from datetime import datetime, timezone

from hushh_mcp.services.pkm_mutation_contracts import derive_pkm_mutation_commit_id

DEFINITIONS = {
    "agent_personal_information": ("memory.confirmed_save.v1", "Owner-confirmed information saved"),
    "agent_email": ("mail.provider_send.v1", "Provider-confirmed email sent"),
    "agent_calendar": ("calendar.provider_effect.v1", "Provider-confirmed Calendar change"),
    "agent_kai": ("kai.confirmed_analysis_save.v1", "Owner-confirmed analysis saved"),
    "agent_kyc": ("kyc.provider_reply.v1", "Information-request reply sent"),
    "agent_nav": ("nav.owner_decision.v1", "Owner approved or declined a sharing request"),
    "agent_location": ("location.domain_effect.v1", "Confirmed Location sharing or change"),
    "agent_wallet": ("wallet.confirmed_card_save.v1", "Owner-confirmed card saved"),
    "agent_career": ("career.confirmed_resume_save.v1", "Owner-confirmed resume saved"),
    "agent_documents": ("documents.approved_share.v1", "Approved original document shared"),
    "agent_connected_systems": (
        "crm.provider_readback.v1",
        "CRM change confirmed by provider readback",
    ),
    "agent_one": ("one.distinct_domain_effects.v1", "Distinct verified task outcomes"),
}


def outcome_coverage(agent_id: str, *, public: bool) -> dict:
    if not public:
        return {
            "status": "internal",
            "proof": None,
            "label": "Internal stage",
            "reason": "Internal stages contribute to their user-facing task; they are not separate activation journeys.",
        }
    definition = DEFINITIONS.get(agent_id)
    if definition is None:
        return {
            "status": "unmeasured",
            "proof": None,
            "label": "Outcome not measured",
            "reason": "No domain-owned completion adapter is registered. Execution returns do not establish value.",
        }
    proof, label = definition
    return {
        "status": "supported",
        "proof": proof,
        "label": label,
        "reason": "Retained positive domain evidence only; missing records do not establish inactivity or complete coverage.",
    }


MAIL_SQL = """
SELECT action_id::text AS action_id, sent_at AS occurred_at
FROM gmail_owner_send_actions
WHERE user_id = $1 AND state = 'sent'
  AND send_at IS NULL
  AND NULLIF(gmail_message_id, '') IS NOT NULL
  AND sent_at >= $2 AND sent_at <= $3
ORDER BY sent_at DESC, action_id LIMIT 101
"""
MEMORY_SQL = """
SELECT DISTINCT c.commit_id::text AS action_id, c.created_at AS occurred_at,
  c.domain, e.metadata->'provenance'->>'mutation_plan_id' AS plan_id,
  e.metadata->'provenance'->>'authorization_mode' AS authorization_mode,
  e.metadata->'provenance'->>'writer_id' AS writer_id
FROM pkm_domain_commits c
JOIN pkm_events e ON e.user_id = c.user_id AND e.domain = c.domain
  AND e.operation_type = 'content_write'
  AND e.metadata->>'data_version' = c.result_content_revision::text
WHERE c.user_id = $1 AND c.commit_kind = 'mutation'
  AND c.result_content_revision IS NOT NULL
  AND c.created_at >= $2 AND c.created_at <= $3
  AND e.metadata->'provenance'->>'authorization_mode' = 'owner_confirmed'
  AND NULLIF(BTRIM(e.metadata->'provenance'->>'mutation_plan_id'), '') IS NOT NULL
  AND NULLIF(BTRIM(e.metadata->'provenance'->>'confirmation_receipt_id'), '') IS NOT NULL
ORDER BY occurred_at DESC, action_id LIMIT 101
"""
CALENDAR_SQL = """
SELECT effect_id AS action_id, occurred_at
FROM one_product_value_receipts
WHERE user_id=$1 AND agent_id='agent_calendar' AND proof='calendar.provider_effect.v1'
  AND occurred_at >= $2 AND occurred_at <= $3 AND expires_at > $3
  AND generation=(SELECT generation FROM one_product_activity_epochs WHERE user_id=$1)
ORDER BY occurred_at DESC, effect_id LIMIT 1001
"""
KYC_SQL = """
SELECT DISTINCT a.action_id::text AS action_id, a.sent_at AS occurred_at
FROM gmail_personal_information_requests w
JOIN gmail_owner_send_actions a ON a.action_id=w.reply_send_action_id AND a.user_id=w.user_id
WHERE w.user_id=$1 AND w.status='sent' AND a.state='sent' AND a.send_at IS NULL
  AND NULLIF(BTRIM(a.gmail_message_id),'') IS NOT NULL
  AND a.gmail_thread_id=w.gmail_thread_id AND a.sent_at >= $2 AND a.sent_at <= $3
ORDER BY occurred_at DESC, action_id LIMIT 1001
"""
NAV_SQL = """
SELECT effect_id AS action_id,occurred_at FROM one_product_value_receipts
WHERE user_id=$1 AND agent_id='agent_nav' AND proof='nav.owner_decision.v1'
  AND occurred_at >= $2 AND occurred_at <= $3 AND expires_at > $3
  AND generation=(SELECT generation FROM one_product_activity_epochs WHERE user_id=$1)
ORDER BY occurred_at DESC,effect_id LIMIT 1001
"""
LOCATION_SQL = """
SELECT d.operation_id::text AS action_id,d.settled_at AS occurred_at
FROM one_action_directive_ledger d
WHERE d.user_id=$1 AND d.channel='command' AND d.command_effect='action'
  AND d.state='settled' AND d.settlement_status='succeeded'
  AND d.settled_at >= $2 AND d.settled_at <= $3
  AND ((d.effect_request_hmac IS NOT NULL AND d.effect_receipt IS NOT NULL
    AND d.action_id IN ('location.rename_circle','location.remove_from_circle','location.leave_circle',
      'location.delete_circle','location.accept_circle_invite','location.decline_circle_invite',
      'location.create_public_link','location.revoke_public_link','location.confirm_nearby_check_in',
      'location.checkout_nearby','location.add_emergency_contact','location.remove_emergency_contact'))
    OR (d.settlement_reason_code IN ('verified_audience_receipts','verified_membership_receipts')
      AND d.action_id LIKE 'location.%'))
  AND (d.action_id <> 'location.checkout_nearby' OR d.effect_receipt->>'checkout_transitioned'='true')
  AND (d.action_id NOT IN ('location.add_emergency_contact','location.remove_emergency_contact')
       OR d.effect_receipt->>'changed'='true')
  AND (d.settlement_reason_code IS DISTINCT FROM 'verified_membership_receipts'
       OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(d.membership_receipts,'{}'::jsonb)) r
         WHERE CASE WHEN jsonb_typeof(r.value->'result'->'addedUserIds')='array'
           THEN jsonb_array_length(r.value->'result'->'addedUserIds') ELSE 0 END>0))
ORDER BY occurred_at DESC,action_id LIMIT 1001
"""
LOCATION_DIRECT_SQL = """
SELECT effect_id AS action_id,occurred_at FROM one_product_value_receipts
WHERE user_id=$1 AND agent_id='agent_location' AND proof='location.domain_effect.v1'
  AND occurred_at >= $2 AND occurred_at <= $3 AND expires_at > $3
  AND generation=(SELECT generation FROM one_product_activity_epochs WHERE user_id=$1)
ORDER BY occurred_at DESC,effect_id LIMIT 1001
"""
CRM_SQL = """
SELECT i.intent_id AS action_id, MIN(a.created_at) AS occurred_at
FROM connected_system_intents i JOIN connected_system_audit_events a
 ON a.intent_id=i.intent_id AND a.user_id=i.user_id AND a.approval_id=i.approval_id
WHERE i.user_id=$1 AND i.status='succeeded' AND i.result_class='succeeded'
  AND NULLIF(BTRIM(i.approval_id),'') IS NOT NULL
  AND a.status='succeeded' AND a.mcp_result_class='succeeded' AND a.readback_result_class='succeeded'
  AND a.action IN ('create','update','delete')
GROUP BY i.intent_id,i.approval_id
HAVING MIN(a.created_at) >= $2 AND MIN(a.created_at) <= $3
ORDER BY occurred_at DESC,action_id LIMIT 1001
"""
DOCUMENTS_SQL = """
SELECT o.operation_id::text AS action_id,o.settled_at AS occurred_at
FROM drive_share_permission_operations o
JOIN one_action_directive_ledger d ON d.user_id=o.user_id AND d.operation_id=o.batch_id
 AND d.document_request_id=o.request_id AND d.document_request_revision=o.review_revision
JOIN drive_share_reviews v ON v.directive_id=d.directive_id AND v.request_id=o.request_id
 AND v.revision=o.review_revision AND v.user_id=o.user_id
WHERE o.user_id=$1 AND o.kind='grant' AND o.state='succeeded' AND o.receipt_envelope IS NOT NULL
 AND d.channel='document_review' AND d.action_id='documents.share_originals'
 AND d.state='consumed' AND d.confirmed_at IS NOT NULL AND d.consumed_at IS NOT NULL
 AND v.decision='approved' AND o.settled_at >= $2 AND o.settled_at <= $3
ORDER BY occurred_at DESC,action_id LIMIT 1001
"""
WALLET_SQL = """
SELECT DISTINCT source_commit_id::text AS action_id,activated_at
FROM wallet_card_registrations
WHERE owner_user_id=$1 AND source_commit_id IS NOT NULL AND activated_at >= $2 AND activated_at <= $3
 AND origin IN ('owner_saved_card_v1','owner_manual_add_v1')
ORDER BY activated_at DESC,action_id LIMIT 1001
"""
CAPACITY_SQL = """SELECT EXISTS(SELECT 1 FROM one_product_value_receipts
  WHERE user_id=$1 AND generation=(SELECT generation FROM one_product_activity_epochs WHERE user_id=$1)
    AND occurred_at >= (date_trunc('day',CAST($2 AS timestamptz) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    AND occurred_at <= $3 AND expires_at > $3
  GROUP BY (occurred_at AT TIME ZONE 'UTC')::date HAVING COUNT(*)>=500)"""

SOURCE_QUERIES = (
    ("agent_email", MAIL_SQL.replace("LIMIT 101", "LIMIT 1001"), "gmail_send"),
    ("agent_calendar", CALENDAR_SQL, "calendar_effect"),
    ("agent_kyc", KYC_SQL, "gmail_send"),
    ("agent_nav", NAV_SQL, "consent_decision"),
    ("agent_location", LOCATION_SQL, "location_operation"),
    ("agent_location", LOCATION_DIRECT_SQL, "location_direct"),
    ("agent_documents", DOCUMENTS_SQL, "drive_permission"),
    ("agent_connected_systems", CRM_SQL, "crm_intent"),
)


def _focus(agent_id: str, *agents: str) -> bool:
    return agent_id == "agent_one" or agent_id in agents


async def value_summaries(
    conn, user_ids: list[str], agent_id: str, since: datetime, now: datetime
) -> dict[str, dict]:
    """Batch one bounded audience page using the same owner-specific source SQL.

    LATERAL retains each owner's ordering and 1,001-row overflow sentinel. The
    existing lifecycle transaction/locks remain owned by the audience caller.
    One needs eleven database round trips for the page, rather than per person.
    Only this module's static SQL is composed; owner IDs and times stay bound.
    """
    if len(user_ids) > 25 or len(set(user_ids)) != len(user_ids):
        raise ValueError("Outcome page exceeds its owner bound")
    if not user_ids:
        return {}
    cache: dict = {}
    queries = []
    if agent_id in DEFINITIONS:
        if _focus(
            agent_id, "agent_personal_information", "agent_kai", "agent_career", "agent_wallet"
        ):
            queries.append(MEMORY_SQL.replace("LIMIT 101", "LIMIT 1001"))
        if _focus(agent_id, "agent_wallet"):
            queries.append(WALLET_SQL)
        queries.extend(query for agent, query, _ in SOURCE_QUERIES if _focus(agent_id, agent))
        if _focus(agent_id, "agent_calendar", "agent_nav", "agent_location"):
            capacity = await conn.fetch(
                "SELECT owners.user_id AS _plg_user_id,("  # nosec B608
                + CAPACITY_SQL.replace("$1", "owners.user_id")
                + ") AS capped FROM unnest($1::text[]) AS owners(user_id)",
                user_ids,
                since,
                now,
                timeout=5,
            )
            if (
                len(capacity) != len(user_ids)
                or {row["_plg_user_id"] for row in capacity} != set(user_ids)
                or any(not isinstance(row["capped"], bool) for row in capacity)
            ):
                raise ValueError("Outcome capacity page is incomplete")
            for row in capacity:
                cache[(row["_plg_user_id"], since, now, "value_receipt_capacity")] = row["capped"]
        for query in queries:
            for uid in user_ids:
                cache[(uid, since, now, query)] = []
            rows = await conn.fetch(
                "SELECT owners.user_id AS _plg_user_id,effect.* "  # nosec B608
                "FROM unnest($1::text[]) AS owners(user_id) CROSS JOIN LATERAL ("
                + query.replace("$1", "owners.user_id")
                + ") AS effect",
                user_ids,
                since,
                now,
                timeout=5,
            )
            for row in rows:
                owner_rows = cache[(row["_plg_user_id"], since, now, query)]
                owner_rows.append(
                    {key: value for key, value in row.items() if key != "_plg_user_id"}
                )
                if len(owner_rows) > 1001:
                    raise ValueError("Outcome source exceeds its owner bound")
    summaries = {}
    for uid in user_ids:
        summaries[uid] = await value_summary(conn, uid, agent_id, since, now, cache=cache)
        # Release this owner's bounded source records as soon as summarized.
        for query in queries:
            del cache[(uid, since, now, query)]
        cache.pop((uid, since, now, "value_receipt_capacity"), None)
    return summaries


def confirmed_memory(row, user_id: str) -> bool:
    if row["authorization_mode"] != "owner_confirmed":
        return False
    try:
        return bool(
            row["action_id"]
            == derive_pkm_mutation_commit_id(
                user_id=user_id, domain=row["domain"], plan_id=row["plan_id"]
            )
        )
    except ValueError:
        return False


async def value_effects(
    conn, uid: str, agent_id: str, since: datetime, now: datetime, cache: dict | None = None
) -> tuple[dict, bool]:
    """Return opaque backend-only effect keys and timestamps, bounded per source.

    Keys do not leave this module's callers. In particular a KYC reply and its
    Mail send, or a saved analysis and its Memory commit, are the same One effect.
    """
    if agent_id not in DEFINITIONS:
        return {}, False
    effects: dict[str, datetime] = {}
    limited = False

    async def rows(query):
        nonlocal limited
        key = (uid, since, now, query)
        if cache is not None and key in cache:
            result = cache[key]
        else:
            result = await conn.fetch(query, uid, since, now, timeout=5)
            if cache is not None:
                cache[key] = result
        limited |= len(result) > 1000
        return result[:1000]

    def add(namespace, row):
        key = f"{namespace}:{row['action_id']}"
        at = row["occurred_at"].astimezone(timezone.utc)
        if not since <= at <= now:
            raise ValueError("Outcome outside requested window")
        effects[key] = min(effects.get(key, at), at)

    def focus(*agents):
        return _focus(agent_id, *agents)

    if focus("agent_calendar", "agent_nav", "agent_location"):
        key = (uid, since, now, "value_receipt_capacity")
        if cache is None or key not in cache:
            capped = await conn.fetchval(
                CAPACITY_SQL,
                uid,
                since,
                now,
                timeout=5,
            )
            if cache is not None:
                cache[key] = capped
        else:
            capped = cache[key]
        limited |= bool(capped)
    if focus("agent_personal_information", "agent_kai", "agent_career", "agent_wallet"):
        commits = await rows(MEMORY_SQL.replace("LIMIT 101", "LIMIT 1001"))
        wallet = (
            {r["action_id"] for r in await rows(WALLET_SQL)} if focus("agent_wallet") else set()
        )
        for row in commits:
            if not confirmed_memory(row, uid):
                continue
            if (
                focus("agent_personal_information")
                or agent_id == "agent_kai"
                and row["domain"] == "financial"
                and row.get("writer_id") == "kai_analysis_completion"
                or agent_id == "agent_career"
                and row["domain"] == "professional"
                and row.get("writer_id") == "career_resume_owner_review"
                or agent_id == "agent_wallet"
                and row["domain"] == "wallet"
                and row["action_id"] in wallet
            ):
                add("pkm_commit", row)
    for agent, query, namespace in SOURCE_QUERIES:
        if focus(agent):
            for row in await rows(query):
                add(namespace, row)
    limited |= len(effects) > 1000
    return dict(
        sorted(effects.items(), key=lambda pair: (pair[1], pair[0]), reverse=True)[:1000]
    ), limited


async def value_summary(
    conn, uid: str, agent_id: str, since: datetime, now: datetime, *, cache: dict | None = None
) -> dict:
    supported = agent_id in DEFINITIONS
    effects, limited = await value_effects(conn, uid, agent_id, since, now, cache)
    return {
        "supported": supported,
        "proof": DEFINITIONS[agent_id][0] if supported else None,
        "count": len(effects),
        "lastAt": max(effects.values()).isoformat() if effects else None,
        "limited": limited,
    }
