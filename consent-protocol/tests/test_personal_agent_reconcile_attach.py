"""The reconcile sweep is attached to a running server. Until now nothing started it.

`start_personal_agent_reconcile_loop` had ZERO callers anywhere in the repository.
That matters because provisioning is `loop.create_task` around a `wait_ready` poll
that runs long after its HTTP response returned: on a CPU-throttled instance the
task barely progresses and may be evicted, and the row strands at `provisioning`
with no host, no surfaced error, and no retry. Two customer-facing strings already
promised that recovery, which made the missing caller an honesty failure as well as
a reliability one.

The half that must NOT run is the idle reap. Per the worker's own module docstring,
`personal_agent_registry` has no last-activity column and `updated_at` is never
written, so any idle query reaps on row AGE -- tearing down a healthy pod belonging
to someone who uses it daily. These tests pin that inertness, because "we wired the
sweep" is exactly the change during which someone helpfully wires the other half too.
"""

from __future__ import annotations

import inspect

import pytest

import server
from hushh_mcp.services.personal_agent_registry_repo import (
    _ACTIVE_POD_STATUSES,
    _STALLED_POD_STATUSES,
    PersonalAgentRegistryRepo,
)


class _Query:
    """Records the filter chain instead of talking to Postgres."""

    def __init__(self, sink: dict) -> None:
        self.sink = sink

    def table(self, name):
        self.sink["table"] = name
        return self

    def select(self, *cols, **_kw):
        self.sink["select"] = cols
        return self

    def in_(self, column, values):
        self.sink.setdefault("in_", {})[column] = list(values)
        return self

    def lt(self, column, value):
        self.sink.setdefault("lt", {})[column] = value
        return self

    def limit(self, n):
        self.sink["limit"] = n
        return self

    def execute(self):
        class _R:
            data = self.sink.get("rows", [])

        return _R()


@pytest.fixture
def repo(monkeypatch):
    sink: dict = {}
    r = PersonalAgentRegistryRepo()
    monkeypatch.setattr(r, "_db", lambda: _Query(sink))
    return r, sink


# -- which rows count as stalled --------------------------------------------------


async def test_only_states_a_row_should_have_left_are_retried(repo):
    r, sink = repo
    await r.fetch_stalled_agents(stalled_before="2026-08-06T00:00:00+00:00")

    assert set(sink["in_"]["status"]) == {"provisioning", "failed"}


async def test_connecting_is_never_retried(repo):
    """A `connecting` row has a LIVE host and is mid-handshake waiting for the pod's
    key. Re-running provision against it would replace a running service. Its stall
    belongs to the pod's startup key push, not to this sweep."""
    r, sink = repo
    await r.fetch_stalled_agents(stalled_before="2026-08-06T00:00:00+00:00")

    assert "connecting" not in sink["in_"]["status"]
    assert "connecting" in _ACTIVE_POD_STATUSES, "still an active state, just not a stalled one"


async def test_a_cutoff_is_always_applied(repo):
    """Without it the sweep would retry a provision that started four seconds ago,
    racing the in-flight task it is meant to replace."""
    r, sink = repo
    await r.fetch_stalled_agents(stalled_before="2026-08-06T00:00:00+00:00")

    assert sink["lt"]["created_at"] == "2026-08-06T00:00:00+00:00"


def test_the_stalled_set_and_the_active_set_stay_distinct():
    """`provisioned` is a finished row. Retrying it would re-provision a working
    agent -- new host, new HusshID risk, real money."""
    assert "provisioned" not in _STALLED_POD_STATUSES


# -- the reap half stays inert ----------------------------------------------------


def _startup_source() -> str:
    return inspect.getsource(server.startup_personal_agent_reconcile_worker)


