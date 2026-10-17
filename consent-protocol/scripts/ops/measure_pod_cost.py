#!/usr/bin/env python3
"""What does one person's private agent actually cost to run?

MEASURED, NOT ESTIMATED
The number this prints comes from Cloud Monitoring's
`run.googleapis.com/container/billable_instance_time` for a real pod service --
the same seconds Google bills -- multiplied by the published per-second rates for
the tier the pod is deployed at. Nothing here is a guess about how long a wake
"probably" takes.

COLD STARTS ARE BILLED AT THE BOOSTED CPU, SO THEY ARE PRICED THAT WAY
Every pod is rendered with `run.googleapis.com/startup-cpu-boost: "true"`. Google
raises a CPU limit of up to 1 vCPU to 2 vCPU "during instance startup time and
for 10 seconds after", and "You are charged for the allocated boosted CPU"
(https://docs.cloud.google.com/run/docs/configuring/services/cpu, checked
2026-10-06). Pricing billable seconds at the unboosted rate alone made a 76 s
cold start on a 0.5 vCPU pod read as 38 vCPU-s when it bills as 2 x (76 + 10) =
172. How many starts there were, and how long they took, comes from the same
API: `run.googleapis.com/container/startup_latencies`, a per-minute distribution
of start times. Its latency matches the log span from "Starting new instance" to
the startup probe succeeding (log 87.2 s, metric 87.0 s; log 89.8 s, metric
89.4 s; hushh-byoc-test, 2026-09-30).

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
import datetime as _dt
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Any

# Cloud Run request-based pricing, us-central1 (Tier 1), as published. These are
# the only hand-entered numbers in the file, so they are named and dated rather
# than inlined into an expression nobody can audit.
#   https://cloud.google.com/run/pricing  (checked 2026-08-28)
CPU_USD_PER_VCPU_SECOND = 0.000024
MEMORY_USD_PER_GIB_SECOND = 0.0000025

METRIC = "run.googleapis.com/container/billable_instance_time"
STARTUP_METRIC = "run.googleapis.com/container/startup_latencies"
STARTUP_BOOST_ANNOTATION = "run.googleapis.com/startup-cpu-boost"

# Startup CPU boost, as published: a limit of up to 1 vCPU is raised to 2 vCPU for
# the startup time plus 10 seconds. Larger limits boost differently and the pod
# never runs at one, so those are reported as unpriced rather than guessed.
BOOSTED_VCPU_FOR_LIMIT_UP_TO_1 = 2.0
BOOST_TAIL_SECONDS = 10.0


@dataclass
class Measurement:
    service: str
    project: str
    window: str
    billable_seconds: float
    points: int
    vcpu: float
    gib: float
    cold_starts: int = 0
    startup_seconds: float = 0.0
    startup_boost: bool = False

    @property
    def usd_per_billable_second(self) -> float:
        """The unboosted rate: what one billable second costs outside a cold start."""
        return self.vcpu * CPU_USD_PER_VCPU_SECOND + self.gib * MEMORY_USD_PER_GIB_SECOND

    @property
    def boosted_vcpu(self) -> float | None:
        """The CPU a cold start bills at, or None when boost is off or not priced."""
        if not self.startup_boost or self.cold_starts <= 0:
            return None
        if self.vcpu > 1.0:
            return None
        return BOOSTED_VCPU_FOR_LIMIT_UP_TO_1

    @property
    def boosted_seconds(self) -> float:
        """Seconds billed at the boosted CPU: each start's latency plus its 10 s tail."""
        if self.boosted_vcpu is None:
            return 0.0
        return self.startup_seconds + BOOST_TAIL_SECONDS * self.cold_starts

    @property
    def vcpu_seconds(self) -> float:
        """Boosted seconds at the boosted CPU, every other billable second at the limit.

        The boosted window is charged in full even where it outruns the billable
        seconds, because the boosted CPU is charged for as allocated (the 10 s tail
        bills whether or not a request is still in flight).
        """
        boosted = self.boosted_vcpu
        if boosted is None:
            return self.billable_seconds * self.vcpu
        window = self.boosted_seconds
        return boosted * window + self.vcpu * max(self.billable_seconds - window, 0.0)

    @property
    def gib_seconds(self) -> float:
        """Memory is not boosted, so it bills on billable seconds alone."""
        return self.billable_seconds * self.gib

    @property
    def unboosted_usd(self) -> float:
        return self.billable_seconds * self.usd_per_billable_second

    @property
    def usd(self) -> float:
        return (
            self.vcpu_seconds * CPU_USD_PER_VCPU_SECOND
            + self.gib_seconds * MEMORY_USD_PER_GIB_SECOND
        )


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


