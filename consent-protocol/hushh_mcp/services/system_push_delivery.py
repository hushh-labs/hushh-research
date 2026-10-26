"""Source-bound system alerts for SMS, Location and relationship transitions.

Postgres is the delivery authority. NOTIFY is only a latency aid; leased rows
survive restarts and successful installations are never retried for a peer's
failure. Provider acceptance does not establish receipt, sound or a read.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.push_tokens_service import (
    LEGACY_REGISTRY_OWNER_FILTER,
    PUSH_TOKEN_REGISTRY_SQL,
    remove_stale_push_token,
)
from hushh_mcp.services.system_push_payloads import actor_label, todo_reminder_notification

logger = logging.getLogger(__name__)
_wakeup: asyncio.Event | None = None

_SOURCE_TYPES = {
    "location_share_created": ("share", "grant_id"),
    "location_access_request": ("location_request", "request_id"),
    "location_circle_member_added": ("circle_member", "circle_id"),
    "location_sms_contact_added": ("circle_member", "circle_id"),
    "connection_request": ("connection_request", "request_id"),
}
SYSTEM_PUSH_NOTIFICATION_TYPES = frozenset(_SOURCE_TYPES)


def durable_push_event_id(user_id: str, notification_type: str, data: dict) -> str | None:
    source = _SOURCE_TYPES.get(notification_type)
    if not source or not data.get(source[1]):
        return None
    try:
        source_id = str(uuid.UUID(str(data[source[1]])))
    except ValueError:
        return None
    with get_db().engine.begin() as conn:
        event_id = conn.execute(
            text("""SELECT id FROM system_push_outbox
            WHERE source_kind=:kind AND source_id=CAST(:source AS UUID)
              AND recipient_user_id=:user ORDER BY created_at DESC LIMIT 1"""),
            {"kind": source[0], "source": source_id, "user": user_id},
        ).scalar()
    return str(event_id) if event_id else None


def durable_push_receipt(user_id: str, notification_type: str, data: dict) -> int | None:
    """Use the source-transaction intent instead of a second best-effort send.

    None preserves legacy callers without a canonical source reference. Zero
    means an intent exists but no installation is currently reachable; it is
    still retried after registration. This is never a device receipt.
    """
    source = _SOURCE_TYPES.get(notification_type)
    if not source:
        return None
    if notification_type == "location_sms_contact_added" and data.get("owner_user_id"):
        with get_db().engine.begin() as conn:
            source_id = conn.execute(
                text("""SELECT id FROM one_location_circles WHERE
                owner_user_id=:owner AND system_kind='sms' AND status='active' LIMIT 1"""),
                {"owner": data["owner_user_id"]},
            ).scalar()
        if source_id:
            data = {**data, "circle_id": str(source_id)}
    if not data.get(source[1]):
        return None
    try:
        source_id = str(uuid.UUID(str(data[source[1]])))
    except ValueError:
        return None
    with get_db().engine.begin() as conn:
        status = conn.execute(
            text("""SELECT status FROM system_push_outbox
            WHERE source_kind=:kind AND source_id=CAST(:source AS UUID)
              AND recipient_user_id=:user ORDER BY created_at DESC LIMIT 1"""),
            {"kind": source[0], "source": source_id, "user": user_id},
        ).scalar()
        if status is None:
            return None
        if status in {"failed", "suppressed"}:
            return 0
        count = conn.execute(
            # Only the fixed registry query is composed; identity is bound.
            text(f"SELECT count(*) FROM ({PUSH_TOKEN_REGISTRY_SQL}) p WHERE user_id=:user"),  # nosec B608
            {"user": user_id},
        ).scalar()
    return int(count or 0)


def _source(conn, event: dict) -> dict | None:
    """Recheck live authority, including the exact request/membership epoch."""
    kind = event["source_kind"]
    params = {
        "source": event["source_id"],
        "user": event["recipient_user_id"],
        "revision": event["source_revision"],
    }
    if kind == "share":
        sql = """SELECT s.* FROM one_location_share_grants s WHERE id=:source
            AND recipient_user_id=:user AND status='active'
            AND (expires_at IS NULL OR expires_at>now())
            AND (COALESCE(NULLIF(BTRIM(metadata->>'share_kind'),''),CASE WHEN metadata->>'reason'='sos_panic' THEN 'sos' ELSE 'share' END)<>'sos'
              OR (latest_envelope_id IS NOT NULL AND EXISTS (SELECT 1 FROM one_location_recipient_keys k
                WHERE k.user_id=s.recipient_user_id AND k.key_id=s.recipient_key_id AND k.status='active')))
            FOR SHARE OF s"""
    elif kind == "todo_reminder":
        sql = """SELECT s.* FROM one_todo_reminder_schedules s WHERE id=:source
            AND user_id=:user AND generation::TEXT=:revision AND due_at<=now()
            AND due_at>now()-interval '15 minutes' FOR SHARE OF s"""
    elif kind == "location_request":
        sql = """SELECT s.* FROM one_location_access_requests s WHERE id=:source
            AND owner_user_id=:user AND status='pending'
            AND COALESCE(metadata->>'notify_owner','true') <> 'false'
            AND COALESCE(request_revision,1)::TEXT=:revision
            AND (expires_at IS NULL OR expires_at>now()) FOR SHARE OF s"""
    elif kind == "connection_request":
        sql = """SELECT s.* FROM connection_requests s WHERE id=:source
            AND addressee_user_id=:user AND status='pending' FOR SHARE OF s"""
    elif kind == "circle_member":
        sql = """SELECT s.*,c.name AS circle_name,c.owner_user_id,c.system_kind
            FROM one_location_circle_memberships s JOIN one_location_circles c ON c.id=s.circle_id
            WHERE s.circle_id=:source AND s.user_id=:user AND s.status='active'
              AND s.role='member' AND EXTRACT(EPOCH FROM s.joined_at)::TEXT=:revision AND c.status='active'
              AND c.system_kind IS DISTINCT FROM 'trusted' FOR SHARE OF s,c"""
    else:
        return None
    result = conn.execute(text(sql), params).mappings().first()
    return dict(result) if result else None


def _notification(conn, event: dict, source: dict) -> dict:
    if event["source_kind"] == "todo_reminder":
        return dict(todo_reminder_notification(event, source))
    from hushh_mcp.services.one_location_agent_service import (
        OneLocationAgentService,
        _access_ask_summary,
        _remaining_label,
    )

    user = event["recipient_user_id"]
    kind = event["source_kind"]
    counterpart = source.get("requester_user_id") or source.get("owner_user_id")
    if kind == "circle_member" and source.get("system_kind") != "sms":
        counterpart = (source.get("metadata") or {}).get("addedBy")
    label = actor_label(conn, counterpart)
    data = {"message_id": str(event["id"]), "user_id": user}
    if kind == "share":
        service = OneLocationAgentService()
        grant = service._grant_payload(source)
        if grant is None:
            raise ValueError("Share source cannot be represented")
        payload = service._location_share_created_notification(
            grant=grant,
            owner_user_id=source["owner_user_id"],
            recipient_user_id=user,
            duration=grant["durationHours"],
            reason=(source.get("metadata") or {}).get("reason"),
            resolved_kind=grant["shareKind"],
        )
        payload["data"] = {**payload["data"], **data}
        return payload
    if kind == "location_request":
        if source.get("extends_grant_id"):
            expiry = conn.execute(
                text("""SELECT expires_at FROM one_location_share_grants
                    WHERE id=:id AND owner_user_id=:owner AND recipient_user_id=:requester
                      AND status='active'"""),
                {
                    "id": source["extends_grant_id"],
                    "owner": user,
                    "requester": source["requester_user_id"],
                },
            ).scalar()
            source = {**source, "extends_grant_expires_at": expiry}
        request = OneLocationAgentService._request_payload(source)
        if request is None:
            raise ValueError("Location request source cannot be represented")
        data.update(
            {
                key: str(value)
                for key, value in {
                    "requested_duration_hours": request.get("requestedDurationHours"),
                    "requested_duration_mode": request.get("requestedDurationMode"),
                    "notification_revision": request.get("requestRevision"),
                    "extends_grant_id": request.get("extendsGrantId"),
                    "extends_grant_expires_at": request.get("extendsGrantExpiresAt"),
                    "referred_by_user_id": request.get("referredByUserId"),
                    "is_extension": "true" if request.get("isExtension") else None,
                }.items()
                if value is not None
            }
        )
        data.update(request_id=str(source["id"]), requester_display_label=label)
        title = (
            "More location time requested" if request["isExtension"] else "Location access request"
        )
        summary = _access_ask_summary(
            requested_duration_hours=request["requestedDurationHours"],
            requested_duration_mode=request["requestedDurationMode"],
            is_extension=request["isExtension"],
            remaining_label=_remaining_label(source.get("extends_grant_expires_at")),
        )
        body = f"{label} {summary}"
        notification_type = "location_access_request"
        link = f"/one/location?section=approvals&requestId={source['id']}"
        tag = f"one-location-request:{source['id']}"
    elif kind == "connection_request":
        from hushh_mcp.branding import connection_request_body

        data.update(request_id=str(source["id"]), requester_label=label)
        title, body = "New connection request", connection_request_body(label)
        notification_type = "connection_request"
        link = f"/one/consent?tab=pending&requestId={source['id']}"
        tag = f"connection-request:{source['id']}"
    else:
        sms = source.get("system_kind") == "sms"
        notification_type = "location_sms_contact_added" if sms else "location_circle_member_added"
        data.update(
            circle_id=str(source["circle_id"]),
            circle_name=source["circle_name"],
            owner_display_label=label,
            added_by_label=label,
        )
        title = "Added to an SMS Circle" if sms else "Added to a Circle"
        body = (
            f"{label} will send you their SMS alert."
            if sms
            else (
                f"{label} added you to {source['circle_name']}."
                if counterpart
                else f"You joined {source['circle_name']}."
            )
        )
        link = f"/one/location?view=people&action=circle-detail&circleId={source['circle_id']}"
        tag = f"location-circle-member-added:{source['circle_id']}:{user}"
    return dict(
        user_id=user,
        notification_type=notification_type,
        title=title,
        body=body,
        request_url=link,
        notification_tag=tag,
        data=data,
        show_alert=True,
    )


def _deliver(db, event: dict) -> str:
    from api.consent_listener import publish_user_state_event_threadsafe
    from api.utils.fcm_messages import build_push_message
    from api.utils.firebase_admin import ensure_firebase_admin
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )

    user = event["recipient_user_id"]
    with db.engine.begin() as conn:
        source = _source(conn, event)
        if not source:
            return "suppressed"
        payload = _notification(conn, event, source)
        ids = (
            conn.execute(
                # Only the fixed registry query is composed; identity is bound.
                text(f"SELECT id,source FROM ({PUSH_TOKEN_REGISTRY_SQL}) p WHERE user_id=:user"),  # nosec B608
                {"user": user},
            )
            .mappings()
            .all()
        )
    data = {
        **{k: str(v) for k, v in payload["data"].items() if v is not None},
        "type": payload["notification_type"],
        "user_id": user,
        "message_id": str(event["id"]),
        "request_url": payload["request_url"],
        "notification_tag": payload["notification_tag"],
        "notification_presentation": "alert",
    }
    # An authenticated live SMS popup must not depend on token registration or
    # Firebase health. The stable id deduplicates this companion with FCM.
    publish_user_state_event_threadsafe(
        user, {**data, "title": payload["title"], "body": payload["body"]}
    )
    if not ids or not ensure_firebase_admin()[0]:
        return "pending"
    from firebase_admin import messaging

    complete = True
    for registration in ids:
        modern = registration["source"] == "installation"
        table = "user_push_installations" if modern else "user_push_tokens"
        predicate = "" if modern else f"AND {LEGACY_REGISTRY_OWNER_FILTER}"
        stale = None
        with db.engine.begin() as conn:
            # Match the registry's established account-deletion/transfer fence.
            owners = sorted(
                {user, str(source.get("owner_user_id") or source.get("requester_user_id") or user)}
            )
            AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=owners)
            if conn.execute(
                text("SELECT 1 FROM account_deletion_tombstones WHERE user_id_hash=ANY(:hashes)"),
                {
                    "hashes": [
                        "sha256:" + hashlib.sha256(owner.encode()).hexdigest() for owner in owners
                    ]
                },
            ).scalar():
                return "suppressed"
            current = conn.execute(
                text("""UPDATE system_push_outbox SET due_at=now()+interval '60 seconds'
                WHERE id=:id AND lease_id=:lease AND status='leased' AND expires_at>now() RETURNING id"""),
                {"id": event["id"], "lease": event["lease_id"]},
            ).scalar()
            if not current:
                return "suppressed"
            row = (
                conn.execute(
                    text(
                        # Two fixed internal variants; identity remains bound.
                        f"SELECT l.* FROM {table} l WHERE id=:id AND user_id=:user {predicate} FOR UPDATE OF l"  # nosec B608
                    ),
                    {"id": registration["id"], "user": user},
                )
                .mappings()
                .first()
            )
            if not row:
                continue
            params = {"event": event["id"], "device": row["device_id"]}
            if conn.execute(
                text(
                    "SELECT 1 FROM system_push_device_deliveries WHERE event_id=:event AND device_id=:device"
                ),
                params,
            ).scalar():
                continue
            if not _source(conn, event):
                return "suppressed"
            message = build_push_message(
                messaging,
                token=row["token"],
                platform=row["platform"],
                data=data,
                title=payload["title"],
                body=payload["body"],
                request_url=payload["request_url"],
                notification_tag=payload["notification_tag"],
                show_alert=True,
            )
            try:
                messaging.send(message)
                conn.execute(
                    text(
                        "INSERT INTO system_push_device_deliveries(event_id,device_id) VALUES(:event,:device) ON CONFLICT DO NOTHING"
                    ),
                    params,
                )
            except (messaging.UnregisteredError, messaging.SenderIdMismatchError):
                stale = row["token"]
            except Exception as exc:
                complete = False
                logger.warning(
                    "system_push.device_failed kind=%s platform=%s error_type=%s",
                    event["source_kind"],
                    row["platform"],
                    type(exc).__name__,
                )
        if stale:
            remove_stale_push_token(db, user, stale)
    with db.engine.begin() as conn:
        accepted = conn.execute(
            text("SELECT 1 FROM system_push_device_deliveries WHERE event_id=:id LIMIT 1"),
            {"id": event["id"]},
        ).scalar()
    return "sent" if complete and accepted else "pending"


def dispatch_system_pushes(db=None) -> int:
    db = db or get_db()
    processed = 0
    with db.engine.begin() as conn:
        conn.execute(
            text("DELETE FROM system_push_outbox WHERE expires_at<now()-interval '3 days'")
        )
        conn.execute(
            text(
                "UPDATE system_push_outbox SET status='failed' WHERE status IN ('pending','leased') AND (expires_at<=now() OR attempts>=12) AND due_at<=now()"
            )
        )
    for _ in range(20):
        with db.engine.begin() as conn:
            event = (
                conn.execute(
                    text("""WITH due AS (SELECT id FROM system_push_outbox
                WHERE status IN ('pending','leased') AND due_at<=now() AND expires_at>now() AND attempts<12
                ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED)
                UPDATE system_push_outbox o SET status='leased',attempts=attempts+1,
                  lease_id=gen_random_uuid(),due_at=now()+interval '60 seconds'
                FROM due WHERE o.id=due.id RETURNING o.*""")
                )
                .mappings()
                .first()
            )
        if not event:
            break
        processed += 1
        event = dict(event)
        try:
            status = _deliver(db, event)
        except Exception as exc:
            status = "pending"
            logger.warning(
                "system_push.dispatch_failed kind=%s error_type=%s",
                event["source_kind"],
                type(exc).__name__,
            )
        with db.engine.begin() as conn:
            conn.execute(
                text("""UPDATE system_push_outbox SET status=:status,
                due_at=now()+make_interval(secs=>LEAST(300,5*CAST(power(2,LEAST(attempts,6)) AS INTEGER)))
                WHERE id=:id AND lease_id=:lease AND status='leased'"""),
                {"status": status, "id": event["id"], "lease": event["lease_id"]},
            )
        logger.info(
            "system_push.attempt kind=%s outcome=%s attempt=%s",
            event["source_kind"],
            status,
            event["attempts"],
        )
    return processed


def wake_system_push_worker() -> None:
    if _wakeup is not None:
        _wakeup.set()


async def run_system_push_worker() -> None:
    global _wakeup
    _wakeup = asyncio.Event()
    while True:
        try:
            count = await asyncio.to_thread(dispatch_system_pushes)
            if count == 20:
                continue
        except Exception as exc:
            logger.warning("system_push.sweep_failed error_type=%s", type(exc).__name__)
        try:
            await asyncio.wait_for(_wakeup.wait(), timeout=5)
        except TimeoutError:
            pass
        _wakeup.clear()
