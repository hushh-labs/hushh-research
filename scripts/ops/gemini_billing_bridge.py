#!/usr/bin/env python3
"""Switch managed Gemini billing between the Hussh org and the personal bridge.

WHY THIS EXISTS
---------------
The Hussh billing account (014D7F-FD970D-D2459E) is under a Lightning dunning
deny, which blocks every Vertex AI call across all of its projects — Gemini
included, and credits do not lift it. To keep development and production moving,
Gemini traffic was temporarily routed to ``hushh-gemini-bridge``, a project on a
personal billing account with its own budget.

That is a deliberate, reversible stopgap. This script is the reverse switch: one
command to put every service back on Hussh billing the day the dunning deny is
resolved, and one command to verify where things actually point.

WHAT IT TOUCHES
---------------
Only the *live* Cloud Run services, because that is what actually decides where
a request bills. Traffic on these services is pinned to named revisions, so a
new revision does NOT serve until traffic is migrated — the failure mode that
silently left search-console pointing at the blocked project while its service
spec claimed otherwise. This script always promotes the revision it creates.

The durable git configuration is deliberately NOT edited here; a script that
rewrites files in three repositories is harder to review than the four one-line
diffs listed by ``--print-git-changes``. Land those in the normal way, then run
this to move live traffic.

USAGE
-----
    python3 scripts/ops/gemini_billing_bridge.py --status
    python3 scripts/ops/gemini_billing_bridge.py --target hushh --dry-run
    python3 scripts/ops/gemini_billing_bridge.py --target hushh --apply
    python3 scripts/ops/gemini_billing_bridge.py --print-git-changes
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass

#: The temporary project on personal billing.
BRIDGE_PROJECT = "hushh-gemini-bridge"

#: Where each service billed before the bridge, and where it returns to.
HUSSH_PROJECT = "hushh-pda-uat"

REGION = "us-central1"


@dataclass(frozen=True)
class Service:
    """A Cloud Run service whose Gemini calls we can re-point."""

    name: str
    project: str
    #: The env var this service reads for its Gemini/Vertex project. Differs by
    #: codebase: search-console separates it from GOOGLE_CLOUD_PROJECT, while
    #: consent-protocol uses GOOGLE_CLOUD_PROJECT itself for the genai client.
    env_var: str
    label: str


SERVICES: tuple[Service, ...] = (
    Service(
        "hushh-search-console-api",
        "hushh-ai-uat",
        "GENAI_GOOGLE_CLOUD_PROJECT",
        "search-console UAT",
    ),
    Service(
        "hushh-search-console-api",
        "hushh-ai-prod",
        "GENAI_GOOGLE_CLOUD_PROJECT",
        "search-console PROD",
    ),
    Service(
        "hushh-adk-playground",
        "hushh-pda-uat",
        "GENAI_GOOGLE_CLOUD_PROJECT",
        "adk-playground UAT",
    ),
    Service(
        "consent-protocol",
        "hushh-pda-uat",
        "GOOGLE_CLOUD_PROJECT",
        "consent-protocol UAT",
    ),
)

GIT_CHANGES = """\
Durable configuration to revert (land these first, then run --target hushh --apply):

  hushh-search-console  scripts/gcp/deploy-env/uat.env
                        scripts/gcp/deploy-env/production.env
                          GENAI_GOOGLE_CLOUD_PROJECT=hushh-gemini-bridge
                          -> GENAI_GOOGLE_CLOUD_PROJECT=hushh-pda-uat

  hushh-research        .github/workflows/deploy-uat.yml
                          delete the line:
                          SUBSTITUTIONS="${SUBSTITUTIONS}##_GENAI_PROJECT_ID=hushh-gemini-bridge"
                          (genai_project_id then falls back to $PROJECT_ID)

  adk                   cloudbuild.yaml
                          _GENAI_VERTEX_PROJECT: hushh-gemini-bridge
                          -> _GENAI_VERTEX_PROJECT: ${_TARGET_PROJECT}

  local Hermes          ~/.hermes/.env
                          GOOGLE_CLOUD_PROJECT=hushh-gemini-bridge
                          -> GOOGLE_CLOUD_PROJECT=hushh-pda-uat
                          then: hermes gateway restart

Also revisit, because they live in the bridge project and do not move with a
project rename:
  * HUSHH_MANAGED_GEMINI_LIVE_API_KEY (Developer API key for
    gemini-3.1-flash-live-preview) is minted in hushh-gemini-bridge. Mint a
    replacement in a Hussh project and update the secret in each environment.
  * The $500 budget and its alerts are on the personal billing account.
