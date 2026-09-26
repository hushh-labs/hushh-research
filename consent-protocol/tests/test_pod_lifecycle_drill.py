"""The lifecycle drill's orchestration is sound, and it can actually fail.

The drill's live half deletes real Cloud Run services, so it cannot run in CI.
But the sequence it runs -- provision, teach, prove-learned, kill, rebuild the
same owner, recall across the death, negative control -- is pure orchestration
over an injected fleet, and that logic must never regress: a drill that always
passes is worse than no drill, because it certifies a lifecycle nobody checked.
These pin the orchestration AND that a state-losing lifecycle fails it.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `consent_token="grant"` / `firebase_token="fb"` are test fixtures for
# arguments genuinely named that way; no real credential appears in this file.
import asyncio
import importlib.util
import json
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
            return base if base else [f"I recall something about {keyword}"]

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


def test_a_fleet_that_cannot_report_identity_cannot_pass():
    """Memory-only evidence cannot establish the whole lifecycle assertion."""
    result = drill.DrillResult(
        horizon_size=1,
        learned_before_death=True,
        recalled=1,
        negative_control_clean=True,
    )
    assert not result.identity_checked
    assert not result.passed


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
    fleet._service_uids["one-pod-ha1bind"] = "synthetic-created-incarnation"

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


async def test_drill_never_kills_a_service_without_creation_identity():
    fleet = drill.GcpFleet(project="synthetic-project", region="us-central1")
    fleet._service_names["synthetic-owner"] = "synthetic-pod"
    with pytest.raises(RuntimeError, match="unproven service incarnation"):
        await fleet.kill("synthetic-owner")


@pytest.mark.parametrize("acknowledged", [False, True])
async def test_partial_creation_is_tracked_before_readiness_and_cleanup_stays_honest(
    monkeypatch, acknowledged
):
    from hushh_mcp.services import gcp_run_client

    fleet = drill.GcpFleet(project="synthetic-project", region="us-central1")
    monkeypatch.setattr(gcp_run_client, "load_operator_credentials", lambda: object())

    def create(self, body, *, adopt_existing=True):
        assert adopt_existing is False
        if not acknowledged:
            raise RuntimeError("acknowledgement lost")
        return {"metadata": {"name": "synthetic-pod", "uid": "synthetic-uid"}}

    deleted = []

    def delete(self, name, *, expected_uid):
        deleted.append((name, expected_uid))

    monkeypatch.setattr(gcp_run_client.GcpRunClient, "create_service", create)
    monkeypatch.setattr(gcp_run_client.GcpRunClient, "delete_service", delete)
    client = fleet._run_client()
    if acknowledged:
        client.create_service({"metadata": {"name": "synthetic-pod"}})
    else:
        with pytest.raises(RuntimeError, match="acknowledgement lost"):
            client.create_service({"metadata": {"name": "synthetic-pod"}})
    # No backend handle returned: IAM/readiness may have failed after creation.
    assert not fleet._service_names
    result = await fleet.teardown()
    assert result["compute_absence_verified"] is acknowledged
    assert result["complete"] is False
    assert result["external_erasure_verified"] is False
    assert deleted == ([("synthetic-pod", "synthetic-uid")] if acknowledged else [])
    assert result["unconfirmed_creates"] == ([] if acknowledged else ["synthetic-pod"])


async def test_failed_compute_cleanup_is_not_reported_removed():
    fleet = drill.GcpFleet(project="synthetic-project", region="us-central1")
    fleet._service_uids["synthetic-pod"] = "synthetic-uid"

    class Client:
        def delete_service(self, name, *, expected_uid):
            raise RuntimeError("sensitive-provider-body")

    fleet._run_client = lambda: Client()
    result = await fleet.teardown()
    assert not result["removed"]
    assert not result["compute_absence_verified"]
    assert "sensitive-provider-body" not in json.dumps(result)


def test_a_refused_pod_turn_never_discloses_response_body(monkeypatch):
    """HTTP status distinguishes failure stages without copying private bodies."""
    import requests

    from hushh_mcp.services import operator_identity

    # Patch the minter, not just the HTTP call: without this the test shells out
    # to a real gcloud and becomes both slow and dependent on who is logged in.
    minted_audiences = []

    def mint(audience):
        minted_audiences.append(audience)
        return "test-token"

    monkeypatch.setattr(operator_identity, "mint_operator_id_token", mint)

    class _Resp:
        status_code = 403
        text = '{"detail":"consent refused for this pod"}'

    monkeypatch.setattr(requests, "post", lambda *a, **k: _Resp())

    fleet = drill.GcpFleet(project="p", region="r", consent_token="grant")  # noqa: S106
    with pytest.raises(RuntimeError, match="pod turn HTTP 403") as failure:
        fleet._turn("https://pod.example", "hello")
    assert "consent refused" not in str(failure.value)
    assert minted_audiences == ["https://pod.example"]


class _FakeHandle:
    backend_metadata = {"service": "one-pod-ha1bind"}
    external_agent_id = "one-pod-ha1bind"


class _FakeBackend:
    async def provision(self, _spec):
        return _FakeHandle()


class _FakeRunClient:
    @staticmethod
    def get_service(_name):
        return {
            "metadata": {"uid": "synthetic-created-incarnation"},
            "status": {"url": "https://one-pod-ha1bind.run.app"},
        }


async def test_replacement_after_creation_cannot_supply_the_drill_turn_url():
    fleet = drill.GcpFleet(project="synthetic-project", region="us-central1", user_id="drill-user")
    fleet._service_uids["one-pod-ha1bind"] = "synthetic-original-incarnation"
    fleet._backend = lambda: _FakeBackend()
    fleet._run_client = lambda: _FakeRunClient()

    async def forbidden_binding(owner):
        raise AssertionError("replacement must not bind an owner")

    fleet.prepare_owner = forbidden_binding
    with pytest.raises(RuntimeError, match="incarnation changed"):
        await fleet.provision("HA1BIND")


def test_the_report_and_json_round_trip():
    result = drill.DrillResult(
        horizon_size=6,
        learned_before_death=True,
        recalled=6,
        negative_control_clean=True,
        stages=["provisioned", "taught 6 facts"],
        identity_before="synthetic-key",
        identity_after="synthetic-key",
        identity_durable=True,
        identity_durable_before=True,
    )
    text = drill.render_report(result)
    assert "POD LIFECYCLE DRILL" in text
    assert "PASS" in text
    assert result.to_dict()["passed"] is True


@pytest.mark.parametrize(
    "reply",
    [
        "radiator",
        "I know nothing about radiator",
        "the radiator is fine",
        "the guest room radiator leaks when it rains but that is false",
    ],
)
def test_query_echo_and_wrong_facts_do_not_prove_recall(reply):
    keyword, fact = drill.HORIZON[0]
    assert not drill._hit(keyword, fact, [reply])


@pytest.mark.parametrize("durable", ["false", "true", 1, None, False])
async def test_malformed_or_false_identity_durability_cannot_pass(durable):
    class Fleet(drill.InMemoryFleet):
        async def identity(self, url):
            return {"podKeyId": "synthetic-key", "podKeyDurable": durable}

    assert not (await drill.run_drill(Fleet(), hushh_id="SYNTHETIC")).passed


async def test_identity_outage_does_not_pass_or_print_private_error(capsys):
    class Fleet(drill.InMemoryFleet):
        async def identity(self, url):
            raise RuntimeError("synthetic-private-error")

    assert not (await drill.run_drill(Fleet(), hushh_id="SYNTHETIC")).passed
    assert "synthetic-private-error" not in capsys.readouterr().out


async def test_predeath_ephemeral_identity_cannot_pass_after_durable_rebuild():
    class Fleet(drill.InMemoryFleet):
        async def identity(self, url):
            return {"podKeyId": "synthetic-key", "podKeyDurable": self._counter > 1}

    assert not (await drill.run_drill(Fleet(), hushh_id="SYNTHETIC")).passed


async def test_absent_fact_hallucination_without_query_keyword_is_rejected():
    class Fleet(drill.InMemoryFleet):
        async def recall(self, url, keyword):
            value = await super().recall(url, keyword)
            return value or ["the missing record says something invented"]

    assert not (await drill.run_drill(Fleet(), hushh_id="SYNTHETIC")).passed


@pytest.mark.parametrize("extra_args", [[], ["--dry-run"]])
def test_live_cli_refuses_before_resource_or_authority_access(
    monkeypatch, tmp_path, capsys, extra_args
):
    def forbidden(*args, **kwargs):
        pytest.fail("blocked live drill touched resource or consent authority")

    monkeypatch.setattr(drill, "GcpFleet", forbidden)
    monkeypatch.setattr(drill, "run_drill", forbidden)
    report_path = tmp_path / "receipt.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "pod_lifecycle_drill.py",
            "--live",
            "--project",
            "synthetic-project",
            "--owner",
            "synthetic-owner",
            "--user-id",
            "synthetic-user",
            "--consent-token",
            "synthetic-private-token",
            "--report-path",
            str(report_path),
            *extra_args,
        ],
    )
    assert drill.main() == 2
    report = json.loads(report_path.read_text())
    assert report == {
        "mode": "live",
        "passed": False,
        "executed": False,
        "reason": "disposable_ownership_and_cleanup_unverified",
    }
    captured = capsys.readouterr()
    assert json.loads(captured.out) == report
    assert not captured.err
    assert "synthetic" not in report_path.read_text()


def test_dry_run_cli_still_executes_oracle_without_live_fleet(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        pytest.fail("dry run constructed a live fleet")

    monkeypatch.setattr(drill, "GcpFleet", forbidden)
    report_path = tmp_path / "receipt.json"
    monkeypatch.setattr(
        sys, "argv", ["pod_lifecycle_drill.py", "--dry-run", "--report-path", str(report_path)]
    )
    assert drill.main() == 0
    assert json.loads(report_path.read_text()) == {"mode": "dry-run", "passed": True}


# -- the memory LEARNING drill --------------------------------------------------------


async def test_a_learning_pod_passes_the_memory_drill_and_every_observation_is_true():
    fleet = drill.InMemoryMemoryFleet()
    result = await drill.run_memory_learning_drill(fleet, hushh_id="HA1LEARNS")
    assert result.passed, result.stages
    observations = result.observations()
    for name in (
        "paraphrase_recalled",
        "recall_via_observed_tool_call",
        "correction_supersedes",
        "stale_value_not_recalled",
        "restart_without_history",
        "revoked_fact_not_recalled_after_replay",
        "negative_control_clean",
        "review_ran_on_close",
        "review_provider_matches_turn_provider",
        "memory_join_present_on_image",
        "catch_up_debt_zero",
        "tombstones_increased",
    ):
        assert observations[name] is True, name
    assert observations["taught"] == len(drill.MEMORY_HORIZON)
    assert observations["quality_judged_independently"] is False, (
        "the drill never grants itself the judged number"
    )
    assert set(result.timings_ms) >= {"paraphrase_recall", "restart_recall", "revoke_replay"}


@pytest.mark.parametrize("leak", drill.MEMORY_LEAKS)
async def test_each_leaky_variant_fails_the_memory_drill(leak):
    """One test per leak, each the exact defect a real pod could carry."""
    result = await drill.run_memory_learning_drill(
        drill.InMemoryMemoryFleet(leak=leak), hushh_id="HA1LEAKS"
    )
    assert not result.passed, f"{leak} passed: {result.stages}"
    observations = result.observations()
    expected_false = {
        "ignores_corrections": "correction_supersedes",
        "resurrects_revoked_on_replay": "revoked_fact_not_recalled_after_replay",
        "answers_without_tool": "recall_via_observed_tool_call",
        "hallucinates_absent": "negative_control_clean",
        "credits_fallback_as_provider": "provider_report_consistent",
        "reviews_on_other_provider": "review_provider_matches_turn_provider",
        "never_reviews_on_close": "review_ran_on_close",
    }[leak]
    assert observations[expected_false] is False, (leak, observations)


def test_the_seven_leaks_are_exactly_the_seven_the_plan_names():
    assert set(drill.MEMORY_LEAKS) == {
        "ignores_corrections",
        "resurrects_revoked_on_replay",
        "answers_without_tool",
        "hallucinates_absent",
        "credits_fallback_as_provider",
        "reviews_on_other_provider",
        "never_reviews_on_close",
    }


async def test_every_recall_carries_an_empty_history():
    """Only the pod's own memory may answer: the browser thread never rides along."""
    fleet = drill.InMemoryMemoryFleet()
    await drill.run_memory_learning_drill(fleet, hushh_id="HA1EMPTYHISTORY")
    assert fleet.asks, "no recall was asked"
    assert all(ask["history"] == [] for ask in fleet.asks)
    assert all(drill.NO_RECORDED_FACT in ask["question"] for ask in fleet.asks)


