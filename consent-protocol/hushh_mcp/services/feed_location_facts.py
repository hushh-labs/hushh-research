"""Bounded Location state and recorded actor facts for the owner Feed projection."""

from typing import Any

from hushh_mcp.services.feed_location_state import grant_status_sql


def location_facts(has: Any, columns: Any, uuid_sql: Any, *, historical: bool):
    joins, patches, required = [], [], {}
    grants = ["flg"] if has("one_location_share_grants") else []
    has_requests = has("one_location_access_requests")
    if grants and has_requests:
        joins.append(f"""LEFT JOIN one_location_share_grants result_grant
          ON result_grant.id={uuid_sql("to_jsonb(flr)->>'approved_grant_id'")}
          AND result_grant.owner_user_id=flr.owner_user_id AND result_grant.recipient_user_id=flr.requester_user_id""")
        grants.append("result_grant")
    if grants or has_requests:
        # The grant and request tables roll out independently. A confirmed grant
        # still supplies current state when the request relation is unavailable.
        statuses = [grant_status_sql(alias) for alias in grants]
        recipients = [alias + ".recipient_user_id" for alias in grants]
        sources = [alias + ".id IS NOT NULL" for alias in grants]
        if has_requests:
            statuses.append(
                "CASE WHEN to_jsonb(flr)->>'status'='pending' AND (to_jsonb(flr)->>'expires_at')::timestamptz<=clock_timestamp() THEN 'expired' ELSE to_jsonb(flr)->>'status' END"
            )
            recipients.append("flr.requester_user_id")
            sources.append("flr.id IS NOT NULL")
        fields = [
            "'current_location_status',COALESCE(" + ",".join(statuses) + ")",
            "'feed_audience',CASE WHEN f.user_id=COALESCE("
            + ",".join(recipients)
            + ") THEN 'recipient' WHEN "
            + " OR ".join(sources)
            + " THEN 'owner' END",
        ]
        if grants:
            fields += [
                "'grant_id',COALESCE(" + ",".join(alias + ".id" for alias in grants) + ")::text",
                "'share_kind',COALESCE(f.metadata->>'share_kind',"
                + ",".join("to_jsonb(" + alias + ")->'metadata'->>'share_kind'" for alias in grants)
                + ")",
            ]
        if grants:
            # Existing atomic Check-In grants already bind owner, recipient and
            # client operation. No new plan, intended audience or failure state.
            owner = "COALESCE(" + ",".join(alias + ".owner_user_id" for alias in grants) + ")"
            operation = (
                "COALESCE("
                + ",".join(
                    "to_jsonb(" + alias + ")->'metadata'->>'client_operation_id'"
                    for alias in grants
                )
                + ")"
            )
            kind = (
                "COALESCE("
                + ",".join("to_jsonb(" + alias + ")->'metadata'->>'share_kind'" for alias in grants)
                + ")"
            )
            fields.append(
                "'check_in_operation_id',CASE WHEN "
                + owner
                + "=f.user_id AND "
                + kind
                + "='check_in' AND length("
                + operation
                + ") BETWEEN 1 AND 160 THEN "
                + operation
                + " END"
            )
        patches.append("jsonb_strip_nulls(jsonb_build_object(" + ",".join(fields) + "))")
    if has_requests and not historical:
        required["location_access_request"] = (
            "flr.id IS NULL OR (COALESCE(to_jsonb(flr)->>'status','pending')<>'expired' AND NOT(COALESCE(to_jsonb(flr)->>'status','pending')='pending' AND COALESCE((to_jsonb(flr)->>'expires_at')::timestamptz<=clock_timestamp(),FALSE)))"
        )
    if has("one_location_circle_member_invites"):
        joins.append(f"""LEFT JOIN one_location_circle_member_invites circle_invite
          ON circle_invite.id={uuid_sql("COALESCE(f.metadata->>'invite_id',split_part(f.source_row_id,':',1))")}
          AND f.user_id IN(circle_invite.inviter_user_id,circle_invite.invitee_user_id)""")
        patches.append(
            "jsonb_strip_nulls(jsonb_build_object('membership_key',circle_invite.metadata->>'membership_key'))"
        )
    if has("one_location_circles") and has("one_location_circle_memberships"):
        # Closed source/schema fragments only; values remain in execute_raw parameters.
        patches.append(f"""jsonb_build_object('current_circle_available', EXISTS(
          SELECT 1 FROM one_location_circles circle JOIN one_location_circle_memberships member
          ON member.circle_id=circle.id AND member.user_id=f.user_id AND member.status='active'
          WHERE circle.id={uuid_sql("f.metadata->>'circle_id'")} AND circle.status='active'))""")  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
    if has("one_location_events") and {"metadata", "actor_user_id"}.issubset(
        columns["one_location_events"]
    ):
        joins.append("""LEFT JOIN LATERAL (SELECT e.* FROM one_location_events e
          WHERE e.id=(SELECT min(candidate.id) FROM one_location_events candidate
            WHERE candidate.event_type=f.event_type AND f.user_id IN(candidate.owner_user_id,candidate.recipient_user_id)
            AND f.source_row_id IN(candidate.id::text,candidate.id::text||':'||'recipient',
              CASE WHEN candidate.event_type IN('location_share_created','location_share_revoked','location_share_expired') THEN candidate.grant_id::text
                WHEN candidate.event_type IN('location_share_shortened','location_share_duration_changed') AND NULLIF(candidate.metadata->>'client_operation_id','') IS NOT NULL
                  THEN candidate.grant_id::text||':'||'operation'||':'||left(candidate.metadata->>'client_operation_id',160)
                WHEN candidate.event_type='location_access_request' THEN candidate.request_id::text||':'||'revision'||':'||COALESCE(candidate.metadata->>'request_revision','1')
                WHEN candidate.event_type IN('location_access_approved','location_access_denied') THEN candidate.request_id::text END)
            HAVING count(*)=1)) recorded_location ON TRUE""")
        patches.append("""jsonb_strip_nulls(jsonb_build_object(
          'membership_key',CASE WHEN jsonb_typeof(recorded_location.metadata->'membership_key')='string' THEN left(recorded_location.metadata->>'membership_key',256) END,
          'circle_id',CASE WHEN recorded_location.metadata->>'circle_id' ~* '^[0-9a-f-]{36}$' THEN recorded_location.metadata->>'circle_id' END,
          'circle_name',CASE WHEN jsonb_typeof(recorded_location.metadata->'circle_name')='string' THEN left(recorded_location.metadata->>'circle_name',160) END,
          'actor_is_self',CASE WHEN recorded_location.actor_user_id IS NOT NULL THEN recorded_location.actor_user_id=f.user_id END,
          'reason',CASE WHEN recorded_location.metadata->>'reason' IN('owner_revoke','recipient_revoke','owner_shorten','recipient_shorten','expired','circle_membership_ended','circle_deleted','connection_disconnected') THEN recorded_location.metadata->>'reason' END,
          'approval_mode',CASE WHEN recorded_location.metadata->>'approval_mode' IN('automatic','manual') THEN recorded_location.metadata->>'approval_mode' END,
          'added_duration_hours',CASE WHEN jsonb_typeof(recorded_location.metadata->'added_duration_hours') IN('number','string') THEN left(recorded_location.metadata->>'added_duration_hours',32) END))""")
    source_kinds = ["to_jsonb(" + alias + ")->'metadata'->>'share_kind'" for alias in grants]
    known_kind = (
        "COALESCE("
        + ",".join(
            source_kinds
            + ["location_feed_origin.metadata->>'share_kind'", "f.metadata->>'share_kind'"]
        )
        + ")"
    )
    # Legacy duration receipts may omit share kind after the short-lived grant is purged.
    # Correlate only this viewer's exact recorded grant, never names or a time window.
    # Closed source/schema fragments only; values remain in execute_raw parameters.
    joins.append(f"""LEFT JOIN LATERAL (
      SELECT origin.metadata FROM feed_events origin
      WHERE f.source_domain='location' AND origin.user_id=f.user_id
        AND origin.source_domain='location'
        AND origin.event_type IN('location_share_created','location_share_unconfirmed')
        AND {_history_grant_expr("origin", uuid_sql)}={_history_grant_expr("f", uuid_sql)}
      ORDER BY origin.id DESC LIMIT 1) location_feed_origin ON TRUE""")  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
    patches.append("jsonb_strip_nulls(jsonb_build_object('share_kind'," + known_kind + "))")
    # A durable receipt is history identity, never authority for a live action.
    patches.append(f"""CASE WHEN f.source_domain='location' AND f.event_type IN(
      'location_share_created','location_share_revoked','location_share_expired','location_share_shortened','location_share_duration_changed')
      THEN jsonb_strip_nulls(jsonb_build_object('recorded_grant_id',COALESCE(
        {_history_grant_expr("f", uuid_sql)},NULLIF(f.metadata->>'recorded_grant_id','')))) ELSE '{{}}'::jsonb END""")
    # Closed source/schema fragments only; values remain in execute_raw parameters.
    published_sos = f"""COALESCE({known_kind},'share')<>'sos' OR (
      f.metadata->>'feed_audience'='recipient' AND EXISTS(SELECT 1 FROM feed_events published
        WHERE published.user_id=f.user_id AND published.source_domain='location'
          AND published.event_type='location_share_created' AND published.metadata->'feed_sms_confirmed'='true'::jsonb
          AND {_history_grant_expr("published", uuid_sql)}={_history_grant_expr("f", uuid_sql)}))"""  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
    for event in (
        "location_share_created",
        "location_share_revoked",
        "location_share_expired",
        "location_share_shortened",
        "location_share_duration_changed",
    ):
        required[event] = published_sos
    # A lifecycle label without an exact recorded operation is not reviewable.
    for event in (
        "location_share_created",
        "location_share_revoked",
        "location_share_expired",
        "location_share_shortened",
        "location_share_duration_changed",
    ):
        required[event] = (
            "("
            + required[event]
            + ") AND "
            + (
                "COALESCE(flg.id::text," + _history_grant_expr("f", uuid_sql) + ")"
                if grants
                else _history_grant_expr("f", uuid_sql)
            )
            + " IS NOT NULL"
        )
    for event in (
        "location_access_request",
        "location_access_approved",
        "location_access_denied",
        "location_access_request_withdrawn",
    ):
        identity = f"COALESCE({uuid_sql("split_part(f.source_row_id,':',1)")},{uuid_sql("f.metadata->>'recorded_request_id'")},{uuid_sql("f.metadata->>'request_id'")}) IS NOT NULL"
        # A source event can supply the verified request while its raw source is an audit id.
        if has("one_location_access_requests"):
            identity = "(flr.id IS NOT NULL OR " + identity + ")"
        required[event] = "(" + required.get(event, "TRUE") + ") AND " + identity
    circle_id = uuid_sql("f.metadata->>'circle_id'")
    required["circle_member_added"] = (
        # Closed source/schema fragments only; values remain in execute_raw parameters.
        f"{circle_id} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM feed_events ended WHERE ended.user_id=f.user_id AND ended.source_domain='location' AND ended.event_type='circle_deleted' AND COALESCE({uuid_sql("ended.metadata->>'circle_id'")},{uuid_sql("split_part(ended.source_row_id,':',1)")})={circle_id} AND (ended.created_at,ended.id)>(f.created_at,f.id))"  # nosec B608 -- authored SQL fragments; all request values use bind parameters.
    )
    if has("feed_event_counterparts"):
        required["circle_member_added"] += (
            " AND NOT EXISTS (SELECT 1 FROM feed_event_counterparts self_add WHERE self_add.feed_event_id=f.id AND self_add.counterpart_user_id=f.user_id)"
        )
    return joins, patches, required


def _history_grant_expr(alias, uuid_sql):
    return f"COALESCE({uuid_sql(f'{alias}.source_row_id')}::text,{uuid_sql(f"{alias}.metadata->>'recorded_grant_id'")}::text,{uuid_sql(f"{alias}.metadata->>'grant_id'")}::text,{uuid_sql(f"split_part({alias}.source_row_id,':',1)")}::text)"
