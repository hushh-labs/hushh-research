"""Transaction-owned SMS call reservation and cancellation."""

from __future__ import annotations

import os
from datetime import datetime
from math import ceil
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.direct_call_lifecycle import clear_call
from hushh_mcp.services.direct_call_policy import CallError


def enabled() -> bool:
    return os.getenv("ONE_LOCATION_SMS_CALL_ESCALATION_ENABLED") == "1"


def reserve(conn, *, owner: str, incident: str, device: str, peer: str) -> dict | None:
    """Bind the selected Circle grant and return the earliest allowed call time."""
    call_id = str(uuid4())
    row = (
        conn.execute(
            text("""
            UPDATE one_location_share_grants g
            SET metadata = g.metadata || jsonb_build_object(
                'sms_call_id', CAST(:call AS TEXT), 'sms_call_device', CAST(:device AS TEXT),
                'sms_call_queued_at', clock_timestamp()
            )
            WHERE g.owner_user_id=:owner AND g.recipient_user_id=:peer
              AND g.metadata->>'sms_incident_id'=:incident AND g.status='active'
              AND EXISTS (
                SELECT 1 FROM direct_communication_keys k
                JOIN trusted_devices d ON d.user_id=k.user_id AND d.device_id=k.device_id
                WHERE k.user_id=:owner AND k.device_id=:device AND d.status='active'
              )
              AND EXISTS (
                SELECT 1 FROM direct_communication_keys k
                JOIN trusted_devices d ON d.user_id=k.user_id AND d.device_id=k.device_id
                WHERE k.user_id=:peer AND d.status='active'
              )
              AND EXISTS (
                SELECT 1 FROM connections
                WHERE user_a_id=LEAST(:owner,:peer) AND user_b_id=GREATEST(:owner,:peer)
                  AND status='active'
              )
              AND NOT EXISTS (
                SELECT 1 FROM direct_message_blocks b
                WHERE (b.blocker_user_id=:owner AND b.blocked_user_id=:peer)
                   OR (b.blocker_user_id=:peer AND b.blocked_user_id=:owner)
              )
            RETURNING metadata
        """),
            {"owner": owner, "incident": incident, "device": device, "peer": peer, "call": call_id},
        )
        .mappings()
        .first()
    )
    return public_reservation(conn, row["metadata"]) if row else None


def public_reservation(conn, metadata: dict) -> dict | None:
    if not metadata.get("sms_call_id") or metadata.get("sms_call_cancelled"):
        return None
    queued_at = datetime.fromisoformat(metadata["sms_call_queued_at"])
    database_now = conn.execute(text("SELECT clock_timestamp()")).scalar_one()
    elapsed = (database_now - queued_at).total_seconds()
    if elapsed >= 30:
        return None
    return {
        "callId": metadata["sms_call_id"],
        "delayMs": max(0, min(10000, ceil((10 - elapsed) * 1000))),
    }


def selected_peer(conn, *, owner: str, incident: str, call_id: str) -> str:
    peer = conn.execute(
        text("""
            SELECT recipient_user_id FROM one_location_share_grants
            WHERE owner_user_id=:owner AND metadata->>'sms_incident_id'=:incident
              AND metadata->>'sms_call_id'=:call
        """),
        {"owner": owner, "incident": incident, "call": call_id},
    ).scalar()
    if peer is None:
        raise CallError("SMS_CALL_UNAVAILABLE", "The SMS call is unavailable.", 404)
    return str(peer)


def reserved_call_id(conn, *, owner: str, call_id: str) -> bool:
    return (
        conn.execute(
            text("""
            SELECT 1 FROM one_location_share_grants
            WHERE owner_user_id=:owner AND metadata->>'sms_call_id'=:call
            LIMIT 1
        """),
            {"owner": owner, "call": call_id},
        ).scalar()
        is not None
    )


def contact_is_current(conn, *, owner: str, peer: str) -> bool:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService()._is_sms_contact(
        owner_user_id=owner, contact_user_id=peer, connection=conn
    )


