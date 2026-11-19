"""Owner-scoped explicit Check-In plans. Grants and ciphertext remain authoritative."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import text

from db.db_client import get_db_connection


class CheckInOperationError(ValueError):
    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


def _plan(conn: Any, owner: str, operation: str, *, lock: bool = False) -> dict[str, Any]:
    row = (
        conn.execute(
            text(
                "SELECT * FROM one_location_check_in_operations WHERE id=CAST(:id AS UUID) AND owner_user_id=:owner"
                + (" FOR UPDATE" if lock else "")
            ),
            {"id": operation, "owner": owner},
        )
        .mappings()
        .first()
    )
    if not row:
        raise CheckInOperationError("Check-In is no longer available", 404)
    return dict(row)


def _targets(conn: Any, operation: str) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in conn.execute(
            text("""SELECT t.target_id,t.recipient_user_id,t.confirmed_grant_id,
      t.confirmed_at,t.ended_at, CASE WHEN g.status='active' AND g.expires_at<=clock_timestamp() THEN 'expired' ELSE g.status END AS share_status,g.expires_at,
      a.display_name
      FROM one_location_check_in_targets t LEFT JOIN one_location_share_grants g ON g.id=t.confirmed_grant_id
      LEFT JOIN actor_identity_cache a ON a.user_id=t.recipient_user_id
      WHERE t.operation_id=CAST(:id AS UUID) ORDER BY t.recipient_user_id"""),
            {"id": operation},
        ).mappings()
    ]


def _target_label(row: dict[str, Any]) -> str:
    from hushh_mcp.services.requester_identity import label_from_identity_row

    if not row["recipient_user_id"]:
        return "Unavailable contact"
    return label_from_identity_row(
        {"user_id": row["recipient_user_id"], "display_name": row.get("display_name")},
        allow_email_handle=False,
        fallback="A contact",
    )


def _payload(plan: dict[str, Any], targets: list[dict[str, Any]]) -> dict[str, Any]:
    confirmed = sum(row["confirmed_grant_id"] is not None for row in targets)
    return {
        "id": str(plan["id"]),
        "clientOperationId": plan["client_operation_id"],
        "state": plan["state"],
        "durationHours": float(plan["duration_hours"]),
        "sourceCircleId": str(plan["source_circle_id"]) if plan["source_circle_id"] else None,
        "confirmedAt": plan["confirmed_at"],
        "createdAt": plan["created_at"],
        "intendedCount": len(targets),
        "confirmedCount": confirmed,
        "pendingCount": len(targets) - confirmed,
        "targets": [
            {
                "userId": row["recipient_user_id"] or "unavailable:" + str(row["target_id"]),
                "label": _target_label(row),
                "grantId": str(row["confirmed_grant_id"]) if row["confirmed_grant_id"] else None,
                "confirmedAt": row["confirmed_at"],
                "status": "unavailable"
                if row["recipient_user_id"] is None
                else row["share_status"] or ("ended" if row["confirmed_grant_id"] else "pending"),
            }
            for row in targets
        ],
    }


def _validate_audience(conn: Any, owner: str, recipients: list[str], circle: str | None) -> None:
    # Reuse Location's canonical connection/Circle boundary, inside this transaction.
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    service = OneLocationAgentService()
    service._key_writer_connection = conn
    try:
        for recipient in recipients:
            eligible, _ = service._resolve_location_peer_eligibility(
                owner_user_id=owner, other_user_id=recipient, source_circle_id=circle
            )
            if not eligible:
                raise CheckInOperationError("A selected person is no longer available", 403)
    finally:
        del service._key_writer_connection


def begin_check_in(
    *,
    owner: str,
    client_operation_id: str,
    recipient_ids: list[str],
    duration_hours: float,
    confirmed_at: datetime,
    source_circle_id: str | None = None,
) -> dict[str, Any]:
    recipients = sorted(set(recipient_ids))
    if not recipients or len(recipients) > 100 or owner in recipients:
        raise CheckInOperationError("Choose the Check-In recipients", 422)
    operation = str(
        uuid5(NAMESPACE_URL, "one.location.check-in:" + owner + ":" + client_operation_id)
    )
    with get_db_connection() as conn:
        conn.execute(
            text("""INSERT INTO one_location_check_in_operations(id,owner_user_id,client_operation_id,duration_hours,source_circle_id,confirmed_at)
          VALUES(:id,:owner,:client,:hours,CAST(:circle AS UUID),:at) ON CONFLICT DO NOTHING"""),
            {
                "id": operation,
                "owner": owner,
                "client": client_operation_id,
                "hours": duration_hours,
                "circle": source_circle_id,
                "at": confirmed_at,
            },
        )
        plan = _plan(conn, owner, operation, lock=True)
        existing = _targets(conn, operation)
        if float(plan["duration_hours"]) != duration_hours or str(
            plan["source_circle_id"] or ""
        ) != str(source_circle_id or ""):
            raise CheckInOperationError("The reviewed Check-In changed")
        if existing and not set(recipients).issubset(
            {row["recipient_user_id"] for row in existing}
        ):
            raise CheckInOperationError("The reviewed Check-In audience changed")
        if not existing:
            _validate_audience(conn, owner, recipients, source_circle_id)
            conn.execute(
                text("""INSERT INTO one_location_check_in_targets(operation_id,recipient_user_id)
              SELECT CAST(:id AS UUID),value FROM jsonb_array_elements_text(CAST(:recipients AS JSONB))"""),
                {"id": operation, "recipients": json.dumps(recipients)},
            )
        return _payload(plan, _targets(conn, operation))


def get_check_in(*, owner: str, operation: str) -> dict[str, Any]:
    with get_db_connection() as conn:
        plan = _plan(conn, owner, operation)
        last_step = plan["settled_at"] or plan["created_at"]
        if plan["state"] != "pending" or datetime.now(UTC) - last_step > timedelta(minutes=5):
            return settle_in_connection(conn, owner=owner, operation=operation)
        return _payload(plan, _targets(conn, operation))


def settle_check_in(*, owner: str, operation: str) -> dict[str, Any]:
    with get_db_connection() as conn:
        return settle_in_connection(conn, owner=owner, operation=operation)


def settle_in_connection(
    conn: Any, *, owner: str, operation: str, final: bool = True
) -> dict[str, Any]:
    plan = _plan(conn, owner, operation, lock=True)
    targets = _targets(conn, operation)
    confirmed = sum(row["confirmed_grant_id"] is not None for row in targets)
    state = (
        "completed"
        if confirmed == len(targets)
        else ("partial" if confirmed else "failed")
        if final
        else "pending"
        if confirmed != plan["confirmed_count"]
        else plan["state"]
    )
    if (
        confirmed == len(targets)
        and confirmed
        and all(
            row["confirmed_grant_id"] is None
            or row["ended_at"] is not None
            or row["share_status"] != "active"
            for row in targets
        )
    ):
        state = "ended"
    if state != plan["state"] or confirmed != plan["confirmed_count"]:
        plan = dict(
            conn.execute(
                text("""UPDATE one_location_check_in_operations SET state=:state,confirmed_count=:confirmed,
          settled_at=clock_timestamp(),revision=revision+1 WHERE id=:id RETURNING *"""),
                {"state": state, "confirmed": confirmed, "id": plan["id"]},
            )
            .mappings()
            .one()
        )
        if state != "pending":
            _publish_result(conn, plan, state, confirmed, len(targets), owner, operation)
    return _payload(plan, targets)


def _publish_result(conn, plan, state, confirmed, total, owner, operation):
    conn.execute(
        text("""INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id,metadata)
          VALUES(:owner,'location',:event,:source,CAST(:metadata AS JSONB)) ON CONFLICT DO NOTHING"""),
        {
            "owner": owner,
            "event": "location_check_in_attention"
            if state in {"partial", "failed"}
            else "location_check_in_result",
            "source": operation + ":revision:" + str(plan["revision"]),
            "metadata": json.dumps(
                {
                    "check_in_operation_id": operation,
                    "share_kind": "check_in",
                    "confirmed_count": confirmed,
                    "intended_count": total,
                    "pending_count": total - confirmed,
                    "user_facing_status": state,
                    "actor_is_self": True,
                }
            ),
        },
    )


def pending_check_ins(owner: str, execute) -> list[dict[str, Any]]:
    probe = execute("SELECT to_regclass('one_location_check_in_operations') AS available", {})
    if not probe or not probe[0].get("available"):
        return []
    reconcile_ended_check_ins(owner, execute)
    rows = execute(
        """SELECT o.*,count(t.*) AS intended,count(t.confirmed_grant_id) AS saved
      FROM one_location_check_in_operations o JOIN one_location_check_in_targets t ON t.operation_id=o.id
      WHERE o.owner_user_id=:owner AND (o.state IN('partial','failed') OR (o.state='pending' AND COALESCE(o.settled_at,o.created_at)<clock_timestamp()-INTERVAL '5 minutes')) AND EXISTS(SELECT 1 FROM one_location_check_in_targets remaining WHERE remaining.operation_id=o.id AND remaining.confirmed_grant_id IS NULL AND remaining.recipient_user_id IS NOT NULL)
      GROUP BY o.id ORDER BY o.settled_at DESC LIMIT 20""",
        {"owner": owner},
    )
    return [
        {
            "id": str(row["id"]),
            "confirmedCount": row["saved"],
            "intendedCount": row["intended"],
            "state": row["state"]
            if row["state"] != "pending"
            else "partial"
            if row["saved"]
            else "failed",
            "updatedAt": row["settled_at"],
        }
        for row in rows
    ]


def purge_check_in_operations(execute, *, owner: str | None, hours: float) -> int:
    probe = execute("SELECT to_regclass('one_location_check_in_operations') AS available", {})
    if not probe or not probe[0].get("available"):
        return 0
    rows = execute(
        """DELETE FROM one_location_check_in_operations operation
      WHERE NOT EXISTS(SELECT 1 FROM one_location_check_in_targets target JOIN one_location_share_grants grant_row
        ON grant_row.id=target.confirmed_grant_id WHERE target.operation_id=operation.id AND grant_row.status='active'
          AND (grant_row.expires_at IS NULL OR grant_row.expires_at>clock_timestamp()))
      AND COALESCE(settled_at,created_at)<clock_timestamp()-(:hours*INTERVAL '1 hour')
        AND (CAST(:owner AS TEXT) IS NULL OR owner_user_id=:owner) RETURNING id""",
        {"owner": owner, "hours": hours},
    )
    return len(rows)


def reconcile_ended_check_ins(owner: str, execute) -> None:
    # Grant end writes do not lock operations. Settle closed outcomes here in
    # a separate transaction, without taking any grant or target row lock.
    execute(
        """WITH ended AS (
      UPDATE one_location_check_in_operations operation SET state='ended',revision=revision+1,
        settled_at=clock_timestamp()
      WHERE owner_user_id=:owner AND state='completed' AND confirmed_count>0
        AND NOT EXISTS(SELECT 1 FROM one_location_check_in_targets target
          LEFT JOIN one_location_share_grants grant_row ON grant_row.id=target.confirmed_grant_id
          WHERE target.operation_id=operation.id AND (target.confirmed_grant_id IS NULL OR (
            target.ended_at IS NULL AND grant_row.status='active' AND
            (grant_row.expires_at IS NULL OR grant_row.expires_at>clock_timestamp()))))
      RETURNING *)
      INSERT INTO feed_events(user_id,source_domain,event_type,source_row_id,metadata)
      SELECT owner_user_id,'location','location_check_in_result',id::text||':'||'revision'||':'||revision,
        jsonb_build_object('check_in_operation_id',id::text,'share_kind','check_in',
          'confirmed_count',confirmed_count,'intended_count',confirmed_count,'pending_count',0,
          'user_facing_status','ended','actor_is_self',true) FROM ended
      ON CONFLICT DO NOTHING RETURNING id""",
        {"owner": owner},
    )
