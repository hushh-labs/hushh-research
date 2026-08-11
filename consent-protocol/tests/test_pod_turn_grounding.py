"""A pod grounds on the owner's own projection, and says so truthfully.

`pod_turn` passed `pkm_context=None` and reported `grounded: false`, on the reasoning
that a pod cannot ground until it holds a durable key and a populated store. The
premise was false: it assumed the POD had to be the one to read PKM.

It does not. The browser already decrypts the owner's turn projection from their own
unlocked vault and already sends it to the hub on every Agent Chat turn. Couriering
that same value through the relay grounds a pod turn while preserving Zero Knowledge
exactly — the projection is opened by the owner's key on the owner's device, and the
pod still holds no database credential.

`grounded` must be DERIVED from what reached the runtime. Hardcoding it was honest
while the turn was ungrounded by construction and becomes a lie the moment a
projection arrives — the same failure shape as the `/health` roster literal that
reported four agents from a pod running none.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.routes.one import pod_turn as pt  # noqa: E402

OWNER = "user-1"
PROJECTION = "Owner prefers concise answers and lives in Seattle."


class _Event:
    def __init__(self, text: str) -> None:
        self.kind = "token"
        self.text = text
        self.directive = None


def _runner_capturing(seen: dict):
    """Stands in for `stream_one_text_turn`, recording what the route handed it."""

    async def _runner(**kwargs):
        seen.update(kwargs)
        yield _Event("ok")

    return _runner


@pytest.fixture
def enabled(monkeypatch):
    """Same shape as test_pod_turn_route's fixture: flags on, model resolved, and
    consent stubbed so these tests isolate grounding rather than re-testing auth."""
    monkeypatch.setattr(pt, "pod_mode", lambda: True)
    monkeypatch.setattr(pt, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pt, "_resolve_model", lambda: ("gemini", "gemini-test"))

    async def _validate(_token, *, verifier=None):
        return {"user_id": OWNER, "scope": "pkm.read"}

    monkeypatch.setattr(pt, "_validate_consent", _validate)


def _payload(**kw) -> pt.PodTurnRequest:
    kw.setdefault("runtime_credential", "owner-key")
    return pt.PodTurnRequest(message="hi", **kw)


async def _run(payload: pt.PodTurnRequest, seen: dict):
    return await pt.run_pod_turn(
        payload=payload,
        consent_token="t",  # noqa: S106 - a fixture for an argument stubbed above
        stream_fn=_runner_capturing(seen),
    )


@pytest.mark.asyncio
async def test_a_projection_reaches_the_runtime_and_is_reported_grounded(enabled) -> None:
    seen: dict = {}
    result = await _run(_payload(pkmContext=PROJECTION), seen)

    assert seen["pkm_context"] == PROJECTION
    assert result["grounded"] is True


@pytest.mark.asyncio
async def test_no_projection_is_reported_ungrounded_and_says_why(enabled) -> None:
    """The absence is stated, not left for the model to infer from silence."""
    seen: dict = {}
    result = await _run(_payload(), seen)

    assert seen["pkm_context"] is None
    assert result["grounded"] is False
    assert seen["grounding_reason"], "an ungrounded pod turn must carry its reason"


@pytest.mark.asyncio
async def test_whitespace_is_not_grounding(enabled) -> None:
    """A blank projection that counted would report `grounded: true` for a turn that
    learned nothing — a claim with no holdings behind it."""
    seen: dict = {}
    result = await _run(_payload(pkmContext="   \n  "), seen)

    assert seen["pkm_context"] is None
    assert result["grounded"] is False


@pytest.mark.asyncio
async def test_grounded_is_derived_rather_than_asserted(enabled) -> None:
    """The field and the behaviour cannot drift, because there is only one source.

    Two turns through the same code path, differing only in whether a projection was
    supplied, must disagree on `grounded`. A constant passes one of these and fails
    the other whichever value it is pinned to.
    """
    with_ctx: dict = {}
    without: dict = {}
    a = await _run(_payload(pkmContext=PROJECTION), with_ctx)
    b = await _run(_payload(), without)

    assert a["grounded"] != b["grounded"]


def test_the_relay_carries_the_projection_and_keeps_it_out_of_dumps() -> None:
    """It is the person's holdings. `exclude=True` is what stops a request dump
    carrying it into a log line, exactly as the model credential is protected."""
    from api.routes.one.pod_relay import PodTurnRelayRequest

    req = PodTurnRelayRequest(message="hi", pkmContext=PROJECTION)
    assert req.pkm_context == PROJECTION
    assert PROJECTION not in str(req.model_dump())
    assert PROJECTION not in req.model_dump_json()


def test_both_ends_agree_on_how_much_projection_fits() -> None:
    """A cap tighter on one side would 422 a projection the other accepts, and the
    relay would surface that as an opaque refusal rather than a size problem."""
    from api.routes.one.pod_relay import PodTurnRelayRequest

    relay_cap = PodTurnRelayRequest.model_fields["pkm_context"].metadata
    pod_cap = pt.PodTurnRequest.model_fields["pkm_context"].metadata
    assert str(relay_cap) == str(pod_cap)
