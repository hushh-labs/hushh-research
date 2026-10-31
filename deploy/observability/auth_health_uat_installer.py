#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Install the owned UAT health job and separately activate its timer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from auth_health_uat_common import (
    record_intent,
)
from auth_health_uat_job_install import install_job
from auth_health_uat_timer_activation import activate_timer


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--record-intent", action="store_true")
    group.add_argument("--install-job", action="store_true")
    group.add_argument("--activate-timer", action="store_true")
    parser.add_argument("--health-action", choices=["install-job", "activate-timer"])
    parser.add_argument("--operation", required=True)
    parser.add_argument("--checker-unique-id", required=True)
    parser.add_argument("--clock-unique-id", required=True)
    parser.add_argument("--build-id", required=True)
    parser.add_argument("--execution-name")
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if args.record_intent:
        if not args.health_action:
            parser.error("--record-intent requires --health-action")
        result = record_intent(
            args.health_action,
            args.operation,
            args.checker_unique_id,
            args.clock_unique_id,
            args.build_id,
            args.execution_name,
            args.receipt,
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    if args.health_action:
        parser.error("--health-action is only valid with --record-intent")
    if args.install_job and args.execution_name is not None:
        parser.error("--execution-name is only valid for timer activation")
    if args.activate_timer and not args.execution_name:
        parser.error("Timer activation requires a full healthy execution resource name")
    result = (
        install_job(
            args.operation,
            args.checker_unique_id,
            args.clock_unique_id,
            args.build_id,
            args.receipt,
        )
        if args.install_job
        else activate_timer(
            args.operation,
            args.checker_unique_id,
            args.clock_unique_id,
            args.build_id,
            args.execution_name,
            args.receipt,
        )
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
