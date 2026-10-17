"""The hub's standby sync sequencing, with every pod answer scripted.

``test_pod_standby_sync_pods.py`` proves the ferry against two real pods. This file
covers what real pods cannot be made to do on cue: a standby that reports another
head after import, each transport failure, a refused record, the sweep's interval,
batch and ordering, and the on-demand route's owner binding.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services.pod_migration_transport import PodMigrationTransportError
from hushh_mcp.services.pod_standby_sync import (
    ON_DEMAND_COOLDOWN_SECONDS,
    SWEEP_BATCH,
    SWEEP_RETRY_COOLDOWN_SECONDS,
    SYNC_INTERVAL,
    StandbySyncService,
)
from tests.standby_sync_pods import MemoryRegistry, MemoryStandbyStore

USER = "firebase-owner"
HID = "ha1_owner"
P_URL, S_URL = "https://primary.test", "https://standby.test"
SHA = {n: ("ab" + f"{n:02x}") * 16 for n in range(1, 10)}
PRIMARY = {"pod_key_id": "podk_p", "pod_signing_key_id": "pods_p"}
STANDBY = {"pod_key_id": "podk_s", "pod_signing_key_id": "pods_s"}


def _head(seq: int, side: dict, role: str, epoch: int = 0) -> dict:
    return {"head_seq": seq, "head_sha": SHA.get(seq, ""), "role": role, "epoch": epoch, **side}


class FakeTransport:
    """``pod_sync_transport``-shaped; answers from scripts, records every call."""

    PodMigrationTransportError = PodMigrationTransportError

    def __init__(self, *, primary=(), standby=(), export=None, imported=None) -> None:
        self.heads = {P_URL: list(primary), S_URL: list(standby)}
        self.export = export
        self.imported = imported
        self.calls: list[str] = []

    @staticmethod
    def _answer(value):
        if isinstance(value, BaseException):
            raise value
        return value

    def read_head(self, *, pod_url, hushh_id, token_minter=None):
        self.calls.append(f"head:{'primary' if pod_url == P_URL else 'standby'}")
        return self._answer(self.heads[pod_url].pop(0))

    def export_range(self, *, pod_url, token_minter=None, **body):
        self.calls.append("export")
        return self._answer(self.export)

    def import_range(self, *, pod_url, token_minter=None, **body):
        self.calls.append("import")
        return self._answer(self.imported)


def _bundle(base: int, head: int) -> dict:
    return {
        "baseSeq": base,
        "baseHeadSha": SHA.get(base, ""),
        "headSeq": head,
        "headSha": SHA[head],
        "ciphertext": "sealed",
    }


def _refused(code: str) -> PodMigrationTransportError:
    return PodMigrationTransportError(code, "refused")


def _rows(epoch: int = 0, **primary) -> tuple[dict, dict]:
    p = {
        "user_id": USER,
        "hushh_id": HID,
        "status": "provisioned",
        "placement_epoch": epoch,
        "backend_metadata": {"url": P_URL},
        **PRIMARY,
        **primary,
    }
    s = {"user_id": USER, "hushh_id": HID, "url": S_URL, "pod_pubkey": "pub", "synced_seq": 0}
    return p, {**s, **STANDBY, "placement_epoch": epoch}


async def _ready() -> bool:
    return True


def _service(transport, *, primary=None, store=None, ready=_ready, clock=None):
    p, s = _rows()
    store = store or MemoryStandbyStore(s)
    kwargs = {"clock": clock} if clock else {}
    return (
        StandbySyncService(
            store=store,
            registry=MemoryRegistry(primary or p),
            transport=transport,
            table_ready=ready,
            **kwargs,
        ),
        store,
    )


def _happy(**overrides) -> FakeTransport:
    script = {
        "primary": [_head(3, PRIMARY, "primary")],
        "standby": [_head(1, STANDBY, "standby"), _head(3, STANDBY, "standby")],
        "export": {"bundle": _bundle(1, 3), "head_seq": 3, "head_sha": SHA[3]},
        "imported": {"head_seq": 3, "head_sha": SHA[3]},
    }
    script.update(overrides)
    return FakeTransport(**script)


# -- the sequence ------------------------------------------------------------------------


async def test_a_range_after_the_standby_head_is_ferried_and_the_new_head_recorded():
    transport = _happy()
    service, store = _service(transport)
    result = await service.sync_once(USER)
    assert (result.status, result.reason, result.synced_seq, result.records_transferred) == (
        "synced",
        "imported",
        3,
        2,
    )
    assert transport.calls == ["head:primary", "head:standby", "export", "import", "head:standby"]
    assert store.results == [{"status": "synced", "seq": 3, "head": SHA[3]}]
    assert store.claims == [ON_DEMAND_COOLDOWN_SECONDS]


async def test_a_standby_reporting_another_head_after_import_is_a_head_mismatch():
    transport = _happy(standby=[_head(1, STANDBY, "standby"), _head(1, STANDBY, "standby")])
    service, store = _service(transport)
    result = await service.sync_once(USER)
    assert (result.status, result.reason, result.recorded) == ("failed", "head_mismatch", True)
    assert store.results == [{"status": "failed", "seq": None, "head": None}]
    assert store.row["synced_seq"] == 0


async def test_an_import_answer_that_disagrees_with_the_export_is_a_head_mismatch():
    transport = _happy(imported={"head_seq": 3, "head_sha": SHA[2]})
    service, _ = _service(transport)
    assert (await service.sync_once(USER)).reason == "head_mismatch"


async def test_a_range_whose_plain_coordinates_miss_the_base_is_never_imported():
    transport = _happy(export={"bundle": _bundle(2, 3), "head_seq": 3, "head_sha": SHA[3]})
    service, _ = _service(transport)
    assert (await service.sync_once(USER)).reason == "head_mismatch"
    assert "import" not in transport.calls


async def test_no_bundle_is_level_only_when_the_export_head_is_the_standby_head():
    level = _happy(export={"bundle": None, "head_seq": 1, "head_sha": SHA[1]})
    service, _ = _service(level)
    assert (await service.sync_once(USER)).reason == "equal_heads"
    moved = _happy(export={"bundle": None, "head_seq": 3, "head_sha": SHA[3]})
    service, _ = _service(moved)
    assert (await service.sync_once(USER)).reason == "head_mismatch"


@pytest.mark.parametrize(
    ("side", "code", "reason"),
    [
        ("primary", "POD_UNREACHABLE", "unreachable_primary"),
        ("primary", "POD_REFUSED_503", "unreachable_primary"),
        ("primary", "POD_REFUSED_403", "refused_primary"),
        ("primary", "POD_RESPONSE_INVALID", "invalid_response_primary"),
        ("primary", "HUB_IDENTITY_UNAVAILABLE", "hub_identity_unavailable"),
        ("standby", "POD_UNREACHABLE", "unreachable_standby"),
        ("standby", "POD_REFUSED_404", "refused_standby"),
    ],
)
async def test_a_head_read_failure_is_typed_by_side(side, code, reason):
    overrides = {side: [_refused(code)]}
    transport = _happy(**overrides)
    service, store = _service(transport)
    result = await service.sync_once(USER)
    assert (result.status, result.reason, result.recorded) == ("failed", reason, True)
    assert "export" not in transport.calls
    assert store.lease is None


@pytest.mark.parametrize(
    ("step", "code", "status", "reason"),
    [
        ("export", "POD_REFUSED_409", "diverged", "refused_fork"),
        ("export", "POD_REFUSED_403", "failed", "refused_primary"),
        ("imported", "POD_REFUSED_400", "failed", "refused_bundle"),
        ("imported", "POD_REFUSED_409", "failed", "import_conflict"),
        ("imported", "POD_UNREACHABLE", "failed", "unreachable_standby"),
    ],
)
async def test_export_and_import_refusals_are_typed(step, code, status, reason):
    service, store = _service(_happy(**{step: _refused(code)}))
    result = await service.sync_once(USER)
    assert (result.status, result.reason) == (status, reason)
    assert store.results[-1]["status"] == status


@pytest.mark.parametrize(
    "body",
    [
        {**_head(3, PRIMARY, "primary"), "head_seq": -1},
        {**_head(3, PRIMARY, "primary"), "head_sha": ""},
        {**_head(3, PRIMARY, "primary"), "head_sha": SHA[3].upper()},
        {**_head(0, PRIMARY, "primary"), "head_sha": SHA[1]},
        {**_head(3, PRIMARY, "primary"), "head_seq": "3"},
        {**_head(3, PRIMARY, "primary"), "role": "leader"},
        {**_head(3, PRIMARY, "primary"), "epoch": True},
    ],
)
async def test_a_malformed_head_is_refused(body):
    service, _ = _service(_happy(primary=[body]))
    assert (await service.sync_once(USER)).reason == "invalid_response_primary"


@pytest.mark.parametrize(
    "primary",
    [
        {"status": "needs_reinit"},
        {"placement_epoch": 1},
        {"hushh_id": "ha1_other"},
        {"backend_metadata": {"url": "http://primary.test"}},
    ],
)
async def test_a_primary_the_registry_does_not_serve_is_never_contacted(primary):
    transport = _happy()
    p, _ = _rows(**primary)
    service, store = _service(transport, primary=p)
    result = await service.sync_once(USER)
    assert (result.status, result.reason) == ("failed", "primary_not_ready")
    assert transport.calls == []
    assert store.lease is None


# -- the lease and the record ------------------------------------------------------------


async def test_a_held_lease_means_busy_and_no_pod_is_contacted():
    transport = _happy()
    service, store = _service(transport)
    store.lease = "f" * 32
    result = await service.sync_once(USER)
    assert (result.status, result.reason) == ("skipped", "busy")
    assert transport.calls == []


async def test_a_refused_synced_record_is_recorded_as_a_failure():
    service, store = _service(_happy())
    store.row["synced_seq"] = 9
    result = await service.sync_once(USER)
    assert (result.status, result.reason, result.recorded) == ("failed", "record_refused", True)
    assert store.results == [{"status": "failed", "seq": None, "head": None}]


async def test_an_unexpected_error_still_releases_the_lease():
    service, store = _service(_happy(primary=[ValueError("boom")]))
    result = await service.sync_once(USER)
    assert (result.reason, result.recorded) == ("internal_error", True)
    assert store.lease is None


async def test_no_standby_table_or_row_is_a_skip_that_touches_nothing():
    async def absent() -> bool:
        return False

    transport = _happy()
    service, store = _service(transport, ready=absent)
    assert (await service.sync_once(USER)).reason == "no_standby"
    assert store.claims == []
    store.row = None
    service, _ = _service(transport, store=store)
    assert (await service.sync_once(USER)).reason == "no_standby"
    assert transport.calls == []


async def test_an_unreadable_store_is_a_typed_skip():
    class Broken(MemoryStandbyStore):
        async def read_standby(self, user_id):
            raise RuntimeError("relation does not exist")

    _, s = _rows()
    service, _ = _service(_happy(), store=Broken(s))
    assert (await service.sync_once(USER)).to_dict()["reason"] == "store_unavailable"


def test_an_outcome_carries_no_address_key_or_record():
    from hushh_mcp.services.pod_standby_sync_checks import outcome

    assert set(outcome("imported").to_dict()) == {
        "status",
        "reason",
        "synced_seq",
        "synced_head_sha",
        "records_transferred",
        "recorded",
    }


# -- the sweep ---------------------------------------------------------------------------


class SweepStore(MemoryStandbyStore):
    def __init__(self, rows: list[dict]) -> None:
        super().__init__(rows[0])
        self.due = rows
        self.asked: list[tuple] = []
        self.attempted: list[str] = []

    async def list_standbys_due(self, synced_before, limit):
        self.asked.append((synced_before, limit))
        return self.due

    async def claim_sync_lease(self, user_id, observed, lease_id, cooldown_seconds):
        self.attempted.append(user_id)
        self.claims.append(cooldown_seconds)
        return None


async def test_the_sweep_asks_for_one_interval_and_one_batch_in_the_store_order():
    now = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)
    _, s = _rows()
    rows = [{**s, "user_id": f"u{n}"} for n in range(SWEEP_BATCH + 2)]
    store = SweepStore(rows)
    service, _ = _service(_happy(), store=store, clock=lambda: now)

    report = await service.sweep_due()

    assert store.asked == [(now - SYNC_INTERVAL, SWEEP_BATCH)]
    assert SYNC_INTERVAL == timedelta(hours=4)
    assert store.attempted == [f"u{n}" for n in range(SWEEP_BATCH)]
    assert set(store.claims) == {SWEEP_RETRY_COOLDOWN_SECONDS}
    assert (report.attempted, report.skipped, report.synced, report.failed) == (
        SWEEP_BATCH,
        SWEEP_BATCH,
        0,
        0,
    )


async def test_the_sweep_counts_what_it_synced_and_what_failed():
    _, s = _rows()
    store = MemoryStandbyStore(s)

    async def due(synced_before, limit):
        return [dict(store.row)]

    store.list_standbys_due = due
    service, _ = _service(_happy(), store=store)
    report = await service.sweep_due()
    assert (report.attempted, report.synced, report.failed) == (1, 1, 0)
    failing, _ = _service(_happy(primary=[_refused("POD_UNREACHABLE")]), store=store)
    store.row["synced_seq"] = 0
    report = await failing.sweep_due()
    assert (report.attempted, report.synced, report.failed) == (1, 0, 1)


async def test_the_sweep_is_inert_without_the_table_and_survives_a_bad_read():
    async def absent() -> bool:
        return False

    store = SweepStore([_rows()[1]])
    service, _ = _service(_happy(), store=store, ready=absent)
    assert (await service.sweep_due()).attempted == 0
    assert store.asked == []

    async def broken(synced_before, limit):
        raise RuntimeError("down")

    store.list_standbys_due = broken
    service, _ = _service(_happy(), store=store)
    assert (await service.sweep_due()).attempted == 0
