from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services.consent_request_lock import (
    consent_request_lock_key,
    serialize_consent_request,
)


def test_consent_request_lock_key_is_stable_and_scope_bound() -> None:
    first = consent_request_lock_key(agent_id="agent-a", user_id="user-a", scope="attr.financial.*")
    assert first == consent_request_lock_key(
        agent_id="agent-a", user_id="user-a", scope="attr.financial.*"
    )
    assert first != consent_request_lock_key(
        agent_id="agent-a", user_id="user-a", scope="attr.travel.*"
    )


@pytest.mark.asyncio
async def test_consent_request_lock_serializes_same_request_lane(monkeypatch) -> None:
    monkeypatch.setenv("TESTING", "true")
    first_entered = asyncio.Event()
    release_first = asyncio.Event()
    order: list[str] = []

    async def first() -> None:
        async with serialize_consent_request(
            agent_id="agent-a", user_id="user-a", scope="attr.financial.*"
        ):
            order.append("first-enter")
            first_entered.set()
            await release_first.wait()
            order.append("first-exit")

    async def second() -> None:
        await first_entered.wait()
        async with serialize_consent_request(
            agent_id="agent-a", user_id="user-a", scope="attr.financial.*"
        ):
            order.append("second-enter")

    first_task = asyncio.create_task(first())
    second_task = asyncio.create_task(second())
    await first_entered.wait()
    await asyncio.sleep(0)
    assert order == ["first-enter"]
    release_first.set()
    await asyncio.gather(first_task, second_task)
    assert order == ["first-enter", "first-exit", "second-enter"]
