"""The live parity probe's classify pipeline is sound, guarded in CI.

The probe's live capture needs a real pod and a session, but the pipeline it
feeds -- reduce both delivered contracts, classify in STRUCTURAL mode -- is pure
and must never regress, because a probe whose classifier is wrong would report
false parity on a broken pod (or false alarms on a working one) and teach the
team to ignore it. These pin exactly that pipeline.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from hushh_mcp.observability.parity_oracle import EquivalenceMode
from hushh_mcp.services.operator_identity import mint_operator_id_token

_PROBE = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "pod_parity_probe.py"
_spec = importlib.util.spec_from_file_location("pod_parity_probe", _PROBE)
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)  # type: ignore[union-attr]


def _matched_pair():
    pod_turn = {
        "text": "Running a full analysis on NVIDIA.",
        "grounded": True,
        "runtimeMode": "user_adc",
        "directiveCount": 1,
        "directives": [
            {
                "kind": "action",
                "payload": {"actionId": "analysis.start", "execution": "frontend"},
                "delegateAgentId": None,
            }
        ],
    }
    hub_frames = [
        {"event": "token", "data": {"text": "Let me analyze NVIDIA."}},
        {"event": "tool_start", "data": {"action_id": "analysis.start", "execution": "frontend"}},
    ]
    return pod_turn, hub_frames


def test_the_self_test_passes():
    """The whole offline pipeline check, the same one the operator runs first."""
    assert probe._self_test() == 0


def test_structural_mode_calls_a_matched_pair_at_parity():
    pod_turn, hub_frames = _matched_pair()
    diff = probe.classify_pair(
        pod_turn=pod_turn,
        hub_frames=hub_frames,
        hub_grounded=True,
        mode=EquivalenceMode.STRUCTURAL,
    )
    assert diff.at_parity


def test_a_live_pod_that_dropped_a_directive_is_not_parity():
    """The reason the probe exists: catch a pod that answered but failed to carry
    the action the hub carried."""
    _, hub_frames = _matched_pair()
    dropped = {"text": "ok", "grounded": True, "directiveCount": 1}  # count, no payload
    diff = probe.classify_pair(pod_turn=dropped, hub_frames=hub_frames, hub_grounded=True)
    assert not diff.at_parity


def test_a_silent_pod_is_not_parity_with_a_speaking_hub():
    _, hub_frames = _matched_pair()
    silent = {"text": "", "grounded": False}
    diff = probe.classify_pair(pod_turn=silent, hub_frames=hub_frames, hub_grounded=True)
    assert not diff.at_parity


def test_the_report_renders_without_error():
    pod_turn, hub_frames = _matched_pair()
    diff = probe.classify_pair(pod_turn=pod_turn, hub_frames=hub_frames, hub_grounded=True)
    text = probe.render_report(diff, prompt="analyze NVIDIA")
    assert "LIVE PARITY" in text
    assert "at parity" in text


# --------------------------------------------------------------------------- #
# The operator ID-token minter falls back across environments. Two ops scripts
# each grew a copy that read an attribute the credential does not carry, so both
# worked only where an explicit key was exported and crashed everywhere else.
# One shared minter now backs the probe's live capture; these pin its fallback
# ORDER so a live run works on an operator workstation, not only in CI.
# --------------------------------------------------------------------------- #


def _boom(*_a, **_k):
    raise RuntimeError("source unavailable")


class _FakeProc:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr


def test_the_minter_falls_back_to_gcloud_when_no_key_and_no_attached_identity(monkeypatch):
    """The posture that broke the probe: no env key, and ADC is a user credential
    that cannot mint an audience-bound ID token -- so gcloud's active account is
    the only source, and the minter must reach it."""
    import subprocess

    import google.oauth2.id_token as idt

    monkeypatch.delenv("GCP_DEPLOY_SA_KEY_B64", raising=False)
    monkeypatch.setattr(idt, "fetch_id_token", _boom)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc(stdout="TOKEN-FROM-GCLOUD\n"))

    assert mint_operator_id_token("https://pod.example") == "TOKEN-FROM-GCLOUD"


def test_the_minter_moves_past_an_unusable_env_key_rather_than_crashing(monkeypatch):
    """A malformed env key must not abort the whole mint -- it is one source of
    three, and the crash it used to cause is exactly the bug being fixed."""
    import subprocess

    import google.oauth2.id_token as idt

    monkeypatch.setenv("GCP_DEPLOY_SA_KEY_B64", "not-valid-base64-or-json!!!")
    monkeypatch.setattr(idt, "fetch_id_token", _boom)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc(stdout="TOKEN-FROM-GCLOUD"))

    assert mint_operator_id_token("https://pod.example") == "TOKEN-FROM-GCLOUD"


def test_the_minter_raises_naming_every_source_when_all_fail(monkeypatch):
    """A failure that names only one source sends the operator looking in the
    wrong place; the error must name all three it tried."""
    import subprocess

    import google.oauth2.id_token as idt

    monkeypatch.delenv("GCP_DEPLOY_SA_KEY_B64", raising=False)
    monkeypatch.setattr(idt, "fetch_id_token", _boom)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc(returncode=1, stderr="reauth"))

    with pytest.raises(RuntimeError) as excinfo:
        mint_operator_id_token("https://pod.example")
    message = str(excinfo.value)
    assert "attached" in message
    assert "gcloud" in message


def test_the_hub_grounding_is_never_read_off_the_pod():
    """The defect this closes: the probe derived the HUB's grounding from the POD's
    own answer, so the two agreed by construction and the grounding comparison could
    never fail. A score with an unfalsifiable dimension overstates what was checked."""
    source = _PROBE.read_text(encoding="utf-8")
    assert 'hub_grounded=bool(pod_turn.get("grounded"))' not in source, (
        "the hub's grounding is being taken from the pod again"
    )
    assert "--hub-grounded" in source, "there is no way to state the hub's grounding"


def test_a_live_run_refuses_rather_than_guessing_an_unstated_hub_grounding(tmp_path, capsys):
    frames = tmp_path / "frames.json"
    frames.write_text('[{"event": "token", "data": {"text": "hi"}}]')
    import sys

    argv = sys.argv
    sys.argv = [
        "probe",
        "--pod-url",
        "https://pod.example",
        "--consent-token",
        "t",
        "--hub-frames",
        str(frames),
    ]
    try:
        assert probe.main() == 2
    finally:
        sys.argv = argv
    assert "never be read off the pod" in capsys.readouterr().out


def test_the_live_capture_uses_the_shared_minter_rather_than_a_private_copy():
    """The defect being prevented: a second copy of the token logic drifting from
    this one. The probe must resolve its token through the shared module."""
    source = _PROBE.read_text(encoding="utf-8")
    assert "operator_identity import mint_operator_id_token" in source
    assert "_service_account_info" not in source, (
        "the probe is reading an attribute the operator credential does not carry"
    )


# --------------------------------------------------------------------------- #
# Lane B7: the ledger's `specialists-run-in-pod` observations have a producer.
# Derived from the delivered turn, never asserted; a hub-door turn yields a hub
# read the judge refuses, and a receipt built from a pod-executed turn passes it.
# --------------------------------------------------------------------------- #

import datetime as _dt  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import subprocess  # noqa: E402

_JUDGE = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "pod_completion_judge.py"
_judge_spec = importlib.util.spec_from_file_location("pod_completion_judge_for_probe", _JUDGE)
judge_mod = importlib.util.module_from_spec(_judge_spec)
# Dataclass creation looks the module up by name; register it before executing.
sys.modules["pod_completion_judge_for_probe"] = judge_mod
_judge_spec.loader.exec_module(judge_mod)  # type: ignore[union-attr]

_LEDGER = Path(__file__).resolve().parents[2] / "config" / "pod-completion-ledger.yaml"


def _location_proposal_turn(**over):
    """The exact envelope `run_pod_turn` returns for the Location proposal path:
    the shared Location service ran in the pod, proposed a link, read no hub door."""
    turn = {
        "text": "Confirm the proposed link.",
        "model": "qwen3-30b-a3b-mlx",
        "modelReported": True,
        "provider": "puppy",
        "grounded": True,
        "directiveCount": 1,
        "directives": [
            {
                "kind": "action",
                "payload": {"type": "create_public_link", "durationHours": 0.5},
                "delegateAgentId": "agent_location",
            }
        ],
        "specialists": [
            {
                "agentId": "agent_location",
                "status": "ok",
                "execution": "pod",
                "informationSource": "none",
                "hubReads": 0,
                "reason": "",
            }
        ],
        "dependencies": {"hub": [], "unavailable": []},
        "runtimeMode": "puppy_relay",
    }
    turn.update(over)
    return turn


def _hub_door_turn():
    return _location_proposal_turn(
        specialists=[
            {
                "agentId": "agent_location",
                "status": "ok",
                "execution": "pod",
                "informationSource": "hub_door",
                "hubReads": 1,
                "reason": "",
            }
        ],
        dependencies={"hub": ["agent_location"], "unavailable": []},
    )


def test_observations_are_derived_from_a_pod_executed_turn():
    observations = probe.derive_ledger_observations(_location_proposal_turn())
    assert observations == {
        "specialist_execution_attributed_to_pod": True,
        "consented_success": True,
        "native_specialist_executions": 1,
        "hub_specialist_information_reads": 0,
    }


def test_a_hub_door_turn_yields_a_hub_read_the_ledger_refuses_negative_control():
    """The whole point: a transitional hub-backed read cannot earn the item."""
    observations = probe.derive_ledger_observations(_hub_door_turn())
    assert observations["hub_specialist_information_reads"] == 1
    item = probe.load_ledger_item(_LEDGER)
    failures = probe.observation_failures(observations, item["check"]["observation_requirements"])
    assert failures and failures[0].startswith("hub_specialist_information_reads")


def test_a_hub_door_read_with_a_missing_count_still_counts_one():
    turn = _hub_door_turn()
    del turn["specialists"][0]["hubReads"]
    turn["dependencies"] = {"hub": [], "unavailable": []}
    assert probe.derive_ledger_observations(turn)["hub_specialist_information_reads"] == 1


def test_an_outcome_that_predates_the_trace_is_not_attributed_to_the_pod():
    """Empty execution means unknown; unknown is never counted as pod."""
    turn = _location_proposal_turn(specialists=[{"agentId": "agent_location", "status": "ok"}])
    observations = probe.derive_ledger_observations(turn)
    assert observations["specialist_execution_attributed_to_pod"] is False
    assert observations["native_specialist_executions"] == 0


def test_a_turn_with_no_specialists_is_not_attributed():
    observations = probe.derive_ledger_observations(_location_proposal_turn(specialists=[]))
    assert observations["specialist_execution_attributed_to_pod"] is False
    assert observations["native_specialist_executions"] == 0


def test_a_degraded_or_refused_turn_is_not_a_consented_success():
    degraded = probe.derive_ledger_observations(
        _location_proposal_turn(degraded="puppy_capability_unsupported")
    )
    assert degraded["consented_success"] is False
    refused = _location_proposal_turn()
    refused["specialists"][0]["status"] = "unsupported"
    assert probe.derive_ledger_observations(refused)["consented_success"] is False


def test_the_shipped_ledger_requirements_are_the_four_the_producer_derives():
    item = probe.load_ledger_item(_LEDGER)
    requirements = item["check"]["observation_requirements"]
    observations = probe.derive_ledger_observations(_location_proposal_turn())
    assert set(requirements) == set(observations)
    assert probe.observation_failures(observations, requirements) == []
    # The producer and the receipt reproduce path are this script.
    assert item["check"]["reproduce"] == "consent-protocol/scripts/ops/pod_parity_probe.py"


@pytest.fixture
def synthetic_repo(tmp_path, monkeypatch):
    """A tracked repository with synthetic sources, so the judge's revision and
    digest checks run for real against a receipt this producer wrote."""

    def git(*args):
        return subprocess.check_output(["git", *args], cwd=tmp_path).decode().strip()  # noqa: S603 - synthetic fixture

    git("init", "-q")
    git("config", "user.email", "synthetic@example.invalid")
    git("config", "user.name", "Synthetic Fixture")
    (tmp_path / "probe.py").write_text("print('synthetic probe')\n")
    (tmp_path / "runtime.py").write_text("print('synthetic runtime')\n")
    git("add", "probe.py", "runtime.py")
    git("commit", "-qm", "synthetic baseline")
    monkeypatch.setattr(judge_mod, "REPO_ROOT", tmp_path)
    return tmp_path, git


def _ledger_item(target):
    """The shipped item's requirements with a local target so the judge can be
    exercised offline; the shipped ledger itself demands a deployed target."""
    shipped = probe.load_ledger_item(_LEDGER)
    check = {
        "kind": "receipt",
        "verified_on": _dt.datetime.now(_dt.timezone.utc).date().isoformat(),
        "expires_after_days": 30,
        "reproduce": "probe.py",
        "artifact": "receipt.json",
        "source_paths": ["probe.py", "runtime.py"],
        "expected_target": target,
        "observation_requirements": dict(shipped["check"]["observation_requirements"]),
    }
    return {
        "id": "specialists-run-in-pod",
        "requirement": "Capability",
        "statement": shipped["statement"],
        "falsifiable": True,
        "check": check,
    }


def _record(repo, git, item, receipt):
    raw = json.dumps(receipt, indent=2, sort_keys=True).encode()
    (repo / "receipt.json").write_bytes(raw)
    item["check"]["artifact_sha256"] = hashlib.sha256(raw).hexdigest()
    git("add", "receipt.json")
    git("commit", "-qm", "record receipt")
    return item


def test_a_receipt_built_from_a_pod_executed_turn_passes_the_judge(synthetic_repo):
    repo, git = synthetic_repo
    target = {"mode": "local", "environment": "synthetic"}
    item = _ledger_item(target)
    receipt = probe.build_receipt(
        _location_proposal_turn(),
        item=item,
        target=target,
        repo_root=repo,
        device={"model": "qwen3-30b-a3b-mlx", "capabilities": {"tool_calling": True}},
    )
    assert receipt["version"] == 1
    assert receipt["result"] == "pass" and receipt["exit_code"] == 0
    assert receipt["assertion_id"] == "specialists-run-in-pod"
    assert receipt["source_commit"] == git("rev-parse", "HEAD")
    assert set(receipt["source_sha256"]) == {"probe.py", "runtime.py"}
    assert receipt["device"]["capabilities"] == {"tool_calling": True}
    # Shape, never content: the answer text is not in the receipt.
    assert "Confirm the proposed link." not in json.dumps(receipt)
    report = judge_mod.judge([_record(repo, git, item, receipt)])
    assert report.finished, [v.detail for v in report.verdicts]


def test_a_receipt_built_from_a_hub_door_turn_fails_the_judge(synthetic_repo):
    repo, git = synthetic_repo
    target = {"mode": "local", "environment": "synthetic"}
    item = _ledger_item(target)
    receipt = probe.build_receipt(_hub_door_turn(), item=item, target=target, repo_root=repo)
    assert receipt["result"] == "fail" and receipt["exit_code"] == 1
    assert any(f.startswith("hub_specialist_information_reads") for f in receipt["failures"])
    report = judge_mod.judge([_record(repo, git, item, receipt)])
    assert not report.finished
    assert [v.id for v in report.failing] == ["specialists-run-in-pod"]


def test_a_receipt_cannot_be_promoted_by_editing_result_after_the_fact(synthetic_repo):
    """Flipping `result` by hand leaves the observations behind; the judge reads
    the observations against the ledger and still says no."""
    repo, git = synthetic_repo
    target = {"mode": "local", "environment": "synthetic"}
    item = _ledger_item(target)
    receipt = probe.build_receipt(_hub_door_turn(), item=item, target=target, repo_root=repo)
    receipt["result"], receipt["exit_code"] = "pass", 0
    report = judge_mod.judge([_record(repo, git, item, receipt)])
    assert not report.finished


def test_the_receipt_cli_writes_a_receipt_from_a_captured_turn(tmp_path, monkeypatch, capsys):
    """`--receipt` with `--turn-json` builds the receipt offline; the shipped
    ledger demands a deployed target, so a local run reports fail-by-target
    only at the judge, while the producer's own verdict follows the observations."""
    import sys

    turn_path = tmp_path / "turn.json"
    turn_path.write_text(json.dumps(_location_proposal_turn()))
    out = tmp_path / "out" / "receipt.json"
    argv = sys.argv
    sys.argv = [
        "probe",
        "--receipt",
        str(out),
        "--turn-json",
        str(turn_path),
        "--target-mode",
        "local",
        "--target-environment",
        "synthetic",
    ]
    try:
        code = probe.main()
    finally:
        sys.argv = argv
    assert code == 0
    receipt = json.loads(out.read_text())
    assert receipt["observations"]["hub_specialist_information_reads"] == 0
    assert receipt["target"] == {"mode": "local", "environment": "synthetic"}
    assert receipt["reproduce"] == "consent-protocol/scripts/ops/pod_parity_probe.py"
    assert "receipt pass" in capsys.readouterr().out
