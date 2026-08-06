"""The pod side of the heartbeat.

The property under test is not "it sends a beat" -- it is that NOTHING the
heartbeat does can take the pod down. A pod whose hub is unreachable must go on
answering its owner's questions; if a failed beat could kill the task or raise into
startup, the heartbeat would have turned a hub outage into an agent outage, and
then auto-heal would restart pods that were serving perfectly.
"""

from __future__ import annotations

import pytest

import pod_server
from hushh_mcp.services.pod_hub_client import PodHubUnavailable


class _Response:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _Client:
    def __init__(self, outcome) -> None:
        self._outcome = outcome
        self.calls: list[str] = []

    def post(self, path: str, **_kwargs):
        self.calls.append(path)
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


async def test_a_beat_posts_to_the_heartbeat_route():
    client = _Client(_Response(200))
    assert await pod_server._heartbeat_once(client) is True
    assert client.calls == ["/api/one/pod/heartbeat"]


async def test_an_unreachable_hub_is_swallowed():
    client = _Client(PodHubUnavailable("hub unreachable: ConnectionError"))
    assert await pod_server._heartbeat_once(client) is False


async def test_an_unexpected_exception_is_swallowed_too():
    """Belt and braces: the pod must survive a bug in its own heartbeat path."""
    client = _Client(RuntimeError("something nobody predicted"))
    assert await pod_server._heartbeat_once(client) is False


@pytest.mark.parametrize("status", [401, 404, 500, 503])
async def test_a_rejected_beat_is_reported_false_not_raised(status: int):
    client = _Client(_Response(status))
    assert await pod_server._heartbeat_once(client) is False


class _StopLoop(Exception):
    """Breaks the infinite loop from inside the patched sleep."""


async def test_the_loop_keeps_beating_after_a_failed_beat(monkeypatch):
    """A run of failures must not end the loop.

    This is the real production shape: ``_heartbeat_once`` swallows its own errors
    and reports False, so the loop sees failures as return values. If a failure
    stopped the loop the pod would go permanently silent after one hub blip, the hub
    would judge it unreachable, and auto-heal would restart a pod that was fine.
    """
    outcomes = [False, False, False, True]
    seen: list[bool] = []

    async def _once(_client):
        result = outcomes[len(seen)]
        seen.append(result)
        return result

    async def _sleep(_seconds):
        if len(seen) >= len(outcomes):
            raise _StopLoop

    monkeypatch.setattr(pod_server, "_heartbeat_once", _once)
    monkeypatch.setattr(pod_server.asyncio, "sleep", _sleep)

    with pytest.raises(_StopLoop):
        await pod_server._heartbeat_loop(0)

    # It kept going through all three failures and reached the recovery.
    assert seen == [False, False, False, True]


async def test_the_loop_sleeps_the_configured_interval_between_beats(monkeypatch):
    """A zero or missing interval would hammer the hub from every pod at once."""
    slept: list[int] = []

    async def _once(_client):
        return True

    async def _sleep(seconds):
        slept.append(seconds)
        if len(slept) >= 2:
            raise _StopLoop

    monkeypatch.setattr(pod_server, "_heartbeat_once", _once)
    monkeypatch.setattr(pod_server.asyncio, "sleep", _sleep)

    with pytest.raises(_StopLoop):
        await pod_server._heartbeat_loop(45)

    assert slept == [45, 45]


def test_no_hub_means_no_heartbeat_task_is_ever_created(monkeypatch):
    """Local and test runs have no hub. Beating into the void would log a failure
    every interval and teach whoever reads those logs to ignore them."""

    def _must_not_be_called():
        raise AssertionError("a heartbeat task was scheduled with no hub configured")

    monkeypatch.setattr(pod_server, "hub_base_url", lambda: None)
    monkeypatch.setattr(pod_server.asyncio, "get_running_loop", _must_not_be_called)

    # The assertion lives in the patched call: reaching it fails the test.
    pod_server._start_heartbeat_loop()


def test_a_configured_hub_does_schedule_the_task(monkeypatch):
    """The mirror of the test above -- otherwise "no task" would pass vacuously."""
    scheduled: list[object] = []

    class _Loop:
        def create_task(self, coro):
            scheduled.append(coro)
            coro.close()  # never actually run it; we only care that it was scheduled
            return None

    monkeypatch.setattr(pod_server, "hub_base_url", lambda: "https://hub.example")
    monkeypatch.setattr(pod_server.asyncio, "get_running_loop", _Loop)

    pod_server._start_heartbeat_loop()

    assert len(scheduled) == 1


# -- the heartbeat needs CPU to actually run ---------------------------------------
#
# The push model rests on a background asyncio loop inside the pod. Cloud Run
# throttles an instance's CPU to near zero between requests, so under the default
# that loop stalls -- and the hub's evaluator reads silence from a WARM pod as a
# fault. The pod would be answering its owner perfectly while auto-heal restarted it
# for being quiet, which is the exact outcome _heartbeat_loop's docstring says the
# design exists to avoid.


def _render(min_instances):
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.gcp_backend import GcpBackend

    backend = GcpBackend(
        project="proj", region="us-central1", min_instances=min_instances, live=False
    )
    config = backend.render_deploy_config(PodSpec(hushh_id="hushh-abc", phone_e164_hash="h", pod_pubkey=""))
    return config["spec"]["template"]["metadata"]["annotations"]


def test_a_warm_pod_gets_cpu_between_requests():
    assert _render(1)["run.googleapis.com/cpu-throttling"] == "false"


def test_an_economy_pod_does_not_buy_always_on_cpu():
    """Silence from a scale-to-zero pod is the HEALTHY state by construction, so
    paying for always-on CPU there would spend money to make a tier report a liveness
    it is designed not to have."""
    assert "run.googleapis.com/cpu-throttling" not in _render(0)


def test_the_two_levers_stay_consistent():
    """minScale and CPU allocation must agree: a warm pod that cannot run its loop is
    a pod the fleet will restart for being healthy."""
    warm = _render(2)
    assert warm["autoscaling.knative.dev/minScale"] == "2"
    assert warm["run.googleapis.com/cpu-throttling"] == "false"
