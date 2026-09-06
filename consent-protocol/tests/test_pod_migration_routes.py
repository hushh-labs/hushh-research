"""The in-pod migration surface: dark by default, fail-closed, and hard to misuse.

These two routes are the only place a person's agent memory is ever decrypted for
transport, so the tests here are mostly about REFUSALS. What they assert, in
order of how badly the failure would go:

  * refusing to import over an existing history -- appending would interleave two
    people's memories into one chain that verifies perfectly and is wrong;
  * refusing to seal to this pod's own key -- a loop that reports success while
    moving nothing;
  * fail-closed auth, the same scheduler identity `/pod/tick` uses;
  * dark by default, and 404 rather than 403 so probing tells nobody which pods
    are migration-capable.
"""

from __future__ import annotations

import os

import pytest
from fastapi import HTTPException

os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

from api.routes.one import pod_migration  # noqa: E402
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog  # noqa: E402
from hushh_mcp.services.pod_connector_keypair_service import (  # noqa: E402
    generate_pod_keypair,
)
from hushh_mcp.services.pod_migration_bundle import head_sha_of, seal_bundle  # noqa: E402


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MIGRATION_ENABLED", "1")
    # The hub caller check is exercised on its own below; neutralise it here so
    # each test asserts one thing.
    monkeypatch.setattr(pod_migration, "_require_hub_caller", lambda _auth: None)
    return monkeypatch


def _own_keys(monkeypatch, keypair):
    monkeypatch.setattr("hushh_mcp.services.pod_self_registration.pod_keypair", lambda: keypair)


def _mount_log(monkeypatch, log):
    monkeypatch.setattr(pod_migration, "_commit_log", lambda: log)


# --------------------------------------------------------------------------- #
# Dark by default
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("value", ["", "0", "false", "no", "maybe"])
async def test_the_surface_is_absent_until_a_lane_turns_it_on(monkeypatch, value):
    monkeypatch.setenv("HUSSH_POD_MIGRATION_ENABLED", value)

    with pytest.raises(HTTPException) as excinfo:
        await pod_migration.export_log(
            request=None,
            body=pod_migration.ExportRequest(
                recipientPublicKey="A" * 44, recipientKeyId="pod-key-1"
            ),
            x_hussh_hub_proof="Bearer x",
        )

    # 404, not 403: an off surface should be indistinguishable from one that does
    # not exist, so probing reveals nothing about which pods can migrate.
    assert excinfo.value.status_code == 404


# --------------------------------------------------------------------------- #
# Fail-closed auth
# --------------------------------------------------------------------------- #


async def test_an_unauthenticated_caller_is_refused(monkeypatch):
    """No audience and no allowlist configured means the verifier refuses
    everything, so a pod deployed without the migration wiring declines rather
    than doing unauthenticated work with its own memory."""
    monkeypatch.setenv("HUSSH_POD_MIGRATION_ENABLED", "1")
    monkeypatch.delenv("HUSSH_POD_TICK_AUDIENCE", raising=False)
    monkeypatch.delenv("HUSSH_POD_TICK_ALLOWED_EMAILS", raising=False)

    with pytest.raises(HTTPException) as excinfo:
        await pod_migration.export_log(
            request=None,
            body=pod_migration.ExportRequest(
                recipientPublicKey="A" * 44, recipientKeyId="pod-key-1"
            ),
            x_hussh_hub_proof=None,
        )

    assert excinfo.value.status_code == 403


# --------------------------------------------------------------------------- #
# Export refusals
# --------------------------------------------------------------------------- #


async def test_exporting_to_ourselves_is_refused(enabled, tmp_path):
    """A loop dressed as a migration. It would report success and move nothing."""
    keys = generate_pod_keypair()
    _own_keys(enabled, keys)
    _mount_log(enabled, PodCommitLog(LocalObjectStore(str(tmp_path / "s")), b"S" * 32))

    with pytest.raises(HTTPException) as excinfo:
        await pod_migration.export_log(
            request=None,
            body=pod_migration.ExportRequest(
                recipientPublicKey=keys.public_key_b64, recipientKeyId=keys.key_id
            ),
            x_hussh_hub_proof="Bearer x",
        )

    assert excinfo.value.status_code == 400
    assert "this pod" in str(excinfo.value.detail)


