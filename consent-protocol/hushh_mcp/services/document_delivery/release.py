"""Document delivery release: operations over the owning store transaction port."""

from __future__ import annotations

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
    digest,
)

from .state import delivery_summary, iso


def release_locked(self, connection, *, request_id, actor):
    request, contract = self._locked(connection, request_id=request_id, actor=actor)
    if actor != contract["recipient_user_id"]:
        raise DeliveryError("recipient_required", 403)
    package = self._paid(connection, request, contract)
    rows = (
        connection.execute(
            text("""SELECT * FROM document_delivery_file_receipts
      WHERE request_id=:request ORDER BY file_ref FOR UPDATE"""),
            {"request": request_id},
        )
        .mappings()
        .all()
    )
    available = {
        str(row["file_ref"])
        for row in rows
        if (contract["receive_through"] == "one" or row["drive_state"] == "confirmed")
        and (not package.get("_partial_refund") or row["hosted_released_at"] is not None)
    }
    for file_ref in available:
        connection.execute(
            text("""UPDATE document_delivery_file_receipts SET
          hosted_released_at=COALESCE(hosted_released_at,clock_timestamp())
          WHERE request_id=:request AND file_ref=:ref"""),
            {"request": request_id, "ref": file_ref},
        )
    summary = delivery_summary(connection, request_id)
    connection.execute(
        text("""UPDATE document_delivery_financial_bindings SET
      confirmed_count=:confirmed,unsettled_count=:unsettled WHERE request_id=:request"""),
        {"request": request_id, **summary},
    )
    if summary["confirmed"] == summary["expected"] and summary["expected"] > 0:
        connection.execute(
            text(
                "UPDATE document_delivery_contracts SET status='released',updated_at=clock_timestamp() WHERE request_id=:request"
            ),
            {"request": request_id},
        )
        connection.execute(
            text(
                "UPDATE drive_share_requests SET status='completed',updated_at=clock_timestamp() WHERE request_id=:request"
            ),
            {"request": request_id},
        )
    artifacts = package["artifacts"]
    allowed = {
        item["artifactId"]
        for item in artifacts
        if item["fileRef"] is None or item["fileRef"] in available
    }
    interaction = self._audit(
        connection, request_id=request_id, actor=actor, kind="package_released"
    )
    return {
        "terms": package["terms"],
        "termsDigest": package["terms_digest"],
        "packageDigest": package["package_digest"],
        "preparationDigest": package["preparation_digest"],
        "contentCommitment": package["content_commitment"],
        "artifacts": artifacts,
        "wrapDigests": [
            {"artifactId": item["artifactId"], "role": item["role"], "sha256": digest(item)}
            for item in sorted(
                package["wraps"], key=lambda item: (item["artifactId"], item["role"])
            )
        ],
        "wraps": [
            item
            for item in package["wraps"]
            if item["role"] == "recipient" and item["artifactId"] in allowed
        ],
        "interactionId": interaction,
        "accessExpiresAt": iso(contract["access_expires_at"]),
    }


async def release(self, *, request_id, actor):
    return await self._transaction(
        lambda connection: self.release_locked(connection, request_id=request_id, actor=actor)
    )


async def artifact_authority(self, *, request_id, actor, artifact_id, served=False):
    def operation(connection):
        request, contract = self._locked(connection, request_id=request_id, actor=actor)
        self._current(request, contract)
        artifact = self._row(
            connection,
            """SELECT * FROM document_delivery_artifacts
          WHERE request_id=:request AND artifact_id=:artifact AND generation_id=:generation AND state='finalized'""",
            {
                "request": request_id,
                "artifact": artifact_id,
                "generation": contract["generation_id"],
            },
        )
        if artifact is None:
            raise DeliveryError("artifact_unavailable", 404)
        if actor != contract["owner_user_id"]:
            self._paid(connection, request, contract)
            if artifact["file_ref"] is not None:
                receipt = self._row(
                    connection,
                    """SELECT * FROM document_delivery_file_receipts
                  WHERE request_id=:request AND file_ref=:ref""",
                    {"request": request_id, "ref": artifact["file_ref"]},
                )
                if (
                    receipt is None
                    or receipt["hosted_released_at"] is None
                    or contract["receive_through"] == "both"
                    and receipt["drive_state"] != "confirmed"
                ):
                    raise DeliveryError("file_not_released", 403)
        if served:
            self._audit(
                connection,
                request_id=request_id,
                actor=actor,
                artifact_id=artifact_id,
                kind="ciphertext_served",
            )
        return artifact

    return await self._transaction(operation)
