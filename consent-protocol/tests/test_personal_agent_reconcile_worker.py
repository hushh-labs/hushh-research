"""Fleet hygiene for the personal-agent pod fleet (DEV-LIVE-EXECUTION-PLAN.md B6).

Hermetic: no DB, no cloud, no timers. Every database and backend interaction is an
injected async callable, the same shape ``revocation_worker.py`` uses, so each
assertion is about what the sweep *would* do.

The load-bearing properties:

1. **Inert by default.** Both kill-switches default off, so with an unconfigured
   environment no task is scheduled, no callable is ever invoked, and a running
   loop stops on its next pass. This is the ship-dark guarantee and it is tested
   first because it is the one that has to hold in production today.
2. **A reap removes compute, never identity.** The worker is handed no registry
   writer at all, so it structurally cannot delete a row or write a tombstone;
   the tests assert the tear-down callable receives the host id and nothing else
   happens.
3. **One bad record never aborts a sweep**, and a failing fetch on one sweep never
   blocks the other.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings, pod_idle_reap_hours
from hushh_mcp.services.personal_agent_provisioning_service import (
    FEED_EVENT_PROVISIONING,
    FEED_EVENT_REAPED,
)
from hushh_mcp.services.personal_agent_reconcile_worker import (
    IdlePod,
    PersonalAgentReconcileWorker,
    StalledAgent,
    start_personal_agent_reconcile_loop,
)

_FEED_MODULE = "hushh_mcp.services.feed_service.FeedService"


class RecordingFeedService:
    events: list[dict] = []

    def record_event(self, **kw):
        RecordingFeedService.events.append(kw)


class Spy:
    """Records every injected-callable invocation the worker makes."""

    def __init__(
        self,
        *,
        stalled: list[StalledAgent] | None = None,
        idle: list[IdlePod] | None = None,
        fetch_stalled_raises: bool = False,
        fetch_idle_raises: bool = False,
        retry_raises_for: set[str] | None = None,
        reap_raises_for: set[str] | None = None,
    ):
        self.fetch_stalled_calls = 0
        self.fetch_idle_calls: list[datetime] = []
        self.retried: list[str] = []
        self.reaped: list[str] = []
        self._stalled = stalled or []
        self._idle = idle or []
        self._fetch_stalled_raises = fetch_stalled_raises
        self._fetch_idle_raises = fetch_idle_raises
        self._retry_raises_for = retry_raises_for or set()
        self._reap_raises_for = reap_raises_for or set()

    async def fetch_stalled(self) -> list[StalledAgent]:
        self.fetch_stalled_calls += 1
        if self._fetch_stalled_raises:
            raise RuntimeError("registry unavailable: dsn=postgres://secret@host/db")
        return list(self._stalled)

    async def retry(self, user_id: str) -> None:
        if user_id in self._retry_raises_for:
            raise RuntimeError("provision failed: token=HCT:supersecret")
        self.retried.append(user_id)

    async def fetch_idle(self, idle_since: datetime) -> list[IdlePod]:
        self.fetch_idle_calls.append(idle_since)
        if self._fetch_idle_raises:
            raise RuntimeError("registry unavailable")
        return list(self._idle)

    async def reap(self, external_agent_id: str) -> None:
        if external_agent_id in self._reap_raises_for:
            raise RuntimeError("cloud run delete failed")
        self.reaped.append(external_agent_id)

    @property
    def touched(self) -> bool:
        return bool(
            self.fetch_stalled_calls or self.fetch_idle_calls or self.retried or self.reaped
        )


def _worker(spy: Spy) -> PersonalAgentReconcileWorker:
    return PersonalAgentReconcileWorker(
        fetch_stalled=spy.fetch_stalled,
        retry=spy.retry,
        fetch_idle=spy.fetch_idle,
        reap=spy.reap,
    )


def _start(spy: Spy, **kw):
    return start_personal_agent_reconcile_loop(
        fetch_stalled=spy.fetch_stalled,
        retry=spy.retry,
        fetch_idle=spy.fetch_idle,
        reap=spy.reap,
        **kw,
    )


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.delenv("PERSONAL_AGENT_ENABLED", raising=False)
    monkeypatch.delenv("PERSONAL_AGENT_RECONCILE_ENABLED", raising=False)
    monkeypatch.delenv("HUSSH_POD_IDLE_REAP_HOURS", raising=False)
    monkeypatch.setattr(_FEED_MODULE, RecordingFeedService)
    RecordingFeedService.events = []
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


@pytest.fixture
def _enabled(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_RECONCILE_ENABLED", "1")


def _types(events: list[dict]) -> list[str]:
    return [event["event_type"] for event in events]


# ---------------------------------------------------------------------------
# Inert by default — the ship-dark guarantee
# ---------------------------------------------------------------------------


async def test_with_both_flags_unset_nothing_is_scheduled():
    spy = Spy(stalled=[StalledAgent("u1", "ha1", "provisioning_failed")])

    assert _start(spy) is None
    assert spy.touched is False


async def test_with_both_flags_unset_a_scan_touches_nothing():
    spy = Spy(
        stalled=[StalledAgent("u1", "ha1", "provisioning_failed")],
        idle=[IdlePod("u2", "ha2", "one-pod-x")],
    )

    report = await _worker(spy).scan_and_reconcile()

    assert report.skipped is True
    assert report.total_scanned == 0
    # Not "returned zero results" — never asked. No query, no cloud call, no feed.
    assert spy.touched is False
    assert RecordingFeedService.events == []


async def test_the_surface_flag_alone_does_not_enable_the_sweep(monkeypatch):
    # Two independent switches: turning the personal-agent surface on must not
    # start a sweep that tears compute down.
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    spy = Spy(idle=[IdlePod("u2", "ha2", "one-pod-x")])

    assert _start(spy) is None
    assert (await _worker(spy).scan_and_reconcile()).skipped is True
    assert spy.touched is False


async def test_the_reconcile_flag_alone_does_not_enable_the_sweep(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_RECONCILE_ENABLED", "1")
    spy = Spy(idle=[IdlePod("u2", "ha2", "one-pod-x")])

    assert _start(spy) is None
    assert (await _worker(spy).scan_and_reconcile()).skipped is True
    assert spy.touched is False


@pytest.mark.parametrize("raw", ["0", "false", "off", "no", "", "maybe"])
async def test_unset_or_unrecognised_flag_values_read_as_off(monkeypatch, raw):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_RECONCILE_ENABLED", raw)
    spy = Spy(idle=[IdlePod("u2", "ha2", "one-pod-x")])

    assert _start(spy) is None
    assert spy.touched is False


async def test_a_running_loop_goes_inert_when_the_flag_is_flipped_off(monkeypatch, _enabled):
    spy = Spy(stalled=[StalledAgent("u1", "ha1", "provisioning_failed")])
    worker = _worker(spy)

    assert (await worker.scan_and_reconcile()).skipped is False
    monkeypatch.setenv("PERSONAL_AGENT_RECONCILE_ENABLED", "0")

    # No redeploy, no restart: the very next pass does nothing.
    calls_before = spy.fetch_stalled_calls
    assert (await worker.scan_and_reconcile()).skipped is True
    assert spy.fetch_stalled_calls == calls_before


async def test_enabling_the_flags_does_schedule_a_task(_enabled):
    spy = Spy()
    task = _start(spy, interval_seconds=3600)

    assert isinstance(task, asyncio.Task)
    assert task.get_name() == "personal-agent-reconcile-worker"
    await asyncio.sleep(0)  # let the first pass run
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# ---------------------------------------------------------------------------
# Retry sweep
# ---------------------------------------------------------------------------


async def test_stalled_rows_are_retried(_enabled):
    spy = Spy(
        stalled=[
            StalledAgent("u1", "ha1", "provisioning_failed"),
            StalledAgent("u2", "ha2", "provisioning_failed"),
        ]
    )

    report = await _worker(spy).scan_and_reconcile()

    assert spy.retried == ["u1", "u2"]
    assert report.retried_count == 2
    assert report.retry_failed_count == 0


async def test_a_retry_emits_a_provisioning_feed_row(_enabled):
    spy = Spy(stalled=[StalledAgent("u1", "ha1", "provisioning_failed")])

    await _worker(spy).scan_and_reconcile()

    # A retry IS a provisioning attempt, so it reuses that line rather than
    # inventing vocabulary the webapp has no renderer for.
    assert _types(RecordingFeedService.events) == [FEED_EVENT_PROVISIONING]
    assert RecordingFeedService.events[0]["user_id"] == "u1"


async def test_one_failing_retry_does_not_abort_the_sweep(_enabled):
    spy = Spy(
        stalled=[
            StalledAgent("u1", "ha1", "provisioning_failed"),
            StalledAgent("u2", "ha2", "provisioning_failed"),
            StalledAgent("u3", "ha3", "provisioning_failed"),
        ],
        retry_raises_for={"u2"},
    )

    report = await _worker(spy).scan_and_reconcile()

    assert spy.retried == ["u1", "u3"]
    assert report.retried_count == 2
    assert report.retry_failed_count == 1
    # A failed retry emits nothing: the owner is not told setup restarted when it did not.
    assert _types(RecordingFeedService.events) == [FEED_EVENT_PROVISIONING] * 2
    assert "HCT:supersecret" not in str(RecordingFeedService.events)


async def test_a_failing_stalled_fetch_still_lets_the_reap_sweep_run(_enabled):
    spy = Spy(fetch_stalled_raises=True, idle=[IdlePod("u2", "ha2", "one-pod-x")])

    report = await _worker(spy).scan_and_reconcile()

    assert report.retried_count == 0
    assert spy.reaped == ["one-pod-x"]
    assert "postgres://" not in str(RecordingFeedService.events)


# ---------------------------------------------------------------------------
# Reap sweep
# ---------------------------------------------------------------------------


async def test_idle_pods_are_torn_down(_enabled):
    spy = Spy(idle=[IdlePod("u1", "ha1", "one-pod-a"), IdlePod("u2", "ha2", "one-pod-b")])

    report = await _worker(spy).scan_and_reconcile()

    assert spy.reaped == ["one-pod-a", "one-pod-b"]
    assert report.reaped_count == 2


async def test_a_reap_emits_a_reaped_feed_row(_enabled):
    spy = Spy(idle=[IdlePod("u1", "ha1", "one-pod-a")])

    await _worker(spy).scan_and_reconcile()

    assert _types(RecordingFeedService.events) == [FEED_EVENT_REAPED]
    assert RecordingFeedService.events[0]["user_id"] == "u1"
    assert RecordingFeedService.events[0]["source_domain"] == "consent"


async def test_a_reap_only_ever_touches_the_host(_enabled):
    # The registry row, HusshID and A2A address survive a reap. The worker is
    # handed no registry writer at all, so this is structural, not conventional:
    # the ONLY thing it can call is the host tear-down.
    spy = Spy(idle=[IdlePod("u1", "ha1", "one-pod-a")])

    await _worker(spy).scan_and_reconcile()

    assert spy.reaped == ["one-pod-a"]
    assert not hasattr(_worker(spy), "_registry")


async def test_a_row_with_no_host_is_skipped(_enabled):
    spy = Spy(idle=[IdlePod("u1", "ha1", ""), IdlePod("u2", "ha2", "   ")])

    report = await _worker(spy).scan_and_reconcile()

    assert spy.reaped == []
    assert report.reaped_count == 0
    assert RecordingFeedService.events == []


async def test_one_failing_teardown_does_not_abort_the_sweep(_enabled):
    spy = Spy(
        idle=[
            IdlePod("u1", "ha1", "one-pod-a"),
            IdlePod("u2", "ha2", "one-pod-b"),
            IdlePod("u3", "ha3", "one-pod-c"),
        ],
        reap_raises_for={"one-pod-b"},
    )

    report = await _worker(spy).scan_and_reconcile()

    assert spy.reaped == ["one-pod-a", "one-pod-c"]
    assert report.reaped_count == 2
    assert report.reap_failed_count == 1
    assert _types(RecordingFeedService.events) == [FEED_EVENT_REAPED] * 2


async def test_a_failing_idle_fetch_still_lets_the_retry_sweep_run(_enabled):
    spy = Spy(stalled=[StalledAgent("u1", "ha1", "provisioning_failed")], fetch_idle_raises=True)

    report = await _worker(spy).scan_and_reconcile()

    assert spy.retried == ["u1"]
    assert report.reaped_count == 0


# ---------------------------------------------------------------------------
# The idle threshold is policy owned by the worker
# ---------------------------------------------------------------------------


async def test_the_idle_cutoff_uses_the_configured_threshold(monkeypatch, _enabled):
    monkeypatch.setenv("HUSSH_POD_IDLE_REAP_HOURS", "3")
    spy = Spy()

    before = datetime.now(timezone.utc)
    await _worker(spy).scan_and_reconcile()
    after = datetime.now(timezone.utc)

    (cutoff,) = spy.fetch_idle_calls
    assert before - timedelta(hours=3) <= cutoff <= after - timedelta(hours=3)
    assert cutoff.tzinfo is not None


async def test_the_idle_threshold_defaults_to_seven_days(_enabled):
    spy = Spy()
    await _worker(spy).scan_and_reconcile()

    (cutoff,) = spy.fetch_idle_calls
    assert pod_idle_reap_hours() == 168
    assert (datetime.now(timezone.utc) - cutoff) >= timedelta(hours=167, minutes=59)


@pytest.mark.parametrize("raw", ["", "   ", "abc", "0", "-24", "1.5"])
async def test_an_unparseable_idle_threshold_fails_safe(monkeypatch, raw, _enabled):
    # A bad value must never collapse the threshold to zero and reap a live fleet.
    monkeypatch.setenv("HUSSH_POD_IDLE_REAP_HOURS", raw)
    spy = Spy()

    await _worker(spy).scan_and_reconcile()

    (cutoff,) = spy.fetch_idle_calls
    assert (datetime.now(timezone.utc) - cutoff) >= timedelta(hours=167, minutes=59)


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


async def test_the_report_summarises_both_sweeps(_enabled):
    spy = Spy(
        stalled=[StalledAgent("u1", "ha1", "provisioning_failed")],
        idle=[IdlePod("u2", "ha2", "one-pod-a")],
    )

    report = await _worker(spy).scan_and_reconcile()

    assert report.total_scanned == 2
    assert report.skipped is False
    summary = report.summary()
    assert "1 retried" in summary and "1 reaped" in summary
    assert report.scan_end >= report.scan_start


# -- the upgrade-failure log must not carry a person's cloud coordinates ---------


def _safe_detail(exc: BaseException) -> str:
    from hushh_mcp.services.personal_agent_reconcile_worker import (
        _safe_detail as impl,  # noqa: PLC0415
    )

    return impl(exc)


def test_a_cloud_error_body_does_not_put_a_persons_project_in_the_logs():
    """The exact string `raise_for_status()` produces for a refused pod upgrade.

    A comment above this log line forbade logging the message at all -- "the message
    can carry a cloud error body, a URL, or a token" -- and 9fc41c180 then added
    `detail=str(exc)` beneath it and left the prohibition standing. Every failed sweep
    wrote the person's own project id and pod name into hub logs.
    """
    exc = RuntimeError(
        "403 Client Error: Forbidden for url: "
        "https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1"
        "/namespaces/alice-private-cloud/services/one-pod-ha1abc"
    )
    out = _safe_detail(exc)

    assert "alice-private-cloud" not in out, "the person's project id reached the log"
    assert "one-pod-ha1abc" not in out
    assert "run.googleapis.com" not in out
    # and the reason the detail exists at all survives
    assert "403" in out, "redaction removed the diagnosis it was supposed to keep"


def test_a_resource_path_outside_a_url_is_redacted_too():
    """Cloud Run error BODIES carry the same coordinates without an https:// prefix."""
    out = _safe_detail(RuntimeError("permission denied on projects/alice-private-cloud"))
    assert "alice-private-cloud" not in out
    assert "projects/" in out, "the shape is useful; only the name is not"


def test_a_token_shaped_run_is_redacted():
    """A bearer token in an error body is the worst thing this line could print."""
    token = "ya29." + ("A" * 60)
    out = _safe_detail(RuntimeError(f"auth failed: {token}"))
    assert token not in out
    assert "A" * 40 not in out


def test_an_ordinary_failure_still_reads_as_itself():
    """Redaction must not turn every message into noise; most carry no coordinates."""
    out = _safe_detail(RuntimeError("copy refused http=403 digest=sha256:abc123"))
    assert "copy refused" in out
    assert "http=403" in out


def test_an_empty_message_says_so_rather_than_printing_nothing():
    assert _safe_detail(RuntimeError("")) == "<no detail>"
