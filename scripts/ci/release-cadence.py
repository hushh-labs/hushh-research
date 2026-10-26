#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Canonical CLI for asynchronous UAT release cadence."""
import argparse
import json
import os
from pathlib import Path

from release_cadence import UnsafeRelease
from release_cadence_github import configuration, disabled_snapshot, reconcile, wait_production


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("reconcile", "wait-production"))
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--sha")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--recover-head", default="")
    parser.add_argument("--retire-failed-before", type=int, default=0)
    parser.add_argument("--reviewed-ledger-sha", default="")
    parser.add_argument("--retry-failed-native-run-id", type=int, default=0)
    args = parser.parse_args()
    repository = os.environ["GITHUB_REPOSITORY"]
    if args.command == "wait-production":
        if not args.run_id or not args.sha:
            parser.error("wait-production requires --run-id and --sha")
        wait_production(repository, args.run_id, args.sha)
        print("Exact production deployment is healthy; live provenance must still pass before upload.")
    else:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        snapshot_path = Path(os.environ["RUNNER_TEMP"], "release-cadence-monitor.json")
        if not configuration()[0]["enabled"]:
            if args.full or args.recover_head or args.retire_failed_before or args.reviewed_ledger_sha or args.retry_failed_native_run_id:
                parser.error("disabled cadence cannot reconcile or recover accounting")
            snapshot = disabled_snapshot(repository, int(os.environ["GITHUB_RUN_ID"]), event)
            snapshot_path.write_text(json.dumps(snapshot))
            print("Automatic release cadence is disabled; manual releases remain available.")
            return 0
        state = reconcile(repository, int(os.environ["GITHUB_RUN_ID"]), event,
                          args.full or event.get("schedule") == "7 3 * * 1", args.recover_head,
                          args.retire_failed_before, args.reviewed_ledger_sha, args.retry_failed_native_run_id)
        policy = configuration()[0]
        snapshot_path.write_text(json.dumps(state))
        lines = [(f"Verified UAT deployments: {state['count']}; TestFlight every {policy['testflight_every']}; "
                  f"production every {policy['production_every']}.")]
        for ordinal, request in state["requests"].items():
            for lane, child in request["lanes"].items():
                if child["state"] != "superseded":
                    lines.append(f"- Milestone {ordinal}, {lane}, {request['sha']}: {child['state']}" +
                                 (f" ([run](https://github.com/{repository}/actions/runs/{child['run_id']}))" if child.get("run_id") else ""))
        summary = "\n".join(lines) + "\n"
        print(summary)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
                handle.write(summary)
        failures = [child for request in state["requests"].values() for child in request["lanes"].values()
                    if child["state"] in {"failure", "cancelled", "timed_out", "action_required"}]
        if failures:
            raise UnsafeRelease("A release needs recovery; its recorded run must be inspected, never blindly redispatched")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except UnsafeRelease as exc:
        raise SystemExit(str(exc)) from exc
