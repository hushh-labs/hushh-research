"""Durable custody transitions, purpose separation and replacement refusal."""

import asyncio
import base64
import json

import pytest

from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog, PodLogFenced
from hushh_mcp.services.pod_vault_custody import (
    CUSTODY_KIND,
    CustodyBinding,
    CustodyRefused,
    PodVaultCustody,
)

DEK = b"d" * 32
VAULT_KEY = b"v" * 32
BINDING = CustodyBinding(owner_id="owner", environment="dev", deployment_id="pod")


def approved(records):
    if any(r["kind"] == "owner_revoked" for r in records):
        raise CustodyRefused("owner_revoked")


def custody(log, epoch=1, dek=DEK):
    return PodVaultCustody(log, dek=dek, binding=BINDING, epoch=epoch, instance_id=f"rev-{epoch}")


@pytest.mark.asyncio
async def test_replacement_recovers_same_key_and_revocation_survives_restart(tmp_path):
    log = PodCommitLog(LocalObjectStore(str(tmp_path)), DEK, owner_id="owner")
    first = custody(log)
    await first.activate_writer()
    state = await first.enroll(
        vault_key=VAULT_KEY,
        key_version=1,
        enrollment_id="approved-1",
        expected_generation=0,
        authority_guard=approved,
    )
    assert VAULT_KEY not in base64.b64decode(state.sealed_key)
    assert VAULT_KEY.decode() not in json.dumps(await log.replay())
    assert await first.recover(authority_guard=approved) == VAULT_KEY
    replacement = custody(log, epoch=2)
    await replacement.activate_writer()
    with pytest.raises(PodLogFenced):
        await first.recover(authority_guard=approved)
    with pytest.raises(PodLogFenced):
        await first.activate_writer()
    assert await replacement.recover(authority_guard=approved) == VAULT_KEY
    with pytest.raises(CustodyRefused, match="decryption"):
        await custody(log, epoch=2, dek=b"x" * 32).recover(authority_guard=approved)
    await replacement.revoke(expected_generation=1, authority_guard=approved)
    restarted = custody(log, epoch=3)
    await restarted.activate_writer()
    with pytest.raises(CustodyRefused, match="not_enrolled"):
        await restarted.recover(authority_guard=approved)
    with pytest.raises(CustodyRefused, match="replayed"):
        await restarted.enroll(
            vault_key=VAULT_KEY,
            key_version=1,
            enrollment_id="approved-1",
            expected_generation=2,
            authority_guard=approved,
        )
    with pytest.raises(CustodyRefused, match="conflict"):
        await restarted.enroll(
            vault_key=VAULT_KEY,
            key_version=1,
            enrollment_id="approved-2",
            expected_generation=0,
            authority_guard=approved,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("winner", ["replacement", "revoke", "erasure", "owner_revoked"])
async def test_enrollment_cannot_win_after_authority_changes(tmp_path, winner):
    entered, release = asyncio.Event(), asyncio.Event()

    class Store(LocalObjectStore):
        pause_next = False

        async def put_if_generation(self, key, data, expected):
            if key == PodCommitLog.HEAD and self.pause_next:
                self.pause_next = False
                entered.set()
                await release.wait()
            return await super().put_if_generation(key, data, expected)

    store = Store(str(tmp_path))
    log = PodCommitLog(store, DEK, owner_id="owner")
    first = custody(log)
    await first.activate_writer()
    await first.enroll(
        vault_key=VAULT_KEY,
        key_version=1,
        enrollment_id="first",
        expected_generation=0,
        authority_guard=approved,
    )
    store.pause_next = True
    task = asyncio.create_task(
        first.enroll(
            vault_key=b"n" * 32,
            key_version=2,
            enrollment_id="late",
            expected_generation=1,
            authority_guard=approved,
        )
    )
    await asyncio.wait_for(entered.wait(), 2)
    try:
        if winner == "replacement":
            await custody(log, 2).activate_writer()
        elif winner == "revoke":
            await first.revoke(expected_generation=1, authority_guard=approved)
        elif winner == "erasure":
            await log.fence_for_erasure(owner_id="owner", attempt_id="erase")
        else:
            await log.append("owner_revoked", {})
    finally:
        release.set()
    with pytest.raises((CustodyRefused, PodLogFenced)):
        await task
    if winner != "erasure":
        assert not any(
            r["kind"] == CUSTODY_KIND and r["payload"]["enrollment_id"] == "late"
            for r in await log.replay()
        )


@pytest.mark.asyncio
async def test_recipient_binding_and_ciphertext_substitution_are_refused(tmp_path):
    log = PodCommitLog(LocalObjectStore(str(tmp_path)), DEK, owner_id="owner")
    current = custody(log)
    await current.activate_writer()
    state = await current.enroll(
        vault_key=VAULT_KEY,
        key_version=1,
        enrollment_id="first",
        expected_generation=0,
        authority_guard=approved,
    )
    foreign = PodVaultCustody(
        log,
        dek=DEK,
        binding=BINDING.model_copy(update={"environment": "prod"}),
        epoch=1,
        instance_id="rev-1",
    )
    with pytest.raises(CustodyRefused, match="writer_history"):
        await foreign.recover(authority_guard=approved)
    # Even a valid outer log seal cannot move a sealed key into another generation.
    await log.append(CUSTODY_KIND, state.model_copy(update={"generation": 2}).model_dump())
    with pytest.raises(CustodyRefused, match="decryption"):
        await current.recover(authority_guard=approved)


@pytest.mark.asyncio
async def test_key_version_cannot_rollback_or_identify_different_keys(tmp_path):
    log = PodCommitLog(LocalObjectStore(str(tmp_path)), DEK, owner_id="owner")
    current = custody(log)
    await current.activate_writer()
    await current.enroll(
        vault_key=VAULT_KEY,
        key_version=2,
        enrollment_id="first",
        expected_generation=0,
        authority_guard=approved,
    )
    for version, key in [(1, VAULT_KEY), (2, b"x" * 32)]:
        with pytest.raises(CustodyRefused, match="key_version_conflict"):
            await current.enroll(
                vault_key=key,
                key_version=version,
                enrollment_id="other",
                expected_generation=1,
                authority_guard=approved,
            )
    await current.enroll(
        vault_key=VAULT_KEY,
        key_version=2,
        enrollment_id="same-key",
        expected_generation=1,
        authority_guard=approved,
    )
    assert await current.recover(authority_guard=approved) == VAULT_KEY


@pytest.mark.asyncio
@pytest.mark.parametrize("kms,durable", [(True, True), (False, True), (True, False)])
async def test_startup_activates_custody_only_with_kms_and_durable_identity(
    tmp_path, monkeypatch, kms, durable
):
    from types import SimpleNamespace

    from hushh_mcp.services import byoc_key_custody, pod_memory_service, pod_self_registration
    from hushh_mcp.services import pod_session_authority as sessions
    from hushh_mcp.services.pod_authority_store import set_active_authority_store

    log = PodCommitLog(LocalObjectStore(str(tmp_path)), DEK, owner_id="owner")
    monkeypatch.setenv("HUSSH_ID", "owner")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: log)
    monkeypatch.setattr(byoc_key_custody, "resolve_pod_log_key", lambda: DEK)
    monkeypatch.setattr(byoc_key_custody, "byoc_custody_configured", lambda: kms)
    monkeypatch.setattr(pod_self_registration, "pod_key_is_durable", lambda: durable)
    monkeypatch.setattr(
        pod_self_registration,
        "pod_keypair",
        lambda: SimpleNamespace(key_id="key", public_key_b64="public"),
    )
    try:
        first = await sessions.build_pod_session_authority(instance_id="first")
        assert (first.vault_custody is not None) == (kms and durable)
        if first.vault_custody:
            await first.vault_custody.enroll(
                vault_key=VAULT_KEY,
                key_version=1,
                enrollment_id="first",
                expected_generation=0,
                authority_guard=approved,
            )
            second = await sessions.build_pod_session_authority(instance_id="second")
            with pytest.raises(PodLogFenced):
                await first.vault_custody.recover(authority_guard=approved)
            assert await second.vault_custody.recover(authority_guard=approved) == VAULT_KEY
            monkeypatch.setattr(byoc_key_custody, "byoc_custody_configured", lambda: False)
            disabled = await sessions.build_pod_session_authority(instance_id="disabled")
            assert disabled.vault_custody is None
            with pytest.raises(PodLogFenced):
                await second.vault_custody.recover(authority_guard=approved)
    finally:
        sessions.set_active_session_authority(None)
        set_active_authority_store(None)
