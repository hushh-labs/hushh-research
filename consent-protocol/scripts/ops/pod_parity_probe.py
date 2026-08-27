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
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

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

    client = session or requests
    from google.auth.transport.requests import Request  # noqa: PLC0415
    from google.oauth2 import service_account  # noqa: PLC0415

    from hushh_mcp.services.gcp_run_client import load_operator_credentials  # noqa: PLC0415

    # ID token audience-bound to the pod URL, from the operator key.
    creds = load_operator_credentials()
    info = getattr(creds, "_service_account_info", None) or {}
    id_creds = service_account.IDTokenCredentials.from_service_account_info(
        info, target_audience=pod_url
    )
    id_creds.refresh(Request())
    resp = client.post(
        f"{pod_url.rstrip('/')}/api/one/pod/turn",
        json={"message": prompt},
        headers={
            "Authorization": f"Bearer {id_creds.token}",
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
    ap.add_argument("--hub-frames", help="path to a JSON file of captured hub frames")
    args = ap.parse_args()

    if args.self_test:
        return _self_test()

    if not args.pod_url or not args.consent_token or not args.hub_frames:
        print("live probe needs --pod-url, --consent-token, and --hub-frames")
        print("(or run --self-test for the offline pipeline check)")
        return 2

    pod_turn = capture_pod_turn(
        pod_url=args.pod_url, prompt=args.prompt, consent_token=args.consent_token
    )
    hub_frames = json.loads(Path(args.hub_frames).read_text())
    diff = classify_pair(
        pod_turn=pod_turn, hub_frames=hub_frames, hub_grounded=bool(pod_turn.get("grounded"))
    )
    print(render_report(diff, prompt=args.prompt))
    return 0 if diff.at_parity else 1


if __name__ == "__main__":
    raise SystemExit(main())