async def test_a_broken_chain_is_refused_before_anything_is_sealed(enabled, tmp_path):
    """Order matters: a bundle built from an unverified log is a broken chain
    that someone now trusts. `replay` raises, and the export stops there."""
    keys = generate_pod_keypair()
    _own_keys(enabled, keys)

    class _Tampered:
        async def replay(self):
            from hushh_mcp.services.pod_commit_log import PodLogTampered

            raise PodLogTampered("hash chain broke at seq 3")

    _mount_log(enabled, _Tampered())

    other = generate_pod_keypair()
    with pytest.raises(HTTPException) as excinfo:
        await pod_migration.export_log(
            request=None,
            body=pod_migration.ExportRequest(
                recipientPublicKey=other.public_key_b64, recipientKeyId=other.key_id
            ),
            x_hussh_hub_proof="Bearer x",
        )

    assert excinfo.value.status_code == 409
    assert "did not verify" in str(excinfo.value.detail)


async def test_an_export_returns_ciphertext_and_coordinates(enabled, tmp_path):
    keys = generate_pod_keypair()
    destination = generate_pod_keypair()
    _own_keys(enabled, keys)

    log = PodCommitLog(LocalObjectStore(str(tmp_path / "s")), b"S" * 32)
    await log.append("memory_record", {"text": "prefers window seats"})
    _mount_log(enabled, log)

    result = await pod_migration.export_log(
        request=None,
        body=pod_migration.ExportRequest(
            recipientPublicKey=destination.public_key_b64,
            recipientKeyId=destination.key_id,
        ),
        x_hussh_hub_proof="Bearer x",
    )

    assert result["recordCount"] == 1
    assert result["recipientKeyId"] == destination.key_id
    assert result["headSha"]
    assert "window seats" not in repr(result["bundle"])


# --------------------------------------------------------------------------- #
# Import refusals -- the worst failure this code could have
# --------------------------------------------------------------------------- #


async def test_importing_over_an_existing_history_is_refused(enabled, tmp_path):
    """The failure that would be invisible AND permanent.

    Appending onto a log that already has records interleaves two agents'
    memories into one chain that verifies perfectly and belongs to nobody. There
    is no repair afterwards, so the refusal is the feature.
    """
    destination_keys = generate_pod_keypair()
    _own_keys(enabled, destination_keys)

    occupied = PodCommitLog(LocalObjectStore(str(tmp_path / "d")), b"D" * 32)
    await occupied.append("memory_record", {"text": "someone else's memory"})
    _mount_log(enabled, occupied)

    source = PodCommitLog(LocalObjectStore(str(tmp_path / "s")), b"S" * 32)
    await source.append("memory_record", {"text": "incoming"})
    records = await source.replay()
    envelope, _ = seal_bundle(
        records=records,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=destination_keys.public_key_b64,
        recipient_key_id=destination_keys.key_id,
    )

    with pytest.raises(HTTPException) as excinfo:
        await pod_migration.import_log(
            request=None,
            body=pod_migration.ImportRequest(bundle=envelope),
            x_hussh_hub_proof="Bearer x",
        )

    assert excinfo.value.status_code == 409
    assert "existing history" in str(excinfo.value.detail)
    # And nothing was written: the occupant's log is untouched.
    assert len(await occupied.replay()) == 1


async def test_an_import_rebuilds_the_identical_head(enabled, tmp_path):
    """The end-to-end proof, through the routes rather than the library."""
    destination_keys = generate_pod_keypair()
    _own_keys(enabled, destination_keys)

    source = PodCommitLog(LocalObjectStore(str(tmp_path / "s")), b"S" * 32)
    for i in range(3):
        await source.append("memory_record", {"text": f"fact {i}"})
    records = await source.replay()
    source_head = head_sha_of(records)
    envelope, _ = seal_bundle(
        records=records,
        head_sha=source_head,
        recipient_public_key_b64=destination_keys.public_key_b64,
        recipient_key_id=destination_keys.key_id,
    )

    destination = PodCommitLog(LocalObjectStore(str(tmp_path / "d")), b"D" * 32)
    _mount_log(enabled, destination)

    result = await pod_migration.import_log(
        request=None,
        body=pod_migration.ImportRequest(bundle=envelope),
        x_hussh_hub_proof="Bearer x",
    )

    assert result["headSha"] == source_head
    assert result["matchesSource"] is True
    assert result["recordCount"] == 3


