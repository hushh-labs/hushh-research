# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Cloud-agnostic pod key custody port and Attested Custody Envelope (ACE) adapter.

Unifies pod DEK custody behind one explicit ``KeyCustodyPort`` contract across:
- ``ephemeral`` / ``fleet_hkdf``: shared-simulation env key injection;
- ``owner_kms``: owner-project KMS wrap/unwrap with create-only object storage and
  crypto-erase tombstone enforcement;
- ``owner_vault``: owner Key Vault local RSA-OAEP-256 wrap + vault unwrap proof and
  crypto-erase tombstone enforcement;
- ``ace_envelope``: per-pod X25519 + AES-256-GCM attested custody envelope sealed in
  create-only object storage without requiring per-user cloud IAM Service Accounts
  (removing the 100-SA/project ceiling for Hussh-hosted cells and mapping cleanly
  onto Google Agent Compute Engine and multi-cloud hosted substrates).
"""

from __future__ import annotations

import base64
import hmac
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Optional, Protocol, runtime_checkable

from hushh_mcp.services.compute_backend import (
    CUSTODY_ACE_ENVELOPE,
    CUSTODY_EPHEMERAL,
    CUSTODY_FLEET_HKDF,
    CUSTODY_MODES,
    CUSTODY_OWNER_KMS,
    CUSTODY_OWNER_VAULT,
)
from hushh_mcp.services.pod_object_version import ABSENT

logger = logging.getLogger(__name__)

CUSTODY_MODE_ENV = "HUSSH_POD_CUSTODY_MODE"
AWS_KMS_KEY_ENV = "HUSSH_POD_AWS_KMS_KEY_ARN"
ACE_SEAL_SCALAR_ENV = "HUSSH_POD_ACE_SEAL_SCALAR"
ACE_KEY_ID_ENV = "HUSSH_POD_ACE_KEY_ID"
ACE_OWNER_ID_ENV = "HUSSH_POD_ID"
_ACE_ALG = "ACE-X25519-AES256GCM-V1"
_ACE_ENVELOPE_VERSION = 1
_ACE_WRAP_INFO = b"hussh.pod.ace.dek-wrap.v1"
_ACE_NONCE_LEN = 12
_KEY_LEN = 32


@runtime_checkable
class KeyCustodyPort(Protocol):
    """Cloud-neutral interface every pod custody implementation satisfies."""

    @property
    def custody_mode(self) -> str: ...

    def resolve_log_key(self) -> bytes: ...

    def resolve_memory_key(self) -> bytes: ...


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("missing encoded field")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def ace_custody_configured() -> bool:
    return bool((os.getenv(ACE_SEAL_SCALAR_ENV) or "").strip())


def _ace_aad(*, hushh_id: str, key_id: str) -> bytes:
    return json.dumps(
        {
            "alg": _ACE_ALG,
            "custody_mode": CUSTODY_ACE_ENVELOPE,
            "hushh_id": hushh_id,
            "kid": key_id,
            "v": _ACE_ENVELOPE_VERSION,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def seal_ace_dek(
    dek: bytes,
    *,
    custodian_public_bytes: bytes,
    hushh_id: str,
    key_id: str,
) -> bytes:
    """Seal a 32-byte pod DEK to the custodian X25519 public key with owner AAD."""
    from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError  # noqa: PLC0415

    if len(dek) != _KEY_LEN:
        raise ByocKeyCustodyError("the log DEK must be exactly 32 bytes")
    if not hushh_id.strip() or not key_id.strip():
        raise ByocKeyCustodyError("ACE custody requires non-empty hushh_id and key_id")

    from cryptography.hazmat.primitives import hashes, serialization  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric import x25519  # noqa: PLC0415
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    try:
        recipient = x25519.X25519PublicKey.from_public_bytes(custodian_public_bytes)
    except Exception:  # noqa: BLE001
        raise ByocKeyCustodyError("ACE custodian public key is invalid") from None

    ephemeral = x25519.X25519PrivateKey.generate()
    ephemeral_pub = ephemeral.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    shared = ephemeral.exchange(recipient)
    aad = _ace_aad(hushh_id=hushh_id.strip(), key_id=key_id.strip())
    kek = HKDF(
        algorithm=hashes.SHA256(),
        length=_KEY_LEN,
        salt=ephemeral_pub,
        info=_ACE_WRAP_INFO + b"|" + aad,
    ).derive(shared)
    nonce = os.urandom(_ACE_NONCE_LEN)
    ciphertext = AESGCM(kek).encrypt(nonce, dek, aad)
    envelope = {
        "alg": _ACE_ALG,
        "ciphertext": _b64url_encode(ciphertext),
        "epk": _b64url_encode(ephemeral_pub),
        "hushh_id": hushh_id.strip(),
        "kid": key_id.strip(),
        "nonce": _b64url_encode(nonce),
        "v": _ACE_ENVELOPE_VERSION,
    }
    return json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode("utf-8")


def open_ace_dek(
    stored: bytes,
    *,
    custodian_private_bytes: bytes,
    expected_hushh_id: str,
    expected_key_id: str,
) -> bytes:
    """Open a stored ACE DEK envelope, failing closed on any AAD, owner, or key mismatch."""
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric import x25519  # noqa: PLC0415
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError  # noqa: PLC0415

    try:
        envelope = json.loads(stored)
        if (
            not isinstance(envelope, dict)
            or set(envelope) != {"alg", "ciphertext", "epk", "hushh_id", "kid", "nonce", "v"}
            or envelope["alg"] != _ACE_ALG
            or envelope["v"] != _ACE_ENVELOPE_VERSION
        ):
            raise ValueError("envelope shape")
        epk_bytes = _b64url_decode(envelope["epk"])
        nonce = _b64url_decode(envelope["nonce"])
        ciphertext = _b64url_decode(envelope["ciphertext"])
        if len(epk_bytes) != _KEY_LEN or len(nonce) != _ACE_NONCE_LEN:
            raise ValueError("field length")
    except Exception:  # noqa: BLE001
        raise ByocKeyCustodyError("the stored ACE log key envelope is malformed") from None

    if envelope["hushh_id"] != expected_hushh_id.strip():
        raise ByocKeyCustodyError("ACE log key envelope belongs to a different owner pod")
    if envelope["kid"] != expected_key_id.strip():
        raise ByocKeyCustodyError("ACE log key envelope is bound to a different key version")

    try:
        custodian = x25519.X25519PrivateKey.from_private_bytes(custodian_private_bytes)
        peer_epk = x25519.X25519PublicKey.from_public_bytes(epk_bytes)
        shared = custodian.exchange(peer_epk)
        aad = _ace_aad(hushh_id=expected_hushh_id.strip(), key_id=expected_key_id.strip())
        kek = HKDF(
            algorithm=hashes.SHA256(),
            length=_KEY_LEN,
            salt=epk_bytes,
            info=_ACE_WRAP_INFO + b"|" + aad,
        ).derive(shared)
        dek = AESGCM(kek).decrypt(nonce, ciphertext, aad)
    except Exception:  # noqa: BLE001
        raise ByocKeyCustodyError(
            "ACE envelope unwrap failed; refusing to run with a substitute key"
        ) from None

    if len(dek) != _KEY_LEN:
        raise ByocKeyCustodyError("the unwrapped ACE log DEK is not 32 bytes")
    return dek


def refuse_store_after_erasure(store: Any) -> None:
    """Refuse to mint a replacement DEK when a pod crypto-erasure tombstone exists."""
    from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError  # noqa: PLC0415
    from hushh_mcp.services.pod_crypto_erase import ERASURE_TOMBSTONE_OBJECT  # noqa: PLC0415

    if store.get_with_generation_blocking(ERASURE_TOMBSTONE_OBJECT)[0] is not None:
        raise ByocKeyCustodyError("this agent was erased; refusing to mint a replacement key")


@dataclass(frozen=True)
class EnvLogKeyCustodyAdapter:
    """Shared-simulation / ephemeral env key custody."""

    custody_mode: str = CUSTODY_FLEET_HKDF

    def resolve_log_key(self) -> bytes:
        from hushh_mcp.services.pod_commit_log import log_key_from_env  # noqa: PLC0415

        return log_key_from_env()

    def resolve_memory_key(self) -> bytes:
        from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError  # noqa: PLC0415

        raw = (os.getenv("HUSSH_POD_MEMORY_KEY") or "").strip()
        if not raw:
            raise ByocKeyCustodyError("HUSSH_POD_MEMORY_KEY is not set")
        return base64.b64decode(raw)


@dataclass(frozen=True)
class GcpKmsCustodyAdapter:
    """Owner Cloud KMS wrap/unwrap custody with erasure tombstone protection."""

    session: Any = None
    token: Optional[str] = None
    store: Any = None
    custody_mode: str = CUSTODY_OWNER_KMS

    def resolve_log_key(self) -> bytes:
        from hushh_mcp.services.byoc_key_custody import _resolve_gcp_kms_log_key  # noqa: PLC0415

        return _resolve_gcp_kms_log_key(session=self.session, token=self.token, store=self.store)

    def resolve_memory_key(self) -> bytes:
        from hushh_mcp.services.byoc_key_custody import derive_memory_key  # noqa: PLC0415

        return derive_memory_key(self.resolve_log_key())


@dataclass(frozen=True)
class AzureKeyVaultCustodyAdapter:
    """Owner Key Vault local RSA-OAEP-256 wrap + unwrap proof custody."""

    session: Any = None
    store: Any = None
    custody_mode: str = CUSTODY_OWNER_VAULT

    def resolve_log_key(self) -> bytes:
        from hushh_mcp.services.pod_key_vault_custody import (  # noqa: PLC0415
            resolve_key_vault_log_key,
        )

        return resolve_key_vault_log_key(store=self.store, session=self.session)

    def resolve_memory_key(self) -> bytes:
        from hushh_mcp.services.byoc_key_custody import derive_memory_key  # noqa: PLC0415

        return derive_memory_key(self.resolve_log_key())


@dataclass(frozen=True)
class AceEnvelopeCustodyAdapter:
    """Zero-per-user-IAM-SA Attested Custody Envelope (ACE) adapter for hosted pods."""

    store: Any = None
    custodian_private_bytes: Optional[bytes] = None
    hushh_id: Optional[str] = None
    key_id: Optional[str] = None
    custody_mode: str = CUSTODY_ACE_ENVELOPE

    def _resolve_inputs(self) -> tuple[Any, bytes, bytes, str, str, str]:
        from cryptography.hazmat.primitives import serialization  # noqa: PLC0415
        from cryptography.hazmat.primitives.asymmetric import x25519  # noqa: PLC0415

        from hushh_mcp.services.byoc_key_custody import (  # noqa: PLC0415
            WRAPPED_KEY_OBJECT_ENV,
            WRAPPED_LOG_KEY_OBJECT,
            ByocKeyCustodyError,
        )

        private_bytes = self.custodian_private_bytes
        if private_bytes is None:
            raw_scalar = (os.getenv(ACE_SEAL_SCALAR_ENV) or "").strip()
            if not raw_scalar:
                raise ByocKeyCustodyError(f"ACE custody requires {ACE_SEAL_SCALAR_ENV}")
            try:
                private_bytes = _b64url_decode(raw_scalar)
            except Exception:  # noqa: BLE001
                raise ByocKeyCustodyError("ACE seal key encoding is invalid") from None

        if len(private_bytes) != _KEY_LEN:
            raise ByocKeyCustodyError("ACE seal key must be 32 bytes")

        try:
            priv = x25519.X25519PrivateKey.from_private_bytes(private_bytes)
            pub_bytes = priv.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        except Exception:  # noqa: BLE001
            raise ByocKeyCustodyError("ACE seal key material is invalid") from None

        owner_id = (self.hushh_id or os.getenv(ACE_OWNER_ID_ENV) or "").strip()
        kid = (self.key_id or os.getenv(ACE_KEY_ID_ENV) or "ace-v1").strip()
        if not owner_id:
            raise ByocKeyCustodyError(f"ACE custody requires {ACE_OWNER_ID_ENV}")

        store = self.store
        if store is None:
            from hushh_mcp.services.pod_storage import resolve_pod_object_store  # noqa: PLC0415

            store = resolve_pod_object_store()

        obj = (os.getenv(WRAPPED_KEY_OBJECT_ENV) or WRAPPED_LOG_KEY_OBJECT).strip()
        return store, private_bytes, pub_bytes, owner_id, kid, obj

    def resolve_log_key(self) -> bytes:
        from hushh_mcp.services.byoc_key_custody import (  # noqa: PLC0415
            ByocKeyCustodyError,
            generate_dek,
        )

        store, priv_bytes, pub_bytes, owner_id, kid, obj = self._resolve_inputs()
        stored, _ = store.get_with_generation_blocking(obj)
        if stored is not None:
            return open_ace_dek(
                stored,
                custodian_private_bytes=priv_bytes,
                expected_hushh_id=owner_id,
                expected_key_id=kid,
            )

        refuse_store_after_erasure(store)
        dek = generate_dek()
        envelope = seal_ace_dek(
            dek,
            custodian_public_bytes=pub_bytes,
            hushh_id=owner_id,
            key_id=kid,
        )
        # Prove round-trip unwrap before persisting so an unopenable key is never stored.
        if not hmac.compare_digest(
            open_ace_dek(
                envelope,
                custodian_private_bytes=priv_bytes,
                expected_hushh_id=owner_id,
                expected_key_id=kid,
            ),
            dek,
        ):
            raise ByocKeyCustodyError("ACE envelope self-check failed")

        if store.put_if_generation_blocking(obj, envelope, ABSENT) is not None:
            logger.info("ace_custody.log_key_created")
            return dek

        logger.info("ace_custody.log_key_race_lost")
        winner, _ = store.get_with_generation_blocking(obj)
        if winner is None:
            raise ByocKeyCustodyError(
                "another boot claimed the ACE log key, then it could not be read"
            )
        return open_ace_dek(
            winner,
            custodian_private_bytes=priv_bytes,
            expected_hushh_id=owner_id,
            expected_key_id=kid,
        )

    def resolve_memory_key(self) -> bytes:
        from hushh_mcp.services.byoc_key_custody import derive_memory_key  # noqa: PLC0415

        return derive_memory_key(self.resolve_log_key())


@dataclass(frozen=True)
class AwsKmsCustodyAdapter:
    """Owner AWS KMS wrap/unwrap custody with AAD encryption context and tombstone guard."""

    kms_client: Any = None
    store: Any = None
    key_arn: Optional[str] = None
    hushh_id: Optional[str] = None
    custody_mode: str = CUSTODY_OWNER_KMS

    def _resolve_inputs(self) -> tuple[Any, Any, str, dict[str, str], str]:
        from hushh_mcp.services.byoc_key_custody import (  # noqa: PLC0415
            WRAPPED_KEY_OBJECT_ENV,
            WRAPPED_LOG_KEY_OBJECT,
            ByocKeyCustodyError,
        )

        arn = (self.key_arn or os.getenv(AWS_KMS_KEY_ENV) or "").strip()
        if not arn:
            raise ByocKeyCustodyError(f"AWS KMS custody requires {AWS_KMS_KEY_ENV}")
        owner_id = (
            self.hushh_id or os.getenv("HUSSH_ID") or os.getenv(ACE_OWNER_ID_ENV) or ""
        ).strip()
        if not owner_id:
            raise ByocKeyCustodyError("AWS KMS custody requires HUSSH_ID for encryption context")
        store = self.store
        if store is None:
            from hushh_mcp.services.pod_storage import resolve_pod_object_store  # noqa: PLC0415

            store = resolve_pod_object_store()
        client = self.kms_client
        if client is None:
            try:
                import boto3  # type: ignore[import-not-found]
            except ImportError as exc:
                raise ByocKeyCustodyError("boto3 is required for live AWS KMS custody") from exc
            client = boto3.client("kms")
        obj = (os.getenv(WRAPPED_KEY_OBJECT_ENV) or WRAPPED_LOG_KEY_OBJECT).strip()
        context = {"custody_mode": CUSTODY_OWNER_KMS, "hushh_id": owner_id}
        return store, client, arn, context, obj

    @staticmethod
    def _unwrap(client: Any, ciphertext: bytes, *, arn: str, context: dict[str, str]) -> bytes:
        from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError  # noqa: PLC0415

        try:
            resp = client.decrypt(
                CiphertextBlob=ciphertext,
                KeyId=arn,
                EncryptionContext=context,
            )
            dek = bytes(resp["Plaintext"])
        except Exception:  # noqa: BLE001
            raise ByocKeyCustodyError(
                "AWS KMS unwrap failed; refusing to run with a substitute key"
            ) from None
        if len(dek) != _KEY_LEN:
            raise ByocKeyCustodyError("the unwrapped AWS KMS log DEK is not 32 bytes")
        return dek

    def resolve_log_key(self) -> bytes:
        from hushh_mcp.services.byoc_key_custody import (  # noqa: PLC0415
            ByocKeyCustodyError,
            generate_dek,
        )

        store, client, arn, context, obj = self._resolve_inputs()
        stored, _ = store.get_with_generation_blocking(obj)
        if stored is not None:
            return self._unwrap(client, stored, arn=arn, context=context)

        refuse_store_after_erasure(store)
        dek = generate_dek()
        try:
            wrapped = bytes(
                client.encrypt(
                    KeyId=arn,
                    Plaintext=dek,
                    EncryptionContext=context,
                )["CiphertextBlob"]
            )
        except Exception:  # noqa: BLE001
            raise ByocKeyCustodyError("AWS KMS wrap failed") from None

        if not hmac.compare_digest(self._unwrap(client, wrapped, arn=arn, context=context), dek):
            raise ByocKeyCustodyError("AWS KMS round-trip verification failed")

        if store.put_if_generation_blocking(obj, wrapped, ABSENT) is not None:
            logger.info("aws_kms_custody.log_key_created")
            return dek

        logger.info("aws_kms_custody.log_key_race_lost")
        winner, _ = store.get_with_generation_blocking(obj)
        if winner is None:
            raise ByocKeyCustodyError(
                "another boot claimed the AWS KMS log key, then it could not be read"
            )
        return self._unwrap(client, winner, arn=arn, context=context)

    def resolve_memory_key(self) -> bytes:
        from hushh_mcp.services.byoc_key_custody import derive_memory_key  # noqa: PLC0415

        return derive_memory_key(self.resolve_log_key())


def resolve_key_custody_port(
    *,
    session: Any = None,
    token: Optional[str] = None,
    store: Any = None,
    kms_client: Any = None,
) -> KeyCustodyPort:
    """Resolve the single active ``KeyCustodyPort`` for this pod process."""
    from hushh_mcp.services.byoc_key_custody import (  # noqa: PLC0415
        KEY_VAULT_KEY_ENV,
        KMS_KEY_ENV,
        ByocKeyCustodyError,
    )

    explicit_mode = (os.getenv(CUSTODY_MODE_ENV) or "").strip()
    if explicit_mode and explicit_mode not in CUSTODY_MODES:
        raise ByocKeyCustodyError(f"unsupported {CUSTODY_MODE_ENV}: {explicit_mode}")

    has_gcp_kms = bool((os.getenv(KMS_KEY_ENV) or "").strip())
    has_aws_kms = bool((os.getenv(AWS_KMS_KEY_ENV) or "").strip())
    has_vault = bool((os.getenv(KEY_VAULT_KEY_ENV) or "").strip())
    has_ace = ace_custody_configured()
    active_envelopes = int(has_gcp_kms) + int(has_aws_kms) + int(has_vault) + int(has_ace)
    if active_envelopes > 1:
        raise ByocKeyCustodyError("a pod's log key has exactly one custodian")

    if explicit_mode == CUSTODY_OWNER_KMS or (not explicit_mode and (has_gcp_kms or has_aws_kms)):
        if has_aws_kms:
            return AwsKmsCustodyAdapter(kms_client=kms_client, store=store)
        if has_gcp_kms:
            return GcpKmsCustodyAdapter(session=session, token=token, store=store)
        raise ByocKeyCustodyError(
            f"{CUSTODY_OWNER_KMS} requires {KMS_KEY_ENV} or {AWS_KMS_KEY_ENV}"
        )

    if explicit_mode == CUSTODY_OWNER_VAULT or (not explicit_mode and has_vault):
        if not has_vault:
            raise ByocKeyCustodyError(f"{CUSTODY_OWNER_VAULT} requires {KEY_VAULT_KEY_ENV}")
        return AzureKeyVaultCustodyAdapter(session=session, store=store)

    if explicit_mode == CUSTODY_ACE_ENVELOPE or (not explicit_mode and has_ace):
        if not has_ace:
            raise ByocKeyCustodyError(f"{CUSTODY_ACE_ENVELOPE} requires {ACE_SEAL_SCALAR_ENV}")
        return AceEnvelopeCustodyAdapter(store=store)

    mode = explicit_mode or (
        CUSTODY_FLEET_HKDF if (os.getenv("HUSSH_POD_LOG_KEY") or "").strip() else CUSTODY_EPHEMERAL
    )
    return EnvLogKeyCustodyAdapter(custody_mode=mode)