def parse_service_tier(service_doc: dict[str, Any]) -> tuple[float, float, bool]:
    """vCPU, GiB and whether startup CPU boost is on, from `services describe` JSON."""
    template = (service_doc.get("spec") or {}).get("template") or {}
    containers = (template.get("spec") or {}).get("containers") or [{}]
    limits = (containers[0].get("resources") or {}).get("limits") or {}
    cpu = _parse_quantity(str(limits.get("cpu") or ""), "cpu")
    mem = _parse_quantity(str(limits.get("memory") or ""), "mem")
    annotations = (template.get("metadata") or {}).get("annotations") or {}
    boost = str(annotations.get(STARTUP_BOOST_ANNOTATION, "")).strip().lower() == "true"
    return cpu, mem, boost


def read_tier(project: str, region: str, service: str) -> tuple[float, float, bool]:
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
            "--format=json",
        ]
    )
    if code != 0:
        raise RuntimeError(f"could not describe {service} in {project}: {out.strip()[:300]}")
    try:
        cpu, mem, boost = parse_service_tier(json.loads(out))
    except (ValueError, AttributeError, TypeError) as exc:
        raise RuntimeError(f"unreadable describe output for {service}: {exc}") from exc
    if cpu <= 0 or mem <= 0:
        raise RuntimeError(f"unreadable resource limits for {service}: cpu={cpu} mem={mem}")
    return cpu, mem, boost


def _window_seconds(window: str) -> int:
    """Accept the same `24h` / `7d` / `30m` shorthand the CLI flag documents."""
    raw = (window or "").strip().lower()
    unit = raw[-1:] if raw and raw[-1] in "smhd" else "h"
    number = raw[:-1] if raw and raw[-1] in "smhd" else raw
    try:
        value = int(number)
    except ValueError as exc:
        raise RuntimeError(f"unreadable --window {window!r}; use forms like 24h, 7d, 30m") from exc
    return value * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]