def test_the_value_oracle_scores_values_not_echoes():
    hit = drill._value_hit
    assert hit("Your dachshund is named Pushkin.", ("pushkin",))
    assert hit("It leaks when it rains.", ("leak",))
    assert not hit("What is the name of my dachshund?", ("pushkin",)), "an echo is not recall"
    assert hit("Zephyr berths at slip forty.", ("forty",), ("twelve",))
    assert not hit("Zephyr berths at slip forty, not twelve.", ("forty",), ("twelve",)), (
        "a stale value beside the new one is still a stale value served"
    )
    assert not hit("", ("forty",))
    assert not hit("NO_RECORDED_FACT", ("forty",))


def test_paraphrase_questions_never_contain_their_own_answers():
    for fact in [*drill.MEMORY_HORIZON, drill.REVOCABLE_FACT]:
        words = drill._answer_tokens(fact.ask)
        for token in fact.value_tokens + fact.new_value_tokens:
            assert not any(w == token or w.startswith(token) for w in words), (fact.key, token)


def test_the_judge_queue_is_blinded_sealed_outside_and_carries_no_ids_or_prompts(tmp_path):
    result = drill.MemoryDrillResult(horizon_size=6)
    result.judge_rows = [
        {"question": f.ask, "answer": f"Answer about {f.key}.", "case": f.key}
        for f in drill.MEMORY_HORIZON
    ]
    run_dir = tmp_path / "runs" / "memory-1"
    summary = drill.write_judge_queue(
        result.judge_rows, run_dir=run_dir, seed=7, harness_path=_DRILL
    )
    queue_text = (run_dir / "review-queue.jsonl").read_text()
    manifest = json.loads((run_dir / "run-manifest.json").read_text())
    rows = [json.loads(line) for line in queue_text.splitlines()]
    assert summary["rows"] == len(rows) == 6 + 6
    assert summary["negative_controls"] == 4 and summary["positive_controls"] == 2
    assert manifest["controls"] == {"negative": 4, "positive": 2}
    assert set(manifest["hashes"]) == {r["id"] for r in rows}
    assert set(manifest["rules"]) == {
        "wrong-value",
        "stale-value",
        "revoked-leak",
        "invented",
        "omission",
    }
    # Nothing in the queue or the manifest names the owner, a pod, a memory id or a prompt.
    for forbidden in (
        "HA1",
        "hushh",
        "mem-",
        "Please remember",
        "NO_RECORDED_FACT",
        "planted",
        "salt",
    ):
        assert forbidden not in queue_text and forbidden not in json.dumps(manifest), forbidden
    assert all(set(r) == {"id", "utterance", "output"} for r in rows)
    # Same seed, same order; a different seed, a different order.
    again = tmp_path / "runs" / "memory-2"
    drill.write_judge_queue(result.judge_rows, run_dir=again, seed=7, harness_path=_DRILL)
    assert [
        json.loads(line)["utterance"]
        for line in (again / "review-queue.jsonl").read_text().splitlines()
    ] == [r["utterance"] for r in rows]
    other = tmp_path / "runs" / "memory-3"
    drill.write_judge_queue(result.judge_rows, run_dir=other, seed=8, harness_path=_DRILL)
    assert [
        json.loads(line)["utterance"]
        for line in (other / "review-queue.jsonl").read_text().splitlines()
    ] != [r["utterance"] for r in rows]
    # The seal lives OUTSIDE the run directory, and only it knows which rows are planted.
    seals = list((tmp_path / "runs" / ".judge-seals").glob("*.seal.json"))
    assert len(seals) == 3
    assert not list(run_dir.glob("*seal*"))
    seal = json.loads(seals[0].read_text())
    assert len(seal["controls"]) == 6 and seal["salt"]
    assert seal["harness_sha256"] == manifest["harness_sha256"]
    with pytest.raises(ValueError):
        drill.write_judge_queue(result.judge_rows, run_dir=run_dir, seed=1, seal_dir=run_dir)


