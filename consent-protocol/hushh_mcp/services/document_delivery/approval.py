"""Document delivery approval: operations over the owning store transaction port."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    COPY_DISCLOSURE,
    DeliveryError,
    FinalApproval,
    Prepare,
    digest,
    preparation_commitment,
)

from .state import deadline


def _selection_terms(self, connection, *, request, contract, body):
    candidates = {item["documentId"]: item for item in self._candidates(connection, request)}
    files = [item.wire() for item in body.selectedFiles]
    if len({item["fileRef"] for item in files}) != len(files) or len(
        {item["documentId"] for item in files}
    ) != len(files):
        raise DeliveryError("duplicate_selection", 422)
    if any(candidates.get(item["documentId"]) != item for item in files):
        raise DeliveryError("source_selection_changed")
    expires = deadline(body.accessExpiresAt)
    if not datetime.now(UTC) < expires <= min(request["expires_at"], contract["access_expires_at"]):
        raise DeliveryError("invalid_access_deadline", 422)
    self._public_key(connection, contract, require_active=True)
    return files, expires


def _prepare(self, connection, *, request_id, actor, body, request, contract):
    files, expires = _selection_terms(
        self, connection, request=request, contract=contract, body=body
    )
    generation = str(uuid4())
    selection_digest = digest(files)
    preparation = preparation_commitment(
        request_id=request_id,
        owner=actor,
        recipient=contract["recipient_user_id"],
        generation_id=generation,
        selection_digest=selection_digest,
    )
    envelope = self.sharing_cipher.seal(
        {"files": files},
        user_id=actor,
        resource_id=request_id,
        purpose="document-delivery-selection",
    )
    pending = connection.execute(
        text(
            "SELECT EXISTS(SELECT 1 FROM drive_share_permission_operations WHERE request_id=:request AND (dispatched_at IS NOT NULL OR state<>'queued'))"
        ),
        {"request": request_id},
    ).scalar()
    if pending:
        raise DeliveryError("drive_preparation_in_progress")
    connection.execute(
        text("DELETE FROM drive_share_permission_operations WHERE request_id=:request"),
        {"request": request_id},
    )
    connection.execute(
        text("DELETE FROM drive_share_reviews WHERE request_id=:request"),
        {"request": request_id},
    )
    self._enqueue_cleanup(connection, request_id)
    connection.execute(
        text("DELETE FROM document_delivery_file_receipts WHERE request_id=:request"),
        {"request": request_id},
    )
    connection.execute(
        text("""UPDATE document_delivery_contracts SET revision=revision+1,
      status='preparing',generation_id=:generation,source_selection_digest=:selection,
      preparation_digest=:preparation,selection_envelope=CAST(:envelope AS jsonb),
      copy_disclosure_version=:copy,copy_accepted_at=clock_timestamp(),amount_cents=:amount,
      access_expires_at=:expires,preparation_expires_at=LEAST(:expires,clock_timestamp()+INTERVAL '30 minutes'),
      current_package_id=NULL,approved_at=NULL,accepted_at=NULL,
      accepted_terms_digest=NULL,accepted_package_digest=NULL,updated_at=clock_timestamp()
      WHERE request_id=:request"""),
        {
            "request": request_id,
            "generation": generation,
            "selection": selection_digest,
            "preparation": preparation,
            "envelope": json.dumps(envelope),
            "copy": COPY_DISCLOSURE,
            "amount": body.amountCents,
            "expires": expires,
        },
    )
    for item in files:
        connection.execute(
            text("""INSERT INTO document_delivery_file_receipts(request_id,file_ref,drive_state)
          VALUES(:request,:ref,:state)"""),
            {
                "request": request_id,
                "ref": item["fileRef"],
                "state": "pending" if contract["receive_through"] == "both" else "not_required",
            },
        )


def _final(self, connection, *, request_id, body, request, contract):
    if contract["status"] != "staged" or contract["preparation_expires_at"] <= datetime.now(UTC):
        raise DeliveryError("package_not_ready")
    package = self._row(
        connection,
        "SELECT * FROM document_delivery_packages WHERE package_id=:id",
        {"id": contract["current_package_id"]},
    )
    if (
        package is None
        or package["terms_digest"] != body.termsDigest
        or package["package_digest"] != body.packageDigest
    ):
        raise DeliveryError("package_changed")
    self._public_key(connection, contract, require_active=True)
    connection.execute(
        text("""UPDATE document_delivery_contracts SET status='approved',
      approved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE request_id=:request"""),
        {"request": request_id},
    )
    connection.execute(
        text("""UPDATE drive_share_requests SET status='approved',revision=:revision,
      quoted_amount_cents=:amount,quote_version=:revision,
      updated_at=clock_timestamp() WHERE request_id=:request"""),
        {
            "request": request_id,
            "revision": contract["revision"],
            "amount": contract["amount_cents"],
            "expires": contract["access_expires_at"],
        },
    )
    from hushh_mcp.services.document_delivery.drive_bridge import queue_grants

    queue_grants(self, connection, request=request, contract=contract, package=package)


async def approve(self, *, request_id: str, actor: str, body: Prepare | FinalApproval):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        replay = self._idempotent(
            connection, request_id, body.idempotencyKey, "approve", body.wire()
        )
        if replay is not None:
            return replay
        self._current(request, contract)
        self._revision(contract, body.expectedRevision)
        self._no_payment_attempt(connection, request_id)
        if isinstance(body, Prepare):
            _prepare(
                self,
                connection,
                request_id=request_id,
                actor=actor,
                body=body,
                request=request,
                contract=contract,
            )
        else:
            _final(
                self,
                connection,
                request_id=request_id,
                body=body,
                request=request,
                contract=contract,
            )
        current_request, current = self._locked(connection, request_id=request_id, actor=actor)
        self._notify_setup_changed(connection, current_request)
        return self._result(
            connection,
            request_id,
            body.idempotencyKey,
            self._projection(
                connection,
                current_request,
                current,
                actor,
                include_owner_source=isinstance(body, Prepare),
            ),
        )

    return await self._transaction(operation)
