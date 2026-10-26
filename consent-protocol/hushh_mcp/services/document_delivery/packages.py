"""Document delivery packages: operations over the owning store transaction port."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    ACTIVITY_DISCLOSURE,
    COPY_DISCLOSURE,
    DeliveryError,
    Package,
    content_commitment,
    digest,
    package_commitment,
)

from .state import iso


def _validate_artifacts(self, connection, request_id, contract, body):
    artifacts = [item.wire() for item in body.artifacts]
    files = self._selection(contract)
    expected_roles = {
        (item["fileRef"], role) for item in files for role in ("original", "watermarked")
    } | {(None, "manifest")}
    if (
        {(item["fileRef"], item["role"]) for item in artifacts} != expected_roles
        or len(artifacts) != len(expected_roles)
        or len({i["artifactId"] for i in artifacts}) != len(artifacts)
    ):
        raise DeliveryError("artifact_set_mismatch", 422)
    if len({i["iv"] for i in artifacts}) != len(artifacts):
        raise DeliveryError("artifact_iv_reuse", 422)
    inventory = {
        str(row["artifact_id"]): dict(row)
        for row in connection.execute(
            text("""SELECT *
      FROM document_delivery_artifacts WHERE request_id=:request AND generation_id=:generation FOR SHARE"""),
            {"request": request_id, "generation": contract["generation_id"]},
        ).mappings()
    }
    if set(inventory) != {item["artifactId"] for item in artifacts} or any(
        inventory[item["artifactId"]]["descriptor"] != item
        or inventory[item["artifactId"]]["state"] != "finalized"
        for item in artifacts
    ):
        raise DeliveryError("artifact_inventory_incomplete")
    return artifacts


def _validate_terms(contract, request_id, actor, body, artifacts):
    if (
        str(contract["generation_id"]) != body.generationId
        or contract["preparation_digest"] != body.preparationDigest
    ):
        raise DeliveryError("preparation_changed")
    content = content_commitment(body.preparationDigest, artifacts)
    terms = body.terms.wire()
    expected_terms = {
        "version": 1,
        "revision": contract["revision"],
        "requestId": request_id,
        "ownerUserId": actor,
        "recipientUserId": contract["recipient_user_id"],
        "receiveThrough": contract["receive_through"],
        "contentCommitment": content,
        "amountCents": contract["amount_cents"],
        "currency": "usd",
        "accessExpiresAt": iso(contract["access_expires_at"]),
        "rights": {"preview": True, "download": True},
        "activityDisclosureVersion": ACTIVITY_DISCLOSURE,
        "copyDisclosureVersion": COPY_DISCLOSURE,
        "recipientKeyId": contract["recipient_key_id"],
        "recipientKeyFingerprint": contract["recipient_key_fingerprint"],
    }
    if (
        terms != expected_terms
        or content != body.contentCommitment
        or digest(terms) != body.termsDigest
    ):
        raise DeliveryError("terms_commitment_mismatch", 422)
    return content, terms


def _validate_wraps(contract, body, artifacts, content, wraps):
    expected_wraps = {
        (item["artifactId"], role) for item in artifacts for role in ("recipient", "owner_recovery")
    }
    if (
        len(wraps) != len(expected_wraps)
        or {(item["artifactId"], item["role"]) for item in wraps} != expected_wraps
    ):
        raise DeliveryError("wrap_set_mismatch", 422)
    if any(
        item["role"] == "recipient"
        and (
            item["recipientKeyId"] != contract["recipient_key_id"]
            or item["recipientKeyFingerprint"] != contract["recipient_key_fingerprint"]
        )
        for item in wraps
    ):
        raise DeliveryError("recipient_wrap_mismatch", 422)
    if package_commitment(content, body.termsDigest, wraps) != body.packageDigest:
        raise DeliveryError("package_commitment_mismatch", 422)
    return wraps


async def stage_package(self, *, request_id, actor, body: Package):
    def operation(connection):
        request, contract = self._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        replay = self._idempotent(
            connection, request_id, body.idempotencyKey, "package", body.wire()
        )
        if replay is not None:
            return replay
        self._current(request, contract, allow_approved=False)
        self._revision(contract, body.expectedRevision)
        if contract["status"] != "preparing" or contract["preparation_expires_at"] <= datetime.now(
            UTC
        ):
            raise DeliveryError("preparation_expired")
        artifacts = _validate_artifacts(self, connection, request_id, contract, body)
        content, terms = _validate_terms(contract, request_id, actor, body, artifacts)
        wraps = _validate_wraps(
            contract, body, artifacts, content, [item.wire() for item in body.wraps]
        )
        package_id = str(uuid4())
        connection.execute(
            text("""INSERT INTO document_delivery_packages(package_id,request_id,revision,generation_id,
          preparation_digest,content_commitment,terms,terms_digest,package_digest,artifacts,wraps)
          VALUES(:id,:request,:revision,:generation,:preparation,:content,CAST(:terms AS jsonb),:td,:pd,
            CAST(:artifacts AS jsonb),CAST(:wraps AS jsonb))"""),
            {
                "id": package_id,
                "request": request_id,
                "revision": contract["revision"],
                "generation": body.generationId,
                "preparation": body.preparationDigest,
                "content": content,
                "terms": json.dumps(terms),
                "td": body.termsDigest,
                "pd": body.packageDigest,
                "artifacts": json.dumps(artifacts),
                "wraps": json.dumps(wraps),
            },
        )
        connection.execute(
            text("""UPDATE document_delivery_contracts SET status='staged',current_package_id=:id,
          updated_at=clock_timestamp() WHERE request_id=:request"""),
            {"id": package_id, "request": request_id},
        )
        request, current = self._locked(connection, request_id=request_id, actor=actor)
        return self._result(
            connection,
            request_id,
            body.idempotencyKey,
            self._projection(connection, request, current, actor),
        )

    return await self._transaction(operation)