def test_the_receipt_passes_the_completion_judges_validator(tmp_path, monkeypatch):
    import datetime as _dt
    import hashlib
    import importlib.util
    import subprocess

    judge_path = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "pod_completion_judge.py"
    spec = importlib.util.spec_from_file_location("pod_completion_judge_for_drill", judge_path)
    judge = importlib.util.module_from_spec(spec)
    # Registered before exec, as the drill itself is above: the judge's dataclasses
    # resolve their string annotations through sys.modules[__module__].
    sys.modules["pod_completion_judge_for_drill"] = judge
    spec.loader.exec_module(judge)  # type: ignore[union-attr]

    def git(*args):
        return subprocess.check_output(["git", *args], cwd=tmp_path).decode().strip()  # noqa: S603 - synthetic fixture arguments

    git("init", "-q")
    git("config", "user.email", "synthetic@example.invalid")
    git("config", "user.name", "Synthetic Fixture")
    (tmp_path / "probe.py").write_text("print('synthetic')\n")
    git("add", "probe.py")
    git("commit", "-qm", "synthetic baseline")

    result = asyncio.run(
        drill.run_memory_learning_drill(drill.InMemoryMemoryFleet(), hushh_id="HA1RECEIPT")
    )
    assert result.passed
    target = {"mode": "local", "environment": "synthetic"}
    receipt = drill.write_receipt(
        tmp_path / "receipt.json",
        result=result,
        target=target,
        repo_root=tmp_path,
        source_paths=("probe.py",),
        commands=["pod_lifecycle_drill.py --memory --consent-token <redacted>"],
    )
    git("add", "receipt.json")
    raw = (tmp_path / "receipt.json").read_bytes()
    item = {
        "id": drill.MEMORY_DRILL_ASSERTION_ID,
        "assertion_id": drill.MEMORY_DRILL_ASSERTION_ID,
        "check": {"kind": "receipt"},
        "artifact": "receipt.json",
        "artifact_sha256": hashlib.sha256(raw).hexdigest(),
        "expected_target": target,
        "source_paths": ["probe.py"],
        "reproduce": "probe.py",
        "observation_requirements": {
            "taught": {"minimum": 6},
            "paraphrase_recalled": {"equals": True},
            "recall_via_observed_tool_call": {"equals": True},
            "correction_supersedes": {"equals": True},
            "stale_value_not_recalled": {"equals": True},
            "restart_without_history": {"equals": True},
            "revoked_fact_not_recalled_after_replay": {"equals": True},
            "negative_control_clean": {"equals": True},
            "review_ran_on_close": {"equals": True},
            "review_provider_matches_turn_provider": {"equals": True},
            "memory_join_present_on_image": {"equals": True},
        },
    }
    monkeypatch.setattr(judge, "REPO_ROOT", tmp_path)
    valid, detail = judge._validate_receipt_artifact(
        item, _dt.datetime.now(_dt.timezone.utc).date()
    )
    assert valid, detail
    assert receipt["result"] == "pass" and receipt["exit_code"] == 0
    assert "<redacted>" in receipt["commands"][0]
    text = json.dumps(receipt)
    for private in ("Pushkin", "4269", "HA1RECEIPT"):
        assert private not in text
    # The judged number is never granted by the drill itself.
    assert receipt["observations"]["quality_judged_independently"] is False


