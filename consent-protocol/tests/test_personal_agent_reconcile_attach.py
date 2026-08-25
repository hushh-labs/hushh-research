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
from datetime import datetime, timedelta, timezone

import pytest

import server
from hushh_mcp.services.personal_agent_provisioning_service import FEED_EVENT_FAILED
from hushh_mcp.services.personal_agent_registry_repo import (
    _ACTIVE_POD_STATUSES,
    _STALLED_POD_STATUSES,
    REASON_HANDSHAKE_TIMEOUT,
    PersonalAgentRegistryRepo,
)


class _Query:
    """Records the filter chain instead of talking to Postgres.

    `update`/`eq` recording rides alongside the select recorders so the same fake
    can pin `mark_provisioning_failed`'s conditional UPDATE: filters after an
    `update()` land in `update_eq` and its `execute()` answers with `update_rows`,
    while the read chain keeps answering with `rows`.
    """

    def __init__(self, sink: dict) -> None:
        self.sink = sink
        self._updating = False

    def table(self, name):
        self.sink["table"] = name
        return self

    def select(self, *cols, **_kw):
        self.sink["select"] = cols
        return self

    def update(self, data, **_kw):
        self._updating = True
        self.sink["update"] = data
        return self

    def eq(self, column, value):
        key = "update_eq" if self._updating else "eq"
        self.sink.setdefault(key, {})[column] = value
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
        rows = self.sink.get("update_rows" if self._updating else "rows", [])

        class _R:
            data = rows

        return _R()


@pytest.fixture
def repo(monkeypatch):
    sink: dict = {}
    r = PersonalAgentRegistryRepo()
    monkeypatch.setattr(r, "_db", lambda: _Query(sink))
    return r, sink


# -- which rows count as stalled --------------------------------------------------


