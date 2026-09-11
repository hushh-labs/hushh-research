"""A migrated agent has the SAME history, proved by hash rather than by counting.

The property under test is the one the whole migration rests on: a commit log
rebuilt in a different cloud, under a different seal key, in a different project,
produces a byte-identical chain head. That works because `PodCommitLog`'s chain
hash covers plaintext-keyed fields only ({seq, kind, payload, prev_sha}) -- the
ciphertext, the nonce and the object key are all outside it.

If that ever stops being true, this file goes red and the migration must stop
claiming zero loss, because the oracle would have become a coincidence.

THE NEGATIVE CONTROLS MATTER AS MUCH AS THE POSITIVE ONE. An oracle that cannot
fail proves nothing, so several tests here corrupt a bundle on purpose and assert
the import refuses. A migration that silently accepted a truncated bundle would
report success and hand someone a shorter agent.
"""

from __future__ import annotations

import base64
import copy

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
from hushh_mcp.services.pod_migration_bundle import (
    PodMigrationBundleError,
    head_sha_of,
    open_bundle,
    seal_bundle,
    verify_rebuilt_head,
)

_FACTS = [
    ("memory_record", {"text": "prefers window seats", "at": 1}),
    ("storage_pointer", {"ref": "blob-1", "alg": "AES-256-GCM"}),
    ("memory_record", {"text": "allergic to shellfish", "at": 2}),
    ("agent_chat_message", {"role": "user", "text": "remind me about the visa"}),
]


async def _log_with_history(tmp_path, key: bytes, name: str) -> PodCommitLog:
    log = PodCommitLog(LocalObjectStore(str(tmp_path / name)), key)
    for kind, payload in _FACTS:
        await log.append(kind, payload)
    return log


def _empty_log(tmp_path, key: bytes, name: str) -> PodCommitLog:
    return PodCommitLog(LocalObjectStore(str(tmp_path / name)), key)


# --------------------------------------------------------------------------- #
# The property: same history, different key, identical head.
# --------------------------------------------------------------------------- #


async def test_a_migrated_log_has_a_byte_identical_head(tmp_path):
    """The whole migration in one assertion.

    Two different seal keys, two different object stores -- standing in for two
    different clouds -- and the same chain head, because the hash never covered
    the sealing in the first place.
    """
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()
    source_head = head_sha_of(records)

    destination_keys = generate_pod_keypair()
    envelope, receipt = seal_bundle(
        records=records,
        head_sha=source_head,
        recipient_public_key_b64=destination_keys.public_key_b64,
        recipient_key_id=destination_keys.key_id,
    )

    opened, carried_head, count = open_bundle(
        envelope,
        private_key=destination_keys.private_key,
        expected_key_id=destination_keys.key_id,
    )
    assert carried_head == source_head
    assert count == len(_FACTS)

    # A different key entirely: the destination pod minted its own.
    destination = _empty_log(tmp_path, b"D" * 32, "destination")
    written = None
    for record in opened:
        written = await destination.append(record["kind"], record["payload"])

    assert written["sha"] == source_head, "the rebuilt chain head diverged from the source"
    verify_rebuilt_head(source_head_sha=source_head, target_head_sha=written["sha"])
    assert receipt.record_count == len(_FACTS)


async def test_the_migrated_log_replays_with_every_record_intact(tmp_path):
    """Head equality is the proof; this is what it is proof OF."""
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()

    keys = generate_pod_keypair()
    envelope, _ = seal_bundle(
        records=records,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=keys.public_key_b64,
        recipient_key_id=keys.key_id,
    )
    opened, _, _ = open_bundle(envelope, private_key=keys.private_key, expected_key_id=keys.key_id)

    destination = _empty_log(tmp_path, b"D" * 32, "destination")
    for record in opened:
        await destination.append(record["kind"], record["payload"])

    rebuilt = await destination.replay()
    assert [(r["kind"], r["payload"]) for r in rebuilt] == _FACTS
    assert [r["sha"] for r in rebuilt] == [r["sha"] for r in records]


# --------------------------------------------------------------------------- #
# The hub can carry it and cannot read it.
# --------------------------------------------------------------------------- #


async def test_the_envelope_carries_no_readable_content(tmp_path):
    """What the hub holds while ferrying: ciphertext and coordinates.

    The honesty clause is engineered, not asserted -- so the bundle is checked
    for the plaintext it must not contain.
    """
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()
    keys = generate_pod_keypair()

    envelope, _ = seal_bundle(
        records=records,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=keys.public_key_b64,
        recipient_key_id=keys.key_id,
    )

    blob = repr(envelope)
    for secret_text in ("window seats", "shellfish", "visa", "memory_record"):
        assert secret_text not in blob, f"{secret_text!r} is readable in the ferried envelope"
    assert set(envelope) == {
        "version",
        "alg",
        "recipientKeyId",
        "ephemeralPublicKey",
        "nonce",
        "ciphertext",
    }


async def test_a_bundle_addressed_elsewhere_is_refused_by_name(tmp_path):
    """Wrong-recipient and tampered-bundle need different operator answers, so
    they get different failures rather than one opaque tag error."""
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()
    intended = generate_pod_keypair()
    someone_else = generate_pod_keypair()

    envelope, _ = seal_bundle(
        records=records,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=intended.public_key_b64,
        recipient_key_id=intended.key_id,
    )

    with pytest.raises(PodMigrationBundleError, match="addressed to pod key"):
        open_bundle(
            envelope,
            private_key=someone_else.private_key,
            expected_key_id=someone_else.key_id,
        )


