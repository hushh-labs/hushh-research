#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = REPO_ROOT / "config" / "ci-governance.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="Assert that a GitHub actor is allowed to dispatch a governed workflow.")
    parser.add_argument("--surface", choices=("uat", "production"), required=True)
    parser.add_argument("--actor", required=True)
    args = parser.parse_args()

    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    allowed = policy.get(args.surface, {}).get("manual_dispatch_users", [])
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
