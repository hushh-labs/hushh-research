"""The hub's standby sync end to end: real hub ferry, real pod routes, two pods.

``StandbySyncService`` -> ``pod_sync_transport`` -> ``pod_migration_transport._post``
-> HTTP -> ``/pod/sync/*`` on two in-process pods (``tests/standby_sync_pods.py``).
Only the store and registry are in memory, and the hub-proof gate accepts exactly the
proof minted for the audience the pod computed from the body it received.

The property: after a sync the standby's OWN head equals the primary's OWN head, and a
sync that fails leaves the standby exactly as it was (E8), proved against the real
pod import, never a fake.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

from hushh_mcp.services import pod_role  # noqa: E402
from hushh_mcp.services.pod_role import sync_import_scope  # noqa: E402
from hushh_mcp.services.pod_standby_sync import StandbySyncService  # noqa: E402
from tests.standby_sync_pods import (  # noqa: E402
    OWNER_HUSHH_ID,
    PRIMARY_URL,
    STANDBY_URL,
    USER,
    MemoryRegistry,
    MemoryStandbyStore,
    Network,
    head_of,
    install_proof_gate,
    make_pod,
    minter,
    primary_row,
    set_role,
    standby_row,
    table_ready,
    use,
)


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MIGRATION_ENABLED", "1")
    monkeypatch.setenv("HUSSH_ID", OWNER_HUSHH_ID)
    monkeypatch.delenv("POD_STORAGE_BACKEND", raising=False)
    install_proof_gate(monkeypatch)
    pod_role.reset_role_cache()
    primary = make_pod(tmp_path, "primary", PRIMARY_URL, b"P" * 32)
    standby = make_pod(tmp_path, "standby", STANDBY_URL, b"S" * 32)
    network = Network(monkeypatch, {PRIMARY_URL: primary, STANDBY_URL: standby})
    assert set_role(network, standby, "standby", 0, primary.signing_id) == {
        "role": "standby",
        "epoch": 0,
    }
    network.calls.clear()
    store = MemoryStandbyStore(standby_row(standby))
    registry = MemoryRegistry(primary_row(primary))
    service = StandbySyncService(
        store=store, registry=registry, token_minter=minter, table_ready=table_ready
    )
    monkeypatch.setattr(
        "hushh_mcp.services.pod_sync_transport._post",
        _with_session(network),
    )
    yield primary, standby, network, store, registry, service
    pod_role.reset_role_cache()


def _with_session(network: Network):
    """Route the real transport through the in-process network."""
    from hushh_mcp.services.pod_migration_transport import _post

    def post(*args, **kwargs):
        kwargs["session"] = network
        return _post(*args, **kwargs)

    return post


async def _learn(monkeypatch, pod, *texts: str) -> None:
    use(monkeypatch, pod)
    for text in texts:
        await pod.log.append("memory_record", {"text": text})


async def test_a_sync_brings_the_standby_level_and_records_the_new_head(world, monkeypatch):
    primary, standby, network, store, _, service = world
    await _learn(monkeypatch, primary, "fact 0", "fact 1", "fact 2")

    result = await service.sync_once(USER, cooldown_seconds=0)

    primary_head = await head_of(monkeypatch, primary)
    assert await head_of(monkeypatch, standby) == primary_head
    assert result.to_dict() == {
        "status": "synced",
        "reason": "imported",
        "synced_seq": 3,
        "synced_head_sha": primary_head[1],
        "records_transferred": 3,
        "recorded": True,
    }
    assert store.results == [{"status": "synced", "seq": 3, "head": primary_head[1]}]
    assert network.paths(STANDBY_URL) == ["/pod/sync/head", "/pod/sync/import", "/pod/sync/head"]

    await _learn(monkeypatch, primary, "later 0", "later 1")
    again = await service.sync_once(USER, cooldown_seconds=0)
    assert (again.reason, again.synced_seq, again.records_transferred) == ("imported", 5, 2)
    assert await head_of(monkeypatch, standby) == await head_of(monkeypatch, primary)
    use(monkeypatch, standby)
    assert [r["payload"]["text"] for r in await standby.log.replay()][-1] == "later 1"


async def test_an_idle_person_records_synced_with_no_export(world, monkeypatch):
    primary, _, network, store, _, service = world
    await _learn(monkeypatch, primary, "fact 0")
    await service.sync_once(USER, cooldown_seconds=0)
    network.calls.clear()

    idle = await service.sync_once(USER, cooldown_seconds=0)

    assert (idle.status, idle.reason, idle.synced_seq, idle.records_transferred) == (
        "synced",
        "equal_heads",
        1,
        0,
    )
    assert "/pod/sync/export" not in network.paths(PRIMARY_URL)
    assert network.paths(STANDBY_URL) == ["/pod/sync/head"]
    assert store.results[-1]["status"] == "synced"


async def test_two_empty_logs_are_level_and_record_no_head_hash(world):
    *_, store, _, service = world
    result = await service.sync_once(USER, cooldown_seconds=0)
    assert (result.reason, result.synced_seq, result.synced_head_sha) == ("equal_heads", 0, None)
    assert store.results == [{"status": "synced", "seq": 0, "head": None}]


async def test_a_tampered_range_is_refused_and_leaves_the_standby_untouched(world, monkeypatch):
    """Negative control: a dishonest hub alters the ciphertext it ferries."""
    primary, standby, network, store, _, service = world
    await _learn(monkeypatch, primary, "fact 0")
    await service.sync_once(USER, cooldown_seconds=0)
    await _learn(monkeypatch, primary, "fact 1", "fact 2")
    before = await head_of(monkeypatch, standby)

    def tamper(origin, path, body):
        if path == "/pod/sync/export" and body.get("bundle"):
            bundle = dict(body["bundle"])
            bundle["ciphertext"] = bundle["ciphertext"][:-8] + "AAAAAAA="
            body = {**body, "bundle": bundle}
        return body

    network.rewrite = tamper
    result = await service.sync_once(USER, cooldown_seconds=0)

    assert (result.status, result.reason, result.recorded) == ("failed", "refused_bundle", True)
    assert await head_of(monkeypatch, standby) == before == (1, store.row["synced_head_sha"])
    use(monkeypatch, standby)
    assert len(await standby.log.replay()) == 1
    assert store.results[-1] == {"status": "failed", "seq": None, "head": None}
    assert store.lease is None


async def test_a_forked_standby_is_recorded_diverged_and_left_untouched(world, monkeypatch):
    primary, standby, network, store, _, service = world
    await _learn(monkeypatch, primary, "fact 0", "fact 1", "fact 2")
    use(monkeypatch, standby)
    await standby.log.read_role(fresh=True)
    with sync_import_scope():
        await standby.log.append("memory_record", {"text": "a different history"})
    forked = await head_of(monkeypatch, standby)

    result = await service.sync_once(USER, cooldown_seconds=0)

    assert (result.status, result.reason) == ("diverged", "refused_fork")
    assert network.paths(PRIMARY_URL) == ["/pod/sync/head", "/pod/sync/export"]
    assert "/pod/sync/import" not in network.paths(STANDBY_URL)
    assert await head_of(monkeypatch, standby) == forked
    assert store.results[-1]["status"] == "diverged"


async def test_a_standby_ahead_of_its_primary_is_diverged_without_an_export(world, monkeypatch):
    primary, standby, network, _, _, service = world
    await _learn(monkeypatch, primary, "fact 0")
    use(monkeypatch, standby)
    await standby.log.read_role(fresh=True)
    with sync_import_scope():
        for n in range(2):
            await standby.log.append("memory_record", {"text": f"other {n}"})

    result = await service.sync_once(USER, cooldown_seconds=0)

    assert (result.status, result.reason) == ("diverged", "refused_fork")
    assert network.paths(PRIMARY_URL) == ["/pod/sync/head"]


async def test_a_pod_the_hub_did_not_record_is_never_ferried_to(world, monkeypatch):
    primary, _, network, store, _, service = world
    await _learn(monkeypatch, primary, "fact 0")
    store.row["pod_signing_key_id"] = "pods_somebody_else"

    result = await service.sync_once(USER, cooldown_seconds=0)

    assert (result.status, result.reason) == ("failed", "identity_mismatch_standby")
    assert "/pod/sync/export" not in network.paths(PRIMARY_URL)


async def test_a_standby_without_its_role_is_not_synced(world, monkeypatch, tmp_path):
    """E3: the hub writes role=standby before anything is routed to a standby."""
    primary, _, network, store, _, service = world
    fresh = make_pod(tmp_path, "fresh", STANDBY_URL, b"F" * 32)
    network.pods[STANDBY_URL] = fresh
    store.row = standby_row(fresh)
    await _learn(monkeypatch, primary, "fact 0")

    result = await service.sync_once(USER, cooldown_seconds=0)

    assert (result.status, result.reason) == ("failed", "role_mismatch_standby")
    assert await head_of(monkeypatch, fresh) == (0, "")


async def test_after_a_promotion_the_sync_runs_in_reverse(world, monkeypatch):
    primary, standby, network, store, registry, service = world
    await _learn(monkeypatch, primary, "fact 0")
    await service.sync_once(USER, cooldown_seconds=0)
    set_role(network, standby, "primary", 1)
    set_role(network, primary, "standby", 1, standby.signing_id)
    registry.row = primary_row(standby, epoch=1)
    store.row = standby_row(primary, epoch=1, synced_seq=1)
    await _learn(monkeypatch, standby, "learned after promotion")

    result = await service.sync_once(USER, cooldown_seconds=0)

    assert (result.reason, result.synced_seq) == ("imported", 2)
    assert await head_of(monkeypatch, primary) == await head_of(monkeypatch, standby)


async def test_a_pod_reporting_an_epoch_below_the_registry_is_refused(world, monkeypatch):
    """E4: after a switch to epoch 1, a pod still at epoch 0 is stale."""
    primary, standby, _, store, registry, service = world
    await _learn(monkeypatch, primary, "fact 0")
    registry.row = primary_row(primary, epoch=1)
    store.row = standby_row(standby, epoch=1)

    result = await service.sync_once(USER, cooldown_seconds=0)

    assert (result.status, result.reason) == ("failed", "stale_epoch_primary")
    assert await head_of(monkeypatch, standby) == (0, "")
