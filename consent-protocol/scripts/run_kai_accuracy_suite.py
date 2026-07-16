#!/usr/bin/env python3
"""Run Kai accuracy/compliance suite with benchmark artifacts."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MONOREPO_ROOT = ROOT.parent


def _default_corpus_dir() -> Path:
    return MONOREPO_ROOT / "data" / "brokerage_statements"


def _default_report_path() -> Path:
    return ROOT / "artifacts" / "kai_quality_baseline_latest.json"


def _run_step(name: str, cmd: list[str]) -> dict[str, Any]:
    started_at = time.time()
    result = subprocess.run(  # noqa: S603 - Controlled internal command invocation.
        cmd,
        cwd=str(ROOT),
        check=False,
        capture_output=True,
        text=True,
    )
    return {
        "name": name,
        "command": cmd,
        "returncode": result.returncode,
        "duration_seconds": round(time.time() - started_at, 2),
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def _has_live_model_credentials() -> bool:
    """Return True when runtime appears configured for live Gemini/Vertex calls."""
    auth_mode = str(os.getenv("HUSHH_GENAI_AUTH_MODE") or "vertex_adc").strip().lower()
    if auth_mode == "developer_api_key":
        return bool(
            os.getenv("GOOGLE_API_KEY", "").strip() or os.getenv("GEMINI_API_KEY", "").strip()
        )
    if auth_mode != "vertex_adc":
        return False

    uses_vertex = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if not uses_vertex:
        return False

    has_project = bool(os.getenv("GOOGLE_CLOUD_PROJECT", "").strip())
    has_location = bool(
        os.getenv("GOOGLE_CLOUD_LOCATION", "").strip()
        or os.getenv("GOOGLE_CLOUD_REGION", "").strip()
    )
    # Hosted ADC comes from the Cloud Run service identity and deliberately
    # has no GOOGLE_APPLICATION_CREDENTIALS file.
    return has_project and has_location


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Kai v6 accuracy and compliance suite")
    parser.add_argument(
        "--corpus-dir",
        default=str(_default_corpus_dir()),
        help="Brokerage PDF corpus directory",
    )
    parser.add_argument(
        "--report-out",
        default=str(_default_report_path()),
        help="Path to write benchmark JSON report",
    )
    parser.add_argument(
        "--summary-out",
        default=str(ROOT / "artifacts" / "kai_accuracy_suite_summary_latest.json"),
        help="Path to write suite summary JSON",
    )
    parser.add_argument(
        "--no-fail-benchmark",
        action="store_true",
        help="Do not fail suite when benchmark quality gates fail.",
    )
    parser.add_argument(
        "--skip-tests",
        action="store_true",
        help="Skip pytest contract checks.",
    )
    parser.add_argument(
        "--per-doc-timeout-sec",
        type=float,
        default=90.0,
        help="Timeout for each benchmark PDF model call.",
    )
    parser.add_argument(
        "--benchmark-limit",
        type=int,
        default=0,
        help="Optional max number of benchmark PDFs to evaluate.",
    )
    parser.add_argument(
        "--include-non-statements",
        action="store_true",
        help="Include guide/how-to PDFs in benchmark auto-discovery.",
    )
    parser.add_argument(
        "--require-live-benchmark",
        action="store_true",
        help="Fail if live benchmark credentials are missing instead of skipping benchmark.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    corpus_dir = Path(args.corpus_dir).expanduser().resolve()
    report_out = Path(args.report_out).expanduser().resolve()
    summary_out = Path(args.summary_out).expanduser().resolve()
    report_out.parent.mkdir(parents=True, exist_ok=True)
    summary_out.parent.mkdir(parents=True, exist_ok=True)

    benchmark_cmd = [
        sys.executable,
        str(ROOT / "scripts" / "eval_portfolio_stream_quality.py"),
        "--corpus-dir",
        str(corpus_dir),
        "--json-out",
        str(report_out),
        "--per-doc-timeout-sec",
        str(max(5.0, args.per_doc_timeout_sec)),
    ]
    if args.benchmark_limit and args.benchmark_limit > 0:
        benchmark_cmd.extend(["--limit", str(args.benchmark_limit)])
    if args.no_fail_benchmark:
        benchmark_cmd.append("--no-fail")
    if args.include_non_statements:
        benchmark_cmd.append("--include-non-statements")

    compliance_cmd = [
        sys.executable,
        str(ROOT / "scripts" / "verify_adk_a2a_compliance.py"),
    ]

    test_cmd = [
        sys.executable,
        "-m",
        "pytest",
        "-q",
        "tests/test_portfolio_stream_quality_rules.py",
        "tests/test_kai_optimize_realtime_contract.py",
        "tests/test_fetchers_provider_priority.py",
        "tests/test_adk_a2a_compliance_script.py",
    ]

    steps: list[dict[str, Any]] = []

    can_run_live_benchmark = _has_live_model_credentials()
    if can_run_live_benchmark:
        steps.append(_run_step("benchmark", benchmark_cmd))
    elif args.require_live_benchmark:
        steps.append(
            {
                "name": "benchmark",
                "command": benchmark_cmd,
                "returncode": 1,
                "duration_seconds": 0.0,
                "stdout": "",
                "stderr": (
                    "Missing live model credentials: configure Vertex workload ADC "
                    "(HUSHH_GENAI_AUTH_MODE=vertex_adc, GOOGLE_GENAI_USE_VERTEXAI=true, "
                    "GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION/REGION) or select "
                    "developer_api_key explicitly for a local-only run."
                ),
                "skipped": False,
            }
        )
    else:
        steps.append(
            {
                "name": "benchmark",
                "command": benchmark_cmd,
                "returncode": 0,
                "duration_seconds": 0.0,
                "stdout": "Skipped benchmark: missing live model credentials.",
                "stderr": "",
                "skipped": True,
            }
        )

    steps.append(_run_step("adk_a2a_compliance", compliance_cmd))
    if not args.skip_tests:
        steps.append(_run_step("contract_tests", test_cmd))

    suite_ok = all(step["returncode"] == 0 for step in steps)
    summary = {
        "ok": suite_ok,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "corpus_dir": str(corpus_dir),
        "benchmark_report": str(report_out),
        "steps": steps,
    }
    summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(summary, indent=2))
    return 0 if suite_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
