"""Document delivery orchestration. Provider access here releases a token only.

Original reads, PDF transformation and file-key generation are exclusively on
the owner's device. All object-store traffic carries opaque ciphertext.
"""

from __future__ import annotations

import base64
import hashlib
import secrets

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.document_delivery.contracts import (
    ACTIVITY_DISCLOSURE,
    COPY_DISCLOSURE,
    MAX_CIPHERTEXT_BYTES,
    MAX_FILE_BYTES,
    MAX_REQUEST_BYTES,
    ChallengeIssue,
    DeliveryError,
    decoded,
)
from hushh_mcp.services.document_delivery.storage import configured_objects
from hushh_mcp.services.document_delivery.store import DocumentDeliveryStore
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service


class DocumentDeliveryService:
    def __init__(self, *, store=None, objects=None, oauth=None):
        self.store = store or DocumentDeliveryStore()
        self._objects = objects
        self.oauth = oauth

    @property
    def objects(self):
        if self._objects is None:
            self._objects = configured_objects()
        return self._objects

    async def readiness(self, *, actor):
        ready = False
        if connector_feature_enabled("protected_document_delivery", actor):
            try:
                from hushh_mcp.services.drive_request_payment_service import (
                    require_payment_configuration,
                )

                require_payment_configuration()
                await self.objects.qualify()
                self.store.sharing_cipher._key()
                self.store.cipher._key()
                ready = await self.store._transaction(self.store.schema_ready)
            except Exception:
                ready = False
        return {
            "enabled": ready,
            "supportedMimeTypes": ["application/pdf"],
            "maxFileBytes": MAX_FILE_BYTES,
            "maxRequestCiphertextBytes": MAX_REQUEST_BYTES,
            "maxFiles": 25,
            "activityDisclosureVersion": ACTIVITY_DISCLOSURE,
            "copyDisclosureVersion": COPY_DISCLOSURE,
            "nativeViewerEnabled": False,
        }

    async def create(self, *, requester, owner, body, google_recipient=None):
        if (
            not (await self.readiness(actor=requester))["enabled"]
            or not (await self.readiness(actor=owner))["enabled"]
        ):
            raise DeliveryError("delivery_unavailable", 503)
        from hushh_mcp.services.drive_request_payment_service import require_payment_configuration
        from hushh_mcp.services.drive_sharing_contract import DriveSharingError

        try:
            require_payment_configuration()
        except DriveSharingError:
            raise DeliveryError("delivery_unavailable", 503) from None
        return await self.store.create(
            requester=requester, owner=owner, body=body, google_recipient=google_recipient
        )

    async def source_session(self, *, request_id, actor, expected_revision):
        authority = await self.store.source_authority(
            request_id=request_id, actor=actor, expected_revision=expected_revision
        )
        oauth = self.oauth or get_external_connector_oauth_service().drive()
        row, credential = await oauth.current_credential(user_id=actor, required_profile="selected")
        if row["connection_generation"] != authority["connectionGeneration"]:
            raise DeliveryError("source_connection_changed")
        await self.store.source_authority(
            request_id=request_id, actor=actor, expected_revision=expected_revision
        )
        return {
            **authority,
            "accessToken": credential["accessToken"],
            "tokenExpiresAt": credential["expiresAt"],
        }

    async def owner_package(self, *, request_id, actor):
        from hushh_mcp.services.document_delivery.recovery import owner_package

        return await owner_package(self.store, request_id=request_id, actor=actor)

    async def recovery_amendment(self, *, request_id, actor, body):
        from hushh_mcp.services.document_delivery.recovery import amend

        return await amend(self.store, request_id=request_id, actor=actor, body=body)

    async def challenge(self, *, request_id, actor, body):
        if not isinstance(body, ChallengeIssue):
            return await self.store.verify_challenge(
                request_id=request_id,
                actor=actor,
                challenge_id=body.challengeId,
                plaintext=body.plaintext,
            )
        nonce = secrets.token_hex(32)
        result = await self.store.issue_challenge(
            request_id=request_id,
            actor=actor,
            key_id=body.recipientKeyId,
            fingerprint=body.recipientKeyFingerprint,
            nonce_hash=hashlib.sha256(nonce.encode()).hexdigest(),
            purpose=body.purpose,
        )
        ephemeral = X25519PrivateKey.generate()
        shared = ephemeral.exchange(
            X25519PublicKey.from_public_bytes(
                decoded(result["key"]["connectorPublicKey"], length=32)
            )
        )
        iv = secrets.token_bytes(12)
        ciphertext = AESGCM(hashlib.sha256(shared).digest()).encrypt(iv, bytes.fromhex(nonce), None)

        def encode(value):
            return base64.b64encode(value).decode()

        return {
            "phase": "issued",
            "challengeId": result["challengeId"],
            "expiresAt": result["expiresAt"],
            "bundle": {
                "wrappedExportKey": encode(ciphertext[:-16]),
                "wrappedKeyIv": encode(iv),
                "wrappedKeyTag": encode(ciphertext[-16:]),
                "senderPublicKey": encode(
                    ephemeral.public_key().public_bytes(
                        serialization.Encoding.Raw, serialization.PublicFormat.Raw
                    )
                ),
                "wrappingAlg": "X25519-AES256-GCM",
                "connectorKeyId": body.recipientKeyId,
            },
        }

    async def reserve_upload(self, *, request_id, actor, body):
        await self.objects.qualify()
        return await self.store.reserve_upload(
            request_id=request_id, actor=actor, body=body, bucket_identity=self.objects.identity
        )

    async def upload(self, *, request_id, actor, upload_id, ciphertext):
        row = await self.store.upload_authority(
            request_id=request_id, actor=actor, upload_id=upload_id, claim=True
        )
        descriptor = row["descriptor"]
        if (
            len(ciphertext) != descriptor["ciphertextBytes"]
            or hashlib.sha256(ciphertext).hexdigest() != descriptor["ciphertextSha256"]
        ):
            # A malformed attempt is fenced. An exact retry reconciles before writing.
            await self.store.upload_result(request_id=request_id, actor=actor, upload_id=upload_id)
            raise DeliveryError("ciphertext_integrity_mismatch", 422)
        if row["bucket_identity"] != self.objects.identity:
            raise DeliveryError("delivery_storage_changed", 503)
        try:
            # Unknown writes reconcile their exact durable resumable session;
            # an absent object alone never authorizes a second payload POST.
            prior, generation = await self.objects.read(
                row["object_key"], limit=MAX_CIPHERTEXT_BYTES
            )
            if prior is None:
                if row["write_dispatched_at"] is not None and row["write_settled_at"] is None:
                    raise DeliveryError("upload_outcome_unknown")
                session = self.store.upload_session(row)
                if session is None:
                    session = await self.objects.initiate(row["object_key"], len(ciphertext))
                    try:
                        await self.store.attach_upload_session(
                            request_id=request_id, actor=actor, upload_id=upload_id, session=session
                        )
                    except BaseException:
                        # No payload has been sent. Best-effort invalidation of
                        # the empty session conveys no file removal claim.
                        await self.objects.session_terminal(
                            session, row["object_key"], len(ciphertext), None
                        )
                        raise
                row = await self.store.dispatch_upload(
                    request_id=request_id, actor=actor, upload_id=upload_id
                )
                generation = await self.objects.send(session, row["object_key"], ciphertext)
            elif prior != ciphertext:
                raise DeliveryError("artifact_write_conflict")
        except BaseException:
            await self.store.upload_result(request_id=request_id, actor=actor, upload_id=upload_id)
            raise
        result = await self.store.upload_result(
            request_id=request_id, actor=actor, upload_id=upload_id, generation=generation
        )
        if result is None:
            raise DeliveryError("upload_authority_ended")
        return {"uploaded": True}

    async def finalize(self, *, request_id, actor, upload_id):
        row = await self.store.upload_authority(
            request_id=request_id, actor=actor, upload_id=upload_id
        )
        if row["bucket_identity"] != self.objects.identity:
            raise DeliveryError("delivery_storage_changed", 503)
        ciphertext, generation = await self.objects.read(
            row["object_key"], limit=MAX_CIPHERTEXT_BYTES
        )
        if (
            ciphertext is None
            or len(ciphertext) != row["descriptor"]["ciphertextBytes"]
            or hashlib.sha256(ciphertext).hexdigest() != row["descriptor"]["ciphertextSha256"]
        ):
            raise DeliveryError("ciphertext_integrity_mismatch", 422)
        if row["object_generation"] is not None and row["object_generation"] != generation:
            raise DeliveryError("artifact_generation_changed")
        result = await self.store.upload_result(
            request_id=request_id,
            actor=actor,
            upload_id=upload_id,
            generation=generation,
            finalized=True,
        )
        if result is None:
            raise DeliveryError("upload_authority_ended")
        return result

    async def artifact(self, *, request_id, actor, artifact_id):
        row = await self.store.artifact_authority(
            request_id=request_id, actor=actor, artifact_id=artifact_id
        )
        if row["bucket_identity"] != self.objects.identity:
            raise DeliveryError("delivery_storage_changed", 503)
        ciphertext, generation = await self.objects.read(
            row["object_key"], limit=MAX_CIPHERTEXT_BYTES
        )
        if (
            ciphertext is None
            or generation != row["object_generation"]
            or len(ciphertext) != row["descriptor"]["ciphertextBytes"]
            or hashlib.sha256(ciphertext).hexdigest() != row["descriptor"]["ciphertextSha256"]
        ):
            raise DeliveryError("ciphertext_integrity_mismatch", 503)
        # Recheck entitlement after storage I/O; an already-returning response
        # may finish after revoke, exactly as a previously saved copy can.
        await self.store.artifact_authority(
            request_id=request_id, actor=actor, artifact_id=artifact_id, served=True
        )
        return ciphertext

    async def cleanup(self, *, limit=10):
        from .cleanup import cleanup

        return await cleanup(self, limit=limit)
