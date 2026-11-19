# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Wave 3 verification for PodSpec custody_mode, KeyCustodyPort, ACE envelope, and erasure guards."""

from __future__ import annotations

import base64
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import x25519

from hushh_mcp.services.byoc_key_custody import (
    KEY_VAULT_KEY_ENV,
    KMS_KEY_ENV,
    WRAPPED_LOG_KEY_OBJECT,
    ByocKeyCustodyError,
    derive_memory_key,
    resolve_pod_log_key,
    resolve_pod_memory_key,
)
from hushh_mcp.services.compute_backend import (
    BACKEND_GCP,
    BACKEND_NULL,
    BACKEND_USER_AZURE,
    BACKEND_USER_GCP,
    CUSTODY_ACE_ENVELOPE,
    CUSTODY_EPHEMERAL,
    CUSTODY_FLEET_HKDF,
    CUSTODY_OWNER_KMS,
    CUSTODY_OWNER_VAULT,
    PodSpec,
    effective_custody_mode,
)
from hushh_mcp.services.pod_crypto_erase import ERASURE_TOMBSTONE_OBJECT
from hushh_mcp.services.pod_custody_port import (
    ACE_KEY_ID_ENV,
    ACE_OWNER_ID_ENV,
    ACE_SEAL_SCALAR_ENV,
    CUSTODY_MODE_ENV,
    AceEnvelopeCustodyAdapter,
    KeyCustodyPort,
    open_ace_dek,
    resolve_key_custody_port,
    seal_ace_dek,
)
from hushh_mcp.services.pod_object_version import ABSENT, ObjectVersion


class _InMemoryObjectStore:
    def __init__(self, *, lose_first_create: bytes | None = None) -> None:
        self.objects: dict[str, tuple[bytes, int]] = {}
        self.lose_first_create = lose_first_create

    def get_with_generation_blocking(self, name: str) -> tuple[bytes | None, ObjectVersion]:
        item = self.objects.get(name)
        if item is None:
            return None, ABSENT
        return item[0], ObjectVersion(str(item[1]))

    def put_if_generation_blocking(
        self, name: str, data: bytes, expected: ObjectVersion
    ) -> ObjectVersion | None:
        if expected == ABSENT:
            if self.lose_first_create is not None and name not in self.objects:
                self.objects[name] = (self.lose_first_create, 1)
                self.lose_first_create = None
                return None
            if name in self.objects:
                return None
            self.objects[name] = (data, 1)
            return ObjectVersion("1")
        current = self.objects.get(name)
        if current is None or ObjectVersion(str(current[1])) != expected:
            return None
        nxt = current[1] + 1
        self.objects[name] = (data, nxt)
        return ObjectVersion(str(nxt))


def _ace_keypair() -> tuple[bytes, bytes, str]:
    priv = x25519.X25519PrivateKey.generate()
    priv_bytes = priv.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    pub_bytes = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    encoded_priv = base64.urlsafe_b64encode(priv_bytes).decode("ascii").rstrip("=")
    return priv_bytes, pub_bytes, encoded_priv


def test_podspec_custody_mode_triad_and_owner_cloud_guardrails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HUSSH_POD_KEY_MASTER", raising=False)
    default_spec = PodSpec(hushh_id="HA1ACE001", phone_e164_hash="h", pod_pubkey="")
    assert default_spec.custody_mode is None
    assert effective_custody_mode(default_spec) == CUSTODY_EPHEMERAL

    ace_spec = PodSpec(
        hushh_id="HA1ACE001",
        phone_e164_hash="h",
        pod_pubkey="",
        deployment_target=BACKEND_GCP,
        model_credential_mode="byok",
        custody_mode=CUSTODY_ACE_ENVELOPE,
    )
    assert (ace_spec.compute_target, ace_spec.credential_mode, ace_spec.custody_mode) == (
        BACKEND_GCP,
        "byok",
        CUSTODY_ACE_ENVELOPE,
    )
    assert effective_custody_mode(ace_spec) == CUSTODY_ACE_ENVELOPE
    assert (
        effective_custody_mode(
            PodSpec(
                hushh_id="HA1",
                phone_e164_hash="h",
                pod_pubkey="",
                deployment_target=BACKEND_USER_GCP,
            )
        )
        == CUSTODY_OWNER_KMS
    )
    assert (
        effective_custody_mode(
            PodSpec(
                hushh_id="HA1",
                phone_e164_hash="h",
                pod_pubkey="",
                deployment_target=BACKEND_USER_AZURE,
            )
        )
        == CUSTODY_OWNER_VAULT
    )
    assert (
        effective_custody_mode(
            PodSpec(
                hushh_id="HA1", phone_e164_hash="h", pod_pubkey="", deployment_target=BACKEND_NULL
            )
        )
        == CUSTODY_EPHEMERAL
    )

    with pytest.raises(ValueError, match="unrecognized custody_mode"):
        PodSpec(hushh_id="HA1", phone_e164_hash="h", pod_pubkey="", custody_mode="aws_kms_raw")
    with pytest.raises(ValueError, match="cannot use shared fleet_hkdf"):
        PodSpec(
            hushh_id="HA1",
            phone_e164_hash="h",
            pod_pubkey="",
            deployment_target=BACKEND_USER_GCP,
            custody_mode=CUSTODY_FLEET_HKDF,
        )
    with pytest.raises(ValueError, match="cannot use owner_vault"):
        PodSpec(
            hushh_id="HA1",
            phone_e164_hash="h",
            pod_pubkey="",
            deployment_target=BACKEND_USER_GCP,
            custody_mode=CUSTODY_OWNER_VAULT,
        )
    with pytest.raises(ValueError, match="cannot use owner_kms"):
        PodSpec(
            hushh_id="HA1",
            phone_e164_hash="h",
            pod_pubkey="",
            deployment_target=BACKEND_USER_AZURE,
            custody_mode=CUSTODY_OWNER_KMS,
        )


