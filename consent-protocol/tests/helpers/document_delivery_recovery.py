"""Owner-only recovery, replacement proof and immutable payment assertion phases."""

import hashlib
from uuid import uuid4

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
    digest,
    key_fingerprint,
    package_commitment,
)
from tests.helpers.document_delivery_client import (
    b64,
    prove_key,
    recipient_wrap,
)


async def read_owner_recovery_package(system, request_id, staged, delivery_app):
    with pytest.raises(DeliveryError, match="request_unavailable"):
        await system.service.owner_package(request_id=request_id, actor="recipient")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        response = await client.get(
            f"/api/connectors/google_drive/sharing/requests/{request_id}/delivery/owner-package",
            headers={"Authorization": "owner"},
        )
    assert response.status_code == 200
    assert "no-store" in response.headers["cache-control"]
    owner_package = response.json()
    assert set(owner_package) == {
        "terms",
        "termsDigest",
        "packageDigest",
        "originalTermsDigest",
        "originalPackageDigest",
        "preparationDigest",
        "contentCommitment",
        "artifacts",
        "wraps",
        "wrapDigests",
        "accessExpiresAt",
    }
    assert owner_package["accessExpiresAt"] == staged.package["terms"]["accessExpiresAt"]
    assert owner_package["accessExpiresAt"] == owner_package["terms"]["accessExpiresAt"]
    expected_digests = [
        {"artifactId": item["artifactId"], "role": item["role"], "sha256": digest(item)}
        for item in sorted(
            staged.package["wraps"], key=lambda item: (item["artifactId"], item["role"])
        )
    ]
    assert owner_package["wrapDigests"] == expected_digests
    assert (
        digest(
            {
                "version": 1,
                "contentCommitment": owner_package["contentCommitment"],
                "termsDigest": owner_package["termsDigest"],
                "wraps": owner_package["wrapDigests"],
            }
        )
        == owner_package["packageDigest"]
    )
    assert owner_package["wraps"] == [
        item for item in staged.package["wraps"] if item["role"] == "owner_recovery"
    ]
    assert len(owner_package["wraps"]) == len(owner_package["artifacts"])
    for envelope in owner_package["wraps"]:
        assert {
            "artifactId": envelope["artifactId"],
            "role": "owner_recovery",
            "sha256": digest(envelope),
        } in owner_package["wrapDigests"]
    return owner_package


async def prove_replacement_key(system, request_id):
    replacement = X25519PrivateKey.generate()
    public = b64(
        replacement.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
    )
    with system.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE one_kyc_client_connectors SET status='rotated' WHERE user_id='recipient'")
        )
        connection.execute(
            text("""INSERT INTO one_kyc_client_connectors(user_id,connector_key_id,connector_public_key,public_key_fingerprint)
          VALUES('recipient','replacement-key',:public,:legacy)"""),
            {"public": public, "legacy": hashlib.sha256(public.encode()).hexdigest()},
        )
    await prove_key(
        system,
        request_id,
        private=replacement,
        public=public,
        key_id="replacement-key",
        purpose="recovery",
    )
    assert (await system.store.projection(request_id=request_id, actor="owner"))[
        "recoveryRequested"
    ] is True
    key = await system.store.recipient_key(request_id=request_id, actor="owner", purpose="recovery")
    assert key["publicKeyFingerprint"] == key_fingerprint(public)
    return public


def replacement_amendment(owner_package, staged, public):
    terms = {
        **owner_package["terms"],
        "revision": 2,
        "recipientKeyId": "replacement-key",
        "recipientKeyFingerprint": key_fingerprint(public),
    }
    td = digest(terms)
    wraps = list(owner_package["wraps"]) + [
        recipient_wrap(
            public,
            item["artifactId"],
            staged.keys[item["artifactId"]],
            td,
            owner_package["contentCommitment"],
            key_id="replacement-key",
        )
        for item in owner_package["artifacts"]
    ]
    body = {
        "expectedRevision": 1,
        "idempotencyKey": str(uuid4()),
        "originalTermsDigest": owner_package["originalTermsDigest"],
        "originalPackageDigest": owner_package["originalPackageDigest"],
        "terms": terms,
        "termsDigest": td,
        "wraps": wraps,
        "packageDigest": package_commitment(owner_package["contentCommitment"], td, wraps),
        "recoveryAccepted": True,
    }
    return terms, body


async def assert_recovery_provenance(system, request_id, staged, owner_package, mode):
    recovered = await system.store.release(request_id=request_id, actor="recipient")
    assert recovered["terms"]["recipientKeyId"] == "replacement-key"
    assert recovered["contentCommitment"] == staged.package["contentCommitment"]
    amended_owner_package = await system.service.owner_package(request_id=request_id, actor="owner")
    assert amended_owner_package["wraps"] == owner_package["wraps"]
    assert amended_owner_package["artifacts"] == owner_package["artifacts"]
    assert amended_owner_package["accessExpiresAt"] == owner_package["accessExpiresAt"]
    assert amended_owner_package["originalTermsDigest"] == staged.package["termsDigest"]
    assert amended_owner_package["originalPackageDigest"] == staged.package["packageDigest"]
    assert amended_owner_package["packageDigest"] != owner_package["packageDigest"]
    assert (
        digest(
            {
                "version": 1,
                "contentCommitment": amended_owner_package["contentCommitment"],
                "termsDigest": amended_owner_package["termsDigest"],
                "wraps": amended_owner_package["wrapDigests"],
            }
        )
        == amended_owner_package["packageDigest"]
    )
    with system.db.engine.connect() as connection:
        binding = (
            connection.execute(text("SELECT * FROM document_delivery_financial_bindings"))
            .mappings()
            .one()
        )
        assert binding["original_terms_digest"] == staged.package["termsDigest"]
        assert binding["original_package_digest"] == staged.package["packageDigest"]
        assert (
            connection.execute(text("SELECT COUNT(*) FROM drive_request_payment_orders")).scalar()
            == 1
        )
        assert (
            connection.execute(text("SELECT COUNT(*) FROM drive_request_owner_payouts")).scalar()
            == 1
        )
        operation = connection.execute(
            text(
                "SELECT operation_id FROM drive_share_permission_operations WHERE request_id=:request AND kind='grant'"
            ),
            {"request": request_id},
        ).scalar()
    if mode == "both":
        from hushh_mcp.services.drive_permission_store import DrivePermissionStore

        # Recovery cannot invalidate the exact original paid Google grant.
        assert (
            await DrivePermissionStore(db=system.db).claim_grant(
                user_id="owner", operation_id=str(operation)
            )
            is not None
        )
