"""The lifecycle drill's orchestration is sound, and it can actually fail.

The drill's live half deletes real Cloud Run services, so it cannot run in CI.
But the sequence it runs -- provision, teach, prove-learned, kill, rebuild the
same owner, recall across the death, negative control -- is pure orchestration
over an injected fleet, and that logic must never regress: a drill that always
passes is worse than no drill, because it certifies a lifecycle nobody checked.
These pin the orchestration AND that a state-losing lifecycle fails it.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_DRILL = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "pod_lifecycle_drill.py"
_spec = importlib.util.spec_from_file_location("pod_lifecycle_drill", _DRILL)
drill = importlib.util.module_from_spec(_spec)
# Register before exec so ``DrillResult``'s dataclass annotations (strings under
# ``from __future__ import annotations``) resolve via ``sys.modules[__module__]``.
sys.modules["pod_lifecycle_drill"] = drill
_spec.loader.exec_module(drill)  # type: ignore[union-attr]


def test_the_self_test_passes():
    """The whole offline check, the same one the operator runs before going live."""
    assert drill._self_test() == 0


async def test_a_preserving_lifecycle_recalls_every_fact_across_the_death():
    result = await drill.run_drill(drill.InMemoryFleet(), hushh_id="HA1PRESERVE")
    assert result.passed
    assert result.recalled == result.horizon_size
    assert result.learned_before_death
    assert result.negative_control_clean


async def test_a_state_losing_lifecycle_fails_the_drill():
    """The reason the drill exists: a rebuild that does NOT reattach to the
    owner's durable state must go red, not silently pass."""
    result = await drill.run_drill(
        drill.InMemoryFleet(loses_state_on_kill=True), hushh_id="HA1LEAKY"
    )
    assert not result.passed
    assert result.recalled == 0, "a wiped owner recalled facts it should have lost"


async def test_the_negative_control_catches_a_pod_that_hallucinates_a_never_taught_fact():
    class _LeaksAbsent(drill.InMemoryFleet):
        async def recall(self, pod_url, keyword):
            base = await super().recall(pod_url, keyword)
            return base + [f"I recall something about {keyword}"]

    result = await drill.run_drill(_LeaksAbsent(), hushh_id="HA1HALLUCINATE")
    # Every taught fact still recalls, and it learned before death -- so the ONLY
    # thing that fails the verdict is the never-taught keyword surfacing.
    assert result.recalled == result.horizon_size
    assert result.learned_before_death
    assert not result.negative_control_clean
    assert not result.passed


async def test_a_pod_that_never_learns_fails_before_the_kill_is_even_meaningful():
    class _Amnesiac(drill.InMemoryFleet):
        async def teach(self, pod_url, keyword, fact):
            return None  # learns nothing

    result = await drill.run_drill(_Amnesiac(), hushh_id="HA1AMNESIAC")
    assert not result.learned_before_death
    assert not result.passed


async def test_the_rebuild_reattaches_to_the_same_owners_state_not_a_fresh_agent():
    """Provisioning the same HusshID after a kill must return the facts the
    deleted service was taught -- the crown property, at the fake's level."""
    fleet = drill.InMemoryFleet()
    url1 = await fleet.provision("HA1SAME")
    await fleet.teach(url1, "meridian", "the meridian account ends in 4269")
    await fleet.kill("HA1SAME")
    url2 = await fleet.provision("HA1SAME")
    assert url2 != url1, "a new service gets a new URL"
    assert await fleet.recall(url2, "meridian") == ["the meridian account ends in 4269"]


# --------------------------------------------------------------------------- #
# Identity across the death. Memory surviving is not the whole claim: a pod that
# kept the records but re-minted its keys is a DIFFERENT agent holding someone's
# history. `podKeyDurable` was served by the pod and read by nothing until the
# drill read it, which is the same reported-but-unverified shape as the original
# ephemeral-identity gap.
# --------------------------------------------------------------------------- #


async def test_the_rebuilt_pod_is_the_same_agent_not_just_the_same_memories():
    result = await drill.run_drill(drill.InMemoryFleet(), hushh_id="HA1IDENTITY")
    assert result.identity_checked
    assert result.identity_preserved
    assert result.identity_before == result.identity_after
    assert result.identity_durable is True
    assert result.passed


async def test_a_pod_that_reminted_its_identity_fails_even_with_perfect_recall():
    """The sharp case: every fact comes back, so the memory half is spotless, and
    the drill must still fail because the agent that answered is a new one."""
    result = await drill.run_drill(
        drill.InMemoryFleet(remints_identity_on_kill=True), hushh_id="HA1REMINT"
    )
    assert result.recalled == result.horizon_size, "memory was intact; identity is the failure"
    assert result.negative_control_clean
    assert result.identity_before != result.identity_after
    assert not result.identity_preserved
    assert not result.passed


