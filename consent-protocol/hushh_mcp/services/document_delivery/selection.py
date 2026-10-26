"""Document delivery selection: operations over the owning store transaction port."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid5

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
)

from .state import iso


def _selection(self, contract):
    if not contract["selection_envelope"]:
        return []
    return self.sharing_cipher.open(
        contract["selection_envelope"],
        user_id=contract["owner_user_id"],
        resource_id=str(contract["request_id"]),
        purpose="document-delivery-selection",
    )["files"]


def _candidates(self, connection, request) -> list[dict]:
    rows = connection.execute(
        text("""SELECT d.* FROM connected_documents d
      JOIN user_external_connector_connections c ON c.user_id=d.user_id
        AND c.connector_id='google_drive' AND c.connection_generation=d.connection_generation
      WHERE d.user_id=:owner AND c.status='connected'
      ORDER BY d.created_at,d.document_id LIMIT 100"""),
        {"owner": request["user_id"]},
    ).mappings()
    result = []
    for row in rows:
        metadata = self.cipher.open(dict(row))
        if (
            metadata["mime_type"] != "application/pdf"
            or not 1 <= (metadata.get("size") or 0) <= 4_194_304
        ):
            continue
        result.append(
            {
                "fileRef": str(uuid5(UUID(str(request["request_id"])), str(row["document_id"]))),
                "documentId": str(row["document_id"]),
                "providerFileId": metadata["file_id"],
                "name": metadata["name"],
                "mimeType": metadata["mime_type"],
                "size": metadata["size"],
                "sourceRevision": metadata["version"],
                "sourceSha256": None,
            }
        )
        if len(result) == 25:
            break
    return result


async def source_selection(self, *, request_id, actor):
    """Owner source metadata, consumed only by the placement-gated content route."""

    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        self._current(request, contract, allow_approved=False)
        if contract["status"] not in {"requested", "preparing", "staged"}:
            raise DeliveryError("source_selection_unavailable")
        files = self._selection(contract)
        if not files and contract["status"] == "requested":
            files = self._candidates(connection, request)
        return {"requestId": request_id, "revision": contract["revision"], "files": files}

    return await self._transaction(operation)


async def source_authority(self, *, request_id, actor, expected_revision):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        self._current(request, contract, allow_approved=False)
        self._revision(contract, expected_revision)
        if not contract["copy_accepted_at"] or contract["preparation_expires_at"] <= datetime.now(
            UTC
        ):
            raise DeliveryError("preparation_expired")
        current = self._row(
            connection,
            """SELECT * FROM user_external_connector_connections
          WHERE user_id=:owner AND connector_id='google_drive' AND status='connected' FOR SHARE""",
            {"owner": actor},
        )
        if current is None:
            raise DeliveryError("source_unavailable")
        return {
            "requestId": request_id,
            "revision": contract["revision"],
            "sourceSelectionDigest": contract["source_selection_digest"],
            "connectionGeneration": current["connection_generation"],
            "expiresAt": iso(contract["preparation_expires_at"]),
        }

    return await self._transaction(operation)


def _document_owner_setup(
    self, connection, *, owner_user_id, amount_cents, settlement_method="stripe_transfer"
):
    setup = self._owner_setup(
        connection,
        owner_user_id=owner_user_id,
        amount_cents=amount_cents,
        settlement_method=settlement_method,
    )
    # The new contract allows exact cents; retain whole-dollar validation
    # for every historical Drive-only request.
    setup["ownerPriceRequired"] = not (type(amount_cents) is int and 50 <= amount_cents <= 50_000)
    from hushh_mcp.services.connector_feature_admission import connector_feature_enabled

    setup["paymentsReady"] = connector_feature_enabled("protected_document_delivery", owner_user_id)
    return setup
