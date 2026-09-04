from __future__ import annotations

import base64
import hashlib
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from hushh_mcp.services.trusted_device_service import (
    TrustedDeviceError,
    TrustedDeviceService,
)


class MemoryStore:
    def __init__(self) -> None:
        self.authorizations: dict[str, dict[str, Any]] = {}
        self.devices: dict[str, dict[str, Any]] = {}
        self.challenges: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []

    def insert_authorization(self, row: dict[str, Any]) -> None:
        self.authorizations[row["code_hash"]] = dict(row)

    def attach_vault_handoff(
        self,
        *,
        authorization_id: str,
        user_id: str,
        handoff: dict[str, Any],
        now_ms: int,
    ) -> bool:
        for row in self.authorizations.values():
            if (
                row["authorization_id"] == authorization_id
                and row["user_id"] == user_id
                and not row.get("consumed_at")
                and row["expires_at"] > now_ms
                and not row.get("vault_handoff")
            ):
                row["vault_handoff"] = dict(handoff)
                return True
        return False

    def consume_authorization(
        self, *, code_hash: str, code_challenge: str, now_ms: int
    ) -> dict[str, Any] | None:
        row = self.authorizations.get(code_hash)
        if (
            not row
            or row.get("consumed_at")
            or row["expires_at"] <= now_ms
            or row["code_challenge"] != code_challenge
        ):
            return None
        row["consumed_at"] = now_ms
        return dict(row)

    def consume_and_activate_authorization(
        self, *, code_hash: str, code_challenge: str, now_ms: int
    ) -> dict[str, Any] | None:
        """Mirror the production atomic exchange/replacement contract."""
        row = self.consume_authorization(
            code_hash=code_hash,
            code_challenge=code_challenge,
            now_ms=now_ms,
        )
        if not row:
            return None
        replacement_id = row.get("replaces_device_id")
        if replacement_id:
            previous = self.get_active_device(
                user_id=str(row["user_id"]), device_id=str(replacement_id)
            )
            if not previous:
                # The production statement leaves an invalid replacement grant
                # unconsumed. Restore the in-memory row to preserve that parity.
                self.authorizations[code_hash]["consumed_at"] = None
                return None
            previous.update(status="revoked", revoked_at=now_ms)
        self.upsert_device(
            {
                "device_id": row["device_id"],
                "user_id": row["user_id"],
                "device_public_key": row["device_public_key"],
                "device_name": row["device_name"],
                "platform": row["platform"],
                "created_at": now_ms,
                "last_used_at": now_ms,
            }
        )
        return {
            **row,
            "replaced_device_id": replacement_id,
        }

    def upsert_device(self, row: dict[str, Any]) -> None:
        self.devices[row["device_id"]] = {**row, "status": "active", "revoked_at": None}

    def list_devices(self, *, user_id: str) -> list[dict[str, Any]]:
        return [row for row in self.devices.values() if row["user_id"] == user_id]

    def get_active_device(self, *, user_id: str, device_id: str) -> dict[str, Any] | None:
        row = self.devices.get(device_id)
        if row and row["user_id"] == user_id and row["status"] == "active":
            return row
        return None

    def revoke_device(self, *, user_id: str, device_id: str, now_ms: int) -> bool:
        row = self.get_active_device(user_id=user_id, device_id=device_id)
        if not row:
            return False
        row.update(status="revoked", revoked_at=now_ms)
        return True

    def insert_challenge(self, row: dict[str, Any]) -> None:
        self.challenges[row["challenge_id"]] = dict(row)

    def get_challenge(
        self, *, challenge_id: str, user_id: str, device_id: str, now_ms: int
    ) -> dict[str, Any] | None:
        row = self.challenges.get(challenge_id)
        if (
            not row
            or row.get("consumed_at")
            or row["expires_at"] <= now_ms
            or row["user_id"] != user_id
            or row["device_id"] != device_id
        ):
            return None
        return dict(row)

    def consume_challenge(
        self, *, challenge_id: str, user_id: str, device_id: str, nonce_hash: str, now_ms: int
    ) -> bool:
        row = self.challenges.get(challenge_id)
        if (
            not row
            or row.get("consumed_at")
            or row["expires_at"] <= now_ms
            or row["user_id"] != user_id
            or row["device_id"] != device_id
            or row["nonce_hash"] != nonce_hash
        ):
            return False
        row["consumed_at"] = now_ms
        return True

    def touch_device(self, *, user_id: str, device_id: str, now_ms: int) -> None:
        row = self.get_active_device(user_id=user_id, device_id=device_id)
        assert row is not None
        row["last_used_at"] = now_ms

    def audit(self, **event: Any) -> None:
        self.events.append(event)


@pytest.fixture(autouse=True)
def trusted_device_pepper(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRUSTED_DEVICE_PEPPER", "unit-test-only-pepper")


def _keypair() -> tuple[ec.EllipticCurvePrivateKey, str]:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_der = private_key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_key, base64.b64encode(public_der).decode("ascii")


def _pkce() -> tuple[str, str]:
    verifier = "a" * 43
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest())
        .decode("ascii")
        .rstrip("=")
    )
    return verifier, challenge


def _enroll() -> tuple[TrustedDeviceService, MemoryStore, ec.EllipticCurvePrivateKey, dict]:
    store = MemoryStore()
    service = TrustedDeviceService(store)
    private_key, public_key = _keypair()
    verifier, challenge = _pkce()
    authorization = service.create_authorization(
        user_id="user-1",
        redirect_uri="http://127.0.0.1:43119/callback",
        code_challenge=challenge,
        device_public_key=public_key,
        device_name="Kushal's Mac",
        platform="macos",
        state="s" * 32,
    )
    code = authorization.redirect_url.split("code=", 1)[1].split("&", 1)[0]
    device = service.exchange_authorization(code=code, code_verifier=verifier)
    return service, store, private_key, device


