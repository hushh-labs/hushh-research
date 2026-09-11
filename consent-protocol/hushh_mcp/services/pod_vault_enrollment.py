"""Purpose-specific owner proof for private-pod vault enrollment.

Internal ceremony used by secure owner setup, never an MCP tool. Transport must
supply an already verified app session and a durable, verified pod recipient key.
"""

from __future__ import annotations

import base64
import hashlib
import inspect
import secrets
import time
from asyncio import Lock
from collections.abc import Awaitable, Callable
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.consent.key_wrapping import unwrap_x25519_aes256_key
from hushh_mcp.services.pod_authority_store import PodAuthorityStore
from hushh_mcp.services.pod_session_authority import canonical_json, verify_subject_proof
from hushh_mcp.services.pod_vault_custody import CustodyRefused, PodVaultCustody


class WrappedCustodyKey(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sender_public_key: str = Field(min_length=44, max_length=44)
    wrapped_key: str = Field(min_length=44, max_length=44)
    nonce: str = Field(min_length=16, max_length=16)
    tag: str = Field(min_length=24, max_length=24)


class PodVaultEnrollment:
    def __init__(
        self,
        custody: PodVaultCustody,
        *,
        recipient: X25519PrivateKey,
        pod_key_id: str,
        user_id: str,
        clock: Callable[[], float] = time.time,
    ):
        if not pod_key_id or not user_id:
            raise ValueError("invalid_custody_recipient")
        self.custody = custody
        self.recipient = recipient
        self.recipient_public_key = base64.b64encode(
            recipient.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        ).decode()
        self.pod_key_id = pod_key_id
        self.user_id = user_id
        self.clock = clock
        self._pending: dict[str, dict[str, Any]] = {}
        # Pending challenges are process-local to one pod incarnation. Serialize
        # consumption so concurrent submissions return the same safe refusal
        # instead of racing through ``dict.pop`` with an unclassified KeyError.
        self._enroll_lock = Lock()

    def _subject(self, history, claims):
        if (
            claims.get("role") != "app"
            or claims.get("user_id") != self.user_id
            or claims.get("hushh_id") != self.custody.binding.owner_id
            or claims.get("epoch") != self.custody.epoch
            or type(claims.get("exp")) is not int
            or claims["exp"] <= self.clock()
        ):
            raise CustodyRefused("custody_owner_proof_required")
        store = PodAuthorityStore(self.custody.log, hushh_id=self.custody.binding.owner_id)
        store.apply_records(history)
        subject = store.subject(claims.get("subject_id", ""))
        if (
            subject.state != "trusted"
            or subject.trust is None
            or subject.trust.role != "app"
            or subject.trust.version != claims.get("version")
            or subject.trust.binding.get("user_id") != self.user_id
            or subject.trust.binding.get("environment") != self.custody.binding.environment
            or subject.trust.binding.get("pod_key_id") != self.pod_key_id
            or subject.trust.binding.get("pod_public_key") != self.recipient_public_key
        ):
            raise CustodyRefused("custody_owner_proof_required")
        return subject.trust

    async def challenge(self, *, claims: dict[str, Any], key_version: int) -> dict[str, Any]:
        history = await self.custody.log.replay()
        self.custody._require_writer(history)
        self._subject(history, claims)
        now = self.clock()
        self._pending = {k: v for k, v in self._pending.items() if v["expires_at"] > now}
        if len(self._pending) >= 32 or type(key_version) is not int or key_version < 1:
            raise CustodyRefused("custody_challenge_unavailable")
        state = self.custody._state(history)
        challenge = {
            "purpose": "hussh.pod.vault-custody.enroll.v1",
            **self.custody.binding.model_dump(),
            "user_id": self.user_id,
            "subject_id": claims["subject_id"],
            "subject_version": claims["version"],
            "epoch": self.custody.epoch,
            "pod_key_id": self.pod_key_id,
            "recipient_public_key": self.recipient_public_key,
            "key_version": key_version,
            "expected_generation": state.generation if state else 0,
            "challenge_id": secrets.token_hex(24),
            "nonce": secrets.token_hex(32),
            "expires_at": int(now) + 120,
            "approve_recoverable_custody": True,
        }
        self._pending[challenge["challenge_id"]] = challenge
        return dict(challenge)

    async def enroll(
        self,
        *,
        claims: dict[str, Any],
        challenge_id: str,
        envelope: WrappedCustodyKey,
        proof: str,
        validate_vault_key: Callable[[bytes, int], None | Awaitable[None]],
    ):
        async with self._enroll_lock:
            challenge = self._pending.get(challenge_id)
            if challenge is None or challenge["expires_at"] <= self.clock():
                raise CustodyRefused("custody_challenge_expired_or_used")
            envelope_digest = hashlib.sha256(
                canonical_json(envelope.model_dump()).encode()
            ).hexdigest()
            payload = canonical_json({"challenge": challenge, "envelope_sha256": envelope_digest})

            def guard(history):
                subject = self._subject(history, claims)
                if (
                    challenge["subject_id"] != subject.subject_id
                    or challenge["subject_version"] != subject.version
                    or challenge["expires_at"] <= self.clock()
                    or not verify_subject_proof(
                        subject.binding["subject_public_key"], payload, proof
                    )
                ):
                    raise CustodyRefused("custody_owner_proof_invalid")

            history = await self.custody.log.replay()
            self.custody._require_writer(history)
            guard(history)
            # Consume before awaiting persistence; interrupted enrollment needs a new
            # challenge, while the caller reconciles committed generation explicitly.
            if self._pending.pop(challenge_id, None) is None:
                raise CustodyRefused("custody_challenge_expired_or_used")
            try:
                raw = {
                    k: base64.b64decode(v, validate=True) for k, v in envelope.model_dump().items()
                }
                key = unwrap_x25519_aes256_key(
                    recipient_private_key=self.recipient,
                    additional_data=canonical_json(challenge).encode(),
                    **raw,
                )
            except Exception:
                raise CustodyRefused("custody_envelope_invalid") from None
            # Existing canonical vault validation must prove the key/version before
            # custody commits. A successful unwrap alone cannot establish that fact.
            validation = validate_vault_key(key, challenge["key_version"])
            if inspect.isawaitable(validation):
                validation = await validation
            if validation is not None:
                raise CustodyRefused("custody_key_validation_invalid")
            return await self.custody.enroll(
                vault_key=key,
                key_version=challenge["key_version"],
                enrollment_id=challenge_id,
                expected_generation=challenge["expected_generation"],
                authority_guard=guard,
            )
