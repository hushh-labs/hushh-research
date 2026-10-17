"""The range bundle: secrecy to the standby, origin from the primary, continuity from the base.

Each refusal below is asserted at the point it must happen. Cross-replay between the
whole-log bundle and the range bundle is asserted to fail at authenticated
decryption (the cause is ``InvalidTag``), with every label made to look right first,
so the test proves the key separation rather than a version-string check.
"""

from __future__ import annotations

import base64
import copy

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from hushh_mcp.services import pod_sync_bundle
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
from hushh_mcp.services.pod_migration_bundle import (
    BUNDLE_VERSION,
    PodMigrationBundleError,
    open_bundle,
    seal_bundle,
)
from hushh_mcp.services.pod_request_signing import public_key_b64, signing_key_id
from hushh_mcp.services.pod_sync_bundle import (
    RANGE_VERSION,
    PodSyncBundleError,
    open_range_bundle,
    seal_range_bundle,
)

_FACTS = [
    ("memory_record", {"text": "prefers window seats", "at": 1}),
    ("storage_pointer", {"ref": "blob-1"}),
    ("memory_record", {"text": "allergic to shellfish", "at": 2}),
    ("agent_chat_message", {"role": "user", "text": "remind me about the visa"}),
    ("memory_record", {"text": "flies out on the 9th", "at": 3}),
]


async def _records(tmp_path) -> list[dict]:
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "primary")), b"P" * 32)
    for kind, payload in _FACTS:
        await log.append(kind, payload)
    return await log.replay()


async def test_browser_range_refuses_export_and_authenticated_older_peer_import(
    tmp_path, monkeypatch
):
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()
    browser_records = copy.deepcopy(records)
    browser_records[0]["kind"] = "browser_session_v1"
    with pytest.raises(PodSyncBundleError, match="object transfer is not qualified"):
        _seal(browser_records, 0, standby, signer)

    canonical = pod_sync_bundle._canonical

    def older_payload(value):
        if "records" in value:
            value = copy.deepcopy(value)
            value["records"][0]["kind"] = "browser_session_v1"
        return canonical(value)

    monkeypatch.setattr(pod_sync_bundle, "_canonical", older_payload)
    envelope = _seal(records, 0, standby, signer)
    with pytest.raises(PodSyncBundleError, match="object transfer is not qualified"):
        _open(envelope, standby, signer)


def _seal(records, base_seq, standby, signer, **overrides):
    base_sha = records[base_seq - 1]["sha"] if base_seq else ""
    kwargs = dict(
        records=records[base_seq:],
        base_seq=base_seq,
        base_head_sha=base_sha,
        recipient_public_key_b64=standby.public_key_b64,
        recipient_key_id=standby.key_id,
        signing_key=signer,
    )
    kwargs.update(overrides)
    return seal_range_bundle(**kwargs)


def _open(envelope, standby, signer):
    return open_range_bundle(
        envelope,
        private_key=standby.private_key,
        expected_key_id=standby.key_id,
        pinned_signing_key_id=signing_key_id(public_key_b64(signer)),
    )


async def test_a_range_round_trips_and_chains_from_its_base(tmp_path):
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()

    contents = _open(_seal(records, 2, standby, signer), standby, signer)

    assert (contents.base_seq, contents.head_seq) == (2, 5)
    assert contents.base_head_sha == records[1]["sha"]
    assert contents.head_sha == records[-1]["sha"]
    assert [r["seq"] for r in contents.records] == [3, 4, 5]
    assert [(r["kind"], r["payload"]) for r in contents.records] == _FACTS[2:]
    assert contents.chain == {r["seq"]: r["sha"] for r in records[1:]}


async def test_a_range_from_the_empty_log_starts_at_sequence_one(tmp_path):
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()

    contents = _open(_seal(records, 0, standby, signer), standby, signer)

    assert contents.base_head_sha == "" and contents.chain[0] == ""
    assert contents.head_sha == records[-1]["sha"]


async def test_a_forked_base_is_refused_at_the_source(tmp_path):
    """Negative control: records that do not chain from the claimed base never ship."""
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()

    with pytest.raises(PodSyncBundleError, match="does not chain"):
        _seal(records, 2, standby, signer, base_head_sha="a" * 64)


async def test_an_empty_range_is_refused(tmp_path):
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()

    with pytest.raises(PodSyncBundleError, match="empty range"):
        _seal(records, 5, standby, signer)