def _query_series(project: str, service: str, metric: str, window: str) -> dict[str, Any]:
    """Query Cloud Monitoring over its REST API.

    NOT `gcloud monitoring time-series list`. That subcommand does not exist --
    verified against Google Cloud SDK 577.0.0, and it is absent from `alpha` and
    `beta` too. This function called it anyway, so the script could never run,
    and the completion ledger's economics receipt pointed at it as the
    reproduction path. The receipt passed because the check verifies the
    reproduce path EXISTS, not that it RUNS: a false green of exactly the kind
    the ledger was built to abolish, shipped inside the ledger's own tooling.

    The v3 timeSeries endpoint is the stable surface and answers 200. Both
    metrics are also published per instance (`cloud_run_instance`), so the
    filter pins the revision resource to keep a second copy from being summed.
    """
    # `requests` rather than urllib: it ships its own CA bundle, and the stdlib
    # opener fails CERTIFICATE_VERIFY_FAILED on a stock macOS Python. The repo's
    # other operator scripts already use it for the same reason.
    import requests  # noqa: PLC0415

    code, token = _sh(["gcloud", "auth", "print-access-token"])
    if code != 0 or not token.strip():
        raise RuntimeError("could not obtain an access token from gcloud")

    seconds = _window_seconds(window)
    end = _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0)
    start = end - _dt.timedelta(seconds=seconds)
    try:
        resp = requests.get(
            f"https://monitoring.googleapis.com/v3/projects/{project}/timeSeries",
            params={
                "filter": (
                    f'metric.type="{metric}" AND resource.type="cloud_run_revision" '
                    f'AND resource.labels.service_name="{service}"'
                ),
                "interval.startTime": start.isoformat().replace("+00:00", "Z"),
                "interval.endTime": end.isoformat().replace("+00:00", "Z"),
            },
            headers={"Authorization": f"Bearer {token.strip()}"},
            timeout=60,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"monitoring unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise RuntimeError(f"monitoring query failed: HTTP {resp.status_code} {resp.text[:300]}")
    payload: dict[str, Any] = resp.json()
    return payload


def sum_billable_points(payload: dict[str, Any]) -> tuple[float, int]:
    """Total billable seconds and the number of points that carried a value."""
    total, points = 0.0, 0
    for s in payload.get("timeSeries") or []:
        for pt in s.get("points") or []:
            value = pt.get("value") or {}
            raw = value.get("doubleValue", value.get("int64Value"))
            if raw is None:
                continue
            total += float(raw)
            points += 1
    return total, points


def sum_cold_starts(payload: dict[str, Any]) -> tuple[int, float]:
    """Cold starts and their total startup time in seconds.

    Each point is a distribution of the starts in that minute, in milliseconds;
    a minute with no start is an empty distribution. Count x mean is the exact
    sum, so no per-start detail is lost for pricing, which is linear in it.
    """
    starts, total_ms = 0, 0.0
    for s in payload.get("timeSeries") or []:
        for pt in s.get("points") or []:
            dist = (pt.get("value") or {}).get("distributionValue") or {}
            count = int(dist.get("count") or 0)
            if count <= 0:
                continue
            starts += count
            total_ms += count * float(dist.get("mean") or 0.0)
    return starts, total_ms / 1000.0


def read_billable_seconds(project: str, service: str, window: str) -> tuple[float, int]:
    return sum_billable_points(_query_series(project, service, METRIC, window))


def read_cold_starts(project: str, service: str, window: str) -> tuple[int, float]:
    return sum_cold_starts(_query_series(project, service, STARTUP_METRIC, window))


def _boost_line(m: Measurement) -> str:
    if not m.startup_boost:
        return "off on this service"
    if m.cold_starts <= 0:
        return "on, no cold start in the window"
    if m.boosted_vcpu is None:
        return f"on, NOT PRICED: no published boost figure used for a {m.vcpu:g} vCPU limit"
    return f"on, {m.boosted_seconds:.1f} s at {m.boosted_vcpu:g} vCPU (startup + 10 s each)"


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
            f"  cold starts / startup time       : {m.cold_starts} / {m.startup_seconds:.1f} s",
            f"  startup CPU boost                : {_boost_line(m)}",
            f"  vCPU-seconds billed              : {m.vcpu_seconds:.1f}  "
            f"(unboosted reading: {m.billable_seconds * m.vcpu:.1f})",
            f"  compute cost for the window      : ${m.usd:.5f}  "
            f"(unboosted reading: ${m.unboosted_usd:.5f})",
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
        vcpu, gib, boost = read_tier(args.project, args.region, args.service)
        seconds, points = read_billable_seconds(args.project, args.service, args.window)
        starts, startup_seconds = read_cold_starts(args.project, args.service, args.window)
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
        cold_starts=starts,
        startup_seconds=startup_seconds,
        startup_boost=boost,
    )
    derived = {
        "vcpu_seconds": m.vcpu_seconds,
        "gib_seconds": m.gib_seconds,
        "unboosted_usd": m.unboosted_usd,
        "usd": m.usd,
        # False when starts exist but the boost could not be priced: usd is then low.
        "boost_priced": not (m.cold_starts and m.startup_boost and m.boosted_vcpu is None),
    }
    print(json.dumps(m.__dict__ | derived, indent=2) if args.json else render(m))
    return 0


if __name__ == "__main__":
    sys.exit(main())
