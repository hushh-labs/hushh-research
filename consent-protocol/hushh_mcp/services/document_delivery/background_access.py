"""Private participant projections and live entitlement around every object read."""

from sqlalchemy import text

from hushh_mcp.services.document_delivery.background_consent import requested
from hushh_mcp.services.document_delivery.background_diagnostics import safe_detail
from hushh_mcp.services.document_delivery.contracts import DeliveryError
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import FILE_ID


def participant(store, connection, request_id, actor):
    row = store._row(
        connection,
        """SELECT * FROM drive_share_requests WHERE request_id=:request
      AND (user_id=:actor OR recipient_user_id=:actor)""",
        {"request": request_id, "actor": actor},
    )
    if row is None:
        raise DeliveryError("request_unavailable", 404)
    return row


def file_projection(store, row):
    source = store.open(row, "source_envelope", "background-copy-source-v2")
    entry = {
        "fileRef": str(row["file_ref"]),
        "name": source["name"],
        "mimeType": source["mimeType"],
        "status": row["state"],
        "previewAvailable": row["state"] == "ready" and source["mimeType"] == "application/pdf",
        "shareId": str(row["share_id"]),
        "sourcePosition": row["position"],
    }
    if FILE_ID.fullmatch(source["id"]):
        entry["openUrl"] = f"https://drive.google.com/file/d/{source['id']}/view"
    entry["rendition"] = "original"
    if row["state"] == "ready":
        ready = store.open(row, "result_envelope", "background-copy-result-v2")
        entry.update(
            {
                key: ready[key]
                for key in (
                    "sha256",
                    "rendition",
                    "name",
                    "mimeType",
                    "exportFormat",
                    "sourceName",
                    "exportedAt",
                )
                if key in ready
            }
        )
        entry["previewAvailable"] = (
            ready.get("mimeType", source["mimeType"]) == "application/pdf"
            and ready["bytes"] <= 4 * 1024 * 1024
        )
        if type(ready.get("sourceMetadataTimeChanged")) is bool:
            entry["sourceMetadataTimeChanged"] = ready["sourceMetadataTimeChanged"]
    elif row["state"] == "unavailable" and row.get("result_envelope"):
        try:
            detail = store.open(row, "result_envelope", "background-copy-result-v2")
            projected = safe_detail(detail.get("copyDiagnostics"))
            if projected:
                entry["copyDiagnostics"] = projected
        except DriveSharingError:
            pass
    if row["reason"]:
        entry["reason"] = row["reason"]
    return entry


async def status(service, *, request_id, actor):
    store = service.store

    def operation(connection):
        request = participant(store, connection, request_id, actor)
        result = {
            "requestId": request_id,
            "status": "pending",
            "files": [],
            "actorRole": "owner" if actor == request["user_id"] else "recipient",
        }
        if not requested(store._open_request(request)) or not store.ready(connection):
            return dict(result, status="unavailable")
        contract = store._row(
            connection,
            "SELECT * FROM document_delivery_background_requests WHERE request_id=:request",
            {"request": request_id},
        )
        if contract is None:
            return result
        try:
            store.authority(connection, request_id, actor, paid=actor != request["user_id"])
        except DriveSharingError as error:
            if str(error) == "payment_required":
                return result
            raise
        except DeliveryError as error:
            if str(error) == "payment_required":
                return result
            if str(error) == "one_copy_revoked":
                return dict(result, status="revoked")
            raise
        rows = connection.execute(
            text("""SELECT f.*,r.user_id AS owner_user_id FROM document_delivery_background_files f
          JOIN drive_share_requests r USING(request_id) WHERE f.request_id=:request ORDER BY f.created_at,f.file_ref"""),
            {"request": request_id},
        ).mappings()
        files = [file_projection(store, dict(item)) for item in rows]
        states = {item["status"] for item in files}
        state = (
            "preparing"
            if "preparing" in states
            else "ready"
            if states == {"ready"}
            else "partial"
            if "ready" in states
            else "unavailable"
            if states
            else "pending"
        )
        return dict(result, status=state, files=files)

    return await store._transaction(operation)


