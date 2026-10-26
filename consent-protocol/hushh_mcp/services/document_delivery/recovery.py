"""Paid-package key amendment; neither a new purchase nor a new copy consent."""

import json
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
    digest,
    key_fingerprint,
    package_commitment,
)


def proven_recovery_key(store, connection, contract):
    row = store._row(
        connection,
        """SELECT k.* FROM document_delivery_key_challenges p
      JOIN document_delivery_public_keys k ON k.user_id=p.user_id AND k.key_id=p.key_id
      JOIN one_kyc_client_connectors r ON r.user_id=k.user_id AND r.connector_key_id=k.key_id AND r.status='active'
      WHERE p.request_id=:request AND p.user_id=:user AND p.purpose='recovery'
      AND p.verified_at IS NOT NULL AND p.verified_at>clock_timestamp()-INTERVAL '30 minutes'
      AND k.fingerprint=p.fingerprint ORDER BY p.verified_at DESC LIMIT 1""",
        {"request": contract["request_id"], "user": contract["recipient_user_id"]},
    )
    if row is None:
        return None
    registry = store._row(
        connection,
        """SELECT connector_public_key FROM one_kyc_client_connectors
      WHERE user_id=:user AND connector_key_id=:key AND status='active' FOR SHARE""",
        {"user": row["user_id"], "key": row["key_id"]},
    )
    if registry is None or key_fingerprint(registry["connector_public_key"]) != row["fingerprint"]:
        return None
    return {
        "connectorKeyId": row["key_id"],
        "connectorPublicKey": row["public_key"],
        "connectorWrappingAlg": "X25519-AES256-GCM",
        "publicKeyFingerprint": row["fingerprint"],
    }


async def owner_package(store, *, request_id, actor):
    from hushh_mcp.services.document_delivery.store import iso

    def operation(connection):
        request, contract = store._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        package = store._paid(connection, request, contract)
        binding = store._row(
            connection,
            "SELECT * FROM document_delivery_financial_bindings WHERE request_id=:request",
            {"request": request_id},
        )
        return {
            "terms": package["terms"],
            "termsDigest": package["terms_digest"],
            "packageDigest": package["package_digest"],
            "originalTermsDigest": binding["original_terms_digest"],
            "originalPackageDigest": binding["original_package_digest"],
            "preparationDigest": package["preparation_digest"],
            "contentCommitment": package["content_commitment"],
            "accessExpiresAt": iso(contract["access_expires_at"]),
            "artifacts": package["artifacts"],
            "wraps": [item for item in package["wraps"] if item["role"] == "owner_recovery"],
            "wrapDigests": [
                {"artifactId": item["artifactId"], "role": item["role"], "sha256": digest(item)}
                for item in sorted(
                    package["wraps"], key=lambda item: (item["artifactId"], item["role"])
                )
            ],
        }

    return await store._transaction(operation)


def _validated_amendment(store, connection, contract, package, body):
    key = proven_recovery_key(store, connection, contract)
    if key is None or key["connectorKeyId"] == contract["recipient_key_id"]:
        raise DeliveryError("recovery_key_proof_required")
    terms = body.terms.wire()
    expected = {
        **package["terms"],
        "revision": contract["revision"] + 1,
        "recipientKeyId": key["connectorKeyId"],
        "recipientKeyFingerprint": key["publicKeyFingerprint"],
    }
    if terms != expected or digest(terms) != body.termsDigest:
        raise DeliveryError("recovery_terms_changed", 422)
    wraps = [item.wire() for item in body.wraps]
    old_recovery = {
        item["artifactId"]: item for item in package["wraps"] if item["role"] == "owner_recovery"
    }
    expected_set = {
        (item["artifactId"], role)
        for item in package["artifacts"]
        for role in ("recipient", "owner_recovery")
    }
    if (
        len(wraps) != len(expected_set)
        or {(item["artifactId"], item["role"]) for item in wraps} != expected_set
    ):
        raise DeliveryError("wrap_set_mismatch", 422)
    for item in wraps:
        if item["role"] == "owner_recovery" and old_recovery[item["artifactId"]] != item:
            raise DeliveryError("owner_recovery_envelope_changed", 422)
        if item["role"] == "recipient" and (
            item["recipientKeyId"] != key["connectorKeyId"]
            or item["recipientKeyFingerprint"] != key["publicKeyFingerprint"]
        ):
            raise DeliveryError("recipient_wrap_mismatch", 422)
    if (
        package_commitment(package["content_commitment"], body.termsDigest, wraps)
        != body.packageDigest
    ):
        raise DeliveryError("package_commitment_mismatch", 422)
    return key, terms, wraps


async def amend(store, *, request_id, actor, body):
    def operation(connection):
        request, contract = store._locked(
            connection, request_id=request_id, actor=actor, owner_only=True
        )
        replay = store._idempotent(
            connection, request_id, body.idempotencyKey, "recovery", body.wire()
        )
        if replay is not None:
            return replay
        store._revision(contract, body.expectedRevision)
        package = store._paid(connection, request, contract)
        binding = store._row(
            connection,
            "SELECT * FROM document_delivery_financial_bindings WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        if (
            body.originalTermsDigest != binding["original_terms_digest"]
            or body.originalPackageDigest != binding["original_package_digest"]
        ):
            raise DeliveryError("original_payment_binding_changed")
        key, terms, wraps = _validated_amendment(store, connection, contract, package, body)
        package_id = str(uuid4())
        connection.execute(
            text("""INSERT INTO document_delivery_packages
          (package_id,request_id,revision,generation_id,preparation_digest,content_commitment,terms,terms_digest,
           package_digest,artifacts,wraps,amendment_of)
          VALUES(:id,:request,:revision,:generation,:preparation,:content,CAST(:terms AS jsonb),:td,:pd,
           CAST(:artifacts AS jsonb),CAST(:wraps AS jsonb),:prior)"""),
            {
                "id": package_id,
                "request": request_id,
                "revision": terms["revision"],
                "generation": package["generation_id"],
                "preparation": package["preparation_digest"],
                "content": package["content_commitment"],
                "terms": json.dumps(terms),
                "td": body.termsDigest,
                "pd": body.packageDigest,
                "artifacts": json.dumps(package["artifacts"]),
                "wraps": json.dumps(wraps),
                "prior": package["package_id"],
            },
        )
        connection.execute(
            text("""UPDATE document_delivery_contracts SET revision=revision+1,current_package_id=:id,
          recipient_key_id=:key,recipient_key_fingerprint=:fp,accepted_terms_digest=:td,accepted_package_digest=:pd,
          updated_at=clock_timestamp() WHERE request_id=:request"""),
            {
                "id": package_id,
                "key": key["connectorKeyId"],
                "fp": key["publicKeyFingerprint"],
                "td": body.termsDigest,
                "pd": body.packageDigest,
                "request": request_id,
            },
        )
        # The new key was B's explicit possession proof, A now authorizes only
        # its rewrap. Original financial T/D and provider grant version remain.
        request, current = store._locked(connection, request_id=request_id, actor=actor)
        return store._result(
            connection,
            request_id,
            body.idempotencyKey,
            store._projection(connection, request, current, actor),
        )

    return await store._transaction(operation)
