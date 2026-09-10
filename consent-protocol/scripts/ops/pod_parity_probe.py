"""Live parity probe: does a real pod answer a prompt the way the hub does?

The parity oracle (``hushh_mcp/observability/parity_oracle``) is sharp -- it
reduces a hub turn and a pod turn to one canonical shape and classifies every
divergence -- but it has only ever been fed four frozen JSON fixtures. Nothing
posts the SAME prompt to a REAL pod and a REAL hub and runs the delivered
contracts through it. That gap is why Capability can only be argued in-process:
the ruler is never held against a live pod.

This is the missing feeder. It captures a live pod turn and a live hub turn for
one prompt+owner and classifies them with the existing oracle, in STRUCTURAL
mode -- because a live LLM's exact wording varies, and EXACT mode (right for the
scripted CI corpus) would thrash on paraphrase and teach the team to ignore the
score. STRUCTURAL compares the PRESENCE of a directive kind or a specialist
class, never the free text.

WHAT IS PROVABLE OFFLINE VS LIVE
--------------------------------
``--self-test`` runs the whole classify+report pipeline on synthetic live-shaped
turns and asserts the pipeline is sound -- no pod, no session, runnable in CI.
The live capture needs operator credentials to reach the pod and a session to
authorise the hub turn, so it is the operator/scheduled half. The oracle it feeds
is the same code the fixture tests pin, so a green self-test plus a green oracle
suite means the only unproven thing in a live run is the network, not the logic.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_LEDGER = REPO_ROOT / "config" / "pod-completion-ledger.yaml"
LEDGER_ITEM_ID = "specialists-run-in-pod"

from hushh_mcp.observability.parity_oracle import (  # noqa: E402
    EquivalenceMode,
    ParityDiff,
    classify,
    observe_hub,
    observe_pod,
)


def classify_pair(
    *,
    pod_turn: dict[str, Any],
    hub_frames: list[dict[str, Any]],
    hub_grounded: bool,
    mode: EquivalenceMode = EquivalenceMode.STRUCTURAL,
) -> ParityDiff:
    """The core: reduce both delivered contracts and classify. Pure, testable.

    ``pod_turn`` is the dict ``run_pod_turn`` returns; ``hub_frames`` are the SSE
    frames the hub emitted for the same prompt. The reducers are the shipped
    oracle's, so this cannot drift from what the fixture tests pin.
    """
    pod_obs = observe_pod(pod_turn)
    hub_obs = observe_hub(
        hub_frames,
        grounded=hub_grounded,
        runtime_mode="hub",
    )
    return classify(pod_obs, hub_obs, mode)


def render_report(diff: ParityDiff, *, prompt: str) -> str:
    lines = [
        "=" * 64,
        f"LIVE PARITY  ::  {prompt[:48]}",
        "=" * 64,
        f"  at parity:   {diff.at_parity}",
    ]
    if diff.failures:
        lines.append(f"  failures:    {[f.value for f in diff.failures]}")
        lines.append(f"  owners:      {list(diff.owners)}")
    if diff.regressions:
        lines.append(f"  regressions: {list(diff.regressions)}")
    if diff.detail:
        lines.append(f"  detail:      {list(diff.detail)}")
    lines.append("=" * 64)
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Ledger observations, DERIVED from the delivered turn. Never asserted by hand.
# --------------------------------------------------------------------------- #


def derive_ledger_observations(turn: dict[str, Any]) -> dict[str, Any]:
    """The four ``specialists-run-in-pod`` observations, read off one pod turn.

    ``run_pod_turn`` now carries a per-specialist dependency report (``execution``,
    ``informationSource``, ``hubReads``, ``reason``) and a turn-level
    ``dependencies`` roll-up. This reads exactly those fields:

    * ``specialist_execution_attributed_to_pod``: at least one specialist ran and
      every one reports ``execution == "pod"``. An outcome that predates the
      trace (empty execution) is NOT attributed; unknown is never counted as pod.
    * ``consented_success``: the turn delivered text, was not degraded, and every
      specialist outcome is ``ok``.
    * ``native_specialist_executions``: specialists that ran in the pod and
      completed ``ok``.
    * ``hub_specialist_information_reads``: the sum of ``hubReads``; a specialist
      whose facts came through a hub door counts at least one even when the
      count is missing, so a door read can never be hidden by an absent number.
    """
    raw = turn.get("specialists")
    specialists = [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
    attributed = bool(specialists)
    consented = bool(str(turn.get("text") or "").strip()) and not turn.get("degraded")
    native = 0
    hub_reads = 0
    for item in specialists:
        execution = str(item.get("execution") or "")
        status = str(item.get("status") or "")
        source = str(item.get("informationSource") or item.get("information_source") or "")
        reads = item.get("hubReads", item.get("hub_reads", 0))
        reads = reads if isinstance(reads, int) and not isinstance(reads, bool) and reads > 0 else 0
        if source == "hub_door" and reads == 0:
            reads = 1
        hub_reads += reads
        if execution != "pod":
            attributed = False
        if execution == "pod" and status == "ok":
            native += 1
        if status != "ok":
            consented = False
    dependencies = turn.get("dependencies")
    if isinstance(dependencies, dict) and isinstance(dependencies.get("hub"), list):
        hub_reads = max(hub_reads, len(dependencies["hub"]))
    return {
        "specialist_execution_attributed_to_pod": attributed,
        "consented_success": consented,
        "native_specialist_executions": native,
        "hub_specialist_information_reads": hub_reads,
    }


def observation_failures(observations: dict[str, Any], requirements: dict[str, Any]) -> list[str]:
    """Which ledger requirements the observations do not satisfy. Same operator
    semantics as the judge (``equals`` is type-strict; ``minimum``/``maximum`` are
    numeric), so the producer cannot call a receipt a pass the judge will fail."""
    failures: list[str] = []
    for key, rule in requirements.items():
        if key not in observations:
            failures.append(f"{key}: missing")
            continue
        if not isinstance(rule, dict) or len(rule) != 1:
            failures.append(f"{key}: invalid requirement")
            continue
        operator, expected = next(iter(rule.items()))
        value = observations[key]
        if operator == "equals":
            ok = type(value) is type(expected) and value == expected
        elif operator in {"minimum", "maximum"}:
            numeric = type(value) in {int, float} and type(expected) in {int, float}
            ok = numeric and (value >= expected if operator == "minimum" else value <= expected)
        else:
            ok = False
        if not ok:
            failures.append(f"{key}: {value!r} does not satisfy {operator} {expected!r}")
    return failures


def load_ledger_item(path: Path, item_id: str = LEDGER_ITEM_ID) -> dict[str, Any]:
    import yaml  # noqa: PLC0415

    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    for item in data.get("assertions") or []:
        if isinstance(item, dict) and item.get("id") == item_id:
            return item
    raise ValueError(f"ledger item {item_id!r} not found in {path}")


def build_receipt(
    turn: dict[str, Any],
    *,
    item: dict[str, Any],
    target: dict[str, Any],
    repo_root: Path,
    device: dict[str, Any] | None = None,
    completed_at: datetime | None = None,
) -> dict[str, Any]:
    """A v1 receipt in the shape ``pod_completion_judge._validate_receipt_artifact``
    checks: version, assertion id, result and exit code, completion time, source
    commit, target, per-source digests and the derived observations.

    ``result`` is derived from the observations against the item's own
    requirements; the producer never writes ``pass`` because a run finished.
    Shape only: no prompt, no answer text, no tokens, no owner information.
    """
    check = item.get("check") or {}
    observations = derive_ledger_observations(turn)
    failures = observation_failures(observations, check.get("observation_requirements") or {})
    source_paths = list(check.get("source_paths") or [])
    digests = {
        relative: hashlib.sha256((repo_root / relative).read_bytes()).hexdigest()
        for relative in source_paths
    }
    revision = subprocess.run(  # noqa: S603 - fixed argv, repository-owned working directory
        ["git", "rev-parse", "HEAD"],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    ).stdout.strip()
    when = completed_at or datetime.now(timezone.utc)
    receipt: dict[str, Any] = {
        "version": 1,
        "assertion_id": str(item.get("id") or LEDGER_ITEM_ID),
        "result": "pass" if not failures else "fail",
        "exit_code": 0 if not failures else 1,
        "completed_at": when.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_commit": revision,
        "target": dict(target),
        "source_sha256": digests,
        "observations": observations,
        "reproduce": str(check.get("reproduce") or ""),
        "turn": {
            "runtime_mode": str(turn.get("runtimeMode") or ""),
            "model": str(turn.get("model") or ""),
            "model_reported": bool(turn.get("modelReported")),
            "grounded": bool(turn.get("grounded")),
            "degraded": str(turn.get("degraded") or ""),
            "specialists": [
                {
                    "agent_id": str(item_.get("agentId") or item_.get("agent_id") or ""),
                    "status": str(item_.get("status") or ""),
                    "execution": str(item_.get("execution") or ""),
                    "information_source": str(item_.get("informationSource") or ""),
                    "hub_reads": item_.get("hubReads", 0),
                    "reason": str(item_.get("reason") or ""),
                }
                for item_ in (turn.get("specialists") or [])
                if isinstance(item_, dict)
            ],
            "dependencies": turn.get("dependencies")
            if isinstance(turn.get("dependencies"), dict)
            else {"hub": [], "unavailable": []},
        },
        "limits": [
            "observations are derived from one delivered pod turn, not from pod logs",
            "a hub information read is counted from the turn's dependency report",
            "no prompt, answer text, token or owner record is recorded",
        ],
    }
    if failures:
        receipt["failures"] = failures
    if device:
        # Puppy One harness vocabulary, as the hub reported it for the device.
        receipt["device"] = {
            "model": str(device.get("model") or ""),
            "capabilities": {
                name: bool(flag)
                for name, flag in (device.get("capabilities") or {}).items()
                if isinstance(flag, bool)
            },
            "probe_mode": str(device.get("probe_mode") or ""),
        }
    return receipt


def _target_from_args(args: argparse.Namespace) -> dict[str, Any]:
    target: dict[str, Any] = {
        "mode": str(args.target_mode or ""),
        "environment": str(args.target_environment or ""),
    }
    if target["mode"] == "deployed":
        target["project"] = str(args.target_project or "")
        target["region"] = str(args.target_region or "")
        target["image_digest"] = str(args.image_digest or "")
    return target


# --------------------------------------------------------------------------- #
# Live capture. Needs operator creds (pod) and a session (hub). Operator half.
# --------------------------------------------------------------------------- #


def capture_pod_turn(
    *, pod_url: str, prompt: str, consent_token: str, session: Any = None
) -> dict[str, Any]:
    """Post one turn to a real pod and return its delivered dict.

    The pod is internal-invoker only, so the caller runs as an identity the pod's
    invoker binding admits (operator or hub). ``consent_token`` is the pkm.read
    grant the relay normally mints; a probe mints it out of band.
    """
    import requests  # noqa: PLC0415

    from hushh_mcp.services.operator_identity import mint_operator_id_token  # noqa: PLC0415

    client = session or requests
    token = mint_operator_id_token(pod_url)
    resp = client.post(
        f"{pod_url.rstrip('/')}/api/one/pod/turn",
        json={"message": prompt},
        headers={
            "Authorization": f"Bearer {token}",
            "X-Consent-Token": consent_token,
            "Content-Type": "application/json",
        },
        timeout=90,
    )
    return dict(resp.json() or {})


# --------------------------------------------------------------------------- #
# Self-test: the whole pipeline on synthetic live-shaped turns. Offline.
# --------------------------------------------------------------------------- #


def _self_test() -> int:
    # A pod turn and a hub turn that carry the SAME action directive, in the exact
    # shapes run_pod_turn and the hub SSE path produce. STRUCTURAL mode should
    # call them at parity despite any wording difference.
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
        {"event": "token", "data": {"text": "Let me analyze NVIDIA for you."}},
        {"event": "tool_start", "data": {"action_id": "analysis.start", "execution": "frontend"}},
    ]
    diff = classify_pair(pod_turn=pod_turn, hub_frames=hub_frames, hub_grounded=True)
    print(render_report(diff, prompt="[self-test] analyze NVIDIA"))
    if not diff.at_parity:
        print("SELF-TEST FAILED: a matched live-shaped pair did not classify at parity")
        return 1

    # And the negative half: a pod that dropped the directive must NOT be parity.
    dropped = {"text": "ok", "grounded": True, "directiveCount": 1}
    bad = classify_pair(pod_turn=dropped, hub_frames=hub_frames, hub_grounded=True)
    if bad.at_parity:
        print("SELF-TEST FAILED: a directive-drop pod wrongly classified at parity")
        return 1

    print("\nSELF-TEST PASSED: the live classify pipeline is sound.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--self-test", action="store_true", help="run the offline pipeline check")
    ap.add_argument("--pod-url", help="live pod URL to probe")
    ap.add_argument("--prompt", default="Analyze NVIDIA")
    ap.add_argument("--consent-token", help="pkm.read grant for the pod turn")
    ap.add_argument(
        "--hub-frames",
        help="path to the captured hub turn: either a JSON array of frames, or an "
        'object {"frames": [...], "grounded": bool}',
    )
    ap.add_argument(
        "--hub-grounded",
        choices=("true", "false"),
        help="whether the HUB's answer was grounded, when the frames file does not say",
    )
    ap.add_argument(
        "--receipt",
        help="write a v1 ledger receipt for specialists-run-in-pod to this path, "
        "derived from the delivered pod turn",
    )
    ap.add_argument(
        "--turn-json",
        help="an already captured pod turn (the run_pod_turn dict) to build the "
        "receipt from instead of dialling the pod",
    )
    ap.add_argument("--device-status", help="captured GET /api/one/puppy/status/{id} JSON")
    ap.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    ap.add_argument("--target-mode", choices=("local", "deployed"), default="deployed")
    ap.add_argument("--target-environment", default="dev")
    ap.add_argument("--target-project")
    ap.add_argument("--target-region")
    ap.add_argument("--image-digest")
    args = ap.parse_args()

    if args.self_test:
        return _self_test()

    if args.receipt and args.turn_json:
        turn = json.loads(Path(args.turn_json).read_text())
        device = json.loads(Path(args.device_status).read_text()) if args.device_status else None
        return _write_receipt(args, turn, device.get("relay") if device else None)

    if not args.pod_url or not args.consent_token or not args.hub_frames:
        print("live probe needs --pod-url, --consent-token, and --hub-frames")
        print("(or run --self-test for the offline pipeline check, or --receipt with --turn-json)")
        return 2

    captured = json.loads(Path(args.hub_frames).read_text())
    # The hub's grounding has to come from the HUB. Deriving it from the pod's own
    # answer -- which this did -- makes the two sides agree by construction, so the
    # grounding comparison could never fail and the score silently overstated what
    # had been checked. An oracle that cannot fail proves nothing, so an unstated
    # hub grounding is a refusal rather than a guess.
    if isinstance(captured, dict):
        hub_frames = list(captured.get("frames") or [])
        hub_grounded = captured.get("grounded")
    else:
        hub_frames = list(captured)
        hub_grounded = None
    if args.hub_grounded is not None:
        hub_grounded = args.hub_grounded == "true"
    if hub_grounded is None:
        print("the hub's grounding is unknown: pass --hub-grounded, or record")
        print('"grounded" in the frames file. It must never be read off the pod.')
        return 2

    pod_turn = capture_pod_turn(
        pod_url=args.pod_url, prompt=args.prompt, consent_token=args.consent_token
    )
    diff = classify_pair(pod_turn=pod_turn, hub_frames=hub_frames, hub_grounded=bool(hub_grounded))
    print(render_report(diff, prompt=args.prompt))
    if args.receipt:
        device = json.loads(Path(args.device_status).read_text()) if args.device_status else None
        receipt_code = _write_receipt(args, pod_turn, device.get("relay") if device else None)
        return receipt_code if receipt_code else (0 if diff.at_parity else 1)
    return 0 if diff.at_parity else 1


def _write_receipt(args: argparse.Namespace, turn: dict[str, Any], device: Any) -> int:
    item = load_ledger_item(Path(args.ledger))
    receipt = build_receipt(
        turn,
        item=item,
        target=_target_from_args(args),
        repo_root=REPO_ROOT,
        device=device if isinstance(device, dict) else None,
    )
    out = Path(args.receipt)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"receipt {receipt['result']}: {out}")
    for failure in receipt.get("failures") or []:
        print(f"  {failure}")
    return 0 if receipt["result"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