def test_secret_flags_are_redacted_from_the_recorded_command():
    argv = ["--memory", "--consent-token", "abc", "--firebase-token=xyz", "--seed", "3"]
    assert drill._redacted_argv(argv) == [
        "--memory",
        "--consent-token",
        "<redacted>",
        "--firebase-token=<redacted>",
        "--seed",
        "3",
    ]


def test_the_memory_drill_refuses_an_image_without_the_join():
    class _PreJoin(drill.InMemoryMemoryFleet):
        async def info(self, pod_url):
            info = await super().info(pod_url)
            info["memoryJoin"] = {"write": True, "review": False, "tombstones": False, "schema": 1}
            return info

    result = asyncio.run(drill.run_memory_learning_drill(_PreJoin(), hushh_id="HA1PREJOIN"))
    assert result.memory_join_present_on_image is False
    assert not result.passed


def test_the_existing_pod_fleet_refuses_incomplete_auth_before_any_network():
    with pytest.raises(ValueError):
        drill.ExistingPodFleet(hushh_id="ha1x", pod_url="https://pod", auth="direct")
    with pytest.raises(ValueError):
        drill.ExistingPodFleet(hushh_id="ha1x", pod_url="https://pod", auth="hub-proxy")
    fleet = drill.ExistingPodFleet(
        hushh_id="ha1x", pod_url="https://pod/", auth="direct", consent_token="grant"
    )
    assert fleet._runtime_fields() == {}
    puppy = drill.ExistingPodFleet(
        hushh_id="ha1x",
        pod_url="https://pod",
        auth="hub-proxy",
        hub_url="https://hub",
        firebase_token="fb",
        puppy_device_id="device-1",
    )
    with pytest.raises(RuntimeError):
        asyncio.run(puppy.restart("ha1x", "https://pod"))  # needs --service and --project