def require_pending(
    conn, *, owner: str, peer: str, device: str, incident: str, call_id: str, preparing: bool
) -> None:
    """Check after the caller has acquired the canonical graph locks."""
    if not enabled():
        raise CallError("SMS_CALL_UNAVAILABLE", "The SMS call is unavailable.", 503)
    state = conn.execute(
        text("""
            SELECT CASE WHEN (g.metadata ? 'sms_call_cancelled') OR EXISTS (
                SELECT 1 FROM one_location_share_grants other
                WHERE other.owner_user_id=g.owner_user_id
                  AND other.metadata->>'sms_incident_id'=:incident
                  AND other.sms_acknowledged_at IS NOT NULL
            ) THEN 'settled'
            WHEN g.status='active' AND g.expires_at>clock_timestamp()
              AND clock_timestamp() >= CAST(g.metadata->>'sms_call_queued_at' AS TIMESTAMPTZ)
                  + interval '10 seconds'
              AND clock_timestamp() < CAST(g.metadata->>'sms_call_queued_at' AS TIMESTAMPTZ)
                  + make_interval(secs=>:window)
            THEN 'ready' ELSE 'unavailable' END
            FROM one_location_share_grants g
            WHERE g.owner_user_id=:owner AND g.recipient_user_id=:peer
              AND g.metadata->>'sms_incident_id'=:incident AND g.metadata->>'sms_call_id'=:call
              AND g.metadata->>'sms_call_device'=:device
        """),
        {
            "owner": owner,
            "peer": peer,
            "device": device,
            "incident": incident,
            "call": call_id,
            "window": 30 if preparing else 60,
        },
    ).scalar()
    if state == "settled":
        raise CallError("SMS_CALL_SETTLED", "The SMS call is no longer needed.", 409)
    if state != "ready" or not contact_is_current(conn, owner=owner, peer=peer):
        raise CallError("SMS_CALL_UNAVAILABLE", "The SMS call is unavailable.", 409)


def lock_for_grant(conn, *, actor: str, grant_id: str, acknowledgement: bool) -> dict | None:
    """Lock before any grant or call row changes, in the order used by calling."""
    row = (
        conn.execute(
            text("""
            SELECT g.owner_user_id AS owner, g.recipient_user_id AS recipient,
                   target.recipient_user_id AS peer, target.id AS target,
                   target.metadata->>'sms_call_id' AS call_id
            FROM one_location_share_grants g
            JOIN one_location_share_grants target
              ON target.owner_user_id=g.owner_user_id
             AND target.metadata->>'sms_incident_id'=g.metadata->>'sms_incident_id'
             AND target.metadata ? 'sms_call_id'
            WHERE g.id=CAST(:grant AS UUID)
              AND (g.recipient_user_id=:actor OR (NOT :ack AND g.owner_user_id=:actor))
        """),
            {"actor": actor, "grant": grant_id, "ack": acknowledgement},
        )
        .mappings()
        .first()
    )
    if not row:
        return None
    lock_connection_graph_users(conn, user_ids=[row["owner"], row["recipient"], row["peer"]])
    return dict(row)


def cancel_unanswered(conn, reservation: dict) -> None:
    conn.execute(
        text("""
            UPDATE one_location_share_grants
            SET metadata=metadata || jsonb_build_object('sms_call_cancelled', TRUE)
            WHERE id=:target AND metadata->>'sms_call_id'=:call_id
        """),
        reservation,
    )
    call_id = conn.execute(
        text("""
            UPDATE direct_calls SET state='cancelled',revision=revision+1,
                expires_at=LEAST(expires_at,clock_timestamp())
            WHERE id=CAST(:call_id AS UUID) AND caller_user_id=:owner AND callee_user_id=:peer
              AND sms_incident_id IS NOT NULL AND state IN ('preparing','ringing')
            RETURNING id
        """),
        reservation,
    ).scalar()
    if call_id:
        clear_call(conn, str(call_id))