async def test_tampered_ciphertext_is_refused_at_decryption(tmp_path, monkeypatch):
    """Re-signed after tampering, so the refusal is the AEAD tag, not the signature."""
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()
    envelope = _seal(records, 1, standby, signer)
    raw = bytearray(base64.b64decode(envelope["ciphertext"]))
    raw[5] ^= 0x01
    envelope["ciphertext"] = base64.b64encode(bytes(raw)).decode()
    envelope["signature"] = base64.b64encode(
        signer.sign(pod_sync_bundle._signed_statement(envelope))
    ).decode()

    with pytest.raises(PodSyncBundleError, match="authenticated decryption") as error:
        _open(envelope, standby, signer)
    assert isinstance(error.value.__cause__, InvalidTag)


async def test_tampering_without_resigning_is_refused_before_decryption(tmp_path, monkeypatch):
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()
    envelope = _seal(records, 1, standby, signer)
    raw = bytearray(base64.b64decode(envelope["ciphertext"]))
    raw[0] ^= 0x01
    envelope["ciphertext"] = base64.b64encode(bytes(raw)).decode()
    decrypted = []
    monkeypatch.setattr(pod_sync_bundle, "_decrypt", lambda *a: decrypted.append(a))

    with pytest.raises(PodSyncBundleError, match="signature does not verify"):
        _open(envelope, standby, signer)
    assert decrypted == []


@pytest.mark.parametrize("mutation", ["unsigned", "other_signer", "relabelled_signer"])
async def test_an_unsigned_or_wrongly_signed_range_is_refused(tmp_path, monkeypatch, mutation):
    """The hub knows the standby's public key, so sealing alone cannot prove origin."""
    records = await _records(tmp_path)
    standby, primary = generate_pod_keypair(), Ed25519PrivateKey.generate()
    impostor = Ed25519PrivateKey.generate()
    if mutation == "unsigned":
        envelope = _seal(records, 1, standby, primary)
        envelope.pop("signer")
        envelope.pop("signature")
    elif mutation == "other_signer":
        envelope = _seal(records, 1, standby, impostor)
    else:
        envelope = _seal(records, 1, standby, impostor)
        envelope["signer"]["keyId"] = signing_key_id(public_key_b64(primary))
    decrypted = []
    monkeypatch.setattr(pod_sync_bundle, "_decrypt", lambda *a: decrypted.append(a))

    with pytest.raises(PodSyncBundleError):
        _open(envelope, standby, primary)
    assert decrypted == [], "an unverified origin must never reach decryption"


async def test_relabelled_coordinates_break_the_signature(tmp_path):
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()
    envelope = _seal(records, 2, standby, signer)
    envelope["baseSeq"], envelope["baseHeadSha"] = 1, records[0]["sha"]

    with pytest.raises(PodSyncBundleError, match="signature does not verify"):
        _open(envelope, standby, signer)


async def test_a_range_for_another_standby_is_refused(tmp_path):
    records = await _records(tmp_path)
    standby, other, signer = (
        generate_pod_keypair(),
        generate_pod_keypair(),
        Ed25519PrivateKey.generate(),
    )

    with pytest.raises(PodSyncBundleError, match="different pod key"):
        _open(_seal(records, 1, standby, signer), other, signer)


async def test_a_whole_log_bundle_presented_as_a_range_fails_at_decryption(tmp_path):
    """Every label is made right and the envelope is validly signed by the pinned
    primary; only the HKDF info and AAD differ. Decryption is where it must fail."""
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()
    whole, _ = seal_bundle(
        records=records,
        head_sha=records[-1]["sha"],
        recipient_public_key_b64=standby.public_key_b64,
        recipient_key_id=standby.key_id,
    )
    forged = _seal(records, 0, standby, signer)
    for field in ("ephemeralPublicKey", "nonce", "ciphertext"):
        forged[field] = whole[field]
    forged["signature"] = base64.b64encode(
        signer.sign(pod_sync_bundle._signed_statement(forged))
    ).decode()

    with pytest.raises(PodSyncBundleError, match="authenticated decryption") as error:
        _open(forged, standby, signer)
    assert isinstance(error.value.__cause__, InvalidTag)


async def test_a_range_presented_as_a_whole_log_bundle_fails_at_decryption(tmp_path):
    records = await _records(tmp_path)
    standby, signer = generate_pod_keypair(), Ed25519PrivateKey.generate()
    forged = copy.deepcopy(_seal(records, 0, standby, signer))
    forged["version"] = BUNDLE_VERSION

    with pytest.raises(PodMigrationBundleError, match="authenticated decryption") as error:
        open_bundle(forged, private_key=standby.private_key, expected_key_id=standby.key_id)
    assert isinstance(error.value.__cause__, InvalidTag)


def test_the_range_has_its_own_version_and_key_derivation():
    assert RANGE_VERSION != BUNDLE_VERSION
    assert pod_sync_bundle._HKDF_INFO == b"hussh.pod.sync.range.v1"