def test_an_identity_that_is_equal_but_not_durable_is_not_preserved():
    """Two ephemeral pods agreeing is not durability. Without this, a pod reporting
    podKeyDurable=false could pass on coincidence alone."""
    result = drill.DrillResult(
        horizon_size=1,
        learned_before_death=True,
        recalled=1,
        negative_control_clean=True,
        identity_before="podk_same",
        identity_after="podk_same",
        identity_durable=False,
    )
    assert not result.identity_preserved
    assert not result.passed


def test_a_fleet_that_cannot_report_identity_leaves_it_unchecked_rather_than_failing():
    """Identity may be silent, never wrong: a fleet with no identity surface still
    proves the memory half rather than going red for a check it cannot run."""
    result = drill.DrillResult(
        horizon_size=1,
        learned_before_death=True,
        recalled=1,
        negative_control_clean=True,
    )
    assert not result.identity_checked
    assert result.passed


def test_the_live_fleet_reads_the_pods_own_durability_claim():
    """The assertion that closes the gap: podKeyDurable must actually be consumed."""
    source = _DRILL.read_text(encoding="utf-8")
    assert "/pod/public-key" in source
    assert "podKeyDurable" in source


# --------------------------------------------------------------------------- #
# The live fleet's wiring. Its cloud calls cannot run in CI, but the thing that
# made --live unrunnable was not a cloud call: it was that the owner binding a
# real turn REQUIRES existed in no code path, and that the token minter read an
# attribute the credential does not carry. Both are checkable here.
# --------------------------------------------------------------------------- #


async def test_provisioning_binds_the_owner_so_a_live_turn_is_not_refused():
    """A pod refuses a turn until an owner is bound to it, and the binding must be
    re-applied on the REBUILD too, or the hub answers the consent check for a host
    that no longer exists."""
    calls: list[str] = []

    fleet = drill.GcpFleet(project="p", region="r", user_id="drill-user")
    fleet._service_names["HA1BIND"] = "one-pod-ha1bind"

    async def _fake_prepare(hushh_id):
        calls.append(hushh_id)

    fleet.prepare_owner = _fake_prepare  # type: ignore[method-assign]
    fleet._backend = lambda: _FakeBackend()  # type: ignore[method-assign]
    fleet._run_client = lambda: _FakeRunClient()  # type: ignore[method-assign]

    await fleet.provision("HA1BIND")
    await fleet.provision("HA1BIND")  # the rebuild
    assert calls == ["HA1BIND", "HA1BIND"], "the owner binding did not run on every provision"


async def test_an_unbound_owner_is_a_loud_refusal_not_a_silent_skip():
    """Skipping the binding would produce a pod that 403s on every turn, which
    reads like a broken pod rather than a drill invoked without an owner."""
    fleet = drill.GcpFleet(project="p", region="r")  # no user_id
    with pytest.raises(RuntimeError, match="user-id"):
        await fleet.prepare_owner("HA1NOOWNER")


def test_the_live_turn_uses_the_shared_operator_minter():
    """The bug this replaced: a private copy reading `_service_account_info`, an
    attribute the operator credential does not carry, so every live turn crashed
    wherever an explicit key was not exported."""
    source = _DRILL.read_text(encoding="utf-8")
    assert "operator_identity import mint_operator_id_token" in source
    assert "_service_account_info" not in source


def test_a_refused_pod_turn_keeps_the_pod_s_own_words(monkeypatch):
    """A 403 consent refusal and a 502 model error need different fixes; collapsing
    them into an empty answer throws away the only sentence that says which."""
    import requests

    from hushh_mcp.services import operator_identity

    # Patch the minter, not just the HTTP call: without this the test shells out
    # to a real gcloud and becomes both slow and dependent on who is logged in.
    monkeypatch.setattr(operator_identity, "mint_operator_id_token", lambda _a: "test-token")

    class _Resp:
        status_code = 403
        text = '{"detail":"consent refused for this pod"}'

    monkeypatch.setattr(requests, "post", lambda *a, **k: _Resp())

    fleet = drill.GcpFleet(project="p", region="r", consent_token="grant")  # noqa: S106
    with pytest.raises(RuntimeError, match="consent refused"):
        fleet._turn("https://pod.example", "hello")


class _FakeHandle:
    backend_metadata = {"service": "one-pod-ha1bind"}
    external_agent_id = "one-pod-ha1bind"


class _FakeBackend:
    async def provision(self, _spec):
        return _FakeHandle()


class _FakeRunClient:
    @staticmethod
    def get_service(_name):
        return {"status": {"url": "https://one-pod-ha1bind.run.app"}}


def test_the_report_and_json_round_trip():
    result = drill.DrillResult(
        horizon_size=6,
        learned_before_death=True,
        recalled=6,
        negative_control_clean=True,
        stages=["provisioned", "taught 6 facts"],
    )
    text = drill.render_report(result)
    assert "POD LIFECYCLE DRILL" in text
    assert "PASS" in text
    assert result.to_dict()["passed"] is True
