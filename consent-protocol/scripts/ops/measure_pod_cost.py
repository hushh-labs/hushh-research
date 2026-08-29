#!/usr/bin/env python3
"""What does one person's private agent actually cost to run?

MEASURED, NOT ESTIMATED
The number this prints comes from Cloud Monitoring's
`run.googleapis.com/container/billable_instance_time` for a real pod service --
the same seconds Google bills -- multiplied by the published per-second rates for
the tier the pod is deployed at. Nothing here is a guess about how long a wake
"probably" takes.

WHAT IT DELIBERATELY DOES NOT INCLUDE
Model inference. A pod on `user_adc` calls Vertex as its owner's service account
on its owner's billing account, so its inference cost is not in this project's
metrics at all and this script would be lying if it folded in a number. The
report says so on its face rather than in a footnote, because a total with a
silent omission gets quoted as a total.

    uv run python scripts/ops/measure_pod_cost.py --project hushh-pda-dev \
        --service one-pod-abc123 --window 24h

Exit 0 with a measurement, 1 when the metric returned no points (which is not a
cost of zero: it means the pod did not run in the window, and saying "$0" there
is the same false green this ledger exists to prevent).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass

# Cloud Run request-based pricing, us-central1 (Tier 1), as published. These are
# the only hand-entered numbers in the file, so they are named and dated rather
# than inlined into an expression nobody can audit.
#   https://cloud.google.com/run/pricing  (checked 2026-08-28)
CPU_USD_PER_VCPU_SECOND = 0.000024
MEMORY_USD_PER_GIB_SECOND = 0.0000025

METRIC = "run.googleapis.com/container/billable_instance_time"


@dataclass
class Measurement:
    service: str
    project: str
    window: str
    billable_seconds: float
    points: int
    vcpu: float
    gib: float

    @property
    def usd_per_billable_second(self) -> float:
        return self.vcpu * CPU_USD_PER_VCPU_SECOND + self.gib * MEMORY_USD_PER_GIB_SECOND

    @property
    def usd(self) -> float:
        return self.billable_seconds * self.usd_per_billable_second


def _sh(args: list[str]) -> tuple[int, str]:
    p = subprocess.run(args, capture_output=True, text=True)  # noqa: S603
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _parse_quantity(raw: str, unit: str) -> float:
    """Cloud Run reports limits as strings: '1000m' vCPU, '1Gi' / '512Mi' memory."""
    raw = (raw or "").strip()
    if not raw:
        return 0.0
    if unit == "cpu":
        return float(raw[:-1]) / 1000.0 if raw.endswith("m") else float(raw)
    m = re.match(r"^([0-9.]+)([GM]i?)?$", raw)
    if not m:
        return 0.0
    value, suffix = float(m.group(1)), (m.group(2) or "")
    return value / 1024.0 if suffix.startswith("M") else value


def read_tier(project: str, region: str, service: str) -> tuple[float, float]:
    """The tier the pod is really deployed at, read off the service, not assumed."""
    code, out = _sh(
        [
            "gcloud",
            "run",
            "services",
            "describe",
            service,
            f"--project={project}",
            f"--region={region}",
            "--format=value(spec.template.spec.containers[0].resources.limits.cpu,"
            "spec.template.spec.containers[0].resources.limits.memory)",
        ]
    )
    if code != 0:
        raise RuntimeError(f"could not describe {service} in {project}: {out.strip()[:300]}")
    parts = out.split()
    cpu = _parse_quantity(parts[0] if parts else "", "cpu")
    mem = _parse_quantity(parts[1] if len(parts) > 1 else "", "mem")
    if cpu <= 0 or mem <= 0:
        raise RuntimeError(f"unreadable resource limits for {service}: {out.strip()[:200]!r}")
    return cpu, mem


def read_billable_seconds(project: str, service: str, window: str) -> tuple[float, int]:
    code, out = _sh(
        [
            "gcloud",
            "monitoring",
            "time-series",
            "list",
            f"--project={project}",
            f'--filter=metric.type="{METRIC}" AND resource.labels.service_name="{service}"',
            "--interval-end-time=now",
            f"--window={window}",
            "--format=json",
        ]
    )
    if code != 0:
        raise RuntimeError(f"monitoring query failed: {out.strip()[:400]}")
    try:
        series = json.loads(out or "[]")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"monitoring returned unparseable output: {exc}") from exc
    total, points = 0.0, 0
    for s in series:
        for pt in s.get("points") or []:
            value = pt.get("value") or {}
            raw = value.get("doubleValue", value.get("int64Value"))
            if raw is None:
                continue
            total += float(raw)
            points += 1
    return total, points


def render(m: Measurement) -> str:
    per_wake = m.usd / max(m.points, 1)
    return "\n".join(
        [
            "=" * 72,
            f"POD COST, MEASURED   {m.service}   ({m.project}, last {m.window})",
            "=" * 72,
            f"  tier read off the service        : {m.vcpu:g} vCPU / {m.gib:g} GiB",
            f"  rate at that tier                : ${m.usd_per_billable_second:.7f} "
            "per billable second",
            f"  billable instance seconds        : {m.billable_seconds:.1f}  "
            f"({m.points} sampled points)",
            f"  compute cost for the window      : ${m.usd:.5f}",
            f"  extrapolated, 100 wakes / month  : ${per_wake * 100:.4f}",
            "",
            "  NOT INCLUDED: model inference. A user_adc pod calls Vertex on its",
            "  owner's billing account, so those dollars are not in this project's",
            "  metrics and are not silently folded into the total above.",
            "=" * 72,
        ]
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--project", required=True)
    ap.add_argument("--region", default="us-central1")
    ap.add_argument("--service", required=True, help="the Cloud Run service backing one pod")
    ap.add_argument("--window", default="24h")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    try:
        vcpu, gib = read_tier(args.project, args.region, args.service)
        seconds, points = read_billable_seconds(args.project, args.service, args.window)
    except RuntimeError as exc:
        print(f"could not measure: {exc}")
        return 1

    if points == 0:
        # Not a cost of zero. The pod did not run in the window, and a zero here
        # would read as "free", which is the wrong lesson from an absent metric.
        print(
            f"no billable-instance-time points for {args.service} in the last {args.window}: "
            "the pod did not run. This is 'not measured', not '$0'."
        )
        return 1

    m = Measurement(
        service=args.service,
        project=args.project,
        window=args.window,
        billable_seconds=seconds,
        points=points,
        vcpu=vcpu,
        gib=gib,
    )
    print(json.dumps(m.__dict__ | {"usd": m.usd}, indent=2) if args.json else render(m))
    return 0


if __name__ == "__main__":
    sys.exit(main())