def test_pkce_exchange_is_single_use_and_registers_device() -> None:
    service, store, _private_key, device = _enroll()
    assert device["user_id"] == "user-1"
    assert store.devices[device["device_id"]]["status"] == "active"
    assert {event["event_type"] for event in store.events} == {
        "authorization_approved",
        "authorization_exchanged",
    }

    with pytest.raises(TrustedDeviceError, match="authorization grant is invalid"):
        service.exchange_authorization(code="tdc_" + "x" * 43, code_verifier="a" * 43)


def test_wrong_pkce_verifier_does_not_consume_code() -> None:
    store = MemoryStore()
    service = TrustedDeviceService(store)
    _private_key, public_key = _keypair()
    verifier, challenge = _pkce()
    authorization = service.create_authorization(
        user_id="user-1",
        redirect_uri="http://localhost:8765/callback",
        code_challenge=challenge,
        device_public_key=public_key,
        device_name="Mac",
        platform="macos",
        state="z" * 32,
    )
    code = authorization.redirect_url.split("code=", 1)[1].split("&", 1)[0]
    with pytest.raises(TrustedDeviceError):
        service.exchange_authorization(code=code, code_verifier="b" * 43)
    assert service.exchange_authorization(code=code, code_verifier=verifier)["user_id"] == "user-1"


def test_vault_handoff_is_attached_once_and_consumed_with_pkce() -> None:
    store = MemoryStore()
    service = TrustedDeviceService(store)
    _private_key, public_key = _keypair()
    verifier, challenge = _pkce()
    authorization = service.create_authorization(
        user_id="user-1",
        redirect_uri="http://127.0.0.1:43119/callback",
        code_challenge=challenge,
        device_public_key=public_key,
        device_name="Mac",
        platform="macos",
        state="s" * 32,
    )
    handoff = {
        "vault_handoff_alg": "X25519-AES256-GCM",
        "vault_handoff_wrapped_key": "ciphertext",
    }
    service.attach_vault_handoff(
        authorization_id=authorization.authorization_id,
        user_id="user-1",
        handoff=handoff,
    )
    with pytest.raises(TrustedDeviceError, match="already attached"):
        service.attach_vault_handoff(
            authorization_id=authorization.authorization_id,
            user_id="user-1",
            handoff=handoff,
        )

    code = authorization.redirect_url.split("code=", 1)[1].split("&", 1)[0]
    exchanged = service.exchange_authorization(code=code, code_verifier=verifier)
    assert exchanged["authorization_id"] == authorization.authorization_id
    assert exchanged["vault_handoff"] == handoff


def test_reconnecting_replaces_only_the_active_device_for_the_same_account() -> None:
    service, store, _private_key, original = _enroll()
    _next_private, next_public = _keypair()
    verifier, challenge = _pkce()
    authorization = service.create_authorization(
        user_id="user-1",
        redirect_uri="http://127.0.0.1:43119/callback",
        code_challenge=challenge,
        device_public_key=next_public,
        device_name="Kushal's Mac (repaired)",
        platform="macos",
        state="r" * 32,
        replaces_device_id=original["device_id"],
    )
    code = authorization.redirect_url.split("code=", 1)[1].split("&", 1)[0]
    replacement = service.exchange_authorization(code=code, code_verifier=verifier)

    assert replacement["replaced_device_id"] == original["device_id"]
    assert store.devices[original["device_id"]]["status"] == "revoked"
    assert store.devices[replacement["device_id"]]["status"] == "active"
    assert "device_replaced" in {event["event_type"] for event in store.events}


def test_signed_challenge_is_single_use_and_revocation_fails_closed() -> None:
    service, _store, private_key, device = _enroll()
    challenge = service.create_challenge(user_id="user-1", device_id=device["device_id"])
    signature = private_key.sign(
        challenge["signing_payload"].encode("utf-8"),
        ec.ECDSA(hashes.SHA256()),
    )
    encoded_signature = base64.b64encode(signature).decode("ascii")
    service.verify_challenge(
        user_id="user-1",
        device_id=device["device_id"],
        challenge_id=challenge["challenge_id"],
        nonce=challenge["nonce"],
        signature_b64=encoded_signature,
    )

    with pytest.raises(TrustedDeviceError, match="already used"):
        service.verify_challenge(
            user_id="user-1",
            device_id=device["device_id"],
            challenge_id=challenge["challenge_id"],
            nonce=challenge["nonce"],
            signature_b64=encoded_signature,
        )

    assert service.revoke_device(user_id="user-1", device_id=device["device_id"])
    assert not service.is_active_device(user_id="user-1", device_id=device["device_id"])
    with pytest.raises(TrustedDeviceError, match="not active"):
        service.create_challenge(user_id="user-1", device_id=device["device_id"])


def test_invalid_signature_is_rejected() -> None:
    service, _store, _private_key, device = _enroll()
    other_private, _ = _keypair()
    challenge = service.create_challenge(user_id="user-1", device_id=device["device_id"])
    signature = other_private.sign(
        challenge["signing_payload"].encode("utf-8"),
        ec.ECDSA(hashes.SHA256()),
    )
    with pytest.raises(TrustedDeviceError, match="signature is invalid"):
        service.verify_challenge(
            user_id="user-1",
            device_id=device["device_id"],
            challenge_id=challenge["challenge_id"],
            nonce=challenge["nonce"],
            signature_b64=base64.b64encode(signature).decode("ascii"),
        )
