#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Retained production receipt reader; automatic release accounting is retired."""
import argparse
import os

from release_cadence import UnsafeRelease
from release_cadence_github import wait_production


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("reconcile", "wait-production"))
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--sha")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--recover-head", default="")
    parser.add_argument("--retire-failed-before", type=int, default=0)
    parser.add_argument("--reviewed-ledger-sha", default="")
    args = parser.parse_args()
    repository = os.environ["GITHUB_REPOSITORY"]
    if args.command == "wait-production":
        if not args.run_id or not args.sha:
            parser.error("wait-production requires --run-id and --sha")
        wait_production(repository, args.run_id, args.sha)
        print("Exact production deployment is healthy; live provenance must still pass before upload.")
    else:
        parser.error("release cadence is retired; use explicit environment deployment")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except UnsafeRelease as exc:
        raise SystemExit(str(exc)) from exc
