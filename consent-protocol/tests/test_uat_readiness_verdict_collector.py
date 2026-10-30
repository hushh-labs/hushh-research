"""The UAT Azure readiness step waits for a finished exam job's verdict rows.

Regression: UAT run 40979434192 failed a passing exam because the job's verdict
rows were not yet searchable inside a fixed 30-second window. These tests run the
real collector snippet from deploy/backend.cloudbuild.yaml with stubbed gcloud and
sleep, so no network or wall-clock time is involved.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PASSING_ROWS = [
    {"jsonPayload": {"azure_pwm_runtime_probe_result": "ok"}},
    {
        "jsonPayload": {
            "azure_pwm_runtime_probe_stage": "primary_http",
            "result": "ok",
            "http_status": 200,
            "deployment": "eval",
        }
    },
    {"jsonPayload": {"azure_managed_text_contract": "ok", "scopes": 2}},
]


def _collector() -> str:
    steps = yaml.safe_load((ROOT / "deploy/backend.cloudbuild.yaml").read_text(encoding="utf-8"))[
        "steps"
    ]
    script = next(step for step in steps if step.get("id") == "verify-azure-pwm-runtime")["args"][1]
    start = script.index("# readiness-verdict-collector:start")
    return script[start : script.index("# readiness-verdict-collector:end")]


def _run(tmp_path: Path, empty_reads: int, rows: list[dict]) -> tuple[int, list[int], str]:
    """Return (log reads, sleep durations, collected entries) for one collection."""
    (tmp_path / "rows.json").write_text(json.dumps(rows), encoding="utf-8")
    harness = "\n".join(
        [
            "set -euo pipefail",
            f"cd '{tmp_path}'",
            "PROJECT_ID=project",
            "execution_name=execution",
            "echo 0 > calls",
            ": > sleeps",
            "gcloud() { n=$(cat calls); echo $((n + 1)) > calls;"
            f" if (( n < {empty_reads} )); then echo '[]'; else cat rows.json; fi; }}",
            'sleep() { echo "$1" >> sleeps; }',
            _collector(),
            "printf '%s' \"$probe_entries\" > collected.json",
        ]
    )
    subprocess.run(["bash", "-c", harness], check=True, timeout=60)  # noqa: S603 - repo-owned snippet, stubbed I/O.
    sleeps = [int(value) for value in (tmp_path / "sleeps").read_text(encoding="utf-8").split()]
    return (
        int((tmp_path / "calls").read_text(encoding="utf-8")),
        sleeps,
        (tmp_path / "collected.json").read_text(encoding="utf-8"),
    )


def test_verdict_rows_that_index_late_still_reach_validation(tmp_path):
    # Seven unsearchable reads exceeded the former six-read window.
    calls, sleeps, collected = _run(tmp_path, empty_reads=7, rows=PASSING_ROWS)
    assert calls == 8
    assert json.loads(collected) == PASSING_ROWS
    assert sleeps[:4] == [2, 4, 8, 10]


def test_missing_verdict_stops_within_a_bounded_wait(tmp_path):
    # Negative control: rows that never appear still end the collection.
    calls, sleeps, collected = _run(tmp_path, empty_reads=10_000, rows=PASSING_ROWS)
    assert calls == 20
    assert json.loads(collected) == []
    assert sum(sleeps) <= 180


def test_visible_failed_verdict_returns_without_waiting(tmp_path):
    failed = [{"jsonPayload": {"azure_pwm_runtime_probe_result": "failed"}}]
    calls, sleeps, collected = _run(tmp_path, empty_reads=0, rows=failed)
    assert (calls, sleeps) == (1, [])
    assert json.loads(collected) == failed
