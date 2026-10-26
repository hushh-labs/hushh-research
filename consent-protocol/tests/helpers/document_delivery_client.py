"""Real client envelope, upload, possession proof and signed payment test phases."""

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    ChallengeIssue,
    FinalApproval,
    Package,
    Prepare,
    Upload,
    canonical,
    content_commitment,
    digest,
    key_fingerprint,
    package_commitment,
)
from hushh_mcp.services.document_delivery.store import iso


def b64(value):
    return base64.b64encode(value).decode()


async def signed_payment_callback(system, request_id, *, payment_intent="pi_test_bound"):
    """Production signature verifier and settlement SQL; no paid-row shortcut."""
    from tests.services.test_drive_request_payment import _signed_event

    with system.db.engine.connect() as connection:
        order = (
            connection.execute(
                text("SELECT * FROM drive_request_payment_orders WHERE request_id=:id"),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
    payload, signature = _signed_event(
        request_id,
        amount=order["amount_cents"],
        session_id=order["stripe_checkout_session_id"],
        attempt_id=str(order["checkout_attempt_id"]),
        payment_intent=payment_intent,
    )
    await system.payment.process_webhook(payload=payload, signature=signature)
    return payload, signature


async def prove_key(
    system, request_id, *, private=None, key_id="key-test", public=None, purpose="delivery"
):
    private, public = private or system.private, public or system.public
    issued = await system.service.challenge(
        request_id=request_id,
        actor="recipient",
        body=ChallengeIssue.model_validate(
            {
                "phase": "issue",
                "recipientKeyId": key_id,
                "recipientKeyFingerprint": key_fingerprint(public),
                "purpose": purpose,
            }
        ),
    )
    bundle = issued["bundle"]
    shared = private.exchange(
        X25519PublicKey.from_public_bytes(base64.b64decode(bundle["senderPublicKey"]))
    )
    plaintext = AESGCM(hashlib.sha256(shared).digest()).decrypt(
        base64.b64decode(bundle["wrappedKeyIv"]),
        base64.b64decode(bundle["wrappedExportKey"]) + base64.b64decode(bundle["wrappedKeyTag"]),
        None,
    )
    from hushh_mcp.services.document_delivery.contracts import ChallengeVerify

    verified = await system.service.challenge(
        request_id=request_id,
        actor="recipient",
        body=ChallengeVerify.model_validate(
            {"phase": "verify", "challengeId": issued["challengeId"], "plaintext": plaintext.hex()}
        ),
    )
    return verified


async def new_request(system, mode="one"):
    from hushh_mcp.services.drive_sharing_contract import VerifiedGoogleRecipient

    return await system.store.create(
        requester="recipient",
        owner="owner",
        google_recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
        )
        if mode == "both"
        else None,
        body={
            "version": 1,
            "ownerUserId": "owner",
            "ownerPersonRef": None,
            "clientRequestId": str(uuid4()),
            "purpose": {"purpose": "Statements", "periodStart": None, "periodEnd": None},
            "reason": "",
            "accessDays": 30,
            "requesterActorType": "person",
            "timeZone": None,
            "expectedQuoteVersion": None,
            "receiveThrough": mode,
            "activityDisclosureVersion": "one-document-activity-v1",
            "activityAccepted": True,
            "recipientKeyId": "key-test",
            "recipientKeyFingerprint": key_fingerprint(system.public),
        },
    )


def recipient_wrap(public, artifact_id, key, terms, content, key_id="key-test"):
    ephemeral = X25519PrivateKey.generate()
    wrapping = hashlib.sha256(
        ephemeral.exchange(X25519PublicKey.from_public_bytes(base64.b64decode(public)))
    ).digest()
    iv = secrets.token_bytes(12)
    fingerprint = key_fingerprint(public)
    aad = canonical(
        {
            "version": 1,
            "purpose": "one-document-recipient-key",
            "contentCommitment": content,
            "termsDigest": terms,
            "artifactId": artifact_id,
            "recipientUserId": "recipient",
            "recipientKeyId": key_id,
            "recipientKeyFingerprint": fingerprint,
        }
    )
    ciphertext = AESGCM(wrapping).encrypt(iv, key, aad)
    return {
        "artifactId": artifact_id,
        "role": "recipient",
        "recipientKeyId": key_id,
        "recipientKeyFingerprint": fingerprint,
        "bundle": {
            "wrappedExportKey": b64(ciphertext[:-16]),
            "wrappedKeyIv": b64(iv),
            "wrappedKeyTag": b64(ciphertext[-16:]),
            "senderPublicKey": b64(
                ephemeral.public_key().public_bytes(
                    serialization.Encoding.Raw, serialization.PublicFormat.Raw
                )
            ),
            "wrappingAlg": "X25519-AES256-GCM",
            "connectorKeyId": key_id,
        },
    }


async def prepare_copy_source(system, request_id, amount):
    projection = await system.store.source_selection(request_id=request_id, actor="owner")
    prepare_body = Prepare.model_validate(
        {
            "phase": "prepare",
            "expectedRevision": 0,
            "idempotencyKey": str(uuid4()),
            "selectedFiles": projection["files"],
            "copyDisclosureVersion": "one-document-copy-v1",
            "copyAccepted": True,
            "amountCents": amount,
            "accessExpiresAt": iso(datetime.now(UTC) + timedelta(days=1)),
        }
    )
    prepared = await system.store.approve(
        request_id=request_id,
        actor="owner",
        body=prepare_body,
    )
    return prepare_body, prepared


async def encrypt_and_upload_copy_artifacts(system, request_id, prepared):
    artifacts, keys, raw = [], {}, {}
    for role in ("original", "watermarked", "manifest"):
        artifact_id, key, iv = str(uuid4()), secrets.token_bytes(32), secrets.token_bytes(12)
        file_ref = None if role == "manifest" else prepared["files"][0]["fileRef"]
        plaintext = b"Private client PDF bytes" if role != "manifest" else b'{"files":[]}'
        aad = canonical(
            {
                "version": 1,
                "purpose": "one-document-content",
                "preparationDigest": prepared["preparationDigest"],
                "artifactId": artifact_id,
                "fileRef": file_ref,
                "role": role,
            }
        )
        ciphertext = AESGCM(key).encrypt(iv, plaintext, aad)
        descriptor = {
            "artifactId": artifact_id,
            "fileRef": file_ref,
            "role": role,
            "iv": b64(iv),
            "plaintextBytes": len(plaintext),
            "ciphertextBytes": len(ciphertext),
            "ciphertextSha256": hashlib.sha256(ciphertext).hexdigest(),
        }
        reserved = await system.service.reserve_upload(
            request_id=request_id,
            actor="owner",
            body=Upload.model_validate(
                {"expectedRevision": 1, "idempotencyKey": str(uuid4()), "descriptor": descriptor}
            ),
        )
        await system.service.upload(
            request_id=request_id,
            actor="owner",
            upload_id=reserved["uploadId"],
            ciphertext=ciphertext,
        )
        await system.service.finalize(
            request_id=request_id, actor="owner", upload_id=reserved["uploadId"]
        )
        artifacts.append(descriptor)
        keys[artifact_id], raw[artifact_id] = key, ciphertext
    return artifacts, keys, raw


def copy_package(system, request_id, amount, prepared, artifacts, keys):
    content = content_commitment(prepared["preparationDigest"], artifacts)
    terms = {
        "version": 1,
        "revision": 1,
        "requestId": request_id,
        "ownerUserId": "owner",
        "recipientUserId": "recipient",
        "receiveThrough": prepared["receiveThrough"],
        "contentCommitment": content,
        "amountCents": amount,
        "currency": "usd",
        "accessExpiresAt": prepared["accessExpiresAt"],
        "rights": {"preview": True, "download": True},
        "activityDisclosureVersion": "one-document-activity-v1",
        "copyDisclosureVersion": "one-document-copy-v1",
        "recipientKeyId": "key-test",
        "recipientKeyFingerprint": key_fingerprint(system.public),
    }
    terms_digest = digest(terms)
    wraps = []
    for item in artifacts:
        wraps.append(
            recipient_wrap(
                system.public, item["artifactId"], keys[item["artifactId"]], terms_digest, content
            )
        )
        wraps.append(
            {
                "artifactId": item["artifactId"],
                "role": "owner_recovery",
                "bundle": {
                    "ciphertext": b64(secrets.token_bytes(64)),
                    "iv": b64(secrets.token_bytes(12)),
                    "tag": b64(secrets.token_bytes(16)),
                },
            }
        )
    package = {
        "expectedRevision": 1,
        "idempotencyKey": str(uuid4()),
        "generationId": prepared["generationId"],
        "preparationDigest": prepared["preparationDigest"],
        "contentCommitment": content,
        "artifacts": artifacts,
        "terms": terms,
        "termsDigest": terms_digest,
        "wraps": wraps,
        "packageDigest": package_commitment(content, terms_digest, wraps),
    }
    return package


async def stage(system, request_id, amount=2500, publish=True):
    prepare_body, prepared = await prepare_copy_source(system, request_id, amount)
    artifacts, keys, raw = await encrypt_and_upload_copy_artifacts(system, request_id, prepared)
    package = copy_package(system, request_id, amount, prepared, artifacts, keys)
    if not publish:
        return SimpleNamespace(
            package=package, raw=raw, keys=keys, prepare_body=prepare_body, prepared=prepared
        )
    await system.store.stage_package(
        request_id=request_id, actor="owner", body=Package.model_validate(package)
    )
    await system.store.approve(
        request_id=request_id,
        actor="owner",
        body=FinalApproval.model_validate(
            {
                "phase": "final",
                "expectedRevision": 1,
                "idempotencyKey": str(uuid4()),
                "termsDigest": package["termsDigest"],
                "packageDigest": package["packageDigest"],
            }
        ),
    )
    return SimpleNamespace(
        package=package, raw=raw, keys=keys, prepare_body=prepare_body, prepared=prepared
    )


async def pay(system, request_id, package):
    await prove_key(system, request_id)
    await system.payment.checkout(
        requester_user_id="recipient",
        request_id=request_id,
        accepted_contract={
            "acceptedTermsRevision": package["terms"]["revision"],
            "acceptedTermsDigest": package["termsDigest"],
            "acceptedPackageDigest": package["packageDigest"],
        },
    )
    system.provider.charge["transfer_group"] = f"drive-request-{request_id}"
    await signed_payment_callback(system, request_id)


async def assert_local_watermarked_read(system, request_id, released, delivery_app):
    descriptor = next(item for item in released["artifacts"] if item["role"] == "watermarked")
    envelope = next(
        item for item in released["wraps"] if item["artifactId"] == descriptor["artifactId"]
    )
    bundle = envelope["bundle"]
    shared = system.private.exchange(
        X25519PublicKey.from_public_bytes(base64.b64decode(bundle["senderPublicKey"]))
    )
    aad = canonical(
        {
            "version": 1,
            "purpose": "one-document-recipient-key",
            "contentCommitment": released["contentCommitment"],
            "termsDigest": released["termsDigest"],
            "artifactId": descriptor["artifactId"],
            "recipientUserId": "recipient",
            "recipientKeyId": "key-test",
            "recipientKeyFingerprint": key_fingerprint(system.public),
        }
    )
    key = AESGCM(hashlib.sha256(shared).digest()).decrypt(
        base64.b64decode(bundle["wrappedKeyIv"]),
        base64.b64decode(bundle["wrappedExportKey"]) + base64.b64decode(bundle["wrappedKeyTag"]),
        aad,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        response = await client.get(
            f"/api/connectors/google_drive/sharing/requests/{request_id}/delivery/artifacts/{descriptor['artifactId']}",
            headers={"Authorization": "recipient"},
        )
        assert response.status_code == 200
        assert "no-store" in response.headers["cache-control"]
    content_aad = canonical(
        {
            "version": 1,
            "purpose": "one-document-content",
            "preparationDigest": released["preparationDigest"],
            "artifactId": descriptor["artifactId"],
            "fileRef": descriptor["fileRef"],
            "role": descriptor["role"],
        }
    )
    assert (
        AESGCM(key).decrypt(base64.b64decode(descriptor["iv"]), response.content, content_aad)
        == b"Private client PDF bytes"
    )
