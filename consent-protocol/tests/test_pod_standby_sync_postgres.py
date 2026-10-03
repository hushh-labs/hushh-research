"""Standby sync against the REAL standby store on PostgreSQL (migration 950).

The single-flight lease and the sweep's due list are SQL, so they are proven by
running it (``tests/standby_postgres_support.py``): two workers racing for one person
sync it once, a recorded sync drops the person off the due list for an interval, and
the recorded head is what the pods reported.
"""

from __future__ import annotations

import asyncio
import threading

import pytest

from hushh_mcp.services.pod_migration_transport import PodMigrationTransportError
from hushh_mcp.services.pod_standby_sync import StandbySyncService
from tests import standby_postgres_support as support
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.standby_postgres_support import (
    HEAD_A,
    OWNER,
    PRIMARY_SIGNING,
    STANDBY_SIGNING,
    placement,
    registry_row,
    seed_primary,
    standby_row,
)

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

PRIMARY_URL = "https://agent.example.test"


@pytest.fixture(scope="module")
def server():
    yield from support.start_server()


@pytest.fixture
def pg(server):
    return support.reset(server)


class Registry:
    def __init__(self, pg) -> None:
        self._pg = pg

    async def get(self, user_id: str):
        return registry_row(self._pg, user_id)


class LevelPods:
    """Both pods report the same head; the first head read can be held open."""

    PodMigrationTransportError = PodMigrationTransportError

    def __init__(self, seq: int = 7, sha: str = HEAD_A) -> None:
        self.head = (seq, sha)
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.reads = 0

    def read_head(self, *, pod_url, hushh_id, token_minter=None):
        self.reads += 1
        self.entered.set()
        assert self.release.wait(10)
        primary = pod_url == PRIMARY_URL
        signing = PRIMARY_SIGNING if primary else STANDBY_SIGNING
        return {
            "head_seq": self.head[0],
            "head_sha": self.head[1],
            "pod_key_id": f"podk_{OWNER}" if primary else "podk_standby",
            "pod_signing_key_id": signing[1],
            "role": "primary" if primary else "standby",
            "epoch": 0,
        }


async def _ready() -> bool:
    return True


def _service(pg, pods) -> StandbySyncService:
    return StandbySyncService(
        store=support.store_for(pg), registry=Registry(pg), transport=pods, table_ready=_ready
    )


async def _seeded(pg) -> None:
    seed_primary(pg)
    assert await support.store_for(pg).add_standby(OWNER, 0, placement())


async def test_two_workers_racing_for_one_person_sync_it_once(pg):
    await _seeded(pg)
    pods = LevelPods()
    pods.release.clear()
    first, second = _service(pg, pods), _service(pg, pods)

    async def racer():
        await asyncio.to_thread(pods.entered.wait, 10)
        lost = await second.sync_once(OWNER, cooldown_seconds=0)
        pods.release.set()
        return lost

    won, lost = await asyncio.gather(first.sync_once(OWNER, cooldown_seconds=0), racer())

    assert (won.status, won.reason, won.recorded) == ("synced", "equal_heads", True)
    assert (lost.status, lost.reason) == ("skipped", "busy")
    assert pods.reads == 2  # the winner's two head reads; the loser read nothing
    row = standby_row(pg)
    assert (row["synced_seq"], row["synced_head_sha"], row["last_sync_status"]) == (
        7,
        HEAD_A,
        "synced",
    )
    assert row["sync_lease_id"] is None


async def test_a_recorded_sync_leaves_the_due_list_for_an_interval(pg):
    await _seeded(pg)
    service = _service(pg, LevelPods())

    first = await service.sweep_due()
    again = await service.sweep_due()

    assert (first.attempted, first.synced) == (1, 1)
    assert again.attempted == 0


async def test_a_failed_sync_is_retried_only_after_the_cooldown(pg):
    await _seeded(pg)

    class Down(LevelPods):
        def read_head(self, **kwargs):
            raise PodMigrationTransportError("POD_UNREACHABLE", "down")

    service = _service(pg, Down())
    failed = await service.sweep_due()
    retried = await service.sweep_due()

    assert (failed.attempted, failed.failed) == (1, 1)
    assert standby_row(pg)["last_sync_status"] == "failed"
    assert (retried.attempted, retried.skipped) == (1, 1)  # due, but inside the cooldown


async def test_the_on_demand_cooldown_refuses_an_immediate_repeat(pg):
    await _seeded(pg)
    service = _service(pg, LevelPods())
    assert (await service.sync_once(OWNER)).reason == "equal_heads"
    assert (await service.sync_once(OWNER)).reason == "busy"
