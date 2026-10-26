"""Document delivery intake: operations over the owning store transaction port."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.document_delivery.contracts import (
    ACTIVITY_DISCLOSURE,
    DeliveryError,
    digest,
    key_fingerprint,
)


def _pin_recipient(self, connection, requester, body):
    key = self._row(
        connection,
        """SELECT * FROM one_kyc_client_connectors
      WHERE user_id=:user AND connector_key_id=:key AND status='active' FOR SHARE""",
        {"user": requester, "key": body["recipientKeyId"]},
    )
    if (
        key is None
        or key_fingerprint(key["connector_public_key"]) != body["recipientKeyFingerprint"]
    ):
        raise DeliveryError("recipient_key_changed")
    fingerprint = key_fingerprint(key["connector_public_key"])
    pinned = self._row(
        connection,
        """INSERT INTO document_delivery_public_keys(user_id,key_id,public_key,fingerprint)
      VALUES(:user,:key,:public,:fingerprint) ON CONFLICT(user_id,key_id) DO UPDATE
      SET key_id=EXCLUDED.key_id WHERE document_delivery_public_keys.public_key=EXCLUDED.public_key
      AND document_delivery_public_keys.fingerprint=EXCLUDED.fingerprint RETURNING key_id""",
        {
            "user": requester,
            "key": body["recipientKeyId"],
            "public": key["connector_public_key"],
            "fingerprint": fingerprint,
        },
    )
    if pinned is None:
        raise DeliveryError("recipient_key_id_reused")
    return fingerprint


def _insert_contract(
    self, connection, *, requester, owner, body, google_recipient, request_digest, fingerprint
):
    request_id = str(uuid4())
    recipient = {"kind": "one_user", "user_id": requester}
    if body["receiveThrough"] == "both":
        if google_recipient is None or google_recipient.user_id != requester:
            raise DeliveryError("verify_google_identity_required")
        recipient = {
            "kind": google_recipient.kind,
            "user_id": requester,
            "subject": google_recipient.subject,
            "email": google_recipient.email,
            "verified_at": google_recipient.verified_at.isoformat(),
        }
    private = {
        "purpose": body["purpose"],
        "reason": body["reason"],
        "recipient": recipient,
        "origin": "requester_profile",
        "trusted_auto": False,
        "document_delivery_version": 1,
        "owner_settlement_required": True,
    }
    envelope = self.sharing_cipher.seal(
        private, user_id=owner, resource_id=request_id, purpose="request"
    )
    # No legacy background preparation is enrolled by this facade.
    request = self._row(
        connection,
        """INSERT INTO drive_share_requests
      (request_id,user_id,recipient_user_id,client_request_id,request_envelope,recipient_binding,
       request_digest,payment_required,preparation_next_at)
      VALUES(:request,:owner,:recipient,:client,CAST(:envelope AS jsonb),:binding,:digest,true,
        clock_timestamp()+INTERVAL '31 days') RETURNING *""",
        {
            "request": request_id,
            "owner": owner,
            "recipient": requester,
            "client": body["clientRequestId"],
            "envelope": json.dumps(envelope),
            "binding": digest(recipient),
            "digest": request_digest,
            "days": body["accessDays"],
        },
    )
    limit = min(request["expires_at"], datetime.now(UTC) + timedelta(days=body["accessDays"]))
    contract = self._row(
        connection,
        """INSERT INTO document_delivery_contracts
      (request_id,owner_user_id,recipient_user_id,receive_through,activity_disclosure_version,
       recipient_key_id,recipient_key_fingerprint,access_expires_at)
      VALUES(:request,:owner,:recipient,:mode,:activity,:key,:fingerprint,:expires) RETURNING *""",
        {
            "request": request_id,
            "owner": owner,
            "recipient": requester,
            "mode": body["receiveThrough"],
            "activity": ACTIVITY_DISCLOSURE,
            "key": body["recipientKeyId"],
            "fingerprint": fingerprint,
            "expires": limit,
        },
    )
    self._event(connection, request, owner, "document_share_request")
    return {
        **self._summary(request, recipient=True),
        "delivery": self._projection(connection, request, contract, requester),
    }


async def create(self, *, requester: str, owner: str, body: dict, google_recipient=None) -> dict:
    def operation(connection):
        lock_connection_graph_users(connection, user_ids=[owner, requester])
        self._relationship(connection, owner, requester)
        from hushh_mcp.services.connector_feature_admission import connector_feature_enabled

        if not connector_feature_enabled(
            "protected_document_delivery", owner
        ) or not connector_feature_enabled("protected_document_delivery", requester):
            raise DeliveryError("delivery_unavailable", 503)
        if not self.schema_ready(connection):
            raise DeliveryError("delivery_schema_unavailable", 503)
        fingerprint = _pin_recipient(self, connection, requester, body)
        request_digest = digest({"owner": owner, "requester": requester, "body": body})
        existing = self._row(
            connection,
            """SELECT * FROM drive_share_requests
          WHERE recipient_user_id=:user AND client_request_id=:client FOR UPDATE""",
            {"user": requester, "client": body["clientRequestId"]},
        )
        if existing:
            if existing["request_digest"] != request_digest:
                raise DeliveryError("idempotency_conflict")
            contract = self._row(
                connection,
                "SELECT * FROM document_delivery_contracts WHERE request_id=:request",
                {"request": existing["request_id"]},
            )
            if contract is None:
                raise DeliveryError("idempotency_conflict")
            return {
                **self._summary(existing, recipient=True),
                "delivery": self._projection(connection, existing, contract, requester),
            }
        return _insert_contract(
            self,
            connection,
            requester=requester,
            owner=owner,
            body=body,
            google_recipient=google_recipient,
            request_digest=request_digest,
            fingerprint=fingerprint,
        )

    return await self._transaction(operation)
