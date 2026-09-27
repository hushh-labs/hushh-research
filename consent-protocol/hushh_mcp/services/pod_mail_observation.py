"""Short-lived, hub-verified Mail observations. These receipts grant no access.

Only nonce, expiry and signature cross to the pod. Owner, serving incarnation,
scope and grant fingerprint are reconstructed at the authenticated hub on every
validation; no mailbox cache, credential copy or parallel approval store exists.
"""

from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.consent.token_signing import sign_payload, verify_payload
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError

_TTL_SECONDS = 90


class MailObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expires_at: int
    nonce: str = Field(pattern=r"^[a-f0-9]{32}$")
    signature: str = Field(min_length=1, max_length=512)


@dataclass(frozen=True)
class MailObservationContext:
    owner_id: str
    pod_id: str
    service_uid: str
    scope_digest: str
    environment: str

    def payload(self, receipt: MailObservation, grant_fingerprint: str) -> str:
        if not all(
            (self.owner_id, self.pod_id, self.service_uid, self.scope_digest, self.environment)
        ):
            raise GmailMetadataError("permission_denied")
        return json.dumps(
            [
                "pod.mail.grant-observation.v1",
                self.environment,
                self.owner_id,
                self.pod_id,
                self.service_uid,
                self.scope_digest,
                grant_fingerprint,
                receipt.expires_at,
                receipt.nonce,
            ],
            separators=(",", ":"),
        )


def _key() -> str:
    from hushh_mcp.config import APP_SIGNING_KEY

    if not APP_SIGNING_KEY:
        raise RuntimeError("Mail observation signing unavailable")
    return APP_SIGNING_KEY


def issue_observation(context: MailObservationContext, fingerprint: str) -> MailObservation:
    receipt = MailObservation(
        expires_at=int(time.time()) + _TTL_SECONDS,
        nonce=secrets.token_hex(16),
        signature="pending",
    )
    return receipt.model_copy(
        update={"signature": sign_payload(context.payload(receipt, fingerprint), hmac_key=_key())}
    )


def verify_observation(
    context: MailObservationContext, receipt: MailObservation, fingerprint: str
) -> None:
    now = int(time.time())
    if not now < receipt.expires_at <= now + _TTL_SECONDS or not verify_payload(
        context.payload(receipt, fingerprint), receipt.signature, hmac_key=_key()
    ):
        raise GmailMetadataError("connection_changed")
