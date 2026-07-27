"""Tests for the pod storage & sync seam (contract shape; inert Null backend).

Confirms the three-replica plan (cloud-backup-of-record + pod cache + device over
the private tunnel, zero-knowledge), that the Null backend moves no data, that the
resolver defaults to Null and fails loud on an unknown backend, and — as a
legibility guard — that the cross-boundary struct carries a ciphertext pointer
with NO plaintext field."""

from __future__ import annotations

import dataclasses

import pytest

from hushh_mcp.services.pod_storage import (
    BACKEND_NULL,
    ROLE_CLOUD_BACKUP,
    ROLE_DEVICE,
    ROLE_POD_CACHE,
    TUNNEL_RELAY_TICKET,
    EncryptedBlobRef,
    NullPodStorage,
    resolve_pod_storage,
)

_HUSHH = "e2eowner01"


def test_sync_plan_three_replicas_zero_knowledge():
    plan = NullPodStorage().render_sync_plan(_HUSHH, pod_key_id="podkey-1").as_dict()
    assert plan["replicas"] == [ROLE_CLOUD_BACKUP, ROLE_POD_CACHE, ROLE_DEVICE]
    assert plan["backupOfRecord"] == ROLE_CLOUD_BACKUP  # the vault is the durable backup
    assert plan["tunnel"] == TUNNEL_RELAY_TICKET
    assert plan["zeroKnowledge"] is True
    assert "pod isolated process" in plan["notes"]["plaintextLocations"]


async def test_null_backend_moves_no_data():
    store = NullPodStorage()
    blob = EncryptedBlobRef(ref="vault://x", wrapping_key_id="podkey-1", alg="x25519")
    out = await store.backup(_HUSHH, blob)
    assert out["status"] == "planned" and out["backend"] == BACKEND_NULL
    assert await store.restore(_HUSHH) is None


def test_resolver_defaults_to_null(monkeypatch):
    monkeypatch.delenv("POD_STORAGE_BACKEND", raising=False)
    assert isinstance(resolve_pod_storage(), NullPodStorage)


def test_resolver_fails_loud_on_unknown(monkeypatch):
    monkeypatch.setenv("POD_STORAGE_BACKEND", "s3-mystery")
    with pytest.raises(NotImplementedError):
        resolve_pod_storage()


def test_encrypted_blob_ref_has_no_plaintext_field():
    # Legibility guard: the only cross-boundary struct is a ciphertext pointer.
    names = {f.name for f in dataclasses.fields(EncryptedBlobRef)}
    assert "ref" in names and "wrapping_key_id" in names
    assert not (names & {"plaintext", "data", "content", "decrypted", "value"})
