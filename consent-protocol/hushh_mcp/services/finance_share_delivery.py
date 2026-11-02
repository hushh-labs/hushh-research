"""Transactional delivery and replacement of recipient-encrypted Finance approvals."""

import hashlib
import json
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.direct_messages_service import DirectMessagesService


def create_finance_share(service, owner, body):
    from hushh_mcp.services.finance_sharing_service import FinanceSharingError, one, request_grants

    payload = body.model_dump(mode="json")
    fingerprint = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    request_id = str(body.requestId)
    with service.db.engine.begin() as conn:
        service._ready(conn)
        conn.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),
            {"key": "finance-share:" + owner + ":" + request_id},
        )
        previous = one(
            conn,
            "SELECT fingerprint FROM finance_share_requests WHERE owner_user_id=:owner AND id=CAST(:id AS uuid)",
            {"owner": owner, "id": request_id},
        )
        if previous:
            if previous["fingerprint"] != fingerprint:
                raise FinanceSharingError("FINANCE_SHARE_RETRY_CONFLICT", 409)
            return request_grants(conn, service._SELECT, owner, request_id)
        recipients, dm = _validate_recipients(service, conn, owner, body)
        conn.execute(
            text("""INSERT INTO finance_share_requests(owner_user_id,id,fingerprint,policy,owner_config,expires_at)
          VALUES(:owner,CAST(:id AS uuid),:fingerprint,CAST(:policy AS jsonb),CAST(:config AS jsonb),
            CASE WHEN :duration IS NULL THEN NULL ELSE clock_timestamp()+make_interval(secs=>:duration) END)"""),
            {
                "owner": owner,
                "id": request_id,
                "fingerprint": fingerprint,
                "policy": json.dumps(payload["policy"]),
                "config": json.dumps(payload["ownerConfig"]),
                "duration": body.policy.durationSeconds,
            },
        )
        for uid, item in recipients:
            _deliver_grant(conn, dm, owner, request_id, uid, item)
        # The connection graph locks serialize replacement with creation,
        # refresh and revoke. Delivery and retirement commit together;
        # a rejected replacement leaves the previous approval intact.
        _retire_previous_access(conn, owner, request_id, recipients)
        return request_grants(conn, service._SELECT, owner, request_id)


def _validate_recipients(service, conn, owner, body):
    from hushh_mcp.services.finance_sharing_service import FinanceSharingError, one, require_advisor

    recipients = []
    for item in body.recipients:
        person = one(
            conn,
            "SELECT user_id FROM actor_profiles WHERE public_person_ref=CAST(:ref AS uuid)",
            {"ref": str(item.personRef)},
        )
        if not person or person["user_id"] == owner:
            raise FinanceSharingError("FINANCE_SHARE_RECIPIENT_INVALID")
        recipients.append((person["user_id"], item))
    lock_connection_graph_users(conn, user_ids=sorted([owner, *[r[0] for r in recipients]]))
    if body.policy.version in (2, 3):
        for uid in sorted(r[0] for r in recipients):
            require_advisor(conn, uid)
    service._key(conn, owner, body.ownerConfig.recipientKeyId)
    dm = DirectMessagesService(db=service.db, connection=conn, defer_notifications=True)
    for uid, item in recipients:
        dm.require_active_connection(owner, uid)
        service._key(conn, uid, item.envelope.recipientKeyId)
        service._key(conn, owner, item.ownerEnvelope.recipientKeyId)
    return recipients, dm


def _deliver_grant(conn, dm, owner, request_id, uid, item):
    message_id = str(uuid4())
    dm.send_message(
        owner,
        recipient_user_id=uid,
        content=f"[finance-share:{item.grantId}]",
        client_message_id=message_id,
    )
    conn.execute(
        text("""INSERT INTO finance_access_grants(id,owner_user_id,recipient_user_id,request_id,
        recipient_key_id,envelope,owner_envelope,content_hash,message_id)
      VALUES(CAST(:grant AS uuid),:owner,:recipient,CAST(:request AS uuid),:key,
        CAST(:envelope AS jsonb),CAST(:owner_envelope AS jsonb),:hash,CAST(:message AS uuid))"""),
        {
            "grant": str(item.grantId),
            "owner": owner,
            "recipient": uid,
            "request": request_id,
            "key": item.envelope.recipientKeyId,
            "envelope": item.envelope.model_dump_json(),
            "owner_envelope": item.ownerEnvelope.model_dump_json(),
            "hash": item.contentHash,
            "message": message_id,
        },
    )


def _retire_previous_access(conn, owner, request_id, recipients):
    for uid, _item in recipients:
        conn.execute(
            text("""UPDATE finance_access_grants g SET
              revoked_at=clock_timestamp(),envelope=NULL,owner_envelope=NULL
              WHERE g.owner_user_id=:owner AND g.recipient_user_id=:recipient
                AND g.request_id<>CAST(:request AS uuid) AND g.revoked_at IS NULL
                AND EXISTS(SELECT 1 FROM finance_share_requests r
                  WHERE r.owner_user_id=g.owner_user_id AND r.id=g.request_id
                    AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp()))"""),
            {"owner": owner, "recipient": uid, "request": request_id},
        )