async def test_the_wrong_private_key_cannot_open_a_correctly_addressed_bundle(tmp_path):
    """Holding the label is not holding the key.

    Someone who learned the destination's key ID (it is public -- the hub stores
    it) must still be unable to read the bundle.
    """
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()
    intended = generate_pod_keypair()

    envelope, _ = seal_bundle(
        records=records,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=intended.public_key_b64,
        recipient_key_id=intended.key_id,
    )

    impostor = X25519PrivateKey.generate()
    with pytest.raises(PodMigrationBundleError, match="failed authenticated decryption"):
        open_bundle(envelope, private_key=impostor, expected_key_id=intended.key_id)


# --------------------------------------------------------------------------- #
# Negative controls. An oracle that cannot fail proves nothing.
# --------------------------------------------------------------------------- #


async def test_one_corrupted_byte_is_refused(tmp_path):
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()
    keys = generate_pod_keypair()
    envelope, _ = seal_bundle(
        records=records,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=keys.public_key_b64,
        recipient_key_id=keys.key_id,
    )

    raw = bytearray(base64.b64decode(envelope["ciphertext"]))
    raw[len(raw) // 2] ^= 0x01  # exactly one bit
    corrupted = {**envelope, "ciphertext": base64.b64encode(bytes(raw)).decode("utf-8")}

    with pytest.raises(PodMigrationBundleError, match="failed authenticated decryption"):
        open_bundle(corrupted, private_key=keys.private_key, expected_key_id=keys.key_id)


async def test_a_truncated_bundle_is_refused(tmp_path):
    """The failure that would otherwise be invisible: a SHORTER agent.

    A truncation that still decrypted would hand someone an agent missing its
    most recent memories, and every count in the system would agree with itself.
    """
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()
    keys = generate_pod_keypair()
    envelope, _ = seal_bundle(
        records=records,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=keys.public_key_b64,
        recipient_key_id=keys.key_id,
    )

    raw = base64.b64decode(envelope["ciphertext"])
    truncated = {**envelope, "ciphertext": base64.b64encode(raw[:-16]).decode("utf-8")}

    with pytest.raises(PodMigrationBundleError):
        open_bundle(truncated, private_key=keys.private_key, expected_key_id=keys.key_id)


async def test_a_relabelled_bundle_is_refused(tmp_path):
    """The recipient key id is authenticated data, so re-addressing breaks the tag
    rather than silently redirecting someone's memory to another pod."""
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()
    keys = generate_pod_keypair()
    other = generate_pod_keypair()
    envelope, _ = seal_bundle(
        records=records,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=keys.public_key_b64,
        recipient_key_id=keys.key_id,
    )

    relabelled = {**envelope, "recipientKeyId": other.key_id}
    with pytest.raises(PodMigrationBundleError):
        open_bundle(relabelled, private_key=keys.private_key, expected_key_id=other.key_id)


async def test_a_dropped_record_breaks_the_head_even_if_it_decrypts(tmp_path):
    """The deepest control: a bundle that opens cleanly but is missing a record.

    Built by re-sealing a short list, so authenticated decryption SUCCEEDS. Only
    the head comparison catches it -- which is exactly the job the head sha has,
    and the reason a record count alone would not be enough.
    """
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()
    keys = generate_pod_keypair()

    short = copy.deepcopy(records)[:-1]
    envelope, _ = seal_bundle(
        records=short,
        # The head claimed is the FULL log's -- a lie the import must catch.
        head_sha=head_sha_of(records),
        recipient_public_key_b64=keys.public_key_b64,
        recipient_key_id=keys.key_id,
    )

    opened, claimed_head, _ = open_bundle(
        envelope, private_key=keys.private_key, expected_key_id=keys.key_id
    )
    destination = _empty_log(tmp_path, b"D" * 32, "destination")
    written = None
    for record in opened:
        written = await destination.append(record["kind"], record["payload"])

    assert written["sha"] != claimed_head
    with pytest.raises(PodMigrationBundleError, match="does not match the source"):
        verify_rebuilt_head(source_head_sha=claimed_head, target_head_sha=written["sha"])


async def test_reordered_records_are_refused_before_anything_is_written(tmp_path):
    """Order is part of the history. A reordered bundle must never reach `append`,
    because a half-written log is worse than a refused migration."""
    source = await _log_with_history(tmp_path, b"S" * 32, "source")
    records = await source.replay()
    keys = generate_pod_keypair()

    shuffled = [records[1], records[0], *records[2:]]
    envelope, _ = seal_bundle(
        records=shuffled,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=keys.public_key_b64,
        recipient_key_id=keys.key_id,
    )

    with pytest.raises(PodMigrationBundleError, match="not contiguous"):
        open_bundle(envelope, private_key=keys.private_key, expected_key_id=keys.key_id)


async def test_an_empty_export_is_refused(tmp_path):
    """An empty log is almost always a misconfiguration wearing the costume of a
    successful no-op -- wrong bucket, wrong prefix, a pod that never wrote."""
    keys = generate_pod_keypair()
    with pytest.raises(PodMigrationBundleError, match="empty log"):
        seal_bundle(
            records=[],
            head_sha="",
            recipient_public_key_b64=keys.public_key_b64,
            recipient_key_id=keys.key_id,
        )


def test_a_missing_head_never_authorizes_a_switch():
    """The switch gate refuses absence as loudly as it refuses a mismatch.

    Two empty strings compare equal, and an `==` check alone would have read
    "nothing was proved" as "everything matched".
    """
    with pytest.raises(PodMigrationBundleError, match="missing"):
        verify_rebuilt_head(source_head_sha="", target_head_sha="")
    with pytest.raises(PodMigrationBundleError, match="missing"):
        verify_rebuilt_head(source_head_sha="abc", target_head_sha="")
