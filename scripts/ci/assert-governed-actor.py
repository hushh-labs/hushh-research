#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = REPO_ROOT / "config" / "ci-governance.json"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Assert that a GitHub actor is allowed to dispatch a governed workflow."
    )
    parser.add_argument("--surface", choices=("dev", "uat", "production"), required=True)
    parser.add_argument("--actor", required=True)
    args = parser.parse_args()

    event_path = os.environ.get("GITHUB_EVENT_PATH")
    event = json.loads(Path(event_path).read_text()) if event_path else {}
    inputs = event.get("inputs") or {}
    if inputs.get("cadence_origin") or inputs.get("cadence_ordinal"):
        raise SystemExit("Automatic release cadence is retired; use an explicit manual release.")
    if "RELEASE_AUTHORIZATION" in os.environ:
        from deployment_security import Refused, verify_forwarded_authorization

        try:
            verify_forwarded_authorization(
                dict(os.environ), os.environ["RELEASE_AUTHORIZATION"], args.surface, args.actor
            )
        except (Refused, KeyError, TypeError, ValueError) as error:
            reason = str(error) if isinstance(error, Refused) else "authorization unavailable"
            raise SystemExit(f"Release authorization refused: {reason}") from None
        print(f"{args.surface} current-attempt live-team authorization passed.")
        return 0

    # Unmigrated operational/inspection callers retain their existing admission;
    # their presence is not proof that every hosted consumer uses live teams.
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    allowed = policy.get(args.surface, {}).get("manual_dispatch_users", [])
    if os.environ.get("GITHUB_RUN_ATTEMPT", "1") != "1" and os.environ.get("GITHUB_TRIGGERING_ACTOR") not in allowed:
        raise SystemExit("Rerunning a governed release requires an authorized triggering actor.")
    if args.actor not in allowed:
        joined = ", ".join(allowed) if allowed else "<none>"
        raise SystemExit(
            f"Refusing {args.surface} workflow dispatch for '{args.actor}'. "
            f"Allowed actors: {joined}"
        )

    print(f"{args.surface} manual dispatch policy passed for actor '{args.actor}'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
