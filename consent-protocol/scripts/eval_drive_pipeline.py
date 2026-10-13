"""Original-byte evaluation runner. No account access, payments or sharing.

Default: extraction only; semantic and delivery results stay unobserved. A local
--adapter module:callable may run the real pipeline. It receives no gold labels:
async adapter(*, case: dict, extraction: dict) -> {observation: dict, runtime: dict}.
Use an authorized private corpus outside Git for real-account evaluation.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import importlib
import inspect
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from hushh_mcp.services.drive_pipeline_evaluation import (  # noqa: E402
    adapter_input,
    build_report,
    load_dataset,
)


def _callable(spec: str):
    module, separator, name = spec.partition(":")
    if not separator or not name:
        raise ValueError("adapter_requires_module_colon_callable")
    return getattr(importlib.import_module(module), name)


async def _invoke(callback, **kwargs):
    if inspect.iscoroutinefunction(callback):
        return await callback(**kwargs)
    result = await asyncio.to_thread(callback, **kwargs)
    return await result if inspect.isawaitable(result) else result


def _dict(value):
    if dataclasses.is_dataclass(value):
        return dataclasses.asdict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value


async def extract_original(document, extractor):
    pages, cursor, engines, profile = [], 1, {}, None
    complete, gaps = False, False
    while cursor is not None:
        result = _dict(
            await _invoke(
                extractor,
                content=document["content"],
                mime_type=document["mime_type"],
                start_page=cursor,
                page_limit=4,
            )
        )
        batch = [_dict(page) for page in result["pages"]]
        pages.extend(batch)
        engines.update(result.get("engine_versions", {}))
        profile = result.get("profile", profile)
        gaps = gaps or result.get("has_gaps", True)
        complete = result.get("complete", False)
        next_page = result.get("next_page")
        if next_page is not None and (next_page <= cursor or len(pages) >= 1000):
            raise ValueError("extraction_did_not_finish_within_budget")
        cursor = next_page
    return {
        "pages": pages,
        "complete": complete,
        "has_gaps": gaps,
        "engine_versions": engines,
        "profile": profile,
    }


async def run_dataset(path: Path, *, extractor, pipeline=None, timeout_seconds=300) -> dict:
    dataset = load_dataset(path)
    attempts, runtime, runtime_seen = [], {}, False
    for case in dataset["cases"]:
        row = {"case_id": case["id"], "status": "not_run", "extraction": {}}
        started, stage = time.monotonic(), "extraction"
        try:
            async with asyncio.timeout(timeout_seconds):
                supplied = adapter_input(case, path.parent)
                extraction = {}
                for document in supplied["documents"]:
                    result = await extract_original(document, extractor)
                    extraction[document["ref"]] = result
                    # Persist counts/provenance, never private document text.
                    row["extraction"][document["ref"]] = {
                        key: result[key]
                        for key in ("complete", "has_gaps", "engine_versions", "profile")
                    } | {"pages": len(result["pages"]), "sha256": document["sha256"]}
                row["stage_latency_ms"] = {"extraction": round((time.monotonic() - started) * 1000)}
                if pipeline is not None:
                    stage = "pipeline"
                    result = await _invoke(pipeline, case=supplied, extraction=extraction)
                    reported_runtime = result["runtime"]
                    if runtime_seen and runtime != reported_runtime:
                        raise ValueError("mixed_runtime_provenance")
                    runtime, runtime_seen = reported_runtime, True
                    observed = result["observation"]
                    if observed.get("case_id", case["id"]) != case["id"]:
                        raise ValueError("adapter_case_mismatch")
                    # Host extraction evidence and identity cannot be replaced by an adapter.
                    row.update(
                        {
                            key: value
                            for key, value in observed.items()
                            if key not in {"case_id", "extraction", "latency_ms"}
                        }
                    )
                else:
                    row["error_stage"] = "pipeline_not_configured"
        except Exception as error:  # noqa: BLE001 - retain failures without private exception text
            row.update(
                status="timeout" if isinstance(error, TimeoutError) else "error",
                error_stage=stage,
                error_type=type(error).__name__,
            )
        row["latency_ms"] = round((time.monotonic() - started) * 1000)
        attempts.append(row)
    report = build_report(dataset, attempts, runtime=runtime)
    # Allowlist outputs; private model reasons, extracted text and titles never enter artifacts.
    report["observations"] = [
        {
            key: row[key]
            for key in (
                "case_id",
                "status",
                "error_stage",
                "error_type",
                "latency_ms",
                "stage_latency_ms",
                "extraction",
                "usage",
            )
            if key in row
        }
        for row in attempts
    ]
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset", type=Path, default=ROOT / "tests/fixtures/drive_pipeline_eval/manifest.json"
    )
    parser.add_argument(
        "--extractor", default="hushh_mcp.services.drive_document_pages:extract_pages"
    )
    parser.add_argument("--adapter", help="Explicit opt-in to a local real-pipeline adapter")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.adapter and os.environ.get("DRIVE_PIPELINE_EVAL_LIVE") != "1":
        parser.error(
            "Set DRIVE_PIPELINE_EVAL_LIVE=1 before invoking a potentially paid model adapter"
        )
    if not 1 <= args.timeout_seconds <= 3600:
        parser.error("timeout must be between 1 and 3600 seconds")
    report = asyncio.run(
        run_dataset(
            args.dataset,
            extractor=_callable(args.extractor),
            pipeline=_callable(args.adapter) if args.adapter else None,
            timeout_seconds=args.timeout_seconds,
        )
    )
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {key: report[key] for key in ("dataset_version", "statuses", "acceptance", "usage")}
        )
    )
    # A partial extraction-only run must not masquerade as a passing pipeline eval.
    return 0 if report["all"]["packet_correctness_all_attempts"]["rate"] == 1 else 1


if __name__ == "__main__":
    raise SystemExit(main())
