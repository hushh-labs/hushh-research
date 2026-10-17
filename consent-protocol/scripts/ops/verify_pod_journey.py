#!/usr/bin/env python3
"""Is the hub that is SERVING actually able to give someone a private agent?

Read-only. Answers one question against the live artifact, and answers it from the
revision holding traffic rather than from anything that merely intends to.

    uv run python scripts/ops/verify_pod_journey.py --sha <deployed-sha>

WHY THIS EXISTS RATHER THAN A TEST
----------------------------------
Every gap it checks passed its unit tests. What they failed was existing in a
running system:

* the personal-agent flags lived only in ``runtime_settings`` -- ``grep -r
  PERSONAL_AGENT deploy/`` returned nothing, so ``HUSSH_GCP_BACKEND_LIVE`` was
  unset and ``GcpBackend`` stayed in plan mode: it rendered a config, never called
  Cloud Run, and read as success at every layer above it;
* provisioning is a 150s task that outlives its response, on an instance whose CPU
  Cloud Run throttles to near zero between requests;
* ``/health`` advertised a hardcoded agent roster that a live-validation document
  then quoted as proof of life.

TWO TRAPS THIS SCRIPT EXISTS TO NOT FALL INTO
---------------------------------------------
1. **Desired state is not fact.** ``deploy-sha`` is a SERVICE label and flips the
   moment a deploy writes the spec -- before the new revision is Ready, and while
   100% of traffic may still be on the old one. An earlier version of this check
   read ``spec.template`` and reported success against a revision serving nothing.
   So: read ``status.traffic``, then read THAT revision.

2. **A git SHA is not an image digest.** Cloud Run resolves the tag to a digest on
   the revision, so comparing a SHA against ``container.image`` can never match.
   The revision carries its own ``deploy-sha`` LABEL; that is the provenance marker.

And the independent tripwire: ``/health``'s roster is derived, and the derivation
drops ``kyc``. If ``kyc`` comes back, old code is answering -- whatever any label,
annotation, or workflow conclusion says. A check that cannot be satisfied by
metadata alone is worth more than three that can.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1].parent))

from hushh_mcp.services.gcp_run_client import load_operator_credentials  # noqa: E402

# The block whose total absence made the whole journey unreachable. Each is
# separately revocable; any one missing breaks a different step.
REQUIRED_ENV = (
    ("PERSONAL_AGENT_ENABLED", "the surface itself; without it every route 404s"),
    ("PERSONAL_AGENT_BACKEND", "which compute backend provisions the pod"),
    ("PERSONAL_AGENT_AUTOPROVISION_ENABLED", "may the hub create billable compute"),
    ("HUSSH_GCP_BACKEND_LIVE", "call Cloud Run, or merely render a config"),
    ("HUSSH_POD_SIGNING_KEY_SECRET", "a pod cannot boot without APP_SIGNING_KEY"),
    ("HUSSH_POD_INVOKER_MEMBER", "unset means the pod is invokable by nobody"),
    ("HUSSH_POD_TURN_ENABLED", "whether a pod may run a turn at all"),
    # Durable state. Checked on the HUB because that is where they live: the hub
    # reads both at construction and `_durable_state_env` emits a pod's storage
    # block only when BOTH are present -- so a hub missing either renders
    # EPHEMERAL pods while every other check on this page still passes. That
    # silence is the whole reason they are listed. The failure mode is a pod that
    # works perfectly until it stops, which on the economy tier (min-instances 0)
    # is not an incident but the design.
    ("POD_STORAGE_GCS_BUCKET", "where a pod's sealed commit log persists"),
    ("HUSSH_POD_KEY_MASTER", "derives each pod's own sealing keys; a secret, never a literal"),
)


def _fetch(url: str, headers: dict) -> dict:
    """Same HTTP client the rest of scripts/ops uses (see pod_fleet.py)."""
    response = requests.get(url, headers=headers, timeout=60)
    response.raise_for_status()
    return dict(response.json())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", default="hushh-pda-dev")
    ap.add_argument("--region", default="us-central1")
    ap.add_argument("--service", default="consent-protocol")
    ap.add_argument("--sha", default="", help="expected deploy SHA; blank skips the check")
    args = ap.parse_args()

    creds = load_operator_credentials()
    import google.auth.transport.requests as greq

    creds.refresh(greq.Request())
    headers = {"Authorization": f"Bearer {creds.token}", "Accept": "application/json"}
    base = (
        f"https://{args.region}-run.googleapis.com/apis/serving.knative.dev/v1"
        f"/namespaces/{args.project}"
    )

    svc = _fetch(f"{base}/services/{args.service}", headers)
    status = svc["status"]
    serving = [t for t in status.get("traffic", []) if (t.get("percent") or 0) > 0]

    print(f"service        : {args.service} ({args.project}/{args.region})")
    print(f"latestCreated  : {status.get('latestCreatedRevisionName')}")
    print(f"latestReady    : {status.get('latestReadyRevisionName')}")
    for t in status.get("traffic", []):
        print(f"traffic        : {t.get('revisionName')} -> {t.get('percent')}%")
    if not serving:
        print("\nNOTHING IS SERVING. Everything below would be about a plan.")
        return 1

    name = serving[0]["revisionName"]
    rev = _fetch(f"{base}/revisions/{name}", headers)
    container = rev["spec"]["containers"][0]
    env = {e["name"] for e in container.get("env", [])}
    labels = rev["metadata"].get("labels") or {}
    annotations = rev["metadata"].get("annotations") or {}

    failures: list[str] = []

    print(f"\n-- serving revision: {name}")
    if args.sha:
        actual = labels.get("deploy-sha", "")
        ok = actual == args.sha
        print(f"   deploy-sha   : {actual or '<none>'} {'== expected' if ok else '!= ' + args.sha}")
        if not ok:
            failures.append("the serving revision is not the SHA under test")

    print("\n-- the personal-agent env block")
    for key, why in REQUIRED_ENV:
        present = key in env
        print(f"   {'OK  ' if present else 'MISS'} {key:38s} {why}")
        if not present:
            failures.append(f"{key} is unset on the serving revision")

    print("\n-- can work outlive the request that started it")
    throttling = annotations.get("run.googleapis.com/cpu-throttling", "")
    print(f"   cpu-throttling: {throttling or '<unset = THROTTLED>'}")
    if throttling != "false":
        failures.append("CPU is throttled between requests; a 150s provision will strand")

    print("\n-- what the running process says about itself")
    url = status["url"]
    try:
        response = requests.get(f"{url}/health", timeout=45)
        print(f"   GET /health       -> {response.status_code}")
        roster = response.json().get("agents")
        print(f"   agents            : {roster}")
        # The tripwire. Nothing but the running code can produce this.
        if "kyc" in (roster or []):
            failures.append("/health reports the retired hardcoded roster: OLD code is serving")
    except Exception as exc:  # noqa: BLE001
        print(f"   GET /health       -> {type(exc).__name__}")
        failures.append("/health did not answer")

    try:
        ready = requests.get(f"{url}/health/ready", timeout=45)
        print(f"   GET /health/ready -> {ready.status_code} {ready.text[:200]}")
    except Exception as exc:  # noqa: BLE001
        # Readiness is a dependency check; a pod holds no DB credential and answers
        # 503 here by design, so this is reported and never fatal.
        print(f"   GET /health/ready -> {type(exc).__name__} (not fatal)")

    print("\n" + "-" * 70)
    if failures:
        print("NOT READY to give anyone a private agent:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("The SERVING hub can create a pod and let it run a turn.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
