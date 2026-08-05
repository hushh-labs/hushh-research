"""The concrete probe and heal.

Two things here are load-bearing beyond the happy path:

  * a heal ALWAYS carries a fresh nonce, because a PUT identical to the live spec
    is a no-op -- "healed" with nothing restarted is a 200 on an empty page; and
  * a heal never creates a service it did not find, because that would turn a
    restart into a silent provision with a new identity.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_liveness_adapters as adapters


class _Response:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _Session:
    def __init__(self, outcome) -> None:
        self._outcome = outcome
        self.calls: list[str] = []

    def get(self, url, **_kwargs):
        self.calls.append(url)
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


@pytest.fixture(autouse=True)
def _no_real_tokens(monkeypatch):
    monkeypatch.setattr(adapters, "_identity_token", lambda _audience: "test-token")


def _row(**overrides) -> dict:
    row = {
        "user_id": "u1",
        "hushh_id": "h1",
        "external_agent_id": "one-pod-h1",
        "backend_metadata": {"url": "https://one-pod-h1.run.app"},
    }
    row.update(overrides)
    return row


# -- probe -------------------------------------------------------------------


async def test_a_serving_pod_probes_alive_on_slash_health():
    session = _Session(_Response(200))

    assert await adapters.probe_pod(_row(), session=session) is True
    # /health, never /health/ready: readiness includes a database check and a pod
    # holds no database credential, so a healthy pod would answer 503 to it.
    assert session.calls == ["https://one-pod-h1.run.app/health"]


@pytest.mark.parametrize("status", [500, 503, 404, 403])
async def test_a_pod_that_answers_badly_is_not_alive(status: int):
    """The gunicorn case: the port is bound and the workers are dead."""
    session = _Session(_Response(status))
    assert await adapters.probe_pod(_row(), session=session) is False


async def test_an_unreachable_pod_is_false_not_an_exception():
    session = _Session(ConnectionError("refused"))
    assert await adapters.probe_pod(_row(), session=session) is False


async def test_a_pod_with_no_recorded_address_is_not_confirmed_alive():
    session = _Session(_Response(200))
    assert await adapters.probe_pod(_row(backend_metadata={}), session=session) is False
    assert session.calls == []


async def test_a_non_https_address_is_refused():
    """The address comes from the row the hub wrote; anything else is not trusted."""
    session = _Session(_Response(200))
    row = _row(backend_metadata={"url": "http://evil.example"})
    assert await adapters.probe_pod(row, session=session) is False
    assert session.calls == []


# -- heal --------------------------------------------------------------------


class _RunClient:
    def __init__(self, *, existing: dict | None = None, fail: bool = False) -> None:
        self._existing = existing
        self._fail = fail
        self.replaced: list[tuple[str, str | None]] = []

    def get_service(self, name: str):
        return self._existing

    def replace_service(self, name: str, body: dict, *, revision_nonce=None):
        if self._fail:
            raise RuntimeError("cloud run said no")
        self.replaced.append((name, revision_nonce))
        return {"ok": True}


@pytest.fixture
def _no_key_refresh(monkeypatch):
    async def _noop(_row):
        return None

    import hushh_mcp.services.pod_key_collector as collector

    monkeypatch.setattr(collector, "refresh_pod_key", _noop)


async def test_a_heal_replaces_the_service_with_a_nonce(_no_key_refresh):
    """Without the nonce the PUT matches the live spec and rolls no revision --
    a heal that reports success and restarts nothing."""
    client = _RunClient(existing={"spec": {}})

    assert await adapters.heal_pod(_row(), client=client) is True
    assert len(client.replaced) == 1
    name, nonce = client.replaced[0]
    assert name == "one-pod-h1"
    assert nonce


async def test_two_heals_use_different_nonces(_no_key_refresh):
    """A reused nonce makes the second heal a no-op."""
    client = _RunClient(existing={"spec": {}})

    await adapters.heal_pod(_row(), client=client)
    await adapters.heal_pod(_row(), client=client)

    assert client.replaced[0][1] != client.replaced[1][1]


async def test_a_missing_service_is_not_created(_no_key_refresh):
    """A restart must never quietly become a provision -- that mints a new identity."""
    client = _RunClient(existing=None)

    assert await adapters.heal_pod(_row(), client=client) is False
    assert client.replaced == []


async def test_a_row_with_no_service_name_is_skipped(_no_key_refresh):
    client = _RunClient(existing={"spec": {}})
    assert await adapters.heal_pod(_row(external_agent_id=""), client=client) is False
    assert client.replaced == []


async def test_a_failed_replace_reports_false_rather_than_raising(_no_key_refresh):
    """The sweep treats a False as "not healed" and backs off; a raise would abort
    the whole pass and leave the rest of the fleet unjudged."""
    client = _RunClient(existing={"spec": {}}, fail=True)
    assert await adapters.heal_pod(_row(), client=client) is False


async def test_a_key_refresh_failure_does_not_undo_a_successful_restart(monkeypatch):
    """The restart happened. Reporting failure would make the sweep heal again."""

    async def _boom(_row):
        raise RuntimeError("key re-pull failed")

    import hushh_mcp.services.pod_key_collector as collector

    monkeypatch.setattr(collector, "refresh_pod_key", _boom)
    client = _RunClient(existing={"spec": {}})

    assert await adapters.heal_pod(_row(), client=client) is True


# -- the seams ---------------------------------------------------------------


def test_the_production_seams_never_wire_wake_as_the_sweep_probe():
    """A scheduled wake would keep the whole economy fleet awake and bill for it."""
    seams = adapters.build_liveness_seams(registry=_FakeRegistry())

    assert seams["probe_pod"] is adapters.probe_pod
    assert seams["probe_pod"] is not adapters.wake_pod
    assert seams["heal_pod"] is adapters.heal_pod


class _FakeRegistry:
    async def fetch_liveness_candidates(self, **_kwargs):
        return []

    async def set_health_state(self, **_kwargs):
        return None