"""


def run(cmd: list[str]) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def serving_revision(svc: Service) -> tuple[str | None, str | None]:
    """Return (revision serving 100%, the genai project it actually uses).

    Reads the revision rather than the service spec on purpose: traffic is
    pinned by name here, so the spec describes intent while the revision
    describes what is billing.
    """
    code, out = run(
        [
            "gcloud",
            "run",
            "services",
            "describe",
            svc.name,
            "--project",
            svc.project,
            "--region",
            REGION,
            "--format=json",
        ]
    )
    if code != 0:
        return None, None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return None, None

    revision = None
    for entry in data.get("status", {}).get("traffic", []):
        if entry.get("percent"):
            revision = entry.get("revisionName")
            break
    if not revision:
        return None, None

    code, rev_out = run(
        [
            "gcloud",
            "run",
            "revisions",
            "describe",
            revision,
            "--project",
            svc.project,
            "--region",
            REGION,
            "--format=value(spec.containers[0].env)",
        ]
    )
    match = (
        re.search(rf"'{svc.env_var}', 'value': '([^']*)'", rev_out)
        if code == 0
        else None
    )
    return revision, (match.group(1) if match else None)


def report_status() -> int:
    print(f"  {'SERVICE':<24} {'PROJECT':<15} {'SERVING REVISION':<42} BILLS TO")
    drifted = 0
    for svc in SERVICES:
        revision, target = serving_revision(svc)
        if revision is None:
            print(f"  {svc.label:<24} {svc.project:<15} {'<unreadable>':<42} ?")
            continue
        where = "PERSONAL (bridge)" if target == BRIDGE_PROJECT else f"hussh ({target})"
        if target == BRIDGE_PROJECT:
            drifted += 1
        print(f"  {svc.label:<24} {svc.project:<15} {revision:<42} {where}")
    print()
    print(f"  {drifted}/{len(SERVICES)} services currently bill to personal.")
    return 0


def switch(target_project: str, *, apply: bool) -> int:
    verb = "APPLY" if apply else "DRY-RUN"
    print(f"  [{verb}] target project: {target_project}\n")
    failures = 0

    for svc in SERVICES:
        revision, current = serving_revision(svc)
        if revision is None:
            print(f"  ! {svc.label}: cannot read service; skipping")
            failures += 1
            continue
        if current == target_project:
            print(f"  = {svc.label}: already on {target_project}")
            continue

        print(f"  -> {svc.label}: {current} -> {target_project}")
        if not apply:
            continue

        # Create a revision carrying the new target...
        code, out = run(
            [
                "gcloud",
                "run",
                "services",
                "update",
                svc.name,
                "--project",
                svc.project,
                "--region",
                REGION,
                f"--update-env-vars={svc.env_var}={target_project}",
                "--format=value(status.latestCreatedRevisionName)",
            ]
        )
        if code != 0:
            print(f"     FAILED to update: {out.strip()[:160]}")
            failures += 1
            continue

        # ...then promote it. Traffic is pinned by name on these services, so
        # without this the new revision is created and never serves.
        code, out = run(
            [
                "gcloud",
                "run",
                "services",
                "describe",
                svc.name,
                "--project",
                svc.project,
                "--region",
                REGION,
                "--format=value(status.latestCreatedRevisionName)",
            ]
        )
        newest = out.strip().splitlines()[0] if code == 0 and out.strip() else ""
        if not newest:
            print("     FAILED to resolve the new revision")
            failures += 1
            continue

        code, out = run(
            [
                "gcloud",
                "run",
                "services",
                "update-traffic",
                svc.name,
                "--project",
                svc.project,
                "--region",
                REGION,
                f"--to-revisions={newest}=100",
            ]
        )
        if code != 0:
            print(f"     FAILED to promote {newest}: {out.strip()[:160]}")
            failures += 1
            continue

        _, verified = serving_revision(svc)
        ok = "ok" if verified == target_project else f"MISMATCH ({verified})"
        print(f"     promoted {newest} -> {ok}")
        if verified != target_project:
            failures += 1

    print()
    if failures:
        print(f"  {failures} failure(s). Re-run --status to inspect.")
        return 1
    print("  done." if apply else "  dry run only; re-run with --apply.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--status", action="store_true", help="show where each service bills today"
    )
    parser.add_argument(
        "--target", choices=("hushh", "personal"), help="billing destination"
    )
    parser.add_argument(
        "--apply", action="store_true", help="perform the switch (default is dry run)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="explicitly preview the switch; this is already the default without --apply",
    )
    parser.add_argument(
        "--print-git-changes",
        action="store_true",
        help="show the durable config to revert",
    )
    args = parser.parse_args()

    if args.print_git_changes:
        print(GIT_CHANGES)
        return 0
    if args.status or not args.target:
        return report_status()

    if args.dry_run and args.apply:
        parser.error("--dry-run and --apply are mutually exclusive")

    target = HUSSH_PROJECT if args.target == "hushh" else BRIDGE_PROJECT
    if args.target == "hushh":
        print("  NOTE: this only succeeds once the Lightning dunning deny is lifted;")
        print(
            "  otherwise every Gemini call returns 403 on the Hussh billing account.\n"
        )
    return switch(target, apply=args.apply)


if __name__ == "__main__":
    sys.exit(main())
