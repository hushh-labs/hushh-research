"""Reuse the managed Drive permission queue, never invent a Google receipt.

Copy approval is a distinct explicit authority. The old permission executor
still performs current issuer, exact provider version, complete ACL absence,
paid dispatch, uncertain-write reconciliation and receipt-proven removal.
"""

import json
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import DeliveryError
from hushh_mcp.services.drive_sharing_contract import DriveSharingError


def _record_review(store, connection, request, contract, package, current):
    review = store.sharing_cipher.seal(
        {
            "document_delivery": {
                "termsDigest": package["terms_digest"],
                "packageDigest": package["package_digest"],
            }
        },
        user_id=request["user_id"],
        resource_id=f"{request['request_id']}:{contract['revision']}",
        purpose="review",
    )
    connection.execute(
        text("""INSERT INTO drive_share_reviews(request_id,revision,user_id,connection_generation,
      review_envelope,review_digest,decision,expires_at,decided_at)
      VALUES(:request,:revision,:owner,:generation,CAST(:envelope AS jsonb),:digest,'approved',:expires,clock_timestamp())"""),
        {
            "request": request["request_id"],
            "revision": contract["revision"],
            "owner": request["user_id"],
            "generation": current["connection_generation"],
            "envelope": json.dumps(review),
            "digest": package["package_digest"],
            "expires": contract["access_expires_at"],
        },
    )


def queue_grants(store, connection, *, request, contract, package):
    if contract["receive_through"] != "both":
        return
    current = store._row(
        connection,
        """SELECT * FROM user_external_connector_connections
      WHERE user_id=:owner AND connector_id='google_drive' FOR SHARE""",
        {"owner": request["user_id"]},
    )
    if current is None or current["status"] != "connected":
        raise DeliveryError("source_unavailable")
    files = store._selection(contract)
    _record_review(store, connection, request, contract, package, current)
    recipient = store._open_request(request)["recipient"]
    for source in files:
        operation = str(uuid4())
        from hushh_mcp.services.document_delivery.store import iso

        plan = store.sharing_cipher.seal(
            {
                "file_id": source["providerFileId"],
                "file_name": source["name"],
                "source_version": source["sourceRevision"],
                "source_kind": "selected",
                "recipient": recipient,
                "expiration_time": iso(contract["access_expires_at"]),
                "document_delivery": {
                    "fileRef": source["fileRef"],
                    "termsDigest": package["terms_digest"],
                    "packageDigest": package["package_digest"],
                    "contentCommitment": package["content_commitment"],
                },
            },
            user_id=request["user_id"],
            resource_id=operation,
            purpose="permission-plan",
        )
        connection.execute(
            text("""INSERT INTO drive_share_permission_operations
          (operation_id,user_id,request_id,review_revision,batch_id,document_id,connection_generation,
           file_lock_hmac,kind,plan_envelope)
          VALUES(:id,:owner,:request,:revision,:batch,:document,:generation,:lock,'grant',CAST(:plan AS jsonb))"""),
            {
                "id": operation,
                "owner": request["user_id"],
                "request": request["request_id"],
                "revision": contract["revision"],
                "batch": f"document-delivery-{contract['generation_id']}",
                "document": source["documentId"],
                "generation": current["connection_generation"],
                "lock": store.sharing_cipher.file_lock(source["providerFileId"]),
                "plan": json.dumps(plan),
            },
        )
        connection.execute(
            text("""UPDATE document_delivery_file_receipts SET grant_operation_id=:operation
          WHERE request_id=:request AND file_ref=:ref"""),
            {"operation": operation, "request": request["request_id"], "ref": source["fileRef"]},
        )


def grant_authority(store, connection, *, request, initial, plan):
    from hushh_mcp.services.document_delivery.store import DocumentDeliveryStore

    copies = DocumentDeliveryStore(
        db=store.db, cipher=store.cipher, sharing_cipher=store.sharing_cipher
    )
    _, contract = copies._locked(
        connection, request_id=str(request["request_id"]), actor=request["user_id"], owner_only=True
    )
    package = copies._paid(connection, request, contract)
    binding = plan["document_delivery"]
    # Key recovery changes current T/D, while the already-paid source grant
    # retains its original immutable financial authority and exact content.
    financial = copies._row(
        connection,
        "SELECT * FROM document_delivery_financial_bindings WHERE request_id=:request",
        {"request": request["request_id"]},
    )
    if (
        contract["receive_through"] != "both"
        or contract["drive_revoke_status"] != "not_requested"
        or financial is None
        or binding["termsDigest"] != financial["original_terms_digest"]
        or binding["packageDigest"] != financial["original_package_digest"]
        or binding["contentCommitment"] != financial["content_commitment"]
        or binding["contentCommitment"] != package["content_commitment"]
    ):
        raise DeliveryError("drive_delivery_authority_changed")
    source = next(
        (item for item in copies._selection(contract) if item["fileRef"] == binding["fileRef"]),
        None,
    )
    document = store._row(
        connection,
        """SELECT * FROM connected_documents WHERE user_id=:owner
      AND document_id=:document AND connection_generation=:generation FOR SHARE""",
        {
            "owner": request["user_id"],
            "document": initial["document_id"],
            "generation": initial["connection_generation"],
        },
    )
    if document is None or source is None:
        raise DeliveryError("source_selection_changed")
    metadata = store.cipher.open(document)
    if (
        metadata["file_id"] != source["providerFileId"]
        or metadata["version"] != source["sourceRevision"]
        or metadata["mime_type"] != source["mimeType"]
        or metadata["size"] != source["size"]
    ):
        raise DeliveryError("source_selection_changed")
    store._active(connection, request["user_id"], initial["connection_generation"])
    store._selection_policy(connection, request["user_id"], feature="google_drive_connection")
    return plan


