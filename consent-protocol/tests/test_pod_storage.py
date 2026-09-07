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
    assert (
        plan["backupOfRecord"] == ROLE_CLOUD_BACKUP
    )  # the user's own cloud copy is the durable backup-of-record
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


def test_resolver_uses_tier_agnostic_key_resolution_for_byoc(monkeypatch, tmp_path):
    """BYOC custody (KMS key set, NO env log key) must still build the commit log.

    THE defect this pins: ``resolve_pod_storage`` used to call
    ``log_key_from_env()`` directly, which raises whenever ``HUSSH_POD_LOG_KEY``
    is absent -- and a BYOC pod is deliberately provisioned WITHOUT that env (it
    gets ``HUSSH_POD_KMS_KEY`` + a wrapped key object instead). The tier-agnostic
    ``byoc_key_custody.resolve_pod_log_key`` existed and had zero production
    callers, so every BYOC pod's memory build failed silently and the pod served
    turns that it forgot (observed live: a CMEK bucket a serving BYOC pod never
    wrote to). Storage resolution must route through the resolver that knows
    both custody models.
    """
    monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
    monkeypatch.setenv("POD_STORAGE_LOCAL_ROOT", str(tmp_path))
    monkeypatch.delenv("POD_STORAGE_GCS_BUCKET", raising=False)
    # BYOC shape: KMS custody configured, env log key absent.
    monkeypatch.setenv("HUSSH_POD_KMS_KEY", "projects/p/locations/l/keyRings/r/cryptoKeys/k")
    monkeypatch.delenv("HUSSH_POD_LOG_KEY", raising=False)

    sentinel = b"\x42" * 32
    calls: list[bool] = []

    def _fake_resolve_pod_log_key(**_kw):
        calls.append(True)
        return sentinel

    import hushh_mcp.services.byoc_key_custody as custody

    monkeypatch.setattr(custody, "resolve_pod_log_key", _fake_resolve_pod_log_key)

    storage = resolve_pod_storage()

    # The tier-agnostic resolver was actually consulted (it had zero callers),
    # and the storage that came back is the real commit-log backend.
    assert calls == [True]
    assert type(storage).__name__ == "CommitLogPodStorage"


def test_resolver_still_reads_env_key_for_managed(monkeypatch, tmp_path):
    """Managed custody (env log key, no KMS) keeps working through the same path."""
    monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
    monkeypatch.setenv("POD_STORAGE_LOCAL_ROOT", str(tmp_path))
    monkeypatch.delenv("POD_STORAGE_GCS_BUCKET", raising=False)
    monkeypatch.delenv("HUSSH_POD_KMS_KEY", raising=False)
    import base64

    monkeypatch.setenv("HUSSH_POD_LOG_KEY", base64.b64encode(b"\x24" * 32).decode())

    storage = resolve_pod_storage()
    assert type(storage).__name__ == "CommitLogPodStorage"