async def content(service, *, request_id, file_ref, actor, disposition):
    store = service.store

    def operation(connection):
        request = participant(store, connection, request_id, actor)
        row = store._row(
            connection,
            """SELECT *, :owner AS owner_user_id FROM document_delivery_background_files
          WHERE request_id=:request AND file_ref=:ref""",
            {"request": request_id, "ref": file_ref, "owner": request["user_id"]},
        )
        if row is None or row["state"] != "ready":
            raise DeliveryError("one_copy_unavailable", 404)
        store.file_authority(connection, row, actor)
        source = store.open(row, "source_envelope", "background-copy-source-v2")
        result = store.open(row, "result_envelope", "background-copy-result-v2")
        source.update({key: result[key] for key in ("name", "mimeType") if key in result})
        if disposition == "preview" and (
            source["mimeType"] != "application/pdf" or result["bytes"] > 4 * 1024 * 1024
        ):
            raise DeliveryError("preview_unavailable", 415)
        store.audit(
            connection,
            request,
            actor,
            "preview_requested" if disposition == "preview" else "download_requested",
            row["file_ref"],
        )
        return row, source, result

    return await store._transaction(operation)


async def revoke(service, *, request_id, actor):
    store = service.store

    def operation(connection):
        request = participant(store, connection, request_id, actor)
        if actor != request["user_id"]:
            raise DeliveryError("owner_required", 403)
        store._participant_gate(connection, actor, request_id)
        connection.execute(
            text(
                "SELECT request_id FROM drive_share_requests WHERE request_id=:request FOR UPDATE"
            ),
            {"request": request_id},
        )
        connection.execute(
            text(
                "UPDATE document_delivery_background_requests SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE request_id=:request"
            ),
            {"request": request_id},
        )
        rows = connection.execute(
            text(
                "UPDATE document_delivery_background_files SET state='revoked' WHERE request_id=:request RETURNING file_ref"
            ),
            {"request": request_id},
        ).mappings()
        for row in rows:
            store.retire(connection, row["file_ref"])
        if store._row(
            connection,
            "SELECT request_id FROM document_delivery_background_requests WHERE request_id=:request",
            {"request": request_id},
        ):
            store.audit(connection, request, actor, "revoked")
        return {"requestId": request_id, "status": "revoked", "files": []}

    return await store._transaction(operation)


async def retire_ended(store, limit):
    def operation(connection):
        rows = (
            connection.execute(
                text("""SELECT f.file_ref FROM document_delivery_background_files f
          JOIN drive_share_requests r USING(request_id) JOIN document_delivery_background_requests c USING(request_id)
          LEFT JOIN user_external_connector_connections d ON d.user_id=r.user_id AND d.connector_id='google_drive'
          WHERE f.state<>'revoked' AND (r.access_expires_at<=clock_timestamp()
            OR r.access_stop_requested_at IS NOT NULL OR r.approval_invalidated_at IS NOT NULL
            OR r.status IN ('cancelled','declined','expired','no_match') OR c.revoked_at IS NOT NULL
            OR d.status IS DISTINCT FROM 'connected' OR d.connection_generation<>c.connection_generation)
          ORDER BY f.created_at LIMIT :limit FOR UPDATE OF f SKIP LOCKED"""),
                {"limit": limit},
            )
            .mappings()
            .all()
        )
        for row in rows:
            connection.execute(
                text(
                    "UPDATE document_delivery_background_files SET state='revoked' WHERE file_ref=:ref"
                ),
                {"ref": row["file_ref"]},
            )
            store.retire(connection, row["file_ref"])
        connection.execute(
            text(
                "DELETE FROM document_delivery_background_activity WHERE created_at<clock_timestamp()-INTERVAL '90 days'"
            )
        )

    await store._transaction(operation)
