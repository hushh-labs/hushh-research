"""Private, exact-file terms for owner-reviewed Drive sharing.

Neither a connection nor this data model grants permission. Only the durable
confirmation claim may admit a provider mutation. No model-generated provider
identifier, recipient address or access role is accepted at that boundary.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.services.google_drive_adapter import FILE_ID, DriveReadError

SHARING_DISCLOSURE = "drive-original-viewer-until-revoked-v1"
SHARING_ACTION = {
    "action_id": "documents.share_originals",
    "version": 1,
    "execution_policy": "confirm_required",
    "activation_policy": "trusted_activation_required",
    "recipient_type": "user",
    "role": "reader",
    "duration": "until_revoked",
    "disclosure": SHARING_DISCLOSURE,
}
BROAD_TRUST_SCOPE = "any_requested_drive_file"
BROAD_TRUST_DISCLOSURE = "drive-any-requested-file-including-future-v1"
LEGACY_TRUST_SCOPE = "exact_files_same_request_purpose"
MAX_FILES = 25
MAX_ENVELOPE_BYTES = 128 * 1024
_EMAIL = re.compile(r'[^@\s<>"(),;:\\]+@[^@\s<>"(),;:\\]+\.[^@\s<>"(),;:\\]+\Z')


class DriveSharingError(DriveReadError):
    pass


@dataclass(frozen=True)
class VerifiedGoogleRecipient:
    user_id: str = field(repr=False)
    subject: str = field(repr=False)
    email: str = field(repr=False)
    verified_at: datetime
    kind: Literal["google_provider", "verified_email"] = "google_provider"


def recipient_from_verified_firebase_claims(
    claims: dict, *, owner_user_id: str, google_provider: object, now: datetime | None = None
) -> VerifiedGoogleRecipient:
    """Input must come from the existing Firebase verifier, never a decoded JWT.

    google_provider is the current Google provider record from Firebase Admin's
    verified user lookup, not request data. A top-level email can be changed
    independently of the Google provider. B needs identity proof, not Drive OAuth.
    """
    now = now or datetime.now(UTC)
    try:
        firebase = claims["firebase"]
        subjects = firebase["identities"]["google.com"]
        # Delivery follows the current linked Google identity, even when the
        # valid One session was established with another sign-in provider.
        email = getattr(google_provider, "email", None)
        if (
            claims.get("uid", claims.get("sub")) != owner_user_id
            or not isinstance(subjects, list)
            or len(subjects) != 1
            or not isinstance(subjects[0], str)
            or not re.fullmatch(r"[0-9]{1,40}", subjects[0])
            or not isinstance(email, str)
            or not email.isascii()
            or not 3 <= len(email) <= 254
            or not _EMAIL.fullmatch(email)
            or getattr(google_provider, "provider_id", None) != "google.com"
            or getattr(google_provider, "uid", None) != subjects[0]
        ):
            raise ValueError("unverified Google identity")
        # Freshness means a current server lookup, not a new interactive login.
        return VerifiedGoogleRecipient(owner_user_id, subjects[0], email, now)
    except (KeyError, TypeError, ValueError):
        raise DriveSharingError("verify_google_identity_required") from None


def recipient_from_google_provider(
    user_id: str, google_provider: object, *, now: datetime | None = None
) -> VerifiedGoogleRecipient:
    """B's identity from Firebase Admin's current user record, for owner actions.

    Used when A shares files from B's question: B is not present, so the proof
    is the same server lookup that re-verifies every delivery, never request data.
    """
    subject = getattr(google_provider, "uid", None)
    email = getattr(google_provider, "email", None)
    if (
        getattr(google_provider, "provider_id", None) != "google.com"
        or not isinstance(subject, str)
        or not re.fullmatch(r"[0-9]{1,40}", subject)
        or not isinstance(email, str)
        or not email.isascii()
        or not 3 <= len(email) <= 254
        or not _EMAIL.fullmatch(email)
    ):
        raise DriveSharingError("recipient_google_identity_required")
    return VerifiedGoogleRecipient(user_id, subject, email, now or datetime.now(UTC))


def recipient_from_verified_firebase_email(
    user_id: str, user: object, *, now: datetime | None = None
) -> VerifiedGoogleRecipient:
    """Use B's current verified One email for an owner-initiated share."""
    email = getattr(user, "email", None)
    if (
        getattr(user, "uid", None) != user_id
        or getattr(user, "disabled", None) is not False
        or getattr(user, "email_verified", None) is not True
        or not isinstance(email, str)
        or not email.isascii()
        or not 3 <= len(email) <= 254
        or not _EMAIL.fullmatch(email)
    ):
        raise DriveSharingError("recipient_verified_email_required")
    return VerifiedGoogleRecipient(
        user_id, user_id, email, now or datetime.now(UTC), "verified_email"
    )


