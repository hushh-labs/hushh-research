"""Owner-only requested/transfer history, without inferred viewing or location."""

import base64
import hmac
import json
from datetime import datetime
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.document_delivery.background_access import participant
from hushh_mcp.services.document_delivery.contracts import DeliveryError


def _cursor(store, request_id, actor, at, event):
    value = [at.isoformat(), str(event)]
    value.append(
        store.sharing_cipher.digest("background-activity-cursor-v2", [request_id, actor, value])
    )
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode()


def _after(store, request_id, actor, cursor):
    if cursor is None:
        return None, None
    try:
        value = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        if not isinstance(value, list) or len(value) != 3:
            raise ValueError
        stamp, event, signature = value
        expected = store.sharing_cipher.digest(
            "background-activity-cursor-v2", [request_id, actor, [stamp, event]]
        )
        at = datetime.fromisoformat(stamp)
        if (
            at.tzinfo is None
            or not hmac.compare_digest(signature, expected)
            or str(UUID(event)) != event
        ):
            raise ValueError
        return at, event
    except (ValueError, TypeError, KeyError):
        raise DeliveryError("invalid_cursor", 422) from None


async def history(service, *, request_id, actor, cursor=None, limit=25):
    if type(limit) is not int or not 1 <= limit <= 50:
        raise DeliveryError("invalid_argument", 422)
    store = service.store
    at, event = _after(store, request_id, actor, cursor)

    def operation(connection):
        request = participant(store, connection, request_id, actor)
        if actor != request["user_id"]:
            raise DeliveryError("owner_required", 403)
        store._participant_gate(connection, actor, request_id)
        store._sharing_admission(actor)
        store._relationship(connection, request["user_id"], request["recipient_user_id"])
        rows = (
            connection.execute(
                text("""SELECT * FROM document_delivery_background_activity
          WHERE request_id=:request AND (CAST(:at AS timestamptz) IS NULL OR
            (created_at,event_id)<(CAST(:at AS timestamptz),CAST(:event AS uuid)))
          ORDER BY created_at DESC,event_id DESC LIMIT :limit"""),
                {"request": request_id, "at": at, "event": event, "limit": limit + 1},
            )
            .mappings()
            .all()
        )
        items = [
            {
                "eventId": str(row["event_id"]),
                "fileRef": str(row["file_ref"]) if row["file_ref"] else None,
                "kind": row["kind"],
                "createdAt": row["created_at"].isoformat(),
                "country": None,
                "actorRole": "system"
                if row["kind"] == "copy_ready"
                else "owner"
                if row["actor_user_id"] == request["user_id"]
                else "recipient"
                if row["actor_user_id"] == request["recipient_user_id"]
                else "system",
            }
            for row in rows[:limit]
        ]
        return {
            "items": items,
            "nextCursor": _cursor(
                store, request_id, actor, rows[limit - 1]["created_at"], rows[limit - 1]["event_id"]
            )
            if len(rows) > limit
            else None,
        }

    return await store._transaction(operation)