async def test_only_states_a_row_should_have_left_are_retried(repo):
    """The statuses must be ones the provisioning service actually writes.

    This asserted `{"provisioning", "failed"}` and passed for as long as the query and
    this expectation were wrong together. Nothing has ever written a bare `"failed"` --
    the service writes `"provisioning_failed"` -- so the retry sweep queried for a
    status absent from the table and has never retried a single failed pod.

    That is the shape the plan of record names: a test written against a call site
    rather than against the thing it calls. It did not merely miss the defect, it
    pinned it, so correcting the query turned this red.

    `tests/test_pod_status_vocabulary_is_one_vocabulary.py` now asserts the JOIN
    between the readers and the writers, which is the check neither side could make
    alone.
    """
    r, sink = repo
    await r.fetch_stalled_agents(stalled_before="2026-08-06T00:00:00+00:00")

    assert set(sink["in_"]["status"]) == {"provisioning", "provisioning_failed"}


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
    racing the in-flight task it is meant to replace.

    THE CUTOFF IS ON INACTIVITY, NOT ON ROW AGE

    `updated_at` is stamped by `upsert` on every lifecycle transition and pointedly
    NOT by `record_heartbeat`, so it means "nothing has happened since". `created_at`
    means "the row is old", and the two diverge exactly where it matters: a row born
    ten minutes ago that transitioned thirty seconds ago is making progress, and an
    age-based cutoff retries it anyway.

    This assertion used to pin `created_at`, which is the very failure the docstring
    two tests above describes: a test written against the call site rather than the
    contract, so that correcting the query turns it red instead of confirming it. The
    contract is that exactly one cutoff is applied and that it measures inactivity, so
    that is what is asserted now, with the reason written down beside it.
    """
    r, sink = repo
    await r.fetch_stalled_agents(stalled_before="2026-08-06T00:00:00+00:00")

    assert sink["lt"] == {"updated_at": "2026-08-06T00:00:00+00:00"}, (
        "the sweep must bound itself by inactivity, by exactly one cutoff"
    )


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
            return {
                uid: {"phone_verified": False, "phone_number": "+15551234567"} for uid in user_ids
            }

    class _Provisioning:
        # The REAL signature: `registry` is a required keyword-only constructor
        # argument and `provision` is keyword-only. This stub used to take no
        # constructor arguments and positional `provision` params -- shaped to
        # the broken production call -- so it passed while the retry it was
        # testing raised TypeError before doing anything.
        def __init__(self, **kwargs):
            assert "registry" in kwargs, "retry must construct with a registry"

        async def provision(self, *, user_id, phone_e164, **_):
            provisioned.append((user_id, phone_e164))

    monkeypatch.setattr("hushh_mcp.services.actor_identity_service.ActorIdentityService", _Identity)
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_provisioning_service.PersonalAgentProvisioningService",
        _Provisioning,
    )

    await wired["retry"]("u1")
    assert provisioned == []


async def test_the_retry_provisions_for_a_verified_owner(wired, monkeypatch):
    provisioned: list = []

    # The retry now probes the row FIRST, because the sweep also returns
    # `connecting` rows and an unreadable row might have a live host -- so a
    # failed read skips the pass instead of provisioning blind. This test is
    # about the provision path, so the probe must succeed and answer with a
    # genuinely stalled status.
    async def _stalled_row(self, user_id):
        return {"user_id": user_id, "status": "provisioning"}

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo.get",
        _stalled_row,
    )

    class _Identity:
        async def get_many(self, user_ids):
            return {
                uid: {"phone_verified": True, "phone_number": "+15551234567"} for uid in user_ids
            }

    class _Provisioning:
        # The REAL signature: `registry` is a required keyword-only constructor
        # argument and `provision` is keyword-only. This stub used to take no
        # constructor arguments and positional `provision` params -- shaped to
        # the broken production call -- so it passed while the retry it was
        # testing raised TypeError before doing anything.
        def __init__(self, **kwargs):
            assert "registry" in kwargs, "retry must construct with a registry"

        async def provision(self, *, user_id, phone_e164, **_):
            provisioned.append((user_id, phone_e164))

    monkeypatch.setattr("hushh_mcp.services.actor_identity_service.ActorIdentityService", _Identity)
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_provisioning_service.PersonalAgentProvisioningService",
        _Provisioning,
    )

    await wired["retry"]("u1")
    assert provisioned == [("u1", "+15551234567")]


# -- the handshake deadline (graceful degradation) ---------------------------------
# A `connecting` row whose pod never publishes its key used to sit there forever:
# the sweep re-pulled it each pass, collected nothing, and said nothing. Past 1800s
# of time-in-state the handshake is now declared dead rather than slow -- the row
# becomes `provisioning_failed` (which the owner's rebuild affordance already
# renders) and the marker gates the sweep so the dead pod is never auto-healed into
# a connecting<->failed flap.


def _connecting_row(*, minutes_old: float) -> dict:
    return {
        "user_id": "u1",
        "hushh_id": "ha1deadline",
        "external_agent_id": "one-pod-ha1deadline",
        "status": "connecting",
        # `upsert` stamps updated_at on every transition and heartbeats never touch
        # it, so this IS time-in-state.
        "updated_at": (datetime.now(timezone.utc) - timedelta(minutes=minutes_old)).isoformat(),
    }


def _wire_connecting_pass(monkeypatch, *, row, advanced=None, mark_returns=True):
    """One sweep pass over `row`: canned registry read, canned key collection, and
    recorders in place of the failure write and the feed projection."""

    async def _get(self, user_id):  # noqa: ARG001 - the class-method signature
        return row

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo.get",
        _get,
    )

    async def _collect(_row):
        return advanced

    monkeypatch.setattr("hushh_mcp.services.pod_key_collector.collect_pod_key_if_pending", _collect)

    marked: list[dict] = []

    async def _mark(self, *, user_id, reason, detail=""):  # noqa: ARG001
        marked.append({"user_id": user_id, "reason": reason, "detail": detail})
        return mark_returns

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo."
        "PersonalAgentRegistryRepo.mark_provisioning_failed",
        _mark,
    )

    events: list[dict] = []

    async def _feed(**kw):
        events.append(kw)

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_provisioning_service."
        "record_provisioning_feed_event_safe",
        _feed,
    )
    return marked, events


async def test_an_overdue_connecting_row_is_marked_failed(wired, monkeypatch):
    """31 minutes in `connecting` with no key collected this pass: the sweep records
    the handshake as dead -- and never constructs a provisioning service, because a
    dead handshake is a terminal verdict, not a retry."""
    marked, _events = _wire_connecting_pass(monkeypatch, row=_connecting_row(minutes_old=31))
    constructed: list = []

    class _NeverConstructed:
        def __init__(self, **kwargs):
            constructed.append(kwargs)

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_provisioning_service.PersonalAgentProvisioningService",
        _NeverConstructed,
    )

    await wired["retry"]("u1")

    assert [m["reason"] for m in marked] == [REASON_HANDSHAKE_TIMEOUT]
    assert marked[0]["user_id"] == "u1"
    assert constructed == []


async def test_a_fresh_connecting_row_is_left_alone(wired, monkeypatch):
    """Two minutes in: key collection alone this pass. The deadline exists to bound
    a stall, never to shortcut a boot that is simply still happening."""
    marked, events = _wire_connecting_pass(monkeypatch, row=_connecting_row(minutes_old=2))

    await wired["retry"]("u1")

    assert marked == []
    assert events == []


async def test_a_connecting_row_that_advances_is_never_failed(wired, monkeypatch):
    """The deadline only applies to a row that did NOT leave `connecting` this pass.
    A key that finally lands -- however late -- is a success, not a timeout."""
    marked, events = _wire_connecting_pass(
        monkeypatch, row=_connecting_row(minutes_old=31), advanced="provisioned"
    )

    await wired["retry"]("u1")

    assert marked == []
    assert events == []


async def test_the_overdue_transition_emits_the_failed_feed_event(wired, monkeypatch):
    """The feed line follows the WRITE, not the attempt: exactly one failed event
    when `mark_provisioning_failed` returned True, and none when the conditional
    update matched nothing (a key attach won the race, so nothing failed)."""
    marked, events = _wire_connecting_pass(
        monkeypatch, row=_connecting_row(minutes_old=31), mark_returns=True
    )
    await wired["retry"]("u1")

    assert marked, "the deadline must have fired for this test to mean anything"
    assert events == [
        {"user_id": "u1", "event_type": FEED_EVENT_FAILED, "reason": "pod_unresponsive"}
    ]

    lost_race, events_after_lost_race = _wire_connecting_pass(
        monkeypatch, row=_connecting_row(minutes_old=31), mark_returns=False
    )
    await wired["retry"]("u1")

    assert lost_race, "the write was attempted and refused"
    assert events_after_lost_race == []


async def test_a_handshake_failed_row_is_never_auto_reprovisioned(wired, monkeypatch):
    """The anti-flap gate: a re-provision heals to the SAME digest the dead pod
    already runs, so auto-retry would cycle connecting<->failed every ~35 minutes.
    The marked row returns BEFORE the identity read, before everything."""
    row = {
        "user_id": "u1",
        "hushh_id": "ha1deadline",
        "status": "provisioning_failed",
        "backend_metadata": {
            "failure": {"code": "handshake_timeout", "detail": "no pod key", "at": "2026-08-25"}
        },
    }

    async def _get(self, user_id):  # noqa: ARG001
        return row

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo.get",
        _get,
    )

    consulted: list = []

    class _Identity:
        def __init__(self):
            consulted.append("constructed")

        async def get_many(self, user_ids):  # noqa: ARG002
            consulted.append("read")
            return {}

    monkeypatch.setattr("hushh_mcp.services.actor_identity_service.ActorIdentityService", _Identity)

    provisioned: list = []

    class _Provisioning:
        def __init__(self, **kwargs):
            provisioned.append(kwargs)

        async def provision(self, **kw):
            provisioned.append(kw)

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_provisioning_service.PersonalAgentProvisioningService",
        _Provisioning,
    )

    await wired["retry"]("u1")

    assert consulted == [], "the gate must return before ActorIdentityService is consulted"
    assert provisioned == []


async def test_mark_provisioning_failed_is_conditional_on_connecting(repo, monkeypatch):
    """The write is race-safe by construction: `.eq(user_id).eq(status,'connecting')`
    so a key attach that lands between the sweep's read and this write wins (zero
    matched rows -> False, nothing written). The failure marker is merged over the
    existing backend_metadata, never a wholesale replace."""
    r, sink = repo
    sink["rows"] = [
        {
            "user_id": "u1",
            "hushh_id": "ha1deadline",
            "status": "connecting",
            "backend_metadata": {"keyless": True},
        }
    ]
    sink["update_rows"] = [{"user_id": "u1"}]

    appended: list[dict] = []

    async def _append(user_id, **kw):
        appended.append({"user_id": user_id, **kw})

    monkeypatch.setattr("hushh_mcp.services.pod_lifecycle_log.append", _append)

    ok = await r.mark_provisioning_failed(
        user_id="u1",
        reason=REASON_HANDSHAKE_TIMEOUT,
        detail="no pod key after 1860s in connecting",
    )

    assert ok is True
    assert sink["update_eq"] == {"user_id": "u1", "status": "connecting"}
    payload = sink["update"]
    assert payload["status"] == "provisioning_failed"
    assert "updated_at" in payload
    failure = payload["backend_metadata"]["failure"]
    assert failure["code"] == REASON_HANDSHAKE_TIMEOUT
    assert failure["detail"] == "no pod key after 1860s in connecting"
    assert failure["at"]
    # Merged over the existing metadata -- a JSONB update replaces the whole column,
    # so dropping this key here is what losing someone's pod facts looks like.
    assert payload["backend_metadata"]["keyless"] is True
    # The terminal verdict reaches the journey narrative, once, on success.
    assert [a["event"] for a in appended] == ["terminal"]
    assert appended[0]["registry_status"] == "provisioning_failed"
    assert appended[0]["reason"] == REASON_HANDSHAKE_TIMEOUT

    # The lost-race case: the conditional update matched zero rows, so the attach's
    # write stands, nothing is recorded as failed, and no narrative is appended.
    sink2: dict = {
        "rows": [
            {
                "user_id": "u1",
                "hushh_id": "ha1deadline",
                "status": "connecting",
                "backend_metadata": {},
            }
        ],
        "update_rows": [],
    }
    r2 = PersonalAgentRegistryRepo()
    monkeypatch.setattr(r2, "_db", lambda: _Query(sink2))
    appended.clear()

    assert await r2.mark_provisioning_failed(user_id="u1", reason=REASON_HANDSHAKE_TIMEOUT) is False
    assert appended == []
