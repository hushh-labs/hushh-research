"""Prepared changes wait in the owner's own sealed log and run at most once.

``pod_action_proposals`` replaces the hub's proposal tables inside an owner-cloud
agent. A claim is a compare-and-set on the log head, so a second confirmation of the
same id gets nothing; expired, foreign, wrong-kind and settled proposals are all
simply unavailable, and an agent with no log refuses rather than keeping it in memory.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services.pod_action_proposals import (
    RECORD_KIND,
    SETTLED_KIND,
    PodActionProposalStore,
    ProposalStoreUnavailable,
    kind_of,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

OWNER = "ha1_proposals"


@pytest.fixture
def log(monkeypatch, tmp_path):
    monkeypatch.setenv("HUSSH_ID", OWNER)
    return PodCommitLog(LocalObjectStore(str(tmp_path / "s")), b"\x21" * 32, owner_id=OWNER)


async def test_a_proposal_is_claimed_once_then_settled(log):
    book = PodActionProposalStore(log_resolver=lambda: log)
    issued = await book.issue(kind="calendar", owner_id="uid", payload={"plan": {"a": 1}})

    assert kind_of(issued["proposal_id"]) == "calendar"
    first, second = await asyncio.gather(
        book.claim(proposal_id=issued["proposal_id"], owner_id="uid", kind="calendar"),
        book.claim(proposal_id=issued["proposal_id"], owner_id="uid", kind="calendar"),
    )
    assert [first, second].count(None) == 1, "exactly one confirmation runs"
    assert {"plan": {"a": 1}} in (first, second)
    await book.settle(proposal_id=issued["proposal_id"], status="executed")
    kinds = [r["kind"] for r in await log.replay()]
    assert kinds == [RECORD_KIND, SETTLED_KIND, SETTLED_KIND]


async def test_expired_foreign_and_wrong_kind_proposals_are_unavailable(log):
    now = [1_000.0]
    book = PodActionProposalStore(log_resolver=lambda: log, clock=lambda: now[0])
    issued = await book.issue(kind="drive", owner_id="uid", payload={}, ttl_s=60)
    pid = issued["proposal_id"]

    assert await book.claim(proposal_id=pid, owner_id="other", kind="drive") is None
    assert await book.claim(proposal_id=pid, owner_id="uid", kind="calendar") is None
    assert await book.claim(proposal_id="gdrv_unknown", owner_id="uid", kind="drive") is None
    now[0] += 61
    assert await book.claim(proposal_id=pid, owner_id="uid", kind="drive") is None


async def test_another_agents_records_are_never_read(log, monkeypatch):
    book = PodActionProposalStore(log_resolver=lambda: log)
    issued = await book.issue(kind="calendar", owner_id="uid", payload={})
    monkeypatch.setenv("HUSSH_ID", "ha1_someone_else")
    assert (
        await book.claim(proposal_id=issued["proposal_id"], owner_id="uid", kind="calendar") is None
    )


async def test_no_durable_log_refuses_instead_of_keeping_it_in_memory():
    book = PodActionProposalStore(log_resolver=lambda: None)
    with pytest.raises(ProposalStoreUnavailable):
        await book.issue(kind="calendar", owner_id="uid", payload={})


async def test_unknown_kinds_and_statuses_are_refused(log):
    book = PodActionProposalStore(log_resolver=lambda: log)
    with pytest.raises(ValueError):
        await book.issue(kind="payments", owner_id="uid", payload={})
    with pytest.raises(ValueError):
        await book.settle(proposal_id="gcal_x", status="pending")
