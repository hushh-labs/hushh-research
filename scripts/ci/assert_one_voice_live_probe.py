#!/usr/bin/env python3
"""Require an exact successful One Voice Live connect from a Cloud Run probe log."""

from __future__ import annotations

import argparse
import json
import sys

RESULT_PREFIX = "managed_vertex_probe_result"


def live_probe_passed(line: str, *, model: str, location: str) -> bool:
    if RESULT_PREFIX not in line or not model or not location:
        return False
    try:
        report = json.loads(line.split(RESULT_PREFIX, 1)[1].strip())
    except json.JSONDecodeError:
        return False
    if not isinstance(report, dict) or not isinstance(report.get("probes"), list):
        return False
    expected = f"one_voice_live:{model}@{location}"
    matches = [
        probe
        for probe in report["probes"]
        if isinstance(probe, dict) and probe.get("probe") == expected
    ]
    return (
        len(matches) == 1
        and matches[0].get("ok") is True
        and matches[0].get("classification") == "dependency_ok"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--location", required=True)
    args = parser.parse_args()
    if live_probe_passed(sys.stdin.read(), model=args.model, location=args.location):
        print("Production One Voice Live connect probe passed.")
        return 0
    print("Production One Voice Live connect probe did not pass.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
