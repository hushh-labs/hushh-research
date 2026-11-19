"""Receipt port called inside the existing atomic grant/envelope transaction."""

from typing import Any

from sqlalchemy import text


def record_check_in_receipt(conn: Any, params: dict[str, Any], row: Any) -> None:
    if not row or params.get("_command_share_kind") != "check_in":
        return
    if not conn.execute(text("SELECT to_regclass('one_location_check_in_operations')")).scalar():
        return  # Old native publishers keep their per-recipient receipt contract.
    plan = (
        conn.execute(
            text("""SELECT id,duration_hours,source_circle_id FROM one_location_check_in_operations
      WHERE owner_user_id=:owner AND client_operation_id=:client FOR UPDATE"""),
            {"owner": params["owner_user_id"], "client": params["_client_operation_id"]},
        )
        .mappings()
        .first()
    )
    if not plan:
        return
    if float(plan["duration_hours"]) != float(params["duration_hours"]) or str(
        plan["source_circle_id"] or ""
    ) != str(params.get("_command_source_circle") or ""):
        raise ValueError("The reviewed Check-In terms changed")
    saved = conn.execute(
        text("""UPDATE one_location_check_in_targets target
      SET confirmed_grant_id=g.id,confirmed_envelope_id=e.id,
          confirmed_at=COALESCE(target.confirmed_at,clock_timestamp())
      FROM one_location_share_grants g JOIN one_location_envelopes e
        ON e.id=CAST(:envelope_id AS UUID) AND e.grant_id=g.id
        AND e.owner_user_id=g.owner_user_id AND e.recipient_user_id=g.recipient_user_id
      WHERE target.operation_id=:operation AND target.recipient_user_id=:recipient
        AND g.id=CAST(:grant_id AS UUID) AND g.owner_user_id=:owner
        AND g.recipient_user_id=:recipient AND g.metadata->>'share_kind'='check_in'
        AND g.metadata->>'client_operation_id'=:client
        AND (target.confirmed_grant_id IS NULL OR target.confirmed_grant_id=g.id)
      RETURNING target.confirmed_grant_id"""),
        {
            "operation": plan["id"],
            "recipient": params["recipient_user_id"],
            "owner": params["owner_user_id"],
            "client": params["_client_operation_id"],
            "grant_id": params["grant_id"],
            "envelope_id": params["envelope_id"],
        },
    ).first()
    if not saved:
        raise ValueError("The reviewed Check-In audience changed")

    # Publish partial/full outcomes with the receipt, even if the client leaves
    # before its final callback. A replay with identical receipts adds no event.
    from hushh_mcp.services.location_check_in_operations import settle_in_connection

    settle_in_connection(
        conn, owner=params["owner_user_id"], operation=str(plan["id"]), final=False
    )
