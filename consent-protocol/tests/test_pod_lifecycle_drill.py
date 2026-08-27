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
