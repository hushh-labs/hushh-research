"""Document delivery transaction: operations over the owning store transaction port."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
    digest,
)


def schema_ready(connection) -> bool:
    return bool(
        connection.execute(
            text("""SELECT to_regclass('document_delivery_cleanup') IS NOT NULL
              AND to_regclass('document_delivery_public_keys') IS NOT NULL
              AND to_regclass('one_kyc_client_connectors') IS NOT NULL
              AND to_regprocedure('document_delivery_summary_for(uuid)') IS NOT NULL
              AND has_function_privilege(current_user,'document_delivery_summary_for(uuid)','EXECUTE')""")
        ).scalar()
    )


def _locked(self, connection, *, request_id: str, actor: str, owner_only=False):
    participant = self._row(
        connection,
        """SELECT * FROM drive_share_requests
      WHERE request_id=:request AND (user_id=:actor OR recipient_user_id=:actor)""",
        {"request": request_id, "actor": actor},
    )
    if participant is None or (owner_only and participant["user_id"] != actor):
        raise DeliveryError("request_unavailable", 404)
    lock_connection_graph_users(
        connection, user_ids=[participant["user_id"], participant["recipient_user_id"]]
    )
    request = self._row(
        connection,
        "SELECT * FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
        {"request": request_id},
    )
    contract = self._row(
        connection,
        "SELECT * FROM document_delivery_contracts WHERE request_id=:request FOR UPDATE",
        {"request": request_id},
    )
    if request is None or contract is None:
        raise DeliveryError("request_unavailable", 404)
    return request, contract


def _current(request, contract, *, allow_approved=True):
    now = datetime.now(UTC)
    if (
        request["status"] in {"declined", "cancelled", "expired", "no_match"}
        or request["expires_at"] <= now
        or contract["access_expires_at"] <= now
        or contract["status"] in {"revoked", "expired", "erasing"}
        or (not allow_approved and contract["status"] in {"approved", "released"})
    ):
        raise DeliveryError("delivery_authority_ended")


def _revision(contract, expected):
    if contract["revision"] != expected:
        raise DeliveryError("delivery_revision_changed")


def _idempotent(self, connection, request_id, key, operation, body):
    fingerprint = digest(body)
    existing = (
        connection.execute(
            text("""SELECT * FROM document_delivery_idempotency
      WHERE request_id=:request AND idempotency_key=:key FOR UPDATE"""),
            {"request": request_id, "key": key},
        )
        .mappings()
        .first()
    )
    if existing is not None:
        if existing["operation"] != operation or existing["body_digest"] != fingerprint:
            raise DeliveryError("idempotency_conflict")
        return (
            self.sharing_cipher.open(
                existing["result"],
                user_id="document-delivery",
                resource_id=f"{request_id}:{key}:{operation}:{fingerprint}",
                purpose="document-delivery-idempotency",
            )
            if existing["result"] is not None
            else None
        )
    connection.execute(
        text("""INSERT INTO document_delivery_idempotency
      (request_id,idempotency_key,operation,body_digest) VALUES(:request,:key,:operation,:digest)"""),
        {"request": request_id, "key": key, "operation": operation, "digest": fingerprint},
    )
    return None


def _result(self, connection, request_id, key, result):
    row = self._row(
        connection,
        """SELECT operation,body_digest FROM document_delivery_idempotency
      WHERE request_id=:request AND idempotency_key=:key FOR UPDATE""",
        {"request": request_id, "key": key},
    )
    if row is None:
        raise DeliveryError("idempotency_state_unavailable", 503)
    sealed = self.sharing_cipher.seal(
        result,
        user_id="document-delivery",
        resource_id=f"{request_id}:{key}:{row['operation']}:{row['body_digest']}",
        purpose="document-delivery-idempotency",
    )
    connection.execute(
        text("""UPDATE document_delivery_idempotency SET result=CAST(:result AS jsonb)
      WHERE request_id=:request AND idempotency_key=:key"""),
        {"request": request_id, "key": key, "result": json.dumps(sealed)},
    )
    return result


def _no_payment_attempt(connection, request_id):
    order = (
        connection.execute(
            text("""SELECT * FROM drive_request_payment_orders
      WHERE request_id=:request FOR UPDATE"""),
            {"request": request_id},
        )
        .mappings()
        .first()
    )
    if order is not None:
        # Even an unbound reserved attempt may already be executing at Stripe.
        raise DeliveryError("delivery_commercial_terms_frozen")
