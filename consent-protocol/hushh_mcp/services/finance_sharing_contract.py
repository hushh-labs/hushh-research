"""Curated recipient-encrypted Finance objects, separate from raw PKM scopes."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator


class StrictObject(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProcessingPermission(StrictObject):
    version: Literal[1] = 1
    allowed: StrictBool = False


class FinanceSharePolicy(StrictObject):
    version: Literal[1] = 1
    mode: Literal["snapshot", "ongoing"]
    sections: list[Literal["allocation", "performance", "holdings", "note"]] = Field(
        min_length=1, max_length=4
    )
    selectionHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    showAmounts: StrictBool = False
    model_processing: ProcessingPermission = Field(default_factory=ProcessingPermission)
    durationSeconds: Literal[3600, 86400, 604800] | None

    @model_validator(mode="after")
    def validate_selection(self):
        if len(set(self.sections)) != len(self.sections):
            raise ValueError("duplicate sections")
        if self.mode == "snapshot" and self.durationSeconds is None:
            raise ValueError("snapshot requires expiry")
        return self


class RecipientEnvelope(StrictObject):
    algorithm: Literal["ECDH-P256-AES256-GCM"]
    recipientKeyId: str = Field(min_length=1, max_length=160)
    ciphertext: str = Field(min_length=24, max_length=180000, pattern=r"^[A-Za-z0-9_-]+$")
    iv: str = Field(pattern=r"^[A-Za-z0-9_-]{16}$")
    senderEphemeralPublicKeyJwk: dict

    @model_validator(mode="after")
    def validate_key(self):
        import re

        key = self.senderEphemeralPublicKeyJwk
        if set(key) - {"kty", "crv", "x", "y", "ext", "key_ops"}:
            raise ValueError("unexpected public key field")
        if key.get("kty") != "EC" or key.get("crv") != "P-256":
            raise ValueError("invalid public key")
        if any(not re.fullmatch(r"[A-Za-z0-9_-]{43}", str(key.get(c, ""))) for c in ("x", "y")):
            raise ValueError("invalid public key")
        if key.get("key_ops", []) != [] or key.get("ext", True) is not True:
            raise ValueError("invalid public key")
        return self


class FinanceRecipient(StrictObject):
    grantId: UUID
    personRef: UUID
    envelope: RecipientEnvelope
    ownerEnvelope: RecipientEnvelope
    contentHash: str = Field(pattern=r"^[a-f0-9]{64}$")


class CreateFinanceShare(StrictObject):
    requestId: UUID
    policy: FinanceSharePolicy
    ownerConfig: RecipientEnvelope
    recipients: list[FinanceRecipient] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_recipients(self):
        if len({r.personRef for r in self.recipients}) != len(self.recipients):
            raise ValueError("duplicate recipient")
        if len({r.grantId for r in self.recipients}) != len(self.recipients):
            raise ValueError("duplicate grant")
        return self


class RefreshFinanceShare(StrictObject):
    expectedRevision: StrictInt = Field(ge=1)
    envelope: RecipientEnvelope
    ownerEnvelope: RecipientEnvelope
    contentHash: str = Field(pattern=r"^[a-f0-9]{64}$")


def finance_envelope_context(*, request_id, grant_id, owner, recipient, policy, revision):
    """Stable tuple; client uses precisely the same order and scalar types."""
    import json

    return json.dumps(
        [
            "finance-share-v1",
            str(request_id),
            str(grant_id),
            owner,
            recipient,
            policy["mode"],
            sorted(policy["sections"]),
            policy["selectionHash"],
            policy["showAmounts"],
            policy["model_processing"]["allowed"],
            policy["durationSeconds"],
            revision,
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    )
