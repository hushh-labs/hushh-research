"""One Container Apps Job execution = one lane: a sequence of eval runs on one deployment.

Started by ``aca_bootstrap.py run-lane`` after it verified the drivers' sha256. The
environment keeps no logs, so every result leaves through the person's own blob
container, written as the job's own managed identity (``get_workload_token``, the pod's
real path): a preflight record, each run's driver log every minute, every file a run
produces as soon as it ends, and a lane status record.

env: EVAL_PLAN = {"lane": str, "runs": [{"kind": "ft"|"nav"|"so", "deployment": str,
     "reasoning": str, "reps": int, "label": str, "gap"?: float, "pod_mode"?: bool}]}
     EVAL_RESULTS_ACCOUNT, EVAL_RESULTS_CONTAINER, EVAL_RESULTS_PREFIX
"""

from __future__ import annotations

import json
import os
import platform
import socket
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
REPO = Path(os.environ.get("EVAL_REPO_ROOT") or "/app")
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))
OUT_ROOT = Path(os.environ.get("EVAL_OUT_ROOT") or "/tmp/eval-out")
ACCOUNT = os.environ["EVAL_RESULTS_ACCOUNT"]
CONTAINER = os.environ["EVAL_RESULTS_CONTAINER"]
PLAN = json.loads(os.environ["EVAL_PLAN"])
PREFIX = f"{os.environ['EVAL_RESULTS_PREFIX'].rstrip('/')}/{PLAN['lane']}"
ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
DRIVERS = {"ft": "run_first_tool_azure.py", "nav": "run_nav_turns.py", "so": "run_structured.py"}
STORAGE = "https://storage.azure.com"

import requests  # noqa: E402

from hushh_mcp.services.pod_workload_identity import get_workload_token  # noqa: E402


def now() -> str:
    return datetime.now(UTC).isoformat()


def put(name: str, data: bytes, ctype: str = "application/json") -> bool:
    url = f"https://{ACCOUNT}.blob.core.windows.net/{CONTAINER}/{PREFIX}/{name}"
    error: object = None
    for attempt in range(4):
        try:
            response = requests.put(
                url,
                data=data,
                headers={
                    "Authorization": "Bearer " + get_workload_token(STORAGE),
                    "x-ms-version": "2021-08-06",
                    "x-ms-blob-type": "BlockBlob",
                    "Content-Type": ctype,
                },
                timeout=120,
            )
            if response.status_code in (200, 201):
                return True
            error = response.status_code
        except Exception as exc:  # noqa: BLE001 - retried, then reported
            error = type(exc).__name__
        time.sleep(2**attempt)
    print(f"upload failed {name}: {error}", file=sys.stderr, flush=True)
    return False


def put_json(name: str, value: object) -> bool:
    return put(name, json.dumps(value, indent=1, default=str).encode())


def preflight() -> dict:
    from hushh_mcp.runtime_providers.azure_openai import workload_token_provider

    facts: dict = {
        "started_utc": now(),
        "lane": PLAN["lane"],
        "plan": PLAN,
        "python": platform.python_version(),
        "hostname": socket.gethostname(),
        "job": os.environ.get("CONTAINER_APP_JOB_NAME"),
        "execution": os.environ.get("CONTAINER_APP_JOB_EXECUTION_NAME"),
        "replica": os.environ.get("CONTAINER_APP_REPLICA_NAME"),
        "pod_image_tag": os.environ.get("HUSSH_POD_IMAGE_TAG"),
        "code_sha": os.environ.get("EVAL_CODE_SHA"),
        "drivers_sha256": os.environ.get("EVAL_DRIVERS_SHA256_VERIFIED"),
        "identity_endpoint_host": urlsplit(os.environ.get("IDENTITY_ENDPOINT", "")).netloc,
        "azure_client_id": os.environ.get("AZURE_CLIENT_ID"),
        "endpoint": ENDPOINT,
        "google_env_names": sorted(k for k in os.environ if k.startswith("GOOGLE")),
        "cpu_count": os.cpu_count(),
    }
    # The exact production credential function, never printed.
    started = time.perf_counter()
    token = workload_token_provider()()
    facts["mi_token_ms"] = round((time.perf_counter() - started) * 1000, 1)
    facts["mi_token_ok"] = bool(token)
    # Network distance to the person's endpoint: tiny authenticated, unbilled GETs.
    probes = []
    with requests.Session() as session:
        for _ in range(6):
            started = time.perf_counter()
            try:
                response = session.get(
                    f"{ENDPOINT}openai/v1/models",
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=30,
                )
                probes.append(
                    {
                        "status": response.status_code,
                        "ms": round((time.perf_counter() - started) * 1000, 1),
                        "region": response.headers.get("x-ms-region"),
                    }
                )
            except Exception as exc:  # noqa: BLE001 - a probe reports
                probes.append({"status": None, "error": type(exc).__name__})
    facts["models_get"] = probes
    del token
    return facts


