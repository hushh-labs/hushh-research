"""Does the pod's agent EVOLVE across a long horizon, or just survive one death?

The private-agent north star's resolved Q1 (founder, 2026-08-06) is explicit: the
simulator's job is to prove *evolution*, not merely that a key survives. "The agent
evolved" must be an **assertion, not a vibe** -- it needs a metric, negative
controls, and the recall path the agent actually uses, because a model can produce a
plausible answer by guessing and only the recall proves it remembered.

Two neighbouring files already exist and this one deliberately does NOT duplicate them:

- ``test_pod_memory_durability.py`` proves a *single* store -> pod death -> recall.
- ``test_pod_memory_is_actually_used.py`` proves the *wiring*: a turn writes to memory
  and ADK's ``load_memory`` tool is bound so the agent can read it.

What neither proves is the compounding the north star asks for: many facts stored
across a long horizon, the pod restarted more than once mid-horizon, an EARLY fact
recalled MUCH LATER as well as a recent one (no decay), measured as a recall rate
with a negative control. That is this file's job.

The recall path exercised here is ``search_memory`` -- the exact call ADK's
``load_memory`` tool makes into the memory service (see the wiring test for the
binding). A pod "restart" is modelled as ``test_pod_memory_durability`` models it:
drop every in-process reference and rebuild a fresh service from nothing but the
owner id, the key, and the log. Nothing is carried across in Python; only the log is.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.pod_commit_log import (  # noqa: E402
    LocalObjectStore,
    PodCommitLog,
)
from hushh_mcp.services.pod_memory_service import (  # noqa: E402
    build_pod_memory_service,
)

pytest.importorskip("google.adk.memory.base_memory_service")

from google.adk.tools import load_memory  # noqa: E402

OWNER = "HA1EVOLVE00001"
KEY = b"\x37" * 32


# The ADK session shapes ``add_session_to_memory`` reads (matches the durability test).
class _Part:
    def __init__(self, text: str) -> None:
        self.text = text


class _Content:
    def __init__(self, text: str) -> None:
        self.parts = [_Part(text)]


class _Event:
    def __init__(self, text: str, author: str = "user") -> None:
        self.author = author
        self.content = _Content(text)


class _Session:
    user_id = OWNER

    def __init__(self, *texts: str) -> None:
        self.events = [_Event(t) for t in texts]


def _log(tmp_path: Path) -> PodCommitLog:
    return PodCommitLog(LocalObjectStore(str(tmp_path / "store")), KEY)


# A long horizon of facts, each carrying one unambiguous keyword that appears in no
# other fact -- so a hit is recall, not coincidence, and the metric means something.
HORIZON: list[tuple[str, str]] = [
    ("radiator", "the guest room radiator leaks when it rains"),
    ("almond", "she is allergic to almond but tolerates other nuts"),
    ("meridian", "the meridian brokerage account number ends in 4269"),
    ("dachshund", "the dachshund is named Pushkin"),
    ("kintsugi", "his kintsugi bowl sits on the third shelf"),
    ("zephyr", "the sailboat is called Zephyr and berths at slip twelve"),
    ("saffron", "the saffron is kept in the blue tin, never the red one"),
    ("obsidian", "the obsidian ring belonged to his grandfather"),
    ("tessellate", "the bathroom tiles tessellate in a Penrose pattern"),
    ("quokka", "the quokka photo was taken on Rottnest Island"),
    ("larch", "the larch by the back fence was planted in 2019"),
    ("velvet", "the velvet chair must never stand in direct sun"),
]


async def _store(service: object, fact: str) -> None:
    await service.add_session_to_memory(_Session(fact))  # type: ignore[attr-defined]


async def _recall(service: object, keyword: str) -> list[str]:
    hits = await service.search_memory(  # type: ignore[attr-defined]
        app_name="one", user_id=OWNER, query=keyword
    )
    return [m.content.parts[0].text for m in hits.memories]


def test_the_agent_evolves_across_a_long_horizon_with_restarts(tmp_path: Path) -> None:
    """Compounding, not survival.

    Store the horizon in three tranches across three pod generations (two restarts in
    between), then measure what fraction of the *whole* horizon recalls in the final
    generation. The earliest fact -- stored in generation one, before two deaths --
    must recall as well as the most recent one. That is evolution: knowledge from an
    early turn used much later, with no decay, measured rather than asserted by vibe.
    """

    async def run() -> None:
        third = len(HORIZON) // 3
        earliest_kw, earliest_fact = HORIZON[0]

        # Generation 1: store the first tranche, then the pod dies.
        gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        for _kw, fact in HORIZON[:third]:
            await _store(gen, fact)
        del gen  # restart 1: nothing survives in-process; only the log.

        # Generation 2: rebuilt from the log. The early fact is already recallable
        # here, before we add anything -- continuity is the precondition, not the claim.
        gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        assert earliest_fact in await _recall(gen, earliest_kw), (
            "an early fact did not survive the first restart"
        )
        for _kw, fact in HORIZON[third : 2 * third]:
            await _store(gen, fact)
        del gen  # restart 2.

        # Generation 3: rebuilt again, stores the final tranche.
        gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        for _kw, fact in HORIZON[2 * third :]:
            await _store(gen, fact)

        # The metric: after two restarts, how much of the whole horizon recalls?
        recalled = 0
        for keyword, fact in HORIZON:
            if fact in await _recall(gen, keyword):
                recalled += 1
        recall_rate = recalled / len(HORIZON)
        print(
            f"[evolution] horizon={len(HORIZON)} restarts=2 "
            f"recalled={recalled}/{len(HORIZON)} recall_rate={recall_rate:.3f}"
        )

        # No decay across the horizon: perfect recall, and specifically the earliest
        # fact -- three generations and two deaths ago -- still comes back.
        assert recall_rate == 1.0, f"memory decayed across the horizon: {recall_rate:.3f}"
        assert earliest_fact in await _recall(gen, earliest_kw), (
            "the earliest fact decayed after two restarts"
        )

    asyncio.run(run())


def test_a_fact_never_stored_is_not_recalled(tmp_path: Path) -> None:
    """The negative control that makes the metric mean something.

    A plausible query for a fact the pod was never told returns nothing. Without this,
    a search that returned everything would score a perfect recall rate and prove
    nothing -- a guesser would "recall" the fact it was never given.
    """

    async def run() -> None:
        gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        for _kw, fact in HORIZON:
            await _store(gen, fact)
        del gen
        gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))

        # "peridot" is a keyword that appears in no stored fact.
        assert await _recall(gen, "peridot") == [], "recalled a fact the pod was never told"
        # And a real keyword still recalls, so the empty result is discrimination,
        # not a dead index.
        real_kw, real_fact = HORIZON[0]
        assert real_fact in await _recall(gen, real_kw)

    asyncio.run(run())


class _ObservedToolContext:
    """A minimal stand-in for ADK's ToolContext.

    ``load_memory`` calls exactly one method on its context, ``search_memory(query)``,
    and Python does not enforce the type hint, so this records each call (that is the
    observation) and forwards to the pod memory service. Using the real
    ``load_memory`` tool, rather than reimplementing it, is the point: the recall the
    north star wants proven is the one the agent actually makes.
    """

    def __init__(self, service: object) -> None:
        self._service = service
        self.calls: list[str] = []

    async def search_memory(self, query: str) -> object:
        self.calls.append(query)
        return await self._service.search_memory(  # type: ignore[attr-defined]
            app_name="one", user_id=OWNER, query=query
        )


async def _recall_via_load_memory_tool(service: object, keyword: str) -> list[str]:
    ctx = _ObservedToolContext(service)
    # ``load_memory.func`` is the real ADK tool implementation, not a copy of it.
    response = await load_memory.func(keyword, ctx)  # type: ignore[attr-defined]
    assert ctx.calls == [keyword], "load_memory did not invoke the recall path"
    return [m.content.parts[0].text for m in response.memories]


def test_the_recall_runs_through_an_observed_load_memory_tool_call(
    tmp_path: Path,
) -> None:
    """The north star's exact requirement: only the tool call proves it remembered.

    The evolution metric above recalls through ``search_memory`` (the method the tool
    invokes). This case closes the loop by driving the real ``load_memory`` ADK tool
    after a restart and observing it: the tool must invoke the recall path and its
    LoadMemoryResponse must carry the fact. A model guessing a plausible answer would
    never produce that observed call, which is exactly why the north star asks for it.
    """

    async def run() -> None:
        gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        for _kw, fact in HORIZON:
            await _store(gen, fact)
        del gen  # restart: the tool must recall from the rebuilt store, not memory.

        gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(tmp_path))
        for keyword, fact in HORIZON:
            assert fact in await _recall_via_load_memory_tool(gen, keyword), (
                f"the load_memory tool did not recall {keyword!r} after the restart"
            )

        # The tool discriminates too: a never-stored keyword comes back empty through
        # the tool, so the observed recall is memory, not a tool that returns anything.
        assert await _recall_via_load_memory_tool(gen, "peridot") == []

    asyncio.run(run())