async def test_a_bundle_for_another_pod_is_refused(enabled, tmp_path):
    ours = generate_pod_keypair()
    theirs = generate_pod_keypair()
    _own_keys(enabled, ours)
    _mount_log(enabled, PodCommitLog(LocalObjectStore(str(tmp_path / "d")), b"D" * 32))

    source = PodCommitLog(LocalObjectStore(str(tmp_path / "s")), b"S" * 32)
    await source.append("memory_record", {"text": "not for us"})
    records = await source.replay()
    envelope, _ = seal_bundle(
        records=records,
        head_sha=head_sha_of(records),
        recipient_public_key_b64=theirs.public_key_b64,
        recipient_key_id=theirs.key_id,
    )

    with pytest.raises(HTTPException) as excinfo:
        await pod_migration.import_log(
            request=None,
            body=pod_migration.ImportRequest(bundle=envelope),
            x_hussh_hub_proof="Bearer x",
        )

    assert excinfo.value.status_code == 400
    assert "addressed to pod key" in str(excinfo.value.detail)


# --------------------------------------------------------------------------- #
# The surface is mounted where it belongs
# --------------------------------------------------------------------------- #


def test_the_pod_mounts_the_migration_surface():
    """It lives on the POD, because hushh cannot perform either step: reading the
    source log needs the source pod's key and writing the destination needs the
    destination's, and the hub holds neither."""
    pod_server = pytest.importorskip("pod_server")
    paths = {r.path for r in pod_server.app.routes if getattr(r, "path", None)}

    assert "/pod/migration/export" in paths
    assert "/pod/migration/import" in paths


# --------------------------------------------------------------------------- #
# The proof is bound to THIS agent, not merely to a valid caller
# --------------------------------------------------------------------------- #


def test_the_proof_audience_names_this_agent():
    """A proof minted for one pod must not open another.

    A URL audience would only say "a hussh pod"; every pod in the fleet shares
    that shape. Binding to the HusshID means a caller holding a legitimate proof
    for their own agent cannot present it at someone else's.
    """
    a = pod_migration.hub_proof_audience("ha1_alice")
    b = pod_migration.hub_proof_audience("ha1_bob")

    assert a != b
    assert "ha1_alice" in a


async def test_a_pod_that_does_not_know_which_agent_it_is_refuses(monkeypatch):
    """Without a HusshID there is nothing to bind a proof to, and an unbound
    proof would make every pod interchangeable to a caller holding any one."""
    monkeypatch.setenv("HUSSH_POD_MIGRATION_ENABLED", "1")
    monkeypatch.delenv("HUSSH_ID", raising=False)
    monkeypatch.setenv("HUSSH_POD_HUB_CALLER_EMAILS", "hub@example.iam.gserviceaccount.com")

    with pytest.raises(HTTPException) as excinfo:
        await pod_migration.export_log(
            request=None,
            body=pod_migration.ExportRequest(
                recipientPublicKey="A" * 44, recipientKeyId="pod-key-1"
            ),
            x_hussh_hub_proof="Bearer anything",
        )

    assert excinfo.value.status_code == 403


async def test_an_empty_caller_allowlist_refuses_everything(monkeypatch):
    """An unconfigured allowlist is a misconfiguration, not permission -- the
    fail-closed rule `verify_scheduler_request` was written to enforce."""
    monkeypatch.setenv("HUSSH_POD_MIGRATION_ENABLED", "1")
    # Canonical deployment identity, also emitted by GcpBackend and AnypointBackend.
    monkeypatch.setenv("HUSSH_ID", "ha1_abc")
    monkeypatch.delenv("HUSSH_POD_HUB_CALLER_EMAILS", raising=False)

    with pytest.raises(HTTPException) as excinfo:
        await pod_migration.export_log(
            request=None,
            body=pod_migration.ExportRequest(
                recipientPublicKey="A" * 44, recipientKeyId="pod-key-1"
            ),
            x_hussh_hub_proof="Bearer anything",
        )

    assert excinfo.value.status_code == 403
