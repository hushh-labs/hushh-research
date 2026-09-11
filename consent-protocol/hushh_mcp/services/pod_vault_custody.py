"""Recoverable vault custody transitions over the existing owner-pod log.

This persistence adapter does not grant consent. Its caller must verify the
purpose-specific owner proof and pass an authority guard for the same log history.
Only purpose-sealed key material enters the already sealed recovery log.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from collections.abc import Callable
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.pod_commit_log import PodCommitLog, PodLogFenced

WRITER_KIND = "vault_custody_writer_v1"
CUSTODY_KIND = "vault_custody_state_v1"
_PURPOSE = b"hussh/pod-vault-custody/aes256gcm/v1"
HistoryGuard = Callable[[list[dict[str, Any]]], None]


class CustodyRefused(PermissionError):
    """Sanitized refusal; never include key material or envelopes."""


class CustodyBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    owner_id: str = Field(min_length=1, max_length=128)
    environment: str = Field(min_length=1, max_length=32)
    deployment_id: str = Field(min_length=1, max_length=256)


class CustodyState(CustodyBinding):
    generation: int = Field(ge=1)
    key_version: int = Field(ge=1)
    key_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$", repr=False)
    enrollment_id: str = Field(min_length=1, max_length=128)
    active: bool
    sealed_key: str = Field(max_length=128, repr=False)


class PodVaultCustody:
    def __init__(
        self,
        log: PodCommitLog,
        *,
        dek: bytes,
        binding: CustodyBinding,
        epoch: int,
        instance_id: str,
    ):
        if len(dek) != 32 or type(epoch) is not int or epoch < 1 or not instance_id:
            raise ValueError("invalid_custody_configuration")
        if getattr(log, "_owner_id", None) != binding.owner_id:
            raise CustodyRefused("custody_owner_mismatch")
        self.log = log
        self.binding = binding
        self.epoch = epoch
        self.instance_id = instance_id
        self._aead = AESGCM(
            HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_PURPOSE).derive(dek)
        )

    def _state(self, records: list[dict[str, Any]]) -> CustodyState | None:
        current = None
        for record in records:
            if record["kind"] != CUSTODY_KIND:
                continue
            try:
                state = CustodyState.model_validate(record["payload"])
            except ValueError:
                raise CustodyRefused("invalid_custody_history") from None
            if any(getattr(state, k) != v for k, v in self.binding.model_dump().items()):
                raise CustodyRefused("custody_binding_mismatch")
            if state.generation != (current.generation + 1 if current else 1):
                raise CustodyRefused("invalid_custody_generation")
            if current and (
                state.key_version < current.key_version
                or (
                    state.key_version == current.key_version
                    and state.key_fingerprint != current.key_fingerprint
                )
            ):
                raise CustodyRefused("invalid_custody_key_history")
            if not state.active and state.sealed_key:
                raise CustodyRefused("invalid_revoked_custody")
            current = state
        return current

    def _writer(self, records: list[dict[str, Any]]) -> dict[str, Any] | None:
        current = None
        for record in records:
            if record["kind"] != WRITER_KIND:
                continue
            candidate = record["payload"]
            if (
                not isinstance(candidate, dict)
                or candidate.get("binding") != self.binding.model_dump()
                or type(candidate.get("epoch")) is not int
                or candidate["epoch"] < 1
                or not isinstance(candidate.get("instance_id"), str)
                or not candidate["instance_id"]
                or (current and candidate["epoch"] <= current["epoch"])
            ):
                raise CustodyRefused("invalid_custody_writer_history")
            current = candidate
        return current

    def _require_writer(self, records: list[dict[str, Any]]) -> None:
        writer = self._writer(records)
        if not writer or writer["epoch"] != self.epoch or writer["instance_id"] != self.instance_id:
            raise PodLogFenced("custody writer was replaced or is unavailable")

    async def activate_writer(self) -> None:
        def guard(records):
            previous = self._writer(records)
            if previous and previous["epoch"] >= self.epoch:
                raise PodLogFenced("custody writer epoch is not newer")

        await self.log.append(
            WRITER_KIND,
            {
                "binding": self.binding.model_dump(),
                "epoch": self.epoch,
                "instance_id": self.instance_id,
            },
            precondition=guard,
        )

    def _aad(self, state: CustodyState) -> bytes:
        import json

        metadata = state.model_dump(exclude={"sealed_key"})
        return (
            _PURPOSE
            + b"\x00"
            + json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()
        )

    async def enroll(
        self,
        *,
        vault_key: bytes,
        key_version: int,
        enrollment_id: str,
        expected_generation: int,
        authority_guard: HistoryGuard,
    ) -> CustodyState:
        if len(vault_key) != 32 or type(expected_generation) is not int or expected_generation < 0:
            raise CustodyRefused("invalid_custody_enrollment")
        state = CustodyState(
            **self.binding.model_dump(),
            generation=expected_generation + 1,
            key_version=key_version,
            key_fingerprint=hashlib.sha256(vault_key).hexdigest(),
            enrollment_id=enrollment_id,
            active=True,
            sealed_key="",
        )
        nonce = secrets.token_bytes(12)
        sealed = base64.b64encode(
            nonce + self._aead.encrypt(nonce, vault_key, self._aad(state))
        ).decode()
        state = state.model_copy(update={"sealed_key": sealed})

        def guard(records):
            self._require_writer(records)
            authority_guard(records)
            current = self._state(records)
            if current and (
                key_version < current.key_version
                or (
                    key_version == current.key_version
                    and state.key_fingerprint != current.key_fingerprint
                )
            ):
                raise CustodyRefused("custody_key_version_conflict")
            if (current.generation if current else 0) != expected_generation:
                raise CustodyRefused("custody_revision_conflict")
            if any(
                r["kind"] == CUSTODY_KIND and r["payload"].get("enrollment_id") == enrollment_id
                for r in records
            ):
                raise CustodyRefused("custody_enrollment_replayed")

        await self.log.append(CUSTODY_KIND, state.model_dump(), precondition=guard)
        return state

    async def revoke(self, *, expected_generation: int, authority_guard: HistoryGuard) -> None:
        records = await self.log.replay()
        current = self._state(records)
        if current is None or current.generation != expected_generation:
            raise CustodyRefused("custody_revision_conflict")
        state = current.model_copy(
            update={"generation": current.generation + 1, "active": False, "sealed_key": ""}
        )

        def guard(history):
            self._require_writer(history)
            authority_guard(history)
            latest = self._state(history)
            if latest is None or latest.generation != expected_generation:
                raise CustodyRefused("custody_revision_conflict")

        await self.log.append(CUSTODY_KIND, state.model_dump(), precondition=guard)

    async def recover(self, *, authority_guard: HistoryGuard) -> bytes:
        records = await self.log.replay()
        self._require_writer(records)
        authority_guard(records)
        state = self._state(records)
        if state is None or not state.active:
            raise CustodyRefused("custody_not_enrolled")
        try:
            sealed = base64.b64decode(state.sealed_key, validate=True)
            key = self._aead.decrypt(sealed[:12], sealed[12:], self._aad(state))
            if len(key) != 32 or hashlib.sha256(key).hexdigest() != state.key_fingerprint:
                raise ValueError("length")
        except Exception:
            raise CustodyRefused("custody_decryption_failed") from None
        # Recovery is a snapshot, not an execution grant. The caller must fence
        # provider/result/commit authority again; key custody alone cannot do it.
        latest = await self.log.replay()
        self._require_writer(latest)
        authority_guard(latest)
        if self._state(latest) != state:
            raise CustodyRefused("custody_changed_during_recovery")
        return key
