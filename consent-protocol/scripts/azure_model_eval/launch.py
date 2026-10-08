"""Start one lane of the in-Azure eval: set the lane's env on the job, then start it.

An execution snapshots the job template when it starts, so setting the env right before
each start gives every lane its own plan; ``az containerapp job execution show`` records
what each execution actually ran with.

usage: python launch.py <plan.json> <results-prefix> <drivers-blob> <drivers-sha256>
       [KEY=VALUE ...]   extra env for this execution only (smoke runs: CASE_IDS=...)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from aca_specs import RG, eval_env

JOB = "hussh-eval-harness"


def az(*args: str) -> str:
    done = subprocess.run(  # noqa: S603 - fixed az executable, argument list
        ["az", *args], capture_output=True, text=True, check=True
    )
    return done.stdout.strip()


def main() -> None:
    plan = json.loads(Path(sys.argv[1]).read_text())
    env = eval_env(
        plan=plan, prefix=sys.argv[2], drivers_blob=sys.argv[3], drivers_sha256=sys.argv[4]
    )
    for extra in sys.argv[5:]:
        key, _, value = extra.partition("=")
        env[key] = value
    pairs = [f"{key}={value}" for key, value in env.items()]
    az(
        "containerapp",
        "job",
        "update",
        "-n",
        JOB,
        "-g",
        RG,
        "--replace-env-vars",
        *pairs,
        "-o",
        "none",
    )
    name = az("containerapp", "job", "start", "-n", JOB, "-g", RG, "--query", "name", "-o", "tsv")
    print(json.dumps({"lane": plan["lane"], "execution": name, "prefix": sys.argv[2]}))


if __name__ == "__main__":
    main()
