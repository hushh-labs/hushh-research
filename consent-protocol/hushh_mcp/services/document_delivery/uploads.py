"""Document delivery uploads: operations over the owning store transaction port."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    MAX_REQUEST_BYTES,
    DeliveryError,
    Upload,
)

from .state import iso


async def reserve_upload(self, *, request_id, actor, body: Upload, bucket_identity):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        replay = self._idempotent(
            connection, request_id, body.idempotencyKey, "upload", body.wire()
        )
        if replay is not None:
            return replay
        self._current(request, contract, allow_approved=False)
        self._revision(contract, body.expectedRevision)
        if contract["status"] != "preparing" or contract["preparation_expires_at"] <= datetime.now(
            UTC
        ):
            raise DeliveryError("preparation_expired")
        descriptor = body.descriptor.wire()
        if descriptor["fileRef"] is not None and descriptor["fileRef"] not in {
            i["fileRef"] for i in self._selection(contract)
        }:
            raise DeliveryError("artifact_selection_mismatch", 422)
        inventory = (
            connection.execute(
                text("""SELECT COALESCE(SUM((descriptor->>'ciphertextBytes')::bigint),0) AS reserved,
              COUNT(*) AS count
          FROM document_delivery_artifacts WHERE request_id=:request AND generation_id=:generation"""),
                {"request": request_id, "generation": contract["generation_id"]},
            )
            .mappings()
            .one()
        )
        if inventory["count"] >= 51:
            raise DeliveryError("request_artifact_limit", 413)
        if inventory["reserved"] + descriptor["ciphertextBytes"] > MAX_REQUEST_BYTES:
            raise DeliveryError("request_ciphertext_limit", 413)
        upload_id = str(uuid4())
        object_key = f"{request_id}/{contract['generation_id']}/{descriptor['artifactId']}"
        connection.execute(
            text("""INSERT INTO document_delivery_artifacts
          (artifact_id,request_id,generation_id,file_ref,role,descriptor,upload_id,bucket_identity,object_key,expires_at)
          VALUES(:artifact,:request,:generation,:ref,:role,CAST(:descriptor AS jsonb),:upload,:bucket,:object,:expires)"""),
            {
                "artifact": descriptor["artifactId"],
                "request": request_id,
                "generation": contract["generation_id"],
                "ref": descriptor["fileRef"],
                "role": descriptor["role"],
                "descriptor": json.dumps(descriptor),
                "upload": upload_id,
                "bucket": bucket_identity,
                "object": object_key,
                "expires": contract["preparation_expires_at"],
            },
        )
        return self._result(
            connection,
            request_id,
            body.idempotencyKey,
            {
                "uploadId": upload_id,
                "artifactId": descriptor["artifactId"],
                "expiresAt": iso(contract["preparation_expires_at"]),
            },
        )

    return await self._transaction(operation)


async def upload_authority(self, *, request_id, actor, upload_id, claim=False):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        self._current(request, contract, allow_approved=False)
        row = self._row(
            connection,
            """SELECT * FROM document_delivery_artifacts
          WHERE request_id=:request AND upload_id=:upload AND generation_id=:generation FOR UPDATE""",
            {
                "request": request_id,
                "upload": upload_id,
                "generation": contract["generation_id"],
            },
        )
        if (
            row is None
            or row["expires_at"] <= datetime.now(UTC)
            or contract["status"] != "preparing"
        ):
            raise DeliveryError("upload_expired")
        if claim:
            if row["state"] not in {"reserved", "uncertain", "writing", "uploaded"}:
                raise DeliveryError("upload_already_started")
            connection.execute(
                text(
                    "UPDATE document_delivery_artifacts SET state='writing' WHERE artifact_id=:id"
                ),
                {"id": row["artifact_id"]},
            )
        return row

    return await self._transaction(operation)


async def attach_upload_session(self, *, request_id, actor, upload_id, session):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        self._current(request, contract, allow_approved=False)
        row = self._row(
            connection,
            """SELECT * FROM document_delivery_artifacts
          WHERE request_id=:request AND upload_id=:upload AND generation_id=:generation FOR UPDATE""",
            {
                "request": request_id,
                "upload": upload_id,
                "generation": contract["generation_id"],
            },
        )
        if row is None or row["expires_at"] <= datetime.now(UTC):
            raise DeliveryError("upload_expired")
        if row["upload_session_envelope"] is not None:
            raise DeliveryError("upload_session_already_bound")
        envelope = self.sharing_cipher.seal(
            {"session": session},
            user_id="document-delivery",
            resource_id=row["object_key"],
            purpose="upload-session",
        )
        connection.execute(
            text("""UPDATE document_delivery_artifacts SET upload_session_envelope=CAST(:envelope AS jsonb),
          session_observed_at=clock_timestamp() WHERE artifact_id=:id"""),
            {"envelope": json.dumps(envelope), "id": row["artifact_id"]},
        )

    return await self._transaction(operation)


def upload_session(self, row):
    if row["upload_session_envelope"] is None:
        return None
    return self.sharing_cipher.open(
        row["upload_session_envelope"],
        user_id="document-delivery",
        resource_id=row["object_key"],
        purpose="upload-session",
    )["session"]


async def dispatch_upload(self, *, request_id, actor, upload_id):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        self._current(request, contract, allow_approved=False)
        row = self._row(
            connection,
            """SELECT * FROM document_delivery_artifacts
          WHERE request_id=:request AND upload_id=:upload AND generation_id=:generation FOR UPDATE""",
            {
                "request": request_id,
                "upload": upload_id,
                "generation": contract["generation_id"],
            },
        )
        if (
            row is None
            or row["upload_session_envelope"] is None
            or row["expires_at"] <= datetime.now(UTC)
        ):
            raise DeliveryError("upload_expired")
        if row["write_dispatched_at"] is not None and row["write_settled_at"] is None:
            raise DeliveryError("upload_outcome_unknown")
        connection.execute(
            text("""UPDATE document_delivery_artifacts SET write_dispatched_at=clock_timestamp(),
          write_settled_at=NULL WHERE artifact_id=:id"""),
            {"id": row["artifact_id"]},
        )
        return row

    return await self._transaction(operation)


async def upload_result(self, *, request_id, actor, upload_id, generation=None, finalized=False):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        row = self._row(
            connection,
            """SELECT * FROM document_delivery_artifacts WHERE request_id=:request
          AND upload_id=:upload FOR UPDATE""",
            {"request": request_id, "upload": upload_id},
        )
        if row is None:
            raise DeliveryError("upload_expired")
        try:
            self._current(request, contract, allow_approved=False)
            valid = row["generation_id"] == contract["generation_id"] and row[
                "expires_at"
            ] > datetime.now(UTC)
        except DeliveryError:
            valid = False
        if not valid:
            self._enqueue_cleanup(
                connection,
                request_id,
                artifact_id=str(row["artifact_id"]),
                generation=generation,
            )
            return None
        connection.execute(
            text("""UPDATE document_delivery_artifacts SET state=:state,
          object_generation=COALESCE(:generation,object_generation),
          finalized_at=CASE WHEN :finalized THEN clock_timestamp() ELSE finalized_at END,
          write_settled_at=CASE WHEN :generation IS NOT NULL THEN clock_timestamp() ELSE write_settled_at END
          WHERE artifact_id=:id"""),
            {
                "state": "finalized" if finalized else "uploaded" if generation else "uncertain",
                "generation": generation,
                "finalized": finalized,
                "id": row["artifact_id"],
            },
        )
        return row["descriptor"]

    return await self._transaction(operation)
