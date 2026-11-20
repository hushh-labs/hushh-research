"""Owner/participant-bound operation references from existing domain authorities.

Only bounded IDs and closed status flags enter Feed. Optional source relations
are omitted before PostgreSQL plans the query during rolling deployments.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Set
from typing import Any

from hushh_mcp.services.feed_location_facts import location_facts
from hushh_mcp.services.feed_search_identity import identity_projection

RELATIONS: dict[str, frozenset[str]] = {
    "connections": frozenset({"user_a_id", "user_b_id", "status"}),
    "feed_event_counterparts": frozenset({"feed_event_id", "counterpart_user_id"}),
    "actor_identity_cache": frozenset({"user_id", "display_name"}),
    "circle_chat_recipients": frozenset(
        {
            "message_id",
            "recipient_user_id",
            "membership_joined_at",
            "read_at",
            "deleted_at",
            "feed_event_id",
        }
    ),
    "circle_chat_messages": frozenset(
        {"id", "circle_id", "sender_user_id", "deleted_for_everyone_at"}
    ),
    "one_location_circles": frozenset({"id", "status", "is_system", "system_kind"}),
    "one_location_circle_memberships": frozenset({"circle_id", "user_id", "status", "joined_at"}),
    "consent_audit": frozenset({"id", "user_id", "request_id", "action", "metadata"}),
    "one_information_request_items": frozenset({"request_id", "bundle_id"}),
    "one_information_request_bundles": frozenset(
        {"bundle_id", "subject_user_id", "requester_user_id"}
    ),
    "one_location_circle_member_invites": frozenset(
        {"id", "inviter_user_id", "invitee_user_id", "metadata"}
    ),
    "one_location_share_grants": frozenset({"id", "owner_user_id", "recipient_user_id"}),
    "one_location_access_requests": frozenset({"id", "owner_user_id", "requester_user_id"}),
    "one_location_events": frozenset(
        {"id", "owner_user_id", "recipient_user_id", "event_type", "grant_id", "request_id"}
    ),
    "gmail_personal_information_requests": frozenset(
        {"workflow_id", "user_id", "reply_send_action_id", "status"}
    ),
    "gmail_owner_send_actions": frozenset({"action_id", "user_id", "state"}),
    "google_provider_connections": frozenset({"user_id", "provider", "status"}),
    "google_service_grants": frozenset({"user_id", "provider", "service", "status"}),
    "kai_gmail_connections": frozenset({"user_id", "status"}),
    "user_external_connector_connections": frozenset(
        {"user_id", "connector_id", "connection_generation", "status"}
    ),
    "drive_bulk_shares": frozenset({"share_id", "user_id", "origin_request_id"}),
}
UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


def _uuid(value: str) -> str:
    return f"CASE WHEN ({value}) ~* '{UUID_PATTERN}' THEN ({value})::uuid ELSE NULL END"


def _integer(value: str) -> str:
    return (
        f"CASE WHEN ({value}) ~ '^[0-9]{{1,19}}$' THEN CASE "
        f"WHEN ({value})::numeric <= 9223372036854775807 THEN ({value})::bigint END END"
    )


SchemaHas = Callable[[str], bool]
Projection = tuple[list[str], list[str], dict[str, str]]


def _consent_projection(has: SchemaHas, columns: Mapping[str, Set[str]]) -> Projection:
    joins: list[str] = []
    patches: list[str] = []
    required: dict[str, str] = {}
    if has("consent_audit"):
        joins.append(f"""LEFT JOIN consent_audit fa ON f.source_domain='consent'
          AND f.event_type IN ('consent_requested','consent_granted','consent_revoked')
          AND fa.id={_integer("f.source_row_id")} AND fa.user_id=f.user_id
          AND fa.action=CASE f.event_type WHEN 'consent_requested' THEN 'REQUESTED'
            WHEN 'consent_granted' THEN 'CONSENT_GRANTED' WHEN 'consent_revoked' THEN 'REVOKED' END""")
        patches.append(
            "jsonb_strip_nulls(jsonb_build_object('request_id',fa.request_id, 'bundle_id',fa.metadata->>'bundle_id'))"
        )
    if has("one_information_request_items") and has("one_information_request_bundles"):
        audit_request = (
            "COALESCE(fa.request_id,f.metadata->>'request_id')"
            if has("consent_audit")
            else "f.metadata->>'request_id'"
        )
        # Closed source/schema fragments only; values remain in execute_raw parameters.
        joins.append(f"""LEFT JOIN LATERAL (
          SELECT b.bundle_id::text AS bundle_id, i.request_id
          FROM one_information_request_bundles b
          LEFT JOIN one_information_request_items i ON i.bundle_id=b.bundle_id
          WHERE f.source_domain='consent' AND f.user_id IN(b.subject_user_id,b.requester_user_id)
            AND (i.request_id={audit_request} OR
              (f.event_type IN ('consent_denied','consent_cancelled') AND
               (i.request_id=f.source_row_id OR b.bundle_id={_uuid("f.source_row_id")})))
          ORDER BY b.bundle_id,i.request_id LIMIT 1
        ) fb ON TRUE""")  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
        patches.append(
            "jsonb_strip_nulls(jsonb_build_object('bundle_id',fb.bundle_id,'request_id',fb.request_id))"
        )
    return joins, patches, required


def _location_projection(has: SchemaHas, columns: Mapping[str, Set[str]]) -> Projection:
    joins: list[str] = []
    patches: list[str] = []
    required: dict[str, str] = {}
    if has("one_location_events"):
        joins.append(f"""LEFT JOIN one_location_events fle ON f.source_domain='location'
          AND fle.id={_integer("split_part(f.source_row_id,':',1)")} AND fle.event_type=f.event_type
          AND f.user_id IN(fle.owner_user_id,fle.recipient_user_id)""")
    grant_id = (
        f"COALESCE({_uuid("split_part(f.source_row_id,':',1)")},{_uuid("f.metadata->>'grant_id'")})"
    )
    request_id = f"COALESCE({_uuid("split_part(f.source_row_id,':',1)")},{_uuid("f.metadata->>'request_id'")})"
    if has("one_location_events"):
        grant_id = f"COALESCE(fle.grant_id,{grant_id})"
        request_id = f"COALESCE(fle.request_id,{request_id})"
    if has("one_location_share_grants"):
        joins.append(f"""LEFT JOIN one_location_share_grants flg ON f.source_domain='location'
          AND f.event_type IN ('location_share_created','location_share_revoked','location_share_expired',
            'location_share_shortened','location_share_duration_changed')
          AND flg.id={grant_id} AND f.user_id IN(flg.owner_user_id,flg.recipient_user_id)""")
        patches.append("jsonb_strip_nulls(jsonb_build_object('grant_id',flg.id::text))")
    if has("one_location_access_requests"):
        joins.append(f"""LEFT JOIN one_location_access_requests flr ON f.source_domain='location'
          AND f.event_type IN ('location_access_request','location_access_approved','location_access_denied','location_access_request_withdrawn')
          AND flr.id={request_id} AND f.user_id IN(flr.owner_user_id,flr.requester_user_id)""")
        patches.append("jsonb_strip_nulls(jsonb_build_object('request_id',flr.id::text))")
    if (
        has("one_location_share_grants")
        and has("one_location_access_requests")
        and "approved_grant_id" in columns["one_location_access_requests"]
    ):
        # A grant created by an approved request is that request's result. A
        # legacy ambiguous binding must not merge distinct requests.
        joins.append("""LEFT JOIN LATERAL (
          SELECT CASE WHEN count(*)=1 THEN min(origin.id::text) END AS request_id
          FROM one_location_access_requests origin WHERE origin.approved_grant_id=flg.id
            AND origin.owner_user_id=flg.owner_user_id AND origin.requester_user_id=flg.recipient_user_id
            AND f.user_id IN(origin.owner_user_id,origin.requester_user_id)
        ) location_origin ON TRUE""")
        patches.append(
            "jsonb_strip_nulls(jsonb_build_object('request_id',location_origin.request_id))"
        )
    return joins, patches, required


def _mail_projection(has: SchemaHas, columns: Mapping[str, Set[str]]) -> Projection:
    joins: list[str] = []
    patches: list[str] = []
    required: dict[str, str] = {}
    if has("gmail_personal_information_requests"):
        confirmed_owner = (
            " AND EXISTS(SELECT 1 FROM gmail_owner_send_actions verified_send WHERE verified_send.action_id=f.source_row_id AND verified_send.user_id=f.user_id AND verified_send.state='sent')"
            if has("gmail_owner_send_actions")
            else " AND FALSE"
        )
        # Closed source/schema fragments only; values remain in execute_raw parameters.
        joins.append(f"""LEFT JOIN LATERAL (SELECT
          CASE WHEN count(*)=1 THEN min(candidate.workflow_id::text)::uuid END AS workflow_id,
          CASE WHEN count(*)=1 THEN min(candidate.status) END AS status
          FROM gmail_personal_information_requests candidate WHERE candidate.user_id=f.user_id AND (( f.event_type='mail_information_request_detected' AND candidate.workflow_id={_uuid("f.source_row_id")})
            OR (f.event_type='mail_message_sent' AND candidate.reply_send_action_id=f.source_row_id {confirmed_owner}))) fkw ON TRUE""")  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
        patches.append("jsonb_strip_nulls(jsonb_build_object('workflow_id',fkw.workflow_id::text))")
        required["mail_information_request_detected"] = (
            "fkw.workflow_id IS NOT NULL AND fkw.status='detected'"
        )
    if has("gmail_owner_send_actions"):
        joins.append("""LEFT JOIN gmail_owner_send_actions fsa ON fsa.user_id=f.user_id
          AND f.event_type IN('mail_message_sent','mail_message_failed','mail_delivery_unconfirmed')
          AND fsa.action_id=f.source_row_id""")
        patches.append(
            "jsonb_strip_nulls(jsonb_build_object('send_action_id',fsa.action_id,'send_state',fsa.state))"
        )
        required["mail_message_sent"] = "fsa.state='sent'"
        required["mail_message_failed"] = "fsa.state='failed'"
        required["mail_delivery_unconfirmed"] = "fsa.state='outcome_unknown'"
    return joins, patches, required


def _google_projection(has: SchemaHas, columns: Mapping[str, Set[str]]) -> Projection:
    joins: list[str] = []
    patches: list[str] = []
    required: dict[str, str] = {}
    if has("google_provider_connections") and has("google_service_grants"):
        joins.append("""LEFT JOIN google_provider_connections fgc ON f.event_type='calendar_reconnect_required'
          AND fgc.user_id=f.user_id AND fgc.provider='google'
          LEFT JOIN google_service_grants fgg ON fgg.user_id=fgc.user_id
            AND fgg.provider='google' AND fgg.service='calendar'""")
        required["calendar_reconnect_required"] = (
            "fgc.status='needs_reauth' OR (fgc.status='connected' AND fgg.status='needs_reauth')"
        )
        patches.append(
            "CASE WHEN f.event_type='calendar_reconnect_required' AND fgc.user_id IS NOT NULL THEN jsonb_build_object('connector_key','calendar:default') ELSE '{}'::jsonb END"
        )
    if has("kai_gmail_connections"):
        joins.append(
            "LEFT JOIN kai_gmail_connections fgm ON f.event_type='mail_reconnect_required' AND fgm.user_id=f.user_id"
        )
        required["mail_reconnect_required"] = "fgm.status='error'"
        patches.append(
            "CASE WHEN f.event_type='mail_reconnect_required' AND fgm.user_id IS NOT NULL THEN jsonb_build_object('connector_key','gmail:default') ELSE '{}'::jsonb END"
        )
    return joins, patches, required


def _connector_projection(has: SchemaHas, columns: Mapping[str, Set[str]]) -> Projection:
    joins: list[str] = []
    patches: list[str] = []
    required: dict[str, str] = {}
    if has("user_external_connector_connections"):
        joins.append("""LEFT JOIN user_external_connector_connections fxc ON f.event_type='connector_reconnect_required'
          AND fxc.user_id=f.user_id AND fxc.connector_id=regexp_replace(f.source_row_id, ':[0-9]+:' || 'needs_reauth$', '')
          AND f.source_row_id=fxc.connector_id || ':' || fxc.connection_generation::text || ':' || 'needs_reauth'""")
        required["connector_reconnect_required"] = "fxc.status='needs_reauth'"
        patches.append(
            "CASE WHEN fxc.connector_id IS NOT NULL THEN jsonb_build_object('connector_key','external:' || fxc.connector_id) ELSE '{}'::jsonb END"
        )
    if has("drive_bulk_shares"):
        joins.append(f"""LEFT JOIN drive_bulk_shares fbs ON f.event_type IN('drive_bulk_completed','drive_bulk_partial','drive_bulk_failed','drive_bulk_stopped')
          AND fbs.share_id={_uuid("split_part(f.source_row_id,':',1)")}
          AND fbs.user_id=f.user_id AND fbs.origin_request_id IS NULL""")
        patches.append("jsonb_strip_nulls(jsonb_build_object('bulk_share_id',fbs.share_id::text))")
    return joins, patches, required


def source_events_sql(
    columns: Mapping[str, Set[str]], *, historical: bool = False, include_dismissed: bool = False
) -> str:
    def has(table: str) -> bool:
        return RELATIONS[table].issubset(columns.get(table, set()))

    joins: list[str] = []
    patches: list[str] = ["'{}'::jsonb"]
    required = {
        "location_circle_message": "FALSE",
        "mail_reconnect_required": "FALSE",
        "calendar_reconnect_required": "FALSE",
        "connector_reconnect_required": "FALSE",
        "mail_information_request_detected": "FALSE",
        "mail_message_sent": "FALSE",
        "mail_message_failed": "FALSE",
        "mail_delivery_unconfirmed": "FALSE",
    }
    for project in (
        _consent_projection,
        _location_projection,
        _mail_projection,
        _google_projection,
        _connector_projection,
        identity_projection,
    ):
        source_joins, source_patches, source_required = project(has, columns)
        joins.extend(source_joins)
        patches.extend(source_patches)
        required.update(source_required)
    location_joins, location_patches, location_required = location_facts(
        has, columns, _uuid, historical=historical
    )
    joins.extend(location_joins)
    patches.extend(location_patches)
    required.update(location_required)

    if not historical and all(
        has(table)
        for table in (
            "circle_chat_recipients",
            "circle_chat_messages",
            "one_location_circles",
            "one_location_circle_memberships",
        )
    ):
        required["location_circle_message"] = """EXISTS(SELECT 1 FROM circle_chat_messages message
          JOIN circle_chat_recipients recipient ON recipient.message_id=message.id AND recipient.recipient_user_id=f.user_id
          JOIN one_location_circles circle ON circle.id=message.circle_id AND circle.status='active'
            AND NOT circle.is_system AND circle.system_kind IS NULL
          JOIN one_location_circle_memberships member ON member.circle_id=circle.id
            AND member.user_id=f.user_id AND member.status='active' AND member.joined_at=recipient.membership_joined_at
          WHERE recipient.feed_event_id=f.id AND message.sender_user_id<>f.user_id
            AND recipient.read_at IS NULL AND recipient.deleted_at IS NULL AND message.deleted_for_everyone_at IS NULL)"""

    for event in ("connection_accepted", "connection_rejected", "connection_withdrawn"):
        required[event] = "COALESCE(f.metadata->>'actor_is_self','false')<>'true'"
        if event == "connection_withdrawn":
            required[event] += " AND NULLIF(f.source_row_id,'') IS NOT NULL"
    if {"id", "owner_user_id"}.issubset(columns.get("one_location_circles", set())):
        required["circle_deleted"] = (
            # Closed source/schema fragments only; values remain in execute_raw parameters.
            f"f.metadata->>'actor_is_self'='false' OR EXISTS(SELECT 1 FROM one_location_circles deleted_circle WHERE deleted_circle.id=COALESCE({_uuid("f.metadata->>'circle_id'")},{_uuid("split_part(f.source_row_id,':',1)")}) AND deleted_circle.owner_user_id<>f.user_id)"  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
        )

    action_required = (
        "CASE "
        + " ".join(
            f"WHEN f.event_type='{event}' THEN COALESCE(({predicate}),FALSE)"
            for event, predicate in required.items()
        )
        + " ELSE TRUE END"
    )
    metadata = " || ".join(patches)
    dismissal = (
        "NULL::timestamptz AS dismissed_at,NULL::uuid AS dismissal_token"
        if include_dismissed
        else "f.dismissed_at,f.dismissal_token"
    )
    # Closed source/schema fragments only; values remain in execute_raw parameters.
    return f"""SELECT f.id,f.user_id,f.source_domain,f.event_type,f.actor_label,f.source_row_id,
      f.read_at,f.created_at,{dismissal},
      (CASE WHEN f.source_domain='location' AND f.event_type IN(
        'location_share_created','location_share_revoked','location_share_expired','location_share_shortened',
        'location_share_duration_changed','location_access_request','location_access_approved',
        'location_access_denied','location_access_request_withdrawn') THEN f.metadata-'grant_id'-'request_id'
        WHEN f.event_type IN('mail_information_request_detected','mail_message_sent','mail_message_failed','mail_delivery_unconfirmed')
        THEN f.metadata-'workflow_id'-'send_action_id'-'send_state' ELSE f.metadata END) || ({metadata}) AS metadata, {action_required} AS source_action_required
      FROM (SELECT id,user_id,source_domain,event_type,actor_label,source_row_id,
        read_at,created_at,dismissed_at,
        (to_jsonb(feed_events)->>'dismissal_token')::uuid AS dismissal_token,
        CASE WHEN jsonb_typeof(metadata)='object' THEN metadata ELSE '{{}}'::jsonb END AS metadata
        FROM feed_events WHERE user_id=:user_id) f {" ".join(joins)} WHERE f.user_id=:user_id"""  # nosec B608 -- authored SQL fragments; all request values use bind parameters.


def load_source_columns(execute_raw: Callable[[str, dict[str, Any]], Any]) -> dict[str, set[str]]:
    rows = (
        execute_raw(
            """SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=ANY(CAST(:tables AS text[]))""",
            {"tables": list(RELATIONS)},
        ).data
        or []
    )
    result: dict[str, set[str]] = {}
    for row in rows:
        if row.get("table_name") and row.get("column_name"):
            result.setdefault(str(row["table_name"]), set()).add(str(row["column_name"]))
    return result
