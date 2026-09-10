"""One owner, one pod, one configuration record.

The founder's rule: no new environment flags for behaviour a single-owner pod
should simply have configured. These tests pin the record's contract: defaults
are the full experience, the newest record for THIS owner wins, another owner's
record is counted and skipped, stored drift is tolerated field by field, and a
write that names an unknown field or an out-of-range value refuses instead of
silently doing nothing.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services import pod_config as mod  # noqa: E402
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog  # noqa: E402
from hushh_mcp.services.pod_config import (  # noqa: E402
    POD_CONFIG_RECORD_KIND,
    PodConfig,
    PodConfigError,
    apply_changes,
    config_from_records,
    record_pod_config,
    resolve_pod_config,
)

OWNER = "HA1CONFIG000001"
OTHER = "HA1CONFIG000002"
KEY = b"\x41" * 32


def _log(tmp_path: Path) -> PodCommitLog:
    return PodCommitLog(LocalObjectStore(str(tmp_path / "store")), KEY, owner_id=OWNER)


@pytest.fixture(autouse=True)
def _reset_active():
    mod.set_active_pod_config(None)
    yield
    mod.set_active_pod_config(None)


def test_every_default_is_the_full_experience() -> None:
    config = PodConfig()
    assert config.direct_ingress_admission is True
    assert config.puppy_broker is True
    assert config.memory_review_on_close is True
    assert config.memory_review_catch_up is True
    assert config.memory_bank_rebuild_on_tick is True
    assert config.memory_review_max_records == 12
    assert config.memory_review_budget_seconds == 45.0
    assert config.memory_digest_max_chars == 1200


def test_no_record_means_defaults(tmp_path: Path) -> None:
    async def run() -> None:
        assert await resolve_pod_config(_log(tmp_path), hushh_id=OWNER) == PodConfig()
        assert await resolve_pod_config(None, hushh_id=OWNER) == PodConfig()

    asyncio.run(run())


def test_the_newest_record_for_this_owner_wins(tmp_path: Path) -> None:
    async def run() -> None:
        log = _log(tmp_path)
        await record_pod_config(log, hushh_id=OWNER, changes={"memory_digest_max_chars": 800})
        await record_pod_config(log, hushh_id=OWNER, changes={"puppy_broker": False})
        del log

        config = await resolve_pod_config(_log(tmp_path), hushh_id=OWNER)
        assert config.memory_digest_max_chars == 800, "an earlier change survives"
        assert config.puppy_broker is False, "the newest change wins"
        assert config.direct_ingress_admission is True, "untouched fields keep defaults"

    asyncio.run(run())


def test_another_owners_record_is_skipped_not_applied(tmp_path: Path) -> None:
    async def run() -> None:
        log = _log(tmp_path)
        await log.append(
            POD_CONFIG_RECORD_KIND,
            {"hushh_id": OTHER, "version": 1, "config": {"puppy_broker": False}},
        )
        assert (await resolve_pod_config(log, hushh_id=OWNER)).puppy_broker is True

    asyncio.run(run())


def test_stored_drift_is_tolerated_field_by_field() -> None:
    records = [
        {
            "kind": POD_CONFIG_RECORD_KIND,
            "payload": {
                "hushh_id": OWNER,
                "config": {
                    "memory_review_max_records": 500,  # out of bounds -> default
                    "memory_digest_max_chars": 600,  # valid -> applied
                    "a_field_from_a_newer_image": True,  # unknown -> ignored
                    "puppy_broker": "no",  # wrong type -> default
                },
            },
        }
    ]
    config = config_from_records(records, hushh_id=OWNER)
    assert config.memory_review_max_records == 12
    assert config.memory_digest_max_chars == 600
    assert config.puppy_broker is True


def test_other_kinds_are_ignored_on_read() -> None:
    records = [
        {"kind": "agent_memory", "payload": {"hushh_id": OWNER, "config": {"puppy_broker": False}}},
        {"kind": "storage_pointer", "payload": {"hushh_id": OWNER}},
    ]
    assert config_from_records(records, hushh_id=OWNER) == PodConfig()


@pytest.mark.parametrize(
    "changes",
    [
        {"no_such_field": True},
        {"puppy_broker": "yes"},
        {"memory_review_max_records": 0},
        {"memory_review_max_records": True},
        {"memory_review_budget_seconds": 4},
        {"memory_digest_max_chars": 4001},
    ],
)
def test_a_write_that_cannot_be_held_refuses(changes: dict) -> None:
    with pytest.raises(PodConfigError):
        apply_changes(PodConfig(), changes)


def test_a_write_needs_a_store_and_an_owner(tmp_path: Path) -> None:
    async def run() -> None:
        with pytest.raises(PodConfigError):
            await record_pod_config(None, hushh_id=OWNER, changes={})
        with pytest.raises(PodConfigError):
            await record_pod_config(_log(tmp_path), hushh_id="", changes={})

    asyncio.run(run())


def test_a_successful_write_becomes_the_active_copy(tmp_path: Path) -> None:
    async def run() -> None:
        assert mod.active_pod_config() == PodConfig()
        updated = await record_pod_config(
            _log(tmp_path), hushh_id=OWNER, changes={"memory_review_on_close": False}
        )
        assert mod.active_pod_config() is updated
        assert mod.active_pod_config().memory_review_on_close is False

    asyncio.run(run())


def test_a_refused_write_leaves_the_active_copy_and_the_log_alone(tmp_path: Path) -> None:
    async def run() -> None:
        log = _log(tmp_path)
        await record_pod_config(log, hushh_id=OWNER, changes={"memory_digest_max_chars": 700})
        before = len(await log.replay())
        with pytest.raises(PodConfigError):
            await record_pod_config(log, hushh_id=OWNER, changes={"typo": 1})
        assert len(await log.replay()) == before
        assert mod.active_pod_config().memory_digest_max_chars == 700

    asyncio.run(run())


def test_config_records_do_not_disturb_memory_replay(tmp_path: Path) -> None:
    """The log is shared; the memory service must keep filtering on kind."""
    pytest.importorskip("google.adk.memory.base_memory_service")
    from hushh_mcp.services.pod_memory_service import build_pod_memory_service

    class _Part:
        def __init__(self, text: str) -> None:
            self.text = text

    class _Content:
        def __init__(self, text: str) -> None:
            self.parts = [_Part(text)]

    class _Event:
        def __init__(self, text: str) -> None:
            self.author = "user"
            self.content = _Content(text)

    class _Session:
        user_id = OWNER

        def __init__(self, *texts: str) -> None:
            self.events = [_Event(t) for t in texts]

    async def run() -> None:
        log = _log(tmp_path)
        await record_pod_config(log, hushh_id=OWNER, changes={"puppy_broker": False})
        svc = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=log)
        await svc.add_session_to_memory(_Session("the guest room radiator leaks"))
        await record_pod_config(log, hushh_id=OWNER, changes={"puppy_broker": True})
        del svc

        second = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        hits = await second.search_memory(app_name="one", user_id=OWNER, query="radiator")
        assert len(hits.memories) == 1
        assert (await resolve_pod_config(_log(tmp_path), hushh_id=OWNER)).puppy_broker is True

    asyncio.run(run())


def test_startup_loader_falls_back_to_defaults_when_the_store_is_unreadable(monkeypatch) -> None:
    async def run() -> None:
        monkeypatch.setenv("HUSSH_ID", OWNER)

        def _boom():
            raise RuntimeError("storage misconfigured")

        monkeypatch.setattr("hushh_mcp.services.pod_memory_service._resolve_log", _boom)
        config = await mod.load_active_pod_config()
        assert config == PodConfig()
        assert mod.active_pod_config() == PodConfig()

    asyncio.run(run())