def run_one(run: dict, status: dict) -> None:
    label = run["label"]
    out = OUT_ROOT / label
    out.mkdir(parents=True, exist_ok=True)
    log = out / "driver.log"
    env = {
        **os.environ,
        "EVAL_REASONING": run.get("reasoning", "production"),
        "AZURE_OPENAI_DEPLOYMENT": run["deployment"],
        "EVAL_OUT_ROOT": str(OUT_ROOT),
    }
    if "gap" in run:
        env["EVAL_CALL_GAP_SECONDS"] = str(run["gap"])
    if "pod_mode" in run:
        # The harness fixtures patch hub-side services and its cases expect the
        # hub-shaped roster; pod mode (baked into Dockerfile.pod) swaps both out.
        env["HUSSH_POD_MODE"] = "1" if run["pod_mode"] else "0"
    cmd = [
        sys.executable,
        str(HERE / DRIVERS[run["kind"]]),
        run["deployment"],
        label,
        str(run["reps"]),
    ]
    status["runs"][label] = {"state": "running", "started_utc": now(), **run}
    put_json("status.json", status)
    with open(log, "wb") as handle:
        proc = subprocess.Popen(  # noqa: S603 - fixed driver path, plan-owned args
            cmd, stdout=handle, stderr=subprocess.STDOUT, env=env, cwd=str(HERE)
        )
        last = time.time()
        while proc.poll() is None:
            time.sleep(5)
            if time.time() - last >= 60:
                put(f"{label}/driver.log", log.read_bytes()[-2_000_000:], "text/plain")
                last = time.time()
    status["runs"][label].update(state="done", rc=proc.returncode, finished_utc=now())
    for path in sorted(out.rglob("*")):
        if path.is_file():
            ctype = "text/plain" if path.suffix in {".log", ".txt"} else "application/json"
            put(f"{label}/{path.relative_to(out)}", path.read_bytes(), ctype)
    put_json("status.json", status)


def _ephemeral_core_keys() -> list[str]:
    """``hushh_mcp.config`` refuses to import without these. The eval holds no person's
    information and signs only fixture tokens, so each execution generates throwaway
    values in-process: they never enter the job definition, a log or a result."""
    import secrets

    made = []
    if len(os.environ.get("APP_SIGNING_KEY", "")) < 32:
        os.environ["APP_SIGNING_KEY"] = secrets.token_urlsafe(48)
        made.append("APP_SIGNING_KEY")
    if len(os.environ.get("VAULT_DATA_KEY", "")) != 64:
        os.environ["VAULT_DATA_KEY"] = secrets.token_hex(32)
        made.append("VAULT_DATA_KEY")
    return made


def main() -> int:
    status: dict = {
        "lane": PLAN["lane"],
        "state": "preflight",
        "runs": {},
        "ephemeral_keys": _ephemeral_core_keys(),
    }
    try:
        facts = preflight()
    except Exception as exc:  # noqa: BLE001 - recorded, then the lane stops
        status.update(state="preflight_failed", error=type(exc).__name__, detail=str(exc)[:300])
        put_json("status.json", status)
        return 1
    put_json("preflight.json", facts)
    status["state"] = "running"
    for run in PLAN["runs"]:
        run_one(run, status)
    status.update(state="complete", finished_utc=now())
    put_json("status.json", status)
    return 0


if __name__ == "__main__":
    sys.exit(main())
