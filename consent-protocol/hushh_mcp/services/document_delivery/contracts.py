"""Frozen document-copy wire. This module never handles a plaintext file key."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

ACTIVITY_DISCLOSURE = "one-document-activity-v1"
COPY_DISCLOSURE = "one-document-copy-v1"
MAX_FILE_BYTES = 4_194_304
MAX_CIPHERTEXT_BYTES = MAX_FILE_BYTES + 131_072
MAX_REQUEST_BYTES = 33_554_432
Hash = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
KeyId = Annotated[str, Field(pattern=r"^[A-Za-z0-9._:-]{3,120}$")]


class DeliveryError(RuntimeError):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code, self.status = code, status


class StrictWire(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    def wire(self) -> dict:
        return self.model_dump(mode="json")


def canonical(value: object) -> bytes:
    def check(item):
        if item is None or type(item) in (str, bool, int):
            return
        if isinstance(item, list):
            for child in item:
                check(child)
            return
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str) or not key.isascii():
                    raise DeliveryError("invalid_commitment", 422)
                check(child)
            return
        raise DeliveryError("invalid_commitment", 422)

    check(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def decoded(value: str, *, length: int | None = None) -> bytes:
    try:
        raw = base64.b64decode(value, validate=True)
        if base64.b64encode(raw).decode() != value or (length is not None and len(raw) != length):
            raise ValueError
        return raw
    except (ValueError, TypeError):
        raise DeliveryError("invalid_encoding", 422) from None


def key_fingerprint(public_key: str) -> str:
    return hashlib.sha256(decoded(public_key, length=32)).hexdigest()


class SelectedFile(StrictWire):
    fileRef: str = Field(pattern=r"^[0-9a-f-]{36}$")
    documentId: str = Field(pattern=r"^[0-9a-f-]{36}$")
    providerFileId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,200}$")
    name: str = Field(min_length=1, max_length=255)
    mimeType: Literal["application/pdf"]
    size: int = Field(ge=1, le=MAX_FILE_BYTES)
    sourceRevision: str = Field(min_length=1, max_length=200)
    sourceSha256: Hash | None

    @model_validator(mode="after")
    def ids(self):
        if str(UUID(self.fileRef)) != self.fileRef or str(UUID(self.documentId)) != self.documentId:
            raise ValueError("Canonical UUID required")
        return self


class Artifact(StrictWire):
    artifactId: str = Field(pattern=r"^[0-9a-f-]{36}$")
    fileRef: str | None
    role: Literal["original", "watermarked", "manifest"]
    iv: str
    plaintextBytes: int = Field(ge=1, le=MAX_FILE_BYTES)
    ciphertextBytes: int = Field(ge=17, le=MAX_CIPHERTEXT_BYTES)
    ciphertextSha256: Hash

    @model_validator(mode="after")
    def encoding(self):
        if str(UUID(self.artifactId)) != self.artifactId:
            raise ValueError("Canonical UUID required")
        if (self.role == "manifest") != (self.fileRef is None):
            raise ValueError("Manifest alone has no file reference")
        if self.fileRef is not None and str(UUID(self.fileRef)) != self.fileRef:
            raise ValueError("Canonical UUID required")
        decoded(self.iv, length=12)
        if self.ciphertextBytes != self.plaintextBytes + 16:
            raise ValueError("AES-GCM length mismatch")
        return self


class Rights(StrictWire):
    preview: Literal[True]
    download: Literal[True]


class Terms(StrictWire):
    version: Literal[1]
    revision: int = Field(ge=1)
    requestId: str
    ownerUserId: str
    recipientUserId: str
    receiveThrough: Literal["one", "both"]
    contentCommitment: Hash
    amountCents: int = Field(ge=50, le=50000)
    currency: Literal["usd"]
    accessExpiresAt: str | None
    rights: Rights
    activityDisclosureVersion: Literal["one-document-activity-v1"]
    copyDisclosureVersion: Literal["one-document-copy-v1"]
    recipientKeyId: KeyId
    recipientKeyFingerprint: Hash


class WrappedKey(StrictWire):
    wrappedExportKey: str
    wrappedKeyIv: str
    wrappedKeyTag: str
    senderPublicKey: str
    wrappingAlg: Literal["X25519-AES256-GCM"]
    connectorKeyId: KeyId

    @model_validator(mode="after")
    def encoding(self):
        decoded(self.wrappedExportKey, length=32)
        decoded(self.wrappedKeyIv, length=12)
        decoded(self.wrappedKeyTag, length=16)
        decoded(self.senderPublicKey, length=32)
        return self


class RecipientWrap(StrictWire):
    artifactId: str
    role: Literal["recipient"]
    recipientKeyId: KeyId
    recipientKeyFingerprint: Hash
    bundle: WrappedKey

    @model_validator(mode="after")
    def key_id(self):
        if self.bundle.connectorKeyId != self.recipientKeyId:
            raise ValueError("Key mismatch")
        return self


class RecoveryBundle(StrictWire):
    ciphertext: str
    iv: str
    tag: str

    @model_validator(mode="after")
    def encoding(self):
        decoded(self.ciphertext, length=64)
        decoded(self.iv, length=12)
        decoded(self.tag, length=16)
        return self


class RecoveryWrap(StrictWire):
    artifactId: str
    role: Literal["owner_recovery"]
    bundle: RecoveryBundle


Wrap = Annotated[RecipientWrap | RecoveryWrap, Field(discriminator="role")]


class RevisionWrite(StrictWire):
    expectedRevision: int = Field(ge=0)
    idempotencyKey: str = Field(pattern=r"^[0-9a-f-]{36}$")


class Prepare(RevisionWrite):
    phase: Literal["prepare"]
    selectedFiles: list[SelectedFile] = Field(min_length=1, max_length=25)
    copyDisclosureVersion: Literal["one-document-copy-v1"]
    copyAccepted: Literal[True]
    amountCents: int = Field(ge=50, le=50000)
    accessExpiresAt: str


class FinalApproval(RevisionWrite):
    phase: Literal["final"]
    termsDigest: Hash
    packageDigest: Hash


Approval = Annotated[Prepare | FinalApproval, Field(discriminator="phase")]


class Upload(RevisionWrite):
    descriptor: Artifact


class Package(RevisionWrite):
    generationId: str
    preparationDigest: Hash
    contentCommitment: Hash
    artifacts: list[Artifact] = Field(min_length=3, max_length=51)
    terms: Terms
    termsDigest: Hash
    wraps: list[Wrap] = Field(min_length=6, max_length=102)
    packageDigest: Hash


class ChallengeIssue(StrictWire):
    phase: Literal["issue"]
    recipientKeyId: KeyId
    recipientKeyFingerprint: Hash
    purpose: Literal["delivery", "recovery"] = "delivery"


class ChallengeVerify(StrictWire):
    phase: Literal["verify"]
    challengeId: str
    plaintext: Hash


Challenge = Annotated[ChallengeIssue | ChallengeVerify, Field(discriminator="phase")]


class CheckoutAcceptance(StrictWire):
    acceptedTermsRevision: int = Field(ge=1)
    acceptedTermsDigest: Hash
    acceptedPackageDigest: Hash


class Activity(StrictWire):
    interactionId: str
    artifactId: str
    eventId: str
    kind: Literal["preview_rendered", "decrypt_failed", "download_requested", "handoff_reported"]
    outcome: Literal["success", "cancelled", "failed"]


class Revoke(RevisionWrite):
    scope: Literal["one", "drive", "both"]


class RecoveryAmendment(RevisionWrite):
    originalTermsDigest: Hash
    originalPackageDigest: Hash
    terms: Terms
    termsDigest: Hash
    wraps: list[Wrap] = Field(min_length=6, max_length=102)
    packageDigest: Hash
    recoveryAccepted: Literal[True]


def preparation_commitment(*, request_id, owner, recipient, generation_id, selection_digest):
    return digest(
        {
            "version": 1,
            "requestId": request_id,
            "ownerUserId": owner,
            "recipientUserId": recipient,
            "generationId": generation_id,
            "sourceSelectionDigest": selection_digest,
        }
    )


def content_commitment(preparation_digest: str, artifacts: list[dict]) -> str:
    return digest(
        {
            "version": 1,
            "preparationDigest": preparation_digest,
            "artifacts": sorted(artifacts, key=lambda item: item["artifactId"]),
        }
    )


def package_commitment(content: str, terms: str, wraps: list[dict]) -> str:
    descriptors = [
        {"artifactId": item["artifactId"], "role": item["role"], "sha256": digest(item)}
        for item in wraps
    ]
    return digest(
        {
            "version": 1,
            "contentCommitment": content,
            "termsDigest": terms,
            "wraps": sorted(descriptors, key=lambda item: (item["artifactId"], item["role"])),
        }
    )