def test_ace_envelope_mints_once_binds_owner_aad_adopts_race_winner_and_refuses_erased_pod(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    priv_bytes, pub_bytes, encoded_priv = _ace_keypair()
    for var in (KMS_KEY_ENV, KEY_VAULT_KEY_ENV):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_ACE_ENVELOPE)
    monkeypatch.setenv(ACE_SEAL_SCALAR_ENV, encoded_priv)
    monkeypatch.setenv(ACE_OWNER_ID_ENV, "HA1HOSTED01")
    monkeypatch.setenv(ACE_KEY_ID_ENV, "ace-cell-us-1")

    store = _InMemoryObjectStore()
    port = resolve_key_custody_port(store=store)
    assert isinstance(port, KeyCustodyPort)
    assert isinstance(port, AceEnvelopeCustodyAdapter)

    dek = resolve_pod_log_key(store=store)
    assert len(dek) == 32
    assert resolve_pod_log_key(store=store) == dek
    assert resolve_pod_memory_key(store=store) == derive_memory_key(dek)

    # Cross-pod substitution check: another pod cannot open HA1HOSTED01's wrapped DEK.
    stored_envelope = store.objects[WRAPPED_LOG_KEY_OBJECT][0]
    with pytest.raises(ByocKeyCustodyError, match="different owner pod"):
        open_ace_dek(
            stored_envelope,
            custodian_private_bytes=priv_bytes,
            expected_hushh_id="HA1OTHER99",
            expected_key_id="ace-cell-us-1",
        )

    # Cold-boot race check: losing boot adopts the winner's envelope.
    winner_dek = b"\x22" * 32
    winner_env = seal_ace_dek(
        winner_dek,
        custodian_public_bytes=pub_bytes,
        hushh_id="HA1HOSTED01",
        key_id="ace-cell-us-1",
    )
    raced_store = _InMemoryObjectStore(lose_first_create=winner_env)
    assert resolve_pod_log_key(store=raced_store) == winner_dek

    # Crypto-erasure check: erased pod never mints a replacement key on 404.
    erased_store = _InMemoryObjectStore()
    erased_store.objects[ERASURE_TOMBSTONE_OBJECT] = (b'{"kind":"pod_crypto_erase_v1"}', 1)
    with pytest.raises(ByocKeyCustodyError, match="erased"):
        resolve_pod_log_key(store=erased_store)


def test_gcp_kms_custody_refuses_to_mint_after_crypto_erasure_and_rejects_dual_custodians(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, encoded_priv = _ace_keypair()
    monkeypatch.setenv(KMS_KEY_ENV, "projects/p/locations/us/keyRings/r/cryptoKeys/k")
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "owner-bucket")
    monkeypatch.delenv(KEY_VAULT_KEY_ENV, raising=False)
    monkeypatch.delenv(ACE_SEAL_SCALAR_ENV, raising=False)
    monkeypatch.delenv(CUSTODY_MODE_ENV, raising=False)

    class _FourOhFourSession:
        def get(self, *_args: Any, **_kw: Any) -> Any:
            return type("Resp", (), {"status_code": 404})()

    borrowed_token = "".join(("synthetic", "-", "token"))
    erased_store = _InMemoryObjectStore()
    erased_store.objects[ERASURE_TOMBSTONE_OBJECT] = (b'{"kind":"pod_crypto_erase_v1"}', 1)
    with pytest.raises(ByocKeyCustodyError, match="erased"):
        resolve_pod_log_key(session=_FourOhFourSession(), token=borrowed_token, store=erased_store)

    # Ambiguous multi-custodian configuration fails closed.
    monkeypatch.setenv(ACE_SEAL_SCALAR_ENV, encoded_priv)
    with pytest.raises(ByocKeyCustodyError, match="exactly one custodian"):
        resolve_key_custody_port()