class ShareRequestPurpose(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    purpose: str = Field(min_length=1, max_length=2000)
    periodStart: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    periodEnd: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def valid_period(self):
        from datetime import date

        if not self.purpose.strip() or (self.periodStart is None) != (self.periodEnd is None):
            raise ValueError("Specify a purpose and either both period dates or neither.")
        if self.periodStart is not None:
            start, end = date.fromisoformat(self.periodStart), date.fromisoformat(self.periodEnd)
            if end < start:
                raise ValueError("The requested period is invalid.")
        return self


class ReviewedSource(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    document_id: UUID
    source_version: str = Field(pattern=r"^[0-9]{1,30}$")
    source_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    index_version: str = Field(pattern=r"^[0-9a-f]{64}$")
    processing_revision: int = Field(ge=0)


class LiveReviewedSource(BaseModel):
    """A provider observation whose raw file ID stays in a private envelope."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["live"] = "live"
    document_id: UUID
    source_version: str = Field(pattern=r"^[0-9]{1,30}$")
    provider_file_binding: str = Field(pattern=r"^[0-9a-f]{64}$")
    connection_generation: int = Field(ge=1)


class SharingApproval(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    request_id: UUID
    revision: int = Field(ge=1)
    owner_user_id: str = Field(min_length=1, max_length=128)
    recipient_user_id: str = Field(min_length=1, max_length=128)
    recipient_binding: str = Field(pattern=r"^[0-9a-f]{64}$")
    connection_generation: int = Field(ge=1)
    sources: tuple[ReviewedSource | LiveReviewedSource, ...] = Field(
        min_length=1, max_length=MAX_FILES
    )
    role: Literal["reader"] = "reader"
    recipient_type: Literal["user"] = "user"
    disclosure: Literal["drive-original-viewer-until-revoked-v1"] = SHARING_DISCLOSURE

    @model_validator(mode="after")
    def exact_distinct_sources(self):
        if self.owner_user_id == self.recipient_user_id:
            raise ValueError("A document request requires a different recipient.")
        if len({source.document_id for source in self.sources}) != len(self.sources):
            raise ValueError("Each approved document must appear exactly once.")
        identities = {
            source.source_fingerprint
            if isinstance(source, ReviewedSource)
            else source.provider_file_binding
            for source in self.sources
        }
        if len(identities) != len(self.sources):
            raise ValueError("Each approved source must appear exactly once.")
        return self

    def authority_binding(self) -> dict:
        payload = self.model_dump(mode="json")
        # Order is presentation only; identity is the complete exact source set.
        payload["sources"] = sorted(payload["sources"], key=lambda source: source["document_id"])
        return payload

    def narrowed_to(self, document_ids: list[str]) -> SharingApproval:
        """The owner's chosen part of this exact reviewed set, never a file outside it."""
        try:
            chosen = [str(UUID(str(item))) for item in document_ids]
        except ValueError:
            raise DriveSharingError("review_changed") from None
        reviewed = {str(source.document_id) for source in self.sources}
        if not chosen or len(set(chosen)) != len(chosen) or not set(chosen) <= reviewed:
            raise DriveSharingError("review_changed")
        # model_validate, not model_copy: the source validators must run again.
        return SharingApproval.model_validate(
            {
                **self.model_dump(),
                "sources": [
                    source for source in self.sources if str(source.document_id) in set(chosen)
                ],
            }
        )


class DriveSharingCipher:
    """Receipt key is independent of the removable document index/OAuth store.

    Provider IDs, verified identity, purpose, file names and permission evidence
    are all inside authenticated envelopes. Only keyed equality digests escape.
    """

    @staticmethod
    def _key() -> bytes:
        try:
            key = base64.b64decode(
                os.environ["DRIVE_SHARING_KEY_V1"], altchars=b"-_", validate=True
            )
            if len(key) != 32:
                raise ValueError("invalid key")
            return key
        except (KeyError, ValueError):
            raise DriveSharingError("sharing_storage_unavailable") from None

    @staticmethod
    def _json(value: object) -> bytes:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, purpose: str, value: object) -> str:
        return hmac.new(
            self._key(), self._json(["drive-sharing-v1", purpose, value]), hashlib.sha256
        ).hexdigest()

    def recipient_binding(self, recipient: VerifiedGoogleRecipient) -> str:
        if recipient.kind == "verified_email":
            return self.digest(
                "recipient", [recipient.kind, recipient.user_id, recipient.subject, recipient.email]
            )
        # Preserve bindings for existing Google-provider requests and rules.
        return self.digest("recipient", [recipient.user_id, recipient.subject, recipient.email])

    def file_lock(self, provider_file_id: str) -> str:
        if not isinstance(provider_file_id, str) or not FILE_ID.fullmatch(provider_file_id):
            raise DriveSharingError("invalid_selection")
        # Global within this service: two owners cannot concurrently mutate one file.
        return self.digest("file-mutation-lock", provider_file_id)

    def seal(self, payload: dict, *, user_id: str, resource_id: str, purpose: str) -> dict:
        plaintext = self._json(payload)
        if len(plaintext) > MAX_ENVELOPE_BYTES:
            raise DriveSharingError("sharing_payload_too_large")
        aad = self._json(["drive-sharing-v1", user_id, resource_id, purpose])
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._key()).encrypt(nonce, plaintext, aad)
        return {
            "version": 1,
            "iv": base64.b64encode(nonce).decode(),
            "ciphertext": base64.b64encode(ciphertext).decode(),
        }

    def open(self, envelope: dict, *, user_id: str, resource_id: str, purpose: str) -> dict:
        try:
            if (
                envelope["version"] != 1
                or len(envelope["ciphertext"]) > (MAX_ENVELOPE_BYTES + 32) * 2
            ):
                raise ValueError("invalid envelope")
            aad = self._json(["drive-sharing-v1", user_id, resource_id, purpose])
            plaintext = AESGCM(self._key()).decrypt(
                base64.b64decode(envelope["iv"], validate=True),
                base64.b64decode(envelope["ciphertext"], validate=True),
                aad,
            )
            payload = json.loads(plaintext)
            if len(plaintext) > MAX_ENVELOPE_BYTES or not isinstance(payload, dict):
                raise ValueError("invalid payload")
            return payload
        except Exception:
            raise DriveSharingError("sharing_storage_unavailable") from None