@pytest.fixture
async def wired(monkeypatch):
    """Run the REAL startup hook and capture the callables it hands the worker.

    Asserting on the source text would prove a string is present; running it proves
    the wiring, which is what a reader of these tests actually wants to believe.
    """
    captured: dict = {}

    def _start(**kwargs):
        captured.update(kwargs)
        return None  # no live loop in a test process

    monkeypatch.setattr(server, "pod_mode", lambda: False)
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_reconcile_worker.start_personal_agent_reconcile_loop",
        _start,
    )
    await server.startup_personal_agent_reconcile_worker()
    assert captured, "startup did not reach start_personal_agent_reconcile_loop"
    return captured


async def test_the_idle_source_returns_nothing(wired):
    """Not "returns few". Nothing. There is no truthful idleness column to read, so
    an empty set is the only honest answer this can give."""
    assert await wired["fetch_idle"](None) == []


async def test_reaping_raises_rather_than_deleting_on_a_signal_known_to_be_wrong(wired):
    """If a future change ever hands this real candidates it must fail loudly, not
    tear down someone's private agent because their registry row is old."""
    with pytest.raises(AssertionError, match="no activity"):
        await wired["reap"]("one-pod-abc")


# -- it is genuinely attached ------------------------------------------------------


async def test_the_worker_is_started_at_server_startup(wired):
    assert callable(wired["fetch_stalled"])
    assert callable(wired["retry"])
    assert wired["interval_seconds"] > 0


async def test_a_pod_never_runs_the_sweep(monkeypatch):
    """A control-plane singleton. A fleet of pods each retrying provisions would race
    one another over shared rows."""
    started = {"yes": False}

    def _start(**_kwargs):
        started["yes"] = True
        return None

    monkeypatch.setattr(server, "pod_mode", lambda: True)
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_reconcile_worker.start_personal_agent_reconcile_loop",
        _start,
    )
    await server.startup_personal_agent_reconcile_worker()

    assert started["yes"] is False


async def test_a_failure_to_attach_never_stops_the_server(monkeypatch):
    """The sweep is a consistency aid. A server that refuses to boot because a
    background loop could not start is strictly worse than one without the loop."""

    def _boom(**_kwargs):
        raise RuntimeError("registry unreachable")

    monkeypatch.setattr(server, "pod_mode", lambda: False)
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_reconcile_worker.start_personal_agent_reconcile_loop",
        _boom,
    )
    # The assertion is that this returns at all.
    await server.startup_personal_agent_reconcile_worker()


async def test_the_retry_refuses_an_unverified_phone(wired, monkeypatch):
    """Same server-side read the AI-connection gate performs. A retry must never mint
    an agent against a number nobody proved they hold -- and a retry loop is exactly
    where such a check gets skipped, because "it already provisioned once" feels like
    proof and is not."""
    provisioned: list = []

    class _Identity:
        async def get_many(self, user_ids):
            return {uid: {"phone_verified": False, "phone_number": "+15551234567"} for uid in user_ids}

    class _Provisioning:
        async def provision(self, user_id, phone):
            provisioned.append((user_id, phone))

    monkeypatch.setattr(
        "hushh_mcp.services.actor_identity_service.ActorIdentityService", _Identity
    )
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_provisioning_service."
        "PersonalAgentProvisioningService",
        _Provisioning,
    )

    await wired["retry"]("u1")
    assert provisioned == []


async def test_the_retry_provisions_for_a_verified_owner(wired, monkeypatch):
    provisioned: list = []

    class _Identity:
        async def get_many(self, user_ids):
            return {uid: {"phone_verified": True, "phone_number": "+15551234567"} for uid in user_ids}

    class _Provisioning:
        async def provision(self, user_id, phone):
            provisioned.append((user_id, phone))

    monkeypatch.setattr(
        "hushh_mcp.services.actor_identity_service.ActorIdentityService", _Identity
    )
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_provisioning_service."
        "PersonalAgentProvisioningService",
        _Provisioning,
    )

    await wired["retry"]("u1")
    assert provisioned == [("u1", "+15551234567")]