def settle_receipt(store, connection, *, job):
    plan = store._plan(job)
    binding = plan.get("document_delivery")
    if binding is None:
        return False
    row = store._row(
        connection,
        "SELECT * FROM drive_share_permission_operations WHERE operation_id=:id",
        {"id": job["operation_id"]},
    )
    if row["kind"] != "grant":
        return False
    state = (
        "confirmed"
        if row["state"] in {"succeeded", "preexisting"}
        else "unknown"
        if row["state"] in {"dispatching", "unknown", "present_unattributed"}
        else "pending"
        if row["state"] == "queued"
        else "failed"
    )
    connection.execute(
        text("""UPDATE document_delivery_file_receipts SET drive_state=:state,
      drive_receipt_envelope=CAST(:receipt AS jsonb) WHERE request_id=:request AND file_ref=:ref"""),
        {
            "state": state,
            "receipt": json.dumps(row["receipt_envelope"]),
            "request": job["request_id"],
            "ref": binding["fileRef"],
        },
    )
    # A failed channel is a terminal incomplete file, not a second file.
    pending = connection.execute(
        text("""SELECT EXISTS(SELECT 1 FROM document_delivery_file_receipts
      WHERE request_id=:request AND drive_state IN ('pending','unknown'))"""),
        {"request": job["request_id"]},
    ).scalar()
    if not pending:
        connection.execute(
            text("""UPDATE drive_share_requests SET status='partial',updated_at=clock_timestamp()
          WHERE request_id=:request AND status='approved'"""),
            {"request": job["request_id"]},
        )
    return True


def sync_revocation(store, connection, *, request, contract):
    if contract["drive_revoke_status"] != "pending":
        return contract["drive_revoke_status"]
    operations = [
        dict(row)
        for row in connection.execute(
            text("""SELECT * FROM drive_share_permission_operations
      WHERE request_id=:request ORDER BY operation_id FOR SHARE"""),
            {"request": request["request_id"]},
        ).mappings()
    ]
    pending, attention = False, False
    for grant in (row for row in operations if row["kind"] == "grant"):
        if grant["state"] in {"queued", "dispatching", "unknown"}:
            pending = True
        elif grant["state"] in {"preexisting", "present_unattributed", "needs_review"}:
            attention = True
        elif grant["state"] == "succeeded":
            receipt = store.sharing_cipher.open(
                grant["receipt_envelope"],
                user_id=request["user_id"],
                resource_id=str(grant["operation_id"]),
                purpose="permission-receipt",
            )
            if receipt.get("managed") is not True:
                attention = True
                continue
            children = [
                row for row in operations if row["parent_operation_id"] == grant["operation_id"]
            ]
            if not children or any(
                row["state"] in {"queued", "dispatching", "unknown"} for row in children
            ):
                pending = True
            elif not any(row["state"] in {"succeeded", "absent"} for row in children):
                attention = True
    status = "pending" if pending else "needs_attention" if attention else "removed"
    connection.execute(
        text(
            "UPDATE document_delivery_contracts SET drive_revoke_status=:status WHERE request_id=:request"
        ),
        {"status": status, "request": request["request_id"]},
    )
    return status


def grant_context(store, connection, initial, max_age):
    store._participant_gate(connection, initial["user_id"], str(initial["request_id"]))
    # Account erasure and legacy settlement take the management context
    # before request/payment locks. Keep grants in that same order.
    context = store._management_context(connection, initial["user_id"], initial["request_id"])
    request = store._related_request(connection, initial["user_id"], str(initial["request_id"]))
    from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore

    DriveRequestPaymentStore.require_paid_if_required(connection, request)
    now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
    plan = store._plan(initial)
    hosted_contract = plan.get("document_delivery") is not None
    if (
        context["private_request_erased_at"] is not None
        or request["access_stop_requested_at"] is not None
        or request["status"] not in {"approved", "partial"}
        or request["approval_invalidated_at"] is not None
        or request["revision"] != initial["review_revision"]
        or request["expires_at"] <= now
        or (not hosted_contract and (now - initial["created_at"]).total_seconds() > max_age)
    ):
        raise DriveSharingError("approval_superseded")
    return request, plan, hosted_contract


def finish_hosted_or_erased(store, connection, job):
    context = store._management_context(connection, job["user_id"], job["request_id"])
    if context["private_request_erased_at"] is not None:
        # The owner's receipt remains manageable. No erased request,
        # recipient link or private notification may be reconstructed.
        return True
    if job["kind"] == "grant":
        if settle_receipt(store, connection, job=job):
            return True
    return False


def removal_terms(grant, plan, created, issuer):
    return {
        "grant_operation_id": str(grant["operation_id"]),
        "document_id": str(grant["document_id"]),
        "review_revision": grant["review_revision"],
        "file_lock_hmac": grant["file_lock_hmac"],
        "file_id": plan["file_id"],
        "file_name": plan["file_name"],
        "permission_id": created["permission_id"],
        "recipient_email": created["email"],
        "issuer": issuer,
        "source_kind": plan.get("source_kind", "indexed"),
        "revocation_revision": grant["revocation_revision"],
        "request_stop": True,
        **(
            {"expiration_time": plan["expiration_time"]}
            if plan.get("document_delivery") is not None
            else {}
        ),
    }


def native_expiry(plan):
    return (
        {"expiration_time": plan["expiration_time"]}
        if plan.get("document_delivery") is not None
        else {}
    )


def created_reader_receipt(present):
    return {
        "permission_id": present["id"],
        "email": present["emailAddress"],
        "expiration_time": present.get("expirationTime"),
    }


async def create_reader(adapter, args, plan):
    return await adapter.create_reader(
        **args, verified_email=plan["recipient"]["email"], **native_expiry(plan)
    )
