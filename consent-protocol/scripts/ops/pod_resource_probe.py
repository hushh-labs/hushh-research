"""Measure what a pod actually costs to run, so sizing stops being a guess.

Cloud Run bills CPU and memory per second, and the renderer currently emits no
``resources`` block at all -- so pod sizing is inherited from a platform default
rather than chosen. Choosing it needs three numbers this tool produces:

* **cold start** -- time from process launch to the first ``200`` on ``/health``.
  This is what ``minScale=0`` costs a user in latency, and therefore what decides
  whether scale-to-zero is acceptable UX or a permanent warm floor is required.
* **idle RSS** -- resident memory once booted and quiet. This is the floor.
* **loaded RSS** -- resident memory after the pod has actually served every route
  it mounts. Sizing off the idle number is how you get OOM restarts, and an OOM
  restart destroys the always-alive property a warm floor is paid for.

It also reports the **import cost breakdown** (via ``-X importtime``), because the
pod mounts five routes and still imports the whole application. That single fact
drives both the memory floor and the cold start, so the slimming opportunity is
worth more than any config change -- and it can only be argued from numbers.

Usage::

    python scripts/ops/pod_resource_probe.py
    python scripts/ops/pod_resource_probe.py --requests 200 --json out.json

Runs entirely locally against a real ``pod_server`` process. No GCP, no cost.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

import requests

# parents[2] from scripts/ops/ IS consent-protocol -- the package root, not the repo
# root. Appending "consent-protocol" again yields a directory that mkdir happily
# creates and uvicorn then finds empty, so the pod "never becomes healthy" for a
# reason that has nothing to do with the pod.
PKG_ROOT = Path(__file__).resolve().parents[2]

# Every route the pod actually mounts. Driving all of them is what turns an idle
# measurement into a loaded one.
POD_ROUTES = ("/health", "/health/ready", "/pod/info", "/pod/public-key", "/")


def _rss_mb(pid: int) -> float:
    """Resident set of a process and its children, in MB."""
    total = 0
    try:
        out = subprocess.run(  # noqa: S603
            ["ps", "-eo", "pid,ppid,rss"], capture_output=True, text=True, check=False
        ).stdout.splitlines()[1:]
    except Exception:  # noqa: BLE001
        return 0.0
    rows = []
    for line in out:
        parts = line.split()
        if len(parts) >= 3:
            rows.append((int(parts[0]), int(parts[1]), int(parts[2])))
    family = {pid}
    # Two passes is enough for uvicorn's master + worker tree.
    for _ in range(3):
        for p, pp, _rss in rows:
            if pp in family:
                family.add(p)
    for p, _pp, rss in rows:
        if p in family:
            total += rss
    return round(total / 1024, 1)


def _pod_env(port: int, root: Path) -> dict[str, str]:
    env = dict(os.environ)
    env.update(
        {
            "HUSSH_POD_MODE": "1",
            "HUSSH_ID": "HA1PROBE",
            "HUSSH_SPACE_ID": "space-probe",
            "PERSONAL_AGENT_ENABLED": "1",
            "APP_SIGNING_KEY": hashlib.sha256(b"pod-resource-probe-signing").hexdigest(),
            "PKM_SQLITE_PATH": str(root / "pkm.sqlite3"),
            "POD_HUB_IDENTITY_AUTH_ENABLED": "0",
        }
    )
    env.pop("VAULT_DATA_KEY", None)  # a pod performs no vault crypto
    return env


def measure_boot(port: int, root: Path, timeout: float) -> tuple[Optional[subprocess.Popen], dict]:
    """Launch a real pod and time it to its first healthy response."""
    root.mkdir(parents=True, exist_ok=True)
    log = (root / "probe-server.log").open("w")
    started = time.time()
    proc = subprocess.Popen(  # noqa: S603
        [
            "uv",
            "run",
            "uvicorn",
            "pod_server:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=str(PKG_ROOT),
        env=_pod_env(port, root),
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}"
    cold_start = None
    while time.time() - started < timeout:
        try:
            if requests.get(f"{url}/health", timeout=3).status_code == 200:
                cold_start = round(time.time() - started, 2)
                break
        except Exception:  # noqa: BLE001, S110 - still booting
            pass
        time.sleep(0.25)
    return proc, {"coldStartSeconds": cold_start, "url": url}


def drive(url: str, requests_count: int) -> dict:
    """Serve every mounted route repeatedly, so 'loaded' means actually loaded."""
    codes: dict[str, int] = {}
    errors = 0
    for i in range(requests_count):
        route = POD_ROUTES[i % len(POD_ROUTES)]
        try:
            r = requests.get(f"{url}{route}", timeout=10)
            key = f"{route} -> {r.status_code}"
            codes[key] = codes.get(key, 0) + 1
        except Exception:  # noqa: BLE001
            errors += 1
    return {"responses": codes, "errors": errors}


def import_breakdown(top: int = 12) -> list[dict[str, Any]]:
    """The most expensive imports on the pod's boot path.

    A pod serves five routes. Anything heavy here that those five routes do not
    need is directly purchasable cold-start and memory.
    """
    env = _pod_env(0, Path("/tmp"))  # noqa: S108 - not written to, env only
    proc = subprocess.run(  # noqa: S603
        ["uv", "run", "python", "-X", "importtime", "-c", "import pod_server"],
        cwd=str(PKG_ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    rows: list[dict[str, Any]] = []
    for line in proc.stderr.splitlines():
        if not line.startswith("import time:"):
            continue
        body = line[len("import time:") :].strip()
        parts = [p.strip() for p in body.split("|")]
        if len(parts) != 3 or not parts[1].isdigit():
            continue
        rows.append({"module": parts[2].strip(), "cumulativeMs": round(int(parts[1]) / 1000, 1)})
    # Top-level modules only: the deepest cumulative times are the real cost centres.
    rows.sort(key=lambda r: r["cumulativeMs"], reverse=True)
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        root_mod = str(row["module"]).split(".")[0]
        if root_mod in seen:
            continue
        seen.add(root_mod)
        out.append(row)
        if len(out) >= top:
            break
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure a pod's real resource cost")
    parser.add_argument("--port", type=int, default=9400)
    parser.add_argument("--requests", type=int, default=120)
    parser.add_argument("--boot-timeout", type=float, default=180.0)
    parser.add_argument("--root", default="")
    parser.add_argument("--json", default="")
    args = parser.parse_args()

    root = Path(args.root) if args.root else PKG_ROOT / ".sim" / "probe"
    proc, boot = measure_boot(args.port, root, args.boot_timeout)
    if proc is None or boot["coldStartSeconds"] is None:
        print("pod never became healthy", file=sys.stderr)
        if proc:
            proc.terminate()
        return 1

    time.sleep(2)
    idle = _rss_mb(proc.pid)
    served = drive(boot["url"], args.requests)
    time.sleep(1)
    loaded = _rss_mb(proc.pid)

    proc.terminate()
    try:
        proc.wait(timeout=20)
    except Exception:  # noqa: BLE001
        proc.kill()

    report = {
        "coldStartSeconds": boot["coldStartSeconds"],
        "idleRssMb": idle,
        "loadedRssMb": loaded,
        "growthMb": round(loaded - idle, 1),
        "requestsServed": args.requests,
        "served": served,
        "importBreakdown": import_breakdown(),
    }
    print(json.dumps(report, indent=2))
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
